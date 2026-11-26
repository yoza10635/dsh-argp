/**
 * §B-1 压缩分派纯函数单测：决策表全格 + 三域实验地面真值复演 + 影子门。
 *
 * 地面真值（windowscan 2026-11-24，compose.py 快照口径）：
 *  - 工具域（32K/64K）：F ≤ R ∧ 供给足 → 仅剪（0 LLM）；
 *  - 散文域（32K/64K）：F > R ∧ 散文 ≥ F−R ∧ 直发可行 → 先摘后剪；
 *  - 焦点/B-6 域（32K）：F=12377 > R=6553 ∧ 散文 3721 < F−R=5824 → 不摘要、剪到下限求生。
 *
 * 2.3.0 规则A 口径改（design-2.2.x §1.2/§1.3）：判据②③ = **aged（span 可驱逐口径）散文
 * ≥ 开单地板 max(1536, 5%·W_eff)**（存在性判据，非释放量预测）∧ 份额闸 工具面/C < 0.5
 * （θ 固化）；①缺口地板与④transcript（total 口径）不变。三域地面真值形态不动
 * （aged 缺省回退 total），新增 46 轮账本判决级行见文末。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { planForm, resolveDispatchMode, resolveDispatchShadowEnabled, resolveDispatchShadowLogPath,
  DEFAULT_PROSE_MIN_TOKENS, DEFAULT_GAP_FLOOR_RATIO, TRANSCRIPT_SAFETY_RATIO, DEFAULT_INSTRUCTION_TOKENS, DEFAULT_MIN_SUMMARY_OUT_TOKENS,
  type DispatchSnapshot } from '../src/factor/dispatch.ts'

const base: DispatchSnapshot = {
  trigger: 'pressure',
  contextTokens: 60_000,
  retainTokens: 12_800,
  windowEff: 64_000,
  floorTokens: 20_000,
  prunableTokens: 40_000,
  condensableProseTokens: 30_000,
  summarySendTokens: 4_000,
}
const snap = (over: Partial<DispatchSnapshot>): DispatchSnapshot => ({ ...base, ...over })

test('0 无需压缩：C ≤ R → none（overflow 触发除外）', () => {
  assert.equal(planForm(snap({ contextTokens: 10_000 })).form, 'none')
  // overflow 是 provider 已确认超窗：即便估算 C ≤ R 也继续走物理判据。
  const d = planForm(snap({ trigger: 'context-overflow', contextTokens: 10_000, floorTokens: 70_000 }))
  assert.equal(d.form, 'terminal-b6')
})

test('1 物理终态：F > W_eff → terminal-b6（手动不绕物理）', () => {
  const d = planForm(snap({ floorTokens: 65_000, prunableTokens: 0 }))
  assert.equal(d.form, 'terminal-b6')
  assert.equal(planForm(snap({ trigger: 'manual', floorTokens: 64_001, prunableTokens: 0 })).form, 'terminal-b6')
})

test('2 仅剪：F ≤ R 且供给覆盖 α×deficit（工具域真值）', () => {
  const d = planForm(snap({ floorTokens: 8_000, prunableTokens: 52_000 }))
  assert.equal(d.form, 'prune-only')
  assert.match(d.reason, /仅剪/)
})

test('2b 仅剪弱余量：F ≤ R 但 P < α·D 也不转摘要（判据① F>R 不成立）', () => {
  const d = planForm(snap({ floorTokens: 12_700, prunableTokens: 47_300, supplyMargin: 2 }))
  assert.equal(d.form, 'prune-only')
  assert.match(d.reason, /弱余量/)
})

test('3 不摘要的求生剪：F > R 过地板但散文补不上缺口（焦点域轮2 实录）', () => {
  // 轮2 实机快照（disp2 focus 19:15:01）：gap 7454 > 地板 6554，prose 1020（真 user 散文）
  // < 开单地板 1638（max(1536, 5%·32768)，2.3.0 口径；旧口径为 < 缺口）→ 正确拒绝摘要。
  // 旧代码把 30KB 再注入词汇表算进散文（10972）才会误判该摘（exclude 分类器同进退）。
  const d = planForm(snap({
    contextTokens: 27_023, retainTokens: 5_242, windowEff: 32_768,
    floorTokens: 12_696, prunableTokens: 14_327, condensableProseTokens: 1_020,
  }))
  assert.equal(d.form, 'prune-only')
  assert.match(d.reason, /不摘要/)
})

test('3a 缺口地板：F 高出 R 几个 K 属软目标可容忍超调（工具域轮2 实锤，5 次血亏摘要被拦）', () => {
  // gap ≤ max(proseMin, 0.2×W_eff)=6554：全部仅剪。
  for (const F of [5_411, 8_487, 10_136, 8_635]) {
    const d = planForm(snap({
      contextTokens: 26_600, retainTokens: 5_242, windowEff: 32_768,
      floorTokens: F, prunableTokens: 26_600 - F, condensableProseTokens: 6_000,
    }))
    assert.equal(d.form, 'prune-only', `F=${F} 应走仅剪`)
    assert.match(d.reason, /软目标|超调/)
  }
})

test('3b sub-K 散文不起摘要（③下限，非判据）', () => {
  const d = planForm(snap({
    retainTokens: 12_800, windowEff: 32_768, floorTokens: 20_000,
    condensableProseTokens: DEFAULT_PROSE_MIN_TOKENS - 1,
  }))
  assert.equal(d.form, 'prune-only')
  assert.match(d.reason, /补不上|下限|开单地板/)
})

test('4 先摘后剪：摘要值得做且直发可行、有可剪面（散文域真值形态）', () => {
  const d = planForm(snap({ floorTokens: 50_000, prunableTokens: 10_000, condensableProseTokens: 48_000 }))
  assert.equal(d.form, 'summarize-then-prune')
  // 轮2 实机快照（disp2 prose 19:14:16）：gap 15321 > 地板 6554、prose 19092 ≥ gap、
  // transcript 21002 装得下 32768 → 先摘后剪（轮1 同场景被 C+send 判据误判先剪后摘）。
  const live = planForm(snap({
    contextTokens: 26_898, retainTokens: 5_242, windowEff: 32_768,
    floorTokens: 20_563, prunableTokens: 6_335, condensableProseTokens: 19_092, summarySendTokens: 6_553,
  }))
  assert.equal(live.form, 'summarize-then-prune')
  assert.match(live.reason, /transcript/)
})

test('4b 仅摘：直发可行但无可剪供给', () => {
  const c = 60_000
  const d = planForm(snap({ contextTokens: c, floorTokens: c, prunableTokens: 0, condensableProseTokens: 55_000 }))
  assert.equal(d.form, 'summarize-only')
})

test('5 先剪后摘不可达（代码+档案双实锤）：摘要请求尺寸=transcript，剪工具不影响它', () => {
  // 旧判据（C+send>W_eff ∧ F+send≤W_eff）必判先剪后摘的参数组合，新判据下仍是
  // 先摘后剪——摘要请求自 buildProseMessages 起就不含工具原子（prose-condenser.ts:541），
  // 剪不剪它都一样大，「独有一次大 miss」的前提在本架构不成立。
  const d = planForm(snap({
    contextTokens: 63_500, floorTokens: 30_000, prunableTokens: 33_500,
    condensableProseTokens: 25_000, summarySendTokens: 15_000,
  }))
  assert.equal(d.form, 'summarize-then-prune')
  assert.match(d.reason, /transcript/)
})

test('5b transcript 超窗摘不出：仅剪求生，不空转', () => {
  const d = planForm(snap({
    contextTokens: 63_500, floorTokens: 52_000, prunableTokens: 11_500,
    condensableProseTokens: 63_000, summarySendTokens: 15_000,
  }))
  assert.equal(d.form, 'prune-only')
  assert.match(d.reason, /仅剪求生/)
})

test('不变量：形态守恒——摘要形态只在 transcript 装得下 W_eff 时出现；先剪后摘永不出；terminal 只在 F>W_eff', () => {
  // 粗网格扫参数组合，验证形态与判据的蕴含关系（纯函数确定性顺带覆盖）。
  for (const C of [10_000, 60_000, 63_500]) {
    for (const F of [5_000, 30_000, 52_000, 65_000]) {
      for (const prose of [500, 3_721, 25_000, 48_000, 63_000]) {
        for (const send of [2_000, 15_000]) {
          const s = snap({ contextTokens: C, floorTokens: F, prunableTokens: Math.max(0, C - F), condensableProseTokens: prose, summarySendTokens: send })
          const d1 = planForm(s)
          assert.deepEqual(d1, planForm(s), '纯函数确定性')
          assert.notEqual(d1.form, 'prune-then-summarize', '先剪后摘本架构不可达，planForm 永不发射')
          if (d1.form === 'terminal-b6') assert.ok(F > s.windowEff)
          if (d1.form === 'summarize-then-prune' || d1.form === 'summarize-only') {
            assert.ok(F > s.retainTokens, '摘要形态蕴含判据① F>R')
            assert.ok(F - s.retainTokens > Math.max(DEFAULT_PROSE_MIN_TOKENS, DEFAULT_GAP_FLOOR_RATIO * s.windowEff),
              '摘要形态蕴含缺口地板 F−R > max(proseMin, ρ·W_eff)（软目标超调不值一次 miss）')
            // 发送判据按 transcript（可浓缩散文 ×1.1 + 指令 + 输出地板），与 C 无关。
            const transcript = Math.ceil(prose * TRANSCRIPT_SAFETY_RATIO)
            assert.ok(transcript + DEFAULT_INSTRUCTION_TOKENS + DEFAULT_MIN_SUMMARY_OUT_TOKENS <= s.windowEff,
              '摘要形态 ⇒ transcript 装得下 W_eff（留得出指令+输出地板）')
          }
        }
      }
    }
  }
})

// ── 2.3.0 规则A：aged 开单判据 + 份额闸（design-2.2.x §1.2/§1.3，T42 翻转为判决级锚）──
test('T42 翻转：aged ≥ 开单地板但 total 补不上缺口 ⇒ 旧缺口口径误判仅剪，新 aged 口径先摘后剪', () => {
  // §0 表 T42 行：入场 C 191.5K、老化散文 38.8K、total 散文 111.1K、工具份额 18.8%。
  // F 取 160K（gap 118K > total 111.1K）⇒ 旧判据「prose < gap」判仅剪（g2 型浅剪连发）；
  // 新判据② aged 38.8K ≥ 开单地板 13.1K、份额闸 18.8% < θ ⇒ 过闸 → transcript 装得下 → 先摘后剪。
  const s = snap({
    contextTokens: 191_471, retainTokens: 41_943, windowEff: 262_144,
    floorTokens: 160_000, prunableTokens: 31_471,
    condensableProseTokens: 111_140, condensableProseAgedTokens: 38_800, toolFaceTokens: 36_000,
  })
  const d = planForm(s)
  assert.equal(d.form, 'summarize-then-prune', '新 aged 口径必须放行摘要（翻转为绿）')
  assert.match(d.reason, /transcript/)
  // 变异锁（git 回滚验红）：判据② 回退旧「total < gap」缺口释放预测 ⇒ total 111.1K <
  // gap 118K ⇒ prune-only，本条红。aged 字段缺省回退只护旧快照，不恢复缺口比较。
})

test('barrier 断供：aged < 开单地板但 total 足 ⇒ 仅剪（焦点/barrier 面不算供给，护原文）', () => {
  const s = snap({
    contextTokens: 100_000, retainTokens: 12_800, windowEff: 100_000,
    floorTokens: 50_000, prunableTokens: 50_000,
    condensableProseTokens: 40_000, condensableProseAgedTokens: 2_000,
  })
  const d = planForm(s)
  assert.equal(d.form, 'prune-only', 'aged 2K < 地板 5K ⇒ 不摘要（gap 37.2K < total 40K 旧口径会误摘）')
  assert.match(d.reason, /老化可浓缩散文/)
})

test('份额闸：工具面/C ≥ θ(0.5) ⇒ 仅剪（剪扛杠杆）；toolFaceTokens 缺省 0 ⇒ 旧全测不触发（兼容锚）', () => {
  const s = snap({
    contextTokens: 100_000, retainTokens: 12_800, windowEff: 100_000,
    floorTokens: 80_000, prunableTokens: 20_000,
    condensableProseTokens: 18_000, condensableProseAgedTokens: 18_000, toolFaceTokens: 60_000,
  })
  const d = planForm(s)
  assert.equal(d.form, 'prune-only', '工具面 60% ≥ θ ⇒ 份额闸关闭摘要')
  assert.match(d.reason, /工具面仍主导/)
  // 同参去掉 toolFaceTokens ⇒ 份额闸不触发，回落到 transcript 判据放行摘要（兼容性锚）。
  assert.equal(planForm(snap({ ...s, toolFaceTokens: undefined })).form, 'summarize-then-prune',
    'toolFaceTokens 缺省 ⇒ 份额闸恒不触发（旧快照行为不变）')
})

test('§0 表复演：6 摘要行（aged 足、工具非主导）过新判据；3 仅剪/none 行（T40b/T43b 小窗 line-0）', () => {
  // 六笔扫荡式摘要事务入场（aged ≥ 地板、工具份额 <θ、transcript 装得下 W_eff）。
  const summarizeRows = [
    { contextTokens: 184_600, aged: 88_200, tool: 44_000 }, // T13
    { contextTokens: 186_700, aged: 100_700, tool: 42_600 }, // T21
    { contextTokens: 184_500, aged: 70_400, tool: 46_900 }, // T31
    { contextTokens: 185_000, aged: 38_000, tool: 35_100 }, // T36（aged 38K 实吞 115K=存在性非释放）
    { contextTokens: 172_700, aged: 74_500, tool: 23_000 }, // T40a
    { contextTokens: 170_400, aged: 75_600, tool: 23_900 }, // T43a
  ]
  for (const r of summarizeRows) {
    const d = planForm(snap({
      trigger: 'context-overflow', contextTokens: r.contextTokens, retainTokens: 41_943, windowEff: 262_144,
      floorTokens: r.contextTokens - 20_000, prunableTokens: 20_000,
      condensableProseTokens: r.aged + 60_000, condensableProseAgedTokens: r.aged, toolFaceTokens: r.tool,
    }))
    assert.equal(d.form, 'summarize-then-prune', `摘要行 C=${r.contextTokens} 必须放行`)
  }
  // T40b/T43b：小入场窗（22.7K/49K）< R 侧 ⇒ line-0 无摘要（缺省 retain 口径下 none/prune-only）。
  for (const c of [22_700, 49_000]) {
    const d = planForm(snap({ contextTokens: c, retainTokens: 41_943, windowEff: 262_144, floorTokens: c - 5_000, prunableTokens: 5_000, condensableProseTokens: 2_000, condensableProseAgedTokens: 2_000 }))
    assert.ok(d.form === 'none' || d.form === 'prune-only', `小窗 C=${c} 不得摘要`)
  }
})

test('分派模式：缺省即接管（2.2.0 裁定）；0=旧世界逃生口；1=影子；2=显式接管', () => {
  assert.equal(resolveDispatchMode({}), 'takeover', '未设 ⇒ 接管')
  assert.equal(resolveDispatchMode({ ARGP_FACTOR_DISPATCH: '0' }), 'off', '显式退回旧双闸世界')
  assert.equal(resolveDispatchMode({ ARGP_FACTOR_DISPATCH: '1' }), 'shadow')
  assert.equal(resolveDispatchMode({ ARGP_FACTOR_DISPATCH: '2' }), 'takeover')
  assert.equal(resolveDispatchShadowEnabled({ ARGP_FACTOR_DISPATCH: '0' }), false)
  assert.equal(resolveDispatchShadowEnabled({}), true, '接管也记决策日志（取证面）')
  assert.equal(resolveDispatchShadowLogPath({}), undefined)
  assert.equal(resolveDispatchShadowLogPath({ ARGP_FACTOR_DISPATCH_LOG: '' }), undefined)
  assert.equal(resolveDispatchShadowLogPath({ ARGP_FACTOR_DISPATCH_LOG: 'x.jsonl' }), 'x.jsonl')
})

// ── 集成守卫：影子块只读——开/关两世界 engine.compactIfNeeded 发射逐字节一致 ──
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ArgpEngine } from '../src/argp-engine.ts'
import { sessionEvents, eventText } from '../src/log-access.ts'

function appendGroup(session: Session, turn: number, callId: string, tool: string, args: string, resultText: string): void {
  session.append('assistant/message', {
    stream: [], turn, step: 1,
    message: createAssistantMessage({
      source: { provider: 'test', model: 'test' },
      content: [{ type: 'text', text: 'doing ' + tool }, { type: 'tool-call', id: callId, name: tool, arguments: args } as never],
    }),
  } as never, { surfaceOp: 'append' })
  session.append('tool/call', { turn, callId, name: tool, arguments: args } as never)
  session.append('tool/result', {
    turn, step: 1,
    message: {
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: resultText }], isError: false }],
      source: { kind: 'tool', callId },
      id: 'm_' + callId,
    },
  } as never, { surfaceOp: 'append' })
}

async function runOnce(id: string): Promise<string[]> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: 'dispatch test persona' } })
  // windowTokens 显式放大：prose 闸二不满足 → 不触 LLM 通路，纯剪枝发射可确定性对照。
  await ctx.plugin(ArgpEngine, { windowTokens: 100_000, retainTokens: 50, recencyGuard: 0, maxPasses: 8 })
  const engine = ctx.compaction as ArgpEngine
  const session = Session.create(SessionId(id))
  session.append('system/message', { content: 'persona' } as never, { surfaceOp: 'append' })
  ;(engine as unknown as { declaredContextWindows: WeakMap<Session, number> }).declaredContextWindows.set(session, 64_000)
  ;(engine as unknown as { bindSession: (s: Session) => void }).bindSession(session)
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: '开始任务' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  appendGroup(session, 1, 'c1', 'read', '{"file_path":"C:/Proj/a.ts"}', 'OLD CONTENT'.repeat(60))
  appendGroup(session, 2, 'c2', 'read', '{"file_path":"C:/Proj/b.ts"}', 'NEW CONTENT'.repeat(60))
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: '收尾' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  const agent = { session, options: {} } as never
  const result = await engine.compactIfNeeded(agent, 'pressure', new AbortController().signal)
  const events = sessionEvents(session) as unknown as Array<{ seq: number; type: string }>
  // compactionId 是每次事务随机的 UUID——归一化掉，其余必须逐字节一致。
  const normalized = JSON.stringify(result, (k, v) => k === 'compactionId' ? '<id>' : v)
  return [normalized, ...events.map(e => e.type), ...[...session.surface.nodes].map(s => eventText(session, s as number))]
}

test('§B-1 影子集成：旧世界(0)与影子(1)compactIfNeeded 发射逐字节一致；影子决策落盘', async () => {
  const logf = join(tmpdir(), 'argp-dispatch-shadow-' + Date.now() + '.jsonl')
  let off: string[]
  process.env['ARGP_FACTOR_DISPATCH'] = '0'
  try {
    off = await runOnce('dispatch-shadow-off')
  } finally {
    delete process.env['ARGP_FACTOR_DISPATCH']
  }
  process.env['ARGP_FACTOR_DISPATCH'] = '1'
  process.env['ARGP_FACTOR_DISPATCH_LOG'] = logf
  let on: string[]
  try {
    on = await runOnce('dispatch-shadow-on')
  } finally {
    delete process.env['ARGP_FACTOR_DISPATCH']
    delete process.env['ARGP_FACTOR_DISPATCH_LOG']
  }
  try {
    assert.ok(off.length > 3, '会话确有发射（事件 + surface 文本）')
    assert.deepEqual(on, off, '影子块不得改变任何发射')
    assert.ok(existsSync(logf), '设了 LOG 路径时决策应落盘')
    const rec = JSON.parse(readFileSync(logf, 'utf-8').trim().split('\n').pop() as string)
    assert.ok(['none', 'prune-only', 'summarize-only', 'summarize-then-prune', 'prune-then-summarize', 'terminal-b6'].includes(rec.form), '落盘记录含合法 form')
    assert.ok(typeof rec.C_or_floor === 'number' || typeof rec.floorTokens === 'number', '落盘记录含 F 快照')
  } finally {
    if (existsSync(logf)) unlinkSync(logf)
  }
})
