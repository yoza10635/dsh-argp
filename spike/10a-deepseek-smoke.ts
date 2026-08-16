/**
 * spike 10a：DeepSeek v4-flash 单轮冒烟。
 * 验证 official adapter + credential 加载 + agent-loop 真实请求链路。
 */
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { DEEPSEEK_MODEL, DEEPSEEK_PROVIDER, DEEPSEEK_REASONING_EFFORT, mountDeepSeekFlash } from './deepseek.ts'

const failures: string[] = []
const ctx = new Context()
await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: 'spike-10a deepseek smoke persona' } })
await ctx.plugin(AgentLoop, { agents: [] })
await mountDeepSeekFlash(ctx)

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

const agent = ctx.agentLoop.create(SessionId('spike-10a'), {
  provider: DEEPSEEK_PROVIDER,
  model: DEEPSEEK_MODEL,
  reasoningEffort: DEEPSEEK_REASONING_EFFORT,
})

ctx.on('agent/request-error', ({ failure }) => {
  console.log('[diag] request-error: ' + JSON.stringify({ code: failure.code, message: String(failure.message).slice(0, 400) }))
})
ctx.on('session/event', (session, event) => {
  if (session !== agent.session) return
  if (event.type === 'turn/end') {
    console.log('[diag] turn/end: ' + JSON.stringify(event.data).slice(0, 300))
  }
  if (event.type === 'assistant/message') {
    const usage = (event.data as { usage?: { inputTokens?: number; outputTokens?: number } }).usage
    console.log('[diag] usage: ' + JSON.stringify(usage ?? {}))
  }
})

agent.followup(createUserMessage({
  content: [{ type: 'text', text: 'Reply with exactly one line: DEEPSEEK-V4-FLASH-OK' }],
  source: { kind: 'user' },
}))
await waitForIdle(agent)

const assistant = [...agent.session.events].filter(e => e.type === 'assistant/message')
const text = assistant.flatMap(e => ((e.data as { message?: { content?: { type: string; text?: string }[] } }).message?.content ?? []))
  .filter(b => b.type === 'text').map(b => b.text ?? '').join(' ')

if (!text.includes('DEEPSEEK-V4-FLASH-OK')) {
  failures.push('answer mismatch: ' + text.slice(0, 200))
  console.log('[FAIL] answer=', text.slice(0, 200))
} else {
  console.log('[PASS] deepseek-v4-flash answer=', text.slice(0, 200))
}

await ctx.fiber.dispose()
console.log(failures.length === 0 ? 'SPIKE 10A VERDICT: PASS' : 'SPIKE 10A VERDICT: FAIL（' + failures.join('; ') + '）')
process.exit(failures.length === 0 ? 0 : 1)
