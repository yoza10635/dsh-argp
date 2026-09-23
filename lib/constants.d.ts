/**
 * 跨引擎共享的默认阈值/预算/比例/超时（P4.2 工程卫生：单一来源）。
 *
 * 规则：跨引擎共享的默认值一律走这里的具名常量，禁止各引擎裸字面重复。
 * 各引擎 config 仍可覆盖（`config.x ?? DEFAULT_X`），本文件只承载"默认值"语义。
 */
/** 默认上下文窗口（token）。graph 引擎 windowTokens 缺省锚。 */
export declare const DEFAULT_WINDOW_TOKENS = 16384;
/** 默认保留目标（token）。graph 引擎 retainTokens 缺省锚。 */
export declare const DEFAULT_RETAIN_TOKENS = 8192;
/** chars/token 估算系数（无 tokenMeter 时的降级度量基准）。 */
export declare const DEFAULT_CHARS_PER_TOKEN = 3.5;
/** A 形态前缀预算（token）。peratom compressor/declarer prefixBudgetTokens 缺省锚。 */
export declare const DEFAULT_PREFIX_BUDGET_TOKENS = 132000;
/** 触发线占上下文比例（windowTokens 未显式指定时按 contextWindow × 此比例解析）。 */
export declare const DEFAULT_WINDOW_RATIO = 0.8;
/** 保留目标占触发线比例（retainTokens 未显式指定时按 windowTokens × 此比例解析）。 */
export declare const DEFAULT_RETAIN_RATIO = 0.2;
/** LLM 调用超时（ms）。peratom compressor/declarer timeoutMs 缺省锚（P4.3 统一）。 */
export declare const DEFAULT_LLM_TIMEOUT_MS = 180000;
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
export declare const DEFAULT_SKIP_CONTEXT_FORMS: readonly string[];
/** 贪心剪枝最大 pass 数（graph 引擎 maxPasses 缺省锚）。
 *  2026-09-22：由 16 提到 10000——剪枝循环正常靠「压缩率达标 / 全保护 / 无进展」自然终止，
 *  此值退化为纯安全上限（防极端空转），不再作为「每次压缩只剪 16 组」的增量节流阀。 */
export declare const DEFAULT_MAX_PASSES = 10000;
