/**
 * Token 本体（PROPOSAL-token-ontology.md，v1.2.0 组件 A/B 共享地基）：
 * 承重 token 词表是**一套词表、两种机制**的唯一事实源——
 *
 *  1. **原子内保真**（fidelityGuard）：peratom 压缩副本必须 verbatim 存活原文的高信号
 *     token（extract 硬拒 / summary 审计）——自 v1.0.0 起存在于 gate.ts，本文件将其提升
 *     为共享叶子模块（gate.ts 改 re-export，既有 import 路径不变）。
 *  2. **原子间推断边**（deriveInferredEdges）：较新的 A 原子**逐字包含**较旧数据原子
 *     （U/R）的承重 token → 派生 `inferred` 语义边（0 LLM，建图期完成）。当模型声明
 *     通道（回复级 cites / CiteDeclarer）空窗时，选择性由构造恢复——保护集只增不减，
 *     错误方向仍只往"少剪"错（与版本链硬排除同一保守哲学）。
 *
 * 本模块**零运行时依赖**（纯函数 + 词表），与 cites-strip.ts 同纪律：
 * 引擎（Stage-2）与 peratom（Stage-1）双向引用都不产生模块环。
 */
// ---------------------------------------------------------------------------
// 词表（自 gate.ts 原样迁移；保真守卫与推断边共用同一口径）
// ---------------------------------------------------------------------------
/**
 * 承重 token 模式集（spike 34 实证驱动：本地模型对 ALL-CAPS 错误码保真完美，
 * 但对 file:line 定位与 key=value 分隔符会不自觉改写）。
 */
export const LOAD_BEARING_PATTERNS = [
    /https?:\/\/\S+/g, // URL
    /\/?\b[\w.@-]+(?:\/[\w.@-]+)+\.\w{1,8}\b/g, // 带扩展名的路径（绝对或相对，含前导斜杠）
    /\b[\w-]+\.\w{1,8}:\d+(?::\d+)?\b/g, // file:line[:col] 行号定位
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, // UUID
    /\b[a-f0-9]{32,64}\b/gi, // 十六进制哈希
    /\b[A-Z][A-Z0-9_]{4,}\b/g, // ALL_CAPS 错误码
    /\b[A-Za-z][\w-]{1,28}=[^\s,;'"]{2,}/g, // key=value（保留原分隔符）
];
/** 提取原文中必须在压缩副本里 verbatim 存活的高信号 token（去重）。 */
export function findLoadBearingTokens(text) {
    const out = new Set();
    for (const re of LOAD_BEARING_PATTERNS) {
        re.lastIndex = 0;
        let m = re.exec(text);
        while (m !== null) {
            const tok = m[0].replace(/[.,;)\]}'"]+$/, '');
            if (tok.length >= 4)
                out.add(tok);
            if (m.index === re.lastIndex)
                re.lastIndex += 1; // 防零宽匹配死循环
            m = re.exec(text);
        }
    }
    return [...out];
}
/** 守卫裁决：missing 非空 = 该副本不得按原样落盘（原文保面 / HLS 修复，由调用方选档）。 */
export function fidelityGuard(originalText, compressedText) {
    const missing = findLoadBearingTokens(originalText).filter(tok => !compressedText.includes(tok));
    return { ok: missing.length === 0, missing };
}
// ---------------------------------------------------------------------------
// 组件 B：HLS 修复档（hard-lossless / soft-lossy，PROPOSAL §3）
// ---------------------------------------------------------------------------
/**
 * HLS 尾注修复（构造性 100% 硬 token 保真）：
 * 模型候选文本 + 守卫缺失清单按原文顺序逐字补全。
 *
 *  - 只**追加**原文 token、不重写模型 prose、不删 candidate 任何字符（I-B3）；
 *  - 对任意 candidate，`fidelityGuard(original, repaired)` 平凡通过（I-B1，
 *    构造性：缺失清单恰为原文承重 token 在 candidate 中的补集）；
 *  - prose 有损性等同 summary 档的受控损失，但**硬 token 零损失**——
 *    填补现有两档（extract=软无损+硬无损 / summary=软有损+硬有损）之间的缺格。
 *
 * `missing` 空 = 候选已全含（此时调用方根本不会走到修复档，此处防御性返回原文）。
 *
 * 注意：本函数是**无条件的构造性修复**，不含经济学判断。是否值得修复由调用方
 * 经 `hlsRepairEconomics(...).accept` 门控决定（见下）——值不值不是构造的问题。
 */
export function repairWithTrailer(candidate, missing) {
    return candidate + trailerText(missing);
}
// ---------------------------------------------------------------------------
// 组件 B 经济学门控（第一性判据：候选的 prose 收益 > 缺失 handle 的补全代价）
// ---------------------------------------------------------------------------
/** 尾注文本（长度口径的唯一事实源：`repairWithTrailer` 与门控共用，保证两者不分叉）。 */
export function trailerText(missing) {
    return missing.length === 0 ? '' : '\n[restored] ' + missing.join(' ');
}
/**
 * 默认 ROI 门槛 θ = 1：净释放预算必须 ≥ 尾注占用，修复才放行。
 *
 * 记 L_orig / L_cand / L_rep 为原文 / 候选 / 修复文本长度：
 *  - 增益 B = L_orig − L_cand（候选 prose 相对原文省下的字符）；
 *  - 代价 C = L_rep − L_cand（尾注占用 = `'\n[restored] ' + missing.join(' ')`）；
 *  - 净释放 N = L_orig − L_rep = B − C（相对「原文保面」的预算净释放，可负）；
 *  - **ROI = N / C**。
 *
 * θ=1 的语义是「尾注替自己买单」：净释放的预算至少与尾注占用相当。
 * N < 0（修复后比原文还长）必然被拒——这正是 spike39 实测的 F1/F4 区间
 * （ROI 0.02 / 0.07，修复后 2.05× 于候选、几乎退化为原文保面）。
 * 被拒即退回 v1.1「原文保面」，错误方向仍只往「少压」错。
 *
 * **这是 HLS 原先缺失的代价盲修正**：修复档此前无论值不值一律补全。
 */
export const DEFAULT_HLS_ROI_THRESHOLD = 1;
/**
 * HLS 修复档的代价—收益核算（纯函数，0 依赖）。调用方以 `accept` 决定「修复」或「回退原文」。
 * `missing` 空（C = 0）→ ROI = +∞、accept = true（防御性：调用方只在守卫失败、missing 非空时进入）。
 */
export function hlsRepairEconomics(originalLength, candidateLength, missing, threshold = DEFAULT_HLS_ROI_THRESHOLD) {
    const trailerCost = trailerText(missing).length;
    const proseGain = originalLength - candidateLength;
    const netRelease = proseGain - trailerCost;
    const roi = trailerCost === 0 ? Number.POSITIVE_INFINITY : netRelease / trailerCost;
    return { proseGain, trailerCost, netRelease, roi, accept: roi >= threshold };
}
const DEFAULTS = { minTokenLen: 6, stopwordRatio: 0.15, maxEdgesPerAtom: 8, windowTurns: 20 };
/**
 * 派生推断边（纯函数，0 LLM，I-A2）：
 * 对每个窗口内的 A 原子，取其承重 token（≥minTokenLen、非停词）逐字命中的**更旧**
 * 数据原子（U/R，seq 严格更小）为候选目标；每 A 至多 maxEdgesPerAtom 条
 * （多目标时 seq 降序——最近的原子最可能是实际参照）。
 *
 * 不变式 I-A1（构造性）：每条返回的 (fromSeq, toSeq) 都存在某 token t，
 * t ∈ tokens(A_from.text) 且 t 逐字 ⊆ R/U_to.text。
 *
 * 确定性：同输入必同输出（token 集去重后按原文出现序、候选按 seq 排序）。
 */
export function deriveInferredEdges(atoms, opts = {}) {
    const minTokenLen = opts.minTokenLen ?? DEFAULTS.minTokenLen;
    const stopwordRatio = opts.stopwordRatio ?? DEFAULTS.stopwordRatio;
    const maxEdgesPerAtom = opts.maxEdgesPerAtom ?? DEFAULTS.maxEdgesPerAtom;
    const windowTurns = opts.windowTurns ?? DEFAULTS.windowTurns;
    if (atoms.length === 0)
        return [];
    // 每原子承重 token 集合（词表口径；长度过滤后）。
    const tokensOf = new Map();
    let latestTurn = 0;
    for (const a of atoms) {
        if (a.turn > latestTurn)
            latestTurn = a.turn;
        const set = new Set();
        for (const t of findLoadBearingTokens(a.text)) {
            if (t.length >= minTokenLen)
                set.add(t);
        }
        tokensOf.set(a.seq, set);
    }
    // 停词表：token 出现的原子数 / 原子总数 > stopwordRatio → 不派生边。
    const tokenAtomCount = new Map();
    for (const set of tokensOf.values()) {
        for (const t of set)
            tokenAtomCount.set(t, (tokenAtomCount.get(t) ?? 0) + 1);
    }
    const stopwords = new Set();
    for (const [t, count] of tokenAtomCount) {
        if (count / atoms.length > stopwordRatio)
            stopwords.add(t);
    }
    // 数据原子（U/R）倒排：token → 含该 token 的原子索引（停词不入索引）。
    const dataAtomIndices = [];
    const inverted = new Map();
    for (let i = 0; i < atoms.length; i += 1) {
        const a = atoms[i];
        if (a.type !== 'U' && a.type !== 'R')
            continue;
        dataAtomIndices.push(i);
        for (const t of tokensOf.get(a.seq) ?? []) {
            if (stopwords.has(t))
                continue;
            const list = inverted.get(t);
            if (list === undefined)
                inverted.set(t, [i]);
            else
                list.push(i);
        }
    }
    const out = [];
    const seen = new Set();
    for (let i = 0; i < atoms.length; i += 1) {
        const a = atoms[i];
        if (a.type !== 'A')
            continue;
        // 声明窗口：仅近 windowTurns 轮的 A 作边源（CiteDeclarer 10 轮的 2 倍余量）。
        if (a.turn <= latestTurn - windowTurns)
            continue;
        const picked = new Set();
        // 候选按 (命中 token, seq 降序) 枚举：同目标多 token 命中去重后保留最近者在前。
        const candidates = [];
        for (const t of tokensOf.get(a.seq) ?? []) {
            if (stopwords.has(t))
                continue;
            for (const j of inverted.get(t) ?? []) {
                if (atoms[j].seq >= a.seq)
                    continue; // 只连更旧的数据原子
                if (picked.has(j))
                    continue;
                picked.add(j);
                candidates.push(j);
            }
        }
        // seq 降序（最近的参照优先）+ 上限截断；候选枚举序本身是确定的（倒排按原子序）。
        candidates.sort((x, y) => atoms[y].seq - atoms[x].seq);
        for (const j of candidates.slice(0, maxEdgesPerAtom)) {
            const key = a.seq + '\u0000' + atoms[j].seq;
            if (seen.has(key))
                continue;
            seen.add(key);
            out.push({ fromSeq: a.seq, toSeq: atoms[j].seq });
        }
    }
    return out;
}
