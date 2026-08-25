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
export const SPLIT_THRESHOLD_CHARS = 100;
/**
 * ARGP 命名空间（防干涉，设计 §6-3）：所有落在原生事件 data 上的自有字段都收拢在
 * `data[ARG_NS]` 下，杜绝与其他插件/宿主的字段名冲突。U-info 标记即 `data[ARG_NS].info`。
 */
export const ARG_NS = 'argp';
/**
 * 类型守卫：事件 data 是否携带 U-info 标记。
 * 分类陷阱防线（plan P0）：必须在 plugin-source → X 判定**之前**调用——插件 append 的
 * 聚合副本若先走 `source.kind === 'plugin'` 判定会被分类成 X（全局不可剪），U-info 永远进不了候选集。
 */
export function isArgpUserInfo(data) {
    const meta = data?.[ARG_NS];
    return meta?.info === true;
}
