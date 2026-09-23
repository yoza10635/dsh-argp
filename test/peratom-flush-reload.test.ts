/**
 * Issue #2 修复验证：peratom flushEntry 的 compaction/summary 发射契约。
 *
 * 背景（Issue #2 根因）：旧 flushEntry 先发 replace 循环、**后**发 compaction/summary，
 * 且 shadowedSeqs 只平铺真正被替换的**离散**原子（plan.steps 的 user-then-tool 序，
 * 非 surface 连续切片）。宿主加载期校验（dsh-compaction invariant 的
 * `validateShadowedSeqs` / v3-to-v4 `Relationships.span()`）要求 summary 的
 * shadowedSeqs 在**发出时刻**逐字等于 [shadowedRange.start, shadowedRange.end] 对应的
 * **当前 surface 连续切片**——旧实现双重违约 ⇒ 写入侧不校验 compaction/* 故落盘静默
 * 成功、重启加载才炸（会话打不开）。
 *
 * 修法（见 src/peratom/flush.ts flushEntry）：summary 移到 replace 循环**之前**
 * （发出时刻整轮窗口仍完整），shadowedSeqs 取整轮收集窗口的连续 surface 切片
 * （surface 顺序），离散性被"整窗"吸收；加防御自检（窗口非有效 span / 覆盖受保护
 * system head ⇒ throw，catch 落带 error 的 end，不发坏 summary）。
 *
 * 两层测试（Issue #2 明确要求，不可互相替代）：
 *  ① 单测：stub host + 真 Session，**直接调 flushEntry**，断言发射顺序
 *     compaction/start → compaction/summary → replace → compaction/end，
 *     且 summary.shadowedSeqs = 发出时刻整轮窗口连续切片。
 *  ② 回归：真 PeratomCompressor 端到端 flush（collect→LLM→flushEntry）→ 全事件流经
 *     宿主 surface 重放 + validateShadowedSeqs 契约，必须通过（= 重启加载不炸）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { foldSurface } from '@deepseek-ai/dsh-session/surface'
import { PeratomCompressor } from '../src/peratom/compressor.ts'
import { flushEntry } from '../src/peratom/flush.ts'
import type { FlushHost } from '../src/peratom/flush.ts'
import type { CompressDecision, CompressRecord, CurrentTurnCollect } from '../src/peratom/compressor-types.ts'

// ---------------------------------------------------------------------------
// 测试会话构建器（与 peratom-compressor.test.ts 同款可压轮）
// ---------------------------------------------------------------------------

const LONG_DIALOG = '帮我修复这个报错，服务起不来了，先看日志再给出修复步骤：\n'
/** 模型逐字抄写的 dialog 片段（不含行尾换行——抄写边界即切片边界）。 */
const DIALOG_QUOTE = '帮我修复这个报错，服务起不来了，先看日志再给出修复步骤：'
const LONG_PASTE = 'Error: listen EADDRINUSE :::3000\n    at Server.setupListenListen (node:net:1917:16)\n'.repeat(4)
const LONG_USER = LONG_DIALOG + LONG_PASTE
const TOOL_TEXT = ('EADDRINUSE stack line '.padEnd(40, '.') + '\n').repeat(20)

function appendUser(session: Session, text: string): number {
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  return session.snapshotEvents().length - 1
}
function appendAssistantWithToolCall(session: Session, turn: number, callId: string, name = 'read_file', args = '{"path":"log.txt"}'): number {
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

/** 标准可压轮：turn/start + 长 user + assistant(toolcall) + tool/result + turn/end。返回关键 seq。 */
function buildCompressibleTurn(session: Session, turn: number, callId: string): { uSeq: number; aSeq: number; rSeq: number } {
  session.append('turn/start', { turn })
  const uSeq = appendUser(session, LONG_USER)
  const aSeq = appendAssistantWithToolCall(session, turn, callId)
  const rSeq = appendToolResult(session, turn, callId, TOOL_TEXT)
  session.append('turn/end', { turn, reason: { kind: 'completed' } } as never)
  return { uSeq, aSeq, rSeq }
}

// ---------------------------------------------------------------------------
// 加载期契约重放：shadowedSeqs 必须等于发出时刻的当前 surface 连续切片
// ---------------------------------------------------------------------------

/** 产生 LLM 消息的事件类型（= 宿主 SURFACE_EVENT_TYPES）。 */
const SURFACE_TYPES = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result'])

/**
 * 重放器实际消费的事件结构（最小结构类型）：只读 seq / type / surfaceOp /
 * data.shadowedRange / data.shadowedSeqs。宿主 `SessionEvent`（seq 为 branded
 * `SessionSeq`，是 `number` 子类型）可赋给它；负控的手工最小事件（seq 为裸
 * `number`）亦可——无需为构造 mock 去伪造完整 branded `SessionEvent`。
 *
 * `data` 带字符串索引签名：允许各事件携带各自的额外 data 字段（宿主
 * `UserMessage` 等 interface 无隐式索引签名，故参数用并集而非直接约束 data）。
 * 重放器只读 shadowedRange/shadowedSeqs 两个具名键。
 */
interface ReplayEvent {
  seq: number
  type: string
  surfaceOp?: unknown
  data?: { [key: string]: unknown; shadowedRange?: { start: number; end: number }; shadowedSeqs?: number[] }
}

/**
 * 按序重放事件、维护当前 surface（append→push、replace→splice，与宿主
 * SurfaceManager 的 state.nodes 同构），在每条 compaction/summary / compaction/prune
 * 处校验 shadowedSeqs = [shadowedRange.start, end] 的**当前** surface 连续切片
 * （= dsh-compaction invariant `validateShadowedSeqs` 的核心契约，逐字复刻）。
 * 任一违约即 throw——这正是 Issue #2 的加载期失败模式（旧实现必在此炸）。
 *
 * 参数取 `SessionEvent | ReplayEvent` 并集：e2e 传宿主 `SessionEvent[]`、负控传
 * 手工 `ReplayEvent[]` 均可赋值；循环内按最小结构 `ReplayEvent` 读取（并集成员
 * 的合法 downcast）。
 */
function replayValidateShadowedSeqs(events: readonly (SessionEvent | ReplayEvent)[]): void {
  const surface: number[] = []
  for (const event of events) {
    const e = event as ReplayEvent
    if (e.type === 'compaction/summary' || e.type === 'compaction/prune') {
      const range = e.data?.shadowedRange
      const seqs = e.data?.shadowedSeqs
      assert.ok(range !== undefined, `${e.type} must carry shadowedRange`)
      assert.ok(seqs !== undefined && seqs.length > 0, `${e.type} must carry a non-empty shadowedSeqs`)
      const start = range.start
      const end = range.end
      const startIndex = surface.indexOf(start)
      const endIndex = surface.indexOf(end)
      assert.ok(startIndex >= 0, `${e.type} (seq ${e.seq}): shadowedRange.start=${start} must name a current surface node at emit time`)
      assert.ok(endIndex >= startIndex, `${e.type} (seq ${e.seq}): shadowedRange.end=${end} must be at/after start in the current surface`)
      const expected = surface.slice(startIndex, endIndex + 1)
      assert.equal(expected.length, seqs.length, `${e.type} (seq ${e.seq}): shadowedSeqs length ${seqs.length} must equal the current surface span length ${expected.length}`)
      for (let i = 0; i < expected.length; i += 1) {
        assert.equal(expected[i], seqs[i], `${e.type} (seq ${e.seq}): shadowedSeqs[${i}]=${seqs[i]} must equal current surface node ${expected[i]} (surface order, at emit time)`)
      }
    }
    // 应用本事件到 surface（summary/prune/turn/compaction-start/end 均非 surface 事件，无变化）
    if (e.surfaceOp === undefined || !SURFACE_TYPES.has(e.type)) continue
    if (e.surfaceOp === 'append') {
      surface.push(e.seq)
    } else {
      const op = e.surfaceOp as { op: string; startSeq: number; endSeq: number }
      const startIdx = surface.indexOf(op.startSeq)
      const endIdx = surface.indexOf(op.endSeq)
      assert.ok(startIdx >= 0 && endIdx >= startIdx, `surface replace (seq ${e.seq}) must name a current surface span`)
      surface.splice(startIdx, endIdx - startIdx + 1, e.seq)
    }
  }
}

// ---------------------------------------------------------------------------
// ① 单测：stub host + 真 Session，直接调 flushEntry
// ---------------------------------------------------------------------------

/** stub host：只含 flushEntry 用到的成员（backend/hlsMode/hlsRoiThreshold/toolCopyMarker）。 */
function makeStubHost(): FlushHost {
  return {
    hlsMode: 'off',
    hlsRoiThreshold: 1,
    toolCopyMarker: false,
    backend: () => null,
  } as FlushHost
}

test('① 单测：flushEntry 先 summary 后 replace，shadowedSeqs = 发出时刻整轮窗口连续切片', () => {
  const session = Session.create(SessionId('flush-reload-unit'))
  const { uSeq, rSeq } = buildCompressibleTurn(session, 1, 'c1')

  // collect 与 collectCurrentTurn 同款口径：startSeq/endSeq = 当轮首/末**材料**事件
  // （user / tool-result，均为 surface 事件）；assistant 在窗口内但不被替换。
  const collect: CurrentTurnCollect = {
    turn: 1,
    startSeq: uSeq,
    endSeq: rSeq,
    interrupted: false,
    userLong: [{ kind: 'user-long', seq: uSeq, turn: 1, text: LONG_USER }],
    toolResults: [{ kind: 'tool-result', seq: rSeq, turn: 1, text: TOOL_TEXT, callId: 'c1' }],
  }
  const decision: CompressDecision = {
    splits: [{ seq: uSeq, quotes: [DIALOG_QUOTE], infoLevel: 'extract', infoText: 'EADDRINUSE :::3000 (compressed)' }],
    tools: [{ seq: rSeq, level: 'extract', text: 'EADDRINUSE stack' }],
  }
  const record: CompressRecord = { at: new Date().toISOString(), turn: 1, called: true }

  flushEntry(makeStubHost(), session, collect, decision, record)

  const events = session.snapshotEvents()
  const kinds = events.map(e => e.type)
  const startIdx = kinds.lastIndexOf('compaction/start')
  const endIdx = kinds.lastIndexOf('compaction/end')
  assert.ok(startIdx >= 0 && endIdx > startIdx, '事务括号 start..end 必须存在')

  // 断言 A：summary 紧跟 start（先于任何 replace）——旧实现 summary 在 replace 之后。
  assert.equal(events[startIdx + 1].type, 'compaction/summary', 'compaction/summary 必须紧跟 compaction/start（先于 replace 循环）')
  // 断言 B：end 前无第二条 summary（宿主每事务恰一条）。
  const summaries = events.slice(startIdx + 1, endIdx).filter(e => e.type === 'compaction/summary')
  assert.equal(summaries.length, 1, '事务内恰一条 compaction/summary')
  // 断言 C：replace 步全部落在 summary 之后（summary 索引 < 任一 replace 索引）。
  const summaryIdx = startIdx + 1
  for (let i = startIdx + 1; i < endIdx; i += 1) {
    const sop = (events[i] as { surfaceOp?: unknown }).surfaceOp
    if (sop !== undefined && sop !== 'append' && (sop as { op: string }).op === 'replace') {
      assert.ok(i > summaryIdx, `replace (seq ${events[i].seq}) 必须落在 summary 之后`)
    }
  }

  // 断言 D：shadowedSeqs = 发出时刻 [startSeq, endSeq] 的当前 surface 连续切片。
  const summary = events[summaryIdx] as unknown as { data: { shadowedRange: { start: number; end: number }; shadowedSeqs: number[] } }
  // 重放到 summary 位置（不含 summary 本身）取发出时刻 surface。
  const surfaceAtEmit: number[] = []
  for (const event of events.slice(0, summaryIdx)) {
    const e = event as { type: string; seq: number; surfaceOp?: unknown }
    if (e.surfaceOp === undefined || !SURFACE_TYPES.has(e.type)) continue
    if (e.surfaceOp === 'append') surfaceAtEmit.push(e.seq)
    else {
      const op = e.surfaceOp as { startSeq: number; endSeq: number }
      const si = surfaceAtEmit.indexOf(op.startSeq)
      const ei = surfaceAtEmit.indexOf(op.endSeq)
      surfaceAtEmit.splice(si, ei - si + 1, e.seq)
    }
  }
  const expected = surfaceAtEmit.slice(surfaceAtEmit.indexOf(uSeq), surfaceAtEmit.indexOf(rSeq) + 1)
  assert.deepEqual([...summary.data.shadowedSeqs], expected, 'shadowedSeqs 必须等于发出时刻整轮窗口的连续 surface 切片（surface 顺序）')
  // 断言 E：shadowedRange 首尾 = shadowedSeqs 首尾（validateShadowedSeqs 判据 2）。
  assert.equal(summary.data.shadowedRange.start, summary.data.shadowedSeqs[0], 'shadowedRange.start === shadowedSeqs[0]')
  assert.equal(summary.data.shadowedRange.end, summary.data.shadowedSeqs[summary.data.shadowedSeqs.length - 1], 'shadowedRange.end === shadowedSeqs.at(-1)')
})

test('①b 单测：窗口非当前 surface 有效 span ⇒ flushEntry throw 且落带 error 的 end（不发坏 summary）', () => {
  const session = Session.create(SessionId('flush-reload-unit-badspan'))
  const { uSeq, rSeq } = buildCompressibleTurn(session, 1, 'c1')
  // 故意把 startSeq 指向一个**不在 surface** 的 seq（turn/start 的 seq=0，非 surface 事件）
  // ⇒ 防御自检必须拒绝（旧实现此处会写出"落盘静默成功、重启才炸"的坏 summary）。
  const collect: CurrentTurnCollect = {
    turn: 1,
    startSeq: 0,
    endSeq: rSeq,
    interrupted: false,
    userLong: [{ kind: 'user-long', seq: uSeq, turn: 1, text: LONG_USER }],
    toolResults: [{ kind: 'tool-result', seq: rSeq, turn: 1, text: TOOL_TEXT, callId: 'c1' }],
  }
  const decision: CompressDecision = {
    splits: [{ seq: uSeq, quotes: [DIALOG_QUOTE], infoLevel: 'extract', infoText: 'x' }],
    tools: [{ seq: rSeq, level: 'extract', text: 'y' }],
  }
  const record: CompressRecord = { at: new Date().toISOString(), turn: 1, called: true }

  assert.throws(() => flushEntry(makeStubHost(), session, collect, decision, record), /not a valid current surface span/, '无效窗口必须 throw')
  const events = session.snapshotEvents()
  const kinds = events.map(e => e.type)
  assert.equal(kinds.filter(t => t === 'compaction/summary').length, 0, '拒绝路径不得发出任何 compaction/summary')
  const endEvent = events[kinds.lastIndexOf('compaction/end')] as unknown as { data: { error?: string } }
  assert.ok(endEvent.data.error !== undefined && endEvent.data.error.length > 0, 'catch 必须落一条带 error 的 compaction/end')
})

// ---------------------------------------------------------------------------
// ② 回归：真 PeratomCompressor 端到端 flush → 加载期契约重放必须通过
// ---------------------------------------------------------------------------

interface Harness {
  ctx: Context
  compressor: PeratomCompressor
  respond: (decisionOrText: unknown, raw?: boolean) => void
}

/** 构造被测服务：fetch 替身按脚本应答（与 peratom-compressor.test.ts 同款）。 */
async function makeHarness(config: Record<string, unknown> = {}): Promise<Harness> {
  const ctx = new Context()
  const queue: unknown[] = []
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
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
    respond(decisionOrText: unknown, raw = false) {
      queue.push(raw ? String(decisionOrText) : decisionOrText)
    },
  }
}

test('② 回归：真实 flush 后的会话重放通过加载期 shadowedSeqs 契约（重启不炸）', async t => {
  const h = await makeHarness()
  t.after(async () => { await h.ctx.fiber.dispose() })
  const session = Session.create(SessionId('flush-reload-e2e'))
  const { uSeq, rSeq } = buildCompressibleTurn(session, 1, 'c1')

  h.respond({
    splits: [{ seq: uSeq, quotes: [DIALOG_QUOTE], infoLevel: 'extract', infoText: 'EADDRINUSE :::3000 (compressed)' }],
    tools: [{ seq: rSeq, level: 'extract', text: 'EADDRINUSE stack' }],
  })
  const record = await h.compressor.compressCurrentTurn(session)
  assert.ok(record !== null, 'compressCurrentTurn 必须产出记录')
  assert.ok(record.appliedReplaces !== undefined && record.appliedReplaces >= 1, '必须真实落地至少一次 replace')

  const events = session.snapshotEvents()
  // ②a 加载期契约重放：每条 compaction/summary 的 shadowedSeqs = 发出时刻当前 surface 连续切片。
  replayValidateShadowedSeqs(events)
  // ②b 宿主完整 surface fold 重放无 throw（= 会话可被重新 load）。
  const folded = foldSurface(events as never)
  assert.ok(folded.nodes.length > 0, 'foldSurface 必须产出非空 surface')
})

test('②-负控：旧 bug 形态（replace 先于 summary + 离散 user-then-tool seqs）必被加载期契约拒绝', () => {
  // 复刻 Issue #2 旧实现的发射序列：replace 循环**先**落地（原原子离开 surface），
  // summary **后**发且 shadowedSeqs 只平铺被替换的离散原子（user-then-tool 序）。
  // 到 summary 被校验时，原 user/tool seq 已不在 surface ⇒ 契约必炸（= 重启加载失败）。
  // 最小事件只带重放器读取的字段（seq/type/surfaceOp/data.shadowedRange/shadowedSeqs），
  // 无需伪造完整 branded SessionEvent（其 seq 是 branded SessionSeq，裸 number 不可赋给它）。
  const events: ReplayEvent[] = []
  const push = (e: ReplayEvent): void => { events.push(e) }
  // 手工构造（seq 连续）：turn/start(0) user(1) assistant(2) tool(3) turn/end(4)
  //   compaction/start(5) user-replace(6→1) tool-replace(7→3) summary(8) end(9)
  push({ seq: 0, type: 'turn/start' })
  push({ seq: 1, type: 'user/message', surfaceOp: 'append' })
  push({ seq: 2, type: 'assistant/message', surfaceOp: 'append' })
  push({ seq: 3, type: 'tool/result', surfaceOp: 'append' })
  push({ seq: 4, type: 'turn/end' })
  push({ seq: 5, type: 'compaction/start' })
  // 旧 bug：replace 先落地（user 1→6、tool 3→7），原 seq 离开 surface
  push({ seq: 6, type: 'user/message', surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 } })
  push({ seq: 7, type: 'tool/result', surfaceOp: { op: 'replace', startSeq: 3, endSeq: 3 } })
  // 旧 bug：summary 后发，shadowedSeqs 只平铺离散原原子（user-then-tool），range 取整窗
  push({ seq: 8, type: 'compaction/summary', data: { shadowedRange: { start: 1, end: 3 }, shadowedSeqs: [1, 3] } })
  push({ seq: 9, type: 'compaction/end' })
  assert.throws(() => replayValidateShadowedSeqs(events), /shadowedRange\.start=1 must name a current surface node|shadowedSeqs/, '旧 bug 形态必须被加载期契约拒绝')
})

test('②c 回归：多步同事务（user split + 两 tool）重放仍通过加载期契约', async t => {
  const h = await makeHarness()
  t.after(async () => { await h.ctx.fiber.dispose() })
  const session = Session.create(SessionId('flush-reload-e2e-multi'))
  // 两个**互异** tool result（不同工具名 + 不同内容，避开版本链同键硬排除）+ 一个长 user ⇒ 多步同事务。
  session.append('turn/start', { turn: 1 })
  const uSeq = appendUser(session, LONG_USER)
  appendAssistantWithToolCall(session, 1, 'c1', 'read_file', '{"path":"log.txt"}')
  const r1Seq = appendToolResult(session, 1, 'c1', TOOL_TEXT)
  appendAssistantWithToolCall(session, 1, 'c2', 'grep', '{"pattern":"EADDRINUSE"}')
  const r2Seq = appendToolResult(session, 1, 'c2', 'grep hit: src/server.ts:42 EADDRINUSE port 3000 already bound by pid 8821\n' + 'second line: net::listen failed errno=98')
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } } as never)

  h.respond({
    splits: [{ seq: uSeq, quotes: [DIALOG_QUOTE], infoLevel: 'extract', infoText: 'EADDRINUSE (compressed)' }],
    tools: [
      { seq: r1Seq, level: 'extract', text: 'EADDRINUSE stack #1' },
      { seq: r2Seq, level: 'summary', text: 'second call summary' },
    ],
  })
  const record = await h.compressor.compressCurrentTurn(session)
  assert.ok(record !== null, 'compressCurrentTurn 必须产出记录')
  assert.ok((record.appliedReplaces ?? 0) >= 2, '多步事务必须落地 ≥2 次 replace')

  const events = session.snapshotEvents()
  replayValidateShadowedSeqs(events)
  foldSurface(events as never)
})
