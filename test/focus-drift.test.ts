/**
 * 1.11.0-beta.1 评审二批反例集（focus drift / D2 同族 + 1-5 延伸）。
 *
 * 病灶（docs/design-review-v1.11.0-beta.1 D2 + §7）：引擎的 this.rt 是**焦点指针**，
 * 任何 await 窗口内其他会话的 pre-step 都会经 bindSession 把它换装成别人的桶——
 * 恢复后继续跑的同步段（measureTokens 锚点、guardOverride、recall 限额、resolved
 * 预算写入）全部落到错误的桶。每个测试 = 一个"焦点被抢绑"反例 + 精确断言。
 *
 *  1. compactIfNeeded：await resolveScaledBudgets 后必须回绑本会话再测量
 *  2. isPressureExceeded：同上（pre-step 轮内压力判定入口）
 *  3. resolveScaledBudgets：resolvedWindowTokens 必须写入**调用方会话**的桶
 *  4. 召回路由：引擎见过 >1 会话时，exec.agent 缺席的调用拒绝回退（不静默串台）
 *  5. zoom 路由同判据 + zoom detail 预算按会话解析窗口推导（不再锚死 16384）
 *  6. compactIfNeeded signal：进入即取消 → null；await 后取消 → 拒绝且零写点
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId, createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ArgpGraphEngine } from '../src/argp-graph-engine.ts'
import { RecallZoom } from '../src/peratom/recall-zoom.ts'
import { eventText } from '../src/log-access.ts'
import { resolveScaledBudgets } from '../src/budget.ts'
import type { BudgetHost } from '../src/budget.ts'
import { DEFAULT_WINDOW_TOKENS, DEFAULT_WINDOW_RATIO, DEFAULT_RETAIN_TOKENS, DEFAULT_RETAIN_RATIO, DEFAULT_CHARS_PER_TOKEN } from '../src/constants.ts'

const ENGINE_BASE = { windowTokens: 100, retainTokens: 50, reserveTokens: 0, minSpanChars: 20, recencyGuard: 0, turnGuard: 0, maxPasses: 16 }

async function makeEngine(config: Record<string, unknown> = {}): Promise<{ ctx: Context; engine: ArgpGraphEngine }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: 'focus-drift test' } })
  await ctx.plugin(ArgpGraphEngine, { ...ENGINE_BASE, ...config })
  return { ctx, engine: ctx.compaction as ArgpGraphEngine }
}

function fakeAgent(session: Session): never {
  return { session, options: { provider: 'p', model: 'm' } } as never
}

/** user + 大段 assistant（可剪主体）+ 尾部小 assistant。返回 { session, 大段 seq }。 */
function makeSessionWith(id: string, bigChars: number): { session: Session; bigSeq: number } {
  const session = Session.create(SessionId(id))
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'anchor ' + id }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  const before = session.snapshotEvents().length
  session.append('assistant/message', {
    stream: [], turn: 1, step: 1,
    message: createAssistantMessage({ source: { provider: 'test', model: 'test' }, content: [{ type: 'text', text: 'x'.repeat(bigChars) }] }),
  }, { surfaceOp: 'append' })
  session.append('assistant/message', {
    stream: [], turn: 1, step: 1,
    message: createAssistantMessage({ source: { provider: 'test', model: 'test' }, content: [{ type: 'text', text: 'tiny tail' }] }),
  }, { surfaceOp: 'append' })
  return { session, bigSeq: before }
}

function makeSecretSession(id: string, secret: string): { session: Session; secretSeq: number } {
  const session = Session.create(SessionId(id))
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'anchor ' + id }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  const before = session.snapshotEvents().length
  session.append('assistant/message', {
    stream: [], turn: 1, step: 1,
    message: createAssistantMessage({ source: { provider: 'test', model: 'test' }, content: [{ type: 'text', text: 'SECRET-' + secret + ' ' + 'z'.repeat(100) }] }),
  }, { surfaceOp: 'append' })
  return { session, secretSeq: before }
}

function compactionEventCount(session: Session): number {
  return session.snapshotEvents().filter(e => e.type.startsWith('compaction/')).length
}

/** 给焦点会话的桶注入"毒锚点"（低量）：无修复时被抢绑方用它测量会得出"未超阈"。 */
function poisonFocusAnchors(engine: ArgpGraphEngine, anchorSeq: number): void {
  const e = engine as unknown as { lastRealPromptTokens: number; lastRealAnchorSeq: number }
  e.lastRealPromptTokens = 1
  e.lastRealAnchorSeq = anchorSeq
}

// ---------------------------------------------------------------------------
// 1/2. await 窗口焦点抢绑 —— compactIfNeeded / isPressureExceeded 必须回绑
// ---------------------------------------------------------------------------

test('D2: compactIfNeeded 的 await 窗口被 B 抢绑 —— 恢复后回绑 A 再测量（剪枝照常发生）', async () => {
  const { ctx, engine } = await makeEngine()
  try {
    const sa = makeSessionWith('drift-cia', 4000)
    const sb = makeSessionWith('drift-cib', 10)
    engine.setSession(sb.session) // 焦点 B（模拟 B 先活动）
    // 前置：A 的 surface 中 seq 超过 B 锚点的节点必须足够小——毒锚点下测量才必然低于阈值
    const bMax = Math.max(...[...sb.session.surface.nodes])
    const tailChars = [...sa.session.surface.nodes].filter(s => s > bMax).reduce((n, s) => n + eventText(sa.session, s).length, 0)
    assert.ok(tailChars < 200, '测试布局前置：A 超出 B 锚点的尾部必须 <200 字符，实际 ' + tailChars)

    const p = engine.compactIfNeeded(fakeAgent(sa.session), 'pressure', new AbortController().signal)
    // 同步抢绑 B——必然先于 A 的恢复微任务（D2 的 await 窗口）。毒锚点必须落在抢绑
    // **之后**：setSession(sb) 是完整重绑，restoreUsageAnchor 会先清掉 B 桶旧锚点。
    engine.setSession(sb.session)
    poisonFocusAnchors(engine, bMax)
    const result = await p
    // 修复：回绑 A 后锚点失效（无 usage 日志）→ chars 口径 ~1000 tok ≥ 阈值 100 → 正常剪枝。
    // 无修复：读到 B 桶毒锚点 → 1 + 小增量 < 100 → 静默跳过（result null）。
    assert.ok(result !== null, 'A 的压力剪枝不得因 B 抢绑焦点而被毒锚点静默跳过')
    assert.ok(compactionEventCount(sa.session) > 0, 'A 的剪枝事务应真实落盘')
  } finally {
    await ctx.fiber.dispose()
  }
})

test('D2: isPressureExceeded 的 await 窗口被 B 抢绑 —— 回绑 A 后压力判定不读 B 的锚点', async () => {
  const { ctx, engine } = await makeEngine()
  try {
    const sa = makeSessionWith('drift-ipe-a', 4000)
    const sb = makeSessionWith('drift-ipe-b', 10)
    engine.setSession(sb.session)
    poisonFocusAnchors(engine, Math.max(...[...sb.session.surface.nodes]))

    const probe = (engine as unknown as { isPressureExceeded(agent: never, extra?: number): Promise<boolean> })
    const p = probe.isPressureExceeded(fakeAgent(sa.session), 0)
    engine.setSession(sb.session) // await 窗口内抢绑
    assert.equal(await p, true, 'A 的轮内压力判定不得被 B 桶毒锚点误判为未超阈')
  } finally {
    await ctx.fiber.dispose()
  }
})

// ---------------------------------------------------------------------------
// 3. resolvedWindowTokens 桶隔离 —— 解析结果写入调用方会话的桶
// ---------------------------------------------------------------------------

test('D2: resolveScaledBudgets 把解析窗口写入调用方会话的桶（不写焦点桶）', async () => {
  let releaseProbe!: (v: { context?: { contextWindow?: number } }) => void
  const probeLlm = {
    resolveModelInfo(): Promise<{ context?: { contextWindow?: number } }> {
      return new Promise(resolve => { releaseProbe = resolve })
    },
  }
  const fakeCtx = { get: (name: string) => (name === 'llm' ? probeLlm : undefined) } as unknown as Context
  const bucketA = { resolvedWindowTokens: 0 }
  const bucketB = { resolvedWindowTokens: 0 }
  const sa = Session.create(SessionId('budget-bucket-a'))
  const sb = Session.create(SessionId('budget-bucket-b'))
  const host: BudgetHost = {
    explicitWindowTokens: false,
    windowTokens: DEFAULT_WINDOW_TOKENS,
    explicitRetainTokens: false,
    reserveTokens: 0,
    retainTokens: DEFAULT_RETAIN_TOKENS,
    declaredContextWindows: new WeakMap(),
    log: { info() {}, warn() {}, error() {} },
    windowRatio: DEFAULT_WINDOW_RATIO,
    retainRatio: DEFAULT_RETAIN_RATIO,
    stateOf: (s: Session) => (s === sa ? bucketA : bucketB),
    charsPerToken: 4,
    lastRealAnchorSeq: -1,
    lastRealPromptTokens: 0,
    tokenMeter: undefined,
    ctx: fakeCtx,
  }
  const p = resolveScaledBudgets(host, fakeAgent(sa))
  releaseProbe({ context: { contextWindow: 10000 } })
  const result = await p
  assert.equal(result.windowTokens, Math.floor(10000 * DEFAULT_WINDOW_RATIO))
  assert.equal(bucketA.resolvedWindowTokens, Math.floor(10000 * DEFAULT_WINDOW_RATIO), 'A 的解析结果必须落 A 的桶')
  assert.equal(bucketB.resolvedWindowTokens, 0, 'B 的桶不得被 A 的解析覆盖')
})

// ---------------------------------------------------------------------------
// 4. 召回路由 —— 多会话下 exec.agent 缺席拒绝回退
// ---------------------------------------------------------------------------

async function runToolOn(ctx: Context, name: string, args: Record<string, unknown>, agentSession?: Session): Promise<string> {
  const res = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId('drift-' + name + '-' + Math.random().toString(36).slice(2)),
    name,
    arguments: args,
    ...(agentSession !== undefined ? { agent: { session: agentSession } } : {}),
  } as never)
  return res.content[0]?.type === 'text' ? res.content[0].text : ''
}

test('路由：单会话回退保留；引擎见过 2 个会话后 exec.agent 缺席必须拒绝（不串台）', async () => {
  const { ctx, engine } = await makeEngine()
  try {
    const sa = makeSecretSession('drift-route-a', 'ALPHA')
    const sb = makeSecretSession('drift-route-b', 'BETA')
    engine.setSession(sa.session) // 引擎只见过一个会话
    const outSingle = await runToolOn(ctx, 'recall_pruned', { seq: sa.secretSeq })
    assert.ok(outSingle.includes('SECRET-ALPHA'), '单会话：无 agent 上下文的焦点回退保留（单会话宿主兼容）')

    engine.setSession(sb.session) // 第二个会话进入引擎视野
    const outMulti = await runToolOn(ctx, 'recall_pruned', { seq: sa.secretSeq })
    assert.ok(!outMulti.includes('SECRET-'), '多会话：不得静默回退焦点会话（否则读到 B 的内容喂给 A 的调用）')
    assert.ok(outMulti.includes('no session'), '拒绝必须显式说明（可观测，不是空结果）')
    // exec.agent 显式携带时永远照常路由（优先级最高）
    const outAgent = await runToolOn(ctx, 'recall_pruned', { seq: sa.secretSeq }, sa.session)
    assert.ok(outAgent.includes('SECRET-ALPHA'), 'exec.agent.session 携带时路由不受多会话影响')
  } finally {
    await ctx.fiber.dispose()
  }
})

// ---------------------------------------------------------------------------
// 5. zoom：路由同判据 + detail 预算会话化
// ---------------------------------------------------------------------------

test('zoom：单会话回退保留；两会话后拒绝；exec.agent 仍优先', async () => {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: 'zoom-drift test' } })
  try {
    const zoom = new RecallZoom(ctx, {})
    const probe = zoom as unknown as { sessionOfToolCall(exec: unknown): Session | null }
    const sa = Session.create(SessionId('zoom-a'))
    const sb = Session.create(SessionId('zoom-b'))
    zoom.setSession(sa)
    assert.equal(probe.sessionOfToolCall({}), sa, '单会话：无 agent 上下文回退保留')
    zoom.setSession(sb)
    assert.equal(probe.sessionOfToolCall({}), null, '两会话：缺席 agent 上下文必须拒绝')
    assert.equal(probe.sessionOfToolCall({ agent: { session: sa } }), sa, 'exec.agent.session 携带时照常路由')
  } finally {
    await ctx.fiber.dispose()
  }
})

test('zoom：detail 预算按会话声明窗口推导（不再锚死静态 16384）', async () => {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: 'zoom-budget test' } })
  try {
    const zoom = new RecallZoom(ctx, {})
    const probe = zoom as unknown as { detailBudgetFor(session: Session): number }
    const declared = Session.create(SessionId('zoom-budget-declared'))
    ;(declared as unknown as { requestContext?: () => unknown }).requestContext = () => ({ contextWindow: 10000 })
    const plain = Session.create(SessionId('zoom-budget-plain'))
    // DETAIL_WINDOW_RATIO = 0.05（zoom 私有常量；显式锁定推导式而不是实现细节）
    assert.equal(probe.detailBudgetFor(declared), Math.floor(10000 * 0.05 * DEFAULT_CHARS_PER_TOKEN), '声明窗口 10000 ⇒ 预算随会话推导')
    assert.equal(probe.detailBudgetFor(plain), Math.floor(DEFAULT_WINDOW_TOKENS * 0.05 * DEFAULT_CHARS_PER_TOKEN), '未声明 ⇒ 回退静态默认口径')
  } finally {
    await ctx.fiber.dispose()
  }
})

// ---------------------------------------------------------------------------
// 6. compactIfNeeded signal 接线
// ---------------------------------------------------------------------------

test('signal：进入即取消 → null 且零事务事件；await 后取消 → 拒绝且零写点', async () => {
  const { ctx, engine } = await makeEngine()
  try {
    const s1 = makeSessionWith('drift-sig1', 4000)
    const r1 = await engine.compactIfNeeded(fakeAgent(s1.session), 'pressure', AbortSignal.abort())
    assert.equal(r1, null, '进入即取消：不得动 surface')
    assert.equal(compactionEventCount(s1.session), 0)

    const s2 = makeSessionWith('drift-sig2', 4000)
    const ac = new AbortController()
    const p = engine.compactIfNeeded(fakeAgent(s2.session), 'pressure', ac.signal)
    ac.abort() // await 窗口内取消（内容可剪——无取消点时本应正常剪枝，保证反例真实）
    await assert.rejects(p, /abort/i, '预算 await 后必须先于任何事务写点抛出取消')
    assert.equal(compactionEventCount(s2.session), 0, '取消路径不得落盘任何事务事件')
  } finally {
    await ctx.fiber.dispose()
  }
})
