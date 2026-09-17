# dsh-argp 1.2.0

> Paste into GitHub Release (tag: `v1.2.0`). Suggested title: `v1.2.0 — token ontology (components A/B) + tombstone-floor fix (breaking host line)`

## ⚠️ Host requirement moved (breaking baseline, additive changes)

**1.2.0 aligns its peer line to `@deepseek-ai/dsh-*` 0.1.6-alpha.1 (cordis ^4.0.2).** This follows the project's established practice (see 1.1.0) of tracking the official host's release line with a stable plugin version — dsh has no true stable line, its `latest` tags are rc builds.

- Hosts on `0.1.5-rc.1` can keep **1.1.0**.
- Zero core-API drift was observed on the alpha line (build/tests byte-clean after the bump), so no behavioral migration is required — only the dependency floor.

## Fixed — the tombstone floor (§11.8①)

Long production sessions eventually hit `CONTEXT_WINDOW_EXCEEDED` even with ARGP mounted. Root cause: ARGP's own `[elided …]` tombstones are plugin-source `X` atoms, which the pruner structurally never selects — so every compaction added permanent floor, monotonically. Both independent control-arm runs reproduced the identical provider-side number (`141,313+32,768>174,080`); the run2 dump showed **1297 of 1310 surface nodes were tombstones (≈142K tokens)**.

Fix: `consolidateTombstones()` — before each graph prune, any run of ≥`tombstoneMergeMinRun` (default 8) consecutive mergeable ARGP tombstones is transactionally merged into one aggregate tombstone. The aggregate keeps the same mergeable shape, so the floor converges to a constant instead of growing. Originals remain recoverable via `recall_pruned(seq)`. Host-injected reminders, official checkpoints, and tool-placeholder tombstones are explicitly excluded. `tombstoneMergeMinRun: 0` disables (used as the A/B control knob).

End-to-end proof: run2 T16 consolidated 1294 tombstones → one 192-char aggregate; turns T16–T22 completed with zero re-overflow.

## Added — token ontology (components A + B)

New `token-ontology.ts` is the single source of truth for the load-bearing token vocabulary, shared by two mechanisms (0-LLM, both default-on):

**Component A — inferred semantic edges.** When the model's declared-cites channel is empty (measured: ~1.5% declaration rate on real local-model sessions), newer assistant atoms that verbatim contain a data atom's load-bearing tokens derive `inferred` edges (weight 1, below all declared levels). Protection only ever increases; the error direction stays "prune less". A₁-style experiments (`disableCiteEdges`) isolate inferred edges too, preserving the zero-semantic-edge arm semantics.

**Component B — HLS trailer repair + economics gate.** When an `extract` copy is rejected by the fidelity guard, v1.1 discarded the whole compression gain. v1.2 appends the missing hard tokens as a verbatim `[restored]` trailer — hard-token fidelity becomes true by construction, prose loss is bounded like the summary tier. A first-principles ROI gate (`hlsRepairEconomics`, θ=1 default) rejects repairs whose trailer doesn't pay for itself (`netRelease/trailerCost < θ`), falling back to v1.1 behavior. Ledgers: `hlsRepairs` / `restoredByGuard` / `hlsRoiSkipped`.

## Known limits (from this cycle's spikes, deliberately not patched)

- Inferred-edge stopword filtering is all-or-nothing at DF>15% (F40-1), and `maxEdgesPerAtom` truncates by seq-desc, which can drop older true dependencies (F40-2). On real corpora the stopword threshold never engages (max DF observed 17 ≪ 33) and 89.7% of edges have single-token support — but single-token support is the shared shape of true references and coincidences alike, so **this measures weak discrimination, not high mislink rate**. Both candidate fixes ("DF decay", "≥k tokens") were tried analytically and retracted: the first has nothing to decay on the real distribution, the second kills true references. Gate changes are blocked on the blinded real-edge labeling worksheet (spike42), not yet scored.
- N=1 A/B corpora cannot attribute component-A's prune-then-reread cost: non-determinism made the two arms diverge ~2× in step count (spec §11.9). Multi-seed or record-replay is required before quoting an attribution number.

## Verified

- `npm run check` green: typecheck + typecheck:spike + smoke + **237/237 tests** (229 baseline + 8 this cycle).
- spike38 (component A parity invariants) ALL PASS; spike39 (HLS invariants vs economics) ALL PASS; spike40/41 metrics reproduce; spike43 audits both control-arm corpora end-to-end.
- Official-config alignment harness (drift self-check against the two-layer `cordis.patch.yml`) verified on the alpha dependency tree.

## Default behavior changes (visible even though the host line is compatible)

| Mechanism | v1.1 | v1.2 default | Revert knob |
|---|---|---|---|
| Tombstone floor | grows monotonically | merges ≥8-runs before prune | `tombstoneMergeMinRun: 0` |
| Semantic edges | cites/inject only | + inferred edges | `disableInferredEdges: true` |
| Failed extract copies | original kept verbatim | `[restored]` trailer if ROI≥1 | `hlsMode: 'off'` |
