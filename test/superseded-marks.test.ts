/**
 * src/factor/factor-atoms.ts `supersededMarks` 契约测试（A6 分桶实现）。
 *
 * 锁两件事：
 *  ① **语义等价**：分桶实现与「全量两两比较」参考实现逐条一致（含多文件读、
 *     部分读区间、errorish 不算覆盖、failed 读不标死等边界）；
 *  ② 关键保守性：覆盖必须来自**单次**后续读（部分读之和不算覆盖）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { supersededMarks, type RTagInput } from '../src/factor/factor-atoms.ts'
import type { RTags } from '../src/factor/types.ts'

function tags(over: Partial<RTags> = {}): RTags {
  return {
    tool: 'read', files: ['c:/a.ts'], scopes: [], commands: [], errorcodes: [],
    errorish: false, writeish: false, readRange: null, sizeChars: 10, rejects: {}, ...over,
  }
}

function input(seq: number, over: Partial<RTags> = {}, tool = 'read'): RTagInput {
  return { seq, turn: seq, callId: 'c' + seq, tool, resultText: 'x', tags: tags({ ...over, tool }) }
}

/** 参考实现：原全量两两比较（逐字保留旧逻辑，仅用于等价性对照）。 */
function rangeOf(r: RTags['readRange']): [number, number] {
  const INF = Number.POSITIVE_INFINITY
  if (r === null) return [0, INF]
  const start = r.offset ?? 0
  return [start, r.limit === null || r.limit === undefined ? INF : start + r.limit]
}
function rangeCovered(old: RTags['readRange'], next: RTags['readRange']): boolean {
  const [a0, a1] = rangeOf(old)
  const [b0, b1] = rangeOf(next)
  return b0 <= a0 && a1 <= b1
}
function naive(map: Map<number, RTagInput>): Map<number, boolean> {
  const reads = [...map.values()].filter(x => x.tool === 'read' || x.tool === 'view').sort((a, b) => a.seq - b.seq)
  const out = new Map<number, boolean>()
  for (const old of reads) {
    if (old.tags.failed === true) continue
    let covered = false
    for (const next of reads) {
      if (next.seq <= old.seq || next.tags.errorish) continue
      if (old.tags.files.some(f => next.tags.files.includes(f)) && rangeCovered(old.tags.readRange, next.tags.readRange)) {
        covered = true
        break
      }
    }
    if (covered) out.set(old.seq, true)
  }
  return out
}

function mapOf(...items: RTagInput[]): Map<number, RTagInput> {
  return new Map(items.map(x => [x.seq, x]))
}

test('supersededMarks: 全量读覆盖旧读；部分读不覆盖；反向读不覆盖', () => {
  const m = mapOf(
    input(1, { readRange: { offset: 0, limit: 10 } }),  // 部分读
    input(2, { readRange: null }),                      // 全量读（覆盖 1，但不被更早的覆盖）
    input(3, { readRange: { offset: 0, limit: 10 } }),  // 后部分读（不覆盖 2 的全量读）
  )
  const out = supersededMarks(m)
  assert.equal(out.get(1), true, '全量后读覆盖部分旧读')
  assert.equal(out.get(2), undefined, '全量旧读不被部分新读覆盖')
  assert.equal(out.get(3), undefined, '最新读无后续覆盖者')
})

test('supersededMarks: 部分读之和不算覆盖（单次读必须独立覆盖）', () => {
  const m = mapOf(
    input(1, { readRange: { offset: 0, limit: 100 } }),
    input(2, { readRange: { offset: 0, limit: 50 } }),
    input(3, { readRange: { offset: 50, limit: 50 } }),
  )
  assert.equal(supersededMarks(m).get(1), undefined, '两次部分读拼起来覆盖也不得判死')
})

test('supersededMarks: 失败读不产生覆盖；不区分文件不覆盖；errorish 后读无效', () => {
  const m = mapOf(
    input(1, { files: ['c:/a.ts'] }),
    input(2, { files: ['c:/b.ts'] }),                          // 不同文件
    input(3, { files: ['c:/a.ts'], errorish: true }),          // errorish 后读不算证据
    input(4, { files: ['c:/a.ts'], failed: true, errorish: true }), // 失败读（宿主 isError ⇒ 同时 errorish）
  )
  const out = supersededMarks(m)
  assert.equal(out.get(1), undefined, '无有效同文件后读')
  assert.equal(out.get(4), undefined, 'failed 读不进入覆盖判定')
})

test('supersededMarks: 多文件读任一同文件后读覆盖即判死', () => {
  const m = mapOf(
    input(1, { files: ['c:/a.ts', 'c:/b.ts'] }),
    input(2, { files: ['c:/b.ts'] }),
  )
  assert.equal(supersededMarks(m).get(1), true)
})

test('supersededMarks: 分桶实现与全量两两比较逐条等价（随机 300 组，固定种子）', () => {
  let seed = 42
  const rnd = (n: number): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed % n
  }
  const files = ['c:/a.ts', 'c:/b.ts', 'c:/c.ts']
  for (let round = 0; round < 300; round += 1) {
    const items: RTagInput[] = []
    const count = 1 + rnd(12)
    for (let i = 0; i < count; i += 1) {
      const fileCount = 1 + rnd(2)
      const picked = new Set<string>()
      for (let f = 0; f < fileCount; f += 1) picked.add(files[rnd(files.length)]!)
      const kind = rnd(3)
      const readRange = kind === 0 ? null
        : kind === 1 ? { offset: rnd(3) * 10, limit: 10 }
        : { offset: rnd(2) * 10, limit: 20 }
      const tool = rnd(6) === 0 ? 'view' : rnd(8) === 0 ? 'bash' : 'read'
      items.push(input(i + 1, {
        files: [...picked],
        readRange,
        errorish: rnd(5) === 0,
        ...(rnd(7) === 0 ? { failed: true } : {}),
      }, tool))
    }
    const m = mapOf(...items)
    const got = [...supersededMarks(m)].sort((a, b) => a[0] - b[0])
    const want = [...naive(m)].sort((a, b) => a[0] - b[0])
    assert.deepEqual(got, want, 'round ' + round + ' 必须逐条等价')
  }
})
