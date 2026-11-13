/**
 * P2-4 旋钮名册与 volatile 接线（design-2.0 §3.4）。宿主实测三件为据
 * （deepseek-harness-latest：settings README「no shipped client does so yet」=
 * auto 表单无渲染器；settings/schema.ts volatileForm + mutate 校验 = 可写键必须
 * volatile；vendor/include applyEntryPatches = patch 整块替换）：
 * 设置卡是唯一渲染面、卡片可写集 = static Config 的 volatile 集、写非 volatile 宿主拒。
 *
 * 变异台账（摘锁必须变红，逐条执行）：
 *  CR1 vocabTopN 引擎装配传 getter（mount=1 ⇒ 词表每类至多 1 行）
 *      → 变异「装配处写死 10」= T1 红；
 *  CR3 recallLimit 驱动 recall_history 缺省 limit（mount=7 ⇒ 取回 7 行；缺省 mount ⇒ 5 行
 *      = P2-1 口径逐字保持）→ 变异「recall-labels 的 host.recallLimitOf?.() 摘除恒 5」= T2 红；
 *  CR4 旧 graph 五键与 engine 判别式：2.0 factor-only 一律告警忽略（宽容读=resolve 透传，
 *      见 T4 的 schema 面）→ 变异「normalizeConfig 告警块删」= T3 红；
 *  CR5 ArgpUserSettingsSchema 名册 = 6 枚；旧五键/engine/退役 uaSummaryThreshold
 *      （factor-ua 退役随之除名）不在默认集、但 resolve 宽容
 *      透传不炸（宿主 cordis 非 strict 同构）→ 变异「schema 回加任一旧键」= T4 红。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ArgpGraphEngine } from '../src/argp-graph-engine.ts'
import { ArgpUserSettingsSchema } from '../src/session-lifecycle.ts'
import { ArgpConfigController, en, zh, type ArgpLocaleKey } from '../src/client/argp-config-controller.ts'
import type { FactorEngine } from '../src/factor/engine.ts'
import { execTool, toolText } from './tool-execute-shape.ts'

function appendUser(session: Session, text: string): void {
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
}

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

function makeSession(id: string): Session {
  const session = Session.create(SessionId(id))
  session.append('system/message', { content: 'persona' } as never, { surfaceOp: 'append' })
  return session
}

interface EngineInternals {
  factor: FactorEngine | null
  bindSession(session: Session): void
  stateOf(session: Session): { recallCallsThisTurn: number; resolvedWindowTokens: number }
}

async function bootFactor(extra: Record<string, unknown>, warns?: string[]): Promise<{ ctx: Context; internals: EngineInternals }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: 'config roster persona' } })
  if (warns !== undefined) {
    const logger = ctx.logger as unknown as { warn: (msg: string) => void }
    const real = logger.warn.bind(ctx.logger)
    logger.warn = (msg: string): void => { warns.push(msg); real(msg) }
  }
  await ctx.plugin(ArgpGraphEngine, { engine: 'factor', windowTokens: 100, retainTokens: 50, ...extra } as never)
  return { ctx, internals: ctx.compaction as unknown as EngineInternals }
}

test('CR1 vocabTopN 装配 getter 活读：mount=1 ⇒ 词表每类至多 1 行', async () => {
  const { internals } = await bootFactor({ vocabTopN: 1 })
  const factor = internals.factor as FactorEngine
  const session = makeSession('roster-vocab')
  internals.bindSession(session)
  appendUser(session, '读三个文件')
  appendGroup(session, 1, 'c1', 'read', '{"file_path":"C:/Proj/a.ts"}', 'AAA'.repeat(60))
  appendGroup(session, 2, 'c2', 'read', '{"file_path":"C:/Proj/b.ts"}', 'BBB'.repeat(60))
  appendGroup(session, 3, 'c3', 'read', '{"file_path":"C:/Proj/c.ts"}', 'focus 焦点轮')
  const r = factor.compactIfNeeded(session, 1000)
  assert.ok(r !== null, '前置剪枝发射（turn1/2 的 R 入被剪账本）')
  const vocab = factor.vocabulary(session)
  const docLines = String((vocab as { text?: string }).text ?? '').split('\n').filter(l => l.includes('document:'))
  assert.equal(docLines.length, 1, 'topN=1 ⇒ 词表 document 类恰 1 行（装配处写死/裸值即失配）')
})

test('CR3 recallLimit 驱动 recall_history 缺省 limit（7 ⇒ 7 行；缺省 mount ⇒ 5）', async () => {
  for (const [limitKey, expected] of [[7, 7], [undefined, 5]] as const) {
    const { ctx, internals } = await bootFactor(limitKey === undefined ? {} : { recallLimit: limitKey })
    const factor = internals.factor as FactorEngine
    const session = makeSession('roster-limit-' + String(limitKey ?? 'd'))
    internals.bindSession(session)
    appendUser(session, '批量读')
    const labels: string[] = []
    for (let i = 1; i <= 9; i += 1) {
      const p = 'C:/Proj/f' + i + '.ts'
      labels.push('document:c:/proj/f' + i + '.ts')
      appendGroup(session, i, 'c' + i, 'read', JSON.stringify({ file_path: p }), 'R' + i + ' CONTENT '.repeat(40))
    }
    appendGroup(session, 10, 'c10', 'read', '{"file_path":"C:/Proj/z.ts"}', '焦点活体')
    const r = factor.compactIfNeeded(session, 100_000)
    assert.ok(r !== null, '大批剪枝发射')
    internals.stateOf(session).resolvedWindowTokens = 1_000_000 // 召回预算放行，数行数
    const res = await execTool(ctx, {
      name: 'recall_history', callId: 'q1', agentSession: session,
      args: { labels },
    })
    const rows = toolText(res).split('\n').filter(l => l.startsWith('--- seq=')).length
    assert.equal(rows, expected, '缺省 limit = recallLimit 旋钮（mount=' + String(limitKey) + '）')
  }
})

test('CR4 旧 graph 键：2.0 factor-only 一律告警忽略（含 engine 判别式）', async () => {
  const fWarns: string[] = []
  const fctx = new Context()
  await mountAgentLoopTestDependencies(fctx, { systemPrompt: { personaPrefix: 'p' } })
  const flogger = fctx.logger as unknown as { warn: (msg: string) => void }
  const fReal = flogger.warn.bind(fctx.logger)
  flogger.warn = (msg: string): void => { fWarns.push(msg); fReal(msg) }
  await ctxPlugin(fctx, { engine: 'factor', recencyGuard: 0, peratom: { compressor: false }, windowTokens: 100, retainTokens: 50 })
  const hit = fWarns.find(w => w.includes('[argp-factor]') && w.includes('recencyGuard=0'))
  assert.ok(hit !== undefined, '老键非缺省 ⇒ 宽容读+告警（文案含键与值）')
  assert.ok(hit.includes('focalTurns'), '告警指向替代键')
  assert.ok(hit.includes('peratom='), 'peratom 块同样在告警名册（三管线已退役）')

  const gWarns: string[] = []
  const gctx = new Context()
  await mountAgentLoopTestDependencies(gctx, { systemPrompt: { personaPrefix: 'p' } })
  const glogger = gctx.logger as unknown as { warn: (msg: string) => void }
  const gReal = glogger.warn.bind(gctx.logger)
  glogger.warn = (msg: string): void => { gWarns.push(msg); gReal(msg) }
  await ctxPlugin(gctx, { engine: 'graph', windowTokens: 100, retainTokens: 50 })
  const graphWarn = gWarns.find(w => w.includes('[argp-factor]') && w.includes('engine='))
  assert.ok(graphWarn !== undefined, 'engine=graph ⇒ 明确告警（不再静默换引擎）')
  assert.ok(graphWarn.includes('1.11.2'), '告警指认老方案冻结点')
})

async function ctxPlugin(ctx: Context, cfg: Record<string, unknown>): Promise<void> {
  await ctx.plugin(ArgpGraphEngine, cfg as never)
}

test('CR6 卡片对账：渲染行 = 名册（6）= en/zh 键集；旧键文案清零', () => {
  const scope = {
    subscribe: () => () => {},
    getSnapshot: () => ({ status: 'ready', writable: true, value: {}, base: {}, user: undefined }),
    set: async () => {}, unset: async () => {},
  }
  const state = new ArgpConfigController(scope as never).inject().hooks.argpConfig.getSnapshot()
  const shellKeys = new Set(['available', 'writable', 'dirty', 'invalid', 'saving', 'failed'])
  const rows = Object.keys(state).filter(k => !shellKeys.has(k)).sort()
  assert.deepEqual(rows, ['charsPerToken', 'focalTurns', 'recallLimit', 'retainRatio', 'vocabTopN', 'windowRatio'],
    '控制器投影行必须与 §3.4 名册一一对应（加/减行不联动即红）')
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort(), 'en/zh 键集必须一致')
  for (const r of rows) {
    assert.ok(en[r as ArgpLocaleKey] !== undefined && zh[r as ArgpLocaleKey] !== undefined, r + ' 缺标题文案')
    assert.ok(en[(r + 'Hint') as ArgpLocaleKey] !== undefined && zh[(r + 'Hint') as ArgpLocaleKey] !== undefined, r + ' 缺提示文案')
  }
  const stale = Object.keys(en).filter(k => /^(maxPasses|recencyGuard|turnGuard|minSpanChars|sortMode|uaSummaryThreshold)/.test(k))
  assert.deepEqual(stale, [], '退位旋钮的文案必须清零（残留=渲染不到的死字典项）')
})

test('CR5 schema 名册 = 6 枚（engine 判别式退役）；旧五键无缺省但 validate 宽容透传', () => {
  // 宿主 resolveConfig 经 ~standard.validate（vendor/cordis fiber.ts:50）；非 strict，
  // 未声明键原样透传（vendor/schemastery index.ts:821 merge）——"宽容读"正是这条路。
  const validate = (v: unknown): Record<string, unknown> => {
    const r = (ArgpUserSettingsSchema as unknown as {
      '~standard': { validate: (x: unknown) => { value?: Record<string, unknown>; issues?: unknown[] } }
    })['~standard'].validate(v)
    assert.equal(r.issues === undefined || r.issues.length === 0, true, 'validate 不得对老键报错：' + JSON.stringify(r.issues))
    return r.value as Record<string, unknown>
  }
  const keys = Object.keys(validate({})).sort()
  assert.deepEqual(keys, [
    'charsPerToken', 'focalTurns', 'recallLimit', 'retainRatio', 'vocabTopN', 'windowRatio',
  ].sort(), '名册恰 6 枚（engine 与旧五键、退役 uaSummaryThreshold 均不得回进默认集）')
  const tolerant = validate({ maxPasses: 3, sortMode: 'legacy', engine: 'graph' })
  assert.equal(tolerant.maxPasses, 3, '老键宽容读：validate 不拒、原样透传（normalizeConfig 据此告警忽略）')
  assert.equal(tolerant.sortMode, 'legacy')
  assert.equal(tolerant.engine, 'graph', 'engine 判别式退位但接受透传（构造期告警按 factor 运行）')
  const retired = validate({ uaSummaryThreshold: 12345 })
  assert.equal(retired.uaSummaryThreshold, 12345, '退役 ua 键宽容透传：老 profile 带该键不炸')
})
