/**
 * spike 17：静态 inDegree 疑点探查（设计 §5.4 反向拓扑链式解锁是否实现）
 *
 * 场景：A1 cites A2（→ 语义边 A1→A2，inDegree(A2)=1）。A1 入度 0 可剪。
 * 设计预期：剪 A1 后 A2 入度归零 → 成为新软候选，链式剪除（forced=false）。
 * 现状判断：inDegree 是 buildGraph 静态结果，pass 循环不更新 → A2 只能靠 force_prune（或剪不掉）。
 *
 * 分别在 lifecycle（默认）与 fail 两种降级策略下观察：
 *  - lifecycle：若 A2 靠 force 剪掉 → forced=true（语义失真）
 *  - fail：若 A2 剪不掉 → 整笔事务 return null（连 A1 都不落盘，达不了标）
 */
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ArgpGraphEngine } from '../src/argp-graph-engine.ts'

async function makeEngine(config: Record<string, unknown> = {}): Promise<{ ctx: Context; engine: ArgpGraphEngine }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: 'argp chain-unlock probe' } })
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

async function run(strategy: string, withCite: boolean): Promise<void> {
  const marker = 'THE-GATEWAY-RELEASE-PASSES-42'
  const { ctx, engine } = await makeEngine({ degradationStrategy: strategy })
  try {
    const session = Session.create(SessionId('chain-unlock-' + strategy + '-' + (withCite ? 'cite' : 'plain')))
    appendUser(session, 'user anchor')
    appendAssistant(session, (withCite ? 'A1 cites A2: ' : 'A1: ') + 'x'.repeat(280) + (withCite ? '\n{"cites":["' + marker + '"]}' : ''), 1)
    const a1Seq = session.events.length - 1
    appendAssistant(session, (withCite ? 'A2 content: ' + marker + ' ' : 'A2: ') + 'y'.repeat(280), 2)
    const a2Seq = session.events.length - 1
    appendAssistant(session, 'A3 latest: ' + 'z'.repeat(40), 3)
    const a3Seq = session.events.length - 1
    engine.setSession(session)
    const result = await engine.compactIfNeeded({ session } as never, 'pressure', new AbortController().signal)
    const record = engine.records[0]
    const prunedSeqs = (record?.prunedAtoms ?? []).map(a => a.seq).sort((x, y) => x - y)
    const surface = session.surface.nodes
    console.log(`[${strategy}/${withCite ? 'cite' : 'plain'}] result=${result === null ? 'null' : 'ok'} forced=${record?.forced ?? 'n/a'}`)
    console.log(`[${strategy}/${withCite ? 'cite' : 'plain'}] prunedSeqs=${JSON.stringify(prunedSeqs)} (a1=${a1Seq} a2=${a2Seq} a3=${a3Seq})`)
    console.log(`[${strategy}/${withCite ? 'cite' : 'plain'}] a2OnSurface=${surface.includes(a2Seq)} a3OnSurface=${surface.includes(a3Seq)}`)
  } finally {
    await ctx.fiber.dispose()
  }
}

async function main(): Promise<void> {
  console.log('== 实验组：A1 cites A2（A1→A2 边，A2 入度 1）—— 设计预期 A2 应被链式解锁 ==')
  console.log('== 对照组：A1/A2 无引用（均入度 0）—— forced 应恒为 false ==')
  await run('lifecycle', true)
  await run('fail', true)
  await run('lifecycle', false)
  await run('fail', false)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
