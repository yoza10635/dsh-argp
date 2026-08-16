/**
 * ARGP 建边版引擎（spike 5，M3）：原子化 + 建图 + 图序剪枝 + cites 义务。
 *
 * 按设计稿 §3-§7 移植，机制验证版简化（差异记入台账）：
 *  - 无版本链去重（§4.4）、无 summarize 降级（§4.6.1，候选耗尽走 force_prune）、无 catalog（仅 recall）
 *  - 占位主路径（§8.3 路径 b）+ 区间 replace；事务仿 spike 4（借 compaction/summary 语义，候选卡点 B-3）
 *  - 配对自保：A（含 tool-call 块）+ 应答 R 成组同剪；U 与 tombstone 永不参剪（不变式 6）。
 *    实测：dsh surface 无 tool/call 节点（SURFACE_EVENT_TYPES 三类），call 块内嵌在 assistant/message 里
 *  - cites 义务开启：正为回答母表待决项（本地新 SOTA 模型的 cites 服从率）
 *  - 触发/目标同一可见字符估算基准（不变式 2）；reasoning 块不计入预算（spike 4a 判决 C）
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { CompactionEngine, CompactionId, compactCheckpointSource } from '@deepseek-ai/dsh-compaction'
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

export interface SemanticEdge { from: number; to: number; level: 'supporting' }
const LEVEL_ORDER: Record<string, number> = { isolated: 0, contextual: 1, supporting: 2, critical: 3 }

export interface ArgpGraphConfig {
  windowTokens?: number   // 默认 16384
  retainTokens?: number   // 默认 8192
  recencyGuard?: number   // 默认 4（surface 末尾 N 节点不参剪）
  minSpanChars?: number   // 默认 512（微剪枝下限）
  charsPerToken?: number  // 默认 3.5（触发与目标同基准）
  /** 单次剪枝事务的最大贪心 pass 数（默认 16；生产档大批量剪枝应调高）。 */
  maxPasses?: number
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
  const fence = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```\s*$/)
  const bare = text.match(/(\{\s*"cites"\s*:[\s\S]*?\})\s*$/)
  const raw = fence?.[1] ?? bare?.[1]
  if (raw === undefined) {
    return { body: text, cites: [], attempted: text.includes('"cites"'), parseFailed: false }
  }
  try {
    const parsed = JSON.parse(raw) as { cites?: unknown }
    if (Array.isArray(parsed.cites) && parsed.cites.every(c => typeof c === 'string')) {
      return { body: text.slice(0, text.length - (text.match(/(\{\s*"cites"[\s\S]*?\}\s*(?:```)?\s*)$/) ?? [''])[0].length).trimEnd(), cites: parsed.cites, attempted: true, parseFailed: false }
    }
    return { body: text, cites: [], attempted: true, parseFailed: true } // JSON 合法但形状不对 → 解析失败，保守保护
  } catch {
    return { body: text, cites: [], attempted: true, parseFailed: true }
  }
}
/** cites 服从率度量台账（C7-cites 判决用）。 */
export interface CiteStats { aAtoms: number; declared: number; resolved: number; ambiguous: number; failed: number }

export class ArgpGraphEngine extends CompactionEngine {
  static inject = ['tools', 'systemPrompt']

  readonly windowTokens: number
  readonly retainTokens: number
  readonly recencyGuard: number
  readonly minSpanChars: number
  readonly charsPerToken: number
  readonly maxPasses: number

  readonly records: GraphPruneRecord[] = []
  readonly recallCalls: { seq: number; hit: boolean }[] = []
  readonly citeStats: CiteStats = { aAtoms: 0, declared: 0, resolved: 0, ambiguous: 0, failed: 0 }
  /** 最近一次建图的语义边（判决 G3 读：被引原子是否获得保护）。 */
  lastEdges: SemanticEdge[] = []

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

    const recallTool = defineTool({
      name: 'recall_pruned',
      description: 'Retrieve the original content of a pruned conversation node by its log seq. Pruned content stays in the append-only log; use this instead of guessing.',
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

    // 定稿契约（设计稿 §7 全文，含 cites 义务）；order 150：工具指引 100-199 段
    ctx.systemPrompt.section({
      name: 'argp-contract',
      order: 150,
      text: () => 'Context compression (ARGP):\n'
        + 'Your conversation context is managed under a compression budget. Older parts of the conversation may be compressed or removed at any time.\n\n'
        + 'Rules:\n'
        + '- Every reply must be self-contained plain text: state facts, conclusions, and content directly in natural language. Never answer by pointing at earlier context items instead of restating the needed content.\n'
        + '- Your visible context is a pruned view: earlier parts of the conversation may have been removed by compression, so absence from the visible context does not mean it was never said. When the user refers to something discussed earlier (values, instructions, facts) that you cannot find in the visible context, ALWAYS call the recall_pruned tool with the seq shown in the placeholder first — never conclude it was never provided without recalling.\n'
        + '- Citation declaration: at the end of every substantive reply, append ONE JSON block listing the earlier context items your reply depends on, each identified by quoting its opening words:\n'
        + '{"cites":["the gateway release passes. Neither","Here is the incident-window data"]}\n'
        + '  - Each entry copies verbatim the first roughly 10-20 words of one earlier item (a user message, a tool result, or one of your earlier replies) that your reply actually used.\n'
        + '  - Only cite items you genuinely depended on (facts, conclusions, instructions). If there are none, output {"cites":[]}.\n'
        + '  - Never invent a quote: every entry must appear word-for-word in your visible context.\n'
        + '  - The reply body before the block stays plain text. The block may be wrapped in a ```json code fence. Output nothing after it.',
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
    const thresholdChars = this.windowTokens * this.charsPerToken
    const retainChars = this.retainTokens * this.charsPerToken
    const visibleNow = this.visibleChars(session)
    if (visibleNow < thresholdChars) {
      console.log('[argp-graph] pressure check: visible=' + visibleNow + ' < threshold=' + thresholdChars + ', skip')
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
    for (const e of edges) eff.set(e.to, Math.max(eff.get(e.to) ?? 0, 5)) // supporting 权重 5
    const lastRef = new Map<number, number>()
    for (const e of edges) {
      const from = atoms[e.from]
      if (from !== undefined) lastRef.set(e.to, Math.max(lastRef.get(e.to) ?? 0, from.turn))
    }
    const touchesSemantic = new Set(edges.flatMap(e => [e.from, e.to]))
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
    return this.pruneIntervals(session, kept, edges.length, softCandidateGroups, forced)
  }

  override async compactNow(
    _agent: ManualCompactAgentContext,
    _signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    throw new Error('argp-graph: compactNow not implemented in spike 5 (mechanism validation)')
  }

  override async compactRegion(): Promise<CompactionResult> {
    throw new Error('argp-graph: compactRegion not implemented in spike 5 (mechanism validation)')
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
      // 无 LLM 剪枝借 summary 语义进事务括号（候选卡点 B-3）
      const summaryEvent = session.append('compaction/summary', {
        ...lifecycle,
        summary: tombstones.map(text => ({ type: 'text', text })),
        shadowedRange: { start: first, end: last },
        shadowedSeqs: allSeqs,
        shadowedTokenCount,
        provider: 'argp',
        model: 'algorithmic-tombstone',
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
          sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...iv.seqs],
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
        summaryEventSeq: summaryEvent.seq,
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
        summarySeq: summaryEvent.seq,
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
