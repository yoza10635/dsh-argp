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
        st.shadowedPending = null;
    }
    for (let index = st.shadowedScanned; index < session.seq; index += 1) {
        const event = sessionEvents(session)[index];
        if (event === undefined)
            continue;
        // 权威剪枝账本：只认 compaction/prune 事件（pruneIntervals 每次真剪枝必发，
        // 且 shadowedSeqs 即被剪 surface seq 的权威清单）。不再靠「replace 形态推断」：
        // 旧实现扫 surfaceOp replace 并把 sourceEventSeqs 收进集合，会误吞两类非剪枝写回——
        //   ① cites 剥离写回（data.argpCites，仅去协议产物）——2026-08-22 已加 argpCites 门控；
        //   ② per-atom 原地压缩副本（1.x 三管线产物，start===end、
        //      sourceEventSeqs=[被压原子]、无 compaction/prune 事件）——2026-08-27 定位：
        //      它仍穿透旧门控被当「已剪」，导致 catalog 谎报 "Compression removed N"、
        //      system 前缀逐轮变、跨轮缓存全断（60 轮 A 臂实证）。
        // 只读 compaction/prune.shadowedSeqs 后，per-atom 原地压缩天然不在账本内，根因消除；
        // 且不再把 compaction/start、compaction/prune 这两个 off-surface 事务 seq 误收进集合。
        if (event.type === 'compaction/start') {
            st.shadowedPending = [];
            continue;
        }
        if (event.type === 'compaction/prune') {
            const shadowed = event.data.shadowedSeqs;
            if (!Array.isArray(shadowed))
                continue;
            if (st.shadowedPending === null)
                for (const seq of shadowed)
                    st.shadowedSet.add(seq);
            else
                st.shadowedPending.push(...shadowed);
            continue;
        }
        if (event.type === 'compaction/end' && st.shadowedPending !== null) {
            const errored = event.data.error !== undefined;
            if (!errored)
                for (const seq of st.shadowedPending)
                    st.shadowedSet.add(seq);
            st.shadowedPending = null;
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
 *  2) 每笔 compaction 事务成功后归零（见 pruneIntervals 末尾）；
 *  3) 2026-11-14 用户裁定：**跨轮也重置**——T44 措辞实验实锤 73,400/73,400 用尽后
 *     同轮后续召回全部空手、模型放弃核对原文；轮变即归零（recallBudgetTurn 游标），
 *     压缩归零保留（双保险，语义一致）。
 */
/**
 * 召回预算读数（装配式 full 视图用，2026-11-14）：**纯读**——只做与 budgetRecallText
 * 相同的惰性轮变归零，不写 recallCharsUsed。对抗审查 B 项四不变量之一：装配侧与钳位侧
 * 必须看到同一预算快照，否则同一回复前后自相矛盾（装配判耗尽、钳位却放行）。
 */
export function recallBudgetState(host, session) {
    if (session === null)
        return { perCallLimit: Number.MAX_SAFE_INTEGER, remaining: Number.MAX_SAFE_INTEGER, totalLimit: Number.MAX_SAFE_INTEGER };
    const st = host.stateOf(session);
    syncBudgetTurn(host, session);
    const perCallLimit = Math.floor(st.resolvedWindowTokens * 0.05 * host.charsPerToken);
    const totalLimit = Math.floor(st.resolvedWindowTokens * 0.10 * host.charsPerToken);
    return { perCallLimit, remaining: Math.max(0, totalLimit - st.recallCharsUsed), totalLimit };
}
function syncBudgetTurn(host, session) {
    const st = host.stateOf(session);
    const turn = currentTurnOf(session);
    if (st.recallBudgetTurn !== turn) {
        st.recallBudgetTurn = turn;
        st.recallCharsUsed = 0;
    }
}
export function budgetRecallText(host, session, text) {
    if (session === null)
        return text;
    const st = host.stateOf(session);
    syncBudgetTurn(host, session);
    const perCallLimit = Math.floor(st.resolvedWindowTokens * 0.05 * host.charsPerToken);
    const totalLimit = Math.floor(st.resolvedWindowTokens * 0.10 * host.charsPerToken);
    const remaining = Math.max(0, totalLimit - st.recallCharsUsed);
    if (remaining === 0) {
        return '(recall text budget exhausted: ' + st.recallCharsUsed + '/' + totalLimit
            + ' chars used this turn. Nothing was returned — this is a budget limit, '
            + 'not missing data. The budget resets next turn; narrow the request or retry then.)';
    }
    const allowed = Math.min(perCallLimit, remaining);
    let result = text;
    if (result.length > allowed) {
        result = result.slice(0, allowed) + '…(truncated at ' + allowed + ' chars; recall budget '
            + (st.recallCharsUsed + allowed) + '/' + totalLimit
            + ' chars used this turn, resets next turn)';
    }
    st.recallCharsUsed += result.length;
    return result;
}
/** 当前轮号（日志尾向前找最近 turn/start；找不到 = 0）——预算重置与召回安全阀共用。 */
export function currentTurnOf(session) {
    const events = sessionEvents(session);
    for (let i = events.length - 1; i >= 0; i -= 1) {
        const e = events[i];
        if (e === undefined || e.type !== 'turn/start')
            continue;
        const t = e.data?.turn;
        return typeof t === 'number' ? t : 0;
    }
    return 0;
}
