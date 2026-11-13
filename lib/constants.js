/**
 * 跨引擎共享的默认阈值/预算/比例/超时（P4.2 工程卫生：单一来源）。
 *
 * 规则：跨引擎共享的默认值一律走这里的具名常量，禁止各引擎裸字面重复。
 * 各引擎 config 仍可覆盖（`config.x ?? DEFAULT_X`），本文件只承载"默认值"语义。
 */
/** 默认上下文窗口（token）。graph 引擎 windowTokens 缺省锚。 */
export const DEFAULT_WINDOW_TOKENS = 16_384;
/** 默认保留目标（token）。graph 引擎 retainTokens 缺省锚。 */
export const DEFAULT_RETAIN_TOKENS = 8_192;
/** chars/token 估算系数（无 tokenMeter 时的降级度量基准）。 */
export const DEFAULT_CHARS_PER_TOKEN = 3.5;
/**
 * 宿主 token-meter 的 `CHARS_PER_TOKEN`（`dsh-token-meter/lib/types/estimate.js`，当前 = 4）。
 *
 * **仅用于 `shadowedTokenCount` 字段**（宿主契约：shadow-price fold 按此口径算净释放）。
 * 宿主**不导出**该常量（`index.js` 只 export `TokenMeter`），故插件侧以常量对齐。
 *
 * ⚠️ **手动同步责任**：宿主升级时须核对宿主 `estimate.js` 的 `CHARS_PER_TOKEN` 仍等于本值
 * （当前对 `0.1.7-alpha.2` 验证）。漂移的后果是宿主 running total / WebUI 显示每笔剪枝
 * 系统性偏移（账目一致性，非协议违约——invariant 只查非负整数）。
 *
 * 与 `DEFAULT_CHARS_PER_TOKEN`（3.5，引擎**内部**预算旋钮：window/retain 阈值、sortKey、
 * recall 预算）是两回事——后者是插件自己的估算，无需对齐宿主，用户仍可经 WebUI 调整。
 */
export const HOST_CHARS_PER_TOKEN = 4;
/**
 * `shadowedTokenCount` 的**唯一定价点**（宿主契约字段）。
 *
 * 全部发射点（peratom flush 的整窗 summary / per-atom prune、prune-tx 的 summary /
 * 逐区间 prune）一律经本函数，禁止各点裸写 `/ 3.5` 或 `/ host.charsPerToken`——
 * 1.8.0 前的病灶正是三处发射器三种口径（/3.5 硬编码、/4、旋钮 3.5）在同一条 fold 流上
 * 记两本账。口径锁定测试（`test/compaction-prune-017.test.ts`）对本函数与真实发射路径
 * 双重验锁：摘掉任一发射点的本函数调用必须变红。
 */
export function shadowedTokensOf(chars) {
    return Math.ceil(chars / HOST_CHARS_PER_TOKEN);
}
/** A 形态前缀预算（token）。peratom compressor/declarer prefixBudgetTokens 缺省锚。 */
export const DEFAULT_PREFIX_BUDGET_TOKENS = 132_000;
/** 触发线占上下文比例（windowTokens 未显式指定时按 contextWindow × 此比例解析）。 */
export const DEFAULT_WINDOW_RATIO = 0.8;
/** 保留目标占触发线比例（retainTokens 未显式指定时按 windowTokens × 此比例解析）。 */
export const DEFAULT_RETAIN_RATIO = 0.2;
/** LLM 调用超时（ms）。peratom compressor/declarer timeoutMs 缺省锚（P4.3 统一）。 */
export const DEFAULT_LLM_TIMEOUT_MS = 180_000;
/**
 * 逐原子压缩（Stage-1）**跳过**的上下文形态清单（v1.6.1）。
 *
 * 键 = dsh-llm 的 `ContextForm`（`MessageSource.form`，`message.d.ts:42-54`）：
 *  - `'relay'` = 另一个 agent 发给本 agent 的消息（子代理 `send_message` 的主动汇报）；
 *  - `'notice'` = 一次性事件记载（子代理结算通知 `subagent-settled` 等）。
 *
 * 跳过理由（2026-09-23 实战语料实证，session-53e3e89f）：
 *  这两类是**已经浓缩过一次的产物**——子代理把 46K–75K 字符的工作过程提炼成
 *  3.6–7.1K 字符的报告（10–20×）。实测行重复率 **0%**（无内部冗余可丢）、
 *  承重 token 密度 0.1–1.5%（散文式报告而非结构化数据），逐原子压缩只会造成
 *  二次损失。它们更适合交给 Stage-2 图剪：全留或全删 + 墓碑 + `recall_pruned(seq)`
 *  可召回，而不是中间态的有损摘要。
 *
 * 注意两条正交轴别混用：`source.kind` 非 `'user'` 是「谁生产的」（注入 → 排除），
 * `form` 是「这是什么性质的东西」（本门控只按性质排除）。非-user-kind 的消息
 * 已被上一道判据排除，故本门控实际只作用于 dsh-agent 的 merge 扩展
 * （`agent-message` / `subagent-settled`）——它们仍是 user-role（`kind==='user'`），
 * 过 kind 门，原本会被放行。
 *
 * 传空数组 = 关闭本门控，退回 v1.6.0 行为（这些消息照旧进候选）。
 */
export const DEFAULT_SKIP_CONTEXT_FORMS = ['relay', 'notice'];
/** 贪心剪枝最大 pass 数（graph 引擎 maxPasses 缺省锚）。
 *  2026-09-22：由 16 提到 10000——剪枝循环正常靠「压缩率达标 / 全保护 / 无进展」自然终止，
 *  此值退化为纯安全上限（防极端空转），不再作为「每次压缩只剪 16 组」的增量节流阀。 */
export const DEFAULT_MAX_PASSES = 10000;
/**
 * 焦点文档 hard 宽度熔断阈值（design-2.0 §2.5 v1.1 用户裁定 + spike54 宽度账）：
 * tiered 模式下焦点文档全枚 hard，但若其 hard 候选字节占比超过本阈值，说明焦点
 * 面过宽（实测语料 8.3%，留足余量），退化为**每文档最新一枚**——保险不反噬预算。
 * 内部常量，不进设置卡（preset/CR 键集锁零新键）。
 */
export const FOCAL_DOC_HARD_WIDTH_RATIO = 0.15;
/**
 * §9.37 出口闸：输出预算三档源的最后一档——`agent.options.maxTokens`（装配期声明，
 * 宿主 buildRequest 正是拿它发请求，新进程首轮也可读）与 requestMaxTokens 观测
 * （agent/request 瀑布）皆缺位时，按声明窗 × 本比例预留生成空间。
 * 0.25 的依据：请求省略 maxTokens 时**服务端自己的默认 mct** 照样吃窗（R2 端点缺省
 * 65536=0.25×262144，400 死流的 request=273,639=prompt+65,536 分毫吻合），这一档
 * 在请求面完全隐形——观测档永远抓不到它。宁多留：漏留=撞墙 400/钳位全量重灌，
 * 多留=早一点剪（可召回），代价不对称。
 */
export const DEFAULT_EGRESS_OUTPUT_RATIO = 0.25;
/** §9.37 出口闸提前量：越过 `线 − 声明窗×本比例` 即触发（容 anchored 后增量估值失真）。 */
export const DEFAULT_EGRESS_MARGIN_RATIO = 0.02;
