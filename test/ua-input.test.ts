/**
 * src/factor/ua-input.ts 纯函数契约（design-2.0 §2.4 输入层）。
 *
 * 锁面：四类分类（含 U-info/relay 二次摘要禁令）、连续切片与切段规则（barrier/
 * excluded/孤儿 R/未闭合轮）、协议组不劈（尾 A 弹出）、约束带逐字子串、池口径。
 *
 * 变异台账（摘锁必须变红，已逐条执行）：
 *  UI1 classifyUaAtom 放行 U-info（去 sourceSeq 支）→ T1 红；
 *  UI2 relay/notice 不 exclude → T1 红；
 *  UI3 未闭合 A 不弹出（closeRun 去 cut）→ T3 红（非法含 A 段）；
 *  UI4 池口径把 R 计入 → T2 红；
 *  UI5 约束句改为非逐字（加装饰）→ T5 红（不再是原文子串）；
 *  UI6 连续性自检退回 seq+1 算术（误杀带洞协议组）→ T2 红。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import type { Atom } from '../src/argp-types.ts'
import { classifyUaAtom, constraintLinesOf, planUaSpans, type UaEventProbe } from '../src/factor/ua-input.ts'

function atom(seq: number, type: 'U' | 'A' | 'R' | 'X', turn: number, text: string, toolCallIds: string[] = []): Atom {
  return { id: seq, seq, type, turn, text, toolCallIds, cites: [], citesFailed: false }
}

const clean: UaEventProbe = { attachment: false }
const probeBy = (map: Map<number, UaEventProbe>) => (seq: number): UaEventProbe => map.get(seq) ?? clean

test('分类器四类 + 二次摘要禁令（UI1/UI2 锁）', () => {
  assert.equal(classifyUaAtom(atom(1, 'A', 0, 'x', ['c1']), clean), 'toolCallA')
  assert.equal(classifyUaAtom(atom(1, 'A', 0, 'x'), clean), 'textA')
  assert.equal(classifyUaAtom(atom(1, 'U', 0, 'x'), clean), 'textA')
  assert.equal(classifyUaAtom(atom(1, 'R', 0, 'x', ['c1']), clean), 'rPair')
  assert.equal(classifyUaAtom(atom(1, 'X', 0, 'x'), clean), 'excluded', 'X（词表 note/墓碑/checkpoint）排除')
  assert.equal(classifyUaAtom(atom(1, 'U', 0, 'x'), { attachment: false, form: 'relay' }), 'excluded', 'relay 已浓缩')
  assert.equal(classifyUaAtom(atom(1, 'U', 0, 'x'), { attachment: false, form: 'notice' }), 'excluded', 'notice 已浓缩')
  assert.equal(classifyUaAtom(atom(1, 'U', 0, 'x'), { attachment: true }), 'barrier', '附件屏障')
  const uinfo = atom(1, 'U', 0, 'x')
  uinfo.sourceSeq = 5
  assert.equal(classifyUaAtom(uinfo, clean), 'excluded', 'U-info 聚合副本禁二次摘要')
})

test('单段全收：U+A(tc)+R+A 一组吃进；池口径 U+A 不含 R（UI4 锁）', () => {
  // 真实 appendGroup 布局：A 与 R 的 log seq 之间隔着 tool/call（占 log 格不进
  // surface，本仓实测 surface=[0,1,2,4]）——seqs 带洞必须照常成段，不可按 seq+1 误杀（UI6 锁）。
  const atoms = [
    atom(1, 'U', 1, '修一下构建'.repeat(10)),
    atom(2, 'A', 1, '跑测试看输出', ['c1']),
    atom(4, 'R', 1, 'BUILD FAILED exit code 1\n'.repeat(50), ['c1']),
    atom(5, 'A', 1, '已定位，是 lockfile 漂移'),
  ]
  const p = planUaSpans(atoms, { probe: probeBy(new Map()), openTurn: null, protectFromTurn: null, watermark: 10 })
  assert.equal(p.spans.length, 1)
  const s = p.spans[0] as (typeof p.spans)[number]
  assert.deepEqual(s.seqs, [1, 2, 4, 5], 'R 随行入段；replace 区间 [1..5] 内含 tool/call 洞（host surface fold 无投影，合法）')
  assert.equal(s.poolChars, atoms[0]!.text.length + atoms[1]!.text.length + atoms[3]!.text.length, '池=U+A')
  assert.equal(p.poolChars, s.poolChars)
  assert.equal(s.firstTurn, 1)
})

test('切段规则：X 切断且未闭合尾 A 弹出；孤儿 R 不吃（UI3 锁）', () => {
  const atoms = [
    atom(1, 'U', 1, '任务说明'),
    atom(2, 'A', 1, '调用中（应答未到就撞上了 X）', ['cX']),
    atom(3, 'X', 1, '墓碑'),
    atom(4, 'R', 1, '迟到的应答', ['cX']),
  ]
  const p = planUaSpans(atoms, { probe: probeBy(new Map()), openTurn: null, protectFromTurn: null, watermark: 9 })
  assert.equal(p.spans.length, 1, 'X 切段 + 孤儿 R 切段 ⇒ 只有一段')
  assert.deepEqual(p.spans[0]?.seqs, [1], '未闭合协议组的 A 从段中弹出（禁劈组）')
})

test('barrier 与未闭合轮/焦点轮切段', () => {
  const probes = new Map<number, UaEventProbe>([[2, { attachment: true }]])
  const atoms = [
    atom(1, 'U', 1, '旧指令'),
    atom(2, 'U', 1, '带附件的旧指令'),
    atom(3, 'U', 2, '更新指令'),
    atom(4, 'A', 3, '最新轮的活体'),
  ]
  const p = planUaSpans(atoms, {
    probe: probeBy(probes), openTurn: 3, protectFromTurn: 3, watermark: 9,
  })
  assert.deepEqual(p.spans.map(s => s.seqs), [[1], [3]], '附件屏障切开两段；turn3 被 openTurn/protect 双护')
})

test('约束带逐字：命中句是原文子串；未命中不入带（UI5 锁）', () => {
  const source = '先看日志。只能用 npm install，禁止手改 lockfile。\n这条没命中没关系。绝不允许推 main！'
  const lines = constraintLinesOf(source)
  assert.ok(lines.includes('只能用 npm install，禁止手改 lockfile。'), '中文句读逐字切出')
  assert.ok(lines.includes('绝不允许推 main！'), '叹号句界')
  assert.ok(!lines.some(l => l.includes('没命中')), '未命中句不入带')
  for (const l of lines) assert.ok(source.includes(l), '约束句必须逐字=原文子串')
})

test('约束句进段与跨段去重合并；watermark 透传', () => {
  const atoms = [
    atom(1, 'U', 1, '必须保留测试。随意'),
    atom(2, 'X', 1, '切断'),
    atom(3, 'U', 2, '必须保留测试。另一句不得跳过评审。'),
  ]
  const p = planUaSpans(atoms, { probe: probeBy(new Map()), openTurn: null, protectFromTurn: null, watermark: 42 })
  assert.equal(p.watermark, 42)
  assert.equal(p.spans.length, 2)
  assert.deepEqual(p.constraintLines, ['必须保留测试。', '另一句不得跳过评审。'], '去重保序')
  assert.deepEqual(p.spans[1]?.constraintLines, ['必须保留测试。', '另一句不得跳过评审。'])
})
