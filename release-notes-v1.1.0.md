# dsh-argp 1.1.0

> Paste into GitHub Release (tag: `v1.1.0`). Suggested title: `v1.1.0 — dsh 0.1.5 support (V3 session envelopes; breaking)`

## ⚠️ Host requirement changed (breaking)

**1.1.0 requires dsh ≥ 0.1.5-alpha.1.** Hosts on `0.1.1-rc.2` … `0.1.3-alpha.2` should stay on **dsh-argp 1.0.5**.

The break is dsh's **V3 canonical session envelopes** (`657e68186a`): the `SurfaceOp` replace discriminators were renamed `start`/`end` → `startSeq`/`endSeq`. Both generations enforce `Object.keys(surfaceOp).length === 3`, so **writing both key sets is rejected by both** — a single build cannot serve both hosts without runtime version sniffing. For an engine whose entire value proposition is determinism, sniffing adds a new source of nondeterminism. The tradeoff: **1.0.5 keeps the old hosts, 1.1.0 takes the new format.**

On 0.1.5 the old spelling does not degrade — it throws:

```
session event "user/message" carries an invalid replace surfaceOp
   surfaceOpOf → planSurfaceEvent → SurfaceManager.validateNext → Session.append
```

Because that happens in the synchronous path of `Session.append()`, a failed write-back leaves the compaction transaction half-open (`compaction/start` already durable, no tombstone, no `compaction/end`) rather than silently skipping the prune.

## Migration surface

| Change | ARGP handling |
|---|---|
| `surfaceOp` keys `start`/`end` → `startSeq`/`endSeq` | 5 production sites + 12 tests renamed |
| `assistant/message` now forbids `sourceEventSeqs` (`?: never` + runtime throw) | dropped from the cites-strip write-back; safe because `shadowedSeqsOf` reads the authoritative `compaction/prune.shadowedSeqs` ledger and no longer infers shadowed nodes from replace events |
| `Session.events` removed entirely | the 1.0.4 dual-path helper's legacy branch is now unreachable on supported hosts, retained only as a guard (covered by a stub test) |
| `assistant/message` gained required `stream` | test fixtures updated |
| testkit `systemPrompt.persona` → `personaPrefix` | tests updated |
| `dsh-llm` `CallId` → `ToolCallId` | tests updated |
| `SessionSeq` is now a branded type | new `asSeq`/`asSeqs` boundary helpers — internals stay plain `number`, branding happens only at the dsh API edge |

## Added

- **`asSeq` / `asSeqs`** (`log-access.ts`): documented branding boundary. ARGP internals keep plain `number` for arithmetic; only dsh API edges are narrowed. No duplicated runtime validation — the host already validates seqs authoritatively, and a second copy of that rule would be a second truth to keep in sync.
- **System-prompt node-0 protection**: dsh 0.1.5 represents the system prompt as `system/message` at surface node 0, and `assertSystemHeadRewrite` hard-protects that slot. ARGP's `atomize` only recognizes user/assistant/tool-result, so node 0 never enters a prune range. That was previously an implicit dependency — it is now documented in the source and pinned by a test.

## Verified

- `npm run check` all green — **211/211** (2026-09-10).
- Before the dependency bump, the same code change produced 209 total / 133 pass / **76 fail**, every failure `carries an invalid replace surfaceOp`. That red state is the direct evidence for why the dependency baseline had to move together with the code.

## Known

- dsh's default model is now **DeepSeek-V41-Flash** (V4-Flash remains selectable). ARGP's published v4-flash cost figures **must not be extrapolated** to the new default.
