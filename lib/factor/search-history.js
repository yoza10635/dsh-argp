import { defineTool } from '@deepseek-ai/dsh-tools';
import { nodeStateOf, rawEventText, sessionEvents } from "../log-access.js";
import { recallBudgetState } from "../recall.js";
import { liveBlendCharsPerToken } from "../budget.js";
import { estTokensFromStats } from "../cjk.js";
import { pushBounded } from "../telemetry.js";
import { RECALL_SEARCH_FACET_N, RECALL_SEARCH_FLAT_N, RECALL_SEARCH_FLAT_TOK, RECALL_SEARCH_MID_TOK, RECALL_SEARCH_PAGE_TOK, RECALL_SEARCH_TF_CAP, RECALL_SEARCH_LIVE_MERGE_K, } from "../constants.js";
import { collectHits, defaultProseCapChars, proseTextOf, scanProseHits } from "./prose-scan.js";
import { KEYWORD_MAX_CHARS, KEYWORD_MIN_CHARS, recallCallBlocked, resolveQueryLabels, sessionOfToolCall } from "./recall-labels.js";
import { isRecallTool, namesRecallFamilyKey } from "./recall-tools.js";
/** U/A 行 turn 源：data.turn ?? 向前扫最近 turn/start ?? '?'（S11 口径）。 */
function turnAtSeq(events, seq) {
    const direct = events[seq]?.data?.turn;
    if (typeof direct === 'number')
        return direct;
    for (let i = seq; i >= 0; i -= 1) {
        const ev = events[i];
        if (ev?.type === 'turn/start' && typeof ev.data?.turn === 'number')
            return ev.data.turn;
    }
    return '?';
}
/**
 * 分层预览六步口径（R10，golden-string 可锁）：①原文定窗 [first−W, first+len+W]
 * ②两端回退最近行边界 ③切片 ④切片压平控制符 ⑤estTokens 前缀累加取 ≤tok 最长
 * codePoint 前缀 ⑥截断补 …（不回测）。
 */
export function buildPreview(text, first, needleLen, tok, cpt) {
    if (tok <= 0)
        return '';
    const side = Math.max(4, Math.floor((tok * cpt) / 2));
    let from = Math.max(0, first - side);
    let to = Math.min(text.length, first + needleLen + side);
    // 行边界**向内收缩**（R10）：窗起点右移到命中前最近行首、终点左移到窗内最近行尾；
    // 无换行则保留字符位——**绝不外扩**（旧 `lastIndexOf+1` 无 \n 时归 0 会把长单行塌成整段）。
    const nlStart = text.indexOf('\n', from);
    if (nlStart >= 0 && nlStart < first)
        from = nlStart + 1;
    const nlEnd = text.lastIndexOf('\n', to);
    if (nlEnd > first)
        to = nlEnd;
    const slice = text.slice(from, to);
    const flat = slice.replace(/[\r\n\t\x00-\x1f]+/g, ' ').replace(/ {2,}/g, ' ').trim();
    let acc = 0;
    let cjk = 0;
    let keep = 0;
    for (const ch of flat) {
        const o = ch.codePointAt(0);
        const isCjk = (o >= 0x3000 && o <= 0x303F) || (o >= 0x3040 && o <= 0x30FF)
            || (o >= 0x3400 && o <= 0x4DBF) || (o >= 0x4E00 && o <= 0x9FFF);
        const nAcc = acc + 1;
        const nCjk = cjk + (isCjk ? 1 : 0);
        if (Math.ceil(estTokensFromStats(nAcc, nCjk)) > tok)
            break;
        acc = nAcc;
        cjk = nCjk;
        keep += ch.length;
    }
    const body = flat.slice(0, keep);
    return (from > 0 ? '…' : '') + body + (keep < flat.length || to < text.length ? '…' : '');
}
/**
 * 多片段预览（Lucene unified highlighter 形：命中分散时取多个 fragment，非只锚首次）。
 * 宽档（tok≥50）最多 2 个**互不重叠**窗（预算对半），窄档单窗；命中聚成一簇时自然只出 1 窗。
 * 确定性：positions 升序、重叠判据=下一锚点 ≤ 上窗可见右界。
 */
export function buildPreviews(text, positions, needleLen, tok, cpt) {
    if (tok <= 0 || positions.length === 0)
        return '';
    const maxFrag = tok >= 50 ? 2 : 1;
    const perFragTok = maxFrag === 1 ? tok : Math.floor(tok / 2);
    const frags = [];
    let lastEnd = -1;
    for (const pos of positions) {
        if (frags.length >= maxFrag)
            break;
        if (pos <= lastEnd)
            continue;
        frags.push(buildPreview(text, pos, needleLen, perFragTok, cpt));
        lastEnd = pos + needleLen + Math.floor((perFragTok * cpt) / 2);
    }
    if (frags.length === 0)
        frags.push(buildPreview(text, positions[0], needleLen, perFragTok, cpt));
    return frags.join(' ⊕ ');
}
export function registerSearchHistory(ctx, factor, host) {
    const tool = defineTool({
        name: 'search_history',
        description: 'Content discovery over the session log by literal case-insensitive substring (2-100 chars, NOT a regex): '
            + 'searches pruned tool results AND conversation prose — user/assistant message originals, including text already '
            + 'condensed away by compaction (originals stay in the append-only log). Each row prints a hit=<seq> handle, the per-item match count (×N), and up to two match fragments (previews shrink when there are many hits); fetch a row\'s full original with search_history(hit=<seq>). '
            + 'Optional labels[] narrows to pruned items carrying ALL given labels — prose has no labels, so with labels present only '
            + 'the tool band is searched. More than ' + RECALL_SEARCH_FACET_N + ' hits: nothing is listed — refine (longer keyword or add labels). '
            + 'Shares the recall_history per-call/per-turn character budget. '
            + 'Pruned results of the recall tools themselves are by default excluded from the tool band and from vocabulary counts '
            + '(copies of originals would duplicate rows); pass a tool:recall_history / tool:list_labels / tool:search_history label to include those copies (audit).',
        parameters: {
            keyword: { type: 'string', description: 'literal substring, 2-100 chars, no control chars (NOT a regex); required unless hit= is set' },
            labels: { type: 'array', items: { type: 'string' }, description: 'optional; ALL must match the same pruned item (verbatim vocabulary labels). With labels only the tool band is searched — prose never carries labels' },
            limit: { type: 'integer', description: 'optional maximum rows; an explicit limit also widens per-row preview width' },
            hit: { type: 'integer', description: 'second-hop full fetch: a hit=<seq> value printed by the PREVIOUS search_history reply (single-slot index — replaced by your next search). When set, keyword/labels/limit are ignored' },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
        },
        execute: async (args, exec) => {
            const session = sessionOfToolCall(exec, host);
            if (session === null)
                return 'search_history: no session bound';
            const a = (args ?? {});
            if (recallCallBlocked(host.stateOf(session), session)) {
                return 'search_history: per-turn recall-call cap reached (20) — retry next turn';
            }
            const st = host.stateOf(session);
            const ledger = factor.ledgerOf(session);
            // ---- hit= 第二跳（D8′：白名单=临时索引 sole，各管各；无 ∪ 手术） ----
            if (typeof a.hit === 'number' && Number.isFinite(a.hit)) {
                const seq = Math.trunc(a.hit);
                const entry = st.searchIndex?.get(seq);
                if (entry === undefined) {
                    // 三因不可区分（重启/被覆盖/从未 surfaced）=单一诚实句（R4）。
                    return 'search_history: hit=' + seq + ' is not in the last result (the index holds only the most recent '
                        + 'search_history reply, and is gone after a restart or another query) — re-run the search first.';
                }
                const events = sessionEvents(session);
                const text = entry.kind === 'R' ? (rawEventText(session, seq)?.text ?? '') : (proseTextOf(events[seq]) ?? '');
                const shadowed = host.shadowedSeqsOf(session);
                const state = nodeStateOf(session, seq, s => shadowed.has(s));
                const info = recallBudgetState({ stateOf: s => host.stateOf(s), charsPerToken: host.charsPerToken }, session);
                const allowed = Math.min(info.perCallLimit, info.remaining);
                const tag = '--- hit=' + seq + ' ' + (entry.kind === 'R' ? 'tool-result' : entry.kind === 'U' ? 'user' : 'assistant')
                    + ' turn=' + entry.turn + ' state=' + state;
                pushBounded(st.recallCalls, { seq, hit: true, state }, host.telemetryCap);
                const RESERVED = 200;
                const room = Math.max(0, allowed - tag.length - 1 - RESERVED);
                if (room <= 0) {
                    return host.budgetRecallText(session, tag + '\n[budget too small this call — retry next turn (budget resets each turn)]');
                }
                if (text.length <= room) {
                    return host.budgetRecallText(session, tag + '\n' + text);
                }
                return host.budgetRecallText(session, tag + '\n' + text.slice(0, room))
                    + '\n[hit ' + seq + ' truncated at ' + room + ' chars of ' + text.length + ' — budget cap; retry next turn for more]';
            }
            const kwRaw = typeof a.keyword === 'string' ? a.keyword.trim() : '';
            if (kwRaw === '') {
                return 'search_history: keyword is required (literal substring 2-100 chars). Label-addressed fetch goes through recall_history; list_labels shows the vocabulary.';
            }
            if (kwRaw.length < KEYWORD_MIN_CHARS || kwRaw.length > KEYWORD_MAX_CHARS || /[\r\n\t\x00-\x1f]/.test(kwRaw)) {
                return 'search_history: keyword must be a literal substring of 2-' + KEYWORD_MAX_CHARS + ' chars without control characters (not a regex)';
            }
            const labels = resolveQueryLabels(ledger, a.labels);
            const needle = kwRaw.toLowerCase();
            const events = sessionEvents(session);
            const rows = [];
            const shadowed = host.shadowedSeqsOf(session);
            const stateOfSeq = (seq) => nodeStateOf(session, seq, s => shadowed.has(s));
            // ---- 工具带（labels 在场=AND 交集逐字不动；=0 键时全账本） ----
            let candT;
            if (labels.keys.size > 0) {
                let inter = null;
                for (const k of labels.keys) {
                    const s = ledger.stat(k);
                    if (s === null)
                        continue;
                    if (inter === null)
                        inter = new Set(s.rootSeqs);
                    else {
                        const set = new Set(s.rootSeqs);
                        for (const x of [...inter])
                            if (!set.has(x))
                                inter.delete(x);
                    }
                }
                candT = inter === null ? [] : [...inter];
            }
            else {
                candT = ledger.prunedRootSeqs();
            }
            // 召回副本可见性裁决（2026-11-23，与 queryPruned 同收口）：裁定 2 剪下的召回
            // 结果携带与原文相同的 document:/errorcode: 键，R 带对原文+副本双命中（行内
            // ×N 只治单 atom 行级、不跨 atom）。labels 未点名 tool: 召回族键时剔除副本；
            // 点名时放行（审计形）。hit= 第二跳不受本闸（白名单=先前 surfacing 行）。
            if (!namesRecallFamilyKey(labels.keys)) {
                candT = candT.filter(seq => {
                    const e = ledger.entryOf(seq);
                    return e === null || !isRecallTool(e.tool);
                });
            }
            for (const seq of candT) {
                const raw = rawEventText(session, seq);
                if (raw === null)
                    continue;
                const h = collectHits(raw.text, needle);
                if (h.count === 0)
                    continue;
                const e = ledger.entryOf(seq);
                rows.push({
                    seq, kind: 'R', turn: e?.turn ?? '?', chars: raw.text.length,
                    score: Math.min(h.count, RECALL_SEARCH_TF_CAP), hits: h.count, first: h.positions[0], positions: h.positions,
                    tool: e?.tool ?? '', verdict: e === null ? 'ok' : e.failed ? 'failed' : e.errorish ? 'error-sig' : 'ok',
                    labels: labels.keys.size > 0 ? [...labels.keys].join(',') : ledger.labelKeysOf(seq).join(','),
                    state: stateOfSeq(seq),
                });
            }
            // ---- 散文带（仅 keyword-only；独立 cap 从旧到新，P7★） ----
            const proseMode = labels.wanted.length === 0 && labels.keys.size === 0;
            let proseTruncated = false;
            let proseScanned = 0;
            if (proseMode) {
                const cap = factor.proseScanCapOverride()
                    ?? defaultProseCapChars(st.resolvedWindowTokens, liveBlendCharsPerToken(session, host.charsPerToken));
                const scan = scanProseHits(events, needle, cap);
                proseTruncated = scan.truncated;
                proseScanned = scan.scannedChars;
                for (const h of scan.hits) {
                    const text = proseTextOf(events[h.seq]);
                    if (text === null)
                        continue;
                    const ev = events[h.seq];
                    rows.push({
                        seq: h.seq, kind: ev.type === 'user/message' ? 'U' : 'A', turn: turnAtSeq(events, h.seq),
                        chars: h.chars, score: Math.min(h.hits, RECALL_SEARCH_TF_CAP), hits: h.hits, first: h.first, positions: h.positions, state: stateOfSeq(h.seq),
                    });
                }
            }
            rows.sort((x, y) => y.score - x.score || x.seq - y.seq);
            const nR = rows.reduce((k, r) => k + (r.kind === 'R' ? 1 : 0), 0);
            const nP = rows.length - nR;
            const echo = [];
            if (labels.remapped.length > 0)
                echo.push('[label suffix-resolved: ' + labels.remapped.join('; ') + ' — use the full form next time]');
            if (labels.ambiguous.length > 0)
                echo.push('[ambiguous path suffix, not resolved: ' + labels.ambiguous.join('; ') + ']');
            if (labels.unknown.length > 0)
                echo.push('[labels not in the pruned ledger, ignored: ' + labels.unknown.join(', ') + ']');
            const header = 'search_history "' + kwRaw.slice(0, 40) + (kwRaw.length > 40 ? '…' : '') + '": '
                + rows.length + ' hit(s) — tool×' + nR + ' + prose×' + nP
                + (proseMode ? ' (prose band scanned ' + proseScanned + ' chars)' : ' (labels filter on: tool band only)');
            if (rows.length === 0) {
                pushBounded(st.recallCalls, { seq: -1, hit: false }, host.telemetryCap);
                st.searchIndex = null;
                st.searchQuery = kwRaw;
                const foot = proseTruncated ? '\n[scan cap hit — newer prose beyond the cap was NOT searched; refine or retry]' : '';
                return host.budgetRecallText(session, header + '\nno matches in pruned originals or conversation prose'
                    + (echo.length > 0 ? '\n' + echo.join('\n') : '')) + foot;
            }
            // ---- N>阈值：标签分布直方图（faceted search 形；无预览/无索引，逼细化） ----
            const lim = typeof a.limit === 'number' && Number.isFinite(a.limit) ? Math.max(1, Math.min(RECALL_SEARCH_FACET_N, Math.trunc(a.limit))) : undefined;
            if (rows.length > RECALL_SEARCH_FACET_N && lim === undefined) {
                pushBounded(st.recallCalls, { seq: -1, hit: true }, host.telemetryCap);
                st.searchIndex = null;
                st.searchQuery = kwRaw;
                // 命名避「共现」（该词已被 errSig 因子与 1.x 共现边占用，S9）。
                const buckets = new Map();
                let uHits = 0;
                let aHits = 0;
                for (const r of rows) {
                    if (r.kind !== 'R') {
                        if (r.kind === 'U')
                            uHits += 1;
                        else
                            aHits += 1;
                        continue;
                    }
                    const others = ledger.labelKeysOf(r.seq).filter(k => !labels.keys.has(k));
                    if (others.length === 0) {
                        buckets.set('(no-label)', (buckets.get('(no-label)') ?? 0) + 1);
                        continue;
                    }
                    for (const k of others)
                        buckets.set(k, (buckets.get(k) ?? 0) + 1);
                }
                // 桶序=count desc → key 字典 asc（显式断键，R6）。
                const sorted = [...buckets].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
                const dist = sorted.slice(0, 20).map(([k, n]) => '  ' + k + ' ×' + n + '(hits)');
                if (sorted.length > 20)
                    dist.push('  …+' + (sorted.length - 20) + ' more labels');
                return host.budgetRecallText(session, header + '\n[' + rows.length
                    + ' hits exceed the listing threshold ' + RECALL_SEARCH_FACET_N + ' — nothing is previewed. Distribution among hits (refine by adding one of these labels, lengthening the keyword, or pass limit= to page):]'
                    + (dist.length > 0 ? '\n' + dist.join('\n') : '')
                    + '\n  prose among hits: User×' + uHits + ' / Assistant×' + aHits
                    + (echo.length > 0 ? '\n' + echo.join('\n') : ''));
            }
            // ---- 分层预览 + 装配钳（先缩预览后削行） ----
            const tierTok = lim !== undefined ? RECALL_SEARCH_PAGE_TOK : rows.length <= RECALL_SEARCH_FLAT_N ? RECALL_SEARCH_FLAT_TOK : RECALL_SEARCH_MID_TOK;
            const info = recallBudgetState({ stateOf: s => host.stateOf(s), charsPerToken: host.charsPerToken }, session);
            const allowed = Math.min(info.perCallLimit, info.remaining);
            const RESERVED = 260;
            const cpt = host.charsPerToken;
            const lines = [header, ...echo];
            const index = new Map();
            let used = header.length + 1;
            let liveShown = 0;
            let collapsedLive = 0;
            let notShown = 0;
            const shown = lim === undefined ? rows : rows.slice(0, lim);
            for (let i = 0; i < shown.length; i++) {
                const r = shown[i];
                if (r.state === 'live') {
                    if (liveShown >= RECALL_SEARCH_LIVE_MERGE_K) {
                        collapsedLive += 1;
                        continue;
                    }
                    liveShown += 1;
                }
                const text = r.kind === 'R' ? (rawEventText(session, r.seq)?.text ?? '') : (proseTextOf(events[r.seq]) ?? '');
                const kindLabel = r.kind === 'R' ? 'R·' + r.tool + ' ' + (r.verdict ?? 'ok') : r.kind;
                const meta = '- hit=' + r.seq + ' · ' + kindLabel + ' · turn=' + r.turn + ' · ' + r.chars + ' chars · state=' + r.state
                    + ' · ×' + r.hits
                    + (r.kind === 'R' && r.labels !== undefined && r.labels !== '' ? ' · labels=' + r.labels : '');
                const shrinkToks = [tierTok, Math.min(tierTok, RECALL_SEARCH_MID_TOK), 0];
                let rowLine = '';
                for (const t of shrinkToks) {
                    const prev = t > 0 ? ' · hit:"' + buildPreviews(text, r.positions, needle.length, t, cpt) + '"' : '';
                    rowLine = meta + prev;
                    if (used + rowLine.length + 1 + RESERVED <= allowed)
                        break;
                }
                if (used + rowLine.length + 1 + RESERVED > allowed) {
                    notShown = shown.length - i - collapsedLive;
                    break;
                }
                lines.push(rowLine);
                used += rowLine.length + 1;
                index.set(r.seq, { kind: r.kind, turn: r.turn });
            }
            if (collapsedLive > 0) {
                lines.push('[+' + collapsedLive + ' live hit(s) skipped — already in your visible context]');
            }
            pushBounded(st.recallCalls, { seq: shown[0]?.seq ?? -1, hit: true }, host.telemetryCap);
            st.searchIndex = index.size > 0 ? index : null;
            st.searchQuery = kwRaw;
            const footers = [];
            if (notShown > 0)
                footers.push('[+' + notShown + ' row(s) not shown — per-call budget is small; retry next turn (budget resets each turn) or narrow]');
            if (proseTruncated)
                footers.push('[scan cap hit: only the oldest ' + proseScanned + ' prose chars were searched — newer content NOT searched]');
            const foot = footers.length > 0 ? '\n' + footers.join('\n') : '';
            const body = lines.length === 1 && index.size === 0 && collapsedLive === 0
                ? header + '\n[budget too small this call to show any hit row — retry next turn]'
                : lines.join('\n');
            return host.budgetRecallText(session, body) + foot;
        },
    });
    ctx.tools.register(tool);
}
