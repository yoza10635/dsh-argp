/**
 * §9.37 出口闸契约测试（design-2.0；用户裁定 2026-11-13："什么设计都无法接受反复重试
 * 再全量重灌的成本"）。锁四件事：
 *  ①容量算术：anchored 投影 ≥ 声明窗 − 输出预算 − 提前量 ⇒ 请求不发先剪（EG-1/2/4）；
 *  ②确定性纪律：断锚（chars 估）与声明窗未知**永不**驱动（EG-3/5，P6-④"只有确定性
 *    的才可以"+ 宁缺勿错交 400 兜底网）；
 *  ③pre-step 接线：缺省开、过线剪 ⇒ 同 step 浓缩闸顺延（EG-6/6c，防同步双重重铸）；
 *  ④逃生口：ARGP_FACTOR_EGRESS=0 ⇒ egress 不挂、浓缩闸照旧（EG-6b；'0' 是唯一关档，EG-7）。
 *
 * 变异台账（摘除必红，cp 快照回滚）：
 *  M1 摘 anchored 守卫 ⇒ EG-3 红；M2 声明窗未知退默认大窗 ⇒ EG-5 红；
 *  M3 摘 `!egressPruned` ⇒ EG-6 红；M4 摘 egressEnabled 门 ⇒ EG-6b 红；
 *  M5 输出预算忽略 requestMaxTokens ⇒ EG-4 红；M6 摘 options.maxTokens 档 ⇒ EG-8 红；
 *  M7 摘 modelDefaultMaxTokens 探测档 ⇒ EG-9 红；M8 摘浓缩闸二补检 ⇒ EG-12 红；
 *  M9 预算档改 options 优先（非 max）⇒ EG-10 红；M10 摘逃生口互斥 ⇒ EG-11 红；
 *  M11 摘 bind 时的 request/context 回填 ⇒ EG-13 红（冷 resume 闸失明）；
 *  M12 摘 egressGate 的 requestContext() 兜底 ⇒ EG-13b 红。
 *  2026-11-13 R2 修后世界实锤：headless 每轮新进程 resume 时历史 request/context 不在
 *  活事件流里，只靠 session/event 写 WeakMap ⇒ declaredWindow=0 ⇒ 出口闸全程放行
 *  （cand-shadow-fix T13/T18/T2x 4 笔 400 死流）。EG-13/13b 即该病灶的回归锁。
 *  对抗审查（2026-11-13）F1/F2/F5/F6 的修复各配专锁（EG-9/F2 闸二/EG-11/EG-10）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { ArgpGraphEngine } from '../src/argp-graph-engine.ts'
import { resolveEgressEnabled, type FactorEngine } from '../src/factor/engine.ts'

interface EgressInternals {
  factor: FactorEngine | null
  bindSession(session: Session): void
  egressGate(agent: unknown, signal: AbortSignal, incomingTokens: number): Promise<boolean>
  condenseGate(agent: unknown, signal: AbortSignal, incomingTokens: number): Promise<void>
  requestMaxTokens: WeakMap<Session, number>
}

async function bootFactor(): Promise<{ ctx: Context; internals: EgressInternals; factor: FactorEngine }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: 'egress persona' } })
  await ctx.plugin(ArgpGraphEngine, { engine: 'factor', windowTokens: 100, retainTokens: 50, recencyGuard: 0 })
  const internals = ctx.compaction as unknown as EgressInternals
  return { ctx, internals, factor: internals.factor as FactorEngine }
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

/** 会话末尾压一枚带 usage 的 assistant：bindSession 从日志回填 ⇒ measureTokens=anchored，
 *  锚点后无新增事件 ⇒ 投影 = 锚点值（算术可控）。 */
function anchorUsage(session: Session, turn: number, inputTokens: number): void {
  session.append('assistant/message', {
    stream: [], turn, step: 1,
    message: createAssistantMessage({ source: { provider: 'test', model: 'test' }, content: [{ type: 'text', text: 'ok' }] }),
    usage: { inputTokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  } as never, { surfaceOp: 'append' })
}

/** 声明窗权威来源 = 宿主 request/context 事件：落会话日志再按快照回放（合成事件无
 *  log offset，会被投影注册表拒收——同 usage 锚点测试的桥接法）。 */
function bridgeDeclaredWindow(ctx: Context, session: Session, contextWindow: number): void {
  session.append('request/context', { contextWindow } as never)
  const evs = session.snapshotEvents()
  ;(ctx as unknown as { emit: (n: string, ...a: unknown[]) => void }).emit('session/event', session, evs[evs.length - 1])
}

function makeAgent(session: Session, options: { maxTokens?: number; provider?: string; model?: string } = {}): {
  session: Session; steer: (msg: unknown) => unknown; options: { maxTokens?: number; provider?: string; model?: string }
} {
  return { session, steer: () => undefined, options }
}

function spyCompact(factor: FactorEngine): { targets: number[] } {
  const orig = factor.compactIfNeeded.bind(factor)
  const targets: number[] = []
  ;(factor as unknown as { compactIfNeeded: (s: Session, t: number) => unknown }).compactIfNeeded =
    (s: Session, t: number) => { targets.push(t); return orig(s, t) }
  return { targets }
}

/** 两枚大 tool 组（可剪面）+ 末尾 usage 锚。 */
function heavyAnchoredSession(id: string, inputTokens: number): Session {
  const session = makeSession(id)
  session.append('user/message', { ...createUserMessage({ content: [{ type: 'text', text: '开始任务' }], source: { kind: 'user' } }), turn: 1 } as never, { surfaceOp: 'append' })
  appendGroup(session, 1, 'c1', '{"file_path":"C:/Proj/a.ts"}', 'OLD CONTENT'.repeat(200))
  appendGroup(session, 2, 'c2', '{"file_path":"C:/Proj/b.ts"}', 'NEW CONTENT'.repeat(200))
  anchorUsage(session, 3, inputTokens)
  return session
}

function emitPreStep(ctx: Context, agent: unknown, messages: unknown[] = []): Promise<unknown> {
  return agentEvents(ctx, agent as Agent).waterfall(
    'agent/pre-step',
    { agent, messages, turn: 9, step: 1, signal: new AbortController().signal } as never,
    (() => Promise.resolve(undefined)) as never,
  )
}

const sig = (): AbortSignal => new AbortController().signal

// 缺省线（声明窗 1000）：outputBudget=floor(1000×0.25)=250，margin=round(1000×0.02)=20 ⇒ line=730。

test('EG-1 anchored 投影过线 ⇒ 请求不发先剪：compactIfNeeded 进且返回 true', async () => {
  const { ctx, internals, factor } = await bootFactor()
  const session = heavyAnchoredSession('eg-fire', 900) // 900 ≥ 780
  internals.bindSession(session)
  bridgeDeclaredWindow(ctx, session, 1000)
  const spy = spyCompact(factor)
  const fired = await internals.egressGate(makeAgent(session), sig(), 0)
  assert.equal(fired, true, '过线必须发剪事务（true=同 step 浓缩闸顺延）')
  assert.equal(spy.targets.length, 1, '恰发一笔 0-LLM 压剪')
  assert.ok(spy.targets[0] > 0, 'target = deficit 字符下界（正数）')
})

test('EG-2 投影在线下 ⇒ 静默放行（不剪不记账）', async () => {
  const { ctx, internals, factor } = await bootFactor()
  const session = heavyAnchoredSession('eg-below', 100) // 100 < 780
  internals.bindSession(session)
  bridgeDeclaredWindow(ctx, session, 1000)
  const spy = spyCompact(factor)
  const fired = await internals.egressGate(makeAgent(session), sig(), 0)
  assert.equal(fired, false)
  assert.deepEqual(spy.targets, [], '线下绝不进 compactIfNeeded（常态轮零开销）')
})

test('EG-3 断锚（chars 估）永不驱动——确定性纪律（M1 锁）', async () => {
  const { ctx, internals, factor } = await bootFactor()
  // 无任何 usage 事件 ⇒ measureTokens 退 chars 口径；内容体量足以越过线（估算口径
  // ≈4400/3.5≈1250 ≥ 780）——若 anchored 守卫被摘，本测必红。
  const bare = makeSession('eg-unanchored')
  bare.append('user/message', { ...createUserMessage({ content: [{ type: 'text', text: '开始任务' }], source: { kind: 'user' } }), turn: 1 } as never, { surfaceOp: 'append' })
  appendGroup(bare, 1, 'c1', '{}', 'OLD CONTENT'.repeat(200))
  appendGroup(bare, 2, 'c2', '{}', 'NEW CONTENT'.repeat(200))
  internals.bindSession(bare)
  bridgeDeclaredWindow(ctx, bare, 1000)
  const spy = spyCompact(factor)
  const fired = await internals.egressGate(makeAgent(bare), sig(), 0)
  assert.equal(fired, false, '断锚禁驱动破坏性改写（P6-④ 纪律原样保留），交 400 兜底网')
  assert.deepEqual(spy.targets, [], '断锚即使 chars 估算远超线也不进')
})

test('EG-4 输出预算=观测 request maxTokens：线随预算下移（M5 锁）', async () => {
  const { ctx, internals, factor } = await bootFactor()
  const session = heavyAnchoredSession('eg-budget', 700) // ∈ [680, 730)
  internals.bindSession(session)
  bridgeDeclaredWindow(ctx, session, 1000)
  const spy = spyCompact(factor)
  assert.equal(await internals.egressGate(makeAgent(session), sig(), 0), false, '未观测 maxTokens ⇒ 预算=25%×窗 ⇒ line=730 ⇒ 700 不过线')
  internals.requestMaxTokens.set(session, 300) // 观测到大输出预算 ⇒ line=1000−300−20=680
  const fired = await internals.egressGate(makeAgent(session), sig(), 0)
  assert.equal(fired, true, '输出预算必须吃真实观测值（R2: mct=65536 > 缺省档会晚压贴墙）')
  assert.ok(spy.targets.length >= 1)
})

test('EG-8 输出预算优先吃 agent.options.maxTokens（新进程首轮唯一可得档，M6 锁）', async () => {
  const { ctx, internals, factor } = await bootFactor()
  const session = heavyAnchoredSession('eg-options', 700)
  internals.bindSession(session)
  bridgeDeclaredWindow(ctx, session, 1000)
  // headless 每轮新进程：requestMaxTokens（WeakMap）冷启为空，只有 options 声明档拿得到 maxTokens。
  const spy = spyCompact(factor)
  const fired = await internals.egressGate(makeAgent(session, { maxTokens: 300 }), sig(), 0)
  assert.equal(fired, true, 'options.maxTokens=300 ⇒ line=680 ⇒ 700 过线（WeakMap 空也认声明档）')
  assert.ok(spy.targets.length >= 1)
})

test('EG-9 输出预算档③=模型注册面 defaultMaxTokens（M7 锁：llm 在瀑布后注入，观测档失明）', async () => {
  const { ctx, internals, factor } = await bootFactor()
  ;(ctx.get('llm') as unknown as { resolveModelInfo?: (p: string, m: string, s: AbortSignal) => Promise<{ defaultMaxTokens: number }> }).resolveModelInfo =
    async () => ({ defaultMaxTokens: 300 })
  const session = heavyAnchoredSession('eg-probe', 700) // 探测缺位 ⇒ line=730 不过线；探得 300 ⇒ line=680 过线
  internals.bindSession(session)
  bridgeDeclaredWindow(ctx, session, 1000)
  const spy = spyCompact(factor)
  const fired = await internals.egressGate(makeAgent(session, { provider: 'test', model: 'test' }), sig(), 0)
  assert.equal(fired, true, '注册面声明的缺省输出预算必须入账（R2 型端点：请求不带 mct，观测档永远空）')
  assert.ok(spy.targets.length >= 1)
})

test('EG-10 输出预算跨源取 max：mid-session 调大 mct 不得欠火（F6 锁）', async () => {
  const { ctx, internals, factor } = await bootFactor()
  const session = heavyAnchoredSession('eg-max', 700)
  internals.bindSession(session)
  bridgeDeclaredWindow(ctx, session, 1000)
  internals.requestMaxTokens.set(session, 300) // 观测档 300 > options 档 200
  const spy = spyCompact(factor)
  const fired = await internals.egressGate(makeAgent(session, { maxTokens: 200 }), sig(), 0)
  assert.equal(fired, true, 'options 优先 ⇒ line=780 欠火；取 max(200,300)=300 ⇒ line=680 ⇒ 过线')
  assert.ok(spy.targets.length >= 1)
})

test('EG-11 PRESSURE 逃生口与出口闸互斥：hatch 世界 egress 不挂（F5 锁）', async () => {
  const savedP = process.env['ARGP_FACTOR_PRESSURE']
  const savedE = process.env['ARGP_FACTOR_EGRESS']
  process.env['ARGP_FACTOR_PRESSURE'] = '1'
  try {
    const { ctx, internals } = await bootFactor()
    const session = heavyAnchoredSession('eg-hatch', 900)
    const calls: string[] = []
    internals.egressGate = async () => { calls.push('egress'); return true }
    internals.condenseGate = async () => { calls.push('condense') }
    ;(internals as unknown as { factorPressure(agent: unknown, incoming?: number): Promise<void> }).factorPressure =
      async () => { calls.push('pressure') }
    await emitPreStep(ctx, makeAgent(session))
    assert.deepEqual(calls, ['pressure', 'condense'], 'hatch=旧世界字节级复现：egress 零触达（两 env 各管各的对照世界）')
  } finally {
    if (savedP === undefined) delete process.env['ARGP_FACTOR_PRESSURE']
    else process.env['ARGP_FACTOR_PRESSURE'] = savedP
    if (savedE === undefined) delete process.env['ARGP_FACTOR_EGRESS']
    else process.env['ARGP_FACTOR_EGRESS'] = savedE
  }
})

// EG-12/12b：egress 驱进的 'pressure' 事务里，§9.36 闸二（ctx ≥ 0.8×声明窗）补检——
// 线（≈0.73×W）与闸二线（0.8×W）之间的带只准确定性剪、不准 LLM 浓缩自动触达（F2）。
// 本组用无显式窗的引擎（windowTokens=0.8×声明窗）+ prose 桩（真 LLM 不挂）。
async function bootFactorScaled(): Promise<{ ctx: Context; internals: EgressInternals & { prose: unknown }; factor: FactorEngine }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: 'egress persona' } })
  await ctx.plugin(ArgpGraphEngine, { engine: 'factor', recencyGuard: 0 })
  const internals = ctx.compaction as unknown as EgressInternals & { prose: unknown }
  return { ctx, internals, factor: internals.factor as FactorEngine }
}

function stubProse(internals: { prose: unknown }): { calls: number } {
  const box = { calls: 0 }
  internals.prose = { condense: async () => { box.calls++; return null } }
  return box
}

test('EG-12 [线, 0.8×窗) 带：剪照常、LLM 浓缩不发（M8 锁）', async () => {
  const { ctx, internals, factor } = await bootFactorScaled() // windowTokens=800=0.8×1000
  const session = heavyAnchoredSession('eg-gate2', 760) // line=730 ≤ 760 < 800
  internals.bindSession(session)
  bridgeDeclaredWindow(ctx, session, 1000)
  const prose = stubProse(internals)
  const spy = spyCompact(factor)
  const fired = await internals.egressGate(makeAgent(session), sig(), 0)
  assert.equal(fired, true, '确定性 R 剪照常发（pruned 非空）')
  assert.equal(prose.calls, 0, '闸二契约"由调用点保证"——egress 调用点自补检，0.73~0.8 带不触达 LLM')
  assert.ok(spy.targets.length >= 1)
})

test('EG-12b 越过 0.8×窗：浓缩照旧跟发（闸二不是禁浓缩，是准入门）', async () => {
  const { ctx, internals, factor } = await bootFactorScaled()
  const session = heavyAnchoredSession('eg-gate2b', 900) // ≥ 800
  internals.bindSession(session)
  bridgeDeclaredWindow(ctx, session, 1000)
  const prose = stubProse(internals)
  const spy = spyCompact(factor)
  const fired = await internals.egressGate(makeAgent(session), sig(), 0)
  assert.equal(fired, true)
  assert.equal(prose.calls, 1, '事务内浓缩通路保留：≥0.8×窗 与 overflow 一样准入（§9.36 语义原样）')
  assert.ok(spy.targets.length >= 1)
})

test('EG-5 声明窗未知 ⇒ 宁缺勿错不驱动（M2 锁）', async () => {
  const { internals, factor } = await bootFactor()
  const session = heavyAnchoredSession('eg-nowindow', 5000) // 若退默认大窗必过线
  internals.bindSession(session) // 不桥 request/context ⇒ WeakMap 无值
  const spy = spyCompact(factor)
  const fired = await internals.egressGate(makeAgent(session), sig(), 0)
  assert.equal(fired, false, '声明窗未知绝不猜口径——照发由 400 overflow 链接管')
  assert.deepEqual(spy.targets, [])
})

test('EG-6 pre-step 接线：egress 发剪 ⇒ 同 step 浓缩闸顺延（M3 锁）', async () => {
  const { ctx, internals } = await bootFactor()
  const session = heavyAnchoredSession('eg-skip', 900)
  const calls: string[] = []
  internals.egressGate = async () => { calls.push('egress'); return true }
  internals.condenseGate = async () => { calls.push('condense') }
  await emitPreStep(ctx, makeAgent(session))
  assert.deepEqual(calls, ['egress'], '发剪事务的 step 不再叠浓缩（同 step 只吃一次前缀重铸）')
})

test('EG-6c pre-step 接线：egress 未发剪 ⇒ 浓缩闸照旧执行', async () => {
  const { ctx, internals } = await bootFactor()
  const session = heavyAnchoredSession('eg-noskip', 100)
  const calls: string[] = []
  internals.egressGate = async () => { calls.push('egress'); return false }
  internals.condenseGate = async () => { calls.push('condense') }
  await emitPreStep(ctx, makeAgent(session))
  assert.deepEqual(calls, ['egress', 'condense'], '未发剪不吞浓缩闸（§9.36 通道原样）')
})

test('EG-6b 逃生口 ARGP_FACTOR_EGRESS=0 ⇒ egress 不挂、浓缩闸照旧（M4 锁）', async () => {
  const saved = process.env['ARGP_FACTOR_EGRESS']
  process.env['ARGP_FACTOR_EGRESS'] = '0'
  try {
    const { ctx, internals } = await bootFactor()
    const session = heavyAnchoredSession('eg-off', 900)
    const calls: string[] = []
    internals.egressGate = async () => { calls.push('egress'); return true }
    internals.condenseGate = async () => { calls.push('condense') }
    await emitPreStep(ctx, makeAgent(session))
    assert.deepEqual(calls, ['condense'], '关档=修前字节世界（对照臂可达；egress 零触达）')
  } finally {
    if (saved === undefined) delete process.env['ARGP_FACTOR_EGRESS']
    else process.env['ARGP_FACTOR_EGRESS'] = saved
  }
})

test('EG-7 resolveEgressEnabled：缺省开，唯一关档=字面 0', () => {
  assert.equal(resolveEgressEnabled({}), true)
  assert.equal(resolveEgressEnabled({ ARGP_FACTOR_EGRESS: '0' }), false)
  assert.equal(resolveEgressEnabled({ ARGP_FACTOR_EGRESS: 'false' }), true, '档位语义同 resolveClipEnabled：只认 0')
  assert.equal(resolveEgressEnabled({ ARGP_FACTOR_EGRESS: '1' }), true)
})

// EG-13/13b：冷 resume（2026-11-13 R2 实锤）——headless 每轮新进程 resume 时，历史
// request/context 不在活事件流里；出口闸必须在 bind 时从日志回填，否则 declaredWindow=0
// 直接放行（cand-shadow-fix T13/T18/T2x 400 死流根因）。13b 锁 requestContext() 第二道兜底。
test('EG-13 冷 resume：历史 request/context 在 bind 时回填 ⇒ 闸照常过线（M11 锁）', async () => {
  const { internals, factor } = await bootFactor()
  const session = heavyAnchoredSession('eg-cold-resume', 900) // 900 ≥ 730
  session.append('request/context', { contextWindow: 1000 } as never) // 只落日志，不回放活事件
  // 关掉宿主 requestContext() 兜底面：本测只准 bind 的日志回填救场（M11 隔离）。
  Object.defineProperty(session, 'requestContext', { value: () => undefined, configurable: true })
  internals.bindSession(session) // 模拟新进程首绑（无 live session/event）
  const spy = spyCompact(factor)
  const fired = await internals.egressGate(makeAgent(session), sig(), 0)
  assert.equal(fired, true, '冷 resume 必须从日志回填声明窗，不得让出口闸失明')
  assert.equal(spy.targets.length, 1)
})

test('EG-13b 日志无 request/context 时走 requestContext() 兜底（M12 锁）', async () => {
  const { internals, factor } = await bootFactor()
  const session = heavyAnchoredSession('eg-request-context', 900)
  Object.defineProperty(session, 'requestContext', { value: () => ({ contextWindow: 1000 }), configurable: true })
  internals.bindSession(session)
  const spy = spyCompact(factor)
  const fired = await internals.egressGate(makeAgent(session), sig(), 0)
  assert.equal(fired, true, '宿主 requestContext() 是权威声明面，日志缺失时也不得放行')
  assert.equal(spy.targets.length, 1)
})
