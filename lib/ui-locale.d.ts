/**
 * 宿主 UI 语言偏好解析（/argp 服务端多语言呈现的取值侧，2026-10-27 探测定案）。
 *
 * 宿主把语言选择存在 settings 的 `locale` 命名空间（`preference` 字段，BCP-47 id，
 * 内置 'zh'/'en'；`@deepseek-ai/dsh-client-locale` 拥有该命名空间）。用户在设置页
 * **显式**选过语言后，值经宿主 settings 服务落进 profile 的 cordis.patch.yml
 * （settings 文档 = profile patch 层，2026-10-27 实机写盘验证），服务端经
 * `settings.describe()`（SettingsForms 的公开读面，按命名空间返回 live 合并值）可读。
 *
 * ⚠️ 结构性缺口（宿主 0.2.1-rc.3 现状）：`preference` 缺失 = 跟随浏览器语言，
 * 而浏览器语言不进服务端（CommandInvocation 契约无 locale 字段）——"自动"模式
 * 解析不出有效语言。本函数对一切缺失/异形/异常**回退英文**（错误方向 = 维持现状）。
 *
 * 依赖方向：叶子模块，零 src 依赖；ctx 形状走最小结构视图（与 llm-adapter 的
 * resolveLlmRuntime 同款宽松读取：先属性访问兼容测试替身，再 ctx.get 官方语义）。
 */
/** 支持的状态卡语言。 */
export type UiLocale = 'zh' | 'en';
/**
 * 解析宿主 UI 语言：settings `locale` 命名空间的 `preference`，`zh*` → zh，
 * 其余（含缺失/异形/服务缺席/调用抛错）→ en。每次 /argp 调用现取——设置页
 * 切语言后下一条 /argp 即生效，无需重启。
 */
export declare function resolveUiLocale(ctx: unknown): UiLocale;
