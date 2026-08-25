/**
 * 版本链重定向回归（2026-08-23）：被剪旧快照（旧 R）recall 时重定向返回同路径最新存活版本原文。
 *
 * 背景：用户拍板「recall 旧快照 = 直接重定向返回最新版原文（替换旧值）」。
 * 机制：findVersionDuplicates 按 R 去重键（issuer A 的 tool name + arguments JSON）把同路径
 * 多版本串成链，latestRByKey 记录最新存活 seq；prunedNodeIndex 对被剪旧 R 记 latestOfPath。
 * recall_pruned 命中旧 seq 时，若 latestOfPath 指向不同 seq 且该 seq 仍可召回 → 重定向返回最新版。
 *
 * 只验证「重定向」不变式：旧 R 召回返回最新版原文 + 明确的重定向标注。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { CallId, createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ArgpGraphEngine } from '../src/argp-graph-engine.ts'

async function makeEngine(config: Record<string, unknown> = {}): Promise<{ ctx: Context; engine: ArgpGraphEngine }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: 'argp version-chain redirect test' } })
  await ctx.plugin(ArgpGraphEngine, { windowTokens: 100, retainTokens: 50, minSpanChars: 20, recencyGuard: 0, maxPasses: 16, ...config })
  return { ctx, engine: ctx.compaction as ArgpGraphEngine }
}

function appendUser(session: Session, text: string): void {
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
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

function appendAssistant(session: Session, text: string, turn: number): void {
  session.append('assistant/message', {
    turn,
    step: 1,
    message: createAssistantMessage({ source: { provider: 'test', model: 'test' }, content: [{ type: 'text', text }] }),
  }, { surfaceOp: 'append' })
}

async function runTool(ctx: Context, name: string, args: Record<string, unknown>): Promise<string> {
  const res = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: CallId('verchain-redirect-' + Math.random().toString(36).slice(2)),
    name,
    arguments: args,
  })
  return res.content[0]?.type === 'text' ? res.content[0].text : ''
}

test('version-chain redirect: recall of pruned old R returns latest same-path version', async () => {
  const { ctx, engine } = await makeEngine({ enableOverlapChain: false })
  try {
    const session = Session.create(SessionId('verchain-redirect'))
    appendUser(session, 'user anchor')

    // 旧版本 read（v1）：A_old + R_old，同 read 参数 → 与 v2 同路径（同 rKey）
    appendToolCallAssistant(session, 1, 'call_1', '{"path":"game.html"}')
    const rOld = appendToolResult(session, 1, 'call_1', 'V1MK ' + 'a'.repeat(300))

    // 新版本 read（v2）：A_new + R_new，同 arguments → A 全等去重把 A_old 当 older
    appendToolCallAssistant(session, 3, 'call_2', '{"path":"game.html"}')
    const rNew = appendToolResult(session, 3, 'call_2', 'V2MK ' + 'b'.repeat(300))

    appendAssistant(session, 'latest anchor.', 4)

    engine.setSession(session)
    await engine.compactIfNeeded({ session } as never, 'pressure', new AbortController().signal)

    // 旧 R 已被剪，且 latestOfPath 指向新版本 seq
    const info = engine.prunedNodeIndex.get(rOld)
    assert.ok(info !== undefined, 'old R should be pruned and indexed')
    assert.equal(info.latestOfPath, rNew, 'latestOfPath should point to the newer same-path version seq')

    // recall 旧 R → 重定向返回最新版原文 + 标注
    const text = await runTool(ctx, 'recall_pruned', { seq: rOld })
    assert.ok(text.includes('V2MK'), 'redirect must return the latest version content')
    assert.ok(!text.includes('V1MK'), 'redirect must NOT return the stale old content')
    assert.ok(text.includes('version-chain redirect'), 'redirect must carry an explicit redirect annotation')
  } finally {
    await ctx.fiber.dispose()
  }
})

test('version-chain redirect: no redirect when old R has no newer same-path version', async () => {
  const { ctx, engine } = await makeEngine({ enableOverlapChain: false })
  try {
    const session = Session.create(SessionId('verchain-no-redirect'))
    appendUser(session, 'user anchor')

    // 唯一一次 read（无同路径后续版本）
    appendToolCallAssistant(session, 1, 'call_1', '{"path":"solo.ts"}')
    const rOnly = appendToolResult(session, 1, 'call_1', 'SOLO-FILE-CONTENT ' + 'x'.repeat(400))

    appendAssistant(session, 'latest anchor.', 2)

    engine.setSession(session)
    await engine.compactIfNeeded({ session } as never, 'pressure', new AbortController().signal)

    // 若被剪且无同路径新版本，latestOfPath 应为 undefined（不重定向，走普通召回）
    const info = engine.prunedNodeIndex.get(rOnly)
    if (info !== undefined) {
      assert.equal(info.latestOfPath, undefined, 'no newer same-path version → no redirect')
    }
  } finally {
    await ctx.fiber.dispose()
  }
})
