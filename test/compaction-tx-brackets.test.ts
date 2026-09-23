/**
 * 事务括号配对：**每个 `compaction/start` 的全部退出路径恰好一条 `compaction/end`**。
 *
 * 背景（2026-09-23 审查发现，P2）：`prune-tx.pruneIntervals`（Stage-2 图剪）与
 * `peratom/flush.flushEntry`（轮末 per-atom 压缩）都把**成功**的 `compaction/end` 放在
 * `try` 内、**后面还有可抛语句**（flush 的断言 2b 代数增量；prune-tx 的 checkpoint 记账、
 * `pushBounded` 遥测、锚点重置），而 `catch` **无条件**再补一条带 `error` 的 end。
 * ⇒ 成功 end 之后的语句一旦抛出，同一个 `compactionId` 就写出**两条 end**：
 *   · 写入侧不校验 ⇒ 当场无感（"落盘静默成功"）；
 *   · 加载期 `applyCompactionTransition` 对 `end` 无分支（返回 undefined），首条 end 已清空
 *     `trace.compaction`，第二条 end 即命中 dsh-compaction invariant 的
 *     `compaction/end has no matching compaction/start` ⇒ 会话**永久打不开**。
 * 即"防御性断言把可恢复错误升级为不可逆损坏"——正是 1.7.0 要消灭的失败模式。
 * 修法 = `ended` 守卫：成功 end 落地后置 `true`，`catch` 内 `if (!ended)`。
 *
 * 本文件用两条**变异敏感**用例锁住它（删掉守卫必红）——把"成功 end 之后再抛"变成确定性可复现：
 *   ① `pruneIntervals`：stub host **不给 `records`** ⇒ 成功 end 之后的
 *      `pushBounded(host.records, …)` 必抛（`undefined.push`）；
 *   ② `flushEntry`：见 `test/peratom-flush-reload.test.ts` ①c（传 `Object.freeze(record)`，
 *      成功 end 之后的第一条记账语句必抛）——两处同一条不变量，分文件复用以复用其会话构建器。
 * 两例均断言：`start === 1 && end === 1`，**且保留的那条 end 不带 error**——证明它是成功路径
 * 落的那条，而非 catch 补的（守卫被删 ⇒ end 变 2 变红；成功 end 压根没落到 ⇒ error 存在，同样红）。
 *
 * 反向对照（防守卫过度收紧）：本文件 ② 覆盖"throw 发生在成功 end **之前**"⇒ 必须补一条带
 * error 的 end（`peratom-flush-reload.test.ts` ①b 同款）。删成"catch 永不补 end"会让此例变红。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { pruneIntervals } from '../src/prune-tx.ts'
import type { PruneTxHost } from '../src/prune-tx.ts'

// ---------------------------------------------------------------------------
// stub host + 可剪会话
// ---------------------------------------------------------------------------

/**
 * stub host：只含 `pruneIntervals` 实际读取的成员（`log` / `prunedNodeIndex` /
 * `compactSourceCommandId` / `charsPerToken` / `telemetryCap` / `recallCharsUsed` /
 * `lastRealPromptTokens` / `lastRealAnchorSeq`）。
 *
 * **故意不给 `records`**：事务成功 end 之后的 `pushBounded(host.records, …)` 因此必然
 * 抛 `TypeError`——这就是把"成功 end 之后再抛"变成确定性用例的注入点。
 */
function makeStubHost(): PruneTxHost {
  return {
    log: { info: () => {}, warn: () => {}, error: () => {} },
    prunedNodeIndex: new Map(),
    compactSourceCommandId: undefined,
    charsPerToken: 4,
    telemetryCap: 10,
    recallCharsUsed: 0,
    lastRealPromptTokens: 0,
    lastRealAnchorSeq: -1,
    // 接口要求但本函数不读取的成员（bindSession/atomize/tombstoneMergeMinRun 等属其他方法）。
    bindSession: () => {},
    atomize: () => [],
    tombstoneMergeMinRun: 8,
    recencyGuard: 0,
    turnGuard: 0,
  } as unknown as PruneTxHost
}

/** 一个只有两条 user/message 的极小可剪会话：surface = [u1, u2]（无 system 头，故 startIdx=0 不触发受保护头判定）。 */
function buildPrunableSession(id: string): { session: Session; seqs: number[] } {
  const session = Session.create(SessionId(id))
  session.append('turn/start', { turn: 1 })
  const seqs: number[] = []
  for (const text of ['u1:' + 'x'.repeat(400), 'u2:' + 'y'.repeat(400)]) {
    const ev = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    seqs.push(ev.seq)
  }
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } } as never)
  return { session, seqs }
}

/** 读事件流的 `compaction/start` / `compaction/end` 计数与最后一条 end。 */
function bracketCounts(session: Session): { starts: number; ends: number; endData: { error?: string } | undefined } {
  const events = session.snapshotEvents()
  const kinds = events.map(e => e.type)
  const endIdx = kinds.lastIndexOf('compaction/end')
  return {
    starts: kinds.filter(t => t === 'compaction/start').length,
    ends: kinds.filter(t => t === 'compaction/end').length,
    endData: endIdx < 0 ? undefined : (events[endIdx] as unknown as { data: { error?: string } }).data,
  }
}

// ---------------------------------------------------------------------------
// ① 成功 end 之后再抛 ⇒ 不得补第二条 end（守卫回归锁）
// ---------------------------------------------------------------------------

test('① pruneIntervals：成功 end 之后的语句抛出 ⇒ 恰好一条 end，且不带 error（ended 守卫；旧实现为 2）', () => {
  const { session, seqs } = buildPrunableSession('tx-brackets-graph-after-end')
  const host = makeStubHost()
  const intervals = [{ seqs, chars: 800, atoms: [] }]

  assert.throws(
    () => pruneIntervals(host, session, intervals, 0, intervals.length, false),
    '成功 end 之后的 pushBounded(host.records = undefined) 必须抛出（本用例的注入点）',
  )

  const { starts, ends, endData } = bracketCounts(session)
  assert.equal(starts, 1, '恰一条 compaction/start')
  assert.equal(ends, 1, '恰一条 compaction/end（ended 守卫；旧实现 catch 无条件再补一条 ⇒ 2 条 ⇒ 重启永不匹配）')
  assert.equal(endData?.error, undefined, '保留的 end 必须是成功路径那条（不带 error），不是 catch 补的')
})

// ---------------------------------------------------------------------------
// ② 反向对照：成功 end 之前抛 ⇒ 必须补一条带 error 的 end（防守卫过度收紧）
// ---------------------------------------------------------------------------

test('② pruneIntervals：成功 end 之前 throw ⇒ 仍须补一条带 error 的 end（未配对 start 不留白）', () => {
  const { session, seqs } = buildPrunableSession('tx-brackets-graph-before-end')
  const host = makeStubHost()
  // 故意把区间首 seq 指向一个**不在 surface** 的 seq（turn/start 的 seq=0，非 surface 事件）
  // ⇒ 防御自检在成功 end 之前 throw。
  const intervals = [{ seqs: [0, ...seqs], chars: 800, atoms: [] }]

  assert.throws(
    () => pruneIntervals(host, session, intervals, 0, intervals.length, false),
    /not a valid current surface span/,
    '无效区间必须 throw',
  )

  const { starts, ends, endData } = bracketCounts(session)
  assert.equal(starts, 1, '恰一条 compaction/start')
  assert.equal(ends, 1, '恰一条 compaction/end（catch 必须关掉未配对的 start）')
  assert.ok(typeof endData?.error === 'string' && endData.error.length > 0, 'catch 落的 end 必须带 error 说明')
})
