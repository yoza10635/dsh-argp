/**
 * factorPressure 钩子链契约测试（design-2.0 §5.3 T-1 欠账清偿；P6-④ 触发收敛后本组测试锁的是
 * ARGP_FACTOR_PRESSURE=1 逃生口的旧世界接线——缺省路径零估算驱动，见文件尾两测）。pre-step 压力剪的
 * 链级锁——组件级（factor-engine/factor-vocab/factor-dispatch）各自绿过，但
 * "吞错隔离→deficit 门槛→UA 兜底"的**接线序**从未被整链断言过）。
 *
 * 变异纪律（每条摘除必须变红）：
 *  - deficit≤0 门槛摘除 ⇒ 无压力也调 compactIfNeeded（测1）；
 *  - 词表 note 吞错隔离摘除 ⇒ steer 抛错连带掐死压力剪（测2）。
 *  （UA 兜底三锁随 factor-ua 退役一并删除——该通路已不存在，缺口兜底语义由
 *   prose-condenser 承担，见 test/prose-condenser.test.ts。）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { ArgpEngine } from '../src/argp-engine.ts'
import type { FactorEngine } from '../src/factor/engine.ts'

interface EngineInternals {
  factor: FactorEngine | null
  factorPressure(agent: unknown, incomingTokens?: number): Promise<void>
  bindSession(session: Session): void
}

async function bootFactor(): Promise<{ ctx: Context; engine: ArgpEngine; internals: EngineInternals; factor: FactorEngine }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: 'pressure hook persona' } })
  await ctx.plugin(ArgpEngine, { engine: 'factor', windowTokens: 100, retainTokens: 50, recencyGuard: 0 })
  const engine = ctx.compaction as ArgpEngine
  const internals = engine as unknown as EngineInternals
  return { ctx, engine, internals, factor: internals.factor as FactorEngine }
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

test('R 剪不动（pruned=null）⇒ 无摘要兜底即本轮终态（factor-ua 退役）', async () => {
  // 可剪面占满（只剩焦点轮 R，协议未闭合被硬保）→ compactIfNeeded 返回 null：
  // 退役后没有 UA 兜底，factorPressure 必须平静返回，且不发射第二笔。
  const { internals, factor } = await bootFactor()
  const session = makeSession('no-fallback')
  internals.bindSession(session)
  session.append('user/message', { ...createUserMessage({ content: [{ type: 'text', text: '只看这个文件' }], source: { kind: 'user' } }), turn: 1 } as never, { surfaceOp: 'append' })
  appendGroup(session, 2, 'c1', '{"file_path":"C:/Proj/a.ts"}', '') // 空结果=attachment 硬保 ⇒ 可剪面占满
  const spy = spyCompact(factor)
  await internals.factorPressure(makeAgent(session), 20000) // incoming 拉满 deficit；不得 reject
  assert.ok((spy.targets[0] ?? 0) > 0, 'deficit>0 必须进一次压力剪')
  assert.equal(spy.targets.length, 1, '剪不动即终态：无兜底第二笔（factor-ua 已退役）')
  spy.restore()
})

// ---------------------------------------------------------------------------
// P6-④ 触发收敛（2026-11-11 裁定）：缺省 pre-step 零估算驱动；env 逃生口恢复旧世界。
//  变异台账：TC1 缺省门控摘除（pressureTriggerEnabled 恒 true）⇒ TC-A 红；
//  TC2 逃生口摘除（env 置 1 也不进 factorPressure）⇒ TC-B 红。
// ---------------------------------------------------------------------------

function emitPreStep(ctx: Context, agent: unknown, messages: unknown[] = []): Promise<unknown> {
  return agentEvents(ctx, agent as Agent).waterfall(
    'agent/pre-step',
    { agent, messages, turn: 9, step: 1, signal: new AbortController().signal } as never,
    (() => Promise.resolve(undefined)) as never,
  )
}

test('TC-A 缺省触发收敛：pre-step 巨额 deficit 也不进 compactIfNeeded（TC1 锁）', async () => {
  const { ctx, internals, factor } = await bootFactor()
  const session = heavySession('tc-default')
  internals.bindSession(session)
  const spy = spyCompact(factor)
  try {
    await emitPreStep(ctx, makeAgent(session))
    assert.deepEqual(spy.targets, [], '★缺省 pre-step 零估算驱动（只认手动 compact + context 报错两信号）')
  } finally {
    spy.restore()
  }
})

test('TC-B env 逃生口：ARGP_FACTOR_PRESSURE=1 恢复旧估算驱动路径（TC2 锁）', async () => {
  const saved = process.env['ARGP_FACTOR_PRESSURE']
  process.env['ARGP_FACTOR_PRESSURE'] = '1'
  try {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: 'pressure hook persona' } })
    await ctx.plugin(ArgpEngine, { engine: 'factor', windowTokens: 100, retainTokens: 50, recencyGuard: 0 })
    const internals = ctx.compaction as unknown as EngineInternals & { factor: FactorEngine | null }
    const factor = internals.factor as FactorEngine
    const session = heavySession('tc-hatch')
    internals.bindSession(session)
    const spy = spyCompact(factor)
    try {
      await emitPreStep(ctx, makeAgent(session))
      assert.ok(spy.targets.length >= 1, '★逃生口路径旧世界照旧（pre-step 估算驱动压力剪接线通）')
      assert.ok((spy.targets[0] ?? 0) > 0, 'target = deficit 字符下界（正数）')
    } finally {
      spy.restore()
    }
  } finally {
    if (saved === undefined) delete process.env['ARGP_FACTOR_PRESSURE']
    else process.env['ARGP_FACTOR_PRESSURE'] = saved
  }
})

test('逃生口估算冻结在 1.x 朴素密度（ADV-1：legacyPlain 接线锁）', async () => {
  const { internals, factor } = await bootFactor()
  const session = makeSession('pressure-legacy-pin')
  internals.bindSession(session)
  const cjk = '压缩召回测试内容段落'.repeat(400) // 纯 CJK 大 surface：加权口径必高于朴素口径
  session.append('user/message', {
    ...createUserMessage({ content: [{ type: 'text', text: cjk }], source: { kind: 'user' } }), turn: 1,
  } as never, { surfaceOp: 'append' })
  const mt = internals as unknown as {
    measureTokens(s: Session, e?: number, l?: boolean): { contextTokens: number; surfaceTokens: number }
    resolveScaledBudgets(a: unknown): Promise<{ retainTokens: number; declaredKnown: boolean }>
  }
  const weighted = mt.measureTokens(session, 0, false)
  const legacy = mt.measureTokens(session, 0, true)
  assert.ok(weighted.surfaceTokens > legacy.surfaceTokens, '前置：CJK surface 加权>朴素（否则夹具失效）')
  assert.ok(Math.abs(legacy.surfaceTokens - Math.ceil(cjk.length / 3.5)) <= 4, 'legacyPlain≈朴素 ceil(chars/3.5)（surface 另含 system/用户头，小常数容差）')
  const scaled = await mt.resolveScaledBudgets(makeAgent(session))
  assert.ok(scaled.declaredKnown)
  const spy = spyCompact(factor)
  await internals.factorPressure(makeAgent(session), 0)
  spy.restore()
  assert.equal(spy.targets.length, 1, 'CJK 大 surface 必构成一次压力剪')
  const expected = Math.floor((legacy.contextTokens - scaled.retainTokens) * 3.5)
  assert.equal(spy.targets[0], expected, '★target 必须按朴素 deficit 推得（摘 legacyPlain=true 接线⇒加权 deficit≈2× ⇒ 红）')
})
