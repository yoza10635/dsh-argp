import { isArgpUserInfo } from './peratom/types.js';
/**
 * 跨宿主版本兼容的事件日志读取（P1 → 1.0.2 升级阻断修复）。
 *
 * dsh 0.1.2-alpha.4 的 breaking 重构 `27bf1039db refactor(session)!: distinguish
 * event seqs from log offsets` 移除了 `Session.events` getter（运行时 `undefined`），
 * 替代为 `snapshotEvents()`（frozen 全日志快照）/ `eventAt(seq)`。rc.2 仍有 `events`
 * getter。为同时兼容两个宿主，本 helper 运行时探测：
 *
 *   - 宿主 Session 提供 `snapshotEvents`（alpha.4+）→ 调 `snapshotEvents()`
 *   - 否则回退到 legacy `session.events`（rc.2）
 *
 * 两个路径都返回 frozen 数组，语义完全一致（不可变、与后续 append 解耦）。
 * 本 helper 是 ARGP 全代码库唯一允许直接触碰"事件日志"的入口——任何新增
 * `session.events[...]` / `for ... of session.events` 都视为违规。
 */
export function sessionEvents(session) {
    const modern = session.snapshotEvents;
    if (typeof modern === 'function')
        return modern.call(session);
    const legacy = session.events;
    if (legacy !== undefined)
        return legacy;
    throw new Error('dsh-argp: session exposes neither events nor snapshotEvents; check dsh version compatibility');
}
/**
 * 全日志扫描收集被遮蔽 surface seq（权威剪枝账本：compaction/prune.shadowedSeqs 的并集）。
 *
 * 2026-08-27：与 ArgpGraphEngine.shadowedSeqsOf 对齐——只认 compaction/prune 事件
 * （pruneIntervals 每次真剪枝必发，shadowedSeqs 即被剪 seq 权威清单）。此前靠
 * 「replace 形态推断」（任何 surfaceOp replace 的 sourceEventSeqs 都算 shadowed），
 * 会把 per-atom 原地压缩（peratom/compressor.ts 的副本，无 compaction/prune 事件）误判为
 * shadowed，导致 recall_summary/recall_detail 对压缩原子谎报 state=shadowed（同一反模式的
 * 第二条路径，且连 argpCites 门控都没有，比 shadowedSeqsOf 更激进）。
 */
export function scanShadowedSeqs(session) {
    const shadowed = new Set();
    for (const event of sessionEvents(session)) {
        if (event.type !== 'compaction/prune')
            continue;
        const seqs = event.data.shadowedSeqs;
        if (Array.isArray(seqs)) {
            for (const seq of seqs)
                shadowed.add(seq);
        }
    }
    return shadowed;
}
/** 判定单个 seq 的状态。shadowed 优先（被遮蔽的节点也可能仍留在 surface 索引之外）。 */
export function nodeStateOf(session, seq, isShadowed) {
    if (isShadowed(seq))
        return 'shadowed';
    for (const node of session.surface.nodes) {
        if (node === seq)
            return 'live';
    }
    return 'off-surface';
}
/**
 * 按 seq 从 append-only 日志取回原文，不再要求节点属于 pruned 集合。
 * 只有越界（日志里没有这个 seq）才算失败。
 */
export function recallFromLog(session, seq, isShadowed, textOf) {
    const total = session.seq;
    if (!Number.isInteger(seq) || seq < 0 || seq >= total || sessionEvents(session)[seq] === undefined) {
        return { ok: false, reason: 'out-of-range', total };
    }
    const state = nodeStateOf(session, seq, isShadowed);
    const text = textOf(session, seq);
    if (text === '')
        return { ok: false, reason: 'no-text', state };
    return { ok: true, state, text };
}
const STATE_HINT = {
    shadowed: 'pruned from the visible context by ARGP',
    live: 'still on the conversation surface, but it may sit outside the model render window',
    'off-surface': 'log-only node, never part of the rendered conversation',
};
/** 状态标签行：模型必须知道取回内容当前是否可见，才能正确执行引用契约。 */
export function stateHeader(seq, state) {
    return '[recall seq=' + seq + ' state=' + state + '] (' + STATE_HINT[state] + '; cite it if your answer uses it)';
}
/** 把 RecallOutcome 渲染成工具返回文本。budget 用于对正文套字数预算。 */
export function formatRecallOutcome(toolName, seq, outcome, budget = t => t) {
    if (outcome.ok)
        return stateHeader(seq, outcome.state) + '\n' + budget(outcome.text);
    if (outcome.reason === 'out-of-range') {
        return toolName + ': seq ' + seq + ' is out of range (log has ' + outcome.total
            + ' events, valid seq 0..' + Math.max(0, outcome.total - 1) + ')';
    }
    return toolName + ': seq ' + seq + ' (state=' + outcome.state + ') exists in the log but carries no model-visible text';
}
export function logRowType(eventType, data) {
    if (eventType === 'user/message') {
        // P0 分类陷阱防线：U-info 聚合副本（data[argp].info）按 U 展示，先于 plugin-source → X 判定
        if (isArgpUserInfo(data))
            return 'U';
        return data?.source?.kind === 'plugin' ? 'X' : 'U';
    }
    if (eventType === 'assistant/message')
        return 'A';
    if (eventType === 'tool/result')
        return 'R';
    if (eventType === 'tool/call')
        return 'T';
    return 'other';
}
/**
 * 区间发现原语：列出 [fromSeq..toSeq] 内所有有正文的日志节点（含 live / off-surface）。
 * 这是 (b) 里容易被漏掉的一半 —— 去门控只解决"知道 seq 就能取"，区间模式解决
 * "模型怎么知道被窗口丢掉的节点的 seq"，把 list 从「剪枝清单」升级为「可见窗口补集查询」。
 */
export function queryLogRange(session, query, isShadowed, textOf) {
    const total = session.seq;
    const events = sessionEvents(session);
    const from = Math.max(0, Math.min(query.fromSeq, total - 1));
    const to = Math.max(from, Math.min(query.toSeq, total - 1));
    const rows = [];
    let scanned = 0;
    let truncated = false;
    for (let seq = from; seq <= to; seq += 1) {
        const event = events[seq];
        if (event === undefined)
            continue;
        scanned += 1;
        const data = event.data;
        const type = logRowType(event.type, data);
        if (query.type !== undefined && type !== query.type)
            continue;
        const turn = typeof data?.turn === 'number' ? data.turn : 0;
        if (query.turn !== undefined && turn !== query.turn)
            continue;
        const text = textOf(session, seq);
        if (text === '')
            continue;
        if (query.keyword !== undefined && !text.includes(query.keyword))
            continue;
        if (rows.length >= query.limit) {
            truncated = true;
            break;
        }
        const firstLine = text.split('\n').map(l => l.trim()).find(l => l !== '') ?? '';
        rows.push({
            seq,
            type,
            turn,
            state: nodeStateOf(session, seq, isShadowed),
            firstLine: firstLine.length > 120 ? firstLine.slice(0, 120) + '…' : firstLine,
        });
    }
    return { rows, scanned, truncated };
}
export function formatLogRow(row, extra = '') {
    return 'seq=' + row.seq + ' type=' + row.type + ' turn=' + row.turn
        + ' state=' + row.state + extra + ' first=' + row.firstLine;
}
