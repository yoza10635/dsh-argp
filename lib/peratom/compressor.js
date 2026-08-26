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
 *  - 防重复 turn 处理：prepare 阶段按 (session, turn) 记账，重复 idle / pre-step 幂等跳过。
 *  - `compressCurrentTurn(session)` 公开入口：立即收集+调用+发射（P4 溢出三步路径②与单测用），
 *    绕过两段式延迟。
 *
 * 单次调用覆盖当轮全部可压原子（user quotes 拆分 + tool extract/summary），OpenAI 兼容
 * fetch + JSON Schema 强制输出（复用 spike 30/32 模式；response_format 被端点拒绝时
 * 自动降级为裸 prompt + 防御性 JSON 提取——spike 32 extractJson 同款）。
 *
 * 无再压缩路径（决策⑦）：collect 只取"原始态"原子——已是 U-info/replace 副本的 seq 直接跳过；
 * 版本链成员硬排除（gate 决策序①）；被中断轮次整轮排除（filterInterruptedAtoms 内嵌）。
 */
import { randomUUID } from 'node:crypto';
import { CompactionId } from '@deepseek-ai/dsh-compaction';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { ARG_NS, SPLIT_THRESHOLD_CHARS } from './types.js';
import { buildDialogText, buildInfoText, resolveSplit } from './split.js';
import { DEFAULT_SMALL_RESULT_CHARS, buildToolNameIndex, buildVersionChainIndex, collectInterruptedTurns, fidelityGuard, filterInterruptedAtoms, projectSurfaceText, rNeedCompress, turnCompressible, userIsLong, } from './gate.js';
/** 插件署名（dialog replace / U-info append 副本的 message.source.plugin）。 */
const PLUGIN_NAME = 'dsh-argp';
/**
 * 缺省端点解析：ARGP_MODEL_SOURCE=qwen-local → QWEN_BASE/QWEN_MODEL（本地推理）；
 * 否则 DeepSeek 生产端点 + DEEPSEEK_API_KEY。apiKey 缺失 → disabled（静默跳过，
 * 开发/离线环境零网络副作用）。
 */
export function defaultEndpoint(env = process.env) {
    if (env['ARGP_MODEL_SOURCE'] === 'qwen-local') {
        return {
            endpoint: (env['QWEN_BASE'] ?? 'http://127.0.0.1:8080/v1') + '/chat/completions',
            model: env['QWEN_MODEL'] ?? 'Qwen3.8-27B',
            apiKey: env['DEEPSEEK_API_KEY'] ?? 'dummy-local',
        };
    }
    const apiKey = env['DEEPSEEK_API_KEY'];
    if (apiKey === undefined || apiKey === '')
        return null;
    return {
        endpoint: env['DEEPSEEK_BASE'] !== undefined ? env['DEEPSEEK_BASE'] + '/chat/completions' : 'https://api.deepseek.com/chat/completions',
        model: env['DEEPSEEK_MODEL'] ?? 'deepseek-v4-flash',
        apiKey,
    };
}
const OUTPUT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['splits', 'tools'],
    properties: {
        splits: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['seq', 'quotes'],
                properties: {
                    seq: { type: 'integer' },
                    quotes: { type: 'array', items: { type: 'string' } },
                },
            },
        },
        tools: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['seq', 'level', 'text'],
                properties: {
                    seq: { type: 'integer' },
                    level: { type: 'string', enum: ['extract', 'summary'] },
                    text: { type: 'string' },
                },
            },
        },
    },
};
/**
 * 防御性 JSON 提取（spike 32 extractJson 原样复刻）：剥 <think>、剥代码围栏、
 * 从最后一个 } 向前找配对 {。response_format 失效的端点上兜底。
 */
function extractJson(raw) {
    const cleaned = raw.replace(/<think>[\s\S]*?<\/think>/g, '');
    const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(cleaned);
    const text = (fenced?.[1] ?? cleaned).trim();
    try {
        return JSON.parse(text);
    }
    catch { /* fall through */ }
    const last = text.lastIndexOf('}');
    if (last > 0) {
        for (let first = text.lastIndexOf('{', last - 1); first >= 0; first = text.lastIndexOf('{', first - 1)) {
            try {
                return JSON.parse(text.slice(first, last + 1));
            }
            catch { /* keep scanning */ }
        }
    }
    return undefined;
}
/** 模型输出 → CompressDecision（信任边界：seq/quotes/level/text 全字段校验，异形丢弃）。 */
export function normalizeDecision(cand) {
    if (cand === null || typeof cand !== 'object')
        return null;
    const o = cand;
    if (!Array.isArray(o.splits) && !Array.isArray(o.tools))
        return null;
    const splits = [];
    const tools = [];
    for (const item of Array.isArray(o.splits) ? o.splits : []) {
        const seq = item?.seq;
        const quotes = item?.quotes;
        if (typeof seq !== 'number' || !Number.isInteger(seq))
            continue;
        if (!Array.isArray(quotes))
            continue;
        splits.push({ seq, quotes: quotes.filter((q) => typeof q === 'string') });
    }
    for (const item of Array.isArray(o.tools) ? o.tools : []) {
        const t = item;
        if (typeof t?.seq !== 'number' || !Number.isInteger(t.seq))
            continue;
        if (t.level !== 'extract' && t.level !== 'summary')
            continue;
        if (typeof t.text !== 'string' || t.text.length === 0)
            continue;
        tools.push({ seq: t.seq, level: t.level, text: t.text });
    }
    return { splits, tools };
}
/** user/message 副本载荷：plugin 署名；meta 存在时挂 data[ARG_NS]（U-info 标记 + summary）。 */
function userCopyPayload(text, meta) {
    const msg = createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'plugin', plugin: PLUGIN_NAME },
    });
    if (meta === undefined)
        return msg;
    return { ...msg, [ARG_NS]: { info: true, sourceSeq: meta.sourceSeq, summary: meta.summary } };
}
/**
 * tool/result replace 副本载荷。dsh-session 硬约束："tool/result surface replacement
 * may change only content"——替换数据与原文除 message.content[0].content 外必须逐键
 * 深度相等，因此**不能**携带 data[ARG_NS] 元数据（多余键即拒绝）。
 * summary 语义由副本正文本身承载；P3 recall_summary 对无 data[ARG_NS].summary 的节点
 * 按设计降级返回 extract 副本文本，信息无损。防再压缩由版本链索引天然兜住：
 * 原文与副本同 (tool|args) 键 → 计数 ≥2 → 双双硬排除。
 */
function toolCopyPayload(origData, text) {
    const d = origData;
    const block = d?.message?.content?.[0];
    if (block === undefined || typeof block !== 'object') {
        throw new Error('peratom-compressor: cannot rewrite tool/result without a content block');
    }
    return {
        ...d,
        message: {
            ...d?.message,
            content: [{ ...block, content: [{ type: 'text', text }] }],
        },
    };
}
/**
 * 引擎侧规划：模型输出过信任边界（seq 必须命中本轮收集集，先到先得去重），
 * 用户消息过 resolveSplit 全套保守策略（定位失败回退 dialog / 覆盖率翻转 / 空隙归 info）。
 * 返回落盘步骤序列；steps 为空 = 本轮无可落地动作（不开发务括号）。
 */
export function planReplacements(collect, decision, events) {
    const userBySeq = new Map(collect.userLong.map(u => [u.seq, u]));
    const toolBySeq = new Map(collect.toolResults.map(t => [t.seq, t]));
    const steps = [];
    let replaces = 0;
    let skippedFallbackDialog = 0;
    let skippedFidelity = 0;
    const fidelityMissing = [];
    const summaryDropped = [];
    let anomalies = 0;
    const seenUserSeqs = new Set();
    for (const split of decision.splits) {
        const atom = userBySeq.get(split.seq);
        if (atom === undefined) {
            anomalies += 1;
            continue;
        }
        if (seenUserSeqs.has(split.seq)) {
            anomalies += 1;
            continue;
        }
        seenUserSeqs.add(split.seq);
        const res = resolveSplit(atom.text, split.quotes);
        if (res.kind === 'split') {
            const dialogText = buildDialogText(atom.text, res.dialogSpans);
            const infoText = buildInfoText(atom.text, res.infoSpans);
            steps.push({
                kind: 'replace',
                type: 'user/message',
                at: atom.seq,
                data: userCopyPayload(dialogText),
                sourceEventSeqs: [atom.seq],
            });
            replaces += 1;
            // U-info append：tail-only 管线（flush 窗口内恰落在当轮尾部）；原文天然留日志。
            steps.push({
                kind: 'append',
                type: 'user/message',
                at: atom.seq,
                data: userCopyPayload(infoText, { sourceSeq: atom.seq, summary: infoText }),
                sourceEventSeqs: [atom.seq],
            });
        }
        else if (res.kind === 'info-only') {
            // 零标注退化：整条 U-info 单事件 replace（纯资料消息的自然情形，非特判）。
            steps.push({
                kind: 'replace',
                type: 'user/message',
                at: atom.seq,
                data: userCopyPayload(atom.text, { sourceSeq: atom.seq, summary: atom.text }),
                sourceEventSeqs: [atom.seq],
            });
            replaces += 1;
        }
        else {
            // fallback-dialog / unsplit（覆盖率翻转、无余量、空消息）：放弃拆分，整条保留 dialog。
            skippedFallbackDialog += 1;
        }
    }
    const origDataBySeq = new Map();
    for (const event of events) {
        if (event.type === 'tool/result')
            origDataBySeq.set(event.seq, event.data);
    }
    const seenToolSeqs = new Set();
    for (const action of decision.tools) {
        const atom = toolBySeq.get(action.seq);
        if (atom === undefined) {
            anomalies += 1;
            continue;
        }
        if (seenToolSeqs.has(action.seq)) {
            anomalies += 1;
            continue;
        }
        seenToolSeqs.add(action.seq);
        // 保真守卫（spike 34 驱动）：原文的高信号 token 必须在副本里 verbatim 存活。
        // level-aware 分级（spike36 复盘驱动）：extract 维持硬拒——缺任一 token 即拒绝替换、
        // 原文保面（错误方向只允许往"少压"错）；summary 是模型自选的概括档，概括天然
        // 会丢精确串，硬拒会让该档位永远不可用——改为审计式放行：缺失清单入账
        // summaryDropped，供 LLM 审核 / 人工审核事后评判。
        const guard = fidelityGuard(atom.text, action.text);
        if (!guard.ok) {
            if (action.level === 'summary') {
                summaryDropped.push(...guard.missing);
            }
            else {
                skippedFidelity += 1;
                fidelityMissing.push(...guard.missing);
                continue;
            }
        }
        steps.push({
            kind: 'replace',
            type: 'tool/result',
            at: action.seq,
            data: toolCopyPayload(origDataBySeq.get(action.seq), action.text),
            sourceEventSeqs: [action.seq],
        });
        replaces += 1;
    }
    return { steps, replaces, skippedFallbackDialog, skippedFidelity, fidelityMissing, summaryDropped, anomalies };
}
// ---------------------------------------------------------------------------
// Prompt（单次调用覆盖当轮全部可压原子；规则前言吸收 P0 三层对冲 + 已知债务 6 修正）
// ---------------------------------------------------------------------------
const PROMPT_RULES = [
    '你是会话压缩器。输入列出本轮全部可压缩原子，你的输出决定它们的压缩形态。',
    '',
    '## 用户长消息拆分（splits）',
    '- 把每条用户消息划分为指令(dialog)片段与资料(info)余量：指令=用户要求做的事、提出的问题、约束或偏好（包括"注意X""别动Y""用Z"限定语）；资料=粘贴的日志、代码、配置、报错、文档引用。',
    '- quotes 数组逐字抄写每段连续指令原文：必须与原文完全一致（空白、换行、标点、大小写、全角半角、emoji），禁止改写、翻译、增删任何字符。',
    '- 片段按原文出现顺序排列；同一段连续指令不要拆成多段，不相邻的指令不要合并成一段。',
    '- 保守纪律：任何可能包含指令语义的片段都必须抄入 quotes——错误方向只允许往 dialog 错；存档/转发类引导语算资料。',
    '- 未抄写的部分视为资料，会被聚合成可压缩副本。',
    '',
    '## 工具结果压缩（tools）',
    '- 对每个原子先做二选一判断，再把判断和压缩内容写进同一条 {"seq","level","text"}：',
    '- 判断为摘取（level="extract"）：内容含结构化数据或精确串（日志行、配置、代码、命令输出），关键信息依赖原文措辞 → text 必须是所选原文片段的逐字完整拷贝——与原文完全一致（空白、换行、标点、大小写、全角半角、emoji 全部原样），禁止改写、翻译、增删、合并或重新组织任何字符；未选中的行视为噪声直接丢弃。',
    '- 判断为摘要（level="summary"）：内容是冗长叙述性文本、概括不损失关键信息 → text 用简洁概括替换全文；若原文仍有个别必须精确保留的串（错误码、标识符、路径等），把它们原样写进概括文本。',
    '- 两种档位由你按每个原子的内容性质自行判断，不必统一；拿不准时选 extract（宁可多抄原文，不要自己组织语言）。',
    '',
    '## 输出',
    '只输出一个 JSON 对象：{"splits":[{"seq":<整数>,"quotes":["…"]}],"tools":[{"seq":<整数>,"level":"extract"|"summary","text":"…"}]}',
    '- seq 原样返回输入给出的值；不需要压缩的原子不要出现在输出里（视为保原文）。',
].join('\n');
function buildPrompt(collect) {
    const atoms = [];
    for (const u of collect.userLong) {
        atoms.push(`<ATOM seq=${u.seq} kind="user-long">\n${u.text}\n</ATOM>`);
    }
    for (const t of collect.toolResults) {
        atoms.push(`<ATOM seq=${t.seq} kind="tool-result">\n${t.text}\n</ATOM>`);
    }
    return PROMPT_RULES + '\n\n' + atoms.join('\n\n');
}
async function postChat(fetchImpl, ep, prompt, timeoutMs, useJsonSchema, chatTemplateKwargs) {
    const body = {
        model: ep.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
    };
    if (useJsonSchema) {
        // JSON Schema 强制输出：支持结构化解码的端点上消灭自由生成失控（plan 已知债务 7 的
        // "服务端 schema 约束"路径）；strict=true 要求全部字段受 schema 约束。
        body['response_format'] = {
            type: 'json_schema',
            json_schema: { name: 'argp_peratom_turn', strict: true, schema: OUTPUT_SCHEMA },
        };
    }
    if (chatTemplateKwargs !== undefined && Object.keys(chatTemplateKwargs).length > 0) {
        body['chat_template_kwargs'] = chatTemplateKwargs;
    }
    const res = await fetchImpl(ep.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ep.apiKey}` },
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify(body),
    });
    if (!res.ok)
        throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json = await res.json();
    return json.choices?.[0]?.message?.content ?? '';
}
/** 日志尾部的 open turn（flush 时刻 compaction 括号的 owner；null=standalone）。 */
function detectOpenTurn(session) {
    for (let index = session.events.length - 1; index >= 0; index -= 1) {
        const event = session.events[index];
        if (event === undefined)
            continue;
        if (event.type === 'turn/start')
            return event.data.turn;
        if (event.type === 'turn/end')
            return null;
    }
    return null;
}
export class PeratomCompressor {
    static inject = [];
    splitThresholdChars;
    smallResultChars;
    timeoutMs;
    chatTemplateKwargs;
    endpoint;
    fetchImpl;
    ctx;
    /** LLM 压缩调用计数器（纯 dialog 轮零调用的断言读这里）。 */
    _calls = 0;
    get calls() { return this._calls; }
    /** 全部压缩尝试记录（时间序）。 */
    records = [];
    /** 当前暂存待发射的事务数（测试/P4 判断 stash 是否就绪）。 */
    get pendingCount() { return this.pending.length; }
    /** 防重复 turn 处理：(session, turn) 记账于 prepare 阶段。 */
    doneTurns = new WeakMap();
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
        return { smallResultChars: this.smallResultChars, toolPolicies: this.toolPolicies };
    }
    constructor(ctx, config = {}) {
        this.ctx = ctx;
        this.endpoint = config.endpoint !== undefined
            ? {
                endpoint: config.endpoint,
                model: config.model ?? 'deepseek-v4-flash',
                apiKey: config.apiKey ?? '',
            }
            : (config.apiKey !== undefined ? { endpoint: config.endpoint ?? 'https://api.deepseek.com/chat/completions', model: config.model ?? 'deepseek-v4-flash', apiKey: config.apiKey } : defaultEndpoint());
        this.splitThresholdChars = config.splitThresholdChars ?? SPLIT_THRESHOLD_CHARS;
        this.smallResultChars = config.smallResultChars ?? DEFAULT_SMALL_RESULT_CHARS;
        this.timeoutMs = config.timeoutMs ?? 180_000;
        this.chatTemplateKwargs = config.chatTemplateKwargs;
        if (config.toolPolicies !== undefined) {
            for (const [name, policy] of config.toolPolicies)
                this.toolPolicies.set(name, policy);
        }
        this.fetchImpl = config.fetchImpl ?? ((...args) => fetch(...args));
        if (this.endpoint === null) {
            ctx.logger.warn('peratom-compressor: no LLM endpoint resolved (set DEEPSEEK_API_KEY or pass config); compressor disabled');
        }
        // 触发钩子：轮末 idle（当轮必已闭）→ 收集 + LLM（异步，不阻塞状态切换）。
        ctx.on('agent/status', ({ agent, status }) => {
            if (status !== 'idle')
                return;
            void this.prepareCurrentTurn(agent.session).catch(error => {
                this.ctx.logger.warn(`peratom-compressor prepare failed: ${error instanceof Error ? error.message : String(error)}`);
            });
        });
        // 发射窗口：下一次 agent/pre-step（open turn 已开、新 user/message 未落盘）。
        // 只 flush 已就绪条目，绝不 await 网络——waterfall 内同步追加后立刻放行。
        ctx.on('agent/pre-step', async ({ agent }, next) => {
            this.flushStashed(agent.session);
            return next();
        });
    }
    // -- 收集 ---------------------------------------------------------------
    /**
     * 收集当前（最新闭合）轮的可压原子。内嵌三道确定性过滤：
     * ① 中断轮整轮排除（filterInterruptedAtoms，interrupted=true 时数组恒空）；
     * ② 版本链成员硬排除（决策④，need_compress=false）；③ 大小启发式门控。
     * 无再压缩路径：U-info 副本 / plugin checkpoint 一律跳过（决策⑦）。
     */
    collectCurrentTurn(session) {
        const events = session.events;
        let closed = null;
        for (let i = events.length - 1; i >= 0; i -= 1) {
            const event = events[i];
            if (event?.type === 'turn/end') {
                closed = event.data.turn;
                break;
            }
        }
        if (closed === null)
            return null;
        // 归轮按位置：user/message 事件不携带 turn 字段（rc.2 类型），其归属 =
        // 当前开放的 turn（turn/start..end 之间的日志区间）。assistant/tool 事件自带
        // turn 字段做二次校验。替换副本（dialog/U-info/tool copy）落在本窗口内的，
        // 由 plugin-source 跳过 / 版本链同键硬排除兜住，不会被误当原始态原子。
        const turnEvents = [];
        let startSeq = Number.MAX_SAFE_INTEGER;
        let endSeq = -1;
        let open = null;
        for (const event of events) {
            if (event.type === 'turn/start') {
                open = event.data.turn;
                continue;
            }
            if (event.type === 'turn/end') {
                open = null;
                continue;
            }
            if (open !== closed)
                continue;
            if (event.type !== 'user/message') {
                const turn = event.data?.turn;
                if (typeof turn === 'number' && turn !== closed)
                    continue;
            }
            turnEvents.push(event);
            if (event.seq < startSeq)
                startSeq = event.seq;
            if (event.seq > endSeq)
                endSeq = event.seq;
        }
        if (endSeq < 0)
            return null;
        const interrupted = collectInterruptedTurns(events).has(closed);
        const collect = {
            turn: closed,
            startSeq,
            endSeq,
            interrupted,
            userLong: [],
            toolResults: [],
        };
        if (interrupted)
            return collect;
        // 中断过滤作用于投影前的原始事件流：被标记轮次的残留原子不进候选。
        const chain = buildVersionChainIndex(events);
        const nameByCall = buildToolNameIndex(events);
        const rawAtoms = [];
        for (const event of turnEvents) {
            const data = event.data;
            if (event.type === 'user/message') {
                // 无再压缩路径：U-info 聚合副本已是压缩态；plugin 无标记副本是 checkpoint/X。
                const source = data?.source?.kind;
                if (source === 'plugin')
                    continue;
                const text = projectSurfaceText(event);
                if (userIsLong(text, this.splitThresholdChars)) {
                    rawAtoms.push({ kind: 'user-long', seq: event.seq, turn: closed, text });
                }
                continue;
            }
            if (event.type === 'tool/result') {
                const callId = data?.message?.source?.callId;
                const text = projectSurfaceText(event);
                // 工具种类名（callId→name 反查）：tool 对照表 / 作者声明的查找键（设计 §6-2）。
                const toolName = callId !== undefined ? nameByCall.get(callId) : undefined;
                rawAtoms.push({ kind: 'tool-result', seq: event.seq, turn: closed, text, callId, toolName });
            }
            // assistant/message 不压缩（设计 §1）。
        }
        const survivors = filterInterruptedAtoms(rawAtoms, events);
        for (const atom of survivors) {
            if (atom.kind === 'user-long') {
                collect.userLong.push(atom);
            }
            else if (rNeedCompress(atom, chain, this.gateOptions()) !== false) {
                collect.toolResults.push(atom);
            }
        }
        return collect;
    }
    // -- 两段式：idle 准备 → pre-step 发射 ----------------------------------
    /** idle 触发段：记账防重 → 收集 → 门控 → LLM → 暂存待发射。返回观测记录。 */
    async prepareCurrentTurn(session) {
        const collect = this.collectCurrentTurn(session);
        if (collect === null)
            return null;
        const done = this.doneTurns.get(session) ?? new Set();
        this.doneTurns.set(session, done);
        if (done.has(collect.turn))
            return null; // 防重复 turn 处理
        done.add(collect.turn);
        const chain = buildVersionChainIndex(session.events);
        if (collect.interrupted) {
            const record = { at: new Date().toISOString(), turn: collect.turn, called: false, skipReason: 'interrupted' };
            this.records.push(record);
            return record; // 中断轮：error/aborted 收尾，半成品不进候选（宁全勿漏）
        }
        if (!turnCompressible([...collect.userLong, ...collect.toolResults], chain, this.gateOptions())) {
            const record = { at: new Date().toISOString(), turn: collect.turn, called: false, skipReason: 'no-candidate' };
            this.records.push(record);
            return record; // 纯 dialog / 版本链成员 / 全小结果：零调用短路
        }
        return this.callAndStash(session, collect);
    }
    /** 发射段：把该 session 的全部就绪事务落入下一次 open-turn 窗口（同步追加，吞错记账）。 */
    flushStashed(session) {
        while (true) {
            const idx = this.pending.findIndex(e => e.session === session);
            if (idx < 0)
                return;
            const [entry] = this.pending.splice(idx, 1);
            try {
                this.flushEntry(entry.session, entry.collect, entry.decision, entry.record);
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                this.ctx.logger.warn(`peratom-compressor flush failed: ${message}`);
                this.records.push({ at: new Date().toISOString(), turn: entry.collect.turn, called: true, error: message });
            }
        }
    }
    /** 公开入口（P4 溢出三步路径② / 单测）：立即收集+调用+发射，绕过两段式延迟。 */
    async compressCurrentTurn(session) {
        const collect = this.collectCurrentTurn(session);
        if (collect === null)
            return null;
        const done = this.doneTurns.get(session) ?? new Set();
        this.doneTurns.set(session, done);
        if (done.has(collect.turn))
            return null;
        done.add(collect.turn);
        const chain = buildVersionChainIndex(session.events);
        if (collect.interrupted) {
            const record = { at: new Date().toISOString(), turn: collect.turn, called: false, skipReason: 'interrupted' };
            this.records.push(record);
            return record;
        }
        if (!turnCompressible([...collect.userLong, ...collect.toolResults], chain, this.gateOptions())) {
            const record = { at: new Date().toISOString(), turn: collect.turn, called: false, skipReason: 'no-candidate' };
            this.records.push(record);
            return record;
        }
        const entry = await this.callAndStash(session, collect);
        this.flushStashed(session);
        return entry;
    }
    // -- LLM 调用与暂存 ------------------------------------------------------
    async callAndStash(session, collect) {
        const record = { at: new Date().toISOString(), turn: collect.turn, called: true };
        this.records.push(record);
        if (this.endpoint === null) {
            record.error = 'no-endpoint';
            return record;
        }
        this._calls += 1;
        const started = Date.now();
        try {
            const prompt = buildPrompt(collect);
            record.atomSeqs = {
                userLong: collect.userLong.map(u => u.seq),
                toolResults: collect.toolResults.map(t => t.seq),
            };
            let raw;
            let ms = Date.now() - started;
            try {
                raw = await postChat(this.fetchImpl, this.endpoint, prompt, this.timeoutMs, true, this.chatTemplateKwargs);
                ms = Date.now() - started;
            }
            catch (schemaError) {
                // response_format 被端点拒绝/网络抖动：spike 30/32 兼容模式重试一次（裸 prompt）。
                raw = await postChat(this.fetchImpl, this.endpoint, prompt, this.timeoutMs, false, this.chatTemplateKwargs);
                ms = Date.now() - started;
                record.anomalies = (record.anomalies ?? 0) + 1;
                void schemaError;
            }
            record.ms = ms;
            record.rawResponse = raw;
            const decision = normalizeDecision(extractJson(raw));
            if (decision === null) {
                record.parseFailed = true;
                return record; // 解析失败静默跳过：本轮保原文（安全方向），绝不阻断会话
            }
            record.decision = decision;
            this.pending.push({ session, collect, decision, record });
        }
        catch (error) {
            record.error = error instanceof Error ? error.message : String(error);
        }
        return record;
    }
    // -- 事务括号发射（仿 t1：start..end，双事件/多事件发射，断言内联）-------
    flushEntry(session, collect, decision, record) {
        const plan = planReplacements(collect, decision, session.events);
        if (plan.steps.length === 0) {
            // 全部动作被拒（保真守卫/回退）或零动作：不开空事务，但统计直接落账到本次记录。
            record.skippedFallbackDialog = plan.skippedFallbackDialog;
            record.skippedFidelity = plan.skippedFidelity;
            if (plan.summaryDropped.length > 0)
                record.summaryDropped = plan.summaryDropped;
            record.fidelityMissing = plan.fidelityMissing;
            record.anomalies = (record.anomalies ?? 0) + plan.anomalies;
            return;
        }
        const openTurn = detectOpenTurn(session);
        const compactionId = CompactionId('argp-peratom-' + randomUUID());
        const lifecycle = { compactionId, turn: openTurn };
        const genBefore = session.surface.replaceGeneration;
        session.append('compaction/start', lifecycle);
        try {
            let replaceCount = 0;
            for (const step of plan.steps) {
                // 断言 1：sourceEventSeqs ⊆ 当轮区间（越界即 bug，plan P1 硬性要求）。
                for (const seq of step.sourceEventSeqs) {
                    if (seq < collect.startSeq || seq > collect.endSeq) {
                        throw new Error(`sourceEventSeq ${seq} outside current turn range [${collect.startSeq}, ${collect.endSeq}] (turn ${collect.turn})`);
                    }
                }
                if (step.kind === 'replace') {
                    const g0 = session.surface.replaceGeneration;
                    session.append(step.type, step.data, {
                        surfaceOp: { op: 'replace', start: step.at, end: step.at },
                        sourceEventSeqs: step.sourceEventSeqs,
                    });
                    const g1 = session.surface.replaceGeneration;
                    // 断言 2：每次 replace 必须推进 replaceGeneration（替换真实落地）。
                    if (g1 <= g0) {
                        throw new Error(`replaceGeneration did not advance after replacing seq ${step.at} (${g0} -> ${g1})`);
                    }
                    replaceCount += 1;
                }
                else {
                    session.append(step.type, step.data, {
                        surfaceOp: 'append',
                        sourceEventSeqs: step.sourceEventSeqs,
                    });
                }
            }
            session.append('compaction/end', lifecycle);
            // 断言 2b：整事务代数增量 === replace 步数（append 步不推进代数）。
            const delta = session.surface.replaceGeneration - genBefore;
            if (delta !== replaceCount) {
                throw new Error(`replaceGeneration delta ${delta} != planned replaces ${replaceCount}`);
            }
            // 统计在事务成功落地后记账（失败路径由 flushStashed 的 error 记录承载）。
            record.appliedReplaces = replaceCount;
            record.skippedFallbackDialog = plan.skippedFallbackDialog;
            record.skippedFidelity = plan.skippedFidelity;
            if (plan.summaryDropped.length > 0)
                record.summaryDropped = plan.summaryDropped;
            record.fidelityMissing = plan.fidelityMissing;
            record.anomalies = (record.anomalies ?? 0) + plan.anomalies;
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            try {
                session.append('compaction/end', { ...lifecycle, error: message });
            }
            catch {
                // 关闭失败保留未配对 start，可被 inspectCompactionEntryState 检出（t1 同纪律）
            }
            throw error;
        }
    }
}
export default PeratomCompressor;
