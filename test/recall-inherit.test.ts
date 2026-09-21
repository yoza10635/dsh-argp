/**
 * §3-3 recall 价值继承回归测试：
 *  - 被剪原子在 prunedNodeIndex 中记录被剪瞬间的 eff
 *  - recall 结果原子被 cites 命中（inDegree>0）→ 继承源原子被剪 eff（×0.5 衰减）
 *  - 源索引缺失时静默跳过继承（不抛错）
 *
 * P3.1：继承的 eff 记账落在 prunedNodeIndex.eff（被剪时记录），可单元级稳定断言——
 * 源 eff=20 → 继承 floor(20×0.5)=10，高于 A 原子 selfImportance(5) 与 supporting 边权重(5)，
 * 故继承值与基线可区分：cited+源在场 → eff=10；cited+源缺失 / uncited → eff=5（不继承）。
 * 原恒真断言（result===null||true / assert.ok(true)）与游离 console.log 已删。
 * 前缀须互异（OLDMARKER/RECALLMARKER）：cites 按前缀匹配，同前缀会让"引用旧原子"的
 * cite 误命中 recall 原子（旧 fixture 的 marker 同时出现在两原子，导致 uncited 也被引用）。
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
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: 'argp recall-inherit test persona' } })
  await ctx.plugin(ArgpGraphEngine, { windowTokens: 100, retainTokens: 50, minSpanChars: 20, recencyGuard: 0, maxPasses: 16, ...config })
  return { ctx, engine: ctx.compaction as ArgpGraphEngine }
}

function appendUser(session: Session, text: string): void {
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
}

function appendAssistant(session: Session, text: string, turn: number): void {
  session.append('assistant/message', { stream: [], 
    turn,
    step: 1,
    message: createAssistantMessage({ source: { provider: 'test', model: 'test' }, content: [{ type: 'text', text }] }),
  }, { surfaceOp: 'append' })
}

test('prunedNodeIndex records eff at prune time (isolated A = 5)', async () => {
  const { ctx, engine } = await makeEngine({ degradationStrategy: 'fail' })
  try {
    const session = Session.create(SessionId('recall-inherit-eff-record'))
    appendUser(session, 'user anchor')
    appendAssistant(session, 'isolated big atom ' + 'a'.repeat(500), 1)
    const bigSeq = session.snapshotEvents().length - 1
    appendAssistant(session, 'latest: ' + 'c'.repeat(20), 2)
    engine.setSession(session)
    await engine.compactIfNeeded({ session } as never, 'pressure', new AbortController().signal)
    const info = engine.prunedNodeIndex.get(bigSeq)
    assert.ok(info !== undefined, 'big atom should be pruned and indexed')
    assert.equal(info.eff, 5, 'eff recorded at prune time (isolated A = 5)')
  } finally {
    await ctx.fiber.dispose()
  }
})

/**
 * 构造 5 原子 recall 继承场景（P3.1 真实断言用）：
 *  - seq 1 = 旧原子（前缀 OLDMARKER，将被剪）
 *  - seq 2 = 引用旧原子（cites OLDMARKER）
 *  - seq 3 = recall 结果原子（前缀 RECALLMARKER，recallSourceSeq→seq1 的继承目标）
 *  - seq 4 = 后续 A：cited 时 cites RECALLMARKER（给 recall 原子入度），uncited 时不 cites
 *  - seq 5 = latest
 * 前缀互异（OLD/RECALL）避免 cites 前缀误命中（旧 fixture 同前缀导致 uncited 也被引用）。
 * 返回关键 seq 与 session。
 */
function buildRecallInheritFixture(session: Session, cite: boolean): { oldSeq: number; recallSeq: number } {
  appendUser(session, 'user anchor')
  appendAssistant(session, 'OLDMARKER old content ' + 'a'.repeat(100), 1)
  const oldSeq = session.snapshotEvents().length - 1
  appendAssistant(session, 'uses old: ' + 'b'.repeat(100) + '\n{"cites":["OLDMARKER"]}', 2)
  appendAssistant(session, 'RECALLMARKER recalled content ' + 'c'.repeat(100), 3)
  const recallSeq = session.snapshotEvents().length - 1
  appendAssistant(session, cite
    ? 'uses recalled: ' + 'd'.repeat(60) + '\n{"cites":["RECALLMARKER"]}'
    : 'unrelated: ' + 'd'.repeat(60), 4)
  appendAssistant(session, 'latest: ' + 'e'.repeat(30), 5)
  return { oldSeq, recallSeq }
}

/** 注入 recall 继承状态：源原子被剪 eff=20（继承 floor(20×0.5)=10，高于 A 自重要 5 / 边权重 5）。 */
function injectRecallState(engine: ArgpGraphEngine, oldSeq: number, recallSeq: number): void {
  engine.prunedNodeIndex.set(oldSeq, { seq: oldSeq, type: 'A', turn: 1, firstLine: 'old', citedBySeq: [], eff: 20 })
  ;(engine as unknown as { recallSourceSeq: number }).recallSourceSeq = oldSeq
  ;(engine as unknown as { recallResultSeq: number }).recallResultSeq = recallSeq
}

test('recall inherit: cited 继承源 eff（floor(20×0.5)=10），uncited 不继承（基线 5）', async () => {
  for (const cite of [true, false]) {
    const { ctx, engine } = await makeEngine({ degradationStrategy: 'fail' })
    try {
      const session = Session.create(SessionId('recall-inherit-' + (cite ? 'cited' : 'uncited')))
      const { oldSeq, recallSeq } = buildRecallInheritFixture(session, cite)
      engine.setSession(session)
      injectRecallState(engine, oldSeq, recallSeq)
      // 不崩溃 + 压缩可执行（degradationStrategy='fail'：候选耗尽才返回 null，此处应产出压缩）
      const result = await engine.compactIfNeeded({ session } as never, 'pressure', new AbortController().signal)
      assert.ok(result !== null, 'compactIfNeeded 产出压缩（cite=' + cite + '）')
      // recall 原子（seq 3）在本 fixture 下必被剪（retain 50 极小）→ 其 eff 落在 prunedNodeIndex
      const info = engine.prunedNodeIndex.get(recallSeq)
      assert.ok(info !== undefined, 'recall 原子被剪并记录 eff（cite=' + cite + '）')
      if (cite) {
        // cited：recall 原子被 seq4 的 supporting 边命中（inDegree>0）→ 继承源 eff floor(20×0.5)=10
        assert.equal(info.eff, 10, 'cited → 继承源 eff（floor(20×0.5)=10，高于自重要 5 与边权重 5）')
      } else {
        // uncited：无入度 → 不继承，eff = A 自重要 5
        assert.equal(info.eff, 5, 'uncited → 不继承（eff = A 自重要 5）')
      }
    } finally {
      await ctx.fiber.dispose()
    }
  }
})

test('recall inherit: 源索引缺失 → 即便被 cites 命中也不继承（eff 基线 5，不抛错）', async () => {
  const { ctx, engine } = await makeEngine({ degradationStrategy: 'fail' })
  try {
    const session = Session.create(SessionId('recall-inherit-no-source'))
    // 同 cited fixture（recall 原子被 seq4 cites 命中），但 recallSourceSeq 指向不存在的 99999
    const { recallSeq } = buildRecallInheritFixture(session, true)
    engine.setSession(session)
    ;(engine as unknown as { recallSourceSeq: number }).recallSourceSeq = 99999
    ;(engine as unknown as { recallResultSeq: number }).recallResultSeq = recallSeq
    // 不崩溃 + 压缩可执行
    const result = await engine.compactIfNeeded({ session } as never, 'pressure', new AbortController().signal)
    assert.ok(result !== null, '源索引缺失不阻断压缩')
    // recall 原子被剪且被 cites 命中（citedBy 非空），但源缺失 → 不继承，eff 保持基线 5
    const info = engine.prunedNodeIndex.get(recallSeq)
    assert.ok(info !== undefined, 'recall 原子被剪并记录 eff')
    assert.ok(info.citedBySeq.length > 0, 'recall 原子确实被 cites 命中（入度>0）')
    assert.equal(info.eff, 5, '源索引缺失 → 不继承（eff = A 自重要 5，非 floor(20×0.5)=10）')
  } finally {
    await ctx.fiber.dispose()
  }
})
