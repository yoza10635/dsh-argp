/**
 * P6-③ 驱逐判据（2026-11-11 用户裁定，11-12 开工）：factor decide 两条新准入。
 *
 * 裁定 2（召回轮）：召回对（recall_history/list_labels 的 call+result）**无条件进剪序**
 * ——全部硬保护位失效（含 open 轮 failureNoFollowR / sticky / focal），可再生=再召回一次；
 * 排序照常走 freshness（刚引用=新鲜，迟剪）。
 * 裁定 3（中断轮）：closed 轮内半截 A（有 tool-call 却有未应答 call）+ 孤儿 R（callId
 * 无在世 issuer A）强制先行（无视目标量，"驱逐时机=下次压缩"），保留该轮 user 消息；
 * 半截 A 的已应答 R 必须同行驱逐（user 墓碑替 A 会孤儿化它们）。
 *
 * 变异台账（摘锁必须变红，已逐条执行）：
 *  EV1 recall 硬保护豁免摘除（hard 照常生效）→ T1 红（open 轮 recall R 受保护不剪）；
 *  EV2 强制先行段摘除（forcedFirstSeqs 不喂）→ T2/T3 红（半截 A/孤儿 R 不入序零发射）；
 *  EV3 半截 A 的已应答 R 不同行 → T4 红（孤儿 R 幸存 = tool-pairing 失衡）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ArgpEngine } from '../src/argp-engine.ts'
import { sessionEvents } from '../src/log-access.ts'
import { FACTOR_COMPACTED_MARKER } from '../src/constants.ts'

function appendUser(session: Session, text: string, turn?: number): void {
  session.append('user/message', {
    ...createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
    ...(turn === undefined ? {} : { turn }),
  } as never, { surfaceOp: 'append' })
}

function appendGroup(session: Session, turn: number, callId: string, tool: string, args: string, resultText: string): void {
  session.append('assistant/message', {
    stream: [], turn, step: 1,
    message: createAssistantMessage({
      source: { provider: 'test', model: 'test' },
      content: [{ type: 'text', text: 'doing ' + tool + ' ' + callId }, { type: 'tool-call', id: callId, name: tool, arguments: args } as never],
    }),
  } as never, { surfaceOp: 'append' })
  session.append('tool/call', { turn, callId, name: tool, arguments: args } as never)
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

/** 半截 A：只落 assistant（带 tool-call）+ tool/call，不落 result（中断现场）。 */
function appendHalfA(session: Session, turn: number, callId: string, tool: string, args: string): void {
  session.append('assistant/message', {
    stream: [], turn, step: 1,
    message: createAssistantMessage({
      source: { provider: 'test', model: 'test' },
      content: [{ type: 'text', text: 'interrupted ' + callId }, { type: 'tool-call', id: callId, name: tool, arguments: args } as never],
    }),
  } as never, { surfaceOp: 'append' })
  session.append('tool/call', { turn, callId, name: tool, arguments: args } as never)
}

/** 已应答 R：为既有 tool/call 落 result（半截 A 的已应答腿）。 */
function appendResult(session: Session, turn: number, callId: string, resultText: string): void {
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

/** 孤儿 R：result 落盘但其 issuer A/call 从未存在（interrupted-merge 产物形态）。 */
function appendOrphanR(session: Session, turn: number, callId: string, resultText: string): void {
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

function makeSession(id: string): Session {
  const session = Session.create(SessionId(id))
  session.append('system/message', { content: 'p6iii persona' } as never, { surfaceOp: 'append' })
  return session
}

interface EngineInternals {
  bindSession(session: Session): void
  compactIfNeeded(agent: unknown, trigger: string, signal: AbortSignal, incoming?: number): Promise<unknown>
}

async function boot(): Promise<{ ctx: Context; internals: EngineInternals }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: 'p6iii persona' } })
  await ctx.plugin(ArgpEngine, { engine: 'factor', windowTokens: 100, retainTokens: 50, recencyGuard: 0 })
  const internals = ctx.compaction as unknown as EngineInternals
  return { ctx, internals }
}

/** surface 节点 JSON dump（tool 桩是 V3 形 tool-result 块内嵌 inner text，纯 text 提取读不到——dump 全量判据）。 */
function surfaceDump(session: Session): string {
  const events = sessionEvents(session) as unknown as Array<{ seq: number; data?: unknown }>
  const nodes = new Set(session.surface.nodes as readonly number[])
  return [...nodes].map(seq => JSON.stringify(events[seq]?.data ?? '')).join('\n')
}

/** surface 上的因子压缩检查点数（A/R 组离场后的 compact-checkpoint user message）。 */
function devCount(session: Session): number {
  const events = sessionEvents(session) as unknown as Array<{ seq: number; type: string; data?: unknown }>
  const nodes = new Set(session.surface.nodes as readonly number[])
  return [...nodes].filter(seq => {
    const e = events[seq]
    if (e?.type !== 'user/message') return false
    const src = (e.data as { source?: { kind?: string } } | undefined)?.source
    return src?.kind === 'compact-checkpoint' && JSON.stringify(e.data).includes(FACTOR_COMPACTED_MARKER)
  }).length
}

test('T1 召回对无条件进剪序：open 轮内的 recall_history R 照剪（EV1 锁）', async () => {
  const { ctx, internals } = await boot()
  const session = makeSession('p6iii-recall')
  internals.bindSession(session)
  // 旧轮：正常 bash R（closed）
  appendUser(session, '旧轮任务', 1)
  appendGroup(session, 1, 'c1', 'bash', '{"command":"npm test"}', '旧轮输出 ' + 'a'.repeat(200))
  // open turn 2：正常 bash R（受 open 保护）+ recall_history R（豁免 ⇒ 照剪）
  session.append('turn/start', { turn: 2 } as never)
  appendUser(session, '当前轮', 2)
  appendGroup(session, 2, 'c2', 'bash', '{"command":"ls"}', 'open 轮活体输出 ' + 'b'.repeat(200))
  appendGroup(session, 2, 'r1', 'recall_history', '{"labels":["document:docs/plan.md"]}', '被召回原文 ' + 'r'.repeat(200))
  const result = await internals.compactIfNeeded({ session } as never, 'context-overflow', new AbortController().signal)
  assert.ok(result !== null, 'context-overflow 必须触发 factor 剪')
  const texts = surfaceDump(session)
  assert.ok(!texts.includes('被召回原文'), '★open 轮 recall R 原文必须被剪（硬保护豁免）')
  assert.ok(!texts.includes('[已剪·因子]'), '新方案零指针桩文本')
  assert.ok(texts.includes('"toolCallId":"r1"'), 'recall R 以空 tool/result 克隆留位（callId 配对）')
  assert.ok(texts.includes('open 轮活体输出'), 'open 轮正常 R 仍受保护（豁免只认召回面）')
  assert.ok(!texts.includes('旧轮输出'), 'closed 旧 A+R 组照常组剪（对照面）')
  assert.ok(devCount(session) >= 1, 'closed 旧组落压缩检查点')
})

test('T2 中断轮半截 A 强制驱逐，user 消息保留（EV2 锁）', async () => {
  const { ctx, internals } = await boot()
  const session = makeSession('p6iii-halfa')
  internals.bindSession(session)
  appendUser(session, '中断轮任务', 2)
  appendHalfA(session, 2, 'cX', 'bash', '{"command":"npm run build"}')
  // 后续正常 closed 轮（保证 turn2 是 closed 的历史轮）
  appendUser(session, '后续轮', 3)
  appendGroup(session, 3, 'c3', 'bash', '{"command":"ls"}', '后续输出 ' + 'c'.repeat(200))
  const result = await internals.compactIfNeeded({ session } as never, 'context-overflow', new AbortController().signal)
  assert.ok(result !== null)
  const texts = surfaceDump(session)
  assert.equal(devCount(session), 1, '★半截 A 走压缩检查点（强制先行，无视目标量）')
  assert.ok(texts.includes('中断轮任务'), '该轮 user 消息保留（裁定 3）')
  assert.ok(!texts.includes('interrupted cX'), '半截 A 原文离场')
  assert.ok(!texts.includes('原文在 append-only 日志'), '不再产生 user 指针墓碑')
})

test('T3 孤儿 R 强制驱逐（EV2 锁）', async () => {
  const { ctx, internals } = await boot()
  const session = makeSession('p6iii-orphan')
  internals.bindSession(session)
  appendUser(session, '孤儿轮', 2)
  // issuer A 从未存在：interrupted-merge 后 A 被先行事务带走、R 滞留
  appendOrphanR(session, 2, 'cLost', '孤儿输出 ' + 'o'.repeat(200))
  appendUser(session, '后续轮', 3)
  appendGroup(session, 3, 'c3', 'bash', '{"command":"ls"}', '后续输出 ' + 'c'.repeat(200))
  const result = await internals.compactIfNeeded({ session } as never, 'context-overflow', new AbortController().signal)
  assert.ok(result !== null)
  const texts = surfaceDump(session)
  assert.equal(devCount(session), 1, '★孤儿 R 走压缩检查点（强制先行）')
  assert.ok(!texts.includes('孤儿输出'), '孤儿 R 原文离场')
  assert.ok(texts.includes('孤儿轮'), 'user 保留')
})

test('T4 半截 A 的已应答 R 同行驱逐（EV3 锁：不同行即孤儿化）', async () => {
  const { ctx, internals } = await boot()
  const session = makeSession('p6iii-companion')
  internals.bindSession(session)
  // 半截 A 与其已应答 R 同在焦点轮（closed）：R 是 focalNonRegenerable 硬保护成员——
  // soft 通道进不了剪序，companion 同行是它入事务的唯一通道。同 A 带未应答 call（半截）。
  appendUser(session, '混合中断轮', 3)
  session.append('assistant/message', {
    stream: [], turn: 3, step: 1,
    message: createAssistantMessage({
      source: { provider: 'test', model: 'test' },
      content: [
        { type: 'text', text: '两调用中断现场' },
        { type: 'tool-call', id: 'cA', name: 'read', arguments: '{"file_path":"C:/Proj/a.ts"}' } as never,
        { type: 'tool-call', id: 'cB', name: 'bash', arguments: '{"command":"npm run build"}' } as never,
      ],
    }),
  } as never, { surfaceOp: 'append' })
  session.append('tool/call', { turn: 3, callId: 'cA', name: 'read', arguments: '{"file_path":"C:/Proj/a.ts"}' } as never)
  session.append('tool/call', { turn: 3, callId: 'cB', name: 'bash', arguments: '{"command":"npm run build"}' } as never)
  appendResult(session, 3, 'cA', '已应答输出2 ' + 'x'.repeat(120))
  const result = await internals.compactIfNeeded({ session } as never, 'context-overflow', new AbortController().signal)
  assert.ok(result !== null)
  const texts = surfaceDump(session)
  assert.equal(devCount(session), 1, '★半截 A 与其已应答 R 整组走压缩检查点')
  assert.ok(!texts.includes('已应答输出2'), '★R(cA) 必须经 companion 同行入事务（focal 硬保护成员，soft 通道进不来）')
  assert.ok(!texts.includes('已应答输出'), 'R(cA) 原文离场')
  assert.ok(!texts.includes('两调用中断现场'), '半截 A 原文离场')
  assert.ok(!texts.includes('原文在 append-only 日志'), '不再产生 user 指针墓碑')
  // 协议组完整性：A 驱逐后不得留悬空 tool result（prune-tx 事务后审计同口径）
  const nodes = new Set(session.surface.nodes as readonly number[])
  const events = sessionEvents(session) as unknown as Array<{ seq: number; type: string; data?: Record<string, unknown> }>
  const liveCalls = new Set<string>()
  for (const e of events) {
    if (!nodes.has(e.seq) || e.type !== 'assistant/message') continue
    const content = (e.data?.message as { content?: Array<{ type?: string; id?: string }> } | undefined)?.content
    for (const b of content ?? []) if (b.type === 'tool-call' && b.id !== undefined) liveCalls.add(b.id)
  }
  for (const e of events) {
    if (!nodes.has(e.seq) || e.type !== 'tool/result') continue
    const content = (e.data?.message as { content?: Array<{ toolCallId?: string }> } | undefined)?.content
    const id = content?.[0]?.toolCallId
    assert.ok(id === undefined || liveCalls.has(id), '悬空 tool result 出现 = 同行驱逐被拆散')
  }
})
