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
import { detectOpenTurn, rawEventText, resolveRootSeqs, scanShadowedSeqs, sessionEvents } from "../log-access.js";
import { FOCAL_DOC_HARD_WIDTH_RATIO } from "../constants.js";
import { pruneIntervals } from "../prune-tx.js";
import { focalCommandLabels, focalLabels, sessionCwdFromEvents, supersededMarks, STUB_PREFIX, tagRsFromLog } from "./factor-atoms.js";
import { RECALL_TOOL_NAMES } from "./recall-labels.js";
import { CLIP_MARK, clipFamilyOf, clipReserveChars, clipText } from "./clip-shape.js";
import { FactorLedger, indexKeys, renderVocabulary } from "./factor-ledger.js";
import { computeScore, planPrune } from "./retention-score.js";
import { factorAssistantTombstone } from '../tombstone-text.js';
import { READ_TOOLS } from "./tag-extract.js";
/**
 * focalTiered 的 env 逃生口（T-3 两臂实跑唯一触达通道）：tiered 是策略档，
 * 禁入 static Config/设置卡（P5-b 裁定，CR5/CR6/preset 键锁不变），生产装配路径
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
 * C10 夹剪层评测逃生口（focalTiered 同款纪律：禁入 static Config/设置卡，
 * CR5/CR6/preset 键锁不变，env 是唯一通道）：缺省关=shadow 二态（R1 行为字节
 * 不变）；env 置 1 开启三态（归位见 planPrune.clipOrder，剪形见 clip-shape.ts）。
 * 生效=构造快照（层切换=策略文档换版，须重挂引擎）。非法值 ⇒ 关（缺省安全）。
 */
export function resolveClipEnabled(env = process.env) {
    return env['ARGP_FACTOR_CLIP'] === '1';
}
/**
 * §9.37 出口闸（缺省**开**；用户裁定 2026-11-13："什么设计都无法接受反复重试再全量
 * 重灌的成本"——400 撞墙→剪→重灌链根除：必然超窗的请求根本不得发出）。
 * env ARGP_FACTOR_EGRESS=0 = 关（仅供修前/修后对照臂复现贴墙世界；缺省与非法值=开，
 * 安全方向）。生效=构造期快照（focalTiered 同款纪律，须重挂引擎）。
 */
export function resolveEgressEnabled(env = process.env) {
    return env['ARGP_FACTOR_EGRESS'] !== '0';
}
/** 词表 note 的行首标记：resume 找回 note 指针的判据（改文案不得动标记）。 */
export const VOCAB_NOTE_MARKER = '[argp-factor 词表]';
export class FactorEngine {
    ledger = new FactorLedger();
    states = new WeakMap();
    host;
    cfg;
    constructor(host, config = {}) {
        this.host = host;
        // 裸值/getter 双形归一（同 PruneTxHost 方法引用惯例）：引擎侧传 getter = 活读
        // volatile 旋钮（P2-4 设置卡，宿主实测写非 volatile 键会被拒 ⇒ 可写键必须 getter
        // 化）；测试传裸值 = 固定值。
        const asGetter = (v, d) => typeof v === 'function' ? v : () => v ?? d;
        this.cfg = {
            focalTurns: asGetter(config.focalTurns, 1),
            vocabTopN: asGetter(config.vocabTopN, 10),
            stickyWindowTurns: config.stickyWindowTurns ?? 8,
            vocabBudgetChars: config.vocabBudgetChars ?? 4000,
            focalTiered: config.focalTiered ?? 'flat',
            clipEnabled: config.clipEnabled === true,
        };
    }
    stateOf(session) {
        let st = this.states.get(session);
        if (st === undefined) {
            st = { observedUpToSeq: -1, snapshots: new Map(), vocabNoteSeq: null, vocabEpoch: -1 };
            this.states.set(session, st);
        }
        return st;
    }
    /**
     * 观察路（sticky 通道 + 被剪账本 + 在线文件快照）。幂等：ledger rootSeq 去重。
     */
    observe(session) {
        const events = sessionEvents(session);
        const atoms = this.host.atomize(session);
        const cwd = sessionCwdFromEvents(events);
        const st = this.stateOf(session);
        const first = st.observedUpToSeq === -1;
        // 日志根事件驱动（resume 正解）：被剪 R 的原事件已离场 surface，只有遍历日志
        // + resolveRootSeqs 折链才能重建被剪账本；桩事件排除（tagRsFromLog 内）。
        const tagsBySeq = tagRsFromLog(events, cwd, seq => resolveRootSeqs(events, seq));
        const shadowed = scanShadowedSeqs(session);
        for (const [seq, input] of tagsBySeq) {
            this.ledger.observeR(seq, input.turn, input.tags);
            if (shadowed.has(seq))
                this.ledger.addPruned({ rootSeq: seq, turn: input.turn, tags: input.tags });
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
        this.ledger.sweepClosed(atoms.reduce((m, a) => Math.max(m, a.turn), 0), this.cfg.stickyWindowTurns);
        return { atoms, tagsBySeq, cwd };
    }
    /** 纯决策（无发射副作用）：单测主对象。targetReleaseChars = 需释放的下界。 */
    decide(session, targetReleaseChars) {
        const { atoms, tagsBySeq, cwd } = this.observe(session);
        const latestTurn = atoms.reduce((m, a) => Math.max(m, a.turn), 0);
        const openTurn = detectOpenTurn(session);
        const shadowed = scanShadowedSeqs(session);
        const focal = focalLabels(atoms, latestTurn, this.cfg.focalTurns(), cwd);
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
            for (const k of focalCommandLabels(calls, latestTurn, this.cfg.focalTurns()))
                focalMedium.add(k);
        }
        const superseded = supersededMarks(tagsBySeq);
        const st = this.stateOf(session);
        const sticky = this.ledger.stickyActive();
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
                seq: a.seq, turn: a.turn, input, inOpenTurn, regenerable, stickyMember, focalMatch,
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
            const focalDocStrong = tiered && f.focalDocHit.length > 0
                && (!fuseActive || f.focalDocHit.some(lbl => docLatest.get(lbl) === f.seq));
            if (focalDocStrong)
                focalDocHardChars += f.input.tags.sizeChars;
            // 三值焦点带（§2.5 v1.1）：strong=文档面命中（hard 与否都占带位——熔断退 hard 时
            // 排序位仍沉底）；medium=白名单命令面（★永不 hard）；其余 none。flat 走布尔回退。
            const focalBand = tiered ? (f.focalDocHit.length > 0 ? 2 : f.mediumHit ? 1 : 0) : undefined;
            if (focalBand === 1)
                mediumBandChars += f.input.tags.sizeChars;
            focalBandBySeq.set(f.seq, focalBand ?? (f.focalMatch ? 1 : 0));
            entries.push({
                rootSeq: f.seq,
                score: computeScore({
                    rootSeq: f.seq, turn: f.turn, currentTurn: latestTurn, tags: f.input.tags,
                    // P6-③ 裁定 2：召回对全部硬保护位失效（无条件进剪序；可再生=再召回一次）。
                    hard: f.isRecall ? {} : {
                        failureNoFollowR: f.inOpenTurn,
                        // tiered：sticky 归因一枚化（只保 exemplar）；flat：逐枚硬保现行为。
                        stickyMember: tiered ? f.stickyMember && stickyExemplarSeqs.has(f.seq) : f.stickyMember,
                        attachment: f.input.resultText.length === 0,
                        // flat：现行为；tiered：焦点 hard 只认 document facet（v1.2 裸码降出），
                        // 且经 focalDocStrong 连可再生枚一并保住。
                        focalNonRegenerable: !tiered && f.focalMatch && f.regenerable !== true,
                        focalDocStrong,
                        errSignatureHard: tiered && errSigHardSeqs.has(f.seq),
                    },
                    regenerable: f.regenerable,
                    // v1.4 superseded 焦点豁免：命中焦点的枚不按"被新版覆盖"插队先剪
                    // （spike54 冲突面 90 枚/211KB；spike55 定案：非焦点释放阀保留）。
                    superseded: tiered && f.focalMatch ? undefined : superseded.get(f.seq) === true ? true : undefined,
                    focal: f.focalMatch,
                    focalBand,
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
        };
    }
    /**
     * 压力剪一笔：决策 → pruneIntervals 成对发射（每区间 shadow-price claim +
     * content-only 桩 replace，宿主契约由 prune-tx 保证）。目标不达不放宽。
     */
    compactIfNeeded(session, targetReleaseChars) {
        if (targetReleaseChars <= 0)
            return null;
        const decision = this.decide(session, targetReleaseChars);
        const { plan, tagsBySeq } = decision;
        if (plan.pruneOrder.length === 0) {
            if (plan.shortfallChars > 0) {
                this.host.log.warn('[argp-factor] 降级链：可剪面释放不足，缺口 ' + plan.shortfallChars
                    + ' chars（硬保护成员未入区；少剪并上报，不放宽判据）');
            }
            return null;
        }
        const atomsBySeq = new Map();
        for (const a of this.host.atomize(session))
            atomsBySeq.set(a.seq, a);
        // 本事务被驱逐 A 的 callId 集：其 R 不得落 tool 桩（桩保留 callId，issuer 已离场 =
        // 悬空 tool_call → provider 400）——改走 user 指针墓碑（配对整体离场）。
        const callsOfEvictedA = new Set();
        for (const seq of plan.pruneOrder) {
            const atom = atomsBySeq.get(seq);
            if (atom?.type === 'A')
                for (const cid of atom.toolCallIds)
                    callsOfEvictedA.add(cid);
        }
        const intervals = [];
        const tombstones = [];
        const seen = new Set();
        // C10 归位集：只有 planPrune 判入 clip 的 seq 走夹剪；其余（含 forcedFirst、
        // 可再生/被覆盖、小文本回落）走 shadow 最小桩。
        const clipSet = new Set(plan.clipOrder);
        let clipEmitted = 0;
        for (const seq of plan.pruneOrder) {
            if (seen.has(seq))
                continue;
            const atom = atomsBySeq.get(seq);
            if (atom === undefined)
                continue;
            // 中断轮半截 A（裁定 3）：user 墓碑整节点替换——未应答 tool_call 随 A 离场；
            // 已应答 R 由 decide 的强制先行段同行入序（seen 去重，同一事务同去）。
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
            // 发射成功立即入账（词表零轮延迟）；下一轮 shadowed-diff 重放被 rootSeq
            // 去重吸收。逐条以**真实 shadowed** 复核——prune-tx 预检（canCloneTool）剔除
            // 的区间未落 shadowed，不得误记。
            const shadowedNow = scanShadowedSeqs(session);
            for (const iv of intervals) {
                const seq = iv.seqs[0];
                if (!shadowedNow.has(seq))
                    continue;
                const atom = atomsBySeq.get(seq);
                const input = tagsBySeq.get(seq);
                if (atom !== undefined && input !== undefined) {
                    this.ledger.addPruned({ rootSeq: seq, turn: atom.turn, tags: input.tags });
                }
            }
            this.host.log.info('[argp-factor] 剪 ' + intervals.length + ' R / ' + plan.releasedChars
                + ' chars（夹剪 ' + clipEmitted + '）；sticky 活跃 ' + decision.stickyActive + '；焦点标签 ' + decision.focalSize);
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
    /** 实体标签选择序：document → command → errorcode（stubText 与 clip 首行共用）。 */
    stubKey(input) {
        return input.tags.files[0] !== undefined ? 'document:' + input.tags.files[0]
            : input.tags.commands[0]
                ?? (input.tags.errorcodes[0] !== undefined ? 'errorcode:' + input.tags.errorcodes[0] : undefined);
    }
    /** 词表段（渲染出口；注入通路见 refreshVocabularyNote）。 */
    vocabulary(session) {
        this.observe(session);
        return renderVocabulary({
            ledger: this.ledger,
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
        if (st.vocabNoteSeq === null) {
            const found = lastVocabNoteSeq(sessionEvents(session));
            if (found !== null) {
                st.vocabNoteSeq = found;
                st.vocabEpoch = this.ledger.epoch;
            }
        }
        if (st.vocabNoteSeq === null) {
            await steer(VOCAB_NOTE_MARKER + '\n' + text);
            // steer 落盘形态由宿主决定（auto-continue 先例：steer 即 append）——指针以
            // **标记回溯**为准；steer 未落盘（异常宿主）则不记指针，下轮自然重试。
            const seq = lastVocabNoteSeq(sessionEvents(session));
            if (seq === null) {
                this.host.log.warn('[argp-factor] 词表 note steer 后未在日志找回（宿主 steer 未落盘？）——本轮跳过，下轮重试');
                return;
            }
            st.vocabNoteSeq = seq;
            st.vocabEpoch = this.ledger.epoch;
            return;
        }
        if (st.vocabEpoch === this.ledger.epoch)
            return;
        st.vocabEpoch = this.ledger.epoch;
        const note = VOCAB_NOTE_MARKER + '\n' + text;
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
