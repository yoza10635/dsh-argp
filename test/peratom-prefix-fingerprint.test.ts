import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { deriveEventMessage } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { PeratomCompressor } from '../src/peratom/compressor.ts'

// ---------------------------------------------------------------------------
// P1 验收判据①：前缀不变断言（plan：N 轮会话逐轮熵降后，第 k 轮请求的 system+历史
// 前缀指纹与上一轮完全一致 —— 缓存经济的生命线）。
//
// 指纹法（llm-log-proxy 同思想的进程内版）：对 surface 逐节点投影 deriveEventMessage
// （真实请求装配用的同一投影函数），序列化成指纹流。压缩第 k 轮前后对比：
// 公共前缀长度必须覆盖到第 k 轮第一个 surface 位置 —— 即第 k 轮之前的全部历史节点
// 字节不变，KV 缓存前缀全 hit；分叉点恰好从当轮开始。
//
// 附带验收判据③④：版本链成员原文零替换（事件数据 JSON 哈希比对）、纯对话轮零调用。
// ---------------------------------------------------------------------------

const LONG_USER = '帮我修复这个报错，服务起不来了：\nError: listen EADDRINUSE :::3000\n'.repeat(3)

interface Req { body: Record<string, unknown> }

function makeHarness(): {
  ctx: Context
  compressor: PeratomCompressor
  requests: Req[]
  respond: (decision: unknown) => void
} {
  const ctx = new Context()
  const requests: Req[] = []
  const queue: unknown[] = []
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    requests.push({ body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> })
    const next = queue.shift()
    if (next === undefined) throw new Error('no scripted response')
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(next) } }],
    }), { status: 200 })
  }) as typeof fetch
  const compressor = new PeratomCompressor(ctx, {
    endpoint: 'http://fake.test/v1/chat/completions',
    apiKey: 'k',
    model: 'm',
    fetchImpl,
  })
  return { ctx, compressor, requests, respond: d => void queue.push(d) }
}

function appendUser(session: Session, text: string): number {
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  return session.events.length - 1
}

function appendAssistantWithToolCall(session: Session, turn: number, callId: string, args: string): number {
  session.append('assistant/message', {
    turn,
    step: 1,
    message: {
      role: 'assistant',
      id: 'am_' + callId,
      source: { kind: 'model', provider: 't', model: 't' },
      content: [
        { type: 'tool-call', id: callId, name: 'read_file', arguments: args },
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

function appendTurnEnd(session: Session, turn: number): void {
  session.append('turn/end', { turn, reason: { kind: 'completed' } } as never)
}

/** 指纹流：surface 逐节点的真实消息投影（与请求装配同源）序列化。 */
function fingerprint(session: Session): string[] {
  return session.surface.nodes.map(seq => {
    const event = session.events[seq]
    if (event === undefined) return '<missing>'
    return JSON.stringify(deriveEventMessage(event))
  })
}

/** 第 k 轮第一个节点在 surface 中的下标（公共前缀必须覆盖到这里）。 */
function firstSurfaceIndexOfTurn(session: Session, collect: { startSeq: number }): number {
  let idx = Number.MAX_SAFE_INTEGER
  for (let i = 0; i < session.surface.nodes.length; i += 1) {
    if ((session.surface.nodes[i] ?? -1) >= collect.startSeq) { idx = i; break }
  }
  return idx
}

test('P1 前缀不变断言：三轮逐轮熵降，每轮压缩后历史前缀指纹字节不变，分叉点恰为当轮起点', async t => {
  const h = makeHarness()
  t.after(() => h.ctx.fiber.dispose())
  const session = Session.create(SessionId('pf-multi'))
  const originals = new Map<number, string>() // 原文零替换的哈希底账
  h.respond({
    splits: [{ seq: 1, quotes: ['帮我修复这个报错，服务起不来了：'] }],
    tools: [{ seq: 3, level: 'extract', text: 'EADDRINUSE at net:512:26 port 3000.' }],
  })

  const callsBefore = h.compressor.calls
  /** 建完一轮压一轮（真实时序：compressCurrentTurn 只看最新闭合轮）。 */
  async function compressJustBuiltTurn(turn: number): Promise<void> {
    const collect = h.compressor.collectCurrentTurn(session)
    assert.ok(collect !== null && collect.turn === turn, `collect 定位到轮 ${turn}（实际 ${collect?.turn ?? 'null'}）`)
    const firstIdx = firstSurfaceIndexOfTurn(session, collect)
    const before = fingerprint(session)
    const nodesBefore = [...session.surface.nodes]

    const record = await h.compressor.compressCurrentTurn(session)

    const after = fingerprint(session)
    let common = 0
    while (common < before.length && common < after.length && before[common] === after[common]) common += 1

    if (collect.interrupted || (!collect.userLong.length && !collect.toolResults.length)) {
      // 纯对话轮：零调用且 surface 完全不动
      assert.equal(record?.called, false, `轮 ${turn} 门控短路`)
      assert.equal(h.compressor.calls, callsBefore + countCallsSoFar, `轮 ${turn} 零调用`)
      assert.deepEqual([...session.surface.nodes], nodesBefore, `轮 ${turn} 无事务时 surface 不动`)
      assert.equal(common, before.length, `轮 ${turn} 指纹流整体不变`)
      return
    }
    assert.equal(record?.called, true, `轮 ${turn} 触发压缩`)
    assert.ok(
      common >= firstIdx,
      `轮 ${turn} 压缩后公共前缀 ${common} 必须覆盖当轮起点下标 ${firstIdx}（此前历史全 hit）`,
    )
    assert.ok(common < before.length || after.length > before.length, `轮 ${turn} 当轮区域确实发生替换/追加（否则压缩没生效）`)
  }
  let countCallsSoFar = 0

  // 轮 1：长 user + 大 tool（可压）
  session.append('turn/start', { turn: 1 })
  const u1 = appendUser(session, LONG_USER)
  originals.set(u1, JSON.stringify(session.events[u1]?.data))
  appendAssistantWithToolCall(session, 1, 'c1', '{"path":"log.txt"}')
  const r1 = appendToolResult(session, 1, 'c1', 'EADDRINUSE stack '.padEnd(40, '.') + 'x'.repeat(520))
  originals.set(r1, JSON.stringify(session.events[r1]?.data))
  appendTurnEnd(session, 1)
  await compressJustBuiltTurn(1)
  countCallsSoFar = h.compressor.calls

  // 轮 2：短对话 + 大 tool 不同参数（可压，且与轮 1 不同键 → 不触发链排除）
  session.append('turn/start', { turn: 2 })
  const u2 = appendUser(session, '继续看另一个文件')
  originals.set(u2, JSON.stringify(session.events[u2]?.data))
  appendAssistantWithToolCall(session, 2, 'c2', '{"path":"other.txt"}')
  const r2 = appendToolResult(session, 2, 'c2', 'OTHER '.padEnd(40, '.') + 'y'.repeat(520))
  originals.set(r2, JSON.stringify(session.events[r2]?.data))
  appendTurnEnd(session, 2)
  // 校正轮 2 应答里的 tool seq（建轮前无法预知）
  h.requests.length = 0
  void u2
  {
    const c2 = h.compressor.collectCurrentTurn(session)
    const toolSeq = c2?.toolResults[0]?.seq ?? r2
    queueFixup(h, { splits: [], tools: [{ seq: toolSeq, level: 'extract', text: 'OTHER file contents summarized.' }] })
  }
  await compressJustBuiltTurn(2)
  countCallsSoFar = h.compressor.calls

  // 轮 3：纯对话轮（短 user + 回复，无工具）→ 门控 false 零调用
  session.append('turn/start', { turn: 3 })
  appendUser(session, '好的收到')
  session.append('assistant/message', {
    turn: 3,
    step: 1,
    message: {
      role: 'assistant',
      id: 'am_t3',
      source: { kind: 'model', provider: 't', model: 't' },
      content: [{ type: 'text', text: 'done' }],
    },
  } as never, { surfaceOp: 'append' })
  appendTurnEnd(session, 3)
  await compressJustBuiltTurn(3)

  // 判据③：版本链成员与全部原文零替换 —— 事件数据 JSON 哈希比对
  for (const [seq, hash] of originals) {
    assert.equal(JSON.stringify(session.events[seq]?.data), hash, `seq ${seq} 原文在日志中零替换`)
  }
})

/** 向替身队列追加一个应答（测试内小工具）。 */
function queueFixup(h: { respond: (d: unknown) => void }, decision: unknown): void {
  h.respond(decision)
}
