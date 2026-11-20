[中文](README.md) | English

# dsh-argp — entity-label context compaction: deterministic label pruning of tool results (0 LLM) + LLM prose summaries at compaction time

[![CI](https://github.com/yoza10635/dsh-argp/actions/workflows/ci.yml/badge.svg)](https://github.com/yoza10635/dsh-argp/actions/workflows/ci.yml)
[![GitHub Release](https://img.shields.io/github/v/release/yoza10635/dsh-argp)](https://github.com/yoza10635/dsh-argp/releases)
[![npm version](https://img.shields.io/npm/v/dsh-argp)](https://www.npmjs.com/package/dsh-argp)
[![npm downloads](https://img.shields.io/npm/dm/dsh-argp)](https://www.npmjs.com/package/dsh-argp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Long sessions fill the window, and per-turn LLM summaries are expensive while shredding the prefix cache.** This plugin is a context compaction plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh): only stale, superseded, out-of-focus tool results are pruned deterministically by entity label (0 LLM); pruned originals stay in the log and come back verbatim by label; conversation prose is summarized only inside compaction transactions; prose condenses automatically when context crosses the line, and requests rejected by the provider for overflow are pruned and retried automatically.

46-turn benchmark: 43.3 min wall clock · ¥3.69 DeepSeek off-peak reference price · 97.8% prefix cache hit rate (n=1, see table notes).

## Install

```bash
dsh plugin --profile <name> add dsh-argp
```

**Works out of the box, no manual wiring**: the package ships its own bundle patch (disables the stock `compaction-basic` and mounts this plugin); the profile layer only carries config overrides.

**Host requirement**: DeepSeek Harness `>=0.2.0-rc.1 <0.3.0-0` (prereleases participate in matching). Both npm `latest` and `next` are on `0.2.2-rc.5` now (0.2.x line; either channel installs directly, matching desktop builds included; install smoke tested on rc.3). Hosts still on the old `0.1.x` line are outside the admission range and the plugin is **silently skipped**. If you don't see `[argp]` logs / the `/argp` command after install, clone this repo and run the preflight: `node scripts/doctor.mjs --dsh <dsh install root>`.

> **Installing within 24 hours of a release? Pin the version.** pnpm 11's `minimumReleaseAge` defaults to 24 h, so a fresh release is silently skipped and installs fall back to the previous one. Use `dsh plugin --profile <name> add dsh-argp@<version>`, or add `minimumReleaseAgeExclude: [dsh-argp]` to the profile's `pnpm-workspace.yaml`.

> **Inactive under the minimal preset** (`skipPresets: ['minimal']`). To enable it there, add `config: { skipPresets: [] }` via a profile-level modify.

## Usage

- Type **`/argp`** in a session: budget, trigger line, prune and recall stats.
- **`/compact`**: run one manual compaction (full prune + prose condensation).
- Automatic compaction: prose condenses first when context crosses the line (0.8× the declared window); when a request is rejected by the provider for overflow (400), a full prune runs and the request is retried automatically.
- Three recall tools are automatically available to the model: `recall_history` (verbatim text of pruned results by entity label), `search_history` (find and fetch by literal keyword, including conversation prose already condensed away), and `list_labels` (vocabulary browser).

```text
ARGP 2.0.0 · engine: factor · preset: standard
budget: trigger 209.7k / retain 41.9k · now 88.4k (source=anchored)
prunes: 7 · last 3 ranges / 41 items / 12.8k→3.1k · pruned index 156
recall: 12 calls · 9 hits (75%)
```

`source=anchored` means usage is anchored to provider-reported truth (the most accurate); `ARGP inactive` means the session hit `skipPresets`.

## How it works

Strategy values are fixed: trigger line 0.8× the declared window, retention target 0.2, estimation weighted by character class (non-CJK 3.5, CJK 1.7 chars/token, κ calibrated on the Qwen3.8 tokenizer — estimation is only a fallback; occupancy anchors on provider usage), 1 focal turn, 10 vocabulary rows per category, 5 default recall items. **The single setting, "Compaction threshold"** (Settings → Plugins, off by default): set a 0–1 ratio and context reaching declaredWindow × ratio is **compacted before sending** (live, no restart; above 0.8 the prose-condensation line at 0.8×window acts first and the threshold line adds pruning on top); **when off, a wall hit (the provider rejecting an oversized request) triggers compaction as the fallback** — suited to endpoints whose real wall ≈ the declared window; endpoints that auto-escalate (real wall ≫ declared window) should turn it on. The five other old knobs stay retired (same-named keys in old profiles are tolerated with a warning).

**Governing principle: tool results may be pruned; conversation prose is only touched inside compaction transactions.**

- **Eviction (0 LLM)**: tool results get entity labels (`document:<path>` / `command:<family>` / `errorcode:<CODE>` / `scope:<dir>`); deterministic judgment over three already-happened facts (a newer read of the same file, the file being modified, a current-turn label reference); undecided candidates queue by recency and size, evictable ones become a one-line labeled stub. Prose is never evicted; focal atoms are protected.
- **Prose condensation**: the plugin's only LLM path, transaction-only, fired only when both gates pass (prose ≥50% of the declared window AND context ≥ 0.8× the declared window); empty output or failure keeps the original.
- **Overflow fallback**: when a request is rejected by the provider for overflow (400), a standard compaction transaction (full prune + prose condensation) runs automatically and the request is retried.
- **Recall**: stubs carry labels; the original text comes back verbatim from the log by label (`recall_history`); content with no label — especially condensed-away conversation prose — is found and fetched verbatim by literal keyword (`search_history`, 2.1.0: tiered previews, `hit=` second-hop full fetch, a label distribution when there are too many hits). All three tools share a character budget (5% per call / 10% cumulative of the window) and state exhaustion explicitly. After compaction, the vocabulary note tells the model to recall by label or keyword.

Compared with LLM-summary compaction: eviction is deterministic and recomputable; forgetting is reversible (the original never leaves the log); history is rewritten only inside compaction transactions, so the prefix cache is not shredded by per-turn rewrites. Transaction protocol, host-compat surface and invariants live in [ARCHITECTURE.md](ARCHITECTURE.md).

## Measured comparison (2026-11-14/15, same 46-turn workload, local Qwen3.8-Flash-Next)

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
| Prefix cache hit rate | 83.3% | 95.6% | 97.8% |
| **DeepSeek off-peak reference price** | **11.58 元** | **4.36 元** | **3.69 元** |
| Declared-window context utilization | 78.9% | 50.0% | 98.4% |
| Forgetting reversible | ✓ `recall`/`recall_detail` | ✗ | ✓ `recall_history` by label + `search_history` by content (prose too) |
| Long-term memory (recall-allowed turn) | 7/10 | 2/10 | 8/10 (supplementary recall turns) |
| Hidden artifact suite (T0) | 19/20 | 18/20 | 20/20 |

Note:

- **Base**: local Qwen3.8-Flash-Next (declared window 262,144), same 46-turn workload, fully serial single-arm, n=1 per arm.
- **Token and price caliber**: token counts are provider-reported usage summed over the run (miss = uncached input, hit = cached input, output = completion); the reference price folds them at **DeepSeek off-peak rates of 1 / 0.02 / 4 元 per 1M tokens**.
- **v2.0.0 column**: the 46-turn run with the pre-send overflow check off (the default shape as of 2.0.1; eval-tier details in [ARCHITECTURE.md](ARCHITECTURE.md) §11); declared-window context utilization is the server's cached_tokens (KV-resident prefix), while 305K is request size, not context.
- **Long-term memory**: v2.0.0 answered 3/3 on the first turn (coverage 3/10), and 3 supplementary recall turns (budget reset each turn) recovered 5 more → **8/10**; the remaining 2 are unreachable: one page was touched only by a directory-level grep (scope directory address only; the recall guidance teaches document/command/errorcode), and one page was never read — its content never entered the session log. The model answered C honestly. 1.x's 7/10 comes from its seq-addressed recall stack (`recall`/`recall_detail`) — a real capability, at 2.4× the price and 2.3× the wall clock.
- **T0**: hidden artifact suite 20/20; comparison summary in `CHANGELOG` 2.0.0.

## Model requirements

- **Eviction does not depend on the model**: identical behavior on any model (0 LLM determinism).
- **Prose condensation** needs an LLM route for the compaction purpose; by default it follows the host's `agent.options`. If the route is unavailable, condensation is disabled, zero network, originals kept. Condensation quality scales with instruction-following, but the failure direction is always "condense less".
- Labels come from tool arguments and outputs; the model is not required to emit any citation protocol.

## Known limitations

- **B-6 window-truncation blind spot**: live nodes that were never replaced can be truncated at the oldest end by the request assembler near the context window, leaving no trace — they are not in the prune vocabulary, and label recall cannot reach them. Mitigation: set `ARGP_FACTOR_EGRESS=1` to enable the pre-send overflow check (compress first, then send), which moves the trigger earlier; the real fix belongs in dsh (B-6 filed).
- **Fallback net precondition**: the gate-off default assumes "real wall ≈ declared window" — the provider must actually reject oversized requests (400) for the fallback chain to trigger auto-pruning. If an endpoint's real wall far exceeds the declared window (gateway auto-escalation, multi-tier models), 400 never fires and auto-pruning goes inert under the default (only prose condensation and manual `/compact` remain); such endpoints should set `ARGP_FACTOR_EGRESS=1` (validated on a real DeepSeek endpoint: gate-off wedged turns by clamping the client-side generation budget to its minimum; gate-on ran the full workload cleanly).
- **Condensation output tax**: condensation is the only LLM call, and only inside a transaction; an over-long summary can eat the savings. Gate 1 (prose ≥50%) and the 20480 output budget bound it, but extremely prose-heavy sessions may still not pay off.
- **Content without entity labels**: pure chat or outputs with no path/command/error code are untouched by pruning and never guessed an identity (fail-closed) — so they have no label address. Since 2.1.0 they are still recoverable verbatim by literal keyword through `search_history` (including text already condensed away). Labels are addresses; keyword is a content channel.
- **Legacy log read path**: old tombstone grammar (v1.3.x–v1.7.x) and old `data.argpCites` remain readable, but 2.0 no longer emits them.

## Development & verification

- `npm run check`: typecheck + smoke + unit tests (336) + build.
- Pre-send overflow check tests: `npm run test -- --test-name-pattern=EG-`.
- Summary caliber of the 46-turn comparison in `CHANGELOG` 2.0.0; 1.x experiment scripts are archived under `spike/retired-1x/` (not compiled).

## Upgrading from 1.x

The 1.x graph engine is retired: the old scheme is frozen at npm **`1.11.2`** (tag `v1.11.2`). 2.x maintains only the factor engine; graph-era knobs in old profiles are tolerated with a warning, and the historical CHANGELOG is kept.

## Feedback

- **Bug**: open an [Issue](https://github.com/yoza10635/dsh-argp/issues) with `dsh --version`, the package version, profile config and a minimal reproduction.
- **Design discussion / usage questions**: open a [Discussion](https://github.com/yoza10635/dsh-argp/discussions).

## License

MIT
