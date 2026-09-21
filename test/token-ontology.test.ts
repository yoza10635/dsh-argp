/**
 * Token 本体不变式（PROPOSAL-token-ontology 组件 A，v1.2.0）：
 *  - I-A1 每条推断边存在某承重 token 双端逐字包含（构造性，随机语料 property test）
 *  - I-A2 派生过程 0 LLM / 0 I/O（仅读取 seq/turn/type/text，Proxy 隔离测试）
 *  - I-A3 声明边满配时零扰动（同 (from,to) 去重，边集与入度与关闭跑位逐位一致）
 *  - I-A4 0 声明时保护集超集（只增不减）
 *  - 停词过滤 / 每 A 上限 / 声明窗口 / 确定性
 *  - 组件 B 经济学门控：trailerText 口径一致 + hlsRepairEconomics 数值与 θ 灵敏度
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ArgpGraphEngine, type Atom } from '../src/argp-graph-engine.ts'
import {
  deriveInferredEdges,
  findLoadBearingTokens,
  hlsRepairEconomics,
  repairWithTrailer,
  trailerText,
  type InferredEdgeOptions,
  type OntologyAtom,
} from '../src/token-ontology.ts'

async function makeEngine(config: Record<string, unknown> = {}): Promise<ArgpGraphEngine> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: 'argp token-ontology test persona' } })
  await ctx.plugin(ArgpGraphEngine, { windowTokens: 100, retainTokens: 50, minSpanChars: 20, recencyGuard: 0, maxPasses: 16, ...config })
  return ctx.compaction as ArgpGraphEngine
}

/** 注意：id 必须唯一（atomize 口径为局部递增 id）——cites 解析的 selfExcluded 谓词按 id 判自指。 */
function atom(id: number, seq: number, turn: number, type: Atom['type'], text: string, cites: Atom['cites'] = []): Atom {
  return { id, seq, turn, type, text, toolCallIds: [], cites, citesFailed: false }
}

/** 承重 token 池：六类词表各取代表（均 ≥6 字符，跨原子可区分）。 */
const TOKEN_POOL = [
  'src/engine/core.ts:141:19',
  'https://example.com/api/v2/health',
  '3f9c2a1e-8b7d-4e6f-9a0b-1c2d3e4f5a6b',
  'DEAD_BEEF_CODE',
  'budget=256MiB',
  'FAIL_OVER_01',
]

test('findLoadBearingTokens: 词表六类命中 + 尾部标点剥离（共享事实源）', () => {
  const toks = findLoadBearingTokens('see src/a/b.ts:10:2 and https://x.dev/p?q=1 and ERR_ABC_123, done')
  assert.ok(toks.includes('src/a/b.ts'), '路径')
  assert.ok(toks.includes('b.ts:10:2'), 'file:line:col')
  assert.ok(toks.includes('https://x.dev/p?q=1'), 'URL')
  assert.ok(toks.includes('ERR_ABC_123'), 'ALL_CAPS（尾逗号剥离）')
})

test('I-A1: 每条推断边存在某承重 token 双端逐字包含（200 轮随机 property test）', () => {
  for (let round = 0; round < 200; round += 1) {
    const atoms: OntologyAtom[] = []
    let seq = 0
    // P3.6 真空守卫的构造性前提：每轮挑一个 seed token，强制同时放进首个数据原子
    // 与首个 A 原子（A 较新、seq 更大）。ratio=1 停词停用 + seed ≥6 字符 ⇒ 该轮
    // deriveInferredEdges 必产出 ≥1 条边，下方空数组守卫不会误伤（非 flaky）。
    const seed = TOKEN_POOL[Math.floor(Math.random() * TOKEN_POOL.length)]!
    // 先数据原子（较旧），后 A 原子（较新）：seq 严格递增保证"更旧"语义
    const nData = 1 + Math.floor(Math.random() * 4)
    for (let i = 0; i < nData; i += 1) {
      seq += 1
      const toks = TOKEN_POOL.filter(() => Math.random() < 0.4)
      if (i === 0 && !toks.includes(seed)) toks.unshift(seed)
      atoms.push({ seq, turn: 1, type: Math.random() < 0.5 ? 'U' : 'R', text: 'data body ' + toks.join(' | ') })
    }
    const nA = 1 + Math.floor(Math.random() * 3)
    for (let i = 0; i < nA; i += 1) {
      seq += 1
      const toks = TOKEN_POOL.filter(() => Math.random() < 0.4)
      if (i === 0 && !toks.includes(seed)) toks.unshift(seed)
      atoms.push({ seq, turn: 1 + i, type: 'A', text: 'reply body ' + toks.join(' | ') })
    }
    const pairs = deriveInferredEdges(atoms, { stopwordRatio: 1 }) // ratio=1 → 停词机制停用（count/len ≤ 1 永不过阈）
    // P3.6 真空守卫：若某轮随机数据使 deriveInferredEdges 返回空数组，下方断言循环
    // 零执行 = 真空通过（假绿）。seed 双端在场保证此守卫恒过（构造性），但一旦未来
    // 词表/派生逻辑改动使 seed 不再命中，这里立即失败而非静默假绿。
    assert.ok(pairs.length > 0, `round ${round}: 推断边不得为空（seed token 双端在场，构造性保证 ≥1 条边）`)
    for (const p of pairs) {
      const from = atoms.find(a => a.seq === p.fromSeq)!
      const to = atoms.find(a => a.seq === p.toSeq)!
      assert.ok(from.type === 'A' && (to.type === 'U' || to.type === 'R'), '边方向：A(新) → U/R(旧)')
      assert.ok(to.seq < from.seq, '目标严格更旧')
      const shared = findLoadBearingTokens(from.text).filter(t => t.length >= 6 && findLoadBearingTokens(to.text).includes(t))
      assert.ok(shared.length > 0, `round ${round}: 边 (${from.seq} → ${to.seq}) 须存在双端共有的 ≥6 字符 token（I-A1 构造性）`)
    }
  }
})

test('I-A2: 派生仅读取 seq/turn/type/text（0 LLM / 0 I/O，Proxy 隔离）', () => {
  const a1: OntologyAtom = { seq: 1, turn: 1, type: 'R', text: 'see FAIL_OVER_01 here' }
  const a2: OntologyAtom = { seq: 2, turn: 2, type: 'A', text: 'the FAIL_OVER_01 path' }
  const make = (a: OntologyAtom): OntologyAtom => new Proxy(a, {
    get(t, k) {
      if (k === 'seq' || k === 'turn' || k === 'type' || k === 'text') return (t as unknown as Record<string, unknown>)[k]
      throw new Error(`forbidden property access: ${String(k)}`)
    },
  })
  // 不抛 = 派生路径未触达词表/守卫之外的任何原子属性（LLM adapter 更无从介入）
  const pairs = deriveInferredEdges([make(a1), make(a2)], { stopwordRatio: 1 })
  assert.equal(pairs.length, 1)
})

test('I-A3: 声明边满配时零扰动——同 (from,to) 去重，边集/入度与关闭跑位逐位一致', async () => {
  const token = 'src/alpha/one.ts:77'
  const atoms: Atom[] = [
    atom(0, 1, 1, 'R', token + ' payload line'),
    atom(1, 2, 2, 'A', 'saw ' + token + ' just now', [{ text: 'src/alpha/one.ts:77 payload', level: 'supporting' }]),
  ]
  // ratio=1.0：双端共有的 token（2/2=100%）不过停词阈——I-A3 需要推断边候选到场才能验证去重
  const on = await makeEngine({ inferredStopwordRatio: 1.0 }) // 默认启用
  const off = await makeEngine({ disableInferredEdges: true, inferredStopwordRatio: 1.0 })
  const rOn = on.buildGraph(atoms)
  const rOff = off.buildGraph(atoms)
  assert.equal(rOff.edges.length, 1, '基线：cites 声明边 1 条')
  assert.equal(rOn.edges.length, 1, '声明先行：token 命中的同 (from,to) 被去重，无边增长')
  assert.equal(on.inferredStats.skippedDup, 1, 'skippedDup 记账')
  assert.deepEqual(on.lastInferredEdges, [])
  assert.deepEqual(rOn.edges, rOff.edges, '边集逐位一致')
  assert.deepEqual(rOn.inDegree, rOff.inDegree, '入度逐位一致')
})

test('I-A4: 0 声明时推断边保护"近期被引用但未声明"的原子——保护集超集（只增不减）', async () => {
  const atoms: Atom[] = [
    atom(0, 1, 1, 'R', 'gateway FAIL_OVER_01 at src/gw/b.ts:9'),
    atom(1, 2, 1, 'U', 'unrelated user text without any hard token'),
    atom(2, 3, 2, 'A', 'the FAIL_OVER_01 path is at src/gw/b.ts:9'),
  ]
  const on = await makeEngine({ inferredStopwordRatio: 0.9 }) // 小语料放宽停词阈（2/3 = 66% < 90%）
  const off = await makeEngine({ disableInferredEdges: true, inferredStopwordRatio: 0.9 })
  const rOn = on.buildGraph(atoms)
  const rOff = off.buildGraph(atoms)
  for (const [id, deg] of rOff.inDegree) {
    assert.ok((rOn.inDegree.get(id) ?? 0) >= deg, `原子 ${id} 保护度只增不减`)
  }
  assert.ok((rOn.inDegree.get(0) ?? 0) > 0, '被引用的 R 获推断边保护（0 声明通道下的选择性恢复）')
  assert.equal(rOff.inDegree.get(0) ?? 0, 0, '基线：0 声明 = 该 R 无保护')
  assert.equal(on.lastInferredEdges.length, 1)
  assert.equal(on.lastInferredEdges[0]!.level, 'inferred')
})

test('停词过滤：出现在 >15% 原子中的 token 不派生边（防公共标识稀释）', () => {
  const atoms: OntologyAtom[] = []
  let seq = 0
  // 10 数据原子：全部含公共 token；仅第 1 个含区分 token
  for (let i = 0; i < 10; i += 1) {
    seq += 1
    atoms.push({ seq, turn: 1, type: 'R', text: 'COMMON_1_X ' + (i === 0 ? 'SIGNAL_2_Y' : 'padding') })
  }
  // 10 A 原子：全部含公共 token；仅最后一个含区分 token
  for (let i = 0; i < 10; i += 1) {
    seq += 1
    atoms.push({ seq, turn: 2 + i, type: 'A', text: 'COMMON_1_X ' + (i === 9 ? 'SIGNAL_2_Y' : 'padding') })
  }
  const pairs = deriveInferredEdges(atoms) // 默认 0.15：公共 100% → 停词；区分 2/20 = 10% → 放行
  assert.equal(pairs.length, 1, '仅区分 token 派生 1 条边')
  assert.equal(pairs[0]!.fromSeq, 20, '最后一个 A')
  assert.equal(pairs[0]!.toSeq, 1, '第一个数据原子')
})

test('每 A 上限：10 个候选目标截断为 8（seq 降序取最近 8）', () => {
  const atoms: OntologyAtom[] = []
  for (let i = 1; i <= 10; i += 1) {
    const tok = 'TOK_' + String(i).padStart(2, '0') + '_ABC'
    atoms.push({ seq: i, turn: 1, type: 'R', text: tok + ' body' })
  }
  const all = atoms.map(a => findLoadBearingTokens(a.text)[0]).join(' ')
  atoms.push({ seq: 11, turn: 2, type: 'A', text: 'hits ' + all })
  const pairs = deriveInferredEdges(atoms, { stopwordRatio: 1 })
  assert.equal(pairs.length, 8, '上限 8 条')
  assert.deepEqual(pairs.map(p => p.toSeq), [10, 9, 8, 7, 6, 5, 4, 3], 'seq 降序：最近参照优先')
})

test('声明窗口：超出 windowTurns 的 A 不作边源', () => {
  const atoms: OntologyAtom[] = [
    { seq: 1, turn: 1, type: 'R', text: 'see WINDOW_TOKEN_9 at src/w/x.ts:3' },
    { seq: 2, turn: 4, type: 'A', text: 'old reply WINDOW_TOKEN_9' },
    { seq: 3, turn: 6, type: 'A', text: 'recent reply WINDOW_TOKEN_9' },
    { seq: 4, turn: 25, type: 'X', text: 'tombstone' }, // latestTurn = 25
  ]
  const pairs = deriveInferredEdges(atoms, { windowTurns: 20, stopwordRatio: 1 })
  assert.equal(pairs.length, 1, 'turn 4 ≤ 25−20 → 出局；turn 6 > 5 → 在场')
  assert.equal(pairs[0]!.fromSeq, 3)
})

test('确定性：同输入两次派生结果逐位一致', () => {
  const atoms: OntologyAtom[] = [
    { seq: 1, turn: 1, type: 'R', text: 'A_ONE_TOKEN and B_TWO_TOKEN' },
    { seq: 2, turn: 1, type: 'R', text: 'C_THREE_TOKEN' },
    { seq: 3, turn: 2, type: 'A', text: 'A_ONE_TOKEN C_THREE_TOKEN B_TWO_TOKEN' },
    { seq: 4, turn: 2, type: 'A', text: 'B_TWO_TOKEN' },
  ]
  assert.deepEqual(deriveInferredEdges(atoms, { stopwordRatio: 1 }), deriveInferredEdges(atoms, { stopwordRatio: 1 }))
})

test('引擎 buildGraph 接线：disableCiteEdges（A₁ 臂）同时隔离推断边', async () => {
  const atoms: Atom[] = [
    atom(0, 1, 1, 'R', 'gateway ARMS_TOKEN_01 at src/a/b.ts:2'),
    atom(1, 2, 2, 'A', 'the ARMS_TOKEN_01 line'),
  ]
  const arm = await makeEngine({ disableCiteEdges: true, inferredStopwordRatio: 0.9 })
  const r = arm.buildGraph(atoms)
  assert.equal(r.edges.length, 0, 'A₁ 零语义边臂：cites 与推断边双双缺席')
  assert.deepEqual(arm.lastInferredEdges, [])
})

test('repairWithTrailer: 空缺失返回原文；非空尾注逐字拼接', () => {
  assert.equal(repairWithTrailer('cand', []), 'cand')
  assert.equal(repairWithTrailer('cand', ['A_ONE', 'b.ts:1']), 'cand\n[restored] A_ONE b.ts:1')
})

test('trailerText: 长度口径的唯一事实源——与 repairWithTrailer 增量逐字一致', () => {
  const missing = ['src/a/b.ts:1', 'ERR_XYZ_99']
  const cand = 'some compressed prose'
  assert.equal(repairWithTrailer(cand, missing).length - cand.length, trailerText(missing).length)
  assert.equal(trailerText([]), '', '空缺失零开销（修复=恒等）')
})

test('hlsRepairEconomics: 口径——proseGain/trailerCost/netRelease/roi 与 accept 边界', () => {
  const missing = ['AAA_BBB_CC'] // 10 字符 → 尾注 '\n[restored] ' (12) + 10 = 22
  // 过门：净释放 38 > 尾注 22（θ=1）
  const ok = hlsRepairEconomics(100, 40, missing)
  assert.equal(ok.proseGain, 60, 'B = L_orig − L_cand')
  assert.equal(ok.trailerCost, 22, 'C = 尾注字符数')
  assert.equal(ok.netRelease, 38, 'N = B − C = L_orig − L_rep')
  assert.ok(Math.abs(ok.roi - 38 / 22) < 1e-9, 'ROI = N / C')
  assert.equal(ok.accept, true, 'ROI ≥ 1 → 放行')
  // 拒门：修复后（62）比原文（50）更长 → 净释放为负
  const bad = hlsRepairEconomics(50, 40, missing)
  assert.equal(bad.netRelease, -12)
  assert.ok(bad.roi < 0)
  assert.equal(bad.accept, false, 'N < 0 在任意 θ ≥ 0 下都被拒')
  // 空缺失：尾注零开销 → ROI = +∞（防御性放行）
  const id = hlsRepairEconomics(100, 40, [])
  assert.equal(id.trailerCost, 0)
  assert.equal(id.roi, Number.POSITIVE_INFINITY)
  assert.equal(id.accept, true)
})

test('hlsRepairEconomics: θ 灵敏度——同一核算在 θ=0 / θ=1 / θ=2 下翻转', () => {
  const missing = ['AAA_BBB_CC'] // 尾注 22
  // B=60, C=22 → ROI ≈ 1.727：θ=0 过、θ=1 过、θ=2 拒
  assert.equal(hlsRepairEconomics(100, 40, missing, 0).accept, true)
  assert.equal(hlsRepairEconomics(100, 40, missing, 1).accept, true)
  assert.equal(hlsRepairEconomics(100, 40, missing, 2).accept, false, 'θ=2：净释放（38）不足尾注 2 倍（44）')
  // 正收益但杠杆不足：B=40, C=22 → N=18, ROI≈0.818 → θ=0 过、θ=1 拒
  assert.equal(hlsRepairEconomics(80, 40, missing, 0).accept, true, 'θ=0 = 只要求净释放为正')
  assert.equal(hlsRepairEconomics(80, 40, missing, 1).accept, false, 'θ=1：尾注未替自己买单')
})
