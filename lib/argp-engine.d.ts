import type { Context, Volatile } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { CompactionEngine } from '@deepseek-ai/dsh-compaction';
import type { CompactionAgentContext, CompactionResult, CompactionTrigger, ManualCompactAgentContext } from '@deepseek-ai/dsh-compaction';
import type { Session } from '@deepseek-ai/dsh-session';
import type { CommandId } from '@deepseek-ai/dsh-commands';
export type { NodeState } from './log-access.js';
export { eventText } from './log-access.js';
import type { Atom } from './argp-types.js';
export type { Atom, AtomType, ArgpUserSettings } from './argp-types.js';
import { type PrunedNodeInfo, type SessionRuntimeState } from './session-state.js';
export type { PrunedNodeInfo } from './session-state.js';
import { type WorldFingerprint } from './env-world.js';
export { looksAskText, classifyUserMessage } from './atomize.js';
export { scaleBudgets } from './budget.js';
import type { GraphPruneRecord } from './prune-tx.js';
export type { GraphPruneRecord } from './prune-tx.js';
export { ARG_SETTINGS_KEY, ArgpUserSettingsSchema } from './session-lifecycle.js';
/**
 * 引擎构造配置（2.0 factor-only 面）。
 *
 * **2.0.0 起零旋钮**：原六枚设置项（windowRatio/retainRatio/charsPerToken/focalTurns/
 * vocabTopN/recallLimit）已退役，缺省值固化在 constants.ts（0.8/0.2/3.5/1/10/5）；
 * 老 profile 里的同名键由 normalizeConfig 宽容读 + 告警忽略。构造面保留显式
 * windowTokens/retainTokens（bench/高级部署按 token 直给，不依赖比例旋钮）。
 *
 * 1.x graph 臂的旋钮（maxPasses/recencyGuard/turnGuard/minSpanChars/sortMode/闭包/引用协议/推断边/peratom…）同样已退位——cordis 非 strict 合并仍会把它们透传进来，
 * normalizeConfig 宽容读 + 告警忽略（老 profile 不炸，但不静默改变预期）。
 */
export interface ArgpConfig {
    /** 触发线（token）。不传时默认 = 适配器声明的 contextWindow × 0.8。 */
    windowTokens?: number;
    /** 保留目标（token）。不传时默认 = 触发线 × 0.2（压缩率 1/5）。 */
    retainTokens?: number;
    /** 触发保留余量（token）；默认 0。windowTokens 会先减去该值作为触发线。 */
    reserveTokens?: number;
    /** 诊断/遥测数组容量上限（保留最近 N 条，默认 256；P4.5 有界化）。 */
    telemetryCap?: number;
    /**
     * 散文扫描带上限（search_history；FactorEngine 同名裸项透传）。**严禁进 static
     * Config**（ZK1 单键名册）：仅构造面直给（测试/bench），缺省=窗相对现算。
     */
    proseScanCapChars?: number;
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
    /** 2.0 判别式仅剩 'factor'：旧的 'graph' 值宽容读但在构造期告警并按 factor 运行。 */
    engine?: 'factor';
    /**
     * 压缩阈值（2.0.1 唯一活旋钮，volatile）：出口闸触发线 = 声明窗 × 本比例。
     * 0/缺省 = 关闭（模型撞墙 400 → 自动压缩兜底）。宿主 settings 源驱动时到达
     * Volatile thunk，经 getter `.get()` 读实时值（设置页改动免重挂生效）；profile
     * 直给裸数字也认（getter 两态兼容）。
     */
    compactionThreshold?: Volatile<number> | number;
}
/**
 * §A：从 400 溢出报文里解析**真实上下文上限**（observedCap）。只在报文带了明确
 * 数字上限时返回；pi-ai 通用文案（"detected context overflow"，无数）返回 undefined
 * ⇒ 调用方保留声明窗（行为不变）。返回的是模型窗（token），取报文里的"上限"侧数字。
 * 导出供单测。
 */
export declare function parseObservedContextCap(message: string | undefined): number | undefined;
export declare class ArgpEngine extends CompactionEngine {
    /**
     * UI 设置页旋钮（dsh 0.1.7+）。Settings 通过扫描插件的 `static Config` 生成
     * 表单；2.0.1 起名册唯一活键 = `compactionThreshold`（压缩阈值）：出口闸触发线
     * = 声明窗 × 本比例，0=关闭（模型撞墙 400 → 自动压缩兜底）。volatile = 设置页
     * 改动免重挂即生效。其余五枚旧旋钮保持退役（constants 固化 + 老键宽容告警）。
     */
    static Config: z<Schemastery.ObjectS<NoInfer<{
        compactionThreshold: z<number, number, "volatile-defined">;
    }>>, Schemastery.ObjectT<NoInfer<{
        compactionThreshold: z<number, number, "volatile-defined">;
    }>>, "plain">;
    static inject: string[];
    /** 2.0 因子引擎（构造期恒装配、会话内不变）。 */
    private readonly factor;
    /** P6-④ 散文浓缩链（factor 唯一 LLM 摘要通路，只在压缩事务内被调；见 prose-condenser.ts）。 */
    private readonly prose;
    /**
     * 每会话的词表快照（systemPrompt.context 的模型可见目录）。
     *
     * 只在压缩事务成功收尾时刷新；两次事务之间即使 provider 被重复调用也返回同一
     * 字节串。用 WeakMap 而非引擎字段，避免多会话目录串台。
     */
    private readonly vocabSnapshots;
    /** 是否已成功注册 systemPrompt.context（注册后 note 只作为无该服务时的回退）。 */
    private vocabContextRegistered;
    /** P6-④ 触发收敛逃生口（构造期快照，ARGP_FACTOR_TIER 同款纪律）：env 置 1 恢复旧估算驱动压力剪。 */
    private readonly pressureTriggerEnabled;
    /** 原始构造 config（压缩阈值 volatile 读实时值的取数面）。 */
    private readonly rawConfig;
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
    /** 已就"toolResultPruner 缺失"记过日志的会话（每会话一次，防压缩事务刷屏）。 */
    private readonly nativePrunerMissingLogged;
    /**
     * 2.0.0 起零旋钮：以下读取点返回 constants.ts 的固化缺省（原设置页六枚旋钮已退役）。
     * 显式 windowTokens/retainTokens 仍走构造配置；比例与估算口径不再可调。
     */
    get windowRatio(): number;
    get retainRatio(): number;
    get charsPerToken(): number;
    readonly maxOverflowRetries: number;
    /** dsh token-meter 服务；真会话中可用时优先用于 token 测量和 contextWindow 探测。 */
    private readonly tokenMeter;
    /** 遥测数组容量上限（P4.5：records/recallCalls/auditWarnings 有界）。 */
    readonly telemetryCap: number;
    get records(): GraphPruneRecord[];
    get recallCalls(): {
        seq: number;
        hit: boolean;
        state?: import('./log-access.js').NodeState;
    }[];
    /** 已剪节点目录（seq -> 元数据），供 /argp 与账目重建。 */
    get prunedNodeIndex(): Map<number, PrunedNodeInfo>;
    /**
     * A2：当前世界指纹（env 派生档 + 生效时机 + 显式 env 回显）。`/argp` 直接打印；
     * 出口闸线取本引擎当前「压缩阈值」（设置页活读），故与真实发射判据同源。
     */
    worldFingerprint(): WorldFingerprint;
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
    /** §A observedCap（session → 从数字型 400 报文学到的**真实**上下文上限）。
     *  仅当 provider 在 400 里报了真实 max（如 OpenAI "maximum context length is N tokens"）
     *  才落账；未知 ⇒ 有效窗退回声明（行为不变）。用于 `W_eff = min(声明, observedCap)`，
     *  修「声明窗 > 真实上限 ⇒ 压力/散文闸永不触发」的死锁。 */
    private readonly observedContextWindows;
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
    constructor(ctx: Context, config?: ArgpConfig);
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
     * 声明窗→会话桶播种（定点回放实锤 2026-11-26）：出口闸关且本进程无压力事务时
     * `resolveScaledBudgets` 零执行，`stateOf(session).resolvedWindowTokens` 保持初始种子
     * `DEFAULT_WINDOW_TOKENS=16,384` 并伪装成已解析值——派生读数（如散文扫描 cap
     * = window × charsPerToken × 2.7）缩到声明窗的 1/16，262K 窗补召轮的素材页全程
     * 不进检索带（46 轮 campaign 补充召回 0/7 根因，cap 实测 110,861 与 16K 种子
     * 算术逐位吻合）。播种只覆盖"从未被解析触碰"的默认种子；首次真解析（含
     * observedCap）由 resolveScaledBudgets 的桶写入自然覆盖。显式窗配置以显式值为
     * 准，不播种。
     */
    private seedBucketFromDeclared;
    /**
     * 增量维护被遮蔽 surface seq 集合（账本语义见 recall.ts；A5 起为位图）。
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
     *  `extraTokens`：本步**已 claim 但尚未落盘**的 user 消息估值。轮初它既不在
     *  surface 里、也不在锚点覆盖范围内，漏掉就等于漏算"这一轮的启动量"——而用户恰恰
     *  常在轮初粘贴大段文本。
     */
    private measureTokens;
    /**
     * 剪后投影（审查 P1-1）：取 max(锚点估算, tokenMeter 总量)。prune-tx 事务后锚点被
     * 重置为 `visibleChars/charsPerToken`（不含 system + tool schemas），单用它会低估算；
     * tokenMeter 在真会话可用时是含 tools/system 的权威值。
     */
    private postPruneProjection;
    /**
     * 本步已 claiming（尚未落盘进 surface）的 user 消息估值（Issue5 起为 CJK 加权：
     * nonCjk/3.5 + cjk/κ）。与 `measureTokens` 的增量口径同基准，可直接相加；
     * 非 CJK 输入 = chars/3.5 逐字等价。
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
     * §9.37 出口闸（接管世界缺省开=旧公式线；off/shadow 缺省关；env=1 或设置
     * 「压缩阈值」>0 恒开；env=0 对照硬覆盖）——2026-11-15 裁定「关为缺省」的前提
     * （旧双闸误触发风险 + 真实墙≈声明窗时 400 兜底可达）已被接管判据表实机 +
     * 真实墙≫声明窗端点的钳制饿死证据推翻，2026-11-25 翻转。它根除的链见 P6-④
     * 贴墙账（T24-J R2 实锤）：
     * 贴墙轮先发出**必然超窗**的请求（`400 … request (273639
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
     * adapterDefaults 剥除。三源全缺（端点缺省 mct 在请求面不可见）才退
     * DEFAULT_EGRESS_OUTPUT_RATIO×声明窗。2026-11-14 撞墙探针勘误：本端点 400 计数是
     * prompt 单独（288,292 与显式 max_tokens=1024 同数），prompt+65,536 联合超窗**照跑**
     * 并被服务端钳位到窗−prompt（精确到 token）——R2「273,639=prompt+65,536」系误读；
     * 预留 mct 的依据改为「严格 provider 强制 prompt+mct≤窗 + 钳位区是静默截断区
     * （T23）」，不再是「本端点按 prompt+mct 拒收」。
     * 逃生口互斥（审查 F5）：ARGP_FACTOR_PRESSURE=1 的"旧世界字节级复现"契约要求本闸
     * 不挂（调用点门控）——两 env 各管各的对照世界，不叠乘。
     * 400 overflow 通路在缺省关形态下是主自动触发（网即通路）；开闸时它退为最后兜底
     * （网不拆：声明窗未知/断锚/剪空/线≤0 → 照发，由 overflow 链接管——严格不差于现状）。
     * @returns true = 本步已发剪事务（调用方把同 step 的浓缩闸顺延，不吃二次重铸）。
     */
    /** 压缩阈值实时值（volatile thunk / 裸值两态兼容；0 或缺省 = 关）。 */
    private get compactionThreshold();
    /**
     * §A 有效上下文窗：`min(声明窗, observedCap)`；任一未知则取已知的那个。
     * 只有当 400 报文报出真实上限（observedCap）时才会 < 声明窗，进而修死锁；
     * observedCap 未知 ⇒ 等于声明窗（默认行为字节不变）。
     */
    private effectiveWindowFor;
    /** §A budget.ts 钩子：本会话已学到的 observedCap（未学到 ⇒ undefined，budget 不封顶）。 */
    observedContextWindow(session: Session): number | undefined;
    /**
     * Issue4（2026-11-17，design-2.1.0-batch §2）：B-6 盲区风险摘要——**只读、近似诊断**。
     * 触发 = 不可剪 live 估算 ≥ windowRatio × 声明窗：可剪面全剪光后仍会逼近声明窗，
     * 宿主组装层将无痕截断最旧 live 节点（README 已知限制 B-6，根治在 dsh 侧）。
     * 近似口径（台账 §6-R4 裁定的落点）：不可剪 = 非 R 原子（U/A/X/system 可见面）
     * + 未闭合轮 R；焦点/sticky/召回对等硬保护位**未计**（方向=低估不可剪量=漏报风险，
     * 卡面文案带「近似」）。**禁走 `FactorEngine.decide`**——其 observe() 有
     * ledger/观察游标/快照采样副作用（factor/engine.ts:459-496），卡面渲染不得污染压缩状态。
     */
    b6RiskSummary(session: Session): {
        declaredWindow: number;
        nonPrunableTokens: number;
        ratioPct: number;
        warn: boolean;
    };
    /**
     * live surface 样本混合密度（Issue5）：token→chars 反向换算（deficit→chars、
     * /argp 卡面历史字符数换算）共用口径。非 CJK-only 样本精确回 charsPerToken
     * （等价锁，见 budget.liveBlendCharsPerToken）。
     */
    liveCharsPerToken(session: Session): number;
    private egressGate;
    /** §9.37 出口闸·输出预算档③：模型注册面的缺省输出预算（每会话探一次，0=已探无）。 */
    private modelDefaultMaxTokens;
    /**
     * 宿主原生 tool-result-pruner 二次收紧（2026-11-13 引入，2026-11-14 裁定改为组剪之后）。
     *
     * 与 factor 组剪**同一笔** `compactIfNeeded` 动作：先按 alpha2 口径把 A+R 协议组
     * 整组归零（目标 = 真实缺口），再对剩余 surface 上所有 > thresholdChars 的
     * `tool/result` 切成 head/middle/tail（0-LLM、确定性、原文恒留 append-only 日志）——
     * 后者专打组剪动不了的部分（焦点/open 轮 read、A 仍存活的 R）。
     * pruner 的 `compaction/prune` 事件落在我们的 `compaction/end` 之后，因此
     * `rebuildLedgerFromLog` 不会把它并进组剪事务账；`shadowedSeqsOf` 照常计入。
     *
     * 约束：宿主只允许 open turn 内做 `tool/result` replace（durable turn work）；
     * 轮间 manual compact 无 open turn ⇒ 跳过。服务缺失/异常 ⇒ no-op，不阻断组剪。
     */
    private nativePruneToolResults;
    compactIfNeeded(agent: CompactionAgentContext, trigger: CompactionTrigger, signal: AbortSignal, 
    /** 本步已 claim 未落盘的 user 消息估值（轮初专用；其余调用点省略）。 */
    incomingTokens?: number): Promise<CompactionResult | null>;
    /**
     * §B-2b 接管事务（ARGP_FACTOR_DISPATCH=2）：按分派形态发射，双闸主权在判据表。
     * 公共前缀：结构去重（宿主再注入旧副本回收，0-LLM）。形态语义：
     *  - prune-only → 组剪 + native 收紧，**不调**浓缩链；
     *  - summarize-then-prune → 先浓缩（dispatchApproved + 分派器输出预算）→ **复测**，
     *    仍有 deficit 才补组剪（§B 定稿：复测判据，不凭决策时的旧 deficit）；
     *  - summarize-only → 只浓缩；
     *  - terminal-b6 → 会话级连续计数：≥3 轮不空转（去重 + 上报，不再组剪），
     *    否则降级求生组剪（能减一点是一点）；
     *  - none → 如实上报（below-retain 不该进到这里 / stop+report）。
     * note 刷新沿用现不变量：有真事务才刷（空转不动 surface）。
     */
    private compactByDispatch;
    compactNow(agent: ManualCompactAgentContext, signal: AbortSignal, sourceCommandId?: CommandId): Promise<CompactionResult | null>;
    compactRegion(_start: number, _end: number, _agent: CompactionAgentContext, _signal?: AbortSignal): Promise<CompactionResult>;
    /**
     * 注册动态词表目录（宿主 `systemPrompt.context`）。
     *
     * 关键时序（2026-11-27 宿主源码核对）：`agent/pre-step` 的 system prompt
     * **在本钩子之前**已 assemble；但 `step()` 在发请求前会再调用
     * `systemPrompt.refreshContext()`，context provider 会重新求值。因此：
     *  - `systemPrompt.section` 在这里更新只会下一次请求可见，并可能额外打穿前缀缓存；
     *  - `systemPrompt.context` 可在本次压缩请求的 refreshContext 中看到事务收尾快照。
     *
     * 服务缺失（旧宿主/测试最小组合）时不注册，保留 refreshFactorNoteSafe 的
     * note 降级路径；注册成功后 note 不再承担目录，避免双份目录。
     */
    private registerVocabularyContext;
    /**
     * 读取 systemPrompt.context 的会话快照。首次访问时从当前账本拍一次快照
     * （冷 resume/测试直挂场景）；之后只读快照，不在 provider 内重复 observe。
     */
    private vocabularyContextText;
    /** 事务成功收尾：冻结本会话的目录快照；失败/空事务不得调用。 */
    private refreshVocabularySnapshot;
    /**
     * 记录一次成功的压缩事务收尾（`compaction/end` 无 error）。
     *
     * 只有成功收尾才置游标：失败/中断的 end 带 `error`，其后的请求并没有经历
     * "历史被改写"这件事，算成压缩后重灌会把失败压缩的代价记到成功账上。
     */
    private noteCompactionEnd;
    /**
     * 每请求缓存采样（2.2.3，见 cache-audit.ts）。
     *
     * 观测点选在 `assistant/message` 的 usage 上：`cacheReadTokens` 与 `inputTokens`
     * 互斥，前者=复用前缀、后者=必须真 prefill。压缩改动早期上下文后，保留段在
     * 首请求里必然 miss 一次；**同一次压缩后的续作仍低命中**才是异常（另有抖前缀源）。
     *
     * 「首请求」用事务游标判定而不是时间窗：`compaction/end` 无 error 置位，
     * 下一条带 usage 的应答消费之。若事务后跨了轮次才有应答（请求被中止/报错，
     * 根本没发出去），视为陈旧标记——不把它算作「压缩后首请求」，否则正常冷启会被
     * 误报成重灌。
     */
    private recordCacheSample;
    /**
     * 词表 note 迁入压缩事务收尾（P6-② 违规点整改，note 前缀炸弹案施工①）：note 变化时机
     * = 压缩时机——"缓存断点频率=压缩频率"不变量的 note 特化（T-3 定量证实每步一改一炸）。
     *
     * 2.2.3 起有 `systemPrompt.context` 时**不再写 note 目录**：目录由 context 快照承担；
     * note 仅作为无 systemPrompt 服务的降级路径（测试最小宿主/旧宿主）。
     *
     * steer 仅首注需要（更新走单节点 replace，指针以标记回溯为准）；本入口拿不到 steer
     * （CompactionAgentContext 无该成员）时首注跳过——下个有 steer 的压缩机会自然重试。
     */
    private refreshFactorNoteSafe;
    /**
     * factor 臂轮内维护（**仅 ARGP_FACTOR_PRESSURE=1 逃生口**，P6-④ 前旧世界复现）：
     * 先词表 note（旧时机 = 每 pre-step），后压力剪（估算驱动）。缺省路径（收敛后）不进本函数
     * ——note 已迁压缩事务收尾（refreshFactorNoteSafe）。
     */
    private factorPressure;
    /**
     * A7 事务账目重建：resume 时从 append-only 日志扫描 compaction/start、compaction/prune、
     * compaction/end 事件重建 records/prunedNodeIndex/shadowedSeqsOf 状态；无 end 的 start 记 warn。
     * 不引入 WAL——日志本身即账目。幂等：已重建过的 compactionId 跳过（rebuiltCompactionIds 去重），
     * 使「setSession 自动重建」与「测试显式清空 records 后再重建」两种路径都安全。
     * §8-11 后活体事务已由 prune-tx 成功收尾入账 prunedNodeIndex；同进程重放撞进的 seq 由
     * notePrunedNode 的 seq 幂等吞掉，不双计。
     */
    rebuildLedgerFromLog(): void;
}
export default ArgpEngine;
