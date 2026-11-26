/**
 * `search_history`：内容发现工具（design-prose-keyword-recall v2.2 刀 B）。
 *
 * 三工具正交（D8′ 用户裁定）：`list_labels`=看词表、`search_history`=找（内容子串，
 * 覆盖被剪工具原子 **+ user/assistant 散文原文**——含已被浓缩请离场的文本）、
 * `recall_history`=取（标签地址）。两步走=本工具回 hit=<seq> 句柄+分层预览，
 * `hit=` 第二跳取全文（刀 C；本刀先把索引槽落好）。
 *
 * 协议要点（三轮台账）：
 *  - N=命中集总数，缺省铺满至 RECALL_SEARCH_FACET_N（limit 缺省不生效，D9 用户裁定）；
 *  - 分层预览（§6.6 SERP snippet 预算制）：N≤20→100tok、N≤250→20tok、显式 limit 页→200tok；
 *    预览总宽再受单次 5% 预算行均摊 min 钳（R5★：先缩预览后削行，削行必发 footer）；
 *  - 排序 score=min(hits, TF_CAP) desc → seq asc（D11 TF 饱和=BM25 饱和项整数最简形；
 *    断键显式化 R6）；
 *  - labels 过滤在场时候选=账本交集逐字不动、散文不参与（门 wanted=0∧keys=0，P12）；
 *  - 散文带独立 cap（从旧到新保最旧，P7★）+ truncated 页脚显式（fail-visible，R8①）；
 *  - live 行 >K 合并成一行提示（S10/P9：预览与预算不被自身回声支配）；
 *  - 行内控制符压平=内容切片专属（R8：引擎分隔符不受影响）；
 *  - 两带合并文本**恰过一次** budgetRecallText（P14），footer 预算外拼接（:401-406 纪律）；
 *  - 零新参数之外的参数键集在刀 C 前冻结（hit= 随 C 加入）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Session } from '@deepseek-ai/dsh-session'
import { nodeStateOf, rawEventText, sessionEvents } from '../log-access.ts'
import { recallBudgetState } from '../recall.ts'
import { liveBlendCharsPerToken } from '../budget.ts'
import { estTokensFromStats } from '../cjk.ts'
import { pushBounded } from '../telemetry.ts'
import {
  RECALL_SEARCH_FACET_N, RECALL_SEARCH_FLAT_N, RECALL_SEARCH_FLAT_TOK, RECALL_SEARCH_MID_TOK,
  RECALL_SEARCH_PAGE_TOK, RECALL_SEARCH_TF_CAP, RECALL_SEARCH_LIVE_MERGE_K,
} from '../constants.ts'
import { collectHits, defaultProseCapChars, proseTextOf, scanProseHits } from './prose-scan.ts'
import { KEYWORD_MAX_CHARS, KEYWORD_MIN_CHARS, recallCallBlocked, resolveQueryLabels, sessionOfToolCall, type RecallLabelsHost } from './recall-labels.ts'
import { isRecallTool, namesRecallFamilyKey } from './recall-tools.ts'
import type { FactorEngine } from './engine.ts'

interface SearchRow {
  seq: number
  kind: 'R' | 'U' | 'A'
  tool?: string
  verdict?: string
  labels?: string
  turn: number | string
  chars: number
  score: number
  /** 原始命中次数（行内 ×N 展示；score 是它的饱和形用于排序）。 */
  hits: number
  first: number
  /** 前若干命中偏移（多 fragment 预览选取用）。 */
  positions: number[]
  state: string
}

/** U/A 行 turn 源：data.turn ?? 向前扫最近 turn/start ?? '?'（S11 口径）。 */
function turnAtSeq(events: readonly unknown[], seq: number): number | string {
  const direct = (events[seq] as { data?: { turn?: unknown } } | undefined)?.data?.turn
  if (typeof direct === 'number') return direct
  for (let i = seq; i >= 0; i -= 1) {
    const ev = events[i] as { type?: string; data?: { turn?: unknown } } | undefined
    if (ev?.type === 'turn/start' && typeof ev.data?.turn === 'number') return ev.data.turn
  }
  return '?'
}

/**
 * 分层预览六步口径（R10，golden-string 可锁）：①原文定窗 [first−W, first+len+W]
 * ②两端回退最近行边界 ③切片 ④切片压平控制符 ⑤estTokens 前缀累加取 ≤tok 最长
 * codePoint 前缀 ⑥截断补 …（不回测）。
 */
export function buildPreview(text: string, first: number, needleLen: number, tok: number, cpt: number): string {
  if (tok <= 0) return ''
  const side = Math.max(4, Math.floor((tok * cpt) / 2))
  let from = Math.max(0, first - side)
  let to = Math.min(text.length, first + needleLen + side)
  // 行边界**向内收缩**（R10）：窗起点右移到命中前最近行首、终点左移到窗内最近行尾；
  // 无换行则保留字符位——**绝不外扩**（旧 `lastIndexOf+1` 无 \n 时归 0 会把长单行塌成整段）。
  const nlStart = text.indexOf('\n', from)
  if (nlStart >= 0 && nlStart < first) from = nlStart + 1
  const nlEnd = text.lastIndexOf('\n', to)
  if (nlEnd > first) to = nlEnd
  const slice = text.slice(from, to)
  const flat = slice.replace(/[\r\n\t\x00-\x1f]+/g, ' ').replace(/ {2,}/g, ' ').trim()
  let acc = 0
  let cjk = 0
  let keep = 0
  for (const ch of flat) {
    const o = ch.codePointAt(0) as number
    const isCjk = (o >= 0x3000 && o <= 0x303F) || (o >= 0x3040 && o <= 0x30FF)
      || (o >= 0x3400 && o <= 0x4DBF) || (o >= 0x4E00 && o <= 0x9FFF)
    const nAcc = acc + 1
    const nCjk = cjk + (isCjk ? 1 : 0)
    if (Math.ceil(estTokensFromStats(nAcc, nCjk)) > tok) break
    acc = nAcc
    cjk = nCjk
    keep += ch.length
  }
  const body = flat.slice(0, keep)
  return (from > 0 ? '…' : '') + body + (keep < flat.length || to < text.length ? '…' : '')
}

/**
 * 多片段预览（Lucene unified highlighter 形：命中分散时取多个 fragment，非只锚首次）。
 * 宽档（tok≥50）最多 2 个**互不重叠**窗（预算对半），窄档单窗；命中聚成一簇时自然只出 1 窗。
 * 确定性：positions 升序、重叠判据=下一锚点 ≤ 上窗可见右界。
 */
export function buildPreviews(text: string, positions: number[], needleLen: number, tok: number, cpt: number): string {
  if (tok <= 0 || positions.length === 0) return ''
  const maxFrag = tok >= 50 ? 2 : 1
  const perFragTok = maxFrag === 1 ? tok : Math.floor(tok / 2)
  const frags: string[] = []
  let lastEnd = -1
  for (const pos of positions) {
    if (frags.length >= maxFrag) break
    if (pos <= lastEnd) continue
    frags.push(buildPreview(text, pos, needleLen, perFragTok, cpt))
    lastEnd = pos + needleLen + Math.floor((perFragTok * cpt) / 2)
  }
  if (frags.length === 0) frags.push(buildPreview(text, positions[0] as number, needleLen, perFragTok, cpt))
  return frags.join(' ⊕ ')
}

export function registerSearchHistory(ctx: Context, factor: FactorEngine, host: RecallLabelsHost): void {
  const tool = defineTool({
    name: 'search_history',
    description:
      'Content discovery over the session log by literal case-insensitive substring (2-100 chars, NOT a regex): '
      + 'searches pruned tool results AND conversation prose — user/assistant message originals, including text already '
      + 'condensed away by compaction (originals stay in the append-only log). Each row prints a hit=<seq> handle, the per-item match count (×N), and up to two match fragments (previews shrink when there are many hits); fetch a row\'s full original with search_history(hit=<seq>) (long originals: continue with the hit=<seq> offset=<n> the reply prints). '
      + 'Optional labels[] narrows to pruned items carrying ALL given labels — prose has no labels, so with labels present only '
      + 'the tool band is searched. More than ' + RECALL_SEARCH_FACET_N + ' hits: nothing is listed — refine (longer keyword or add labels). '
      + 'If the prose surface does not fit one page, the footer prints a scan cursor — re-call with the same keyword and offset=<n> to page forward (never re-run the search bare to page: bare restarts at the oldest content). '
      + 'Shares the recall_history per-call/per-turn character budget. '
      + 'Pruned results of the recall tools themselves are by default excluded from the tool band and from vocabulary counts '
      + '(copies of originals would duplicate rows); pass a tool:recall_history / tool:list_labels / tool:search_history label to include those copies (audit).',
    parameters: {
      keyword: { type: 'string', description: 'literal substring, 2-100 chars, no control chars (NOT a regex); required unless hit= is set' },
      labels: { type: 'array', items: { type: 'string' }, description: 'optional; ALL must match the same pruned item (verbatim vocabulary labels). With labels only the tool band is searched — prose never carries labels' },
      limit: { type: 'integer', description: 'optional maximum rows; an explicit limit also widens per-row preview width' },
      hit: { type: 'integer', description: 'second-hop full fetch: a hit=<seq> value printed by the PREVIOUS search_history reply (single-slot index — replaced by your next search). When set, keyword/labels/limit are ignored' },
      offset: { type: 'integer', description: 'continuation cursor: with hit= — start reading N chars into that original; with keyword — start the prose scan at char N of the prose surface. Use the offset=<n> printed by the previous reply footer; re-running the search WITHOUT the offset always restarts from the oldest content' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: async (args: unknown, exec: unknown) => {
      const session = sessionOfToolCall(exec, host)
      if (session === null) return 'search_history: no session bound'
      const a = (args ?? {}) as Record<string, unknown>
      if (recallCallBlocked(host.stateOf(session), session)) {
        return 'search_history: per-turn recall-call cap reached (20) — retry next turn'
      }
      const st = host.stateOf(session)
      const ledger = factor.ledgerOf(session)
      // ---- hit= 第二跳（D8′：白名单=临时索引 sole，各管各；无 ∪ 手术） ----
      if (typeof a.hit === 'number' && Number.isFinite(a.hit)) {
        const seq = Math.trunc(a.hit)
        const entry = st.searchIndex?.get(seq)
        if (entry === undefined) {
          // 三因不可区分（重启/被覆盖/从未 surfaced）=单一诚实句（R4）。
          return 'search_history: hit=' + seq + ' is not in the last result (the index holds only the most recent '
            + 'search_history reply, and is gone after a restart or another query) — re-run the search first.'
        }
        const events = sessionEvents(session) as readonly unknown[]
        const text = entry.kind === 'R' ? (rawEventText(session, seq)?.text ?? '') : (proseTextOf(events[seq] as never) ?? '')
        // offset 续读：只推进读取窗，白名单纪律不变（地址仍只来自上一次 search）。
        const off = typeof a.offset === 'number' && Number.isFinite(a.offset) ? Math.max(0, Math.trunc(a.offset)) : 0
        const shadowed = host.shadowedSeqsOf(session)
        const state = nodeStateOf(session, seq, s => shadowed.has(s))
        const info = recallBudgetState({ stateOf: s => host.stateOf(s), charsPerToken: host.charsPerToken }, session)
        const allowed = Math.min(info.perCallLimit, info.remaining)
        const tag = '--- hit=' + seq + ' ' + (entry.kind === 'R' ? 'tool-result' : entry.kind === 'U' ? 'user' : 'assistant')
          + ' turn=' + entry.turn + ' state=' + state
          + (off > 0 ? ' offset=' + off : '')
        pushBounded(st.recallCalls, { seq, hit: true, state }, host.telemetryCap)
        const RESERVED = 200
        const room = Math.max(0, allowed - tag.length - 1 - RESERVED)
        if (off >= text.length) {
          // 诚实越界句（先于预算分支：越界判定零成本，不该被"预算不足"挡成假阴性）。
          return host.budgetRecallText(session, tag + '\n[hit ' + seq + ' is ' + text.length
            + ' chars in total — offset=' + off + ' is past the end; nothing more to read]')
        }
        if (room <= 0) {
          return host.budgetRecallText(session, tag + '\n[budget too small this call — retry next turn (budget resets each turn)]')
        }
        if (text.length - off <= room) {
          return host.budgetRecallText(session, tag + '\n' + text.slice(off))
        }
        return host.budgetRecallText(session, tag + '\n' + text.slice(off, off + room))
          + '\n[hit ' + seq + ': showed chars ' + off + '–' + (off + room) + ' of ' + text.length
          + ' (budget cap) — continue with hit=' + seq + ' offset=' + (off + room)
          + '; the address lives until your next search]'
      }
      const kwRaw = typeof a.keyword === 'string' ? a.keyword.trim() : ''
      if (kwRaw === '') {
        return 'search_history: keyword is required (literal substring 2-100 chars). Label-addressed fetch goes through recall_history; list_labels shows the vocabulary.'
      }
      if (kwRaw.length < KEYWORD_MIN_CHARS || kwRaw.length > KEYWORD_MAX_CHARS || /[\r\n\t\x00-\x1f]/.test(kwRaw)) {
        return 'search_history: keyword must be a literal substring of 2-' + KEYWORD_MAX_CHARS + ' chars without control characters (not a regex)'
      }
      const labels = resolveQueryLabels(ledger, a.labels)
      const needle = kwRaw.toLowerCase()
      const events = sessionEvents(session) as readonly unknown[]
      const rows: SearchRow[] = []
      const shadowed = host.shadowedSeqsOf(session)
      const stateOfSeq = (seq: number): string => nodeStateOf(session, seq, s => shadowed.has(s))
      // ---- 工具带（labels 在场=AND 交集逐字不动；=0 键时全账本） ----
      let candT: number[]
      if (labels.keys.size > 0) {
        let inter: Set<number> | null = null
        for (const k of labels.keys) {
          const s = ledger.stat(k)
          if (s === null) continue
          if (inter === null) inter = new Set(s.rootSeqs)
          else {
            const set = new Set(s.rootSeqs)
            for (const x of [...inter]) if (!set.has(x)) inter.delete(x)
          }
        }
        candT = inter === null ? [] : [...inter]
      } else {
        candT = ledger.prunedRootSeqs()
      }
      // 召回副本可见性裁决（2026-11-23，与 queryPruned 同收口）：裁定 2 剪下的召回
      // 结果携带与原文相同的 document:/errorcode: 键，R 带对原文+副本双命中（行内
      // ×N 只治单 atom 行级、不跨 atom）。labels 未点名 tool: 召回族键时剔除副本；
      // 点名时放行（审计形）。hit= 第二跳不受本闸（白名单=先前 surfacing 行）。
      if (!namesRecallFamilyKey(labels.keys)) {
        candT = candT.filter(seq => {
          const e = ledger.entryOf(seq)
          return e === null || !isRecallTool(e.tool)
        })
      }
      for (const seq of candT) {
        const raw = rawEventText(session, seq)
        if (raw === null) continue
        const h = collectHits(raw.text, needle)
        if (h.count === 0) continue
        const e = ledger.entryOf(seq)
        rows.push({
          seq, kind: 'R', turn: e?.turn ?? '?', chars: raw.text.length,
          score: Math.min(h.count, RECALL_SEARCH_TF_CAP), hits: h.count, first: h.positions[0] as number, positions: h.positions,
          tool: e?.tool ?? '', verdict: e === null ? 'ok' : e.failed ? 'failed' : e.errorish ? 'error-sig' : 'ok',
          labels: labels.keys.size > 0 ? [...labels.keys].join(',') : ledger.labelKeysOf(seq).join(','),
          state: stateOfSeq(seq),
        })
      }
      // ---- 散文带（仅 keyword-only；独立 cap 从旧到新，P7★） ----
      // offset 续翻（定点回放实锤 2026-11-26：旧世界 cap 触线后"retry or refine"是
      // 空承诺——重试只会从最旧重扫，更新的内容永远出不了界）。offset=散文流字符
      // 游标，页脚给 next；与 hit= 的 offset 同语义（"从第 N 字继续读"）。
      const scanOffset = typeof a.offset === 'number' && Number.isFinite(a.offset) ? Math.max(0, Math.trunc(a.offset)) : 0
      const proseMode = labels.wanted.length === 0 && labels.keys.size === 0
      let proseTruncated = false
      let proseScanned = 0
      let proseTotal = 0
      if (proseMode) {
        const cap = factor.proseScanCapOverride()
          ?? defaultProseCapChars(st.resolvedWindowTokens, liveBlendCharsPerToken(session, host.charsPerToken))
        const scan = scanProseHits(events as never, needle, cap, scanOffset)
        proseTruncated = scan.truncated
        proseScanned = scan.scannedChars
        proseTotal = scan.totalChars
        for (const h of scan.hits) {
          const text = proseTextOf(events[h.seq] as never)
          if (text === null) continue
          const ev = events[h.seq] as { type?: string }
          rows.push({
            seq: h.seq, kind: ev.type === 'user/message' ? 'U' : 'A', turn: turnAtSeq(events, h.seq),
            chars: h.chars, score: Math.min(h.hits, RECALL_SEARCH_TF_CAP), hits: h.hits, first: h.first, positions: h.positions, state: stateOfSeq(h.seq),
          })
        }
      }
      rows.sort((x, y) => y.score - x.score || x.seq - y.seq)
      const nR = rows.reduce((k, r) => k + (r.kind === 'R' ? 1 : 0), 0)
      const nP = rows.length - nR
      const echo: string[] = []
      if (labels.remapped.length > 0) echo.push('[label suffix-resolved: ' + labels.remapped.join('; ') + ' — use the full form next time]')
      if (labels.ambiguous.length > 0) echo.push('[ambiguous path suffix, not resolved: ' + labels.ambiguous.join('; ') + ']')
      if (labels.unknown.length > 0) echo.push('[labels not in the pruned ledger, ignored: ' + labels.unknown.join(', ') + ']')
      const header = 'search_history "' + kwRaw.slice(0, 40) + (kwRaw.length > 40 ? '…' : '') + '": '
        + rows.length + ' hit(s) — tool×' + nR + ' + prose×' + nP
        + (proseMode ? ' (prose band scanned ' + proseScanned + ' chars)' : ' (labels filter on: tool band only)')
      if (rows.length === 0) {
        pushBounded(st.recallCalls, { seq: -1, hit: false }, host.telemetryCap)
        st.searchIndex = null
        st.searchQuery = kwRaw
        const nextOff = scanOffset + proseScanned
        const foot = proseTruncated
          ? '\n[scan cap hit — prose window chars ' + scanOffset + '–' + nextOff + ' of ' + proseTotal + ' searched, no match there yet; keep paging with the same keyword and offset=' + nextOff
            + (nextOff > scanOffset ? '' : ' (page did not advance — lengthen the keyword)') + ']'
          : scanOffset > 0 ? '\n[end of prose surface: everything past offset=' + scanOffset + ' was searched too — no more pages]' : ''
        return host.budgetRecallText(session, header + '\nno matches in pruned originals or conversation prose'
          + (echo.length > 0 ? '\n' + echo.join('\n') : '')) + foot
      }
      // ---- N>阈值：标签分布直方图（faceted search 形；无预览/无索引，逼细化） ----
      const lim = typeof a.limit === 'number' && Number.isFinite(a.limit) ? Math.max(1, Math.min(RECALL_SEARCH_FACET_N, Math.trunc(a.limit))) : undefined
      if (rows.length > RECALL_SEARCH_FACET_N && lim === undefined) {
        pushBounded(st.recallCalls, { seq: -1, hit: true }, host.telemetryCap)
        st.searchIndex = null
        st.searchQuery = kwRaw
        // 命名避「共现」（该词已被 errSig 因子与 1.x 共现边占用，S9）。
        const buckets = new Map<string, number>()
        let uHits = 0
        let aHits = 0
        for (const r of rows) {
          if (r.kind !== 'R') { if (r.kind === 'U') uHits += 1; else aHits += 1; continue }
          const others = ledger.labelKeysOf(r.seq).filter(k => !labels.keys.has(k))
          if (others.length === 0) { buckets.set('(no-label)', (buckets.get('(no-label)') ?? 0) + 1); continue }
          for (const k of others) buckets.set(k, (buckets.get(k) ?? 0) + 1)
        }
        // 桶序=count desc → key 字典 asc（显式断键，R6）。
        const sorted = [...buckets].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))
        const dist = sorted.slice(0, 20).map(([k, n]) => '  ' + k + ' ×' + n + '(hits)')
        if (sorted.length > 20) dist.push('  …+' + (sorted.length - 20) + ' more labels')
        return host.budgetRecallText(session, header + '\n[' + rows.length
          + ' hits exceed the listing threshold ' + RECALL_SEARCH_FACET_N + ' — nothing is previewed. Distribution among hits (refine by adding one of these labels, lengthening the keyword, or pass limit= to page):]'
          + (dist.length > 0 ? '\n' + dist.join('\n') : '')
          + '\n  prose among hits: User×' + uHits + ' / Assistant×' + aHits
          + (echo.length > 0 ? '\n' + echo.join('\n') : ''))
      }
      // ---- 分层预览 + 装配钳（先缩预览后削行） ----
      const tierTok = lim !== undefined ? RECALL_SEARCH_PAGE_TOK : rows.length <= RECALL_SEARCH_FLAT_N ? RECALL_SEARCH_FLAT_TOK : RECALL_SEARCH_MID_TOK
      const info = recallBudgetState({ stateOf: s => host.stateOf(s), charsPerToken: host.charsPerToken }, session)
      const allowed = Math.min(info.perCallLimit, info.remaining)
      const RESERVED = 260
      const cpt = host.charsPerToken
      const lines: string[] = [header, ...echo]
      const index = new Map<number, { kind: 'R' | 'U' | 'A'; turn: number | string }>()
      let used = header.length + 1
      let liveShown = 0
      let collapsedLive = 0
      let notShown = 0
      const shown = lim === undefined ? rows : rows.slice(0, lim)
      for (let i = 0; i < shown.length; i++) {
        const r = shown[i] as SearchRow
        if (r.state === 'live') {
          if (liveShown >= RECALL_SEARCH_LIVE_MERGE_K) { collapsedLive += 1; continue }
          liveShown += 1
        }
        const text = r.kind === 'R' ? (rawEventText(session, r.seq)?.text ?? '') : (proseTextOf(events[r.seq] as never) ?? '')
        const kindLabel = r.kind === 'R' ? 'R·' + r.tool + ' ' + (r.verdict ?? 'ok') : r.kind
        const meta = '- hit=' + r.seq + ' · ' + kindLabel + ' · turn=' + r.turn + ' · ' + r.chars + ' chars · state=' + r.state
          + ' · ×' + r.hits
          + (r.kind === 'R' && r.labels !== undefined && r.labels !== '' ? ' · labels=' + r.labels : '')
        const shrinkToks = [tierTok, Math.min(tierTok, RECALL_SEARCH_MID_TOK), 0]
        let rowLine = ''
        for (const t of shrinkToks) {
          const prev = t > 0 ? ' · hit:"' + buildPreviews(text, r.positions, needle.length, t, cpt) + '"' : ''
          rowLine = meta + prev
          if (used + rowLine.length + 1 + RESERVED <= allowed) break
        }
        if (used + rowLine.length + 1 + RESERVED > allowed) {
          notShown = shown.length - i - collapsedLive
          break
        }
        lines.push(rowLine)
        used += rowLine.length + 1
        index.set(r.seq, { kind: r.kind, turn: r.turn })
      }
      if (collapsedLive > 0) {
        lines.push('[+' + collapsedLive + ' live hit(s) skipped — already in your visible context]')
      }
      pushBounded(st.recallCalls, { seq: shown[0]?.seq ?? -1, hit: true }, host.telemetryCap)
      st.searchIndex = index.size > 0 ? index : null
      st.searchQuery = kwRaw
      const footers: string[] = []
      if (notShown > 0) footers.push('[+' + notShown + ' row(s) not shown — per-call budget is small; retry next turn (budget resets each turn) or narrow]')
      if (proseTruncated) {
        const nextOff = scanOffset + proseScanned
        footers.push('[scan cap hit — prose scan page = chars ' + scanOffset + '–' + nextOff + ' of ' + proseTotal
          + ': newer prose NOT yet searched. Call again with the same keyword and offset=' + nextOff
          + ' for the next page (re-running bare restarts from the oldest content)]')
      } else if (scanOffset > 0) {
        footers.push('[end of prose surface: all ' + proseTotal + ' prose chars searched through this page — no more pages]')
      }
      const foot = footers.length > 0 ? '\n' + footers.join('\n') : ''
      const body = lines.length === 1 && index.size === 0 && collapsedLive === 0
        ? header + '\n[budget too small this call to show any hit row — retry next turn]'
        : lines.join('\n')
      return host.budgetRecallText(session, body) + foot
    },
  })
  ctx.tools.register(tool)
}
