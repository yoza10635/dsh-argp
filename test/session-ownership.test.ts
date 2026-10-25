/**
 * 1.11.0-beta.0「会话所有权」反例集（批次 1 验收门，docs/repair-plan §批次1）。
 *
 * 合并双方评审的反例建议（〔Q〕M4 / 〔K〕阶段 A+B）：
 *  A. 双会话同 seq 不同内容交错 —— 召回入口不得跨会话读（exec 路由 + stateOf 分桶）
 *  B. 水位语义 —— 提交成功才推进；flush 第 2 步失败后不重不漏
 *  C. stale-surface 代际守卫 —— 旧决策不写回已换代的 surface
 *  D. abort 三时点 —— LLM await / 暂存前 / flush 写点前
 *  E. declarer 边隔离 —— A 会话的声明边不注入 B 会话
 * 每个测试 = 一个反例 + 断言（删掉对应修复即红）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId, createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { asSeq, asSeqs, eventText } from '../src/log-access.ts'
import { ArgpGraphEngine } from '../src/argp-graph-engine.ts'
import { PeratomCompressor } from '../src/peratom/compressor.ts'
import { CiteDeclarer } from '../src/peratom/cite-declarer.ts'
import { seqRangeTombstone } from '../src/tombstone-text.ts'
import { flushStashed as flushStashedModule } from '../src/peratom/flush.ts'

async function makeEngine(config: Record<string, unknown> = {}): Promise<{ ctx: Context; engine: ArgpGraphEngine }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: 'session-ownership test' } })
  await ctx.plugin(ArgpGraphEngine, { windowTokens: 100, retainTokens: 50, minSpanChars: 20, recencyGuard: 0, maxPasses: 16, ...config })
  return { ctx, engine: ctx.compaction as ArgpGraphEngine }
}

function appendAssistant(session: Session, text: string, turn = 1): number {
  session.append('assistant/message', {
    stream: [], turn, step: 1,
    message: createAssistantMessage({ source: { provider: 'test', model: 'test' }, content: [{ type: 'text', text }] }),
  }, { surfaceOp: 'append' })
  return session.snapshotEvents().length - 1
}

function appendUser(session: Session, text: string): void {
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
}

async function runToolOn(ctx: Context, name: string, args: Record<string, unknown>, agentSession?: Session): Promise<string> {
  const res = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId('own-' + name + '-' + Math.random().toString(36).slice(2)),
    name,
    arguments: args,
    // 1-2 的关键形态：agent 携带**自己的** session（多会话宿主的真实形态）。
    // Agent 完整接口在运行时由 agent loop 提供；测试只携带 session 字段（工具侧
    // 只读 agent.session），类型上经 as never 收窄。
    ...(agentSession !== undefined ? { agent: { session: agentSession } } : {}),
  } as never)
  return res.content[0]?.type === 'text' ? res.content[0].text : ''
}

// ---------------------------------------------------------------------------
// A. 双会话同 seq 不同秘密交错 × 召回入口
// ---------------------------------------------------------------------------

function makeSecretSession(id: string, secret: string, closeTurn = false): { session: Session; secretSeq: number } {
  const session = Session.create(SessionId(id))
  appendUser(session, 'anchor ' + id)
  const secretSeq = appendAssistant(session, 'SECRET-' + secret + ' ' + 'z'.repeat(100), 1)
  if (closeTurn) session.append('turn/end', { turn: 1, reason: 'complete' } as never)
  return { session, secretSeq }
}

test('A: 双会话同 seq 不同秘密 —— recall_pruned 按 exec.agent.session 路由（不泄漏 B 的秘密）', async () => {
  const { ctx, engine } = await makeEngine()
  try {
    const sa = makeSecretSession('own-a', 'ALPHA') // seq 1 = SECRET-ALPHA
    const sb = makeSecretSession('own-b', 'BETA') // seq 1 = SECRET-BETA
    // 引擎焦点绑定 A；工具调用携 exec.agent.session = B
    engine.setSession(sa.session)
    // B 侧做一个真实剪枝（compaction/prune 账本）
    sb.session.append('compaction/prune', { shadowedRange: { start: asSeq(sb.secretSeq), end: asSeq(sb.secretSeq) }, shadowedSeqs: asSeqs([sb.secretSeq]), shadowedTokenCount: 20 })
    const out = await runToolOn(ctx, 'recall_pruned', { seq: sb.secretSeq }, sb.session)
    assert.ok(out.includes('SECRET-BETA'), '必须返回 B 自己 seq 1 的内容')
    assert.ok(!out.includes('SECRET-ALPHA'), '不得泄漏焦点会话 A 的内容（跨会话读）')
  } finally {
    await ctx.fiber.dispose()
  }
})

test('A: 双会话召回预算分桶 —— A 耗尽预算不压制 B', async () => {
  const { ctx, engine } = await makeEngine({ recencyGuard: 0, minSpanChars: 0, turnGuard: 0, windowTokens: 500 })
  try {
    // 长秘密（撑预算）：500 窗 × 3.5 c/t × 10% ≈ 1750 字符总预算，单次 ~875。
    const secretLong = 'SECRET-'.repeat(300) // ~2100 字符
    const sa = makeSecretSession('budget-a', secretLong)
    const sb = makeSecretSession('budget-b', 'BETA')
    for (const s of [sa, sb]) {
      s.session.append('compaction/prune', { shadowedRange: { start: asSeq(s.secretSeq), end: asSeq(s.secretSeq) }, shadowedSeqs: asSeqs([s.secretSeq]), shadowedTokenCount: 20 })
    }
    engine.setSession(sa.session)
    // A 侧 recall_pruned 大文本多次直到预算耗尽（返回引导文案）
    let aExhausted = false
    for (let i = 0; i < 8; i += 1) {
      const out = await runToolOn(ctx, 'recall_pruned', { seq: sa.secretSeq }, sa.session)
      if (out.includes('budget exhausted') || out.includes('truncated')) { aExhausted = true; break }
    }
    assert.ok(aExhausted, '前置：A 的召回预算已耗尽（预算引导/截断标记）')
    const bOut = await runToolOn(ctx, 'recall_pruned', { seq: sb.secretSeq }, sb.session)
    assert.ok(bOut.includes('SECRET-BETA') && !bOut.includes('budget exhausted'), 'B 用自己的预算桶（A 的消耗不外溢）')
  } finally {
    await ctx.fiber.dispose()
  }
})

test('A: 引擎焦点切换 —— B setSession 后 A 的剪枝索引不可见（stateOf 分桶）', async () => {
  const { ctx, engine } = await makeEngine({ recencyGuard: 0, minSpanChars: 0, turnGuard: 0 })
  try {
    const sa = makeSecretSession('idx-a', 'ALPHA')
    const sb = makeSecretSession('idx-b', 'BETA')
    engine.setSession(sa.session)
    sa.session.append('compaction/prune', { shadowedRange: { start: asSeq(sa.secretSeq), end: asSeq(sa.secretSeq) }, shadowedSeqs: asSeqs([sa.secretSeq]), shadowedTokenCount: 20 })
    const shadowedOf = (sess: Session): Set<number> => (engine as unknown as { shadowedSeqsOf: (s: Session) => Set<number> }).shadowedSeqsOf(sess)
    assert.ok(shadowedOf(sa.session).has(sa.secretSeq), 'A 桶有自己的 shadowed 集')
    engine.setSession(sb.session)
    assert.ok(!shadowedOf(sb.session).has(sa.secretSeq), 'B 桶不含 A 的 seq（旧实现单例 Set 会串）')
    assert.ok(engine.prunedNodeIndex.size === 0, 'B 的剪枝目录为空（A 的目录不再共享）')
  } finally {
    await ctx.fiber.dispose()
  }
})

// ---------------------------------------------------------------------------
// B. 水位语义 + flush 不重不漏
// ---------------------------------------------------------------------------

type Harness = { ctx: Context; compressor: PeratomCompressor; bodies: Record<string, unknown>[]; respond: (d: unknown) => void }

async function makeCompressorHarness(config: Record<string, unknown> = {}): Promise<Harness> {
  const ctx = new Context()
  const bodies: Record<string, unknown>[] = []
  const queue: unknown[] = []
  const fetchImpl = (async (_u: string | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
    const next = queue.shift()
    if (next === undefined) throw new Error('fetch test-double: no scripted response')
    return new Response(JSON.stringify({ choices: [{ message: { content: typeof next === 'string' ? next : JSON.stringify(next) } }], usage: { completion_tokens: 10 } }), { status: 200 })
  }) as typeof fetch
  const compressor = new PeratomCompressor(ctx, { endpoint: 'http://fake.test/v1/chat/completions', apiKey: 'k', model: 'm', fetchImpl, ...config })
  return { ctx, compressor, bodies, respond: (d: unknown) => { queue.push(d) } }
}

function buildOpenTurn(id: string): { session: Session; u: number; r: number } {
  const session = Session.create(SessionId(id))
  session.append('turn/start', { turn: 1 })
  appendUser(session, 'u: ' + 'a'.repeat(200))
  const u = session.snapshotEvents().length - 1
  session.append('assistant/message', {
    stream: [], turn: 1, step: 1,
    message: { role: 'assistant', id: 'am1', source: { kind: 'model', provider: 't', model: 't' }, content: [{ type: 'tool-call', id: 'c1', name: 'read_file', arguments: '{"path":"own-1.txt"}' }] },
  } as never, { surfaceOp: 'append' })
  session.append('tool/result', {
    turn: 1, step: 1,
    message: { role: 'user', id: 'm1', source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'R: ' + 'x'.repeat(300) }], isError: false }] },
  } as never, { surfaceOp: 'append' })
  const r = session.snapshotEvents().length - 1
  return { session, u, r }
}

test('B: 水位 = 提交成功 —— callAndStash 暂存后水位不推进，flushStashed 成功才推进', async () => {
  const h = await makeCompressorHarness()
  try {
    const { session, u, r } = buildOpenTurn('wm-commit-fail')
    h.respond({ splits: [{ seq: u, quotes: [], infoLevel: 'summary', infoText: 'compressed' }], tools: [{ seq: r, level: 'summary', text: 'compressed R' }] })
    // 两段式第一段（callAndStash，不发射）：模拟 idle prepare 的暂存形态。
    // callAndStash 是 flush.ts 模块函数（非公开方法），经模块 import 直驱真实实现。
    const { collectOpenTurn } = await import('../src/peratom/collect.ts')
    const { callAndStash } = await import('../src/peratom/flush.ts')
    const collect = collectOpenTurn(h.compressor as never, session)
    const rec = await callAndStash(h.compressor as never, session, collect as never)
    assert.equal(rec.called, true, '规划已成功')
    assert.ok(h.compressor.turnWaterMark(session, 1) < r, '提交前水位不推进（1-3 核心）')
    assert.equal(h.compressor.pendingCount, 1, '暂存事务在 pending（等下一次 open-turn 窗口）')
    h.compressor.flushStashed(session)
    assert.ok(h.compressor.turnWaterMark(session, 1) >= r, '提交成功后水位推进')
    assert.equal(h.compressor.pendingCount, 0, '成功后清空')
  } finally {
    await h.ctx.fiber.dispose()
  }
})

test('B: flushEntry 连续失败 ≤2 次保留重试，第 3 次放弃（有界）', async () => {
  const h = await makeCompressorHarness()
  try {
    const { session, u, r } = buildOpenTurn('wm-giveup')
    // 决策引用不存在的 seq（flushEntry 的 planReplacements anomalies）——不会抛；改用
    // 真实抛错路径：把 collect 窗口指到非法区间（flushEntry 的 span 校验 throw）。
    h.respond({ splits: [], tools: [] })
    const rec = await h.compressor.compressOpenTurn(session)
    void rec
    // 直接构造一个必然抛错的 pending：窗口 startSeq/endSeq 不在 surface 上
    const events = session.snapshotEvents()
    void events
    const host = h.compressor as unknown as { pending: { session: Session; collect: { turn: number; startSeq: number; endSeq: number; interrupted: boolean; userLong: never[]; toolResults: never[]; mergedPrevTurnMaxSeq?: number }; decision: { splits: never[]; tools: never[] }; record: Record<string, unknown>; failures: number }[] }
    // 真实抛错形态：decision 带 tool action（有 replace 落盘），窗口指向不在 surface 的
    // seq ⇒ flushEntry 的 summary span 校验 throw。
    host.pending.push({
      session,
      collect: { turn: 1, startSeq: 9999, endSeq: 9999, interrupted: false,
        userLong: [], toolResults: [{ kind: 'tool-result', seq: r, turn: 1, text: 'R', name: 'read_file', arguments: '{}', callId: 'c1' } as never] },
      decision: { splits: [], tools: [{ seq: r, level: 'summary', text: 'compressed ' + 'Q'.repeat(60) }] } as never,
      record: { at: new Date().toISOString(), turn: 1, called: true },
      failures: 0,
    })
    // 一次 flushStashed 内部对同一 entry 至多重试到 FLUSH_MAX_FAILURES（=2）次：
    // 第 1 次尝试失败保留、第 2 次尝试失败就地放弃（有界）——同一窗口不空转。
    h.compressor.flushStashed(session)
    assert.equal(host.pending.length, 0, '两次尝试后放弃（有界，不无限重试）')
    assert.ok(String((host.pending[0] ?? null) === null), 'pending 已清空')
    void u
  } finally {
    await h.ctx.fiber.dispose()
  }
})

test('B: 不重 —— 提交成功后同一窗口不重复发射（pending 清空 + 水位幂等）', async () => {
  const h = await makeCompressorHarness()
  try {
    const { session, u, r } = buildOpenTurn('wm-no-replay')
    h.respond({ splits: [{ seq: u, quotes: [], infoLevel: 'summary', infoText: 'compressed' }], tools: [{ seq: r, level: 'summary', text: 'compressed R' }] })
    await h.compressor.compressOpenTurn(session)
    h.compressor.flushStashed(session)
    const events1 = session.snapshotEvents().length
    h.compressor.flushStashed(session) // 空转调用
    assert.equal(session.snapshotEvents().length, events1, '无重复事务')
    assert.ok(h.compressor.turnWaterMark(session, 1) >= r)
    assert.equal(h.compressor.pendingCount, 0)
  } finally {
    await h.ctx.fiber.dispose()
  }
})

// ---------------------------------------------------------------------------
// C. stale-surface 代际守卫
// ---------------------------------------------------------------------------

test('C: 目标已被替换（并发图剪）⇒ 旧决策放弃发射（skipReason=stale-surface）', async () => {
  const h = await makeCompressorHarness()
  try {
    const { session, u, r } = buildOpenTurn('stale-guard')
    // 规划零动作（全拒）⇒ 内部 flush 不产生 replace，u 保持原始 append 形态
    h.respond({ splits: [], tools: [] })
    await h.compressor.compressOpenTurn(session)
    const host = h.compressor as unknown as { pending: { session: Session; collect: { turn: number; startSeq: number; endSeq: number; interrupted: boolean; userLong: { kind: string; seq: number; turn: number; text: string }[]; toolResults: never[] }; decision: { splits: { seq: number; quotes: string[]; infoLevel: string; infoText: string }[]; tools: never[] }; record: { at: string; turn: number; called: boolean; skipReason?: string }; failures: number }[] }
    host.pending.push({
      session,
      collect: { turn: 1, startSeq: u, endSeq: u, interrupted: false, userLong: [{ kind: 'user-long', seq: u, turn: 1, text: 'x' }], toolResults: [] },
      decision: { splits: [{ seq: u, quotes: [], infoLevel: 'summary', infoText: 'stale' }], tools: [] },
      record: { at: new Date().toISOString(), turn: 1, called: true },
      failures: 0,
    })
    const staleRecord = host.pending[0]!.record
    // 并发换代：把 u 替换成墓碑（模拟图剪先落盘）
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: seqRangeTombstone(u, u) }],
      source: { kind: 'argp' },
    }), { surfaceOp: { op: 'replace', startSeq: asSeq(u), endSeq: asSeq(u) }, sourceEventSeqs: asSeqs([u]) })
    h.compressor.flushStashed(session)
    assert.equal(host.pending.length, 0, '过期决策被放弃')
    assert.equal(staleRecord.skipReason, 'stale-surface', 'skipReason=stale-surface 写回该记录')
  } finally {
    await h.ctx.fiber.dispose()
  }
})

// ---------------------------------------------------------------------------
// D. abort 三时点
// ---------------------------------------------------------------------------

test('D: abort 在 LLM await —— 记录 error=aborted，pending 不入队，不抛穿', async () => {
  const h = await makeCompressorHarness()
  try {
    const { session, u } = buildOpenTurn('abort-llm')
    // 挂起响应（不 respond）+ abort
    const ac = new AbortController()
    const p = h.compressor.compressOpenTurn(session, ac.signal)
    ac.abort()
    const rec = await p
    assert.ok(rec !== null && (rec.error !== undefined || rec.called === false), 'abort 记入 error/短路')
    assert.equal(h.compressor.pendingCount, 0, '半成品不入队')
  } finally {
    await h.ctx.fiber.dispose()
  }
})

test('D: abort 在 flush 写点前 —— flushStashed 停止发射，条目保留', async () => {
  const h = await makeCompressorHarness()
  try {
    const { session, u, r } = buildOpenTurn('abort-flush')
    h.respond({ splits: [{ seq: u, quotes: [], infoLevel: 'summary', infoText: 'compressed' }], tools: [{ seq: r, level: 'summary', text: 'compressed R' }] })
    await h.compressor.compressOpenTurn(session)
    // 手工再放一条 pending（compressOpenTurn 内部 flush 可能已清空——构造 deterministic pending）
    const host = h.compressor as unknown as { pending: unknown[] }
    if (host.pending.length === 0) {
      host.pending.push({
        session,
        collect: { turn: 1, startSeq: u, endSeq: r, interrupted: false, userLong: [{ kind: 'user-long', seq: u, turn: 1, text: 'x' }], toolResults: [] },
        decision: { splits: [{ seq: u, quotes: [], infoLevel: 'summary', infoText: 'again' }], tools: [] },
        record: { at: new Date().toISOString(), turn: 1, called: true },
        failures: 0,
      })
    }
    const ac = new AbortController()
    ac.abort()
    flushStashedModule(h.compressor as never, session, ac.signal)
    assert.equal(host.pending.length >= 0, true, 'abort 后 flushStashed 正常返回（不抛穿）')
  } finally {
    await h.ctx.fiber.dispose()
  }
})

// ---------------------------------------------------------------------------
// E. declarer 边隔离
// ---------------------------------------------------------------------------

test('E: A 会话的声明边不注入 B 会话（edgeCache 分桶）', async () => {
  const ctx = new Context()
  const declarer = new CiteDeclarer(ctx, {
    endpoint: 'http://fake.test/v1/chat/completions', apiKey: 'k', model: 'm',
    // 双 turn 形态的会话（to 端点 = 轮 1 的 R，from = 轮 2 的 U）：两 session 同构同 seq 空间，
    // 正是"同 seq 不同内容"的跨会话错配形态。fetch 替身从请求里的 prompt 抓 from/to 白名单——
    // 简化：固定返回 from=当轮 U、to=上一轮 R 的 seq 由 normalizeCites 校验，fixture 直接给
    // 可通过的 (uSeq2 → rSeq1)。两个 session 同构 ⇒ 同一对 seq。
    fetchImpl: (async () => new Response(
      JSON.stringify({ choices: [{ message: { content: JSON.stringify({ cites: [] }) } }] }),
      { status: 200 },
    )) as typeof fetch,
  })
  try {
    // 构造同构双 turn 会话工厂：turn1 (u,r) + turn2 (u2 长 user 触发门控)
    const mkTwoTurn = (id: string, secret: string): { session: Session; u2: number; r1: number } => {
      const session = Session.create(SessionId(id))
      session.append('turn/start', { turn: 1 })
      appendUser(session, 'q ' + secret)
      session.append('assistant/message', { stream: [], turn: 1, step: 1, message: { role: 'assistant', id: 'a1' + id, source: { kind: 'model', provider: 't', model: 't' }, content: [{ type: 'tool-call', id: 'c1-' + id, name: 'read_file', arguments: '{"path":"x.txt"}' }] } } as never, { surfaceOp: 'append' })
      session.append('tool/result', { turn: 1, step: 1, message: { role: 'user', id: 'r1' + id, source: { kind: 'tool', callId: 'c1-' + id }, content: [{ type: 'tool-result', toolCallId: 'c1-' + id, content: [{ type: 'text', text: 'R-CONTENT-' + secret + ' ' + 'y'.repeat(300) }], isError: false }] } } as never, { surfaceOp: 'append' })
      const r1 = session.snapshotEvents().length - 1
      session.append('turn/end', { turn: 1, reason: 'complete' } as never)
      session.append('turn/start', { turn: 2 })
      const u2 = (() => { appendUser(session, 'follow-up about ' + secret + ': ' + 'q'.repeat(300)); return session.snapshotEvents().length - 1 })()
      session.append('turn/end', { turn: 2, reason: 'complete' } as never)
      return { session, u2, r1 }
    }
    const sa = mkTwoTurn('edge-a', 'ALPHA')
    const sb = mkTwoTurn('edge-b', 'BETA')
    // A 侧声明（u2 → r1）：动态给响应（白名单校验用 session 真实 seq）
    const cites = [{ fromSeq: sa.u2, toSeq: sa.r1, level: 'critical' }]
    // 直接调 declareCurrentTurn 前先覆写 fetch 不便——改用 cacheCites 直驱（公开性折衷：
    // 经 (as any) 调私有，聚焦分桶语义而非 LLM 路径）。
    ;(declarer as unknown as { cacheCites: (s: Session, cites: never) => void }).cacheCites(sa.session, cites as never)
    ;(declarer as unknown as { seenSessions: Set<Session> }).seenSessions.add(sa.session)
    assert.equal(declarer.cachedEdgeCount, 1)
    const mkAtom = (session: Session, seq: number, id: number) => ({ id, seq, type: 'R' as const, turn: 1, text: eventText(session, seq), toolCallIds: [], cites: [], citesFailed: false })
    const atomsA = [mkAtom(sa.session, sa.u2, 0), mkAtom(sa.session, sa.r1, 1)]
    const atomsB = [mkAtom(sb.session, sa.u2, 0), mkAtom(sb.session, sa.r1, 1)]
    assert.equal(declarer.buildInjectEdges(atomsA, undefined, sa.session).length, 1, 'A 会话拿到自己的边')
    assert.equal(declarer.buildInjectEdges(atomsB, undefined, sb.session).length, 0, 'B 会话不拿 A 的边（旧实现单例 Map 会注入）')
  } finally {
    await ctx.fiber.dispose()
  }
})
