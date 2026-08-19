/**
 * 日志级访问原语（P1 修复路线 (b) 的公共实现）。
 *
 * 背景：三个引擎（argp-graph / recall / argp-t1）原本在 recall_pruned 工具里用同一道
 * 布尔门控 `shadowedSeqs(session).has(seq)`，未命中直接拒答 "not a pruned node"。
 * 但数据路径本来就是全日志级的（eventText 直接索引 session.events[seq]），门控是唯一障碍：
 * 掉出可见上下文但未被 ARGP 替换的节点（如适配器按 contextWindow 丢弃的 live surface 节点、
 * 或从不进 surface 的 tool/call）对模型既不可见、也不可召回 —— 即 P1「盲区」。
 *
 * 本模块把 recall 原语从"查 pruned 索引"升级为"按 seq 查 append-only 日志、无视节点状态"，
 * 并携带状态标签（shadowed / live / off-surface），使模型知道取回的内容当前是否可见
 * —— 否则引用契约（cites 该不该带）无法执行。越界 seq 才报错。
 */
import type { Session } from '@deepseek-ai/dsh-session'

/**
 * 节点相对可见上下文的状态：
 *  - `shadowed`：已被 surfaceOp replace 遮蔽（ARGP 剪枝产物），确定不在可见上下文里。
 *  - `live`：仍在 session.surface.nodes 上。注意"在 surface 上"不等于"模型看得见"——
 *    适配器组装请求时可能按 contextWindow 截断最旧的 surface 消息（见 B-6）。
 *  - `off-surface`：合法事件但从未进入 surface（tool/call、turn/start、compaction/* 等）。
 */
export type NodeState = 'shadowed' | 'live' | 'off-surface'

/** 全日志扫描收集被遮蔽 surface seq（replace 事件 sourceEventSeqs 的并集）。 */
export function scanShadowedSeqs(session: Session): Set<number> {
  const shadowed = new Set<number>()
  for (const event of session.events) {
    const op = (event as { surfaceOp?: unknown }).surfaceOp
    if (op !== undefined && op !== 'append') {
      for (const seq of (event as { sourceEventSeqs?: number[] }).sourceEventSeqs ?? []) {
        shadowed.add(seq)
      }
    }
  }
  return shadowed
}

/** 判定单个 seq 的状态。shadowed 优先（被遮蔽的节点也可能仍留在 surface 索引之外）。 */
export function nodeStateOf(session: Session, seq: number, isShadowed: (seq: number) => boolean): NodeState {
  if (isShadowed(seq)) return 'shadowed'
  for (const node of session.surface.nodes) {
    if (node === seq) return 'live'
  }
  return 'off-surface'
}

export type RecallOutcome =
  | { ok: true; state: NodeState; text: string }
  | { ok: false; reason: 'out-of-range'; total: number }
  | { ok: false; reason: 'no-text'; state: NodeState }

/**
 * 按 seq 从 append-only 日志取回原文，不再要求节点属于 pruned 集合。
 * 只有越界（日志里没有这个 seq）才算失败。
 */
export function recallFromLog(
  session: Session,
  seq: number,
  isShadowed: (seq: number) => boolean,
  textOf: (session: Session, seq: number) => string,
): RecallOutcome {
  const total = session.events.length
  if (!Number.isInteger(seq) || seq < 0 || seq >= total || session.events[seq] === undefined) {
    return { ok: false, reason: 'out-of-range', total }
  }
  const state = nodeStateOf(session, seq, isShadowed)
  const text = textOf(session, seq)
  if (text === '') return { ok: false, reason: 'no-text', state }
  return { ok: true, state, text }
}

const STATE_HINT: Record<NodeState, string> = {
  shadowed: 'pruned from the visible context by ARGP',
  live: 'still on the conversation surface, but it may sit outside the model render window',
  'off-surface': 'log-only node, never part of the rendered conversation',
}

/** 状态标签行：模型必须知道取回内容当前是否可见，才能正确执行引用契约。 */
export function stateHeader(seq: number, state: NodeState): string {
  return '[recall seq=' + seq + ' state=' + state + '] (' + STATE_HINT[state] + '; cite it if your answer uses it)'
}

/** 把 RecallOutcome 渲染成工具返回文本。budget 用于对正文套字数预算。 */
export function formatRecallOutcome(
  toolName: string,
  seq: number,
  outcome: RecallOutcome,
  budget: (text: string) => string = t => t,
): string {
  if (outcome.ok) return stateHeader(seq, outcome.state) + '\n' + budget(outcome.text)
  if (outcome.reason === 'out-of-range') {
    return toolName + ': seq ' + seq + ' is out of range (log has ' + outcome.total
      + ' events, valid seq 0..' + Math.max(0, outcome.total - 1) + ')'
  }
  return toolName + ': seq ' + seq + ' (state=' + outcome.state + ') exists in the log but carries no model-visible text'
}

/** 日志行的展示类型（比 AtomType 多 T=tool/call 与 other，因为区间模式会扫到非 surface 事件）。 */
export type LogRowType = 'U' | 'A' | 'R' | 'X' | 'T' | 'other'

export function logRowType(eventType: string, data: Record<string, unknown> | undefined): LogRowType {
  if (eventType === 'user/message') {
    return (data as { source?: { kind?: string } } | undefined)?.source?.kind === 'plugin' ? 'X' : 'U'
  }
  if (eventType === 'assistant/message') return 'A'
  if (eventType === 'tool/result') return 'R'
  if (eventType === 'tool/call') return 'T'
  return 'other'
}

export interface LogRow {
  seq: number
  type: LogRowType
  turn: number
  state: NodeState
  firstLine: string
}

export interface LogRangeQuery {
  fromSeq: number
  toSeq: number
  turn?: number
  type?: string
  keyword?: string
  limit: number
}

export interface LogRangeResult {
  rows: LogRow[]
  scanned: number
  truncated: boolean
}

/**
 * 区间发现原语：列出 [fromSeq..toSeq] 内所有有正文的日志节点（含 live / off-surface）。
 * 这是 (b) 里容易被漏掉的一半 —— 去门控只解决"知道 seq 就能取"，区间模式解决
 * "模型怎么知道被窗口丢掉的节点的 seq"，把 list 从「剪枝清单」升级为「可见窗口补集查询」。
 */
export function queryLogRange(
  session: Session,
  query: LogRangeQuery,
  isShadowed: (seq: number) => boolean,
  textOf: (session: Session, seq: number) => string,
): LogRangeResult {
  const total = session.events.length
  const from = Math.max(0, Math.min(query.fromSeq, total - 1))
  const to = Math.max(from, Math.min(query.toSeq, total - 1))
  const rows: LogRow[] = []
  let scanned = 0
  let truncated = false
  for (let seq = from; seq <= to; seq += 1) {
    const event = session.events[seq]
    if (event === undefined) continue
    scanned += 1
    const data = event.data as Record<string, unknown> | undefined
    const type = logRowType(event.type, data)
    if (query.type !== undefined && type !== query.type) continue
    const turn = typeof data?.turn === 'number' ? (data.turn as number) : 0
    if (query.turn !== undefined && turn !== query.turn) continue
    const text = textOf(session, seq)
    if (text === '') continue
    if (query.keyword !== undefined && !text.includes(query.keyword)) continue
    if (rows.length >= query.limit) {
      truncated = true
      break
    }
    const firstLine = text.split('\n').map(l => l.trim()).find(l => l !== '') ?? ''
    rows.push({
      seq,
      type,
      turn,
      state: nodeStateOf(session, seq, isShadowed),
      firstLine: firstLine.length > 120 ? firstLine.slice(0, 120) + '…' : firstLine,
    })
  }
  return { rows, scanned, truncated }
}

export function formatLogRow(row: LogRow, extra = ''): string {
  return 'seq=' + row.seq + ' type=' + row.type + ' turn=' + row.turn
    + ' state=' + row.state + extra + ' first=' + row.firstLine
}
