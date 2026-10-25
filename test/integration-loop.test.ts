/**
 * 进程内真实回路集成测试（Tier A，2026-10-26）。
 *
 * 与单测/组件测的区别：`mountAgentLoopTestHarness` 挂**生产 AgentLoop 本体**，
 * turn 由真实驱动器推进（inbox claim → pre-step → LLM stream → 工具派发 →
 * turn/end → idle），LLM 经 `ctx.llm.registerAdapter` 的脚本化 LlmAdapter 提供
 * （唯一抽象方法 stream；peratom 的 dsh-llm 通路走同一 runtime——autoDshLlmSpec
 * 从 agent.options 现取路由，故一个适配器同时服务真实回路与压缩调用）。
 *
 *  I1. 两段式水位经真实事件序：轮末 idle prepare（LLM 提案）→ 暂存 → 下一轮
 *      pre-step flush → 事务落盘；turn-2 的真实请求已看不到被替换原文。
 *  I2. D2 端到端：A 的首次 pre-step 在预算探测 await 窗口内被 B 的完整轮次抢绑
 *      焦点——恢复后必须按 A 自己的口径判定压力（B 的低锚点不得毒化 A）。
 *  I3. maintenance 空任务不破坏：真实 maintenance 相位（宿主映射为 idle）跑空
 *      任务后，事务括号配对、下一轮照常（2-4 已知限制的安全侧锁定）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { AgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Session as SessionType } from '@deepseek-ai/dsh-session'
import { ArgpGraphEngine } from '../src/argp-graph-engine.ts'
import { eventText } from '../src/log-access.ts'

// ---------------------------------------------------------------------------
// 脚本化 LlmAdapter：按 purpose 分发（undefined = agent 轮；'compaction' = peratom）
// ---------------------------------------------------------------------------

interface RecordedCall {
  provider: string
  model: string
  purpose?: string
  messages: unknown[]
}

/** 轮次响应（agent 目的）：一个 text 块 + 可选 usage（usage 会落进 assistant/message
 * 事件，成为引擎 usage 锚点的真实来源——I2 的"低锚点"就靠它）。 */
export interface TurnScript {
  text: string
  usage?: { inputTokens: number; outputTokens: number }
}

class ScriptedLlm extends LlmAdapter {
  readonly calls: RecordedCall[] = []
  readonly resolveCalls: string[] = []
  /** 按 provider 分道的轮次脚本（多 agent 交错时互不误取——顺序队列会被"先醒的 agent"吃掉别人的脚本）。 */
  turnQueueByProvider = new Map<string, TurnScript[]>()
  /** compaction 响应回调（延迟求值：调用发生时才执行，可读运行中会话状态）。 */
  compactionResponse: (() => string) | null = null
  /** 预算探测闸门（I2）：armed 后的首次 resolveModel 挂起，制造确定性 await 窗口。
   *  显式布防（agent 创建可能触发未布防的模型解析），且 A/B 走不同 provider——
   *  LlmRuntime 对同路由的并发模型信息查询会合流，同 provider 会把 B 也吊死在闸门上。 */
  armed = false
  gate: Promise<void> = Promise.resolve()
  /** 每 provider 的声明窗口（I2 桶隔离：A/B 各自 resolveScaledBudgets 的真值来源）。 */
  contextWindowOf = new Map<string, number>([['a', 2000], ['b', 50000]])

  turnQueueOf(provider: string): TurnScript[] {
    let q = this.turnQueueByProvider.get(provider)
    if (q === undefined) { q = []; this.turnQueueByProvider.set(provider, q) }
    return q
  }

  enqueue(provider: string, script: TurnScript): void {
    this.turnQueueOf(provider).push(script)
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const purpose = (options as { purpose?: string }).purpose
    this.calls.push({ provider: options.provider, model: options.model, purpose, messages: options.messages })
    if (purpose === 'compaction') {
      const text = this.compactionResponse === null ? '{"splits":[],"tools":[]}' : this.compactionResponse()
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    const script = this.turnQueueOf(options.provider).shift()
    if (script === undefined) throw new Error('scripted adapter: agent turn with empty script queue (provider ' + options.provider + ')')
    yield { type: 'block-start', index: 0, blockType: 'text' }
    if (script.text !== '') yield { type: 'text-delta', index: 0, text: script.text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: script.text } }
    if (script.usage !== undefined) {
      yield { type: 'usage', usage: { inputTokens: script.usage.inputTokens, outputTokens: script.usage.outputTokens } }
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  override async resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string; context: { contextWindow: number } }> {
    const gated = this.armed && this.resolveCalls.length === 0
    this.resolveCalls.push(provider + (gated ? '(GATED)' : ''))
    if (gated) await this.gate
    // LlmModelInfo 必填 provider/id/name（运行时严格校验，缺项即 INVALID_MODEL_INFO）
    return { provider, id: model, name: 'scripted model', context: { contextWindow: this.contextWindowOf.get(provider) ?? 8000 } }
  }
}

// ---------------------------------------------------------------------------
// harness 组装 + 驱动
// ---------------------------------------------------------------------------

async function makeLoop(engineConfig: Record<string, unknown> = {}): Promise<{
  ctx: Context
  adapter: ScriptedLlm
  engine: ArgpGraphEngine
  harness: AgentLoopTestHarness
}> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: 'integration-loop test' } })
  const adapter = new ScriptedLlm()
  ;(ctx.get('llm') as unknown as { registerAdapter(p: string[], a: LlmAdapter): unknown }).registerAdapter(['a', 'b'], adapter)
  await ctx.plugin(ArgpGraphEngine, { peratom: { declarer: false }, ...engineConfig })
  const harness = await mountAgentLoopTestHarness(ctx)
  return { ctx, adapter, engine: ctx.compaction as ArgpGraphEngine, harness }
}

async function makeAgent(harness: AgentLoopTestHarness, id: string, provider = 'a'): Promise<Agent> {
  return harness.create(SessionId(id), { provider, model: 'm' } as never)
}

function say(agent: Agent, text: string): void {
  agent.send(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), 'next-turn', true)
}

async function until(cond: () => boolean, ms = 6000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (cond()) return
    await new Promise(r => setTimeout(r, 40))
  }
  assert.ok(cond(), '等待超时：' + what)
}

function compactionEvents(session: SessionType): { type: string; error?: unknown }[] {
  return session.snapshotEvents()
    .filter(e => e.type.startsWith('compaction/'))
    .map(e => ({ type: e.type, error: (e.data as { error?: unknown } | undefined)?.error }))
}

interface CompressorView {
  pending: { session: SessionType }[]
  records: { turn: number; called: boolean; skipReason?: string; error?: string }[]
}

function compressorOf(engine: ArgpGraphEngine): CompressorView {
  const stack = (engine as unknown as { peratomStack: { compressor: unknown } | null }).peratomStack
  assert.ok(stack !== null, 'peratom 栈已挂载（引擎自挂载句柄）')
  return stack.compressor as CompressorView
}

// ---------------------------------------------------------------------------
// I1. 两段式水位：真实轮末 idle prepare → 暂存 → 下一轮 pre-step flush → 事务
// ---------------------------------------------------------------------------

test('I1: 轮末 idle 提案暂存，下一轮 pre-step flush 落盘——turn-2 真实请求看不到被替换原文', async () => {
  const { ctx, adapter, engine, harness } = await makeLoop({ windowTokens: 8000, retainTokens: 4000, recencyGuard: 0, turnGuard: 0, minSpanChars: 20 })
  try {
    const agent = await makeAgent(harness, 'int-i1')
    const session = agent.session
    const compressor = compressorOf(engine)
    const MARK = 'I1-BIG-CONTENT-' + 'x'.repeat(3600)

    // 轮 1：大段 user 文本 + 短应答。轮末 idle → compressor prepare（LLM 提案）。
    adapter.compactionResponse = () => {
      // 提案延迟求值：此刻 user 原子已在日志里，按真实 seq 下 split 决策
      const uSeq = session.snapshotEvents().findIndex(e => e.type === 'user/message')
      assert.ok(uSeq >= 0, 'user/message 已落盘')
      return JSON.stringify({ splits: [{ seq: uSeq, quotes: [], infoLevel: 'summary', infoText: 'compressed I1' }], tools: [] })
    }
    adapter.turnQueueOf('a').push({ text: 'ok' })
    say(agent, MARK)
    await agent.whenIdle()
    await until(() => compressor.pending.length > 0 || compressor.records.some(r => r.called), 6000, 'idle prepare 暂存/提案')

    // 轮 2：pre-step 有界等待在飞 pass → flushStashed 落事务 → 同一 step 请求瘦身。
    adapter.turnQueueOf('a').push({ text: 'done' })
    say(agent, 'continue')
    await agent.whenIdle()
    await until(() => compactionEvents(session).some(e => e.type === 'compaction/end' && e.error === undefined), 6000, 'flush 事务落盘')

    const events = compactionEvents(session)
    assert.ok(events.some(e => e.type === 'compaction/start'), '事务有 start')
    assert.equal(events.filter(e => e.type === 'compaction/start').length, events.filter(e => e.type === 'compaction/end').length, '事务括号配对')
    // tombstone 已在 surface：大原子被 [elided 副本替换
    const surfaceText = [...session.surface.nodes].map(s => eventText(session, s)).join('\n')
    assert.ok(!surfaceText.includes(MARK), '被替换原文不再出现在 surface')
    assert.ok(surfaceText.includes('[elided'), 'tombstone 副本在 surface')
    // 轮 2 的真实 LLM 请求（agent 目的最后一次调用）不携带被替换原文
    const agentCalls = adapter.calls.filter(c => c.purpose === undefined)
    const last = agentCalls[agentCalls.length - 1]
    assert.ok(last !== undefined, '轮 2 有真实请求')
    assert.ok(!JSON.stringify(last.messages).includes(MARK), '轮 2 请求已瘦身（原文不在上下文）')
    // 水位语义：成功 flush 一次后不重压同一内容
    assert.equal(compressor.records.filter(r => r.called).length, 1, '恰好一次成功压缩（无重复提案）')
  } finally {
    await ctx.fiber.dispose()
  }
})

// ---------------------------------------------------------------------------
// I2. D2 端到端：首次预算探测的 await 窗口被 B 的完整轮次抢绑焦点
// ---------------------------------------------------------------------------

test('I2: A 预算探测挂起期间 B 跑完整轮次——交错不破坏、解析窗口按会话分桶、锚点不串台', async () => {
  const { ctx, adapter, engine, harness } = await makeLoop({ recencyGuard: 0, turnGuard: 0, minSpanChars: 20 })
  let releaseGate: () => void = () => {}
  try {
    adapter.gate = new Promise<void>(r => { releaseGate = r })

    const a = await makeAgent(harness, 'int-i2-a', 'a')
    const b = await makeAgent(harness, 'int-i2-b', 'b')
    const bucketOf = engine as unknown as { stateOf(s: SessionType): { resolvedWindowTokens: number; lastRealPromptTokens: number } }
    adapter.armed = true

    // A 的首次 pre-step：预算探测（armed 后首个 resolveModel）挂起在闸门上
    adapter.turnQueueOf('a').push({ text: 'a done', usage: { inputTokens: 1111, outputTokens: 5 } })
    say(a, 'I2-BIG-' + 'y'.repeat(12000))
    await until(() => adapter.resolveCalls.length >= 1 && adapter.resolveCalls[0]!.endsWith('(GATED)'), 6000, 'A 的首次预算探测已挂起')

    // 交错窗口内：B 跑完一个完整轮次（低 usage 锚点落 B 桶 = 串台毒源），A 仍挂在探测上
    adapter.turnQueueOf('b').push({ text: 'b done', usage: { inputTokens: 3, outputTokens: 2 } })
    say(b, 'hi b')
    await b.whenIdle()
    await until(() => bucketOf.stateOf(b.session).lastRealPromptTokens === 3, 6000, 'B 桶低锚点落位（毒源前置）')

    releaseGate()
    await a.whenIdle()

    // ① 交错不破坏：A 的轮正常收尾（有自己的 usage），B 的会话零事务写入
    assert.equal(bucketOf.stateOf(a.session).lastRealPromptTokens, 1111, 'A 的锚点来自 A 自己的 usage（不被 B 的 3 毒化）')
    assert.equal(compactionEvents(b.session).length, 0, 'B 会话不得被 A 的压力路径写任何事务')
    // ② 解析窗口按会话分桶（D2 桶化端到端）：A=2000×0.8=1600，B=50000×0.8=40000；
    //    共享字段形态下 B 的解析会覆盖 A（A 读到 40000）
    await until(() => bucketOf.stateOf(a.session).resolvedWindowTokens === 1600, 6000, 'A 桶解析窗口落位')
    assert.equal(bucketOf.stateOf(b.session).resolvedWindowTokens, 40000, 'B 桶窗口独立（不因 A 的解析被改写）')
  } finally {
    releaseGate() // 断言失败也先开闸：挂在闸门上的 pre-step 纤程不得死锁 fiber.dispose
    await ctx.fiber.dispose()
  }
})

// ---------------------------------------------------------------------------
// I3. maintenance 空任务不破坏（2-4 已知限制的安全侧）
// ---------------------------------------------------------------------------

test('I3: 真实 maintenance 相位（映射 idle）跑空任务——括号配对、无重复压缩、下一轮照常', async () => {
  const { ctx, adapter, engine, harness } = await makeLoop({ windowTokens: 8000, retainTokens: 4000, recencyGuard: 0, turnGuard: 0, minSpanChars: 20 })
  try {
    const agent = await makeAgent(harness, 'int-i3')
    const session = agent.session
    const compressor = compressorOf(engine)
    adapter.turnQueueOf('a').push({ text: 'ok' })
    say(agent, 'I3 small turn')
    await agent.whenIdle()
    await until(() => compressor.records.length > 0, 6000, '轮末 pass 记账')

    await agent.runMaintenance(async () => { /* 空任务：真实 maintenance 相位 */ })
    await agent.whenIdle()

    const events = compactionEvents(session)
    assert.equal(events.filter(e => e.type === 'compaction/start').length, events.filter(e => e.type === 'compaction/end').length, 'maintenance 后事务括号仍配对')

    adapter.turnQueueOf('a').push({ text: 'after' })
    say(agent, 'after maintenance')
    await agent.whenIdle()
    assert.equal(adapter.calls.filter(c => c.purpose === undefined).length, 2, 'maintenance 后下一轮照常完成')
  } finally {
    await ctx.fiber.dispose()
  }
})
