import type { Context } from '@deepseek-ai/cordis';
import type { Session } from '@deepseek-ai/dsh-session';
import type { NodeState } from '../log-access.js';
/** 决策⑤ 4 倍制：summary 档预算 = budgetRatio × detail 档。默认 4。 */
export declare const DEFAULT_BUDGET_RATIO = 4;
/** 单次召回正文的来源标签（测试断言 + 引导文案用）。 */
export type SummarySource = 'stored' | 'copy' | 'original';
export interface SummaryResolution {
    text: string;
    source: SummarySource;
}
/** 召回调用观测记录（时间序）。 */
export interface RecallZoomRecord {
    tool: 'recall_summary' | 'recall_detail';
    seq: number;
    /** 是否取到正文（越界 / 无正文为 false）。 */
    hit: boolean;
    /** 命中时的节点状态（shadowed / live / off-surface）。 */
    state?: NodeState;
    /** summary 档正文来源（stored=存储 summary，copy=压缩副本，original=降级原文）。 */
    source?: SummarySource;
    /** 命中时计入对应档预算的字符数。 */
    chars: number;
    /** 因预算耗尽被拦（返回引导文案而非正文）。 */
    budgetBlocked?: 'summary' | 'detail';
    /** 失败原因（越界 / 无正文）。 */
    reason?: 'out-of-range' | 'no-text';
}
export interface RecallZoomConfig {
    /** detail 档单窗预算（token）；显式给则优先于 windowTokens 比例解析。 */
    detailBudgetTokens?: number;
    /** 4 倍制系数（决策⑤），summary 档预算 = ratio × detail 档。默认 4。 */
    budgetRatio?: number;
    /** 窗口 token 锚（未显式给 detailBudgetTokens 时解析默认预算用）。 */
    windowTokens?: number;
    /** chars/token 估算。默认 3.5。 */
    charsPerToken?: number;
    /** 是否注册工具与契约 section（默认 true）。测试可关断只留纯函数。 */
    enabled?: boolean;
}
/**
 * 解析某 seq 的"最佳可用 summary 文本"，三档降级（设计 §4 + plan P3）：
 *  1. `stored`——该事件（或引用它的压缩副本）携带 `data[ARG_NS].summary`（U-info 原子）；
 *  2. `copy`——引用该 seq 的最新压缩副本正文（tool/result extract 副本 / dialog 副本）；
 *  3. `original`——从未压缩，降级返回 append-only 日志原文。
 * 无正文返回 null。
 */
export declare function resolveSummaryText(session: Session, seq: number): SummaryResolution | null;
export declare class RecallZoom {
    static inject: readonly [];
    private readonly ctx;
    private readonly budgetRatio;
    private readonly detailBudgetChars;
    private readonly enabled;
    private session;
    /** detail 档单窗累计字符（compaction/end 归零）。 */
    private detailCharsUsed;
    /** summary 档单窗累计字符（compaction/end 归零）。 */
    private summaryCharsUsed;
    /** 全部召回尝试记录（时间序）。 */
    readonly records: RecallZoomRecord[];
    constructor(ctx: Context, config?: RecallZoomConfig);
    /** detail 档单窗预算（字符）。 */
    get detailBudget(): number;
    /** summary 档单窗预算（字符）= budgetRatio × detail。 */
    get summaryBudget(): number;
    /** detail 档已用字符（测试断言 / 观测）。 */
    get detailUsed(): number;
    /** summary 档已用字符。 */
    get summaryUsed(): number;
    setSession(session: Session): void;
    /** 强制重置预算滑窗（测试 / 手动压缩用；生产由 compaction/end 触发）。 */
    resetBudget(): void;
    /** 预算引导文案：教模型升档 / 降档，而非硬拒。 */
    private budgetGuidance;
    /** gist 档召回（P3）：三档降级取数 + summary 预算。 */
    recallSummary(seqArg: number | undefined): Promise<string>;
    /** exact 档召回（verbatim 天花板）：日志原文逐字节 + detail 预算。 */
    recallDetail(seqArg: number | undefined): Promise<string>;
}
export default RecallZoom;
