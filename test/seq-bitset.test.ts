/**
 * src/seq-bitset.ts 契约测试（A5 内存有界化的基础容器）。
 *
 * 锁三件事：① `has`/`add`/`size` 与 `Set<number>` 同义（去重、越界、非法入参）；
 * ② 跨 word 边界增长正确（31/32/33、大 seq 触发倍增）；
 * ③ 存储是逐位（byteLength ≈ N/8），不是逐元素对象——这正是 A5 的目的。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { SeqBitset } from '../src/seq-bitset.ts'

test('SeqBitset: add/has/size 与 Set 同义（含跨 word 边界与重复 add）', () => {
  const bits = new SeqBitset(8)
  const set = new Set<number>()
  for (const seq of [0, 1, 31, 32, 33, 63, 64, 1000]) {
    bits.add(seq)
    set.add(seq)
    bits.add(seq) // 重复 add 不得改变 size
  }
  assert.equal(bits.size, set.size)
  for (let seq = 0; seq <= 1100; seq += 1) {
    assert.equal(bits.has(seq), set.has(seq), 'seq=' + seq + ' 与 Set 判定一致')
  }
})

test('SeqBitset: 非法 seq（负数/小数/非数）按不存在处理，不污染 size', () => {
  const bits = new SeqBitset()
  bits.add(-1)
  bits.add(1.5)
  bits.add(Number.NaN)
  assert.equal(bits.size, 0)
  assert.equal(bits.has(-1), false)
  assert.equal(bits.has(1.5), false)
})

test('SeqBitset: 迭代按升序产出全部已置位 seq（诊断面）', () => {
  const bits = new SeqBitset()
  const seqs = [5, 2, 999, 64, 0]
  for (const seq of seqs) bits.add(seq)
  assert.deepEqual([...bits], [0, 2, 5, 64, 999])
})

test('SeqBitset: 存储是逐位——20k 个 seq 的位图不超过 3 倍 N/8 字节', () => {
  const bits = new SeqBitset()
  const N = 20_000
  for (let i = 0; i < N; i += 1) bits.add(i)
  assert.equal(bits.size, N)
  assert.ok(bits.byteLength <= (N / 8) * 3, '含倍增留白仍应在 N/8 的量级（Set<number> 约 30–40 B/项）')
})
