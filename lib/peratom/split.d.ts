/**
 * P0 拆分解析与策略（纯函数，零 LLM / 零 Session 依赖）。
 *
 * 职责边界：模型返回 SplitDecision.quotes 之后、落盘（P1 的 replace 事务）之前的全部
 * 确定性逻辑都在这里——定位（indexOf）、策略裁决（回退/翻转/退化）、dialog/info 文本构建。
 * 全部可单测；策略口径与 docs/per-atom-implementation-plan.md P0 一一对应。
 *
 * 危险方向说明（plan「保守对冲」节）：空隙归 info 后，失败模式是"漏标的指令片段变成
 * 可剪内容"。因此本模块的一切歧义都向 dialog 方向回退：
 *   - 任一片段定位失败 → 整条回退 dialog（保真不变式优先，静默计数由调用方负责）；
 *   - 抄写覆盖率 ≥ COVERAGE_FLIP → 整条保留为 dialog（模型实际在说"这都是指令"）；
 *   - 零有效片段 → 整条 U-info（纯资料消息的自然退化，非特判）。
 */
export type Span = readonly [number, number];
/** dialog 复合文本中，替代被摘除资料位置的省略标记（与剪枝墓碑 [elided …] 惯用法同构）。 */
export declare const SPLIT_ELLIPSIS = "\n[\u2026]\n";
/** dialog 覆盖率翻转阈值（plan P0 退化规则）：≥80% 视为整条指令。 */
export declare const COVERAGE_FLIP = 0.8;
/** 定位结果：首个出现位置（indexOf）命中的区间 + 定位失败的原文片段。 */
export interface LocatedQuotes {
    spans: Span[];
    misses: string[];
}
/**
 * 在原文中逐条定位抄写片段。重叠/乱序输入按排序后合并处理（合并不视为错误——
 * 与 range 法不同，抄写的"错"几乎都是定位失败而非坐标漂移）。
 */
export declare function locateQuotes(quotes: unknown, message: string): LocatedQuotes;
/** 拆分策略裁决。 */
export type SplitResolution = {
    kind: 'unsplit';
    reason: 'coverage-flip' | 'no-info-remainder' | 'empty-message';
} | {
    kind: 'info-only';
} | {
    kind: 'fallback-dialog';
} | {
    kind: 'split';
    dialogSpans: Span[];
    infoSpans: Span[];
};
/**
 * 计算补集间隙（未被 dialog 区间覆盖的部分），丢弃纯空白间隙——
 * 格式性噪音不值得成为 info 原子（其字符仍留在日志原文中，可 recall_detail 全文恢复）。
 */
export declare function complementGaps(spans: Span[], len: number, text?: string): Span[];
/**
 * 策略主入口：给定原文与（可能不可信的）quotes 输出，裁决最终拆分形态。
 * 输入宽容：quotes 接受 unknown（模型产物未经校验），一切异常走 fallback-dialog。
 */
export declare function resolveSplit(message: string, quotes: unknown, coverageFlip?: number): SplitResolution;
/** dialog 复合文本：各片段原文逐字拼接，片段间以省略标记连接（相邻引文间的资料位置）。 */
export declare function buildDialogText(message: string, spans: Span[]): string;
/** info 聚合文本：各余量段原文拼接（单段时即原文切片）。 */
export declare function buildInfoText(message: string, spans: Span[]): string;
