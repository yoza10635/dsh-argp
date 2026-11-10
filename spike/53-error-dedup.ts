#!/usr/bin/env node
/**
 * spike 53 — errorcode 签名去重的 exemplar 规则测算（用户 2026-11-10 提案：
 * 组合原子压缩时**只留一枚**就够让 Agent 意识到问题，不必全留）。
 *
 * 签名 = code + 共现因子（优先 file，次 command，再 tool；§9.9 路由口径）。
 * 规则草案（v1.2 候选）：同签名组内**最新一枚**为 exemplar；其余为 excess
 * （普通可剪，词表 note 记"×N 次"）；若组内最新错误**之后**出现同因子的
 * 无码成功 R ⇒ 事实失效（superseded），连 exemplar 都可剪。
 *
 * 测四个数：①excess 枚数/字节（只留一枚省多少）；②excess 中当前被 hard 保护的
 * 枚数/字节（=现在正烧预算的重复枚，主要走 sticky 通道——它按 对 匹配，
 * 匹配到的**每一枚**都硬保）；③superseded 组占比（可再省一层）；④exemplar 枚
 * 当前被 hard 保护的存活面。
 *
 * 口径：pristine 重建（与 spike50/51/52 共享核），decide(∞) 拿 tagsBySeq+hardProtected；
 * 零 LLM。隐私：stdout 只聚合量。
 *
 * ```bash
 * npm run errdedup [-- --limit=8]
 * ```
 */
import * as path from 'node:path'
import { sessionEvents } from '../src/log-access.ts'
import { collectArchives, defaultRoots, mountVariant, toPristineSession } from './lib/t2-replay-core.ts'
import { loadSessionEvents } from './lib/session-corpus.ts'

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

interface Sig { seq: number; bytes: number; files: string[]; cmds: string[] }

let archivesDone = 0
const agg = {
  errAtoms: 0, errBytes: 0,
  groups: 0, multiGroups: 0,
  excessAtoms: 0, excessBytes: 0,
  excessHardAtoms: 0, excessHardBytes: 0,
  supersededGroups: 0,
  exemplarHardAtoms: 0,
}

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
  const decision = mounted.factor.decide(session, Number.MAX_SAFE_INTEGER)
  archivesDone++

  const hard = new Set(decision.plan.hardProtected)
  const groups = new Map<string, Sig[]>()
  const bytesBySeq = new Map<number, number>()
  const allRs: Array<{ seq: number; files: string[]; cmds: string[]; hasErr: boolean }> = []
  for (const [seq, input] of decision.tagsBySeq) {
    allRs.push({ seq, files: input.tags.files, cmds: input.tags.commands, hasErr: input.tags.errorcodes.length > 0 })
    if (input.tags.errorcodes.length === 0) continue
    agg.errAtoms++
    agg.errBytes += input.tags.sizeChars
    bytesBySeq.set(seq, input.tags.sizeChars)
    const factor = input.tags.files[0] !== undefined ? 'f:' + input.tags.files[0]
      : input.tags.commands[0] !== undefined ? 'c:' + input.tags.commands[0] : 't:' + input.tool
    for (const code of input.tags.errorcodes) {
      const sig = code + '|' + factor
      const g = groups.get(sig) ?? []
      g.push({ seq, bytes: input.tags.sizeChars, files: input.tags.files, cmds: input.tags.commands })
      groups.set(sig, g)
    }
  }

  // exemplar 判定**按条去重**（一条可属多组：任一签名组里是最新一枚 ⇒ 保留；
  // 直接按组成员累加会把多码条目的字节重复计数——首轮 99.2% 就是这么来的）
  const exemplarSeqs = new Set<number>()
  for (const g of groups.values()) {
    agg.groups++
    if (g.length > 1) agg.multiGroups++
    g.sort((a, b) => a.seq - b.seq)
    const exemplar = g[g.length - 1] as Sig
    exemplarSeqs.add(exemplar.seq)
    const factor = exemplar.files[0] ?? exemplar.cmds[0] ?? null
    const sameFactor = (r: { files: string[]; cmds: string[] }): boolean =>
      factor !== null && (r.files.includes(factor) || r.cmds.includes(factor))
    if (allRs.some(r => r.seq > exemplar.seq && !r.hasErr && sameFactor(r))) agg.supersededGroups++
  }
  for (const [seq, bytes] of bytesBySeq) {
    if (exemplarSeqs.has(seq)) {
      if (hard.has(seq)) agg.exemplarHardAtoms++
      continue
    }
    agg.excessAtoms++
    agg.excessBytes += bytes
    if (hard.has(seq)) { agg.excessHardAtoms++; agg.excessHardBytes += bytes }
  }
}

const pct = (a: number, b: number): string => (b === 0 ? '-' : (100 * a / b).toFixed(1)) + '%'
const kb = (n: number): string => (n / 1024).toFixed(1) + 'KB'
console.log('达标档案 = ' + archivesDone)
console.log('带码 R = ' + agg.errAtoms + ' 枚 / ' + kb(agg.errBytes) + ' | 签名组 = ' + agg.groups
  + '（多枚组 ' + agg.multiGroups + '，' + pct(agg.multiGroups, agg.groups) + '）')
console.log('exemplar 规则可剪 excess = ' + agg.excessAtoms + ' 枚 / ' + kb(agg.excessBytes)
  + '（占错误字节 ' + pct(agg.excessBytes, agg.errBytes) + '）')
console.log('其中当前 hard 保护的重复枚 = ' + agg.excessHardAtoms + ' 枚 / ' + kb(agg.excessHardBytes)
  + '（excess 的 ' + pct(agg.excessHardAtoms, agg.excessAtoms) + '；现由 sticky 逐枚硬保）')
console.log('superseded 组（最新错误后同因子成功过 ⇒ exemplar 亦可剪）= ' + agg.supersededGroups
  + ' / ' + agg.groups + '（' + pct(agg.supersededGroups, agg.groups) + '）')
console.log('exemplar 枚当前被 hard 保护 = ' + agg.exemplarHardAtoms + ' 枚（去重后仍想留的保护面）')
