/**
 * /compact 手动压缩链路回归测试（command-compact → ctx.compaction.compactNow）。
 *
 * command-compact（官方包）调用签名：
 *   ctx.compaction.compactNow(invocation.agent, invocation.signal, invocation.commandId)
 * 断言：
 *  1) compactNow 在可剪会话返回结果：选最老 A/R 连续块，U/X 不参剪
 *  2) compactNow 无可剪内容（全 U）→ null（UI 显示 "No compactable history yet."）
 *  3) sourceCommandId 透传：事务事件 + records 台账带发起命令 ID（presentation correlation）
 *  4) runMaintenance 包装被调用（ManualCompactAgentContext 空闲串行化语义）
 *  5) compactRegion 手动 span 含 U/X → 拒绝（P5 语义）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { ManualCompactAgentContext } from '@deepseek-ai/dsh-compaction'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
import { asSeq, asSeqs } from '../src/log-access.ts'
import { ArgpGraphEngine } from '../src/argp-graph-engine.ts'

async function makeEngine(config: Record<string, unknown> = {}): Promise<{ ctx: Context; engine: ArgpGraphEngine }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: 'argp manual-compact test' } })
  await ctx.plugin(ArgpGraphEngine, { windowTokens: 100, retainTokens: 50, minSpanChars: 20, recencyGuard: 0, maxPasses: 16, ...config })
  return { ctx, engine: ctx.compaction as ArgpGraphEngine }
}

function appendUser(session: Session, text: string, turn: number): void {
  session.append('user/message', {
    turn,
    ...createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
  } as never, { surfaceOp: 'append' })
}

function appendAssistant(session: Session, text: string, turn: number): void {
  session.append('assistant/message', { stream: [], 
    turn,
    step: 1,
    message: createAssistantMessage({ source: { provider: 'test', model: 'test' }, content: [{ type: 'text', text }] }),
  }, { surfaceOp: 'append' })
}

/** U + 大 A1/A2（turn1，可剪）+ U + 最新 A3（turn3，受 turnGuard 保护）。 */
function buildPrunableSession(): Session {
  const session = Session.create(SessionId('manual-prunable'))
  appendUser(session, 'u1 anchor', 1)
  appendAssistant(session, 'A1: ' + 'x'.repeat(200), 1)
  appendAssistant(session, 'A2: ' + 'y'.repeat(200), 1)
  appendUser(session, 'u2 anchor', 2)
  appendAssistant(session, 'A3 latest: ' + 'z'.repeat(60), 3)
  return session
}

function stubManualAgent(session: Session, maintenanceCalls: number[]): ManualCompactAgentContext {
  return {
    session,
    runMaintenance: (async (task: (signal: AbortSignal) => Promise<unknown>) => {
      maintenanceCalls[0] += 1
      return task(new AbortController().signal)
    }) as ManualCompactAgentContext['runMaintenance'],
  } as ManualCompactAgentContext
}

test('/compact: 可剪会话返回结果，只剪最老 A/R 块（U/X 不参剪）', async () => {
  const { ctx, engine } = await makeEngine()
  try {
    const session = buildPrunableSession()
    engine.setSession(session)
    const calls: number[] = [0]
    const result = await engine.compactNow(stubManualAgent(session, calls), new AbortController().signal)
    assert.ok(result !== null, 'prunable session must compact')
    assert.ok(result.shadowedSeqs.length >= 1)
    assert.ok(calls[0] === 1, 'runMaintenance must wrap the operation')
    // 台账：事务被记录
    assert.ok(engine.records.length >= 1)
    const surface = new Set(session.surface.nodes)
    // seq 布局（无 turn/start，U1=0）：0=U1, 1=A1, 2=A2, 3=U2, 4=A3
    assert.ok(!surface.has(asSeq(1)) && !surface.has(asSeq(2)), 'A1/A2 must be pruned')
    assert.ok(surface.has(asSeq(0)) && surface.has(asSeq(3)) && surface.has(asSeq(4)), 'U anchors and latest A must survive')
  } finally {
    await ctx.fiber.dispose()
  }
})

test('/compact: 无可剪内容（全 U）→ null', async () => {
  const { ctx, engine } = await makeEngine()
  try {
    const session = Session.create(SessionId('manual-all-u'))
    for (let turn = 1; turn <= 3; turn += 1) appendUser(session, 'u' + turn + ' anchor ' + 'z'.repeat(40), turn)
    engine.setSession(session)
    const result = await engine.compactNow(stubManualAgent(session, [0]), new AbortController().signal)
    assert.equal(result, null, 'all-U session has no compactable A/R block')
    assert.equal(engine.records.length, 0, 'no transaction may be recorded')
  } finally {
    await ctx.fiber.dispose()
  }
})

test('/compact: sourceCommandId 透传到事务事件与台账', async () => {
  const { ctx, engine } = await makeEngine()
  try {
    const session = buildPrunableSession()
    engine.setSession(session)
    const commandId = 'cmd-compact-42' as unknown as CommandId
    const result = await engine.compactNow(stubManualAgent(session, [0]), new AbortController().signal, commandId)
    assert.ok(result !== null)
    const record = engine.records[0]
    assert.ok(record !== undefined)
    assert.equal(record.sourceCommandId, 'cmd-compact-42', 'record must carry the initiating command id')
    // 事务事件（compaction/start）data 带 sourceCommandId
    const startEvent = session.snapshotEvents().find(e => e.type === 'compaction/start')
    assert.ok(startEvent !== undefined)
    assert.equal((startEvent.data as { sourceCommandId?: string }).sourceCommandId, 'cmd-compact-42')
    // 自动压缩路径不受污染：连续 compactIfNeeded 后新记录无 sourceCommandId
    const recordCount = engine.records.length
    await engine.compactIfNeeded({ session } as never, 'pressure', new AbortController().signal)
    const later = engine.records.slice(recordCount).find(r => r.sourceCommandId !== undefined)
    assert.equal(later, undefined, 'automatic compactions must NOT inherit the command id')
  } finally {
    await ctx.fiber.dispose()
  }
})

test('/compact: sourceCommandId 一致性——start/summary/end 三事件同值（加载期 fold 契约）', async () => {
  // 回归锁定（2026-09-23 P0）：旧实现只给 compaction/start 带 sourceCommandId，
  // summary/end 不带。宿主 dsh-compaction invariant（validateSourceCommandId）与
  // v3-to-v4 relationships.compactionOwner 都要求三事件携带**同一个** sourceCommandId，
  // 否则 /compact 过的会话在加载期 fold 时 throw "no matching compaction/start"（实测
  // session-bffe40b6 无法重新加载）。本测试在数据层直接断言三事件同值——确定性、
  // 不依赖 invariant 是否被安装，故任何回归都会在此失败。
  const { ctx, engine } = await makeEngine()
  try {
    const session = buildPrunableSession()
    engine.setSession(session)
    const commandId = 'cmd-compact-scid' as unknown as CommandId
    const result = await engine.compactNow(stubManualAgent(session, [0]), new AbortController().signal, commandId)
    assert.ok(result !== null, 'prunable session must compact')
    const events = session.snapshotEvents()
    const starts = events.filter(e => e.type === 'compaction/start')
    const summaries = events.filter(e => e.type === 'compaction/summary')
    const ends = events.filter(e => e.type === 'compaction/end')
    assert.equal(starts.length, 1, 'exactly one compaction/start')
    assert.equal(summaries.length, 1, 'exactly one compaction/summary')
    assert.equal(ends.length, 1, 'exactly one compaction/end')
    const startScid = (starts[0]!.data as { sourceCommandId?: string }).sourceCommandId
    const summaryScid = (summaries[0]!.data as { sourceCommandId?: string }).sourceCommandId
    const endScid = (ends[0]!.data as { sourceCommandId?: string }).sourceCommandId
    assert.equal(startScid, commandId, 'start carries the initiating command id')
    assert.equal(summaryScid, startScid, 'summary sourceCommandId must equal start (load-time fold contract)')
    assert.equal(endScid, startScid, 'end sourceCommandId must equal start (load-time fold contract)')
    // 第五个受校验事件：压缩 checkpoint（user/message + compactCheckpointSource）。
    // 宿主 invariant validateCheckpoint → validateSourceCommandId 要求 checkpoint 的
    // source.sourceCommandId 与 start 同值；旧实现 compactCheckpointSource(compactionId)
    // 只传 compactionId（sourceCommandId 缺省 undefined）⇒ 手动 /compact 时同样违约。
    const checkpoints = events.filter(e => e.type === 'user/message'
      && (e.data as { source?: { kind?: string } }).source?.kind === 'compact-checkpoint')
    assert.ok(checkpoints.length >= 1, 'graph prune must emit at least one compact-checkpoint')
    for (const cp of checkpoints) {
      const cpScid = (cp.data as { source: { sourceCommandId?: string } }).source.sourceCommandId
      assert.equal(cpScid, startScid, 'checkpoint sourceCommandId must equal start (validateCheckpoint)')
    }
  } finally {
    await ctx.fiber.dispose()
  }
})

test('compactRegion: 手动 span 含 U/X → 拒绝（P5 语义）', async () => {
  const { ctx, engine } = await makeEngine()
  try {
    const session = buildPrunableSession()
    engine.setSession(session)
    // span 覆盖 U1(seq1)..A2(seq3) → 含 U → 必须抛错
    await assert.rejects(
      engine.compactRegion(1, 3, { session } as never),
      /does not prune U\/X spans/,
    )
  } finally {
    await ctx.fiber.dispose()
  }
})

/** 多段会话：U A A | U A A | U A（末段 turnGuard 保护）。真实会话即此形态。 */
function buildSegmentedSession(): Session {
  const session = Session.create(SessionId('manual-segmented'))
  appendUser(session, 'u1 anchor', 1)
  appendAssistant(session, 'A1: ' + 'x'.repeat(200), 1)
  appendAssistant(session, 'A2: ' + 'y'.repeat(200), 1)
  appendUser(session, 'u2 anchor', 2)
  appendAssistant(session, 'A3: ' + 'p'.repeat(200), 2)
  appendAssistant(session, 'A4: ' + 'q'.repeat(200), 2)
  appendUser(session, 'u3 anchor', 3)
  appendAssistant(session, 'A5 latest: ' + 'z'.repeat(200), 4)
  return session
}

test('/compact: 被 U 切碎的多段 A/R 全部剪除（旧实现只剪最老一段）', async () => {
  const { ctx, engine } = await makeEngine()
  try {
    const session = buildSegmentedSession()
    engine.setSession(session)
    const result = await engine.compactNow(stubManualAgent(session, [0]), new AbortController().signal)
    assert.ok(result !== null, 'segmented session must compact')
    // seq 布局（无 turn/start）：0=U1, 1=A1, 2=A2, 3=U2, 4=A3, 5=A4, 6=U3, 7=A5
    assert.ok(
      result.shadowedSeqs.length >= 4,
      'both A/R segments must be pruned, got ' + result.shadowedSeqs.length,
    )
    const surface = new Set(session.surface.nodes)
    for (const pruned of [1, 2, 4, 5]) {
      assert.ok(!surface.has(asSeq(pruned)), 'A/R at seq ' + pruned + ' must be pruned')
    }
    for (const kept of [0, 3, 6, 7]) {
      assert.ok(surface.has(asSeq(kept)), 'U anchor / protected latest A at seq ' + kept + ' must survive')
    }
  } finally {
    await ctx.fiber.dispose()
  }
})
