/**
 * 系统级动态词表目录（2.2.3）。
 *
 * 锁面：
 *  - 有 systemPrompt.context 时，目录由 context provider 读取**事务收尾快照**，
 *    不再写会话流 note（避免双份目录与 steer 失败导致模型看不到地址）；
 *  - 快照只在显式 refresh 时更新；provider 本身不重新 observe live ledger；
 *  - 多会话各持自己的目录，不串台；
 *  - 无 systemPrompt 服务时仍由 factor.refreshVocabularyNote 承担旧 note 降级
 *    （既有 factor-vocab.test.ts 继续锁旧通道）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ArgpEngine } from '../src/argp-engine.ts'
import { FactorEngine, VOCAB_NOTE_MARKER } from '../src/factor/engine.ts'
import { sessionEvents } from '../src/log-access.ts'

function makeSession(id: string): Session {
  const session = Session.create(SessionId(id))
  session.append('system/message', { content: 'persona' } as never, { surfaceOp: 'append' })
  return session
}

function appendUser(session: Session, text: string): void {
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
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

function prunedReadPair(session: Session, factor: FactorEngine): void {
  appendUser(session, '开始任务')
  appendGroup(session, 1, 'c1', 'read', '{"file_path":"C:/Proj/ctx-a.ts"}', 'OLD CONTENT'.repeat(50))
  appendGroup(session, 2, 'c2', 'read', '{"file_path":"C:/Proj/ctx-b.ts"}', 'NEW CONTENT'.repeat(50))
  assert.ok(factor.compactIfNeeded(session, 1000) !== null, '前置剪枝必须发射')
}

interface TestEngine {
  factor: FactorEngine
  vocabContextRegistered: boolean
  bindSession(session: Session): void
  refreshFactorNoteSafe(agent: { session: Session }): Promise<void>
}

async function boot(): Promise<{ ctx: Context; engine: ArgpEngine; internals: TestEngine }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: 'vocab context persona' } })
  await ctx.plugin(ArgpEngine, { engine: 'factor', windowTokens: 100, retainTokens: 50, recencyGuard: 0 })
  const engine = ctx.compaction as ArgpEngine
  return { ctx, engine, internals: engine as unknown as TestEngine }
}

/** 用真实 systemPrompt 装配面取上下文；context provider 会拿到 agent.session。 */
async function vocabularyContext(ctx: Context, session: Session): Promise<string | undefined> {
  const sp = (ctx as unknown as {
    systemPrompt: { assemble(context: unknown): Promise<{ contexts: { name: string; text?: string }[] }> }
  }).systemPrompt
  const assembly = await sp.assemble({ agent: { session } })
  return assembly.contexts.find(c => c.name === 'argp:vocabulary')?.text
}

function contextTextOf(assembly: { contexts: { name: string; text?: string }[] }): string | undefined {
  return assembly.contexts.find(c => c.name === 'argp:vocabulary')?.text
}

test('同一请求：pre-step 前装配 → 事务收尾刷新 → refreshContext 可见', async (t) => {
  const { ctx, internals } = await boot()
  const session = makeSession('vocab-context-refresh')
  internals.bindSession(session)
  const sp = (ctx as unknown as {
    systemPrompt: {
      assemble(context: unknown): Promise<{ contexts: { name: string; text?: string }[] }>
      refreshContext?: (assembly: unknown, context: unknown) => { contexts: { name: string; text?: string }[] }
    }
  }).systemPrompt
  // 本锁面锁的是宿主**新增**的 systemPrompt.refreshContext API（peer 地板 0.2.0-rc.1 没有）。
  // 生产侧不调用它、按服务存在性降级（无服务走 note 通道，factor-vocab.test.ts 锁旧通道），
  // 故旧宿主上这是不存在的契约——能力探测缺席即跳过，不是回归。
  if (typeof sp.refreshContext !== 'function') {
    t.skip('宿主无 systemPrompt.refreshContext（0.2.0-rc.1 线）：该契约不存在，生产降级路径由 note 通道锁覆盖')
    return
  }
  // 模拟宿主 pre-step：先装配旧 assembly，再在钩子里做压缩事务。
  const before = await sp.assemble({ agent: { session } })
  assert.equal(contextTextOf(before) ?? '', '', '压缩前无目录')
  prunedReadPair(session, internals.factor)
  await internals.refreshFactorNoteSafe({ session })
  // 宿主 step() 的真实路径：对旧 assembly 重新求值 context。
  // 必须以方法形态调用（服务实现依赖 this），不能摘成自由函数。
  const refreshed = sp.refreshContext(before, { agent: { session } })
  const text = contextTextOf(refreshed)
  assert.ok(text !== undefined && text.includes('document:c:/proj/ctx-a.ts'), '同一次请求的 refreshContext 必须看到新目录')
})

function surfaceHasVocabularyNote(session: Session): boolean {
  return [...session.surface.nodes].some(seq => {
    const e = (sessionEvents(session) as unknown as { seq: number; type: string; data?: { content?: unknown } }[])
      .find(x => x.seq === (seq as number))
    return e?.type === 'user/message' && JSON.stringify(e.data?.content ?? '').includes(VOCAB_NOTE_MARKER)
  })
}

test('目录携带置信语义：证据被剪既不算确认也不算反驳，复核走召回', async () => {
  const { ctx, internals } = await boot()
  const session = makeSession('vocab-context-confidence')
  internals.bindSession(session)
  prunedReadPair(session, internals.factor)
  await internals.refreshFactorNoteSafe({ session })
  const text = await vocabularyContext(ctx, session)
  assert.ok(text !== undefined)
  // 病灶：模型看到结论却看不到支撑证据 ⇒ 重做一遍或悄悄降级表述。目录必须显式否掉这条推论。
  assert.match(text, /Elision is not a verdict/, '★缺证据不得被读成改判')
  assert.match(text, /neither confirms nor refutes/, '两个方向都封住（既不升级也不降级）')
  assert.match(text, /recall the original and re-check/, '正确动作 = 召回原文核对')
})

test('压缩事务收尾：systemPrompt.context 可见目录，且不再重复写 note', async () => {
  const { ctx, internals } = await boot()
  const session = makeSession('vocab-context-prune')
  internals.bindSession(session)
  assert.ok(internals.vocabContextRegistered, 'systemPrompt 已挂载时 context 必须注册')
  prunedReadPair(session, internals.factor)
  await internals.refreshFactorNoteSafe({ session })
  const text = await vocabularyContext(ctx, session)
  assert.ok(text !== undefined && text.includes('document:c:/proj/ctx-a.ts'), '目录必须含被剪标签')
  assert.ok(text.includes('recall_history'), '目录必须携带召回触发说明')
  assert.equal(surfaceHasVocabularyNote(session), false, 'context 生效时不再写会话流 note')
  const again = await vocabularyContext(ctx, session)
  assert.equal(again, text, '两次装配之间目录字节稳定（只随事务刷新）')
})

test('快照只在事务收尾刷新：账本已前进但未 refresh 时 context 保持旧字节', async () => {
  const { ctx, internals } = await boot()
  const session = makeSession('vocab-context-freeze')
  internals.bindSession(session)
  prunedReadPair(session, internals.factor)
  await internals.refreshFactorNoteSafe({ session })
  const before = await vocabularyContext(ctx, session)
  assert.ok(before !== undefined && before.includes('ctx-a.ts'))

  // 直接推进 factor 账本（模拟一笔不经过本引擎收尾的观察/剪枝）：
  // provider 若读 live ledger 会立即出现 command:npm。
  appendGroup(session, 3, 'b1', 'bash', '{"command":"npm run ctx-test"}', 'out ' + 'x'.repeat(400))
  appendGroup(session, 4, 'c4', 'read', '{"file_path":"C:/Proj/ctx-c.ts"}', 'focus elsewhere')
  assert.ok(internals.factor.compactIfNeeded(session, 1000) !== null)
  const frozen = await vocabularyContext(ctx, session)
  assert.equal(frozen, before, '未 refresh 时必须保持事务收尾快照，不读 live ledger')
  assert.ok(!frozen?.includes('command:npm'), '新剪标签不得自动漂进目录')

  await internals.refreshFactorNoteSafe({ session })
  const updated = await vocabularyContext(ctx, session)
  assert.ok(updated?.includes('command:npm'), '显式事务收尾后目录才更新')
})

test('多会话隔离：A 的目录不得泄漏到 B', async () => {
  const { ctx, internals } = await boot()
  const bind = (s: Session): void => internals.bindSession(s)
  const a = makeSession('vocab-context-a')
  const b = makeSession('vocab-context-b')
  bind(a)
  prunedReadPair(a, internals.factor)
  await internals.refreshFactorNoteSafe({ session: a })
  bind(b)
  const textB = await vocabularyContext(ctx, b)
  assert.ok(textB === undefined || !textB.includes('ctx-a.ts'), 'B 看不到 A 被剪标签')
})
