/**
 * prune-tx surface 位置序排序回归锁（2026-11-11 P0：CB 四臂实锤病灶）。
 *
 * 病灶：调用方喂入的区间序 = 决策优先序（factor 压力剪按 retention 最差优先逐条成区间，
 * factor/engine.ts compactIfNeeded `for (const seq of plan.pruneOrder)`），不是 surface 位置序
 * → 首尾位置倒挂（实锤日志 `range [102, 52] … startIdx=31, endIdx=14`）直接撞 span 守卫
 * throw 整笔拒发 ⇒ 压力剪**静默蒸发**：CB 22 题会话 11 个中招（candidate 与 stock 皆中），
 * factor 臂压缩大面积失效 → 上下文失控涨到 35K+ 撞 provider 槽墙（轮死 finish=length/1-token）。
 * 修复：区间与墓碑按 indexOf(seqs[0]) **原子**位置排序（types.ts:107-117：shadowedRange 是
 * surface 位置 span，排序正是把 first/last 恢复到位置语义）。
 *
 * 变异纪律：
 *  ① 摘除排序块 → ①②撞守卫 throw 全红；
 *  ② 排序只动 intervals 不动 tombstones（拆配对）→ replace 的 sourceEventSeqs 与被剪节点
 *    失配，宿主 assertSourceEventReferences 拒 ⇒ result null ②红；
 *  ③ 排序方向倒置 → ①首尾极值断言红。
 *
 * 2.2.2 桩游程治理（④⑤⑥）：发射前**相邻同文 user 墓碑归并**——
 *  ④ 摘除归并块 → ④三连同文出 4 剪红；摘「逐字节同文」判据 → ④异文条被并红；
 *  ⑤ 摘 surface 位置邻接判据（同文即并）→ ⑤活体夹断红；
 *  ⑥ 摘 user 类型门（tool 参与归并）→ ⑥两条 callId 桩塌一红。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { pruneIntervals, type PruneTxHost } from '../src/prune-tx.ts'
import { sessionEvents } from '../src/log-access.ts'

function makeHost(): PruneTxHost {
  return {
    log: { info: () => {}, warn: () => {}, error: () => {} },
    stateOf: () => ({
      prunedNodeIndex: new Map(), records: [], lastRealPromptTokens: 0, lastRealAnchorSeq: 0,
    }) as never,
    compactSourceCommandId: undefined,
    charsPerToken: 4,
    telemetryCap: 100,
    bindSession: () => {},
    atomize: () => [],
    tombstoneMergeMinRun: 8,
    recencyGuard: 0,
    turnGuard: 0,
  } as unknown as PruneTxHost
}

function makeSession(id: string): Session {
  const session = Session.create(SessionId(id))
  session.append('system/message', { content: 'order persona' } as never, { surfaceOp: 'append' })
  return session
}

function appendUser(session: Session, turn: number, text: string): number {
  return session.append('user/message', { ...createUserMessage({
    content: [{ type: 'text', text }], source: { kind: 'user' },
  }), turn } as never, { surfaceOp: 'append' }).seq
}

function appendGroupV4(session: Session, turn: number, callId: string, resultText: string): number {
  session.append('assistant/message', {
    stream: [], turn, step: 1,
    message: createAssistantMessage({
      source: { provider: 'test', model: 'test' },
      content: [{ type: 'text', text: 'doing read' }, { type: 'tool-call', id: callId, name: 'read', arguments: '{}' } as never],
    }),
  } as never, { surfaceOp: 'append' })
  session.append('tool/call', { turn, callId, name: 'read', arguments: '{}' } as never)
  return session.append('tool/result', {
    turn, step: 1,
    message: {
      role: 'tool', source: { kind: 'tool', callId }, toolCallId: callId,
      content: [{ type: 'text', text: resultText }], isError: false, id: 'm_' + callId,
    },
  } as never, { surfaceOp: 'append' }).seq
}

test('① 倒挂多区间事务：优先序喂入（尾…首）必须成功落盘，首尾极值按位置归正', () => {
  const session = makeSession('tx-order-user-desc')
  appendUser(session, 1, 'task')
  const s1 = appendUser(session, 2, 'r1:' + 'A'.repeat(400))
  const s2 = appendUser(session, 3, 'r2:' + 'B'.repeat(400))
  const s3 = appendUser(session, 4, 'r3:' + 'C'.repeat(400))
  // 决策优先序 = 新者优先（retention 倒序）：区间尾 < 区间首 = 病灶形
  const intervals = [s3, s2, s1].map(seq => ({ seqs: [seq], chars: 400, atoms: [] }))
  const result = pruneIntervals(makeHost(), session, intervals, 0, intervals.length, false, undefined, 'factor-prune')
  assert.notEqual(result, null, '倒挂优先序喂入不得再撞守卫拒发（修复前此路 throw）')
  assert.equal(result!.shadowedRange.start, s1 as never, '位置序排序后 first=最前位（s1）')
  assert.equal(result!.shadowedRange.end, s3 as never, 'last=最后位（s3）')
  const dump = session.snapshotEvents().map(e => JSON.stringify(e)).join('\n')
  for (const s of [s1, s2, s3]) {
    assert.ok(dump.includes(`"start":${s},"end":${s}`) || dump.includes(`"start": ${s}`), `seq ${s} 的 replace 必须落盘`)
  }
})

test('② 倒挂 + tool 墓碑：排序必须与墓碑原子换位（配对=桩文/原 R/位点三者同轨）', () => {
  const session = makeSession('tx-order-tool-desc')
  appendUser(session, 1, 'task')
  const s1 = appendGroupV4(session, 2, 'c1', 'R1 ' + 'A'.repeat(400))
  const s2 = appendGroupV4(session, 3, 'c2', 'R2 ' + 'B'.repeat(400))
  const s3 = appendGroupV4(session, 4, 'c3', 'R3 ' + 'C'.repeat(400))
  const desc = [s3, s2, s1]
  const ids = ['c3', 'c2', 'c1']
  const intervals = desc.map(seq => ({ seqs: [seq], chars: 400, atoms: [] }))
  const tombstones = desc.map((seq, i) => ({
    type: 'tool' as const, seq, callId: ids[i] as string, text: `STUB-${ids[i]}`,
  }))
  const result = pruneIntervals(makeHost(), session, intervals, 0, intervals.length, false, tombstones, 'factor-prune')
  assert.notEqual(result, null, 'tool 墓碑形倒挂事务必须成功（拆配对会被宿主 sourceEventSeqs 校验拒 ⇒ null）')
  // surface 序上桩文本必须 s1→s3 升序（replace 循环按排序后区间走），且每桩克隆自配对原 R（id=m_cX）
  const events = sessionEvents(session)
  const surfTexts = [...session.surface.nodes].map(sq => JSON.stringify((events[sq as number] as { data?: unknown } | undefined)?.data ?? ''))
  const pos = (needle: string): number => surfTexts.findIndex(t => t.includes(needle))
  const p1 = pos('STUB-c1'); const p2 = pos('STUB-c2'); const p3 = pos('STUB-c3')
  assert.ok(p1 >= 0 && p1 < p2 && p2 < p3, `桩在 surface 上必须按 s1<s2<s3 位置排列（实际 ${p1},${p2},${p3}）`)
  assert.ok(surfTexts[p1]?.includes('m_c1'), 'STUB-c1 必须克隆自 c1 的原 R（配对未被排序拆散）')
  assert.ok(surfTexts[p3]?.includes('m_c3'), 'STUB-c3 必须克隆自 c3 的原 R')
})

test('③ 已位置升序喂入（图臂常态形）：行为零变化（sort 稳定性锁）', () => {
  const session = makeSession('tx-order-asc')
  appendUser(session, 1, 'task')
  const s1 = appendUser(session, 2, 'r1:' + 'A'.repeat(400))
  const s2 = appendUser(session, 3, 'r2:' + 'B'.repeat(400))
  const intervals = [s1, s2].map(seq => ({ seqs: [seq], chars: 400, atoms: [] }))
  const result = pruneIntervals(makeHost(), session, intervals, 0, intervals.length, false, undefined, 'graph-prune')
  assert.notEqual(result, null, '升序喂入修复前后都必成功')
  assert.equal(result!.shadowedRange.start, s1 as never)
  assert.equal(result!.shadowedRange.end, s2 as never)
})

type EvLike = { type: string; data?: Record<string, unknown>; surfaceOp?: { op?: string; startSeq?: number; endSeq?: number } }
const evsOf = (session: Session): EvLike[] => sessionEvents(session) as unknown as EvLike[]
const pruneEvs = (session: Session): EvLike[] => evsOf(session).filter(e => e.type === 'compaction/prune')
/** shadow-price 契约：每条 compaction/prune 之后**紧随**的带 surfaceOp 事件必须是同范围 replace。 */
function assertShadowPriceContract(session: Session): void {
  const evs = evsOf(session)
  for (let i = 0; i < evs.length; i += 1) {
    if (evs[i]!.type !== 'compaction/prune') continue
    const range = evs[i]!.data?.shadowedRange as { start: number; end: number }
    let j = i + 1
    while (j < evs.length && evs[j]!.surfaceOp === undefined) j += 1
    const next = evs[j]
    assert.ok(next?.surfaceOp?.op === 'replace'
      && next.surfaceOp.startSeq === range.start && next.surfaceOp.endSeq === range.end,
      'prune@' + i + ' shadowedRange [' + range.start + ',' + range.end + '] 必须紧跟同范围 replace')
  }
}
const surfaceNeedleCount = (session: Session, needle: string): number => {
  const evs = evsOf(session)
  return [...session.surface.nodes].filter(sq => JSON.stringify((evs[sq as number] as { data?: unknown } | undefined)?.data ?? '').includes(needle)).length
}

test('④ 相邻同文 user 墓碑归并：3 连同文并 1 条 + 异文 1 条 ⇒ 2 剪 2 桩（shadow-price 契约逐对成立）', () => {
  const session = makeSession('tx-merge-adj')
  appendUser(session, 1, 'task')
  const s1 = appendUser(session, 2, 'a'.repeat(300))
  const s2 = appendUser(session, 3, 'b'.repeat(300))
  const s3 = appendUser(session, 4, 'c'.repeat(300))
  const s4 = appendUser(session, 5, 'd'.repeat(300))
  const SAME = '归并测试同文桩'
  const intervals = [s1, s2, s3, s4].map(seq => ({ seqs: [seq], chars: 300, atoms: [] }))
  const tombstones = [SAME, SAME, SAME, '异文桩'].map(text => ({ type: 'user' as const, text }))
  const result = pruneIntervals(makeHost(), session, intervals, 0, intervals.length, false, tombstones, 'factor-prune')
  assert.notEqual(result, null, '归并后事务必须成功落盘')
  const prunes = pruneEvs(session)
  assert.equal(prunes.length, 2, '三连同文并成 1 区间 + 异文独立 1 区间')
  assert.deepEqual([...(prunes[0]!.data!.shadowedSeqs as number[])], [s1, s2, s3], '宽区间=传递并条（位置序）')
  assert.deepEqual([...(prunes[1]!.data!.shadowedSeqs as number[])], [s4])
  assert.equal(surfaceNeedleCount(session, SAME), 1, '同文三条 ⇒ 表面一枚桩')
  assert.equal(surfaceNeedleCount(session, '异文桩'), 1, '异文不并（逐字节判据）')
  assert.equal(surfaceNeedleCount(session, 'a'.repeat(300)), 0)
  assert.equal(surfaceNeedleCount(session, 'd'.repeat(300)), 0)
  assertShadowPriceContract(session)
})

test('⑤ 邻接门：同文被活体夹断不并；同文邻接对倒序喂入排序后照样并', () => {
  const SAME = '邻接门同文桩'
  // (a) 活体夹断 ⇒ 位置不邻接 ⇒ 不并
  const gap = makeSession('tx-merge-gap')
  appendUser(gap, 1, 'task')
  const x1 = appendUser(gap, 2, 'p'.repeat(300))
  appendUser(gap, 3, 'LIVE-NODE')
  const x2 = appendUser(gap, 4, 'q'.repeat(300))
  const r1 = pruneIntervals(makeHost(), gap,
    [{ seqs: [x1], chars: 300, atoms: [] }, { seqs: [x2], chars: 300, atoms: [] }],
    0, 2, false, [{ type: 'user', text: SAME }, { type: 'user', text: SAME }], 'factor-prune')
  assert.notEqual(r1, null)
  assert.equal(pruneEvs(gap).length, 2, '活体夹断 ⇒ 同文两区间不并（surface 位置邻接判据）')
  assert.equal(surfaceNeedleCount(gap, SAME), 2)
  assert.ok(surfaceNeedleCount(gap, 'LIVE-NODE') === 1, '活体保留')
  assertShadowPriceContract(gap)
  // (b) 邻接同文对倒序喂入：排序块先归正位置序，归并块随后照样并条
  const desc = makeSession('tx-merge-desc')
  appendUser(desc, 1, 'task')
  const y1 = appendUser(desc, 2, 'm'.repeat(300))
  const y2 = appendUser(desc, 3, 'n'.repeat(300))
  const r2 = pruneIntervals(makeHost(), desc,
    [{ seqs: [y2], chars: 300, atoms: [] }, { seqs: [y1], chars: 300, atoms: [] }],
    0, 2, false, [{ type: 'user', text: SAME }, { type: 'user', text: SAME }], 'factor-prune')
  assert.notEqual(r2, null)
  const prunes = pruneEvs(desc)
  assert.equal(prunes.length, 1, '倒序喂入经排序后邻接同文 ⇒ 并成一条')
  assert.deepEqual([...(prunes[0]!.data!.shadowedSeqs as number[])], [y1, y2])
  assertShadowPriceContract(desc)
})

test('⑥ tool 结构桩豁免归并：邻接同文 tool 墓碑各剪各的（callId 配对语义不破）', () => {
  const session = makeSession('tx-merge-tool')
  appendUser(session, 1, 'task')
  const r1 = appendGroupV4(session, 2, 'c1', 'R1 ' + 'A'.repeat(400))
  const r2 = appendGroupV4(session, 3, 'c2', 'R2 ' + 'B'.repeat(400))
  const intervals = [{ seqs: [r1], chars: 400, atoms: [] }, { seqs: [r2], chars: 400, atoms: [] }]
  const tombstones = [
    { type: 'tool' as const, seq: r1, callId: 'c1', text: '同文豁免' },
    { type: 'tool' as const, seq: r2, callId: 'c2', text: '同文豁免' },
  ]
  const result = pruneIntervals(makeHost(), session, intervals, 0, intervals.length, false, tombstones, 'factor-prune')
  assert.notEqual(result, null)
  assert.equal(pruneEvs(session).length, 2, 'tool 类型不参与归并（user 类型门）')
  assert.equal(surfaceNeedleCount(session, '同文豁免'), 2)
  assert.ok(surfaceNeedleCount(session, 'm_c1') === 1 && surfaceNeedleCount(session, 'm_c2') === 1,
    '两条桩各自克隆原 R（callId/配对独立保留）')
  assertShadowPriceContract(session)
})
