/**
 * 被剪账本 + 倒排索引 + sticky 状态机 + 词表渲染（design-2.0 §1.3/§1.4/§2.2）。
 *
 * 全量重放、零持久化：一切状态可从 append-only 日志的 prune 事件重建（引擎侧职责，
 * 本模块只吃 `(rootSeq, turn, RTags)` 三元组，不碰 fs、不碰 LLM）。
 *
 * 纪律：
 *  - **append root seq 去重**——replace 链同一调用多次入账只计一次（`shadowedSeqsOf`
 *    口径教训，spike/48 实测 47K 剪枝副本 vs 7.8K 真调用的病灶）；
 *  - **词表源 = 被剪账本**（§1.5-7：列存活原子会把"已被清空"的标签挤出 top-N）；
 *  - **fail-closed 出口**：渲染前再过一遍 `labelAllowed`（文法表改版后旧索引条目
 *    不得漏进 prompt——拒收者留索引、不进 prompt）；
 *  - **sticky 闭集从紧**（I-DIR：闭集是释放向，判据须严）：任何 tool 类的复发
 *    都重置观察窗，"同文件他操作成功"绝不构成关闭理由。
 */
import { labelAllowed } from "./tag-canonical.js";
// ---------------------------------------------------------------------------
// 索引键形：`<facet>:<label>`；document/scope/errorcode 加前缀，command 族
// tag-extract 已产出 `command:<family>` 形态，原样入键（前缀即键形契约）。
// ---------------------------------------------------------------------------
export function indexKeys(tags) {
    const out = [];
    for (const f of tags.files)
        out.push('document:' + f);
    for (const s of tags.scopes)
        out.push('scope:' + s);
    for (const c of tags.commands)
        out.push(c);
    for (const e of tags.errorcodes)
        out.push('errorcode:' + e);
    return out;
}
/** 词表可列类别（tool 仅展示不进查询键、scope 仅辅助排序——都不渲染进行）。 */
export const VOCAB_FACETS = ['document', 'command', 'errorcode'];
export function facetOfKey(key) {
    if (key.startsWith('document:'))
        return 'document';
    if (key.startsWith('scope:'))
        return 'scope';
    if (key.startsWith('command:'))
        return 'command';
    if (key.startsWith('errorcode:'))
        return 'errorcode';
    if (key.startsWith('tool:'))
        return 'tool';
    return null;
}
export class FactorLedger {
    entries = new Map();
    inverted = new Map();
    /** sticky 通道独立去重：观察流含存活 R，与剪枝通道互不污染。 */
    observed = new Set();
    sticky = new Map();
    _epoch = 0;
    get epoch() {
        return this._epoch;
    }
    get prunedCount() {
        return this.entries.size;
    }
    /**
     * 剪枝入账。rootSeq 重复（replace 链 / 重放双计）⇒ 返回 false，绝不双计。
     * 不合文法的标签照单入索引（§1.3：留索引），出口渲染处拦截。
     */
    addPruned(entry) {
        if (this.entries.has(entry.rootSeq))
            return false;
        this.entries.set(entry.rootSeq, entry);
        for (const key of indexKeys(entry.tags)) {
            const set = this.inverted.get(key);
            if (set === undefined)
                this.inverted.set(key, new Set([entry.rootSeq]));
            else
                set.add(entry.rootSeq);
        }
        this._epoch += 1;
        return true;
    }
    /**
     * sticky 状态机进料：**全部** R 事件（含存活者——"两次失败夹成功写"的观察
     * 面本来就在存活区）。rootSeq 去重与 addPruned 独立。
     */
    observeR(rootSeq, turn, tags) {
        if (this.observed.has(rootSeq))
            return;
        this.observed.add(rootSeq);
        if (tags.errorish && tags.errorcodes.length > 0 && tags.files.length > 0) {
            for (const file of tags.files) {
                for (const code of tags.errorcodes) {
                    const key = file + '|' + code;
                    const t = this.sticky.get(key);
                    if (t === undefined) {
                        this.sticky.set(key, {
                            key, file, errorcode: code, state: 'open', failCount: 1,
                            firstFailTurn: turn, lastFailTurn: turn, fixClaimedBetween: false,
                            toolClasses: new Set([tags.tool]),
                        });
                    }
                    else {
                        // 复发夹修复宣称 ⇒ sticky（保护向：宣称不实、错误再现）。
                        // closed 非终态：同键复发必须复活重观察（闭集判据重新起算）。
                        if (t.fixClaimedBetween)
                            t.state = 'sticky';
                        else if (t.state === 'closed')
                            t.state = 'open';
                        t.failCount += 1;
                        t.lastFailTurn = turn;
                        t.fixClaimedBetween = false;
                        t.toolClasses.add(tags.tool);
                    }
                }
            }
            this._epoch += 1;
            return;
        }
        if (tags.writeish && !tags.errorish && tags.files.length > 0) {
            // 成功写 = 对在场文件的"修复宣称"，只挂到该文件已有的 open/sticky 失败上。
            for (const file of tags.files) {
                for (const t of this.sticky.values()) {
                    if (t.file === file && t.state !== 'closed')
                        t.fixClaimedBetween = true;
                }
            }
        }
    }
    /**
     * 闭集扫描（引擎每轮调用）。I-DIR 严口径：窗内**任何** tool 类复发都重置
     * 观察窗（三条件交集版更松，弃用）；只有 sticky 且窗内零复发才 closed。
     */
    sweepClosed(currentTurn, windowTurns) {
        for (const t of this.sticky.values()) {
            if (t.state === 'sticky' && currentTurn - t.lastFailTurn >= windowTurns)
                t.state = 'closed';
        }
    }
    /** open/sticky 全量视图（引擎排序硬保护 + 词表标注行消费）。 */
    stickyActive() {
        const out = [];
        for (const t of this.sticky.values()) {
            if (t.state === 'closed')
                continue;
            out.push({
                key: t.key, file: t.file, errorcode: t.errorcode, state: t.state,
                failCount: t.failCount, firstFailTurn: t.firstFailTurn,
                lastFailTurn: t.lastFailTurn, fixClaimedBetween: t.fixClaimedBetween,
            });
        }
        return out.sort((a, b) => b.failCount - a.failCount || b.lastFailTurn - a.lastFailTurn);
    }
    stat(key) {
        const set = this.inverted.get(key);
        if (set === undefined || set.size === 0)
            return null;
        let last = -1;
        for (const seq of set) {
            const e = this.entries.get(seq);
            if (e !== undefined && e.turn > last)
                last = e.turn;
        }
        return { rootSeqs: [...set].sort((a, b) => a - b), count: set.size, lastSeenTurn: last };
    }
    /** item 句柄校验（recall_history item= 钻取）：rootSeq 必须在**被剪账本**内——
     *  对 live seq 用 item 必须拒绝，否则 item 就是无标签限制的 seq 召回通道（假通道复辟）。 */
    hasEntry(rootSeq) {
        return this.entries.has(rootSeq);
    }
    /** item 钻取的行元数据（仅账本内 seq 有值；outline/item 路径共用）。 */
    entryOf(rootSeq) {
        const e = this.entries.get(rootSeq);
        if (e === undefined)
            return null;
        return { turn: e.turn, tool: e.tags.tool, failed: e.tags.failed === true, errorish: e.tags.errorish };
    }
    /**
     * 标签 **AND** 召回（§1.4 需求驱动通道；2026-11-14 用户批准的 Kimi 方案 R2 内核）。
     * 候选 = 在场标签倒排集的交集；不在账本的标签剔除回显（droppedLabels 同口径），
     * 不参与求交（一个空想标签不杀死整个查询）。
     * 未命中的查询标签如实剔除并回显（droppedLabels），不静默。
     */
    queryPruned(q) {
        // AND：从第一个在场标签的集合开始逐个求交。
        let candidate = null;
        for (const label of q.labels) {
            const set = this.inverted.get(label);
            if (set === undefined || set.size === 0)
                continue;
            if (candidate === null)
                candidate = new Set(set);
            else
                for (const seq of candidate)
                    if (!set.has(seq))
                        candidate.delete(seq);
        }
        const sorted = [...(candidate ?? [])]
            .map(seq => ({ seq, e: this.entries.get(seq) }))
            .filter((x) => x.e !== undefined)
            .sort((a, b) => {
            if ((q.order ?? 'relevant') === 'timeline') {
                return a.e.turn - b.e.turn || a.seq - b.seq;
            }
            if (q.order === 'fresh')
                return b.e.turn - a.e.turn || b.seq - a.seq;
            // relevant（缺省）：hitLabels 数在纯 AND 下为常数 ⇒ 实际退化为 fresh（契约文案
            // 如实说明）；保留该键是为 anyOf（缓办）与多键形标签未来扩展留位。
            const aHits = q.labels.filter(l => this.inverted.get(l)?.has(a.seq)).length;
            const bHits = q.labels.filter(l => this.inverted.get(l)?.has(b.seq)).length;
            return bHits - aHits || b.e.turn - a.e.turn || b.seq - a.seq;
        });
        const hitOf = (seq) => q.labels.filter(l => this.inverted.get(l)?.has(seq));
        return this.pageOf(q, sorted, hitOf);
    }
    /** cursor/epoch 分页（从 queryPruned 拆出：排序与分页两个正交关注点）。 */
    pageOf(q, sorted, hitOf) {
        const epochStale = q.epoch !== undefined && q.epoch !== this._epoch;
        // 排序已在调用侧按当前 epoch 重算：epoch 漂移时旧游标的语义已失效（它指向旧排序的
        // offset），必须从头开始——文案说"re-sorted from scratch"就必须真的从头。
        const start = epochStale ? 0 : Math.max(0, Math.min(q.cursor ?? 0, sorted.length));
        const page = sorted.slice(start, start + q.limit);
        return {
            rows: page.map(x => ({
                rootSeq: x.seq, turn: x.e.turn, hitLabels: hitOf(x.seq),
                tool: x.e.tags.tool, failed: x.e.tags.failed === true, errorish: x.e.tags.errorish,
            })),
            nextCursor: start + page.length < sorted.length ? start + page.length : null,
            epoch: this._epoch,
            epochStale,
        };
    }
    /** queryPruned 的 droppedLabels（组合根转发用，免调用方摸索引）。 */
    droppedLabels(labels) {
        return labels.filter(l => {
            const set = this.inverted.get(l);
            return set === undefined || set.size === 0;
        });
    }
    /**
     * 路径后缀归一匹配（2026-11-14 用户裁定；alpha4 T19/T30 实锤：模型猜相对路径标签
     * `document:.material/p02-1.md`，账本存绝对路径 ⇒ no-match 后模型放弃召回、凭记忆作答）。
     * 只对路径形键（document:/scope:）；`rel:` 前缀键剥离后同权。多候选时调用方
     * fail-closed 列出候选，绝不猜（与词表 fail-closed 同纪律）。
     */
    matchBySuffix(prefix, tail) {
        const out = [];
        for (const key of this.inverted.keys()) {
            if (!key.startsWith(prefix))
                continue;
            let rest = key.slice(prefix.length);
            if (rest.startsWith('rel:'))
                rest = rest.slice('rel:'.length);
            if (rest === tail || rest.endsWith('/' + tail))
                out.push(key);
        }
        return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    }
    /**
     * 词表行（每类 topN，数量降序 → 新鲜度降序）。**只从被剪账本派生**。
     * 出口 fail-closed：不合当前文法的键（文法表改版/历史污染）剔除并计数。
     * 行内线索（Kimi R4 紧版，2026-11-14）：lastTool/lastFailed 取最后一条的宿主结构化
     * verdict；err-sig 只**计数**不判死——errorish 是文本信号（日志正文含 ENOENT 也置真），
     * 绝不当"该次调用失败"渲染（types.ts RTags.failed 注释纪律）。
     */
    vocabularyRows(facet, topN) {
        const prefix = facet + ':';
        const candidates = [];
        let rejected = 0;
        for (const key of this.inverted.keys()) {
            if (!key.startsWith(prefix))
                continue;
            if (labelAllowed(key) !== null) {
                rejected += 1;
                continue;
            }
            const st = this.stat(key);
            if (st === null)
                continue;
            let lastSeq = -1;
            let lastEntry = null;
            let errSig = 0;
            for (const seq of st.rootSeqs) {
                const e = this.entries.get(seq);
                if (e === undefined)
                    continue;
                if (e.tags.errorish)
                    errSig += 1;
                if (lastEntry === null || e.turn > lastEntry.turn || (e.turn === lastEntry.turn && seq > lastSeq)) {
                    lastEntry = e;
                    lastSeq = seq;
                }
            }
            candidates.push({
                key, count: st.count, lastSeenTurn: st.lastSeenTurn,
                lastTool: lastEntry?.tags.tool ?? 'tool',
                lastFailed: lastEntry?.tags.failed === true,
                errSigCount: errSig,
            });
        }
        candidates.sort((a, b) => b.count - a.count || b.lastSeenTurn - a.lastSeenTurn);
        return { rows: candidates.slice(0, topN), omitted: Math.max(0, candidates.length - topN), rejected };
    }
}
export function renderVocabulary(o) {
    const topN = o.topNPerFacet ?? 10;
    const budget = o.budgetChars ?? 4000;
    const omitted = {};
    const lines = [];
    let rejected = 0;
    let used = 0;
    let truncated = false;
    const push = (line) => {
        if (used + line.length + 1 > budget) {
            truncated = true;
            return false;
        }
        used += line.length + 1;
        lines.push(line);
        return true;
    };
    // 词表标注行只列 sticky（§2.2）；open 是候选、仅进引擎排序硬保护位，
    // 未定型的问题不配占用 prompt 行。
    for (const t of o.ledger.stickyActive()) {
        if (t.state !== 'sticky')
            continue;
        const mark = o.stickyHook !== undefined
            ? o.stickyHook(t)
            : `⚠ ${t.file} + ${t.errorcode}：修复宣称后仍失败 ×${t.failCount}——按未解决特例对待，动手前先 recall_history(document:${t.file})`;
        if (!push(mark))
            break;
    }
    for (const facet of VOCAB_FACETS) {
        const v = o.ledger.vocabularyRows(facet, topN);
        rejected += v.rejected;
        if (v.rows.length === 0)
            continue;
        if (v.omitted > 0)
            omitted[facet] = v.omitted;
        const header = `${facet}（历史已清空项，recall_history 可取回）：`;
        if (!push(header)) {
            truncated = true;
            break;
        }
        let anyRow = false;
        for (const r of v.rows) {
            // R4 紧版行（2026-11-14）：去每行 hook（facet header 已指路 recall_history），
            // 换确定性线索——最后一条的 tool + 宿主结构化 verdict + err-sig 计数
            // （errorish 只计数不判死，见 vocabularyRows 注释）。
            const errPart = r.errSigCount > 0 ? ' · err-sig ' + r.errSigCount + '/' + r.count : '';
            if (!push(`- ${r.key} ×${r.count} · last: ${r.lastTool} ${r.lastFailed ? 'failed' : 'ok'} @t${r.lastSeenTurn}${errPart}`)) {
                truncated = true;
                break;
            }
            anyRow = true;
        }
        // 诚实渲染：标题不得单独入文——承诺"可取回"却零条目是假通道，空标题回滚。
        if (!anyRow) {
            lines.pop();
            used -= header.length + 1;
        }
        if (truncated)
            break;
    }
    const omittedFacets = Object.keys(omitted);
    if (!truncated && omittedFacets.length > 0) {
        const hint = `其余低频标签未列：list_labels(${omittedFacets.join('|')}) 下钻`;
        if (used + hint.length + 1 > budget)
            truncated = true;
        else
            lines.push(hint);
    }
    return { text: lines.join('\n'), omitted, truncated, rejectedLabels: rejected };
}
