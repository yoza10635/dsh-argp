[中文](README.md) | English

# dsh-argp — Two-engine context compaction: guarded per-atom shrink + deterministic reference-graph eviction

[![CI](https://github.com/yoza10635/dsh-argp/actions/workflows/ci.yml/badge.svg)](https://github.com/yoza10635/dsh-argp/actions/workflows/ci.yml)
[![GitHub Release](https://img.shields.io/github/v/release/yoza10635/dsh-argp)](https://github.com/yoza10635/dsh-argp/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

dsh-argp is a third-party context compaction engine for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) in its 1.0.0 two-engine form:

- **Stage-1 per-atom shrink (eager, per turn)** — at turn end, the turn's atoms are *shrunk*, not discarded: the model picks `extract` (verbatim excerpt) / `summary` (abridged; every dropped token is itemized into an audit ledger) / `false` (keep original) per atom, and **deterministic guards decide whether a proposal lands** — an `extract` missing even one load-bearing token is rejected whole. The LLM only proposes; it never destroys.
- **Stage-2 reference-graph eviction (lazy, at pressure)** — on the atom reference graph (deterministic A→R pairing edges + model-declared semantic cites edges), whole atoms are evicted in reverse topological order with **zero LLM calls in the eviction phase**, so the compression budget is honored exactly.
- **The append-only log is the single source of truth** — originals of everything shrunk or evicted stay in the log forever; two-tier recall `recall_summary` / `recall_detail` (byte-exact, hash-locked by tests) brings them back on demand. The context is a rendered view of the log, not the history itself.

## Why

Summarizer-based compaction (an LLM rewriting history) pays three prices:

1. **Lossy** — exact tokens (paths, error codes, config values) die first in any rewrite, and are unrecoverable;
2. **Cache wipeout** — rewritten history changes the system+prefix every turn, invalidating cross-turn KV/prefix caches from the change point on;
3. **Uncontrolled ratio** — summary length is at the model's whim; the budget is never honored.

ARGP's answer: **the LLM stays in the loop, but in chains** — its output is always an untrusted input proposal, and guards adjudicate under verbatim discipline; **forgetting is deterministic** — 0-LLM graph rules guarantee convergence and budget; **history is immutable** — the append-only log carries every original, backed by the recall contract (never guess).

Measured (30-turn synthetic multi-turn coding task, four-arm comparison, spike 37): the only arm that achieves both **7/7 probe fidelity** and lower cost than the active baseline is the dual-engine arm (A); the traditional summary baseline (D) is cheapest but scores 5/7 — it swallows exact strings and key gist. **The selling point is not "cheapest" but "cheapest under fidelity"** (A's full cost components ≤ baseline C; 3.39× more expensive than D — that gap is the price of fidelity, priced openly).

> How it works (dual-engine pipeline, reverse-topological pruning, shadow-price contract, module map) — see [ARCHITECTURE.md](ARCHITECTURE.md).

## Core mechanics

### Stage-1: PeratomCompressor (eager entropy reduction)

1. **Deterministic gating** (`gate.ts`): pure predicates decide *whether* a turn is compressible (long user messages / tool results over 512 chars / non-version-chain members); the LLM only decides *how*.
2. **Per-atom decisions**: a single LLM call returns `{seq, level, text}` decisions — `extract` (verbatim subset; the guard hard-rejects missing tokens) / `summary` (allowed; every dropped token is itemized into `summaryDropped` for audit) / `false` (explicitly keep the original); long user messages go through splitting (dialog verbatim transcription + remainder aggregated as U-info, gaps assigned to info).
3. **No-op guard**: full-copy proposals with ≤5% gain count as `false` — no replace event is emitted (a zero-gain replacement wastes a surface generation for nothing).
4. **Tail-only replacement**: replacements must satisfy sourceEventSeqs ⊆ the current turn's range (out-of-range is a bug, locked by assertion); prefix-fingerprint tests prove request-prefix stability across N turns of per-turn compression — the lifeline of cache economy.

### Stage-2: ArgpGraphEngine (lazy graph eviction, 0-LLM)

1. **Atomization + graph building**: deterministic edges (assistant → its tool results, via `toolCallId`) + semantic edges (the model outputs `{"cites":[{"t":"prefix","l":"c|s|x"}]}` per contract, four levels: critical/supporting/contextual/isolated).
2. **Topological eviction**: repeatedly evict in-degree-0 atoms (ordered by edge level → effective importance → last-reference turn); evicted atoms' outgoing edges vanish and downstream atoms unlock pass by pass; the closure lifecycle (ACTIVE→COMPLETED→PRUNABLE→PRUNED) retires finished task closures whole.
3. **Budget honored exactly**: window = contextWindow×0.8 trigger, retain = window×0.2 target; the degradation chain lifecycle→summarize→force→fail converges to budget or fails explicitly — measured 200K → 160K trigger → 32K retained, landing exactly.

### Bridging and recall

- **CiteDeclarer** (per turn): the model declares cross-turn reference edges over its window, fed to Stage-2 through the `injectEdges` channel — measured recall efficiency ≈ 2.6× the edgeless arm (zoom pinpoints the right atoms).
- **RecallZoom**: `recall_summary(seq)` (compressed state) / `recall_detail(seq)` (byte-exact log original); 4:1 budgeting (summary budget = 4× detail) — over-budget calls return guidance text instead of a hard refusal. Atoms evicted from history are additionally served by `recall_pruned` / `list_pruned`.

## Model requirements (honest version)

The quality of per-atom split/shrink decisions depends on the model's instruction-following ability; **the guards guarantee "never compresses badly" on any model (errors only ever err toward compressing less), but the benefit scales with compliance**:

- Measured baseline: local Qwen3.6-35B-A3B / Qwen3.8-27B, full pipeline over 30/60 turns with 0 errors and 7/7 probes; parse failures of the split-transcription notation 0% (vs 72% for interval locating).
- **Known DeepSeek-family trait**: when the system prompt conflicts with user instructions (e.g. a task prompt saying "nothing else"), cites declarations can drop to 0 — semantic selectivity goes to zero, but Stage-1 guarded compression and Stage-2 deterministic eviction keep working and all invariants pass (50-turn v4-flash evidence). Once the task prompt leaves room for cites, the declaration rate recovers (43.6% measured over 10 turns).
- The information-contract compliance probe (info-contract) will be measured on DeepSeek in the post-1.0.0 recheck round.

## Install & mount

Install from npm (the `v1.0.0` two-engine form):

```bash
dsh plugin --profile <name> add dsh-argp
```

Disable the stock summarizer in the profile's `cordis.patch.yml`:

```yaml
- id: compaction-basic
  disabled: true
```

> Mounting is handled by the package's own bundle patch (`cordis.patch.yml`) (`insert` creates the entry); the profile layer should only override config (`modify`) — do not `insert` again there (otherwise `duplicate loader entry id`).

### Two-engine configuration (1.0.0 form)

Stage-1 components resolve their endpoint from environment variables by default (`DEEPSEEK_API_KEY`); in production, point them explicitly at the host dsh-llm:

```yaml
- id: dsh-argp
  config:
    compressor:
      llm: { provider: deepseek-official, model: deepseek-v4-flash }   # dsh-llm backend
    declarer:
      llm: { provider: deepseek-official, model: deepseek-v4-flash }   # may point at a separate lite tier
```

Without `llm` config, it falls back to OpenAI-compatible direct connection via `endpoint`/`apiKey` config or environment variables (the local llama.cpp experiment form; behavior unchanged). Stage-2 budgets are ratio-driven by default (window=ctx×0.8 / retain=window×0.2); no hardcoding needed.

## Validation results

### Four-arm comparison (30-turn synthetic multi-turn coding, local Qwen3.6-35B-A3B, spike 37)

| Arm | Configuration | Probes | Cost (idle pricing) | Verdict |
|---|---|---|---|---|
| **A dual-engine full** | compressor + declarer + graph + zoom | **7/7** | ¥0.454 | The only 7/7 arm at ≤ baseline cost |
| B edgeless | declarer off | 7/7 | ¥0.556 | 31 recalls vs A's 12 (declarer ≈2.6× cheaper) |
| C active baseline | graph only (evicts at overflow) | 6/7 (R2 missed) | ¥0.802 | A's full cost components ≤ C |
| D summary baseline | dsh stock BasicCompactionEngine | 5/7 (loses exact tokens + gist) | ¥0.134 | Cheapest but loses fidelity — the foil for "cheapest under fidelity" |

Anti-interference: zero replacements of append-origin originals across arms A/B/C (A 140 / B 154 / C 216 events); prefix stability: A's 21 main requests share one fingerprint.

### Water level and turn amplification

Measured behavior under a fixed window (16K tok; P5-bis, local Qwen3.6-35B-A3B, 2026-08-28 — evidence detail in `CHANGELOG`):

- **Turn count amplified substantially**: the zero-compaction control dies at ~20 turns on the window ceiling; the dual engine survives to full budget under the same window (~60-turn scale) — sustainable turns under a fixed window improve by an order of magnitude (lower-bound caliber; never cite bare multipliers — always carry window/task/model).
- **Zero per-request prefix-stability degradation**: the dual engine's per-request prefix fingerprint distribution matches the zero-compaction control; compaction events add only a one-time recompute tax, no cumulative degradation.

### Graph engine historical validation (v0.3.x, DeepSeek v4-flash / Qwen3.8-27B)

50-turn t-long: U anchors 7/7, needles 7/7 (5/7 recovered via recall), 4 transactions 0 errors, compression target honored exactly (32K); 200K mainline cost ¥2.695 vs baseline high ¥3.087 (that baseline contains 77% empty-stream errors — a platform B-5 defect; read the contrast under this caliber, the disabled tier ¥3.19 is the cleaner control).

## Reproduce

| Experiment | Command | What it validates |
|---|---|---|
| Four-arm comparison (needs a local model) | `ARGP_ARM=A\|B\|C\|D\|E node spike/37-peratom-three-arm.ts` | Probe fidelity, cost triplet, anti-interference, K_no / amplification |
| per-atom soak | `npm run spike36` | Eight verdicts: gating / chain / conservation / prefix / VK-atom |
| 50-turn t-long | `ARGP_DEEPSEEK_THINKING=enabled node spike/06-tlong.ts` | L1/L2/L3 invariants, anchors/needles, exact budget |
| Synthetic 0-LLM | `npm run spike8a` | Single transaction with zero LLM calls |
| Per-atom audit | `node spike/atom-audit.mjs <artifact dir>` | Event-driven per-atom shrink/eviction detail |

`npm run check` = typecheck + smoke + unit tests (202/202 green as of 2026-09-02). Every number carries its artifact path (evidence landing in `CHANGELOG.md`).

## Platform gap feedback (for dsh)

No structured metadata channel for tool/result replacement (B-1), compaction/prune outside the transaction state machine (B-3), headless test assembly silently disables tokenMeter (B-4), summarizer empty streams (B-5), window truncation leaves no trace (B-6) — the formal record lives in [dsh Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions) (#1090 and related threads).

## Known limitations

- **B-6 window-truncation blind spot**: live nodes not replaced by ARGP get their oldest part silently truncated by the request-assembly layer as the context nears contextWindow — `recall_pruned` cannot recover them. Mitigation: ratio budgets trigger earlier; the root fix is on the dsh side (B-6 filed upstream).
- **Model dependence (honest version, above)**: guards guarantee safety; benefits depend on compliance. The lite-tier multi-model split's compliance is unmeasured (ledger D21).
- **per-atom output tax**: Stage-1's per-turn compression call is a side-channel cost (7.2K completion tokens over 30 turns, measured; it never enters the context but counts toward total cost); usage from the dsh-llm backend is recorded, and the spike aggregation caliber is being wired up.
- **Two-hop tombstone recall**: as placeholder text drifts across turns the original seq can be lost; `recall_pruned(seq)` needs the correct numbering (eliminated together once B-6 lands).

## Reporting issues

- **Bugs**: open an [Issue](https://github.com/yoza10635/dsh-argp/issues) with `dsh --version`, this package's version, your profile config (`windowTokens`/`retainTokens` etc.), and a minimal reproduction.
- **Design discussion / usage questions**: open a [Discussion](https://github.com/yoza10635/dsh-argp/discussions).

## License

MIT
