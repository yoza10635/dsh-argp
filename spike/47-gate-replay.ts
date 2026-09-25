#!/usr/bin/env node
/**
 * spike 47 — A0 闸级判别器（gate-replay）。
 *
 * ## 为什么需要它
 *
 * "321 条 A 到底是被 A10 挡的，还是走闭包路径被剪的"这类问题，此前只能靠
 * `ARGP_DEBUG_PASS=1` 重放判定——而**仓库里没有可重放存档的 harness**
 * （`spike/43-corpus-audit.ts` 是纯静态审计，不驱动引擎）。B3（C/E）改完若测不出
 * 效果，只会污染变量。本脚本补上这条路：**用真实导出函数**重放某个 session 存档的
 * 剪枝选择过程。
 *
 * ## 铁律：不复刻闸逻辑，只复刻"状态推导"
 *
 * - **闸判定**调用真实导出函数 `isAtomCandidate` / `isGroupCandidate` / `sortKey`
 *   （`src/prune-selection.ts`）。（1.7.0 的 `tomb-audit.mjs` 是另一件事：它只做静态
 *   统计，不驱动引擎。）
 * - **状态推导**（`position`/`recencyCut`/`eff`/`askCoverage`/`aGroupChars`…）必须复刻
 *   `compactIfNeeded`（`src/argp-graph-engine.ts:1356-1450`）——它散落在方法体里、没有
 *   可复用的纯函数入口。每段都标了源行号，改引擎时须同步。
 * - **"首个拦截闸"**用短表达式复算（只为**解释**结论），并与真实函数的返回**交叉校验**；
 *   二者不一致时脚本打印 `[MISMATCH]` 并计入失败——不一致即意味着本脚本的状态推导
 *   与引擎漂移了，此时**不要相信它的解释**。
 * - **surface 折叠**绝不自己写：用宿主权威 `foldSurface`（历史教训：自写重放把 881
 *   节点算成 682）。
 *
 * ## 硬门槛：先自验收，再谈结论
 *
 * 脚本必须在目标 session 上复现三组已知量，否则输出不可信（"核验工具先验收"）：
 *   ① 原始 append 节点 941 / 被剪 476（R 437 / A 34 / U 4 / system 1）
 *   ② 原始 A 422 / 被剪 34
 *   ③ 末态 R 墓碑 364 / 孤儿 0
 * 基准会话：一个本地会话存档（数字来自宿主同源口径，会话存档本身不进仓库）。
 * 传 `--strict` 时任一不符即 exit 1。
 *
 * ## 用法
 *
 * ```bash
 * npm run gate-replay -- <session.v4.jsonl.zstd>
 * npm run gate-replay -- <session.v4.jsonl.zstd> --recency-guard=10 --turn-guard=1 --strict
 * ```
 *
 * 输入可以是**未解压**的 `session.vN.jsonl.zstd`（多帧 zstd：本脚本用
 * `loadSessionEvents` 按 magic 扫帧逐帧解，Node 的 `zstdDecompressSync` 单调用只解
 * 第一帧、必踩），也可以是已解压的明文 JSONL。
 *
 * 宿主模块路径可用 `DSH_PROFILE_NODE_MODULES` 覆盖（默认 `~/.dsh/profiles/node_modules`）。
 *
 * ⚠️ 隐私：只读。只打印聚合量与诊断标签，不打印 session 原文。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'
import type { Session } from '@deepseek-ai/dsh-session'
import { EDGE_WEIGHTS } from '../src/argp-types.ts'
import type { Atom } from '../src/argp-types.ts'
import { atomize, buildGraph, findVersionDuplicates, looksAskText, type GraphBuildHost } from '../src/graph-build.ts'
import { isAtomCandidate, isGroupCandidate, sortKey, compareSortKeys, type PruneState } from '../src/prune-selection.ts'
import { TOMBSTONE_MAX_CHARS, isTombstoneText } from '../src/tombstone-text.ts'
import { DEFAULT_MAX_PASSES } from '../src/constants.ts'
import { loadSessionEvents, type RawSessionEvent } from './lib/session-corpus.ts'

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2)
const file = argv.find(a => !a.startsWith('--'))
if (file === undefined) {
  console.error('usage: npm run gate-replay -- <session.v4.jsonl.zstd|session.jsonl> [--recency-guard=N] [--turn-guard=N] [--retain-ratio=R] [--strict]')
  process.exit(2)
}
const numArg = (name: string, fallback: number): number => {
  const raw = argv.find(a => a.startsWith('--' + name + '='))
  if (raw === undefined) return fallback
  const v = Number(raw.slice(name.length + 3))
  return Number.isFinite(v) ? v : fallback
}
const hasFlag = (name: string): boolean => argv.includes('--' + name)

/** 引擎默认（`session-lifecycle.normalizeConfig` + `ArgpGraphEngine.Config`）。 */
const recencyGuard = numArg('recency-guard', 4)
const turnGuard = numArg('turn-guard', 1)
const retainRatio = numArg('retain-ratio', 0.2)
const SORT_MODE: PruneState['sortMode'] = 'density'
const CHARS_PER_TOKEN = 3.5
const MIN_SPAN_CHARS = 0
const STRICT = hasFlag('strict')

const K = (c: number): string => (c * 0.385 / 1000).toFixed(1)
const pct = (a: number, b: number): string => (100 * a / Math.max(1, b)).toFixed(1)

// ---------------------------------------------------------------------------
// 载入（多帧 zstd 由 loadSessionEvents 处理；明文 JSONL 亦兼容）
// ---------------------------------------------------------------------------
const isZstd = /\.zstd$/i.test(file)
const loaded = loadSessionEvents(file)
const events = loaded.events as RawSessionEvent[]
const stats = loaded.stats
console.log('=== A0 gate-replay ===')
console.log('file: ' + file + (isZstd ? ' (multi-frame zstd)' : ' (plain jsonl)'))
console.log('events = ' + events.length + ' | frames = ' + stats.frames + ' | badFrames = ' + stats.badFrames
  + ' | seqGaps = ' + stats.seqGaps + ' | seqDups = ' + stats.seqDups)
if (stats.badFrames > 0 || stats.seqGaps > 0 || stats.seqDups > 0) {
  console.log('[WARN] 存档完整性异常（badFrames/seqGaps/seqDups 非 0）⇒ 下面的 seq↔下标对齐假设可能不成立')
}
if (events.length === 0) {
  console.error('[FAIL] no events loaded')
  process.exit(1)
}

/** 按 seq 索引的事件数组（`eventText`/`sessionEvents` 用 `[seq]` 取值 ⇒ 下标必须 == seq）。 */
const bySeq: (RawSessionEvent | undefined)[] = []
for (const ev of events) bySeq[ev.seq] = ev
const at = (seq: number): RawSessionEvent | undefined => bySeq[seq]

// 宿主权威 surface 折叠
const NM = process.env['DSH_PROFILE_NODE_MODULES'] ?? path.join(homedir(), '.dsh', 'profiles', 'node_modules')
const surfacePath = path.join(NM, '@deepseek-ai', 'dsh-session', 'lib', 'types', 'surface.js')
if (!fs.existsSync(surfacePath)) {
  console.error('[FAIL] 宿主 foldSurface 未找到: ' + surfacePath + '\n       用 DSH_PROFILE_NODE_MODULES 指向别处')
  process.exit(1)
}
const { foldSurface } = await import(pathToFileURL(surfacePath).href) as {
  foldSurface: (events: readonly RawSessionEvent[]) => { nodes: number[]; replacements: { seqs?: number[] }[] }
}
const fold = foldSurface(events)
const liveSet = new Set<number>(fold.nodes)
console.log('surface nodes (末态) = ' + fold.nodes.length + ' | replacements = ' + fold.replacements.length)

const fakeSession = {
  snapshotEvents: () => bySeq,
  surface: { nodes: fold.nodes },
  seq: bySeq.length,
} as unknown as Session

// ---------------------------------------------------------------------------
// ① 自验收：三项已知量（硬门槛）
// ---------------------------------------------------------------------------
const SURFACE_TYPES = new Set(['user/message', 'assistant/message', 'tool/result', 'system/message'])
const isAppend = (ev: RawSessionEvent): boolean => {
  const op = ev.surfaceOp
  if (op === undefined || op === null) return true
  if (op === 'append') return true
  return typeof op === 'object' && (op as { op?: string }).op === 'append'
}
/** 事件正文字本（与 `log-access.eventTextOf` 同口径：只认 text / tool-call / tool-result 内层 text）。 */
const textOf = (ev: RawSessionEvent | undefined): string => {
  if (ev === undefined) return ''
  const d = (ev.data ?? {}) as { content?: unknown[]; message?: { content?: unknown[] } }
  const blocks = ev.type === 'user/message' ? d.content : d.message?.content
  if (!Array.isArray(blocks)) return ''
  let out = ''
  for (const b of blocks as { type?: string; text?: string; name?: string; arguments?: unknown; content?: { type?: string; text?: string }[] }[]) {
    if (b?.type === 'text' && typeof b.text === 'string') out += b.text
    if (b?.type === 'tool-call') out += '[tool-call ' + (b.name ?? '?') + '(' + (typeof b.arguments === 'string' ? b.arguments : JSON.stringify(b.arguments ?? {})) + ')]'
    if (b?.type === 'tool-result') for (const ib of b.content ?? []) if (ib?.type === 'text' && typeof ib.text === 'string') out += ib.text
  }
  return out
}
const blocksOf = (ev: RawSessionEvent | undefined): { type?: string; id?: string; callId?: string; name?: string; arguments?: unknown; text?: string }[] => {
  if (ev === undefined) return []
  const d = (ev.data ?? {}) as { content?: unknown[]; message?: { content?: unknown[] } }
  const blocks = ev.type === 'user/message' ? d.content : d.message?.content
  return Array.isArray(blocks) ? (blocks as never[]) : []
}
const callIdOfR = (ev: RawSessionEvent): string | undefined => {
  const d = ev.data as { message?: { source?: { callId?: string }; toolCallId?: string }; toolCallId?: string } | undefined
  return d?.message?.source?.callId ?? d?.message?.toolCallId ?? d?.toolCallId
}

const appendByType = new Map<string, number>()
const prunedByType = new Map<string, number>()
for (const ev of events) {
  if (!SURFACE_TYPES.has(ev.type)) continue
  if (!isAppend(ev)) continue
  appendByType.set(ev.type, (appendByType.get(ev.type) ?? 0) + 1)
  if (!liveSet.has(ev.seq)) prunedByType.set(ev.type, (prunedByType.get(ev.type) ?? 0) + 1)
}
const sum = (m: Map<string, number>): number => [...m.values()].reduce((a, b) => a + b, 0)
const appendTotal = sum(appendByType)
const prunedTotal = sum(prunedByType)

// 末态 R 墓碑 + 孤儿
const issuers = new Set<string>()
for (const seq of fold.nodes) {
  const ev = at(seq)
  if (ev === undefined) continue
  for (const b of blocksOf(ev)) {
    if (b.type === 'tool-call') {
      const id = b.id ?? b.callId
      if (typeof id === 'string') issuers.add(id)
    }
  }
}
let rTomb = 0
let rOrphan = 0
for (const seq of fold.nodes) {
  const ev = at(seq)
  if (ev?.type !== 'tool/result') continue
  if (!textOf(ev).includes('[elided')) continue
  rTomb += 1
  const cid = callIdOfR(ev)
  if (cid === undefined || !issuers.has(cid)) rOrphan += 1
}

console.log('\n--- ① 自验收（硬门槛）---')
const checks: [string, boolean, string][] = [
  ['原始 append 节点 = 941', appendTotal === 941, String(appendTotal)],
  ['被剪原始节点 = 476', prunedTotal === 476, String(prunedTotal)],
  ['原始 A = 422', (appendByType.get('assistant/message') ?? 0) === 422, String(appendByType.get('assistant/message') ?? 0)],
  ['被剪原始 A = 34', (prunedByType.get('assistant/message') ?? 0) === 34, String(prunedByType.get('assistant/message') ?? 0)],
  ['末态 R 墓碑 = 364', rTomb === 364, String(rTomb)],
  ['R 墓碑孤儿 = 0', rOrphan === 0, String(rOrphan)],
]
for (const [name, ok, got] of checks) console.log('[' + (ok ? 'PASS' : 'FAIL') + '] ' + name + (ok ? '' : '  ← got ' + got))
console.log('  （基准 = 最初的定基会话；其他 session 上 FAIL 属正常，只表示"这组数字不适用"）')
console.log('  append 分布: ' + JSON.stringify([...appendByType.entries()]))
console.log('  被剪分布:   ' + JSON.stringify([...prunedByType.entries()]))

// ---------------------------------------------------------------------------
// ② 建图（调用真实 atomize / buildGraph / findVersionDuplicates）
// ---------------------------------------------------------------------------
const host: GraphBuildHost = {
  session: fakeSession,
  citeStats: { aAtoms: 0, declared: 0, resolved: 0, ambiguous: 0, failed: 0 },
  citeMinPrefixLen: 4,
  disableCiteEdges: false,
  // ⚠️ 关键：不注入 declarer 边。本存档的声明边（CiteRecord）从不落盘，事后不可取证
  // ⇒ 这正是"声明边缺席"场景，也是 A10 保护永不释放的前提。F1（1.7.1）落地后，
  // 可用 ARGP_CITES_DUMP 的产物补上这一路，再跑本脚本观察 A 的变化。
  injectEdges: undefined,
  disableInferredEdges: false,
  inferredOpts: { minTokenLen: 6, stopwordRatio: 0.15, maxEdgesPerAtom: 8, windowTurns: 20 },
  lastInferredEdges: [],
  inferredStats: { candidates: 0, accepted: 0, skippedDup: 0 },
  lastEdges: [],
  lastDeterministicEdges: [],
  enableOverlapChain: false,
  overlapTheta: 0.8,
}
const atoms = atomize(host, fakeSession)
const { edges, deterministicEdges, inDegree } = buildGraph(host, atoms)
const { dupIds, chainLen } = findVersionDuplicates(host, atoms, inDegree)
const inferred = host.lastInferredEdges.length
const citesEdges = edges.length - inferred

console.log('\n--- ② 建图 ---')
console.log('atoms(末态 surface) = ' + atoms.length + '  ' + JSON.stringify(
  ['U', 'A', 'R', 'X'].map(t => [t, atoms.filter(a => a.type === t).length]),
))
console.log('edges = ' + edges.length + ' (cites ' + citesEdges + ' + inferred ' + inferred + ') | deterministic = ' + deterministicEdges.length)
console.log('推断候选 = ' + host.inferredStats.candidates + '（accept ' + host.inferredStats.accepted + ' / dup ' + host.inferredStats.skippedDup + '）')
console.log('cites 统计: A 原子 ' + host.citeStats.aAtoms + ' / declared ' + host.citeStats.declared + ' / resolved ' + host.citeStats.resolved + ' / ambiguous ' + host.citeStats.ambiguous + ' / failed ' + host.citeStats.failed)
if (citesEdges === 0) {
  console.log('  ⚠️ 语义边全部来自推断通道 ⇒ 声明边缺席。A10 的解锁输入（curInDegreeDecl）恒 0。')
}
console.log('版本链去重 = ' + dupIds.size + ' 个原子')

// ---------------------------------------------------------------------------
// ③ PruneState 推导（复刻 compactIfNeeded；每段标源行号）
// ---------------------------------------------------------------------------
const surfaceSeqs = [...fold.nodes]
const position = new Map<number, number>(surfaceSeqs.map((seq, i) => [seq, i]))
const recencyCut = Math.max(0, surfaceSeqs.length - recencyGuard)          // engine:1358
const latestTurn = atoms.reduce((m, a) => Math.max(m, a.turn), 0)          // engine:1359
const selfImportance = (a: Atom): number => (a.type === 'A' ? 5 : (a.type === 'U' && a.sourceSeq === undefined ? 3 : 0)) // engine:1361
const eff = new Map<number, number>(atoms.map(a => [a.id, selfImportance(a)])) // engine:1362
for (const e of edges) eff.set(e.to, Math.max(eff.get(e.to) ?? 0, EDGE_WEIGHTS[e.level])) // engine:1363
const lastRef = new Map<number, number>()                                  // engine:1376-1380
for (const e of edges) {
  const from = atoms[e.from]
  if (from !== undefined) lastRef.set(e.to, Math.max(lastRef.get(e.to) ?? 0, from.turn))
}
const touchesSemantic = new Set<number>(edges.flatMap(e => [e.from, e.to])) // engine:1381
const askCoverage = new Map<number, number>()                              // engine:1383-1395
for (const u of atoms.filter(a => a.type === 'U')) {
  if (!looksAskText(u.text)) continue
  const firstA = atoms.filter(a => a.type === 'A' && a.turn >= u.turn && a.seq > u.seq).sort((a, b) => a.seq - b.seq)[0]
  if (firstA !== undefined && edges.some(e => e.from === firstA.id && e.to === u.id)) askCoverage.set(u.id, firstA.id)
}
const rByCallForPrune = new Map<string, Atom>()                            // engine:1405-1406
for (const r of atoms) if (r.type === 'R' && r.toolCallIds[0] !== undefined) rByCallForPrune.set(r.toolCallIds[0], r)
const aGroupChars = new Map<number, number>()                              // engine:1410-1419
for (const a of atoms) {
  if (a.type !== 'A' || a.toolCallIds.length === 0) continue
  let total = a.text.length
  for (const cid of a.toolCallIds) {
    const r = rByCallForPrune.get(cid)
    if (r !== undefined) total += r.text.length
  }
  aGroupChars.set(a.id, total)
}
const groups: Atom[][] = atoms.map(a => [a])                               // engine:1420-1427（每原子单元素组）

const pruneState: PruneState = {
  turnGuard,
  askCoverage,
  position,
  recencyCut,
  latestTurn,
  edges,
  atoms,
  curInDegree: inDegree,
  curInDegreeDecl: new Map<number, number>(
    [...inDegree].filter(([id]) => {
      // 初值 = 只数非 inferred 入边（engine:1473-1479 的 pass 0 等价式）
      return edges.some(e => e.to === id && e.level !== 'inferred')
    }),
  ),
  deterministicEdges,
  touchesSemantic,
  eff,
  sortMode: SORT_MODE,
  chainLen,
  lastRef,
  charsPerToken: CHARS_PER_TOKEN,
  aGroupChars,
}
console.log('\n--- ③ 参数 ---')
console.log('recencyGuard=' + recencyGuard + ' turnGuard=' + turnGuard + ' minSpanChars=' + MIN_SPAN_CHARS
  + ' sortMode=' + SORT_MODE + ' maxPasses=' + DEFAULT_MAX_PASSES + ' retainRatio=' + retainRatio)
console.log('⚠️ 守卫值按 CLI 取值；真实会话的 patch 若覆盖过（如 recencyGuard=10），请显式传 --recency-guard=N 复现')

// ---------------------------------------------------------------------------
// ④ 闸级分类（真实函数判定 + 短式复算解释，交叉校验）
// ---------------------------------------------------------------------------
/**
 * "首个拦截闸"复算——**只用于解释**，权威结论一律以 `isAtomCandidate` 为准。
 * 逐条对应 `src/prune-selection.ts:isAtomCandidate` 的判定顺序。
 */
function firstGate(a: Atom, st: PruneState, allowInDegree: boolean): string {
  if (a.type === 'U' && a.sourceSeq === undefined) {
    const coverer = st.askCoverage.get(a.id)
    if (coverer === undefined) return 'ask-exempt-no-cover'
    const pos = st.position.get(a.seq)
    if (pos === undefined || pos >= st.recencyCut) return 'position-guard'
    if (a.turn > st.latestTurn - st.turnGuard) return 'turn-guard'
    const incoming = st.edges.filter(e => e.to === a.id)
    if (incoming.length === 0 || incoming.some(e => e.from !== coverer)) return 'ask-exempt-cover-lost'
    return 'pass'
  }
  if (a.type !== 'A' && a.type !== 'R' && a.type !== 'U') return 'type-not-eligible'
  if (isTombstoneText(a.text) && a.text.length <= TOMBSTONE_MAX_CHARS) return 'tombstone-terminal'
  const pos = st.position.get(a.seq)
  if (pos === undefined || pos >= st.recencyCut) return 'position-guard'
  if (a.turn > st.latestTurn - st.turnGuard) return 'turn-guard'
  if (a.citesFailed) return 'cites-failed'
  if (a.type === 'A' && a.toolCallIds.length > 0) {
    const groupIds = new Set<number>([a.id])
    const groupRs = st.atoms.filter(x => x.type === 'R' && a.toolCallIds.includes(x.toolCallIds[0] ?? ''))
    for (const r of groupRs) groupIds.add(r.id)
    if (groupRs.length > 0) {
      // C（B3）：组内 R 全立碑 ⇒ 放行。**本分支必须与 `src/prune-selection.ts` 的 A10 块逐字对应**——
      // 本函数是 `isAtomCandidate` 的重写副本（④ 段需要"首个拦截闸"的归因，单个布尔给不出来），
      // 漏同步即触发下方一致性校验（实测：C 落地后忘改本处 ⇒ 312 例不一致）。
      const allStubbed = groupRs.every(r => isTombstoneText(r.text))
      if (!allStubbed) {
        const aCitesR = st.edges.some(e => e.from === a.id && groupRs.some(r => e.to === r.id))
        const anyRExternalIncoming = groupRs.some(r =>
          (st.curInDegreeDecl.get(r.id) ?? 0) > 0
          || st.deterministicEdges.some(e => e.to === r.id && !groupIds.has(e.from)))
        if (!aCitesR && !anyRExternalIncoming) return 'a10-structural'
      }
    }
  }
  if (!allowInDegree && (st.curInDegree.get(a.id) ?? 0) > 0) return 'in-degree'
  return 'pass'
}

const gateTally = new Map<string, Map<string, number>>() // type -> gate -> count
let mismatches = 0
const candCharsByType = new Map<string, number>()
for (const a of atoms) {
  const real = isAtomCandidate(a, false, pruneState)
  const label = firstGate(a, pruneState, false)
  const byReal = label === 'pass'
  if (real !== byReal) {
    mismatches += 1
    if (mismatches <= 5) console.log('[MISMATCH] seq=' + a.seq + ' ' + a.type + ' real=' + real + ' label=' + label)
  }
  const per = gateTally.get(a.type) ?? new Map<string, number>()
  per.set(label, (per.get(label) ?? 0) + 1)
  gateTally.set(a.type, per)
  if (real) candCharsByType.set(a.type, (candCharsByType.get(a.type) ?? 0) + a.text.length)
}
console.log('\n--- ④ 闸级分类（末态活体原子，allowInDegree=false）---')
for (const type of ['A', 'R', 'U', 'X']) {
  const per = gateTally.get(type)
  if (per === undefined) continue
  const total = [...per.values()].reduce((a, b) => a + b, 0)
  const sorted = [...per.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => k + '=' + v).join(' ')
  console.log('  ' + type + ' 共 ' + total + '：' + sorted)
}
console.log('  一致性校验：isAtomCandidate 与首个拦截闸复算不一致 = ' + mismatches + (mismatches === 0 ? ' ✅' : ' ❌ 本脚本状态推导已与引擎漂移，勿采信解释'))
for (const [type, chars] of candCharsByType) console.log('  可剪面(' + type + ') 可见字符 = ' + chars + ' (≈' + K(chars) + 'K tok)')

// ---------------------------------------------------------------------------
// ⑤ A10 锁定面 + C 收益预估
// ---------------------------------------------------------------------------
let a10Total = 0
let a10AllStub = 0
let a10AllStubSelfChars = 0
let a10AllStubGroupChars = 0
let a10SomeLive = 0
let a10NoGroup = 0
let a10PureText = 0
for (const a of atoms.filter(x => x.type === 'A')) {
  if (a.toolCallIds.length === 0) { a10PureText += 1; continue }
  a10Total += 1
  const groupRs = atoms.filter(x => x.type === 'R' && a.toolCallIds.includes(x.toolCallIds[0] ?? ''))
  if (groupRs.length === 0) { a10NoGroup += 1; continue }
  const allStubbed = groupRs.every(r => isTombstoneText(r.text))
  if (allStubbed) {
    a10AllStub += 1
    a10AllStubSelfChars += a.text.length
    a10AllStubGroupChars += a.text.length + groupRs.reduce((s, r) => s + r.text.length, 0)
  } else a10SomeLive += 1
}
const liveAToolArgs = atoms.filter(a => a.type === 'A').reduce((s, a) => s
  + blocksOf(at(a.seq)).filter(b => b.type === 'tool-call').reduce((t, b) => t
    + (typeof b.arguments === 'string' ? b.arguments.length : JSON.stringify(b.arguments ?? {}).length), 0), 0)
console.log('\n--- ⑤ C 的释放面（末态；C 已落地后即为"已放行面"）---')
console.log('带 tool-call 的活体 A = ' + a10Total + ' | 纯文本 A = ' + a10PureText)
console.log('  R 组全墓碑（C 的靶子）= ' + a10AllStub
  + '   ← C 之前这些被 A10 结构保护锁死；C 起改判为可参剪')
console.log('    A 自身可见字符 = ' + a10AllStubSelfChars + ' (≈' + K(a10AllStubSelfChars) + 'K tok)')
console.log('    A + 其 R 组墓碑字符 = ' + a10AllStubGroupChars + ' (≈' + K(a10AllStubGroupChars) + 'K tok)')
console.log('  R 组含非墓碑（A10 仍保护该组，R 尚可继续剪）= ' + a10SomeLive)
console.log('  R 组为空（A10 不适用）= ' + a10NoGroup)
console.log('  活体 A 的 tool-call 参数总量 = ' + liveAToolArgs + ' 字符 (≈' + K(liveAToolArgs) + 'K tok)')
console.log('  ⇒ 毛释放 ≈ ' + K(a10AllStubGroupChars) + 'K tok'
  + '（其中 A 自身 ' + K(a10AllStubSelfChars) + 'K、余为已墓碑化的 R 组）'
  + '；净释放（扣新增区间墓碑）见 docs/plan-compaction-fixes §7.6 = 243,992 字符 ≈ 93.9K tok')

// ---------------------------------------------------------------------------
// ⑥ G1 效果预估（1.7.0 会重复入候选的墓碑面）
// ---------------------------------------------------------------------------
let g1Eligible = 0
let g1EligibleChars = 0
let g1OverCap = 0
for (const a of atoms) {
  if (a.type !== 'A' && a.type !== 'R' && a.type !== 'U') continue
  if (!isTombstoneText(a.text)) continue
  if (a.text.length <= TOMBSTONE_MAX_CHARS) { g1Eligible += 1; g1EligibleChars += a.text.length } else g1OverCap += 1
}
console.log('\n--- ⑥ G1 终止态排除面 ---')
console.log('已是墓碑、长度 ≤ ' + TOMBSTONE_MAX_CHARS + '（1.7.0 会每轮重复入候选的空转来源）= ' + g1Eligible
  + ' 个 / ' + g1EligibleChars + ' 字符')
console.log('超上限放行的长墓碑 = ' + g1OverCap + '（安全阀）')
console.log('  ⇒ 1.7.1 起这些节点不再参剪；地板仍由 consolidateTombstones（事件层）压下去')

// ---------------------------------------------------------------------------
// ⑦ 模拟贪心（正常候选 + force；**不含闭包路径**）
// ---------------------------------------------------------------------------
const duplicateIds = dupIds
const pruned = new Map<number, Atom>()
for (const id of duplicateIds) {
  const a = atoms.find(x => x.id === id)
  if (a !== undefined) pruned.set(id, a)
}
const initialVisible = atoms.reduce((s, a) => s + a.text.length, 0)
const retainChars = Math.floor(initialVisible * retainRatio)
let forced = false
let passes = 0
let stopped: string = 'maxPasses'
let prevSize = pruned.size
for (let pass = 0; pass < DEFAULT_MAX_PASSES; pass += 1) {
  passes = pass + 1
  if (pass > 0 && pruned.size === prevSize) { stopped = 'no-progress'; break }
  prevSize = pruned.size
  const cur = new Map<number, number>()
  const curDecl = new Map<number, number>()
  for (const e of edges) {
    if (pruned.has(e.from)) continue
    cur.set(e.to, (cur.get(e.to) ?? 0) + 1)
    if (e.level !== 'inferred') curDecl.set(e.to, (curDecl.get(e.to) ?? 0) + 1)
  }
  pruneState.curInDegree = cur
  pruneState.curInDegreeDecl = curDecl
  const remaining = atoms.filter(a => !pruned.has(a.id))
  const visible = remaining.reduce((s, a) => s + a.text.length, 0)
  if (visible <= retainChars) { stopped = 'target-reached'; break }
  const liveGroups = groups.filter(g => g.some(a => !pruned.has(a.id)))
  let cand = liveGroups.filter(g => isGroupCandidate(g, false, pruneState))
  if (cand.length === 0) {
    // 降级链：真实引擎这里先走闭包（selectClosureToMerge）再 force；本脚本简化跳过闭包路径
    cand = liveGroups.filter(g => isGroupCandidate(g, true, pruneState))
    if (cand.length === 0) { stopped = 'candidates-exhausted'; break }
    forced = true
  }
  const groupKey = (g: Atom[]): string => g.map(a => sortKey(a, pruneState)).sort()[0] as string
  cand.sort((x, y) => compareSortKeys(groupKey(x), groupKey(y)))
  const top = cand[0] as Atom[]
  for (const a of top) {
    pruned.set(a.id, a)
    if (a.type === 'A' && a.toolCallIds.length > 0) {
      for (const cid of a.toolCallIds) {
        const r = rByCallForPrune.get(cid)
        if (r !== undefined && !pruned.has(r.id)) pruned.set(r.id, r)
      }
    }
  }
}
const prunedChars = [...pruned.values()].reduce((s, a) => s + a.text.length, 0)
const prunedByKind = new Map<string, number>()
for (const a of pruned.values()) prunedByKind.set(a.type, (prunedByKind.get(a.type) ?? 0) + 1)
console.log('\n--- ⑦ 模拟贪心（正常候选 + force；不含闭包路径 ⇒ 结果偏保守）---')
console.log('retainChars 目标 = ' + retainChars + '（initialVisible ' + initialVisible + ' × ' + retainRatio + '）')
console.log('passes = ' + passes + ' | 终止原因 = ' + stopped + ' | forced = ' + forced)
console.log('剪除原子 = ' + pruned.size + ' (' + JSON.stringify([...prunedByKind.entries()]) + ') / ' + prunedChars + ' 字符 (≈' + K(prunedChars) + 'K tok)')
console.log('可见字符 ' + initialVisible + ' → ' + (initialVisible - prunedChars) + ' (降 ' + pct(prunedChars, initialVisible) + '%)')
console.log('⚠️ 真实引擎还会走闭包生命周期（selectClosureToMerge）与 tombstone-merge，故实际剪除量 ≥ 本数')

console.log('\n' + (mismatches === 0 ? '[OK] 闸判定与解释一致' : '[FAIL] 闸判定与解释不一致 = ' + mismatches))
const gateFail = checks.filter(([, ok]) => !ok).length
process.exitCode = (STRICT && (mismatches > 0 || gateFail > 0)) ? 1 : 0
