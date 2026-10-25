/**
 * 1.11.0-beta.1「预算真值与触发」回归锁（docs/repair-plan §批次2）。
 *  - 2-1 retain 绝对上界（scaleBudgets capRetain）+ 事务后 token 复测
 *  - 2-2 默认比率分支地面真值（不传 retainTokens，断言 visible(after) ≤ target）
 *  - 2-3 reactivePending 陈旧清理（正常 finish 清 pending）
 *  - 2-5 fetch 错误分类重试（400/422 降级重试；429/5xx 不重试）
 * 每个测试对应一个修复，删掉修复必须变红。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { scaleBudgets } from '../src/budget.ts'
import { visibleChars } from '../src/budget.ts'
import { ArgpGraphEngine } from '../src/argp-graph-engine.ts'
import { PeratomCompressor } from '../src/peratom/compressor.ts'
import { collectOpenTurn } from '../src/peratom/collect.ts'
import { postChat } from '../src/peratom/prompt.ts'
import type { ResolvedEndpoint } from '../src/peratom/compressor-types.ts'

async function makeEngine(config: Record<string, unknown> = {}): Promise<{ ctx: Context; engine: ArgpGraphEngine }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: 'budget-truth test' } })
  await ctx.plugin(ArgpGraphEngine, { recencyGuard: 0, minSpanChars: 0, turnGuard: 0, maxPasses: 16, ...config })
  return { ctx, engine: ctx.compaction as ArgpGraphEngine }
}

function appendAssistant(session: Session, text: string, turn = 1): number {
  session.append('assistant/message', {
    stream: [], turn, step: 1,
    message: createAssistantMessage({ source: { provider: 'test', model: 'test' }, content: [{ type: 'text', text }] }),
  }, { surfaceOp: 'append' })
  return session.snapshotEvents().length - 1
}

function appendUser(session: Session, text: string): void {
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
}

// ---------------------------------------------------------------------------
// 2-1: retain 绝对上界
// ---------------------------------------------------------------------------

test('2-1: scaleBudgets —— retain 被窗口 − reserve − headroom 封顶（比例目标再大也不越界）', () => {
  // 窗口 1000、reserve 100 ⇒ 上界 = 1000 − 100 − 100 = 800；比例目标 0.9×1000=900 > 800 ⇒ cap
  const capped = scaleBudgets(1000, { windowRatio: 1, retainRatio: 0.9, reserveTokens: 100 })
  assert.equal(capped.windowTokens, 1000)
  assert.equal(capped.retainTokens, 800, '0.9 比例目标 900 被 800 上界截断')
  // 显式 retain 同样被封顶（escape hatch 不越过物理上限）
  const explicit = scaleBudgets(1000, { explicitWindow: 1000, explicitRetain: 950, reserveTokens: 100 })
  assert.equal(explicit.retainTokens, 800, '显式 retain 950 也被封到 800')
  // 正常场景不受影响：0.2 比例目标 200 < 800 原样通过
  const normal = scaleBudgets(1000, { windowRatio: 1, retainRatio: 0.2, reserveTokens: 100 })
  assert.equal(normal.retainTokens, 200)
  // 极端小窗口：上界 ≤0 ⇒ retain 0（调用方按无保留空间处理）
  const tiny = scaleBudgets(50, { windowRatio: 1, retainRatio: 0.5, reserveTokens: 50 })
  assert.equal(tiny.retainTokens, 0)
})

// ---------------------------------------------------------------------------
// 2-2: 默认比率分支地面真值
// ---------------------------------------------------------------------------

test('2-2: 不传 retainTokens 的默认分支 —— 压缩后 visible(after) ≤ retain 目标（字符口径地面真值）', async () => {
  const { ctx, engine } = await makeEngine()
  try {
    const session = Session.create(SessionId('ground-truth'))
    // 声明窗口（declaredKnown + 触发线前提）：2048 窗 ⇒ 阈值 1638 tok；
    // 内容 8024 字符 ≈ 2293 tok > 阈值 ⇒ 必触发。
    ctx.emit('session/event', session, { type: 'request/context', data: { contextWindow: 2048 } } as never)
    appendUser(session, 'anchor')
    // 4 条独立大 A（无边引用 ⇒ 全部可剪）
    for (let i = 0; i < 4; i += 1) appendAssistant(session, 'A' + i + ' ' + 'x'.repeat(2000), 1 + i)
    appendUser(session, 'latest')
    engine.setSession(session)
    const before = visibleChars(session)
    await engine.compactIfNeeded({ session } as never, 'pressure', new AbortController().signal)
    const after = visibleChars(session)
    // 默认 retainRatio 0.2 ⇒ 目标 = 可剪内容 × 0.2。地面真值断言（删掉图剪收敛则红）。
    assert.ok(after < before, '发生了压缩（' + before + ' → ' + after + '）')
    assert.ok(after <= Math.ceil(before * 0.25), 'after=' + after + ' ≤ 目标上界（0.2×before+保守余量）')
  } finally {
    await ctx.fiber.dispose()
  }
})

// ---------------------------------------------------------------------------
// 2-3: reactivePending 陈旧清理
// ---------------------------------------------------------------------------

test('2-3: 正常 finish 清 reactivePending（clamped→正常 stop 不再误触发 reactive）', async () => {
  const { ctx, engine } = await makeEngine({ reactiveRetries: 2 })
  try {
    const session = Session.create(SessionId('stale-reactive'))
    appendUser(session, 'anchor')
    engine.setSession(session)
    const internal = engine as unknown as { reactivePending: WeakMap<Session, true> }
    // 模拟上一响应被钳制留下的 pending
    internal.reactivePending.set(session, true)
    // 正常 finish 的 assistant/message 事件流经 session/event ⇒ pending 被清
    session.append('assistant/message', {
      stream: [{ type: 'chunk', time: 0, chunk: { type: 'finish', reason: { kind: 'stop' } } }] as never,
      turn: 1, step: 1,
      message: createAssistantMessage({ source: { provider: 'test', model: 'test' }, content: [{ type: 'text', text: 'done normally' }] }),
    }, { surfaceOp: 'append' })
    // ctx 测试环境不自动派发 session/event（宿主接线）——手动 emit（见坑 7 惯例）
    const events = session.snapshotEvents()
    const last = events[events.length - 1]
    ctx.emit('session/event', session, last)
    assert.equal(internal.reactivePending.has(session), false, '正常 finish 后 pending 已清（旧实现跨响应存活）')
  } finally {
    await ctx.fiber.dispose()
  }
})

// ---------------------------------------------------------------------------
// 2-5: fetch 错误分类重试
// ---------------------------------------------------------------------------

const ep: ResolvedEndpoint = { endpoint: 'http://fake.test/v1/chat/completions', apiKey: 'k', model: 'm' }

test('2-5: 非 200 错误带 httpStatus 分类标注（400/429/500 各自正确），成功响应不变', async () => {
  // 重试分类逻辑在 flush.ts 的 catch（httpStatus 驱动）；本测试锁分类标注本身。
  const makeFetch = (status: number): typeof fetch => (async () => new Response('{"error":{"message":"x"}}', { status })) as typeof fetch
  for (const status of [400, 422, 429, 500]) {
    const err = await postChat(makeFetch(status), ep, 'p', 1000, true, undefined, undefined, undefined, 100).then(
      () => null,
      (e: Error & { httpStatus?: number }) => e,
    )
    assert.ok(err !== null, status + ' 必须抛错')
    assert.equal((err as Error & { httpStatus?: number }).httpStatus, status, status + ' 错误带 httpStatus 标注（删掉 2-5 标注即红）')
    assert.ok(err.message.includes('HTTP ' + status))
  }
})

test('2-5: callAndStash 对 429 不做 schema 降级重试（fetch 计数=1）；对 400 恰好 2 次', async () => {
  const { callAndStash } = await import('../src/peratom/flush.ts')
  const make = async (status: number): Promise<{ getCalls: () => number; host: never; session: Session }> => {
    const ctx = new Context()
    let calls = 0
    const fetchImpl = (async (_u: string | URL, init?: RequestInit) => {
      calls += 1
      void init
      return new Response('{"error":{"message":"x"}}', { status })
    }) as typeof fetch
    const compressor = new PeratomCompressor(ctx, { endpoint: 'http://fake.test/v1/chat/completions', apiKey: 'k', model: 'm', fetchImpl })
    const session = Session.create(SessionId('cls-' + status))
    session.append('turn/start', { turn: 1 })
    appendUser(session, 'u ' + 'a'.repeat(300))
    session.append('assistant/message', { stream: [], turn: 1, step: 1, message: { role: 'assistant', id: 'am1', source: { kind: 'model', provider: 't', model: 't' }, content: [{ type: 'tool-call', id: 'c1', name: 'read_file', arguments: '{"path":"x"}' }] } } as never, { surfaceOp: 'append' })
    session.append('tool/result', { turn: 1, step: 1, message: { role: 'user', id: 'm1', source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'R ' + 'x'.repeat(800) }], isError: false }] } } as never, { surfaceOp: 'append' })
    const host = compressor as never
    return { getCalls: () => calls, host, session }
  }
  // 429：一次请求即失败（无降级重试）
  const h429 = await make(429)
  const collect429 = collectOpenTurn(h429.host, h429.session)
  await callAndStash(h429.host, h429.session, collect429 as never)
  assert.equal(h429.getCalls(), 1, '429 只发一次（删掉 2-5 分类即红：旧实现会发 2 次）')
  // 400：schema → 裸 prompt 共 2 次
  const h400 = await make(400)
  const collect400 = collectOpenTurn(h400.host, h400.session)
  await callAndStash(h400.host, h400.session, collect400 as never)
  assert.equal(h400.getCalls(), 2, '400 发两次（兼容重试保留）')
})
