/**
 * 单会话运行时状态（1.11.0-beta.0「会话所有权」批，1-1）。
 *
 * 病灶（〔Q〕M4 / 〔K〕P1-1，双 BLOCKER）：引擎把这些字段做成**进程级单例**——
 * 台账（prunedNodeIndex / records）、召回预算与计数、shadowed 增量游标、冻结 catalog、
 * usage 锚点、账本重建去重集、闭包召回表全部挂在实例上。多会话/多代理宿主里
 * A→B 切换时 B 读到 A 的剪枝索引（同 seq 不同内容 = 跨会话泄漏）、A 的预算压制 B 的
 * 召回、A 的锚点让 B 误触发。
 *
 * 修法：全部字段收进本状态对象，引擎经 `WeakMap<Session, SessionRuntimeState>`
 * 分桶（`stateOf(session)` 懒建）。**同步方法**（图剪全同步）经引擎上的 getter 兼容层
 * 读"当前焦点会话"的桶（sync 期间焦点不可变，安全）；**异步路径**（召回工具 execute、
 * peratom 三管线、账本重建）显式线程 session（exec.agent.session 路由，1-2），
 * 不得依赖焦点指针。
 *
 * 依赖方向：本模块是**类型叶子**——只 import type，无运行时依赖、无环。
 */
import type { Session } from '@deepseek-ai/dsh-session';
import type { SemanticEdge, DeterministicEdge } from './argp-types.js';
import type { CiteStats, InferredStats } from './graph-build.js';
import type { PrunedNodeInfo } from './prune-selection.js';
import type { GraphPruneRecord } from './prune-tx.js';
import type { NodeState } from './log-access.js';
/**
 * 一个会话的全量运行时状态。语义与单例时代逐字段相同，仅生命周期从"进程"改"会话"：
 * 会话首次被 stateOf 触达时创建，会话对象释放时随 WeakMap 回收。
 */
export interface SessionRuntimeState {
    /** 剪枝事务台账（有界遥测，pruneIntervals 写、账本重建补、buildTombstoneRedirect 读）。 */
    records: GraphPruneRecord[];
    /** recall_pruned 观测（有界）。 */
    recallCalls: {
        seq: number;
        hit: boolean;
        state?: NodeState;
    }[];
    /** recall(query) 观测（有界）。 */
    recallQueryCalls: {
        query: string;
        count: number;
        hits: number;
    }[];
    /** 建图统计（cites 声明/解析；/argp 报数）。 */
    citeStats: CiteStats;
    /** §3-3 recall 价值继承：最近一次 recall 的旧原子 seq 与结果 R 原子 seq。 */
    recallSourceSeq: number;
    recallResultSeq: number;
    /** 最近一次建图的边集（判决 G3 / 诊断）。 */
    lastEdges: SemanticEdge[];
    lastDeterministicEdges: DeterministicEdge[];
    lastInferredEdges: SemanticEdge[];
    /** 最近一次建图的推断边统计。 */
    inferredStats: InferredStats;
    /** 已剪节点目录（seq -> 元数据；list_pruned / 版本链重定向读）。 */
    prunedNodeIndex: Map<number, PrunedNodeInfo>;
    /** 闭包生命周期剪除记录（noteRecallHit 反查 rootSeq）。 */
    closurePrunes: {
        closureId: string;
        rootSeq: number;
        prunedSeqs: number[];
        at: string;
    }[];
    /** 闭包最近一次被 recall 回拉的轮次；key = rootSeq。 */
    closureLastRecalled: Map<number, number>;
    /** 每轮召回调用计数（防循环安全阀）。 */
    recallCallsThisTurn: number;
    /** 召回字符预算（单窗累计，压缩事务成功时归零——prune-tx）。 */
    recallCharsUsed: number;
    /** 冻结 catalog 文本（system 块恒定性；本会话首绑时拍快照）。 */
    frozenCatalog: string | null;
    /** 最近一次请求的真实 prompt token（provider usage 锚点）。 */
    lastRealPromptTokens: number;
    /** 锚点已覆盖的 surface 最大 seq。 */
    lastRealAnchorSeq: number;
    /** A7 账本重建审计警告（有界）。 */
    auditWarnings: string[];
    /** A7 已重建过的 compactionId（本会话幂等去重）。 */
    rebuiltCompactionIds: Set<string>;
    /** shadowed 增量游标三件套（shadowedSeqsOf 维护；per-session 后切换无需重置）。 */
    shadowedSession: Session | null;
    shadowedSet: Set<number>;
    shadowedScanned: number;
    /** 反应式阶梯守卫覆盖（"剪不动 ⇒ 放宽 recency/turn"的当前档位；A→B 不得继承）。 */
    guardOverride: {
        recencyGuard: number;
        turnGuard: number;
    } | null;
}
export declare function createSessionRuntimeState(): SessionRuntimeState;
