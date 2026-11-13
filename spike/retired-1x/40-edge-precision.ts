/**
 * spike 40 — 组件 A 推断边「误连率」实测（PROPOSAL-token-ontology §2 唯一缺失的地基）
 *
 * 动机（缺口 1）：组件 A 用「逐字共现承重 token」派生 A→(U/R) 保护边。已知该边只增保护
 * （错误方向只往"少剪"错，I-A4），但**从未测过**共现是否等于相关：A 只是"提及"某个数据
 * 原子（现实常见形态：「这与 <另一文件> 里的失败不同」）时，派生出的边是**误连**——
 * 代价 = 该 R 被无谓保护 → 压缩机会丢失（这正是组件 A 性价比的分母）。
 *
 * 方法（受控植入真值 planted truth）：
 *   每个数据原子 D_i 携带唯一 handle（真实仓库形态：路径 + 行号 + 错误码）；
 *   每个 A 原子植入两类引用：
 *     T（真依赖：A 需要 D 的内容）与 M（仅提及：逐字写出 D 的 handle 但不依赖它）。
 *   `deriveInferredEdges` 在 token 视角**不可区分** T 与 M，于是
 *     precision = |derived ∩ T| / |derived|，误连率 = |derived ∩ M| / |derived|。
 *
 * 真值声明为**植入**，非人工标注 —— 度量的是「机制在受控共现下的判别力」，
 * 不等于真实 trace 上的部署精度（后者需 live 语料，见文件末"剩余"）。
 *
 * 臂（同语料、按各 A 原子分别评估；DF / 停词 / 每 A 上限均按生产默认口径全局计算）：
 *   aP0..aP3  提及密度扫描：真依赖 2 个 + 提及 m ∈ {0,1,2,3} → precision 曲线
 *   aC1       半公共 handle（DF=13.2% < 15% 停词阈）在 A 与 4 个无关 D 间共现
 *             → 停词阈能否挡住"通用但不算公共"的 handle？
 *   aH1       每 A 上限拥挤：真依赖 3 + 提及 6 = 9 > maxEdges(8) → seq 降序截断
 *             是否会丢真依赖（recall 损失）？
 *
 * 用法：npm run spike40（0-LLM 离线；buildGraph/派生均为纯函数路径）
 * 产物：spike/out/40-edge-precision-<stamp>.json
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { deriveInferredEdges, findLoadBearingTokens, type OntologyAtom } from '../src/token-ontology.ts'

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const outDir = path.join(import.meta.dirname, 'out')
fs.mkdirSync(outDir, { recursive: true })

const findings: { id: string; severity: 'HIGH' | 'MEDIUM'; detail: string }[] = []
const verdict = (name: string, ok: boolean, detail: string): boolean => {
  console.log((ok ? '[PASS ' : '[FAIL ') + name + '] ' + detail)
  return ok
}
const finding = (id: string, severity: 'HIGH' | 'MEDIUM', detail: string): void => {
  console.log(`[FINDING ${id} · ${severity}] ${detail}`)
  findings.push({ id, severity, detail })
}

// ---------------------------------------------------------------------------
// 语料：28 个"唯一 handle"数据原子 + 4 个"半公共 handle"数据原子 + 6 个 A 原子
// ---------------------------------------------------------------------------
const N_UNIQUE = 28 // D0..D27
const N_GENERIC = 4 // G0..G3（半公共 handle）
const GENERIC_HANDLE = 'conf/base.yaml' // 路径形态；全局 DF = (4+1)/38 = 13.2% < 15%
const MAX_EDGES = 8 // deriveInferredEdges 生产缺省

/** D_i 的唯一 handle 对（路径:行 + 错误码；两 token 指向同一目标，消费端去重为一条边）。 */
function handlesOf(i: number): string[] {
  return [`src/unit${i}/mod${i}.ts:${100 + i}`, `ERR_UNIT${i}X`]
}

/** 数据原子文本：首行 handle，后接中性 prose（不含任何承重 token）。 */
function dataText(handles: string[]): string {
  const [h1, h2] = handles
  return `runtime dump for ${h1} code ${h2}\n`
    + '该步骤的输出已归档，字段与预期一致，未发现额外异常，继续后续核对流程。\n'.repeat(3)
}

/** A 原子文本：中文 prose + 逐字引用 T（真依赖）与 M（仅提及）的 handle。 */
function aText(lead: string, trueRefs: number[], mentions: number[], extra = ''): string {
  const lines = [lead]
  if (trueRefs.length > 0) {
    lines.push('需要处理的目标：' + trueRefs.flatMap(i => handlesOf(i)).join(' '))
  }
  if (mentions.length > 0) {
    lines.push('另外注意，历史上类似的问题出现在 ' + mentions.flatMap(i => handlesOf(i)).join(' ') + ' ——但那与本次无关，仅供参考。')
  }
  if (extra !== '') lines.push(extra)
  return lines.join('\n')
}

// 各 A 的 (真依赖 T, 仅提及 M)，索引 = D 序号
const ARMS: { id: string; lead: string; T: number[]; M: number[]; note: string }[] = [
  { id: 'aP0', lead: '本次修正只涉及下方这条路径，无历史参照。', T: [0, 1], M: [], note: 'm=0 基线' },
  { id: 'aP1', lead: '本次修正涉及下方路径，并顺带提一处旧记录。', T: [2, 3], M: [4], note: 'm=1' },
  { id: 'aP2', lead: '本次修正涉及下方路径，另有两处旧记录值得对照。', T: [5, 6], M: [7, 8], note: 'm=2' },
  { id: 'aP3', lead: '本次修正涉及下方路径，另有若干旧记录仅作背景。', T: [9, 10], M: [11, 12, 13], note: 'm=3' },
  { id: 'aC1', lead: '本次核对围绕下方唯一路径展开。', T: [14], M: [], note: '半公共 handle 臂（额外引用 GENERIC_HANDLE）' },
  { id: 'aH1', lead: '本次重构牵涉下方三条路径，其余为背景提及。', T: [15, 16, 17], M: [18, 19, 20, 21, 22, 23], note: '上限拥挤臂（真依赖 3 + 提及 6 = 9 候选）' },
]

function buildAtoms(): { atoms: OntologyAtom[]; truth: Map<string, { T: number[]; M: number[] }> } {
  const atoms: OntologyAtom[] = []
  let seq = 0
  // 数据原子：D0..D27（seq 1..28）→ G0..G3（seq 29..32）
  for (let i = 0; i < N_UNIQUE; i += 1) {
    seq += 1
    atoms.push({ seq, turn: 1, type: 'R', text: dataText(handlesOf(i)) })
  }
  for (let g = 0; g < N_GENERIC; g += 1) {
    seq += 1
    atoms.push({ seq, turn: 1, type: 'R', text: dataText([GENERIC_HANDLE, `ERR_GENERIC${g}X`]) })
  }
  // A 原子（seq 33..38）
  const truth = new Map<string, { T: number[]; M: number[] }>()
  for (const arm of ARMS) {
    seq += 1
    const extra = arm.id === 'aC1' ? '公共配置位于 ' + GENERIC_HANDLE + ' 处。' : ''
    atoms.push({ seq, turn: 2, type: 'A', text: aText(arm.lead, arm.T, arm.M, extra) })
    truth.set(arm.id, { T: arm.T, M: arm.M })
  }
  return { atoms, truth }
}

// ---------------------------------------------------------------------------
// 评估
// ---------------------------------------------------------------------------
interface ArmEval {
  id: string
  note: string
  trueRefs: number
  mentions: number
  derived: number
  tp: number
  fp: number
  fn: number
  precision: number
  recall: number
  f1: number
  falseLinkRate: number
  fpTargets: number[]
  fnTargets: number[]
  derivedSeqs: number[]
}

function evaluate(): { evals: ArmEval[]; atoms: OntologyAtom[]; dfGeneric: number; totalAtoms: number } {
  const { atoms, truth } = buildAtoms()
  const seqOfD = new Map<number, number>() // D 序号 -> seq
  for (let i = 0; i < N_UNIQUE; i += 1) seqOfD.set(i, i + 1)
  const seqOfGenericA = atoms.find(a => a.type === 'A' && truth.get('aC1') !== undefined && a.text.includes(GENERIC_HANDLE))!.seq
  const seqOfGenericData = new Set(atoms.filter(a => a.type === 'R' && a.text.includes(GENERIC_HANDLE) && a.text.includes('ERR_GENERIC')).map(a => a.seq))

  const pairs = deriveInferredEdges(atoms)
  const byFrom = new Map<number, number[]>()
  for (const p of pairs) {
    const list = byFrom.get(p.fromSeq)
    if (list === undefined) byFrom.set(p.fromSeq, [p.toSeq])
    else if (!list.includes(p.toSeq)) list.push(p.toSeq)
  }

  // 半公共 handle 的 DF（复算；用于证明它确实低于 15% 停词阈）
  const dfGeneric = atoms.filter(a => findLoadBearingTokens(a.text).includes(GENERIC_HANDLE)).length

  const evals: ArmEval[] = []
  for (const arm of ARMS) {
    const aSeq = atoms.find(a => a.type === 'A' && a.text.startsWith(arm.lead))!.seq
    const derived = (byFrom.get(aSeq) ?? []).slice().sort((x, y) => x - y)
    const trueSeqs = new Set(arm.T.map(i => seqOfD.get(i)!))
    const mentionSeqs = new Set(arm.M.map(i => seqOfD.get(i)!))
    const genericTargets = arm.id === 'aC1' ? [...seqOfGenericData].filter(s => s !== seqOfGenericA) : []
    const falseExpected = new Set([...mentionSeqs, ...genericTargets])

    const tp = derived.filter(s => trueSeqs.has(s)).length
    const fp = derived.filter(s => falseExpected.has(s)).length
    const fn = [...trueSeqs].filter(s => !derived.includes(s)).length
    const precision = derived.length === 0 ? 1 : tp / derived.length
    const recall = trueSeqs.size === 0 ? 1 : tp / (tp + fn)
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall)
    evals.push({
      id: arm.id,
      note: arm.note,
      trueRefs: trueSeqs.size,
      mentions: arm.M.length + genericTargets.length,
      derived: derived.length,
      tp,
      fp,
      fn,
      precision,
      recall,
      f1,
      falseLinkRate: derived.length === 0 ? 0 : fp / derived.length,
      fpTargets: derived.filter(s => falseExpected.has(s)),
      fnTargets: [...trueSeqs].filter(s => !derived.includes(s)),
      derivedSeqs: derived,
    })
  }
  return { evals, atoms, dfGeneric, totalAtoms: atoms.length }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
function main(): void {
  console.log('[spike40] 组件 A 推断边误连率实测（0-LLM；受控植入真值）')
  const t0 = Date.now()
  const { evals, atoms, dfGeneric, totalAtoms } = evaluate()
  const byId = new Map(evals.map(e => [e.id, e]))

  console.log(`  语料：${totalAtoms} 原子（数据 ${N_UNIQUE} 唯一 handle + ${N_GENERIC} 半公共 handle，A ${ARMS.length}）`)
  console.log(`  ${GENERIC_HANDLE} 的 DF = ${dfGeneric}/${totalAtoms} = ${((dfGeneric / totalAtoms) * 100).toFixed(1)}%（停词阈 15%）`)

  // 逐臂明细
  for (const e of evals) {
    console.log(`  · ${e.id}（${e.note}）T=${e.trueRefs} M=${e.mentions} → 派生 ${e.derived} 边：`
      + `TP=${e.tp} FP=${e.fp} FN=${e.fn} P=${e.precision.toFixed(3)} R=${e.recall.toFixed(3)} 误连率=${(e.falseLinkRate * 100).toFixed(1)}%`)
  }

  const checks: boolean[] = []

  // S40-1 无噪音基线：m=0 时机制判别完美（precision=recall=1）
  const p0 = byId.get('aP0')!
  checks.push(verdict('S40-1 planted-baseline', p0.precision === 1 && p0.recall === 1 && p0.derived === 2,
    `m=0：派生 ${p0.derived} 边 = 真依赖 2/2，precision=${p0.precision} recall=${p0.recall}（token 通道在无噪音时无损）`))

  // S40-2 误连率与解析模型一致：P = |T|/(|T|+|M|)，误连率 = m/(2+m)
  const analytic = ['aP1', 'aP2', 'aP3'].map(id => {
    const e = byId.get(id)!
    const expectP = e.trueRefs / (e.trueRefs + e.mentions)
    return { id, ok: Math.abs(e.precision - expectP) < 1e-9, expectP, got: e.precision }
  })
  const allMatch = analytic.every(a => a.ok)
  checks.push(verdict('S40-2 false-link-model', allMatch,
    `precision 与解析式 P=|T|/(|T|+|M|) 一致：`
    + analytic.map(a => `${a.id} 期望 ${a.expectP.toFixed(3)} 实测 ${a.got.toFixed(3)}`).join('；')))

  // 结论量化：真依赖 2 个时，每多 1 个"仅提及"，precision 掉 1/(2+m)
  console.log(`  → 误连率曲线（|T|=2）：m=0 → 0%；m=1 → 33.3%；m=2 → 50.0%；m=3 → 60.0%`)
  console.log(`  → 即：真实回复里"仅提及"越多，组件 A 的保护面越脱离真依赖。这是 token 通道的原理性上限。`)

  // S40-3 半公共 handle 漏网（HIGH finding）：DF 13.2% < 15% → 停词不过滤 → 误连
  const c1 = byId.get('aC1')!
  const genericFp = c1.fp
  const stopwordBlocked = genericFp === 0
  const s403 = verdict('S40-3 semicommon-stopword', stopwordBlocked,
    `半公共 handle DF=${((dfGeneric / totalAtoms) * 100).toFixed(1)}% < 15% 停词阈 → ${stopwordBlocked ? '被挡住' : `未挡住，产生 ${genericFp} 条误连边`}`
    + `（aC1 真依赖 1，派生 ${c1.derived}，precision=${c1.precision.toFixed(3)}）`)
  checks.push(s403)
  if (!stopwordBlocked) {
    finding('F40-1', 'HIGH',
      `停词阈 15% 是按"原子占比"设的，但"通用但非全局"的 handle（此处 DF=${((dfGeneric / totalAtoms) * 100).toFixed(1)}%）`
      + `仍会派生误连边（aC1 产生 ${genericFp} 条）。停词是全或无二值，缺乏"按 DF 衰减"的连续信号。`)
  }

  // S40-4 每 A 上限拥挤（MEDIUM finding）：真依赖被 seq 降序截断挤出
  const h1 = byId.get('aH1')!
  const noRecallLoss = h1.fn === 0
  const s404 = verdict('S40-4 cap-crowding', noRecallLoss,
    `真依赖 3 + 提及 6 = 9 候选 > maxEdges(${MAX_EDGES}) → ${noRecallLoss ? '无 recall 损失' : `recall=${h1.recall.toFixed(3)}，被截断丢失的真依赖 seq=${h1.fnTargets.join(',')}`}`)
  checks.push(s404)
  if (!noRecallLoss) {
    finding('F40-2', 'MEDIUM',
      `maxEdgesPerAtom(${MAX_EDGES}) 按"seq 降序（最近优先）"截断：当提及数挤占名额时，**更旧的真依赖会被丢弃**`
      + `（aH1 丢 ${h1.fn} 个）。recency-priority 是文档化设计选择，但其 recall 代价此前未度量。`)
  }

  // 代价侧：误连保护面（可回收字符上界）——被**仅误连边**保护的数据原子文本总长
  const falseProtectedSeqs = new Set<number>()
  for (const e of evals) for (const s of e.fpTargets) falseProtectedSeqs.add(s)
  const charBySeq = new Map(atoms.map(a => [a.seq, a.text.length]))
  const wastedChars = [...falseProtectedSeqs].reduce((sum, s) => sum + (charBySeq.get(s) ?? 0), 0)
  const allDataChars = atoms.filter(a => a.type !== 'A').reduce((sum, a) => sum + a.text.length, 0)
  console.log(`[INFO S40-5] 误连保护面（**本语料特定**，非部署估计）：${falseProtectedSeqs.size} 个数据原子仅因误连被保护，`
    + `合计 ${wastedChars} 字符 = 全部数据字符的 ${((wastedChars / allDataChars) * 100).toFixed(1)}%（组件 A 代价侧分母）`)
  console.log(`  注：该比例由本语料的提及密度决定（每 A 均植入了提及），真实 trace 需实测；此处只证明代价侧可量化。`)

  const elapsed = Date.now() - t0
  const pass = checks.every(Boolean)
  const highFindings = findings.filter(f => f.severity === 'HIGH')

  const report = {
    meta: {
      runAt: new Date().toISOString(),
      durationMs: elapsed,
      llmCalls: 0,
      method: 'planted-truth（受控植入真值；非人工标注）',
      corpus: `${totalAtoms} atoms = ${N_UNIQUE} unique-handle R + ${N_GENERIC} generic-handle R + ${ARMS.length} A`,
      stopwordRatio: 0.15,
      minTokenLen: 6,
      maxEdgesPerAtom: MAX_EDGES,
      genericHandleDf: dfGeneric / totalAtoms,
      caveat: '植入真值度量机制判别力，不等价于真实 trace 部署精度（需 live 语料）',
    },
    evals,
    falseLinkCurve: ARMS.filter(a => a.id.startsWith('aP')).map(a => {
      const e = byId.get(a.id)!
      return { m: e.mentions, precision: e.precision, falseLinkRate: e.falseLinkRate }
    }),
    semicommonHandle: { handle: GENERIC_HANDLE, df: dfGeneric / totalAtoms, falseEdges: genericFp },
    capCrowding: { maxEdges: MAX_EDGES, candidates: h1.mentions + h1.trueRefs, recallLoss: h1.fn },
    protectionTax: { falseProtectedAtoms: falseProtectedSeqs.size, wastedChars, shareOfDataChars: wastedChars / allDataChars },
    findings,
    verdicts: { measurementValid: pass, highFindings: highFindings.length },
  }
  const outFile = path.join(outDir, '40-edge-precision-' + stamp + '.json')
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2))
  console.log(`\n产物：${outFile}`)
  if (highFindings.length > 0) {
    console.error('\n=== HIGH FINDINGS ===')
    for (const f of highFindings) console.error(`  ${f.id}: ${f.detail}`)
  }
  if (!pass) {
    console.error('\n=== MEASUREMENT FAILURES ===')
    process.exitCode = 1
  } else {
    console.log(pass && highFindings.length === 0
      ? '\n=== ALL PASS（组件 A 误连率已量化，无 HIGH 发现）==='
      : '\n=== 度量成立，但存在 HIGH 发现（见上）===')
  }
}

main()
