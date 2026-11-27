/**
 * 单旋钮名册锁（2.0.1：唯一活键 compactionThreshold；2.0.0 退役的五枚保持退役）。
 *
 * 2.0.1 起 `ArgpEngine.Config` 与 `ArgpUserSettingsSchema` 的唯一键 =
 * compactionThreshold（压缩阈值：出口闸触发线 = 声明窗 × 比例，0=关闭撞墙兜底）；
 * 五枚退役旋钮的缺省值固化在 constants.ts，老 profile 写它们只告警、不生效。
 *
 * 变异台账（摘锁必须变红，逐条执行）：
 *  ZK1 static Config 回加第二枚旋钮 ⇒ T1 红（schema 默认键集断言）。
 *  ZK1b schema 的 min/max 边界删除 ⇒ T1 的 1.5 拒收断言红。
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
import { ArgpEngine } from '../src/argp-engine.ts'
import { ArgpUserSettingsSchema } from '../src/session-lifecycle.ts'
import type { FactorEngine } from '../src/factor/engine.ts'
import { describeWorld } from '../src/env-world.ts'
import { renderArgpStatus, type ArgpStatusHost } from '../src/argp-command.ts'
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
  await ctx.plugin(ArgpEngine, { engine: 'factor', windowTokens: 100, retainTokens: 50, ...extra } as never)
  return { ctx, internals: ctx.compaction as unknown as EngineInternals }
}

const RETIRED_KNOBS = ['windowRatio', 'retainRatio', 'charsPerToken', 'focalTurns', 'vocabTopN', 'recallLimit'] as const

test('ZK1 单旋钮名册：static Config 与 ArgpUserSettingsSchema 唯一键 = compactionThreshold（缺省 0=关）', () => {
  const std = (ArgpUserSettingsSchema as unknown as {
    '~standard': { validate: (x: unknown) => { value?: Record<string, unknown>; issues?: unknown[] } }
  })['~standard']
  const validate = (v: unknown): Record<string, unknown> => {
    const r = std.validate(v)
    assert.equal(r.issues === undefined || r.issues.length === 0, true, 'validate 不得报错：' + JSON.stringify(r.issues))
    return r.value as Record<string, unknown>
  }
  const defaults = validate({})
  assert.deepEqual(Object.keys(defaults).sort(), ['compactionThreshold'], 'schema 默认键集 = 唯一活键（回加第二枚=红）')
  assert.equal(defaults.compactionThreshold, 0, '缺省 0 = 关（撞墙 400 兜底）')
  assert.equal(validate({ compactionThreshold: 0.5 }).compactionThreshold, 0.5, '比例可设')
  const bad = std.validate({ compactionThreshold: 1.5 })
  assert.equal((bad.issues ?? []).length > 0, true, '>1 必须被 schema 拒（ZK1b）')
  const tolerant = validate({ windowRatio: 0.5, focalTurns: 2, recallLimit: 7 })
  assert.equal(tolerant.windowRatio, 0.5, '老键宽容透传：validate 不拒（normalizeConfig 据此告警）')
  assert.equal(tolerant.focalTurns, 2)
  assert.equal(tolerant.recallLimit, 7)
  // static Config 同名单（宿主扫描面）；cordis 非 strict 会透传未知键。
  const staticSchema = (ArgpEngine as unknown as {
    Config: { '~standard': { validate: (x: unknown) => { value?: Record<string, unknown> } } }
  }).Config
  const staticDefaults = staticSchema['~standard'].validate({})
  assert.deepEqual(Object.keys(staticDefaults.value ?? {}).sort(), ['compactionThreshold'], 'static Config 唯一活键（回加第二枚=红）')
  // dict 层白名单（非 strict validate 会吞 optional 无 default 的幽灵键——键集以
  // schema 属性字典为准，对抗审查 P2-1）。
  const dictKeys = Object.keys((ArgpEngine as unknown as { Config: { dict?: Record<string, unknown> } }).Config.dict ?? {})
  assert.deepEqual(dictKeys.sort(), ['compactionThreshold'], 'schema 属性字典 = 唯一活键（幽灵键从 validate 缝隙溜过也红）')
  // volatile 键缺省在静态 validate 中物化为占位对象（settings 源驱动实时值）；
  // 其 .get() 必须解析为 0 = 关（改动缺省比例 = 此断言红）。
  const staticValue = (staticDefaults.value ?? {}).compactionThreshold as { get?: () => unknown } | undefined
  const staticResolved = typeof staticValue?.get === 'function' ? staticValue.get() : staticValue
  assert.ok(staticResolved === undefined || staticResolved === 0, 'volatile 静态占位 .get() = 0（关）')
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
  await ctx.plugin(ArgpEngine, { engine: 'factor', recencyGuard: 0, peratom: { compressor: false }, windowTokens: 100, retainTokens: 50 } as never)
  const hit = warns.find(w => w.includes('[argp-factor]') && w.includes('recencyGuard=0'))
  assert.ok(hit !== undefined, '老 graph 键非缺省 ⇒ 宽容读+告警')
  assert.ok(hit.includes('peratom='), 'peratom 块同样在告警名册')

  const gWarns: string[] = []
  const gctx = new Context()
  await mountAgentLoopTestDependencies(gctx, { systemPrompt: { personaPrefix: 'p' } })
  const glogger = gctx.logger as unknown as { warn: (msg: string) => void }
  const greal = glogger.warn.bind(gctx.logger)
  glogger.warn = (msg: string): void => { gWarns.push(msg); greal(msg) }
  await gctx.plugin(ArgpEngine, { engine: 'graph', windowTokens: 100, retainTokens: 50 } as never)
  const graphWarn = gWarns.find(w => w.includes('[argp-factor]') && w.includes('engine='))
  assert.ok(graphWarn !== undefined, 'engine=graph ⇒ 明确告警（不再静默换引擎）')
  assert.ok(graphWarn.includes('1.11.2'), '告警指认老方案冻结点')
})

// ---------------------------------------------------------------------------
// A2：世界指纹（env 派生档 + 生效时机，/argp 一行打印）
// ---------------------------------------------------------------------------

test('A2 describeWorld：缺省世界 = takeover / egress 开（旧公式线）/ 各臂关，且时机标注正确', () => {
  const w = describeWorld({}, 0)
  const fact = (name: string): { value: string; timing: string } | undefined => w.facts.find(f => f.name === name)
  assert.equal(fact('dispatch')?.value, 'takeover')
  assert.equal(fact('dispatch')?.timing, 'live', '分派每请求活读')
  assert.equal(fact('egress')?.value, 'on(old-line)', '接管世界缺省开，线 = 窗−输出预算−2%')
  assert.equal(fact('tiered')?.value, 'flat')
  assert.equal(fact('tiered')?.timing, 'boot', 'tiered 是构造期快照')
  for (const name of ['clip', 'qscore', 'pressure', 'shadow', 'peratomDebug']) {
    assert.equal(fact(name)?.value, 'off', name + ' 缺省关')
  }
  assert.deepEqual(w.overrides, [], '无 env ⇒ 无覆盖回显')
})

test('A2 describeWorld：显式 env 按派生档显示（非法值显示缺省，不原样照抄）', () => {
  const w = describeWorld({
    ARGP_FACTOR_TIER: 'tiered',
    ARGP_FACTOR_DISPATCH: '0',
    ARGP_FACTOR_CLIP: '1',
    ARGP_FACTOR_EGRESS: '0',
    ARGP_FACTOR_SHADOW: 'yes', // 非法：resolveShadowEnabled 只认 '1' ⇒ off
  }, 0)
  const fact = (name: string): string | undefined => w.facts.find(f => f.name === name)?.value
  assert.equal(fact('tiered'), 'tiered')
  assert.equal(fact('dispatch'), 'off')
  assert.equal(fact('clip'), 'on')
  assert.equal(fact('egress'), 'off', 'ARGP_FACTOR_EGRESS=0 硬关')
  assert.equal(fact('shadow'), 'off', '非法值 ⇒ 缺省关（不照抄 yes）')
  assert.deepEqual(w.overrides.map(o => o.key), [
    'ARGP_FACTOR_CLIP', 'ARGP_FACTOR_DISPATCH', 'ARGP_FACTOR_EGRESS', 'ARGP_FACTOR_SHADOW', 'ARGP_FACTOR_TIER',
  ], '显式 env 原样回显（含 0 值）')
})

test('A2 describeWorld：设置「压缩阈值」>0 压过分派缺省（线 = 比例）', () => {
  const w = describeWorld({ ARGP_FACTOR_EGRESS: '0' }, 0)
  assert.equal(w.facts.find(f => f.name === 'egress')?.value, 'off', '显式 0 硬关优先')
  assert.equal(describeWorld({}, 0.6).facts.find(f => f.name === 'egress')?.value, 'on(0.6)')
})

test('A2 /argp：世界行随指纹打印（含 @boot/@live 与显式 env）', async () => {
  const prev = process.env['ARGP_FACTOR_TIER']
  process.env['ARGP_FACTOR_TIER'] = 'flat'
  try {
    const { ctx } = await bootFactor({})
    const engine = ctx.compaction as ArgpEngine
    const session = Session.create(SessionId('world-card'))
    const res = renderArgpStatus(engine as unknown as ArgpStatusHost, { agent: { session } } as never, 'zh')
    const text = res.text ?? ''
    assert.ok(text.includes('世界：'), '世界行在场')
    assert.ok(text.includes('dispatch=takeover@live'), '派生档 + 活读时机')
    assert.ok(text.includes('tiered=flat@boot'), '构造快照时机')
    assert.ok(text.includes('ARGP_FACTOR_TIER=flat'), '显式 env 回显')
  } finally {
    if (prev === undefined) delete process.env['ARGP_FACTOR_TIER']
    else process.env['ARGP_FACTOR_TIER'] = prev
  }
})
