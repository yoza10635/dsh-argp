/**
 * spike 41 — 真实 session 语料校准（PROPOSAL-token-ontology §2 的真实语料地基）
 *
 * 动机：spike40 的误连率是**受控植入真值**（合成），据此的结论只在"合成语料成立"的
 * 前提下有效。本 spike 换用**本机真实 session**（`~/.dsh/sessions`，只读，见
 * `spike/lib/session-corpus.ts` 的隐私铁律）做**校准**：真实数据的 token DF 分布、
 * 停词阈是否真的起作用、推断边的支撑强度与影响半径。
 *
 * ⚠️ **只输出聚合量，绝不输出 session 原文**；`~/.dsh/sessions` 不存在时优雅跳过
 * （CI 通常没有），退出码仍为 0。
 *
 * 判决项：
 *   S41-1 loader-integrity  多帧 zstd 读取器完整复原：0 坏帧 / 0 丢弃行 / seq 无缺口
 *   S41-2 edges-nonvacuous  真实语料上确实派生出推断边（机制不是空转）
 * 观察项（真实语料校准结论，不硬卡）：
 *   S41-3 停词阈命中数  真实语料上 15% 停词阈命中 **0 个** token（见 FINDING F41-1）
 *   S41-4 支撑强度      单 token 支撑边占比、被保护数据原子占比（影响半径）
 *
 * 用法：node --import ./scripts/ts-import-rewrite-loader.mjs spike/41-real-corpus.ts
 * 产物：spike/out/41-real-corpus-<stamp>.json（**仅聚合量**）
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { deriveInferredEdges, findLoadBearingTokens, type OntologyAtom } from '../src/token-ontology.ts'
import { defaultSessionRoot, loadRealCorpus, type RealSession } from './lib/session-corpus.ts'

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const outDir = path.join(import.meta.dirname, 'out')
fs.mkdirSync(outDir, { recursive: true })

const failures: string[] = []
const findings: { id: string; severity: 'HIGH' | 'MEDIUM'; detail: string }[] = []
const verdict = (name: string, ok: boolean, detail: string): void => {
  console.log((ok ? '[PASS ' : '[FAIL ') + name + '] ' + detail)
  if (!ok) failures.push(name + ': ' + detail)
}
const finding = (id: string, severity: 'HIGH' | 'MEDIUM', detail: string): void => {
  console.log(`[FINDING ${id} · ${severity}] ${detail}`)
  findings.push({ id, severity, detail })
}

/** 单 session 的推断边统计（生产口径 = 每 session 独立建图）。 */
interface SessionStats {
  id: string
  cwdSlug: string
  atoms: number
  u: number
  a: number
  r: number
  chars: number
  turns: number
  uniqueTokens: number
  maxDf: number
  stopwordHits: number
  edges: number
  singleTokenEdges: number
  protectedDataAtoms: number
  dataAtoms: number
}

function statsOf(s: RealSession): SessionStats {
  const atoms: OntologyAtom[] = s.atoms
  const df = new Map<string, number>()
  const tokensBySeq = new Map<number, string[]>()
  for (const a of atoms) {
    const toks = findLoadBearingTokens(a.text)
    tokensBySeq.set(a.seq, toks)
    for (const t of new Set(toks)) df.set(t, (df.get(t) ?? 0) + 1)
  }
  const n = Math.max(atoms.length, 1)
  const stopwords = new Set([...df.entries()].filter(([, v]) => v / n > 0.15).map(([t]) => t))
  const edges = deriveInferredEdges(atoms)
  let single = 0
  for (const e of edges) {
    const from = tokensBySeq.get(e.fromSeq) ?? []
    const to = tokensBySeq.get(e.toSeq) ?? []
    // 支撑强度 = 同时满足「≥6 字符、非停词、双端逐字共现」的**不同 token 数**
    const shared = new Set(from.filter(t => t.length >= 6 && !stopwords.has(t) && to.includes(t)))
    if (shared.size === 1) single += 1
  }
  const cnt = (t: string): number => atoms.filter(a => a.type === t).length
  return {
    id: s.id,
    cwdSlug: s.cwdSlug,
    atoms: atoms.length,
    u: cnt('U'), a: cnt('A'), r: cnt('R'),
    chars: atoms.reduce((sum, a) => sum + a.text.length, 0),
    turns: new Set(atoms.map(a => a.turn)).size,
    uniqueTokens: df.size,
    maxDf: Math.max(0, ...df.values()),
    stopwordHits: stopwords.size,
    edges: edges.length,
    singleTokenEdges: single,
    protectedDataAtoms: new Set(edges.map(e => e.toSeq)).size,
    dataAtoms: atoms.filter(a => a.type !== 'A').length,
  }
}

function main(): void {
  const t0 = Date.now()
  const root = process.env['ARGP_SESSION_ROOT'] ?? defaultSessionRoot()
  console.log(`[spike41] 真实 session 语料校准（只读；root=${root}）`)

  const corpus = loadRealCorpus(root)
  if (corpus.length === 0) {
    console.log(`[skip] 未找到真实 session（${root} 不存在或为空）——CI 环境正常跳过，退出码 0`)
    return
  }

  // S41-1 读取器完整性（口径 = loader 账目；注意 `session` 头事件按设计无 seq，非损坏）
  const badFrames = corpus.reduce((s, c) => s + c.stats.badFrames, 0)
  const malformed = corpus.reduce((s, c) => s + c.stats.malformed, 0)
  const seqGaps = corpus.reduce((s, c) => s + c.stats.seqGaps, 0)
  const seqDups = corpus.reduce((s, c) => s + c.stats.seqDups, 0)
  const totalFrames = corpus.reduce((s, c) => s + c.stats.frames, 0)
  const totalSeq = corpus.reduce((s, c) => s + c.stats.seqCount, 0)
  const heads = corpus.reduce((s, c) => s + c.stats.headEvents, 0)
  verdict('S41-1 loader-integrity', badFrames === 0 && malformed === 0 && seqGaps === 0 && seqDups === 0,
    `${corpus.length} 个 session / ${totalFrames} 个 zstd 帧 / ${totalSeq} 条带 seq 事件（另有 ${heads} 条无 seq 的 session 头，属正常）：`
    + `坏帧 ${badFrames}、非法行 ${malformed}、**seq 缺口 ${seqGaps}、重复 ${seqDups}**——多帧拼接读取器完整复原历史`)

  const rows = corpus.map(statsOf)
  const totalAtoms = rows.reduce((s, r) => s + r.atoms, 0)
  const totalChars = rows.reduce((s, r) => s + r.chars, 0)
  const totalEdges = rows.reduce((s, r) => s + r.edges, 0)
  const totalSingle = rows.reduce((s, r) => s + r.singleTokenEdges, 0)
  const totalStopHits = rows.reduce((s, r) => s + r.stopwordHits, 0)
  const totalProtected = rows.reduce((s, r) => s + r.protectedDataAtoms, 0)
  const totalData = rows.reduce((s, r) => s + r.dataAtoms, 0)

  console.log(`\n  session 逐条（生产口径：每 session 独立建图）`)
  console.log('  ' + ['session', 'atoms', 'U/A/R', 'chars', 'turns', 'uniqTok', 'maxDF', 'stopDF15', 'edges', 'single1', 'protected'].map((h, i) => h.padEnd(i === 0 ? 26 : 10)).join(''))
  for (const r of rows) {
    console.log('  ' + [
      r.id.slice(0, 24).padEnd(26),
      String(r.atoms).padEnd(10),
      `${r.u}/${r.a}/${r.r}`.padEnd(10),
      String(r.chars).padEnd(10),
      String(r.turns).padEnd(10),
      String(r.uniqueTokens).padEnd(10),
      String(r.maxDf).padEnd(10),
      String(r.stopwordHits).padEnd(10),
      String(r.edges).padEnd(10),
      String(r.singleTokenEdges).padEnd(10),
      `${r.protectedDataAtoms}/${r.dataAtoms}`.padEnd(10),
    ].join(''))
  }

  // S41-2 机制非空转
  verdict('S41-2 edges-nonvacuous', totalEdges > 0,
    `真实语料 ${totalAtoms} 原子 / ${totalChars} 字符 → 派生 ${totalEdges} 条推断边（机制在真实数据上非空转）`)

  // S41-3 校准：停词阈在真实语料上的命中数
  console.log(`[INFO S41-3] 停词阈（15% DF）在真实语料上的命中：${totalStopHits} 个 token`
    + `（各 session maxDF = ${rows.map(r => r.maxDf).join('/')}）`)
  if (totalStopHits === 0) {
    finding('F41-1', 'MEDIUM',
      `15% 停词阈**在真实语料上从不触发**（4 个 session 全为 0 命中；最大 DF 仅 ${Math.max(...rows.map(r => r.maxDf))}，`
      + `而阈值为该 session 原子数的 15%）。含义：① 该守卫防的是"全局公共标识"这一**真实语料不出现的失效模式**；`
      + `② spike38 的 S38-5 用 30% DF 样板 token 验收该守卫——该场景是按需构造的，不能代表生产；`
      + `③ 真实的判别难题见 F41-2（弱支撑），而**全局 DF 守卫结构上触及不到它**。`)
  }

  // S41-4 支撑强度与影响半径
  const singleShare = totalEdges === 0 ? 0 : totalSingle / totalEdges
  const protectShare = totalData === 0 ? 0 : totalProtected / totalData
  console.log(`[INFO S41-4] 支撑强度：${totalSingle}/${totalEdges} = ${(singleShare * 100).toFixed(1)}% 的边仅由**单个**稀有 token 支撑；`
    + `影响半径：${totalProtected}/${totalData} = ${(protectShare * 100).toFixed(1)}% 的数据原子被推断边保护`)
  if (singleShare > 0.5) {
    finding('F41-2', 'MEDIUM',
      `真实语料上 ${(singleShare * 100).toFixed(1)}% 的推断边只由**一个** token 支撑（合成语料 spike40 的 m/(2+m) 曲线是理想化下界）。`
      + `⚠️ 措辞校正：单 token 支撑是**真引用与巧合提及的共同形态**——A 说"修 src/db/pool.ts 第 88 行"，对应的 R 就只共用那个路径 token。`
      + `所以本项度量的是**信号判别力弱**（无法区分二者），**不是**"误连率更高"；真实误连率仍需标注才能测。`
      + `连带校正：先前提议的"≥k 独立 token 才建边"会**误杀真引用**（最常见的真引用就是单文件/单定位），不是对症修法。`) 
  }

  const elapsed = Date.now() - t0
  const report = {
    meta: {
      runAt: new Date().toISOString(),
      durationMs: elapsed,
      llmCalls: 0,
      root,
      privacy: '仅聚合量；不含任何 session 原文',
      mode: 'real-corpus-calibration',
    },
    sessions: rows.map(r => ({ id: r.id, cwdSlug: r.cwdSlug, atoms: r.atoms, u: r.u, a: r.a, r: r.r, chars: r.chars, turns: r.turns, uniqueTokens: r.uniqueTokens, maxDf: r.maxDf, stopwordHits: r.stopwordHits, edges: r.edges, singleTokenEdges: r.singleTokenEdges, protectedDataAtoms: r.protectedDataAtoms, dataAtoms: r.dataAtoms })),
    aggregate: {
      sessions: corpus.length, atoms: totalAtoms, chars: totalChars, edges: totalEdges,
      singleTokenShare: singleShare, protectedShare: protectShare, stopwordHits: totalStopHits,
    },
    findings,
    verdicts: failures.length === 0 ? 'ALL PASS' : failures,
  }
  const outFile = path.join(outDir, '41-real-corpus-' + stamp + '.json')
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2))
  console.log(`\n产物：${outFile}`)
  if (failures.length > 0) {
    console.error('\n=== FAILURES ===')
    for (const f of failures) console.error('  ' + f)
    process.exitCode = 1
  } else {
    console.log('\n=== ALL PASS（真实语料校准完成，结论见 FINDING）===')
  }
}

main()
