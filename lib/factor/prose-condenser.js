/**
 * 散文浓缩链（P6-④ 共批，2026-11-12 开工）：与剪枝链并行的散文通道——工具原子归
 * 确定性桩+召回（factor decide / prune-tx），散文（U/A 文本）归 LLM 原生式浓缩。
 *
 * 用户裁定（docs §9.22/§9.23 台账，2026-11-11 深夜三裁定 + 11-12 开工令）：
 *  - **触发** =（system 头 + 全上下文散文字符）÷ 声明窗 > 50% **且**常规压缩触发成立（合取）
 *    ——本类只在压缩事务内被调（compactIfNeeded factor 分发 / compactNow），合取的另一半
 *    由调用点保证；分母 = 声明窗（dsh 默认分母），声明未知 ⇒ 跳过不猜；
 *  - **动作** = 完全参照原生 compaction-basic 摘要方式：one-shot、replay 前缀（sys+散文栈）
 *    + 尾部指令 user 消息；**输入仅 sys+散文（不含工具原子）**；
 *  - **驱逐** = 轮级贪心（用户 11-11 定案"轮内所有中间原子被驱逐→不留墓碑"）：从最老轮起
 *    整轮驱逐——轮内全部原子（散文/工具对/可吞 X）随轮离场，A(args) 随轮走 ⇒ 无悬空
 *    tool_call——连续整轮段一笔 replace 落**单条浓缩节点**（无逐原子墓碑）；首个不可整轮的
 *    轮（含不可吞 X/附件/U-info 副本）只做逐原子散文驱逐（标准 seqRangeTombstone 指针），
 *    贪心在此停（不跨洞续段，保"单浓缩节点"形状）；
 *  - **无逐字转写带、无保真守卫**：原始信息有 recall 兜底（用户裁定），逐字精确性不进本链
 *    ——与 UaSummarizer（fidelityGuard+约束带）的根本分野；
 *  - **浓缩节点带结构化 kind**：source=compact-checkpoint（宿主结构化源，prune-tx 统一写）
 *    + 文本标记 PROSE_CHECKPOINT_PREFIX（resume 找回/统计识别，VOCAB_NOTE_MARKER 同款
 *    判据纪律）；节点归 X ⇒ 不参与下轮散文统计（天然出池，不自我滚雪球）。
 *
 * 轮级贪心的**位置纪律**（atomize 实测约束）：atom.turn 取 `data.turn`，而 prune-tx 的
 * user 墓碑 replace 不带 turn 字段 ⇒ 墓碑 X 原子 turn=0——按 turn 号分组会把墓碑错编成
 * "turn 0 伪轮"。故分组按 **surface 连续 run**（相邻同 turn 号归一段，无原子节点断段），
 * open turn 用**位置**守卫（run 起点 ≥ open turn 首节点位置即停），焦点窗用 turn 号守卫
 * （turn=0 伪轮天然在焦点号之下，位置上若落在 open 区已被位置守卫拦住）。
 *
 * factor-ua（UaSummarizer 缺口兜底）被本链取代（退役，装配注见 argp-graph-engine）。
 */
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm';
import { eventText, sessionEvents } from "../log-access.js";
import { pruneIntervals } from "../prune-tx.js";
import { isMergeableTombstoneText } from '../tombstone-text.js';
import { classifyUaAtom } from "./ua-input.js";
import { autoDshLlmSpec, completeViaDshLlm } from "../peratom/llm-adapter.js";
/** 散文占比触发线（分母=声明窗，含 system 头）。用户裁定 50%。 */
export const PROSE_TRIGGER_RATIO = 0.5;
/** 浓缩节点文本标记（单一事实源：生成与识别同文件——VOCAB_NOTE_MARKER 同款纪律）。 */
export const PROSE_CHECKPOINT_PREFIX = '[散文压缩]';
/** 摘要调用输出预算（maxTokens 三易其值终定 8192 的同源口径；思考型模型防烧穿）。 */
export const PROSE_SUMMARY_MAX_TOKENS = 8192;
/** LLM 超时（照 UaSummarizer/DEFAULT_LLM_TIMEOUT_MS 口径）。 */
const PROSE_LLM_TIMEOUT_MS = 180_000;
/**
 * 原生 compaction-basic 的 checkpoint 框架语（CHECKPOINT_PREAMBLE 逐字同款）：
 * 使替换节点被读作"既定背景"而非待答问题。
 */
const CHECKPOINT_PREAMBLE = 'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.';
/** 摘要指令（原生 COMPACTION_INSTRUCTION 的段式骨架，散文域裁剪：无工具原子可述）。 */
const PROSE_COMPACTION_INSTRUCTION = [
    'You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.',
    '',
    'Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section — never drop a section.',
    '',
    '## Primary Request and Intent',
    '- [the user\'s original and evolving goals; quote verbatim where the exact wording matters]',
    '',
    '## Key Technical Concepts',
    '- [technologies, frameworks, patterns, and conventions in play]',
    '',
    '## Decisions and Rationale',
    '- [decisions made and why, user feedback and corrections]',
    '',
    '## Pending Jobs',
    '- [explicitly requested work not yet completed]',
    '',
    '## Current Work',
    '- [precisely what was in progress at this checkpoint]',
    '',
    '## Next Step',
    '- [the single next action, directly in line with the most recent request, or "(none)"]',
    '',
    '## Critical Context',
    '- [constraints, user preferences, open questions, data needed to continue]',
    '',
    'Rules:',
    '- Write concise engineering prose. Preserve exact file paths, commands, error strings, identifiers, numeric values, and syntax fragments.',
    '- Capture user feedback and explicit instructions faithfully, especially corrections.',
    '- Tool outputs are NOT included in this request (they are stubbed elsewhere with recall pointers); do not invent tool details.',
    '- Do NOT mention this summarization request or that the context was compacted.',
    '- Output only the checkpoint text: do not call any tool or take any other action.',
].join('\n');
/**
 * 轮级贪心（纯函数，单测主对象）。surface 按**连续 run** 分组（相邻同 turn 号），逐段晋升：
 * 整轮可驱逐（段内全部原子 ∈ textA/toolCallA/rPair/可吞 X，且段内有散文）→ 并入整轮段；
 * 首个破段（含 barrier/excluded-不可吞）→ 其 textA 原子逐个进 partialSeqs，贪心停止。
 */
export function planProseEviction(atoms, probes, surfaceSeqs, options) {
    const atomsBySeq = new Map(atoms.map(a => [a.seq, a]));
    const clsOf = (atom) => {
        const probe = probes.get(atom.seq) ?? { attachment: false };
        const cls = classifyUaAtom(atom, probe);
        // X 的可吞性细化：可并墓碑（[elided 空格族）+ 本链历史浓缩节点（[散文压缩]）可被
        // 整轮段吞并（内容并入新检查点=原生合并语义）；宿主官方 checkpoint / 词表 note /
        // system-reminder 等 excluded-X 永不吞。
        const swallowableX = cls === 'excluded' && atom.type === 'X'
            && (isMergeableTombstoneText(atom.text) || atom.text.trimStart().startsWith(PROSE_CHECKPOINT_PREFIX));
        return { cls, swallowableX };
    };
    const proseOf = (atom, cls) => cls === 'textA' ? atom.text.length : 0;
    // 全局统计：散文字符 = 全部 U/A 原子文本和（U-info 副本与 relay/notice 是 X/U-excluded——
    // U-info 副本 type 仍 U，计入统计；它是上下文中的散文）。
    let proseCharsAll = 0;
    for (const a of atoms) {
        if (a.type === 'U' || a.type === 'A')
            proseCharsAll += a.text.length;
    }
    const runs = [];
    let cur = null;
    for (let pos = 0; pos < surfaceSeqs.length; pos += 1) {
        const seq = surfaceSeqs[pos];
        const atom = atomsBySeq.get(seq);
        if (atom === undefined) {
            cur = null;
            continue;
        }
        if (cur !== null && cur.turn === atom.turn) {
            cur.seqs.push(seq);
            continue;
        }
        cur = { turn: atom.turn, seqs: [seq], startPos: pos };
        runs.push(cur);
    }
    const spanSeqs = [];
    const partialSeqs = [];
    let evicted = 0;
    let stopped = false;
    for (const run of runs) {
        if (options.openTurnFromPos !== null && run.startPos >= options.openTurnFromPos) {
            stopped = true;
            break;
        }
        if (run.turn >= options.protectFromTurn) {
            stopped = true;
            break;
        }
        // 整轮可驱逐判定：段内无 barrier、无不可吞 excluded、无 U-info 副本（excluded-X 可吞例外）。
        let whole = true;
        let runProse = 0;
        for (const seq of run.seqs) {
            const atom = atomsBySeq.get(seq);
            if (atom === undefined) {
                whole = false;
                break;
            }
            const { cls, swallowableX } = clsOf(atom);
            if (cls === 'barrier' || (cls === 'excluded' && !swallowableX)) {
                whole = false;
                break;
            }
            runProse += proseOf(atom, cls);
        }
        if (whole && runProse > 0) {
            spanSeqs.push(...run.seqs);
            evicted += runProse;
            if (evicted >= options.needChars) {
                stopped = true;
                break;
            }
            continue;
        }
        if (whole && runProse === 0) {
            // 0 散文段（历史墓碑 run / 纯工具 run）：只在已有散文进账时搭车并入（桥接连续段），
            // 领头跑空转——整段无散文时计划落空（no-candidate）。
            if (evicted > 0)
                spanSeqs.push(...run.seqs);
            continue;
        }
        // 破段：textA 原子逐个驱逐（指针墓碑），贪心停止（不跨洞续段）。
        for (const seq of run.seqs) {
            const atom = atomsBySeq.get(seq);
            if (atom === undefined)
                continue;
            const { cls } = clsOf(atom);
            if (cls !== 'textA')
                continue;
            partialSeqs.push(seq);
            evicted += proseOf(atom, cls);
        }
        stopped = true;
        break;
    }
    // stopped=false 且未达需释放量 = 候选耗尽，仍返回计划（能驱尽驱，方向安全）。
    const stopReason = spanSeqs.length === 0 && partialSeqs.length === 0 ? 'no-candidate'
        : evicted >= options.needChars ? 'need-met' : 'exhausted';
    return {
        spanSeqs, partialSeqs,
        evictedProseChars: evicted,
        proseCharsAll,
        stopReason,
    };
}
/** 浓缩节点文本（标记行在前：resume 找回与统计识别按 startsWith 判）。 */
export function proseCheckpointText(summary) {
    return PROSE_CHECKPOINT_PREFIX + '\n' + CHECKPOINT_PREAMBLE + '\n\n<compacted-summary>\n'
        + summary.trim() + '\n</compacted-summary>';
}
/**
 * 散文浓缩编排：触发判定 → 轮级贪心 → one-shot LLM（sys+散文 replay）→ prune-tx 发射。
 * 返回 null = 未动作（未过触发线 / 无候选 / LLM 不可用或失败）——不静默，逐条落 log。
 */
export class ProseCondenser {
    ctx;
    host;
    cfg;
    constructor(ctx, host, config = {}) {
        this.ctx = ctx;
        this.host = host;
        // 裸值/getter 双形归一（FactorEngine/UaSummarizer 同法）：引擎侧传 getter = 活读 volatile 旋钮。
        const asGetter = (v, d) => typeof v === 'function' ? v : () => v ?? d;
        this.cfg = {
            focalTurns: asGetter(config.focalTurns, 1),
            llmTimeoutMs: config.llmTimeoutMs ?? PROSE_LLM_TIMEOUT_MS,
            complete: config.complete,
        };
    }
    /**
     * 压缩事务内调用（合取的另一半由调用点保证）。windowTokens = 声明窗（分母）。
     */
    async condense(session, route, windowTokens, signal) {
        if (windowTokens <= 0) {
            this.host.log.info('[argp-factor-prose] 声明窗未知（windowTokens<=0）：散文浓缩跳过（分母=声明窗，不猜物理口径）');
            return null;
        }
        const spec = this.resolveSpec(route);
        if (spec === null) {
            this.host.log.info('[argp-factor-prose] LLM 后端不可用（无路由或宿主无 llm 服务）：散文浓缩 disabled，零网络');
            return null;
        }
        const events = sessionEvents(session);
        const probes = this.buildProbes(session);
        const atoms = this.host.atomize(session);
        const surfaceSeqs = [...session.surface.nodes];
        // system 头字符：surface 节点 0 为 system/message 才计（原生 systemHead 同判）。
        let sysChars = 0;
        const headSeq = surfaceSeqs[0];
        const headEvent = headSeq !== undefined ? events[headSeq] : undefined;
        if (headEvent !== undefined && headEvent.type === 'system/message') {
            sysChars = eventText(session, headSeq).length;
        }
        // 需释放量 =（sys+散文）− 触发线字符数；>0 才动作。
        const windowChars = windowTokens * this.host.charsPerToken;
        const lineChars = Math.floor(windowChars * PROSE_TRIGGER_RATIO);
        const pre = planProseEviction(atoms, probes, [], {
            needChars: 0, protectFromTurn: Number.POSITIVE_INFINITY, openTurnFromPos: null,
        });
        const proseCharsAll = pre.proseCharsAll;
        const needChars = sysChars + proseCharsAll - lineChars;
        if (needChars <= 0) {
            this.host.log.info('[argp-factor-prose] 散文占比 ' + Math.round(((sysChars + proseCharsAll) / Math.max(windowChars, 1)) * 100)
                + '% ≤ 触发线 ' + Math.round(PROSE_TRIGGER_RATIO * 100) + '%：不浓缩');
            return null;
        }
        // 保护窗：open turn 位置 + 焦点轮号（与 factor decide 同焦点口径）。
        const latestTurn = atoms.reduce((m, a) => Math.max(m, a.turn), 0);
        const openTurnSeq = this.openTurnFirstSeq(session);
        const openTurnFromPos = openTurnSeq === null ? null : Math.max(0, surfaceSeqs.indexOf(openTurnSeq));
        const focalTurns = this.focalTurnsOf();
        const protectFromTurn = focalTurns > 0 ? latestTurn - focalTurns + 1 : Number.POSITIVE_INFINITY;
        const plan = planProseEviction(atoms, probes, surfaceSeqs, { needChars, protectFromTurn, openTurnFromPos });
        if (plan.stopReason === 'no-candidate') {
            this.host.log.info('[argp-factor-prose] 无可驱逐散文段（全部受保护/含 barrier）：不浓缩');
            return null;
        }
        // 摘要输入 = sys + 被驱逐散文（span+partial 的 textA，按 surface 位置序 replay）。
        const evictedSeqs = [...plan.spanSeqs, ...plan.partialSeqs];
        const evictedSet = new Set(evictedSeqs);
        const proseMessages = this.buildProseMessages(atoms, surfaceSeqs, evictedSet);
        const summary = await this.callLlm(spec, proseMessages, signal);
        if (summary.trim().length === 0) {
            this.host.log.warn('[argp-factor-prose] LLM 摘要空输出（保原文，本轮不浓缩）');
            return null;
        }
        // 发射：整轮段 1 区间 + 1 浓缩节点（不留逐原子墓碑）；partial 逐原子区间 + 指针墓碑。
        const atomsBySeq = new Map(atoms.map(a => [a.seq, a]));
        const intervals = [];
        const tombstones = [];
        if (plan.spanSeqs.length > 0) {
            const spanAtoms = plan.spanSeqs.map(s => atomsBySeq.get(s)).filter((a) => a !== undefined);
            const spanChars = plan.spanSeqs.reduce((sum, s) => sum + (atomsBySeq.get(s)?.text.length ?? 0), 0);
            intervals.push({ seqs: [...plan.spanSeqs], chars: spanChars, atoms: spanAtoms });
            tombstones.push({ type: 'user', text: proseCheckpointText(summary) });
        }
        for (const seq of plan.partialSeqs) {
            const atom = atomsBySeq.get(seq);
            if (atom === undefined)
                continue;
            intervals.push({ seqs: [seq], chars: atom.text.length, atoms: [atom] });
            tombstones.push({ type: 'user', text: seqRangePointer(seq) });
        }
        if (intervals.length === 0)
            return null;
        this.host.log.info('[argp-factor-prose] 浓缩 ' + plan.spanSeqs.length + ' 整轮节点 + ' + plan.partialSeqs.length
            + ' 散点散文（' + plan.evictedProseChars + ' chars）→ 单检查点；stop=' + plan.stopReason);
        return pruneIntervals(this.host, session, intervals, 0, intervals.length, false, tombstones, 'factor-prose');
    }
    /** 焦点轮数活读：宿主侧旋钮与 FactorEngine 同源（引擎构造期传 getter 到本类）。 */
    focalTurnsOf() {
        return this.cfg.focalTurns();
    }
    /** 散文占比统计（触发线日志/遥测复用；不读 LLM）。 */
    proseStats(session) {
        const events = sessionEvents(session);
        const surfaceSeqs = [...session.surface.nodes];
        let sysChars = 0;
        const headSeq = surfaceSeqs[0];
        const headEvent = headSeq !== undefined ? events[headSeq] : undefined;
        if (headEvent !== undefined && headEvent.type === 'system/message')
            sysChars = eventText(session, headSeq).length;
        let proseCharsAll = 0;
        for (const a of this.host.atomize(session)) {
            if (a.type === 'U' || a.type === 'A')
                proseCharsAll += a.text.length;
        }
        return { sysChars, proseCharsAll };
    }
    buildProbes(session) {
        const events = sessionEvents(session);
        const probes = new Map();
        for (const seq of session.surface.nodes) {
            const data = events[seq]?.data;
            if (data === undefined)
                continue;
            const src = (data['source'] ?? data['message']?.source);
            const raw = Array.isArray(data['content']) ? data['content']
                : Array.isArray(data['message']?.content)
                    ? data['message'].content : [];
            const attachment = raw.some(b => {
                const t = b?.type;
                return t === 'image' || t === 'file';
            });
            probes.set(seq, { form: typeof src?.form === 'string' ? src.form : undefined, attachment });
        }
        return probes;
    }
    /** open turn 首节点 seq（detectOpenTurn 的位置版：日志尾向前找最近 turn/start）。 */
    openTurnFirstSeq(session) {
        const events = sessionEvents(session);
        for (let i = events.length - 1; i >= 0; i -= 1) {
            const e = events[i];
            if (e === undefined)
                continue;
            if (e.type === 'turn/start') {
                // turn/start 是 off-surface 事件：其 turn 号的首个 surface 节点 = 该 turn 号首个原子。
                const turn = typeof e.data?.turn === 'number'
                    ? e.data.turn : null;
                if (turn === null)
                    return null;
                for (const a of this.host.atomize(session)) {
                    if (a.turn === turn)
                        return a.seq;
                }
                return null;
            }
            if (e.type === 'turn/end')
                return null;
        }
        return null;
    }
    /** 被驱逐散文 → replay messages（U→user、A→assistant 纯文本；按 surface 位置序）。 */
    buildProseMessages(atoms, surfaceSeqs, evicted) {
        const atomsBySeq = new Map(atoms.map(a => [a.seq, a]));
        const messages = [];
        for (const seq of surfaceSeqs) {
            if (!evicted.has(seq))
                continue;
            const atom = atomsBySeq.get(seq);
            if (atom === undefined || atom.text.length === 0)
                continue;
            if (atom.type === 'U') {
                messages.push(createUserMessage({ content: [{ type: 'text', text: atom.text }], source: { kind: 'user' } }));
            }
            else if (atom.type === 'A') {
                messages.push(createAssistantMessage({
                    source: { provider: 'argp-prose', model: 'condense-replay' },
                    content: [{ type: 'text', text: atom.text }],
                }));
            }
        }
        return messages;
    }
    async callLlm(spec, proseMessages, signal) {
        if (this.cfg.complete !== undefined) {
            // 测试注入形：散文栈平铺进 prompt（形状同构：前缀 replay + 尾部指令）。
            const flat = proseMessages.map(m => {
                const blocks = m.content ?? [];
                return (m.role === 'assistant' ? 'A: ' : 'U: ')
                    + blocks.map(b => typeof b.text === 'string' ? b.text : '').join('');
            }).join('\n');
            return await this.cfg.complete(spec, flat + '\n\n' + PROSE_COMPACTION_INSTRUCTION, this.cfg.llmTimeoutMs);
        }
        return (await completeViaDshLlm(this.ctx, spec, PROSE_COMPACTION_INSTRUCTION, this.cfg.llmTimeoutMs, proseMessages, undefined, signal, PROSE_SUMMARY_MAX_TOKENS)).text;
    }
    /** spec 解析同 UaSummarizer：路由齐 + 宿主 llm 服务在位，缺一即 disabled。 */
    resolveSpec(route) {
        if (this.cfg.complete !== undefined) {
            const provider = route.provider;
            const model = route.model;
            return provider !== undefined && provider !== '' && model !== undefined && model !== ''
                ? { provider, model } : null;
        }
        return autoDshLlmSpec(this.ctx, route);
    }
}
/** partial 散点的指针墓碑（标准 [elided] 文法：可并、后续贪心可吞；原文在日志 seq）。 */
function seqRangePointer(seq) {
    // tombstone-text 的 seqRangeTombstone 是图臂文法出口；此处内联同文法单节点形，
    // 避免给零依赖叶模块引入反向 import（叶纪律见 tombstone-text.ts 头注）。
    return '[elided seq=' + seq + '; recall_pruned(' + seq + ') for detail]';
}
