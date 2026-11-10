/**
 * src/factor/ua-summarizer.ts 编排契约（design-2.0 §2.4）：LLM 经 complete 注入，
 * 零网络。锁面：双门控（池阈值自判/disabled 静默）、发射成对与配对地板（N-P0-1）、
 * 约束带逐字追加、保守档、守卫重试后保原文、异步窗后漂移弃段。
 *
 * 变异台账（摘锁必须变红，已逐条执行）：
 *  US1 池门控**双保险整体**摘除（gate 的 return 与选取循环的 acc>=need 同时删）→ T1 红；
 *     （实测单删任一层另一层兜住仍绿——门控与选取数学互为冗余防御，锁的是合取行为）
 *  US2 保守档删（空承重+有约束也压）→ T4 红；
 *  US3 守卫删（LLM 胡写也发射）→ T5 红；
 *  US4 漂移复核删（surface 换代后仍发射旧段）→ T6 红；
 *  US5 约束带不进 X 文本 → T3 红；
 *  US6 summary 事件谎报 0-LLM（factor-ua 文案/model 退化）→ T2 红。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ArgpGraphEngine } from '../src/argp-graph-engine.ts'
import { UaSummarizer } from '../src/factor/ua-summarizer.ts'
import { sessionEvents } from '../src/log-access.ts'

function appendUser(session: Session, text: string, source?: Record<string, unknown>): void {
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: (source ?? { kind: 'user' }) as never,
  }), { surfaceOp: 'append' })
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

function makeSession(id: string): Session {
  const session = Session.create(SessionId(id))
  session.append('system/message', { content: 'persona' } as never, { surfaceOp: 'append' })
  return session
}

interface EngineInternals {
  bindSession(session: Session): void
}

/** 4 个旧轮（U+A(tc)+R 组）+ 焦点轮 5。池燃料充足。 */
function buildHistory(session: Session): void {
  appendUser(session, '按 docs/plan.md 推进，先跑 npm test 看基线')
  appendGroup(session, 1, 'c1', 'bash', '{"command":"npm test"}', 'FAILURES! exit code 1 ERR_ASSERTION deepEqual mismatch')
  appendGroup(session, 2, 'c2', 'bash', '{"command":"npm test"}', 'FAILURES! exit code 1 ERR_TIMEOUT async hook')
  appendUser(session, '继续修')
  appendGroup(session, 3, 'c3', 'read', '{"file_path":"C:/Proj/src/a.ts"}', 'export const A = 1')
  appendGroup(session, 4, 'c4', 'bash', '{"command":"cargo test"}', 'test result: ok. 42 passed')
  appendUser(session, '好，收尾')
  appendGroup(session, 5, 'c5', 'read', '{"file_path":"C:/Proj/src/z.ts"}', 'focus 活体不动')
}

async function boot(): Promise<{ ctx: Context; internals: EngineInternals }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: 'ua summarizer persona' } })
  await ctx.plugin(ArgpGraphEngine, { engine: 'factor', windowTokens: 100, retainTokens: 50, recencyGuard: 0 })
  const internals = ctx.compaction as unknown as EngineInternals
  return { ctx, internals }
}

/** 照单全收型假 LLM：把提示里"必须逐字出现"的 token 清单原样带上。 */
const obedientLlm = async (_spec: unknown, prompt: string): Promise<string> => {
  const m = prompt.match(/必须逐字出现的 token：([^\n]*)\n/)
  const list = m?.[1] ?? ''
  const toks = list === '（无）' || list === '' ? [] : list.split('、')
  return '两轮测试失败后定位修复，最终 42 通过。' + toks.join(' ')
}

function makeSummarizer(ctx: Context, host: object, cfg: Partial<ConstructorParameters<typeof UaSummarizer>[2]> = {}): UaSummarizer {
  return new UaSummarizer(ctx, host as never, { uaSummaryThreshold: 40, focalTurns: 1, ...cfg })
}

function surfacePairingBalanced(session: Session): boolean {
  const nodes = new Set(session.surface.nodes as readonly number[])
  const events = sessionEvents(session) as unknown as Array<{ seq: number; type: string; data?: Record<string, unknown> }>
  const liveA = new Set<string>()
  for (const e of events) {
    if (!nodes.has(e.seq) || e.type !== 'assistant/message') continue
    const content = (e.data?.message as { content?: Array<{ type?: string; id?: string }> } | undefined)?.content
    for (const b of content ?? []) if (b.type === 'tool-call' && b.id !== undefined) liveA.add(b.id)
  }
  for (const e of events) {
    if (!nodes.has(e.seq) || e.type !== 'tool/result') continue
    const content = (e.data?.message as { content?: Array<{ toolCallId?: string }> } | undefined)?.content
    const id = content?.[0]?.toolCallId
    if (id !== undefined && !liveA.has(id)) return false
  }
  return true
}

test('池门控：阈值下不摘、零 LLM 调用（US1 锁）', async () => {
  const { ctx, internals } = await boot()
  const session = makeSession('ua-gate')
  internals.bindSession(session)
  appendUser(session, '很短')
  appendGroup(session, 1, 'c1', 'bash', '{"command":"ls"}', 'ok')
  appendUser(session, '收')
  let calls = 0
  const ua = makeSummarizer(ctx, internals, { uaSummaryThreshold: 40_000, complete: async () => { calls += 1; return 'x' } })
  const r = await ua.summarize(session, { provider: 'p', model: 'm' })
  assert.equal(r, null)
  assert.equal(calls, 0)
})

test('发射路径：成对事务+因子摘要文案如实标 LLM+surface 配对地板不破（US6 锁）', async () => {
  const { ctx, internals } = await boot()
  const session = makeSession('ua-emit')
  internals.bindSession(session)
  buildHistory(session)
  const ua = makeSummarizer(ctx, internals, { complete: obedientLlm })
  const r = await ua.summarize(session, { provider: 'p', model: 'm' })
  assert.ok(r !== null, '池过阈值必须发射')
  const events = sessionEvents(session) as unknown as Array<{ type: string; data?: Record<string, unknown> }>
  const prunes = events.filter(e => e.type === 'compaction/prune')
  const summaries = events.filter(e => e.type === 'compaction/summary')
  const uaSummary = summaries.find(e => String(JSON.stringify(e.data ?? '')).includes('因子摘要'))
  assert.ok(uaSummary !== undefined, 'summary 走 factor-ua 口径')
  assert.equal((uaSummary?.data as { model?: string } | undefined)?.model, 'llm-batch-summary', 'LLM 参与如实记录（禁 0-LLM 宣称）')
  assert.ok(prunes.length >= 1, '成对：至少一条 shadow-price prune')
  assert.ok(surfacePairingBalanced(session), 'N-P0-1 地板：surface 上无孤儿 tool-result（无 provider 400 形态）')
  // 焦点轮（turn5）的组逐字留守
  const stillLive = sessionEvents(session).some(e => JSON.stringify(e.data ?? '').includes('focus 活体不动'))
  assert.ok(stillLive, '焦点轮活体不参摘')
})

test('约束带逐字追加在生成之外（US5 锁）', async () => {
  const { ctx, internals } = await boot()
  const session = makeSession('ua-band')
  internals.bindSession(session)
  appendUser(session, '必须保留 src/a.ts 的导出名。随便聊聊别的')
  appendGroup(session, 1, 'c1', 'bash', '{"command":"ls"}', 'a.ts')
  appendUser(session, '继续')
  appendGroup(session, 2, 'c2', 'read', '{"file_path":"C:/x/y.ts"}', 'export const KEEP_ME = 1 // 见 URL https://ex.com/z')
  appendUser(session, '好')
  appendGroup(session, 3, 'c3', 'read', '{"file_path":"C:/x/w.ts"}', 'focus')
  // 假 LLM 故意不带约束句
  const ua = makeSummarizer(ctx, internals, {
    uaSummaryThreshold: 40,
    complete: async (_s, prompt) => {
      const m = prompt.match(/必须逐字出现的 token：([^\n]*)\n/)
      return '摘要正文。' + (m?.[1] === '（无）' ? '' : (m?.[1] ?? ''))
    },
  })
  const r = await ua.summarize(session, { provider: 'p', model: 'm' })
  assert.ok(r !== null)
  // 注意取的是 X 墓碑（前缀 '[因子摘要 turn'），不是 compaction/summary（文案也含"因子摘要"）。
  const xText = sessionEvents(session)
    .filter(e => e.type === 'user/message')
    .map(e => JSON.stringify(e.data ?? ''))
    .find(t => t.includes('[因子摘要 turn')) ?? ''
  assert.ok(xText.includes('约束带·逐字'), 'X 文本带约束带分区')
  assert.ok(xText.includes('必须保留 src/a.ts 的导出名。'), '约束句逐字存活（LLM 没写也补上）')
})

test('保守档：空承重集 ∧ 约束命中 >0 → 保原文零调用（US2 锁）', async () => {
  const { ctx, internals } = await boot()
  const session = makeSession('ua-conservative')
  internals.bindSession(session)
  // U 全是散文约束、无硬 token；R 也无码无 URL ⇒ 守卫无从验证
  appendUser(session, '必须每天跑测试。不得跳过评审。全部用中文回答')
  appendGroup(session, 1, 'c1', 'bash', '{"command":"ls"}', 'all fine')
  appendUser(session, '继续推进')
  appendGroup(session, 2, 'c2', 'bash', '{"command":"ls"}', 'still fine')
  appendUser(session, '收尾')
  appendGroup(session, 3, 'c3', 'bash', '{"command":"pwd"}', 'focus')
  let calls = 0
  const ua = makeSummarizer(ctx, internals, {
    uaSummaryThreshold: 40,
    complete: async () => { calls += 1; return '不该被调到' },
  })
  const r = await ua.summarize(session, { provider: 'p', model: 'm' })
  assert.equal(r, null, '保守档：全段保原文')
  assert.equal(calls, 0, '保守档判定在 LLM 调用之前')
})

test('守卫两次不过 → 保原文（重试一次后仍缺即弃）（US3 锁）', async () => {
  const { ctx, internals } = await boot()
  const session = makeSession('ua-guard')
  internals.bindSession(session)
  buildHistory(session)
  let calls = 0
  const ua = makeSummarizer(ctx, internals, {
    complete: async () => { calls += 1; return '无关摘要，什么 token 都没带' },
  })
  const r = await ua.summarize(session, { provider: 'p', model: 'm' })
  assert.equal(r, null, '守卫不过绝不发射')
  assert.ok(calls >= 1, 'LLM 被调了（守卫在调用后判）')
  assert.ok(!sessionEvents(session).some(e => JSON.stringify(e.data ?? '').includes('因子摘要')), '零摘要事件')
})

test('异步窗后漂移：段内节点换代 → 弃该段（US4 锁）', async () => {
  const { ctx, internals } = await boot()
  const session = makeSession('ua-drift')
  internals.bindSession(session)
  buildHistory(session)
  const eventsBefore = sessionEvents(session) as unknown as Array<{ seq: number; type: string; data?: Record<string, unknown>; surfaceOp?: unknown }>
  const target = eventsBefore.find(e => e.type === 'tool/result'
    && String(JSON.stringify(e.data ?? '')).includes('ERR_ASSERTION')) as { seq: number; data: Record<string, unknown> }
  const ua = makeSummarizer(ctx, internals, {
    complete: async (_s, prompt) => {
      // LLM 窗内模拟并发换代：段内某个 R 被单节点 replace（surface 节点换 seq）
      const msg = target.data.message as { content: unknown[] }
      const cloned = JSON.parse(JSON.stringify(msg)) as { content: Array<{ content?: Array<{ type?: string; text?: string }> }> }
      cloned.content[0]!.content = [{ type: 'text', text: '并发改写' }]
      session.append('tool/result', { ...target.data, message: cloned } as never, {
        surfaceOp: { op: 'replace', startSeq: target.seq as never, endSeq: target.seq as never },
        // 宿主 assertSourceEventReferences：replace 必须逐一点名被遮蔽的 surface 节点。
        sourceEventSeqs: [target.seq] as never,
      })
      const m = prompt.match(/必须逐字出现的 token：([^\n]*)\n/)
      return '摘要。' + (m?.[1] === '（无）' ? '' : (m?.[1] ?? ''))
    },
  })
  const r = await ua.summarize(session, { provider: 'p', model: 'm' })
  // 本布局 turn1-4 之间无 excluded/X/屏障 ⇒ 恰一个段；段内唯一 R 换代 ⇒ 整批弃、零事件。
  assert.equal(r, null, '唯一段漂移 ⇒ 弃批')
  const emitted = sessionEvents(session).some(e => JSON.stringify(e.data ?? '').includes('因子摘要'))
  assert.ok(!emitted, '零摘要/prune 事件')
  const nodes = new Set(session.surface.nodes as readonly number[])
  assert.ok(!nodes.has(target.seq), '被换代 seq 已离场（漂移确已发生，非空转自证）')
  assert.ok(surfacePairingBalanced(session), '配对地板不破')
})
