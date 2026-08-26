/**
 * P4 Stage-2 对接 + 溢出三步路径 单测。
 *
 * 验收判据（plan P4）：
 *  ① 集成测试：单条超大 tool result 直超窗口 → 溢出三步序列（①forcePrune →
 *     ②onOverflowCompress → ③forcePrune）收敛到窗口内
 *  ② U-info 被剪后 recall_detail(sourceSeq) 可恢复原用户消息全文
 *  ③ 全量回归：现有 test 文件零破坏（由 npm test 覆盖，本文件不重复）
 *
 * 另含：U-info 候选放行（sourceSeq 有值 → R 待遇参剪）vs dialog 永不剪
 *      （sourceSeq 无值 → ask-exempt 分支，无覆盖 → 结构性不可剪）的干净对比；
 *      onOverflowCompress 未注入时行为与现役一致（第二次溢出即保留错误）。
 *
 * fixture 预算口径：windowTokens=100 / retainTokens=20（retainChars=70），
 * 会话总量 > 70 触发剪枝；U-info 文本 ≥ minSpanChars(20) 不被微剪枝下限丢弃；
 * 最新轮 A/R 由 turnGuard(默认1) 保护，dialog/普通 U 由 ask-exempt 结构性保护。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { CONTEXT_WINDOW_EXCEEDED_CODE, CallId, createAssistantMessage, createUserMessage, type LlmFailure } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { ArgpGraphEngine } from '../src/argp-graph-engine.ts'
import { RecallZoom } from '../src/peratom/recall-zoom.ts'
import { ARG_NS } from '../src/peratom/types.ts'

// ---------------------------------------------------------------------------
// 测试会话构建器
// ---------------------------------------------------------------------------

/** 普通 user 消息（source: user；atomize → U，sourceSeq 无值 → ask-exempt / dialog）。 */
function appendUser(session: Session, turn: number, text: string): number {
  session.append('user/message', {
    turn,
    ...createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
  } as never, { surfaceOp: 'append' })
  return session.events.length - 1
}

/** U-info 聚合副本（source: plugin + data[ARG_NS]；atomize → U 且 sourceSeq 有值 → R 待遇参剪）。 */
function appendUInfo(session: Session, turn: number, text: string, sourceSeq: number, summary: string): number {
  session.append('user/message', {
    turn,
    ...createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: 'dsh-argp-peratom' } }),
    [ARG_NS]: { info: true, sourceSeq, summary },
  } as never, { surfaceOp: 'append' })
  return session.events.length - 1
}

/** assistant 消息（可带 tool-call）。 */
function appendAssistant(session: Session, turn: number, text: string, toolCallId?: string): number {
  const content: unknown[] = [{ type: 'text', text }]
  if (toolCallId !== undefined) content.push({ type: 'tool-call', id: toolCallId, name: 'run', arguments: {} })
  session.append('assistant/message', {
    turn,
    ...createAssistantMessage({ content } as never),
  } as never, { surfaceOp: 'append' })
  return session.events.length - 1
}

/** tool result（应答 tool-call）。 */
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
  return session.events.length - 1
}

async function makeEngine(config: Record<string, unknown> = {}): Promise<{ ctx: Context; engine: ArgpGraphEngine }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: 'argp p4 test' } })
  await ctx.plugin(ArgpGraphEngine, { windowTokens: 100, retainTokens: 20, minSpanChars: 20, recencyGuard: 0, maxPasses: 16, ...config })
  return { ctx, engine: ctx.compaction as ArgpGraphEngine }
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

/**
 * U-info 放行 fixture：
 *   turn 1：dialog（普通 U）+ 原始用户（普通 U，含 marker）+ U-info（sourceSeq 有值）
 *   turn 2：A + R（最新轮，turnGuard 保护）
 * 唯一可剪候选 = U-info（eff=0、R 待遇）；dialog/原始用户 ask-exempt 结构性不可剪。
 */
function buildUInfoSession(id: string, marker: string): {
  session: Session; dialogSeq: number; origUserSeq: number; uinfoSeq: number
} {
  const session = Session.create(SessionId(id))
  const dialogSeq = appendUser(session, 1, '把端口改成 8080')
  const origUserSeq = appendUser(session, 1, '完整配置：' + marker + '; PORT=3000; DB=mysql://host/db')
  const uinfoSeq = appendUInfo(session, 1, '资料摘要：本消息为用户粘贴的配置资料，含 PORT 与 DB 两项', origUserSeq, '配置含 ' + marker)
  appendAssistant(session, 2, '好的，我来改', CallId(id + 'a1'))
  appendToolResult(session, 2, id + 'a1', 'done')
  return { session, dialogSeq, origUserSeq, uinfoSeq }
}

// ---------------------------------------------------------------------------
// 验收判据 ①：U-info 候选放行 vs dialog 永不剪
// ---------------------------------------------------------------------------

test('U-info（sourceSeq 有值）按 R 待遇参剪；dialog / 原始用户（sourceSeq 无值）永不剪', async () => {
  const { ctx, engine } = await makeEngine()
  try {
    const { session, dialogSeq, origUserSeq, uinfoSeq } = buildUInfoSession('p4-uinfo-prune', 'MARKER-P4-0001')
    engine.setSession(session)
    const result = await engine.compactIfNeeded({ session } as never, 'context-overflow', new AbortController().signal)
    assert.ok(result !== null, 'context-overflow must produce a prune')
    const shadowed = new Set(result!.shadowedSeqs)
    assert.ok(shadowed.has(uinfoSeq), 'U-info (sourceSeq present) must be pruned as an R-treated candidate')
    assert.ok(!shadowed.has(dialogSeq), 'dialog U (sourceSeq absent, ask-exempt) must never be pruned')
    assert.ok(!shadowed.has(origUserSeq), 'original user U (sourceSeq absent, ask-exempt) must never be pruned')
  } finally {
    await ctx.fiber.dispose()
  }
})

// ---------------------------------------------------------------------------
// 验收判据 ②：U-info 被剪后 recall_detail(sourceSeq) 恢复原用户消息全文
// ---------------------------------------------------------------------------

test('U-info 被剪后 recall_detail(sourceSeq) 逐字节恢复原用户消息', async () => {
  const { ctx, engine } = await makeEngine()
  try {
    const marker = 'SECRET-CONFIG-XYZ-0042'
    const { session, origUserSeq, uinfoSeq } = buildUInfoSession('p4-uinfo-recall', marker)
    engine.setSession(session)
    const result = await engine.compactIfNeeded({ session } as never, 'context-overflow', new AbortController().signal)
    assert.ok(result !== null, 'a prune must occur')
    assert.ok(result!.shadowedSeqs.includes(uinfoSeq), 'U-info must be the pruned atom')

    // U-info 被剪后，模型据 data[ARG_NS].sourceSeq 调 recall_detail 取回原文全文
    const zoom = new RecallZoom(ctx, {})
    zoom.setSession(session)
    const detail = await zoom.recallDetail(origUserSeq)
    assert.ok(detail.includes(marker), 'recall_detail(sourceSeq) must restore the original user message verbatim: ' + detail.slice(0, 120))
  } finally {
    await ctx.fiber.dispose()
  }
})

// ---------------------------------------------------------------------------
// 验收判据 ③（溢出三步）：单条超大 tool result 直超窗口 → 三步序列收敛
// ---------------------------------------------------------------------------

test('溢出三步：超大 R 直超窗 → ①forcePrune → ②compress+③forcePrune（compress 恰调一次）', async () => {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: 'p4 overflow persona' } })
  const session = Session.create(SessionId('p4-overflow-3step'))
  // turn1：可剪的旧内容（R 候选，turnGuard 不保护）
  appendUser(session, 1, '旧的请求')
  appendAssistant(session, 1, '运行一下', CallId('p4old1'))
  appendToolResult(session, 1, 'p4old1', 'old result ' + 'x'.repeat(200))
  // turn2（当前轮，turnGuard 保护）：单条超大 R 直超窗口
  appendUser(session, 2, '再看这个日志')
  appendAssistant(session, 2, '读日志', CallId('p4big1'))
  const bigR = appendToolResult(session, 2, 'p4big1', 'BIG-LOG-' + 'y'.repeat(4000))

  let compressCalls = 0
  await ctx.plugin(ArgpGraphEngine, {
    windowTokens: 100, retainTokens: 20, minSpanChars: 20, recencyGuard: 0, maxPasses: 16, maxOverflowRetries: 3,
    onOverflowCompress: async (s: Session) => {
      // 模拟 PeratomCompressor.compressCurrentTurn：克隆原 R data、只改 inner text
      // （dsh 硬约束：tool/result replace 只能改 content），surface 换代
      compressCalls += 1
      const origData = s.events[bigR]?.data as unknown as { message: { content: Array<Record<string, unknown>> } }
      const origMsg = origData.message
      const origBlock = origMsg.content[0]
      s.append('tool/result', {
        ...(s.events[bigR]?.data as object),
        message: { ...origMsg, content: [{ ...origBlock, content: [{ type: 'text', text: 'extract: EADDRINUSE' }] }] },
      } as never, { surfaceOp: { op: 'replace', start: bigR, end: bigR }, sourceEventSeqs: [bigR] })
    },
  })
  const engine = ctx.compaction as ArgpGraphEngine
  engine.setSession(session)
  const agent = stubAgent(session)

  // 事件#1（retries=0）→ ① forcePrune（剪 turn1 旧 R）→ retry；compress 未调
  const e1 = await emitRequestError(ctx, agent, overflowFailure())
  assert.equal(e1?.kind, 'retry', 'step-1 forcePrune must retry')
  assert.equal(compressCalls, 0, 'compress must NOT run on the first overflow (step-1 only)')

  // 事件#2（retries=1）→ ② compress（替换超大 R）+ ③ forcePrune → retry
  const e2 = await emitRequestError(ctx, agent, overflowFailure())
  assert.equal(e2?.kind, 'retry', 'step-2 (compress + step-3 prune) must retry')
  assert.equal(compressCalls, 1, 'compress must run exactly once across the overflow sequence')

  // 收敛断言：超大 R 已被 extract 替换（surface 上不再含 BIG-LOG- 原文）
  let surfaceHasBig = false
  for (const seq of session.surface.nodes) {
    const ev = session.events[seq]
    const text = (ev?.data as { message?: { content?: Array<{ content?: Array<{ text?: string }> }> } } | undefined)
      ?.message?.content?.[0]?.content?.[0]?.text ?? ''
    if (text.includes('BIG-LOG-')) surfaceHasBig = true
  }
  assert.equal(surfaceHasBig, false, 'the oversized R must be replaced by the extract (converged below the window)')

  // 事件#3（retries=2）→ 三步用尽 → 保留原错误（不 retry），compress 不重跑
  const e3 = await emitRequestError(ctx, agent, overflowFailure())
  assert.equal(e3, undefined, 'third overflow must exhaust the three-step sequence and preserve the error')
  assert.equal(compressCalls, 1, 'compress must not re-run after exhaustion')
  await ctx.fiber.dispose()
})

// ---------------------------------------------------------------------------
// 补充：onOverflowCompress 未注入 → 行为与现役一致（第二次溢出即保留错误）
// ---------------------------------------------------------------------------

test('onOverflowCompress 未注入：第二次溢出保留错误（与现役行为一致）', async () => {
  const { ctx, engine } = await makeEngine({ maxOverflowRetries: 5 })
  try {
    const session = Session.create(SessionId('p4-overflow-noinject'))
    for (let turn = 1; turn <= 6; turn += 1) appendUser(session, turn, 'u' + turn + ': ' + 'x'.repeat(120))
    engine.setSession(session)
    const agent = stubAgent(session)
    // 第一次溢出：forcePrune → retry（现役行为）
    const e1 = await emitRequestError(ctx, agent, overflowFailure())
    assert.equal(e1?.kind, 'retry')
    // 第二次溢出：未注入 onOverflowCompress → 保留原错误（现役行为：无第②③步）
    const e2 = await emitRequestError(ctx, agent, overflowFailure())
    assert.equal(e2, undefined, 'without onOverflowCompress, the second overflow must preserve the error (current behavior)')
  } finally {
    await ctx.fiber.dispose()
  }
})
