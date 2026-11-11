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
