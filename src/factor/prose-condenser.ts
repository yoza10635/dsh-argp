/**
 * 散文浓缩链（P6-④ 共批，2026-11-12 开工）：工具原子归 factor 协议组剪（A+R 整组、
 * 压缩检查点占位、标签召回），散文（U + 无 R 的 final A，textA）归 LLM 原生式浓缩。
 *
 * 用户裁定（docs §9.22/§9.23 三裁定 + §9.36 改版 + 2026-11-13 组剪裁定）：
 *  - **触发** = 合取双闸（§9.36）：闸一 =（system 头 + **textA 散文字符**）÷ 声明窗 ≥ 50%
 *    （本类内查；toolCallA/rPair 不计入散文，见 ua-input 分类器）；闸二 = 总上下文 ≥
 *    windowRatio(0.8)×声明窗（引擎侧 condenseGate 查，usage 账单锚，事后形）。400 事务内
 *    与手动 compactNow 的调用点保留（手动免闸二）；分母 = 声明窗，声明未知 ⇒ 跳过不猜；
 *  - **动作** = one-shot、replay 前缀 + 尾部指令；**输入 = U + final A（textA）**，
 *    工具原子（CALL/RESULT）不进摘要（2026-11-13 用户裁定，反转 §9.36 全栈输入）；
 *  - **刀深** = 清扫式合并（§9.36 H2 终裁）：焦点外可驱前缀一轮全吞；容量保证归 factor；
 *  - **驱逐** = 轮级贪心：从最老轮起整轮驱逐——轮内全部原子（散文/工具对/可吞 X）随轮
 *    离场；连续整轮段一笔 replace 落**单条浓缩检查点**；**不再做 partial 逐原子指针**
 *    （用户裁定召回走标签，partial 散点原样保留，零 seq 指针墓碑）；
 *  - **无逐字转写带、无保真守卫**：原始信息有 recall 兜底（标签制），逐字精确性不进本链；
 *  - **浓缩节点带结构化 kind**：source=compact-checkpoint（宿主结构化源，prune-tx 统一写）
 *    + 文本标记 PROSE_CHECKPOINT_PREFIX（resume 找回/统计识别，VOCAB_NOTE_MARKER 同款
 *    判据纪律）；节点归 X ⇒ 不参与下轮散文统计（天然出池，不自我滚雪球）。
 *
 * 轮级贪心的**位置纪律**（atomize 实测约束）：atom.turn 取 `data.turn`，而 prune-tx 的
 * user 墓碑 replace 不带 turn 字段 ⇒ 墓碑 X 原子 turn=0——按 turn 号分组会把墓碑错编成
 * "turn 0 伪轮"。故分组按 **surface 连续 run**（相邻同 turn 号归一段，无原子节点断段），
 * open turn 用**位置**守卫（run 起点 ≥ open turn 首节点位置即停），焦点窗用 turn 号守卫
 * （turn=0 伪轮天然在焦点号之下，位置上若落在 open 区已被位置守卫拦住）。
 */
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Message } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { CompactionResult } from '@deepseek-ai/dsh-compaction'
import { eventText, rawEventFaces, sessionEvents } from '../log-access.ts'
import { pruneIntervals, type PruneTxHost } from '../prune-tx.ts'
import type { Atom } from '../argp-types.ts'
import { isFactorTombstoneText, isMergeableTombstoneText } from '../tombstone-text.js'
import { classifyUaAtom, type SummaryInputClass, type UaEventProbe } from './ua-input.ts'
import { hasAttachmentBlocks, STUB_PREFIX } from './factor-atoms.ts'
import { FACTOR_COMPACTED_MARKER, VOCAB_NOTE_MARKER } from '../constants.ts'
import { autoDshLlmSpec, completeViaDshLlm, type AgentRouteHint } from '../peratom/llm-adapter.ts'

/** 散文占比触发线（分母=声明窗，含 system 头）。§9.36 合取双闸之闸一（50% 线原样保留）；
 *  闸二（总上下文 ≥ windowRatio×声明窗）在引擎侧 condenseGate 把关，两闸齐过才开压。 */
export const PROSE_TRIGGER_RATIO = 0.5

/** 浓缩节点文本标记（单一事实源：生成与识别同文件——VOCAB_NOTE_MARKER 同款纪律）。 */
export const PROSE_CHECKPOINT_PREFIX = '[散文压缩]'

/**
 * 摘要调用输出预算（§9.36 H5 终裁 2026-11-13：8192→20480——R1 回放实测两发顶到
 * 8192 顶=检查点被人为掐长；20480 ≤ 0.2×262,144=52,429 预留位内）。
 * 小声明窗守卫（H5）：实际传入 = min(本值, 0.2×声明窗 − 指令预算)，见 condense()。
 */
export const PROSE_SUMMARY_MAX_TOKENS = 20_480

/** 小窗守卫给指令与协议开销留的 token 数（H5 式子中的常数项）。 */
const PROSE_INSTRUCTION_TOKEN_RESERVE = 512

/** LLM 超时（DEFAULT_LLM_TIMEOUT_MS 同源口径）。 */
const PROSE_LLM_TIMEOUT_MS = 180_000

/**
 * 原生 compaction-basic 的 checkpoint 框架语（CHECKPOINT_PREAMBLE 逐字同款）：
 * 使替换节点被读作"既定背景"而非待答问题。
 */
const CHECKPOINT_PREAMBLE = 'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.'

/**
 * 摘要指令 v2（§9.36 全栈带 tool 裁定；文本=回放实测形 replay/stage2-replay.py）：
 * transcript 面 = "U:" 用户 / "A:" 助手 / "CALL name(args)" 工具调用 / "RESULT ..."
 * 工具结果（均日志原文）。旧 v1 的 "Tool outputs are NOT included" 规则行随全栈裁定删除。
 */
const PROSE_COMPACTION_INSTRUCTION = [
  'You are now acting as a compaction engine for this AI coding assistant. Condense the conversation transcript ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context. The transcript contains only the conversational prose: "U:" user messages and "A:" assistant final messages. Tool calls and tool outputs are NOT part of this transcript (they are recallable by label if needed).',
  '',
  'Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section — never drop a section.',
  '',
  '## Primary Request and Intent',
  '- [the user\'s original and evolving goals; quote verbatim where the exact wording matters]',
  '',
  '## Key Technical Concepts',
  '- [technologies, frameworks, patterns, and conventions in play]',
  '',
  '## Decisions and Rationale',
  '- [decisions made and why, user feedback and corrections]',
  '',
  '## Actions and Findings (from the assistant\'s final messages)',
  '- [what the assistant reported doing; tool outputs are not part of this transcript and are recallable by label]',
  '',
  '## Pending Jobs',
  '- [explicitly requested work not yet completed]',
  '',
  '## Current Work',
  '- [precisely what was in progress at this checkpoint]',
  '',
  '## Next Step',
  '- [the single next action, directly in line with the most recent request, or "(none)"]',
  '',
  '## Critical Context',
  '- [constraints, user preferences, open questions, data needed to continue]',
  '',
  'Rules:',
  '- Write concise engineering prose. Preserve exact file paths, commands, error strings, identifiers, numeric values, and syntax fragments from the conversation.',
  '- Capture user feedback and explicit instructions faithfully, especially corrections.',
  '- Do NOT mention this summarization request or that the context was compacted.',
  '- Output only the checkpoint text: do not call any tool or take any other action.',
].join('\n')

/** 事件读侧探针（同 ua-input 口径：source.form + 附件块）。 */
export interface ProseEventProbe {
  form?: string
  attachment: boolean
}

/** 轮级贪心计划（纯函数输出；发射在 ProseCondenser.condense）。 */
export interface ProseEvictPlan {
  /** 连续整轮段的 surface seqs（一笔 replace → 单浓缩节点；按 surface 位置升序）。 */
  spanSeqs: number[]
  /** 逐原子散文驱逐 seqs（破段轮；每 seq 独立区间+指针墓碑）。 */
  partialSeqs: number[]
  /** 计划驱逐的散文字符（span + partial 的 textA 文本和）。 */
  evictedProseChars: number
  /** 全上下文散文字符（U/A 文本和；触发统计口径，含受保护轮）。 */
  proseCharsAll: number
  stopReason: 'need-met' | 'exhausted' | 'no-candidate'
}

/** 贪心入参：surface 节点序 + 需释放的散文字符下界 + 保护窗。 */
export interface ProseEvictOptions {
  needChars: number
  /** 焦点保护线：turn ≥ 该号的轮不驱逐（latestTurn − focalTurns + 1；focalTurns=0 ⇒ Infinity）。 */
  protectFromTurn: number
  /** open turn 首节点的 surface 位置（null = 无 open turn）；run 起点 ≥ 该位置即停。 */
  openTurnFromPos: number | null
}

/**
 * 轮级贪心（纯函数，单测主对象）。surface 按**连续 run** 分组（相邻同 turn 号），逐段晋升：
 * 整轮可驱逐（段内全部原子 ∈ textA/toolCallA/rPair/可吞 X，且段内有散文）→ 并入整轮段；
 * 首个破段（含 barrier/excluded-不可吞）→ 其 textA 原子逐个进 partialSeqs，贪心停止。
 */
export function planProseEviction(
  atoms: readonly Atom[],
  probes: ReadonlyMap<number, ProseEventProbe>,
  surfaceSeqs: readonly number[],
  options: ProseEvictOptions,
): ProseEvictPlan {
  const atomsBySeq = new Map<number, Atom>(atoms.map(a => [a.seq, a]))
  const clsOf = (atom: Atom): { cls: SummaryInputClass; swallowableX: boolean } => {
    const probe = probes.get(atom.seq) ?? { attachment: false }
    const cls = classifyUaAtom(atom, probe)
    // X 的可吞性细化：可并墓碑（[elided 空格族）+ 本链历史浓缩节点（[散文压缩]）
    // + 桩族（STUB_PREFIX：因子桩/夹剪/占位桩）+ 协议组空占位（argp-removed）。
    // 宿主官方 checkpoint / 词表 note / system-reminder 等 excluded-X 永不吞。
    const swallowableX = cls === 'excluded' && atom.type === 'X'
      && (probe?.form === 'argp-removed'
        || atom.text.trimStart().startsWith(FACTOR_COMPACTED_MARKER)
        || atom.text.trimStart().startsWith(VOCAB_NOTE_MARKER)
        || isMergeableTombstoneText(atom.text)
        || isFactorTombstoneText(atom.text)
        || atom.text.trimStart().startsWith(PROSE_CHECKPOINT_PREFIX)
        || atom.text.trimStart().startsWith(STUB_PREFIX))
    return { cls, swallowableX }
  }
  const proseOf = (atom: Atom, cls: SummaryInputClass): number =>
    cls === 'textA' ? atom.text.length : 0

  // 全局统计：散文字符 = **textA**（U + 无 tool-call 的 final A）——用户 2026-11-13 澄清的
  // 原始设计。toolCallA（K）与 rPair 属 factor 协议组，不计入散文；excluded/barrier 也不计。
  let proseCharsAll = 0
  for (const a of atoms) {
    const probe = probes.get(a.seq) ?? { attachment: false }
    if (classifyUaAtom(a, probe) === 'textA') proseCharsAll += a.text.length
  }

  // surface 连续 run 分组：相邻节点同 turn 号归一段；无原子节点（system 头/未知类型）断段。
  interface Run { turn: number; seqs: number[]; startPos: number }
  const runs: Run[] = []
  let cur: Run | null = null
  let holePos = -1
  let sawAtom = false
  for (let pos = 0; pos < surfaceSeqs.length; pos += 1) {
    const seq = surfaceSeqs[pos] as number
    const atom = atomsBySeq.get(seq)
    if (atom === undefined) {
      cur = null
      // 非原子表面节点（system/message 等）是**硬洞**：span 作为单区间 replace 必须
      // 覆盖区间内全部 surface 节点，而这些节点没有原子 ⇒ sourceEventSeqs 缺项，
      // 宿主 assert 直接 throw（LLM 已经付过费）。首个洞之前可以正常规划；跨洞即停。
      if (sawAtom && holePos < 0) holePos = pos
      continue
    }
    sawAtom = true
    if (cur !== null && cur.turn === atom.turn) {
      cur.seqs.push(seq)
      continue
    }
    cur = { turn: atom.turn, seqs: [seq], startPos: pos }
    runs.push(cur)
  }

  const spanSeqs: number[] = []
  const partialSeqs: number[] = []
  let evicted = 0
  let stopped = false
  for (const run of runs) {
    if (holePos >= 0 && run.startPos > holePos && (spanSeqs.length > 0 || partialSeqs.length > 0)) { stopped = true; break }
    if (options.openTurnFromPos !== null && run.startPos >= options.openTurnFromPos) { stopped = true; break }
    if (run.turn >= options.protectFromTurn) { stopped = true; break }
    // 整轮可驱逐判定：段内无 barrier、无不可吞 excluded、无 U-info 副本（excluded-X 可吞例外）。
    let whole = true
    let runProse = 0
    for (const seq of run.seqs) {
      const atom = atomsBySeq.get(seq)
      if (atom === undefined) { whole = false; break }
      const { cls, swallowableX } = clsOf(atom)
      if (cls === 'barrier' || (cls === 'excluded' && !swallowableX)) { whole = false; break }
      runProse += proseOf(atom, cls)
    }
    if (whole && runProse > 0) {
      spanSeqs.push(...run.seqs)
      evicted += runProse
      if (evicted >= options.needChars) { stopped = true; break }
      continue
    }
    if (whole && runProse === 0) {
      // 0 散文段（历史墓碑 run / 纯工具 run）：只在已有散文进账时搭车并入（桥接连续段），
      // 领头跑空转——整段无散文时计划落空（no-candidate）。
      if (evicted > 0) spanSeqs.push(...run.seqs)
      continue
    }
    // 破段：textA 原子逐个驱逐（指针墓碑），贪心停止（不跨洞续段）。
    for (const seq of run.seqs) {
      const atom = atomsBySeq.get(seq)
      if (atom === undefined) continue
      const { cls } = clsOf(atom)
      if (cls !== 'textA') continue
      partialSeqs.push(seq)
      evicted += proseOf(atom, cls)
    }
    stopped = true
    break
  }
  // stopped=false 且未达需释放量 = 候选耗尽，仍返回计划（能驱尽驱，方向安全）。
  const stopReason: ProseEvictPlan['stopReason'] =
    spanSeqs.length === 0 && partialSeqs.length === 0 ? 'no-candidate'
      : evicted >= options.needChars ? 'need-met' : 'exhausted'
  return {
    spanSeqs, partialSeqs,
    evictedProseChars: evicted,
    proseCharsAll,
    stopReason,
  }
}

/** 浓缩节点文本（标记行在前：resume 找回与统计识别按 startsWith 判）。 */
export function proseCheckpointText(summary: string): string {
  return PROSE_CHECKPOINT_PREFIX + '\n' + CHECKPOINT_PREAMBLE + '\n\n<compacted-summary>\n'
    + summary.trim() + '\n</compacted-summary>'
}

export interface ProseCondenserConfig {
  /** 焦点轮数（焦点轮不入驱逐池；同 FactorEngine 口径）。设置卡旋钮 → 引擎侧传 getter 活读。 */
  focalTurns?: number | (() => number)
  /** LLM 超时（缺省 180s）。 */
  llmTimeoutMs?: number
  /** 测试注入：替代 dsh-llm 的补全函数（缺省走 ctx.llm + autoDshLlmSpec）。 */
  complete?: (spec: { provider: string; model: string }, prompt: string, timeoutMs: number) => Promise<string>
}

/**
 * 散文浓缩编排：触发判定 → 轮级贪心 → one-shot LLM（sys+散文 replay）→ prune-tx 发射。
 * 返回 null = 未动作（未过触发线 / 无候选 / LLM 不可用或失败）——不静默，逐条落 log。
 */
export class ProseCondenser {
  private readonly ctx: Context
  private readonly host: PruneTxHost
  private readonly cfg: {
    focalTurns: () => number; llmTimeoutMs: number
    complete?: ProseCondenserConfig['complete']
  }

  constructor(ctx: Context, host: PruneTxHost, config: ProseCondenserConfig = {}) {
    this.ctx = ctx
    this.host = host
    // 裸值/getter 双形归一（FactorEngine 同法）：引擎侧传 getter = 活读 volatile 旋钮。
    const asGetter = (v: number | (() => number) | undefined, d: number): (() => number) =>
      typeof v === 'function' ? v : () => v ?? d
    this.cfg = {
      focalTurns: asGetter(config.focalTurns, 1),
      llmTimeoutMs: config.llmTimeoutMs ?? PROSE_LLM_TIMEOUT_MS,
      complete: config.complete,
    }
  }

  /**
   * 双闸合取的闸一（散文 ≥50% 线）在本方法内查；闸二（ctx ≥ windowRatio×声明窗）由调用点
   * 保证（condenseGate / 400 事务天然满足；手动 compactNow 免闸二）。
   * windowTokens = 触发线（分母口径同旧：声明窗×windowRatio 前的声明值——引擎传缩放后
   * windowTokens，此处仅作分母）；declaredWindow = 适配器声明窗原值（H5 小窗守卫用）。
   */
  async condense(
    session: Session,
    route: AgentRouteHint,
    windowTokens: number,
    signal?: AbortSignal,
    declaredWindow = 0,
  ): Promise<CompactionResult | null> {
    if (windowTokens <= 0) {
      this.host.log.info('[argp-factor-prose] 声明窗未知（windowTokens<=0）：散文浓缩跳过（分母=声明窗，不猜物理口径）')
      return null
    }
    const spec = this.resolveSpec(route)
    if (spec === null) {
      this.host.log.info('[argp-factor-prose] LLM 后端不可用（无路由或宿主无 llm 服务）：散文浓缩 disabled，零网络')
      return null
    }
    const events = sessionEvents(session) as unknown as Array<{ seq: number; type: string; data?: Record<string, unknown> }>
    const probes = this.buildProbes(session)
    const atoms = this.host.atomize(session)
    const surfaceSeqs = [...session.surface.nodes] as unknown as number[]
    // system 头字符：surface 节点 0 为 system/message 才计（原生 systemHead 同判）。
    let sysChars = 0
    const headSeq = surfaceSeqs[0]
    const headEvent = headSeq !== undefined ? events[headSeq] : undefined
    if (headEvent !== undefined && headEvent.type === 'system/message') {
      sysChars = eventText(session, headSeq as number).length
    }
    // 需释放量 =（sys+散文）− 声明窗×50%；>0 才动作。
    // 分母必须是**声明窗**（§9.36 闸一原义），不是缩放后的触发线：windowTokens =
    // 声明窗×windowRatio（缺省 0.8），用它会让 50% 线实际降到 40% 声明窗、浓缩提前
    // 触发（windowRatio 调小则更早）。声明值未知时才退回触发线（保守近似）。
    const gateWindow = declaredWindow > 0 ? declaredWindow : windowTokens
    const windowChars = gateWindow * this.host.charsPerToken
    const lineChars = Math.floor(windowChars * PROSE_TRIGGER_RATIO)
    const pre = planProseEviction(atoms, probes, [], {
      needChars: 0, protectFromTurn: Number.POSITIVE_INFINITY, openTurnFromPos: null,
    })
    const proseCharsAll = pre.proseCharsAll
    const needChars = sysChars + proseCharsAll - lineChars
    if (needChars <= 0) {
      this.host.log.info('[argp-factor-prose] 散文占比 ' + Math.round(((sysChars + proseCharsAll) / Math.max(windowChars, 1)) * 100)
        + '% ≤ 触发线 ' + Math.round(PROSE_TRIGGER_RATIO * 100) + '%：不浓缩')
      return null
    }
    // 注：needChars 至此只作闸一（散文线）判据用；驱逐计划不再按需量收刀（下方清扫式）。
    // 保护窗：open turn 位置 + 焦点轮号（与 factor decide 同焦点口径）。
    const latestTurn = atoms.reduce((m, a) => Math.max(m, a.turn), 0)
    const openTurnSeq = this.openTurnFirstSeq(session)
    const openTurnFromPos = openTurnSeq === null ? null : Math.max(0, surfaceSeqs.indexOf(openTurnSeq))
    const focalTurns = this.focalTurnsOf()
    const protectFromTurn = focalTurns > 0 ? latestTurn - focalTurns + 1 : Number.POSITIVE_INFINITY
    // §9.36 H2 终裁=清扫式合并：span=焦点外可驱前缀一轮全吞（顶到焦点/open/洞界），
    // 不按需量收刀——压缩比不可控的刀不挂"压到线 X"的保证语义（容量归确定性剪枝层）。
    const plan = planProseEviction(atoms, probes, surfaceSeqs, {
      needChars: Number.POSITIVE_INFINITY, protectFromTurn, openTurnFromPos,
    })
    if (plan.stopReason === 'no-candidate') {
      this.host.log.info('[argp-factor-prose] 无可驱逐散文段（全部受保护/含 barrier）：不浓缩')
      return null
    }
    // 仅散点（无整轮段）：partial A 的指针在 2.0 不可召回（无 seq 通道、A 无标签），
    // 蒸发即模型侧数据丢失；且没有检查点承载 LLM 摘要（白付一次调用）。不动作。
    if (plan.spanSeqs.length === 0) {
      this.host.log.info('[argp-factor-prose] 仅散点（无整轮段）：不动作（指针不可召回，保原文）')
      return null
    }
    // 配对闭包预检（2026-11-13 审查 P0-2）：span 不得把 A 与它的 R 切成两半——
    // 洞/barrier/焦点线都可能停在 A 之后、R 之前。不闭合 ⇒ 本轮不浓缩（保原文，
    // 不付 LLM、不产生孤儿 tool result）。
    const balance = this.spanPairingBalanced(atoms, new Set(plan.spanSeqs))
    if (!balance.ok) {
      this.host.log.warn('[argp-factor-prose] span 配对不闭合（' + balance.reason + '）：本轮不浓缩（保原文）')
      return null
    }
    // 摘要输入 = 整轮 span 的**散文**（U + 无 R 的 final A；2026-11-13 用户裁定）。
    // 工具原子（toolCallA/rPair）不进摘要，由 factor 协议组剪负责；span 内工具原子随整轮
    // 离场但不喂 LLM，原文经 recall_history(labels) 召回。
    const evictedSet = new Set<number>(plan.spanSeqs)
    const spanMessages = this.buildProseMessages(atoms, probes, surfaceSeqs, evictedSet)
    const summary = await this.callLlm(spec, spanMessages, signal, declaredWindow)
    if (summary.trim().length === 0) {
      this.host.log.warn('[argp-factor-prose] LLM 摘要空输出（保原文，本轮不浓缩）')
      return null
    }
    // 发射：整轮段 1 区间 + 1 浓缩检查点。**不再逐原子指针**（用户裁定：召回走标签，
    // 不走指针；partial 散点原样保留，避免产生任何 seq 指针墓碑）。
    const atomsBySeq = new Map<number, Atom>(atoms.map(a => [a.seq, a]))
    const intervals: { seqs: number[]; chars: number; atoms: Atom[] }[] = []
    const tombstones: ({ type: 'user'; text: string } | { type: 'tool'; seq: number; callId: string; text?: string })[] = []
    const spanAtoms = plan.spanSeqs.map(s => atomsBySeq.get(s)).filter((a): a is Atom => a !== undefined)
    const spanChars = plan.spanSeqs.reduce((sum, s) => sum + (atomsBySeq.get(s)?.text.length ?? 0), 0)
    intervals.push({ seqs: [...plan.spanSeqs], chars: spanChars, atoms: spanAtoms })
    tombstones.push({ type: 'user', text: proseCheckpointText(summary) })
    if (intervals.length === 0) return null
    this.host.log.info('[argp-factor-prose] 浓缩 ' + plan.spanSeqs.length + ' 整轮节点（' + spanChars
      + ' chars）→ 单检查点；散点 ' + plan.partialSeqs.length + ' 个原样保留（无指针）；stop=' + plan.stopReason)
    return pruneIntervals(this.host, session, intervals, 0, intervals.length, false, tombstones, 'factor-prose')
  }

  /** 焦点轮数活读：宿主侧旋钮与 FactorEngine 同源（引擎构造期传 getter 到本类）。 */
  focalTurnsOf(): number {
    return this.cfg.focalTurns()
  }

  /** 散文占比统计（触发线日志/遥测复用；不读 LLM）。 */
  proseStats(session: Session): { sysChars: number; proseCharsAll: number } {
    const events = sessionEvents(session) as unknown as Array<{ seq: number; type: string }>
    const surfaceSeqs = [...session.surface.nodes] as unknown as number[]
    let sysChars = 0
    const headSeq = surfaceSeqs[0]
    const headEvent = headSeq !== undefined ? events[headSeq] : undefined
    if (headEvent !== undefined && headEvent.type === 'system/message') sysChars = eventText(session, headSeq as number).length
    const probes = this.buildProbes(session)
    let proseCharsAll = 0
    for (const a of this.host.atomize(session)) {
      const probe = probes.get(a.seq) ?? { attachment: false }
      if (classifyUaAtom(a, probe) === 'textA') proseCharsAll += a.text.length
    }
    return { sysChars, proseCharsAll }
  }

  private buildProbes(session: Session): Map<number, ProseEventProbe> {
    const events = sessionEvents(session) as unknown as Array<{ seq: number; data?: Record<string, unknown> }>
    const probes = new Map<number, ProseEventProbe>()
    for (const seq of session.surface.nodes as unknown as number[]) {
      const data = events[seq]?.data
      if (data === undefined) continue
      const src = (data['source'] ?? (data['message'] as { source?: unknown } | undefined)?.source) as { form?: string } | undefined
      // 附件判据与 factor 硬保护同源：递归 tool-result 嵌套 content（顶层扫会漏掉
      // R 里的 image/file，浓缩时附件被摘要吞掉）。
      const attachment = hasAttachmentBlocks(data)
      probes.set(seq, { form: typeof src?.form === 'string' ? src.form : undefined, attachment })
    }
    return probes
  }

  /** open turn 首节点 seq（detectOpenTurn 的位置版：日志尾向前找最近 turn/start）。 */
  private openTurnFirstSeq(session: Session): number | null {
    const events = sessionEvents(session) as unknown as Array<{ seq: number; type: string; data?: Record<string, unknown> }>
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const e = events[i]
      if (e === undefined) continue
      if (e.type === 'turn/start') {
        // turn/start 是 off-surface 事件：其 turn 号的首个 surface 节点 = 该 turn 号首个原子。
        const turn = typeof (e.data as { turn?: unknown } | undefined)?.turn === 'number'
          ? (e.data as { turn: number }).turn : null
        if (turn === null) return null
        for (const a of this.host.atomize(session)) {
          if (a.turn === turn) return a.seq
        }
        return null
      }
      if (e.type === 'turn/end') return null
    }
    return null
  }

  /**
   * 配对闭包预检（审查 P0-2）：span 内每个 tool-call A 的全部 R 必须也在 span；
   * span 内每个有 issuer 的 R 的 issuer A 必须也在 span。孤儿 R（无 issuer）可随 span 走。
   */
  private spanPairingBalanced(atoms: readonly Atom[], span: ReadonlySet<number>): { ok: boolean; reason?: string } {
    const aByCall = new Map<string, Atom[]>()
    const rByCall = new Map<string, Atom[]>()
    for (const a of atoms) {
      if (a.type === 'A') {
        for (const cid of a.toolCallIds) {
          const list = aByCall.get(cid)
          if (list === undefined) aByCall.set(cid, [a])
          else list.push(a)
        }
      } else if (a.type === 'R' && a.toolCallIds[0] !== undefined) {
        const list = rByCall.get(a.toolCallIds[0] as string)
        if (list === undefined) rByCall.set(a.toolCallIds[0] as string, [a])
        else list.push(a)
      }
    }
    for (const a of atoms) {
      if (!span.has(a.seq)) continue
      if (a.type === 'A') {
        for (const cid of a.toolCallIds) {
          const rs = rByCall.get(cid) ?? []
          if (rs.some(r => !span.has(r.seq))) {
            return { ok: false, reason: 'A seq=' + a.seq + ' call=' + cid + ' 的 R 在 span 外' }
          }
        }
      } else if (a.type === 'R' && a.toolCallIds[0] !== undefined) {
        const as = aByCall.get(a.toolCallIds[0] as string) ?? []
        if (as.length > 0 && as.some(x => !span.has(x.seq))) {
          return { ok: false, reason: 'R seq=' + a.seq + ' 的 issuer A 在 span 外' }
        }
      }
    }
    return { ok: true }
  }

  /**
   * 驱逐 span → **散文** replay messages（2026-11-13 用户裁定：散文 = U + 无 R 的 final A）。
   * 只回放 classifyUaAtom === 'textA' 的原子；toolCallA（K）与 rPair 属 factor 协议组，
   * 不进摘要输入；excluded/barrier 同样跳过。标记 U:/A: 与指令首行一致。
   * 这是对 §9.36 "全栈 U/A+CALL/RESULT 输入" 的用户裁定反转：工具原子不再喂给摘要，
   * 由 factor 组剪（压缩检查点占位）回收，原文经 recall_history(labels) 召回。
   */
  private buildProseMessages(
    atoms: readonly Atom[],
    probes: ReadonlyMap<number, ProseEventProbe>,
    surfaceSeqs: readonly number[],
    evicted: Set<number>,
  ): Message[] {
    const atomBySeq = new Map<number, Atom>(atoms.map(a => [a.seq, a]))
    const messages: Message[] = []
    for (const seq of surfaceSeqs) {
      if (!evicted.has(seq)) continue
      const atom = atomBySeq.get(seq)
      if (atom === undefined || atom.text.length === 0) continue
      // 旧 [散文压缩] 检查点若被 span 吞并：把它的摘要文本作为 U 散文入面（滚动合并），
      // 不能静默丢掉（审查 P1-7）。
      if (atom.type === 'X') {
        if (atom.text.trimStart().startsWith(PROSE_CHECKPOINT_PREFIX)) {
          messages.push(createUserMessage({ content: [{ type: 'text', text: 'U: ' + atom.text }], source: { kind: 'user' } }))
        }
        continue
      }
      const probe = probes.get(seq) ?? { attachment: false }
      if (classifyUaAtom(atom, probe) !== 'textA') continue
      if (atom.type === 'U') {
        messages.push(createUserMessage({ content: [{ type: 'text', text: 'U: ' + atom.text }], source: { kind: 'user' } }))
      } else if (atom.type === 'A') {
        messages.push(createAssistantMessage({
          source: { provider: 'argp-prose', model: 'condense-replay' },
          content: [{ type: 'text', text: 'A: ' + atom.text }],
        }))
      }
    }
    return messages
  }

  private async callLlm(spec: { provider: string; model: string }, spanMessages: Message[], signal?: AbortSignal, declaredWindow = 0): Promise<string> {
    if (this.cfg.complete !== undefined) {
      // 测试注入形：span 栈平铺进 prompt（形状同构：前缀 replay + 尾部指令）。
      // 行内标记（U:/A:）已在 buildProseMessages 写入文本，此处不再叠角色前缀。
      const flat = spanMessages.map(m => {
        const blocks = (m as unknown as { content?: ReadonlyArray<{ type?: string; text?: string }> }).content ?? []
        return blocks.map(b => typeof b.text === 'string' ? b.text : '').join('')
      }).join('\n')
      return await this.cfg.complete(spec, flat + '\n\n' + PROSE_COMPACTION_INSTRUCTION, this.cfg.llmTimeoutMs)
    }
    return (await completeViaDshLlm(this.ctx, spec, PROSE_COMPACTION_INSTRUCTION, this.cfg.llmTimeoutMs,
      spanMessages, undefined, signal, summaryMaxTokensOut(declaredWindow))).text
  }

  /** spec 解析（compressor 优先序 auto 档口径）：路由齐 + 宿主 llm 服务在位，缺一即 disabled。 */
  private resolveSpec(route: AgentRouteHint): { provider: string; model: string } | null {
    if (this.cfg.complete !== undefined) {
      const provider = route.provider
      const model = route.model
      return provider !== undefined && provider !== '' && model !== undefined && model !== ''
        ? { provider, model } : null
    }
    return autoDshLlmSpec(this.ctx, route)
  }
}

/**
 * 浓缩输出预算（§9.36 H5 终裁）：min(20480, 0.2×声明窗 − 指令预留)——
 * 262K 声明窗下=20480（预留 52,429 tok 内）；小声明窗（如联调 32K 形：0.2×=6.5K）
 * 自动收缩，摘要调用自己永远装得下窗。declaredWindow ≤0（声明未知）⇒ 常数上限
 * （调用点已保证声明未知不进入浓缩路径，此处纯防御）。
 */
export function summaryMaxTokensOut(declaredWindow: number): number {
  if (declaredWindow <= 0) return PROSE_SUMMARY_MAX_TOKENS
  return Math.max(1024, Math.min(PROSE_SUMMARY_MAX_TOKENS, Math.floor(declaredWindow * 0.2) - PROSE_INSTRUCTION_TOKEN_RESERVE))
}

// 2026-11-13 用户裁定：散文侧不再产生部分散点的 seq 指针墓碑（召回走标签，不走指针）；
// partial 散点原样保留。原 seqRangePointer 已删除，防止文案回潮。
