import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { ARG_NS } from '../src/peratom/types.ts'
import { PeratomCompressor, normalizeDecision, planReplacements } from '../src/peratom/compressor.ts'
import type { CompressDecision, CurrentTurnCollect } from '../src/peratom/compressor.ts'
import { isArgpUserInfo } from '../src/peratom/types.ts'

// ---------------------------------------------------------------------------
// 测试会话构建器
// ---------------------------------------------------------------------------

const LONG_DIALOG = '帮我修复这个报错，服务起不来了，先看日志再给出修复步骤：\n'
/** 模型逐字抄写的 dialog 片段（不含行尾换行——抄写边界即切片边界）。 */
const DIALOG_QUOTE = '帮我修复这个报错，服务起不来了，先看日志再给出修复步骤：'
const LONG_PASTE = 'Error: listen EADDRINUSE :::3000\n    at Server.setupListenListen (node:net:1917:16)\n'.repeat(4)
const LONG_USER = LONG_DIALOG + LONG_PASTE // dialog + 资料，>100 字符

function appendUser(session: Session, text: string): number {
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  return session.events.length - 1
}

function appendAssistantWithToolCall(session: Session, turn: number, callId: string, name: string, args: string): number {
  session.append('assistant/message', {
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
  return session.events.length - 1
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
  return session.events.length - 1
}

function appendTurnEnd(session: Session, turn: number, kind = 'completed'): void {
  session.append('turn/end', { turn, reason: { kind } } as never)
}

/** 标准可压轮：长 user + 大 tool result。返回关键 seq。 */
function buildCompressibleTurn(session: Session, turn: number, callId: string): { uSeq: number; rSeq: number } {
  session.append('turn/start', { turn })
  const uSeq = appendUser(session, LONG_USER)
  appendAssistantWithToolCall(session, turn, callId, 'read_file', '{"path":"log.txt"}')
  const rSeq = appendToolResult(session, turn, callId, ('EADDRINUSE stack line '.padEnd(40, '.') + '\n').repeat(20))
  appendTurnEnd(session, turn)
  return { uSeq, rSeq }
}

interface CapturedRequest {
  url: URL | string
  body: Record<string, unknown>
}

interface Harness {
  ctx: Context
  compressor: PeratomCompressor
  requests: CapturedRequest[]
  respond: (decisionOrText: unknown, raw?: boolean) => void
}

/** 构造被测服务：fetch 替身按脚本应答；respond() 排队下一个响应。 */
async function makeHarness(config: Record<string, unknown> = {}): Promise<Harness> {
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
  const compressor = new PeratomCompressor(ctx, {
    endpoint: 'http://fake.test/v1/chat/completions',
    apiKey: 'test-key',
    model: 'test-model',
    fetchImpl,
    ...config,
  })
  return {
    ctx,
    compressor,
    requests,
    respond(decisionOrText: unknown, raw = false) {
      queue.push(raw ? String(decisionOrText) : decisionOrText)
    },
  }
}

async function dispose(h: Harness): Promise<void> {
  await h.ctx.fiber.dispose()
}

// ---------------------------------------------------------------------------
// 调用门控：纯 dialog / 中断轮 → 零调用
// ---------------------------------------------------------------------------

test('纯对话轮零调用（调用计数器断言）：短 user + 回复不触发任何 LLM 调用与事件追加', async t => {
  const h = await makeHarness()
  t.after(() => dispose(h))
  const session = Session.create(SessionId('pc-pure-dialog'))
  session.append('turn/start', { turn: 1 })
  appendUser(session, '在吗？')
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: {
      role: 'assistant',
      id: 'am_plain1',
      source: { kind: 'model', provider: 't', model: 't' },
      content: [{ type: 'text', text: '在的' }],
    },
  } as never, { surfaceOp: 'append' })
  appendTurnEnd(session, 1)

  const genBefore = session.surface.replaceGeneration
  const eventsBefore = session.events.length
  const record = await h.compressor.compressCurrentTurn(session)

  assert.equal(record?.called, false)
  assert.equal(h.compressor.calls, 0, '零调用断言')
  assert.equal(session.events.length, eventsBefore, '无任何事件追加')
  assert.equal(session.surface.replaceGeneration, genBefore)
})

test('中断轮零调用：turn/end aborted 的轮次整轮排除，即使含长 user 与大 tool result', async t => {
  const h = await makeHarness()
  t.after(() => dispose(h))
  const session = Session.create(SessionId('pc-interrupted'))
  session.append('turn/start', { turn: 1 })
  appendUser(session, LONG_USER)
  appendAssistantWithToolCall(session, 1, 'c-x', 'read_file', '{"path":"a"}')
  appendToolResult(session, 1, 'c-x', 'x'.repeat(600))
  appendTurnEnd(session, 1, 'aborted')

  const collect = h.compressor.collectCurrentTurn(session)
  assert.equal(collect?.interrupted, true)
  assert.equal(collect?.userLong.length, 0, '中断过滤内嵌于 collectCurrentTurn')
  assert.equal(collect?.toolResults.length, 0)

  const record = await h.compressor.compressCurrentTurn(session)
  assert.equal(record?.called, false)
  assert.equal(record?.skipReason, 'interrupted', '中断轮单独标记，与门控 no-candidate 区分')
  assert.equal(h.compressor.calls, 0)
  assert.equal(session.events.find(e => e.type === 'compaction/start'), undefined, '无事务')
})

test('assistant/message.interrupted 直挂标记同样使轮次排除（rc.2 流中取消前缀）', async t => {
  const h = await makeHarness()
  t.after(() => dispose(h))
  const session = Session.create(SessionId('pc-am-interrupted'))
  session.append('turn/start', { turn: 1 })
  appendUser(session, LONG_USER)
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: {
      role: 'assistant',
      id: 'am_i2',
      source: { kind: 'model', provider: 't', model: 't' },
      content: [{ type: 'text', text: 'partial' }],
    },
    interrupted: true,
  } as never, { surfaceOp: 'append' })
  appendToolResult(session, 1, 'c-i', 'y'.repeat(600))
  appendTurnEnd(session, 1, 'aborted')

  const collect = h.compressor.collectCurrentTurn(session)
  assert.equal(collect?.interrupted, true)
})

// ---------------------------------------------------------------------------
// 正常压缩事务：单次调用覆盖当轮全部可压原子 + 双事件发射 + 断言
// ---------------------------------------------------------------------------

test('可压轮单次调用：dialog replace + U-info append 双事件、tool replace 副本、事务括号与断言全过', async t => {
  const h = await makeHarness()
  t.after(() => dispose(h))
  const session = Session.create(SessionId('pc-normal'))
  const { uSeq, rSeq } = buildCompressibleTurn(session, 1, 'c1')

  const extractText = 'EADDRINUSE on port 3000 at net:1917; server failed to bind.'
  h.respond({
    splits: [{ seq: uSeq, quotes: [DIALOG_QUOTE] }],
    tools: [{ seq: rSeq, level: 'extract', text: extractText }],
  })

  const genBefore = session.surface.replaceGeneration
  const record = await h.compressor.compressCurrentTurn(session)

  assert.equal(h.compressor.calls, 1, '单次调用覆盖当轮全部可压原子')
  assert.equal(record?.called, true)
  assert.equal(record?.parseFailed, undefined)
  assert.equal(record?.appliedReplaces, 2, 'dialog replace + tool replace')

  // 请求形状：JSON Schema 强制输出
  assert.equal(h.requests.length, 1)
  const rf = h.requests[0]?.body['response_format'] as { type?: string; json_schema?: { strict?: boolean; name?: string } } | undefined
  assert.equal(rf?.type, 'json_schema')
  assert.equal(rf?.json_schema?.strict, true)
  assert.equal(rf?.json_schema?.name, 'argp_peratom_turn')

  // 事务括号：compaction/start..end 配对且 end 无 error
  const kinds = session.events.map(e => e.type)
  const startIdx = kinds.lastIndexOf('compaction/start')
  const endIdx = kinds.lastIndexOf('compaction/end')
  assert.ok(startIdx > 0 && endIdx === kinds.length - 1, `start..end 括号收尾：${kinds.slice(-4).join(',')}`)
  assert.equal((session.events[endIdx]?.data as { error?: string }).error, undefined)

  // 事件 ①：dialog replace（原位替换，plugin 署名，无 ARG_NS 标记）
  const dialogEvent = session.events[endIdx! - 3]
  assert.equal(dialogEvent?.type, 'user/message')
  const dData = dialogEvent?.data as unknown as { source?: { plugin?: string }; content?: { text: string }[]; [k: string]: unknown }
  assert.equal(dData.source?.plugin, 'dsh-argp')
  assert.equal(isArgpUserInfo(dData), false, 'dialog 副本不带 info 标记（永不剪）')
  assert.deepEqual((dialogEvent as unknown as { surfaceOp: { op: string; start: number; end: number } }).surfaceOp, { op: 'replace', start: uSeq, end: uSeq })
  assert.deepEqual(dialogEvent?.sourceEventSeqs, [uSeq])
  const expectedDialog = DIALOG_QUOTE
  assert.equal(
    (dData.content as { text: string }[])?.[0]?.text,
    expectedDialog,
    'dialog 文本 = 抄写片段拼接',
  )

  // 事件 ②：U-info append（info 标记 + sourceSeq + summary）
  const infoEvent = session.events[endIdx! - 2]
  assert.equal(infoEvent?.type, 'user/message')
  const iData = infoEvent?.data as unknown as { [k: string]: unknown }
  assert.equal(isArgpUserInfo(iData), true, 'U-info 标记落盘')
  const meta = iData[ARG_NS] as { info: boolean; sourceSeq: number; summary: string }
  assert.equal(meta.info, true)
  assert.equal(meta.sourceSeq, uSeq)
  assert.ok(meta.summary.includes('EADDRINUSE'), 'summary = info 聚合文本')
  assert.equal(infoEvent?.surfaceOp, 'append')

  // 事件 ③：tool replace 副本（dsh-session 硬约束：只许改 content，故无 ARG_NS 元数据）
  const toolEvent = session.events[endIdx! - 1]
  assert.equal(toolEvent?.type, 'tool/result')
  const tData = toolEvent?.data as unknown as {
    message?: { content?: { toolCallId?: string; content?: { text: string }[] }[] }
    [k: string]: unknown
  }
  assert.equal(tData.message?.content?.[0]?.content?.[0]?.text, extractText)
  assert.equal(tData.message?.content?.[0]?.toolCallId, 'c1', 'callId 配对语义保持')
  assert.equal(ARG_NS in tData, false, 'tool/result replace 只允许改 content（多键即被宿主拒绝）')
  assert.deepEqual((toolEvent as unknown as { surfaceOp: { op: string; start: number } }).surfaceOp.op, 'replace')

  // 断言已在 flush 内联执行（未抛错）；replaceGeneration 增量 = 2 个 replace
  assert.equal(session.surface.replaceGeneration - genBefore, 2)
  // 原文仍在 append-only 日志（防干涉底座）
  assert.ok((session.events[uSeq]!.data as { content: { text: string }[] }).content[0]!.text.includes('EADDRINUSE'), '原始 user 全文留日志')
  assert.equal(
    (session.events[rSeq]!.data as { message: { content: { content: { text: string }[] }[] } }).message.content[0]!.content[0]!.text.length,
    ('EADDRINUSE stack line '.padEnd(40, '.') + '\n').repeat(20).length,
    '原始 tool result verbatim 留日志',
  )
})

test('两段式发射：prepareCurrentTurn 只暂存不落盘，flushStashed 才开发务括号', async t => {
  const h = await makeHarness()
  t.after(() => dispose(h))
  const session = Session.create(SessionId('pc-two-phase'))
  const { rSeq } = buildCompressibleTurn(session, 1, 'c1')
  h.respond({ splits: [], tools: [{ seq: rSeq, level: 'extract', text: 'EADDRINUSE short extract' }] })

  const eventsBefore = session.events.length
  const record = await h.compressor.prepareCurrentTurn(session)
  assert.equal(record?.called, true)
  assert.equal(h.compressor.calls, 1)
  assert.equal(session.events.length, eventsBefore, 'idle 阶段不动日志（tool/result replace 需 open turn）')

  h.compressor.flushStashed(session)
  const kinds = session.events.map(e => e.type)
  assert.ok(kinds.includes('compaction/start') && kinds[kinds.length - 1] === 'compaction/end', 'pre-step 窗口发射事务')

  // 异形 decision（seq 未收集）→ 无可落地动作 → 不开空事务
  const session2 = Session.create(SessionId('pc-two-phase-empty'))
  buildCompressibleTurn(session2, 1, 'd1')
  h.respond({ splits: [{ seq: 9999, quotes: [] }], tools: [] }) // 异形 seq 全部丢弃
  await h.compressor.prepareCurrentTurn(session2)
  h.compressor.flushStashed(session2)
  assert.equal(session2.events.filter(e => e.type === 'compaction/start').length, 0, '零动作不开发务括号')
})

// ---------------------------------------------------------------------------
// 保守路径：fallback-dialog / 解析失败 / 防重复 / 无再压缩
// ---------------------------------------------------------------------------

test('定位失败整条回退 dialog：该消息零替换，tool 照常压缩，计数入 skippedFallbackDialog', async t => {
  const h = await makeHarness()
  t.after(() => dispose(h))
  const session = Session.create(SessionId('pc-fallback'))
  const { uSeq, rSeq } = buildCompressibleTurn(session, 1, 'c1')
  h.respond({
    splits: [{ seq: uSeq, quotes: ['彻底编造的抄写片段'] }],
    tools: [{ seq: rSeq, level: 'summary', text: 'EADDRINUSE 端口占用错误。' }],
  })

  const record = await h.compressor.compressCurrentTurn(session)
  assert.equal(record?.skippedFallbackDialog, 1)
  assert.equal(record?.appliedReplaces, 1, '仅 tool replace')

  const kinds = session.events.map(e => e.type)
  const endIdx = kinds.lastIndexOf('compaction/end')
  // user 原位未被替换：end 前只有 tool/result 一个 replace 事件
  let userReplaces = 0
  for (let i = endIdx! - 1; i >= 0; i -= 1) {
    const ev = session.events[i]!
    if (ev.type === 'compaction/start') break
    if (ev.type === 'user/message') userReplaces += 1
  }
  assert.equal(userReplaces, 0, '保真不变式：回退消息不留副本')
})

test('解析失败静默跳过：parseFailed 记账、零事件、不抛错', async t => {
  const h = await makeHarness()
  t.after(() => dispose(h))
  const session = Session.create(SessionId('pc-parse-fail'))
  buildCompressibleTurn(session, 1, 'c1')
  h.respond('模型走神输出的非 JSON 文本 <think>思考</think> 还是没有 JSON', true)

  const record = await h.compressor.compressCurrentTurn(session)
  assert.equal(record?.called, true)
  assert.equal(record?.parseFailed, true)
  assert.equal(h.compressor.calls, 1)
  assert.equal(session.events.filter(e => e.type.startsWith('compaction/')).length, 0, '零事务')
})

test('response_format 被拒时降级裸 prompt 重试一次并成功解析', async t => {
  const h = await makeHarness()
  t.after(() => dispose(h))
  const session = Session.create(SessionId('pc-degrade'))
  const { uSeq } = buildCompressibleTurn(session, 1, 'c1')
  // 第一响应：HTTP 400（端点不支持 response_format）；第二响应：合法 JSON（走裸 prompt 队列）
  h.respond(new Response('{"error":{"message":"response_format unsupported"}}', { status: 400 }))
  h.respond({ splits: [{ seq: uSeq, quotes: [DIALOG_QUOTE] }], tools: [] })

  const record = await h.compressor.compressCurrentTurn(session)
  assert.equal(h.requests.length, 2, 'schema 失败后恰好一次降级重试')
  assert.notEqual(h.requests[0]?.body['response_format'], undefined, '首次带 JSON Schema 强制输出')
  assert.equal(h.requests[1]?.body['response_format'], undefined, '重试为裸 prompt（spike 30/32 兼容模式）')
  assert.equal(record?.anomalies, 1, '降级计入 anomalies')
  assert.equal(record?.parseFailed, undefined)
  assert.equal(record?.appliedReplaces, 1, 'dialog replace 落地（U-info append 不计 replaces）')
})

test('防重复 turn 处理：同一轮第二次 compress 直接跳过（不再调用不再发射）', async t => {
  const h = await makeHarness()
  t.after(() => dispose(h))
  const session = Session.create(SessionId('pc-dedupe'))
  const { uSeq, rSeq } = buildCompressibleTurn(session, 1, 'c1')
  h.respond({ splits: [], tools: [{ seq: rSeq, level: 'extract', text: 'kept short' }] })

  const first = await h.compressor.compressCurrentTurn(session)
  assert.equal(first?.called, true)
  const callsAfterFirst = h.compressor.calls
  const eventsAfterFirst = session.events.length

  const second = await h.compressor.compressCurrentTurn(session)
  assert.equal(second, null, '记账命中 → null')
  assert.equal(h.compressor.calls, callsAfterFirst)
  assert.equal(session.events.length, eventsAfterFirst)
  void uSeq
})

test('版本链成员硬排除：同键 tool result 不进 collect.toolResults；仅剩链成员时零调用', async t => {
  const h = await makeHarness()
  t.after(() => dispose(h))
  const session = Session.create(SessionId('pc-chain'))
  // 轮 1：读 a.ts（建立链首）
  session.append('turn/start', { turn: 1 })
  appendAssistantWithToolCall(session, 1, 'old', 'read_file', '{"path":"same.ts"}')
  appendToolResult(session, 1, 'old', 'v1')
  appendTurnEnd(session, 1)
  // 轮 2：再次读 same.ts —— 新快照也是链成员（保守口径），且无长 user
  session.append('turn/start', { turn: 2 })
  appendUser(session, 'short question')
  appendAssistantWithToolCall(session, 2, 'new', 'read_file', '{"path":"same.ts"}')
  appendToolResult(session, 2, 'new', 'v2')
  appendTurnEnd(session, 2)
  const collect = h.compressor.collectCurrentTurn(session)
  assert.equal(collect?.turn, 2)
  assert.equal(collect?.toolResults.length, 0, '链成员硬排除')

  const record = await h.compressor.compressCurrentTurn(session)
  assert.equal(record?.called, false, '仅链成员 → 门控 false → 零调用')
  assert.equal(h.compressor.calls, 0)
})

test('setToolPolicy（tool 对照表）：按工具名改档即时影响 collect；撤销回启发式；shell 未声明走启发式', async t => {
  const h = await makeHarness()
  t.after(() => dispose(h))
  const session = Session.create(SessionId('pc-toolpolicy'))
  const big = ('EADDRINUSE stack line at net:1917 '.repeat(10) + '\n').repeat(2) // >512 字符

  // 轮 1：大 read_file 结果。collectCurrentTurn 只取"最新闭合轮"，故逐轮 collect。
  session.append('turn/start', { turn: 1 })
  appendUser(session, 'short')
  appendAssistantWithToolCall(session, 1, 'c1', 'read_file', '{"path":"a.ts"}')
  appendToolResult(session, 1, 'c1', big)
  appendTurnEnd(session, 1)

  // 场景 1：read_file 声明 false → 大结果被对照表拦下，不进候选
  h.compressor.setToolPolicy('read_file', false)
  assert.equal(h.compressor.getToolPolicy('read_file'), false)
  let collect = h.compressor.collectCurrentTurn(session)
  assert.equal(collect?.turn, 1)
  assert.equal(collect?.toolResults.length, 0, '对照表 read_file→false 拦下大结果')

  // 场景 2：撤销声明 → 回启发式，同一轮的大结果重新进候选（且 toolName 已挂上）
  h.compressor.setToolPolicy('read_file', undefined)
  assert.equal(h.compressor.getToolPolicy('read_file'), undefined)
  collect = h.compressor.collectCurrentTurn(session)
  assert.equal(collect?.turn, 1)
  assert.equal(collect?.toolResults.length, 1, '撤销后回启发式 extract')
  assert.equal(collect?.toolResults[0]?.toolName, 'read_file', 'toolName 经 callId 反查挂上原子')

  // 场景 3：shell 类工具不声明（设计：异构输出不预设）→ 走启发式；大结果 extract、小结果 false
  session.append('turn/start', { turn: 2 })
  appendUser(session, 'short')
  appendAssistantWithToolCall(session, 2, 'c2', 'bash', '{"cmd":"ls -la /tmp"}')
  appendToolResult(session, 2, 'c2', big) // 大 shell 输出
  appendTurnEnd(session, 2)
  assert.equal(h.compressor.getToolPolicy('bash'), undefined, '从未声明 bash（不预设）')
  collect = h.compressor.collectCurrentTurn(session)
  assert.equal(collect?.turn, 2)
  assert.equal(collect?.toolResults.length, 1, '未声明 bash 大输出 → 启发式 extract（安全网兜底）')
  assert.equal(collect?.toolResults[0]?.toolName, 'bash')
})

test('无再压缩路径：U-info 副本 / checkpoint 不进候选（决策⑦）', async t => {
  const h = await makeHarness()
  t.after(() => dispose(h))
  const session = Session.create(SessionId('pc-no-recompress'))
  // 当轮含一条已压缩的 U-info 副本与一条 checkpoint
  session.append('turn/start', { turn: 1 })
  const base = createUserMessage({ content: [{ type: 'text', text: '很长的资料聚合副本'.repeat(30) }], source: { kind: 'plugin', plugin: 'dsh-argp' } })
  session.append('user/message', { ...base, [ARG_NS]: { info: true, sourceSeq: 1, summary: 's' } } as never, { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: {
      role: 'assistant',
      id: 'am_nr1',
      source: { kind: 'model', provider: 't', model: 't' },
      content: [{ type: 'text', text: 'ok' }],
    },
  } as never, { surfaceOp: 'append' })
  appendTurnEnd(session, 1)

  const collect = h.compressor.collectCurrentTurn(session)
  assert.equal(collect?.userLong.length, 0, 'U-info/checkpoint 一律跳过')
  const record = await h.compressor.compressCurrentTurn(session)
  assert.equal(record?.called, false)
})

// ---------------------------------------------------------------------------
// 引擎侧规划纯函数：信任边界 + resolveSplit 策略裁决
// ---------------------------------------------------------------------------

test('planReplacements：seq 未收集/重复出现计 anomaly 先到先得；info-only 整条 U-info replace', () => {
  const collect: CurrentTurnCollect = {
    turn: 1,
    startSeq: 0,
    endSeq: 5,
    interrupted: false,
    userLong: [{ kind: 'user-long', seq: 0, turn: 1, text: '指令A：粘贴资料粘贴资料' }],
    toolResults: [],
  }
  const decision: CompressDecision = {
    splits: [
      { seq: 99, quotes: ['x'] }, // 未收集 seq → anomaly
      { seq: 0, quotes: [] },     // info-only：整条 U-info
      { seq: 0, quotes: ['指'] }, // 重复 seq → anomaly，先到先得
    ],
    tools: [],
  }
  const plan = planReplacements(collect, decision, [])
  assert.equal(plan.anomalies, 2)
  assert.equal(plan.steps.length, 1)
  assert.equal(plan.replaces, 1)
  const step = plan.steps[0]!
  assert.equal(step.kind, 'replace')
  const data = step.data as { [k: string]: unknown }
  assert.equal(isArgpUserInfo(data), true, 'info-only → U-info replace 副本')
})

test('planReplacements：保真守卫——缺高信号 token 的 extract 被拒绝（原文保面），全含则放行', () => {
  const toolText = 'Error ERR_CACHE_EVICTION_0x1F4 at src/cache/lru.ts:141:19 victim=txn#8821 budget 256MiB'
  const collect: CurrentTurnCollect = {
    turn: 1,
    startSeq: 0,
    endSeq: 5,
    interrupted: false,
    userLong: [],
    toolResults: [{ kind: 'tool-result', seq: 5, turn: 1, text: toolText, callId: 'c9' }],
  }
  // 转述丢 token：错误码没了、kv 分隔符被改写 → 拒绝
  const bad = planReplacements(
    collect,
    { splits: [], tools: [{ seq: 5, level: 'extract', text: 'cache eviction at lru.ts 141 line for txn 8821' }] },
    [],
  )
  assert.equal(bad.steps.length, 0)
  assert.equal(bad.skippedFidelity, 1)

  // 高信号串 verbatim 全含 → 放行（需提供原始事件供副本构造）
  const origEvent = {
    type: 'tool/result',
    seq: 5,
    time: 0,
    surfaceOp: 'append',
    data: {
      message: {
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: 'c9', content: [{ type: 'text', text: toolText }], isError: false }],
        source: { kind: 'tool', callId: 'c9' },
      },
    },
  } as never
  const good = planReplacements(
    collect,
    { splits: [], tools: [{ seq: 5, level: 'extract', text: 'ERR_CACHE_EVICTION_0x1F4 at src/cache/lru.ts:141:19 victim=txn#8821' }] },
    [origEvent],
  )
  assert.equal(good.steps.length, 1)
  assert.equal(good.skippedFidelity, 0)
})

test('planReplacements：split 解析产出 dialog replace + U-info append 两步，sourceEventSeqs 指向原文', () => {
  const text = '先看A：AAA资料BBB再看B：'
  const collect: CurrentTurnCollect = {
    turn: 1,
    startSeq: 3,
    endSeq: 3,
    interrupted: false,
    userLong: [{ kind: 'user-long', seq: 3, turn: 1, text }],
    toolResults: [],
  }
  const plan = planReplacements(
    collect,
    { splits: [{ seq: 3, quotes: ['先看A：', '再看B：'] }], tools: [] },
    [],
  )
  assert.equal(plan.steps.length, 2)
  assert.equal(plan.replaces, 1)
  const [dialog, info] = plan.steps as unknown as [{ kind: string; sourceEventSeqs: number[]; at: number }, { kind: string; sourceEventSeqs: number[] }]
  assert.equal(dialog.kind, 'replace')
  assert.equal(dialog.at, 3)
  assert.deepEqual(dialog.sourceEventSeqs, [3])
  assert.equal(info.kind, 'append')
  assert.deepEqual(info.sourceEventSeqs, [3])
})

// ---------------------------------------------------------------------------
// info 压缩（设计 §10 决策 1 补实现）：infoLevel/infoText 契约 + 保真守卫 + 单档落盘
// ---------------------------------------------------------------------------

const INFO_SPLIT_TEXT = '检查A：Error EADDRINUSE at src/cache/lru.ts:141:19 victim=txn#8821检查B：'
const INFO_RAW = 'Error EADDRINUSE at src/cache/lru.ts:141:19 victim=txn#8821'
const INFO_COLLECT: CurrentTurnCollect = {
  turn: 1,
  startSeq: 3,
  endSeq: 3,
  interrupted: false,
  userLong: [{ kind: 'user-long', seq: 3, turn: 1, text: INFO_SPLIT_TEXT }],
  toolResults: [],
}

test('normalizeDecision：splits 透传 infoLevel/infoText；异形档位与 summary 空文本弃档（回退逐字）', () => {
  const d = normalizeDecision({
    splits: [
      { seq: 1, quotes: ['a'], infoLevel: 'extract', infoText: 'EADDRINUSE' },
      { seq: 2, quotes: ['b'], infoLevel: 'summary', infoText: '概括' },
      { seq: 3, quotes: ['c'], infoLevel: 'false', infoText: '' },
      { seq: 4, quotes: ['d'], infoLevel: 'nonsense', infoText: 'x' },
      { seq: 5, quotes: ['e'], infoLevel: 'summary', infoText: '' },
    ],
    tools: [],
  })
  assert.deepEqual(d?.splits[0], { seq: 1, quotes: ['a'], infoLevel: 'extract', infoText: 'EADDRINUSE' })
  assert.deepEqual(d?.splits[1], { seq: 2, quotes: ['b'], infoLevel: 'summary', infoText: '概括' })
  assert.deepEqual(d?.splits[2], { seq: 3, quotes: ['c'], infoLevel: 'false', infoText: '' })
  assert.deepEqual(d?.splits[3], { seq: 4, quotes: ['d'], infoLevel: undefined, infoText: 'x' }, '异形档位 → undefined（planReplacements 回退逐字）')
  assert.deepEqual(d?.splits[4], { seq: 5, quotes: ['e'], infoLevel: 'summary', infoText: undefined }, 'summary 空压缩文本 → undefined')
})

test('planReplacements：infoLevel=extract 全含高信号 token → U-info 节点 = 压缩 infoText（非逐字），单档 summary 元数据', () => {
  const plan = planReplacements(
    INFO_COLLECT,
    { splits: [{ seq: 3, quotes: ['检查A：', '检查B：'], infoLevel: 'extract', infoText: INFO_RAW }], tools: [] },
    [],
  )
  assert.equal(plan.steps.length, 2)
  assert.equal(plan.skippedFidelity, 0)
  const info = plan.steps[1] as { kind: string; data: { content?: { text: string }[]; [k: string]: unknown } }
  assert.equal(info.kind, 'append')
  assert.equal(info.data.content?.[0]?.text, INFO_RAW, 'info 节点 = 模型压缩 extract 文本')
  const meta = info.data[ARG_NS] as { info: boolean; sourceSeq: number; summary: string }
  assert.equal(meta.summary, INFO_RAW, '单档：ARG_NS.summary = surface 压缩态')
})

test('planReplacements：info extract 缺高信号 token → 回退逐字（原文保面），skippedFidelity 记账', () => {
  const plan = planReplacements(
    INFO_COLLECT,
    { splits: [{ seq: 3, quotes: ['检查A：', '检查B：'], infoLevel: 'extract', infoText: 'cache eviction at lru.ts line 141 for txn 8821' }], tools: [] },
    [],
  )
  assert.equal(plan.skippedFidelity, 1, '缺 token 的 extract 被拒')
  assert.ok(plan.fidelityMissing.includes('EADDRINUSE'), '缺失清单含错误码')
  const info = plan.steps[1] as { data: { content?: { text: string }[] } }
  assert.equal(info.data.content?.[0]?.text, INFO_RAW, '回退逐字 info（错误方向只往少压错）')
})

test('planReplacements：info summary 丢精确串 → 审计放行（summaryDropped 入账，压缩文本仍落盘）', () => {
  const plan = planReplacements(
    INFO_COLLECT,
    { splits: [{ seq: 3, quotes: ['检查A：', '检查B：'], infoLevel: 'summary', infoText: 'lru 缓存淘汰触发绑定失败' }], tools: [] },
    [],
  )
  assert.equal(plan.skippedFidelity, 0, 'summary 不硬拒')
  assert.ok(plan.summaryDropped.includes('EADDRINUSE'), '缺失精确串入审计账')
  const info = plan.steps[1] as { data: { content?: { text: string }[] } }
  assert.equal(info.data.content?.[0]?.text, 'lru 缓存淘汰触发绑定失败', 'summary 压缩文本落盘')
})

test('planReplacements：infoLevel=false / 缺省 → info 逐字保留（原文切片回退）', () => {
  const text = '先看A：AAA资料BBB再看B：'
  const collect: CurrentTurnCollect = {
    turn: 1,
    startSeq: 3,
    endSeq: 3,
    interrupted: false,
    userLong: [{ kind: 'user-long', seq: 3, turn: 1, text }],
    toolResults: [],
  }
  const withFalse = planReplacements(
    collect,
    { splits: [{ seq: 3, quotes: ['先看A：', '再看B：'], infoLevel: 'false', infoText: '' }], tools: [] },
    [],
  )
  assert.equal((withFalse.steps[1] as { data: { content?: { text: string }[] } }).data.content?.[0]?.text, 'AAA资料BBB', 'false → 逐字')
  const omitted = planReplacements(
    collect,
    { splits: [{ seq: 3, quotes: ['先看A：', '再看B：'] }], tools: [] },
    [],
  )
  assert.equal((omitted.steps[1] as { data: { content?: { text: string }[] } }).data.content?.[0]?.text, 'AAA资料BBB', '缺省 → 逐字')
})

test('端到端：split 带 infoLevel=extract → U-info 节点落盘压缩文本（非逐字），事务与断言全过', async t => {
  const h = await makeHarness()
  t.after(() => dispose(h))
  const session = Session.create(SessionId('pc-info-extract-e2e'))
  const { uSeq, rSeq } = buildCompressibleTurn(session, 1, 'c1')
  const compressedInfo = 'EADDRINUSE :::3000 at node:net:1917'
  h.respond({
    splits: [{ seq: uSeq, quotes: [DIALOG_QUOTE], infoLevel: 'extract', infoText: compressedInfo }],
    tools: [{ seq: rSeq, level: 'extract', text: 'EADDRINUSE stack' }],
  })
  const record = await h.compressor.compressCurrentTurn(session)
  assert.equal(record?.appliedReplaces, 2, 'dialog replace + tool replace')
  const kinds = session.events.map(e => e.type)
  const endIdx = kinds.lastIndexOf('compaction/end')
  const infoEvent = session.events[endIdx! - 2]
  assert.equal(infoEvent?.type, 'user/message')
  const iData = infoEvent?.data as unknown as { content?: { text: string }[]; [k: string]: unknown }
  assert.equal(iData.content?.[0]?.text, compressedInfo, 'U-info surface = 模型压缩 extract 文本')
  const meta = iData[ARG_NS] as { summary: string }
  assert.equal(meta.summary, compressedInfo, '单档 summary 元数据 = 压缩文本')
  assert.equal(infoEvent?.surfaceOp, 'append')
})
