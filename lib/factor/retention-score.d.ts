import type { PruneScore, RTags } from './types.ts';
/** 硬保护判据位（§2.3 第一层；引擎注入，任一 true 即保护）。 */
export interface HardFlags {
    /** 协议组未闭合的 A。 */
    protocolUnclosed?: boolean;
    /** 失败无后继 R。 */
    failureNoFollowR?: boolean;
    /** open/sticky 交集区成员（保护向：open 也算）。 */
    stickyMember?: boolean;
    /** 附件/非文本。 */
    attachment?: boolean;
    /** 焦点轮非再生 R*（条件保护：焦点 ∧ containment<满覆盖，离开焦点即入排序）。 */
    focalNonRegenerable?: boolean;
    /** node 0（宿主保护）。 */
    node0?: boolean;
}
export interface ScoreInput {
    rootSeq: number;
    turn: number;
    currentTurn: number;
    tags: RTags;
    hard?: HardFlags;
    /** 可再生性证明（引擎 fs 验"文件未变"；undefined=未知=保守不可再生）。 */
    regenerable?: boolean;
    /** staleness 覆盖证明（后续全量读 ⊇ 本读范围；部分读永不覆盖——引擎侧配反例）。 */
    superseded?: boolean;
    /** 焦点（标签 ∈ 焦点标签集；undefined=保守按焦点）。 */
    focal?: boolean;
}
export interface ScoredEntry {
    rootSeq: number;
    score: PruneScore;
}
export declare function computeScore(i: ScoreInput): PruneScore;
/** 字典序比较：负 = a 先剪。 */
export declare function compareForPrune(a: ScoredEntry, b: ScoredEntry): number;
export interface PrunePlan {
    /** 已按目标释放量截断的剪枝序列（§2.3 序；未达目标时为全量 + shortfall）。 */
    pruneOrder: number[];
    hardProtected: number[];
    /** 目标未达成量（降级链：少剪 + 告警上报，永不放宽判据换名额）。 */
    shortfallChars: number;
    releasedChars: number;
}
/**
 * 排序 + 目标释放量选择。targetReleaseChars 是**下界**（retain 目标：释放不足
 * 则爆窗），按序取到累计 ≥ 目标即止（含首个越界项——不回头少剪）。
 * 全取仍不可达 ⇒ 如实给 shortfallChars（§2.3 降级链：少剪 + 告警），
 * 硬保护成员**任何压力下都不入 pruneOrder**。
 */
export declare function planPrune(entries: ScoredEntry[], opts?: {
    targetReleaseChars?: number;
}): PrunePlan;
