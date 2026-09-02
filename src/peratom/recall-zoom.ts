/**
 * Per-Atom 两级召回 zoom（P3）：渐进式 recall，verbatim 天花板。
 *
 * 依据：per-atom-implementation-plan.md P3（已迁出公开仓库） + per-atom-compression-engine-design.md §5（已迁出公开仓库）。
 *
 * 三个存储级别（设计 §4）：
 *  - extract：熵降后 surface 上常驻的压缩副本（模型可见）
 *  - summary：压缩时产的摘要（U-info 存 `data[ARG_NS].summary`；tool/result 副本正文即 extract）
 *  - original：append-only 日志里的 verbatim 原文（天然存在，零存储成本）
 *
 * 两级工具（设计 §5 渐进 zoom）：
 *  - `recall_summary(seq)`：gist 档——"这内容是关于什么的"。优先读存储 summary，无则降级返回
 *    压缩副本（extract），再降级返回原文。便宜（预算给 4×）。
 *  - `recall_detail(seq)`：exact 档——"确切字符串"。从 append-only 日志取 verbatim 原文（复用
 *    log-access.recallFromLog + argp-graph-engine.eventText），即 verbatim 天花板。贵（预算 1×）。
 *
 * 宿主身份（与 PeratomCompressor / CiteDeclarer 同构）：普通 cordis 服务（**非 compaction 位**），
 * 注册两个 defineTool + 一个静态契约 section，经 `setSession` / `agent/pre-step` 绑定 session。
 * 零 LLM 调用——两个工具都是纯日志读取，0 推理成本。
 *
 * 预算模块（决策⑤ 4 倍制）：detail 档基线预算，summary 档 = `budgetRatio`(4) × detail。
 * 按"自上次 compaction 事务以来的累计字符"滑窗计数（与 argp-graph-engine.budgetRecallText 同款
 * 重置语义，挂在 `compaction/end`）。**超限不硬拒**——返回引导文案教模型升档（summary→detail）
 * 或降档（detail→summary），而非拒绝读取。
 *
 * 失败隔离：seq 越界 / 无正文返回明确说明（不抛错）；预算耗尽返回引导（不阻断会话）。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import { eventText } from '../argp-graph-engine.js'
import { formatRecallOutcome, recallFromLog, scanShadowedSeqs, sessionEvents, stateHeader } from '../log-access.js'
import type { NodeState } from '../log-access.js'
import { ARG_NS } from './types.js'
import type { ArgpUserMeta } from './types.js'

/** 决策⑤ 4 倍制：summary 档预算 = budgetRatio × detail 档。默认 4。 */
export const DEFAULT_BUDGET_RATIO = 4

/** 默认窗口锚（未显式给预算时按 windowTokens × 比例解析）。 */
const DEFAULT_WINDOW_TOKENS = 16_384
const DEFAULT_CHARS_PER_TOKEN = 3.5
/** detail 档预算占窗口比例（单窗累计，字符）。 */
const DETAIL_WINDOW_RATIO = 0.05

/** 单次召回正文的来源标签（测试断言 + 引导文案用）。 */
export type SummarySource = 'stored' | 'copy' | 'original'

export interface SummaryResolution {
  text: string
  source: SummarySource
}

/** 召回调用观测记录（时间序）。 */
export interface RecallZoomRecord {
  tool: 'recall_summary' | 'recall_detail'
  seq: number
  /** 是否取到正文（越界 / 无正文为 false）。 */
  hit: boolean
  /** 命中时的节点状态（shadowed / live / off-surface）。 */
  state?: NodeState
  /** summary 档正文来源（stored=存储 summary，copy=压缩副本，original=降级原文）。 */
  source?: SummarySource
  /** 命中时计入对应档预算的字符数。 */
  chars: number
  /** 因预算耗尽被拦（返回引导文案而非正文）。 */
  budgetBlocked?: 'summary' | 'detail'
  /** 失败原因（越界 / 无正文）。 */
  reason?: 'out-of-range' | 'no-text'
}

export interface RecallZoomConfig {
  /** detail 档单窗预算（token）；显式给则优先于 windowTokens 比例解析。 */
  detailBudgetTokens?: number
  /** 4 倍制系数（决策⑤），summary 档预算 = ratio × detail 档。默认 4。 */
  budgetRatio?: number
  /** 窗口 token 锚（未显式给 detailBudgetTokens 时解析默认预算用）。 */
  windowTokens?: number
  /** chars/token 估算。默认 3.5。 */
  charsPerToken?: number
  /** 是否注册工具与契约 section（默认 true）。测试可关断只留纯函数。 */
  enabled?: boolean
}

/**
 * 解析某 seq 的"最佳可用 summary 文本"，三档降级（设计 §4 + plan P3）：
 *  1. `stored`——该事件（或引用它的压缩副本）携带 `data[ARG_NS].summary`（U-info 原子）；
 *  2. `copy`——引用该 seq 的最新压缩副本正文（tool/result extract 副本 / dialog 副本）；
 *  3. `original`——从未压缩，降级返回 append-only 日志原文。
 * 无正文返回 null。
 */
export function resolveSummaryText(session: Session, seq: number): SummaryResolution | null {
  const event = sessionEvents(session)[seq]
  if (event === undefined) return null

  // 1) 该事件自身携带存储 summary（U-info 副本本身被直接引用）
  const own = summaryOfEvent(session, seq)
  if (own !== null) return own

  // 2) 找引用此 seq 的压缩副本（自新到旧；U-info 副本优先其存储 summary）
  const events = sessionEvents(session)
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (i === seq) continue
    const copy = events[i]
    if (copy === undefined) continue
    const srcs = (copy as { sourceEventSeqs?: number[] }).sourceEventSeqs
    if (srcs === undefined || !srcs.includes(seq)) continue
    const stored = summaryOfEvent(session, i)
    if (stored !== null) return stored
    const copyText = eventText(session, i)
    if (copyText !== '') return { text: copyText, source: 'copy' }
  }

  // 3) 从未压缩 → 降级返回原文
  const orig = eventText(session, seq)
  if (orig === '') return null
  return { text: orig, source: 'original' }
}

/** 读某事件的 `data[ARG_NS].summary`；缺失 / 空串返回 null。 */
function summaryOfEvent(session: Session, seq: number): SummaryResolution | null {
  const event = sessionEvents(session)[seq]
  if (event === undefined) return null
  const meta = (event.data as Record<string, unknown> | undefined)?.[ARG_NS] as ArgpUserMeta | undefined
  if (meta?.summary !== undefined && meta.summary !== '') return { text: meta.summary, source: 'stored' }
  return null
}

/** 判定某 seq 的节点状态（shadowed / live / off-surface），复用全日志扫描。 */
function nodeState(session: Session, seq: number): NodeState {
  const shadowed = scanShadowedSeqs(session)
  if (shadowed.has(seq)) return 'shadowed'
  for (const node of session.surface.nodes) {
    if (node === seq) return 'live'
  }
  return 'off-surface'
}

export class RecallZoom {
  static inject = [] as const

  private readonly ctx: Context
  private readonly budgetRatio: number
  private readonly detailBudgetChars: number
  private readonly enabled: boolean

  private session: Session | null = null

  /** detail 档单窗累计字符（compaction/end 归零）。 */
  private detailCharsUsed = 0
  /** summary 档单窗累计字符（compaction/end 归零）。 */
  private summaryCharsUsed = 0

  /** 全部召回尝试记录（时间序）。 */
  readonly records: RecallZoomRecord[] = []

  constructor(ctx: Context, config: RecallZoomConfig = {}) {
    this.ctx = ctx
    this.budgetRatio = config.budgetRatio ?? DEFAULT_BUDGET_RATIO
    this.enabled = config.enabled ?? true
    const charsPerToken = config.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN
    const windowTokens = config.windowTokens ?? DEFAULT_WINDOW_TOKENS
    this.detailBudgetChars = config.detailBudgetTokens !== undefined
      ? Math.floor(config.detailBudgetTokens * charsPerToken)
      : Math.floor(windowTokens * DETAIL_WINDOW_RATIO * charsPerToken)

    // 生产 session 绑定：模型在轮中调用工具，此处对齐 argp-graph-engine / PeratomCompressor 的
    // pre-step 绑定点（只绑 session，不干预步进决策——透传 next()）。
    ctx.on('agent/pre-step', async ({ agent }, next) => {
      this.session = agent.session
      return next()
    })

    // 预算滑窗重置：每笔 compaction 事务成功后归零（与 budgetRecallText 同款语义）。
    ctx.on('session/event', (_session, event) => {
      if (event.type === 'compaction/end') {
        this.detailCharsUsed = 0
        this.summaryCharsUsed = 0
      }
    })

    if (!this.enabled) return

    const summaryTool = defineTool({
      name: 'recall_summary',
      description: 'Cheap gist recall of any conversation node by log seq: returns a short summary of what the content was about, not the exact wording. Use it when you need the idea/conclusion but not verbatim strings (exact values, paths, error codes). If the summary is not enough and you need the exact string, escalate to recall_detail(seq). Works on any seq in the append-only log, whether or not it is still visible. The reply is prefixed with [recall-summary seq=N state=...] so you know if the content is currently visible.',
      parameters: { seq: { type: 'integer', description: 'log seq of the node to summarize; placeholders show the seqs they replaced' } },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      execute: async (args): Promise<string> => this.recallSummary((args as { seq?: number }).seq),
    })
    ctx.tools.register(summaryTool)

    const detailTool = defineTool({
      name: 'recall_detail',
      description: 'Exact verbatim recall of any conversation node by log seq: returns the original text byte-for-byte from the append-only log (the verbatim ceiling). Use it when you need the exact string — an error code, a path, a number, a quote — not just the gist. It is the expensive tier (1/4 the budget of recall_summary); for "what was this about" use recall_summary(seq) instead. Works on any seq in the log, whether or not it is still visible. The reply is prefixed with [recall-detail seq=N state=...].',
      parameters: { seq: { type: 'integer', description: 'log seq of the node to recover verbatim' } },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      execute: async (args): Promise<string> => this.recallDetail((args as { seq?: number }).seq),
    })
    ctx.tools.register(detailTool)

    // 两级召回契约（静态，不引用运行时状态——保护 system 前缀缓存）。
    // section 名 argp-recall-zoom（独立于 argp-contract / argp-catalog，避免重名冲突）。
    ctx.systemPrompt.section({
      name: 'argp-recall-zoom',
      order: 151,
      text: () => 'Two-tier recall for content that left your visible context (compressed or pruned): '
        + 'recall_summary(seq) returns a cheap gist ("what it was about"); recall_detail(seq) returns the exact verbatim original. '
        + 'Use recall_summary first for understanding; escalate to recall_detail only when you need an exact string (error code, path, number, quote). '
        + 'Both work on any seq in the log — absence from the visible context never means it was never said. Never reconstruct a recalled value from memory; call the tool.',
    })
  }

  /** detail 档单窗预算（字符）。 */
  get detailBudget(): number { return this.detailBudgetChars }
  /** summary 档单窗预算（字符）= budgetRatio × detail。 */
  get summaryBudget(): number { return Math.floor(this.detailBudgetChars * this.budgetRatio) }
  /** detail 档已用字符（测试断言 / 观测）。 */
  get detailUsed(): number { return this.detailCharsUsed }
  /** summary 档已用字符。 */
  get summaryUsed(): number { return this.summaryCharsUsed }

  setSession(session: Session): void {
    this.session = session
  }

  /** 强制重置预算滑窗（测试 / 手动压缩用；生产由 compaction/end 触发）。 */
  resetBudget(): void {
    this.detailCharsUsed = 0
    this.summaryCharsUsed = 0
  }

  /** 预算引导文案：教模型升档 / 降档，而非硬拒。 */
  private budgetGuidance(tier: 'summary' | 'detail', used: number, budget: number): string {
    if (tier === 'detail') {
      return 'recall_detail: verbatim budget exhausted for this window ('
        + used + '/' + budget + ' chars used since the last compaction). Verbatim recall is the expensive tier — '
        + 'if you only need what the content was about, use recall_summary(seq) (4x the budget). '
        + 'The detail budget resets on the next compaction; retry then if you still need the exact string.'
    }
    return 'recall_summary: summary budget exhausted for this window ('
      + used + '/' + budget + ' chars used since the last compaction). '
      + 'If you need the exact string (error code, path, number), use recall_detail(seq). '
      + 'The summary budget resets on the next compaction; retry then.'
  }

  /** gist 档召回（P3）：三档降级取数 + summary 预算。 */
  async recallSummary(seqArg: number | undefined): Promise<string> {
    const seq = seqArg
    if (seq === undefined || this.session === null) return 'recall_summary: no session bound'
    const session = this.session
    const budget = this.summaryBudget
    if (this.summaryCharsUsed >= budget) {
      this.records.push({ tool: 'recall_summary', seq, hit: false, chars: 0, budgetBlocked: 'summary' })
      return this.budgetGuidance('summary', this.summaryCharsUsed, budget)
    }
    const resolution = resolveSummaryText(session, seq)
    if (resolution === null) {
      this.records.push({ tool: 'recall_summary', seq, hit: false, chars: 0, reason: 'no-text' })
      return formatRecallOutcome('recall_summary', seq, { ok: false, reason: 'no-text', state: nodeState(session, seq) })
    }
    const state = nodeState(session, seq)
    const allowed = Math.min(resolution.text.length, budget - this.summaryCharsUsed)
    const truncated = resolution.text.length > allowed
    const post = this.summaryCharsUsed + allowed
    // 预算只计实际投递的正文（allowed）；截断 marker 是固定长度诊断元信息，不计入。
    const body = truncated
      ? resolution.text.slice(0, allowed) + '…(truncated: summary recall budget ' + post + '/' + budget + ' chars)'
      : resolution.text
    this.summaryCharsUsed = post
    this.records.push({ tool: 'recall_summary', seq, hit: true, state, source: resolution.source, chars: allowed })
    const suffix = resolution.source === 'original'
      ? '\n[no stored summary for seq ' + seq + ' — returning original text]'
      : ''
    return stateHeader(seq, state).replace('[recall seq=', '[recall-summary seq=') + '\n' + body + suffix
  }

  /** exact 档召回（verbatim 天花板）：日志原文逐字节 + detail 预算。 */
  async recallDetail(seqArg: number | undefined): Promise<string> {
    const seq = seqArg
    if (seq === undefined || this.session === null) return 'recall_detail: no session bound'
    const session = this.session
    const budget = this.detailBudget
    if (this.detailCharsUsed >= budget) {
      this.records.push({ tool: 'recall_detail', seq, hit: false, chars: 0, budgetBlocked: 'detail' })
      return this.budgetGuidance('detail', this.detailCharsUsed, budget)
    }
    const shadowed = scanShadowedSeqs(session)
    const outcome = recallFromLog(session, seq, s => shadowed.has(s), eventText)
    if (!outcome.ok) {
      this.records.push({ tool: 'recall_detail', seq, hit: false, chars: 0, reason: outcome.reason === 'out-of-range' ? 'out-of-range' : 'no-text' })
      return formatRecallOutcome('recall_detail', seq, outcome)
    }
    const allowed = Math.min(outcome.text.length, budget - this.detailCharsUsed)
    const truncated = outcome.text.length > allowed
    const post = this.detailCharsUsed + allowed
    // 预算只计实际投递的正文（allowed）；截断 marker 是固定长度诊断元信息，不计入。
    const body = truncated
      ? outcome.text.slice(0, allowed) + '…(truncated: detail recall budget ' + post + '/' + budget + ' chars)'
      : outcome.text
    this.detailCharsUsed = post
    this.records.push({ tool: 'recall_detail', seq, hit: true, state: outcome.state, chars: allowed })
    return stateHeader(seq, outcome.state).replace('[recall seq=', '[recall-detail seq=') + '\n' + body
  }
}

export default RecallZoom
