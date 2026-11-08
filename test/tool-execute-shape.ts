/**
 * ctx.tools.execute 两线形状适配层（CI 矩阵 oldest 格依赖；只服务测试，运行时代码无关）。
 *
 * - ≥0.2.2-rc.1：**批式**。入参 `{signal, calls:[{type,id,name,arguments:JSON 串}], agent?}`，
 *   返回 `{results:[{callId,result}]}`。
 * - ≤0.2.1 线（oldest 格装树 = v1.11.0-beta.0 锁，dsh-tools 0.2.0-rc.1）：**单发**。
 *   入参 `{signal, callId, name, arguments:对象, agent?}`，返回直接是 `{content,isError,error}`。
 *
 * 形状判定以**实际装树**为地面真值：直读已安装的 node_modules/@deepseek-ai/dsh-tools/package.json
 * 版本（绕过 exports 映射，不依赖包导出 version）。44ff291 曾只按新批式写测试，CI oldest 格
 * 在 `batch.results` undefined 上炸穿——本文件即该回归的锁；oldest 矩阵格跑不到绿就合不进去。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'

const toolsPkgPath = fileURLToPath(new URL('../node_modules/@deepseek-ai/dsh-tools/package.json', import.meta.url))
const installedToolsVersion: string = (JSON.parse(readFileSync(toolsPkgPath, 'utf8')) as { version: string }).version

/** 装树的 dsh-tools 是否走批式 execute 线。批式自 0.2.2 引入（0.2.0/0.2.1 线均单发）；
 * 按线（core 版本）判定即可——预发布后缀不改变线归属，也免拉 semver 的类型依赖。 */
const [maj, min, patch] = installedToolsVersion.split('-')[0].split('.').map(Number)
export const BATCH_TOOL_EXECUTE = maj > 0 || min > 2 || (maj === 0 && min === 2 && patch >= 2)

/** 单工具结果的两线统一视图：旧线返回体本身；新线取 batch.results[0].result。 */
export interface ToolOutcome {
  content?: { type: string; text?: string }[]
  isError?: boolean
  error?: { message?: string }
}

/** 结果体 → 纯文本（测试统一口径：首块 text，否则空串）。 */
export function toolText(res: ToolOutcome | undefined): string {
  return res?.content?.[0]?.type === 'text' ? res.content[0].text ?? '' : ''
}

/** 按装树形状经 ctx.tools.execute 走一次工具，返回统一的 ToolOutcome。 */
export async function execTool(
  ctx: Context,
  opts: { name: string; args: Record<string, unknown>; callId: string; agentSession?: unknown },
): Promise<ToolOutcome | undefined> {
  const signal = new AbortController().signal
  const agent = opts.agentSession !== undefined ? { agent: { session: opts.agentSession } } : {}
  if (BATCH_TOOL_EXECUTE) {
    const batch = (await ctx.tools.execute({
      signal,
      calls: [{ type: 'tool-use', id: opts.callId, name: opts.name, arguments: JSON.stringify(opts.args) }],
      ...agent,
    } as never)) as unknown as { results?: { callId: string; result: ToolOutcome }[] }
    return batch?.results?.[0]?.result
  }
  return (await ctx.tools.execute({
    signal,
    callId: opts.callId,
    name: opts.name,
    arguments: opts.args,
    ...agent,
  } as never)) as unknown as ToolOutcome
}
