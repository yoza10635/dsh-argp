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
/** chars/token 估算系数（无 tokenMeter 时的降级度量基准；非 CJK 桶，Issue5 后口径）。 */
export declare const DEFAULT_CHARS_PER_TOKEN = 3.5;
/**
 * CJK chars/token 估算系数（Issue5，2.1.0）：`estTokens = nonCjk/3.5 + cjk/κ` 的 CJK 分量。
 *
 * **κ = 1.7 = Qwen3.8 tokenizer 标定值**（2026-11-17，tb21p 同帧配对差分：自然中文
 * 散文 30K chars 两独立组读数 1.714/1.675，pooled 1.70；读数表 design-2.1.0-batch §5）。
 * 3.5 对中文重负载系统性低估 ~2×（本常量的动机，外评 Issue5）。
 *
 * 跨 tokenizer 不重标定 = **刻意简化**（README 口径声明）：换端点时 κ 不自动跟随，
 * 估算仍只是兜底语义（anchored 真值面不受影响）。白名单判定与消费点见 `cjk.ts`。
 */
export declare const CJK_CHARS_PER_TOKEN = 1.7;
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
export declare const HOST_CHARS_PER_TOKEN = 4;
/**
 * `shadowedTokenCount` 的**唯一定价点**（宿主契约字段）。
 *
 * 全部发射点（peratom flush 的整窗 summary / per-atom prune、prune-tx 的 summary /
 * 逐区间 prune）一律经本函数，禁止各点裸写 `/ 3.5` 或 `/ host.charsPerToken`——
 * 旧的病灶正是三处发射器三种口径（/3.5 硬编码、/4、旋钮 3.5）在同一条 fold 流上
 * 记两本账。口径锁定测试（`test/compaction-prune-017.test.ts`）对本函数与真实发射路径
 * 双重验锁：摘掉任一发射点的本函数调用必须变红。
 */
export declare function shadowedTokensOf(chars: number): number;
/** 触发线占上下文比例（windowTokens 未显式指定时按 contextWindow × 此比例解析）。 */
export declare const DEFAULT_WINDOW_RATIO = 0.8;
/** 保留目标占触发线比例（retainTokens 未显式指定时按 windowTokens × 此比例解析）。 */
export declare const DEFAULT_RETAIN_RATIO = 0.2;
/** 焦点轮数缺省（2.0.0 起零旋钮：原 focalTurns 设置项退役，缺省固化）。 */
export declare const DEFAULT_FOCAL_TURNS = 1;
/** 词表 note 每类行数缺省（原 vocabTopN 设置项退役，缺省固化）。 */
export declare const DEFAULT_VOCAB_TOP_N = 10;
/** recall_history 缺省条数（原 recallLimit 设置项退役；沿用 P2-1 已测口径 5）。 */
export declare const DEFAULT_RECALL_LIMIT = 5;
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
 *  二次损失。它们更适合交给剪枝事务：全留或全删 + 墓碑 + 标签取回
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
/**
 * 焦点文档 hard 宽度熔断阈值（design-2.0 §2.5 v1.1 用户裁定 + spike54 宽度账）：
 * tiered 模式下焦点文档全枚 hard，但若其 hard 候选字节占比超过本阈值，说明焦点
 * 面过宽（实测语料 8.3%，留足余量），退化为**每文档最新一枚**——保险不反噬预算。
 * 内部常量，不进 static Config（零旋钮锁 ZK1 / preset 键锁）。
 */
export declare const FOCAL_DOC_HARD_WIDTH_RATIO = 0.15;
/** 词表 note 的行首标记：resume 找回 note 指针的判据；也是 prose 可吞判据
 *  （2026-11-13 审查 P0-6：note 不得成为散文 span 的永久 barrier）。改文案不得动标记。 */
export declare const VOCAB_NOTE_MARKER = "[argp-factor \u8BCD\u8868]";
/** 因子组剪的压缩检查点文案（2026-11-13 用户裁定：空 developer 在宿主 compaction
 *  边界非法——fold 要求 open step；改用宿主原生的 compact-checkpoint user message）。
 *  模型可见，但只是"旧次要原子已压缩"的中性标记，不含指针；标签见词表 note。 */
export declare const FACTOR_COMPACTED_MARKER = "\u5DF2\u538B\u7F29\u526A\u679D\u6B21\u8981\u539F\u5B50";
/**
 * 表面桩游程回收阈值（2026-11-26 session-43df801e 审计）：surface 上紧邻的
 * compact-checkpoint 桩（文本逐字节相同）达到该数即随**当笔压缩事务**顺带归并
 * （不独立发维护事务——surface 换代税只交一次）。阈=2 与事务内相邻同文并条
 * （prune-tx 归并 pass）对称同判据：相邻同文桩对模型本已不可分辨。1.x 图臂的
 * tombstoneMergeMinRun=8 旋钮已随 2.0 零旋钮退役（RETIRED_GRAPH_KEYS），不复活
 * 配置面。
 */
export declare const FACTOR_STUB_RUN_MIN = 2;
/**
 * 焦点尾窗组数上限（2026-11-13 用户裁定）：最新轮 A/R 字节占当前 A/R 面
 * ≥ {@link FOCUS_TURN_SHARE_THRESHOLD} 时，焦点从"整轮"降级为该轮最新的
 * 至多 10 个 A+R 协议组——最后一轮本身过大时，整轮保护会让可剪面归零。
 * 只影响硬保护/组剪的焦点判据；散文浓缩仍按 turn 保护（不在此列）。
 */
export declare const FOCUS_GROUP_CAP = 10;
/** 焦点尾窗降级的触发线：最新轮 A/R 字节占全部 A/R 字节的比例。 */
export declare const FOCUS_TURN_SHARE_THRESHOLD = 0.5;
/**
 * 焦点名额（2.2.1 包二 A1，用户 2026-11-26 裁定形态）：非升级态下焦点区按位置从新到旧
 * 排名，最新的 {@link FOCUS_QUOTA_GROUPS} 组仍硬保护；**超出名额的组只有「全组 R 均被
 * superseded 判据判死」才降级整组离场**（事实门控——放宽的是位置门，从不放宽事实门）。
 * barrier/附件组豁免不占名额；open 区（本轮协议现场）不入降级带；升级态（占比≥50% ∧
 * 组>10）走原 FOCUS_GROUP_CAP 无事实离场路径，语义不变。固化值，不进设置。
 */
export declare const FOCUS_QUOTA_GROUPS = 20;
/** 名额预算比例 δ（包二）：δ·W_eff 装不下名额组数（按组均字节折算）时名额收缩；
 *  分母 W_eff（ρ·W_eff 先例）。窗未知（manual/无快照）回退 N={@link FOCUS_QUOTA_GROUPS}。 */
export declare const FOCUS_QUOTA_BUDGET_RATIO = 0.3;
/**
 * §9.37 出口闸：输出预算三档源的最后一档——`agent.options.maxTokens`（装配期声明，
 * 宿主 buildRequest 正是拿它发请求，新进程首轮也可读）与 requestMaxTokens 观测
 * （agent/request 瀑布）皆缺位时，按声明窗 × 本比例预留生成空间。
 * 0.25 的依据：请求省略 maxTokens 时**服务端自己的默认 mct** 仍占生成预算
 * （R2 端点缺省 65536=0.25×262144；2026-11-14 撞墙探针勘误：400 计数是 prompt
 * 单独、钳位在窗−prompt 精确发生——预留 mct 的依据是严格 provider 强制
 * prompt+mct≤窗与钳位静默截断区，非「本端点按 prompt+mct 拒收」）。这一档在
 * 请求面完全隐形——观测档永远抓不到它。宁多留：漏留=撞墙 400/钳位静默截断，
 * 多留=早一点剪（可召回），代价不对称。
 */
export declare const DEFAULT_EGRESS_OUTPUT_RATIO = 0.25;
/** §9.37 出口闸提前量：越过 `线 − 声明窗×本比例` 即触发（容 anchored 后增量估值失真）。 */
export declare const DEFAULT_EGRESS_MARGIN_RATIO = 0.02;
/**
 * search_history 输出协议档位（design-prose-keyword-recall §1.2/D5/D9/D11 单点；
 * SH7 机器锁数）：缺省铺满 N≤FLAT_N→FLAT_TOK/原子、N≤FACET_N→MID_TOK、
 * N>FACET_N→分布档（不列）；显式 limit 页→PAGE_TOK；TF 饱和=BM25 饱和项整数形；
 * live 行合并阈值（P9/S10）。
 */
export declare const RECALL_SEARCH_FLAT_N = 20;
export declare const RECALL_SEARCH_FLAT_TOK = 100;
export declare const RECALL_SEARCH_MID_TOK = 20;
export declare const RECALL_SEARCH_FACET_N = 250;
export declare const RECALL_SEARCH_PAGE_TOK = 200;
export declare const RECALL_SEARCH_TF_CAP = 10;
export declare const RECALL_SEARCH_LIVE_MERGE_K = 5;
