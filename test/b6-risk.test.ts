/**
 * Issue4 回归锁（design-2.1.0-batch §2）：B-6 盲区风险摘要 + 状态卡风险行。
 * 正控=不可剪面过线 ⇒ 有提示；负控一=占用在线下 ⇒ 无提示；负控二=大量可剪 R
 * 面（正常压缩场景）⇒ 无提示（外评验收「触发条件下状态卡可见提示；负控不误报」）。
 * 变异映射：摘 b6RiskSummary 的 warn 判定 → 正控红；摘 R 排除分支（可剪当不可剪）→ 负控二红；
 * 摘 declared≤0 早退 → declaredWindow 未知负控红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ArgpEngine } from '../src/argp-engine.ts'
import { renderArgpStatus, type ArgpStatusHost } from '../src/argp-command.ts'

async function bootFactor(): Promise<{ ctx: Context; engine: ArgpEngine }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: 'b6 persona' } })
  await ctx.plugin(ArgpEngine, { engine: 'factor', windowTokens: 100, retainTokens: 50, recencyGuard: 0 })
  return { ctx, engine: ctx.compaction as unknown as ArgpEngine }
}

function makeSession(id: string): Session {
  const session = Session.create(SessionId(id))
  session.append('system/message', { content: 'persona' } as never, { surfaceOp: 'append' })
  return session
}

function appendUser(session: Session, turn: number, text: string): void {
  session.append('user/message', { ...createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), turn } as never, { surfaceOp: 'append' })
}

function appendReadGroup(session: Session, turn: number, callId: string, resultText: string): void {
  session.append('assistant/message', {
    stream: [], turn, step: 1,
    message: { source: { provider: 'test', model: 'test' }, content: [{ type: 'tool-call', id: callId, name: 'read', arguments: '{}' }] },
  } as never, { surfaceOp: 'append' })
  session.append('tool/call', { turn, callId, name: 'read', arguments: '{}' } as never)
  session.append('tool/result', {
    turn, step: 1,
    message: {
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: resultText }], isError: false }],
      source: { kind: 'tool', callId },
      id: 'm_' + callId,
    },
  } as never, { surfaceOp: 'append' })
}

/** 声明窗=宿主 request/context 事件（同 egress 测试的桥接法）。 */
function bridgeDeclaredWindow(ctx: Context, session: Session, contextWindow: number): void {
  session.append('request/context', { contextWindow } as never)
  const evs = session.snapshotEvents()
  ;(ctx as unknown as { emit: (n: string, ...a: unknown[]) => void }).emit('session/event', session, evs[evs.length - 1])
}

const BIG = 'X'.repeat(3000) // 3000 chars ⇒ ceil(3000/3.5)=858 tok

test('B6 正控：不可剪 U 面 ≥0.8×声明窗 ⇒ warn=true 且读数可控', async () => {
  const { ctx, engine } = await bootFactor()
  const s = makeSession('b6-warn')
  bridgeDeclaredWindow(ctx, s, 1000) // 风险线=800 tok；U 面 858 tok
  appendUser(s, 1, BIG)
  const r = engine.b6RiskSummary(s)
  assert.equal(r.declaredWindow, 1000)
  assert.ok(r.nonPrunableTokens >= 800, `nonPrunable=${r.nonPrunableTokens} 应 ≥800`)
  assert.equal(r.warn, true)
})

test('B6 负控一：同不可剪面但声明窗宽大 ⇒ warn=false', async () => {
  const { ctx, engine } = await bootFactor()
  const s = makeSession('b6-below')
  bridgeDeclaredWindow(ctx, s, 10_000) // 线=8000 tok
  appendUser(s, 1, BIG)
  assert.equal(engine.b6RiskSummary(s).warn, false)
})

test('B6 负控二：大量可剪 R 面（正常压缩场景）不计入不可剪 ⇒ 无提示', async () => {
  const { ctx, engine } = await bootFactor()
  const s = makeSession('b6-prunable')
  bridgeDeclaredWindow(ctx, s, 1000) // 线=800 tok；若 R 被误计=不可剪，必误报
  for (let i = 0; i < 4; i++) appendReadGroup(s, 1 + i, 'c' + i, BIG) // 4×3000 chars 全可剪
  const r = engine.b6RiskSummary(s)
  assert.ok(r.nonPrunableTokens < 800, `可剪 R 被误计入不可剪：${r.nonPrunableTokens}`)
  assert.equal(r.warn, false)
})

test('B6 声明窗未知 ⇒ 零告警（宁缺勿错，交 400 兜底网口径）', async () => {
  const { ctx, engine } = await bootFactor()
  const s = makeSession('b6-undeclared')
  appendUser(s, 1, BIG)
  const r = engine.b6RiskSummary(s)
  assert.deepEqual(r, { declaredWindow: 0, nonPrunableTokens: 0, ratioPct: 0, warn: false })
})

test('B6 状态卡：正控有「B-6 盲区」行、负控二无（zh 渲染）', async () => {
  const { ctx, engine } = await bootFactor()
  const warnS = makeSession('b6-card-warn')
  bridgeDeclaredWindow(ctx, warnS, 1000)
  appendUser(warnS, 1, BIG)
  const okS = makeSession('b6-card-ok')
  bridgeDeclaredWindow(ctx, okS, 1000)
  for (let i = 0; i < 4; i++) appendReadGroup(okS, 1 + i, 'c' + i, BIG)
  const host = engine as unknown as ArgpStatusHost
  const textOf = (r: ReturnType<typeof renderArgpStatus>): string =>
    r.kind === 'success' ? String(r.text ?? '') : JSON.stringify(r)
  const warnText = textOf(renderArgpStatus(host, { agent: { session: warnS } as never } as never, 'zh'))
  assert.ok(warnText.includes('B-6 盲区'), `正控卡面应含盲区行：\n${warnText}`)
  const okText = textOf(renderArgpStatus(host, { agent: { session: okS } as never } as never, 'zh'))
  assert.ok(!okText.includes('B-6 盲区'), `负控卡面不应有盲区行：\n${okText}`)
})
