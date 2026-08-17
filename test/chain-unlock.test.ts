/**
 * 回归测试：§5.4 反向拓扑链式解锁（静态入度缺口修复，spike 17 定性）
 *
 * 修复语义：inDegree 由 buildGraph 静态计算改为每 pass 从"未被剪原子的边"动态重推，
 * 剪除引用方后其出边消失 → 目标入度递减。
 * 用户约束：B 可能有 A/C/D 多个引用 —— 须等全部引用方被剪才解锁 B。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ArgpGraphEngine } from '../src/argp-graph-engine.ts'

async function makeEngine(config: Record<string, unknown> = {}): Promise<{ ctx: Context; engine: ArgpGraphEngine }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: 'argp chain-unlock test' } })
  await ctx.plugin(ArgpGraphEngine, { windowTokens: 100, retainTokens: 50, minSpanChars: 20, recencyGuard: 0, maxPasses: 16, ...config })
  return { ctx, engine: ctx.compaction as ArgpGraphEngine }
}

function appendUser(session: Session, text: string): void {
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
}

function appendAssistant(session: Session, text: string, turn: number): void {
  session.append('assistant/message', {
    turn,
    step: 1,
    message: createAssistantMessage({ source: { provider: 'test', model: 'test' }, content: [{ type: 'text', text }] }),
  }, { surfaceOp: 'append' })
}

const MARKER = 'THE-GATEWAY-RELEASE-PASSES-42'

/** 构造 U + (A1 cites A2) + A3(latest)，返回各原子 seq 与 session。 */
function buildSingleChain(session: Session): { a1: number; a2: number; a3: number } {
  appendUser(session, 'user anchor')
  appendAssistant(session, 'A1: ' + 'x'.repeat(280) + '\n{"cites":["' + MARKER + '"]}', 1)
  const a1 = session.events.length - 1
  appendAssistant(session, 'A2 content: ' + MARKER + ' ' + 'y'.repeat(280), 2)
  const a2 = session.events.length - 1
  appendAssistant(session, 'A3 latest: ' + 'z'.repeat(40), 3)
  const a3 = session.events.length - 1
  return { a1, a2, a3 }
}

test('chain-unlock: single cite — pruning citer unlocks citee as soft candidate (forced=false)', async () => {
  const { ctx, engine } = await makeEngine()
  try {
    const session = Session.create(SessionId('chain-unlock-single'))
    const { a1, a2, a3 } = buildSingleChain(session)
    engine.setSession(session)
    const result = await engine.compactIfNeeded({ session } as never, 'pressure', new AbortController().signal)
    assert.ok(result !== null, 'expected a compaction transaction')
    const record = engine.records[0]
    assert.ok(record !== undefined)
    assert.equal(record.forced, false, 'citee should be pruned as soft candidate, not via force_prune')
    const surface = new Set(session.surface.nodes)
    assert.equal(surface.has(a1), false, 'citer A1 should be pruned')
    assert.equal(surface.has(a2), false, 'citee A2 should be unlocked and pruned')
    assert.equal(surface.has(a3), true, 'latest A3 should stay')
  } finally {
    await ctx.fiber.dispose()
  }
})

test('chain-unlock: multi-cite — citee unlocks only after ALL citeres are pruned', async () => {
  const { ctx, engine } = await makeEngine()
  try {
    const session = Session.create(SessionId('chain-unlock-multi'))
    appendUser(session, 'user anchor')
    appendAssistant(session, 'A1: ' + 'x'.repeat(280) + '\n{"cites":["' + MARKER + '"]}', 1)
    const a1 = session.events.length - 1
    appendAssistant(session, 'A2 content: ' + MARKER + ' ' + 'y'.repeat(280), 2)
    const a2 = session.events.length - 1
    appendAssistant(session, 'A3: ' + 'w'.repeat(280) + '\n{"cites":["' + MARKER + '"]}', 2)
    const a3 = session.events.length - 1
    appendAssistant(session, 'A4 latest: ' + 'v'.repeat(40), 3)
    const a4 = session.events.length - 1
    engine.setSession(session)
    const result = await engine.compactIfNeeded({ session } as never, 'pressure', new AbortController().signal)
    assert.ok(result !== null, 'expected a compaction transaction')
    const record = engine.records[0]
    assert.ok(record !== undefined)
    assert.equal(record.forced, false, 'after both citeres pruned, citee should unlock as soft candidate')
    const surface = new Set(session.surface.nodes)
    assert.equal(surface.has(a1), false)
    assert.equal(surface.has(a2), false, 'citee A2 pruned only after A1 and A3 are gone')
    assert.equal(surface.has(a3), false)
    assert.equal(surface.has(a4), true, 'latest A4 should stay')
  } finally {
    await ctx.fiber.dispose()
  }
})

test('chain-unlock: retained citer — citee must NOT be unlocked while one citer remains (fail strategy)', async () => {
  const { ctx, engine } = await makeEngine({ degradationStrategy: 'fail' })
  try {
    const session = Session.create(SessionId('chain-unlock-retained'))
    appendUser(session, 'user anchor')
    appendAssistant(session, 'A1: ' + 'x'.repeat(280) + '\n{"cites":["' + MARKER + '"]}', 1)
    const a1 = session.events.length - 1
    appendAssistant(session, 'A2 content: ' + MARKER + ' ' + 'y'.repeat(280), 2)
    const a2 = session.events.length - 1
    // A3 (latest turn, never prunable) still cites A2 → A2 keeps effective in-degree 1
    appendAssistant(session, 'A3 latest: ' + 'w'.repeat(280) + '\n{"cites":["' + MARKER + '"]}', 3)
    const a3 = session.events.length - 1
    engine.setSession(session)
    const result = await engine.compactIfNeeded({ session } as never, 'pressure', new AbortController().signal)
    assert.equal(result, null, 'fail strategy: over budget but citee protected by retained citer → no transaction')
    const surface = new Set(session.surface.nodes)
    assert.equal(surface.has(a2), true, 'citee A2 must stay while A3 still cites it')
    assert.equal(surface.has(a3), true)
  } finally {
    await ctx.fiber.dispose()
  }
})
