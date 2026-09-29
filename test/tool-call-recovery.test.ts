/**
 * 宿主 0.2.0-rc.1 `ToolCallRecovery` 消账语义契约回归（跑宿主**真实**函数，不复刻其逻辑）。
 *
 * ## 背景
 * 0.2.0-rc.1 重构 `dsh-session/repair.ts` 并新增 `ToolCallRecovery`，把 `tool/result` 的
 * **消账条件**从「按 callId 无条件消账」收紧为「必须 `surfaceOp === 'append'` 且 turn/step
 * 相等」。宿主把该语义**写死成测试**（`packages/core/session/tests/repair.spec.ts:178`
 * `does NOT synthesize a result for a tool-call that already has one`）。
 *
 * 而 dsh-argp 的 per-atom 压缩会以 **replace** 形态重写 `tool/result`（复用原 callId），
 * 正是这条收紧判据的靶心 —— 所以必须显式锁住。
 *
 * ## 本测试证明什么
 * ① **argp 真实产物形态**（原始 append 应答在 append-only 日志中 + argp 的 replace 压缩副
 *    本）⇒ 宿主**不会**补结果。机制：`ToolCallRecovery.observe` 扫的是**事件日志**（非
 *    surface）且只认 `surfaceOp === 'append'`，原始 append 已消账，replace 副本不被误判；
 * ② **判别力对照**：取**同一条**日志，唯一变量＝把该 tool/result 的 `surfaceOp` 由 `append`
 *    改成 `replace` ⇒ 宿主**立刻**补一条 ⇒ 证明 ① 不是恒绿的假阳性。
 *
 * ① 若失败 ⇒ 每次压缩后重启都会给**已应答**的 tool-call 补一条 error 结果 ⇒ 双份
 * `role:'tool'` 消息 ⇒ provider 400 / 会话不可用。
 *
 * 另注：宿主 `assertToolResultRewrite`（`dsh-session/lib/index.js`）对 `tool/result` 的
 * surface replace 强制两条纪律 —— **必须目标是当前 tool/result**、**除 `message.content`
 * 外全字段逐字相同**。这解释了为何「只有 replace 形态、无 append 前身」在宿主校验下
 * 不可达：replace 必须有一个 append 前身，而那个前身写入时即已消账。
 *
 * ## 覆盖边界（诚实披露）
 * 本文件锁的是**宿主判据侧**：argp 的产物形态（replace + 复用 callId + 只改 content）按
 * `src/peratom/flush.ts` / `src/prune-tx.ts` 的产物纪律**建模构造**，而非跑真实 flush 产出。
 * 事件顺序与形态的端到端覆盖在 `test/peratom-flush-reload.test.ts`（三层测试 + 变异实测）。
 * 若要端到端锁「argp 真实压缩产物 → interruptedTurnClosers 不补」，需在该文件的 stub host
 * 上续一条用例。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Session, SessionId, interruptedTurnClosers } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { ToolCallId, createAssistantMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { asSeq, asSeqs } from '../src/log-access.ts'

const CALL_ID = 'call-argp-tool-recovery'

function makeSession(id: string): Session {
  const session = Session.create(SessionId(`argp-tool-recovery-${id}`))
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 } as never)
  return session
}

/** assistant 带 tool-call ⇒ `ToolCallRecovery` 的 pending 登记点。 */
function appendToolCallAssistant(session: Session, turn: number, step: number): void {
  session.append('assistant/message', {
    stream: [],
    turn,
    step,
    message: createAssistantMessage({
      source: { provider: 'test', model: 'test' },
      content: [{ type: 'tool-call', id: ToolCallId(CALL_ID) as never, name: 'bash', arguments: '{}' }],
    }),
  }, { surfaceOp: 'append' })
}

/** 原始应答（**append** 形态）—— 宿主消账的唯一合法形态。返回其 seq。 */
function appendToolResultAppend(session: Session, turn: number, step: number, text: string): number {
  const seq = session.snapshotEvents().length
  session.append('tool/result', {
    turn,
    step,
    message: createToolResultMessage({
      callId: ToolCallId(CALL_ID) as never,
      content: [{ type: 'text', text }],
      isError: false,
    }),
  }, { surfaceOp: 'append' })
  return seq
}

/**
 * argp per-atom 压缩副本（**replace** 形态，复用同 callId 覆盖原 seq 区间）。
 * 严格复刻 argp 产物纪律：除 `message.content` 外**全字段逐字复制原事件**
 * （宿主 `assertToolResultRewrite` 强制 "may change only content"，违反即 throw）。
 */
function appendToolResultReplace(session: Session, seq: number, text: string): void {
  const orig = session.snapshotEvents()[seq] as SessionEvent<'tool/result'>
  session.append('tool/result', {
    ...orig.data,
    message: { ...orig.data.message, content: [{ type: 'text', text }] },
  } as never, {
    surfaceOp: { op: 'replace', startSeq: asSeq(seq), endSeq: asSeq(seq) },
    sourceEventSeqs: asSeqs([seq]),
  })
}

test('argp replace 形态的 tool/result 不会让宿主误判未应答（跑宿主真实 interruptedTurnClosers）', () => {
  const session = makeSession('replace')
  appendToolCallAssistant(session, 1, 1)
  const rSeq = appendToolResultAppend(session, 1, 1, 'ok: real tool output')
  // argp per-atom 压缩：以 replace 形态重写该 tool/result（复用同 callId + 覆盖原 seq）
  appendToolResultReplace(session, rSeq, `[已压缩-摘取 seq=${rSeq}] ok: real tool output`)
  // 日志在此中断（turn 未闭合）—— 模拟崩溃恢复的扫描入口

  const closers = interruptedTurnClosers(session.snapshotEvents())
  const synthesized = closers.filter(e => e.type === 'tool/result')
  assert.equal(
    synthesized.length, 0,
    'append 原始已消账 ⇒ 不得补结果（补了就会双份 role:tool ⇒ provider 400）',
  )
  assert.ok(closers.some(e => e.type === 'turn/end'), '未闭合 turn 仍应被闭合')
})

test('判别力对照：同一条日志，仅把 surfaceOp 由 append 改成 replace ⇒ 宿主立刻补结果', () => {
  const session = makeSession('replace-only')
  appendToolCallAssistant(session, 1, 1)
  appendToolResultAppend(session, 1, 1, 'ok: real tool output')

  const raw = session.snapshotEvents()
  const lastIdx = raw.length - 1
  const lastSeq = raw[lastIdx]!.seq
  // 唯一变量：该 tool/result 的写入形态由 append 改为 replace，其余字段逐字不变
  const events = raw.map((e, i) => (i === lastIdx
    ? { ...e, surfaceOp: { op: 'replace', startSeq: lastSeq, endSeq: lastSeq } }
    : e)) as unknown as readonly SessionEvent[]

  const closers = interruptedTurnClosers(events)
  const synthesized = closers.filter(e => e.type === 'tool/result')
  assert.equal(
    synthesized.length, 1,
    'replace 形态**不**消账（0.2.0-rc.1 判据）⇒ 证明上例的 0 不是恒真',
  )
})
