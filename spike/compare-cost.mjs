// compare-cost.mjs：读多个 06c/06-tlong 风格 result.json，按双价格锚折算成本，
// 并做「分量支配检查」——ARGP 臂在 (miss,hit,out) 三分量上全面 ≤ 基线臂时，
// 成本在任何非负价格向量下都占优（价格结构无关）。
//
// 用法：
//   node spike/compare-cost.mjs out/<runA>/result.json out/<runB>/result.json out/<runC>/result.json
//   # 或一次性比多目录：
//   node spike/compare-cost.mjs out/06c-35b-*/result.json
//
// 输入契约：result.json 需含
//   arm                 : 'A' | 'B' | 'C'
//   spike               : 运行名
//   cost.missTokens     : 原始 miss(uncached input) token 累计
//   cost.hitTokens      : 原始 cache-read token 累计
//   cost.outTokens      : 原始 completion token 累计
//   cost.cacheHitRatePct: 缓存命中率（仅展示）
//   turnsCompleted / compressionCount
//
// 价格锚（¥/M tokens）：
//   v4-flash 空闲        : miss 1.5 / hit 0.05 / out 4.5   （与 160K 定稿同口径）
//   M3 ≤512K 五折后      : miss 2.1 / hit 0.42 / out 8.4   （命中价差仅 5×）
// 本地模型真实成本≈0；此处按「云等价价」折算 token 流，结果为下界（本地缓存命中 ≥ 云端）。

import fs from 'node:fs'

const ANCHORS = {
  'v4-flash(空闲)': { miss: 1.5, hit: 0.05, out: 4.5 },
  'M3(≤512K 五折)': { miss: 2.1, hit: 0.42, out: 8.4 },
}

function load(p) {
  const r = JSON.parse(fs.readFileSync(p, 'utf8'))
  const fails = Array.isArray(r.verdict?.failures) ? r.verdict.failures : []
  return {
    path: p,
    arm: r.arm ?? '?',
    run: r.spike ?? p,
    miss: r.cost?.missTokens ?? 0,
    hit: r.cost?.hitTokens ?? 0,
    out: r.cost?.outTokens ?? 0,
    cacheHit: r.cost?.cacheHitRatePct ?? 0,
    turns: r.turnsCompleted ?? 0,
    compressions: r.compressionCount ?? 0,
    // 质量轴（仅展示，模型绑定，不计入成本支配检查）
    uCorrect: r.uCorrect ?? 0,
    rCorrect: r.rCorrect ?? 0,
    recallCalls: r.recallCalls ?? 0,
    pruneTx: r.pruneTransactions ?? 0,
    shadowed: r.shadowedNodes ?? 0,
    failures: fails,
  }
}

const files = process.argv.slice(2)
if (files.length === 0) {
  console.error('usage: node spike/compare-cost.mjs <result.json> [<result.json> ...]')
  process.exit(1)
}
const rows = files.map(load)

// 基准臂：优先 arm==='A'，否则第一行
const base = rows.find((r) => r.arm === 'A') ?? rows[0]

// ---------- 逐锚成本表 ----------
for (const [name, a] of Object.entries(ANCHORS)) {
  console.log('\n=== 锚: ' + name + '  (miss ¥' + a.miss + '/M, hit ¥' + a.hit + '/M, out ¥' + a.out + '/M) ===')
  console.log('arm  run                            miss      hit       out      ¥总成本    cacheHit%  压缩')
  for (const r of rows) {
    const cost = (r.miss * a.miss + r.hit * a.hit + r.out * a.out) / 1e6
    console.log(
      String(r.arm).padEnd(4),
      r.run.slice(0, 30).padEnd(30),
      String(r.miss).padStart(8),
      String(r.hit).padStart(8),
      String(r.out).padStart(8),
      ('¥' + cost.toFixed(3)).padStart(9),
      String(r.cacheHit).padStart(8),
      String(r.compressions).padStart(6),
    )
  }
  // 相对基准的成本比
  const baseCost = (base.miss * a.miss + base.hit * a.hit + base.out * a.out) / 1e6
  for (const r of rows) {
    if (r === base) continue
    const c = (r.miss * a.miss + r.hit * a.hit + r.out * a.out) / 1e6
    const ratio = baseCost > 0 ? (c / baseCost) : NaN
    console.log('  → ' + base.arm + ' vs ' + r.arm + ': ' + r.arm + ' 成本 = ' + (ratio * 100).toFixed(1) + '% of ' + base.arm + (ratio < 1 ? '  (ARGP 更省)' : '  (ARGP 更贵)'))
  }
}

// ---------- 分量支配检查（价格结构无关） ----------
console.log('\n=== 分量支配检查（基准=' + base.arm + ' ' + base.run + '）===')
for (const r of rows) {
  if (r === base) continue
  const signs = [base.miss <= r.miss ? '≤' : '>', base.hit <= r.hit ? '≤' : '>', base.out <= r.out ? '≤' : '>']
  const dom = base.miss <= r.miss && base.hit <= r.hit && base.out <= r.out
  console.log(
    '  ' + base.arm + ' vs ' + r.arm + ': miss ' + base.miss + signs[0] + r.miss +
    ' | hit ' + base.hit + signs[1] + r.hit +
    ' | out ' + base.out + signs[2] + r.out +
    ' → ' + (dom ? '全分量支配 ✅（任何价格向量下都更省）' : '存在反超 ⚠️（排名依赖锚）'),
  )
}

// ---------- 质量轴（模型绑定，仅展示；ARGP 的「保质量」主张） ----------
console.log('\n=== 质量轴（模型绑定，仅展示；不为成本结论的一部分）===')
console.log('arm  run                           压缩  pruneTx  shadowed  recallCalls  U正确  R正确  失败项')
for (const r of rows) {
  const failN = r.failures.length
  console.log(
    String(r.arm).padEnd(4),
    r.run.slice(0, 30).padEnd(30),
    String(r.compressions).padStart(4),
    String(r.pruneTx).padStart(7),
    String(r.shadowed).padStart(9),
    String(r.recallCalls).padStart(11),
    String(r.uCorrect).padStart(6),
    String(r.rCorrect).padStart(6),
    String(failN).padStart(5),
  )
}
for (const r of rows) {
  if (r.failures.length > 0) {
    console.log('  [' + r.arm + '] 失败项 ' + r.failures.length + '：')
    for (const f of r.failures) console.log('      - ' + f)
  }
}
