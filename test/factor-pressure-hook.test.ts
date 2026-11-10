/**
 * factorPressure 钩子链契约测试（design-2.0 §5.3 T-1 欠账清偿：pre-step 压力剪的
 * 链级锁——组件级（factor-engine/factor-vocab/factor-dispatch）各自绿过，但
 * "吞错隔离→deficit 门槛→UA 兜底"的**接线序**从未被整链断言过）。
 *
 * 变异纪律（每条摘除必须变红）：
 *  - deficit≤0 门槛摘除 ⇒ 无压力也调 compactIfNeeded（测1）；
 *  - 词表 note 吞错隔离摘除 ⇒ steer 抛错连带掐死压力剪（测2）；
 *  - pruned!==null 早退摘除 ⇒ 剪成功仍烧 UA 摘要（测3 右半）；
 *  - UA 兜底缺失 ⇒ 可剪面占满时无人接手（测3 左半）；
 *  - UA 吞错隔离摘除 ⇒ summarize 抛错炸穿 pre-step（测4）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ArgpGraphEngine } from '../src/argp-graph-engine.ts'
import type { FactorEngine } from '../src/factor/engine.ts'

interface EngineInternals {
  factor: FactorEngine | null
  ua: { summarize(session: Session, options: unknown): Promise<unknown> } | null
  factorPressure(agent: unknown, incomingTokens?: number): Promise<void>
  bindSession(session: Session): void
}

async function bootFactor(): Promise<{ engine: ArgpGraphEngine; internals: EngineInternals; factor: FactorEngine }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: 'pressure hook persona' } })
  await ctx.plugin(ArgpGraphEngine, { engine: 'factor', windowTokens: 100, retainTokens: 50, recencyGuard: 0 })
  const engine = ctx.compaction as ArgpGraphEngine
  const internals = engine as unknown as EngineInternals
  return { engine, internals, factor: internals.factor as FactorEngine }
}

function makeSession(id: string): Session {
  const session = Session.create(SessionId(id))
  session.append('system/message', { content: 'persona' } as never, { surfaceOp: 'append' })
  return session
}

function appendGroup(session: Session, turn: number, callId: string, args: string, resultText: string): void {
  session.append('assistant/message', {
    stream: [], turn, step: 1,
    message: createAssistantMessage({
      source: { provider: 'test', model: 'test' },
      content: [{ type: 'text', text: 'doing read' }, { type: 'tool-call', id: callId, name: 'read', arguments: args } as never],
    }),
  } as never, { surfaceOp: 'append' })
  session.append('tool/call', { turn, callId, name: 'read', arguments: args } as never)
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

/** 最小 agent 形（factorPressure 只消费 session/steer/options）。 */
function makeAgent(session: Session, steer?: (msg: unknown) => unknown): { session: Session; steer: (msg: unknown) => unknown; options: Record<string, never> } {
  return { session, steer: steer ?? (() => undefined), options: {} }
}

/** spy factor.compactIfNeeded（记录 target 并委托原实现）。 */
function spyCompact(factor: FactorEngine): { targets: number[]; restore(): void } {
  const orig = factor.compactIfNeeded.bind(factor)
  const targets: number[] = []
  ;(factor as unknown as { compactIfNeeded: (s: Session, t: number) => unknown }).compactIfNeeded =
    (s: Session, t: number) => { targets.push(t); return orig(s, t) }
  return { targets, restore: () => { (factor as unknown as { compactIfNeeded: unknown }).compactIfNeeded = orig } }
}

function heavySession(id: string): Session {
  const session = makeSession(id)
  session.append('user/message', { ...createUserMessage({ content: [{ type: 'text', text: '开始任务' }], source: { kind: 'user' } }), turn: 1 } as never, { surfaceOp: 'append' })
  appendGroup(session, 1, 'c1', '{"file_path":"C:/Proj/a.ts"}', 'OLD CONTENT'.repeat(200))
  appendGroup(session, 2, 'c2', '{"file_path":"C:/Proj/b.ts"}', 'NEW CONTENT'.repeat(200))
  return session
}

test('deficit≤0 ⇒ compactIfNeeded 根本不进（压力门槛）', async () => {
  const { internals, factor } = await bootFactor()
  const session = makeSession('low-deficit')
  internals.bindSession(session)
  const spy = spyCompact(factor)
  await internals.factorPressure(makeAgent(session), 0)
  assert.deepEqual(spy.targets, [], '小会话（persona-only）不构成 deficit')
  spy.restore()
})

test('deficit>0 ⇒ 按 deficit×charsPerToken 调 compactIfNeeded 并真发射', async () => {
  const { internals, factor } = await bootFactor()
  const session = heavySession('with-deficit')
  internals.bindSession(session)
  const spy = spyCompact(factor)
  await internals.factorPressure(makeAgent(session), 0)
  assert.equal(spy.targets.length, 1, '有压力必须进一次')
  assert.ok(spy.targets[0] > 0, 'target = deficit 字符下界（正数）')
  spy.restore()
})

test('词表 note steer 抛错 ⇒ 吞错隔离，同钩子压力剪照常执行', async () => {
  const { internals, factor } = await bootFactor()
  const session = heavySession('steer-boom')
  internals.bindSession(session)
  // 先剪一笔造出词表脏态（epoch 变 ⇒ refresh 必调 steer）
  factor.compactIfNeeded(session, 1000)
  const spy = spyCompact(factor)
  const boomAgent = makeAgent(session, () => { throw new Error('steer boom') })
  await internals.factorPressure(boomAgent, 0) // 不得 reject
  assert.ok(spy.targets.length >= 1, 'steer 抛错不得掐死压力剪（丢的只是提示）')
  spy.restore()
})

test('R 剪不动（pruned=null）⇒ UA 摘要兜底接手；剪成功 ⇒ UA 不烧', async () => {
  // 兜底半：只剩焦点轮 R（协议未闭合被硬保）→ compactIfNeeded 返回 null → ua.summarize 接手。
  const { internals, factor } = await bootFactor()
  const session = makeSession('ua-fallback')
  internals.bindSession(session)
  session.append('user/message', { ...createUserMessage({ content: [{ type: 'text', text: '只看这个文件' }], source: { kind: 'user' } }), turn: 1 } as never, { surfaceOp: 'append' })
  appendGroup(session, 2, 'c1', '{"file_path":"C:/Proj/a.ts"}', '') // 空结果=attachment 硬保 ⇒ 可剪面占满
  let uaCalls = 0
  internals.ua = { summarize: async () => { uaCalls += 1 } }
  await internals.factorPressure(makeAgent(session), 20000) // incoming 拉满 deficit
  assert.equal(uaCalls, 1, '可剪面占满 ⇒ UA 兜底必须接手')
  // 不烧半：重负载可剪 ⇒ pruned 非 null ⇒ UA 静默。
  const { internals: internals2 } = await bootFactor()
  const heavy = heavySession('ua-silent')
  internals2.bindSession(heavy)
  let ua2 = 0
  internals2.ua = { summarize: async () => { ua2 += 1 } }
  await internals2.factorPressure(makeAgent(heavy), 0)
  assert.equal(ua2, 0, '剪成功不得再烧 UA 摘要')
  void factor
})

test('UA summarize 抛错 ⇒ 吞错隔离不阻断本步', async () => {
  const { internals } = await bootFactor()
  const session = makeSession('ua-boom')
  internals.bindSession(session)
  session.append('user/message', { ...createUserMessage({ content: [{ type: 'text', text: '只看这个文件' }], source: { kind: 'user' } }), turn: 1 } as never, { surfaceOp: 'append' })
  appendGroup(session, 2, 'c1', '{"file_path":"C:/Proj/a.ts"}', '') // attachment 硬保 ⇒ pruned=null 走 UA
  internals.ua = { summarize: async () => { throw new Error('ua boom') } }
  await internals.factorPressure(makeAgent(session), 20000) // 不得 reject
})
