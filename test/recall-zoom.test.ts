/**
 * P3 两级召回 zoom（recall-zoom）单测。
 *
 * 验收判据（plan P3）：
 *  ① verbatim 天花板：detail 返回 = 日志原文逐字节一致（hash 相等断言）
 *  ② 预算拦截与恢复路径各一测（4 倍制 + compaction/end 归零 + resetBudget）
 *  ③ 召回产物回注后成为普通原子（下一轮可被正常门控/剪枝——以 compressor.collectCurrentTurn
 *     把它收为 tool-result 候选为第一性断言）
 *
 * 另有：summary 三档降级（stored/copy/original）、4 倍制预算数学、out-of-range / 无 session /
 * 超预算截断、契约 section 静态注册、预算滑窗在 compaction/end 归零。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId, createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { asSeq, asSeqs } from '../src/log-access.ts'
import { eventText } from '../src/argp-graph-engine.ts'
import { PeratomCompressor } from '../src/peratom/compressor.ts'
import { RecallZoom } from '../src/peratom/recall-zoom.ts'
import { ARG_NS } from '../src/peratom/types.ts'

// ---------------------------------------------------------------------------
// 测试会话构建器（与 recall-log-access.test.ts 同口径）
// ---------------------------------------------------------------------------

/** 一段含精确串的长原文（verbatim 天花板断言载体，含路径 / 错误码 / 行号）。 */
const BIG_ORIGINAL =
  'EADDRINUSE at /opt/svc/app.js:3000\n'
  + 'Error: listen EADDRINUSE :::3000\n'
  + '    at Server.setupListenAfterListen (node:net:1917:16)\n'
  + '  marker=DEADBEEF-0042 line=3000\n'
  + ('stack frame padding '.repeat(40) + '\n')

function appendUser(session: Session, text: string): number {
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  return session.snapshotEvents().length - 1
}

function appendToolResult(session: Session, turn: number, callId: string, text: string): number {
  session.append('tool/result', {
    turn,
    step: 1,
    message: {
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }], isError: false }],
      source: { kind: 'tool', callId },
      id: 'm_' + callId,
    },
  } as never, { surfaceOp: 'append' })
  return session.snapshotEvents().length - 1
}

function appendTurnStart(session: Session, turn: number): void {
  session.append('turn/start', { turn })
}

function appendTurnEnd(session: Session, turn: number, kind = 'completed'): void {
  session.append('turn/end', { turn, reason: { kind } } as never)
}

/**
 * 会话布局（seq = events 索引）：
 *   0 turn/start(1)            —— off-surface 无正文
 *   1 user/message U           —— live 原文
 *   2 tool/result R            —— live 原文（BIG_ORIGINAL，verbatim 载体）
 *   3 turn/end(1)
 */
function buildBaseSession(): Session {
  const session = Session.create(SessionId('rz-base'))
  appendTurnStart(session, 1)
  appendUser(session, 'who ate the cookie?')
  appendToolResult(session, 1, 'c1', BIG_ORIGINAL)
  appendTurnEnd(session, 1)
  return session
}

interface ZoomHarness {
  ctx: Context
  zoom: RecallZoom
}

async function makeZoom(config: Record<string, unknown> = {}): Promise<ZoomHarness> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: 'recall-zoom test persona' } })
  const zoom = new RecallZoom(ctx, { detailBudgetTokens: 2000, ...config })
  return { ctx, zoom }
}

async function runTool(ctx: Context, name: string, args: Record<string, unknown>): Promise<string> {
  const res = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId('rz-' + name + '-' + Math.random().toString(36).slice(2)),
    name,
    arguments: args,
  })
  return res.content[0]?.type === 'text' ? res.content[0].text : ''
}

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex')
}

// ---------------------------------------------------------------------------
// 验收①：verbatim 天花板（detail 返回 = 日志原文逐字节）
// ---------------------------------------------------------------------------

test('验收①：recall_detail 返回 = 日志原文逐字节一致（sha256 相等）', async t => {
  const h = await makeZoom()
  t.after(() => h.ctx.fiber.dispose())
  const session = buildBaseSession()
  h.zoom.setSession(session)

  const rSeq = 2
  const expected = eventText(session, rSeq)
  assert.equal(expected, BIG_ORIGINAL, 'eventText 投影应与原文一致（fixture 自检）')

  const out = await runTool(h.ctx, 'recall_detail', { seq: rSeq })
  assert.ok(out.includes('[recall-detail seq=2 '), 'must carry the recall-detail header: ' + out.slice(0, 80))
  assert.ok(out.includes('state=live'), 'live node must carry state=live')
  const body = out.slice(out.indexOf('\n') + 1)
  assert.equal(sha256(body), sha256(BIG_ORIGINAL), 'detail 正文必须与日志原文逐字节一致')
  assert.equal(h.zoom.records.at(-1)?.hit, true)
  assert.equal(h.zoom.records.at(-1)?.tool, 'recall_detail')
  assert.equal(h.zoom.records.at(-1)?.chars, BIG_ORIGINAL.length)
})

test('recall_detail 越界 seq：out-of-range 说明（不抛错）', async t => {
  const h = await makeZoom()
  t.after(() => h.ctx.fiber.dispose())
  const session = buildBaseSession()
  h.zoom.setSession(session)
  const out = await runTool(h.ctx, 'recall_detail', { seq: 999 })
  assert.ok(out.includes('out of range'), 'must report out-of-range: ' + out)
  assert.equal(h.zoom.records.at(-1)?.reason, 'out-of-range')
  assert.equal(h.zoom.records.at(-1)?.hit, false)
})

test('recall_detail 未绑 session：明确说明（不抛错）', async t => {
  const h = await makeZoom()
  t.after(() => h.ctx.fiber.dispose())
  const out = await runTool(h.ctx, 'recall_detail', { seq: 0 })
  assert.ok(out.includes('no session bound'), 'must report no session: ' + out)
})

// ---------------------------------------------------------------------------
// summary 三档降级：stored / copy / original
// ---------------------------------------------------------------------------

test('recall_summary 档1（stored）：U-info 副本 data[ARG_NS].summary 直接命中', async t => {
  const h = await makeZoom()
  t.after(() => h.ctx.fiber.dispose())
  const session = Session.create(SessionId('rz-stored'))
  appendTurnStart(session, 1)
  const origU = appendUser(session, '原始长资料：' + '数据粘贴 '.repeat(30))
  // U-info 副本（replace 原文，携带 ARG_NS.summary）
  const copyMsg = createUserMessage({ content: [{ type: 'text', text: '（U-info 副本）' }], source: { kind: 'plugin', plugin: 'peratom-compressor' } })
  session.append('user/message', { ...copyMsg, [ARG_NS]: { info: true, sourceSeq: origU, summary: 'INFO-SUMMARY-ABC：用户粘贴了配置资料' } } as never,
    { surfaceOp: { op: 'replace', startSeq: asSeq(origU), endSeq: asSeq(origU) }, sourceEventSeqs: asSeqs([origU]) })
  appendTurnEnd(session, 1)
  h.zoom.setSession(session)

  // 模型按占位符里的"原 seq"召回 → resolveSummaryText 经 sourceEventSeqs 反查副本拿 stored summary
  const out = await runTool(h.ctx, 'recall_summary', { seq: origU })
  assert.ok(out.includes('INFO-SUMMARY-ABC'), 'must return the stored summary via copy reverse-lookup: ' + out)
  assert.equal(h.zoom.records.at(-1)?.source, 'stored')
  assert.equal(h.zoom.records.at(-1)?.state, 'off-surface')
  // per-atom 原地压缩（start===end）把原节点替换出 surface，但**不**进剪枝账本（无 compaction/prune）：
  // 故原 seq 状态是 off-surface（被替换、非剪枝），而非旧的 shadowed（谎称"已剪枝"）。
  // 这正是 2026-08-27 修复的误报：压缩≠剪枝，不应报 state=shadowed。
})

test('recall_summary 档2（copy）：tool/result extract 副本正文（无 ARG_NS，走 sourceEventSeqs 反查）', async t => {
  const h = await makeZoom()
  t.after(() => h.ctx.fiber.dispose())
  const session = buildBaseSession()
  h.zoom.setSession(session)
  const rSeq = 2
  // extract 副本（replace 原文 R，正文=extract，无 ARG_NS；保留 type: 'tool-result' 使 eventText 可投影）
  const origData = session.snapshotEvents()[rSeq]!.data as unknown as { message: { content: Array<Record<string, unknown>> } }
  const origMsg = origData.message
  const origBlock = origMsg.content[0]!
  session.append('tool/result', {
    ...(session.snapshotEvents()[rSeq]!.data as object),
    message: { ...origMsg, content: [{ ...origBlock, content: [{ type: 'text', text: 'EXTRACT-ONLY: EADDRINUSE at port 3000' }] }] },
  } as never, { surfaceOp: { op: 'replace', startSeq: asSeq(rSeq), endSeq: asSeq(rSeq) }, sourceEventSeqs: asSeqs([rSeq]) })

  const out = await runTool(h.ctx, 'recall_summary', { seq: rSeq })
  assert.ok(out.includes('EXTRACT-ONLY'), 'must return the extract copy text: ' + out)
  assert.equal(h.zoom.records.at(-1)?.source, 'copy')
})

test('recall_summary 档3（original）：从未压缩的 seq 降级返回原文 + 标注', async t => {
  const h = await makeZoom()
  t.after(() => h.ctx.fiber.dispose())
  const session = buildBaseSession()
  h.zoom.setSession(session)
  const out = await runTool(h.ctx, 'recall_summary', { seq: 1 })
  assert.ok(out.includes('who ate the cookie'), 'must degrade to original text: ' + out)
  assert.ok(out.includes('no stored summary'), 'must annotate the original fallback')
  assert.equal(h.zoom.records.at(-1)?.source, 'original')
})

// ---------------------------------------------------------------------------
// 预算：4 倍制数学 + 拦截 + 恢复 + 截断 + compaction/end 归零
// ---------------------------------------------------------------------------

test('4 倍制预算数学：summaryBudget = 4 × detailBudget', async t => {
  const h = await makeZoom({ detailBudgetTokens: 100, budgetRatio: 4 })
  t.after(() => h.ctx.fiber.dispose())
  const charsPerToken = 3.5
  assert.equal(h.zoom.detailBudget, Math.floor(100 * charsPerToken))
  assert.equal(h.zoom.summaryBudget, Math.floor(100 * charsPerToken) * 4)
})

test('验收②a：detail 预算拦截（超预算返回引导文案教降档，不硬拒）', async t => {
  const h = await makeZoom({ detailBudgetTokens: 50 }) // 175 字符预算
  t.after(() => h.ctx.fiber.dispose())
  const session = buildBaseSession()
  h.zoom.setSession(session)
  assert.ok(BIG_ORIGINAL.length > h.zoom.detailBudget, 'fixture 必须超预算')

  const first = await runTool(h.ctx, 'recall_detail', { seq: 2 })
  // C1 做实：截断标记回传"下一步该传什么"（续读 from），而非仅诊断预算数
  assert.ok(first.includes('…(truncated at ' + h.zoom.detailBudget + '/' + BIG_ORIGINAL.length + ' chars; call recall_detail(seq=2, from=' + h.zoom.detailBudget + ') to continue)'),
    'first call should be truncated to budget with a continuation hint: ' + first.slice(-160))
  assert.equal(h.zoom.detailUsed, h.zoom.detailBudget, 'budget should be fully consumed')

  const second = await runTool(h.ctx, 'recall_detail', { seq: 2 })
  assert.ok(second.includes('verbatim budget exhausted'), 'second call must be budget-guided: ' + second.slice(0, 80))
  assert.ok(second.includes('recall_summary'), 'guidance must teach de-escalation to recall_summary')
  assert.equal(h.zoom.records.at(-1)?.budgetBlocked, 'detail')
  assert.equal(h.zoom.records.at(-1)?.hit, false)
})

test('验收②b：预算恢复（resetBudget 归零后可再次召回）', async t => {
  const h = await makeZoom({ detailBudgetTokens: 50 })
  t.after(() => h.ctx.fiber.dispose())
  const session = buildBaseSession()
  h.zoom.setSession(session)

  await runTool(h.ctx, 'recall_detail', { seq: 2 }) // 耗尽
  assert.equal(h.zoom.detailUsed, h.zoom.detailBudget, 'precondition: exhausted')
  const blocked = await runTool(h.ctx, 'recall_detail', { seq: 2 })
  assert.ok(blocked.includes('verbatim budget exhausted'), 'precondition: blocked while exhausted')

  // 程序化恢复路径（生产由 compaction/end 事件触发同款归零，见下条测试）
  h.zoom.resetBudget()
  assert.equal(h.zoom.detailUsed, 0, 'resetBudget 归零')

  const recovered = await runTool(h.ctx, 'recall_detail', { seq: 2 })
  assert.ok(recovered.includes('EADDRINUSE'), 'budget reset must allow recall again: ' + recovered.slice(0, 80))
  assert.equal(h.zoom.records.at(-1)?.hit, true)
})

test('compaction/end 事件归零预算（session/event 钩子）', async t => {
  const h = await makeZoom({ detailBudgetTokens: 50 })
  t.after(() => h.ctx.fiber.dispose())
  const session = buildBaseSession()
  h.zoom.setSession(session)
  await runTool(h.ctx, 'recall_detail', { seq: 2 })
  assert.equal(h.zoom.detailUsed, h.zoom.detailBudget, 'precondition: exhausted')
  // 经 ctx 事件总线派发 compaction/end（钩子挂在 ctx.on('session/event')；探针实证
  // session.append 不触发监听器，须 ctx.emit 手动派发，实参 (session, event)；钩子只读
  // event.type，故事件体 as never 缩窄）。
  h.ctx.emit('session/event', session, { type: 'compaction/end', compactionId: 'x' } as never)
  assert.equal(h.zoom.detailUsed, 0, 'compaction/end must zero the budget via the session/event hook')
})

test('summary 预算独立于 detail：耗尽 detail 不影响 summary 档', async t => {
  const h = await makeZoom({ detailBudgetTokens: 50, budgetRatio: 1 }) // summary 预算 = 175 字符
  t.after(() => h.ctx.fiber.dispose())
  const session = buildBaseSession()
  h.zoom.setSession(session)
  await runTool(h.ctx, 'recall_detail', { seq: 2 })
  assert.equal(h.zoom.detailUsed, h.zoom.detailBudget, 'detail exhausted')
  assert.equal(h.zoom.summaryUsed, 0, 'summary untouched')
  const s = await runTool(h.ctx, 'recall_summary', { seq: 1 })
  assert.ok(s.includes('who ate the cookie'), 'summary still works after detail exhaustion: ' + s.slice(0, 80))
})

// ---------------------------------------------------------------------------
// C1 做实：from/limit 分页——截断标记回传续读 from，大节点可完整拿回
// ---------------------------------------------------------------------------

test('C1：from/limit 分页——截断标记回传续读 from，续读拿到剩余正文', async t => {
  const h = await makeZoom({ detailBudgetTokens: 50 }) // 175 字符预算
  t.after(() => h.ctx.fiber.dispose())
  const session = buildBaseSession()
  h.zoom.setSession(session)
  const from = h.zoom.detailBudget // 175
  const first = await runTool(h.ctx, 'recall_detail', { seq: 2 })
  assert.ok(first.includes('call recall_detail(seq=2, from=' + from + ') to continue'), 'first page must name the continuation from: ' + first.slice(-160))
  assert.equal(h.zoom.detailUsed, h.zoom.detailBudget, 'first page consumes the whole budget')
  // 续读：生产由 compaction/end 重置滑窗并放大窗口；此处用大预算 harness 验证"完整拿回"
  const big = await makeZoom({ detailBudgetTokens: 2000 })
  t.after(() => big.ctx.fiber.dispose())
  big.zoom.setSession(session)
  const full = await big.zoom.recallDetail(2, from)
  const body = full.slice(full.indexOf('\n') + 1)
  assert.equal(body, BIG_ORIGINAL.slice(from), 'continuation must return exactly the remaining original text')
  assert.ok(!body.includes('truncated'), 'final page must not be truncated')
  assert.equal(big.zoom.records.at(-1)?.chars, BIG_ORIGINAL.length - from)
})

test('C1：limit 参数限制单次返回字符数（截断标记回传 from=from+limit）', async t => {
  const h = await makeZoom() // 默认预算远大于 limit
  t.after(() => h.ctx.fiber.dispose())
  const session = buildBaseSession()
  h.zoom.setSession(session)
  const out = await runTool(h.ctx, 'recall_detail', { seq: 2, from: 0, limit: 10 })
  const body = out.slice(out.indexOf('\n') + 1)
  assert.equal(body.slice(0, 10), BIG_ORIGINAL.slice(0, 10), 'limit caps the returned chars')
  assert.ok(body.includes('call recall_detail(seq=2, from=10) to continue'), 'limit truncation must name from=10: ' + body.slice(-120))
  assert.equal(h.zoom.records.at(-1)?.chars, 10, 'budget counts only the delivered chars')
})

test('P1：tool/call 参数为对象 → JSON 语义等价重建 + 精确标注（note）', async t => {
  const h = await makeZoom()
  t.after(() => h.ctx.fiber.dispose())
  const session = Session.create(SessionId('rz-tc-obj'))
  appendTurnStart(session, 1)
  // 宿主把 arguments 存成对象（非 raw JSON string）→ 字面量不可恢复
  session.append('tool/call', { turn: 1, step: 1, callId: 'tc1', name: 'bash', arguments: { cmd: 'ls -la', cwd: '/opt/svc' } } as never)
  h.zoom.setSession(session)
  const out = await runTool(h.ctx, 'recall_detail', { seq: 1 })
  assert.ok(out.includes('[tool-call bash('), 'must project the tool-call: ' + out)
  assert.ok(out.includes('[note:'), 'object arguments must carry the reconstruction note: ' + out)
  assert.ok(out.includes('JSON semantic-equivalent reconstruction'), 'note must say JSON semantic-equivalent: ' + out)
  assert.ok(out.includes('"cmd":"ls -la"'), 'reconstructed JSON must be present: ' + out)
})

test('P1：tool/call 参数为字符串（raw JSON）→ 逐字，无重建标注', async t => {
  const h = await makeZoom()
  t.after(() => h.ctx.fiber.dispose())
  const session = Session.create(SessionId('rz-tc-str'))
  appendTurnStart(session, 1)
  const rawArgs = '{"path":"x","depth":2}'
  session.append('tool/call', { turn: 1, step: 1, callId: 'tc2', name: 'read_file', arguments: rawArgs } as never)
  h.zoom.setSession(session)
  const out = await runTool(h.ctx, 'recall_detail', { seq: 1 })
  assert.ok(out.includes('[tool-call read_file(' + rawArgs + ')]'), 'string arguments must be verbatim: ' + out)
  assert.ok(!out.includes('[note:'), 'string arguments must NOT carry a reconstruction note: ' + out)
})

// ---------------------------------------------------------------------------
// 验收③：召回产物回注后成为普通原子（下一轮可被正常门控/剪枝）
// ---------------------------------------------------------------------------

test('验收③：recall_detail 产物回注为 tool/result 后，下一轮 collectCurrentTurn 收为候选', async t => {
  const h = await makeZoom({ detailBudgetTokens: 2000 })
  t.after(() => h.ctx.fiber.dispose())
  const session = buildBaseSession()
  h.zoom.setSession(session)

  // 模型调用 recall_detail 拿到正文（模拟 dsh 在工具返回后 append 的 tool/result）
  const recallOut = await runTool(h.ctx, 'recall_detail', { seq: 2 })
  const body = recallOut.slice(recallOut.indexOf('\n') + 1)
  assert.ok(body.includes('EADDRINUSE'), 'recall body sanity')

  // 下一轮：把召回产物 append 成普通 tool/result（source.kind=tool，dsh 真实行为——
  // 工具返回的完整文本含 header，故键 text|<带header> 区别于原 R 的 text|BIG_ORIGINAL，
  // 不会误判成版本链成员，可正常参剪）。
  appendTurnStart(session, 2)
  appendUser(session, '现在怎么修？')
  const recalledSeq = appendToolResult(session, 2, 'recall-c1', recallOut)
  appendTurnEnd(session, 2)

  // 第一性断言：compressor 的收集器把它当正常 tool-result 候选（无特殊对待、不被跳过）
  const compressor = new PeratomCompressor(h.ctx, {
    endpoint: 'http://fake.test/v1/chat/completions',
    apiKey: 'k',
    model: 'm',
    fetchImpl: (async () => new Response('{}', { status: 200 })) as typeof fetch,
  })
  const collect = compressor.collectCurrentTurn(session)
  assert.ok(collect !== null, 'next turn must be collectable')
  const candidate = collect?.toolResults.find(a => a.seq === recalledSeq)
  assert.ok(candidate !== undefined, 'recalled product must be a normal tool-result candidate')
  assert.equal(candidate?.text, recallOut, 'candidate text = full recall product (header + verbatim)')
  assert.equal(candidate?.callId, 'recall-c1')
})

// ---------------------------------------------------------------------------
// 契约 section：静态注册（独立名 + order，不引用运行时状态）
// ---------------------------------------------------------------------------

test('契约：两工具均注册（路由可达）+ 直驱入口返回两级语义正文', async t => {
  const h = await makeZoom()
  t.after(() => h.ctx.fiber.dispose())
  const session = buildBaseSession()
  h.zoom.setSession(session)
  // 路由可达 = register 成功（未注册会返回 unknown tool 错误，见 enabled=false 测试）
  const outS = await runTool(h.ctx, 'recall_summary', { seq: 1 })
  assert.ok(outS.includes('who ate the cookie'), 'recall_summary routed and returned text')
  const outD = await runTool(h.ctx, 'recall_detail', { seq: 2 })
  assert.ok(outD.includes('EADDRINUSE'), 'recall_detail routed and returned text')
  // 两级语义：summary 正文 ≠ detail 正文（summary 降级原文 vs detail verbatim，seq 不同）
  assert.notEqual(outS, outD)
  // 直驱入口（绕过工具路由）同样可用
  const direct = await h.zoom.recallSummary(1)
  assert.ok(direct.includes('[recall-summary seq=1 '), 'direct drive carries the recall-summary header: ' + direct.slice(0, 60))
})

test('enabled=false：不注册工具（直驱入口仍可用）', async t => {
  const h = await makeZoom({ enabled: false })
  t.after(() => h.ctx.fiber.dispose())
  const session = buildBaseSession()
  h.zoom.setSession(session)
  // 直驱入口仍可用（与工具注册解耦）
  const direct = await h.zoom.recallDetail(2)
  assert.ok(direct.includes('EADDRINUSE'), 'direct drive works even with tools disabled')
  // 工具未注册 → 路由返回 unknown tool 错误（探针实证：不抛错，返回 isError 结果）
  const res = await h.ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId('rz-disabled-' + Math.random().toString(36).slice(2)),
    name: 'recall_detail',
    arguments: { seq: 2 },
  })
  assert.equal(res.isError, true, 'unregistered tool must return an error result')
  assert.ok(String((res as { error?: { message?: string } }).error?.message ?? '').includes('unknown tool'), 'must be an unknown-tool error')
})
