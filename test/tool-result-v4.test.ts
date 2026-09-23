import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { PeratomCompressor } from '../src/peratom/compressor.ts'
import { eventTextOf } from '../src/log-access.ts'

// ---------------------------------------------------------------------------
// V4 tool/result 双形状测试（宿主 0.1.7：tool 一等消息，toolCallId/isError 顶层，
// content 是 ContentBlock[]）。证明 peratom 写入侧（toolCopyPayload）与读取侧
// （eventTextOf）对 V4 形态正确：替换后仍是 role:'tool' 一等消息、顶层身份字段
// 保留、content 换为单 text block；原文 verbatim 留日志。
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

/** V4 tool/result：role:'tool'，toolCallId/isError 顶层，content 是 ContentBlock[]（text）。 */
function appendToolResultV4(session: Session, turn: number, callId: string, text: string): number {
  session.append('tool/result', {
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

test('V4 读取侧：eventTextOf 从 role:tool 一等消息提取 content 文本', () => {
  const session = Session.create(SessionId('v4-read'))
  const rSeq = appendToolResultV4(session, 1, 'c1', 'EADDRINUSE stack trace here')
  const event = session.snapshotEvents()[rSeq]!
  assert.equal(eventTextOf(event), 'EADDRINUSE stack trace here', 'V4 tool result 文本经 content[0].text 提取')
})

test('V4 写入侧：peratom extract 替换后仍是 role:tool 一等消息，toolCallId/isError 顶层保留、content 换单 text block', async t => {
  const h = await makeHarness({ toolCopyMarker: false })
  t.after(() => dispose(h))
  const session = Session.create(SessionId('v4-tool-replace'))

  session.append('turn/start', { turn: 1 })
  const uSeq = appendUser(session, LONG_USER)
  appendAssistantWithToolCall(session, 1, 'c1', 'read_file', '{"path":"log.txt"}')
  const rSeq = appendToolResultV4(session, 1, 'c1', ('EADDRINUSE stack line '.padEnd(40, '.') + '\n').repeat(20))
  appendTurnEnd(session, 1)

  const extractText = 'EADDRINUSE on port 3000 at net:1917; server failed to bind.'
  h.respond({
    splits: [{ seq: uSeq, quotes: [DIALOG_QUOTE] }],
    tools: [{ seq: rSeq, level: 'extract', text: extractText }],
  })

  const record = await h.compressor.compressCurrentTurn(session)
  assert.equal(record?.called, true)
  assert.equal(h.compressor.calls, 1, '单次调用覆盖当轮全部可压原子')

  // 找到 tool/result replace 事件
  const toolEvent = session.snapshotEvents().find(
    e => e.type === 'tool/result' && (e as { surfaceOp?: { op?: string } }).surfaceOp?.op === 'replace',
  )
  assert.ok(toolEvent, 'tool/result replace 事件存在')
  const tData = toolEvent!.data as unknown as {
    message?: { role?: string; toolCallId?: string; isError?: boolean; content?: { type?: string; text?: string }[] }
  }
  assert.equal(tData.message?.role, 'tool', 'V4 替换副本保持 role:tool 一等消息')
  assert.equal(tData.message?.toolCallId, 'c1', '顶层 toolCallId 保留（配对语义）')
  assert.equal(tData.message?.isError, false, '顶层 isError 保留')
  assert.equal(tData.message?.content?.[0]?.type, 'text', 'content 是 text block（非 V3 的 tool-result block）')
  assert.equal(tData.message?.content?.[0]?.text, extractText, 'content 文本 = 模型 extract 输出')

  // 原始 V4 tool result 仍 verbatim 留日志（防干涉底座）
  const orig = session.snapshotEvents()[rSeq]!.data as unknown as { message?: { role?: string; toolCallId?: string; content?: { text?: string }[] } }
  assert.equal(orig.message?.role, 'tool')
  assert.equal(orig.message?.toolCallId, 'c1')
  assert.ok(orig.message?.content?.[0]?.text?.includes('EADDRINUSE'), '原始 tool result verbatim 留日志')
})
