[中文](README.md) | English

# dsh-argp — context compaction for dsh

[![CI](https://github.com/yoza10635/dsh-argp/actions/workflows/ci.yml/badge.svg)](https://github.com/yoza10635/dsh-argp/actions/workflows/ci.yml)
[![GitHub Release](https://img.shields.io/github/v/release/yoza10635/dsh-argp)](https://github.com/yoza10635/dsh-argp/releases)
[![npm version](https://img.shields.io/npm/v/dsh-argp)](https://www.npmjs.com/package/dsh-argp)
[![npm downloads](https://img.shields.io/npm/dm/dsh-argp)](https://www.npmjs.com/package/dsh-argp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**dsh-argp is a third-party context compaction plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh).** Tool results are evicted deterministically by entity label (0 LLM); prose is condensed once per compaction transaction; an egress gate keeps a request that would necessarily overflow from ever being sent. Everything evicted stays in the append-only log and comes back verbatim via `recall_history(label)`.

> The 1.x graph engine is retired: the old scheme is frozen at npm **`1.11.2`** (tag `v1.11.2`). 2.x maintains only the factor engine; graph-era knobs in old profiles are tolerated with a warning.

## Install

```bash
dsh plugin --profile <name> add dsh-argp
```

**Mounted on install, no manual wiring**: the package ships its own bundle patch (disables the stock `compaction-basic` and mounts this plugin); the profile layer only carries config overrides.

> **Installing within 24 hours of a release? Pin the version.** pnpm 11's `minimumReleaseAge` defaults to 24 h, so a fresh release is silently skipped and installs fall back to the previous one. Use `dsh plugin --profile <name> add dsh-argp@<version>`, or add `minimumReleaseAgeExclude: [dsh-argp]` to the profile's `pnpm-workspace.yaml`.

> **Inactive under the minimal preset** (`skipPresets: ['minimal']`). To enable it there, add `config: { skipPresets: [] }` via a profile-level modify.

## Usage

- Type **`/argp`** in a session: budget, trigger line, prune and recall stats.
- **`/compact`**: run one manual compaction (full prune + prose condensation).
- Compaction is automatic: when context approaches the window, the egress gate stops the over-window request, runs the standard compaction transaction, then sends; provider 400 remains the last-resort net.
- Two recall tools are automatically available to the model: `recall_history` (verbatim text by label) and `list_labels` (vocabulary browser).

```text
ARGP 2.0.0-alpha.5 · engine: factor · preset: standard
budget: trigger 209.7k / retain 41.9k · now 88.4k (source=anchored)
prunes: 7 · last 3 ranges / 41 items / 12.8k→3.1k · pruned index 156
recall: 12 calls · 9 hits (75%)
```

`source=anchored` means usage is anchored to provider-reported truth; `ARGP inactive` means the session hit `skipPresets`.

## Zero configuration

Since 2.0.0 there are no settings knobs: the six strategy values are fixed at a trigger
line of 0.8× the declared window, retention target 0.2, 3.5 chars/token, 1 focal turn,
10 vocabulary rows per category, and 5 default recall items. Same-named keys in old
profiles are tolerated with a warning and ignored; behavior always follows the fixed defaults.

## How it works

- **Eviction (0 LLM)**: tool results get entity labels (`document:<path>` / `command:<family>` / `errorcode:<CODE>` / `scope:<dir>`); deterministic staleness (superseded reads, newer versions, non-focal turns) scores them, and evictable ones become a one-line labeled stub. Prose is never evicted; focal turns are protected.
- **Prose condensation**: the plugin's only LLM path, transaction-only, fired only when both gates pass (prose ≥50% of the declared window AND context ≥ `windowRatio×window`); empty output or failure keeps the original.
- **Egress gate**: before a request is sent, anchored arithmetic decides whether it would necessarily overflow — if so it is not sent; compress first, then send. Provider 400 is the last-resort net.
- **Recall**: stubs carry labels; the original text comes back verbatim from the log by label. Both recall tools share a character budget (5% per call / 10% cumulative of the window) and state exhaustion explicitly.

Compared with LLM-summary compaction: eviction is deterministic and recomputable; forgetting is reversible (the original never leaves the log); history is rewritten only inside compaction transactions, so the prefix cache is not shredded by per-turn rewrites. Transaction protocol, host-compat surface and invariants live in [ARCHITECTURE.md](ARCHITECTURE.md).

## Measured comparison (T24-J, 2026-11-14/15, local Qwen3.8-Flash-Next)

The same 46-turn workload (same prompts, same materials, fully serial single-arm, same
endpoint/model/window 262,144); provider-reported token usage is broken out into its three
components, which one consolidated row folds into a DeepSeek off-peak reference price (in 元):

| Dimension | v1.11.2 | Native (host compaction-basic) | v2.0.0 |
|---|---|---|---|
| Compaction mechanism | LLM summaries + contiguous-prune rewrites + system-head rewrite every turn | est-driven pre-clamp prune + periodic LLM summaries | **Deterministic label group-prune** + prose-condense dual gates + turn-boundary budget trigger |
| Wall clock | 114.7 min | 61.8 min | 43.3 min |
| Input miss tokens (miss) | 9.287M | 1.979M | 1.363M |
| Input hit tokens (hit) | 46.21M | 43.49M | 60.06M |
| Output tokens (output) | 0.343M | 0.378M | 0.283M |
| Prefix cache hit rate | 0.833 | 0.956 | 0.978 |
| **DeepSeek off-peak reference price** | **11.58 元** | **4.36 元** | **3.69 元** |
| Peak KV-resident context (share of declared window) | 78.9% | 50.0% | 98.4% |
| Forgetting reversible | ✗ | ✗ | ✓ `recall_history` byte-for-byte by label |
| Material-needle memory (no-tools turn) | 0/12 | 0/12 | 1/12 |
| Long-term memory (recall-allowed turn) | 7/10 | 2/10 | 3/3 = 100% |
| Hidden artifact suite (T0) | 19/20 | 18/20 | 17/20 |

Note: measured on **local Qwen3.8-Flash-Next** (declared window 262,144) — same 46-turn workload, fully serial single-arm, n=1 per arm; token counts are provider-reported usage summed over the run (miss = uncached input, hit = cached input, output = completion), and the reference price folds them at **DeepSeek off-peak rates of 1 / 0.02 / 4 元 per 1M tokens**. The v2.0.0 column is the egress-gate-off paired arm egress0b's settled values; peak is the server's cached_tokens (KV-resident prefix), while 305K is request size, not context; long-term memory for v2.0.0 is scored on the answered set (**3/3 = 100%**; 3/10 is recall-budget coverage — the 7 unanswered were honestly declined with zero fabrication), and all three T0 failures are unlocked-shape trajectory judgments. Full seven-arm data and per-turn detail live in `CHANGELOG` 2.0.0-alpha.5.

## Model requirements

- **Eviction and the egress gate do not depend on the model**: identical behavior on any model (0 LLM determinism).
- **Prose condensation** needs an LLM route for the compaction purpose; by default it follows the host's `agent.options`. If the route is unavailable, condensation is disabled, zero network, originals kept. Condensation quality scales with instruction-following, but the failure direction is always "condense less".
- Labels come from tool arguments and outputs; the model is not required to emit any citation protocol.

## Known limitations

- **B-6 window-truncation blind spot**: live nodes that were never replaced can be truncated at the oldest end by the request assembler near the context window, leaving no trace — they are not in the prune vocabulary, and label recall cannot reach them. Mitigation: ratio budgets move the trigger earlier; the real fix belongs in dsh (B-6 filed).
- **Condensation output tax**: condensation is the only LLM call, and only inside a transaction; an over-long summary can eat the savings. Gate 1 (prose ≥50%) and the 20480 output budget bound it, but extremely prose-heavy sessions may still not pay off.
- **Content without entity labels cannot be evicted**: pure chat or outputs with no path/command/error code are untouched by pruning and wait for condensation. This is the other side of "labels are the only address" (fail-closed: never guess identity).
- **Legacy log read path**: old tombstone grammar (v1.3.x–v1.7.x) and old `data.argpCites` remain readable, but 2.0 no longer emits them.

## Development & verification

- `npm run check`: typecheck + smoke + unit tests (275) + build.
- Egress-gate tests: `npm run test -- --test-name-pattern=EG-`.
- Offline corpus replay: `node --import ./scripts/ts-import-rewrite-loader.mjs spike/50-t2-replay.ts`.
- Per-turn detail and seven-arm data for the 46-turn comparison live in `CHANGELOG` 2.0.0-alpha.5; 1.x experiment scripts are archived under `spike/retired-1x/` (not compiled).

## Feedback

- **Bug**: open an [Issue](https://github.com/yoza10635/dsh-argp/issues) with `dsh --version`, the package version, profile config and a minimal reproduction.
- **Design discussion / usage questions**: open a [Discussion](https://github.com/yoza10635/dsh-argp/discussions).

## License

MIT
