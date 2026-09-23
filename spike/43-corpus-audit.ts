/**
 * spike 43 — 受控语料自检（受控语料跑批规格书的配套审计；该规格书为本地内部文档，不随包发布）
 *
 * 跑完一份受控 session 后立刻判定：**这份语料能支撑哪些测量、不能支撑哪些**。
 * 不给"大概行"——逐条硬判，不过就不要拿它下结论。
 *
 * 四组审计：
 *   ① 结构验收     turns / atoms / chars / compaction 次数 / prune 次数与去重 seq 数
 *   ② 场景有效性   cites 声明数（空窗场景）、跨轮 handle 数、承重 token 密度、推断边数
 *   ③ 驱逐代价     **prune-then-reread**：内容被驱逐后同一路径是否被再次 read/grep
 *                  （非循环的操作性信号，不依赖人工标注）
 *   ④ 组件 B 生产线观测  替换副本里的 `[restored]` 尾注 → 逐例复算 ROI，
 *                  统计"门控 θ=1 会拦下多少"（I-B5 的真实数据校验）
 *
 * 用法：
 *   npm run spike43                              # 审最新 session
 *   npm run spike43 -- <session.v3.jsonl.zstd>   # 审指定 session
 *
 * ⚠️ 隐私：只读；报告只写**聚合量**到 gitignored 的 spike/out/。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { deriveInferredEdges, findLoadBearingTokens, hlsRepairEconomics, type OntologyAtom } from '../src/token-ontology.ts'
import { defaultSessionRoot, loadPlainJsonl, loadSessionEvents, atomsFromEvents, type RawSessionEvent } from './lib/session-corpus.ts'

const outDir = path.join(import.meta.dirname, 'out')
const RESTORED_MARK = '\n[restored] '
const TYPE_MAP: Record<string, string> = { 'user/message': 'U', 'assistant/message': 'A', 'tool/result': 'R' }

const failures: string[] = []
const verdict = (name: string, ok: boolean, detail: string): void => {
  console.log((ok ? '[PASS ' : '[FAIL ') + name + '] ' + detail)
  if (!ok) failures.push(name)
}
const info = (name: string, detail: string): void => console.log(`[INFO ${name}] ${detail}`)

/** 取事件的正文字本（三种信封形状）。 */
function bodyOf(ev: RawSessionEvent): string {
  const d = ev.data as { content?: unknown; message?: { content?: unknown } }
  const grab = (blocks: unknown): string[] => {
    if (!Array.isArray(blocks)) return []
    const out: string[] = []
    for (const b of blocks) {
      if (b === null || typeof b !== 'object') continue
      const bb = b as { type?: string; text?: string; content?: unknown }
      if (bb.type === 'text' && typeof bb.text === 'string') out.push(bb.text)
      else if (bb.type === 'tool-result') out.push(...grab(bb.content))
    }
    return out
  }
  if (ev.type === 'user/message') return grab(d.content).join('')
  return grab(d.message?.content).join('')
}

/** 工具调用参数里的目标路径/模式（read 的 file_path、grep 的 path+pattern）。 */
function targetOf(name: string, args: unknown): string | null {
  if (typeof args !== 'string' || !args.trim().startsWith('{')) return null
  try {
    const o = JSON.parse(args) as Record<string, unknown>
    if (name === 'read') return typeof o['file_path'] === 'string' ? o['file_path'] : null
    if (name === 'grep' || name === 'glob') {
      const p = typeof o['path'] === 'string' ? o['path'] : ''
      const q = typeof o['pattern'] === 'string' ? o['pattern'] : ''
      return (p + '\u0000' + q).trim() === '' ? null : `grep:${p}:${q}`
    }
    return null
  } catch { return null }
}

interface SessionAudit {
  file: string
  turns: number
  atoms: number
  dataAtoms: number
  chars: number
  compactionStarts: number
  pruneEvents: number
  prunedSeqs: number
  replaces: number
  assistantAppends: number
  cites: number
  crossTurnHandles: number
  toolResultWithTokens: number
  bigToolResults: number
  edges: number
  singleTokenEdges: number
  pruneThenReread: number
  prunedSeqsReread: number
  prunedPaths: number
  hlsRepairs: number
  hlsFalsePositive: number
  hlsRoi: number[]
  hlsGateWouldBlock: number
}

function auditSession(file: string): SessionAudit {
  // 两种输入：真实 session（多帧 zstd 容器）与受控跑批 harness 产物（普通 JSONL）。
  const { events } = file.endsWith('.jsonl') ? loadPlainJsonl(file) : loadSessionEvents(file)
  const atoms: OntologyAtom[] = atomsFromEvents(events)

  // ---- ① 结构 ----
  const turnSet = new Set<number>()
  let compactionStarts = 0
  let pruneEvents = 0
  const prunedSeqSet = new Set<number>()
  let replaces = 0
  for (const e of events) {
    if (e.type === 'turn/start') turnSet.add(Number((e.data as { turn?: number }).turn ?? -1))
    if (e.type === 'compaction/start') compactionStarts += 1
    if (e.type === 'compaction/prune') {
      pruneEvents += 1
      const ss = (e.data as { shadowedSeqs?: unknown }).shadowedSeqs
      if (Array.isArray(ss)) for (const x of ss) if (typeof x === 'number') prunedSeqSet.add(x)
    }
    const so = e.surfaceOp
    if (so !== null && typeof so === 'object' && (so as { op?: string }).op === 'replace') replaces += 1
  }

  // ---- ② 场景有效性 ----
  // cites 声明：**只数 append 原始写入的 assistant 正文**。三个易错点（实测踩过）：
  //   ① replace 副本同样带正文 → 会把同一条声明重复计入（本例虚增到 28）；
  //   ② `system/message` 里的工具 schema 说明含 `"cites":` 字样（本例 3 次）→ 非模型声明；
  //   ③ 只看 assistant/message，不要扫全日志。
  let cites = 0
  let assistantAppends = 0
  for (const e of events) {
    if (e.type !== 'assistant/message') continue
    if (e.surfaceOp !== 'append') continue
    assistantAppends += 1
    cites += (bodyOf(e).match(/"cites"\s*:/g) ?? []).length
  }
  const tokensBySeq = new Map<number, string[]>()
  const tokenTurns = new Map<string, Set<number>>()
  for (const a of atoms) {
    const tk = findLoadBearingTokens(a.text)
    tokensBySeq.set(a.seq, tk)
    for (const t of new Set(tk)) {
      const set = tokenTurns.get(t) ?? new Set<number>()
      set.add(a.turn)
      tokenTurns.set(t, set)
    }
  }
  let crossTurnHandles = 0
  for (const [, turns] of tokenTurns) if (turns.size >= 2) crossTurnHandles += 1
  const toolAtoms = atoms.filter(a => a.type === 'R')
  const toolResultWithTokens = toolAtoms.filter(a => findLoadBearingTokens(a.text).length > 0).length
  const bigToolResults = toolAtoms.filter(a => a.text.length >= 512).length

  const df = new Map<string, number>()
  for (const a of atoms) for (const t of new Set(tokensBySeq.get(a.seq) ?? [])) df.set(t, (df.get(t) ?? 0) + 1)
  const n = Math.max(atoms.length, 1)
  const stop = new Set([...df.entries()].filter(([, v]) => v / n > 0.15).map(([t]) => t))
  const bySeq = new Map(atoms.map(a => [a.seq, a]))
  const edges = deriveInferredEdges(atoms)
  let singleTokenEdges = 0
  for (const e of edges) {
    const from = bySeq.get(e.fromSeq)
    const to = bySeq.get(e.toSeq)
    if (from === undefined || to === undefined) continue
    const toToks = new Set(tokensBySeq.get(e.toSeq) ?? [])
    const shared = new Set((tokensBySeq.get(e.fromSeq) ?? []).filter(t => t.length >= 6 && !stop.has(t) && toToks.has(t)))
    if (shared.size === 1) singleTokenEdges += 1
  }

  // ---- ③ 驱逐代价：prune-then-reread ----
  // tool/call(callId, name, arguments) → 目标路径；tool/result(seq) 经 toolCallId 关联到路径
  const callTarget = new Map<string, string>()
  for (const e of events) {
    if (e.type !== 'tool/call') continue
    const d = e.data as { callId?: string; name?: string; arguments?: unknown }
    if (typeof d.callId !== 'string') continue
    const tgt = targetOf(String(d.name ?? ''), d.arguments)
    if (tgt !== null) callTarget.set(d.callId, tgt)
  }
  const pathSeqs = new Map<string, number[]>()
  const seqPath = new Map<number, string>()
  for (const e of events) {
    if (e.type !== 'tool/result') continue
    const d = e.data as { message?: { content?: Array<{ toolCallId?: string }> } }
    const cid = d.message?.content?.[0]?.toolCallId
    if (typeof cid !== 'string') continue
    const tgt = callTarget.get(cid)
    if (tgt === undefined) continue
    seqPath.set(e.seq, tgt)
    const list = pathSeqs.get(tgt) ?? []
    list.push(e.seq)
    pathSeqs.set(tgt, list)
  }
  // 单位必须一致：以**路径**为分母（此前以「被驱逐 seq 数」为分子、路径数为分母 → 出现 153% 的假比例）
  const prunedPaths = new Set<string>()
  for (const s of prunedSeqSet) {
    const tgt = seqPath.get(s)
    if (tgt !== undefined) prunedPaths.add(tgt)
  }
  let pruneThenRereadPaths = 0
  let prunedSeqsReread = 0
  for (const tgt of prunedPaths) {
    const prunedHere = (pathSeqs.get(tgt) ?? []).filter(x => prunedSeqSet.has(x))
    const hit = prunedHere.some(s => (pathSeqs.get(tgt) ?? []).some(x => x > s))
    if (hit) pruneThenRereadPaths += 1
    prunedSeqsReread += prunedHere.filter(s => (pathSeqs.get(tgt) ?? []).some(x => x > s)).length
  }
  const pruneThenReread = pruneThenRereadPaths

  // ---- ④ 组件 B 生产线观测：替换副本里的 `[restored]` 尾注 ----
  //
  // ⚠️ 假阳性陷阱（2026-09-15 实测踩过）：**裸文本搜索 `[restored]` 会全错**。
  //   本机 4 个 session 里裸搜到 41 处，但**真实 HLS 落盘 = 0** —— 41 处全部是
  //   "对话内容里在讨论 HLS 机制本身"（本仓库的 session 读/改的就是 `token-ontology.ts`，
  //   于是 `return candidate + '\n[restored] ' + missing.join(' ')` 这行源码本身出现在日志里）。
  //   正确判据 = I-B3 构造性：repaired = candidate + 尾注，且**尾注 token 逐字 ⊆ 原文承重 token 集**。
  const appendBody = new Map<number, string>()
  for (const e of events) {
    if (e.surfaceOp === 'append' && e.type !== 'compaction/prune') appendBody.set(e.seq, bodyOf(e))
  }
  let hlsRepairs = 0
  let hlsFalsePositive = 0
  let hlsGateWouldBlock = 0
  const hlsRoi: number[] = []
  for (const e of events) {
    const so = e.surfaceOp
    if (so === null || typeof so !== 'object' || (so as { op?: string }).op !== 'replace') continue
    const text = bodyOf(e)
    const idx = text.indexOf(RESTORED_MARK)
    if (idx < 0) continue
    const src = (e as unknown as { sourceEventSeqs?: number[] }).sourceEventSeqs
    const origSeq = Array.isArray(src) && src.length > 0 ? src[0] : undefined
    const orig = origSeq === undefined ? undefined : appendBody.get(origSeq)
    const candidate = text.slice(0, idx)
    const trailerToks = text.slice(idx + RESTORED_MARK.length).split(' ').filter(t => t !== '')
    // I-B3 构造性校验：尾注必须非空、且每个 token 逐字来自原文承重词表；否则判为假阳性
    const origTokens = orig === undefined ? null : new Set(findLoadBearingTokens(orig))
    const isRealRepair = orig !== undefined && trailerToks.length > 0
      && origTokens !== null && trailerToks.every(t => origTokens.has(t))
    if (!isRealRepair) { hlsFalsePositive += 1; continue }
    hlsRepairs += 1
    const econ = hlsRepairEconomics(orig.length, candidate.length, trailerToks)
    hlsRoi.push(econ.roi)
    if (!econ.accept) hlsGateWouldBlock += 1
  }

  return {
    file: path.basename(path.dirname(file)),
    turns: turnSet.size,
    atoms: atoms.length,
    dataAtoms: atoms.filter(a => a.type !== 'A').length,
    chars: atoms.reduce((s, a) => s + a.text.length, 0),
    compactionStarts, pruneEvents, prunedSeqs: prunedSeqSet.size, replaces,
    assistantAppends, cites, crossTurnHandles, toolResultWithTokens, bigToolResults,
    edges: edges.length, singleTokenEdges,
    pruneThenReread: pruneThenRereadPaths, prunedSeqsReread, prunedPaths: prunedPaths.size,
    hlsRepairs, hlsFalsePositive, hlsRoi, hlsGateWouldBlock,
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function newestSession(): string | null {
  const root = defaultSessionRoot()
  if (!fs.existsSync(root)) return null
  let best: { f: string; m: number } | null = null
  for (const slug of fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name)) {
    for (const id of fs.readdirSync(path.join(root, slug))) {
      const f = path.join(root, slug, id, 'session.v3.jsonl.zstd')
      if (!fs.existsSync(f)) continue
      const m = fs.statSync(f).mtimeMs
      if (best === null || m > best.m) best = { f, m }
    }
  }
  return best?.f ?? null
}

function main(): void {
  const arg = process.argv.slice(2)[0]
  const file = arg !== undefined ? path.resolve(arg) : newestSession()
  if (file === null || !fs.existsSync(file)) {
    console.log('[skip] 未找到 session 文件（给路径或先跑一份受控 session）——退出码 0')
    return
  }
  console.log(`[spike43] 受控语料自检（规格：本地跑批规格书，不随包发布）`)
  console.log(`  session: ${path.basename(path.dirname(file))}`)
  const r = auditSession(file)

  console.log(`\n  ① 结构验收`)
  console.log(`     turns=${r.turns}  atoms=${r.atoms}（数据原子 ${r.dataAtoms}）  chars=${r.chars}（≈${Math.round(r.chars / 3.5)} tok）`)
  console.log(`     compaction/start=${r.compactionStarts}  prune 事件=${r.pruneEvents}（去重 seq ${r.prunedSeqs}）  replace=${r.replaces}`)
  verdict('A1 volume', r.chars >= 400_000 && r.atoms >= 150,
    `chars=${r.chars}（≥400000，≈${Math.round(r.chars / 3.5)} tok）/ atoms=${r.atoms}（≥150）`
    + `；turns=${r.turns}（仅记录，不作门槛——量由字符/原子数决定，且空窗轮次少不等于量少）`)
  // 用 prune 事件数而非 compaction/start 数：后者会被 overflow-retry 恢复环抬高
  // （本机实测某 session 28 次 start / 86 次 prune，start 计数含反复重试）。
  verdict('A2 compaction-cycles', r.pruneEvents >= 3, `prune 事件=${r.pruneEvents}（≥3，真实驱逐发生）；compaction/start=${r.compactionStarts}（仅供参考，含重试膨胀）`)
  verdict('A3 eviction-volume', r.prunedSeqs >= 30, `被驱逐去重 seq=${r.prunedSeqs}（≥30）`)

  console.log(`\n  ② 场景有效性`)
  const citeRate = r.cites / Math.max(r.assistantAppends, 1)
  console.log(`     cites 声明=${r.cites}/${r.assistantAppends} 条 assistant 原始回复（${(citeRate * 100).toFixed(1)}%）  跨轮 handle=${r.crossTurnHandles}  带承重 token 的 tool result=${r.toolResultWithTokens}（其中 ≥512 字符 ${r.bigToolResults}）`)
  console.log(`     推断边=${r.edges}（单 token 支撑 ${r.singleTokenEdges}）`)
  verdict('B1 empty-cite-window', citeRate <= 0.05,
    `cites 声明率 ${(citeRate * 100).toFixed(1)}%（≤5% 视为声明通道空窗——组件 A 的适用场景）`)
  verdict('B2 cross-turn-deps', r.crossTurnHandles >= 3, `跨轮复现 handle=${r.crossTurnHandles}（≥3，否则推断边零命中）`)
  verdict('B3 extract-candidates', r.bigToolResults >= 30, `≥512 字符的 tool result=${r.bigToolResults}（≥30，Stage-1 才有量）`)
  verdict('B4 edges-present', r.edges >= 1, `推断边=${r.edges}（≥1，否则组件 A 无数据）`)

  console.log(`\n  ③ 驱逐代价（prune-then-reread，非循环）`)
  info('C1', `被驱逐内容涉及 ${r.prunedPaths} 个路径，其中 **${r.pruneThenReread} 个路径**（${((r.pruneThenReread / Math.max(r.prunedPaths, 1)) * 100).toFixed(1)}%）`
    + `在驱逐后被再次读取（被驱逐的 seq 中 ${r.prunedSeqsReread} 个有后续重读）`)
  console.log(`         ⚠️ 这是**上限**：agent 本就会为自身理由重读文件。可归因的驱逐代价必须由**对照组**做差`
    + `（同题关掉剪枝 → 同一指标的差值才是代价）。单臂绝对值不可单独引用。`)

  console.log(`\n  ④ 组件 B 生产线观测（替换副本里的 [restored] 尾注；口径 = I-B3 构造性）`)
  if (r.hlsFalsePositive > 0) {
    info('D0', `剔除假阳性 ${r.hlsFalsePositive} 例（含 [restored] 字样但尾注 token 不 ⊆ 原文承重词表`
      + ` —— 典型来源：对话在讨论 HLS 机制本身的源码）`)
  }
  if (r.hlsRepairs === 0) {
    info('D1', '未观测到**真实** HLS 修复落盘（该 session 未启用 trailer 档，或守卫未触发）')
  } else {
    const sorted = [...r.hlsRoi].sort((a, b) => a - b)
    const med = sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)]! : NaN
    info('D1', `HLS 修复落盘 ${r.hlsRepairs} 例；可复算 ROI 的 ${r.hlsRoi.length} 例：`
      + `中位 ${med.toFixed(3)}，最小 ${sorted[0]!.toFixed(3)}，最大 ${sorted[sorted.length - 1]!.toFixed(3)}`)
    info('D2', `其中 ROI < θ(1) 的 ${r.hlsGateWouldBlock} 例 —— **门控本会拦下**（越修越长/不划算），`
      + `占 ${((r.hlsGateWouldBlock / Math.max(r.hlsRoi.length, 1)) * 100).toFixed(1)}%`)
  }

  // ---- 结论矩阵 ----
  console.log(`\n  === 结论：这份语料能测什么 ===`)
  const canEdge = r.edges >= 1
  const canVolume = r.prunedSeqs >= 30
  const okHls = r.hlsRepairs > 0
  console.log(`    ${canEdge ? '✔' : '✘'} 组件 A 保护面/影响半径${canEdge ? '' : '（推断边为 0）'}`)
  console.log(`    ${canVolume ? '✔' : '✘'} 组件 A 驱逐代价（prune-then-reread）${canVolume ? '' : '（驱逐量不足）'}`)
  console.log(`    ${okHls ? '✔' : '✘'} 组件 B ROI 分布（生产数据）${okHls ? '' : '（无 HLS 落盘）'}`)
  console.log(`    ✘ 组件 A 误连率（precision）——**需要真值标签**，本审计结构上给不出（用 spike42）`)
  console.log(`    ✘ 收敛/指纹回归——**需要跨多轮压缩序列**，单份 session 不够`)

  const report = {
    meta: { runAt: new Date().toISOString(), privacy: '仅聚合量', spec: 'corpus-run-spec（本地内部规格书，不随包发布）' },
    session: r.file,
    structure: { turns: r.turns, atoms: r.atoms, dataAtoms: r.dataAtoms, chars: r.chars, compactionStarts: r.compactionStarts, pruneEvents: r.pruneEvents, prunedSeqs: r.prunedSeqs, replaces: r.replaces },
    scenario: { cites: r.cites, assistantAppends: r.assistantAppends, citeRate, crossTurnHandles: r.crossTurnHandles, toolResultWithTokens: r.toolResultWithTokens, bigToolResults: r.bigToolResults, edges: r.edges, singleTokenEdges: r.singleTokenEdges },
    evictionCost: { prunedPaths: r.prunedPaths, pruneThenRereadPaths: r.pruneThenReread, prunedSeqsReread: r.prunedSeqsReread },
    componentB: { hlsRepairs: r.hlsRepairs, hlsFalsePositive: r.hlsFalsePositive, hlsGateWouldBlock: r.hlsGateWouldBlock, roi: r.hlsRoi },
    verdicts: failures.length === 0 ? 'ALL PASS' : failures,
  }
  fs.mkdirSync(outDir, { recursive: true })
  const outFile = path.join(outDir, '43-corpus-audit-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json')
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2))
  console.log(`\n  产物：${outFile}`)
  if (failures.length > 0) {
    console.error(`\n=== FAILURES ===\n  ${failures.join('  ')}`)
    process.exitCode = 1
  } else {
    console.log('\n=== 全部验收项通过 ===')
  }
}

main()
