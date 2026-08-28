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
     * 追加到请求体的模板参数（如本地 llama.cpp + Qwen3 的 `{ enable_thinking: false }`）。
     * 实测（spike 33）：llama.cpp 上 json_schema 强制输出与思考模式互斥——不关思考则
     * token 预算全烧在推理上、content 为空。官方端点会忽略未知字段，默认不发送。
     */
    chatTemplateKwargs?: Record<string, unknown>;
    /**
     * 初始 tool 对照表（设计 §6-2）：工具种类名 → 压缩档位。运行期可经
     * `setToolPolicy(toolName, policy)` 增改；构造期传入便于单测 / 声明式挂载预置。
     */
    toolPolicies?: ReadonlyMap<string, NeedCompress>;
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
    /** 当轮原子 seq 快照（prompt 里给出的值；调试 seq 信任边界用）。 */
    atomSeqs?: {
        userLong: number[];
        toolResults: number[];
    };
    /** 模型原始 decision（解析成功时留痕；调试服从率用）。 */
    decision?: CompressDecision;
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
    anomalies: number;
}
/**
 * 引擎侧规划：模型输出过信任边界（seq 必须命中本轮收集集，先到先得去重），
 * 用户消息过 resolveSplit 全套保守策略（定位失败回退 dialog / 覆盖率翻转 / 空隙归 info）。
 * 返回落盘步骤序列；steps 为空 = 本轮无可落地动作（不开发务括号）。
 */
export declare function planReplacements(collect: CurrentTurnCollect, decision: CompressDecision, events: readonly SessionEvent[]): PlanResult;
export declare class PeratomCompressor {
    static inject: readonly [];
    readonly splitThresholdChars: number;
    readonly smallResultChars: number;
    readonly timeoutMs: number;
    private readonly chatTemplateKwargs;
    private readonly endpoint;
    private readonly dshLlm;
    private readonly fetchImpl;
    private readonly ctx;
    /** LLM 压缩调用计数器（纯 dialog 轮零调用的断言读这里）。 */
    private _calls;
    get calls(): number;
    /** 全部压缩尝试记录（时间序）。 */
    readonly records: CompressRecord[];
    /** 当前暂存待发射的事务数（测试/P4 判断 stash 是否就绪）。 */
    get pendingCount(): number;
    /** 防重复 turn 处理：(session, turn) 记账于 prepare 阶段。 */
    private readonly doneTurns;
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
    constructor(ctx: Context, config?: PeratomCompressorConfig);
    /**
     * 收集当前（最新闭合）轮的可压原子。内嵌三道确定性过滤：
     * ① 中断轮整轮排除（filterInterruptedAtoms，interrupted=true 时数组恒空）；
     * ② 版本链成员硬排除（决策④，need_compress=false）；③ 大小启发式门控。
     * 无再压缩路径：U-info 副本 / plugin checkpoint 一律跳过（决策⑦）。
     */
    collectCurrentTurn(session: Session): CurrentTurnCollect | null;
    /** idle 触发段：记账防重 → 收集 → 门控 → LLM → 暂存待发射。返回观测记录。 */
    prepareCurrentTurn(session: Session): Promise<CompressRecord | null>;
    /** 发射段：把该 session 的全部就绪事务落入下一次 open-turn 窗口（同步追加，吞错记账）。 */
    flushStashed(session: Session): void;
    /** 公开入口（P4 溢出三步路径② / 单测）：立即收集+调用+发射，绕过两段式延迟。 */
    compressCurrentTurn(session: Session): Promise<CompressRecord | null>;
    private callAndStash;
    private flushEntry;
}
export default PeratomCompressor;
