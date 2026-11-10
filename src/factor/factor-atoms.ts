/**
 * 事件流 → 因子决策原料（design-2.0 §3.1 接线层；引擎侧唯一碰事件形态的地方）。
 *
 * 形态纪律（spike/43 + spike/48 真实归档实核，P0 坑账全部内化）：
 *  - issuer 关联 = **callId**（tool/call 事件 `{callId,name,arguments}` ×
 *    tool/result `data.message.content[0].toolCallId`），不是 seq±1；
 *  - R 文本在 `tool-result` 块的**嵌套 content 递归**——只取顶层 text 会全空；
 *  - 剪枝 replace 链会产生同 callId 的 tool/result 副本——本层**不去重**，
 *    去重是 FactorLedger 的 rootSeq 职责（职责分层）；
 *  - isError 双形态：V4 `message.isError` 顶层 / V3 tool-result 块内。
 */
import { extractTags } from './tag-extract.ts'
import { indexKeys } from './factor-ledger.ts'
import type { RTags } from './types.ts'

/** 事件形状的最小结构型（SessionEvent 的读侧投影，避免 import 宿主类型传染）。 */
export interface EventLike {
  seq: number
  type: string
  data?: Record<string, unknown>
}

/** Atom 的读侧投影（argp-types.Atom 的字段子集）。 */
export interface AtomLike {
  seq: number
  type: 'U' | 'A' | 'R' | 'X'
  turn: number
  text: string
  toolCallIds: string[]
}

export interface CallInfo {
  name: string
  args: unknown
  seq: number
}

/** tool/call 事件 + A 事件内嵌 tool-call 块 双形态索引（先到者胜）。 */
export function indexCalls(events: readonly EventLike[]): Map<string, CallInfo> {
  const byId = new Map<string, CallInfo>()
  for (const e of events) {
    if (e.type === 'tool/call') {
      const d = e.data ?? {}
      const callId = typeof d['callId'] === 'string' ? (d['callId'] as string) : undefined
      if (callId !== undefined && !byId.has(callId)) {
        byId.set(callId, { name: String(d['name'] ?? ''), args: d['arguments'], seq: e.seq })
      }
      continue
    }
    if (e.type !== 'assistant/message') continue
    const content = (e.data as { message?: { content?: unknown } } | undefined)?.message?.content
    if (!Array.isArray(content)) continue
    for (const b of content as Array<Record<string, unknown>>) {
      if (b['type'] !== 'tool-call' || typeof b['id'] !== 'string') continue
      if (!byId.has(b['id'])) byId.set(b['id'], { name: String(b['name'] ?? ''), args: b['arguments'], seq: e.seq })
    }
  }
  return byId
}

/**
 * R 事件文本投影：text 块 + tool-result 嵌套 content 递归（spike48 首轮病灶锁）。
 * capChars 只影响 errorish 文本信号与 sizeChars 的口径（大输出照样被 size 键排前）。
 */
export function resultTextOf(e: EventLike, capChars = 32_768): string {
  const msg = (e.data ?? {})['message'] as { content?: unknown } | undefined
  const parts: string[] = []
  let n = 0
  const grab = (blocks: unknown): void => {
    if (!Array.isArray(blocks)) return
    for (const b of blocks) {
      if (n >= capChars) return
      if (b === null || typeof b !== 'object') continue
      const bb = b as { type?: string; text?: string; content?: unknown }
      if (bb.type === 'text' && typeof bb.text === 'string') {
        parts.push(bb.text)
        n += bb.text.length
      } else if (bb.type === 'tool-result') {
        grab(bb.content)
      }
    }
  }
  grab(msg?.content)
  return parts.join('\n')
}

/** isError 双形态（V4 message 顶层 / V3 tool-result 块内），取 OR。 */
export function isErrorOf(e: EventLike): boolean {
  const msg = (e.data as { message?: { isError?: unknown; content?: unknown } } | undefined)?.message
  if (msg?.isError === true) return true
  const blocks = msg?.content
  if (Array.isArray(blocks)) {
    for (const b of blocks as Array<Record<string, unknown>>) {
      if (b['type'] === 'tool-result' && b['isError'] === true) return true
    }
  }
  return false
}

/** session 头事件的 cwd（事件时环境；缺 undefined——绝不拿当前 cwd 凑）。 */
export function sessionCwdFromEvents(events: readonly EventLike[]): string | undefined {
  for (const h of events) {
    const cwd = h.data?.['cwd']
    if (h.type === 'session' && typeof cwd === 'string') return cwd
  }
  return undefined
}

export interface RTagInput {
  seq: number
  turn: number
  callId: string | undefined
  tool: string
  resultText: string
  tags: RTags
}

/**
 * 对全部 R 原子贴标（seq → 输入+结果）。issuer 缺失（悬挂/损坏事件）不丢弃：
 * tool=''/args=null 走文本兜底通道，贴不出的标签由覆盖率口径如实登记。
 */
export function tagRs(
  events: readonly EventLike[],
  atoms: readonly AtomLike[],
  sessionCwd: string | undefined,
): Map<number, RTagInput> {
  const bySeq = new Map<number, EventLike>()
  for (const e of events) if (!bySeq.has(e.seq)) bySeq.set(e.seq, e)
  const calls = indexCalls(events)
  const out = new Map<number, RTagInput>()
  for (const a of atoms) {
    if (a.type !== 'R') continue
    const ev = bySeq.get(a.seq)
    if (ev === undefined) continue
    const callId = a.toolCallIds[0]
    const call = callId !== undefined ? calls.get(callId) : undefined
    const resultText = resultTextOf(ev)
    const isError = isErrorOf(ev)
    const tags = extractTags({
      tool: call?.name ?? '',
      rawArgs: call?.args,
      resultText,
      sessionCwd,
      isError,
    })
    out.set(a.seq, { seq: a.seq, turn: a.turn, callId, tool: call?.name ?? '', resultText, tags })
  }
  return out
}

/**
 * 焦点标签集（§2.5 定稿措辞）：最近 focalTurns 轮**存活 U/A** 文本命中的 canonical
 * 标签（extractTags 文本兜底通道，同 canonical 单点）——**不是**"最近轮全部原子"。
 * U/A 是 cue 链载体，A 恒留正是前提；R 的键要成为焦点须经 U/A 叙事引用。
 */
export function focalLabels(
  atoms: readonly AtomLike[],
  latestTurn: number,
  focalTurns: number,
  sessionCwd: string | undefined,
): Set<string> {
  const out = new Set<string>()
  for (const a of atoms) {
    if (a.turn <= latestTurn - focalTurns) continue
    if (a.type !== 'U' && a.type !== 'A') continue
    const t = extractTags({ tool: '', rawArgs: null, resultText: a.text, sessionCwd })
    for (const key of indexKeys(t)) out.add(key)
  }
  return out
}

// ---------------------------------------------------------------------------
// staleness 覆盖证明（释放向：覆盖须**证明**，部分读永不覆盖全量读）
// ---------------------------------------------------------------------------

const INF = Number.POSITIVE_INFINITY

function rangeOf(r: RTags['readRange']): [number, number] {
  if (r === null) return [0, INF] // 全量读
  const start = r.offset ?? 0
  return [start, r.limit === null || r.limit === undefined ? INF : start + r.limit]
}

/** old ⊆ new（同为对该文件的成功 read；new 更新）。 */
export function rangeCovered(old: RTags['readRange'], next: RTags['readRange']): boolean {
  const [a0, a1] = rangeOf(old)
  const [b0, b1] = rangeOf(next)
  return b0 <= a0 && a1 <= b1
}

/**
 * seq → 是否被后续同文件成功读覆盖。只看 READ 类成功 R；错误读不作覆盖证据。
 * P1-d 保守：issuer 工具名缺失（''）不认 read 类（与 retention-score 的族下限同口径）。
 */
export function supersededMarks(tagsBySeq: ReadonlyMap<number, RTagInput>): Map<number, boolean> {
  const reads = [...tagsBySeq.values()]
    .filter(x => x.tool === 'read' || x.tool === 'view')
    .sort((a, b) => a.seq - b.seq)
  const out = new Map<number, boolean>()
  for (const old of reads) {
    let covered = false
    for (const next of reads) {
      if (next.seq <= old.seq || next.tags.errorish) continue
      if (old.tags.files.some(f => next.tags.files.includes(f)) && rangeCovered(old.tags.readRange, next.tags.readRange)) {
        covered = true
        break
      }
    }
    if (covered) out.set(old.seq, true)
  }
  return out
}
