/**
 * 单会话运行时状态（「会话所有权」批；2.0 factor-only 收窄）。
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
 * 保留的全是 factor 事务与本会话可观测面实际读写的字段。
 *
 * 依赖方向：本模块是**类型叶子**——只 import type 与无依赖的 constants 常量，
 * 无运行时依赖、无环。
 */
import { DEFAULT_PRUNED_INDEX_CAP, DEFAULT_WINDOW_TOKENS } from './constants.js'
import { SeqBitset, type SeqSet } from './seq-bitset.js'
import type { Session } from '@deepseek-ai/dsh-session'
import type { AtomType } from './argp-types.js'
import type { GraphPruneRecord } from './prune-tx.js'
import type { NodeState } from './log-access.js'
import type { RequestCacheSample } from './cache-audit.js'

/**
 * 已剪节点目录条目（seq -> 元数据）。账本重建与 /argp 仍读它。
 */
export interface PrunedNodeInfo {
  seq: number
  type: AtomType
  turn: number
  firstLine: string
  citedBySeq: number[]
  /** 被剪瞬间的有效重要性（历史图臂口径；2.0 不消费，保留字段形状供旧日志回放）。 */
  eff: number
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
  /** 已剪节点目录（seq -> 元数据；账本重建写，/argp 报数）。A5：明细有上限，
   *  计数走 {@link prunedNodeTotal}（Map 长度会因淘汰而小于真实值）。 */
  prunedNodeIndex: Map<number, PrunedNodeInfo>
  /** 已剪节点总数（单调累计；A5 起 /argp 用它报数，不受明细淘汰影响）。 */
  prunedNodeTotal: number
  /** 每轮召回调用计数（防循环安全阀）。 */
  recallCallsThisTurn: number
  /** 计数对应的 turn/start 轮号（-1=尚未同步；轮变即归零，不依赖事件投递）。 */
  recallTurn: number
  /** 召回字符预算（本 turn 累计，轮变即归零 + 压缩事务成功归零——recall.ts / prune-tx）。 */
  recallCharsUsed: number
  /** 预算重置游标对应的 turn/start 轮号（-1=尚未同步；与 recallTurn 安全阀游标分立）。 */
  recallBudgetTurn: number
  /** 最近一次请求的真实 prompt token（provider usage 锚点）。 */
  lastRealPromptTokens: number
  /** 锚点已覆盖的 surface 最大 seq。 */
  lastRealAnchorSeq: number
  /**
   * 最近一次 resolveScaledBudgets 为**本会话**解析出的有效窗口（桶化：
   * 原为引擎级共享字段，多会话下 B 的解析会覆盖 A 的 recall 限额（recall-labels 按它推
   * per-call/total 上限）与 /argp 报数；budget.ts 经 stateOf(session) 写入本桶）。
   */
  resolvedWindowTokens: number
  /** A7 账本重建审计警告（有界）。 */
  auditWarnings: string[]
  /** A7 已重建过的 compactionId（本会话幂等去重）。 */
  rebuiltCompactionIds: Set<string>
  /** shadowed 增量游标三件套（shadowedSeqsOf 维护；per-session 后切换无需重置）。
   *  A5：`shadowedSet` 用位图（seq 稠密，1 bit/seq）而非 `Set<number>`；
   *  截断会破坏「已剪/存活」判定，故只压缩存储、不设条数上限。 */
  shadowedSession: Session | null
  shadowedSet: SeqSet
  shadowedScanned: number
  /** 进行中事务的 prune 声称（compaction/start→end 之间；end 成功才入 shadowedSet）。 */
  shadowedPending: number[] | null
  /** search_history 临时命中索引（单槽；任何新查询整体覆盖；null=空/未建/进程重启）。 */
  searchIndex: Map<number, { kind: 'R' | 'U' | 'A'; turn: number | string }> | null
  /** 最近一次 search_history 的查询词（第二跳「被覆盖」话术如实披露；刀 C）。 */
  searchQuery: string
  /** §B-2 terminal-b6 连续计数（接管形态）：≥N 轮不空转（只报不剪）；非 b6 决策归零。 */
  b6Streak: number
  /** §F churn 状态：最近一次 prune-only 发射的**实际释放**（-1=无记录；摘要发射清零）。 */
  lastPruneRelease: number
  /** §F churn 状态：最近一次 prune-only 处置（发射或被抑制）的入场 contextTokens（0=无）。 */
  lastPruneEntryCtx: number
  /**
   * 每请求缓存审计样本（有界；2.2.3）。压缩是否打断前缀缓存的**直接读数**来自
   * provider usage，不再靠首字延迟反推（见 cache-audit.ts）。
   */
  cacheSamples: RequestCacheSample[]
  /** 最近一次成功压缩事务（`compaction/end` 无 error）——后续请求都归属它。 */
  lastCompaction: { id: string; at: number; turn: number | null } | null
  /**
   * 该事务后尚无带 usage 的模型应答：下一条即"压缩后首请求"。
   * 只有首请求的低命中是压缩的**必然代价**；之后的低命中说明还有别的抖前缀源。
   */
  compactionAwaitingReply: boolean
}

export function createSessionRuntimeState(): SessionRuntimeState {
  return {
    records: [],
    recallCalls: [],
    prunedNodeIndex: new Map(),
    prunedNodeTotal: 0,
    recallCallsThisTurn: 0,
    recallTurn: -1,
    recallCharsUsed: 0,
    recallBudgetTurn: -1,
    lastRealPromptTokens: 0,
    lastRealAnchorSeq: -1,
    resolvedWindowTokens: DEFAULT_WINDOW_TOKENS,
    auditWarnings: [],
    rebuiltCompactionIds: new Set(),
    shadowedSession: null,
    shadowedSet: new SeqBitset(),
    shadowedScanned: 0,
    shadowedPending: null,
    searchIndex: null,
    searchQuery: '',
    b6Streak: 0,
    lastPruneRelease: -1,
    lastPruneEntryCtx: 0,
    cacheSamples: [],
    lastCompaction: null,
    compactionAwaitingReply: false,
  }
}

/**
 * 写入一条已剪节点明细（A5）：明细有上限（{@link DEFAULT_PRUNED_INDEX_CAP}），
 * 但 `prunedNodeTotal` 单调累计真实总数——`/argp` 报数用后者。
 * 幂等：同一 seq 已在 Map 内则不重复计数（重建按 compactionId 去重，正常不会重复）。
 */
export function notePrunedNode(
  st: SessionRuntimeState,
  seq: number,
  info: PrunedNodeInfo,
  cap: number = DEFAULT_PRUNED_INDEX_CAP,
): void {
  if (st.prunedNodeIndex.has(seq)) return
  st.prunedNodeIndex.set(seq, info)
  st.prunedNodeTotal += 1
  if (st.prunedNodeIndex.size > cap) {
    // seq 递增入账 ⇒ 首个键即最旧明细；删明细不动计数。
    const oldest = st.prunedNodeIndex.keys().next()
    if (!oldest.done) st.prunedNodeIndex.delete(oldest.value)
  }
}
