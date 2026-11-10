#!/usr/bin/env node
/**
 * spike 54 — 策略宽度账（design-2.0 §2.5 v1.1-v1.3 提案栈的 T-2 宽度验证；src 零改动，
 * 纯决策层模拟：在 base decide(∞) 的候选/剪序上施加各策略的"额外保护集"，同一
 * 预算前缀语义（spike50 cutAtBudget）看三张账）：
 *
 *  ① **宽度**：策略额外保护了多少枚/字节（相对软候选总量）——"留太多"侧；
 *  ② **挤占/缺口**：预算照旧要剪掉的字节里，策略保护的人被谁顶替（displaced=
 *     变体剪了而 base 留着的软原子），以及可剪总量不足预算的缺口档案数——代价落在谁头上；
 *  ③ **付费覆盖**：spike51 口径的付账信号原子（reReadLater ∨ errFileLater）在
 *     各预算下被保住的比例——"留太少"侧。
 *
 * 变体（全部会话内口径，不依赖全局码表）：
 *   docStrongAll    焦点 document ⇒ 含该因子的软原子**全枚**保护（用户裁定形态）；
 *   docStrong1      每焦点文档只留最新一枚（宽度回退方案）；
 *   errHardAll      每个 code×因子 签名留最新一枚 exemplar（**无** n≥2 门槛——展示
 *                   n=1=100% 陷阱的宽度）；
 *   errHard2        同签名计数≥2 才强留 exemplar（用户门槛）；
 *   errHard2+sup    再捆 superseded 失效（同因子成功后 exemplar 亦可剪）；
 *   cmdMedium       焦点 command 只挪排序（剪序末尾），不占 hard——宽度 0，只看挤占；
 *   combo           docStrong1 + errHard2+sup（推荐组合）。
 *
 * 隐私：stdout 只聚合量；明细 spike/out/。零 LLM。
 *
 * ```bash
 * npm run policy [-- --limit=8] [-- --budgets=8000,30000,100000]
 * ```
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { sessionEvents } from '../src/log-access.ts'
import { focalLabels, sessionCwdFromEvents, type AtomLike, type EventLike } from '../src/factor/factor-atoms.ts'
import { indexKeys } from '../src/factor/factor-ledger.ts'
import { loadSessionEvents } from './lib/session-corpus.ts'
import { collectArchives, defaultRoots, mountVariant, toPristineSession } from './lib/t2-replay-core.ts'

const argv = process.argv.slice(2)
function flagOf(name: string): string | undefined {
  const eq = argv.find(a => a.startsWith('--' + name + '='))
  if (eq !== undefined) return eq.slice(name.length + 3)
  const i = argv.indexOf('--' + name)
  return i >= 0 ? argv[i + 1] : undefined
}
const LIMIT = Number(flagOf('limit') ?? '0')
const MIN_TURNS = Number(flagOf('min-turns') ?? '4')
const BUDGETS = (flagOf('budgets') ?? '8000,30000,100000').split(',').map(Number)
const OUT_DIR = flagOf('out') ?? path.join('spike', 'out', 'policy')
const ROOTS = (flagOf('roots') ?? defaultRoots().join(path.delimiter)).split(path.delimiter).filter(r => r !== '')

const VARIANTS = ['docStrongAll', 'docStrong1', 'errHardAll', 'errHard2', 'errHard2sup', 'cmdMedium', 'combo'] as const

function cutPrefix(order: readonly number[], chars: ReadonlyMap<number, number>, target: number): Set<number> {
  const cut = new Set<number>()
  let acc = 0
  for (const seq of order) {
    cut.add(seq)
    acc += chars.get(seq) ?? 0
    if (acc >= target) break
  }
  return cut
}

interface VAgg {
  extraAtoms: number; extraChars: number
  displacedAtoms: number; displacedChars: number
  shortfallArchives: number; shortfallChars: number
  signalAtoms: number; signalKept: number
  /** 调试：保护集∩信号∩base 剪集（策略真救回的付账枚数）。 */
  extraSignal: number
}
const agg = new Map<string, Map<number, VAgg>>()
for (const v of VARIANTS) {
  const m = new Map<number, VAgg>()
  for (const b of BUDGETS) m.set(b, { extraAtoms: 0, extraChars: 0, displacedAtoms: 0, displacedChars: 0, shortfallArchives: 0, shortfallChars: 0, signalAtoms: 0, signalKept: 0, extraSignal: 0 })
  agg.set(v, m)
}
let archivesDone = 0
let totalSoftChars = 0

for (const arc of collectArchives(ROOTS)) {
  if (LIMIT > 0 && archivesDone >= LIMIT) break
  let events
  try { events = loadSessionEvents(arc.file).events } catch { continue }
  let turnEstimate = 0
  for (const e of events) {
    const t = (e.data as { turn?: number } | undefined)?.turn
    if (typeof t === 'number' && t > turnEstimate) turnEstimate = t
  }
  if (turnEstimate < MIN_TURNS) continue
  const { session } = toPristineSession(events, arc.slug)
  if (sessionEvents(session).length === 0) continue

  const mounted = await mountVariant({})
  mounted.bind(session)
  const atoms = mounted.atomize(session)
  const latestTurn = atoms.reduce((m, a) => Math.max(m, a.turn), 0)
  const decision = mounted.factor.decide(session, Number.MAX_SAFE_INTEGER)
  archivesDone++

  const eventsLike = sessionEvents(session) as unknown as EventLike[]
  const cwd = sessionCwdFromEvents(eventsLike)
  const focalSet = focalLabels(atoms as unknown as AtomLike[], latestTurn, 1, cwd)
  const focalDoc = new Set([...focalSet].filter(k => k.startsWith('document:')))
  const focalCmd = new Set([...focalSet].filter(k => k.startsWith('command:')))

  const hard = new Set(decision.plan.hardProtected)
  const soft = decision.candidates // 可剪集（含 sizeChars）
  const chars = new Map<number, number>()
  for (const [seq, c] of soft) chars.set(seq, c.tags.sizeChars)
  const pruneOrder = [...decision.plan.pruneOrder]
  for (const c of soft.values()) totalSoftChars += c.tags.sizeChars

  // 付账信号（spike51 处理盲口径，同集合内可比）：reReadLater ∨ errFileLater
  const allRs = [...decision.tagsBySeq.values()]
  const signal = new Set<number>()
  for (const [seq, c] of soft) {
    const files = c.tags.files
    const later = allRs.filter(x => x.seq > seq)
    const reRead = files.length > 0 && later.some(x => (x.tool === 'read' || x.tool === 'view') && x.tags.files.some(f => files.includes(f)))
    const errFile = files.length > 0 && later.some(x => x.tags.errorcodes.length > 0 && x.tags.files.some(f => files.includes(f)))
    if (reRead || errFile) signal.add(seq)
  }

  // 错误签名组（全体 R 计数——用户"只出现 1 次"=会话内实际发生数；exemplar=最新一枚）
  const groups = new Map<string, number[]>()
  const factorOf = (x: { tags: { files: string[]; commands: string[] } }, tool: string): string =>
    x.tags.files[0] !== undefined ? 'f:' + x.tags.files[0] : x.tags.commands[0] !== undefined ? 'c:' + x.tags.commands[0] : 't:' + tool
  for (const x of allRs) {
    const factor = factorOf(x, x.tool)
    for (const code of x.tags.errorcodes) {
      const g = groups.get(code + '|' + factor) ?? []
      g.push(x.seq)
      groups.set(code + '|' + factor, g)
    }
  }
  const exemplarOf = new Map<string, number>()
  for (const [sig, seqs] of groups) exemplarOf.set(sig, Math.max(...seqs))
  const superseded = (sig: string, exSeq: number): boolean => {
    const target = sig.split('|')[1]?.slice(2)
    if (target === undefined) return false
    return allRs.some(r => r.seq > exSeq && r.tags.errorcodes.length === 0
      && (r.tags.files.includes(target) || r.tags.commands.includes(target)))
  }

  const softSeqs = new Set(soft.keys())
  const inSoft = (s: Set<number>): Set<number> => new Set([...s].filter(x => softSeqs.has(x)))

  const keysOf = new Map<number, Set<string>>()
  for (const [seq, c] of soft) keysOf.set(seq, new Set(indexKeys(c.tags)))

  // —— 各变体的额外保护集（仅作用软候选；已在 hard 的不在软集，天然排除）——
  const prot = new Map<string, Set<number>>()
  const docAll = inSoft(new Set([...soft.keys()].filter(s => [...(keysOf.get(s) ?? [])].some(k => focalDoc.has(k)))))
  prot.set('docStrongAll', docAll)
  const docLatest = new Set<number>()
  for (const label of focalDoc) {
    let best = -1
    for (const [seq, c] of soft) if (indexKeys(c.tags).includes(label)) best = Math.max(best, seq)
    if (best >= 0) docLatest.add(best)
  }
  prot.set('docStrong1', docLatest)

  const errAll = new Set<number>()
  const err2 = new Set<number>()
  const err2sup = new Set<number>()
  for (const [sig, exSeq] of exemplarOf) {
    // 计数门槛看全组（含 hard 成员——"只出现 1 次"指会话内实际发生数）；
    // exemplar 已 hard 的组天然零成本（inSoft 过滤）。
    errAll.add(exSeq)
    if ((groups.get(sig) as number[]).length >= 2) {
      err2.add(exSeq)
      if (!superseded(sig, exSeq)) err2sup.add(exSeq)
    }
  }
  prot.set('errHardAll', inSoft(errAll))
  prot.set('errHard2', inSoft(err2))
  prot.set('errHard2sup', inSoft(err2sup))
  const cmdSet = inSoft(new Set([...soft.keys()].filter(s => [...(keysOf.get(s) ?? [])].some(k => focalCmd.has(k)))))
  prot.set('cmdMedium', new Set()) // 不占 hard——只改排序
  const combo = new Set([...docLatest, ...inSoft(err2sup)])
  for (const s of combo) if (!softSeqs.has(s)) combo.delete(s)
  prot.set('combo', combo)

  const baseCutByBudget = new Map<number, Set<number>>()
  for (const b of BUDGETS) baseCutByBudget.set(b, cutPrefix(pruneOrder, chars, b))

  for (const v of VARIANTS) {
    const add = prot.get(v) as Set<number>
    let order = pruneOrder.filter(s => !add.has(s))
    if (v === 'cmdMedium') order = [...pruneOrder.filter(s => !cmdSet.has(s)), ...pruneOrder.filter(s => cmdSet.has(s))]
    const prunableChars = order.reduce((s, q) => s + (chars.get(q) ?? 0), 0)
    for (const b of BUDGETS) {
      const a = (agg.get(v) as Map<number, VAgg>).get(b) as VAgg
      for (const s of add) { a.extraAtoms++; a.extraChars += chars.get(s) ?? 0 }
      const baseCut = baseCutByBudget.get(b) as Set<number>
      const varCut = cutPrefix(order, chars, b)
      if (prunableChars < b) {
        a.shortfallArchives++
        a.shortfallChars += b - prunableChars
      }
      for (const s of varCut) if (!baseCut.has(s)) { a.displacedAtoms++; a.displacedChars += chars.get(s) ?? 0 }
      for (const s of signal) {
        a.signalAtoms++
        const kept = !varCut.has(s) // 不在剪前缀 = 被保住（hard ∪ 保护 ∪ 尾部）
        if (kept) a.signalKept++
        if (add.has(s) && (baseCutByBudget.get(b) as Set<number>).has(s)) a.extraSignal++
      }
    }
  }
}

const kb = (n: number): string => (n / 1024).toFixed(0) + 'KB'
const pct = (a: number, b: number): string => (b === 0 ? '-' : (100 * a / b).toFixed(1)) + '%'
console.log('达标档案 = ' + archivesDone + ' | 软候选总字节 = ' + kb(totalSoftChars))
const rows: string[] = ['变体          预算    额外保护(枚/KB, 宽)  挤占(枚/KB)   缺口(档/KB)  信号保住%  救回付账枚']
for (const v of VARIANTS) {
  for (const b of BUDGETS) {
    const a = (agg.get(v) as Map<number, VAgg>).get(b) as VAgg
    rows.push(v.padEnd(13) + String(b).padEnd(7)
      + (a.extraAtoms + '/' + kb(a.extraChars) + ',' + pct(a.extraChars, totalSoftChars)).padEnd(21)
      + ' ' + (a.displacedAtoms + '/' + kb(a.displacedChars)).padEnd(11)
      + ' ' + (a.shortfallArchives + '/' + kb(a.shortfallChars)).padEnd(11)
      + ' ' + pct(a.signalKept, a.signalAtoms).padEnd(10)
      + ' ' + a.extraSignal)
  }
}
console.log(rows.join('\n'))
console.log('判读：宽度列看"留太多"（docStrongAll 若宽到挤占陡增⇒回退 docStrong1）；'
  + '信号保住列看"留太少"（combo 应显著高于 base 侧的 docStrong1/errHard2sup 单腿）；'
  + 'errHardAll−errHard2 的宽度差=n=1 陷阱的价格。cmdMedium 只挪排序：宽度 0、只有挤占。')

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true })
fs.writeFileSync(path.join(OUT_DIR, 'agg.json'), JSON.stringify(Object.fromEntries([...agg.entries()].map(([v, m]) => [v, Object.fromEntries([...m.entries()])])), null, 1))
console.log('明细 → ' + path.join(OUT_DIR, 'agg.json'))
