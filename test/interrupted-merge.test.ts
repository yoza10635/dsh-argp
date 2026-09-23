import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { PeratomCompressor } from '../src/peratom/compressor.ts'

// ---------------------------------------------------------------------------
// 中断轮并入下一轮（1.7.0 行为变更）：
// 中断轮 N 的完整原子不在 N 自己的 pass 压（racy——轮刚被中断），而是并入
// 下一轮 N+1 的 settled pass。断言：N 的 R 被 N+1 pass 压、pass 归属 N+1、
// N 自身 pass 跳过（skipReason 非 interrupted）、单次调用覆盖两轮。
// ---------------------------------------------------------------------------

const LONG_DIALOG = '帮我修复这个报错，服务起不来了，先看日志再给出修复步骤：\n'
const DIALOG_QUOTE = '帮我修复这个报错，服务起不来了，先看日志再给出修复步骤：'
const LONG_PASTE = 'Error: listen EADDRINUSE :::3000\n    at Server.setupListenListen (node:net:1917:16)\n'.repeat(4)
const LONG_USER = LONG_DIALOG + LONG_PASTE

function appendUser(session: Session, text: string): number {
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  return session.snapshotEvents().length - 1
}

function appendAssistantWithToolCall(session: Session, turn: number, callId: string, name: string, args: string): number {
  session.append('assistant/message', {
    stream: [],
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

function appendTurnEnd(session: Session, turn: number, kind = 'completed'): void {
  session.append('turn/end', { turn, reason: { kind } } as never)
}

interface Harness {
  ctx: Context
  compressor: PeratomCompressor
  respond: (decisionOrText: unknown) => void
}

async function makeHarness(config: Record<string, unknown> = {}): Promise<Harness> {
  const ctx = new Context()
  const queue: unknown[] = []
  const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
    const next = queue.shift()
    if (next === undefined) throw new Error('fetch test-double: no scripted response')
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
    respond(decisionOrText: unknown) {
      queue.push(decisionOrText)
    },
  }
}

async function dispose(h: Harness): Promise<void> {
  await h.ctx.fiber.dispose()
}

test('中断轮并入下一轮：N 中断 + N+1 闭合 ⇒ N 的 R 被 N+1 pass 压、pass 归属 N+1、单次调用覆盖两轮', async t => {
  const h = await makeHarness({ toolCopyMarker: false })
  t.after(() => dispose(h))
  const session = Session.create(SessionId('interrupted-merge'))

  // Turn 1: 中断（aborted），带一个大 tool result。
  session.append('turn/start', { turn: 1 })
  appendAssistantWithToolCall(session, 1, 'c1', 'read_file', '{"path":"log.txt"}')
  const r1Seq = appendToolResult(session, 1, 'c1', ('EADDRINUSE stack line '.padEnd(40, '.') + '\n').repeat(20))
  appendTurnEnd(session, 1, 'aborted')

  // Turn 2: 闭合（completed），带长 user + 大 tool result。
  session.append('turn/start', { turn: 2 })
  const u2Seq = appendUser(session, LONG_USER)
  appendAssistantWithToolCall(session, 2, 'c2', 'read_file', '{"path":"log2.txt"}')
  const r2Seq = appendToolResult(session, 2, 'c2', ('EADDRINUSE stack line2 '.padEnd(40, '.') + '\n').repeat(20))
  appendTurnEnd(session, 2, 'completed')

  // 脚本化决策：extract 两轮各自的 tool result + split turn 2 的 user。
  h.respond({
    splits: [{ seq: u2Seq, quotes: [DIALOG_QUOTE] }],
    tools: [
      { seq: r1Seq, level: 'extract', text: 'turn1 EADDRINUSE extract' },
      { seq: r2Seq, level: 'extract', text: 'turn2 EADDRINUSE extract' },
    ],
  })

  const record = await h.compressor.compressCurrentTurn(session)
  assert.equal(record?.called, true, 'N+1 pass 被调用')
  assert.equal(record?.turn, 2, 'pass 归属 N+1（settled），非中断的 N')
  assert.equal(record?.skipReason, undefined, 'N+1 自身未中断 ⇒ 不跳过（N 的原子并入而非跳过）')
  assert.equal(h.compressor.calls, 1, '单次调用覆盖 N+1 + 并入的 N')

  // 两轮的 tool result 各一个 replace（N 的 R 被 N+1 pass 压）。
  const replaces = session.snapshotEvents().filter(
    e => e.type === 'tool/result' && (e as { surfaceOp?: { op?: string } }).surfaceOp?.op === 'replace',
  )
  assert.equal(replaces.length, 2, 'N 与 N+1 的 tool result 各一个 replace')

  // 原始 tool result 仍 verbatim 留日志（防干涉底座）。
  const orig1 = (session.snapshotEvents()[r1Seq]!.data as { message: { content: { content: { text: string }[] }[] } }).message.content[0]!.content[0]!.text
  assert.ok(orig1.includes('EADDRINUSE'), 'N 的原始 tool result verbatim 留日志')
})

test('对照组：N 未中断 ⇒ 不并入（N+1 pass 只压 N+1 自身原子）', async t => {
  const h = await makeHarness({ toolCopyMarker: false })
  t.after(() => dispose(h))
  const session = Session.create(SessionId('interrupted-merge-ctrl'))

  // Turn 1: 闭合（completed），带大 tool result。
  session.append('turn/start', { turn: 1 })
  appendAssistantWithToolCall(session, 1, 'c1', 'read_file', '{"path":"log.txt"}')
  const r1Seq = appendToolResult(session, 1, 'c1', ('EADDRINUSE stack line '.padEnd(40, '.') + '\n').repeat(20))
  appendTurnEnd(session, 1, 'completed')

  // Turn 2: 闭合（completed），带大 tool result。
  session.append('turn/start', { turn: 2 })
  appendAssistantWithToolCall(session, 2, 'c2', 'read_file', '{"path":"log2.txt"}')
  const r2Seq = appendToolResult(session, 2, 'c2', ('EADDRINUSE stack line2 '.padEnd(40, '.') + '\n').repeat(20))
  appendTurnEnd(session, 2, 'completed')

  // 只脚本化 turn 2 的 extract（turn 1 未中断 ⇒ 不并入，N+1 pass 不含 N 的原子）。
  h.respond({ splits: [], tools: [{ seq: r2Seq, level: 'extract', text: 'turn2 EADDRINUSE extract' }] })

  const record = await h.compressor.compressCurrentTurn(session)
  assert.equal(record?.called, true)
  assert.equal(record?.turn, 2)
  // turn 1 未中断 ⇒ 不并入 ⇒ 只有 turn 2 的 tool result 被 replace。
  const replaces = session.snapshotEvents().filter(
    e => e.type === 'tool/result' && (e as { surfaceOp?: { op?: string } }).surfaceOp?.op === 'replace',
  )
  assert.equal(replaces.length, 1, 'N 未中断 ⇒ 不并入，仅 N+1 的 R 被压')
  void r1Seq
})
