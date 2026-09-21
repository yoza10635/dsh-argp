/**
 * peratom「轮末 pass 落地等待」单测（A 方案，2026-09-21）。
 *
 * 背景：事务发射推迟到下一轮首个 `agent/pre-step`（loop 先跑 preStep 再落盘消息）。
 * 旧实现"绝不 await 网络"⇒ 若轮末 LLM 调用仍在飞而用户已发下一条消息，新轮首个
 * pre-step 无条目可发射，替换副本落到新轮**中途**（真环境实证 #9：晚 6 步，前 6 步
 * 跑在未压缩上下文上 + 中途换 surface 断 KV）。本组用例锁"有界等待"语义：
 *  ① 在飞 ⇒ pre-step 必须等它落地（下一个 user message 等待）
 *  ② 超时 ⇒ 放行不卡死（上界 = flushWaitMs，事务顺延到后续窗口）
 *  ③ 已就绪 ⇒ 立即发射，零额外等待
 *  ④ flushWaitMs: 0 ⇒ 关闭等待（逃生阀，退回旧行为）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { PeratomCompressor } from '../src/peratom/compressor.ts'

const DIALOG = '帮我修复这个报错，服务起不来了，先看日志再给出修复步骤：'
const DIALOG_QUOTE = DIALOG
const LONG_USER = DIALOG + 'Error: listen EADDRINUSE :::3000\n    at Server.setup (node:net:1917:16)\n'.repeat(4)

interface CapturedRequest { url: URL | string; body: Record<string, unknown> }
interface GatedHarness {
  ctx: Context
  compressor: PeratomCompressor
  requests: CapturedRequest[]
  release: () => void
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(r => { resolve = r })
  return { promise, resolve }
}

async function waitFor(pred: () => boolean, ms = 1_000): Promise<void> {
  const t0 = Date.now()
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('waitFor: condition not met in time')
    await new Promise(r => setTimeout(r, 2))
  }
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

/** 会话：闭合的可压轮（turn 1）+ 新轮 turn/start（turn 2）= "新轮已开、消息未落盘"。 */
function buildScenario(id: string): { session: Session; uSeq: number; rSeq: number; agent: Agent; plan: unknown } {
  const session = Session.create(SessionId(id))
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: LONG_USER }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  const uSeq = session.snapshotEvents().length - 1
  session.append('assistant/message', { stream: [], 
    turn: 1,
    step: 1,
    message: {
      role: 'assistant',
      id: 'am_c1',
      source: { kind: 'model', provider: 't', model: 't' },
      content: [{ type: 'tool-call', id: 'c1', name: 'read_file', arguments: '{"path":"log.txt"}' }],
    },
  } as never, { surfaceOp: 'append' })
  session.append('tool/result', {
    turn: 1,
    step: 1,
    message: {
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: ('EADDRINUSE stack line '.padEnd(40, '.') + '\n').repeat(20) }], isError: false }],
      source: { kind: 'tool', callId: 'c1' },
      id: 'm_c1',
    },
  } as never, { surfaceOp: 'append' })
  const rSeq = session.snapshotEvents().length - 1
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } } as never)
  session.append('turn/start', { turn: 2 })
  const plan = {
    splits: [{ seq: uSeq, quotes: [DIALOG_QUOTE], infoLevel: 'extract', infoText: 'log EADDRINUSE' }],
    tools: [{ seq: rSeq, level: 'extract', text: 'EADDRINUSE stack' }],
  }
  return { session, uSeq, rSeq, agent: { session, options: {} } as Agent, plan }
}

/** 带闸门 harness：fetch 进入后挂住，直到 release()（模拟"轮末 pass 仍在飞"）。 */
async function makeGatedHarness(plan: unknown, config: Record<string, unknown> = {}): Promise<GatedHarness> {
  const gate = deferred()
  const requests: CapturedRequest[] = []
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: 'peratom-flush-wait' } })
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    requests.push({ url, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> })
    await gate.promise
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(plan) } }],
      usage: { completion_tokens: 10 },
    }), { status: 200 })
  }) as typeof fetch
  const compressor = new PeratomCompressor(ctx, {
    endpoint: 'http://fake.test/v1/chat/completions',
    apiKey: 'test-key',
    model: 'test-model',
    fetchImpl,
    ...config,
  })
  return { ctx, compressor, requests, release: gate.resolve }
}

/** 触发 pre-step waterfall（返回 promise：用于断言"是否已放行"）。 */
function firePreStep(ctx: Context, agent: Agent): Promise<unknown> {
  return agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { agent, messages: [], turn: 2, step: 1, signal: new AbortController().signal } as never,
    (() => Promise.resolve(undefined)) as never,
  )
}

const hasTransaction = (session: Session): boolean => session.snapshotEvents().some(e => e.type === 'compaction/start')

// ---------------------------------------------------------------------------
// ① 在飞 ⇒ 等待
// ---------------------------------------------------------------------------

test('① 轮末 pass 在飞时 pre-step 等到它落地才放行（下一个 user message 等待）', async t => {
  const { session, agent, plan } = buildScenario('pf-await')
  const h = await makeGatedHarness(plan)
  t.after(async () => { h.release(); await h.ctx.fiber.dispose() })

  h.ctx.emit('agent/status', { agent, status: 'idle' }) // 轮末 idle → 发起 pass（挂在网上）
  await waitFor(() => h.requests.length > 0)

  let released = false
  const preStep = firePreStep(h.ctx, agent).then(() => { released = true })
  await sleep(40)
  assert.equal(released, false, 'pre-step 必须等待在飞 pass（旧实现此处立即放行）')
  assert.equal(hasTransaction(session), false, '未落地前不得发射事务')

  h.release()
  await preStep
  assert.equal(released, true, 'pass 落地后 pre-step 放行')
  assert.equal(hasTransaction(session), true, '事务在同一 pre-step 窗口内发射（本轮首个请求即带压缩结果）')
})

// ---------------------------------------------------------------------------
// ② 超时 ⇒ 放行
// ---------------------------------------------------------------------------

test('② 超过 flushWaitMs 未落地则放行（不卡死这一轮；事务顺延到后续窗口）', async t => {
  const { session, agent, plan } = buildScenario('pf-timeout')
  const h = await makeGatedHarness(plan, { flushWaitMs: 80 })
  t.after(async () => { h.release(); await h.ctx.fiber.dispose() })

  h.ctx.emit('agent/status', { agent, status: 'idle' })
  await waitFor(() => h.requests.length > 0)

  const t0 = Date.now()
  await firePreStep(h.ctx, agent)
  const elapsed = Date.now() - t0
  assert.ok(elapsed >= 60, `等待上界生效（实测 ${elapsed}ms，应 ≈80ms）`)
  assert.equal(hasTransaction(session), false, 'pass 未落地 ⇒ 本次 pre-step 无事务（退回旧行为）')
})

// ---------------------------------------------------------------------------
// ③ 已就绪 ⇒ 立即发射
// ---------------------------------------------------------------------------

test('③ pass 已就绪 ⇒ pre-step 立即发射，不产生额外等待', async t => {
  const { session, agent, plan } = buildScenario('pf-ready')
  const h = await makeGatedHarness(plan, { flushWaitMs: 5_000 })
  t.after(async () => { h.release(); await h.ctx.fiber.dispose() })

  h.ctx.emit('agent/status', { agent, status: 'idle' })
  h.release()
  await waitFor(() => h.compressor.pendingCount > 0) // pass 已跑完、条目就绪

  const t0 = Date.now()
  await firePreStep(h.ctx, agent)
  const elapsed = Date.now() - t0
  assert.ok(elapsed < 1_000, `就绪条目不得触发等待上界（实测 ${elapsed}ms ≪ 5000ms）`)
  assert.equal(hasTransaction(session), true, '已就绪条目在该窗口发射')
})

// ---------------------------------------------------------------------------
// ④ flushWaitMs: 0 ⇒ 逃生阀
// ---------------------------------------------------------------------------

test('④ flushWaitMs=0 关闭等待（逃生阀）：在飞 pass 不阻塞 pre-step', async t => {
  const { session, agent, plan } = buildScenario('pf-off')
  const h = await makeGatedHarness(plan, { flushWaitMs: 0 })
  t.after(async () => { h.release(); await h.ctx.fiber.dispose() })

  h.ctx.emit('agent/status', { agent, status: 'idle' })
  await waitFor(() => h.requests.length > 0)

  const t0 = Date.now()
  await firePreStep(h.ctx, agent)
  const elapsed = Date.now() - t0
  assert.ok(elapsed < 200, `关闭等待后立即放行（实测 ${elapsed}ms）`)
  assert.equal(hasTransaction(session), false, '在飞 pass 未落地 ⇒ 无事务（退回旧行为）')
})
