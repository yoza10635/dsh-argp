/**
 * ARGP 通用类型叶子模块（P5 结构重构 Wave 3 第 1 步）。
 *
 * 本模块是**叶子**：只含类型定义 + 纯常量，不 import 任何 src 运行时模块。
 * 唯一依赖是 `cites-strip` 的 `ParsedCite`（type-only import，编译期擦除；
 * cites-strip 本身是零依赖叶子），故运行时零依赖、类型图无环。
 *
 * 背景（C 报告 S3）：最通用的类型 `Atom` / `SemanticEdge` / `DeterministicEdge` 原先
 * 定义在 3,313 行的 hub `argp-graph-engine.ts` 里，被 peratom/* 反向 import
 * （cite-declarer / mount 取类型、recall-zoom 取 eventText）⇒ 模块回边，阻碍
 * peratom 独立单测与按需加载。现将通用类型收敛到本叶子，依赖方向变为
 * peratom → argp-types（叶子），回边消除。
 *
 * 留在 hub 的类型：`ArgpGraphConfig`——它引用 peratom 三个管线 config
 * （PeratomCompressorConfig / CiteDeclarerConfig / RecallZoomConfig）与
 * PresetCleanOptions，若迁入本叶子会迫使 argp-types 反向 import peratom，
 * 形成类型环并破坏叶子性，故按「深度依赖则留 hub」原则保留在引擎侧。
 */
import type { ParsedCite } from './cites-strip.js'

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

/**
 * 语义边级别。v1.2.0 起含 'inferred'（PROPOSAL-token-ontology 组件 A）：
 * 承重 token 逐字包含派生边——模型声明通道（cites / declarer）空窗时的**保底层**，
 * 0 LLM、构造性 I-A1（∃ token 双端逐字在场）。保护度低于任何声明档（权重 1 < contextual 2），
 * 高于无边原子；声明边先行去重（buildGraph 在 cites/inject 之后合并，同 (from,to) 先到者胜）。
 */
export type EdgeLevel = 'critical' | 'supporting' | 'contextual' | 'inferred'
export interface SemanticEdge { from: number; to: number; level: EdgeLevel }
export interface DeterministicEdge { from: number; to: number }
export const EDGE_WEIGHTS: Record<EdgeLevel, number> = { critical: 10, supporting: 5, contextual: 2, inferred: 1 }
export const LEVEL_ORDER: Record<string, number> = { isolated: 0, contextual: 1, supporting: 2, critical: 3 }

/**
 * UI 设置页可调旋钮（Settings → Plugins → Configurable → ARGP）。
 * 服务端经 ctx.inject(['settings']) → settings.register('dsh-argp', schema, { base })
 * 注册 namespace，base=引擎 cordis 配置；客户端 ArgpConfigCard 经 ctx.settingsScope.bind 读写。
 * 字段即引擎构造期读取的顶层旋钮。
 */
export interface ArgpUserSettings {
  windowRatio: number
  retainRatio: number
  maxPasses: number
  recencyGuard: number
  turnGuard: number
  minSpanChars: number
  enableSummarize: boolean
  sortMode: 'legacy' | 'density' | 'density-chain'
  charsPerToken: number
}
