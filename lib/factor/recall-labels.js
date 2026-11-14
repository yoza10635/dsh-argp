import { defineTool } from '@deepseek-ai/dsh-tools';
import { nodeStateOf, rawEventText } from "../log-access.js";
import { currentTurnOf, recallBudgetState } from "../recall.js";
import { pushBounded } from "../telemetry.js";
import { DEFAULT_RECALL_LIMIT } from "../constants.js";
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
/** per-turn 安全阀（两工具共用）：轮变归零 → 判上限 → 计数。返回 true = 已拒绝。 */
function recallCallBlocked(st, session) {
    const turn = currentTurnOf(session);
    if (st.recallTurn !== turn) {
        st.recallTurn = turn;
        st.recallCallsThisTurn = 0;
    }
    if (st.recallCallsThisTurn >= RECALL_CALLS_PER_TURN_LIMIT)
        return true;
    st.recallCallsThisTurn += 1;
    return false;
}
/**
 * 路径形标签的归一化尾段（后缀匹配用）：剥 document:/scope: 前缀、反斜杠归一、
 * 小写、剥 `./` 与前导 `/`。不含 `/`（单词名）返回 null——单词名走既有裸标签展开，
 * 不进后缀通道。
 */
function pathTailOf(wanted) {
    const stripped = wanted.startsWith('document:')
        ? wanted.slice('document:'.length)
        : wanted.startsWith('scope:') ? wanted.slice('scope:'.length) : wanted;
    let p = stripped.replace(/\\/g, '/').toLowerCase();
    while (p.startsWith('./'))
        p = p.slice(2);
    if (p.startsWith('/'))
        p = p.slice(1);
    if (p === '' || !p.includes('/'))
        return null;
    return p;
}
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
        description: 'Retrieve the original text of tool results that were pruned from your visible context, addressed by ENTITY LABEL instead of seq. Pass labels exactly as shown in the vocabulary section: document:<path>, command:<family>, errorcode:<CODE> (a bare name without prefix is matched against all facets; a path-like label may also be given in shortened relative form — a unique path-suffix match resolves it and the reply states the full key; ambiguous suffixes are listed, never guessed). Multiple labels require ALL of them to match the same item (true intersection) — if nothing comes back, drop a label or check list_labels coverage. view:"outline" returns one metadata line per item (turn/tool/verdict/size/labels) so you can survey a wide result set before fetching text; the default view returns full originals, sized to fit the budget with an item/offset continuation hint when an item is cut. item=<rootSeq> fetches a single item listed by an earlier reply; offset=<chars> continues a truncated item. Returns originals verbatim from the append-only log under a per-call and per-turn character budget; when more matches exist the reply ends with cursor/epoch values to pass back for the next page (re-pass the same labels/limit/order/view when paging). Pruned content is keyed by entity labels; item= only addresses items a previous recall reply surfaced. Use list_labels(category) to discover labels you cannot recall.',
        parameters: {
            labels: { type: 'array', items: { type: 'string' }, description: 'one or more labels; ALL must match the same item (true intersection), verbatim from the vocabulary (e.g. ["document:c:/proj/a.ts","errorcode:ERESOLVE"])' },
            limit: { type: 'integer', description: 'optional maximum items to return (engine-configured default when omitted, cap 20)' },
            view: { type: 'string', description: 'optional result shape: "full" (default) = original texts; "outline" = one metadata line per item — start here for wide result sets' },
            order: { type: 'string', description: 'optional sort: "relevant" (default) | "fresh" (newest first) | "timeline" (oldest first, causal reading order)' },
            cursor: { type: 'integer', description: 'optional continuation cursor from a previous reply (must be paired with its epoch)' },
            epoch: { type: 'integer', description: 'optional ledger epoch from a previous reply; mismatch = the ledger changed, results are re-sorted from scratch and the reply says so' },
            item: { type: 'integer', description: 'optional single-item fetch: the item=<rootSeq> value from an earlier reply line; when set, labels/cursor/limit/order/view are ignored' },
            offset: { type: 'integer', description: 'optional character offset into that item (continuation after a truncation hint)' },
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
            if (recallCallBlocked(st, session)) {
                return 'recall_history: per-turn call limit reached (' + RECALL_CALLS_PER_TURN_LIMIT
                    + ' calls). This is a loop guard, not a content limit — retrieved text is capped by a separate '
                    + 'character budget. Narrow the query or retry next turn.';
            }
            const a = (args ?? {});
            const ledger = factor.ledgerForRecall(session);
            const shadowed = host.shadowedSeqsOf(session);
            // ---- item 钻取路径（item 优先；labels/cursor/limit/order/view 忽略并明示，不隐式合并）。
            // 生死线（对抗审查 C 项）：item 必须 ∈ 被剪账本——否则 item 就是无标签限制的 seq
            // 召回通道，等于把已退役的 recall_pruned 假通道换个名字挂回来。 ----
            if (typeof a.item === 'number' && Number.isFinite(a.item)) {
                const seq = Math.trunc(a.item);
                if (!ledger.hasEntry(seq)) {
                    return 'recall_history: item=' + seq + ' is not in the pruned ledger (it may still be live in your visible context, or the value is stale). Only item= values printed by earlier recall replies are valid; find items with labels + view:"outline".';
                }
                const off = a.offset === undefined ? 0 : Math.trunc(a.offset);
                if (!Number.isFinite(a.offset ?? 0) || off < 0) {
                    return 'recall_history: offset must be a non-negative character offset (got ' + String(a.offset) + ').';
                }
                const ent = ledger.entryOf(seq);
                const raw = rawEventText(session, seq);
                const state = nodeStateOf(session, seq, s => shadowed.has(s));
                pushBounded(st.recallCalls, { seq, hit: true, state }, host.telemetryCap);
                if (raw === null) {
                    return 'recall_history: item=' + seq + ' (this log event carries no model-visible text)';
                }
                if (off >= raw.text.length) {
                    return 'recall_history: item=' + seq + ' — offset ' + off + ' is past the end (' + raw.text.length + ' chars); no more content.';
                }
                // 装配目标 = min(perCallLimit, remaining)（审查 B 不变量 #1）；140 ≈ 续读 footer 保留位，
                // 还须扣 header/tag 自身——slice 预算 ≠ 全部 body 预算（否则外层钳位切进正文）。
                const info = recallBudgetState({ stateOf: s => host.stateOf(s), charsPerToken: host.charsPerToken }, session);
                const header = 'recall_history: item=' + seq + (off > 0 ? ' from offset=' + off : '') + ' (' + raw.text.length + ' chars total, labels/cursor/limit/order/view ignored in item mode)';
                const tag = '--- seq=' + seq + ' turn=' + (ent?.turn ?? 0) + ' state=' + state
                    + (ent ? ' tool=' + ent.tool + (ent.failed ? ' failed' : '') : '');
                const bodyBudget = Math.max(0, Math.min(info.perCallLimit, info.remaining) - 140 - header.length - tag.length - 1);
                const slice = raw.text.slice(off, off + bodyBudget);
                const lines = [header, tag + (raw.reconstructed ? ' [reconstructed: ' + (raw.note ?? '') + ']' : '') + '\n' + slice];
                // 续读提示走 footer（钳位外拼，预算紧时不被吃——沿用既有 footer 纪律）。
                const nextOff = off + slice.length;
                const footer = nextOff < raw.text.length
                    ? '\n[item continues: call recall_history with item=' + seq + ' offset=' + nextOff + ']'
                    : '';
                return host.budgetRecallText(session, lines.join('\n')) + footer;
            }
            const wanted = [...new Set((Array.isArray(a.labels) ? a.labels : [])
                    .map(l => (typeof l === 'string' ? l.trim() : '')).filter(l => l !== ''))];
            if (wanted.length === 0) {
                return 'recall_history: pass at least one label exactly as shown in the '
                    + 'vocabulary section (document:<path> / command:<family> / errorcode:<CODE>); '
                    + 'call list_labels to see the full pruned vocabulary.';
            }
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
            // 路径后缀归一（2026-11-14 用户裁定；alpha4 T19/T30 实锤：模型猜相对路径标签，
            // 账本存绝对路径 ⇒ no-match 后模型放弃召回、凭记忆作答）。精确/展开都未命中的
            // 路径形标签做唯一后缀匹配；命中如实告知改写（模型下次用全形），多候选
            // fail-closed 列出候选绝不猜（与词表出口 fail-closed 同纪律）。
            const remapped = [];
            const ambiguous = [];
            for (const w of [...unknown]) {
                const tail = pathTailOf(w);
                if (tail === null)
                    continue;
                const candidates = [...ledger.matchBySuffix('document:', tail), ...ledger.matchBySuffix('scope:', tail)];
                if (candidates.length === 1) {
                    keys.add(candidates[0]);
                    remapped.push(w + ' → ' + candidates[0]);
                    unknown.splice(unknown.indexOf(w), 1);
                }
                else if (candidates.length > 1) {
                    ambiguous.push(w + ' — suffix matches ' + candidates.length + ' ledger keys: '
                        + candidates.slice(0, 5).join(', ') + (candidates.length > 5 ? ', …' : ''));
                    unknown.splice(unknown.indexOf(w), 1);
                }
            }
            // 缺省档 = 固化 DEFAULT_RECALL_LIMIT（原 recallLimit 旋钮已随 2.0.0 退役；
            // 5 = P2-1 已测口径逐字保持）；模型可显式传 limit，上限 20。
            const limit = Math.max(1, Math.min(20, a.limit ?? DEFAULT_RECALL_LIMIT));
            const view = a.view === 'outline' ? 'outline' : 'full';
            const order = a.order === 'fresh' || a.order === 'timeline' ? a.order : 'relevant';
            const q = ledger.queryPruned({ labels: [...keys], limit, order, cursor: a.cursor, epoch: a.epoch });
            if (q.rows.length === 0) {
                pushBounded(st.recallCalls, { seq: -1, hit: false }, host.telemetryCap);
                // 全部标签都解析成功仍空 ⇒ 是"无交集"而非"标签空想"——必须区分（审查 F.10），
                // 否则模型会反复重查同一对标签。
                const allResolved = unknown.length === 0 && ambiguous.length === 0 && wanted.length >= 2;
                return 'recall_history: no pruned item matches (' + wanted.join(', ') + ')'
                    + (unknown.length > 0 ? ' — labels not in the pruned ledger, ignored: ' + unknown.join(', ') : '')
                    + (ambiguous.length > 0 ? ' — ambiguous path suffix, not resolved: ' + ambiguous.join('; ') : '')
                    + (allResolved ? ' — labels exist but no pruned item carries all of them together; drop a label or check list_labels coverage' : '')
                    + '. The ledger holds ' + ledger.prunedCount + ' pruned item(s) total; '
                    + 'if the label came from memory rather than a stub/vocabulary line, call list_labels to see the real one.';
            }
            const lines = [];
            lines.push((view === 'outline' ? 'recall_history outline: ' : 'recall_history: ') + q.rows.length + ' item(s) by labels [' + [...keys].join(', ')
                + '] (ledger holds ' + ledger.prunedCount + ')' + (view === 'outline' ? '; fetch text with item=<id>' : ''));
            // 未命中的查询标签如实回显（不静默）：模型必须知道自己查询里哪半是空想。
            if (unknown.length > 0)
                lines.push('[labels not in the pruned ledger, ignored: ' + unknown.join(', ') + ']');
            // 后缀归一改写必须可见（模型学会下次用全形）；歧义候选如实列出。
            if (remapped.length > 0)
                lines.push('[label suffix-resolved: ' + remapped.join('; ') + ' — use the full form next time]');
            if (ambiguous.length > 0)
                lines.push('[ambiguous path suffix, not resolved: ' + ambiguous.join('; ') + ']');
            if (q.epochStale)
                lines.push('[warning: ledger epoch changed since your cursor — results re-sorted from scratch, continue with the cursor/epoch below]');
            if (view === 'outline') {
                // outline：每行只给确定性元数据。长度**现算**（rawEventText 实际可取回长度）——
                // 贴标期 sizeChars 有 32768 采样封顶（tag-extract），对大结果系统性低报（审查 D 项）。
                for (const row of q.rows) {
                    const raw = rawEventText(session, row.rootSeq);
                    const len = raw === null ? 'no-text' : raw.text.length + ' chars';
                    const verdict = row.failed ? 'failed' : row.errorish ? 'error-sig' : 'ok';
                    lines.push('item=' + row.rootSeq + ' · turn=' + row.turn + ' · ' + row.tool + ' ' + verdict
                        + ' · ' + len + ' · labels=' + row.hitLabels.join(','));
                }
            }
            else {
                // 装配式 full（审查 B 项四不变量）：目标 = min(perCall, remaining)（#1）；
                // RESERVED 给全局 footer + 装配期提示留位，它们不得被外层钳位切头（#3）；
                // K 钳非负、首条装不下即停（#2/#4）；全文只过一次 budgetRecallText（#3）。
                const info = recallBudgetState({ stateOf: s => host.stateOf(s), charsPerToken: host.charsPerToken }, session);
                const allowed = Math.min(info.perCallLimit, info.remaining);
                const RESERVED = 300;
                const MARKER_ROOM = 150;
                let used = lines.reduce((n, l) => n + l.length + 1, 0);
                let rendered = 0;
                let cut = null;
                for (const row of q.rows) {
                    const raw = rawEventText(session, row.rootSeq);
                    const state = nodeStateOf(session, row.rootSeq, s => shadowed.has(s));
                    pushBounded(st.recallCalls, { seq: row.rootSeq, hit: true, state }, host.telemetryCap);
                    const tag = '--- seq=' + row.rootSeq + ' turn=' + row.turn + ' state=' + state + ' labels=' + row.hitLabels.join(',')
                        + (raw?.reconstructed ? ' [reconstructed: ' + (raw.note ?? '') + ']' : '');
                    const block = raw === null
                        ? tag + ' (this log event carries no model-visible text)'
                        : tag + '\n' + raw.text;
                    if (raw === null) {
                        // 无正文小块：放得下就过，放不下停（无 offset 续读概念）。
                        if (used + block.length + 1 + RESERVED <= allowed) {
                            lines.push(block);
                            used += block.length + 1;
                            rendered += 1;
                            continue;
                        }
                        break;
                    }
                    const room = allowed - RESERVED - used - tag.length - 1 - MARKER_ROOM;
                    if (room >= raw.text.length) {
                        lines.push(block);
                        used += block.length + 1;
                        rendered += 1;
                        continue;
                    }
                    // 装不下：能装多少装多少（K 钳非负），留截断续读提示；一条都装不下就停。
                    const keep = raw === null ? 0 : Math.max(0, Math.min(raw.text.length, room));
                    if (raw !== null && keep > 0) {
                        lines.push(tag + '\n' + raw.text.slice(0, keep));
                        used += tag.length + 1 + keep;
                        cut = { seq: row.rootSeq, offset: keep };
                    }
                    break;
                }
                const skipped = q.rows.length - rendered - (cut !== null ? 1 : 0);
                if (cut !== null) {
                    lines.push('[item ' + cut.seq + ' truncated at ' + cut.offset + ' chars — re-call with item=' + cut.seq + ', offset=' + cut.offset + ' to continue]');
                }
                if (rendered === 0 && q.rows.length > 0) {
                    lines.push('[budget too small this call to show item bodies — use view:"outline" for metadata only, or retry next turn (budget resets each turn)]');
                }
                else if (skipped > 0) {
                    lines.push('[+' + skipped + ' more item(s) not shown — narrow labels, use view:"outline", or retry next turn]');
                }
            }
            // 续读提示**不随正文一起被预算截断**（budgetRecallText 从头部截）：正文单独过
            // 预算，footer 最后拼；否则预算紧时唯一的分页手段先被吃掉。
            const footer = q.nextCursor !== null
                ? '\n[more matches: call recall_history again with cursor=' + q.nextCursor + ' epoch=' + q.epoch + ']'
                : '';
            return host.budgetRecallText(session, lines.join('\n')) + footer;
        },
    });
    ctx.tools.register(recallHistoryTool);
    const listLabelsTool = defineTool({
        name: 'list_labels',
        description: 'List the label vocabulary derived from the pruned ledger: every document:<path> / command:<family> / errorcode:<CODE> (and scope:<path> on request) that covers pruned tool results, each with how many pruned items it covers, the last operation seen on it, and an error-signal count (a text signal, not a failure verdict). Use it when a needed label is not in the short vocabulary section or when recall_history found nothing (labels must be copied from here or from a stub, never guessed). category filters one facet (default: document+command+errorcode); each line is directly usable in recall_history.',
        parameters: {
            category: { type: 'string', description: 'optional facet filter: document | command | errorcode | scope' },
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
            const st = host.stateOf(session);
            // 与 recall_history 共用**同一** per-turn 安全阀（文件头契约：两工具共享上限；
            // 否则字符预算耗尽后 list_labels 可无限空转）。
            if (recallCallBlocked(st, session)) {
                return 'list_labels: per-turn call limit reached (' + RECALL_CALLS_PER_TURN_LIMIT
                    + ' calls, shared with recall_history). This is a loop guard, not a content limit; retry next turn.';
            }
            const a = (args ?? {});
            let cats;
            if (a.category !== undefined && a.category.trim() !== '') {
                const c = a.category.trim();
                // scope 按需可见（2026-11-14 Kimi 方案 R2 收口）：查询侧早已放行
                // （FACET_PREFIXES / matchBySuffix / stubKey 都认 scope），词表侧补齐是对齐；
                // 缺省扫掠仍不含 scope（目录键量大价值低，进缺省扫掠会挤占 top-N）。
                if (!VOCAB_FACETS.includes(c) && c !== 'scope') {
                    return 'list_labels: unknown category "' + a.category + '" (valid: ' + VOCAB_FACETS.join(' | ') + ' | scope)';
                }
                cats = [c];
            }
            else
                cats = VOCAB_FACETS;
            const limit = Math.max(1, Math.min(200, a.limit ?? 30));
            const ledger = factor.ledgerForRecall(session);
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
                for (const r of v.rows) {
                    // R4 紧版行内线索：last = 最后一条的 tool + 宿主结构化 verdict；
                    // err-sig 只计数（errorish 是文本信号，不当"调用失败"渲染）。
                    const errPart = r.errSigCount > 0 ? ' · err-sig ' + r.errSigCount + '/' + r.count : '';
                    lines.push('- ' + r.key + ' ×' + r.count + ' · last: ' + r.lastTool + ' ' + (r.lastFailed ? 'failed' : 'ok')
                        + ' @t' + r.lastSeenTurn + errPart);
                }
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
