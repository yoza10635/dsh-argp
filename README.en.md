[中文](README.md) | English

# dsh-argp — Logical-Chain Atomic Reference-Graph Pruning Compaction Engine

[![CI](https://github.com/yoza10635/dsh-argp/actions/workflows/ci.yml/badge.svg)](https://github.com/yoza10635/dsh-argp/actions/workflows/ci.yml)
[![GitHub Release](https://img.shields.io/github/v/release/yoza10635/dsh-argp)](https://github.com/yoza10635/dsh-argp/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

dsh-argp (ARGP = **A**tomic **R**eference **G**raph **P**runing) is a third-party `CompactionEngine` for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) that performs **selective forgetting driven by the logical chain (reference-dependency topology)**: atoms that are *depended on* are kept per the citation graph, while *isolated* atoms are evicted in reverse topological order — **without any LLM calls**, instead of rewriting history into a summary.

- **0 LLM in the compression phase** — pure graph rules, deterministic and convergent.
- **Decided by the logical chain** — pruning follows reference-dependency topology ("what is depended on"), not recency or model preference.
- **Selective forgetting, not rewriting** — pruned content stays in the append-only session log and is retrievable via built-in `recall_pruned` / `recall` tools.
- **Engine-agnostic seam** — mounted as a drop-in replacement for `compaction-basic` through the standard `CompactionEngine` interface.
- **Exact compression ratio** — measured 200K context → 160K trigger → 32K retained; output size is controlled.

> Status: research/validation stage. The full pipeline (mount → prune → recall, transaction invariants) is validated on dsh `0.1.0-rc.6` with DeepSeek v4-flash over 50-turn runs; declarative production mounting is verified (loaded via the `dsh plugin` CLI).

## Why

Summarizer-based compaction (e.g. `compaction-basic`) rewrites history with an LLM at compression time: cost scales with context, information is lossy, and compression ratio is not controllable. ARGP takes the opposite route: dependencies are captured structurally while the conversation happens (a small per-turn annotation), and compaction only *evicts* atoms in reverse topological order of the citation graph — every atom's token count is known, pruning is deterministic, and the degradation chain converges to budget.

## Core mechanics

1. **Atomization** — history is decomposed into atoms (user / assistant / tool-result). dsh's surface has no standalone tool/call nodes, so call blocks live inside assistant atoms.
2. **Graph building** — deterministic edges (assistant → its tool results, via `toolCallId`) plus semantic edges from citation prefixes the assistant declares in its output (`{"cites": [...]}`).
3. **Topological pruning** — repeatedly evict atoms with in-degree 0, ordered by edge level → effective importance → last-reference round. Citations to a pruned atom unlock it (dynamic effective in-degree, per pass). `U` (user) atoms and tombstones are never pruned.
4. **Closure lifecycle** — completed task closures (roots anchored on task-type user atoms) can be evicted whole, with tombstones that feed the recall index.
5. **Recall** — `recall_pruned(seq)` retrieves pruned atoms from the log; `list_pruned` shows the pruned-node index. Budget: ≤3 calls/turn, ≤5% window per call, ≤10% total.
6. **Version dedup** — exact-duplicate assistant atoms / same-issuer tool results are pruned in pairs (simplified form of the design's θ=0.8 chain dedup).

Design details, invariants, and implementation-vs-design deviations are tracked in [`docs/`](docs/).

## Model requirement (edge density is tied to instruction following)

Semantic edges come from the `{"cites": [...]}` declarations the model emits per the prompt contract during conversation — **edge density is a direct function of the model's instruction-following capability**:

- **Strong instruction following**: cites are declared as contracted → the citation graph reflects real dependencies → high pruning selectivity
- **Weak instruction following**: under-declaration (sparse graph, deterministic edges only) or erratic declaration (over-dense graph) → lower pruning selectivity and changed transaction shape

Measured contrast (50-turn t-long, same engine and parameters, **same task prompt**): DeepSeek v4-flash (high) declared 0 cites, ~34–35 atoms per transaction (sparse graph); Qwen3.8-27B declared 547, only ~4 atoms per transaction across 37 transactions (dense graph) — **the same engine shows different pruning shapes on different models**, yet L1/L2/L3 invariants pass on both.

A key model difference (measured): the t-long task prompt itself says "reply with exactly one line and nothing else" (which conflicts with the citation contract). **DeepSeek v4-flash ranks the system prompt below user instructions** — "nothing else" suppresses its cites declarations (declared=0); **Qwen3.8-27B ranks the system prompt above user instructions and declares more robustly** — even when told "nothing else", it still appends cites after its reply (declared=547). **Which side wins when system and user prompts conflict is determined by model training, not by prompt wording** — this is the deeper cause of edge-density differences, and prompt-template tuning has a hard ceiling on compliance (measured ≤40% across templates).

**Warning for users**: DeepSeek-family models are more easily suppressed by user instructions when system and user prompts conflict — if your task/tool prompt happens to contain wording like "nothing else" or strict output-format requirements that clash with the citation contract, DeepSeek may end up with zero edges for the whole session. This does not affect compaction (see the zero-edge guarantee below); it only loses semantic selectivity. Once the task prompt leaves room for the citation block (measured over 10 turns), the declaration rate recovers to 43.6% with 100% resolution.

Implication: pairing with a model that follows instructions well is recommended; on weaker models compaction stays safe (0-LLM determinism + `U`-anchor protection + `recall` fallback hold on any model), only the selectivity benefit is reduced.

**An important guarantee: even with zero edges for the entire session (cites declared=0, the semantic-reference layer entirely absent), all other pruning-priority mechanisms keep working normally.** Semantic edges are only an *enhancement signal* for compaction decisions, not a requirement — the core pruning paths (deterministic-edge pairing, `eff` importance ranking, `U`-anchor never-pruned, lastRef recency, density ordering, closure lifecycle, version-chain dedup) all operate independently of cites declarations. The DeepSeek v4-flash run (declared=0, 50 turns) is full evidence of this guarantee: L1/L2/L3 all pass, exact compression ratio, recall fallback intact — **with the cross-turn logical chain absent, the engine degrades to "deterministic edges + position/importance ordering" ordinary pruning: fully functional, only the selectivity gain disappears**.

## Install & mount

### Declarative CLI mount (verified)

```bash
dsh plugin --profile <name> add dsh-argp
```

Then insert the engine and disable the stock summarizer in the profile's `cordis.patch.yml`:

```yaml
- id: compaction-basic
  disabled: true
- insert:
    - id: dsh-argp
      name: dsh-argp
      config: { maxPasses: 16 }   # budgets are ratio-driven by default
```

After boot, `ctx.compaction` is the ARGP engine.

### Ratio-driven budgets (default)

- `windowTokens = contextWindow × 0.8` (trigger at 80% of context)
- `retainTokens = windowTokens × 0.2` (1/5 compression ratio)

The context capacity comes from the model adapter declaration and adapts automatically when the model changes; explicit overrides are also supported (see [config](src/argp-graph-engine.ts)).

### Local development

```bash
npm install
npm run check        # typecheck + local smoke + unit tests
```

DeepSeek-backed validation requires a dsh API credential (standard dsh credential location):

```bash
npm run smoke:deepseek   # 10a + 10b + 10d single-turn smokes
```

## Validation

DeepSeek v4-flash, 50-turn t-long task; full numbers with artifact paths in [`docs/experiment-2026-08-16-separated-contract-probe.md`](docs/experiment-2026-08-16-separated-contract-probe.md).

| Metric | dsh-argp | compaction-basic (high, same task) |
|---|---|---|
| budget mode | ratio-driven (200K → 160K trigger → 32K retain) | fixed 32K intent, uncontrolled |
| transactions / errors | 4 / 0 | 30 / 23 (77%, empty streams) |
| U anchors preserved | 7/7 | 7/7 |
| needles recovered | 7/7 (5/7 via recall) | 0/7 (unrecoverable) |
| compression target | exact (32K) | 67K actual (uncontrolled) |
| cost (idle pricing) | ¥2.695 | ¥3.087 |

Research-scale comparison: dsh-argp ¥0.355 (U 7/7 R 7/7) vs `compaction-basic` ¥0.911 (U 0/7 R 0/7).

## Reproduce

| Run | Command | What it validates |
|---|---|---|
| 50-turn t-long (high thinking) | `ARGP_DEEPSEEK_THINKING=enabled node spike/06-tlong.ts` | L1/L2/L3 invariants, 7/7 anchors, 7/7 needles via recall |
| 160K mainline | `ARGP_CONTEXT_WINDOW=200000 ARGP_CHUNK_LINES=600 node spike/06-tlong.ts` | Exact compression ratio, ratio-driven budgets |
| Baseline (compaction-basic) | `node spike/07-baseline.ts` | Same task with the stock summarizer for contrast |
| Synthetic 0-LLM | `npm run spike8a` | 28-atom single-transaction pruning with zero LLM calls |

Every number carries its artifact path (see the experiment record).

## Known platform gaps (feedback to dsh)

Developing a non-LLM compaction backend surfaced four extensibility gaps in the compaction seam. Details and repro scripts in [`docs/dsh-api-feedback-2026-08-17.md`](docs/dsh-api-feedback-2026-08-17.md):

1. **No structured metadata channel on tool/result replacement** — placeholders must clone the original message and may only swap content.
2. **`compaction/prune` is outside the transaction invariant state machine** — no native event type for algorithmic eviction; third-party engines must borrow `summary` semantics with pseudo fields.
3. **Headless test assembly silently disables the pressure path** — `mountAgentLoopTestDependencies` does not register `tokenMeter`, and the pre-step catch swallows the error.
4. **Intermittent empty streams on summarizer calls (B-5)** — 77% of transactions failed with empty streams under high thinking effort; `maxTokens=32768` does not help; likely a streaming connection race.

## License

MIT
