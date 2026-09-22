/**
 * 上下文形态门控（`source.form`）专项（v1.6.1）。
 *
 * 背景（2026-09-23 实战语料实证，session-53e3e89f）：子代理的成果汇报在主流里以
 * `user/message` 落地，source 是 dsh-agent 的 **merge 扩展 kind**（`agent-message` /
 * `subagent-settled`）——它们**不等于 `'plugin'`**，因此逃过了既有的「插件注入」判据，
 * 被当成普通长用户消息送进逐原子压缩。但实测这两类是**已浓缩过一次的产物**
 * （行重复率 0%、承重 token 密度 0.1–1.5%、本身是 10–20× 提炼结果），压缩只会造成
 * 二次损失 ⇒ 按 `source.form`（性质轴，与来源轴正交）把它们挡在 Stage-1 之外，
 * 交给 Stage-2 图剪（全留或全删 + 墓碑 + recall）处理。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { PeratomCompressor } from '../src/peratom/compressor.ts'
import { DEFAULT_SKIP_CONTEXT_FORMS } from '../src/constants.ts'

const LONG = '帮我修复这个报错，服务起不来了，先看日志再给出修复步骤：\n'
  + 'Error: listen EADDRINUSE :::3000\n    at Server.setupListenListen (node:net:1917:16)\n'.repeat(4)

/** 追加一条带自定义 source 的 user/message（扁平形态，与实测存档一致）。 */
function appendUserWithSource(session: Session, text: string, source: Record<string, unknown>): number {
  const msg = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
  session.append('user/message', { ...msg, source } as never, { surfaceOp: 'append' })
  return session.snapshotEvents().length - 1
}

/**
 * 单轮会话：turn/start → 【锚】一条普通长 user + 一条带 source 的长 user → turn/end。
 *
 * 带锚的原因：若一轮里只有被门控排除的那条，`collectFromWindow` 因窗口为空而返回
 * `null`（而非空候选），断言 `userLong.length === 0` 会拿到 undefined、无法区分
 * 「被精确排除」与「整轮没材料」。加一条普通 user 做锚 ⇒ 能断言「收到 1 条、正是锚」，
 * 即门控是**选择性**的。
 */
function buildTurn(session: Session, source: Record<string, unknown>, withAnchor = true): void {
  session.append('turn/start', { turn: 1 })
  if (withAnchor) appendUserWithSource(session, LONG, { kind: 'user' })
  appendUserWithSource(session, LONG, source)
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } } as never)
}

function makeCompressor(ctx: Context, config: Record<string, unknown> = {}): PeratomCompressor {
  return new PeratomCompressor(ctx, {
    endpoint: 'http://fake.test/v1/chat/completions',
    apiKey: 'test-key',
    model: 'test-model',
    ...config,
  })
}

test('form=relay（子代理主动汇报）不进逐原子压缩候选', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  const c = makeCompressor(ctx)
  const session = Session.create(SessionId('cfg-relay'))
  buildTurn(session, { kind: 'agent-message', form: 'relay', senderSessionId: 'child-1' })

  const collect = c.collectCurrentTurn(session)
  assert.equal(collect?.interrupted, false)
  assert.equal(collect?.userLong.length, 1, '只收到锚；relay 被门控排除（已浓缩产物，交给图剪）')
})

test('form=notice（子代理结算通知）不进候选；kind=plugin 仍按来源轴排除', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  const c = makeCompressor(ctx)

  const s1 = Session.create(SessionId('cfg-notice'))
  buildTurn(s1, { kind: 'subagent-settled', form: 'notice' })
  assert.equal(c.collectCurrentTurn(s1)?.userLong.length, 1, '只收到锚；notice 被门控排除')

  const s2 = Session.create(SessionId('cfg-plugin'))
  buildTurn(s2, { kind: 'plugin', plugin: 'tool-jobs', form: 'notice' })
  assert.equal(c.collectCurrentTurn(s2)?.userLong.length, 1, '只收到锚；plugin 仍被来源轴排除（既有行为）')
})

test('对照：不带 form 的普通长 user 仍进候选（门控只按性质，不误伤）', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  const c = makeCompressor(ctx)
  for (const source of [{ kind: 'user' }, { kind: 'agent-message' }, { kind: 'goal' }]) {
    const session = Session.create(SessionId(`cfg-plain-${String(source.kind)}`))
    buildTurn(session, source, false) // 不加锚：单独一条，收到 1 即证明未被排除
    assert.equal(c.collectCurrentTurn(session)?.userLong.length, 1, `kind=${String(source.kind)} 无 form ⇒ 仍是材料`)
  }
})

test('逃生阀：skipContextForms 传空数组 ⇒ 关闭门控，退回 v1.6.0 行为', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  const off = makeCompressor(ctx, { skipContextForms: [] })
  const on = makeCompressor(ctx)
  const s1 = Session.create(SessionId('cfg-off'))
  buildTurn(s1, { kind: 'agent-message', form: 'relay', senderSessionId: 'child-1' })
  const s2 = Session.create(SessionId('cfg-on'))
  buildTurn(s2, { kind: 'agent-message', form: 'relay', senderSessionId: 'child-2' })
  assert.equal(off.collectCurrentTurn(s1)?.userLong.length, 2, '空数组 = 不排除任何形态（锚 + relay）')
  assert.equal(on.collectCurrentTurn(s2)?.userLong.length, 1, '同构造在默认档下只收到锚 ⇒ 门控确实生效')
})

test('生产默认 = DEFAULT_SKIP_CONTEXT_FORMS（relay/notice）', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  assert.deepEqual([...makeCompressor(ctx).skipContextForms], [...DEFAULT_SKIP_CONTEXT_FORMS])
  assert.deepEqual([...DEFAULT_SKIP_CONTEXT_FORMS], ['relay', 'notice'])
})
