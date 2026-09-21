/**
 * HLS 修复档不变式（PROPOSAL-token-ontology 组件 B，v1.2.0）：
 *  - I-B1 对任意候选，repaired 通过保真守卫（50 轮随机扰动 property test）
 *  - I-B2 no-op 守卫先于修复档（零收益副本不修复）
 *  - I-B3 修复只追加：candidate 逐字节不变、补入 token 全部来自原文
 *  - I-B4 图侧兼容：尾注不影响 cites 前缀解析，推断边仍命中修复副本
 *  - planReplacements 集成：tool/info 两路的 HLS 落地 + 台账 + 回退语义
 *  - I-B5 经济学门控：ROI = 净释放/尾注 ≥ θ（缺省 1）才修复，否则退回原文保面
 *    （代价盲修正——修复后接近/超过原文长度的病态区间被拦下，spike39 F1/F4 形态）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { planReplacements, type CompressDecision, type CurrentTurnCollect } from '../src/peratom/compressor.ts'
import { ArgpGraphEngine, type Atom } from '../src/argp-graph-engine.ts'
import { fidelityGuard, findLoadBearingTokens, hlsRepairEconomics, repairWithTrailer } from '../src/token-ontology.ts'

const POOL = [
  'src/engine/core.ts:141:19',
  'https://example.com/api/v2/health',
  '3f9c2a1e-8b7d-4e6f-9a0b-1c2d3e4f5a6b',
  'DEAD_BEEF_CODE',
  'budget=256MiB',
  'FAIL_OVER_01',
]

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    const tmp = a[i]!; a[i] = a[j]!; a[j] = tmp
  }
  return a
}

test('I-B1: 任意候选的 repaired 通过保真守卫（50 轮随机扰动 property test）', () => {
  for (let i = 0; i < 50; i += 1) {
    const nTok = 3 + Math.floor(Math.random() * 2)
    const toks = shuffle(POOL).slice(0, nTok)
    const original = 'context ' + toks.join(' mid ') + ' tail'
    const kept = shuffle(toks).slice(0, Math.floor(Math.random() * toks.length)) // 随机保留 0..n-1 个
    const candidate = 'summary ' + kept.join(' ')
    const guard = fidelityGuard(original, candidate)
    // P3.6 真空守卫：kept 至多保留 n-1 个 token（slice 上界 < toks.length）⇒ 候选必丢
    // ≥1 个承重 token ⇒ guard.missing 非空 ⇒ 下方 repaired 真正走了"尾注补全"修复路径。
    // 若未来改动使 missing 恒空，repaired 退化为 candidate 恒等、断言平凡通过 = 假绿，
    // 此守卫立即失败。
    assert.ok(guard.missing.length > 0, `round ${i}: 候选须丢失 ≥1 个承重 token（否则修复路径未被执行，真空通过）`)
    const repaired = repairWithTrailer(candidate, guard.missing)
    assert.equal(fidelityGuard(original, repaired).ok, true,
      `round ${i}: repaired 必须 100% 硬 token 保真（保真由构造）`)
  }
})

test('I-B3: 修复只追加——candidate 逐字节不变，补入 token 全部来自原文', () => {
  const original = 'fail ERR_ZZZ_09 at src/aa/bb.ts:7 uuid=11112222-3333-4444-5555-666677778888'
  const candidate = 'fail at bb'
  const guard = fidelityGuard(original, candidate)
  assert.ok(!guard.ok)
  const repaired = repairWithTrailer(candidate, guard.missing)
  assert.equal(repaired.slice(0, candidate.length), candidate, 'candidate 前缀逐字节不变')
  assert.ok(repaired.startsWith(candidate))
  const trailer = repaired.slice(candidate.length)
  assert.ok(trailer.startsWith('\n[restored] '), '尾注格式')
  const added = trailer.slice('\n[restored] '.length).split(' ')
  const origTokens = new Set(findLoadBearingTokens(original))
  for (const t of added) {
    assert.ok(origTokens.has(t), `补入 token "${t}" 必须来自原文承重词表`)
  }
})

test('I-B2: no-op 守卫先于修复档——近零收益副本（≥95%）缺 token 也不修复', () => {
  // 每行 ≈214 字符 × 30 = 6420；替换 12→7 字符 × 30 = −150 → 97.7% ≥ 95%
  const line = 'ERR_ALPHA_01 ' + 'x '.repeat(100) + '\n'
  const toolText = line.repeat(30)
  const candidate = toolText.replaceAll('ERR_ALPHA_01 ', 'alpha01 ')
  assert.ok(candidate.length >= toolText.length * 0.95, 'fixture 须过 no-op 阈值')
  const collect: CurrentTurnCollect = {
    turn: 1,
    startSeq: 5,
    endSeq: 5,
    interrupted: false,
    userLong: [],
    toolResults: [{ kind: 'tool-result', seq: 5, turn: 1, text: toolText, callId: 'c1' }],
  }
  const plan = planReplacements(
    collect,
    { splits: [], tools: [{ seq: 5, level: 'extract', text: candidate }] },
    [],
    { hlsMode: 'trailer' },
  )
  assert.equal(plan.skippedNoopGain, 1, 'no-op 先行拦截')
  assert.equal(plan.hlsRepairs, 0, '不进入修复档（I-B2）')
  assert.equal(plan.steps.length, 0)
})

test('I-B4: 图侧兼容——尾注不影响 cites 前缀解析；推断边命中修复副本后被声明边去重', async () => {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: 'argp hls-plan test persona' } })
  await ctx.plugin(ArgpGraphEngine, { windowTokens: 100, retainTokens: 50, minSpanChars: 20, recencyGuard: 0, maxPasses: 16, inferredStopwordRatio: 1.0 })
  const engine = ctx.compaction as ArgpGraphEngine
  // HLS 修复后的 R 原子：candidate 首行 + 尾注（硬 token 在尾注里逐字在场）
  const original = 'src/alpha/one.ts:77 payload line'
  const candidate = 'eviction payload'
  const repaired = repairWithTrailer(candidate, fidelityGuard(original, candidate).missing)
  const atoms: Atom[] = [
    { id: 0, seq: 1, turn: 1, type: 'R', text: repaired, toolCallIds: [], cites: [], citesFailed: false },
    { id: 1, seq: 2, turn: 2, type: 'A', text: 'saw src/alpha/one.ts:77 payload', toolCallIds: [], cites: [{ text: 'eviction payload', level: 'supporting' }], citesFailed: false },
  ]
  const { edges } = engine.buildGraph(atoms)
  // cites 前缀（candidate 首行）不受尾注影响 → 解析命中
  assert.equal(edges.length, 1, '声明边 1 条（推断边同 (from,to) 去重）')
  assert.equal(edges[0]!.level, 'supporting', '声明先行：最终边是声明级别，不是 inferred')
  assert.equal(engine.inferredStats.skippedDup, 1)
  // 修复副本的 n-gram 可用性：尾注 token 逐字在场（前缀解析/版本链键的底座）
  assert.ok(repaired.includes('one.ts:77'))
})

test('plan：tool extract 被拒且 ROI ≥ θ → HLS 尾注落地（restoredByGuard 台账）；off/缺省 = v1.1 硬拒', () => {
  // ROI 可过门形态（probe 实测 ROI=1.396）：长原文 + 大幅压缩的候选 + 少量短 missing。
  const toolText = 'Error: the connection pool refused new sessions with EADDRINUSE at src/db/pool.ts:88 after thirty seconds of retries, and the reporting job failed to obtain any connection; rollback the pool config change and restart the gateway to recover the service.'
  const candidate = 'connection pool refused new sessions after retries; reporting job could not obtain a connection; rollback pool config and restart gateway'
  const collect: CurrentTurnCollect = {
    turn: 1,
    startSeq: 5,
    endSeq: 5,
    interrupted: false,
    userLong: [],
    toolResults: [{ kind: 'tool-result', seq: 5, turn: 1, text: toolText, callId: 'c9' }],
  }
  const origEvent = {
    type: 'tool/result',
    seq: 5,
    time: 0,
    surfaceOp: 'append',
    data: {
      message: {
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: 'c9', content: [{ type: 'text', text: toolText }], isError: false }],
        source: { kind: 'tool', callId: 'c9' },
      },
    },
  } as never
  const decision: CompressDecision = { splits: [], tools: [{ seq: 5, level: 'extract', text: candidate }] }

  // hlsMode='trailer'：拒收 → 门控放行 → 修复落地
  const plan = planReplacements(collect, decision, [origEvent], { hlsMode: 'trailer' })
  assert.equal(plan.steps.length, 1, '修复副本落地')
  assert.equal(plan.hlsRepairs, 1)
  assert.equal(plan.hlsRoiSkipped, 0, 'ROI ≥ θ：门控未拦截')
  assert.equal(plan.skippedFidelity, 0, '修复不是拒收（与 skippedFidelity 互斥语义）')
  const missing = fidelityGuard(toolText, candidate).missing
  assert.deepEqual(plan.restoredByGuard, missing, '台账 = 守卫缺失清单')
  const step = plan.steps[0] as { data: { message: { content: Array<{ content: Array<{ type: string; text: string }> }> } } }
  const text = step.data.message.content[0]!.content[0]!.text
  assert.equal(text, repairWithTrailer(candidate, missing))
  assert.ok(text.endsWith('[restored] ' + missing.join(' ')))
  assert.equal(fidelityGuard(toolText, text).ok, true, '落地文本 100% 硬 token 保真（构造性）')

  // hlsMode='off'：v1.1 硬拒原文保面
  const off = planReplacements(collect, decision, [origEvent], { hlsMode: 'off' })
  assert.equal(off.steps.length, 0)
  assert.equal(off.skippedFidelity, 1)
  assert.equal(off.hlsRepairs, 0)
  // 缺省（独立调用方）= off
  const def = planReplacements(collect, decision, [origEvent])
  assert.equal(def.skippedFidelity, 1, '缺省保守默认')
})

test('plan：ROI < θ（修复后 ≥ 原文，代价盲病态区间）→ 门控退回 v1.1 原文保面', () => {
  // spike39 F1/F4 形态：原文短、候选压缩有限、missing 长而多 → 修复文本比原文还长。
  // probe 实测：original=87 candidate=46 trailer=58 repaired=104 → ROI=-0.293。
  const toolText = 'Error ERR_CACHE_EVICTION_0x1F4 at src/cache/lru.ts:141:19 victim=txn#8821 budget 256MiB'
  const candidate = 'cache eviction at lru.ts line 141 for txn 8821'
  const econ = hlsRepairEconomics(toolText.length, candidate.length, fidelityGuard(toolText, candidate).missing)
  assert.ok(econ.roi < 1, `fixture 必须落在门控拦截区（实测 ROI=${econ.roi.toFixed(3)}）`)
  assert.ok(econ.netRelease < 0, 'fixture 的修复文本须比原文更长（净释放为负）')
  const collect: CurrentTurnCollect = {
    turn: 1,
    startSeq: 5,
    endSeq: 5,
    interrupted: false,
    userLong: [],
    toolResults: [{ kind: 'tool-result', seq: 5, turn: 1, text: toolText, callId: 'c9' }],
  }
  const origEvent = {
    type: 'tool/result',
    seq: 5,
    time: 0,
    surfaceOp: 'append',
    data: {
      message: {
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: 'c9', content: [{ type: 'text', text: toolText }], isError: false }],
        source: { kind: 'tool', callId: 'c9' },
      },
    },
  } as never
  const plan = planReplacements(
    collect,
    { splits: [], tools: [{ seq: 5, level: 'extract', text: candidate }] },
    [origEvent],
    { hlsMode: 'trailer' },
  )
  assert.equal(plan.steps.length, 0, '无落地步骤（原子保原文）')
  assert.equal(plan.hlsRepairs, 0, '不修复（越修越长）')
  assert.equal(plan.hlsRoiSkipped, 1, '门控拒收入账')
  assert.equal(plan.skippedFidelity, 1, '与拒收同向（原子保原文）')
  assert.deepEqual(plan.restoredByGuard, [], '无尾注补入')
})

test('plan：info extract 被拒且 ROI ≥ θ → U-info append 文本 = candidate + 尾注（summary 元数据同步）', () => {
  const raw = 'Error: the connection pool refused new sessions with EADDRINUSE at src/db/pool.ts:88 after thirty seconds of retries, and the reporting job failed to obtain any connection; rollback the pool config change and restart the gateway to recover the service.'
  const splitText = '检查A：' + raw + '检查B：'
  const collect: CurrentTurnCollect = {
    turn: 1,
    startSeq: 3,
    endSeq: 3,
    interrupted: false,
    userLong: [{ kind: 'user-long', seq: 3, turn: 1, text: splitText }],
    toolResults: [],
  }
  const candidate = 'connection pool refused new sessions after retries; reporting job could not obtain a connection; rollback pool config and restart gateway'
  const plan = planReplacements(
    collect,
    { splits: [{ seq: 3, quotes: ['检查A：', '检查B：'], infoLevel: 'extract', infoText: candidate }], tools: [] },
    [],
    { hlsMode: 'trailer' },
  )
  assert.equal(plan.hlsRepairs, 1)
  assert.equal(plan.hlsRoiSkipped, 0)
  assert.equal(plan.skippedFidelity, 0)
  const missing = fidelityGuard(raw, candidate).missing
  assert.ok(missing.includes('EADDRINUSE'))
  const info = plan.steps[1] as { kind: string; data: { content?: { text: string }[]; [k: string]: unknown } }
  assert.equal(info.kind, 'append')
  const text = info.data.content?.[0]?.text
  assert.equal(text, repairWithTrailer(candidate, missing))
  // 单档 summary 元数据 = surface 同文本
  const meta = info.data['argp'] as { summary: string }
  assert.equal(meta.summary, text, 'ARG_NS.summary 同步为修复文本')
  assert.equal(fidelityGuard(raw, text).ok, true)
})

test('plan：info extract ROI < θ → 门控退回原文保面（append 文本 = info 原文，无尾注）', () => {
  const raw = 'Error EADDRINUSE at src/cache/lru.ts:141:19 victim=txn#8821'
  const splitText = '检查A：' + raw + '检查B：'
  const collect: CurrentTurnCollect = {
    turn: 1,
    startSeq: 3,
    endSeq: 3,
    interrupted: false,
    userLong: [{ kind: 'user-long', seq: 3, turn: 1, text: splitText }],
    toolResults: [],
  }
  const candidate = 'cache eviction at lru.ts line 141 for txn 8821'
  const plan = planReplacements(
    collect,
    { splits: [{ seq: 3, quotes: ['检查A：', '检查B：'], infoLevel: 'extract', infoText: candidate }], tools: [] },
    [],
    { hlsMode: 'trailer' },
  )
  assert.equal(plan.hlsRepairs, 0, '不修复（越修越长）')
  assert.equal(plan.hlsRoiSkipped, 1, '门控拒收入账')
  assert.equal(plan.skippedFidelity, 1)
  assert.deepEqual(plan.restoredByGuard, [])
  const info = plan.steps[1] as { kind: string; data: { content?: { text: string }[]; [k: string]: unknown } }
  assert.equal(info.data.content?.[0]?.text, raw, 'info 副本 = 原文保面（v1.1 行为）')
  const meta = info.data['argp'] as { summary: string }
  assert.equal(meta.summary, raw, '元数据同步为原文')
})

test('plan：summary 档不受 HLS 影响（审计放行，无尾注）', () => {
  const raw = 'Error EADDRINUSE at src/cache/lru.ts:141:19 victim=txn#8821'
  const splitText = '检查A：' + raw + '检查B：'
  const collect: CurrentTurnCollect = {
    turn: 1,
    startSeq: 3,
    endSeq: 3,
    interrupted: false,
    userLong: [{ kind: 'user-long', seq: 3, turn: 1, text: splitText }],
    toolResults: [],
  }
  const plan = planReplacements(
    collect,
    { splits: [{ seq: 3, quotes: ['检查A：', '检查B：'], infoLevel: 'summary', infoText: 'lru 缓存淘汰触发绑定失败' }], tools: [] },
    [],
    { hlsMode: 'trailer' },
  )
  assert.equal(plan.hlsRepairs, 0, 'summary 不走 HLS（本就审计放行）')
  const info = plan.steps[1] as { data: { content?: { text: string }[] } }
  assert.equal(info.data.content?.[0]?.text, 'lru 缓存淘汰触发绑定失败', '无 [restored] 尾注')
  assert.ok(plan.summaryDropped?.includes('EADDRINUSE'), '审计账不变')
})
