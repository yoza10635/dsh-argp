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

test('SH10 hit= 第二跳：临时索引散文 seq 钻通逐字原文（R2★ 缺锁的正面半）', async () => {
  const { ctx, session } = await bootFixture()
  const found = toolText(await execTool(ctx, { name: 'search_history', callId: 'h1', agentSession: session, args: { keyword: 'kw-SH' } }))
  const uSeq = [...found.matchAll(/hit=(\d+) · U ·/g)].map(m => Number(m[1]))[0]
  assert.ok(uSeq !== undefined, '发现面有 U 行')
  const fetched = toolText(await execTool(ctx, { name: 'search_history', callId: 'h2', agentSession: session, args: { hit: uSeq } }))
  assert.ok(fetched.includes('--- hit=' + uSeq + ' user'), 'hit 钻取头形')
  assert.ok(fetched.includes('部署代号 kw-SH 记录于此'), '散文原文逐字取回')
  assert.ok(fetched.includes('state=live'))
})

test('SH11 hit= 白名单外拒答：陌生 seq + 被新查询覆盖后旧 seq 失效（单槽诚实句，R4）', async () => {
  const { ctx, session } = await bootFixture()
  const miss = toolText(await execTool(ctx, { name: 'search_history', callId: 'h3', agentSession: session, args: { hit: 999999 } }))
  assert.ok(miss.includes('not in the last result'), '陌生 seq 严拒（非无标签 seq 通道）')
  const found = toolText(await execTool(ctx, { name: 'search_history', callId: 'h4', agentSession: session, args: { keyword: 'kw-SH' } }))
  const oldSeq = seqsOf(found)[0]!
  void toolText(await execTool(ctx, { name: 'search_history', callId: 'h5', agentSession: session, args: { keyword: 'kw-ZERO' } }))
  const stale = toolText(await execTool(ctx, { name: 'search_history', callId: 'h6', agentSession: session, args: { hit: oldSeq } }))
  assert.ok(stale.includes('not in the last result'), '新查询覆盖单槽→旧 hit 失效如实报')
})

test('SH12 分布档（N>250）：无预览无索引+prose User/Assistant 头+faceted 命名避共现', async () => {
  const { ctx, session, internals } = await bootSearch()
  for (let i = 0; i < 251; i++) appendUser(session, 'kw-FAC 条目' + i)
  const out = toolText(await execTool(ctx, { name: 'search_history', callId: 'f1', agentSession: session, args: { keyword: 'kw-FAC' } }))
  assert.ok(out.includes('251 hit(s)'), '命中集总数=251（N 定义 D9）')
  assert.ok(out.includes('exceed the listing threshold'), '超阈不列')
  assert.ok(!out.includes('· hit:"'), '分布档无预览')
  assert.ok(out.includes('Distribution among hits'), 'faceted 命名避共现（S9）')
  assert.ok(out.includes('prose among hits: User×251'), '散文 User 桶')
  assert.ok(internals.stateOf(session).searchIndex === null, '分布档不落索引')
})

test('SH13 单原子多次命中：行内 ×N 次数 + 分散命中出 2 fragment（highlighter canon）', async () => {
  const { ctx, session } = await bootSearch()
  appendUser(session, 'kw-MF 开头 ' + 'a'.repeat(3000) + ' kw-MF 结尾')
  const out = toolText(await execTool(ctx, { name: 'search_history', callId: 'mf1', agentSession: session, args: { keyword: 'kw-MF' } }))
  assert.ok(out.includes('· ×2'), '行内报原始命中次数 ×2（非饱和 score）')
  assert.ok(out.includes('⊕'), '分散两处命中→两个 fragment 窗（不只锚首次）')
  assert.ok(out.indexOf('kw-MF 开头') < out.indexOf('kw-MF 结尾'), '首尾两窗都在')
})

test('SH14 聚集命中退化为单 fragment + ×N：命中挤一簇不硬塞第二窗', async () => {
  const { ctx, session } = await bootSearch()
  appendUser(session, 'kw-CL a kw-CL b kw-CL c')
  const out = toolText(await execTool(ctx, { name: 'search_history', callId: 'cl1', agentSession: session, args: { keyword: 'kw-CL' } }))
  assert.ok(out.includes('· ×3'), '三次命中如实报 ×3')
  assert.ok(!out.includes('⊕'), '命中聚一簇→单窗（重叠锚点跳过，不重复同段）')
})

test('SH15 hit= offset 续读：首页页脚给续读位，offset 读后页，越界如实报（旧"retry next turn"空承诺退役）', async () => {
  const { ctx, session } = await bootSearch()
  appendUser(session, 'kw-OFF start ' + 'x'.repeat(6000) + ' kw-OFF end')
  const out = toolText(await execTool(ctx, { name: 'search_history', callId: 'o1', agentSession: session, args: { keyword: 'kw-OFF' } }))
  const seq = seqsOf(out)[0]!
  const p1 = toolText(await execTool(ctx, { name: 'search_history', callId: 'o2', agentSession: session, args: { hit: seq } }))
  assert.ok(p1.includes('kw-OFF start') && !p1.includes('kw-OFF end'), '首页只装得下头部')
  const m = p1.match(/showed chars 0–(\d+) of (\d+) \(budget cap\) — continue with hit=\d+ offset=\1/)
  assert.ok(m, '页脚如实报窗口 [0–room)、总长、续读位')
  const room = Number(m![1])
  const p2 = toolText(await execTool(ctx, { name: 'search_history', callId: 'o3', agentSession: session, args: { hit: seq, offset: room } }))
  assert.ok(p2.includes('offset=' + room), '头行回显当前 offset')
  assert.ok(!p2.includes('kw-OFF start'), '续页已越过首页内容')
  assert.ok(p2.match(/offset=\d+\n/)!, 'offset 后正文紧接换行')
  const past = toolText(await execTool(ctx, { name: 'search_history', callId: 'o4', agentSession: session, args: { hit: seq, offset: 999999 } }))
  assert.ok(past.includes('past the end'), '越界 offset 如实报，不返回空文本冒充读完')
})

test('SH16 keyword offset 扫描翻页：页脚 next 指针续翻到后页命中，hit= 地址随后页重建（补召素材页正路）', async () => {
  const { ctx, session } = await bootFixture({ proseScanCapChars: 260 })
  appendUser(session, 'kw-PG 第一段 ' + 'a'.repeat(90))
  appendUser(session, 'kw-PG 第二段 ' + 'b'.repeat(90))
  appendUser(session, 'kw-PG 第三段 关键料 kw-PG')
  const p1 = toolText(await execTool(ctx, { name: 'search_history', callId: 'pg1', agentSession: session, args: { keyword: 'kw-PG' } }))
  assert.ok(p1.includes('第一段') && !p1.includes('第三段'), '首页只装最旧窗')
  const m = p1.match(/offset=(\d+)/)!
  const p2 = toolText(await execTool(ctx, { name: 'search_history', callId: 'pg2', agentSession: session, args: { keyword: 'kw-PG', offset: Number(m[1]) } }))
  assert.ok(p2.includes('第三段'), 'offset 续翻必达后页素材（旧世界此处永远出界）')
  assert.ok(p2.includes('end of prose surface'), '末页如实报无后续页')
  const seq2 = seqsOf(p2)
  assert.ok(seq2.length > 0, '后页行带 hit= 地址')
  const fetched = toolText(await execTool(ctx, { name: 'search_history', callId: 'pg3', agentSession: session, args: { hit: seq2[0] } }))
  assert.ok(fetched.includes('关键料 kw-PG'), '后页地址二跳逐字回取打通')
})

test('SH17 冷启动对齐：新引擎实例首查也走日志重放，工具带不空（B4）', async () => {
  // 老引擎已完成剪枝并写日志；新引擎实例的进程内账本是空的（冷 resume 形态）。
  const { session } = await bootFixture()
  const ctx2 = new Context()
  await mountAgentLoopTestDependencies(ctx2, { systemPrompt: { personaPrefix: 'search persona' } })
  await ctx2.plugin(ArgpEngine, { engine: 'factor', windowTokens: 100, retainTokens: 50, recencyGuard: 0 })
  const out = toolText(await execTool(ctx2, {
    name: 'search_history', callId: 'q-cold', agentSession: session, args: { keyword: 'kw-SH' },
  }))
  assert.match(out, /tool×1/, '★冷启动首查必须先补日志重放（ledgerOf 会让工具带恒零候选）')
  assert.ok(out.includes('labels=document:c:/proj/sh.ts'), '重放后的工具带仍带全形标签')
})
