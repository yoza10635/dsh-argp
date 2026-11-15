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
 * 装配侧不变量（argp-graph-engine 构造器执行）：
 *  - engine='factor' ⇒ compressor/declarer/zoom 三管线不挂、cites 通道硬关；
 *  - 本类只剪 R（content-only 最小桩，宿主 assertToolResultRewrite 形态）；
 *    A 永不入剪枝区间（恒留待摘要），协议组互锁因此天然满足。
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { detectOpenTurn, eventText, rawEventText, resolveRootSeqs, scanShadowedSeqs, sessionEvents } from "../log-access.js";
import { DEFAULT_FOCAL_TURNS, DEFAULT_VOCAB_TOP_N, FACTOR_COMPACTED_MARKER, FOCAL_DOC_HARD_WIDTH_RATIO, FOCUS_GROUP_CAP, FOCUS_TURN_SHARE_THRESHOLD, VOCAB_NOTE_MARKER } from "../constants.js";
import { pruneIntervals } from "../prune-tx.js";
import { focalCommandLabels, focalLabels, hasAttachmentBlocks, sessionCwdFromEvents, supersededMarks, STUB_PREFIX, tagRsFromLog } from "./factor-atoms.js";
import { RECALL_TOOL_NAMES } from "./recall-labels.js";
import { CLIP_MARK, clipFamilyOf, clipReserveChars, clipText } from "./clip-shape.js";
import { FactorLedger, indexKeys, renderVocabulary } from "./factor-ledger.js";
import { computeScore, planPrune } from "./retention-score.js";
import { factorAssistantTombstone } from '../tombstone-text.js';
import { READ_TOOLS } from "./tag-extract.js";
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
 * §9.37 出口闸（缺省**关**；用户裁定 2026-11-15：46 轮实测对照臂形态即缺省形态——
 * 贴墙由 400 兜底网 + §9.36 闸二浓缩接管，上下文贴线优先于预检防线的提前回落）。
 * env ARGP_FACTOR_EGRESS=1 = 开（评测/对照/防 400 死流需要时显式开；缺省与非法值=关，
 * 档位语义同 resolveClipEnabled）。生效=构造期快照（focalTiered 同款纪律，须重挂引擎）。
 */
export function resolveEgressEnabled(env = process.env) {
    return env['ARGP_FACTOR_EGRESS'] === '1';
}
/** 词表 note 的行首标记（单一事实源在 constants.ts；此处保留 re-export 供既有测试/调用方）。 */
export { VOCAB_NOTE_MARKER };
/**
 * 词表 note 的模型侧引导（2.0.0 起替代 system 前缀常驻契约）：
 * 只在**首次压缩事务后**随词表 note 出现——压缩前没有被剪内容，无需指引；
 * note 本就随 epoch 重写，不额外制造前缀缓存断点。
 */
const VOCAB_NOTE_GUIDE = 'Pruned atoms remain in the append-only log. If an answer depends on content no longer visible, recall it with recall_history using the labels below — never reconstruct from memory. If no document label matches, shell-read content may carry command:<family> labels, and directory-level scope:<dir> addresses may also exist — list_labels(category:\'command\' or \'scope\') enumerates them (not listed below). Replies must be self-contained: restate facts, do not point at earlier context.';
const vocabNoteText = (labels) => VOCAB_NOTE_MARKER + '\n' + VOCAB_NOTE_GUIDE + '\n' + labels;
/**
 * 焦点尾窗规划（2026-11-13 用户裁定）：**只在最新轮自身过大时**把焦点从整轮
 * 降级为该轮最新的至多 `cap` 个 A+R 协议组。正常轮（占比 <阈值或组数 ≤cap）
 * 原样返回 escalated=false，硬保护/组剪/排序全部走现行 turn 判据（零行为变化）。
 *
 * 判据用 A/R 字节占比作代理（本轮真实 token 密度未知；用户原话"最后一轮上下文
 * 占比超过已有的一半"）。组按 A 的 surface 位置排序，取最新 cap 组；焦点集含
 * A 与其全部 live R（闭包，组不拆分）。
 */
export function planFocusTail(atoms, surfaceSeqs, opts) {
    const empty = {
        escalated: false, focusSeqs: new Set(), groupCount: 0, latestTurnGroupCount: 0, latestTurnShare: 0,
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
    return {
        escalated, focusSeqs, groupCount: groups.length, latestTurnGroupCount, latestTurnShare,
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
        if (opts.focusSeqs !== null) {
            // 焦点尾窗降级：只保护焦点组；焦点外的 open 轮组也可整组离场（尾窗之外=旧工作集）。
            const inFocus = opts.focusSeqs.has(a.seq) || defined.some(r => opts.focusSeqs.has(r.seq));
            if (inFocus && !forced)
                continue;
        }
        else {
            if (opts.openTurn !== null && a.turn >= opts.openTurn)
                continue;
            if (!forced && a.turn >= opts.protectFromTurn)
                continue;
        }
        const missing = rs.some(list => list.length === 0);
        if (missing && !forced)
            continue; // 缺失 R 且非 forced：交给原 forced 链
        if (!defined.every(r => selected.has(r.seq) || isStub(r)))
            continue; // 有 live R ⇒ A 保留
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
        if (opts.focusSeqs === null) {
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
        // 裸值/getter 双形归一：装配面传 getter（2.0.0 起 ArgpGraphEngine 传固化常量
        // getter）；测试传裸值 = 固定值。设置页旋钮已退役，不再有 volatile 活读路径。
        const asGetter = (v, d) => typeof v === 'function' ? v : () => v ?? d;
        this.cfg = {
            focalTurns: asGetter(config.focalTurns, DEFAULT_FOCAL_TURNS),
            vocabTopN: asGetter(config.vocabTopN, DEFAULT_VOCAB_TOP_N),
            stickyWindowTurns: config.stickyWindowTurns ?? 8,
            vocabBudgetChars: config.vocabBudgetChars ?? 4000,
            focalTiered: config.focalTiered ?? 'flat',
            clipEnabled: config.clipEnabled === true,
        };
    }
    /** 会话账本（懒建；见 ledgers 字段注释）。public：召回工具按执行会话取桶。 */
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
            if (shadowed.has(seq))
                ledger.addPruned({ rootSeq: seq, turn: input.turn, tags: input.tags });
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
    decide(session, targetReleaseChars) {
        const { atoms, tagsBySeq, cwd } = this.observe(session);
        const latestTurn = atoms.reduce((m, a) => Math.max(m, a.turn), 0);
        const openTurn = detectOpenTurn(session);
        const shadowed = scanShadowedSeqs(session);
        const focalTurns = this.cfg.focalTurns();
        const protectFromTurn = focalTurns > 0 ? latestTurn - focalTurns + 1 : Number.POSITIVE_INFINITY;
        // 焦点尾窗降级（用户 2026-11-13）：只在最新轮自身占比 ≥50% 且组数 >10 时触发；
        // 否则 focusEscalated=false，下面所有焦点判据走现行 turn 路径（零行为变化）。
        const surfaceSeqs = [...session.surface.nodes];
        const focusTail = planFocusTail(atoms, surfaceSeqs, {
            protectFromTurn, cap: FOCUS_GROUP_CAP, latestTurn, shareThreshold: FOCUS_TURN_SHARE_THRESHOLD,
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
            // 全部硬保护位失效（无条件进剪序）；排序照常走 freshness（刚引用=新鲜，迟剪）。
            // 未闭合轮的 R：本轮协议现场（模型可能尚未消化），硬保护不进排序
            const inOpenTurn = openTurn !== null && a.turn >= openTurn;
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
                isRecall: RECALL_TOOL_NAMES.includes(input.tool),
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
        for (const f of facts) {
            // 焦点尾窗降级时，焦点外 R 的 turn/label 焦点保护全部失效（组剪已按 focusSeqs
            // 保护最新 10 组；旧的同文档读不再因 label 命中被连带硬保）。
            const focusGate = !focusEscalated || f.inFocus;
            const focalDocStrong = tiered && focusGate && f.focalDocHit.length > 0
                && (!fuseActive || f.focalDocHit.some(lbl => docLatest.get(lbl) === f.seq));
            if (focalDocStrong)
                focalDocHardChars += f.input.tags.sizeChars;
            // 三值焦点带（§2.5 v1.1）：strong=文档面命中（hard 与否都占带位——熔断退 hard 时
            // 排序位仍沉底）；medium=白名单命令面（★永不 hard）；其余 none。flat 走布尔回退。
            const focalBand = tiered ? (f.focalDocHit.length > 0 ? 2 : f.mediumHit ? 1 : 0) : undefined;
            const effectiveFocal = focusEscalated ? f.inFocus : f.focalMatch;
            const effectiveBand = tiered
                ? (focusEscalated ? (f.inFocus ? focalBand : 0) : focalBand)
                : (effectiveFocal ? 1 : 0);
            if (tiered && effectiveBand === 1)
                mediumBandChars += f.input.tags.sizeChars;
            focalBandBySeq.set(f.seq, effectiveBand);
            entries.push({
                rootSeq: f.seq,
                score: computeScore({
                    rootSeq: f.seq, turn: f.turn, currentTurn: latestTurn, tags: f.input.tags,
                    // P6-③ 裁定 2：召回对全部硬保护位失效（无条件进剪序；可再生=再召回一次）。
                    hard: f.isRecall ? {} : {
                        // 焦点尾窗降级时，open 轮只保焦点组；焦点外旧组可离场（尾窗之外=旧工作集）。
                        failureNoFollowR: f.inOpenTurn && (!focusEscalated || f.inFocus),
                        // tiered：sticky 归因一枚化（只保 exemplar）；flat：逐枚硬保现行为。
                        stickyMember: tiered ? f.stickyMember && stickyExemplarSeqs.has(f.seq) : f.stickyMember,
                        // 附件保护：空文本（纯附件 R）或文本+附件混合——文本桩会把 image/file 一起丢。
                        attachment: f.input.resultText.length === 0 || f.input.hasAttachment === true,
                        // flat：现行为；tiered：焦点 hard 只认 document facet（v1.2 裸码降出），
                        // 且经 focalDocStrong 连可再生枚一并保住。
                        focalNonRegenerable: !tiered && focusGate && f.focalMatch && f.regenerable !== true,
                        focalDocStrong,
                        errSignatureHard: tiered && errSigHardSeqs.has(f.seq),
                    },
                    regenerable: f.regenerable,
                    // v1.4 superseded 焦点豁免：命中焦点的枚不按"被新版覆盖"插队先剪
                    // （spike54 冲突面 90 枚/211KB；spike55 定案：非焦点释放阀保留）。
                    superseded: tiered && effectiveFocal ? undefined : superseded.get(f.seq) === true ? true : undefined,
                    focal: effectiveFocal,
                    focalBand: tiered ? effectiveBand : undefined,
                }),
            });
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
        });
        return {
            plan, candidates, tagsBySeq, latestTurn,
            focalSize: focal.size, stickyActive: sticky.length, shortfallChars: plan.shortfallChars,
            focalTiered: this.cfg.focalTiered, clipEnabled: clipOn, focalDocHardChars, focalDocFuse: fuseActive,
            errSigHardCount: errSigHardSeqs.size,
            focalMediumSize: focalMedium.size, mediumBandChars, focalBandBySeq,
            interruptedForcedSeqs: forcedFirst,
            focusEscalated, focusSeqs: focusTail.focusSeqs,
            focusGroupCount: focusTail.groupCount, latestTurnShare: focusTail.latestTurnShare,
        };
    }
    /**
     * 压力剪一笔：决策 → 协议组（A+R 整组 + K pack）/ R-only 空桩 → prune-tx 成对发射。
     * 目标不达不放宽；组剪收益按区间实际 chars 复核。
     */
    compactIfNeeded(session, targetReleaseChars) {
        if (targetReleaseChars <= 0)
            return null;
        const decision = this.decide(session, targetReleaseChars);
        const { plan, tagsBySeq } = decision;
        const atoms = this.host.atomize(session);
        const atomsBySeq = new Map();
        for (const a of atoms)
            atomsBySeq.set(a.seq, a);
        const clipOn = this.cfg.clipEnabled === true;
        // C10 夹剪臂 = 显式对照世界（ARGP_FACTOR_CLIP=1）：保留旧 R-only 夹剪/桩语义，
        // 不启用 A+R 组剪（组剪是 2026-11-13 新默认；两臂互斥，便于同域 A/B）。
        if (clipOn)
            return this.compactClipArm(session, plan, tagsBySeq, atomsBySeq);
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
        });
        const intervals = [];
        const tombstones = [];
        const consumed = new Set();
        // 1) 协议组（A+R + 旧 A+桩 K pack）：整组离场，压缩检查点占位（中性标记，模型可见）。
        for (const g of groupPlan.groups) {
            intervals.push({ seqs: g.seqs, chars: g.chars, atoms: g.atoms });
            tombstones.push({ type: 'user', text: FACTOR_COMPACTED_MARKER });
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
        // 3) R-only：A 保留 ⇒ 空 tool/result 克隆（无指针）；孤儿 R（issuer 已离场，
        //    含本事务刚被组剪/forced-A 消费的 issuer）⇒ 压缩检查点。issuerAlive 必须
        //    排除 consumed，否则会把"issuer 刚离场"的 R 落成 tool 桩 = 孤儿 tool result。
        const issuerAlive = new Set();
        for (const a of atoms) {
            if (a.type === 'A' && !consumed.has(a.seq))
                for (const cid of a.toolCallIds)
                    issuerAlive.add(cid);
        }
        for (const seq of groupPlan.rOnly) {
            if (consumed.has(seq))
                continue;
            const atom = atomsBySeq.get(seq);
            const input = tagsBySeq.get(seq);
            if (atom === undefined || input === undefined || input.callId === undefined)
                continue;
            if (attachmentSeqs.has(seq))
                continue; // 附件 R 不可文本召回：保留活体，不落空桩
            consumed.add(seq);
            intervals.push({ seqs: [seq], chars: input.tags.sizeChars, atoms: [atom] });
            if (!issuerAlive.has(input.callId)) {
                tombstones.push({ type: 'user', text: FACTOR_COMPACTED_MARKER });
                continue;
            }
            // 新默认（clip off）：空 tool/result 克隆——无指针文本，配对保 callId。
            tombstones.push({ type: 'tool', seq, callId: input.callId, text: '' });
        }
        if (intervals.length === 0) {
            if (plan.shortfallChars > 0) {
                this.host.log.warn('[argp-factor] 降级链：可剪面释放不足，缺口 ' + plan.shortfallChars
                    + ' chars（硬保护成员未入区；少剪并上报，不放宽判据）');
            }
            return null;
        }
        const result = pruneIntervals(this.host, session, intervals, 0, intervals.length, false, tombstones, 'factor-prune');
        if (result !== null) {
            // 发射成功立即入账（词表零轮延迟）；组区间逐个 R 记账，A 不入账。逐条以真实
            // shadowed 复核——prune-tx 预检（canCloneTool）剔除的区间未落 shadowed，不得误记。
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
                        this.ledgerOf(session).addPruned({ rootSeq, turn: atom.turn, tags: rootInput.tags });
                    }
                }
            }
            const released = intervals.reduce((n, iv) => n + iv.chars, 0);
            const shortfall = Math.max(0, targetReleaseChars - released);
            this.host.log.info('[argp-factor] 组剪 ' + groupPlan.groups.length + ' 组 / R-only '
                + (intervals.length - groupPlan.groups.length) + ' 区间；释放 ' + released + ' / 目标 '
                + targetReleaseChars + ' chars（夹剪臂未启用）'
                + '；sticky 活跃 ' + decision.stickyActive + '；焦点标签 ' + decision.focalSize);
            if (shortfall > 0) {
                this.host.log.warn('[argp-factor] 目标未达：缺口 ' + shortfall
                    + ' chars（可剪/硬保护面耗尽；少剪并上报，不放宽判据）');
            }
        }
        return result;
    }
    /**
     * C10 夹剪臂（ARGP_FACTOR_CLIP=1）的旧语义：R-only 夹剪/最小桩 + A 仅 forced 时 user 墓碑。
     * 与 2026-11-13 的 A+R 组剪互斥（组剪是新默认；夹剪是显式对照世界，A/B 需要字节可复现）。
     */
    compactClipArm(session, plan, tagsBySeq, atomsBySeq) {
        const callsOfEvictedA = new Set();
        for (const seq of plan.pruneOrder) {
            const atom = atomsBySeq.get(seq);
            if (atom?.type === 'A')
                for (const cid of atom.toolCallIds)
                    callsOfEvictedA.add(cid);
        }
        const intervals = [];
        const tombstones = [];
        const clipSet = new Set(plan.clipOrder);
        const seen = new Set();
        let clipEmitted = 0;
        for (const seq of plan.pruneOrder) {
            if (seen.has(seq))
                continue;
            const atom = atomsBySeq.get(seq);
            if (atom === undefined)
                continue;
            if (atom.type === 'A') {
                seen.add(seq);
                intervals.push({ seqs: [seq], chars: atom.text.length, atoms: [atom] });
                tombstones.push({ type: 'user', text: factorAssistantTombstone(seq) });
                continue;
            }
            const input = tagsBySeq.get(seq);
            if (input === undefined || input.callId === undefined)
                continue;
            seen.add(seq);
            intervals.push({ seqs: [seq], chars: input.tags.sizeChars, atoms: [atom] });
            if (callsOfEvictedA.has(input.callId)) {
                tombstones.push({ type: 'user', text: factorAssistantTombstone(seq) });
            }
            else {
                const text = this.replacementText(session, seq, input, clipSet.has(seq));
                if (text.startsWith(CLIP_MARK))
                    clipEmitted += 1;
                tombstones.push({ type: 'tool', seq, callId: input.callId, text });
            }
        }
        if (intervals.length === 0)
            return null;
        const result = pruneIntervals(this.host, session, intervals, 0, intervals.length, false, tombstones, 'factor-prune');
        if (result !== null) {
            const shadowedNow = scanShadowedSeqs(session);
            for (const iv of intervals) {
                const seq = iv.seqs[0];
                if (!shadowedNow.has(seq))
                    continue;
                const atom = atomsBySeq.get(seq);
                const input = tagsBySeq.get(seq);
                if (atom !== undefined && input !== undefined) {
                    this.ledgerOf(session).addPruned({ rootSeq: seq, turn: atom.turn, tags: input.tags });
                }
            }
            this.host.log.info('[argp-factor] 夹剪臂：剪 ' + intervals.length + ' R / ' + plan.releasedChars
                + ' chars（夹剪 ' + clipEmitted + '）；sticky 活跃 ' + this.ledgerOf(session).stickyActive().length);
            if (plan.shortfallChars > 0) {
                this.host.log.warn('[argp-factor] 夹剪臂目标未达：缺口 ' + plan.shortfallChars
                    + ' chars（硬保护成员未入区；少剪并上报，不放宽判据）');
            }
        }
        return result;
    }
    /**
     * 三态替换文本（C10）：归位 ∈ clipOrder 的成员走夹剪模板（原文经 rawEventText
     * 取回——**只读 append-only 日志**，不改日志本体）；模板拒绝（小文本）或原文
     * 缺失 ⇒ 回落最小桩。clip 关闭时逐字节等于现行为（stubText）。
     */
    replacementText(session, seq, input, clipOn) {
        if (clipOn) {
            const raw = rawEventText(session, seq);
            if (raw !== null) {
                const clipped = clipText({ tool: input.tool, key: this.stubKey(input), seq, text: raw.text });
                if (clipped !== null)
                    return clipped;
            }
        }
        return this.stubText(input);
    }
    /** 最小桩（§1.2 ~30 字符物理下限；禁引退役工具名）。前缀 STUB_PREFIX 是
     *  tagRsFromLog 的桩排除判据（夹剪文本同带此前缀，同受排除）——单点引用，改文案不得动前缀。 */
    stubText(input) {
        const key = this.stubKey(input);
        const head = STUB_PREFIX + ' ' + (input.tool !== '' ? input.tool : 'tool');
        return key === undefined
            ? head + '（无实体标签，原文仍在日志）'
            : head + ' → ' + key + '（需要原文时 recall_history(' + key + ')）';
    }
    /** 实体标签选择序：document → command → errorcode → scope（stubText 与 clip 首行共用）。
     *  scope 也是词表键（factor-ledger.indexKeys）；漏掉会让只有目录的 grep R 被标
     *  "无实体标签"，而模型其实可以 recall_history(scope:…)。 */
    stubKey(input) {
        return input.tags.files[0] !== undefined ? 'document:' + input.tags.files[0]
            : input.tags.commands[0]
                ?? (input.tags.errorcodes[0] !== undefined ? 'errorcode:' + input.tags.errorcodes[0]
                    : (input.tags.scopes[0] !== undefined ? 'scope:' + input.tags.scopes[0] : undefined));
    }
    /** 词表段（渲染出口；注入通路见 refreshVocabularyNote）。 */
    vocabulary(session) {
        this.observe(session);
        return renderVocabulary({
            ledger: this.ledgerOf(session),
            topNPerFacet: this.cfg.vocabTopN(),
            budgetChars: this.cfg.vocabBudgetChars,
        });
    }
    /**
     * 词表 note 的单一可见副本维护（§1.4 注入位定稿：**不进 system 前缀**——每轮变动
     * = 跨轮前缀缓存全断，`6d252cf` 教训；note 常驻剪枝区带、内容随 epoch 重写）。
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
        // 无 claim 的单节点 replace 自折叠（cites-strip / U-info 副本同形态生产先例）。
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
