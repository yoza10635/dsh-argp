/**
 * 被剪账本 + 倒排索引 + sticky 状态机 + 词表渲染（design-2.0 §1.3/§1.4/§2.2）。
 *
 * 全量重放、零持久化：一切状态可从 append-only 日志的 prune 事件重建（引擎侧职责，
 * 本模块只吃 `(rootSeq, turn, RTags)` 三元组，不碰 fs、不碰 LLM）。
 *
 * 纪律：
 *  - **append root seq 去重**——replace 链同一调用多次入账只计一次（`shadowedSeqsOf`
 *    口径教训，P0 提取审计实测 47K 剪枝副本 vs 7.8K 真调用的病灶）；
 *  - **词表源 = 被剪账本**（§1.5-7：列存活原子会把"已被清空"的标签挤出 top-N）；
 *  - **fail-closed 出口**：渲染前再过一遍 `labelAllowed`（文法表改版后旧索引条目
 *    不得漏进 prompt——拒收者留索引、不进 prompt）；
 *  - **sticky 闭集从紧**（I-DIR：闭集是释放向，判据须严）：任何 tool 类的复发
 *    都重置观察窗，"同文件他操作成功"绝不构成关闭理由。
 */
import { labelAllowed } from "./tag-canonical.js";
import { isRecallTool, namesRecallFamilyKey } from "./recall-tools.js";
import { DEFAULT_STICKY_TRACK_CAP } from '../constants.js';
import { SeqBitset } from '../seq-bitset.js';
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
    // tool 键（2026-11-16 用户裁定「tool 名字等于什么就是什么因子键」）：注册名逐字入键
    // （宿主存在字面冒号名 `tool:jobs` ⇒ 键形 `tool:tool:jobs`，P8 裁定不折叠）。
    // **非空门槛**（对抗审查 P1-1）：callId 配不到 issuer 的孤儿 R `tool:''` 是实测常态，
    // 空尾键 `tool:` 穿透 labelAllowed（5 字符）并罩住全部匿名原子；且 focalLabels 与
    // 本函数共享（factor-atoms.ts:202）——不设门槛即焦点污染（ZT3/ZT9 锁死）。
    if (tags.tool !== '')
        out.push('tool:' + tags.tool);
    return out;
}
/** 词表可列类别（scope 仅辅助排序不渲染；tool 2026-11-16 升格进查询键，
 *  旧「tool 仅展示」口径随 design-tool-facet §1 作废）。 */
export const VOCAB_FACETS = ['document', 'command', 'errorcode', 'tool'];
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
    /**
     * sticky 通道独立去重：观察流含存活 R，与剪枝通道互不污染。
     * A5：seq 稠密 ⇒ 用位图（1 bit/seq）替代 `Set<number>`（≈30–40 B/seq）。
     * **不设条数上限**：丢一枚去重 ⇒ 该 R 重放时会被再计一次失败。
     */
    observed = new SeqBitset();
    sticky = new Map();
    _epoch = 0;
    stickyCap;
    constructor(stickyCap = DEFAULT_STICKY_TRACK_CAP) {
        this.stickyCap = stickyCap;
    }
    get epoch() {
        return this._epoch;
    }
    get prunedCount() {
        return this.entries.size;
    }
    /** 观察去重集的已登记数量（诊断/内存回归用；真实条数不受位图容量影响）。 */
    get observedCount() {
        return this.observed.size;
    }
    /** 观察去重位图占用字节数（内存回归用）。 */
    get observedBytes() {
        return this.observed.byteLength;
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
     * sticky 状态机进料：R 事件（含存活者——"两次失败夹成功写"的观察面本来就在
     * 存活区），**但召回族除外**（下方 isRecall 早退，召回副本可见性裁决）。
     * rootSeq 去重与 addPruned 独立。
     */
    observeR(rootSeq, turn, tags) {
        // 召回副本可见性裁决（2026-11-23）：裁定 2 剪下的召回结果不进 sticky 观察面。
        // 副本经文本侧兜底携带的 file|errorcode 组合是原文失败发生次的回声——放进来 =
        // 同一次失败再记一笔；若中间夹过成功写的 fixClaimedBetween，把已修复错误翻成
        // sticky（词表「修复宣称后仍失败 ×N」假警报行 + 同文件读取挂错保护）。
        // 早退放在 observed 登记**之前**：observed 是"进过观察面"的去重集，副本从未进
        // 观察面、登记它即让去重集虚胖；重放幂等不因此破坏——副本事件每次重放都走
        // 同一早退路径，代价只是一次 includes 判断。
        if (isRecallTool(tags.tool))
            return;
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
                        this.evictStickyOverCap();
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
     * sticky 轨道上限（A5）：超限时淘汰一条——优先已闭集（不再提供保护）中
     * lastFailTurn 最旧者；全未闭合则淘汰 lastFailTurn 最旧者。O(轨道数)，只在
     * 新建轨道时越过上限才触发。仍在观察窗内的近期轨道不动（窗内保护语义保持）。
     */
    evictStickyOverCap() {
        if (this.sticky.size <= this.stickyCap)
            return;
        let victim = null;
        let victimClosed = false;
        let victimTurn = Number.POSITIVE_INFINITY;
        for (const [key, t] of this.sticky) {
            const closed = t.state === 'closed';
            // 闭集优先：只要存在闭集，未闭合轨道绝不成为候选。
            if (victim !== null && victimClosed && !closed)
                continue;
            if (victim === null || (closed && !victimClosed) || (closed === victimClosed && t.lastFailTurn < victimTurn)) {
                victim = key;
                victimClosed = closed;
                victimTurn = t.lastFailTurn;
            }
        }
        if (victim !== null)
            this.sticky.delete(victim);
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
    /** keyword 发现模式全候选（升序确定性）。 */
    prunedRootSeqs() {
        return [...this.entries.keys()].sort((a, b) => a - b);
    }
    /** 单枚条目的全形标签键（keyword 发现行随行走全形标签 = 教学闭环，§11.4：
     *  命中一次就教会模型下次直接用它抄来的标签）。 */
    labelKeysOf(rootSeq) {
        const e = this.entries.get(rootSeq);
        return e === undefined ? [] : indexKeys(e.tags);
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
        // keyword 通道候选收口（design-tool-facet §11.4）：带 labels ⇒ 交集（KR2——keyword
        // 不越过 label 收窄集）；labels 空 ⇒ restrictTo 即全候选（发现模式）。在场 label
        // 全被剔（空想）时 candidate 保持 null——restrictTo **不复活**被拒候选（KR2 另一半）。
        if (q.restrictTo !== undefined) {
            if (candidate === null)
                candidate = q.labels.length === 0 ? new Set(q.restrictTo) : null;
            else
                for (const seq of [...candidate])
                    if (!q.restrictTo.has(seq))
                        candidate.delete(seq);
        }
        // 召回副本可见性裁决（2026-11-23）：裁定 2 把召回工具自身结果剪成副本，副本经
        // 文本侧兜底携带与原文相同的 document:/errorcode: 键（tag-extract），纯 AND 下
        // relevant 档退化为 turn/rootSeq 降序 ⇒ seq 更新的副本排挤原文进缺省档
        // （缺省 limit 5 与 5% 字符预算）。缺省剔除；labels 点名 tool: 召回族键时放行
        // （审计查询 ['document:x','tool:recall_history']='该文件曾被召回过什么'必须
        // 命中副本）。施加位置=条目级（entries 过滤后、排序前）；item= 直钻不受本闸
        // （句柄只来自先前 surfacing，审计第二跳要用）。
        const copiesVisible = namesRecallFamilyKey(q.labels);
        const sorted = [...(candidate ?? [])]
            .map(seq => ({ seq, e: this.entries.get(seq) }))
            .filter((x) => x.e !== undefined)
            .filter(x => copiesVisible || !isRecallTool(x.e.tags.tool))
            .sort((a, b) => {
            if ((q.order ?? 'relevant') === 'timeline') {
                return a.e.turn - b.e.turn || a.seq - b.seq;
            }
            if (q.order === 'fresh')
                return b.e.turn - a.e.turn || b.seq - a.seq;
            // keyword 相关性首键（命中数降序）：只在调用方给了 relevance 时生效，否则
            // 下方表达式逐字节等于现行 relevant 行为（KR3 确定性由 Map 值确定性保证）。
            const rel = q.relevance !== undefined ? (q.relevance.get(b.seq) ?? 0) - (q.relevance.get(a.seq) ?? 0) : 0;
            // relevant（缺省）：hitLabels 数在纯 AND 下为常数 ⇒ 实际退化为 fresh（契约文案
            // 如实说明）；保留该键是为 anyOf（缓办）与多键形标签未来扩展留位。
            const aHits = q.labels.filter(l => this.inverted.get(l)?.has(a.seq)).length;
            const bHits = q.labels.filter(l => this.inverted.get(l)?.has(b.seq)).length;
            return rel || bHits - aHits || b.e.turn - a.e.turn || b.seq - a.seq;
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
        // 召回副本可见性裁决（2026-11-23）：非 tool facet 的行计数与全部行内聚合量
        // （lastSeenTurn/lastTool/err-sig/preview）剔除召回副本——queryPruned 缺省
        // 不返回副本，词表 ×N 不得超出可返回数（「词表数=可查数」契约）；仅副本
        // 覆盖的键（可见数 0）整行不出列。tool facet 原样保留——`tool:recall_history`
        // ×副本数本身是审计行，且点名 tool: 族键的查询确实返回副本。
        const skipCopies = facet !== 'tool';
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
            let visibleCount = 0;
            for (const seq of st.rootSeqs) {
                const e = this.entries.get(seq);
                if (e === undefined)
                    continue;
                if (skipCopies && isRecallTool(e.tags.tool))
                    continue;
                visibleCount += 1;
                if (e.tags.errorish)
                    errSig += 1;
                if (lastEntry === null || e.turn > lastEntry.turn || (e.turn === lastEntry.turn && seq > lastSeq)) {
                    lastEntry = e;
                    lastSeq = seq;
                }
            }
            if (skipCopies && visibleCount === 0)
                continue;
            candidates.push({
                key,
                count: skipCopies ? visibleCount : st.count,
                lastSeenTurn: skipCopies ? (lastEntry?.turn ?? st.lastSeenTurn) : st.lastSeenTurn,
                lastTool: lastEntry?.tags.tool ?? 'tool',
                lastFailed: lastEntry?.tags.failed === true,
                errSigCount: errSig,
                // 预览与 `last:` 位**同枚**（lastSeenTurn 那枚，P1-4 裁定：否则文案与
                // recall 首条对不上）。一行聚合 N 枚只展示这一枚。
                preview: lastEntry?.preview,
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
            truncated = true;
    }
    // R4 紧版行（2026-11-14）：去每行 hook（facet header 已指路 recall_history），
    // 换确定性线索——最后一条的 tool + 宿主结构化 verdict + err-sig 计数
    // （errorish 只计数不判死，见 vocabularyRows 注释）。
    // tool 桶行键名即工具名，`last: <tool>` 与键恒重复 ⇒ 去重（P2 项）。
    const plainLine = (r, dedupeTool) => `- ${r.key} ×${r.count} · ${dedupeTool ? '' : 'last: ' + r.lastTool + ' '}${r.lastFailed ? 'failed' : 'ok'} @t${r.lastSeenTurn}`
        + (r.errSigCount > 0 ? ' · err-sig ' + r.errSigCount + '/' + r.count : '');
    // 交互族行变体（design-tool-facet §2）：Q/A 预览（与 last: 位同枚）；多问 q×n 防漏答。
    const interactiveLine = (r) => `- ${r.key} ×${r.count} · ${r.lastFailed ? 'failed' : 'ok'} @t${r.lastSeenTurn}`
        + (r.errSigCount > 0 ? ' · err-sig ' + r.errSigCount + '/' + r.count : '')
        + (r.preview?.q !== undefined ? ' · Q' + (r.preview.qCount !== undefined ? '×' + r.preview.qCount : '') + ':"' + r.preview.q + '"' : '')
        + (r.preview?.a !== undefined ? ' A:"' + r.preview.a + '"' : '');
    /** 单块渲染；空标题回滚（承诺"可取回"却零条目 = 假通道）。返回是否全部入文。 */
    const block = (header, rows, lineOf) => {
        if (rows.length === 0)
            return true;
        if (!push(header)) {
            truncated = true;
            return false;
        }
        let anyRow = false;
        for (const r of rows) {
            if (!push(lineOf(r))) {
                truncated = true;
                break;
            }
            anyRow = true;
        }
        if (!anyRow) {
            lines.pop();
            used -= header.length + 1;
        }
        return !truncated;
    };
    // **两段化**（P1-3：VOCAB_FACETS 声明序不再承担优先级；push 失败即截断的单调模型
    // 撑不起"交互置顶、最后裁"）：
    //  保号段（先推 = 最后裁）：sticky → 交互 tool 行 → document；
    //  普通段（先裁）：command → errorcode → 普通 tool 行。
    // 段内溢出裁序（A5 裁定，ZT4 锁）：document 行先让位、交互行最后裁。
    const isI = o.isInteractive ?? (() => false);
    const toolView = o.ledger.vocabularyRows('tool', topN);
    rejected += toolView.rejected;
    if (toolView.omitted > 0)
        omitted.tool = toolView.omitted;
    const interactiveRows = toolView.rows.filter(r => isI(r.key));
    const plainToolRows = toolView.rows.filter(r => !isI(r.key));
    const docView = o.ledger.vocabularyRows('document', topN);
    rejected += docView.rejected;
    if (docView.omitted > 0)
        omitted.document = docView.omitted;
    block('交互记录（已剪，recall_history 可取回原文）：', interactiveRows, interactiveLine);
    if (!truncated)
        block('document（历史已清空项，recall_history 可取回）：', docView.rows, r => plainLine(r, false));
    // 普通段：保号段把预算吃穿就不再尝试（诚实 truncated，不静默丢）。
    if (!truncated) {
        for (const facet of ['command', 'errorcode']) {
            const v = o.ledger.vocabularyRows(facet, topN);
            rejected += v.rejected;
            if (v.omitted > 0)
                omitted[facet] = v.omitted;
            block(`${facet}（历史已清空项，recall_history 可取回）：`, v.rows, r => plainLine(r, false));
            if (truncated)
                break;
        }
        if (!truncated)
            block('tool（历史已清空项，recall_history 可取回）：', plainToolRows, r => plainLine(r, true));
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
