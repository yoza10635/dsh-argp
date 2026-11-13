// 微基准：验证 mergeIntervals 的 O(n²) 缩放（审计 P2 问题 2）。
// 用法：node scripts/bench-merge-intervals.mjs
import { mergeIntervals } from '../lib/prune-selection.js'

function makePruned(n) {
  const pruned = new Map()
  for (let i = 0; i < n; i += 1) {
    pruned.set(i, {
      id: i,
      seq: i,
      type: i % 3 === 0 ? 'A' : 'R',
      turn: Math.floor(i / 10),
      text: 'x'.repeat(200),
      toolCallIds: [],
      cites: [],
      citesFailed: false,
    })
  }
  return pruned
}

function makePosition(n) {
  const position = new Map()
  for (let i = 0; i < n; i += 1) position.set(i, i)
  return position
}

const sizes = [1000, 2000, 4000, 8000]
const issuerByCall = new Map()
for (const n of sizes) {
  const pruned = makePruned(n)
  const position = makePosition(n)
  // 预热
  mergeIntervals(pruned, position, issuerByCall, 0)
  const iters = n >= 4000 ? 3 : 10
  const t0 = process.hrtime.bigint()
  for (let k = 0; k < iters; k += 1) mergeIntervals(pruned, position, issuerByCall, 0)
  const t1 = process.hrtime.bigint()
  const ms = Number(t1 - t0) / 1e6 / iters
  console.log(`n=${String(n).padStart(5)}  avg=${ms.toFixed(1)}ms`)
}
