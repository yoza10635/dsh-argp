// spike 27d：验证 dsh-token-meter 是否统计 tool/result（压载场景）
// 挂真 TokenMeter 插件，构造：30 轮小文本 + 1 次大 tool/result（ref-module 模拟）
// 对比：有/无 tool/result 时 measure() 的 surfaceTokens 变化
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { ArgpGraphEngine } from '../src/argp-graph-engine.ts'

async function makeCtx(): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: 'argp spike27d' } })
  await ctx.plugin(TokenMeter)
  if (typeof (ctx as unknown as { tokenMeter?: { measure?: unknown } }).tokenMeter?.measure !== 'function') throw new Error('tokenMeter did not mount')
  console.log('[27d] tokenMeter mounted ok')
  return ctx
}

function appendUser(s: Session, text: string, turn: number): void {
  s.append('user/message', { turn, ...createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }) } as never, { surfaceOp: 'append' })
}
function beginStep(s: Session, turn: number, step: number): void {
  s.append('step/start', { turn, step } as never)
}
function endStep(s: Session, turn: number, step: number): void {
  s.append('step/end', { turn, step } as never)
}
function appendAssistant(s: Session, text: string, turn: number, step = 1): void {
  s.append('assistant/message', { turn, step, message: createAssistantMessage({ source: { provider: 'test', model: 'test' }, content: [{ type: 'text', text }] }) }, { surfaceOp: 'append' })
}
function appendToolResult(s: Session, text: string, turn: number, step = 1): void {
  s.append('tool/result', {
    turn, step, callId: 'call-' + turn,
    message: createAssistantMessage({ source: { provider: 'test', model: 'test' }, content: [{ type: 'text', text }] }),
  } as never, { surfaceOp: 'append' })
}

async function main(): Promise<void> {
  const ctx = await makeCtx()
  const session = Session.create(SessionId('spike27d'))
  // 30 轮小文本（每轮 step/start → user → assistant → step/end）
  for (let t = 1; t <= 30; t += 1) {
    beginStep(session, t, 1)
    appendUser(session, `u${t}: ${('small task ' + t + ' ').repeat(30)}`, t)
    appendAssistant(session, `A${t}: ${('small answer ' + t + ' ').repeat(40)}`, t)
    endStep(session, t, 1)
  }
  const meter = (ctx as unknown as { tokenMeter: { measure(s: Session): { totalTokens: number; surfaceTokens: number } } }).tokenMeter
  const m1 = meter.measure(session)
  console.log('[27d] 30 轮后: totalTokens=' + m1.totalTokens + ' surfaceTokens=' + m1.surfaceTokens)

  // 挂引擎（A 臂同配置）确认 measureTokens 走 tokenMeter
  await ctx.plugin(ArgpGraphEngine, { windowTokens: 80_000, retainTokens: 16_000, minSpanChars: 20, recencyGuard: 0, maxPasses: 16 })
  const engine = ctx.compaction as ArgpGraphEngine
  engine.setSession(session)
  const mt = engine as unknown as { measureTokens(s: Session): { contextTokens: number; surfaceTokens: number } }
  console.log('[27d] 引擎 measureTokens(30轮): ' + JSON.stringify(mt.measureTokens(session)))

  // 压载：读 ref-module（大 tool/result ~100KB）
  const codeLines = Array.from({ length: 1300 }, (_, i) => `export function fn${i}(a: number, b: string): boolean { return a > 0 && b.length > ${i % 7}; } // line ${i}`)
  const big = codeLines.join('\n')
  beginStep(session, 31, 1)
  appendUser(session, 'u31: read ref-module.ts in full', 31)
  appendAssistant(session, 'A31-toolcall: {"cites":[]} read_file ref-module.ts', 31, 1)
  appendToolResult(session, big, 31, 1)
  appendAssistant(session, 'A31: extractCites is the exported function.', 31, 1)
  endStep(session, 31, 1)

  const m2 = meter.measure(session)
  console.log('[27d] 压载后: totalTokens=' + m2.totalTokens + ' surfaceTokens=' + m2.surfaceTokens + '（tool/result ' + big.length + ' 字符）')
  console.log('[27d] 引擎 measureTokens(压载后): ' + JSON.stringify(mt.measureTokens(session)))

  // 直接调 compactIfNeeded
  const agent = { session } as Parameters<ArgpGraphEngine['compactIfNeeded']>[0]
  const r = await engine.compactIfNeeded(agent, 'pressure', new AbortController().signal)
  console.log('[27d] compactIfNeeded: ' + (r === null ? 'skip' : 'TRIGGERED shadowed=' + r.shadowedSeqs.length))
}

void main()
