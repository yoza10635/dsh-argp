/**
 * 因子臂召回面（design-2.0 §1.4/§3.2）：`recall_history` + `list_labels` 两个
 * defineTool——factor 臂**只挂这两个**，graph 臂三件套（recall_pruned/list_pruned/
 * recall）不挂（挂载分流在 argp-graph-engine 构造期，按 engine 判别式）。
 *
 * 与 graph 臂的口径差：
 *  - 入口是**标签**不是 seq——factor 桩只写标签（seq 不进 prompt 是 §1.2 物理下限的
 *    直接推论），词表行同样只给标签；
 *  - 查询内核 = FactorLedger.queryPruned（交集优先 + 新鲜度降序 + cursor/epoch
 *    分页；epoch 漂移如实告警不假装稳定）；原文经 rawEventText 取日志 append 根源
 *    （被剪 R 的原事件仍在 append-only 日志里，text 块逐字；重建部分带 note）；
 *  - 预算照抄 graph 臂契约（budgetRecallText：单次 5% + 累计 10% 窗口、耗尽显式
 *    说明、压缩事务归零）——发现类工具 list_labels 同付费（0-4 教训：白嫖通道会把
 *    预算挤占面变成发现面本身）。
 *
 * 单点复用（禁各写一份）：sessionOfToolCall / RECALL_CALLS_PER_TURN_LIMIT ← recall-tools.ts。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionRuntimeState } from '../session-state.ts'
import { nodeStateOf, rawEventText } from '../log-access.ts'
import { RECALL_CALLS_PER_TURN_LIMIT, sessionOfToolCall, type RecallToolsHost } from '../recall-tools.ts'
import { VOCAB_FACETS, facetOfKey, type VocabFacet } from './factor-ledger.ts'
import type { FactorEngine } from './engine.ts'

/** 窄宿主：两个闭包实际触达的引擎成员（同 recall-tools 的窄接口纪律）。 */
export interface RecallLabelsHost {
  /** 焦点会话（exec.agent.session 缺席时的单会话兜底）。 */
  session: Session | null
  sessionCount: () => number
  stateOf: (session: Session) => SessionRuntimeState
  shadowedSeqsOf: (session: Session) => Set<number>
  budgetRecallText: (session: Session, text: string) => string
}

/** 裸标签（无 facet 前缀）的展开候选——查询向宽容，词表向 fail-closed 不冲突：
 *  出口渲染拦的是**进 prompt 的键**，这里放行的是**模型抄错形态的查询**。 */
const FACET_PREFIXES = ['document:', 'command:', 'errorcode:', 'scope:'] as const

/**
 * 注册因子臂召回两工具。`factor` 闭包捕获引擎的**同一个** FactorEngine 实例
 * （账本/epoch 与发射侧共享，构造期装配一次）。
 */
export function registerRecallLabels(ctx: Context, factor: FactorEngine, host: RecallLabelsHost): void {
  const resolveSession = (exec: unknown): Session | null =>
    sessionOfToolCall(exec, host as unknown as RecallToolsHost)

  const recallHistoryTool = defineTool({
    name: 'recall_history',
    description: 'Retrieve the original text of tool results that were pruned from your visible context, addressed by ENTITY LABEL instead of seq. Pass labels exactly as shown in a [已剪·因子 ...] stub or the vocabulary section: document:<path>, command:<family>, errorcode:<CODE> (a bare name without prefix is matched against all facets). Items matching several labels come first; within a tie, newest first. Returns originals verbatim from the append-only log under a recall budget; when more matches exist the reply ends with cursor/epoch values to pass back for the next page. This is your FIRST recall attempt in this engine — pruned content is keyed by entity, there is no seq-based recall. Use list_labels(category) to discover labels you cannot recall.',
    parameters: {
      labels: { type: 'array', items: { type: 'string' }, description: 'one or more labels to intersect, verbatim from a stub or the vocabulary (e.g. ["document:c:/proj/a.ts","errorcode:ERESOLVE"])' },
      limit: { type: 'integer', description: 'optional maximum items to return (default 5, cap 20)' },
      cursor: { type: 'integer', description: 'optional continuation cursor from a previous reply (must be paired with its epoch)' },
      epoch: { type: 'integer', description: 'optional ledger epoch from a previous reply; mismatch = the ledger changed, results are re-sorted from scratch and the reply says so' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: async (args, exec): Promise<string> => {
      const session = resolveSession(exec)
      if (session === null) return 'recall_history: no session bound (multi-session host: recall requires agent context; single-session hosts bind implicitly)'
      const st = host.stateOf(session)
      if (st.recallCallsThisTurn >= RECALL_CALLS_PER_TURN_LIMIT) {
        return 'recall_history: per-turn call limit reached (' + RECALL_CALLS_PER_TURN_LIMIT
          + ' calls). This is a loop guard, not a content limit — retrieved text is capped by a separate '
          + 'character budget. Intersect more labels to get several items per call, or retry next turn.'
      }
      st.recallCallsThisTurn += 1
      const a = (args ?? {}) as { labels?: string[]; limit?: number; cursor?: number; epoch?: number }
      const wanted = [...new Set((Array.isArray(a.labels) ? a.labels : [])
        .map(l => (typeof l === 'string' ? l.trim() : '')).filter(l => l !== ''))]
      if (wanted.length === 0) {
        return 'recall_history: pass at least one label exactly as shown in a [已剪·因子] stub or the '
          + 'vocabulary section (document:<path> / command:<family> / errorcode:<CODE>); '
          + 'call list_labels to see the full pruned vocabulary.'
      }
      const ledger = factor.ledger
      const keys = new Set<string>()
      const unknown: string[] = []
      for (const w of wanted) {
        if (facetOfKey(w) !== null) {
          if (ledger.stat(w) !== null) keys.add(w)
          else unknown.push(w)
          continue
        }
        // 大小写两形都试：document 键是 canonical 小写形（盘符归一），模型手敲
        // `C:/...` 直拼查不中；errorcode 大小写敏感，只认索引里真实存在的形。
        const variants = new Set([w, w.toLowerCase()])
        const hits: string[] = []
        for (const v of variants) for (const p of FACET_PREFIXES) {
          const k = p + v
          if (ledger.stat(k) !== null) hits.push(k)
        }
        if (hits.length === 0) unknown.push(w)
        else for (const k of hits) keys.add(k)
      }
      const limit = Math.max(1, Math.min(20, a.limit ?? 5))
      const q = ledger.queryPruned({ labels: [...keys], limit, cursor: a.cursor, epoch: a.epoch })
      if (q.rows.length === 0) {
        return 'recall_history: no pruned item matches (' + wanted.join(', ') + ')'
          + (unknown.length > 0 ? ' — labels not in the pruned ledger, ignored: ' + unknown.join(', ') : '')
          + '. The ledger holds ' + ledger.prunedCount + ' pruned item(s) total; '
          + 'if the label came from memory rather than a stub/vocabulary line, call list_labels to see the real one.'
      }
      const shadowed = host.shadowedSeqsOf(session)
      const lines: string[] = []
      lines.push('recall_history: ' + q.rows.length + ' item(s) by labels [' + [...keys].join(', ')
        + '] (ledger holds ' + ledger.prunedCount + ')')
      // 未命中的查询标签如实回显（不静默）：模型必须知道自己查询里哪半是空想。
      if (unknown.length > 0) lines.push('[labels not in the pruned ledger, ignored: ' + unknown.join(', ') + ']')
      if (q.epochStale) lines.push('[warning: ledger epoch changed since your cursor — results re-sorted from scratch, continue with the cursor/epoch below]')
      for (const row of q.rows) {
        const state = nodeStateOf(session, row.rootSeq, s => shadowed.has(s))
        const tag = '--- seq=' + row.rootSeq + ' turn=' + row.turn + ' state=' + state + ' hit=' + row.hitLabels.join(',')
        const raw = rawEventText(session, row.rootSeq)
        if (raw === null) {
          lines.push(tag + ' (this log event carries no model-visible text)')
          continue
        }
        lines.push(tag + (raw.reconstructed ? ' [reconstructed: ' + (raw.note ?? '') + ']' : '') + '\n' + raw.text)
      }
      if (q.nextCursor !== null) {
        lines.push('[more matches: call recall_history again with cursor=' + q.nextCursor + ' epoch=' + q.epoch + ']')
      }
      return host.budgetRecallText(session, lines.join('\n'))
    },
  })
  ctx.tools.register(recallHistoryTool)

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
    execute: async (args, exec): Promise<string> => {
      const session = resolveSession(exec)
      if (session === null) return 'list_labels: no session bound (multi-session host: recall requires agent context)'
      const a = (args ?? {}) as { category?: string; limit?: number }
      let cats: readonly VocabFacet[]
      if (a.category !== undefined && a.category.trim() !== '') {
        const c = a.category.trim() as VocabFacet
        if (!(VOCAB_FACETS as readonly string[]).includes(c)) {
          return 'list_labels: unknown category "' + a.category + '" (valid: ' + VOCAB_FACETS.join(' | ') + ')'
        }
        cats = [c]
      } else cats = VOCAB_FACETS
      const limit = Math.max(1, Math.min(200, a.limit ?? 30))
      const ledger = factor.ledger
      const lines: string[] = ['list_labels: vocabulary of the pruned ledger (' + ledger.prunedCount + ' pruned item(s))']
      let rejected = 0
      for (const facet of cats) {
        const v = ledger.vocabularyRows(facet, limit)
        rejected += v.rejected
        if (v.rows.length === 0) {
          lines.push(facet + ': no pruned item carries a ' + facet + ' label')
          continue
        }
        lines.push(facet + ' — ' + v.rows.length + ' label(s)' + (v.omitted > 0 ? ' (' + v.omitted + ' more, raise limit)' : '') + ':')
        for (const r of v.rows) lines.push('- ' + r.key + ' ×' + r.count + ' (last seen turn ' + r.lastSeenTurn + ')')
      }
      // fail-closed 出口可见：被当前文法拒收的键留索引不进 prompt，但拒收本身必须可查。
      if (rejected > 0) lines.push('[rejected by current label grammar, kept in index but not listable: ' + rejected + ']')
      lines.push('Retrieve any of these with recall_history(["<key>"]).')
      // 发现类同付费（0-4 教训：免费列表会把预算挤占面变成发现面）。
      return host.budgetRecallText(session, lines.join('\n'))
    },
  })
  ctx.tools.register(listLabelsTool)
}
