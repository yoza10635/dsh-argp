/**
 * 因子臂 U/A 批次摘要的**输入层纯函数**（design-2.0 §2.4；LLM 调用与发射在
 * ua-summarizer.ts——本文件零 LLM、零事件读取，事件形态经 probe 回调注入）。
 *
 * 纪律：
 *  - 分类器四类（+rPair 随行料）：`textA | toolCallA（含配对 R）| excluded
 *    （relay/notice、X、已浓缩副本）| barrier（附件）`——relay/notice 与 U-info 聚合
 *    副本都是**已浓缩产物**（DEFAULT_SKIP_CONTEXT_FORMS 教训），二次摘要禁入；
 *  - span 是**连续 surface 切片**（prune-tx replace 的硬前提）：excluded/barrier/
 *    孤儿 R/不可参摘原子一律切段（它们绝不能被摘要副本吞掉）；协议组不劈——
 *    段尾未闭合的 toolCallA 弹出（连同其后内容弃入下批重规划）；
 *  - 约束带逐字：命中约束词法的 **U 句**取原文子串进带，不参与生成；
 *    高召回词法，误报代价 = 多几行逐字文本；
 *  - 未闭合轮与焦点轮不入池：本轮协议现场/任务活体，语义同 R 剪的硬保护位。
 */
import type { Atom } from '../argp-types.ts'

export type SummaryInputClass = 'textA' | 'toolCallA' | 'rPair' | 'excluded' | 'barrier'

/** 事件读侧探针（atom 上无 source.form / 附件块——编排侧从日志投影后喂进来）。 */
export interface UaEventProbe {
  /** source.form（relay/notice ⇒ excluded）。 */
  form?: string
  /** 内容含 image/file 块 ⇒ barrier（摘要不吃附件，且切断段）。 */
  attachment: boolean
}

/** 已浓缩形态（二次摘要禁令；与 constants.DEFAULT_SKIP_CONTEXT_FORMS 同名单）。 */
export const SKIP_SUMMARY_FORMS: readonly string[] = ['relay', 'notice']

export function classifyUaAtom(atom: Atom, probe: UaEventProbe): SummaryInputClass {
  if (atom.type === 'X') return 'excluded'
  // 已浓缩的 U-info 聚合副本（sourceSeq 即识别判据）：禁二次摘要。
  if (atom.type === 'U' && atom.sourceSeq !== undefined) return 'excluded'
  if (probe.attachment) return 'barrier'
  if (atom.type === 'U') {
    if (probe.form !== undefined && SKIP_SUMMARY_FORMS.includes(probe.form)) return 'excluded'
    return 'textA'
  }
  if (atom.type === 'A') return atom.toolCallIds.length > 0 ? 'toolCallA' : 'textA'
  return 'rPair'
}

// ---------------------------------------------------------------------------
// 约束带词法（高召回；误报=多几行逐字文本，方向安全）
// ---------------------------------------------------------------------------

/** 约束词法（§2.4 名单 + 同族扩展）：命中即整句逐字进约束带。 */
export const CONSTRAINT_LEXICON_RE = /(只|仅|绝|禁|勿|别|不要|必须|不得|统一|红线|一律|严禁|不许|不准|务必)/

const SENTENCE_SPLIT_RE = /[^。！？!?\n]+[。！？!?\n]?/g

/**
 * 逐字约束句：按句末标点/换行切句，返回**原文子串**（不改写；trim 只切两端空白）。
 */
export function constraintLinesOf(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(SENTENCE_SPLIT_RE)) {
    const s = (m[0] ?? '').trim()
    if (s !== '' && CONSTRAINT_LEXICON_RE.test(s)) out.push(s)
  }
  return out
}

// ---------------------------------------------------------------------------
// 分段规划
// ---------------------------------------------------------------------------

export interface UaSpan {
  /** 连续 surface seq（含 rPair——replace 范围逐节点覆盖）。 */
  seqs: number[]
  atoms: Atom[]
  /** 段内 U+A 字符量（阈值池口径；R 是配对随行料不计池）。 */
  poolChars: number
  /** 段内全量字符（发射记账）。 */
  allChars: number
  firstTurn: number
  lastTurn: number
  /** 段内 U 原子的约束句（逐字，出现序）。 */
  constraintLines: string[]
}

export interface UaPlanResult {
  /** 由旧到新。 */
  spans: UaSpan[]
  poolChars: number
  /** 规划时日志尾（发射只覆盖 seq < watermark；异步期新事件天然入下批）。 */
  watermark: number
  /** 全部段约束句合并（去重保序）。 */
  constraintLines: string[]
}

export interface UaPlanOptions {
  probe: (seq: number) => UaEventProbe
  /** detectOpenTurn：本轮协议现场不参摘（遇该 turn 原子切段）。 */
  openTurn: number | null
  /** turn >= 此值不参摘（焦点轮活体；null = 不护）。 */
  protectFromTurn: number | null
  /** 规划时刻日志尾（调用方传 session.seq）。 */
  watermark: number
}

export function planUaSpans(atoms: readonly Atom[], opts: UaPlanOptions): UaPlanResult {
  const spans: UaSpan[] = []
  let run: Atom[] = []
  /** 段内未闭合协议组：callId → 其 issuer A 在 run 中的下标。 */
  let pending = new Map<string, number>()

  const closeRun = (): void => {
    // 协议组不劈：段尾仍有未应答的 toolCallA ⇒ 从最早那个 A 起弹出（弃入下批）。
    let cut = run.length
    for (const idx of pending.values()) cut = Math.min(cut, idx)
    const kept = run.slice(0, cut)
    run = []
    pending = new Map()
    if (kept.length === 0) return
    const seqs = kept.map(a => a.seq)
    // 连续性自检（replace 区间必须逐格连续；断档 = 数据异常，宁弃不发非法区间）。
    for (let i = 1; i < seqs.length; i += 1) {
      if ((seqs[i] as number) !== (seqs[i - 1] as number) + 1) return
    }
    const constraintLines: string[] = []
    for (const a of kept) {
      if (a.type === 'U') constraintLines.push(...constraintLinesOf(a.text))
    }
    spans.push({
      seqs,
      atoms: kept,
      poolChars: kept.reduce((n, a) => n + (a.type === 'R' ? 0 : a.text.length), 0),
      allChars: kept.reduce((n, a) => n + a.text.length, 0),
      firstTurn: (kept[0] as Atom).turn,
      lastTurn: (kept[kept.length - 1] as Atom).turn,
      constraintLines,
    })
  }

  for (const a of atoms) {
    const ineligible = (opts.openTurn !== null && a.turn >= opts.openTurn)
      || (opts.protectFromTurn !== null && a.turn >= opts.protectFromTurn)
    if (ineligible) { closeRun(); continue }
    const cls = classifyUaAtom(a, opts.probe(a.seq))
    if (cls === 'excluded' || cls === 'barrier') { closeRun(); continue }
    if (cls === 'rPair') {
      const callId = a.toolCallIds[0]
      if (callId !== undefined && pending.has(callId)) {
        pending.delete(callId)
        run.push(a)
        continue
      }
      // 孤儿 R（issuer A 不在本段）：切段，不吃它。
      closeRun()
      continue
    }
    if (cls === 'toolCallA') {
      run.push(a)
      const idx = run.length - 1
      for (const id of a.toolCallIds) pending.set(id, idx)
      continue
    }
    run.push(a)
  }
  closeRun()

  const merged = new Set<string>()
  for (const s of spans) for (const l of s.constraintLines) merged.add(l)
  return {
    spans,
    poolChars: spans.reduce((n, s) => n + s.poolChars, 0),
    watermark: opts.watermark,
    constraintLines: [...merged],
  }
}
