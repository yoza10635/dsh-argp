import test from 'node:test'
import assert from 'node:assert/strict'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  buildToolNameIndex,
  buildVersionChainIndex,
  collectInterruptedTurns,
  filterInterruptedAtoms,
  findLoadBearingTokens,
  fidelityGuard,
  isInterruptedTurnEnd,
  projectSurfaceText,
  rNeedCompress,
  turnCompressible,
  DEFAULT_SMALL_RESULT_CHARS,
} from '../src/peratom/gate.ts'
import type { NeedCompress } from '../src/peratom/gate.ts'

// ---------------------------------------------------------------------------
// 测试会话构建器（事件形状与 argp-graph-engine.test.ts 同款）
// ---------------------------------------------------------------------------

function appendUser(session: Session, text: string): number {
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  return session.events.length - 1
}

function appendAssistantWithToolCall(session: Session, turn: number, callId: string, name: string, args: string, text = 'working'): number {
  session.append('assistant/message', {
    turn,
    step: 1,
    message: {
      role: 'assistant',
      id: 'am_' + callId,
      source: { kind: 'model', provider: 'test', model: 'test' },
      content: [
        { type: 'tool-call', id: callId, name, arguments: args },
        { type: 'text', text },
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

function appendTurnEnd(session: Session, turn: number, kind: string): void {
  session.append('turn/end', { turn, reason: { kind } } as never)
}

// ---------------------------------------------------------------------------
// 中断轮次识别（rc.2 双口径：reason.kind + 直挂标记 + assistant/message 标记）
// ---------------------------------------------------------------------------

test('isInterruptedTurnEnd：reason.kind 命中 aborted/error/interrupted；completed/blocked/max-tokens 不算', () => {
  assert.equal(isInterruptedTurnEnd({ reason: { kind: 'aborted' } }), true)
  assert.equal(isInterruptedTurnEnd({ reason: { kind: 'error' } }), true)
  assert.equal(isInterruptedTurnEnd({ reason: { kind: 'interrupted' } }), true)
  assert.equal(isInterruptedTurnEnd({ reason: { kind: 'completed' } }), false)
  assert.equal(isInterruptedTurnEnd({ reason: { kind: 'blocked' } }), false)
  assert.equal(isInterruptedTurnEnd({ reason: { kind: 'max-tokens' } }), false)
})

test('isInterruptedTurnEnd：data.interrupted 直挂标记（diff 文档口径）与异形输入', () => {
  assert.equal(isInterruptedTurnEnd({ interrupted: true }), true)
  assert.equal(isInterruptedTurnEnd({ interrupted: false, reason: { kind: 'completed' } }), false)
  assert.equal(isInterruptedTurnEnd(null), false)
  assert.equal(isInterruptedTurnEnd('garbage'), false)
  assert.equal(isInterruptedTurnEnd(undefined), false)
})

test('collectInterruptedTurns：扫描 turn/end 与 assistant/message 双落点', () => {
  const session = Session.create(SessionId('gate-interrupted'))
  session.append('turn/start', { turn: 1 })
  appendUser(session, 'hi')
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: {
      role: 'assistant',
      id: 'am_i1',
      source: { kind: 'model', provider: 't', model: 't' },
      content: [{ type: 'text', text: 'partial' }],
    },
    interrupted: true, // 流中取消：已交付前缀 finalize
  } as never, { surfaceOp: 'append' })
  appendTurnEnd(session, 1, 'aborted')
  session.append('turn/start', { turn: 2 })
  appendUser(session, 'next question')
  appendAssistantWithToolCall(session, 2, 'c1', 'read_file', '{"path":"a.ts"}')
  appendTurnEnd(session, 2, 'completed')

  const turns = collectInterruptedTurns(session.events)
  assert.deepEqual([...turns].sort((a, b) => a - b), [1])
})

test('filterInterruptedAtoms：被中断轮次的原子整轮排除，其余轮次原样保留且顺序不变', () => {
  const session = Session.create(SessionId('gate-filter'))
  const u1 = appendUser(session, 'long message '.repeat(20))
  appendTurnEnd(session, 1, 'error') // 失败收尾 → 轮 1 全部残留
  const u2 = appendUser(session, 'second long message '.repeat(20))
  appendTurnEnd(session, 2, 'completed')

  const atoms = [
    { seq: u1, turn: 1, text: 'a' },
    { seq: u2, turn: 2, text: 'b' },
  ]
  const filtered = filterInterruptedAtoms(atoms, session.events)
  assert.equal(filtered.length, 1)
  assert.equal(filtered[0]?.seq, u2)

  // 无中断标记时零拷贝语义等价（全部保留）
  const clean = Session.create(SessionId('gate-clean'))
  appendUser(clean, 'x')
  appendTurnEnd(clean, 1, 'completed')
  assert.equal(filterInterruptedAtoms(atoms, clean.events).length, 2)
})

test('filterInterruptedAtoms：空日志 / 无 turn 字段原子宽容处理', () => {
  assert.deepEqual(filterInterruptedAtoms([{ turn: 3 }], []), [{ turn: 3 }])
})

// ---------------------------------------------------------------------------
// 版本链索引（决策④硬排除底座）
// ---------------------------------------------------------------------------

test('buildVersionChainIndex：同 tool+args 键出现 ≥2 次即成员；不同参数不归链', () => {
  const session = Session.create(SessionId('gate-chain'))
  appendAssistantWithToolCall(session, 1, 'c1', 'read_file', '{"path":"a.ts"}')
  appendToolResult(session, 1, 'c1', 'content v1')
  appendAssistantWithToolCall(session, 2, 'c2', 'read_file', '{"path":"a.ts"}')
  appendToolResult(session, 2, 'c2', 'content v2')
  appendAssistantWithToolCall(session, 3, 'c3', 'read_file', '{"path":"b.ts"}')
  appendToolResult(session, 3, 'c3', 'other file')

  const chain = buildVersionChainIndex(session.events)
  assert.equal(chain.isMember('c1', 'content v1'), true, '旧快照是链成员')
  assert.equal(chain.isMember('c2', 'content v2'), true, '新快照同键也是成员（压缩侧保守：全组保 verbatim）')
  assert.equal(chain.isMember('c3', 'other file'), false, '不同参数是独立调用')
})

test('buildVersionChainIndex：callId 缺 issuer 时退化为 text| 键；单次出现非成员', () => {
  const session = Session.create(SessionId('gate-chain-text'))
  appendToolResult(session, 1, 'orphan-1', 'same output')
  appendToolResult(session, 1, 'orphan-2', 'same output')
  const chain = buildVersionChainIndex(session.events)
  assert.equal(chain.isMember('orphan-1', 'same output'), true, '无 issuer 相同文本重复 → text| 回退键成链')
  assert.equal(chain.isMember(undefined, 'unique'), false)
})

// ---------------------------------------------------------------------------
// 门控谓词（设计 §2 决策序）
// ---------------------------------------------------------------------------

const BIG = 'x'.repeat(DEFAULT_SMALL_RESULT_CHARS)
const SMALL = 'short'

test('rNeedCompress：版本链硬排除优先于一切；大小启发式其次；声明通道可覆盖大小但不可越过硬排除', () => {
  const chainSession = Session.create(SessionId('gate-order'))
  appendAssistantWithToolCall(chainSession, 1, 'k1', 'run', '{"q":"a"}')
  appendToolResult(chainSession, 1, 'k1', BIG)
  appendAssistantWithToolCall(chainSession, 2, 'k2', 'run', '{"q":"a"}')
  appendToolResult(chainSession, 2, 'k2', BIG)
  const chain = buildVersionChainIndex(chainSession.events)

  assert.equal(rNeedCompress({ text: BIG, callId: 'k1' }, chain), false, '① 链成员强制 false')

  const plain = buildVersionChainIndex([])
  assert.equal(rNeedCompress({ text: SMALL, callId: 's1' }, plain), false, '③ 小结果默认 false')
  assert.equal(rNeedCompress({ text: BIG, callId: 's2' }, plain), 'extract', '③ 大结果默认 extract')

  // ② 作者声明 / tool 对照表按**工具种类名**查（非 callId）
  const declared = new Map<string, NeedCompress>([['smalltool', 'summary']])
  assert.equal(
    rNeedCompress({ text: SMALL, callId: 's1', toolName: 'smalltool' }, plain, { toolPolicies: declared }),
    'summary',
    '② 声明覆盖启发式（小结果→summary）',
  )
  assert.equal(
    rNeedCompress({ text: BIG, callId: 'k1', toolName: 'run' }, chain, { toolPolicies: new Map<string, NeedCompress>([['run', 'extract']]) }),
    false,
    '① 硬排除不可被声明越过',
  )
})

test('rNeedCompress：tool 对照表按 toolName 命中（同工具多条结果同档）；无名字→跳过声明走启发式', () => {
  const plain = buildVersionChainIndex([])
  const table = new Map<string, NeedCompress>([['read_file', 'summary']])
  // 同一工具 read_file 的两条不同结果，声明同档
  assert.equal(rNeedCompress({ text: BIG, callId: 'a', toolName: 'read_file' }, plain, { toolPolicies: table }), 'summary')
  assert.equal(rNeedCompress({ text: SMALL, callId: 'b', toolName: 'read_file' }, plain, { toolPolicies: table }), 'summary', '小结果也被声明抬到 summary')
  // 未声明工具（shell）→ 无对照表命中，落回大小启发式
  assert.equal(rNeedCompress({ text: BIG, callId: 'c', toolName: 'bash' }, plain, { toolPolicies: table }), 'extract', '未声明大结果→启发式 extract')
  assert.equal(rNeedCompress({ text: SMALL, callId: 'd', toolName: 'bash' }, plain, { toolPolicies: table }), false, '未声明小结果→启发式 false')
  // 无名字（孤立 tool/result 无 issuer）→ 跳过声明，落回启发式
  assert.equal(rNeedCompress({ text: SMALL, callId: 'orphan' }, plain, { toolPolicies: table }), false, '无 toolName 不查表')
})

test('buildToolNameIndex：callId→工具名取自 assistant tool-call 块；孤立结果无名', () => {
  const session = Session.create(SessionId('gate-toolname'))
  appendAssistantWithToolCall(session, 1, 'c1', 'read_file', '{"path":"a.ts"}')
  appendToolResult(session, 1, 'c1', 'content v1')
  appendToolResult(session, 1, 'orphan-1', 'no issuer')
  const idx = buildToolNameIndex(session.events)
  assert.equal(idx.get('c1'), 'read_file')
  assert.equal(idx.has('orphan-1'), false)
})

test('turnCompressible：纯 dialog 轮 false；长 user 或可压 tool 任一即 true；仅链成员 tool 的轮 false', () => {
  const plain = buildVersionChainIndex([])
  assert.equal(turnCompressible([], plain), false)
  assert.equal(turnCompressible([
    { kind: 'tool-result', seq: 2, turn: 1, text: SMALL, callId: 's' },
  ], plain), false, '短 user + 小 tool = 纯 dialog 轮')
  assert.equal(turnCompressible([
    { kind: 'user-long', seq: 1, turn: 1, text: '长消息'.repeat(100) },
  ], plain), true)
  assert.equal(turnCompressible([
    { kind: 'tool-result', seq: 2, turn: 1, text: BIG, callId: 'b' },
  ], plain), true)

  // 仅链成员 tool 的轮：门控为 false（零调用），与"版本链绝不压缩"一致
  const chainSession = Session.create(SessionId('gate-turn-chain'))
  appendAssistantWithToolCall(chainSession, 1, 'm1', 'get', '{"u":"x"}')
  appendToolResult(chainSession, 1, 'm1', BIG)
  appendAssistantWithToolCall(chainSession, 2, 'm2', 'get', '{"u":"x"}')
  appendToolResult(chainSession, 2, 'm2', BIG + 'v2')
  const chain = buildVersionChainIndex(chainSession.events)
  assert.equal(turnCompressible([
    { kind: 'tool-result', seq: 3, turn: 2, text: BIG + 'v2', callId: 'm2' },
  ], chain), false)
})

// ---------------------------------------------------------------------------
// extract 保真守卫（决策③结构化，spike 34 实证驱动）
// ---------------------------------------------------------------------------

test('findLoadBearingTokens：七类高信号形态逐一命中', () => {
  const text = [
    'connect ECONNREFUSED at /opt/app/src/cache/lru.ts',        // 错误码 + 绝对路径
    'at LRU.evict (src/cache/lru.ts:141:19)',                   // file:line:col
    'see https://api.example.com/v2/users?cursor=zz90 docs',    // URL
    'rid 7c9e6679-7425-40de-944b-e07fc1f90ae7 done',            // UUID
    'sha 3f79bb7b435b05321651daefd374cdc681dc06faa65e374e38337b88ca046dea end', // hex 哈希
    'victim=txn#8821 blocker=txn#8790',                         // key=value
  ].join('\n')
  const tokens = findLoadBearingTokens(text)
  for (const expected of [
    '/opt/app/src/cache/lru.ts',
    'lru.ts:141:19',
    'https://api.example.com/v2/users?cursor=zz90',
    '7c9e6679-7425-40de-944b-e07fc1f90ae7',
    '3f79bb7b435b05321651daefd374cdc681dc06faa65e374e38337b88ca046dea',
    'ECONNREFUSED',
    'victim=txn#8821',
  ]) {
    assert.ok(tokens.includes(expected), `应命中 ${expected}；实际 ${JSON.stringify(tokens)}`)
  }
})

test('findLoadBearingTokens：普通散文零误报（不阻碍正常摘要）', () => {
  const tokens = findLoadBearingTokens('The service restarted after the deploy finished. Everything looks healthy now.')
  assert.equal(tokens.length, 0, JSON.stringify(tokens))
})

test('fidelityGuard：缺任一 token 即拒绝；全含则放行', () => {
  const original = 'Error ERR_CACHE_EVICTION_0x1F4 at src/cache/lru.ts:141:19 victim=txn#8821'
  assert.equal(fidelityGuard(original, 'cache eviction at lru.ts:141:19').ok, false, '丢了错误码与 kv → 拒绝')
  const good = fidelityGuard(
    original,
    'Cache eviction ERR_CACHE_EVICTION_0x1F4 at src/cache/lru.ts:141:19 victim=txn#8821 blocked pool',
  )
  assert.equal(good.ok, true, JSON.stringify(good.missing))
})


// ---------------------------------------------------------------------------
// 投影镜像（gate 与图引擎 eventText 同口径的回归锚）
// ---------------------------------------------------------------------------

test('projectSurfaceText：user 文本 / tool 内层文本 / reasoning 排除', () => {
  const session = Session.create(SessionId('gate-project'))
  const uSeq = appendUser(session, 'user text')
  assert.equal(projectSurfaceText(session.events[uSeq]!), 'user text')

  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: {
      role: 'assistant',
      id: 'am_r1',
      source: { kind: 'model', provider: 't', model: 't' },
      content: [
        { type: 'reasoning', text: 'hidden' },
        { type: 'text', text: 'visible' },
      ],
    },
  } as never, { surfaceOp: 'append' })
  assert.equal(projectSurfaceText(session.events[session.events.length - 1]!), 'visible')

  const rSeq = appendToolResult(session, 1, 'p1', 'tool body')
  assert.equal(projectSurfaceText(session.events[rSeq]!), 'tool body')
})
