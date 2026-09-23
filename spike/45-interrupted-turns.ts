/**
 * spike 45：手动中断轮 × peratom 审计（2026-09-23）。
 *
 * 问题：用户观察到「手动中断的 turn 不触发 peratom」。本脚本回答三个问题：
 *  1. 中断轮在事件流里的**实际签名**是什么（turn/end.reason.kind / reason.reason.kind /
 *     assistant/message.interrupted），手动（user）与 parent/hook/disposed/legacy 各占多少；
 *  2. 中断轮里**残留多少可压材料**（peratom 口径：U 长消息 > splitThreshold、R ≥ 512 字符）——
 *     设计把整轮排除（filterInterruptedAtoms），这些材料是否其实是**完整**的（工具已执行完、
 *     结果已落盘），即"残留"论断对 peratom 是否成立；
 *  3. 量化：全语料中断轮总数、含可压材料的轮数、被放过的字符量（对照触发线 100K 的占比）。
 *
 * 口径与 src/peratom/gate.ts 完全一致（collectInterruptedTurns 的两种形态 + reason 细分），
 * 但本脚本是**离线只读**的：不 import 运行时，直接读原始事件，避免 Session 实例依赖。
 *
 * ⚠️ 隐私铁律：只读 ~/.dsh/sessions，只输出聚合量与结构签名，不输出会话原文。
 *
 * 用法：
 *   node --import ./scripts/ts-import-rewrite-loader.mjs spike/45-interrupted-turns.ts [--min-r-chars=512] [--split-chars=2000]
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { loadRealCorpus, defaultSessionRoot, loadSessionEvents } from './lib/session-corpus.ts'
import type { RawSessionEvent } from './lib/session-corpus.ts'

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------
const args = process.argv.slice(2)
const argOf = (name: string, dflt: number): number => {
  const hit = args.find(a => a.startsWith(`--${name}=`))
  return hit !== undefined ? Number(hit.split('=')[1]) : dflt
}
const MIN_R_CHARS = argOf('min-r-chars', 512)      // peratom 小结果阈值（DEFAULT_SMALL_RESULT_CHARS）
const SPLIT_CHARS = argOf('split-chars', 2000)     // user 长消息拆分阈值（生产 splitThresholdChars 口径）

// ---------------------------------------------------------------------------
// 中断签名识别（与 gate.ts collectInterruptedTurns 同口径 + reason 细分）
// ---------------------------------------------------------------------------
const INTERRUPTED_END_REASONS = new Set(['aborted', 'error', 'interrupted'])

interface TurnEndInfo {
  seq: number
  turn: number
  kind: string            // reason.kind
  cause: string           // reason.reason.kind（aborted 才有）/ '—'
  interruptedFlag: boolean // data.interrupted 直挂
}

interface AssistantInterrupt {
  seq: number
  turn: number
  step: number
  chars: number
}

/** 从事件流提取：每个 turn 的 turn/end 签名 + 每个 interrupted assistant 前缀。 */
function scanEvents(events: readonly RawSessionEvent[]): {
  turnEnds: Map<number, TurnEndInfo>
  assistantInterrupts: Map<number, AssistantInterrupt[]>
} {
  const turnEnds = new Map<number, TurnEndInfo>()
  const assistantInterrupts = new Map<number, AssistantInterrupt[]>()
  for (const ev of events) {
    if (ev.type === 'turn/end') {
      const d = ev.data as { turn?: number; interrupted?: unknown; reason?: { kind?: string; reason?: { kind?: string } } }
      const turn = d.turn ?? -1
      const kind = d.reason?.kind ?? '—'
      const cause = d.reason?.reason?.kind ?? '—'
      if (INTERRUPTED_END_REASONS.has(kind) || d.interrupted === true) {
        turnEnds.set(turn, { seq: ev.seq, turn, kind, cause, interruptedFlag: d.interrupted === true })
      }
      continue
    }
    if (ev.type === 'assistant/message' && (ev.data as { interrupted?: unknown }).interrupted === true) {
      const d = ev.data as { turn?: number; step?: number; message?: { content?: unknown[] } }
      const turn = d.turn ?? -1
      let chars = 0
      const content = d.message?.content
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b !== null && typeof b === 'object') {
            const bb = b as { type?: string; text?: string }
            if (bb.type === 'text' && typeof bb.text === 'string') chars += bb.text.length
          }
        }
      }
      const list = assistantInterrupts.get(turn) ?? []
      list.push({ seq: ev.seq, turn, step: d.step ?? -1, chars })
      assistantInterrupts.set(turn, list)
    }
  }
  return { turnEnds, assistantInterrupts }
}

// ---------------------------------------------------------------------------
// 中断轮内的可压材料（peratom 口径）
// ---------------------------------------------------------------------------
interface AtomStat {
  seq: number
  type: 'U' | 'R'
  chars: number
  compressible: boolean
  /** R：工具结果是否"完整交付"（原始 append 且非合成中断结果）。 */
  isOriginalAppend: boolean
  /** R：文本是否命中合成中断结果的特征串（repair 模块口径）。 */
  looksSynthetic: boolean
}

function textOf(ev: RawSessionEvent): string {
  const d = ev.data as { content?: unknown; message?: { content?: unknown } }
  const blocks = ev.type === 'user/message' ? d.content : d.message?.content
  if (!Array.isArray(blocks)) return ''
  const out: string[] = []
  for (const b of blocks) {
    if (b === null || typeof b !== 'object') continue
    const bb = b as { type?: string; text?: string; content?: unknown }
    if (bb.type === 'text' && typeof bb.text === 'string') out.push(bb.text)
    else if (bb.type === 'tool-result' && Array.isArray(bb.content)) {
      for (const c of bb.content) {
        if (c !== null && typeof c === 'object' && (c as { type?: string }).type === 'text') {
          out.push((c as { text?: string }).text ?? '')
        }
      }
    }
  }
  return out.join('')
}

function isOriginalAppend(ev: RawSessionEvent): boolean {
  const so = ev.surfaceOp
  if (so === 'append') return true
  if (so !== null && typeof so === 'object') return (so as { op?: string }).op === 'append'
  return false
}

const SYNTHETIC_MARKERS = [
  'interrupted after it was recorded',
  'interrupted before the Harness recorded',
  'Its outcome is unknown',
]

/** 某 turn 区间（turn/start..turn/end）内的 U/R 原子统计。 */
function atomsInTurn(events: readonly RawSessionEvent[], turn: number): AtomStat[] {
  const out: AtomStat[] = []
  let inTurn = false
  for (const ev of events) {
    if (ev.type === 'turn/start') {
      inTurn = (ev.data as { turn?: number }).turn === turn
      continue
    }
    if (ev.type === 'turn/end') {
      if ((ev.data as { turn?: number }).turn === turn) inTurn = false
      continue
    }
    if (!inTurn) continue
    if (ev.type === 'user/message') {
      const text = textOf(ev)
      if (text.trim() === '') continue
      out.push({
        seq: ev.seq, type: 'U', chars: text.length,
        compressible: text.length > SPLIT_CHARS,
        isOriginalAppend: isOriginalAppend(ev), looksSynthetic: false,
      })
    } else if (ev.type === 'tool/result') {
      const text = textOf(ev)
      if (text.trim() === '') continue
      const looksSynthetic = SYNTHETIC_MARKERS.some(m => text.includes(m))
      out.push({
        seq: ev.seq, type: 'R', chars: text.length,
        compressible: text.length >= MIN_R_CHARS,
        isOriginalAppend: isOriginalAppend(ev), looksSynthetic,
      })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
const root = defaultSessionRoot()
if (!fs.existsSync(root)) {
  console.log(`[skip] 无 session 根目录 ${root}（CI 环境）`)
  process.exit(0)
}
const corpus = loadRealCorpus(root)
console.log(`语料：${corpus.length} 个 session，根=${root}`)
console.log(`口径：R ≥ ${MIN_R_CHARS} 字符可压；U > ${SPLIT_CHARS} 字符可拆\n`)

interface TurnReport {
  sessionId: string
  turn: number
  kind: string
  cause: string
  assistantInterrupted: boolean
  uTotal: number
  uCompressible: number
  rTotal: number
  rCompressible: number
  rCharsCompressible: number
  rSynthetic: number
  rOriginalCompressible: number
}

const reports: TurnReport[] = []
let totalTurns = 0
for (const s of corpus) {
  const { events } = loadSessionEvents(s.file)
  const { turnEnds, assistantInterrupts } = scanEvents(events)
  // 统计该 session 的总闭合轮数（分母）
  const closedTurns = new Set<number>()
  for (const ev of events) if (ev.type === 'turn/end') closedTurns.add((ev.data as { turn?: number }).turn ?? -1)
  totalTurns += closedTurns.size
  for (const [turn, info] of turnEnds) {
    const atoms = atomsInTurn(events, turn)
    const uTotal = atoms.filter(a => a.type === 'U').length
    const uCompressible = atoms.filter(a => a.type === 'U' && a.compressible).length
    const rAll = atoms.filter(a => a.type === 'R')
    const rCompressible = rAll.filter(a => a.compressible)
    const rOriginalCompressible = rAll.filter(a => a.compressible && a.isOriginalAppend && !a.looksSynthetic)
    const rSynthetic = rAll.filter(a => a.looksSynthetic).length
    reports.push({
      sessionId: s.id,
      turn,
      kind: info.kind,
      cause: info.cause,
      assistantInterrupted: (assistantInterrupts.get(turn)?.length ?? 0) > 0,
      uTotal,
      uCompressible,
      rTotal: rAll.length,
      rCompressible: rCompressible.length,
      rCharsCompressible: rOriginalCompressible.reduce((n, a) => n + a.chars, 0),
      rSynthetic,
      rOriginalCompressible: rOriginalCompressible.length,
    })
  }
}

// ---------------------------------------------------------------------------
// 汇总输出
// ---------------------------------------------------------------------------
console.log(`总闭合轮：${totalTurns}；中断轮：${reports.length}`)
if (reports.length === 0) {
  console.log('（语料中无中断轮——若你刚手动中断过，检查 session 是否已落盘 / 是否在本机根目录下）')
  process.exit(0)
}

// 按 reason.kind × cause 分桶
const byKindCause = new Map<string, number>()
for (const r of reports) {
  const key = `${r.kind} / ${r.cause}`
  byKindCause.set(key, (byKindCause.get(key) ?? 0) + 1)
}
console.log('\n中断签名分布（reason.kind / reason.reason.kind）：')
for (const [k, n] of [...byKindCause].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k}: ${n}`)
}

const withAssistant = reports.filter(r => r.assistantInterrupted).length
console.log(`\n带 interrupted assistant 前缀的轮：${withAssistant}/${reports.length}`)

// 可压材料统计
const withMaterial = reports.filter(r => r.uCompressible > 0 || r.rOriginalCompressible > 0)
console.log(`含 peratom 可压材料的轮：${withMaterial.length}/${reports.length}`)
const totalRChars = reports.reduce((n, r) => n + r.rCharsCompressible, 0)
const totalUCompressible = reports.reduce((n, r) => n + r.uCompressible, 0)
console.log(`被放过的 R 可压字符总量：${totalRChars}（≈ ${Math.round(totalRChars / 4)} tok，按 4 字符/tok 粗估）`)
console.log(`被放过的 U 长消息条数：${totalUCompressible}`)
console.log(`合成中断结果（repair 口径）条数：${reports.reduce((n, r) => n + r.rSynthetic, 0)}`)

// 逐轮明细（按可压字符降序，最多 15 条）
console.log('\n逐轮明细（按被放过的 R 可压字符降序，≤15 条）：')
const sorted = [...reports].sort((a, b) => b.rCharsCompressible - a.rCharsCompressible)
for (const r of sorted.slice(0, 15)) {
  console.log(
    `  ${r.sessionId.slice(0, 20)}… turn=${r.turn} ${r.kind}/${r.cause}` +
    ` A中断=${r.assistantInterrupted ? 'Y' : 'n'}` +
    ` | U=${r.uTotal}(可拆${r.uCompressible}) R=${r.rTotal}(可压${r.rCompressible}, 原始完整${r.rOriginalCompressible}, 合成${r.rSynthetic})` +
    ` | 放过R字符=${r.rCharsCompressible}`,
  )
}

// 关键判定：中断轮里"原始完整"的可压 R 占比
const origCompressible = reports.reduce((n, r) => n + r.rOriginalCompressible, 0)
const allCompressible = reports.reduce((n, r) => n + r.rCompressible, 0)
console.log(`\n判定：中断轮内可压 R 共 ${allCompressible} 条，其中原始完整（非合成）${origCompressible} 条` +
  `（${allCompressible > 0 ? Math.round(100 * origCompressible / allCompressible) : 0}%）`)
if (origCompressible > 0) {
  console.log('⇒ "该 turn 的原子全是残留" 对 peratom 不成立：完整交付的工具结果被整轮排除，永不压缩。')
} else {
  console.log('⇒ 中断轮内没有完整可压 R（要么无 R、要么全是合成/小结果）——整轮排除对 peratom 无损。')
}
