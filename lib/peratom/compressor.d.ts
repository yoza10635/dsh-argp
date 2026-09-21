import type { Context } from '@deepseek-ai/cordis';
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';
import type { DshLlmSpec } from './llm-adapter.js';
import type { GateToolResult, GateUserLong, NeedCompress } from './gate.js';
export interface PeratomCompressorConfig {
    /** OpenAI 兼容 chat/completions 端点全 URL。缺省按环境变量解析（见 defaultEndpoint）。 */
    endpoint?: string;
    apiKey?: string;
    model?: string;
    /**
     * dsh-llm 生产后端（P5 后债务清算）：经宿主 LlmRuntime 调用，优先于 endpoint/apiKey
     * （fetch 遗产路径）。多模型分工：与 declarer 各自指定 provider/model（lite 档可选）。
     */
    llm?: DshLlmSpec;
    /** 用户长消息阈值（默认 SPLIT_THRESHOLD_CHARS=100）。 */
    splitThresholdChars?: number;
    /** 工具结果小结果阈值（默认 DEFAULT_SMALL_RESULT_CHARS=512）。 */
    smallResultChars?: number;
    /** 单次请求超时（默认 180s，spike 32 同款）。 */
    timeoutMs?: number;
    /**
     * 追加到请求体的模板参数**基础层**（如本地 llama.cpp + Qwen3 的 `{ enable_thinking: false }`）。
     * A 形态（带前缀）下，`resolveEffectiveCtk` 会以**最近一次真实 agent 请求的
     * `chat_template_kwargs` 为基础**再叠加本基础层 + `enable_thinking:false` 覆盖
     * （2026-09-19 定案：同态渲染 = 继承主链 ctk；强制 pt:true 反而把跨轮 reasoning
     * 渲染回来，LCP 12.7% < pt:false 30.3%）。C 形态（无前缀）直接用本基础层。
     * 实测（spike 33）：不关思考则 token 预算全烧在推理上、content 为空。
     */
    chatTemplateKwargs?: Record<string, unknown>;
    /**
     * 压缩调用输出 cap（token，默认 16384）。plan 的 quotes 部分 = dialog 保真保留
     * （用户指令逐字转写，尺寸与原子原文同量级，不可省）⇒ cap 必须容纳"dialog +
     * tools plan"而不是"几百 token"——cap 截断 = JSON 不完整 = parse 失败 = 整轮
     * 保原文（2026-09-20 r3 实弹：3-turn 语料 T1 任务书全指令型 user 即打满 4096）。
     * 防爆余量按新窗口重标定：触发线 100,007 + agent maxTokens 32,768 + cap 16,384
     * ≈ 149K ≪ 262,144 墙（旧 174K 墙时代 4096 的"让 margin"推导已过时；KV 池
     * 933K 下 16K 响应的 prefill 搅动也可忽略）。
     */
    maxCompletionTokens?: number;
    /**
     * A 形态前缀预算（token，默认 132000 ≈ 0.76×174080 墙）：前缀快照估算
     * `prompt_tokens` 超预算时**该次降级 C 形态**（丢前缀、只发指令）——防爆上限的
     * 核心防线（"全前缀或无前缀"二元门控，截断前缀要么质量最伤要么比 C 还贵）。
     * 估算源 = 最近一次真实 agent 请求的 usage.prompt_tokens（同源，误差 < 1K）。
     */
    prefixBudgetTokens?: number;
    /**
     * 初始 tool 对照表（设计 §6-2）：工具种类名 → 压缩档位。运行期可经
     * `setToolPolicy(toolName, policy)` 增改；构造期传入便于单测 / 声明式挂载预置。
     */
    toolPolicies?: ReadonlyMap<string, NeedCompress>;
    /**
     * HLS 修复档（PROPOSAL-token-ontology 组件 B，v1.2.0；默认 'trailer'）：
     * extract 被保真守卫拒收（缺高信号 token）时不再整条丢弃（收益全损），
     * 改为守卫机械补全——候选文本 + 缺失 token 按原文顺序尾注（`[restored]`），
     * 硬 token 保真由构造（100%），prose 损失受控（等同 summary 档），
     * 缺失清单入 `restoredByGuard` 台账（与 summaryDropped 同级可审）。
     * 'off' = v1.1 行为（拒收即原文保面）。
     */
    hlsMode?: 'trailer' | 'off';
    /**
     * HLS 经济学门槛 θ（默认 1，见 token-ontology `DEFAULT_HLS_ROI_THRESHOLD`）：
     * 仅当 ROI = 净释放预算 / 尾注占用 ≥ θ 才修复，否则退回原文保面。
     * 修复后比原文还长（ROI < 0）在任何 θ ≥ 0 下都被拒——这是代价盲的修正。
     */
    hlsRoiThreshold?: number;
    /** fetch 注入点（测试替身；生产缺省 globalThis.fetch）。 */
    fetchImpl?: typeof fetch;
}
interface ResolvedEndpoint {
    endpoint: string;
    model: string;
    apiKey: string;
}
/**
 * 缺省端点解析：ARGP_MODEL_SOURCE=qwen-local → QWEN_BASE/QWEN_MODEL（本地推理）；
 * 否则 DeepSeek 生产端点 + DEEPSEEK_API_KEY。apiKey 缺失 → disabled（静默跳过，
 * 开发/离线环境零网络副作用）。
 */
export declare function defaultEndpoint(env?: NodeJS.ProcessEnv): ResolvedEndpoint | null;
export interface UserSplit {
    seq: number;
    quotes: string[];
    /**
     * 资料（info）压缩档位（设计 §10 决策 1 补实现）：`false`=原样 / `summary`=概括 /
     * `extract`=逐字摘取。用户源 info 默认偏好 summary（设计 L54：叙述类资料保意图）；
     * shell 报错/含精确串 → extract。缺省（undefined）= 不压缩（引擎回退原文切片）。
     */
    infoLevel?: 'false' | 'summary' | 'extract';
    /**
     * 压缩后的 info 文本：summary/extract 时必填；false 或缺省时留空/缺省（引擎回退逐字切片）。
     * 单档（§10 决策 7"只有两种形态"）：surface 放此文本、`data[ARG_NS].summary` 存同文本。
     */
    infoText?: string;
}
export interface ToolAction {
    seq: number;
    /**
     * 工具结果压缩档位（设计对称：与 info 同级显式信号）。`false`=全是关键内容、
     * 无可压空间（典型如完整源码模块）→ 原子保原文、不 emit replace；`text` 此时可空。
     */
    level: 'extract' | 'summary' | 'false';
    text: string;
}
/** 单次压缩调用的输出形状（覆盖当轮全部可压原子）。 */
export interface CompressDecision {
    splits: UserSplit[];
    tools: ToolAction[];
}
/** 模型输出 → CompressDecision（信任边界：seq/quotes/level/text 全字段校验，异形丢弃）。 */
export declare function normalizeDecision(cand: unknown): CompressDecision | null;
/** collectCurrentTurn 产物：当轮可压原子（已内嵌中断过滤 + 版本链硬排除 + 门控筛选）。 */
export interface CurrentTurnCollect {
    turn: number;
    /** 当轮事件 seq 区间（含 step 标记等非 surface 事件）；sourceEventSeqs ⊆ 区间断言的界。 */
    startSeq: number;
    endSeq: number;
    /** 当轮命中中断标记：两个数组恒空，调用门控必然 false（零 LLM 调用）。 */
    interrupted: boolean;
    userLong: GateUserLong[];
    toolResults: GateToolResult[];
}
/** 一次压缩尝试的观测记录（测试断言直接读这里）。 */
export interface CompressRecord {
    at: string;
    turn: number | null;
    called: boolean;
    ms?: number;
    parseFailed?: boolean;
    appliedReplaces?: number;
    skippedFallbackDialog?: number;
    /** 保真守卫拒绝的 tool 副本数（缺高信号 token → 原文保面，spike 34 驱动）。 */
    skippedFidelity?: number;
    /** 模型显式选 false（不压）的 tool 原子数（设计对称：与 info 同级显式信号）。 */
    skippedFalse?: number;
    /** no-op 守卫拒的 tool 副本数（收益 ≤5% 视同 false；spike 37 全文照抄实锤驱动）。 */
    skippedNoopGain?: number;
    /** 被保真守卫拒的副本中缺失的高信号 token 汇总（诊断白压根因）。 */
    fidelityMissing?: string[];
    /**
     * summary 副本的守卫审计清单（level-aware 放行，spike36 复盘驱动）：
     * 模型自选 summary 时守卫不做硬拒，但原文中被概括丢掉的高信号 token
     * 逐条入账，供 LLM 审核 / 人工审核事后评判。空数组/缺省 = 无丢失。
     */
    summaryDropped?: string[];
    /**
     * HLS 修复档计数（v1.2.0 组件 B）：extract 副本被拒后经守卫尾注补全落地的数量。
     * 与 skippedFidelity 互斥语义：前者 = 保真由构造地落地，后者 = 保守回退原文。
     */
    hlsRepairs?: number;
    /**
     * HLS 审计台账（与 summaryDropped 同级可审）：守卫从原文补进尾注的高信号 token。
     * 空数组/缺省 = 无修复发生。spike39 用其度量"拒收挽回率"。
     */
    restoredByGuard?: string[];
    /**
     * HLS 经济学门控拒收数（v1.2.0 门控修正）：缺 token 但 ROI < θ → 退回原文保面。
     * 空/缺省 = 无门控拦截。用于观测「代价盲区间」（修复越修越长）在真实语料的频率。
     */
    hlsRoiSkipped?: number;
    /** 当轮原子 seq 快照（prompt 里给出的值；调试 seq 信任边界用）。 */
    atomSeqs?: {
        userLong: number[];
        toolResults: number[];
    };
    /** 模型原始 decision（解析成功时留痕；调试服从率用）。 */
    decision?: CompressDecision;
    /** A 形态降级 C 的原因（'prefix-budget' = 前缀超预算丢前缀只发指令；防爆上限门控留痕）。 */
    degradedToC?: string;
    /** 模型原始响应文本（无论解析成败都留痕；调试 parseFailed 根因用）。 */
    rawResponse?: string;
    /** dsh-llm 后端的 usage 记账（fetch 后端经 meteringFetch 在 spike 侧独立计量）。 */
    usage?: {
        promptTokens: number;
        completionTokens: number;
    };
    anomalies?: number;
    error?: string;
    /**
     * called=false 时的短路原因（观测"合法跳过"用，review 严重发现 #2）：
     * - 'no-candidate'：门控判无可压原子（纯 dialog / 全部原子 < 小结果阈值或版本链成员）；
     * - 'interrupted'：轮次被中断（error/aborted 收尾，半成品原子被 filterInterruptedAtoms 清空，
     *   与"门控判无可压"是两种性质——前者是环境/模型失败，后者是正常判决。19:50 复跑里
     *   LLM 连接失败的轮次曾误显示为 no-candidate，VK-plan-c 无法区分，故拆出）；
     * - 缺省（undefined）表示 called=true 的正常调用。
     */
    skipReason?: 'no-candidate' | 'interrupted';
}
interface PlannedStep {
    kind: 'replace' | 'append';
    type: 'user/message' | 'tool/result';
    /** replace 的目标 seq（append 时无意义）。 */
    at: number;
    data: unknown;
    sourceEventSeqs: number[];
}
interface PlanResult {
    steps: PlannedStep[];
    replaces: number;
    skippedFallbackDialog: number;
    skippedFidelity: number;
    /** 模型显式选 false（不压）的 tool 原子数（设计对称：与 info 同级显式信号）。 */
    skippedFalse: number;
    /** no-op 守卫拒的 tool 副本数（收益 ≤5% 视同 false；spike 37 全文照抄实锤驱动）。 */
    skippedNoopGain: number;
    /** 被保真守卫拒的副本中，缺失的高信号 token 汇总（诊断"白压"根因用）。 */
    fidelityMissing: string[];
    /** summary 副本审计：被概括丢弃的高信号 token（放行但入账，供审核）。 */
    summaryDropped: string[];
    /** HLS 修复档（v1.2.0 组件 B）：extract 被拒后经守卫尾注补全落地的副本数。 */
    hlsRepairs: number;
    /** HLS 审计台账：守卫补进尾注的高信号 token（与 summaryDropped 同级可审，spike39 消费）。 */
    restoredByGuard: string[];
    /**
     * HLS 经济学门控拒收数（v1.2.0 门控修正）：候选虽缺 token 但 ROI = 净释放/尾注 < θ
     * （尾注不划算，修复后接近/超过原文长度）→ 退回原文保面。与 skippedFidelity 同向
     * （原子保原文），单列以便度量「代价盲区间」（spike39 的 F1/F4 形态）的出现频率。
     */
    hlsRoiSkipped: number;
    anomalies: number;
}
/**
 * planReplacements 选项（v1.2.0）：`hlsMode` 对独立调用方缺省 'off'（保守默认，
 * 既有行为不变）；PeratomCompressor 类显式传自身配置（生产缺省 'trailer'）。
 */
export interface PlanOptions {
    hlsMode?: 'trailer' | 'off';
    /** HLS 经济学门槛 θ（缺省 1）；仅 trailer 档生效。 */
    hlsRoiThreshold?: number;
}
/**
 * 引擎侧规划：模型输出过信任边界（seq 必须命中本轮收集集，先到先得去重），
 * 用户消息过 resolveSplit 全套保守策略（定位失败回退 dialog / 覆盖率翻转 / 空隙归 info）。
 * 返回落盘步骤序列；steps 为空 = 本轮无可落地动作（不开发务括号）。
 */
export declare function planReplacements(collect: CurrentTurnCollect, decision: CompressDecision, events: readonly SessionEvent[], opts?: PlanOptions): PlanResult;
export declare class PeratomCompressor {
    static inject: readonly [];
    readonly splitThresholdChars: number;
    readonly smallResultChars: number;
    readonly timeoutMs: number;
    /** HLS 修复档（v1.2.0 组件 B；生产缺省 'trailer'，'off' = v1.1 硬拒行为）。 */
    readonly hlsMode: 'trailer' | 'off';
    /** HLS 经济学门槛 θ（v1.2.0 门控修正；缺省 1）。 */
    readonly hlsRoiThreshold: number;
    /** 压缩调用输出 cap（默认 4096；JSON plan 输出通常几百 token，小 cap 给 prompt 让出 margin）。 */
    readonly maxCompletionTokens: number;
    /** A 形态前缀预算（默认 132000 ≈ 0.76×174080；前缀超预算 ⇒ 该次降级 C 形态）。 */
    readonly prefixBudgetTokens: number;
    private readonly chatTemplateKwargs;
    private readonly endpoint;
    private readonly dshLlm;
    /**
     * 自动兜底候选（§11.13.1）：显式 `config.llm` 与 fetch（endpoint/apiKey/env）两路
     * 都缺省时置 true，后端改为在真会话里延迟解析（agent 路由 + 宿主 ctx.llm）。
     */
    private readonly llmAutoEligible;
    /** 延迟解析出的后端（来自 agent 路由；构造期拿不到路由，故后置填充）。 */
    private autoLlm;
    private readonly fetchImpl;
    private readonly ctx;
    /** LLM 压缩调用计数器（纯 dialog 轮零调用的断言读这里）。 */
    private _calls;
    get calls(): number;
    /** 全部压缩尝试记录（时间序）。 */
    readonly records: CompressRecord[];
    /** 当前暂存待发射的事务数（测试/P4 判断 stash 是否就绪）。 */
    get pendingCount(): number;
    /**
     * 每轮压缩**水位**：(session, turn) → 已被规划过的最大 seq（-1 = 未压过）。
     *
     * 语义（2026-09-21 修订，替代原 `doneTurns` 的"轮级一次性"）：
     *  - **成功的 pass** 把该轮水位推进到本次窗口的 `endSeq`（= 规划器已考虑过的边界）；
     *  - 后续 pass（轮末 idle 或再次压力）**只收 `seq > 水位` 的原子** ⇒ 轮内压力 pass
     *    不再吃掉轮末 idle pass，同一轮可增量再压。真环境 2026-09-21 实证：turn 6 的
     *    轮内 pass（step 85）用掉唯一配额后，step 85-92 的新增内容永不入压。
     *  - 门控短路（`no-candidate`）/ 中断轮**不推进水位** ⇒ 该轮仍可被后续 pass 处理
     *    （原实现把 `done.add` 放在门控**之前**，一次 no-candidate 即永久作废该轮）。
     *  - 天然幂等：同一轮无新增原子时窗口为空 ⇒ collect 返回 null ⇒ 零 LLM 调用。
     *  - 未推进水位的重复调用只做一次日志扫描（无网络、无事务），代价可忽略。
     */
    private readonly passWatermark;
    /** idle 阶段产出、等待下一次 open-turn 窗口发射的事务。 */
    private readonly pending;
    /**
     * tool 对照表 / 作者声明（设计 §6-2）：工具种类名 → 压缩档位。
     * 未声明的工具缺席默认（走大小启发式）；声明只放宽/收紧启发式，不可越过版本链硬排除。
     */
    private readonly toolPolicies;
    /** tool 对照表查询（测试 / P4 接线断言用）。 */
    getToolPolicy(toolName: string): NeedCompress | undefined;
    /**
     * 声明某工具种类的压缩档位（设计 §6-2 `setToolPolicy(toolName, policy)`）。
     * `false`=永不压缩（保原文）；'summary'=一句话概括；'extract'=关键内容摘录。
     * 传 `undefined` 撤销声明（回启发式默认）。声明是"提示非命令"：
     * 版本链硬排除（决策序第 1 层）与保真守卫仍先行，错误方向只往"少压"错。
     */
    setToolPolicy(toolName: string, policy: NeedCompress | undefined): void;
    /** 门控选项快照：大小阈值 + tool 对照表（prepare / compressCurrentTurn 两处同口径）。 */
    private gateOptions;
    /** 某轮已规划过的最大 seq（-1 = 未压过）。 */
    private waterMarkOf;
    /** 成功落地后推进水位（单调不回退）。 */
    private advanceWaterMark;
    /** 测试 / 诊断入口：读某轮的压缩水位。 */
    turnWaterMark(session: Session, turn: number): number;
    /**
     * 该事件是否为**可压缩的原始材料**（唯一判据，三处共用）。
     *
     * 两类事件不是材料，必须同时从「候选」与「窗口边界（startSeq/endSeq）」里排除：
     *  - **压缩产物**：`surfaceOp` 存在且非 `'append'`（本压缩器 / 图剪写回的替换副本）。
     *    它是上一次 pass 的结果；水位语义下同一轮会被多次 collect，放进去会让
     *    窗口恒非空（每次 pass 都以 no-candidate 重复记账），且副本的
     *    `message.source.kind` 仍是 `'tool'`，plugin-source 判据拦不住 ⇒ 有二次摘要风险。
     *  - **插件注入**：`user/message` 且 `source.kind === 'plugin'`（A 形态前缀指令、
     *    U-info 聚合副本、checkpoint）。这类事件由引擎/本压缩器自己写入，不是会话材料；
     *    边界若把它们算进去，纯注入窗口会返回"空候选的非 null 收集"（同上噪声问题）。
     *
     * 判据口径与 `argp-t1-engine.shadowedSeqs` 的 replace 判定一致。
     */
    private isMaterial;
    constructor(ctx: Context, config?: PeratomCompressorConfig);
    /**
     * 记住 agent 路由（§11.13.1 自动兜底）。构造期拿不到路由，只能在真会话的
     * `agent/status` / `agent/pre-step` 钩子里现取。非自动模式直接短路。
     */
    private rememberRoute;
    /**
     * 后端选路（§11.13.1）：显式 `config.llm` > fetch（endpoint/apiKey/env）> 自动兜底。
     * 三条都解不出返回 null —— 调用方按 disabled 记账（`no-endpoint`），不抛错、不阻断会话。
     */
    private backend;
    /**
     * 收集当前（最新闭合）轮的可压原子。内嵌三道确定性过滤：
     * ① 中断轮整轮排除（filterInterruptedAtoms，interrupted=true 时数组恒空）；
     * ② 版本链成员硬排除（决策④，need_compress=false）；③ 大小启发式门控。
     * 无再压缩路径：U-info 副本 / plugin checkpoint 一律跳过（决策⑦）。
     */
    collectCurrentTurn(session: Session, afterSeq?: number): CurrentTurnCollect | null;
    /**
     * 收集当前开放轮（最后一条 turn/start 之后、尚无 turn/end）的可压原子。
     * P4 溢出三步路径②专用：溢出发生在 open turn 的请求上，第②步要降熵的正是
     * 这个 open turn——closed-turn 口径会错压上一闭合轮（2026-08-29 review 中项，
     * 与 per-atom 设计 §8「对当前轮大原子降熵」的意图不符）。过滤与闭合轮完全
     * 同款（中断/版本链/大小门控；U-info/checkpoint 跳过）；open turn 无 turn/end，
     * 不会出现在中断集里。无 turn/start（会话头）返回 null。
     */
    collectOpenTurn(session: Session, afterSeq?: number): CurrentTurnCollect | null;
    /** 窗口→候选的共享尾部（中断/版本链/大小门控 + 原子化）。closed/open 两口径共用。 */
    private collectFromWindow;
    /** idle 触发段：记账防重 → 收集 → 门控 → LLM → 暂存待发射。返回观测记录。 */
    prepareCurrentTurn(session: Session): Promise<CompressRecord | null>;
    /** 发射段：把该 session 的全部就绪事务落入下一次 open-turn 窗口（同步追加，吞错记账）。 */
    flushStashed(session: Session): void;
    /** 公开入口（P4 溢出三步路径② / 单测）：立即收集+调用+发射，绕过两段式延迟。 */
    compressCurrentTurn(session: Session): Promise<CompressRecord | null>;
    /**
     * 公开入口（P4 溢出三步路径② 生产接线）：对当前 open turn 立即收集+调用+发射。
     * 溢出发生在 open turn 的请求上，第②步必须压它而不是最新闭合轮（设计 §8
     * 「对当前轮大原子降熵」；closed 口径会错压上一轮，2026-08-29 review 中项）。
     * 水位语义（2026-09-21 修订）：open turn 压缩后**只推进该轮水位**（= 本次窗口 endSeq），
     * 该轮闭合时 idle prepare 仍会跑，但只收水位之后的新增原子（原先的"轮级一次性"
     * 记账会让轮内 pass 吃掉轮末 pass，使该轮尾部永不入压）。
     */
    compressOpenTurn(session: Session): Promise<CompressRecord | null>;
    /** 共享压缩尾部：中断/无候选短路（不推进水位）+ callAndStash + 立即 flush（成功才推进水位）。 */
    private compressCollect;
    /**
     * A 形态前缀快照（设计文档 §4 tail-only 语义的落地）：agent 当前
     * `deriveMessages()` + `requestHeader().tools` + 主链 ctk。
     *
     * 时序依据（2026-09-18/19 record 实测）：
     * - 轮边界触发（idle）：derive = 刚结束轮的全量，复用对象 = P_last / 下一轮第一发；
     * - 轮内触发（pre-step，P6）：derive = 进行到一半的 turn N，复用对象 = 紧随其后的
     *   step k+1 请求。两条路径共用本快照函数，前缀 = 触发时刻的 deriveMessages()。
     * 无 header 事件（会话首请求前）时 tools 缺省，消息前缀仍可用。
     */
    private buildContextPrefix;
    /**
     * 方案 B ctk（2026-09-19 定案，替代旧的"强制 pt:true"）：
     *   { enable_thinking:false, preserve_thinking:false, reasoning_effort:<主链同值?>, ...config 基础层 }
     * 三字段各自的理由：
     *  - `preserve_thinking:false`（方案 B 核心）：压缩请求末尾必是 user 指令 ⇒ 模板把
     *    last_query_index 推到末尾 ⇒ 历史轮内 reasoning 被剥 = **剥离态**。这恰好与
     *    "下一轮第一发 agent 请求"（末尾也是 user，同为剥离态）**同态** ⇒ 前缀逐 token
     *    一致（plan B 实测 LCP 99.4%）。强制 pt:true 反而把跨轮 reasoning 渲染回来，
     *    与参照不同态（LCP 12.7% < pt:false 30.3%）。
     *  - `enable_thinking:false`：压缩响应是 JSON plan，不烧 thinking（spike 33）。
     *  - `reasoning_effort`：与主链对齐（若声明了）——匹配主链的渲染 token 序列，
     *    跨模型可移植（不依赖 Qwen3 专属 pt 语义）。
     * 主链 reasoningEffort 取自最近 `request/header` 事件的 config（LlmCallConfig 无
     * chat_template_kwargs 字段，只有 reasoningEffort——故从它重建，非读现成 ctk）。
     */
    private resolveEffectiveCtk;
    /**
     * 前缀预算门控（防爆上限核心防线）：估算 A 形态请求的 prompt_tokens
     * = 最近一次真实 agent 请求的 billed input + 指令字符估算（/4，chars/4 对
     * 指令这种短文本偏安全）。usage 挂 assistant/message 事件的 data **顶层**
     * （agent-loop 落账实证 `{turn, step, message, usage, stream}`，读
     * `data.message.usage` 恒 undefined ⇒ A 形态会被静默全量降级 C）；billed
     * 口径 = inputTokens（未命中）+ cacheReadTokens + cacheWriteTokens，与引擎
     * 真实锚点同式——只算未命中会在高缓存命中率时大幅低估、漏放行超预算请求。
     * 超预算 ⇒ 返回 false，调用方**该次降级 C 形态**（丢前缀只发指令）——
     * "全前缀或无前缀"二元门控：截断前缀要么砍最近历史（质量最伤）要么 0 命中
     * 还比 C 贵（被支配）。无 usage 可参照（会话头）⇒ 保守返回 false（降级 C）。
     */
    private prefixWithinBudget;
    private callAndStash;
    private flushEntry;
}
export default PeratomCompressor;
