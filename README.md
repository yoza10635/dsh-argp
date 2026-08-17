# ARGP — 0-LLM Deterministic Context Compaction for DeepSeek Harness

ARGP (**A**tomic **R**eference **G**raph **P**runing) is a third-party `CompactionEngine` for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) that compresses conversation context **without any LLM calls**: instead of rewriting history into a summary, it selectively forgets.

- **0 LLM in the compression phase** — pure graph rules, deterministic and convergent.
- **Selective forgetting, not rewriting** — pruned content stays in the append-only session log and is retrievable via a built-in `recall_pruned` tool.
- **Engine-agnostic seam** — mounted as a drop-in replacement for `compaction-basic` through the standard `CompactionEngine` interface.

> Status: research/validation stage. The full pipeline (mount → prune → recall, transaction invariants) is validated on dsh `0.1.0-rc.6` with DeepSeek v4-flash (see [Reproduce](#reproduce)). Declarative production mounting (P4) is in progress.

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

## Repository layout

| Path | Content |
|---|---|
| `src/argp-graph-engine.ts` | Main engine (graph build, pruning, closure lifecycle, recall/list tools) |
| `src/argp-t1-engine.ts` | Earlier single-transaction validation engine |
| `src/recall-engine.ts` / `src/probe-engine.ts` | Recall / probe helpers |
| `test/` | Node test suite (`argp-graph-engine.test.ts`, `chain-unlock.test.ts`) |
| `spike/` | Repro/validation scripts (each `node spike/NN-*.ts` is self-contained) |
| `docs/` | Design (v1.0), migration design, roadmap, experiment records, design↔impl trace |

## Quick start

```bash
npm install
npm run check        # typecheck + local smoke + unit tests
```

DeepSeek-backed validation requires a dsh API credential (standard dsh credential location) and runs:

```bash
npm run smoke:deepseek   # 10a + 10b + 10d single-turn smokes
```

## Reproduce

Key validation runs (all artifacts are local-only; scripts are committed):

| Run | Command | What it validates |
|---|---|---|
| 50-turn t-long (high thinking) | `ARGP_DEEPSEEK_THINKING=enabled node spike/06-tlong.ts` | L1/L2/L3 invariants, 7/7 anchors, 7/7 needles via recall |
| Production-scale | `ARGP_DEEPSEEK_THINKING=enabled ARGP_WINDOW_TOKENS=100000 ARGP_RETAIN_TOKENS=33000 ARGP_MAX_PASSES=256 node spike/06-tlong.ts` | Large-transaction pruning (34–35 atoms per transaction) |
| Baseline (compaction-basic) | `node spike/07-baseline.ts` | Same task with the stock summarizer for contrast |
| Synthetic 0-LLM | `npm run spike8a` | 28-atom single-transaction pruning with zero LLM calls |

Experiment results and claims are recorded in [`docs/experiment-2026-08-16-separated-contract-probe.md`](docs/experiment-2026-08-16-separated-contract-probe.md) and the publication ledger in [`docs/publication-plan.md`](docs/publication-plan.md); every number carries its artifact path.

## Known platform gaps (feedback to dsh)

Developing a non-LLM compaction backend surfaced three extensibility gaps in the compaction seam. Details and repro scripts in [`docs/dsh-api-feedback-2026-08-17.md`](docs/dsh-api-feedback-2026-08-17.md):

1. **No structured metadata channel on tool/result replacement** — placeholders must clone the original message and may only swap content.
2. **`compaction/prune` is outside the transaction invariant state machine** — no native event type for algorithmic eviction; third-party engines must borrow `summary` semantics with pseudo fields.
3. **Headless test assembly silently disables the pressure path** — `mountAgentLoopTestDependencies` does not register `tokenMeter`, and the pre-step catch swallows the error.

## License

MIT
