/**
 * 预算比例解析回归测试：
 *  - scaleBudgets 纯函数：显式优先 / 比例推导（0.8 / 0.2）/ 无上下文回退
 *  - 集成：显式 window/retain 走显式路径（无 llm 依赖）
 *  - 集成：未显式 + llm 无 adapter → 回退静态默认，不崩溃
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ArgpGraphEngine, scaleBudgets } from '../src/argp-graph-engine.ts'
import { resolveScaledBudgets, type BudgetHost } from '../src/budget.ts'
import { DEFAULT_WINDOW_TOKENS, DEFAULT_RETAIN_TOKENS, DEFAULT_WINDOW_RATIO, DEFAULT_RETAIN_RATIO } from '../src/constants.ts'

async function makeEngine(config: Record<string, unknown> = {}): Promise<{ ctx: Context; engine: ArgpGraphEngine }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: 'budget-scale test persona' } })
  await ctx.plugin(ArgpGraphEngine, { windowTokens: 100, retainTokens: 50, minSpanChars: 20, recencyGuard: 0, maxPasses: 16, ...config })
  return { ctx, engine: ctx.compaction as ArgpGraphEngine }
}

function appendUser(session: Session, text: string): void {
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
}
function appendAssistant(session: Session, text: string, turn: number): void {
  session.append('assistant/message', { stream: [],  turn, step: 1, message: createAssistantMessage({ source: { provider: 'test', model: 'test' }, content: [{ type: 'text', text }] }) }, { surfaceOp: 'append' })
}

function fakeAgent(session: Session): never {
  return { session, options: { provider: 'test', model: 'm' } } as never
}

test('scaleBudgets: explicit values win over ratios', () => {
  const r = scaleBudgets(1000, { explicitWindow: 500, explicitRetain: 100 })
  assert.deepEqual(r, { windowTokens: 500, retainTokens: 100 })
})

test('scaleBudgets: window = ctx×0.8, retain = window×0.2', () => {
  const r = scaleBudgets(1000, {})
  assert.equal(r.windowTokens, 800)
  assert.equal(r.retainTokens, 160)
  // 非 1000 的上下文也验证
  const r2 = scaleBudgets(200_000, {})
  assert.equal(r2.windowTokens, 160_000)
  assert.equal(r2.retainTokens, 32_000)
})

test('scaleBudgets: custom ratios', () => {
  const r = scaleBudgets(200_000, { windowRatio: 0.5, retainRatio: 0.25 })
  assert.equal(r.windowTokens, 100_000)
  assert.equal(r.retainTokens, 25_000)
})

test('scaleBudgets: mixed explicit window + ratio retain', () => {
  const r = scaleBudgets(200_000, { explicitWindow: 50_000 })
  assert.equal(r.windowTokens, 50_000)
  assert.equal(r.retainTokens, 10_000)
})

test('scaleBudgets: no contextWindow → fallback defaults', () => {
  const r = scaleBudgets(undefined, {})
  assert.equal(r.windowTokens, 16_384)
  assert.equal(r.retainTokens, 8_192)
  const r2 = scaleBudgets(0, {})
  assert.equal(r2.windowTokens, 16_384)
})

test('explicit window/retain tokens are used as-is (no llm needed)', async () => {
  const { ctx, engine } = await makeEngine({ windowTokens: 500, retainTokens: 100 })
  try {
    const session = Session.create(SessionId('budget-explicit'))
    appendUser(session, 'anchor')
    appendAssistant(session, 'x'.repeat(4000), 1)
    appendAssistant(session, 'latest: y', 2)
    engine.setSession(session)
    const result = await engine.compactIfNeeded(fakeAgent(session), 'pressure', new AbortController().signal)
    assert.ok(result !== null, 'should compact with explicit budget')
    assert.equal((engine as unknown as { resolvedWindowTokens: number }).resolvedWindowTokens, 500)
  } finally {
    await ctx.fiber.dispose()
  }
})

test('no explicit tokens + llm without adapter → fallback static defaults, no crash', async () => {
  const { ctx, engine } = await makeEngine({ windowTokens: undefined, retainTokens: undefined })
  try {
    const session = Session.create(SessionId('budget-fallback'))
    appendUser(session, 'anchor')
    appendAssistant(session, 'x'.repeat(100), 1)
    appendAssistant(session, 'latest: y', 2)
    engine.setSession(session)
    // 无显式 token + llm 无 adapter：不抛错即"no crash"（compactIfNeeded 正常返回）；
    // 真实断言落在回退静态默认窗口 16384（P3.1：原 :93 恒真断言已删）。
    await engine.compactIfNeeded(fakeAgent(session), 'pressure', new AbortController().signal)
    assert.equal((engine as unknown as { resolvedWindowTokens: number }).resolvedWindowTokens, 16_384)
  } finally {
    await ctx.fiber.dispose()
  }
})

// ---------------------------------------------------------------------------
// ⑧ 1.5.1 回归：resolveModelInfo 挂起被 5s 超时兜底——不卡死且走静态默认
//    P1.3：旧代码用 new AbortController().signal 但 controller 从未 abort ⇒ LLM 服务
//    挂起时 await 无限阻塞 pre-step。修复：5s setTimeout 把 hang 转成 rejection，
//    落入 contextWindow=undefined 降级（declaredKnown=false，宁缺勿错）。
//    注入一个「永不 resolve、但在 signal abort 时 reject」的 resolveModelInfo——真实
//    适配器监听 AbortSignal，5s 超时即触发 reject；若超时失效则会真正卡死。
// ---------------------------------------------------------------------------

test('resolveScaledBudgets：resolveModelInfo 挂起被 5s 超时兜底——不卡死且走静态默认', async () => {
  // 信号感知的「挂起」替身：永不 resolve，仅在 signal abort 时 reject（真适配器同语义）
  const hangingLlm = {
    resolveModelInfo(_provider: string, _model: string, signal: AbortSignal) {
      return new Promise<{ context?: { contextWindow?: number } }>((_resolve, reject) => {
        if (signal.aborted) { reject(new Error('aborted')); return }
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    },
  }
  const fakeCtx = { get: (name: string) => (name === 'llm' ? hangingLlm : undefined) } as unknown as Context
  const host: BudgetHost = {
    explicitWindowTokens: false,
    windowTokens: DEFAULT_WINDOW_TOKENS,
    explicitRetainTokens: false,
    retainTokens: DEFAULT_RETAIN_TOKENS,
    declaredContextWindows: new WeakMap(),
    log: { info() {}, warn() {}, error() {} },
    windowRatio: DEFAULT_WINDOW_RATIO,
    retainRatio: DEFAULT_RETAIN_RATIO,
    resolvedWindowTokens: 0,
    charsPerToken: 4,
    lastRealAnchorSeq: -1,
    lastRealPromptTokens: 0,
    tokenMeter: undefined,
    ctx: fakeCtx,
  }
  const session = Session.create(SessionId('budget-timeout'))
  const agent = { session, options: { provider: 'p', model: 'm' } } as never

  // 6s 守卫赛跑：若 5s 超时未生效，resolveScaledBudgets 会无限挂起 ⇒ 此处 reject 使测试失败
  // （证明测试真的卡住 = 超时失效）。主 promise settle 后置 settled=true，避免悬挂 reject 变未处理拒绝。
  let settled = false
  const guard = new Promise<never>((_, rej) => {
    setTimeout(() => { if (!settled) rej(new Error('resolveScaledBudgets 卡死超过 6s —— 5s 超时未生效')) }, 6000)
  })
  const result = await Promise.race([resolveScaledBudgets(host, agent), guard])
  settled = true

  // 超时后 contextWindow 仍 undefined ⇒ scaleBudgets 走 fallbackWindow(=host.windowTokens=DEFAULT)
  assert.equal(host.resolvedWindowTokens, DEFAULT_WINDOW_TOKENS, 'resolveModelInfo 挂起 ⇒ 走静态默认窗口，不依赖声明值')
  assert.equal(result.windowTokens, DEFAULT_WINDOW_TOKENS)
  assert.equal(result.retainTokens, DEFAULT_RETAIN_TOKENS)
  assert.equal(result.declaredKnown, false, '声明值未知 ⇒ declaredKnown=false（宁缺勿错）')
})
