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
 *
 * 2.2.2 存档加载地雷锁（⑦，session-43df801e 案）：非 append 的 tool/result 必须处于
 *  开放轮内（宿主 v4 fold），prune-tx 预检按 detectOpenTurn 剔除轮间隙 tool 桩区间：
 *  摘除 openTurnPre===null 剔除分支 → ⑦红（毒桩落盘）；剔除误伤 user 桩 → ⑦红。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { pruneIntervals, type PruneTxHost } from '../src/prune-tx.ts'
import { detectOpenTurn, sessionEvents } from '../src/log-access.ts'

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

function appendGroupV4(session: Session, turn: number, callId: string, resultText: string): { aSeq: number; rSeq: number; callId: string } {
  const aSeq = session.append('assistant/message', {
    stream: [], turn, step: 1,
    message: createAssistantMessage({
      source: { provider: 'test', model: 'test' },
      content: [{ type: 'text', text: 'doing read' }, { type: 'tool-call', id: callId, name: 'read', arguments: '{}' } as never],
    }),
  } as never, { surfaceOp: 'append' }).seq
  session.append('tool/call', { turn, callId, name: 'read', arguments: '{}' } as never)
  const rSeq = session.append('tool/result', {
    turn, step: 1,
    message: {
      role: 'tool', source: { kind: 'tool', callId }, toolCallId: callId,
      content: [{ type: 'text', text: resultText }], isError: false, id: 'm_' + callId,
    },
  } as never, { surfaceOp: 'append' }).seq
  return { aSeq, rSeq, callId }
}

test('① 倒挂多区间事务：优先序喂入（尾…首）必须成功落盘，首尾极值按位置归正', () => {
  const session = makeSession('tx-order-user-desc')
  appendUser(session, 1, 'task')
  const s1 = appendUser(session, 2, 'r1:' + 'A'.repeat(400))
  const s2 = appendUser(session, 3, 'r2:' + 'B'.repeat(400))
  const s3 = appendUser(session, 4, 'r3:' + 'C'.repeat(400))
  // 决策优先序 = 新者优先（retention 倒序）：区间尾 < 区间首 = 病灶形
  const intervals = [s3, s2, s1].map(seq => ({ seqs: [seq], chars: 400, atoms: [] }))
  const result = pruneIntervals(makeHost(), session, intervals, intervals.length, false, intervals.map((_iv, i) => ({ type: 'user' as const, text: 'CP-' + i })), 'factor-prune')
  assert.notEqual(result, null, '倒挂优先序喂入不得再撞守卫拒发（修复前此路 throw）')
  assert.equal(result!.shadowedRange.start, s1 as never, '位置序排序后 first=最前位（s1）')
  assert.equal(result!.shadowedRange.end, s3 as never, 'last=最后位（s3）')
  const dump = session.snapshotEvents().map(e => JSON.stringify(e)).join('\n')
  for (const s of [s1, s2, s3]) {
    assert.ok(dump.includes(`"start":${s},"end":${s}`) || dump.includes(`"start": ${s}`), `seq ${s} 的 replace 必须落盘`)
  }
})

test('② 倒挂 + 整组 user 检查点：排序必须与墓碑原子换位（检查点文本/位点同轨）', () => {
  const session = makeSession('tx-order-group-desc')
  appendUser(session, 1, 'task')
  const g1 = appendGroupV4(session, 2, 'c1', 'R1 ' + 'A'.repeat(400))
  const g2 = appendGroupV4(session, 3, 'c2', 'R2 ' + 'B'.repeat(400))
  const g3 = appendGroupV4(session, 4, 'c3', 'R3 ' + 'C'.repeat(400))
  const desc = [g3, g2, g1]
  const intervals = desc.map(g => ({ seqs: [g.aSeq, g.rSeq], chars: 400, atoms: [] }))
  const tombstones = desc.map(g => ({ type: 'user' as const, text: 'CHECK-' + g.callId }))
  const result = pruneIntervals(makeHost(), session, intervals, intervals.length, false, tombstones, 'factor-prune')
  assert.notEqual(result, null, '倒挂优先序喂入不得撞守卫拒发（排序与墓碑必须原子换位）')
  // surface 序上检查点文本必须 c1→c3 升序（replace 循环按排序后区间走）
  const events = sessionEvents(session)
  const surfTexts = [...session.surface.nodes].map(sq => JSON.stringify((events[sq as number] as { data?: unknown } | undefined)?.data ?? ''))
  const pos = (needle: string): number => surfTexts.findIndex(t => t.includes(needle))
  const p1 = pos('CHECK-c1'); const p2 = pos('CHECK-c2'); const p3 = pos('CHECK-c3')
  assert.ok(p1 >= 0 && p1 < p2 && p2 < p3, `检查点必须按 c1<c2<c3 位置排列（实际 ${p1},${p2},${p3}）`)
})

test('③ 已位置升序喂入（图臂常态形）：行为零变化（sort 稳定性锁）', () => {
  const session = makeSession('tx-order-asc')
  appendUser(session, 1, 'task')
  const s1 = appendUser(session, 2, 'r1:' + 'A'.repeat(400))
  const s2 = appendUser(session, 3, 'r2:' + 'B'.repeat(400))
  const intervals = [s1, s2].map(seq => ({ seqs: [seq], chars: 400, atoms: [] }))
  const result = pruneIntervals(makeHost(), session, intervals, intervals.length, false, intervals.map((_iv, i) => ({ type: 'user' as const, text: 'CP-' + i })), 'graph-prune')
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
  const result = pruneIntervals(makeHost(), session, intervals, intervals.length, false, tombstones, 'factor-prune')
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
    2, false, [{ type: 'user', text: SAME }, { type: 'user', text: SAME }], 'factor-prune')
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
    2, false, [{ type: 'user', text: SAME }, { type: 'user', text: SAME }], 'factor-prune')
  assert.notEqual(r2, null)
  const prunes = pruneEvs(desc)
  assert.equal(prunes.length, 1, '倒序喂入经排序后邻接同文 ⇒ 并成一条')
  assert.deepEqual([...(prunes[0]!.data!.shadowedSeqs as number[])], [y1, y2])
  assertShadowPriceContract(desc)
})

test('⑥ 结构锁：tool/developer 形态墓碑整类废除（prune-tx 只发 user 检查点，事务前 fail-fast）', () => {
  const session = makeSession('tx-non-user-guard')
  appendUser(session, 1, 'task')
  const u = appendUser(session, 2, 'x'.repeat(300))
  const intervals = [{ seqs: [u], chars: 300, atoms: [] }]
  assert.throws(
    () => pruneIntervals(
      makeHost(), session, intervals, 1, false,
      [{ type: 'tool', seq: u, callId: 'c1', text: '毒桩' }] as never,
      'factor-prune',
    ),
    /only emit user\/message checkpoints/,
    '非 user 墓碑必须立即 throw（宿主 v4 fold 的毒形态结构性不可达）',
  )
  assert.equal(
    sessionEvents(session).filter(e => e.type === 'compaction/start').length, 0,
    'fail-fast 发生在事务开始前：不落 start，不留死括号',
  )
})

test('⑦ 轮间隙锁：无开放轮时 user 检查点事务照常落盘，全档零非 append tool/result', () => {
  // 现场复刻：轮次间隙手动 /compact（compaction/start.data.turn === null）。旧实现会在
  // 此处落非 append 的 tool/result（宿主 v4 fold requireTurn ⇒ 整档 corrupt）；根修后
  // surface replace 只发 user 检查点，与轮状态无关，事务可安全落盘。
  const session = makeSession('tx-gap-user') // 无 turn/start：detectOpenTurn=null
  appendUser(session, 1, 'task')
  const u1 = appendUser(session, 2, 'old ' + 'A'.repeat(400))
  const u2 = appendUser(session, 3, 'tail ' + 'B'.repeat(300))
  const intervals = [{ seqs: [u1], chars: 400, atoms: [] }, { seqs: [u2], chars: 300, atoms: [] }]
  const tombstones = [
    { type: 'user' as const, text: '间隙检查点A' },
    { type: 'user' as const, text: '间隙检查点B' },
  ]
  const result = pruneIntervals(makeHost(), session, intervals, intervals.length, false, tombstones, 'factor-prune')
  assert.equal(detectOpenTurn(session), null, '前置：事务确在轮间隙')
  assert.notEqual(result, null, 'user 检查点不受轮约束，事务照常落盘')
  assert.equal(pruneEvs(session).length, 2)
  assert.equal(surfaceNeedleCount(session, '间隙检查点A'), 1)
  assert.equal(surfaceNeedleCount(session, '间隙检查点B'), 1)
  assert.equal(surfaceNeedleCount(session, 'old '), 0)
  assert.equal(surfaceNeedleCount(session, 'tail '), 0)
  assert.ok(!sessionEvents(session).some(e => e.type === 'tool/result' && (e as { surfaceOp?: unknown }).surfaceOp !== 'append'),
    '整档不得存在非 append tool/result（加载校验毒形态结构性缺席）')
  assertShadowPriceContract(session)
})

test('⑧ 缓存断点锁：一笔压缩事务的 surface replace 数恰等于区间数（不引入额外前缀断点）', () => {
  // 缓存命中 = 最长未变前缀。压缩事务本身必然改写历史前缀（固有代价），
  // 但**每多一枚 replace 事件就是多一个前缀断点**——本锁保证发射面不增殖：
  // 区间数 == replace 数 == prune 数（相邻 shadow-price 成对）。
  const session = makeSession('tx-order-replace-count')
  appendUser(session, 1, 'task')
  const u1 = appendUser(session, 2, 'old ' + 'A'.repeat(400))
  const u2 = appendUser(session, 3, 'mid ' + 'B'.repeat(300))
  const u3 = appendUser(session, 4, 'tail ' + 'C'.repeat(200))
  const intervals = [
    { seqs: [u1], chars: 400, atoms: [] },
    { seqs: [u2], chars: 300, atoms: [] },
    { seqs: [u3], chars: 200, atoms: [] },
  ]
  const tombstones = [
    { type: 'user' as const, text: 'cp-one' },
    { type: 'user' as const, text: 'cp-two' },
    { type: 'user' as const, text: 'cp-three' },
  ]
  const result = pruneIntervals(makeHost(), session, intervals, intervals.length, false, tombstones, 'factor-prune')
  assert.notEqual(result, null, '事务应落盘')
  const evs = evsOf(session)
  const isReplace = (e: EvLike): boolean => typeof (e as { surfaceOp?: unknown }).surfaceOp === 'object'
    && (e as { surfaceOp?: unknown }).surfaceOp !== null
  const replaces = evs.filter(isReplace)
  assert.equal(replaces.length, intervals.length, '每个区间恰好一次 replace：多一次即多一个缓存前缀断点')
  assert.equal(replaces.length, pruneEvs(session).length, 'replace 与 prune 一一对应（宿主 shadow-price 相邻契约）')
  // 事务括号外零 replace：压缩之外不得再动前缀
  const bracket: [number, number][] = []
  let open: number | null = null
  for (const e of evs) {
    if (e.type === 'compaction/start') open = (e as unknown as { seq: number }).seq
    else if (e.type === 'compaction/end' && open !== null) { bracket.push([open, (e as unknown as { seq: number }).seq]); open = null }
  }
  assert.equal(bracket.length, 1, '恰一笔事务')
  const outside = replaces.filter(e => { const s = (e as unknown as { seq: number }).seq; return !bracket.some(([a, b]) => s >= a && s <= b) })
  assert.equal(outside.length, 0, '事务外零 surface replace（压缩之外不得产生额外缓存丢失）')
  assertShadowPriceContract(session)
})

test('⑨ 落点重导：外来 surface 替换落在 span 中段 ⇒ 事务成功且 prune 声明全部在场（2.2.2 blocker 锁）', () => {
  // 病灶（2026-11-27 rev-fold 复核实机复现）：散文浓缩在 LLM 之前取整段 span 快照，等模型数秒后
  // 才发射。窗口内任何 surface replace 落在 span **中段**时，旧的 summary 守卫只看首尾两点 ⇒
  // 整笔放行 ⇒ prune 按陈旧 seqs 落盘 → 紧随的 replace 被写入侧拒（sourceEventSeqs must include
  // every shadowed surface node）→ catch 只补 error end ⇒ **毒 prune 永久留在日志**（加载侧对每条
  // prune 无条件跑 span()，error end 关闭的事务同样校验）⇒ 整档拒载。
  const session = makeSession('tx-stale-mid')
  appendUser(session, 1, 'task')
  const n1 = appendUser(session, 2, 'A'.repeat(400))
  const n2 = appendUser(session, 3, 'B'.repeat(400))
  const n3 = appendUser(session, 4, 'C'.repeat(400))
  const intervals = [{ seqs: [n1, n2, n3], chars: 1200, atoms: [] }]   // 决策时刻的 span 快照
  // await 窗口内：外部替换掉中段的 n2（宿主 toolResultPruner / 外来压缩引擎的等价形态）
  session.append('user/message', {
    ...createUserMessage({ content: [{ type: 'text', text: '外来替换' }], source: { kind: 'user' } }),
  } as never, {
    surfaceOp: { op: 'replace', startSeq: n2 as never, endSeq: n2 as never },
    sourceEventSeqs: [n2] as never,
  })
  const liveBefore = [...session.surface.nodes].map(Number)
  const result = pruneIntervals(makeHost(), session, intervals, 1, false, [{ type: 'user' as const, text: 'CP' }], 'factor-prose')
  assert.notEqual(result, null, '中段被换掉不得整笔蒸发（修复前此路留毒 prune 落盘）')
  const claimed = pruneEvs(session).flatMap(e => e.data!.shadowedSeqs as number[])
  assert.ok(claimed.every(q => liveBefore.includes(q)),
    `prune 声明必须全部落在当前 surface 上：claimed=${JSON.stringify(claimed)} vs live=${JSON.stringify(liveBefore)}`)
  assert.ok(!claimed.includes(n2), '已离面的 n2 不得再进声明（这就是旧版毒 prune 的成因）')
  assert.equal(claimed.length, 3, '重导后声明 = 现读连续切片（外来替换被正常吞入本 span）')
  assertShadowPriceContract(session)
})

test('⑩ 词表纪律：压缩事务写出的模型可见文本不得点名已退役工具', () => {
  // 2.x 的取回通道只有 recall_history / list_labels / search_history。1.x 的墓碑生成器
  // （retrieve / toolTombstone / seqRangeTombstone）会写出 `recall_pruned(<seq>)` —— 那是一个
  // **不存在的工具**，比"不留指针"更糟：模型会去调一个没有的通道并自信地失败。
  // 生成器已整体删除、`tombstones` 也已改必填（缺省回退分支同时消失）。本锁保证任何新文案
  // 不能再把退役工具名写回模型可见面。
  const session = makeSession('tx-retired-tool-name')
  appendUser(session, 1, 'task')
  const u1 = appendUser(session, 2, 'old ' + 'A'.repeat(400))
  const u2 = appendUser(session, 3, 'old ' + 'B'.repeat(400))
  const result = pruneIntervals(makeHost(), session,
    [{ seqs: [u1], chars: 400, atoms: [] }, { seqs: [u2], chars: 400, atoms: [] }],
    2, false,
    [{ type: 'user', text: '已压缩剪枝次要原子' }, { type: 'user', text: '已压缩剪枝次要原子' }],
    'factor-prune')
  assert.notEqual(result, null, '事务应成功落盘')
  const evs = evsOf(session)
  const visible = [...session.surface.nodes]
    .map(sq => JSON.stringify((evs[sq as number] as { data?: unknown } | undefined)?.data ?? '')).join('\n')
  for (const dead of ['recall_pruned', 'list_pruned']) {
    assert.ok(!visible.includes(dead), `模型可见 surface 出现已退役工具名 ${dead}`)
  }
  assert.ok(!JSON.stringify(evs).includes('recall_pruned('), '事务不得写出 recall_pruned(...) 形态文本')
})
