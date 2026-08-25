/**
 * Per-Atom 压缩引擎（Stage-1）共享类型与常量。
 *
 * 依据：docs/per-atom-implementation-plan.md P0（2026-08-24 表示法定案：原文抄写 + 空隙归 info）
 * 与 docs/per-atom-compression-engine-design.md §1/§10。
 *
 * 本模块是叶子模块：只有常量、接口与纯类型守卫，零依赖——引擎（Stage-2）与
 * 后续管线（P1 compressor / P3 recall）可双向引用而不引入环。
 */
/** 拆分阈值（设计 §10 决策②）：≤100 字符的 user/message 不触发拆分调用。 */
export declare const SPLIT_THRESHOLD_CHARS = 100;
/**
 * ARGP 命名空间（防干涉，设计 §6-3）：所有落在原生事件 data 上的自有字段都收拢在
 * `data[ARG_NS]` 下，杜绝与其他插件/宿主的字段名冲突。U-info 标记即 `data[ARG_NS].info`。
 */
export declare const ARG_NS = "argp";
/**
 * 拆分调用输出（2026-08-24 定案）：模型只逐字抄写 dialog（指令）片段，
 * 未被抄写的余量整体归 info——不要求模型标注资料边界（空隙归 info）。
 */
export interface SplitDecision {
    seq: number;
    /** 连续指令片段的逐字抄写：必须与原文完全一致（含空白/标点/全角半角/emoji），按原文顺序排列 */
    quotes: string[];
}
/**
 * U-info 原子标记的落盘形态：原生 user/message 的 `data[ARG_NS]`。
 * 原始消息全文留在 append-only 日志（sourceSeq 即 recall_detail 的恢复目标）。
 */
export interface ArgpUserMeta {
    info: true;
    sourceSeq: number;
}
/**
 * 类型守卫：事件 data 是否携带 U-info 标记。
 * 分类陷阱防线（plan P0）：必须在 plugin-source → X 判定**之前**调用——插件 append 的
 * 聚合副本若先走 `source.kind === 'plugin'` 判定会被分类成 X（全局不可剪），U-info 永远进不了候选集。
 */
export declare function isArgpUserInfo(data: unknown): boolean;
