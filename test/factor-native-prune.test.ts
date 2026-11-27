/**
 * 原生 tool-result-pruner 二次收紧接线（2026-11-13 引入，2026-11-14 用户裁定改序）：
 *  - 同一笔 compactIfNeeded：**先** alpha2 口径组剪（A+R 整组归零，目标 = 真实缺口），
 *    **再**对剩余 surface 跑 pruner（专打焦点/open 轮里组剪动不了的大 read）；
 *  - pruner 的 compaction/prune 落在我们的 compaction/end 之后 ⇒ 不并进组剪事务账；
 *  - pruner 切片（root 已 shadowed 的 replace 克隆）算 stub ⇒ 下一笔组剪可整组驱逐，
 *    不再形成永久配重（alpha3 实锤 63.5% surface）；
 *  - 服务缺失 / 无 open turn / 异常 ⇒ no-op，不阻断组剪。
 *
 *  - 宿主格式校验硬界「tool/result replace 仅 open turn 合法」：老轮超限 R 撞上它时
 *    pruneSession 整 pass fail-fast（真实包 @throws 语义，早先已提交的 replace 保持
 *    durable；被拒节点先落的 compaction/prune 成孤儿）⇒ 引擎吞掉不阻断，
 *    老超限面 + 同笔未扫到的 open 轮超限面当笔漏剪 = 行为基线（NP10a/NP10c）。
 *
 * 变异锁：摘掉 compactIfNeeded 的 nativePruneToolResults 调用 ⇒ NP1 红；
 * 把 pruner 挪回组剪之前 ⇒ NP7/NP9 红；摘掉 stubSeqs 的克隆判据 ⇒ NP8 红；
 * 摘掉假 pruner 的 rejectOutsideOpenTurn 模拟 ⇒ NP10a 红（超限面被切开=宿主放开
 * 老节点替换或我方重构，须报警）；摘掉引擎侧 try/catch ⇒ NP10a 红（异常阻断事务发射）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ArgpEngine } from '../src/argp-engine.ts'
import { sessionEvents } from '../src/log-access.ts'

const MARKER = '[... tool result middle pruned ...]'

interface PrunerInternals {
  compactIfNeeded(agent: unknown, trigger: string, signal: AbortSignal, incomingTokens?: number): Promise<unknown>
  records: Array<{ shadowedSeqs: number[] }>
  factor: { compactIfNeeded(session: Session, targetReleaseChars: number): unknown }
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

/** 假 pruner：真实服务的行为镜像（只切 text 块、保留 callId/source、append
 *  compaction/prune + tool/result replace）。测试只依赖接口形状，不重测宿主包。
 *  rejectOutsideOpenTurn=true 时补执行宿主格式校验的一条硬约束（"tool/result
 *  replacement is outside an open turn"，SessionFormatError——testkit Session 不跑它，
 *  探针实测会 ACCEPTED）。语义照抄真实包 dsh-compaction-tool-result-pruner
 *  index.ts:133-134：shadow-price prune 事件先落盘、被拒的 replace 抛错中断整 pass，
 *  pass 内早先已提交的 replace 保持 durable ⇒ 被拒节点留一枚孤儿 prune 事件。 */
function installFakePruner(ctx: Context, opts: { throw?: boolean; omit?: boolean; onCall?: () => void; rejectOutsideOpenTurn?: boolean } = {}): { calls: number; charsRemoved: number; pruneSeqs: number[] } {
  const state = { calls: 0, charsRemoved: 0, pruneSeqs: [] as number[] }
  if (opts.omit === true) return state
  const fake = {
    pruneSession(session: Session) {
      state.calls += 1
      opts.onCall?.()
      if (opts.throw === true) throw new Error('fake pruner boom')
      // open turn 边界：最近一个 turn/start 的 seq（off-surface 事件；台架形态无 turn/end）。
      let openStart = Number.POSITIVE_INFINITY
      if (opts.rejectOutsideOpenTurn === true) {
        for (const e of sessionEvents(session) as unknown as Array<{ type: string; seq: number }>) {
          if (e.type === 'turn/start') openStart = Math.max(openStart, e.seq)
        }
      }
      const pruned: { originalSeq: number; replacementSeq: number }[] = []
      let charsRemoved = 0
      for (const seq of [...session.surface.nodes]) {
        const ev = session.eventAt(seq) as { type?: string; data?: { message?: { content?: unknown[] } } } | undefined
        if (ev?.type !== 'tool/result') continue
        const msg = session.deriveEventMessage(ev as never) as unknown as { content?: Array<Record<string, unknown>> }
        let text = 0
        for (const b of msg.content ?? []) {
          if (b.type === 'text') text += String(b.text ?? '').length
          else if (b.type === 'tool-result') {
            for (const c of (b.content as Array<Record<string, unknown>> | undefined) ?? []) {
              if (c.type === 'text') text += String(c.text ?? '').length
            }
          }
        }
        if (text <= 8192) continue
        const content = (msg.content ?? []).map(b => {
          if (b.type !== 'tool-result') return b
          return {
            ...b,
            content: ((b.content as Array<Record<string, unknown>>) ?? []).map(c =>
              c.type === 'text' ? { ...c, text: String(c.text ?? '').slice(0, 64) + '\n\n' + MARKER + '\n\n' } : c),
          }
        })
        const message = { ...msg, content }
        const pruneEvent = session.append('compaction/prune', {
          shadowedRange: { start: seq, end: seq }, shadowedSeqs: [seq], shadowedTokenCount: 10,
        } as never)
        state.pruneSeqs.push(pruneEvent.seq)
        if (opts.rejectOutsideOpenTurn === true && seq < openStart) {
          throw new Error('surface replace: tool/result replacement is outside an open turn')
        }
        const rep = session.append('tool/result', { ...(ev.data as object), message } as never, {
          surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
          sourceEventSeqs: [seq],
        } as never)
        pruned.push({ originalSeq: seq, replacementSeq: rep.seq })
        charsRemoved += Math.max(0, text - 64)
      }
      state.charsRemoved += charsRemoved
      return { pruned, charsRemoved }
    },
  }
  ctx.reflect.provide('toolResultPruner', fake)
  return state
}

async function boot(): Promise<{ ctx: Context; engine: PrunerInternals }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: 'native pruner persona' } })
  await ctx.plugin(ArgpEngine, { engine: 'factor', windowTokens: 100, retainTokens: 50 } as never)
  return { ctx, engine: ctx.compaction as unknown as PrunerInternals }
}

function makeAgent(session: Session): unknown {
  return { session, options: {}, steer: () => undefined }
}

function surfaceDump(session: Session): string {
  const evs = sessionEvents(session) as unknown as Array<{ seq: number }>
  return [...session.surface.nodes].map(s => JSON.stringify(evs[s as number])).join('\n')
}

function appendBigFocusGroup(session: Session): { callId: string; result: string } {
  const result = 'BIG-FOCUS '.repeat(2500) // 25K chars，必过 8192 阈
  appendGroup(session, 2, 'focus', 'C:/Proj/focus.ts', result)
  return { callId: 'focus', result }
}

test('NP1 同一笔压缩：pruner 全局切大 R + 组剪赶旧 A+R，两层都落', async () => {
  const { ctx, engine } = await boot()
  const state = installFakePruner(ctx)
  const session = makeSession('native-np1')
  appendUser(session, 1, '开始任务')
  appendGroup(session, 1, 'old', 'C:/Proj/old.ts', 'OLD-TEXT '.repeat(300))
  appendUser(session, 2, '读焦点文件')
  session.append('turn/start', { turn: 2 })
  appendBigFocusGroup(session)
  const out = await engine.compactIfNeeded(makeAgent(session), 'context-overflow', new AbortController().signal)
  assert.ok(out !== null, '组剪必须发射（旧组可剪）')
  assert.equal(state.calls, 1, '★pruner 必须被调用（摘调用 ⇒ 此条红）')
  const dump = surfaceDump(session)
  assert.ok(dump.includes(MARKER), '大 R 已被 pruner 切成 head/middle/tail')
  assert.ok(!dump.includes('BIG-FOCUS '.repeat(2500)), '焦点大 R 原文离场（replace 真落盘）')
  assert.ok(!dump.includes('OLD-TEXT'), '旧 A+R 组被组剪整组赶走')
  assert.ok(dump.includes('focus.ts'), '焦点组 A 侧保留')
  assert.ok(state.charsRemoved > 20000, 'pruner 节省量上报')
})

test('NP2 服务缺失：no-op，组剪照常（零行为变化）', async () => {
  const { ctx, engine } = await boot()
  installFakePruner(ctx, { omit: true })
  const session = makeSession('native-np2')
  appendUser(session, 1, '开始任务')
  appendGroup(session, 1, 'old', 'C:/Proj/old.ts', 'OLD-TEXT '.repeat(300))
  appendUser(session, 2, '继续')
  session.append('turn/start', { turn: 2 })
  appendBigFocusGroup(session)
  const out = await engine.compactIfNeeded(makeAgent(session), 'context-overflow', new AbortController().signal)
  assert.ok(out !== null)
  const dump = surfaceDump(session)
  assert.ok(!dump.includes(MARKER), '无 pruner 不得出现切文本')
  assert.ok(!dump.includes('OLD-TEXT'), '组剪仍工作')
})

test('NP3 无 open turn：pruner 跳过（tool/result replace 只允许 open turn），组剪照常', async () => {
  const { ctx, engine } = await boot()
  const state = installFakePruner(ctx)
  const session = makeSession('native-np3')
  appendUser(session, 1, '开始任务')
  appendGroup(session, 1, 'old', 'C:/Proj/old.ts', 'OLD-TEXT '.repeat(300))
  appendUser(session, 2, '继续') // 不 append turn/start ⇒ detectOpenTurn=null
  appendBigFocusGroup(session)
  const out = await engine.compactIfNeeded(makeAgent(session), 'context-overflow', new AbortController().signal)
  assert.ok(out !== null)
  assert.equal(state.calls, 0, '无 open turn 不调 pruner')
  assert.ok(!surfaceDump(session).includes(MARKER))
})

test('NP4 pruner 异常：不阻断，组剪照常', async () => {
  const { ctx, engine } = await boot()
  const state = installFakePruner(ctx, { throw: true })
  const session = makeSession('native-np4')
  appendUser(session, 1, '开始任务')
  appendGroup(session, 1, 'old', 'C:/Proj/old.ts', 'OLD-TEXT '.repeat(300))
  appendUser(session, 2, '继续')
  session.append('turn/start', { turn: 2 })
  appendBigFocusGroup(session)
  const out = await engine.compactIfNeeded(makeAgent(session), 'context-overflow', new AbortController().signal)
  assert.ok(out !== null)
  assert.equal(state.calls, 1)
  assert.ok(!surfaceDump(session).includes('OLD-TEXT'), 'pruner 异常后组剪仍发射')
})

test('NP5 pruner 的裸 compaction/prune 不并进组剪事务账（resume 重建安全）', async () => {
  const { ctx, engine } = await boot()
  const state = installFakePruner(ctx)
  const session = makeSession('native-np5')
  appendUser(session, 1, '开始任务')
  appendGroup(session, 1, 'old', 'C:/Proj/old.ts', 'OLD-TEXT '.repeat(300))
  appendUser(session, 2, '继续')
  session.append('turn/start', { turn: 2 })
  appendBigFocusGroup(session)
  await engine.compactIfNeeded(makeAgent(session), 'context-overflow', new AbortController().signal)
  const evs = sessionEvents(session) as unknown as Array<{ type: string; seq?: number }>
  const starts = evs.filter(e => e.type === 'compaction/start').length
  const ends = evs.filter(e => e.type === 'compaction/end').length
  assert.equal(starts, 1, '只有组剪一笔 start（pruner 不发事务）')
  assert.equal(ends, 1)
  assert.equal(engine.records.length, 1, '账目重建/在线账只有组剪一笔')
  // 组剪事务的 shadowedSeqs 不得包含 pruner 遮掉的焦点原 R。
  const focusOriginal = evs.find(e => e.type === 'tool/result' && JSON.stringify(e).includes('BIG-FOCUS'))?.seq
  assert.ok(focusOriginal !== undefined)
  assert.ok(!engine.records[0]!.shadowedSeqs.includes(focusOriginal), 'pruner 原 R 不混入组剪区间账')
  // 新序：组剪事务结束后才出现 pruner 事件（先组剪后 pruner 的结构锁）。
  const endSeq = evs.find(e => e.type === 'compaction/end')?.seq ?? -1
  assert.ok(state.pruneSeqs.length > 0, 'pruner 必须实际切过')
  assert.ok(state.pruneSeqs.every(s => s > endSeq), 'pruner 的 prune 事件必须在 compaction/end 之后')
})

test('NP7 组剪目标按真实缺口计算（pruner 不再缩小目标）：先组剪后 pruner', async () => {
  const targetOf = async (withPruner: boolean): Promise<{ target: number; order: string[] }> => {
    const { ctx, engine } = await boot()
    const order: string[] = []
    installFakePruner(ctx, withPruner ? { onCall: () => order.push('pruner') } : { omit: true })
    const session = makeSession('native-np7-' + String(withPruner))
    appendUser(session, 1, '开始任务')
    appendGroup(session, 1, 'old', 'C:/Proj/old.ts', 'OLD-TEXT '.repeat(300))
    appendUser(session, 2, '继续')
    session.append('turn/start', { turn: 2 })
    appendBigFocusGroup(session)
    let target = -1
    const orig = engine.factor.compactIfNeeded.bind(engine.factor)
    engine.factor.compactIfNeeded = (s: Session, t: number) => { target = t; order.push('factor'); return orig(s, t) }
    await engine.compactIfNeeded(makeAgent(session), 'context-overflow', new AbortController().signal)
    return { target, order }
  }
  const withPruner = await targetOf(true)
  const withoutPruner = await targetOf(false)
  assert.ok(withoutPruner.target > 0 && withPruner.target > 0)
  assert.equal(withPruner.target, withoutPruner.target,
    '先组剪 ⇒ pruner 不参与目标计算（若 re-measure 前置残留 ⇒ 此条红）')
  assert.deepEqual(withPruner.order, ['factor', 'pruner'], '★动作顺序必须是 组剪→pruner（反序 ⇒ 此条红）')
})

test('NP8 pruner 切片在下一笔压缩可被整组驱逐（残留配重修复锁）', async () => {
  const { ctx, engine } = await boot()
  const state = installFakePruner(ctx)
  const session = makeSession('native-np8')
  appendUser(session, 1, '开始任务')
  session.append('turn/start', { turn: 2 })
  appendBigFocusGroup(session) // turn 2 的焦点大 read：第一笔组剪动不了
  await engine.compactIfNeeded(makeAgent(session), 'context-overflow', new AbortController().signal)
  assert.equal(state.calls, 1, 'pruner 必须切出切片')
  let dump = surfaceDump(session)
  assert.ok(dump.includes(MARKER), '第一笔：焦点大 R 被切成 head/middle/tail')
  assert.ok(dump.includes('focus.ts'), '第一笔：焦点 A 仍受 open turn 保护')

  // 下一笔：turn 3 打开，turn 2 组离开焦点窗；切片是 stub ⇒ 整组（A+切片）离场。
  appendUser(session, 2, '第二轮')
  session.append('turn/start', { turn: 3 })
  appendGroup(session, 3, 'new', 'C:/Proj/new.ts', 'NEW-TEXT '.repeat(300))
  await engine.compactIfNeeded(makeAgent(session), 'context-overflow', new AbortController().signal)
  dump = surfaceDump(session)
  assert.ok(!dump.includes(MARKER), 'pruner 切片必须被组剪带走（不判 stub ⇒ 此条红）')
  assert.ok(!dump.includes('focus.ts'), '切片所属 A 同组离场（整组闭包）')
  assert.ok(dump.includes('NEW-TEXT'), '新焦点组保留')
})

test('NP6 surface 文本判据：无 pruner 时大 R 原文仍在（变异对照锚）', async () => {
  const { ctx, engine } = await boot()
  installFakePruner(ctx, { omit: true })
  const session = makeSession('native-np6')
  appendUser(session, 2, '继续')
  session.append('turn/start', { turn: 2 })
  const { result } = appendBigFocusGroup(session)
  await engine.compactIfNeeded(makeAgent(session), 'context-overflow', new AbortController().signal)
  assert.ok(surfaceDump(session).includes(result), '无 pruner ⇒ 大 R 原文保留')
  assert.ok(!surfaceDump(session).includes(MARKER))
})

/** NP10 共享形态（真实 46 轮账本 T42 型「稳态事务」的缩小镜像）：缺口只需赶 t1 旧组
 *  （目标按 NP7 wrap 先例钉 3500 chars），surface 上同时留 t2（闭轮）与 t3（open 轮）
 *  各一枚 >8192 超限 R——闭轮超限 R 是组剪当笔没赶走、pruner 又动不了的那类。 */
function buildNp10(engine: PrunerInternals, id: string): Session {
  const session = makeSession(id)
  appendUser(session, 1, '开始任务')
  appendGroup(session, 1, 'old', 'C:/Proj/old.ts', 'OLD-TEXT '.repeat(700))
  appendUser(session, 2, '查旧档')
  session.append('turn/start', { turn: 2 })
  appendGroup(session, 2, 'stale', 'C:/Proj/stale.ts', 'STALE-BIG '.repeat(3000))
  appendUser(session, 3, '读焦点')
  session.append('turn/start', { turn: 3 })
  appendGroup(session, 3, 'open', 'C:/Proj/open.ts', 'OPEN-BIG '.repeat(3000))
  const orig = engine.factor.compactIfNeeded.bind(engine.factor)
  engine.factor.compactIfNeeded = (s: Session) => orig(s, 3500)
  return session
}

test('NP10a 老轮超限 R：宿主拒 open-turn 外 replace ⇒ pruneSession fail-fast 吞掉不阻断；超限面漏剪=基线', async () => {
  const { ctx, engine } = await boot()
  const state = installFakePruner(ctx, { rejectOutsideOpenTurn: true })
  const session = buildNp10(engine, 'native-np10a')
  const out = await engine.compactIfNeeded(makeAgent(session), 'context-overflow', new AbortController().signal)
  assert.ok(out !== null, '组剪必须发射（t1 可赶；pruner 异常不阻断事务）')
  assert.equal(state.calls, 1, 'pruner 必须被调用（全表面扫描 oldest-first 撞上 t2 老超限 R）')
  assert.equal(state.charsRemoved, 0, '整 pass 中断 ⇒ 本笔零削减')
  const dump = surfaceDump(session)
  assert.ok(!dump.includes(MARKER), 'fail-fast 不落任何切片（含本可合法切的 open 轮 R）')
  assert.ok(!dump.includes('OLD-TEXT'), '组剪兜底：老组整组离场（漏剪只对组剪赶不走的闭轮面成立）')
  assert.ok(dump.includes('STALE-BIG '.repeat(3000)), '★老轮超限 R 原文滞留 surface = 漏剪基线（宿主放开老节点替换或我方重构 pruner 时此条报警）')
  assert.ok(dump.includes('OPEN-BIG '.repeat(3000)), '★open 轮超限 R 当笔漏剪（fail-fast 供给归零；只能等下笔随组赶旧回收）')
})

test('NP10c 超限形态下 pruner 孤儿 compaction/prune 不入组剪事务账（NP5 复验）', async () => {
  const { ctx, engine } = await boot()
  const state = installFakePruner(ctx, { rejectOutsideOpenTurn: true })
  const session = buildNp10(engine, 'native-np10c')
  await engine.compactIfNeeded(makeAgent(session), 'context-overflow', new AbortController().signal)
  const evs = sessionEvents(session) as unknown as Array<{ type: string; seq?: number; data?: { shadowedSeqs?: number[] } }>
  const starts = evs.filter(e => e.type === 'compaction/start').length
  const ends = evs.filter(e => e.type === 'compaction/end').length
  assert.equal(starts, 1, '只有组剪一笔事务 start')
  assert.equal(ends, 1)
  const endSeq = evs.find(e => e.type === 'compaction/end')?.seq ?? -1
  // 组剪事务自身逐区间发射 compaction/prune（start..end 内），孤儿判据=落在 end 之后。
  const orphans = evs.filter(e => e.type === 'compaction/prune' && (e.seq ?? -1) > endSeq)
  assert.equal(orphans.length, 1, '恰一枚孤儿 prune 在事务外：被拒节点 shadow-price 先落盘、正文 replace 被宿主拒')
  const staleSeq = evs.find(e => e.type === 'tool/result' && JSON.stringify(e).includes('STALE-BIG'))?.seq
  assert.ok(staleSeq !== undefined, '被拒原 R 仍在日志（surface 滞留已由 NP10a 钉）')
  assert.equal(orphans[0]!.seq, state.pruneSeqs[0], '孤儿即假 pruner 落盘的那枚')
  assert.deepEqual(orphans[0]!.data?.shadowedSeqs, [staleSeq], '孤儿给 surface 仍在位的老轮原 R 定价（记账疤痕=基线）')
  assert.equal(engine.records.length, 1, '在线账/重建账只有组剪一笔（孤儿不并进）')
  assert.ok(!engine.records[0]!.shadowedSeqs.includes(staleSeq), '孤儿不把 surface 在位的老轮原 R 拖进组剪区间账')
  assert.ok(!engine.records[0]!.shadowedSeqs.includes(orphans[0]!.seq!), '孤儿事件自身不进组剪事务账')
})
