/**
 * 排序规约（design-2.0 §2.3——复现算法，替代"因子清单"）：
 *
 *   第一层 硬保护 = 绝不入剪枝区间（引擎给判据位，本模块 AND 消费）；
 *   第二层起 字典序（先剪者在前）：
 *     ①可再生证明 → ②staleness 覆盖证明 → ③非焦点 → ④freshness 旧者先
 *     → ⑤size 大者先 → tie: rootSeq 升序。
 *   缺失值一律取保守档（未知 → 按不可再生/未覆盖/焦点处理）。
 *   降级链：释放仍不达目标 → 少剪 + shortfall 上报；**永不放宽判据、
 *   永不拉硬保护成员入区**。
 *
 * I-DIR 落点：释放向判据（regenerable/superseded 的"放行"）在本模块内做
 * **二次核验**——引擎注入 true 也不足以放行，还必须工具族=read 类且有 document
 * 键；注入方说谎/误标时被工具族防线拦下。保护向（hard 各位）可宽。
 */
import { READ_TOOLS } from "./tag-extract.js";
import { CLIP_MIN_SAVING_CHARS } from "./clip-shape.js";
export function computeScore(i) {
    const hard = i.hard ?? {};
    const isHard = Object.values(hard).some(v => v === true);
    // 释放向二次核验：read 类 + 有 document 键是不可绕过的下限。
    const readish = READ_TOOLS.has(i.tags.tool);
    const regenerable = i.regenerable === true && readish && i.tags.files.length > 0 ? 0 : 1;
    const superseded = i.superseded === true && readish ? 0 : 1;
    // 三值带优先；布尔回退保留 flat 现语义（undefined=保守按焦点=1）。
    const focal = i.focalBand ?? (i.focal === false ? 0 : 1);
    return {
        hard: isHard ? 1 : 0,
        regenerable,
        superseded,
        focal,
        freshness: Math.max(0, i.currentTurn - i.turn),
        size: i.tags.sizeChars,
    };
}
export const QSCORE_TAX_CHARS = 105;
export function keepProb(s) {
    const bandFactor = s.focal === 2 ? 10 : s.focal === 1 ? 4 : 1;
    const regenFactor = s.regenerable === 0 ? 0.02 : 1;
    const superFactor = s.superseded === 0 ? 0.05 : 1;
    return Math.min(1, bandFactor * regenFactor * superFactor / (1 + s.freshness));
}
export function qPriority(e) {
    const net = e.score.size - QSCORE_TAX_CHARS;
    if (net <= 0)
        return -1;
    return (1 - keepProb(e.score)) * net;
}
/** 字典序比较：负 = a 先剪。`mode='quant'`（§D）：硬保护与证明/焦点**桶门保留**
 *  （§2.3 保守档纪律不因量化让步——纯标量会无视"可再生/已覆盖"证明门），
 *  只把 ④轮龄降序+⑤size 降序 两键替换为净代价标量（age 经 keepProb 连续衰减 ×
 *  事务税摊销后的 size）——桶内「留着最贵」的单标量权衡。 */
export function compareForPrune(a, b, mode = 'lex') {
    if (mode === 'quant') {
        return a.score.hard - b.score.hard
            || a.score.regenerable - b.score.regenerable
            || a.score.superseded - b.score.superseded
            || a.score.focal - b.score.focal
            || qPriority(b) - qPriority(a)
            || a.rootSeq - b.rootSeq;
    }
    return a.score.hard - b.score.hard
        || a.score.regenerable - b.score.regenerable
        || a.score.superseded - b.score.superseded
        || a.score.focal - b.score.focal
        || b.score.freshness - a.score.freshness
        || b.score.size - a.score.size
        || a.rootSeq - b.rootSeq;
}
/**
 * 排序 + 目标释放量选择。targetReleaseChars 是**下界**（retain 目标：释放不足
 * 则爆窗），按序取到累计 ≥ 目标即止（含首个越界项——不回头少剪）。
 * 全取仍不可达 ⇒ 如实给 shortfallChars（§2.3 降级链：少剪 + 告警），
 * 硬保护成员**任何压力下都不入 pruneOrder**。
 *
 * `forcedFirstSeqs`（P6-③ 裁定 3）：强制先行段——中断轮半截 A + 孤儿工具对等协议残渣，
 * 无视目标量下次压缩必驱逐（"驱逐时机=下次压缩"）。与 soft 求交去重（同一 seq 不两段入账）。
 *
 * `clip`（C10 夹剪层，缺省关）：给出即启用三态归位——被归 clip 的成员在目标账上
 * 只按**净收益**（size − 头尾预留）累计，防"名义达标、实报欠火"；归位判据与
 * 预留量解耦（语义在此，形状归 clip-shape.ts 模板，预留经回调注入）。
 */
export function planPrune(entries, opts = {}) {
    const sizeBySeq = new Map();
    const hard = [];
    const soft = [];
    for (const e of entries) {
        sizeBySeq.set(e.rootSeq, e.score.size);
        if (e.score.hard === 1)
            hard.push(e.rootSeq);
        else
            soft.push(e);
    }
    const orderMode = opts.orderMode ?? 'lex';
    soft.sort(orderMode === 'quant' ? (a, b) => compareForPrune(a, b, 'quant') : compareForPrune);
    const target = opts.targetReleaseChars ?? Infinity;
    const forced = opts.forcedFirstSeqs ?? [];
    const forcedSet = new Set(forced);
    const clip = opts.clip;
    const taken = [];
    const clipOrder = [];
    let takenChars = 0;
    for (const seq of forced) {
        taken.push(seq);
        takenChars += sizeBySeq.get(seq) ?? 0;
    }
    for (const e of soft) {
        if (forcedSet.has(e.rootSeq))
            continue;
        let gain = e.score.size;
        if (clip !== undefined && e.score.regenerable === 1 && e.score.superseded === 1) {
            const net = e.score.size - clip.reserveCharsOf(e);
            if (net >= CLIP_MIN_SAVING_CHARS) {
                gain = net;
                clipOrder.push(e.rootSeq);
            }
        }
        taken.push(e.rootSeq);
        takenChars += gain;
        if (takenChars >= target)
            break;
    }
    return {
        pruneOrder: taken,
        hardProtected: hard.sort((a, b) => a - b),
        shortfallChars: Math.max(0, target - takenChars),
        releasedChars: takenChars,
        clipOrder,
    };
}
