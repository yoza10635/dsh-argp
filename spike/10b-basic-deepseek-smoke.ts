/**
 * spike 10b：BasicCompactionEngine + DeepSeek v4-flash 单轮装配冒烟。
 * 验证 B-4 修复后的 baseline 压力通道不会静默失效。
 */
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { DEEPSEEK_MODEL, DEEPSEEK_PROVIDER, DEEPSEEK_REASONING_EFFORT, mountDeepSeekFlash } from './deepseek.ts'

const failures: string[] = []
const ctx = new Context()
await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: 'spike-10b baseline smoke persona' } })
await ctx.plugin(AgentLoop, { agents: [] })
await ctx.plugin(TokenMeter)
if (typeof ctx.tokenMeter?.measure !== 'function') throw new Error('tokenMeter did not mount')
await mountDeepSeekFlash(ctx)
await ctx.plugin(BasicCompactionEngine, {
  modelPolicies: [{
    provider: DEEPSEEK_PROVIDER,
    model: DEEPSEEK_MODEL,
    thresholdRatio: 0.08,
    retainTokens: 7_168,
  }],
})

function waitForIdle(subject: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent, status }) => {
      if (agent === subject && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

let requestErrors = 0
ctx.on('agent/request-error', ({ failure }) => {
  requestErrors += 1
  console.log('[diag] request-error: ' + JSON.stringify({ code: failure.code, message: String(failure.message).slice(0, 300) }))
})

const agent = ctx.agentLoop.create(SessionId('spike-10b'), {
  provider: DEEPSEEK_PROVIDER,
  model: DEEPSEEK_MODEL,
  reasoningEffort: DEEPSEEK_REASONING_EFFORT,
})

agent.followup(createUserMessage({
  content: [{ type: 'text', text: 'Reply with exactly one line: BASIC-DEEPSEEK-OK' }],
  source: { kind: 'user' },
}))
await waitForIdle(agent)

const text = [...agent.session.events].filter(e => e.type === 'assistant/message')
  .flatMap(e => ((e.data as { message?: { content?: { type: string; text?: string }[] } }).message?.content ?? []))
  .filter(b => b.type === 'text').map(b => b.text ?? '').join(' ')

if (!text.includes('BASIC-DEEPSEEK-OK')) failures.push('answer mismatch: ' + text.slice(0, 200))
if (requestErrors > 0) failures.push('request errors: ' + requestErrors)
console.log('[diag] answer=', text.slice(0, 200))
console.log('[diag] requestErrors=', requestErrors)

await ctx.fiber.dispose()
console.log(failures.length === 0 ? 'SPIKE 10B VERDICT: PASS' : 'SPIKE 10B VERDICT: FAIL（' + failures.join('; ') + '）')
process.exit(failures.length === 0 ? 0 : 1)
