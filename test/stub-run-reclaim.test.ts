/**
 * 表面桩游程随剪回收回归锁（2.2.2，2026-11-26 session-43df801e 审计）。
 *
 * 病灶：factor 组剪逐组留压缩检查点桩（user/message, source.kind=compact-checkpoint），
 * 114 组扫荡在表面产出 96 连排同文桩——角色交替破坏 + 逐事务累积泄漏。桩判 X 类
 * （永不进 A+R 剪枝面）+ prose 三桶按 own-kind 排除 ⇒ 常规通道双盲不可回收；
 * §11.8 归并通道随图臂退役 ⇒ factor 世界零桩治理。
 *
 * 治理两层：
 *  A. 事务内相邻同文并条（prune-tx 归并 pass，锁在 prune-tx-order ④⑤⑥）——阻断新游程；
 *  B. 跨事务随剪回收（FactorEngine.reclaimStubRuns）——surface 上 ≥FACTOR_STUB_RUN_MIN
 *     的同文邻接桩游程，**只在当笔压缩事务落地后**顺带发一笔 tombstone-merge 并条；
 *     绝不独立发维护事务。
 *
 * 锁清单：
 *  RR1 跨事务种子游程（两事务各落一枚邻接同文桩）⇒ 随下笔压缩事务归并成 1，
 *      归并事务 prune/replace shadow-price 契约成立，扫荡自身的当笔并条不受扰动；
 *  RR2 无事务 ⇒ 回收器闭嘴：种子游程原位保留，compaction 通道零落盘；
 *  RR3 纪律门：孤桩（游程 1）与同文非邻接桩都不得碰——有事务也只并游程。
 *
 * 变异纪律：摘 compactIfNeeded 内的 reclaimStubRuns 调用 ⇒ RR1 红（3 桩不塌 2、
 * 归并事务缺席）；K 阈改 1 ⇒ RR3 红（扫荡孤桩被独立归并，归并事务出现）；
 * 回收器邻接判据失效（同文即并）⇒ RR3 红（种子对跨活体被并）；回收器改独立发事务
 * （compactIfNeeded 返回 null 也跑）⇒ RR2 红（compaction 通道非零）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { CompactionId, compactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import { ArgpEngine } from '../src/argp-engine.ts'
import { FactorEngine, type FactorEngineHost } from '../src/factor/engine.ts'
import { FACTOR_COMPACTED_MARKER } from '../src/constants.ts'
import { sessionEvents } from '../src/log-access.ts'

async function makeFactor(): Promise<{ host: FactorEngineHost; factor: FactorEngine }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: 'stub reclaim persona' } })
  await ctx.plugin(ArgpEngine, { windowTokens: 100, retainTokens: 50, recencyGuard: 0, maxPasses: 8 })
  const host = ctx.compaction as unknown as FactorEngineHost
  return { host, factor: new FactorEngine(host) }
}

function makeSession(id: string): Session {
  const session = Session.create(SessionId(id))
  session.append('system/message', { content: 'persona' } as never, { surfaceOp: 'append' })
  return session
}

function appendUser(session: Session, turn: number, text: string): number {
  return session.append('user/message', { ...createUserMessage({
    content: [{ type: 'text', text }], source: { kind: 'user' },
  }), turn } as never, { surfaceOp: 'append' }).seq
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

/** 事务外直落一枚 compact-checkpoint 桩（模拟早前事务的遗留）。 */
function seedStub(session: Session, tag: string): number {
  return session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: FACTOR_COMPACTED_MARKER }],
    source: compactCheckpointSource(CompactionId('seed-' + tag) as never) as never,
  }) as never, { surfaceOp: 'append' }).seq
}

/** 表面上的因子压缩检查点桩 seq（文案=中性标记）。 */
function checkpointSeqs(session: Session): number[] {
  const evs = sessionEvents(session) as unknown as Array<{ seq: number; type: string; data?: unknown }>
  return [...session.surface.nodes].filter(s => {
    const e = evs[s as number]
    if (e?.type !== 'user/message') return false
    const src = (e.data as { source?: { kind?: string } } | undefined)?.source
    return src?.kind === 'compact-checkpoint' && JSON.stringify(e.data).includes(FACTOR_COMPACTED_MARKER)
  }) as number[]
}

function summaryCount(session: Session, needle: string): number {
  return (sessionEvents(session) as unknown as Array<{ type: string; data?: unknown }>)
    .filter(e => e.type === 'compaction/summary' && JSON.stringify(e.data).includes(needle)).length
}

function pruneEventShadowing(session: Session, want: number[]): Array<Record<string, unknown>> {
  return (sessionEvents(session) as unknown as Array<{ type: string; data?: Record<string, unknown> }>)
    .filter(e => e.type === 'compaction/prune'
      && JSON.stringify([...(e.data?.shadowedSeqs as number[] ?? [])].sort((a, b) => a - b)) === JSON.stringify([...want].sort((a, b) => a - b)))
    .map(e => e.data ?? {})
}

test('RR1 跨事务同文游程随剪归并：种子 2 连桩塌 1，扫荡当笔并条不受扰动', async () => {
  const { host, factor } = await makeFactor()
  const session = makeSession('reclaim-rr1')
  host.bindSession(session)
  appendUser(session, 1, '开始任务')
  const seed1 = seedStub(session, 'a')
  const seed2 = seedStub(session, 'b')
  appendUser(session, 2, '继续')
  buildGroups(session, 2, 12)

  assert.notEqual(factor.compactIfNeeded(session, 1_000_000), null, '降级扫荡必须发射事务')
  const cps = checkpointSeqs(session)
  assert.equal(cps.length, 2, '种子游程归并 1 枚 + 扫荡当笔归并 1 枚（修复前=3：种子 2 + 扫荡 2 塌… 扫荡本就并 1）')
  assert.ok(!cps.includes(seed1) && !cps.includes(seed2), '种子桩原址已被归并事务 shadow')
  assert.equal(summaryCount(session, '已整理压缩记录'), 1, '归并事务恰一笔（随剪顺带）')
  const mergePrunes = pruneEventShadowing(session, [seed1, seed2])
  assert.equal(mergePrunes.length, 1, '归并事务的 prune 恰覆盖种子游程')
  assert.equal(mergePrunes[0]!.shadowedRange && JSON.stringify(mergePrunes[0]!.shadowedRange),
    JSON.stringify({ start: seed1, end: seed2 }), '宽范围=种子游程序')
  // 归并事务的 shadow-price 契约：该 prune 紧随同范围 replace
  const evs = sessionEvents(session) as unknown as Array<{ type: string; data?: Record<string, unknown>; surfaceOp?: { op?: string; startSeq?: number; endSeq?: number } }>
  const idx = evs.findIndex(e => {
    if (e.type !== 'compaction/prune') return false
    const range = e.data?.shadowedRange as { start: number; end: number } | undefined
    return range !== undefined && range.start === seed1 && range.end === seed2
  })
  assert.ok(idx >= 0)
  let j = idx + 1
  while (j < evs.length && evs[j]!.surfaceOp === undefined) j += 1
  const nxt = evs[j]?.surfaceOp
  assert.ok(nxt !== undefined && nxt.op === 'replace' && nxt.startSeq === seed1 && nxt.endSeq === seed2,
    '归并 prune 必须紧跟同范围 replace（宿主 fold 邻接契约）')
  // 收敛锁：再按一次压缩钮不产生第二笔归并事务
  const before = summaryCount(session, '已整理压缩记录')
  factor.compactIfNeeded(session, 1_000_000)
  assert.equal(summaryCount(session, '已整理压缩记录'), before, '归并后游程塌缩 ⇒ 无重复维护事务')
})

test('RR2 无压缩事务 ⇒ 回收器不发独立事务（种子游程原位保留）', async () => {
  const { host, factor } = await makeFactor()
  const session = makeSession('reclaim-rr2')
  host.bindSession(session)
  appendUser(session, 1, '开始任务')
  seedStub(session, 'a')
  seedStub(session, 'b')

  assert.equal(factor.compactIfNeeded(session, 1_000_000), null, '无可剪面 ⇒ 主事务不发')
  assert.equal(checkpointSeqs(session).length, 2, '游程保留——绝不独立发维护事务')
  const compactionEvs = (sessionEvents(session) as unknown as Array<{ type: string }>)
    .filter(e => e.type.startsWith('compaction/'))
  assert.equal(compactionEvs.length, 0, 'compaction 通道零落盘')
})

test('RR3 纪律门：孤桩与同文非邻接桩都不碰（有事务也只并游程）', async () => {
  const { host, factor } = await makeFactor()
  const session = makeSession('reclaim-rr3')
  host.bindSession(session)
  appendUser(session, 1, '开始任务')
  seedStub(session, 'a')
  appendUser(session, 2, '活体夹断')
  seedStub(session, 'b')
  appendUser(session, 3, '继续')
  buildGroups(session, 3, 12)

  assert.notEqual(factor.compactIfNeeded(session, 1_000_000), null, '降级扫荡必须发射事务')
  // 扫荡 g0/g1 当笔并条成 1 桩；种子 a/b 各为游程 1（且被活体夹断）⇒ 全部保留
  assert.equal(checkpointSeqs(session).length, 3, '种子 2 枚游程 1 不触 + 扫荡 1 枚')
  assert.equal(summaryCount(session, '已整理压缩记录'), 0, '无游程 ≥K ⇒ 回收器零事务（K=2 下限锁）')
})
