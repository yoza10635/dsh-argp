// 同轮次「无原子压缩」vs「有原子压缩」上下文差距对比
// 用法：node spike/ctx-compare.mjs <C臂log> <A臂log>
// 从 harness 控制台日志解析逐轮活上下文（[turn] <label> ... liveChars=N liveAtoms=M）。
import fs from 'node:fs'

const [cLog, aLog] = process.argv.slice(2)
if (!cLog || !aLog) { console.error('usage: node spike/ctx-compare.mjs <C-arm-log> <A-arm-log>'); process.exit(1) }

function parseTraj(path) {
  const txt = fs.readFileSync(path, 'utf8')
  const traj = []
  const re = /^\[turn\] (\S+) (ok|FAILED).*liveChars=(\d+) liveAtoms=(\d+)/gm
  let m
  while ((m = re.exec(txt)) !== null) traj.push({ label: m[1], ok: m[2] === 'ok', liveChars: +m[3], liveAtoms: +m[4] })
  const arm = (txt.match(/SPIKE 37 \((\w+)\)/) ?? [])[1]
  const done = (txt.match(/完成轮数 (\d+)\/(\d+)/) ?? []).slice(1)
  return { traj, arm, completedTurns: done[0] ?? traj.length, total: done[1] ?? traj.length }
}
const C = parseTraj(cLog)
const A = parseTraj(aLog)
if (C.traj.length === 0 || A.traj.length === 0) { console.error('日志中未找到 liveChars 轨迹（harness 是否含逐轮活上下文测量？）'); process.exit(1) }

function maxOf(arr, k) { return arr.reduce((m, x) => Math.max(m, x[k]), 0) }
function avgOf(arr, k) { return arr.length ? arr.reduce((s, x) => s + x[k], 0) / arr.length : 0 }

const n = Math.max(C.traj.length, A.traj.length)
console.log('=== 同轮次上下文差距（无原子压缩 C vs 有原子压缩 A）===')
console.log(`C = ${C.arm}臂  完成轮=${C.completedTurns}/${C.total}   A = ${A.arm}臂  完成轮=${A.completedTurns}/${A.total}`)
console.log('')
console.log('轮  | C活字符      | A活字符      | 差距(C-A)  | A降幅   | C活原子 | A活原子')
console.log('----+--------------+--------------+------------+----------+---------+--------')
let sumGap = 0, nComp = 0
for (let i = 0; i < n; i += 1) {
  const c = C.traj[i], a = A.traj[i]
  if (!c || !a) continue
  const gap = c.liveChars - a.liveChars
  sumGap += gap; nComp += 1
  const pct = c.liveChars > 0 ? (100 * gap / c.liveChars).toFixed(1) + '%' : '-'
  console.log(` ${String(i + 1).padStart(2)} | ${String(c.liveChars).padStart(12)} | ${String(a.liveChars).padStart(12)} | ${String(gap).padStart(10)} | ${pct.padStart(8)} | ${String(c.liveAtoms).padStart(7)} | ${String(a.liveAtoms).padStart(7)}`)
}
const cMax = maxOf(C.traj, 'liveChars'), aMax = maxOf(A.traj, 'liveChars')
const cAvg = Math.round(avgOf(C.traj, 'liveChars')), aAvg = Math.round(avgOf(A.traj, 'liveChars'))
const cAtoms = maxOf(C.traj, 'liveAtoms'), aAtoms = maxOf(A.traj, 'liveAtoms')
console.log('----+--------------+--------------+------------+----------+---------+--------')
console.log(` 峰值| ${String(cMax).padStart(12)} | ${String(aMax).padStart(12)} | ${String(cMax - aMax).padStart(10)} | ${(cMax > 0 ? (100 * (cMax - aMax) / cMax).toFixed(1) + '%' : '-').padStart(8)} | ${String(cAtoms).padStart(7)} | ${String(aAtoms).padStart(7)}`)
console.log(` 均值| ${String(cAvg).padStart(12)} | ${String(aAvg).padStart(12)} | ${String(cAvg - aAvg).padStart(10)} | ${(cAvg > 0 ? (100 * (cAvg - aAvg) / cAvg).toFixed(1) + '%' : '-').padStart(8)} |         |`)
console.log(` 末轮| ${String(C.traj[C.traj.length-1].liveChars).padStart(12)} | ${String(A.traj[A.traj.length-1].liveChars).padStart(12)} | ${String(C.traj[C.traj.length-1].liveChars - A.traj[A.traj.length-1].liveChars).padStart(10)} | ${(C.traj[C.traj.length-1].liveChars > 0 ? (100 * (C.traj[C.traj.length-1].liveChars - A.traj[A.traj.length-1].liveChars) / C.traj[C.traj.length-1].liveChars).toFixed(1) + '%' : '-').padStart(8)} | ${String(C.traj[C.traj.length-1].liveAtoms).padStart(7)} | ${String(A.traj[A.traj.length-1].liveAtoms).padStart(7)}`)

// 字符 → token 折算（经验 ~3.5 字符/token，本地口径；仅作量级参考）
const CHARS_PER_TOKEN = 3.5
console.log('')
console.log('=== 折算（~3.5 字符/token，量级参考）===')
console.log(`峰值上下文：C≈${Math.round(cMax / CHARS_PER_TOKEN)} tokens  A≈${Math.round(aMax / CHARS_PER_TOKEN)} tokens  差距≈${Math.round((cMax - aMax) / CHARS_PER_TOKEN)} tokens`)
console.log('')
console.log('注：活上下文=活原子模型可见总字符（text+tool-result 内层+tool-call args，不含 reasoning；')
console.log('    本地 Qwen 丢弃 reasoning_content，prompt_tokens 差值=0 实测；tombstone/剪枝原子不计入）。')
console.log('    C 臂仍挂 ArgpGraphEngine（溢出才剪），A 臂=图引擎+per-atom 压缩；两者唯一差异=Stage-1 per-atom 压缩。')
console.log('    run-to-run 变量：两臂各独立跑一次，模型非 temperature=0，绝对值有波动，但相对差距趋势稳定。')
