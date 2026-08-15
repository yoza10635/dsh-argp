/**
 * spike 4a：dsh-llm-pi-ai 适配器 × llama-server(8080) 冒烟（t1 前置）
 *
 * 判决项：
 *  A. 手工声明路由（openai-completions + baseURL）经 agent-loop 真实多轮生成成功
 *  B. reasoning_content 被捕获为 session 事件里的 reasoning 块
 *  C. reasoning 回放实测：对比 prompt_tokens 增量与可见文本增量，判定历史 thinking
 *     是否随请求重放（pi-ai 源码推演为"回放"，此处实证）——决定 spike 4 引擎是否需要
 *     "thinking 剥离"机制
 */
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'

const failures: string[] = []

// 本地 llama-server 无鉴权，但 pi-ai 对手工路由强制要求凭据：给个哑值
process.env['ARGP_LOCAL_KEY'] = 'local-no-auth'

const ctx = new Context()
// mountAgentLoopTestDependencies 内部已挂 LlmRuntime，勿重复
await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: 'spike-4a smoke persona' } })
await ctx.plugin(AgentLoop, { agents: [] })
await ctx.plugin(LlmPiAi, {
  providers: {
    local: {
      displayName: 'Local llama.cpp',
      apiKeyEnv: 'ARGP_LOCAL_KEY',
      api: 'openai-completions',
      baseURL: 'http://localhost:8080/v1',
      compat: { thinkingFormat: 'qwen' },
      models: [{
        id: 'Qwen3.8-27B',
        name: 'Qwen3.8-27B (local SOTA)',
        contextWindow: 196_608,
        // 服务端 --reasoning-budget 16384：maxTokens 4096 时 thinking 可独占额度
        // 打爆 completion（实测 turn 1 可见文本 0），调到 8192 留出回答空间
        maxTokens: 8192,
        reasoningEfforts: { off: 'false', high: 'true' },
      }],
    },
  },
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

const agent = ctx.agentLoop.create(SessionId('spike-4a'), { provider: 'local', model: 'Qwen3.8-27B', reasoningEffort: 'high' })

// 诊断：捕获请求错误与轮次结束原因
ctx.on('agent/request-error', ({ failure }) => {
  console.log('[diag] request-error: ' + JSON.stringify({ code: failure.code, message: String(failure.message).slice(0, 300) }))
})
ctx.on('session/event', (session, event) => {
  if (session !== agent.session) return
  if (event.type === 'turn/end' || event.type === 'llm/retry') {
    console.log('[diag] ' + event.type + ': ' + JSON.stringify(event.data).slice(0, 300))
  }
})

// 每轮记录 usage（从 usage 事件取）与 surface 可见文本量
const turnStats: { turn: number; promptTokens: number; completionTokens: number }[] = []
ctx.on('session/event', (session, event) => {
  if (session !== agent.session) return
  if (event.type === 'assistant/message') {
    const usage = (event.data as { usage?: { inputTokens?: number; outputTokens?: number } }).usage
    turnStats.push({
      turn: event.data.turn as number,
      promptTokens: usage?.inputTokens ?? -1,
      completionTokens: usage?.outputTokens ?? -1,
    })
  }
})

const prompts = [
  'List exactly 3 lesser-known facts about the Eiffel Tower. One short sentence each.',
  'List exactly 3 lesser-known facts about the Great Wall of China. One short sentence each.',
  'List exactly 3 lesser-known facts about the Roman Colosseum. One short sentence each.',
]

for (const prompt of prompts) {
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: prompt }],
    source: { kind: 'user' },
  }))
  await waitForIdle(agent)
}

const events = [...agent.session.events]

// 判决 B：reasoning 块进入 session 事件
const assistantEvents = events.filter(e => e.type === 'assistant/message')
const reasoningBlocks = assistantEvents.flatMap(e =>
  ((e.data as { message: { content: { type: string }[] } }).message?.content ?? []).filter(b => b.type === 'reasoning'))
console.log('[info] assistant events=' + assistantEvents.length + ', reasoning blocks=' + reasoningBlocks.length)

// 可见文本总量（不含 reasoning）
const visibleChars = assistantEvents.reduce((sum, e) => {
  const content = (e.data as { message: { content: { type: string; text?: string }[] } }).message?.content ?? []
  return sum + content.filter(b => b.type === 'text').reduce((s, b) => s + (b.text?.length ?? 0), 0)
}, 0)
const reasoningChars = assistantEvents.reduce((sum, e) => {
  const content = (e.data as { message: { content: { type: string; text?: string }[] } }).message?.content ?? []
  return sum + content.filter(b => b.type === 'reasoning').reduce((s, b) => s + (b.text?.length ?? 0), 0)
}, 0)

console.log('[info] visible text chars=' + visibleChars + ', reasoning chars=' + reasoningChars)
for (const stat of turnStats) {
  console.log('[info] turn ' + stat.turn + ': prompt=' + stat.promptTokens + ' completion=' + stat.completionTokens)
}

// 判决 A：3 轮都有文本回答
const textAnswers = assistantEvents.filter(e => {
  const content = (e.data as { message: { content: { type: string; text?: string }[] } }).message?.content ?? []
  return content.some(b => b.type === 'text' && (b.text?.length ?? 0) > 0)
})
if (textAnswers.length >= 3) {
  console.log('[PASS A] 3 turns generated real text answers via local route')
} else {
  failures.push('A: only ' + textAnswers.length + ' text answers')
  console.log('[FAIL A] text answers=' + textAnswers.length)
}

if (reasoningBlocks.length > 0) {
  console.log('[PASS B] reasoning captured: ' + reasoningBlocks.length + ' blocks, ' + reasoningChars + ' chars')
} else {
  failures.push('B: no reasoning blocks captured')
  console.log('[FAIL B] no reasoning blocks in session events')
}

// 判决 C：回放判定——第 3 轮 prompt_tokens 若远大于"全部可见文本+问题的合理 token 量"，
// 说明历史 reasoning 被重放。粗估：1 token 约 3.5 chars（英文），阈值取可见文本 token 估算的 1.8 倍
const last = turnStats[turnStats.length - 1]
if (last !== undefined && last.promptTokens > 0) {
  const visibleTokenEstimate = Math.ceil(visibleChars / 3.5) + 400 // +system/tools/问题余量
  const replayed = last.promptTokens > visibleTokenEstimate * 1.8
  console.log('[VERDICT C] turn-3 prompt=' + last.promptTokens
    + ' vs visible-only estimate~' + visibleTokenEstimate
    + ' -> history reasoning ' + (replayed ? 'IS REPLAYED' : 'NOT replayed'))
  if (replayed) {
    console.log('[VERDICT C] reasoning 回放实证成立：spike 4 引擎需 thinking 剥离机制（或登记卡点 B-2）')
  }
} else {
  console.log('[WARN C] no usage data for replay verdict')
}

await ctx.fiber.dispose()
console.log(failures.length === 0
  ? 'SMOKE VERDICT: PASS（适配器链路打通' + (reasoningBlocks.length > 0 ? '，含 reasoning' : '') + '）'
  : 'SMOKE VERDICT: FAIL（' + failures.join('; ') + '）')
process.exit(failures.length === 0 ? 0 : 1)
