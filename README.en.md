[中文](README.md) | English

# dsh-argp — long-session context compaction: cheaper than LLM summarization, and forgetting is reversible

[![CI](https://github.com/yoza10635/dsh-argp/actions/workflows/ci.yml/badge.svg)](https://github.com/yoza10635/dsh-argp/actions/workflows/ci.yml)
[![GitHub Release](https://img.shields.io/github/v/release/yoza10635/dsh-argp)](https://github.com/yoza10635/dsh-argp/releases)
[![npm version](https://img.shields.io/npm/v/dsh-argp)](https://www.npmjs.com/package/dsh-argp)
[![npm downloads](https://img.shields.io/npm/dm/dsh-argp)](https://www.npmjs.com/package/dsh-argp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Jump to**: [Who it is for](#who-it-is-for--who-it-is-not-for) · [30-second start](#30-second-start) · [Measured comparison](#measured-comparison) · [How it works](#how-it-works) · [Known limitations](#known-limitations) · [Install & compatibility](#appendix-install-and-host-compatibility)

**Long sessions fill the context window, and per-turn LLM summaries are expensive, slow, and shred the prefix cache — and what they forget is gone for good.** This plugin for [DeepSeek Harness](https://github.com/deepseek-ai/dsh) (dsh) compacts in a different direction: only stale, superseded, out-of-focus tool results are pruned deterministically by entity label (**0 LLM; same input, same output, recomputable**), their originals always stay in the append-only log and come back verbatim by label or keyword; conversation prose gets its LLM summary only inside compaction transactions, never between turns.

**Vs per-turn LLM summarization: cost −68% (¥11.58 → ¥3.69) · wall clock −62% (114.7 → 43.3 min) · 97.8% prefix cache hit**¹

**Vs the host's native compaction: similar price (default shape ¥4.18 vs native ¥4.36²), but forgetting is reversible — long-term memory 8/10 vs 2/10³, everything deterministic and recomputable, and tool-heavy sessions run 0 LLM end to end**

```bash
dsh plugin --profile <name> add dsh-argp
```

Works out of the box: the package ships its own bundle patch (disables the stock `compaction-basic` and mounts this plugin); the profile layer only carries config overrides. Host admission range and the minimal-preset caveat live in the appendix below.

> ¹ Same 46-turn workload, fully serial single-arm, n=1 per arm (2026-11-14/15, local endpoint, declared window 262,144). These figures are the **wall-trigger** shape (2.0 series): compaction fires as the fallback on the provider's 400 overflow rejection, compressing only at 98.4% of the window. Since 2.2.0 the default is the **early-trigger** shape (compact before sending); the full re-measure of the same workload comes to **¥4.18 / 40.8 min / 96.5% hit / 73.0% utilization** (2026-11-26, 46/46, 0 dead turns) — different trigger strategies are different calibers: the two books stand side by side and never substitute for each other; full ledger in the appendix.
>
> ² Native = host `compaction-basic`, same workload, measured. This price gap is config-sensitive: at the smaller output budgets typical of desktop configs the line returns near 0.8×window and the gap narrows (see the 2.2.0 re-measure row in the appendix).
>
> ³ Recall-turns-allowed caliber; 8/10 is the 2.0.0 measurement. The 2.2.1 supplement-recall re-run has a structural out-of-band result on the "verbatim material back" axis (while the honesty axis answers truthfully) — both books are in the appendix's long-term memory row; read them together.

![Desktop screenshot: the turn-40 compaction transaction — 113 atoms / ≈155,576 tok booked in one shot](assets/desktop-compaction-t40.png)

Full replay on 2026-11-23: the host's native compaction **never fired once** — 4 ARGP compaction transactions, ≈0.66M tokens shadowed in total; the screenshot above is that very turn.

## Who it is for / who it is not for

**It is for you if —**

- you run **tool-heavy long sessions** (lots of file reads, commands, searches): pruning is judged only on facts that already happened (a newer read of the same file, the file was modified, a current-turn label reference); no model cooperation required, same input same output, recomputable;
- you want **forgetting to be reversible**: pruned originals stay in the log verbatim — `recall_history` fetches by label, `search_history` fetches by literal keyword (including conversation prose already condensed away);
- you need a **controllable bill**: 0 LLM everywhere except prose condensation — ordinary load needs ≈120 turns to reach the condensation criterion, so tool sessions and short sessions cost zero LLM.

**It is not for you if —**

- you expect "compaction at zero cost": every transaction necessarily causes one re-prefill of the retained span (the first request after compaction hits near zero, the next recovers) — this one-off cache tax is a design cost, not a bug (see Known limitations);
- your host is still on the `0.1.x` line (outside the admission range — the plugin is silently skipped) or you run the minimal preset (inactive by default; one profile line enables it);
- your window is <64K or your sessions are attachment-heavy: the barrier/attachment face has no release mechanism at all and must be added on top of the recommended window (see the recommended-window line under Known limitations).

## 30-second start

- Type **`/argp`** in a session: budget, trigger line, prune/recall/cache audit on one card. **`/compact`**: run one manual compaction (full prune + prose condensation).
- Automatic compaction is on by default: before a request is sent, anything at or above the "declared window − output budget − 2%" line triggers a standard compaction transaction first (on by default since 2.2.0); the provider's overflow rejection (400) is demoted to the last-resort net. The single knob is the "Compaction threshold" setting (Settings → Plugins; a 0–1 ratio moves the line earlier, live, no restart); `ARGP_FACTOR_EGRESS=0` is a hard override back to the 400-fallback shape.
- The three recall tools `recall_history` / `search_history` / `list_labels` are automatically available to the model (shared character budget: 5% per call / 10% cumulative of the window; exhaustion is stated explicitly).

```text
ARGP 2.3.0 · engine: factor · preset: standard
world: dispatch=takeover@live egress=on(old-line)@live tiered=flat@boot clip=off@boot qscore=off@boot pressure=off@boot shadow=off@boot peratomDebug=off@live
budget: trigger 209.7k / retain 41.9k · now 88.4k (source=anchored)
prunes: 7 · last 3 ranges / 41 items / 12.8k→3.1k · pruned index 156
recall: 12 calls · 9 hits (75%) [this process]
cache (provider usage; per-request prefix reuse):
  · turn 40 step 1 · prompt 88.4k / cached 2.3k (3%) · refill [tx 7c42e91b]
  · turn 41 step 1 · prompt 90.6k / cached 85.7k (95%)
post-compaction: 1 refill(s) · 0 repeat miss(es) [this process]
```

`source=anchored` means occupancy is anchored to provider-reported usage, and the `cache` block reads the same usage — the `refill` on the first request after compaction is unavoidable, while a `repeat-miss` on a later request of the same transaction means something else is still invalidating the prefix. The `world` line is the fingerprint of what is actually in effect (derived env values + when they apply — look here first when debugging). `ARGP inactive` means the session hit `skipPresets`.

## Measured comparison

Same 46-turn workload, 2026-11-14/15, local Qwen3.8-Flash-Next, declared window 262,144; n=1 per column:

| | Per-turn LLM summary (v1.11.2) | Host native | This plugin, 2.0 series¹ | This plugin, default shape¹ (since 2.2.0) |
|---|---|---|---|---|
| Reference price (DeepSeek off-peak) | ¥11.58 | ¥4.36 | **¥3.69** | ¥4.18 |
| Wall clock | 114.7 min | 61.8 min | **43.3 min** | 40.8 min |
| Prefix cache hit rate | 83.3% | 95.6% | **97.8%** | 96.5% |
| Long-term memory (recall turns allowed) | 7/10 | 2/10 | **8/10** | 2.2.1 re-run: see appendix |
| Forgetting reversible | ✓ | ✗ | ✓ | ✓ |

¹ n=1 per column; the 2.0-series column is wall-trigger, the last column early-trigger — different trigger strategies are different calibers, the two books never substitute for each other. Full token breakdown, utilization, the hidden artifact suite (T0) and the third 2.2.1 book live in the appendix "Measured comparison and caliber" plus the re-measure rows of the tuning appendix; this table is their digest.

## How it works

**Governing principle: tool results may be pruned; conversation prose is only touched inside compaction transactions.**

- **Eviction (0 LLM)**: tool results get entity labels (`document:<path>` / `command:<family>` / `errorcode:<CODE>` / `scope:<dir>`, plus a `tool:<registered-name>` fallback address); judged evictable, a result becomes a one-line labeled stub; undecided candidates queue by recency and size. Prose is never evicted; focal atoms are protected.
- **Prose condensation (the only LLM path)**: transaction-only, and issued only when the approval criteria are met ("prose ≥ 50% of the declared window" is one of them; ordinary load needs ≈120 turns to reach the line). The summary request shares the live conversation's prefix byte-for-byte (measured 98.8% hit); empty output or failure keeps the original — the failure direction is always "condense less".
- **Overflow fallback (last line of defense)**: when a request is rejected by the provider for overflow (400), a standard compaction transaction runs automatically and the request is retried — the net is never removed.
- **Recall**: stubs carry labels; originals come back verbatim by label; content with no label — especially condensed-away conversation prose — is found and fetched verbatim by literal keyword via `search_history`. At transaction commit the plugin injects the session's vocabulary snapshot, visible to the model every turn.

Fixed strategy values (trigger line, retention target, estimation caliber) are in the appendix "Tuning and measurement caliber"; the transaction protocol, host-compat surface and invariants live in [ARCHITECTURE.md](ARCHITECTURE.md).

## Model requirements

- **Eviction does not depend on the model**: identical behavior on any model (0 LLM determinism).
- **Prose condensation** needs an LLM route for the compaction purpose; by default it follows the host's `agent.options`. If the route is unavailable, condensation is disabled, zero network, originals kept. Condensation quality scales with instruction-following, but the failure direction is always "condense less".
- Labels come from tool arguments and outputs; the model is not required to emit any citation protocol.

## Known limitations

The three that matter most for choosing:

- **The first request after compaction always re-prefills once (unavoidable cache tax)**: compaction rewrites early context, so the retained span cannot reuse the prefix on that request — measured: a 239.5K prompt hit only ~0.2K (47s first token ≈ full prefill), and the next request was back at 94%+. The `cache` block in `/argp` reads provider usage and separates "first request after compaction = refill" from "later request of the same transaction = repeat-miss": the former is the design cost, the latter means something else is still invalidating the prefix (directory/system head). The lever is fewer transactions, not a higher per-compaction ratio.
- **Recommended window (W_min, since 2.2.1)**: the healthy-session floor is ≈ measured fixed face (system / tool schemas / resident files) + focus-quota budget (min(20 groups, 0.3×effective window converted to groups by average group bytes)) + fresh prose (~5K tokens typically) + checkpoint/stub face (~3K) + output budget (mct) + headroom. The **barrier/attachment face is the one component no mechanism can release** (image/file blocks are not text-recallable; neither group-prune nor summarization touches them) and is excluded from the above — recommended line: **window ≥ 64K** (excluding attachment face and oversized pastes; attachment-heavy sessions should add their measured attachment volume). The hard-face F on the status card is an approximation (focal/sticky/recall-pair hard slots are not counted); treat both its display and any derivation as approximate.
- **Window approach and blind-spot diagnostics**: un-prunable live nodes (no label, outside the prune vocabulary) form a diagnostic blind spot as occupancy approaches the declared window; the `/argp` status card surfaces an explicit risk line once un-prunable live reaches 80% of the window (approximate diagnostic). Measured (2026-11-19, 40K-window probe): the current host does **not** silently truncate oversized requests — it sends them in full and returns an explicit `CONTEXT_WINDOW_EXCEEDED`, and session archives stay complete; evicted content is therefore never lost and can be fetched verbatim via `search_history(keyword=...)` (2.1.0). Mitigation: the pre-send egress check (compact first, then send) is on by default under compaction takeover (since 2.2.0); the trigger point can be moved earlier via the "Compaction threshold" ratio setting.

<details>
<summary>The other five known limitations (full text)</summary>

- **The egress gate is on by default under compaction takeover** (since 2.2.0): the pre-step prunes first once a request projects at or above the "window − output budget − 2%" line, preventing two things — ① on endpoints whose real wall far exceeds the declared window (gateway auto-escalation, multi-tier models) 400 never fires while the host clamps `max_tokens` to "window − prompt": sessions with a large fixed face (huge AGENTS.md, many tool schemas) fall into the "clamp line < pressure line (0.8×window)" dead zone and turns get clamped into starvation (observed both on the bench and on a real DeepSeek endpoint with the gate off; both ran cleanly with it on); ② the 400→retry→full-replay waste of requests doomed to overflow. The control/eval arm `ARGP_FACTOR_EGRESS=0` is a hard override (closes even the ratio line; behavior falls back to the 400-fallback net, whose precondition is real wall ≈ declared window); setting "Compaction threshold" > 0 installs a custom ratio line. The compressor's legacy worlds (`ARGP_FACTOR_DISPATCH=0/1`) stay off by default — production behavior unchanged.
- **The summary call is billed and cache-aware too**: manual `/compact` and automatic compaction now share the same **host-style context assembly** (system head + routed history + tail instruction), byte-identical to the live conversation prefix — measured 116,736/118,135 hit (98.8%, 14.0s) for the manual summary request, versus 0 hit / 33.3s when it rebuilt a `U:/A:` transcript. Under takeover the summary reuses the host's hot prefix (measured 93–98% hit), so most of the input tax rides the cache price. Summary output remains bounded by the "prose ≥ 50%" criterion and the output budget; extremely prose-heavy sessions may still not pay off.
- **Post-prune address coverage**: every tool result carries at least one `tool:<registered-name>` address (orphan results with a missing tool name excluded); post-prune vocabulary and interaction rows always list addresses and previews — the old "no entity label, no recall" caveat was retired with the tool factor key. Pure chat prose never enters tool pruning and gets no guessed identity (fail-closed), so it has **no label address** — but since 2.1.0 it is recoverable verbatim by literal keyword through `search_history` (including text already condensed away). Labels are addresses; keyword is the content channel.
- **Oversized results vs. global pre-prune**: under ARGP takeover the host's autonomously triggered global pre-prune is stripped from the presets by this package; the live pre-prune is the *same host service borrowed by this package inside each compaction transaction* (threshold ≈8192 chars, tool-name agnostic), and the host only permits rewriting `tool/result` nodes **of the current (open) turn** — what gets cut into head/middle/tail are over-limit `recall_history`/`list_labels` results **freshly returned in that turn**: head and tail visible, middle invisible within the turn (the original always stays in the append-only log and the ledger can re-fetch the full text). Over-limit results from older turns bypass the pre-prune (the host rejects rewrites outside the open turn) and are covered by group-prune, which evicts their whole group as it ages out. For precise long content, prefer small item drill-downs or recall across turns rather than relying on the middle of one giant in-turn full view.
- **Legacy log read path**: old tombstone grammar (v1.3.x–v1.7.x) and old `data.argpCites` remain readable, but 2.0 no longer emits them.

</details>

## Appendix: install and host compatibility

- **Host requirement**: DeepSeek Harness `>=0.2.0-rc.1 <0.3.0-0` (prereleases participate in matching). Both npm `latest` and `next` are on `0.2.2-rc.5` now (0.2.x line; either channel installs directly, matching desktop builds included; install smoke tested on rc.3). Hosts still on the old `0.1.x` line are outside the admission range and the plugin is **silently skipped**. If you don't see `[argp]` logs / the `/argp` command after install, clone this repo and run the preflight: `node scripts/doctor.mjs --dsh <dsh install root>`.
- **Inactive under the minimal preset** (`skipPresets: ['minimal']`). To enable it there, add `config: { skipPresets: [] }` via a profile-level modify.
- **Preset override block (whole-replacement snapshot)**: the GENERATED block at the end of this package's `cordis.patch.yml` modifies the three default presets `standard / cordis / ptc` by replacing their config wholesale — stripping the `compaction-basic` / `tool-result-pruner` rows and the `isolate` block inside their compaction group (the host patch layer has no partial-surgery semantics for presets; whole replacement is the only mechanism that disables native compaction under the default presets). The profile layer's own patch is applied *after every bundle layer*: **your customizations win over this package**, not the other way round; custom preset ids beyond these three are untouched. If your own preset's compaction group was copied from a host template, apply the same surgery there — drop the two stock rows *and* the whole `isolate:` block, all three (dropping the providers but keeping `isolate` leaves `/compact` waiting forever; keeping the stock rows silently reverts prose compaction to native). When the host updates its shipped presets, regenerate the snapshot with `scripts/generate-preset-overrides.ts`; until then the snapshot masks those changes.

## Appendix: measured comparison and caliber

Same prompts, same materials, fully serial single-arm, same endpoint/model/window 262,144; provider-reported token usage broken out in full, with one row folded into a DeepSeek off-peak reference price:

| Dimension | v1.11.2 | Native (host compaction-basic) | v2.0.0 |
|---|---|---|---|
| Compaction mechanism | LLM summaries + contiguous-prune rewrites + system-head rewrite every turn | est-driven pre-clamp prune + periodic LLM summaries | **Deterministic label group-prune** + prose-condense dual gates + turn-boundary budget trigger |
| Wall clock | 114.7 min | 61.8 min | 43.3 min |
| Input miss tokens (miss) | 9.287M | 1.979M | 1.363M |
| Input hit tokens (hit) | 46.21M | 43.49M | 60.06M |
| Output tokens (output) | 0.343M | 0.378M | 0.283M |
| Prefix cache hit rate | 83.3% | 95.6% | 97.8% |
| **DeepSeek off-peak reference price** | **¥11.58** | **¥4.36** | **¥3.69** |
| Declared-window context utilization | 78.9% | 50.0% | 98.4%† |
| Forgetting reversible | ✓ `recall`/`recall_detail` | ✗ | ✓ `recall_history` by label + `search_history` by content (prose too) |
| Long-term memory (recall-allowed turn) | 7/10 | 2/10 | 8/10 (supplementary recall turns) |
| Hidden artifact suite (T0) | 19/20 | 18/20 | 20/20 |

† All three columns measured 2026-11-14/15 (host line unchanged since, comparable); the 2.0-series column is the **wall-trigger** caliber — transactions fire on the provider's 400 overflow rejection as the fallback, compressing only at 98.4% of the window. The 2.2.0 default shape moves the trigger earlier via the egress gate; the full re-measure of the same workload comes to ¥4.18 / 40.8 min / 96.5% / 73.0% (2026-11-26, 46/46, 0 dead turns; one client-side stream stall at T37 re-sent and passed, counted as INFRA) — different trigger strategies, different calibers: the two books are booked separately, never mixed into one column; full ledger in the rows below. Long-term memory 8/10 and T0 20/20 are 2.0.0-era measurements; re-runs landed with 2.2.1 (T0 19/20 — the same single red as history; first supplement-recall baseline; see below).

## Appendix: tuning and measurement caliber

- **Base**: local Qwen3.8-Flash-Next (declared window 262,144), same 46-turn workload, fully serial single-arm, n=1 per arm.
- **Token and price caliber**: token counts are provider-reported usage summed over the run (miss = uncached input, hit = cached input, output = completion); the reference price folds them at **DeepSeek off-peak rates of 1 / 0.02 / 4 元 per 1M tokens**.
- **v2.0.0 column**: the 46-turn run with the pre-send overflow check off (the default shape during 2.0.1–2.1.0; since 2.2.0 the egress gate is on by default under takeover; eval-tier details in [ARCHITECTURE.md](ARCHITECTURE.md) §11); declared-window context utilization is the server's cached_tokens (KV-resident prefix), while 305K is request size, not context.
- **2.2.0 default-shape re-measure (early-trigger caliber, not interchangeable with the column above)**: 2026-11-26, 2.2.0 build; 46/46 completed, 0 dead turns (one T37 client-side stall, re-sent, INFRA): **¥4.18 / 40.8 min / 96.5% hit / 73.0% peak utilization** — at this config's mct=65536 the egress line sits at window − output budget − 2% ≈ 73%×window; at typical desktop output budgets the line returns near 0.8×window and the gap vs the old book narrows. The delta is entirely the price of the trigger point: the egress gate moves compaction from "after the wall" to "before the request", trading window headroom to seal the "host max_tokens clamp < pressure line" starvation band; `ARGP_FACTOR_EGRESS=0` restores the wall-trigger fallback shape. 6 of the 9 transactions were §G cache-shaped summaries with a 0.3–4% miss share of their own. Long-term memory and T0 re-runs landed with 2.2.1 (below).
- **2.2.1 default-shape re-measure (early-trigger caliber)**: 2026-11-26, 2.2.1 build; 46/46 completed, 0 dead turns: **¥4.41 / 44.6 min / 96.14% hit** — the −0.34pp vs the 2.2.0 book is a structural trade (deeper transaction-turn tax offset by +2pp on non-transaction turns); total miss actually fell (~20K), and the output delta was wire-forensics-cleared of effort and summary-accounting factors (n=1 dispersion plus a dead-turn artifact in the old book). Three-domain bench all-clean in the same round (focus 64K: 76/76, 0 dead). **Caliber ruling: 32K scenarios are out of adaptation scope — 64K ≈ W_min is the limit scenario** (see the recommended-window line under Known limitations).
- **Long-term memory**: v2.0.0 answered 3/3 on the first turn (coverage 3/10), and 3 supplementary recall turns (budget reset each turn) recovered 5 more → **8/10**; the remaining 2 are unreachable: one page was touched only by a directory-level grep (scope directory address only; the recall guidance teaches document/command/errorcode), and one page was never read — its content never entered the session log. The model answered C honestly. 1.x's 7/10 comes from its seq-addressed recall stack (`recall`/`recall_detail`) — a real capability, at 2.4× the price and 2.3× the wall clock. 2.2.1 first supplement-recall baseline (tail 7 material needles): 0/7 verbatim — material prose is sweep-merged into summaries from the first transaction with no verbatim transcription band, and the prose-band scan is capped at the oldest ~110.8K chars with no paging; structural out-of-band, not this train's behavior. Honesty axis 7/7: every C answered truthfully, no fabricated anchors, all B-state file anchors real.
- **T0**: hidden artifact suite 20/20 (2.0.0 caliber); comparison summary in `CHANGELOG` 2.0.0. 2.2.1 re-run: **19/20** (the single red, `test_plugin_error_isolated`, is the historical same-item artifact gap — the interface was never implemented, not a compression-behavior issue); native control arm 17/20.
- **Fixed strategy values**: trigger line = the earliest of 0.8× the declared window and the egress line (window − output budget − 2%; on by default under takeover), retention target 0.2, estimation weighted by character class (non-CJK 3.5, CJK 1.7 chars/token, κ calibrated on the Qwen3.8 tokenizer — estimation is only a fallback; occupancy anchors on provider usage), 1 focal turn, 10 vocabulary rows per category, 5 default recall items.
- **The single setting, "Compaction threshold"** (Settings → Plugins, unset by default): set a 0–1 ratio and the egress line becomes declaredWindow × ratio — context reaching that line is **compacted before sending** (live, no restart; prose condensation still rides dispatch approval, "prose ≥ 50% of the declared window" being one of the criteria). **When unset, the egress gate still runs on the legacy formula line under takeover** (since 2.2.0, sealing the "host clamp line < pressure line" starvation band); in the compressor's legacy worlds (`ARGP_FACTOR_DISPATCH=0/1`) it stays off by default — there, compaction transactions are triggered by the provider's overflow rejection (400) or by manual `/compact` (precondition: real wall ≈ declared window). The five other old knobs stay retired (same-named keys in old profiles are tolerated with a warning).

## Upgrading from 1.x

The 1.x graph engine is retired: the old scheme is frozen at npm **`1.11.2`** (tag `v1.11.2`). 2.x maintains only the factor engine; graph-era knobs in old profiles are tolerated with a warning, and the historical CHANGELOG is kept.

## Development

One-shot quality gate: `npm run check` (typecheck + spike typecheck + smoke + unit tests + build); `lib/` artifact consistency is enforced in CI via `git diff --exit-code lib/`. Gate matrix and targeted regressions: [CONTRIBUTING.md](CONTRIBUTING.md); transaction protocol and design baseline: [ARCHITECTURE.md](ARCHITECTURE.md).

## Feedback

- **Bug**: open an [Issue](https://github.com/yoza10635/dsh-argp/issues) with `dsh --version`, the package version, profile config and a minimal reproduction.
- **Design discussion / usage questions**: open a [Discussion](https://github.com/yoza10635/dsh-argp/discussions).

## License

MIT
