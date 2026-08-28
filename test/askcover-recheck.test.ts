/**
 * askCover 动态复核回归用例（路线图 P3-3 建档；评估 v2 P0-3 失败模式的回归防线）。
 *
 * ask-exempt U 剪枝语义（argp-graph-engine.ts：buildGraph 内 askCoverage + isAtomCandidate）：
 *  1. 覆盖建立：ask 型 U（looksAskText）之后**首个** A 若声明了指向它的语义边
 *     → askCover.set(u.id, firstA.id)；首个 A 无边时后续 A 的 cites 不建立覆盖；
 *  2. 动态复核：U 参剪前要求**所有保留入边都来自覆盖者**——跨轮引用到达
 *     （后来者 A 也 cites 它）→ 豁免失效，U 不可剪。这是 P0-3 失败模式
 *     （"跨轮引用到达 → 豁免失效"被正确处理为**拒绝剪枝**）的直接回归；
 *  3. 非 ask 的 dialog U 无覆盖 → 结构性不可剪（ask-exempt 分支拒绝）；
 *     闭包生命周期对 root U 的整闭包退休是另一条路径，本文件用
 *     closureWindowK=999 令静止窗永不满足，隔离闭包剪枝的干扰。
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
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: 'argp askcover-recheck test' } })
  await ctx.plugin(ArgpGraphEngine, {
    windowTokens: 100, retainTokens: 50, minSpanChars: 20, recencyGuard: 0,
    turnGuard: 2, closureWindowK: 999, maxPasses: 16, ...config,
  })
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

/** 远端锚点：把 latestTurn 推高、让被测 U 退出 turnGuard 保护窗（自身受 turnGuard 保护不可剪）。 */
function appendAnchor(session: Session, turn: number): void {
  appendAssistant(session, '后续工作记录 anchor-' + turn + ' ' + 'w'.repeat(280), turn)
}

const prunedSeqsAcross = (engine: ArgpGraphEngine): Set<number> =>
  new Set(engine.records.flatMap(r => r.shadowedSeqs))

test('ask-exempt 基线：被首个 A 覆盖且无跨轮引用的 ask U，过保护期后可参剪', async () => {
  const { ctx, engine } = await makeEngine()
  try {
    const session = Session.create(SessionId('askcover-baseline'))
    appendUser(session, '请把 DEPLOY-A7K3 的端口改回 8080？')
    const uAsk = session.events.length - 1
    appendAssistant(session, '已核对当前配置并给出回滚步骤。' + 'x'.repeat(280) + '\n{"cites":["DEPLOY-A7K3"]}', 1)
    const a1 = session.events.length - 1
    appendAnchor(session, 9)
    engine.setSession(session)

    const result = await engine.compactIfNeeded({ session } as never, 'pressure', new AbortController().signal)
    assert.ok(result !== null, 'expected a prune transaction')
    const pruned = prunedSeqsAcross(engine)
    assert.ok(pruned.has(uAsk), 'covered ask U must be prunable via ask-exempt path')
    assert.ok(pruned.has(a1), 'coverer A1 (in-degree 0) is a normal candidate')
  } finally {
    await ctx.fiber.dispose()
  }
})

test('P0-3 回归：跨轮引用到达（后来者 A 也 cites 该 U）→ 豁免失效，U 不剪', async () => {
  const { ctx, engine } = await makeEngine()
  try {
    const session = Session.create(SessionId('askcover-crossref'))
    appendUser(session, '请把 DEPLOY-A7K3 的端口改回 8080？')
    const uAsk = session.events.length - 1
    appendAssistant(session, '已核对当前配置并给出回滚步骤。' + 'x'.repeat(280) + '\n{"cites":["DEPLOY-A7K3"]}', 1)
    const a1 = session.events.length - 1
    // 跨轮引用者：turn 9 再次 cites 同一 U → U 的保留入边不再全部来自覆盖者
    appendAssistant(session, '补记部署讨论结论。' + 'y'.repeat(280) + '\n{"cites":["DEPLOY-A7K3"]}', 9)
    appendAnchor(session, 10)
    engine.setSession(session)

    const result = await engine.compactIfNeeded({ session } as never, 'pressure', new AbortController().signal)
    assert.ok(result !== null, 'expected a prune transaction (A1 remains prunable)')
    const pruned = prunedSeqsAcross(engine)
    assert.ok(pruned.has(a1), 'positive control: coverer A1 must still be pruned — transaction ran')
    assert.ok(!pruned.has(uAsk), 'cross-turn reference must invalidate the ask exemption (dynamic recheck)')
  } finally {
    await ctx.fiber.dispose()
  }
})

test('dialog U（非 ask）不经 ask-exempt 参剪：即使被 A cites 也只能走闭包路径（此处闭包已隔离）', async () => {
  const { ctx, engine } = await makeEngine()
  try {
    const session = Session.create(SessionId('askcover-dialog'))
    appendUser(session, '背景说明：服务沿用 DEPLOY-B9X2 的部署参数，端口约定见配置库。')
    const uDialog = session.events.length - 1
    appendAssistant(session, '收到背景信息。' + 'z'.repeat(280) + '\n{"cites":["DEPLOY-B9X2"]}', 1)
    const a1 = session.events.length - 1
    appendAnchor(session, 9)
    engine.setSession(session)

    const result = await engine.compactIfNeeded({ session } as never, 'pressure', new AbortController().signal)
    assert.ok(result !== null, 'expected a prune transaction (A1 remains prunable)')
    const pruned = prunedSeqsAcross(engine)
    assert.ok(pruned.has(a1), 'positive control: citing A1 must still be pruned — transaction ran')
    assert.ok(!pruned.has(uDialog), 'dialog U has no ask coverage → structurally non-prunable via ask-exempt')
  } finally {
    await ctx.fiber.dispose()
  }
})
