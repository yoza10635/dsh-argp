import z from '@deepseek-ai/schemastery';
import { CompactionEngine } from '@deepseek-ai/dsh-compaction';
import { CONTEXT_WINDOW_EXCEEDED_CODE, createUserMessage, isContextWindowExceededError } from '@deepseek-ai/dsh-llm';
import { asSeq, detectOpenTurn, sessionEvents, turnOf } from './log-access.js';
// eventText 转发自 log-access，维持既有公共 API 与测试 import。
export { eventText } from './log-access.js';
import { DEFAULT_CHARS_PER_TOKEN, DEFAULT_EGRESS_MARGIN_RATIO, DEFAULT_EGRESS_OUTPUT_RATIO, DEFAULT_FOCAL_TURNS, DEFAULT_RETAIN_RATIO, DEFAULT_VOCAB_TOP_N, DEFAULT_WINDOW_RATIO } from './constants.js';
import { createSessionRuntimeState } from './session-state.js';
// 原子化模块：atomize/extractCites/classifyUserMessage/looksAskText。本地使用 + 转发。
import { extractCites, atomize } from './atomize.js';
export { looksAskText, classifyUserMessage, extractCites } from './atomize.js';
// 预算/度量模块：scaleBudgets/resolveScaledBudgets/measureTokens/acquireTokenMeter。
import { resolveScaledBudgets, measureTokens, liveBlendCharsPerToken } from './budget.js';
import { countCjkChars, estTokensFromStats } from './cjk.js';
export { scaleBudgets } from './budget.js';
import { FactorEngine, resolveClipEnabled, resolveEgress, resolveFocalTiered, resolvePressureTriggerEnabled } from "./factor/engine.js";
import { registerRecallLabels } from "./factor/recall-labels.js";
import { registerSearchHistory } from "./factor/search-history.js";
import { ProseCondenser } from "./factor/prose-condenser.js";
// 召回模块（2.0 只留共享语义）：shadowed 增量账本 + 召回字符预算。本地使用。
import { shadowedSeqsOf, budgetRecallText } from './recall.js';
// /argp 只读状态命令：经嵌套 ctx.inject(['commands']) 注册，宿主无命令服务时静默不注册。
import { registerArgpCommand } from './argp-command.js';
// 会话生命周期 + 构造期装配：normalizeConfig/registerSettings/bindSession/rebuildLedgerFromLog。
// 设置页常量（ARG_SETTINGS_KEY/ArgpUserSettingsSchema）在 session-lifecycle，此处转发维持公共 API。
import { normalizeConfig, registerSettings, bindSession, rebuildLedgerFromLog } from './session-lifecycle.js';
export { ARG_SETTINGS_KEY, ArgpUserSettingsSchema } from './session-lifecycle.js';
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
export function stripTrailingCitesIfNeeded(session, event) {
    const data = event.data;
    if (data === undefined)
        return;
    if (Array.isArray(data.argpCites))
        return; // 已剥离，跳过
    const msg = data.message;
    const content = msg?.content;
    if (!Array.isArray(content) || content.length === 0)
        return;
    let lastIdx = -1;
    for (let i = content.length - 1; i >= 0; i -= 1) {
        const b = content[i];
        if (b?.type === 'text') {
            lastIdx = i;
            break;
        }
    }
    if (lastIdx === -1)
        return;
    const block = content[lastIdx];
    if (typeof block.text !== 'string')
        return;
    const { body, cites } = extractCites(block.text);
    if (body === block.text)
        return; // 无 cites 块，无需改写
    const newContent = content.slice();
    newContent[lastIdx] = { ...block, text: body };
    session.append('assistant/message', {
        ...data,
        message: { ...msg, content: newContent },
        argpCites: cites,
    }, {
        surfaceOp: { op: 'replace', startSeq: asSeq(event.seq), endSeq: asSeq(event.seq) },
        // 不给 sourceEventSeqs：dsh 0.1.5 起 assistant/message 自带 provider stream，
        // 类型层为 `sourceEventSeqs?: never`、运行时 assertProvenance 亦直接 throw
        // （"assistant/message embeds its source stream and cannot carry sourceEventSeqs"）。
        // 安全性：shadowedSeqsOf 只认 compaction/prune.shadowedSeqs 权威账本，
        // 不从 replace 事件推断被遮节点，故本处省略不影响剪枝账目。
    });
}
/** 默认在这些 preset 下不生效（极简 preset 保留原生态）。 */
const DEFAULT_SKIP_PRESETS = ['minimal'];
/**
 * §A：从 400 溢出报文里解析**真实上下文上限**（observedCap）。只在报文带了明确
 * 数字上限时返回；pi-ai 通用文案（"detected context overflow"，无数）返回 undefined
 * ⇒ 调用方保留声明窗（行为不变）。返回的是模型窗（token），取报文里的"上限"侧数字。
 * 导出供单测。
 */
export function parseObservedContextCap(message) {
    if (message === undefined || message === '')
        return undefined;
    const num = (s) => parseInt(s.replace(/,/g, ''), 10);
    const rules = [
        [/maximum context length[^0-9]*([0-9][0-9,]*)\s*tokens/i, m => num(m[1])],
        [/context length is[^0-9]*([0-9][0-9,]*)/i, m => num(m[1])],
        [/prompt is too long[^0-9]*[0-9][0-9,]*\s*tokens?[^\d]*([0-9][0-9,]*)/i, m => num(m[1])],
        [/([0-9][0-9,]*)\s*tokens?\s*(?:exceeds|>)\s*(?:the\s*)?(?:model'?s?\s*)?[^0-9]*([0-9][0-9,]*)/i, m => num(m[2])],
        [/(?:max(?:imum)?|limit(?:\s+of)?|of)\D{0,15}([0-9][0-9,]*)\s*tokens/i, m => num(m[1])],
    ];
    for (const [re, pick] of rules) {
        const m = message.match(re);
        if (m !== null) {
            const v = pick(m);
            if (Number.isFinite(v) && v >= 1024)
                return v;
        }
    }
    return undefined;
}
export class ArgpEngine extends CompactionEngine {
    /**
     * UI 设置页旋钮（dsh 0.1.7+）。Settings 通过扫描插件的 `static Config` 生成
     * 表单；2.0.1 起名册唯一活键 = `compactionThreshold`（压缩阈值）：出口闸触发线
     * = 声明窗 × 本比例，0=关闭（模型撞墙 400 → 自动压缩兜底）。volatile = 设置页
     * 改动免重挂即生效。其余五枚旧旋钮保持退役（constants 固化 + 老键宽容告警）。
     */
    static Config = z.object({
        compactionThreshold: z.number().min(0).max(1).default(0).volatile(),
    });
    static inject = ['tools'];
    /** 2.0 因子引擎（构造期恒装配、会话内不变）。 */
    factor;
    /** P6-④ 散文浓缩链（factor 唯一 LLM 摘要通路，只在压缩事务内被调；见 prose-condenser.ts）。 */
    prose;
    /** P6-④ 触发收敛逃生口（构造期快照，ARGP_FACTOR_TIER 同款纪律）：env 置 1 恢复旧估算驱动压力剪。 */
    pressureTriggerEnabled = false;
    /** 原始构造 config（压缩阈值 volatile 读实时值的取数面）。 */
    rawConfig;
    windowTokens;
    retainTokens;
    /** true = config 显式给 windowTokens；false = 运行时按 contextWindow × windowRatio 解析。 */
    explicitWindowTokens;
    /** true = config 显式给 retainTokens；false = 运行时按 windowTokens × retainRatio 解析。 */
    explicitRetainTokens;
    reserveTokens;
    tokenMeterFn;
    /** 在这些 preset 下不生效的 preset id 列表（构造期定，默认 ['minimal']）。 */
    skipPresets;
    /** 已就"跳过"记过日志的会话（每会话只记一次，避免 pre-step 每步刷屏）。 */
    skipLogged = new WeakSet();
    /** 已就"toolResultPruner 缺失"记过日志的会话（每会话一次，防压缩事务刷屏）。 */
    nativePrunerMissingLogged = new WeakSet();
    /**
     * 2.0.0 起零旋钮：以下读取点返回 constants.ts 的固化缺省（原设置页六枚旋钮已退役）。
     * 显式 windowTokens/retainTokens 仍走构造配置；比例与估算口径不再可调。
     */
    get windowRatio() { return DEFAULT_WINDOW_RATIO; }
    get retainRatio() { return DEFAULT_RETAIN_RATIO; }
    get charsPerToken() { return DEFAULT_CHARS_PER_TOKEN; }
    maxOverflowRetries;
    /** dsh token-meter 服务；真会话中可用时优先用于 token 测量和 contextWindow 探测。 */
    tokenMeter;
    /** 遥测数组容量上限（P4.5：records/recallCalls/auditWarnings 有界）。 */
    telemetryCap;
    // ---------------------------------------------------------------------
    // 会话运行时状态（1-1 起按会话分桶）：以下成员住在 SessionRuntimeState
    //（WeakMap<Session> 分桶，见 sessionStates/stateOf）。引擎上的 getter/setter 是
    // **焦点兼容层**——同步方法沿用 this.x 写法零改动。
    // ---------------------------------------------------------------------
    get records() { return this.rt.records; }
    get recallCalls() { return this.rt.recallCalls; }
    get citeStats() { return this.rt.citeStats; }
    /** 已剪节点目录（seq -> 元数据），供 /argp 与账目重建。 */
    get prunedNodeIndex() { return this.rt.prunedNodeIndex; }
    get recallCallsThisTurn() { return this.rt.recallCallsThisTurn; }
    get recallCharsUsed() { return this.rt.recallCharsUsed; }
    /** context-overflow 恢复：每个 agent 的重试计数（assistant/message 成功或 idle 时重置）。 */
    overflowRetries = new WeakMap();
    /** session → agent 映射，供成功后重置重试计数（agent loop 上下文经 session/event 取不到 agent）。 */
    overflowAgents = new WeakMap();
    /** 最近一次请求的真实 prompt token（usage.inputTokens + cacheReadTokens + cacheWriteTokens，
     *  provider 回报，与 UI ContextMeter 分子同口径）。
     *  pressure check 用它锚定 + 增量估算，替代 tokenMeter 的 chars/4 启发式（低估 30%+，
     *  导致迟触发/窗口保护失效，2026-08-23）。 */
    get lastRealPromptTokens() { return this.rt.lastRealPromptTokens; }
    set lastRealPromptTokens(v) { this.rt.lastRealPromptTokens = v; }
    /** 声明窗口缓存（session → 适配器声明的 contextWindow，来自 request/context 事件）。
     *  真环境联调实证：物理窗口探测（llama.cpp n_ctx=262144）与声明窗口（32000）
     *  在 pre-step 时刻可能错位，声明值缺失时宁可跳过检查也不用物理口径。 */
    declaredContextWindows = new WeakMap();
    /** §A observedCap（session → 从数字型 400 报文学到的**真实**上下文上限）。
     *  仅当 provider 在 400 里报了真实 max（如 OpenAI "maximum context length is N tokens"）
     *  才落账；未知 ⇒ 有效窗退回声明（行为不变）。用于 `W_eff = min(声明, observedCap)`，
     *  修「声明窗 > 真实上限 ⇒ 压力/散文闸永不触发」的死锁。 */
    observedContextWindows = new WeakMap();
    /** 锚点：lastRealPromptTokens 已覆盖的 surface 最大 seq（其后新增内容需增量估算）。 */
    get lastRealAnchorSeq() { return this.rt.lastRealAnchorSeq; }
    set lastRealAnchorSeq(v) { this.rt.lastRealAnchorSeq = v; }
    /** 本会话最近解析的有效窗口（桶化随 rt；budget.ts 经 stateOf 直写本桶，见 session-state.ts）。 */
    get resolvedWindowTokens() { return this.rt.resolvedWindowTokens; }
    set resolvedWindowTokens(v) { this.rt.resolvedWindowTokens = v; }
    /** /compact 手动压缩的发起命令 ID（presentation correlation，透传给事务事件）。 */
    compactSourceCommandId = undefined;
    /** A7：账本重建后追加的审计警告（供测试断言/诊断；per-session）。 */
    get auditWarnings() { return this.rt.auditWarnings; }
    /** A7：已重建过的 compactionId 集合（per-session 分桶后天然跨会话隔离，幂等 + 告警不重复）。 */
    get rebuiltCompactionIds() { return this.rt.rebuiltCompactionIds; }
    /** 本次请求声明的输出预算（`agent/request` 捕获；适配器的钳制发生在其后，故这里拿到的是请求值）。 */
    requestMaxTokens = new WeakMap();
    /** §9.37 出口闸·输出预算档③：llm `resolveModelInfo().defaultMaxTokens` 探测缓存
     *  （请求缺 maxTokens 时 llm 服务在 agent/request 瀑布**之后**注入它——观测档盲区，
     *  宿主 llm/src/index.ts resolveCallWithInfo 实证）。0 = 已探无（不重探）；缺键 = 未探。 */
    modelDefaultMaxTokensCache = new WeakMap();
    session = null;
    /** 会话运行时状态分桶（1-1）：stateOf 懒建；rt = 当前焦点会话的桶（bindRuntimeState 换装）。 */
    sessionStates = new WeakMap();
    rt = createSessionRuntimeState();
    /** 绑定过的会话身份登记（sessionCount 用；WeakSet 不持有引用）。 */
    seenSessions = new WeakSet();
    seenSessionCount = 0;
    stateOf(session) {
        let st = this.sessionStates.get(session);
        if (st === undefined) {
            st = createSessionRuntimeState();
            this.sessionStates.set(session, st);
        }
        return st;
    }
    /** bindSession 专用：把焦点桶换装为该会话的桶（session-lifecycle 经 LifecycleHost 调用）。 */
    bindRuntimeState(session) {
        this.rt = this.stateOf(session);
        // 会话可见性登记：召回工具的"焦点回退"只在引擎只见过一个会话时允许；
        // 多会话宿主下 exec.agent 缺席的回退会静默串台，改为显式拒绝。
        if (!this.seenSessions.has(session)) {
            this.seenSessions.add(session);
            this.seenSessionCount += 1;
        }
    }
    /** 引擎累计绑定过的不同会话数（WeakSet 计数；>1 时召回工具不得回退焦点会话）。 */
    sessionCount() { return this.seenSessionCount; }
    /** 结构化日志门面（构造期自 ctx 捕获）。 */
    log;
    constructor(ctx, config = {}) {
        super(ctx);
        // 结构化日志门面（2026-08-29 review 轻微项）：替换裸 console 直调，日志进宿主
        // 统一管道（ctx.logger 门面；warn/error/info 三级均被 cordis logger 支持）。
        this.log = ctx.logger;
        this.rawConfig = config;
        // 在这些 preset 下不生效（构造期定；默认 ['minimal']）。
        this.skipPresets = [...(config.skipPresets ?? DEFAULT_SKIP_PRESETS)];
        normalizeConfig(ctx, this, config);
        registerSettings(ctx, this, config);
        // 旋钮已退役（2.0.0 零旋钮）：焦点/词表口径用 constants.ts 固化缺省。
        this.factor = new FactorEngine(this, {
            focalTurns: () => DEFAULT_FOCAL_TURNS,
            vocabTopN: () => DEFAULT_VOCAB_TOP_N,
            // 策略档 env 逃生口（T-3 两臂实跑）：缺省 flat=现行为字节不变，
            // 禁入 static Config ⇒ env 是生产触达 tiered 的唯一通道（resolveFocalTiered 注释）。
            focalTiered: resolveFocalTiered(),
            // C10 夹剪层（三态保留）：构造期快照 env，缺省关=shadow 二态字节不变（R2 A/B 通道）。
            clipEnabled: resolveClipEnabled(),
            // 散文扫描带 cap 裸项透传（缺省 undefined=窗相对现算；0=关闭散文带）。
            proseScanCapChars: config.proseScanCapChars,
        });
        // P6-④ 散文浓缩链：factor 唯一 LLM 摘要通路，只在压缩事务内被调
        // （compactIfNeeded——overflow 或出口闸驱进的 'pressure' 且闸二 ctx 线补检通过 /
        // compactNow 免闸二；估算驱动零触达）。
        this.prose = new ProseCondenser(ctx, this, {
            focalTurns: () => DEFAULT_FOCAL_TURNS,
        });
        // 触发收敛逃生口：构造期快照 env（档位语义同 resolveFocalTiered——策略切换须重挂引擎）。
        this.pressureTriggerEnabled = resolvePressureTriggerEnabled();
        // §9.37 出口闸：缺省关（2026-11-15 用户裁定：对照臂形态=缺省，贴墙交 400 兜底网）。
        // 开启面 = 设置「压缩阈值」(compactionThreshold>0，volatile 实时读) 或 env=1（评测/对照），
        // 每次 pre-step 经 resolveEgress 实时解析（设置页改动免重挂生效）。
        // 召回面 = recall_history / list_labels（标签制）+ search_history（内容发现，2.1.0）。
        registerRecallLabels(ctx, this.factor, this);
        registerSearchHistory(ctx, this.factor, this);
        this.log.info('[argp] engine=factor-only（2.0）：R 贴标剪枝 + 散文浓缩；召回面 = recall_history/list_labels（标签）+ search_history（内容发现）');
        // /argp 状态命令：只读出口，放在工具注册之后（依赖 commands 服务，缺失时
        // inject 回调不执行 ⇒ 不改变其余装配的可观测行为）。
        registerArgpCommand(ctx, this);
        // 压缩/恢复引导不在 system 前缀常驻：词表 note 在首次压缩事务后注入
        // （VOCAB_NOTE_GUIDE），前缀保持稳定，且 note 本就只在压缩时变化。
        ctx.on('session/event', (session, event) => {
            // 声明窗口缓存（真环境联调实证）：request/context 事件携带适配器声明的
            // contextWindow（settings 模型条目），是权威口径。pre-step 压力检查可能早于首个
            // request/context 事件落账（新会话 turn-1），此缓存使后续检查/重启会话立即拿到
            // 声明值，不再退化为物理窗口探测（llama.cpp 场景 262144 vs 声明 32000，7.7× 口径差）。
            if (event.type === 'request/context') {
                const declared = event.data?.contextWindow;
                if (typeof declared === 'number' && declared > 0) {
                    const previous = this.declaredContextWindows.get(session);
                    if (previous !== undefined && previous !== declared) {
                        this.log.info(`[argp-engine] declared contextWindow changed: ${previous} -> ${declared}`);
                    }
                    this.declaredContextWindows.set(session, declared);
                }
            }
            // 外来压缩事务可见性（真环境联调实证）：本插件的 compactionId 一律带
            // `argp-` 前缀；不带前缀的 compaction/start = 其他压缩实现（如原生摘要器）在
            // 本 ctx.compaction 位之外运作——lossy 摘要会先于本引擎事务发生，必须在日志可见。
            if (event.type === 'compaction/start') {
                const cid = event.data?.compactionId;
                if (typeof cid === 'string' && !cid.startsWith('argp-')) {
                    this.log.warn(`[argp-engine] foreign compaction detected (id=${cid}, turn=${turnOf(event) ?? '?'})`
                        + ' — a non-ARGP compaction engine is active; lossy summarization may pre-empt ARGP pruning');
                }
            }
            // 真实 token 锚点（2026-08-23）：assistant/message 携带 provider 回报的 usage，
            // inputTokens（未命中）+ cacheReadTokens（命中）+ cacheWriteTokens（写缓存，
            // Anthropic 风格 provider 上报；OpenAI 兼容端点缺省 0）= 本次请求的真实 prompt token。
            // pressure check 优先用它，避免 tokenMeter chars/4 低估导致的迟触发。
            // 与 UI ContextMeter 分子同口径（connection client contextPressureOf）。
            if (event.type === 'assistant/message') {
                const usage = event.data?.usage;
                const seq = event.seq;
                if (usage !== undefined && typeof usage.inputTokens === 'number') {
                    const usageSt = this.stateOf(session);
                    usageSt.lastRealPromptTokens = (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
                    if (typeof seq === 'number')
                        usageSt.lastRealAnchorSeq = seq;
                }
                // 一次成功的模型应答 = 溢出恢复序列的终结点：重置该 agent 的重试计数，
                // 即使工具调用让同一 turn 继续（对齐 compaction-basic 的 overflowAgents 模式）。
                const agent = this.overflowAgents.get(session);
                if (agent !== undefined)
                    this.overflowRetries.delete(agent);
            }
            // 流式闭环后立刻剥离尾部 {"cites":[...]} JSON（残差清扫；见函数头注释）。
            const seq = event.seq;
            if (event.type === 'assistant/message' && typeof seq === 'number') {
                // 延迟到本次事件发射结束后执行，避免在读/写 surface 的中途改写 surface（重入安全）
                const ev = event;
                Promise.resolve().then(() => {
                    try {
                        stripTrailingCitesIfNeeded(session, ev);
                    }
                    catch { /* 不阻断主流程 */ }
                });
            }
        });
        ctx.on('agent/status', ({ agent, status }) => {
            if (status === 'idle')
                this.overflowRetries.delete(agent);
        });
        // 上下文溢出恢复（官方机制，与 compaction-basic 同构）：模型请求返回
        // 400 exceed_context_size_error（稳定错误码 CONTEXT_WINDOW_EXCEEDED，不写死
        // token 数）时，强制剪枝并把请求重发出去。识别靠 LlmFailure.code ——
        // provider 特定错误（DeepSeek 的 {"type":"exceed_context_size_error"}）由
        // dsh-llm 适配器归一化到该稳定码。
        ctx.on('agent/request-error', async ({ agent, failure, signal }, next) => {
            // P6-④ 报错事件核验补强（2026-11-12，17+20 真实样本核验结论）：两报错类在生产
            // 已归一 CONTEXT_WINDOW_EXCEEDED——t24v 21 死轮实锤走 pi-ai usage-based
            // isContextOverflow 分支（模板消息 "pi-ai detected context overflow" 本身不过
            // isContextWindowExceededError 文本分类器，但 code 已是稳定码，钩子按 code 路由 ✓）。
            // 残余缺口 = pi-ai 通用适配器对**非词语化** 400（裸 exceed_context_size_error type、
            // 无词语文本）落 PI_AI_ERROR（classifyPiAiError 词面全不中）——加文本回兜：
            // message 命中 isContextWindowExceededError 同样进拦截；rate-limit/网络/余额词面
            // 判假已核（本地对照 5 例全过），回兜不误伤非溢出类。
            const overflowLike = failure.code === CONTEXT_WINDOW_EXCEEDED_CODE
                || isContextWindowExceededError(failure.message ?? '');
            if (!overflowLike || signal.aborted)
                return next();
            // §A：报文若报了真实上限（如 "maximum context length is 131072 tokens"），
            // 学到 observedCap → 后续有效窗 = min(声明, 真实)，解开声明>真实的压力/散文闸死锁。
            // pi-ai 通用文案无数 ⇒ parse 返回 undefined ⇒ 不记（行为不变）。取更小者为准。
            const cap = parseObservedContextCap(failure.message);
            if (cap !== undefined) {
                const prev = this.observedContextWindows.get(agent.session);
                if (prev === undefined || cap < prev) {
                    this.observedContextWindows.set(agent.session, cap);
                    const declaredNow = this.declaredContextWindows.get(agent.session) ?? 0;
                    this.log.info(`[argp-engine] observedCap learned: ${cap} tokens`
                        + (declaredNow > 0 ? ` (declared=${declaredNow}, effective=${Math.min(cap, declaredNow)})` : '')
                        + `; 400 msg: ${(failure.message ?? '').slice(0, 140)}`);
                }
            }
            this.overflowAgents.set(agent.session, agent);
            const retries = this.overflowRetries.get(agent) ?? 0;
            if (retries >= this.maxOverflowRetries)
                return next();
            // 溢出恢复只剩一步（forcePrune 后 retry）；重试上限缺省 1（对齐官方 compaction-basic）。
            const session = agent.session;
            const genBefore = session.surface.replaceGeneration;
            let result;
            try {
                result = await this.compactIfNeeded(agent, 'context-overflow', signal);
            }
            catch (recoveryError) {
                const message = recoveryError instanceof Error ? recoveryError.message : String(recoveryError);
                // 剪枝可能在摘要之类后续阶段抛错前已落地（模型无关的确定性占位
                // 替换）。只要 surface 换代了，这次减量就是重试的充分凭证，不丢弃。
                if (!signal.aborted && session.surface.replaceGeneration > genBefore) {
                    // 审查 P1-1：durable surface progress ≠ 减够；仍 ≥ 窗则不 retry（同一超窗请求重发只会再 400）。
                    const declaredAfterCatch = this.effectiveWindowFor(session);
                    if (declaredAfterCatch > 0 && this.postPruneProjection(session) >= declaredAfterCatch) {
                        this.log.warn(`[argp-engine] overflow prune partial progress but still ≥ window: ${message}; not retrying`);
                        return next();
                    }
                    this.log.warn(`[argp-engine] overflow prune failed after durable surface progress: ${message}; retrying from the replacement surface`);
                    this.overflowRetries.set(agent, retries + 1);
                    return { kind: 'retry' };
                }
                this.log.warn(`[argp-engine] overflow prune failed: ${message}; ${signal.aborted ? 'cancellation prevents retry' : 'preserving the original request error'}`);
                return next();
            }
            if (signal.aborted || session.surface.replaceGeneration <= genBefore)
                return next();
            if (result !== null) {
                this.log.info(`[argp-engine] context-overflow prune: shadowed ${result.shadowedSeqs.length} surface nodes `
                    + `(seqs ${result.shadowedRange.start}-${result.shadowedRange.end}, ~${result.shadowedTokenCount} tokens)`);
            }
            // 2026-11-13 T34 实锤：surface 换代 ≠ 减够。事务后二次测量；仍 ≥ 声明窗 ⇒ 不 retry
            // （重发同一超窗请求只会再吃一发 400），保留原始错误交给下一轮/用户。
            const declaredForGuard = this.effectiveWindowFor(session);
            if (declaredForGuard > 0) {
                const after = this.postPruneProjection(session);
                if (after >= declaredForGuard) {
                    this.log.warn('[argp-engine] overflow prune 后仍 ≥ 声明窗（projected=' + after
                        + ' ≥ ' + declaredForGuard + '）：不 retry 同一超窗请求');
                    return next();
                }
            }
            this.overflowRetries.set(agent, retries + 1);
            return { kind: 'retry' };
        });
        // 本次请求声明的输出预算（L2 判据的一半）。只读 waterfall：不改配置，仅记录，供
        // assistant/message 落账时区分"输出被**外部**钳制"与"模型自己写满预算"。
        ctx.on('agent/request', async ({ agent }, next) => {
            const config = await next();
            if (typeof config.maxTokens === 'number' && config.maxTokens > 0) {
                this.requestMaxTokens.set(agent.session, config.maxTokens);
            }
            return config;
        });
        ctx.on('agent/pre-step', async ({ agent, messages, step, signal }, next) => {
            this.bindSession(agent.session); // A7（问题 3）：生产 resume 点，账目缺失时自动重建
            // skipPresets 必须在**所有**破坏性路径之前判：出口闸/浓缩闸二/压力逃生口都在本
            // 钩子内直调事务，若只在 compactIfNeeded/compactNow 里判，minimal preset 会被
            // 浓缩链改写（"ARGP 不生效"承诺破裂）。命中即整钩子退场（含后续 next()）。
            if (this.skipIfPreset(agent.session))
                return next();
            // factor 分发（P6-④ 触发收敛）：pre-step 估算驱动退役——破坏性改写只认
            // 手动 compact + context 报错两信号，外加 §9.37 出口闸（anchored 确定性容量算术，
            // 非估算驱动）。词表 note 同步迁出 pre-step（变化时机 = 压缩时机，事务收尾统一写）。
            // ARGP_FACTOR_PRESSURE=1 = 评测逃生口，恢复旧估算驱动路径。
            const incoming = this.incomingTokens(messages);
            if (!signal.aborted && this.pressureTriggerEnabled) {
                try {
                    await this.factorPressure(agent, incoming);
                }
                catch (e) {
                    this.log.warn('[argp-factor] pre-step 压力剪失败（不阻断本步）: ' + (e instanceof Error ? e.message : String(e)));
                }
            }
            // §9.37 出口闸（缺省关，ARGP_FACTOR_EGRESS=1 或设置「压缩阈值」>0 开）：必然超窗
            // 的请求根本不发——先剪后发，根除撞墙 400/钳位→重试→全量重灌链；缺省形态下贴墙
            // 交 400 兜底网 + 闸二浓缩接管（对照臂形态）。env=0 为对照硬覆盖（设置也不开）。
            // 返回真值=本步已发剪事务，浓缩闸顺延（同 step 不吃二次重铸）。
            const egress = resolveEgress(process.env, this.compactionThreshold);
            // 与 PRESSURE 逃生口互斥（审查 F5）：hatch=旧世界字节级复现契约，两 env 各管各的
            // 对照世界——要"旧世界+出口闸"的第三组合请显式改码，别靠 env 叠乘出第四态。
            let egressPruned = false;
            if (!signal.aborted && egress.enabled && !this.pressureTriggerEnabled) {
                try {
                    const gate = await this.egressGate(agent, signal, incoming, egress.lineRatio);
                    if (gate === 'blocked') {
                        // 剪后仍 ≥ 声明窗：不进入本步请求（宿主 PreStepDecision 硬拒）。但若本步已
                        // claim 了用户消息，reject 会让这条 prompt 永久丢失（宿主 claim 已从 inbox
                        // 移除）——此时绝不 reject，交 400 兜底网，下一轮再剪。
                        if (messages.length > 0) {
                            this.log.warn('[argp-factor-egress] 剪后仍超窗，但本步有用户输入：不硬拒（避免丢 prompt），交 400 兜底');
                        }
                        else {
                            this.log.warn('[argp-factor-egress] pre-step 硬拒：事务后仍超窗，本步不发送');
                            return { kind: 'reject' };
                        }
                    }
                    egressPruned = gate === true;
                }
                catch (e) {
                    this.log.warn('[argp-factor-egress] pre-step 出口闸异常（不阻断本步）: ' + (e instanceof Error ? e.message : String(e)));
                }
            }
            // §9.36 浓缩通道闸二（ctx 闸）：上一请求 usage 已锚、下一请求未发——双闸合取里
            // "总上下文 ≥ windowRatio×声明窗"的把关位（闸一散文线在 condense 内）。
            if (!signal.aborted && !egressPruned) {
                try {
                    await this.condenseGate(agent, signal, incoming);
                }
                catch (e) {
                    this.log.warn('[argp-factor-prose] pre-step ctx 闸异常（不阻断本步）: ' + (e instanceof Error ? e.message : String(e)));
                }
            }
            void step;
            return next();
        });
    }
    /**
     * A7（问题 3 修订）：session 绑定统一入口——setSession / agent/pre-step / compactIfNeeded 首次绑定
     * 都走这里。绑定后若 records 为空且日志含 compaction/start 事件（resume 场景：账目丢失仅日志在），
     * 懒触发 rebuildLedgerFromLog() 自动重建；幂等由 rebuiltCompactionIds 去重保证。
     */
    bindSession(session) {
        bindSession(this, session);
        // 2026-11-13 R2 实锤：headless 每轮新起 dsh 进程 resume，历史 request/context 不在
        // 活事件流里——只靠 session/event 写 WeakMap 会让 §9.37 出口闸读到 0 直接放行。
        this.restoreDeclaredWindow(session);
    }
    setSession(session) {
        this.bindSession(session);
    }
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
    restoreUsageAnchor(session) {
        let restored = false;
        const st = this.stateOf(session);
        // 内存桶已有锚点（本进程上一次绑定/事务后估算）⇒ 不动：日志里的最后一条 usage
        // 可能早于本进程的压缩事务，盲目回填会把"压缩后 retain 位"重置回压缩前大值，
        // 出口闸随后误判并触发整段重剪（多会话/子代理切换焦点时必现）。冷 resume
        // （新进程，桶为空）才需要从日志回填。
        if (st.lastRealAnchorSeq >= 0 || st.lastRealPromptTokens > 0)
            return;
        try {
            const events = sessionEvents(session);
            for (let i = events.length - 1; i >= 0; i -= 1) {
                const event = events[i];
                if (event?.type !== 'assistant/message')
                    continue;
                const usage = event.data?.usage;
                if (usage === undefined || typeof usage.inputTokens !== 'number')
                    continue;
                const read = typeof usage.cacheReadTokens === 'number' ? usage.cacheReadTokens : 0;
                const write = typeof usage.cacheWriteTokens === 'number' ? usage.cacheWriteTokens : 0;
                st.lastRealPromptTokens = usage.inputTokens + read + write;
                st.lastRealAnchorSeq = typeof event.seq === 'number' ? event.seq : -1;
                restored = true;
                break;
            }
        }
        catch {
            restored = false;
        }
        if (!restored) {
            // 新会话 / 日志无 usage：清掉可能属于上一个 session 的失效锚点。
            st.lastRealPromptTokens = 0;
            st.lastRealAnchorSeq = -1;
            return;
        }
        this.log.info('[argp-engine] usage anchor restored from log: real prompt='
            + st.lastRealPromptTokens + ' tok at seq=' + st.lastRealAnchorSeq);
    }
    /**
     * 声明窗锚点回填（2026-11-13，R2 修后世界实锤）：`declaredContextWindows` 原先**只**
     * 由活 `session/event` 的 `request/context` 写入。headless 驱动每轮新起一个 dsh 子进程
     * （`--session-id` resume），历史 `request/context` 不会重放到新进程的 WeakMap ⇒
     * `egressGate` 读到 `declaredWindow=0` 直接 `return false`，§9.37 出口闸在 T02 起就死了，
     * 400→剪→重试→全量重灌链原样复活（cand-shadow-fix T13/T18/T2x 共 4 笔死流实锤）。
     * 与 `restoreUsageAnchor` 同模式：反向扫日志取最后一条声明值；每 session/进程只扫一次
     * （WeakMap 已有值即早退；活事件更新不受影响）。
     */
    restoreDeclaredWindow(session) {
        if ((this.declaredContextWindows.get(session) ?? 0) > 0)
            return;
        try {
            const events = sessionEvents(session);
            for (let i = events.length - 1; i >= 0; i -= 1) {
                const event = events[i];
                if (event?.type !== 'request/context')
                    continue;
                const declared = event.data?.contextWindow;
                if (typeof declared === 'number' && declared > 0) {
                    this.declaredContextWindows.set(session, declared);
                    this.log.info('[argp-engine] declared contextWindow restored from log: ' + declared);
                    return;
                }
            }
        }
        catch {
            // 日志不可读：保持未知，宁缺勿错交给 400 兜底网（与 resolveScaledBudgets 同纪律）。
        }
    }
    /**
     * 增量维护被遮蔽 surface seq 集合（账本语义见 recall.ts）。
     */
    shadowedSeqsOf(session) {
        return shadowedSeqsOf(this, session);
    }
    /**
     * 原子化（§4.1）：只投影 surface 节点；U/X/R/A 四类（tool/call 不进 surface，无 T 类）。
     *
     * node 0 保护（2026-09-10，dsh 0.1.5 起）：宿主把 system prompt 表示为 surface node 0 的
     * `system/message`，并在 surface.ts `assertSystemHeadRewrite` 里硬性保护——任何覆盖 node 0 的
     * replace 必须是"恰好覆盖该单节点的 system/message"，否则 throw。
     * 本投影**静默跳过** system/message，因此 node 0 永远不会进入 ARGP 的剪枝区间。
     */
    atomize(session) {
        return atomize(this, session);
    }
    /** 测量当前上下文 token。优先「真实 usage 锚点 + 增量估算」（2026-08-23，
     *  替代 tokenMeter chars/4 低估导致的迟触发/窗口保护失效）；无锚点才回退
     *  dsh tokenMeter / 配置函数 / 字符估算。source 标注估计来源。
     *  `extraTokens`：本步**已 claim 但尚未落盘**的 user 消息估值。轮初它既不在
     *  surface 里、也不在锚点覆盖范围内，漏掉就等于漏算"这一轮的启动量"——而用户恰恰
     *  常在轮初粘贴大段文本。
     */
    measureTokens(session, extraTokens = 0, legacyPlain = false) {
        return measureTokens(this, session, extraTokens, legacyPlain);
    }
    /**
     * 剪后投影（审查 P1-1）：取 max(锚点估算, tokenMeter 总量)。prune-tx 事务后锚点被
     * 重置为 `visibleChars/charsPerToken`（不含 system + tool schemas），单用它会低估算；
     * tokenMeter 在真会话可用时是含 tools/system 的权威值。
     */
    postPruneProjection(session, extraTokens = 0) {
        const m = this.measureTokens(session, extraTokens);
        let total = m.contextTokens;
        if (this.tokenMeter !== undefined) {
            try {
                total = Math.max(total, this.tokenMeter.measure(session).totalTokens + extraTokens);
            }
            catch { /* tokenMeter 不可用：保持锚点估算 */ }
        }
        return total;
    }
    /**
     * 本步已 claiming（尚未落盘进 surface）的 user 消息估值（Issue5 起为 CJK 加权：
     * nonCjk/3.5 + cjk/κ）。与 `measureTokens` 的增量口径同基准，可直接相加；
     * 非 CJK 输入 = chars/3.5 逐字等价。
     */
    incomingTokens(messages) {
        let chars = 0;
        let cjk = 0;
        for (const message of messages) {
            const content = message.content;
            if (!Array.isArray(content))
                continue;
            for (const block of content) {
                const b = block;
                if (typeof b.text === 'string') {
                    chars += b.text.length;
                    cjk += countCjkChars(b.text);
                }
                if (!Array.isArray(b.content))
                    continue;
                for (const inner of b.content) {
                    const t = inner.text;
                    if (typeof t === 'string') {
                        chars += t.length;
                        cjk += countCjkChars(t);
                    }
                }
            }
        }
        return chars === 0 ? 0 : Math.ceil(estTokensFromStats(chars, cjk));
    }
    /**
     * recall 预算：单次结果与累计结果都按窗口比例截断（窗口取最近解析的有效预算）。
     * 预算耗尽时显式说明剩余额度与何时恢复；每笔 compaction 事务成功后归零
     * （见 prune-tx 事务尾）。
     */
    budgetRecallText(session, text) {
        return budgetRecallText(this, session, text);
    }
    /**
     * 预算解析：显式配置用显式值；否则从适配器声明的 contextWindow 按比例推导——
     *  windowTokens = contextWindow × windowRatio（默认 0.8），retainTokens = windowTokens × retainRatio（默认 0.2）。
     *  上下文容量由其他插件（模型适配器声明）决定，本引擎不硬编码。
     *  解析顺序：1) session.requestContext()（request/context 事件，真会话最可靠）；
     *           2) llm.resolveModelInfo(provider, model)；3) 静态默认值。
     */
    async resolveScaledBudgets(agent) {
        return resolveScaledBudgets(this, agent);
    }
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
    activePresetOf(session) {
        // 经 ctx.get() 读取（reflect 层"无需 inject"的读法）：直接属性访问 ctx.sessionProjections
        // 会抛 "cannot get property … without inject"（本插件 static inject 只声明 tools）。
        // sessionProjections 是 dsh-base 的核心服务（恒在）；服务缺失时 get() 返回 undefined，安全降级。
        const projections = this.ctx.get?.('sessionProjections');
        if (projections === undefined)
            return undefined;
        try {
            return projections.stateOf(session, 'agentPreset');
        }
        catch {
            return undefined;
        }
    }
    /**
     * 会话是否运行在 skipPresets 列出的 preset 下（= ARGP 不生效，保留原生态）。
     * 无 preset 信息（undefined/null）时不跳过。命中时记一次日志（每会话一次）。
     */
    skipIfPreset(session) {
        if (this.skipPresets.length === 0)
            return false;
        const preset = this.activePresetOf(session);
        if (preset === undefined || preset === null)
            return false;
        if (!this.skipPresets.includes(preset))
            return false;
        if (!this.skipLogged.has(session)) {
            this.skipLogged.add(session);
            this.log.info('[argp-engine] session runs under preset "' + preset + '" (in skipPresets); ARGP compaction disabled for this session (stock behavior)');
        }
        return true;
    }
    /**
     * §9.36 浓缩通道闸二（ctx 闸；用户裁定 2026-11-13：检查点可在发送之后=usage 账单锚）：
     * pre-step 位（上一请求 usage 已落锚、下一请求未发）测得总上下文 ≥ 触发线
     * （windowRatio×声明窗，缺省 0.8）⇒ 驱一发清扫式浓缩（prose.condense 内查闸一）。
     * 锚点健康前提（H6）：source='anchored'（usage 真锚；断锚退 chars 估=禁触发破坏性
     * 改写，宁缺勿错）+ 声明窗已知。手动 compactNow 免本闸（手动语义保留）。
     * 0.2×声明窗留给摘要输出（输出预算=summaryMaxTokensOut(声明窗)）。
     */
    async condenseGate(agent, signal, incomingTokens) {
        const session = agent.session;
        const { windowTokens, declaredKnown } = await this.resolveScaledBudgets(agent);
        this.bindSession(session); // D2：await 窗口内焦点可能换装——回绑后再读锚点
        if (!declaredKnown || windowTokens <= 0 || signal.aborted)
            return;
        const measurement = this.measureTokens(session, incomingTokens);
        if (measurement.source !== 'anchored')
            return;
        if (measurement.contextTokens < windowTokens)
            return;
        this.log.info('[argp-factor-prose] ctx 闸过线: contextTokens=' + measurement.contextTokens
            + ' ≥ ' + windowTokens + '（声明窗=' + (this.declaredContextWindows.get(session) ?? '?') + '），清扫式浓缩');
        const res = await this.prose.condense(session, agent.options, windowTokens, signal, this.effectiveWindowFor(session));
        if (res !== null)
            await this.refreshFactorNoteSafe(agent); // P6-② note 纪律：变化时机=压缩时机（未发射不写 note）
    }
    /**
     * §9.37 出口闸（缺省关；开启面 = 设置「压缩阈值」compactionThreshold>0 或 env
     * ARGP_FACTOR_EGRESS=1；env=0 为对照硬覆盖）——2026-11-15 用户裁定改判：
     * 对照臂形态即缺省形态，贴墙由 400 兜底网 + §9.36 闸二浓缩接管；本闸降级为
     * 评测/对照/防死流开关，它根除的链见 P6-④ 贴墙账（T24-J R2 实锤）：
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
    get compactionThreshold() {
        const raw = this.rawConfig.compactionThreshold;
        if (typeof raw === 'number')
            return raw;
        const get = raw?.get;
        return typeof get === 'function' ? get.call(raw) : 0;
    }
    /**
     * §A 有效上下文窗：`min(声明窗, observedCap)`；任一未知则取已知的那个。
     * 只有当 400 报文报出真实上限（observedCap）时才会 < 声明窗，进而修死锁；
     * observedCap 未知 ⇒ 等于声明窗（默认行为字节不变）。
     */
    effectiveWindowFor(session) {
        const declared = this.declaredContextWindows.get(session) ?? 0;
        const observed = this.observedContextWindows.get(session) ?? 0;
        if (declared > 0 && observed > 0)
            return Math.min(declared, observed);
        return Math.max(declared, observed);
    }
    /** §A budget.ts 钩子：本会话已学到的 observedCap（未学到 ⇒ undefined，budget 不封顶）。 */
    observedContextWindow(session) {
        const v = this.observedContextWindows.get(session);
        return v !== undefined && v > 0 ? v : undefined;
    }
    /**
     * Issue4（2026-11-17，design-2.1.0-batch §2）：B-6 盲区风险摘要——**只读、近似诊断**。
     * 触发 = 不可剪 live 估算 ≥ windowRatio × 声明窗：可剪面全剪光后仍会逼近声明窗，
     * 宿主组装层将无痕截断最旧 live 节点（README 已知限制 B-6，根治在 dsh 侧）。
     * 近似口径（台账 §6-R4 裁定的落点）：不可剪 = 非 R 原子（U/A/X/system 可见面）
     * + 未闭合轮 R；焦点/sticky/召回对等硬保护位**未计**（方向=低估不可剪量=漏报风险，
     * 卡面文案带「近似」）。**禁走 `FactorEngine.decide`**——其 observe() 有
     * ledger/观察游标/快照采样副作用（factor/engine.ts:459-496），卡面渲染不得污染压缩状态。
     */
    b6RiskSummary(session) {
        const declared = this.effectiveWindowFor(session);
        if (declared <= 0)
            return { declaredWindow: 0, nonPrunableTokens: 0, ratioPct: 0, warn: false };
        const openTurn = detectOpenTurn(session);
        const atoms = atomize(this, session);
        let chars = 0;
        let cjk = 0;
        for (const a of atoms) {
            if (a.type === 'R' && (openTurn === null || a.turn < openTurn))
                continue;
            chars += a.text.length;
            cjk += countCjkChars(a.text);
        }
        const tokens = Math.ceil(estTokensFromStats(chars, cjk));
        return {
            declaredWindow: declared,
            nonPrunableTokens: tokens,
            ratioPct: Math.round((tokens / declared) * 100),
            warn: tokens >= declared * this.windowRatio,
        };
    }
    /**
     * live surface 样本混合密度（Issue5）：token→chars 反向换算（deficit→chars、
     * /argp 卡面历史字符数换算）共用口径。非 CJK-only 样本精确回 charsPerToken
     * （等价锁，见 budget.liveBlendCharsPerToken）。
     */
    liveCharsPerToken(session) {
        return liveBlendCharsPerToken(session, this.charsPerToken);
    }
    async egressGate(agent, signal, incomingTokens, lineRatio = null) {
        const session = agent.session;
        if (signal.aborted)
            return false;
        this.bindSession(session); // D2：同钩子内 factorPressure（逃生口开时）的 await 窗口可能已换桶——回绑再测量
        let declaredWindow = this.declaredContextWindows.get(session) ?? 0;
        if (declaredWindow <= 0) {
            // 冷 resume 第二道兜底（2026-11-13 R2 实锤）：历史日志缺失/裁剪时，宿主
            // requestContext() 仍持有权威声明值；拿到即回填，避免闸再次失明。
            const reqCtx = session.requestContext?.();
            if (reqCtx?.contextWindow !== undefined && reqCtx.contextWindow > 0) {
                declaredWindow = reqCtx.contextWindow;
                this.declaredContextWindows.set(session, declaredWindow);
            }
        }
        if (declaredWindow <= 0)
            return false; // 声明窗未知：宁缺勿错，交给 400 兜底网
        // §A：若学到真实上限，压力线按有效窗（min 声明/真实）计——否则声明>真实时
        // 0.8×声明线永不可达、闸永不触发（死锁）。
        const observedEgress = this.observedContextWindows.get(session) ?? 0;
        if (observedEgress > 0)
            declaredWindow = Math.min(declaredWindow, observedEgress);
        const measurement = this.measureTokens(session, incomingTokens);
        if (measurement.source !== 'anchored')
            return false;
        // 两种线形（resolveEgress）：设置「压缩阈值」比例线（lineRatio 非空）直接取窗×比例，
        // 不做输出预算三源探测；env=1 旧公式线保留三源取 max（预算语义见 docblock 头部）。
        let outputBudget = 0;
        let line;
        if (lineRatio !== null) {
            line = Math.round(declaredWindow * lineRatio);
        }
        else {
            const knownBudgets = [
                agent.options.maxTokens,
                this.requestMaxTokens.get(session),
                await this.modelDefaultMaxTokens(agent), // await 后无 this.rt 裸读（measurement 已定格；compactIfNeeded 自回绑）
            ].filter((n) => typeof n === 'number' && n > 0);
            outputBudget = knownBudgets.length > 0
                ? Math.max(...knownBudgets)
                : Math.floor(declaredWindow * DEFAULT_EGRESS_OUTPUT_RATIO);
            line = declaredWindow - outputBudget - Math.round(declaredWindow * DEFAULT_EGRESS_MARGIN_RATIO);
        }
        if (line <= 0 || measurement.contextTokens < line)
            return false; // 线≤0=输出预算吃满窗：闸自缚，400 网接（审查 F7 入账）
        this.log.info('[argp-factor-egress] 出口闸过线·先剪后发: projected=' + measurement.contextTokens
            + ' ≥ line=' + line + '（声明窗=' + declaredWindow + (lineRatio !== null ? '，压缩阈值=' + lineRatio : '，输出预算=' + outputBudget) + '）');
        const result = await this.compactIfNeeded(agent, 'pressure', signal, incomingTokens);
        // 2026-11-13 硬校验（长跑 T34 实锤）：事务后二次测量；仍 ≥ 声明窗 ⇒ 拒绝发送
        // （pre-step 返回 {kind:'reject'}），绝不把注定 400 的请求发出去。组剪正常时应远低于窗。
        const after = this.postPruneProjection(session, incomingTokens);
        if (after >= declaredWindow) {
            this.log.warn('[argp-factor-egress] 剪后仍超窗：projected=' + after
                + ' ≥ 声明窗=' + declaredWindow + '；本步拒绝发送（不再发注定 400 的请求）');
            return 'blocked';
        }
        if (after >= line) {
            this.log.info('[argp-factor-egress] 剪后仍在线上但未超窗：projected=' + after
                + ' ≥ line=' + line + '（估计误差；本步放行，下轮再剪）');
        }
        return result !== null;
    }
    /** §9.37 出口闸·输出预算档③：模型注册面的缺省输出预算（每会话探一次，0=已探无）。 */
    async modelDefaultMaxTokens(agent) {
        const session = agent.session;
        const cached = this.modelDefaultMaxTokensCache.get(session);
        if (cached !== undefined)
            return cached > 0 ? cached : undefined;
        const provider = agent.options.provider;
        const model = agent.options.model;
        if (provider === undefined || model === undefined)
            return undefined; // 无路由信息：不探也不缓存（拿到路由的会话再探）
        const llm = this.ctx.get('llm');
        if (llm?.resolveModelInfo === undefined) {
            this.modelDefaultMaxTokensCache.set(session, 0);
            return undefined;
        }
        const ac = new AbortController();
        const timer = setTimeout(() => { ac.abort(); }, 5000); // P1.3 同口径：hang 转 rejection，pre-step 绝不被探测卡死
        try {
            const info = await llm.resolveModelInfo(provider, model, ac.signal);
            const declared = info?.defaultMaxTokens;
            this.modelDefaultMaxTokensCache.set(session, typeof declared === 'number' && declared > 0 ? declared : 0);
        }
        catch {
            this.modelDefaultMaxTokensCache.set(session, 0);
        }
        finally {
            clearTimeout(timer);
        }
        const v = this.modelDefaultMaxTokensCache.get(session);
        return v !== undefined && v > 0 ? v : undefined;
    }
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
    nativePruneToolResults(session) {
        const pruner = this.ctx.get('toolResultPruner');
        if (pruner?.pruneSession === undefined) {
            if (!this.nativePrunerMissingLogged.has(session)) {
                this.nativePrunerMissingLogged.add(session);
                this.log.info('[argp-factor-native-prune] toolResultPruner 服务未挂载，跳过全局预剪');
            }
            return { pruned: 0, charsRemoved: 0 };
        }
        if (detectOpenTurn(session) === null) {
            this.log.info('[argp-factor-native-prune] 无 open turn，跳过 tool/result 全局预剪');
            return { pruned: 0, charsRemoved: 0 };
        }
        try {
            const result = pruner.pruneSession(session);
            const pruned = Array.isArray(result?.pruned) ? result.pruned.length : 0;
            const charsRemoved = typeof result?.charsRemoved === 'number' ? result.charsRemoved : 0;
            if (pruned > 0) {
                this.log.info('[argp-factor-native-prune] 全局预剪 ' + pruned + ' 枚 / ' + charsRemoved + ' chars');
            }
            return { pruned, charsRemoved };
        }
        catch (e) {
            this.log.warn('[argp-factor-native-prune] 全局预剪异常（不阻断，继续 factor 组剪）：'
                + (e instanceof Error ? e.message : String(e)));
            return { pruned: 0, charsRemoved: 0 };
        }
    }
    async compactIfNeeded(agent, trigger, signal, 
    /** 本步已 claim 未落盘的 user 消息估值（轮初专用；其余调用点省略）。 */
    incomingTokens = 0) {
        const session = agent.session;
        if (signal.aborted)
            return null; // 进入即已取消：不动 surface，调用方各自的 aborted 分支接管
        if (this.skipIfPreset(session))
            return null;
        this.bindSession(session); // A7（问题 3）：compactIfNeeded 也走统一绑定（含账目懒重建）
        const { windowTokens, retainTokens, declaredKnown } = await this.resolveScaledBudgets(agent);
        // D2（beta.1 评审）：上面这个 await 的窗口内，其他会话的 pre-step 可能已把焦点桶
        // （this.rt）换装——恢复后必须先回绑本会话再继续，否则 measureTokens 的锚点
        // 等 getter 层字段全部落到别人的桶（多会话串台）。回绑幂等（焦点未动即早退）。
        this.bindSession(session);
        signal.throwIfAborted(); // 取消优先于任何事务写点（错误分类：abort 不属于可重试类别）
        const thresholdTokens = windowTokens - this.reserveTokens;
        // thresholdTokens 只用于压力口径的早退；context-overflow 是 provider 已确认超窗，
        // reserve 再大也必须尝试事务（否则 400 恢复被静默禁用，请求原样失败）。
        if (thresholdTokens <= 0 && trigger !== 'context-overflow') {
            this.log.info('[argp-engine] pressure check: reserveTokens exceeds windowTokens, skip');
            return null;
        }
        let measurement = this.measureTokens(session, incomingTokens);
        // ── factor 分发（P6-④ 触发收敛后口径）：本方法只被两信号驱进
        // （手动 compactNow / request-error 钩子的 context-overflow）——pre-step 估算驱动已
        // 退役（factorPressure 仅存于 ARGP_FACTOR_PRESSURE=1 逃生口）。事务内动作序：
        // A+R 组剪（0-LLM，整组归零；deficit = 真实口径 − retain）→ 原生 pruner 二次收紧
        // 剩余大 R（0-LLM，head/middle/tail；焦点/open 轮里组剪动不了的 read）→ 散文浓缩
        // （(sys+散文)÷声明窗 > 50% 才动，one-shot 原生式，factor 臂唯一 LLM 摘要通路）→
        // 词表 note 事务收尾（P6-② 违规点整改：note 变化时机 = 压缩时机）。
        if (trigger === 'context-overflow' || declaredKnown) {
            // 2026-11-14 用户裁定：先组剪、后 pruner。反序（pruner 先切）会把大 R 变成派生
            // 克隆，组剪随后按 root 建账认不到克隆，整组反而驱逐不了，留下永久配重。
            let pruned = null;
            const deficit = measurement.contextTokens - retainTokens;
            if (deficit > 0) {
                // Issue5：deficit→chars 按 live 面样本混合密度（CJK 重的面同额 token 只需更少字符）
                pruned = this.factor.compactIfNeeded(session, Math.floor(deficit * this.liveCharsPerToken(session)));
            }
            let native = { pruned: 0, charsRemoved: 0 };
            if (trigger === 'context-overflow' || measurement.contextTokens > retainTokens) {
                native = this.nativePruneToolResults(session);
            }
            if (native.pruned > 0) {
                this.log.info('[argp-factor] 同笔压缩：组剪目标 ' + Math.max(0, deficit) + ' tok → native pruner 二次收紧 '
                    + native.pruned + ' 枚 / ' + native.charsRemoved + ' chars');
            }
            let proseResult = null;
            // §9.36 闸二（ctx ≥ windowRatio×声明窗）契约="由调用点保证"：overflow 天然满足
            // （provider 已拒收）；'pressure' 现由 §9.37 出口闸驱进且线可低至任意 >0（设置
            // 压缩阈值比例线）或 ≈0.73×窗（env=1 旧公式线）——闸二必须在此补检，LLM 浓缩链
            // 不得被自动通路提前触达（审查 F2；手动 compactNow 免闸二不受影响）。
            const proseGateOk = trigger === 'context-overflow' || measurement.contextTokens >= windowTokens;
            if (declaredKnown && proseGateOk) {
                try {
                    proseResult = await this.prose.condense(session, agent.options, windowTokens, signal, this.effectiveWindowFor(session));
                }
                catch (e) {
                    this.log.warn('[argp-factor-prose] 散文浓缩异常（本轮不处置）：' + (e instanceof Error ? e.message : String(e)));
                }
            }
            // note 只在**真有事务**时刷新：空转（无可剪面且无可浓缩段）也 replace note 会
            // 让 surface.replaceGeneration 增长——400 恢复钩子会把它误判成"已减量"而重发
            // 同一超窗请求（并且违背 note 变化时机=压缩时机的前缀纪律）。
            if (proseResult !== null || pruned !== null)
                await this.refreshFactorNoteSafe(agent);
            return proseResult ?? pruned;
        }
        return null;
    }
    async compactNow(agent, signal, sourceCommandId) {
        if (this.skipIfPreset(agent.session))
            return null;
        // factor 手动压缩（P6-④：手动 compact 是两信号之一）：全量剪（能剪多少剪多少——
        // 目标 = 全部可剪面，硬保护自然兜底）→ 散文浓缩 → 词表 note 事务收尾。与
        // compactIfNeeded factor 分发同一动作序；sourceCommandId 经 host 透传三事件
        // （prune-tx 契约），事务后复位防串账。
        if (signal.aborted)
            return null;
        this.bindSession(agent.session);
        this.compactSourceCommandId = sourceCommandId;
        try {
            // 手动压缩必须走 runMaintenance（宿主契约：idle 任务，活跃 turn 中调用会同步
            // throw"already active"）——旧实现经 session-lifecycle.compactNow 有这一层，
            // factor 直调后丢了；直接改 surface 会与驱动轮交错。
            const run = async (agentSignal) => {
                const opSignal = AbortSignal.any([signal, agentSignal]);
                opSignal.throwIfAborted();
                // 同一动作序（2026-11-14 用户裁定）：factor 组剪（手动=全量，目标 MAX）→
                // 原生 pruner 二次收紧剩余大 R。宿主 manual compact 走 idle maintenance，
                // 通常无 open turn ⇒ pruner no-op。
                const pruned = this.factor.compactIfNeeded(agent.session, Number.MAX_SAFE_INTEGER);
                const native = this.nativePruneToolResults(agent.session);
                if (native.pruned > 0) {
                    this.log.info('[argp-factor] 手动压缩：native pruner 二次收紧 ' + native.pruned + ' 枚 / ' + native.charsRemoved + ' chars');
                }
                opSignal.throwIfAborted();
                let proseResult = null;
                const { windowTokens, declaredKnown } = await this.resolveScaledBudgets(agent);
                opSignal.throwIfAborted(); // await 窗口内被取消：按契约抛 AbortError，不吞成"成功"
                this.bindSession(agent.session); // D2：await 窗口内焦点可能换装——回绑再写 surface
                if (declaredKnown) {
                    try {
                        proseResult = await this.prose.condense(agent.session, agent.options, windowTokens, opSignal, this.effectiveWindowFor(agent.session));
                    }
                    catch (e) {
                        if (opSignal.aborted)
                            throw e; // 取消不是"本轮不处置"：必须向上传播
                        this.log.warn('[argp-factor-prose] 手动散文浓缩异常（本轮不处置）：' + (e instanceof Error ? e.message : String(e)));
                    }
                }
                const result = proseResult ?? pruned;
                if (result !== null)
                    await this.refreshFactorNoteSafe(agent);
                return result;
            };
            return typeof agent.runMaintenance === 'function'
                ? await agent.runMaintenance(run)
                : await run(signal);
        }
        finally {
            this.compactSourceCommandId = undefined;
        }
    }
    async compactRegion(_start, _end, _agent, _signal) {
        // factor 臂只剪 R（A 永不入剪枝区间），没有"按区间剪"的语义。
        throw new Error('[argp-factor] 2.0 factor-only 引擎不支持按区间手动压缩（请在 UI 用 /compact 全量压缩）');
    }
    /**
     * 词表 note 迁入压缩事务收尾（P6-② 违规点整改，note 前缀炸弹案施工①）：note 变化时机
     * = 压缩时机——"缓存断点频率=压缩频率"不变量的 note 特化（T-3 定量证实每步一改一炸）。
     * steer 仅首注需要（更新走单节点 replace，指针以标记回溯为准）；本入口拿不到 steer
     * （CompactionAgentContext 无该成员）时首注跳过——下个有 steer 的压缩机会自然重试。
     */
    async refreshFactorNoteSafe(agent) {
        const steerFn = agent.steer;
        try {
            await this.factor.refreshVocabularyNote(agent.session, text => {
                if (steerFn === undefined)
                    throw new Error('steer unavailable at this compaction entry');
                return steerFn(createUserMessage({
                    content: [{ type: 'text', text }],
                    // auto-continue 同款 notice 形态：宿主按 X 归类（进请求、不参剪、UI 渲染 notice）。
                    source: { kind: 'argp', form: 'notice', summary: 'factor vocabulary (pruned labels; recall_history keys)' },
                }));
            });
        }
        catch (e) {
            this.log.warn('[argp-factor] 词表 note 刷新失败（压缩事务收尾，本轮跳过）：' + (e instanceof Error ? e.message : String(e)));
        }
    }
    /**
     * factor 臂轮内维护（**仅 ARGP_FACTOR_PRESSURE=1 逃生口**，P6-④ 前旧世界复现）：
     * 先词表 note（旧时机 = 每 pre-step），后压力剪（估算驱动）。缺省路径（收敛后）不进本函数
     * ——note 已迁压缩事务收尾（refreshFactorNoteSafe）。
     */
    async factorPressure(agent, incomingTokens = 0) {
        // 词表 note 吞错自隔离：注入失败丢的是提示，不能把同钩子的压力剪一并带走。
        try {
            await this.factor.refreshVocabularyNote(agent.session, text => agent.steer(createUserMessage({
                content: [{ type: 'text', text }],
                // auto-continue 同款 notice 形态：宿主按 X 归类（进请求、不参剪、UI 渲染 notice）。
                source: { kind: 'argp', form: 'notice', summary: 'factor vocabulary (pruned labels; recall_history keys)' },
            })));
        }
        catch (e) {
            this.log.warn('[argp-factor] 词表 note 刷新失败（本轮跳过）：' + (e instanceof Error ? e.message : String(e)));
        }
        const { retainTokens, declaredKnown } = await this.resolveScaledBudgets(agent);
        if (!declaredKnown)
            return;
        this.bindSession(agent.session); // D2：上方 await 窗口内焦点可能被其他会话的装配换桶——回绑后再测量
        const m = this.measureTokens(agent.session, incomingTokens, true);
        const deficit = m.contextTokens - retainTokens;
        if (deficit <= 0)
            return;
        // R 剪清不动（可剪面被硬保护占满）即本轮终态：无摘要兜底——factor 臂唯一 LLM
        // 摘要通路是散文浓缩链（prose-condenser），只在压缩事务内被调（触发收敛口径）。
        // ⚠️ Issue5 显式不改 + ADV-1 裁定（2026-11-17）：本函数=ARGP_FACTOR_PRESSURE=1
        // 逃生口的旧世界字节级复现契约——估算分量经 legacyPlain=true 冻结在 1.x 朴素密度
        // （measureTokens 上游已全局 CJK 加权，不 pin 则 CJK 会话 deficit 失真 ≈2×），
        // 此处再乘裸 charsPerToken 同为冻结面。勿"顺手"加权。
        this.factor.compactIfNeeded(agent.session, Math.floor(deficit * this.charsPerToken));
    }
    /**
     * A7 事务账目重建：resume 时从 append-only 日志扫描 compaction/start、compaction/prune、
     * compaction/end 事件重建 records/prunedNodeIndex/shadowedSeqsOf 状态；无 end 的 start 记 warn。
     * 不引入 WAL——日志本身即账目。幂等：已重建过的 compactionId 跳过（rebuiltCompactionIds 去重），
     * 使「setSession 自动重建」与「测试显式清空 records 后再重建」两种路径都安全。
     */
    rebuildLedgerFromLog() {
        rebuildLedgerFromLog(this);
    }
}
export default ArgpEngine;
