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

async function makeEngine(config: Record<string, unknown> = {}): Promise<{ ctx: Context; engine: ArgpGraphEngine }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: 'budget-scale test persona' } })
  await ctx.plugin(ArgpGraphEngine, { windowTokens: 100, retainTokens: 50, minSpanChars: 20, recencyGuard: 0, maxPasses: 16, ...config })
  return { ctx, engine: ctx.compaction as ArgpGraphEngine }
}

function appendUser(session: Session, text: string): void {
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
}
function appendAssistant(session: Session, text: string, turn: number): void {
  session.append('assistant/message', { turn, step: 1, message: createAssistantMessage({ source: { provider: 'test', model: 'test' }, content: [{ type: 'text', text }] }) }, { surfaceOp: 'append' })
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
    const result = await engine.compactIfNeeded(fakeAgent(session), 'pressure', new AbortController().signal)
    assert.ok(result === null || result !== null, 'no crash on llm-unavailable')
    assert.equal((engine as unknown as { resolvedWindowTokens: number }).resolvedWindowTokens, 16_384)
  } finally {
    await ctx.fiber.dispose()
  }
})
