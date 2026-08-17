# [RFC Draft] Making the compaction seam engine-agnostic

> **Draft** for GitHub Discussion (category: Ideas). Not yet posted.
> Author: ARGP project (a third-party 0-LLM compaction engine for dsh)
> Status: for internal review before posting

---

## Title (candidate)

**[RFC] Making the compaction seam engine-agnostic: three gaps hit by a 0-LLM deterministic pruning engine**

## TL;DR

dsh's contributing docs state that "packages in the official repository are inherently no more important than packages created by the community" and that the design supports deep customization. We are a third-party `CompactionEngine` backend that replaces `compaction-basic` with a **0-LLM, deterministic graph-pruning** compressor (ARGP), and the full pipeline works (mount → prune → recall, all transaction checks pass). But the compaction seam currently encodes an implicit "compaction = LLM summarization" assumption in three places, which forces third-party engines to either hack around or give up. This post reports the three gaps with minimal repro, and asks whether the seam can be made engine-neutral.

## Context

ARGP (Atomic Reference Graph Pruning) is a deterministic context-compaction algorithm: conversation history is decomposed into atoms (user / assistant / tool-result), the agent declares citation edges between atoms each turn, and compaction removes atoms in reverse topological order by pure graph rules — **zero LLM calls in the compression phase**, with a `recall` tool to retrieve pruned content on demand. We mounted it as a full `CompactionEngine` (replacing `compaction-basic`) on dsh `0.1.0-rc.6` and validated it end-to-end (50-turn runs, L1/L2/L3 invariants pass, 7/7 user-anchors retained, 7/7 needles recoverable via recall).

The engine works. What does not fit are three seams that assume a summarizer:

## Gap 1 — tool/result replacement has no structured metadata channel

**Symptom.** A tool/result node replacement is hard-constrained by `assertToolResultRewrite`: only the inner `content` of the tool-result block may change; every other field (including the generated `id`) must deep-equal the original node, and the replacement event must itself remain a `tool/result`. The only compliant placeholder is "clone the original message, keep the id, swap the content".

**Why it matters for us.** A 0-LLM pruner replaces spans with tombstones, but a tombstone has no structured place to carry pruning metadata (reason, graph node references, recall markers). Options today: (a) encode metadata into the placeholder text (fragile parsing), or (b) keep a side index keyed by seq. Both work; both are band-aids that every third-party engine will have to reinvent.

**Minimal repro.** `spike/02-surfaceop.ts` (judgment 3/3n): cloning the original message and swapping content passes; creating a new message (new id) fails with `tool/result surface replacement may change only content`.

**Suggested change (either)**:
1. An optional structured metadata channel on surface replacement events (e.g. `SurfaceIntent.meta` / event-level `meta`), or
2. Permit additional annotation fields on replacement nodes under `assertToolResultRewrite`.

Backward-compatible in both cases; default behavior unchanged.

## Gap 2 — `compaction/prune` is outside the transaction invariant state machine

**Symptom.** dsh-compaction's `invariant.ts` maintains a transaction-bracket state machine only over `compaction/start|summary|end` (open/summarized/owner checks). `compaction/prune` never sets the `summarized` bit; `validateCompactionEvent` returns `undefined` for it — it is a floating event that cannot form a transaction on its own.

**Why it matters for us.** Our pruning is a 0-LLM deterministic *replacement* — semantically an eviction, not a summary. There is no native event type for it, so we are forced to borrow the `compaction/summary` semantics and fill `provider`/`model` with pseudo-values (`'argp'` / `'algorithmic-tombstone'`) to mark algorithmic pruning. Consequences: (a) tombstone placeholder text masquerades as summary content, so accounting (e.g. `shadowedTokenCount`) hangs under a nominal summary; (b) no native way to distinguish "LLM summary" from "algorithmic eviction" per event; (c) if dsh later adds constraints on summary semantics (quality checks, token caps), algorithmic pruning gets caught in the crossfire.

**Minimal repro.** `spike/04-t1.ts` + source inspection of `compaction/src/invariant.ts` (the `summarized` bit is set only by `compaction/summary`).

**Suggested change (either)**:
1. Bring `compaction/prune` into the invariant state machine (independent flag or reuse `summarized`, with its own owner check), so it can form a standalone bracket, or
2. Add a `compaction/tombstone` event type (same shape as summary, but semantically a placeholder eviction, exempt from summary-like constraints).

## Gap 3 — headless test assembly silently kills the Basic engine's pressure path

**Symptom.** With `mountAgentLoopTestDependencies` + `ctx.plugin(BasicCompactionEngine, ...)`, a 50-turn run produced **zero compaction events**; the request grew to 201,633 tokens, hit the 196,608 window 400, and the task aborted at turn 36. No error surfaced anywhere. Root cause (confirmed by source reading): the testkit mounts llm/session/systemPrompt/tools/agent but **not `tokenMeter`**; `BasicCompactionEngine`'s `static inject` includes `tokenMeter`, and the `measure` call throws inside the pre-step hook, where the catch branch only does `ctx.logger.warn` — silently swallowed when the test harness has no logger attached.

**Why it matters for us.** Beyond our baseline-arm comparison being blocked, this is a general hazard for **any** third-party plugin: a missing-dependency assembly fails silently instead of loudly. In tests that wastes GPU-hours; in production it looks like "compaction never happens".

**Minimal repro.** `spike/07-baseline.ts`; output at `spike/out/07-baseline-2026-08-16T07-55-41-633Z/` (wall=5024s, 0 transactions).

**Suggested change (either)**:
1. Register `tokenMeter` in `mountAgentLoopTestDependencies` (or document it as a required prerequisite of the Basic engine), and
2. Upgrade the pre-step catch from a silent `warn` to an observable channel (event, or throw on first error) so silent failure becomes impossible.

## Why this is an extensibility matter, not a native-bug fix

These are not bugs in dsh's own behavior — dsh's summarizer works as designed. They are **assumptions of a single engine shape baked into the seam**: every one of the three is invisible to `compaction-basic` and only shows up for a non-LLM backend. The official philosophy ("community packages are not inherently less important") only holds if third-party engines can integrate without semantic hacks. We're not asking for ARGP-specific features; we're asking whether the seam can be made engine-neutral so that memory engines, streaming engines, or 0-LLM engines can all be first-class citizens.

## Ask

1. Is engine-agnostic compaction on the roadmap, or is `compaction-basic` intended to remain the reference shape?
2. For Gap 1 & 2: which of the suggested options would dsh prefer, and are there plans for a stable event/API surface for third-party compaction engines in the rc series?
3. For Gap 3: would a testkit tokenMeter registration + observable pre-step error channel be acceptable?

Happy to provide full repro materials (offline event-stream replays, minimal sessions) for any of the three.

---

## 中文摘要

本文是第三方 0-LLM 确定性剪枝引擎（ARGP）对 dsh compaction 接缝的三处扩展性缺口的提案（未发布草稿）。核心观点：官方文档宣称"社区包与官方包平等、支持深度定制"，但当前 compaction seam 的三处设计（tool/result 替换的元数据约束、compaction/prune 游离于事务状态机、testkit 装配缺 tokenMeter 且静默吞错）都隐含"压缩 = LLM 摘要"的单一形态假设。这三条对官方自身引擎不可见，只对非 LLM 后端暴露——属于平台可扩展性问题而非原生 bug。目标：让 seam 引擎中立化，使第三方引擎（记忆型/流式/0-LLM）能成为一等公民，无需语义 hack。
