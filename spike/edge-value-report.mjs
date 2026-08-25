// edge-value-report.mjs：边价值四臂判决聚合（设计 docs/edge-value-4arm-design.md §6）
//
// 用法：
//   node spike/edge-value-report.mjs <A2_run_dir> [A1_run_dir]
//   A2_run_dir 内含 result.json + 28 重放产物 shadowed-{clear,cites,oracle}.json
//   A1_run_dir 内含 result.json（A₁ 无边真跑；P2 真跑差 A₂−A₁ 需要）
//
// 输出：P1 保留集差异（边是否死代码）、P2 D 针正确率差（A₂−A₁，边投入止损闸）、
//       P3 recall 调用频率差（边是否转化为省调用）。
import fs from 'node:fs'
import path from 'node:path'

const a2Dir = process.argv[2]
const a1Dir = process.argv[3] ?? null
if (!a2Dir) {
  console.error('usage: node spike/edge-value-report.mjs <A2_run_dir> [A1_run_dir]')
  process.exit(1)
}
const j = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))
const readOpt = (p) => (fs.existsSync(p) ? j(p) : null)

const a2 = readOpt(path.join(a2Dir, 'result.json'))
const a1 = a1Dir ? readOpt(path.join(a1Dir, 'result.json')) : null
const sc = readOpt(path.join(a2Dir, 'shadowed-clear.json'))
const sCite = readOpt(path.join(a2Dir, 'shadowed-cites.json'))
const sOra = readOpt(path.join(a2Dir, 'shadowed-oracle.json'))

function symdiff(a, b) {
  if (!a || !b) return null
  const sa = new Set(a), sb = new Set(b)
  const onlyA = [...sa].filter((x) => !sb.has(x)).length
  const onlyB = [...sb].filter((x) => !sa.has(x)).length
  return { onlyA, onlyB, symmetric: onlyA + onlyB }
}

console.log('\n=== 边价值四臂判决报告 ===')
console.log('A2 目录: ' + a2Dir + (a1Dir ? '\nA1 目录: ' + a1Dir : '（未提供 A1 → P2 真跑差 A₂−A₁ 需另跑 A₁）'))

// ---------- P1 结构层 ----------
console.log('\n--- P1 结构层（保留集差异 = 边是否死代码）---')
if (sc && sCite) {
  const d = symdiff(sc, sCite)
  console.log('clear vs cites 被独剪: ' + d.onlyA + ' / ' + d.onlyB + ' → 对称差 ' + d.symmetric)
  console.log('  ' + (d.symmetric === 0
    ? '⚠️ shadowedSeqs 完全相同 → 边是死代码（P1 不成立）→ P2/P3 免测，直接止损'
    : '✅ 边改变了保留集（P1 成立），继续 P2/P3'))
}
if (sCite && sOra) {
  const d = symdiff(sCite, sOra)
  console.log('cites vs oracle 对称差 ' + d.symmetric + '（oracle 上限 − 模型边 = 模型服从率吃掉的价值）')
}

// ---------- P2 信息层 ----------
console.log('\n--- P2 信息层（D 针正确率，综合 ≥3 早期 R 原子）---')
if (a2) {
  console.log('A2(cites): U=' + a2.uCorrect + ' R=' + a2.rCorrect + ' D=' + (a2.dCorrect ? 'OK' : 'MISS')
    + ' dTargetShadowed=' + a2.dTargetShadowed + ' recallCalls=' + (a2.recallCalls?.length ?? '?'))
}
if (a1) {
  console.log('A1(无边): U=' + a1.uCorrect + ' R=' + a1.rCorrect + ' D=' + (a1.dCorrect ? 'OK' : 'MISS')
    + ' dTargetShadowed=' + a1.dTargetShadowed + ' recallCalls=' + (a1.recallCalls?.length ?? '?'))
  if (a2) {
    const diff = (a2.dCorrect ? 1 : 0) - (a1.dCorrect ? 1 : 0)
    console.log('A2−A1 D 正确率差 = ' + (diff * 100) + '% → '
      + (Math.abs(diff) < 0.05 ? '边无保留增益（±5% 内）→ 边投入止损（叙事收缩为 0-LLM 剪枝+recall 兜底）'
        : '边有效（≥5%）→ 解锁质量档（C 协议搭车复核）'))
  }
}
if (sOra) {
  console.log('A3(oracle): D 针离线可达性见 shadowed-oracle 与 dTargetShadowed 预检（oracle 边须保留 3 早期 chunk）')
}

// ---------- P3 成本层 ----------
console.log('\n--- P3 成本层（recall 调用频率 = 保护是否省调用）---')
if (a2 && a1) {
  const r2 = a2.recallCalls?.length ?? 0
  const r1 = a1.recallCalls?.length ?? 0
  console.log('recall 调用: A2=' + r2 + ' A1=' + r1 + ' → '
    + (r2 === r1 ? '无差异（P3 不成立，价值仅限保真，成本叙事不写）'
      : (r2 < r1 ? 'A2 更少（边省调用 → 价值打折更轻）' : 'A2 更多（异常）')))
}
console.log('\n=== 报告结束（判决标准见 docs/edge-value-4arm-design.md §6）===')
