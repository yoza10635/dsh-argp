/**
 * ARGP 压缩引擎（2.0 factor-only）。
 *
 * 宿主面 = `CompactionEngine`：pre-step 三通道（压力逃生口 / §9.37 出口闸 / §9.36
 * 浓缩闸二）、溢出 400 恢复、手动 `/compact`、`/argp` 只读状态。
 * 事务内核 = factor 引擎（R 贴标剪枝，0-LLM）+ 散文浓缩（唯一 LLM 摘要通路）。
 *
 * 1.x 的 stage-2 图剪（建图/闭包/版本链/cites 边/catalog/list_pruned 召回面）已整体
 * 退役：老方案锁定在 npm latest 1.11.2（tag v1.11.2）。读侧兼容保留：老墓碑文法、
 * 老 `data.argpCites` 忽略读、`prune-tx` 的 tool/result 克隆配对契约。
 *
 * 循环 import 规约：引擎是唯一组合根，向下单向依赖各功能模块；各模块经窄接口
 * （LifecycleHost / BudgetHost / RecallHost / PruneTxHost / FactorEngineHost …）回指，
 * 编译期断言、运行时同一实例。
 */
import type { Context, Volatile } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { CompactionEngine } from '@deepseek-ai/dsh-compaction';
import type { CompactionAgentContext, CompactionResult, CompactionTrigger, ManualCompactAgentContext } from '@deepseek-ai/dsh-compaction';
import type { Session } from '@deepseek-ai/dsh-session';
import type { CommandId } from '@deepseek-ai/dsh-commands/brand';
export type { NodeState, LogRow, LogRowType } from './log-access.js';
export { eventText } from './log-access.js';
import type { Atom } from './argp-types.js';
export type { Atom, AtomType, ArgpUserSettings } from './argp-types.js';
import { type PrunedNodeInfo, type SessionRuntimeState } from './session-state.js';
export type { PrunedNodeInfo } from './session-state.js';
import { type CiteStats } from './graph-build.js';
export { looksAskText, classifyUserMessage, extractCites } from './graph-build.js';
export type { CiteStats } from './graph-build.js';
export { scaleBudgets } from './budget.js';
import type { GraphPruneRecord } from './prune-tx.js';
export type { GraphPruneRecord } from './prune-tx.js';
export { ARG_SETTINGS_KEY, ArgpUserSettingsSchema } from './session-lifecycle.js';
/**
 * 解析后的设置页旋钮（dsh 0.1.7+ 的 `Config` 形状）。与下面 `static Config` schema
 * 一一对应：schema 负责校验 + 表单生成，本 interface 负责引擎侧的读取类型。
 * 每个字段标 `Volatile<T>` = "无需重新挂载即可变化"，引擎经 `.get()` 读实时值。
 */
export interface ArgpLiveConfig {
    windowRatio: Volatile<number>;
    retainRatio: Volatile<number>;
    charsPerToken: Volatile<number>;
    focalTurns: Volatile<number>;
    vocabTopN: Volatile<number>;
    recallLimit: Volatile<number>;
}
/**
 * 引擎构造配置（2.0 factor-only 面）。
 *
 * 保留的键 = factor 事务与本会话可观测面实际消费的字段；1.x graph 臂的旋钮
 * （maxPasses/recencyGuard/turnGuard/minSpanChars/sortMode/闭包/cites/推断边/peratom…）
 * 已退位——cordis 非 strict 合并仍会把它们透传进来，normalizeConfig 宽容读 + 告警忽略
 * （老 profile 不炸，但不静默改变预期）。
 */
export interface ArgpGraphConfig {
    /** 触发线（token）。不传时默认 = 适配器声明的 contextWindow × windowRatio（默认 0.8）。 */
    windowTokens?: number;
    /** 保留目标（token）。不传时默认 = 触发线 × retainRatio（默认 0.2，压缩率 1/5）。 */
    retainTokens?: number;
    /** 触发线占上下文比例（默认 0.8；仅当 windowTokens 未显式指定时生效）。 */
    windowRatio?: number;
    /** 保留目标占触发线比例（默认 0.2；仅当 retainTokens 未显式指定时生效）。 */
    retainRatio?: number;
    /** 字符/token 估算比（默认 3.5；provider usage 锚点在位时以其为准）。 */
    charsPerToken?: number;
    /** 触发保留余量（token）；默认 0。windowTokens 会先减去该值作为触发线。 */
    reserveTokens?: number;
    /** 诊断/遥测数组容量上限（保留最近 N 条，默认 256；P4.5 有界化）。 */
    telemetryCap?: number;
    /** 可选显式 token 测量函数；不传则退化为字符估算。 */
    measureTokens?: (session: Session) => {
        contextTokens: number;
        surfaceTokens: number;
    };
    /** 上下文溢出恢复的最大重试次数（context-overflow trigger），缺省 1（对齐官方 compaction-basic）。 */
    maxOverflowRetries?: number;
    /**
     * 在这些 agent preset 下**不生效**（不剪枝/不压缩，会话历史保持原生态）的 preset id 列表。
     * 默认 `['minimal']`。判定按**会话实际运行的 preset**（session projection `agentPreset`）；
     * 无 preset 信息的会话（如 headless/CLI profile 无 preset registry）不受影响。
     * 设为 `[]` 关闭该行为（所有 preset 下都生效）。
     */
    skipPresets?: string[];
    /** 焦点轮数（§2.5，设置卡旋钮的构造期缺省）。 */
    focalTurns?: number;
    /** 词表每类 topN（§1.4，设置卡旋钮的构造期缺省）。 */
    vocabTopN?: number;
    /** recall_history 缺省 limit（P0 宽度实测 p50=8；现默认 5 沿用 P2-1 已测口径）。 */
    recallLimit?: number;
    /** 2.0 判别式仅剩 'factor'：旧的 'graph' 值宽容读但在构造期告警并按 factor 运行。 */
    engine?: 'factor';
}
/**
 * 流式中 assistant 消息落盘后，立即剥离尾部 {"cites":[...]}（ARGP 引用协议产物），
 * 使其不残留在**模型可见 surface** 上——下一轮请求不再把协议产物当正文重读。
 * 2.0 factor 契约已不再要求模型输出 cites；本剥离保留为**残差清扫**（历史会话与
 * 旧契约惯性的输出），幂等且零副作用。
 * 注意（2026-08 修正认知）：Web UI 的人类转录按 dsh 核心设计固定取 append 起源
 * 事件，replace 副本是 model-only（core session surface.ts："replacement copies
 * stay model-only"），因此本剥离**不影响 UI 显示**。
 * 仅改写最后一个 text 块；保留 model/provider/replay 等元数据；将 cites 存入
 * data.argpCites，以便后续 atomize 读侧仍能取到引用（文本已剥离后 extractCites 取不到）。
 * 幂等：已剥离节点（含 argpCites）再次进入时直接跳过，无重入循环。
 */
export declare function stripTrailingCitesIfNeeded(session: Session, event: {
    seq: number;
    data?: Record<string, unknown>;
}): void;
export declare class ArgpGraphEngine extends CompactionEngine {
    /**
     * UI 设置页可调旋钮（dsh 0.1.7+）。Settings 通过扫描插件的 `static Config` 生成
     * 表单，不再接受 `settings.register(ns, schema, { base })` —— 该 API 在宿主
     * 0.1.7（#4587，`profile-owned-live-configuration`）已移除。字段标 `.volatile()`
     * 表示"无需重新挂载即可变化"，引擎侧每次经 `config.x.get()` 读当前值。
     *
     * 2.0 名册 = 6 枚（design-2.0 §3.4）：3 枚引擎通用（windowRatio/retainRatio/
     * charsPerToken）+ 3 枚 factor（focalTurns/vocabTopN/recallLimit）。1.x graph 五键与
     * engine 判别式退位（设置卡不再渲染，profile 里的老值宽容读+告警，见 normalizeConfig）。
     */
    static Config: z<Schemastery.ObjectS<NoInfer<{
        windowRatio: z<number, number, "volatile-defined">;
        retainRatio: z<number, number, "volatile-defined">;
        charsPerToken: z<number, number, "volatile-defined">;
        focalTurns: z<number, number, "volatile-defined">;
        vocabTopN: z<number, number, "volatile-defined">;
        recallLimit: z<number, number, "volatile-defined">;
    }>>, Schemastery.ObjectT<NoInfer<{
        windowRatio: z<number, number, "volatile-defined">;
        retainRatio: z<number, number, "volatile-defined">;
        charsPerToken: z<number, number, "volatile-defined">;
        focalTurns: z<number, number, "volatile-defined">;
        vocabTopN: z<number, number, "volatile-defined">;
        recallLimit: z<number, number, "volatile-defined">;
    }>>, "plain">;
    static inject: string[];
    /** Cordis 解析出的设置页旋钮引用（volatile 字段经 `.get()` 读实时值）。 */
    private readonly args;
    /** 2.0 因子引擎（构造期恒装配、会话内不变）。 */
    private readonly factor;
    /** P6-④ 散文浓缩链（factor 唯一 LLM 摘要通路，只在压缩事务内被调；见 prose-condenser.ts）。 */
    private readonly prose;
    /** P6-④ 触发收敛逃生口（构造期快照，ARGP_FACTOR_TIER 同款纪律）：env 置 1 恢复旧估算驱动压力剪。 */
    private readonly pressureTriggerEnabled;
    /** §9.37 出口闸（构造期快照，缺省开；见 resolveEgressEnabled / egressGate）。 */
    private readonly egressEnabled;
    readonly windowTokens: number;
    readonly retainTokens: number;
    /** true = config 显式给 windowTokens；false = 运行时按 contextWindow × windowRatio 解析。 */
    private readonly explicitWindowTokens;
    /** true = config 显式给 retainTokens；false = 运行时按 windowTokens × retainRatio 解析。 */
    private readonly explicitRetainTokens;
    readonly reserveTokens: number;
    readonly tokenMeterFn?: (session: Session) => {
        contextTokens: number;
        surfaceTokens: number;
    };
    /** 在这些 preset 下不生效的 preset id 列表（构造期定，默认 ['minimal']）。 */
    private readonly skipPresets;
    /** 已就"跳过"记过日志的会话（每会话只记一次，避免 pre-step 每步刷屏）。 */
    private readonly skipLogged;
    /**
     * 旋钮读取点（dsh 0.1.7+）：直接读 Cordis 解析出的 volatile 引用，用户经设置页写入
     * 后下一次 `.get()` 即为新值（`profile-owned-live-configuration` 要求的"消费者在操作时
     * 读取其引用"）。构造期快照字段 `argpSettings` 随旧 `settings.register` 一并移除。
     */
    get windowRatio(): number;
    get retainRatio(): number;
    get charsPerToken(): number;
    /** recallLimit 旋钮活读（RecallLabelsHost 接线；缺省 5 = P2-1 已测口径）。 */
    recallLimitOf(): number;
    readonly maxOverflowRetries: number;
    /** dsh token-meter 服务；真会话中可用时优先用于 token 测量和 contextWindow 探测。 */
    private readonly tokenMeter;
    /** 遥测数组容量上限（P4.5：records/recallCalls/auditWarnings 有界）。 */
    readonly telemetryCap: number;
    /** prune-tx 接口成员（factor 事务不读；图时代的墓碑归并阈值，保留默认值供旧骨架）。 */
    readonly tombstoneMergeMinRun = 8;
    get records(): GraphPruneRecord[];
    get recallCalls(): {
        seq: number;
        hit: boolean;
        state?: import('./log-access.js').NodeState;
    }[];
    get citeStats(): CiteStats;
    /** 已剪节点目录（seq -> 元数据），供 /argp 与账目重建。 */
    get prunedNodeIndex(): Map<number, PrunedNodeInfo>;
    get recallCallsThisTurn(): number;
    get recallCharsUsed(): number;
    /** context-overflow 恢复：每个 agent 的重试计数（assistant/message 成功或 idle 时重置）。 */
    private readonly overflowRetries;
    /** session → agent 映射，供成功后重置重试计数（agent loop 上下文经 session/event 取不到 agent）。 */
    private readonly overflowAgents;
    /** 最近一次请求的真实 prompt token（usage.inputTokens + cacheReadTokens + cacheWriteTokens，
     *  provider 回报，与 UI ContextMeter 分子同口径）。
     *  pressure check 用它锚定 + 增量估算，替代 tokenMeter 的 chars/4 启发式（低估 30%+，
     *  导致迟触发/窗口保护失效，2026-08-23）。 */
    get lastRealPromptTokens(): number;
    set lastRealPromptTokens(v: number);
    /** 声明窗口缓存（session → 适配器声明的 contextWindow，来自 request/context 事件）。
     *  真环境联调实证：物理窗口探测（llama.cpp n_ctx=262144）与声明窗口（32000）
     *  在 pre-step 时刻可能错位，声明值缺失时宁可跳过检查也不用物理口径。 */
    private readonly declaredContextWindows;
    /** 锚点：lastRealPromptTokens 已覆盖的 surface 最大 seq（其后新增内容需增量估算）。 */
    get lastRealAnchorSeq(): number;
    set lastRealAnchorSeq(v: number);
    /** 本会话最近解析的有效窗口（桶化随 rt；budget.ts 经 stateOf 直写本桶，见 session-state.ts）。 */
    get resolvedWindowTokens(): number;
    set resolvedWindowTokens(v: number);
    /** /compact 手动压缩的发起命令 ID（presentation correlation，透传给事务事件）。 */
    private compactSourceCommandId;
    /** A7：账本重建后追加的审计警告（供测试断言/诊断；per-session）。 */
    get auditWarnings(): string[];
    /** A7：已重建过的 compactionId 集合（per-session 分桶后天然跨会话隔离，幂等 + 告警不重复）。 */
    get rebuiltCompactionIds(): Set<string>;
    /** 本次请求声明的输出预算（`agent/request` 捕获；适配器的钳制发生在其后，故这里拿到的是请求值）。 */
    private readonly requestMaxTokens;
    /** §9.37 出口闸·输出预算档③：llm `resolveModelInfo().defaultMaxTokens` 探测缓存
     *  （请求缺 maxTokens 时 llm 服务在 agent/request 瀑布**之后**注入它——观测档盲区，
     *  宿主 llm/src/index.ts resolveCallWithInfo 实证）。0 = 已探无（不重探）；缺键 = 未探。 */
    private readonly modelDefaultMaxTokensCache;
    private session;
    /** 会话运行时状态分桶（1-1）：stateOf 懒建；rt = 当前焦点会话的桶（bindRuntimeState 换装）。 */
    private readonly sessionStates;
    private rt;
    /** 绑定过的会话身份登记（sessionCount 用；WeakSet 不持有引用）。 */
    private readonly seenSessions;
    private seenSessionCount;
    stateOf(session: Session): SessionRuntimeState;
    /** bindSession 专用：把焦点桶换装为该会话的桶（session-lifecycle 经 LifecycleHost 调用）。 */
    bindRuntimeState(session: Session): void;
    /** 引擎累计绑定过的不同会话数（WeakSet 计数；>1 时召回工具不得回退焦点会话）。 */
    sessionCount(): number;
    /** 结构化日志门面（构造期自 ctx 捕获）。 */
    private readonly log;
    constructor(ctx: Context, config?: ArgpGraphConfig);
    /**
     * A7（问题 3 修订）：session 绑定统一入口——setSession / agent/pre-step / compactIfNeeded 首次绑定
     * 都走这里。绑定后若 records 为空且日志含 compaction/start 事件（resume 场景：账目丢失仅日志在），
     * 懒触发 rebuildLedgerFromLog() 自动重建；幂等由 rebuiltCompactionIds 去重保证。
     */
    private bindSession;
    setSession(session: Session): void;
    /**
     * 真实 token 锚点回填（2026-09-21 修，问题定位见内部根因台账）。
     *
     * 背景：`lastRealPromptTokens` / `lastRealAnchorSeq` 原先**只**由 `ctx.on('session/event')`
     * 的 `assistant/message` 处理器写入。宿主进程重启后 resume 的会话若不再把该事件喂给本
     * 引擎（真环境 2026-09-21 实证：同一会话 turn 1 锚点正常、turn 2 起恒为 0），
     * `measureTokens` 会静默走回退分支 `visibleChars / charsPerToken`——而 `visibleChars`
     * 的投影口径**不含 reasoning**。实测该估算 ≈ 真实 prompt 的 **0.48 倍**：
     *   turn 6 真实 prompt 210,719 tok 时估算仅 ≈102,703 ⇒ 触发线 100,007 一路不越线，
     *   直到真实 prompt 210,719 才触发（迟 2.1×，66 步空转）。
     *
     * 口径与 usage 处理器**完全一致**（in + cacheRead + cacheWrite = provider 回报的 billed
     * prompt），取日志中最后一条带 `usage.inputTokens` 的 `assistant/message`——即本进程
     * 重启前最后一次真实请求的 prompt 规模。日志无带 usage 的应答（全新会话）⇒ 重置为
     * 0 / -1，保持既有回退行为（新会话首轮本就没有可用锚点）。
     *
     * 幂等与成本：反向扫描在最后一条带 usage 的应答处提前返回（通常就是最后一条应答）；
     * 会话身份每步换新（见 bindSession 注释）时重复回填的值恒等于 live 处理器写入的值
     * （日志 append-only，最后一条 usage 恒 ≥ 内存锚点），故重复执行不会回退。
     */
    private restoreUsageAnchor;
    /**
     * 声明窗锚点回填（2026-11-13，R2 修后世界实锤）：`declaredContextWindows` 原先**只**
     * 由活 `session/event` 的 `request/context` 写入。headless 驱动每轮新起一个 dsh 子进程
     * （`--session-id` resume），历史 `request/context` 不会重放到新进程的 WeakMap ⇒
     * `egressGate` 读到 `declaredWindow=0` 直接 `return false`，§9.37 出口闸在 T02 起就死了，
     * 400→剪→重试→全量重灌链原样复活（cand-shadow-fix T13/T18/T2x 共 4 笔死流实锤）。
     * 与 `restoreUsageAnchor` 同模式：反向扫日志取最后一条声明值；每 session/进程只扫一次
     * （WeakMap 已有值即早退；活事件更新不受影响）。
     */
    private restoreDeclaredWindow;
    /**
     * 增量维护被遮蔽 surface seq 集合（账本语义见 recall.ts）。
     */
    private shadowedSeqsOf;
    /**
     * 原子化（§4.1）：只投影 surface 节点；U/X/R/A 四类（tool/call 不进 surface，无 T 类）。
     *
     * node 0 保护（2026-09-10，dsh 0.1.5 起）：宿主把 system prompt 表示为 surface node 0 的
     * `system/message`，并在 surface.ts `assertSystemHeadRewrite` 里硬性保护——任何覆盖 node 0 的
     * replace 必须是"恰好覆盖该单节点的 system/message"，否则 throw。
     * 本投影**静默跳过** system/message，因此 node 0 永远不会进入 ARGP 的剪枝区间。
     */
    atomize(session: Session): Atom[];
    /** 测量当前上下文 token。优先「真实 usage 锚点 + 增量估算」（2026-08-23，
     *  替代 tokenMeter chars/4 低估导致的迟触发/窗口保护失效）；无锚点才回退
     *  dsh tokenMeter / 配置函数 / 字符估算。source 标注估计来源。
     *  `extraTokens`（1.4.0）：本步**已 claim 但尚未落盘**的 user 消息估值。轮初它既不在
     *  surface 里、也不在锚点覆盖范围内，漏掉就等于漏算"这一轮的启动量"——而用户恰恰
     *  常在轮初粘贴大段文本。
     */
    private measureTokens;
    /**
     * 本步已 claiming（尚未落盘进 surface）的 user 消息估值：字符数 ÷ charsPerToken。
     * 与 `measureTokens` 的增量口径同基准（同一 charsPerToken），可直接相加。
     */
    private incomingTokens;
    /**
     * recall 预算：单次结果与累计结果都按窗口比例截断（窗口取最近解析的有效预算）。
     * 预算耗尽时显式说明剩余额度与何时恢复；每笔 compaction 事务成功后归零
     * （见 prune-tx 事务尾）。
     */
    private budgetRecallText;
    /**
     * 预算解析：显式配置用显式值；否则从适配器声明的 contextWindow 按比例推导——
     *  windowTokens = contextWindow × windowRatio（默认 0.8），retainTokens = windowTokens × retainRatio（默认 0.2）。
     *  上下文容量由其他插件（模型适配器声明）决定，本引擎不硬编码。
     *  解析顺序：1) session.requestContext()（request/context 事件，真会话最可靠）；
     *           2) llm.resolveModelInfo(provider, model)；3) 静态默认值。
     */
    private resolveScaledBudgets;
    /**
     * 会话当前运行的 agent preset id（从 session projection 读取）。
     *
     * 返回：
     *  - `undefined`：本 profile 无 agent-preset-registry（无 preset 概念，如 headless/CLI）
     *    → 不跳过（按现状工作）。
     *  - `null`：registry 在，但会话头未记录 preset（非 preset 流程创建）→ 不跳过。
     *  - 字符串：会话实际运行的 preset id（可被 `agent-preset/selected` 事件切换）。
     *
     * `sessionProjections` 是 dsh-base 的核心服务（恒在），但 `agentPreset` 这个
     * projection key 由 web-app 的 agent-preset-registry 注册——dsh-argp 不依赖该包，
     * 故经结构类型窄接口读取（避免新增 peer/dep），服务缺失时安全降级为 undefined。
     */
    private activePresetOf;
    /**
     * 会话是否运行在 skipPresets 列出的 preset 下（= ARGP 不生效，保留原生态）。
     * 无 preset 信息（undefined/null）时不跳过。命中时记一次日志（每会话一次）。
     */
    private skipIfPreset;
    /**
     * §9.36 浓缩通道闸二（ctx 闸；用户裁定 2026-11-13：检查点可在发送之后=usage 账单锚）：
     * pre-step 位（上一请求 usage 已落锚、下一请求未发）测得总上下文 ≥ 触发线
     * （windowRatio×声明窗，缺省 0.8）⇒ 驱一发清扫式浓缩（prose.condense 内查闸一）。
     * 锚点健康前提（H6）：source='anchored'（usage 真锚；断锚退 chars 估=禁触发破坏性
     * 改写，宁缺勿错）+ 声明窗已知。手动 compactNow 免本闸（手动语义保留）。
     * 0.2×声明窗留给摘要输出（输出预算=summaryMaxTokensOut(声明窗)）。
     */
    private condenseGate;
    /**
     * §9.37 出口闸（缺省开；ARGP_FACTOR_EGRESS=0 关=仅修前/修后对照臂）——用户裁定
     * 2026-11-13："什么设计都无法接受反复重试再全量重灌的成本"。P6-④ 把 400 当触发器的
     * 贴墙账（T24-J R2 实锤）：贴墙轮先发出**必然超窗**的请求（`400 … request (273639
     * tokens) exceeds the available context size (262144)`——6 笔零 usage 死流恰每笔事务
     * 轮一发，这串 prefill 在 usage 账里完全隐形）→ 拒收后剪 → 重试再全量重灌；端点窗边
     * 行为还分叉：有时静默把 max_tokens 钳到 窗−prompt 再打满（T23 out=1,617，marker 丢轮）。
     * 出口闸 = pre-step 位（上一请求 usage 已锚、下一请求未发）做确定性容量算术：
     *   anchored 实测（含本步增量估值）≥ 声明窗 − 输出预算 − 提前量 ⇒ 请求根本不发，
     *   先走标准压缩事务（compactIfNeeded('pressure') factor 分发：R 剪 0-LLM 在前，
     *   散文浓缩按 §9.36 双闸跟后）再发。剪的目标位是 retain（既有 deficit 口径）而非
     *   贴线微剪——首笔过线的驱逐深度=窗×(触发线−retain)量级，账（审查 F3）：方向与
     *   "多留=早一点剪（可召回）"一致。只认 anchored（断锚禁驱动破坏性改写，P6-④
     *   "只有确定性的才可以"原样保留）。anchored 标签≠真锚：事务后 prune-tx 把锚重置为
     *   chars 估算仍标 'anchored'（审查 F4）——敞口有界：事务后上下文已回落 retain 位，
     *   且下一笔成功请求即重锚真 usage；根治=锚 provenance 位（挂后）。
     * 输出预算三源取 **max**（保守侧：多留早剪，漏留撞墙）：①`agent.options.maxTokens`
     * ——宿主 buildRequest 正是拿它发请求（agent-loop agent.ts 组装段实证），headless
     * 每轮新进程时首轮唯一可得；②requestMaxTokens 观测（agent/request 瀑布，本进程
     * step≥2 才有）；③`llm.resolveModelInfo().defaultMaxTokens`——请求缺 maxTokens 时
     * llm 服务在瀑布**之后**注入（resolveCallWithInfo 实证），②对它失明、①会被
     * adapterDefaults 剥除。三源全缺（注册面不可见的端点缺省 mct——R2 实锤
     * request=prompt+65,536）才退 DEFAULT_EGRESS_OUTPUT_RATIO×声明窗。
     * 逃生口互斥（审查 F5）：ARGP_FACTOR_PRESSURE=1 的"旧世界字节级复现"契约要求本闸
     * 不挂（调用点门控）——两 env 各管各的对照世界，不叠乘。
     * 400 overflow 通路保留为最后兜底（网不拆：声明窗未知/断锚/剪空/线≤0 → 照发，由
     * overflow 链接管——严格不差于现状）。
     * @returns true = 本步已发剪事务（调用方把同 step 的浓缩闸顺延，不吃二次重铸）。
     */
    private egressGate;
    /** §9.37 出口闸·输出预算档③：模型注册面的缺省输出预算（每会话探一次，0=已探无）。 */
    private modelDefaultMaxTokens;
    compactIfNeeded(agent: CompactionAgentContext, trigger: CompactionTrigger, signal: AbortSignal, 
    /** 本步已 claim 未落盘的 user 消息估值（轮初专用；其余调用点省略）。 */
    incomingTokens?: number): Promise<CompactionResult | null>;
    compactNow(agent: ManualCompactAgentContext, signal: AbortSignal, sourceCommandId?: CommandId): Promise<CompactionResult | null>;
    compactRegion(_start: number, _end: number, _agent: CompactionAgentContext, _signal?: AbortSignal): Promise<CompactionResult>;
    /**
     * 词表 note 迁入压缩事务收尾（P6-② 违规点整改，note 前缀炸弹案施工①）：note 变化时机
     * = 压缩时机——"缓存断点频率=压缩频率"不变量的 note 特化（T-3 定量证实每步一改一炸）。
     * steer 仅首注需要（更新走单节点 replace，指针以标记回溯为准）；本入口拿不到 steer
     * （CompactionAgentContext 无该成员）时首注跳过——下个有 steer 的压缩机会自然重试。
     */
    private refreshFactorNoteSafe;
    /**
     * factor 臂轮内维护（**仅 ARGP_FACTOR_PRESSURE=1 逃生口**，P6-④ 前旧世界复现）：
     * 先词表 note（旧时机 = 每 pre-step），后压力剪（估算驱动）。缺省路径（收敛后）不进本函数
     * ——压力剪退役、note 迁压缩事务收尾（refreshFactorNoteSafe）。
     */
    private factorPressure;
    /**
     * A7 事务账目重建：resume 时从 append-only 日志扫描 compaction/start、compaction/prune、
     * compaction/end 事件重建 records/prunedNodeIndex/shadowedSeqsOf 状态；无 end 的 start 记 warn。
     * 不引入 WAL——日志本身即账目。幂等：已重建过的 compactionId 跳过（rebuiltCompactionIds 去重），
     * 使「setSession 自动重建」与「测试显式清空 records 后再重建」两种路径都安全。
     */
    rebuildLedgerFromLog(): void;
}
export default ArgpGraphEngine;
