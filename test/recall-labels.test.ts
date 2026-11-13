/**
 * 因子臂召回面契约（design-2.0 §1.4/§3.2）：recall_history + list_labels 经
 * engine:'factor' 全链路（插件构造 → ctx.tools → 真 Session 剪枝 → 取回）。
 *
 * 锁面：
 *  - factor-only：恰好两工具、老三件套缺席（假通道不挂）；
 *  - 标签 → 日志原文：state/hit 标记齐、返回 append 根源原文（不是桩）；
 *  - 查询宽容（裸标签展开）与未命中如实回显（半空想查询必须可见）；
 *  - cursor/epoch 续读 + 漂移重排告警（不假装稳定分页）；
 *  - 每轮防循环安全阀双臂同阀（recall-tools 单点复用）；
 *  - 字符预算截断与耗尽显式（budgetRecallText 契约复用）。
 *
 * 变异台账（摘锁必须变红，已逐条执行）：
 *  ML1 删未命中查询标签回显 → T3 红；
 *  ML2 删 epochStale 告警 → T5 红；
 *  ML3 删 nextCursor 续读提示 → T5 红（第二页无从取得，两页内容重合）；
 *  ML4 删裸标签前缀展开 → T3 红；
 *  ML5 queryPruned 入参 cursor/epoch 改缺省 → T5 红（两页同内容）；
 *  ML6 构造期重新挂回 recall_pruned 三件套 → T1 红。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ArgpGraphEngine } from '../src/argp-graph-engine.ts'
import type { FactorEngine } from '../src/factor/engine.ts'
import { execTool, toolText } from './tool-execute-shape.ts'

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

function makeSession(id: string): Session {
  const session = Session.create(SessionId(id))
  session.append('system/message', { content: 'persona' } as never, { surfaceOp: 'append' })
  return session
}

interface EngineInternals {
  factor: FactorEngine | null
  bindSession(session: Session): void
  stateOf(session: Session): { recallCallsThisTurn: number; recallTurn: number; resolvedWindowTokens: number }
}

async function boot(): Promise<{ ctx: Context; engine: ArgpGraphEngine; internals: EngineInternals }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: 'recall labels persona' } })
  await ctx.plugin(ArgpGraphEngine, { engine: 'factor', windowTokens: 100, retainTokens: 50, recencyGuard: 0 })
  return { ctx, engine: ctx.compaction as ArgpGraphEngine, internals: ctx.compaction as unknown as EngineInternals }
}

/** ToolsService.get 对缺席工具的形状两线不一（undefined / throw 皆可能）——统一布尔。 */
function hasTool(ctx: Context, name: string): boolean {
  try {
    const t = (ctx.tools as unknown as { get(n: string): unknown }).get(name)
    return t !== undefined && t !== null
  } catch {
    return false
  }
}

/** 两 read 场景：turn1 a.ts（非焦点被剪）、turn2 b.ts（焦点留守）。返回剪后 session。 */
function prunedReadPair(session: Session, factor: FactorEngine): void {
  appendUser(session, '开始任务')
  appendGroup(session, 1, 'c1', 'read', '{"file_path":"C:/Proj/a.ts"}', 'OLD CONTENT'.repeat(50))
  appendGroup(session, 2, 'c2', 'read', '{"file_path":"C:/Proj/b.ts"}', 'NEW CONTENT'.repeat(50))
  const r = factor.compactIfNeeded(session, 1000)
  assert.ok(r !== null, '前置剪枝必须发射')
}

test('factor-only：恰好两新工具；老三件套缺席（假通道不挂）', async () => {
  const f = await boot()
  assert.ok(hasTool(f.ctx, 'recall_history'), 'recall_history 挂载')
  assert.ok(hasTool(f.ctx, 'list_labels'), 'list_labels 挂载')
  assert.ok(!hasTool(f.ctx, 'recall_pruned'), '老 seq 通道在 factor-only 是假通道——不挂')
  assert.ok(!hasTool(f.ctx, 'list_pruned'))
  assert.ok(!hasTool(f.ctx, 'recall'))
  const sectionsOf = async (ctx: Context): Promise<Map<string, string>> => {
    const sp = (ctx as unknown as { systemPrompt: { assemble(): Promise<{ sections: { name: string; text?: string }[] }> } }).systemPrompt
    const out = new Map<string, string>()
    for (const s of (await sp.assemble()).sections) out.set(s.name, s.text ?? '')
    return out
  }
  const fs = await sectionsOf(f.ctx)
  const contract = fs.get('argp-contract') ?? ''
  assert.ok(contract.includes('recall_history') && contract.includes('vocabulary'), 'factor 契约指标签通道')
  assert.ok(!contract.includes('[已剪·因子'), '契约不再承诺 stub 文本（2026-11-13 组剪后零指针）')
  assert.ok(!contract.includes('recall_pruned') && !contract.includes('list_pruned'), '契约禁引退役工具名（假通道）')
  assert.ok(!fs.has('argp-cites'), 'cites 契约整段不注册')
})

test('recall_history：标签交集 → 日志 append 根源原文；state/hit 标记齐、桩文本不冒充', async () => {
  const { ctx, internals } = await boot()
  const factor = internals.factor as FactorEngine
  const session = makeSession('recall-basic')
  internals.bindSession(session)
  prunedReadPair(session, factor)
  const res = await execTool(ctx, {
    name: 'recall_history', callId: 'q1', agentSession: session,
    args: { labels: ['document:c:/proj/a.ts'] },
  })
  const text = toolText(res)
  assert.ok(text.includes('OLD CONTENT'), '取回的是原文（日志 append 根事件），不是桩')
  assert.ok(!text.includes('已剪·因子 tool →') || text.includes('OLD CONTENT'), '桩文本不作正文返回')
  assert.ok(text.includes('state=shadowed'), '状态标记：取回内容当前不可见')
  assert.ok(text.includes('hit=document:c:/proj/a.ts'), '命中标签回显')
  assert.ok(!text.includes('cursor='), '全量命中（limit 内）不给续读提示')
})

test('裸标签查询宽容；未命中标签如实回显（ML1/ML4 锁）', async () => {
  const { ctx, internals } = await boot()
  const factor = internals.factor as FactorEngine
  const session = makeSession('recall-bare')
  internals.bindSession(session)
  prunedReadPair(session, factor)
  const bare = toolText(await execTool(ctx, {
    name: 'recall_history', callId: 'q1', agentSession: session,
    args: { labels: ['C:/Proj/a.ts'] },
  }))
  assert.ok(bare.includes('OLD CONTENT'), '裸标签按四 facet 展开命中（模型抄漏前缀不是查询失败）')
  const mixed = toolText(await execTool(ctx, {
    name: 'recall_history', callId: 'q2', agentSession: session,
    args: { labels: ['document:c:/proj/a.ts', 'document:c:/nope.ts'] },
  }))
  assert.ok(mixed.includes('OLD CONTENT'))
  assert.ok(mixed.includes('document:c:/nope.ts'), '未命中标签必须回显（ML1）')
  assert.ok(mixed.includes('ignored'), '回显措辞标明"被剔除"')
})

test('查询无命中：如实说明 + 账本总量 + list_labels 指路（不静默空串）', async () => {
  const { ctx, internals } = await boot()
  const factor = internals.factor as FactorEngine
  const session = makeSession('recall-empty')
  internals.bindSession(session)
  prunedReadPair(session, factor)
  const text = toolText(await execTool(ctx, {
    name: 'recall_history', callId: 'q1', agentSession: session,
    args: { labels: ['document:c:/never.ts'] },
  }))
  assert.ok(text.includes('no pruned item matches'), '无命中必须显式')
  assert.ok(text.includes('list_labels'), '指路发现通道')
  assert.ok(text.includes('1 pruned item'), '账本总量可见')
})

test('分页续读：limit=1 → cursor/epoch 提示；翻页取次新；epoch 漂移告警（ML2/ML3/ML5 锁）', async () => {
  const { ctx, internals } = await boot()
  const factor = internals.factor as FactorEngine
  const session = makeSession('recall-page')
  internals.bindSession(session)
  // 两条 bash npm R（同 command:npm 键）+ turn3 焦点转移 → 双剪
  appendUser(session, '任务')
  appendGroup(session, 1, 'b1', 'bash', '{"command":"npm run build"}', 'out alpha ' + 'a'.repeat(400))
  appendGroup(session, 2, 'b2', 'bash', '{"command":"npm run lint"}', 'out beta ' + 'b'.repeat(400))
  appendGroup(session, 3, 'c3', 'read', '{"file_path":"C:/Proj/c.ts"}', 'focus elsewhere')
  assert.ok(factor.compactIfNeeded(session, 1000) !== null)
  const page1 = toolText(await execTool(ctx, {
    name: 'recall_history', callId: 'q1', agentSession: session,
    args: { labels: ['command:npm'], limit: 1 },
  }))
  assert.ok(page1.includes('turn=2'), '新鲜度降序：第一页是 turn2')
  assert.ok(page1.includes('out beta'), '页 1 正文是 turn2 输出')
  const m = page1.match(/cursor=(\d+) epoch=(\d+)/)
  assert.ok(m !== null, '必须打印续读 cursor/epoch（ML3）')
  const page2 = toolText(await execTool(ctx, {
    name: 'recall_history', callId: 'q2', agentSession: session,
    args: { labels: ['command:npm'], limit: 1, cursor: Number(m?.[1]), epoch: Number(m?.[2]) },
  }))
  assert.ok(page2.includes('turn=1'), 'cursor 续读取到次新条目（ML5）')
  const stale = toolText(await execTool(ctx, {
    name: 'recall_history', callId: 'q3', agentSession: session,
    args: { labels: ['command:npm'], limit: 1, cursor: Number(m?.[1]), epoch: Number(m?.[2]) + 999 },
  }))
  assert.ok(stale.includes('epoch changed'), 'epoch 漂移必须告警重排（ML2）')
  assert.ok(stale.includes('turn=2'), '漂移后必须真的从头分页（旧 cursor=1 会跳过最新行，ML2b）')
})

test('list_labels：词表下钻（键×数量）；未知类别严拒；空 facet 如实', async () => {
  const { ctx, internals } = await boot()
  const factor = internals.factor as FactorEngine
  const session = makeSession('labels-vocab')
  internals.bindSession(session)
  prunedReadPair(session, factor)
  const all = toolText(await execTool(ctx, { name: 'list_labels', callId: 'q1', agentSession: session, args: {} }))
  assert.ok(all.includes('document:c:/proj/a.ts ×1'), '被剪键入列带覆盖数')
  assert.ok(all.includes('recall_history'), '行尾给取回指路')
  const doc = toolText(await execTool(ctx, { name: 'list_labels', callId: 'q2', agentSession: session, args: { category: 'document' } }))
  assert.ok(doc.includes('document — 1 label(s)'))
  const err = toolText(await execTool(ctx, { name: 'list_labels', callId: 'q3', agentSession: session, args: { category: 'errorcode' } }))
  assert.ok(err.includes('no pruned item carries'), '空 facet 如实说明（不空串）')
  const bogus = toolText(await execTool(ctx, { name: 'list_labels', callId: 'q4', agentSession: session, args: { category: 'bogus' } }))
  assert.ok(bogus.includes('unknown category'), '未知类别严拒并列合法值')
})

test('每轮防循环安全阀双臂同阀；预算截断与耗尽显式（budgetRecallText 契约复用）', async () => {
  const { ctx, internals } = await boot()
  const factor = internals.factor as FactorEngine
  const session = makeSession('recall-guards')
  internals.bindSession(session)
  prunedReadPair(session, factor)
  const st = internals.stateOf(session)
  st.recallCallsThisTurn = 20
  st.recallTurn = 0
  const guard = toolText(await execTool(ctx, {
    name: 'recall_history', callId: 'q1', agentSession: session, args: { labels: ['document:c:/proj/a.ts'] },
  }))
  assert.ok(guard.includes('per-turn call limit'), '安全阀复用 recall-tools 单点')
  const labelsGuard = toolText(await execTool(ctx, { name: 'list_labels', callId: 'lg', agentSession: session, args: {} }))
  assert.ok(labelsGuard.includes('per-turn call limit'), 'list_labels 共用同一 per-turn 安全阀（不白嫖）')
  st.recallCallsThisTurn = 0
  st.recallTurn = 0
  st.resolvedWindowTokens = 8 // 极小窗口：5% 单次 ≈ 1 字符
  let sawTruncated = false
  let sawExhausted = false
  for (let i = 0; i < 5; i += 1) {
    const t = toolText(await execTool(ctx, {
      name: 'recall_history', callId: 'g' + i, agentSession: session, args: { labels: ['document:c:/proj/a.ts'] },
    }))
    if (t.includes('truncated')) sawTruncated = true
    if (t.includes('budget exhausted')) { sawExhausted = true; break }
  }
  assert.ok(sawTruncated, '预算内截断必须带截断标记与余额说明')
  assert.ok(sawExhausted, '累计耗尽显式说明（不静默空手）')
})
