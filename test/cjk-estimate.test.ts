/**
 * Issue5 回归锁（design-2.1.0-batch §3）：CJK 自适应密度估算 estTokens = nonCjk/3.5 + cjk/κ。
 * 三道不变量落锁：
 *  ① anchored 判定面零触碰——锚点基数=usage 真值，latin 增量逐字同旧口径；
 *  ② 非 CJK-only 文本估算逐字不变（含白名单外西里尔/谚文/emoji/全角）；
 *  ③ 设置名册不动（ZK1 复跑覆盖，本文件不重复）。
 * 加权侧：纯 CJK/混排按 κ=1.7（constants 标定常数，测试用同一常数=锁口径一致）。
 * 变异映射：M25 去 CJK 加权 → CT2/CT3/CT6 红；M26 去 latin 分量 → CT1/CT4 红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ArgpEngine } from '../src/argp-engine.ts'
import { measureTokens, visibleCharStats, liveBlendCharsPerToken, type BudgetHost } from '../src/budget.ts'
import { countCjkChars, estTokens, estTokensFromStats } from '../src/cjk.ts'
import { DEFAULT_CHARS_PER_TOKEN, CJK_CHARS_PER_TOKEN } from '../src/constants.ts'
import { eventText } from '../src/log-access.ts'

async function bootFactor(): Promise<{ ctx: Context; engine: ArgpEngine }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: 'cjk persona' } })
  await ctx.plugin(ArgpEngine, { engine: 'factor', windowTokens: 100, retainTokens: 50, recencyGuard: 0 })
  return { ctx, engine: ctx.compaction as unknown as ArgpEngine }
}

function makeSession(id: string): Session {
  const session = Session.create(SessionId(id))
  session.append('system/message', { content: 'persona' } as never, { surfaceOp: 'append' })
  return session
}

function appendUser(session: Session, turn: number, text: string): void {
  session.append('user/message', { ...createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), turn } as never, { surfaceOp: 'append' })
}

const LATIN = 'the quick brown fox jumps over the lazy dog while measuring chars per token '
const CJK = '中文自适应密度估算把每个汉字按标定系数折算成令牌而不是统一按三七五近似标定读数收敛于一七〇'
assert.ok(countCjkChars(CJK) === CJK.length && CJK.length > 20)

test('CT1 等价锁：非 CJK 文本（含白名单外）估算与旧口径 chars/3.5 逐字相同', () => {
  for (const n of [1, 3, 35, 1000, 99999]) {
    assert.equal(Math.ceil(estTokensFromStats(n, 0)), Math.ceil(n / DEFAULT_CHARS_PER_TOKEN))
  }
  assert.equal(estTokens(LATIN + LATIN), (LATIN.length * 2) / DEFAULT_CHARS_PER_TOKEN)
  // 白名单外字符一律 nonCjk：西里尔 / 谚文 / emoji（代理对）/ 全角形式（FF00 段非 3000 段）
  const outside = 'Привет мир 한국인 😀 （）：！？123'
  assert.equal(countCjkChars(outside), 0)
  assert.equal(estTokens(outside), outside.length / DEFAULT_CHARS_PER_TOKEN)
  // 白名单内中日韩标点（3000 段）走 CJK 桶：、。《》
  assert.equal(countCjkChars('、。《》'), 4)
})

test('CT2 纯 CJK：κ 加权生效且方向=修正低估（估算较旧口径 ≈ 3.5/1.7 倍）', () => {
  const text = CJK.repeat(7)
  const old = Math.ceil(text.length / DEFAULT_CHARS_PER_TOKEN)
  const est = Math.ceil(estTokens(text))
  assert.equal(est, Math.ceil(text.length / CJK_CHARS_PER_TOKEN))
  assert.ok(est > old * 1.8 && est < old * 2.3, `CJK 修正倍率异常：old=${old} est=${est}`)
})

test('CT3 混排：分量加权和精确可加（锁口径=同一 κ 常数）', () => {
  const text = LATIN + CJK + LATIN + CJK
  const cjk = countCjkChars(text)
  assert.ok(cjk > 0 && cjk < text.length)
  const exact = (text.length - cjk) / DEFAULT_CHARS_PER_TOKEN + cjk / CJK_CHARS_PER_TOKEN
  assert.equal(estTokens(text), exact)
  // 混合密度介于两常数之间
  const blend = text.length / estTokens(text)
  assert.ok(blend > CJK_CHARS_PER_TOKEN && blend < DEFAULT_CHARS_PER_TOKEN)
})

test('CT4 anchored 判定面锁（不变量①）：锚点基数零动，latin 增量逐字同旧口径', async () => {
  const { engine } = await bootFactor()
  const s = makeSession('cjk-anchor')
  const host = engine as unknown as BudgetHost
  appendUser(s, 1, LATIN)
  const st = engine.stateOf(s)
  st.lastRealAnchorSeq = s.seq
  st.lastRealPromptTokens = 5000
  const base = measureTokens(host, s)
  assert.equal(base.source, 'anchored')
  assert.equal(base.contextTokens, 5000) // 增量=0：锚点覆盖全部已落盘事件
  appendUser(s, 2, LATIN)
  let deltaChars = 0
  for (const seq of s.surface.nodes) if (seq >= st.lastRealAnchorSeq) deltaChars += eventText(s, seq).length
  const withDelta = measureTokens(host, s)
  assert.equal(withDelta.contextTokens, 5000 + Math.ceil(deltaChars / DEFAULT_CHARS_PER_TOKEN))
})

test('CT5 liveBlend 密度：latin surface 精确回 3.5；CJK surface 落入 (κ, 3.5)；recall 预算随密度收缩', async () => {
  const { engine } = await bootFactor()
  const lat = makeSession('cjk-blend-lat')
  appendUser(lat, 1, LATIN.repeat(20))
  const cjkS = makeSession('cjk-blend-cjk')
  appendUser(cjkS, 1, CJK.repeat(20))
  const stLat = visibleCharStats(lat)
  const stCjk = visibleCharStats(cjkS)
  assert.equal(stCjk.cjk, stCjk.chars)
  assert.ok(stLat.cjk === 0)
  // 空 surface 与 latin surface 精确回退常数密度（floor 不抖）
  assert.equal(liveBlendCharsPerToken(makeSession('cjk-blend-empty'), 3.5), 3.5)
  assert.equal(liveBlendCharsPerToken(lat, 3.5), 3.5)
  const blendCjk = liveBlendCharsPerToken(cjkS, 3.5)
  assert.ok(blendCjk > CJK_CHARS_PER_TOKEN && blendCjk < DEFAULT_CHARS_PER_TOKEN, `blend=${blendCjk}`)
  // engine 公开方法与会话样本同源
  assert.equal(engine.liveCharsPerToken(lat), 3.5)
  assert.ok(Math.abs(engine.liveCharsPerToken(cjkS) - blendCjk) < 1e-12)
})

test('CT6 b6RiskSummary：CJK 不可剪面按 κ 折算（触发线较旧口径提前）', async () => {
  const { ctx, engine } = await bootFactor()
  const s = makeSession('cjk-b6')
  s.append('request/context', { contextWindow: 1000 } as never)
  const evs = s.snapshotEvents()
  ;(ctx as unknown as { emit: (n: string, ...a: unknown[]) => void }).emit('session/event', s, evs[evs.length - 1])
  const text = CJK.repeat(40)
  appendUser(s, 1, text)
  const r = engine.b6RiskSummary(s)
  assert.equal(r.nonPrunableTokens, Math.ceil(text.length / CJK_CHARS_PER_TOKEN))
  assert.ok(r.nonPrunableTokens > Math.ceil(text.length / DEFAULT_CHARS_PER_TOKEN) * 1.8)
})
