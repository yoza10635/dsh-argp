import { CompactionEngine } from '@deepseek-ai/dsh-compaction';
import { CONTEXT_WINDOW_EXCEEDED_CODE, createUserMessage } from '@deepseek-ai/dsh-llm';
import { asSeq, detectOpenTurn, sessionEvents, turnOf } from './log-access.js';
// eventText 已迁 log-access（P5 Wave 3 第 1 步）；此处转发以维持既有公共 API 与测试 import。
export { eventText } from './log-access.js';
import { EDGE_WEIGHTS } from './argp-types.js';
export { EDGE_WEIGHTS } from './argp-types.js';
import { DEFAULT_WINDOW_TOKENS } from './constants.js';
import { pushBounded } from './telemetry.js';
import { cleanShippedPresets } from './preset-cleaner.js';
// 建图侧模块（P5 Wave 3 第 4 步）：atomize/buildGraph/findVersionDuplicates/extractCites/
// classifyUserMessage/looksAskText + 纯辅助。本地使用 + 转发维持既有公共 API。
import { looksAskText, extractCites, atomize, buildGraph, findVersionDuplicates } from './graph-build.js';
export { looksAskText, classifyUserMessage, extractCites } from './graph-build.js';
// 预算/度量模块（P5 Wave 3 第 4 步）：scaleBudgets/resolveScaledBudgets/measureTokens/
// acquireTokenMeter/visibleChars。本地使用 + 转发维持既有公共 API。
import { visibleChars, resolveScaledBudgets, measureTokens } from './budget.js';
export { scaleBudgets } from './budget.js';
// 召回模块（P5 Wave 3 第 4 步）：shadowedSeqsOf/catalogText/recallQuery/recall/
// recallAnyState/nodeState/latestTurnOf/noteRecallHit/budgetRecallText。本地使用。
import { shadowedSeqsOf, catalogText, recallQuery, recall, recallAnyState, nodeState, latestTurnOf, latestTurnOfSession, noteRecallHit, budgetRecallText } from './recall.js';
// 剪枝选择模块（P5 Wave 3 第 4 步）：isAtomCandidate/isGroupCandidate/sortKey/
// mergeIntervals/buildTombstones/selectClosureToMerge + 共享类型。本地使用 + 转发维持公共 API。
import { isGroupCandidate, sortKey, mergeIntervals, buildTombstones, selectClosureToMerge } from './prune-selection.js';
export { isAtomCandidate, isGroupCandidate, sortKey, mergeIntervals, buildTombstones } from './prune-selection.js';
// 剪枝事务模块（P5 Wave 3 第 4 步）：pruneIntervals/consolidateTombstones/
// compactRegions/selectManualRanges/compactRegion/isMergeableTombstone + GraphPruneRecord。
// 本地使用 + 转发维持公共 API。
import { pruneIntervals, consolidateTombstones, compactRegions, selectManualRanges, compactRegion } from './prune-tx.js';
export { isMergeableTombstone } from './prune-tx.js';
import { registerRecallTools } from './recall-tools.js';
// 会话生命周期 + 构造期装配模块（P5 Wave 3 第 4 步）：normalizeConfig/registerSettings/
// mountPeratomStack + bindSession/rebuildLedgerFromLog/rearmReactive/compactNow。
// 设置页常量（ARG_SETTINGS_KEY/ArgpUserSettingsSchema）随 registerSettings 迁入，此处转发维持公共 API。
import { normalizeConfig, registerSettings, mountPeratomStack, bindSession, rebuildLedgerFromLog, rearmReactive, compactNow } from './session-lifecycle.js';
export { ARG_SETTINGS_KEY, ArgpUserSettingsSchema } from './session-lifecycle.js';
// GraphPruneRecord 已迁 prune-tx（P5 Wave 3 第 4 步）；经上方 import 本地可用、经 re-export 维持公共 API。
/**
 * 流式中 assistant 消息落盘后，立即剥离尾部 {"cites":[...]}（ARGP 引用协议产物），
 * 使其不残留在**模型可见 surface** 上——下一轮请求不再把协议产物当正文重读。
 * 注意（2026-08 修正认知）：Web UI 的人类转录按 dsh 核心设计固定取 append 起源
 * 事件，replace 副本是 model-only（core session surface.ts："replacement copies
 * stay model-only"），因此本剥离**不影响 UI 显示**。UI 侧残留的治理在源头：
 * cites 契约 V5 规定空引用时不产出任何 block（空块对引用图零信息）；非空 block
 * 在 UI 中作为原始回复的一部分可见（模型侧仍被剥离）。仅改写最后一个 text 块；
 * 保留 model/provider/replay 等元数据；将 cites 存入 data.argpCites，以便后续
 * compaction 经 atomize 重建引用图（文本被剥离后 extractCites 取不到 cites）。
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
        // 安全性：shadowedSeqsOf 已改为只认 compaction/prune.shadowedSeqs 权威账本，
        // 不再从 replace 事件推断被遮节点，故本处省略不影响剪枝账目。
    });
}
// extractCites / CiteStats / InferredStats 已迁 graph-build（P5 Wave 3 第 4 步）；
// 经上方 import 本地可用、经 re-export 维持公共 API。
// isAtomCandidate / isGroupCandidate / sortKey / mergeIntervals / buildTombstones /
// PruneInterval / PruneTombstone / PruneState / PrunedNodeInfo 已迁 prune-selection
// （P5 Wave 3 第 4 步）；经上方 import 本地可用、经 re-export 维持公共 API。
export class ArgpGraphEngine extends CompactionEngine {
    static inject = ['tools', 'systemPrompt'];
    windowTokens;
    retainTokens;
    /** true = config 显式给 windowTokens；false = 运行时按 contextWindow × windowRatio 解析。 */
    explicitWindowTokens;
    /** true = config 显式给 retainTokens；false = 运行时按 windowTokens × retainRatio 解析。 */
    explicitRetainTokens;
    /** 最近一次 resolveScaledBudgets 解析出的有效预算（recall 预算等后续同步使用点读取）。 */
    resolvedWindowTokens = DEFAULT_WINDOW_TOKENS;
    reserveTokens;
    tokenMeterFn;
    degradationStrategy;
    turnBasis;
    /**
     * UI 设置页可调旋钮的实时解析值（Settings → Plugins → Configurable → ARGP）。
     * 构造期为 cordis 配置基线；ctx.inject(['settings']) 注册后随用户写入实时更新。
     */
    argpSettings;
    /** settings 源 thunk：ctx.inject(['settings']) 注册后置为 scope.get()，否则回退 cordis 基线。 */
    settingsSource = () => this.argpSettings;
    get windowRatio() { return this.argpSettings.windowRatio; }
    get retainRatio() { return this.argpSettings.retainRatio; }
    /**
     * 守卫读取点统一走 getter：反应式补救（L2）在第 2 次尝试时用 `guardOverride` 临时
     * 放宽守卫（连当前轮一起剪），使"被钳后回线"成为可能；其余时刻恒等于 settings 值。
     */
    guardOverride = null;
    get recencyGuard() { return this.guardOverride?.recencyGuard ?? this.argpSettings.recencyGuard; }
    get turnGuard() { return this.guardOverride?.turnGuard ?? this.argpSettings.turnGuard; }
    get minSpanChars() { return this.argpSettings.minSpanChars; }
    get charsPerToken() { return this.argpSettings.charsPerToken; }
    get maxPasses() { return this.argpSettings.maxPasses; }
    get enableSummarize() { return this.argpSettings.enableSummarize; }
    get sortMode() { return this.argpSettings.sortMode; }
    maxOverflowRetries;
    /** P4 溢出三步第②步回调（undefined = 退化为现役两步）。 */
    onOverflowCompress;
    /** P6 轮内压力压缩回调（undefined = 仅溢出才压 open turn，P6 前行为）。 */
    onPrePressureCompress;
    /** 闭包静止窗 K（A11 参数化，默认 2）。 */
    closureWindowK;
    /** cites 前缀最小长度守卫（A2，默认 2；ASCII ≥4 / CJK ≥2 的换算由守卫实现）。 */
    citeMinPrefixLen;
    /** 版本链重叠归链阈值 θ（A4，默认 0.8）。 */
    overlapTheta;
    /** 版本链重叠归链开关（A4，默认 false）。 */
    enableOverlapChain;
    /** dsh token-meter 服务；真会话中可用时优先用于 token 测量和 contextWindow 探测。 */
    tokenMeter;
    /** 遥测数组容量上限（P4.5：records/recallCalls/recallQueryCalls/closurePrunes/auditWarnings 有界）。 */
    telemetryCap;
    records = [];
    recallCalls = [];
    recallQueryCalls = [];
    citeStats = { aAtoms: 0, declared: 0, resolved: 0, ambiguous: 0, failed: 0 };
    /** §3-3 recall 价值继承：最近一次 recall 的旧原子 seq 与结果 R 原子 seq（建图时用）。 */
    recallSourceSeq = -1;
    recallResultSeq = -1;
    /** 最近一次建图的语义边（判决 G3 读：被引原子是否获得保护）。 */
    lastEdges = [];
    /** 最近一次建图的确定性边（组内 A→R，不参与语义级别排序）。 */
    lastDeterministicEdges = [];
    /** 边价值实验 A₃：注入的 oracle 边（buildGraph 合并用）。 */
    injectEdges = undefined;
    /** 边价值实验 A₁ 离线重放：跳过 cites 边构建（同时隔离推断边，见 config 注释）。 */
    disableCiteEdges = false;
    /** 推断边开关（PROPOSAL-token-ontology 组件 A，v1.2.0；默认启用）。 */
    disableInferredEdges = false;
    /** tombstone 归并阈值（§11.8① 修复；默认 8，0=关闭；见 ArgpGraphConfig.tombstoneMergeMinRun）。 */
    tombstoneMergeMinRun = 8;
    /** 推断边派生参数（config 缺省 6/0.15/8/20；见 InferredEdgeOptions）。 */
    inferredOpts = { minTokenLen: 6, stopwordRatio: 0.15, maxEdgesPerAtom: 8, windowTurns: 20 };
    /** 推断边统计（最近一次 buildGraph 口径）。 */
    inferredStats = { candidates: 0, accepted: 0, skippedDup: 0 };
    /** 最近一次建图的推断边（诊断/测试断言用；同 lastEdges）。 */
    lastInferredEdges = [];
    /** 回复级 cites 义务实际生效值（auto 已解析；构造期定死，运行期不重评）。 */
    citesObligation;
    /** citesObligation 是否 auto 口径（config 未显式给值）。auto 下 section 恒注册、
     *  text 回调随 declarer.armed 动态返回 ''（autoLlm 会话中期武装的时序修复，2026-09-21）。 */
    citesObligationAuto;
    /** P0 双引擎自挂载句柄（config.peratom 缺省时为 null；观测/诊断用）。 */
    peratomStack = null;
    /** 已剪节点目录（seq -> 元数据 + 依赖），供 list_pruned 查询；新事务覆盖旧 seq。 */
    prunedNodeIndex = new Map();
    /** 闭包生命周期剪除记录。 */
    closurePrunes = [];
    nextClosureId = 0;
    /** 闭包最近一次被 recall 回拉的轮次；key = rootSeq（跨 pass 稳定，见 P2 修复注释）。 */
    closureLastRecalled = new Map();
    recallCallsThisTurn = 0;
    recallCharsUsed = 0;
    /**
     * 冻结的 catalog 文本快照：system 块是单条被前缀缓存的消息，块内任何字节变化都会
     * 让整块 KV 失效。故 catalog 不与每步 assemble 联动，而是"全程冻结、仅在真正落剪时刷新一次"
     * （见 bindSession 初值 + pruneIntervals 末尾刷新）。无剪枝的整段对话里 system 块逐字节一致，
     * 前缀缓存全段命中；剪枝本身已改动可见上下文，那一步的缓存失效是必然代价。
     */
    frozenCatalog = null;
    /** context-overflow 恢复：每个 agent 的重试计数（assistant/message 成功或 idle 时重置）。 */
    overflowRetries = new WeakMap();
    /** session → agent 映射，供成功后重置重试计数（agent loop 上下文经 session/event 取不到 agent）。 */
    overflowAgents = new WeakMap();
    /** 最近一次请求的真实 prompt token（usage.inputTokens + cacheReadTokens + cacheWriteTokens，
     *  provider 回报，与 UI ContextMeter 分子同口径）。
     *  pressure check 用它锚定 + 增量估算，替代 tokenMeter 的 chars/4 启发式（低估 30%+，
     *  导致迟触发/窗口保护失效，2026-08-23）。 */
    lastRealPromptTokens = 0;
    /** 声明窗口缓存（session → 适配器声明的 contextWindow，来自 request/context 事件）。
     *  2026-08-28 真环境联调：物理窗口探测（llama.cpp n_ctx=262144）与声明窗口（32000）
     *  在 pre-step 时刻可能错位，声明值缺失时宁可跳过检查也不用物理口径。 */
    declaredContextWindows = new WeakMap();
    /** 锚点：lastRealPromptTokens 已覆盖的 surface 最大 seq（其后新增内容需增量估算）。 */
    lastRealAnchorSeq = -1;
    /** /compact 手动压缩的发起命令 ID（presentation correlation，透传给事务事件）。 */
    compactSourceCommandId = undefined;
    /** A7：账目重建后追加的审计警告（供测试断言/诊断）。 */
    auditWarnings = [];
    /** A7：已重建过的 compactionId 集合（跨 session 重置，保证幂等 + 告警不重复）。 */
    rebuiltCompactionIds = new Set();
    /** L2/L3 反应式：观察到"输出被外部钳制"后置位，由 pre-step（turn 仍在跑）或 turn-stopping（本轮要收）消费。 */
    reactivePending = new WeakMap();
    /** 本次请求声明的输出预算（`agent/request` 捕获；适配器的钳制发生在其后，故这里拿到的是请求值）。 */
    requestMaxTokens = new WeakMap();
    /** 三级触发 ①②③ 开关与旋钮（cordis 配置，不进 UI 设置页）。 */
    midTurnPruneEnabled;
    midTurnTurnGuard;
    /** 兼容别名路径：`midTurnActive: true` ⇒ 轮中用默认 `turnGuard`（1.3.x 语义）。 */
    midTurnLegacyGuard;
    reactiveRetries;
    continuationNotice;
    /** 本 episode（连续被钳）内已用掉的"剪枝 + 续写"次数；出现一次正常输出即清零。 */
    reactiveRescues = new WeakMap();
    session = null;
    shadowedSession = null;
    shadowedSet = new Set();
    shadowedScanned = 0;
    /** 结构化日志门面（构造期自 ctx 捕获）。 */
    log;
    constructor(ctx, config = {}) {
        super(ctx);
        // 结构化日志门面（2026-08-29 review 轻微项）：替换裸 console 直调，日志进宿主
        // 统一管道（ctx.logger 门面；warn/error/info 三级均被 cordis logger 支持）。
        this.log = ctx.logger;
        // P5 Wave 3 第 4 步：构造期装配拆四函数——session-lifecycle.normalizeConfig（字段归一，纯）/
        // registerSettings（UI 设置页 ctx.inject）/ mountPeratomStack（peratom 三管线自挂载 + 派生赋值），
        // 加 recall-tools.registerRecallTools（下方）。副作用次序不变：字段归一 → settings 注册 →
        // peratom 自挂载 → 召回工具注册。字段赋值与 ctx 副作用无交互（settings 回调不读归一字段），
        // 两批字段赋值合并为单一 normalizeConfig 置于 registerSettings 之前，可观测行为不变。
        normalizeConfig(ctx, this, config);
        registerSettings(ctx, this, config);
        mountPeratomStack(ctx, this, config);
        // P5 Wave 3 第 4 步：三个召回工具闭包迁 recall-tools.registerRecallTools（闭包体逐字保留，this → host 窄接口）。
        // 三个 ctx.tools.register 调用次序不变（recall_pruned → list_pruned → recall）。
        registerRecallTools(ctx, this);
        // 压缩/恢复契约（静态部分）：只负责“视图可能被剪 + 必要时用 recall 工具找回”。
        // 本 section 的 text 必须是纯静态（不引用引擎运行时状态）——否则每轮变化会破坏
        // system message 前缀，使 KV/prefix cache 从本位置起全部失效（动态目录见 argp-catalog）。
        ctx.systemPrompt.section({
            name: 'argp-contract',
            order: 150,
            text: () => 'Context compression (ARGP):\n'
                + 'Your visible context is a pruned view of the full conversation. Older parts may be no longer in visible context — either replaced by placeholders like [elided seq=N..M ...], or dropped from the render window without any placeholder. Absence from the visible context never means it was never said.\n'
                + '- Every reply must be self-contained plain text: state facts, conclusions, and content directly in natural language. Never answer by pointing at earlier context items instead of restating the needed content.\n'
                + '- When your answer depends on content that is no longer in visible context, use list_pruned to find the right seq, then call recall_pruned(seq) or recall(query) to recover the full text before answering. Never reconstruct missing facts from memory.\n'
                + '- If a placeholder does not name the seq you need, or the content you need left the context without any placeholder, use list_pruned with fromSeq/toSeq to scan that seq window of the raw log. recall_pruned works on any seq in the log and labels each result with state=shadowed|live|off-surface.',
        });
        // 被剪目录：沉到 system message 尾部（order 9999），使 persona + argp-contract 正文 +
        // argp-cites 等静态 section 构成稳定前缀。
        // 根因修复：原实现把动态 catalog 拼进 order:150 的契约段，导致 system message 前缀每轮变、
        // 缓存从 catalog 处断开（2026-08-22 发现，A 臂测试缓存零命中）。recall 协议不依赖其在 system 靠前。
        // 位置说明（2026-09-10 核实）：本段文本恒为空串（frozenCatalog 首绑即冻成 ''，见 bindSession 与
        // test/argp-graph-engine.test.ts:374/397 断言），故 order 取值对本段的缓存影响实为零——保持 9999
        // 仅为保守不动既有排布。注意 dsh 0.1.5-rc.1 起 HARNESS_SOURCE/WEB_SURFACE/DEPLOYMENT_PERSONA_SUFFIX
        // 被排到 10000/10100/10200，本段不再字面意义上"最后"，但三段均为会话内静态、不构成每轮 cache-miss。
        ctx.systemPrompt.section({
            name: 'argp-catalog',
            order: 9999,
            // 永久冻结快照：catalog 只在首次 bindSession 拍一次（见 bindSession / pruneIntervals 注释），
            // 之后全程回放 frozenCatalog，绝不引用实时状态——否则每步重求值会改 system 块、打穿前缀缓存。
            // fallback 用空串而非 catalogText：即便极端情况下 frozenCatalog 为 null，也返回空而非 live 重算，
            // 保证 system 块恒定。
            text: () => this.frozenCatalog ?? '',
        });
        // 引用输出协议：独立 PromptSection，只负责 cites 格式；recall 行为不在这里要求。
        // 挂载受 citesObligation 门控（auto：declarer 已武装即不注册——边声明走结构化旁路，
        // 回复不再携带 cites 尾，源头消灭 UI 显示泄漏）。协议关闭不影响引擎侧剥离与
        // buildGraph 解析：模型偶发残留的 cites 尾仍被剥离并作为加菜边消费。
        // 2026-09-21 时序修复（autoLlm）：auto 兜底的 declarer 构造期未武装、会话中期
        // 才经 agent/status → rememberRoute 武装，构造期布尔无法预判——auto 口径下
        // section 恒注册，text 回调在 armed 翻转后动态返回 ''；renderPrompt 过滤空
        // section ⇒ system 块不再含协议。armed 单调递增（autoLlm 只赋值不清除）⇒
        // 至多翻转一次，代价 = 一次 system 块 KV 失效（通常发生在首个请求之前，可忽略）。
        // 始终未武装时保持全文（两种边来源不能同时归零）。显式覆盖保持静态语义。
        // V4 措辞（实测，spike 脚本已精简移除）：明示"读了工具结果并作答 = 必须引用该结果"，
        // 比旧版"if used ... append"的被动式显著提升 t-long 类任务下的声明率。
        // V5 措辞（2026-08 修 UI 残留）：空引用时"完全不输出 block"而非写 {"cites":[]}。
        // 原因：dsh 核心的人类转录固定取 append 起源事件（replace 副本 model-only，
        // 见 core session surface.ts "replacement copies stay model-only"），surface
        // 剥离永远改不到 UI 显示；空块对引用图零信息（无入边），只能在源头不产出。
        // 引擎侧对"无块"本就是常态（§4.7），citeStats 对空/无块均不计 declared。
        if (this.citesObligation || this.citesObligationAuto) {
            ctx.systemPrompt.section({
                name: 'argp-cites',
                order: 151,
                text: () => {
                    if (this.citesObligationAuto && this.peratomStack?.declarer?.armed === true)
                        return '';
                    return 'Citation declaration (ARGP):\n'
                        + 'In this session you frequently read files with read_file and answer from their content. EVERY time your final reply is based on a tool result you read, you MUST cite it.\n'
                        + 'When your reply depends on at least one earlier item, append ONE JSON block to the end of your final reply:\n'
                        + '{"cites":[...]}\n'
                        + '- When you answered from a file you read, cite that file\'s tool result: copy verbatim the first 10-20 words of its content.\n'
                        + '- Cite user instructions you followed and earlier assistant claims you built upon too.\n'
                        + '- If your reply used nothing from earlier items, output no block at all — never an empty {"cites":[]} block.\n'
                        + '- Grading (V6): by default a citation is supporting. When the cited item is load-bearing for a chain of decisions (a critical fact your whole answer stands on), you may declare it as: {"cites":[{"t":"<verbatim prefix>","l":"c"}]} — use "s" for supporting and "x" for contextual. Bare strings are treated as supporting.\n'
                        + '- The block goes in the final reply body, never in reasoning. Output nothing after it.';
                },
            });
        }
        ctx.on('session/event', (session, event) => {
            if (event.type === 'turn/start') {
                this.recallCallsThisTurn = 0;
                // 续写阶梯按 turn 重置：**同一 turn 内**的连续被钳逐级放宽守卫（第 2 次起 recency/turn
                // guard 归零），turn 一换就重新拿到完整额度——既保证"连续被钳能升级"，又不会把整条
                // 会话的额度耗在一次事故上，也天然封住"每步都被钳 → 每步白压"的循环。
                this.reactiveRescues.delete(session);
            }
            // L2/L3 反应式信号（1.4.0 引入，1.5.0 扩展到续写）："输出被**外部**钳制"的真信号。
            // `assistant/message.data.stream` 末项 = finish chunk（全 session 实测词表：
            // tool-calls / stop / max-tokens）；`data.usage.outputTokens` 是本步实际输出。
            // 判据：kind === 'max-tokens' **且** outputTokens < 本次请求声明的 maxTokens
            //   ⇒ 输出预算被宿主/适配器啃小（实测 1,911 / 1 / 4,714 vs 请求 32,768）= 容量压力
            //     ⇒ 置位；pre-step 会强制剪（turn 还在跑），turn-stopping 会剪 + steer 续写（本轮要收）；
            //   ⇒ outputTokens ≈ maxTokens 则是模型自己写满预算，不构成上下文压力，不触发。
            // 正常输出（非钳制）⇒ 清零本 episode 的续写阶梯（见 reactiveRescues），
            // 使"连续被钳才升级"成立，而长会话中的偶发钳制各自都能拿到完整的重试额度。
            if (event.type === 'assistant/message') {
                const data = event.data;
                const tail = Array.isArray(data?.stream) ? data.stream[data.stream.length - 1] : undefined;
                const finish = tail?.chunk;
                const output = data?.usage?.outputTokens;
                const budget = this.requestMaxTokens.get(session);
                const clamped = finish?.type === 'finish' && finish.reason?.kind === 'max-tokens'
                    && typeof output === 'number' && typeof budget === 'number' && output < budget;
                if (clamped) {
                    this.reactivePending.set(session, true);
                    this.log.warn('[argp-graph] output clamped by the host: finish=max-tokens with output='
                        + output + ' < requested ' + budget + ' ⇒ prune + continue the same turn');
                }
            }
            // 声明窗口缓存（2026-08-28 真环境联调）：request/context 事件携带适配器声明的
            // contextWindow（settings 模型条目），是权威口径。pre-step 压力检查可能早于首个
            // request/context 事件落账（新会话 turn-1），此缓存使后续检查/重启会话立即拿到
            // 声明值，不再退化为物理窗口探测（llama.cpp 场景 262144 vs 声明 32000，7.7× 口径差）。
            if (event.type === 'request/context') {
                const declared = event.data?.contextWindow;
                if (typeof declared === 'number' && declared > 0) {
                    const previous = this.declaredContextWindows.get(session);
                    if (previous !== undefined && previous !== declared) {
                        this.log.info(`[argp-graph] declared contextWindow changed: ${previous} -> ${declared}`);
                    }
                    this.declaredContextWindows.set(session, declared);
                }
            }
            // 外来压缩事务可见性（2026-08-28 真环境联调）：本插件的 compactionId 一律带
            // `argp-` 前缀；不带前缀的 compaction/start = 其他压缩实现（如原生摘要器）在
            // 本 ctx.compaction 位之外运作——lossy 摘要会先于图剪发生，必须在日志可见。
            if (event.type === 'compaction/start') {
                const cid = event.data?.compactionId;
                if (typeof cid === 'string' && !cid.startsWith('argp-')) {
                    this.log.warn(`[argp-graph] foreign compaction detected (id=${cid}, turn=${turnOf(event) ?? '?'})`
                        + ' — a non-ARGP compaction engine is active; lossy summarization may pre-empt graph pruning');
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
                    this.lastRealPromptTokens = (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
                    if (typeof seq === 'number')
                        this.lastRealAnchorSeq = seq;
                }
                // 一次成功的模型应答 = 溢出恢复序列的终结点：重置该 agent 的重试计数，
                // 即使工具调用让同一 turn 继续（对齐 compaction-basic 的 overflowAgents 模式）。
                const agent = this.overflowAgents.get(session);
                if (agent !== undefined)
                    this.overflowRetries.delete(agent);
            }
            // 流式闭环后立刻剥离尾部 {"cites":[...]} JSON（ARGP 引用协议产物），
            // 使其不残留在模型可见 surface 上（UI 人类转录取 append 原文，不受影响；
            // 空块由契约 V5 在源头不产出）。完全在 dsh-argp 插件内完成，不改官方插件。
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
            if (failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE || signal.aborted)
                return next();
            this.overflowAgents.set(agent.session, agent);
            const retries = this.overflowRetries.get(agent) ?? 0;
            if (retries >= this.maxOverflowRetries)
                return next();
            // P4 溢出三步序列（在现有重试环内，"仍超？"的真信号 = provider 再次溢出事件）：
            //   事件#1（retries=0）→ ① forcePrune(旧内容) → retry
            //   事件#2（retries=1）→ ① 没解决才走到这：② onOverflowCompress（当前轮
            //      per-atom 降熵：U 拆分/大 R extract，顺带补 cites）→ ③ forcePrune → retry
            //   事件#3（retries≥2）→ ③ 也没解决 → 保留原错误（现有行为）
            // retries 是每序列单调计数器（成功应答/idle 才重置），故第②步全序列只跑一次、
            // 且永不空转（① 成功即不再溢出、不再进本钩子）。onOverflowCompress 未注入时
            // 事件#2 直接保留原错误——与现役行为完全一致。
            const session = agent.session;
            const genBefore = session.surface.replaceGeneration;
            const isStepOne = retries < 1;
            // 耗尽判定：事件#3（retries≥2 三步用尽）或未注入 compressor 的事件#2（现役即止）。
            if (!isStepOne && (this.onOverflowCompress === undefined || retries >= 2)) {
                this.log.warn(`[argp-graph] overflow recovery exhausted (retries=${retries}); preserving the original request error`);
                return next();
            }
            // ② per-atom 降熵（仅事件#2；① 成功就不会进到这里，故不空转）。
            // 失败隔离：compressor 抛错只记日志——genBefore 在其前捕获，② 的换代仍计入下方
            // "durable progress" 凭证，不吞 provider 溢出错误。
            if (!isStepOne && this.onOverflowCompress !== undefined) {
                try {
                    await this.onOverflowCompress(session);
                }
                catch (compressError) {
                    const message = compressError instanceof Error ? compressError.message : String(compressError);
                    this.log.warn(`[argp-graph] overflow per-atom compress failed: ${message}; relying on step-3 forcePrune`);
                }
            }
            // ①（事件#1）/ ③（事件#2）forcePrune
            let result;
            try {
                result = await this.compactIfNeeded(agent, 'context-overflow', signal);
            }
            catch (recoveryError) {
                const message = recoveryError instanceof Error ? recoveryError.message : String(recoveryError);
                // 剪枝可能在 summarize 之类后续阶段抛错前已落地（模型无关的确定性占位
                // 替换）；或 ② 已换代。只要 surface 换代了，这次减量就是重试的充分凭证，不丢弃。
                if (!signal.aborted && session.surface.replaceGeneration > genBefore) {
                    this.log.warn(`[argp-graph] overflow prune failed after durable surface progress: ${message}; retrying from the replacement surface`);
                    this.overflowRetries.set(agent, retries + 1);
                    return { kind: 'retry' };
                }
                this.log.warn(`[argp-graph] overflow prune failed: ${message}; ${signal.aborted ? 'cancellation prevents retry' : 'preserving the original request error'}`);
                return next();
            }
            if (signal.aborted || session.surface.replaceGeneration <= genBefore)
                return next();
            if (result !== null) {
                this.log.info(`[argp-graph] context-overflow step-${isStepOne ? 1 : 3} prune: shadowed ${result.shadowedSeqs.length} surface nodes `
                    + `(seqs ${result.shadowedRange.start}-${result.shadowedRange.end}, ~${result.shadowedTokenCount} tokens)`);
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
            if (!signal.aborted) {
                const session = agent.session;
                // ── 三级触发的判定窗口（v1.5.0）────────────────────────────────────────
                // pre-step 载荷自带 `{ messages, turn, step }`：宿主 `agent.ts:244` 先 claim
                // （把本步要发的 user 消息取出，落一条 inbox/spliced），`:250` 才 dispatch 本
                // 钩子 ⇒ **轮初（step===1）时 `messages` 就是本轮新 user 消息的精确内容**，而它
                // 此刻尚未进 surface。故轮初估值既不需要"预测"，也不会漏掉用户的大段粘贴。
                //   · step === 1 → L1 轮初主动：per-atom LLM pass（原子降熵）+ 图剪，阈值沿用
                //     windowRatio；估值含本步已 claim 未落盘的 user 消息。
                //   · step  > 1 → L1' 轮中压力剪：**只做 0-LLM 图剪**，且放宽 `turnGuard`
                //     （`midTurnTurnGuard`，默认 0）。真会话存档实证：超额的来源恰恰是上一批
                //     tool result（轮中），而 turnGuard=1 把整轮保护起来——这正是 1.3.x 轮中剪
                //     "只剪 1 原子/154 tok、却每次断一次前缀缓存"的根因。轮中不跑 per-atom pass：
                //     那是 79s–3min 的阻塞，轮内不划算（轮初/轮末另有专门通道）。
                // 两种时机都落在**本 pre-step**：剪完同一个 step 的请求即已瘦身 ⇒ 天然自动继续本 turn。
                // 回调失败隔离：吞错后照常走图剪。
                const turnStart = step === 1;
                if (turnStart || this.midTurnPruneEnabled) {
                    const incoming = this.incomingTokens(messages);
                    // per-atom 压缩：轮初必跑；轮中只在 `midTurnActive: true`（1.3.x 对照档）下跑——
                    // 它需要 open turn 的原子，且是一次 79s–3min 的阻塞，新默认档的轮中剪刻意不带它。
                    if ((turnStart || this.midTurnLegacyGuard)
                        && this.onPrePressureCompress !== undefined && detectOpenTurn(session) !== null) {
                        if (await this.isPressureExceeded(agent, incoming)) {
                            try {
                                await this.onPrePressureCompress(session);
                            }
                            catch (error) {
                                const message = error instanceof Error ? error.message : String(error);
                                this.log.error('[argp-graph] pre-pressure peratom compress FAILED: ' + message);
                                this.log.warn(`[argp-graph] pre-pressure compress failed: ${message}; proceeding to graph prune`);
                            }
                        }
                    }
                    const previousOverride = this.guardOverride;
                    if (!turnStart) {
                        // 轮中剪：只放宽 turnGuard；recencyGuard 照旧保护最新节点（刚收到的 tool result 不动）。
                        this.guardOverride = {
                            recencyGuard: this.argpSettings.recencyGuard,
                            turnGuard: this.midTurnLegacyGuard ? this.argpSettings.turnGuard : this.midTurnTurnGuard,
                        };
                    }
                    try {
                        await this.compactIfNeeded(agent, 'pressure', signal, incoming);
                    }
                    catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        this.log.error('[argp-graph] pressure prune FAILED: ' + message + (error instanceof Error && error.stack ? '\n' + error.stack.split('\n').slice(0, 6).join('\n') : ''));
                        this.log.warn(`[argp-graph] pressure prune failed: ${message}; continuing the turn`);
                    }
                    finally {
                        this.guardOverride = previousOverride;
                    }
                }
                // turn 仍在跑时的收紧剪（被 turn-stopping 消费过的不再重复）。
                await this.runReactivePrune(agent, signal, ctx);
            }
            return next();
        });
        // ── L3 截断续写（v1.5.0 核心）──────────────────────────────────────────────
        // 把"输出被外部钳制 ⇒ 本 turn 被 max-tokens 终结 ⇒ 任务半途而废"改写成
        // "剪掉超额 + steer 一条续写消息 ⇒ **同一个 turn** 继续推进当前任务"。
        //
        // 为什么必须挂在这里：宿主 `agent-loop/src/agent.ts:483` 在 `finish.kind === 'max-tokens'`
        // 时**直接 return**（先于 `executeToolCalls` ⇒ 那一步的 tool calls 被丢弃），`turn()` 随即因
        // `turnEnds && inbox.nextStep.length === 0` 收轮 ⇒ agent 回 idle 等用户。真会话存档实证：
        // 全库 5/5 次钳制后面紧跟的都是 `step/end > turn/end`，没有一次续跑。
        // `agent/turn-stopping` 是本轮最后一个可干预点（turn/end 尚未落账 ⇒ 编号 bracket 仍属本 turn），
        // 且 harness 自带契约测试锁定 *"steer() from an agent/turn-stopping listener continues the
        // same turn"*（`packages/core/agent-loop/tests/contract-regressions.spec.ts:323`）：steer 进
        // next-step 后循环以 `target='next-step'` 续跑，用户无需再发"继续"。
        ctx.on('agent/turn-stopping', async ({ agent, signal }) => {
            const session = agent.session;
            if (!this.reactivePending.has(session))
                return;
            this.reactivePending.delete(session);
            if (signal.aborted)
                return;
            const used = this.reactiveRescues.get(session) ?? 0;
            if (used >= this.reactiveRetries) {
                this.log.warn('[argp-graph] auto-continue: limit reached (' + used + '/' + this.reactiveRetries
                    + '); letting the turn end — the task needs a new user message');
                return;
            }
            this.reactiveRescues.set(session, used + 1);
            const relax = used + 1 > 1;
            const previousOverride = this.guardOverride;
            if (relax) {
                this.guardOverride = { recencyGuard: 0, turnGuard: 0 };
                this.log.warn('[argp-graph] auto-continue attempt ' + (used + 1) + ': relaxing recency/turn guards');
            }
            let result = null;
            try {
                result = await this.compactIfNeeded(agent, 'context-overflow', signal);
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                this.log.error('[argp-graph] auto-continue prune FAILED: ' + message);
            }
            finally {
                this.guardOverride = previousOverride;
            }
            if (result === null || result.shadowedSeqs.length === 0) {
                // 本轮剪不动 ⇒ 把信号留到下一次机会（通常是用户开口后的那一轮 pre-step，那时阶梯已 +1、
                // 守卫放宽）。不 steer：零腾空还续写，只会立刻再被钳一次。
                this.rearmReactive(session, used + 1);
                this.log.warn('[argp-graph] auto-continue: nothing prunable; letting the turn end');
                return;
            }
            this.log.warn('[argp-graph] output was clamped by the host: pruned ' + result.shadowedSeqs.length
                + ' nodes (~' + result.shadowedTokenCount + ' tokens) at turn-stopping; steering a continuation'
                + ' so the same turn keeps advancing the task');
            if (this.continuationNotice.length === 0)
                return;
            try {
                agent.steer(createUserMessage({
                    content: [{ type: 'text', text: this.continuationNotice }],
                    // 宿主/本引擎都把 `plugin` 源归为 X（可见、不参剪）⇒ 这条提示既进请求又不会被剪掉，
                    // 且 UI 侧按 notice 渲染，不会伪装成用户输入。
                    source: {
                        kind: 'plugin',
                        plugin: 'dsh-argp',
                        form: 'notice',
                        summary: 'output clamped; context pruned — continuing the same turn',
                    },
                }));
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                this.log.error('[argp-graph] auto-continue steer FAILED: ' + message);
            }
        });
        // Preset 净化（Q8 收口）：roster 服务可用时，对含 stock compaction 的 shipped
        // preset 生成 `<id>-argp` 净化副本（摘 compaction-basic/tool-result-pruner，
        // 留 command-compact——其 compaction inject 沿 realm 链解析到本引擎）。
        // inject 是优雅降级边界：无 agentPresets 的部署（headless 等）回调永不执行；
        // 净化全程 fail-soft，失败只记日志（install-hygiene 不能阻断引擎挂载）。
        if (config.presetClean !== false) {
            ctx.inject(['agentPresets'], (iocCtx) => {
                const presets = iocCtx.agentPresets;
                if (presets === undefined)
                    return;
                const options = config.presetClean === false ? {} : config.presetClean;
                void cleanShippedPresets(presets, options ?? {})
                    .then(report => {
                    for (const outcome of report.outcomes) {
                        if (outcome.status === 'skipped') {
                            if (outcome.reason !== 'no stock compaction-basic') {
                                this.log.warn(`[argp-preset-clean] ${outcome.source}: skipped (${outcome.reason ?? 'unknown'})`);
                            }
                            continue;
                        }
                        if (outcome.status === 'already-clean')
                            continue;
                        this.log.info(`[argp-preset-clean] ${outcome.source} -> ${outcome.target} (${outcome.status}; removed: ${outcome.removed.join(', ') || 'none'})`
                            + ' — select "' + outcome.target + '" for new sessions; /compact in it routes to ARGP');
                    }
                })
                    .catch((error) => {
                    this.log.warn('[argp-preset-clean] failed: ' + String(error));
                });
            });
        }
    }
    /**
     * A7（问题 3 修订）：session 绑定统一入口——setSession / agent/pre-step / compactIfNeeded 首次绑定
     * 都走这里。绑定后若 records 为空且日志含 compaction/start 事件（resume 场景：账目丢失仅日志在），
     * 懒触发 rebuildLedgerFromLog() 自动重建；幂等由 rebuiltCompactionIds 去重保证。
     */
    bindSession(session) {
        // P5 Wave 3 第 4 步：实现迁 session-lifecycle.bindSession（this → host 窄接口），本方法变薄编排。
        bindSession(this, session);
    }
    setSession(session) {
        this.bindSession(session);
    }
    /**
     * 真实 token 锚点回填（2026-09-21 修，问题定位见 docs/audit-prune-priority / 当日台账）。
     *
     * 背景：`lastRealPromptTokens` / `lastRealAnchorSeq` 原先**只**由 `ctx.on('session/event')`
     * 的 `assistant/message` 处理器写入。宿主进程重启后 resume 的会话若不再把该事件喂给本
     * 引擎（真环境 2026-09-21 实证：同一会话 turn 1 锚点正常、turn 2 起恒为 0），
     * `measureTokens` 会静默走回退分支 `visibleChars / charsPerToken`——而 `visibleChars`
     * 的投影口径**不含 reasoning**。实测该估算 ≈ 真实 prompt 的 **0.48 倍**：
     *   turn 6 真实 prompt 210,719 tok 时估算仅 ≈102,703 ⇒ 触发线 100,007 一路不越线，
     *   直到真实 prompt 210,719 才触发（迟 2.1×，66 步空转；graph 剪全程只跑 1 次）。
     *   windowRatio=0.8 档下估算上限 ≈126K **永远够不到** 210,715 触发线 ⇒ 压力路径
     *   完全不触发，只剩 provider 报错后的溢出恢复兜底。
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
                this.lastRealPromptTokens = usage.inputTokens + read + write;
                this.lastRealAnchorSeq = typeof event.seq === 'number' ? event.seq : -1;
                restored = true;
                break;
            }
        }
        catch {
            restored = false;
        }
        if (!restored) {
            // 新会话 / 日志无 usage：清掉可能属于上一个 session 的失效锚点。
            this.lastRealPromptTokens = 0;
            this.lastRealAnchorSeq = -1;
            return;
        }
        this.log.info('[argp-graph] usage anchor restored from log: real prompt='
            + this.lastRealPromptTokens + ' tok at seq=' + this.lastRealAnchorSeq);
    }
    /** 生成上下文头部 catalog（设计稿 §5 + A9）：U/A/R 三类都列（R 带 type=R），snippet 截断，字符预算驱动（A9）。
     *  P5 Wave 3 第 4 步：实现迁 recall.catalogText（this → host 窄接口），本方法变薄编排。 */
    catalogText(maxItems = 20, snippetChars = 70, tokenBudget = 600) {
        return catalogText(this, maxItems, snippetChars, tokenBudget);
    }
    /** 按关键词查询被剪节点原文（设计稿 §6 的 recall(query) 简化版）。
     *  P5 Wave 3 第 4 步：实现迁 recall.recallQuery（this → host 窄接口），本方法变薄编排。 */
    recallQuery(query, maxResults = 5) {
        return recallQuery(this, query, maxResults);
    }
    /**
     * 增量维护被遮蔽 surface seq 集合：事件日志只追加，游标从上次扫描处继续，
     * 避免每次 recall/剪枝压力检查都 O(事件总量) 重扫。session 切换时重置。
     * P5 Wave 3 第 4 步：实现迁 recall.shadowedSeqsOf（this → host 窄接口），本方法变薄编排。
     */
    shadowedSeqsOf(session) {
        return shadowedSeqsOf(this, session);
    }
    /**
     * 程序化 recall（RecallHandle 语义）：**仅**命中被遮蔽节点，未命中返回 null。
     * 这是给宿主/测试用的窄接口，故意保留 pruned-only 语义（历史 spike 系列的
     * `engine.recall(seq) !== null` 探针依赖它判定"是否已被剪"，去门控会破坏探针）；
     * 模型侧 recall_pruned 工具已按 P1 修复 (b) 去门控并带状态标签，
     * 程序化的全日志入口是 recallAnyState()。
     * P5 Wave 3 第 4 步：实现迁 recall.recall（this → host 窄接口），本方法变薄编排。
     */
    recall(seq) {
        return recall(this, seq);
    }
    /**
     * 全日志级 recall（P1 修复 (b) 的程序化入口）：对任意界内 seq 返回原文 + 状态标签，
     * 不要求节点属于 pruned 集合。越界返回 null。
     * P5 Wave 3 第 4 步：实现迁 recall.recallAnyState（this → host 窄接口），本方法变薄编排。
     */
    recallAnyState(seq) {
        return recallAnyState(this, seq);
    }
    /** 单个 seq 相对可见上下文的状态（shadowed / live / off-surface）。
     *  P5 Wave 3 第 4 步：实现迁 recall.nodeState（this → host 窄接口），本方法变薄编排。 */
    nodeState(seq) {
        return nodeState(this, seq);
    }
    /**
     * 原子化（§4.1）：只投影 surface 节点；U/X/R/A 四类（tool/call 不进 surface，无 T 类）。cites 统计在 A 原子处累计。
     *
     * node 0 保护（2026-09-10，dsh 0.1.5 起）：宿主把 system prompt 表示为 surface node 0 的
     * `system/message`，并在 surface.ts `assertSystemHeadRewrite` 里硬性保护——任何覆盖 node 0 的
     * replace 必须是"恰好覆盖该单节点的 system/message"，否则 throw。
     * 本函数的 switch 只认 `user/message` / `assistant/message` / `tool/result`，其余类型（含
     * `system/message`）**静默跳过、不产出原子**，因此 node 0 永远不会进入 ARGP 的剪枝区间，
     * 上述宿主断言不会被触发。**这是有意依赖，不是巧合**——若日后要支持剪系统提示，
     * 必须同时改这里与宿主契约。守护用例见 test/argp-graph-engine.test.ts
     * 「system prompt at surface node 0 is never selected for pruning」。
     *
     * P5 Wave 3 第 4 步：实现迁 graph-build.atomize（this → host 窄接口），本方法变薄编排。
     */
    atomize(session) {
        return atomize(this, session);
    }
    /**
     * 建图（§4.2 + §4.7 + A1/A2/A5）：确定性边不计级别；cites 子串匹配生成语义边，
     * 级别取声明级别（V6 契约，裸字符串默认 supporting；critical 参与闭包守卫不变量 2′）。
     * A5：3-gram 倒排索引候选（先精确 n-gram 命中，再子串验证）；前缀过短自动全扫描回退。
     * 歧义消解增强（A2）：命中集内 U 优先 → 最长公共前缀最深的原子优先 → 最早 seq。
     * 前缀长度守卫：过短前缀不计 declared 也不建边。
     *
     * P5 Wave 3 第 4 步：实现迁 graph-build.buildGraph（this → host 窄接口），本方法变薄编排。
     */
    buildGraph(atoms) {
        return buildGraph(this, atoms);
    }
    /** surface 可见字符总量（与 spike 4 同基准）。P5 Wave 3 第 4 步：实现迁 budget.visibleChars（纯函数）。 */
    visibleChars(session) {
        return visibleChars(session);
    }
    /** 测量当前上下文 token。优先「真实 usage 锚点 + 增量估算」（2026-08-23，
     *  替代 tokenMeter chars/4 低估导致的迟触发/窗口保护失效）；无锚点才回退
     *  dsh tokenMeter / 配置函数 / 字符估算。source 标注估计来源（2026-08-29：
     *  压力日志与实验审计需要区分 anchored 真值路径与启发式回退路径）。
     *  `extraTokens`（1.4.0）：本步**已 claim 但尚未落盘**的 user 消息估值。轮初它既不在
     *  surface 里、也不在锚点覆盖范围内，漏掉就等于漏算"这一轮的启动量"——而用户恰恰
     *  常在轮初粘贴大段文本，正是 1.3.x 轮初估值偏低的直接原因。
     *  P5 Wave 3 第 4 步：实现迁 budget.measureTokens（this → host 窄接口），本方法变薄编排。 */
    measureTokens(session, extraTokens = 0) {
        return measureTokens(this, session, extraTokens);
    }
    /**
     * 本步已 claiming（尚未落盘进 surface）的 user 消息估值：字符数 ÷ charsPerToken。
     * 与 `measureTokens` 的增量口径同基准（同一 charsPerToken），可直接相加。
     */
    incomingTokens(messages) {
        let chars = 0;
        for (const message of messages) {
            const content = message.content;
            if (!Array.isArray(content))
                continue;
            for (const block of content) {
                const b = block;
                if (typeof b.text === 'string')
                    chars += b.text.length;
                if (!Array.isArray(b.content))
                    continue;
                for (const inner of b.content) {
                    const t = inner.text;
                    if (typeof t === 'string')
                        chars += t.length;
                }
            }
        }
        return chars === 0 ? 0 : Math.ceil(chars / this.charsPerToken);
    }
    /**
     * §4.4 版本链去重（+ A3 N1 bug fix + A4 θ 重叠归链）：
     *  - A：文本全等（不变）。
     *  - R：按「issuer A 的 tool name + arguments JSON」去重（而非旧版 issuer?.text.trim()），
     *    解决「同措辞不同工具调用（如不同参数 read different files）被错误归链去重」的问题。
     *    回退：issuer 不存在时用 r.text（callId 缺失的最小退化）。
     *  - A4：enableOverlapChain 时，R 文本行重叠 sim ≥ θ（默认 0.8）也归入同一版本链
     *    （read→edit→read 等高频工具迭代）；A 文本仍走全等。
     * 返回 { dupIds, chainLen }：chainLen 记录每个存活代表（newer）的链长，供 density-chain 叠加 eff。
     *
     * P5 Wave 3 第 4 步：实现迁 graph-build.findVersionDuplicates（this → host 窄接口），本方法变薄编排。
     */
    findVersionDuplicates(atoms, inDegree) {
        return findVersionDuplicates(this, atoms, inDegree);
    }
    /**
     * 当前最大 turn 号（recall 回拉防抖窗口 / 闭包保护窗口共用口径）。
     *
     * P4 修复：旧实现遍历 **全部 events** 取 max，把 turn/start、注入型 system-reminder
     * 等非 surface 事件也算进来，与 compactIfNeeded（含内联闭包降级链）用的
     * "atoms（surface 节点）最大 turn" 口径不一致 —— 同一个防抖判定两端基准不同。
     * 现统一为 surface 节点口径；turnBasis='semantic'（默认）时进一步排除注入型 X 节点，
     * 使纯注入不推进轮次、不抬高 latestTurn-k 保护线。
     */
    latestTurnOf(session) {
        // P5 Wave 3 第 4 步：实现迁 recall.latestTurnOf（this → host 窄接口），本方法变薄编排。
        return latestTurnOf(this, session);
    }
    latestTurnOfSession() {
        return latestTurnOfSession(this);
    }
    /**
     * recall 命中被剪闭包内节点时，将该闭包拉回 ACTIVE 并记下防抖轮。
     *
     * P2 修复：防抖 key 从 closureId 改为 rootSeq。closureId 由 `nextClosureId++` 生成，
     * selectClosureToMerge 每 pass 都给所有 root 重发新 id，导致此处写入的旧 id 与
     * 剪枝决策处读取的新 id 永不相等 → `continue` 防抖分支永不触发 → 刚 recall 回来的
     * 闭包下一 pass 又被剪。rootSeq 跨 pass 稳定，是闭包的天然身份。
     * P5 Wave 3 第 4 步：实现迁 recall.noteRecallHit（this → host 窄接口），本方法变薄编排。
     */
    noteRecallHit(seq) {
        noteRecallHit(this, seq);
    }
    /**
     * recall 预算：单次结果与累计结果都按窗口比例截断（窗口取最近解析的有效预算）。
     *
     * P7 修复：recallCharsUsed 原本只增不减、全会话无 reset —— 累计触顶后 allowed=0，
     * 返回值退化成纯 '…(truncated)' 且不说明原因，长会话静默丢 recall。现在
     *  1) 预算耗尽时显式说明剩余额度与何时恢复（不再静默）；
     *  2) 每笔 compaction 事务成功后归零（见 pruneIntervals 末尾）。
     * P5 Wave 3 第 4 步：实现迁 recall.budgetRecallText（this → host 窄接口），本方法变薄编排。
     */
    budgetRecallText(text) {
        return budgetRecallText(this, text);
    }
    /**
     * A6（保守选项 a）：summarize 末环不实现 —— 保持默认关闭（enableSummarize=false）、
     * force_prune 为终端降级，文档明确。本 stub 恒返回 null，degradationStrategy='summarize'
     * 且 enableSummarize=true 时也不会产出 LLM 摘要；实际路径仍为 lifecycle → force。
     */
    summarizeCriticalChain(_session, _atoms, _edges, _latestTurn) {
        return null;
    }
    /** P2 选择侧（2026-08-22 拆出）：选一个 PRUNABLE 闭包并返回其原子/区间，不执行剪枝。
     *  `alreadyPruned` 用于排除已由正常候选/版本重复剪过的原子——修复前独立闭包事务
     *  按整闭包（含已剪原子）独立剪枝并 return，导致正常候选成果被丢弃；现改为"选择并入
     *  pruned、统一事务剪"（compactIfNeeded 降级链内联），闭包原子需与已剪集合去重
     *  （如 A1/A2 已正常剪 → 闭包仅剩 root U，单独退休 root U 是有意设计：P5 注释
     *  "自动闭包生命周期确实会连 root U 一起剪除"）。 */
    selectClosureToMerge(session, atoms, edges, inDegree, askCover, latestTurn, alreadyPruned) {
        // P5 Wave 3 第 4 步：实现迁 prune-selection.selectClosureToMerge（this → host 窄接口），本方法变薄编排。
        return selectClosureToMerge(this, session, atoms, edges, inDegree, askCover, latestTurn, alreadyPruned);
    }
    // 2026-09-21（P5 Wave 3 第 3 步）：原独立闭包事务方法删除（生产零调用、仅测试引用；
    // 注释自认 2026-08-22 起已被内联）——其选择逻辑即 selectClosureToMerge，执行语义已内联进
    // compactIfNeeded 降级链（候选耗尽 → 闭包并入 pruned → 统一 pruneIntervals 事务剪）。
    /**
     * 预算解析：显式配置用显式值；否则从适配器声明的 contextWindow 按比例推导——
     *  windowTokens = contextWindow × windowRatio（默认 0.8），retainTokens = windowTokens × retainRatio（默认 0.2）。
     *  上下文容量由其他插件（模型适配器声明）决定，本引擎不硬编码。
     *  解析顺序：1) session.requestContext()（request/context 事件，真会话最可靠）；
     *           2) llm.resolveModelInfo(provider, model)；3) 静态默认值。
     */
    async resolveScaledBudgets(agent) {
        // P5 Wave 3 第 4 步：实现迁 budget.resolveScaledBudgets（this → host 窄接口），本方法变薄编排。
        return resolveScaledBudgets(this, agent);
    }
    /**
     * tombstone 归并（v1.2.x §11.8① 修复）。扫描 surface，找**连续**的「可合并墓碑」X 段
     * （user/message + isMergeableTombstone 文本），段长 ≥ tombstoneMergeMinRun 时一笔事务
     * replace 成单条聚合墓碑（列出原 tombstone seqs → 原文仍 recall_pruned(seq) 可取回）。
     * 复用 pruneIntervals 事务骨架（含 shadow-price 契约、summary、锚点重置）。
     * 每 pass 至多一段——失败回退范围清晰。返回被归并的墓碑节点数（0 = 无可归并）。
     * tool 占位墓碑（type=tool）与 system-reminder / 官方 checkpoint（不含 pruned by ARGP）
     * 均被 isMergeableTombstone / 事件类型过滤挡住，不会被吞。
     */
    consolidateTombstones(session) {
        // P5 Wave 3 第 4 步：实现迁 prune-tx.consolidateTombstones（this → host 窄接口），本方法变薄编排。
        return consolidateTombstones(this, session);
    }
    /**
     * 压力剪枝（§4.3/§4.5）：估算量 ≥ windowTokens 时重建图，按排序键逐弱剪至 ≤ retainTokens。
     * 候选：A/T/R、语义入度 0、非近因豁免区、非最新轮、非保守保护；普通 U 仅 ask-exempt 参剪，
     * X（墓碑/checkpoint）不参剪——但墓碑地板由 §11.8① tombstone-merge 在图剪前归并（见 consolidateTombstones）。
     * 排序键（§4.5）：最低关联语义级别升 → effective_importance 升 → lastRefRound 升 → seq 升。
     * 候选耗尽仍超预算 → force_prune（忽略入度，§4.6.2）。
     *
     * trigger='context-overflow'（官方溢出恢复，见 agent/request-error 钩子）：
     * 模型请求已被 provider 确认超出上下文（400 exceed_context_size_error）——估算量
     * 可能与实际请求偏差（估算低于触发线但请求已撞墙），此时**跳过 pressure 门槛强制
     * 剪枝**，剪到 retain 目标（≈1/5 窗口，远低于 n_ctx）后由钩子重发请求。
     */
    /**
     * P6 轮内压力判定（与 compactIfNeeded('pressure') 同口径，2026-09-19 方案 B）：
     * 声明窗口已知 且 contextTokens ≥ windowTokens − reserveTokens。抽出供 pre-step
     * 钩子复用，避免两处重复预算解析（口径漂移风险）。返回 false = 未达标（或
     * reserve 超窗 / 声明窗口未知）⇒ 调用方跳过轮内压缩。
     */
    async isPressureExceeded(agent, extraTokens = 0) {
        const session = agent.session;
        const { windowTokens, declaredKnown } = await this.resolveScaledBudgets(agent);
        const thresholdTokens = windowTokens - this.reserveTokens;
        if (thresholdTokens <= 0)
            return false;
        if (!declaredKnown)
            return false;
        const measurement = this.measureTokens(session, extraTokens);
        return measurement.contextTokens >= thresholdTokens;
    }
    /**
     * L2 反应式补救（三级触发②）：轮中唯一允许的压缩时机。
     *
     * 触发源见 `session/event` 里的 max-tokens 判据（输出被宿主/适配器钳制 = 容量压力已由
     * 上游确认）。执行用 `context-overflow` trigger 走 `compactIfNeeded` —— 该 trigger
     * **绕过阈值早检**（"仍未回线"的真信号由上游继续钳输出给出），即"强制剪一次"。
     *
     * 升级策略：第 2 次起临时放宽 recencyGuard/turnGuard（连当前轮一起进入候选）——因为
     * 常规轮内剪枝受 turnGuard 保护几乎剪不动，"被钳后回线"需要更狠的手段。用尽
     * `reactiveRetries` 次即停止重试并交给 overflow 路径（provider 400）兜底：避免
     * "每步都被钳 → 每步白压"的死循环（那比现状更糟，每圈多吃一次输出）。
     */
    /**
     * 反应式"零候选"重挂：把钳制信号留给下一次机会（下个 pre-step / 下一轮 turn-stopping），
     * 那时阶梯已 +1 ⇒ 守卫放宽，原本剪不动的局面（turnGuard 保护当前轮）才可能剪动。
     * 额度用尽则不再重挂（避免"每步白压"）。
     */
    rearmReactive(session, used) {
        // P5 Wave 3 第 4 步：实现迁 session-lifecycle.rearmReactive（this → host 窄接口），本方法变薄编排。
        rearmReactive(this, session, used);
    }
    /**
     * L2：turn 仍在跑时的反应式收紧剪。被钳后宿主可能继续本 turn（还有 next-step 输入），
     * 此时就在下一个 pre-step 剪；若本轮要收，则由 turn-stopping 的 L3 路径剪 + 续写。
     * 两者共用同一个 episode 计数器（`reactiveRescues`），故连续被钳会逐级放宽守卫而不是各自从头开始。
     */
    async runReactivePrune(agent, signal, ctx) {
        if (!this.reactivePending.has(agent.session))
            return;
        this.reactivePending.delete(agent.session);
        if (signal.aborted)
            return;
        const used = this.reactiveRescues.get(agent.session) ?? 0;
        if (used >= this.reactiveRetries) {
            this.log.warn('[argp-graph] reactive prune retries exhausted after ' + used
                + ' attempt(s); leaving further recovery to the overflow path');
            return;
        }
        this.reactiveRescues.set(agent.session, used + 1);
        const relax = used + 1 > 1;
        const previousOverride = this.guardOverride;
        if (relax) {
            this.guardOverride = { recencyGuard: 0, turnGuard: 0 };
            this.log.warn('[argp-graph] reactive prune attempt ' + (used + 1)
                + ': relaxing recency/turn guards so the newest turn becomes prunable');
        }
        try {
            const result = await this.compactIfNeeded(agent, 'context-overflow', signal);
            if (result !== null) {
                this.log.info('[argp-graph] reactive prune attempt ' + (used + 1) + ': shadowed '
                    + result.shadowedSeqs.length + ' surface nodes (seqs ' + result.shadowedRange.start + '-'
                    + result.shadowedRange.end + ', ~' + result.shadowedTokenCount + ' tokens)');
            }
            else {
                // 没剪到东西 ⇒ 信号留着：下一次机会（下一个 pre-step / 下一轮 turn-stopping）带上
                // 放宽守卫再试。若这里直接消费掉，"守卫太紧导致零候选"就会变成永久漏救。
                this.rearmReactive(agent.session, used + 1);
                this.log.warn('[argp-graph] reactive prune attempt ' + (used + 1)
                    + ': nothing prunable (candidate set exhausted); re-arming for a relaxed retry');
            }
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.log.error('[argp-graph] reactive prune FAILED: ' + message);
            this.log.warn(`[argp-graph] reactive prune failed: ${message}; leaving recovery to the overflow path`);
        }
        finally {
            this.guardOverride = previousOverride;
        }
    }
    async compactIfNeeded(agent, trigger, _signal, 
    /** 本步已 claim 未落盘的 user 消息估值（轮初专用；其余调用点省略）。 */
    incomingTokens = 0) {
        const session = agent.session;
        this.bindSession(session); // A7（问题 3）：compactIfNeeded 也走统一绑定（含账目懒重建）
        const { windowTokens, retainTokens, declaredKnown } = await this.resolveScaledBudgets(agent);
        const thresholdTokens = windowTokens - this.reserveTokens;
        if (thresholdTokens <= 0) {
            this.log.info('[argp-graph] pressure check: reserveTokens exceeds windowTokens, skip');
            return null;
        }
        const retainChars = retainTokens * this.charsPerToken;
        const measurement = this.measureTokens(session, incomingTokens);
        // 声明窗口未知时的早检跳过（2026-08-28）：物理口径宁可不用（宁缺勿错）；
        // context-overflow 触发除外——那是 provider 确认的真实溢出，必须处置。
        if (trigger !== 'context-overflow' && !declaredKnown) {
            this.log.info('[argp-graph] pressure check: declared contextWindow unknown, skip (will check after first request/context)');
            return null;
        }
        if (trigger !== 'context-overflow' && measurement.contextTokens < thresholdTokens) {
            this.log.info('[argp-graph] pressure check: contextTokens=' + measurement.contextTokens + ' (source=' + measurement.source + ') < threshold=' + thresholdTokens + ', skip');
            return null;
        }
        // v1.2.x §11.8① tombstone-merge：图剪前先把「墓碑地板」压下去。
        // X 原子在 isAtomCandidate 结构性不可剪（2119 行）→ 每轮剪枝新增墓碑，地板单调累积，
        // 剪到候选耗尽仍超窗（run1 T17 / run2 T16 同数字 141,313+32,768>174,080 两臂复现；
        // run2 dump 实测 1297/1310 surface 节点是墓碑，≈142K tok）。归并后原子/图重建，
        // 后续贪心循环拿到的才是真实可剪面。
        const mergedTombstones = this.consolidateTombstones(session);
        if (mergedTombstones > 0) {
            this.log.info('[argp-graph] tombstone-merge: ' + mergedTombstones + ' tombstone nodes consolidated before graph prune');
        }
        const atoms = this.atomize(session);
        const { edges, deterministicEdges, inDegree } = this.buildGraph(atoms);
        // 动态有效入度（§5.4 反向拓扑链式解锁）：每 pass 从"未被剪原子的边"重推，
        // 剪除引用方后其出边消失 → 目标入度递减。多引用场景（A/C/D 都引用 B）下
        // B 须等全部引用方被剪才解锁，天然正确；重复 cites 也按边数逐条减。
        let curInDegree = inDegree;
        // 实验（2026-09-15）：A10 结构守卫（isAtomCandidate 内）的前提是「R 已被组外的**语义声明**
        // 保护」，而 `inferred` 边是 0-LLM 机械派生（权重 1、不保证保护力）——若把它计入 A10 的
        // 外部入边判据，会伪激活「R 已受保护 → A 可剪」→ A 先被剪 → §5.4 链式解锁带走 R，
        // 净效果是**加边反而多剪**（spike38 A-ON 27 原子 vs A-OFF 23）。故 A10 只看非 inferred 入度。
        let curInDegreeDecl = new Map();
        const surfaceSeqs = [...session.surface.nodes];
        const position = new Map(surfaceSeqs.map((seq, i) => [seq, i]));
        const recencyCut = Math.max(0, surfaceSeqs.length - this.recencyGuard);
        const latestTurn = atoms.reduce((m, a) => Math.max(m, a.turn), 0);
        // P4：U-info 按 R 待遇（eff=0，无 selfImportance，靠边权重/排序）；普通 U=3。
        const selfImportance = (a) => (a.type === 'A' ? 5 : (a.type === 'U' && a.sourceSeq === undefined ? 3 : 0));
        const eff = new Map(atoms.map(a => [a.id, selfImportance(a)]));
        for (const e of edges)
            eff.set(e.to, Math.max(eff.get(e.to) ?? 0, EDGE_WEIGHTS[e.level])); // 语义边权重
        // §3-3 recall 价值继承：recall 结果原子若被 cites 命中（入度>0 = 模型确认使用），
        // 继承旧原子的被剪 eff（×0.5 衰减）。继承一旦触发即"永久"生效于本轮排序——
        // 不依赖当前入度（链式解锁可能剪掉 cites 方后使入度归零，但继承的价值仍应保留，
        // 避免"模型刚确认使用的内容因引用方先被剪而立刻被剪"）。
        if (this.recallResultSeq >= 0 && this.recallSourceSeq >= 0) {
            const recallAtom = atoms.find(a => a.seq === this.recallResultSeq);
            const source = this.prunedNodeIndex.get(this.recallSourceSeq);
            if (recallAtom !== undefined && source !== undefined && (inDegree.get(recallAtom.id) ?? 0) > 0) {
                const inherited = Math.floor(source.eff * 0.5);
                eff.set(recallAtom.id, Math.max(eff.get(recallAtom.id) ?? 0, inherited));
            }
        }
        const lastRef = new Map();
        for (const e of edges) {
            const from = atoms[e.from];
            if (from !== undefined)
                lastRef.set(e.to, Math.max(lastRef.get(e.to) ?? 0, from.turn));
        }
        const touchesSemantic = new Set(edges.flatMap(e => [e.from, e.to]));
        // ask-exempt U 动态覆盖：U 后首个 A 若对它有 supporting 边，则视为被覆盖；后续跨轮引用会使其失效。
        const askCoverage = new Map();
        for (const u of atoms.filter(a => a.type === 'U')) {
            const text = u.text.trim();
            // A8：ask 检测（导出纯函数 looksAskText，测试直接锁定收窄行为）
            const looksAsk = looksAskText(u.text);
            if (!looksAsk)
                continue;
            const firstA = atoms
                .filter(a => a.type === 'A' && a.turn >= u.turn && a.seq > u.seq)
                .sort((a, b) => a.seq - b.seq)[0];
            if (firstA !== undefined && edges.some(e => e.from === firstA.id && e.to === u.id)) {
                askCoverage.set(u.id, firstA.id);
            }
        }
        // 2026-08-23 半拆组：R（tool/result）独立成组，不再与 issuer A 同进退——
        // 大 R（工具结果，常达 10-90K 字符）可独立剪除，解决"压缩率不足"（此前被 A+R 组绑定，
        // 组候选要求 A 也候选；A 因 A10 保护/入度门槛不候选 → 整组不可剪 → 大 R 永远剪不掉）。
        // 协议安全由两侧保证：① 剪 R（A 保留）→ tool 占位墓碑配对 A 的 tool_calls（见
        // pruneIntervals tool 墓碑）；② 剪 A → pass 循环连带剪其全部 R（user 墓碑，防孤儿 tool 消息）。
        // R 被 cites 引用（语义入度 > 0）时仍不可剪（isAtomCandidate 的 curInDegree 门槛保留）。
        const issuerByCall = new Map();
        for (const a of atoms)
            if (a.type === 'A')
                for (const cid of a.toolCallIds)
                    issuerByCall.set(cid, a);
        // R by callId（半拆组连带剪用：剪 A 时把应答其 call 的 R 一并剪除）
        const rByCallForPrune = new Map();
        for (const r of atoms)
            if (r.type === 'R' && r.toolCallIds[0] !== undefined)
                rByCallForPrune.set(r.toolCallIds[0], r);
        const groupOf = new Map();
        const groups = [];
        for (const a of atoms) {
            if (groupOf.has(a.id))
                continue;
            const gid = groups.length;
            groups.push([a]);
            groupOf.set(a.id, gid);
        }
        // P5 Wave 3 第 2 步：3 个闭包（isAtomCandidate/isGroupCandidate/sortKey）提升为模块级纯函数，
        // 原闭包捕获的 this 字段与局部量打包成显式 state（PruneState）。curInDegree/curInDegreeDecl
        // 每 pass 重推（链式解锁），方法内每 pass 同步到 pruneState（见下方 pass 循环）；
        // chainLen 占位空 Map，findVersionDuplicates 后回填（sortKey 仅在 pass 循环内调用，届时已回填）。
        const pruneState = {
            turnGuard: this.turnGuard,
            askCoverage,
            position,
            recencyCut,
            latestTurn,
            edges,
            atoms,
            curInDegree,
            curInDegreeDecl,
            deterministicEdges,
            touchesSemantic,
            eff,
            sortMode: this.sortMode,
            chainLen: new Map(),
            lastRef,
            charsPerToken: this.charsPerToken,
        };
        const softCandidateGroups = groups.filter(g => isGroupCandidate(g, false, pruneState)).length;
        const pruned = new Map();
        // 2026-08-22：闭包原子归属（seq → 闭包元数据），intervals/tombstone 生成时按归属区分
        // 闭包区间（P3/P6：闭包 tombstone 带 root/计数供 recall 消歧）与默认区间。
        const closureSeqMeta = new Map();
        const { dupIds: duplicateIds, chainLen, latestRByKey, rKeyByRId } = this.findVersionDuplicates(atoms, inDegree);
        for (const id of duplicateIds) {
            const atom = atoms.find(a => a.id === id);
            if (atom !== undefined)
                pruned.set(id, atom);
        }
        // 排序键 sortKey 已提升为模块级纯函数（§4.5 + spike 18 提案）；此处回填 chainLen（占位后）。
        pruneState.chainLen = chainLen;
        let forced = false;
        for (let pass = 0; pass < this.maxPasses; pass += 1) {
            // 每 pass 重推有效入度：已剪原子的出边不再计入目标入度（链式解锁）
            curInDegree = new Map();
            curInDegreeDecl = new Map();
            for (const e of edges) {
                if (pruned.has(e.from))
                    continue;
                curInDegree.set(e.to, (curInDegree.get(e.to) ?? 0) + 1);
                // A10 专用：只数非 inferred 入边（见上方实验注释）。
                if (e.level !== 'inferred')
                    curInDegreeDecl.set(e.to, (curInDegreeDecl.get(e.to) ?? 0) + 1);
            }
            // P5 Wave 3 第 2 步：同步当前 pass 的有效入度到 pruneState（模块级 isAtomCandidate 按调用时读取）。
            pruneState.curInDegree = curInDegree;
            pruneState.curInDegreeDecl = curInDegreeDecl;
            const remaining = atoms.filter(a => !pruned.has(a.id));
            const visible = remaining.reduce((sum, a) => sum + a.text.length, 0);
            if (visible <= retainChars)
                break;
            const liveGroups = groups.filter(g => g.some(a => !pruned.has(a.id)));
            let candidateGroups = liveGroups.filter(g => isGroupCandidate(g, false, pruneState));
            if (process.env['ARGP_DEBUG_PASS'] === '1') {
                const dbg = (m) => { process.stdout.write('[dbg] ' + m + '\n'); };
                dbg('pass=' + pass + ' visible=' + visible + '/' + retainChars + ' prunedSoFar=' + pruned.size);
                for (const g of liveGroups) {
                    const a = g[0];
                    dbg('  ' + (isGroupCandidate(g, false, pruneState) ? 'CAND' : 'skip') + ' seq=' + a.seq + ' ' + a.type + ' t' + a.turn + ' inDeg=' + (curInDegree.get(a.id) ?? 0) + ' chars=' + a.text.length);
                }
            }
            if (candidateGroups.length === 0) {
                // 2026-08-22 降级链完整化：候选耗尽时不再 return 丢弃累积 pruned——原独立闭包事务
                // 的 return 把正常候选 + 版本重复全部作废，每次压缩只剪 1 个闭包（2-10 原子），
                // 25 次压缩剪除率 0-2%（"压缩饿死"，见 engine-fix-2026-08-22-compaction-starvation.md（已迁出公开仓库））。
                // fail 保持设计语义（§5.9/§5.11：资源用尽/超窗 → 报警终止，全有或全无、不产出）。
                // lifecycle（默认）：闭包生命周期（选择并入 pruned，含 root U 退休，排除已剪）→
                // summarize（默认关，独立事务）→ force_prune（忽略入度，剪到达标为止）；
                // 全部累积统一走最终 pruneIntervals 一次事务剪。
                if (this.degradationStrategy === 'fail')
                    return null;
                const closure = this.selectClosureToMerge(session, atoms, edges, inDegree, askCoverage, latestTurn, new Set(pruned.keys()));
                if (closure !== null) {
                    const closureTotal = closure.seqs.length;
                    for (const a of closure.atoms) {
                        pruned.set(a.id, a);
                        closureSeqMeta.set(a.seq, { closureId: closure.closureId, rootPreview: closure.rootPreview, closureTotal });
                    }
                    pushBounded(this.closurePrunes, {
                        closureId: closure.closureId,
                        rootSeq: closure.root.seq,
                        prunedSeqs: closure.seqs,
                        at: new Date().toISOString(),
                    }, this.telemetryCap);
                    continue; // 重推后继续：可能还有更多可剪闭包 / force
                }
                if (this.degradationStrategy === 'summarize' && this.enableSummarize) {
                    const summarizeResult = this.summarizeCriticalChain(session, atoms, edges, latestTurn);
                    if (summarizeResult !== null)
                        return summarizeResult;
                }
                candidateGroups = liveGroups.filter(g => isGroupCandidate(g, true, pruneState)); // force_prune：忽略入度
                if (candidateGroups.length === 0)
                    break;
                forced = true;
            }
            const groupKey = (g) => g.map(a => sortKey(a, pruneState)).sort()[0];
            candidateGroups.sort((x, y) => groupKey(x).localeCompare(groupKey(y)));
            const top = candidateGroups[0];
            for (const a of top) {
                pruned.set(a.id, a);
                // 2026-08-23 半拆组连带：剪 A（含 tool-call）必须连带其全部应答 R——
                // 否则提交 messages 里出现孤儿 tool 消息（role:"tool" 无匹配 assistant.tool_calls）→ provider 400。
                // R 独立剪时由 tool 占位墓碑配对（A 保留），此处只处理"A 剪 → R 跟剪"方向。
                if (a.type === 'A' && a.toolCallIds.length > 0) {
                    for (const cid of a.toolCallIds) {
                        const r = rByCallForPrune.get(cid);
                        if (r !== undefined && !pruned.has(r.id))
                            pruned.set(r.id, r);
                    }
                }
            }
        }
        // 微剪枝下限：按极大连续区间归并，区间可见量 < minSpanChars 的放回（不剪）。
        // 2026-08-23 半拆组：R 原子（issuer A 未被剪）强制单独成区间——tool 占位墓碑
        // 的 surface replace 必须恰好替换 1 个节点（dsh assertToolResultRewrite），
        // 多 R 相邻或 R 与邻原子合并会导致替换区间 > 1 节点 → schema 校验失败。
        // 2026-08-23 孤儿修复（双向守卫）：旧守卫只挡「solo-R 并入已有区间」，
        // 没挡「后续原子并入以 solo-R 开头的区间」——混剪后 R 被 user tombstone
        // 整体替换，callId 蒸发，issuer A 的 tool-call 失去应答 → provider 400。
        // 实测 26-local-full-verify2：23 个孤儿全部是此形态（seq 与混剪区间逐一对应）。
        // P5 Wave 3 第 2 步：区间归并段提升为模块级纯函数 mergeIntervals（逐字保留）。
        // droppedIntervals 原方法内计算但未被读取，现由 mergeIntervals 内部计算（供未来诊断/单测）。
        const kept = mergeIntervals(pruned, position, issuerByCall, this.minSpanChars).kept;
        if (kept.length === 0)
            return null;
        for (const iv of kept) {
            for (const a of iv.atoms) {
                const citedBySeq = edges
                    .filter(e => e.to === a.id)
                    .map(e => atoms[e.from]?.seq)
                    .filter((x) => x !== undefined);
                const firstLine = a.text.split('\n').map(l => l.trim()).find(l => l !== '') ?? '';
                // 版本链重定向（2026-08-23）：被剪旧 R 若属于某路径版本链，记录该路径最新存活版本 seq，
                // recall_pruned 命中时重定向返回最新版原文（替代旧值）。
                let latestOfPath;
                if (a.type === 'R') {
                    const key = rKeyByRId.get(a.id);
                    if (key !== undefined) {
                        const latest = latestRByKey.get(key);
                        if (latest !== undefined && latest !== a.seq)
                            latestOfPath = latest;
                    }
                }
                this.prunedNodeIndex.set(a.seq, {
                    seq: a.seq,
                    type: a.type,
                    turn: a.turn,
                    firstLine: firstLine.length > 120 ? firstLine.slice(0, 120) + '…' : firstLine,
                    citedBySeq,
                    eff: eff.get(a.id) ?? 0,
                    ...(latestOfPath !== undefined ? { latestOfPath } : {}),
                });
            }
        }
        // 2026-08-22：区间 tombstone 按闭包归属生成——区间原子全部来自同一闭包 → 闭包 tombstone
        // （P3/P6：带 root/计数，recall 消歧）。
        // 2026-08-23 半拆组：单 R 区间（issuer A 未被剪）→ tool 占位墓碑（保留 callId 配对 A 的
        // tool_calls，wire 序列化输出 role:"tool"，不触发 provider 400；文本提示 recall 找回）。
        // P5 Wave 3 第 2 步：tombstone 生成段提升为模块级纯函数 buildTombstones（逐字保留）。
        const tombstoneTexts = buildTombstones(kept, closureSeqMeta, issuerByCall, pruned, forced);
        return this.pruneIntervals(session, kept, edges.length, softCandidateGroups, forced, tombstoneTexts);
    }
    async compactNow(agent, signal, sourceCommandId) {
        // P5 Wave 3 第 4 步：实现迁 session-lifecycle.compactNow（this → host 窄接口），本方法变薄编排。
        return compactNow(this, agent, signal, sourceCommandId);
    }
    async compactRegion(start, end, agent, signal) {
        // P5 Wave 3 第 4 步：实现迁 prune-tx.compactRegion（this → host 窄接口），本方法变薄编排。
        return compactRegion(this, start, end, agent, signal);
    }
    /** 为手动 compactNow 选择**全部**可剪的极大连续 A/R 段（确定性、由旧到新）。
     *
     *  入选判据（与旧版一致，仅去掉"遇阻即停"）：段内原子必须
     *  ① 是对话载体 A/R（U/X 不参剪，手动入口不剪骨架，见 compactRegion 的 P5 约束）；
     *  ② 不落在 turnGuard（最近 N 轮）与 recencyGuard（surface 末尾 N 节点）保护窗口内。
     *
     *  修复（2026-09-21）：旧实现扫到第一个不合格节点就 `break`，而真实会话的 surface 被
     *  用户消息切成「U A R A R U A R …」多段结构 ⇒ 手动 /compact 永远只剪最老一小段
     *  （表现为"图剪压不动"）。现在改为收集全部极大连续段，交给一笔 pruneIntervals 事务剪除。
     *  P5 Wave 3 第 4 步：实现迁 prune-tx.selectManualRanges（this → host 窄接口），本方法变薄编排。
     */
    selectManualRanges(session) {
        return selectManualRanges(this, session);
    }
    /** 手动多区间压缩：逐段复核边界后合并为一笔事务剪除。
     *  边界复核与 compactRegion 同口径（配对平衡 / 段内不含 U/X / 段内有可剪原子），
     *  任一区间不合格则**静默剔除该区间**（而非整体失败）——手动入口的语义是"能剪多少剪多少"。
     *  返回 null = 全部区间都被剔除（无可剪内容），调用方据此显示 "No compactable history yet."。
     *  P5 Wave 3 第 4 步：实现迁 prune-tx.compactRegions（this → host 窄接口），本方法变薄编排。 */
    compactRegions(ranges, agent, signal) {
        return compactRegions(this, ranges, agent, signal);
    }
    /** 一笔事务剪多个极大连续区间：start → summary → 每区间 checkpoint replace → end。
     *  tombstone 类型（2026-08-23 半拆组）：'user' = 普通/闭包墓碑文本；'tool' = tool/result
     *  占位墓碑（克隆原 R data、只改 tool-result block 的 inner text，保留 callId/isError/role/id
     *  ——dsh assertToolResultRewrite 只允许改 inner text），配对 issuer A 的 tool_calls 防 400。 */
    pruneIntervals(session, intervals, semanticEdges, candidateCount, forced, tombstones, summaryKind) {
        // P5 Wave 3 第 4 步：实现迁 prune-tx.pruneIntervals（this → host 窄接口），本方法变薄编排。
        return pruneIntervals(this, session, intervals, semanticEdges, candidateCount, forced, tombstones, summaryKind);
    }
    /**
     * A7 事务账目重建：resume 时从 append-only 日志扫描 compaction/start、compaction/prune、
     * compaction/end 事件重建 records/prunedNodeIndex/shadowedSeqsOf 状态；无 end 的 start 记 warn。
     * 不引入 WAL——日志本身即账目。幂等：已重建过的 compactionId 跳过（rebuiltCompactionIds 去重），
     * 使「setSession 自动重建」与「测试显式清空 records 后再重建」两种路径都安全。
     */
    rebuildLedgerFromLog() {
        // P5 Wave 3 第 4 步：实现迁 session-lifecycle.rebuildLedgerFromLog（this → host 窄接口），本方法变薄编排。
        rebuildLedgerFromLog(this);
    }
}
export default ArgpGraphEngine;
