/**
 * spike 10d：ArgpGraphEngine + DeepSeek v4-flash 单轮装配冒烟。
 */
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ArgpGraphEngine } from '../src/argp-graph-engine.ts'
import { DEEPSEEK_MODEL, DEEPSEEK_PROVIDER, DEEPSEEK_REASONING_EFFORT, mountDeepSeekFlash } from './deepseek.ts'

const failures: string[] = []
const ctx = new Context()
await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: 'spike-10d argp smoke persona' } })
await ctx.plugin(AgentLoop, { agents: [] })
await mountDeepSeekFlash(ctx)
await ctx.plugin(ArgpGraphEngine, { windowTokens: 10_240, retainTokens: 7_168 })
const engine = ctx.compaction as ArgpGraphEngine

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

const agent = ctx.agentLoop.create(SessionId('spike-10d'), {
  provider: DEEPSEEK_PROVIDER,
  model: DEEPSEEK_MODEL,
  reasoningEffort: DEEPSEEK_REASONING_EFFORT,
})
engine.setSession(agent.session)

agent.followup(createUserMessage({
  content: [{ type: 'text', text: 'Reply with exactly one line: ARGP-DEEPSEEK-OK' }],
  source: { kind: 'user' },
}))
await waitForIdle(agent)

const text = [...agent.session.events].filter(e => e.type === 'assistant/message')
  .flatMap(e => ((e.data as { message?: { content?: { type: string; text?: string }[] } }).message?.content ?? []))
  .filter(b => b.type === 'text').map(b => b.text ?? '').join(' ')

if (!text.includes('ARGP-DEEPSEEK-OK')) failures.push('answer mismatch: ' + text.slice(0, 200))
if (requestErrors > 0) failures.push('request errors: ' + requestErrors)
console.log('[diag] answer=', text.slice(0, 200))
console.log('[diag] requestErrors=', requestErrors)

await ctx.fiber.dispose()
console.log(failures.length === 0 ? 'SPIKE 10D VERDICT: PASS' : 'SPIKE 10D VERDICT: FAIL（' + failures.join('; ') + '）')
process.exit(failures.length === 0 ? 0 : 1)
