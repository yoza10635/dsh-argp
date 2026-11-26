/**
 * 焦点尾窗降级回归锁（2026-11-13 用户裁定）：
 *  - 最新轮 A/R 占比 ≥50% 且该轮协议组 >10 ⇒ 焦点从整轮收窄为最新 10 组；
 *  - 正常轮（占比 <50% 或组数 ≤10）零行为变化（整轮焦点）；
 *  - 降级后最老的 2 组 A+R 可整组驱逐，最新 10 组保留；
 *  - open turn 内同样只保焦点 10 组（open 硬保护同步收窄）。
 *
 * 2.2.1 包二（A1 焦点名额，FT7–FT13）：非升级态下焦点区按名额保护——
 *  - 名额 = min(20, ⌊δ·W_eff·cpt / 组均字节⌋)，下限 1；窗未知回退 20（FT9）；
 *  - 超名额的**旧侧**组只有全组 R 被 superseded 判死才整组降级离场（FT7 绿/FT8 红）；
 *  - barrier/附件组豁免不占名额（FT11）；open 区组不入降级带（FT12）；
 *  - 畸形 turn/start（号不可读）按 -1 哨兵全区当 open，降级带清零（FT13 fail-closed）；
 *  - 升级态走原 cap 路径，降级带恒空（FT10；FT1–FT6 即升级态字节锁）。
 *
 * 变异锁：摘 focusEscalated 条件 / 摘 cap / 摘 planProtocolGroups focusSeqs 判据 ⇒ 红；
 * 摘 demotedGroups 计算 ⇒ FT7/FT9/FT11 红；摘 decide 事实门（按位置整带降级）⇒ FT8 红；
 * 摘附件豁免 ⇒ FT11 红；摘 open 排除 ⇒ FT12 红；摘 demotedSeqs 透传（发射端仍按
 * 位置门拦）⇒ FT7 红；升级态塞降级带 ⇒ FT10 红；detectOpenTurn 摘 -1 哨兵回退
 * `?? null` ⇒ FT13 红。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  const plan = planFocusTail(atoms, surface, {
    protectFromTurn: 1, cap: 10, latestTurn: 1, shareThreshold: 0.5,
    quotaGroups: 20, quotaBudgetRatio: 0.3, openTurn: null, charsPerToken: 3.5, attachmentSeqs: new Set(),
  })
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

test('FT6 降级后焦点外旧组整组（A args + R 原文）离场，相邻同文检查点归并 1 枚', async () => {
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
  assert.equal(checkpoints.length, 1, '两相邻同文检查点随事务归并为一枚（2.2.2 桩游程治理：surface 紧邻+逐字节同文 ⇒ 并条）')
})

/** 带 image 块的组（G8 配方）：tool-result content 内嵌 {type:'image'} ⇒ barrier 面。 */
function appendGroupImage(session: Session, turn: number, callId: string, filePath: string, resultText: string): void {
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
      content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: resultText }, { type: 'image' } as never], isError: false }],
      source: { kind: 'tool', callId }, id: 'm_' + callId,
    },
  } as never, { surfaceOp: 'append' })
}

function checkpointsOf(session: Session): number {
  const evs = sessionEvents(session) as unknown as Array<{ seq: number; type: string; data?: unknown }>
  return [...session.surface.nodes].filter(s => evs[s as number]?.type === 'user/message'
    && JSON.stringify(evs[s as number]?.data).includes('已压缩剪枝次要原子')).length
}

/** FT7–FT12 共用底架：turn1 超大旧组（把占比压到 <50%，堵升级态）+ turn2 焦点区组。 */
function buildQuotaScaffold(id: string): Session {
  const session = makeSession(id)
  appendUser(session, 1, '开始任务')
  appendGroup(session, 1, 'huge', 'C:/Proj/huge.ts', 'HUGE'.repeat(25_000))
  appendUser(session, 2, '继续')
  return session
}

test('FT7 名额 20/21 组边界：最老判死组整组（A+R）离场，其余 20 组硬保；[argp-quota] 影子列落日志', async () => {
  const { host, factor } = await makeFactor()
  const session = buildQuotaScaffold('quota-ft7')
  host.bindSession(session)
  buildGroups(session, 2, 20, 'a')
  // 判死证据：文末重读 a0.ts（全量覆盖全量 ⇒ supersededMarks(c0)=true）。
  appendGroup(session, 2, 'c0dup', 'C:/Proj/a0.ts', 'A0-RELOADED-' + 'y'.repeat(200))

  const quotaLogs: string[] = []
  const origInfo = host.log.info.bind(host.log)
  ;(host.log as { info: (m: string) => void }).info = (m: string): void => {
    if (m.startsWith('[argp-quota] ')) quotaLogs.push(m)
    origInfo(m)
  }
  // 影子流水落盘：台架取证只读 ARGP_FACTOR_DISPATCH_LOG，log.info 在 bench 不可见 ⇒
  // quota 记录必须与 dispatch 决策同文件落盘，否则观察哨「降级档驱逐」列失明。
  const shadowPath = join(tmpdir(), 'argp-quota-shadow-' + Date.now() + '-' + process.pid + '.jsonl')
  const prevShadowEnv = process.env['ARGP_FACTOR_DISPATCH_LOG']
  process.env['ARGP_FACTOR_DISPATCH_LOG'] = shadowPath
  try {
    const d = factor.decide(session, 1_000_000)
    assert.equal(d.focusEscalated, false, '占比 <50% ⇒ 非升级态')
    assert.equal(d.quotaUsed, 20, '窗未知（直接 decide）⇒ 名额回退固化 N=20')
    assert.equal(d.quotaBandGroups, 1, '21 可排名组超名额 1 ⇒ 带=[a0]')
    assert.equal(d.demotedGroupCount, 1, 'a0 全组 R 判死 ⇒ 事实门过')
    assert.ok(d.demotedSeqs.size === 2, '降级=整组：A+R 同进退')
    assert.ok(d.plan.pruneOrder.includes(seqOfR(d, 'c0')), '判死组 R 入剪序（焦点硬保已摘）')
    assert.ok(d.plan.hardProtected.includes(seqOfR(d, 'c1')), '名额内 a1 仍整轮焦点硬保')
    assert.ok(d.plan.hardProtected.includes(seqOfR(d, 'c0dup')), '覆盖读本身焦点硬保')

    assert.ok(factor.compactIfNeeded(session, 1_000_000) !== null)
    const dump = surfaceDump(session)
    assert.ok(!dump.includes('A0-xxxx'), 'a0 判死组 R 原文离场')
    assert.ok(dump.includes('A0-RELOADED'), '覆盖读（活体）保留')
    assert.ok(dump.includes('A1-'), '名额内组不动')
    assert.ok(dump.includes('A19-'), '名额内组不动')
    assert.equal(checkpointsOf(session), 2, 'turn1 超大旧组 + a0 降级组各一枚检查点')
  } finally {
    ;(host.log as { info: (m: string) => void }).info = origInfo
    if (prevShadowEnv === undefined) delete process.env['ARGP_FACTOR_DISPATCH_LOG']
    else process.env['ARGP_FACTOR_DISPATCH_LOG'] = prevShadowEnv
  }
  assert.equal(quotaLogs.length, 1, '[argp-quota] 影子列恰一行（发射侧）')
  const rec = JSON.parse(quotaLogs[0]!.slice('[argp-quota] '.length)) as Record<string, number | string>
  assert.deepEqual(Object.keys(rec).sort(), ['demotedGroups', 'evictedChars', 'evictedGroups', 'mode', 'quotaBandGroups', 'quotaUsed', 't'])
  assert.equal(rec.mode, 'quota')
  assert.equal(typeof rec.t, 'number')
  assert.equal(rec.quotaUsed, 20)
  assert.equal(rec.quotaBandGroups, 1)
  assert.equal(rec.demotedGroups, 1)
  assert.equal(rec.evictedGroups, 1, '组剪计划口径：降级组进组剪')
  const evictedChars = rec.evictedChars as number
  assert.ok(evictedChars > 200 && evictedChars < 500, 'chars 账 = A+R 实际文本量：实测 ' + evictedChars)
  // 影子流水文件：mode:'quota' 记录与 dispatch 决策同文件（台架可取证）
  const shadowLines = readFileSync(shadowPath, 'utf8').trim().split('\n')
  const quotaRec = JSON.parse(shadowLines.find(l => (JSON.parse(l) as { mode?: string }).mode === 'quota') ?? 'null') as Record<string, number> | null
  assert.ok(quotaRec !== null, '影子流水须含 mode:quota 行')
  assert.equal(quotaRec!.quotaBandGroups, 1)
  assert.equal(quotaRec!.demotedGroups, 1)
  assert.equal(quotaRec!.evictedGroups, 1)
  try { unlinkSync(shadowPath) } catch { /* 清理失败不影响判定 */ }
})

test('FT8 事实门红锁：超名额但未判死的组照常硬保（放宽位置门≠放宽事实门）', async () => {
  const { host, factor } = await makeFactor()
  const session = buildQuotaScaffold('quota-ft8')
  host.bindSession(session)
  buildGroups(session, 2, 21, 'a') // 无覆盖读：a0 超名额但活着

  const d = factor.decide(session, 1_000_000)
  assert.equal(d.quotaBandGroups, 1, '位置门：a0 入带')
  assert.equal(d.demotedGroupCount, 0, '事实门：无 superseded ⇒ 不降级')
  assert.equal(d.demotedSeqs.size, 0)
  assert.ok(!d.plan.pruneOrder.includes(seqOfR(d, 'c0')), 'a0 R 不进剪序')
  assert.ok(d.plan.hardProtected.includes(seqOfR(d, 'c0')))

  assert.ok(factor.compactIfNeeded(session, 1_000_000) !== null)
  const dump = surfaceDump(session)
  assert.ok(dump.includes('A0-xxxx'), 'a0 仍在面（仅 turn1 超大旧组离场）')
  assert.equal(checkpointsOf(session), 1)
})

test('FT9 名额 δ·W_eff 折算（纯函数）：窗未知回退 20、预算收缩、下限 1、窗≤0 回退', async () => {
  const { host } = await makeFactor()
  const session = buildQuotaScaffold('quota-ft9')
  buildGroups(session, 2, 20, 'a')
  appendGroup(session, 2, 'c0dup', 'C:/Proj/a0.ts', 'A0-RELOADED-' + 'y'.repeat(200))
  const atoms = host.atomize(session)
  const surface = [...session.surface.nodes] as unknown as number[]
  const base = { protectFromTurn: 2, cap: 10, latestTurn: 2, shareThreshold: 0.5,
    quotaGroups: 20, quotaBudgetRatio: 0.3, openTurn: null, charsPerToken: 3.5, attachmentSeqs: new Set<number>() }
  const rankableChars = atoms.filter(a => (a.type === 'A' || a.type === 'R') && a.turn === 2)
    .reduce((n, a) => n + a.text.length, 0)
  const avg = rankableChars / 21

  const p1 = planFocusTail(atoms, surface, { ...base })
  assert.equal(p1.escalated, false)
  assert.equal(p1.quotaUsed, 20, '窗未知 ⇒ 回退 N')
  assert.equal(p1.demotedGroups.length, 1)
  const p2 = planFocusTail(atoms, surface, { ...base, windowEffTokens: 1000 })
  assert.equal(p2.quotaUsed, Math.max(1, Math.floor(0.3 * 1000 * 3.5 / avg)), 'quota = ⌊δ·W_eff·cpt/组均字节⌋ 形态锁')
  assert.ok(p2.quotaUsed < 20 && p2.quotaUsed > 1, `预算收缩应落在 (1,20)：实测 ${p2.quotaUsed}`)
  assert.equal(p2.demotedGroups.length, 21 - p2.quotaUsed, '带 = 可排名组 − 名额（旧侧）')
  assert.equal(p2.demotedGroups[0]![0], p1.demotedGroups[0]![0], '带仍从最老组起')
  const p3 = planFocusTail(atoms, surface, { ...base, windowEffTokens: 1 })
  assert.equal(p3.quotaUsed, 1, '预算再小也保底 1 组')
  assert.equal(p3.demotedGroups.length, 20)
  const p4 = planFocusTail(atoms, surface, { ...base, windowEffTokens: 0 })
  assert.equal(p4.quotaUsed, 20, '窗 ≤0 = 未知 ⇒ 回退 N（manual 字节兼容）')
})

test('FT10 升级态共存锁：占比≥50% ∧ 组>10 ⇒ 原 cap 路径，降级带恒空', async () => {
  const { host, factor } = await makeFactor()
  const session = makeSession('quota-ft10')
  host.bindSession(session)
  appendUser(session, 1, '开始任务')
  buildGroups(session, 1, 21, 'a') // 全在最新轮 ⇒ share=1 ⇒ 升级态
  const d = factor.decide(session, 1_000_000)
  assert.equal(d.focusEscalated, true, '21 组/100% ⇒ 升级（>10 组无条件离场语义不变）')
  assert.equal(d.quotaBandGroups, 0, '升级态不产降级带（名额路径与 cap 路径互斥）')
  assert.equal(d.demotedGroupCount, 0)
  assert.equal(d.demotedSeqs.size, 0)
  assert.ok(d.plan.hardProtected.includes(seqOfR(d, 'c11')), '焦点仍=最新 10 组（cap 原语义）')
  assert.ok(d.plan.pruneOrder.includes(seqOfR(d, 'c0')))
})

test('FT11 barrier 豁免不占名额：附件组让位，判死的名额外活组照常降级离场', async () => {
  const { host, factor } = await makeFactor()
  const session = buildQuotaScaffold('quota-ft11')
  host.bindSession(session)
  // 显式造数（buildGroups 的 callId 固定 c0.. 会撞名）：k0 附件组豁免不占名额
  // ⇒ 可排名组 = c1..c20 + 文末 b1 覆盖读 = 21 ⇒ 带 = [c1]（b1 判死）。
  appendGroupImage(session, 2, 'k0', 'C:/Proj/b0.ts', 'B0-IMG-' + 'x'.repeat(200))
  for (let i = 1; i <= 20; i += 1) appendGroup(session, 2, 'c' + i, 'C:/Proj/b' + i + '.ts', 'B' + i + '-' + 'x'.repeat(200))
  appendGroup(session, 2, 'k1dup', 'C:/Proj/b1.ts', 'B1-RELOADED-' + 'y'.repeat(200))
  const d = factor.decide(session, 1_000_000)
  assert.equal(d.focusEscalated, false)
  assert.equal(d.demotedGroupCount, 1)
  assert.equal(d.quotaBandGroups, 1)
  const b0r = seqOfR(d, 'k0'); const b1r = seqOfR(d, 'c1')
  assert.equal(d.demotedSeqs.has(b0r), false, '附件组豁免：不占名额也永不入带')
  assert.equal(d.demotedSeqs.has(b1r), true, 'b1 判死且超名额 ⇒ 降级')
  assert.ok(d.plan.hardProtected.includes(b0r), '附件硬保护位独立于名额路径，照常生效')
  assert.equal(factor.compactIfNeeded(session, 1_000_000) !== null, true)
  const dump = surfaceDump(session)
  assert.ok(dump.includes('B0-IMG'), 'barrier 组留面')
  assert.ok(!dump.includes('B1-xxxx'), 'b1 判死组离场')
  assert.ok(dump.includes('B1-RELOADED'), '覆盖读保留')
  assert.ok(dump.includes('B2-'), '名额内组不动')
})

test('FT12 open 区不入带：本轮协议现场的焦点组即使超名额也不降级', async () => {
  const { host, factor } = await makeFactor()
  const session = buildQuotaScaffold('quota-ft12')
  host.bindSession(session)
  session.append('turn/start', { turn: 2 })
  buildGroups(session, 2, 21, 'a')
  appendGroup(session, 2, 'c0dup', 'C:/Proj/a0.ts', 'A0-RELOADED-' + 'y'.repeat(200))
  const d = factor.decide(session, 1_000_000)
  assert.equal(d.focusEscalated, false, '占比 <50%')
  assert.equal(d.quotaBandGroups, 0, 'open 区组全部不入带')
  assert.equal(d.demotedGroupCount, 0)
  assert.ok(!d.plan.pruneOrder.includes(seqOfR(d, 'c0')), '判死但 open ⇒ 不剪')
  assert.ok(d.plan.hardProtected.includes(seqOfR(d, 'c0')))
  assert.ok(factor.compactIfNeeded(session, 1_000_000) !== null)
  assert.ok(surfaceDump(session).includes('A0-xxxx'), '焦点/open 组全部留面')
})

test('FT13 畸形 turn/start fail-closed：开放轮存在但号不可读 ⇒ 降级带清零、驱逐全停', async () => {
  // 审查 F1（发布前复核）：旧实现把「turn/start 无数字段」折叠成 null=「无开放轮」，
  // openFromPos=+∞ ⇒ 本轮协议现场整组可判死降级（fail-open）。修后 detectOpenTurn 返回
  // -1 哨兵 ⇒ 一切按开放轮处理。变异锁：摘 -1 回退 `?? null` ⇒ 本测试红（band=1、降级 1）。
  const { host, factor } = await makeFactor()
  const session = buildQuotaScaffold('quota-ft13')
  host.bindSession(session)
  buildGroups(session, 2, 20, 'a')
  appendGroup(session, 2, 'c0dup', 'C:/Proj/a0.ts', 'A0-RELOADED-' + 'y'.repeat(200))
  session.append('turn/start', {} as unknown as { turn: number }) // 畸形：未闭合开放轮、号不可读
  const d = factor.decide(session, 1_000_000)
  assert.equal(d.focusEscalated, false)
  assert.equal(d.quotaBandGroups, 0, '-1 哨兵 ⇒ 全区按 open 处理，无组入带')
  assert.equal(d.demotedGroupCount, 0)
  assert.ok(!d.plan.pruneOrder.includes(seqOfR(d, 'c0')), '判死组 R 也不进剪序')
  // 全区当 open ⇒ 组剪无处可剪 ⇒ 无事务发射（比 FT12 更保守：连旧轮也不可赶）。
  assert.equal(factor.compactIfNeeded(session, 1_000_000), null, 'fail-closed：无可剪面不发事务')
  assert.ok(surfaceDump(session).includes('A0-xxxx'), '判死组也留面')
})
