/**
 * spike 37a — P5 成本口径探针：本地 llama.cpp × dsh-llm-deepseek 适配器 usage 映射
 *
 * 背景：P5 三臂要测成本三元组 (miss, hit, out)。本地 llama.cpp 的 raw 响应已验证
 * 带 prompt_tokens_details.cached_tokens（同前缀第二次请求 cached>0），但 dsh 适配器
 * 如何把它映射进 session 事件的 assistant/message usage（inputTokens / cacheReadTokens /
 * outputTokens）未实证。本探针用与 35/36 同款的 LlmDeepSeek(qwen-local) 装配跑两轮：
 *   轮 1 长 user（~2.5K token）
 *   轮 2 短 followup（前缀与轮 1 共享 → 预期 cacheReadTokens>0）
 * 并 dump 每轮 assistant/message 的 usage 全字段 + raw 事件，判定：
 *   U1 适配器是否把 cached_tokens 映射为 usage.cacheReadTokens（或类似字段）
 *   U2 inputTokens 口径：= prompt_tokens（含 cached）还是 prompt - cached（miss-only）
 *   U3 reasoning 是否计入 outputTokens
 *
 * 用法：npm run spike37a（需本地 llama.cpp :8080）
 * 产物：stdout 打印（不写文件，探针性质）
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import { SessionId } from '@deepseek-ai/dsh-session'

const BASE = (process.env['QWEN_BASE'] ?? 'http://127.0.0.1:8080/v1').replace(/\/$/, '')
const MODEL = process.env['QWEN_MODEL'] ?? 'Qwen3.6-35B-A3B'

// ~2.5K token 共享前缀（约 10K 字符）
const LONG_PREFIX = Array.from({ length: 250 }, (_, i) => `cfg-line-${i}: value=${i * 7} mode=${i % 2 ? 'on' : 'off'} region=cn-north-1`).join('\n')

function waitIdle(ctx: Context, agent: { session: unknown }): Promise<void> {
  return new Promise(resolve => {
    const dispose = ctx.on('agent/status', ({ agent: a, status }) => {
      if (a === agent && status === 'idle') { dispose(); resolve() }
    })
  })
}

async function main(): Promise<void> {
  process.env['DEEPSEEK_API_KEY'] = process.env['DEEPSEEK_API_KEY'] ?? 'dummy-local'
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: 'usage-probe persona' } })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LlmDeepSeek, {
    thinking: 'disabled',
    reasoningEffort: 'off',
    baseURL: BASE,
    models: [{ id: MODEL, name: MODEL, contextWindow: 196_608 }],
  })

  const agent = ctx.agentLoop.create(SessionId('spike-37a-usage'), {
    provider: 'deepseek-official',
    model: MODEL,
    reasoningEffort: 'off',
  })

  agent.followup(createUserMessage({ content: [{ type: 'text', text: LONG_PREFIX + '\n用一句话确认你收到了配置清单。' }], source: { kind: 'user' } }))
  await waitIdle(ctx, agent)
  console.log('[turn1 done] events=' + agent.session.events.length)

  agent.followup(createUserMessage({ content: [{ type: 'text', text: '再确认一次。' }], source: { kind: 'user' } }))
  await waitIdle(ctx, agent)
  console.log('[turn2 done] events=' + agent.session.events.length)

  const asst = agent.session.events.filter(e => e.type === 'assistant/message')
  console.log('\n=== assistant/message usage 全字段 ===')
  for (const e of asst) {
    const d = e.data as { turn?: number; usage?: unknown; message?: { content?: unknown[] } }
    console.log(`\n--- turn=${d.turn} seq=${e.seq} ---`)
    console.log('usage=' + JSON.stringify(d.usage))
    // message content 各 block 的字段（看是否有独立 usage/缓存字段）
    const content = Array.isArray(d.message?.content) ? d.message.content : []
    for (const b of content) {
      const blk = b as Record<string, unknown>
      console.log('block type=' + String(blk['type']) + ' keys=[' + Object.keys(blk).join(',') + ']')
    }
  }

  // 判定输出
  const u2 = (asst[1]?.data as { usage?: Record<string, unknown> })?.usage ?? {}
  console.log('\n=== 判定 ===')
  console.log('轮2 usage 原始: ' + JSON.stringify(u2))
  const cacheKeys = Object.keys(u2).filter(k => /cache/i.test(k))
  console.log('U1 cache 字段: ' + (cacheKeys.length ? cacheKeys.join(',') : '无 → 适配器未暴露 cached_tokens'))
  const inTok = Number(u2['inputTokens'] ?? -1)
  const cacheRead = Number(u2['cacheReadTokens'] ?? u2['cachedTokens'] ?? -1)
  if (inTok > 0 && cacheRead >= 0) {
    console.log(`U2 inputTokens=${inTok} cacheRead=${cacheRead} → ${cacheRead > 0 ? 'inputTokens 含 cached（prompt 全量口径），miss = input - cacheRead' : 'cacheRead=0（轮2 未命中或字段名不符）'}`)
  }

  // 落盘完整事件供交叉验证
  const outDir = path.join(process.cwd(), 'spike', 'out')
  fs.mkdirSync(outDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const outFile = path.join(outDir, `37a-usage-${stamp}.json`)
  fs.writeFileSync(outFile, JSON.stringify({ base: BASE, model: MODEL, asstEvents: asst }, null, 2))
  console.log('\n产物：' + outFile)

  await ctx.fiber.dispose()
}

main().catch(err => {
  console.error(err)
  process.exitCode = 1
})
