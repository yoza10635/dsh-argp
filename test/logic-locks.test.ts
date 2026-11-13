/**
 * 2.0 factor-only 逻辑回归锁（2026-11-13 整体审查的 P0/P1 修复）：
 *   L1 召回计数 per-turn 归零（否则 20 次后整会话永久闸）；
 *   L2 被剪账本按会话分桶（否则跨会话 seq 串台）；
 *   L3 焦点重绑不重放账目（rebuiltCompactionIds 不得清）；
 *   L4 事务后锚点不被日志里的旧 usage 复活（焦点切回不得重剪）；
 *   L5 measureTokens 计入锚点事件本身（assistant 消息属于下一请求）；
 *   L6 skipPresets 在 pre-step 三通道之前生效（minimal 下不得改写 surface）。
 *
 * 变异台账（摘修复必须变红，已逐条 cp 快照验证）：
 *   LL1 删 turn/start 归零分支 ⇒ L1 红；
 *   LL2 账本改回进程单例 `ledger` ⇒ L2 红；
 *   LL3 bindSession 恢复 clear() ⇒ L3 红；
 *   LL4 删 restoreUsageAnchor 的"桶已有锚点即早退" ⇒ L4 红；
 *   LL5 budget 的增量比较改回 `>` ⇒ L5 红；
 *   LL6 删 pre-step 的 skipIfPreset 早退 ⇒ L6 红。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { asSeq, asSeqs, scanShadowedSeqs, sessionEvents } from '../src/log-access.ts'
import { createSessionRuntimeState } from '../src/session-state.ts'
import { shadowedSeqsOf } from '../src/recall.ts'
import { ArgpGraphEngine } from '../src/argp-graph-engine.ts'
import type { FactorEngine } from '../src/factor/engine.ts'
import { hasAttachmentBlocks } from '../src/factor/factor-atoms.ts'
import type { SessionRuntimeState } from '../src/session-state.ts'
import { execTool, toolText } from './tool-execute-shape.ts'

interface Internals {
  factor: FactorEngine
  bindSession(session: Session): void
  stateOf(session: Session): SessionRuntimeState
  measureTokens(session: Session, extra?: number): { contextTokens: number; source: string }
  activePresetOf(session: Session): string | null | undefined
  skipIfPreset(session: Session): boolean
}

async function boot(extra: Record<string, unknown> = {}): Promise<{ ctx: Context; internals: Internals }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: 'logic locks persona' } })
  await ctx.plugin(ArgpGraphEngine, { engine: 'factor', windowTokens: 100, retainTokens: 50, ...extra } as never)
  return { ctx, internals: ctx.compaction as unknown as Internals }
}

function appendUser(session: Session, text: string, turn?: number): void {
  session.append('user/message', {
    ...createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
    ...(turn === undefined ? {} : { turn }),
  } as never, { surfaceOp: 'append' })
}

function appendGroup(session: Session, turn: number, callId: string, filePath: string, resultText: string): void {
  session.append('assistant/message', {
    stream: [], turn, step: 1,
    message: createAssistantMessage({
      source: { provider: 'test', model: 'test' },
      content: [{ type: 'text', text: 'doing read' }, { type: 'tool-call', id: callId, name: 'read', arguments: JSON.stringify({ file_path: filePath }) } as never],
    }),
  } as never, { surfaceOp: 'append' })
  session.append('tool/call', { turn, callId, name: 'read', arguments: JSON.stringify({ file_path: filePath }) } as never)
  session.append('tool/result', {
    turn, step: 1,
    message: {
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: resultText }], isError: false }],
      source: { kind: 'tool', callId },
      id: 'm_' + callId,
    },
  } as never, { surfaceOp: 'append' })
}

function makeSession(id: string): Session {
  const session = Session.create(SessionId(id))
  session.append('system/message', { content: 'persona' } as never, { surfaceOp: 'append' })
  return session
}

test('L1 召回安全阀 per-turn：turn/start 归零，21 次后下一轮仍可用', async () => {
  const { ctx, internals } = await boot()
  const session = makeSession('lock-recall-turn')
  internals.bindSession(session)
  appendUser(session, '任务')
  for (let i = 0; i < 20; i += 1) {
    await execTool(ctx, { name: 'recall_history', callId: 'c' + i, agentSession: session, args: { labels: ['document:c:/none.ts'] } })
  }
  const blocked = toolText(await execTool(ctx, { name: 'recall_history', callId: 'c20', agentSession: session, args: { labels: ['document:c:/none.ts'] } }))
  assert.ok(blocked.includes('per-turn call limit'), '20 次内同轮触发安全阀')
  session.append('turn/start', { turn: 2 } as never)
  const next = toolText(await execTool(ctx, { name: 'recall_history', callId: 'c21', agentSession: session, args: { labels: ['document:c:/none.ts'] } }))
  assert.ok(!next.includes('per-turn call limit'), '新轮必须归零（LL1：不归零则整会话永久闸）')
  assert.ok(next.includes('no pruned item matches'), '归零后进入正常查询路径')
})

test('L2 被剪账本按会话隔离：B 会话不得取到 A 的 seq/内容', async () => {
  const { ctx, internals } = await boot()
  const a = makeSession('lock-ledger-a')
  const b = makeSession('lock-ledger-b')
  internals.bindSession(a)
  appendUser(a, '任务 A')
  appendGroup(a, 1, 'a1', 'C:/Proj/a.ts', 'A-ONLY CONTENT '.repeat(30))
  appendGroup(a, 2, 'a2', 'C:/Proj/focus.ts', 'focus')
  assert.ok(internals.factor.compactIfNeeded(a, 1000) !== null, 'A 剪枝发射')
  const hitA = toolText(await execTool(ctx, {
    name: 'recall_history', callId: 'q1', agentSession: a, args: { labels: ['document:c:/proj/a.ts'] },
  }))
  assert.ok(hitA.includes('A-ONLY CONTENT'), 'A 自己能取回')
  // B 有与 A 相同的 seq 布局（同长度历史），但内容不同
  appendUser(b, '任务 B')
  appendGroup(b, 1, 'b1', 'C:/Proj/b.ts', 'B-ONLY CONTENT '.repeat(30))
  appendGroup(b, 2, 'b2', 'C:/Proj/focus.ts', 'focus')
  const missB = toolText(await execTool(ctx, {
    name: 'recall_history', callId: 'q2', agentSession: b, args: { labels: ['document:c:/proj/a.ts'] },
  }))
  assert.ok(missB.includes('no pruned item matches'), 'B 的账本不得含 A 的标签（LL2：单例账本会命中）')
  assert.ok(!missB.includes('B-ONLY CONTENT'), '更不得把 B 的同 seq 事件冒充 A 的原文')
})

test('L3 焦点重绑不重放账目：A→B→A 后 records 不增长', async () => {
  const { internals } = await boot()
  const a = makeSession('lock-rebind-a')
  appendUser(a, 'shadowed one')
  const u = 1
  const startSeq = a.snapshotEvents().length
  a.append('compaction/start', { compactionId: CompactionId('argp-lock-1'), turn: 1 })
  const pruneSeq = a.snapshotEvents().length
  a.append('compaction/prune', {
    shadowedRange: { start: asSeq(u), end: asSeq(u) },
    shadowedSeqs: asSeqs([u]),
    shadowedTokenCount: 5,
  })
  a.append('user/message', createUserMessage({ content: [{ type: 'text', text: '[elided seq=1]' }], source: { kind: 'argp' } }), {
    surfaceOp: { op: 'replace', startSeq: asSeq(u), endSeq: asSeq(u) },
    sourceEventSeqs: asSeqs([pruneSeq, u]),
  })
  a.append('compaction/end', { compactionId: CompactionId('argp-lock-1'), turn: 1 })
  void startSeq
  internals.bindSession(a)
  const n1 = internals.stateOf(a).records.length
  assert.equal(n1, 1, '首绑重建 1 笔')
  const b = makeSession('lock-rebind-b')
  internals.bindSession(b)
  internals.bindSession(a)
  assert.equal(internals.stateOf(a).records.length, 1, '切回 A 不得重复追加（LL3）')
})

test('L4 事务后锚点不被日志旧 usage 复活：焦点切回不重剪', async () => {
  const { internals } = await boot()
  const a = makeSession('lock-anchor-a')
  appendUser(a, '任务')
  a.append('assistant/message', {
    stream: [], turn: 1, step: 1,
    usage: { inputTokens: 200_000, outputTokens: 10 },
    message: createAssistantMessage({ source: { provider: 'test', model: 'test' }, content: [{ type: 'text', text: 'done' }] }),
  } as never, { surfaceOp: 'append' })
  internals.bindSession(a)
  assert.equal(internals.stateOf(a).lastRealPromptTokens, 200_000, '首绑从日志回填真 usage')
  // 模拟压缩事务后的估算锚（prune-tx 写的就是这两行）
  const st = internals.stateOf(a)
  st.lastRealPromptTokens = 40_000
  st.lastRealAnchorSeq = a.seq
  internals.bindSession(makeSession('lock-anchor-b'))
  internals.bindSession(a)
  assert.equal(st.lastRealPromptTokens, 40_000, '内存锚点必须优先（LL4：回填旧 usage 会让出口闸按压缩前规模重剪）')
})

test('L5 measureTokens 计入锚点事件本身（assistant 消息属于下一请求）', async () => {
  const { internals } = await boot()
  const session = makeSession('lock-anchor-message')
  const text = 'x'.repeat(700) // 700 chars / 3.5 = 200 tok
  session.append('assistant/message', {
    stream: [], turn: 1, step: 1,
    usage: { inputTokens: 1000, outputTokens: 10 },
    message: createAssistantMessage({ source: { provider: 'test', model: 'test' }, content: [{ type: 'text', text }] }),
  } as never, { surfaceOp: 'append' })
  internals.bindSession(session)
  const m = internals.measureTokens(session)
  assert.equal(m.source, 'anchored')
  assert.equal(m.contextTokens, 1200, '1000 usage + 锚点 assistant 的 200 tok（LL5：`>` 会漏掉这 200）')
})

test('L6 skipPresets 在 pre-step 三通道前生效：minimal 下 pre-step 不得改写 surface', async () => {
  // 控制组：pressure 逃生口打开（第一通道必进）；无 skip 时它确实会发事务。
  const run = async (skipped: boolean): Promise<number> => {
    const { ctx, internals } = await boot(skipped ? { skipPresets: ['minimal'] } : {})
    const session = makeSession('lock-preset-' + String(skipped))
    internals.bindSession(session)
    appendUser(session, '任务')
    appendGroup(session, 1, 'c1', 'C:/Proj/a.ts', 'OLD '.repeat(200))
    appendGroup(session, 2, 'c2', 'C:/Proj/b.ts', 'focus')
    // 伪造 preset 投影：skip 判定走真实 skipIfPreset/skipPresets 逻辑
    internals.activePresetOf = () => (skipped ? 'minimal' : 'standard')
    // 把逃生口打开，确保"不动作"不是因为缺省通道关闭
    ;(internals as unknown as { pressureTriggerEnabled: boolean }).pressureTriggerEnabled = true
    let calls = 0
    const real = internals.factor.compactIfNeeded.bind(internals.factor)
    internals.factor.compactIfNeeded = (sess: Session, target: number) => { calls += 1; return real(sess, target) }
    const agent = { session, steer: () => undefined, options: {} }
    await agentEvents(ctx, agent as unknown as Agent).waterfall(
      'agent/pre-step',
      { agent, messages: [], turn: 9, step: 1, signal: new AbortController().signal } as never,
      (() => Promise.resolve(undefined)) as never,
    )
    return calls
  }
  assert.equal(await run(false), 1, '控制组：逃生口通道照常发事务')
  assert.equal(await run(true), 0, 'minimal：钩子最先退场，三通道一个都不许动（LL6）')
})

test('L7 附件判据递归：tool-result 嵌套 image/file 也识别（文本+附件混合 R 不得被文本桩吞）', () => {
  assert.equal(hasAttachmentBlocks({ message: { content: [{ type: 'tool-result', content: [{ type: 'text', text: 'ok' }, { type: 'image' }] }] } }), true)
  assert.equal(hasAttachmentBlocks({ message: { content: [{ type: 'tool-result', content: [{ type: 'text', text: 'ok' }] }] } }), false)
  assert.equal(hasAttachmentBlocks({ content: [{ type: 'file' }] }), true)
})

test('L8 手动 compactNow 走 runMaintenance（活跃 turn 不得交错）+ 事务真实落地', async () => {
  const { ctx, internals } = await boot()
  const session = makeSession('lock-manual')
  internals.bindSession(session)
  appendUser(session, '任务')
  appendGroup(session, 1, 'c1', 'C:/Proj/a.ts', 'OLD '.repeat(200))
  appendGroup(session, 2, 'c2', 'C:/Proj/focus.ts', 'focus')
  const before = session.surface.replaceGeneration
  let maintained = 0
  const agent = {
    session,
    options: {},
    runMaintenance: async <T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> => {
      maintained += 1
      return await task(new AbortController().signal)
    },
  }
  const engine = ctx.compaction as unknown as { compactNow(a: unknown, s: AbortSignal): Promise<unknown> }
  const r = await engine.compactNow(agent, new AbortController().signal)
  assert.equal(maintained, 1, 'runMaintenance 必须被调用（宿主 idle 契约）')
  assert.ok(r !== null, '全量剪有可剪面')
  assert.ok(session.surface.replaceGeneration > before, 'surface 已换代')
})

test('L9 error-end 事务的 prune 声称不入 shadowed 账（live 节点不得被谎报已剪）', () => {
  const session = makeSession('lock-error-end')
  appendUser(session, 'LIVE NODE')
  const live = 1
  session.append('compaction/start', { compactionId: CompactionId('argp-lock-err'), turn: 1 })
  session.append('compaction/prune', {
    shadowedRange: { start: asSeq(live), end: asSeq(live) },
    shadowedSeqs: asSeqs([live]),
    shadowedTokenCount: 5,
  })
  session.append('compaction/end', { compactionId: CompactionId('argp-lock-err'), turn: 1, error: 'replace threw' })
  assert.equal(scanShadowedSeqs(session).has(live), false, 'scan：error-end 声称必须丢弃')
  const st = createSessionRuntimeState()
  const got = shadowedSeqsOf({ stateOf: () => st, charsPerToken: 3.5 }, session)
  assert.equal(got.has(live), false, '增量账本同口径')
  // 控制组：成功 end 正常入账
  const ok = makeSession('lock-ok-end')
  appendUser(ok, 'SHADOWED')
  ok.append('compaction/start', { compactionId: CompactionId('argp-lock-ok'), turn: 1 })
  ok.append('compaction/prune', { shadowedRange: { start: asSeq(1), end: asSeq(1) }, shadowedSeqs: asSeqs([1]), shadowedTokenCount: 5 })
  ok.append('compaction/end', { compactionId: CompactionId('argp-lock-ok'), turn: 1 })
  assert.equal(scanShadowedSeqs(ok).has(1), true, '成功事务照常入账')
})
