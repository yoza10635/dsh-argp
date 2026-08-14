/**
 * spike 1：最小 CompactionEngine 挂载 + 生命周期验证（无 API key，mock 适配器）
 *
 * 判决标准（设计稿 §10 spike 1）：
 *  A. ArgpProbeEngine 作为 ctx.compaction 挂载成功（"Load one implementation per context"）
 *  B. agent 运行时引擎自挂的 agent/pre-step 钩子触发，compactIfNeeded('pressure') 被调用
 *  C. 引擎返回 null 不干扰正常轮次（agent 正常产出最终回答）
 */
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  createUserMessage,
  LlmAdapter,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { ArgpProbeEngine } from '../src/probe-engine.ts'

/** 免 key mock 适配器：单轮直接给最终回答（仿 headless-agent cli-mock-llm）。 */
class ArgpMockAdapter extends LlmAdapter {
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { provider, id: model, name: model }
  }

  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    const reply = 'spike-1 mock answer: mount verified.'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: reply }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
    yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 4 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

const failures: string[] = []

// --- 组装 harness（仿 examples/headless-agent/tests/harness.ts，去掉 bash/todo/持久化）---
const ctx = new Context()
await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: 'spike-1 probe persona' } })
await ctx.plugin(AgentLoop, { agents: [] })
ctx.llm.registerAdapter(['argp-mock'], new ArgpMockAdapter())

// 挂载探针引擎：不加载 TokenMeter/ToolResultPruner/BasicCompactionEngine——
// ARGP 独占 ctx.compaction（设计稿 §1：Load one implementation per context）
await ctx.plugin(ArgpProbeEngine)
const engine = ctx.compaction

// 判决 A：挂载成功且实例正确
if (engine instanceof ArgpProbeEngine) {
  console.log('[PASS A] ArgpProbeEngine mounted as ctx.compaction')
} else {
  failures.push('A: ctx.compaction is not ArgpProbeEngine')
  console.log('[FAIL A] ctx.compaction is not ArgpProbeEngine')
}

// --- 跑一个完整轮次 ---
const agent = ctx.agentLoop.create(SessionId('spike-1'), { provider: 'argp-mock', model: 'mock-1' })
agent.followup(createUserMessage({
  content: [{ type: 'text', text: 'spike 1 probe: answer once, no tools.' }],
  source: { kind: 'user' },
}))
await waitForIdle(ctx, agent)

const events = [...agent.session.events]

// 判决 B：压力钩子触发过，compactIfNeeded('pressure') 被调用
const probe = engine instanceof ArgpProbeEngine ? engine : undefined
const pressureCalls = probe?.calls.filter(call => call.method === 'compactIfNeeded' && call.trigger === 'pressure') ?? []
if (pressureCalls.length > 0) {
  console.log('[PASS B] compactIfNeeded(pressure) invoked ' + pressureCalls.length + 'x; sample: ' + JSON.stringify(pressureCalls[0]))
} else {
  failures.push('B: compactIfNeeded(pressure) never invoked')
  console.log('[FAIL B] probe calls so far: ' + JSON.stringify(probe?.calls ?? []))
}

// 判决 C：引擎空转不干扰轮次，agent 正常产出回答
const lastAssistant = [...events].reverse().find(e => e.type === 'assistant/message')
const answer = lastAssistant === undefined ? '' : JSON.stringify(lastAssistant)
if (answer.includes('mount verified')) {
  console.log('[PASS C] agent completed turn with final answer despite probe engine')
} else {
  failures.push('C: final answer missing or unexpected')
  console.log('[FAIL C] last assistant event: ' + answer.slice(0, 200))
}

await ctx.fiber.dispose()

console.log(failures.length === 0
  ? 'SPIKE 1 VERDICT: PASS（挂载与生命周期验证通过）'
  : 'SPIKE 1 VERDICT: FAIL（' + failures.length + ' 项未过：' + failures.join('; ') + '）')
process.exit(failures.length === 0 ? 0 : 1)
