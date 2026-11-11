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
/** 字典序比较：负 = a 先剪。 */
export function compareForPrune(a, b) {
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
    soft.sort(compareForPrune);
    const target = opts.targetReleaseChars ?? Infinity;
    const taken = [];
    let takenChars = 0;
    for (const e of soft) {
        taken.push(e.rootSeq);
        takenChars += e.score.size;
        if (takenChars >= target)
            break;
    }
    return {
        pruneOrder: taken,
        hardProtected: hard.sort((a, b) => a - b),
        shortfallChars: Math.max(0, target - takenChars),
        releasedChars: takenChars,
    };
}
