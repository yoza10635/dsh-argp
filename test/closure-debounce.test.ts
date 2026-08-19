/**
 * P2 回归测试：recall 防抖 key 从 closureId 改为 rootSeq。
 *
 * Bug：closureId 由 `nextClosureId++` 生成，tryPruneClosures **每 pass 都给所有 root
 * 重发新 id**（即使跨事务，计数器也只增不减）。noteRecallHit 把「旧 id」写入
 * closureLastRecalled，而剪枝决策处查「本次 pass 的新 id」→ 永不相等 → 防抖分支
 * 永不触发（L816 `continue` 死代码）→ 刚被 recall 回拉的闭包下一 pass 又被剪。
 *
 * 修复：key 改用 rootSeq（闭包 root U 的 seq，跨 pass / 跨事务稳定），写入与读取
 * 用同一把钥匙。本测试两条断言：
 *  1) 写入侧：noteRecallHit 之后 closureLastRecalled 里出现的是 rootSeq 条目，
 *     旧 closureId 条目不复存在；
 *  2) 决策侧：预置「该 rootSeq 刚被 recall」后，tryPruneClosures 对同一闭包返回
 *     null（被防抖挡住）；清除预置后同一闭包可剪（非 null）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ArgpGraphEngine, type Atom } from '../src/argp-graph-engine.ts'

async function makeEngine(config: Record<string, unknown> = {}): Promise<{ ctx: Context; engine: ArgpGraphEngine }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: 'argp closure-debounce test' } })
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

/**
 * 构造两个闭包 + 一个最新 turn 的锚点：
 *   C1（turn1）：U1 + A1(cites U1) + A2(cites A1) —— lastRef=1，可剪
 *   C2（turn2）：U2 + B1 —— lastRef=2，可剪（但 lastRootSeq=U2，C2 永远被「最新闭包」豁免）
 *   A5（turn5）：latest 锚点 —— latestTurn=5，latestTurn-k=3 → 两闭包 lastRef 均达标
 * 返回各 seq 与 atoms 快照所需信息。
 */
function buildClosureSession(session: Session): { u1: number; a1: number; a2: number; u2: number } {
  appendUser(session, 'C1 user anchor')
  const u1 = session.events.length - 1
  appendAssistant(session, 'A1: ' + 'x'.repeat(280) + '\n{"cites":["C1-ANCHOR"]}', 1)
  const a1 = session.events.length - 1
  appendAssistant(session, 'A2 content: C1-ANCHOR ' + 'y'.repeat(280), 1)
  const a2 = session.events.length - 1
  appendUser(session, 'C2 user anchor')
  const u2 = session.events.length - 1
  appendAssistant(session, 'B1: ' + 'z'.repeat(280), 2)
  appendAssistant(session, 'A5 latest: ' + 'w'.repeat(280), 5)
  return { u1, a1, a2, u2 }
}

test('P2 write-side: noteRecallHit 以 rootSeq 为 key 写入防抖（旧 closureId key 不再出现）', async () => {
  const { ctx, engine } = await makeEngine()
  try {
    const session = Session.create(SessionId('p2-write-side'))
    const { u1, a1, a2 } = buildClosureSession(session)
    engine.setSession(session)
    const result = await engine.compactIfNeeded({ session } as never, 'pressure', new AbortController().signal)
    assert.ok(result !== null, 'expected a closure-prune transaction')
    // 事务 1 剪掉 C1 闭包：root U1 连同 A1/A2 一起进 shadowedSeqs
    const record = engine.records[0]
    assert.ok(record !== undefined)
    const prunedSet = new Set(record.shadowedSeqs)
    assert.ok(prunedSet.has(u1) && prunedSet.has(a1) && prunedSet.has(a2), 'C1 closure should be pruned together')
    assert.equal(engine.closurePrunes.length, 1)
    const cp = engine.closurePrunes[0]
    assert.ok(cp !== undefined)
    assert.equal(cp.rootSeq, u1, 'closure record must carry rootSeq = root U seq')
    // recall 命中闭包内节点 → noteRecallHit 写入
    const engineAny = engine as unknown as { noteRecallHit(seq: number): void; closureLastRecalled: Map<number, number> }
    engineAny.noteRecallHit(a1)
    assert.ok(engineAny.closureLastRecalled.has(u1), 'debounce key must be rootSeq (' + u1 + ')')
    assert.equal(engineAny.closureLastRecalled.get(u1), 5, 'debounce round should be latest turn (A5 turn=5)')
    assert.equal(engineAny.closureLastRecalled.size, 1, 'exactly one debounce entry — old closureId key must NOT be used')
    // 二次压缩不应再剪 C1（防抖窗口 latestTurn - lastRecalled = 5-5 = 0 < k=2）。
    // 此时 C1 已被物理替换，C2 因 lastRootSeq 豁免 → 唯一还可能发生的是组剪枝剪
    // 其他候选（如 B1）；断言：有事务可以发生，但绝不允许触碰 C1 原子。
    const second = await engine.compactIfNeeded({ session } as never, 'pressure', new AbortController().signal)
    assert.ok(second !== null, 'second compaction should still prune OTHER candidates (B1)')
    for (const r of engine.records.slice(1)) {
      for (const seq of [u1, a1, a2]) {
        assert.ok(!r.shadowedSeqs.includes(seq), 'recalled closure node ' + seq + ' must not be re-pruned')
      }
    }
  } finally {
    await ctx.fiber.dispose()
  }
})

test('P2 decision-side: tryPruneClosures 按 rootSeq 查防抖，recall 过的闭包被跳过', async () => {
  const { ctx, engine } = await makeEngine()
  try {
    const session = Session.create(SessionId('p2-decision-side'))
    const { u1 } = buildClosureSession(session)
    engine.setSession(session)
    const atoms: Atom[] = engine.atomize(session)
    const { edges, inDegree } = engine.buildGraph(atoms)
    const askCover = new Map<number, number>()
    const latestTurn = atoms.reduce((m, a) => Math.max(m, a.turn), 0)
    const engineAny = engine as unknown as {
      closureLastRecalled: Map<number, number>
      tryPruneClosures(
        session: Session,
        atoms: Atom[],
        edges: unknown[],
        inDegree: Map<number, number>,
        askCover: Map<number, number>,
        latestTurn: number,
      ): unknown
    }
    // 预置「rootSeq 刚被 recall」（模拟 noteRecallHit 在上一事务写入）
    engineAny.closureLastRecalled.set(u1, latestTurn)
    const blocked = engineAny.tryPruneClosures(session, atoms, edges, inDegree, askCover, latestTurn)
    assert.ok(blocked === null, 'closure recalled this turn must be debounced (latestTurn - recalled < k)')
    // 清除预置后同一闭包恢复可剪（证明不是其他条件挡住的）
    engineAny.closureLastRecalled.delete(u1)
    const allowed = engineAny.tryPruneClosures(session, atoms, edges, inDegree, askCover, latestTurn)
    assert.ok(allowed !== null, 'closure without a recent recall must be prunable')
  } finally {
    await ctx.fiber.dispose()
  }
})
