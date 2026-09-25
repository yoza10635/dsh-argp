import { appendFileSync } from 'node:fs';
import { buildToolNameIndex, buildVersionChainIndex, collectInterruptedTurns, projectSurfaceText, turnCompressible, userIsLong, } from './gate.js';
import { mainChainReasoningEffort, sessionEvents, turnOf } from '../log-access.js';
import { SPLIT_THRESHOLD_CHARS, isOwnSourceKind } from './types.js';
import { DEFAULT_LLM_TIMEOUT_MS, DEFAULT_PREFIX_BUDGET_TOKENS } from '../constants.js';
import { DEFAULT_TELEMETRY_CAP, pushBounded } from '../telemetry.js';
import { completeViaDshLlm } from './llm-adapter.js';
import { autoDshLlmSpec } from './llm-adapter.js';
import { serializeWireMessages, serializeWireTools } from './llm-adapter.js';
/** 声明窗口（plan P2 决策⑥起步值）：当轮行为原子 + 近 N 轮数据原子。 */
export const CITATION_WINDOW_TURNS = 10;
/** 声明边缓存上限（超限按插入序淘汰最旧；会话生命周期内的边总量有界）。 */
const MAX_CACHED_EDGES = 512;
/** prompt 内单原子文本上限（引用判定只需头尾关键内容，防窗口 prompt 膨胀）。 */
const PROMPT_ATOM_CHAR_CAP = 1500;
const LEVELS = ['critical', 'supporting', 'contextual'];
/**
 * 缺省端点解析：与 PeratomCompressor 同口径（ARGP_MODEL_SOURCE=qwen-local → 本地；
 * 否则 DeepSeek 生产端点）。apiKey 缺失 → disabled（静默跳过，零网络副作用）——
 * declarer 可独立关闭（plan P2 验收判据 3 的"不挂载"路径）。
 */
export function citeDeclarerDefaultEndpoint(env = process.env) {
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
// ---------------------------------------------------------------------------
// 结构化输出契约（JSON Schema 强制 + 防御性提取双保险，compressor 同款）
// ---------------------------------------------------------------------------
const OUTPUT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['cites'],
    properties: {
        cites: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['fromSeq', 'toSeq', 'level'],
                properties: {
                    fromSeq: { type: 'integer' },
                    toSeq: { type: 'integer' },
                    level: { type: 'string', enum: ['critical', 'supporting', 'contextual'] },
                },
            },
        },
    },
};
/**
 * 防御性 JSON 提取（compressor extractJson 同款）：剥推理块、剥代码围栏、
 * 从最后一个 } 向前找配对 {。response_format 失效的端点上兜底。
 * （推理块标签在正则内用 unicode 转义书写，避免源码字面序列干扰文本工具。）
 */
function extractJson(raw) {
    const cleaned = raw.replace(/\u003cthink[\s\S]*?\u003c\/think\u003e/g, '');
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
/**
 * 模型输出 → DeclaredCite[]（信任边界）：fromSeq 必须在 isFrom 集合、toSeq 必须在 isTo
 * 集合、from≠to、level 三档；越界 / 异形边丢弃并计入 invalid。同 (from,to) 重复合并
 * 保留最高 level（critical > supporting > contextual）。
 */
export function normalizeCites(cites, fromSeqs, toSeqs) {
    const rank = { critical: 3, supporting: 2, contextual: 1 };
    const best = new Map();
    let invalid = 0;
    for (const item of cites) {
        const c = (item === null || typeof item !== 'object')
            ? undefined
            : item;
        const fromSeq = c?.fromSeq;
        const toSeq = c?.toSeq;
        if (typeof fromSeq !== 'number' || !Number.isInteger(fromSeq)) {
            invalid += 1;
            continue;
        }
        if (typeof toSeq !== 'number' || !Number.isInteger(toSeq)) {
            invalid += 1;
            continue;
        }
        if (fromSeq === toSeq) {
            invalid += 1;
            continue;
        }
        if (!fromSeqs.has(fromSeq) || !toSeqs.has(toSeq)) {
            invalid += 1;
            continue;
        }
        const level = c?.level;
        if (typeof level !== 'string' || !LEVELS.includes(level)) {
            invalid += 1;
            continue;
        }
        const key = fromSeq + '->' + toSeq;
        const prev = best.get(key);
        const levelValue = level; // includes 校验已过，窄化不可达
        if (prev === undefined || rank[levelValue] > rank[prev.level]) {
            best.set(key, { fromSeq, toSeq, level: levelValue });
        }
    }
    return { cites: [...best.values()], invalid };
}
// ---------------------------------------------------------------------------
// Prompt（单次调用覆盖当轮行为原子 × 近轮数据原子；保守纪律 = 宁漏勿错）
// ---------------------------------------------------------------------------
const PROMPT_RULES = [
    '你是会话引用分析器。输入列出两类原子：',
    '- side="from"：当轮行为原子（role="current"，kind=user/assistant）——引用方；',
    '- side="to"：近轮窗口数据原子（role="prior"，kind=user/tool-result）——被引用方。',
    '',
    '## 任务',
    '对每个 from 原子，判断它引用或依赖了哪些 to 原子：当前用户消息复述/复用早先轮次的内容（数字、路径、日志行、结论），或当前助手回复基于早先工具输出 / 用户提供的资料做总结、引用、延续处理。',
    '',
    '## level 三档',
    '- critical：to 原子被 from 原子直接引用或逐字引用（精确串、数字、路径、错误码）——摘掉 to 原子则 from 原子的含义完全不可读；',
    '- supporting：from 原子的结论或处理依赖 to 原子，但含义仍可理解；',
    '- contextual：仅松散背景相关（话题延续），可任意时刻摘除。',
    '拿不准时降档或不声明。',
    '',
    '## 纪律',
    '- 只声明真实引用；不确定相关就不声明（to 原子未出现在任何引用中 = 视为无引用，安全方向）。',
    '- fromSeq 只能取 side="from" 列表出现的 seq，toSeq 只能取 side="to" 列表出现的 seq；seq 原样返回输入给出的值。',
    '',
    '## 输出',
    '只输出一个 JSON 对象：{"cites":[{"fromSeq":<整数>,"toSeq":<整数>,"level":"critical"|"supporting"|"contextual"}]}',
].join('\n');
function buildCitePrompt(atoms) {
    const lines = [];
    for (const a of atoms) {
        lines.push(`<ATOM seq=${a.seq} role="${a.role}" side="${a.isFrom ? 'from' : 'to'}" kind="${a.kind}">\n${a.text}\n</ATOM>`);
    }
    return PROMPT_RULES + '\n\n' + lines.join('\n\n');
}
/**
 * A 形态（设计文档 §4 tail-only 语义，与 compressor 同款）：引用声明调用站在
 * agent 链延长线上——`[...agent 当前 deriveMessages() 的 wire 渲染, {user: 声明指令}]`。
 * ctk 由调用方解析（resolveEffectiveCtk：继承主链 requestHeader ctk +
 * enable_thinking:false 覆盖，2026-09-19 方案 B 定案——同态渲染 = 继承主链；
 * 强制 pt:true 已证实更差：LCP 12.7% < pt:false 30.3%）。前缀预算门控与
 * compressor 同款（超预算该次降级 C）。
 */
async function postChat(fetchImpl, ep, prompt, timeoutMs, useJsonSchema, chatTemplateKwargs, 
/** A 形态前缀（serializeWireMessages 产物）；缺省 = C 形态独立 one-shot。 */
contextWire, 
/** A 形态 tools 透传（requestHeader().tools 的 wire 渲染）。 */
contextTools, 
/** 输出 cap（token）。cites 输出通常几百 token；小 cap 给 prompt 让出 margin。 */
maxCompletionTokens) {
    const body = {
        model: ep.model,
        messages: contextWire !== undefined
            ? [...contextWire, { role: 'user', content: prompt }]
            : [{ role: 'user', content: prompt }],
        temperature: 0,
    };
    if (maxCompletionTokens !== undefined)
        body['max_completion_tokens'] = maxCompletionTokens;
    if (contextTools !== undefined)
        body['tools'] = contextTools;
    if (useJsonSchema) {
        // JSON Schema 强制输出：支持结构化解码的端点上消灭自由生成失控（与 compressor 同策略）。
        body['response_format'] = {
            type: 'json_schema',
            json_schema: { name: 'argp_cite_declarer', strict: true, schema: OUTPUT_SCHEMA },
        };
    }
    // ctk 由调用方解析（resolveEffectiveCtk）；此处不再强制 preserve_thinking
    //（2026-09-19 定案，见头注）。
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
function capPromptText(text) {
    return text.length > PROMPT_ATOM_CHAR_CAP
        ? text.slice(0, PROMPT_ATOM_CHAR_CAP) + '\n…[truncated]'
        : text;
}
/**
 * 收集声明窗口：当轮（最新闭合 turn）行为原子 + 近 windowTurns 轮（closed-N..closed-1）
 * 数据原子 + 当轮门控原子。turn 归属与 compressor collectCurrentTurn 同口径：
 * user/message 无 turn 字段（rc.2）→ 归属当前开放 turn；assistant/tool 自带 turn。
 */
export function collectDeclAtoms(session, windowTurns, splitThresholdChars) {
    const events = sessionEvents(session);
    let closed = null;
    for (let i = events.length - 1; i >= 0; i -= 1) {
        const event = events[i];
        if (event?.type === 'turn/end') {
            closed = turnOf(event) ?? null;
            break;
        }
    }
    if (closed === null)
        return null;
    const interrupted = collectInterruptedTurns(events).has(closed);
    const collect = { turn: closed, interrupted, gateAtoms: [], fromAtoms: [], toAtoms: [] };
    if (interrupted)
        return collect;
    const nameByCall = buildToolNameIndex(events);
    const fromBySeq = new Map();
    const toBySeq = new Map();
    const gate = [];
    let open = null;
    for (const event of events) {
        if (event.type === 'turn/start') {
            open = turnOf(event) ?? null;
            continue;
        }
        if (event.type === 'turn/end') {
            open = null;
            continue;
        }
        const data = event.data;
        const declaredTurn = turnOf(event);
        const turn = event.type === 'user/message' ? open : (typeof declaredTurn === 'number' ? declaredTurn : open);
        if (turn === null)
            continue;
        if (turn !== closed && (turn > closed - 1 || turn < closed - windowTurns))
            continue;
        if (event.type === 'user/message') {
            const source = data?.source?.kind;
            const text = projectSurfaceText(event);
            if (text.trim() === '')
                continue;
            if (turn === closed) {
                // 自家注入副本（U-info / A-form 指令）不是行为原子——按自有来源白名单判据跳过
                // （版本无关：V3 'plugin' / V4 'argp' 命中白名单；idle 时刻当轮本不应存在，防御性）。
                if (isOwnSourceKind(source))
                    continue;
                fromBySeq.set(event.seq, { seq: event.seq, turn: closed, kind: 'user', isFrom: true, isTo: false, role: 'current', text: capPromptText(text) });
                if (userIsLong(text, splitThresholdChars))
                    gate.push({ kind: 'user-long', seq: event.seq, turn: closed, text });
            }
            else {
                toBySeq.set(event.seq, { seq: event.seq, turn, kind: 'user', isFrom: false, isTo: true, role: 'prior', text: capPromptText(text) });
            }
            continue;
        }
        if (event.type === 'assistant/message') {
            const text = projectSurfaceText(event);
            if (text.trim() === '')
                continue;
            if (turn === closed) {
                fromBySeq.set(event.seq, { seq: event.seq, turn: closed, kind: 'assistant', isFrom: true, isTo: false, role: 'current', text: capPromptText(text) });
            }
            continue;
        }
        if (event.type === 'tool/result') {
            const text = projectSurfaceText(event);
            if (text.trim() === '')
                continue;
            const callId = data?.message?.source?.callId;
            if (turn === closed) {
                gate.push({ kind: 'tool-result', seq: event.seq, turn: closed, text, callId, toolName: callId !== undefined ? nameByCall.get(callId) : undefined });
            }
            else {
                toBySeq.set(event.seq, { seq: event.seq, turn, kind: 'tool-result', isFrom: false, isTo: true, role: 'prior', text: capPromptText(text) });
            }
        }
    }
    // 窗口内被中断轮次的残留原子不作 to 端点（与压缩侧 filterInterruptedAtoms 同口径，宁全勿漏）。
    // 中断轮并入下一轮（1.7.0）：紧邻上一轮（closed - 1）若被中断，其原子并入 closed 的 pass，
    // 故保留为 to 端点（供 cites 声明）；更早的中断轮仍排除。
    const interruptedTurns = collectInterruptedTurns(events);
    collect.gateAtoms = gate;
    collect.fromAtoms = [...fromBySeq.values()];
    collect.toAtoms = [...toBySeq.values()].filter(a => a.turn === closed - 1 || !interruptedTurns.has(a.turn));
    return collect;
}
// ---------------------------------------------------------------------------
// CiteDeclarer 服务本体
// ---------------------------------------------------------------------------
export class CiteDeclarer {
    static inject = [];
    windowTurns;
    timeoutMs;
    ctx;
    endpoint;
    dshLlm;
    /** 自动兜底候选（§11.13.1）：显式 llm 与 fetch 两路都缺省时置 true。 */
    llmAutoEligible;
    /** 延迟解析出的后端（来自 agent 路由；构造期拿不到路由，故后置填充）。 */
    autoLlm = null;
    fetchImpl;
    chatTemplateKwargs;
    /** 输出 cap（默认 4096；cites JSON 通常几百 token，小 cap 防爆上限）。 */
    maxCompletionTokens;
    /** A 形态前缀预算（默认 132000；超预算该次降级 C）。 */
    prefixBudgetTokens;
    /** seq 空间声明边缓存：(fromSeq->toSeq) → 边。消费端 buildInjectEdges 做 seq→id 映射。 */
    edgeCache = new Map();
    /** 防重复 turn 处理：(session, turn) 记账于声明阶段。 */
    doneTurns = new WeakMap();
    /** LLM 声明调用计数器（门控跳过 / 中断 / disabled 轮零调用的断言读这里）。 */
    _calls = 0;
    get calls() { return this._calls; }
    /** 全部声明尝试记录（时间序）。 */
    /** 遥测数组容量上限（P4.5：records 有界）。 */
    telemetryCap;
    records = [];
    /** 缓存中的声明边数（测试断言用）。 */
    get cachedEdgeCount() { return this.edgeCache.size; }
    /** 是否已解析到 LLM 后端（dsh-llm / endpoint / 自动兜底任一）。未武装时 auto 口径下回复级 cites 协议保持开启（两种边来源不能同时归零）。 */
    get armed() { return this.endpoint !== null || this.dshLlm !== null || this.autoLlm !== null; }
    constructor(ctx, config = {}) {
        this.ctx = ctx;
        this.dshLlm = config.llm ?? null;
        this.endpoint = config.endpoint !== undefined
            ? { endpoint: config.endpoint, model: config.model ?? 'deepseek-v4-flash', apiKey: config.apiKey ?? '' }
            : (config.apiKey !== undefined
                ? { endpoint: config.endpoint ?? 'https://api.deepseek.com/chat/completions', model: config.model ?? 'deepseek-v4-flash', apiKey: config.apiKey }
                : citeDeclarerDefaultEndpoint());
        this.windowTurns = config.windowTurns ?? CITATION_WINDOW_TURNS;
        this.timeoutMs = config.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;
        this.telemetryCap = config.telemetryCap ?? DEFAULT_TELEMETRY_CAP;
        this.chatTemplateKwargs = config.chatTemplateKwargs;
        this.maxCompletionTokens = config.maxCompletionTokens ?? 4096;
        this.prefixBudgetTokens = config.prefixBudgetTokens ?? DEFAULT_PREFIX_BUDGET_TOKENS;
        this.fetchImpl = config.fetchImpl ?? ((...args) => fetch(...args));
        // 显式 llm 与 fetch 两路都缺省 ⇒ 进入自动兜底（真会话里解析 agent 路由）。
        this.llmAutoEligible = config.llm === undefined && this.endpoint === null;
        if (this.endpoint === null && this.dshLlm === null) {
            if (this.llmAutoEligible) {
                ctx.logger.info('[argp-peratom] declarer: no explicit LLM backend; auto mode — will follow the host dsh-llm + agent route once a real session provides one (disabled, zero network, until then)');
            }
            else {
                ctx.logger.warn('[argp-peratom] declarer: no LLM backend resolved (set DEEPSEEK_API_KEY, pass config.llm, or pass config); declarer disabled');
            }
        }
        // 触发钩子：轮末 idle（当轮必已闭）→ 收集 + 声明（异步，不阻塞状态切换）。
        // 与 compressor 的 idle prepare 同钩子、互相独立：declarer 只产边缓存，不落盘。
        ctx.on('agent/status', ({ agent, status }) => {
            this.rememberRoute(agent);
            if (status !== 'idle')
                return;
            void this.declareCurrentTurn(agent.session).catch(error => {
                this.ctx.logger.warn(`[argp-peratom] declarer declare failed: ${error instanceof Error ? error.message : String(error)}`);
            });
        });
    }
    // -- LLM 后端选择（§11.13.1）-------------------------------------------
    /** 记住 agent 路由（构造期拿不到，只能在 agent/status 钩子里现取）。非自动模式短路。 */
    rememberRoute(agent) {
        if (!this.llmAutoEligible)
            return;
        try {
            const spec = autoDshLlmSpec(this.ctx, agent?.options ?? null);
            if (spec !== null)
                this.autoLlm = spec;
        }
        catch { /* 路由解析失败：保持原值，退化为 disabled（零网络） */ }
    }
    /** 后端选路：显式 `config.llm` > fetch（endpoint/apiKey/env）> 自动兜底；三者皆无 → null。 */
    backend() {
        if (this.dshLlm !== null)
            return { kind: 'dsh-llm', spec: this.dshLlm };
        if (this.endpoint !== null)
            return { kind: 'fetch', endpoint: this.endpoint };
        if (this.autoLlm !== null)
            return { kind: 'dsh-llm', spec: this.autoLlm };
        return null;
    }
    /** 方案 B ctk（与 compressor 同款，2026-09-19 定案）：et:false + pt:false + 主链 reasoningEffort 对齐。 */
    resolveEffectiveCtk(session) {
        // 2026-09-21（P5 Wave 3 第 3 步）：主链 reasoningEffort 抽取收敛到 log-access 共享访问器。
        const mainChainEffort = mainChainReasoningEffort(session);
        const ctk = { ...(this.chatTemplateKwargs ?? {}) };
        ctk['enable_thinking'] = false;
        ctk['preserve_thinking'] = false;
        if (mainChainEffort !== undefined)
            ctk['reasoning_effort'] = mainChainEffort;
        return ctk;
    }
    /**
     * 前缀预算门控（与 compressor 同款；超预算该次降级 C）。usage 挂事件 data
     * 顶层（非 message 内层），billed = inputTokens + cacheRead + cacheWrite
     * 与引擎真实锚点同式——只算未命中会在高缓存命中率时低估、漏降级。
     */
    prefixWithinBudget(session, promptChars) {
        const events = sessionEvents(session);
        for (let i = events.length - 1; i >= 0; i -= 1) {
            const event = events[i];
            if (event?.type !== 'assistant/message')
                continue;
            const usage = event.data?.usage;
            if (usage === undefined || typeof usage.inputTokens !== 'number')
                continue;
            const billedInput = usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
            return billedInput + Math.ceil(promptChars / 4) <= this.prefixBudgetTokens;
        }
        return false;
    }
    /**
     * idle 触发段（公开入口供单测 / P4 直驱）：幂等查询 → 中断轮短路 → 孤立原子门控
     * （turnCompressible 共用谓词）→ disabled 短路（**不记账**）→ 记账 → LLM（1 次静默重试）→ 边入缓存。
     * 返回观测记录；无可声明轮（无闭合 turn）返回 null。
     */
    async declareCurrentTurn(session) {
        const collect = collectDeclAtoms(session, this.windowTurns, SPLIT_THRESHOLD_CHARS);
        if (collect === null)
            return null;
        const done = this.doneTurns.get(session) ?? new Set();
        this.doneTurns.set(session, done);
        // 幂等查询：仅"已真正声明过"的轮会记账（见下方 done.add），其余短路态一律不记账。
        if (done.has(collect.turn))
            return null; // 防重复 turn 处理
        if (collect.interrupted) {
            const record = { at: new Date().toISOString(), turn: collect.turn, called: false, error: 'interrupted-turn' };
            pushBounded(this.records, record, this.telemetryCap);
            return record; // 中断轮：半成品原子不进引用声明（宁全勿漏）
        }
        if (!turnCompressible(collect.gateAtoms, buildVersionChainIndex(sessionEvents(session)))) {
            const record = { at: new Date().toISOString(), turn: collect.turn, called: false, error: 'gate-skipped' };
            pushBounded(this.records, record, this.telemetryCap);
            return record; // 孤立原子规则：纯 dialog / 全版本链 / 全小结果 → 零调用、零建边
        }
        const backend = this.backend();
        if (backend === null) {
            const record = { at: new Date().toISOString(), turn: collect.turn, called: false, error: 'no-endpoint' };
            pushBounded(this.records, record, this.telemetryCap);
            // disabled：静默跳过；【不记账 done】——no-endpoint 是瞬时态（路由未就绪 / 启动期 env
            // 未设），后端就绪后同一轮必须能重试，否则该轮 citation 边永久缺失（与 compressor
            // 的 passWatermark「仅成功规划才推进」同语义）。
            return record;
        }
        done.add(collect.turn); // 幂等记账：过门控且有端点 ⇒ 该轮已真正声明
        this._calls += 1;
        const record = { at: new Date().toISOString(), turn: collect.turn, called: true };
        pushBounded(this.records, record, this.telemetryCap);
        // A 形态前缀（与 compressor 同语义）：agent 当前 deriveMessages() + requestHeader().tools。
        // 预算门控：超预算该次降级 C（丢前缀只发指令），防爆上限。
        const contextMessages = session.deriveMessages();
        const contextTools = session.requestHeader()?.tools;
        const effectiveCtk = this.resolveEffectiveCtk(session);
        const prompt = buildCitePrompt([...collect.fromAtoms, ...collect.toAtoms]);
        const usePrefix = this.prefixWithinBudget(session, prompt.length);
        this.ctx.logger.info(`[argp-peratom] declarer: turn ${collect.turn} from=${collect.fromAtoms.length} to=${collect.toAtoms.length} (dsh-llm=${backend.kind === 'dsh-llm'}, prefix=${usePrefix ? contextMessages.length + ' msgs' : 'OFF (degraded C)'})`);
        const started = Date.now();
        try {
            let raw;
            if (backend.kind === 'dsh-llm') {
                // dsh-llm 生产后端：一次到位（GenerateOptions 无 response_format，extractJson 兜底）。
                raw = (await completeViaDshLlm(this.ctx, backend.spec, prompt, this.timeoutMs, usePrefix ? contextMessages : undefined, usePrefix ? contextTools : undefined)).text;
            }
            else {
                const contextWire = usePrefix ? serializeWireMessages(contextMessages, this.ctx.logger) : undefined;
                const contextToolsWire = usePrefix ? serializeWireTools(contextTools) : undefined;
                try {
                    raw = await postChat(this.fetchImpl, backend.endpoint, prompt, this.timeoutMs, true, effectiveCtk, contextWire, contextToolsWire, this.maxCompletionTokens);
                }
                catch {
                    // response_format 被端点拒绝 / 网络抖动：降级裸 prompt 静默重试一次（compressor 同款，
                    // plan P2"至多重试 1 次"）。第二次仍失败 → 外层 catch 记 error，本轮无边。
                    raw = await postChat(this.fetchImpl, backend.endpoint, prompt, this.timeoutMs, false, effectiveCtk, contextWire, contextToolsWire, this.maxCompletionTokens);
                }
            }
            record.ms = Date.now() - started;
            const parsed = extractJson(raw);
            const citesArr = (parsed !== null && typeof parsed === 'object') ? parsed.cites : undefined;
            if (!Array.isArray(citesArr)) {
                record.error = 'parse-failed';
                this.dumpCites(record);
                return record; // 解析失败：本轮无边（安全方向），绝不阻断
            }
            const fromSeqs = new Set(collect.fromAtoms.map(a => a.seq));
            const toSeqs = new Set(collect.toAtoms.map(a => a.seq));
            const { cites, invalid } = normalizeCites(citesArr, fromSeqs, toSeqs);
            record.invalid = invalid;
            record.accepted = cites.length;
            record.cites = cites;
            if (cites.length > 0)
                this.cacheCites(cites);
            this.dumpCites(record);
        }
        catch (error) {
            record.error = error instanceof Error ? error.message : String(error);
        }
        return record;
    }
    /** 边入缓存：同 (from,to) 覆盖（后轮声明刷新 level）；超限按插入序淘汰最旧。 */
    cacheCites(cites) {
        for (const cite of cites) {
            const key = cite.fromSeq + '->' + cite.toSeq;
            if (!this.edgeCache.has(key) && this.edgeCache.size >= MAX_CACHED_EDGES) {
                const oldest = this.edgeCache.keys().next().value;
                if (oldest !== undefined)
                    this.edgeCache.delete(oldest);
            }
            this.edgeCache.set(key, cite);
        }
    }
    /**
     * F1（1.7.1）：声明边落盘（**默认关**，env 门控的 JSONL 诊断通道）。
     *
     * ## 为什么需要它
     *
     * 声明边的唯一出口是进程内存：`edgeCache`（消费端）与 `records`（观测端），而
     * `records` 只经 `ctx.logger.info('[argp-peratom] …')` 打印，`~/.dsh/logs/*` 只保留
     * startup 段 ⇒ **声明边事后完全不可取证**。实测后果：本会话"376 条 A 的 R 组全是
     * 墓碑、A 却剪不掉"只能归因到"A10 判定"这一步，无法区分
     *   (a) declarer 根本没产边；
     *   (b) 产了边但 `buildInjectEdges` 因端点离 surface 丢弃；
     *   (c) 产了边但 `MAX_CACHED_EDGES=512` 的插入序淘汰把老边挤掉。
     *
     * 而且 F1 **不只是可观测性**：声明入度（`curInDegreeDecl`）就是 A10 的解锁输入，
     * 所以"声明边到底存不存在"直接决定 A 能不能被剪。
     *
     * ## 契约
     *
     * - 门控 `process.env['ARGP_CITES_DUMP']` = 目标文件路径；**未设 ⇒ 立即 return**
     *   （生产零开销、零落盘）。每次调用读 env（不缓存），运行期可开关、测试无需关心构造时序。
     * - `appendFileSync` 写单行 JSON，全程 `try/catch` 吞异常——declarer 故障绝不阻断
     *   建图或会话（与 `buildInjectEdges` 恒返回 `[]` 同一条失败隔离原则）。
     * - 两种行形态（`kind` 区分）：
     *   - `cite`：单条声明边（`fromSeq/toSeq/level` + 轮级 `accepted/invalid`）；
     *   - `cite-none`：该轮**零边**的归因行（`error`/`invalid`/`accepted=0`）——
     *     区分"门控跳过/中断/解析失败"与"真产了边"的关键证据；
     *   - `inject`：`buildInjectEdges` 每次建图的摘要（`cacheSize/emitted/dropped*`），
     *     这是区分"LRU 淘汰"与"端点离 surface 丢弃"的唯一判据。
     */
    dump(row) {
        const file = process.env['ARGP_CITES_DUMP'];
        if (file === undefined || file === '')
            return;
        try {
            appendFileSync(file, JSON.stringify(row) + '\n');
        }
        catch {
            // 落盘失败（路径不可写/磁盘满）绝不阻断声明或建图
        }
    }
    /**
     * F1 落盘：一轮声明的全部边，或在零边时写一条**归因行**。
     * 零边归因行必须含 `error`（`gate-skipped` / `interrupted-turn` / `parse-failed` /
     * 网络错误文本）——它是"declarer 没产边"与"产了边但被丢弃"的分界线。
     */
    dumpCites(record) {
        const cites = record.cites ?? [];
        if (cites.length === 0) {
            this.dump({
                kind: 'cite-none', at: record.at, turn: record.turn,
                error: record.error, accepted: record.accepted ?? 0, invalid: record.invalid ?? 0,
            });
            return;
        }
        for (const cite of cites) {
            this.dump({
                kind: 'cite', at: record.at, turn: record.turn,
                fromSeq: cite.fromSeq, toSeq: cite.toSeq, level: cite.level,
                accepted: record.accepted ?? 0, invalid: record.invalid ?? 0,
            });
        }
    }
    /**
     * Stage-2 接线点（ArgpGraphEngineConfig.injectEdges 回调）：seq→id 映射。
     * 吞一切异常恒返回 `[]`——declarer 故障绝不阻断建图（plan P2 失败隔离）。
     * 端点已离 surface 的边：buildGraph 的 validIds 校验（atom.id 集合）天然丢弃（优雅降级）。
     * 注意：buildGraph 校验空间是**本次投影内的 atom.id**（局部索引），不是 seq——
     * 故缓存保持 seq 空间，本方法每次建图现映射。
     *
     * F1（1.7.1）：每次建图落一条摘要（env 门控，默认关）。字段
     * `droppedByMissingEndpoint` = **重定向后仍**不在本次投影 atom 集合内而被丢弃的边数
     * （方案初稿命名为 `droppedByValidIds`，实为 idBySeq 映射阶段丢弃，与 buildGraph 的
     * validIds 是两回事 ⇒ 改名以免误读）；`cacheSize` 与 `emitted + dropped*` 不等时说明
     * 存在**插入序淘汰**（判定 LRU 挤老边 vs 端点离场，只能靠这三个数对账）。
     *
     * F3（1.7.1）：`redirect` 提供「旧 seq → 当前替身 seq」映射（调用侧由
     * `buildTombstoneRedirect(records)` 构造，见 `prune-tx.ts`）。**缺省不传 = 保持 1.7.0
     * 行为**（端点离场即丢）。摘要新增 `redirectedEdges` = **至少一个端点经重定向**才命中的
     * 边数，它是 `emitted` 的**子集**，**不计入** `emitted + dropped* = cacheSize` 求和式。
     */
    buildInjectEdges(atoms, redirect) {
        try {
            const idBySeq = new Map();
            for (const a of atoms)
                idBySeq.set(a.seq, a.id);
            // F3：端点已离场时沿**墓碑链**重定向到当前替身（多跳 + 防环）。返回 [id, 是否经重定向]；
            // 链上任何一环落在本次投影即命中。缺失映射/断链 ⇒ undefined（沿用旧降级语义）。
            const resolve = (seq) => {
                const direct = idBySeq.get(seq);
                if (direct !== undefined)
                    return [direct, false];
                if (redirect === undefined)
                    return [undefined, false];
                const seen = new Set([seq]);
                let cur = redirect(seq);
                while (cur !== undefined && !seen.has(cur)) {
                    const hit = idBySeq.get(cur);
                    if (hit !== undefined)
                        return [hit, true];
                    seen.add(cur);
                    cur = redirect(cur);
                }
                return [undefined, false];
            };
            const out = [];
            let droppedByMissingEndpoint = 0;
            let droppedBySelfLoop = 0;
            let redirectedEdges = 0;
            for (const cite of this.edgeCache.values()) {
                const [from, fromRedirected] = resolve(cite.fromSeq);
                const [to, toRedirected] = resolve(cite.toSeq);
                if (from === undefined || to === undefined) {
                    droppedByMissingEndpoint += 1;
                    continue;
                }
                if (from === to) {
                    droppedBySelfLoop += 1;
                    continue;
                }
                if (fromRedirected || toRedirected)
                    redirectedEdges += 1;
                out.push({ from, to, level: cite.level });
            }
            this.dump({
                kind: 'inject', at: new Date().toISOString(),
                cacheSize: this.edgeCache.size, emitted: out.length,
                droppedByMissingEndpoint, droppedBySelfLoop, redirectedEdges,
            });
            return out;
        }
        catch {
            return [];
        }
    }
}
