/**
 * Per-Atom 两级召回 zoom（P3）：渐进式 recall，verbatim 天花板。
 *
 * 三个存储级别：
 *  - extract：熵降后 surface 上常驻的压缩副本（模型可见）
 *  - summary：压缩时产的摘要（U-info 存 `data[ARG_NS].summary`；tool/result 副本正文即 extract）
 *  - original：append-only 日志里的 verbatim 原文（天然存在，零存储成本）
 *
 * 两级工具（渐进 zoom）：
 *  - `recall_summary(seq)`：gist 档——"这内容是关于什么的"。优先读存储 summary，无则降级返回
 *    压缩副本（extract），再降级返回原文。便宜（预算给 4×）。
 *  - `recall_detail(seq, from?, limit?)`：exact 档——"确切字符串"。从 append-only 日志取原文
 *    （复用 log-access.recallFromLog + rawEventText：text 块逐字字面量，tool-call 参数为对象
 *    时 JSON 语义等价重建并精确标注），即 verbatim 天花板。大节点经 from/limit 分页续读——
 *    截断标记回传下一次该传的 from，被剪的长代码/长工具输出可完整拿回。贵（预算 1×）。
 *
 * 宿主身份（与 PeratomCompressor / CiteDeclarer 同构）：普通 cordis 服务（**非 compaction 位**），
 * 注册两个 defineTool + 一个静态契约 section，经 `setSession` / `agent/pre-step` 绑定 session。
 * 零 LLM 调用——两个工具都是纯日志读取，0 推理成本。
 *
 * 预算模块（决策⑤ 4 倍制）：detail 档基线预算，summary 档 = `budgetRatio`(4) × detail。
 * 按"自上次 compaction 事务以来的累计字符"滑窗计数（与 argp-graph-engine.budgetRecallText 同款
 * 重置语义，挂在 `compaction/end`）。**超限不硬拒**——返回引导文案教模型升档（summary→detail）
 * 或降档（detail→summary），而非拒绝读取。
 *
 * 失败隔离：seq 越界 / 无正文返回明确说明（不抛错）；预算耗尽返回引导（不阻断会话）。
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { eventText, formatRecallOutcome, rawEventText, recallFromLog, scanShadowedSeqs, sessionEvents, stateHeader } from '../log-access.js';
import { ARG_NS } from './types.js';
import { DEFAULT_CHARS_PER_TOKEN, DEFAULT_WINDOW_TOKENS } from '../constants.js';
import { DEFAULT_TELEMETRY_CAP, pushBounded } from '../telemetry.js';
/** 决策⑤ 4 倍制：summary 档预算 = budgetRatio × detail 档。默认 4。 */
export const DEFAULT_BUDGET_RATIO = 4;
/** detail 档预算占窗口比例（单窗累计，字符）。 */
const DETAIL_WINDOW_RATIO = 0.05;
/**
 * 解析某 seq 的"最佳可用 summary 文本"，三档降级：
 *  1. `stored`——该事件（或引用它的压缩副本）携带 `data[ARG_NS].summary`（U-info 原子）；
 *  2. `copy`——引用该 seq 的最新压缩副本正文（tool/result extract 副本 / dialog 副本）；
 *  3. `original`——从未压缩，降级返回 append-only 日志原文。
 * 无正文返回 null。
 */
export function resolveSummaryText(session, seq) {
    const event = sessionEvents(session)[seq];
    if (event === undefined)
        return null;
    // 1) 该事件自身携带存储 summary（U-info 副本本身被直接引用）
    const own = summaryOfEvent(session, seq);
    if (own !== null)
        return own;
    // 2) 找引用此 seq 的压缩副本（自新到旧；U-info 副本优先其存储 summary）
    const events = sessionEvents(session);
    for (let i = events.length - 1; i >= 0; i -= 1) {
        if (i === seq)
            continue;
        const copy = events[i];
        if (copy === undefined)
            continue;
        const srcs = copy.sourceEventSeqs;
        if (srcs === undefined || !srcs.includes(seq))
            continue;
        const stored = summaryOfEvent(session, i);
        if (stored !== null)
            return stored;
        const copyText = eventText(session, i);
        if (copyText !== '')
            return { text: copyText, source: 'copy' };
    }
    // 3) 从未压缩 → 降级返回原文
    const orig = eventText(session, seq);
    if (orig === '')
        return null;
    return { text: orig, source: 'original' };
}
/** 读某事件的 `data[ARG_NS].summary`；缺失 / 空串返回 null。 */
function summaryOfEvent(session, seq) {
    const event = sessionEvents(session)[seq];
    if (event === undefined)
        return null;
    const meta = event.data?.[ARG_NS];
    if (meta?.summary !== undefined && meta.summary !== '')
        return { text: meta.summary, source: 'stored' };
    return null;
}
/** 判定某 seq 的节点状态（shadowed / live / off-surface），复用全日志扫描。 */
function nodeState(session, seq) {
    const shadowed = scanShadowedSeqs(session);
    if (shadowed.has(seq))
        return 'shadowed';
    for (const node of session.surface.nodes) {
        if (node === seq)
            return 'live';
    }
    return 'off-surface';
}
export class RecallZoom {
    static inject = [];
    ctx;
    budgetRatio;
    detailBudgetChars;
    enabled;
    session = null;
    /**
     * 1.11.0-beta.0（1-1）：两档预算滑窗 per-session 分桶（此前进程级单例——A 会话的
     * compaction/end 会归零 B 会话的预算、B 的消耗压制 A 的召回）。
     */
    budgets = new WeakMap();
    budgetsOf(session) {
        let b = this.budgets.get(session);
        if (b === undefined) {
            b = { detail: 0, summary: 0 };
            this.budgets.set(session, b);
        }
        return b;
    }
    /** 工具调用的目标会话（1-2）：exec.agent.session 优先；焦点回退仅在只见过一个会话时
     *  允许——多会话宿主下缺席 agent 上下文的回退会把 B 会话的内容喂给 A 的调用（beta.1
     *  评审 D2 同族，与 recall-tools.sessionOfToolCall 同一判据）。 */
    sessionOfToolCall(exec) {
        const agent = exec?.agent;
        if (agent?.session !== undefined)
            return agent.session;
        return this.seenSessionCount <= 1 ? this.session : null;
    }
    /** 绑定过的会话身份登记 + 计数（sessionOfToolCall 回退拒绝判据；WeakSet 不持引用）。 */
    seenSessions = new WeakSet();
    seenSessionCount = 0;
    /** 绑定入口唯一通道：登记身份 + 换焦点（setSession / agent/pre-step 都走这里）。 */
    rememberSession(session) {
        this.session = session;
        if (!this.seenSessions.has(session)) {
            this.seenSessions.add(session);
            this.seenSessionCount += 1;
        }
    }
    /** 焦点会话的 detail 档单窗累计（观测/测试；per-session 桶在 budgets）。 */
    get detailCharsUsed() { return this.session === null ? 0 : this.budgetsOf(this.session).detail; }
    get summaryCharsUsed() { return this.session === null ? 0 : this.budgetsOf(this.session).summary; }
    /** 遥测数组容量上限（P4.5：records 有界）。 */
    telemetryCap;
    /** 全部召回尝试记录（时间序）。 */
    records = [];
    /** 配置口径的窗口/token 比（windowTokensOf 的回退基线；显式 detailBudgetTokens 优先）。 */
    configWindowTokens;
    configCharsPerToken;
    explicitDetailTokens;
    constructor(ctx, config = {}) {
        this.ctx = ctx;
        this.budgetRatio = config.budgetRatio ?? DEFAULT_BUDGET_RATIO;
        this.enabled = config.enabled ?? true;
        this.telemetryCap = config.telemetryCap ?? DEFAULT_TELEMETRY_CAP;
        const charsPerToken = config.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN;
        const windowTokens = config.windowTokens ?? DEFAULT_WINDOW_TOKENS;
        this.configCharsPerToken = charsPerToken;
        this.configWindowTokens = windowTokens;
        this.explicitDetailTokens = config.detailBudgetTokens !== undefined;
        this.detailBudgetChars = config.detailBudgetTokens !== undefined
            ? Math.floor(config.detailBudgetTokens * charsPerToken)
            : Math.floor(windowTokens * DETAIL_WINDOW_RATIO * charsPerToken);
        // 生产 session 绑定：模型在轮中调用工具，此处对齐 argp-graph-engine / PeratomCompressor 的
        // pre-step 绑定点（只绑 session，不干预步进决策——透传 next()）。
        ctx.on('agent/pre-step', async ({ agent }, next) => {
            this.rememberSession(agent.session);
            return next();
        });
        // 预算滑窗重置：每笔 compaction 事务成功后归零（与 budgetRecallText 同款语义）。
        ctx.on('session/event', (session, event) => {
            // 2-6（1.11.0-beta.1）：复位条件统一为"compaction 事务**成功**"——带 error 的 end
            // 是 partial 事务（1.10.2 0-5 定案），视图未换代，预算不该复位（否则失败事务
            // 反而奖励一轮全额召回预算）。与 engine 侧 pruneIntervals 的"成功才复位"同口径。
            if (event.type !== 'compaction/end')
                return;
            if (typeof event.data.error === 'string')
                return;
            // 1-1：按 event 所属会话归零（此前进程级归零会清掉并发会话的预算）。
            const b = this.budgetsOf(session);
            b.detail = 0;
            b.summary = 0;
        });
        if (!this.enabled)
            return;
        const summaryTool = defineTool({
            name: 'recall_summary',
            description: 'Cheap gist recall of any conversation node by log seq: returns a short summary of what the content was about, not the exact wording. Use it when you need the idea/conclusion but not verbatim strings (exact values, paths, error codes). If the summary is not enough and you need the exact string, escalate to recall_detail(seq). Works on any seq in the append-only log, whether or not it is still visible. The reply is prefixed with [recall-summary seq=N state=...] so you know if the content is currently visible.',
            parameters: { seq: { type: 'integer', description: 'log seq of the node to summarize; placeholders show the seqs they replaced' } },
            output: {
                schema: { type: 'string' },
                render: (_args, value) => [{ type: 'text', text: value }],
            },
            execute: async (args, exec) => this.recallSummary(args.seq, this.sessionOfToolCall(exec)),
        });
        ctx.tools.register(summaryTool);
        const detailTool = defineTool({
            name: 'recall_detail',
            description: 'Exact recall of any conversation node by log seq: returns the original text from the append-only log (the verbatim ceiling). Fidelity: text blocks come back verbatim as stored; tool-call arguments are a JSON semantic-equivalent reconstruction when the host stores them as an object (annotated in the reply). The fidelity guarantee covers structured load-bearing tokens (URLs, paths, file:line, UUIDs, hashes, key=value); prose-level wording is not guaranteed verbatim. Use it when you need the exact string — an error code, a path, a number, a quote — not just the gist. It is the expensive tier (1/4 the budget of recall_summary); for "what was this about" use recall_summary(seq) instead. Large nodes are returned in pages: pass from (character offset, default 0) and limit (max chars this call, optional); a truncated reply tells you the exact from to pass next. Works on any seq in the log, whether or not it is still visible. The reply is prefixed with [recall-detail seq=N state=...].',
            parameters: {
                seq: { type: 'integer', description: 'log seq of the node to recover' },
                from: { type: 'integer', description: 'character offset to start reading from (default 0); pass the value named by a previous truncated reply to continue' },
                limit: { type: 'integer', description: 'optional maximum number of characters to return this call' },
            },
            output: {
                schema: { type: 'string' },
                render: (_args, value) => [{ type: 'text', text: value }],
            },
            execute: async (args, exec) => {
                const a = args;
                return this.recallDetail(a.seq, a.from, a.limit, this.sessionOfToolCall(exec));
            },
        });
        ctx.tools.register(detailTool);
        // 两级召回契约（静态，不引用运行时状态——保护 system 前缀缓存）。
        // section 名 argp-recall-zoom（独立于 argp-contract / argp-catalog，避免重名冲突）。
        ctx.systemPrompt.section({
            name: 'argp-recall-zoom',
            order: 151,
            text: () => 'Two-tier recall for content that left your visible context (compressed or pruned): '
                + 'recall_summary(seq) returns a cheap gist ("what it was about"); recall_detail(seq) returns the original text from the log '
                + '(text blocks verbatim; tool-call arguments JSON semantic-equivalent when the host stores them as an object, and the reply says so). '
                + 'Use recall_summary first for understanding; escalate to recall_detail only when you need an exact string (error code, path, number, quote). '
                + 'Both work on any seq in the log — absence from the visible context never means it was never said. Never reconstruct a recalled value from memory; call the tool. '
                + 'A truncated recall_detail reply names the from offset to pass next; keep paging until the node is fully read.',
        });
    }
    /** detail 档单窗预算（字符）。 */
    get detailBudget() { return this.detailBudgetChars; }
    /** summary 档单窗预算（字符）= budgetRatio × detail。 */
    get summaryBudget() { return Math.floor(this.detailBudgetChars * this.budgetRatio); }
    /** 会话解析窗口（beta.1 评审：预算不得锚在进程级固定 16384 上——宿主 requestContext
     *  已声明本会话真实窗口时按它推导；未声明回退配置值/静态默认）。 */
    windowTokensOf(session) {
        try {
            const cw = session.requestContext?.()?.contextWindow;
            if (cw !== undefined && cw > 0)
                return cw;
        }
        catch { /* 回退配置口径 */ }
        return this.configWindowTokens;
    }
    /** detail 档单窗预算（会话口径；显式 detailBudgetTokens 配置恒定优先）。 */
    detailBudgetFor(session) {
        return this.explicitDetailTokens
            ? this.detailBudgetChars
            : Math.floor(this.windowTokensOf(session) * DETAIL_WINDOW_RATIO * this.configCharsPerToken);
    }
    /** summary 档单窗预算（会话口径）。 */
    summaryBudgetFor(session) {
        return Math.floor(this.detailBudgetFor(session) * this.budgetRatio);
    }
    /** detail 档已用字符（测试断言 / 观测；焦点会话口径）。 */
    get detailUsed() { return this.detailCharsUsed; }
    /** summary 档已用字符。 */
    get summaryUsed() { return this.summaryCharsUsed; }
    setSession(session) {
        this.rememberSession(session);
    }
    /** 强制重置预算滑窗（测试 / 手动压缩用；生产由 compaction/end 触发；作用于焦点会话）。 */
    resetBudget() {
        if (this.session === null)
            return;
        const b = this.budgetsOf(this.session);
        b.detail = 0;
        b.summary = 0;
    }
    /** 预算引导文案：教模型升档 / 降档，而非硬拒。 */
    budgetGuidance(tier, used, budget) {
        if (tier === 'detail') {
            return 'recall_detail: verbatim budget exhausted for this window ('
                + used + '/' + budget + ' chars used since the last compaction). Verbatim recall is the expensive tier — '
                + 'if you only need what the content was about, use recall_summary(seq) (4x the budget). '
                + 'The detail budget resets on the next compaction; retry then if you still need the exact string.';
        }
        return 'recall_summary: summary budget exhausted for this window ('
            + used + '/' + budget + ' chars used since the last compaction). '
            + 'If you need the exact string (error code, path, number), use recall_detail(seq). '
            + 'The summary budget resets on the next compaction; retry then.';
    }
    /** gist 档召回（P3）：三档降级取数 + summary 预算。 */
    async recallSummary(seqArg, sessionArg) {
        const seq = seqArg;
        const session = sessionArg ?? this.session;
        if (seq === undefined || session === null)
            return 'recall_summary: no session bound';
        const b = this.budgetsOf(session);
        const budget = this.summaryBudgetFor(session);
        if (b.summary >= budget) {
            pushBounded(this.records, { tool: 'recall_summary', seq, hit: false, chars: 0, budgetBlocked: 'summary' }, this.telemetryCap);
            return this.budgetGuidance('summary', b.summary, budget);
        }
        const resolution = resolveSummaryText(session, seq);
        if (resolution === null) {
            pushBounded(this.records, { tool: 'recall_summary', seq, hit: false, chars: 0, reason: 'no-text' }, this.telemetryCap);
            return formatRecallOutcome('recall_summary', seq, { ok: false, reason: 'no-text', state: nodeState(session, seq) });
        }
        const state = nodeState(session, seq);
        const allowed = Math.min(resolution.text.length, budget - b.summary);
        const truncated = resolution.text.length > allowed;
        const post = b.summary + allowed;
        // 预算只计实际投递的正文（allowed）；截断 marker 是固定长度诊断元信息，不计入。
        const body = truncated
            ? resolution.text.slice(0, allowed) + '…(truncated: summary recall budget ' + post + '/' + budget + ' chars)'
            : resolution.text;
        b.summary = post;
        pushBounded(this.records, { tool: 'recall_summary', seq, hit: true, state, source: resolution.source, chars: allowed }, this.telemetryCap);
        const suffix = resolution.source === 'original'
            ? '\n[no stored summary for seq ' + seq + ' — returning original text]'
            : '';
        return stateHeader(seq, state).replace('[recall seq=', '[recall-summary seq=') + '\n' + body + suffix;
    }
    /**
     * exact 档召回（verbatim 天花板）：日志原文 + detail 预算 + from/limit 分页。
     *
     * 分页（C1 做实）：`from` = 字符偏移（默认 0），`limit` = 本次最多返回字符数（可选）。
     * 投递窗口 = [from, min(from+limit, 预算余量, 原文长度))；被预算或 limit 截断时，
     * 截断标记回传"下一步该传什么"（`call recall_detail(seq=N, from=…)`），模型可逐页
     * 拿回被剪的长代码/长工具输出——截断不再是不可恢复的信息丢失。
     * 预算只计实际投递的正文（allowed）；截断 marker 是固定长度诊断元信息，不计入。
     */
    async recallDetail(seqArg, fromArg, limitArg, sessionArg) {
        const seq = seqArg;
        const session = sessionArg ?? this.session;
        if (seq === undefined || session === null)
            return 'recall_detail: no session bound';
        const b = this.budgetsOf(session);
        const budget = this.detailBudgetFor(session);
        if (b.detail >= budget) {
            pushBounded(this.records, { tool: 'recall_detail', seq, hit: false, chars: 0, budgetBlocked: 'detail' }, this.telemetryCap);
            return this.budgetGuidance('detail', b.detail, budget);
        }
        const shadowed = scanShadowedSeqs(session);
        const outcome = recallFromLog(session, seq, s => shadowed.has(s), (s, q) => rawEventText(s, q)?.text ?? '');
        if (!outcome.ok) {
            pushBounded(this.records, { tool: 'recall_detail', seq, hit: false, chars: 0, reason: outcome.reason === 'out-of-range' ? 'out-of-range' : 'no-text' }, this.telemetryCap);
            return formatRecallOutcome('recall_detail', seq, outcome);
        }
        const raw = rawEventText(session, seq);
        const text = outcome.text;
        const from = Math.max(0, Math.floor(fromArg ?? 0));
        const limit = limitArg !== undefined && Number.isInteger(limitArg) && limitArg > 0 ? limitArg : undefined;
        const header = stateHeader(seq, outcome.state).replace('[recall seq=', '[recall-detail seq=');
        const note = raw?.reconstructed && raw.note !== undefined ? '\n[note: ' + raw.note + ']' : '';
        const remaining = text.length - from;
        if (remaining <= 0) {
            pushBounded(this.records, { tool: 'recall_detail', seq, hit: true, state: outcome.state, chars: 0 }, this.telemetryCap);
            return header + '\n…(end of content at seq ' + seq + ': nothing beyond char ' + from + ')' + note;
        }
        const allowed = Math.min(remaining, budget - b.detail, limit ?? remaining);
        const end = from + allowed;
        const post = b.detail + allowed;
        const body = text.slice(from, end)
            + (end < text.length
                ? '…(truncated at ' + end + '/' + text.length + ' chars; call recall_detail(seq=' + seq + ', from=' + end + ') to continue)'
                : '');
        b.detail = post;
        pushBounded(this.records, { tool: 'recall_detail', seq, hit: true, state: outcome.state, chars: allowed }, this.telemetryCap);
        return header + '\n' + body + note;
    }
}
export default RecallZoom;
