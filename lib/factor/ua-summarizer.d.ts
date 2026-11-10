/**
 * 因子臂 U/A 批次摘要编排（design-2.0 §2.4）：plan → LLM → 保真守卫 → prune-tx 成对发射。
 * 因子臂**唯一**触 LLM 处——G7（0-LLM）口径限的是剪枝链，不含摘要链；summary 事件
 * 文案如实标注 LLM 参与（禁 0-LLM 宣称）。
 *
 * 纪律：
 *  - 双条件触发：压力门控由调用方（pre-step deficit>0）将，本函数只查池门控
 *    （poolChars > uaSummaryThreshold）——纯阈值触发会在低总 token 时白丢一次前缀缓存；
 *  - 水位：plan 记 watermark（只覆盖 seq < watermark），异步 LLM 窗后发射前
 *    **逐段漂移复核**——surface 换代或文本已变 ⇒ 弃该段（旧计划不强推，下批重规划）；
 *  - 守卫（fidelityGuard 口径）对 **U/A 原文 + R 错误码**的必要条件：U/A 是任务契约
 *    面，其硬 token 必须逐字存活；R 大段输出不要求全存活（原文在日志、标签进词表），
 *    只锁错误码（负知识锚）；
 *  - 空承重集 ∧ 约束命中 >0 = 最危险形态（要保的全是散文式约束，无从机器验证）→
 *    **保守档保原文**；守卫失败重试一次（缺 token 清单进重试指令），再失败保原文；
 *  - 约束带逐字转写在**生成之外**追加（不参与 LLM，也不允许 LLM 复述改写）。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Session } from '@deepseek-ai/dsh-session';
import type { CompactionResult } from '@deepseek-ai/dsh-compaction';
import { type PruneTxHost } from '../prune-tx.ts';
export interface UaSummarizerConfig {
    /** U+A 池字符阈值（缺省 40K，§2.4）。 */
    uaSummaryThreshold?: number;
    /** 单次最多摘几段（缺省 3，防一笔事务吞掉全场）。 */
    maxSpansPerCall?: number;
    /** 每段摘要正文目标上限（缺省 1200 字符）。 */
    summaryMaxChars?: number;
    /** LLM 超时（缺省 180s，照 DEFAULT_LLM_TIMEOUT_MS）。 */
    llmTimeoutMs?: number;
    /** 焦点轮数（焦点轮不入摘要池；同 FactorEngine 口径）。 */
    focalTurns?: number;
    /** 测试注入：替代 dsh-llm 的补全函数（缺省走 ctx.llm + autoDshLlmSpec）。 */
    complete?: (spec: {
        provider: string;
        model: string;
    }, prompt: string, timeoutMs: number) => Promise<string>;
}
export declare class UaSummarizer {
    private readonly ctx;
    private readonly host;
    private readonly cfg;
    constructor(ctx: Context, host: PruneTxHost, config?: UaSummarizerConfig);
    /**
     * 压力门下试摘一批。返回 null = 本轮未动作（池未过阈值 / 全段保守档或漂移弃段），
     * 不静默：每条弃因都落 log。
     */
    summarize(session: Session, route: {
        provider?: string;
        model?: string;
    }, signal?: AbortSignal): Promise<CompactionResult | null>;
    /**
     * 单段：守卫原文 → LLM → 守卫 → 重试一次 → 漂移复核 → X 文本。任一环失败 null（保原文）。
     */
    private summarizeSpan;
    private buildPrompt;
    private callLlm;
    /** spec 解析同 compressor 优先序的 auto 档：路由齐 + 宿主 llm 服务在位，缺一即 disabled。 */
    private resolveSpec;
}
