/**
 * Per-Atom 压缩引擎（Stage-1）共享类型与常量。
 *
 * 依据：per-atom-implementation-plan.md P0（已迁出公开仓库；2026-08-24 表示法定案：原文抄写 + 空隙归 info）
 * 与 per-atom-compression-engine-design.md §1/§10（已迁出公开仓库）。
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
 * 分类陷阱防线（plan P0）：必须在「非 user 源 → X」判定**之前**调用——插件 append 的
 * 聚合副本若先走 `source.kind !== 'user'` 判定会被分类成 X（全局不可剪），U-info 永远进不了候选集。
 */
export function isArgpUserInfo(data) {
    const meta = data?.[ARG_NS];
    return meta?.info === true;
}
/**
 * 本引擎/压缩器**自己写入**的 user-role 消息的 `source.kind` 清单（来源轴排除清单）。
 *
 * 宿主 0.1.7 去 `plugin` 化后，本引擎的注入分两种 kind：
 *  - `'argp'`：U-info 聚合副本（peratom 压缩写回）+ auto-continue 续写提示（steer notice）；
 *  - `'compact-checkpoint'`：压缩 checkpoint 标记（`dsh-compaction` 的 `compactCheckpointSource`）。
 * `'plugin'` 是 0.1.6 及更早的遗留 kind（V3 会话存档里仍会出现），保留以向后兼容读取。
 *
 * ⚠️ **刻意不采用「非 `user` 即排除」的反向判据**：dsh-agent 的 merge 扩展 kind
 * （`agent-message` / `goal` / `subagent-settled` 等）也**不是 `'user'`**，但它们不属于
 * 本引擎写入——它们由**正交的性质轴**（`source.form` ∈ relay/notice，见
 * `DEFAULT_SKIP_CONTEXT_FORMS`）按"是否已浓缩产物"单独裁决。反向判据会把这两类
 * 一并误伤（既挡出 Stage-1 候选，又让 Stage-2 把可剪的 U 归成不可剪的 X）。
 * 故来源轴只认**本引擎自己的** kind 白名单，其余非-user kind 一律按普通材料/可剪 U 对待。
 */
export const OWN_SOURCE_KINDS = ['plugin', 'argp', 'compact-checkpoint'];
/** {@link OWN_SOURCE_KINDS} 的成员判定（kind 缺省 = 非本引擎写入 = false）。 */
export function isOwnSourceKind(kind) {
    return kind !== undefined && OWN_SOURCE_KINDS.includes(kind);
}
