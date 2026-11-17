/**
 * 焦点尾窗降级回归锁（2026-11-13 用户裁定）：
 *  - 最新轮 A/R 占比 ≥50% 且该轮协议组 >10 ⇒ 焦点从整轮收窄为最新 10 组；
 *  - 正常轮（占比 <50% 或组数 ≤10）零行为变化（整轮焦点）；
 *  - 降级后最老的 2 组 A+R 可整组驱逐，最新 10 组保留；
 *  - open turn 内同样只保焦点 10 组（open 硬保护同步收窄）。
 *
 * 变异锁：摘 focusEscalated 条件 / 摘 cap / 摘 planProtocolGroups focusSeqs 判据 ⇒ 红。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ArgpEngine } from '../src/argp-engine.ts'
import { FactorEngine, planFocusTail, type FactorEngineHost } from '../src/factor/engine.ts'
import { eventText, sessionEvents } from '../src/log-access.ts'

async function makeFactor(): Promise<{ host: FactorEngineHost; factor: FactorEngine }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: 'focus tail persona' } })
  await ctx.plugin(ArgpEngine, { windowTokens: 100, retainTokens: 50, recencyGuard: 0, maxPasses: 8 })
  const host = ctx.compaction as unknown as FactorEngineHost
  return { host, factor: new FactorEngine(host) }
}

function makeSession(id: string): Session {
  const session = Session.create(SessionId(id))
  session.append('system/message', { content: 'persona' } as never, { surfaceOp: 'append' })
  return session
}

function appendUser(session: Session, turn: number, text: string): void {
  session.append('user/message', { ...createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), turn } as never, { surfaceOp: 'append' })
}

function appendGroup(session: Session, turn: number, callId: string, filePath: string, resultText: string): void {
  session.append('assistant/message', {
    stream: [], turn, step: 1,
    message: createAssistantMessage({
      source: { provider: 'test', model: 'test' },
      content: [{ type: 'text', text: 'doing read' }, { type: 'tool-call', id: callId, name: 'read', arguments: JSON.stringify({ file_path: filePath }) } as never],
    }),
  } as never, { surfaceOp: 'append' })
  session.append('tool/call', { turn, callId, name: 'read', arguments: JSON.stringify({ file_path: filePath }) } as never)
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

function buildGroups(session: Session, turn: number, n: number, prefix = 'g'): void {
  for (let i = 0; i < n; i += 1) {
    appendGroup(session, turn, 'c' + i, 'C:/Proj/' + prefix + i + '.ts', prefix.toUpperCase() + i + '-' + 'x'.repeat(200))
  }
}

function surfaceDump(session: Session): string {
  const evs = sessionEvents(session) as unknown as Array<{ seq: number }>
  return [...session.surface.nodes].map(s => JSON.stringify(evs[s as number])).join('\n')
}

function seqOfR(decision: ReturnType<FactorEngine['decide']>, callId: string): number {
  const hit = [...decision.candidates.entries()].find(([, x]) => x.callId === callId)
  assert.ok(hit !== undefined, 'missing R ' + callId)
  return hit[0]
}

test('FT1 最新轮 12 组/占比 100% ⇒ 尾窗降级：最老 2 组可剪，最新 10 组硬保', async () => {
  const { host, factor } = await makeFactor()
  const session = makeSession('focus-ft1')
  host.bindSession(session)
  appendUser(session, 1, '开始任务')
  buildGroups(session, 1, 12)

  const d = factor.decide(session, 1_000_000)
  assert.equal(d.focusEscalated, true, '12 组 × 100% 占比必须降级')
  assert.equal(d.focusGroupCount, 12)
  assert.equal(d.latestTurnShare, 1)
  assert.ok(d.focusSeqs.size >= 20, '焦点集含 10 组 A+全部 live R')

  // 最老 2 组入剪序；最新 10 组 R 在硬保护（不可入剪序）。
  assert.ok(d.plan.pruneOrder.includes(seqOfR(d, 'c0')))
  assert.ok(d.plan.pruneOrder.includes(seqOfR(d, 'c1')))
  assert.ok(d.plan.hardProtected.includes(seqOfR(d, 'c11')))
  assert.ok(!d.plan.pruneOrder.includes(seqOfR(d, 'c11')))
  assert.ok(d.plan.hardProtected.includes(seqOfR(d, 'c2')), '第 3 组起是最新 10 组之一')
})

test('FT2 open turn 同样收窄：焦点外旧组可组剪，最新 10 组留守', async () => {
  const { host, factor } = await makeFactor()
  const session = makeSession('focus-ft2')
  host.bindSession(session)
  appendUser(session, 1, '开始任务')
  session.append('turn/start', { turn: 1 })
  buildGroups(session, 1, 12)

  const d = factor.decide(session, 1_000_000)
  assert.equal(d.focusEscalated, true)
  assert.ok(d.plan.pruneOrder.includes(seqOfR(d, 'c0')), 'open 轮焦点外 R 必须可剪（open 硬保护收窄）')
  assert.ok(d.plan.pruneOrder.includes(seqOfR(d, 'c1')))
  assert.ok(!d.plan.pruneOrder.includes(seqOfR(d, 'c11')))

  const result = factor.compactIfNeeded(session, 1_000_000)
  assert.ok(result !== null)
  const dump = surfaceDump(session)
  assert.ok(!dump.includes('C:/Proj/g0.ts') && !dump.includes('C:/Proj/g1.ts'), '最老 2 组 A+R 离场')
  assert.ok(dump.includes('C:/Proj/g2.ts') && dump.includes('C:/Proj/g11.ts'), '最新 10 组保留')
})

test('FT3 正常轮 ≤10 组：不降级，整轮焦点（零行为变化）', async () => {
  const { host, factor } = await makeFactor()
  const session = makeSession('focus-ft3')
  host.bindSession(session)
  appendUser(session, 1, '开始任务')
  buildGroups(session, 1, 5)
  const d = factor.decide(session, 1_000_000)
  assert.equal(d.focusEscalated, false)
  assert.equal(d.focusSeqs.size, 0)
  assert.equal(d.plan.pruneOrder.length, 0, '整轮焦点 ⇒ 无可剪 R（仅 5 组）')
  assert.equal(factor.compactIfNeeded(session, 1_000_000), null, '不发射')
})

test('FT4 占比 <50%：即使 12 组也不降级（整轮焦点保留）', async () => {
  const { host, factor } = await makeFactor()
  const session = makeSession('focus-ft4')
  host.bindSession(session)
  appendUser(session, 1, '开始任务')
  // turn1 一枚超大 R 占绝对多数；turn2 12 个小组成不了 50%。
  appendGroup(session, 1, 'huge', 'C:/Proj/huge.ts', 'HUGE'.repeat(25_000))
  appendUser(session, 2, '继续')
  buildGroups(session, 2, 12)
  const d = factor.decide(session, 1_000_000)
  assert.ok(d.latestTurnShare < 0.5, '读数须 <50%')
  assert.equal(d.focusEscalated, false)
  assert.ok(d.plan.pruneOrder.length >= 1)
  assert.equal(d.plan.pruneOrder[0], seqOfR(d, 'huge'), '可剪的是旧大 R')
  assert.ok(d.plan.hardProtected.includes(seqOfR(d, 'c0')), 'turn2 全部 12 组仍按整轮焦点硬保')
})

test('FT5 planFocusTail 纯函数：cap/share/焦点闭包读数', async () => {
  const { host } = await makeFactor()
  const session = makeSession('focus-ft5')
  appendUser(session, 1, '开始任务')
  buildGroups(session, 1, 12)
  const atoms = host.atomize(session)
  const surface = [...session.surface.nodes] as unknown as number[]
  const plan = planFocusTail(atoms, surface, { protectFromTurn: 1, cap: 10, latestTurn: 1, shareThreshold: 0.5 })
  assert.equal(plan.escalated, true)
  assert.equal(plan.latestTurnGroupCount, 12)
  assert.equal(plan.groupCount, 12)
  assert.equal(plan.latestTurnShare, 1)
  // 焦点集 = 最新 10 组 A + R；最老 2 组 A 不在集合。
  const aSeqs = atoms.filter(a => a.type === 'A').map(a => a.seq).sort((a, b) => a - b)
  assert.equal(plan.focusSeqs.has(aSeqs[0]!), false)
  assert.equal(plan.focusSeqs.has(aSeqs[1]!), false)
  assert.equal(plan.focusSeqs.has(aSeqs[2]!), true)
  assert.equal(plan.focusSeqs.has(aSeqs[11]!), true)
})

test('FT6 降级后焦点外旧组整组（A args + R 原文）离场，词表检查点计 2 枚', async () => {
  const { host, factor } = await makeFactor()
  const session = makeSession('focus-ft6')
  host.bindSession(session)
  appendUser(session, 1, '开始任务')
  buildGroups(session, 1, 12)
  assert.ok(factor.compactIfNeeded(session, 1_000_000) !== null)
  const dump = surfaceDump(session)
  assert.ok(!dump.includes('C:/Proj/g0.ts') && !dump.includes('G0-'), 'g0 组 A/R 双双离场')
  assert.ok(!dump.includes('C:/Proj/g1.ts') && !dump.includes('G1-'), 'g1 组 A/R 双双离场')
  assert.ok(dump.includes('C:/Proj/g2.ts') && dump.includes('G2-'), 'g2 保留')
  assert.ok(dump.includes('C:/Proj/g11.ts') && dump.includes('G11-'), 'g11 保留')
  const evs = sessionEvents(session) as unknown as Array<{ seq: number; type: string; data?: unknown }>
  const checkpoints = [...session.surface.nodes].filter(s => evs[s as number]?.type === 'user/message'
    && JSON.stringify(evs[s as number]?.data).includes('已压缩剪枝次要原子'))
  assert.equal(checkpoints.length, 2, '两组各一枚压缩检查点')
})
