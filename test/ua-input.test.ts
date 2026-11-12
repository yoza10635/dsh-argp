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
  return { id: seq, seq, type, turn, text, toolCallIds, cites: [], citesFailed: false }
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
