import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
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
