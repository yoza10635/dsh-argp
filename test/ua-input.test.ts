/**
 * src/factor/ua-input.ts 纯函数契约（design-2.0 §2.4 输入层；现消费者 = prose-condenser）。
 *
 * 锁面：四类分类（含 U-info/relay 二次浓缩禁令）。
 *
 * 变异台账（摘锁必须变红，已逐条执行）：
 *  UI1 classifyUaAtom 放行 U-info（去 sourceSeq 支）→ T1 红；
 *  UI2 relay/notice 不 exclude → T1 红。
 *  （UI3-UI6 锁 planUaSpans/constraintLines 的分段与约束带行为，随 factor-ua 退役一并删除。）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import type { Atom } from '../src/argp-types.ts'
import { classifyUaAtom, type UaEventProbe } from '../src/factor/ua-input.ts'

function atom(seq: number, type: 'U' | 'A' | 'R' | 'X', turn: number, text: string, toolCallIds: string[] = []): Atom {
  return { id: seq, seq, type, turn, text, toolCallIds }
}

const clean: UaEventProbe = { attachment: false }

test('分类器四类 + 二次浓缩禁令（UI1/UI2 锁）', () => {
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
  assert.equal(classifyUaAtom(uinfo, clean), 'excluded', 'U-info 聚合副本禁二次浓缩')
})

test('宿主再注入三件套归类分期：缺省 prose=现网字节不变，exclude=分派器度量口径', () => {
  // AGENTS.md / git 快照 / 技能目录：宿主每次压缩重注入一份——旧副本被 condenser 吞掉
  // 是唯一回收通道（§B-2 结构去重落地前不能断），故缺省仍按 textA（现网不变）；
  // 分派器散文度量显式 'exclude'（假量不撑大判据②，轮1 焦点域实锤 10972→1020）。
  const glossaryProbe = { attachment: false, form: 'instructions', kind: 'agent-instructions' }
  assert.equal(classifyUaAtom(atom(9, 'U', 1, 'alpha bravo ...'), glossaryProbe), 'textA', '缺省=现网口径（condense 吞旧副本通道保留）')
  assert.equal(classifyUaAtom(atom(9, 'U', 1, 'alpha bravo ...'), glossaryProbe, 'exclude'), 'excluded', 'exclude 模式：AGENTS.md 词汇表非可浓缩散文')
  assert.equal(classifyUaAtom(atom(10, 'U', 1, 'git status...'), { attachment: false, form: 'snapshot', kind: 'runtime-context' }, 'exclude'), 'excluded', '运行时快照排除')
  assert.equal(classifyUaAtom(atom(11, 'U', 1, 'skill list...'), { attachment: false, form: 'catalog', kind: 'skill-catalog' }, 'exclude'), 'excluded', '技能目录排除')
  // 单通道命中也排除（宿主两字段都给，任一为权威判据）。
  assert.equal(classifyUaAtom(atom(12, 'U', 1, 'x'), { attachment: false, kind: 'agent-instructions' }, 'exclude'), 'excluded', 'kind 单通道命中即排除')
  assert.equal(classifyUaAtom(atom(13, 'U', 1, 'x'), { attachment: false, form: 'catalog' }, 'exclude'), 'excluded', 'form 单通道命中即排除')
  // 真用户消息（kind=user / 无 form）两模式下都是可浓缩散文——排除面精确不误伤。
  assert.equal(classifyUaAtom(atom(14, 'U', 1, 'real prose'), { attachment: false, kind: 'user' }, 'exclude'), 'textA', '真 user 消息不受影响')
})
