/**
 * tool 因子键升格 + 交互类词表预览 + keyword 通道（design-tool-facet-2026-11-16 v3）。
 *
 * 锁面（§7 ZT1-ZT11 / §11.6 KR1-KR6）：
 *  - ZT1 键形：非空工具名被剪后倒排/词表含 `tool:<注册名>`（含未知工具）；
 *  - ZT2 死桩（**只锁 clip 臂**，P0-1：默认臂不产桩文本）：clip 桩含 tool: 地址；
 *  - ZT3 焦点免疫：focalLabels 永不产出 `tool:` 前缀键（含空尾形）；
 *  - ZT4 两段化：预算紧时交互行在场、普通段先裁；段内溢出 document 先让位；
 *  - ZT5 预览文法：控制符压平 / secret 侧弃 / 80 截断 / 形状不符降级；
 *  - ZT6 重建一致：在线剪枝 vs 新引擎实例从日志重建，preview/词表逐字节一致；
 *  - ZT7 交互组检查点：专段含 tool: 地址、不含「次要原子」（P7=带）；
 *  - ZT8 裸名排除：裸标签查询不展开到 tool 桶；
 *  - ZT9 空尾键：`tool:''` 的孤儿 R 三面（倒排/桩/焦点）都不产 `tool:`；
 *  - ZT10 混合组：措辞只提在场成员，read-only 组仍中性 MARKER；
 *  - ZT11 名单门槛：名单外工具永不产预览；名单内形状不符 ⇒ 名-only 行；
 *  - KR1 双空闸：labels/keyword 至少一个；KR2 AND（keyword 不越过 label 集、不复活
 *    被拒候选）；KR3 确定性；KR4 keyword 文法闸拒收可见；KR5 预算记账复用；
 *    KR6 扫描面 = 被剪 R 原文（live 内容不可 grep）。
 *
 * 变异台账（2026-11-16 全量执行：21 变异全红，cp 快照回滚后哈希=基线）：
 *  M1a indexKeys 去 tool push→红(ZT1/ZT6)；M1b 去非空门槛→红(ZT3/ZT9/倒排键形)；
 *  M2 stubKey 去 tool 尾→红(ZT2)；M3 isInteractive 谓词摘除→红(ZT4)；
 *  M4 空标题回滚摘除→红(ZT4 + 词表饥饿旧锁)；M5 queryPruned restrictTo 交集摘除→红(KR2)；
 *  M6 shrinkSide 去 labelAllowed→红(ZT5-secret)；M7 去 80 截断→红(ZT5)；
 *  M8 flatten 压平摘除→红(ZT5 问句控制符)；M9 exit 剥井号摘除→红；M10 A 侧降级裸取 R→红(P1-4/形状门槛)；
 *  M11 检查点专段摘除→红(ZT7)；M12 专段措辞改全名单→红(ZT10)；
 *  M13 组剪 preview 透传摘除→红(ZT6；**实锤**：施工期本缺此透传，ZT6 天然先红)；
 *  M14 tagRsFromLog 提取摘除→红(ZT6/ZT5)；M15 KR1 双空闸→红；M16/M17 KR4 文法/trim 闸→红；
 *  M18 扫描 hay 小写摘除→红(KR2+/大小写)；M19 预算记账旁路→红(KR5)；
 *  M20 list_labels tool 去重摘除→红；M21 FACET_PREFIXES 加 tool:→红(ZT8)。
 *  结构锁（如实记，不伪装变异）：KR3=同查询逐字节等值 + 0-LLM 纯函数无随机源；
 *  KR6=候选面(账本条目)+行面(rows∈ledger)双闸冗余，单点摘除不红是设计属性；
 *  ZT11=名单闸+形状门槛双防线，名单闸单摘不红（形状门槛独立兜底，危险形态由 M10 锁）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ArgpEngine } from '../src/argp-engine.ts'
import { FactorEngine, type FactorEngineHost } from '../src/factor/engine.ts'
import { FactorLedger, indexKeys, renderVocabulary } from '../src/factor/factor-ledger.ts'
import { extractPreview, interactiveCheckpointText, isInteractiveToolKey } from '../src/factor/interactive.ts'
import { focalLabels } from '../src/factor/factor-atoms.ts'
import { FACTOR_COMPACTED_MARKER } from '../src/constants.ts'
import { eventText } from '../src/log-access.ts'
import { execTool, toolText } from './tool-execute-shape.ts'
import type { RTags } from '../src/factor/types.ts'

function mkTags(over: Partial<RTags> = {}): RTags {
  return {
    tool: 'read', files: [], scopes: [], commands: [], errorcodes: [],
    errorish: false, writeish: false, cwdSeen: false, argsFp: '',
    readRange: null, sizeChars: 10, rejects: {}, ...over,
  }
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

/** 一条 A 携多个 tool-call（混合组判据 ZT10 用）。 */
function appendMultiCallGroup(session: Session, turn: number, calls: Array<{ callId: string; tool: string; args: string }>, resultTextBy: (tool: string) => string): void {
  session.append('assistant/message', {
    stream: [], turn, step: 1,
    message: createAssistantMessage({
      source: { provider: 'test', model: 'test' },
      content: [{ type: 'text', text: 'multi' }, ...calls.map(c => ({ type: 'tool-call', id: c.callId, name: c.tool, arguments: c.args } as never))],
    }),
  } as never, { surfaceOp: 'append' })
  for (const c of calls) session.append('tool/call', { turn, callId: c.callId, name: c.tool, arguments: c.args } as never)
  for (const c of calls) {
    session.append('tool/result', {
      turn, step: 1,
      message: {
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: c.callId, content: [{ type: 'text', text: resultTextBy(c.tool) }], isError: false }],
        source: { kind: 'tool', callId: c.callId },
        id: 'm_' + c.callId,
      },
    } as never, { surfaceOp: 'append' })
  }
}

function makeSession(id: string): Session {
  const session = Session.create(SessionId(id))
  session.append('system/message', { content: 'persona' } as never, { surfaceOp: 'append' })
  return session
}

async function boot(engineCfg: { clipEnabled?: boolean } = {}): Promise<{ host: FactorEngineHost; factor: FactorEngine }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: 'tool facet persona' } })
  await ctx.plugin(ArgpEngine, { windowTokens: 100, retainTokens: 50, recencyGuard: 0, maxPasses: 8 })
  const engine = ctx.compaction as ArgpEngine
  const host = engine as unknown as FactorEngineHost
  return { host, factor: new FactorEngine(host, engineCfg.clipEnabled === true ? { clipEnabled: true } : {}) }
}

async function bootRecall(): Promise<{ ctx: Context; factor: () => FactorEngine | null; stateOf: (s: Session) => { recallCharsUsed: number } }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: 'tool facet recall persona' } })
  await ctx.plugin(ArgpEngine, { engine: 'factor', windowTokens: 100, retainTokens: 50, recencyGuard: 0 })
  const internals = ctx.compaction as unknown as { factor: FactorEngine | null; stateOf(s: Session): { recallCharsUsed: number } }
  return { ctx, factor: () => internals.factor, stateOf: s => internals.stateOf(s) }
}

const ASK_ARGS = '{"questions":[{"id":"q1","question":"部署要上生产吗？"},{"id":"q2","question":"回滚窗口留多久？"}]}'
const ASK_RESULT = JSON.stringify({ answers: [{ id: 'q1', selected: ['上生产'] }, { id: 'q2', selected: [], custom: '留 24h' }] })

// ---------------------------------------------------------------------------
// 提取器单测（ZT5/ZT11 + 形状门槛）
// ---------------------------------------------------------------------------

test('extractPreview ask_user_question：Q 逐问拼接+qCount；A 走 answers 解析非 JSON 骨架（P1-4）', () => {
  const p = extractPreview('ask_user_question', ASK_ARGS, ASK_RESULT)
  assert.ok(p !== null)
  assert.ok(p.q !== undefined && p.q.includes('部署要上生产吗？') && p.q.includes('回滚窗口留多久？'))
  assert.equal(p.qCount, 2, '多问必须带 q×n 记号（防预览装不下全部导致漏答误导）')
  assert.ok(p.a !== undefined && p.a.includes('上生产') && p.a.includes('留 24h'), 'selected+custom 都进 A 侧')
  assert.ok(!p.a.includes('"answers"'), 'A 侧禁止是 JSON 骨架')
})

test('extractPreview 形状门槛：answers 非 JSON ⇒ q-only 降级；名单外恒 null（ZT11）', () => {
  const p = extractPreview('ask_user_question', ASK_ARGS, 'not a json <<<')
  assert.ok(p !== null && p.q !== undefined && p.a === undefined, '形状不符 ⇒ 名-only/Q-only，绝不硬编造')
  assert.equal(extractPreview('read', ASK_ARGS, ASK_RESULT), null, '名单外工具永不产预览（ZT11）')
  const noQ = extractPreview('ask_user_question', '{"nope":1}', ASK_RESULT)
  assert.ok(noQ !== null && noQ.q === undefined && noQ.a !== undefined, 'args 形状不符 ⇒ 无 Q 侧、A 侧照解析')
})

test('extractPreview 收缩：控制符压平单行、80 截断、secret 侧弃（ZT5）', () => {
  const p = extractPreview('subagent', '{"prompt":"第一行任务\\n第二行不该出现在单行预览里"}', 'started subagent agent-1')
  assert.ok(p !== null && p.q !== undefined && !/[\r\n]/.test(p.q), 'Q 侧压平成单行')
  const nl = extractPreview('ask_user_question', '{"questions":[{"id":"q1","question":"部署\\n上线吗"}]}', ASK_RESULT)
  assert.ok(nl !== null && nl.q !== undefined && !/[\r\n]/.test(nl.q) && nl.q.includes('部署 上线吗'),
    '问句正文实过 flatten：控制符压成单空格（不侧弃、不进词表行）')
  assert.ok(p.a === undefined, 'subagent A 侧恒缺——R 是启动回执（P0-2）')
  const long = extractPreview('subagent', JSON.stringify({ prompt: 'x'.repeat(300) }), 'started subagent a')
  assert.ok(long !== null && long.q !== undefined && long.q.length <= 80, '每侧 ≤80 chars')
  const secret = extractPreview('ask_user_question', '{"questions":[{"id":"q1","question":"用哪个 key"}]}',
    JSON.stringify({ answers: [{ id: 'q1', selected: [], custom: 'sk-abcdefghijklmnop1234' }] }))
  assert.ok(secret !== null && secret.a === undefined, 'secret 形态 ⇒ 该侧 labelAllowed 拒收')
  // ADV-5：secret 恰跨 80 截断线——先截后验会把 sk- 切成断尾残缺形令正则失配（穿透口）
  const cross = extractPreview('ask_user_question',
    JSON.stringify({ questions: [{ id: 'q1', question: 'x'.repeat(75) + ' sk-abcdefghijklmnop1234' }] }), ASK_RESULT)
  assert.ok(cross !== null && cross.q === undefined, '★原串含 secret 且截后成残缺形 ⇒ 整侧弃（截先验后即穿透）')
  // M6 锁：后置复检独立面——「…」属 \S，截断点恰落 token 尾时把尾 token 延一字符
  // 跨过 `token[:=]\S{6,}` 阈值（ABCDE→ABCDE…=6）：原串放行、capped 才命中 ⇒ 前置检测抓不到。
  const cross2 = extractPreview('ask_user_question',
    JSON.stringify({ questions: [{ id: 'q1', question: 'a'.repeat(67) + ' token=ABCDE end' }] }), ASK_RESULT)
  assert.ok(cross2 !== null && cross2.q === undefined, '★截后「…」延符跨界 ⇒ 后置复检独立拦截（摘后置即穿透）')
})

test('extractPreview exit_plan_mode：Q=plan 首行剥 #；A=判决文案首行', () => {
  const p = extractPreview('exit_plan_mode', '{"plan":"# 发布 2.1.0\\n\\n步骤若干"}', 'Plan approved by user.\nnext')
  assert.ok(p !== null)
  assert.equal(p.q, '发布 2.1.0')
  assert.ok(p.a !== undefined && p.a.includes('approved') && !p.a.includes('\n'))
})

test('interactiveCheckpointText：只提在场成员 + 带 tool: 地址（ZT7/ZT10 文案侧）', () => {
  const t = interactiveCheckpointText(['ask_user_question'])
  assert.ok(t.includes('用户问答') && t.includes('recall_history(tool:ask_user_question)'), '在场成员+即时指针')
  assert.ok(!t.includes('次要原子') && !t.includes('计划审批'), '普通组措辞词与不在场成员都不得出现')
  const multi = interactiveCheckpointText(['subagent_fork'])
  assert.ok(multi.includes('子代理启动') && !multi.includes('用户回答') && !multi.includes('报告'), 'subagent 不得暗示可取回报告（P0-2）')
})

test('isInteractiveToolKey：tool: 前缀 + 名单；非 tool 键恒 false', () => {
  assert.equal(isInteractiveToolKey('tool:ask_user_question'), true)
  assert.equal(isInteractiveToolKey('tool:read'), false)
  assert.equal(isInteractiveToolKey('document:c:/a.ts'), false)
})

// ---------------------------------------------------------------------------
// 词表两段化（ZT4）
// ---------------------------------------------------------------------------

test('renderVocabulary 两段化：预算紧时交互行在场、普通段先裁；段内溢出 document 先让位（ZT4/A5）', () => {
  const l = new FactorLedger()
  l.addPruned({ rootSeq: 1, turn: 1, tags: mkTags({ tool: 'ask_user_question' }), preview: { q: '部署吗', a: '上' } })
  l.addPruned({ rootSeq: 2, turn: 2, tags: mkTags({ tool: 'read', files: ['c:/a.ts'] }) })
  l.addPruned({ rootSeq: 3, turn: 3, tags: mkTags({ tool: 'grep', errorcodes: ['ERR-X'] }) })
  l.addPruned({ rootSeq: 4, turn: 4, tags: mkTags({ tool: 'bash', commands: ['command:npm'] }) })
  const full = renderVocabulary({ ledger: l, topNPerFacet: 10, budgetChars: 4000, isInteractive: isInteractiveToolKey })
  assert.ok(full.text.includes('- tool:ask_user_question ×1 · ok @t1 · Q:"部署吗" A:"上"'), '交互行变体：预览在场')
  assert.ok(full.text.includes('- tool:read ×1 · ok @t2'), 'tool 普通行去重 last: 重复')
  assert.ok(!/^- tool:\S+ .*· last: /m.test(full.text), 'tool 桶行不得再带 last: <同键名>')
  assert.ok(full.text.includes('last: grep'), '非 tool 面保留 last:')
  assert.ok(full.text.indexOf('tool:ask_user_question') < full.text.indexOf('document:c:/a.ts'), '交互段先于 document（保号段序）')
  assert.ok(full.truncated === false)

  // 预算卡在普通段 tool 块之前：普通 tool 行出局、交互行仍在（截断代价全落普通段）。
  const toolPlainIdx = full.text.indexOf('- tool:read')
  assert.ok(toolPlainIdx > 0)
  const cut1 = renderVocabulary({ ledger: l, topNPerFacet: 10, budgetChars: toolPlainIdx, isInteractive: isInteractiveToolKey })
  assert.ok(cut1.text.includes('tool:ask_user_question'), '交互行（保号段）必须存活')
  assert.ok(!cut1.text.includes('- tool:read'), '普通段先裁')
  assert.equal(cut1.truncated, true, '诚实截断标记')

  // 预算卡在保号段内部（document 行之前）：document 先让位，交互行仍最后裁（A5 段内序）。
  const docIdx = full.text.indexOf('- document:c:/a.ts')
  assert.ok(docIdx > 0)
  const cut2 = renderVocabulary({ ledger: l, topNPerFacet: 10, budgetChars: docIdx, isInteractive: isInteractiveToolKey })
  assert.ok(cut2.text.includes('tool:ask_user_question'), '段内溢出时交互行仍在（最后裁）')
  assert.ok(!cut2.text.includes('document:c:/a.ts'), '段内溢出 document 先让位')
  assert.ok(!cut2.text.includes('document（'), '空标题回滚：header 不得单独入文')
})

test('renderVocabulary 无 isInteractive 注入 ⇒ 全部 tool 行落普通段（分层兼容）', () => {
  const l = new FactorLedger()
  l.addPruned({ rootSeq: 1, turn: 1, tags: mkTags({ tool: 'ask_user_question' }), preview: { q: '部署吗' } })
  const v = renderVocabulary({ ledger: l, topNPerFacet: 10, budgetChars: 4000 })
  assert.ok(v.text.includes('tool:ask_user_question'), '键照列')
  assert.ok(!v.text.includes('Q:"'), '无谓词注入 ⇒ 无交互段/预览（名单知识不进叶子模块）')
})

// ---------------------------------------------------------------------------
// 引擎级：ZT1/ZT6/ZT7/ZT9/ZT10/ZT2
// ---------------------------------------------------------------------------

test('ZT1：未知工具被剪 ⇒ 倒排+词表含 tool:<注册名>（原样含字面冒号名）', async () => {
  const { host, factor } = await boot()
  const session = makeSession('zt1')
  host.bindSession(session)
  appendUser(session, '开始')
  appendGroup(session, 1, 'c1', 'tool:jobs', '{"job":"watch"}', 'JOB OUTPUT BODY '.repeat(30))
  appendGroup(session, 2, 'c2', 'read', '{"file_path":"C:/Proj/b.ts"}', 'FOCUS '.repeat(50))
  appendUser(session, '收尾')
  assert.ok(factor.compactIfNeeded(session, 1000) !== null)
  assert.ok(factor.ledger.stat('tool:tool:jobs') !== null, '双前缀键原样入键（P8：键形=注册名逐字）')
  const vocab = factor.vocabulary(session).text
  assert.ok(vocab.includes('- tool:tool:jobs ×1 · ok @t1'), '词表 tool 行在场且去重 last:')
})

test('ZT6：在线 vs 新引擎实例日志重建，preview 与词表逐字节一致（重建走同一点提取）', async () => {
  const { host, factor } = await boot()
  const session = makeSession('zt6')
  host.bindSession(session)
  appendUser(session, '开始')
  appendGroup(session, 1, 'a1', 'ask_user_question', ASK_ARGS, ASK_RESULT.repeat(10))
  appendGroup(session, 2, 'c2', 'read', '{"file_path":"C:/Proj/b.ts"}', 'FOCUS '.repeat(50))
  appendUser(session, '收尾')
  assert.ok(factor.compactIfNeeded(session, 1000) !== null)
  const online = factor.vocabulary(session).text
  assert.ok(online.includes('Q×2:"部署要上生产吗？'), '在线预览在场（多问带 q×2 记号）')
  const resumed = new FactorEngine(host)
  const rebuilt = resumed.vocabulary(session)
  assert.equal(rebuilt.text, online, 'ZT6：重建路径（tagRsFromLog 再提取）与在线逐字节一致')
})

test('ZT7/ZT10：交互组检查点专段带地址；措辞只提在场成员', async () => {
  const { host, factor } = await boot()
  const session = makeSession('zt7')
  host.bindSession(session)
  appendUser(session, '开始')
  // 两枚候选都 < 目标 1000 ⇒ plan 必须连剪两组（focalTurns=1 只护 turn3）
  appendGroup(session, 1, 'a1', 'ask_user_question', ASK_ARGS, ASK_RESULT.repeat(6))
  appendMultiCallGroup(session, 2, [
    { callId: 'm1', tool: 'exit_plan_mode', args: '{"plan":"# 发布计划\\n细节"}' },
    { callId: 'm2', tool: 'read', args: '{"file_path":"C:/Proj/m.ts"}' },
  ], () => 'MIXED BODY '.repeat(30))
  appendGroup(session, 3, 'c3', 'read', '{"file_path":"C:/Proj/b.ts"}', 'FOCUS '.repeat(50))
  assert.ok(factor.compactIfNeeded(session, 1000) !== null)
  const checkpointTexts = [...session.surface.nodes]
    .map(n => eventText(session, n as number))
    .filter(t => t.includes('已压缩'))
  const ask = checkpointTexts.find(t => t.includes('tool:ask_user_question'))
  assert.ok(ask !== undefined, '交互组专段带即时指针（P7=带）')
  assert.ok(!ask.includes('次要原子'), '专段不得沿用中性 MARKER 词')
  const mixed = checkpointTexts.find(t => t.includes('tool:exit_plan_mode'))
  assert.ok(mixed !== undefined && mixed.includes('计划审批'), '混合组走专段且措辞含在场成员')
  assert.ok(!mixed.includes('用户问答'), '混合组措辞只提在场成员（ZT10：不得含组内不存在的承诺）')
})

test('ZT9：孤儿 R（issuer 缺失 ⇒ tool 名空）倒排/词表两面不产空尾键（焦点面由 ZT3 结构锁）', async () => {
  const { host, factor } = await boot()
  const session = makeSession('zt9')
  host.bindSession(session)
  appendUser(session, '开始')
  // 无 tool/call 事件的孤儿 R（callId 配不到 issuer ⇒ tool:''，实测常态）
  session.append('tool/result', {
    turn: 1, step: 1,
    message: {
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: 'ghost', content: [{ type: 'text', text: 'ORPHAN '.repeat(50) }] }],
      source: { kind: 'tool', callId: 'ghost' },
      id: 'm_ghost',
    },
  } as never, { surfaceOp: 'append' })
  appendGroup(session, 2, 'c2', 'read', '{"file_path":"C:/Proj/b.ts"}', 'FOCUS '.repeat(50))
  assert.ok(factor.compactIfNeeded(session, 200) !== null, '孤儿 R 组剪离场')
  assert.equal(factor.ledger.stat('tool:'), null, '倒排无空尾键（ZT9）')
  const vocab = factor.vocabulary(session).text
  assert.ok(!vocab.includes('- tool: '), '词表无 `- tool:` 空尾行')
})

test('ZT3：focalLabels 对 U/A 文本直调也永不产出 tool: 前缀（结构性质）', () => {
  const atoms = [
    { seq: 1, type: 'U' as const, turn: 2, text: 'ask_user_question 和 exit_plan_mode 都跑过了，读 a.ts 报 ERESOLVE', toolCallIds: [] },
    { seq: 2, type: 'A' as const, turn: 2, text: 'tool:ask_user_question 字面出现也不产键', toolCallIds: [] },
  ]
  const focal = focalLabels(atoms, 2, 5, undefined)
  assert.ok(focal.size >= 0)
  assert.ok(![...focal].some(k => k.startsWith('tool:')), 'U/A 文本通道经 extractTags(tool:"") ⇒ 结构上不可产 tool: 键')
})

test('ZT2：clip 对照臂桩文本含 tool: 地址（默认臂不产桩文本——P0-1 语境）', async () => {
  const { host, factor } = await boot({ clipEnabled: true })
  const session = makeSession('zt2')
  host.bindSession(session)
  // 2.2.2 存档地雷锁：clip 臂落 tool/result replace，宿主 v4 fold 要求开放轮内
  //（真实 pre-step 恒在轮内）；轮号大于全部原子 ⇒ 只喂 detectOpenTurn，不动决策口径。
  session.append('turn/start', { turn: 999 } as never)
  appendUser(session, '开始')
  appendGroup(session, 1, 'x1', 'custom-x', '{"foo":1}', 'HEADK ok\n' + 'w'.repeat(4000) + '\nTAIL end')
  appendGroup(session, 2, 'c2', 'read', '{"file_path":"C:/Proj/b.ts"}', 'FOCUS '.repeat(50))
  appendUser(session, '收尾')
  const r = factor.compactIfNeeded(session, 6000)
  assert.ok(r !== null)
  const stubbed = [...session.surface.nodes]
    .map(n => eventText(session, n as number))
    .filter(t => t.includes('[已剪·因子]'))
  assert.ok(stubbed.length >= 1, 'clip 臂产生桩')
  assert.ok(stubbed.some(t => t.includes('tool:custom-x')), '桩内地址含 tool:<名>（clip 臂受益面）')
})

// ---------------------------------------------------------------------------
// 召回面：ZT8 + KR1-KR6
// ---------------------------------------------------------------------------

/** 造一个含交互剪枝 + read 剪枝 + live 内容的会话并返回 boot 面。 */
async function bootPruned() {
  const { ctx, factor, stateOf } = await bootRecall()
  const internals = ctx.compaction as unknown as { bindSession(s: Session): void }
  const session = makeSession('kr')
  internals.bindSession(session)
  appendUser(session, '开始')
  // 两枚候选各自 < 目标 1000 ⇒ plan 连剪 ask+keep（turn3 受焦点保护）
  appendGroup(session, 1, 'a1', 'ask_user_question', ASK_ARGS, ASK_RESULT.repeat(6))
  appendGroup(session, 2, 'r1', 'read', '{"file_path":"C:/Proj/keep.ts"}', 'ZZZTOPSECRET 已剪内容标记'.repeat(35))
  appendGroup(session, 3, 'c3', 'read', '{"file_path":"C:/Proj/b.ts"}', 'FOCUS '.repeat(50))
  const f = factor()
  assert.ok(f !== null && f.compactIfNeeded(session, 1000) !== null)
  // turn4 的 live R 带同词但不入被剪账本（KR6）
  appendGroup(session, 4, 'l1', 'read', '{"file_path":"C:/Proj/live.ts"}', 'ZZZTOPSECRET live 内容不可 grep')
  return { ctx, session, stateOf }
}

test('ZT8+KR1：labels 空 ⇒ 引导文案（含 search_history 指路）；裸名不展开 tool 桶', async () => {
  const { ctx, session } = await bootPruned()
  const empty = toolText(await execTool(ctx, { name: 'recall_history', callId: 'e1', agentSession: session, args: {} }))
  assert.ok(empty.includes('search_history'), 'KR1：标签空 ⇒ 引导（含 search_history 内容发现指路），不落全表扫描')
  const bare = toolText(await execTool(ctx, { name: 'recall_history', callId: 'e2', agentSession: session, args: { labels: ['ask_user_question'] } }))
  assert.ok(bare.includes('not in the pruned ledger'), '裸名按现契约回显 unknown')
  assert.ok(!bare.includes('by labels [tool:ask_user_question]'), 'ZT8：裸名不展开进 tool 桶')
})

test('KR2（迁册 search_history）：labels+keyword = AND；keyword 不越过有效 label 集', async () => {
  const { ctx, session } = await bootPruned()
  // keep.ts 原文含 needle、ask 答案不含：AND 应只回 keep 一枚
  const both = toolText(await execTool(ctx, {
    name: 'search_history', callId: 'k1', agentSession: session,
    args: { labels: ['document:c:/proj/keep.ts'], keyword: 'ZZZTOPSECRET' },
  }))
  assert.ok(both.includes('hit=') && both.includes('ZZZTOPSECRET'), 'AND：label 集内 keyword 命中，预览在场')
  assert.ok(!both.includes('ask_user_question'), 'label 集外的 keyword 命中枚不得被捞进（不越集）')
  const miss = toolText(await execTool(ctx, {
    name: 'search_history', callId: 'k2', agentSession: session,
    args: { labels: ['tool:ask_user_question'], keyword: 'ZZZTOPSECRET' },
  }))
  assert.ok(miss.includes('0 hit(s)'), 'label 集内零 keyword 命中 ⇒ 空手（keyword 不扩集）')
  // 现契约「空想 label 剔除不杀查询」+ keyword：label 不缩候选，keyword 独立发现，
  // 空想回显必须仍在场（模型要能看到自己哪半是空想）。
  const ghost = toolText(await execTool(ctx, {
    name: 'search_history', callId: 'k3', agentSession: session,
    args: { labels: ['errorcode:NOPE_NOT_THERE'], keyword: 'ZZZTOPSECRET' },
  }))
  assert.ok(ghost.includes('labels not in the pruned ledger, ignored'), '空想 label 照旧回显')
  assert.ok(ghost.includes('ZZZTOPSECRET'), 'keyword 独立发现不被空想 label 拖死')
  // 多标签真交集（M5 活锁）：keep.ts 是 tool:read、ask 是 tool:ask_user_question，
  // 两标签交叉=空集；若退化为并集会把 keep（含 ZZZ）误捞回。
  const inter = toolText(await execTool(ctx, {
    name: 'search_history', callId: 'k4', agentSession: session,
    args: { labels: ['document:c:/proj/keep.ts', 'tool:ask_user_question'], keyword: 'ZZZTOPSECRET' },
  }))
  assert.ok(inter.includes('0 hit(s)'), '多标签 AND=真交集（非并集，摘交集收口=并集则误捞）')
})

test('KR2+/KR3+KR5+KR6（迁册 search_history）：keyword 发现模式=行+全形标签+命中窗；同查询确定性；预算记账；live 不可 grep', async () => {
  const { ctx, session, stateOf } = await bootPruned()
  const first = toolText(await execTool(ctx, {
    name: 'search_history', callId: 'd1', agentSession: session,
    args: { keyword: 'ZZZTOPSECRET' },
  }))
  assert.ok(first.includes('search_history "ZZZTOPSECRET"'), 'keyword 发现头')
  assert.ok(first.includes('· hit:"'), '命中窗在场')
  assert.ok(first.includes('labels=document:c:/proj/keep.ts'), '发现行随行走全形标签（教学闭环）')
  // KR3 确定性：同查询逐字节等值（0-LLM ⇒ 无排序抖动；预算记账同轮不改变行内容）
  const second = toolText(await execTool(ctx, {
    name: 'search_history', callId: 'd2', agentSession: session,
    args: { keyword: 'ZZZTOPSECRET' },
  }))
  assert.equal(second, first, 'KR3：同查询逐字节一致')
  const lowered = toolText(await execTool(ctx, {
    name: 'search_history', callId: 'd2b', agentSession: session,
    args: { keyword: 'zzztopsecret' },
  }))
  assert.ok(lowered.includes('hit='), '大小写不敏感')
  const live = toolText(await execTool(ctx, {
    name: 'search_history', callId: 'd3', agentSession: session,
    args: { keyword: 'live 内容不可 grep' },
  }))
  assert.ok(live.includes('no matches'), 'KR6：live R 同词不可命中（非被剪原文、非 U/A 散文）')
  assert.ok(stateOf(session).recallCharsUsed > 0, 'KR5：keyword 通道同走 budgetRecallText 记账')
})

test('KR4（迁册 search_history）：keyword 文法闸——过短/过长/控制符拒收可见', async () => {
  const { ctx, session } = await bootPruned()
  const short = toolText(await execTool(ctx, { name: 'search_history', callId: 'g1', agentSession: session, args: { keyword: 'x' } }))
  assert.ok(short.includes('literal substring of 2-'), '1 字符拒收可见')
  const ctrl = toolText(await execTool(ctx, { name: 'search_history', callId: 'g2', agentSession: session, args: { keyword: 'a\nb' } }))
  assert.ok(ctrl.includes('literal substring'), '控制符拒收')
  const long = toolText(await execTool(ctx, { name: 'search_history', callId: 'g3', agentSession: session, args: { keyword: 'y'.repeat(101) } }))
  assert.ok(long.includes('literal substring'), '超长拒收')
  const emptyish = toolText(await execTool(ctx, { name: 'search_history', callId: 'g4', agentSession: session, args: { keyword: '   ' } }))
  assert.ok(emptyish.includes('keyword is required'), 'trim 后空显式拒绝（不静默降级）')
})

test('list_labels：category=tool 放行且行去重 last:；交互键可列', async () => {
  const { ctx, session } = await bootPruned()
  const t = toolText(await execTool(ctx, { name: 'list_labels', callId: 'll1', agentSession: session, args: { category: 'tool' } }))
  assert.ok(t.includes('tool:ask_user_question'), 'tool 类别可列')
  assert.ok(!/last: ask_user_question/.test(t), 'tool 桶行去重 last: 重复')
})

test('MARKER 不变：普通组检查点仍逐字 `已压缩剪枝次要原子`', async () => {
  const { host, factor } = await boot()
  const session = makeSession('marker')
  host.bindSession(session)
  appendUser(session, '开始')
  appendGroup(session, 1, 'c1', 'read', '{"file_path":"C:/Proj/a.ts"}', 'OLD CONTENT '.repeat(50))
  appendGroup(session, 2, 'c2', 'read', '{"file_path":"C:/Proj/b.ts"}', 'NEW CONTENT '.repeat(50))
  appendUser(session, '收尾')
  assert.ok(factor.compactIfNeeded(session, 1000) !== null)
  const cps = [...session.surface.nodes]
    .map(n => eventText(session, n as number))
    .filter(t => t.includes(FACTOR_COMPACTED_MARKER))
  assert.equal(cps.length, 1, '普通 read 组仍落 MARKER（零指针裁定不变）')
})
