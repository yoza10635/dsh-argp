#!/usr/bin/env node
/**
 * spike 55 — "模型要对比新旧版本"论断的实数检验（用户 2026-11-11：该情况是否存在、
 * 频率多高可以直接检验）。全 B 类口径，零 LLM。
 *
 * 三个可数痕迹：
 *  M1 **处理感知取回率**（决定性）：pristine 读 R 且 supersededMarks=true（旧版本枚），
 *     若被在线处理档案（fold replace 链）压掉 ⇒ 处理点之后同文件是否再被 read/view
 *     取回或 recall 点名 = superseded 释放的**真实付账率**；对照组=同样被压但**未**
 *     superseded 的读。两率接近 ⇒ 链的释放和无差别释放一样疼；superseded 组显著高
 *     ⇒ "旧版本被需要"实锤，全删有据。
 *  M2 **显式对比手势**：tool/call 里 git diff / diff / Compare-Object / fc 的调用频率。
 *  M3 **无变更重读震荡**：同文件相邻两次成功读之间没有任何对该文件的 edit/write
 *     ⇒ 纯查看/对比手势代理；报"≥2 读文件里无变更对占比"与"≥3 读文件占比"。
 *     （bash/pwsh 改文件不在 edit 口径内——M3 是上界偏乐观的代理，登记。）
 *
 * 口径复用：宿主 foldSurface（spike52 同款）、supersededMarks（引擎自家）、seqMap 对齐。
 * 隐私：stdout 只聚合量。
 *
 * ```bash
 * npm run vercmp [-- --limit=8]
 * ```
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { sessionEvents } from '../src/log-access.ts'
import { sessionCwdFromEvents, supersededMarks, type EventLike } from '../src/factor/factor-atoms.ts'
import { loadSessionEvents, type RawSessionEvent } from './lib/session-corpus.ts'
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
const ROOTS = (flagOf('roots') ?? defaultRoots().join(path.delimiter)).split(path.delimiter).filter(r => r !== '')

interface FoldReplacement { seq: number; start: number; end: number; shadowedSeqs: number[] }
const NM = process.env['DSH_PROFILE_NODE_MODULES'] ?? path.join(process.cwd(), 'node_modules')
const SURFACE_FILE = path.join(NM, '@deepseek-ai', 'dsh-session', 'lib', 'types', 'surface.js')
if (!fs.existsSync(SURFACE_FILE)) {
  console.error('[FAIL] 宿主 surface.js 未找到: ' + SURFACE_FILE)
  process.exit(1)
}
const { foldSurface } = await import(pathToFileURL(SURFACE_FILE).href) as {
  foldSurface: (events: readonly RawSessionEvent[]) => { nodes: number[]; replacements: FoldReplacement[] }
}

const RECALL_TOOLS = new Set(['recall_pruned', 'recall', 'list_pruned'])
const EDIT_TOOLS = new Set(['edit', 'write', 'multiedit', 'notebookedit', 'str_replace', 'search_replace'])
const READ_TOOLS = new Set(['read', 'view'])
const DIFF_RE = /(git\s+diff|\bdiff\b|compare-object|\bfc\s+\/|\bdifftool\b)/i

let archives = 0
const m1 = { supTreated: 0, supRetried: 0, ctlTreated: 0, ctlRetried: 0 }
const matched = { files: 0, supT: 0, supR: 0, supRC: 0, ctlT: 0, ctlR: 0, ctlRC: 0 }
let diffCalls = 0
let totalCalls = 0
let files2plus = 0
let pairsTotal = 0
let pairsNoEdit = 0
let files3plus = 0

for (const arc of collectArchives(ROOTS)) {
  if (LIMIT > 0 && archives >= LIMIT) break
  let events
  try { events = loadSessionEvents(arc.file).events } catch { continue }
  const bySeq: (RawSessionEvent | undefined)[] = []
  let turnEstimate = 0
  for (const e of events) {
    bySeq[e.seq] = e
    const t = (e.data as { turn?: number } | undefined)?.turn
    if (typeof t === 'number' && t > turnEstimate) turnEstimate = t
  }
  if (turnEstimate < MIN_TURNS) continue
  let fold
  try { fold = foldSurface(events) } catch { continue }
  const { session, seqMap } = toPristineSession(events, arc.slug)
  const eventsLike = sessionEvents(session) as unknown as EventLike[]
  if (eventsLike.length === 0) continue
  const mounted = await mountVariant({})
  mounted.bind(session)
  const decision = mounted.factor.decide(session, Number.MAX_SAFE_INTEGER)
  archives++

  const baseSeq = Math.min(...eventsLike.map(e => e.seq))
  const rawOf = (p: number): number | undefined => seqMap[p - baseSeq]

  // 处理点：原始 seq → 首个覆盖它的 replacement seq
  const treat = new Map<number, number>()
  for (const r of fold.replacements) {
    const mark = (s: number): void => { if (!treat.has(s)) treat.set(s, r.seq) }
    for (const s of r.shadowedSeqs) mark(s)
    for (let s = r.start; s <= r.end; s++) mark(s)
  }

  const cwd = sessionCwdFromEvents(eventsLike)
  const pathNorm = (p: string): string => p.toLowerCase().replace(/\\/g, '/')
  const cwdNorm = cwd !== undefined ? pathNorm(cwd).replace(/\/+$/, '') : null
  const mentionsFile = (text: string, file: string): boolean => {
    const t = pathNorm(text)
    const full = pathNorm(file)
    if (t.includes(full)) return true
    if (cwdNorm !== null && full.startsWith(cwdNorm + '/')) {
      const rel = full.slice(cwdNorm.length + 1)
      return rel.length > 5 && t.includes(rel)
    }
    return false
  }

  // 原流调用索引（M2 + recall 点名）
  const calls: Array<{ rawSeq: number; name: string; argsRaw: string }> = []
  for (const e of events) {
    if (e.type !== 'tool/call') continue
    totalCalls++
    const d = (e.data ?? {}) as { name?: string; arguments?: unknown }
    const name = typeof d.name === 'string' ? d.name : ''
    const raw = typeof d.arguments === 'string' ? d.arguments : JSON.stringify(d.arguments ?? '')
    if (DIFF_RE.test(name + ' ' + raw)) diffCalls++
    calls.push({ rawSeq: e.seq, name, argsRaw: raw })
  }

  // R 索引（pristine 贴标 → 原始 seq）
  const sup = supersededMarks(decision.tagsBySeq)
  const rs: Array<{ rawSeq: number; tool: string; files: string[] }> = []
  for (const [p, input] of decision.tagsBySeq) {
    const r = rawOf(p)
    if (r === undefined) continue
    rs.push({ rawSeq: r, tool: input.tool, files: input.tags.files })
  }

  // M1：被压的读，superseded 组 vs 对照组。对照组两种：
  //  粗对照=全部"被压未覆盖"读（活动度不匹配，会低估基线）；
  //  配对对照=**同文件**内被压的非 superseded 读（活动度天然匹配，主判据）。
  //  取回通道分列：read 取回（内容可能已变/未变）vs recall 点名（旧字节逐字节需求）。
  const refetchRead = (rawSeq: number, files: string[]): boolean =>
    rs.some(x => x.rawSeq > rawSeq && READ_TOOLS.has(x.tool) && x.files.some(f => files.includes(f)))
  const refetchRecall = (rawSeq: number, files: string[]): boolean =>
    calls.some(c => c.rawSeq > rawSeq && RECALL_TOOLS.has(c.name) && files.some(f => mentionsFile(c.argsRaw, f)))
  interface Cell { t: number; r: number; rc: number }
  const newCell = (): Cell => ({ t: 0, r: 0, rc: 0 })
  const perFile = new Map<string, { sup: Cell; ctl: Cell }>()
  const bumpM1 = (c: Cell, hitRead: boolean, hitRecall: boolean): void => { c.t++; if (hitRead) c.r++; if (hitRecall) c.rc++ }
  for (const [p, input] of decision.tagsBySeq) {
    if (!READ_TOOLS.has(input.tool) || input.tags.files.length === 0) continue
    const r = rawOf(p)
    if (r === undefined) continue
    const repSeq = treat.get(r)
    if (repSeq === undefined) continue // 未被在线处理 ⇒ 不在这笔账里
    const isSup = sup.get(p) === true
    const hitRead = refetchRead(repSeq, input.tags.files)
    const hitRecall = refetchRecall(repSeq, input.tags.files)
    if (isSup) { m1.supTreated++; if (hitRead || hitRecall) m1.supRetried++ }
    else { m1.ctlTreated++; if (hitRead || hitRecall) m1.ctlRetried++ }
    for (const f of input.tags.files) {
      const g = perFile.get(f) ?? { sup: newCell(), ctl: newCell() }
      bumpM1(isSup ? g.sup : g.ctl, hitRead, hitRecall)
      perFile.set(f, g)
    }
  }
  for (const [f, g] of perFile) {
    if (g.sup.t === 0 || g.ctl.t === 0) continue
    matched.supT += g.sup.t; matched.supR += g.sup.r; matched.supRC += g.sup.rc
    matched.ctlT += g.ctl.t; matched.ctlR += g.ctl.r; matched.ctlRC += g.ctl.rc
    matched.files++
    void f
  }

  // M3：同文件相邻读之间无 edit ⇒ 无变更重读（pristine seq 空间）
  const byFile = new Map<string, { reads: number[]; edits: number[] }>()
  for (const [p, input] of decision.tagsBySeq) {
    for (const f of input.tags.files) {
      const g = byFile.get(f) ?? { reads: [], edits: [] }
      if (READ_TOOLS.has(input.tool)) g.reads.push(p)
      else if (EDIT_TOOLS.has(input.tool) && input.tags.errorcodes.length === 0) g.edits.push(p)
      byFile.set(f, g)
    }
  }
  for (const g of byFile.values()) {
    g.reads.sort((a, b) => a - b)
    g.edits.sort((a, b) => a - b)
    if (g.reads.length >= 2) files2plus++
    if (g.reads.length >= 3) files3plus++
    for (let i = 0; i + 1 < g.reads.length; i++) {
      pairsTotal++
      const [lo, hi] = [g.reads[i] as number, g.reads[i + 1] as number]
      if (!g.edits.some(e => e > lo && e < hi)) pairsNoEdit++
    }
  }
}

const pct = (a: number, b: number): string => (b === 0 ? '-' : (100 * a / b).toFixed(1)) + '%'
console.log('达标档案 = ' + archives)
console.log('M1 处理感知取回率（被压读之后同文件再取回）：')
console.log('  粗对照口径 superseded 组 = ' + m1.supRetried + '/' + m1.supTreated + '（' + pct(m1.supRetried, m1.supTreated)
  + '） vs 非 superseded 被压读 = ' + m1.ctlRetried + '/' + m1.ctlTreated + '（' + pct(m1.ctlRetried, m1.ctlTreated) + '）')
console.log('  **同文件配对**（' + matched.files + ' 个两态齐全的文件）：')
console.log('    superseded 枚 = read 再取 ' + pct(matched.supR, matched.supT) + ' | recall 点名 ' + pct(matched.supRC, matched.supT))
console.log('    同文件新版枚 = read 再取 ' + pct(matched.ctlR, matched.ctlT) + ' | recall 点名 ' + pct(matched.ctlRC, matched.ctlT))
console.log('  （read 再取=活动度代理，内容可能已刷新；recall 点名=旧字节逐字节需求的唯一直证）')
console.log('M2 显式对比调用 = ' + diffCalls + ' / ' + totalCalls + ' tool/call（' + pct(diffCalls, totalCalls) + '）')
console.log('M3 无变更重读对 = ' + pairsNoEdit + '/' + pairsTotal + '（' + pct(pairsNoEdit, pairsTotal)
  + '）| ≥2 读文件 = ' + files2plus + '，其中 ≥3 读 = ' + files3plus + '（' + pct(files3plus, files2plus) + '）')
