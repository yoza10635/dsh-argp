import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type { CompressDecision, CurrentTurnCollect, PlanOptions } from './compressor-types.js';
/**
 * 防御性 JSON 提取（spike 32 extractJson 原样复刻）：剥 <think>、剥代码围栏、
 * 从最后一个 } 向前找配对 {。response_format 失效的端点上兜底。
 */
export declare function extractJson(raw: string): unknown;
/** 模型输出 → CompressDecision（信任边界：seq/quotes/level/text 全字段校验，异形丢弃）。 */
export declare function normalizeDecision(cand: unknown): CompressDecision | null;
interface PlannedStep {
    kind: 'replace' | 'append';
    type: 'user/message' | 'tool/result';
    /** replace 的目标 seq（append 时无意义）。 */
    at: number;
    data: unknown;
    sourceEventSeqs: number[];
}
interface PlanResult {
    steps: PlannedStep[];
    replaces: number;
    skippedFallbackDialog: number;
    skippedFidelity: number;
    /** 模型显式选 false（不压）的 tool 原子数（设计对称：与 info 同级显式信号）。 */
    skippedFalse: number;
    /** no-op 守卫拒的 tool 副本数（收益 ≤5% 视同 false；spike 37 全文照抄实锤驱动）。 */
    skippedNoopGain: number;
    /** 被保真守卫拒的副本中，缺失的高信号 token 汇总（诊断"白压"根因用）。 */
    fidelityMissing: string[];
    /** summary 副本审计：被概括丢弃的高信号 token（放行但入账，供审核）。 */
    summaryDropped: string[];
    /** HLS 修复档（v1.2.0 组件 B）：extract 被拒后经守卫尾注补全落地的副本数。 */
    hlsRepairs: number;
    /** HLS 审计台账：守卫补进尾注的高信号 token（与 summaryDropped 同级可审，spike39 消费）。 */
    restoredByGuard: string[];
    /**
     * HLS 经济学门控拒收数（v1.2.0 门控修正）：候选虽缺 token 但 ROI = 净释放/尾注 < θ
     * （尾注不划算，修复后接近/超过原文长度）→ 退回原文保面。与 skippedFidelity 同向
     * （原子保原文），单列以便度量「代价盲区间」（spike39 的 F1/F4 形态）的出现频率。
     */
    hlsRoiSkipped: number;
    anomalies: number;
}
/**
 * 引擎侧规划：模型输出过信任边界（seq 必须命中本轮收集集，先到先得去重），
 * 用户消息过 resolveSplit 全套保守策略（定位失败回退 dialog / 覆盖率翻转 / 空隙归 info）。
 * 返回落盘步骤序列；steps 为空 = 本轮无可落地动作（不开发务括号）。
 */
export declare function planReplacements(collect: CurrentTurnCollect, decision: CompressDecision, events: readonly SessionEvent[], opts?: PlanOptions): PlanResult;
export {};
