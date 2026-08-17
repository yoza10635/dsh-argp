/**
 * spike 21 诊断（修正版）：真实流程——先压缩剪掉旧原子（入索引），
 * 再追加 recall 新原子 + 后续 cites，对比 cited/uncited 两种命运的差异。
 */
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ArgpGraphEngine } from '../src/argp-graph-engine.ts'

async function makeEngine(config: Record<string, unknown> = {}): Promise<{ ctx: Context; engine: ArgpGraphEngine }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: 'recall-inherit diag' } })
  await ctx.plugin(ArgpGraphEngine, { windowTokens: 100, retainTokens: 50, minSpanChars: 20, recencyGuard: 0, maxPasses: 16, ...config })
  return { ctx, engine: ctx.compaction as ArgpGraphEngine }
}
function appendUser(session: Session, text: string): void {
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
}
function appendAssistant(session: Session, text: string, turn: number): void {
  session.append('assistant/message', { turn, step: 1, message: createAssistantMessage({ source: { provider: 'test', model: 'test' }, content: [{ type: 'text', text }] }) }, { surfaceOp: 'append' })
}

for (const cite of [true, false]) {
  const { ctx, engine } = await makeEngine({ degradationStrategy: 'lifecycle' })
  const session = Session.create(SessionId('diag2-' + cite))
  const marker = 'RECALL-DIAG-77'
  appendUser(session, 'user anchor')
  // 旧原子：孤立大 A（会被剪）+ 一个 cites 它的小 A（保护不了，因大 A 在组内？）
  // 用纯孤立大原子确保第一轮被剪：seq=1 大、seq=2 小（无 cites）
  appendAssistant(session, 'old content ' + marker + ' ' + 'a'.repeat(400), 1)
  const oldSeq = session.events.length - 1
  appendAssistant(session, 'small filler: ' + 'b'.repeat(40), 2)
  appendAssistant(session, 'latest: ' + 'c'.repeat(20), 3)
  engine.setSession(session)
  // 第一轮压缩：剪掉旧原子（孤立大 A）→ 索引记录 eff
  await engine.compactIfNeeded({ session } as never, 'pressure', new AbortController().signal)
  const oldIndexed = engine.prunedNodeIndex.get(oldSeq)
  console.log(`[${cite ? 'cited' : 'uncited'}] round1: oldSeq=${oldSeq} prunedIndexed=${oldIndexed !== undefined} eff=${oldIndexed?.eff} oldOnSurface=${session.surface.nodes.includes(oldSeq)}`)

  // 第二轮：追加 recall 新原子（文本=旧内容，模拟 recall 返回）+ 后续 A（可选 cites）
  appendAssistant(session, marker + ' recalled text ' + 'c'.repeat(100), 4)
  const recallSeq = session.events.length - 1
  appendAssistant(session, cite ? 'uses recalled: ' + 'd'.repeat(60) + '\n{"cites":["' + marker + '"]}' : 'unrelated: ' + 'd'.repeat(60), 5)
  appendAssistant(session, 'latest filler: ' + 'e'.repeat(30), 6)
  // 注入 recall 映射（模拟 recall 工具调用）
  ;(engine as unknown as { recallSourceSeq: number }).recallSourceSeq = oldSeq
  ;(engine as unknown as { recallResultSeq: number }).recallResultSeq = recallSeq
  const result = await engine.compactIfNeeded({ session } as never, 'pressure', new AbortController().signal)
  const rec = engine.records[engine.records.length - 1]
  const pruned = rec ? rec.prunedAtoms.map(a => a.seq).sort((x, y) => x - y) : []
  console.log(`[${cite ? 'cited' : 'uncited'}] round2: result=${result === null ? 'null' : 'ok'} recallSeq=${recallSeq} recallOnSurface=${session.surface.nodes.includes(recallSeq)} pruned=${JSON.stringify(pruned)} forced=${rec?.forced}`)
  await ctx.fiber.dispose()
}
