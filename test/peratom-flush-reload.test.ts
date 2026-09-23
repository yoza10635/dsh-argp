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
 * 三层测试（Issue #2 明确要求，不可互相替代）：
 *  ① 单测：stub host + 真 Session，**直接调 flushEntry**，断言发射顺序
 *     compaction/start → compaction/summary → replace → compaction/end，
 *     且 summary.shadowedSeqs = 发出时刻整轮窗口连续切片。
 *  ② 回归：真 PeratomCompressor 端到端 flush（collect→LLM→flushEntry）→ 全事件流经
 *     宿主 surface 重放 + validateShadowedSeqs 契约，必须通过（= 重启加载不炸）。
 *  ③ 回归：同一条真实日志经**宿主原生完整加载链**（encodeCurrentHeader/Event →
 *     createRestore → assertV4RowAdmission → decodeRow → assertReleasedV4Relationships）
 *     必须通过——即 issue 给出的 `validate.mjs` 入口（= 用户重启 dsh 打开会话的
 *     同一条路径）。② 与 ③ 是三路等价校验，但宿主入口是 issue 点名要求的那一道。
 *
 * 变异实测（2026-09-24）：把 `flushEntry` 的 summary 块整体移到 replace 循环**之后**
 * （复刻 issue 的 fatal ①）⇒ ① / ② / ②c / **③** 共 4 红，4 条负控全绿 ⇒ 判别力精准。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId, KNOWN_SESSION_EVENT_TYPES, type SessionEvent } from '@deepseek-ai/dsh-session'
import { sessionFormatCatalog as formatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import { assertReleasedV4Relationships, assertV4RowAdmission } from '@deepseek-ai/dsh-session-format-v3-to-v4'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { foldSurface } from '@deepseek-ai/dsh-session/surface'
// 0.1.7 宿主 shadow-price fold（内部函数，主入口仅导出 TokenMeter）：peratom 路径的
// **重启加载投影**契约核验（P0-A 回归锁）。经相对路径直引构建产物，与
// compaction-prune-017.test.ts 同型。旧实现（整窗 summary 撞单原子 replace）在此必
// throw "no adjacent shadow price"——本文件其余测试（replayValidateShadowedSeqs /
// foldSurface）都不覆盖 shadow-price，故 peratom 路径此前对 P0-A 全盲。
import { foldSurfaceProjection as _foldSurfaceProjection } from '../node_modules/@deepseek-ai/dsh-token-meter/lib/types/surface-projection.js'
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

test('①c 单测：成功 end 之后的语句抛出 ⇒ 恰好一条 end，且不带 error（ended 守卫；旧实现为 2）', () => {
  const session = Session.create(SessionId('flush-reload-unit-after-end'))
  const { uSeq, rSeq } = buildCompressibleTurn(session, 1, 'c1')
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
  // record 冻结 ⇒ 成功 `compaction/end` 之后的第一条记账语句（`record.appliedReplaces = …`）
  // 在严格模式下必抛（写冻结对象 = TypeError）⇒ 走进 catch。旧实现 catch **无条件**再补一条
  // 带 error 的 end，同一 compactionId 因此出现**两条** end：写入侧不校验（当场无感），重启
  // 加载期第二条 end 命中宿主 invariant `compaction/end has no matching compaction/start`
  // ⇒ 会话**永久打不开**。ended 守卫下此处不得再补 end（与 test/compaction-tx-brackets.test.ts
  // ① 的 prune-tx 侧同一条不变量）。
  const record = Object.freeze({ at: new Date().toISOString(), turn: 1, called: true }) as CompressRecord

  assert.throws(
    () => flushEntry(makeStubHost(), session, collect, decision, record),
    '成功 end 之后的记账写入（冻结 record）必须抛出——本用例的注入点',
  )

  const events = session.snapshotEvents()
  const kinds = events.map(e => e.type)
  assert.equal(kinds.filter(t => t === 'compaction/start').length, 1, '恰一条 compaction/start')
  assert.equal(kinds.filter(t => t === 'compaction/end').length, 1, '恰一条 compaction/end（ended 守卫；旧实现为 2）')
  const endEvent = events[kinds.lastIndexOf('compaction/end')] as unknown as { data: { error?: string } }
  assert.equal(endEvent.data.error, undefined, '保留的 end 必须是成功路径那条（不带 error），不是 catch 补的')
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

// ---------------------------------------------------------------------------
// ②d shadow-price 回归锁（P0-A）：peratom flush 全事件流经宿主**真实**
// foldSurfaceProjection 无 "no adjacent shadow price"（= 重启加载投影不炸）
// ---------------------------------------------------------------------------

/** 宽松 claim 类型：规避宿主 branded SessionSeq（运行时即 number）。 */
type LooseClaim = { start: number; end: number; tokens: number } | undefined
const foldSurfaceProjection = _foldSurfaceProjection as unknown as (
  claim: LooseClaim,
  event: { type: string; data?: unknown; seq?: number; surfaceOp?: unknown },
) => { deltaTokens: number; claim: LooseClaim }

/**
 * 按序重放事件、维护宿主 shadow-price claim 状态机（与宿主 resume 的
 * `usage-projection.ts` 同构）：compaction/summary|prune 武装 claim，surface
 * append 过期 claim，surface replace 消费 claim 且要求范围**严格相等**——不等即
 * throw "no adjacent shadow price"。任一违约即 throw = 重启加载失败（P0-A 失败模式）。
 */
function replayShadowPrice(events: readonly (SessionEvent | ReplayEvent)[]): void {
  let claim: LooseClaim = undefined
  for (const event of events) {
    const folded = foldSurfaceProjection(claim, event as never)
    claim = folded.claim
  }
}

test('②d 回归：真实 peratom flush 全事件流经宿主 foldSurfaceProjection 无 "no adjacent shadow price"（P0-A 锁）', async t => {
  const h = await makeHarness()
  t.after(async () => { await h.ctx.fiber.dispose() })
  const session = Session.create(SessionId('flush-shadowprice-e2e'))
  const { uSeq, rSeq } = buildCompressibleTurn(session, 1, 'c1')

  h.respond({
    splits: [{ seq: uSeq, quotes: [DIALOG_QUOTE], infoLevel: 'extract', infoText: 'EADDRINUSE :::3000 (compressed)' }],
    tools: [{ seq: rSeq, level: 'extract', text: 'EADDRINUSE stack' }],
  })
  const record = await h.compressor.compressCurrentTurn(session)
  assert.ok(record !== null, 'compressCurrentTurn 必须产出记录')
  assert.ok((record.appliedReplaces ?? 0) >= 1, '必须真实落地至少一次 replace')

  // 关键：全事件流经宿主真实 shadow-price fold（= 重启加载的投影路径）。
  // 旧 beta.2 形态（整窗 summary 撞单原子 replace）在此必 throw；修复后每条
  // replace 前有同范围 per-atom prune 覆盖整窗 claim ⇒ 不 throw。
  replayShadowPrice(session.snapshotEvents())
})

test('②d-负控：旧 bug 形态（整窗 summary 后直接单原子 replace、无 per-atom prune）必被 foldSurfaceProjection 拒绝', () => {
  // 复刻 beta.2 旧 flushEntry 的发射序列：整窗 compaction/summary（range=整轮窗口）
  // 后**直接**单原子 replace（range=该原子），中间无 per-atom prune 覆盖 claim。
  // 首条 replace 撞整窗 claim（8-46 ≠ 9-9）⇒ foldSurfaceProjection 必 throw
  // "no adjacent shadow price"——这正是 P0-A 的失败模式，证明本测试能区分新旧形态。
  // surface 事件须带最小 message 载荷：真实 foldSurfaceProjection 对 append/replace
  // 会调 estimateMessage 计价（user→data、assistant/tool→data.message），缺 role/content
  // 会先于 shadow-price 判定抛 TypeError。这里给最小合法载荷，让断言落在 shadow-price 上。
  const userMsg = { role: 'user', content: [{ type: 'text', text: 'x' }] }
  const asstMsg = { role: 'assistant', content: [{ type: 'text', text: 'x' }] }
  const toolMsg = { role: 'tool', content: [{ type: 'text', text: 'x' }] }
  const events: ReplayEvent[] = [
    { seq: 0, type: 'turn/start' },
    { seq: 1, type: 'user/message', surfaceOp: 'append', data: { ...userMsg } },
    { seq: 2, type: 'assistant/message', surfaceOp: 'append', data: { message: { ...asstMsg } } },
    { seq: 3, type: 'tool/result', surfaceOp: 'append', data: { message: { ...toolMsg } } },
    { seq: 4, type: 'turn/end' },
    { seq: 5, type: 'compaction/start' },
    // 整窗 summary（range 1-3）武装 claim {1,3}
    { seq: 6, type: 'compaction/summary', data: { shadowedRange: { start: 1, end: 3 }, shadowedSeqs: [1, 2, 3], shadowedTokenCount: 10 } },
    // 旧 bug：无 per-atom prune，直接单原子 replace（range 1-1）撞整窗 claim {1,3}
    { seq: 7, type: 'user/message', surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 }, data: { ...userMsg } },
    { seq: 8, type: 'compaction/end' },
  ]
  assert.throws(
    () => replayShadowPrice(events),
    /no adjacent shadow price/,
    '旧 bug 形态（整窗 summary 撞单原子 replace）必须被宿主 shadow-price fold 拒绝',
  )
})

// ---------------------------------------------------------------------------
// ③ 宿主**完整加载链**（Issue #2 点名要求的 assertReleasedV4Relationships 入口）
// ---------------------------------------------------------------------------

/**
 * 走宿主完整加载链重载会话（= Issue #2 给出的 `validate.mjs` 等价物）：
 *
 *   encodeCurrentHeader / encodeCurrentEvent → createRestore(header, …)
 *   → assertV4RowAdmission(row) → decodeRow(row) → assertReleasedV4Relationships
 *
 * 任一环节违规即 throw——这正是用户重启 dsh、重新打开会话时走的同一条路径
 * （`SessionLogScanner.finish() → assertReleasedV4Relationships`）。
 *
 * 与 ② 的分工（**不可互相替代**）：② 用宿主 `foldSurface` / token-meter
 * `foldSurfaceProjection` / 本仓自写重放器做等价校验；③ 补上 issue 指定的**宿主原生
 * 入口**，把"插件发射顺序 + range/seqs 取值"整链交给宿主自己的 v3-to-v4 关系校验。
 *
 * 头部：`session.header` 是**逻辑**头（version/id/createdAt/isSeeded），物理 v4 头另需
 * `delegationDepth`——`assertReleasedV4Header` 的 5 个必填之一（其余 cwd/parentSession/
 * origin/agentPreset 可选），故补 0。
 */
function reloadThroughHostLoadChain(session: Session): void {
  const s = session as unknown as { header: Record<string, unknown>; inheritedEventCount: number }
  const headerRow = formatCatalog.encodeCurrentHeader({ ...s.header, delegationDepth: 0 } as never, s.inheritedEventCount)
  const rows = [headerRow, ...session.snapshotEvents().map(e => formatCatalog.encodeCurrentEvent(e as never))]
  const restore = formatCatalog.createRestore(rows[0], { recovery: 'strict', validation: 'transformed' })
  for (let i = 1; i < rows.length; i += 1) {
    assertV4RowAdmission(rows[i], KNOWN_SESSION_EVENT_TYPES)
    restore.decodeRow(rows[i])
  }
  assertReleasedV4Relationships(restore.finish(), KNOWN_SESSION_EVENT_TYPES)
}

/**
 * V4 tool/result 载荷：`role:'tool'` + `toolCallId`/`isError` 顶层 + `content` 为
 * ContentBlock[]（与 `src/log-access.ts` 读取侧支持的 V4 形态一致）。
 * 原地复用同一函数可保证"只换 content"——宿主 `assertToolResultRewrite` 要求
 * tool/result 的 surface replace **只能**改 content（改 id/source 会先被拒）。
 */
function toolResultV4Payload(turn: number, callId: string, text: string) {
  return {
    turn,
    step: 1,
    message: {
      role: 'tool',
      toolCallId: callId,
      isError: false,
      content: [{ type: 'text', text }],
      source: { kind: 'tool', callId },
      id: 'm_' + callId,
    },
  }
}

function appendToolResultV4(session: Session, turn: number, callId: string, text: string): number {
  session.append('tool/result', toolResultV4Payload(turn, callId, text) as never, { surfaceOp: 'append' })
  return session.snapshotEvents().length - 1
}

/**
 * V4 生命周期**合法**的可压轮。② 用的 `buildCompressibleTurn` 缺 `step/start` 与
 * `tool/call`——只够跑插件自身的 surface 校验，过不了宿主 v3-to-v4 的关系链
 * （`Relationships.tool()` 要求 tool/result 前该 `toolCallId` 已被 assistant/message
 * 广告**且** `started`，否则报 "is not the exact TOOL_NOT_STARTED repair"）。
 * 本构造器补齐：turn/start → user → step/start → assistant(tool-call) → tool/call
 * → tool/result → step/end → turn/end。
 */
function buildV4CompressibleTurn(session: Session, turn: number, callId: string): { uSeq: number; aSeq: number; rSeq: number } {
  session.append('turn/start', { turn })
  const uSeq = appendUser(session, LONG_USER)
  session.append('step/start', { turn, step: 1 } as never)
  const aSeq = appendAssistantWithToolCall(session, turn, callId)
  session.append('tool/call', { turn, step: 1, callId, name: 'read_file', arguments: '{"path":"log.txt"}' } as never)
  const rSeq = appendToolResultV4(session, turn, callId, TOOL_TEXT)
  session.append('step/end', { turn, step: 1 } as never)
  session.append('turn/end', { turn, reason: { kind: 'completed' } } as never)
  return { uSeq, aSeq, rSeq }
}

test('③ 回归：真实 peratom flush 的日志经宿主完整加载链（assertReleasedV4Relationships）通过', async t => {
  const h = await makeHarness()
  t.after(async () => { await h.ctx.fiber.dispose() })
  const session = Session.create(SessionId('flush-loadchain-e2e'))
  const { uSeq, rSeq } = buildV4CompressibleTurn(session, 1, 'c1')
  // 压缩事务发生在**下一轮已开启**时——与真实 flush 同构（被收集轮已结束、当前轮开放；
  // issue 日志即"收集 turn 16 / 事务 turn 17"）。这不是测试装置：宿主
  // `Relationships.tool()` 对 tool/result 的 replace 走 `requireTurn`，无开放 turn 时
  // 替换必被拒，故开放轮是真实前置条件。
  session.append('turn/start', { turn: 2 })

  h.respond({
    splits: [{ seq: uSeq, quotes: [DIALOG_QUOTE], infoLevel: 'extract', infoText: 'EADDRINUSE :::3000 (compressed)' }],
    tools: [{ seq: rSeq, level: 'extract', text: 'EADDRINUSE stack' }],
  })
  const record = await h.compressor.compressCurrentTurn(session)
  assert.ok(record !== null, 'compressCurrentTurn 必须产出记录')
  assert.ok((record.appliedReplaces ?? 0) >= 1, '必须真实落地至少一次 replace')

  // 关键断言：宿主完整加载链必须吃下这份日志（= 重启 dsh 后可正常打开会话）。
  reloadThroughHostLoadChain(session)
})

test('③-负控：旧 bug 形态（replace 先于 summary、seqs 只含被替换原子）必被加载链拒绝', () => {
  // 复刻 Issue #2 旧 flushEntry 的发射序列：compaction/start → replace 循环**先**落地
  // （被替换原子离开 surface）→ compaction/summary **后**发，且 shadowedSeqs 只平铺
  // 真正被替换的原子（而非整窗连续切片）。
  // 期望：宿主 `Relationships.span()` 在 `assertReleasedV4Relationships` 处抛出与线上
  // 逐字相同的错误——证明本测试能区分新旧形态（旧实现必红）。
  const session = Session.create(SessionId('flush-loadchain-negctl'))
  const { uSeq, rSeq } = buildV4CompressibleTurn(session, 1, 'c1')
  session.append('turn/start', { turn: 2 })

  const cid = 'argp-peratom-00000000-0000-4000-8000-0000000000ff'
  session.append('compaction/start', { compactionId: cid, turn: 2 } as never)
  // 旧 bug ①：replace 先于 summary
  // （`surfaceOp` 的 startSeq/endSeq 在类型上是 branded `SessionSeq`，裸 number 需收窄——
  //  与 flush.ts 生产路径同一收窄惯例。）
  session.append('tool/result', toolResultV4Payload(1, 'c1', 'compressed') as never, {
    surfaceOp: { op: 'replace', startSeq: rSeq, endSeq: rSeq },
    sourceEventSeqs: [rSeq],
  } as never)
  // 旧 bug ②：range 取整轮窗口、seqs 只含被替换原子
  session.append('compaction/summary', {
    compactionId: cid,
    turn: 2,
    summary: [{ type: 'text', text: 'probe' }],
    shadowedRange: { start: uSeq, end: rSeq },
    shadowedSeqs: [rSeq],
    shadowedTokenCount: 100,
    provider: 'argp',
    model: 'deterministic-guards',
  } as never)
  session.append('compaction/end', { compactionId: cid, turn: 2 } as never)

  assert.throws(
    () => reloadThroughHostLoadChain(session),
    /shadowedSeqs do not name an exact current surface span/,
    '旧 bug 形态必须被宿主完整加载链拒绝（= issue 报的 stored log is corrupt）',
  )
})
