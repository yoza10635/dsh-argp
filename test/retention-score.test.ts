/**
 * src/factor/retention-score.ts 契约测试（design-2.0 §2.3 排序规约）。
 *
 * 契约面：
 *  - 缺失值保守档（未知 = 不可再生/未覆盖/焦点）；
 *  - I-DIR 释放向二次核验：注入 true 仍须 read 族 + document 键下限；
 *  - 字典序优先级：再生 > 覆盖 > 非焦点 > 旧 > 大 > seq tie；
 *  - 硬保护成员任何压力下不入区；目标不可达如实报 shortfall（降级链）。
 *
 * 变异纪律：二次核验的 readish 条件、缺失值保守分支、hard 过滤任一摘除必须变红。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { compareForPrune, computeScore, planPrune } from '../src/factor/retention-score.ts'
import type { ScoredEntry, ScoreInput } from '../src/factor/retention-score.ts'
import type { RTags } from '../src/factor/types.ts'

function mkTags(over: Partial<RTags> = {}): RTags {
  return {
    tool: 'read', files: ['c:/a.ts'], scopes: [], commands: [], errorcodes: [],
    errorish: false, writeish: false, cwdSeen: false, argsFp: '',
    readRange: null, sizeChars: 100, rejects: {}, ...over,
  }
}

function mk(rootSeq: number, over: Partial<ScoreInput> = {}): ScoredEntry {
  const base = { rootSeq, turn: 5, currentTurn: 10, tags: mkTags() }
  return { rootSeq, score: computeScore({ ...base, ...over }) }
}

// ---------------------------------------------------------------------------
// 保守档与释放向二次核验
// ---------------------------------------------------------------------------

test('缺失值一律保守：undefined → 不可再生/未覆盖/焦点', () => {
  const s = computeScore({ rootSeq: 1, turn: 5, currentTurn: 10, tags: mkTags() })
  assert.equal(s.regenerable, 1)
  assert.equal(s.superseded, 1)
  assert.equal(s.focal, 1)
  assert.equal(s.hard, 0)
  assert.equal(s.freshness, 5)
})

test('可再生二次核验：非 read 族/无 document 键的注入 true 不放行', () => {
  const writeTrue = computeScore({
    rootSeq: 1, turn: 5, currentTurn: 10, tags: mkTags({ tool: 'write', writeish: true }), regenerable: true,
  })
  assert.equal(writeTrue.regenerable, 1, 'write 输出不可再生是语义事实，注入翻不动')
  const noFile = computeScore({
    rootSeq: 2, turn: 5, currentTurn: 10, tags: mkTags({ files: [] }), regenerable: true,
  })
  assert.equal(noFile.regenerable, 1, '无 document 键无从验"文件未变"')
  const ok = computeScore({ rootSeq: 3, turn: 5, currentTurn: 10, tags: mkTags(), regenerable: true })
  assert.equal(ok.regenerable, 0)
})

test('覆盖证明同样只认 read 族（grep 输出无覆盖语义）', () => {
  const grep = computeScore({
    rootSeq: 1, turn: 5, currentTurn: 10, tags: mkTags({ tool: 'grep', files: [], scopes: ['c:/p'] }), superseded: true,
  })
  assert.equal(grep.superseded, 1)
})

// ---------------------------------------------------------------------------
// 字典序
// ---------------------------------------------------------------------------

test('优先级：可再生压倒新鲜度与体积（新小项排在旧大项前）', () => {
  const regenFreshSmall = mk(1, { turn: 9, regenerable: true, tags: mkTags({ sizeChars: 10 }) })
  const staleBig = mk(2, { turn: 1, tags: mkTags({ sizeChars: 9999 }) })
  assert.ok(compareForPrune(regenFreshSmall, staleBig) < 0, '①键优先于④⑤')
})

test('同级键序：非焦点 → 旧 → 大 → seq 升 tie', () => {
  const focal = mk(1, { focal: true })
  const nonFocal = mk(2, { focal: false })
  assert.ok(compareForPrune(nonFocal, focal) < 0, '③非焦点先剪')
  const fresh = mk(3, { turn: 9 })
  const stale = mk(4, { turn: 1 })
  assert.ok(compareForPrune(stale, fresh) < 0, '④旧者先')
  const small = mk(5, { tags: mkTags({ sizeChars: 10 }) })
  const big = mk(6, { tags: mkTags({ sizeChars: 500 }) })
  assert.ok(compareForPrune(big, small) < 0, '⑤大者先')
  const a = mk(7)
  const b = mk(8)
  assert.ok(compareForPrune(a, b) < 0 && compareForPrune(b, a) > 0, 'tie: rootSeq 升序')
})

test('三值焦点带（v1.1）：none=0 < medium=1 < strong=2；focalBand 优先于布尔回退', () => {
  assert.equal(computeScore({ rootSeq: 1, turn: 5, currentTurn: 10, tags: mkTags(), focalBand: 0 }).focal, 0,
    '★严格相等陷阱：none 档必须映射 0，不得被布尔回退翻成保守 1')
  assert.equal(computeScore({ rootSeq: 1, turn: 5, currentTurn: 10, tags: mkTags(), focalBand: 1 }).focal, 1)
  assert.equal(computeScore({ rootSeq: 1, turn: 5, currentTurn: 10, tags: mkTags(), focalBand: 2, focal: false }).focal, 2,
    'focalBand 给了就优先（focal:false 不得压带）')
  const none = mk(1, { focalBand: 0 })
  const med = mk(2, { focalBand: 1 })
  const strong = mk(3, { focalBand: 2 })
  assert.ok(compareForPrune(none, med) < 0 && compareForPrune(med, strong) < 0, '带序：none 先剪于 medium 先剪于 strong')
  // 布尔通道逐字不变（flat 地基）：undefined=保守 1
  assert.equal(computeScore({ rootSeq: 1, turn: 5, currentTurn: 10, tags: mkTags(), focal: false }).focal, 0)
  assert.equal(computeScore({ rootSeq: 1, turn: 5, currentTurn: 10, tags: mkTags() }).focal, 1)
})

// ---------------------------------------------------------------------------
// 硬保护与降级链
// ---------------------------------------------------------------------------

test('硬保护成员任何压力下不入 pruneOrder', () => {
  const plan = planPrune([
    mk(1, { hard: { stickyMember: true }, tags: mkTags({ sizeChars: 1000 }) }),
    mk(2, { hard: { attachment: true } }),
    mk(3, { hard: { node0: true } }),
    mk(4, { focal: false, regenerable: true }),
  ], { targetReleaseChars: 100000 })
  assert.deepEqual(plan.pruneOrder, [4], '缺口再大也只报 shortfall，不拉硬保护入区')
  assert.deepEqual(plan.hardProtected, [1, 2, 3])
  assert.equal(plan.shortfallChars, 100000 - 100)
})

test('retain 目标是下界：按序取到 ≥ 目标即止（含越界项），不可达如实报缺口', () => {
  const entries = [
    mk(1, { regenerable: true, tags: mkTags({ sizeChars: 60 }) }),   // 第一位
    mk(2, { superseded: true, tags: mkTags({ sizeChars: 50 }) }),    // 第二位
    mk(3, { focal: false, tags: mkTags({ sizeChars: 40 }) }),        // 第三位
  ]
  const plan = planPrune(entries, { targetReleaseChars: 100 })
  assert.deepEqual(plan.pruneOrder, [1, 2], '60 不足，取到 110 越界即止——不回头少剪')
  assert.equal(plan.releasedChars, 110)
  assert.equal(plan.shortfallChars, 0)
  const starved = planPrune(entries, { targetReleaseChars: 200 })
  assert.deepEqual(starved.pruneOrder, [1, 2, 3])
  assert.equal(starved.shortfallChars, 50, '全取仍不足 ⇒ 降级链告警量，不是继续放宽')
})

test('焦点轮非再生 R* 条件保护位（引擎给位，模块只 AND）', () => {
  const guarded = mk(1, { hard: { focalNonRegenerable: true } })
  const left = mk(2) // 离开焦点：引擎不再给位，正常入排序
  const plan = planPrune([guarded, left])
  assert.deepEqual(plan.pruneOrder, [2])
  assert.deepEqual(plan.hardProtected, [1])
})

test('§D 量化臂：净代价标量序（死大先于活小；硬保护不解锁；缺省 lex 不变；臂差异可证）', () => {
  const deadBig = mk(1, { tags: mkTags({ sizeChars: 9000 }), regenerable: true, superseded: true, focalBand: 0 })
  const liveSmall = mk(2, { turn: 10, tags: mkTags({ sizeChars: 2000 }), focalBand: 2 })
  const hardOne = mk(3, { tags: mkTags({ sizeChars: 50000 }), hard: { attachment: true } })
  assert.ok(compareForPrune(deadBig, liveSmall, 'quant') < 0, 'quant：死大净代价高，先剪')
  const planQ = planPrune([liveSmall, deadBig, hardOne], { targetReleaseChars: Infinity, orderMode: 'quant' })
  assert.deepEqual(planQ.hardProtected, [3], 'quant 臂硬保护位绝不入区（§D 不解锁实锤）')
  assert.deepEqual(planQ.pruneOrder, [1, 2], 'quant 序：净代价降序')
  const planL = planPrune([liveSmall, deadBig, hardOne], { targetReleaseChars: Infinity })
  assert.deepEqual(planL.pruneOrder, [1, 2], '缺省 lex 字节不变')
  // 臂差异可证：旧小 vs 中龄大——lex ④age 一票否决旧者先；quant ④⑤连续竞争，
  // 中龄大枚净代价（dead×(size−税)）回补排前。
  const oldSmall = mk(10, { turn: 1, tags: mkTags({ sizeChars: 600 }) })
  const midBig = mk(11, { turn: 4, tags: mkTags({ sizeChars: 8000 }) })
  assert.ok(compareForPrune(oldSmall, midBig, 'lex') < 0, 'lex：④旧者先（age 一票否决）')
  assert.ok(compareForPrune(midBig, oldSmall, 'quant') < 0, 'quant：中龄大枚净代价回补排前')
  // ⚠ 正是这条「中龄大枚先剪」性质导致焦点域 A/B 回退（反复重读的大文件被先驱逐，
  // read 24/36 vs 36/36）——quant 保留为对照臂、缺省维持 lex（台账见 retention-score.ts）。
})
