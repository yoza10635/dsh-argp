/**
 * §B-2 接管形态验收：结构去重驱逐、§C 分派器核准跳闸一、takeover 发射（prune-only
 * 不触浓缩链）、terminal-b6 连续计数不空转。
 *
 * 地面真值锚（2026-11-25 三域影子对照）：工具域=仅剪（0-LLM）；terminal-b6 只在
 * 不可剪残余超 W_eff 时出现，≥3 轮连击必须停止空转。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ArgpEngine } from '../src/argp-engine.ts'
import { ProseCondenser, PROSE_CHECKPOINT_PREFIX } from '../src/factor/prose-condenser.ts'
import { FactorEngine, type FactorEngineHost } from '../src/factor/engine.ts'
import { sessionEvents, eventText } from '../src/log-access.ts'

function appendUser(session: Session, text: string, turn?: number): void {
  session.append('user/message', {
    ...createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
    ...(turn === undefined ? {} : { turn }),
  } as never, { surfaceOp: 'append' })
}

/** 宿主再注入原子（form/kind 结构化标记，surface 落 user/message——档案实锤形状）。 */
function appendInjected(session: Session, kind: string, form: string, text: string, turn = 1): void {
  session.append('user/message', {
    ...createUserMessage({ content: [{ type: 'text', text }], source: { kind, form } as never }),
    turn,
  } as never, { surfaceOp: 'append' })
}

function appendGroup(session: Session, turn: number, callId: string, tool: string, args: string, resultText: string): void {
  session.append('assistant/message', {
    stream: [], turn, step: 1,
    message: createAssistantMessage({
      source: { provider: 'test', model: 'test' },
      content: [{ type: 'text', text: 'doing ' + tool }, { type: 'tool-call', id: callId, name: tool, arguments: args } as never],
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

function surfTexts(session: Session): string[] {
  return [...session.surface.nodes].map(s => eventText(session, s as number))
}

async function boot(config: Record<string, unknown> = {}): Promise<{ ctx: Context; engine: ArgpEngine; host: FactorEngineHost; factor: FactorEngine }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: 'takeover test persona' } })
  await ctx.plugin(ArgpEngine, { recencyGuard: 0, maxPasses: 8, ...config })
  const engine = ctx.compaction as ArgpEngine
  const host = engine as unknown as FactorEngineHost
  return { ctx, engine, host, factor: new FactorEngine(host) }
}

test('§B-2a 结构去重：宿主再注入旧副本整节点离场，每 kind 保留最新；幂等', async () => {
  const { host, factor } = await boot({ windowTokens: 100_000, retainTokens: 50 })
  const session = Session.create(SessionId('dedup-1'))
  session.append('system/message', { content: 'persona' } as never, { surfaceOp: 'append' })
  host.bindSession(session)
  appendUser(session, '开始任务')
  appendInjected(session, 'agent-instructions', 'instructions', 'GLOSSARY V1 ' + 'a'.repeat(800))
  appendGroup(session, 1, 'c1', 'read', '{"file_path":"C:/x.ts"}', 'R1')
  appendInjected(session, 'agent-instructions', 'instructions', 'GLOSSARY V2 ' + 'b'.repeat(800), 2)
  appendInjected(session, 'skill-catalog', 'catalog', 'CATALOG V1')
  appendInjected(session, 'skill-catalog', 'catalog', 'CATALOG V2', 2)
  const r = factor.dedupeReinjected(session)
  assert.ok(r !== null, '有重复副本必须发射去重事务')
  const texts = surfTexts(session)
  assert.ok(texts.some(t => t.includes('GLOSSARY V2')), '最新副本保留')
  assert.ok(!texts.some(t => t.includes('GLOSSARY V1')), '旧副本驱逐')
  assert.ok(texts.some(t => t.includes('CATALOG V2')) && !texts.some(t => t.includes('CATALOG V1')), 'catalog 同规则')
  assert.ok(texts.some(t => t.includes('开始任务')), '真 user 消息不动')
  assert.equal(factor.dedupeReinjected(session), null, '再去重无可驱逐 ⇒ null（幂等）')
})

test('§C 分派器核准跳闸一：占比不过旧闸一时，approved 仍浓缩；未核准字节不变', async () => {
  const { ctx, engine } = await boot({ windowTokens: 100_000, retainTokens: 50 })
  const session = Session.create(SessionId('gate-bypass'))
  session.append('system/message', { content: 'persona' } as never, { surfaceOp: 'append' })
  ;(engine as unknown as { bindSession: (s: Session) => void }).bindSession(session)
  for (let t = 1; t <= 3; t++) appendUser(session, '轮次 ' + t + ' 的散文内容 ' + 'x'.repeat(200), t)
  let calls = 0
  const prose = new ProseCondenser(ctx, engine as never, {
    focalTurns: 1,
    complete: async () => { calls += 1; return '浓缩检查点。' },
  })
  const off = await prose.condense(session, { provider: 't', model: 'm' }, 100_000, undefined, 100_000)
  assert.equal(off, null, '未核准 + 占比不过闸一 ⇒ 不动作（现网锁）')
  assert.equal(calls, 0)
  const on = await prose.condense(session, { provider: 't', model: 'm' }, 100_000, undefined, 100_000,
    { approved: true, maxOutputTokens: 4096 })
  assert.ok(on !== null, '分派器核准必须浓缩（闸一主权移交判据表）')
  assert.equal(calls, 1, '核准路径才起 LLM')
  assert.ok(surfTexts(session).some(t => t.startsWith(PROSE_CHECKPOINT_PREFIX)), '检查点落 surface')
})

test('§B-2b takeover prune-only：按形态发射且不触浓缩链；决策落盘 mode=takeover', async () => {
  const logf = join(tmpdir(), 'argp-dispatch-tko-' + Date.now() + '.jsonl')
  process.env['ARGP_FACTOR_DISPATCH'] = '2'
  process.env['ARGP_FACTOR_DISPATCH_LOG'] = logf
  try {
    const { engine } = await boot({ windowTokens: 100_000, retainTokens: 50 })
    const session = Session.create(SessionId('tko-prune'))
    session.append('system/message', { content: 'persona' } as never, { surfaceOp: 'append' })
    ;(engine as unknown as { declaredContextWindows: WeakMap<Session, number> }).declaredContextWindows.set(session, 64_000)
    ;(engine as unknown as { bindSession: (s: Session) => void }).bindSession(session)
    appendUser(session, '开始任务')
    appendGroup(session, 1, 'c1', 'read', '{"file_path":"C:/Proj/a.ts"}', 'OLD CONTENT'.repeat(60))
    appendGroup(session, 2, 'c2', 'read', '{"file_path":"C:/Proj/b.ts"}', 'NEW CONTENT'.repeat(60))
    appendUser(session, '收尾')
    const agent = { session, options: {} } as never
    const result = await engine.compactIfNeeded(agent, 'pressure', new AbortController().signal)
    assert.ok(result !== null, 'prune-only 形态必须发射组剪')
    const texts = surfTexts(session)
    assert.ok(!texts.some(t => t.includes('OLD CONTENT')), '旧 R 随组离场')
    assert.ok(!texts.some(t => t.startsWith(PROSE_CHECKPOINT_PREFIX)), 'prune-only 不得触浓缩链')
    const rec = JSON.parse(readFileSync(logf, 'utf-8').trim().split('\n').pop() as string)
    assert.equal(rec.mode, 'takeover')
    assert.equal(rec.form, 'prune-only')
    assert.match(rec.reason, /仅剪/)
  } finally {
    delete process.env['ARGP_FACTOR_DISPATCH']
    delete process.env['ARGP_FACTOR_DISPATCH_LOG']
    if (existsSync(logf)) unlinkSync(logf)
  }
})

test('§B-2b terminal-b6 连续计数：第 3 轮起不空转（求生剪也停），计数落桶', async () => {
  const { engine } = await boot({ windowTokens: 1024, retainTokens: 128 })
  const session = Session.create(SessionId('tko-b6'))
  session.append('system/message', { content: 'persona' } as never, { surfaceOp: 'append' })
  ;(engine as unknown as { declaredContextWindows: WeakMap<Session, number> }).declaredContextWindows.set(session, 1024)
  const bind = engine as unknown as { bindSession: (s: Session) => void }
  bind.bindSession(session)
  // 全 user 面（无可剪 R）+ 无再注入副本：F ≈ C > W_eff=1024 ⇒ terminal-b6。
  appendUser(session, 'U'.repeat(5000))
  const st = (engine as unknown as { stateOf: (s: Session) => { b6Streak: number } }).stateOf(session)
  const agent = { session, options: {} } as never
  const signals = () => new AbortController().signal
  process.env['ARGP_FACTOR_DISPATCH'] = '2'
  try {
    await engine.compactIfNeeded(agent, 'pressure', signals())
    assert.equal(st.b6Streak, 1)
    await engine.compactIfNeeded(agent, 'pressure', signals())
    assert.equal(st.b6Streak, 2)
    const eventsBefore = sessionEvents(session).length
    const r3 = await engine.compactIfNeeded(agent, 'pressure', signals())
    assert.equal(st.b6Streak, 3)
    assert.equal(r3, null, '第 3 轮起不空转：不发射任何事务')
    assert.equal(sessionEvents(session).length, eventsBefore, '不空转=零写入')
  } finally {
    delete process.env['ARGP_FACTOR_DISPATCH']
  }
})
