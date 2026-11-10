/** 已浓缩形态（二次摘要禁令；与 constants.DEFAULT_SKIP_CONTEXT_FORMS 同名单）。 */
export const SKIP_SUMMARY_FORMS = ['relay', 'notice'];
export function classifyUaAtom(atom, probe) {
    if (atom.type === 'X')
        return 'excluded';
    // 已浓缩的 U-info 聚合副本（sourceSeq 即识别判据）：禁二次摘要。
    if (atom.type === 'U' && atom.sourceSeq !== undefined)
        return 'excluded';
    if (probe.attachment)
        return 'barrier';
    if (atom.type === 'U') {
        if (probe.form !== undefined && SKIP_SUMMARY_FORMS.includes(probe.form))
            return 'excluded';
        return 'textA';
    }
    if (atom.type === 'A')
        return atom.toolCallIds.length > 0 ? 'toolCallA' : 'textA';
    return 'rPair';
}
// ---------------------------------------------------------------------------
// 约束带词法（高召回；误报=多几行逐字文本，方向安全）
// ---------------------------------------------------------------------------
/** 约束词法（§2.4 名单 + 同族扩展）：命中即整句逐字进约束带。 */
export const CONSTRAINT_LEXICON_RE = /(只|仅|绝|禁|勿|别|不要|必须|不得|统一|红线|一律|严禁|不许|不准|务必)/;
const SENTENCE_SPLIT_RE = /[^。！？!?\n]+[。！？!?\n]?/g;
/**
 * 逐字约束句：按句末标点/换行切句，返回**原文子串**（不改写；trim 只切两端空白）。
 */
export function constraintLinesOf(text) {
    const out = [];
    for (const m of text.matchAll(SENTENCE_SPLIT_RE)) {
        const s = (m[0] ?? '').trim();
        if (s !== '' && CONSTRAINT_LEXICON_RE.test(s))
            out.push(s);
    }
    return out;
}
export function planUaSpans(atoms, opts) {
    const spans = [];
    let run = [];
    /** run 各成员在输入 atoms 数组中的下标（索引邻接自检用，见 closeRun）。 */
    let runAt = [];
    /** 段内未闭合协议组：callId → 其 issuer A 在 run 中的下标。 */
    let pending = new Map();
    const closeRun = () => {
        // 协议组不劈：段尾仍有未应答的 toolCallA ⇒ 从最早那个 A 起弹出（弃入下批）。
        let cut = run.length;
        for (const idx of pending.values())
            cut = Math.min(cut, idx);
        const kept = run.slice(0, cut);
        const keptAt = runAt.slice(0, cut);
        run = [];
        runAt = [];
        pending = new Map();
        if (kept.length === 0)
            return;
        const seqs = kept.map(a => a.seq);
        // 连续性自检（replace 区间必须是 surface 序列的连续切片，禁吞无账 surface 节点）。
        // 判据 = **输入 atoms 数组的下标邻接**，不是 seq+1 算术：atomize 是 surface 的 1:1
        // 投影，而 tool/call 占 log 格却不进 surface（graph-build.ts §4.1 原子化注释；本仓
        // 实测 appendGroup 后 surface=[0,1,2,4]——A(seq2) 与 R(seq4) 之间恒有洞）。replace
        // 范围 [first..last] 里的洞只可来自这类非 surface 事件——host 的 surface fold 对
        // 它们本就无投影，prune-tx 的 summary span 自检（prune-tx.ts surfaceNodes.slice）
        // 与逐区间 shadow-price 同样按 surface 取证，洞合法。
        for (let i = 1; i < keptAt.length; i += 1) {
            if (keptAt[i] !== keptAt[i - 1] + 1)
                return;
        }
        const constraintLines = [];
        for (const a of kept) {
            if (a.type === 'U')
                constraintLines.push(...constraintLinesOf(a.text));
        }
        spans.push({
            seqs,
            atoms: kept,
            poolChars: kept.reduce((n, a) => n + (a.type === 'R' ? 0 : a.text.length), 0),
            allChars: kept.reduce((n, a) => n + a.text.length, 0),
            firstTurn: kept[0].turn,
            lastTurn: kept[kept.length - 1].turn,
            constraintLines,
        });
    };
    for (let i = 0; i < atoms.length; i += 1) {
        const a = atoms[i];
        const ineligible = (opts.openTurn !== null && a.turn >= opts.openTurn)
            || (opts.protectFromTurn !== null && a.turn >= opts.protectFromTurn);
        if (ineligible) {
            closeRun();
            continue;
        }
        const cls = classifyUaAtom(a, opts.probe(a.seq));
        if (cls === 'excluded' || cls === 'barrier') {
            closeRun();
            continue;
        }
        if (cls === 'rPair') {
            const callId = a.toolCallIds[0];
            if (callId !== undefined && pending.has(callId)) {
                pending.delete(callId);
                run.push(a);
                runAt.push(i);
                continue;
            }
            // 孤儿 R（issuer A 不在本段）：切段，不吃它。
            closeRun();
            continue;
        }
        if (cls === 'toolCallA') {
            run.push(a);
            runAt.push(i);
            const idx = run.length - 1;
            for (const id of a.toolCallIds)
                pending.set(id, idx);
            continue;
        }
        run.push(a);
        runAt.push(i);
    }
    closeRun();
    const merged = new Set();
    for (const s of spans)
        for (const l of s.constraintLines)
            merged.add(l);
    return {
        spans,
        poolChars: spans.reduce((n, s) => n + s.poolChars, 0),
        watermark: opts.watermark,
        constraintLines: [...merged],
    };
}
