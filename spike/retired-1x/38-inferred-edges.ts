/**
 * spike 38 — 推断边（PROPOSAL-token-ontology 组件 A）真实语料重放（v1.2.0 验收）
 *
 * 0-LLM 确定性离线回放：合成 30 轮 trace（26-tlong-coding 同构形态——3 个跨轮依赖源 R
 * + 20 轮 filler 膨胀 + 5 个引用探针 A + 收尾），跑**真实引擎链路**
 * atomize → buildGraph → 压力剪枝。无本地模型时同样成立（结构性 0-LLM）。
 *
 * 条件（模型声明通道形态）：
 *   A = 0 声明：A 原子无任何 cites 块（prompt 冲突空窗形态）
 *   B = 声明满配：探针 A 携带引用其依赖源 R 的 cites 块（7 条，逐一对应 7 个推断对）
 * 臂（推断边开关）：
 *   ON = 默认（推断边启用）；OFF = disableInferredEdges: true（v1.1 行为）
 *
 * 判决项（主臂 degradationStrategy='fail'，全有或全无——保护上限不可达时不产出而非过剪）：
 *   S38-1 coverage     0 声明时依赖源全部获推断保护，建图入度精确（dep1=3 / dep2=2 / dep3=2）
 *   S38-2 superset     ON 保护集 ⊇ OFF 保护集（OFF 0 声明 0 边 = ∅）
 *   S38-3 payoff       OFF 臂剪掉 3/3 被引用依赖源（选择性丢失，仅 recall 兜底）；
 *                      ON 臂零产出（全有或全无），依赖源 3/3 在 surface 存活
 *   S38-4 零扰动       声明满配时 ON/OFF 剪枝序列逐位一致（I-A3 语料级）；
 *                      推断对 7/7 被声明边去重（skippedDup=7, accepted=0）
 *   S38-5 停词卫生     推断边恰 7 条、目标恰 3 个依赖源；公共样板 token（25/83=30%>15%）
 *                      触发停词、不派生任何 filler 边；声明/推断两通道保护集完全重合
 *   S38-6 0-LLM        全程零网络（buildGraph/剪枝纯函数路径，结构性保证）
 * 观察项（production 默认 degradationStrategy='lifecycle'，不硬卡，如实记录）：
 *   S38-7 降级链交互   推断边不豁免闭包生命周期/force 链（闭包守卫只认 critical 边，
 *                      不变量 2′），也不豁免 §5.4 链式解锁（引用方全部退休后目标解锁）；
 *                      但**排序**与**共活**收益成立：OFF 先剪依赖源（最大 R 最前），
 *                      ON 先剪 filler、依赖源仅在引用方退休后随链解锁/闭包退休——
 *                      recall 安全网 + 'fail' 档为严格模式。
 *
 * 用法：npm run spike38（无 LLM 依赖，离线可跑）
 * 产物：spike/out/38-inferred-edges-<stamp>.json
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Session as SessionT } from '@deepseek-ai/dsh-session'
import { ArgpGraphEngine } from '../src/argp-graph-engine.ts'
import { findLoadBearingTokens } from '../src/token-ontology.ts'

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const outDir = path.join(import.meta.dirname, 'out')
fs.mkdirSync(outDir, { recursive: true })

const failures: string[] = []
const verdict = (name: string, ok: boolean, detail: string): void => {
  console.log((ok ? '[PASS ' : '[FAIL ') + name + '] ' + detail)
  if (!ok) failures.push(name + ': ' + detail)
}

// ---------- 引擎配置 ----------
// window 2000（threshold = 2000 − reserve 0）；语料 ~48K 字符 ≈ 13.7K tok @3.5 → 压力检查必触发。
// 条件 A：retain 1340 → retainChars 4690，落在 (C−OFFcap, C−ONcap) 窗口内：
//   OFF 剪 23 R 后剩 ~1852 字符 ≤ 4690（达标，正常产出）；
//   ON  剪完 filler+探针+A 后剩 ~7485 字符 > 4690（候选耗尽 → 按策略降级）。
// 条件 B：retain 2500 → retainChars 8750，20 filler R 剪完剩 ~8094 ≤ 8750（达标即停，零扰动可观测）。
const CHARS_PER_TOKEN = 3.5 // 引擎默认
const BASE_CONFIG = {
  windowTokens: 2000,
  maxPasses: 32,
  recencyGuard: 4,
  turnGuard: 2,
  minSpanChars: 0,
  sortMode: 'density',
} as const

// ---------- 语料（确定性字符串；尺寸设计见上注释） ----------
// 依赖源 R：首行唯一（条件 B 的 cites 前缀锚点）+ 承重 token 逐字在场
function padTo(total: number, seed: string): string {
  let out = ''
  for (let i = 1; out.length < total; i += 1) {
    out += ' ' + seed + ' note ' + i + '\n'
  }
  return out.slice(0, total)
}
const DEP1_R =
  'dep1 runtime dump\n'
  + 'timeout=30s pool=25\n'
  + 'token=SVC_TOKEN_Q4W2\n'
  + 'config=/opt/app/config/app.yaml\n'
  + padTo(2000, 'dep1 runtime dump')
const DEP2_R =
  'dep2 contract dump\n'
  + 'gw=https://api.example.com/v1/order/query\n'
  + 'field=order_no\n'
  + padTo(2000, 'dep2 contract dump')
const DEP3_R =
  'dep3 code reference\n'
  + 'src/svc/ratelimit.ts:88\n'
  + 'RATELIMIT_WINDOW_MS=60000\n'
  + padTo(2000, 'dep3 code reference')

// 样板 token：出现在 20 filler R + 5 探针 A = 25/83 原子（30% > 15% 停词阈）
const COMMON = 'workspace/svc/common.ts:1'

// 探针 A（ASCII 标点分隔，token 与依赖源 R 逐字一致；'公共头' 为探针识别锚）
const PROBE: Record<number, string> = {
  25: '部署参数核对如下: timeout=30s pool=25 token=SVC_TOKEN_Q4W2 config=/opt/app/config/app.yaml / 公共头 ' + COMMON,
  26: '接口核对: gw=https://api.example.com/v1/order/query field=order_no 公共头 ' + COMMON,
  27: '代码定位: src/svc/ratelimit.ts:88 RATELIMIT_WINDOW_MS=60000 公共头 ' + COMMON,
  28: '交叉核对: timeout=30s gw=https://api.example.com/v1/order/query 公共头 ' + COMMON,
  29: '复核: token=SVC_TOKEN_Q4W2 src/svc/ratelimit.ts:88 公共头 ' + COMMON,
}
// 条件 B：探针 A 的 cites 块（前缀 = 依赖源 R 首行；T28/T29 各引用两个依赖源）
const PROBE_CITES: Record<number, string[]> = {
  25: ['dep1 runtime dump'],
  26: ['dep2 contract dump'],
  27: ['dep3 code reference'],
  28: ['dep1 runtime dump', 'dep2 contract dump'],
  29: ['dep1 runtime dump', 'dep3 code reference'],
}

function fillerR(i: number): string {
  let out = ''
  for (let k = 0; k < 60 && out.length < 2000; k += 1) {
    out += 'log entry ' + (i * 30 + k) + ' in the ' + COMMON + ' batch, status normal\n'
  }
  return out.slice(0, 2000)
}
function fillerA(n: number): string {
  return '本步骤' + n + '完成了限流窗口的核对, 结果符合预期, 相关记录已归档, 下一步继续处理剩余事项。'
}
function fillerU(n: number): string {
  return '继续第' + n + '步的核对工作'
}
const DEPS: Array<[string, string, string]> = [
  ['dep1', 'call_dep1', DEP1_R],
  ['dep2', 'call_dep2', DEP2_R],
  ['dep3', 'call_dep3', DEP3_R],
]

// ---------- session 构造（fresh per arm；条件 B 在探针 A 追加 cites 块） ----------
function buildSession(condition: 'A' | 'B'): SessionT {
  const session = Session.create(SessionId('spike38-' + condition.toLowerCase()))
  const user = (turn: number, text: string): void => {
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  }
  const assistant = (turn: number, callId: string | null, args: string | null, text: string): void => {
    const content: unknown[] = []
    if (callId !== null && args !== null) {
      content.push({ type: 'tool-call', id: callId, name: 'read_file', arguments: args })
    }
    let body = text
    if (condition === 'B' && PROBE_CITES[turn] !== undefined) {
      body += '\n{"cites":' + JSON.stringify(PROBE_CITES[turn]) + '}'
    }
    content.push({ type: 'text', text: body })
    session.append('assistant/message', {
      stream: [],
      turn,
      step: 1,
      message: {
        role: 'assistant',
        id: 'am_t' + turn,
        source: { kind: 'model', provider: 'offline', model: 'deterministic' },
        content,
      },
    } as never, { surfaceOp: 'append' })
  }
  const result = (turn: number, callId: string, text: string): void => {
    session.append('tool/result', {
      turn,
      step: 1,
      message: {
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }], isError: false }],
        source: { kind: 'tool', callId },
        id: 'm_' + callId,
      },
    } as never, { surfaceOp: 'append' })
  }

  user(1, '任务: 实现限流微服务的部署与核对')
  assistant(1, null, null, fillerA(1))
  for (let i = 0; i < 3; i += 1) {
    const [name, callId, text] = DEPS[i]!
    user(2 + i, '读取' + name + '资料')
    assistant(2 + i, callId, '{"path":"' + name + '-dump.txt"}', fillerA(2 + i))
    result(2 + i, callId, text)
  }
  for (let t = 5; t <= 24; t += 1) {
    user(t, fillerU(t))
    assistant(t, 'call_f' + t, '{"path":"filler/note-' + t + '.txt"}', fillerA(t))
    result(t, 'call_f' + t, fillerR(t))
  }
  for (let t = 25; t <= 29; t += 1) {
    user(t, fillerU(t))
    assistant(t, null, null, PROBE[t]!)
  }
  user(30, '收尾: 确认全部核对完毕')
  assistant(30, null, null, fillerA(30))
  return session
}

// ---------- 臂执行 ----------
interface ArmResult {
  label: string
  condition: 'A' | 'B'
  arm: 'ON' | 'OFF'
  strategy: 'fail' | 'lifecycle'
  visibleBefore: number
  visibleAfter: number
  surfaceAfter: number
  buildInDegreeBySeq: Record<string, number> // seq -> 建图期语义入度
  protectedSeqs: number[]
  prunedCount: number
  prunedByType: Record<string, number>
  prunedDepR: number // 被剪的依赖源 R 数（0-3）
  prunedSeqs: number[]
  inferredEdges: number
  inferredTargets: number[]
  inferredStats: { candidates: number; accepted: number; skippedDup: number }
  finalEdgeLevels: Record<string, number>
  citeStats: { aAtoms: number; declared: number; resolved: number; ambiguous: number; failed: number }
  closurePrunes: number
  hadTransaction: boolean
}

type ArmSpec = { label: string; condition: 'A' | 'B'; arm: 'ON' | 'OFF'; strategy: 'fail' | 'lifecycle'; retain: number }

async function runArm(spec: ArmSpec): Promise<ArmResult> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: 'argp spike38 persona' } })
  await ctx.plugin(ArgpGraphEngine, {
    ...BASE_CONFIG,
    retainTokens: spec.retain,
    degradationStrategy: spec.strategy,
    ...(spec.arm === 'OFF' ? { disableInferredEdges: true } : {}),
  })
  const engine = ctx.compaction as ArgpGraphEngine
  const session = buildSession(spec.condition)
  engine.setSession(session)

  // 建图期快照（instrumentation；compactIfNeeded 内部以同输入重建，结果同值）
  const atoms = engine.atomize(session)
  const seqById = new Map<number, number>()
  for (const a of atoms) seqById.set(a.id, a.seq)
  const { inDegree } = engine.buildGraph(atoms)
  const inDegBySeq: Record<string, number> = {}
  for (const a of atoms) inDegBySeq[String(a.seq)] = inDegree.get(a.id) ?? 0
  // 快照调用已计数 citeStats；清零，让最终值 = compactIfNeeded 内部单次事务
  const cs = engine.citeStats
  cs.aAtoms = 0; cs.declared = 0; cs.resolved = 0; cs.ambiguous = 0; cs.failed = 0

  // 可见量 = 原子文本长度和（与引擎 pass 循环 visible 完全同口径；cites 块已剥离）
  const visibleOf = (s: SessionT): number =>
    engine.atomize(s).reduce((sum, a) => sum + a.text.length, 0)
  const visibleBefore = visibleOf(session)

  await engine.compactIfNeeded({ session } as never, 'pressure', new AbortController().signal)
  const record = engine.records[0]
  const prunedAtoms = record?.prunedAtoms ?? []
  const prunedByType: Record<string, number> = {}
  for (const a of prunedAtoms) prunedByType[a.type] = (prunedByType[a.type] ?? 0) + 1
  const depSeqs = atoms.filter(a => a.type === 'R' && a.text.startsWith('dep')).map(a => a.seq)
  const prunedSeqSet = new Set(prunedAtoms.map(a => a.seq))
  const prunedDepR = depSeqs.filter(s => prunedSeqSet.has(s)).length
  const lastInferred = engine.lastInferredEdges
  const inferredTargetSeqs = [...new Set(
    lastInferred.map(e => seqById.get(e.to)).filter((s): s is number => s !== undefined),
  )].sort((x, y) => x - y)
  const finalEdges = engine.buildGraph(engine.atomize(session))
  const finalEdgeLevels: Record<string, number> = {}
  for (const e of finalEdges.edges) finalEdgeLevels[e.level] = (finalEdgeLevels[e.level] ?? 0) + 1

  const res: ArmResult = {
    label: spec.label,
    condition: spec.condition,
    arm: spec.arm,
    strategy: spec.strategy,
    visibleBefore,
    visibleAfter: visibleOf(session),
    surfaceAfter: session.surface.nodes.length,
    buildInDegreeBySeq: inDegBySeq,
    protectedSeqs: atoms.filter(a => (inDegree.get(a.id) ?? 0) > 0).map(a => a.seq).sort((x, y) => x - y),
    prunedCount: prunedAtoms.length,
    prunedByType,
    prunedDepR,
    prunedSeqs: prunedAtoms.map(a => a.seq).sort((x, y) => x - y),
    inferredEdges: lastInferred.length,
    inferredTargets: inferredTargetSeqs,
    inferredStats: { ...engine.inferredStats },
    finalEdgeLevels,
    citeStats: { ...cs },
    closurePrunes: engine.closurePrunes.length,
    hadTransaction: record !== undefined,
  }
  await ctx.fiber.dispose()
  return res
}

// ---------- 主流程 ----------
async function main(): Promise<void> {
  console.log('[spike38] 推断边真实语料重放（0-LLM 确定性；30 轮 / 83 原子）')
  const t0 = Date.now()

  const retainA = Math.round(4690 / CHARS_PER_TOKEN) // 1340
  const retainB = Math.round(8750 / CHARS_PER_TOKEN) // 2500
  const arms: ArmSpec[] = [
    { label: 'A-ON-fail', condition: 'A', arm: 'ON', strategy: 'fail', retain: retainA },
    { label: 'A-OFF-fail', condition: 'A', arm: 'OFF', strategy: 'fail', retain: retainA },
    { label: 'B-ON-fail', condition: 'B', arm: 'ON', strategy: 'fail', retain: retainB },
    { label: 'B-OFF-fail', condition: 'B', arm: 'OFF', strategy: 'fail', retain: retainB },
    { label: 'A-ON-lifecycle', condition: 'A', arm: 'ON', strategy: 'lifecycle', retain: retainA },
    { label: 'A-OFF-lifecycle', condition: 'A', arm: 'OFF', strategy: 'lifecycle', retain: retainA },
  ]
  const results = new Map<string, ArmResult>()
  for (const spec of arms) results.set(spec.label, await runArm(spec))
  const aOn = results.get('A-ON-fail')!
  const aOff = results.get('A-OFF-fail')!
  const bOn = results.get('B-ON-fail')!
  const bOff = results.get('B-OFF-fail')!
  const aOnLc = results.get('A-ON-lifecycle')!
  const aOffLc = results.get('A-OFF-lifecycle')!

  // 探针轮（报告用）
  const probeTurns = [25, 26, 27, 28, 29]

  // S38-1 coverage
  const degs = aOn.protectedSeqs.map(s => aOn.buildInDegreeBySeq[String(s)] ?? 0).join('/')
  const degOk = aOn.protectedSeqs.length === 3
    && aOn.inferredEdges === 7
    && aOn.inferredTargets.length === 3
    && aOn.buildInDegreeBySeq[String(aOn.protectedSeqs[0]!)] === 3
  // 入度向量排序后必须为 [2,2,3]（探针数决定：dep1 被 3 探针引用、dep2/dep3 各 2）
  const sortedDeg = aOn.protectedSeqs.map(s => aOn.buildInDegreeBySeq[String(s)] ?? 0).sort((x, y) => x - y)
  const exactDeg = JSON.stringify(sortedDeg) === JSON.stringify([2, 2, 3])
  verdict('S38-1 coverage', degOk && exactDeg,
    `0 声明 ON：保护 ${aOn.protectedSeqs.length} 个依赖源，入度向量 [${degs}]，推断边 ${aOn.inferredEdges} 条（期望 3 保护 / 7 边 / [2,2,3]）`)

  // S38-2 superset
  const offProt = new Set(aOff.protectedSeqs)
  const onProt = new Set(aOn.protectedSeqs)
  verdict('S38-2 superset', aOff.protectedSeqs.every(s => onProt.has(s)),
    `ON 保护 ${aOn.protectedSeqs.length} ⊇ OFF 保护 ${aOff.protectedSeqs.length}（0 声明 0 边 = ∅；只增不减）`)

  // S38-3 payoff（'fail' 全有或全无）
  const offPrunedR = aOff.prunedByType['R'] ?? 0
  const payoffOk = aOff.prunedDepR === 3
    && offPrunedR === 23 // 3 dep R + 20 filler R
    && !aOn.hadTransaction
    && aOn.prunedDepR === 0
    && aOn.surfaceAfter === 83 // 无产出 → surface 原样
  verdict('S38-3 payoff', payoffOk,
    `OFF 臂剪 R ${offPrunedR} 个其中依赖源 ${aOff.prunedDepR}/3（选择性丢失，仅 recall 兜底）；`
    + `ON 臂${aOn.hadTransaction ? `产出 ${aOn.prunedCount} 原子` : '零产出（全有或全无）'}，依赖源存活 ${3 - aOn.prunedDepR}/3，surface ${aOn.surfaceAfter}/83 节点`)

  // S38-4 零扰动（声明满配：ON/OFF 剪枝序列逐位一致 + 推断边全部被声明去重）
  // ⚠️ 口径修正（2026-09-15）：`citeStats` 是**跨 buildGraph 累加**（引擎内 `+=`），
  // `inferredStats` 是**最近一次建图**口径。原断言拿常量 7 直接对表这两个计数器 →
  // 在一趟 compactIfNeeded 会多次建图（多 pass）的前提下必然误判。此处改断不变量，
  // 原始计数降为 INFO 留档（不可与"7 条声明"直接对表）。
  const seqEq = bOn.prunedSeqs.length === bOff.prunedSeqs.length
    && bOn.prunedSeqs.every((v, i) => v === bOff.prunedSeqs[i])
  const finalInferredEdges = bOn.finalEdgeLevels['inferred'] ?? 0
  const allDeduped = bOn.inferredStats.accepted === 0
  // 通道等价（S38-4 的核心主张）：0 声明（纯推断）与满配声明（纯声明）的保护集与入度完全一致
  const sameProtection = JSON.stringify(aOn.protectedSeqs) === JSON.stringify(bOn.protectedSeqs)
    && JSON.stringify(aOn.protectedSeqs.map(s => aOn.buildInDegreeBySeq[String(s)]).sort((x, y) => x - y))
      === JSON.stringify(bOn.protectedSeqs.map(s => bOn.buildInDegreeBySeq[String(s)]).sort((x, y) => x - y))
  verdict('S38-4 zero-perturbation', seqEq && finalInferredEdges === 0 && allDeduped && sameProtection,
    `满配声明：ON/OFF 剪枝序列逐位${seqEq ? '一致' : '不一致'}（各 ${bOn.prunedSeqs.length} 原子）；`
    + `最终图推断边 ${finalInferredEdges} 条（应为 0 = 全部被声明边去重）；accepted=${bOn.inferredStats.accepted}（应为 0）；`
    + `两通道保护集${sameProtection ? '完全重合' : '不重合'}（0 声明推断 == 满配声明，${aOn.protectedSeqs.length} 个依赖源同入度）；`
    + `最终边 ${JSON.stringify(bOn.finalEdgeLevels)}`)
  console.log(`[INFO S38-4b] 计数器口径：citeStats 跨 buildGraph **累加**（declared=${bOn.citeStats.declared} / resolved=${bOn.citeStats.resolved} / ambiguous=${bOn.citeStats.ambiguous}），`
    + `inferredStats 为**最近一次建图**（candidates=${bOn.inferredStats.candidates} / accepted=${bOn.inferredStats.accepted} / skippedDup=${bOn.inferredStats.skippedDup}）`
    + `——两者均不可与"7 条声明"常量直接对表（一趟 compactIfNeeded 有多趟 pass）。`)

  // S38-4c 推断↔声明覆盖关系（可对表的确定性量）：满配声明下，探针 A 的 cites 是否覆盖全部推断对
  console.log(`[INFO S38-4c] 声明覆盖：condition B 探针 cites 7 条；最近一次建图 inferred candidates=${bOn.inferredStats.candidates}、`
    + `skippedDup=${bOn.inferredStats.skippedDup}（skippedDup = 同 (from,to) 已被声明边占位而丢弃的推断对）`)

  // S38-5 停词卫生：推断目标不得包含任何 filler 原子
  const noFillerTarget = aOn.inferredTargets.every(s => aOn.protectedSeqs.includes(s))
  // 停词核算（独立复算）：'workspace/svc/common.ts:1' 出现的原子占比
  const sessionA = buildSession('A')
  const probeCtx = new Context()
  await mountAgentLoopTestDependencies(probeCtx, { systemPrompt: { personaPrefix: 'x' } })
  await probeCtx.plugin(ArgpGraphEngine, {})
  const probeEngine = probeCtx.compaction as ArgpGraphEngine
  const probeAtoms = probeEngine.atomize(sessionA)
  const commonBearing = probeAtoms.filter(a => {
    const toks = findLoadBearingTokens(a.text)
    return toks.some(t => t.includes('common.ts'))
  }).length
  const commonRatio = commonBearing / probeAtoms.length
  await probeCtx.fiber.dispose()
  verdict('S38-5 stopword-hygiene', aOn.inferredEdges === 7 && noFillerTarget && commonRatio > 0.15,
    `推断目标恰为 ${aOn.inferredTargets.length} 个依赖源（无 filler）；样板 token 原子占比 ${commonBearing}/${probeAtoms.length}=${(commonRatio * 100).toFixed(1)}% > 15% 停词阈`)

  // S38-5b 声明/推断通道重合（已成为 S38-4 的硬判据之一；此处保留读数）
  console.log(`[INFO S38-5b] 声明/推断通道重合：0 声明推断保护集 == 满配声明保护集（${sameProtection}，同 ${aOn.protectedSeqs.length} 个依赖源同入度）`)

  // S38-6 0-LLM（结构性）
  const elapsed = Date.now() - t0
  console.log(`[INFO S38-6] 0-LLM：6 臂全离线（buildGraph/剪枝纯函数路径，零网络），${elapsed}ms 完成`)

  // S38-7 降级链交互（production 默认 lifecycle；观察项，不硬卡）
  console.log(`[INFO S38-7] lifecycle 默认档观察：`)
  console.log(`  A-OFF-lifecycle：剪 ${aOffLc.prunedCount} 原子（${JSON.stringify(aOffLc.prunedByType)}），依赖源存活 ${3 - aOffLc.prunedDepR}/3（先剪最大 R = 依赖源），闭包退休 ${aOffLc.closurePrunes}`)
  console.log(`  A-ON-lifecycle ：剪 ${aOnLc.prunedCount} 原子（${JSON.stringify(aOnLc.prunedByType)}），依赖源存活 ${3 - aOnLc.prunedDepR}/3（filler 先行；依赖源仅经 §5.4 链式解锁/闭包退休），闭包退休 ${aOnLc.closurePrunes}`)
  console.log(`  结论：推断边 = 排序 + 共活保护（引用方存活期内目标不可软剪）；不豁免 critical-only 闭包守卫与链式解锁——严格模式见 'fail' 臂，安全网 = recall`)

  // 报告
  const report = {
    meta: {
      runAt: new Date().toISOString(),
      durationMs: elapsed,
      llmCalls: 0,
      corpus: '30 turns / 83 atoms (U30 A30 R23)；dep R×3 + filler R×20 + 探针 A×5 + filler A/U；26-tlong-coding 同构',
      retainChars: { conditionA: Math.round(retainA * CHARS_PER_TOKEN), conditionB: Math.round(retainB * CHARS_PER_TOKEN) },
      condition: 'A=0-declaration, B=declared-saturated(7 cites)',
    },
    arms: [aOn, aOff, bOn, bOff, aOnLc, aOffLc],
    probeTurns,
    verdicts: failures.length === 0 ? 'ALL PASS (S38-1..S38-5 全过；S38-6 结构性；S38-4b/4c/5b/7 观察)' : failures,
  }
  const outFile = path.join(outDir, '38-inferred-edges-' + stamp + '.json')
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2))
  console.log(`\n产物：${outFile}`)
  if (failures.length > 0) {
    console.error('\n=== FAILURES ===')
    for (const f of failures) console.error('  ' + f)
    process.exitCode = 1
  } else {
    console.log('\n=== ALL PASS ===')
  }
}

void main()
