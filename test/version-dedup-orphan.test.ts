/**
 * 版本链去重孤儿 tool 消息修复回归（方案 A，2026-08-23）。
 *
 * 病灶：findVersionDuplicates 的 addPair 剪 issuer A（tool-call）时，对 R 加了
 * 「inDegree==0 才连带剪」的守卫。当 A 因版本去重被剪、而其 R 被后续 cites 引用
 * （inDegree>0）时：A 的 tool-call 蒸发、R 保留 → role:"tool" 无 tool_calls → provider 400。
 *
 * 方案 A 语义：剪 A 时无条件连带剪其全部 R，与 pass 循环（:1693 附近）语义一致。
 * 版本去重 = 旧快照整组淘汰；R 的 cites 引用在 newer 版本上会重建，旧 R 与引用一起剪。
 * 不保护被 cites 的旧 R（否则 surface 膨胀、版本链去重失效）；无孤儿由连带剪保证。
 *
 * 本测试只验证「无孤儿」不变式（A+R 同生共死），不验证「保护被 cites 旧快照」。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ArgpGraphEngine } from '../src/argp-graph-engine.ts'

async function makeEngine(config: Record<string, unknown> = {}): Promise<{ ctx: Context; engine: ArgpGraphEngine }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: 'argp version-dedup orphan test' } })
  await ctx.plugin(ArgpGraphEngine, { windowTokens: 100, retainTokens: 50, minSpanChars: 20, recencyGuard: 0, maxPasses: 16, ...config })
  return { ctx, engine: ctx.compaction as ArgpGraphEngine }
}

function appendUser(session: Session, text: string): void {
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
}

function appendAssistant(session: Session, text: string, turn: number): number {
  session.append('assistant/message', {
    turn,
    step: 1,
    message: createAssistantMessage({ source: { provider: 'test', model: 'test' }, content: [{ type: 'text', text }] }),
  }, { surfaceOp: 'append' })
  return session.events.length - 1
}

function appendToolCallAssistant(session: Session, turn: number, callId: string, argumentsStr: string): number {
  session.append('assistant/message', {
    turn,
    step: 1,
    message: createAssistantMessage({
      source: { provider: 'test', model: 'test' },
      content: [{ type: 'tool-call', id: callId as never, name: 'read_file', arguments: argumentsStr }],
    }),
  }, { surfaceOp: 'append' })
  return session.events.length - 1
}

function appendToolResult(session: Session, turn: number, callId: string, text: string): number {
  session.append('tool/result', {
    turn,
    step: 1,
    message: createToolResultMessage({ callId: callId as never, content: [{ type: 'text', text }], isError: false }),
  }, { surfaceOp: 'append' })
  return session.events.length - 1
}

/** wire 配对不变式：surface 上每个存活 tool-call 都有应答（含占位），无孤儿。 */
function assertNoOrphan(session: Session): void {
  const callIds = new Set<string>()
  const resultIds = new Set<string>()
  for (const seq of session.surface.nodes) {
    const ev = session.events[seq] as { type: string; data?: { message?: { content?: { type: string; id?: string; toolCallId?: string }[]; source?: { callId?: string } } } }
    const blocks = ev.data?.message?.content ?? []
    for (const b of blocks) {
      if (b.type === 'tool-call' && b.id !== undefined) callIds.add(b.id)
      if (b.type === 'tool-result' && b.toolCallId !== undefined) resultIds.add(b.toolCallId)
    }
    if (ev.data?.message?.source?.callId !== undefined) resultIds.add(ev.data.message.source.callId)
  }
  for (const id of callIds) assert.ok(resultIds.has(id), 'unanswered tool-call on surface (orphan): ' + id)
}

test('version-dedup: issuer A with cited R — A+R pruned together, no orphan (方案 A)', async () => {
  const { ctx, engine } = await makeEngine({ enableOverlapChain: false })
  try {
    const session = Session.create(SessionId('verdedup-orphan-cited'))
    appendUser(session, 'user anchor')

    // 旧版本 read：A_old 发起 read_file game.html（同 arguments 将与 A_new 触发 A 全等去重）
    const aOld = appendToolCallAssistant(session, 1, 'call_1', '{"path":"game.html"}')
    const rOld = appendToolResult(session, 1, 'call_1', 'MARKER-V1 file content ' + 'r'.repeat(200))

    // 后续 assistant cites 旧 R → R_old inDegree=1（被引用）
    appendAssistant(session, 'edit uses old file snapshot\n{"cites":["MARKER-V1"]}', 2)

    // 新版本 read：A_new 相同 read_file（A 全等去重把 A_old 当 older）
    const aNew = appendToolCallAssistant(session, 3, 'call_2', '{"path":"game.html"}')
    const rNew = appendToolResult(session, 3, 'call_2', 'MARKER-V2 file content ' + 'r'.repeat(200))

    appendAssistant(session, 'latest anchor.', 4)

    engine.setSession(session)
    const result = await engine.compactIfNeeded({ session } as never, 'pressure', new AbortController().signal)
    assert.ok(result !== null, 'compaction must trigger')

    const surface = new Set(session.surface.nodes)
    // 方案 A：A_old 与 R_old 同生共死（连带剪），无孤儿；新版本 A_new 保留（其 R 若被剪走占位墓碑）
    assert.equal(surface.has(aOld), false, 'A_old should be deduped (连带剪 R_old)')
    assert.equal(surface.has(rOld), false, 'R_old should be pruned together with A_old')
    assert.ok(surface.has(aNew), 'newer A_new stays as representative')

    // 核心不变式：无孤儿（A_new 的 tool-call 必有应答，含 R_new 占位墓碑）
    assertNoOrphan(session)
  } finally {
    await ctx.fiber.dispose()
  }
})

test('version-dedup: uncited R — A+R deduped, no orphan (方案 A baseline)', async () => {
  const { ctx, engine } = await makeEngine({ enableOverlapChain: false })
  try {
    const session = Session.create(SessionId('verdedup-orphan-uncited'))
    appendUser(session, 'user anchor')

    // 旧版本 read：R_old 不被 cites
    const aOld = appendToolCallAssistant(session, 1, 'call_1', '{"path":"game.html"}')
    const rOld = appendToolResult(session, 1, 'call_1', 'file content v1 ' + 'r'.repeat(200))

    // 中间 assistant 不 cites 旧 R
    appendAssistant(session, 'unrelated filler ' + 'x'.repeat(100), 2)

    // 新版本 read：同 arguments → A 全等去重
    const aNew = appendToolCallAssistant(session, 3, 'call_2', '{"path":"game.html"}')
    appendToolResult(session, 3, 'call_2', 'file content v2 ' + 'r'.repeat(200))

    appendAssistant(session, 'latest anchor.', 4)

    engine.setSession(session)
    const result = await engine.compactIfNeeded({ session } as never, 'pressure', new AbortController().signal)
    assert.ok(result !== null, 'compaction must trigger')

    const surface = new Set(session.surface.nodes)
    assert.equal(surface.has(aOld), false, 'uncited A_old should be deduped')
    assert.equal(surface.has(rOld), false, 'uncited R_old should be deduped with its issuer')

    assertNoOrphan(session)
  } finally {
    await ctx.fiber.dispose()
  }
})
