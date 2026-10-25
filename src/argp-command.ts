/**
 * `/argp` 只读状态命令（1.10.0）。
 *
 * 动机：ARGP 的全部状态（预算、剪枝台账、召回命中、cites 统计）都在引擎实例里，
 * 但此前**没有任何人类可见的出口**——判断"压缩到底生效了没有"只能去翻日志。
 * 本命令把引擎的内观测面搬到一个 `/argp` 上，零模型交互、零副作用。
 *
 * ⚠️ 三条硬边界（设计约束，不是实现细节）：
 *
 * 1. **只读**：handler 只拼文本，绝不触发压缩。手动压缩走宿主官方的 `/compact`
 *    （`@deepseek-ai/dsh-command-compact`，由各 preset 层挂载），它调
 *    `ctx.compaction.compactNow(agent, signal, commandId)` —— 落到的就是本引擎。
 *    再开 `/argp compact` 只是重复入口，还多背一条 `sourceCommandId` 契约面
 *    （铁律 1③），故**不做**。
 *
 * 2. **不新增 boot 期失败面**：宿主命令服务经嵌套 `ctx.inject(['commands'], ...)`
 *    获取（与 `session-lifecycle.registerSettings` 同款）。宿主没有 commands 服务时
 *    inject 回调永不执行 ⇒ 命令静默不注册，引擎其余部分照常工作。当前正在排查
 *    dsh.so 的 L5.2 web boot 失败，任何"缺服务即抛"的写法都会污染那边的归因。
 *
 * 3. **宿主契约不自己复刻**：命令的注册/生命周期（`command/run` ↔ `command/done`）
 *    全部由宿主 `CommandRuntime` 负责，本模块只提供 `{name, description, handler}`
 *    三件套（铁律 3）。测试跑真实 `CommandRuntime`，不 mock。
 *
 * 生命周期事件由宿主写入：每次调用落 `command/run` + `command/done`（log-only，
 * 不进 model surface），与 `/compact` 同口径。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { Session } from '@deepseek-ai/dsh-session'
import type { CiteStats } from './graph-build.js'
import type { GraphPruneRecord } from './prune-tx.js'
import type { BudgetHost } from './budget.js'
import { measureTokens } from './budget.js'

/**
 * 状态行首展示的版本号。**必须与 `package.json` 的 `version` 一致**——
 * `scripts/prerelease-check.mjs` 有断言守着（发版时忘改会直接卡住发布）。
 */
export const ARGP_STATUS_VERSION = '1.11.0-beta.0'

/** 命令名（不带斜杠）。UI 发现列表按此展示。 */
export const ARGP_COMMAND_NAME = 'argp'

/** 命令描述（发现 UI 的一行说明）。 */
export const ARGP_COMMAND_DESCRIPTION = 'Show ARGP context-compression status for this session (read-only)'

/**
 * 状态渲染所需的引擎切片（窄接口）。
 *
 * 与 `LifecycleHost` / `BudgetHost` 同理：本模块只声明自己要读的字段，经
 * `this as unknown as ArgpStatusHost` 从引擎实例转换而来，不把命令模块反向
 * 耦合到 `ArgpGraphEngine` 这个大类上（也避免测试要构造整个引擎）。
 */
export interface ArgpStatusHost extends BudgetHost {
  /** 剪枝台账（有界环形缓冲，见 telemetry.pushBounded）。 */
  readonly records: GraphPruneRecord[]
  /** 召回调用记录（有界）。 */
  readonly recallCalls: { seq: number; hit: boolean }[]
  /** cites 边声明统计（Stage-1 declarer 喂 Stage-2 injectEdges）。 */
  readonly citeStats: CiteStats
  /** 已剪节点目录（seq → 元信息），供 list_pruned / recall_pruned 查询。 */
  readonly prunedNodeIndex: Map<number, unknown>
  /** 双引擎自挂载句柄（null = 纯 Stage-2 图引擎）。诊断"双引擎到底挂没挂"的唯一出口。 */
  readonly peratomStack: { compressor: unknown | null; declarer: unknown | null; zoom: unknown | null } | null
  /** 在这些 preset 下引擎不生效（默认 ['minimal']）。 */
  readonly skipPresets: string[]
  /** 引擎当前绑定的会话（可能尚未绑定）。 */
  readonly session: Session | null
  /** 会话实际运行的 preset id（无 preset 概念时 undefined）。 */
  activePresetOf(session: Session): string | null | undefined
}

/** 宿主命令服务的窄接口（避免 import 运行时实现，只触达 register）。 */
interface CommandRegistryLike {
  register(definition: {
    name: string
    description: string
    input?: { hint: string }
    recordInput?: boolean
    handler: (invocation: CommandInvocation) => CommandResult | Promise<CommandResult>
  }): () => void
}

/**
 * 注册 `/argp`（幂等、可降级）。
 *
 * 与 `registerSettings` 同构：嵌套 inject 拿到 commands 服务后才注册，注册动作
 * 包在 `ctx.effect` 里（返回的 disposer 在插件卸载/重挂载时自动注销命令）。
 */
export function registerArgpCommand(ctx: Context, host: ArgpStatusHost): void {
  ctx.inject(['commands'], (scopedCtx: Context) => {
    const registry = (scopedCtx as unknown as { commands?: CommandRegistryLike }).commands
    if (registry === undefined || typeof registry.register !== 'function') return
    scopedCtx.effect(() => registry.register({
      name: ARGP_COMMAND_NAME,
      description: ARGP_COMMAND_DESCRIPTION,
      input: { hint: '(no arguments)' },
      // 无参数命令：`rawInput` 不落 `command/run`，避免日志里堆空串。
      recordInput: false,
      handler: (invocation: CommandInvocation) => renderArgpStatus(host, invocation),
    }))
  })
}

/** token 数的人读格式：>=1000 显示 `xx.xk`，否则原样。 */
function fmtTokens(tokens: number): string {
  if (!Number.isFinite(tokens)) return '?'
  if (Math.abs(tokens) >= 1000) return (tokens / 1000).toFixed(1) + 'k'
  return String(Math.round(tokens))
}

/** 百分比（0 调用时返回 `n/a` 而不是 0%，避免"零命中"与"没调用"混为一谈）。 */
function fmtPct(hit: number, total: number): string {
  if (total === 0) return 'n/a'
  return Math.round((hit / total) * 100) + '%'
}

/**
 * 渲染状态文本（分段详单）。纯函数，除 `measureTokens` 的读操作外无副作用。
 *
 * 段数自适应：无意义的段（如未挂 declarer 时的 cites 段）整段省略，
 * 宁可少一行也不输出恒为 0 的噪声。
 */
export function renderArgpStatus(host: ArgpStatusHost, invocation: Pick<CommandInvocation, 'agent'>): CommandResult {
  const session = (invocation.agent as unknown as { session?: Session } | undefined)?.session ?? host.session
  const lines: string[] = []

  // 段 1：身份 + 引擎形态 + preset 生效性
  const stage1 = host.peratomStack !== null ? 'graph+peratom' : 'graph'
  let head = 'ARGP ' + ARGP_STATUS_VERSION + ' · engine: ' + stage1
  if (session !== null && session !== undefined) {
    const preset = host.activePresetOf(session)
    const skipped = preset !== undefined && preset !== null && host.skipPresets.includes(preset)
    head += ' · preset: ' + (preset ?? 'unknown') + (skipped ? ' (ARGP inactive — in skipPresets)' : '')
  }
  lines.push(head)

  // 段 2：预算 + 当前占用
  const trigger = host.resolvedWindowTokens
  const retain = host.explicitRetainTokens ? host.retainTokens : Math.floor(trigger * host.retainRatio)
  if (session === null || session === undefined) {
    lines.push('budget: trigger ' + fmtTokens(trigger) + ' / retain ' + fmtTokens(retain) + ' · no session bound yet')
  } else {
    const m = measureTokens(host, session)
    lines.push('budget: trigger ' + fmtTokens(trigger) + ' / retain ' + fmtTokens(retain)
      + ' · now ' + fmtTokens(m.contextTokens) + ' (source=' + m.source + ')')
  }

  // 段 3：剪枝台账（次数 + 最近一次的形状）
  const total = host.records.length
  if (total === 0) {
    lines.push('prunes: 0 (no compaction yet)')
  } else {
    const last = host.records[total - 1]
    const beforeTok = Math.round(last.charsBefore / host.charsPerToken)
    const afterTok = Math.round(last.charsAfter / host.charsPerToken)
    lines.push('prunes: ' + total
      + ' · last ' + last.intervals.length + ' ranges / ' + last.shadowedSeqs.length + ' items / '
      + fmtTokens(beforeTok) + '→' + fmtTokens(afterTok)
      + (last.forced ? ' (forced)' : '')
      + ' · pruned index ' + host.prunedNodeIndex.size)
  }

  // 段 4：召回命中（recall_pruned / recall_detail 的实际使用面）
  const calls = host.recallCalls.length
  const hits = host.recallCalls.reduce((n, r) => n + (r.hit ? 1 : 0), 0)
  lines.push('recall: ' + calls + ' calls · ' + hits + ' hits (' + fmtPct(hits, calls) + ')')

  // 段 5：cites 统计（仅双引擎 declarer 在位时输出；纯 Stage-2 下全 0 无意义）
  if (host.peratomStack?.declarer != null) {
    const c = host.citeStats
    lines.push('cites: ' + c.declared + ' declared · ' + c.resolved + ' resolved'
      + ' (' + c.ambiguous + ' ambiguous, ' + c.failed + ' failed)')
  }

  return { kind: 'success', text: lines.join('\n') }
}
