/**
 * ARGP t1 引擎（spike 4，M2）：机制验证版压缩引擎（16K 压缩窗口）。
 *
 * 与 ARGP 定稿形态的差距（机制验证版妥协，记入设计稿 §10 spike 4）：
 *  - 无 LLM 建边（cites/图构建器属 M3）：剪枝序 = 最旧优先 + U 载体保护 + 近因豁免，
 *    U 载体保护即"回答→触发问题"架构先验的最小形态（不变式 6：U 非被覆盖永不遮蔽）
 *  - 占位主路径（spike 2 判决 b，§8.3）：被剪区间换出 tombstone checkpoint 节点
 *  - 事务仿 compaction-basic：compaction/start（锁）→ compaction/summary（影子价）→
 *    user/message checkpoint（surfaceOp replace + compactCheckpointSource）→ compaction/end；
 *    compaction/* 事件由引擎自己 append
 *  - 实测发现（写死注释）：compaction/prune 事件不进 start/summary/end 不变式状态机
 *    （不置 summarized 位），无 LLM 剪枝要进事务括号只能借 compaction/summary 语义
 *    （provider/model 字段标记为算法剪枝）——已记入台账，候选卡点 B-3
 *  - 0 LLM 调用、确定性收敛：触发与目标同一可见字符估算基准（不变式 2，预算基准一致性）；
 *    reasoning 块不计入预算——spike 4a 判决 C 实证服务端 preserve_thinking=false，
 *    历史 thinking 不进 prompt，无剪枝对象，引擎无需 thinking 剥离机制
 *
 * recall 闭环内嵌（spike 3 能力合并）：recall_pruned 工具 + argp-contract 契约段 +
 * append-only 日志原文找回——CompactionEngine 服务槽唯一，不能与 ArgpRecallEngine 并挂。
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
import { deriveEventMessage } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { formatRecallOutcome, recallFromLog } from './log-access.js'
import type { NodeState } from './log-access.js'

export interface ArgpT1Config {
  /** 压力阈值（默认 16384 token）：surface 可见估算量超过即触发剪枝。 */
  windowTokens?: number
  /** 剪枝目标（默认 8192 token）：从最旧剪到此估算量以下。 */
  retainTokens?: number
  /** 近因豁免：surface 末尾 N 个节点不参剪（默认 4）。 */
  recencyGuard?: number
  /** 微剪枝下限（默认 512 字符）：低于此量的 span 不值得 tombstone（净增占位字符 + KV 失效）。 */
  minSpanChars?: number
  /** 估算基准：英文 1 token 约 3.5 字符；触发与目标同基准（不变式 2）。 */
  charsPerToken?: number
  /** 单次剪枝事务的最大贪心 pass 数（默认 8；机制验证档固定，生产档可按需调高）。 */
  maxPasses?: number
}

/** 一次剪枝事务的观测记录（spike 断言直接读这里）。 */
export interface PruneRecord {
  at: string
  compactionId: string
  startEventSeq: number
  summaryEventSeq: number
  tombstoneSeq: number
  endEventSeq: number
  shadowedSeqs: number[]
  shadowedTokenCount: number
  charsBefore: number
  charsAfter: number
}

/** 收集当前日志里全部被遮蔽的 surface seq（replace 事件 sourceEventSeqs 的并集）。 */
function shadowedSeqs(session: Session): Set<number> {
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

/** 从一个事件投影出模型可见文本（text + tool-call 概要 + tool-result 内层 text；reasoning 块不算）。 */
function eventText(session: Session, seq: number): string {
  const event = session.events[seq]
  if (event === undefined) return ''
  const message = deriveEventMessage(event)
  if (message === null) return ''
  const parts: string[] = []
  for (const block of message.content) {
    if (block.type === 'text') parts.push(block.text)
    if (block.type === 'tool-call') {
      parts.push('[tool-call ' + block.name + '(' + (typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments)) + ')]')
    }
    if (block.type === 'tool-result') {
      for (const inner of block.content ?? []) {
        if (inner.type === 'text') parts.push(inner.text)
      }
    }
  }
  return parts.join('\n')
}

/** surface 可见字符总量（与 prompt 实际负担对齐：历史 reasoning 不回放，不计入）。 */
function visibleChars(session: Session): number {
  let total = 0
  for (const seq of session.surface.nodes) {
    total += eventText(session, seq).length
  }
  return total
}

/** 日志尾部的 open turn（pre-step 时刻用于 compaction 括号的 owner）。 */
function detectOpenTurn(session: Session): number | null {
  for (let index = session.events.length - 1; index >= 0; index -= 1) {
    const event = session.events[index]
    if (event === undefined) continue
    if (event.type === 'turn/start') return (event.data as { turn: number }).turn
    if (event.type === 'turn/end') return null
  }
  return null
}

export class ArgpT1Engine extends CompactionEngine {
  // cordis 约束：fiber 内访问其他服务必须先声明 inject（仿 compaction-basic / recall-engine）
  static inject = ['tools', 'systemPrompt']

  readonly windowTokens: number
  readonly retainTokens: number
  readonly recencyGuard: number
  readonly minSpanChars: number
  readonly charsPerToken: number
  readonly maxPasses: number

  /** 全部剪枝事务记录（spike 断言直接读这里）。 */
  readonly records: PruneRecord[] = []
  /** recall_pruned 调用台账（服从率基线度量用）。 */
  readonly recallCalls: { seq: number; hit: boolean; state?: NodeState }[] = []

  private session: Session | null = null

  constructor(ctx: Context, config: ArgpT1Config = {}) {
    super(ctx)
    this.windowTokens = config.windowTokens ?? 16_384
    this.retainTokens = config.retainTokens ?? 8_192
    this.recencyGuard = config.recencyGuard ?? 4
    this.minSpanChars = config.minSpanChars ?? 512
    this.charsPerToken = config.charsPerToken ?? 3.5
    this.maxPasses = config.maxPasses ?? 8

    const recallTool = defineTool({
      name: 'recall_pruned',
      description: 'Retrieve the original content of any conversation node by its log seq, whether or not it is still in visible context. The reply is prefixed with [recall seq=N state=shadowed|live|off-surface]. Everything ever said stays in the append-only log; use this instead of guessing.',
      parameters: { seq: { type: 'integer', description: 'log seq of the node to recover; placeholders show the seqs they replaced' } },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      execute: async (args): Promise<string> => {
        const seq = (args as { seq?: number }).seq
        if (seq === undefined || this.session === null) return 'recall_pruned: no session bound'
        // P1 修复 (b)：去掉 shadowedSeqs 门控，只有越界才算失败（与 argp-graph-engine 同构）
        const shadowed = shadowedSeqs(this.session)
        const outcome = recallFromLog(this.session, seq, s => shadowed.has(s), eventText)
        this.recallCalls.push({ seq, hit: outcome.ok, state: outcome.ok ? outcome.state : undefined })
        return formatRecallOutcome('recall_pruned', seq, outcome)
      },
    })
    ctx.tools.register(recallTool)

    // 引用契约（与 spike 3 同文，order 150：tool guidance 100–199 约定段）
    ctx.systemPrompt.section({
      name: 'argp-contract',
      order: 150,
      text: () => 'ARGP contract: some history nodes are pruned to placeholders like [elided seq=N ...]. '
        + 'When your answer depends on elided content, call recall_pruned with that seq first — never reconstruct elided facts from memory.',
    })

    // 仿 compaction-basic：引擎自挂步间压力钩子，动态分派 compactIfNeeded
    ctx.on('agent/pre-step', async ({ agent, signal }, next): Promise<PreStepDecision> => {
      if (this.session === null) this.session = agent.session
      if (!signal.aborted) {
        try {
          await this.compactIfNeeded(agent, 'pressure', signal)
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error)
          ctx.logger.warn(`argp-t1 pressure prune failed: ${message}; continuing the turn`)
        }
      }
      return next()
    })
  }

  /** 注入/替换引擎绑定的 session（spike 侧创建 agent 后显式调用）。 */
  setSession(session: Session): void {
    this.session = session
  }

  /** 按被遮蔽 seq 找回原文；未命中返回 null。 */
  recall(seq: number): string | null {
    if (this.session === null) return null
    if (!shadowedSeqs(this.session).has(seq)) return null
    const text = eventText(this.session, seq)
    return text === '' ? null : text
  }

  /** surface 可见 token 估算（触发与目标同基准）。 */
  estimateTokens(session: Session): number {
    return Math.ceil(visibleChars(session) / this.charsPerToken)
  }

  /**
   * 压力剪枝：估算量 ≥ windowTokens 时从最旧可剪区间逐段 tombstone，
   * 直到 ≤ retainTokens 或无可剪区间。0 LLM 调用，确定性收敛。
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
    if (visibleChars(session) < thresholdChars) return null

    let last: CompactionResult | null = null
    for (let pass = 0; pass < this.maxPasses; pass += 1) {
      const span = this.selectOldestSpan(session)
      if (span === null) break
      last = this.pruneSpan(session, span)
      if (visibleChars(session) <= retainChars) break
    }
    if (last !== null) {
      this.ctx.logger.info(
        `[argp-t1] pruned to ~${this.estimateTokens(session)} tokens `
        + `(${this.records.length} transactions total)`,
      )
    }
    return last
  }

  override async compactNow(
    _agent: ManualCompactAgentContext,
    _signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    throw new Error('argp-t1: compactNow not implemented in spike 4 (mechanism validation)')
  }

  override async compactRegion(): Promise<CompactionResult> {
    throw new Error('argp-t1: compactRegion not implemented in spike 4 (mechanism validation)')
  }

  /**
   * 选最旧一段可剪连续 surface 区间：
   *  - U 载体保护：user/message 节点永不参剪（不变式 6，needle 唯一载体）
   *  - 近因豁免：surface 末尾 recencyGuard 个节点不参剪
   *  - tool 配对自保：user 节点不剪 ⇒ assistant(tool-call)/tool(result) 对不会被切散
   *  - 微剪枝下限：可见量 < minSpanChars 的 span 不剪（实测：reasoning-only 助手节点
   *    可见文本 0，剪了净增 tombstone 字符且白付 KV 失效代价）
   */
  private selectOldestSpan(session: Session): number[] | null {
    const seqs = [...session.surface.nodes]
    const candidates = seqs.slice(0, Math.max(0, seqs.length - this.recencyGuard))
    let span: number[] = []
    let spanChars = 0
    for (const seq of candidates) {
      const event = session.events[seq]
      if (event === undefined || event.type === 'user/message') {
        // 小 span 跳过而非终止：避免微节点挡住后面大 span（确定性不变）
        if (span.length > 0 && spanChars >= this.minSpanChars) return span
        span = []
        spanChars = 0
        continue
      }
      span.push(seq)
      spanChars += eventText(session, seq).length
    }
    if (span.length === 0 || spanChars < this.minSpanChars) return null
    return span
  }

  /** 一次完整剪枝事务：start（锁）→ summary（影子价）→ checkpoint replace → end。 */
  private pruneSpan(session: Session, seqs: number[]): CompactionResult {
    const charsBefore = visibleChars(session)
    const openTurn = detectOpenTurn(session)
    const compactionId = CompactionId('argp-t1-' + randomUUID())
    const lifecycle = { compactionId, turn: openTurn }
    const start = seqs[0] as number
    const end = seqs[seqs.length - 1] as number

    const startEvent = session.append('compaction/start', lifecycle)
    try {
      const shadowedTokenCount = Math.ceil(
        seqs.reduce((sum, seq) => sum + eventText(session, seq).length, 0) / this.charsPerToken,
      )
      const tombstoneText = '[elided seq=' + start + '..' + end + ': ' + seqs.length
        + ' surface nodes pruned by ARGP (window pressure, 0-LLM); recall_pruned(seq) retrieves original]'
      // 无 LLM 剪枝借 summary 语义进事务括号：provider/model 标记为算法剪枝（候选卡点 B-3）
      const summaryEvent = session.append('compaction/summary', {
        ...lifecycle,
        summary: [{ type: 'text', text: tombstoneText }],
        shadowedRange: { start, end },
        shadowedSeqs: seqs,
        shadowedTokenCount,
        provider: 'argp',
        model: 'algorithmic-tombstone',
      })
      const tombstone = session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: tombstoneText }],
        source: compactCheckpointSource(compactionId),
      }), {
        surfaceOp: { op: 'replace', start, end },
        sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...seqs],
      })
      const endEvent = session.append('compaction/end', lifecycle)
      const charsAfter = visibleChars(session)
      this.records.push({
        at: new Date().toISOString(),
        compactionId,
        startEventSeq: startEvent.seq,
        summaryEventSeq: summaryEvent.seq,
        tombstoneSeq: tombstone.seq,
        endEventSeq: endEvent.seq,
        shadowedSeqs: seqs,
        shadowedTokenCount,
        charsBefore,
        charsAfter,
      })
      return {
        compactionId,
        startSeq: startEvent.seq,
        summarySeq: summaryEvent.seq,
        endSeq: endEvent.seq,
        summary: [{ type: 'text', text: tombstoneText }],
        shadowedRange: { start, end },
        shadowedSeqs: seqs,
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
}

export default ArgpT1Engine
