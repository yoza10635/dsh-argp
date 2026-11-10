import { detectOpenTurn, sessionEvents } from "../log-access.js";
import { pruneIntervals } from "../prune-tx.js";
import { fidelityGuard, findLoadBearingTokens } from "../token-ontology.js";
import { autoDshLlmSpec, completeViaDshLlm } from "../peratom/llm-adapter.js";
import { planUaSpans } from "./ua-input.js";
/** R 文本在摘要输入里的截断上限（头 800 + 尾 200；错误码多在头尾）。 */
const R_CLIP = { head: 800, tail: 200 };
/** 守卫要锁的 R 错误码上限（按出现序取前 N，防 token 爆炸把守卫逼成永假）。 */
const MAX_R_CODES = 30;
const R_CODE_RE = /\b[A-Z][A-Z0-9_]{4,}\b/g;
export class UaSummarizer {
    ctx;
    host;
    cfg;
    constructor(ctx, host, config = {}) {
        this.ctx = ctx;
        this.host = host;
        // 裸值/getter 双形归一（FactorEngine 同法）：引擎侧传 getter = 活读 volatile 旋钮。
        const asGetter = (v, d) => typeof v === 'function' ? v : () => v ?? d;
        this.cfg = {
            uaSummaryThreshold: asGetter(config.uaSummaryThreshold, 40_000),
            maxSpansPerCall: config.maxSpansPerCall ?? 3,
            summaryMaxChars: config.summaryMaxChars ?? 1200,
            llmTimeoutMs: config.llmTimeoutMs ?? 180_000,
            focalTurns: asGetter(config.focalTurns, 1),
            complete: config.complete,
        };
    }
    /**
     * 压力门下试摘一批。返回 null = 本轮未动作（池未过阈值 / 全段保守档或漂移弃段），
     * 不静默：每条弃因都落 log。
     */
    async summarize(session, route, signal) {
        const spec = this.resolveSpec(route);
        if (spec === null) {
            this.host.log.info('[argp-factor-ua] LLM 后端不可用（无路由或宿主无 llm 服务）：摘要 disabled，零网络');
            return null;
        }
        const events = sessionEvents(session);
        const probe = (seq) => {
            const data = events[seq]?.data;
            if (data === undefined)
                return { attachment: false };
            const src = (data['source'] ?? data['message']?.source);
            const raw = Array.isArray(data['content']) ? data['content']
                : Array.isArray(data['message']?.content)
                    ? data['message'].content : [];
            const attachment = raw.some(b => {
                const t = b?.type;
                return t === 'image' || t === 'file';
            });
            return { form: typeof src?.form === 'string' ? src.form : undefined, attachment };
        };
        const atoms = this.host.atomize(session);
        const latestTurn = atoms.reduce((m, a) => Math.max(m, a.turn), 0);
        const openTurn = detectOpenTurn(session);
        const focal = this.cfg.focalTurns();
        const plan = planUaSpans(atoms, {
            probe,
            openTurn,
            protectFromTurn: focal > 0 ? latestTurn - focal + 1 : null,
            watermark: session.seq,
        });
        // 阈值单次活读（volatile 旋钮）：判定与日志用同一个值，不撕裂。
        const threshold = this.cfg.uaSummaryThreshold();
        if (plan.poolChars <= threshold) {
            this.host.log.info('[argp-factor-ua] 池 ' + plan.poolChars + ' ≤ 阈值 ' + threshold + '：不摘');
            return null;
        }
        // 最旧段先吃，吃到剩余池回到阈值下（或 maxSpans 封顶）。
        const need = plan.poolChars - threshold;
        const chosen = [];
        let acc = 0;
        for (const s of plan.spans) {
            if (acc >= need || chosen.length >= this.cfg.maxSpansPerCall)
                break;
            chosen.push(s);
            acc += s.poolChars;
        }
        if (chosen.length === 0)
            return null;
        const intervals = [];
        const tombstones = [];
        for (const span of chosen) {
            if (signal?.aborted === true)
                break;
            const guard = await this.summarizeSpan(session, spec, span, signal);
            if (guard === null)
                continue;
            intervals.push({ seqs: span.seqs, chars: span.allChars, atoms: span.atoms });
            tombstones.push({ type: 'user', text: guard });
        }
        if (intervals.length === 0)
            return null;
        return pruneIntervals(this.host, session, intervals, 0, chosen.length, false, tombstones, 'factor-ua');
    }
    /**
     * 单段：守卫原文 → LLM → 守卫 → 重试一次 → 漂移复核 → X 文本。任一环失败 null（保原文）。
     */
    async summarizeSpan(session, spec, span, signal) {
        const uaText = span.atoms.filter(a => a.type !== 'R').map(a => a.text).join('\n');
        const codes = [];
        const seen = new Set();
        for (const a of span.atoms) {
            if (a.type !== 'R')
                continue;
            for (const m of a.text.matchAll(R_CODE_RE)) {
                const c = m[0] ?? '';
                if (c !== '' && !seen.has(c)) {
                    seen.add(c);
                    codes.push(c);
                }
                if (codes.length >= MAX_R_CODES)
                    break;
            }
            if (codes.length >= MAX_R_CODES)
                break;
        }
        const guardOriginal = uaText + (codes.length > 0 ? '\n' + codes.join('\n') : '');
        const load = findLoadBearingTokens(guardOriginal);
        // 保守档（§2.4）：无机器可验证的硬 token、却有散文式约束在保护——最危险形态，
        // 放弃压缩保原文。
        if (load.length === 0 && span.constraintLines.length > 0) {
            this.host.log.warn('[argp-factor-ua] turn ' + span.firstTurn + '-' + span.lastTurn
                + ' 保守档：承重集空 ∧ 约束命中 ' + span.constraintLines.length + ' 条——保原文放弃压缩');
            return null;
        }
        const base = this.buildPrompt(span, load, codes);
        let text = '';
        try {
            text = await this.callLlm(spec, base, signal);
        }
        catch (e) {
            this.host.log.warn('[argp-factor-ua] LLM 调用失败（保原文）：' + (e instanceof Error ? e.message : String(e)));
            return null;
        }
        let guard = fidelityGuard(guardOriginal, text);
        if (!guard.ok && signal?.aborted !== true) {
            // 重试一次：缺失清单进指令（peratom HLS 修复档的批次版——重写而非尾注）。
            const retry = base + '\n\n上一稿**逐字缺失**以下 token，必须原样带上后重写整段摘要：\n'
                + guard.missing.map(t => '- ' + t).join('\n');
            try {
                text = await this.callLlm(spec, retry, signal);
            }
            catch (e) {
                this.host.log.warn('[argp-factor-ua] 重试调用失败（保原文）：' + (e instanceof Error ? e.message : String(e)));
                return null;
            }
            guard = fidelityGuard(guardOriginal, text);
        }
        if (!guard.ok) {
            this.host.log.warn('[argp-factor-ua] turn ' + span.firstTurn + '-' + span.lastTurn
                + ' 守卫两次不过，缺 ' + guard.missing.length + ' token——保原文');
            return null;
        }
        // 漂移复核（异步 LLM 窗后必查）：段内 seq 必须仍是 surface 活节点——
        // surface replace 出**新 seq** 顶位（词表 note 换代同构），旧 seq 离场即漂移。
        const live = new Set(session.surface.nodes);
        for (const a of span.atoms) {
            if (!live.has(a.seq)) {
                this.host.log.info('[argp-factor-ua] 段 turn ' + span.firstTurn + '-' + span.lastTurn + ' 漂移（seq ' + a.seq + ' 已换代）——弃该段');
                return null;
            }
        }
        const band = span.constraintLines.length > 0
            ? '\n[约束带·逐字]\n' + span.constraintLines.map(l => '- ' + l).join('\n')
            : '';
        return '[因子摘要 turn ' + span.firstTurn + '-' + span.lastTurn + ']\n' + text + band
            + '\n（被吞工具输出的实体标签见词表 note；原文 recall_history(<标签>) 可取回）';
    }
    buildPrompt(span, load, codes) {
        const parts = [];
        for (const a of span.atoms) {
            const tag = a.type === 'U' ? 'U' : a.type === 'A' ? 'A' : 'R';
            let t = a.text;
            if (a.type === 'R' && t.length > R_CLIP.head + R_CLIP.tail + 3) {
                t = t.slice(0, R_CLIP.head) + '…' + t.slice(-R_CLIP.tail);
            }
            parts.push('[' + tag + ' t' + a.turn + '] ' + t);
        }
        return '你是会话压缩器（ARGP 因子引擎）。把下面对话片段（turn ' + span.firstTurn + '-' + span.lastTurn
            + '）摘成不超过 ' + this.cfg.summaryMaxChars + ' 字的连贯摘要，保住后续轮次继续任务所需上下文。\n'
            + '规则：\n'
            + '1. 硬 token 逐字保留：URL、路径、file:line、标识符、命令行（下列清单会被机器校验）；\n'
            + '2. 失败是负知识：(命令/工具 + 错误码) 配对必须写明，被放弃的尝试也要写明；\n'
            + '3. 不要复述或改写约束句——用户约束会由系统在摘要后逐字附"约束带"，你的正文与它矛盾即失败；\n'
            + '4. 只输出摘要正文，无标题无解释。\n'
            + '必须逐字出现的 token：' + (load.length + codes.length === 0 ? '（无）' : [...new Set([...load, ...codes])].join('、')) + '\n'
            + '片段：\n' + parts.join('\n');
    }
    async callLlm(spec, prompt, signal) {
        if (this.cfg.complete !== undefined)
            return await this.cfg.complete(spec, prompt, this.cfg.llmTimeoutMs);
        return (await completeViaDshLlm(this.ctx, spec, prompt, this.cfg.llmTimeoutMs, undefined, undefined, signal)).text;
    }
    /** spec 解析同 compressor 优先序的 auto 档：路由齐 + 宿主 llm 服务在位，缺一即 disabled。 */
    resolveSpec(route) {
        if (this.cfg.complete !== undefined) {
            const provider = route.provider;
            const model = route.model;
            return provider !== undefined && provider !== '' && model !== undefined && model !== ''
                ? { provider, model } : null;
        }
        return autoDshLlmSpec(this.ctx, { provider: route.provider, model: route.model });
    }
}
