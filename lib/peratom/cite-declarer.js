import { buildToolNameIndex, buildVersionChainIndex, collectInterruptedTurns, projectSurfaceText, turnCompressible, userIsLong, } from './gate.js';
import { SPLIT_THRESHOLD_CHARS } from './types.js';
import { completeViaDshLlm } from './llm-adapter.js';
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
async function postChat(fetchImpl, ep, prompt, timeoutMs, useJsonSchema, chatTemplateKwargs) {
    const body = {
        model: ep.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
    };
    if (useJsonSchema) {
        // JSON Schema 强制输出：支持结构化解码的端点上消灭自由生成失控（与 compressor 同策略）。
        body['response_format'] = {
            type: 'json_schema',
            json_schema: { name: 'argp_cite_declarer', strict: true, schema: OUTPUT_SCHEMA },
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
            open = event.data.turn;
            continue;
        }
        if (event.type === 'turn/end') {
            open = null;
            continue;
        }
        const data = event.data;
        const declaredTurn = event.data?.turn;
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
                // 自家 U-info 副本不是行为原子（idle 时刻当轮不应存在，防御性跳过）。
                if (source === 'plugin')
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
    const interruptedTurns = collectInterruptedTurns(events);
    collect.gateAtoms = gate;
    collect.fromAtoms = [...fromBySeq.values()];
    collect.toAtoms = [...toBySeq.values()].filter(a => !interruptedTurns.has(a.turn));
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
    fetchImpl;
    chatTemplateKwargs;
    /** seq 空间声明边缓存：(fromSeq->toSeq) → 边。消费端 buildInjectEdges 做 seq→id 映射。 */
    edgeCache = new Map();
    /** 防重复 turn 处理：(session, turn) 记账于声明阶段。 */
    doneTurns = new WeakMap();
    /** LLM 声明调用计数器（门控跳过 / 中断 / disabled 轮零调用的断言读这里）。 */
    _calls = 0;
    get calls() { return this._calls; }
    /** 全部声明尝试记录（时间序）。 */
    records = [];
    /** 缓存中的声明边数（测试断言用）。 */
    get cachedEdgeCount() { return this.edgeCache.size; }
    /** 是否已解析到 LLM 后端（dsh-llm 或 endpoint 任一）。未武装时 auto 口径下回复级 cites 协议保持开启（两种边来源不能同时归零）。 */
    get armed() { return this.endpoint !== null || this.dshLlm !== null; }
    constructor(ctx, config = {}) {
        this.ctx = ctx;
        this.dshLlm = config.llm ?? null;
        this.endpoint = config.endpoint !== undefined
            ? { endpoint: config.endpoint, model: config.model ?? 'deepseek-v4-flash', apiKey: config.apiKey ?? '' }
            : (config.apiKey !== undefined
                ? { endpoint: config.endpoint ?? 'https://api.deepseek.com/chat/completions', model: config.model ?? 'deepseek-v4-flash', apiKey: config.apiKey }
                : citeDeclarerDefaultEndpoint());
        this.windowTurns = config.windowTurns ?? CITATION_WINDOW_TURNS;
        this.timeoutMs = config.timeoutMs ?? 120_000;
        this.chatTemplateKwargs = config.chatTemplateKwargs;
        this.fetchImpl = config.fetchImpl ?? ((...args) => fetch(...args));
        if (this.endpoint === null && this.dshLlm === null) {
            ctx.logger.warn('cite-declarer: no LLM backend resolved (set DEEPSEEK_API_KEY, pass config.llm, or pass config); declarer disabled');
        }
        // 触发钩子：轮末 idle（当轮必已闭）→ 收集 + 声明（异步，不阻塞状态切换）。
        // 与 compressor 的 idle prepare 同钩子、互相独立：declarer 只产边缓存，不落盘。
        ctx.on('agent/status', ({ agent, status }) => {
            if (status !== 'idle')
                return;
            void this.declareCurrentTurn(agent.session).catch(error => {
                this.ctx.logger.warn(`cite-declarer declare failed: ${error instanceof Error ? error.message : String(error)}`);
            });
        });
    }
    /**
     * idle 触发段（公开入口供单测 / P4 直驱）：幂等记账 → 中断轮短路 → 孤立原子门控
     * （turnCompressible 共用谓词）→ disabled 短路 → LLM（1 次静默重试）→ 边入缓存。
     * 返回观测记录；无可声明轮（无闭合 turn）返回 null。
     */
    async declareCurrentTurn(session) {
        const collect = collectDeclAtoms(session, this.windowTurns, SPLIT_THRESHOLD_CHARS);
        if (collect === null)
            return null;
        const done = this.doneTurns.get(session) ?? new Set();
        this.doneTurns.set(session, done);
        if (done.has(collect.turn))
            return null; // 防重复 turn 处理
        if (collect.interrupted) {
            const record = { at: new Date().toISOString(), turn: collect.turn, called: false, error: 'interrupted-turn' };
            this.records.push(record);
            return record; // 中断轮：半成品原子不进引用声明（宁全勿漏）
        }
        if (!turnCompressible(collect.gateAtoms, buildVersionChainIndex(session.events))) {
            const record = { at: new Date().toISOString(), turn: collect.turn, called: false, error: 'gate-skipped' };
            this.records.push(record);
            return record; // 孤立原子规则：纯 dialog / 全版本链 / 全小结果 → 零调用、零建边
        }
        if (this.endpoint === null && this.dshLlm === null) {
            const record = { at: new Date().toISOString(), turn: collect.turn, called: false, error: 'no-endpoint' };
            this.records.push(record);
            return record; // disabled：静默跳过
        }
        this._calls += 1;
        const record = { at: new Date().toISOString(), turn: collect.turn, called: true };
        this.records.push(record);
        console.log(`[argp-peratom] declarer: turn ${collect.turn} from=${collect.fromAtoms.length} to=${collect.toAtoms.length} (dsh-llm=${this.dshLlm !== null})`);
        const started = Date.now();
        try {
            const prompt = buildCitePrompt([...collect.fromAtoms, ...collect.toAtoms]);
            let raw;
            if (this.dshLlm !== null) {
                // dsh-llm 生产后端：一次到位（GenerateOptions 无 response_format，extractJson 兜底）。
                raw = (await completeViaDshLlm(this.ctx, this.dshLlm, prompt, this.timeoutMs)).text;
            }
            else {
                try {
                    raw = await postChat(this.fetchImpl, this.endpoint, prompt, this.timeoutMs, true, this.chatTemplateKwargs);
                }
                catch {
                    // response_format 被端点拒绝 / 网络抖动：降级裸 prompt 静默重试一次（compressor 同款，
                    // plan P2"至多重试 1 次"）。第二次仍失败 → 外层 catch 记 error，本轮无边。
                    raw = await postChat(this.fetchImpl, this.endpoint, prompt, this.timeoutMs, false, this.chatTemplateKwargs);
                }
            }
            record.ms = Date.now() - started;
            const parsed = extractJson(raw);
            const citesArr = (parsed !== null && typeof parsed === 'object') ? parsed.cites : undefined;
            if (!Array.isArray(citesArr)) {
                record.error = 'parse-failed';
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
     * Stage-2 接线点（ArgpGraphEngineConfig.injectEdges 回调）：seq→id 映射。
     * 吞一切异常恒返回 `[]`——declarer 故障绝不阻断建图（plan P2 失败隔离）。
     * 端点已离 surface 的边：buildGraph 的 validIds 校验（atom.id 集合）天然丢弃（优雅降级）。
     * 注意：buildGraph 校验空间是**本次投影内的 atom.id**（局部索引），不是 seq——
     * 故缓存保持 seq 空间，本方法每次建图现映射。
     */
    buildInjectEdges(atoms) {
        try {
            const idBySeq = new Map();
            for (const a of atoms)
                idBySeq.set(a.seq, a.id);
            const out = [];
            for (const cite of this.edgeCache.values()) {
                const from = idBySeq.get(cite.fromSeq);
                const to = idBySeq.get(cite.toSeq);
                if (from === undefined || to === undefined)
                    continue;
                if (from === to)
                    continue;
                out.push({ from, to, level: cite.level });
            }
            return out;
        }
        catch {
            return [];
        }
    }
}
