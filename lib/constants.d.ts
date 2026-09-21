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
/** 贪心剪枝最大 pass 数（graph 引擎 maxPasses 缺省锚）。 */
export declare const DEFAULT_MAX_PASSES = 16;
