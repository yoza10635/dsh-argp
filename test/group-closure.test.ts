/**
 * 回归锁（2026-11-27 闭包裁定）：协议组的**闭包**语义。
 *
 * 病灶：`planPrune` 逐枚原子累计达标（retention-score.ts:217-229 `takenChars += gain;
 * if (takenChars >= target) break`），对 A+R 成组毫无感知；而发射层旧门 `planProtocolGroups`
 * 要求**全组 R 都已被选中**（`defined.every(selected||stub)`）才允许整组离场。二者错配 ⇒
 * 部分选中的组走到那道门被整组 `continue` 留下，可这些 R 的字符已经算进 `releasedChars`
 * ⇒ `shortfallChars` 归零 ⇒ 既不剪也不 warn，静默零释放空转（实测 seed23 round4/5：
 * selR=13 / held=13 / res=null，chars 65013→65778 反而上涨）。
 *
 * 裁定：改为**闭包**——组内至少一枚 live R 被选中 ⇒ 整组（A + 全部 live R + 夹心节点）
 * 一起离场，一条 user 检查点占位。理由：调用块就长在 A 里，A 离场后单独保留其余 R 无语义；
 * 且"打包带走"本就是原子定义（要剪一起剪）。硬保护一道不放宽：焦点/open 轮的 turn 与位置
 * 守卫、附件 R、surface 不连续、无 R 的 A，全部照旧拦。
 *
 * 变异映射：
 *  - 把 `some` 改回 `every` ⇒ 用例 ① 红（组不闭包、R2 落 rOnly）；
 *  - 摘掉附件硬拦（L469）⇒ 用例 ③ 红（含附件 sibling 的组被闭包吞掉）；
 *  - 摘掉"组内无一枚被选中"这条 ⇒ 用例 ② 红（整组被无端驱逐）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Atom } from '../src/argp-types.ts'
import { planProtocolGroups } from '../src/factor/engine.ts'

function mkAtom(seq: number, type: Atom['type'], turn: number, text: string, toolCallIds: string[] = []): Atom {
  return { id: seq, seq, type, turn, text, toolCallIds } as Atom
}

const SYS = 0, U = 1, A = 2, R1 = 3, R2 = 4

/** 一个 A 带两枚 live R（同轮两次工具调用），surface 上严格连续。 */
function oneAWithTwoR(): { atoms: Atom[]; surface: number[] } {
  const atoms = [
    mkAtom(SYS, 'X', 0, 'persona'),
    mkAtom(U, 'U', 1, 'task'),
    mkAtom(A, 'A', 1, 'calling two tools', ['c1', 'c2']),
    mkAtom(R1, 'R', 1, 'R1 ' + 'a'.repeat(500), ['c1']),
    mkAtom(R2, 'R', 1, 'R2 ' + 'b'.repeat(500), ['c2']),
  ]
  return { atoms, surface: [SYS, U, A, R1, R2] }
}

const PLAIN = {
  protectFromTurn: 99,
  openTurn: null,
  focusSeqs: null,
  stubSeqs: new Set<number>(),
  attachmentSeqs: new Set<number>(),
}

test('① 闭包：只选中组内一枚 R ⇒ 整组（A + 两枚 R）一起离场，rOnly 清空', () => {
  const { atoms, surface } = oneAWithTwoR()
  const plan = planProtocolGroups(atoms, surface, new Set([R1]), PLAIN)
  assert.equal(plan.groups.length, 1, '部分选中必须闭包成组（旧 every 门此处直接 continue，groups=0）')
  const g = plan.groups[0]!
  assert.deepEqual([...g.seqs].sort((x, y) => x - y), [A, R1, R2], 'A 与全部 live R 同进退（含未被选中的 R2）')
  assert.equal(plan.rOnly.length, 0, '闭包后不得留下半拆 R 等死')
  // 闭包的代价必须如实反映在 chars 上：整组三个节点都计入释放量
  assert.ok(g.chars > 1000, `整组释放量应含三节点正文，实测 ${g.chars}`)
})

test('② 组内无一枚被选中 ⇒ 整组不动（闭包不得变成"无差别全剪"）', () => {
  const { atoms, surface } = oneAWithTwoR()
  const plan = planProtocolGroups(atoms, surface, new Set([U]), PLAIN)
  assert.equal(plan.groups.length, 0, '没有任何 R 被选中时不得闭包驱逐整组')
  assert.equal(plan.rOnly.length, 0, 'R 未被选中 ⇒ 不进 rOnly')
})

test('③ 硬保护不放宽：sibling 带附件 ⇒ 整组不得闭包吞掉', () => {
  const { atoms, surface } = oneAWithTwoR()
  const plan = planProtocolGroups(atoms, surface, new Set([R1]), { ...PLAIN, attachmentSeqs: new Set([R2]) })
  assert.equal(plan.groups.length, 0, '附件 R 不可文本召回，含它的组必须整组保留（image/file 不能被 recall 还原）')
  assert.deepEqual([...plan.rOnly], [R1], '被选中的 R1 落 rOnly，由 decide 侧 held（宁少剪不误吞附件）')
})

test('④ 焦点组保护不放宽：闭包只作用于焦点外的组', () => {
  const { atoms, surface } = oneAWithTwoR()
  // 焦点尾窗降级态：focusSeqs 只保护列出的 seq ⇒ A 在焦点内即整组不动
  const plan = planProtocolGroups(atoms, surface, new Set([R1]), { ...PLAIN, focusSeqs: new Set([A]) })
  assert.equal(plan.groups.length, 0, '焦点内的组不得被闭包驱逐')
})

test('⑤ 不连续不闭包：A 与 R 之间夹活体节点 ⇒ 不误吞夹心', () => {
  const atoms = [
    mkAtom(SYS, 'X', 0, 'persona'),
    mkAtom(A, 'A', 1, 'calling', ['c1', 'c2']),
    mkAtom(R1, 'R', 1, 'R1 ' + 'a'.repeat(500), ['c1']),
    mkAtom(5, 'U', 2, '夹在中间的用户消息'),
    mkAtom(R2, 'R', 1, 'R2 ' + 'b'.repeat(500), ['c2']),
  ]
  const surface = [SYS, A, R1, 5, R2]
  const plan = planProtocolGroups(atoms, surface, new Set([R1]), PLAIN)
  assert.equal(plan.groups.length, 0, 'slice 含夹心节点（seq 5 非本组成员）⇒ 拒绝闭包，不误吞活体')
})
