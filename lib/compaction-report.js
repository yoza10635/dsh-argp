/**
 * 用户可见的压缩回执文案（2026-11-27）。
 *
 * 原则：`compaction/summary.summary[].text` 会直接显示在会话 UI 的压缩节点上，读它的人
 * 是「装了插件的普通用户」，不是插件开发者。所以这里**只说人话**：
 *  - 不出现 §编号、墓碑、surface、原子、sourceEventSeqs、0-LLM 之类内部术语；
 *  - 数字统一走「万 / 千 / 个 token」，不给人看裸的 5-6 位数；
 *  - 永远带上「原文还在、可以逐字找回」这句——这是用户真正关心的安全感。
 *
 * 开发者要的精确口径（surface 记账 / 历史体量 / 区间数）留在 `host.log.info` 的 debug 行，
 * 不进 UI。
 */
import { rawEventFaces } from './log-access.js';
import { countCjkChars, estTokensFromStats } from './cjk.js';
/** token 数的用户可读格式：>=1 万用「万」，>=1 千用「千」，否则原数。 */
export function formatTokenCount(n) {
    const v = Math.max(0, Math.round(n));
    if (v >= 10_000)
        return (v / 10_000).toFixed(1) + ' 万 token';
    if (v >= 1_000)
        return (v / 1_000).toFixed(1) + ' 千 token';
    return v + ' token';
}
/**
 * 本次从可见上下文里拿掉的 token 量（CJK 自适应估算）。
 *
 * 与宿主契约字段 `shadowedTokenCount`（被替换节点文本 ÷4）不同：这里按节点在 prompt 里的
 * 真实文本面（含 reasoning / 工具结果）估算，中文不再被 4 字/token 低估，所以更接近用户
 * 在「上下文使用量」上看到的下降。
 */
export function estimateSurfaceRelease(session, seqs) {
    let chars = 0;
    let cjk = 0;
    const seen = new Set();
    for (const seq of seqs) {
        if (seen.has(seq))
            continue;
        seen.add(seq);
        for (const face of rawEventFaces(session, seq)) {
            chars += face.text.length;
            cjk += countCjkChars(face.text);
        }
    }
    return Math.ceil(estTokensFromStats(chars, cjk));
}
/**
 * 压缩回执的用户文案。四种事务各一句，句式统一为
 * 「做了什么 + 省了多少 + 原文还在」。
 */
export function compactionSummaryText(kind, stats) {
    const amount = formatTokenCount(stats.releaseTokens);
    switch (kind) {
        case 'tombstone-merge':
            return `已整理压缩记录：把 ${stats.count} 条旧标记合并成 ${stats.intervals} 条（约再省 ${amount}）。原文仍在日志里，需要时可逐字找回。`;
        case 'factor-prose':
            return `已浓缩 ${stats.count} 段早期对话（约释放 ${amount}）。原文仍在日志里，需要时可逐字找回。`;
        case 'graph-prune':
            return `已压缩 ${stats.count} 处历史（约释放 ${amount}）。原文仍在日志里，需要时可逐字找回。`;
        case 'factor-prune':
        default:
            return `已压缩 ${stats.count} 处工具调用历史（约释放 ${amount}）。原文仍在日志里，需要时可逐字找回。`;
    }
}
/** 开发者 debug 行（host.log.info）：保留精确口径，不进 UI。 */
export function compactionDebugLine(kind, stats, extra) {
    return '[argp] compaction ' + kind
        + `: nodes=${stats.count} intervals=${stats.intervals}`
        + ` surface_release_est=${stats.releaseTokens} host_shadow_tokens=${extra.shadowedTokenCount}`
        + ` history_tokens=${extra.historyTokens} history_chars=${extra.historyChars} origin_events=${extra.originEvents}`;
}
