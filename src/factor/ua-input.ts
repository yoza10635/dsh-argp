/**
 * 因子臂原子**输入分类纯函数**（design-2.0 §2.4 输入层；现消费者 = prose-condenser
 * 散文浓缩链——本文件零 LLM、零事件读取，事件形态经 probe 回调注入）。
 *
 * 分类器四类（+rPair 随行料）：`textA | toolCallA（含配对 R）| excluded
 * （relay/notice、X、已浓缩副本）| barrier（附件）`——relay/notice 与 U-info 聚合
 * 副本都是**已浓缩产物**（DEFAULT_SKIP_CONTEXT_FORMS 教训），二次浓缩禁入。
 */
import type { Atom } from '../argp-types.ts'

export type SummaryInputClass = 'textA' | 'toolCallA' | 'rPair' | 'excluded' | 'barrier'

/** 事件读侧探针（atom 上无 source.form / 附件块——编排侧从日志投影后喂进来）。 */
export interface UaEventProbe {
  /** source.form（relay/notice ⇒ excluded）。 */
  form?: string
  /** 内容含 image/file 块 ⇒ barrier（浓缩不吃附件，且切断段）。 */
  attachment: boolean
}

/** 已浓缩形态（二次浓缩禁令；与 constants.DEFAULT_SKIP_CONTEXT_FORMS 同名单）。 */
export const SKIP_SUMMARY_FORMS: readonly string[] = ['relay', 'notice']

export function classifyUaAtom(atom: Atom, probe: UaEventProbe): SummaryInputClass {
  if (atom.type === 'X') return 'excluded'
  // 已浓缩的 U-info 聚合副本（sourceSeq 即识别判据）：禁二次浓缩。
  if (atom.type === 'U' && atom.sourceSeq !== undefined) return 'excluded'
  if (probe.attachment) return 'barrier'
  if (atom.type === 'U') {
    if (probe.form !== undefined && SKIP_SUMMARY_FORMS.includes(probe.form)) return 'excluded'
    return 'textA'
  }
  if (atom.type === 'A') return atom.toolCallIds.length > 0 ? 'toolCallA' : 'textA'
  return 'rPair'
}
