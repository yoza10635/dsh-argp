/**
 * C（B3）验收：A10 放行（组内 R 全立碑）+ 整组退场（A 剪 ⇒ 全部应答 R 同批）。
 *
 * ## 为什么做
 *
 * A10 用 `toolCallIds` 匹配 `groupRs`，而 stub **完整继承原 callId**（实测 1,971/1,971）
 * ⇒ R 立碑后 `groupRs` 仍非空 ⇒ "收割过的组"与"没收割过的组"在 A10 眼里一模一样 ⇒ A 永久
 * 结构保护。A0 闸级重放实测（session-16188a24）：末态活体 A 388 条里 **371（95.6%）**的首个
 * 拦截闸就是 A10，其中 **312 条的 R 组早已全是墓碑**（携 268,086 字符 ≈ 103.2K tok）。
 *
 * ## 变异锁（强制）
 *
 * 1. **摘掉 `src/prune-selection.ts` A10 块里的 `allStubbed` 放行** ⇒ A 组与 C 组断言变红。
 * 2. **摘掉 `src/argp-graph-engine.ts` 的事后整组校验循环** ⇒ D 组变红（aCovered && !rCovered）。
 * 3. **把放行判据从 `isTombstoneText` 换成 `isToolTombstoneText`** ⇒ B 组①变红；
 *    **顺手套上 `TOMBSTONE_MAX_CHARS`** ⇒ B 组②变红。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { asSeq, asSeqs } from '../src/log-access.ts'
import { ArgpGraphEngine } from '../src/argp-graph-engine.ts'
import { isAtomCandidate, type PruneState } from '../src/prune-selection.ts'
import {
  TOMBSTONE_MAX_CHARS,
  closureTombstone,
  consolidatedTombstone,
  isTombstoneText,
  seqRangeTombstone,
  toolTombstone,
} from '../src/tombstone-text.ts'
import type { Atom } from '../src/argp-types.ts'

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

function appendUser(session: Session, text: string): void {
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
}

/**
 * A(tool-call ×N) + 其应答 R。`args` 可注入长参数（A 的有效体积由 tool-call block 决定）。
 *
 * ⚠️ `args` 默认**按 callId 唯一**：若各次调用共用同一份 `name+arguments`，
 * `findVersionDuplicates` 会把它们当成"同一路径的版本链"在 pass 0 **之前**就整批预剪
 * （`dupIds`），那条路径同样**绕过 `isAtomCandidate`** ⇒ 会污染本文件的变异锁
 * （实测：夹具曾因此让"A 被剪"断言在摘掉 C 后仍然为真）。
 */
function appendToolPair(
  session: Session, turn: number, callId: string, resultText: string,
  args: string = JSON.stringify({ path: 'file-' + callId + '.ts' }),
): { aSeq: number; rSeq: number } {
  const aSeq = appendAssistantWithCall(session, turn, callId, args)
  appendToolResult(session, turn, callId, resultText)
  const rSeq = session.snapshotEvents().length - 1
  return { aSeq, rSeq }
}

/** 只追加带 tool-call 的 A（R 由调用方另行安排，可用来制造"A 与 R 不相邻"的形态）。 */
function appendAssistantWithCall(session: Session, turn: number, callId: string, args: string): number {
  session.append('assistant/message', {
    stream: [], turn, step: 1,
    message: {
      role: 'assistant', id: 'am_' + callId,
      source: { kind: 'model', provider: 'test', model: 'test' },
      content: [{ type: 'tool-call', id: callId, name: 'read_file', arguments: args }, { type: 'text', text: 'on it' }],
    },
  } as never, { surfaceOp: 'append' })
  return session.snapshotEvents().length - 1
}

function appendToolResult(session: Session, turn: number, callId: string, resultText: string): void {
  session.append('tool/result', {
    turn, step: 1,
    message: {
      role: 'user', id: 'm_' + callId,
      source: { kind: 'tool', callId },
      content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: resultText }], isError: false }],
    },
  } as never, { surfaceOp: 'append' })
}

/** 把某 R 就地替换为 tool 占位墓碑（复刻 prune-tx 的 V3 分支：只改内层 text）。返回墓碑节点 seq。 */
function stubToolResult(session: Session, turn: number, callId: string, targetSeq: number, text: string): number {
  session.append('tool/result', {
    turn, step: 1,
    message: {
      role: 'user', id: 'm_' + callId,
      source: { kind: 'tool', callId },
      content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }], isError: false }],
    },
  } as never, { surfaceOp: { op: 'replace', startSeq: asSeq(targetSeq), endSeq: asSeq(targetSeq) }, sourceEventSeqs: asSeqs([targetSeq]) })
  return session.snapshotEvents().length - 1
}

/** 一段与 A/R 无关的"黏着物"：user 墓碑（X 类 ⇒ 结构上永不参剪）⇒ 用来拉开 position 相邻性。 */
function appendSpacerTombstone(session: Session): number {
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: seqRangeTombstone(900, 900) }],
    source: { kind: 'argp' },
  }), { surfaceOp: 'append' })
  return session.snapshotEvents().length - 1
}

function appendAssistantText(session: Session, turn: number, text: string): void {
  session.append('assistant/message', {
    stream: [], turn, step: 1,
    message: createAssistantMessage({ source: { provider: 'test', model: 'test' }, content: [{ type: 'text', text }] }),
  }, { surfaceOp: 'append' })
}

function makeAtom(over: Partial<Atom> & Pick<Atom, 'seq' | 'type' | 'text'>): Atom {
  return { id: over.seq, turn: 1, toolCallIds: [], cites: [], citesFailed: false, ...over } as Atom
}

/** 最小 PruneState：默认所有守卫都放行，只让被测的那道闸起作用。 */
function makeState(atoms: Atom[], over: Partial<PruneState> = {}): PruneState {
  return {
    turnGuard: 1,
    askCoverage: new Map(),
    position: new Map(atoms.map((a, i) => [a.seq, i])),
    recencyCut: atoms.length,
    latestTurn: 10,
    edges: [],
    atoms,
    curInDegree: new Map(),
    curInDegreeDecl: new Map(),
    deterministicEdges: [],
    touchesSemantic: new Set(),
    eff: new Map(),
    sortMode: 'legacy',
    chainLen: new Map(),
    lastRef: new Map(),
    charsPerToken: 3.5,
    aGroupChars: new Map(),
    ...over,
  }
}

async function makeEngine(config: Record<string, unknown> = {}): Promise<{ ctx: Context; engine: ArgpGraphEngine }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: 'a10-stubbed-group test persona' } })
  await ctx.plugin(ArgpGraphEngine, { windowTokens: 100, retainTokens: 50, minSpanChars: 0, recencyGuard: 0, turnGuard: 0, ...config })
  return { ctx, engine: ctx.compaction as ArgpGraphEngine }
}

/** 压出一批"年老的活体"，保证每个 fixture 都有可剪内容（否则候选枯竭、断言空过）。 */
function appendPressure(session: Session): void {
  for (const turn of [2, 3, 4]) {
    appendToolPair(session, turn, 'c' + turn, 'Y'.repeat(3000))
    appendAssistantText(session, turn, 'A' + turn + ':' + 'z'.repeat(2000))
  }
}

/** 本事务产生的 replace 区间（fixture 手工造的替换用 `since` 排除）。 */
function replacesSince(session: Session, since: number): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = []
  for (const e of session.snapshotEvents()) {
    if (e.seq < since) continue
    const op = e.surfaceOp as { op?: string; startSeq?: number; endSeq?: number } | undefined
    if (op === undefined || typeof op !== 'object' || op.op !== 'replace') continue
    if (op.startSeq === undefined || op.endSeq === undefined) continue
    out.push({ start: op.startSeq, end: op.endSeq })
  }
  return out
}

const covered = (repl: { start: number; end: number }[], seq: number): boolean =>
  repl.some(iv => iv.start <= seq && iv.end >= seq)

/**
 * 孤儿检测（**走原始事件，不走文本渲染**）：surface 上每个 `tool/result`，其 callId 必须能在
 * 同 surface 的某个 `assistant/message` 的 tool-call 里找到 —— 否则提交 messages 时是
 * `role:'tool'` 无匹配 `assistant.tool_calls` ⇒ provider 400。
 */
function orphanToolResults(session: Session): number[] {
  const bySeq = new Map(session.snapshotEvents().map(e => [e.seq, e]))
  const nodes = [...session.surface.nodes]
  const callsOnSurface = new Set<string>()
  for (const seq of nodes) {
    const e = bySeq.get(seq)
    if (e?.type !== 'assistant/message') continue
    const content = (e.data as { message?: { content?: unknown } } | undefined)?.message?.content
    if (!Array.isArray(content)) continue
    for (const b of content as { type?: string; id?: string }[]) {
      if (b?.type === 'tool-call' && typeof b.id === 'string') callsOnSurface.add(b.id)
    }
  }
  const orphans: number[] = []
  for (const seq of nodes) {
    const e = bySeq.get(seq)
    if (e?.type !== 'tool/result') continue
    const data = e.data as { message?: { source?: { callId?: string }; content?: unknown }; toolCallId?: string } | undefined
    const inner = Array.isArray(data?.message?.content)
      ? (data?.message?.content as { type?: string; toolCallId?: string }[]).find(b => b?.type === 'tool-result')
      : undefined
    const cid = data?.message?.source?.callId ?? data?.toolCallId ?? inner?.toolCallId
    if (typeof cid === 'string' && !callsOnSurface.has(cid)) orphans.push(seq)
  }
  return orphans
}

// ---------------------------------------------------------------------------
// A. A10 放行（纯函数 + 变异锁）
// ---------------------------------------------------------------------------

test('C: 组内 R 全部立碑 ⇒ A10 不再结构保护，A 参剪（变异锁）', () => {
  const a = makeAtom({ seq: 10, type: 'A', text: 'A: ' + 'x'.repeat(500), toolCallIds: ['c1'] })
  const rStub = makeAtom({ seq: 11, type: 'R', text: toolTombstone(11), toolCallIds: ['c1'] })

  // ← 摘掉 prune-selection.ts A10 块的 allStubbed 放行后，下面两条必须变红
  assert.equal(isAtomCandidate(a, false, makeState([a, rStub])), true,
    'C：组内 R 已全碑 ⇒ 内容已不在 surface，A10 失去保护对象')
  assert.equal(isAtomCandidate(a, true, makeState([a, rStub])), true, 'C：force_prune 路径同结论')
})

test('C: 反例——组内 R 含非墓碑 ⇒ A10 保护照旧（现行行为不变）', () => {
  const rLive = makeAtom({ seq: 11, type: 'R', text: 'live tool result '.repeat(50), toolCallIds: ['c1'] })
  const a = makeAtom({ seq: 10, type: 'A', text: 'A', toolCallIds: ['c1'] })
  assert.equal(isAtomCandidate(a, false, makeState([a, rLive])), false,
    'R 仍有内容 ⇒ A10 照旧保护（未被 C 误伤）')

  // 一个已碑一个活体 ⇒ 整组仍保护（放行须"全部"成立）
  const a2 = makeAtom({ seq: 13, type: 'A', text: 'A2', toolCallIds: ['c1', 'c2'] })
  const rStub = makeAtom({ seq: 12, type: 'R', text: toolTombstone(12), toolCallIds: ['c2'] })
  assert.equal(isAtomCandidate(a2, false, makeState([a2, rLive, rStub])), false,
    '任一 R 未立碑 ⇒ 整组仍受保护')
})

test('C: 既有两条放行路径不变（A cites 组内 R / R 有组外声明入度）', () => {
  const rLive = makeAtom({ seq: 11, type: 'R', text: 'live '.repeat(50), toolCallIds: ['c1'] })
  const a = makeAtom({ seq: 10, type: 'A', text: 'A', toolCallIds: ['c1'] })
  const withCite = makeState([a, rLive], { edges: [{ from: 10, to: 11, level: 'critical' } as never] })
  assert.equal(isAtomCandidate(a, false, withCite), true, 'A 有 cites 指向组内 R ⇒ 放行（1.7.0 既有路径）')
  const withExt = makeState([a, rLive], { curInDegreeDecl: new Map([[11, 1]]) })
  assert.equal(isAtomCandidate(a, false, withExt), true, 'R 有组外声明入度 ⇒ 放行（1.7.0 既有路径）')
})

// ---------------------------------------------------------------------------
// B. 判据口径锁
// ---------------------------------------------------------------------------

test('C: 放行判据 = isTombstoneText 全族、不套长度安全阀（口径锁）', () => {
  const a = makeAtom({ seq: 10, type: 'A', text: 'A', toolCallIds: ['c1'] })
  const mk = (text: string): PruneState => makeState([a, makeAtom({ seq: 11, type: 'R', text, toolCallIds: ['c1'] })])

  // ① 非 tool 族（区间/闭包/聚合）也放行 —— 误用 isToolTombstoneText 时此条变红
  //    口径依据：量出 312 靶子的 gate-replay ⑤ 段与 step-audit.mjs 用的都是全族判据
  for (const text of [seqRangeTombstone(20, 24), closureTombstone('closure-2', 1, 9, 'root'), consolidatedTombstone(3, 1, 9)]) {
    assert.ok(isTombstoneText(text))
    assert.equal(isAtomCandidate(a, false, mk(text)), true, '全族墓碑均表示"内容已不在 surface": ' + text)
  }

  // ② 超长墓碑仍放行 —— 顺手套上 TOMBSTONE_MAX_CHARS 时此条变红
  //    （该安全阀服务于 G1 的"地板卡死"，语义是"还有东西可丢"，与"内容是否已不在"是两件事）
  const longText = toolTombstone(11) + ' '.repeat(TOMBSTONE_MAX_CHARS)
  assert.ok(longText.length > TOMBSTONE_MAX_CHARS)
  assert.equal(isAtomCandidate(a, false, mk(longText)), true, '长度安全阀不参与 C 的放行判定')

  // ③ 非墓碑文本绝不因 C 放行
  assert.equal(isAtomCandidate(a, false, mk('real tool output '.repeat(50))), false)
})

// ---------------------------------------------------------------------------
// C. 引擎级：整组退场
// ---------------------------------------------------------------------------

test('C 引擎级：A 剪 ⇒ 其已碑 R 同批退场（无孤儿）', async () => {
  const { ctx, engine } = await makeEngine()
  try {
    const session = Session.create(SessionId('c-group-exit'))
    appendUser(session, 'anchor')
    // 唯一差异 = R 已被立碑 ⇒ C 应放行 A（1.7.0 下 A10 会永久拦住它）
    const { aSeq, rSeq } = appendToolPair(session, 1, 'c1', 'Z'.repeat(4000))
    const stubSeq = stubToolResult(session, 1, 'c1', rSeq, toolTombstone(rSeq))
    appendPressure(session)
    engine.setSession(session)

    const before = session.snapshotEvents().length
    await engine.compactIfNeeded({ session } as never, 'pressure', new AbortController().signal)
    const repl = replacesSince(session, before)
    assert.ok(repl.length > 0, 'prerequisite: 本次事务确实剪到了东西')

    // 变异锁 ①：A 必须被剪（摘掉 allStubbed 放行 ⇒ 此断言变红）
    assert.ok(covered(repl, aSeq),
      'C：组内 R 已碑 ⇒ A 应参剪（1.7.0 被 A10 永久拦住）。实际区间 = ' + JSON.stringify(repl.slice(0, 5)))

    // 变异锁 ②：已碑 R 必须与 A 同批退场（整组退场）
    assert.ok(covered(repl, stubSeq),
      '整组退场：已碑 R 必须与 A 同批进同一区间（否则留下孤儿 role:\'tool\'）')

    // ③ 硬约束：surface 上不存在孤儿 tool 结果
    assert.deepEqual(orphanToolResults(session), [], '不得出现孤儿 tool 结果（provider 400）')
  } finally {
    await ctx.fiber.dispose()
  }
})

test('C 引擎级：R 组含活体 ⇒ 配对不变式仍成立（闭包路径也不破配对）', async () => {
  // ⚠️ 本用例**不能**断言"A 未被剪"：降级链里的 `selectClosureToMerge`（闭包生命周期）
  // **不经 `isAtomCandidate`** ⇒ 它可以绕过 A10 把含 A 的整段闭包剪掉（这正是 §2.6 列的
  // "另一条通路"，也是本次实测观察到的形态）。故此处只锁配对不变式：
  //   R 仍有内容时 A10 在**候选路径**上照旧保护（由本文件 A 组的纯函数断言锁定），
  //   而无论哪条路径剪了 A，其 R 都必须同批走 —— 这才是 provider 400 的唯一防线。
  const { ctx, engine } = await makeEngine()
  try {
    const session = Session.create(SessionId('c-live-group-protected'))
    appendUser(session, 'anchor')
    const { aSeq, rSeq } = appendToolPair(session, 1, 'c1', 'Z'.repeat(4000)) // R **不立碑**
    appendPressure(session)
    engine.setSession(session)

    const before = session.snapshotEvents().length
    await engine.compactIfNeeded({ session } as never, 'pressure', new AbortController().signal)
    const repl = replacesSince(session, before)
    assert.ok(repl.length > 0, 'prerequisite: 本次事务确实剪到了东西')
    const aCovered = covered(repl, aSeq)
    const rCovered = covered(repl, rSeq)
    assert.ok(!(aCovered && !rCovered),
      'A 被剪则其活体 R 必须同批（A=' + aCovered + ' / R=' + rCovered + '）区间 = ' + JSON.stringify(repl))
    assert.deepEqual(orphanToolResults(session), [])
  } finally {
    await ctx.fiber.dispose()
  }
})

// ---------------------------------------------------------------------------
// D. 事后整组校验（minSpanChars > 0 时的区间分裂）
// ---------------------------------------------------------------------------

test('C 引擎级：A 与 R 被 X 类黏着物隔开且 R 区间被放回时，撤销 A（不破配对）', async () => {
  // minSpanChars=100：A 的长区间保留、R 的短区间被整段放回
  // ⇒ 若不做事后校验 ⇒ A 走了、R 留下 = 孤儿 role:'tool'
  const { ctx, engine } = await makeEngine({ minSpanChars: 100 })
  try {
    const session = Session.create(SessionId('c-split-interval'))
    appendUser(session, 'anchor')
    // 形态：A（长参数）→ **X 类黏着物** → 该 A 的 R（已立碑）
    // ⇒ A 与 R 在 surface 上不相邻（position 相差 2）⇒ mergeIntervals 分成两个区间
    const aSeq = appendAssistantWithCall(session, 1, 'c1', '{"path":"' + 'p'.repeat(3000) + '"}')
    const spacerSeq = appendSpacerTombstone(session)
    const rSeq = (() => { appendToolResult(session, 1, 'c1', 'Z'.repeat(4000)); return session.snapshotEvents().length - 1 })()
    const stubSeq = stubToolResult(session, 1, 'c1', rSeq, toolTombstone(rSeq))
    appendPressure(session)
    engine.setSession(session)

    const before = session.snapshotEvents().length
    await engine.compactIfNeeded({ session } as never, 'pressure', new AbortController().signal)
    const repl = replacesSince(session, before)
    assert.ok(repl.length > 0, 'prerequisite: 本次事务确实剪到了东西')

    // 前置：黏着物必须仍在 surface（否则 A 与 R 相邻、区间合并，本用例退化为空过）
    assert.ok(!covered(repl, spacerSeq), 'prerequisite: X 类黏着物未被剪（分割成立）')

    const aCovered = covered(repl, aSeq)
    const rCovered = covered(repl, stubSeq)
    // 变异锁：摘掉 argp-graph-engine.ts 的事后整组校验循环 ⇒ aCovered && !rCovered ⇒ 本断言变红
    assert.ok(!(aCovered && !rCovered),
      'A 与 R 必须同进退（A 被剪=' + aCovered + ' / R 被剪=' + rCovered + '）')
    assert.deepEqual(orphanToolResults(session), [], '不得出现孤儿 tool 结果')
  } finally {
    await ctx.fiber.dispose()
  }
})
