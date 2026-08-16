/**
 * ARGP 建边版引擎（spike 5，M3）：原子化 + 建图 + 图序剪枝 + cites 义务。
 *
 * 按设计稿 §3-§7 移植，机制验证版简化（差异记入台账）：
 *  - 无版本链去重（§4.4）、summarize 降级默认关闭（§4.6.1，候选耗尽走 force_prune）、catalog 已支持
 *  - 占位主路径（§8.3 路径 b）+ 区间 replace；事务仿 spike 4（借 compaction/summary 语义，候选卡点 B-3）
 *  - 配对自保：A（含 tool-call 块）+ 应答 R 成组同剪；U 与 tombstone 永不参剪（不变式 6）。
 *    实测：dsh surface 无 tool/call 节点（SURFACE_EVENT_TYPES 三类），call 块内嵌在 assistant/message 里
 *  - cites 义务开启：正为回答母表待决项（本地新 SOTA 模型的 cites 服从率）
 *  - 触发/目标同一可见字符估算基准（不变式 2）；reasoning 块不计入预算（spike 4a 判决 C）
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { CompactionEngine, CompactionId, compactCheckpointSource, toolPairingBalancedAfter, toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction'
import type {
  CompactionAgentContext,
  CompactionResult,
  CompactionTrigger,
  ManualCompactAgentContext,
} from '@deepseek-ai/dsh-compaction'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Session } from '@deepseek-ai/dsh-session'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'

export type AtomType = 'U' | 'A' | 'R' | 'X' // X = compact tombstone/checkpoint；dsh surface 无 tool/call 节点（call 块内嵌在 A 里，SURFACE_EVENT_TYPES 实测）

export interface Atom {
  id: number            // 本次投影内局部递增
  seq: number           // 事件 seq（surface 节点）
  type: AtomType
  turn: number
  text: string          // 模型可见文本（A 已剥离 cites JSON）
  toolCallIds: string[] // A：发出的 tool-call id；R：应答的 call id —— 配对键（成对同剪防孤儿）
  cites: string[]       // 仅 A：声明的引用前缀（原文）
  citesFailed: boolean  // 仅 A：检测到 cites 尝试但解析失败 → 保守保护（§4.7）
}

export type EdgeLevel = 'critical' | 'supporting' | 'contextual'
export interface SemanticEdge { from: number; to: number; level: EdgeLevel }
export const EDGE_WEIGHTS: Record<EdgeLevel, number> = { critical: 10, supporting: 5, contextual: 2 }
const LEVEL_ORDER: Record<string, number> = { isolated: 0, contextual: 1, supporting: 2, critical: 3 }

export interface ArgpGraphConfig {
  windowTokens?: number   // 默认 16384
  retainTokens?: number   // 默认 8192
  recencyGuard?: number   // 默认 4（surface 末尾 N 节点不参剪）
  minSpanChars?: number   // 默认 512（微剪枝下限）
  charsPerToken?: number  // 默认 3.5（触发与目标同基准）
  /** 单次剪枝事务的最大贪心 pass 数（默认 16；生产档大批量剪枝应调高）。 */
  maxPasses?: number
  /** 触发保留余量（token）；默认 0。windowTokens 会先减去该值作为触发线。 */
  reserveTokens?: number
  /** 可选显式 token 测量函数；不传则退化为字符估算。 */
  measureTokens?: (session: Session) => { contextTokens: number; surfaceTokens: number }
  /** 是否启用 summarize 降级。默认 false：本地单 slot 模型下 summarize 会破坏 KV cache，ARGP 走 force_prune。 */
  enableSummarize?: boolean
}

export interface GraphPruneRecord {
  at: string
  compactionId: string
  intervals: { start: number; end: number; tombstoneSeq: number }[]
  startEventSeq: number
  summaryEventSeq: number
  endEventSeq: number
  shadowedSeqs: number[]
  prunedAtoms: { id: number; type: AtomType; seq: number }[]
  semanticEdges: number
  candidates: number
  charsBefore: number
  charsAfter: number
  forced: boolean
}



/** 从一个事件投影出模型可见文本（text + tool-call 概要 + tool-result 内层 text；reasoning 不算）。 */
export function eventText(session: Session, seq: number): string {
  const event = session.events[seq]
  if (event === undefined) return ''
  const data = event.data as Record<string, unknown> | undefined
  const parts: string[] = []
  if (event.type === 'tool/call') {
    const d = data as { name?: string; arguments?: unknown }
    parts.push('[tool-call ' + (d?.name ?? '?') + '(' + (typeof d?.arguments === 'string' ? d.arguments : JSON.stringify(d?.arguments ?? {})) + ')]')
    return parts.join('\n')
  }
  // dsh event shapes differ by type: user/message carries content at data.content,
  // assistant/message and tool/result carry it at data.message.content.
  const rawContent = event.type === 'user/message'
    ? (data as { content?: unknown[] } | undefined)?.content
    : (data as { message?: { content?: unknown[] } } | undefined)?.message?.content
  const content = Array.isArray(rawContent) ? (rawContent as { type: string; text?: string; name?: string; arguments?: unknown; content?: { type: string; text?: string }[] }[]) : []
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    if (block.type === 'tool-call') {
      parts.push('[tool-call ' + (block.name ?? '?') + '(' + (typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments ?? {})) + ')]')
    }
    if (block.type === 'tool-result') {
      for (const inner of block.content ?? []) if (inner.type === 'text' && typeof inner.text === 'string') parts.push(inner.text)
    }
  }
  return parts.join('\n')
}

/** 提取 A 文本尾部的 cites JSON（支持裸 JSON 与 ```json 围栏）；返回剥离后正文与前缀列表。 */
export function extractCites(text: string): { body: string; cites: string[]; attempted: boolean; parseFailed: boolean } {
  const fencedFull = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```\s*$/)
  const bareFull = text.match(/(\{\s*"cites"\s*:[\s\S]*?\})\s*$/)
  const raw = fencedFull?.[1] ?? bareFull?.[1]
  if (raw === undefined) {
    const attempted = text.includes('"cites"')
    return { body: text, cites: [], attempted, parseFailed: attempted }
  }
  try {
    const parsed = JSON.parse(raw) as { cites?: unknown }
    if (Array.isArray(parsed.cites) && parsed.cites.every(c => typeof c === 'string')) {
      const stripped = (fencedFull?.[0] ?? bareFull?.[0] ?? '').length
      return { body: text.slice(0, text.length - stripped).trimEnd(), cites: parsed.cites, attempted: true, parseFailed: false }
    }
    return { body: text, cites: [], attempted: true, parseFailed: true } // JSON 合法但形状不对 → 解析失败，保守保护
  } catch {
    return { body: text, cites: [], attempted: true, parseFailed: true }
  }
}
/** cites 服从率度量台账（C7-cites 判决用）。 */
export interface CiteStats { aAtoms: number; declared: number; resolved: number; ambiguous: number; failed: number }

/** list_pruned 工具的剪枝节点目录条目。 */
export interface PrunedNodeInfo {
  seq: number
  type: AtomType
  turn: number
  firstLine: string
  citedBySeq: number[]
}

export class ArgpGraphEngine extends CompactionEngine {
  static inject = ['tools', 'systemPrompt']

  readonly windowTokens: number
  readonly retainTokens: number
  readonly recencyGuard: number
  readonly minSpanChars: number
  readonly charsPerToken: number
  readonly maxPasses: number
  readonly reserveTokens: number
  readonly tokenMeterFn?: (session: Session) => { contextTokens: number; surfaceTokens: number }
  readonly enableSummarize: boolean

  readonly records: GraphPruneRecord[] = []
  readonly recallCalls: { seq: number; hit: boolean }[] = []
  readonly recallQueryCalls: { query: string; count: number; hits: number }[] = []
  readonly citeStats: CiteStats = { aAtoms: 0, declared: 0, resolved: 0, ambiguous: 0, failed: 0 }
  /** 最近一次建图的语义边（判决 G3 读：被引原子是否获得保护）。 */
  lastEdges: SemanticEdge[] = []

  /** 已剪节点目录（seq -> 元数据 + 依赖），供 list_pruned 查询；新事务覆盖旧 seq。 */
  readonly prunedNodeIndex = new Map<number, PrunedNodeInfo>()

  private session: Session | null = null
  private shadowedSession: Session | null = null
  private shadowedSet: Set<number> = new Set()
  private shadowedScanned = 0

  constructor(ctx: Context, config: ArgpGraphConfig = {}) {
    super(ctx)
    this.windowTokens = config.windowTokens ?? 16_384
    this.retainTokens = config.retainTokens ?? 8_192
    this.recencyGuard = config.recencyGuard ?? 4
    this.minSpanChars = config.minSpanChars ?? 512
    this.charsPerToken = config.charsPerToken ?? 3.5
    this.maxPasses = config.maxPasses ?? 16
    this.reserveTokens = config.reserveTokens ?? 0
    this.tokenMeterFn = config.measureTokens
    this.enableSummarize = config.enableSummarize ?? false

    const recallTool = defineTool({
      name: 'recall_pruned',
      description: 'Retrieve the original text of pruned conversation nodes. Call only when your answer depends on content behind an [elided seq=N..M ...] placeholder, or when an earlier value is absent from visible context. Pass one placeholder seq per call. Pruned content stays in the append-only log; never guess it.',
      parameters: { seq: { type: 'integer', description: 'log seq of the pruned node, shown in the placeholder' } },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      execute: async (args): Promise<string> => {
        const seq = (args as { seq?: number }).seq
        if (seq === undefined || this.session === null) return 'recall_pruned: no session bound'
        const hit = this.shadowedSeqsOf(this.session).has(seq)
        this.recallCalls.push({ seq, hit })
        if (!hit) return 'recall_pruned: seq ' + seq + ' is not a pruned node'
        const text = eventText(this.session, seq)
        return text === '' ? 'recall_pruned: seq ' + seq + ' recovered but carries no model-visible text' : text
      },
    })
    ctx.tools.register(recallTool)

    const listPrunedTool = defineTool({
      name: 'list_pruned',
      description: 'List pruned conversation nodes that are currently elided from visible context. Use this to find the seq you need before calling recall_pruned. Returns one line per pruned seq with seq, type, turn, first-line preview, and citedBy seqs when known. Optional filters: turn, type (A/R/U/X), keyword.',
      parameters: {
        turn: { type: 'integer', description: 'optional exact turn number filter' },
        type: { type: 'string', description: 'optional node type filter: A (assistant), R (tool result), U (user), X (checkpoint)' },
        keyword: { type: 'string', description: 'optional substring that must appear in the node text' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      execute: async (args): Promise<string> => {
        if (this.session === null) return 'list_pruned: no session bound'
        const shadowed = this.shadowedSeqsOf(this.session)
        const filters = (args ?? {}) as { turn?: number; type?: string; keyword?: string }
        const lines: string[] = []
        const seqs = [...shadowed].sort((a, b) => a - b)
        for (const seq of seqs) {
          const event = this.session.events[seq]
          if (event === undefined) continue
          const data = event.data as Record<string, unknown> | undefined
          const turn = typeof data?.turn === 'number' ? (data.turn as number) : 0
          if (filters.turn !== undefined && turn !== filters.turn) continue
          let type: AtomType
          if (event.type === 'user/message') {
            type = (data as { source?: { kind?: string } } | undefined)?.source?.kind === 'plugin' ? 'X' : 'U'
          } else if (event.type === 'assistant/message') {
            type = 'A'
          } else if (event.type === 'tool/result') {
            type = 'R'
          } else {
            type = 'X'
          }
          if (filters.type !== undefined && type !== filters.type) continue
          const text = eventText(this.session, seq)
          if (filters.keyword !== undefined && !text.includes(filters.keyword)) continue
          const firstLine = text.split('\n').map(l => l.trim()).find(l => l !== '') ?? ''
          const preview = firstLine.length > 120 ? firstLine.slice(0, 120) + '…' : firstLine
          const indexed = this.prunedNodeIndex.get(seq)
          const citedBy = indexed !== undefined && indexed.citedBySeq.length > 0
            ? ' citedBy=' + indexed.citedBySeq.join(',')
            : ''
          lines.push('seq=' + seq + ' type=' + type + ' turn=' + turn + citedBy + ' first=' + preview)
        }
        if (lines.length === 0) return 'list_pruned: no pruned nodes match filters'
        return lines.join('\n')
      },
    })
    ctx.tools.register(listPrunedTool)

    const recallQueryTool = defineTool({
      name: 'recall',
      description: 'Search pruned conversation nodes by content query and return matching original text. Use when you know roughly what was said but not the exact seq. Prefer list_pruned when you can identify by turn/type, and recall_pruned(seq) when you already know the seq.',
      parameters: {
        query: { type: 'string', description: 'keywords or substring to search in pruned content' },
        maxResults: { type: 'integer', description: 'optional maximum number of matches to return (default 5)' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      execute: async (args): Promise<string> => {
        if (this.session === null) return 'recall: no session bound'
        const query = (args as { query?: string }).query ?? ''
        const maxResults = (args as { maxResults?: number }).maxResults ?? 5
        return this.recallQuery(query, maxResults)
      },
    })
    ctx.tools.register(recallQueryTool)

    // 压缩/恢复契约：只负责“视图可能被剪 + 必要时用 recall 工具找回”。
    ctx.systemPrompt.section({
      name: 'argp-contract',
      order: 150,
      text: () => {
        const base = 'Context compression (ARGP):\n'
          + 'Your visible context is a pruned view of the full conversation. Older parts may have been replaced by placeholders like [elided seq=N..M ...]; absence from the visible context does not mean it was never said.\n'
          + '- Every reply must be self-contained plain text: state facts, conclusions, and content directly in natural language. Never answer by pointing at earlier context items instead of restating the needed content.\n'
          + '- When your answer depends on an elided placeholder, use list_pruned to find the right seq, then call recall_pruned(seq) or recall(query) to recover the full text before answering. Never reconstruct elided facts from memory.'
        const catalog = this.catalogText(20, 70)
        return catalog === '' ? base : base + '\n\n' + catalog
      },
    })

    // 引用输出协议：独立 PromptSection，只负责 cites 格式；recall 行为不在这里要求。
    ctx.systemPrompt.section({
      name: 'argp-cites',
      order: 151,
      text: () => 'Citation declaration (ARGP):\n'
        + 'If your final reply used one or more earlier visible items, append ONE JSON block at the end of your final text, after your complete answer:\n'
        + '{"cites":["the gateway release passes. Neither","Here is the incident-window data"]}\n'
        + '- Each entry must copy verbatim the first 10-20 words of one earlier item you actually used.\n'
        + '- Only cite items you genuinely depended on. If none, omit the block entirely.\n'
        + '- The block belongs in the final reply body only, never in reasoning. Output nothing after it.',
    })

    ctx.on('agent/pre-step', async ({ agent, signal }, next): Promise<PreStepDecision> => {
      if (this.session === null) this.session = agent.session
      if (!signal.aborted) {
        try {
          await this.compactIfNeeded(agent, 'pressure', signal)
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error)
          ctx.logger.warn(`argp-graph pressure prune failed: ${message}; continuing the turn`)
        }
      }
      return next()
    })
  }

  setSession(session: Session): void {
    this.session = session
    this.shadowedSeqsOf(session) // setSession 时初始化一次；后续仅扫描新追加事件
  }

  /** 生成上下文头部 catalog（设计稿 §5）：只列被剪 U/A，snippet 截断，≤maxItems 条。 */
  catalogText(maxItems = 20, snippetChars = 70): string {
    if (this.session === null) return ''
    const shadowed = this.shadowedSeqsOf(this.session)
    const lines: string[] = []
    for (const seq of [...shadowed].sort((a, b) => a - b)) {
      if (lines.length >= maxItems) break
      const event = this.session.events[seq]
      if (event === undefined) continue
      const data = event.data as Record<string, unknown> | undefined
      let type: AtomType
      if (event.type === 'user/message') {
        type = (data as { source?: { kind?: string } } | undefined)?.source?.kind === 'plugin' ? 'X' : 'U'
      } else if (event.type === 'assistant/message') {
        type = 'A'
      } else {
        continue // catalog 只列 U/A
      }
      const text = eventText(this.session, seq)
      const snippet = text.split('\n').map(l => l.trim()).find(l => l !== '') ?? ''
      const clipped = snippet.length > snippetChars ? snippet.slice(0, snippetChars) + '…' : snippet
      lines.push('[' + type + (data?.turn !== undefined ? data.turn : '') + '] ' + clipped)
    }
    if (lines.length === 0) return ''
    return '[context] Compression removed ' + shadowed.size + ' earlier item(s) from the visible context:\n' + lines.join('\n')
  }
  /** 按关键词查询被剪节点原文（设计稿 §6 的 recall(query) 简化版）。 */
  recallQuery(query: string, maxResults = 5): string {
    if (this.session === null) return 'recall: no session bound'
    const shadowed = this.shadowedSeqsOf(this.session)
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
    interface Hit { seq: number; score: number; text: string; type: AtomType; turn: number }
    const hits: Hit[] = []
    for (const seq of shadowed) {
      const event = this.session.events[seq]
      if (event === undefined) continue
      const data = event.data as Record<string, unknown> | undefined
      const text = eventText(this.session, seq)
      if (text === '') continue
      const lower = text.toLowerCase()
      let score = 0
      for (const term of terms) if (lower.includes(term)) score += 1
      if (score === 0) continue
      let type: AtomType
      if (event.type === 'user/message') type = (data as { source?: { kind?: string } } | undefined)?.source?.kind === 'plugin' ? 'X' : 'U'
      else if (event.type === 'assistant/message') type = 'A'
      else if (event.type === 'tool/result') type = 'R'
      else type = 'X'
      const turn = typeof data?.turn === 'number' ? (data.turn as number) : 0
      hits.push({ seq, score, text, type, turn })
    }
    hits.sort((a, b) => b.score - a.score || (a.type === 'U' ? -1 : b.type === 'U' ? 1 : a.seq - b.seq))
    const selected = hits.slice(0, maxResults)
    this.recallQueryCalls.push({ query, count: selected.length, hits: selected.length })
    if (selected.length === 0) return 'recall: no pruned nodes match query "' + query + '"'
    const lines = selected.map(h => '[' + h.type + (h.turn !== 0 ? h.turn : '') + '] ' + h.text)
    return 'Recalled ' + selected.length + ' pruned atom(s) for "' + query + '":\n' + lines.join('\n')
  }

  /**
   * 增量维护被遮蔽 surface seq 集合：事件日志只追加，游标从上次扫描处继续，
   * 避免每次 recall/剪枝压力检查都 O(事件总量) 重扫。session 切换时重置。
   */
  private shadowedSeqsOf(session: Session): Set<number> {
    if (this.shadowedSession !== session) {
      this.shadowedSession = session
      this.shadowedSet = new Set()
      this.shadowedScanned = 0
    }
    for (let index = this.shadowedScanned; index < session.events.length; index += 1) {
      const event = session.events[index]
      if (event === undefined) continue
      const op = (event as { surfaceOp?: unknown }).surfaceOp
      if (op !== undefined && op !== 'append') {
        for (const seq of (event as { sourceEventSeqs?: number[] }).sourceEventSeqs ?? []) {
          this.shadowedSet.add(seq)
        }
      }
    }
    this.shadowedScanned = session.events.length
    return this.shadowedSet
  }

  recall(seq: number): string | null {
    if (this.session === null) return null
    if (!this.shadowedSeqsOf(this.session).has(seq)) return null
    const text = eventText(this.session, seq)
    return text === '' ? null : text
  }

  /** 原子化（§4.1）：只投影 surface 节点；U/X/R/A 四类（tool/call 不进 surface，无 T 类）。cites 统计在 A 原子处累计。 */
  atomize(session: Session): Atom[] {
    const atoms: Atom[] = []
    for (const seq of session.surface.nodes) {
      const event = session.events[seq]
      if (event === undefined) continue
      const data = event.data as Record<string, unknown> | undefined
      const turn = typeof data?.turn === 'number' ? (data.turn as number) : 0
      if (event.type === 'user/message') {
        const source = (data as { source?: { kind?: string } }).source
        const kind = source?.kind === 'plugin' ? 'X' : 'U'
        atoms.push({ id: atoms.length, seq, type: kind, turn, text: eventText(session, seq), toolCallIds: [], cites: [], citesFailed: false })
        continue
      }
      if (event.type === 'assistant/message') {
        const raw = eventText(session, seq)
        const { body, cites, attempted, parseFailed } = extractCites(raw)
        const msg = (data as { message?: { content?: unknown[] } })?.message
        const content = Array.isArray(msg?.content) ? (msg?.content as { type: string; id?: string }[]) : []
        const toolCallIds = content.filter(b => b.type === 'tool-call' && typeof b.id === 'string').map(b => b.id as string)
        this.citeStats.aAtoms += 1
        if (cites.length > 0) this.citeStats.declared += cites.length
        if (parseFailed) this.citeStats.failed += 1
        atoms.push({ id: atoms.length, seq, type: 'A', turn, text: body, toolCallIds, cites, citesFailed: parseFailed })
        continue
      }
      if (event.type === 'tool/result') {
        const d = data as { message?: { source?: { callId?: string } } }
        const callId = d?.message?.source?.callId
        atoms.push({ id: atoms.length, seq, type: 'R', turn, text: eventText(session, seq), toolCallIds: callId === undefined ? [] : [callId], cites: [], citesFailed: false })
        continue
      }
    }
    return atoms
  }

  /**
   * 建图（§4.2 + §4.7）：确定性边不计级别；cites 子串匹配生成 supporting 语义边
   * （唯一命中采纳；多命中 AMBIG → 最早命中 + U 优先）。
   * 实测修正（spike 5 首跑）：原 startsWith 头部匹配边数归零——逐字引文起点常落在
   * 原子文本中段，改 includes 子串匹配（同“被动头部匹配陷阱”教训）。
   */
  buildGraph(atoms: Atom[]): { edges: SemanticEdge[]; inDegree: Map<number, number> } {
    const edges: SemanticEdge[] = []
    for (const a of atoms) {
      if (a.type !== 'A') continue
      for (const prefix of a.cites) {
        const p = prefix.trim()
        if (p === '') continue
        const hits = atoms.filter(t => t.id !== a.id && t.text !== '' && t.text.includes(p))
        if (hits.length === 0) continue
        let target = hits[0]
        if (hits.length > 1) {
          this.citeStats.ambiguous += 1
          const uHit = hits.find(h => h.type === 'U')
          target = uHit ?? hits.reduce((min, h) => (h.seq < min.seq ? h : min), hits[0])
        }
        edges.push({ from: a.id, to: target.id, level: 'supporting' })
        this.citeStats.resolved += 1
      }
    }
    this.lastEdges = edges
    const inDegree = new Map<number, number>()
    for (const e of edges) inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1)
    return { edges, inDegree }
  }
  /** surface 可见字符总量（与 spike 4 同基准）。 */
  private visibleChars(session: Session): number {
    let total = 0
    for (const seq of session.surface.nodes) total += eventText(session, seq).length
    return total
  }

  /** 测量当前上下文 token（当前退化为字符估算；tokenMeter 接入留待后续）。 */
  private measureTokens(session: Session): { contextTokens: number; surfaceTokens: number } {
    if (this.tokenMeterFn !== undefined) return this.tokenMeterFn(session)
    const surfaceTokens = Math.ceil(this.visibleChars(session) / this.charsPerToken)
    return { contextTokens: surfaceTokens, surfaceTokens }
  }

  /** §4.4 简化版本链去重：相同 A/R 文本保留最新，旧副本标记为可剪。 */
  private findVersionDuplicates(atoms: Atom[], inDegree: Map<number, number>): Set<number> {
    const dupIds = new Set<number>()
    const seenA = new Map<string, Atom>()
    for (const a of atoms.filter(x => x.type === 'A')) {
      const key = a.text.trim()
      const existing = seenA.get(key)
      if (existing !== undefined) {
        const older = existing.turn < a.turn || (existing.turn === a.turn && existing.seq < a.seq) ? existing : a
        const newer = older === existing ? a : existing
        if ((inDegree.get(older.id) ?? 0) === 0) dupIds.add(older.id)
        seenA.set(key, newer)
      } else {
        seenA.set(key, a)
      }
    }
    const seenR = new Map<string, Atom>()
    for (const r of atoms.filter(x => x.type === 'R')) {
      const key = r.text.trim()
      const existing = seenR.get(key)
      if (existing !== undefined) {
        const older = existing.turn < r.turn || (existing.turn === r.turn && existing.seq < r.seq) ? existing : r
        const newer = older === existing ? r : existing
        if ((inDegree.get(older.id) ?? 0) === 0) dupIds.add(older.id)
        seenR.set(key, newer)
      } else {
        seenR.set(key, r)
      }
    }
    return dupIds
  }

  /**
   * 压力剪枝（§4.3/§4.5）：估算量 ≥ windowTokens 时重建图，按排序键逐弱剪至 ≤ retainTokens。
   * 候选：A/T/R、语义入度 0、非近因豁免区、非最新轮、非保守保护；U/X 永不参剪。
   * 排序键（§4.5）：最低关联语义级别升 → effective_importance 升 → lastRefRound 升 → seq 升。
   * 候选耗尽仍超预算 → force_prune（忽略入度，§4.6.2）。
   */
  override async compactIfNeeded(
    agent: CompactionAgentContext,
    _trigger: CompactionTrigger,
    _signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    const session = agent.session
    if (this.session === null) this.session = session
    const thresholdTokens = this.windowTokens - this.reserveTokens
    if (thresholdTokens <= 0) {
      console.log('[argp-graph] pressure check: reserveTokens exceeds windowTokens, skip')
      return null
    }
    const retainChars = this.retainTokens * this.charsPerToken
    const visibleNow = this.visibleChars(session)
    const measurement = this.measureTokens(session)
    if (measurement.contextTokens < thresholdTokens) {
      console.log('[argp-graph] pressure check: contextTokens=' + measurement.contextTokens + ' < threshold=' + thresholdTokens + ', skip')
      return null
    }

    const atoms = this.atomize(session)
    const { edges, inDegree } = this.buildGraph(atoms)
    const surfaceSeqs = [...session.surface.nodes]
    const position = new Map(surfaceSeqs.map((seq, i) => [seq, i]))
    const recencyCut = Math.max(0, surfaceSeqs.length - this.recencyGuard)
    const latestTurn = atoms.reduce((m, a) => Math.max(m, a.turn), 0)
    const selfImportance = (a: Atom): number => (a.type === 'A' ? 5 : a.type === 'U' ? 3 : 0)
    const eff = new Map(atoms.map(a => [a.id, selfImportance(a)]))
    for (const e of edges) eff.set(e.to, Math.max(eff.get(e.to) ?? 0, EDGE_WEIGHTS[e.level])) // 语义边权重
    const lastRef = new Map<number, number>()
    for (const e of edges) {
      const from = atoms[e.from]
      if (from !== undefined) lastRef.set(e.to, Math.max(lastRef.get(e.to) ?? 0, from.turn))
    }
    const touchesSemantic = new Set(edges.flatMap(e => [e.from, e.to]))
    // ask-exempt U 动态覆盖：U 后首个 A 若对它有 supporting 边，则视为被覆盖；后续跨轮引用会使其失效。
    const askCoverage = new Map<number, number>()
    for (const u of atoms.filter(a => a.type === 'U')) {
      const text = u.text.trim()
      const looksAsk = text.endsWith('?') || /\bask\b/i.test(text) || /\bwhat\b/i.test(text)
      if (!looksAsk) continue
      const firstA = atoms
        .filter(a => a.type === 'A' && a.turn >= u.turn && a.seq > u.seq)
        .sort((a, b) => a.seq - b.seq)[0]
      if (firstA !== undefined && edges.some(e => e.from === firstA.id && e.to === u.id)) {
        askCoverage.set(u.id, firstA.id)
      }
    }
    // 成对同剪组（配对自保，修正版）：dsh surface 无 tool/call 节点，call 块内嵌在 A 里。
    // 剪 R 不带走发出它的 A → 孤儿 call；剪含 call 的 A 不带走应答 R → 孤儿 result；两者都致 API 400。
    // 故：A（含 tool-call）+ 应答其全部 call 的 R 成组，同进同退。
    const issuerByCall = new Map<string, Atom>()
    for (const a of atoms) if (a.type === 'A') for (const cid of a.toolCallIds) issuerByCall.set(cid, a)
    const groupOf = new Map<number, number>()
    const groups: Atom[][] = []
    for (const a of atoms) {
      const issuer = a.type === 'R' && a.toolCallIds[0] !== undefined ? issuerByCall.get(a.toolCallIds[0]) : undefined
      if (issuer !== undefined) {
        let gid = groupOf.get(issuer.id)
        if (gid === undefined) {
          gid = groups.length
          groups.push([issuer])
          groupOf.set(issuer.id, gid)
        }
        ;(groups[gid] as Atom[]).push(a)
        groupOf.set(a.id, gid)
        continue
      }
      if (groupOf.has(a.id)) continue // 已作为 issuer 入组
      const gid = groups.length
      groups.push([a])
      groupOf.set(a.id, gid)
    }
    const isAtomCandidate = (a: Atom, allowInDegree: boolean): boolean => {
      if (a.type === 'U') {
        const coverer = askCoverage.get(a.id)
        if (coverer === undefined) return false
        const pos = position.get(a.seq)
        if (pos === undefined || pos >= recencyCut) return false
        if (a.turn >= latestTurn) return false
        // 动态复核：所有保留入边都必须来自覆盖者，否则豁免失效
        const incoming = edges.filter(e => e.to === a.id)
        if (incoming.length === 0 || incoming.some(e => e.from !== coverer)) return false
        return true
      }
      if (a.type !== 'A' && a.type !== 'R') return false
      const pos = position.get(a.seq)
      if (pos === undefined || pos >= recencyCut) return false
      if (a.turn >= latestTurn) return false
      if (a.citesFailed) return false
      if (!allowInDegree && (inDegree.get(a.id) ?? 0) > 0) return false
      return true
    }
    const isGroupCandidate = (g: Atom[], allowInDegree: boolean): boolean =>
      g.every(a => isAtomCandidate(a, allowInDegree))
    const sortKey = (a: Atom): string => {
      const lvl = touchesSemantic.has(a.id) ? LEVEL_ORDER.supporting : LEVEL_ORDER.isolated
      return [lvl, eff.get(a.id) ?? 0, lastRef.get(a.id) ?? 0, a.seq].map(n => String(n).padStart(10, '0')).join('|')
    }

    const softCandidateGroups = groups.filter(g => isGroupCandidate(g, false)).length
    const pruned = new Map<number, Atom>()
    const duplicateIds = this.findVersionDuplicates(atoms, inDegree)
    for (const id of duplicateIds) {
      const atom = atoms.find(a => a.id === id)
      if (atom !== undefined) pruned.set(id, atom)
    }
    let forced = false
    for (let pass = 0; pass < this.maxPasses; pass += 1) {
      const remaining = atoms.filter(a => !pruned.has(a.id))
      const visible = remaining.reduce((sum, a) => sum + a.text.length, 0)
      if (visible <= retainChars) break
      const liveGroups = groups.filter(g => g.some(a => !pruned.has(a.id)))
      let candidateGroups = liveGroups.filter(g => isGroupCandidate(g, false))
      if (candidateGroups.length === 0) {
        candidateGroups = liveGroups.filter(g => isGroupCandidate(g, true)) // force_prune：忽略入度
        if (candidateGroups.length === 0) break
        forced = true
      }
      const groupKey = (g: Atom[]): string => g.map(sortKey).sort()[0] as string
      candidateGroups.sort((x, y) => groupKey(x).localeCompare(groupKey(y)))
      const top = candidateGroups[0] as Atom[]
      for (const a of top) pruned.set(a.id, a) // 整组同剪
    }

    // 微剪枝下限：按极大连续区间归并，区间可见量 < minSpanChars 的放回（不剪）
    const prunedSeqs = [...pruned.values()].map(a => a.seq).sort((x, y) => x - y)
    const intervals: { seqs: number[]; chars: number; atoms: Atom[] }[] = []
    for (const seq of prunedSeqs) {
      const a = [...pruned.values()].find(x => x.seq === seq)
      if (a === undefined) continue
      const lastInterval = intervals[intervals.length - 1]
      const prevPos = lastInterval !== undefined ? position.get(lastInterval.seqs[lastInterval.seqs.length - 1] as number) : undefined
      const curPos = position.get(seq)
      if (lastInterval !== undefined && prevPos !== undefined && curPos !== undefined && curPos === prevPos + 1) {
        lastInterval.seqs.push(seq)
        lastInterval.chars += a.text.length
        lastInterval.atoms.push(a)
      } else {
        intervals.push({ seqs: [seq], chars: a.text.length, atoms: [a] })
      }
    }
    const kept = intervals.filter(iv => iv.chars >= this.minSpanChars)
    console.log('[argp-graph] prune decision: visible=' + visibleNow + ' groups=' + groups.length
      + ' softCandidates=' + softCandidateGroups + ' prunedAtoms=' + pruned.size + ' keptIntervals=' + kept.length + ' forced=' + forced)
    if (kept.length === 0) return null
    for (const iv of kept) {
      for (const a of iv.atoms) {
        const citedBySeq = edges
          .filter(e => e.to === a.id)
          .map(e => atoms[e.from]?.seq)
          .filter((x): x is number => x !== undefined)
        const firstLine = a.text.split('\n').map(l => l.trim()).find(l => l !== '') ?? ''
        this.prunedNodeIndex.set(a.seq, {
          seq: a.seq,
          type: a.type,
          turn: a.turn,
          firstLine: firstLine.length > 120 ? firstLine.slice(0, 120) + '…' : firstLine,
          citedBySeq,
        })
      }
    }
    return this.pruneIntervals(session, kept, edges.length, softCandidateGroups, forced)
  }

  override async compactNow(
    agent: ManualCompactAgentContext,
    signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    if (this.session === null) this.session = agent.session
    signal.throwIfAborted()
    const run = async (agentSignal: AbortSignal): Promise<CompactionResult | null> => {
      const opSignal = AbortSignal.any([signal, agentSignal])
      opSignal.throwIfAborted()
      const range = this.selectManualRange(agent.session)
      if (range === null) return null
      return this.compactRegion(range.start, range.end, agent, opSignal)
    }
    if (typeof agent.runMaintenance === 'function') {
      return agent.runMaintenance(run)
    }
    return run(signal)
  }

  override async compactRegion(
    start: number,
    end: number,
    agent: CompactionAgentContext,
    signal?: AbortSignal,
  ): Promise<CompactionResult> {
    if (this.session === null) this.session = agent.session
    signal?.throwIfAborted()
    const session = agent.session
    const nodes = session.surface.nodes
    const startIdx = nodes.indexOf(start)
    const endIdx = nodes.indexOf(end)
    if (startIdx === -1) throw new Error('compactRegion: start seq ' + start + ' not found in surface')
    if (endIdx === -1) throw new Error('compactRegion: end seq ' + end + ' not found in surface')
    if (startIdx > endIdx) throw new Error('compactRegion: start seq ' + start + ' is after end seq ' + end + ' on the surface')
    if (!toolPairingBalancedBefore(session, nodes[startIdx])) throw new Error('compactRegion: start seq ' + start + ' is not a balanced boundary')
    if (!toolPairingBalancedAfter(session, nodes[endIdx])) throw new Error('compactRegion: end seq ' + end + ' is not a balanced boundary')

    const shadowedSeqs = nodes.slice(startIdx, endIdx + 1)
    const atoms = this.atomize(session)
    const bySeq = new Map(atoms.map(a => [a.seq, a]))
    const intervalAtoms = shadowedSeqs.map(seq => bySeq.get(seq)).filter((a): a is Atom => a !== undefined)
    if (intervalAtoms.some(a => a.type === 'U' || a.type === 'X')) {
      throw new Error('compactRegion: ARGP never prunes U/X nodes; choose a span without U/X')
    }
    if (intervalAtoms.length === 0) {
      throw new Error('compactRegion: selected span contains no prunable A/R atoms')
    }
    const chars = intervalAtoms.reduce((sum, a) => sum + a.text.length, 0)
    const interval = { seqs: shadowedSeqs, chars, atoms: intervalAtoms }
    return this.pruneIntervals(session, [interval], 0, 0, true)
  }

  /** 为手动 compactNow 选择一个确定性的最老 A/R 连续块。 */
  private selectManualRange(session: Session): { start: number; end: number } | null {
    const surfaceSeqs = session.surface.nodes
    const atoms = this.atomize(session)
    const bySeq = new Map(atoms.map(a => [a.seq, a]))
    const latestTurn = atoms.reduce((m, a) => Math.max(m, a.turn), 0)
    const recencyCut = Math.max(0, surfaceSeqs.length - this.recencyGuard)
    let start: number | null = null
    let end = -1
    for (let i = 0; i < surfaceSeqs.length; i += 1) {
      const seq = surfaceSeqs[i]
      const atom = bySeq.get(seq)
      if (atom === undefined || atom.type === 'U' || atom.type === 'X' || atom.turn >= latestTurn || i >= recencyCut) {
        if (start !== null) break
        continue
      }
      if (start === null) start = seq
      end = seq
    }
    if (start === null) return null
    return { start, end }
  }

  /** 一笔事务剪多个极大连续区间：start → summary → 每区间 checkpoint replace → end。 */
  private pruneIntervals(
    session: Session,
    intervals: { seqs: number[]; chars: number; atoms: Atom[] }[],
    semanticEdges: number,
    candidateCount: number,
    forced: boolean,
  ): CompactionResult {
    const charsBefore = this.visibleChars(session)
    const openTurn = this.detectOpenTurn(session)
    const compactionId = CompactionId('argp-graph-' + randomUUID())
    const lifecycle = { compactionId, turn: openTurn }
    const allSeqs = intervals.flatMap(iv => iv.seqs)
    const first = intervals[0]?.seqs[0] ?? 0
    const last = intervals[intervals.length - 1]?.seqs[intervals[intervals.length - 1]!.seqs.length - 1] ?? first

    const startEvent = session.append('compaction/start', lifecycle)
    try {
      const shadowedTokenCount = Math.ceil(intervals.reduce((s, iv) => s + iv.chars, 0) / this.charsPerToken)
      const tombstones = intervals.map(iv => '[elided seq=' + iv.seqs[0] + '..' + iv.seqs[iv.seqs.length - 1]
        + ': ' + iv.seqs.length + ' surface nodes pruned by ARGP (graph order, cites-aware'
        + (forced ? ', forced' : '') + '); recall_pruned(seq) retrieves original]')
      // 0-LLM 剪枝使用 compaction/prune shadow-price 事件（替代 summary）
      const pruneEvent = session.append('compaction/prune', {
        shadowedRange: { start: first, end: last },
        shadowedSeqs: allSeqs,
        shadowedTokenCount,
      })
      const intervalRecords: { start: number; end: number; tombstoneSeq: number }[] = []
      for (let i = 0; i < intervals.length; i += 1) {
        const iv = intervals[i]
        if (iv === undefined) continue
        const start = iv.seqs[0] as number
        const end = iv.seqs[iv.seqs.length - 1] as number
        const text = tombstones[i] ?? ''
        const tombstone = session.append('user/message', createUserMessage({
          content: [{ type: 'text', text }],
          source: compactCheckpointSource(compactionId),
        }), {
          surfaceOp: { op: 'replace', start, end },
          sourceEventSeqs: [startEvent.seq, pruneEvent.seq, ...iv.seqs],
        })
        intervalRecords.push({ start, end, tombstoneSeq: tombstone.seq })
      }
      const endEvent = session.append('compaction/end', lifecycle)
      const charsAfter = this.visibleChars(session)
      this.records.push({
        at: new Date().toISOString(),
        compactionId,
        intervals: intervalRecords,
        startEventSeq: startEvent.seq,
        summaryEventSeq: pruneEvent.seq,
        endEventSeq: endEvent.seq,
        shadowedSeqs: allSeqs,
        prunedAtoms: intervals.flatMap(iv => iv.atoms.map(a => ({ id: a.id, type: a.type, seq: a.seq }))),
        semanticEdges,
        candidates: candidateCount,
        charsBefore,
        charsAfter,
        forced,
      })
      return {
        compactionId,
        startSeq: startEvent.seq,
        summarySeq: pruneEvent.seq,
        endSeq: endEvent.seq,
        summary: tombstones.map(text => ({ type: 'text', text })),
        shadowedRange: { start: first, end: last },
        shadowedSeqs: allSeqs,
        shadowedTokenCount,
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      try {
        session.append('compaction/end', { ...lifecycle, error: message })
      } catch {
        // 关闭失败保留未配对 start，可被 inspectCompactionEntryState 检出
      }
      throw error
    }
  }

  /** 日志尾部的 open turn（pre-step 时刻用于 compaction 括号的 owner）。 */
  private detectOpenTurn(session: Session): number | null {
    for (let index = session.events.length - 1; index >= 0; index -= 1) {
      const event = session.events[index]
      if (event === undefined) continue
      if (event.type === 'turn/start') return (event.data as { turn: number }).turn
      if (event.type === 'turn/end') return null
    }
    return null
  }
}

export default ArgpGraphEngine
