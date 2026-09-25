/**
 * 召回工具注册（P5 Wave 3 第 4 步，C 报告 S1 + §4 蓝图 A：recall-tools 模块）。
 *
 * 从 hub `argp-graph-engine.ts` 构造器迁出的三个 defineTool 闭包：
 * `recall_pruned`（按 seq 召回原文，含版本链重定向）/ `list_pruned`（pruned 列表 +
 * 区间模式原始日志扫描）/ `recall`（内容查询召回）。闭包体逐字保留，仅 `this.x` →
 * `host.x`（窄接口 + `this as unknown as RecallToolsHost` 调用，编译期类型、运行时
 * 同一实例，方法引用经 host 派发回 class 薄编排方法，this 绑定语义不变）。
 *
 * 构造器侧副作用顺序不变：本函数在构造器原位置被调用，三个
 * `ctx.tools.register(...)` 的先后次序与原先逐字一致。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Session } from '@deepseek-ai/dsh-session'
import type { AtomType } from './argp-types.js'
import type { NodeState } from './log-access.js'
import { eventText, formatLogRow, formatRecallOutcome, queryLogRange, recallFromLog, sessionEvents, stateHeader } from './log-access.js'
import { classifyUserMessage } from './graph-build.js'
import { pushBounded } from './telemetry.js'
import type { PrunedNodeInfo } from './prune-selection.js'

/**
 * 窄宿主接口：三个工具闭包实际触达的引擎成员（字段 + 方法引用）。
 * 方法引用（shadowedSeqsOf/noteRecallHit/budgetRecallText/recallQuery）经 host 派发
 * 到 class 上的薄编排方法，运行时 this 仍是引擎实例——与原先闭包内 `this.method(...)`
 * 完全一致。
 */
export interface RecallToolsHost {
  session: Session | null
  recallCallsThisTurn: number
  recallCalls: { seq: number; hit: boolean; state?: NodeState }[]
  telemetryCap: number
  prunedNodeIndex: Map<number, PrunedNodeInfo>
  recallSourceSeq: number
  recallResultSeq: number
  shadowedSeqsOf: (session: Session) => Set<number>
  noteRecallHit: (seq: number) => void
  budgetRecallText: (text: string) => string
  recallQuery: (query: string, maxResults?: number) => string
}

/**
 * 每轮召回**调用次数**上限（1.7.1：由硬闸门 `3` 提升为宽松安全阀 `20`）。
 *
 * 1.7.0 用 `>= 3` 作主闸门：每轮第三次之后的召回直接被拒。实测（session-16188a24，
 * 15 轮）该闸门**从未触顶**——全会话 6 次召回调用分散在 2 轮（后 11 轮归零），
 * 跨会话基线 0.76%，配额白设；它唯一的实际作用是"模型真需要第四次召回时拿不到东西"，
 * 与"墓碑只给指针、把取回决定交给模型"的方向相反（负优化）。
 *
 * 1.7.1 把主闸门改为**字符预算**（`budgetRecallText` 的 `recallCharsUsed` 窗口，
 * 压缩换代时归零、耗尽时显式说明剩余额度），本计数退化为**防循环安全阀**：
 * 只拦"模型陷入召回循环"这种病态行为，不参与"要不要多取几次"的正常决策。
 * 取值参考：本档 493 次工具调用 / 15 轮 ≈ 33 次/轮 ⇒ 20 次/轮 仍是合理上限。
 */
const RECALL_CALLS_PER_TURN_LIMIT = 20

/**
 * 注册三个召回工具到 ctx.tools。构造器在原先内联定义工具的位置调用本函数，
 * 保持 register 调用顺序逐字不变。
 */
export function registerRecallTools(ctx: Context, host: RecallToolsHost): void {
  const recallTool = defineTool({
    name: 'recall_pruned',
    description: 'Retrieve the original text of any conversation node by its log seq, whether or not it is still in your visible context (text blocks verbatim; tool-call arguments are a JSON semantic-equivalent reconstruction when the host stores them as an object — the reply says so). Call it when an [elided ...] placeholder names the seq you need: every placeholder prints the seq(s) it replaced and its own recall_pruned(...) instruction. Pass one seq per call. The reply is prefixed with [recall seq=N state=shadowed|live|off-surface] so you know whether that content is currently visible. Everything ever said stays in the append-only log; never guess it. Use recall(query) when you remember keywords but not the seq, and list_pruned when you have neither.',
    parameters: { seq: { type: 'integer', description: 'log seq of the node to recover; placeholders show the seqs they replaced' } },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: async (args): Promise<string> => {
      const seq = (args as { seq?: number }).seq
      if (seq === undefined || host.session === null) return 'recall_pruned: no session bound'
      if (host.recallCallsThisTurn >= RECALL_CALLS_PER_TURN_LIMIT) {
        return 'recall_pruned: per-turn call limit reached (' + RECALL_CALLS_PER_TURN_LIMIT
          + ' calls). This is a loop guard, not a content limit — retrieved text is capped by a separate '
          + 'character budget. Prefer recall(query) with keywords when you need several nodes at once, or retry next turn.'
      }
      host.recallCallsThisTurn += 1
      // P1 修复 (b)：不再用 shadowedSeqsOf 门控。数据路径本来就是全日志级的
      // （eventText 直接索引 sessionEvents(session)[seq]），只有越界才算失败；返回值带状态标签，
      // 使掉出可见上下文但未被 ARGP 替换的节点（适配器窗口丢弃 / 从不进 surface）也可召回。
      const shadowed = host.shadowedSeqsOf(host.session)
      const outcome = recallFromLog(host.session, seq, s => shadowed.has(s), eventText)
      pushBounded(host.recallCalls, { seq, hit: outcome.ok, state: outcome.ok ? outcome.state : undefined }, host.telemetryCap)
      if (!outcome.ok) return formatRecallOutcome('recall_pruned', seq, outcome)
      host.noteRecallHit(seq)
      // 版本链重定向（2026-08-23）：被剪旧 R 若属于某路径版本链，重定向返回该路径最新存活版本原文，
      // 替代旧值。避免模型基于已过时的旧快照做决定（旧值正是被剪的原因）；文件仍在演进时
      // 模型要的是「现在长什么样」。保留 state 标签说明这是重定向结果。
      const redirect = host.prunedNodeIndex.get(seq)?.latestOfPath
      if (redirect !== undefined && redirect !== seq) {
        const latestOutcome = recallFromLog(host.session, redirect, s => shadowed.has(s), eventText)
        if (latestOutcome.ok) {
          const result = stateHeader(seq, latestOutcome.state)
            + '\n[version-chain redirect: seq ' + seq + ' was superseded by newer version seq ' + redirect + ' of the same path; returning the latest]\n'
            + host.budgetRecallText(latestOutcome.text)
          host.recallSourceSeq = seq
          host.recallResultSeq = host.session.seq
          return result
        }
      }
      const result = formatRecallOutcome('recall_pruned', seq, outcome, text => host.budgetRecallText(text))
      // §3-3 recall 价值继承：记录"旧原子 seq → 本次 recall 结果将被 append 为的新 R 原子 seq"。
      // dsh 在工具 execute 返回后 append tool/result 事件，其 seq = 当前事件总数。
      host.recallSourceSeq = seq
      host.recallResultSeq = host.session.seq
      return result
    },
  })
  ctx.tools.register(recallTool)

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
    execute: async (args): Promise<string> => {
      if (host.session === null) return 'list_pruned: no session bound'
      const shadowed = host.shadowedSeqsOf(host.session)
      const filters = (args ?? {}) as {
        turn?: number
        type?: string
        keyword?: string
        fromSeq?: number
        toSeq?: number
        limit?: number
      }
      // P1 修复 (b) 的另一半：区间模式 = 发现原语。去门控只解决"知道 seq 就能取"，
      // 掉出渲染窗口的 live 节点没有 tombstone 也不带 seq，模型需要能按区间查全日志补集。
      if (filters.fromSeq !== undefined || filters.toSeq !== undefined) {
        const total = host.session.seq
        const limit = Math.max(1, Math.min(200, filters.limit ?? 50))
        const range = queryLogRange(host.session, {
          fromSeq: filters.fromSeq ?? 0,
          toSeq: filters.toSeq ?? total - 1,
          turn: filters.turn,
          type: filters.type,
          keyword: filters.keyword,
          limit,
        }, s => shadowed.has(s), eventText)
        if (range.rows.length === 0) {
          return 'list_pruned (range mode): no node with text in seq '
            + (filters.fromSeq ?? 0) + '..' + (filters.toSeq ?? total - 1) + ' matches the filters'
        }
        const header = 'list_pruned (range mode): ' + range.rows.length + ' node(s) in seq '
          + (filters.fromSeq ?? 0) + '..' + (filters.toSeq ?? total - 1)
          + ' (log has ' + total + ' events; state=shadowed means ARGP pruned it, '
          + 'live means still on the surface, off-surface means log-only)'
          + (range.truncated ? '; output capped at limit=' + limit + ', narrow the range or raise limit' : '')
        const rangeLines = range.rows.map(row => {
          const indexed = host.prunedNodeIndex.get(row.seq)
          const citedBy = indexed !== undefined && indexed.citedBySeq.length > 0
            ? ' citedBy=' + indexed.citedBySeq.join(',')
            : ''
          return formatLogRow(row, citedBy)
        })
        return header + '\n' + rangeLines.join('\n')
      }
      const lines: string[] = []
      const seqs = [...shadowed].sort((a, b) => a - b)
      for (const seq of seqs) {
        const event = sessionEvents(host.session)[seq]
        if (event === undefined) continue
        const data = event.data as Record<string, unknown> | undefined
        const turn = typeof data?.turn === 'number' ? (data.turn as number) : 0
        if (filters.turn !== undefined && turn !== filters.turn) continue
        let type: AtomType
        if (event.type === 'user/message') {
          type = classifyUserMessage(data)
        } else if (event.type === 'assistant/message') {
          type = 'A'
        } else if (event.type === 'tool/result') {
          type = 'R'
        } else {
          type = 'X'
        }
        if (filters.type !== undefined && type !== filters.type) continue
        const text = eventText(host.session, seq)
        if (filters.keyword !== undefined && !text.includes(filters.keyword)) continue
        const firstLine = text.split('\n').map(l => l.trim()).find(l => l !== '') ?? ''
        const preview = firstLine.length > 120 ? firstLine.slice(0, 120) + '…' : firstLine
        const indexed = host.prunedNodeIndex.get(seq)
        const citedBy = indexed !== undefined && indexed.citedBySeq.length > 0
          ? ' citedBy=' + indexed.citedBySeq.join(',')
          : ''
        lines.push('seq=' + seq + ' type=' + type + ' turn=' + turn + ' state=shadowed' + citedBy + ' first=' + preview)
      }
      if (lines.length === 0) {
        return 'list_pruned: no pruned node matches the filters. '
          + 'If the content you need was never replaced by a placeholder, retry with range mode '
          + '(fromSeq/toSeq) to scan the raw log window.'
      }
      return lines.join('\n')
    },
  })
  ctx.tools.register(listPrunedTool)

  const recallQueryTool = defineTool({
    name: 'recall',
    description: 'Search nodes that are no longer in your visible context by content query and return matching original text. Make this your first recall attempt when you do not know the exact seq: pass a few distinctive keywords from the content you need (matching is a plain substring test over node text, so any word that literally appeared works). It returns several matches in one call. Use recall_pruned(seq) instead when a placeholder already names the seq.',
    parameters: {
      query: { type: 'string', description: 'keywords or substring to search in content that left the visible context' },
      maxResults: { type: 'integer', description: 'optional maximum number of matches to return (default 5)' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: async (args): Promise<string> => {
      if (host.session === null) return 'recall: no session bound'
      if (host.recallCallsThisTurn >= RECALL_CALLS_PER_TURN_LIMIT) {
        return 'recall: per-turn call limit reached (' + RECALL_CALLS_PER_TURN_LIMIT
          + ' calls). This is a loop guard, not a content limit — narrow the query or retry next turn.'
      }
      host.recallCallsThisTurn += 1
      const query = (args as { query?: string }).query ?? ''
      const maxResults = (args as { maxResults?: number }).maxResults ?? 5
      return host.budgetRecallText(host.recallQuery(query, maxResults))
    },
  })
  ctx.tools.register(recallQueryTool)
}
