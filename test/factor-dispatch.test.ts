/**
 * engine 判别式分发契约（design-2.0 §3.2 挂载策略）：
 *  - engine='factor' ⇒ compressor/declarer/zoom 三管线不挂 + citesObligation 硬关；
 *  - 缺省 'graph' ⇒ 现役行为逐字不变（三管线缺省即挂）；
 *  - 非法 engine 值构造期 violations 严拒（不静默回退）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ArgpGraphEngine } from '../src/argp-graph-engine.ts'
import { sessionEvents } from '../src/log-access.ts'

function appendUser(session: Session, text: string): void {
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
}

function appendGroup(session: Session, turn: number, callId: string, tool: string, args: string, resultText: string): void {
  session.append('assistant/message', {
    stream: [], turn, step: 1,
    message: createAssistantMessage({
      source: { provider: 'test', model: 'test' },
      content: [{ type: 'text', text: 'doing ' + tool }, { type: 'tool-call', id: callId, name: tool, arguments: args } as never],
    }),
  } as never, { surfaceOp: 'append' })
  session.append('tool/call', { turn, callId, name: tool, arguments: args } as never)
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

interface EngineInternals {
  peratomStack?: { compressor: unknown; declarer: unknown; zoom: unknown } | null
  citesObligation: boolean
  citesObligationAuto: boolean
}

async function boot(config: Record<string, unknown>): Promise<EngineInternals> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: 'dispatch test persona' } })
  await ctx.plugin(ArgpGraphEngine, { windowTokens: 100, retainTokens: 50, ...config })
  return ctx.compaction as unknown as EngineInternals
}

test("engine='factor'：三管线不挂载、citesObligation 硬关", async () => {
  const engine = await boot({ engine: 'factor' })
  assert.ok(!engine.peratomStack, 'compressor/declarer/zoom 缺省全不挂（G7 破产路径封堵）')
  assert.equal(engine.citesObligation, false, 'cites 契约随臂硬关')
  assert.equal(engine.citesObligationAuto, false)
})

test("缺省 engine='graph'：三管线缺省即挂（现役行为逐字不变）", async () => {
  const engine = await boot({})
  assert.ok(engine.peratomStack, 'graph 臂缺省挂载不得因判别式引入而漂移')
  assert.equal(engine.citesObligation, true, 'graph 臂 auto 口径：无 declarer 武装时 obligation 开')
})

test("engine='typo'：构造期 violations 严拒，不静默回退 graph", async () => {
  await assert.rejects(boot({ engine: 'typo' }), (e: unknown) =>
    String(e instanceof Error ? e.message : e).includes('engine'))
})

test("engine='factor'：compactIfNeeded 走因子决策路径（发射 '因子剪' summary，非图剪）", async () => {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: 'dispatch test persona' } })
  await ctx.plugin(ArgpGraphEngine, { engine: 'factor', windowTokens: 100, retainTokens: 50, recencyGuard: 0 })
  const engine = ctx.compaction as ArgpGraphEngine
  const session = Session.create(SessionId('dispatch-e2e'))
  appendUser(session, '开始任务')
  appendGroup(session, 1, 'c1', 'read', '{"file_path":"C:/Proj/a.ts"}', 'OLD CONTENT'.repeat(50))
  appendGroup(session, 2, 'c2', 'read', '{"file_path":"C:/Proj/b.ts"}', 'NEW CONTENT'.repeat(50))
  const result = await engine.compactIfNeeded({ session } as never, 'pressure', new AbortController().signal)
  assert.ok(result !== null, '超 retain 下限必须发射（factor 压力口径）')
  const events = sessionEvents(session) as unknown as Array<{ type: string; data?: Record<string, unknown> }>
  const summary = events.find(e => e.type === 'compaction/summary')
  const text = JSON.stringify(summary?.data ?? {})
  assert.ok(text.includes('因子剪'), 'summary 走 factor 口径')
  assert.ok(!text.includes('图剪'), '不得串用图臂事务')
  assert.ok(text.includes('recall_history'), 'factor summary 引新召回通道（禁引退役工具名）')
})
