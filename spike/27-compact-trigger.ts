// spike 27：快速压缩触发验证（不重跑 50 轮）
// 构造 30+ 轮、估算 > 80K 的 session，直接调 compactIfNeeded('pressure')，
// 回答：修复后引擎在超长上下文下能否正常触发压缩（本地 A 臂"未触发"是否代码 bug）。
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ArgpGraphEngine } from '../src/argp-graph-engine.ts'

async function makeEngine(): Promise<{ ctx: Context; engine: ArgpGraphEngine }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: 'argp spike27 trigger test' } })
  await ctx.plugin(ArgpGraphEngine, {
    windowTokens: 80_000, retainTokens: 16_000, minSpanChars: 20, recencyGuard: 0, maxPasses: 16,
  })
  return { ctx, engine: ctx.compaction as ArgpGraphEngine }
}

function appendUser(s: Session, text: string, turn: number): void {
  s.append('user/message', { turn, ...createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }) } as never, { surfaceOp: 'append' })
}
function appendAssistant(s: Session, text: string, turn: number): void {
  s.append('assistant/message', { turn, step: 1, message: createAssistantMessage({ source: { provider: 'test', model: 'test' }, content: [{ type: 'text', text }] }) }, { surfaceOp: 'append' })
}

/** 构造 35 轮、每轮大文本 → 估算远超 80K。 */
function buildLongSession(): Session {
  const s = Session.create(SessionId('spike27-long'))
  for (let turn = 1; turn <= 35; turn += 1) {
    // 每轮 U（~3200 字符）+ A（~4800 字符）→ 35 轮 ≈ 280K 字符 ≈ 80K token（charsPerToken 3.5）
    appendUser(s, `u${turn}: ${('task constraint data item ' + turn + ' ').repeat(160)}`, turn)
    appendAssistant(s, `A${turn}: ${('implementation detail block ' + turn + ' ').repeat(240)}`, turn)
  }
  return s
}

async function main(): Promise<void> {
  const { ctx, engine } = await makeEngine()
  const session = buildLongSession()
  engine.setSession(session)

  const { contextTokens, surfaceTokens } = (engine as unknown as { measureTokens(s: Session): { contextTokens: number; surfaceTokens: number } }).measureTokens(session)
  console.log('[spike27] session events=' + session.events.length + ' surface nodes=' + session.surface.nodes.length)
  console.log('[spike27] 估算 contextTokens=' + contextTokens + ' surfaceTokens=' + surfaceTokens + ' (windowTokens=80000)')
  const visibleChars = (engine as unknown as { visibleChars(s: Session): number }).visibleChars(session)
  console.log('[spike27] visibleChars=' + visibleChars)

  const agent = { session } as Parameters<ArgpGraphEngine['compactIfNeeded']>[0]
  try {
    const result = await engine.compactIfNeeded(agent, 'pressure', new AbortController().signal)
    console.log('[spike27] compactIfNeeded 返回: ' + JSON.stringify(result === null ? null : {
      compactionId: result.compactionId,
      shadowedRange: result.shadowedRange,
      shadowedSeqs: result.shadowedSeqs.length,
      shadowedTokenCount: result.shadowedTokenCount,
    }))
    console.log('[spike27] records=' + engine.records.length + ' boundaries 应=1')
    const after = (engine as unknown as { visibleChars(s: Session): number }).visibleChars(session)
    console.log('[spike27] 压缩后 visibleChars=' + after + '（前=' + visibleChars + '）')
    console.log('[spike27] 表面剩余节点=' + session.surface.nodes.length)
  } catch (error) {
    console.error('[spike27] compactIfNeeded 抛错: ' + (error instanceof Error ? error.message + '\n' + (error.stack ?? '') : String(error)))
  }
  await ctx.stop()
}

void main()
