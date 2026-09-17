/**
 * dsh-llm 生产适配器单测（P5 后债务清算）。
 *
 * 锁定四件事：
 *  ① completeViaDshLlm：text-delta 拼装、usage 记账、purpose='compaction' 归类、
 *    宿主无 llm 服务时明确报错（不静默）；
 *  ② compressor 的 config.llm 后端：走 ctx.llm、fetch 零调用、usage 落 record、
 *    解析/守卫/落盘全链路与 fetch 后端行为一致；
 *  ③ 后端优先级：config.llm 存在时无须 endpoint/apiKey（disabled 语义让位）；
 *  ④ declarer 同款接线：声明边照常入缓存（injectEdges 通道与后端无关）；
 *  ⑤ 宿主路由自动兜底（§11.13.1）：无显式 llm/endpoint/env 时先 disabled，agent 路由
 *    到位后自动武装并跟随宿主 provider/model；显式 config.llm 优先于兜底。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { completeViaDshLlm } from '../src/peratom/llm-adapter.ts'
import { autoDshLlmSpec } from '../src/peratom/llm-adapter.ts'
import { PeratomCompressor } from '../src/peratom/compressor.ts'
import { CiteDeclarer } from '../src/peratom/cite-declarer.ts'
import type { DshLlmSpec } from '../src/peratom/llm-adapter.ts'

// ---------------------------------------------------------------------------
// 测试替身：宿主 llm 服务（LlmRuntime 结构化最小视图）
// ---------------------------------------------------------------------------

interface FakeStreamCall { provider: string; model: string; purpose?: string; messageCount: number }

function fakeLlm(responses: Array<{ text?: string; usage?: { inputTokens: number; outputTokens: number } }>): {
  service: unknown
  calls: FakeStreamCall[]
} {
  const calls: FakeStreamCall[] = []
  let i = 0
  const service = {
    async *stream(options: {
      provider: string
      model: string
      purpose?: string
      messages: unknown[]
    }) {
      calls.push({ provider: options.provider, model: options.model, purpose: options.purpose, messageCount: options.messages.length })
      const r = responses[Math.min(i, responses.length - 1)]
      i += 1
      const text = r.text ?? ''
      const mid = Math.ceil(text.length / 2)
      yield { type: 'text-delta', text: text.slice(0, mid) }
      yield { type: 'text-delta', text: text.slice(mid) }
      if (r.usage !== undefined) yield { type: 'usage', usage: r.usage }
    },
  }
  return { service, calls }
}

function ctxWithLlm(service: unknown): Context {
  const ctx = new Context()
  ;(ctx as unknown as { llm: unknown }).llm = service
  return ctx
}

// ---------------------------------------------------------------------------
// ① completeViaDshLlm 直测
// ---------------------------------------------------------------------------

test('completeViaDshLlm：text-delta 拼装 + usage 记账 + purpose=compaction + 单消息 hand-built 请求', async () => {
  const { service, calls } = fakeLlm([{ text: '{"splits":[],"tools":[]}', usage: { inputTokens: 1234, outputTokens: 56 } }])
  const res = await completeViaDshLlm(ctxWithLlm(service), { provider: 'deepseek-official', model: 'deepseek-v4-flash' }, 'PROMPT', 1000)
  assert.equal(res.text, '{"splits":[],"tools":[]}')
  assert.deepEqual(res.usage, { promptTokens: 1234, completionTokens: 56 })
  assert.equal(calls.length, 1)
  const call = calls[0]
  assert.ok(call !== undefined)
  assert.equal(call.provider, 'deepseek-official')
  assert.equal(call.model, 'deepseek-v4-flash')
  assert.equal(call.purpose, 'compaction', '辅助模型调用必须带 purpose=compaction（GenerateOptions 词表）')
  assert.equal(call.messageCount, 1)
})

test('completeViaDshLlm：宿主无 llm 服务 → 明确报错（不静默）', async () => {
  await assert.rejects(
    () => completeViaDshLlm(new Context(), { provider: 'p', model: 'm' }, 'PROMPT', 1000),
    /no llm service/,
  )
})

// ---------------------------------------------------------------------------
// 会话构建（与 peratom-compressor.test.ts 同款最小构造）
// ---------------------------------------------------------------------------

const LONG_USER = '帮我修复这个报错，服务起不来了，先看日志再给出修复步骤：\n' + 'Error: listen EADDRINUSE :::3000\n    at Server.setupListenListen (node:net:1917:16)\n'.repeat(4)

function appendUser(session: Session, text: string): number {
  session.append('user/message', { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } } as never, { surfaceOp: 'append' })
  return session.snapshotEvents().length - 1
}

function appendAssistantWithToolCall(session: Session, turn: number, callId: string): number {
  session.append('assistant/message', { stream: [], 
    turn,
    step: 1,
    message: {
      role: 'assistant',
      id: 'am_' + callId,
      source: { kind: 'model', provider: 'test', model: 'test' },
      content: [
        { type: 'tool-call', id: callId, name: 'read_file', arguments: '{"path":"log.txt"}' },
        { type: 'text', text: 'on it' },
      ],
    },
  } as never, { surfaceOp: 'append' })
  return session.snapshotEvents().length - 1
}

function appendToolResult(session: Session, turn: number, callId: string, text: string): number {
  session.append('tool/result', {
    turn,
    step: 1,
    message: {
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }], isError: false }],
      source: { kind: 'tool', callId },
      id: 'm_' + callId,
    },
  } as never, { surfaceOp: 'append' })
  return session.snapshotEvents().length - 1
}

function buildCompressibleTurn(session: Session, turn: number, callId: string): { uSeq: number; aSeq: number; rSeq: number } {
  session.append('turn/start', { turn } as never)
  const uSeq = appendUser(session, LONG_USER)
  const aSeq = appendAssistantWithToolCall(session, turn, callId)
  const rSeq = appendToolResult(session, turn, callId, ('EADDRINUSE stack line '.padEnd(40, '.') + '\n').repeat(20))
  session.append('turn/end', { turn, reason: { kind: 'completed' } } as never)
  return { uSeq, aSeq, rSeq }
}

// ---------------------------------------------------------------------------
// ②③ compressor 接线
// ---------------------------------------------------------------------------

test('compressor：config.llm 后端走 ctx.llm、fetch 零调用、usage 落 record、落盘链路不变', async t => {
  // 先建会话拿到 rSeq，再按 seq 组装响应（JSON.stringify 提前固化是本测试曾踩的坑）
  const session = Session.create(SessionId('llm-adapter-comp'))
  const { rSeq } = buildCompressibleTurn(session, 1, 'c1')
  const { service, calls } = fakeLlm([{ text: JSON.stringify({ splits: [], tools: [{ seq: rSeq, level: 'summary', text: 'EADDRINUSE 连接耗尽摘要' }] }), usage: { inputTokens: 500, outputTokens: 20 } }])
  const ctx = ctxWithLlm(service)
  t.after(() => ctx.fiber.dispose())
  let fetchCalled = 0
  const compressor = new PeratomCompressor(ctx, {
    llm: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    fetchImpl: (async () => { fetchCalled += 1; throw new Error('fetch must not be used') }) as typeof fetch,
  })
  const record = await compressor.compressCurrentTurn(session)
  assert.ok(record !== null)
  assert.equal(record.called, true)
  assert.equal(record.appliedReplaces, 1, '落盘链路（守卫→replace 事务）与 fetch 后端行为一致')
  assert.ok(record.usage !== undefined, 'dsh-llm usage 必须入账')
  assert.equal(record.usage?.completionTokens, 20)
  assert.equal(fetchCalled, 0, 'llm 后端就位时 fetch 零调用')
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.provider, 'deepseek-official')
})

test('compressor：config.llm 存在时无须 endpoint/apiKey（no-endpoint 语义让位）', async t => {
  const { service, calls } = fakeLlm([{ text: '{"splits":[],"tools":[]}' }])
  const ctx = ctxWithLlm(service)
  t.after(() => ctx.fiber.dispose())
  const compressor = new PeratomCompressor(ctx, { llm: { provider: 'p', model: 'm' } })
  const session = Session.create(SessionId('llm-adapter-priority'))
  buildCompressibleTurn(session, 1, 'c2')
  const record = await compressor.compressCurrentTurn(session)
  assert.ok(record !== null)
  assert.notEqual(record.error, 'no-endpoint', 'llm 后端就位时不得判 disabled')
  assert.equal(record.called, true)
  assert.equal(calls.length, 1)
})

// ---------------------------------------------------------------------------
// ④ declarer 接线
// ---------------------------------------------------------------------------

test('declarer：config.llm 接线——跨轮声明边照常入缓存（injectEdges 通道与后端无关）', async t => {
  // declarer 语义（设计 §"输入 = 当轮原子 + 近 N 轮窗口"）：from=当轮行为原子、
  // to=先前轮数据原子——当轮 R 只进门控、不在 to 集合。故构造两轮：
  // turn-1 留下大 R（to 目标），turn-2 的 assistant（from）声明引用它。
  const session = Session.create(SessionId('llm-adapter-decl'))
  const r1 = buildCompressibleTurn(session, 1, 'c1')
  session.append('turn/start', { turn: 2 } as never)
  appendUser(session, LONG_USER) // turn-2 user-long 供门控
  const a2 = appendAssistantWithToolCall(session, 2, 'c2')
  appendToolResult(session, 2, 'c2', 'small')
  session.append('turn/end', { turn: 2, reason: { kind: 'completed' } } as never)
  const fake = fakeLlm([{ text: JSON.stringify({ cites: [{ fromSeq: a2, toSeq: r1.rSeq, level: 'supporting' }] }) }])
  const ctx = ctxWithLlm(fake.service)
  t.after(() => ctx.fiber.dispose())
  let fetchCalled = 0
  const declarer = new CiteDeclarer(ctx, {
    llm: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } satisfies DshLlmSpec,
    fetchImpl: (async () => { fetchCalled += 1; throw new Error('fetch must not be used') }) as typeof fetch,
  })
  const record = await declarer.declareCurrentTurn(session)
  assert.ok(record !== null)
  assert.equal(record.called, true)
  assert.equal(record.accepted, 1)
  assert.equal(declarer.cachedEdgeCount, 1, '声明边照常入缓存')
  assert.equal(fetchCalled, 0)
  assert.equal(fake.calls.length, 1)
})

// ---------------------------------------------------------------------------
// ⑤ 宿主路由自动兜底（2026-09-17 §11.13.1）
// ---------------------------------------------------------------------------

/** 清掉三条后端 env（defaultEndpoint 口径），返回还原函数。 */
function withoutLlmEnv(): () => void {
  const keys = ['ARGP_MODEL_SOURCE', 'QWEN_BASE', 'QWEN_MODEL', 'DEEPSEEK_API_KEY', 'DEEPSEEK_BASE', 'DEEPSEEK_MODEL']
  const saved = keys.map(k => [k, process.env[k]] as const)
  for (const k of keys) delete process.env[k]
  return () => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

function emitRouting(ctx: Context, session: Session, provider: string, model: string): void {
  ;(ctx as unknown as { emit: (n: string, ...a: unknown[]) => void })
    .emit('agent/status', { agent: { session, options: { provider, model } }, status: 'running' })
}

test('autoDshLlmSpec：路由齐备 + 宿主有 llm 才解析，缺一即 null', () => {
  const { service } = fakeLlm([{ text: '{}' }])
  const ctx = ctxWithLlm(service)
  assert.deepEqual(autoDshLlmSpec(ctx, { provider: 'localhost', model: 'Qwen3.8-27B' }), { provider: 'localhost', model: 'Qwen3.8-27B' })
  assert.equal(autoDshLlmSpec(ctx, null), null, '无路由 → 不兜底')
  assert.equal(autoDshLlmSpec(ctx, { provider: 'p' }), null, '缺 model → 不兜底')
  assert.equal(autoDshLlmSpec(ctx, { provider: 'p', model: '' }), null, '空 model → 不兜底')
  assert.equal(autoDshLlmSpec(ctx, { provider: '', model: 'm' }), null, '空 provider → 不兜底')
  assert.equal(autoDshLlmSpec(new Context(), { provider: 'p', model: 'm' }), null, '宿主无 llm 服务 → 不兜底')
})

test('compressor：自动兜底——无 llm/endpoint/env 时先 disabled，agent 路由到位后跟随宿主后端', async t => {
  const restoreEnv = withoutLlmEnv()
  t.after(restoreEnv)

  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  let fetchCalled = 0
  const fetchImpl = (async () => { fetchCalled += 1; throw new Error('fetch must not be used') }) as typeof fetch

  // ① 路由未知：与既有 disabled 语义逐字一致（零网络、零调用）
  const offSession = Session.create(SessionId('llm-auto-comp-off'))
  const offCompressor = new PeratomCompressor(ctx, { fetchImpl })
  buildCompressibleTurn(offSession, 1, 'c1')
  const before = await offCompressor.compressCurrentTurn(offSession)
  assert.equal(before?.error, 'no-endpoint', '无显式后端且路由未知 → 保持 no-endpoint')
  assert.equal(fetchCalled, 0, '未武装时零网络')

  // ② 宿主在钩子里告知路由：自动武装，后端 = 宿主路由（provider/model 跟随，不写死）
  const onSession = Session.create(SessionId('llm-auto-comp-on'))
  const turn = buildCompressibleTurn(onSession, 1, 'c2')
  const fake = fakeLlm([{
    text: JSON.stringify({ splits: [], tools: [{ seq: turn.rSeq, level: 'summary', text: '自动兜底摘要' }] }),
    usage: { inputTokens: 42, outputTokens: 8 },
  }])
  ;(ctx as unknown as { llm: unknown }).llm = fake.service
  const onCompressor = new PeratomCompressor(ctx, { fetchImpl })
  emitRouting(ctx, onSession, 'localhost', 'Qwen3.8-27B')

  const record = await onCompressor.compressCurrentTurn(onSession)
  assert.ok(record !== null)
  assert.equal(record.error, undefined, '路由到位后不得再判 disabled')
  assert.equal(record.called, true)
  assert.equal(record.appliedReplaces, 1, '落盘链路与显式后端一致')
  assert.equal(fetchCalled, 0, 'dsh-llm 后端就位时 fetch 零调用')
  assert.equal(fake.calls.length, 1)
  assert.equal(fake.calls[0]?.provider, 'localhost', '后端 provider 跟随 agent 路由')
  assert.equal(fake.calls[0]?.model, 'Qwen3.8-27B', '后端 model 跟随 agent 路由')
  assert.equal(fake.calls[0]?.purpose, 'compaction')
})

test('compressor：显式 config.llm 优先于自动兜底（显式配了就不跟随宿主）', async t => {
  const restoreEnv = withoutLlmEnv()
  t.after(restoreEnv)

  const session = Session.create(SessionId('llm-auto-precedence'))
  const turn = buildCompressibleTurn(session, 1, 'c1')
  const fake = fakeLlm([{ text: JSON.stringify({ splits: [], tools: [{ seq: turn.rSeq, level: 'summary', text: 'S' }] }) }])
  const ctx = ctxWithLlm(fake.service)
  t.after(() => ctx.fiber.dispose())
  const compressor = new PeratomCompressor(ctx, { llm: { provider: 'explicit-p', model: 'explicit-m' } })
  emitRouting(ctx, session, 'localhost', 'Qwen3.8-27B')
  await compressor.compressCurrentTurn(session)
  assert.equal(fake.calls[0]?.provider, 'explicit-p', '显式 llm 赢过自动兜底')
  assert.equal(fake.calls[0]?.model, 'explicit-m')
})

test('declarer：自动兜底——armed 随路由到位翻转，声明边照常入缓存', async t => {
  const restoreEnv = withoutLlmEnv()
  t.after(restoreEnv)

  const session = Session.create(SessionId('llm-auto-decl'))
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  let fetchCalled = 0
  const declarer = new CiteDeclarer(ctx, {
    fetchImpl: (async () => { fetchCalled += 1; throw new Error('fetch must not be used') }) as typeof fetch,
  })

  // turn-1 的大 R 是 turn-2 的 to 目标（与既有显式后端用例同款布局）。
  const r1 = buildCompressibleTurn(session, 1, 'c1')

  // ① 路由未知：未武装 → 静默跳过，零网络
  assert.equal(declarer.armed, false, '构造期拿不到路由 → 未武装（citesObligation 保持开启）')
  const before = await declarer.declareCurrentTurn(session)
  assert.equal(before?.error, 'no-endpoint')
  assert.equal(fetchCalled, 0)

  // ② 路由到位后自动武装
  session.append('turn/start', { turn: 2 } as never)
  appendUser(session, LONG_USER)
  const a2 = appendAssistantWithToolCall(session, 2, 'c2')
  appendToolResult(session, 2, 'c2', 'small')
  session.append('turn/end', { turn: 2, reason: { kind: 'completed' } } as never)
  const fake = fakeLlm([{ text: JSON.stringify({ cites: [{ fromSeq: a2, toSeq: r1.rSeq, level: 'supporting' }] }) }])
  ;(ctx as unknown as { llm: unknown }).llm = fake.service
  emitRouting(ctx, session, 'localhost', 'Qwen3.8-27B')
  assert.equal(declarer.armed, true, '路由到位后自动武装')

  const record = await declarer.declareCurrentTurn(session)
  assert.ok(record !== null)
  assert.equal(record.called, true)
  assert.equal(record.accepted, 1)
  assert.equal(declarer.cachedEdgeCount, 1, '声明边照常入缓存')
  assert.equal(fetchCalled, 0)
  assert.equal(fake.calls[0]?.provider, 'localhost')
  assert.equal(fake.calls[0]?.model, 'Qwen3.8-27B')
})
