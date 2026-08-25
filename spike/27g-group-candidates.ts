// spike 27g：验证"剔除组内确定性边后候选组数回升"假设
// 重放 26-v4-fix50 到第一次压缩前，复制引擎组构造 + isAtomCandidate 判定，
// 对比两种口径的 softCandidateGroups：
//   口径 A（现状）：R 的 curInDegree 含来自同组 issuer 的确定性边 → 整组被 1550 门槛卡死
//   口径 B（假设）：R 的入度剔除来自同组 issuer 的确定性边 → 候选组数应回升
import fs from 'node:fs'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ArgpGraphEngine, looksAskText } from '../src/argp-graph-engine.ts'

const OUT_DIR = process.argv[2] ?? 'spike/out/26-v4-fix50-2026-08-22T12-49-03-413Z'

interface AtomLike {
  id: number
  seq: number
  type: 'U' | 'A' | 'R' | 'X'
  turn: number
  text: string
  toolCallIds: string[]
  citesFailed: boolean
}
interface EdgeLike { from: number; to: number; level: string }

async function main(): Promise<void> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: 'argp spike27g' } })
  await ctx.plugin(ArgpGraphEngine, { windowTokens: 80_000, retainTokens: 16_000, maxPasses: 256 })
  const engine = ctx.compaction as ArgpGraphEngine
  const session = Session.create(SessionId('spike27g-replay'))

  // 重放到第一次 compaction/start 之前
  const lines = fs.readFileSync(path.resolve(OUT_DIR, 'events.jsonl'), 'utf8').split('\n').filter(Boolean)
  const SURFACE_TYPES = new Set(['user/message', 'assistant/message', 'assistant/chunk', 'tool/result', 'tool/call'])
  let cutSeq = Number.MAX_SAFE_INTEGER
  for (const l of lines) {
    const e = JSON.parse(l)
    if (e.type === 'compaction/start') { cutSeq = e.seq; break }
    if (!SURFACE_TYPES.has(e.type)) continue
    try {
      session.append(e.type, e.data ?? {}, { surfaceOp: e.surfaceOp ?? 'append' } as never)
    } catch { /* skip */ }
  }
  console.log('[27g] 重放到第一次压缩前：cutSeq=' + cutSeq + ' surface.nodes=' + session.surface.nodes.length)
  engine.setSession(session)

  const eng = engine as unknown as {
    atomize(s: Session): AtomLike[]
    buildGraph(atoms: AtomLike[]): { edges: EdgeLike[]; deterministicEdges: EdgeLike[]; inDegree: Map<number, number> }
  }
  const atoms = eng.atomize(session)
  const { edges, deterministicEdges, inDegree } = eng.buildGraph(atoms)
  const surfaceSeqs = [...session.surface.nodes]
  const position = new Map(surfaceSeqs.map((seq, i) => [seq, i]))
  const latestTurn = atoms.reduce((m, a) => Math.max(m, a.turn), 0)
  const recencyCut = Math.max(0, surfaceSeqs.length - 4) // 引擎默认 recencyGuard=4
  const turnGuard = 1

  // ---- 复制引擎组构造（1490-1509）----
  const issuerByCall = new Map<string, AtomLike>()
  for (const a of atoms) if (a.type === 'A') for (const cid of a.toolCallIds) issuerByCall.set(cid, a)
  const groupOf = new Map<number, number>()
  const groups: AtomLike[][] = []
  for (const a of atoms) {
    const issuer = a.type === 'R' && a.toolCallIds[0] !== undefined ? issuerByCall.get(a.toolCallIds[0]) : undefined
    if (issuer !== undefined) {
      let gid = groupOf.get(issuer.id)
      if (gid === undefined) { gid = groups.length; groups.push([issuer]); groupOf.set(issuer.id, gid) }
      ;(groups[gid] as AtomLike[]).push(a)
      groupOf.set(a.id, gid)
      continue
    }
    if (groupOf.has(a.id)) continue
    const gid = groups.length
    groups.push([a])
    groupOf.set(a.id, gid)
  }

  // ---- 复制 askCoverage（U 覆盖判定，1471-1484）----
  const askCoverage = new Map<number, number>()
  for (const u of atoms.filter(a => a.type === 'U')) {
    if (!looksAskText(u.text)) continue
    const firstA = atoms
      .filter(a => a.type === 'A' && a.turn >= u.turn && a.seq > u.seq)
      .sort((a, b) => a.seq - b.seq)[0]
    if (firstA !== undefined && edges.some(e => e.from === firstA.id && e.to === u.id)) {
      askCoverage.set(u.id, firstA.id)
    }
  }

  // ---- 复制 isAtomCandidate（1510-1552），入度来源可切换 ----
  const isAtomCandidate = (a: AtomLike, allowInDegree: boolean, curInDegree: Map<number, number>): boolean => {
    if (a.type === 'U') {
      const coverer = askCoverage.get(a.id)
      if (coverer === undefined) return false
      const pos = position.get(a.seq)
      if (pos === undefined || pos >= recencyCut) return false
      if (a.turn > latestTurn - turnGuard) return false
      const incoming = edges.filter(e => e.to === a.id)
      if (incoming.length === 0 || incoming.some(e => e.from !== coverer)) return false
      return true
    }
    if (a.type !== 'A' && a.type !== 'R') return false
    const pos = position.get(a.seq)
    if (pos === undefined || pos >= recencyCut) return false
    if (a.turn > latestTurn - turnGuard) return false
    if (a.citesFailed) return false
    if (a.type === 'A' && a.toolCallIds.length > 0) {
      const groupIds = new Set<number>([a.id])
      const groupRs = atoms.filter(x => x.type === 'R' && a.toolCallIds.includes(x.toolCallIds[0] ?? ''))
      for (const r of groupRs) groupIds.add(r.id)
      if (groupRs.length > 0) {
        const aCitesR = edges.some(e => e.from === a.id && groupRs.some(r => e.to === r.id))
        const anyRExternalIncoming = groupRs.some(r =>
          (curInDegree.get(r.id) ?? 0) > 0 ||
          deterministicEdges.some(e => e.to === r.id && !groupIds.has(e.from)))
        if (!aCitesR && !anyRExternalIncoming) return false
      }
    }
    if (!allowInDegree && (curInDegree.get(a.id) ?? 0) > 0) return false
    return true
  }
  const isGroupCandidate = (g: AtomLike[], allowInDegree: boolean, curInDegree: Map<number, number>): boolean =>
    g.every(a => isAtomCandidate(a, allowInDegree, curInDegree))

  // ---- 口径 A：现状（inDegree 原样）----
  const groupsA = groups.filter(g => isGroupCandidate(g, false, inDegree)).length

  // ---- 口径 B：剔除"来自同组 issuer 的确定性边"对 R 入度的贡献 ----
  const adjusted = new Map(inDegree)
  for (const r of atoms.filter(a => a.type === 'R')) {
    const issuer = r.toolCallIds[0] !== undefined ? issuerByCall.get(r.toolCallIds[0]) : undefined
    if (issuer === undefined) continue
    // 组内确定性边数：deterministicEdges 中 from=issuer、to=r
    const inner = deterministicEdges.filter(e => e.from === issuer.id && e.to === r.id).length
    if (inner > 0) adjusted.set(r.id, Math.max(0, (adjusted.get(r.id) ?? 0) - inner))
  }
  const groupsB = groups.filter(g => isGroupCandidate(g, false, adjusted)).length

  // ---- 附带：剔除后仍被其他门槛挡掉的组数分解 ----
  const reasons = { fresh: 0, newTurn: 0, citesFailed: 0, a10: 0, inDegreeA: 0, inDegreeB: 0, uNoCover: 0 }
  for (const g of groups) {
    for (const a of g) {
      if (a.type === 'U') { if (askCoverage.get(a.id) === undefined) reasons.uNoCover += 1; continue }
      const pos = position.get(a.seq)
      if (pos === undefined || pos >= recencyCut) { reasons.fresh += 1; break }
      if (a.turn > latestTurn - turnGuard) { reasons.newTurn += 1; break }
      if (a.citesFailed) { reasons.citesFailed += 1; break }
      if ((inDegree.get(a.id) ?? 0) > 0) { reasons.inDegreeA += 1; break }
    }
  }

  console.log('\n=== 对比 ===')
  console.log('原子总数=' + atoms.length + ' 组数=' + groups.length + ' 入度>0原子=' + [...inDegree.values()].filter(v => v > 0).length)
  console.log('口径A（现状，R入度含组内确定性边）: softCandidateGroups = ' + groupsA)
  console.log('口径B（剔除组内确定性边）        : softCandidateGroups = ' + groupsB)
  console.log('\n=== 口径A被挡原因分解（组级，首因） ===')
  console.log(JSON.stringify(reasons, null, 1))

  // ---- 模拟 pass 循环（1577-1605），看剪几组、为何停 ----
  console.log('\n=== pass 循环模拟 ===')
  const touchesSemantic = new Set(edges.flatMap(e => [e.from, e.to]))
  const sortKeyOf = (a: AtomLike): string => {
    const lvl = touchesSemantic.has(a.id) ? 1 : 0
    return [lvl, a.turn, a.seq].map(n => String(n).padStart(10, '0')).join('|')
  }
  const prunedSet = new Set<number>()
  let forced = false
  for (let pass = 0; pass < 256; pass += 1) {
    const cur = new Map<number, number>()
    for (const e of edges) { if (prunedSet.has(e.from)) continue; cur.set(e.to, (cur.get(e.to) ?? 0) + 1) }
    const remaining = atoms.filter(a => !prunedSet.has(a.id))
    const visible = remaining.reduce((s, a) => s + a.text.length, 0)
    if (visible <= 56_000) { console.log('pass=' + pass + ' visible(' + visible + ')<=retainChars(56000) → break'); break }
    const liveGroups = groups.filter(g => g.some(a => !prunedSet.has(a.id)))
    let candidateGroups = liveGroups.filter(g => isGroupCandidate(g, false, cur))
    let path = 'normal'
    if (candidateGroups.length === 0) {
      candidateGroups = liveGroups.filter(g => isGroupCandidate(g, true, cur)) // force
      path = 'force'
      if (candidateGroups.length === 0) { console.log('pass=' + pass + ' 正常候选空 + force 候选也空 → break（剪不动）'); break }
      forced = true
    }
    const groupKey = (g: AtomLike[]): string => g.map(sortKeyOf).sort()[0] as string
    candidateGroups.sort((x, y) => groupKey(x).localeCompare(groupKey(y)))
    const top = candidateGroups[0] as AtomLike[]
    for (const a of top) prunedSet.add(a.id)
    const cutChars = top.reduce((s, a) => s + a.text.length, 0)
    console.log('pass=' + pass + ' [' + path + '] 剪组=' + top.map(a => 'seq' + a.seq + ':' + a.type).join(',')
      + ' 剪' + cutChars + '字符 剩' + (visible - cutChars) + ' 候选组=' + candidateGroups.length)
    if (prunedSet.size > 40) break
  }
  console.log('模拟总剪原子=' + prunedSet.size + ' forced=' + forced)
  console.log('（真实 record[0]：剪 2 原子 / forced=false —— 若模拟剪得多，说明 27g 状态与真实跑不一致）')
}

main().catch(err => { console.error(err); process.exit(1) })
