/**
 * 宿主 v4 fold **真实校验器**回归锁（2.2.2 存档加载根修，session-43df801e 案）。
 *
 * 为什么要拿宿主代码当 oracle：ARGP 自己复刻 fold 判据会和宿主漂移（本事故的直接教训是
 * "写入侧不拦、加载侧整档 corrupt"）。本文件直接 import
 * `@deepseek-ai/dsh-session-format-v3-to-v4` 的 `assertReleasedV4Relationships`，
 * 对 ARGP 真实发射的日志做一次**加载期同款校验**：
 *  - 正向：轮内 / 轮间隙（手动 /compact 形态）压缩事务产出的日志都必须被宿主接受；
 *  - 反向（阴性对照）：同样日志里手工补一枚轮间隙的 tool/result replace ⇒ 宿主必须
 *    抛 "tool/result is outside an open turn"（证明 oracle 有判别力，不是纸面锁）。
 *
 * 2.2.2 根修后 ARGP 的 surface replace **只剩 user 检查点**（1.x 引用协议剥离那条残余 assistant replace
 * 自 2.2.1 起就被宿主写入侧无条件拒收，属从未生效的死路径，2.2.2 已连同落点守卫一并删除），
 * "非 append tool/result 落轮间隙"这一类从结构上不可达。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { assertReleasedV4Relationships } from '@deepseek-ai/dsh-session-format-v3-to-v4'
import { pruneIntervals, type PruneTxHost } from '../src/prune-tx.ts'
import { detectOpenStep, sessionEvents } from '../src/log-access.ts'

function makeHost(): PruneTxHost {
  return {
    log: { info: () => {}, warn: () => {}, error: () => {} },
    stateOf: () => ({
      prunedNodeIndex: new Map(), records: [], lastRealPromptTokens: 0, lastRealAnchorSeq: 0,
    }) as never,
    compactSourceCommandId: undefined,
    charsPerToken: 4,
    telemetryCap: 100,
    bindSession: () => {},
    atomize: () => [],
    tombstoneMergeMinRun: 8,
    recencyGuard: 0,
    turnGuard: 0,
  } as unknown as PruneTxHost
}

/** 宿主加载侧校验：伪 artifact（header 无 type 字段，事件按 seq 连续）。 */
function assertHostLoadable(session: Session): void {
  const events = sessionEvents(session) as unknown as { type: string }[]
  const artifact = {
    header: {
      version: 4,
      id: String(session.id),
      createdAt: 1,
      isSeeded: false,
      delegationDepth: 0,
      cwd: 'C:/workspace/test',
    },
    events,
  }
  assertReleasedV4Relationships(artifact as never, new Set(events.map(e => e.type)) as never)
}

/** 段 1：合法 v4 会话骨架（system head + user + 一个完整 A/R 协议组 + turn/start·end）。 */
function seedTurn(session: Session, len: number): { aSeq: number; rSeq: number; rData: Record<string, unknown> } {
  session.append('turn/start', { turn: 1 } as never)
  session.append('step/start', { turn: 1, step: 1 } as never)
  session.append('system/message', {
    turn: 1, step: 1,
    message: {
      role: 'system',
      content: [{ type: 'text', text: 'persona' }],
      source: { kind: 'system-prompt' },
      id: 'sys_1',
    },
  } as never, { surfaceOp: 'append' })
  session.append('user/message', {
    content: [{ type: 'text', text: 'task' }], source: { kind: 'user' }, role: 'user', id: 'u_1',
  } as never, { surfaceOp: 'append' })
  const aSeq = session.append('assistant/message', {
    turn: 1, step: 1, stream: [],
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'doing read' },
        { type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' },
      ],
      source: { kind: 'model', provider: 'test', model: 'test' },
      id: 'a_1',
    },
  } as never, { surfaceOp: 'append' }).seq
  session.append('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{}' } as never)
  const rData = {
    turn: 1, step: 1,
    message: {
      role: 'tool',
      source: { kind: 'tool', callId: 'c1' },
      toolCallId: 'c1',
      content: [{ type: 'text', text: 'R'.repeat(len) }],
      isError: false,
      id: 'm_c1',
    },
  }
  const rSeq = session.append('tool/result', rData as never, { surfaceOp: 'append' }).seq
  session.append('step/end', { turn: 1, step: 1 } as never)
  session.append('turn/end', { turn: 1 } as never)
  return { aSeq, rSeq, rData }
}

/** 2.2.2 根修形态：整组区间 → 单个 user 检查点（user replace 不受轮约束）。 */
function pruneGroupToCheckpoint(session: Session, group: { aSeq: number; rSeq: number }, text: string): void {
  const result = pruneIntervals(
    makeHost(),
    session,
    [{ seqs: [group.aSeq, group.rSeq], chars: 900, atoms: [] }],
    1,
    false,
    [{ type: 'user', text }],
    'factor-prune',
  )
  assert.notEqual(result, null, 'user 检查点事务必须成功落盘')
}

test('宿主 oracle 正向：轮间隙（手动 /compact）压缩后日志可被宿主加载', () => {
  const session = Session.create(SessionId('fold-gap-ok'))
  const group = seedTurn(session, 4000)
  assert.equal(sessionEvents(session).at(-1)?.type, 'turn/end', '前置：轮间隙')
  pruneGroupToCheckpoint(session, group, 'ARGP 压缩检查点')
  assertHostLoadable(session)
  // 整档零非 append tool/result（本次事故的毒形态）
  assert.equal(
    sessionEvents(session).filter(e => e.type === 'tool/result' && (e as { surfaceOp?: unknown }).surfaceOp !== 'append').length,
    0,
  )
})

test('宿主 oracle 正向：轮内（自动 pre-step）压缩后日志可被宿主加载', () => {
  const session = Session.create(SessionId('fold-inturn-ok'))
  const group = seedTurn(session, 4000)
  session.append('turn/start', { turn: 2 } as never)
  pruneGroupToCheckpoint(session, group, 'ARGP 压缩检查点')
  assertHostLoadable(session)
})

test('宿主 oracle 阴性对照：轮间隙手工补一枚 tool/result replace ⇒ 宿主必须整档拒载', () => {
  const session = Session.create(SessionId('fold-gap-poison'))
  const group = seedTurn(session, 4000)
  // 直接走 Session.append 复刻 2.2.1 的毒形态：写入侧只校验 content-only
  // （宿主 v4 写入侧 SurfaceManager 的 assertToolResultRewrite），**不校验轮**——
  // 这正是「写入成功、加载才炸」的两层口径分叉。故内容只改 message.content。
  const origMessage = (group.rData as { message: Record<string, unknown> }).message
  session.append('tool/result', {
    ...group.rData,
    message: { ...origMessage, content: [{ type: 'text', text: 'stub' }] },
  } as never, {
    surfaceOp: { op: 'replace', startSeq: group.rSeq as never, endSeq: group.rSeq as never },
    sourceEventSeqs: [group.rSeq as never],
  })
  assert.throws(
    () => assertHostLoadable(session),
    /tool\/result is outside an open turn/,
    '宿主加载侧必须拒载轮间隙 tool/result replace（oracle 判别力自证；2.2.2 根修后 ARGP 不再产生该形态）',
  )
})
