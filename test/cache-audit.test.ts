/**
 * 每请求缓存审计（2.2.3）。
 *
 * 锁面（每条摘除/改判据必须变红）：
 *  1. usage 三分量互斥口径：prompt = 未命中 + 命中 + 写缓存，命中率按 prompt 归一；
 *  2. 分类：压缩后**首请求**低命中 = 必然重灌；同一事务后的**续作**低命中 = 异常；
 *  3. 小 prompt 的低命中不报异常（冷启噪声不得淹没真信号）；
 *  4. 引擎接线：`compaction/end`（无 error）才置事务游标；后续请求都归属该事务，
 *     只有第一条算首请求；
 *  5. 失败事务（带 error）不得置游标——否则失败压缩会被算作"压缩后重灌"；
 *  6. `/argp` 段 5 露出最近样本与两次计数。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ArgpEngine } from '../src/argp-engine.ts'
import {
  buildRequestCacheSample,
  classifyCacheSample,
  isLowCacheHit,
  REFILL_MAX_HIT_RATIO,
  REFILL_MIN_PROMPT_TOKENS,
} from '../src/cache-audit.ts'
import { renderArgpStatus, type ArgpStatusHost } from '../src/argp-command.ts'
import type { SessionRuntimeState } from '../src/session-state.ts'

// ---------------------------------------------------------------------------
// 纯函数面
// ---------------------------------------------------------------------------

test('buildRequestCacheSample：三分量互斥求和 + 命中率归一', () => {
  const s = buildRequestCacheSample({
    at: 1000, turn: 3, step: 2,
    inputTokens: 3403, cacheReadTokens: 236000, cacheWriteTokens: 5000,
    compaction: null, firstAfterCompaction: false,
  })
  assert.equal(s.promptTokens, 244403, 'prompt = 未命中 + 命中 + 写缓存')
  assert.equal(s.uncachedTokens, 3403)
  assert.equal(s.cachedTokens, 236000)
  assert.ok(Math.abs(s.hitRatio - 236000 / 244403) < 1e-9)
  assert.equal(s.compactionId, null, '无事务 ⇒ 不虚构出处')
  assert.equal(s.sinceCompactionMs, null)
  assert.equal(s.firstAfterCompaction, false)
})

test('buildRequestCacheSample：缺字段/负数一律钳 0，prompt=0 不产出 NaN 命中率', () => {
  const s = buildRequestCacheSample({
    at: 0, turn: null, step: null,
    inputTokens: -5, cacheReadTokens: Number.NaN, cacheWriteTokens: 0,
    compaction: null, firstAfterCompaction: false,
  })
  assert.equal(s.promptTokens, 0)
  assert.equal(s.hitRatio, 0)
})

test('buildRequestCacheSample：事务归属带间隔毫秒，且 firstAfter 由调用方游标决定', () => {
  const s = buildRequestCacheSample({
    at: 50_000, turn: 7, step: 1,
    inputTokens: 239_000, cacheReadTokens: 500, cacheWriteTokens: 0,
    compaction: { id: 'argp-tx-9', at: 47_000 }, firstAfterCompaction: true,
  })
  assert.equal(s.compactionId, 'argp-tx-9')
  assert.equal(s.sinceCompactionMs, 3000)
  assert.equal(s.firstAfterCompaction, true)
})

test('classifyCacheSample：首请求低命中=重灌、续作低命中=异常、首请求高命中=缓存续作', () => {
  const base = {
    at: 0, turn: 1, step: 1, cacheWriteTokens: 0, sinceCompactionMs: 0,
  }
  const first = (cached: number, uncached: number, first_ = true) => classifyCacheSample(buildRequestCacheSample({
    ...base, inputTokens: uncached, cacheReadTokens: cached,
    compaction: { id: 'argp-1', at: 0 }, firstAfterCompaction: first_,
  }))
  assert.equal(first(0, 239_000), 'post-compaction-refill', '★压缩后首请求几乎 0 命中 ⇒ 必然重灌')
  assert.equal(first(236_000, 3_400), 'post-compaction-cached', '宿主保留可复用前缀')
  assert.equal(first(0, 239_000, false), 'unexpected-refill', '★同一事务后第二发仍 0 命中 ⇒ 另有抖前缀源')
  assert.equal(first(236_000, 3_400, false), 'steady')
})

test('classifyCacheSample：无事务时低命中=冷启，高命中=稳态', () => {
  const mk = (cached: number, uncached: number) => classifyCacheSample(buildRequestCacheSample({
    at: 0, turn: 1, step: 1, inputTokens: uncached, cacheReadTokens: cached, cacheWriteTokens: 0,
    compaction: null, firstAfterCompaction: false,
  }))
  assert.equal(mk(0, 50_000), 'cold-start')
  assert.equal(mk(40_000, 10_000), 'steady')
})

test('isLowCacheHit：小 prompt 低命中不算异常（冷启噪声闸）', () => {
  const mk = (prompt: number, cached: number) => buildRequestCacheSample({
    at: 0, turn: 1, step: 1, inputTokens: prompt - cached, cacheReadTokens: cached, cacheWriteTokens: 0,
    compaction: { id: 'argp-1', at: 0 }, firstAfterCompaction: false,
  })
  assert.equal(isLowCacheHit(mk(REFILL_MIN_PROMPT_TOKENS - 1, 0)), false)
  assert.equal(isLowCacheHit(mk(REFILL_MIN_PROMPT_TOKENS, 0)), true)
  assert.equal(isLowCacheHit(mk(100_000, Math.ceil(100_000 * REFILL_MAX_HIT_RATIO))), false,
    '恰在界线上不算低命中（严格小于）')
})

// ---------------------------------------------------------------------------
// 引擎接线 + /argp 露出
// ---------------------------------------------------------------------------

interface TestEngine {
  bindSession(session: Session): void
  stateOf(session: Session): SessionRuntimeState
  noteCompactionEnd(session: Session, event: unknown): void
  recordCacheSample(session: Session, event: unknown, usage: Record<string, number>): void
}

/**
 * 分发注入点直调：`Session.create` 出来的独立会话不接 SessionStore，`append` 不会
 * 发 `session/event`（宿主里由 store 的 emitCtx 承担）。这里喂的是**与宿主同形**的
 * 事件对象（type/data/turn），锁的是处理逻辑本身，不是 cordis 的分发管道。
 */
function emitEnd(internals: TestEngine, session: Session, data: Record<string, unknown>): void {
  internals.noteCompactionEnd(session, { type: 'compaction/end', data })
}

async function boot(): Promise<{ ctx: Context; engine: ArgpEngine }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: 'cache audit persona' } })
  await ctx.plugin(ArgpEngine, { engine: 'factor', windowTokens: 100, retainTokens: 50, recencyGuard: 0 })
  return { ctx, engine: ctx.compaction as ArgpEngine }
}

function reply(internals: TestEngine, session: Session, turn: number, step: number, usage: Record<string, number>): void {
  // 真实事件形状：assistant/message 携带 turn/step 与 usage（dsh-session types）。
  session.append('assistant/message', {
    turn, step,
    message: createAssistantMessage({ source: { provider: 'test', model: 'test' }, content: [{ type: 'text', text: 'ok' }] }),
    stream: [],
    usage,
  } as never, { surfaceOp: 'append' })
  internals.recordCacheSample(session, { type: 'assistant/message', data: { turn, step, usage } }, usage)
}

test('compaction/end 置游标：首请求归因事务、续作只记同一 tx 但不算首请求', async () => {
  const { engine } = await boot()
  const internals = engine as unknown as TestEngine
  const session = Session.create(SessionId('cache-audit-wire'))
  internals.bindSession(session)

  emitEnd(internals, session, { compactionId: 'argp-tx-1', turn: 5 })
  assert.equal(internals.stateOf(session).lastCompaction?.id, 'argp-tx-1')

  // 压缩后首请求：239K prompt 只命中 1.5K（≈0 hit）= 全量重灌。
  reply(internals, session, 5, 1, { inputTokens: 238_000, outputTokens: 300, cacheReadTokens: 1_500 })
  // 第二发：命中恢复（236K/239.4K）。
  reply(internals, session, 5, 2, { inputTokens: 3_403, outputTokens: 200, cacheReadTokens: 236_000 })

  const st = internals.stateOf(session)
  assert.equal(st.cacheSamples.length, 2)
  const [first, second] = st.cacheSamples
  assert.equal(first?.firstAfterCompaction, true, '★事务后第一条带 usage 的应答=首请求')
  assert.equal(first?.compactionId, 'argp-tx-1')
  assert.equal(classifyCacheSample(first!), 'post-compaction-refill')
  assert.equal(second?.firstAfterCompaction, false, '续作不再是首请求')
  assert.equal(second?.compactionId, 'argp-tx-1', '仍归属同一事务（才能识别"续作仍失配"）')
  assert.equal(classifyCacheSample(second!), 'steady')
  assert.equal(st.compactionAwaitingReply, false)
})

test('失败事务（compaction/end 带 error）不置游标——不把失败压缩当压缩后重灌', async () => {
  const { engine } = await boot()
  const internals = engine as unknown as TestEngine
  const session = Session.create(SessionId('cache-audit-failed-tx'))
  internals.bindSession(session)

  emitEnd(internals, session, { compactionId: 'argp-tx-bad', turn: 3, error: 'boom' })
  reply(internals, session, 3, 1, { inputTokens: 120_000, outputTokens: 100, cacheReadTokens: 0 })

  const sample = internals.stateOf(session).cacheSamples[0]
  assert.equal(sample?.compactionId, null, '★失败事务不得成为归属')
  assert.equal(sample?.firstAfterCompaction, false)
  assert.equal(classifyCacheSample(sample!), 'cold-start')
})

test('事务后跨轮才到的应答视为陈旧标记，不算首请求', async () => {
  const { engine } = await boot()
  const internals = engine as unknown as TestEngine
  const session = Session.create(SessionId('cache-audit-stale'))
  internals.bindSession(session)

  emitEnd(internals, session, { compactionId: 'argp-tx-old', turn: 2 })
  reply(internals, session, 9, 1, { inputTokens: 80_000, outputTokens: 100, cacheReadTokens: 0 })

  const st = internals.stateOf(session)
  assert.equal(st.cacheSamples[0]?.firstAfterCompaction, false, '★隔了 7 轮的应答不能算"压缩后首请求"')
  assert.equal(st.cacheSamples[0]?.compactionId, null, '陈旧事务不再归因')
  assert.equal(st.compactionAwaitingReply, false, '游标已消费，不会无限期挂着')
})

test('/argp 段 5：小 prompt 的低命中不是失配（缓存块粒度未达，不得报警）', async () => {
  // 实测形态（2026-11-27 本机端点）：压缩把 19 万字符压到 3.2K 后，请求 prompt 只剩
  // 1,011 token、cached=0 —— 而该端点缓存块粒度是 2048，1K prompt 结构上不可能报告命中。
  // 这不是"续作又失配"，若报警就是卡面自己制造噪声。
  const { engine } = await boot()
  const internals = engine as unknown as TestEngine
  const session = Session.create(SessionId('cache-audit-small-prompt'))
  internals.bindSession(session)

  emitEnd(internals, session, { compactionId: 'argp-tx-small', turn: 4 })
  reply(internals, session, 4, 1, { inputTokens: 979, outputTokens: 20, cacheReadTokens: 0 })
  reply(internals, session, 4, 2, { inputTokens: 1_011, outputTokens: 20, cacheReadTokens: 0 })

  const result = renderArgpStatus(engine as unknown as ArgpStatusHost, { agent: { session } } as never)
  const text = result.kind === 'success' ? (result.text ?? '') : ''
  assert.doesNotMatch(text, /repeat-miss/, '★1K prompt 的 0 命中不得标 repeat-miss')
  assert.doesNotMatch(text, /refill \[tx/, '首请求同理（块粒度未达）')
  assert.match(text, /post-compaction: 0 refill\(s\) · 0 repeat miss\(es\)/, '两枚计数都为 0')
})

test('/argp 段 5：露出最近样本 + 重灌/续作失配计数', async () => {
  const { engine } = await boot()
  const internals = engine as unknown as TestEngine
  const session = Session.create(SessionId('cache-audit-status'))
  internals.bindSession(session)

  emitEnd(internals, session, { compactionId: 'argp-tx-77', turn: 4 })
  reply(internals, session, 4, 1, { inputTokens: 239_000, outputTokens: 300, cacheReadTokens: 1_200 })
  reply(internals, session, 4, 2, { inputTokens: 230_000, outputTokens: 300, cacheReadTokens: 1_000 })

  const result = renderArgpStatus(engine as unknown as ArgpStatusHost, { agent: { session } } as never)
  assert.equal(result.kind, 'success')
  const text = result.kind === 'success' ? (result.text ?? '') : ''
  assert.match(text, /cache \(provider usage/, '段 5 标题')
  assert.match(text, /prompt 240\.2k \/ cached 1\.2k \(0%\)/, '首请求行：prompt/cached/命中率')
  assert.match(text, /refill \[tx argp-tx-77\]/, '首请求标记重灌 + 事务 id')
  assert.match(text, /repeat-miss \[tx argp-tx-77\]/, '★续作仍失配单独标记')
  assert.match(text, /post-compaction: 1 refill\(s\) · 1 repeat miss\(es\)/, '两枚计数')
})
