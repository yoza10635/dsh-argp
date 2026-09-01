import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ArgpGraphEngine, EDGE_WEIGHTS, eventText, extractCites, looksAskText, type Atom } from '../src/argp-graph-engine.ts'

async function makeEngine(config: Record<string, unknown> = {}): Promise<{ ctx: Context; engine: ArgpGraphEngine }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: 'argp 0-llm test persona' } })
  await ctx.plugin(ArgpGraphEngine, { windowTokens: 100, retainTokens: 50, minSpanChars: 20, recencyGuard: 0, maxPasses: 16, ...config })
  return { ctx, engine: ctx.compaction as ArgpGraphEngine }
}

function appendUser(session: Session, text: string): void {
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
}

function appendAssistant(session: Session, text: string, turn: number): void {
  session.append('assistant/message', {
    turn,
    step: 1,
    message: createAssistantMessage({
      source: { provider: 'test', model: 'test' },
      content: [{ type: 'text', text }],
    }),
  }, { surfaceOp: 'append' })
}

test('extractCites: bare JSON, fenced JSON, empty cites, invalid, absent', () => {
  const bare = extractCites('answer\n{"cites":["hello world"]}')
  assert.equal(bare.body, 'answer')
  assert.deepEqual(bare.cites, [{ text: 'hello world', level: 'supporting' }])
  assert.equal(bare.attempted, true)
  assert.equal(bare.parseFailed, false)

  const fenced = extractCites('answer\n```json\n{"cites":["hello world"]}\n```')
  assert.equal(fenced.body, 'answer')
  assert.deepEqual(fenced.cites, [{ text: 'hello world', level: 'supporting' }])
  assert.equal(fenced.parseFailed, false)

  const empty = extractCites('answer\n{"cites":[]}')
  assert.equal(empty.body, 'answer')
  assert.deepEqual(empty.cites, [])
  assert.equal(empty.parseFailed, false)

  // A1 V6 分级契约：{"t":...,"l":"c|x|s"} 对象条目
  const graded = extractCites('answer\n{"cites":[{"t":"the gateway release","l":"c"},{"t":"some file","l":"x"},{"t":"plain"}]}')
  assert.equal(graded.parseFailed, false)
  assert.deepEqual(graded.cites, [
    { text: 'the gateway release', level: 'critical' },
    { text: 'some file', level: 'contextual' },
    { text: 'plain', level: 'supporting' },
  ])

  // 形状不合法（混入数字/对象缺 t）→ parseFailed
  const badShape = extractCites('answer\n{"cites":["ok", 42]}')
  assert.equal(badShape.attempted, true)
  assert.equal(badShape.parseFailed, true)
  const missingT = extractCites('answer\n{"cites":[{"x":"no t"}]}')
  assert.equal(missingT.parseFailed, true)

  const invalid = extractCites('answer\n{"cites": [')
  assert.equal(invalid.attempted, true)
  assert.equal(invalid.parseFailed, true)

  const absent = extractCites('answer')
  assert.equal(absent.attempted, false)
  assert.equal(absent.parseFailed, false)
})

test('eventText: user/assistant/tool-result/tool-call and reasoning exclusion', () => {
  const session = Session.create(SessionId('event-text-test'))
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'user text' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  const uSeq = session.events.length - 1
  assert.equal(eventText(session, uSeq), 'user text')

  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: createAssistantMessage({
      source: { provider: 'test', model: 'test' },
      content: [{ type: 'reasoning', text: 'hidden' }, { type: 'text', text: 'assistant text' }],
    }),
  }, { surfaceOp: 'append' })
  const aSeq = session.events.length - 1
  assert.equal(eventText(session, aSeq), 'assistant text')

  session.append('tool/result', {
    turn: 1,
    step: 1,
    message: {
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: 'tool text' }], isError: false }],
      source: { kind: 'tool', callId: 'call_1' },
      id: 'm_1',
    },
  } as never, { surfaceOp: 'append' })
  const rSeq = session.events.length - 1
  assert.equal(eventText(session, rSeq), 'tool text')

  session.append('tool/call', { turn: 1, name: 'read_file', arguments: '{"path":"x"}' } as never)
  const tSeq = session.events.length - 1
  assert.equal(eventText(session, tSeq), '[tool-call read_file({"path":"x"})]')
})

test('atomize: U/A/R/X types, cites stripping, toolCallIds', async () => {
  const { ctx, engine } = await makeEngine()
  try {
    const session = Session.create(SessionId('atomize-test'))
    appendUser(session, 'question')
    appendAssistant(session, 'answer\n{"cites":["question"]}', 1)
    const aSeq = session.events.length - 1
    const atoms = engine.atomize(session)
    assert.equal(atoms.length, 2)
    assert.equal(atoms[0]?.type, 'U')
    assert.equal(atoms[1]?.type, 'A')
    assert.equal(atoms[1]?.seq, aSeq)
    assert.equal(atoms[1]?.text, 'answer')
    assert.deepEqual(atoms[1]?.cites, [{ text: 'question', level: 'supporting' }])
    assert.equal(atoms[1]?.citesFailed, false)
    assert.equal(engine.citeStats.aAtoms, 1)
    assert.equal(engine.citeStats.declared, 1)
  } finally {
    await ctx.fiber.dispose()
  }
})

test('buildGraph: supporting edge, no-hit, and ambiguity with U priority', async () => {
  const { ctx, engine } = await makeEngine()
  try {
    const atoms: Atom[] = [
      { id: 0, seq: 10, type: 'U', turn: 1, text: 'the gateway release passes. Neither', toolCallIds: [], cites: [], citesFailed: false },
      { id: 1, seq: 11, type: 'A', turn: 1, text: 'the gateway release passes. Neither', toolCallIds: [], cites: [], citesFailed: false },
      { id: 2, seq: 12, type: 'A', turn: 2, text: 'answer', toolCallIds: [], cites: [{ text: 'the gateway release passes', level: 'supporting' }], citesFailed: false },
    ]
    const { edges, inDegree } = engine.buildGraph(atoms)
    assert.equal(edges.length, 1)
    assert.equal(edges[0]?.from, 2)
    assert.equal(edges[0]?.to, 0) // U 优先于 A1
    assert.equal(inDegree.get(0), 1)
    assert.equal(engine.citeStats.resolved, 1)
    assert.equal(engine.citeStats.ambiguous, 1)

    const noHit = engine.buildGraph([
      { id: 0, seq: 1, type: 'A', turn: 1, text: 'answer', toolCallIds: [], cites: [{ text: 'not present', level: 'supporting' }], citesFailed: false },
    ])
    assert.equal(noHit.edges.length, 0)
  } finally {
    await ctx.fiber.dispose()
  }
})

test('compactIfNeeded: prunes old A nodes, never U, and records one transaction', async () => {
  const { ctx, engine } = await makeEngine()
  try {
    const session = Session.create(SessionId('compact-test'))
    appendUser(session, 'user anchor')
    appendAssistant(session, 'A1:' + 'x'.repeat(300), 1)
    appendAssistant(session, 'A2:' + 'y'.repeat(300), 2)
    appendAssistant(session, 'A3:' + 'z'.repeat(300), 3)
    engine.setSession(session)
    const agent = { session } as never
    const result = await engine.compactIfNeeded(agent, 'pressure', new AbortController().signal)
    assert.ok(result !== null)
    assert.equal(engine.records.length, 1)
    const record = engine.records[0]
    assert.ok(record !== undefined)
    assert.ok(record.prunedAtoms.length >= 2)
    if (engine.closurePrunes.length === 0) {
      assert.equal(record.prunedAtoms.every(a => a.type === 'A'), true)
    }
    assert.ok(record.shadowedSeqs.length >= 2)
    const stillSurface = new Set(session.surface.nodes)
    const userSeq = [...session.events].findIndex(e => e.type === 'user/message')
    if (engine.closurePrunes.length === 0) {
      assert.ok(stillSurface.has(userSeq))
    }
    for (const a of record.prunedAtoms) {
      assert.equal(engine.recall(a.seq) !== null, true)
    }
  } finally {
    await ctx.fiber.dispose()
  }
})

test('list_pruned index and recall fallback after prune', async () => {
  const { ctx, engine } = await makeEngine()
  try {
    const session = Session.create(SessionId('list-pruned-test'))
    appendUser(session, 'user anchor')
    appendAssistant(session, 'A1:' + 'x'.repeat(300), 1)
    appendAssistant(session, 'A2:' + 'y'.repeat(300), 2)
    appendAssistant(session, 'A3:' + 'z'.repeat(300), 3)
    engine.setSession(session)
    await engine.compactIfNeeded({ session } as never, 'pressure', new AbortController().signal)
    const record = engine.records[0]
    assert.ok(record !== undefined)
    const firstPruned = record.prunedAtoms[0]
    assert.ok(firstPruned !== undefined)
    const recalled = engine.recall(firstPruned.seq)
    assert.ok(recalled !== null && recalled.length > 0)
    const indexed = engine.prunedNodeIndex.get(firstPruned.seq)
    assert.ok(indexed !== undefined)
    assert.equal(indexed.seq, firstPruned.seq)
    assert.equal(indexed.type, firstPruned.type)
  } finally {
    await ctx.fiber.dispose()
  }
})

test('compactRegion: prunes a balanced A/R span and leaves U on surface', async () => {
  const { ctx, engine } = await makeEngine()
  try {
    const session = Session.create(SessionId('compact-region-test'))
    appendUser(session, 'user anchor')
    const a1Text = 'A1:' + 'x'.repeat(200)
    appendAssistant(session, a1Text, 1)
    const a1Seq = session.events.length - 1
    appendAssistant(session, 'A2:' + 'y'.repeat(200), 2)
    const a2Seq = session.events.length - 1
    appendAssistant(session, 'A3:' + 'z'.repeat(200), 3)
    engine.setSession(session)
    const result = await engine.compactRegion(a1Seq, a2Seq, { session } as never)
    assert.ok(result !== null)
    assert.equal(engine.records.length, 1)
    const record = engine.records[0]
    assert.ok(record !== undefined)
    assert.equal(record.shadowedSeqs.includes(a1Seq), true)
    assert.equal(record.shadowedSeqs.includes(a2Seq), true)
    assert.equal(record.prunedAtoms.every(a => a.type === 'A'), true)
    const stillSurface = new Set(session.surface.nodes)
    const userSeq = [...session.events].findIndex(e => e.type === 'user/message')
    assert.ok(stillSurface.has(userSeq))
    assert.ok(!stillSurface.has(a1Seq))
    assert.ok(!stillSurface.has(a2Seq))
  } finally {
    await ctx.fiber.dispose()
  }
})

test('compactNow: selects oldest A/R block and prunes it without LLM', async () => {
  const { ctx, engine } = await makeEngine()
  try {
    const session = Session.create(SessionId('compact-now-test'))
    appendUser(session, 'user anchor')
    appendAssistant(session, 'A1:' + 'x'.repeat(200), 1)
    appendAssistant(session, 'A2:' + 'y'.repeat(200), 2)
    appendAssistant(session, 'A3:' + 'z'.repeat(200), 3)
    engine.setSession(session)
    const agent = {
      session,
      runMaintenance: async <T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> => fn(new AbortController().signal),
    }
    const result = await engine.compactNow(agent as never, new AbortController().signal)
    assert.ok(result !== null)
    assert.equal(engine.records.length, 1)
    const record = engine.records[0]
    assert.ok(record !== undefined)
    assert.equal(record.prunedAtoms.every(a => a.type === 'A'), true)
    const stillSurface = new Set(session.surface.nodes)
    const userSeq = [...session.events].findIndex(e => e.type === 'user/message')
    assert.ok(stillSurface.has(userSeq))
  } finally {
    await ctx.fiber.dispose()
  }
})

test('prune emits compaction/prune (ledger) + compaction/summary (UI display)', async () => {
  const { ctx, engine } = await makeEngine()
  try {
    const session = Session.create(SessionId('prune-event-test'))
    appendUser(session, 'user anchor')
    appendAssistant(session, 'A1:' + 'x'.repeat(300), 1)
    appendAssistant(session, 'A2:' + 'y'.repeat(300), 2)
    appendAssistant(session, 'A3:' + 'z'.repeat(300), 3)
    engine.setSession(session)
    await engine.compactIfNeeded({ session } as never, 'pressure', new AbortController().signal)
    const events = [...session.events]
    const pruneEvents = events.filter(e => e.type === 'compaction/prune')
    const summaryEvents = events.filter(e => e.type === 'compaction/summary')
    assert.equal(pruneEvents.length, 1)
    // 2026-08-28 设计修订（docs/webui-liaison-2026-08-28.md §8）：compaction/summary
    // 是宿主 CompactionNodeView 的唯一显示文本通道——不发则 UI 节点显示"压缩摘要不可用"。
    // 账本语义不变：权威剪枝账本仍只认 compaction/prune，summary 仅供 UI 展示。
    assert.equal(summaryEvents.length, 1)
    assert.ok(((summaryEvents[0]?.data as { summary?: { text?: string }[] }).summary ?? [])
      .some(block => typeof block.text === 'string' && block.text.includes('ARGP 图剪')))
    const record = engine.records[0]
    assert.ok(record !== undefined)
    const tombstoneSeq = record.intervals[0]?.tombstoneSeq
    assert.ok(tombstoneSeq !== undefined)
    const tombstone = events[tombstoneSeq]
    assert.ok(tombstone !== undefined)
    assert.ok(((tombstone as { sourceEventSeqs?: number[] }).sourceEventSeqs ?? []).includes(pruneEvents[0]?.seq ?? -1))
  } finally {
    await ctx.fiber.dispose()
  }
})

test('reserveTokens: blocks pruning when contextTokens below effective threshold', async () => {
  const { ctx, engine } = await makeEngine({ reserveTokens: 1000 })
  try {
    const session = Session.create(SessionId('reserve-test'))
    appendUser(session, 'user anchor')
    appendAssistant(session, 'A1:' + 'x'.repeat(300), 1)
    appendAssistant(session, 'A2:' + 'y'.repeat(300), 2)
    appendAssistant(session, 'A3:' + 'z'.repeat(300), 3)
    engine.setSession(session)
    const result = await engine.compactIfNeeded({ session } as never, 'pressure', new AbortController().signal)
    assert.equal(result, null)
    assert.equal(engine.records.length, 0)
  } finally {
    await ctx.fiber.dispose()
  }
})

// ---- citesObligation（回复级 cites 义务门控）----

type SectionedAssembly = { sections: { name: string }[] }

async function sectionNames(ctx: Context): Promise<string[]> {
  const sp = (ctx as unknown as { systemPrompt: { assemble(): Promise<SectionedAssembly> } }).systemPrompt
  const assembly = await sp.assemble()
  return assembly.sections.map(s => s.name)
}

test('citesObligation auto: default mount keeps argp-cites (no declarer)', async () => {
  const { ctx, engine } = await makeEngine()
  try {
    assert.equal(engine.citesObligation, true)
    assert.ok((await sectionNames(ctx)).includes('argp-cites'))
  } finally {
    await ctx.fiber.dispose()
  }
})

test('citesObligation auto: armed declarer drops argp-cites, keeps contract+catalog', async () => {
  const { ctx, engine } = await makeEngine({
    peratom: { compressor: false, zoom: false, declarer: { endpoint: 'http://declarer.test/v1', apiKey: 'test-key' } },
  })
  try {
    assert.equal(engine.peratomStack?.declarer?.armed, true)
    assert.equal(engine.citesObligation, false)
    const names = await sectionNames(ctx)
    assert.ok(!names.includes('argp-cites'), 'argp-cites should be absent under armed declarer')
    assert.ok(names.includes('argp-contract'))
    assert.ok(names.includes('argp-catalog'))
  } finally {
    await ctx.fiber.dispose()
  }
})

test('citesObligation auto: unarmed declarer keeps argp-cites (edge sources never both zero)', async () => {
  const savedKey = process.env['DEEPSEEK_API_KEY']
  const savedSource = process.env['ARGP_MODEL_SOURCE']
  delete process.env['DEEPSEEK_API_KEY']
  delete process.env['ARGP_MODEL_SOURCE']
  try {
    const { ctx, engine } = await makeEngine({ peratom: { compressor: false, zoom: false, declarer: {} } })
    try {
      assert.equal(engine.peratomStack?.declarer?.armed, false)
      assert.equal(engine.citesObligation, true)
      assert.ok((await sectionNames(ctx)).includes('argp-cites'))
    } finally {
      await ctx.fiber.dispose()
    }
  } finally {
    if (savedKey !== undefined) process.env['DEEPSEEK_API_KEY'] = savedKey
    if (savedSource !== undefined) process.env['ARGP_MODEL_SOURCE'] = savedSource
  }
})

test('citesObligation explicit overrides win over auto', async () => {  // 强制关（无 peratom）
  {
    const { ctx, engine } = await makeEngine({ citesObligation: false })
    try {
      assert.equal(engine.citesObligation, false)
      assert.ok(!(await sectionNames(ctx)).includes('argp-cites'))
    } finally {
      await ctx.fiber.dispose()
    }
  }
  // 强制开（declarer 已武装，A₁-A₃ 实验臂形态）
  {
    const { ctx, engine } = await makeEngine({
      citesObligation: true,
      peratom: { compressor: false, zoom: false, declarer: { endpoint: 'http://declarer.test/v1', apiKey: 'test-key' } },
    })
    try {
      assert.equal(engine.citesObligation, true)
      assert.ok((await sectionNames(ctx)).includes('argp-cites'))
    } finally {
      await ctx.fiber.dispose()
    }
  }
})

test('buildGraph dedup: injected edge identical to reply-cites edge is dropped (first-come wins)', async () => {
  const { ctx, engine } = await makeEngine({
    injectEdges: () => [{ from: 1, to: 0, level: 'critical' }],
  })
  try {
    const session = Session.create(SessionId('edge-dedup-test'))
    appendUser(session, 'The answer is 42.')
    appendAssistant(session, 'The answer is 42.\n{"cites":["The answer is 42."]}', 1)
    appendAssistant(session, 'A2:' + 'y'.repeat(300), 2)
    appendAssistant(session, 'A3:' + 'z'.repeat(300), 3)
    engine.setSession(session)
    await engine.compactIfNeeded({ session } as never, 'pressure', new AbortController().signal)
    const same = engine.lastEdges.filter(e => e.from === 1 && e.to === 0)
    assert.equal(same.length, 1, 'duplicate (from,to) collapsed to a single edge')
    assert.equal(same[0]?.level, 'supporting', 'reply-level edge kept (first-come priority)')
    assert.equal(engine.citeStats.resolved, 1)
  } finally {
    await ctx.fiber.dispose()
  }
})

test('pressure accounting: usage anchor (incl. cacheWriteTokens) + increment drives pruning above chars heuristic', async () => {
  const { ctx, engine } = await makeEngine({ windowTokens: 200, retainTokens: 50 })
  try {
    const session = Session.create(SessionId('anchor-accounting-test'))
    // 测试环境不桥接 session/event 总线（真宿主由 app 接线）——手动模拟 host 桥接，
    // 使引擎的 usage 锚点 handler 收到事件。
    const bridge = (ev: unknown): void => { (ctx as unknown as { emit: (n: string, ...a: unknown[]) => void }).emit('session/event', session, ev) }
    appendUser(session, 'user anchor')
    bridge(session.events[session.events.length - 1])
    // 锚点事件：assistant/message 携带 provider usage；cacheWriteTokens 必须计入
    // 锚点和（Anthropic 风格 provider）——本例 30+0+45=75，缺 cacheWrite 则 30，
    // 两种口径下只有含 cacheWrite 的锚定估计能过 200 触发线。
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createAssistantMessage({ source: { provider: 'test', model: 'test' }, content: [{ type: 'text', text: 'a' }] }),
      usage: { inputTokens: 30, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 45 },
    }, { surfaceOp: 'append' })
    bridge(session.events[session.events.length - 1])
    appendAssistant(session, 'B2:' + 'x'.repeat(247), 2)
    appendAssistant(session, 'B3:' + 'y'.repeat(247), 3)
    engine.setSession(session)
    await engine.compactIfNeeded({ session } as never, 'pressure', new AbortController().signal)
    // chars 全量启发式 ≈ 512 chars / 3.5 = 147 < 200（不会触发）；
    // 锚定 = 75 + ceil(500/3.5)=143 → 218 ≥ 200（触发并剪 turn2）。
    assert.equal(engine.records.length, 1, 'anchored estimate crossed threshold and pruned')
  } finally {
    await ctx.fiber.dispose()
  }
})


test('ask-exempt U: covered ask U can be pruned when no cross refs', async () => {
  const { ctx, engine } = await makeEngine()
  try {
    const session = Session.create(SessionId('ask-covered-test'))
    appendUser(session, 'What is the answer?')
    appendAssistant(session, 'The answer is 42.\n{"cites":["What is the answer?"]}', 1)
    appendAssistant(session, 'A2:' + 'y'.repeat(300), 2)
    appendAssistant(session, 'A3:' + 'z'.repeat(300), 3)
    engine.setSession(session)
    await engine.compactIfNeeded({ session } as never, 'pressure', new AbortController().signal)
    const record = engine.records[0]
    assert.ok(record !== undefined)
    assert.ok(record.prunedAtoms.some(a => a.type === 'U'))
  } finally {
    await ctx.fiber.dispose()
  }
})

test('ask-exempt U: cross-reference invalidates exemption and keeps U', async () => {
  const { ctx, engine } = await makeEngine()
  try {
    const session = Session.create(SessionId('ask-cross-ref-test'))
    appendUser(session, 'What is the answer?')
    appendAssistant(session, 'The answer is 42.\n{"cites":["What is the answer?"]}', 1)
    appendAssistant(session, 'Another answer.\n{"cites":["What is the answer?"]}', 2)
    appendAssistant(session, 'A3:' + 'z'.repeat(300), 3)
    engine.setSession(session)
    await engine.compactIfNeeded({ session } as never, 'pressure', new AbortController().signal)
    const record = engine.records[0]
    assert.ok(record !== undefined)
    assert.equal(record.prunedAtoms.some(a => a.type === 'U'), false)
  } finally {
    await ctx.fiber.dispose()
  }
})

test('version dedup: older duplicate A is pruned while newer copy stays eligible', async () => {
  const { ctx, engine } = await makeEngine()
  try {
    const session = Session.create(SessionId('version-dedup-test'))
    appendUser(session, 'user anchor')
    const dupText = 'DUP:' + 'x'.repeat(30)
    appendAssistant(session, dupText, 1)
    const oldSeq = session.events.length - 1
    appendAssistant(session, dupText, 2)
    appendAssistant(session, 'A3:' + 'y'.repeat(300), 3)
    appendAssistant(session, 'A4:' + 'z'.repeat(300), 4)
    engine.setSession(session)
    await engine.compactIfNeeded({ session } as never, 'pressure', new AbortController().signal)
    const record = engine.records[0]
    assert.ok(record !== undefined)
    assert.ok(record.prunedAtoms.some(a => a.seq === oldSeq))
  } finally {
    await ctx.fiber.dispose()
  }
})


test('catalogText: renders pruned U/A items with context header', async () => {
  const { ctx, engine } = await makeEngine()
  try {
    const session = Session.create(SessionId('catalog-test'))
    appendUser(session, 'user anchor')
    appendAssistant(session, 'A1:' + 'x'.repeat(300), 1)
    appendAssistant(session, 'A2:' + 'y'.repeat(300), 2)
    appendAssistant(session, 'A3:' + 'z'.repeat(300), 3)
    engine.setSession(session)
    await engine.compactIfNeeded({ session } as never, 'pressure', new AbortController().signal)
    const catalog = engine.catalogText()
    assert.ok(catalog.includes('[context] Compression removed'))
    assert.ok(catalog.includes('[A'))
  } finally {
    await ctx.fiber.dispose()
  }
})

// 回归：per-atom 原地压缩（无 compaction/prune 事务）不得计入剪枝账本。
// 2026-08-27 定位：旧 shadowedSeqsOf 靠「replace 形态推断」剪枝，per-atom 压缩的
// start===end replace（sourceEventSeqs=[被压原子]）穿透门控被当「已剪」，导致
// catalog 谎报 "Compression removed N"、system 前缀逐轮变、跨轮缓存全断
// （60 轮 A 臂实证：catalog removed 44，而 compaction/prune 事件数=0）。
// 修复后只认 compaction/prune.shadowedSeqs 权威账本，per-atom 压缩天然不在内。
test('regression: per-atom in-place compression is NOT counted as pruned (no false "Compression removed")', async () => {
  const { ctx, engine } = await makeEngine()
  try {
    const session = Session.create(SessionId('peratom-not-pruned'))
    appendUser(session, 'original user content ' + 'x'.repeat(50))
    const uSeq = session.events.length - 1
    // per-atom 原地压缩形态：user 副本 replace 原文（start===end、sourceEventSeqs=[原 seq]），
    // **不**发 compaction/prune（peratom/compressor.ts 的写回路径无剪枝事务）。
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '[compressed copy]' }],
      source: { kind: 'plugin', plugin: 'dsh-argp' },
    }), { surfaceOp: { op: 'replace', start: uSeq, end: uSeq }, sourceEventSeqs: [uSeq] })
    engine.setSession(session)

    // 剪枝账本必须为空：压缩原子不算被剪
    const shadowed = (engine as unknown as { shadowedSeqsOf(s: Session): Set<number> }).shadowedSeqsOf(session)
    assert.equal(shadowed.size, 0, 'per-atom in-place compression must NOT enter the shadowed ledger, got: ' + [...shadowed].join(','))
    // catalog 不得谎报 "Compression removed"（无真剪枝 → 空字符串）
    const catalog = engine.catalogText()
    assert.ok(!catalog.includes('[context] Compression removed'), 'catalog must not falsely report a removal for a compression, got: ' + catalog.slice(0, 120))
    // 程序化 recall 不应把压缩原子当 shadowed 命中（recall 仅命中剪节点）
    assert.equal(engine.recall(uSeq), null, 'recall must not treat a compressed (non-pruned) atom as a pruned node')
  } finally {
    await ctx.fiber.dispose()
  }
})

// 对照：真剪枝事务（compaction/prune 携带 shadowedSeqs）仍须正常入账、catalog 正常渲染。
test('regression: real prune transaction (compaction/prune) IS counted as pruned', async () => {
  const { ctx, engine } = await makeEngine()
  try {
    const session = Session.create(SessionId('real-prune-transaction'))
    appendUser(session, 'user anchor')
    appendAssistant(session, 'A1:' + 'x'.repeat(300), 1)
    const aSeq = session.events.length - 1
    // 模拟 pruneIntervals 的权威事务：compaction/prune 携带 shadowedSeqs + tombstone replace
    session.append('compaction/prune', { shadowedRange: { start: aSeq, end: aSeq }, shadowedSeqs: [aSeq], shadowedTokenCount: 50 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '[elided seq=' + aSeq + ': pruned by ARGP]' }],
      source: { kind: 'plugin', plugin: 'argp-test' },
    }), { surfaceOp: { op: 'replace', start: aSeq, end: aSeq }, sourceEventSeqs: [aSeq] })
    engine.setSession(session)

    const shadowed = (engine as unknown as { shadowedSeqsOf(s: Session): Set<number> }).shadowedSeqsOf(session)
    assert.ok(shadowed.has(aSeq), 'real pruned node must be in the shadowed ledger')
    assert.ok(engine.catalogText().includes('[context] Compression removed'), 'catalog must report the real removal')
    assert.ok(engine.recall(aSeq) !== null, 'recall must hit a genuinely pruned node')
  } finally {
    await ctx.fiber.dispose()
  }
})

test('compactRegion: balanced tool-call/result span can be pruned without orphan pair', async () => {
  const { ctx, engine } = await makeEngine()
  try {
    const session = Session.create(SessionId('pairing-region-test'))
    appendUser(session, 'user anchor')
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createAssistantMessage({
        source: { provider: 'test', model: 'test' },
        content: [{ type: 'tool-call', id: 'call_1' as never, name: 'read_file', arguments: '{"path":"x"}' }],
      }),
    }, { surfaceOp: 'append' })
    const aToolSeq = session.events.length - 1
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({ callId: 'call_1' as never, content: [{ type: 'text', text: 'file body' }], isError: false }),
    }, { surfaceOp: 'append' })
    const rSeq = session.events.length - 1
    appendAssistant(session, 'A3:' + 'z'.repeat(300), 3)
    engine.setSession(session)
    const result = await engine.compactRegion(aToolSeq, rSeq, { session } as never)
    assert.ok(result !== null)
    const record = engine.records[0]
    assert.ok(record !== undefined)
    assert.ok(record.prunedAtoms.some(a => a.seq === aToolSeq))
    assert.ok(record.prunedAtoms.some(a => a.seq === rSeq))
  } finally {
    await ctx.fiber.dispose()
  }
})

test('orphan fix: solo-R adjacent to prunable atom keeps own tool tombstone (no mixed interval)', async () => {
  // 2026-08-23 回归：旧单向合并守卫会把「位置连续的 solo-R + 邻原子」合成混剪区间 →
  // user tombstone 整体替换 → callId 蒸发 → issuer 的 tool-call 无应答（provider 400）。
  // 实测 26-local-full-verify2 中 23 个孤儿全部是此形态。
  const { ctx, engine } = await makeEngine()
  try {
    const session = Session.create(SessionId('orphan-mixed-interval-test'))
    appendUser(session, 'user anchor')
    // issuer A1：带 tool-call，本身不被剪（新近/入度保护不重要，只要不在 pruned 集）
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createAssistantMessage({
        source: { provider: 'test', model: 'test' },
        content: [{ type: 'tool-call', id: 'call_1' as never, name: 'read_file', arguments: '{"path":"x"}' }],
      }),
    }, { surfaceOp: 'append' })
    const aSeq = session.events.length - 1
    // 大 R（未被 cites 引用）——与后续 A2 位置连续，旧代码会合并成混剪区间
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({ callId: 'call_1' as never, content: [{ type: 'text', text: 'R1:' + 'r'.repeat(300) }], isError: false }),
    }, { surfaceOp: 'append' })
    const rSeq = session.events.length - 1
    appendAssistant(session, 'A2:' + 'y'.repeat(300), 2)
    const a2Seq = session.events.length - 1
    appendAssistant(session, 'A3: latest anchor.', 3)
    engine.setSession(session)
    const result = await engine.compactIfNeeded({ session } as never, 'pressure', new AbortController().signal)
    assert.ok(result !== null)
    assert.ok(result.shadowedSeqs.includes(rSeq))
    assert.ok(session.surface.nodes.includes(aSeq), 'issuer A must survive')
    // R 的墓碑必须是 tool 占位（replace 事件，保 callId），而不是 user/message 文本墓碑
    const toolTombstone = [...session.events].find(e => {
      const ev = e as { type?: string; surfaceOp?: { op?: string }; data?: { message?: { source?: { callId?: string } } } }
      return ev.type === 'tool/result' && ev.surfaceOp?.op === 'replace' && ev.data?.message?.source?.callId === 'call_1'
    })
    assert.ok(toolTombstone !== undefined, 'R must get a tool tombstone (callId preserved)')
    // 区间隔离：不存在同时覆盖 rSeq 与 a2Seq 的区间（混剪不再发生）
    const record = engine.records[0]
    assert.ok(record !== undefined)
    for (const iv of record.intervals) {
      assert.ok(iv.start > rSeq || iv.end < rSeq || iv.start > a2Seq || iv.end < a2Seq
        || (iv.start === rSeq && iv.end === rSeq),
      'interval ' + iv.start + '..' + iv.end + ' mixes solo-R with neighbor')
    }
    // wire 配对不变式：surface 上每个存活 tool-call 都有应答（含占位）
    const callIds = new Set<string>()
    const resultIds = new Set<string>()
    for (const seq of session.surface.nodes) {
      const ev = session.events[seq] as { type: string; data?: { message?: { content?: { type: string; id?: string; toolCallId?: string }[]; source?: { callId?: string } } } }
      const blocks = ev.data?.message?.content ?? []
      for (const b of blocks) {
        if (b.type === 'tool-call' && b.id !== undefined) callIds.add(b.id)
        if (b.type === 'tool-result' && b.toolCallId !== undefined) resultIds.add(b.toolCallId)
      }
      if (ev.data?.message?.source?.callId !== undefined) resultIds.add(ev.data.message.source.callId)
    }
    for (const id of callIds) assert.ok(resultIds.has(id), 'unanswered tool-call on surface: ' + id)
  } finally {
    await ctx.fiber.dispose()
  }
})

test('production-like: repeated synthetic pruning yields multiple transactions without pruning U', async () => {
  const { ctx, engine } = await makeEngine()
  try {
    const session = Session.create(SessionId('multi-tx-stress'))
    appendUser(session, 'user anchor')
    for (let i = 1; i <= 10; i += 1) {
      appendAssistant(session, 'A' + i + ':' + String(i).repeat(300), i)
    }
    engine.setSession(session)
    let turn = 10
    let guard = 0
    while (engine.records.length < 2 && guard < 10) {
      const result = await engine.compactIfNeeded({ session } as never, 'pressure', new AbortController().signal)
      if (result === null) {
        turn += 1
        appendAssistant(session, 'A' + turn + ':' + String(turn).repeat(300), turn)
      }
      guard += 1
    }
    assert.ok(engine.records.length >= 2)
    if (engine.closurePrunes.length === 0) {
      assert.ok(engine.records.every(r => r.prunedAtoms.every(a => a.type !== 'U')))
    }
    const pruneEvents = [...session.events].filter(e => e.type === 'compaction/prune')
    // 2026-09-01：pruneIntervals 改为逐区间发 prune（每区间一个 shadow-price 事件，对齐宿主
    // foldSurfaceProjection 严格相等契约）。每事务 prune 数 = 该事务 intervals 数，
    // 总 prune 数 = 各事务 intervals 之和（单区间事务仍为 1）。
    const totalIntervals = engine.records.reduce((sum, r) => sum + r.intervals.length, 0)
    assert.equal(pruneEvents.length, totalIntervals)
  } finally {
    await ctx.fiber.dispose()
  }
})

// 回归守护（2026-09-01）：宿主 token-meter foldSurfaceProjection 要求每个 compaction/prune|summary
// armed 的 shadow-price claim 与紧随其后的 surface replace 范围严格相等，否则重放 throw
// （resume 报 "no adjacent shadow price"）。本测试 inline 复刻该 fold，对 ARGP 剪枝后的真实事件流
// 逐事件重放，断言零矛盾——旧"单总 claim + 逐区间 replace"结构必 throw，逐区间成对结构必通过。
test('regression: prune event stream survives host foldSurfaceProjection replay (strict range contract)', async () => {
  const { ctx, engine } = await makeEngine()
  try {
    const session = Session.create(SessionId('fold-contract-test'))
    appendUser(session, 'user anchor')
    appendAssistant(session, 'A1:' + 'x'.repeat(300), 1)
    appendAssistant(session, 'A2:' + 'y'.repeat(300), 2)
    appendAssistant(session, 'A3:' + 'z'.repeat(300), 3)
    engine.setSession(session)
    const result = await engine.compactIfNeeded({ session } as never, 'pressure', new AbortController().signal)
    assert.ok(result !== null, 'must have pruned at least one interval')
    // 复刻 packages/llm/token-meter/src/surface-projection.ts foldSurfaceProjection 的判定路径：
    //   compaction/prune|summary → arm claim(shadowedRange)；
    //   非 surface 事件 → 清 claim；
    //   surface append → 清 claim；
    //   surface replace → claim 存在且范围 ≠ replace 范围 → throw（此处记矛盾）
    type Claim = { start: number; end: number; at: number; kind: string }
    const SURFACE = new Set(['user/message', 'assistant/message', 'tool/result'])
    let claim: Claim | undefined
    const contradictions: string[] = []
    for (const e of session.events) {
      if (e.type === 'compaction/summary' || e.type === 'compaction/prune') {
        const d = e.data as { shadowedRange?: { start?: number; end?: number } }
        if (d.shadowedRange?.start !== undefined && d.shadowedRange?.end !== undefined) {
          claim = { start: d.shadowedRange.start, end: d.shadowedRange.end, at: e.seq, kind: e.type }
        }
        continue
      }
      const so = (e as { surfaceOp?: { op?: string; start?: number; end?: number } }).surfaceOp
      if (!so || !SURFACE.has(e.type)) { claim = undefined; continue }
      if (so.op === 'append') { claim = undefined; continue }
      if (so.op === 'replace' && claim !== undefined) {
        if (claim.start !== so.start || claim.end !== so.end) {
          contradictions.push('replace ' + so.start + '-' + so.end + ' @seq=' + e.seq
            + ' vs ' + claim.kind + '@' + claim.at + ' covers ' + claim.start + '-' + claim.end)
        }
        claim = undefined
      }
    }
    assert.deepEqual(contradictions, [], 'no shadow-price claim/replace range mismatch (host resume would throw)')
  } finally {
    await ctx.fiber.dispose()
  }
})

test('recallQuery: searches pruned content by keywords and records stats', async () => {
  const { ctx, engine } = await makeEngine()
  try {
    const session = Session.create(SessionId('recall-query-test'))
    appendUser(session, 'user anchor')
    appendAssistant(session, 'A1:' + 'x'.repeat(300), 1)
    appendAssistant(session, 'A2:' + 'y'.repeat(300), 2)
    appendAssistant(session, 'A3:' + 'z'.repeat(300), 3)
    engine.setSession(session)
    await engine.compactIfNeeded({ session } as never, 'pressure', new AbortController().signal)
    const result = engine.recallQuery('A1', 5)
    assert.ok(result.includes('Recalled'))
    assert.ok(result.includes('A1'))
    assert.ok(engine.recallQueryCalls.length >= 1)
    const noHit = engine.recallQuery('definitely-not-present', 5)
    assert.ok(noHit.includes('no pruned nodes match'))
  } finally {
    await ctx.fiber.dispose()
  }
})

test('explicit measureTokens: config function drives trigger decision', async () => {
  const { ctx, engine } = await makeEngine({
    measureTokens: () => ({ contextTokens: 10000, surfaceTokens: 10000 }),
  })
  try {
    const session = Session.create(SessionId('explicit-token-meter-test'))
    appendUser(session, 'user anchor')
    appendAssistant(session, 'A1:' + 'x'.repeat(300), 1)
    appendAssistant(session, 'A2:' + 'y'.repeat(300), 2)
    appendAssistant(session, 'A3:' + 'z'.repeat(300), 3)
    engine.setSession(session)
    const result = await engine.compactIfNeeded({ session } as never, 'pressure', new AbortController().signal)
    assert.ok(result !== null)
    assert.equal(engine.records.length, 1)
  } finally {
    await ctx.fiber.dispose()
  }
})


test('edge levels: EDGE_WEIGHTS and buildGraph default supporting', async () => {
  assert.equal(EDGE_WEIGHTS.critical, 10)
  assert.equal(EDGE_WEIGHTS.supporting, 5)
  assert.equal(EDGE_WEIGHTS.contextual, 2)
  const { ctx, engine } = await makeEngine()
  try {
    const atoms: Atom[] = [
      { id: 0, seq: 1, type: 'U', turn: 1, text: 'source', toolCallIds: [], cites: [], citesFailed: false },
      { id: 1, seq: 2, type: 'A', turn: 2, text: 'answer', toolCallIds: [], cites: [{ text: 'source', level: 'supporting' }], citesFailed: false },
    ]
    const { edges } = engine.buildGraph(atoms)
    assert.equal(edges.length, 1)
    assert.equal(edges[0]?.level, 'supporting')
  } finally {
    await ctx.fiber.dispose()
  }
})

test('deterministic edges: A→R from matching toolCallIds', async () => {
  const { ctx, engine } = await makeEngine()
  try {
    const atoms: Atom[] = [
      { id: 0, seq: 1, type: 'A', turn: 1, text: 'call', toolCallIds: ['call_1'], cites: [], citesFailed: false },
      { id: 1, seq: 2, type: 'R', turn: 1, text: 'result', toolCallIds: ['call_1'], cites: [], citesFailed: false },
      { id: 2, seq: 3, type: 'A', turn: 2, text: 'plain', toolCallIds: [], cites: [], citesFailed: false },
    ]
    const { edges, deterministicEdges, inDegree } = engine.buildGraph(atoms)
    assert.equal(edges.length, 0)
    assert.equal(deterministicEdges.length, 1)
    assert.equal(deterministicEdges[0]?.from, 0)
    assert.equal(deterministicEdges[0]?.to, 1)
    assert.equal(engine.lastDeterministicEdges.length, 1)
    assert.equal(inDegree.size, 0)
  } finally {
    await ctx.fiber.dispose()
  }
})

test('catalogText: sorts pruned U before A when both are pruned', async () => {
  const { ctx, engine } = await makeEngine()
  try {
    const session = Session.create(SessionId('catalog-order-test'))
    appendUser(session, 'What is the answer?')
    appendAssistant(session, 'The answer is 42.\n{"cites":["What is the answer?"]}', 1)
    appendAssistant(session, 'A2:' + 'y'.repeat(300), 2)
    appendAssistant(session, 'A3:' + 'z'.repeat(300), 3)
    engine.setSession(session)
    await engine.compactIfNeeded({ session } as never, 'pressure', new AbortController().signal)
    const catalog = engine.catalogText()
    const uIndex = catalog.indexOf('[U')
    const aIndex = catalog.indexOf('[A')
    assert.ok(uIndex !== -1)
    assert.ok(aIndex !== -1)
    assert.ok(uIndex < aIndex)
  } finally {
    await ctx.fiber.dispose()
  }
})

test('closure lifecycle: completed PRUNABLE closure is pruned as a whole', async () => {
  const { ctx, engine } = await makeEngine()
  try {
    const session = Session.create(SessionId('closure-prune-test'))
    appendUser(session, 'task one')
    const u1Seq = session.events.length - 1
    appendAssistant(session, 'A1:' + 'x'.repeat(50), 1)
    const a1Seq = session.events.length - 1
    appendUser(session, 'task two')
    const u2Seq = session.events.length - 1
    appendAssistant(session, 'A2:' + 'y'.repeat(50), 2)
    engine.setSession(session)
    const atoms = engine.atomize(session)
    const { edges, inDegree } = engine.buildGraph(atoms)
    const result = engine.tryPruneClosures(session, atoms, edges, inDegree, new Map(), 2)
    assert.ok(result !== null)
    assert.equal(engine.closurePrunes.length, 1)
    const record = engine.records[0]
    assert.ok(record !== undefined)
    const stillSurface = new Set(session.surface.nodes)
    assert.ok(!stillSurface.has(u1Seq))
    assert.ok(!stillSurface.has(a1Seq))
    assert.ok(stillSurface.has(u2Seq)) // task two user
  } finally {
    await ctx.fiber.dispose()
  }
})

test('closure lifecycle: dependent closure with incoming edge is not pruned first', async () => {
  const { ctx, engine } = await makeEngine()
  try {
    const session = Session.create(SessionId('closure-dependent-test'))
    appendUser(session, 'task one')
    const u1Seq = session.events.length - 1
    appendAssistant(session, 'A1:' + 'x'.repeat(50), 1)
    const a1Seq = session.events.length - 1
    appendUser(session, 'task two')
    const u2Seq = session.events.length - 1
    appendAssistant(session, 'A2:' + 'y'.repeat(50), 2)
    const a2Seq = session.events.length - 1
    engine.setSession(session)
    const atoms = engine.atomize(session)
    const a1 = atoms.find(a => a.seq === a1Seq)
    const a2 = atoms.find(a => a.seq === a2Seq)
    assert.ok(a1 !== undefined && a2 !== undefined)
    const edges = [{ from: a1.id, to: a2.id, level: 'supporting' as const }]
    const inDegree = new Map<number, number>([[a2.id, 1]])
    const result = engine.tryPruneClosures(session, atoms, edges, inDegree, new Map(), 2)
    assert.ok(result !== null)
    assert.equal(engine.closurePrunes.length, 1)
    assert.equal(engine.closurePrunes[0]?.rootSeq, u1Seq)
    const stillSurface = new Set(session.surface.nodes)
    assert.ok(stillSurface.has(u2Seq))
    assert.ok(stillSurface.has(a2Seq))
    assert.ok(!stillSurface.has(u1Seq))
  } finally {
    await ctx.fiber.dispose()
  }
})

test('closure tombstone: includes closure id and root preview', async () => {
  const { ctx, engine } = await makeEngine()
  try {
    const session = Session.create(SessionId('closure-tombstone-test'))
    appendUser(session, 'task one')
    appendAssistant(session, 'A1:' + 'x'.repeat(50), 1)
    appendUser(session, 'task two')
    appendAssistant(session, 'A2:' + 'y'.repeat(50), 2)
    engine.setSession(session)
    const atoms = engine.atomize(session)
    const { edges, inDegree } = engine.buildGraph(atoms)
    const result = engine.tryPruneClosures(session, atoms, edges, inDegree, new Map(), 2)
    assert.ok(result !== null)
    const tombstone = [...session.events].find(e => e.type === 'user/message'
      && (e.data as { content?: { type: string; text: string }[] }).content?.some(b => b.text.includes('[elided closure')))
    assert.ok(tombstone !== undefined)
    const text = (tombstone.data as { content: { type: string; text: string }[] }).content.map(b => b.text).join('')
    assert.ok(text.includes('[elided closure'))
    assert.ok(text.includes('task one'))
  } finally {
    await ctx.fiber.dispose()
  }
})

test('extractCites V6: full-word levels resolve; unknown level falls back to supporting (Q2)', () => {
  const fullWord = extractCites('answer\n{"cites":[{"t":"critical item","l":"critical"},{"t":"contextual item","l":"contextual"},{"t":"plain"}]}')
  assert.equal(fullWord.parseFailed, false)
  assert.deepEqual(fullWord.cites, [
    { text: 'critical item', level: 'critical' },
    { text: 'contextual item', level: 'contextual' },
    { text: 'plain', level: 'supporting' },
  ])
  // 未知/拼错等级 → 静默回退 supporting（绝不升级成 critical——问题 2 修复方向）
  const unknown = extractCites('answer\n{"cites":[{"t":"zzz item","l":"zzz"},{"t":"legacy","l":"contextual"}]}')
  assert.equal(unknown.parseFailed, false)
  assert.deepEqual(unknown.cites, [
    { text: 'zzz item', level: 'supporting' },
    { text: 'legacy', level: 'contextual' },
  ])
  // l 缺失/非字符串 → supporting
  const noLevel = extractCites('answer\n{"cites":[{"t":"no level"}]}')
  assert.equal(noLevel.parseFailed, false)
  assert.deepEqual(noLevel.cites, [{ text: 'no level', level: 'supporting' }])
})

test('buildGraph prefix guard: ASCII>=4 or CJK>=2 chars (Q5)', async () => {
  const { ctx, engine } = await makeEngine()
  try {
    const session = Session.create(SessionId('prefix-guard-test'))
    appendUser(session, 'the quick brown fox jumps over the lazy dog')
    const uSeq = session.events.length - 1
    // 过短 ASCII 前缀（“the”=3 < 4）→ 拒
    appendAssistant(session, 'ans1 {"cites":[{"t":"the","l":"s"}]}', 1)
    const aShortSeq = session.events.length - 1
    // 长前缀（“the quick” >= 4）→ 放行
    appendAssistant(session, 'ans2 {"cites":[{"t":"the quick","l":"s"}]}', 2)
    const aLongSeq = session.events.length - 1
    // CJK 双字（“读书”=2 wide）→ 放行且命中含中文的 U
    appendUser(session, '读书使人进步')
    const uCjkSeq = session.events.length - 1
    appendAssistant(session, 'ans3 {"cites":[{"t":"读书","l":"s"}]}', 3)
    const aCjkSeq = session.events.length - 1
    const atoms = engine.atomize(session)
    const { edges } = engine.buildGraph(atoms)
    const aShort = atoms.find(a => a.seq === aShortSeq)
    const aLong = atoms.find(a => a.seq === aLongSeq)
    const aCjk = atoms.find(a => a.seq === aCjkSeq)
    assert.ok(aShort !== undefined && aLong !== undefined && aCjk !== undefined)
    // “the” 拒（citePrefixTooShort → failed++，无边）
    assert.ok(!edges.some(e => e.from === aShort.id), '"the" prefix must be rejected')
    // “the quick” 放行 → A→U 边
    assert.ok(edges.some(e => e.from === aLong.id && e.to === uSeq), 'long ascii prefix must resolve to U')
    // 读书 放行 → A→U(CJK) 边
    assert.ok(edges.some(e => e.from === aCjk.id && e.to === uCjkSeq), 'CJK 2-char prefix must resolve to U')
  } finally {
    await ctx.fiber.dispose()
  }
})

test('A10 narrow guard: tool A with R group and no external refs stays protected; with external cite becomes prunable (Q1)', async () => {
  const { ctx, engine } = await makeEngine()
  try {
    const session = Session.create(SessionId('a10-narrow-test'))
    appendUser(session, 'user anchor')
    // 工具 A：带 R 组但漏 cites → 无外部入边 → 结构性保护（不可剪）
    session.append('assistant/message', {
      turn: 1, step: 1,
      message: createAssistantMessage({
        source: { provider: 'test', model: 'test' },
        content: [
          { type: 'text', text: 'tool answer' },
          { type: 'tool-call', id: 'call_a' as never, name: 'read_file', arguments: '{"path":"x"}' },
        ],
      }),
    }, { surfaceOp: 'append' })
    const aSeq = session.events.length - 1
    session.append('tool/result', {
      turn: 1, step: 1,
      message: createToolResultMessage({ callId: 'call_a' as never, content: [{ type: 'text', text: 'file body' }], isError: false }),
    }, { surfaceOp: 'append' })
    const rSeq = session.events.length - 1
    appendAssistant(session, 'A3:' + 'y'.repeat(300), 3)
    appendAssistant(session, 'A4:' + 'z'.repeat(300), 4)
    engine.setSession(session)
    const result = await engine.compactIfNeeded({ session } as never, 'pressure', new AbortController().signal)
    assert.ok(result !== null, 'session must prune something (protected nodes are excluded from candidates)')
    assert.ok(!result.shadowedSeqs.includes(aSeq), 'protected tool A must not be in shadowed set')
    // 2026-08-23 半拆组：R 独立可剪（tool 占位墓碑配对 A 的 tool_calls，协议安全），
    // A10 结构性保护只落在 A 上；A 无论 R 是否被剪都必须保留（闭包不整体消失）。
    const surface = new Set(session.surface.nodes)
    assert.ok(surface.has(aSeq), 'tool A stays in surface whether or not R is pruned')
  } finally {
    await ctx.fiber.dispose()
  }
})

test('A10 narrow guard: tool A with externally-cited R becomes prunable (Q1 control)', async () => {
  const { ctx, engine } = await makeEngine()
  try {
    const session = Session.create(SessionId('a10-narrow-test2'))
    appendUser(session, 'user anchor')
    session.append('assistant/message', {
      turn: 1, step: 1,
      message: createAssistantMessage({
        source: { provider: 'test', model: 'test' },
        content: [
          { type: 'text', text: 'tool answer' },
          { type: 'tool-call', id: 'call_b' as never, name: 'read_file', arguments: '{"path":"x"}' },
        ],
      }),
    }, { surfaceOp: 'append' })
    session.append('tool/result', {
      turn: 1, step: 1,
      message: createToolResultMessage({ callId: 'call_b' as never, content: [{ type: 'text', text: 'file body' }], isError: false }),
    }, { surfaceOp: 'append' })
    const r2Seq = session.events.length - 1
    // 另一个 A cites 该 R → R 有外部语义入边
    appendAssistant(session, 'later cites R {"cites":[{"t":"file body","l":"s"}]}', 2)
    appendAssistant(session, 'A5:' + 'y'.repeat(300), 5)
    appendAssistant(session, 'A6:' + 'z'.repeat(300), 6)
    engine.setSession(session)
    const result = await engine.compactIfNeeded({ session } as never, 'pressure', new AbortController().signal)
    assert.ok(result !== null, 'tool A with externally-cited R must become prunable')
  } finally {
    await ctx.fiber.dispose()
  }
})

test('A4 chainLen: 3 identical R versions collapse to survivor chainLen=3, dup=2 (Q4)', async () => {
  const { ctx, engine } = await makeEngine()
  try {
    const session = Session.create(SessionId('chainlen-test'))
    appendUser(session, 'user anchor')
    // 三个同 issuer 同 arguments 的 R 版本
    for (let i = 0; i < 3; i += 1) {
      session.append('tool/result', {
        turn: 1, step: 1,
        message: createToolResultMessage({ callId: ('call_' + i) as never, content: [{ type: 'text', text: 'SAME RESULT BODY ' + 'x'.repeat(40) }], isError: false }),
      }, { surfaceOp: 'append' })
    }
    // 对应的三个 issuer A（同文本 → A 去重成一条链）
    for (let i = 0; i < 3; i += 1) {
      session.append('assistant/message', {
        turn: 1, step: 1,
        message: createAssistantMessage({
          source: { provider: 'test', model: 'test' },
          content: [
            { type: 'text', text: 'ISSUER TEXT ' + 'y'.repeat(60) },
            { type: 'tool-call', id: ('call_' + i) as never, name: 'read_file', arguments: '{"path":"x"}' },
          ],
        }),
      }, { surfaceOp: 'append' })
    }
    const atoms = engine.atomize(session)
    const { inDegree } = engine.buildGraph(atoms)
    const { dupIds, chainLen } = (engine as unknown as {
      findVersionDuplicates(atoms: Atom[], inDegree: Map<number, number>): { dupIds: Set<number>; chainLen: Map<number, number> }
    }).findVersionDuplicates(atoms, inDegree)
    // 三个 R 版本 → 2 个 dup，survivor chainLen=3
    const rDups = atoms.filter(a => a.type === 'R' && dupIds.has(a.id)).length
    assert.equal(rDups, 2, 'two of three R versions are dups')
    const rSurvivor = atoms.find(a => a.type === 'R' && !dupIds.has(a.id))
    assert.ok(rSurvivor !== undefined)
    assert.equal(chainLen.get(rSurvivor.id), 3, 'survivor chainLen = 3 (mergeOlderR counts list length)')
    // issuer A 文本全等 → A 侧也去重
    const aDups = atoms.filter(a => a.type === 'A' && dupIds.has(a.id)).length
    assert.equal(aDups, 2)
  } finally {
    await ctx.fiber.dispose()
  }
})

test('critical closure guard: cross-closure critical edge blocks target closure; supporting does not (Q6)', async () => {
  const { ctx, engine } = await makeEngine()
  try {
    const session = Session.create(SessionId('critical-closure-test'))
    appendUser(session, 'closure one root')
    const u1Seq = session.events.length - 1
    appendAssistant(session, 'A1:' + 'x'.repeat(50), 1)
    const a1Seq = session.events.length - 1
    appendUser(session, 'closure two root')
    const u2Seq = session.events.length - 1
    appendAssistant(session, 'A2:' + 'y'.repeat(50), 2)
    const a2Seq = session.events.length - 1
    // 第三个 U：让 closure2 不是「最后一个 root」（最后一个 root 永远不剪）
    appendUser(session, 'closure three root')
    appendAssistant(session, 'A3:' + 'w'.repeat(50), 3)
    engine.setSession(session)
    const atoms = engine.atomize(session)
    const a1 = atoms.find(a => a.seq === a1Seq)
    const a2 = atoms.find(a => a.seq === a2Seq)
    assert.ok(a1 !== undefined && a2 !== undefined)
    // 跨闭包 critical 边：closure1 的 A1 → closure2 的 A2。
    // closure1 是最后 root 的前一个？不——roots=[u1,u2,u3]，u1 非最后 root，
    // 但闭包归属：u1 的闭包 = [u1,A1]，u2 的闭包 = [u2,A2]，u3 的闭包=[u3,A3]。
    // critical 边 A1→A2 使 closure2 有 external critical 入度 → closure2 被守卫。
    // closure1 无入边 → 候选。排序后 closure1 被剪。
    const edgesCrit = [{ from: a1.id, to: a2.id, level: 'critical' as const }]
    const inDegreeCrit = new Map<number, number>([[a2.id, 1]])
    const resultCrit = engine.tryPruneClosures(session, atoms, edgesCrit, inDegreeCrit, new Map(), 2)
    assert.ok(resultCrit !== null, 'closure1 (no in-edge) must still be prunable')
    // 关键：closure2 因 external critical 入边被守卫 → 不在剪除范围
    assert.equal(engine.closurePrunes.length, 1)
    assert.equal(engine.closurePrunes[0]?.rootSeq, u1Seq, 'closure1 pruned, not closure2')
    const stillSurfaceCrit = new Set(session.surface.nodes)
    assert.ok(stillSurfaceCrit.has(u2Seq), 'closure2 (critical in-edge) must stay on surface')
    assert.ok(stillSurfaceCrit.has(a2Seq))

    // 同结构 supporting 边：跨闭包 supporting 不计入 inDegreeByClosure → 无守卫。
    // 用独立 engine 验证（closurePrunes 是实例数组，跨 session 累计）
    const { ctx: ctx2, engine: engine2 } = await makeEngine()
    try {
      const session2 = Session.create(SessionId('critical-closure-test2'))
      appendUser(session2, 'closure one root')
      const u1b = session2.events.length - 1
      appendAssistant(session2, 'A1:' + 'x'.repeat(50), 1)
      const a1b = session2.events.length - 1
      appendUser(session2, 'closure two root')
      const u2b = session2.events.length - 1
      appendAssistant(session2, 'A2:' + 'y'.repeat(50), 2)
      const a2b = session2.events.length - 1
      appendUser(session2, 'closure three root')
      appendAssistant(session2, 'A3:' + 'w'.repeat(50), 3)
      engine2.setSession(session2)
      const atoms2 = engine2.atomize(session2)
      const a1bAtom = atoms2.find(a => a.seq === a1b)
      const a2bAtom = atoms2.find(a => a.seq === a2b)
      assert.ok(a1bAtom !== undefined && a2bAtom !== undefined)
      const edgesSup = [{ from: a1bAtom.id, to: a2bAtom.id, level: 'supporting' as const }]
      const inDegreeSup = new Map<number, number>([[a2bAtom.id, 1]])
      const resultSup = engine2.tryPruneClosures(session2, atoms2, edgesSup, inDegreeSup, new Map(), 2)
      // supporting 边不构成闭包守卫 → closure1 仍可剪
      assert.ok(resultSup !== null, 'supporting edge must not block closure pruning')
      assert.equal(engine2.closurePrunes.length, 1)
    } finally {
      await ctx2.fiber.dispose()
    }
  } finally {
    await ctx.fiber.dispose()
  }
})

test('A8 narrowed ask detection: looksAskText locks CJK rules (Q10)', () => {
  // 句首请求/问句 → 命中
  assert.equal(looksAskText('帮我看看这个报错'), true, 'CJK ask at start matches')
  assert.equal(looksAskText('请告诉我怎么做'), true, '请 at start matches')
  assert.equal(looksAskText('这个怎么处理'), true, '疑问词 怎么 matches')
  assert.equal(looksAskText('你能帮忙吗'), true, '句尾 吗 matches')
  assert.equal(looksAskText('What is the answer?'), true, 'English ? matches')
  // 非句首“顺便帮我带个话” → 不再误判（收窄核心）
  assert.equal(looksAskText('顺便帮我带个话'), false, 'trailing 帮我 must NOT match (Q10 fix)')
  assert.equal(looksAskText('他问我什么了'), true, '疑问词 什么 still matches (conservative)')
  assert.equal(looksAskText('好的没问题'), false, 'plain statement does not match')
})

test('A8 narrowed ask detection: CJK ask U exempted and prunable via coverage (Q10 integration)', async () => {
  const { ctx, engine } = await makeEngine()
  try {
    // 中文 ask 句（帮我…）→ askCoverage 覆盖 → U 可随组剪（收窄后中文问句仍豁免）
    const session = Session.create(SessionId('ask-narrow-test'))
    appendUser(session, '帮我看看这个报错')
    const uAskSeq = session.events.length - 1
    appendAssistant(session, '报错原因是配置错误。\n{"cites":[{"t":"帮我看看这个报错","l":"s"}]}', 1)
    appendAssistant(session, 'A2:' + 'y'.repeat(300), 2)
    appendAssistant(session, 'A3:' + 'z'.repeat(300), 3)
    engine.setSession(session)
    await engine.compactIfNeeded({ session } as never, 'pressure', new AbortController().signal)
    const record = engine.records[0]
    assert.ok(record !== undefined, 'CJK ask U must be exempted and prunable')
    assert.ok(record.prunedAtoms.some(a => a.type === 'U'), 'CJK ask U pruned (exemption works)')
  } finally {
    await ctx.fiber.dispose()
  }
})


test('overflow retries default: 3 when peratom compressor wired, 1 otherwise, explicit wins', async () => {
  // 无 peratom：维持官方 compaction-basic 口径 1
  {
    const { ctx, engine } = await makeEngine()
    try {
      assert.equal(engine.maxOverflowRetries, 1)
    } finally {
      await ctx.fiber.dispose()
    }
  }
  // 挂载 compressor（第②步存在）：缺省自动提到 3，三步序列可达
  {
    const { ctx, engine } = await makeEngine({ peratom: { compressor: {}, declarer: false, zoom: false } })
    try {
      assert.equal(engine.maxOverflowRetries, 3)
    } finally {
      await ctx.fiber.dispose()
    }
  }
  // 显式配置始终优先
  {
    const { ctx, engine } = await makeEngine({ maxOverflowRetries: 5, peratom: { compressor: {}, declarer: false, zoom: false } })
    try {
      assert.equal(engine.maxOverflowRetries, 5, 'explicit config wins over auto default')
    } finally {
      await ctx.fiber.dispose()
    }
  }
})
