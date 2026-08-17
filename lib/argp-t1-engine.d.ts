import type { Context } from '@deepseek-ai/cordis';
import { CompactionEngine } from '@deepseek-ai/dsh-compaction';
import type { CompactionAgentContext, CompactionResult, CompactionTrigger, ManualCompactAgentContext } from '@deepseek-ai/dsh-compaction';
import type { Session } from '@deepseek-ai/dsh-session';
export interface ArgpT1Config {
    /** 压力阈值（默认 16384 token）：surface 可见估算量超过即触发剪枝。 */
    windowTokens?: number;
    /** 剪枝目标（默认 8192 token）：从最旧剪到此估算量以下。 */
    retainTokens?: number;
    /** 近因豁免：surface 末尾 N 个节点不参剪（默认 4）。 */
    recencyGuard?: number;
    /** 微剪枝下限（默认 512 字符）：低于此量的 span 不值得 tombstone（净增占位字符 + KV 失效）。 */
    minSpanChars?: number;
    /** 估算基准：英文 1 token 约 3.5 字符；触发与目标同基准（不变式 2）。 */
    charsPerToken?: number;
    /** 单次剪枝事务的最大贪心 pass 数（默认 8；机制验证档固定，生产档可按需调高）。 */
    maxPasses?: number;
}
/** 一次剪枝事务的观测记录（spike 断言直接读这里）。 */
export interface PruneRecord {
    at: string;
    compactionId: string;
    startEventSeq: number;
    summaryEventSeq: number;
    tombstoneSeq: number;
    endEventSeq: number;
    shadowedSeqs: number[];
    shadowedTokenCount: number;
    charsBefore: number;
    charsAfter: number;
}
export declare class ArgpT1Engine extends CompactionEngine {
    static inject: string[];
    readonly windowTokens: number;
    readonly retainTokens: number;
    readonly recencyGuard: number;
    readonly minSpanChars: number;
    readonly charsPerToken: number;
    readonly maxPasses: number;
    /** 全部剪枝事务记录（spike 断言直接读这里）。 */
    readonly records: PruneRecord[];
    /** recall_pruned 调用台账（服从率基线度量用）。 */
    readonly recallCalls: {
        seq: number;
        hit: boolean;
    }[];
    private session;
    constructor(ctx: Context, config?: ArgpT1Config);
    /** 注入/替换引擎绑定的 session（spike 侧创建 agent 后显式调用）。 */
    setSession(session: Session): void;
    /** 按被遮蔽 seq 找回原文；未命中返回 null。 */
    recall(seq: number): string | null;
    /** surface 可见 token 估算（触发与目标同基准）。 */
    estimateTokens(session: Session): number;
    /**
     * 压力剪枝：估算量 ≥ windowTokens 时从最旧可剪区间逐段 tombstone，
     * 直到 ≤ retainTokens 或无可剪区间。0 LLM 调用，确定性收敛。
     */
    compactIfNeeded(agent: CompactionAgentContext, _trigger: CompactionTrigger, _signal: AbortSignal): Promise<CompactionResult | null>;
    compactNow(_agent: ManualCompactAgentContext, _signal: AbortSignal): Promise<CompactionResult | null>;
    compactRegion(): Promise<CompactionResult>;
    /**
     * 选最旧一段可剪连续 surface 区间：
     *  - U 载体保护：user/message 节点永不参剪（不变式 6，needle 唯一载体）
     *  - 近因豁免：surface 末尾 recencyGuard 个节点不参剪
     *  - tool 配对自保：user 节点不剪 ⇒ assistant(tool-call)/tool(result) 对不会被切散
     *  - 微剪枝下限：可见量 < minSpanChars 的 span 不剪（实测：reasoning-only 助手节点
     *    可见文本 0，剪了净增 tombstone 字符且白付 KV 失效代价）
     */
    private selectOldestSpan;
    /** 一次完整剪枝事务：start（锁）→ summary（影子价）→ checkpoint replace → end。 */
    private pruneSpan;
}
export default ArgpT1Engine;
