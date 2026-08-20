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
import { ArgpGraphEngine } from '../src/argp-graph-engine.ts'

async function makeEngine(config: Record<string, unknown> = {}): Promise<{ ctx: Context; engine: ArgpGraphEngine }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: 'argp manual-compact test' } })
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
  session.append('assistant/message', {
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
    assert.ok(!surface.has(1) && !surface.has(2), 'A1/A2 must be pruned')
    assert.ok(surface.has(0) && surface.has(3) && surface.has(4), 'U anchors and latest A must survive')
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
    const startEvent = session.events.find(e => e.type === 'compaction/start')
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
