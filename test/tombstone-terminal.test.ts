/**
 * G 组（1.7.1）验收：墓碑终止态排除（G1）+ 文案统一（G2/G3）。
 *
 * ## 变异锁（强制）
 *
 * 「墓碑不再参剪」那组断言就是变异锁：**摘掉 `src/prune-selection.ts:isAtomCandidate`
 * 里的 `isTombstoneText` 短路，它们必须变红**。若摘掉后仍全绿，说明测试没有真的锁住修复。
 * 同理「无墓碑换墓碑」的引擎级断言必须在摘掉短路后变红。
 *
 * ## 背景数字（session-16188a24，见 docs/session-diag-16188a24-2026-09-25.md）
 *
 * - `replace` 事件 2,047 中 **1,560（76.2%）**是"墓碑换墓碑"（42c → 42c，收益 0）；
 * - 链式证据 `17(115c) → 708 → 1578 → 3136 → 3926 → 4729 → 5496 → 6274`；
 * - 30 个 `compaction/start` 却产生 2,045 个 `compaction/prune`；
 * - 墓文档位是 `isAtomCandidate` 没有任何"已立碑"判定（疑似 2026-08-23 半拆组的回归）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { asSeq, asSeqs } from '../src/log-access.ts'
import { ArgpGraphEngine, eventText, isMergeableTombstone } from '../src/argp-graph-engine.ts'
import { isAtomCandidate, type PruneState } from '../src/prune-selection.ts'
import {
  CLOSURE_ROOT_PREVIEW_MAX_CHARS,
  TOMBSTONE_MAX_CHARS,
  closureTombstone,
  consolidatedTombstone,
  isMergeableTombstoneText,
  isTombstoneText,
  isToolTombstoneText,
  seqRangeTombstone,
  toolTombstone,
  toolTombstoneSummary,
} from '../src/tombstone-text.ts'
import type { Atom } from '../src/argp-types.ts'

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

function appendUser(session: Session, text: string): void {
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
}

/** A(tool-call) + R 一对（V3 信封形态：`message.source.callId` 是 atomize 取 callId 的路径）。 */
function appendToolPair(session: Session, turn: number, callId: string, resultText: string): { aSeq: number; rSeq: number } {
  session.append('assistant/message', {
    stream: [],
    turn,
    step: 1,
    message: {
      role: 'assistant',
      id: 'am_' + callId,
      source: { kind: 'model', provider: 'test', model: 'test' },
      content: [{ type: 'tool-call', id: callId, name: 'read_file', arguments: '{"path":"x"}' }, { type: 'text', text: 'on it' }],
    },
  } as never, { surfaceOp: 'append' })
  const aSeq = session.snapshotEvents().length - 1
  session.append('tool/result', {
    turn,
    step: 1,
    message: {
      role: 'user',
      id: 'm_' + callId,
      source: { kind: 'tool', callId },
      content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: resultText }], isError: false }],
    },
  } as never, { surfaceOp: 'append' })
  const rSeq = session.snapshotEvents().length - 1
  return { aSeq, rSeq }
}

/** 把某 R 就地替换为 tool 占位墓碑（复刻 prune-tx 的 V3 分支：只改内层 text）。 */
function stubToolResult(session: Session, turn: number, callId: string, rSeq: number, text: string): void {
  session.append('tool/result', {
    turn,
    step: 1,
    message: {
      role: 'user',
      id: 'm_' + callId,
      source: { kind: 'tool', callId },
      content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }], isError: false }],
    },
  } as never, { surfaceOp: { op: 'replace', startSeq: asSeq(rSeq), endSeq: asSeq(rSeq) }, sourceEventSeqs: asSeqs([rSeq]) })
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
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: 'tombstone-terminal test persona' } })
  await ctx.plugin(ArgpGraphEngine, { windowTokens: 100, retainTokens: 50, minSpanChars: 20, recencyGuard: 0, maxPasses: 16, ...config })
  return { ctx, engine: ctx.compaction as ArgpGraphEngine }
}

// ---------------------------------------------------------------------------
// G2/G3：文案生成器与判据
// ---------------------------------------------------------------------------

test('G2/G3: 文案生成器形态（前缀 / seq 可见 / for detail）', () => {
  const tool = toolTombstone(1049)
  assert.equal(tool, '[elided: seq=1049; recall_pruned(1049) for detail]')
  assert.ok(tool.startsWith('[elided:'), 'tool 族用冒号前缀（不可合并判别子）')
  assert.ok(tool.includes('1049'), 'tool 墓碑必须自带原始 R 的 seq（1.7.0 写着 recall_pruned(seq) 却不给 seq）')

  const single = seqRangeTombstone(17, 17)
  assert.equal(single, '[elided seq=17; recall_pruned(17) for detail]', 'A === B 时退化为单节点形态')

  const range = seqRangeTombstone(17, 20)
  assert.equal(range, '[elided seq=17..20; recall_pruned(17) for detail]')

  const closure = closureTombstone('closure-2', 1, 9, 'task one')
  assert.ok(closure.includes('closure-2') && closure.includes('seqs=1..9'))
  assert.ok(closure.includes('task one'), 'root 预览保留（消歧线索）')
  assert.ok(closure.includes('recall_pruned(1) for detail'))

  // 闭包 root 预览截断（1.7.0 取整行、无上限 ⇒ 单条墓碑可达数千字符 ⇒ 抬地板 + G1 安全阀失效）
  const longRoot = '很长的首行' + 'x'.repeat(500)
  const truncated = closureTombstone('closure-9', 1, 2, longRoot)
  assert.ok(truncated.length < 200, 'root 预览必须被截断，got ' + truncated.length)
  assert.ok(truncated.includes('…'), '截断有显式省略号')
  assert.ok(CLOSURE_ROOT_PREVIEW_MAX_CHARS < 100)

  const agg = consolidatedTombstone(12, 8, 30)
  assert.ok(agg.includes('consolidated ×12') && agg.includes('seqs=8..30'))

  // 前缀一致性：全部族都以 [elided 开头且紧随 ' ' 或 ':'
  for (const t of [tool, single, range, closure, agg, toolTombstoneSummary()]) {
    assert.ok(isTombstoneText(t), '必须是墓碑: ' + t)
    assert.ok(/^\[elided[ :]/.test(t), '前缀形态: ' + t)
  }
})

test('G2/G3: 区间墓碑相对 1.7.0 显著缩短（token 收益来源）', () => {
  // 1.7.0 实际文案（逐字，来自 git 历史）
  const old110 = '[elided seq=8..9: 2 surface nodes pruned by ARGP (graph order, cites-aware); recall_pruned(seq) retrieves original]'
  const new110 = seqRangeTombstone(8, 9)
  assert.ok(new110.length <= old110.length * 0.5,
    '区间墓碑应至少砍半：' + old110.length + ' → ' + new110.length)

  const oldTool = '[elided: 旧版本结果已压缩；recall_pruned(seq) 找回原值]'
  const newTool = toolTombstone(1049)
  assert.ok(newTool.length <= oldTool.length + 10, 'tool 墓碑补 seq 后不应显著变长')
})

test('G2/G3: 判据（tool / 全族 / 可合并）三档分明', () => {
  assert.equal(isToolTombstoneText(toolTombstone(5)), true)
  assert.equal(isToolTombstoneText(seqRangeTombstone(5, 7)), false)
  assert.equal(isToolTombstoneText('[elidedFoo'), false, '缺分隔符不算墓碑（排除 [elidedFoo 类误判）')

  assert.equal(isTombstoneText('  ' + toolTombstone(5)), true, '允许前导空白')
  assert.equal(isTombstoneText('[已压缩-摘取 seq=5]'), false, 'peratom 压缩副本仍含信息，不算墓碑（应可继续剪）')
  assert.equal(isTombstoneText('[elidedFoo'), false)
  assert.equal(isTombstoneText('ordinary user text'), false)

  // 可合并族 = [elided + 空格族 + 含 recall_pruned
  assert.equal(isMergeableTombstone(seqRangeTombstone(8, 9)), true)
  assert.equal(isMergeableTombstone(closureTombstone('closure-2', 1, 9, 'root')), true)
  assert.equal(isMergeableTombstone(consolidatedTombstone(12, 8, 30)), true)
  assert.equal(isMergeableTombstone(toolTombstone(5)), false, 'tool 占位墓碑不可合并（孤儿 tool_call 防护）')
  assert.equal(isMergeableTombstone('<system-reminder>keep me</system-reminder>'), false)
  assert.equal(isMergeableTombstone('user instruction that happens to mention recall_pruned(1)'), false)
  // 与 prune-tx 的公开 API 同源（两者必须是同一实现）
  assert.equal(isMergeableTombstone(toolTombstone(5)), isMergeableTombstoneText(toolTombstone(5)))
  assert.equal(isMergeableTombstone(seqRangeTombstone(1, 2)), isMergeableTombstoneText(seqRangeTombstone(1, 2)))
})

test('G2/G3: 1.7.0 遗留文案不再被判为可合并（换轴后旧判据失效的历史数据）', () => {
  // 1.7.0 的 tool 墓碑（冒号前缀 + 指向 recall_pruned 的取回提示）——换轴后仍不可合并
  assert.equal(isMergeableTombstone('[elided: 旧版本结果已压缩；recall_pruned(seq) 找回原值]'), false)
  // 1.7.0 的区间墓碑——换轴后**仍可合并**（[elided 空格族 + 含 recall_pruned）
  assert.equal(isMergeableTombstone('[elided seq=8..9: 2 surface nodes pruned by ARGP (graph order, cites-aware); recall_pruned(seq) retrieves original]'), true,
    '换轴不应让历史墓碑失去可归并性（否则老会话的地板压不下去）')
})

// ---------------------------------------------------------------------------
// G1：墓碑终止态排除（变异锁）
// ---------------------------------------------------------------------------

test('G1: 已立碑的原子不再参剪；正常入度路径与 force 路径都拦住（变异锁）', () => {
  const stub = makeAtom({ seq: 5, type: 'R', text: toolTombstone(1049), toolCallIds: ['c1'] })
  const state = makeState([stub])

  // ← 摘掉 prune-selection.ts 的 isTombstoneText 短路后，下面两条必须变红
  assert.equal(isAtomCandidate(stub, false, state), false, 'G1：正常路径必须拦住墓碑')
  assert.equal(isAtomCandidate(stub, true, state), false, 'G1：force_prune 路径同样拦住（不再"墓碑换墓碑"）')

  // 对照组：同样条件、非墓碑文本 ⇒ 仍可剪（证明拦住它的是 G1，不是别的闸）
  const live = makeAtom({ seq: 6, type: 'R', text: 'EADDRINUSE stack line '.repeat(20), toolCallIds: ['c2'] })
  assert.equal(isAtomCandidate(live, true, makeState([live])), true, '非墓碑文本照常可剪')
})

test('G1: 长度安全阀——超长墓碑仍允许参剪（防地板卡死）', () => {
  const longStub = makeAtom({ seq: 7, type: 'R', text: toolTombstone(1049) + ' '.repeat(TOMBSTONE_MAX_CHARS), toolCallIds: ['c1'] })
  assert.ok(longStub.text.length > TOMBSTONE_MAX_CHARS)
  assert.equal(isAtomCandidate(longStub, true, makeState([longStub])), true, '超长墓碑仍入候选（宁少剪，不卡地板）')
})

test('G1: 覆盖四族墓碑（区间 / 闭包 / 聚合 / tool）', () => {
  const texts = [
    toolTombstone(1049),
    seqRangeTombstone(17, 20),
    seqRangeTombstone(17, 17),
    closureTombstone('closure-2', 1, 9, 'task one'),
    consolidatedTombstone(12, 8, 30),
  ]
  for (const text of texts) {
    const a = makeAtom({ seq: 30, type: 'R', text })
    assert.equal(isAtomCandidate(a, false, makeState([a])), false, 'G1 应覆盖: ' + text)
  }
  // user 墓碑在 1.7.0 已因 X 类不可候选（此处断言 X 类路径不变，防回归）
  const x = makeAtom({ seq: 31, type: 'X', text: 'whatever' })
  assert.equal(isAtomCandidate(x, true, makeState([x])), false, 'X 类（checkpoint/墓碑）从不参剪')
})

test('G1: 其他闸位不受影响（位置 / 年龄 / citesFailed 顺序不变）', () => {
  // 位置闸：recencyCut 之后
  const near = makeAtom({ seq: 3, type: 'R', text: 'live content'.repeat(5) })
  assert.equal(isAtomCandidate(near, false, makeState([near], { recencyCut: 0 })), false, '位置闸仍在')
  // 年龄闸
  const young = makeAtom({ seq: 4, type: 'R', turn: 10, text: 'live content'.repeat(5) })
  assert.equal(isAtomCandidate(young, false, makeState([young], { latestTurn: 10, turnGuard: 1 })), false, '年龄闸仍在')
  // citesFailed 保护
  const failed = makeAtom({ seq: 5, type: 'A', text: 'answer', citesFailed: true })
  assert.equal(isAtomCandidate(failed, true, makeState([failed])), false, 'citesFailed 保护仍在')
})

// ---------------------------------------------------------------------------
// G1 引擎级：不再产生"墓碑换墓碑"的 replace
// ---------------------------------------------------------------------------

test('G1 引擎级：剪枝事务不再替换已有墓碑（空转归零）', async () => {
  const { ctx, engine } = await makeEngine({ recencyGuard: 0, minSpanChars: 0, turnGuard: 0, maxPasses: 200 })
  try {
    const session = Session.create(SessionId('g1-terminal-engine'))
    appendUser(session, 'task anchor')
    // 已被剪成 tool 墓碑的 R（issuer A 存活 ⇒ 占位必需，1.7.0 会被反复再剪）
    const { rSeq: stubbed } = appendToolPair(session, 1, 'c1', 'X'.repeat(4000))
    stubToolResult(session, 1, 'c1', stubbed, toolTombstone(stubbed))
    // 另有一段**活体**可剪内容（保证事务确实剪到了东西，否则断言会空过）
    for (const turn of [2, 3, 4]) {
      const { rSeq } = appendToolPair(session, turn, 'c' + turn, 'Y'.repeat(3000))
      void rSeq
      session.append('assistant/message', {
        stream: [],
        turn,
        step: 1,
        message: createAssistantMessage({ source: { provider: 'test', model: 'test' }, content: [{ type: 'text', text: 'A' + turn + ':' + 'z'.repeat(2000) }] }),
      }, { surfaceOp: 'append' })
    }
    engine.setSession(session)

    const before = session.snapshotEvents().length
    await engine.compactIfNeeded({ session } as never, 'pressure', new AbortController().signal)

    // 只看引擎本次产生的 replace（fixture 手工造的替换不算）
    const replacedTargets = session.snapshotEvents()
      .filter(e => e.seq >= before)
      .filter(e => {
        const op = e.surfaceOp as { op?: string; startSeq?: number } | undefined
        return op !== undefined && typeof op === 'object' && op.op === 'replace' && op.startSeq !== undefined
      })
      .map(e => (e.surfaceOp as { startSeq: number }).startSeq)

    assert.ok(replacedTargets.length > 0, 'prerequisite: 本次事务确实剪到了活体内容')
    for (const seq of replacedTargets) {
      const text = eventText(session, seq)
      assert.ok(!isTombstoneText(text),
        'G1 变异锁：seq=' + seq + ' 是墓碑却被再次替换（1.7.0 的"墓碑换墓碑"空转）→ ' + text.slice(0, 60))
    }
    // 墓碑节点仍在 surface 上（未被剪走；注意 replace 副本是新 seq，故按文本判定）
    const surfaceTexts = [...session.surface.nodes].map(seq => eventText(session, seq))
    assert.ok(surfaceTexts.some(t => isToolTombstoneText(t)),
      'tool 占位墓碑仍在 surface（只被归并压地板，不靠重复剪）')
  } finally {
    await ctx.fiber.dispose()
  }
})

test('G1 引擎级：tombstone-merge（事件层）不受影响，地板仍能被压下去', async () => {
  const { ctx, engine } = await makeEngine({ tombstoneMergeMinRun: 4, recencyGuard: 0, minSpanChars: 0, turnGuard: 0 })
  try {
    const session = Session.create(SessionId('g1-merge-unaffected'))
    appendUser(session, 'anchor')
    // 连续 6 条**可合并** user 墓碑（[elided 空格族）
    for (let i = 0; i < 6; i += 1) {
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: seqRangeTombstone(300 + i * 2, 300 + i * 2) }],
        source: { kind: 'argp' },
      }), { surfaceOp: 'append' })
    }
    session.append('assistant/message', {
      stream: [],
      turn: 1,
      step: 1,
      message: createAssistantMessage({ source: { provider: 'test', model: 'test' }, content: [{ type: 'text', text: 'A:' + 'x'.repeat(400) }] }),
    }, { surfaceOp: 'append' })
    engine.setSession(session)
    const before = session.surface.nodes.length
    await engine.compactIfNeeded({ session } as never, 'pressure', new AbortController().signal)
    const mergedText = [...session.surface.nodes].map(seq => eventText(session, seq)).find(t => t.includes('consolidated'))
    assert.ok(mergedText !== undefined, '归并仍发生（事件层，不经 isAtomCandidate）')
    assert.ok(session.surface.nodes.length < before, '地板被压下去')
    assert.equal(isMergeableTombstone(mergedText), true, '聚合墓碑自身仍保持可再归并形态')
  } finally {
    await ctx.fiber.dispose()
  }
})
