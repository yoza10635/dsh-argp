import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ArgpGraphEngine, eventText, extractCites, type Atom } from '../src/argp-graph-engine.ts'

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
  assert.deepEqual(bare.cites, ['hello world'])
  assert.equal(bare.attempted, true)
  assert.equal(bare.parseFailed, false)

  const fenced = extractCites('answer\n```json\n{"cites":["hello world"]}\n```')
  assert.equal(fenced.body, 'answer')
  assert.deepEqual(fenced.cites, ['hello world'])
  assert.equal(fenced.parseFailed, false)

  const empty = extractCites('answer\n{"cites":[]}')
  assert.equal(empty.body, 'answer')
  assert.deepEqual(empty.cites, [])
  assert.equal(empty.parseFailed, false)

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
    assert.deepEqual(atoms[1]?.cites, ['question'])
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
      { id: 2, seq: 12, type: 'A', turn: 2, text: 'answer', toolCallIds: [], cites: ['the gateway release passes'], citesFailed: false },
    ]
    const { edges, inDegree } = engine.buildGraph(atoms)
    assert.equal(edges.length, 1)
    assert.equal(edges[0]?.from, 2)
    assert.equal(edges[0]?.to, 0) // U 优先于 A1
    assert.equal(inDegree.get(0), 1)
    assert.equal(engine.citeStats.resolved, 1)
    assert.equal(engine.citeStats.ambiguous, 1)

    const noHit = engine.buildGraph([
      { id: 0, seq: 1, type: 'A', turn: 1, text: 'answer', toolCallIds: [], cites: ['not present'], citesFailed: false },
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
    assert.equal(record.prunedAtoms.every(a => a.type === 'A'), true)
    assert.ok(record.shadowedSeqs.length >= 2)
    const stillSurface = new Set(session.surface.nodes)
    const userSeq = [...session.events].findIndex(e => e.type === 'user/message')
    assert.ok(stillSurface.has(userSeq))
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
    assert.equal(indexed.type, 'A')
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

test('prune emits compaction/prune instead of compaction/summary', async () => {
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
    assert.equal(summaryEvents.length, 0)
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
    assert.ok(engine.records.every(r => r.prunedAtoms.every(a => a.type !== 'U')))
    const pruneEvents = [...session.events].filter(e => e.type === 'compaction/prune')
    assert.equal(pruneEvents.length, engine.records.length)
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
