import { sessionEvents } from './log-access.js';
/**
 * 增量维护被遮蔽 surface seq 集合：事件日志只追加，游标从上次扫描处继续，
 * 避免每次召回/剪枝都 O(事件总量) 重扫。session 切换时重置。
 */
export function shadowedSeqsOf(host, session) {
    const st = host.stateOf(session);
    if (st.shadowedSession !== session) {
        st.shadowedSession = session;
        st.shadowedSet = new Set();
        st.shadowedScanned = 0;
    }
    for (let index = st.shadowedScanned; index < session.seq; index += 1) {
        const event = sessionEvents(session)[index];
        if (event === undefined)
            continue;
        // 权威剪枝账本：只认 compaction/prune 事件（pruneIntervals 每次真剪枝必发，
        // 且 shadowedSeqs 即被剪 surface seq 的权威清单）。不再靠「replace 形态推断」：
        // 旧实现扫 surfaceOp replace 并把 sourceEventSeqs 收进集合，会误吞两类非剪枝写回——
        //   ① cites 剥离写回（data.argpCites，仅去协议产物）——2026-08-22 已加 argpCites 门控；
        //   ② per-atom 原地压缩（peratom/compressor.ts 的 user/tool 副本，start===end、
        //      sourceEventSeqs=[被压原子]、无 compaction/prune 事件）——2026-08-27 定位：
        //      它仍穿透旧门控被当「已剪」，导致 catalog 谎报 "Compression removed N"、
        //      system 前缀逐轮变、跨轮缓存全断（60 轮 A 臂实证）。
        // 只读 compaction/prune.shadowedSeqs 后，per-atom 原地压缩天然不在账本内，根因消除；
        // 且不再把 compaction/start、compaction/prune 这两个 off-surface 事务 seq 误收进集合。
        if (event.type === 'compaction/prune') {
            const shadowed = event.data.shadowedSeqs;
            if (Array.isArray(shadowed)) {
                for (const seq of shadowed)
                    st.shadowedSet.add(seq);
            }
        }
    }
    st.shadowedScanned = session.seq;
    return st.shadowedSet;
}
/**
 * recall 预算：单次结果与累计结果都按窗口比例截断（窗口取最近解析的有效预算）。
 *
 * P7 修复：recallCharsUsed 原本只增不减、全会话无 reset —— 累计触顶后 allowed=0，
 * 返回值退化成纯 '…(truncated)' 且不说明原因，长会话静默丢 recall。现在
 *  1) 预算耗尽时显式说明剩余额度与何时恢复（不再静默）；
 *  2) 每笔 compaction 事务成功后归零（见 pruneIntervals 末尾）。
 */
export function budgetRecallText(host, session, text) {
    if (session === null)
        return text;
    const st = host.stateOf(session);
    const perCallLimit = Math.floor(st.resolvedWindowTokens * 0.05 * host.charsPerToken);
    const totalLimit = Math.floor(st.resolvedWindowTokens * 0.10 * host.charsPerToken);
    const remaining = Math.max(0, totalLimit - st.recallCharsUsed);
    if (remaining === 0) {
        return '(recall text budget exhausted: ' + st.recallCharsUsed + '/' + totalLimit
            + ' chars used since the last compaction. Nothing was returned — this is a budget limit, '
            + 'not missing data. The budget resets on the next compaction; narrow the request or retry later.)';
    }
    const allowed = Math.min(perCallLimit, remaining);
    let result = text;
    if (result.length > allowed) {
        result = result.slice(0, allowed) + '…(truncated at ' + allowed + ' chars; recall budget '
            + (st.recallCharsUsed + allowed) + '/' + totalLimit
            + ' chars used since the last compaction, resets on the next one)';
    }
    st.recallCharsUsed += result.length;
    return result;
}
