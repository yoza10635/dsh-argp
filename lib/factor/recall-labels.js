import { defineTool } from '@deepseek-ai/dsh-tools';
import { nodeStateOf, rawEventText } from "../log-access.js";
import { pushBounded } from "../telemetry.js";
import { VOCAB_FACETS, facetOfKey } from "./factor-ledger.js";
/**
 * 工具调用的目标会话解析（1-2）：优先 exec.agent.session（agent loop 设置，多会话/
 * 子代理宿主下逐调用正确）。回退焦点绑定**只在引擎只见过一个会话时允许**（beta.1 评审
 * D2 同族：多会话宿主下 exec.agent 缺席的静默回退会把 B 会话的上下文喂给 A 的调用；
 * 单会话宿主与无 agent 上下文的测试路径不受影响）。
 */
function sessionOfToolCall(exec, host) {
    const agent = exec?.agent;
    if (agent?.session !== undefined)
        return agent.session;
    return host.sessionCount() <= 1 ? host.session : null;
}
/**
 * 每轮召回**调用次数**上限（防循环安全阀，20）。主闸门是字符预算
 * （budgetRecallText 的 recallCharsUsed 窗口），本计数只拦病态循环。
 */
const RECALL_CALLS_PER_TURN_LIMIT = 20;
/** 裸标签（无 facet 前缀）的展开候选——查询向宽容，词表向 fail-closed 不冲突：
 *  出口渲染拦的是**进 prompt 的键**，这里放行的是**模型抄错形态的查询**。 */
const FACET_PREFIXES = ['document:', 'command:', 'errorcode:', 'scope:'];
/**
 * 召回面工具名（单一事实源）：defineTool 的 name 与 decide() 的召回对识别同源——
 * P6-③ 裁定 2：召回对（call+result）无条件进剪序（可再生=再召回一次），识别按本名单。
 */
export const RECALL_TOOL_NAMES = ['recall_history', 'list_labels'];
/**
 * 注册因子臂召回两工具。`factor` 闭包捕获引擎的**同一个** FactorEngine 实例
 * （账本/epoch 与发射侧共享，构造期装配一次）。
 */
export function registerRecallLabels(ctx, factor, host) {
    const resolveSession = (exec) => sessionOfToolCall(exec, host);
    const recallHistoryTool = defineTool({
        name: 'recall_history',
        description: 'Retrieve the original text of tool results that were pruned from your visible context, addressed by ENTITY LABEL instead of seq. Pass labels exactly as shown in a [已剪·因子 ...] stub or the vocabulary section: document:<path>, command:<family>, errorcode:<CODE> (a bare name without prefix is matched against all facets). Items matching several labels come first; within a tie, newest first. Returns originals verbatim from the append-only log under a recall budget; when more matches exist the reply ends with cursor/epoch values to pass back for the next page. This is your FIRST recall attempt in this engine — pruned content is keyed by entity, there is no seq-based recall. Use list_labels(category) to discover labels you cannot recall.',
        parameters: {
            labels: { type: 'array', items: { type: 'string' }, description: 'one or more labels to intersect, verbatim from a stub or the vocabulary (e.g. ["document:c:/proj/a.ts","errorcode:ERESOLVE"])' },
            limit: { type: 'integer', description: 'optional maximum items to return (engine-configured default when omitted, cap 20)' },
            cursor: { type: 'integer', description: 'optional continuation cursor from a previous reply (must be paired with its epoch)' },
            epoch: { type: 'integer', description: 'optional ledger epoch from a previous reply; mismatch = the ledger changed, results are re-sorted from scratch and the reply says so' },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
        },
        execute: async (args, exec) => {
            const session = resolveSession(exec);
            if (session === null)
                return 'recall_history: no session bound (multi-session host: recall requires agent context; single-session hosts bind implicitly)';
            const st = host.stateOf(session);
            if (st.recallCallsThisTurn >= RECALL_CALLS_PER_TURN_LIMIT) {
                return 'recall_history: per-turn call limit reached (' + RECALL_CALLS_PER_TURN_LIMIT
                    + ' calls). This is a loop guard, not a content limit — retrieved text is capped by a separate '
                    + 'character budget. Intersect more labels to get several items per call, or retry next turn.';
            }
            st.recallCallsThisTurn += 1;
            const a = (args ?? {});
            const wanted = [...new Set((Array.isArray(a.labels) ? a.labels : [])
                    .map(l => (typeof l === 'string' ? l.trim() : '')).filter(l => l !== ''))];
            if (wanted.length === 0) {
                return 'recall_history: pass at least one label exactly as shown in a [已剪·因子] stub or the '
                    + 'vocabulary section (document:<path> / command:<family> / errorcode:<CODE>); '
                    + 'call list_labels to see the full pruned vocabulary.';
            }
            const ledger = factor.ledger;
            const keys = new Set();
            const unknown = [];
            for (const w of wanted) {
                if (facetOfKey(w) !== null) {
                    if (ledger.stat(w) !== null)
                        keys.add(w);
                    else
                        unknown.push(w);
                    continue;
                }
                // 大小写两形都试：document 键是 canonical 小写形（盘符归一），模型手敲
                // `C:/...` 直拼查不中；errorcode 大小写敏感，只认索引里真实存在的形。
                const variants = new Set([w, w.toLowerCase()]);
                const hits = [];
                for (const v of variants)
                    for (const p of FACET_PREFIXES) {
                        const k = p + v;
                        if (ledger.stat(k) !== null)
                            hits.push(k);
                    }
                if (hits.length === 0)
                    unknown.push(w);
                else
                    for (const k of hits)
                        keys.add(k);
            }
            // 默认档 = recallLimit 旋钮（活读，volatile）；未接线时保持 P2-1 固定默认 5。
            const limit = Math.max(1, Math.min(20, a.limit ?? host.recallLimitOf?.() ?? 5));
            const q = ledger.queryPruned({ labels: [...keys], limit, cursor: a.cursor, epoch: a.epoch });
            if (q.rows.length === 0) {
                pushBounded(st.recallCalls, { seq: -1, hit: false }, host.telemetryCap);
                return 'recall_history: no pruned item matches (' + wanted.join(', ') + ')'
                    + (unknown.length > 0 ? ' — labels not in the pruned ledger, ignored: ' + unknown.join(', ') : '')
                    + '. The ledger holds ' + ledger.prunedCount + ' pruned item(s) total; '
                    + 'if the label came from memory rather than a stub/vocabulary line, call list_labels to see the real one.';
            }
            const shadowed = host.shadowedSeqsOf(session);
            const lines = [];
            lines.push('recall_history: ' + q.rows.length + ' item(s) by labels [' + [...keys].join(', ')
                + '] (ledger holds ' + ledger.prunedCount + ')');
            // 未命中的查询标签如实回显（不静默）：模型必须知道自己查询里哪半是空想。
            if (unknown.length > 0)
                lines.push('[labels not in the pruned ledger, ignored: ' + unknown.join(', ') + ']');
            if (q.epochStale)
                lines.push('[warning: ledger epoch changed since your cursor — results re-sorted from scratch, continue with the cursor/epoch below]');
            for (const row of q.rows) {
                const state = nodeStateOf(session, row.rootSeq, s => shadowed.has(s));
                pushBounded(st.recallCalls, { seq: row.rootSeq, hit: true, state }, host.telemetryCap);
                const tag = '--- seq=' + row.rootSeq + ' turn=' + row.turn + ' state=' + state + ' hit=' + row.hitLabels.join(',');
                const raw = rawEventText(session, row.rootSeq);
                if (raw === null) {
                    lines.push(tag + ' (this log event carries no model-visible text)');
                    continue;
                }
                lines.push(tag + (raw.reconstructed ? ' [reconstructed: ' + (raw.note ?? '') + ']' : '') + '\n' + raw.text);
            }
            if (q.nextCursor !== null) {
                lines.push('[more matches: call recall_history again with cursor=' + q.nextCursor + ' epoch=' + q.epoch + ']');
            }
            return host.budgetRecallText(session, lines.join('\n'));
        },
    });
    ctx.tools.register(recallHistoryTool);
    const listLabelsTool = defineTool({
        name: 'list_labels',
        description: 'List the label vocabulary derived from the pruned ledger: every document:<path> / command:<family> / errorcode:<CODE> that covers pruned tool results, with how many pruned items it covers and the last turn it was seen. Use it when a needed label is not in the short vocabulary section or when recall_history found nothing (labels must be copied from here or from a stub, never guessed). category filters one facet (default: all); each line is directly usable in recall_history.',
        parameters: {
            category: { type: 'string', description: 'optional facet filter: document | command | errorcode' },
            limit: { type: 'integer', description: 'optional maximum labels per category (default 30, cap 200)' },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
        },
        execute: async (args, exec) => {
            const session = resolveSession(exec);
            if (session === null)
                return 'list_labels: no session bound (multi-session host: recall requires agent context)';
            const a = (args ?? {});
            let cats;
            if (a.category !== undefined && a.category.trim() !== '') {
                const c = a.category.trim();
                if (!VOCAB_FACETS.includes(c)) {
                    return 'list_labels: unknown category "' + a.category + '" (valid: ' + VOCAB_FACETS.join(' | ') + ')';
                }
                cats = [c];
            }
            else
                cats = VOCAB_FACETS;
            const limit = Math.max(1, Math.min(200, a.limit ?? 30));
            const ledger = factor.ledger;
            const lines = ['list_labels: vocabulary of the pruned ledger (' + ledger.prunedCount + ' pruned item(s))'];
            let rejected = 0;
            for (const facet of cats) {
                const v = ledger.vocabularyRows(facet, limit);
                rejected += v.rejected;
                if (v.rows.length === 0) {
                    lines.push(facet + ': no pruned item carries a ' + facet + ' label');
                    continue;
                }
                lines.push(facet + ' — ' + v.rows.length + ' label(s)' + (v.omitted > 0 ? ' (' + v.omitted + ' more, raise limit)' : '') + ':');
                for (const r of v.rows)
                    lines.push('- ' + r.key + ' ×' + r.count + ' (last seen turn ' + r.lastSeenTurn + ')');
            }
            // fail-closed 出口可见：被当前文法拒收的键留索引不进 prompt，但拒收本身必须可查。
            if (rejected > 0)
                lines.push('[rejected by current label grammar, kept in index but not listable: ' + rejected + ']');
            lines.push('Retrieve any of these with recall_history(["<key>"]).');
            // 发现类同付费（0-4 教训：免费列表会把预算挤占面变成发现面）。
            return host.budgetRecallText(session, lines.join('\n'));
        },
    });
    ctx.tools.register(listLabelsTool);
}
