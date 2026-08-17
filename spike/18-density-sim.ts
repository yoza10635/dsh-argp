/**
 * spike 18：离线排序策略模拟 —— 单位 token 重要性（密度排序） + 版本链存活代表 eff 叠加
 *
 * 目的：不调 API、纯本地复刻引擎剪枝决策核心，对比三种排序配置在合成场景下的剪枝效率，
 * 量化"预算密度排序"与"版本链叠加"两个设计提案（design-vs-impl-trace.md §3）的增益。
 *
 * 复刻范围（与 src/argp-graph-engine.ts 对齐）：
 *  - 原子：U/A/R（id/seq/turn/type/text/toolCallIds/cites）
 *  - 建边：确定性 A→R（toolCallId 配对）+ cites 语义边（supporting，权重 5）
 *  - eff：selfImportance(A=5,U=3,R=0)，被入边权重覆盖 max；版本链叠加为配置项
 *  - lastRef：入边 from.turn 的 max
 *  - 版本链去重：文本全等，older 预剪（in_degree==0 才剔），保留链代表与链长
 *  - 成对同剪组：A（含 tool-call）+ 应答 R 同进同退
 *  - pass 循环：curInDegree 每 pass 重推 → 候选 in_degree==0 → 排序剪最小组 → 直至 visible ≤ retain
 *
 * 三种配置：
 *  A. 现状       [lvl, eff, lastRef, seq]
 *  B. 密度·分级   [lvl, eff, tokens升序(大先剪), lastRef, seq]
 *  C. 密度+叠加  [lvl, eff+(count-1)*CHAIN_W, tokens升序, lastRef, seq]
 */
const CHARS_PER_TOKEN = 3.5

interface Atom {
  id: number
  seq: number
  turn: number
  type: 'U' | 'A' | 'R'
  text: string
  toolCallIds: string[]
  cites: number[] // 简化：直接给目标 id（模拟器不做子串匹配）
}

interface Edge { from: number; to: number }

const EDGE_WEIGHTS: Record<string, number> = { critical: 10, supporting: 5, contextual: 2 }
const LEVEL_ORDER: Record<string, number> = { isolated: 0, contextual: 1, supporting: 2, critical: 3 }
const tokens = (a: Atom): number => Math.max(1, Math.ceil(a.text.length / CHARS_PER_TOKEN))

// ---------- 场景构造 ----------

let nextId = 0
let nextSeq = 0
let nextTurn = 1
let nextCall = 0

function resetSeq(): void { nextId = 0; nextSeq = 0; nextTurn = 1; nextCall = 0 }

function atom(type: Atom['type'], text: string, opts: { toolCallId?: string; cites?: number[] } = {}): Atom {
  const a: Atom = {
    id: nextId++, seq: nextSeq++, turn: nextTurn, type,
    text, toolCallIds: opts.toolCallId ? [opts.toolCallId] : [], cites: opts.cites ?? [],
  }
  return a
}

function nextTurnMark(): void { nextTurn += 1 }

/** 场景 1：同档孤立原子大小悬殊 —— 密度排序的核心验证。
 *  10 个孤立 A（无 cites 无 toolCall，全 isolated 档、eff=5）：
 *  2 个大原子（各 2K token）+ 8 个小原子（各 100 token）。
 *  retain 设为剪掉 2 个大原子即达标 → A 配置按 seq 剪小原子（8 pass 才轮到大的），
 *  B/C 配置同档内大 token 先剪（2 pass 达标）。 */
function sceneDensity(): { atoms: Atom[]; userAtoms: Set<number>; desc: string } {
  resetSeq()
  const atoms: Atom[] = []
  atoms.push(atom('U', 'user anchor ' + 'u'.repeat(40)))
  // 小原子先出现（seq 靠前）→ A 配置按 seq 先剪它们；大原子后出现（seq 靠后）
  // → 只有 B/C（token 优先）会跳过小原子直剪大原子。retain 设为剪 2 个大原子即达标。
  const smalls: Atom[] = []
  for (let i = 0; i < 8; i += 1) { nextTurnMark(); smalls.push(atom('A', 'small-' + i + ' ' + 's'.repeat(100 * CHARS_PER_TOKEN))) }
  const bigs: Atom[] = []
  for (let i = 0; i < 2; i += 1) { nextTurnMark(); bigs.push(atom('A', 'BIG-' + i + ' ' + 'B'.repeat(2000 * CHARS_PER_TOKEN))) }
  atoms.push(...smalls, ...bigs)
  nextTurnMark()
  atoms.push(atom('A', 'latest ' + 'z'.repeat(50)))
  const userAtoms = new Set(atoms.filter(a => a.type === 'U').map(a => a.id))
  return { atoms, userAtoms, desc: '场景1：同档8小(100tok,先出现) + 2大(2K tok,后出现)' }
}

/** 场景 2：版本链 —— 同文本 A 出现 3 次，链代表是否被密度/叠加保住 */
function sceneVersionChain(): { atoms: Atom[]; userAtoms: Set<number>; desc: string } {
  resetSeq()
  const atoms: Atom[] = []
  atoms.push(atom('U', 'user anchor ' + 'u'.repeat(40)))
  const chainText = 'repeat-content ' + 'r'.repeat(500)
  for (let i = 0; i < 3; i += 1) {
    nextTurnMark()
    const cid = 'call' + i
    const a = atom('A', chainText, { toolCallId: cid })
    const r = atom('R', 'result ' + i + ' ' + 'q'.repeat(300), { toolCallId: cid })
    atoms.push(a, r)
  }
  // 加压：预算紧张，必须剪不少原子
  for (let i = 0; i < 20; i += 1) { nextTurnMark(); atoms.push(atom('A', 'filler ' + i + ' ' + 'f'.repeat(800))) }
  nextTurnMark()
  atoms.push(atom('A', 'latest ' + 'z'.repeat(50)))
  const userAtoms = new Set(atoms.filter(a => a.type === 'U').map(a => a.id))
  return { atoms, userAtoms, desc: '场景2：3-版本链 + 20 个 filler' }
}

/** 场景 3：组合 —— 大 R（被引用）+ 版本链 + 大小悬殊孤立原子同时在场 */
function sceneCombined(): { atoms: Atom[]; userAtoms: Set<number>; desc: string } {
  resetSeq()
  const atoms: Atom[] = []
  atoms.push(atom('U', 'user anchor ' + 'u'.repeat(40)))
  nextTurnMark()
  const bigR = atom('R', 'y'.repeat(2_000 * CHARS_PER_TOKEN), { toolCallId: 'big' })
  atoms.push(atom('A', 'issuer ' + 'i'.repeat(50), { toolCallId: 'big' }), bigR)
  const chainText = 'chain ' + 'c'.repeat(400)
  for (let i = 0; i < 3; i += 1) {
    nextTurnMark()
    const cid = 'c' + i
    atoms.push(atom('A', chainText, { toolCallId: cid }), atom('R', 'res ' + i + ' ' + 'v'.repeat(200), { toolCallId: cid }))
  }
  for (let i = 0; i < 6; i += 1) { nextTurnMark(); atoms.push(atom('A', 'small-' + i + ' ' + 's'.repeat(80 * CHARS_PER_TOKEN))) }
  for (let i = 0; i < 2; i += 1) { nextTurnMark(); atoms.push(atom('A', 'BIG-' + i + ' ' + 'B'.repeat(1500 * CHARS_PER_TOKEN))) }
  nextTurnMark()
  atoms.push(atom('A', 'latest ' + 'z'.repeat(50)))
  const userAtoms = new Set(atoms.filter(a => a.type === 'U').map(a => a.id))
  return { atoms, userAtoms, desc: '场景3：组合（2K大R + 3-版本链 + 6小 + 2大孤立）' }
}

// ---------- 剪枝决策复刻 ----------

interface SimResult {
  config: string
  prunedCount: number
  passCount: number
  prunedChars: number
  remainingChars: number
  remainingEff: number
  chainRepAlive: boolean
  maxChainLen: number
  forced: boolean
}

function simulate(atoms: Atom[], config: 'A' | 'B' | 'C', retainTokens: number): SimResult {
  const CHAIN_W = 1 // 版本链叠加权重（提案 2 待调参）
  // 建边
  const edges: Edge[] = []
  const rByCall = new Map<string, Atom>()
  for (const r of atoms) if (r.type === 'R' && r.toolCallIds[0]) rByCall.set(r.toolCallIds[0], r)
  for (const a of atoms) {
    if (a.type !== 'A') continue
    for (const cid of a.toolCallIds) { const r = rByCall.get(cid); if (r) edges.push({ from: a.id, to: r.id }) }
    for (const t of a.cites) edges.push({ from: a.id, to: t })
  }
  // 版本链：文本全等 older 预剪（in_degree==0 才剔），保留链代表与链长
  const chainLen = new Map<number, number>()
  const prePruned = new Set<number>()
  const seenA = new Map<string, { atom: Atom; count: number }>()
  for (const a of atoms.filter(x => x.type === 'A')) {
    const key = a.text.trim()
    const ex = seenA.get(key)
    if (ex) {
      const older = ex.atom.turn < a.turn || (ex.atom.turn === a.turn && ex.atom.seq < a.seq) ? ex.atom : a
      const newer = older === ex.atom ? a : ex.atom
      const inDeg = edges.filter(e => e.to === older.id).length
      if (inDeg === 0) { prePruned.add(older.id); for (const cid of older.toolCallIds) { const r = rByCall.get(cid); if (r && edges.filter(e => e.to === r.id).length === 0) prePruned.add(r.id) } }
      chainLen.set(newer.id, ex.count + 1)
      seenA.set(key, { atom: newer, count: ex.count + 1 })
    } else {
      seenA.set(key, { atom: a, count: 1 })
    }
  }
  const repIds = new Set([...seenA.values()].map(v => v.atom.id))
  const maxChainLen = Math.max(0, ...[...chainLen.values()])
  // eff + lastRef
  const selfImportance = (a: Atom): number => (a.type === 'A' ? 5 : a.type === 'U' ? 3 : 0)
  const eff = new Map(atoms.map(a => [a.id, selfImportance(a)]))
  for (const e of edges) eff.set(e.to, Math.max(eff.get(e.to) ?? 0, EDGE_WEIGHTS.supporting))
  if (config === 'C') for (const [id, len] of chainLen) eff.set(id, (eff.get(id) ?? 0) + (len - 1) * CHAIN_W)
  const lastRef = new Map<number, number>()
  for (const e of edges) { const from = atoms[e.from]; if (from) lastRef.set(e.to, Math.max(lastRef.get(e.to) ?? 0, from.turn)) }
  const touchesSemantic = new Set(edges.map(e => e.from))
  // 成组
  const issuerByCall = new Map<string, Atom>()
  for (const a of atoms) if (a.type === 'A') for (const cid of a.toolCallIds) issuerByCall.set(cid, a)
  const groups: Atom[][] = []
  const groupOf = new Map<number, number>()
  for (const a of atoms) {
    const issuer = a.type === 'R' && a.toolCallIds[0] ? issuerByCall.get(a.toolCallIds[0]) : undefined
    if (issuer) {
      let gid = groupOf.get(issuer.id)
      if (gid === undefined) { gid = groups.length; groups.push([issuer]); groupOf.set(issuer.id, gid) }
      ;(groups[gid] as Atom[]).push(a); groupOf.set(a.id, gid); continue
    }
    if (groupOf.has(a.id)) continue
    const gid = groups.length; groups.push([a]); groupOf.set(a.id, gid)
  }
  const latestTurn = Math.max(...atoms.map(a => a.turn))
  const position = new Map(atoms.map((a, i) => [a.seq, i]))
  const recencyCut = atoms.length // 模拟 recencyGuard=0（全参与，简化）
  // pass 循环
  const pruned = new Map<number, Atom>()
  for (const id of prePruned) { const a = atoms.find(x => x.id === id); if (a) pruned.set(id, a) }
  let forced = false
  let passCount = 0
  const retainChars = retainTokens * CHARS_PER_TOKEN
  let curInDegree = new Map<number, number>()
  for (let pass = 0; pass < 256; pass += 1) {
    passCount = pass + 1
    curInDegree = new Map<number, number>()
    for (const e of edges) { if (pruned.has(e.from)) continue; curInDegree.set(e.to, (curInDegree.get(e.to) ?? 0) + 1) }
    const remaining = atoms.filter(a => !pruned.has(a.id))
    const visible = remaining.reduce((s, a) => s + a.text.length, 0)
    if (visible <= retainChars) break
    const liveGroups = groups.filter(g => g.some(a => !pruned.has(a.id)))
    const isCandidate = (a: Atom, allowInDegree: boolean): boolean => {
      if (a.type === 'U') return false
      if (a.type !== 'A' && a.type !== 'R') return false
      if (a.turn >= latestTurn) return false
      if (!allowInDegree && (curInDegree.get(a.id) ?? 0) > 0) return false
      return true
    }
    let candidateGroups = liveGroups.filter(g => g.every(a => isCandidate(a, false)))
    if (candidateGroups.length === 0) {
      candidateGroups = liveGroups.filter(g => g.every(a => isCandidate(a, true)))
      if (candidateGroups.length === 0) break
      forced = true
    }
    const sortKey = (a: Atom): string => {
      const lvl = touchesSemantic.has(a.id) ? LEVEL_ORDER.supporting : LEVEL_ORDER.isolated
      const effV = eff.get(a.id) ?? 0
      if (config === 'A') return [lvl, effV, lastRef.get(a.id) ?? 0, a.seq].map(n => String(n).padStart(12, '0')).join('|')
      // B/C：eff 同档内 token 降序（大 token 先剪）——负数使大 token 排前
      const tok = config === 'B' || config === 'C' ? -tokens(a) : 0
      return [lvl, effV, tok, lastRef.get(a.id) ?? 0, a.seq].map(n => String(n).padStart(12, '0')).join('|')
    }
    const groupKey = (g: Atom[]): string => g.map(sortKey).sort()[0] as string
    candidateGroups.sort((x, y) => groupKey(x).localeCompare(groupKey(y)))
    const top = candidateGroups[0] as Atom[]
    for (const a of top) pruned.set(a.id, a)
  }
  const remaining = atoms.filter(a => !pruned.has(a.id))
  const remainingChars = remaining.reduce((s, a) => s + a.text.length, 0)
  const remainingEff = remaining.reduce((s, a) => s + (eff.get(a.id) ?? 0), 0)
  const chainRepAlive = [...repIds].some(id => !pruned.has(id))
  return {
    config, prunedCount: pruned.size, passCount,
    prunedChars: atoms.reduce((s, a) => s + a.text.length, 0) - remainingChars,
    remainingChars, remainingEff, chainRepAlive, maxChainLen, forced,
  }
}

function runScene(scene: { atoms: Atom[]; userAtoms: Set<number>; desc: string }, retainTokens: number): void {
  console.log(`\n=== ${scene.desc} | retain=${retainTokens}K ===`)
  const totalTokens = scene.atoms.reduce((s, a) => s + tokens(a), 0)
  console.log(`原子数=${scene.atoms.length} 总token≈${Math.round(totalTokens / 1000)}K`)
  for (const cfg of ['A', 'B', 'C'] as const) {
    const r = simulate(scene.atoms, cfg, retainTokens)
    const prunedTokens = Math.round(r.prunedChars / CHARS_PER_TOKEN / 100) / 10
    const remainTokens = Math.round(r.remainingChars / CHARS_PER_TOKEN / 1000 * 10) / 10
    console.log(`[${cfg}] 剪=${r.prunedCount}原子/${prunedTokens}K pass=${r.passCount} 剩=${remainTokens}K eff残=${r.remainingEff} 链代表活=${r.chainRepAlive} 链长=${r.maxChainLen} forced=${r.forced}`)
  }
}

// ---------- 主流程 ----------

console.log('== spike 18：密度排序 + 版本链叠加 离线模拟 ==')
console.log('配置 A=现状 [lvl,eff,lastRef,seq]  B=密度分级(同eff内大token先剪)  C=B+链代表eff叠加')
runScene(sceneDensity(), 2500)        // 总≈4.4K token，retain=2.5K（需剪 2 个大原子达标）
runScene(sceneVersionChain(), 2000)   // 总≈5K token，retain=2K（剪 3K）
runScene(sceneCombined(), 2500)       // 总≈5.6K token，retain=2.5K（剪 3.1K）
