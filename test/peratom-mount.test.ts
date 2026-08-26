/**
 * P4 双引擎生产挂载工厂（mountPeratomStack）单测。
 *
 * 验收点：
 *  ① 装配拓扑：ctx.compaction = ArgpGraphEngine（Stage-2 位），三管线句柄非空，
 *     引擎的 injectEdges/onOverflowCompress 已接线（行为级：注入 declarer 边影响
 *     buildGraph、onOverflowCompress 被溢出钩子调用）
 *  ② P5 三臂开关：declarer:false → 无边（injectEdges 不接线）；compressor:false →
 *     溢出三步退化为现役（onOverflowCompress 不接线）；zoom:false → 不注册工具
 *  ③ 失败隔离：compressor 缺失 endpoint（disabled 态）时 onOverflowCompress 仍被
 *     调用但不抛错（compressCurrentTurn 静默返回 no-endpoint 记录）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { CONTEXT_WINDOW_EXCEEDED_CODE, CallId, createAssistantMessage, createUserMessage, type LlmFailure } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { ArgpGraphEngine, type Atom } from '../src/argp-graph-engine.ts'
import { mountPeratomStack } from '../src/peratom/mount.ts'
import { PeratomCompressor } from '../src/peratom/compressor.ts'
import { CiteDeclarer } from '../src/peratom/cite-declarer.ts'
import { RecallZoom } from '../src/peratom/recall-zoom.ts'

async function makeCtx(): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: 'mount test' } })
  return ctx
}

function stubAgent(session: Session): Agent {
  return { session, options: {} } as Agent
}

function overflowFailure(): LlmFailure {
  return { message: 'request (197482 tokens) exceeds the available context size (196608 tokens)', code: CONTEXT_WINDOW_EXCEEDED_CODE }
}

function emitRequestError(ctx: Context, agent: Agent, failure: LlmFailure): Promise<{ kind: 'retry' } | undefined> {
  const turn = agent.session.events.findLast(event => event.type === 'turn/start')?.data.turn ?? 1
  return agentEvents(ctx, agent).waterfall(
    'agent/request-error',
    { turn, step: 1, provider: 'test', failure, retryPolicy: undefined, signal: new AbortController().signal },
    () => Promise.resolve(undefined),
  )
}

/** 大 R 会话：turn1 旧 R（可剪）+ turn2 当前轮大 R（turnGuard 保护）；带闭合轮边界（compressor.collectCurrentTurn 靠 turn/end 定位当轮）。 */
function buildOverflowSession(id: string): { session: Session; bigR: number } {
  const session = Session.create(SessionId(id))
  const appendTurnStart = (turn: number) => session.append('turn/start', { turn })
  const appendTurnEnd = (turn: number) => session.append('turn/end', { turn, reason: { kind: 'completed' } } as never)
  const appendUser = (turn: number, text: string) => {
    session.append('user/message', { turn, ...createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }) } as never, { surfaceOp: 'append' })
  }
  const appendAssistant = (turn: number, text: string, cid: string) => {
    session.append('assistant/message', { turn, ...createAssistantMessage({ content: [{ type: 'text', text }, { type: 'tool-call', id: cid, name: 'run', arguments: {} }] } as never) } as never, { surfaceOp: 'append' })
  }
  const appendToolResult = (turn: number, callId: string, text: string): number => {
    session.append('tool/result', {
      turn, step: 1,
      message: { role: 'user', content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }], isError: false }], source: { kind: 'tool', callId }, id: 'm_' + callId },
    } as never, { surfaceOp: 'append' })
    return session.events.length - 1
  }
  appendTurnStart(1)
  appendUser(1, '旧请求')
  appendAssistant(1, '跑一下', id + 'old')
  appendToolResult(1, id + 'old', 'old ' + 'x'.repeat(200))
  appendTurnEnd(1)
  appendTurnStart(2)
  appendUser(2, '看日志')
  appendAssistant(2, '读日志', id + 'big')
  const bigR = appendToolResult(2, id + 'big', 'BIG-' + 'y'.repeat(3000))
  appendTurnEnd(2)
  return { session, bigR }
}

/** 环境隔离：剥离 LLM endpoint 环境变量（保证管线 disabled 态、零网络副作用），退出时还原。 */
function isolateLlmEnv(): () => void {
  const keys = ['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE', 'DEEPSEEK_MODEL', 'ARGP_MODEL_SOURCE', 'QWEN_BASE', 'QWEN_MODEL'] as const
  const saved = new Map<string, string | undefined>()
  for (const k of keys) { saved.set(k, process.env[k]); delete process.env[k] }
  return () => { for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v } }
}

test('装配拓扑：compaction 位 = ArgpGraphEngine，三管线句柄非空，接线生效', async () => {
  const restoreEnv = isolateLlmEnv()
  const ctx = await makeCtx()
  const stack = await mountPeratomStack(ctx, {
    graph: { windowTokens: 100, retainTokens: 20, minSpanChars: 20, recencyGuard: 0, maxPasses: 16, maxOverflowRetries: 3 },
  })
  try {
    assert.ok(stack.engine instanceof ArgpGraphEngine, 'ctx.compaction must be the graph engine')
    assert.ok(ctx.compaction instanceof ArgpGraphEngine, 'compaction slot holds the graph engine')
    assert.ok(stack.compressor instanceof PeratomCompressor)
    assert.ok(stack.declarer instanceof CiteDeclarer)
    assert.ok(stack.zoom instanceof RecallZoom)

    // 行为级接线断言：onOverflowCompress 已注入（溢出序列第②步会调用 compressor）。
    // 环境隔离下 compressor 缺 endpoint → disabled 态，compressCurrentTurn 静默返回
    // no-endpoint（不抛错、零网络）。② 被调用的证据 = compressor.records 出现记录
    // （若 wiring 缺失，records 恒空）。
    const { session } = buildOverflowSession('mount-wired')
    stack.engine.setSession(session)
    const agent = stubAgent(session)
    const e1 = await emitRequestError(ctx, agent, overflowFailure())
    assert.equal(e1?.kind, 'retry', 'step-1 forcePrune must retry')
    assert.equal(stack.compressor!.records.length, 0, 'compress must not run on step-1 (first overflow)')
    // 第二次溢出触发第②步：wired 回调调用 compressor（disabled）→ 记 no-endpoint。
    // disabled 态② 不换代、③ 无新候选 → 状态机保留原错误（undefined）属正确行为；
    // 关键断言是 records 出现（证明 ② 接线生效，而非 wiring 缺失导致 records 恒空）。
    const e2 = await emitRequestError(ctx, agent, overflowFailure())
    assert.ok(stack.compressor!.records.length >= 1, 'step-2 must invoke the wired onOverflowCompress (compressor record present)')
    assert.equal(stack.compressor!.records.at(-1)?.error, 'no-endpoint', 'disabled compressor must record no-endpoint without throwing')
    void e2
  } finally {
    await ctx.fiber.dispose()
    restoreEnv()
  }
})

test('P5 臂 B：declarer:false → injectEdges 不接线（无边）', async () => {
  const ctx = await makeCtx()
  const stack = await mountPeratomStack(ctx, { declarer: false, compressor: false, zoom: false })
  try {
    assert.equal(stack.declarer, null)
    // 无 declarer → buildGraph 不消费声明边（injectEdges 未注入）。
    // 用引擎私有 injectEdges 字段直查接线状态。
    const injected = (stack.engine as unknown as { injectEdges?: unknown }).injectEdges
    assert.equal(injected, undefined, 'injectEdges must not be wired when declarer is off')
  } finally {
    await ctx.fiber.dispose()
  }
})

test('P5 臂 B/C 分叉：compressor:false → onOverflowCompress 不接线（溢出退化为现役）', async () => {
  const ctx = await makeCtx()
  // maxOverflowRetries: 5 —— 让第二次溢出越过重试上限检查，专门命中
  // "未注入 onOverflowCompress"分支（而非被上限拦截），隔离验证接线缺失行为
  const stack = await mountPeratomStack(ctx, {
    graph: { windowTokens: 100, retainTokens: 20, minSpanChars: 20, recencyGuard: 0, maxPasses: 16, maxOverflowRetries: 5 },
    compressor: false, declarer: false, zoom: false,
  })
  try {
    assert.equal(stack.compressor, null)
    const injected = (stack.engine as unknown as { onOverflowCompress?: unknown }).onOverflowCompress
    assert.equal(injected, undefined, 'onOverflowCompress must not be wired when compressor is off')
    // 行为：第二次溢出即保留错误（现役两步行为，无第②③步）
    const { session } = buildOverflowSession('mount-nocomp')
    stack.engine.setSession(session)
    const agent = stubAgent(session)
    const e1 = await emitRequestError(ctx, agent, overflowFailure())
    assert.equal(e1?.kind, 'retry')
    const e2 = await emitRequestError(ctx, agent, overflowFailure())
    assert.equal(e2, undefined, 'second overflow must preserve the error (current behavior without compressor)')
  } finally {
    await ctx.fiber.dispose()
  }
})

test('P5 臂 C 等价：不读工厂直接 ctx.plugin(ArgpGraphEngine) = 纯基线（零 per-atom 接线）', async () => {
  const ctx = await makeCtx()
  await ctx.plugin(ArgpGraphEngine, { windowTokens: 100, retainTokens: 20, minSpanChars: 20, recencyGuard: 0, maxPasses: 16 })
  try {
    const engine = ctx.compaction as ArgpGraphEngine
    assert.ok(engine instanceof ArgpGraphEngine)
    const injectedEdges = (engine as unknown as { injectEdges?: unknown }).injectEdges
    const injectedCompress = (engine as unknown as { onOverflowCompress?: unknown }).onOverflowCompress
    assert.equal(injectedEdges, undefined, 'baseline has no per-atom wiring')
    assert.equal(injectedCompress, undefined, 'baseline has no per-atom wiring')
  } finally {
    await ctx.fiber.dispose()
  }
})
