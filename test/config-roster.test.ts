/**
 * 零旋钮名册锁（2.0.0：六枚设置项全部退役）。
 *
 * 2.0.0 起 `ArgpGraphEngine.Config` 与 `ArgpUserSettingsSchema` 都是空集；
 * 原六枚旋钮（windowRatio/retainRatio/charsPerToken/focalTurns/vocabTopN/
 * recallLimit）的缺省值固化在 constants.ts，老 profile 写它们只告警、不生效。
 *
 * 变异台账（摘锁必须变红，逐条执行）：
 *  ZK1 static Config 回加任一旋钮 ⇒ T1 红（schema 默认键集断言）。
 *  ZK2 normalizeConfig 的退役告警块删除 ⇒ T2 红（warn 文案断言）。
 *  ZK3 退役键被重新接线（如 recallLimitOf 回读 config）⇒ T3 红（行为仍按固化缺省）。
 *  ZK4 旧 graph 五键/engine 判别式告警块删除 ⇒ T4 红。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ArgpGraphEngine } from '../src/argp-graph-engine.ts'
import { ArgpUserSettingsSchema } from '../src/session-lifecycle.ts'
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
  windowRatio: number
  retainRatio: number
  charsPerToken: number
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

const RETIRED_KNOBS = ['windowRatio', 'retainRatio', 'charsPerToken', 'focalTurns', 'vocabTopN', 'recallLimit'] as const

test('ZK1 名册为空：static Config 与 ArgpUserSettingsSchema 都不含任何旋钮', () => {
  const validate = (v: unknown): Record<string, unknown> => {
    const r = (ArgpUserSettingsSchema as unknown as {
      '~standard': { validate: (x: unknown) => { value?: Record<string, unknown>; issues?: unknown[] } }
    })['~standard'].validate(v)
    assert.equal(r.issues === undefined || r.issues.length === 0, true, 'validate 不得报错：' + JSON.stringify(r.issues))
    return r.value as Record<string, unknown>
  }
  assert.deepEqual(Object.keys(validate({})).sort(), [], 'ArgpUserSettingsSchema 默认键集必须为空')
  const tolerant = validate({ windowRatio: 0.5, focalTurns: 2, recallLimit: 7 })
  assert.equal(tolerant.windowRatio, 0.5, '老键宽容透传：validate 不拒（normalizeConfig 据此告警）')
  assert.equal(tolerant.focalTurns, 2)
  assert.equal(tolerant.recallLimit, 7)
  // static Config 同为空白名单（宿主扫描面）；cordis 非 strict 会透传未知键。
  const staticSchema = (ArgpGraphEngine as unknown as {
    Config: { '~standard': { validate: (x: unknown) => { value?: Record<string, unknown> } } }
  }).Config
  const staticDefaults = staticSchema['~standard'].validate({})
  assert.deepEqual(Object.keys(staticDefaults.value ?? {}).sort(), [], 'static Config 默认键集必须为空（回加旋钮=红）')
})

test('ZK2 退役六键：出现即告警，文案逐键可见', async () => {
  const warns: string[] = []
  await bootFactor({ windowRatio: 1, retainRatio: 1, charsPerToken: 1, focalTurns: 9, vocabTopN: 1, recallLimit: 9 }, warns)
  const hit = warns.find(w => w.includes('[argp-factor]') && w.includes('设置旋钮'))
  assert.ok(hit !== undefined, '退役旋钮必须告警（不静默沿用旧值）')
  for (const key of RETIRED_KNOBS) assert.ok(hit.includes(key + '='), '告警必须含 ' + key + ' 的值')
  assert.ok(hit.includes('windowRatio=0.8') && hit.includes('recallLimit=5'), '告警必须给出固化缺省')
})

test('ZK3 退役键不生效：读取点与召回缺省仍按常量（1/9/7 全部被忽略）', async () => {
  const { ctx, internals } = await bootFactor({ windowRatio: 1, retainRatio: 1, charsPerToken: 1, focalTurns: 9, vocabTopN: 1, recallLimit: 7 })
  assert.equal(internals.windowRatio, 0.8, 'windowRatio 固化为 0.8')
  assert.equal(internals.retainRatio, 0.2, 'retainRatio 固化为 0.2')
  assert.equal(internals.charsPerToken, 3.5, 'charsPerToken 固化为 3.5')
  const factor = internals.factor as FactorEngine
  const session = makeSession('zero-knob-recall')
  internals.bindSession(session)
  appendUser(session, '批量读')
  for (let i = 1; i <= 9; i += 1) {
    appendGroup(session, i, 'c' + i, 'read', JSON.stringify({ file_path: 'C:/Proj/f.ts' }), 'R' + i + ' CONTENT '.repeat(40))
  }
  appendGroup(session, 10, 'c10', 'read', '{"file_path":"C:/Proj/z.ts"}', '焦点活体')
  const r = factor.compactIfNeeded(session, 100_000)
  assert.ok(r !== null, '大批剪枝发射')
  internals.stateOf(session).resolvedWindowTokens = 1_000_000 // 召回预算放行，只数缺省 limit
  const res = await execTool(ctx, {
    name: 'recall_history', callId: 'q1', agentSession: session,
    args: { labels: ['document:c:/proj/f.ts'] },
  })
  const rows = toolText(res).split('\n').filter(l => l.startsWith('--- seq=')).length
  assert.equal(rows, 5, '缺省 limit 固化为 5（recallLimit=7 必须被忽略）')
})

test('ZK3b 词表 topN 固化为 10：vocabTopN=1 不再压成 1 行', async () => {
  const { internals } = await bootFactor({ vocabTopN: 1 })
  const factor = internals.factor as FactorEngine
  const session = makeSession('zero-knob-vocab')
  internals.bindSession(session)
  appendUser(session, '读三个文件')
  appendGroup(session, 1, 'c1', 'read', '{"file_path":"C:/Proj/a.ts"}', 'AAA'.repeat(60))
  appendGroup(session, 2, 'c2', 'read', '{"file_path":"C:/Proj/b.ts"}', 'BBB'.repeat(60))
  appendGroup(session, 3, 'c3', 'read', '{"file_path":"C:/Proj/c.ts"}', 'focus 焦点轮')
  const r = factor.compactIfNeeded(session, 1000)
  assert.ok(r !== null, '前置剪枝发射')
  const vocab = factor.vocabulary(session)
  const docLines = String((vocab as { text?: string }).text ?? '').split('\n').filter(l => l.includes('document:'))
  assert.equal(docLines.length, 2, 'topN 固定 10 ⇒ 两个被剪 document 标签全列（旧旋钮 1 会只剩 1 行）')
})

test('ZK4 旧 graph 键与 engine 判别式：仍告警忽略（宽容读不炸）', async () => {
  const warns: string[] = []
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: 'p' } })
  const logger = ctx.logger as unknown as { warn: (msg: string) => void }
  const real = logger.warn.bind(ctx.logger)
  logger.warn = (msg: string): void => { warns.push(msg); real(msg) }
  await ctx.plugin(ArgpGraphEngine, { engine: 'factor', recencyGuard: 0, peratom: { compressor: false }, windowTokens: 100, retainTokens: 50 } as never)
  const hit = warns.find(w => w.includes('[argp-factor]') && w.includes('recencyGuard=0'))
  assert.ok(hit !== undefined, '老 graph 键非缺省 ⇒ 宽容读+告警')
  assert.ok(hit.includes('peratom='), 'peratom 块同样在告警名册')

  const gWarns: string[] = []
  const gctx = new Context()
  await mountAgentLoopTestDependencies(gctx, { systemPrompt: { personaPrefix: 'p' } })
  const glogger = gctx.logger as unknown as { warn: (msg: string) => void }
  const greal = glogger.warn.bind(gctx.logger)
  glogger.warn = (msg: string): void => { gWarns.push(msg); greal(msg) }
  await gctx.plugin(ArgpGraphEngine, { engine: 'graph', windowTokens: 100, retainTokens: 50 } as never)
  const graphWarn = gWarns.find(w => w.includes('[argp-factor]') && w.includes('engine='))
  assert.ok(graphWarn !== undefined, 'engine=graph ⇒ 明确告警（不再静默换引擎）')
  assert.ok(graphWarn.includes('1.11.2'), '告警指认老方案冻结点')
})
