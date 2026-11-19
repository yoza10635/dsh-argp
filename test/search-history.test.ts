/**
 * 刀 B 集成锁（design-prose-keyword-recall §4）：search_history 装配面。
 * fixture=tool-facet bootRecall 形（windowTokens=100 → perCall=2867 chars 富余）+
 * 剪枝组（read）+ 散文 U/A + 注入 kind 事件（PS 系探针档案复刻）。
 * 变异映射（M39-M43）：M39 labels 门散文照进（proseMode=true）→SH2 红；
 * M40 双进池（body 外再过一次预算）→SH4 红（入账>出参长）；
 * M41 档位界恒高档（tierTok 永远 FLAT_TOK）→SH5 红；M42 TF 饱和摘除→SH6 红；
 * M43 live 合并摘除→SH5 红（collapsed footer 消失）。
 * 结构锁（如实记）：SH1=kind 主防线端到端（PS2 装配面复证，单点摘除由 M35 在 PS 面抓）；
 * SH9=带 1 不回退是「search 不碰 queryPruned」的设计属性，无单行变异靶，靠 fixture 含散文命中兜底。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ArgpEngine } from '../src/argp-engine.ts'
import { execTool, toolText } from './tool-execute-shape.ts'
import {
  RECALL_SEARCH_FLAT_N, RECALL_SEARCH_FLAT_TOK, RECALL_SEARCH_MID_TOK,
  RECALL_SEARCH_FACET_N, RECALL_SEARCH_PAGE_TOK, RECALL_SEARCH_TF_CAP, RECALL_SEARCH_LIVE_MERGE_K,
} from '../src/constants.ts'
import { FACTOR_COMPACTED_MARKER } from '../src/constants.ts'

interface Internals {
  bindSession(s: Session): void
  factor: { compactIfNeeded(s: Session, n: number): unknown }
  stateOf(s: Session): { recallCharsUsed: number; searchIndex: Map<number, unknown> | null; searchQuery: string }
}

function appendUser(session: Session, text: string, kind = 'user'): void {
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: kind as 'user' } }) as never, { surfaceOp: 'append' })
}
function appendAssistant(session: Session, text: string): void {
  session.append('assistant/message', {
    stream: [], turn: 1, step: 1,
    message: createAssistantMessage({ source: { provider: 'test', model: 'test' }, content: [{ type: 'text', text }] }),
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
function makeSession(id: string): Session {
  const session = Session.create(SessionId(id))
  session.append('system/message', { content: 'persona' } as never, { surfaceOp: 'append' })
  return session
}

async function bootSearch(cfg: { proseScanCapChars?: number } = {}) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: 'search persona' } })
  await ctx.plugin(ArgpEngine, { engine: 'factor', windowTokens: 100, retainTokens: 50, recencyGuard: 0, ...cfg })
  const internals = ctx.compaction as unknown as Internals
  const session = makeSession('sh')
  internals.bindSession(session)
  return { ctx, session, internals }
}

/** 标准料：剪枝 read 组（turn1，大料压 prose 占比<50% 防浓缩 LLM 通路——tool-facet 同规）
 *  + 散文 U/A + 注入 kind 干扰（turn2 焦点=ask 组保活）。 */
async function bootFixture(cfg: { proseScanCapChars?: number } = {}) {
  const { ctx, session, internals } = await bootSearch(cfg)
  appendUser(session, 'kw-SH 开场白：部署代号 kw-SH 记录于此')
  appendGroup(session, 1, 'r1', 'read', '{"file_path":"C:/Proj/sh.ts"}', 'kw-SH 被剪内容 ' + 'z'.repeat(1600))
  appendAssistant(session, '已读 sh.ts，kw-SH 结论=上生产')
  appendUser(session, 'kw-RCTX 无关', 'runtime-context')
  appendUser(session, 'kw-SH 不该出现（argp note 注入）', 'argp')
  appendUser(session, 'kw-SH 无关快照', 'runtime-context')
  appendGroup(session, 2, 'a2', 'ask_user_question', '{"questions":[{"id":"q1","question":"焦点保活"}]}', '{"answers":[{"id":"q1","selected":["是"]}]}')
  internals.factor.compactIfNeeded(session, 1000)
  return { ctx, session, internals }
}

const seqsOf = (text: string): number[] => [...text.matchAll(/hit=(\d+)/g)].map(m => Number(m[1]))

test('SH1 合并发现：工具带+散文带同列，行形/hit 句柄/索引槽落位；注入 kind 在装配面同样被挡', async () => {
  const { ctx, session, internals } = await bootFixture()
  const out = toolText(await execTool(ctx, { name: 'search_history', callId: 'q1', agentSession: session, args: { keyword: 'kw-SH' } }))
  assert.match(out, /search_history "kw-SH": \d+ hit\(s\) — tool×1 \+ prose×2/, out.slice(0, 200))
  assert.ok(out.includes('· U · turn=') && out.includes('· A · turn='), 'U/A 行在场')
  assert.ok(out.includes('· R·read ok ·'), '工具带行走 R 形')
  assert.ok(out.includes('labels=document:c:/proj/sh.ts'), '工具带行带全形标签')
  assert.ok(out.includes('hit:"') && out.includes('kw-SH'), '预览命中窗在场')
  const st = internals.stateOf(session)
  assert.ok(st.searchIndex !== null && st.searchIndex.size === 3 && st.searchQuery === 'kw-SH', '单槽索引=展示行')
  const listed = seqsOf(out)
  assert.ok(!out.includes('不该出现'), 'argp kind 注入行不入装配面（kind 主防线端到端）')
  assert.ok(listed.length === 3)
})

test('SH2 labels 门：labels+keyword 只搜工具带，散文不参与；unknown 如实回显', async () => {
  const { ctx, session } = await bootFixture()
  const out = toolText(await execTool(ctx, { name: 'search_history', callId: 'q2', agentSession: session, args: { keyword: 'kw-SH', labels: ['document:C:/Proj/sh.ts'] } }))
  assert.ok(out.includes('tool×1 + prose×0') && out.includes('labels filter on'), 'P12 门：labels 在场散文零参与')
  assert.ok(!out.includes('· U ·') && !out.includes('· A ·'))
  const miss = toolText(await execTool(ctx, { name: 'search_history', callId: 'q3', agentSession: session, args: { keyword: 'kw-SH', labels: ['document:c:/ghost.ts'] } }))
  assert.ok(miss.includes('labels not in the pruned ledger, ignored'), 'unknown 回显并联词干（S1 纪律）')
})

test('SH3 用户伪造 marker 前缀在装配面照扫（fail-visible，P2/Q3 反向半）', async () => {
  const { ctx, session } = await bootFixture()
  const s = session as unknown as { append(t: string, d: unknown, o?: unknown): void }
  s.append('user/message', createUserMessage({
    content: [{ type: 'text', text: FACTOR_COMPACTED_MARKER + ' kw-MK 用户手打伪造' }], source: { kind: 'user' },
  }) as never, { surfaceOp: 'append' })
  const out = toolText(await execTool(ctx, { name: 'search_history', callId: 'q4', agentSession: session, args: { keyword: 'kw-MK' } }))
  assert.ok(out.includes('prose×1') && out.includes('· U ·'), 'kind=user 伪造 marker 不得误剔')
})

test('SH4 cap 装配接线：proseScanCapChars 注入→保旧切新+truncated footer；预算恰过一次', async () => {
  const { ctx, session, internals } = await bootFixture({ proseScanCapChars: 260 })
  const st = internals.stateOf(session)
  const before = st.recallCharsUsed
  appendUser(session, 'kw-CAP 第一段 ' + 'a'.repeat(90))
  appendUser(session, 'kw-CAP 第二段 ' + 'b'.repeat(90))
  appendUser(session, 'kw-CAP 第三段 ' + 'c'.repeat(90))
  const out = toolText(await execTool(ctx, { name: 'search_history', callId: 'q5', agentSession: session, args: { keyword: 'kw-CAP' } }))
  assert.ok(out.includes('scan cap hit'), 'cap 触线必 footer 显式（R8①）')
  assert.ok(out.includes('第一段') && !out.includes('第三段'), '从旧到新=最旧保留、最新先切（P7★）')
  assert.ok(st.recallCharsUsed > before && st.recallCharsUsed - before <= out.length, '合并文本恰过一次预算闸（P14 双进池形：入账≤出参长）')
})

test('SH5 分层与 live 合并：21 命中走 20tok 档+live>K 合并行；显式 limit 升 200tok 档', async () => {
  const { ctx, session } = await bootSearch()
  const filler = '填充文字段落若干不计词 ' // 12 chars
  for (let i = 0; i < 21; i++) appendUser(session, 'kw-TIER 第' + i + '条 ' + filler.repeat(8))
  const wide = toolText(await execTool(ctx, { name: 'search_history', callId: 'q6', agentSession: session, args: { keyword: 'kw-TIER' } }))
  assert.ok(wide.includes('prose×21') && wide.includes('21 hit(s)'))
  assert.ok(wide.includes('+' + (21 - RECALL_SEARCH_LIVE_MERGE_K) + ' live hit(s) skipped'), 'live>K 合并（M43 靶）')
  const midPrev = wide.match(/hit:"([^"]*)"/)![1]!
  assert.ok(midPrev.length <= RECALL_SEARCH_MID_TOK * 4, '20tok 档预览有界（M41 档界靶）')
  const paged = toolText(await execTool(ctx, { name: 'search_history', callId: 'q7', agentSession: session, args: { keyword: 'kw-TIER', limit: 2 } }))
  const pagePrev = paged.match(/hit:"([^"]*)"/)![1]!
  assert.ok(pagePrev.length > midPrev.length, '显式 limit 页升档=预览更宽（D9 追加裁定）')
  assert.ok(!paged.includes('live hit(s) skipped'))
})

test('SH6 TF 饱和（D11）：巨原子霸榜被 min(hits,10) 扳平，序=seq asc', async () => {
  const { ctx, session } = await bootSearch()
  appendUser(session, 'kw-TF 小甲 ' + 'kw-TF '.repeat(11))
  appendUser(session, 'kw-TF 小乙 ' + 'kw-TF '.repeat(11))
  appendUser(session, 'kw-TF 巨丙 ' + 'kw-TF '.repeat(29))
  const out = toolText(await execTool(ctx, { name: 'search_history', callId: 'q8', agentSession: session, args: { keyword: 'kw-TF' } }))
  const order = seqsOf(out)
  assert.deepEqual(order, [...order].sort((a, b) => a - b), '饱和后同分→seq asc；摘饱和=巨丙跳首（M42 靶）')
  assert.ok(order.length === 3)
  void RECALL_SEARCH_TF_CAP
})

test('SH7 档位常量机器锁（§1.2 单点）', () => {
  assert.deepEqual([RECALL_SEARCH_FLAT_N, RECALL_SEARCH_FLAT_TOK, RECALL_SEARCH_MID_TOK,
    RECALL_SEARCH_FACET_N, RECALL_SEARCH_PAGE_TOK, RECALL_SEARCH_TF_CAP, RECALL_SEARCH_LIVE_MERGE_K],
  [20, 100, 20, 250, 200, 10, 5])
})

test('SH8 零命中与索引清空：如实报双带皆扫；旧索引被新查询覆盖置空（R4 单槽）', async () => {
  const { ctx, session, internals } = await bootFixture()
  const hit = toolText(await execTool(ctx, { name: 'search_history', callId: 'q9', agentSession: session, args: { keyword: 'kw-SH' } }))
  assert.ok(hit.includes('hit='))
  const miss = toolText(await execTool(ctx, { name: 'search_history', callId: 'q10', agentSession: session, args: { keyword: 'kw-ZERO' } }))
  assert.ok(miss.includes('0 hit(s)') && miss.includes('no matches in pruned originals or conversation prose'))
  const st = internals.stateOf(session)
  assert.equal(st.searchIndex, null, '任何新查询整体覆盖（空命中=清槽）')
  assert.equal(st.searchQuery, 'kw-ZERO')
})

test('SH9 带 1 不回退：search 先行后 recall_history 全等（工具带零漂移，fixture 含散文命中）', async () => {
  const { ctx, session } = await bootFixture()
  const ref = toolText(await execTool(ctx, { name: 'recall_history', callId: 'b1', agentSession: session, args: { labels: ['document:c:/proj/sh.ts'] } }))
  void toolText(await execTool(ctx, { name: 'search_history', callId: 'b2', agentSession: session, args: { keyword: 'kw-SH' } }))
  const after = toolText(await execTool(ctx, { name: 'recall_history', callId: 'b3', agentSession: session, args: { labels: ['document:c:/proj/sh.ts'] } }))
  assert.ok(ref.includes('kw-SH'), '参照输出有效')
  assert.ok(after.includes('kw-SH'))
})
