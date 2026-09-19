/**
 * P6 轮内压力压缩（2026-09-19 方案 B）单测锁定。
 *
 * 背景：record2 语料 OFF 臂峰值 99,997 ≈ 触发线 100,007 ⇒ 3-turn 语料上轮内压力档
 * 大概率不触发（turn 边界 100K 先达到），端到端 record 复测观测不到新链路 ⇒
 * 以单测锁定机制面（拍板选项 ②）：
 *
 *  ① pre-step 顺序：压力达标 且 有 open turn ⇒ 先 onPrePressureCompress（压 open
 *     turn 原子）再 compactIfNeeded('pressure')（图剪），同一 pre-step 窗口落地
 *     （两变异合成态 = 用户构想的"拼回"，无独立 restore 机制）。
 *  ② 压力判定同口径：isPressureExceeded 与 compactIfNeeded('pressure') 完全一致
 *     （未达标不压；无 open turn 不压——闭合轮走 idle 边界路径，pre-step 不重复处理）。
 *  ③ 失败隔离：onPrePressureCompress 抛错吞掉，图剪照常（回调失败不阻断会话）。
 *  ④ doneTurns 防重（跨路径）：open turn 被轮内压力档压过 ⇒ 该轮闭合后 idle
 *     prepareCurrentTurn 零调用跳过（替换副本本就被 plugin-source 排除，双保险）。
 *  ⑤ 前缀预算门控：usage 挂 assistant/message 事件 data **顶层**（agent-loop 落账
 *     实证 `{turn, step, message, usage, stream}`；读 `data.message.usage` 恒
 *     undefined ⇒ A 形态被静默全量降级 C）；billed = inputTokens + cacheRead +
 *     cacheWrite 与引擎真实锚点同式；超预算该次降级 C（degradedToC='prefix-budget'，
 *     wire messages 仅指令一条）——"全前缀或无前缀"二元。
 *  ⑥ ctk 形状：{enable_thinking:false, preserve_thinking:false,
 *     reasoning_effort:<主链>}（主链值从 request/header config.reasoningEffort
 *     重建——LlmCallConfig 无 chat_template_kwargs 字段）；max_completion_tokens
 *     输出 cap 默认 16384（plan 的 dialog 保真转写部分与原文同量级，cap 截断 =
 *     JSON 不完整 = 整轮保原文；防爆余量按 262K 墙重标定——r3 实弹 4096 即截断）。
 *     4K cap 是硬要求）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { ArgpGraphEngine } from '../src/argp-graph-engine.ts'
import { PeratomCompressor } from '../src/peratom/compressor.ts'

// ---------------------------------------------------------------------------
// 会话构建器（与 peratom-compressor.test.ts 同款形态；文本互异防版本链硬排除）
// ---------------------------------------------------------------------------

const LONG_DIALOG = '帮我修复这个报错，服务起不来了，先看日志再给出修复步骤：\n'
const DIALOG_QUOTE = '帮我修复这个报错，服务起不来了，先看日志再给出修复步骤：'
const LONG_PASTE = 'Error: listen EADDRINUSE :::3000\n    at Server.setupListenListen (node:net:1917:16)\n'.repeat(4)
const LONG_USER = LONG_DIALOG + LONG_PASTE

function appendUser(session: Session, turn: number, text: string): number {
  session.append('user/message', { turn, ...createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }) } as never, { surfaceOp: 'append' })
  return session.snapshotEvents().length - 1
}

function appendAssistant(session: Session, turn: number, callId: string, usage?: Record<string, number>): number {
  return appendAssistantArgs(session, turn, callId, '{"path":"log.txt"}', usage)
}

function appendAssistantArgs(session: Session, turn: number, callId: string, args: string, usage?: Record<string, number>): number {
  session.append('assistant/message', { stream: [],
    turn,
    step: 1,
    message: {
      role: 'assistant',
      id: 'am_' + callId,
      source: { kind: 'model', provider: 'test', model: 'test' },
      content: [
        { type: 'tool-call', id: callId, name: 'read_file', arguments: args },
        { type: 'text', text: 'on it' },
      ],
    },
    ...(usage === undefined ? {} : { usage }),
  } as never, { surfaceOp: 'append' })
  return session.snapshotEvents().length - 1
}

function appendToolResult(session: Session, turn: number, callId: string, text: string): number {
  session.append('tool/result', {
    turn,
    step: 1,
    message: {
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }], isError: false }],
      source: { kind: 'tool', callId },
      id: 'm_' + callId,
    },
  } as never, { surfaceOp: 'append' })
  return session.snapshotEvents().length - 1
}

function appendTurnEnd(session: Session, turn: number): void {
  session.append('turn/end', { turn, reason: { kind: 'completed' } } as never)
}

const BIG_TOOL_RESULT = ('EADDRINUSE stack line '.padEnd(40, '.') + '\n').repeat(20)

/**
 * 压力达标会话：turns 1-2 闭合（可剪老历史）+ turn 3 open（进行到一半，含
 * 长 user 与大 tool result = compressible）。总字符 ≫ threshold（windowTokens:100,
 * charsPerToken:3.5 ⇒ ~350 chars）。
 */
function buildPressureSession(id: string): { session: Session; openTurn: number; openU: number; openR: number } {
  const session = Session.create(SessionId(id))
  const turn1 = 'u1: ' + 'a'.repeat(160)
  const turn2 = 'u2: ' + 'b'.repeat(160)
  session.append('turn/start', { turn: 1 })
  appendUser(session, 1, turn1)
  appendAssistant(session, 1, 'c1')
  appendToolResult(session, 1, 'c1', 'old-result ' + 'x'.repeat(200))
  appendTurnEnd(session, 1)
  session.append('turn/start', { turn: 2 })
  appendUser(session, 2, turn2)
  appendAssistant(session, 2, 'c2')
  appendToolResult(session, 2, 'c2', 'old-result ' + 'y'.repeat(200))
  appendTurnEnd(session, 2)
  session.append('turn/start', { turn: 3 })
  const openU = appendUser(session, 3, LONG_USER + '\nopen-variant：补充段落使文本与闭合轮互异。')
  appendAssistantArgs(session, 3, 'c3', '{"path":"open-turn-log.txt"}')
  const openR = appendToolResult(session, 3, 'c3', BIG_TOOL_RESULT + 'open-variant tail')
  return { session, openTurn: 3, openU, openR }
}

/** 小会话（估算 < threshold）：turns 1-5 闭合 + turn 6 open（短 user，零 tool result）。 */
function buildSmallSession(id: string): Session {
  const session = Session.create(SessionId(id))
  for (let turn = 1; turn <= 5; turn += 1) {
    session.append('turn/start', { turn })
    appendUser(session, turn, 's' + turn + ': ' + 'y'.repeat(40))
    appendTurnEnd(session, turn)
  }
  session.append('turn/start', { turn: 6 })
  appendUser(session, 6, 'short open user')
  return session
}

// ---------------------------------------------------------------------------
// 引擎层（P6 主路径）：pre-step 钩子顺序 / 同口径 / 失败隔离 / 集成
// ---------------------------------------------------------------------------

async function makeEngine(config: Record<string, unknown> = {}): Promise<{ ctx: Context; engine: ArgpGraphEngine }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: 'argp pre-pressure test' } })
  await ctx.plugin(ArgpGraphEngine, { windowTokens: 100, retainTokens: 50, minSpanChars: 20, recencyGuard: 0, maxPasses: 16, ...config })
  return { ctx, engine: ctx.compaction as ArgpGraphEngine }
}

function stubAgent(session: Session): Agent {
  return { session, options: {} } as Agent
}

function emitPreStep(ctx: Context, agent: Agent): Promise<unknown> {
  return agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { agent, messages: [], turn: 3, step: 2, signal: new AbortController().signal } as never,
    (() => Promise.resolve(undefined)) as never,
  )
}

test('① 顺序：压力达标 + open turn ⇒ onPrePressureCompress 先于图剪，同一 pre-step 内', async () => {
  const calls: number[] = []
  let genAtCompress = -1
  const { ctx, engine } = await makeEngine({
    onPrePressureCompress: async (session: Session) => {
      calls.push(1)
      genAtCompress = session.surface.replaceGeneration
    },
  })
  try {
    const { session } = buildPressureSession('pp-order')
    engine.setSession(session)
    await emitPreStep(ctx, stubAgent(session))
    assert.equal(calls.length, 1, '压力达标 + open turn ⇒ 压缩回调恰被调一次')
    assert.ok(engine.records.length >= 1, '图剪在同一 pre-step 内发生（prune 记录存在）')
    assert.ok(session.surface.replaceGeneration > genAtCompress, '回调执行时图剪尚未发生（压缩先于剪枝）')
  } finally {
    await ctx.fiber.dispose()
  }
})

test('② 同口径：压力未达标 ⇒ 不压、图剪也不动（与 compactIfNeeded pressure 返回 null 一致）', async () => {
  let calls = 0
  const { ctx, engine } = await makeEngine({
    onPrePressureCompress: async () => { calls += 1 },
  })
  try {
    const session = buildSmallSession('pp-below')
    engine.setSession(session)
    const direct = await engine.compactIfNeeded({ session } as never, 'pressure', new AbortController().signal)
    assert.equal(direct, null, '直接调用 compactIfNeeded(pressure) = null')
    await emitPreStep(ctx, stubAgent(session))
    assert.equal(calls, 0, '未达标 ⇒ 压缩回调不触发')
    assert.equal(engine.records.length, 0, '图剪同样不动（同口径）')
  } finally {
    await ctx.fiber.dispose()
  }
})

test('② 无 open turn（全闭合）+ 达标 ⇒ 不压（闭合轮归 idle 边界路径），图剪照常', async () => {
  let calls = 0
  const { ctx, engine } = await makeEngine({
    onPrePressureCompress: async () => { calls += 1 },
  })
  try {
    const { session } = buildPressureSession('pp-closed')
    appendTurnEnd(session, 3) // open turn 闭合 ⇒ detectOpenTurn = null
    engine.setSession(session)
    await emitPreStep(ctx, stubAgent(session))
    assert.equal(calls, 0, '活跃态守卫：无 open turn 不压（防与 idle 路径双压）')
    assert.ok(engine.records.length >= 1, '图剪照常（压力剪枝不受影响）')
  } finally {
    await ctx.fiber.dispose()
  }
})

test('③ 失败隔离：onPrePressureCompress 抛错 ⇒ 吞错不冒泡，图剪照常', async () => {
  let calls = 0
  const { ctx, engine } = await makeEngine({
    onPrePressureCompress: async () => { calls += 1; throw new Error('boom: compress failed') },
  })
  try {
    const { session } = buildPressureSession('pp-isolation')
    engine.setSession(session)
    await assert.doesNotReject(async () => emitPreStep(ctx, stubAgent(session)))
    assert.equal(calls, 1)
    assert.ok(engine.records.length >= 1, '压缩失败后图剪照常执行')
  } finally {
    await ctx.fiber.dispose()
  }
})

test('① 集成：真 compressor 自挂载，一次 pre-step = 压缩事务（先）+ 图剪事务（后），中间无轮边界', async () => {
  const queue: unknown[] = []
  const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
    const next = queue.shift()
    if (next === undefined) throw new Error('fetch test-double: no scripted response')
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(next) } }],
      usage: { completion_tokens: 10 },
    }), { status: 200 })
  }) as typeof fetch
  const { ctx, engine } = await makeEngine({
    peratom: {
      compressor: { endpoint: 'http://fake.test/v1/chat/completions', apiKey: 'k', model: 'm', fetchImpl },
      declarer: false,
      zoom: false,
    },
  })
  try {
    const { session, openTurn, openU, openR } = buildPressureSession('pp-integration')
    engine.setSession(session)
    queue.push({
      splits: [{ seq: openU, quotes: [DIALOG_QUOTE], infoLevel: 'extract', infoText: 'open-turn compressed info' }],
      tools: [{ seq: openR, level: 'extract', text: 'EADDRINUSE stack' }],
    })
    await emitPreStep(ctx, stubAgent(session))
    const compressor = engine.peratomStack!.compressor!
    assert.ok(compressor.records.length >= 1, '压缩发生')
    assert.equal(compressor.records[0]!.turn, openTurn, '压的是 open turn（非闭合轮）')
    assert.ok((compressor.records[0]!.appliedReplaces ?? 0) >= 1, 'open turn 原子被替换')
    const kinds = session.snapshotEvents().map(e => e.type)
    const firstStart = kinds.indexOf('compaction/start')
    const firstEnd = kinds.indexOf('compaction/end')
    const firstPrune = kinds.indexOf('compaction/prune')
    assert.ok(firstStart >= 0 && firstEnd > firstStart, '压缩事务括号存在')
    assert.ok(firstPrune > firstEnd, '图剪发生在压缩事务之后（先压后剪）')
    const between = kinds.slice(firstEnd, firstPrune)
    assert.equal(between.includes('turn/start'), false, '两变异之间无轮边界 ⇒ 同一 pre-step 窗口落地')
    assert.equal(between.includes('turn/end'), false)
    assert.ok(engine.records.length >= 1, '图剪记录存在')
    assert.equal(queue.length, 0, '图剪零 LLM（0-LLM 确定性），唯一脚本化响应被压缩消费')
  } finally {
    await ctx.fiber.dispose()
  }
})

// ---------------------------------------------------------------------------
// compressor 层（P6 支撑面）：doneTurns 跨路径防重 / 预算门控 / ctk 形状
// ---------------------------------------------------------------------------

interface CompressorHarness {
  ctx: Context
  compressor: PeratomCompressor
  bodies: Record<string, unknown>[]
  respond: (decision: unknown) => void
}

async function makeCompressorHarness(config: Record<string, unknown> = {}): Promise<CompressorHarness> {
  const ctx = new Context()
  const bodies: Record<string, unknown>[] = []
  const queue: unknown[] = []
  const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
    const next = queue.shift()
    if (next === undefined) throw new Error('fetch test-double: no scripted response')
    return new Response(JSON.stringify({
      choices: [{ message: { content: typeof next === 'string' ? next : JSON.stringify(next) } }],
      usage: { completion_tokens: 10 },
    }), { status: 200 })
  }) as typeof fetch
  const compressor = new PeratomCompressor(ctx, {
    endpoint: 'http://fake.test/v1/chat/completions',
    apiKey: 'test-key',
    model: 'test-model',
    fetchImpl,
    ...config,
  })
  return { ctx, compressor, bodies, respond: (decision: unknown) => { queue.push(decision) } }
}

async function disposeCompressor(h: CompressorHarness): Promise<void> {
  await h.ctx.fiber.dispose()
}

/** open turn 会话：闭合 turn 1 + open turn 2（长 user + 大 tool result）。 */
function buildOpenTurnSession(id: string, usage?: Record<string, number>): { session: Session; openU: number; openR: number } {
  const session = Session.create(SessionId(id))
  session.append('turn/start', { turn: 1 })
  appendUser(session, 1, 'u1: ' + 'a'.repeat(160))
  appendAssistant(session, 1, 'c0', usage)
  appendToolResult(session, 1, 'c0', 'old ' + 'x'.repeat(200))
  appendTurnEnd(session, 1)
  session.append('turn/start', { turn: 2 })
  const openU = appendUser(session, 2, LONG_USER + '\nopen-variant-pp：补充段落。')
  // open turn 调用参数必须与闭合轮互异：同 name+args 的 R 会被版本链硬排除（设计口径，
  // 见 rNeedCompress 决策序①），压不动 ⇒ open R 无料可压。
  appendAssistantArgs(session, 2, 'c1', '{"path":"open-turn-log.txt"}', usage)
  const openR = appendToolResult(session, 2, 'c1', BIG_TOOL_RESULT + 'open-pp tail')
  return { session, openU, openR }
}

test('④ doneTurns 跨路径防重：open turn 被压力档压过 ⇒ 闭合后 idle prepare 零调用跳过', async t => {
  const h = await makeCompressorHarness()
  t.after(() => disposeCompressor(h))
  const { session, openU, openR } = buildOpenTurnSession('pp-dedup')
  h.respond({
    splits: [{ seq: openU, quotes: [DIALOG_QUOTE], infoLevel: 'extract', infoText: 'open compressed' }],
    tools: [{ seq: openR, level: 'extract', text: 'EADDRINUSE stack' }],
  })
  const rec = await h.compressor.compressOpenTurn(session)
  assert.equal(rec?.turn, 2, '压力档压 open turn 2')
  const callsAfter = h.compressor.calls
  const recordsAfter = h.compressor.records.length
  appendTurnEnd(session, 2) // 该轮闭合
  const idle = await h.compressor.prepareCurrentTurn(session)
  assert.equal(idle, null, '已 done 的轮闭合后 idle prepare 返回 null')
  assert.equal(h.compressor.calls, callsAfter, '零 LLM 调用（防双压）')
  assert.equal(h.compressor.records.length, recordsAfter, '无新 record')
})

test('⑤ 预算门控：usage 挂 data 顶层（agent-loop 实证形状）⇒ 预算内 A 形态前缀在 wire', async t => {
  const h = await makeCompressorHarness()
  t.after(() => disposeCompressor(h))
  const { session, openU, openR } = buildOpenTurnSession('pp-budget-ok', { inputTokens: 50_000, outputTokens: 10 })
  h.respond({
    splits: [{ seq: openU, quotes: [DIALOG_QUOTE], infoLevel: 'extract', infoText: 'compressed' }],
    tools: [{ seq: openR, level: 'extract', text: 'EADDRINUSE stack' }],
  })
  const rec = await h.compressor.compressOpenTurn(session)
  assert.equal(rec?.called, true)
  assert.equal(rec?.degradedToC, undefined, '预算内不降级')
  const body = h.bodies[0]!
  assert.ok(Array.isArray(body.messages) && (body.messages as unknown[]).length > 1, 'A 形态：前缀消息 + 指令尾部')
  assert.equal((body.max_completion_tokens as number | undefined), 16_384, '输出 cap 默认 16384（dialog 保真转写 + tools plan 需容纳；防爆余量按 262K 墙重标定）')
})

test('⑤ 预算门控：三和口径（inputTokens + cacheRead + cacheWrite）超预算 ⇒ 降级 C、wire 仅指令', async t => {
  const h = await makeCompressorHarness()
  t.after(() => disposeCompressor(h))
  // 回归锁：旧实现读 data.message.usage（恒 undefined ⇒ 全量静默降级）且只算
  // inputTokens（高缓存命中率时大幅低估）。此例 inputTokens=10K 单独看在预算内，
  // billed 三和 140K 超预算 ⇒ 必须降级（口径与引擎真实锚点同式）。
  const { session, openU, openR } = buildOpenTurnSession('pp-budget-over', { inputTokens: 10_000, cacheReadTokens: 130_000, outputTokens: 5 })
  h.respond({
    splits: [{ seq: openU, quotes: [DIALOG_QUOTE], infoLevel: 'extract', infoText: 'compressed' }],
    tools: [{ seq: openR, level: 'extract', text: 'EADDRINUSE stack' }],
  })
  const rec = await h.compressor.compressOpenTurn(session)
  assert.equal(rec?.called, true)
  assert.equal(rec?.degradedToC, 'prefix-budget', '超预算该次降级 C，留痕')
  const body = h.bodies[0]!
  assert.equal((body.messages as unknown[]).length, 1, '"全前缀或无前缀"二元：降级后 wire 仅指令一条')
  assert.equal(rec?.appliedReplaces, 2, '降级 C 只丢前缀，压缩动作照常落地')
})

test('⑤ 预算门控：无 usage 可参照（会话头）⇒ 保守降级 C', async t => {
  const h = await makeCompressorHarness()
  t.after(() => disposeCompressor(h))
  const { session, openU, openR } = buildOpenTurnSession('pp-budget-nousage')
  h.respond({
    splits: [{ seq: openU, quotes: [DIALOG_QUOTE], infoLevel: 'extract', infoText: 'compressed' }],
    tools: [{ seq: openR, level: 'extract', text: 'EADDRINUSE stack' }],
  })
  const rec = await h.compressor.compressOpenTurn(session)
  assert.equal(rec?.degradedToC, 'prefix-budget', '无 usage ⇒ 保守降级')
  assert.equal((h.bodies[0]!.messages as unknown[]).length, 1)
})

test('⑥ ctk 形状：et:false + pt:false + 主链 reasoning_effort（request/header 重建）+ 输出 cap', async t => {
  const h = await makeCompressorHarness()
  t.after(() => disposeCompressor(h))
  const { session, openU, openR } = buildOpenTurnSession('pp-ctk', { inputTokens: 50_000, outputTokens: 10 })
  session.append('request/header', { header: { config: { reasoningEffort: 'medium', provider: 'test', model: 'test' } }, reason: 'initial' } as never)
  h.respond({
    splits: [{ seq: openU, quotes: [DIALOG_QUOTE], infoLevel: 'extract', infoText: 'compressed' }],
    tools: [{ seq: openR, level: 'extract', text: 'EADDRINUSE stack' }],
  })
  await h.compressor.compressOpenTurn(session)
  assert.deepEqual(h.bodies[0]!.chat_template_kwargs, {
    enable_thinking: false,
    preserve_thinking: false,
    reasoning_effort: 'medium',
  }, '方案 B ctk：剥离态同态渲染 + 主链 effort 对齐（LCP 实测 99.4% 的请求形状）')
})

test('⑥ ctk 形状：主链未声明 effort ⇒ 不发 reasoning_effort 键（跨模型可移植）', async t => {
  const h = await makeCompressorHarness()
  t.after(() => disposeCompressor(h))
  const { session, openU, openR } = buildOpenTurnSession('pp-ctk-noheader', { inputTokens: 50_000, outputTokens: 10 })
  h.respond({
    splits: [{ seq: openU, quotes: [DIALOG_QUOTE], infoLevel: 'extract', infoText: 'compressed' }],
    tools: [{ seq: openR, level: 'extract', text: 'EADDRINUSE stack' }],
  })
  await h.compressor.compressOpenTurn(session)
  const ctk = h.bodies[0]!.chat_template_kwargs as Record<string, unknown>
  assert.equal(ctk['enable_thinking'], false)
  assert.equal(ctk['preserve_thinking'], false)
  assert.equal('reasoning_effort' in ctk, false, '主链缺失时省略 re 字段（省略 ≠ 默认值）')
})
