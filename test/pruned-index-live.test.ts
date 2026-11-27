/**
 * §8-11 已剪明细目录活体入账（2026-11-27）。
 *
 * 病灶：`prunedNodeIndex`/`prunedNodeTotal` 此前唯一入账点在 `rebuildLedgerFromLog`
 * （冷 resume 才跑）——活体事务不入账，`/argp` 的 `pruned index` 列在 compact 后
 * 不重启的进程恒报 0。
 *
 * 锁面：
 *  - 活体事务成功收尾即入账：records.shadowedSeqs 的每个 seq 都在目录里，
 *    计数 = 去重后 seq 数，type 与 prunedAtoms 逐一致，firstLine 非空；
 *  - 冷重放不双计：同进程显式 rebuildLedgerFromLog 撞进活体已入账的 seq，
 *    被 notePrunedNode 的 seq 幂等吞掉（total/size 不变，占位 firstLine 不覆盖真值）；
 *  - tombstone-merge 臂 `atoms: []` 的元数据补齐走日志反查：type（U/A/R 分类与
 *    重建侧同口径）与 turn 从事件恢复。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ArgpEngine } from '../src/argp-engine.ts'
import { pruneIntervals } from '../src/prune-tx.ts'
import { createSessionRuntimeState, type SessionRuntimeState } from '../src/session-state.ts'
import type { FactorEngine } from '../src/factor/engine.ts'

interface TestEngine {
  factor: FactorEngine
  bindSession(session: Session): void
}

async function boot(): Promise<{ engine: ArgpEngine; internals: TestEngine }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(ArgpEngine, { engine: 'factor', windowTokens: 100, retainTokens: 50, recencyGuard: 0 })
  const engine = ctx.compaction as ArgpEngine
  return { engine, internals: engine as unknown as TestEngine }
}

function makeSession(id: string): Session {
  const session = Session.create(SessionId(id))
  session.append('system/message', { content: 'persona' } as never, { surfaceOp: 'append' })
  return session
}

function appendUser(session: Session, text: string): void {
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
}

function appendGroup(session: Session, turn: number, callId: string, tool: string, args: string, resultText: string): void {
  session.append('assistant/message', {
    stream: [], turn, step: 1,
    message: createAssistantMessage({
      source: { provider: 'test', model: 'test' },
      content: [{ type: 'text', text: 'doing ' + tool }, { type: 'tool-call', id: callId, name: tool, arguments: args } as never],
    }),
  } as never, { surfaceOp: 'append' })
  session.append('tool/call', { turn, callId, name: tool, arguments: args } as never)
  session.append('tool/result', {
    turn, step: 1,
    message: {
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: resultText }], isError: false }],
      source: { kind: 'tool', callId },
      id: 'm_' + callId,
    },
  } as never, { surfaceOp: 'append' })
}

/** 铺两组读文件并触发一笔真实剪枝事务（与 vocab-context 夹具同形）。 */
function prunedReadPair(session: Session, factor: FactorEngine): void {
  appendUser(session, '开始任务')
  appendGroup(session, 1, 'c1', 'read', '{"file_path":"C:/Proj/ctx-a.ts"}', 'OLD CONTENT'.repeat(50))
  appendGroup(session, 2, 'c2', 'read', '{"file_path":"C:/Proj/ctx-b.ts"}', 'NEW CONTENT'.repeat(50))
  assert.ok(factor.compactIfNeeded(session, 1000) !== null, '前置剪枝必须发射')
}

test('活体事务成功收尾即入账：shadowedSeqs 全数在目录，计数=去重 seq 数', async () => {
  const { internals } = await boot()
  const session = makeSession('pruned-index-live')
  internals.bindSession(session)
  prunedReadPair(session, internals.factor)
  const st = (internals as unknown as { stateOf(s: Session): SessionRuntimeState }).stateOf(session)
  const rec = st.records[st.records.length - 1]
  assert.ok(rec !== undefined && rec.shadowedSeqs.length > 0, '前置事务必须留下 shadowedSeqs')
  const uniq = new Set(rec.shadowedSeqs)
  assert.equal(st.prunedNodeTotal, uniq.size, '★活体不入账 ⇒ 恒 0（§8-11 病灶）；修复后计数=去重后 seq 数')
  for (const seq of uniq) {
    assert.ok(st.prunedNodeIndex.has(seq), '被剪 seq ' + seq + ' 必须在目录里')
  }
  for (const atom of rec.prunedAtoms) {
    assert.equal(st.prunedNodeIndex.get(atom.seq)?.type, atom.type, '目录 type 必须与事务 prunedAtoms 一致')
  }
  assert.ok(rec.prunedAtoms.some(a => a.type === 'R'), '夹具必须含工具结果原子（type 分类的判别面）')
  const anyInfo = st.prunedNodeIndex.get(rec.prunedAtoms[0]!.seq)
  assert.ok(anyInfo !== undefined && anyInfo.firstLine.length > 0, '活体明细的 firstLine 必须是真实文本（非重建占位串）')
})

test('同进程冷重放不双计：重建撞进活体已入账 seq 被幂等吞掉', async () => {
  const { engine, internals } = await boot()
  const session = makeSession('pruned-index-replay')
  internals.bindSession(session)
  prunedReadPair(session, internals.factor)
  const st = (internals as unknown as { stateOf(s: Session): SessionRuntimeState }).stateOf(session)
  assert.ok(st.prunedNodeTotal > 0)
  const totalBefore = st.prunedNodeTotal
  const sizeBefore = st.prunedNodeIndex.size
  const firstLineSample = [...st.prunedNodeIndex.values()][0]?.firstLine ?? ''
  // 模拟冷进程重放（同桶显式 rebuild）：同一批 seq 再走一遍 notePrunedNode。
  engine.rebuildLedgerFromLog()
  assert.equal(st.prunedNodeTotal, totalBefore, '重放撞进已入账 seq 不得二次计数')
  assert.equal(st.prunedNodeIndex.size, sizeBefore, '重放不得撑大目录')
  assert.equal([...st.prunedNodeIndex.values()][0]?.firstLine, firstLineSample, '重建占位串 (rebuilt from log) 不得覆盖活体真实 firstLine')
})

test('tombstone-merge 臂 atoms=[] 的明细走日志反查：type/turn 从事件恢复', () => {
  // 直接驱动共用咽喉（与桩归并臂同一条 pruneIntervals 路）：intervals 只带 seqs、
  // atoms 置空——元数据必须由日志反查补齐（merge 臂 factor/engine.ts 就是这个形状）。
  const st = createSessionRuntimeState()
  const host = {
    bindSession: (): void => {},
    atomize: () => [],
    log: { info: () => {}, warn: () => {}, error: () => {} },
    stateOf: () => st,
    compactSourceCommandId: undefined,
    charsPerToken: 3.5,
    telemetryCap: 50,
  }
  const session = makeSession('pruned-index-merge-arm')
  appendGroup(session, 7, 'c9', 'bash', '{"command":"npm run probe"}', 'OUT ' + 'x'.repeat(300))
  const nodes = [...session.surface.nodes]
  const aSeq = nodes[nodes.length - 2] as number
  const rSeq = nodes[nodes.length - 1] as number
  const res = pruneIntervals(
    host as never, session,
    [{ seqs: [aSeq, rSeq], chars: 320, atoms: [] }],
    0, true,
    [{ type: 'user', text: '[elided merged stub]' }],
    'tombstone-merge',
  )
  assert.ok(res !== null, '事务必须落地')
  assert.equal(st.prunedNodeTotal, 2, 'atoms=[] 也必须全数入账')
  assert.equal(st.prunedNodeIndex.get(aSeq)?.type, 'A', 'assistant/message 反查为 A')
  assert.equal(st.prunedNodeIndex.get(rSeq)?.type, 'R', 'tool/result 反查为 R')
  assert.equal(st.prunedNodeIndex.get(aSeq)?.turn, 7, 'turn 从事件恢复')
  assert.match(st.prunedNodeIndex.get(rSeq)?.firstLine ?? '', /OUT /, 'firstLine 从日志文本恢复')
})
