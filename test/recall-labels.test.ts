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
 *  - 字符预算截断与耗尽显式（budgetRecallText 契约复用）+ 跨轮重置（2026-11-14 用户裁定）；
 *  - 路径后缀归一匹配（alpha4 T19/T30 实锤修复）：相对/缩短标签唯一命中改写并告知，
 *    多候选 fail-closed 列出绝不猜；
 *  - 召回引导三面同教 scope + scope 地址端到端（L1-L4，2026-11-15：46 轮 P45 Q8 型洞
 *    =纯引导缺口——只被目录级 grep 触及的内容仅有 scope 地址，引导不教则模型不可发现）。
 *
 * 变异台账（摘锁必须变红，已逐条执行）：
 *  ML1 删未命中查询标签回显 → T3 红；
 *  ML2 删 epochStale 告警 → T5 红；
 *  ML3 删 nextCursor 续读提示 → T5 红（第二页无从取得，两页内容重合）；
 *  ML4 删裸标签前缀展开 → T3 红；
 *  ML5 queryPruned 入参 cursor/epoch 改缺省 → T5 红（两页同内容）；
 *  ML6 构造期重新挂回 recall_pruned 三件套 → T1 红。
 *  ML7 摘后缀归一通道（handler 的 matchBySuffix 块）→ T8 红；
 *  ML8 摘 budgetRecallText 轮变归零 → T9 红；
 *  ML9 摘 outline 视图分支 → T10 红；
 *  ML10 摘 item 钻取路径 → T11 红；
 *  ML11 装配式 full 改回整批拼接（无截断提示/双记账）→ T12 红。
 *  ML12 删 description 的 scope:<dir> 枚举 → T-scope-guidance 红；
 *  ML13 摘空标签错误文案的 scope 项 → T-scope-guidance 红；
 *  ML14 摘账本 indexKeys 的 scope 索引 → T-scope-e2e 红（stubKey 只管桩文本标签，
 *    摘它不红——L3 真正依赖的是 indexKeys 的 scope 键，变异实测钉死）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ArgpEngine } from '../src/argp-engine.ts'
import type { FactorEngine } from '../src/factor/engine.ts'
import { execTool, toolText } from './tool-execute-shape.ts'
import { liveBlendCharsPerToken } from '../src/budget.ts'
import { DEFAULT_CHARS_PER_TOKEN } from '../src/constants.ts'

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
  stateOf(session: Session): { recallCallsThisTurn: number; recallTurn: number; recallCharsUsed: number; resolvedWindowTokens: number }
}

async function boot(): Promise<{ ctx: Context; engine: ArgpEngine; internals: EngineInternals }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: 'recall labels persona' } })
  await ctx.plugin(ArgpEngine, { engine: 'factor', windowTokens: 100, retainTokens: 50, recencyGuard: 0 })
  return { ctx, engine: ctx.compaction as ArgpEngine, internals: ctx.compaction as unknown as EngineInternals }
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
  assert.ok(!fs.has('argp-contract'), '2.0.0 起契约不驻 system 前缀（随词表 note 在首次压缩后注入）')
})

test('召回引导三面同教 scope（2026-11-15 裁定：46 轮 P45 Q8 型洞=纯引导缺口，L1/L4 锁）', async () => {
  const f = await boot()
  const tool = (f.ctx.tools as unknown as { get(n: string): { description: string } }).get('recall_history') as { description: string }
  assert.ok(tool.description.includes('scope:<dir>'), 'L1：recall_history description 列 scope 形态')
  const { internals } = f
  const factor = internals.factor as FactorEngine
  const session = makeSession('recall-scope-guidance')
  internals.bindSession(session)
  prunedReadPair(session, factor)
  const empty = await execTool(f.ctx, {
    name: 'recall_history', callId: 'q0', agentSession: session,
    args: { labels: [] },
  })
  assert.ok(toolText(empty).includes('scope:<dir>'), 'L4：空标签错误文案同步列 scope（失败时刻不得与新教通道自相矛盾）')
})

test('scope 地址端到端：仅目录级 grep 的 R 被剪后可按 scope:<dir> 逐字取回；裸词目录降级指路（L3 锁）', async () => {
  const { ctx, internals } = await boot()
  const factor = internals.factor as FactorEngine
  const session = makeSession('recall-scope-e2e')
  internals.bindSession(session)
  appendUser(session, '开始任务')
  // turn1：目录级 grep（args 只有 path=目录，无文件键 ⇒ 无 document，仅 scope 地址）；
  // turn2：read 焦点留守，驱动剪枝发射——t38 型原子的最小复刻。
  appendGroup(session, 1, 'g1', 'grep', '{"path":"C:/Proj/.material","pattern":"NOTE"}', 'MATERIAL LINE QK-3391-SCAN ' + 'x'.repeat(260))
  appendGroup(session, 2, 'c2', 'read', '{"file_path":"C:/Proj/b.ts"}', 'NEW CONTENT'.repeat(50))
  assert.ok(factor.compactIfNeeded(session, 1000) !== null, '前置剪枝必须发射')
  const res = await execTool(ctx, {
    name: 'recall_history', callId: 'q1', agentSession: session,
    args: { labels: ['scope:c:/proj/.material'] },
  })
  const text = toolText(res)
  assert.ok(text.includes('MATERIAL LINE QK-3391-SCAN'), 'scope 标签取回 grep 原文逐字（t38 型洞的机制通路）')
  assert.ok(text.includes('state=shadowed'), '取回内容标记为当前不可见')
  const bare = await execTool(ctx, {
    name: 'recall_history', callId: 'q2', agentSession: session,
    args: { labels: ['scope:material'] },
  })
  assert.ok(toolText(bare).includes('list_labels'), '裸词 scope（无 /）走不到后缀通道 → 未命中如实 + 指路 list_labels')
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
  assert.ok(text.includes('labels=document:c:/proj/a.ts'), '命中标签回显（labels= 形，hit= 已随审查 D 项退役）')
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

test('路径后缀归一：相对/缩短标签唯一命中改写并告知；多候选 fail-closed 列出（ML7 锁）', async () => {
  const { ctx, internals } = await boot()
  const factor = internals.factor as FactorEngine
  const session = makeSession('recall-suffix')
  internals.bindSession(session)
  // alpha4 T19 同构场景：账本键 = 绝对路径，模型猜相对路径标签
  appendUser(session, '任务')
  appendGroup(session, 1, 'm1', 'read', '{"file_path":"C:/Users/admin/t24j-ws/ws2-alpha4/.material/p02-1.md"}', 'P02 ORIGINAL '.repeat(40))
  appendGroup(session, 2, 'm2', 'read', '{"file_path":"C:/Proj/other.ts"}', 'NEW CONTENT'.repeat(50))
  assert.ok(factor.compactIfNeeded(session, 1000) !== null)
  const rel = toolText(await execTool(ctx, {
    name: 'recall_history', callId: 'q1', agentSession: session,
    args: { labels: ['document:.material/p02-1.md'] },
  }))
  assert.ok(rel.includes('P02 ORIGINAL'), '后缀归一命中原文（不空手）')
  assert.ok(rel.includes('suffix-resolved'), '改写必须可见（模型学会下次用全形）')
  assert.ok(rel.includes('document:c:/users/admin/t24j-ws/ws2-alpha4/.material/p02-1.md'), '全形键如实告知')
  // 歧义：两条同尾键 → fail-closed 列候选、零内容返回（绝不猜）
  const session2 = makeSession('recall-suffix-ambig')
  internals.bindSession(session2)
  appendUser(session2, '任务')
  appendGroup(session2, 1, 'a1', 'read', '{"file_path":"C:/x/dir1/p.md"}', 'AAA '.repeat(40))
  appendGroup(session2, 1, 'a2', 'read', '{"file_path":"C:/y/dir1/p.md"}', 'BBB '.repeat(40))
  appendGroup(session2, 2, 'a3', 'read', '{"file_path":"C:/Proj/other.ts"}', 'NEW CONTENT'.repeat(50))
  assert.ok(factor.compactIfNeeded(session2, 1000) !== null)
  const amb = toolText(await execTool(ctx, {
    name: 'recall_history', callId: 'q2', agentSession: session2,
    args: { labels: ['document:dir1/p.md'] },
  }))
  assert.ok(amb.includes('ambiguous path suffix'), '歧义必须显式')
  assert.ok(amb.includes('c:/x/dir1/p.md') && amb.includes('c:/y/dir1/p.md'), '候选如实列出')
  assert.ok(!amb.includes('AAA') && !amb.includes('BBB'), '绝不猜（零正文返回）')
})

test('召回预算跨轮重置（2026-11-14 用户裁定）：轮变即归零；同轮仍累计到耗尽显式（ML8 锁）', async () => {
  const { ctx, internals } = await boot()
  const factor = internals.factor as FactorEngine
  const session = makeSession('recall-budget-turn')
  internals.bindSession(session)
  prunedReadPair(session, factor)
  const st = internals.stateOf(session)
  st.resolvedWindowTokens = 8 // 极小窗口：total 10% ≈ 2 字符，单次 5% ≈ 1 字符
  const call = async (id: string): Promise<string> => toolText(await execTool(ctx, {
    name: 'recall_history', callId: id, agentSession: session,
    args: { labels: ['document:c:/proj/a.ts'] },
  }))
  assert.ok((await call('t1a')).includes('truncated'), '同轮首调：预算内截断')
  assert.ok((await call('t1b')).includes('budget exhausted'), '同轮累计耗尽显式（不静默空手）')
  assert.ok((await call('t1c')).includes('budget exhausted'), '同轮仍耗尽（轮内不重置）')
  session.append('turn/start', { turn: 1 } as never)
  const t2 = await call('t2a')
  assert.ok(!t2.includes('budget exhausted'), '轮变预算归零（跨轮重置生效）')
  assert.ok(t2.includes('truncated'), '轮 2 重新可用（per-call 限额内截断照旧）')
})

test('outline 视图：每行确定性元数据（item/turn/tool/verdict/现算长度/labels=），零正文（ML9 锁）', async () => {
  const { ctx, internals } = await boot()
  const factor = internals.factor as FactorEngine
  const session = makeSession('recall-outline')
  internals.bindSession(session)
  appendUser(session, '任务')
  appendGroup(session, 1, 'o1', 'read', '{"file_path":"C:/Proj/a.ts"}', 'OLD'.repeat(10))
  appendGroup(session, 2, 'o2', 'read', '{"file_path":"C:/Proj/b.ts"}', 'NEW'.repeat(10))
  assert.ok(factor.compactIfNeeded(session, 1000) !== null)
  const out = toolText(await execTool(ctx, {
    name: 'recall_history', callId: 'q1', agentSession: session,
    args: { labels: ['document:c:/proj/a.ts'], view: 'outline' },
  }))
  assert.ok(/item=\d+ · turn=1 · read ok · 30 chars · labels=document:c:\/proj\/a\.ts/.test(out), '元数据行格式（长度=现算 rawEventText 长度，不用贴标期采样值）')
  assert.ok(!out.includes('OLDOLD'), 'outline 不给正文（宽查询先扫后取的两级协议）')
  assert.ok(out.includes('fetch text with item='), '指引 item 钻取')
})

test('item 钻取：单条取回、截断续读 offset、负 offset 严拒、越界如实、非账本 seq 严拒（ML10 锁）', async () => {
  const { ctx, internals } = await boot()
  const factor = internals.factor as FactorEngine
  const session = makeSession('recall-item')
  internals.bindSession(session)
  prunedReadPair(session, factor)
  const outline = toolText(await execTool(ctx, {
    name: 'recall_history', callId: 'q0', agentSession: session,
    args: { labels: ['document:c:/proj/a.ts'], view: 'outline' },
  }))
  const m = outline.match(/item=(\d+)/)
  assert.ok(m !== null, 'outline 给出 item 句柄')
  const seq = Number(m![1])
  const st = internals.stateOf(session)
  st.resolvedWindowTokens = 2000 // perCall = 350：header/tag 扣除后 slice 被迫截断
  const first = toolText(await execTool(ctx, {
    name: 'recall_history', callId: 'q1', agentSession: session,
    args: { item: seq },
  }))
  assert.ok(first.includes('OLD CONTENT'), 'item 取回原文')
  assert.ok(first.includes('chars total'), '总长可见；labels/order 等参数被忽略要明示')
  const fm = first.match(/\[item continues: call recall_history with item=(\d+) offset=(\d+)\]/)
  assert.ok(fm !== null, '截断必须给续读 footer（钳位外拼）')
  const second = toolText(await execTool(ctx, {
    name: 'recall_history', callId: 'q2', agentSession: session,
    args: { item: Number(fm![1]), offset: Number(fm![2]) },
  }))
  assert.ok(second.includes('from offset=' + fm![2]), '续读回显 offset')
  const neg = toolText(await execTool(ctx, {
    name: 'recall_history', callId: 'q3', agentSession: session,
    args: { item: seq, offset: -5 },
  }))
  assert.ok(neg.includes('offset must be a non-negative'), '负 offset 严拒（fail-closed）')
  const past = toolText(await execTool(ctx, {
    name: 'recall_history', callId: 'q4', agentSession: session,
    args: { item: seq, offset: 100000 },
  }))
  assert.ok(past.includes('past the end'), '越界如实说明、不给下一 offset')
  const ghost = toolText(await execTool(ctx, {
    name: 'recall_history', callId: 'q5', agentSession: session,
    args: { item: 99999 },
  }))
  assert.ok(ghost.includes('not in the pruned ledger'), '非账本 seq（含 live）严拒——item 不是无标签 seq 召回通道')
})

test('装配式 full：新→旧序，首条整装→次条截断带 offset 提示→余项弃装计数；单次记账不双计（ML11 锁）', async () => {
  const { ctx, internals } = await boot()
  const factor = internals.factor as FactorEngine
  const session = makeSession('recall-assembly')
  internals.bindSession(session)
  appendUser(session, '任务')
  appendGroup(session, 1, 'p1', 'read', '{"file_path":"C:/Proj/a.ts"}', 'AAA-XYZ '.repeat(80))
  appendGroup(session, 2, 'p2', 'read', '{"file_path":"C:/Proj/a.ts"}', 'BBB-XYZ '.repeat(80))
  appendGroup(session, 3, 'p3', 'read', '{"file_path":"C:/Proj/a.ts"}', 'CCC-XYZ '.repeat(80))
  appendGroup(session, 4, 'p4', 'read', '{"file_path":"C:/Proj/b.ts"}', 'NEW'.repeat(10))
  appendGroup(session, 5, 'p5', 'read', '{"file_path":"C:/Proj/b.ts"}', 'NEW'.repeat(10))
  appendGroup(session, 6, 'p6', 'read', '{"file_path":"C:/Proj/b.ts"}', 'NEW'.repeat(10))
  assert.ok(factor.compactIfNeeded(session, 3000) !== null, '大缺额把三条 a.ts 全剪进账本')
  const st = internals.stateOf(session)
  // Issue5 口径：召回预算 = resolvedWindowTokens × 5%/10% × live 面混合密度。
  // 本会话 surface 含中文墓碑/notice，blend < 3.5 —— 窗口按 blend 反向补偿，
  // 把 perCall 拉回 1400 的原语义，让本锁继续锁装配行为（序/截断/弃装/单记账）
  // 而非预算密度换算（后者由 test/cjk-estimate.test.ts CT5 专锁）。
  const blend = liveBlendCharsPerToken(session, DEFAULT_CHARS_PER_TOKEN)
  st.resolvedWindowTokens = Math.ceil(8000 * DEFAULT_CHARS_PER_TOKEN / blend) // perCall ≈ 1400：首条(t3)全文装下，次条(t2)截断，末条(t1)弃装
  const res = await execTool(ctx, {
    name: 'recall_history', callId: 'q1', agentSession: session,
    args: { labels: ['document:c:/proj/a.ts'], limit: 5 },
  })
  const text = toolText(res)
  assert.ok(text.includes('CCC-XYZ '.repeat(20)), '最新条整条装入')
  assert.ok(text.includes('BBB-XYZ ') && !text.includes('BBB-XYZ '.repeat(30)), '次条只装部分（装配期截断）')
  assert.ok(!text.includes('AAA-XYZ '), '装不下的条目整条弃装（不装半截静默尾巴）')
  assert.ok(/item \d+ truncated at \d+ chars/.test(text), '装配期截断提示必须存活（不被外层钳位切头）')
  assert.ok(text.includes('+1 more item(s) not shown'), '弃装余量如实计数')
  assert.equal(st.recallCharsUsed, text.length, '单次记账不变量：装配后无外层再截 ⇒ used = 返回长度（恰一次）')
})

test('list_labels：scope 按需可见（查询侧早已放行，词表侧对齐）；行内线索渲染', async () => {
  const { ctx, internals } = await boot()
  const factor = internals.factor as FactorEngine
  const session = makeSession('labels-scope')
  internals.bindSession(session)
  appendUser(session, '任务')
  appendGroup(session, 1, 'g1', 'grep', '{"pattern":"shard","path":"C:/proj/src"}', 'shard hit at line 12')
  appendGroup(session, 2, 'g2', 'read', '{"file_path":"C:/Proj/b.ts"}', 'NEW'.repeat(50))
  assert.ok(factor.compactIfNeeded(session, 1000) !== null)
  const scope = toolText(await execTool(ctx, {
    name: 'list_labels', callId: 'q1', agentSession: session,
    args: { category: 'scope' },
  }))
  assert.ok(scope.includes('scope — 1 label(s)'), 'scope 类别可见（G 项收口）')
  assert.ok(scope.includes('scope:c:/proj/src'), 'scope 键入列')
  assert.ok(scope.includes('· last: grep ok @t'), '行内线索：last tool/verdict/turn')
  const bogus = toolText(await execTool(ctx, {
    name: 'list_labels', callId: 'q2', agentSession: session,
    args: { category: 'bogus' },
  }))
  assert.ok(bogus.includes('valid: document | command | errorcode | tool | scope'), '严拒文案与描述同口径（含 scope；tool 2026-11-16 升格）')
})
