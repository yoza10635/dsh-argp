/**
 * 单会话运行时状态（1.11.0-beta.0「会话所有权」批，1-1；2.0 factor-only 收窄）。
 *
 * 病灶（〔Q〕M4 / 〔K〕P1-1，双 BLOCKER）：引擎把这些字段做成**进程级单例**——
 * 台账（prunedNodeIndex / records）、召回预算与计数、shadowed 增量游标、
 * usage 锚点、账本重建去重集全部挂在实例上。多会话/多代理宿主里
 * A→B 切换时 B 读到 A 的剪枝索引（同 seq 不同内容 = 跨会话泄漏）、A 的预算压制 B 的
 * 召回、A 的锚点让 B 误触发。
 *
 * 修法：全部字段收进本状态对象，引擎经 `WeakMap<Session, SessionRuntimeState>`
 * 分桶（`stateOf(session)` 懒建）。**同步方法**经引擎上的 getter 兼容层
 * 读"当前焦点会话"的桶（sync 期间焦点不可变，安全）；**异步路径**（召回工具执行、
 * 账本重建）显式线程 session，不得依赖焦点指针。
 *
 * 2.0（factor-only）：图臂专属字段（边集/闭包/frozen catalog/守卫覆盖/关键词召回统计）
 * 随 stage-2 图剪退役；保留的全是 factor 事务与本会话可观测面实际读写的字段。
 *
 * 依赖方向：本模块是**类型叶子**——只 import type 与无依赖的 constants 常量，
 * 无运行时依赖、无环。
 */
import { DEFAULT_WINDOW_TOKENS } from './constants.js'
import type { Session } from '@deepseek-ai/dsh-session'
import type { AtomType } from './argp-types.js'
import type { CiteStats } from './graph-build.js'
import type { GraphPruneRecord } from './prune-tx.js'
import type { NodeState } from './log-access.js'

/**
 * 已剪节点目录条目（seq -> 元数据）。原定义在 prune-selection（图剪选择器），
 * 2.0 随选择器退役迁入本叶子——账本重建与 /argp 仍读它。
 */
export interface PrunedNodeInfo {
  seq: number
  type: AtomType
  turn: number
  firstLine: string
  citedBySeq: number[]
  /** 被剪瞬间的有效重要性（历史图臂口径；2.0 不消费，保留字段形状供旧日志回放）。 */
  eff: number
  /** 版本链重定向（2026-08-23）：被剪旧快照 recall 时指向同路径最新存活版本的 seq。 */
  latestOfPath?: number
}

/**
 * 一个会话的全量运行时状态。语义与单例时代逐字段相同，仅生命周期从"进程"改"会话"：
 * 会话首次被 stateOf 触达时创建，会话对象释放时随 WeakMap 回收。
 */
export interface SessionRuntimeState {
  /** 剪枝事务台账（有界遥测，pruneIntervals 写、账本重建补）。 */
  records: GraphPruneRecord[]
  /** 召回观测（有界；factor 两工具每命中一条记一笔，/argp 报数）。 */
  recallCalls: { seq: number; hit: boolean; state?: NodeState }[]
  /** 建图统计（cites 声明/解析；atomize 写，诊断用）。 */
  citeStats: CiteStats
  /** 已剪节点目录（seq -> 元数据；账本重建写，/argp 报数）。 */
  prunedNodeIndex: Map<number, PrunedNodeInfo>
  /** 每轮召回调用计数（防循环安全阀）。 */
  recallCallsThisTurn: number
  /** 召回字符预算（单窗累计，压缩事务成功时归零——prune-tx）。 */
  recallCharsUsed: number
  /** 最近一次请求的真实 prompt token（provider usage 锚点）。 */
  lastRealPromptTokens: number
  /** 锚点已覆盖的 surface 最大 seq。 */
  lastRealAnchorSeq: number
  /**
   * 最近一次 resolveScaledBudgets 为**本会话**解析出的有效窗口（1.11.0-beta.1 桶化：
   * 原为引擎级共享字段，多会话下 B 的解析会覆盖 A 的 recall 限额（recall-labels 按它推
   * per-call/total 上限）与 /argp 报数；budget.ts 经 stateOf(session) 写入本桶）。
   */
  resolvedWindowTokens: number
  /** A7 账本重建审计警告（有界）。 */
  auditWarnings: string[]
  /** A7 已重建过的 compactionId（本会话幂等去重）。 */
  rebuiltCompactionIds: Set<string>
  /** shadowed 增量游标三件套（shadowedSeqsOf 维护；per-session 后切换无需重置）。 */
  shadowedSession: Session | null
  shadowedSet: Set<number>
  shadowedScanned: number
}

export function createSessionRuntimeState(): SessionRuntimeState {
  return {
    records: [],
    recallCalls: [],
    citeStats: { aAtoms: 0, declared: 0, resolved: 0, ambiguous: 0, failed: 0 },
    prunedNodeIndex: new Map(),
    recallCallsThisTurn: 0,
    recallCharsUsed: 0,
    lastRealPromptTokens: 0,
    lastRealAnchorSeq: -1,
    resolvedWindowTokens: DEFAULT_WINDOW_TOKENS,
    auditWarnings: [],
    rebuiltCompactionIds: new Set(),
    shadowedSession: null,
    shadowedSet: new Set(),
    shadowedScanned: 0,
  }
}
