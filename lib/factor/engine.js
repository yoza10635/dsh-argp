/**
 * 因子引擎组合根（design-2.0 §3.2）：贴标 → 排序 → plan → prune-tx 成对发射。
 *
 * 全链 0 LLM（G7 口径）：本文件无 LLM import；摘要在 prose-condenser（P6-④）。
 *
 * 账本一致性策略：**被剪账本 = shadowed 集合的投影**——发射侧零手动记账，
 * resume 重放与在线新增走同一条观察路（scanShadowedSeqs 引擎无关，
 * §1.5-9 无版本 pin 裁定的落点）。observeR/addPruned 由 ledger 的 rootSeq
 * 去重保证幂等，重复扫描无害——P1-d 正确性优先，增量缓存留给 P3 性能项。
 *
 * 可再生性采样的时序纪律（释放向，I-DIR）：**只在事件首次在线观察到时采样**
 * 文件基线；重放批（引擎挂上前的历史）不采样——启动后才 stat 到的 mtime
 * 无法区分"R 读后文件没动"与"R 读后已变又恰好没再变"，一律按未知（不可再生）。
 *
 * 装配侧不变量（argp-engine 构造器执行）：
 *  - engine='factor' ⇒ compressor/declarer/zoom 三管线不挂（1.x 遗留通道整体退位）；
 *  - 本类只剪 R（content-only 最小桩，宿主 assertToolResultRewrite 形态）；
 *    A 永不入剪枝区间（恒留待摘要），协议组互锁因此天然满足。
 */
import { appendFileSync } from 'node:fs';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction';
import { detectOpenTurn, eventText, rawEventText, resolveRootSeqs, scanShadowedSeqs, sessionEvents } from "../log-access.js";
import { DEFAULT_CHARS_PER_TOKEN, DEFAULT_FOCAL_TURNS, DEFAULT_VOCAB_TOP_N, FACTOR_COMPACTED_MARKER, FACTOR_STUB_RUN_MIN, FOCAL_DOC_HARD_WIDTH_RATIO, FOCUS_GROUP_CAP, FOCUS_QUOTA_BUDGET_RATIO, FOCUS_QUOTA_GROUPS, FOCUS_TURN_SHARE_THRESHOLD, VOCAB_NOTE_MARKER } from "../constants.js";
import { proseTextOf } from "./prose-scan.js";
import { pruneIntervals } from "../prune-tx.js";
import { focalCommandLabels, focalLabels, hasAttachmentBlocks, sessionCwdFromEvents, supersededMarks, tagRsFromLog } from "./factor-atoms.js";
import { isRecallTool } from "./recall-tools.js";
import { resolveDispatchMode, resolveDispatchShadowLogPath } from "./dispatch.js";
import { HOST_REINJECTED_FORMS, HOST_REINJECTED_KINDS } from "./ua-input.js";
import { CLIP_MARK, clipFamilyOf, clipReserveChars, clipText } from "./clip-shape.js";
import { FactorLedger, indexKeys, renderVocabulary } from "./factor-ledger.js";
import { computeScore, planPrune } from "./retention-score.js";
import { READ_TOOLS } from "./tag-extract.js";
import { INTERACTIVE_PREVIEW_TOOLS, interactiveCheckpointText, isInteractiveToolKey } from "./interactive.js";
/**
 * focalTiered 的 env 逃生口（T-3 两臂实跑唯一触达通道）：tiered 是策略档，
 * 禁入 static Config（P5-b 裁定，ZK1/preset 键锁不变），生产装配路径
 * 缺省恒 flat——要跑 tiered 臂只能经此 env。非法值 ⇒ flat（缺省安全）；
 * 生效=构造快照（档切换=策略文档换版，须重挂引擎，不做活读）。
 */
export function resolveFocalTiered(env = process.env) {
    return env['ARGP_FACTOR_TIER'] === 'tiered' ? 'tiered' : 'flat';
}
/**
 * P6-④ 触发收敛的评测逃生口（focalTiered 同款纪律：禁入 static Config，env 是唯一通道）：
 * 缺省 = 估算驱动退役（只认手动 compact + context 报错两信号，估算永不触发破坏性改写）；
 * env 置 1 恢复旧 pre-step 估算驱动路径（压力剪 + 缺口摘要 + note 每 pre-step 刷新，
 * 旧世界字节级复现，供修前/修后对照臂）。非法值 ⇒ 缺省（退役生效，安全方向）。
 * 生效 = 构造期快照（档切换须重挂引擎，不做活读）。
 */
export function resolvePressureTriggerEnabled(env = process.env) {
    return env['ARGP_FACTOR_PRESSURE'] === '1';
}
/**
 * C10 夹剪层评测逃生口（focalTiered 同款纪律：禁入 static Config，
 * ZK1/preset 键锁不变，env 是唯一通道）：缺省关=shadow 二态（R1 行为字节
 * 不变）；env 置 1 开启三态（归位见 planPrune.clipOrder，剪形见 clip-shape.ts）。
 * 生效=构造快照（层切换=策略文档换版，须重挂引擎）。非法值 ⇒ 关（缺省安全）。
 */
export function resolveClipEnabled(env = process.env) {
    return env['ARGP_FACTOR_CLIP'] === '1';
}
/**
 * §D 影子反事实逃生口（同 clip 纪律：env 唯一通道，缺省关=字节不变）：
 * `ARGP_FACTOR_SHADOW=1` 打开；日志落到 `ARGP_FACTOR_SHADOW_LOG`（未设则只读不写）。
 * 只旁路重算并**记录**「把 sticky/focal/err 从硬保护降级为软评分」后的剪序差异，
 * 发射用的 plan 不受任何影响。
 */
export function resolveShadowEnabled(env = process.env) {
    return env['ARGP_FACTOR_SHADOW'] === '1';
}
/**
 * §D 量化排序臂（同 clip/shadow 纪律：env 唯一通道，缺省关=字典序字节不变）：
 * `ARGP_FACTOR_QSCORE=1` ⇒ 软集按净保留代价标量排序（retention-score.qPriority）。
 * 硬保护位不解锁（§D 影子实锤）；A/B 达标才谈翻缺省。
 */
export function resolveQScoreEnabled(env = process.env) {
    return env['ARGP_FACTOR_QSCORE'] === '1';
}
export function resolveEgress(env = process.env, compactionThreshold = 0) {
    if (env['ARGP_FACTOR_EGRESS'] === '0')
        return { enabled: false, lineRatio: null };
    if (compactionThreshold > 0)
        return { enabled: true, lineRatio: compactionThreshold };
    if (env['ARGP_FACTOR_EGRESS'] === '1')
        return { enabled: true, lineRatio: null };
    // 缺省面：接管=开（死亡带唯一防线）；off/shadow=关（旧世界现网行为不变）。
    return resolveDispatchMode(env) === 'takeover'
        ? { enabled: true, lineRatio: null }
        : { enabled: false, lineRatio: null };
}
/** 词表 note 的行首标记（单一事实源在 constants.ts；此处保留 re-export 供既有测试/调用方）。 */
export { VOCAB_NOTE_MARKER };
/**
 * 词表引导（2.2.3 起同时供 systemPrompt.context 快照与旧 note 回退使用）：
 * 只在**首次压缩事务后**出现——压缩前没有被剪内容，无需指引；目录内容由事务
 * 成功收尾时的会话快照冻结，不在每次请求重新从 live ledger 生成。
 *
 * 2.2.3 补一句**置信语义**（元认知复盘）：证据被剪既不证明结论为真、也不证明为假。
 * 缺了工具结果的结论最容易被后续模型读成"置信度下降"，于是重做一遍或悄悄降级表述；
 * 正确动作是召回原文核对。与 `prose-condenser` 的 provenance 规则互补：那边管
 * "写摘要时别升级"，这边管"读历史时别因为看不见证据就改判"。
 */
const VOCAB_NOTE_GUIDE = 'Pruned atoms remain in the append-only log. If an answer depends on content no longer visible, recall it with recall_history using the labels below — never reconstruct from memory. Elision is not a verdict: a tool result being gone neither confirms nor refutes the conclusion it supported, so do not silently restate an earlier conclusion as more or less certain — recall the original and re-check before relying on it. If no document label matches, shell-read content may carry command:<family> labels, and directory-level scope:<dir> addresses may also exist — list_labels(category:\'command\' or \'scope\') enumerates them (not listed below). For conversation prose that was condensed away (it has no label), search_history(keyword=...) greps the log verbatim. Replies must be self-contained: restate facts, do not point at earlier context.';
const vocabNoteText = (labels) => VOCAB_NOTE_MARKER + '\n' + VOCAB_NOTE_GUIDE + '\n' + labels;
/**
 * 焦点尾窗规划（2026-11-13 用户裁定）：**只在最新轮自身过大时**把焦点从整轮
 * 降级为该轮最新的至多 `cap` 个 A+R 协议组。正常轮（占比 <阈值或组数 ≤cap）
 * 原样返回 escalated=false，硬保护/组剪/排序全部走现行 turn 判据（零行为变化）。
 *
 * 判据用 A/R 字节占比作代理（本轮真实 token 密度未知；用户原话"最后一轮上下文
 * 占比超过已有的一半"）。组按 A 的 surface 位置排序，取最新 cap 组；焦点集含
 * A 与其全部 live R（闭包，组不拆分）。
 *
 * 2.2.1 包二（A1）追加：非升级态下产出**降级带候选**（超出焦点名额的旧组）——
 * 位置门放宽，事实门（superseded 判死）在 decide 裁决；升级态走原 cap 路径字节不变。
 */
export function planFocusTail(atoms, surfaceSeqs, opts) {
    const empty = {
        escalated: false, focusSeqs: new Set(), groupCount: 0, latestTurnGroupCount: 0, latestTurnShare: 0,
        demotedGroups: [], quotaUsed: opts.quotaGroups,
    };
    if (!Number.isFinite(opts.protectFromTurn) || opts.cap <= 0)
        return empty;
    const atomBySeq = new Map();
    let allChars = 0;
    let latestChars = 0;
    for (const a of atoms) {
        // U 也入位置表：focalFromPos 要落在本轮 user 消息之后，clone A/R 的 turn=0
        // 才能被位置线收进焦点区（占比仍只算 A/R，U 不是可剪面）。
        atomBySeq.set(a.seq, a);
        if (a.type !== 'A' && a.type !== 'R')
            continue;
        allChars += a.text.length;
        if (a.turn === opts.latestTurn)
            latestChars += a.text.length;
    }
    const latestTurnShare = allChars > 0 ? latestChars / allChars : 0;
    // 位置守卫：焦点区起点 = 首个 turn ≥ 边界的 surface 位置（覆盖 clone turn=0）。
    let focalFromPos = Number.POSITIVE_INFINITY;
    for (let i = 0; i < surfaceSeqs.length; i += 1) {
        const atom = atomBySeq.get(surfaceSeqs[i]);
        if (atom !== undefined && atom.turn >= opts.protectFromTurn) {
            focalFromPos = i;
            break;
        }
    }
    if (!Number.isFinite(focalFromPos))
        return { ...empty, latestTurnShare };
    const posOf = new Map();
    for (let i = 0; i < surfaceSeqs.length; i += 1)
        posOf.set(surfaceSeqs[i], i);
    const rByCall = new Map();
    for (const a of atoms) {
        if (a.type !== 'R' || a.toolCallIds[0] === undefined)
            continue;
        const cid = a.toolCallIds[0];
        const list = rByCall.get(cid);
        if (list === undefined)
            rByCall.set(cid, [a]);
        else
            list.push(a);
    }
    const groups = [];
    for (const a of atoms) {
        if (a.type !== 'A' || a.toolCallIds.length === 0)
            continue;
        const pos = posOf.get(a.seq);
        if (pos === undefined || pos < focalFromPos)
            continue;
        const defined = a.toolCallIds.flatMap(cid => rByCall.get(cid) ?? []);
        groups.push({ aSeq: a.seq, turn: a.turn, pos, seqs: [a.seq, ...defined.map(r => r.seq)] });
    }
    groups.sort((a, b) => a.pos - b.pos);
    const latestTurnGroupCount = groups.filter(g => g.turn >= opts.latestTurn).length;
    const escalated = latestTurnGroupCount > opts.cap && latestTurnShare >= opts.shareThreshold;
    const focusSeqs = new Set();
    if (escalated) {
        for (const g of groups.slice(-opts.cap))
            for (const seq of g.seqs)
                focusSeqs.add(seq);
    }
    // A1 降级带（2.2.1 包二，仅非升级态）：open 区组不入带（本轮协议现场）；附件组豁免
    // 不占名额（附件本就不可文本召回，位置保护对它是恒保护）。可排名组按位置从新到旧
    // 取最新 quotaUsed 组仍硬保护，更旧的进候选带——**事实门**（全组 R 判死）在 decide
    // 裁决，这里只出位置与组形。名额 = min(N, ⌊δ·W_eff·cpt / 组均字节⌋)，下限 1；
    // 窗未知/折算不可得 ⇒ 回退 N（manual/无快照字节兼容旧形态）。
    let openFromPos = Number.POSITIVE_INFINITY;
    if (opts.openTurn !== null) {
        for (let i = 0; i < surfaceSeqs.length; i += 1) {
            const atom = atomBySeq.get(surfaceSeqs[i]);
            if (atom !== undefined && atom.turn >= opts.openTurn) {
                openFromPos = i;
                break;
            }
        }
    }
    const rankable = groups.filter(g => g.pos < openFromPos && !g.seqs.some(s => opts.attachmentSeqs.has(s)));
    const rankableChars = rankable.reduce((n, g) => n + g.seqs.reduce((m, s) => m + (atomBySeq.get(s)?.text.length ?? 0), 0), 0);
    const avgGroupChars = rankable.length > 0 ? rankableChars / rankable.length : 0;
    const budgetChars = opts.windowEffTokens !== undefined && opts.windowEffTokens > 0
        && opts.charsPerToken > 0 && avgGroupChars > 0
        ? opts.quotaBudgetRatio * opts.windowEffTokens * opts.charsPerToken
        : undefined;
    const quotaUsed = budgetChars === undefined
        ? opts.quotaGroups
        : Math.max(1, Math.min(opts.quotaGroups, Math.floor(budgetChars / avgGroupChars)));
    const demotedGroups = escalated ? []
        : rankable.slice(0, Math.max(0, rankable.length - quotaUsed)).map(g => [...g.seqs]);
    return {
        escalated, focusSeqs, groupCount: groups.length, latestTurnGroupCount, latestTurnShare,
        demotedGroups, quotaUsed,
    };
}
/**
 * A+R 组剪选择（2026-11-13 用户裁定，design-group-prune）：
 *  - R 入选（或已是因子桩）且 A 的全部 callId 闭包成立 ⇒ A+R 整组驱逐；
 *  - 旧 A+桩组（K pack）即使 R 未入选也驱逐（死重 GC，回收 K 面 args）；
 *  - A 有 live R（未入选）⇒ A 保留，selected R 走空 tool 桩；
 *  - 缺失 R 的 A（中断轮）只有在 forced（in selected）时才整组驱逐；
   *  - 焦点/open 保护：默认（focusSeqs=null）非 forced 组必须 turn < protectFromTurn
   *    且不在 open turn；焦点尾窗降级（focusSeqs≠null）时改按焦点原子集保护，焦点外
   *    组（含 open 轮内）可整组驱逐；
   *  - A1 降级集（2.2.1 包二，demotedSeqs，仅 focusSeqs=null 侧生效）：事实门已判死
   *    的组放宽位置/轮次两道**位置门**；missing/live R/附件/连续性**事实门一律不放宽**；
   *  - 组 seqs 必须是 surface 连续切片（防止 replace 区间吞掉夹在中间的节点）。
   */
export function planProtocolGroups(atoms, surfaceSeqs, selected, opts) {
    const atomBySeq = new Map();
    for (const a of atoms)
        atomBySeq.set(a.seq, a);
    // 一个 callId 可能对应多个 live R（tool 重试/恢复/元数据复制）——全收，不能 last-wins，
    // 否则 forced 组会带走 A+一枚 R、把另一枚变成孤儿（审查 P1-3）。
    const rByCall = new Map();
    for (const a of atoms) {
        if (a.type !== 'R' || a.toolCallIds[0] === undefined)
            continue;
        const cid = a.toolCallIds[0];
        const list = rByCall.get(cid);
        if (list === undefined)
            rByCall.set(cid, [a]);
        else
            list.push(a);
    }
    const posOf = new Map();
    for (let i = 0; i < surfaceSeqs.length; i += 1)
        posOf.set(surfaceSeqs[i], i);
    // 位置守卫（审查 P1-2）：A.turn 缺失/被克隆成 0 时，turn 号守卫会放行物理上属于
    // open/focal 区的组。用「首个 turn ≥ 边界 的 surface 位置」补一道位置线。
    const firstPosAtOrAfterTurn = (turn) => {
        for (let i = 0; i < surfaceSeqs.length; i += 1) {
            const atom = atomBySeq.get(surfaceSeqs[i]);
            if (atom !== undefined && atom.turn >= turn)
                return i;
        }
        return Number.POSITIVE_INFINITY;
    };
    const openFromPos = opts.openTurn === null ? Number.POSITIVE_INFINITY : firstPosAtOrAfterTurn(opts.openTurn);
    const focalFromPos = Number.isFinite(opts.protectFromTurn) ? firstPosAtOrAfterTurn(opts.protectFromTurn) : Number.POSITIVE_INFINITY;
    const isStub = (a) => opts.stubSeqs.has(a.seq);
    const groups = [];
    const consumed = new Set();
    for (const a of atoms) {
        if (a.type !== 'A' || a.toolCallIds.length === 0)
            continue;
        const forced = selected.has(a.seq);
        const rs = a.toolCallIds.map(cid => rByCall.get(cid) ?? []);
        const defined = rs.flat();
        // A1 降级组（仅非升级态消费）：放宽下面 turn 门与末尾位置门；事实门不动。
        const demoted = opts.focusSeqs === null && opts.demotedSeqs !== undefined
            && opts.demotedSeqs !== null && opts.demotedSeqs.has(a.seq);
        if (opts.focusSeqs !== null) {
            // 焦点尾窗降级：只保护焦点组；焦点外的 open 轮组也可整组离场（尾窗之外=旧工作集）。
            const inFocus = opts.focusSeqs.has(a.seq) || defined.some(r => opts.focusSeqs.has(r.seq));
            if (inFocus && !forced)
                continue;
        }
        else if (!demoted) {
            if (opts.openTurn !== null && a.turn >= opts.openTurn)
                continue;
            if (!forced && a.turn >= opts.protectFromTurn)
                continue;
        }
        const missing = rs.some(list => list.length === 0);
        if (missing && !forced)
            continue; // 缺失 R 且非 forced：交给原 forced 链
        if (!defined.some(r => selected.has(r.seq) || isStub(r)))
            continue; // 组内无一枚被选中 ⇒ 整组不动
        // 附件硬保护（审查 P0-5）：image/file 不能被 recall_history（文本）召回，组剪不得吞；
        // A 侧附件（assistant content image/file）同样保护。
        if (opts.attachmentSeqs.has(a.seq) || defined.some(r => opts.attachmentSeqs.has(r.seq)))
            continue;
        if (defined.length === 0 && !forced)
            continue; // 无 R 的 A 只有 forced 才整组走
        const seqSet = new Set([a.seq, ...defined.map(r => r.seq)]);
        let start = Number.POSITIVE_INFINITY;
        let end = -1;
        let posMissing = false;
        for (const s of seqSet) {
            const p = posOf.get(s);
            if (p === undefined) {
                posMissing = true;
                break;
            }
            start = Math.min(start, p);
            end = Math.max(end, p);
        }
        if (posMissing)
            continue;
        const slice = surfaceSeqs.slice(start, end + 1);
        if (slice.length !== seqSet.size || !slice.every(s => seqSet.has(s)))
            continue; // 非连续：不误吞夹心节点
        if (opts.focusSeqs === null && !demoted) {
            if (start >= openFromPos)
                continue; // 位置守卫：物理上已在 open 区（A.turn 缺失也拦住）
            if (!forced && start >= focalFromPos)
                continue; // 位置守卫：物理上已进焦点区
        }
        const sliceAtoms = slice.map(s => atomBySeq.get(s));
        if (sliceAtoms.some(x => x === undefined))
            continue;
        const groupAtoms = sliceAtoms;
        const chars = groupAtoms.reduce((n, x) => n + x.text.length, 0);
        groups.push({ aSeq: a.seq, rSeqs: defined.map(r => r.seq), seqs: [...slice], chars, atoms: groupAtoms });
        for (const s of slice)
            consumed.add(s);
    }
    const rOnly = [...selected].filter(seq => {
        if (consumed.has(seq))
            return false;
        const atom = atomBySeq.get(seq);
        return atom !== undefined && atom.type === 'R';
    });
    return { groups, rOnly };
}
export class FactorEngine {
    /**
     * 被剪账本**按会话分桶**：账本键是 rootSeq（会话内 seq），引擎却是宿主进程级单例。
     * 共享一份 = A 会话的 seq 被 B 会话的 recall_history 取到 B 的无关事件（静默串台），
     * 且 addPruned 的 rootSeq 去重会让第二个会话的同 seq 条目被丢弃。
     * `ledger` 兼容读 = 最近一次被 observe/decide/vocabulary 触达的桶（单会话测试/诊断）。
     */
    ledgers = new WeakMap();
    lastLedger = new FactorLedger();
    states = new WeakMap();
    host;
    cfg;
    constructor(host, config = {}) {
        this.host = host;
        // 裸值/getter 双形归一：装配面传 getter（2.0.0 起 ArgpEngine 传固化常量
        // getter）；测试传裸值 = 固定值。设置页旋钮已退役，不再有 volatile 活读路径。
        const asGetter = (v, d) => typeof v === 'function' ? v : () => v ?? d;
        this.cfg = {
            focalTurns: asGetter(config.focalTurns, DEFAULT_FOCAL_TURNS),
            vocabTopN: asGetter(config.vocabTopN, DEFAULT_VOCAB_TOP_N),
            stickyWindowTurns: config.stickyWindowTurns ?? 8,
            vocabBudgetChars: config.vocabBudgetChars ?? 4000,
            focalTiered: config.focalTiered ?? 'flat',
            clipEnabled: config.clipEnabled === true,
            qScoreEnabled: config.qScoreEnabled === true,
            proseScanCapChars: config.proseScanCapChars,
        };
    }
    /** 会话账本（懒建；见 ledgers 字段注释）。public：召回工具按执行会话取桶。 */
    /** 散文带 cap 覆盖（search_history 装配读；undefined ⇒ 装配层按窗相对现算）。 */
    proseScanCapOverride() {
        return this.cfg.proseScanCapChars;
    }
    ledgerOf(session) {
        let l = this.ledgers.get(session);
        if (l === undefined) {
            l = new FactorLedger();
            this.ledgers.set(session, l);
        }
        this.lastLedger = l;
        return l;
    }
    /** 兼容读：最近一次被 observe/decide/vocabulary 触达的会话账本（诊断/单会话测试）。 */
    get ledger() {
        return this.lastLedger;
    }
    /**
     * 召回入口账本（冷 resume 修复）：新进程里进程内账本是空的，而账本的唯一真相是
     * 日志（被剪 R 的 shadowed 投影 + 原事件仍在）。召回工具直接读账本 ⇒ 必须先在
     * 首召回时补一次 observe 重放；否则 resume 后 `list_labels` 谎报 0 条、
     * `recall_history` 永远 no match，直到下一次压缩事务才"突然恢复"。
     * 幂等：observe 的 rootSeq 去重保证重复重放不双计；每会话每进程至多补一次
     * （后续压缩事务已在线更新）。
     */
    ledgerForRecall(session) {
        const st = this.stateOf(session);
        if (!st.ledgerReady)
            this.observe(session);
        return this.ledgerOf(session);
    }
    stateOf(session) {
        let st = this.states.get(session);
        if (st === undefined) {
            st = { observedUpToSeq: -1, ledgerReady: false, snapshots: new Map(), vocabNoteSeq: null, vocabEpoch: -1 };
            this.states.set(session, st);
        }
        return st;
    }
    /**
     * 观察路（sticky 通道 + 被剪账本 + 在线文件快照）。幂等：ledger rootSeq 去重。
     */
    observe(session) {
        const events = sessionEvents(session);
        const ledger = this.ledgerOf(session);
        const atoms = this.host.atomize(session);
        // 宿主 0.1.5+ 的 cwd 在 Session.header（creation metadata，**不进事件日志**）；
        // 旧日志兜底扫 session 事件。取不到就保持 undefined（绝不拿当前进程 cwd 凑）。
        const cwd = session.header?.cwd
            ?? sessionCwdFromEvents(events);
        const st = this.stateOf(session);
        const first = st.observedUpToSeq === -1;
        // 日志根事件驱动（resume 正解）：被剪 R 的原事件已离场 surface，只有遍历日志
        // + resolveRootSeqs 折链才能重建被剪账本；桩事件排除（tagRsFromLog 内）。
        const tagsBySeq = tagRsFromLog(events, cwd, seq => resolveRootSeqs(events, seq));
        const shadowed = scanShadowedSeqs(session);
        for (const [seq, input] of tagsBySeq) {
            ledger.observeR(seq, input.turn, input.tags);
            // preview 随贴标同行（tagRsFromLog 单点提取）——在线/重建同路 ⇒ ZT6 逐字节一致。
            if (shadowed.has(seq))
                ledger.addPruned({ rootSeq: seq, turn: input.turn, tags: input.tags, preview: input.preview });
        }
        // 在线快照采样：仅首观察且非重放批的 R
        if (this.host.fileSnapshot !== undefined) {
            for (const [seq, input] of tagsBySeq) {
                if (seq <= st.observedUpToSeq || (first && seq <= (events[events.length - 1]?.seq ?? -1)))
                    continue;
                if (!READ_TOOLS.has(input.tool) || input.tags.files.length === 0 || st.snapshots.has(seq))
                    continue;
                const snap = new Map();
                for (const key of input.tags.files.slice(0, 4)) {
                    const s = this.host.fileSnapshot(key);
                    if (s !== null && s !== undefined)
                        snap.set(key, s);
                }
                if (snap.size > 0)
                    st.snapshots.set(seq, snap);
            }
        }
        const tailSeq = events.length > 0 ? (events[events.length - 1]?.seq ?? st.observedUpToSeq) : st.observedUpToSeq;
        st.observedUpToSeq = Math.max(st.observedUpToSeq, tailSeq);
        st.ledgerReady = true;
        ledger.sweepClosed(atoms.reduce((m, a) => Math.max(m, a.turn), 0), this.cfg.stickyWindowTurns);
        return { atoms, tagsBySeq, cwd };
    }
    /** 纯决策（无发射副作用）：单测主对象。targetReleaseChars = 需释放的下界。 */
    decide(session, targetReleaseChars, opts) {
        const { atoms, tagsBySeq, cwd } = this.observe(session);
        const latestTurn = atoms.reduce((m, a) => Math.max(m, a.turn), 0);
        const openTurn = detectOpenTurn(session);
        const shadowed = scanShadowedSeqs(session);
        const focalTurns = this.cfg.focalTurns();
        const protectFromTurn = focalTurns > 0 ? latestTurn - focalTurns + 1 : Number.POSITIVE_INFINITY;
        // 焦点尾窗降级（用户 2026-11-13）：只在最新轮自身占比 ≥50% 且组数 >10 时触发；
        // 否则 focusEscalated=false，下面所有焦点判据走现行 turn 路径（零行为变化）。
        const surfaceSeqs = [...session.surface.nodes];
        // A1 名额的 barrier 豁免面（2.2.1 包二）：R 侧附件从 tagsBySeq 取（与硬保护位
        // attachment 同源）；A 侧附件罕见，由发射端 attachmentSeqs 事实门兜底（不降级≠可驱逐）。
        const barrierSeqs = new Set();
        for (const [seq, input] of tagsBySeq)
            if (input.hasAttachment === true)
                barrierSeqs.add(seq);
        const focusTail = planFocusTail(atoms, surfaceSeqs, {
            protectFromTurn, cap: FOCUS_GROUP_CAP, latestTurn, shareThreshold: FOCUS_TURN_SHARE_THRESHOLD,
            quotaGroups: FOCUS_QUOTA_GROUPS, quotaBudgetRatio: FOCUS_QUOTA_BUDGET_RATIO,
            openTurn, charsPerToken: DEFAULT_CHARS_PER_TOKEN, attachmentSeqs: barrierSeqs,
            windowEffTokens: opts?.windowEffTokens,
        });
        const focusEscalated = focusTail.escalated;
        const focal = focalLabels(atoms, latestTurn, focalTurns, cwd);
        const tiered = this.cfg.focalTiered === 'tiered';
        const focalDocSet = new Set([...focal].filter(k => k.startsWith('document:')));
        // medium 带原料（§2.5 v1.1）：焦点窗内 tool/call 的 args 命令族（白名单准入）。
        // flat 恒空集——现行为字节不变（文本通道从未产过命令标签，事件通道同关）。
        const focalMedium = new Set();
        if (tiered) {
            const calls = [];
            for (const e of sessionEvents(session)) {
                if (e.type !== 'tool/call')
                    continue;
                const d = e.data;
                calls.push({ turn: typeof d.turn === 'number' ? d.turn : 0, name: String(d.name ?? ''), args: d.arguments });
            }
            for (const k of focalCommandLabels(calls, latestTurn, focalTurns))
                focalMedium.add(k);
        }
        const superseded = supersededMarks(tagsBySeq);
        // A1 事实门（2.2.1 包二）：只有全组 defined R 均被 superseded 判死的组进降级集；
        // 无 R 的组（中断轮/纯 A）不因位置降级——事实门不放宽（missing/live 门发射端仍拦）。
        // 降级=整组（A 与其 R 同进退），发射端对集内 A 放宽位置/轮次门。
        const demotedSeqs = new Set();
        let demotedGroupCount = 0;
        if (!focusEscalated && focusTail.demotedGroups.length > 0) {
            const typeBySeq = new Map();
            for (const a of atoms)
                typeBySeq.set(a.seq, a.type);
            for (const gseqs of focusTail.demotedGroups) {
                const rs = gseqs.filter(s => typeBySeq.get(s) === 'R');
                if (rs.length === 0)
                    continue;
                if (rs.every(s => superseded.get(s) === true)) {
                    demotedGroupCount += 1;
                    for (const s of gseqs)
                        demotedSeqs.add(s);
                }
            }
        }
        const st = this.stateOf(session);
        const sticky = this.ledgerOf(session).stickyActive();
        const candidates = new Map();
        const facts = [];
        for (const a of atoms) {
            if (a.type !== 'R')
                continue;
            if (shadowed.has(a.seq))
                continue;
            const input = tagsBySeq.get(a.seq);
            if (input === undefined)
                continue;
            candidates.set(a.seq, input);
            // P6-③ 裁定 2：召回对（recall_history/list_labels 的 result）可再生=再召回一次，
            // 全部硬保护位失效（轮闭合后进剪序）；排序照常走 freshness（刚引用=新鲜，迟剪）。
            // 未闭合轮的 R：本轮协议现场（模型可能尚未消化），硬保护不进排序
            const inOpenTurn = openTurn !== null && a.turn >= openTurn;
            // P1（2026-11-17 注入预审实锤）：在轮已返回的召回 R 是**尚未消化的协议输入**——
            // 裁定 2 的"下次压缩驱逐"=轮闭合后的下一事务；同轮第二笔压缩事务把刚返回的
            // recall/list_labels 结果剪成空克隆=高压时召回面自废（provider 看到的是空 tool/result）。
            // 轮闭合后回到裁定 2 无条件进剪序。
            if (inOpenTurn && isRecallTool(input.tool))
                continue;
            // 焦点尾窗降级时，只有最新 cap 组内的 R 算焦点；其余走普通排序/释放阀。
            const inFocus = focusEscalated && focusTail.focusSeqs.has(a.seq);
            const keys = indexKeys(input.tags);
            const focalMatch = keys.some(k => focal.has(k));
            let regenerable;
            const snap = st.snapshots.get(a.seq);
            if (snap !== undefined && this.host.fileSnapshot !== undefined && READ_TOOLS.has(input.tool)) {
                const cur = this.host.fileSnapshot(input.tags.files[0] ?? '');
                regenerable = cur !== null && cur !== undefined
                    && [...snap.values()].every(s => s.mtimeMs === cur.mtimeMs && s.size === cur.size);
            }
            // 硬保护只认**已定型 sticky** 轨；open 轨是词表观察对象——open 也保护会把
            // 文本信号的一切误报升级为硬保护（实测：正常输出挂 ALL_CAPS 候选码即成轨）。
            const stickyMember = input.tags.errorcodes.length > 0 && input.tags.files.some(f => sticky.some(t => t.state === 'sticky' && t.file === f && input.tags.errorcodes.includes(t.errorcode)));
            facts.push({
                seq: a.seq, turn: a.turn, input, inOpenTurn, inFocus, regenerable, stickyMember, focalMatch,
                focalDocHit: tiered ? [...keys].filter(k => focalDocSet.has(k)) : [],
                mediumHit: tiered ? keys.some(k => focalMedium.has(k)) : false,
                isRecall: isRecallTool(input.tool),
            });
        }
        // 宽度熔断（§2.5 v1.1 护栏）：焦点文档 hard 候选字节占比超阈 ⇒ 每文档只保最新一枚
        let fuseActive = false;
        const docLatest = new Map();
        if (tiered) {
            let totalChars = 0;
            let docChars = 0;
            for (const f of facts) {
                totalChars += f.input.tags.sizeChars;
                if (f.focalDocHit.length > 0)
                    docChars += f.input.tags.sizeChars;
                for (const lbl of f.focalDocHit)
                    docLatest.set(lbl, Math.max(docLatest.get(lbl) ?? 0, f.seq));
            }
            fuseActive = totalChars > 0 && docChars > totalChars * FOCAL_DOC_HARD_WIDTH_RATIO;
        }
        // v1.2 路由 + v1.3 exemplar（tiered-only；spike52 共现账 / spike53 去重账 / spike54 errHard2sup 零成本列）：
        // 签名 = code × 共现因子（file 优先、command 次之；仅 tool ⇒ 裸码走词表，永不进 hard）。
        // hard 准入线 = 会话内同签名复发 ≥2（n=1 ⇒ 100% 假捆绑，用户裁定），且**只保 exemplar 一枚**；
        // 成功后失效：同因子后续无码 R 出现 ⇒ 释放（spike53 实测 29% 组落此）。
        const errSigHardSeqs = new Set();
        const stickyExemplarSeqs = new Set();
        if (tiered) {
            const groups = new Map();
            for (const f of facts) {
                const t = f.input.tags;
                if (t.errorcodes.length === 0)
                    continue;
                const factor = t.files[0] ?? t.commands[0] ?? null;
                const sigFactor = t.files[0] !== undefined ? 'f:' + t.files[0]
                    : t.commands[0] !== undefined ? 'c:' + t.commands[0] : 't:' + f.input.tool;
                for (const code of t.errorcodes) {
                    const key = code + '|' + sigFactor;
                    const item = { seq: f.seq, factor, files: t.files, cmds: t.commands };
                    const g = groups.get(key);
                    if (g === undefined)
                        groups.set(key, [item]);
                    else
                        g.push(item);
                }
            }
            const successAfter = (seq, factor) => factor !== null && facts.some(r => r.seq > seq && r.input.tags.errorcodes.length === 0
                && (r.input.tags.files.includes(factor) || r.input.tags.commands.includes(factor)));
            for (const g of groups.values()) {
                if (g.length < 2)
                    continue; // n=1 假捆绑门槛（变异锁：摘此门槛测"n=1 豁免"必须红）
                const ex = g.reduce((m, x) => (x.seq > m.seq ? x : m));
                if (ex.factor === null || successAfter(ex.seq, ex.factor))
                    continue; // 裸码走词表；成功后失效
                errSigHardSeqs.add(ex.seq);
            }
            // sticky 归因一枚化（spike53：67 枚/249KB 正被逐枚硬保白烧）：每 (file×code) 对只保最新一枚，
            // 同一释放阀（成功后失效）；flat 保持逐枚硬保现行为。
            for (const t of sticky) {
                if (t.state !== 'sticky')
                    continue;
                let exemplar = -1;
                for (const f of facts) {
                    if (f.input.tags.errorcodes.includes(t.errorcode) && f.input.tags.files.includes(t.file) && f.seq > exemplar)
                        exemplar = f.seq;
                }
                if (exemplar >= 0 && !successAfter(exemplar, t.file))
                    stickyExemplarSeqs.add(exemplar);
            }
        }
        const entries = [];
        let focalDocHardChars = 0;
        let mediumBandChars = 0;
        const focalBandBySeq = new Map();
        // §D shadow counterfactual state — read-only; only used to log, never to emit.
        const shadowEnabled = resolveShadowEnabled(process.env);
        const shadowEntries = [];
        const shadowHardBySeq = new Map();
        for (const f of facts) {
            // 焦点尾窗降级时，焦点外 R 的 turn/label 焦点保护全部失效（组剪已按 focusSeqs
            // 保护最新 10 组；旧的同文档读不再因 label 命中被连带硬保）。
            // A1（包二）：事实门已判死的降级带 R 同样摘焦点位——判死组保焦点豁免=白烧名额。
            const demotedR = demotedSeqs.has(f.seq);
            const focusGate = (!focusEscalated || f.inFocus) && !demotedR;
            const focalDocStrong = tiered && focusGate && f.focalDocHit.length > 0
                && (!fuseActive || f.focalDocHit.some(lbl => docLatest.get(lbl) === f.seq));
            if (focalDocStrong)
                focalDocHardChars += f.input.tags.sizeChars;
            // 三值焦点带（§2.5 v1.1）：strong=文档面命中（hard 与否都占带位——熔断退 hard 时
            // 排序位仍沉底）；medium=白名单命令面（★永不 hard）；其余 none。flat 走布尔回退。
            const focalBand = tiered ? (f.focalDocHit.length > 0 ? 2 : f.mediumHit ? 1 : 0) : undefined;
            // A1：降级带判死 R 的 label 焦点命中同样失效（flat 档的 focalNonRegenerable/
            // superseded 焦点豁免/quant 焦点位都由本值裁决）。
            const effectiveFocal = (focusEscalated ? f.inFocus : f.focalMatch) && !demotedR;
            const effectiveBand = tiered
                ? (focusEscalated ? (f.inFocus ? focalBand : 0) : focalBand)
                : (effectiveFocal ? 1 : 0);
            if (tiered && effectiveBand === 1)
                mediumBandChars += f.input.tags.sizeChars;
            focalBandBySeq.set(f.seq, effectiveBand);
            // P6-③ 裁定 2：召回对全部硬保护位失效（无条件进剪序；可再生=再召回一次）。
            const hardFlags = f.isRecall ? {} : {
                // 焦点尾窗降级时，open 轮只保焦点组；焦点外旧组可离场（尾窗之外=旧工作集）。
                // A1：降级带按位置排除 open 区，demotedR 与 inOpenTurn 仅在现场轮 turn 数据
                // 异常时共存——判死组不当本轮协议现场保（与 focusGate 同一放宽口径的兜底）。
                failureNoFollowR: f.inOpenTurn && (!focusEscalated || f.inFocus) && !demotedR,
                // tiered：sticky 归因一枚化（只保 exemplar）；flat：逐枚硬保现行为。
                stickyMember: tiered ? f.stickyMember && stickyExemplarSeqs.has(f.seq) : f.stickyMember,
                // 附件保护：空文本（纯附件 R）或文本+附件混合——文本桩会把 image/file 一起丢。
                attachment: f.input.resultText.length === 0 || f.input.hasAttachment === true,
                // flat：现行为；tiered：焦点 hard 只认 document facet（v1.2 裸码降出），
                // 且经 focalDocStrong 连可再生枚一并保住。
                focalNonRegenerable: !tiered && focusGate && f.focalMatch && f.regenerable !== true,
                focalDocStrong,
                errSignatureHard: tiered && errSigHardSeqs.has(f.seq),
            };
            const scoreInput = {
                rootSeq: f.seq, turn: f.turn, currentTurn: latestTurn, tags: f.input.tags,
                hard: hardFlags,
                regenerable: f.regenerable,
                // v1.4 superseded 焦点豁免：命中焦点的枚不按"被新版覆盖"插队先剪
                // （spike54 冲突面 90 枚/211KB；spike55 定案：非焦点释放阀保留）。
                superseded: tiered && effectiveFocal ? undefined : superseded.get(f.seq) === true ? true : undefined,
                focal: effectiveFocal,
                focalBand: tiered ? effectiveBand : undefined,
            };
            entries.push({ rootSeq: f.seq, score: computeScore(scoreInput) });
            // §D shadow counterfactual (read-only, env-gated): demote the *content-value*
            // hard flags (sticky/focal/err) to soft ordering, KEEP protocol + attachment +
            // open-turn hard. Recomputed here; the emitted `plan` below is NOT affected.
            // Include every candidate (recall pairs already had hard={} so they match).
            if (shadowEnabled) {
                shadowHardBySeq.set(f.seq, Object.keys(hardFlags).filter(k => hardFlags[k] === true
                    && k !== 'failureNoFollowR' && k !== 'attachment'));
                shadowEntries.push({
                    rootSeq: f.seq,
                    score: computeScore({ ...scoreInput, hard: {
                            failureNoFollowR: hardFlags.failureNoFollowR,
                            attachment: hardFlags.attachment,
                        } }),
                });
            }
        }
        // P6-③ 裁定 3：中断轮驱逐（closed 轮）——半截 A（有 tool-call 却有未应答 call）+
        // 孤儿 R（callId 无在世 issuer A， issuer 已被先行事务带走）无条件强制先行，"驱逐时机
        // =下次压缩"，无视目标量；该轮 user 消息保留（U 恒不在 factor 剪序）。半截 A 的已应答
        // R 同行入序——user 墓碑替 A 会让它们孤儿化（provider 400 同级形态），必须同事务同去。
        const issuerAlive = new Set();
        const answered = new Set();
        const rByCall = new Map();
        for (const a of atoms) {
            if (a.type === 'A')
                for (const cid of a.toolCallIds)
                    issuerAlive.add(cid);
            if (a.type === 'R' && a.toolCallIds[0] !== undefined) {
                answered.add(a.toolCallIds[0]);
                rByCall.set(a.toolCallIds[0], a);
            }
        }
        const forcedFirst = [];
        const forcedSeen = new Set();
        const pushForced = (seq) => {
            if (!forcedSeen.has(seq)) {
                forcedSeen.add(seq);
                forcedFirst.push(seq);
            }
        };
        for (const a of atoms) {
            if (openTurn !== null && a.turn >= openTurn)
                continue; // open 轮 = 本轮协议现场，不驱逐
            if (a.type === 'A' && a.toolCallIds.length > 0 && a.toolCallIds.some(cid => !answered.has(cid))) {
                pushForced(a.seq);
                for (const cid of a.toolCallIds) {
                    const r = rByCall.get(cid);
                    if (r !== undefined)
                        pushForced(r.seq);
                }
            }
            if (a.type === 'R' && a.toolCallIds[0] !== undefined && !issuerAlive.has(a.toolCallIds[0])) {
                pushForced(a.seq);
            }
        }
        const clipOn = this.cfg.clipEnabled === true;
        const plan = planPrune(entries, {
            targetReleaseChars,
            forcedFirstSeqs: forcedFirst,
            // C10：夹剪预留按工具族模板经回调注入（语义归位在本模块，形状归 clip-shape）。
            ...(clipOn ? { clip: { reserveCharsOf: (e) => clipReserveChars(clipFamilyOf(tagsBySeq.get(e.rootSeq)?.tool ?? '')) } } : {}),
            // §D 量化臂：只作用于发射 plan 的软集排序；shadow 反事实臂恒 lex（对照基线不动）。
            ...(this.cfg.qScoreEnabled ? { orderMode: 'quant' } : {}),
        });
        // §D shadow counterfactual: run the same prune on the hard-demoted candidate set
        // and log cur-vs-shadow. This is observation only — `plan` above is what emits.
        if (shadowEnabled)
            this.logShadowCounterfactual(shadowEntries, plan, {
                targetReleaseChars, forcedFirst, clipOn, tagsBySeq, shadowHardBySeq, latestTurn,
            });
        return {
            plan, candidates, tagsBySeq, latestTurn,
            focalSize: focal.size, stickyActive: sticky.length, shortfallChars: plan.shortfallChars,
            focalTiered: this.cfg.focalTiered, clipEnabled: clipOn, qScoreEnabled: this.cfg.qScoreEnabled, focalDocHardChars, focalDocFuse: fuseActive,
            errSigHardCount: errSigHardSeqs.size,
            focalMediumSize: focalMedium.size, mediumBandChars, focalBandBySeq,
            interruptedForcedSeqs: forcedFirst,
            focusEscalated, focusSeqs: focusTail.focusSeqs,
            focusGroupCount: focusTail.groupCount, latestTurnShare: focusTail.latestTurnShare,
            demotedSeqs, demotedGroupCount,
            quotaBandGroups: focusTail.demotedGroups.length, quotaUsed: focusTail.quotaUsed,
        };
    }
    /**
     * §D 影子反事实记录（只读）：在同一批候选上，把 sticky/focal/err 从硬保护降级为
     * 软排序后重算一次 planPrune，把「多释放了哪些枚、各因哪个降级位、cur vs shadow 的
     * released/shortfall」写进日志。发射用的 plan 完全不受影响——本方法不返回、不改状态。
     */
    logShadowCounterfactual(shadowEntries, plan, o) {
        const path = process.env['ARGP_FACTOR_SHADOW_LOG'];
        if (path === undefined || path === '')
            return;
        try {
            const shadowPlan = planPrune(shadowEntries, {
                targetReleaseChars: o.targetReleaseChars,
                forcedFirstSeqs: o.forcedFirst,
                ...(o.clipOn ? { clip: { reserveCharsOf: (e) => clipReserveChars(clipFamilyOf(o.tagsBySeq.get(e.rootSeq)?.tool ?? '')) } } : {}),
            });
            const curOrder = new Set(plan.pruneOrder);
            const chars = (s) => o.tagsBySeq.get(s)?.tags.sizeChars ?? 0;
            const extraSeqs = shadowPlan.pruneOrder.filter(s => !curOrder.has(s)).map(s => ({
                seq: s, chars: chars(s), demoted: o.shadowHardBySeq.get(s) ?? [],
            }));
            appendFileSync(path, JSON.stringify({
                t: Date.now(), target: o.targetReleaseChars, latestTurn: o.latestTurn,
                candidates: shadowEntries.length,
                curReleased: plan.releasedChars, shadowReleased: shadowPlan.releasedChars,
                curShortfall: plan.shortfallChars, shadowShortfall: shadowPlan.shortfallChars,
                extraCount: extraSeqs.length, extraChars: extraSeqs.reduce((a, e) => a + e.chars, 0),
                extraSeqs,
            }) + '\n');
        }
        catch { /* observability must never affect the emitted decision */ }
    }
    /**
     * 压力剪一笔：决策 → 协议组（A+R 整组 + K pack）/ R-only 空桩 → prune-tx 成对发射。
     * 目标不达不放宽；组剪收益按区间实际 chars 复核。
     *
     * **2.2.2 根修（2026-11-26 session-43df801e 存档加载失败案）：本引擎不再发射任何
     * 非 append 的 tool/result。** 旧 C10 夹剪臂以「R-only tool/result replace 改写
     * inner text 保 callId 配对」发射，宿主 v4 fold 对该形态执行 requireTurn()，而压缩
     * 事务可落在轮间隙（手动 /compact 走宿主 idle maintenance，实证
     * compaction/start.data.turn === null）⇒ 无合法表达、写入侧不拦、下次加载整档
     * corrupt 拒载。根修把夹剪从「改写 R 节点」改为「组剪检查点的文本变体」：
     * 同一整组区间照常以 user/message 检查点离场（user replace 不受轮约束），
     * 检查点文本携带该组 R 的头尾预览（clip-shape 模板）而不是中性标记。
     * 因此 C10 的信息轴（信息悬崖 vs 头尾留真）保留，且发射形态与压缩时点无关。
     */
    compactIfNeeded(session, targetReleaseChars, opts) {
        if (targetReleaseChars <= 0)
            return null;
        const decision = this.decide(session, targetReleaseChars, opts);
        const { plan, tagsBySeq } = decision;
        const atoms = this.host.atomize(session);
        const atomsBySeq = new Map();
        for (const a of atoms)
            atomsBySeq.set(a.seq, a);
        const clipOn = this.cfg.clipEnabled === true;
        // C10 夹剪层（ARGP_FACTOR_CLIP=1，显式对照世界）：只改组剪检查点的**文本**——
        // 归位集 clipOrder 内的 R 用头尾预览文本，其余仍走中性/交互标记。剪枝决策面
        // （组选择/保护/守护）与 clip 关闭时逐字节相同 ⇒ A/B 隔离环境，变量只剩检查点文本。
        const clipSet = clipOn ? new Set(plan.clipOrder) : null;
        // 派生视图 provenance（审查 P0-3 + 2026-11-14 alpha3 实锤）：不按文本前缀判桩——
        // 「replace 克隆 ∧ root 已 shadowed」一律算 stub，覆盖两类派生副本：
        //   ① R-only 空 tool/result 克隆（本引擎 prune-tx 产物）；
        //   ② 原生 toolResultPruner 的 head/middle/tail 切片（组剪之后二次收紧产物）。
        // 原文都在 append-only 日志、标签可召回；若把 ② 当 live R，组闭包永远不成立，
        // pruner 切片就会变成永久配重（alpha3 终态 63.5% surface 实证）。
        const shadowedForStub = scanShadowedSeqs(session);
        const eventLog = sessionEvents(session);
        const stubSeqs = new Set();
        for (const a of atoms) {
            if (a.type !== 'R')
                continue;
            const roots = resolveRootSeqs(eventLog, a.seq);
            if (roots.includes(a.seq))
                continue;
            if (!roots.some(r => shadowedForStub.has(r)))
                continue;
            stubSeqs.add(a.seq);
        }
        const attachmentSeqs = new Set();
        for (const a of atoms) {
            const ev = eventLog[a.seq];
            if (ev !== undefined && hasAttachmentBlocks(ev.data))
                attachmentSeqs.add(a.seq);
        }
        const surfaceSeqs = [...session.surface.nodes];
        const selected = new Set(plan.pruneOrder);
        const focalTurns = this.cfg.focalTurns();
        const protectFromTurn = focalTurns > 0 ? decision.latestTurn - focalTurns + 1 : Number.POSITIVE_INFINITY;
        const openTurn = detectOpenTurn(session);
        const groupPlan = planProtocolGroups(atoms, surfaceSeqs, selected, {
            protectFromTurn, openTurn,
            // 焦点尾窗降级时只保护最新 10 组；未降级传 null = 旧 turn/open 判据字节不变。
            focusSeqs: decision.focusEscalated ? decision.focusSeqs : null,
            stubSeqs, attachmentSeqs,
            // A1（包二）：升级态走原 cap 路径（demotedSeqs 本就为空，显式置 null 上双保险）；
            // 非升级态透传事实门降级集——空集时发射面与旧行为逐字节一致。
            demotedSeqs: decision.focusEscalated ? null : (decision.demotedSeqs.size > 0 ? decision.demotedSeqs : null),
        });
        // [argp-quota] 影子列（2.2.1 包二，纯遥测）：本笔降级带的组形/名额账。放在事务
        // 前是因为 dispatch 影子记录早于发射落盘、拿不到组剪后计数；evicted* 为本笔发射
        // 计划口径（事实门全过 ⇒ 组可驱逐，实际是否随区间落盘受 prune-tx 预检）。
        if (decision.demotedGroupCount > 0 || decision.quotaBandGroups > 0) {
            const demotedHit = groupPlan.groups.filter(g => decision.demotedSeqs.has(g.aSeq));
            const quotaRecord = {
                t: Date.now(), mode: 'quota',
                quotaUsed: decision.quotaUsed, quotaBandGroups: decision.quotaBandGroups,
                demotedGroups: decision.demotedGroupCount,
                evictedGroups: demotedHit.length,
                evictedChars: demotedHit.reduce((n, g) => n + g.chars, 0),
            };
            this.host.log.info('[argp-quota] ' + JSON.stringify(quotaRecord));
            // 影子流水落盘（同 ARGP_FACTOR_DISPATCH_LOG 通道）：台架/评测臂靠这行判
            // 「名额是否真咬」——log.info 在 bench 取证里不可见，不落盘=观察哨失明。
            const quotaPath = resolveDispatchShadowLogPath();
            if (quotaPath !== undefined) {
                try {
                    appendFileSync(quotaPath, JSON.stringify(quotaRecord) + '\n');
                }
                catch { /* 落盘失败不改变任何发射 */ }
            }
        }
        const intervals = [];
        const tombstones = [];
        const consumed = new Set();
        let clipEmitted = 0;
        // 1) 协议组（A+R + 旧 A+桩 K pack）：整组离场，单个 user 压缩检查点占位（模型可见）。
        //    文本三态（2.2.2 根修后不再有 tool/result 形态）：
        //      - 夹剪（clip 开 ∧ 组内有 clipOrder 成员）⇒ 头尾预览文本；
        //      - 交互组 ⇒ 专段带 tool: 即时指针（P7=带 + ZT7/ZT10，措辞只提在场成员）；
        //      - 其余 ⇒ 零指针中性标记。
        for (const g of groupPlan.groups) {
            intervals.push({ seqs: g.seqs, chars: g.chars, atoms: g.atoms });
            const text = this.groupCheckpointText(session, g, tagsBySeq, clipSet);
            if (text.startsWith(CLIP_MARK))
                clipEmitted += 1;
            tombstones.push({ type: 'user', text });
            for (const s of g.seqs)
                consumed.add(s);
        }
        // 2) forced A 未被组吸收：无 R 在面 ⇒ 仍可整节点离场（检查点）；有 R 留下 ⇒ A 不动，
        //    其 selected R 走 R-only 空桩，配对不破。
        const rCalls = new Set();
        for (const a of atoms) {
            if (a.type === 'R' && a.toolCallIds[0] !== undefined)
                rCalls.add(a.toolCallIds[0]);
        }
        for (const seq of selected) {
            if (consumed.has(seq))
                continue;
            const atom = atomsBySeq.get(seq);
            if (atom?.type !== 'A')
                continue;
            const hasR = atom.toolCallIds.some(cid => rCalls.has(cid));
            if (hasR)
                continue;
            intervals.push({ seqs: [seq], chars: atom.text.length, atoms: [atom] });
            tombstones.push({ type: 'user', text: FACTOR_COMPACTED_MARKER });
            consumed.add(seq);
        }
        // 3) R-only（2.2.2 打包带走裁定，2026-11-26 存档加载失败案）：闭包之后走到这里的，
        //    只剩**整组无法闭包**的 selected R（sibling 带附件 / 组在焦点或 open 区 / A 与 R
        //    在 surface 上不连续）——正常形态已被上面的闭包整组带走。旧「空 tool/result 克隆」
        //    桩形态废止：宿主 v4 fold 要求非 append 的 tool/result 必须落在开放轮内，而压缩
        //    事务可发生在 step/end↔step/start 甚至 turn 间隙（1147 等 6 枚实锤）⇒ 该形态是
        //    存档不可加载的毒源。issuer 在世 ⇒ held 并计入真实缺口（下方 warn 判据），
        //    绝不再静默；孤儿 R（issuer 已离场，含本事务刚被组剪/forced-A 消费的 issuer）
        //    ⇒ 压缩检查点。issuerAlive 必须排除 consumed，否则"issuer 刚离场"的 R 会被
        //    当活体配对而漏剪。
        const issuerAlive = new Set();
        for (const a of atoms) {
            if (a.type === 'A' && !consumed.has(a.seq))
                for (const cid of a.toolCallIds)
                    issuerAlive.add(cid);
        }
        let halfSplitHeld = 0;
        let heldChars = 0;
        for (const seq of groupPlan.rOnly) {
            if (consumed.has(seq))
                continue;
            const atom = atomsBySeq.get(seq);
            const input = tagsBySeq.get(seq);
            if (atom === undefined || input === undefined || input.callId === undefined)
                continue;
            if (attachmentSeqs.has(seq)) {
                heldChars += input.tags.sizeChars;
                continue;
            } // 附件 R 不可文本召回：保留活体
            if (issuerAlive.has(input.callId)) {
                halfSplitHeld += 1;
                heldChars += input.tags.sizeChars;
                continue;
            }
            consumed.add(seq);
            intervals.push({ seqs: [seq], chars: input.tags.sizeChars, atoms: [atom] });
            tombstones.push({ type: 'user', text: FACTOR_COMPACTED_MARKER });
        }
        if (halfSplitHeld > 0) {
            this.host.log.info('[argp-factor] 半拆组保留 ' + halfSplitHeld
                + ' 枚 R（issuer 在世不剪单 R；打包带走裁定）');
        }
        if (intervals.length === 0) {
            // 缺口口径修正（2026-11-27）：planPrune 逐枚累计达标（retention-score.ts:217-229），
            // 被 held 的 R 其字符**已经**算进 releasedChars ⇒ shortfall 归零 ⇒ 旧版这里静默 return
            // null，一笔不释放也不告警（实测 seed23 round4/5 selR=13/held=13/res=null、chars 反涨）。
            // held/附件保留量是真实缺口，必须并入 warn 判据，"零释放"从此不可静默。
            const gap = Math.max(plan.shortfallChars, heldChars);
            if (gap > 0) {
                this.host.log.warn('[argp-factor] 降级链：可剪面释放不足，缺口 ' + gap
                    + ' chars（plan shortfall=' + plan.shortfallChars + '，半拆/附件保留=' + heldChars
                    + '；硬保护成员未入区，少剪并上报，不放宽判据）');
            }
            return null;
        }
        const result = pruneIntervals(this.host, session, intervals, intervals.length, false, tombstones, 'factor-prune');
        if (result !== null) {
            // 发射成功立即入账（词表零轮延迟）；组区间逐个 R 记账，A 不入账。逐条以真实
            // shadowed 复核——未被 shadow 的区间（事务预检剔除等）不得误记。
            const shadowedNow = scanShadowedSeqs(session);
            for (const iv of intervals) {
                for (const seq of iv.seqs) {
                    if (!shadowedNow.has(seq))
                        continue;
                    const atom = atomsBySeq.get(seq);
                    const input = tagsBySeq.get(seq);
                    if (atom?.type === 'R' && input !== undefined) {
                        // 审查 P1-4：账本键用 append 根 seq（克隆节点上可能带 tags；按 clone seq 记账
                        // 会让 recall 取到空克隆）。root 无 tags 时回退当前 input。
                        const roots = resolveRootSeqs(eventLog, seq);
                        const rootSeq = roots[0] ?? seq;
                        const rootInput = tagsBySeq.get(rootSeq) ?? input;
                        // preview 必须同行透传（ZT6）：漏传 = 在线账本无预览、重建有 ⇒ 词表漂移。
                        this.ledgerOf(session).addPruned({ rootSeq, turn: atom.turn, tags: rootInput.tags, preview: rootInput.preview });
                    }
                }
            }
            const released = intervals.reduce((n, iv) => n + iv.chars, 0);
            const shortfall = Math.max(0, targetReleaseChars - released);
            this.host.log.info('[argp-factor] 组剪 ' + groupPlan.groups.length + ' 组 / R-only '
                + (intervals.length - groupPlan.groups.length) + ' 区间；释放 ' + released + ' / 目标 '
                + targetReleaseChars + ' chars（夹剪检查点 ' + clipEmitted + ' 枚）'
                + '；sticky 活跃 ' + decision.stickyActive + '；焦点标签 ' + decision.focalSize);
            if (shortfall > 0) {
                this.host.log.warn('[argp-factor] 目标未达：缺口 ' + shortfall
                    + ' chars（可剪/硬保护面耗尽；少剪并上报，不放宽判据）');
            }
            // 桩游程随剪回收（2026-11-26 session-43df801e 审计，见 reclaimStubRuns）：放在
            // 主事务**之后**——本笔新落盘的桩与表面既有同文桩邻接成的新游程也能当笔收编。
            this.reclaimStubRuns(session);
        }
        return result;
    }
    /**
     * 表面桩游程随剪回收（2026-11-26 审计：桩 kind=compact-checkpoint ⇒ atomize 判 X，
     * 永不进 A+R 剪枝面；prose 三桶带按 own-kind 排除 ⇒ 双盲不可回收；§11.8 归并通道
     * 随图臂退役 ⇒ 跨事务累积泄漏 + 同文连排破坏角色交替）。
     * 事务内的相邻同文并条（prune-tx 归并 pass）已阻断新游程生成；本方法处理**跨事务
     * 累积与存量会话**：扫当前表面极大同文 checkpoint 桩游程（≥FACTOR_STUB_RUN_MIN），
     * 发一笔 tombstone-merge 事务每条并一。纪律：判据认 kind+逐字节同文，不认文案子串
     * （避开图臂 '[elided ' 文案漂移坑）；同文 ⇒ 归并零信息损失（交互桩文本含各自
     * keys，异文自然不并，指针语义保留）。**绝不独立发维护事务**——只在 compactIfNeeded
     * 已有事务落地（surface 已换代、换代税已交）后随剪执行；异常只记日志不影响主事务。
     */
    reclaimStubRuns(session) {
        try {
            const events = sessionEvents(session);
            const surface = [...session.surface.nodes];
            const stubTextAt = (seq) => {
                const ev = events[seq];
                if (ev?.type !== 'user/message')
                    return null;
                const src = ev.data?.source;
                if (src === undefined || !isCompactCheckpointSource(src))
                    return null;
                const text = proseTextOf(ev);
                return text !== null && text !== '' ? text : null;
            };
            const runs = [];
            let cur = [];
            let curText = null;
            const flush = () => {
                if (curText !== null && cur.length >= FACTOR_STUB_RUN_MIN)
                    runs.push({ seqs: cur, text: curText });
                cur = [];
                curText = null;
            };
            for (const seq of surface) {
                const t = stubTextAt(seq);
                if (t !== null && t === curText)
                    cur.push(seq);
                else {
                    flush();
                    if (t !== null) {
                        cur = [seq];
                        curText = t;
                    }
                }
            }
            flush();
            if (runs.length === 0)
                return;
            const intervals = runs.map(r => ({ seqs: r.seqs, chars: r.seqs.length * r.text.length, atoms: [] }));
            const tombstones = runs.map(r => ({ type: 'user', text: r.text }));
            const res = pruneIntervals(this.host, session, intervals, intervals.length, false, tombstones, 'tombstone-merge');
            if (res !== null) {
                this.host.log.info('[argp-factor] 桩游程随剪归并 ' + runs.length + ' 段 / '
                    + runs.reduce((n, r) => n + r.seqs.length, 0) + ' 桩 → ' + runs.length + ' 占位');
            }
        }
        catch (e) {
            this.host.log.warn('[argp-factor] 桩游程回收异常（本轮跳过，不影响主事务）：'
                + (e instanceof Error ? e.message : String(e)));
        }
    }
    /**
     * §B-2a 结构去重驱逐（0-LLM）：宿主**每次压缩后**把再注入三件套
     * （agent-instructions/runtime-context/skill-catalog）重新注入一份——档案实锤
     * 2026-11-25（prose 域 catalog ×4 = 首注 + 3 次压缩）。旧副本与新副本内容同源，
     * 驱逐无需摘要、无需入账（U 无召回标签）。每 kind 保留 surface 最新一枚，旧者
     * 整节点离场（中性检查点墓碑）。时机：重复只在**下一笔事务前**存在（重注入发生
     * 在压缩事务之后），本方法在接管事务的开头回收。
     */
    dedupeReinjected(session) {
        const atoms = this.host.atomize(session);
        const eventLog = sessionEvents(session);
        const byKind = new Map();
        for (const a of atoms) {
            if (a.type !== 'U')
                continue;
            const ev = eventLog[a.seq];
            const src = (ev?.data?.['source'] ?? ev?.data?.['message']?.source);
            if (src === undefined)
                continue;
            const hit = (src.kind !== undefined && HOST_REINJECTED_KINDS.includes(src.kind))
                || (src.form !== undefined && HOST_REINJECTED_FORMS.includes(src.form));
            if (!hit)
                continue;
            const key = src.kind ?? src.form ?? '?';
            const list = byKind.get(key) ?? [];
            list.push(a);
            byKind.set(key, list);
        }
        const intervals = [];
        const tombstones = [];
        for (const list of byKind.values()) {
            // atomize 按 surface 序遍历：末位=最新注入，保留；其余为过期重复。
            for (const stale of list.slice(0, -1)) {
                intervals.push({ seqs: [stale.seq], chars: stale.text.length, atoms: [stale] });
                tombstones.push({ type: 'user', text: FACTOR_COMPACTED_MARKER });
            }
        }
        if (intervals.length === 0)
            return null;
        const result = pruneIntervals(this.host, session, intervals, intervals.length, false, tombstones, 'injection-dedupe');
        if (result !== null) {
            this.host.log.info('[argp-factor-dedup] 驱逐过期再注入副本 ' + intervals.length + ' 枚 / '
                + intervals.reduce((n, iv) => n + iv.chars, 0) + ' chars');
        }
        return result;
    }
    /**
     * 组剪检查点文本（2.2.2 根修后 C10 夹剪层的唯一合法落点）：把一个整组区间压缩成
     * **单条 user/message 检查点**（user replace 不受轮/步约束，压缩事务可安全落在轮间隙），
     * 文本三态由组内成员决定：
     *  - 夹剪（clip 开 ∧ 组内有 clipOrder 成员 ∧ 原始 R 文本可读）⇒ 头尾预览文本；
     *  - 交互组 ⇒ 专段带 tool: 即时指针（P7 带 + ZT7/ZT10）；
     *  - 其余 ⇒ 零指针中性标记。
     *
     * 旧夹剪臂直接 replace 原 R 节点本体（tool/result replace）——宿主 v4 fold 的
     * `requireTurn()` 让它在轮间隙无合法表达（session-43df801e 存档加载失败案）；
     * 根修把「信息保留」从节点形态挪到检查点文本，且组剪决策面与 clip 关闭时相同，
     * A/B 变量只剩「检查点是否携带头尾预览」。多 R 组取最大一枚的预览（预算有界）。
     */
    groupCheckpointText(session, group, tagsBySeq, clipSet) {
        if (clipSet !== null && clipSet.size > 0) {
            let best = null;
            for (const seq of group.rSeqs) {
                const input = tagsBySeq.get(seq);
                if (input === undefined || !clipSet.has(seq))
                    continue;
                const raw = rawEventText(session, seq);
                if (raw === null)
                    continue;
                const clipped = clipText({ tool: input.tool, key: this.stubKey(input), seq, text: raw.text });
                if (clipped === null)
                    continue;
                const size = input.tags.sizeChars;
                if (best === null || size > best.size)
                    best = { clipped, size };
            }
            if (best !== null)
                return best.clipped;
        }
        const interactiveTools = [];
        for (const atom of group.atoms) {
            if (atom.type !== 'R')
                continue;
            const tool = tagsBySeq.get(atom.seq)?.tool ?? '';
            if (INTERACTIVE_PREVIEW_TOOLS.has(tool) && !interactiveTools.includes(tool))
                interactiveTools.push(tool);
        }
        return interactiveTools.length > 0 ? interactiveCheckpointText(interactiveTools) : FACTOR_COMPACTED_MARKER;
    }
    /** 实体标签选择序：document → command → errorcode → scope → **tool**（夹剪检查点
     *  首行共用）。scope 也是词表键（factor-ledger.indexKeys）；漏掉会让只有目录的 grep R
     *  被标 "无实体标签"，而模型其实可以 recall_history(scope:…)。
     *  tool 尾位（2026-11-16 design-tool-facet §1）：非空门槛同 indexKeys。 */
    stubKey(input) {
        return input.tags.files[0] !== undefined ? 'document:' + input.tags.files[0]
            : input.tags.commands[0]
                ?? (input.tags.errorcodes[0] !== undefined ? 'errorcode:' + input.tags.errorcodes[0]
                    : input.tags.scopes[0] !== undefined ? 'scope:' + input.tags.scopes[0]
                        : input.tool !== '' ? 'tool:' + input.tool : undefined);
    }
    /** 词表段（渲染出口；注入通路见 refreshVocabularyNote）。 */
    vocabulary(session) {
        this.observe(session);
        return renderVocabulary({
            ledger: this.ledgerOf(session),
            topNPerFacet: this.cfg.vocabTopN(),
            budgetChars: this.cfg.vocabBudgetChars,
            isInteractive: isInteractiveToolKey,
        });
    }
    /**
     * 系统级动态目录快照（2.2.3；systemPrompt.context 的单一数据源）。
     *
     * 与 `refreshVocabularyNote` 的区别：note 是**事务流**里的历史通知，可能因
     * steer/替换/吞并而不可见；快照是**宿主每次装配请求时**读取的模型侧上下文，
     * 只在压缩事务成功收尾时更新。调用方必须把返回对象的 `text` 冻结到会话状态，
     * 不得让 provider 每次请求重新从 live ledger 渲染——否则“目录变化”会脱离
     * “压缩事务”这个唯一的缓存断点时机。
     */
    vocabularySnapshot(session) {
        const { text } = this.vocabulary(session);
        return {
            text: text === '' ? '' : VOCAB_NOTE_GUIDE + '\n' + text,
            epoch: this.ledgerOf(session).epoch,
        };
    }
    /**
     * 词表 note 的单一可见副本维护（§1.4 注入位定稿：**不进 system 前缀**——每轮变动
     * = 跨轮前缀缓存全断，`6d252cf` 教训；note 常驻剪枝区带、内容随 epoch 重写）。
     * 2.2.3 起有 `systemPrompt.context` 时由 `ArgpEngine` 停用本路径（context 快照
     * 承担目录）；本方法仅作为无该服务时的降级通道保留。
     *
     * 通路 = pre-step 的 steer/replace（auto-continue 同款 notice 先例）：
     *  - 首注：steer 一条 notice（source.kind='argp'，宿主归 X：进请求、不参剪、UI 按
     *    notice 渲染）；指针以标记回溯为准——steer throw 或未落盘都**不记指针**
     *    （记了 resume 找不回，等于坏指针 ⇒ 下轮自然重试）。
     *  - 更新：**单节点 replace 原地重写**（墓碑归并同形态；replace 副本 model-only，
     *    UI 留首份 notice——词表本就常驻更新，旧副本进 UI 无害）。绝不再 steer 第二条
     *    （X 在 factor 臂永不参剪，多副本 = 不可剪地板累积）。
     *  - resume：进程重启后指针丢失，按 VOCAB_NOTE_MARKER 从日志尾回溯找回最新副本。
     */
    async refreshVocabularyNote(session, steer) {
        const { text } = this.vocabulary(session);
        if (text === '')
            return;
        const st = this.stateOf(session);
        const ledger = this.ledgerOf(session);
        // 审查 P0-6/P1-9：note 若被散文 span 吞掉/被替换，旧指针指向 shadowed seq；直接
        // replace 会 throw（refreshFactorNoteSafe 吞掉后永久 stale）。先做 surface 成员检查，
        // 失效则清指针，走"steer 新 note"路径（而不是去日志尾找回旧副本）。
        if (st.vocabNoteSeq !== null && !session.surface.nodes.includes(st.vocabNoteSeq)) {
            st.vocabNoteSeq = null;
            st.vocabEpoch = -1;
        }
        if (st.vocabNoteSeq === null) {
            const found = lastVocabNoteSeq(sessionEvents(session));
            if (found !== null && session.surface.nodes.includes(found)) {
                st.vocabNoteSeq = found;
                // resume 找回指针 ≠ note 内容是最新：与当前渲染逐字比对，一致才认账本版本；
                // 否则标脏（-1）让本次刷新重写——盲目认 epoch 会把崩溃前漏刷的剪枝当成已渲染。
                st.vocabEpoch = eventText(session, found) === vocabNoteText(text) ? ledger.epoch : -1;
            }
        }
        if (st.vocabNoteSeq === null) {
            await steer(vocabNoteText(text));
            // steer 落盘形态由宿主决定（auto-continue 先例：steer 即 append）——指针以
            // **标记回溯**为准；steer 未落盘（异常宿主）则不记指针，下轮自然重试。
            const seq = lastVocabNoteSeq(sessionEvents(session));
            if (seq === null) {
                this.host.log.warn('[argp-factor] 词表 note steer 后未在日志找回（宿主 steer 未落盘？）——本轮跳过，下轮重试');
                return;
            }
            st.vocabNoteSeq = seq;
            st.vocabEpoch = ledger.epoch;
            return;
        }
        if (st.vocabEpoch === ledger.epoch)
            return;
        const note = vocabNoteText(text);
        // 裸 replace（无相邻 compaction/prune 配对）合法的前提 = 此刻无 armed claim：
        // token-meter 投影只在 claim 悬着且范围不符时 throw（"no adjacent shadow price"），
        // 无 claim 的单节点 replace 自折叠（U-info 副本同形态生产先例）。
        // 调用点在 pre-step——上一笔剪枝事务以 compaction/end 收口、claim 已 drop。
        await session.append('user/message', createUserMessage({
            content: [{ type: 'text', text: note }],
            source: { kind: 'argp', form: 'notice', summary: 'factor vocabulary (pruned labels; recall_history keys)' },
        }), {
            surfaceOp: { op: 'replace', startSeq: st.vocabNoteSeq, endSeq: st.vocabNoteSeq },
            sourceEventSeqs: [st.vocabNoteSeq],
        });
        // 落盘成功才认版本：append 抛错时 epoch 不变，下个压缩时机自然重试（否则永久 stale）。
        st.vocabEpoch = ledger.epoch;
    }
}
/** 日志尾向前找词表 note 的最新副本（replace 链的尾代 seq 最大，首个命中即最新）。 */
function lastVocabNoteSeq(events) {
    for (let i = events.length - 1; i >= 0; i -= 1) {
        const e = events[i];
        if (e === undefined || e.type !== 'user/message')
            continue;
        // user/message 的 content 挂 data.content（rawEventText 同口径）；双形态兼容读。
        const d = (e.data ?? {});
        const blocks = Array.isArray(d.content) ? d.content : Array.isArray(d.message?.content) ? d.message.content : null;
        const first = blocks === null ? undefined : blocks[0];
        if (first !== undefined && first.type === 'text' && typeof first.text === 'string' && first.text.startsWith(VOCAB_NOTE_MARKER))
            return e.seq;
    }
    return null;
}
