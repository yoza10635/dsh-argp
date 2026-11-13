import type { Session } from '@deepseek-ai/dsh-session';
import type { AtomType } from './argp-types.js';
import type { CiteStats } from './graph-build.js';
import type { GraphPruneRecord } from './prune-tx.js';
import type { NodeState } from './log-access.js';
/**
 * 已剪节点目录条目（seq -> 元数据）。原定义在 prune-selection（图剪选择器），
 * 2.0 随选择器退役迁入本叶子——账本重建与 /argp 仍读它。
 */
export interface PrunedNodeInfo {
    seq: number;
    type: AtomType;
    turn: number;
    firstLine: string;
    citedBySeq: number[];
    /** 被剪瞬间的有效重要性（历史图臂口径；2.0 不消费，保留字段形状供旧日志回放）。 */
    eff: number;
    /** 版本链重定向（2026-08-23）：被剪旧快照 recall 时指向同路径最新存活版本的 seq。 */
    latestOfPath?: number;
}
/**
 * 一个会话的全量运行时状态。语义与单例时代逐字段相同，仅生命周期从"进程"改"会话"：
 * 会话首次被 stateOf 触达时创建，会话对象释放时随 WeakMap 回收。
 */
export interface SessionRuntimeState {
    /** 剪枝事务台账（有界遥测，pruneIntervals 写、账本重建补）。 */
    records: GraphPruneRecord[];
    /** 召回观测（有界；factor 两工具每命中一条记一笔，/argp 报数）。 */
    recallCalls: {
        seq: number;
        hit: boolean;
        state?: NodeState;
    }[];
    /** 建图统计（cites 声明/解析；atomize 写，诊断用）。 */
    citeStats: CiteStats;
    /** 已剪节点目录（seq -> 元数据；账本重建写，/argp 报数）。 */
    prunedNodeIndex: Map<number, PrunedNodeInfo>;
    /** 每轮召回调用计数（防循环安全阀）。 */
    recallCallsThisTurn: number;
    /** 召回字符预算（单窗累计，压缩事务成功时归零——prune-tx）。 */
    recallCharsUsed: number;
    /** 最近一次请求的真实 prompt token（provider usage 锚点）。 */
    lastRealPromptTokens: number;
    /** 锚点已覆盖的 surface 最大 seq。 */
    lastRealAnchorSeq: number;
    /**
     * 最近一次 resolveScaledBudgets 为**本会话**解析出的有效窗口（1.11.0-beta.1 桶化：
     * 原为引擎级共享字段，多会话下 B 的解析会覆盖 A 的 recall 限额（recall-labels 按它推
     * per-call/total 上限）与 /argp 报数；budget.ts 经 stateOf(session) 写入本桶）。
     */
    resolvedWindowTokens: number;
    /** A7 账本重建审计警告（有界）。 */
    auditWarnings: string[];
    /** A7 已重建过的 compactionId（本会话幂等去重）。 */
    rebuiltCompactionIds: Set<string>;
    /** shadowed 增量游标三件套（shadowedSeqsOf 维护；per-session 后切换无需重置）。 */
    shadowedSession: Session | null;
    shadowedSet: Set<number>;
    shadowedScanned: number;
}
export declare function createSessionRuntimeState(): SessionRuntimeState;
