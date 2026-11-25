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

/** 事件读侧探针（atom 上无 source.form / source.kind / 附件块——编排侧从日志投影后喂进来）。 */
export interface UaEventProbe {
  /** source.form（relay/notice/宿主再注入形态 ⇒ excluded）。 */
  form?: string
  /** source.kind（宿主注入通道枚举：agent-instructions/runtime-context/skill-catalog）。 */
  kind?: string
  /** 内容含 image/file 块 ⇒ barrier（浓缩不吃附件，且切断段）。 */
  attachment: boolean
}

/** 已浓缩形态（二次浓缩禁令；与 constants.DEFAULT_SKIP_CONTEXT_FORMS 同名单）。 */
export const SKIP_SUMMARY_FORMS: readonly string[] = ['relay', 'notice']

/**
 * 宿主每请求**再注入**的上下文三件套（实机铁证 2026-11-25 三域影子对照：prose 域
 * 32K 会话 skill-catalog 注入 4 次 ×8.5KB——压缩驱逐后宿主立即重新注入）。驱逐它们
 * 释放的是**假量**（下一请求原样回来），喂进摘要 transcript 还白烧 LLM token。
 * 焦点域 30KB AGENTS.md 词汇表曾被计为可浓缩散文 10972 tok，把「不该摘」的 B-6
 * 场景误判成「摘」（影子对照抓出的口径 bug）。
 */
export const HOST_REINJECTED_FORMS: readonly string[] = ['instructions', 'snapshot', 'catalog']
export const HOST_REINJECTED_KINDS: readonly string[] = ['agent-instructions', 'runtime-context', 'skill-catalog']

/**
 * 宿主再注入三件套的归类模式（§B-2 接管的分期安全垫）：
 *  - 'prose'（**缺省=现网字节不变**）：按旧行为计 textA——condenser 会吞进摘要并
 *    驱逐旧副本；宿主每次压缩重注入一份，虽然烧 LLM token 但 surface 不累积。
 *  - 'exclude'：判 excluded——dispatch 散文度量用它（假量不再撑大判据②）。
 * 等 §B-2 的 0-LLM 结构去重驱逐落地后，缺省才翻到 exclude——否则旧副本永远
 * 留在 surface（排除=不再被驱逐 ∧ 宿主每压必重注入 ⇒ 重复累积，档案实锤）。
 */
export type HostReinjectedMode = 'prose' | 'exclude'

export function classifyUaAtom(
  atom: Atom,
  probe: UaEventProbe,
  hostReinjected: HostReinjectedMode = 'prose',
): SummaryInputClass {
  if (atom.type === 'X') return 'excluded'
  // 已浓缩的 U-info 聚合副本（sourceSeq 即识别判据）：禁二次浓缩。
  if (atom.type === 'U' && atom.sourceSeq !== undefined) return 'excluded'
  if (probe.attachment) return 'barrier'
  if (atom.type === 'U') {
    if (probe.form !== undefined && SKIP_SUMMARY_FORMS.includes(probe.form)) return 'excluded'
    if (hostReinjected === 'exclude') {
      // 宿主再注入三件套：form/kind 双通道命中皆排除（真 user 消息 kind='user'、
      // form=undefined，不受影响）。
      if (probe.form !== undefined && HOST_REINJECTED_FORMS.includes(probe.form)) return 'excluded'
      if (probe.kind !== undefined && HOST_REINJECTED_KINDS.includes(probe.kind)) return 'excluded'
    }
    return 'textA'
  }
  if (atom.type === 'A') return atom.toolCallIds.length > 0 ? 'toolCallA' : 'textA'
  return 'rPair'
}
