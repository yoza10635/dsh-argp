/**
 * spike 20：本地 Qwen3.8-27B（llama.cpp :8080）冒烟 —— 验证 dsh llm-deepseek 适配器
 * 能否通过 baseURL 覆盖接到本地 OpenAI 兼容端点（不需要写新适配器）。
 *
 * 用法：DEEPSEEK_API_KEY=dummy node spike/20-qwen-smoke.ts
 * 判定：agent 一轮对话返回非空文本；打印原始响应结构供诊断。
 */
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import { SessionId } from '@deepseek-ai/dsh-session'

const BASE = process.env['QWEN_BASE'] ?? 'http://127.0.0.1:8080/v1'
const MODEL = 'Qwen3.8-27B'

let ctx: Context
function waitForIdle(subject: { on: never }): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: a, status }: { agent: { id: unknown }; status: string }) => {
      if (a === (subject as unknown as { id: unknown }) && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

async function main(): Promise<void> {
  process.env['DEEPSEEK_API_KEY'] = process.env['DEEPSEEK_API_KEY'] ?? 'dummy-local'
  console.log('[qwen-smoke] base=' + BASE + ' model=' + MODEL)

  ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: 'qwen local smoke' } })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LlmDeepSeek, {
    thinking: 'disabled',
    reasoningEffort: 'off',
    baseURL: BASE,
    models: [{ id: MODEL, name: MODEL, contextWindow: 196_608 }],
  })
  const agent = ctx.agentLoop.create(SessionId('qwen-smoke'), {
    provider: 'deepseek-official',
    model: MODEL,
    reasoningEffort: 'off' as const,
  })

  const dispose = ctx.on('session/event', (session: { id: string }, event: { type: string; data: unknown }) => {
    if (session.id !== agent.session.id) return
    if (event.type === 'assistant/message') {
      const d = event.data as { message?: { content?: unknown[] } }
      const parts = (d.message?.content as { type: string; text?: string }[] | undefined) ?? []
      console.log('[qwen-smoke] assistant event content types:', JSON.stringify(parts.map(p => p.type)))
    }
    if (event.type === 'llm/retry' || event.type === 'agent/request-error') {
      console.log('[qwen-smoke] ' + event.type + ': ' + JSON.stringify(event.data).slice(0, 400))
    }
  })

  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Reply with exactly: LOCAL-QWEN-OK' }], source: { kind: 'user' } }))
  await waitForIdle(agent as never)
  dispose()

  // 提取最后 assistant 文本
  const events = [...agent.session.events] as { type?: string; data?: { message?: { content?: { type: string; text?: string }[] } } }[]
  let text = '(none)'
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i]
    if (e?.type === 'assistant/message') {
      const parts = e.data?.message?.content?.filter(b => b.type === 'text' && b.text !== undefined).map(b => b.text as string) ?? []
      if (parts.length > 0) { text = parts.join(' '); break }
    }
  }
  const ok = text.includes('LOCAL-QWEN-OK')
  console.log('[qwen-smoke] result: ' + (ok ? 'PASS' : 'FAIL'))
  console.log('[qwen-smoke] answer: ' + text.slice(0, 300).replace(/\n/g, ' '))
  await ctx.fiber?.dispose()
}

main().catch(err => {
  console.error('[qwen-smoke] FATAL:', err)
  process.exit(1)
})
