/**
 * 三级触发（**1.5.0**）默认契约锁定。
 *
 *   L1 轮初主动：本 turn 首个 pre-step（`payload.step === 1`）判定；估值必须计入本步已
 *      claiming、尚未落盘进 surface 的 user 消息（`payload.messages`）——它是精确值，不是
 *      预测（宿主 `agent.ts:244` 先 claim、`:250` 才 dispatch 本钩子）。轮初 = per-atom pass
 *      （原子降熵）+ 图剪。
 *   L1' 轮中压力剪（1.5.0 起默认**开**）：`step > 1` 且压力达标即剪，**只做 0-LLM 图剪**，
 *      且放宽 `turnGuard`（`midTurnTurnGuard`，默认 0）——真会话存档实证：超额的来源就是
 *      本轮的上一批 tool result，而 turnGuard=1 恰把它整轮保护起来（这正是 1.3.x 轮中剪
 *      "只剪 1 原子/154 tok、却每次断一次前缀缓存"的根因）。剪落在这个 pre-step ⇒ 同一
 *      step 的请求即已瘦身 = **自动继续本 turn**（无需等下一次触发）。
 *   L2 反应式（turn 仍在跑）：只有"输出被钳制"（finish=max-tokens 且 outputTokens < 本次
 *      请求的 maxTokens）之后，才在下一 pre-step 强制剪（`context-overflow` 绕过阈值早检），
 *      `reactiveRetries` 封顶、同一 turn 内第 2 次起放宽守卫。
 *   L3 截断续写（1.5.0 核心）：本轮要收（`agent/turn-stopping`）时若仍有待消费的钳制信号，
 *      就地强制剪 + `agent.steer(续写消息)` ⇒ 循环以 `target='next-step'` **续同一个 turn**，
 *      用户不必再发"继续"。宿主 `agent.ts:483` 在 max-tokens 时先于 `executeToolCalls`
 *      直接 return，`turn()` 随即因 inbox 空而收轮 ⇒ 没有本钩子，任务就半途而废。
 *
 * 判据形状来自真会话存档实证（`assistant/message.data` 键 = {message, step, stream,
 * turn, usage}，`stream` 末项 = finish chunk；usage = {inputTokens, outputTokens,
 * totalTokens, cacheReadTokens}；实测被钳三例 = 1,911 / 1 / 4,714 vs 请求 32,768）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { ArgpGraphEngine } from '../src/argp-graph-engine.ts'

// ---------------------------------------------------------------------------
// 会话构建器
// ---------------------------------------------------------------------------

function appendUser(session: Session, turn: number, text: string): number {
  session.append('user/message', { turn, ...createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }) } as never, { surfaceOp: 'append' })
  return session.snapshotEvents().length - 1
}

function appendAssistant(session: Session, turn: number, callId: string): number {
  session.append('assistant/message', {
    stream: [],
    turn,
    step: 1,
    message: {
      role: 'assistant',
      id: 'am_' + callId,
      source: { kind: 'model', provider: 'test', model: 'test' },
      content: [
        { type: 'tool-call', id: callId, name: 'read_file', arguments: '{"path":"' + callId + '.log"}' },
        { type: 'text', text: 'on it ' + callId },
      ],
    },
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

/**
 * 真宿主由 app 把 `session.append` 桥接到 ctx 事件总线（`test/argp-graph-engine.test.ts`
 * 同款注释实证：测试环境**不**桥接）。L2 信号走 `ctx.on('session/event')`，故此处手动模拟。
 */
function hostEmit(ctx: Context, session: Session, event: unknown): void {
  (ctx as unknown as { emit: (name: string, ...args: unknown[]) => void }).emit('session/event', session, event)
}

/** 追加一条"被宿主钳制"的 assistant/message（真会话实测形状）并桥接到事件总线。 */
function appendClampedAssistant(ctx: Context, session: Session, turn: number, outputTokens: number): void {
  session.append('assistant/message', {
    stream: [
      { type: 'block-end', time: 1, chunk: { type: 'block-end' } },
      { type: 'usage', time: 2, chunk: { type: 'usage' } },
      { type: 'finish', time: 3, chunk: { type: 'finish', reason: { kind: 'max-tokens' } } },
    ],
    turn,
    step: 2,
    message: {
      role: 'assistant',
      id: 'am_clamped_' + turn,
      source: { kind: 'model', provider: 'test', model: 'test' },
      content: [{ type: 'text', text: 'truncated output' }],
    },
    usage: { inputTokens: 176_053, outputTokens, totalTokens: 176_053 + outputTokens, cacheReadTokens: 8_240 },
  } as never, { surfaceOp: 'append' })
  const events = session.snapshotEvents()
  hostEmit(ctx, session, events[events.length - 1])
}

function appendTurnEnd(session: Session, turn: number): void {
  session.append('turn/end', { turn, reason: { kind: 'completed' } } as never)
}

/**
 * 量级落在「保留目标（retainTokens=50 ⇒ ~175 字符）」与「触发线（windowTokens=100 ⇒
 * ~350 字符）」之间的会话：**压力未达标**（轮初主动不剪），但强制路径仍有可剪面。
 * turns 1-3 闭合 + turn 4 open。
 */
function buildMidSession(id: string): Session {
  const session = Session.create(SessionId(id))
  for (let turn = 1; turn <= 3; turn += 1) {
    session.append('turn/start', { turn })
    appendUser(session, turn, 'r' + turn + ': ' + String(turn).repeat(16))
    appendAssistant(session, turn, 'rc' + turn)
    appendToolResult(session, turn, 'rc' + turn, 'res' + turn + ' ' + 'z'.repeat(14))
    appendTurnEnd(session, turn)
  }
  session.append('turn/start', { turn: 4 })
  appendUser(session, 4, 'open4: ' + 'w'.repeat(12))
  return session
}

/**
 * L3⑤ 专用：**两级可剪面**会话（turn 1-3 闭合 + turn 4 open）。
 *
 * 与 `buildMidSession` 的差别只有一处：tool result 由 19 字符抬到 25 字符（≥ `minSpanChars`
 * = 20），于是单个 R 也能独立成区间被剪掉。
 *
 * 为什么必须这样（1.7.1 文案变更导致的**夹具**失效，不是行为回归）：
 *  - 1.7.0 的区间墓碑文案长 115 字符（`[elided seq=A..B: N surface nodes pruned by ARGP
 *    (graph order, cites-aware); recall_pruned(seq) retrieves original]`）。第一次强制剪
 *    之后，这条长墓碑把**残存可见量重新抬回 retain 目标之上**（`retainTokens` 50 ×
 *    charsPerToken 3.5 = 175 字符），于是第二次机会"看起来"还有活干。
 *  - 1.7.1 起区间墓碑缩到 46 字符（G3），第一次强制剪后残存可见量落到 171 字符 < 175 ⇒
 *    第二次机会**真的无物可剪**，L3③ 的"剪不动就不续写"正确生效 ⇒ 本用例将测不到
 *    "阶梯按 turn 重置"。
 *  - 即 1.7.0 能过靠的是长墓碑制造的假压力 —— 正是 G1/G3 要消掉的空转副产物。
 *  ⇒ 夹具必须留出**真实**的可剪面：抬 tool result 长度，让单个 R 自己就是合法区间。
 */
function buildRescueSession(id: string): Session {
  const session = Session.create(SessionId(id))
  for (let turn = 1; turn <= 3; turn += 1) {
    session.append('turn/start', { turn })
    appendUser(session, turn, 'r' + turn + ': ' + String(turn).repeat(16))
    appendAssistant(session, turn, 'rc' + turn)
    appendToolResult(session, turn, 'rc' + turn, 'res' + turn + ' ' + 'z'.repeat(20))
    appendTurnEnd(session, turn)
  }
  session.append('turn/start', { turn: 4 })
  appendUser(session, 4, 'open4: ' + 'w'.repeat(12))
  return session
}

/** 压力**明显达标**的会话（turn 1-2 闭合 + turn 3 open），用于"轮内默认不剪"对照。 */
function buildPressuredSession(id: string): Session {
  const session = Session.create(SessionId(id))
  for (let turn = 1; turn <= 2; turn += 1) {
    session.append('turn/start', { turn })
    appendUser(session, turn, 'p' + turn + ': ' + 'a'.repeat(160))
    appendAssistant(session, turn, 'pc' + turn)
    appendToolResult(session, turn, 'pc' + turn, 'old-result ' + 'x'.repeat(200))
    appendTurnEnd(session, turn)
  }
  session.append('turn/start', { turn: 3 })
  appendUser(session, 3, 'p3: ' + 'b'.repeat(160))
  appendAssistant(session, 3, 'pc3')
  appendToolResult(session, 3, 'pc3', 'open-result ' + 'y'.repeat(200))
  return session
}

// ---------------------------------------------------------------------------
// 驱动
// ---------------------------------------------------------------------------

async function makeEngine(config: Record<string, unknown> = {}): Promise<{ ctx: Context; engine: ArgpGraphEngine }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: 'argp trigger-levels test' } })
  // 不传 midTurnActive/midTurnPrune ⇒ 走 1.5.0 默认（轮初主动 + 轮中压力剪）。
  await ctx.plugin(ArgpGraphEngine, { windowTokens: 100, retainTokens: 50, minSpanChars: 20, recencyGuard: 0, maxPasses: 16, ...config })
  return { ctx, engine: ctx.compaction as ArgpGraphEngine }
}

/**
 * 压力路径完全关掉的口径（`windowTokens` 极大 ⇒ 阈值永远够不到）：只留
 * `context-overflow` 强制路径。专供 L2/L3 用例——否则夹具 append 进去的那条被钳
 * assistant 就会把上下文推过线，轮中压力剪会先开火，测的就不是反应式了。
 */
async function makeForcedEngine(config: Record<string, unknown> = {}): Promise<{ ctx: Context; engine: ArgpGraphEngine }> {
  return makeEngine({ windowTokens: 10_000_000, ...config })
}

function stubAgent(session: Session, onSteer?: (message: unknown) => void): Agent {
  return {
    session,
    options: {},
    steer: (message: unknown) => { if (onSteer !== undefined) onSteer(message) },
  } as unknown as Agent
}

function emitPreStep(ctx: Context, agent: Agent, turn: number, step: number, messages: unknown[] = []): Promise<unknown> {
  return agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { agent, messages, turn, step, signal: new AbortController().signal } as never,
    (() => Promise.resolve(undefined)) as never,
  )
}

/** 模拟宿主一次请求：`agent/request` 声明输出预算（适配器的钳制发生在其后）。 */
function emitRequest(ctx: Context, agent: Agent, maxTokens: number): Promise<unknown> {
  return agentEvents(ctx, agent).waterfall(
    'agent/request',
    { agent, turn: 4, step: 2, signal: new AbortController().signal } as never,
    (() => Promise.resolve({ provider: 'test', model: 'test', maxTokens })) as never,
  )
}

function userMessage(text: string): unknown {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

// ---------------------------------------------------------------------------
// L1 轮初主动
// ---------------------------------------------------------------------------

test('L1① 轮初（step=1）计入本步 messages：大段粘贴把估值推过线 ⇒ 剪枝', async () => {
  const { ctx, engine } = await makeEngine()
  try {
    const session = buildMidSession('tl-l1-in')
    engine.setSession(session)
    const before = engine.records.length
    await emitPreStep(ctx, stubAgent(session), 4, 1, [userMessage('x'.repeat(5_000))])
    assert.ok(engine.records.length > before, '轮初估值含未落盘的 user 消息 ⇒ 越线 ⇒ 图剪')
  } finally {
    await ctx.fiber.dispose()
  }
})

test('L1② 同会话、同 step=1 但 messages 为空 ⇒ 不剪（增量才是越线的原因，非空转）', async () => {
  const { ctx, engine } = await makeEngine()
  try {
    const session = buildMidSession('tl-l1-out')
    engine.setSession(session)
    const before = engine.records.length
    await emitPreStep(ctx, stubAgent(session), 4, 1, [])
    assert.equal(engine.records.length, before, '不含新消息 ⇒ 压力未达标 ⇒ 零剪枝')
  } finally {
    await ctx.fiber.dispose()
  }
})

test('L1③ 轮中（step=2）默认做压力剪：压力达标即剪，且**不**跑 per-atom LLM pass', async () => {
  const calls: number[] = []
  const { ctx, engine } = await makeEngine({ onPrePressureCompress: async () => { calls.push(1) } })
  try {
    const session = buildPressuredSession('tl-mid-on')
    engine.setSession(session)
    const before = engine.records.length
    await emitPreStep(ctx, stubAgent(session), 3, 2, [])
    assert.ok(engine.records.length > before, '1.5.0 默认轮中压力剪生效（0-LLM 图剪）')
    assert.equal(calls.length, 0, '轮中剪刻意不带 per-atom pass（79s–3min 的阻塞，轮中不划算）')
  } finally {
    await ctx.fiber.dispose()
  }
})

test('L1④ 逃生阀 midTurnActive:true ⇒ 轮中回到 1.3.x 档（per-atom pass + 默认守卫）', async () => {
  const calls: number[] = []
  const { ctx, engine } = await makeEngine({ midTurnActive: true, onPrePressureCompress: async () => { calls.push(1) } })
  try {
    const session = buildPressuredSession('tl-mid-legacy')
    engine.setSession(session)
    const before = engine.records.length
    await emitPreStep(ctx, stubAgent(session), 3, 2, [])
    assert.ok(engine.records.length > before, 'midTurnActive:true 仍会剪')
    assert.equal(calls.length, 1, '且恢复 1.3.x 的 per-atom 前置压缩')
  } finally {
    await ctx.fiber.dispose()
  }
})

test('L1⑤ 轮中剪放宽 turnGuard：独占当前轮的 tool result（legacy 档不可剪）也能剪', async () => {
  // 只有 open turn（turn 1）有内容：默认守卫下候选为空；轮中剪放宽后才有。
  const session = Session.create(SessionId('tl-mid-relax'))
  session.append('turn/start', { turn: 1 })
  appendUser(session, 1, 'only1: ' + 'c'.repeat(40))
  appendAssistant(session, 1, 'oc1')
  appendToolResult(session, 1, 'oc1', 'open-only ' + 'd'.repeat(600))

  // legacy 档（midTurnActive:true ⇒ 沿用默认 turnGuard=1）：整轮被保护 ⇒ 零候选。
  const legacy = await makeEngine({ midTurnActive: true })
  try {
    legacy.engine.setSession(session)
    const before = legacy.engine.records.length
    await emitPreStep(legacy.ctx, stubAgent(session), 1, 2, [])
    assert.equal(legacy.engine.records.length, before,
      'turnGuard=1 把当前轮整轮保护 ⇒ 剪不动（这正是 1.3.x 轮中剪"只剪 1 原子/154 tok"的成因）')
  } finally {
    await legacy.ctx.fiber.dispose()
  }

  // 新默认档：轮中剪把 turnGuard 降到 midTurnTurnGuard（默认 0）⇒ 同一会话、同一时点即可剪。
  const relaxed = await makeEngine()
  try {
    relaxed.engine.setSession(session)
    const before = relaxed.engine.records.length
    await emitPreStep(relaxed.ctx, stubAgent(session), 1, 2, [])
    assert.ok(relaxed.engine.records.length > before, '放宽 turnGuard 后：本轮旧 tool result 参剪')
  } finally {
    await relaxed.ctx.fiber.dispose()
  }
})

// ---------------------------------------------------------------------------
// L2 反应式
// ---------------------------------------------------------------------------

test('L2① 被钳信号 ⇒ 下一步 pre-step 强制剪枝（压力未达标也剪）', async () => {
  const { ctx, engine } = await makeForcedEngine()
  try {
    const session = buildMidSession('tl-l2-on')
    engine.setSession(session)
    const agent = stubAgent(session)
    const before = engine.records.length

    // 对照组：无信号时同一步零剪枝（压力未达标）。
    await emitPreStep(ctx, agent, 4, 2, [])
    assert.equal(engine.records.length, before, '前置对照：无信号 + 未达标 ⇒ 零剪枝')

    await emitRequest(ctx, agent, 32_768)
    appendClampedAssistant(ctx, session, 4, 1_911) // 1,911 < 32,768 = 外部钳制
    await emitPreStep(ctx, agent, 4, 2, [])
    assert.ok(engine.records.length > before, '钳制信号 ⇒ 强制剪枝（context-overflow trigger 绕过阈值早检）')
  } finally {
    await ctx.fiber.dispose()
  }
})

test('L2② 判据收窄：outputTokens === 请求 maxTokens（模型自己写满）⇒ 不触发', async () => {
  const { ctx, engine } = await makeForcedEngine()
  try {
    const session = buildMidSession('tl-l2-selfcap')
    engine.setSession(session)
    const agent = stubAgent(session)
    const before = engine.records.length

    await emitRequest(ctx, agent, 32_768)
    appendClampedAssistant(ctx, session, 4, 32_768) // 写满自己的预算 ≠ 容量压力
    await emitPreStep(ctx, agent, 4, 2, [])
    assert.equal(engine.records.length, before, '自写满不构成上下文压力 ⇒ 不剪')
  } finally {
    await ctx.fiber.dispose()
  }
})

test('L2③ 升级：第 2 次尝试放宽守卫，使"只剩当前轮可剪"的局面也能剪动', async () => {
  const { ctx, engine } = await makeForcedEngine({ reactiveRetries: 2 })
  try {
    // 只有 open turn（turn 1）有内容：turnGuard=1 下首轮无候选，放宽后才有。
    const session = Session.create(SessionId('tl-l2-relax'))
    session.append('turn/start', { turn: 1 })
    appendUser(session, 1, 'only1: ' + 'c'.repeat(40))
    appendAssistant(session, 1, 'oc1')
    appendToolResult(session, 1, 'oc1', 'open-only ' + 'd'.repeat(200))
    engine.setSession(session)
    const agent = stubAgent(session)
    const before = engine.records.length

    await emitRequest(ctx, agent, 32_768)
    appendClampedAssistant(ctx, session, 1, 1_911)
    await emitPreStep(ctx, agent, 1, 2, [])
    assert.equal(engine.records.length, before, '第 1 次：turnGuard 保护当前轮 ⇒ 候选为空')

    await emitPreStep(ctx, agent, 1, 2, [])
    assert.ok(engine.records.length > before, '第 2 次：放宽 recency/turn 守卫 ⇒ 连当前轮一起剪')
  } finally {
    await ctx.fiber.dispose()
  }
})

test('L2④ 上限：reactiveRetries 用尽后不再重试（避免每步白压）', async () => {
  const { ctx, engine } = await makeForcedEngine({ reactiveRetries: 1 })
  try {
    const session = buildMidSession('tl-l2-cap')
    engine.setSession(session)
    const agent = stubAgent(session)

    await emitRequest(ctx, agent, 32_768)
    appendClampedAssistant(ctx, session, 4, 1_911)
    await emitPreStep(ctx, agent, 4, 2, [])
    const afterFirst = engine.records.length
    assert.ok(afterFirst > 0, '第 1 次补救照常执行')

    await emitPreStep(ctx, agent, 4, 2, [])
    await emitPreStep(ctx, agent, 4, 2, [])
    assert.equal(engine.records.length, afterFirst, '次数用尽 ⇒ 后续 pre-step 不再补救（交给 overflow 路径）')
  } finally {
    await ctx.fiber.dispose()
  }
})

// ---------------------------------------------------------------------------
// L3 截断续写（agent/turn-stopping）
// ---------------------------------------------------------------------------

/**
 * 宿主在本轮最后一个可干预点派发（`turn/end` 尚未落账 ⇒ 编号 bracket 仍属本 turn）。
 * 事件载荷的 `agent` 由 `agentEvents` 注入。
 */
function emitTurnStopping(ctx: Context, agent: Agent, turn: number): Promise<unknown> {
  return agentEvents(ctx, agent).serial(
    'agent/turn-stopping',
    { turn, signal: new AbortController().signal } as never,
  )
}

test('L3① 被钳后本轮要收 ⇒ 就近强制剪 + steer 续写消息（同一 turn 继续推进任务）', async () => {
  const steers: unknown[] = []
  const { ctx, engine } = await makeForcedEngine()
  try {
    const session = buildMidSession('tl-l3-continue')
    engine.setSession(session)
    const agent = stubAgent(session, message => steers.push(message))
    const before = engine.records.length

    await emitRequest(ctx, agent, 32_768)
    appendClampedAssistant(ctx, session, 4, 1_911)
    await emitTurnStopping(ctx, agent, 4)

    assert.ok(engine.records.length > before, 'turn-stopping 上先强制剪（context-overflow 绕过阈值早检）')
    assert.equal(steers.length, 1, '剪成功 ⇒ steer 恰一条续写消息')

    const message = steers[0] as { role?: string; source?: { kind?: string; form?: string }; content?: { text?: string }[] }
    assert.equal(message.role, 'user', 'steer 载荷是 user-role 消息（宿主 inbox 只收 UserMessage）')
    assert.equal(message.source?.kind, 'argp', '源标 argp ⇒ 引擎归类 X（可见、不参剪），UI 按 notice 渲染')
    assert.equal(message.source?.form, 'notice')
    assert.match(String(message.content?.[0]?.text), /截断/, '续写提示点明"被截断"，避免模型以为自己写错了')
  } finally {
    await ctx.fiber.dispose()
  }
})

test('L3② 对照组：无钳制信号 ⇒ turn-stopping 不剪也不续写', async () => {
  const steers: unknown[] = []
  const { ctx, engine } = await makeForcedEngine()
  try {
    const session = buildMidSession('tl-l3-idle')
    engine.setSession(session)
    const agent = stubAgent(session, message => steers.push(message))
    const before = engine.records.length

    await emitRequest(ctx, agent, 32_768)
    await emitTurnStopping(ctx, agent, 4) // 未发生钳制

    assert.equal(engine.records.length, before, '无信号 ⇒ 零剪枝（不打扰正常收轮）')
    assert.equal(steers.length, 0, '无信号 ⇒ 不续写')
  } finally {
    await ctx.fiber.dispose()
  }
})

test('L3③ 剪不动就不续写：避免"白续写 ⇒ 立刻再被钳"的空转', async () => {
  const steers: unknown[] = []
  const { ctx, engine } = await makeForcedEngine()
  try {
    // 只有 dialog U（永不参剪）+ 短 A：强制剪也拿不到候选。
    const session = Session.create(SessionId('tl-l3-noprune'))
    session.append('turn/start', { turn: 1 })
    appendUser(session, 1, 'only a question?')
    engine.setSession(session)
    const agent = stubAgent(session, message => steers.push(message))
    const before = engine.records.length

    await emitRequest(ctx, agent, 32_768)
    appendClampedAssistant(ctx, session, 1, 1_911)
    await emitTurnStopping(ctx, agent, 1)

    assert.equal(engine.records.length, before, '无候选 ⇒ 零剪枝')
    assert.equal(steers.length, 0, '零剪枝 ⇒ 不续写（续写只会立刻再被钳）')
  } finally {
    await ctx.fiber.dispose()
  }
})

test('L3④ 续写次数上限：reactiveRetries 用尽后放手让本轮结束', async () => {
  const steers: unknown[] = []
  const { ctx, engine } = await makeForcedEngine({ reactiveRetries: 1 })
  try {
    const session = buildMidSession('tl-l3-cap')
    engine.setSession(session)
    const agent = stubAgent(session, message => steers.push(message))

    await emitRequest(ctx, agent, 32_768)
    appendClampedAssistant(ctx, session, 4, 1_911)
    await emitTurnStopping(ctx, agent, 4)
    assert.equal(steers.length, 1, '第 1 次照常续写')

    // 续写步再次被钳（同一 turn，尚无 turn/start）
    appendClampedAssistant(ctx, session, 4, 1_911)
    await emitTurnStopping(ctx, agent, 4)
    assert.equal(steers.length, 1, '额度用尽 ⇒ 不再续写（避免无限续）')
  } finally {
    await ctx.fiber.dispose()
  }
})

test('L3⑤ 阶梯按 turn 重置：新一轮拿到完整续写额度', async () => {
  const steers: unknown[] = []
  const { ctx, engine } = await makeForcedEngine({ reactiveRetries: 1 })
  try {
    const session = buildRescueSession('tl-l3-reset')
    engine.setSession(session)
    const agent = stubAgent(session, message => steers.push(message))

    await emitRequest(ctx, agent, 32_768)
    appendClampedAssistant(ctx, session, 4, 1_911)
    await emitTurnStopping(ctx, agent, 4)
    assert.equal(steers.length, 1)

    hostEmit(ctx, session, { type: 'turn/start', data: { turn: 5 } }) // 新一轮 ⇒ 阶梯清空
    appendClampedAssistant(ctx, session, 5, 1_911)
    await emitTurnStopping(ctx, agent, 5)
    assert.equal(steers.length, 2, 'turn 一换就重新拿到额度，避免"一条会话只救两次"')
  } finally {
    await ctx.fiber.dispose()
  }
})
