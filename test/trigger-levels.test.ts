/**
 * 三级触发（1.4.0）默认契约锁定。
 *
 *   L1 轮初主动：**只**在本轮首个 pre-step（`payload.step === 1`）判定；估值必须计入
 *      本步已 claiming、尚未落盘进 surface 的 user 消息（`payload.messages`）——
 *      它是精确值，不是预测（宿主 `agent.ts:244` 先 claim、`:250` 才 dispatch 本钩子）。
 *   L2 反应式：轮内**不做**主动压缩；只有在"输出被宿主/适配器钳制"（finish=max-tokens
 *      且 outputTokens < 本次请求的 maxTokens）之后，才在下一个 pre-step 强制执行一次
 *      `compactIfNeeded('context-overflow')`（该 trigger 绕过阈值早检 = 强制剪），
 *      并用 `reactiveRetries` 封顶、第 2 次起放宽守卫。
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
  // 注意：**不**传 midTurnActive ⇒ 走 1.4.0 默认（轮内不主动压缩）。
  await ctx.plugin(ArgpGraphEngine, { windowTokens: 100, retainTokens: 50, minSpanChars: 20, recencyGuard: 0, maxPasses: 16, ...config })
  return { ctx, engine: ctx.compaction as ArgpGraphEngine }
}

function stubAgent(session: Session): Agent {
  return { session, options: {} } as Agent
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

test('L1③ 轮内（step=2）默认不做主动压缩：压力明显达标也不剪', async () => {
  const { ctx, engine } = await makeEngine()
  try {
    const session = buildPressuredSession('tl-mid-off')
    engine.setSession(session)
    const before = engine.records.length
    await emitPreStep(ctx, stubAgent(session), 3, 2, [])
    assert.equal(engine.records.length, before, '1.4.0 默认轮内无主动阈值 ⇒ 零剪枝')
  } finally {
    await ctx.fiber.dispose()
  }
})

test('L1④ 逃生阀 midTurnActive:true ⇒ 同一会话轮内仍会剪（对照，证明 L1③ 不是失效）', async () => {
  const { ctx, engine } = await makeEngine({ midTurnActive: true })
  try {
    const session = buildPressuredSession('tl-mid-on')
    engine.setSession(session)
    const before = engine.records.length
    await emitPreStep(ctx, stubAgent(session), 3, 2, [])
    assert.ok(engine.records.length > before, 'midTurnActive:true 恢复 1.3.x 的逐 pre-step 压力检查')
  } finally {
    await ctx.fiber.dispose()
  }
})

// ---------------------------------------------------------------------------
// L2 反应式
// ---------------------------------------------------------------------------

test('L2① 被钳信号 ⇒ 下一步 pre-step 强制剪枝（压力未达标也剪）', async () => {
  const { ctx, engine } = await makeEngine()
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
  const { ctx, engine } = await makeEngine()
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
  const { ctx, engine } = await makeEngine({ reactiveRetries: 2 })
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
  const { ctx, engine } = await makeEngine({ reactiveRetries: 1 })
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
