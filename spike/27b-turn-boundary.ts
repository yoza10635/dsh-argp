// spike 27b：模拟"压载读文件后下一轮 pre-step 才超线"的时序
// 验证：turn30 pre-step(56K skip) → 轮内读 ref-module(+26K) → turn31 pre-step 应看到 82K → 触发压缩？
// 关键：dsh 的 agent/pre-step 是否在"工具调用后、模型回答前"也触发？
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ArgpGraphEngine } from '../src/argp-graph-engine.ts'

async function makeEngine(): Promise<{ ctx: Context; engine: ArgpGraphEngine }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: 'argp spike27b' } })
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
function appendToolResult(s: Session, text: string, turn: number): void {
  s.append('tool/result', {
    turn, step: 1,
    message: createAssistantMessage({ source: { provider: 'test', model: 'test' }, content: [{ type: 'text', text }] }),
  } as never, { surfaceOp: 'append' })
}

async function main(): Promise<void> {
  const { engine } = await makeEngine()
  const session = Session.create(SessionId('spike27b'))
  engine.setSession(session)
  const agent = { session } as Parameters<ArgpGraphEngine['compactIfNeeded']>[0]
  const signal = new AbortController().signal
  const mt = engine as unknown as { measureTokens(s: Session): { contextTokens: number } }

  // 模拟 turn 1-29：小文本（~50K 估算，不超线）
  for (let t = 1; t <= 29; t += 1) {
    appendUser(session, `u${t}: ${('small task ' + t + ' ').repeat(30)}`, t)
    appendAssistant(session, `A${t}: ${('small answer ' + t + ' ').repeat(40)}`, t)
  }
  console.log('[27b] turn29 后估算: ' + mt.measureTokens(session).contextTokens)

  // turn 30 pre-step 检查（模拟压载前）
  let r = await engine.compactIfNeeded(agent, 'pressure', signal)
  console.log('[27b] turn30 pre-step: ' + (r === null ? 'skip（未超线）' : 'TRIGGERED'))

  // turn 30 轮内读 ref-module（大 tool result，+26K 估算）
  // 模拟 ref-module.ts：~103KB 真实多样 TS 代码（1300 行 × ~80 字符），估算 ≈ 25-30K token
  const codeLines = Array.from({ length: 1300 }, (_, i) =>
    `export function fn${i}(a: number, b: string): boolean { return a > 0 && b.length > ${i % 7}; } // line ${i} with varied tokens`
  )
  const big = codeLines.join('\n')
  appendUser(session, 'u30: read ref-module.ts in full and tell me the exported function name', 30)
  appendToolResult(session, big, 30)
  appendAssistant(session, 'A30: extractCites is the exported function.', 30)
  console.log('[27b] turn30 压载后估算: ' + mt.measureTokens(session).contextTokens)

  // turn 31 pre-step 检查（模拟压载后下一轮）
  r = await engine.compactIfNeeded(agent, 'pressure', signal)
  console.log('[27b] turn31 pre-step: ' + (r === null ? 'skip（未超线）' : 'TRIGGERED shadowed=' + r.shadowedSeqs.length))

  // 再模拟 turn 32-35 压载继续
  for (let t = 32; t <= 35; t += 1) {
    appendUser(session, `u${t}: read ref-module again`, t)
    appendToolResult(session, big, t)
    appendAssistant(session, `A${t}: scaleBudgets decides compaction.`, t)
  }
  console.log('[27b] turn35 后估算: ' + mt.measureTokens(session).contextTokens)
  r = await engine.compactIfNeeded(agent, 'pressure', signal)
  console.log('[27b] turn35 pre-step: ' + (r === null ? 'skip' : 'TRIGGERED shadowed=' + r.shadowedSeqs.length))
  console.log('[27b] records=' + engine.records.length)
}

void main()
