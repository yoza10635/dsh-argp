/**
 * 1.7.0-beta：compaction/prune 0.1.7 协议核验（设计文档 §2.4，0 代码加测试）。
 *
 * 0.1.7 把 compaction/prune 提升为原生事件（known-event-types 现含 'compaction/prune'，
 * 0.1.6 无）。准入规则（dsh-compaction/invariant 的 validateShadowedSeqs）：shadowedRange
 * 精确命名当前 surface 区间 + shadowedSeqs 列出区间内每个 node；**不要求** ignorable /
 * compaction 事务 / owner 字段。shadow-price 协议（dsh-token-meter foldSurfaceProjection）：
 * prune 的 shadowedRange 必须与紧随其后的 surface replace 范围**严格相等**，否则 resume
 * 重放 throw "no adjacent shadow price"（2026-09-01 实测事故：多区间事务发一个总跨度 claim
 * 再逐区间 replace，第一个 replace 即撞总 claim）。
 *
 * 本文件用真实 ArgpGraphEngine 触发真实 prune（走 prune-tx.ts 发射路径，非手工复刻），核验：
 *   ① 准入：每个 compaction/prune 满足 validateShadowedSeqs 四条判据（无 ignorable）；
 *   ② shadow-price resume：全事件流经 foldSurfaceProjection 重放无 throw，且每个 prune 的
 *      shadowedRange 与紧随 replace 范围严格相等。
 *   ③ 受保护头（node 0 = system/message）永不进剪枝区间——已由 argp-graph-engine.test.ts
 *      「system prompt at surface node 0 is never selected for pruning」守护，此处不重复。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createAssistantMessage, createSystemMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ArgpGraphEngine } from '../src/argp-graph-engine.ts'
// 0.1.7 宿主 shadow-price fold：内部函数（主入口仅导出 TokenMeter），经相对路径直引构建产物。
import { foldSurfaceProjection as _foldSurfaceProjection } from '../node_modules/@deepseek-ai/dsh-token-meter/lib/types/surface-projection.js'

/** 宽松 claim 类型：规避宿主 branded SessionSeq（运行时即 number）。 */
type LooseClaim = { start: number; end: number; tokens: number } | undefined
const foldSurfaceProjection = _foldSurfaceProjection as unknown as (
  claim: LooseClaim,
  event: { type: string; data?: unknown; seq?: number; surfaceOp?: unknown },
) => { deltaTokens: number; claim: LooseClaim }

async function makeEngine(): Promise<{ ctx: Context; engine: ArgpGraphEngine }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: 'argp 017-protocol test persona' } })
  await ctx.plugin(ArgpGraphEngine, { windowTokens: 100, retainTokens: 50, minSpanChars: 20, recencyGuard: 0, maxPasses: 16 })
  return { ctx, engine: ctx.compaction as ArgpGraphEngine }
}

function appendSystem(session: Session, text: string): void {
  session.append('system/message', { turn: 0, step: 0, message: createSystemMessage(text) }, { surfaceOp: 'append' })
}
function appendUser(session: Session, text: string): void {
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
}
function appendAssistant(session: Session, text: string, turn: number): void {
  session.append('assistant/message', { stream: [], turn, step: 1, message: createAssistantMessage({ source: { provider: 'test', model: 'test' }, content: [{ type: 'text', text }] }) }, { surfaceOp: 'append' })
}

/** 建一个带 system 头、会被真实剪枝的会话，触发 prune；返回 pre-prune surface（= prune 时刻 surface，因 prune 是 off-surface）。 */
async function buildPrunedSession(id: string): Promise<{ ctx: Context; engine: ArgpGraphEngine; session: Session; prePruneSurface: number[] }> {
  const { ctx, engine } = await makeEngine()
  const session = Session.create(SessionId(id))
  appendSystem(session, 'you are a deterministic 0.1.7 protocol test agent')
  appendUser(session, 'user anchor')
  appendAssistant(session, 'A1:' + 'x'.repeat(300), 1)
  appendAssistant(session, 'A2:' + 'y'.repeat(300), 2)
  appendAssistant(session, 'A3:' + 'z'.repeat(300), 3)
  engine.setSession(session)
  const prePruneSurface = [...session.surface.nodes]
  const result = await engine.compactIfNeeded({ session } as never, 'pressure', new AbortController().signal)
  assert.ok(result !== null, 'must have pruned at least one interval')
  return { ctx, engine, session, prePruneSurface }
}

/** 重放全部事件流经 0.1.7 shadow-price fold；claim 状态机与宿主 resume 同构。任一 replace 撞错范围 claim 即 throw。 */
function replayShadowPrice(session: Session): void {
  let claim: LooseClaim = undefined
  for (const event of session.snapshotEvents()) {
    const folded = foldSurfaceProjection(claim, event)
    claim = folded.claim
  }
}

test('0.1.7 准入：dsh-argp 的 compaction/prune 满足 validateShadowedSeqs（无 ignorable）', async () => {
  const { ctx, session, prePruneSurface } = await buildPrunedSession('prune-017-admission')
  try {
    const events = [...session.snapshotEvents()]
    const pruneEvents = events.filter(e => e.type === 'compaction/prune')
    assert.ok(pruneEvents.length > 0, 'prune must emit at least one compaction/prune')
    for (const prune of pruneEvents) {
      const data = prune.data as { shadowedRange: { start: number; end: number }; shadowedSeqs: number[]; ignorable?: unknown }
      // 判据 1：shadowedSeqs 非空
      assert.ok(data.shadowedSeqs.length > 0, 'shadowedSeqs must be non-empty')
      // 判据 2：shadowedRange 首尾 = shadowedSeqs 首尾
      assert.equal(data.shadowedRange.start, data.shadowedSeqs[0], 'shadowedRange.start === shadowedSeqs[0]')
      assert.equal(data.shadowedRange.end, data.shadowedSeqs[data.shadowedSeqs.length - 1], 'shadowedRange.end === shadowedSeqs.at(-1)')
      // 判据 3：shadowedRange 命名当前（pre-prune）surface 区间（start/end 在 surface 中，end 不早于 start）
      const startIndex = prePruneSurface.indexOf(data.shadowedRange.start)
      const endIndex = prePruneSurface.indexOf(data.shadowedRange.end)
      assert.ok(startIndex >= 0, 'shadowedRange.start must name a current surface node')
      assert.ok(endIndex >= startIndex, 'shadowedRange.end must be at/after start in the surface')
      // 判据 4：shadowedSeqs 精确列出区间内每个 node（= surface[startIndex..endIndex]）
      assert.deepEqual(data.shadowedSeqs, prePruneSurface.slice(startIndex, endIndex + 1), 'shadowedSeqs must list every node in the current surface span')
      // 无 ignorable 字段（0.1.7 准入不要求；dsh-argp 也不发）
      assert.equal(data.ignorable, undefined, 'no ignorable field (0.1.7 admission does not require it)')
    }
  } finally {
    await ctx.fiber.dispose()
  }
})

test('0.1.7 shadow-price resume：全事件流经 foldSurfaceProjection 无 "no adjacent shadow price"', async () => {
  const { ctx, session } = await buildPrunedSession('prune-017-resume')
  try {
    // 重放不应 throw；若任一 replace 的 armed claim 范围不符，foldSurfaceProjection 会 throw
    replayShadowPrice(session)
    // 显式断言：每个 compaction/prune 的 shadowedRange 与紧随的 replace 范围严格相等
    const events = [...session.snapshotEvents()]
    for (let i = 0; i < events.length; i += 1) {
      const e = events[i]
      if (e.type !== 'compaction/prune') continue
      const next = events[i + 1]
      assert.ok(next !== undefined, 'prune must be followed by an event')
      const nextOp = (next as { surfaceOp?: { op?: string; startSeq?: number; endSeq?: number } }).surfaceOp
      assert.ok(nextOp !== undefined && nextOp.op === 'replace', 'prune must be immediately followed by a surface replace')
      const range = (e.data as { shadowedRange: { start: number; end: number } }).shadowedRange
      assert.equal(nextOp.startSeq, range.start, 'replace.startSeq === prune.shadowedRange.start')
      assert.equal(nextOp.endSeq, range.end, 'replace.endSeq === prune.shadowedRange.end')
    }
  } finally {
    await ctx.fiber.dispose()
  }
})
