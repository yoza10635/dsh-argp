/**
 * ARGP 建边版引擎（spike 5，M3）：原子化 + 建图 + 图序剪枝 + cites 义务。
 *
 * 按设计稿 §3-§7 移植，机制验证版简化（差异台账见 design-vs-impl-trace.md（已迁出公开仓库））：
 *  - 版本链去重为简化版（相同文本全等去重、A/R 成对，非设计 §5.13 的 θ=0.8 重叠归链）、summarize 降级默认关闭（§4.6.1，候选耗尽走 force_prune）、catalog 已支持
 *  - 占位主路径（§8.3 路径 b）+ 区间 replace；事务仿 spike 4（借 compaction/summary 语义，候选卡点 B-3）
 *  - 配对自保：A（含 tool-call 块）+ 应答 R 成组同剪；U 与 tombstone 永不参剪（不变式 6）。
 *    实测：dsh surface 无 tool/call 节点（SURFACE_EVENT_TYPES 三类），call 块内嵌在 assistant/message 里
 *  - cites 义务开启：正为回答母表待决项（本地新 SOTA 模型的 cites 服从率）
 *  - 触发/目标同一可见字符估算基准（不变式 2）；reasoning 块不计入预算（spike 4a 判决 C）
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { CompactionEngine, CompactionId, compactCheckpointSource, toolPairingBalancedAfter, toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction'
import type {
  CompactionAgentContext,
  CompactionResult,
  CompactionTrigger,
  ManualCompactAgentContext,
} from '@deepseek-ai/dsh-compaction'
import { CONTEXT_WINDOW_EXCEEDED_CODE, createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Session } from '@deepseek-ai/dsh-session'
import type { Agent, PreStepDecision, RequestErrorAction } from '@deepseek-ai/dsh-agent'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
import { asSeq, asSeqs, detectOpenTurn, eventText, formatLogRow, formatRecallOutcome, nodeStateOf, queryLogRange, recallFromLog, sessionEvents, stateHeader, turnOf } from './log-access.js'
import type { NodeState as NodeStateLabel } from './log-access.js'
export type { NodeState, LogRow, LogRowType } from './log-access.js'
// eventText 已迁 log-access（P5 Wave 3 第 1 步）；此处转发以维持既有公共 API 与测试 import。
export { eventText } from './log-access.js'
// 通用类型收敛到叶子 argp-types（P5 Wave 3 第 1 步）：本地使用 + 转发维持公共 API。
import type { Atom, AtomType, EdgeLevel, SemanticEdge, DeterministicEdge, ArgpUserSettings } from './argp-types.js'
import { EDGE_WEIGHTS, LEVEL_ORDER } from './argp-types.js'
export type { Atom, AtomType, EdgeLevel, SemanticEdge, DeterministicEdge, ArgpUserSettings } from './argp-types.js'
export { EDGE_WEIGHTS } from './argp-types.js'
import { matchCitesTail, parseCitesBlock } from './cites-strip.js'
import type { ParsedCite, CiteLevel } from './cites-strip.js'
import {
  DEFAULT_CHARS_PER_TOKEN,
  DEFAULT_MAX_PASSES,
  DEFAULT_RETAIN_RATIO,
  DEFAULT_RETAIN_TOKENS,
  DEFAULT_WINDOW_RATIO,
  DEFAULT_WINDOW_TOKENS,
} from './constants.js'
import { DEFAULT_TELEMETRY_CAP, pushBounded } from './telemetry.js'
export type { ParsedCite, CiteLevel } from './cites-strip.js'
import { deriveInferredEdges, type InferredEdgeOptions } from './token-ontology.js'
import { cleanShippedPresets, type PresetCleanOptions, type PresetRosterLike } from './preset-cleaner.js'
export type { PresetCleanOptions, PresetCleanReport, PresetRow } from './preset-cleaner.js'
import { PeratomCompressor, type PeratomCompressorConfig } from './peratom/compressor.js'
import { CiteDeclarer, type CiteDeclarerConfig } from './peratom/cite-declarer.js'
import { RecallZoom, type RecallZoomConfig } from './peratom/recall-zoom.js'
import { ARG_NS, isArgpUserInfo } from './peratom/types.js'
import z from '@deepseek-ai/schemastery'
// NOTE: intentionally NO import of `installSettingsSection` / `settingsNamespace`
// from `@deepseek-ai/dsh-settings`: dsh 0.1.2-alpha.1 deleted both. A missing
// NAMED EXPORT is not a missing service — an ESM named import that resolves to
// nothing is a SyntaxError at module evaluation, which cordis reports as a
// failed entry and the host exits 1 (installing this plugin stops the host
// booting at all). Verified against the reference implementation
// (dshmarket/src/settings.ts) and confirmed by live probe on this host:
// `@deepseek-ai/dsh-settings` resolves but exports only
// SettingsConflictError / SettingsProvider / default / redactSecrets.
// The `settings` SERVICE itself never changed, so we call
// `settings.register(ns, schema, { base })` through `ctx.inject` — the
// graceful-degradation boundary — and validate the namespace locally.

/** 设置页 namespace key（同时是 Host 服务端与客户端卡片的 key，须一致才进渲染交集）。 */
export const ARG_SETTINGS_KEY = 'dsh-argp'

/** 引擎设置 schema（schemastery）：校验 UI 写入 + 提供 describe 视图。默认值=引擎既有默认。 */
export const ArgpUserSettingsSchema = z.object({
  windowRatio: z.number().min(0.1).max(1).default(DEFAULT_WINDOW_RATIO),
  retainRatio: z.number().min(0.05).max(1).default(DEFAULT_RETAIN_RATIO),
  maxPasses: z.number().step(1).min(1).default(DEFAULT_MAX_PASSES),
  recencyGuard: z.number().step(1).min(0).default(4),
  turnGuard: z.number().step(1).min(0).default(1),
  minSpanChars: z.number().step(1).min(0).default(0),
  enableSummarize: z.boolean().default(false),
  sortMode: z.string().default('density'),
  charsPerToken: z.number().min(0.5).max(8).default(DEFAULT_CHARS_PER_TOKEN),
}) as z<ArgpUserSettings>

/**
 * The namespace pattern `settingsNamespace` enforced before it was removed.
 * Kept as a literal check rather than an import (see the note above).
 */
const NAMESPACE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

/** Namespace the card on the browser side keys itself to. */
const ARG_SETTINGS_NS: string = ARG_SETTINGS_KEY

if (!NAMESPACE_PATTERN.test(ARG_SETTINGS_NS)) {
  throw new TypeError(`settings namespace "${ARG_SETTINGS_NS}" must match ${String(NAMESPACE_PATTERN)}`)
}

/** 比例预算纯函数：window = ctx × windowRatio；retain = window × retainRatio（缺省回退）。导出供测试。 */
export function scaleBudgets(
  contextWindow: number | undefined,
  opts: { windowRatio?: number; retainRatio?: number; explicitWindow?: number; explicitRetain?: number; fallbackWindow?: number; fallbackRetain?: number },
): { windowTokens: number; retainTokens: number } {
  const windowRatio = opts.windowRatio ?? DEFAULT_WINDOW_RATIO
  const retainRatio = opts.retainRatio ?? DEFAULT_RETAIN_RATIO
  if (opts.explicitWindow !== undefined && opts.explicitRetain !== undefined) {
    return { windowTokens: opts.explicitWindow, retainTokens: opts.explicitRetain }
  }
  if (contextWindow === undefined || contextWindow <= 0) {
    return { windowTokens: opts.fallbackWindow ?? DEFAULT_WINDOW_TOKENS, retainTokens: opts.fallbackRetain ?? DEFAULT_RETAIN_TOKENS }
  }
  const windowTokens = opts.explicitWindow ?? Math.floor(contextWindow * windowRatio)
  const retainTokens = opts.explicitRetain ?? Math.floor(windowTokens * retainRatio)
  return { windowTokens, retainTokens }
}

/**
 * A8（问题 10 修订）：ask 检测中英双语纯函数。
 * 英文：'?' / ask / what；中文：？/ 吗 / 呢 / 什么 / 怎么 / 如何 / 能否 / 能不能。
 * /帮我/ 由子串收窄为句首（^请|^帮我|^能不能|^能否），避免 "顺便帮我带个话" 之类
 * 非问句/非请求主语误命中；疑问词 什么/怎么/如何 仍保留子串（问句核心成分，方向保守=少剪）。
 * 导出供测试直接锁定收窄行为。
 */
export function looksAskText(text: string): boolean {
  const t = text.trim()
  return t.endsWith('?') || /\bask\b/i.test(t) || /\bwhat\b/i.test(t)
    || t.endsWith('？') || /吗[？?。]?$/.test(t) || /呢[？?。]?$/.test(t)
    || /什么|怎么|如何|能否|能不能/.test(t)
    || /^(请|帮我|能不能|能否)/.test(t)
}

/**
 * user/message 原子分类（P0 分类陷阱防线，plan「分类陷阱」节）。
 *
 * 顺序不可交换：先识别 `data[argp].info === true`（U-info 聚合副本——由 peratom 管线
 * 插件 append，但必须按 U 待遇参与剪枝候选），再落 `source.kind === 'plugin'` → X
 * （墓碑/checkpoint）判定。若先判 plugin-source，U-info 会被分类成 X 而**全局不可剪**，
 * P4 的候选放行将永远失效。
 *
 * 此前该规则内联在四处（catalogText / recallQuery / atomize / rebuildLedgerFromLog），
 * 现统一收敛到本纯函数；导出供测试直接锁定顺序行为（A8 先例）。
 */
export function classifyUserMessage(data: unknown): 'U' | 'X' {
  if (isArgpUserInfo(data)) return 'U'
  return (data as { source?: { kind?: string } } | undefined)?.source?.kind === 'plugin' ? 'X' : 'U'
}

/**
 * tombstone 可合并判据（v1.2.x §11.8① 修复）。X 原子中仅「本引擎剪枝墓碑」可安全合并：
 * 文本以 `[elided` 开头、含 pruned by ARGP 与 recall_pruned 取回提示（覆盖默认区间
 * 墓碑与 closure 墓碑两种形态；tool 占位墓碑 `[elided: ...` 缺 pruned by ARGP → 不合并，
 * 且 consolidateTombstoneRuns 只认 user/message 事件，双保险防孤儿 tool_calls）。
 * 其余 X（宿主 system-reminder、官方摘要 checkpoint、注入型 checkpoint）不可动。
 * 导出供测试锁定行为。
 */
export function isMergeableTombstone(text: string): boolean {
  const t = text.trimStart()
  return t.startsWith('[elided') && t.includes('pruned by ARGP') && t.includes('recall_pruned')
}

export interface ArgpGraphConfig {
  /** 触发线（token）。不传时默认 = 适配器声明的 contextWindow × windowRatio（默认 0.8）。 */
  windowTokens?: number
  /** 保留目标（token）。不传时默认 = 触发线 × retainRatio（默认 0.2，压缩率 1/5）。 */
  retainTokens?: number
  /** 触发线占上下文比例（默认 0.8；仅当 windowTokens 未显式指定时生效）。 */
  windowRatio?: number
  /** 保留目标占触发线比例（默认 0.2；仅当 retainTokens 未显式指定时生效）。 */
  retainRatio?: number
  recencyGuard?: number   // 默认 4（surface 末尾 N 节点不参剪）
  turnGuard?: number      // 默认 1（最近 N 个 turn 的原子不参剪；独立于 recencyGuard）
  /**
   * 轮中（step > 1）压力剪开关（三级触发 v1.5.0）。默认 **true**。
   *
   * 动机（2026-09-21 真会话存档实证）：上下文超限的两个主要形态是「拿到 tool result 之后
   * 才超」与「输出被钳制」——前者发生在**轮中**，而只在轮初判定的 L1 看不到它。轮中不剪
   * ⇒ 只能等 provider 400（浪费一次请求）或等输出被钳（本 turn 直接被 max-tokens 终结）。
   * 轮中剪的落地位置是那个 pre-step，剪完**同一个 step 的请求**即已瘦身 ⇒ 天然自动继续。
   *
   * ⚠️ 与 1.3.x 的关键差别：轮中剪**放宽 `turnGuard`**（见 `midTurnTurnGuard`）。超额的来源
   * 就是**本轮**的 tool result，而 turnGuard=1 恰把整轮保护起来——这正是 1.3.x 轮中剪"只剪
   * 掉 1 原子/154 tok、却每次都断一次前缀缓存"的根因。轮中剪**不跑 per-atom LLM pass**
   * （那是 79s–3min 的阻塞，轮中不划算；0-LLM 图剪放宽守卫即可剪掉本轮旧 tool result）。
   *
   * 兼容别名（1.4.0 起）：`midTurnActive: true` = 轮中剪**开**且用默认守卫（1.3.x 语义，
   * 对照组）；`midTurnActive: false` = 轮中剪**关**（1.4.0 语义）。两者都不写 = 新默认。
   */
  midTurnPrune?: boolean
  /** 轮中剪时 `turnGuard` 降到该值（默认 0 = 允许剪本轮的旧 A/R；`recencyGuard` 照常保护最新节点）。 */
  midTurnTurnGuard?: number
  /** 1.4.0 的旧键：见 `midTurnPrune` 的兼容别名说明。 */
  midTurnActive?: boolean
  /**
   * 输出被钳制后自动续写的提示词（三级触发 v1.5.0）。默认内置中文一句（点明"输出被宿主的
   * 输出预算截断 + 上下文已压缩 + 接着上次未完成处写、勿重述"）。设为空串则只剪枝不续写。
   */
  continuationNotice?: string
  /**
   * 反应式补救的最大次数（**每次"连续被钳"episode** 内，默认 2；出现一次正常输出即清零）。
   * 输出被外部钳制后（`finish=max-tokens` 且 `usage.outputTokens < 本次请求的 maxTokens`，
   * = provider/适配器把输出预算啃小了，容量压力的真信号）：
   *   ① 若本 turn 随后要结束（`agent/turn-stopping`）⇒ 就地强制剪 + `steer` 一条续写消息，
   *      把**当前轮**续下去（1.5.0 核心：被钳不再等于任务中断）；
   *   ② 否则（turn 还在跑）⇒ 下一个 pre-step 强制剪。
   * 第 2 次起放宽 `recencyGuard`/`turnGuard`（连最新节点一起剪）。用尽后不再重试，交给
   * overflow 路径（provider 400）兜底——避免"每步都被钳 → 每步白压"的死循环。
   */
  reactiveRetries?: number
  minSpanChars?: number   // 默认 0（微剪枝下限；>0 会放回小区间，易导致连续压缩）
  charsPerToken?: number  // 默认 3.5（触发与目标同基准；tokenMeter 可用时不再使用）
  /** 单次剪枝事务的最大贪心 pass 数（默认 16；生产档大批量剪枝应调高）。 */
  maxPasses?: number
  /** 触发保留余量（token）；默认 0。windowTokens 会先减去该值作为触发线。 */
  reserveTokens?: number
  /** 诊断/遥测数组容量上限（保留最近 N 条，默认 256；P4.5 有界化）。 */
  telemetryCap?: number
  /** 可选显式 token 测量函数；不传则退化为字符估算。 */
  measureTokens?: (session: Session) => { contextTokens: number; surfaceTokens: number }
  /** 是否启用 summarize 降级。默认 false：本地单 slot 模型下 summarize 会破坏 KV cache，ARGP 走 force_prune。 */
  enableSummarize?: boolean
  /** 降级链：lifecycle（默认，闭包→force） / summarize / force / fail。 */
  degradationStrategy?: 'lifecycle' | 'summarize' | 'force' | 'fail'
  /** 排序模式（spike 18 提案，2026-08-23 起默认 density）：
   *  density（默认）：eff 同档内 token 降序（大 token 先剪，单位 token 重要性；spike 19 实证同达成度 recall 2→0）
   *  legacy： [lvl, eff, lastRef, seq]（绝对 eff，忽略体积；显式传入以回退旧行为）
   *  density-chain：density + 版本链存活代表 eff 叠加 (count-1)*1 */
  sortMode?: 'legacy' | 'density' | 'density-chain'
  /**
   * latestTurn 口径（P4 修复）：
   *  semantic（默认）：只算真实 U/A/R 活动的 turn；注入型 X 节点（system-reminder、
   *    ARGP 自己的 tombstone）不推进轮次计数，避免"注入撑大 latestTurn → 闭包保护
   *    窗口 latestTurn-k 被抬高 → 本应受保护的旧闭包被提前剪"。
   *  all：旧口径，把 X 一并算进 latestTurn（既往实验数据基线；对照实验需显式指定）。
   * 注意：本项影响 turnGuard 与闭包保护窗口的判定，口径变更需在实验台账标注。
   */
  turnBasis?: 'semantic' | 'all'
  /**
   * 上下文溢出恢复的最大重试次数（context-overflow trigger）。缺省口径（2026-08-29
   * review 修复）：未挂 peratom compressor 时默认 1（对齐官方 compaction-basic）；
   * 挂载时自动提到 3——否则三步序列的第②步（事件#2）在重试上限守卫处被跳过，
   * 溢出三步退化为"① + 保留错误"。显式配置始终优先。每次「模型请求 400
   * exceed_context_size → 恢复步 → retry」消耗 1 次；超限后保留原始请求错误。
   */
  maxOverflowRetries?: number
  /** 闭包静止窗 K（默认 2）：lastRef 须 ≤ latestTurn−K 且未被 recall 防抖才可整闭包剪除。 */
  closureWindowK?: number
  /** cites 前缀最小长度守卫（A2，默认 2）：前缀字符数低于该值直接判失败，避免"的/a"等噪音伪引用。 */
  citeMinPrefixLen?: number
  /** 版本链重叠归链阈值 θ（A4，默认 0.8，仅对 R 生效）：sim=|A∩B|/min(|A|,|B|) ≥ θ 视为同一版本链。 */
  overlapTheta?: number
  /** 版本链重叠归链启用（A4，默认 false；启用后 A 文本仍走全等去重）。 */
  enableOverlapChain?: boolean
  /**
   * 边价值实验 A₃：注入 oracle 边（离线辅助 LLM 组图，schema 强制）。
   * buildGraph 在 cites 边之后合并这些边，用于测"理论上限"保留集（A₃−A₂ = 模型服从率吃掉的价值）。
   */
  injectEdges?: (atoms: Atom[]) => SemanticEdge[]
  /**
   * 边价值实验 A₁ 离线重放：跳过 cites 边构建（仅保留确定性 A→R 边），
   * 隔离"无边"保留集，与 A₂（带 cites 边）比 shadowedSeqs 差异（P1 结构层）。
   * 注意（v1.2.0）：A₁"无边"臂同时**自动隔离推断边**——disableCiteEdges=true 时
   * 推断边一并关闭，保证该臂零语义边的实验语义不被 0-LLM 派生边污染。
   */
  disableCiteEdges?: boolean
  /**
   * 推断边开关（PROPOSAL-token-ontology 组件 A，v1.2.0；默认 true = 启用）。
   * 承重 token 逐字包含派生语义边（0 LLM、建图期）：模型声明通道空窗时恢复选择性，
   * 保护集只增不减（I-A4）。false = 退回 v1.1 行为（语义边仅 cites / inject 两源）。
   * 独立于 disableCiteEdges（A₁ 臂经后者一并关闭，见上）。
   */
  disableInferredEdges?: boolean
  /** 推断边种子 token 最小长度（默认 6；守卫词表 ≥4 为保真口径，边派生需更强区分度）。 */
  inferredMinTokenLen?: number
  /** 推断边停词阈值（默认 0.15）：出现在 >15% 原子中的 token 不派生边。 */
  inferredStopwordRatio?: number
  /** 每 A 原子推断边上限（默认 8）。 */
  inferredMaxEdgesPerAtom?: number
  /** 推断边声明窗口轮数（默认 20）：仅近 N 轮的 A 原子作边源。 */
  inferredWindowTurns?: number
  /**
   * tombstone 归并阈值（v1.2.x §11.8① 修复，默认 8；0 = 关闭）。
   * X 原子（剪枝墓碑）在 isAtomCandidate 结构性不可剪 → 墓碑地板单调累积，
   * 实测两臂复现同形态 CONTEXT_WINDOW_EXCEEDED（141,313+32,768>174,080；
   * run2 T16 dump：1297/1310 surface 节点是墓碑，284,786 chars ≈ 142K tok）。
   * ≥N 的连续可合并墓碑段会被归并为单条聚合墓碑（原文仍在 append-only 日志，
   * recall_pruned(seq) 可取回）。每 pass 至多归并一段——若整段一次事务 replace
   * 失败，回退范围清晰可查（宁少并不错删）。
   */
  tombstoneMergeMinRun?: number
  /**
   * P0 双引擎生产挂载（2026-08-28，webui-liaison 台账发现一，已迁出公开仓库）：非空时
   * 引擎构造期自挂 peratom 三管线（Stage-1 eager 熵降 + 边声明 + 两级召回），
   * injectEdges/onOverflowCompress 由内部接线——显式传入的同名 config 键被忽略并告警。
   * 管线组件的 llm 后端：component config 传 `llm: { provider, model }` 走宿主 dsh-llm
   * （生产形态，purpose='compaction'）；不传按各组件 fetch 环境变量口径解析（本地实验
   * 形态，环境缺失时组件自然 disabled，零网络）。`false` = 关闭该管线。
   * 与 mountPeratomStack（测试/三臂工厂）同拓扑；本块存在的意义是真宿主 bundle patch
   * 只能声明式挂一个插件入口（发现一：default export 只有 graph 引擎 = 双引擎无生产路径）。
   */
  peratom?: {
    compressor?: PeratomCompressorConfig | false
    declarer?: CiteDeclarerConfig | false
    zoom?: RecallZoomConfig | false
  }
  /**
   * Preset 净化器（2026-09-04 Q8 收口）。rc.2 起 agent 组成迁入 preset 平面，
   * standard/cordis/ptc 的 compaction 组各挂一份 compaction-basic——宿主 profile 的
   * `disabled: true` 管不到 preset 子树，官方摘要器与 ARGP 双引擎并存（外来 lossy
   * 摘要先于图剪 + 英文 checkpoint 拉偏会话语言）。启用后引擎挂载期对 roster 中每个
   * 含 stock compaction 的 shipped preset 经官方 authoring API 生成净化副本
   * `<id>-argp`（摘除 compaction-basic/tool-result-pruner，保留 command-compact——
   * 其 `compaction` inject 沿 realm 链向上解析到本引擎的 `ctx.compaction`，
   * `/compact` 自动指向 ARGP 图剪）。幂等、fail-soft、只写 `~/.dsh/.agent-presets/`。
   * `false` 关闭；对象可调 strip 集合/后缀/源白名单（见 PresetCleanOptions）。
   * 依赖 roster 服务：无 agentPresets 的部署（headless 等）静默跳过。
   */
  presetClean?: false | PresetCleanOptions
  /**
   * 回复级 cites 义务开关（argp-cites system section，order 151）。
   * 缺省 auto：declarer 管线挂载且已武装（解析到 LLM 后端）时关闭，否则开启——
   * 边声明由 declarer 结构化旁路承担，主回复不再携带 {"cites":...} 尾（源头消灭
   * UI 显示泄漏，见 webui-liaison 台账发现三证据链，已迁出公开仓库）。
   * 2026-09-21 时序修复：auto 兜底（autoLlm）的 declarer 构造期未武装、会话中期
   * 才经 agent/status 武装——auto 口径下 section 恒注册，text 回调在 armed 翻转后
   * 动态返回 ''（renderPrompt 过滤空 section ⇒ system 块不再含协议）；armed 单调
   * 递增 ⇒ 至多翻转一次。显式 true/false 覆盖 auto（静态语义不变）：边价值实验
   * A₁-A₃ 臂依赖回复级 cites 时强制开；双保险关闭时强制关。declarer 挂载但始终
   * 未武装（无 LLM 后端）时 auto 保持全文（两种边来源不能同时归零）。buildGraph
   * 的 cites 解析不受影响——协议关闭后模型偶发残留的 cites 尾仍被剥离并作为加菜
   * 边消费，引擎侧 flush 剥离恒开。
   */
  citesObligation?: boolean
  /**
   * P4 溢出三步序列第 ② 步：第一次溢出 forcePrune 后若仍超窗，
   * 回调对当前 open turn 做 per-atom 降熵（PeratomCompressor.compressOpenTurn：
   * U 拆分 / 大 R extract + 顺带补 cites），产生 surface 换代后由第 ③ 步
   * 再次 forcePrune 收尾。未注入（undefined）时退化为现役两步
   * （forcePrune → 保留原错误），行为与 0.3.x 完全一致。
   * 回调自身失败被吞掉（失败隔离：不影响后续 forcePrune 与原错误保留）。
   */
  onOverflowCompress?: (session: Session) => Promise<void>
  /**
   * P6 轮内压力压缩（2026-09-19 方案 B 主路径）：pre-step 压力达标（与
   * compactIfNeeded('pressure') 同口径）时，**先**对当前 open turn 做 per-atom
   * 压缩（compressOpenTurn），**再**图剪（compactIfNeeded），两者在同一 pre-step
   * 窗口落地 = 单变异窗口（"拼回"效果：step k+1 看到剪枝后 turns 1..N-1 +
   * 原子压缩过的进行到一半的 turn N）。仅 open turn 触发（闭合轮走 idle 边界
   * 路径）；活跃态守卫内建——pre-step 在轮内只在 tool result 之后触发，纯文本
   * 收手的 turn 不会再 fire。回调自身失败被吞掉（失败隔离：不影响后续图剪）。
   * 未注入（undefined）时行为与 P6 前完全一致（仅溢出才压 open turn）。
   */
  onPrePressureCompress?: (session: Session) => Promise<void>
}

export interface GraphPruneRecord {
  at: string
  compactionId: string
  /** /compact 发起命令 ID（presentation correlation；自动压缩时为 undefined）。 */
  sourceCommandId?: string
  intervals: { start: number; end: number; tombstoneSeq: number }[]
  startEventSeq: number
  summaryEventSeq: number
  endEventSeq: number
  shadowedSeqs: number[]
  prunedAtoms: { id: number; type: AtomType; seq: number }[]
  semanticEdges: number
  candidates: number
  charsBefore: number
  charsAfter: number
  forced: boolean
}

/**
 * 流式中 assistant 消息落盘后，立即剥离尾部 {"cites":[...]}（ARGP 引用协议产物），
 * 使其不残留在**模型可见 surface** 上——下一轮请求不再把协议产物当正文重读。
 * 注意（2026-08 修正认知）：Web UI 的人类转录按 dsh 核心设计固定取 append 起源
 * 事件，replace 副本是 model-only（core session surface.ts："replacement copies
 * stay model-only"），因此本剥离**不影响 UI 显示**。UI 侧残留的治理在源头：
 * cites 契约 V5 规定空引用时不产出任何 block（空块对引用图零信息）；非空 block
 * 在 UI 中作为原始回复的一部分可见（模型侧仍被剥离）。仅改写最后一个 text 块；
 * 保留 model/provider/replay 等元数据；将 cites 存入 data.argpCites，以便后续
 * compaction 经 atomize 重建引用图（文本被剥离后 extractCites 取不到 cites）。
 * 幂等：已剥离节点（含 argpCites）再次进入时直接跳过，无重入循环。
 */
export function stripTrailingCitesIfNeeded(session: Session, event: { seq: number; data?: Record<string, unknown> }): void {
  const data = event.data
  if (data === undefined) return
  if (Array.isArray(data.argpCites)) return // 已剥离，跳过
  const msg = data.message as { content?: unknown[] } | undefined
  const content = msg?.content
  if (!Array.isArray(content) || content.length === 0) return
  let lastIdx = -1
  for (let i = content.length - 1; i >= 0; i -= 1) {
    const b = content[i] as { type?: string; text?: string }
    if (b?.type === 'text') { lastIdx = i; break }
  }
  if (lastIdx === -1) return
  const block = content[lastIdx] as { type: string; text?: string }
  if (typeof block.text !== 'string') return
  const { body, cites } = extractCites(block.text)
  if (body === block.text) return // 无 cites 块，无需改写
  const newContent = content.slice()
  newContent[lastIdx] = { ...block, text: body }
  session.append('assistant/message', {
    ...data,
    message: { ...(msg as object), content: newContent },
    argpCites: cites,
  } as never, {
    surfaceOp: { op: 'replace', startSeq: asSeq(event.seq), endSeq: asSeq(event.seq) },
    // 不给 sourceEventSeqs：dsh 0.1.5 起 assistant/message 自带 provider stream，
    // 类型层为 `sourceEventSeqs?: never`、运行时 assertProvenance 亦直接 throw
    // （"assistant/message embeds its source stream and cannot carry sourceEventSeqs"）。
    // 安全性：shadowedSeqsOf 已改为只认 compaction/prune.shadowedSeqs 权威账本，
    // 不再从 replace 事件推断被遮节点，故本处省略不影响剪枝账目。
  })
}

/**
 * 提取 A 文本尾部的 cites JSON（支持裸 JSON 与 ```json 围栏）；返回剥离后正文与引用列表。
 * V6 分级契约：条目可为字符串（视为 supporting）或 {t, l} 对象（l ∈ c|s|x）。
 * 形状不合法（如混入数字/对象缺 t）→ parseFailed 保守保护。
 */
export function extractCites(text: string): { body: string; cites: ParsedCite[]; attempted: boolean; parseFailed: boolean } {
  const matched = matchCitesTail(text)
  const attempted = text.includes('"cites"')
  if (matched === null) {
    return { body: text, cites: [], attempted, parseFailed: attempted }
  }
  const cites = parseCitesBlock(matched.raw)
  if (cites === null) {
    return { body: text, cites: [], attempted: true, parseFailed: true } // JSON 合法但形状不对 → 解析失败，保守保护
  }
  return { body: text.slice(0, text.length - matched.span).trimEnd(), cites, attempted: true, parseFailed: false }
}
/** cites 服从率度量台账（C7-cites 判决用）。 */
export interface CiteStats { aAtoms: number; declared: number; resolved: number; ambiguous: number; failed: number }
/** 推断边统计（v1.2.0；最近一次 buildGraph 口径，每次建图重置；skippedDup = 与既有声明边同 (from,to) 被去重）。 */
export interface InferredStats { candidates: number; accepted: number; skippedDup: number }

/**
 * P5 结构重构 Wave 3 第 2 步（C 报告 S2）：compactIfNeeded 拆分出的模块级纯函数。
 *
 * 背景：compactIfNeeded 原约 365 行单函数，内含 3 个闭包（isAtomCandidate /
 * isGroupCandidate / sortKey，闭包捕获 this 与局部 state）+ ~100 行贪心 for-pass
 * 循环 + ~80 行区间归并/tombstone 生成，单函数不可测不可读。现将「无 this 副作用」
 * 的判定/排序/归并/墓碑段提升为模块级纯函数：原来闭包捕获的 this 字段与局部量
 * 打包成显式 state 参数（PruneState）传入，函数体逻辑逐字保留（this.x → state.x）。
 * 贪心 for-pass 循环与 this 交互过深（selectClosureToMerge 会 this.nextClosureId++、
 * 写 this.closurePrunes、调 this.summarizeCriticalChain、读 this.degradationStrategy/
 * maxPasses/enableSummarize、process.env 调试副作用），抽出会改变控制流/副作用顺序，
 * 故保留在方法内（见 compactIfNeeded）。
 *
 * 导出（export function）供未来独立单测；**不**加进 src/index.ts 公共 API。
 */

/** 剪枝区间（区间归并产物）。hasSoloR = 区间含「issuer A 未被剪」的独立 R（tool 占位墓碑配对约束）。 */
export interface PruneInterval {
  seqs: number[]
  chars: number
  atoms: Atom[]
  hasSoloR: boolean
}

/** 区间 tombstone 规格：user 文本墓碑 或 tool 占位墓碑（保留 callId 配对 issuer A 的 tool_calls）。 */
export type PruneTombstone = { type: 'user'; text: string } | { type: 'tool'; seq: number; callId: string }

/**
 * compactIfNeeded 拆出纯函数共享的显式 state：原 3 个闭包捕获的 this 字段与局部量。
 * - turnGuard / sortMode / charsPerToken：原闭包读 this.<getter>；此处快照为值（方法执行期间
 *   guardOverride/argpSettings 稳定，快照等价）。
 * - curInDegree / curInDegreeDecl：每 pass 重推（链式解锁），方法内每 pass 更新本字段，
 *   纯函数按调用时读取当前 pass 值（与原闭包捕获 let 绑定的语义一致）。
 * - chainLen：findVersionDuplicates 产物；仅 sortKey 使用，且 sortKey 只在 pass 循环内调用
 *   （届时已回填），构造期占位空 Map 不会被读到。
 */
export interface PruneState {
  turnGuard: number
  askCoverage: Map<number, number>
  position: Map<number, number>
  recencyCut: number
  latestTurn: number
  edges: SemanticEdge[]
  atoms: Atom[]
  curInDegree: Map<number, number>
  curInDegreeDecl: Map<number, number>
  deterministicEdges: DeterministicEdge[]
  touchesSemantic: Set<number>
  eff: Map<number, number>
  sortMode: 'legacy' | 'density' | 'density-chain'
  chainLen: Map<number, number>
  lastRef: Map<number, number>
  charsPerToken: number
}

/**
 * 单原子剪枝候选判定（原 compactIfNeeded 内 isAtomCandidate 闭包，逐字保留 this.x→state.x）。
 * ask-exempt U（dialog）须被首个 A 的 supporting 边覆盖才参剪；A/R/U-info 走
 * recencyGuard/turnGuard/citesFailed/A10 结构保护/入度门槛。
 */
export function isAtomCandidate(a: Atom, allowInDegree: boolean, state: PruneState): boolean {
  if (a.type === 'U' && a.sourceSeq === undefined) {
    // 普通 U（含 task-init dialog）：ask-exempt 路径——须被首个 A 的 supporting
    // 边覆盖才参剪。dialog 永不剪不变（无覆盖 → 不可剪）。
    const coverer = state.askCoverage.get(a.id)
    if (coverer === undefined) return false
    const pos = state.position.get(a.seq)
    if (pos === undefined || pos >= state.recencyCut) return false
    if (a.turn > state.latestTurn - state.turnGuard) return false
    // 动态复核：所有保留入边都必须来自覆盖者，否则豁免失效
    const incoming = state.edges.filter(e => e.to === a.id)
    if (incoming.length === 0 || incoming.some(e => e.from !== coverer)) return false
    return true
  }
  // P4：U-info（a.sourceSeq 有值）按 R 待遇参剪——跳过 ask-exempt（其不是 ask
  // 文本、永远拿不到覆盖），走下方与 A/R 相同的 recencyGuard/turnGuard/
  // citesFailed/入度门槛。dialog 不受影响（仍走上方 ask-exempt 分支）。
  if (a.type !== 'A' && a.type !== 'R' && a.type !== 'U') return false
  const pos = state.position.get(a.seq)
  if (pos === undefined || pos >= state.recencyCut) return false
  if (a.turn > state.latestTurn - state.turnGuard) return false
  if (a.citesFailed) return false
  // A10（必补，收窄版）：A 带 R 组但漏 cites 时，该 A 对 R 无语义边 → 闭包守卫（inDegreeByClosure）
  // 防不住整闭包被剪。但**仅当组内 R 均无来自组外的其他入边**才结构性保护（设计 §4 收窄版 + 问题 1 修订）：
  //  - A 漏 cites 且 R 无任何外部入边（组内只有 issuer 的确定性配对边）→ 整组失去外部保护，
  //    A 不可剪（防整闭包被剪；单轮 1U+1A+1R 探针场景即此形态，**应保护**——评审探针的
  //    “工具 A 永久不可剪”是旧版无脑全保护的结论，收窄后仅漏 cites 且无外部引用的组受保护）
  //  - R 被组外原子 cites 或引用（语义入度 >0，或来自其他 A 的确定性边）→ R 已被外部保护，A 照常可剪
  //  - A 有 cites 指向组内 R → 有边，不触发保护
  // 判定依据：语义边（edges）+ 确定性边（deterministicEdges）均只数「组外来源」——
  // 组内 issuer 自己的配对边不算“其他入边”，否则“有 R 就保护”退化为无脑全保护（问题 1）。
  // force_prune（allowInDegree=true）路径同样走此判定——结构性保护优先于强制降级。
  if (a.type === 'A' && a.toolCallIds.length > 0) {
    const groupIds = new Set<number>([a.id])
    const groupRs = state.atoms.filter(x => x.type === 'R' && a.toolCallIds.includes(x.toolCallIds[0] ?? ''))
    for (const r of groupRs) groupIds.add(r.id)
    if (groupRs.length > 0) {
      const aCitesR = state.edges.some(e => e.from === a.id && groupRs.some(r => e.to === r.id))
      // R 的外部入边：语义边来自组外原子，或确定性边来自组外原子（其他 A 调用了同一 callId 链）
      const anyRExternalIncoming = groupRs.some(r =>
        (state.curInDegreeDecl.get(r.id) ?? 0) > 0 || // 语义**声明**入度（cites/inject）——排除 inferred（见上方实验注释）
        state.deterministicEdges.some(e => e.to === r.id && !groupIds.has(e.from))) // 确定性：组外 A→R
      if (!aCitesR && !anyRExternalIncoming) return false
    }
  }
  if (!allowInDegree && (state.curInDegree.get(a.id) ?? 0) > 0) return false
  return true
}

/** 组候选判定（原 isGroupCandidate 闭包）：组内全部原子均候选。 */
export function isGroupCandidate(g: Atom[], allowInDegree: boolean, state: PruneState): boolean {
  return g.every(a => isAtomCandidate(a, allowInDegree, state))
}

/**
 * 排序键（原 sortKey 闭包，§4.5 + spike 18 提案）：默认 legacy = [lvl, eff, lastRef, seq]；
 * density = eff 同档内 token 降序（大 token 先剪）；density-chain = density + 链代表 eff 叠加。
 */
export function sortKey(a: Atom, state: PruneState): string {
  const lvl = state.touchesSemantic.has(a.id) ? LEVEL_ORDER.supporting : LEVEL_ORDER.isolated
  const effV = state.eff.get(a.id) ?? 0
  if (state.sortMode === 'legacy') {
    return [lvl, effV, state.lastRef.get(a.id) ?? 0, a.seq].map(n => String(n).padStart(10, '0')).join('|')
  }
  const chainBonus = state.sortMode === 'density-chain' ? (state.chainLen.get(a.id) ?? 1) - 1 : 0
  // density/density-chain：token 降序（负数入键，大 token 数值小排前）
  const tokNeg = -Math.ceil(a.text.length / state.charsPerToken)
  return [lvl, effV + chainBonus, tokNeg, state.lastRef.get(a.id) ?? 0, a.seq].map(n => String(n).padStart(10, '0')).join('|')
}

/**
 * 区间归并（原 compactIfNeeded 内区间归并段，逐字保留）。
 * 按极大连续区间归并 pruned 原子；R 原子（issuer A 未被剪）强制单独成区间（tool 占位墓碑
 * 的 surface replace 必须恰好替换 1 节点）；双向守卫防孤儿 tool 消息；
 * 区间可见量 < minSpanChars 的放回（不剪）。
 * 入参 = pruned 原子集合 + position/issuerByCall 局部量 + minSpanChars（原 this.minSpanChars）；
 * 出参 = 归并后区间 kept + droppedIntervals（放回区间数，原方法内计算但未被读取，保留以逐字对应）。
 */
export function mergeIntervals(
  pruned: Map<number, Atom>,
  position: Map<number, number>,
  issuerByCall: Map<string, Atom>,
  minSpanChars: number,
): { kept: PruneInterval[]; droppedIntervals: number } {
  const prunedSeqs = [...pruned.values()].map(a => a.seq).sort((x, y) => x - y)
  const intervals: PruneInterval[] = []
  for (const seq of prunedSeqs) {
    const a = [...pruned.values()].find(x => x.seq === seq)
    if (a === undefined) continue
    const isSoloR = a.type === 'R' && a.toolCallIds[0] !== undefined
      && (() => {
        const issuer = issuerByCall.get(a.toolCallIds[0] as string)
        return issuer !== undefined && !pruned.has(issuer.id)
      })()
    const lastInterval = intervals[intervals.length - 1]
    const prevPos = lastInterval !== undefined ? position.get(lastInterval.seqs[lastInterval.seqs.length - 1] as number) : undefined
    const curPos = position.get(seq)
    if (!isSoloR && lastInterval !== undefined && lastInterval.hasSoloR === false
      && prevPos !== undefined && curPos !== undefined && curPos === prevPos + 1) {
      lastInterval.seqs.push(seq)
      lastInterval.chars += a.text.length
      lastInterval.atoms.push(a)
    } else {
      intervals.push({ seqs: [seq], chars: a.text.length, atoms: [a], hasSoloR: isSoloR })
    }
  }
  const keptRaw = intervals.filter(iv => iv.chars >= minSpanChars)
  // 2026-08-23 兜底防线：双向守卫后结构上不应再出现「混剪区间含 issuer 存活的 R」，
  // 但降级路径不能假设不变式处处成立——最后校验一遍，违例则把该 R 原子拆出成独立区间；
  // 拆后原区间低于微剪枝下限则整段放回（宁可不剪，不破配对）。
  const kept: typeof keptRaw = []
  const rescued: typeof keptRaw = []
  for (const iv of keptRaw) {
    if (iv.seqs.length <= 1) { kept.push(iv); continue }
    const rest = { seqs: [] as number[], chars: 0, atoms: [] as Atom[], hasSoloR: false }
    for (const a of iv.atoms) {
      const soloHere = a.type === 'R' && a.toolCallIds[0] !== undefined
        && (() => {
          const issuer = issuerByCall.get(a.toolCallIds[0] as string)
          return issuer !== undefined && !pruned.has(issuer.id)
        })()
      if (soloHere) rescued.push({ seqs: [a.seq], chars: a.text.length, atoms: [a], hasSoloR: true })
      else { rest.seqs.push(a.seq); rest.chars += a.text.length; rest.atoms.push(a) }
    }
    if (rest.chars >= minSpanChars) kept.push(rest)
  }
  kept.push(...rescued)
  kept.sort((x, y) => (x.seqs[0] as number) - (y.seqs[0] as number))
  const droppedIntervals = intervals.length - kept.length
  return { kept, droppedIntervals }
}

/**
 * 区间 tombstone 生成（原 compactIfNeeded 内 tombstone 段，逐字保留）。
 * 区间原子全部来自同一闭包 → 闭包 tombstone（带 root/计数，recall 消歧）；
 * 单 R 区间（issuer A 未被剪）→ tool 占位墓碑（保留 callId 配对 A 的 tool_calls）；
 * 否则默认 user 文本墓碑（forced 时标注）。
 */
export function buildTombstones(
  kept: PruneInterval[],
  closureSeqMeta: Map<number, { closureId: string; rootPreview: string; closureTotal: number }>,
  issuerByCall: Map<string, Atom>,
  pruned: Map<number, Atom>,
  forced: boolean,
): PruneTombstone[] {
  return kept.map(iv => {
    const metas = iv.atoms
      .map(a => closureSeqMeta.get(a.seq))
      .filter((m): m is { closureId: string; rootPreview: string; closureTotal: number } => m !== undefined)
    const first = metas[0]
    if (first !== undefined && metas.every(m => m.closureId === first.closureId)) {
      return { type: 'user' as const, text: '[elided closure ' + first.closureId
        + ' seqs=' + iv.seqs[0] + '..' + iv.seqs[iv.seqs.length - 1]
        + ': ' + iv.seqs.length + ' of ' + first.closureTotal + ' surface nodes in this closure'
        + ' pruned by ARGP closure lifecycle; root=' + first.rootPreview
        + '; recall_pruned(seq) retrieves original]' }
    }
    const r0 = iv.atoms[0]
    if (iv.atoms.length === 1 && r0.type === 'R' && r0.toolCallIds[0] !== undefined) {
      const issuer = issuerByCall.get(r0.toolCallIds[0])
      if (issuer !== undefined && !pruned.has(issuer.id)) {
        return { type: 'tool', seq: r0.seq, callId: r0.toolCallIds[0] }
      }
    }
    return { type: 'user' as const, text: '[elided seq=' + iv.seqs[0] + '..' + iv.seqs[iv.seqs.length - 1]
      + ': ' + iv.seqs.length + ' surface nodes pruned by ARGP (graph order, cites-aware'
      + (forced ? ', forced' : '') + '); recall_pruned(seq) retrieves original]' }
  })
}

/** list_pruned 工具的剪枝节点目录条目。 */
export interface PrunedNodeInfo {
  seq: number
  type: AtomType
  turn: number
  firstLine: string
  citedBySeq: number[]
  /** 被剪瞬间的有效重要性（recall 价值继承的来源，§3-3）。 */
  eff: number
  /** 版本链重定向（2026-08-23）：被剪旧快照 recall 时，指向同一路径（tool name+arguments）下最新存活版本的 seq。
   *  未参与版本链去重的被剪节点无此字段（undefined）。 */
  latestOfPath?: number
}

export class ArgpGraphEngine extends CompactionEngine {
  static inject = ['tools', 'systemPrompt']

  readonly windowTokens: number
  readonly retainTokens: number
  /** true = config 显式给 windowTokens；false = 运行时按 contextWindow × windowRatio 解析。 */
  private readonly explicitWindowTokens: boolean
  /** true = config 显式给 retainTokens；false = 运行时按 windowTokens × retainRatio 解析。 */
  private readonly explicitRetainTokens: boolean
  /** 最近一次 resolveScaledBudgets 解析出的有效预算（recall 预算等后续同步使用点读取）。 */
  private resolvedWindowTokens = DEFAULT_WINDOW_TOKENS
  readonly reserveTokens: number
  readonly tokenMeterFn?: (session: Session) => { contextTokens: number; surfaceTokens: number }
  readonly degradationStrategy: 'lifecycle' | 'summarize' | 'force' | 'fail'
  readonly turnBasis: 'semantic' | 'all'
  /**
   * UI 设置页可调旋钮的实时解析值（Settings → Plugins → Configurable → ARGP）。
   * 构造期为 cordis 配置基线；ctx.inject(['settings']) 注册后随用户写入实时更新。
   */
  private argpSettings: ArgpUserSettings
  /** settings 源 thunk：ctx.inject(['settings']) 注册后置为 scope.get()，否则回退 cordis 基线。 */
  private settingsSource: () => ArgpUserSettings = () => this.argpSettings
  get windowRatio(): number { return this.argpSettings.windowRatio }
  get retainRatio(): number { return this.argpSettings.retainRatio }
  /**
   * 守卫读取点统一走 getter：反应式补救（L2）在第 2 次尝试时用 `guardOverride` 临时
   * 放宽守卫（连当前轮一起剪），使"被钳后回线"成为可能；其余时刻恒等于 settings 值。
   */
  private guardOverride: { recencyGuard: number; turnGuard: number } | null = null
  get recencyGuard(): number { return this.guardOverride?.recencyGuard ?? this.argpSettings.recencyGuard }
  get turnGuard(): number { return this.guardOverride?.turnGuard ?? this.argpSettings.turnGuard }
  get minSpanChars(): number { return this.argpSettings.minSpanChars }
  get charsPerToken(): number { return this.argpSettings.charsPerToken }
  get maxPasses(): number { return this.argpSettings.maxPasses }
  get enableSummarize(): boolean { return this.argpSettings.enableSummarize }
  get sortMode(): 'legacy' | 'density' | 'density-chain' { return this.argpSettings.sortMode }
  readonly maxOverflowRetries: number
  /** P4 溢出三步第②步回调（undefined = 退化为现役两步）。 */
  readonly onOverflowCompress?: (session: Session) => Promise<void>
  /** P6 轮内压力压缩回调（undefined = 仅溢出才压 open turn，P6 前行为）。 */
  readonly onPrePressureCompress?: (session: Session) => Promise<void>
  /** 闭包静止窗 K（A11 参数化，默认 2）。 */
  readonly closureWindowK: number
  /** cites 前缀最小长度守卫（A2，默认 2；ASCII ≥4 / CJK ≥2 的换算由守卫实现）。 */
  readonly citeMinPrefixLen: number
  /** 版本链重叠归链阈值 θ（A4，默认 0.8）。 */
  readonly overlapTheta: number
  /** 版本链重叠归链开关（A4，默认 false）。 */
  readonly enableOverlapChain: boolean
  /** dsh token-meter 服务；真会话中可用时优先用于 token 测量和 contextWindow 探测。 */
  private readonly tokenMeter: { measure(session: Session): { totalTokens: number; surfaceTokens: number } } | undefined

  /** 遥测数组容量上限（P4.5：records/recallCalls/recallQueryCalls/closurePrunes/auditWarnings 有界）。 */
  readonly telemetryCap: number
  readonly records: GraphPruneRecord[] = []
  readonly recallCalls: { seq: number; hit: boolean; state?: NodeStateLabel }[] = []
  readonly recallQueryCalls: { query: string; count: number; hits: number }[] = []
  readonly citeStats: CiteStats = { aAtoms: 0, declared: 0, resolved: 0, ambiguous: 0, failed: 0 }
  /** §3-3 recall 价值继承：最近一次 recall 的旧原子 seq 与结果 R 原子 seq（建图时用）。 */
  private recallSourceSeq = -1
  private recallResultSeq = -1
  /** 最近一次建图的语义边（判决 G3 读：被引原子是否获得保护）。 */
  lastEdges: SemanticEdge[] = []
  /** 最近一次建图的确定性边（组内 A→R，不参与语义级别排序）。 */
  lastDeterministicEdges: DeterministicEdge[] = []
  /** 边价值实验 A₃：注入的 oracle 边（buildGraph 合并用）。 */
  injectEdges: ((atoms: Atom[]) => SemanticEdge[]) | undefined = undefined
  /** 边价值实验 A₁ 离线重放：跳过 cites 边构建（同时隔离推断边，见 config 注释）。 */
  disableCiteEdges = false
  /** 推断边开关（PROPOSAL-token-ontology 组件 A，v1.2.0；默认启用）。 */
  disableInferredEdges = false
  /** tombstone 归并阈值（§11.8① 修复；默认 8，0=关闭；见 ArgpGraphConfig.tombstoneMergeMinRun）。 */
  tombstoneMergeMinRun = 8
  /** 推断边派生参数（config 缺省 6/0.15/8/20；见 InferredEdgeOptions）。 */
  inferredOpts: InferredEdgeOptions = { minTokenLen: 6, stopwordRatio: 0.15, maxEdgesPerAtom: 8, windowTurns: 20 }
  /** 推断边统计（最近一次 buildGraph 口径）。 */
  readonly inferredStats: InferredStats = { candidates: 0, accepted: 0, skippedDup: 0 }
  /** 最近一次建图的推断边（诊断/测试断言用；同 lastEdges）。 */
  lastInferredEdges: SemanticEdge[] = []
  /** 回复级 cites 义务实际生效值（auto 已解析；构造期定死，运行期不重评）。 */
  readonly citesObligation: boolean
  /** citesObligation 是否 auto 口径（config 未显式给值）。auto 下 section 恒注册、
   *  text 回调随 declarer.armed 动态返回 ''（autoLlm 会话中期武装的时序修复，2026-09-21）。 */
  readonly citesObligationAuto: boolean
  /** P0 双引擎自挂载句柄（config.peratom 缺省时为 null；观测/诊断用）。 */
  readonly peratomStack: {
    compressor: PeratomCompressor | null
    declarer: CiteDeclarer | null
    zoom: RecallZoom | null
  } | null = null

  /** 已剪节点目录（seq -> 元数据 + 依赖），供 list_pruned 查询；新事务覆盖旧 seq。 */
  readonly prunedNodeIndex = new Map<number, PrunedNodeInfo>()
  /** 闭包生命周期剪除记录。 */
  readonly closurePrunes: { closureId: string; rootSeq: number; prunedSeqs: number[]; at: string }[] = []
  private nextClosureId = 0
  /** 闭包最近一次被 recall 回拉的轮次；key = rootSeq（跨 pass 稳定，见 P2 修复注释）。 */
  private closureLastRecalled = new Map<number, number>()
  private recallCallsThisTurn = 0
  private recallCharsUsed = 0
  /**
   * 冻结的 catalog 文本快照：system 块是单条被前缀缓存的消息，块内任何字节变化都会
   * 让整块 KV 失效。故 catalog 不与每步 assemble 联动，而是"全程冻结、仅在真正落剪时刷新一次"
   * （见 bindSession 初值 + pruneIntervals 末尾刷新）。无剪枝的整段对话里 system 块逐字节一致，
   * 前缀缓存全段命中；剪枝本身已改动可见上下文，那一步的缓存失效是必然代价。
   */
  private frozenCatalog: string | null = null
  /** context-overflow 恢复：每个 agent 的重试计数（assistant/message 成功或 idle 时重置）。 */
  private readonly overflowRetries = new WeakMap<Agent, number>()
  /** session → agent 映射，供成功后重置重试计数（agent loop 上下文经 session/event 取不到 agent）。 */
  private readonly overflowAgents = new WeakMap<Session, Agent>()
  /** 最近一次请求的真实 prompt token（usage.inputTokens + cacheReadTokens + cacheWriteTokens，
   *  provider 回报，与 UI ContextMeter 分子同口径）。
   *  pressure check 用它锚定 + 增量估算，替代 tokenMeter 的 chars/4 启发式（低估 30%+，
   *  导致迟触发/窗口保护失效，2026-08-23）。 */
  private lastRealPromptTokens = 0
  /** 声明窗口缓存（session → 适配器声明的 contextWindow，来自 request/context 事件）。
   *  2026-08-28 真环境联调：物理窗口探测（llama.cpp n_ctx=262144）与声明窗口（32000）
   *  在 pre-step 时刻可能错位，声明值缺失时宁可跳过检查也不用物理口径。 */
  private readonly declaredContextWindows = new WeakMap<Session, number>()
  /** 锚点：lastRealPromptTokens 已覆盖的 surface 最大 seq（其后新增内容需增量估算）。 */
  private lastRealAnchorSeq = -1
  /** /compact 手动压缩的发起命令 ID（presentation correlation，透传给事务事件）。 */
  private compactSourceCommandId: CommandId | undefined = undefined
  /** A7：账目重建后追加的审计警告（供测试断言/诊断）。 */
  readonly auditWarnings: string[] = []
  /** A7：已重建过的 compactionId 集合（跨 session 重置，保证幂等 + 告警不重复）。 */
  private rebuiltCompactionIds = new Set<string>()
  /** L2/L3 反应式：观察到"输出被外部钳制"后置位，由 pre-step（turn 仍在跑）或 turn-stopping（本轮要收）消费。 */
  private readonly reactivePending = new WeakMap<Session, true>()
  /** 本次请求声明的输出预算（`agent/request` 捕获；适配器的钳制发生在其后，故这里拿到的是请求值）。 */
  private readonly requestMaxTokens = new WeakMap<Session, number>()
  /** 三级触发 ①②③ 开关与旋钮（cordis 配置，不进 UI 设置页）。 */
  private readonly midTurnPruneEnabled: boolean
  private readonly midTurnTurnGuard: number
  /** 兼容别名路径：`midTurnActive: true` ⇒ 轮中用默认 `turnGuard`（1.3.x 语义）。 */
  private readonly midTurnLegacyGuard: boolean
  private readonly reactiveRetries: number
  private readonly continuationNotice: string
  /** 本 episode（连续被钳）内已用掉的"剪枝 + 续写"次数；出现一次正常输出即清零。 */
  private readonly reactiveRescues = new WeakMap<Session, number>()

  private session: Session | null = null
  private shadowedSession: Session | null = null
  private shadowedSet: Set<number> = new Set()
  private shadowedScanned = 0
  /** 结构化日志门面（构造期自 ctx 捕获）。 */
  private readonly log: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void }

  constructor(ctx: Context, config: ArgpGraphConfig = {}) {
    super(ctx)
    // 结构化日志门面（2026-08-29 review 轻微项）：替换裸 console 直调，日志进宿主
    // 统一管道（ctx.logger 门面；warn/error/info 三级均被 cordis logger 支持）。
    this.log = ctx.logger
    // 静态默认（兼容显式配置路径）：若 config 显式给 windowTokens/retainTokens 用之；
    // 否则运行时在 compactIfNeeded 按 contextWindow × ratio 解析（见 resolveScaledBudgets）。
    this.windowTokens = config.windowTokens ?? DEFAULT_WINDOW_TOKENS
    this.retainTokens = config.retainTokens ?? DEFAULT_RETAIN_TOKENS
    this.explicitWindowTokens = config.windowTokens !== undefined
    this.explicitRetainTokens = config.retainTokens !== undefined
    // 顶层旋钮（windowRatio/retainRatio/recencyGuard/turnGuard/minSpanChars/charsPerToken/
    // maxPasses/enableSummarize/sortMode）改由 ctx.inject(['settings']) 经 settings 源 thunk 驱动
    // （见下方 settings 注册块），此处不再逐字段赋值；getter 读取 this.argpSettings。
    this.reserveTokens = config.reserveTokens ?? 0
    this.telemetryCap = config.telemetryCap ?? DEFAULT_TELEMETRY_CAP
    this.tokenMeterFn = config.measureTokens
    // tokenMeter 不作为 required inject（避免测试/最小化组合缺少该服务时构造失败），
    // 运行时尝试从 ctx 获取；真会话中 dsh-token-meter 已挂载即可使用。
    try {
      this.tokenMeter = (ctx as any).tokenMeter ?? (ctx as any).get?.('tokenMeter')
    } catch {
      this.tokenMeter = undefined
    }
    this.degradationStrategy = config.degradationStrategy ?? 'lifecycle'
    // 2026-08-23 拍板：默认 density（spike 18 离线 + spike 19 真实验证：同达成度下 recall 2→0、
    // 保留集单位信息量更高；eff 同档大 token 先剪 = 分数背包贪心）。需回退可显式传 sortMode:'legacy'。
    this.turnBasis = config.turnBasis ?? 'semantic'

    // ── UI 设置页注册（Settings → Plugins → Configurable → ARGP）──
    // 构造期基线 = cordis 配置（windowRatio 等顶层旋钮）；ctx.inject(['settings']) 在 settings 服务
    // 存在时注册 namespace=`dsh-argp`（base=基线），并把源 thunk 指向 scope.get()；用户经 UI 写入
    // 后 onChange 实时刷新 this.argpSettings，getter 透出即时生效（无需重启）。settings 服务缺失时
    // 优雅回退到 cordis 基线（settingsSource 保持 () => this.argpSettings）。
    const settingsEntry: ArgpUserSettings = {
      windowRatio: config.windowRatio ?? DEFAULT_WINDOW_RATIO,
      retainRatio: config.retainRatio ?? DEFAULT_RETAIN_RATIO,
      maxPasses: config.maxPasses ?? DEFAULT_MAX_PASSES,
      recencyGuard: config.recencyGuard ?? 4,
      turnGuard: config.turnGuard ?? 1,
      minSpanChars: config.minSpanChars ?? 0,
      enableSummarize: config.enableSummarize ?? false,
      sortMode: config.sortMode ?? 'density',
      charsPerToken: config.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN,
    }
    this.argpSettings = settingsEntry
    this.settingsSource = () => settingsEntry
    // `inject` is the graceful-degradation boundary: on a host with no settings
    // service the callback never runs and the composed entry stands.
    ctx.inject(['settings'], (scopedCtx: Context) => {
      const scoped = scopedCtx as unknown as Context & {
        settings: {
          register: (
            ns: string,
            schema: z<ArgpUserSettings>,
            options: { base: ArgpUserSettings },
          ) => { get: () => ArgpUserSettings; watch: (listener: () => void) => void }
        }
      }
      const scope = scoped.settings.register(ARG_SETTINGS_NS, ArgpUserSettingsSchema, { base: settingsEntry })
      this.settingsSource = () => scope.get()
      const apply = (): void => { this.argpSettings = this.settingsSource() }
      // Unload restores the composed entry, so a disabled section cannot leave
      // the engine reading a value nobody can see or change any more.
      scoped.effect(() => () => {
        this.settingsSource = () => settingsEntry
        apply()
      })
      apply()
      scope.watch(apply)
    })
    this.maxOverflowRetries = config.maxOverflowRetries ?? 1
    // 三级触发（1.5.0）：① 轮初主动 ② 轮中压力剪（step>1，放宽 turnGuard）③ 截断后剪+续写。
    // 轮中剪默认**开**：超额的来源是上一批 tool result（轮中），只在轮初判定的 L1 看不见它；
    // 而轮中剪落在那个 pre-step 里，剪完同一步的请求即已瘦身 ⇒ 天然自动继续。
    // 兼容 1.4.0 的 `midTurnActive`：true = 开+默认守卫（1.3.x 对照），false = 关。
    this.midTurnPruneEnabled = config.midTurnPrune ?? config.midTurnActive ?? true
    this.midTurnLegacyGuard = config.midTurnActive === true
    this.midTurnTurnGuard = Math.max(0, config.midTurnTurnGuard ?? 0)
    this.reactiveRetries = Math.max(0, config.reactiveRetries ?? 2)
    this.continuationNotice = config.continuationNotice
      ?? '[argp] 你上一条输出被宿主的输出预算截断了（不是你的错误）。上下文已压缩，请从截断处接着完成当前任务，不要重述已写内容。'
    this.onOverflowCompress = config.onOverflowCompress
    this.onPrePressureCompress = config.onPrePressureCompress
    this.closureWindowK = config.closureWindowK ?? 2
    // 默认 4：ASCII 词（如 "the"=3）被拒；CJK 双字（"读书"=2×2=4）放行（问题 5 修订）
    this.citeMinPrefixLen = config.citeMinPrefixLen ?? 4
    this.overlapTheta = config.overlapTheta ?? 0.8
    this.enableOverlapChain = config.enableOverlapChain ?? false
    this.injectEdges = config.injectEdges
    this.disableCiteEdges = config.disableCiteEdges ?? false
    // v1.2.0 组件 A（PROPOSAL-token-ontology）：推断边参数（默认启用，可单独关停）。
    this.disableInferredEdges = config.disableInferredEdges ?? false
    // v1.2.x §11.8①：tombstone 归并阈值（默认 8；显式 0 = 关闭，对照组实验用）。
    if (config.tombstoneMergeMinRun !== undefined) this.tombstoneMergeMinRun = config.tombstoneMergeMinRun
    if (config.inferredMinTokenLen !== undefined) this.inferredOpts.minTokenLen = config.inferredMinTokenLen
    if (config.inferredStopwordRatio !== undefined) this.inferredOpts.stopwordRatio = config.inferredStopwordRatio
    if (config.inferredMaxEdgesPerAtom !== undefined) this.inferredOpts.maxEdgesPerAtom = config.inferredMaxEdgesPerAtom
    if (config.inferredWindowTurns !== undefined) this.inferredOpts.windowTurns = config.inferredWindowTurns
    // P0 双引擎自挂载：peratom 配置块存在时，Stage-1 三管线在构造期挂载并接线
    // （与 mountPeratomStack 同拓扑：三管线 hook 注册进 ctx 事件总线，本引擎作为
    // ctx.compaction 接收 injectEdges / onOverflowCompress）。
    // ⚠️ 显式判 object（而非只判 `!== undefined`）：YAML 里"关掉 Stage-1"最自然的写法是
    // `peratom: false`，而布尔装箱后 `.compressor` 取到 undefined → `?? {}` → 三管线全挂，
    // 与写配置的人意图**完全相反**。false / null 一律按"不挂"处理（与缺省同语义）。
    if (config.peratom !== undefined && typeof config.peratom === 'object' && config.peratom !== null) {
      if (config.onOverflowCompress !== undefined || config.injectEdges !== undefined) {
        this.log.warn('[argp-graph] peratom block set; explicit injectEdges/onOverflowCompress ignored (wired internally)')
      }
      const compressor = config.peratom.compressor === false ? null : new PeratomCompressor(ctx, config.peratom.compressor ?? {})
      const declarer = config.peratom.declarer === false ? null : new CiteDeclarer(ctx, config.peratom.declarer ?? {})
      const zoom = config.peratom.zoom === false ? null : new RecallZoom(ctx, config.peratom.zoom ?? {})
      if (declarer !== null) this.injectEdges = (atoms) => declarer.buildInjectEdges(atoms)
      if (compressor !== null) {
        this.onOverflowCompress = async (session: Session): Promise<void> => {
          // 溢出发生在当前 open turn 的请求上——第②步要降熵的正是它。closed-turn
          // 口径会错压上一闭合轮（2026-08-29 review 中项），改用 open-turn 入口。
          await compressor.compressOpenTurn(session)
        }
        // P6：轮内压力达标时先压缩 open turn 原子再图剪（与 onOverflowCompress 同入口，
        // 区别只在触发条件：压力 vs 溢出错误）。
        this.onPrePressureCompress = async (session: Session): Promise<void> => {
          await compressor.compressOpenTurn(session)
        }
      }
      this.peratomStack = { compressor, declarer, zoom }
    }

    // P4 修复（2026-08-29 review，严重项）：peratom 第②步（onOverflowCompress）挂载时，
    // 重试上限缺省从 1 提到 3——否则事件#2（retries=1）在重试上限守卫处直接保留原错误，
    // 三步序列的第②步在默认配置下永不触发（测试显式传 3/5 掩盖了缺口，生产挂载路径
    // 无人设值）。显式配置始终优先；耗尽判定（retries≥2，见 request-error 钩子）独立于
    // 本上限，第③步后照旧收束，不会多空转。未挂 compressor（第②步不存在）时维持 1。
    if (config.maxOverflowRetries === undefined && this.onOverflowCompress !== undefined) {
      this.maxOverflowRetries = 3
    }

    // 回复级 cites 义务 auto 口径：declarer 已武装（有 LLM 后端）→ 结构化旁路建边
    // 接管，回复协议关闭；显式 true/false 覆盖。declarer 挂载但未武装时保持开启，
    // 避免"两种边来源同时归零"（见 citesObligation 配置注释）。
    // 2026-09-21 时序修复：autoLlm 兜底的 declarer 构造期未武装（路由要等真会话的
    // agent/status 钩子才解析），构造期布尔无法覆盖它——auto 口径下 section 恒注册，
    // 由 text 回调在 armed 翻转后动态返回 ''（见注册处）；显式覆盖保持静态语义。
    this.citesObligationAuto = config.citesObligation === undefined
    this.citesObligation = config.citesObligation ?? !(this.peratomStack?.declarer?.armed === true)

    const recallTool = defineTool({
      name: 'recall_pruned',
      description: 'Retrieve the original text of any conversation node by its log seq, whether or not it is still in your visible context (text blocks verbatim; tool-call arguments are a JSON semantic-equivalent reconstruction when the host stores them as an object — the reply says so). Call it when your answer depends on content behind an [elided seq=N..M ...] placeholder, or when an earlier value is absent from the visible context. Pass one seq per call. The reply is prefixed with [recall seq=N state=shadowed|live|off-surface] so you know whether that content is currently visible. Everything ever said stays in the append-only log; never guess it. Use list_pruned (including its fromSeq/toSeq range mode) when you do not know the seq.',
      parameters: { seq: { type: 'integer', description: 'log seq of the node to recover; placeholders show the seqs they replaced' } },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      execute: async (args): Promise<string> => {
        const seq = (args as { seq?: number }).seq
        if (seq === undefined || this.session === null) return 'recall_pruned: no session bound'
        if (this.recallCallsThisTurn >= 3) return 'recall_pruned: per-turn budget exceeded (3 calls)'
        this.recallCallsThisTurn += 1
        // P1 修复 (b)：不再用 shadowedSeqsOf 门控。数据路径本来就是全日志级的
        // （eventText 直接索引 sessionEvents(session)[seq]），只有越界才算失败；返回值带状态标签，
        // 使掉出可见上下文但未被 ARGP 替换的节点（适配器窗口丢弃 / 从不进 surface）也可召回。
        const shadowed = this.shadowedSeqsOf(this.session)
        const outcome = recallFromLog(this.session, seq, s => shadowed.has(s), eventText)
        pushBounded(this.recallCalls, { seq, hit: outcome.ok, state: outcome.ok ? outcome.state : undefined }, this.telemetryCap)
        if (!outcome.ok) return formatRecallOutcome('recall_pruned', seq, outcome)
        this.noteRecallHit(seq)
        // 版本链重定向（2026-08-23）：被剪旧 R 若属于某路径版本链，重定向返回该路径最新存活版本原文，
        // 替代旧值。避免模型基于已过时的旧快照做决定（旧值正是被剪的原因）；文件仍在演进时
        // 模型要的是「现在长什么样」。保留 state 标签说明这是重定向结果。
        const redirect = this.prunedNodeIndex.get(seq)?.latestOfPath
        if (redirect !== undefined && redirect !== seq) {
          const latestOutcome = recallFromLog(this.session, redirect, s => shadowed.has(s), eventText)
          if (latestOutcome.ok) {
            const result = stateHeader(seq, latestOutcome.state)
              + '\n[version-chain redirect: seq ' + seq + ' was superseded by newer version seq ' + redirect + ' of the same path; returning the latest]\n'
              + this.budgetRecallText(latestOutcome.text)
            this.recallSourceSeq = seq
            this.recallResultSeq = this.session.seq
            return result
          }
        }
        const result = formatRecallOutcome('recall_pruned', seq, outcome, text => this.budgetRecallText(text))
        // §3-3 recall 价值继承：记录"旧原子 seq → 本次 recall 结果将被 append 为的新 R 原子 seq"。
        // dsh 在工具 execute 返回后 append tool/result 事件，其 seq = 当前事件总数。
        this.recallSourceSeq = seq
        this.recallResultSeq = this.session.seq
        return result
      },
    })
    ctx.tools.register(recallTool)

    const listPrunedTool = defineTool({
      name: 'list_pruned',
      description: 'List conversation nodes that are no longer in your visible context, so you can find the seq to pass to recall_pruned. Default mode lists nodes pruned by ARGP. Range mode (pass fromSeq/toSeq) scans the raw append-only log over that seq window and reports every node with text, including nodes that are still on the surface but may have fallen outside the model render window — use it when a placeholder does not mention the seq you need. Each line carries seq, type, turn, state (shadowed/live/off-surface) and a first-line preview. Optional filters: turn, type (A/R/U/X/T), keyword, limit.',
      parameters: {
        turn: { type: 'integer', description: 'optional exact turn number filter' },
        type: { type: 'string', description: 'optional node type filter: A (assistant), R (tool result), U (user), X (checkpoint), T (tool call, range mode only)' },
        keyword: { type: 'string', description: 'optional substring that must appear in the node text' },
        fromSeq: { type: 'integer', description: 'optional range-mode start seq (inclusive); enables raw-log scanning instead of the pruned-only list' },
        toSeq: { type: 'integer', description: 'optional range-mode end seq (inclusive); defaults to the newest event when only fromSeq is given' },
        limit: { type: 'integer', description: 'optional maximum number of lines to return (default 50 in range mode, capped at 200)' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      execute: async (args): Promise<string> => {
        if (this.session === null) return 'list_pruned: no session bound'
        const shadowed = this.shadowedSeqsOf(this.session)
        const filters = (args ?? {}) as {
          turn?: number
          type?: string
          keyword?: string
          fromSeq?: number
          toSeq?: number
          limit?: number
        }
        // P1 修复 (b) 的另一半：区间模式 = 发现原语。去门控只解决"知道 seq 就能取"，
        // 掉出渲染窗口的 live 节点没有 tombstone 也不带 seq，模型需要能按区间查全日志补集。
        if (filters.fromSeq !== undefined || filters.toSeq !== undefined) {
          const total = this.session.seq
          const limit = Math.max(1, Math.min(200, filters.limit ?? 50))
          const range = queryLogRange(this.session, {
            fromSeq: filters.fromSeq ?? 0,
            toSeq: filters.toSeq ?? total - 1,
            turn: filters.turn,
            type: filters.type,
            keyword: filters.keyword,
            limit,
          }, s => shadowed.has(s), eventText)
          if (range.rows.length === 0) {
            return 'list_pruned (range mode): no node with text in seq '
              + (filters.fromSeq ?? 0) + '..' + (filters.toSeq ?? total - 1) + ' matches the filters'
          }
          const header = 'list_pruned (range mode): ' + range.rows.length + ' node(s) in seq '
            + (filters.fromSeq ?? 0) + '..' + (filters.toSeq ?? total - 1)
            + ' (log has ' + total + ' events; state=shadowed means ARGP pruned it, '
            + 'live means still on the surface, off-surface means log-only)'
            + (range.truncated ? '; output capped at limit=' + limit + ', narrow the range or raise limit' : '')
          const rangeLines = range.rows.map(row => {
            const indexed = this.prunedNodeIndex.get(row.seq)
            const citedBy = indexed !== undefined && indexed.citedBySeq.length > 0
              ? ' citedBy=' + indexed.citedBySeq.join(',')
              : ''
            return formatLogRow(row, citedBy)
          })
          return header + '\n' + rangeLines.join('\n')
        }
        const lines: string[] = []
        const seqs = [...shadowed].sort((a, b) => a - b)
        for (const seq of seqs) {
          const event = sessionEvents(this.session)[seq]
          if (event === undefined) continue
          const data = event.data as Record<string, unknown> | undefined
          const turn = typeof data?.turn === 'number' ? (data.turn as number) : 0
          if (filters.turn !== undefined && turn !== filters.turn) continue
          let type: AtomType
          if (event.type === 'user/message') {
            type = classifyUserMessage(data)
          } else if (event.type === 'assistant/message') {
            type = 'A'
          } else if (event.type === 'tool/result') {
            type = 'R'
          } else {
            type = 'X'
          }
          if (filters.type !== undefined && type !== filters.type) continue
          const text = eventText(this.session, seq)
          if (filters.keyword !== undefined && !text.includes(filters.keyword)) continue
          const firstLine = text.split('\n').map(l => l.trim()).find(l => l !== '') ?? ''
          const preview = firstLine.length > 120 ? firstLine.slice(0, 120) + '…' : firstLine
          const indexed = this.prunedNodeIndex.get(seq)
          const citedBy = indexed !== undefined && indexed.citedBySeq.length > 0
            ? ' citedBy=' + indexed.citedBySeq.join(',')
            : ''
          lines.push('seq=' + seq + ' type=' + type + ' turn=' + turn + ' state=shadowed' + citedBy + ' first=' + preview)
        }
        if (lines.length === 0) {
          return 'list_pruned: no pruned node matches the filters. '
            + 'If the content you need was never replaced by a placeholder, retry with range mode '
            + '(fromSeq/toSeq) to scan the raw log window.'
        }
        return lines.join('\n')
      },
    })
    ctx.tools.register(listPrunedTool)

    const recallQueryTool = defineTool({
      name: 'recall',
      description: 'Search nodes that are no longer in your visible context by content query and return matching original text. Use when you know roughly what was said but not the exact seq. Prefer list_pruned when you can identify by turn/type or by seq range, and recall_pruned(seq) when you already know the seq.',
      parameters: {
        query: { type: 'string', description: 'keywords or substring to search in content that left the visible context' },
        maxResults: { type: 'integer', description: 'optional maximum number of matches to return (default 5)' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      execute: async (args): Promise<string> => {
        if (this.session === null) return 'recall: no session bound'
        if (this.recallCallsThisTurn >= 3) return 'recall: per-turn budget exceeded (3 calls)'
        this.recallCallsThisTurn += 1
        const query = (args as { query?: string }).query ?? ''
        const maxResults = (args as { maxResults?: number }).maxResults ?? 5
        return this.budgetRecallText(this.recallQuery(query, maxResults))
      },
    })
    ctx.tools.register(recallQueryTool)

    // 压缩/恢复契约（静态部分）：只负责“视图可能被剪 + 必要时用 recall 工具找回”。
    // 本 section 的 text 必须是纯静态（不引用引擎运行时状态）——否则每轮变化会破坏
    // system message 前缀，使 KV/prefix cache 从本位置起全部失效（动态目录见 argp-catalog）。
    ctx.systemPrompt.section({
      name: 'argp-contract',
      order: 150,
      text: () => 'Context compression (ARGP):\n'
        + 'Your visible context is a pruned view of the full conversation. Older parts may be no longer in visible context — either replaced by placeholders like [elided seq=N..M ...], or dropped from the render window without any placeholder. Absence from the visible context never means it was never said.\n'
        + '- Every reply must be self-contained plain text: state facts, conclusions, and content directly in natural language. Never answer by pointing at earlier context items instead of restating the needed content.\n'
        + '- When your answer depends on content that is no longer in visible context, use list_pruned to find the right seq, then call recall_pruned(seq) or recall(query) to recover the full text before answering. Never reconstruct missing facts from memory.\n'
        + '- If a placeholder does not name the seq you need, or the content you need left the context without any placeholder, use list_pruned with fromSeq/toSeq to scan that seq window of the raw log. recall_pruned works on any seq in the log and labels each result with state=shadowed|live|off-surface.',
    })

    // 被剪目录：沉到 system message 尾部（order 9999），使 persona + argp-contract 正文 +
    // argp-cites 等静态 section 构成稳定前缀。
    // 根因修复：原实现把动态 catalog 拼进 order:150 的契约段，导致 system message 前缀每轮变、
    // 缓存从 catalog 处断开（2026-08-22 发现，A 臂测试缓存零命中）。recall 协议不依赖其在 system 靠前。
    // 位置说明（2026-09-10 核实）：本段文本恒为空串（frozenCatalog 首绑即冻成 ''，见 bindSession 与
    // test/argp-graph-engine.test.ts:374/397 断言），故 order 取值对本段的缓存影响实为零——保持 9999
    // 仅为保守不动既有排布。注意 dsh 0.1.5-rc.1 起 HARNESS_SOURCE/WEB_SURFACE/DEPLOYMENT_PERSONA_SUFFIX
    // 被排到 10000/10100/10200，本段不再字面意义上"最后"，但三段均为会话内静态、不构成每轮 cache-miss。
    ctx.systemPrompt.section({
      name: 'argp-catalog',
      order: 9999,
      // 永久冻结快照：catalog 只在首次 bindSession 拍一次（见 bindSession / pruneIntervals 注释），
      // 之后全程回放 frozenCatalog，绝不引用实时状态——否则每步重求值会改 system 块、打穿前缀缓存。
      // fallback 用空串而非 catalogText：即便极端情况下 frozenCatalog 为 null，也返回空而非 live 重算，
      // 保证 system 块恒定。
      text: () => this.frozenCatalog ?? '',
    })

    // 引用输出协议：独立 PromptSection，只负责 cites 格式；recall 行为不在这里要求。
    // 挂载受 citesObligation 门控（auto：declarer 已武装即不注册——边声明走结构化旁路，
    // 回复不再携带 cites 尾，源头消灭 UI 显示泄漏）。协议关闭不影响引擎侧剥离与
    // buildGraph 解析：模型偶发残留的 cites 尾仍被剥离并作为加菜边消费。
    // 2026-09-21 时序修复（autoLlm）：auto 兜底的 declarer 构造期未武装、会话中期
    // 才经 agent/status → rememberRoute 武装，构造期布尔无法预判——auto 口径下
    // section 恒注册，text 回调在 armed 翻转后动态返回 ''；renderPrompt 过滤空
    // section ⇒ system 块不再含协议。armed 单调递增（autoLlm 只赋值不清除）⇒
    // 至多翻转一次，代价 = 一次 system 块 KV 失效（通常发生在首个请求之前，可忽略）。
    // 始终未武装时保持全文（两种边来源不能同时归零）。显式覆盖保持静态语义。
    // V4 措辞（实测，spike 脚本已精简移除）：明示"读了工具结果并作答 = 必须引用该结果"，
    // 比旧版"if used ... append"的被动式显著提升 t-long 类任务下的声明率。
    // V5 措辞（2026-08 修 UI 残留）：空引用时"完全不输出 block"而非写 {"cites":[]}。
    // 原因：dsh 核心的人类转录固定取 append 起源事件（replace 副本 model-only，
    // 见 core session surface.ts "replacement copies stay model-only"），surface
    // 剥离永远改不到 UI 显示；空块对引用图零信息（无入边），只能在源头不产出。
    // 引擎侧对"无块"本就是常态（§4.7），citeStats 对空/无块均不计 declared。
    if (this.citesObligation || this.citesObligationAuto) {
      ctx.systemPrompt.section({
        name: 'argp-cites',
        order: 151,
        text: () => {
          if (this.citesObligationAuto && this.peratomStack?.declarer?.armed === true) return ''
          return 'Citation declaration (ARGP):\n'
            + 'In this session you frequently read files with read_file and answer from their content. EVERY time your final reply is based on a tool result you read, you MUST cite it.\n'
            + 'When your reply depends on at least one earlier item, append ONE JSON block to the end of your final reply:\n'
            + '{"cites":[...]}\n'
            + '- When you answered from a file you read, cite that file\'s tool result: copy verbatim the first 10-20 words of its content.\n'
            + '- Cite user instructions you followed and earlier assistant claims you built upon too.\n'
            + '- If your reply used nothing from earlier items, output no block at all — never an empty {"cites":[]} block.\n'
            + '- Grading (V6): by default a citation is supporting. When the cited item is load-bearing for a chain of decisions (a critical fact your whole answer stands on), you may declare it as: {"cites":[{"t":"<verbatim prefix>","l":"c"}]} — use "s" for supporting and "x" for contextual. Bare strings are treated as supporting.\n'
            + '- The block goes in the final reply body, never in reasoning. Output nothing after it.'
        },
      })
    }

    ctx.on('session/event', (session, event) => {
      if (event.type === 'turn/start') {
        this.recallCallsThisTurn = 0
        // 续写阶梯按 turn 重置：**同一 turn 内**的连续被钳逐级放宽守卫（第 2 次起 recency/turn
        // guard 归零），turn 一换就重新拿到完整额度——既保证"连续被钳能升级"，又不会把整条
        // 会话的额度耗在一次事故上，也天然封住"每步都被钳 → 每步白压"的循环。
        this.reactiveRescues.delete(session)
      }
      // L2/L3 反应式信号（1.4.0 引入，1.5.0 扩展到续写）："输出被**外部**钳制"的真信号。
      // `assistant/message.data.stream` 末项 = finish chunk（全 session 实测词表：
      // tool-calls / stop / max-tokens）；`data.usage.outputTokens` 是本步实际输出。
      // 判据：kind === 'max-tokens' **且** outputTokens < 本次请求声明的 maxTokens
      //   ⇒ 输出预算被宿主/适配器啃小（实测 1,911 / 1 / 4,714 vs 请求 32,768）= 容量压力
      //     ⇒ 置位；pre-step 会强制剪（turn 还在跑），turn-stopping 会剪 + steer 续写（本轮要收）；
      //   ⇒ outputTokens ≈ maxTokens 则是模型自己写满预算，不构成上下文压力，不触发。
      // 正常输出（非钳制）⇒ 清零本 episode 的续写阶梯（见 reactiveRescues），
      // 使"连续被钳才升级"成立，而长会话中的偶发钳制各自都能拿到完整的重试额度。
      if (event.type === 'assistant/message') {
        const data = event.data as {
          stream?: readonly { chunk?: { type?: string; reason?: { kind?: string } } }[]
          usage?: { outputTokens?: number }
        } | undefined
        const tail = Array.isArray(data?.stream) ? data.stream[data.stream.length - 1] : undefined
        const finish = tail?.chunk
        const output = data?.usage?.outputTokens
        const budget = this.requestMaxTokens.get(session)
        const clamped = finish?.type === 'finish' && finish.reason?.kind === 'max-tokens'
          && typeof output === 'number' && typeof budget === 'number' && output < budget
        if (clamped) {
          this.reactivePending.set(session, true)
          this.log.warn('[argp-graph] output clamped by the host: finish=max-tokens with output='
            + output + ' < requested ' + budget + ' ⇒ prune + continue the same turn')
        }
      }
      // 声明窗口缓存（2026-08-28 真环境联调）：request/context 事件携带适配器声明的
      // contextWindow（settings 模型条目），是权威口径。pre-step 压力检查可能早于首个
      // request/context 事件落账（新会话 turn-1），此缓存使后续检查/重启会话立即拿到
      // 声明值，不再退化为物理窗口探测（llama.cpp 场景 262144 vs 声明 32000，7.7× 口径差）。
      if (event.type === 'request/context') {
        const declared = (event.data as { contextWindow?: number } | undefined)?.contextWindow
        if (typeof declared === 'number' && declared > 0) {
          const previous = this.declaredContextWindows.get(session)
          if (previous !== undefined && previous !== declared) {
            this.log.info(`[argp-graph] declared contextWindow changed: ${previous} -> ${declared}`)
          }
          this.declaredContextWindows.set(session, declared)
        }
      }
      // 外来压缩事务可见性（2026-08-28 真环境联调）：本插件的 compactionId 一律带
      // `argp-` 前缀；不带前缀的 compaction/start = 其他压缩实现（如原生摘要器）在
      // 本 ctx.compaction 位之外运作——lossy 摘要会先于图剪发生，必须在日志可见。
      if (event.type === 'compaction/start') {
        const cid = (event.data as { compactionId?: string } | undefined)?.compactionId
        if (typeof cid === 'string' && !cid.startsWith('argp-')) {
          this.log.warn(`[argp-graph] foreign compaction detected (id=${cid}, turn=${turnOf(event) ?? '?'})`
            + ' — a non-ARGP compaction engine is active; lossy summarization may pre-empt graph pruning')
        }
      }
      // 真实 token 锚点（2026-08-23）：assistant/message 携带 provider 回报的 usage，
      // inputTokens（未命中）+ cacheReadTokens（命中）+ cacheWriteTokens（写缓存，
      // Anthropic 风格 provider 上报；OpenAI 兼容端点缺省 0）= 本次请求的真实 prompt token。
      // pressure check 优先用它，避免 tokenMeter chars/4 低估导致的迟触发。
      // 与 UI ContextMeter 分子同口径（connection client contextPressureOf）。
      if (event.type === 'assistant/message') {
        const usage = (event as { data?: { usage?: { inputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number } } }).data?.usage
        const seq = (event as { seq?: unknown }).seq
        if (usage !== undefined && typeof usage.inputTokens === 'number') {
          this.lastRealPromptTokens = (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
          if (typeof seq === 'number') this.lastRealAnchorSeq = seq
        }
        // 一次成功的模型应答 = 溢出恢复序列的终结点：重置该 agent 的重试计数，
        // 即使工具调用让同一 turn 继续（对齐 compaction-basic 的 overflowAgents 模式）。
        const agent = this.overflowAgents.get(session)
        if (agent !== undefined) this.overflowRetries.delete(agent)
      }
      // 流式闭环后立刻剥离尾部 {"cites":[...]} JSON（ARGP 引用协议产物），
      // 使其不残留在模型可见 surface 上（UI 人类转录取 append 原文，不受影响；
      // 空块由契约 V5 在源头不产出）。完全在 dsh-argp 插件内完成，不改官方插件。
      const seq = (event as { seq?: unknown }).seq
      if (event.type === 'assistant/message' && typeof seq === 'number') {
        // 延迟到本次事件发射结束后执行，避免在读/写 surface 的中途改写 surface（重入安全）
        const ev = event as { seq: number; data?: Record<string, unknown> }
        Promise.resolve().then(() => {
          try { stripTrailingCitesIfNeeded(session, ev) } catch { /* 不阻断主流程 */ }
        })
      }
    })
    ctx.on('agent/status', ({ agent, status }) => {
      if (status === 'idle') this.overflowRetries.delete(agent)
    })
    // 上下文溢出恢复（官方机制，与 compaction-basic 同构）：模型请求返回
    // 400 exceed_context_size_error（稳定错误码 CONTEXT_WINDOW_EXCEEDED，不写死
    // token 数）时，强制剪枝并把请求重发出去。识别靠 LlmFailure.code ——
    // provider 特定错误（DeepSeek 的 {"type":"exceed_context_size_error"}）由
    // dsh-llm 适配器归一化到该稳定码。
    ctx.on('agent/request-error', async (
      { agent, failure, signal },
      next,
    ): Promise<RequestErrorAction> => {
      if (failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE || signal.aborted) return next()
      this.overflowAgents.set(agent.session, agent)
      const retries = this.overflowRetries.get(agent) ?? 0
      if (retries >= this.maxOverflowRetries) return next()
      // P4 溢出三步序列（在现有重试环内，"仍超？"的真信号 = provider 再次溢出事件）：
      //   事件#1（retries=0）→ ① forcePrune(旧内容) → retry
      //   事件#2（retries=1）→ ① 没解决才走到这：② onOverflowCompress（当前轮
      //      per-atom 降熵：U 拆分/大 R extract，顺带补 cites）→ ③ forcePrune → retry
      //   事件#3（retries≥2）→ ③ 也没解决 → 保留原错误（现有行为）
      // retries 是每序列单调计数器（成功应答/idle 才重置），故第②步全序列只跑一次、
      // 且永不空转（① 成功即不再溢出、不再进本钩子）。onOverflowCompress 未注入时
      // 事件#2 直接保留原错误——与现役行为完全一致。
      const session = agent.session
      const genBefore = session.surface.replaceGeneration
      const isStepOne = retries < 1
      // 耗尽判定：事件#3（retries≥2 三步用尽）或未注入 compressor 的事件#2（现役即止）。
      if (!isStepOne && (this.onOverflowCompress === undefined || retries >= 2)) {
        this.log.warn(`[argp-graph] overflow recovery exhausted (retries=${retries}); preserving the original request error`)
        return next()
      }
      // ② per-atom 降熵（仅事件#2；① 成功就不会进到这里，故不空转）。
      // 失败隔离：compressor 抛错只记日志——genBefore 在其前捕获，② 的换代仍计入下方
      // "durable progress" 凭证，不吞 provider 溢出错误。
      if (!isStepOne && this.onOverflowCompress !== undefined) {
        try {
          await this.onOverflowCompress(session)
        } catch (compressError: unknown) {
          const message = compressError instanceof Error ? compressError.message : String(compressError)
          this.log.warn(`[argp-graph] overflow per-atom compress failed: ${message}; relying on step-3 forcePrune`)
        }
      }
      // ①（事件#1）/ ③（事件#2）forcePrune
      let result: CompactionResult | null
      try {
        result = await this.compactIfNeeded(agent, 'context-overflow', signal)
      } catch (recoveryError: unknown) {
        const message = recoveryError instanceof Error ? recoveryError.message : String(recoveryError)
        // 剪枝可能在 summarize 之类后续阶段抛错前已落地（模型无关的确定性占位
        // 替换）；或 ② 已换代。只要 surface 换代了，这次减量就是重试的充分凭证，不丢弃。
        if (!signal.aborted && session.surface.replaceGeneration > genBefore) {
          this.log.warn(`[argp-graph] overflow prune failed after durable surface progress: ${message}; retrying from the replacement surface`)
          this.overflowRetries.set(agent, retries + 1)
          return { kind: 'retry' }
        }
        this.log.warn(`[argp-graph] overflow prune failed: ${message}; ${signal.aborted ? 'cancellation prevents retry' : 'preserving the original request error'}`)
        return next()
      }
      if (signal.aborted || session.surface.replaceGeneration <= genBefore) return next()
      if (result !== null) {
        this.log.info(
          `[argp-graph] context-overflow step-${isStepOne ? 1 : 3} prune: shadowed ${result.shadowedSeqs.length} surface nodes `
          + `(seqs ${result.shadowedRange.start}-${result.shadowedRange.end}, ~${result.shadowedTokenCount} tokens)`,
        )
      }
      this.overflowRetries.set(agent, retries + 1)
      return { kind: 'retry' }
    })
    // 本次请求声明的输出预算（L2 判据的一半）。只读 waterfall：不改配置，仅记录，供
    // assistant/message 落账时区分"输出被**外部**钳制"与"模型自己写满预算"。
    ctx.on('agent/request', async ({ agent }, next) => {
      const config = await next()
      if (typeof config.maxTokens === 'number' && config.maxTokens > 0) {
        this.requestMaxTokens.set(agent.session, config.maxTokens)
      }
      return config
    })
    ctx.on('agent/pre-step', async ({ agent, messages, step, signal }, next): Promise<PreStepDecision> => {
      this.bindSession(agent.session) // A7（问题 3）：生产 resume 点，账目缺失时自动重建
      if (!signal.aborted) {
        const session = agent.session
        // ── 三级触发的判定窗口（v1.5.0）────────────────────────────────────────
        // pre-step 载荷自带 `{ messages, turn, step }`：宿主 `agent.ts:244` 先 claim
        // （把本步要发的 user 消息取出，落一条 inbox/spliced），`:250` 才 dispatch 本
        // 钩子 ⇒ **轮初（step===1）时 `messages` 就是本轮新 user 消息的精确内容**，而它
        // 此刻尚未进 surface。故轮初估值既不需要"预测"，也不会漏掉用户的大段粘贴。
        //   · step === 1 → L1 轮初主动：per-atom LLM pass（原子降熵）+ 图剪，阈值沿用
        //     windowRatio；估值含本步已 claim 未落盘的 user 消息。
        //   · step  > 1 → L1' 轮中压力剪：**只做 0-LLM 图剪**，且放宽 `turnGuard`
        //     （`midTurnTurnGuard`，默认 0）。真会话存档实证：超额的来源恰恰是上一批
        //     tool result（轮中），而 turnGuard=1 把整轮保护起来——这正是 1.3.x 轮中剪
        //     "只剪 1 原子/154 tok、却每次断一次前缀缓存"的根因。轮中不跑 per-atom pass：
        //     那是 79s–3min 的阻塞，轮内不划算（轮初/轮末另有专门通道）。
        // 两种时机都落在**本 pre-step**：剪完同一个 step 的请求即已瘦身 ⇒ 天然自动继续本 turn。
        // 回调失败隔离：吞错后照常走图剪。
        const turnStart = step === 1
        if (turnStart || this.midTurnPruneEnabled) {
          const incoming = this.incomingTokens(messages)
          // per-atom 压缩：轮初必跑；轮中只在 `midTurnActive: true`（1.3.x 对照档）下跑——
          // 它需要 open turn 的原子，且是一次 79s–3min 的阻塞，新默认档的轮中剪刻意不带它。
          if ((turnStart || this.midTurnLegacyGuard)
            && this.onPrePressureCompress !== undefined && detectOpenTurn(session) !== null) {
            if (await this.isPressureExceeded(agent, incoming)) {
              try {
                await this.onPrePressureCompress(session)
              } catch (error: unknown) {
                const message = error instanceof Error ? error.message : String(error)
                this.log.error('[argp-graph] pre-pressure peratom compress FAILED: ' + message)
                this.log.warn(`[argp-graph] pre-pressure compress failed: ${message}; proceeding to graph prune`)
              }
            }
          }
          const previousOverride = this.guardOverride
          if (!turnStart) {
            // 轮中剪：只放宽 turnGuard；recencyGuard 照旧保护最新节点（刚收到的 tool result 不动）。
            this.guardOverride = {
              recencyGuard: this.argpSettings.recencyGuard,
              turnGuard: this.midTurnLegacyGuard ? this.argpSettings.turnGuard : this.midTurnTurnGuard,
            }
          }
          try {
            await this.compactIfNeeded(agent, 'pressure', signal, incoming)
          } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error)
            this.log.error('[argp-graph] pressure prune FAILED: ' + message + (error instanceof Error && error.stack ? '\n' + error.stack.split('\n').slice(0, 6).join('\n') : ''))
            this.log.warn(`[argp-graph] pressure prune failed: ${message}; continuing the turn`)
          } finally {
            this.guardOverride = previousOverride
          }
        }
        // turn 仍在跑时的收紧剪（被 turn-stopping 消费过的不再重复）。
        await this.runReactivePrune(agent, signal, ctx)
      }
      return next()
    })

    // ── L3 截断续写（v1.5.0 核心）──────────────────────────────────────────────
    // 把"输出被外部钳制 ⇒ 本 turn 被 max-tokens 终结 ⇒ 任务半途而废"改写成
    // "剪掉超额 + steer 一条续写消息 ⇒ **同一个 turn** 继续推进当前任务"。
    //
    // 为什么必须挂在这里：宿主 `agent-loop/src/agent.ts:483` 在 `finish.kind === 'max-tokens'`
    // 时**直接 return**（先于 `executeToolCalls` ⇒ 那一步的 tool calls 被丢弃），`turn()` 随即因
    // `turnEnds && inbox.nextStep.length === 0` 收轮 ⇒ agent 回 idle 等用户。真会话存档实证：
    // 全库 5/5 次钳制后面紧跟的都是 `step/end > turn/end`，没有一次续跑。
    // `agent/turn-stopping` 是本轮最后一个可干预点（turn/end 尚未落账 ⇒ 编号 bracket 仍属本 turn），
    // 且 harness 自带契约测试锁定 *"steer() from an agent/turn-stopping listener continues the
    // same turn"*（`packages/core/agent-loop/tests/contract-regressions.spec.ts:323`）：steer 进
    // next-step 后循环以 `target='next-step'` 续跑，用户无需再发"继续"。
    ctx.on('agent/turn-stopping', async ({ agent, signal }) => {
      const session = agent.session
      if (!this.reactivePending.has(session)) return
      this.reactivePending.delete(session)
      if (signal.aborted) return
      const used = this.reactiveRescues.get(session) ?? 0
      if (used >= this.reactiveRetries) {
        this.log.warn('[argp-graph] auto-continue: limit reached (' + used + '/' + this.reactiveRetries
          + '); letting the turn end — the task needs a new user message')
        return
      }
      this.reactiveRescues.set(session, used + 1)
      const relax = used + 1 > 1
      const previousOverride = this.guardOverride
      if (relax) {
        this.guardOverride = { recencyGuard: 0, turnGuard: 0 }
        this.log.warn('[argp-graph] auto-continue attempt ' + (used + 1) + ': relaxing recency/turn guards')
      }
      let result: CompactionResult | null = null
      try {
        result = await this.compactIfNeeded(agent, 'context-overflow', signal)
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        this.log.error('[argp-graph] auto-continue prune FAILED: ' + message)
      } finally {
        this.guardOverride = previousOverride
      }
      if (result === null || result.shadowedSeqs.length === 0) {
        // 本轮剪不动 ⇒ 把信号留到下一次机会（通常是用户开口后的那一轮 pre-step，那时阶梯已 +1、
        // 守卫放宽）。不 steer：零腾空还续写，只会立刻再被钳一次。
        this.rearmReactive(session, used + 1)
        this.log.warn('[argp-graph] auto-continue: nothing prunable; letting the turn end')
        return
      }
      this.log.warn('[argp-graph] output was clamped by the host: pruned ' + result.shadowedSeqs.length
        + ' nodes (~' + result.shadowedTokenCount + ' tokens) at turn-stopping; steering a continuation'
        + ' so the same turn keeps advancing the task')
      if (this.continuationNotice.length === 0) return
      try {
        agent.steer(createUserMessage({
          content: [{ type: 'text', text: this.continuationNotice }],
          // 宿主/本引擎都把 `plugin` 源归为 X（可见、不参剪）⇒ 这条提示既进请求又不会被剪掉，
          // 且 UI 侧按 notice 渲染，不会伪装成用户输入。
          source: {
            kind: 'plugin',
            plugin: 'dsh-argp',
            form: 'notice',
            summary: 'output clamped; context pruned — continuing the same turn',
          },
        }))
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        this.log.error('[argp-graph] auto-continue steer FAILED: ' + message)
      }
    })

    // Preset 净化（Q8 收口）：roster 服务可用时，对含 stock compaction 的 shipped
    // preset 生成 `<id>-argp` 净化副本（摘 compaction-basic/tool-result-pruner，
    // 留 command-compact——其 compaction inject 沿 realm 链解析到本引擎）。
    // inject 是优雅降级边界：无 agentPresets 的部署（headless 等）回调永不执行；
    // 净化全程 fail-soft，失败只记日志（install-hygiene 不能阻断引擎挂载）。
    if (config.presetClean !== false) {
      ctx.inject(['agentPresets'], (iocCtx: Context) => {
        const presets = (iocCtx as unknown as { agentPresets?: PresetRosterLike }).agentPresets
        if (presets === undefined) return
        const options = config.presetClean === false ? {} : config.presetClean
        void cleanShippedPresets(presets, options ?? {})
          .then(report => {
            for (const outcome of report.outcomes) {
              if (outcome.status === 'skipped') {
                if (outcome.reason !== 'no stock compaction-basic') {
                  this.log.warn(`[argp-preset-clean] ${outcome.source}: skipped (${outcome.reason ?? 'unknown'})`)
                }
                continue
              }
              if (outcome.status === 'already-clean') continue
              this.log.info(`[argp-preset-clean] ${outcome.source} -> ${outcome.target} (${outcome.status}; removed: ${outcome.removed.join(', ') || 'none'})`
                + ' — select "' + outcome.target + '" for new sessions; /compact in it routes to ARGP')
            }
          })
          .catch((error: unknown) => {
            this.log.warn('[argp-preset-clean] failed: ' + String(error))
          })
      })
    }
  }

  /**
   * A7（问题 3 修订）：session 绑定统一入口——setSession / agent/pre-step / compactIfNeeded 首次绑定
   * 都走这里。绑定后若 records 为空且日志含 compaction/start 事件（resume 场景：账目丢失仅日志在），
   * 懒触发 rebuildLedgerFromLog() 自动重建；幂等由 rebuiltCompactionIds 去重保证。
   */
  private bindSession(session: Session): void {
    if (this.session === session) return
    this.session = session
    this.rebuiltCompactionIds.clear() // 跨 session 重置告警/重建去重
    this.shadowedSeqsOf(session) // setSession 时初始化一次；后续仅扫描新追加事件
    try {
      this.rebuildLedgerFromLog() // 懒触发：仅当 records 空 + 日志含事务事件时真正重建
    } catch { /* 重建失败不阻断 turn */ }
    // 锚点回填（2026-09-21）：换 session 身份 = 进程重启后 resume / 新会话，
    // 此时内存锚点要么属于上一个 session（失效），要么为空 ⇒ 必须从日志恢复，
    // 否则压力检查静默退化为 chars 口径（详见 restoreUsageAnchor 注释）。
    this.restoreUsageAnchor(session)
    // 永久冻结 catalog：仅在首次绑定（frozenCatalog 仍为 null）时拍一次快照。
    // 后续任何重绑（agent/pre-step 每步传来的 session 对象可能换新身份，见 line 870）或落剪
    // 都不再改写 —— 这是 1.0.2 仍漏的 bug：session 对象换位时 bindSession 重跑会把
    // frozenCatalog 重算成当时 catalogText 值（有时返回 ''），导致 catalog 段在非剪枝步骤
    // 凭空消失/重现、打穿前缀缓存。现改为"只冻一次"，system 块全程逐字节恒定、KV 100% 命中。
    // 代价：catalog 文本停在首绑时刻（recall_pruned / list_pruned 仍扫原始日志，发现能力不丢）。
    if (this.frozenCatalog === null) this.frozenCatalog = this.catalogText(20, 70)
  }

  setSession(session: Session): void {
    this.bindSession(session)
  }

  /**
   * 真实 token 锚点回填（2026-09-21 修，问题定位见 docs/audit-prune-priority / 当日台账）。
   *
   * 背景：`lastRealPromptTokens` / `lastRealAnchorSeq` 原先**只**由 `ctx.on('session/event')`
   * 的 `assistant/message` 处理器写入。宿主进程重启后 resume 的会话若不再把该事件喂给本
   * 引擎（真环境 2026-09-21 实证：同一会话 turn 1 锚点正常、turn 2 起恒为 0），
   * `measureTokens` 会静默走回退分支 `visibleChars / charsPerToken`——而 `visibleChars`
   * 的投影口径**不含 reasoning**。实测该估算 ≈ 真实 prompt 的 **0.48 倍**：
   *   turn 6 真实 prompt 210,719 tok 时估算仅 ≈102,703 ⇒ 触发线 100,007 一路不越线，
   *   直到真实 prompt 210,719 才触发（迟 2.1×，66 步空转；graph 剪全程只跑 1 次）。
   *   windowRatio=0.8 档下估算上限 ≈126K **永远够不到** 210,715 触发线 ⇒ 压力路径
   *   完全不触发，只剩 provider 报错后的溢出恢复兜底。
   *
   * 口径与 usage 处理器**完全一致**（in + cacheRead + cacheWrite = provider 回报的 billed
   * prompt），取日志中最后一条带 `usage.inputTokens` 的 `assistant/message`——即本进程
   * 重启前最后一次真实请求的 prompt 规模。日志无带 usage 的应答（全新会话）⇒ 重置为
   * 0 / -1，保持既有回退行为（新会话首轮本就没有可用锚点）。
   *
   * 幂等与成本：反向扫描在最后一条带 usage 的应答处提前返回（通常就是最后一条应答）；
   * 会话身份每步换新（见 bindSession 注释）时重复回填的值恒等于 live 处理器写入的值
   * （日志 append-only，最后一条 usage 恒 ≥ 内存锚点），故重复执行不会回退。
   */
  private restoreUsageAnchor(session: Session): void {
    let restored = false
    try {
      const events = sessionEvents(session)
      for (let i = events.length - 1; i >= 0; i -= 1) {
        const event = events[i]
        if (event?.type !== 'assistant/message') continue
        const usage = (event.data as { usage?: { inputTokens?: unknown; cacheReadTokens?: unknown; cacheWriteTokens?: unknown } } | undefined)?.usage
        if (usage === undefined || typeof usage.inputTokens !== 'number') continue
        const read = typeof usage.cacheReadTokens === 'number' ? usage.cacheReadTokens : 0
        const write = typeof usage.cacheWriteTokens === 'number' ? usage.cacheWriteTokens : 0
        this.lastRealPromptTokens = usage.inputTokens + read + write
        this.lastRealAnchorSeq = typeof event.seq === 'number' ? event.seq : -1
        restored = true
        break
      }
    } catch { restored = false }
    if (!restored) {
      // 新会话 / 日志无 usage：清掉可能属于上一个 session 的失效锚点。
      this.lastRealPromptTokens = 0
      this.lastRealAnchorSeq = -1
      return
    }
    this.log.info('[argp-graph] usage anchor restored from log: real prompt='
      + this.lastRealPromptTokens + ' tok at seq=' + this.lastRealAnchorSeq)
  }

  /** 生成上下文头部 catalog（设计稿 §5 + A9）：U/A/R 三类都列（R 带 type=R），snippet 截断，字符预算驱动（A9）。 */
  catalogText(maxItems = 20, snippetChars = 70, tokenBudget = 600): string {
    if (this.session === null) return ''
    const shadowed = this.shadowedSeqsOf(this.session)
    const entries: { type: AtomType; turn: number; seq: number; snippet: string }[] = []
    const charBudget = tokenBudget * this.charsPerToken
    let usedChars = 0
    for (const seq of shadowed) {
      if (entries.length >= maxItems) break
      const event = sessionEvents(this.session)[seq]
      if (event === undefined) continue
      const data = event.data as Record<string, unknown> | undefined
      let type: AtomType
      if (event.type === 'user/message') {
        type = classifyUserMessage(data)
      } else if (event.type === 'assistant/message') {
        type = 'A'
      } else if (event.type === 'tool/result') {
        type = 'R' // A9：R 补入 catalog 发现入口（N2）
      } else {
        continue
      }
      const text = eventText(this.session, seq)
      const snippet = text.split('\n').map(l => l.trim()).find(l => l !== '') ?? ''
      const clipped = snippet.length > snippetChars ? snippet.slice(0, snippetChars) + '…' : snippet
      if (usedChars + clipped.length > charBudget && entries.length > 0) break
      usedChars += clipped.length
      const turn = typeof data?.turn === 'number' ? (data.turn as number) : 0
      entries.push({ type, turn, seq, snippet: clipped })
    }
    // U 排前，其余按 seq 升序
    entries.sort((a, b) => (a.type === 'U' ? 0 : 1) - (b.type === 'U' ? 0 : 1) || a.seq - b.seq)
    const lines = entries.map(e => '[' + e.type + (e.turn !== 0 ? e.turn : '') + '] ' + e.snippet)
    if (lines.length === 0) return ''
    return '[context] Compression removed ' + shadowed.size + ' earlier item(s) from the visible context:\n' + lines.join('\n')
  }
  /** 按关键词查询被剪节点原文（设计稿 §6 的 recall(query) 简化版）。 */
  recallQuery(query: string, maxResults = 5): string {
    if (this.session === null) return 'recall: no session bound'
    const shadowed = this.shadowedSeqsOf(this.session)
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
    interface Hit { seq: number; score: number; text: string; type: AtomType; turn: number }
    const hits: Hit[] = []
    for (const seq of shadowed) {
      const event = sessionEvents(this.session)[seq]
      if (event === undefined) continue
      const data = event.data as Record<string, unknown> | undefined
      const text = eventText(this.session, seq)
      if (text === '') continue
      const lower = text.toLowerCase()
      let score = 0
      for (const term of terms) if (lower.includes(term)) score += 1
      if (score === 0) continue
      let type: AtomType
      if (event.type === 'user/message') type = classifyUserMessage(data)
      else if (event.type === 'assistant/message') type = 'A'
      else if (event.type === 'tool/result') type = 'R'
      else type = 'X'
      const turn = typeof data?.turn === 'number' ? (data.turn as number) : 0
      hits.push({ seq, score, text, type, turn })
    }
    hits.sort((a, b) => b.score - a.score || (a.type === 'U' ? -1 : b.type === 'U' ? 1 : a.seq - b.seq))
    const selected = hits.slice(0, maxResults)
    for (const h of selected) this.noteRecallHit(h.seq)
    pushBounded(this.recallQueryCalls, { query, count: selected.length, hits: selected.length }, this.telemetryCap)
    if (selected.length === 0) return 'recall: no pruned nodes match query "' + query + '"'
    const lines = selected.map(h => '[' + h.type + (h.turn !== 0 ? h.turn : '') + '] ' + h.text)
    return 'Recalled ' + selected.length + ' pruned atom(s) for "' + query + '":\n' + lines.join('\n')
  }

  /**
   * 增量维护被遮蔽 surface seq 集合：事件日志只追加，游标从上次扫描处继续，
   * 避免每次 recall/剪枝压力检查都 O(事件总量) 重扫。session 切换时重置。
   */
  private shadowedSeqsOf(session: Session): Set<number> {
    if (this.shadowedSession !== session) {
      this.shadowedSession = session
      this.shadowedSet = new Set()
      this.shadowedScanned = 0
    }
    for (let index = this.shadowedScanned; index < session.seq; index += 1) {
      const event = sessionEvents(session)[index]
      if (event === undefined) continue
      // 权威剪枝账本：只认 compaction/prune 事件（pruneIntervals 每次真剪枝必发，
      // 且 shadowedSeqs 即被剪 surface seq 的权威清单）。不再靠「replace 形态推断」：
      // 旧实现扫 surfaceOp replace 并把 sourceEventSeqs 收进集合，会误吞两类非剪枝写回——
      //   ① cites 剥离写回（data.argpCites，仅去协议产物）——2026-08-22 已加 argpCites 门控；
      //   ② per-atom 原地压缩（peratom/compressor.ts 的 user/tool 副本，start===end、
      //      sourceEventSeqs=[被压原子]、无 compaction/prune 事件）——2026-08-27 定位：
      //      它仍穿透旧门控被当「已剪」，导致 catalog 谎报 "Compression removed N"、
      //      system 前缀逐轮变、跨轮缓存全断（60 轮 A 臂实证：catalog 显示 removed 44，
      //      而 compaction/prune 事件数 = 0，44 个全是 per-atom 原地压缩）。
      // 只读 compaction/prune.shadowedSeqs 后，per-atom 原地压缩天然不在账本内，根因消除；
      // 且不再把 compaction/start、compaction/prune 这两个 off-surface 事务 seq 误收进集合。
      if (event.type === 'compaction/prune') {
        const shadowed = (event.data as { shadowedSeqs?: number[] }).shadowedSeqs
        if (Array.isArray(shadowed)) {
          for (const seq of shadowed) this.shadowedSet.add(seq)
        }
      }
    }
    this.shadowedScanned = session.seq
    return this.shadowedSet
  }

  /**
   * 程序化 recall（RecallHandle 语义）：**仅**命中被遮蔽节点，未命中返回 null。
   * 这是给宿主/测试用的窄接口，故意保留 pruned-only 语义（历史 spike 系列的
   * `engine.recall(seq) !== null` 探针依赖它判定"是否已被剪"，去门控会破坏探针）；
   * 模型侧 recall_pruned 工具已按 P1 修复 (b) 去门控并带状态标签，
   * 程序化的全日志入口是 recallAnyState()。
   */
  recall(seq: number): string | null {
    if (this.session === null) return null
    if (!this.shadowedSeqsOf(this.session).has(seq)) return null
    const text = eventText(this.session, seq)
    return text === '' ? null : text
  }

  /**
   * 全日志级 recall（P1 修复 (b) 的程序化入口）：对任意界内 seq 返回原文 + 状态标签，
   * 不要求节点属于 pruned 集合。越界返回 null。
   */
  recallAnyState(seq: number): { text: string; state: NodeStateLabel } | null {
    if (this.session === null) return null
    const shadowed = this.shadowedSeqsOf(this.session)
    const outcome = recallFromLog(this.session, seq, s => shadowed.has(s), eventText)
    if (!outcome.ok) return null
    return { text: outcome.text, state: outcome.state }
  }

  /** 单个 seq 相对可见上下文的状态（shadowed / live / off-surface）。 */
  nodeState(seq: number): NodeStateLabel | null {
    if (this.session === null) return null
    const shadowed = this.shadowedSeqsOf(this.session)
    return nodeStateOf(this.session, seq, s => shadowed.has(s))
  }

  /**
   * 原子化（§4.1）：只投影 surface 节点；U/X/R/A 四类（tool/call 不进 surface，无 T 类）。cites 统计在 A 原子处累计。
   *
   * node 0 保护（2026-09-10，dsh 0.1.5 起）：宿主把 system prompt 表示为 surface node 0 的
   * `system/message`，并在 surface.ts `assertSystemHeadRewrite` 里硬性保护——任何覆盖 node 0 的
   * replace 必须是"恰好覆盖该单节点的 system/message"，否则 throw。
   * 本函数的 switch 只认 `user/message` / `assistant/message` / `tool/result`，其余类型（含
   * `system/message`）**静默跳过、不产出原子**，因此 node 0 永远不会进入 ARGP 的剪枝区间，
   * 上述宿主断言不会被触发。**这是有意依赖，不是巧合**——若日后要支持剪系统提示，
   * 必须同时改这里与宿主契约。守护用例见 test/argp-graph-engine.test.ts
   * 「system prompt at surface node 0 is never selected for pruning」。
   */
  atomize(session: Session): Atom[] {
    const atoms: Atom[] = []
    for (const seq of session.surface.nodes) {
      const event = sessionEvents(session)[seq]
      if (event === undefined) continue
      const data = event.data as Record<string, unknown> | undefined
      const turn = typeof data?.turn === 'number' ? (data.turn as number) : 0
      if (event.type === 'user/message') {
        // P0 分类陷阱防线：先认 data[argp].info（U-info 聚合副本），再判 plugin-source → X
        const kind = classifyUserMessage(data)
        // P4：U-info 投影 sourceSeq（原始用户消息日志 seq）——既是 recall_detail 恢复
        // 目标，也是 isAtomCandidate/闭包 root 的 U-info 识别判据（dialog 无此字段）。
        const uInfoMeta = (data as Record<string, unknown> | undefined)?.[ARG_NS] as { sourceSeq?: unknown } | undefined
        const uSourceSeq = typeof uInfoMeta?.sourceSeq === 'number' ? (uInfoMeta.sourceSeq as number) : undefined
        const userAtom: Atom = { id: atoms.length, seq, type: kind, turn, text: eventText(session, seq), toolCallIds: [], cites: [], citesFailed: false }
        if (uSourceSeq !== undefined) userAtom.sourceSeq = uSourceSeq
        atoms.push(userAtom)
        continue
      }
      if (event.type === 'assistant/message') {
        const raw = eventText(session, seq)
        const stored = (data as { argpCites?: ParsedCite[] | string[] }).argpCites
        const parsed = extractCites(raw)
        // 优先用 surface 剥离时存入的 argpCites，保证跨压缩引用图不丢（文本已无 cites）。
        // ⚠ 2026-08-22 修复：判据原查 graded 字段 `c.t`，但写回格式是 ParsedCite `{text, level}`
        // （stripTrailingCitesIfNeeded 存 extractCites 的返回值）→ every 恒 false → 误走 string[]
        // 分支把对象塞进 text → buildGraph cite.text.trim() 抛 TypeError → 压缩静默失败（boundaries=0）。
        // 现按实际格式归一化，兼容 ParsedCite[] / string[]（V5 产物）/ graded {t,l}（契约原文）三种形状。
        let cites: ParsedCite[]
        if (Array.isArray(stored)) {
          cites = stored
            .map(c => {
              if (typeof c === 'string') return { text: c, level: 'supporting' as const }
              if (c !== null && typeof c === 'object') {
                const o = c as { text?: unknown; t?: unknown; level?: unknown; l?: unknown }
                const text = typeof o.text === 'string' ? o.text : typeof o.t === 'string' ? o.t : ''
                if (text === '') return null
                let level: CiteLevel = 'supporting'
                const lv = (typeof o.level === 'string' ? o.level : typeof o.l === 'string' ? o.l : '').trim().toLowerCase()
                if (lv === 'c' || lv === 'critical') level = 'critical'
                else if (lv === 'x' || lv === 'contextual') level = 'contextual'
                return { text, level }
              }
              return null
            })
            .filter((c): c is ParsedCite => c !== null)
        } else {
          cites = parsed.cites
        }
        const body = parsed.body
        const msg = (data as { message?: { content?: unknown[] } })?.message
        const content = Array.isArray(msg?.content) ? (msg?.content as { type: string; id?: string }[]) : []
        const toolCallIds = content.filter(b => b.type === 'tool-call' && typeof b.id === 'string').map(b => b.id as string)
        this.citeStats.aAtoms += 1
        if (cites.length > 0) this.citeStats.declared += cites.length
        if (parsed.parseFailed) this.citeStats.failed += 1
        atoms.push({ id: atoms.length, seq, type: 'A', turn, text: body, toolCallIds, cites, citesFailed: parsed.parseFailed })
        continue
      }
      if (event.type === 'tool/result') {
        const d = data as { message?: { source?: { callId?: string } } }
        const callId = d?.message?.source?.callId
        atoms.push({ id: atoms.length, seq, type: 'R', turn, text: eventText(session, seq), toolCallIds: callId === undefined ? [] : [callId], cites: [], citesFailed: false })
        continue
      }
    }
    return atoms
  }

  /**
   * A2 前缀长度守卫（问题 5 修订）：统一按「有效字符」折算——ASCII 1 字符、CJK/全角 2 字符，
   * effective = ascii + wide×2 < minLen（默认 4）即视为噪音前缀（"的""a""the"）→ 不参与匹配。
   * 效果："the"(3 ascii) 拒、"读书"(2 wide = 4) 放行、"the quick"(9 ascii) 放行。
   */
  private citePrefixTooShort(prefix: string): boolean {
    const minLen = this.citeMinPrefixLen
    let ascii = 0
    let wide = 0
    for (const ch of prefix) {
      if (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch)) wide += 1
      else ascii += 1
    }
    return ascii + wide * 2 < minLen
  }

  /** A5 倒排索引：prefix n-gram → atom id 候选集（n=3）。索引查询只给候选，命中须过验证谓词。 */
  private readonly ngramN = 3

  private buildNGramIndex(atoms: Atom[], extract: (a: Atom) => string): Map<string, number[]> {
    const index = new Map<string, number[]>()
    const n = this.ngramN
    for (const a of atoms) {
      const text = extract(a)
      if (text === '') continue
      const grams = new Set<string>()
      for (let i = 0; i + n <= text.length; i += 1) grams.add(text.slice(i, i + n))
      for (const g of grams) {
        const list = index.get(g)
        if (list === undefined) index.set(g, [a.id])
        else list.push(a.id)
      }
    }
    return index
  }

  /** 查询候选集：前缀长度 < n 时返回 null（走全扫描回退）。取前缀上 ≤3 个 n-gram 交集收窄候选。 */
  private queryNGramCandidates(index: Map<string, number[]>, prefix: string): number[] | null {
    const n = this.ngramN
    if (prefix.length < n) return null
    const first = prefix.slice(0, n)
    const firstList = index.get(first)
    if (firstList === undefined) return []
    const candidates = new Set<number>(firstList)
    const starts = [Math.floor((prefix.length - n) / 2), prefix.length - n]
    for (const start of starts) {
      if (start === 0) continue
      const g = prefix.slice(start, start + n)
      const list = index.get(g)
      if (list === undefined) return []
      const set = new Set(list)
      for (const id of [...candidates]) {
        if (!set.has(id)) candidates.delete(id)
      }
      if (candidates.size === 0) return []
    }
    return [...candidates]
  }

  /**
   * 建图（§4.2 + §4.7 + A1/A2/A5）：确定性边不计级别；cites 子串匹配生成语义边，
   * 级别取声明级别（V6 契约，裸字符串默认 supporting；critical 参与闭包守卫不变量 2′）。
   * A5：3-gram 倒排索引候选（先精确 n-gram 命中，再子串验证）；前缀过短自动全扫描回退。
   * 歧义消解增强（A2）：命中集内 U 优先 → 最长公共前缀最深的原子优先 → 最早 seq。
   * 前缀长度守卫：过短前缀不计 declared 也不建边。
   */
  buildGraph(atoms: Atom[]): { edges: SemanticEdge[]; deterministicEdges: DeterministicEdge[]; inDegree: Map<number, number> } {
    const edges: SemanticEdge[] = []
    const deterministicEdges: DeterministicEdge[] = []
    const rByCall = new Map<string, Atom>()
    for (const r of atoms) if (r.type === 'R' && r.toolCallIds[0] !== undefined) rByCall.set(r.toolCallIds[0], r)
    for (const a of atoms) {
      if (a.type !== 'A') continue
      for (const cid of a.toolCallIds) {
        const r = rByCall.get(cid)
        if (r !== undefined) deterministicEdges.push({ from: a.id, to: r.id })
      }
    }
    // A5：整文本 n-gram 索引（子串命中）+ 行首 n-gram 索引（行首精确命中，A2 增强回退）
    const textIndex = this.buildNGramIndex(atoms, a => a.text)
    const lineIndex = this.buildNGramIndex(atoms, a => a.text.split('\n').map(l => l.trim()).filter(l => l !== '').join('\n'))
    const resolveHits = (prefix: string, index: Map<string, number[]>, verify: (t: Atom) => boolean): Atom[] => {
      const candidates = this.queryNGramCandidates(index, prefix)
      const pool = candidates === null
        ? atoms
        : candidates.map(id => atoms.find(a => a.id === id)).filter((a): a is Atom => a !== undefined)
      return pool.filter(verify)
    }
    if (!this.disableCiteEdges) for (const a of atoms) {
      if (a.type !== 'A') continue
      for (const cite of a.cites) {
        // 兜底防御（2026-08-22）：cites 来自模型不可信输入 + argpCites 历史格式迁移，
        // 任何非字符串 text 一律视为无效声明跳过，绝不让压缩主体抛错。
        if (typeof cite.text !== 'string') {
          this.citeStats.failed += 1
          continue
        }
        const p = cite.text.trim()
        if (p === '') continue
        if (this.citePrefixTooShort(p)) {
          this.citeStats.failed += 1 // 过短前缀视为声明失败（保守保护，不建边）
          continue
        }
        const selfExcluded = (t: Atom): boolean => t.id !== a.id && t.text !== ''
        // 先精确（行首）后子串：行首命中更贴引用意图，其次整文子串（spike 5 教训：includes 兜底）
        let hits = resolveHits(p, lineIndex, t => selfExcluded(t) && t.text.split('\n').some(line => line.trim().startsWith(p)))
        if (hits.length === 0) {
          hits = resolveHits(p, textIndex, t => selfExcluded(t) && t.text.includes(p))
        }
        if (hits.length === 0) continue
        let target = hits[0]
        if (hits.length > 1) {
          this.citeStats.ambiguous += 1
          const uHit = hits.find(h => h.type === 'U')
          if (uHit !== undefined) {
            target = uHit
          } else {
            // A2：最长公共前缀最深的原子优先（引用意图最接近），同深度取最早 seq
            const depth = (h: Atom): number => {
              let i = 0
              while (i < p.length && i < h.text.length && h.text[i] === p[i]) i += 1
              return i
            }
            target = hits.reduce((min, h) => (depth(h) > depth(min) || (depth(h) === depth(min) && h.seq < min.seq) ? h : min), hits[0] as Atom)
          }
        }
        edges.push({ from: a.id, to: target.id, level: cite.level })
        this.citeStats.resolved += 1
      }
    }
    // 边价值实验 A₃：合并注入的 oracle 边（离线辅助 LLM 组图）。校验 from/to 合法且非自环。
    // 去重（2026-08-29，citesObligation 退役回复协议后）：模型残留 cites 尾仍会被
    // 上方解析建边，declarer 可能对同一 (from,to) 声明同一条边——只保留先到者
    // （回复级逐字前缀是最强证据），防 inDegree 双计污染判决与守卫计数。
    if (this.injectEdges !== undefined) {
      const validIds = new Set(atoms.map(a => a.id))
      const seen = new Set(edges.map(e => `${e.from}\u0000${e.to}`))
      for (const e of this.injectEdges(atoms)) {
        if (e.from === e.to || !validIds.has(e.from) || !validIds.has(e.to)) continue
        const key = `${e.from}\u0000${e.to}`
        if (seen.has(key)) continue
        seen.add(key)
        edges.push(e)
      }
    }
    // v1.2.0 组件 A（PROPOSAL-token-ontology）：推断边——承重 token 逐字包含派生
    // （0 LLM，I-A1 构造性；停词过滤/每 A 上限/声明窗口见 token-ontology.ts）。
    // 在 cites / injectEdges 之后合并 → 声明边先行（同 (from,to) 先到者胜，与 inject
    // 去重同纪律）；A₁ 臂（disableCiteEdges）一并隔离，保零语义边实验语义。
    this.lastInferredEdges = []
    if (!this.disableCiteEdges && !this.disableInferredEdges) {
      const pairs = deriveInferredEdges(atoms, this.inferredOpts)
      this.inferredStats.candidates = pairs.length
      const seqToId = new Map<number, number>()
      for (const a of atoms) seqToId.set(a.seq, a.id)
      const seenInferred = new Set(edges.map(e => `${e.from}\u0000${e.to}`))
      let accepted = 0
      let skippedDup = 0
      for (const p of pairs) {
        const from = seqToId.get(p.fromSeq)
        const to = seqToId.get(p.toSeq)
        if (from === undefined || to === undefined) continue
        if (from === to) continue // 防御：seq→id 映射异常（如重复 id）不得产出自环
        const key = `${from}\u0000${to}`
        if (seenInferred.has(key)) { skippedDup += 1; continue }
        seenInferred.add(key)
        edges.push({ from, to, level: 'inferred' })
        this.lastInferredEdges.push({ from, to, level: 'inferred' })
        accepted += 1
      }
      this.inferredStats.accepted = accepted
      this.inferredStats.skippedDup = skippedDup
    }
    this.lastEdges = edges
    this.lastDeterministicEdges = deterministicEdges
    const inDegree = new Map<number, number>()
    for (const e of edges) inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1)
    return { edges, deterministicEdges, inDegree }
  }
  /** surface 可见字符总量（与 spike 4 同基准）。 */
  private visibleChars(session: Session): number {
    let total = 0
    for (const seq of session.surface.nodes) total += eventText(session, seq).length
    return total
  }

  /** 测量当前上下文 token。优先「真实 usage 锚点 + 增量估算」（2026-08-23，
   *  替代 tokenMeter chars/4 低估导致的迟触发/窗口保护失效）；无锚点才回退
   *  dsh tokenMeter / 配置函数 / 字符估算。source 标注估计来源（2026-08-29：
   *  压力日志与实验审计需要区分 anchored 真值路径与启发式回退路径）。
   *  `extraTokens`（1.4.0）：本步**已 claim 但尚未落盘**的 user 消息估值。轮初它既不在
   *  surface 里、也不在锚点覆盖范围内，漏掉就等于漏算"这一轮的启动量"——而用户恰恰
   *  常在轮初粘贴大段文本，正是 1.3.x 轮初估值偏低的直接原因。 */
  private measureTokens(session: Session, extraTokens = 0): { contextTokens: number; surfaceTokens: number; source: 'anchored' | 'tokenMeter' | 'config' | 'chars' } {
    const surfaceTokens = Math.ceil(this.visibleChars(session) / this.charsPerToken)
    if (this.lastRealAnchorSeq >= 0 && this.lastRealPromptTokens > 0) {
      // 真实锚点（上轮 provider usage）只覆盖锚点 seq 之前的内容；其后 surface 新增
      // 节点（user/assistant/tool 事件）按字符估算增量。增量通常远小于全量，估算偏差
      // 只作用于增量 → 总误差从 ±30% 降到几个百分点。已知局限（均为保守或单步窗口）：
      // ① peratom 替换旧节点（seq ≤ 锚点）减量不计 → 高估 → 剪早（保守方向）；
      // ② 压缩换代后锚点重置为纯 surface 估算（不含 system+tools）→ 低估一个 step，
      //    下一次 assistant/message usage 回到精确锚定。
      let deltaChars = 0
      for (const seq of session.surface.nodes) {
        if (seq > this.lastRealAnchorSeq) deltaChars += eventText(session, seq).length
      }
      const deltaTokens = Math.ceil(deltaChars / this.charsPerToken)
      return { contextTokens: this.lastRealPromptTokens + deltaTokens + extraTokens, surfaceTokens, source: 'anchored' }
    }
    if (this.tokenMeter !== undefined) {
      try {
        const m = this.tokenMeter.measure(session)
        return { contextTokens: m.totalTokens + extraTokens, surfaceTokens: m.surfaceTokens, source: 'tokenMeter' }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        this.log.warn('[argp-graph] tokenMeter.measure failed, falling back: ' + message)
      }
    }
    if (this.tokenMeterFn !== undefined) {
      const measured = this.tokenMeterFn(session)
      return { ...measured, contextTokens: measured.contextTokens + extraTokens, source: 'config' }
    }
    return { contextTokens: surfaceTokens + extraTokens, surfaceTokens, source: 'chars' }
  }

  /**
   * 本步已 claiming（尚未落盘进 surface）的 user 消息估值：字符数 ÷ charsPerToken。
   * 与 `measureTokens` 的增量口径同基准（同一 charsPerToken），可直接相加。
   */
  private incomingTokens(messages: readonly unknown[]): number {
    let chars = 0
    for (const message of messages) {
      const content = (message as { content?: unknown }).content
      if (!Array.isArray(content)) continue
      for (const block of content) {
        const b = block as { text?: unknown; content?: unknown }
        if (typeof b.text === 'string') chars += b.text.length
        if (!Array.isArray(b.content)) continue
        for (const inner of b.content) {
          const t = (inner as { text?: unknown }).text
          if (typeof t === 'string') chars += t.length
        }
      }
    }
    return chars === 0 ? 0 : Math.ceil(chars / this.charsPerToken)
  }

  /** A4 行级重叠相似度：sim=|A∩B|/min(|A|,|B|)（行集合）。 */
  private static lineOverlap(a: string, b: string): number {
    const linesA = new Set(a.split('\n').map(l => l.trim()).filter(l => l !== ''))
    const linesB = new Set(b.split('\n').map(l => l.trim()).filter(l => l !== ''))
    const min = Math.min(linesA.size, linesB.size)
    if (min === 0) return 0
    let inter = 0
    for (const l of linesA) if (linesB.has(l)) inter += 1
    return inter / min
  }

  /**
   * §4.4 版本链去重（+ A3 N1 bug fix + A4 θ 重叠归链）：
   *  - A：文本全等（不变）。
   *  - R：按「issuer A 的 tool name + arguments JSON」去重（而非旧版 issuer?.text.trim()），
   *    解决「同措辞不同工具调用（如不同参数 read different files）被错误归链去重」的问题。
   *    回退：issuer 不存在时用 r.text（callId 缺失的最小退化）。
   *  - A4：enableOverlapChain 时，R 文本行重叠 sim ≥ θ（默认 0.8）也归入同一版本链
   *    （read→edit→read 等高频工具迭代）；A 文本仍走全等。
   * 返回 { dupIds, chainLen }：chainLen 记录每个存活代表（newer）的链长，供 density-chain 叠加 eff。
   */
  private findVersionDuplicates(atoms: Atom[], inDegree: Map<number, number>): { dupIds: Set<number>; chainLen: Map<number, number>; latestRByKey: Map<string, number>; rKeyByRId: Map<number, string> } {
    const dupIds = new Set<number>()
    const chainLen = new Map<number, number>()
    const latestRByKey = new Map<string, number>()
    const rKeyByRId = new Map<number, string>()
    const issuerByCall = new Map<string, Atom>()
    const rByCall = new Map<string, Atom>()
    for (const a of atoms) {
      if (a.type !== 'A') continue
      for (const cid of a.toolCallIds) issuerByCall.set(cid, a)
    }
    for (const r of atoms) {
      if (r.type !== 'R' || r.toolCallIds[0] === undefined) continue
      rByCall.set(r.toolCallIds[0], r)
    }
    const addPair = (a: Atom): void => {
      if ((inDegree.get(a.id) ?? 0) !== 0) return
      // 方案 A 修复（2026-08-23）：剪 A 时无条件连带剪其全部 R，与 pass 循环（:1693 附近）语义一致。
      // 版本去重语义 = 旧快照整组淘汰；R 的 cites 引用在 newer 版本上会重建，旧 R 与引用一起剪。
      // 不保护被 cites 的旧 R（否则 surface 膨胀、版本链去重失效）；无孤儿由连带剪保证。
      dupIds.add(a.id)
      for (const cid of a.toolCallIds) {
        const r = rByCall.get(cid)
        if (r !== undefined) dupIds.add(r.id)
      }
    }
    const seenA = new Map<string, { atom: Atom; count: number }>()
    for (const a of atoms.filter(x => x.type === 'A')) {
      const key = a.text.trim()
      const existing = seenA.get(key)
      if (existing !== undefined) {
        const older = existing.atom.turn < a.turn || (existing.atom.turn === a.turn && existing.atom.seq < a.seq) ? existing.atom : a
        const newer = older === existing.atom ? a : existing.atom
        if ((inDegree.get(older.id) ?? 0) === 0) addPair(older)
        const count = existing.count + 1
        chainLen.set(newer.id, count)
        seenA.set(key, { atom: newer, count })
      } else {
        seenA.set(key, { atom: a, count: 1 })
      }
    }
    const seenR = new Map<string, { atom: Atom }[]>()
    const rKey = (r: Atom): string => {
      // A3 N1 fix：R 去重键 = issuer A 的 tool name + arguments JSON（callId 缺失时退化为 r.text）
      const issuer = r.toolCallIds[0] !== undefined ? issuerByCall.get(r.toolCallIds[0]) : undefined
      if (issuer === undefined) return 'text|' + r.text.trim()
      const issuerEvent = this.session === null ? undefined : sessionEvents(this.session)[issuer.seq]
      const content = (issuerEvent?.data as { message?: { content?: unknown[] } } | undefined)
        ?.message?.content as Array<{ type?: string; id?: string; name?: string; arguments?: unknown }> | undefined
      const tc = content?.find(b => b.type === 'tool-call' && b.id === r.toolCallIds[0])
      const argsStr = tc !== undefined && tc.arguments !== undefined
        ? (typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments))
        : ''
      return (tc?.name ?? '?') + '|' + argsStr
    }
    const registerR = (key: string, r: Atom): void => {
      const list = seenR.get(key)
      if (list === undefined) seenR.set(key, [{ atom: r }])
      else list.push({ atom: r })
      latestRByKey.set(key, r.seq)
      rKeyByRId.set(r.id, key)
    }
    const mergeOlderR = (older: Atom, r: Atom, key: string): void => {
      if ((inDegree.get(older.id) ?? 0) === 0) {
        dupIds.add(older.id)
        const issuer = older.toolCallIds[0] !== undefined ? issuerByCall.get(older.toolCallIds[0]) : undefined
        if (issuer !== undefined) addPair(issuer)
      }
      // A4 问题 4 修订：chainLen = 合并后组成员数（list.length），而非「已合并条目数+1」的
      // cur.count 累加——后者在同一 atom 已入 list 时重复多计（如 3 副本 R 链混入 issuer A 计数）。
      // 先 push 再取 list.length：3 个相同 R → 第一次 register len=1，随后两次 merge 各 push → len=2/3。
      const list = seenR.get(key)
      if (list === undefined) {
        seenR.set(key, [{ atom: r }])
        chainLen.set(r.id, 1)
      } else {
        list.push({ atom: r })
        chainLen.set(r.id, list.length)
      }
      // 版本链重定向：记录该 key 下最新见到的 R seq（遍历按 surface 顺序，后续 seq 更大更「新」）
      latestRByKey.set(key, r.seq)
      rKeyByRId.set(older.id, key)
      rKeyByRId.set(r.id, key)
    }
    for (const r of atoms.filter(x => x.type === 'R')) {
      const key = rKey(r)
      const group = seenR.get(key)
      const exact = group?.find(e => e.atom.text === r.text)
      if (exact !== undefined) {
        const older = exact.atom.turn < r.turn || (exact.atom.turn === r.turn && exact.atom.seq < r.seq) ? exact.atom : r
        const newer = older === exact.atom ? r : exact.atom
        if (older !== newer) {
          mergeOlderR(older, newer, key)
          exact.atom = newer
        }
        continue
      }
      if (this.enableOverlapChain && group !== undefined) {
        const sims = group.map(e => ArgpGraphEngine.lineOverlap(e.atom.text, r.text))
        const best = sims.reduce((m, s, i) => (s > sims[m] ? i : m), 0)
        if (sims[best] !== undefined && sims[best] >= this.overlapTheta) {
          const older = group[best]?.atom as Atom
          mergeOlderR(older, r, key)
          continue
        }
      }
      registerR(key, r)
    }
    return { dupIds, chainLen, latestRByKey, rKeyByRId }
  }

  /**
   * 当前最大 turn 号（recall 回拉防抖窗口 / 闭包保护窗口共用口径）。
   *
   * P4 修复：旧实现遍历 **全部 events** 取 max，把 turn/start、注入型 system-reminder
   * 等非 surface 事件也算进来，与 compactIfNeeded（含内联闭包降级链）用的
   * "atoms（surface 节点）最大 turn" 口径不一致 —— 同一个防抖判定两端基准不同。
   * 现统一为 surface 节点口径；turnBasis='semantic'（默认）时进一步排除注入型 X 节点，
   * 使纯注入不推进轮次、不抬高 latestTurn-k 保护线。
   */
  latestTurnOf(session: Session): number {
    let max = 0
    for (const seq of session.surface.nodes) {
      const event = sessionEvents(session)[seq]
      if (event === undefined) continue
      const data = event.data as Record<string, unknown> | undefined
      if (this.turnBasis === 'semantic' && event.type === 'user/message'
        && classifyUserMessage(data) === 'X') {
        continue // 注入型 X（system-reminder / ARGP tombstone）不推进语义轮次；
        // U-info 聚合副本（classifyUserMessage → U）是真实用户内容的替换拷贝，照常参与——
        // 若被跳过，被拆分消息所在轮会漏报 latestTurn，recency/turnGuard 保护线随之偏移。
      }
      const t = data?.turn
      if (typeof t === 'number' && t > max) max = t
    }
    return max
  }

  private latestTurnOfSession(): number {
    if (this.session === null) return 0
    return this.latestTurnOf(this.session)
  }

  /**
   * recall 命中被剪闭包内节点时，将该闭包拉回 ACTIVE 并记下防抖轮。
   *
   * P2 修复：防抖 key 从 closureId 改为 rootSeq。closureId 由 `nextClosureId++` 生成，
   * selectClosureToMerge 每 pass 都给所有 root 重发新 id，导致此处写入的旧 id 与
   * 剪枝决策处读取的新 id 永不相等 → `continue` 防抖分支永不触发 → 刚 recall 回来的
   * 闭包下一 pass 又被剪。rootSeq 跨 pass 稳定，是闭包的天然身份。
   */
  private noteRecallHit(seq: number): void {
    for (const c of this.closurePrunes) {
      if (c.prunedSeqs.includes(seq)) {
        this.closureLastRecalled.set(c.rootSeq, this.latestTurnOfSession())
        break
      }
    }
  }

  /**
   * recall 预算：单次结果与累计结果都按窗口比例截断（窗口取最近解析的有效预算）。
   *
   * P7 修复：recallCharsUsed 原本只增不减、全会话无 reset —— 累计触顶后 allowed=0，
   * 返回值退化成纯 '…(truncated)' 且不说明原因，长会话静默丢 recall。现在
   *  1) 预算耗尽时显式说明剩余额度与何时恢复（不再静默）；
   *  2) 每笔 compaction 事务成功后归零（见 pruneIntervals 末尾）。
   */
  private budgetRecallText(text: string): string {
    const perCallLimit = Math.floor(this.resolvedWindowTokens * 0.05 * this.charsPerToken)
    const totalLimit = Math.floor(this.resolvedWindowTokens * 0.10 * this.charsPerToken)
    const remaining = Math.max(0, totalLimit - this.recallCharsUsed)
    if (remaining === 0) {
      return '(recall text budget exhausted: ' + this.recallCharsUsed + '/' + totalLimit
        + ' chars used since the last compaction. Nothing was returned — this is a budget limit, '
        + 'not missing data. The budget resets on the next compaction; narrow the request or retry later.)'
    }
    const allowed = Math.min(perCallLimit, remaining)
    let result = text
    if (result.length > allowed) {
      result = result.slice(0, allowed) + '…(truncated at ' + allowed + ' chars; recall budget '
        + (this.recallCharsUsed + allowed) + '/' + totalLimit
        + ' chars used since the last compaction, resets on the next one)'
    }
    this.recallCharsUsed += result.length
    return result
  }

  /**
   * A6（保守选项 a）：summarize 末环不实现 —— 保持默认关闭（enableSummarize=false）、
   * force_prune 为终端降级，文档明确。本 stub 恒返回 null，degradationStrategy='summarize'
   * 且 enableSummarize=true 时也不会产出 LLM 摘要；实际路径仍为 lifecycle → force。
   */
  private summarizeCriticalChain(
    _session: Session,
    _atoms: Atom[],
    _edges: SemanticEdge[],
    _latestTurn: number,
  ): CompactionResult | null {
    return null
  }

  /** P2 选择侧（2026-08-22 拆出）：选一个 PRUNABLE 闭包并返回其原子/区间，不执行剪枝。
   *  `alreadyPruned` 用于排除已由正常候选/版本重复剪过的原子——修复前独立闭包事务
   *  按整闭包（含已剪原子）独立剪枝并 return，导致正常候选成果被丢弃；现改为"选择并入
   *  pruned、统一事务剪"（compactIfNeeded 降级链内联），闭包原子需与已剪集合去重
   *  （如 A1/A2 已正常剪 → 闭包仅剩 root U，单独退休 root U 是有意设计：P5 注释
   *  "自动闭包生命周期确实会连 root U 一起剪除"）。 */
  private selectClosureToMerge(
    session: Session,
    atoms: Atom[],
    edges: SemanticEdge[],
    inDegree: Map<number, number>,
    askCover: Map<number, number>,
    latestTurn: number,
    alreadyPruned: Set<number>,
  ): {
    closureId: string
    root: Atom
    rootPreview: string
    /** 闭包全量 seq（含已由正常候选剪过的原子）——closurePrunes 记录用（noteRecallHit 反查 rootSeq）。 */
    seqs: number[]
    /** 本事务实际并入 pruned 的原子（过滤 alreadyPruned）。 */
    atoms: Atom[]
    intervals: { seqs: number[]; chars: number; atoms: Atom[] }[]
  } | null {
    const roots = atoms
      .filter(a => a.type === 'U' && a.sourceSeq === undefined && !askCover.has(a.id))
      // P4：排除 U-info 作 root——U-info 是"可丢弃可召回"的资料副本，不是开启新
      // 任务的 task-init 根。若不排除，闭包生命周期会以 U-info 为根把其后整段
      // dialog/A/R 拖进闭包退休（语义错误）。普通 U（dialog）仍为合法根。
      .sort((a, b) => a.seq - b.seq)
    if (roots.length === 0) return null
    const closureOf = new Map<number, string>()
    const rootByClosure = new Map<string, Atom>()
    for (let i = 0; i < roots.length; i += 1) {
      const root = roots[i]
      const nextRoot = roots[i + 1]
      const id = 'closure-' + (this.nextClosureId++)
      rootByClosure.set(id, root)
      for (const a of atoms) {
        if (a.type === 'U' && a.id !== root.id) continue
        if (a.seq >= root.seq && (nextRoot === undefined || a.seq < nextRoot.seq)) {
          closureOf.set(a.id, id)
        }
      }
    }
    const lastRefByClosure = new Map<string, number>()
    const inDegreeByClosure = new Map<string, number>()
    const atomById = new Map(atoms.map(a => [a.id, a]))
    for (const e of edges) {
      const fromClosure = closureOf.get(e.from)
      const toClosure = closureOf.get(e.to)
      const from = atomById.get(e.from)
      if (from !== undefined && toClosure !== undefined) {
        const ref = from.turn
        lastRefByClosure.set(toClosure, Math.max(lastRefByClosure.get(toClosure) ?? 0, ref))
      }
      if (fromClosure !== undefined && toClosure !== undefined && fromClosure !== toClosure) {
        // A1 不变量 2′：仅 external **critical** 边计入闭包守卫入度
        if (e.level === 'critical') {
          inDegreeByClosure.set(toClosure, (inDegreeByClosure.get(toClosure) ?? 0) + 1)
        }
      }
    }
    const k = this.closureWindowK
    const candidates: { id: string; root: Atom; lastRef: number; seqs: number[]; prunableSeqs: number[] }[] = []
    const lastRootSeq = roots.length > 0 ? roots[roots.length - 1]?.seq : -1
    for (const [id, root] of rootByClosure) {
      if (root.seq === lastRootSeq) continue
      const lastRecalled = this.closureLastRecalled.get(root.seq)
      if (lastRecalled !== undefined && latestTurn - lastRecalled < k) continue
      const lastRef = lastRefByClosure.get(id) ?? 0
      if (lastRef > latestTurn - k) continue
      if ((inDegreeByClosure.get(id) ?? 0) > 0) continue
      const seqs = atoms.filter(a => closureOf.get(a.id) === id).map(a => a.seq).sort((x, y) => x - y)
      if (seqs.length === 0) continue
      // 过滤已剪原子：只剩已剪原子的闭包无可剪内容，不选；prunable 用于 intervals，seqs 全量用于记录
      const prunableSeqs = seqs.filter(s => !alreadyPruned.has(s))
      if (prunableSeqs.length === 0) continue
      candidates.push({ id, root, lastRef, seqs, prunableSeqs })
    }
    if (candidates.length === 0) return null
    candidates.sort((a, b) => a.lastRef - b.lastRef || a.root.seq - b.root.seq)
    const chosen = candidates[0]
    if (chosen === undefined) return null
    const surfaceSeqs = session.surface.nodes
    const position = new Map<number, number>(surfaceSeqs.map((seq, i) => [seq, i]))
    const chosenSet = new Set(chosen.prunableSeqs)
    const bySeq = new Map(atoms.map(a => [a.seq, a]))
    const intervals: { seqs: number[]; chars: number; atoms: Atom[] }[] = []
    let current: number[] = []
    for (const seq of surfaceSeqs) {
      if (!chosenSet.has(seq)) {
        if (current.length > 0) {
          const intervalAtoms = current.map(s => bySeq.get(s)).filter((a): a is Atom => a !== undefined)
          const chars = intervalAtoms.reduce((sum, a) => sum + a.text.length, 0)
          intervals.push({ seqs: current, chars, atoms: intervalAtoms })
          current = []
        }
        continue
      }
      current.push(seq)
    }
    if (current.length > 0) {
      const intervalAtoms = current.map(s => bySeq.get(s)).filter((a): a is Atom => a !== undefined)
      const chars = intervalAtoms.reduce((sum, a) => sum + a.text.length, 0)
      intervals.push({ seqs: current, chars, atoms: intervalAtoms })
    }
    if (intervals.length === 0) return null
    const chosenAtoms = chosen.prunableSeqs
      .map(s => bySeq.get(s))
      .filter((a): a is Atom => a !== undefined)
    const rootPreview = chosen.root.text.split('\n').map(l => l.trim()).find(l => l !== '') ?? ''
    return {
      closureId: chosen.id,
      root: chosen.root,
      rootPreview,
      seqs: chosen.seqs,
      atoms: chosenAtoms,
      intervals,
    }
  }

  // 2026-09-21（P5 Wave 3 第 3 步）：原独立闭包事务方法删除（生产零调用、仅测试引用；
  // 注释自认 2026-08-22 起已被内联）——其选择逻辑即 selectClosureToMerge，执行语义已内联进
  // compactIfNeeded 降级链（候选耗尽 → 闭包并入 pruned → 统一 pruneIntervals 事务剪）。

/**
 * 预算解析：显式配置用显式值；否则从适配器声明的 contextWindow 按比例推导——
 *  windowTokens = contextWindow × windowRatio（默认 0.8），retainTokens = windowTokens × retainRatio（默认 0.2）。
 *  上下文容量由其他插件（模型适配器声明）决定，本引擎不硬编码。
 *  解析顺序：1) session.requestContext()（request/context 事件，真会话最可靠）；
 *           2) llm.resolveModelInfo(provider, model)；3) 静态默认值。
 */
  private async resolveScaledBudgets(
    agent: CompactionAgentContext,
  ): Promise<{ windowTokens: number; retainTokens: number; declaredKnown: boolean }> {
    const explicitWindow = this.explicitWindowTokens ? this.windowTokens : undefined
    const explicitRetain = this.explicitRetainTokens ? this.retainTokens : undefined
    let contextWindow: number | undefined
    // 1) 真会话中 request/context 事件会写入 session.requestContext()，优先读取。
    try {
      const reqCtx = (agent.session as unknown as { requestContext?: () => { contextWindow?: number } | undefined }).requestContext?.()
      if (reqCtx?.contextWindow !== undefined && reqCtx.contextWindow > 0) {
        contextWindow = reqCtx.contextWindow
      }
    } catch {
      contextWindow = undefined
    }
    // 1.5) 声明窗口缓存（request/context 事件的 WeakMap 副本）：覆盖 requestContext()
    // 尚未落账但事件已流经的时序（pre-step 检查早于首个请求的落账窗口）。
    if (contextWindow === undefined) {
      const cached = this.declaredContextWindows.get(agent.session)
      if (cached !== undefined && cached > 0) contextWindow = cached
    }
    // 2) fallback 到 llm.resolveModelInfo（旧路径/测试路径）。
    if (contextWindow === undefined) {
      try {
        const provider = agent.options?.provider
        const model = agent.options?.model
        const llm = (this as unknown as { ctx: Context }).ctx.get('llm') as
          | { resolveModelInfo?: (p: string, m: string, s: AbortSignal) => Promise<{ context?: { contextWindow?: number } }> }
          | undefined
        if (llm?.resolveModelInfo !== undefined && provider !== undefined && model !== undefined) {
          // P1.3（2026-09-21）：旧代码用 new AbortController().signal 但该 controller 从未被
          // abort——LLM 服务挂起时这个 await 无限阻塞 pre-step（外层 try/catch 只对 rejection
          // 生效，对 hang 无效）。5s 超时把 hang 转成 rejection，落入既有 contextWindow=
          // undefined 降级（declaredKnown=false 路径，宁缺勿错）。
          const ac = new AbortController()
          const t = setTimeout(() => ac.abort(), 5000)
          try {
            const info = await llm.resolveModelInfo(provider, model, ac.signal)
            contextWindow = info.context?.contextWindow
          } finally {
            clearTimeout(t)
          }
        }
      } catch {
        contextWindow = undefined
      }
    }
    // 3) 声明值完全未知（新会话首个 pre-step，且探测路径不可信/缺失）：标记
    // declaredKnown=false，宁缺勿错——物理窗口口径（llama.cpp n_ctx）会让阈值放大
    // 7×+，形同禁用。显式配置 windowTokens 的场景不依赖声明值，不受影响。
    const declaredKnown = explicitWindow !== undefined
      || (contextWindow !== undefined && contextWindow > 0)
    if (!declaredKnown) {
      this.log.info('[argp-graph] declared contextWindow not yet known; early pressure checks will skip until the first request/context lands')
    }
    const scaled = scaleBudgets(contextWindow, {
      explicitWindow, explicitRetain,
      windowRatio: this.windowRatio, retainRatio: this.retainRatio,
      fallbackWindow: this.windowTokens, fallbackRetain: this.retainTokens,
    })
    this.resolvedWindowTokens = scaled.windowTokens
    return { ...scaled, declaredKnown }
  }

  /**
   * tombstone 归并（v1.2.x §11.8① 修复）。扫描 surface，找**连续**的「可合并墓碑」X 段
   * （user/message + isMergeableTombstone 文本），段长 ≥ tombstoneMergeMinRun 时一笔事务
   * replace 成单条聚合墓碑（列出原 tombstone seqs → 原文仍 recall_pruned(seq) 可取回）。
   * 复用 pruneIntervals 事务骨架（含 shadow-price 契约、summary、锚点重置）。
   * 每 pass 至多一段——失败回退范围清晰。返回被归并的墓碑节点数（0 = 无可归并）。
   * tool 占位墓碑（type=tool）与 system-reminder / 官方 checkpoint（不含 pruned by ARGP）
   * 均被 isMergeableTombstone / 事件类型过滤挡住，不会被吞。
   */
  private consolidateTombstones(session: Session): number {
    if (this.tombstoneMergeMinRun <= 0) return 0
    const nodes = [...session.surface.nodes]
    // 1) 收集每个 surface 节点的「可合并墓碑」布尔
    const isTomb: boolean[] = new Array(nodes.length)
    for (let i = 0; i < nodes.length; i += 1) {
      const seq = nodes[i]
      const ev = sessionEvents(session)[seq]
      if (ev === undefined || ev.type !== 'user/message') { isTomb[i] = false; continue }
      if (classifyUserMessage(ev.data) !== 'X') { isTomb[i] = false; continue }
      isTomb[i] = isMergeableTombstone(eventText(session, seq))
    }
    // 2) 找第一段长度 ≥ minRun 的连续墓碑
    const minRun = this.tombstoneMergeMinRun
    let runStart = -1, runEnd = -1
    for (let i = 0; i <= nodes.length; i += 1) {
      const inRun = i < nodes.length && isTomb[i]
      if (inRun) { if (runStart === -1) runStart = i }
      else if (runStart !== -1) {
        const len = i - runStart
        if (len >= minRun) { runEnd = i - 1; break }
        runStart = -1
      }
    }
    if (runStart === -1 || runEnd === -1) return 0
    // 3) 校验事务边界 tool-pairing 平衡（与 compactRegion 同判据），不平衡则放弃归并
    if (!toolPairingBalancedBefore(session, nodes[runStart]!) || !toolPairingBalancedAfter(session, nodes[runEnd]!)) {
      this.log.info('[argp-graph] tombstone-merge: boundary not tool-pairing balanced, skip')
      return 0
    }
    const tombSeqs = nodes.slice(runStart, runEnd + 1) as number[]
    const tombAtoms: Atom[] = tombSeqs.map(seq => ({
      id: -1, seq, type: 'X' as AtomType, turn: 0,
      text: eventText(session, seq), toolCallIds: [], cites: [], citesFailed: false,
    }))
    const chars = tombAtoms.reduce((s, a) => s + a.text.length, 0)
    const interval = { seqs: tombSeqs, chars, atoms: tombAtoms }
    // 聚合墓碑文本：保持「[elided … pruned by ARGP … recall_pruned」形态（自身可再归并，
    // 地板随压缩次数收敛到常数；seq 跨度显式保留，被吞聚合的内部 seq 可递归 recall）。
    const aggText = '[elided consolidated ×' + tombSeqs.length + ' seqs=' + tombSeqs[0] + '..' + tombSeqs[tombSeqs.length - 1]
      + ': these placeholder nodes were themselves pruned by ARGP (tombstone-merge, §11.8); originals remain recallable via recall_pruned(seq) / list_pruned]'
    try {
      this.pruneIntervals(session, [interval], 0, 0, true, [{ type: 'user', text: aggText }], 'tombstone-merge')
    } catch (error: unknown) {
      // 归并是「优化地板」的尽力步骤，失败不阻断主图剪（回退：墓碑继续累积，由 overflow 三步序列兜底）
      this.log.warn('[argp-graph] tombstone-merge failed (non-fatal): ' + (error instanceof Error ? error.message : String(error)))
      return 0
    }
    return tombSeqs.length
  }

  /**
   * 压力剪枝（§4.3/§4.5）：估算量 ≥ windowTokens 时重建图，按排序键逐弱剪至 ≤ retainTokens。
   * 候选：A/T/R、语义入度 0、非近因豁免区、非最新轮、非保守保护；普通 U 仅 ask-exempt 参剪，
   * X（墓碑/checkpoint）不参剪——但墓碑地板由 §11.8① tombstone-merge 在图剪前归并（见 consolidateTombstones）。
   * 排序键（§4.5）：最低关联语义级别升 → effective_importance 升 → lastRefRound 升 → seq 升。
   * 候选耗尽仍超预算 → force_prune（忽略入度，§4.6.2）。
   *
   * trigger='context-overflow'（官方溢出恢复，见 agent/request-error 钩子）：
   * 模型请求已被 provider 确认超出上下文（400 exceed_context_size_error）——估算量
   * 可能与实际请求偏差（估算低于触发线但请求已撞墙），此时**跳过 pressure 门槛强制
   * 剪枝**，剪到 retain 目标（≈1/5 窗口，远低于 n_ctx）后由钩子重发请求。
   */
  /**
   * P6 轮内压力判定（与 compactIfNeeded('pressure') 同口径，2026-09-19 方案 B）：
   * 声明窗口已知 且 contextTokens ≥ windowTokens − reserveTokens。抽出供 pre-step
   * 钩子复用，避免两处重复预算解析（口径漂移风险）。返回 false = 未达标（或
   * reserve 超窗 / 声明窗口未知）⇒ 调用方跳过轮内压缩。
   */
  private async isPressureExceeded(agent: CompactionAgentContext, extraTokens = 0): Promise<boolean> {
    const session = agent.session
    const { windowTokens, declaredKnown } = await this.resolveScaledBudgets(agent)
    const thresholdTokens = windowTokens - this.reserveTokens
    if (thresholdTokens <= 0) return false
    if (!declaredKnown) return false
    const measurement = this.measureTokens(session, extraTokens)
    return measurement.contextTokens >= thresholdTokens
  }

  /**
   * L2 反应式补救（三级触发②）：轮中唯一允许的压缩时机。
   *
   * 触发源见 `session/event` 里的 max-tokens 判据（输出被宿主/适配器钳制 = 容量压力已由
   * 上游确认）。执行用 `context-overflow` trigger 走 `compactIfNeeded` —— 该 trigger
   * **绕过阈值早检**（"仍未回线"的真信号由上游继续钳输出给出），即"强制剪一次"。
   *
   * 升级策略：第 2 次起临时放宽 recencyGuard/turnGuard（连当前轮一起进入候选）——因为
   * 常规轮内剪枝受 turnGuard 保护几乎剪不动，"被钳后回线"需要更狠的手段。用尽
   * `reactiveRetries` 次即停止重试并交给 overflow 路径（provider 400）兜底：避免
   * "每步都被钳 → 每步白压"的死循环（那比现状更糟，每圈多吃一次输出）。
   */
  /**
   * 反应式"零候选"重挂：把钳制信号留给下一次机会（下个 pre-step / 下一轮 turn-stopping），
   * 那时阶梯已 +1 ⇒ 守卫放宽，原本剪不动的局面（turnGuard 保护当前轮）才可能剪动。
   * 额度用尽则不再重挂（避免"每步白压"）。
   */
  private rearmReactive(session: Session, used: number): void {
    if (used < this.reactiveRetries) this.reactivePending.set(session, true)
  }

  /**
   * L2：turn 仍在跑时的反应式收紧剪。被钳后宿主可能继续本 turn（还有 next-step 输入），
   * 此时就在下一个 pre-step 剪；若本轮要收，则由 turn-stopping 的 L3 路径剪 + 续写。
   * 两者共用同一个 episode 计数器（`reactiveRescues`），故连续被钳会逐级放宽守卫而不是各自从头开始。
   */
  private async runReactivePrune(
    agent: CompactionAgentContext,
    signal: AbortSignal,
    ctx: Context,
  ): Promise<void> {
    if (!this.reactivePending.has(agent.session)) return
    this.reactivePending.delete(agent.session)
    if (signal.aborted) return
    const used = this.reactiveRescues.get(agent.session) ?? 0
    if (used >= this.reactiveRetries) {
      this.log.warn('[argp-graph] reactive prune retries exhausted after ' + used
        + ' attempt(s); leaving further recovery to the overflow path')
      return
    }
    this.reactiveRescues.set(agent.session, used + 1)
    const relax = used + 1 > 1
    const previousOverride = this.guardOverride
    if (relax) {
      this.guardOverride = { recencyGuard: 0, turnGuard: 0 }
      this.log.warn('[argp-graph] reactive prune attempt ' + (used + 1)
        + ': relaxing recency/turn guards so the newest turn becomes prunable')
    }
    try {
      const result = await this.compactIfNeeded(agent, 'context-overflow', signal)
      if (result !== null) {
        this.log.info('[argp-graph] reactive prune attempt ' + (used + 1) + ': shadowed '
          + result.shadowedSeqs.length + ' surface nodes (seqs ' + result.shadowedRange.start + '-'
          + result.shadowedRange.end + ', ~' + result.shadowedTokenCount + ' tokens)')
      } else {
        // 没剪到东西 ⇒ 信号留着：下一次机会（下一个 pre-step / 下一轮 turn-stopping）带上
        // 放宽守卫再试。若这里直接消费掉，"守卫太紧导致零候选"就会变成永久漏救。
        this.rearmReactive(agent.session, used + 1)
        this.log.warn('[argp-graph] reactive prune attempt ' + (used + 1)
          + ': nothing prunable (candidate set exhausted); re-arming for a relaxed retry')
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      this.log.error('[argp-graph] reactive prune FAILED: ' + message)
      this.log.warn(`[argp-graph] reactive prune failed: ${message}; leaving recovery to the overflow path`)
    } finally {
      this.guardOverride = previousOverride
    }
  }

  override async compactIfNeeded(
    agent: CompactionAgentContext,
    trigger: CompactionTrigger,
    _signal: AbortSignal,
    /** 本步已 claim 未落盘的 user 消息估值（轮初专用；其余调用点省略）。 */
    incomingTokens = 0,
  ): Promise<CompactionResult | null> {
    const session = agent.session
    this.bindSession(session) // A7（问题 3）：compactIfNeeded 也走统一绑定（含账目懒重建）
    const { windowTokens, retainTokens, declaredKnown } = await this.resolveScaledBudgets(agent)
    const thresholdTokens = windowTokens - this.reserveTokens
    if (thresholdTokens <= 0) {
      this.log.info('[argp-graph] pressure check: reserveTokens exceeds windowTokens, skip')
      return null
    }
    const retainChars = retainTokens * this.charsPerToken
    const measurement = this.measureTokens(session, incomingTokens)
    // 声明窗口未知时的早检跳过（2026-08-28）：物理口径宁可不用（宁缺勿错）；
    // context-overflow 触发除外——那是 provider 确认的真实溢出，必须处置。
    if (trigger !== 'context-overflow' && !declaredKnown) {
      this.log.info('[argp-graph] pressure check: declared contextWindow unknown, skip (will check after first request/context)')
      return null
    }
    if (trigger !== 'context-overflow' && measurement.contextTokens < thresholdTokens) {
      this.log.info('[argp-graph] pressure check: contextTokens=' + measurement.contextTokens + ' (source=' + measurement.source + ') < threshold=' + thresholdTokens + ', skip')
      return null
    }

    // v1.2.x §11.8① tombstone-merge：图剪前先把「墓碑地板」压下去。
    // X 原子在 isAtomCandidate 结构性不可剪（2119 行）→ 每轮剪枝新增墓碑，地板单调累积，
    // 剪到候选耗尽仍超窗（run1 T17 / run2 T16 同数字 141,313+32,768>174,080 两臂复现；
    // run2 dump 实测 1297/1310 surface 节点是墓碑，≈142K tok）。归并后原子/图重建，
    // 后续贪心循环拿到的才是真实可剪面。
    const mergedTombstones = this.consolidateTombstones(session)
    if (mergedTombstones > 0) {
      this.log.info('[argp-graph] tombstone-merge: ' + mergedTombstones + ' tombstone nodes consolidated before graph prune')
    }

    const atoms = this.atomize(session)
    const { edges, deterministicEdges, inDegree } = this.buildGraph(atoms)
    // 动态有效入度（§5.4 反向拓扑链式解锁）：每 pass 从"未被剪原子的边"重推，
    // 剪除引用方后其出边消失 → 目标入度递减。多引用场景（A/C/D 都引用 B）下
    // B 须等全部引用方被剪才解锁，天然正确；重复 cites 也按边数逐条减。
    let curInDegree = inDegree
    // 实验（2026-09-15）：A10 结构守卫（isAtomCandidate 内）的前提是「R 已被组外的**语义声明**
    // 保护」，而 `inferred` 边是 0-LLM 机械派生（权重 1、不保证保护力）——若把它计入 A10 的
    // 外部入边判据，会伪激活「R 已受保护 → A 可剪」→ A 先被剪 → §5.4 链式解锁带走 R，
    // 净效果是**加边反而多剪**（spike38 A-ON 27 原子 vs A-OFF 23）。故 A10 只看非 inferred 入度。
    let curInDegreeDecl = new Map<number, number>()
    const surfaceSeqs = [...session.surface.nodes]
    const position = new Map<number, number>(surfaceSeqs.map((seq, i) => [seq, i]))
    const recencyCut = Math.max(0, surfaceSeqs.length - this.recencyGuard)
    const latestTurn = atoms.reduce((m, a) => Math.max(m, a.turn), 0)
    // P4：U-info 按 R 待遇（eff=0，无 selfImportance，靠边权重/排序）；普通 U=3。
    const selfImportance = (a: Atom): number => (a.type === 'A' ? 5 : (a.type === 'U' && a.sourceSeq === undefined ? 3 : 0))
    const eff = new Map(atoms.map(a => [a.id, selfImportance(a)]))
    for (const e of edges) eff.set(e.to, Math.max(eff.get(e.to) ?? 0, EDGE_WEIGHTS[e.level])) // 语义边权重
    // §3-3 recall 价值继承：recall 结果原子若被 cites 命中（入度>0 = 模型确认使用），
    // 继承旧原子的被剪 eff（×0.5 衰减）。继承一旦触发即"永久"生效于本轮排序——
    // 不依赖当前入度（链式解锁可能剪掉 cites 方后使入度归零，但继承的价值仍应保留，
    // 避免"模型刚确认使用的内容因引用方先被剪而立刻被剪"）。
    if (this.recallResultSeq >= 0 && this.recallSourceSeq >= 0) {
      const recallAtom = atoms.find(a => a.seq === this.recallResultSeq)
      const source = this.prunedNodeIndex.get(this.recallSourceSeq)
      if (recallAtom !== undefined && source !== undefined && (inDegree.get(recallAtom.id) ?? 0) > 0) {
        const inherited = Math.floor(source.eff * 0.5)
        eff.set(recallAtom.id, Math.max(eff.get(recallAtom.id) ?? 0, inherited))
      }
    }
    const lastRef = new Map<number, number>()
    for (const e of edges) {
      const from = atoms[e.from]
      if (from !== undefined) lastRef.set(e.to, Math.max(lastRef.get(e.to) ?? 0, from.turn))
    }
    const touchesSemantic = new Set(edges.flatMap(e => [e.from, e.to]))
    // ask-exempt U 动态覆盖：U 后首个 A 若对它有 supporting 边，则视为被覆盖；后续跨轮引用会使其失效。
    const askCoverage = new Map<number, number>()
    for (const u of atoms.filter(a => a.type === 'U')) {
      const text = u.text.trim()
      // A8：ask 检测（导出纯函数 looksAskText，测试直接锁定收窄行为）
      const looksAsk = looksAskText(u.text)
      if (!looksAsk) continue
      const firstA = atoms
        .filter(a => a.type === 'A' && a.turn >= u.turn && a.seq > u.seq)
        .sort((a, b) => a.seq - b.seq)[0]
      if (firstA !== undefined && edges.some(e => e.from === firstA.id && e.to === u.id)) {
        askCoverage.set(u.id, firstA.id)
      }
    }
    // 2026-08-23 半拆组：R（tool/result）独立成组，不再与 issuer A 同进退——
    // 大 R（工具结果，常达 10-90K 字符）可独立剪除，解决"压缩率不足"（此前被 A+R 组绑定，
    // 组候选要求 A 也候选；A 因 A10 保护/入度门槛不候选 → 整组不可剪 → 大 R 永远剪不掉）。
    // 协议安全由两侧保证：① 剪 R（A 保留）→ tool 占位墓碑配对 A 的 tool_calls（见
    // pruneIntervals tool 墓碑）；② 剪 A → pass 循环连带剪其全部 R（user 墓碑，防孤儿 tool 消息）。
    // R 被 cites 引用（语义入度 > 0）时仍不可剪（isAtomCandidate 的 curInDegree 门槛保留）。
    const issuerByCall = new Map<string, Atom>()
    for (const a of atoms) if (a.type === 'A') for (const cid of a.toolCallIds) issuerByCall.set(cid, a)
    // R by callId（半拆组连带剪用：剪 A 时把应答其 call 的 R 一并剪除）
    const rByCallForPrune = new Map<string, Atom>()
    for (const r of atoms) if (r.type === 'R' && r.toolCallIds[0] !== undefined) rByCallForPrune.set(r.toolCallIds[0], r)
    const groupOf = new Map<number, number>()
    const groups: Atom[][] = []
    for (const a of atoms) {
      if (groupOf.has(a.id)) continue
      const gid = groups.length
      groups.push([a])
      groupOf.set(a.id, gid)
    }
    // P5 Wave 3 第 2 步：3 个闭包（isAtomCandidate/isGroupCandidate/sortKey）提升为模块级纯函数，
    // 原闭包捕获的 this 字段与局部量打包成显式 state（PruneState）。curInDegree/curInDegreeDecl
    // 每 pass 重推（链式解锁），方法内每 pass 同步到 pruneState（见下方 pass 循环）；
    // chainLen 占位空 Map，findVersionDuplicates 后回填（sortKey 仅在 pass 循环内调用，届时已回填）。
    const pruneState: PruneState = {
      turnGuard: this.turnGuard,
      askCoverage,
      position,
      recencyCut,
      latestTurn,
      edges,
      atoms,
      curInDegree,
      curInDegreeDecl,
      deterministicEdges,
      touchesSemantic,
      eff,
      sortMode: this.sortMode,
      chainLen: new Map<number, number>(),
      lastRef,
      charsPerToken: this.charsPerToken,
    }
    const softCandidateGroups = groups.filter(g => isGroupCandidate(g, false, pruneState)).length
    const pruned = new Map<number, Atom>()
    // 2026-08-22：闭包原子归属（seq → 闭包元数据），intervals/tombstone 生成时按归属区分
    // 闭包区间（P3/P6：闭包 tombstone 带 root/计数供 recall 消歧）与默认区间。
    const closureSeqMeta = new Map<number, { closureId: string; rootPreview: string; closureTotal: number }>()
    const { dupIds: duplicateIds, chainLen, latestRByKey, rKeyByRId } = this.findVersionDuplicates(atoms, inDegree)
    for (const id of duplicateIds) {
      const atom = atoms.find(a => a.id === id)
      if (atom !== undefined) pruned.set(id, atom)
    }
    // 排序键 sortKey 已提升为模块级纯函数（§4.5 + spike 18 提案）；此处回填 chainLen（占位后）。
    pruneState.chainLen = chainLen
    let forced = false
    for (let pass = 0; pass < this.maxPasses; pass += 1) {
      // 每 pass 重推有效入度：已剪原子的出边不再计入目标入度（链式解锁）
      curInDegree = new Map<number, number>()
      curInDegreeDecl = new Map<number, number>()
      for (const e of edges) {
        if (pruned.has(e.from)) continue
        curInDegree.set(e.to, (curInDegree.get(e.to) ?? 0) + 1)
        // A10 专用：只数非 inferred 入边（见上方实验注释）。
        if (e.level !== 'inferred') curInDegreeDecl.set(e.to, (curInDegreeDecl.get(e.to) ?? 0) + 1)
      }
      // P5 Wave 3 第 2 步：同步当前 pass 的有效入度到 pruneState（模块级 isAtomCandidate 按调用时读取）。
      pruneState.curInDegree = curInDegree
      pruneState.curInDegreeDecl = curInDegreeDecl
      const remaining = atoms.filter(a => !pruned.has(a.id))
      const visible = remaining.reduce((sum, a) => sum + a.text.length, 0)
      if (visible <= retainChars) break
      const liveGroups = groups.filter(g => g.some(a => !pruned.has(a.id)))
      let candidateGroups = liveGroups.filter(g => isGroupCandidate(g, false, pruneState))
      if (process.env['ARGP_DEBUG_PASS'] === '1') {
        const dbg = (m: string): void => { process.stdout.write('[dbg] ' + m + '\n') }
        dbg('pass=' + pass + ' visible=' + visible + '/' + retainChars + ' prunedSoFar=' + pruned.size)
        for (const g of liveGroups) {
          const a = g[0]!
          dbg('  ' + (isGroupCandidate(g, false, pruneState) ? 'CAND' : 'skip') + ' seq=' + a.seq + ' ' + a.type + ' t' + a.turn + ' inDeg=' + (curInDegree.get(a.id) ?? 0) + ' chars=' + a.text.length)
        }
      }
      if (candidateGroups.length === 0) {
        // 2026-08-22 降级链完整化：候选耗尽时不再 return 丢弃累积 pruned——原独立闭包事务
        // 的 return 把正常候选 + 版本重复全部作废，每次压缩只剪 1 个闭包（2-10 原子），
        // 25 次压缩剪除率 0-2%（"压缩饿死"，见 engine-fix-2026-08-22-compaction-starvation.md（已迁出公开仓库））。
        // fail 保持设计语义（§5.9/§5.11：资源用尽/超窗 → 报警终止，全有或全无、不产出）。
        // lifecycle（默认）：闭包生命周期（选择并入 pruned，含 root U 退休，排除已剪）→
        // summarize（默认关，独立事务）→ force_prune（忽略入度，剪到达标为止）；
        // 全部累积统一走最终 pruneIntervals 一次事务剪。
        if (this.degradationStrategy === 'fail') return null
        const closure = this.selectClosureToMerge(session, atoms, edges, inDegree, askCoverage, latestTurn, new Set(pruned.keys()))
        if (closure !== null) {
          const closureTotal = closure.seqs.length
          for (const a of closure.atoms) {
            pruned.set(a.id, a)
            closureSeqMeta.set(a.seq, { closureId: closure.closureId, rootPreview: closure.rootPreview, closureTotal })
          }
          pushBounded(this.closurePrunes, {
            closureId: closure.closureId,
            rootSeq: closure.root.seq,
            prunedSeqs: closure.seqs,
            at: new Date().toISOString(),
          }, this.telemetryCap)
          continue // 重推后继续：可能还有更多可剪闭包 / force
        }
        if (this.degradationStrategy === 'summarize' && this.enableSummarize) {
          const summarizeResult = this.summarizeCriticalChain(session, atoms, edges, latestTurn)
          if (summarizeResult !== null) return summarizeResult
        }
        candidateGroups = liveGroups.filter(g => isGroupCandidate(g, true, pruneState)) // force_prune：忽略入度
        if (candidateGroups.length === 0) break
        forced = true
      }
      const groupKey = (g: Atom[]): string => g.map(a => sortKey(a, pruneState)).sort()[0] as string
      candidateGroups.sort((x, y) => groupKey(x).localeCompare(groupKey(y)))
      const top = candidateGroups[0] as Atom[]
      for (const a of top) {
        pruned.set(a.id, a)
        // 2026-08-23 半拆组连带：剪 A（含 tool-call）必须连带其全部应答 R——
        // 否则提交 messages 里出现孤儿 tool 消息（role:"tool" 无匹配 assistant.tool_calls）→ provider 400。
        // R 独立剪时由 tool 占位墓碑配对（A 保留），此处只处理"A 剪 → R 跟剪"方向。
        if (a.type === 'A' && a.toolCallIds.length > 0) {
          for (const cid of a.toolCallIds) {
            const r = rByCallForPrune.get(cid)
            if (r !== undefined && !pruned.has(r.id)) pruned.set(r.id, r)
          }
        }
      }
    }

    // 微剪枝下限：按极大连续区间归并，区间可见量 < minSpanChars 的放回（不剪）。
    // 2026-08-23 半拆组：R 原子（issuer A 未被剪）强制单独成区间——tool 占位墓碑
    // 的 surface replace 必须恰好替换 1 个节点（dsh assertToolResultRewrite），
    // 多 R 相邻或 R 与邻原子合并会导致替换区间 > 1 节点 → schema 校验失败。
    // 2026-08-23 孤儿修复（双向守卫）：旧守卫只挡「solo-R 并入已有区间」，
    // 没挡「后续原子并入以 solo-R 开头的区间」——混剪后 R 被 user tombstone
    // 整体替换，callId 蒸发，issuer A 的 tool-call 失去应答 → provider 400。
    // 实测 26-local-full-verify2：23 个孤儿全部是此形态（seq 与混剪区间逐一对应）。
    // P5 Wave 3 第 2 步：区间归并段提升为模块级纯函数 mergeIntervals（逐字保留）。
    // droppedIntervals 原方法内计算但未被读取，现由 mergeIntervals 内部计算（供未来诊断/单测）。
    const kept = mergeIntervals(pruned, position, issuerByCall, this.minSpanChars).kept
    if (kept.length === 0) return null
    for (const iv of kept) {
      for (const a of iv.atoms) {
        const citedBySeq = edges
          .filter(e => e.to === a.id)
          .map(e => atoms[e.from]?.seq)
          .filter((x): x is number => x !== undefined)
        const firstLine = a.text.split('\n').map(l => l.trim()).find(l => l !== '') ?? ''
        // 版本链重定向（2026-08-23）：被剪旧 R 若属于某路径版本链，记录该路径最新存活版本 seq，
        // recall_pruned 命中时重定向返回最新版原文（替代旧值）。
        let latestOfPath: number | undefined
        if (a.type === 'R') {
          const key = rKeyByRId.get(a.id)
          if (key !== undefined) {
            const latest = latestRByKey.get(key)
            if (latest !== undefined && latest !== a.seq) latestOfPath = latest
          }
        }
        this.prunedNodeIndex.set(a.seq, {
          seq: a.seq,
          type: a.type,
          turn: a.turn,
          firstLine: firstLine.length > 120 ? firstLine.slice(0, 120) + '…' : firstLine,
          citedBySeq,
          eff: eff.get(a.id) ?? 0,
          ...(latestOfPath !== undefined ? { latestOfPath } : {}),
        })
      }
    }
    // 2026-08-22：区间 tombstone 按闭包归属生成——区间原子全部来自同一闭包 → 闭包 tombstone
    // （P3/P6：带 root/计数，recall 消歧）。
    // 2026-08-23 半拆组：单 R 区间（issuer A 未被剪）→ tool 占位墓碑（保留 callId 配对 A 的
    // tool_calls，wire 序列化输出 role:"tool"，不触发 provider 400；文本提示 recall 找回）。
    // P5 Wave 3 第 2 步：tombstone 生成段提升为模块级纯函数 buildTombstones（逐字保留）。
    const tombstoneTexts = buildTombstones(kept, closureSeqMeta, issuerByCall, pruned, forced)
    return this.pruneIntervals(session, kept, edges.length, softCandidateGroups, forced, tombstoneTexts)
  }

  override async compactNow(
    agent: ManualCompactAgentContext,
    signal: AbortSignal,
    sourceCommandId?: CommandId,
  ): Promise<CompactionResult | null> {
    this.bindSession(agent.session) // A7（问题 3）：统一绑定 + 账目懒重建
    signal.throwIfAborted()
    // /compact 链路（command-compact 调用方传入 commandId）：透传给事务事件做
    // presentation correlation（对齐 compaction-basic 的 sourceCommandId 语义）。
    this.compactSourceCommandId = sourceCommandId
    try {
      const run = async (agentSignal: AbortSignal): Promise<CompactionResult | null> => {
        const opSignal = AbortSignal.any([signal, agentSignal])
        opSignal.throwIfAborted()
        // 多段收集（2026-09-21 修复）：surface 被用户消息切成多段时，旧实现只剪最老一段。
        const ranges = this.selectManualRanges(agent.session)
        return this.compactRegions(ranges, agent, opSignal)
      }
      if (typeof agent.runMaintenance === 'function') {
        return agent.runMaintenance(run)
      }
      return run(signal)
    } finally {
      this.compactSourceCommandId = undefined
    }
  }

  override async compactRegion(
    start: number,
    end: number,
    agent: CompactionAgentContext,
    signal?: AbortSignal,
  ): Promise<CompactionResult> {
    this.bindSession(agent.session) // A7（问题 3）：统一绑定 + 账目懒重建
    signal?.throwIfAborted()
    const session = agent.session
    const nodes = session.surface.nodes
    const startIdx = nodes.indexOf(asSeq(start))
    const endIdx = nodes.indexOf(asSeq(end))
    if (startIdx === -1) throw new Error('compactRegion: start seq ' + start + ' not found in surface')
    if (endIdx === -1) throw new Error('compactRegion: end seq ' + end + ' not found in surface')
    if (startIdx > endIdx) throw new Error('compactRegion: start seq ' + start + ' is after end seq ' + end + ' on the surface')
    if (!toolPairingBalancedBefore(session, nodes[startIdx])) throw new Error('compactRegion: start seq ' + start + ' is not a balanced boundary')
    if (!toolPairingBalancedAfter(session, nodes[endIdx])) throw new Error('compactRegion: end seq ' + end + ' is not a balanced boundary')

    const shadowedSeqs = nodes.slice(startIdx, endIdx + 1)
    const atoms = this.atomize(session)
    const bySeq = new Map(atoms.map(a => [a.seq, a]))
    const intervalAtoms = shadowedSeqs.map(seq => bySeq.get(seq)).filter((a): a is Atom => a !== undefined)
    if (intervalAtoms.some(a => a.type === 'U' || a.type === 'X')) {
      // P5：措辞 scoped 到手动入口。自动闭包生命周期（compactIfNeeded 降级链内联）确实会连 root U
      // （task-init）与 X checkpoint 一起剪除；"ARGP never prunes U/X" 只对本手动入口成立。
      throw new Error('compactRegion (manual) does not prune U/X spans; choose a span without U/X, '
        + 'or let the automatic closure lifecycle retire those nodes together with their closure')
    }
    if (intervalAtoms.length === 0) {
      throw new Error('compactRegion: selected span contains no prunable A/R atoms')
    }
    const chars = intervalAtoms.reduce((sum, a) => sum + a.text.length, 0)
    const interval = { seqs: shadowedSeqs, chars, atoms: intervalAtoms }
    // 本入口不传 tombstones → pruneIntervals 的 P1.2 预校验不会剔除任何区间，null 不可达。
    const result = this.pruneIntervals(session, [interval], 0, 0, true)
    if (result === null) throw new Error('compactRegion: pruneIntervals unexpectedly returned null (no tombstones passed; unreachable)')
    return result
  }

  /** 为手动 compactNow 选择**全部**可剪的极大连续 A/R 段（确定性、由旧到新）。
   *
   *  入选判据（与旧版一致，仅去掉"遇阻即停"）：段内原子必须
   *  ① 是对话载体 A/R（U/X 不参剪，手动入口不剪骨架，见 compactRegion 的 P5 约束）；
   *  ② 不落在 turnGuard（最近 N 轮）与 recencyGuard（surface 末尾 N 节点）保护窗口内。
   *
   *  修复（2026-09-21）：旧实现扫到第一个不合格节点就 `break`，而真实会话的 surface 被
   *  用户消息切成「U A R A R U A R …」多段结构 ⇒ 手动 /compact 永远只剪最老一小段
   *  （表现为"图剪压不动"）。现在改为收集全部极大连续段，交给一笔 pruneIntervals 事务剪除。
   */
  private selectManualRanges(session: Session): { start: number; end: number }[] {
    const surfaceSeqs = session.surface.nodes
    const atoms = this.atomize(session)
    const bySeq = new Map(atoms.map(a => [a.seq, a]))
    const latestTurn = atoms.reduce((m, a) => Math.max(m, a.turn), 0)
    const recencyCut = Math.max(0, surfaceSeqs.length - this.recencyGuard)
    const ranges: { start: number; end: number }[] = []
    let start: number | null = null
    let end = -1
    const flush = (): void => {
      if (start !== null) ranges.push({ start, end })
      start = null
      end = -1
    }
    for (let i = 0; i < surfaceSeqs.length; i += 1) {
      const seq = surfaceSeqs[i]
      const atom = bySeq.get(seq)
      const eligible = atom !== undefined
        && atom.type !== 'U' && atom.type !== 'X'
        && atom.turn <= latestTurn - this.turnGuard
        && i < recencyCut
      if (!eligible) {
        flush() // 不合格节点就地闭合当前段（不再终止整个扫描）
        continue
      }
      if (start === null) start = seq
      end = seq
    }
    flush()
    return ranges
  }

  /** 手动多区间压缩：逐段复核边界后合并为一笔事务剪除。
   *  边界复核与 compactRegion 同口径（配对平衡 / 段内不含 U/X / 段内有可剪原子），
   *  任一区间不合格则**静默剔除该区间**（而非整体失败）——手动入口的语义是"能剪多少剪多少"。
   *  返回 null = 全部区间都被剔除（无可剪内容），调用方据此显示 "No compactable history yet."。 */
  private compactRegions(
    ranges: { start: number; end: number }[],
    agent: CompactionAgentContext,
    signal: AbortSignal,
  ): CompactionResult | null {
    if (ranges.length === 0) return null
    this.bindSession(agent.session) // A7（问题 3）：统一绑定 + 账目懒重建
    signal.throwIfAborted()
    const session = agent.session
    const nodes = session.surface.nodes
    const bySeq = new Map(this.atomize(session).map(a => [a.seq, a]))
    const intervals: { seqs: number[]; chars: number; atoms: Atom[] }[] = []
    for (const range of ranges) {
      const startIdx = nodes.indexOf(asSeq(range.start))
      const endIdx = nodes.indexOf(asSeq(range.end))
      if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) continue
      if (!toolPairingBalancedBefore(session, nodes[startIdx])) continue
      if (!toolPairingBalancedAfter(session, nodes[endIdx])) continue
      const shadowedSeqs = nodes.slice(startIdx, endIdx + 1)
      const intervalAtoms = shadowedSeqs.map(seq => bySeq.get(seq)).filter((a): a is Atom => a !== undefined)
      if (intervalAtoms.length === 0) continue
      if (intervalAtoms.some(a => a.type === 'U' || a.type === 'X')) continue
      const chars = intervalAtoms.reduce((sum, a) => sum + a.text.length, 0)
      intervals.push({ seqs: shadowedSeqs, chars, atoms: intervalAtoms })
    }
    if (intervals.length === 0) return null
    return this.pruneIntervals(session, intervals, 0, 0, true)
  }

  /** 一笔事务剪多个极大连续区间：start → summary → 每区间 checkpoint replace → end。
   *  tombstone 类型（2026-08-23 半拆组）：'user' = 普通/闭包墓碑文本；'tool' = tool/result
   *  占位墓碑（克隆原 R data、只改 tool-result block 的 inner text，保留 callId/isError/role/id
   *  ——dsh assertToolResultRewrite 只允许改 inner text），配对 issuer A 的 tool_calls 防 400。 */
  private pruneIntervals(
    session: Session,
    intervals: { seqs: number[]; chars: number; atoms: Atom[] }[],
    semanticEdges: number,
    candidateCount: number,
    forced: boolean,
    tombstones?: ({ type: 'user'; text: string } | { type: 'tool'; seq: number; callId: string })[],
    summaryKind?: 'graph-prune' | 'tombstone-merge',
  ): CompactionResult | null {
    // P1.2（2026-09-21）：事务开始前预校验 tool 占位墓碑的可克隆性。带 tool 墓碑的单 R 区间
    // 必须克隆原 R data（只改 inner text）以配对 issuer A 的 tool_calls；若原事件
    // data/message/content 缺失（损坏事件），旧代码落入 user 墓碑分支 → R 节点被 user/message
    // 替换 → issuer A 的 tool_calls 失去应答 → 序列化 role:"tool" 悬空 → provider 400。
    // 事务前预校验 canCloneTool：无法克隆的单 R 区间从待剪集合剔除（保留该 R 活体、不剪）并
    // warn；后续循环用过滤后的区间集合。循环内守卫保留为防御性 backstop（预校验通过后可达性为零）。
    const canCloneTool = (seq: number): boolean => {
      const ev = sessionEvents(session)[seq] as { data?: Record<string, unknown> } | undefined
      const data = ev?.data
      const msg = data?.message as { content?: { type?: string; toolCallId?: string; isError?: boolean }[] } | undefined
      return data !== undefined && msg !== undefined && msg.content?.[0] !== undefined
    }
    type TombstoneSpec = { type: 'user'; text: string } | { type: 'tool'; seq: number; callId: string }
    let useIntervals = intervals
    let useTombstones = tombstones
    if (tombstones !== undefined && tombstones.length === intervals.length) {
      const droppedSeqs: number[] = []
      const keptIv: typeof intervals = []
      const keptTs: TombstoneSpec[] = []
      for (let i = 0; i < intervals.length; i += 1) {
        const iv = intervals[i]
        const ts = tombstones[i]
        if (ts !== undefined && ts.type === 'tool' && iv.seqs.length === 1 && !canCloneTool(ts.seq)) {
          droppedSeqs.push(ts.seq)
          continue
        }
        keptIv.push(iv)
        if (ts !== undefined) keptTs.push(ts)
      }
      if (droppedSeqs.length > 0) {
        this.log.warn('[argp-graph] tool tombstone clone pre-check failed for seq(s) ' + droppedSeqs.join(',')
          + '; keeping those R node(s) alive (not pruned) to preserve issuer tool_calls pairing')
        // 调用方（图剪）在事务前已把这些原子索引进 prunedNodeIndex；节点保留活体，
        // 删除索引条目保持 recall 账本诚实（活体节点不应出现在 pruned 索引）。
        for (const seq of droppedSeqs) this.prunedNodeIndex.delete(seq)
        useIntervals = keptIv
        useTombstones = keptTs
      }
    }
    if (useIntervals.length === 0) return null
    const charsBefore = this.visibleChars(session)
    const openTurn = detectOpenTurn(session)
    const compactionId = CompactionId('argp-graph-' + randomUUID())
    const lifecycle = { compactionId, turn: openTurn }
    const allSeqs = useIntervals.flatMap(iv => iv.seqs)
    const first = useIntervals[0]?.seqs[0] ?? 0
    const last = useIntervals[useIntervals.length - 1]?.seqs[useIntervals[useIntervals.length - 1]!.seqs.length - 1] ?? first

    const startEvent = session.append('compaction/start', {
      ...lifecycle,
      // /compact 溯源：发起命令 ID 随事务事件落账（UI presentation correlation）
      ...this.compactSourceCommandId === undefined ? {} : { sourceCommandId: this.compactSourceCommandId },
    })
    try {
      const shadowedTokenCount = Math.ceil(useIntervals.reduce((s, iv) => s + iv.chars, 0) / this.charsPerToken)
      const resolvedTombstones = useTombstones !== undefined && useTombstones.length === useIntervals.length
        ? useTombstones
        : useIntervals.map(iv => ({
            type: 'user' as const,
            text: '[elided seq=' + iv.seqs[0] + '..' + iv.seqs[iv.seqs.length - 1]
              + ': ' + iv.seqs.length + ' surface nodes pruned by ARGP (graph order, cites-aware'
              + (forced ? ', forced' : '') + '); recall_pruned(seq) retrieves original]',
          }))
      const intervalRecords: { start: number; end: number; tombstoneSeq: number }[] = []
      let firstPruneSeq: number | undefined
      for (let i = 0; i < useIntervals.length; i += 1) {
        const iv = useIntervals[i]
        if (iv === undefined) continue
        const start = iv.seqs[0] as number
        const end = iv.seqs[iv.seqs.length - 1] as number
        // Shadow-price 契约（宿主 token-meter foldSurfaceProjection）：compaction/prune 的
        // shadowedRange 必须与紧随其后的 surface replace 范围**严格相等**，否则重放投影 throw
        // （2026-09-01 实测：多区间事务发一个总跨度 claim 再逐区间 replace，第一个 replace
        // 即撞总 claim → resume 报 "no adjacent shadow price"）。故每区间一个 shadow-price
        // 事件，范围=该单区间，与官方 compaction-tool-result-pruner 同模式；末尾 summary 的
        // 总范围 claim 被紧随的 off-surface compaction/end 清掉，无契约冲突。
        const intervalPrune = session.append('compaction/prune', {
          shadowedRange: { start: asSeq(start), end: asSeq(end) },
          shadowedSeqs: asSeqs(iv.seqs),
          shadowedTokenCount: Math.ceil(iv.chars / this.charsPerToken),
        })
        if (firstPruneSeq === undefined) firstPruneSeq = intervalPrune.seq
        const ts = resolvedTombstones[i]
        if (ts !== undefined && ts.type === 'tool' && iv.seqs.length === 1) {
          // tool 占位墓碑：克隆原 R data，只改 tool-result block 的 inner text
          const origEvent = sessionEvents(session)[ts.seq] as { data?: Record<string, unknown> } | undefined
          const origData = origEvent?.data
          const origMsg = origData?.message as { content?: { type?: string; toolCallId?: string; isError?: boolean }[] } | undefined
          const origBlock = origMsg?.content?.[0]
          if (origData !== undefined && origMsg !== undefined && origBlock !== undefined) {
            const tombstone = session.append('tool/result', {
              ...origData,
              message: {
                ...(origMsg as object),
                content: [{
                  type: 'tool-result',
                  toolCallId: origBlock.toolCallId ?? ts.callId,
                  isError: origBlock.isError ?? false,
                  content: [{ type: 'text', text: '[elided: 旧版本结果已压缩；recall_pruned(seq) 找回原值]' }],
                }],
              },
            } as never, {
              surfaceOp: { op: 'replace', startSeq: asSeq(ts.seq), endSeq: asSeq(ts.seq) },
              sourceEventSeqs: asSeqs([startEvent.seq, intervalPrune.seq, ...iv.seqs]),
            })
            intervalRecords.push({ start, end, tombstoneSeq: tombstone.seq })
            continue
          }
          // 原 R data 不可用时回退 user 墓碑（安全方向：无结构化 tool-result → 无孤儿配对问题）
        }
        const text = ts !== undefined && ts.type === 'user'
          ? ts.text
          : '[elided seq=' + iv.seqs[0] + '..' + iv.seqs[iv.seqs.length - 1]
            + ': ' + iv.seqs.length + ' surface nodes pruned by ARGP (graph order, cites-aware'
            + (forced ? ', forced' : '') + '); recall_pruned(seq) retrieves original]'
        const tombstone = session.append('user/message', createUserMessage({
          content: [{ type: 'text', text }],
          source: compactCheckpointSource(compactionId),
        }), {
          surfaceOp: { op: 'replace', startSeq: asSeq(start), endSeq: asSeq(end) },
          sourceEventSeqs: asSeqs([startEvent.seq, intervalPrune.seq, ...iv.seqs]),
        })
        intervalRecords.push({ start, end, tombstoneSeq: tombstone.seq })
      }
      // 人类可读剪枝摘要（2026-08-28 UI 联调）：compaction 节点的展示文本来自
      // compaction/summary 事件；不发则 WebUI 显示"压缩摘要不可用"。off-surface
      // 日志事件，模型不可见。payload 按 CompactionSummary 词典填诚实值，类型走 as never。
      const prunedCount = useIntervals.reduce((sum, iv) => sum + iv.atoms.length, 0)
      const charsBefore0 = useIntervals.reduce((sum, iv) => sum + iv.chars, 0)
      session.append('compaction/summary', {
        ...lifecycle,
        summary: [{
          type: 'text',
          text: summaryKind === 'tombstone-merge'
            ? `ARGP 墓碑归并（§11.8①）：${prunedCount} 墓碑 / ${useIntervals.length} 区间归并为聚合占位（约 ${Math.ceil(charsBefore0 / this.charsPerToken)} tok 回收）；0-LLM；原文保留在 append-only 日志，recall_pruned(seq) / list_pruned 可取回`
            : `ARGP 图剪：${prunedCount} 原子 / ${useIntervals.length} 区间（约 ${Math.ceil(charsBefore0 / this.charsPerToken)} tok）；确定性排序，0-LLM；原文保留在 append-only 日志，recall_pruned(seq) / list_pruned 可取回`,
        }],
        shadowedRange: { start: first, end: last },
        shadowedSeqs: allSeqs,
        shadowedTokenCount: Math.ceil(charsBefore0 / this.charsPerToken),
        provider: 'argp',
        model: 'deterministic-guards',
      } as never)
      const endEvent = session.append('compaction/end', lifecycle)
      const charsAfter = this.visibleChars(session)
      pushBounded(this.records, {
        at: new Date().toISOString(),
        compactionId,
        ...this.compactSourceCommandId === undefined ? {} : { sourceCommandId: this.compactSourceCommandId },
        intervals: intervalRecords,
        startEventSeq: startEvent.seq,
        summaryEventSeq: firstPruneSeq ?? startEvent.seq,
        endEventSeq: endEvent.seq,
        shadowedSeqs: allSeqs,
        prunedAtoms: useIntervals.flatMap(iv => iv.atoms.map(a => ({ id: a.id, type: a.type, seq: a.seq }))),
        semanticEdges,
        candidates: candidateCount,
        charsBefore,
        charsAfter,
        forced,
      }, this.telemetryCap)
      // P7：一笔 compaction 事务成功即重置 recall 字数预算（视图已换代，旧累计不应继续压制新一轮召回）
      this.recallCharsUsed = 0
      // 2026-08-23：压缩换代 surface——旧真实锚点（压缩前的 provider usage）失效，
      // 若保留会用大锚点 + 增量导致压缩后立即误触发。用压缩后 surface 估算重置锚点
      // （压缩后 surface 小、估算误差影响小；下一次请求的 usage 会再次精确锚定）。
      const nodes = session.surface.nodes
      const tailSeq = nodes.length > 0 ? nodes[nodes.length - 1] : -1
      this.lastRealPromptTokens = Math.ceil(this.visibleChars(session) / this.charsPerToken)
      this.lastRealAnchorSeq = typeof tailSeq === 'number' ? tailSeq : this.lastRealAnchorSeq
      // 永久冻结：落剪不再刷新 frozenCatalog（见 bindSession 注释）。剪枝本身已让可见上下文换代，
      // 那一步的前缀缓存失效是上下文真实变更的必然代价；但 catalog 文本恒定，不在这条路上再变一次。
      return {
        compactionId,
        startSeq: asSeq(startEvent.seq),
        summarySeq: asSeq(firstPruneSeq ?? startEvent.seq),
        endSeq: asSeq(endEvent.seq),
        summary: resolvedTombstones.map(ts => ({ type: 'text', text: ts.type === 'tool'
          ? '[elided tool result; recall_pruned(seq) retrieves original]' : ts.text })),
        shadowedRange: { start: asSeq(first), end: asSeq(last) },
        shadowedSeqs: asSeqs(allSeqs),
        shadowedTokenCount,
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      try {
        session.append('compaction/end', { ...lifecycle, error: message })
      } catch {
        // 关闭失败保留未配对 start，可被 inspectCompactionEntryState 检出
      }
      throw error
    }
  }

  /**
   * A7 事务账目重建：resume 时从 append-only 日志扫描 compaction/start、compaction/prune、
   * compaction/end 事件重建 records/prunedNodeIndex/shadowedSeqsOf 状态；无 end 的 start 记 warn。
   * 不引入 WAL——日志本身即账目。幂等：已重建过的 compactionId 跳过（rebuiltCompactionIds 去重），
   * 使「setSession 自动重建」与「测试显式清空 records 后再重建」两种路径都安全。
   */
  rebuildLedgerFromLog(): void {
    if (this.session === null) return
    const events = sessionEvents(this.session)
    const starts: { seq: number; compactionId: string; lifecycle: Record<string, unknown> }[] = []
    const prunes: { seq: number; start: number; end: number; shadowedSeqs: number[]; shadowedTokenCount: number }[] = []
    const ends = new Set<number>()
    const endByStart = new Map<number, { endSeq: number; error?: string }>()
    for (let i = 0; i < events.length; i += 1) {
      const event = events[i]
      if (event === undefined) continue
      if (event.type === 'compaction/start') {
        starts.push({ seq: i, compactionId: String((event.data as { compactionId?: unknown }).compactionId ?? ''), lifecycle: event.data as Record<string, unknown> })
      } else if (event.type === 'compaction/prune') {
        const d = event.data as { shadowedRange?: { start?: number; end?: number }; shadowedSeqs?: number[]; shadowedTokenCount?: number }
        prunes.push({ seq: i, start: d.shadowedRange?.start ?? 0, end: d.shadowedRange?.end ?? 0, shadowedSeqs: d.shadowedSeqs ?? [], shadowedTokenCount: d.shadowedTokenCount ?? 0 })
      } else if (event.type === 'compaction/end') {
        ends.add(i)
        const d = event.data as { compactionId?: unknown; error?: unknown }
        const s = starts.find(st => st.compactionId === d.compactionId)
        if (s !== undefined) endByStart.set(s.seq, { endSeq: i, error: typeof d.error === 'string' ? d.error : undefined })
      }
    }
    // 账目重建：shadowed 集合直接复用 shadowedSeqsOf 的增量游标（问题 8：删重复扫描循环，
    // shadowedSeqsOf 已从上次扫描处继续到 events.length，同一游标不冲突）
    this.shadowedSeqsOf(this.session)
    // 事件类型反查（问题 8）：从日志真实事件反推原子类型/轮次，不再一律占位 'A'/turn 0。
    // 分类口径与 atomize 一致：统一走 classifyUserMessage（先 data[argp].info → U，再 plugin 源 → X）。
    const typeOfSeq = (seq: number): AtomType => {
      const event = this.session === null ? undefined : sessionEvents(this.session)[seq]
      if (event === undefined) return 'X'
      if (event.type === 'user/message') return classifyUserMessage(event.data)
      if (event.type === 'assistant/message') return 'A'
      if (event.type === 'tool/result') return 'R'
      return 'X'
    }
    const turnOfSeq = (seq: number): number => {
      const event = this.session === null ? undefined : sessionEvents(this.session)[seq]
      return event === undefined ? 0 : (turnOf(event) ?? 0)
    }
    // 逐 start 配对：收集该事务区间（start..end）内的**全部** compaction/prune 与 end。
    // 2026-09-01 修复：pruneIntervals 改为逐区间发 prune（每区间一个 shadow-price 事件，
    // 对齐宿主 foldSurfaceProjection 严格相等契约），一个事务含多个 prune；
    // 旧"start 后最近一个 prune"假设失效 → 改为收集事务内全部并合并（兼容旧单 prune 日志：
    // 此时区间内恰一个，合并结果等同旧行为）。
    for (const s of starts) {
      // 幂等守卫：已重建过则跳过（防止 setSession 自动重建后，测试显式 rebuildLedgerFromLog 再重建）
      if (this.rebuiltCompactionIds.has(s.compactionId)) continue
      const end = endByStart.get(s.seq)
      if (end === undefined) {
        // 未闭合 start：仅告警，不重建记录；标记已处理防止重复告警
        if (!this.rebuiltCompactionIds.has(s.compactionId)) {
          pushBounded(this.auditWarnings, 'unclosed compaction start at seq ' + s.seq + ' (compactionId=' + s.compactionId + '); transaction may have been interrupted', this.telemetryCap)
          this.rebuiltCompactionIds.add(s.compactionId)
        }
        continue
      }
      const txPrunes = prunes
        .filter(p => p.seq > s.seq && p.seq < end.endSeq)
        .sort((a, b) => a.seq - b.seq)
      if (txPrunes.length === 0) continue
      // 标记已重建（重建后不重复，防止再次 rebuildLedgerFromLog 时追加）
      this.rebuiltCompactionIds.add(s.compactionId)
      const txPrune = txPrunes[0]!
      const intervalSeqs = txPrunes.flatMap(p => p.shadowedSeqs)
      const charsBefore = 0 // 日志无快照，账目重建不伪造数值
      const charsAfter = 0
      const intervalRecords = intervalSeqs.length > 0
        ? [{ start: intervalSeqs[0] as number, end: intervalSeqs[intervalSeqs.length - 1] as number, tombstoneSeq: end.endSeq }]
        : []
      const prunedAtoms: { id: number; type: AtomType; seq: number }[] = intervalSeqs.map(seq => ({ id: seq, type: typeOfSeq(seq), seq }))
      pushBounded(this.records, {
        at: String((s.lifecycle as { at?: unknown }).at ?? ''),
        compactionId: s.compactionId,
        intervals: intervalRecords,
        startEventSeq: s.seq,
        summaryEventSeq: txPrune.seq,
        endEventSeq: end.endSeq,
        shadowedSeqs: intervalSeqs,
        prunedAtoms,
        semanticEdges: 0,
        candidates: 0,
        charsBefore,
        charsAfter,
        forced: false,
      }, this.telemetryCap)
      for (const seq of intervalSeqs) {
        if (!this.prunedNodeIndex.has(seq)) {
          this.prunedNodeIndex.set(seq, {
            seq,
            type: typeOfSeq(seq), // 问题 8：真实类型反查（R/U 不再一律 'A'）
            turn: turnOfSeq(seq),
            firstLine: '(rebuilt from log) seq=' + seq,
            citedBySeq: [],
            eff: 0,
          })
        }
      }
    }
  }

  // 2026-09-21（P5 Wave 3 第 3 步）：detectOpenTurn 已迁 log-access 叶子
  // （与 peratom/compressor 的逐字相同实现收敛），本类改调导入的模块函数。
}

export default ArgpGraphEngine
