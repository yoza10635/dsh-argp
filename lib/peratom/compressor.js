import { SPLIT_THRESHOLD_CHARS } from './types.js';
import { DEFAULT_SMALL_RESULT_CHARS } from './gate.js';
import { DEFAULT_HLS_ROI_THRESHOLD } from '../token-ontology.js';
import { DEFAULT_LLM_TIMEOUT_MS, DEFAULT_PREFIX_BUDGET_TOKENS, DEFAULT_SKIP_CONTEXT_FORMS } from '../constants.js';
import { DEFAULT_TELEMETRY_CAP } from '../telemetry.js';
// P5 Wave 3 第 5 步：纯类型 + 端点解析迁 compressor-types 叶子（type-only import 编译期擦除，
// 无运行时环）。本地 import 供类/构造函数使用；export ... from 供公共 API 与测试 re-export。
import { defaultEndpoint } from './compressor-types.js';
export { defaultEndpoint } from './compressor-types.js';
// 引擎侧确定性规划（纯函数）：normalizeDecision / planReplacements 供测试与独立调用方。
export { normalizeDecision, planReplacements, toolCopyMarkerText, TOOL_COPY_MARKER_RE, userCopyPayload, attachmentBlocksOf } from './decision.js';
// 收集侧（窄宿主接口 CollectHost）：水位 + 窗口→候选 + closed/open 两口径。
import { waterMarkOf, advanceWaterMark, collectCurrentTurn, collectOpenTurn, } from './collect.js';
// Prompt / 后端选路（窄宿主接口 PromptHost）。
import { backend } from './prompt.js';
// 两段式发射（窄宿主接口 FlushHost）：LLM 调用 + 事务括号 + 在飞 pass 等待 + 路由记忆。
import { prepareCurrentTurn, flushStashed, compressCurrentTurn, compressOpenTurn, awaitInFlightPass, rememberRoute, } from './flush.js';
export class PeratomCompressor {
    static inject = [];
    splitThresholdChars;
    smallResultChars;
    timeoutMs;
    /** HLS 修复档（v1.2.0 组件 B；生产缺省 'trailer'，'off' = v1.1 硬拒行为）。 */
    hlsMode;
    /** HLS 经济学门槛 θ（v1.2.0 门控修正；缺省 1）。 */
    hlsRoiThreshold;
    /** tool/result 压缩副本头部标记（v1.6.1；生产缺省 true = 开启，false = v1.6 无标记）。 */
    toolCopyMarker;
    /**
     * 逐原子压缩跳过的上下文形态（v1.6.1；缺省 `DEFAULT_SKIP_CONTEXT_FORMS` =
     * `relay`/`notice` ⇒ 子代理汇报类消息不进压缩、只交给 Stage-2 图剪）。
     * 传空数组 = 关闭本门控，退回 v1.6.0 行为。语义见该常量注释。
     */
    skipContextForms;
    /** 压缩调用输出 cap（默认 4096；JSON plan 输出通常几百 token，小 cap 给 prompt 让出 margin）。 */
    maxCompletionTokens;
    /** A 形态前缀预算（默认 132000 ≈ 0.76×174080；前缀超预算 ⇒ 该次降级 C 形态）。 */
    prefixBudgetTokens;
    /** 轮末 pass 落地等待上界（ms，默认 180_000；0 = 不等，退回"绝不 await 网络"）。 */
    flushWaitMs;
    /**
     * 在飞的轮末 pass（仅 idle 路径登记）：pre-step 据此决定是否等待其落地。
     * 值 = "该 session 的全部在飞 pass 都已 settle" 的**屏障** promise——新 pass 到来时
     * 串联在旧屏障之后（`prior.then(() => pass)`；pass 本身已在跑，不因此串行化）。
     */
    inFlightPass = new WeakMap();
    chatTemplateKwargs;
    endpoint;
    dshLlm;
    /**
     * 自动兜底候选（§11.13.1）：显式 `config.llm` 与 fetch（endpoint/apiKey/env）两路
     * 都缺省时置 true，后端改为在真会话里延迟解析（agent 路由 + 宿主 ctx.llm）。
     */
    llmAutoEligible;
    /** 延迟解析出的后端（来自 agent 路由；构造期拿不到路由，故后置填充）。 */
    autoLlm = null;
    fetchImpl;
    ctx;
    /** LLM 压缩调用计数器（纯 dialog 轮零调用的断言读这里）。 */
    _calls = 0;
    get calls() { return this._calls; }
    /** 遥测数组容量上限（P4.5：records 有界）。 */
    telemetryCap;
    /** 全部压缩尝试记录（时间序）。 */
    records = [];
    /** 当前暂存待发射的事务数（测试/P4 判断 stash 是否就绪）。 */
    get pendingCount() { return this.pending.length; }
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
    passWatermark = new WeakMap();
    /** idle 阶段产出、等待下一次 open-turn 窗口发射的事务。 */
    pending = [];
    /**
     * tool 对照表 / 作者声明（设计 §6-2）：工具种类名 → 压缩档位。
     * 未声明的工具缺席默认（走大小启发式）；声明只放宽/收紧启发式，不可越过版本链硬排除。
     */
    toolPolicies = new Map();
    /** tool 对照表查询（测试 / P4 接线断言用）。 */
    getToolPolicy(toolName) { return this.toolPolicies.get(toolName); }
    /**
     * 声明某工具种类的压缩档位（设计 §6-2 `setToolPolicy(toolName, policy)`）。
     * `false`=永不压缩（保原文）；'summary'=一句话概括；'extract'=关键内容摘录。
     * 传 `undefined` 撤销声明（回启发式默认）。声明是"提示非命令"：
     * 版本链硬排除（决策序第 1 层）与保真守卫仍先行，错误方向只往"少压"错。
     */
    setToolPolicy(toolName, policy) {
        if (policy === undefined)
            this.toolPolicies.delete(toolName);
        else
            this.toolPolicies.set(toolName, policy);
    }
    /** 门控选项快照：大小阈值 + tool 对照表（prepare / compressCurrentTurn 两处同口径）。 */
    gateOptions() {
        return { smallResultChars: this.smallResultChars, toolPolicies: this.toolPolicies, skipContextForms: this.skipContextForms };
    }
    /** 某轮已规划过的最大 seq（-1 = 未压过）。 */
    waterMarkOf(session, turn) {
        // P5 Wave 3 第 5 步：实现迁 collect.waterMarkOf（this → host 窄接口），本方法变薄编排。
        return waterMarkOf(this, session, turn);
    }
    /** 成功落地后推进水位（单调不回退）。 */
    advanceWaterMark(session, turn, endSeq) {
        // P5 Wave 3 第 5 步：实现迁 collect.advanceWaterMark（this → host 窄接口），本方法变薄编排。
        advanceWaterMark(this, session, turn, endSeq);
    }
    /** 测试 / 诊断入口：读某轮的压缩水位。 */
    turnWaterMark(session, turn) {
        return this.waterMarkOf(session, turn);
    }
    constructor(ctx, config = {}) {
        this.ctx = ctx;
        this.dshLlm = config.llm ?? null;
        this.endpoint = config.endpoint !== undefined
            ? {
                endpoint: config.endpoint,
                model: config.model ?? 'deepseek-v4-flash',
                apiKey: config.apiKey ?? '',
            }
            : (config.apiKey !== undefined ? { endpoint: config.endpoint ?? 'https://api.deepseek.com/chat/completions', model: config.model ?? 'deepseek-v4-flash', apiKey: config.apiKey } : defaultEndpoint());
        this.splitThresholdChars = config.splitThresholdChars ?? SPLIT_THRESHOLD_CHARS;
        this.smallResultChars = config.smallResultChars ?? DEFAULT_SMALL_RESULT_CHARS;
        this.timeoutMs = config.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;
        this.flushWaitMs = config.flushWaitMs ?? 180_000;
        this.telemetryCap = config.telemetryCap ?? DEFAULT_TELEMETRY_CAP;
        this.hlsMode = config.hlsMode ?? 'trailer';
        this.hlsRoiThreshold = config.hlsRoiThreshold ?? DEFAULT_HLS_ROI_THRESHOLD;
        this.toolCopyMarker = config.toolCopyMarker ?? true;
        this.skipContextForms = config.skipContextForms ?? DEFAULT_SKIP_CONTEXT_FORMS;
        this.chatTemplateKwargs = config.chatTemplateKwargs;
        this.maxCompletionTokens = config.maxCompletionTokens ?? 16_384;
        this.prefixBudgetTokens = config.prefixBudgetTokens ?? DEFAULT_PREFIX_BUDGET_TOKENS;
        if (config.toolPolicies !== undefined) {
            for (const [name, policy] of config.toolPolicies)
                this.toolPolicies.set(name, policy);
        }
        this.fetchImpl = config.fetchImpl ?? ((...args) => fetch(...args));
        // 显式 llm 与 fetch 两路都缺省 ⇒ 进入自动兜底（真会话里解析 agent 路由）。
        this.llmAutoEligible = config.llm === undefined && this.endpoint === null;
        if (this.endpoint === null && this.dshLlm === null) {
            if (this.llmAutoEligible) {
                ctx.logger.info('[argp-peratom] compressor: no explicit LLM backend; auto mode — will follow the host dsh-llm + agent route once a real session provides one (disabled, zero network, until then)');
            }
            else {
                ctx.logger.warn('[argp-peratom] compressor: no LLM backend resolved (set DEEPSEEK_API_KEY, pass config.llm, or pass config); compressor disabled');
            }
        }
        // 触发钩子：轮末 idle（当轮必已闭）→ 收集 + LLM（异步，不阻塞状态切换）。
        // 同时把该 pass 登记为"在飞"（屏障），供 pre-step 决定是否等待（见 flushWaitMs）。
        ctx.on('agent/status', ({ agent, status }) => {
            this.rememberRoute(agent);
            if (status !== 'idle')
                return;
            const pass = this.prepareCurrentTurn(agent.session).catch(error => {
                this.ctx.logger.warn(`[argp-peratom] compressor prepare failed: ${error instanceof Error ? error.message : String(error)}`);
            });
            const prior = this.inFlightPass.get(agent.session);
            this.inFlightPass.set(agent.session, prior === undefined ? pass : prior.then(() => pass, () => pass));
        });
        // 发射窗口：下一次 agent/pre-step（open turn 已开、新 user/message 未落盘）。
        // 先**有界等待**在飞的轮末 pass（flushWaitMs，默认 180s），再同步追加已就绪条目
        // （flushStashed 本身仍是同步、不 await 网络）。等待保证"下一个 user message 的
        // 首个请求"带上本次压缩结果，而不是让替换副本落在新轮中途。超时不阻塞：告警后照旧
        // 放行，事务在后续窗口落地。
        ctx.on('agent/pre-step', async ({ agent }, next) => {
            this.rememberRoute(agent);
            await this.awaitInFlightPass(agent.session);
            this.flushStashed(agent.session);
            return next();
        });
    }
    /**
     * 有界等待在飞的轮末 pass（见 `PeratomCompressorConfig.flushWaitMs`）。
     * P5 Wave 3 第 5 步：实现迁 flush.awaitInFlightPass（this → host 窄接口），本方法变薄编排。
     */
    awaitInFlightPass(session) {
        return awaitInFlightPass(this, session);
    }
    // -- LLM 后端选择 -------------------------------------------------------
    /**
     * 记住 agent 路由（§11.13.1 自动兜底）。构造期拿不到路由，只能在真会话的
     * `agent/status` / `agent/pre-step` 钩子里现取。非自动模式直接短路。
     * P5 Wave 3 第 5 步：实现迁 flush.rememberRoute（this → host 窄接口），本方法变薄编排。
     */
    rememberRoute(agent) {
        rememberRoute(this, agent);
    }
    /**
     * 后端选路（§11.13.1）：显式 `config.llm` > fetch（endpoint/apiKey/env）> 自动兜底。
     * 三条都解不出返回 null —— 调用方按 disabled 记账（`no-endpoint`），不抛错、不阻断会话。
     * P5 Wave 3 第 5 步：实现迁 prompt.backend（this → host 窄接口），本方法变薄编排。
     */
    backend() {
        return backend(this);
    }
    // -- 收集 ---------------------------------------------------------------
    /**
     * 收集当前（最新闭合）轮的可压原子。内嵌三道确定性过滤：
     * ① 中断轮整轮排除（filterInterruptedAtoms，interrupted=true 时数组恒空）；
     * ② 版本链成员硬排除（决策④，need_compress=false）；③ 大小启发式门控。
     * 无再压缩路径：U-info 副本 / plugin checkpoint 一律跳过（决策⑦）。
     * P5 Wave 3 第 5 步：实现迁 collect.collectCurrentTurn（this → host 窄接口），本方法变薄编排。
     */
    collectCurrentTurn(session, afterSeq) {
        return collectCurrentTurn(this, session, afterSeq);
    }
    /**
     * 收集当前开放轮（最后一条 turn/start 之后、尚无 turn/end）的可压原子。
     * P4 溢出三步路径②专用：溢出发生在 open turn 的请求上，第②步要降熵的正是
     * 这个 open turn——closed-turn 口径会错压上一闭合轮（2026-08-29 review 中项，
     * 与 per-atom 设计 §8「对当前轮大原子降熵」的意图不符）。过滤与闭合轮完全
     * 同款（中断/版本链/大小门控；U-info/checkpoint 跳过）；open turn 无 turn/end，
     * 不会出现在中断集里。无 turn/start（会话头）返回 null。
     * P5 Wave 3 第 5 步：实现迁 collect.collectOpenTurn（this → host 窄接口），本方法变薄编排。
     */
    collectOpenTurn(session, afterSeq) {
        return collectOpenTurn(this, session, afterSeq);
    }
    // -- 两段式：idle 准备 → pre-step 发射 ----------------------------------
    /**
     * idle 触发段：记账防重 → 收集 → 门控 → LLM → 暂存待发射。返回观测记录。
     * P5 Wave 3 第 5 步：实现迁 flush.prepareCurrentTurn（this → host 窄接口），本方法变薄编排。
     */
    async prepareCurrentTurn(session) {
        return prepareCurrentTurn(this, session);
    }
    /**
     * 发射段：把该 session 的全部就绪事务落入下一次 open-turn 窗口（同步追加，吞错记账）。
     * P5 Wave 3 第 5 步：实现迁 flush.flushStashed（this → host 窄接口），本方法变薄编排。
     */
    flushStashed(session) {
        flushStashed(this, session);
    }
    /**
     * 公开入口（P4 溢出三步路径② / 单测）：立即收集+调用+发射，绕过两段式延迟。
     * P5 Wave 3 第 5 步：实现迁 flush.compressCurrentTurn（this → host 窄接口），本方法变薄编排。
     */
    async compressCurrentTurn(session) {
        return compressCurrentTurn(this, session);
    }
    /**
     * 公开入口（P4 溢出三步路径② 生产接线）：对当前 open turn 立即收集+调用+发射。
     * 溢出发生在 open turn 的请求上，第②步必须压它而不是最新闭合轮（设计 §8
     * 「对当前轮大原子降熵」；closed 口径会错压上一轮，2026-08-29 review 中项）。
     * 水位语义（2026-09-21 修订）：open turn 压缩后**只推进该轮水位**（= 本次窗口 endSeq），
     * 该轮闭合时 idle prepare 仍会跑，但只收水位之后的新增原子（原先的"轮级一次性"
     * 记账会让轮内 pass 吃掉轮末 pass，使该轮尾部永不入压）。
     * P5 Wave 3 第 5 步：实现迁 flush.compressOpenTurn（this → host 窄接口），本方法变薄编排。
     */
    async compressOpenTurn(session) {
        return compressOpenTurn(this, session);
    }
}
export default PeratomCompressor;
