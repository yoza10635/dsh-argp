/**
 * Shared DeepSeek v4-flash test mount for argp-dsh spikes.
 *
 * The spike harness (mountAgentLoopTestDependencies) does not mount the
 * dsh credentials service, so this helper loads DEEPSEEK_API_KEY from the
 * standard user credential file when the process environment lacks it.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'

export const DEEPSEEK_PROVIDER = 'deepseek-official'
export const DEEPSEEK_MODEL = 'deepseek-v4-flash'

const thinking = process.env['ARGP_DEEPSEEK_THINKING'] === 'enabled' ? 'enabled' as const : 'disabled' as const
const reasoning = process.env['ARGP_DEEPSEEK_REASONING'] ?? (thinking === 'enabled' ? 'high' as const : 'off' as const)
export const DEEPSEEK_REASONING_EFFORT = reasoning as 'off' | 'low' | 'high' | 'max'

export const DEEPSEEK_FLASH_CONFIG = {
  thinking,
  reasoningEffort: DEEPSEEK_REASONING_EFFORT,
  models: [{
    id: DEEPSEEK_MODEL,
    name: 'DeepSeek-V4-Flash',
    // 适配器声明的上下文容量；BasicCompactionEngine 触发线 = contextWindow × thresholdRatio。
    // 160K 主流场景档设 ARGP_CONTEXT_WINDOW=200000（×0.8=160K 触发）。
    contextWindow: Number(process.env['ARGP_CONTEXT_WINDOW'] ?? 128_000),
  }],
}

/** Load DEEPSEEK_API_KEY from ~/.dsh/.credentials.yaml unless already set. */
export function ensureDeepSeekApiKey(env: NodeJS.ProcessEnv = process.env): void {
  if (env['DEEPSEEK_API_KEY'] !== undefined && env['DEEPSEEK_API_KEY'].length > 0) return
  const credentialFile = join(homedir(), '.dsh', '.credentials.yaml')
  const text = readFileSync(credentialFile, 'utf8')
  const match = /^DEEPSEEK_API_KEY:\s*['"]?([^'"\r\n]+)['"]?\s*$/m.exec(text)
  const value = match?.[1]?.trim()
  if (value === undefined || value.length === 0) {
    throw new Error(`deepseek-v4-flash: DEEPSEEK_API_KEY not set and not found in ${credentialFile}`)
  }
  env['DEEPSEEK_API_KEY'] = value
}

/** Mount the official DeepSeek adapter for deepseek-v4-flash tests. */
export async function mountDeepSeekFlash(ctx: Context): Promise<void> {
  ensureDeepSeekApiKey()
  await ctx.plugin(LlmDeepSeek, DEEPSEEK_FLASH_CONFIG)
}
