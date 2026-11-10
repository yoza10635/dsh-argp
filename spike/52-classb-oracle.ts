#!/usr/bin/env node
/**
 * spike 52 — B 类 oracle：处理感知成本账（§9.7 A/B 分法，用户 2026-11-10 提出口径）。
 *
 * ## 与 spike51 的分工
 *
 * spike51 的 LLM 判卷 = **A 类**（模型"主动想不想留"，校准证明不可信只作旁证）；
 * 其确定性信号 = **B 类**（剪后真付账）但**处理盲**——不问"当时在不在上下文"，
 * 把"内容还在却被重读"（模型自己的毛病）记进了成本。本件补 B 类的正确形态：
 * **成本只记在"在线确实被压缩过"的条目上**。
 *
 * ## 处理档案 = 归档 replace 链（宿主权威 foldSurface，绝不自己折）
 *
 * 原始归档里每条 replacement 给出 {seq, start, end, shadowedSeqs}：被覆盖的原始
 * seq 在该点被遮蔽/桩化（tool/result 是 content-only 改写，R 不离场但正文已换——
 * 同样记"被处理"）。归因看**桩文本形**（tombstone-text 指纹 ⇒ 'argp'；replace 本体
 * 不带 source 标记——探针实锤），非桩 ⇒ 'other'（basic 摘要等）；控制组=同会话内
 * 从未被覆盖的 R（'kept'）。尾窗 ≥20 事件切 early/late 仅作护栏（首轮实测
 * 尾窗 p50≈477：在线 replace 全程发生、**不尾偏**；late 率低不得翻案）。
 * 成本事件按**原流 seq 因果序**在处理点之后找：
 *   recall    召回工具（recall_pruned/recall/list_pruned，recall-tools.ts:72/150/260）
 *             点名本条主题——**压缩体制特有**的付账通道：不压缩就没有这条调用；
 *   dupCall   同工具名+同归一参数的**逐字重发**（bash 类直测）；
 *   subj      同工具名再触达同主题（args 提到本条文件——read 换窗口再读也算）；
 *   reRead    后续 read/view 再取同文件（处理感知版，对照 spike51 的处理盲版）；
 *   reerror   同 errorcode 再现（仍为相关证据，不是因果）；
 *   errFile   后续报错 R（isError 或有 errorcode）正文再提本条文件。
 * **选择偏差登记**：剪枝器专挑"不被需要"的下手，treated 各率低于 kept 是剪枝
 * 在干活的预期形态——本表正确读法=facet 间横向比 + recall 绝对量，不是 Δ>0 单门槛。
 *
 * ## 边界（登记在册）
 *
 * ① 处理组是 **graph 时代在线 argp** 的动作，不是本引擎变体的决策——本表度量
 *    "facet 级压缩的真实代价"，喂 facet 分级提案（§2.5），不裁决变体本身；
 * ② 因果 B 类只能来自 T-3 带发射重放；本表一切差值都是实现轨迹相关证据；
 * ③ 旧归档 error 形缺 isError 的条目走 errorcode 旁路，errFile 对其失明。
 *
 * 隐私铁律同前：只读；stdout 只聚合量；明细（键+布尔，无正文）落 spike/out/。
 *
 * ```bash
 * npm run classb                # 全量（零 LLM）
 * npm run classb -- --limit 8
 * ```
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { eventTextOf, sessionEvents } from '../src/log-access.ts'
import { isTombstoneText } from '../src/tombstone-text.ts'
import { sessionCwdFromEvents, type EventLike } from '../src/factor/factor-atoms.ts'
import { indexKeys } from '../src/factor/factor-ledger.ts'
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
const OUT_DIR = flagOf('out') ?? path.join('spike', 'out', 'classb')
const ROOTS = (flagOf('roots') ?? defaultRoots().join(path.delimiter)).split(path.delimiter).filter(r => r !== '')

// ---------------------------------------------------------------------------
// 宿主权威 surface 折叠（同 spike47 教训：自写重放必漂移）
// ---------------------------------------------------------------------------

interface FoldReplacement { seq: number; start: number; end: number; shadowedSeqs: number[] }

const NM = process.env['DSH_PROFILE_NODE_MODULES'] ?? path.join(process.cwd(), 'node_modules')
const SURFACE_FILE = path.join(NM, '@deepseek-ai', 'dsh-session', 'lib', 'types', 'surface.js')
if (!fs.existsSync(SURFACE_FILE)) {
  console.error('[FAIL] 宿主 surface.js 未找到: ' + SURFACE_FILE + '\n       用 DSH_PROFILE_NODE_MODULES 指向别处')
  process.exit(1)
}
const hostVersion = (JSON.parse(fs.readFileSync(path.join(NM, '@deepseek-ai', 'dsh-session', 'package.json'), 'utf8')) as { version: string }).version
const { foldSurface } = await import(pathToFileURL(SURFACE_FILE).href) as {
  foldSurface: (events: readonly RawSessionEvent[]) => { nodes: number[]; replacements: FoldReplacement[] }
}

// ---------------------------------------------------------------------------
// 聚合
// ---------------------------------------------------------------------------

const FACET_RANK = ['document', 'errorcode', 'command', 'scope'] as const
type Facet = typeof FACET_RANK[number] | 'none'
const facetOf = (keys: readonly string[]): Facet => {
  for (const f of FACET_RANK) if (keys.some(k => k.startsWith(f + ':'))) return f
  return 'none'
}
const normArgs = (s: string): string => s.toLowerCase().replace(/\\/g, '/').replace(/\s+/g, ' ').trim()

interface Bucket { n: number; recall: number; dup: number; subj: number; reRead: number; reerror: number; errFile: number; anyCost: number }
const buckets = new Map<string, Bucket>()
const bump = (facet: Facet, group: string): Bucket => {
  const k = facet + '|' + group
  let b = buckets.get(k)
  if (b === undefined) { b = { n: 0, recall: 0, dup: 0, subj: 0, reRead: 0, reerror: 0, errFile: 0, anyCost: 0 }; buckets.set(k, b) }
  return b
}

// 尾窗护栏：首轮实测尾窗 p50≈477（在线 replace 全程发生），early/late 一般同分布；
// 保留切分只为异种语料（尾偏型）兜底。
const EARLY_TAIL = 20
const RECALL_TOOLS = new Set(['recall_pruned', 'recall', 'list_pruned'])
let recallCalls = 0

const details: Array<{ key: string; facet: Facet; group: string; treatSeq: number | null; tail: number; recall: boolean; dup: boolean; subj: boolean; reRead: boolean; reerror: boolean; errFile: boolean }> = []
const treatedTails: number[] = []

// errorcode 共现先验（用户 2026-11-10 假设：code 单因子无鉴别力（§9.8 实锤 2），
// 价值在 code×共现因子——同 tool=工具损坏、同 command=环境事实、同 file=幻觉记忆）
interface ErrItem { slug: string; code: string; tool: string; hasCmd: boolean; hasFile: boolean; group: string; reRead: boolean; reerror: boolean; errFile: boolean; any: boolean }
const errItems: ErrItem[] = []
const toolTally = new Map<string, { n: number; errN: number }>()
let archivesDone = 0
let foldThrows = 0
const repHist: Record<string, number> = {}

// ---------------------------------------------------------------------------
// 主循环
// ---------------------------------------------------------------------------

for (const arc of collectArchives(ROOTS)) {
  if (LIMIT > 0 && archivesDone >= LIMIT) break
  let events: RawSessionEvent[]
  try { events = loadSessionEvents(arc.file).events } catch { continue }

  const bySeq: (RawSessionEvent | undefined)[] = []
  let turnEstimate = 0
  for (const e of events) {
    bySeq[e.seq] = e
    const t = (e.data as { turn?: number } | undefined)?.turn
    if (typeof t === 'number' && t > turnEstimate) turnEstimate = t
  }
  if (turnEstimate < MIN_TURNS) continue
  const rawEnd = bySeq.length - 1

  let fold
  try { fold = foldSurface(events) } catch { foldThrows++; continue }
  archivesDone++

  // 处理链：原始 seq → 首个覆盖它的 replacement（range 含 content-only 改写；
  // 区间内的非 surface 洞也会被标记，但只有 R 条目参与查表，无害）。
  const treat = new Map<number, { repSeq: number; agent: 'argp' | 'other' }>()
  for (const r of fold.replacements) {
    // 归因：replace 本体不带 source 标记（探针实锤 keys=turn,step,message）——
    // 认桩文本形（tombstone-text 是 argp 桩的精确指纹）；非桩 ⇒ 非 argp（basic 摘要等）。
    const repEv = bySeq[r.seq]
    const repText = repEv !== undefined ? eventTextOf(repEv as never) : ''
    const agent: 'argp' | 'other' = repText !== '' && isTombstoneText(repText) ? 'argp' : 'other'
    repHist[agent] = (repHist[agent] ?? 0) + 1
    const mark = (s: number): void => { if (!treat.has(s)) treat.set(s, { repSeq: r.seq, agent }) }
    for (const s of r.shadowedSeqs) mark(s)
    for (let s = r.start; s <= r.end; s++) mark(s)
  }

  // pristine 重建 + 贴标（与 spike50/51 同核；seqMap 对齐 pristine seq ↔ 原始 seq）
  const { session, seqMap } = toPristineSession(events, arc.slug)
  const eventsLike = sessionEvents(session) as unknown as EventLike[]
  if (eventsLike.length === 0) continue
  const baseSeq = Math.min(...eventsLike.map(e => e.seq))
  const rawOf = (p: number): number | undefined => seqMap[p - baseSeq]

  const mounted = await mountVariant({})
  mounted.bind(session)
  const decision = mounted.factor.decide(session, Number.MAX_SAFE_INTEGER)
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

  // 原流索引用语料事件（成本事件必须落在原始因果序上）
  const calls: Array<{ rawSeq: number; name: string; args: string; raw: string }> = []
  const argsByCallId = new Map<string, string>()
  for (const e of events) {
    if (e.type !== 'tool/call') continue
    const d = (e.data ?? {}) as { callId?: string; name?: string; arguments?: unknown }
    const a = typeof d.arguments === 'string' ? d.arguments : JSON.stringify(d.arguments ?? '')
    if (typeof d.callId === 'string') argsByCallId.set(d.callId, a)
    const name = typeof d.name === 'string' ? d.name : ''
    if (RECALL_TOOLS.has(name)) recallCalls++
    calls.push({ rawSeq: e.seq, name, args: normArgs(a), raw: a })
  }

  const laterRs: Array<{ rawSeq: number; tool: string; files: string[]; errorcodes: string[] }> = []
  const errFileIdx: Array<{ rawSeq: number; text: string }> = []
  for (const [p, input] of decision.tagsBySeq) {
    const r = rawOf(p)
    if (r === undefined) continue
    laterRs.push({ rawSeq: r, tool: input.tool, files: input.tags.files, errorcodes: input.tags.errorcodes })
    const msg = (bySeq[r]?.data as { message?: { isError?: boolean } } | undefined)?.message
    if (msg?.isError === true || input.tags.errorcodes.length > 0) errFileIdx.push({ rawSeq: r, text: input.resultText })
  }

  for (const [p, input] of decision.tagsBySeq) {
    const r = rawOf(p)
    if (r === undefined) continue
    const t = treat.get(r)
    const windowStart = t !== undefined ? t.repSeq : r
    const tail = rawEnd - windowStart
    const group = t === undefined ? 'kept' : t.agent + (tail >= EARLY_TAIL ? '-e' : '-l')
    if (t !== undefined) treatedTails.push(tail)
    const keys = [...indexKeys(input.tags)]
    const facet = facetOf(keys)
    const files = input.tags.files
    const argsX = input.callId !== undefined ? normArgs(argsByCallId.get(input.callId) ?? '') : ''
    const recall = calls.some(c => c.rawSeq > windowStart && RECALL_TOOLS.has(c.name)
      && (files.some(f => mentionsFile(c.raw, f)) || keys.some(k => c.args.includes(normArgs(k)))))
    const dup = argsX !== '' && calls.some(c => c.rawSeq > windowStart && c.name === input.tool && c.args === argsX)
    const subj = files.length > 0 && calls.some(c => c.rawSeq > windowStart && c.name === input.tool
      && files.some(f => mentionsFile(c.raw, f)))
    const reRead = files.length > 0 && laterRs.some(x => x.rawSeq > windowStart
      && (x.tool === 'read' || x.tool === 'view') && x.files.some(f => files.includes(f)))
    const reerror = input.tags.errorcodes.length > 0 && laterRs.some(x => x.rawSeq > windowStart
      && x.errorcodes.some(c => input.tags.errorcodes.includes(c)))
    const errFile = files.length > 0 && errFileIdx.some(x => x.rawSeq > windowStart && files.some(f => mentionsFile(x.text, f)))
    const tl = toolTally.get(input.tool) ?? { n: 0, errN: 0 }
    tl.n++
    if (input.tags.errorcodes.length > 0) {
      tl.errN++
      for (const code of input.tags.errorcodes) {
        errItems.push({ slug: arc.slug, code, tool: input.tool, hasCmd: input.tags.commands.length > 0, hasFile: files.length > 0, group,
          reRead, reerror, errFile, any: recall || dup || subj || reRead || reerror || errFile })
      }
    }
    toolTally.set(input.tool, tl)
    const b = bump(facet, group)
    b.n++
    if (recall) b.recall++
    if (dup) b.dup++
    if (subj) b.subj++
    if (reRead) b.reRead++
    if (reerror) b.reerror++
    if (errFile) b.errFile++
    if (recall || dup || subj || reRead || reerror || errFile) b.anyCost++
    details.push({ key: arc.slug + '|r' + r, facet, group, treatSeq: t?.repSeq ?? null, tail, recall, dup, subj, reRead, reerror, errFile })
  }
}

// ---------------------------------------------------------------------------
// 输出（聚合量）
// ---------------------------------------------------------------------------

console.log('host foldSurface = dsh-session@' + hostVersion + '（运行时 0.2.2-rc.1 同版为佳，异版谨慎读数）')
console.log('达标档案 = ' + archivesDone + ' | fold 抛出跳过 = ' + foldThrows + ' | replacements = ' + JSON.stringify(repHist)
  + ' | 召回工具调用总数 = ' + recallCalls)
const pct = (x: number, n: number): string => (n === 0 ? '-' : (100 * x / n).toFixed(1)) + '%'
treatedTails.sort((a, b) => a - b)
const q = (x: number): number => treatedTails.length === 0 ? NaN : treatedTails[Math.round((treatedTails.length - 1) * x)]
console.log('处理点尾窗分布（事件数）: p25=' + q(0.25) + ' p50=' + q(0.5) + ' p75=' + q(0.75)
  + ' | early(≥' + EARLY_TAIL + ') 占比 = ' + pct(treatedTails.filter(t => t >= EARLY_TAIL).length, treatedTails.length))
const rows: string[] = []
rows.push('facet      group    n     recall dup    subj   reRead  reerror  errFile  anyCost')
for (const facet of [...FACET_RANK, 'none']) {
  for (const group of ['argp-e', 'argp-l', 'other-e', 'other-l', 'kept']) {
    const b = buckets.get(facet + '|' + group)
    if (b === undefined || b.n === 0) continue
    rows.push(facet.padEnd(10) + ' ' + group.padEnd(8) + String(b.n).padEnd(5)
      + ' ' + pct(b.recall, b.n).padEnd(6) + ' ' + pct(b.dup, b.n).padEnd(6) + ' ' + pct(b.subj, b.n).padEnd(6)
      + ' ' + pct(b.reRead, b.n).padEnd(7)
      + ' ' + pct(b.reerror, b.n).padEnd(8) + ' ' + pct(b.errFile, b.n).padEnd(8) + pct(b.anyCost, b.n))
  }
  const sum = (gs: string[]): Bucket | undefined => {
    let found = false
    const acc: Bucket = { n: 0, recall: 0, dup: 0, subj: 0, reRead: 0, reerror: 0, errFile: 0, anyCost: 0 }
    for (const g of gs) {
      const b = buckets.get(facet + '|' + g)
      if (b === undefined) continue
      found = true
      acc.n += b.n; acc.recall += b.recall; acc.dup += b.dup; acc.subj += b.subj; acc.reRead += b.reRead
      acc.reerror += b.reerror; acc.errFile += b.errFile; acc.anyCost += b.anyCost
    }
    return found ? acc : undefined
  }
  const early = sum(['argp-e', 'other-e'])
  const k = buckets.get(facet + '|kept')
  if (early !== undefined && k !== undefined && early.n > 0 && k.n > 0) {
    rows.push('  Δ(early处理−kept) = ' + (100 * early.anyCost / early.n - 100 * k.anyCost / k.n).toFixed(1) + ' pt')
  }
}
console.log(rows.join('\n'))
console.log('判读：首选 **facet 横向比**（同 group 行之间）+ **recall 列绝对量**——recall 是压缩体制'
  + '特有的付账通道，哪列高哪 facet 被压后真被再次需要；Δ(early−kept)>0 只是加分项，'
  + 'Δ≤0 是剪枝选择性的预期形态（头注"选择偏差登记"）。'
  + '\n因果裁决仍需 T-3——本表是在线 graph 时代 argp 处理轨迹的相关证据（头注①②）。')

// ---------------------------------------------------------------------------
// errorcode 共现先验表（用户假设检验）
// ---------------------------------------------------------------------------

console.log('\n=== errorcode 共现先验（code×共现因子；条目=带 code 的 R，多 code 计多次）===')
console.log('带 code 的 R = ' + errItems.length + ' / 全部 R = ' + [...toolTally.values()].reduce((s, t) => s + t.n, 0))
const rate = (xs: ErrItem[], pick: (x: ErrItem) => boolean): string =>
  pct(xs.filter(pick).length, xs.length)
const profRows: string[] = ['共现形态        组      n     reRead  reerror  errFile  anyCost']
for (const [pname, test] of [['+file', (x: ErrItem) => x.hasFile], ['+cmd(无file)', (x: ErrItem) => !x.hasFile && x.hasCmd], ['裸code', (x: ErrItem) => !x.hasFile && !x.hasCmd]] as Array<[string, (x: ErrItem) => boolean]>) {
  for (const [gname, gtest] of [['argp-e', (x: ErrItem) => x.group === 'argp-e'], ['kept', (x: ErrItem) => x.group === 'kept']] as Array<[string, (x: ErrItem) => boolean]>) {
    const xs = errItems.filter(x => test(x) && gtest(x))
    if (xs.length === 0) continue
    profRows.push(pname.padEnd(15) + gname.padEnd(7) + String(xs.length).padEnd(5)
      + ' ' + rate(xs, x => x.reRead).padEnd(7) + ' ' + rate(xs, x => x.reerror).padEnd(8)
      + ' ' + rate(xs, x => x.errFile).padEnd(8) + rate(xs, x => x.any))
  }
}
console.log(profRows.join('\n'))

const byCode = new Map<string, { n: number; tools: Map<string, number>; cmd: number; file: number }>()
for (const x of errItems) {
  let c = byCode.get(x.code)
  if (c === undefined) { c = { n: 0, tools: new Map(), cmd: 0, file: 0 }; byCode.set(x.code, c) }
  c.n++
  c.tools.set(x.tool, (c.tools.get(x.tool) ?? 0) + 1)
  if (x.hasCmd) c.cmd++
  if (x.hasFile) c.file++
}
const topCodes = [...byCode.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 12)
console.log('top codes（topTool 占比=共现集中度；≥60% 即用户假设的"捆绑因子"）:')
for (const [code, c] of topCodes) {
  const [tTool, tN] = [...c.tools.entries()].sort((a, b) => b[1] - a[1])[0] ?? ['-', 0]
  console.log('  ' + code.slice(0, 30).padEnd(31) + ' n=' + String(c.n).padEnd(6)
    + ' topTool=' + tTool + '(' + pct(tN, c.n) + ')  +cmd=' + pct(c.cmd, c.n) + '  +file=' + pct(c.file, c.n))
}
const allN = [...toolTally.values()].reduce((s, t) => s + t.n, 0)
const allErr = [...toolTally.values()].reduce((s, t) => s + t.errN, 0)
const avgRate = allN > 0 ? allErr / allN : 0
const hot = [...toolTally.entries()].filter(([, t]) => t.n >= 20 && t.errN / t.n > avgRate * 2)
  .sort((a, b) => b[1].errN / b[1].n - a[1].errN / a[1].n)
console.log('工具错误率扫描（语料均=' + pct(allErr, allN) + '）：异常工具(n≥20 且 >2×均) = '
  + (hot.length === 0 ? '无' : hot.map(([t, x]) => t + ' ' + pct(x.errN, x.n) + '(n=' + x.n + ')').join(', ')))

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true })
fs.writeFileSync(path.join(OUT_DIR, 'details.jsonl'), details.map(d => JSON.stringify(d)).join('\n') + '\n')
console.log('明细（键+布尔，无正文）→ ' + path.join(OUT_DIR, 'details.jsonl'))
