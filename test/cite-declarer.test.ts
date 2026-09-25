import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ArgpGraphEngine, type Atom } from '../src/argp-graph-engine.ts'
import { PeratomCompressor } from '../src/peratom/compressor.ts'
import {
  CiteDeclarer,
  collectDeclAtoms,
  normalizeCites,
} from '../src/peratom/cite-declarer.ts'
import { buildTombstoneRedirect } from '../src/prune-tx.ts'

// ---------------------------------------------------------------------------
// 测试会话构建器（与 peratom-compressor.test.ts 同口径）
// ---------------------------------------------------------------------------

const LONG_DIALOG = '帮我修复这个报错，服务起不来了，先看日志再给出修复步骤：\n'
const DIALOG_QUOTE = '帮我修复这个报错，服务起不来了，先看日志再给出修复步骤：'
const LONG_PASTE = 'Error: listen EADDRINUSE :::3000\n    at Server.setupListenListen (node:net:1917:16)\n'.repeat(4)
const LONG_USER = LONG_DIALOG + LONG_PASTE // dialog + 资料，>100 字符
const BIG_RESULT = ('EADDRINUSE stack line '.padEnd(40, '.') + '\n').repeat(20) // >512 字符
/** 推理块标签（源码内用 unicode 转义构造，避免字面序列干扰文本工具）。 */
const THINK_OPEN = '\u003cthink\u003e'
const THINK_CLOSE = '\u003c/think\u003e'

function appendUser(session: Session, text: string): number {
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  return session.snapshotEvents().length - 1
}

function appendAssistantText(session: Session, turn: number, text: string): number {
  session.append('assistant/message', { stream: [], 
    turn,
    step: 1,
    message: createAssistantMessage({
      source: { provider: 'test', model: 'test' },
      content: [{ type: 'text', text }],
    }),
  }, { surfaceOp: 'append' })
  return session.snapshotEvents().length - 1
}

function appendAssistantWithToolCall(session: Session, turn: number, callId: string, name: string, args: string): number {
  session.append('assistant/message', { stream: [], 
    turn,
    step: 1,
    message: {
      role: 'assistant',
      id: 'am_' + callId,
      source: { kind: 'model', provider: 'test', model: 'test' },
      content: [
        { type: 'tool-call', id: callId, name, arguments: args },
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

function appendTurnStart(session: Session, turn: number): void {
  session.append('turn/start', { turn })
}

function appendTurnEnd(session: Session, turn: number, kind = 'completed'): void {
  session.append('turn/end', { turn, reason: { kind } } as never)
}

/** 标准可压轮：长 user + 大 tool result。返回关键 seq。 */
function buildCompressibleTurn(session: Session, turn: number, callId: string): { uSeq: number; rSeq: number } {
  appendTurnStart(session, turn)
  const uSeq = appendUser(session, LONG_USER)
  appendAssistantWithToolCall(session, turn, callId, 'read_file', '{"path":"log.txt"}')
  const rSeq = appendToolResult(session, turn, callId, BIG_RESULT)
  appendTurnEnd(session, turn)
  return { uSeq, rSeq }
}

interface CapturedRequest {
  url: URL | string
  body: Record<string, unknown>
}

interface DeclarerHarness {
  ctx: Context
  declarer: CiteDeclarer
  requests: CapturedRequest[]
  respond: (decisionOrText: unknown, raw?: boolean) => void
}

/** 构造被测服务：fetch 替身按脚本应答；respond() 排队下一个响应。 */
async function makeDeclarer(config: Record<string, unknown> = {}): Promise<DeclarerHarness> {
  const ctx = new Context()
  const requests: CapturedRequest[] = []
  const queue: unknown[] = []
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    requests.push({ url, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> })
    const next = queue.shift()
    if (next === undefined) throw new Error('fetch test-double: no scripted response')
    if (next instanceof Response) return next
    return new Response(JSON.stringify({
      choices: [{ message: { content: typeof next === 'string' ? next : JSON.stringify(next) } }],
      usage: { completion_tokens: 10 },
    }), { status: 200 })
  }) as typeof fetch
  const declarer = new CiteDeclarer(ctx, {
    endpoint: 'http://fake.test/v1/chat/completions',
    apiKey: 'test-key',
    model: 'test-model',
    fetchImpl,
    ...config,
  })
  return {
    ctx,
    declarer,
    requests,
    respond(decisionOrText: unknown, raw = false) {
      queue.push(raw ? String(decisionOrText) : decisionOrText)
    },
  }
}

async function makeEngine(config: Record<string, unknown> = {}): Promise<{ ctx: Context; engine: ArgpGraphEngine }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: 'cite-declarer test persona' } })
  await ctx.plugin(ArgpGraphEngine, { windowTokens: 100, retainTokens: 50, minSpanChars: 20, recencyGuard: 0, maxPasses: 16, ...config })
  return { ctx, engine: ctx.compaction as ArgpGraphEngine }
}

/** Stage-2 剪枝基线会话（与 argp-graph-engine.test.ts compact-test 同构）。 */
function buildCompactFixture(session: Session): void {
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'user anchor' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  session.append('assistant/message', { stream: [],  turn: 1, step: 1, message: createAssistantMessage({ source: { provider: 'test', model: 'test' }, content: [{ type: 'text', text: 'A1:' + 'x'.repeat(300) }] }) }, { surfaceOp: 'append' })
  session.append('assistant/message', { stream: [],  turn: 2, step: 1, message: createAssistantMessage({ source: { provider: 'test', model: 'test' }, content: [{ type: 'text', text: 'A2:' + 'y'.repeat(300) }] }) }, { surfaceOp: 'append' })
  session.append('assistant/message', { stream: [],  turn: 3, step: 1, message: createAssistantMessage({ source: { provider: 'test', model: 'test' }, content: [{ type: 'text', text: 'A3:' + 'z'.repeat(300) }] }) }, { surfaceOp: 'append' })
}

// ---------------------------------------------------------------------------
// collectDeclAtoms：窗口组成（from=当轮 U/A，to=近轮 U/R）
// ---------------------------------------------------------------------------

test('collectDeclAtoms: 窗口组成与中断轮（紧邻轮）并入', () => {
  const session = Session.create(SessionId('cd-collect'))
  // 轮 1：长 user + 大 tool result
  appendTurnStart(session, 1)
  const u1 = appendUser(session, LONG_USER)
  const a1 = appendAssistantWithToolCall(session, 1, 'c1', 'read_file', '{"path":"a"}')
  const r1 = appendToolResult(session, 1, 'c1', BIG_RESULT)
  appendTurnEnd(session, 1)
  // 轮 2：短 user + 小 tool result（门控视角全小）
  appendTurnStart(session, 2)
  const u2 = appendUser(session, '继续')
  appendAssistantWithToolCall(session, 2, 'c2', 'ls', '{}')
  const r2 = appendToolResult(session, 2, 'c2', 'short')
  appendTurnEnd(session, 2)
  // 轮 3：中断轮（aborted），含大 tool result —— 紧邻轮（closed-1）⇒ 并入轮 4 的 pass，保留为 to 端点
  appendTurnStart(session, 3)
  const u3 = appendUser(session, LONG_USER)
  appendAssistantWithToolCall(session, 3, 'c3', 'read_file', '{"path":"b"}')
  const r3 = appendToolResult(session, 3, 'c3', BIG_RESULT)
  appendTurnEnd(session, 3, 'aborted')
  // 轮 4（当轮）：长 user + A 回复
  appendTurnStart(session, 4)
  const u4 = appendUser(session, LONG_USER)
  const a4 = appendAssistantText(session, 4, '依据日志，EADDRINUSE 出现在 3000 端口。')
  appendTurnEnd(session, 4)

  const collect = collectDeclAtoms(session, 10, 100)
  assert.ok(collect !== null)
  assert.equal(collect.turn, 4)
  assert.equal(collect.interrupted, false)
  // from = 当轮 U + A（A 文本非空）
  const fromSeqs = collect.fromAtoms.map(a => a.seq).sort((a, b) => a - b)
  assert.deepEqual(fromSeqs, [u4, a4].sort((a, b) => a - b))
  assert.equal(collect.fromAtoms.every(a => a.isFrom && a.role === 'current'), true)
  // to = 近轮 U/R（含轮 1、轮 2；轮 3 中断轮为紧邻轮 ⇒ 并入保留；当轮排除）
  const toSeqs = collect.toAtoms.map(a => a.seq).sort((a, b) => a - b)
  assert.ok(toSeqs.includes(u1), '轮 1 U 在窗口')
  assert.ok(toSeqs.includes(r1), '轮 1 R 在窗口')
  assert.ok(toSeqs.includes(u2), '轮 2 短 U 也在窗口（数据原子不设长门槛）')
  assert.ok(toSeqs.includes(r2), '轮 2 小 R 也在窗口')
  assert.ok(toSeqs.includes(r3), '中断轮 3 为紧邻轮（closed-1）⇒ 并入轮 4 的 pass，R 保留')
  assert.ok(toSeqs.includes(u3), '中断轮 3 的 U 也保留（并入）')
  assert.ok(!toSeqs.includes(u4) && !toSeqs.includes(a4), '当轮原子不作 to 端点')
  assert.equal(collect.toAtoms.every(a => a.isTo && a.role === 'prior'), true)
  // 门控原子：当轮 user-long（长 U）+ tool-result（当轮无 R → 仅 U）
  assert.equal(collect.gateAtoms.length, 1)
  assert.equal(collect.gateAtoms[0]?.kind, 'user-long')
  void u1; void a1; void u2; void r2
})

test('collectDeclAtoms: 超出窗口的轮次被排除', () => {
  const session = Session.create(SessionId('cd-window'))
  // 12 轮，每轮一个大 R；窗口 10 → 轮 1 的 R 离窗口（closed=12, 窗口=2..11）
  for (let t = 1; t <= 12; t += 1) {
    appendTurnStart(session, t)
    appendUser(session, 't' + t)
    appendAssistantWithToolCall(session, t, 'c' + t, 'read_file', '{"path":"f' + t + '"}')
    appendToolResult(session, t, 'c' + t, 'R' + t + '.'.repeat(520))
    appendTurnEnd(session, t)
  }
  const collect = collectDeclAtoms(session, 10, 100)
  assert.ok(collect !== null)
  assert.ok(collect.toAtoms.length > 0)
  // 窗口轮 2..11：每轮 U+R 共 20 个原子（轮 1 排除）
  assert.equal(collect.toAtoms.length, 20)
})

// ---------------------------------------------------------------------------
// normalizeCites：信任边界
// ---------------------------------------------------------------------------

test('normalizeCites: 信任边界全字段校验 + 同对合并取最高级', () => {
  const froms = new Set([10, 11])
  const tos = new Set([3, 4])
  const out = normalizeCites([
    { fromSeq: 10, toSeq: 3, level: 'supporting' },
    { fromSeq: 10, toSeq: 3, level: 'critical' }, // 同对合并 → critical
    { fromSeq: 11, toSeq: 4, level: 'contextual' },
    { fromSeq: 99, toSeq: 3, level: 'critical' }, // from 越界
    { fromSeq: 10, toSeq: 99, level: 'critical' }, // to 越界
    { fromSeq: 10, toSeq: 10, level: 'critical' }, // 自环
    { fromSeq: 10, toSeq: 4, level: 'bogus' }, // level 非法
    { fromSeq: 1.5, toSeq: 3, level: 'critical' }, // 非整数
    'garbage', // 异形元素
  ], froms, tos)
  assert.equal(out.invalid, 6)
  assert.equal(out.cites.length, 2)
  assert.deepEqual(out.cites, [
    { fromSeq: 10, toSeq: 3, level: 'critical' },
    { fromSeq: 11, toSeq: 4, level: 'contextual' },
  ])
})

// ---------------------------------------------------------------------------
// 正常声明路径：请求形状 + 边入缓存
// ---------------------------------------------------------------------------

test('正常声明：json_schema 请求、边采纳入缓存、record 留痕', async t => {
  const h = await makeDeclarer()
  t.after(() => h.ctx.fiber.dispose())
  const session = Session.create(SessionId('cd-normal'))
  const { rSeq: r1 } = buildCompressibleTurn(session, 1, 'c1')
  const { uSeq } = buildCompressibleTurn(session, 2, 'c2')
  // to 端点 = 近轮 U/R（轮 1 的 R），当轮原子不作 to 端点
  h.respond({ cites: [{ fromSeq: uSeq, toSeq: r1, level: 'supporting' }] })

  const record = await h.declarer.declareCurrentTurn(session)
  assert.equal(record?.called, true)
  assert.equal(record?.accepted, 1)
  assert.equal(record?.invalid, 0)
  assert.equal(h.declarer.calls, 1)
  assert.equal(h.declarer.cachedEdgeCount, 1)
  assert.equal(h.requests.length, 1)
  const rf = h.requests[0]?.body['response_format'] as { type?: string; json_schema?: { strict?: boolean; name?: string } } | undefined
  assert.equal(rf?.type, 'json_schema')
  assert.equal(rf?.json_schema?.strict, true)
  assert.equal(rf?.json_schema?.name, 'argp_cite_declarer')
  // prompt 暴露 from/to 两侧 seq
  const prompt = String((h.requests[0]?.body['messages'] as { content: string }[])[0]?.content ?? '')
  assert.ok(prompt.includes(`seq=${uSeq}`), 'prompt 含当轮 U seq')
  assert.ok(prompt.includes(`seq=${r1}`), 'prompt 含上轮 R seq')
})

test('解析失败静默跳过：裸文本响应 → parse-failed、无边、不抛错', async t => {
  const h = await makeDeclarer()
  t.after(() => h.ctx.fiber.dispose())
  const session = Session.create(SessionId('cd-parse-fail'))
  buildCompressibleTurn(session, 1, 'c1')
  buildCompressibleTurn(session, 2, 'c2')
  h.respond('抱歉，我无法输出 JSON。', true)

  const record = await h.declarer.declareCurrentTurn(session)
  assert.equal(record?.called, true)
  assert.equal(record?.error, 'parse-failed')
  assert.equal(record?.accepted, undefined)
  assert.equal(h.declarer.cachedEdgeCount, 0, '无边入缓存')
  assert.equal(session.snapshotEvents().find(e => e.type === 'compaction/start'), undefined, 'declarer 零事件副作用')
})

test('response_format 被拒 → 裸 prompt 静默重试一次（compressor 同款降级）', async t => {
  const h = await makeDeclarer()
  t.after(() => h.ctx.fiber.dispose())
  const session = Session.create(SessionId('cd-retry'))
  const { rSeq: r1 } = buildCompressibleTurn(session, 1, 'c1')
  const { uSeq: u2 } = buildCompressibleTurn(session, 2, 'c2')
  h.respond(new Response(JSON.stringify({ error: 'response_format not supported' }), { status: 400, statusText: 'Bad Request' }))
  h.respond({ cites: [{ fromSeq: u2, toSeq: r1, level: 'supporting' }] })

  const record = await h.declarer.declareCurrentTurn(session)
  assert.equal(h.requests.length, 2, 'schema 请求 + 裸 prompt 重试各一次')
  assert.equal(h.requests[0]?.body['response_format'] !== undefined, true)
  assert.equal(h.requests[1]?.body['response_format'], undefined, '重试请求无 response_format')
  assert.equal(record?.accepted, 1, '重试成功后边正常入缓存')
})

// ---------------------------------------------------------------------------
// 调用门控与短路路径（孤立原子规则 / 中断 / disabled）
// ---------------------------------------------------------------------------

test('纯 dialog 轮零调用（gate-skipped）：短 user + 小回复 → 不调用、不建边', async t => {
  const h = await makeDeclarer()
  t.after(() => h.ctx.fiber.dispose())
  const session = Session.create(SessionId('cd-gate'))
  appendTurnStart(session, 1)
  appendUser(session, '在吗？')
  appendAssistantText(session, 1, '在的')
  appendTurnEnd(session, 1)

  const record = await h.declarer.declareCurrentTurn(session)
  assert.equal(record?.called, false)
  assert.equal(record?.error, 'gate-skipped')
  assert.equal(h.declarer.calls, 0, '零调用断言')
  assert.equal(h.declarer.cachedEdgeCount, 0)
})

test('中断轮零调用（interrupted-turn）：aborted 收尾即使含长 user 与大 R', async t => {
  const h = await makeDeclarer()
  t.after(() => h.ctx.fiber.dispose())
  const session = Session.create(SessionId('cd-interrupted'))
  appendTurnStart(session, 1)
  appendUser(session, LONG_USER)
  appendAssistantWithToolCall(session, 1, 'c1', 'read_file', '{"path":"a"}')
  appendToolResult(session, 1, 'c1', BIG_RESULT)
  appendTurnEnd(session, 1, 'aborted')

  const record = await h.declarer.declareCurrentTurn(session)
  assert.equal(record?.called, false)
  assert.equal(record?.error, 'interrupted-turn')
  assert.equal(h.declarer.calls, 0)
})

test('disabled（无 apiKey）→ no-endpoint 记录、零调用、零网络', async t => {
  const saved = { ds: process.env['DEEPSEEK_API_KEY'], src: process.env['ARGP_MODEL_SOURCE'] }
  delete process.env['DEEPSEEK_API_KEY']
  delete process.env['ARGP_MODEL_SOURCE']
  const ctx = new Context()
  let fetchCalled = 0
  const declarer = new CiteDeclarer(ctx, {
    fetchImpl: (async () => { fetchCalled += 1; return new Response('{}', { status: 200 }) }) as typeof fetch,
  })
  t.after(() => {
    if (saved.ds === undefined) delete process.env['DEEPSEEK_API_KEY']
    else process.env['DEEPSEEK_API_KEY'] = saved.ds
    if (saved.src === undefined) delete process.env['ARGP_MODEL_SOURCE']
    else process.env['ARGP_MODEL_SOURCE'] = saved.src
    return ctx.fiber.dispose()
  })
  const session = Session.create(SessionId('cd-disabled'))
  buildCompressibleTurn(session, 1, 'c1')

  const record = await declarer.declareCurrentTurn(session)
  assert.equal(record?.called, false)
  assert.equal(record?.error, 'no-endpoint')
  assert.equal(declarer.calls, 0)
  assert.equal(fetchCalled, 0, '零网络副作用')
})

// ---------------------------------------------------------------------------
// 验收判据 ①：50 轮合成对话边解析成功率（管线机制口径）
// ---------------------------------------------------------------------------

test('验收①：50 轮合成对话，混合响应形态下管线解析成功率 100%（≥95%）', async t => {
  const h = await makeDeclarer()
  t.after(() => h.ctx.fiber.dispose())
  const session = Session.create(SessionId('cd-50turns'))
  let parsed = 0
  let failed = 0
  let prevRSeq = -1
  for (let turn = 1; turn <= 50; turn += 1) {
    const { uSeq, rSeq } = buildCompressibleTurn(session, turn, 'c' + turn)
    if (turn === 1) {
      h.respond({ cites: [] })
    } else {
      // 当轮 U 引用上一轮 R（窗口内合法边）；三种响应形态轮换：裸 JSON / 围栏 / 推理块前缀
      const payload = JSON.stringify({ cites: [{ fromSeq: uSeq, toSeq: prevRSeq, level: turn % 2 === 0 ? 'critical' : 'supporting' }] })
      if (turn % 3 === 0) h.respond('```json\n' + payload + '\n```', true)
      else if (turn % 3 === 1) h.respond(THINK_OPEN + 'analyzing citations' + THINK_CLOSE + '\n' + payload, true)
      else h.respond(JSON.parse(payload) as unknown)
    }
    const record = await h.declarer.declareCurrentTurn(session)
    if (record !== null && record.error === undefined && record.accepted !== undefined) parsed += 1
    else failed += 1
    prevRSeq = rSeq
  }
  assert.equal(h.declarer.calls, 50, '每轮恰好一次调用')
  assert.equal(failed, 0, '无解析失败（含围栏 / 推理块前缀形态）')
  const successRate = parsed / 50
  assert.ok(successRate >= 0.95, `解析成功率 ${successRate} ≥ 95%`)
  assert.equal(h.declarer.cachedEdgeCount, 49, '轮 2..50 各 1 条边入缓存')
})

// ---------------------------------------------------------------------------
// buildInjectEdges：seq→id 映射与优雅降级
// ---------------------------------------------------------------------------

test('buildInjectEdges: seq→id 映射、离 surface 端点丢弃、空缓存返回空', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  const d = new CiteDeclarer(ctx, {
    endpoint: 'http://fake.test/v1',
    apiKey: 'k',
    fetchImpl: (async () => new Response('{}', { status: 200 })) as typeof fetch,
  })
  assert.deepEqual(d.buildInjectEdges([]), [], '空缓存 → 空数组')
  assert.deepEqual(d.buildInjectEdges([{ id: 0, seq: 5, type: 'U', turn: 1, text: '', toolCallIds: [], cites: [], citesFailed: false }]), [])
})

test('buildInjectEdges 集成：声明边经 injectEdges 进 buildGraph，inDegree 落在被引方', async t => {
  const h = await makeDeclarer()
  t.after(() => h.ctx.fiber.dispose())
  const session = Session.create(SessionId('cd-inject'))
  const { rSeq: r1 } = buildCompressibleTurn(session, 1, 'c1')
  const { uSeq: u2 } = buildCompressibleTurn(session, 2, 'c2')
  // to 端点 = 上一轮 R（窗口内合法边）
  h.respond({ cites: [{ fromSeq: u2, toSeq: r1, level: 'critical' }] })
  const record = await h.declarer.declareCurrentTurn(session)
  assert.equal(record?.accepted, 1)

  const atoms: Atom[] = [
    { id: 0, seq: r1, type: 'R', turn: 1, text: 'big result text', toolCallIds: ['c1'], cites: [], citesFailed: false },
    { id: 1, seq: u2, type: 'U', turn: 2, text: 'long user message body', toolCallIds: [], cites: [], citesFailed: false },
  ]
  const edges = h.declarer.buildInjectEdges(atoms)
  assert.deepEqual(edges, [{ from: 1, to: 0, level: 'critical' }], 'from=引用方(U id)，to=被引用方(R id)')
  // 离 surface 的 to 端点（r1 不在投影内）→ 优雅丢弃
  const degraded = h.declarer.buildInjectEdges([atoms[1]!])
  assert.deepEqual(degraded, [], '端点离 surface → 丢弃')
})

test('缓存淘汰：超过 MAX_CACHED_EDGES(512) 按插入序淘汰最旧', async t => {
  const h = await makeDeclarer()
  t.after(() => h.ctx.fiber.dispose())
  const session = Session.create(SessionId('cd-evict'))
  let firstEdgeU = -1
  let firstEdgeTo = -1
  let prevRSeq = -1
  for (let turn = 1; turn <= 514; turn += 1) {
    const { uSeq, rSeq } = buildCompressibleTurn(session, turn, 'e' + turn)
    if (turn === 1) {
      h.respond({ cites: [] })
    } else {
      if (turn === 2) { firstEdgeU = uSeq; firstEdgeTo = prevRSeq }
      // to 端点 = 上一轮 R（窗口内合法边）
      h.respond({ cites: [{ fromSeq: uSeq, toSeq: prevRSeq, level: 'supporting' }] })
    }
    await h.declarer.declareCurrentTurn(session)
    prevRSeq = rSeq
  }
  assert.equal(h.declarer.calls, 514, '每轮恰好一次调用（轮 1 门控过但 cites 为空）')
  assert.equal(h.declarer.cachedEdgeCount, 512, '缓存封顶 512')
  // 最旧边（轮 2：u2→r1）被淘汰：仅其端点 seq 在投影内 → 无输出
  const oldestAtoms: Atom[] = [
    { id: 0, seq: firstEdgeU, type: 'U', turn: 2, text: 'u2', toolCallIds: [], cites: [], citesFailed: false },
    { id: 1, seq: firstEdgeTo, type: 'R', turn: 1, text: 'r1', toolCallIds: [], cites: [], citesFailed: false },
  ]
  assert.deepEqual(h.declarer.buildInjectEdges(oldestAtoms), [], '最旧边已淘汰')
})

// ---------------------------------------------------------------------------
// F3（1.7.1）：端点已墓碑化 ⇒ 沿墓碑链重定向到当前替身
// 病灶：写入侧词表走原始日志（离场 seq 仍合法）、消费侧 idBySeq 走当前投影 ⇒ 边必丢。
// ---------------------------------------------------------------------------

test('F3: buildTombstoneRedirect 展开区间、排除自映射、同名后者胜', () => {
  const m = buildTombstoneRedirect([
    { intervals: [{ start: 18, end: 18, tombstoneSeq: 53 }, { start: 20, end: 22, tombstoneSeq: 60 }] },
    { intervals: [{ start: 53, end: 53, tombstoneSeq: 99 }, { start: 7, end: 7, tombstoneSeq: 7 }] },
  ])
  assert.equal(m.get(18), 53, '单点区间')
  assert.equal(m.get(20), 60, '多节点区间起点')
  assert.equal(m.get(21), 60, '多节点区间中段')
  assert.equal(m.get(22), 60, '多节点区间终点')
  assert.equal(m.get(53), 99, '同名 seq 后者胜（取最新替身）')
  assert.equal(m.has(7), false, 'start === tombstoneSeq ⇒ 不建自映射')
  assert.equal(m.has(19), false, '未覆盖的 seq 不入表')
})

test('F3 (1.7.1): 端点已墓碑化 ⇒ 缺省仍丢、传 redirect 命中墓碑，多跳可达且防环', async t => {
  const h = await makeDeclarer()
  t.after(() => h.ctx.fiber.dispose())
  const session = Session.create(SessionId('cd-f3-redirect'))
  const { rSeq: r1 } = buildCompressibleTurn(session, 1, 'c1')
  const { uSeq: u2 } = buildCompressibleTurn(session, 2, 'c2')
  h.respond({ cites: [{ fromSeq: u2, toSeq: r1, level: 'critical' }] })
  assert.equal((await h.declarer.declareCurrentTurn(session))?.accepted, 1, 'prerequisite: 本轮 1 条边被采纳')

  // 投影里 r1 已被墓碑（tombSeq）替换，r1 本身离场
  const tombSeq = r1 + 100
  const atoms: Atom[] = [
    { id: 0, seq: tombSeq, type: 'R', turn: 1, text: '[elided: seq=' + r1 + '; recall_pruned(' + r1 + ') for detail]', toolCallIds: ['c1'], cites: [], citesFailed: false },
    { id: 1, seq: u2, type: 'U', turn: 2, text: 'long user message body', toolCallIds: [], cites: [], citesFailed: false },
  ]
  assert.deepEqual(h.declarer.buildInjectEdges(atoms), [], '缺省不传 redirect ⇒ 保持 1.7.0 行为（端点离场即丢）')
  assert.deepEqual(
    h.declarer.buildInjectEdges(atoms, seq => (seq === r1 ? tombSeq : undefined)),
    [{ from: 1, to: 0, level: 'critical' }],
    '一跳重定向 ⇒ to 命中墓碑节点的 id',
  )

  const finalSeq = r1 + 200
  const deepAtoms: Atom[] = [
    { id: 0, seq: finalSeq, type: 'R', turn: 1, text: 'tomb', toolCallIds: ['c1'], cites: [], citesFailed: false },
    { id: 1, seq: u2, type: 'U', turn: 2, text: 'u', toolCallIds: [], cites: [], citesFailed: false },
  ]
  const chain = new Map<number, number>([[r1, tombSeq], [tombSeq, finalSeq]])
  assert.deepEqual(h.declarer.buildInjectEdges(deepAtoms, s => chain.get(s)),
    [{ from: 1, to: 0, level: 'critical' }], '两跳墓碑链可达（墓碑再被墓碑替换）')
  const cyc = new Map<number, number>([[r1, tombSeq], [tombSeq, r1]])
  assert.deepEqual(h.declarer.buildInjectEdges(deepAtoms, s => cyc.get(s)), [], '环 ⇒ 丢弃且不挂死')
})

test('F3 (1.7.1): inject 摘要新增 redirectedEdges（靠重定向才命中的边数）', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argp-cites-f3-'))
  const dumpFile = path.join(dir, 'cites.jsonl')
  const prev = process.env['ARGP_CITES_DUMP']
  t.after(() => {
    if (prev === undefined) delete process.env['ARGP_CITES_DUMP']
    else process.env['ARGP_CITES_DUMP'] = prev
    fs.rmSync(dir, { recursive: true, force: true })
  })
  process.env['ARGP_CITES_DUMP'] = dumpFile

  const h = await makeDeclarer()
  t.after(() => h.ctx.fiber.dispose())
  const session = Session.create(SessionId('cd-f3-dump'))
  const { rSeq: r1 } = buildCompressibleTurn(session, 1, 'c1')
  const { uSeq: u2 } = buildCompressibleTurn(session, 2, 'c2')
  h.respond({ cites: [{ fromSeq: u2, toSeq: r1, level: 'supporting' }] })
  await h.declarer.declareCurrentTurn(session)

  const tombSeq = r1 + 100
  const atoms: Atom[] = [
    { id: 0, seq: tombSeq, type: 'R', turn: 1, text: 'tomb', toolCallIds: ['c1'], cites: [], citesFailed: false },
    { id: 1, seq: u2, type: 'U', turn: 2, text: 'u', toolCallIds: [], cites: [], citesFailed: false },
  ]
  h.declarer.buildInjectEdges(atoms, seq => (seq === r1 ? tombSeq : undefined))

  const inj = readDump(dumpFile).filter(r => r['kind'] === 'inject').pop() as Record<string, number>
  assert.equal(inj['cacheSize'], 1)
  assert.equal(inj['emitted'], 1)
  assert.equal(inj['droppedByMissingEndpoint'], 0, '重定向后不再计入丢弃')
  assert.equal(inj['redirectedEdges'], 1, '该边靠重定向才命中')
  assert.equal((inj['emitted'] ?? 0) + (inj['droppedByMissingEndpoint'] ?? 0) + (inj['droppedBySelfLoop'] ?? 0), inj['cacheSize'],
    'redirectedEdges 是 emitted 子集，不参与该求和式')
})

// ---------------------------------------------------------------------------
// 验收判据 ②：两插件故障注入——declarer 失败不影响同轮熵降
// ---------------------------------------------------------------------------

test('验收②：declarer LLM 故障注入（重试耗尽）不影响同轮 compressor 熵降', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  const goodQueue: unknown[] = []
  const goodFetch = (async (_url: string | URL, _init?: RequestInit) => {
    const next = goodQueue.shift()
    if (next === undefined) throw new Error('no good response')
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(next) } }] }), { status: 200 })
  }) as typeof fetch
  let badCalls = 0
  const badFetch = (async () => {
    badCalls += 1
    throw new Error('injected network failure')
  }) as typeof fetch
  const compressor = new PeratomCompressor(ctx, {
    endpoint: 'http://fake.test/v1/chat/completions',
    apiKey: 'k',
    model: 'm',
    fetchImpl: goodFetch,
  })
  const declarer = new CiteDeclarer(ctx, {
    endpoint: 'http://fake.test/v1/chat/completions',
    apiKey: 'k',
    model: 'm',
    fetchImpl: badFetch,
  })

  const session = Session.create(SessionId('cd-fault'))
  const { uSeq, rSeq } = buildCompressibleTurn(session, 1, 'c1')

  // ① declarer 先声明（原始形态原子，门控通过）→ 故障注入：schema 请求失败 + 裸重试失败
  const declRecord = await declarer.declareCurrentTurn(session)
  assert.equal(declRecord?.called, true)
  assert.ok(declRecord?.error !== undefined && declRecord.error !== 'parse-failed', '网络故障记 error')
  assert.equal(badCalls, 2, '至多静默重试 1 次（共 2 次尝试）')
  assert.equal(declarer.cachedEdgeCount, 0, '故障轮无边')

  // ② 同轮熵降照常：compressor 完成 dialog replace + U-info + tool replace
  goodQueue.push({
    splits: [{ seq: uSeq, quotes: [DIALOG_QUOTE] }],
    tools: [{ seq: rSeq, level: 'extract', text: 'EADDRINUSE on port 3000; server failed to bind.' }],
  })
  const compRecord = await compressor.compressCurrentTurn(session)
  assert.equal(compRecord?.called, true)
  assert.ok(compRecord?.appliedReplaces !== undefined && compRecord.appliedReplaces >= 2, `熵降完成：appliedReplaces=${compRecord?.appliedReplaces}`)
  const kinds = session.snapshotEvents().map(e => e.type)
  const startIdx = kinds.lastIndexOf('compaction/start')
  const endIdx = kinds.lastIndexOf('compaction/end')
  assert.ok(startIdx > 0 && endIdx === kinds.length - 1, '压缩事务括号完整')

  // ③ declarer 故障状态不污染建图通道
  assert.deepEqual(declarer.buildInjectEdges([]), [], '故障后注入通道仍返回空数组（无异常）')
})

// ---------------------------------------------------------------------------
// 验收判据 ③：disabled declarer 挂载 → Stage-2 行为与基线完全一致
// ---------------------------------------------------------------------------

test('验收③：挂载 disabled declarer（injectEdges 通道）的剪枝结果与无 declarer 基线一致', async () => {
  // 基线：无 declarer
  const baseline = await makeEngine()
  const declarerCtx = new Context()
  try {
    const s1 = Session.create(SessionId('cd-eq-base'))
    buildCompactFixture(s1)
    baseline.engine.setSession(s1)
    await baseline.engine.compactIfNeeded({ session: s1 } as never, 'pressure', new AbortController().signal)
    const base = baseline.engine.records[0]
    assert.ok(base !== undefined)

    // 对照：ArgpGraphEngine + injectEdges（disabled declarer，零缓存）
    const declarer = new CiteDeclarer(declarerCtx, {
      endpoint: 'http://fake.test/v1/chat/completions',
      apiKey: 'test-key',
      fetchImpl: (async () => new Response('{}', { status: 200 })) as typeof fetch,
    })
    let channelCalls = 0
    const ctx2 = new Context()
    await mountAgentLoopTestDependencies(ctx2, { systemPrompt: { personaPrefix: 'cite-declarer eq persona' } })
    await ctx2.plugin(ArgpGraphEngine, {
      windowTokens: 100, retainTokens: 50, minSpanChars: 20, recencyGuard: 0, maxPasses: 16,
      injectEdges: (atoms: Atom[]) => { channelCalls += 1; return declarer.buildInjectEdges(atoms) },
    })
    const engine2 = ctx2.compaction as ArgpGraphEngine
    const s2 = Session.create(SessionId('cd-eq-inject'))
    buildCompactFixture(s2)
    engine2.setSession(s2)
    await engine2.compactIfNeeded({ session: s2 } as never, 'pressure', new AbortController().signal)
    const inj = engine2.records[0]
    assert.ok(inj !== undefined)
    assert.ok(channelCalls > 0, 'injectEdges 通道确实被建图调用（非旁路）')
    assert.equal(declarer.cachedEdgeCount, 0, 'disabled declarer 零边')

    // 等价断言：剪掉的原子 seq 集合 / 影子化 seq 集合 / 剩余 surface 完全一致
    const seqSet = (r: { prunedAtoms: { seq: number }[] }) => r.prunedAtoms.map(a => a.seq).sort((a, b) => a - b)
    assert.deepEqual(seqSet(inj), seqSet(base), 'pruned seq 集合一致')
    assert.deepEqual([...(inj as { shadowedSeqs: number[] }).shadowedSeqs].sort((a, b) => a - b), [...(base as { shadowedSeqs: number[] }).shadowedSeqs].sort((a, b) => a - b), 'shadowedSeqs 一致')
    assert.deepEqual([...s2.surface.nodes].sort((a, b) => a - b), [...s1.surface.nodes].sort((a, b) => a - b), '剩余 surface 节点一致')
    await ctx2.fiber.dispose()
  } finally {
    await declarerCtx.fiber.dispose()
    await baseline.ctx.fiber.dispose()
  }
})

// ---------------------------------------------------------------------------
// F1（1.7.1）：声明边落盘（env 门控 JSONL）
// ---------------------------------------------------------------------------

/** 读 dump 文件为行对象（不存在时返回 []）。 */
function readDump(file: string): Record<string, unknown>[] {
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim() !== '').map(l => JSON.parse(l) as Record<string, unknown>)
}

test('F1 (1.7.1): 未设 ARGP_CITES_DUMP ⇒ 零落盘（生产零开销契约）', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argp-cites-off-'))
  const dumpFile = path.join(dir, 'cites.jsonl')
  const prev = process.env['ARGP_CITES_DUMP']
  t.after(() => {
    if (prev === undefined) delete process.env['ARGP_CITES_DUMP']
    else process.env['ARGP_CITES_DUMP'] = prev
    fs.rmSync(dir, { recursive: true, force: true })
  })
  delete process.env['ARGP_CITES_DUMP']

  const h = await makeDeclarer()
  t.after(() => h.ctx.fiber.dispose())
  const session = Session.create(SessionId('cd-dump-off'))
  const { rSeq: r1 } = buildCompressibleTurn(session, 1, 'c1')
  const { uSeq: u2 } = buildCompressibleTurn(session, 2, 'c2')
  h.respond({ cites: [{ fromSeq: u2, toSeq: r1, level: 'supporting' }] })

  const record = await h.declarer.declareCurrentTurn(session)
  assert.equal(record?.accepted, 1, 'prerequisite: 本轮确实声明了 1 条边')
  // 建图侧也要跑一次（它是最容易漏掉门控的落盘点）
  h.declarer.buildInjectEdges([
    { id: 0, seq: r1, type: 'R', turn: 1, text: 'big result text', toolCallIds: ['c1'], cites: [], citesFailed: false },
  ])

  assert.equal(fs.existsSync(dumpFile), false, '未设 env ⇒ 不创建文件')
  assert.equal(fs.readdirSync(dir).length, 0, '未设 env ⇒ 目录内零新增文件')
})

test('F1 (1.7.1): 设 ARGP_CITES_DUMP ⇒ 边行数 = record.cites.length，inject 摘要可对账', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argp-cites-on-'))
  const dumpFile = path.join(dir, 'cites.jsonl')
  const prev = process.env['ARGP_CITES_DUMP']
  t.after(() => {
    if (prev === undefined) delete process.env['ARGP_CITES_DUMP']
    else process.env['ARGP_CITES_DUMP'] = prev
    fs.rmSync(dir, { recursive: true, force: true })
  })
  process.env['ARGP_CITES_DUMP'] = dumpFile

  const h = await makeDeclarer()
  t.after(() => h.ctx.fiber.dispose())
  const session = Session.create(SessionId('cd-dump-on'))
  const { rSeq: r1 } = buildCompressibleTurn(session, 1, 'c1')
  const { uSeq: u2 } = buildCompressibleTurn(session, 2, 'c2')
  // 一条合法边 + 一条越界边（toSeq 不在白名单 ⇒ invalid，不入 record.cites）
  h.respond({ cites: [
    { fromSeq: u2, toSeq: r1, level: 'critical' },
    { fromSeq: u2, toSeq: 999999, level: 'supporting' },
  ] })

  const record = await h.declarer.declareCurrentTurn(session)
  assert.equal(record?.accepted, 1, 'prerequisite: 1 条被采纳')
  assert.equal(record?.invalid, 1, 'prerequisite: 1 条越界')

  const atoms: Atom[] = [
    { id: 0, seq: r1, type: 'R', turn: 1, text: 'big result text', toolCallIds: ['c1'], cites: [], citesFailed: false },
    { id: 1, seq: u2, type: 'U', turn: 2, text: 'long user message body', toolCallIds: [], cites: [], citesFailed: false },
  ]
  const edges = h.declarer.buildInjectEdges(atoms)

  const rows = readDump(dumpFile)
  const citeRows = rows.filter(r => r['kind'] === 'cite')
  const injectRows = rows.filter(r => r['kind'] === 'inject')

  // ① 边行数 = record.cites.length（逐条一行）
  assert.equal(citeRows.length, record?.cites?.length, '边行数 = record.cites.length')
  assert.equal(citeRows[0]?.['turn'], record?.turn)
  assert.equal(citeRows[0]?.['fromSeq'], u2)
  assert.equal(citeRows[0]?.['toSeq'], r1)
  assert.equal(citeRows[0]?.['level'], 'critical')
  // 轮级 accepted/invalid 冗余在每条边行上（方案 §5.2：逐条带，便于单行自证）
  assert.equal(citeRows[0]?.['accepted'], record?.accepted)
  assert.equal(citeRows[0]?.['invalid'], record?.invalid)

  // ② inject 摘要：一次建图一条，且这三个数能对账"LRU 淘汰 vs 端点离场"
  assert.equal(injectRows.length, 1, '一次 buildInjectEdges 一条摘要')
  const inj = injectRows[0] as Record<string, number>
  assert.equal(inj['cacheSize'], edges.length, 'cacheSize = 缓存边数')
  assert.equal(inj['emitted'], edges.length, 'emitted = 实际产出边数')
  assert.equal((inj['emitted'] ?? 0) + (inj['droppedByMissingEndpoint'] ?? 0) + (inj['droppedBySelfLoop'] ?? 0), inj['cacheSize'],
    'emitted + dropped* 必须等于 cacheSize（无缺口）')
})

test('F1 (1.7.1): 零边轮写归因行（区分"没产边"与"产了边被丢弃"）', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argp-cites-none-'))
  const dumpFile = path.join(dir, 'cites.jsonl')
  const prev = process.env['ARGP_CITES_DUMP']
  t.after(() => {
    if (prev === undefined) delete process.env['ARGP_CITES_DUMP']
    else process.env['ARGP_CITES_DUMP'] = prev
    fs.rmSync(dir, { recursive: true, force: true })
  })
  process.env['ARGP_CITES_DUMP'] = dumpFile

  const h = await makeDeclarer()
  t.after(() => h.ctx.fiber.dispose())
  const session = Session.create(SessionId('cd-dump-none'))
  buildCompressibleTurn(session, 1, 'c1')
  buildCompressibleTurn(session, 2, 'c2')
  h.respond('抱歉，我无法输出 JSON。', true) // 解析失败 ⇒ 零边

  const record = await h.declarer.declareCurrentTurn(session)
  assert.equal(record?.error, 'parse-failed')

  const rows = readDump(dumpFile)
  const noneRows = rows.filter(r => r['kind'] === 'cite-none')
  assert.equal(noneRows.length, 1, '零边轮留一条归因行')
  assert.equal(noneRows[0]?.['error'], 'parse-failed', 'error 字段是"没产边"的分类依据')
  assert.equal(rows.filter(r => r['kind'] === 'cite').length, 0, '零边时不应有 cite 行')
})

