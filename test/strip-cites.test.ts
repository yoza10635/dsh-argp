import test from 'node:test'
import assert from 'node:assert/strict'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { stripTrailingCitesIfNeeded } from '../src/argp-engine.ts'
import { sessionEvents } from '../src/log-access.ts'

// 最小 session 桩：只捕获 append 调用
function stubSession() {
  const appends: Array<{ type: string; data: Record<string, unknown>; opts: unknown }> = []
  const session = {
    append(type: string, data: Record<string, unknown>, opts: unknown) {
      appends.push({ type, data, opts })
      return { seq: 999 }
    },
  }
  return { session, appends }
}

test('strips trailing {"cites":[...]} from the last text block and stashes argpCites', () => {
  const { session, appends } = stubSession()
  const event = {
    seq: 7,
    data: {
      message: { content: [{ type: 'text', text: 'Here is the answer.\n\n{"cites":["earlier claim A"]}' }] },
      model: 'mock', provider: 'mock',
    } as Record<string, unknown>,
  }
  stripTrailingCitesIfNeeded(session as never, event)
  assert.equal(appends.length, 1, 'should rewrite exactly one surface node')
  const a = appends[0]!
  assert.equal(a.type, 'assistant/message')
  const content = (a.data.message as { content: Array<{ type: string; text: string }> }).content
  assert.equal(content.length, 1)
  assert.equal(content[0]!.text, 'Here is the answer.', 'cites JSON must be gone from text')
  assert.deepEqual(a.data.argpCites, [{ text: 'earlier claim A', level: 'supporting' }], 'cites preserved in argpCites (V6 graded)')
  assert.equal((a.opts as { surfaceOp: { op: string; startSeq: number; endSeq: number } }).surfaceOp.op, 'replace')
  // issue #1 回归锁（2026-11-14）：assistant/message 的 replace **不得携带 sourceEventSeqs**
  // ——宿主 dsh-token-meter 把该字段按「由哪些 assistant/chunk 拼成」解释，写了它该会话计量
  // 永久抛错、压缩失效。宿主 0.1.5+ 的 assertProvenance 会 throw，但引擎调用点 try/catch 吞错
  // （argp-engine.ts），套件里只有本 stub 测试直达此路径 ⇒ 必须在此断言锁死。
  assert.ok(!('sourceEventSeqs' in (a.opts as object)),
    'assistant/message replace 不得携带 sourceEventSeqs（issue #1：与 dsh-token-meter 语义冲突）')
})

test('no-op when message has no trailing cites block', () => {
  const { session, appends } = stubSession()
  const event = {
    seq: 3,
    data: { message: { content: [{ type: 'text', text: 'plain answer, no cites' }] } } as Record<string, unknown>,
  }
  stripTrailingCitesIfNeeded(session as never, event)
  assert.equal(appends.length, 0, 'should not rewrite when nothing to strip')
})

test('idempotent: already-stripped node (argpCites present) is skipped', () => {
  const { session, appends } = stubSession()
  const event = {
    seq: 9,
    data: {
      message: { content: [{ type: 'text', text: 'clean answer' }] },
      argpCites: ['x'],
    } as Record<string, unknown>,
  }
  stripTrailingCitesIfNeeded(session as never, event)
  assert.equal(appends.length, 0, 'should not loop on already-stripped node')
})

test('preserves tool-call blocks and only trims the trailing text block', () => {
  const { session, appends } = stubSession()
  const event = {
    seq: 1,
    data: {
      message: {
        content: [
          { type: 'text', text: 'Let me call the tool.' },
          { type: 'tool-call', id: 'call_1', name: 'read', arguments: '{}' },
          { type: 'text', text: 'Done.\n\n{"cites":["call_1"]}' },
        ],
      },
    } as Record<string, unknown>,
  }
  stripTrailingCitesIfNeeded(session as never, event)
  assert.equal(appends.length, 1)
  const content = (appends[0]!.data.message as { content: Array<{ type: string; text?: string; id?: string }> }).content
  assert.equal(content.length, 3, 'tool-call block must be preserved')
  assert.equal(content[1]!.type, 'tool-call')
  assert.equal(content[2]!.text, 'Done.', 'only the last text block is trimmed')
  assert.deepEqual(appends[0]!.data.argpCites, [{ text: 'call_1', level: 'supporting' }])
  assert.ok(!('sourceEventSeqs' in (appends[0]!.opts as object)),
    'assistant/message replace 不得携带 sourceEventSeqs（issue #1）')
})
/**
 * 真实日志状态的落点判定夹具。
 * 说明：宿主 `Session.append` 对 assistant/message replace 另有写入契约（replace 必须用
 * sourceEventSeqs 覆盖被遮节点，而 v4 assistant/message 又禁带 sourceEventSeqs）——故剥离
 * 的**实际 append 在真实 Session 上会被宿主自己拒收**（调用点 try/catch 吞错，历史行为）。
 * 红线要保的是「落点守卫不误关功能」：这里用真实日志 + 捕获 append 的替身，隔离验证——
 * 开放轮 + step 坐标匹配时守卫必须放行并真的走到 append；轮间隙必须拦下。
 */
function realLogSession(id: string, closeTurn: boolean): {
  wrapper: { snapshotEvents: () => readonly unknown[]; append: (...args: unknown[]) => { seq: number } }
  event: { seq: number; data: Record<string, unknown> }
  captured: unknown[][]
} {
  const real = Session.create(SessionId(id))
  real.append('turn/start', { turn: 1 } as never)
  real.append('step/start', { turn: 1, step: 1 } as never)
  const event = real.append('assistant/message', {
    turn: 1, step: 1, stream: [],
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'Here is the answer.\n\n{"cites":["earlier claim A"]}' }],
      source: { kind: 'model', provider: 'test', model: 'test' },
      id: 'a_1',
    },
  } as never, { surfaceOp: 'append' }) as unknown as { seq: number; data: Record<string, unknown> }
  if (closeTurn) {
    real.append('step/end', { turn: 1, step: 1 } as never)
    real.append('turn/end', { turn: 1 } as never)
  }
  const snapshot = sessionEvents(real)
  const captured: unknown[][] = []
  const wrapper = {
    snapshotEvents: () => snapshot,
    append: (...args: unknown[]) => {
      captured.push(args)
      return { seq: 999 }
    },
  }
  return { wrapper, event, captured }
}

test('真实落点（开放轮 + 开放 step、坐标匹配）：守卫放行，cites 剥离照常执行', () => {
  const { wrapper, event, captured } = realLogSession('strip-real-ok', false)
  stripTrailingCitesIfNeeded(wrapper as never, event)
  assert.equal(captured.length, 1, '真实调用点守卫必须放行（红线：不许把剥离功能关掉）')
  assert.equal(captured[0]![0], 'assistant/message')
  const opts = captured[0]![2] as { surfaceOp?: { op?: string } }
  assert.equal(opts.surfaceOp?.op, 'replace', '放行后走的是原位 replace 写回')
  const data = captured[0]![1] as Record<string, unknown>
  assert.deepEqual(data.argpCites, [{ text: 'earlier claim A', level: 'supporting' }])
})

test('真实落点（轮间隙）：守卫识别非法落点，跳过写回', () => {
  const { wrapper, event, captured } = realLogSession('strip-real-gap', true)
  stripTrailingCitesIfNeeded(wrapper as never, event)
  assert.equal(captured.length, 0, '轮间隙 assistant replace 非法 ⇒ 守卫必须拦下写回（不污染存档）')
})
