/**
 * P4 声明式挂载实例化验证 v2：boot web profile 树 + 提供 tools/systemPrompt stub，
 * 使 argp 引擎的 inject 依赖满足，确认 ctx.compaction 是 ArgpGraphEngine。
 *
 * 运行：cd deepseek-harness && node --import tsx/esm D:/workspace/ARGP/dsh-argp/spike/22-declarative-mount-check.ts
 */
import { boot } from '@deepseek-ai/dsh-app-boot'
import { readFileSync } from 'node:fs'
import { load } from 'js-yaml'
import type { Context } from '@deepseek-ai/cordis'

// profile 目录：默认 ~/.dsh/profiles/web（dsh 固定 home），可用 ARGP_WEB_PROFILE 覆盖。
// 不用个人绝对路径默认值，保证脚本在任意机器可跑。
const profileDir = process.env['ARGP_WEB_PROFILE'] ??
  (process.env['HOME'] ?? process.env['USERPROFILE']) + '/.dsh/profiles/web'
const rootConfig = profileDir + '/cordis.yml'
const patchYaml = readFileSync(profileDir + '/cordis.patch.yml', 'utf8')
const patches = (load(patchYaml) as unknown[]).filter(p => p !== null && typeof p === 'object')

console.log('=== P4 声明式挂载验证 v2 ===')
console.log('patch 条目数:', patches.length)

try {
  const ctx = await boot('dsh-p4-check', rootConfig, structuredClone(patches), (hostCtx: Context) => {
    // 提供 launch env（阻止网络）；tools/systemPrompt 由 web bundle 提供，
    // 若未提供则注入 stub（验证目标是 compaction 引擎，非工具层）
    hostCtx.provide('launch.environment', { DSH_NO_NETWORK: '1' } as never)
    if ((hostCtx as unknown as { tools?: unknown }).tools === undefined) {
      hostCtx.provide('tools', { register: () => {} } as never)
    }
    if ((hostCtx as unknown as { systemPrompt?: unknown }).systemPrompt === undefined) {
      hostCtx.provide('systemPrompt', {
        persona: 'p4-check',
        section: () => {},
      } as never)
    }
  })
  const compaction = (ctx as unknown as { compaction?: unknown }).compaction
  const engineName = compaction === undefined
    ? 'undefined'
    : (compaction as { constructor?: { name?: string } }).constructor?.name ?? 'unknown'
  console.log('ctx.compaction constructor:', engineName)
  console.log('是 ArgpGraphEngine:', engineName === 'ArgpGraphEngine' ? 'YES' : 'NO')
  await ctx.fiber?.dispose()
} catch (err) {
  console.error('=== P4 验证失败 ===')
  console.error(String(err).slice(0, 800))
  process.exit(1)
}
