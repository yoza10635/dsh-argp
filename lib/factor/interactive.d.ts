export declare const INTERACTIVE_PREVIEW_TOOLS: ReadonlySet<string>;
/** tool 键 → 是否交互族（renderVocabulary 谓词注入用；名单知识不进 factor-ledger）。 */
export declare function isInteractiveToolKey(key: string): boolean;
/**
 * 交互组检查点专段（P7=带：组剪当刻给即时召回指针，近因强于词表 note 常驻指针）。
 * 破组剪「检查点零指针」常规**仅限交互组**；普通组仍 FACTOR_COMPACTED_MARKER。
 * 措辞只提在场成员（ZT7/ZT10）；subagent 不得暗示可取回报告——R 恒为启动回执，
 * 报告是 U notice 从不被 factor 剪（P0-2 实锤）。
 */
export declare function interactiveCheckpointText(tools: readonly string[]): string;
export interface PreviewBits {
    /** Q 侧（来自配对 A 的 args，交互内容摘要）。 */
    q?: string;
    /** A 侧（来自 R 原文；subagent 恒缺——R 无信息量）。 */
    a?: string;
    /** 多问标记（ask_user_question questions>1）：预览只装得下首问，q×n 防漏答误导。 */
    qCount?: number;
}
/**
 * 按注册名分派的形状门槛提取器。返回 null = 名-only 行（形状不符/两侧皆弃）；
 * 调用方（tagRsFromLog）只对名单内工具调用——名单外恒无预览（ZT11）。
 */
export declare function extractPreview(tool: string, rawArgs: unknown, resultText: string): PreviewBits | null;
