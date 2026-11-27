/**
 * Issue #2 验收层回归（2.0 时代）：**我们发射的 compaction 事务日志必须过宿主原生完整加载链**。
 *
 * 背景（issue #2 根因）：写入侧不校验 compaction/* ⇒ "落盘静默成功、重启才炸"（stored log
 * is corrupt）。1.7.0 修复落了两层回归：写入侧自检 + 宿主加载链验收
 * （旧 `test/peratom-flush-reload.test.ts`）。2.0 factor-only 重构退役旧栈时，**契约移植进了
 * `prune-tx.pruneIntervals`**（span 守卫 + summary 先于 replace，"Issue #2 同类修复"），写入侧
 * 守卫由 `compaction-tx-brackets.test.ts` 锁死；但**验收层没有随契约迁移**——"我们发射的日志
 * ⇒ 宿主 strict 重载不炸"这半边在 2.0 全盲，本文件补上：
 *
 *   encodeCurrentHeader / encodeCurrentEvent → createRestore(header, strict/transformed)
 *   → assertV4RowAdmission(row) → decodeRow(row) → assertReleasedV4Relationships
 *
 * 这正是用户重启 dsh 重新打开会话走的同一条路径（SessionLogScanner.finish()）。
 *
 * 三条正控覆盖 prune-tx 的三种真实区间形态：
 *   ① 单节点区间（user 消息独剪）——summary 单点 span；
 *   ② 多区间（两条 user 分属两轮）——summary 总跨度 span + **逐区间 shadow-price 相邻**
 *     （compaction/prune 必须与紧随其后的 surface replace 严格相等，2026-09-01 实锤）；
 *   ③ 整轮区间 [u..r]——单条 checkpoint user 墓碑整段 replace（factor 组剪的生产形态）。
 * 负控：复刻 issue 旧 bug 发射序（replace 先于 summary、shadowedSeqs 只平铺被替换原子），
 * 宿主必须在 assertReleasedV4Relationships 处逐字抛出线上错误——证明本文件能区分新旧形态。
 *
 * 变异纪律：把 prune-tx 的 summary 发射移回 replace 循环之后（复刻 fatal ①）⇒ ①②③ 全红、
 * 负控保持绿 ⇒ 判别力精准。摘 span 守卫（refusing to emit）只会改变写入侧行为，验收层
 * 由 ①②③ 对发射产物把关。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Session, SessionId, KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import { sessionFormatCatalog as formatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import { assertReleasedV4Relationships, assertV4RowAdmission } from '@deepseek-ai/dsh-session-format-v3-to-v4'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { pruneIntervals } from '../src/prune-tx.ts'
import type { PruneTxHost } from '../src/prune-tx.ts'

// ---------------------------------------------------------------------------
// 宿主原生完整加载链（与旧 peratom-flush-reload.test.ts ③ 同一道入口）
// ---------------------------------------------------------------------------

/**
 * 头部：`session.header` 是逻辑头（version/id/createdAt/isSeeded），物理 v4 头另需
 * `delegationDepth`——`assertReleasedV4Header` 必填五项之一（cwd/parentSession/origin/
 * agentPreset 可选），故补 0。
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

// ---------------------------------------------------------------------------
// 会话构建器（V4 生命周期全量：过宿主关系链的最低要求）
// ---------------------------------------------------------------------------

const TOOL_TEXT = ('EADDRINUSE stack line '.padEnd(40, '.') + '\n').repeat(20)

function appendUser(session: Session, text: string): number {
  const ev = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  return ev.seq
}

function appendAssistantWithToolCall(session: Session, turn: number, callId: string): number {
  const ev = session.append('assistant/message', { stream: [],
    turn,
    step: 1,
    message: {
      role: 'assistant',
      id: 'am_' + callId,
      source: { kind: 'model', provider: 'test', model: 'test' },
      content: [
        { type: 'tool-call', id: callId, name: 'read_file', arguments: '{"path":"log.txt"}' },
        { type: 'text', text: 'on it' },
      ],
    },
  } as never, { surfaceOp: 'append' })
  return ev.seq
}

/** V4 tool/result 载荷：role:'tool' + 顶层 toolCallId/isError + content 单 text 块。 */
function appendToolResultV4(session: Session, turn: number, callId: string): number {
  const ev = session.append('tool/result', {
    turn,
    step: 1,
    message: {
      role: 'tool',
      toolCallId: callId,
      isError: false,
      content: [{ type: 'text', text: TOOL_TEXT }],
      source: { kind: 'tool', callId },
      id: 'm_' + callId,
    },
  } as never, { surfaceOp: 'append' })
  return ev.seq
}

/**
 * V4 生命周期合法的可压轮：turn/start → user → step/start → assistant(tool-call)
 * → tool/call → tool/result → step/end → turn/end。宿主 `Relationships.tool()` 要求
 * tool/result 前该 callId 已被 assistant/message 广告且 started。
 */
function buildV4CompressibleTurn(session: Session, turn: number, callId: string, userText: string): { uSeq: number; aSeq: number; rSeq: number } {
  session.append('turn/start', { turn })
  const uSeq = appendUser(session, userText)
  session.append('step/start', { turn, step: 1 } as never)
  const aSeq = appendAssistantWithToolCall(session, turn, callId)
  session.append('tool/call', { turn, step: 1, callId, name: 'read_file', arguments: '{"path":"log.txt"}' } as never)
  const rSeq = appendToolResultV4(session, turn, callId)
  session.append('step/end', { turn, step: 1 } as never)
  session.append('turn/end', { turn, reason: { kind: 'completed' } } as never)
  return { uSeq, aSeq, rSeq }
}

/** 事务 stub host：与 compaction-tx-brackets 同型，但 records/auditWarnings 必须真实给足（正控要走完全事务）。 */
function makeTxHost(): PruneTxHost {
  return {
    log: { info: () => {}, warn: () => {}, error: () => {} },
    stateOf: () => ({ records: [], auditWarnings: [], prunedNodeIndex: new Map() }) as never,
    compactSourceCommandId: undefined,
    charsPerToken: 4,
    telemetryCap: 10,
    bindSession: () => {},
    atomize: () => [],
    tombstoneMergeMinRun: 8,
    recencyGuard: 0,
    turnGuard: 0,
  } as unknown as PruneTxHost
}

// ---------------------------------------------------------------------------
// ①②③ 正控：prune-tx 三种区间形态的发射产物都必须过宿主加载链
// ---------------------------------------------------------------------------

test('① 单节点区间：pruneIntervals 发射的日志经宿主完整加载链通过', () => {
  const session = Session.create(SessionId('factor-v4-reload-single'))
  const { uSeq } = buildV4CompressibleTurn(session, 1, 'c1', 'u1:' + 'x'.repeat(400))
  // 压缩事务发生在下一轮已开启时——与真实压缩同构（被剪轮已闭、requireTurn 需开放轮）。
  session.append('turn/start', { turn: 2 })

  const result = pruneIntervals(makeTxHost(), session, [{ seqs: [uSeq], chars: 800, atoms: [] }], 1, false, [{ type: 'user' as const, text: 'CP' }])
  assert.ok(result !== null, '事务必须成功落地')

  reloadThroughHostLoadChain(session)
})

test('② 多区间（跨两轮）：summary 总跨度 span + 逐区间 shadow-price 相邻，加载链通过', () => {
  const session = Session.create(SessionId('factor-v4-reload-multi'))
  const t1 = buildV4CompressibleTurn(session, 1, 'c1', 'u1:' + 'x'.repeat(400))
  const t2 = buildV4CompressibleTurn(session, 2, 'c2', 'u2:' + 'y'.repeat(400))
  session.append('turn/start', { turn: 3 })

  const result = pruneIntervals(
    makeTxHost(), session,
    [{ seqs: [t1.uSeq], chars: 800, atoms: [] }, { seqs: [t2.uSeq], chars: 800, atoms: [] }],
    2, false,
    [{ type: 'user' as const, text: 'CP-0' }, { type: 'user' as const, text: 'CP-1' }],
  )
  assert.ok(result !== null, '事务必须成功落地')

  reloadThroughHostLoadChain(session)
})

test('③ 整轮区间 [u..r]：单条 checkpoint 墓碑整段 replace（factor 组剪生产形态），加载链通过', () => {
  const session = Session.create(SessionId('factor-v4-reload-whole-turn'))
  const { uSeq, aSeq, rSeq } = buildV4CompressibleTurn(session, 1, 'c1', 'u1:' + 'x'.repeat(400))
  session.append('turn/start', { turn: 2 })

  // 区间 seqs 必须列全 span 内每个 surface 节点（宿主 assertSourceEventReferences：replace 的
  // sourceEventSeqs 必须包含每个被遮 surface 节点）——生产中区间=连续原子全列，本构造同构。
  const result = pruneIntervals(
    makeTxHost(), session,
    [{ seqs: [uSeq, aSeq, rSeq], chars: 4000, atoms: [] }],
    1, false,
    [{ type: 'user' as const, text: 'CP' }],
  )
  assert.ok(result !== null, '事务必须成功落地')

  reloadThroughHostLoadChain(session)
})

// ---------------------------------------------------------------------------
// 负控：issue 旧 bug 形态必须被加载链拒绝（判别力证明）
// ---------------------------------------------------------------------------

test('负控：replace 先于 summary 且 seqs 只含被替换原子 ⇒ 宿主逐字拒绝（issue 报的 stored log is corrupt）', () => {
  const session = Session.create(SessionId('factor-v4-reload-negctl'))
  const { uSeq, rSeq } = buildV4CompressibleTurn(session, 1, 'c1', 'u1:' + 'x'.repeat(400))
  session.append('turn/start', { turn: 2 })

  const cid = 'argp-graph-00000000-0000-4000-8000-0000000000ff'
  session.append('compaction/start', { compactionId: cid, turn: 2 } as never)
  // 旧 bug ①：replace 先于 summary（被替换原子离开 surface）
  session.append('tool/result', {
    turn: 1,
    step: 1,
    message: {
      role: 'tool',
      toolCallId: 'c1',
      isError: false,
      content: [{ type: 'text', text: 'compressed' }],
      source: { kind: 'tool', callId: 'c1' },
      id: 'm_c1',
    },
  } as never, {
    surfaceOp: { op: 'replace', startSeq: rSeq, endSeq: rSeq },
    sourceEventSeqs: [rSeq],
  } as never)
  // 旧 bug ②：range 取整轮窗口、seqs 只含被替换原子（非发射时刻 surface 连续切片）
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
