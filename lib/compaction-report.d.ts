/**
 * 用户可见的压缩回执文案（2026-11-27）。
 *
 * 原则：`compaction/summary.summary[].text` 会直接显示在会话 UI 的压缩节点上，读它的人
 * 是「装了插件的普通用户」，不是插件开发者。所以这里**只说人话**：
 *  - 不出现 §编号、墓碑、surface、原子、sourceEventSeqs、0-LLM 之类内部术语；
 *  - 数字统一走「万 / 千 / 个 token」，不给人看裸的 5-6 位数；
 *  - 永远带上「原文还在、可以逐字找回」这句——这是用户真正关心的安全感。
 *
 * 开发者要的精确口径（surface 记账 / 历史体量 / 区间数）留在 `host.log.info` 的 debug 行，
 * 不进 UI。
 */
import type { Session } from '@deepseek-ai/dsh-session';
/** 压缩回执的事务类型（与 prune-tx 的 summaryKind 对齐；graph-prune 为历史兼容保留）。 */
export type ReportKind = 'tombstone-merge' | 'factor-prune' | 'factor-prose' | 'injection-dedupe' | 'graph-prune';
/** token 数的用户可读格式：>=1 万用「万」，>=1 千用「千」，否则原数。 */
export declare function formatTokenCount(n: number): string;
/**
 * 本次从可见上下文里拿掉的 token 量（**净释放**，CJK 自适应估算）。
 *
 * 口径说明（2026-11-27 rev-search 复核修正——原文档把因果说反了）：
 *  - 本函数 = 被替换节点的**全部文本面**（含 reasoning 与工具结果，`rawEventFaces` 口径）
 *    ÷ CJK 自适应密度，再**减去新检查点自身的回填价格**；
 *  - 它与**下一次真实 provider 请求的 prompt 降幅**同阶（实测：估算 ≈19.4 万 vs usage 实测
 *    194,285），因为 reasoning 与工具原文确实会从 prompt 里消失；
 *  - 它**不等于**压缩瞬间 UI「上下文使用量」的即时降幅——那个走宿主 token-meter 的
 *    `deltaTokens = 检查点价格 − shadowedTokenCount`（÷4、且 `iv.chars` 经 atomize 排除
 *    reasoning，`constants.ts:42`），要等下一发真实 usage 才回锚到我们这个量级。
 *  所以文案只能说"移出/释放了约 X 历史"，不能说"你的使用量会降 X"。
 */
export declare function estimateSurfaceRelease(session: Session, seqs: readonly number[], addedText?: string): number;
export interface ReportStats {
    /** 事务涉及的原子/节点数（debug 口径；散文「段」也以它为准，已剔除检查点桩）。 */
    count: number;
    /** 区间数（归并事务兼作"并成几条"）。 */
    intervals: number;
    /** 工具调用次数 = R 原子数（组剪的用户计数；用 count 会把 A+R 一起数成 2 倍）。 */
    toolCalls?: number;
    /** 本次释放的 token 净估算（estimateSurfaceRelease）。 */
    releaseTokens: number;
}
/**
 * 压缩回执的用户文案。句式统一为「做了什么 + 省了多少 + 原文还在」。
 *
 * 计数口径纪律（2026-11-27 rev-search 复核）：用户读到的"次/段/条"必须与他的心智模型同量纲
 * ——组剪的 atoms 含 1 枚 A + n 枚 R，直接报 atoms 会把一次调用说成"2 处工具调用"（约 2× 虚高），
 * 故组剪用 `toolCalls`（R 原子数）；散文 atoms 含被吞并的旧检查点，故由调用方剔除 X 后再传 count。
 */
export declare function compactionSummaryText(kind: ReportKind, stats: ReportStats): string;
/** 开发者 debug 行（host.log.info）：保留精确口径，不进 UI。 */
export declare function compactionDebugLine(kind: ReportKind, stats: ReportStats, extra: {
    shadowedTokenCount: number;
    historyTokens: number;
    historyChars: number;
    originEvents: number;
    capped?: boolean;
}): string;
