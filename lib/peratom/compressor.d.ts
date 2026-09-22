/**
 * PeratomCompressor（Stage-1，plan P1）：eager 轮末熵降管线。
 *
 * 宿主身份（plan §0）：**普通 cordis 服务，非 ctx.compaction 服务位**——Stage-2 的
 * ArgpGraphEngine 独占 compaction 位，本服务走事件钩子，失败隔离免费获得。
 *
 * 触发与发射的两段式设计（对齐 dsh-session 不变量）：
 *  - `agent/status: idle` 钩子触发（spike 06 idle 判定口径）：此刻当轮已闭
 *    （agent-loop kick() 在 turn/end 之后的 finally 才 setPhase idle）。收集当轮原子 +
 *    发起 LLM 调用（网络等待在轮外，不阻塞任何 waterfall），结果暂存 pending 队列。
 *  - 事务发射推迟到下一次 `agent/pre-step`（新轮已开、其 user/message 尚未入日志——
 *    loop 先跑 preStep 再落盘消息）。原因：dsh-session invariant 规定 tool/result 的
 *    surface replace 是"durable turn work"，只允许在 open turn 内追加；idle 时 openTurn=null。
 *    推迟发射不损缓存语义：前 N-1 轮前缀字节不变，替换发生在下一次请求组装之前。
 *  - **"轮外"只在调用先于下一条消息返回时成立**（2026-09-21 修）：若调用仍在飞而用户
 *    已发下一条消息，新轮首个 pre-step 无条目可发射 ⇒ 事务落到新轮**中途**（真环境实证：
 *    跨进程 resume 的 pass 晚 6 步落盘，前 6 步跑在未压缩上下文上 + 中途换 surface 断
 *    KV）。故 pre-step **有界等待**在飞 pass（`flushWaitMs`，默认 180s；超时告警后放行
 *    ——事务顺延到后续窗口，即旧行为），使"下一个 user message 等待"成为确定性语义。
 *  - 防重复处理：按 (session, turn) 记**压缩水位**（见 passWatermark）——已规划过的
 *    前缀不再入候选，重复 idle / pre-step 因窗口为空而幂等短路；成功 pass 之后
 *    同轮新增内容仍可再压（2026-09-21 起，替代原"轮级一次性"记账）。
 *  - `compressCurrentTurn(session)` 公开入口：立即收集+调用+发射（P4 溢出三步路径②与单测用），
 *    绕过两段式延迟。
 *
 * 单次调用覆盖当轮全部可压原子（user quotes 拆分 + tool extract/summary），OpenAI 兼容
 * fetch + JSON Schema 强制输出（复用 spike 30/32 模式；response_format 被端点拒绝时
 * 自动降级为裸 prompt + 防御性 JSON 提取——spike 32 extractJson 同款）。
 *
 * 无再压缩路径（决策⑦）：collect 只取"原始态"原子——已是 U-info/replace 副本的 seq 直接跳过；
 * 版本链成员硬排除（gate 决策序①）；被中断轮次整轮排除（filterInterruptedAtoms 内嵌）。
 *
 * P5 结构重构 Wave 3 第 5 步（C 报告 §4 B 表）：本文件瘦身为**组合根**——class 只持有
 * 字段 + 构造函数（注册钩子）+ 薄编排方法（转发到模块）。实现拆到 5 个模块，依赖方向
 * compressor-types（叶）← decision/collect/prompt ← flush ← compressor（组合根）：
 *  - compressor-types.ts：纯类型 + defaultEndpoint（叶子，不 import 任何 peratom 运行时）；
 *  - decision.ts：extractJson / normalizeDecision / planReplacements（纯函数）；
 *  - collect.ts：isMaterial / waterMarkOf / advanceWaterMark / collectFromWindow /
 *    collectCurrentTurn / collectOpenTurn（窄宿主接口 CollectHost）；
 *  - prompt.ts：PROMPT_RULES / buildPrompt / postChat / backend（窄宿主接口 PromptHost）；
 *  - flush.ts：buildContextPrefix / resolveEffectiveCtk / prefixWithinBudget / callAndStash /
 *    prepareCurrentTurn / compressCollect / flushStashed / flushEntry / awaitInFlightPass /
 *    rememberRoute（窄宿主接口 FlushHost）。
 * 循环 import 规避沿用 hub 第 4 步模式：模块 type-only import（编译期擦除）+
 * `this as unknown as *Host` 窄接口；模块永不运行时 import 本组合根。
 * 行为逐字节不变：方法体逐字保留（this.x → host.x），仅搬家。
 *
 * 2026-09-21（P5 Wave 3 第 3 步）：detectOpenTurn 已迁 log-access 叶子
 * （与 argp-graph-engine 的逐字相同实现收敛），本模块改调导入的模块函数。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Session } from '@deepseek-ai/dsh-session';
import type { NeedCompress } from './gate.js';
import type { PeratomCompressorConfig, CurrentTurnCollect, CompressRecord } from './compressor-types.js';
export type { PeratomCompressorConfig, UserSplit, ToolAction, CompressDecision, CurrentTurnCollect, CompressRecord, PlanOptions, } from './compressor-types.js';
export { defaultEndpoint } from './compressor-types.js';
export { normalizeDecision, planReplacements, toolCopyMarkerText, TOOL_COPY_MARKER_RE } from './decision.js';
export declare class PeratomCompressor {
    static inject: readonly [];
    readonly splitThresholdChars: number;
    readonly smallResultChars: number;
    readonly timeoutMs: number;
    /** HLS 修复档（v1.2.0 组件 B；生产缺省 'trailer'，'off' = v1.1 硬拒行为）。 */
    readonly hlsMode: 'trailer' | 'off';
    /** HLS 经济学门槛 θ（v1.2.0 门控修正；缺省 1）。 */
    readonly hlsRoiThreshold: number;
    /** tool/result 压缩副本头部标记（v1.6.1；生产缺省 true = 开启，false = v1.6 无标记）。 */
    readonly toolCopyMarker: boolean;
    /**
     * 逐原子压缩跳过的上下文形态（v1.6.1；缺省 `DEFAULT_SKIP_CONTEXT_FORMS` =
     * `relay`/`notice` ⇒ 子代理汇报类消息不进压缩、只交给 Stage-2 图剪）。
     * 传空数组 = 关闭本门控，退回 v1.6.0 行为。语义见该常量注释。
     */
    readonly skipContextForms: readonly string[];
    /** 压缩调用输出 cap（默认 4096；JSON plan 输出通常几百 token，小 cap 给 prompt 让出 margin）。 */
    readonly maxCompletionTokens: number;
    /** A 形态前缀预算（默认 132000 ≈ 0.76×174080；前缀超预算 ⇒ 该次降级 C 形态）。 */
    readonly prefixBudgetTokens: number;
    /** 轮末 pass 落地等待上界（ms，默认 180_000；0 = 不等，退回"绝不 await 网络"）。 */
    readonly flushWaitMs: number;
    /**
     * 在飞的轮末 pass（仅 idle 路径登记）：pre-step 据此决定是否等待其落地。
     * 值 = "该 session 的全部在飞 pass 都已 settle" 的**屏障** promise——新 pass 到来时
     * 串联在旧屏障之后（`prior.then(() => pass)`；pass 本身已在跑，不因此串行化）。
     */
    private readonly inFlightPass;
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
    /** 遥测数组容量上限（P4.5：records 有界）。 */
    readonly telemetryCap: number;
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
    constructor(ctx: Context, config?: PeratomCompressorConfig);
    /**
     * 有界等待在飞的轮末 pass（见 `PeratomCompressorConfig.flushWaitMs`）。
     * P5 Wave 3 第 5 步：实现迁 flush.awaitInFlightPass（this → host 窄接口），本方法变薄编排。
     */
    private awaitInFlightPass;
    /**
     * 记住 agent 路由（§11.13.1 自动兜底）。构造期拿不到路由，只能在真会话的
     * `agent/status` / `agent/pre-step` 钩子里现取。非自动模式直接短路。
     * P5 Wave 3 第 5 步：实现迁 flush.rememberRoute（this → host 窄接口），本方法变薄编排。
     */
    private rememberRoute;
    /**
     * 后端选路（§11.13.1）：显式 `config.llm` > fetch（endpoint/apiKey/env）> 自动兜底。
     * 三条都解不出返回 null —— 调用方按 disabled 记账（`no-endpoint`），不抛错、不阻断会话。
     * P5 Wave 3 第 5 步：实现迁 prompt.backend（this → host 窄接口），本方法变薄编排。
     */
    private backend;
    /**
     * 收集当前（最新闭合）轮的可压原子。内嵌三道确定性过滤：
     * ① 中断轮整轮排除（filterInterruptedAtoms，interrupted=true 时数组恒空）；
     * ② 版本链成员硬排除（决策④，need_compress=false）；③ 大小启发式门控。
     * 无再压缩路径：U-info 副本 / plugin checkpoint 一律跳过（决策⑦）。
     * P5 Wave 3 第 5 步：实现迁 collect.collectCurrentTurn（this → host 窄接口），本方法变薄编排。
     */
    collectCurrentTurn(session: Session, afterSeq?: number): CurrentTurnCollect | null;
    /**
     * 收集当前开放轮（最后一条 turn/start 之后、尚无 turn/end）的可压原子。
     * P4 溢出三步路径②专用：溢出发生在 open turn 的请求上，第②步要降熵的正是
     * 这个 open turn——closed-turn 口径会错压上一闭合轮（2026-08-29 review 中项，
     * 与 per-atom 设计 §8「对当前轮大原子降熵」的意图不符）。过滤与闭合轮完全
     * 同款（中断/版本链/大小门控；U-info/checkpoint 跳过）；open turn 无 turn/end，
     * 不会出现在中断集里。无 turn/start（会话头）返回 null。
     * P5 Wave 3 第 5 步：实现迁 collect.collectOpenTurn（this → host 窄接口），本方法变薄编排。
     */
    collectOpenTurn(session: Session, afterSeq?: number): CurrentTurnCollect | null;
    /**
     * idle 触发段：记账防重 → 收集 → 门控 → LLM → 暂存待发射。返回观测记录。
     * P5 Wave 3 第 5 步：实现迁 flush.prepareCurrentTurn（this → host 窄接口），本方法变薄编排。
     */
    prepareCurrentTurn(session: Session): Promise<CompressRecord | null>;
    /**
     * 发射段：把该 session 的全部就绪事务落入下一次 open-turn 窗口（同步追加，吞错记账）。
     * P5 Wave 3 第 5 步：实现迁 flush.flushStashed（this → host 窄接口），本方法变薄编排。
     */
    flushStashed(session: Session): void;
    /**
     * 公开入口（P4 溢出三步路径② / 单测）：立即收集+调用+发射，绕过两段式延迟。
     * P5 Wave 3 第 5 步：实现迁 flush.compressCurrentTurn（this → host 窄接口），本方法变薄编排。
     */
    compressCurrentTurn(session: Session): Promise<CompressRecord | null>;
    /**
     * 公开入口（P4 溢出三步路径② 生产接线）：对当前 open turn 立即收集+调用+发射。
     * 溢出发生在 open turn 的请求上，第②步必须压它而不是最新闭合轮（设计 §8
     * 「对当前轮大原子降熵」；closed 口径会错压上一轮，2026-08-29 review 中项）。
     * 水位语义（2026-09-21 修订）：open turn 压缩后**只推进该轮水位**（= 本次窗口 endSeq），
     * 该轮闭合时 idle prepare 仍会跑，但只收水位之后的新增原子（原先的"轮级一次性"
     * 记账会让轮内 pass 吃掉轮末 pass，使该轮尾部永不入压）。
     * P5 Wave 3 第 5 步：实现迁 flush.compressOpenTurn（this → host 窄接口），本方法变薄编排。
     */
    compressOpenTurn(session: Session): Promise<CompressRecord | null>;
}
export default PeratomCompressor;
