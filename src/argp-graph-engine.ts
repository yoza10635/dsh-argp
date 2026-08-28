/**
 * ARGP 建边版引擎（spike 5，M3）：原子化 + 建图 + 图序剪枝 + cites 义务。
 *
 * 按设计稿 §3-§7 移植，机制验证版简化（差异台账见 docs/design-vs-impl-trace.md）：
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
import { formatLogRow, formatRecallOutcome, nodeStateOf, queryLogRange, recallFromLog, stateHeader } from './log-access.js'
import type { NodeState as NodeStateLabel } from './log-access.js'
export type { NodeState, LogRow, LogRowType } from './log-access.js'
import { matchCitesTail, parseCitesBlock } from './cites-strip.js'
import type { ParsedCite, CiteLevel } from './cites-strip.js'
export type { ParsedCite, CiteLevel } from './cites-strip.js'
import { PeratomCompressor, type PeratomCompressorConfig } from './peratom/compressor.js'
import { CiteDeclarer, type CiteDeclarerConfig } from './peratom/cite-declarer.js'
import { RecallZoom, type RecallZoomConfig } from './peratom/recall-zoom.js'
import { ARG_NS, isArgpUserInfo } from './peratom/types.js'

export type AtomType = 'U' | 'A' | 'R' | 'X' // X = compact tombstone/checkpoint；dsh surface 无 tool/call 节点（call 块内嵌在 A 里，SURFACE_EVENT_TYPES 实测）

export interface Atom {
  id: number            // 本次投影内局部递增
  seq: number           // 事件 seq（surface 节点）
  type: AtomType
  turn: number
  text: string          // 模型可见文本（A 已剥离 cites JSON）
  toolCallIds: string[] // A：发出的 tool-call id；R：应答的 call id —— 配对键（成对同剪防孤儿）
  cites: ParsedCite[]   // 仅 A：声明的引用（前缀原文 + 级别；V6 分级契约，见 cites-strip.ts）
  citesFailed: boolean  // 仅 A：检测到 cites 尝试但解析失败 → 保守保护（§4.7）
  /**
   * P4（U-info 剪枝放行）：仅 U-info 聚合副本有值——原始用户消息的日志 seq
   * （recall_detail(sourceSeq) 的恢复目标）。dialog 副本（无 argp meta）与
   * 普通 user 消息均无此字段，故 `sourceSeq !== undefined` 即 U-info 识别判据：
   * ① isAtomCandidate 按 R 待遇参剪；② 排除出闭包 root（防 U-info 误当
   * task-init 根拖整段退休）。
   */
  sourceSeq?: number
}

export type EdgeLevel = 'critical' | 'supporting' | 'contextual'
export interface SemanticEdge { from: number; to: number; level: EdgeLevel }
export interface DeterministicEdge { from: number; to: number }
export const EDGE_WEIGHTS: Record<EdgeLevel, number> = { critical: 10, supporting: 5, contextual: 2 }
const LEVEL_ORDER: Record<string, number> = { isolated: 0, contextual: 1, supporting: 2, critical: 3 }

/** 比例预算纯函数：window = ctx × windowRatio；retain = window × retainRatio（缺省回退）。导出供测试。 */
export function scaleBudgets(
  contextWindow: number | undefined,
  opts: { windowRatio?: number; retainRatio?: number; explicitWindow?: number; explicitRetain?: number; fallbackWindow?: number; fallbackRetain?: number },
): { windowTokens: number; retainTokens: number } {
  const windowRatio = opts.windowRatio ?? 0.8
  const retainRatio = opts.retainRatio ?? 0.2
  if (opts.explicitWindow !== undefined && opts.explicitRetain !== undefined) {
    return { windowTokens: opts.explicitWindow, retainTokens: opts.explicitRetain }
  }
  if (contextWindow === undefined || contextWindow <= 0) {
    return { windowTokens: opts.fallbackWindow ?? 16_384, retainTokens: opts.fallbackRetain ?? 8_192 }
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
  turnGuard?: number      // 默认 2（最近 N 个 turn 的原子不参剪；独立于 recencyGuard）
  minSpanChars?: number   // 默认 0（微剪枝下限；>0 会放回小区间，易导致连续压缩）
  charsPerToken?: number  // 默认 3.5（触发与目标同基准；tokenMeter 可用时不再使用）
  /** 单次剪枝事务的最大贪心 pass 数（默认 16；生产档大批量剪枝应调高）。 */
  maxPasses?: number
  /** 触发保留余量（token）；默认 0。windowTokens 会先减去该值作为触发线。 */
  reserveTokens?: number
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
   * 上下文溢出恢复的最大重试次数（context-overflow trigger，默认 1，对齐官方
   * compaction-basic 的 maxOverflowRetries）。每次「模型请求 400 exceed_context_size
   * → 强制剪枝 → retry」消耗 1 次；超限后保留原始请求错误，不再循环。
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
   */
  disableCiteEdges?: boolean
  /**
   * P0 双引擎生产挂载（2026-08-28，docs/webui-liaison-2026-08-28.md 发现一）：非空时
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
   * P4 溢出三步序列第 ② 步：第一次溢出 forcePrune 后若仍超窗，
   * 回调对当前轮做 per-atom 降熵（PeratomCompressor.compressCurrentTurn：
   * U 拆分 / 大 R extract + 顺带补 cites），产生 surface 换代后由第 ③ 步
   * 再次 forcePrune 收尾。未注入（undefined）时退化为现役两步
   * （forcePrune → 保留原错误），行为与 0.3.x 完全一致。
   * 回调自身失败被吞掉（失败隔离：不影响后续 forcePrune 与原错误保留）。
   */
  onOverflowCompress?: (session: Session) => Promise<void>
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



/** 从一个事件投影出模型可见文本（text + tool-call 概要 + tool-result 内层 text；reasoning 不算）。 */
export function eventText(session: Session, seq: number): string {
  const event = session.events[seq]
  if (event === undefined) return ''
  const data = event.data as Record<string, unknown> | undefined
  const parts: string[] = []
  if (event.type === 'tool/call') {
    const d = data as { name?: string; arguments?: unknown }
    parts.push('[tool-call ' + (d?.name ?? '?') + '(' + (typeof d?.arguments === 'string' ? d.arguments : JSON.stringify(d?.arguments ?? {})) + ')]')
    return parts.join('\n')
  }
  // dsh event shapes differ by type: user/message carries content at data.content,
  // assistant/message and tool/result carry it at data.message.content.
  const rawContent = event.type === 'user/message'
    ? (data as { content?: unknown[] } | undefined)?.content
    : (data as { message?: { content?: unknown[] } } | undefined)?.message?.content
  const content = Array.isArray(rawContent) ? (rawContent as { type: string; text?: string; name?: string; arguments?: unknown; content?: { type: string; text?: string }[] }[]) : []
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    if (block.type === 'tool-call') {
      parts.push('[tool-call ' + (block.name ?? '?') + '(' + (typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments ?? {})) + ')]')
    }
    if (block.type === 'tool-result') {
      for (const inner of block.content ?? []) if (inner.type === 'text' && typeof inner.text === 'string') parts.push(inner.text)
    }
  }
  return parts.join('\n')
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
    surfaceOp: { op: 'replace', start: event.seq, end: event.seq },
    sourceEventSeqs: [event.seq],
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
  readonly windowRatio: number
  readonly retainRatio: number
  /** true = config 显式给 windowTokens；false = 运行时按 contextWindow × windowRatio 解析。 */
  private readonly explicitWindowTokens: boolean
  /** true = config 显式给 retainTokens；false = 运行时按 windowTokens × retainRatio 解析。 */
  private readonly explicitRetainTokens: boolean
  /** 最近一次 resolveScaledBudgets 解析出的有效预算（recall 预算等后续同步使用点读取）。 */
  private resolvedWindowTokens = 16_384
  readonly recencyGuard: number
  readonly turnGuard: number
  readonly minSpanChars: number
  readonly charsPerToken: number
  readonly maxPasses: number
  readonly reserveTokens: number
  readonly tokenMeterFn?: (session: Session) => { contextTokens: number; surfaceTokens: number }
  readonly enableSummarize: boolean
  readonly degradationStrategy: 'lifecycle' | 'summarize' | 'force' | 'fail'
  readonly sortMode: 'legacy' | 'density' | 'density-chain'
  readonly turnBasis: 'semantic' | 'all'
  readonly maxOverflowRetries: number
  /** P4 溢出三步第②步回调（undefined = 退化为现役两步）。 */
  readonly onOverflowCompress?: (session: Session) => Promise<void>
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
  /** 边价值实验 A₁ 离线重放：跳过 cites 边构建。 */
  disableCiteEdges = false
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
  /** context-overflow 恢复：每个 agent 的重试计数（assistant/message 成功或 idle 时重置）。 */
  private readonly overflowRetries = new WeakMap<Agent, number>()
  /** session → agent 映射，供成功后重置重试计数（agent loop 上下文经 session/event 取不到 agent）。 */
  private readonly overflowAgents = new WeakMap<Session, Agent>()
  /** 最近一次请求的真实 prompt token（usage.inputTokens + cacheReadTokens，provider 回报）。
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

  private session: Session | null = null
  private shadowedSession: Session | null = null
  private shadowedSet: Set<number> = new Set()
  private shadowedScanned = 0

  constructor(ctx: Context, config: ArgpGraphConfig = {}) {
    super(ctx)
    // 静态默认（兼容显式配置路径）：若 config 显式给 windowTokens/retainTokens 用之；
    // 否则运行时在 compactIfNeeded 按 contextWindow × ratio 解析（见 resolveScaledBudgets）。
    this.windowTokens = config.windowTokens ?? 16_384
    this.retainTokens = config.retainTokens ?? 8_192
    this.explicitWindowTokens = config.windowTokens !== undefined
    this.explicitRetainTokens = config.retainTokens !== undefined
    this.windowRatio = config.windowRatio ?? 0.8
    this.retainRatio = config.retainRatio ?? 0.2
    this.recencyGuard = config.recencyGuard ?? 4
    // turnGuard：最近 N 个完整 turn 不参剪。真会话中一个 turn 常有多个 surface 节点
    //（user / assistant-tool-call / tool-result / assistant-text），recencyGuard 只按节点
    // 位置保护可能截断当前轮，turnGuard 提供更自然的"最近 N 轮对话"语义保护。
    // 默认 1（等价于原 `a.turn >= latestTurn` 行为），真会话配置可提高到 2。
    this.turnGuard = config.turnGuard ?? 1
    // 微剪枝下限默认 0：大上下文下若保留 >0 阈值，小于该值的剪枝区间会被放回，
    // 导致可见量始终高于 retain 目标，触发连续压缩循环。如需启用请显式传入。
    this.minSpanChars = config.minSpanChars ?? 0
    this.charsPerToken = config.charsPerToken ?? 3.5
    this.maxPasses = config.maxPasses ?? 16
    this.reserveTokens = config.reserveTokens ?? 0
    this.tokenMeterFn = config.measureTokens
    // tokenMeter 不作为 required inject（避免测试/最小化组合缺少该服务时构造失败），
    // 运行时尝试从 ctx 获取；真会话中 dsh-token-meter 已挂载即可使用。
    try {
      this.tokenMeter = (ctx as any).tokenMeter ?? (ctx as any).get?.('tokenMeter')
    } catch {
      this.tokenMeter = undefined
    }
    this.enableSummarize = config.enableSummarize ?? false
    this.degradationStrategy = config.degradationStrategy ?? 'lifecycle'
    // 2026-08-23 拍板：默认 density（spike 18 离线 + spike 19 真实验证：同达成度下 recall 2→0、
    // 保留集单位信息量更高；eff 同档大 token 先剪 = 分数背包贪心）。需回退可显式传 sortMode:'legacy'。
    this.sortMode = config.sortMode ?? 'density'
    this.turnBasis = config.turnBasis ?? 'semantic'
    this.maxOverflowRetries = config.maxOverflowRetries ?? 1
    this.onOverflowCompress = config.onOverflowCompress
    this.closureWindowK = config.closureWindowK ?? 2
    // 默认 4：ASCII 词（如 "the"=3）被拒；CJK 双字（"读书"=2×2=4）放行（问题 5 修订）
    this.citeMinPrefixLen = config.citeMinPrefixLen ?? 4
    this.overlapTheta = config.overlapTheta ?? 0.8
    this.enableOverlapChain = config.enableOverlapChain ?? false
    this.injectEdges = config.injectEdges
    this.disableCiteEdges = config.disableCiteEdges ?? false
    // P0 双引擎自挂载：peratom 配置块存在时，Stage-1 三管线在构造期挂载并接线
    // （与 mountPeratomStack 同拓扑：三管线 hook 注册进 ctx 事件总线，本引擎作为
    // ctx.compaction 接收 injectEdges / onOverflowCompress）。
    if (config.peratom !== undefined) {
      if (config.onOverflowCompress !== undefined || config.injectEdges !== undefined) {
        console.warn('[argp-graph] peratom block set; explicit injectEdges/onOverflowCompress ignored (wired internally)')
      }
      const compressor = config.peratom.compressor === false ? null : new PeratomCompressor(ctx, config.peratom.compressor ?? {})
      const declarer = config.peratom.declarer === false ? null : new CiteDeclarer(ctx, config.peratom.declarer ?? {})
      const zoom = config.peratom.zoom === false ? null : new RecallZoom(ctx, config.peratom.zoom ?? {})
      if (declarer !== null) this.injectEdges = (atoms) => declarer.buildInjectEdges(atoms)
      if (compressor !== null) {
        this.onOverflowCompress = async (session: Session): Promise<void> => {
          await compressor.compressCurrentTurn(session)
        }
      }
      this.peratomStack = { compressor, declarer, zoom }
    }

    const recallTool = defineTool({
      name: 'recall_pruned',
      description: 'Retrieve the original text of any conversation node by its log seq, whether or not it is still in your visible context. Call it when your answer depends on content behind an [elided seq=N..M ...] placeholder, or when an earlier value is absent from the visible context. Pass one seq per call. The reply is prefixed with [recall seq=N state=shadowed|live|off-surface] so you know whether that content is currently visible. Everything ever said stays in the append-only log; never guess it. Use list_pruned (including its fromSeq/toSeq range mode) when you do not know the seq.',
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
        // （eventText 直接索引 session.events[seq]），只有越界才算失败；返回值带状态标签，
        // 使掉出可见上下文但未被 ARGP 替换的节点（适配器窗口丢弃 / 从不进 surface）也可召回。
        const shadowed = this.shadowedSeqsOf(this.session)
        const outcome = recallFromLog(this.session, seq, s => shadowed.has(s), eventText)
        this.recallCalls.push({ seq, hit: outcome.ok, state: outcome.ok ? outcome.state : undefined })
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
            this.recallResultSeq = this.session.events.length
            return result
          }
        }
        const result = formatRecallOutcome('recall_pruned', seq, outcome, text => this.budgetRecallText(text))
        // §3-3 recall 价值继承：记录"旧原子 seq → 本次 recall 结果将被 append 为的新 R 原子 seq"。
        // dsh 在工具 execute 返回后 append tool/result 事件，其 seq = 当前事件总数。
        this.recallSourceSeq = seq
        this.recallResultSeq = this.session.events.length
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
          const total = this.session.events.length
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
          const event = this.session.events[seq]
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

    // 被剪目录（动态部分）：每轮变化的“被剪节点列表”沉到 system message 最末尾（order 9999），
    // 让 persona + argp-contract 正文 + argp-cites 等静态 section 构成稳定前缀、可被 prefix cache 复用。
    // 根因修复：原实现把动态 catalog 拼进 order:150 的契约段，导致 system message 前缀每轮变、
    // 缓存从 catalog 处断开（2026-08-22 发现，A 臂测试缓存零命中）。recall 协议不依赖其在 system 靠前。
    ctx.systemPrompt.section({
      name: 'argp-catalog',
      order: 9999,
      text: () => this.catalogText(20, 70),
    })

    // 引用输出协议：独立 PromptSection，只负责 cites 格式；recall 行为不在这里要求。
    // V4 措辞（spike/24 实测）：明示"读了工具结果并作答 = 必须引用该结果"，
    // 比旧版"if used ... append"的被动式显著提升 t-long 类任务下的声明率。
    // V5 措辞（2026-08 修 UI 残留）：空引用时"完全不输出 block"而非写 {"cites":[]}。
    // 原因：dsh 核心的人类转录固定取 append 起源事件（replace 副本 model-only，
    // 见 core session surface.ts "replacement copies stay model-only"），surface
    // 剥离永远改不到 UI 显示；空块对引用图零信息（无入边），只能在源头不产出。
    // 引擎侧对"无块"本就是常态（§4.7），citeStats 对空/无块均不计 declared。
    ctx.systemPrompt.section({
      name: 'argp-cites',
      order: 151,
      text: () => 'Citation declaration (ARGP):\n'
        + 'In this session you frequently read files with read_file and answer from their content. EVERY time your final reply is based on a tool result you read, you MUST cite it.\n'
        + 'When your reply depends on at least one earlier item, append ONE JSON block to the end of your final reply:\n'
        + '{"cites":[...]}\n'
        + '- When you answered from a file you read, cite that file\'s tool result: copy verbatim the first 10-20 words of its content.\n'
        + '- Cite user instructions you followed and earlier assistant claims you built upon too.\n'
        + '- If your reply used nothing from earlier items, output no block at all — never an empty {"cites":[]} block.\n'
        + '- Grading (V6): by default a citation is supporting. When the cited item is load-bearing for a chain of decisions (a critical fact your whole answer stands on), you may declare it as: {"cites":[{"t":"<verbatim prefix>","l":"c"}]} — use "s" for supporting and "x" for contextual. Bare strings are treated as supporting.\n'
        + '- The block goes in the final reply body, never in reasoning. Output nothing after it.',
    })

    ctx.on('session/event', (session, event) => {
      if (event.type === 'turn/start') this.recallCallsThisTurn = 0
      // 声明窗口缓存（2026-08-28 真环境联调）：request/context 事件携带适配器声明的
      // contextWindow（settings 模型条目），是权威口径。pre-step 压力检查可能早于首个
      // request/context 事件落账（新会话 turn-1），此缓存使后续检查/重启会话立即拿到
      // 声明值，不再退化为物理窗口探测（llama.cpp 场景 262144 vs 声明 32000，7.7× 口径差）。
      if (event.type === 'request/context') {
        const declared = (event.data as { contextWindow?: number } | undefined)?.contextWindow
        if (typeof declared === 'number' && declared > 0) {
          const previous = this.declaredContextWindows.get(session)
          if (previous !== undefined && previous !== declared) {
            console.log(`[argp-graph] declared contextWindow changed: ${previous} -> ${declared}`)
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
          console.warn(`[argp-graph] foreign compaction detected (id=${cid}, turn=${(event.data as { turn?: number }).turn ?? '?'})`
            + ' — a non-ARGP compaction engine is active; lossy summarization may pre-empt graph pruning'
            + ' (see docs/webui-liaison-2026-08-28.md 发现二)')
        }
      }
      // 真实 token 锚点（2026-08-23）：assistant/message 携带 provider 回报的 usage，
      // inputTokens（未命中）+ cacheReadTokens（命中）= 本次请求的真实 prompt token。
      // pressure check 优先用它，避免 tokenMeter chars/4 低估导致的迟触发。
      if (event.type === 'assistant/message') {
        const usage = (event as { data?: { usage?: { inputTokens?: number; cacheReadTokens?: number } } }).data?.usage
        const seq = (event as { seq?: unknown }).seq
        if (usage !== undefined && typeof usage.inputTokens === 'number') {
          this.lastRealPromptTokens = (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0)
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
        ctx.logger.warn(`argp-graph overflow recovery exhausted (retries=${retries}); preserving the original request error`)
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
          ctx.logger.warn(`argp-graph overflow per-atom compress failed: ${message}; relying on step-3 forcePrune`)
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
          ctx.logger.warn(`argp-graph overflow prune failed after durable surface progress: ${message}; retrying from the replacement surface`)
          this.overflowRetries.set(agent, retries + 1)
          return { kind: 'retry' }
        }
        ctx.logger.warn(`argp-graph overflow prune failed: ${message}; ${signal.aborted ? 'cancellation prevents retry' : 'preserving the original request error'}`)
        return next()
      }
      if (signal.aborted || session.surface.replaceGeneration <= genBefore) return next()
      if (result !== null) {
        ctx.logger.info(
          `argp-graph context-overflow step-${isStepOne ? 1 : 3} prune: shadowed ${result.shadowedSeqs.length} surface nodes `
          + `(seqs ${result.shadowedRange.start}-${result.shadowedRange.end}, ~${result.shadowedTokenCount} tokens)`,
        )
      }
      this.overflowRetries.set(agent, retries + 1)
      return { kind: 'retry' }
    })
    ctx.on('agent/pre-step', async ({ agent, signal }, next): Promise<PreStepDecision> => {
      this.bindSession(agent.session) // A7（问题 3）：生产 resume 点，账目缺失时自动重建
      if (!signal.aborted) {
        try {
          await this.compactIfNeeded(agent, 'pressure', signal)
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error)
          console.error('[argp-graph] pressure prune FAILED: ' + message + (error instanceof Error && error.stack ? '\n' + error.stack.split('\n').slice(0, 6).join('\n') : ''))
          ctx.logger.warn(`argp-graph pressure prune failed: ${message}; continuing the turn`)
        }
      }
      return next()
    })
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
  }

  setSession(session: Session): void {
    this.bindSession(session)
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
      const event = this.session.events[seq]
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
      const event = this.session.events[seq]
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
    this.recallQueryCalls.push({ query, count: selected.length, hits: selected.length })
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
    for (let index = this.shadowedScanned; index < session.events.length; index += 1) {
      const event = session.events[index]
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
    this.shadowedScanned = session.events.length
    return this.shadowedSet
  }

  /**
   * 程序化 recall（RecallHandle 语义）：**仅**命中被遮蔽节点，未命中返回 null。
   * 这是给宿主/测试用的窄接口，故意保留 pruned-only 语义（spike/11/12/13/16 的
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

  /** 原子化（§4.1）：只投影 surface 节点；U/X/R/A 四类（tool/call 不进 surface，无 T 类）。cites 统计在 A 原子处累计。 */
  atomize(session: Session): Atom[] {
    const atoms: Atom[] = []
    for (const seq of session.surface.nodes) {
      const event = session.events[seq]
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
    if (this.injectEdges !== undefined) {
      const validIds = new Set(atoms.map(a => a.id))
      for (const e of this.injectEdges(atoms)) {
        if (e.from !== e.to && validIds.has(e.from) && validIds.has(e.to)) edges.push(e)
      }
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
   *  dsh tokenMeter / 配置函数 / 字符估算。 */
  private measureTokens(session: Session): { contextTokens: number; surfaceTokens: number } {
    const surfaceTokens = Math.ceil(this.visibleChars(session) / this.charsPerToken)
    if (this.lastRealAnchorSeq >= 0 && this.lastRealPromptTokens > 0) {
      // 真实锚点（上轮 provider usage）只覆盖锚点 seq 之前的内容；其后 surface 新增
      // 节点（user/assistant/tool 事件）按字符估算增量。增量通常远小于全量，估算偏差
      // 只作用于增量 → 总误差从 ±30% 降到几个百分点。
      let deltaChars = 0
      for (const seq of session.surface.nodes) {
        if (seq > this.lastRealAnchorSeq) deltaChars += eventText(session, seq).length
      }
      const deltaTokens = Math.ceil(deltaChars / this.charsPerToken)
      return { contextTokens: this.lastRealPromptTokens + deltaTokens, surfaceTokens }
    }
    if (this.tokenMeter !== undefined) {
      try {
        const m = this.tokenMeter.measure(session)
        return { contextTokens: m.totalTokens, surfaceTokens: m.surfaceTokens }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.warn('[argp-graph] tokenMeter.measure failed, falling back: ' + message)
      }
    }
    if (this.tokenMeterFn !== undefined) return this.tokenMeterFn(session)
    return { contextTokens: surfaceTokens, surfaceTokens }
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
      const issuerEvent = this.session?.events[issuer.seq]
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
   * 等非 surface 事件也算进来，与 compactIfNeeded / tryPruneClosures 用的
   * "atoms（surface 节点）最大 turn" 口径不一致 —— 同一个防抖判定两端基准不同。
   * 现统一为 surface 节点口径；turnBasis='semantic'（默认）时进一步排除注入型 X 节点，
   * 使纯注入不推进轮次、不抬高 latestTurn-k 保护线。
   */
  latestTurnOf(session: Session): number {
    let max = 0
    for (const seq of session.surface.nodes) {
      const event = session.events[seq]
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
   * tryPruneClosures 每 pass 都给所有 root 重发新 id，导致此处写入的旧 id 与
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
   *  `alreadyPruned` 用于排除已由正常候选/版本重复剪过的原子——修复前 tryPruneClosures
   *  按整闭包（含已剪原子）独立剪枝并 return，导致正常候选成果被丢弃；现改为"选择并入
   *  pruned、统一事务剪"，闭包原子需与已剪集合去重（如 A1/A2 已正常剪 → 闭包仅剩 root U，
   *  单独退休 root U 是有意设计：P5 注释"自动闭包生命周期确实会连 root U 一起剪除"）。 */
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
    const position = new Map(surfaceSeqs.map((seq, i) => [seq, i]))
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

  /** P2：尝试按闭包生命周期剪除一个 PRUNABLE 闭包。返回 CompactionResult 或 null。 */
  tryPruneClosures(
    session: Session,
    atoms: Atom[],
    edges: SemanticEdge[],
    inDegree: Map<number, number>,
    askCover: Map<number, number>,
    latestTurn: number,
  ): CompactionResult | null {
    // 2026-08-22：选择逻辑抽到 selectClosureToMerge（供 compactIfNeeded 降级链并入 pruned 复用），
    // 本方法保持"独立闭包事务"语义（手动/独立路径）；执行段不变。
    const chosen = this.selectClosureToMerge(session, atoms, edges, inDegree, askCover, latestTurn, new Set<number>())
    if (chosen === null) return null
    const intervals = chosen.intervals
    for (const iv of intervals) {
      for (const a of iv.atoms) {
        const citedBySeq = edges.filter(e => e.to === a.id).map(e => atoms[e.from]?.seq).filter((x): x is number => x !== undefined)
        const firstLine = a.text.split('\n').map(l => l.trim()).find(l => l !== '') ?? ''
        this.prunedNodeIndex.set(a.seq, {
          seq: a.seq,
          type: a.type,
          turn: a.turn,
          firstLine: firstLine.length > 120 ? firstLine.slice(0, 120) + '…' : firstLine,
          citedBySeq,
          // 闭包剪枝没有 eff map；用 selfImportance 近似（A=5/U=3/R=0；P4：U-info 按 R=0）
          eff: a.type === 'A' ? 5 : (a.type === 'U' && a.sourceSeq === undefined ? 3 : 0),
        })
      }
    }
    // P3/P6：tombstone 必须自带 seq 区间（否则 tombstone-within-tombstone 两跳后 seq 信息
    // 彻底丢失，模型无法 recall），并给出「本区间 K / 闭包合计 N」消歧 —— 同一闭包跨多个
    // 区间时各 tombstone 的计数都是局部准确值，缺少 N 会让模型误判数据脏。
    const closureTotal = chosen.seqs.length
    const tombstones = intervals.map(iv => ({
      type: 'user' as const,
      text: '[elided closure ' + chosen.closureId
        + ' seqs=' + iv.seqs[0] + '..' + iv.seqs[iv.seqs.length - 1]
        + ': ' + iv.seqs.length + ' of ' + closureTotal + ' surface nodes in this closure'
        + ' pruned by ARGP closure lifecycle; root=' + chosen.rootPreview
        + '; recall_pruned(seq) retrieves original]',
    }))
    const result = this.pruneIntervals(session, intervals, 0, 0, false, tombstones)
    this.closurePrunes.push({
      closureId: chosen.closureId,
      rootSeq: chosen.root.seq,
      prunedSeqs: chosen.seqs,
      at: new Date().toISOString(),
    })
    return result
  }

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
          const info = await llm.resolveModelInfo(provider, model, new AbortController().signal)
          contextWindow = info.context?.contextWindow
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
      console.log('[argp-graph] declared contextWindow not yet known; early pressure checks will skip until the first request/context lands')
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
   * 压力剪枝（§4.3/§4.5）：估算量 ≥ windowTokens 时重建图，按排序键逐弱剪至 ≤ retainTokens。
   * 候选：A/T/R、语义入度 0、非近因豁免区、非最新轮、非保守保护；U/X 永不参剪。
   * 排序键（§4.5）：最低关联语义级别升 → effective_importance 升 → lastRefRound 升 → seq 升。
   * 候选耗尽仍超预算 → force_prune（忽略入度，§4.6.2）。
   *
   * trigger='context-overflow'（官方溢出恢复，见 agent/request-error 钩子）：
   * 模型请求已被 provider 确认超出上下文（400 exceed_context_size_error）——估算量
   * 可能与实际请求偏差（估算低于触发线但请求已撞墙），此时**跳过 pressure 门槛强制
   * 剪枝**，剪到 retain 目标（≈1/5 窗口，远低于 n_ctx）后由钩子重发请求。
   */
  override async compactIfNeeded(
    agent: CompactionAgentContext,
    trigger: CompactionTrigger,
    _signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    const session = agent.session
    this.bindSession(session) // A7（问题 3）：compactIfNeeded 也走统一绑定（含账目懒重建）
    const { windowTokens, retainTokens, declaredKnown } = await this.resolveScaledBudgets(agent)
    const thresholdTokens = windowTokens - this.reserveTokens
    if (thresholdTokens <= 0) {
      console.log('[argp-graph] pressure check: reserveTokens exceeds windowTokens, skip')
      return null
    }
    const retainChars = retainTokens * this.charsPerToken
    const measurement = this.measureTokens(session)
    // 声明窗口未知时的早检跳过（2026-08-28）：物理口径宁可不用（宁缺勿错）；
    // context-overflow 触发除外——那是 provider 确认的真实溢出，必须处置。
    if (trigger !== 'context-overflow' && !declaredKnown) {
      console.log('[argp-graph] pressure check: declared contextWindow unknown, skip (will check after first request/context)')
      return null
    }
    if (trigger !== 'context-overflow' && measurement.contextTokens < thresholdTokens) {
      console.log('[argp-graph] pressure check: contextTokens=' + measurement.contextTokens + ' < threshold=' + thresholdTokens + ', skip')
      return null
    }

    const atoms = this.atomize(session)
    const { edges, deterministicEdges, inDegree } = this.buildGraph(atoms)
    // 动态有效入度（§5.4 反向拓扑链式解锁）：每 pass 从"未被剪原子的边"重推，
    // 剪除引用方后其出边消失 → 目标入度递减。多引用场景（A/C/D 都引用 B）下
    // B 须等全部引用方被剪才解锁，天然正确；重复 cites 也按边数逐条减。
    let curInDegree = inDegree
    const surfaceSeqs = [...session.surface.nodes]
    const position = new Map(surfaceSeqs.map((seq, i) => [seq, i]))
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
    const isAtomCandidate = (a: Atom, allowInDegree: boolean): boolean => {
      if (a.type === 'U' && a.sourceSeq === undefined) {
        // 普通 U（含 task-init dialog）：ask-exempt 路径——须被首个 A 的 supporting
        // 边覆盖才参剪。dialog 永不剪不变（无覆盖 → 不可剪）。
        const coverer = askCoverage.get(a.id)
        if (coverer === undefined) return false
        const pos = position.get(a.seq)
        if (pos === undefined || pos >= recencyCut) return false
        if (a.turn > latestTurn - this.turnGuard) return false
        // 动态复核：所有保留入边都必须来自覆盖者，否则豁免失效
        const incoming = edges.filter(e => e.to === a.id)
        if (incoming.length === 0 || incoming.some(e => e.from !== coverer)) return false
        return true
      }
      // P4：U-info（a.sourceSeq 有值）按 R 待遇参剪——跳过 ask-exempt（其不是 ask
      // 文本、永远拿不到覆盖），走下方与 A/R 相同的 recencyGuard/turnGuard/
      // citesFailed/入度门槛。dialog 不受影响（仍走上方 ask-exempt 分支）。
      if (a.type !== 'A' && a.type !== 'R' && a.type !== 'U') return false
      const pos = position.get(a.seq)
      if (pos === undefined || pos >= recencyCut) return false
      if (a.turn > latestTurn - this.turnGuard) return false
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
        const groupRs = atoms.filter(x => x.type === 'R' && a.toolCallIds.includes(x.toolCallIds[0] ?? ''))
        for (const r of groupRs) groupIds.add(r.id)
        if (groupRs.length > 0) {
          const aCitesR = edges.some(e => e.from === a.id && groupRs.some(r => e.to === r.id))
          // R 的外部入边：语义边来自组外原子，或确定性边来自组外原子（其他 A 调用了同一 callId 链）
          const anyRExternalIncoming = groupRs.some(r =>
            (curInDegree.get(r.id) ?? 0) > 0 || // 语义入度（cites）——已含组外来源
            deterministicEdges.some(e => e.to === r.id && !groupIds.has(e.from))) // 确定性：组外 A→R
          if (!aCitesR && !anyRExternalIncoming) return false
        }
      }
      if (!allowInDegree && (curInDegree.get(a.id) ?? 0) > 0) return false
      return true
    }
    const isGroupCandidate = (g: Atom[], allowInDegree: boolean): boolean =>
      g.every(a => isAtomCandidate(a, allowInDegree))

    const softCandidateGroups = groups.filter(g => isGroupCandidate(g, false)).length
    const pruned = new Map<number, Atom>()
    // 2026-08-22：闭包原子归属（seq → 闭包元数据），intervals/tombstone 生成时按归属区分
    // 闭包区间（P3/P6：闭包 tombstone 带 root/计数供 recall 消歧）与默认区间。
    const closureSeqMeta = new Map<number, { closureId: string; rootPreview: string; closureTotal: number }>()
    const { dupIds: duplicateIds, chainLen, latestRByKey, rKeyByRId } = this.findVersionDuplicates(atoms, inDegree)
    for (const id of duplicateIds) {
      const atom = atoms.find(a => a.id === id)
      if (atom !== undefined) pruned.set(id, atom)
    }
    // 排序键（§4.5 + spike 18 提案）：默认 legacy = [lvl, eff, lastRef, seq]；
    // density = eff 同档内 token 降序（大 token 先剪）；density-chain = density + 链代表 eff 叠加。
    const sortKey = (a: Atom): string => {
      const lvl = touchesSemantic.has(a.id) ? LEVEL_ORDER.supporting : LEVEL_ORDER.isolated
      const effV = eff.get(a.id) ?? 0
      if (this.sortMode === 'legacy') {
        return [lvl, effV, lastRef.get(a.id) ?? 0, a.seq].map(n => String(n).padStart(10, '0')).join('|')
      }
      const chainBonus = this.sortMode === 'density-chain' ? (chainLen.get(a.id) ?? 1) - 1 : 0
      // density/density-chain：token 降序（负数入键，大 token 数值小排前）
      const tokNeg = -Math.ceil(a.text.length / this.charsPerToken)
      return [lvl, effV + chainBonus, tokNeg, lastRef.get(a.id) ?? 0, a.seq].map(n => String(n).padStart(10, '0')).join('|')
    }
    let forced = false
    for (let pass = 0; pass < this.maxPasses; pass += 1) {
      // 每 pass 重推有效入度：已剪原子的出边不再计入目标入度（链式解锁）
      curInDegree = new Map<number, number>()
      for (const e of edges) {
        if (pruned.has(e.from)) continue
        curInDegree.set(e.to, (curInDegree.get(e.to) ?? 0) + 1)
      }
      const remaining = atoms.filter(a => !pruned.has(a.id))
      const visible = remaining.reduce((sum, a) => sum + a.text.length, 0)
      if (visible <= retainChars) break
      const liveGroups = groups.filter(g => g.some(a => !pruned.has(a.id)))
      let candidateGroups = liveGroups.filter(g => isGroupCandidate(g, false))
      if (candidateGroups.length === 0) {
        // 2026-08-22 降级链完整化：候选耗尽时不再 return 丢弃累积 pruned——原 tryPruneClosures
        // 的 return 把正常候选 + 版本重复全部作废，每次压缩只剪 1 个闭包（2-10 原子），
        // 25 次压缩剪除率 0-2%（"压缩饿死"，见 docs/engine-fix-2026-08-22-compaction-starvation.md）。
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
          this.closurePrunes.push({
            closureId: closure.closureId,
            rootSeq: closure.root.seq,
            prunedSeqs: closure.seqs,
            at: new Date().toISOString(),
          })
          continue // 重推后继续：可能还有更多可剪闭包 / force
        }
        if (this.degradationStrategy === 'summarize' && this.enableSummarize) {
          const summarizeResult = this.summarizeCriticalChain(session, atoms, edges, latestTurn)
          if (summarizeResult !== null) return summarizeResult
        }
        candidateGroups = liveGroups.filter(g => isGroupCandidate(g, true)) // force_prune：忽略入度
        if (candidateGroups.length === 0) break
        forced = true
      }
      const groupKey = (g: Atom[]): string => g.map(sortKey).sort()[0] as string
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
    const prunedSeqs = [...pruned.values()].map(a => a.seq).sort((x, y) => x - y)
    const intervals: { seqs: number[]; chars: number; atoms: Atom[]; hasSoloR: boolean }[] = []
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
    const keptRaw = intervals.filter(iv => iv.chars >= this.minSpanChars)
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
      if (rest.chars >= this.minSpanChars) kept.push(rest)
    }
    kept.push(...rescued)
    kept.sort((x, y) => (x.seqs[0] as number) - (y.seqs[0] as number))
    const droppedIntervals = intervals.length - kept.length
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
    const tombstoneTexts: ({ type: 'user'; text: string } | { type: 'tool'; seq: number; callId: string })[] = kept.map(iv => {
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
        const range = this.selectManualRange(agent.session)
        if (range === null) return null
        return this.compactRegion(range.start, range.end, agent, opSignal)
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
    const startIdx = nodes.indexOf(start)
    const endIdx = nodes.indexOf(end)
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
      // P5：措辞 scoped 到手动入口。自动闭包生命周期（tryPruneClosures）确实会连 root U
      // （task-init）与 X checkpoint 一起剪除；"ARGP never prunes U/X" 只对本手动入口成立。
      throw new Error('compactRegion (manual) does not prune U/X spans; choose a span without U/X, '
        + 'or let the automatic closure lifecycle retire those nodes together with their closure')
    }
    if (intervalAtoms.length === 0) {
      throw new Error('compactRegion: selected span contains no prunable A/R atoms')
    }
    const chars = intervalAtoms.reduce((sum, a) => sum + a.text.length, 0)
    const interval = { seqs: shadowedSeqs, chars, atoms: intervalAtoms }
    return this.pruneIntervals(session, [interval], 0, 0, true)
  }

  /** 为手动 compactNow 选择一个确定性的最老 A/R 连续块。 */
  private selectManualRange(session: Session): { start: number; end: number } | null {
    const surfaceSeqs = session.surface.nodes
    const atoms = this.atomize(session)
    const bySeq = new Map(atoms.map(a => [a.seq, a]))
    const latestTurn = atoms.reduce((m, a) => Math.max(m, a.turn), 0)
    const recencyCut = Math.max(0, surfaceSeqs.length - this.recencyGuard)
    let start: number | null = null
    let end = -1
    for (let i = 0; i < surfaceSeqs.length; i += 1) {
      const seq = surfaceSeqs[i]
      const atom = bySeq.get(seq)
      if (atom === undefined || atom.type === 'U' || atom.type === 'X' || atom.turn > latestTurn - this.turnGuard || i >= recencyCut) {
        if (start !== null) break
        continue
      }
      if (start === null) start = seq
      end = seq
    }
    if (start === null) return null
    return { start, end }
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
  ): CompactionResult {
    const charsBefore = this.visibleChars(session)
    const openTurn = this.detectOpenTurn(session)
    const compactionId = CompactionId('argp-graph-' + randomUUID())
    const lifecycle = { compactionId, turn: openTurn }
    const allSeqs = intervals.flatMap(iv => iv.seqs)
    const first = intervals[0]?.seqs[0] ?? 0
    const last = intervals[intervals.length - 1]?.seqs[intervals[intervals.length - 1]!.seqs.length - 1] ?? first

    const startEvent = session.append('compaction/start', {
      ...lifecycle,
      // /compact 溯源：发起命令 ID 随事务事件落账（UI presentation correlation）
      ...this.compactSourceCommandId === undefined ? {} : { sourceCommandId: this.compactSourceCommandId },
    })
    try {
      const shadowedTokenCount = Math.ceil(intervals.reduce((s, iv) => s + iv.chars, 0) / this.charsPerToken)
      const resolvedTombstones = tombstones !== undefined && tombstones.length === intervals.length
        ? tombstones
        : intervals.map(iv => ({
            type: 'user' as const,
            text: '[elided seq=' + iv.seqs[0] + '..' + iv.seqs[iv.seqs.length - 1]
              + ': ' + iv.seqs.length + ' surface nodes pruned by ARGP (graph order, cites-aware'
              + (forced ? ', forced' : '') + '); recall_pruned(seq) retrieves original]',
          }))
      // 0-LLM 剪枝使用 compaction/prune shadow-price 事件（替代 summary）
      const pruneEvent = session.append('compaction/prune', {
        shadowedRange: { start: first, end: last },
        shadowedSeqs: allSeqs,
        shadowedTokenCount,
      })
      const intervalRecords: { start: number; end: number; tombstoneSeq: number }[] = []
      for (let i = 0; i < intervals.length; i += 1) {
        const iv = intervals[i]
        if (iv === undefined) continue
        const start = iv.seqs[0] as number
        const end = iv.seqs[iv.seqs.length - 1] as number
        const ts = resolvedTombstones[i]
        if (ts !== undefined && ts.type === 'tool' && iv.seqs.length === 1) {
          // tool 占位墓碑：克隆原 R data，只改 tool-result block 的 inner text
          const origEvent = session.events[ts.seq] as { data?: Record<string, unknown> } | undefined
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
              surfaceOp: { op: 'replace', start: ts.seq, end: ts.seq },
              sourceEventSeqs: [startEvent.seq, pruneEvent.seq, ...iv.seqs],
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
          surfaceOp: { op: 'replace', start, end },
          sourceEventSeqs: [startEvent.seq, pruneEvent.seq, ...iv.seqs],
        })
        intervalRecords.push({ start, end, tombstoneSeq: tombstone.seq })
      }
      const endEvent = session.append('compaction/end', lifecycle)
      const charsAfter = this.visibleChars(session)
      this.records.push({
        at: new Date().toISOString(),
        compactionId,
        ...this.compactSourceCommandId === undefined ? {} : { sourceCommandId: this.compactSourceCommandId },
        intervals: intervalRecords,
        startEventSeq: startEvent.seq,
        summaryEventSeq: pruneEvent.seq,
        endEventSeq: endEvent.seq,
        shadowedSeqs: allSeqs,
        prunedAtoms: intervals.flatMap(iv => iv.atoms.map(a => ({ id: a.id, type: a.type, seq: a.seq }))),
        semanticEdges,
        candidates: candidateCount,
        charsBefore,
        charsAfter,
        forced,
      })
      // P7：一笔 compaction 事务成功即重置 recall 字数预算（视图已换代，旧累计不应继续压制新一轮召回）
      this.recallCharsUsed = 0
      // 2026-08-23：压缩换代 surface——旧真实锚点（压缩前的 provider usage）失效，
      // 若保留会用大锚点 + 增量导致压缩后立即误触发。用压缩后 surface 估算重置锚点
      // （压缩后 surface 小、估算误差影响小；下一次请求的 usage 会再次精确锚定）。
      const nodes = session.surface.nodes
      const tailSeq = nodes.length > 0 ? nodes[nodes.length - 1] : -1
      this.lastRealPromptTokens = Math.ceil(this.visibleChars(session) / this.charsPerToken)
      this.lastRealAnchorSeq = typeof tailSeq === 'number' ? tailSeq : this.lastRealAnchorSeq
      return {
        compactionId,
        startSeq: startEvent.seq,
        summarySeq: pruneEvent.seq,
        endSeq: endEvent.seq,
        summary: resolvedTombstones.map(ts => ({ type: 'text', text: ts.type === 'tool'
          ? '[elided tool result; recall_pruned(seq) retrieves original]' : ts.text })),
        shadowedRange: { start: first, end: last },
        shadowedSeqs: allSeqs,
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
    const events = this.session.events
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
      const event = this.session?.events[seq]
      if (event === undefined) return 'X'
      if (event.type === 'user/message') return classifyUserMessage(event.data)
      if (event.type === 'assistant/message') return 'A'
      if (event.type === 'tool/result') return 'R'
      return 'X'
    }
    const turnOfSeq = (seq: number): number => {
      const event = this.session?.events[seq]
      const turn = (event?.data as { turn?: unknown } | undefined)?.turn
      return typeof turn === 'number' ? turn : 0
    }
    // 逐 start 配对：找到该事务的 prune（start 后最近的 compaction/prune）与 end
    for (const s of starts) {
      // 幂等守卫：已重建过则跳过（防止 setSession 自动重建后，测试显式 rebuildLedgerFromLog 再重建）
      if (this.rebuiltCompactionIds.has(s.compactionId)) continue
      const prune = prunes.find(p => p.seq > s.seq)
      const end = endByStart.get(s.seq)
      if (end === undefined) {
        // 未闭合 start：仅告警，不重建记录；标记已处理防止重复告警
        if (!this.rebuiltCompactionIds.has(s.compactionId)) {
          this.auditWarnings.push('unclosed compaction start at seq ' + s.seq + ' (compactionId=' + s.compactionId + '); transaction may have been interrupted')
          this.rebuiltCompactionIds.add(s.compactionId)
        }
        continue
      }
      if (prune === undefined) continue
      // 标记已重建（重建后不重复，防止再次 rebuildLedgerFromLog 时追加）
      this.rebuiltCompactionIds.add(s.compactionId)
      const intervalSeqs = prune.shadowedSeqs
      const charsBefore = 0 // 日志无快照，账目重建不伪造数值
      const charsAfter = 0
      const intervalRecords = intervalSeqs.length > 0
        ? [{ start: intervalSeqs[0] as number, end: intervalSeqs[intervalSeqs.length - 1] as number, tombstoneSeq: end.endSeq }]
        : []
      const prunedAtoms: { id: number; type: AtomType; seq: number }[] = intervalSeqs.map(seq => ({ id: seq, type: typeOfSeq(seq), seq }))
      this.records.push({
        at: String((s.lifecycle as { at?: unknown }).at ?? ''),
        compactionId: s.compactionId,
        intervals: intervalRecords,
        startEventSeq: s.seq,
        summaryEventSeq: prune.seq,
        endEventSeq: end.endSeq,
        shadowedSeqs: intervalSeqs,
        prunedAtoms,
        semanticEdges: 0,
        candidates: 0,
        charsBefore,
        charsAfter,
        forced: false,
      })
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

  /** 日志尾部的 open turn（pre-step 时刻用于 compaction 括号的 owner）。 */
  private detectOpenTurn(session: Session): number | null {
    for (let index = session.events.length - 1; index >= 0; index -= 1) {
      const event = session.events[index]
      if (event === undefined) continue
      if (event.type === 'turn/start') return (event.data as { turn: number }).turn
      if (event.type === 'turn/end') return null
    }
    return null
  }
}

export default ArgpGraphEngine
