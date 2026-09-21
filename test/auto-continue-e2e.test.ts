/**
 * L3 端到端：真 agent 循环里，"输出被钳 ⇒ 剪 + steer ⇒ **同一个 turn** 继续跑"。
 *
 * 这是 1.5.0 的验收主线。单测（trigger-levels.test.ts）只能证明"我们调了 steer"，
 * 证明不了"宿主会因此续同一个 turn"——那半截在宿主侧：
 *   ① `agent-loop/src/agent.ts:483`：`finish.kind === 'max-tokens'` 时**先于**
 *      `executeToolCalls` 直接 return ⇒ 该步的 tool calls 被丢弃；
 *   ② `turn()`：`turnEnds && inbox.nextStep.length === 0` ⇒ break（收轮）；
 *   ③ 因此只有 steer 把 next-step 填上，循环才会以 `target='next-step'` 续跑。
 * 本文件用真 AgentLoop + 脚本化适配器把这条链走通，断言落在两处：
 *   · 适配器收到的请求数（3 = 第 2 轮被钳后自动续了一次）；
 *   · 会话里 `turn/start` 的条数（2 = 续跑没有新开 turn，正是"同一 turn 继续推进任务"）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ArgpGraphEngine } from '../src/argp-graph-engine.ts'

/** 正常收尾的回答。 */
function textResponse(text: string, outputTokens = text.length): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/**
 * 被宿主/适配器钳制的回答：`finish = max-tokens` 但 `usage.outputTokens` 远小于请求声明的
 * maxTokens（真会话实测 1,911 / 1 / 4,714 vs 32,768）——引擎判据即此形状。
 */
function clampedResponse(text: string, outputTokens: number): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 176_053, outputTokens } },
    { type: 'finish', reason: { kind: 'max-tokens' } },
  ]
}

/** 按脚本逐次作答，并记录收到的全部请求。 */
class ScriptAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  private readonly script: StreamChunk[][]
  // 注意：Node 的 strip-only TS 模式不支持参数属性（constructor(private x)）⇒ 显式赋值。
  constructor(script: StreamChunk[][]) {
    super()
    this.script = script
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.script.shift()
    if (entry === undefined) throw new Error('ScriptAdapter: script exhausted')
    for (const chunk of entry) yield chunk
  }
}

/**
 * 等待 agent 回到 idle。P3.5 兜底超时：node:test 无默认超时，若 idle 事件丢失
 * （宿主/钩子异常）原实现永不 resolve ⇒ 整组挂死而非失败。现加 setTimeout 兜底，
 * 超时即 reject（测试失败而非挂死）；正常 idle 到达则清掉定时器。
 */
function waitForIdle(ctx: Context, agent: Agent, timeoutMs = 15_000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      dispose()
      reject(new Error('waitForIdle: no idle event within ' + timeoutMs + 'ms (idle event lost)'))
    }, timeoutMs)
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        if (settled) return
        settled = true
        clearTimeout(timer)
        dispose()
        resolve()
      }
    })
  })
}

function countEvents(agent: Agent, type: string): number {
  return agent.session.snapshotEvents().filter(event => event.type === type).length
}

/**
 * 压力阈值定到够不到（windowTokens 极大）⇒ 只剩 `context-overflow` 强制路径可剪，
 * 于是"续写"必然是 L3 的功劳，不会与 L1/L1' 混淆。
 */
async function makeHarness(script: StreamChunk[][], engineConfig: Record<string, unknown> = {}) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: 'argp auto-continue e2e' } })
  await ctx.plugin(ArgpGraphEngine, {
    windowTokens: 10_000_000, retainTokens: 50, minSpanChars: 20, recencyGuard: 0, maxPasses: 16,
    ...engineConfig,
  })
  const harness = await mountAgentLoopTestHarness(ctx)
  const adapter = new ScriptAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  return { ctx, harness, adapter }
}

function send(agent: Agent, text: string): void {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}

test('E2E① 被钳 ⇒ 剪 + steer ⇒ 同一 turn 自动续跑（用户不必再发"继续"）', async () => {
  const { ctx, harness, adapter } = await makeHarness([
    textResponse('turn 1 done'),                        // 第 1 轮：正常收尾（垫入可剪历史）
    clampedResponse('I was cut off mid-', 1),           // 第 2 轮：被钳（output 1 ≪ 请求 32,768）
    textResponse('…continuing the task where I stopped'), // 续写步：同一 turn 内
  ])
  try {
    const agent = await harness.create(SessionId('ac-e2e-on'), { provider: 'mock', model: 'mock', maxTokens: 32_768 })

    send(agent, 'turn1: ' + 'x'.repeat(400))
    await waitForIdle(ctx, agent)
    send(agent, 'turn2: ' + 'y'.repeat(400))
    await waitForIdle(ctx, agent)

    assert.equal(adapter.requests.length, 3, '第 2 轮被钳后自动续了一次（无需新用户消息）')
    assert.equal(countEvents(agent, 'turn/start'), 2, '续跑在**同一个 turn** 内（没有新开 turn）')
    assert.equal(countEvents(agent, 'turn/end'), 2, '总 turn 数不变')

    const third = JSON.stringify(adapter.requests[2]?.messages ?? [])
    assert.match(third, /截断/, '第 3 次请求带上了续写提示（steer 消息确实进了请求）')
    assert.match(third, /不要重述/, '提示内容可执行（接着写、勿重述）')
  } finally {
    await ctx.fiber.dispose()
  }
})

test('E2E② 对照组：正常收尾的 turn 不会被续（证明 E2E① 的第三次请求非常态）', async () => {
  const { ctx, harness, adapter } = await makeHarness([
    textResponse('turn 1 done'),
    textResponse('turn 2 done'),
  ])
  try {
    const agent = await harness.create(SessionId('ac-e2e-off'), { provider: 'mock', model: 'mock', maxTokens: 32_768 })

    send(agent, 'turn1: ' + 'x'.repeat(400))
    await waitForIdle(ctx, agent)
    send(agent, 'turn2: ' + 'y'.repeat(400))
    await waitForIdle(ctx, agent)

    assert.equal(adapter.requests.length, 2, '正常收尾 ⇒ 不多发请求')
    assert.equal(countEvents(agent, 'turn/start'), 2)
  } finally {
    await ctx.fiber.dispose()
  }
})

test('E2E③ 续写额度用尽 ⇒ 回到旧行为（本轮结束、等用户），不会无限续', async () => {
  const { ctx, harness, adapter } = await makeHarness([
    textResponse('turn 1 done'),
    clampedResponse('cut A ', 1),   // 第 2 轮：被钳 ⇒ 续 1 次
    clampedResponse('cut B ', 1),   // 续写步又被钳 ⇒ 额度用尽 ⇒ 收轮
  ], { reactiveRetries: 1 })
  try {
    const agent = await harness.create(SessionId('ac-e2e-cap'), { provider: 'mock', model: 'mock', maxTokens: 32_768 })

    send(agent, 'turn1: ' + 'x'.repeat(400))
    await waitForIdle(ctx, agent)
    send(agent, 'turn2: ' + 'y'.repeat(400))
    await waitForIdle(ctx, agent)

    assert.equal(adapter.requests.length, 3, '续了一次（第 3 次请求）；再被钳时不再续')
    assert.equal(countEvents(agent, 'turn/start'), 2, '仍只有 2 个 turn')
  } finally {
    await ctx.fiber.dispose()
  }
})
