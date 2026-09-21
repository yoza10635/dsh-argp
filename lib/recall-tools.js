import { defineTool } from '@deepseek-ai/dsh-tools';
import { eventText, formatLogRow, formatRecallOutcome, queryLogRange, recallFromLog, sessionEvents, stateHeader } from './log-access.js';
import { classifyUserMessage } from './graph-build.js';
import { pushBounded } from './telemetry.js';
/**
 * 注册三个召回工具到 ctx.tools。构造器在原先内联定义工具的位置调用本函数，
 * 保持 register 调用顺序逐字不变。
 */
export function registerRecallTools(ctx, host) {
    const recallTool = defineTool({
        name: 'recall_pruned',
        description: 'Retrieve the original text of any conversation node by its log seq, whether or not it is still in your visible context (text blocks verbatim; tool-call arguments are a JSON semantic-equivalent reconstruction when the host stores them as an object — the reply says so). Call it when your answer depends on content behind an [elided seq=N..M ...] placeholder, or when an earlier value is absent from the visible context. Pass one seq per call. The reply is prefixed with [recall seq=N state=shadowed|live|off-surface] so you know whether that content is currently visible. Everything ever said stays in the append-only log; never guess it. Use list_pruned (including its fromSeq/toSeq range mode) when you do not know the seq.',
        parameters: { seq: { type: 'integer', description: 'log seq of the node to recover; placeholders show the seqs they replaced' } },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
        },
        execute: async (args) => {
            const seq = args.seq;
            if (seq === undefined || host.session === null)
                return 'recall_pruned: no session bound';
            if (host.recallCallsThisTurn >= 3)
                return 'recall_pruned: per-turn budget exceeded (3 calls)';
            host.recallCallsThisTurn += 1;
            // P1 修复 (b)：不再用 shadowedSeqsOf 门控。数据路径本来就是全日志级的
            // （eventText 直接索引 sessionEvents(session)[seq]），只有越界才算失败；返回值带状态标签，
            // 使掉出可见上下文但未被 ARGP 替换的节点（适配器窗口丢弃 / 从不进 surface）也可召回。
            const shadowed = host.shadowedSeqsOf(host.session);
            const outcome = recallFromLog(host.session, seq, s => shadowed.has(s), eventText);
            pushBounded(host.recallCalls, { seq, hit: outcome.ok, state: outcome.ok ? outcome.state : undefined }, host.telemetryCap);
            if (!outcome.ok)
                return formatRecallOutcome('recall_pruned', seq, outcome);
            host.noteRecallHit(seq);
            // 版本链重定向（2026-08-23）：被剪旧 R 若属于某路径版本链，重定向返回该路径最新存活版本原文，
            // 替代旧值。避免模型基于已过时的旧快照做决定（旧值正是被剪的原因）；文件仍在演进时
            // 模型要的是「现在长什么样」。保留 state 标签说明这是重定向结果。
            const redirect = host.prunedNodeIndex.get(seq)?.latestOfPath;
            if (redirect !== undefined && redirect !== seq) {
                const latestOutcome = recallFromLog(host.session, redirect, s => shadowed.has(s), eventText);
                if (latestOutcome.ok) {
                    const result = stateHeader(seq, latestOutcome.state)
                        + '\n[version-chain redirect: seq ' + seq + ' was superseded by newer version seq ' + redirect + ' of the same path; returning the latest]\n'
                        + host.budgetRecallText(latestOutcome.text);
                    host.recallSourceSeq = seq;
                    host.recallResultSeq = host.session.seq;
                    return result;
                }
            }
            const result = formatRecallOutcome('recall_pruned', seq, outcome, text => host.budgetRecallText(text));
            // §3-3 recall 价值继承：记录"旧原子 seq → 本次 recall 结果将被 append 为的新 R 原子 seq"。
            // dsh 在工具 execute 返回后 append tool/result 事件，其 seq = 当前事件总数。
            host.recallSourceSeq = seq;
            host.recallResultSeq = host.session.seq;
            return result;
        },
    });
    ctx.tools.register(recallTool);
    const listPrunedTool = defineTool({
        name: 'list_pruned',
        description: 'List conversation nodes that are no longer in your visible context, so you can find the seq to pass to recall_pruned. Default mode lists nodes pruned by ARGP. Range mode (pass fromSeq/toSeq) scans the raw append-only log over that seq window and reports every node with text, including nodes that are still on the surface but may have fallen outside the model render window — use it when a placeholder does not mention the seq you need. Each line carries seq, type, turn, state (shadowed/live/off-surface) and a first-line preview. Optional filters: turn, type (A/R/U/X/T), keyword, limit.',
        parameters: {
            turn: { type: 'integer', description: 'optional exact turn number filter' },
            type: { type: 'string', description: 'optional node type filter: A (assistant), R (tool result), U (user), X (checkpoint), T (tool call, range mode only)' },
            keyword: { type: 'string', description: 'optional substring that must appear in the node text' },
            fromSeq: { type: 'integer', description: 'optional range-mode start seq (inclusive); enables raw-log scanning instead of the pruned-only list' },
            toSeq: { type: 'integer', description: 'optional range-mode end seq (inclusive); defaults to the newest event when only fromSeq is given' },
            limit: { type: 'integer', description: 'optional maximum number of lines to return (default 50 in range mode, capped at 200)' },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
        },
        execute: async (args) => {
            if (host.session === null)
                return 'list_pruned: no session bound';
            const shadowed = host.shadowedSeqsOf(host.session);
            const filters = (args ?? {});
            // P1 修复 (b) 的另一半：区间模式 = 发现原语。去门控只解决"知道 seq 就能取"，
            // 掉出渲染窗口的 live 节点没有 tombstone 也不带 seq，模型需要能按区间查全日志补集。
            if (filters.fromSeq !== undefined || filters.toSeq !== undefined) {
                const total = host.session.seq;
                const limit = Math.max(1, Math.min(200, filters.limit ?? 50));
                const range = queryLogRange(host.session, {
                    fromSeq: filters.fromSeq ?? 0,
                    toSeq: filters.toSeq ?? total - 1,
                    turn: filters.turn,
                    type: filters.type,
                    keyword: filters.keyword,
                    limit,
                }, s => shadowed.has(s), eventText);
                if (range.rows.length === 0) {
                    return 'list_pruned (range mode): no node with text in seq '
                        + (filters.fromSeq ?? 0) + '..' + (filters.toSeq ?? total - 1) + ' matches the filters';
                }
                const header = 'list_pruned (range mode): ' + range.rows.length + ' node(s) in seq '
                    + (filters.fromSeq ?? 0) + '..' + (filters.toSeq ?? total - 1)
                    + ' (log has ' + total + ' events; state=shadowed means ARGP pruned it, '
                    + 'live means still on the surface, off-surface means log-only)'
                    + (range.truncated ? '; output capped at limit=' + limit + ', narrow the range or raise limit' : '');
                const rangeLines = range.rows.map(row => {
                    const indexed = host.prunedNodeIndex.get(row.seq);
                    const citedBy = indexed !== undefined && indexed.citedBySeq.length > 0
                        ? ' citedBy=' + indexed.citedBySeq.join(',')
                        : '';
                    return formatLogRow(row, citedBy);
                });
                return header + '\n' + rangeLines.join('\n');
            }
            const lines = [];
            const seqs = [...shadowed].sort((a, b) => a - b);
            for (const seq of seqs) {
                const event = sessionEvents(host.session)[seq];
                if (event === undefined)
                    continue;
                const data = event.data;
                const turn = typeof data?.turn === 'number' ? data.turn : 0;
                if (filters.turn !== undefined && turn !== filters.turn)
                    continue;
                let type;
                if (event.type === 'user/message') {
                    type = classifyUserMessage(data);
                }
                else if (event.type === 'assistant/message') {
                    type = 'A';
                }
                else if (event.type === 'tool/result') {
                    type = 'R';
                }
                else {
                    type = 'X';
                }
                if (filters.type !== undefined && type !== filters.type)
                    continue;
                const text = eventText(host.session, seq);
                if (filters.keyword !== undefined && !text.includes(filters.keyword))
                    continue;
                const firstLine = text.split('\n').map(l => l.trim()).find(l => l !== '') ?? '';
                const preview = firstLine.length > 120 ? firstLine.slice(0, 120) + '…' : firstLine;
                const indexed = host.prunedNodeIndex.get(seq);
                const citedBy = indexed !== undefined && indexed.citedBySeq.length > 0
                    ? ' citedBy=' + indexed.citedBySeq.join(',')
                    : '';
                lines.push('seq=' + seq + ' type=' + type + ' turn=' + turn + ' state=shadowed' + citedBy + ' first=' + preview);
            }
            if (lines.length === 0) {
                return 'list_pruned: no pruned node matches the filters. '
                    + 'If the content you need was never replaced by a placeholder, retry with range mode '
                    + '(fromSeq/toSeq) to scan the raw log window.';
            }
            return lines.join('\n');
        },
    });
    ctx.tools.register(listPrunedTool);
    const recallQueryTool = defineTool({
        name: 'recall',
        description: 'Search nodes that are no longer in your visible context by content query and return matching original text. Use when you know roughly what was said but not the exact seq. Prefer list_pruned when you can identify by turn/type or by seq range, and recall_pruned(seq) when you already know the seq.',
        parameters: {
            query: { type: 'string', description: 'keywords or substring to search in content that left the visible context' },
            maxResults: { type: 'integer', description: 'optional maximum number of matches to return (default 5)' },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
        },
        execute: async (args) => {
            if (host.session === null)
                return 'recall: no session bound';
            if (host.recallCallsThisTurn >= 3)
                return 'recall: per-turn budget exceeded (3 calls)';
            host.recallCallsThisTurn += 1;
            const query = args.query ?? '';
            const maxResults = args.maxResults ?? 5;
            return host.budgetRecallText(host.recallQuery(query, maxResults));
        },
    });
    ctx.tools.register(recallQueryTool);
}
