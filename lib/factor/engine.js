import { detectOpenTurn, resolveRootSeqs, scanShadowedSeqs, sessionEvents } from "../log-access.js";
import { pruneIntervals } from "../prune-tx.js";
import { focalLabels, sessionCwdFromEvents, supersededMarks, STUB_PREFIX, tagRsFromLog } from "./factor-atoms.js";
import { FactorLedger, indexKeys, renderVocabulary } from "./factor-ledger.js";
import { computeScore, planPrune } from "./retention-score.js";
import { READ_TOOLS } from "./tag-extract.js";
export class FactorEngine {
    ledger = new FactorLedger();
    states = new WeakMap();
    host;
    cfg;
    constructor(host, config = {}) {
        this.host = host;
        this.cfg = {
            focalTurns: config.focalTurns ?? 1,
            vocabTopN: config.vocabTopN ?? 10,
            stickyWindowTurns: config.stickyWindowTurns ?? 8,
            vocabBudgetChars: config.vocabBudgetChars ?? 4000,
        };
    }
    stateOf(session) {
        let st = this.states.get(session);
        if (st === undefined) {
            st = { observedUpToSeq: -1, snapshots: new Map() };
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
        const focal = focalLabels(atoms, latestTurn, this.cfg.focalTurns, cwd);
        const superseded = supersededMarks(tagsBySeq);
        const st = this.stateOf(session);
        const sticky = this.ledger.stickyActive();
        const entries = [];
        const candidates = new Map();
        for (const a of atoms) {
            if (a.type !== 'R')
                continue;
            if (shadowed.has(a.seq))
                continue;
            const input = tagsBySeq.get(a.seq);
            if (input === undefined)
                continue;
            candidates.set(a.seq, input);
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
            entries.push({
                rootSeq: a.seq,
                score: computeScore({
                    rootSeq: a.seq, turn: a.turn, currentTurn: latestTurn, tags: input.tags,
                    hard: {
                        failureNoFollowR: inOpenTurn,
                        stickyMember,
                        attachment: input.resultText.length === 0,
                        focalNonRegenerable: focalMatch && regenerable !== true,
                    },
                    regenerable,
                    superseded: superseded.get(a.seq) === true ? true : undefined,
                    focal: focalMatch,
                }),
            });
        }
        const plan = planPrune(entries, { targetReleaseChars });
        return {
            plan, candidates, tagsBySeq, latestTurn,
            focalSize: focal.size, stickyActive: sticky.length, shortfallChars: plan.shortfallChars,
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
        const intervals = [];
        const tombstones = [];
        for (const seq of plan.pruneOrder) {
            const atom = atomsBySeq.get(seq);
            const input = tagsBySeq.get(seq);
            if (atom === undefined || input === undefined || input.callId === undefined)
                continue;
            intervals.push({ seqs: [seq], chars: input.tags.sizeChars, atoms: [atom] });
            tombstones.push({ type: 'tool', seq, callId: input.callId, text: this.stubText(input) });
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
                + ' chars；sticky 活跃 ' + decision.stickyActive + '；焦点标签 ' + decision.focalSize);
        }
        return result;
    }
    /** 最小桩（§1.2 ~30 字符物理下限；禁引退役工具名）。前缀 STUB_PREFIX 是
     *  tagRsFromLog 的桩排除判据——单点引用，改文案不得动前缀。 */
    stubText(input) {
        const key = input.tags.files[0] !== undefined ? 'document:' + input.tags.files[0]
            : input.tags.commands[0]
                ?? (input.tags.errorcodes[0] !== undefined ? 'errorcode:' + input.tags.errorcodes[0] : undefined);
        const head = STUB_PREFIX + ' ' + (input.tool !== '' ? input.tool : 'tool');
        return key === undefined
            ? head + '（无实体标签，原文仍在日志）'
            : head + ' → ' + key + '（需要原文时 recall_history(' + key + ')）';
    }
    /** 词表段（surface 剪枝区头部注入位在 P2 接线；本函数是渲染出口）。 */
    vocabulary(session) {
        this.observe(session);
        return renderVocabulary({
            ledger: this.ledger,
            topNPerFacet: this.cfg.vocabTopN,
            budgetChars: this.cfg.vocabBudgetChars,
        });
    }
}
