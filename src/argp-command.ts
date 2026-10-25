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
import type { SessionRuntimeState } from './session-state.js'
import type { BudgetHost } from './budget.js'
import { measureTokens, visibleChars, capRetain } from './budget.js'
import { DEFAULT_WINDOW_TOKENS } from './constants.js'

/**
 * 状态行首展示的版本号。**必须与 `package.json` 的 `version` 一致**——
 * `scripts/prerelease-check.mjs` 有断言守着（发版时忘改会直接卡住发布）。
 */
export const ARGP_STATUS_VERSION = '1.11.0-beta.1'

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
  /**
   * 会话运行时状态桶（批次 3-2：records/recallCalls/citeStats/prunedNodeIndex 改按
   * **发起命令的会话**取桶读取——旧字段是引擎焦点桶 getter，多会话下 /argp 显示的是
   * 别的会话的账（跨会话残留）。stateOf 返回完整 SessionRuntimeState（较 BudgetHost
   * 的窄 {resolvedWindowTokens} 型变宽，引擎真身满足）。
   */
  stateOf: (session: Session) => SessionRuntimeState
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
  const st = session !== null && session !== undefined ? host.stateOf(session) : null

  // 段 1：身份 + 引擎形态 + preset 生效性
  const stage1 = host.peratomStack !== null ? 'graph+peratom' : 'graph'
  let head = 'ARGP ' + ARGP_STATUS_VERSION + ' · engine: ' + stage1
  if (session !== null && session !== undefined) {
    const preset = host.activePresetOf(session)
    const skipped = preset !== undefined && preset !== null && host.skipPresets.includes(preset)
    head += ' · preset: ' + (preset ?? 'unknown') + (skipped ? ' (ARGP inactive — in skipPresets)' : '')
  }
  lines.push(head)

  // 段 2：预算 + 当前占用（D2 桶化：trigger 读**发起命令的会话**的桶，不再读焦点/共享字段；
  // 批次 3-2：retain 口径与引擎一致——显式值走 capRetain 绝对上界（截断时标注），比例值
  // = 可压缩内容（visible）× retainRatio，不再是误导的 window × retainRatio）
  const trigger = host.explicitWindowTokens
    ? host.windowTokens
    : (st !== null ? st.resolvedWindowTokens : DEFAULT_WINDOW_TOKENS)
  let retain: number
  let capNote = ''
  if (session !== null && session !== undefined) {
    if (host.explicitRetainTokens) {
      retain = capRetain(host.retainTokens, trigger, host.reserveTokens)
      if (retain < host.retainTokens) capNote = ' (capped from ' + fmtTokens(host.retainTokens) + ')'
    } else {
      retain = Math.floor(Math.ceil(visibleChars(session) / host.charsPerToken) * host.retainRatio)
    }
  } else {
    retain = Math.floor(trigger * host.retainRatio)
  }
  if (session === null || session === undefined) {
    lines.push('budget: trigger ' + fmtTokens(trigger) + ' / retain ' + fmtTokens(retain) + capNote + ' · no session bound yet')
  } else {
    const m = measureTokens(host, session)
    lines.push('budget: trigger ' + fmtTokens(trigger) + ' / retain ' + fmtTokens(retain) + capNote
      + ' · now ' + fmtTokens(m.contextTokens) + ' (source=' + m.source + ')')
  }

  // 段 3：剪枝台账（**会话桶**；批次 3-2：records 为进程内遥测——重启后由账本重建恢复，
  // 重建未及/失败时不再伪造 0，改报日志真值；auditWarnings 一并露出）
  const records = st?.records ?? []
  const logStarts = session !== null && session !== undefined
    ? session.snapshotEvents().filter(e => e.type === 'compaction/start').length
    : 0
  if (records.length === 0) {
    lines.push(logStarts > 0
      ? 'prunes: 0 in this process · log has ' + logStarts + ' transaction(s) (ledger rebuild pending)'
      : 'prunes: 0 (no compaction yet)')
  } else {
    const last = records[records.length - 1]
    if (last !== undefined) {
      const beforeTok = Math.round(last.charsBefore / host.charsPerToken)
      const afterTok = Math.round(last.charsAfter / host.charsPerToken)
      lines.push('prunes: ' + records.length
        + ' · last ' + last.intervals.length + ' ranges / ' + last.shadowedSeqs.length + ' items / '
        + fmtTokens(beforeTok) + '→' + fmtTokens(afterTok)
        + (last.forced ? ' (forced)' : '')
        + ' · pruned index ' + (st?.prunedNodeIndex.size ?? 0))
    }
  }
  if (st !== null && st.auditWarnings.length > 0) {
    const latest = st.auditWarnings[st.auditWarnings.length - 1] ?? ''
    lines.push('audit: ' + st.auditWarnings.length + ' warning(s) · latest: '
      + (latest.length > 120 ? latest.slice(0, 120) + '…' : latest))
  }

  // 段 4：召回命中（批次 3-2：会话桶 + 进程内口径标注——重启归零不是会话真值）
  const recallCalls = st?.recallCalls ?? []
  const calls = recallCalls.length
  const hits = recallCalls.reduce((n, r) => n + (r.hit ? 1 : 0), 0)
  lines.push('recall: ' + calls + ' calls · ' + hits + ' hits (' + fmtPct(hits, calls) + ') [this process]')

  // 段 5：cites 统计（仅双引擎 declarer 在位时输出；纯 Stage-2 下全 0 无意义）
  if (host.peratomStack?.declarer != null && st !== null) {
    const c = st.citeStats
    lines.push('cites: ' + c.declared + ' declared · ' + c.resolved + ' resolved'
      + ' (' + c.ambiguous + ' ambiguous, ' + c.failed + ' failed) [this process]')
  }

  return { kind: 'success', text: lines.join('\n') }
}
