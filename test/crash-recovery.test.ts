/**
 * A7：事务账目重建 + 未闭合审计 + 崩溃注入测试。
 * - rebuildLedgerFromLog：幂等，无 session 时无操作
 * - rebuildLedgerFromLog：session 含未闭合 compaction/start → push auditWarnings
 * - rebuildLedgerFromLog：session 含完整事务（start→prune→tombstone→end）→ 重建 records + prunedNodeIndex
 * - 连续两次调用幂等
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { CompactionEngine, CompactionId } from '@deepseek-ai/dsh-compaction'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ArgpGraphEngine } from '../src/argp-graph-engine.ts'

async function makeEngine(): Promise<{ ctx: Context; engine: ArgpGraphEngine }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: 'argp 0-llm test persona' } })
  await ctx.plugin(ArgpGraphEngine, {
    windowTokens: 100,
    retainTokens: 50,
    minSpanChars: 20,
    recencyGuard: 0,
    maxPasses: 16,
  })
  return { ctx, engine: ctx.compaction as ArgpGraphEngine }
}

function appendUser(session: Session, text: string): void {
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
}

/** 模拟真实事务事件形状：compaction/start → compaction/prune → tombstone(replace) → compaction/end */
function pushTransaction(session: Session, id: string): { startSeq: number; pruneSeq: number; endSeq: number; shadowedSeqs: number[] } {
  const u1 = session.events.length
  appendUser(session, 'shadowed user text ' + id)
  const a1 = session.events.length
  appendUser(session, 'shadowed answer text ' + id)
  const shadowedSeqs = [u1, a1]
  const startSeq = session.events.length
  session.append('compaction/start', { compactionId: CompactionId(id), turn: 1 })
  const pruneSeq = session.events.length
  session.append('compaction/prune', {
    shadowedRange: { start: u1, end: a1 },
    shadowedSeqs,
    shadowedTokenCount: 10,
  })
  const tombstoneSeq = session.events.length
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: '[elided seq=' + u1 + '..' + a1 + ']' }],
    source: { kind: 'plugin', plugin: 'argp-graph' },
  }), {
    surfaceOp: { op: 'replace', start: u1, end: a1 },
    sourceEventSeqs: [startSeq, pruneSeq, ...shadowedSeqs],
  })
  const endSeq = session.events.length
  session.append('compaction/end', { compactionId: CompactionId(id), turn: 1 })
  return { startSeq, pruneSeq, endSeq, shadowedSeqs }
}

test('rebuildLedgerFromLog: no-op when session is null', async () => {
  const { ctx, engine } = await makeEngine()
  try {
    engine.rebuildLedgerFromLog()
    assert.equal(engine.records.length, 0, 'no session → no records')
    assert.equal(engine.auditWarnings.length, 0)
  } finally {
    await ctx.fiber.dispose()
  }
})

test('rebuildLedgerFromLog: unclosed start produces audit warning (A7)', async () => {
  const { ctx, engine } = await makeEngine()
  try {
    const session = Session.create(SessionId('crash-unclosed'))
    engine.setSession(session)
    // 只注入 compaction/start，没有 prune/end → 未闭合（崩溃注入场景）
    const startSeq = session.events.length
    session.append('compaction/start', { compactionId: CompactionId('c1'), turn: 1 })
    assert.equal(engine.records.length, 0)
    engine.rebuildLedgerFromLog()
    assert.equal(engine.auditWarnings.length, 1, 'must push exactly one warning')
    assert.ok(engine.auditWarnings[0]!.includes('unclosed'), 'warning mentions unclosed')
    assert.ok(engine.auditWarnings[0]!.includes('c1'), 'warning mentions compactionId')
    assert.ok(engine.auditWarnings[0]!.includes(String(startSeq)), 'warning mentions start seq')
    assert.equal(engine.records.length, 0, 'unclosed start → no record (graceful skip)')
  } finally {
    await ctx.fiber.dispose()
  }
})

test('rebuildLedgerFromLog: complete transaction rebuilds records + prunedNodeIndex (A7)', async () => {
  const { ctx, engine } = await makeEngine()
  try {
    const session = Session.create(SessionId('crash-complete'))
    engine.setSession(session)
    const { startSeq, pruneSeq, endSeq, shadowedSeqs } = pushTransaction(session, 'c2')
    // 事务在 setSession 之后注入：记录在真实运行时由 pruneIntervals 推送，
    // 但此处模拟「账目丢失、仅日志在」的 resume 场景 → 显式清空 records 再重建
    engine.records.length = 0
    engine.rebuildLedgerFromLog()
    assert.equal(engine.records.length, 1, '完整事务 → 重建 1 条 record')
    const rec = engine.records[0]!
    assert.equal(rec.compactionId, 'c2')
    assert.equal(rec.startEventSeq, startSeq)
    assert.equal(rec.summaryEventSeq, pruneSeq)
    assert.equal(rec.endEventSeq, endSeq)
    assert.deepEqual(rec.shadowedSeqs, shadowedSeqs)
    assert.equal(rec.intervals.length, 1)
    // prunedNodeIndex 包含被剪节点
    for (const seq of shadowedSeqs) {
      assert.ok(engine.prunedNodeIndex.has(seq), 'seq=' + seq + ' in prunedNodeIndex')
    }
    // shadowed 集合包含被剪节点（recall 能查到）
    const shadowed = (engine as unknown as { shadowedSeqsOf(s: Session): Set<number> }).shadowedSeqsOf(session)
    for (const seq of shadowedSeqs) assert.ok(shadowed.has(seq), 'seq=' + seq + ' in shadowedSeqs')
  } finally {
    await ctx.fiber.dispose()
  }
})

test('rebuildLedgerFromLog: idempotent — second call does not duplicate records', async () => {
  const { ctx, engine } = await makeEngine()
  try {
    const session = Session.create(SessionId('crash-idem'))
    engine.setSession(session)
    pushTransaction(session, 'c3')
    engine.records.length = 0
    engine.rebuildLedgerFromLog()
    const firstCount = engine.records.length
    assert.equal(firstCount, 1)
    engine.rebuildLedgerFromLog() // 第二次幂等调用
    assert.equal(engine.records.length, firstCount, 'second call must not duplicate records')
  } finally {
    await ctx.fiber.dispose()
  }
})

test('rebuildLedgerFromLog: multiple transactions each produce one record', async () => {
  const { ctx, engine } = await makeEngine()
  try {
    const session = Session.create(SessionId('crash-multi'))
    engine.setSession(session)
    pushTransaction(session, 'tx-a')
    pushTransaction(session, 'tx-b')
    pushTransaction(session, 'tx-c')
    engine.records.length = 0
    engine.rebuildLedgerFromLog()
    assert.equal(engine.records.length, 3, '3 个完整事务 → 3 条 record')
    const ids = engine.records.map(r => r.compactionId)
    assert.deepEqual(ids, ['tx-a', 'tx-b', 'tx-c'])
  } finally {
    await ctx.fiber.dispose()
  }
})
test('resume flow: new engine binding an old session auto-rebuilds ledger via bindSession (Q3)', async () => {
  const { ctx, engine: writer } = await makeEngine()
  let session!: Session
  try {
    // 先造一个含完整事务的 session（模拟崩溃前写入的日志）
    session = Session.create(SessionId('crash-resume'))
    writer.setSession(session)
    const u1 = session.events.length
    appendUser(session, 'shadowed resume user ' + 'x'.repeat(40))
    const a1 = session.events.length
    appendUser(session, 'shadowed resume answer ' + 'y'.repeat(40))
    const shadowedSeqs = [u1, a1]
    const startSeq = session.events.length
    session.append('compaction/start', { compactionId: CompactionId('tx-resume'), turn: 1 })
    session.append('compaction/prune', { shadowedRange: { start: u1, end: a1 }, shadowedSeqs, shadowedTokenCount: 10 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '[elided seq=' + u1 + '..' + a1 + ']' }],
      source: { kind: 'plugin', plugin: 'argp-graph' },
    }), { surfaceOp: { op: 'replace', start: u1, end: a1 }, sourceEventSeqs: [startSeq, ...shadowedSeqs] })
    session.append('compaction/end', { compactionId: CompactionId('tx-resume'), turn: 1 })
    // writer 已通过 setSession 绑定该 session（此时 setSession 时日志为空，无重建）
    // 现在模拟崩溃：新 engine 实例绑定同一 session（resume 流程）→ 必须自动重建
  } finally {
    await ctx.fiber.dispose()
  }
  const { ctx: ctx2, engine: resumed } = await makeEngine()
  try {
    resumed.setSession(session)
    assert.equal(resumed.records.length, 1, 'resume: ledger auto-rebuilt from log')
    const rec = resumed.records[0]!
    assert.equal(rec.compactionId, 'tx-resume')
    assert.equal(rec.startEventSeq, 2)
    assert.ok(rec.shadowedSeqs.includes(0) && rec.shadowedSeqs.includes(1))
    // type/turn 反查（问题 8）：被剪节点类型为 U（两个都是 user/message，非 plugin 源）
    const idx = resumed.prunedNodeIndex
    for (const seq of [0, 1]) {
      const info = [...idx.values()].find(v => v.seq === seq)
      assert.ok(info !== undefined, 'seq=' + seq + ' in prunedNodeIndex after resume')
      assert.equal(info.type, 'U', 'rebuilt type must be U for user/message nodes (Q8)')
      assert.ok(info.turn >= 0, 'rebuilt turn must be real (Q8)')
    }
    // 幂等：再次绑定同一 session 不重复重建
    resumed.setSession(session)
    assert.equal(resumed.records.length, 1, 're-bind same session must not duplicate')
    // auditWarnings 为空（事务完整）
    assert.equal(resumed.auditWarnings.length, 0)
  } finally {
    await ctx2.fiber.dispose()
  }
})

test('resume flow: unclosed start on an old session produces warning once (Q3)', async () => {
  const { ctx, engine: writer } = await makeEngine()
  let session!: Session
  try {
    session = Session.create(SessionId('crash-resume-unclosed'))
    writer.setSession(session)
    appendUser(session, 'shadowed text ' + 'z'.repeat(40))
    session.append('compaction/start', { compactionId: CompactionId('tx-orphan'), turn: 1 })
  } finally {
    await ctx.fiber.dispose()
  }
  const { ctx: ctx2, engine: resumed } = await makeEngine()
  try {
    resumed.setSession(session)
    assert.equal(resumed.auditWarnings.length, 1, 'resume: unclosed start surfaces as warning')
    assert.ok(resumed.auditWarnings[0]!.includes('unclosed'))
    assert.ok(resumed.auditWarnings[0]!.includes('tx-orphan'))
    assert.equal(resumed.records.length, 0, 'unclosed start must not fabricate a record')
    // 重复绑定不重复告警
    resumed.setSession(session)
    assert.equal(resumed.auditWarnings.length, 1, 're-bind must not duplicate warning')
  } finally {
    await ctx2.fiber.dispose()
  }
})