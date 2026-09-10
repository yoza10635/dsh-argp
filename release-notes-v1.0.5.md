# dsh-argp 1.0.5

> 粘贴到 GitHub Release（tag: `v1.0.5`，已推送）。标题建议：`v1.0.5 — auto-sanitized presets + WebUI settings card`

## Highlights

### Preset cleaner: end the dual-compaction conflict

Since dsh moved the agent plane behind presets (rc.2), every `standard` / `cordis` / `ptc` session mounted the stock `compaction-basic` summarizer inside an isolated realm — a plane that host-level `disabled: true` in `cordis.patch.yml` cannot reach. The lossy stock summarizer and ARGP's deterministic graph pruning both fired on `agent/pre-step`, racing for the same surface.

dsh-argp now fixes this automatically at engine mount: for every shipped preset still carrying stock compaction, it creates a `<id>-argp` copy through the official authoring API (into `~/.dsh/.agent-presets/`), strips `compaction-basic` and `tool-result-pruner`, and **keeps `command-compact`** — whose `compaction` inject now resolves through the realm chain to the host-plane ARGP engine, so `/compact` routes straight to ARGP's deterministic `compactNow` with zero extra wiring.

- Idempotent, drift-healing, fail-soft; only ever writes to `~/.dsh/.agent-presets/`
- Shipped presets are untouched byte-for-byte (unit-test asserted) — sanitized copies are an addition, not a replacement
- Standing-mount file stamps mean new sessions pick up the sanitized generation without restarting the host
- Disable with `config.presetClean: false`

Verified on first boot: `cordis-argp`, `ptc-argp`, `standard-argp` generated with zero stock compaction rows remaining.

### WebUI settings card

Settings → Plugins → Plugin configuration now includes an ARGP card editing the nine engine knobs (windowRatio, retainRatio, maxPasses, recencyGuard, turnGuard, minSpanChars, enableSummarize, sortMode, charsPerToken) with per-field override badges, reset, and staged save/discard.

### Fixed

- The settings card rendered near-black with unreadable text in the light theme: its inline styles referenced custom properties the host shell never defines (`--bg-elevated`, `--border`, `--bg-input`, …), so every dark-theme fallback literal won. All chrome now uses the host `--dsw-alias-*` theme system (adapts to both themes) with light-theme-safe fallbacks.

## Verified

- `npm run check` all green (209/209, 2026-09-04), including 7 preset-cleaner tests (idempotence, drift healing, source-file invariance, source whitelist).

**Full changelog**: https://github.com/yoza10635/dsh-argp/blob/main/CHANGELOG.md

npm: `npm i dsh-argp@1.0.5`
