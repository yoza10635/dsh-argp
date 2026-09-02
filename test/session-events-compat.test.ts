/**
 * 跨宿主事件日志兼容回归测试：锁定 `sessionEvents()` 的双分支 dispatch。
 *
 * 背景：dsh 0.1.2-alpha.4 的 breaking 重构 `27bf1039db refactor(session)!`
 * 移除了 `Session.events` getter（运行时 undefined），替代为 `snapshotEvents()`。
 * rc.2 仍有 `events` getter。`sessionEvents()`（src/log-access.ts）是 ARGP 全代码库
 * 唯一允许触碰事件日志的入口——46 处调用点都经由它。本测试把三条 dispatch 路径
 * 固化进 CI，任何宿主升级（新增/移除事件 API）都会在这里炸响：
 *
 *   1) modern 分支：宿主提供 `snapshotEvents` → 调它（且 `this` 绑定必须正确）
 *   2) modern 优先：两个 API 同时存在时必须走 `snapshotEvents`（防未来宿主
 *      保留 `events` 别名时静默走错分支）
 *   3) legacy 分支：无 `snapshotEvents` → 回退 `events` getter（rc.2 真 Session 实证）
 *   4) 两者皆无 → throw（明确的版本不兼容报错，而非 undefined 级联崩溃）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { sessionEvents } from '../src/log-access.ts'

test('sessionEvents: modern 分支调用 snapshotEvents 且 this 绑定正确', () => {
  // mock alpha.4 形态宿主：snapshotEvents 从 this 私有日志读快照——
  // 若 helper 用现代方法调用（modern()）而非 modern.call(session)，this 会丢失并抛错。
  const log = [
    { type: 'turn/start' as const, data: { turn: 1 } },
    { type: 'user/message' as const, data: { text: 'hello' } },
  ]
  let thisArg: unknown = null
  const modernSession = {
    _log: log,
    snapshotEvents(this: { _log: readonly { type: string; data: unknown }[] }) {
      thisArg = this
      if (!this._log) throw new Error('this binding lost: helper must call snapshotEvents.call(session)')
      return Object.freeze([...this._log]) as readonly { type: string; data: unknown }[]
    },
  } as unknown as Session
  const events = sessionEvents(modernSession)
  assert.equal(events.length, 2)
  assert.equal(events[0].type, 'turn/start')
  assert.equal(thisArg, modernSession, 'snapshotEvents must be invoked with the session as this')
  assert.ok(Object.isFrozen(events), 'modern path must return a frozen snapshot')
})

test('sessionEvents: 两 API 并存时 modern 分支优先（防 legacy 别名静默接管）', () => {
  const modernSession = {
    snapshotEvents() { return Object.freeze(['modern']) },
    events: Object.freeze(['legacy']) as never,
  } as unknown as Session
  const events = sessionEvents(modernSession)
  assert.deepEqual([...events], ['modern'], 'snapshotEvents must win when both APIs exist')
})

test('sessionEvents: legacy 分支回退 events getter（rc.2 真 Session 实证）', () => {
  // 测试环境装的是 rc.2（peer pin 0.1.1-rc.2）——真 Session 没有 snapshotEvents，
  // helper 必须走 events getter 且语义与 session.seq 对齐。
  const session = Session.create(SessionId('session-events-compat'))
  assert.equal(typeof (session as { snapshotEvents?: unknown }).snapshotEvents, 'undefined',
    'precondition: rc.2 Session exposes no snapshotEvents')
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'who ate the cookie?' }], source: { kind: 'user' } }), { surfaceOp: 'append' })

  const events = sessionEvents(session)
  assert.equal(events.length, session.seq, 'legacy path length must equal session.seq')
  assert.equal(events[0].type, 'turn/start')
  assert.ok(Object.isFrozen(events), 'rc.2 events getter returns a frozen snapshot')

  // 快照语义：后续 append 不得增长已返回的数组（与 modern 分支契约一致）
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'and the milk?' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  assert.equal(events.length, 2, 'returned snapshot must not grow on later append')
  assert.equal(session.seq, 3, 'session.seq reflects the new append')
})

test('sessionEvents: 两 API 皆无 → throw 明确的版本兼容错误', () => {
  const orphan = {} as unknown as Session
  assert.throws(
    () => sessionEvents(orphan),
    /neither events nor snapshotEvents/,
    'must fail loudly with an actionable version-compatibility error, not cascade from undefined',
  )
})
