/**
 * 共享模型装配：deepseek（官方 API）| qwen-local（127.0.0.1:8080 llama.cpp）。
 *
 * qwen-local 复用 dsh 的 llm-deepseek 适配器，仅覆盖 baseURL（$DEEPSEEK_BASE_URL /
 * config.baseURL）——适配器的请求路径是 ${baseURL}/chat/completions，而 llama.cpp
 * 的 OpenAI 兼容端点是 /v1/chat/completions，故 base 须含 /v1。
 * 已由 spike/20-qwen-smoke.ts 验证：thinking 块正确解析为 reasoning 事件，无需新适配器。
 */
import type { Context } from '@deepseek-ai/cordis'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import { DEEPSEEK_MODEL, DEEPSEEK_PROVIDER, DEEPSEEK_REASONING_EFFORT, mountDeepSeekFlash } from './deepseek.ts'

export interface ModelMount {
  provider: string
  model: string
  reasoning: 'off' | 'low' | 'high' | 'max'
  /** 模型声明的上下文容量（token）——用于适配器 catalog；ARGP 触发线由 ARGP_WINDOW_TOKENS 单独控制 */
  contextWindow: number
}

export type ModelSource = 'deepseek' | 'qwen-local'

/** 从环境变量解析模型源（ARGP_MODEL_SOURCE，默认 deepseek）。 */
export function resolveModelSource(env: NodeJS.ProcessEnv = process.env): ModelSource {
  return env['ARGP_MODEL_SOURCE'] === 'qwen-local' ? 'qwen-local' : 'deepseek'
}

/** 装配模型插件，返回 agent 创建所需的 provider/model/reasoning 三元组。 */
export async function mountModel(ctx: Context): Promise<ModelMount> {
  const source = resolveModelSource()
  if (source === 'qwen-local') {
    const base = process.env['QWEN_BASE'] ?? 'http://127.0.0.1:8080/v1'
    const model = process.env['QWEN_MODEL'] ?? 'Qwen3.8-27B'
    const contextWindow = Number(process.env['QWEN_CONTEXT_WINDOW'] ?? 196_608)
    // 本地服务不需要真实 key，但适配器要求 apiKeyEnv 有值
    process.env['DEEPSEEK_API_KEY'] = process.env['DEEPSEEK_API_KEY'] ?? 'dummy-local'
    await ctx.plugin(LlmDeepSeek, {
      thinking: 'disabled',
      reasoningEffort: 'off',
      baseURL: base,
      models: [{ id: model, name: model, contextWindow }],
    })
    return { provider: 'deepseek-official', model, reasoning: 'off', contextWindow }
  }
  await mountDeepSeekFlash(ctx)
  return { provider: DEEPSEEK_PROVIDER, model: DEEPSEEK_MODEL, reasoning: DEEPSEEK_REASONING_EFFORT, contextWindow: Number(process.env['ARGP_CONTEXT_WINDOW'] ?? 128_000) }
}
