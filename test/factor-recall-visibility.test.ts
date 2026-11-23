/**
 * 召回副本可见性裁决契约（2026-11-23，查询层统一收口；剪枝层裁定 2 不动）。
 *
 * 病灶链（对码事实）：裁定 2 把 recall_history/list_labels/search_history 的结果原子
 * （副本）轮闭合后无条件进剪序；副本经 tag-extract 文本侧兜底携带与原文相同的
 * document:/errorcode: 键 + tool:<注册名> 键进倒排索引（indexKeys），于是——
 *  ① 查询侧：queryPruned 缺省 relevant 序在纯 AND 下退化 turn/rootSeq 降序，seq 更新
 *    的副本排挤原文进缺省 5 条与 5% 字符预算；search_history R 带对原文+副本双命中
 *    （行内 ×N 只治单 atom 行级、不跨 atom）；
 *  ② 正确性侧：observeR 无过滤全量喂，副本的 file|code 组合把同一次失败再记一次，
 *    中间夹过 fixClaimedBetween 时把已修复错误翻成 sticky——词表冒「修复宣称后仍
 *    失败 ×N」假警报行 + 同文件读取挂错保护。
 *
 * 锁面：
 *  - RV1 同 document: 键原文+副本在场：recall_history(document:x) 只回原文；
 *  - RV2 labels 点名 tool: 召回族键 ⇒ 副本可查（审计通道，放行向）；
 *  - RV3 search_history R 带缺省只命中原文一次；labels 含 tool:recall_history 时回副本；
 *  - RV4 sticky 链：报错 R → 同文件成功写 → 召回副本 R（resultText 含同报错文本+路径）
 *    ⇒ sticky 不翻转、failCount 不变、词表无假警报行；
 *  - RV5 「词表数=可查数」：document:x 词表计数 == recall_history(document:x) 可返回
 *    条数（副本在场场景）；仅副本覆盖的键整行不出列；tool facet 行原样保留。
 *  - 不动面（裁定 4）：剪枝序/文本兜底/item= 直钻——剪枝行为由 EV1/EV1b
 *    （factor-eviction-p6iii）锁死，本文件不重复；直钻放行由 RV2 正面半隐含
 *    （副本句柄经 item=/hit= 仍可取回）。
 *
 * 变异台账（摘锁必须变红，已逐条执行）：
 *  RV-M1 queryPruned 条目级过滤摘除（factor-ledger queryPruned 的 isRecallTool filter）
 *       → RV1/RV5 红（副本挤进缺省查询、计数错位）；
 *  RV-M2 search_history 工具带过滤摘除（candT 的 isRecallTool filter）→ RV3 红（tool×2）；
 *  RV-M3 observeR isRecall 早退摘除 → RV4 红（sticky 翻转 ×2 + 假警报行）；
 *  RV-M4 vocabularyRows 非 tool facet 剔除摘除 → RV5 红（×2/仅副本覆盖键出列）；
 *  RV-M5 显式点名放行摘除（namesRecallFamilyKey 恒 false 形）→ RV2 红、RV3 后半红
 *       （审计通道死）。
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
}

async function boot(id: string): Promise<{ ctx: Context; factor: FactorEngine; session: Session }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: 'recall visibility persona' } })
  await ctx.plugin(ArgpEngine, { engine: 'factor', windowTokens: 100, retainTokens: 50, recencyGuard: 0 })
  const internals = ctx.compaction as unknown as EngineInternals
  const factor = internals.factor as FactorEngine
  const session = makeSession(id)
  internals.bindSession(session)
  return { ctx, factor, session }
}

/**
 * 场景 A（RV1/RV2/RV3/RV5 共用）：
 *  turn1 read a.ts（原文，含 kw-RV）；turn2 recall_history 的 R（副本——resultText 复刻
 *  召回输出：携带 document 键回显 + 独占的 C:/Ghost/only-copy.ts 路径；args 无 path 键
 *  ⇒ 文本侧兜底 ⇒ 与原文同 document:c:/proj/a.ts 键 + tool:recall_history 键）；
 *  turn3 read b.ts 焦点转移；target=350 ⇒ 按序剪 a.ts(~150)+副本(~310)，b.ts 留守焦点。
 */
async function bootCopyScene(id: string): Promise<{ ctx: Context; factor: FactorEngine; session: Session }> {
  const { ctx, factor, session } = await boot(id)
  appendUser(session, '任务')
  appendGroup(session, 1, 'c1', 'read', '{"file_path":"C:/Proj/a.ts"}', 'kw-RV 原文段 ' + '甲'.repeat(140))
  appendGroup(session, 2, 'rc1', 'recall_history', '{"labels":["document:c:/proj/a.ts"]}',
    'recall_history: 1 item(s) by labels [document:c:/proj/a.ts] (ledger holds 1)\nRV-COPY-ECHO kw-RV 原文片段 C:/Ghost/only-copy.ts ' + '乙'.repeat(140))
  appendGroup(session, 3, 'c2', 'read', '{"file_path":"C:/Proj/b.ts"}', 'NEW CONTENT'.repeat(50))
  assert.ok(factor.compactIfNeeded(session, 350) !== null, '前置剪枝必须发射（裁定 2：轮闭合副本进剪序）')
  // 前置自证：副本确已被剪进账本、document 键原文+副本双携带（否则本文件断言空转）。
  const ledger = factor.ledgerForRecall(session)
  assert.ok(ledger.stat('tool:recall_history') !== null, '前置：召回副本已被剪进账本')
  assert.ok(ledger.stat('document:c:/proj/a.ts') !== null, '前置：document:c:/proj/a.ts 键在场')
  return { ctx, factor, session }
}

/** 场景 A 里副本的 rootSeq（账本唯一 tool:recall_history 成员）。 */
function copySeqOf(factor: FactorEngine, session: Session): number {
  const seqs = factor.ledgerForRecall(session).stat('tool:recall_history')?.rootSeqs ?? []
  assert.equal(seqs.length, 1, '前置：账本恰一枚召回副本')
  return seqs[0] as number
}

test('RV1 同 document: 键原文+副本在场：recall_history(document:x) 缺省只回原文（RV-M1 锁）', async () => {
  const { ctx, factor, session } = await bootCopyScene('rv-copy-basic')
  const copySeq = copySeqOf(factor, session)
  const out = toolText(await execTool(ctx, {
    name: 'recall_history', callId: 'q1', agentSession: session,
    args: { labels: ['document:c:/proj/a.ts'], limit: 20 },
  }))
  const blocks = out.match(/--- seq=/g) ?? []
  assert.equal(blocks.length, 1, '缺省档只回原文一块——副本（seq 更新，relevant 退化 fresh 序会排前）挤位=病灶①')
  assert.ok(out.includes('kw-RV 原文段'), '原文正文逐字在场')
  assert.ok(!out.includes('RV-COPY-ECHO'), '副本正文不得混进缺省查询')
  assert.ok(!out.includes('--- seq=' + copySeq), '副本 seq 不出现在结果块头')
})

test('RV2 labels 点名 tool: 召回族键 ⇒ 副本可查（审计放行向，RV-M5 锁）', async () => {
  const { ctx, factor, session } = await bootCopyScene('rv-copy-audit')
  const copySeq = copySeqOf(factor, session)
  const outline = toolText(await execTool(ctx, {
    name: 'recall_history', callId: 'q1', agentSession: session,
    args: { labels: ['tool:recall_history'], view: 'outline' },
  }))
  assert.ok(outline.includes('item=' + copySeq + ' ·'), 'outline 点名族键命中副本行')
  assert.ok(outline.includes('· recall_history '), '行元数据 tool=注册名')
  const audit = toolText(await execTool(ctx, {
    name: 'recall_history', callId: 'q2', agentSession: session,
    args: { labels: ['document:c:/proj/a.ts', 'tool:recall_history'] },
  }))
  assert.ok(audit.includes('RV-COPY-ECHO'), '审计查询「该文件曾被召回过什么」必须能命中副本')
})

test('RV3 search_history R 带缺省只命中原文一次；点名 tool: 族键时回副本（RV-M2/RV-M5 锁）', async () => {
  const { ctx, session } = await bootCopyScene('rv-copy-search')
  const plain = toolText(await execTool(ctx, {
    name: 'search_history', callId: 's1', agentSession: session,
    args: { keyword: 'kw-RV' },
  }))
  assert.match(plain, /tool×1 \+ prose×0/, 'R 带只数原文——原文+副本双命中=病灶①（search_history 面）')
  assert.ok(plain.includes('R·read ok'), '在场行是原文 read')
  assert.ok(!plain.includes('R·recall_history'), '副本不在缺省 R 带')
  const audit = toolText(await execTool(ctx, {
    name: 'search_history', callId: 's2', agentSession: session,
    args: { keyword: 'kw-RV', labels: ['tool:recall_history'] },
  }))
  assert.match(audit, /tool×1/, '点名族键 = 工具带收口到副本集')
  assert.ok(audit.includes('R·recall_history'), '审计形副本可查')
  assert.ok(audit.includes('labels filter on'), 'labels 在场散文不参与（P12 不动面）')
})

test('RV4 sticky 链不被召回副本翻转：报错 R → 成功写 → 副本 R = 不翻转/failCount 不变/词表无假警报（RV-M3 锁）', async () => {
  const { factor, session } = await boot('rv-sticky-copy')
  const F = 'c:/proj/app.ts'
  const failText = 'npm ERR! code ERESOLVE resolution failed for C:/Proj/app.ts ' + '丙'.repeat(140)
  appendUser(session, '任务')
  // turn1 报错 R：bash 失败，文本兜底给出 document:c:/proj/app.ts + errorcode:ERESOLVE。
  appendGroup(session, 1, 'b1', 'bash', '{"command":"npm install"}', failText)
  // turn2 同文件成功写 = 修复宣称（fixClaimedBetween 原料）。
  appendGroup(session, 2, 'w1', 'write', '{"file_path":"C:/Proj/app.ts"}', 'ok, file updated')
  // turn3 召回副本 R：resultText 逐字回显同报错文本+路径——无早退则同一次失败再记一笔。
  appendGroup(session, 3, 'rc1', 'recall_history', '{"labels":["document:c:/proj/app.ts"]}',
    'recall_history: 1 item(s)\n' + failText + ' RV-ERR-COPY-ECHO')
  // turn4 焦点转移；target=300 ⇒ 剪 b1+w1+rc1（~430 chars），c2 留守。
  appendGroup(session, 4, 'c2', 'read', '{"file_path":"C:/Proj/b.ts"}', 'NEW CONTENT'.repeat(50))
  assert.ok(factor.compactIfNeeded(session, 300) !== null, '前置剪枝必须发射（裁定 2：轮闭合副本进剪序）')
  const ledger = factor.ledgerForRecall(session)
  assert.ok(ledger.stat('tool:recall_history') !== null, '前置：召回副本已被剪进账本')
  const track = ledger.stickyActive().find(t => t.key === F + '|ERESOLVE')
  assert.ok(track !== undefined, '前置：原文报错已成型 sticky 轨')
  assert.equal(track.state, 'open', '副本不进 sticky 观察面——已修复错误不得被回声翻成 sticky（病灶②）')
  assert.equal(track.failCount, 1, 'failCount 只计原文发生次')
  assert.equal(track.fixClaimedBetween, true, '成功写宣称确实在场（若副本再入料，正是它被翻成 sticky 的扳机）')
  assert.ok(!factor.vocabulary(session).text.includes('修复宣称后仍失败'), '词表无假警报行（stickyHook 缺省中文文案）')
})

test('RV5 词表计数=可查数：document ×N == 缺省可返回条数；仅副本覆盖键不出列；tool facet 原样（RV-M4 锁）', async () => {
  const { ctx, session } = await bootCopyScene('rv-vocab-count')
  const doc = toolText(await execTool(ctx, {
    name: 'list_labels', callId: 'l1', agentSession: session, args: { category: 'document' },
  }))
  const m = doc.match(/document:c:\/proj\/a\.ts ×(\d+)/)
  assert.ok(m !== null, 'document:c:/proj/a.ts 在列')
  assert.ok(!doc.includes('c:/ghost/only-copy.ts'), '仅副本覆盖的键（可查数 0）整行不出列——假通道词表行')
  const recall = toolText(await execTool(ctx, {
    name: 'recall_history', callId: 'r1', agentSession: session,
    args: { labels: ['document:c:/proj/a.ts'], limit: 20 },
  }))
  const n = Number(recall.match(/recall_history: (\d+) item\(s\)/)?.[1] ?? '-1')
  assert.equal(n, Number(m![1]), '「词表数=可查数」契约：×N 与缺省查询可返回条数一致')
  assert.equal(n, 1, '场景 A：原文 1 + 副本 1 ⇒ 可查 1')
  const ghost = toolText(await execTool(ctx, {
    name: 'recall_history', callId: 'r2', agentSession: session, args: { labels: ['document:c:/ghost/only-copy.ts'] },
  }))
  assert.ok(ghost.includes('no pruned item matches'), '幽灵键（仅副本携带）查询侧同样无命中——两面口径一致')
  const tools = toolText(await execTool(ctx, {
    name: 'list_labels', callId: 'l2', agentSession: session, args: { category: 'tool' },
  }))
  assert.ok(/tool:recall_history ×1/.test(tools), 'tool facet 行原样保留（副本自身就是它的计数对象，审计行）')
})
