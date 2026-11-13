/**
 * 原生 tool-result-pruner 全局预剪接线（2026-11-13 用户裁定）：
 *  - 同一笔 compactIfNeeded：pruner 先切全局 R（含焦点尾窗内大 read），组剪再按
 *    re-measure 后的剩余 deficit 赶 A+R 组；
 *  - pruner 的 compaction/prune 落在我们的 compaction/start 之前 ⇒ 不并进组剪事务账；
 *  - 服务缺失 / 无 open turn / 异常 ⇒ no-op，不阻断组剪。
 *
 * 变异锁：摘掉 compactIfNeeded 的 nativePruneToolResults 调用 ⇒ NP1 红（fake 未调用、
 * 大 R 原文仍在 surface）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ArgpGraphEngine } from '../src/argp-graph-engine.ts'
import { eventText, sessionEvents } from '../src/log-access.ts'

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
 *  compaction/prune + tool/result replace）。测试只依赖接口形状，不重测宿主包。 */
function installFakePruner(ctx: Context, opts: { throw?: boolean; omit?: boolean } = {}): { calls: number; charsRemoved: number } {
  const state = { calls: 0, charsRemoved: 0 }
  if (opts.omit === true) return state
  const fake = {
    pruneSession(session: Session) {
      state.calls += 1
      if (opts.throw === true) throw new Error('fake pruner boom')
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
        session.append('compaction/prune', {
          shadowedRange: { start: seq, end: seq }, shadowedSeqs: [seq], shadowedTokenCount: 10,
        } as never)
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
  await ctx.plugin(ArgpGraphEngine, { engine: 'factor', windowTokens: 100, retainTokens: 50 } as never)
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
  installFakePruner(ctx)
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
})

test('NP7 pruner 节省计入同一 deficit：组剪目标按 re-measure 缩小', async () => {
  const targetOf = async (withPruner: boolean): Promise<number> => {
    const { ctx, engine } = await boot()
    installFakePruner(ctx, withPruner ? {} : { omit: true })
    const session = makeSession('native-np7-' + String(withPruner))
    appendUser(session, 1, '开始任务')
    appendGroup(session, 1, 'old', 'C:/Proj/old.ts', 'OLD-TEXT '.repeat(300))
    appendUser(session, 2, '继续')
    session.append('turn/start', { turn: 2 })
    appendBigFocusGroup(session)
    let target = -1
    const orig = engine.factor.compactIfNeeded.bind(engine.factor)
    engine.factor.compactIfNeeded = (s: Session, t: number) => { target = t; return orig(s, t) }
    await engine.compactIfNeeded(makeAgent(session), 'context-overflow', new AbortController().signal)
    return target
  }
  const withPruner = await targetOf(true)
  const withoutPruner = await targetOf(false)
  assert.ok(withoutPruner > 0 && withPruner > 0)
  assert.ok(withPruner < withoutPruner, 'pruner 后组剪目标必须更小（re-measure 未接 ⇒ 此条红）：'
    + withPruner + ' < ' + withoutPruner)
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
