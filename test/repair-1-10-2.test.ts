/**
 * 1.10.2 修复批次回归锁（docs/repair-plan-2026-10-25.md 批次 0）。
 *
 * 纪律：每个测试对应一个修复项，**删掉修复必须变红**（变异验证过才算锁住）。
 *  - 0-1 attachmentBlocksOf 形状 → uinfo-attachment.test.ts（fixture 已改真实宿主形状，即锁）
 *  - 0-2 info-only 尊重 infoLevel/infoText（本文件 §0-2）
 *  - 0-3 cites 毒化 + 墓碑结构锚定（本文件 §0-3；force 可越锁在 tombstone-terminal 闸序测试）
 *  - 0-4 list_pruned 默认模式硬顶 + 计入预算（本文件 §0-4）
 *  - 0-5 账本重建尊重 error-end（本文件 §0-5）
 *  - 0-6 归并墓碑指向 append 根源 + recall 墓碑重定向（本文件 §0-6）
 *  - 0-8 构造期配置形状校验（本文件 §0-8）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId, createAssistantMessage, createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import { asSeq, asSeqs, eventText } from '../src/log-access.ts'
import { ArgpGraphEngine } from '../src/argp-graph-engine.ts'
import { planReplacements } from '../src/peratom/compressor.ts'
import type { CompressDecision, CurrentTurnCollect } from '../src/peratom/compressor.ts'
import { ARG_NS } from '../src/peratom/types.ts'
import { isAtomCandidate, buildPruneIndexes, buildTombstoneReplaceSeqs, type PruneState } from '../src/prune-selection.ts'
import { buildTombstoneRedirect } from '../src/prune-tx.ts'
import { consolidatedTombstone, isTombstoneText, isLooseLegacyTombstoneText, seqRangeTombstone, toolTombstone } from '../src/tombstone-text.ts'
import type { Atom } from '../src/argp-types.ts'

async function makeEngine(config: Record<string, unknown> = {}): Promise<{ ctx: Context; engine: ArgpGraphEngine }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: 'repair-1-10-2 test' } })
  await ctx.plugin(ArgpGraphEngine, { windowTokens: 100, retainTokens: 50, minSpanChars: 20, recencyGuard: 0, maxPasses: 16, ...config })
  return { ctx, engine: ctx.compaction as ArgpGraphEngine }
}

function appendUser(session: Session, text: string): void {
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
}

function appendAssistant(session: Session, text: string, turn = 1): number {
  session.append('assistant/message', {
    stream: [], turn, step: 1,
    message: createAssistantMessage({ source: { provider: 'test', model: 'test' }, content: [{ type: 'text', text }] }),
  }, { surfaceOp: 'append' })
  return session.snapshotEvents().length - 1
}

/** 真实宿主形状的 user/message 事件（content 在 data.content，无 message 层）。 */
function userEventAt(seq: number, text: string): never {
  return { type: 'user/message', seq, time: 0, surfaceOp: 'append', data: { content: [{ type: 'text', text }], source: { kind: 'user' } } } as never
}

async function runTool(ctx: Context, name: string, args: Record<string, unknown>): Promise<string> {
  const res = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId('repair-' + name + '-' + Math.random().toString(36).slice(2)),
    name,
    arguments: args,
  })
  return res.content[0]?.type === 'text' ? res.content[0].text : ''
}

// ---------------------------------------------------------------------------
// §0-2 info-only 分支尊重 infoLevel/infoText
// ---------------------------------------------------------------------------

function infoOnlyCollect(text: string, seq = 5): { collect: CurrentTurnCollect; events: never[] } {
  return {
    collect: {
      turn: 1, startSeq: seq, endSeq: seq, interrupted: false,
      userLong: [{ kind: 'user-long', seq, turn: 1, text }],
      toolResults: [],
    },
    events: (() => { const arr = new Array<never>(seq + 1); arr[seq] = userEventAt(seq, text); return arr })(),
  }
}

test('0-2: info-only + summary ⇒ 副本与 meta.summary 用模型压缩文本（此前整档 no-op）', () => {
  const text = 'error code E1234 at C:/sys/path.cfg, retry count 3. ' + 'k'.repeat(120)
  const { collect, events } = infoOnlyCollect(text)
  // 空 quotes ⇒ resolveSplit 走 info-only；summary 档 = 审计放行（缺失入账、文本采用）。
  const decision: CompressDecision = { splits: [{ seq: 5, quotes: [], infoLevel: 'summary', infoText: 'E1234 重试 3 次的路径错误' }], tools: [] }
  const plan = planReplacements(collect, decision, events)
  assert.equal(plan.steps.length, 1)
  const data = plan.steps[0]!.data as { content: ContentBlock[]; [ARG_NS]?: { summary: string } }
  assert.equal(data.content[0]!.type, 'text')
  assert.equal((data.content[0] as { text: string }).text, 'E1234 重试 3 次的路径错误', 'surface 副本 = 压缩文本')
  assert.equal(data[ARG_NS]!.summary, 'E1234 重试 3 次的路径错误', 'meta.summary 同步压缩文本')
  assert.ok(plan.summaryDropped.length > 0, 'summary 审计入账缺失硬 token')
})

test('0-2: info-only + extract 守卫不过 ⇒ 回退原文（错误方向只往少压错）', () => {
  const text = 'error code E1234 at C:/sys/path.cfg, retry count 3. ' + 'k'.repeat(120)
  const { collect, events } = infoOnlyCollect(text)
  const decision: CompressDecision = { splits: [{ seq: 5, quotes: [], infoLevel: 'extract', infoText: 'plain words without any hard token' }], tools: [] }
  const plan = planReplacements(collect, decision, events, { hlsMode: 'off' })
  const data = plan.steps[0]!.data as { content: ContentBlock[] }
  assert.equal((data.content[0] as { text: string }).text, text, 'extract 缺硬 token ⇒ 原文保面')
  assert.equal(plan.skippedFidelity, 1)
})

// ---------------------------------------------------------------------------
// §0-3 墓碑终止态结构锚定
// ---------------------------------------------------------------------------

test('0-3: isTombstoneText 文法锚定——现行四族/摘要族/遗留族整串命中，截断与自造文本不命中', () => {
  // 现行四族 + off-surface 摘要族
  for (const t of [
    toolTombstone(1049),
    seqRangeTombstone(17, 17),
    seqRangeTombstone(17, 20),
    '[elided closure closure-2 seqs=1..9; root=task one; recall_pruned(1) for detail]',
    consolidatedTombstone(12, 8, 30),
    '[elided: tool result compressed]',
  ]) {
    assert.ok(isTombstoneText(t), 'must match grammar: ' + t)
  }
  // git 历史遗留族（v1.3.0/v1.5.0/v1.7.0 生成器逐字）
  for (const t of [
    '[elided: 旧版本结果已压缩；recall_pruned(seq) 找回原值]',
    '[elided tool result; recall_pruned(seq) retrieves original]',
    '[elided seq=3..9: 7 surface nodes pruned by ARGP (graph order, cites-aware); recall_pruned(seq) retrieves original]',
    '[elided seq=3..9: 7 surface nodes pruned by ARGP (graph order, cites-aware, forced); recall_pruned(seq) retrieves original]',
    '[elided closure closure-1 seqs=1..9: 9 of 9 surface nodes in this closure pruned by ARGP closure lifecycle; root=x; recall_pruned(seq) retrieves original]',
    '[elided consolidated ×3 seqs=1..9: these placeholder nodes were themselves pruned by ARGP (tombstone-merge, §11.8); originals remain recallable via recall_pruned(seq) / list_pruned]',
  ]) {
    assert.ok(isTombstoneText(t), 'legacy grammar must match: ' + t)
  }
  // 截断引用 / 前缀相似 / 自造文本：旧宽判据（前缀+紧随字符）会误认，文法锚定后不命中
  for (const t of [
    '[elidedFoo]', // 前缀粘连
    '[elided seq=1..2; recall_pruned(' , // 源码里被截断的字面量
    '[elided seq=1..2; recall_pruned(1) for detail] extra trailing', // 后缀粘连
    '[elided something the model made up]',
  ]) {
    assert.equal(isTombstoneText(t), false, 'must NOT match grammar: ' + t)
  }
  // 宽松旧版判据（只允许与 replace 事件锚串联）：合法族命中，自造前缀文本不命中
  assert.equal(isLooseLegacyTombstoneText('[elided seq=1..2: pruned by ARGP (graph order); recall_pruned(seq) retrieves original]'), true)
  assert.equal(isLooseLegacyTombstoneText('[elided made up but says pruned by ARGP and recall_pruned(1)]'), true, '宽松档本就以文本为准（防漏认），安全由事件锚承担')
  assert.equal(isLooseLegacyTombstoneText('[elidedFoo recall_pruned(1)]'), false)
})

test('0-3: buildTombstoneReplaceSeqs——replace+文法入集；append 同文本不入集（伪造免疫）', () => {
  const tomb = toolTombstone(9)
  const mkEvent = (seq: number, surfaceOp: unknown): { seq: number; type: string; surfaceOp: unknown; data: unknown } =>
    ({ seq, type: 'tool/result', surfaceOp, data: { message: { role: 'tool', content: [{ type: 'text', text: tomb }] } } })
  const events = [
    undefined, // seq 0 空洞防御
    mkEvent(1, 'append'), // 模型/工具输出的"完美文法墓碑"，但事件是 append
    mkEvent(2, { op: 'replace', startSeq: 1, endSeq: 1 }), // 真墓碑：replace 事件
  ]
  const atoms: Atom[] = [
    { id: 1, seq: 1, type: 'R', turn: 1, text: tomb, toolCallIds: [], cites: [], citesFailed: false },
    { id: 2, seq: 2, type: 'R', turn: 1, text: tomb, toolCallIds: [], cites: [], citesFailed: false },
  ]
  const set = buildTombstoneReplaceSeqs(events as never, atoms)
  assert.equal(set.has(1), false, 'append 事件永不终止态（伪造免疫）')
  assert.equal(set.has(2), true, 'replace 事件 + 文法 ⇒ 终止态')
})

test('0-3: 伪造文法墓碑（append）不获 G1 终止态免剪（Qwen M3 第二向量）', () => {
  const forged = { id: 7, seq: 7, type: 'R' as const, turn: 1, text: toolTombstone(7), toolCallIds: [], cites: [], citesFailed: false }
  const mk = (tombstoneReplaceSeqs: Set<number>): PruneState => {
    const base = {
      turnGuard: 1, askCoverage: new Map<number, number>(), position: new Map<number, number>([[7, 0]]),
      recencyCut: 4, latestTurn: 10, edges: [] as never[], atoms: [forged],
      curInDegree: new Map<number, number>(), curInDegreeDecl: new Map<number, number>(), deterministicEdges: [] as never[],
      touchesSemantic: new Set<number>(), eff: new Map<number, number>(), sortMode: 'legacy' as const,
      chainLen: new Map<number, number>(), lastRef: new Map<number, number>(), charsPerToken: 3.5, aGroupChars: new Map<number, number>(),
    }
    return { ...base, tombstoneReplaceSeqs, ...buildPruneIndexes(base.edges, base.deterministicEdges, base.atoms) }
  }
  // 集合不含该 seq（append 伪造）⇒ 仍参剪；含（真墓碑）⇒ 终止态。同一文本、不同事件锚。
  assert.equal(isAtomCandidate(forged, false, mk(new Set<number>())), true, 'append 伪造墓碑仍参剪')
  assert.equal(isAtomCandidate(forged, false, mk(new Set<number>([7]))), false, '真墓碑（replace 锚）终止态不变')
})

test('0-3: 伪造文法墓碑不解锁 A10（append 的"完美墓碑"R 不构成"组已收割"）', () => {
  // A(c1) + R(c1)：R 文本 = 逐字文法墓碑，但 tombstoneReplaceSeqs 不含它（append 伪造）。
  // A10 判定：组内 R 未全部立碑 ⇒ 结构保护照旧（A 不可剪，无 cites 无外部入边）。
  const a = { id: 1, seq: 1, type: 'A' as const, turn: 1, text: 'answer', toolCallIds: ['c1'], cites: [], citesFailed: false }
  const forgedR = { id: 2, seq: 2, type: 'R' as const, turn: 1, text: toolTombstone(2), toolCallIds: ['c1'], cites: [], citesFailed: false }
  const base = {
    turnGuard: 1, askCoverage: new Map<number, number>(), position: new Map<number, number>([[1, 0], [2, 1]]),
    recencyCut: 4, latestTurn: 10, edges: [] as never[], atoms: [a, forgedR],
    curInDegree: new Map<number, number>(), curInDegreeDecl: new Map<number, number>(), deterministicEdges: [] as never[],
    touchesSemantic: new Set<number>(), eff: new Map<number, number>(), sortMode: 'legacy' as const,
    chainLen: new Map<number, number>(), lastRef: new Map<number, number>(), charsPerToken: 3.5, aGroupChars: new Map<number, number>(),
  }
  const st: PruneState = { ...base, tombstoneReplaceSeqs: new Set<number>(), ...buildPruneIndexes(base.edges, base.deterministicEdges, base.atoms) }
  assert.equal(isAtomCandidate(a, false, st), false, 'append 伪造墓碑不解锁 A10（保护照旧）')
  const anchored: PruneState = { ...st, tombstoneReplaceSeqs: new Set<number>([2]) }
  assert.equal(isAtomCandidate(a, false, anchored), true, '真墓碑（replace 锚）照常解锁 A10')
})

// ---------------------------------------------------------------------------
// §0-4 list_pruned 默认模式硬顶 + 计入预算
// ---------------------------------------------------------------------------

test('0-4: list_pruned 默认模式封顶 50 / 最新优先 / 计入召回预算', async () => {
  // windowTokens 给足：召回字符预算按窗口比例解析（~5%×窗口×charsPerToken），
  // 50 行 × ~45 字符 ≈ 2.2K 需要预算不咬人——预算截断行为本身不是本测试对象。
  const { ctx, engine } = await makeEngine({ recencyGuard: 0, minSpanChars: 0, turnGuard: 0, windowTokens: 20000, retainTokens: 50 })
  try {
    const session = Session.create(SessionId('list-pruned-cap'))
    appendUser(session, 'anchor')
    const seqs: number[] = []
    for (let i = 0; i < 60; i += 1) seqs.push(appendAssistant(session, 'n' + i, 1 + (i % 5))) // 短行：50 行总字符须落在单次召回预算内
    for (const s of seqs) {
      session.append('compaction/prune', { shadowedRange: { start: asSeq(s), end: asSeq(s) }, shadowedSeqs: asSeqs([s]), shadowedTokenCount: 5 })
    }
    engine.setSession(session)
    const usedBefore = (engine as unknown as { recallCharsUsed: number }).recallCharsUsed
    const out = await runTool(ctx, 'list_pruned', {})
    const lines = out.split('\n')
    assert.ok(out.includes('capped at limit=50'), '必须带截断提示: ' + out.slice(0, 120))
    const dataLines = lines.filter(l => l.startsWith('seq='))
    assert.equal(dataLines.length, 50, '恰好 50 行')
    const firstSeq = Number(/seq=(\d+)/.exec(dataLines[0]!)![1])
    assert.ok(firstSeq === Math.max(...seqs), '最新优先（首行 = 最大 seq）: ' + firstSeq)
    assert.ok((engine as unknown as { recallCharsUsed: number }).recallCharsUsed > usedBefore, '默认模式计入召回字符预算')
  } finally {
    await ctx.fiber.dispose()
  }
})

// ---------------------------------------------------------------------------
// §0-5 账本重建尊重 error-end
// ---------------------------------------------------------------------------

test('0-5: error-end 事务重建为 partial——error 入账 / 无假墓碑重定向 / 只索引真被替换 seq', async () => {
  const { ctx, engine } = await makeEngine({ recencyGuard: 0, minSpanChars: 0, turnGuard: 0 })
  try {
    const session = Session.create(SessionId('ledger-error-end'))
    appendUser(session, 'anchor')
    const a1 = appendAssistant(session, 'A1-ORIGINAL ' + 'x'.repeat(50))
    const a2 = appendAssistant(session, 'A2-ORIGINAL ' + 'y'.repeat(50))
    session.append('compaction/start', { compactionId: CompactionId('tx-err-1'), turn: 1 })
    session.append('compaction/prune', { shadowedRange: { start: asSeq(a1), end: asSeq(a2) }, shadowedSeqs: asSeqs([a1, a2]), shadowedTokenCount: 30 })
    // 只有 a1 真正被 replace（partial：第二个 replace 前抛错的形态）；a2 仍在 surface。
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: seqRangeTombstone(a1, a1) }],
      source: { kind: 'argp' },
    }), { surfaceOp: { op: 'replace', startSeq: asSeq(a1), endSeq: asSeq(a1) }, sourceEventSeqs: asSeqs([a1]) })
    const endSeq = session.append('compaction/end', { compactionId: CompactionId('tx-err-1'), turn: 1, error: 'synthetic partial failure' }).seq
    engine.setSession(session) // bindSession 懒触发 rebuildLedgerFromLog

    const record = engine.records.find(r => r.compactionId === 'tx-err-1')
    assert.ok(record !== undefined, '事务被重建（有 prune 事件落地）')
    assert.equal(record.error, 'synthetic partial failure', 'error 显式入账')
    assert.equal(record.intervals.length, 0, 'partial 不产墓碑重定向记录')
    assert.equal(buildTombstoneRedirect(engine.records).size, 0, '重定向表无假映射（旧实现会映射到 off-surface 的 error end seq=' + endSeq + '）')
    assert.equal(engine.prunedNodeIndex.has(a1), true, '真被替换的 seq 入剪索引')
    assert.equal(engine.prunedNodeIndex.has(a2), false, '未被替换的 seq（仍在 surface）不入剪索引')
  } finally {
    await ctx.fiber.dispose()
  }
})

// ---------------------------------------------------------------------------
// §0-6 归并墓碑指向 append 根源 + recall 墓碑重定向
// ---------------------------------------------------------------------------

test('0-6: 归并聚合墓碑的 seqs/recall 指向 append 根源（非墓碑副本自身）', async () => {
  const { ctx, engine } = await makeEngine({ tombstoneMergeMinRun: 2, recencyGuard: 0, minSpanChars: 0, turnGuard: 0 })
  try {
    const session = Session.create(SessionId('consolidate-roots'))
    appendUser(session, 'anchor')
    const a1 = appendAssistant(session, 'ORIGINAL-AAA ' + 'x'.repeat(200))
    const a2 = appendAssistant(session, 'ORIGINAL-BBB ' + 'y'.repeat(200))
    // 两条真 replace 墓碑（区间族，各自指向原文）
    for (const [start, end] of [[a1, a1], [a2, a2]] as const) {
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: seqRangeTombstone(start, end) }],
        source: { kind: 'argp' },
      }), { surfaceOp: { op: 'replace', startSeq: asSeq(start), endSeq: asSeq(end) }, sourceEventSeqs: asSeqs([start]) })
    }
    appendAssistant(session, 'A:' + 'z'.repeat(400)) // 触发压力
    engine.setSession(session)
    await engine.compactIfNeeded({ session } as never, 'pressure', new AbortController().signal)
    const merged = [...session.surface.nodes].map(seq => eventText(session, seq)).find(t => t.includes('consolidated'))
    assert.ok(merged !== undefined, '归并发生')
    assert.ok(merged.includes('seqs=' + a1 + '..' + a2), '聚合指向 append 根源 ' + a1 + '..' + a2 + '，而非副本 seq；got: ' + merged)
    assert.ok(merged.includes('recall_pruned(' + a1 + ')'), 'recall 指针 = 根源首 seq')
  } finally {
    await ctx.fiber.dispose()
  }
})

test('0-6: recall_pruned 打到墓碑副本 seq ⇒ 重定向返回 append 根源原文', async () => {
  const { ctx, engine } = await makeEngine({ recencyGuard: 0, minSpanChars: 0, turnGuard: 0 })
  try {
    const session = Session.create(SessionId('recall-tombstone-redirect'))
    appendUser(session, 'anchor')
    const a1 = appendAssistant(session, 'SECRET-ORIGINAL-XYZ ' + 'w'.repeat(100))
    session.append('compaction/prune', { shadowedRange: { start: asSeq(a1), end: asSeq(a1) }, shadowedSeqs: asSeqs([a1]), shadowedTokenCount: 30 })
    const copy = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: seqRangeTombstone(a1, a1) }],
      source: { kind: 'argp' },
    }), { surfaceOp: { op: 'replace', startSeq: asSeq(a1), endSeq: asSeq(a1) }, sourceEventSeqs: asSeqs([a1]) }).seq
    appendUser(session, 'latest')
    engine.setSession(session)

    const out = await runTool(ctx, 'recall_pruned', { seq: copy })
    assert.ok(out.includes('[tombstone redirect: seq ' + copy), '重定向说明头: ' + out.slice(0, 100))
    assert.ok(out.includes('SECRET-ORIGINAL-XYZ'), '返回原文而非又一层墓碑文本')
    assert.ok(!out.includes('for detail]'), '不应返回墓碑文案本身')
  } finally {
    await ctx.fiber.dispose()
  }
})

// ---------------------------------------------------------------------------
// §0-8 构造期配置形状校验
// ---------------------------------------------------------------------------

test('0-8: skipPresets 非数组 ⇒ 构造期显式拒绝（旧实现 spread 成字符数组静默永不匹配）', async () => {
  await assert.rejects(
    makeEngine({ skipPresets: 'minimal' as never }),
    /skipPresets: expected string\[\]/,
  )
})

test('0-8: NaN 数值旋钮 ⇒ 构造期显式拒绝（旧实现静默偏移预算）', async () => {
  await assert.rejects(
    makeEngine({ windowTokens: Number.NaN }),
    /windowTokens: expected finite number/,
  )
})
