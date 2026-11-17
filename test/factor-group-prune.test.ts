/**
 * A+R 协议组剪回归锁（2026-11-13 用户裁定，docs/design-group-prune-2026-11-13.md）：
 *   G1 旧 A+R 组整组离场 → 空 developer 占位（模型不可见、轮中无 user 消息、无指针）；
 *   G2 闭包：A 的某个 R 仍是 live/hard ⇒ A 保留，selected R 走空 tool/result（配对不破）；
 *   G3 K pack：旧 A+已剪桩组（R 未入选）也会被组剪；
 *   G4 孤儿 R（issuer 已离场）→ 空 developer，不落 tool 桩（否则孤儿 tool result → 400）；
 *   G5 标签召回：组剪后 recall_history(labels) 仍能取回 R 原文。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createAssistantMessage, createSystemMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ArgpEngine } from '../src/argp-engine.ts'
import { eventText } from '../src/log-access.ts'
import { FACTOR_COMPACTED_MARKER } from '../src/constants.ts'
import type { FactorEngine } from '../src/factor/engine.ts'
import { execTool, toolText } from './tool-execute-shape.ts'

interface Internals {
  factor: FactorEngine
  bindSession(session: Session): void
}

async function boot(): Promise<{ ctx: Context; internals: Internals }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: 'group prune persona' } })
  await ctx.plugin(ArgpEngine, { engine: 'factor', windowTokens: 100, retainTokens: 50 } as never)
  return { ctx, internals: ctx.compaction as unknown as Internals }
}

function makeSession(id: string): Session {
  const session = Session.create(SessionId(id))
  session.append('system/message', { content: 'persona' } as never, { surfaceOp: 'append' })
  return session
}

function appendUser(session: Session, text: string, turn: number): void {
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

function appendResult(session: Session, turn: number, callId: string, resultText: string, extra: unknown[] = []): void {
  session.append('tool/result', {
    turn, step: 1,
    message: {
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: resultText }, ...extra], isError: false }],
      source: { kind: 'tool', callId },
      id: 'm_' + callId,
    },
  } as never, { surfaceOp: 'append' })
}
function surfaceEvents(session: Session): Array<{ seq: number; type: string; data?: Record<string, unknown> }> {
  const evs = session.snapshotEvents() as unknown as Array<{ seq: number; type: string; data?: Record<string, unknown> }>
  return [...session.surface.nodes].map(s => evs[s as number] as { seq: number; type: string; data?: Record<string, unknown> })
}

function surfaceTexts(session: Session): string[] {
  return surfaceEvents(session).map(e => eventText(session, e.seq))
}

function factorCheckpoints(session: Session): Array<{ seq: number; type: string; data?: Record<string, unknown> }> {
  return surfaceEvents(session).filter(e => {
    if (e.type !== 'user/message') return false
    const src = (e.data as { source?: { kind?: string } } | undefined)?.source
    return src?.kind === 'compact-checkpoint' && eventText(session, e.seq).startsWith(FACTOR_COMPACTED_MARKER)
  })
}

function resultOf(session: Session, callId: string): { text: string; seq: number } | null {
  for (const e of surfaceEvents(session)) {
    if (e.type !== 'tool/result') continue
    const data = e.data as { message?: { source?: { callId?: string } } } | undefined
    if (data?.message?.source?.callId !== callId) continue
    return { text: eventText(session, e.seq), seq: e.seq }
  }
  return null
}

test('G1 A+R 组整组离场 → 压缩检查点（中性标记、无指针）', async () => {
  const { ctx, internals } = await boot()
  const session = makeSession('group-basic')
  internals.bindSession(session)
  appendUser(session, '任务', 1)
  appendGroup(session, 1, 'c1', 'C:/Proj/a.ts', 'OLD CONTENT '.repeat(40))
  appendGroup(session, 2, 'c2', 'C:/Proj/b.ts', 'NEW CONTENT '.repeat(40))
  appendGroup(session, 3, 'c3', 'C:/Proj/focus.ts', 'FOCUS CONTENT')
  const promptCount = (): number => surfaceEvents(session).filter(e =>
    e.type === 'user/message' && (e.data as { source?: { kind?: string } } | undefined)?.source?.kind === 'user').length
  const usersBefore = promptCount()
  const result = internals.factor.compactIfNeeded(session, 100_000)
  assert.ok(result !== null, '组剪必须发射事务')
  const texts = surfaceTexts(session)
  assert.ok(!texts.some(t => t.includes('OLD CONTENT')), '组 1 的 R 已离场')
  assert.ok(!texts.some(t => t.includes('NEW CONTENT')), '组 2 的 R 已离场')
  assert.ok(!texts.some(t => t.includes('C:/Proj/a.ts')), '组 1 的 A（args）已离场')
  assert.ok(!texts.some(t => t.includes('C:/Proj/b.ts')), '组 2 的 A（args）已离场')
  assert.ok(texts.some(t => t.includes('FOCUS CONTENT')), '焦点轮 R（hard）保留')
  const checkpoints = factorCheckpoints(session)
  assert.equal(checkpoints.length, 2, '两个旧组 ⇒ 两个压缩检查点')
  for (const c of checkpoints) {
    assert.ok(eventText(session, c.seq).startsWith(FACTOR_COMPACTED_MARKER), '检查点文案=已压缩剪枝次要原子（无指针）')
  }
  assert.equal(promptCount(), usersBefore, '不新增 user 提示（检查点 source 不是 user）')
  assert.ok(!texts.some(t => t.includes('[已剪·因子]') || t.includes('recall_history(')), '零指针/墓碑文本')
})

test('G2 闭包：一个 R 仍 live/hard ⇒ A 保留，selected R 走空 tool/result', async () => {
  const { internals } = await boot()
  const session = makeSession('group-closure')
  internals.bindSession(session)
  appendUser(session, '任务', 1)
  // A 两个 call：c1 普通（可剪），c2 附件（hard）
  session.append('assistant/message', {
    stream: [], turn: 1, step: 1,
    message: createAssistantMessage({
      source: { provider: 'test', model: 'test' },
      content: [
        { type: 'text', text: 'doing tools' },
        { type: 'tool-call', id: 'c1', name: 'read', arguments: JSON.stringify({ file_path: 'C:/Proj/a.ts' }) },
        { type: 'tool-call', id: 'c2', name: 'read', arguments: JSON.stringify({ file_path: 'C:/Proj/img.ts' }) },
      ] as never,
    }),
  } as never, { surfaceOp: 'append' })
  session.append('tool/result', {
    turn: 1, step: 1,
    message: {
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'NORMAL R' }], isError: false }],
      source: { kind: 'tool', callId: 'c1' }, id: 'm_c1',
    },
  } as never, { surfaceOp: 'append' })
  session.append('tool/result', {
    turn: 1, step: 1,
    message: {
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: 'c2', content: [{ type: 'text', text: 'IMG R' }, { type: 'image' } as never], isError: false }],
      source: { kind: 'tool', callId: 'c2' }, id: 'm_c2',
    },
  } as never, { surfaceOp: 'append' })
  appendGroup(session, 2, 'c3', 'C:/Proj/focus.ts', 'FOCUS CONTENT')
  const result = internals.factor.compactIfNeeded(session, 100_000)
  assert.ok(result !== null)
  const texts = surfaceTexts(session)
  assert.ok(texts.some(t => t.includes('doing tools')), 'A 必须保留（有 live/hard R，闭包不成立）')
  assert.ok(texts.some(t => t.includes('IMG R')), '附件 R 硬保护保留')
  assert.ok(!texts.some(t => t.includes('NORMAL R')), 'selected R 已剪')
  const c1 = resultOf(session, 'c1')
  assert.ok(c1 !== null, 'selected R 必须以空 tool/result 克隆留在面上（配对）')
  assert.equal(c1.text, '', '空 tool/result 无指针文本')
})

test('G3 K pack：旧 A+已剪桩组（R 未入选）也被组剪', async () => {
  const { internals } = await boot()
  const session = makeSession('group-kpack')
  internals.bindSession(session)
  appendUser(session, '任务', 1)
  appendGroup(session, 1, 'c1', 'C:/Proj/a.ts', 'K CONTENT')
  // 现场贴桩 c1 的 R（与生产同形：prune claim + 克隆 replace，只改 inner text）
  const evs = session.snapshotEvents() as unknown as Array<{ type?: string; data?: unknown; seq: number }>
  const rSeq = [...session.surface.nodes].find(s => evs[s as number]?.type === 'tool/result')
  assert.ok(rSeq !== undefined)
  const stubData = JSON.parse(JSON.stringify((evs[rSeq as number] as { data?: unknown }).data ?? {}))
  stubData.message.content[0].content = [{ type: 'text', text: '[已剪·因子] read → document:c:/proj/a.ts' }]
  session.append('compaction/prune', {
    shadowedRange: { start: rSeq as never, end: rSeq as never }, shadowedSeqs: [rSeq as never], shadowedTokenCount: 10,
  } as never)
  session.append('tool/result', stubData as never, {
    surfaceOp: { op: 'replace', startSeq: rSeq as never, endSeq: rSeq as never },
    sourceEventSeqs: [rSeq as never],
  } as never)
  appendGroup(session, 2, 'c2', 'C:/Proj/focus.ts', 'FOCUS CONTENT')
  const result = internals.factor.compactIfNeeded(session, 100_000)
  assert.ok(result !== null, 'K pack 必须能独立启动事务（即使 R 未入选）')
  const texts = surfaceTexts(session)
  assert.ok(!texts.some(t => t.includes('C:/Proj/a.ts')), '旧 A（args）已离场')
  assert.ok(!texts.some(t => t.includes('[已剪·因子]')), '旧桩已随组离场')
  assert.ok(texts.some(t => t.includes('FOCUS CONTENT')), '焦点轮保留')
  assert.equal(factorCheckpoints(session).length, 1, 'K pack 落一个压缩检查点')
})

test('G4 孤儿 R（issuer 已离场）→ 空 developer，不落 tool 桩', async () => {
  const { internals } = await boot()
  const session = makeSession('group-orphan')
  internals.bindSession(session)
  appendUser(session, '任务', 1)
  // 无 issuer A 的 tool/result（callId=orphan）
  session.append('tool/call', { turn: 1, callId: 'orphan', name: 'read', arguments: JSON.stringify({ file_path: 'C:/Proj/orphan.ts' }) } as never)
  session.append('tool/result', {
    turn: 1, step: 1,
    message: {
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: 'orphan', content: [{ type: 'text', text: 'ORPHAN R' }], isError: false }],
      source: { kind: 'tool', callId: 'orphan' }, id: 'm_orphan',
    },
  } as never, { surfaceOp: 'append' })
  appendGroup(session, 2, 'c2', 'C:/Proj/focus.ts', 'FOCUS CONTENT')
  const result = internals.factor.compactIfNeeded(session, 100_000)
  assert.ok(result !== null)
  const texts = surfaceTexts(session)
  assert.ok(!texts.some(t => t.includes('ORPHAN R')), '孤儿 R 已离场')
  assert.ok(resultOf(session, 'orphan') === null, '不得落 tool 桩（否则孤儿 tool result → 400）')
  assert.equal(factorCheckpoints(session).length, 1, '孤儿 R 走压缩检查点')
})

test('G5 标签召回：组剪后 recall_history(labels) 仍取回 R 原文', async () => {
  const { ctx, internals } = await boot()
  const session = makeSession('group-recall')
  internals.bindSession(session)
  appendUser(session, '任务', 1)
  appendGroup(session, 1, 'c1', 'C:/Proj/a.ts', 'RECALL-ME CONTENT '.repeat(30))
  appendGroup(session, 2, 'c2', 'C:/Proj/b.ts', 'OTHER CONTENT')
  assert.ok(internals.factor.compactIfNeeded(session, 100_000) !== null)
  assert.ok(!surfaceTexts(session).some(t => t.includes('RECALL-ME')), '原文已离场')
  const hit = toolText(await execTool(ctx, {
    name: 'recall_history', callId: 'q1', agentSession: session, args: { labels: ['document:c:/proj/a.ts'] },
  }))
  assert.ok(hit.includes('RECALL-ME'), '组剪后标签仍可召回（账本按 R rootSeq 记账）')
})

test('G6 空 tool/result 克隆仍可 K pack（provenance 判桩，2026-11-13 审查 P0-3）', async () => {
  const { internals } = await boot()
  const session = makeSession('group-empty-stub')
  internals.bindSession(session)
  appendUser(session, '任务', 1)
  session.append('assistant/message', {
    stream: [], turn: 1, step: 1,
    message: createAssistantMessage({
      source: { provider: 'test', model: 'test' },
      content: [
        { type: 'text', text: 'doing tools' },
        { type: 'tool-call', id: 'c1', name: 'read', arguments: JSON.stringify({ file_path: 'C:/Proj/a.ts' }) },
        { type: 'tool-call', id: 'c2', name: 'read', arguments: JSON.stringify({ file_path: 'C:/Proj/b.ts' }) },
      ] as never,
    }),
  } as never, { surfaceOp: 'append' })
  session.append('tool/call', { turn: 1, callId: 'c1', name: 'read', arguments: JSON.stringify({ file_path: 'C:/Proj/a.ts' }) } as never)
  session.append('tool/call', { turn: 1, callId: 'c2', name: 'read', arguments: JSON.stringify({ file_path: 'C:/Proj/b.ts' }) } as never)
  appendResult(session, 1, 'c1', 'C1 CONTENT '.repeat(40))
  appendResult(session, 1, 'c2', 'C2 CONTENT '.repeat(40))
  // 模拟 R-only 空克隆：prune claim + 克隆原 R、inner text 置空（与生产同形）
  const r1 = resultOf(session, 'c1')
  assert.ok(r1 !== null)
  const evs = session.snapshotEvents() as unknown as Array<{ data?: unknown }>
  const empty = JSON.parse(JSON.stringify((evs[r1.seq] as { data?: unknown }).data ?? {}))
  empty.message.content[0].content = [{ type: 'text', text: '' }]
  session.append('compaction/prune', {
    shadowedRange: { start: r1.seq as never, end: r1.seq as never }, shadowedSeqs: [r1.seq as never], shadowedTokenCount: 10,
  } as never)
  session.append('tool/result', empty as never, {
    surfaceOp: { op: 'replace', startSeq: r1.seq as never, endSeq: r1.seq as never },
    sourceEventSeqs: [r1.seq as never],
  } as never)
  appendGroup(session, 2, 'c3', 'C:/Proj/focus.ts', 'FOCUS CONTENT')
  const result = internals.factor.compactIfNeeded(session, 100_000)
  assert.ok(result !== null, '空克隆必须被 provenance 认作桩，A+空桩+c2 才能整组 K pack')
  const texts = surfaceTexts(session)
  assert.ok(!texts.some(t => t.includes('C:/Proj/a.ts')), '旧 A args 离场')
  assert.ok(!texts.some(t => t.includes('C:/Proj/b.ts')), '旧 A args（c2）离场')
  assert.equal(factorCheckpoints(session).length, 1, '整组落一个压缩检查点')
})

test('G7 V3 callId（仅 content[0].toolCallId）分组不产生孤儿（审查 P0-4）', async () => {
  const { internals } = await boot()
  const session = makeSession('group-v3')
  internals.bindSession(session)
  appendUser(session, '任务', 1)
  session.append('assistant/message', {
    stream: [], turn: 1, step: 1,
    message: createAssistantMessage({
      source: { provider: 'test', model: 'test' },
      content: [{ type: 'text', text: 'doing read' }, { type: 'tool-call', id: 'c1', name: 'read', arguments: JSON.stringify({ file_path: 'C:/Proj/v3.ts' }) } as never],
    }),
  } as never, { surfaceOp: 'append' })
  session.append('tool/call', { turn: 1, callId: 'c1', name: 'read', arguments: JSON.stringify({ file_path: 'C:/Proj/v3.ts' }) } as never)
  // V3：source 无 callId，仅 content[0].toolCallId
  session.append('tool/result', {
    turn: 1, step: 1,
    message: {
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'V3 CONTENT '.repeat(30) }], isError: false }],
      source: { kind: 'tool' },
      id: 'm_v3',
    },
  } as never, { surfaceOp: 'append' })
  appendGroup(session, 2, 'c2', 'C:/Proj/focus.ts', 'FOCUS CONTENT')
  const result = internals.factor.compactIfNeeded(session, 100_000)
  assert.ok(result !== null, 'V3 callId 必须被 atomize 读出 ⇒ 正常组剪')
  const texts = surfaceTexts(session)
  assert.ok(!texts.some(t => t.includes('C:/Proj/v3.ts')), 'V3 A args 离场')
  assert.equal(factorCheckpoints(session).length, 1, 'V3 组也落压缩检查点')
  // 协议组完整性：不得留悬空 tool result
  const nodes = new Set(session.surface.nodes as readonly number[])
  const evs = session.snapshotEvents() as unknown as Array<{ seq: number; type: string; data?: Record<string, unknown> }>
  const liveCalls = new Set<string>()
  for (const e of evs) {
    if (!nodes.has(e.seq) || e.type !== 'assistant/message') continue
    const content = (e.data?.message as { content?: Array<{ type?: string; id?: string }> } | undefined)?.content
    for (const b of content ?? []) if (b.type === 'tool-call' && b.id !== undefined) liveCalls.add(b.id)
  }
  for (const e of evs) {
    if (!nodes.has(e.seq) || e.type !== 'tool/result') continue
    const content = (e.data?.message as { content?: Array<{ toolCallId?: string }> } | undefined)?.content
    const id = content?.[0]?.toolCallId
    assert.ok(id === undefined || liveCalls.has(id), '悬空 tool result = V3 callId 读取失败')
  }
})

test('G8 附件 R 不得被 forced 组剪吞掉（审查 P0-5）', async () => {
  const { internals } = await boot()
  const session = makeSession('group-attachment')
  internals.bindSession(session)
  appendUser(session, '任务', 1)
  session.append('assistant/message', {
    stream: [], turn: 1, step: 1,
    message: createAssistantMessage({
      source: { provider: 'test', model: 'test' },
      content: [
        { type: 'text', text: 'two calls, one interrupted' },
        { type: 'tool-call', id: 'c1', name: 'read', arguments: JSON.stringify({ file_path: 'C:/Proj/img.ts' }) },
        { type: 'tool-call', id: 'c2', name: 'read', arguments: JSON.stringify({ file_path: 'C:/Proj/missing.ts' }) },
      ] as never,
    }),
  } as never, { surfaceOp: 'append' })
  session.append('tool/call', { turn: 1, callId: 'c1', name: 'read', arguments: JSON.stringify({ file_path: 'C:/Proj/img.ts' }) } as never)
  session.append('tool/call', { turn: 1, callId: 'c2', name: 'read', arguments: JSON.stringify({ file_path: 'C:/Proj/missing.ts' }) } as never)
  appendResult(session, 1, 'c1', 'IMG R', [{ type: 'image' } as never])
  appendGroup(session, 2, 'c3', 'C:/Proj/focus.ts', 'FOCUS CONTENT')
  const result = internals.factor.compactIfNeeded(session, 100_000)
  assert.equal(result, null, '附件 R 在 ⇒ 组剪放弃（不能文本召回 image）')
  const texts = surfaceTexts(session)
  assert.ok(texts.some(t => t.includes('IMG R')), 'image R 仍在面')
  assert.ok(texts.some(t => t.includes('C:/Proj/img.ts')), 'A 仍在面')
  assert.equal(factorCheckpoints(session).length, 0, '不得落 group 检查点')
})

test('G9 压缩检查点事件形状可 deriveMessages（宿主 compact-checkpoint）', async () => {
  const { internals } = await boot()
  const session = Session.create(SessionId('group-dev-shape'))
  session.append('system/message', {
    turn: 0, step: 0, message: createSystemMessage('persona'),
  } as never, { surfaceOp: 'append' })
  internals.bindSession(session)
  appendUser(session, '任务', 1)
  appendGroup(session, 1, 'c1', 'C:/Proj/a.ts', 'SHAPE CONTENT')
  appendGroup(session, 2, 'c2', 'C:/Proj/focus.ts', 'FOCUS CONTENT')
  assert.ok(internals.factor.compactIfNeeded(session, 100_000) !== null)
  const messages = session.deriveMessages()
  assert.ok(Array.isArray(messages) && messages.length > 0, 'deriveMessages 不得因检查点 throw')
  assert.equal(messages.filter(m => m.role === 'developer').length, 0, '不使用 developer 占位（宿主边界非法）')
  const cps = factorCheckpoints(session)
  assert.equal(cps.length, 1, '组剪落一个 compact-checkpoint user message')
  assert.ok(eventText(session, cps[0].seq).startsWith(FACTOR_COMPACTED_MARKER))
})

test('G10 组区间不连续（A 与 R 夹着官方 X）⇒ 组剪放弃，A 保留 + R 空桩（审查 P0-2）', async () => {
  const { internals } = await boot()
  const session = makeSession('group-contiguity')
  internals.bindSession(session)
  appendUser(session, '任务', 1)
  session.append('assistant/message', {
    stream: [], turn: 1, step: 1,
    message: createAssistantMessage({
      source: { provider: 'test', model: 'test' },
      content: [{ type: 'text', text: 'doing read' }, { type: 'tool-call', id: 'c1', name: 'read', arguments: JSON.stringify({ file_path: 'C:/Proj/a.ts' }) } as never],
    }),
  } as never, { surfaceOp: 'append' })
  session.append('tool/call', { turn: 1, callId: 'c1', name: 'read', arguments: JSON.stringify({ file_path: 'C:/Proj/a.ts' }) } as never)
  session.append('developer/message', { content: '官方公告（不可吞 X）', turn: 1 } as never, { surfaceOp: 'append' })
  appendResult(session, 1, 'c1', 'SPLIT R')
  appendGroup(session, 2, 'c2', 'C:/Proj/focus.ts', 'FOCUS CONTENT')
  const result = internals.factor.compactIfNeeded(session, 100_000)
  assert.ok(result !== null)
  const texts = surfaceTexts(session)
  assert.ok(texts.some(t => t.includes('C:/Proj/a.ts')), 'A 保留（组不连续，不误吞夹心 X）')
  assert.ok(!texts.some(t => t.includes('SPLIT R')), 'R 走空 tool/result')
  assert.equal(factorCheckpoints(session).length, 0, '不得落 group 检查点（连续性检查拒绝）')
})
