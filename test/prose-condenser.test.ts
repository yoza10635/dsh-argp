/**
 * src/factor/prose-condenser.ts 契约（§9.36 浓缩通道改版，用户 2026-11-13 系列裁定）：
 * 触发=**合取双闸**——闸一 散文 ≥50%×声明窗（PROSE_TRIGGER_RATIO，本文件）∧ 闸二 总上下文
 * ≥ windowRatio(0.8)×声明窗（引擎 condenseGate，usage 账单锚）；输入面=span 全栈
 * U/A+CALL/RESULT **日志原文**（桩族以原文替位，[散文压缩] checkpoint 滚动替身）；
 * 刀深=**清扫式合并**（焦点外前缀一轮全吞；H2 终裁：压缩比不可控，禁挂"压到线"保证）；
 * 输出预算=min(20480, 0.2×声明窗−512)（H5）。并行链语义不变：整轮段单浓缩节点无逐原子
 * 墓碑 / 破段轮逐原子指针；无逐字转写带（原始信息 recall 兜底）。
 *
 * 变异台账（摘锁必须变红，逐条 cp 快照回滚验红）：
 *  PC1 触发判定摘除（比值 ≤ 线也动作）→ T1 红；
 *  PC2 贪心破段停摘除（跨洞续段/整段逐原子化）→ T3 红（整轮段出现逐原子 [elided 桩）；
 *  PC3 kind 标记摘除（浓缩节点无 [散文压缩] 前缀）→ T2 红；
 *  PC4 全栈输入摘除（RESULT/CALL 文本缺出摘要请求——§9.36 对旧"仅 sys+散文"的反转锁）→ T4 红；
 *  PC5 声明窗守卫摘除（windowTokens<=0 也动作）→ T7 红；
 *  PC6 open 轮位置守卫摘除 → T8 红（open 轮散文被驱逐）；
 *  PC7 驱逐刀改回"按需收刀"（needChars 贪心复辟）→ T10 红（H2 终裁清扫式锁）；
 *  PC8 桩族不以原文替位（桩文进摘要请求）→ T13 红（H1 锁）；
 *  PC9 ctx 闸（闸二）判据摘除或锚点要求（source≠anchored）摘除 → T12 红（H6 锁）；
 *  PC10 H5 输出预算守卫摘除（常数 20480 直通小窗）→ T11 红。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ArgpGraphEngine } from '../src/argp-graph-engine.ts'
import { PROSE_CHECKPOINT_PREFIX, ProseCondenser, planProseEviction, summaryMaxTokensOut, type ProseEventProbe } from '../src/factor/prose-condenser.ts'
import type { Atom } from '../src/argp-types.ts'
import { sessionEvents } from '../src/log-access.ts'

function appendUser(session: Session, text: string, turn?: number): void {
  session.append('user/message', {
    ...createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
    ...(turn === undefined ? {} : { turn }),
  } as never, { surfaceOp: 'append' })
}

/** surface 节点首 text 块（双形状：user/message 直挂 content；assistant/message 包 message.content）。 */
function surfTextsOf(session: Session): string[] {
  const events = sessionEvents(session) as unknown as Array<{ data?: Record<string, unknown> }>
  return [...session.surface.nodes as readonly number[]].map(seq => {
    const data = events[seq]?.data ?? {}
    if (typeof data['content'] === 'string') return data['content'] as string
    const raw = Array.isArray(data['content'])
      ? data['content']
      : Array.isArray((data['message'] as { content?: unknown[] } | undefined)?.content)
        ? (data['message'] as { content: Array<{ type?: string; text?: string }> }).content
        : []
    const blocks = raw as Array<{ type?: string; text?: string }>
    return blocks.map(b => typeof b.text === 'string' ? b.text : '').join('')
  })
}

function appendGroup(session: Session, turn: number, callId: string, tool: string, args: string, resultText: string): void {
  session.append('assistant/message', {
    stream: [], turn, step: 1,
    message: createAssistantMessage({
      source: { provider: 'test', model: 'test' },
      content: [{ type: 'text', text: 'doing ' + tool + ' ' + callId }, { type: 'tool-call', id: callId, name: tool, arguments: args } as never],
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
  session.append('system/message', { content: 'prose persona' } as never, { surfaceOp: 'append' })
  return session
}

interface EngineInternals {
  bindSession(session: Session): void
  charsPerToken: number
  log: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void }
  atomize(session: Session): Atom[]
  stateOf(session: Session): unknown
  compactSourceCommandId: undefined
  telemetryCap: number
  tombstoneMergeMinRun: number
  recencyGuard: number
  turnGuard: number
}

/** 4 个旧轮（U+A(tc)+R 组）+ 焦点轮 5。散文燃料充足（U/A 文本各 100+ 字符）。 */
function buildHistory(session: Session): void {
  // user 带 turn——与生产一致（宿主 user/message 恒带 turn；atomize 按 data.turn 分组）
  for (let t = 1; t <= 4; t += 1) {
    appendUser(session, 'T' + t + '-user：' + '散'.repeat(100), t)
    appendGroup(session, t, 'c' + t, 'bash', '{"command":"npm test"}', 'R' + t + '-TOOL-OUTPUT-' + 'out'.repeat(60))
  }
  appendUser(session, '焦点轮不动：' + '焦'.repeat(100), 5)
  appendGroup(session, 5, 'c5', 'read', '{"file_path":"C:/Proj/z.ts"}', '焦点活体')
}

async function boot(): Promise<{ ctx: Context; internals: EngineInternals }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: 'prose condenser persona' } })
  await ctx.plugin(ArgpGraphEngine, { engine: 'factor', windowTokens: 100, retainTokens: 50, recencyGuard: 0 })
  const internals = ctx.compaction as unknown as EngineInternals
  return { ctx, internals }
}

// ---------------------------------------------------------------------------
// planProseEviction 纯函数（驱逐计划的段语义；condense 侧只以 needChars=∞ 走清扫式，
// 贪心需量形保留为可测语义——PC2 破段停是段语义而非需量语义，两形共用）
// ---------------------------------------------------------------------------

function atom(seq: number, turn: number, type: Atom['type'], text: string, toolCallIds: string[] = []): Atom {
  return { id: seq, seq, type, turn, text, toolCallIds, cites: [], citesFailed: false }
}

const noProbe = new Map<number, ProseEventProbe>()

test('planProseEviction ①：轮级贪心整轮段（散文+工具对+可吞墓碑全走），need 达标即停', () => {
  // surface: [sys(1) U1 A1 R1 U2 A2 R2 U3焦点] —— seq 0 是 system（无原子断段）
  const atoms = [
    atom(1, 1, 'U', 'U1-'.padEnd(60, '文')),
    atom(2, 1, 'A', 'A1-'.padEnd(60, '答'), ['c1']),
    atom(3, 1, 'R', 'R1'),
    atom(4, 2, 'U', 'U2-'.padEnd(60, '文')),
    atom(5, 2, 'A', 'A2-'.padEnd(60, '答'), ['c2']),
    atom(6, 2, 'R', 'R2'),
    atom(7, 3, 'U', '焦点U'),
  ]
  const plan = planProseEviction(atoms, noProbe, [0, 1, 2, 3, 4, 5, 6, 7], {
    needChars: 100, protectFromTurn: 3, openTurnFromPos: null,
  })
  assert.ok(plan.spanSeqs.length > 0, '整轮段必须成段')
  assert.ok(plan.spanSeqs.includes(1) && plan.spanSeqs.includes(3), 'turn1 全员进段')
  assert.ok(plan.stopReason === 'need-met' || plan.stopReason === 'exhausted')
  assert.ok(plan.partialSeqs.length === 0, '无破段 ⇒ 无逐原子指针')
  assert.ok(!plan.spanSeqs.includes(7), '焦点轮不进段')
  // 连续性：span 在 surface 上必须连续（单笔 replace 前提）
  const positions = plan.spanSeqs.map(s => [0, 1, 2, 3, 4, 5, 6, 7].indexOf(s))
  assert.ok(positions.every((p, i) => i === 0 || p === (positions[i - 1] as number) + 1), 'span 必须位置连续: ' + positions.join(','))
})

test('planProseEviction ②：破段轮（附件 barrier）→ 逐原子指针 + 贪心停（不跨洞）', () => {
  const atoms = [
    atom(1, 1, 'U', 'U1-'.padEnd(60, '文')),
    atom(2, 1, 'A', 'A1-'.padEnd(60, '答')),
    atom(3, 2, 'U', '带图轮', []), // barrier（probe.attachment）
    atom(4, 2, 'A', 'A2-'.padEnd(60, '答')),
    atom(5, 3, 'U', 'U3-'.padEnd(60, '文')), // 贪心停在破段轮，turn3 不得进
  ]
  const probes = new Map<number, ProseEventProbe>([[3, { attachment: true }]])
  const plan = planProseEviction(atoms, probes, [1, 2, 3, 4, 5], {
    needChars: 500, protectFromTurn: 99, openTurnFromPos: null,
  })
  assert.deepStrictEqual(plan.spanSeqs, [1, 2], 'turn1 整轮段照常')
  assert.deepStrictEqual(plan.partialSeqs, [4], '破段轮（turn2）只逐原子驱逐其 textA（A2）；附件 U3 除外')
  assert.ok(!plan.spanSeqs.includes(5) && !plan.partialSeqs.includes(5), '贪心停在破段轮，turn3 不动')
})

test('planProseEviction ③：turn=0 墓碑 run 可吞（可并文法 + [散文压缩] 历史节点），不可吞 X 破段', () => {
  const atoms = [
    atom(1, 1, 'U', 'U1-'.padEnd(60, '文')),
    atom(2, 0, 'X', '[elided seq=9; recall_pruned(9) for detail]'),
    atom(3, 2, 'U', 'U2-'.padEnd(60, '文')),
    atom(4, 0, 'X', '官方 checkpoint 文本'),
  ]
  const plan = planProseEviction(atoms, noProbe, [1, 2, 3, 4], {
    needChars: 500, protectFromTurn: 99, openTurnFromPos: null,
  })
  assert.ok(plan.spanSeqs.includes(1) && plan.spanSeqs.includes(2), 'turn1 + 可并墓碑 run 同段（桥接）')
  assert.ok(plan.spanSeqs.includes(3), 'turn2 照常进段')
  assert.deepStrictEqual(plan.partialSeqs, [], '不可吞官方 checkpoint 破段但无 textA ⇒ 无指针')
})

test('planProseEviction ④：open 轮位置守卫（run 起点 ≥ open 首位即停）+ 0 散文段不领头', () => {
  const atoms = [
    atom(1, 1, 'U', 'U1-'.padEnd(60, '文')),
    atom(2, 2, 'A', 'A2-'.padEnd(60, '答'), ['c2']), // 纯工具 run（无 U）——不领头
    atom(3, 3, 'U', 'openU'),
  ]
  const plan = planProseEviction(atoms, noProbe, [1, 2, 3], {
    needChars: 10, protectFromTurn: 99, openTurnFromPos: 2,
  })
  assert.deepStrictEqual(plan.spanSeqs, [1], 'open 首位(pos=2) 之前才可动；pos2 的纯工具 run 被 open 守卫拦住')
  assert.ok(plan.stopReason === 'need-met', 'U1 散文 60 字 ≥ need 10')
})

test('planProseEviction ⑤：因子桩（STUB_PREFIX 族）可吞（§9.36——清扫式必须吞得下已贴桩的轮）', () => {
  const atoms = [
    atom(1, 1, 'U', 'U1-'.padEnd(60, '文')),
    atom(2, 1, 'A', 'A1-'.padEnd(60, '答'), ['c1']),
    atom(3, 1, 'X', '[已剪·因子] bash → command:npm；recall_history(command:npm) 取回原文'),
    atom(4, 2, 'U', 'U2-'.padEnd(60, '文')),
  ]
  const plan = planProseEviction(atoms, noProbe, [1, 2, 3, 4], {
    needChars: Number.POSITIVE_INFINITY, protectFromTurn: 99, openTurnFromPos: null,
  })
  assert.ok(plan.spanSeqs.includes(3), '★桩成员必须可吞（否则剪枝链先手贴桩会腰斩浓缩 span）')
  assert.ok(plan.spanSeqs.includes(4), '桩后的轮照常进段')
  assert.deepStrictEqual(plan.partialSeqs, [])
})

// ---------------------------------------------------------------------------
// condense() 端到端（complete 注入，零网络）
// ---------------------------------------------------------------------------

test('T1 触发门控（闸一）：散文占比 ≤ 50% 声明窗 ⇒ 不动作零调用（PC1 锁）', async () => {
  const { ctx, internals } = await boot()
  const session = makeSession('prose-gate')
  internals.bindSession(session)
  appendUser(session, '短')
  appendGroup(session, 1, 'c1', 'bash', '{"command":"ls"}', 'ok')
  let calls = 0
  const prose = new ProseCondenser(ctx, internals as never, {
    focalTurns: 1,
    complete: async () => { calls += 1; return '摘要' },
  })
  // windowChars = 100000×cpt：占比极低 ⇒ 不触发
  const result = await prose.condense(session, { provider: 't', model: 'm' }, 100_000)
  assert.equal(result, null, '低于触发线必须不动作')
  assert.equal(calls, 0, '触发线下零 LLM 调用')
})

test('T2 端到端：整轮段单浓缩节点 + kind 标记 + <compacted-summary>（PC3 锁）', async () => {
  const { ctx, internals } = await boot()
  const session = makeSession('prose-e2e')
  internals.bindSession(session)
  buildHistory(session)
  const nodesBefore = (session.surface.nodes as readonly number[]).length
  const prose = new ProseCondenser(ctx, internals as never, {
    focalTurns: 1,
    complete: async () => '四轮对话的浓缩检查点正文。',
  })
  const result = await prose.condense(session, { provider: 't', model: 'm' }, 100)
  assert.ok(result !== null, '占比超线必须动作')
  const surfTexts = surfTextsOf(session)
  const cpIdx = surfTexts.findIndex(t => t.startsWith(PROSE_CHECKPOINT_PREFIX))
  assert.ok(cpIdx >= 0, 'surface 必须出现 [散文压缩] 浓缩节点')
  assert.ok(surfTexts[cpIdx]?.includes('<compacted-summary>'), '原生框架标签必须在')
  assert.ok(surfTexts[cpIdx]?.includes('四轮对话的浓缩检查点正文'), 'LLM 摘要正文必须在')
  assert.ok(!surfTexts[cpIdx]?.includes('焦点轮不动'), '焦点轮文本不进检查点（受保护）')
  // 整轮段 = 单节点 replace：驱逐的 turn1-4 全部节点被**一个**检查点顶替（无逐原子墓碑）
  const elidedCount = surfTexts.filter(t => t.startsWith('[elided')).length
  assert.equal(elidedCount, 0, '整轮段不留逐原子墓碑（轮级贪心裁定）')
  const removed = nodesBefore - (session.surface.nodes as readonly number[]).length
  assert.ok(removed >= 10, '驱逐必须真实缩面（removed=' + removed + '）')
})

test('T3 破段轮：不可吞 X 破段 → 轮内 textA 逐原子指针，后续轮不动（PC2 锁）', async () => {
  const { ctx, internals } = await boot()
  const session = makeSession('prose-partial')
  internals.bindSession(session)
  appendUser(session, 'T1-user：' + '散'.repeat(100), 1)
  appendGroup(session, 1, 'c1', 'bash', '{"command":"npm test"}', 'R1-' + 'out'.repeat(60))
  // turn2 破段轮：U(textA) + A(tc)+R + 不可吞 X（developer 公告）——整轮降级部分驱逐：
  // U2 走逐原子指针；A(tc)/R 不可逐原子去（孤儿化）⇒ 原位不动；X 恒不动。
  appendUser(session, 'T2-user：' + '散'.repeat(100), 2)
  appendGroup(session, 2, 'c2', 'bash', '{"command":"ls"}', 'R2-' + 'out'.repeat(60))
  session.append('developer/message', { content: '官方 developer 公告（不可吞 X）', turn: 2 } as never, { surfaceOp: 'append' })
  appendUser(session, 'T3-user：' + '散'.repeat(100), 3)
  appendGroup(session, 3, 'c3', 'bash', '{"command":"ls"}', 'R3-' + 'out'.repeat(60))
  const prose = new ProseCondenser(ctx, internals as never, {
    focalTurns: 1,
    complete: async () => '破段浓缩正文。',
  })
  const result = await prose.condense(session, { provider: 't', model: 'm' }, 50)
  assert.ok(result !== null)
  const surfTexts = surfTextsOf(session)
  const cpCount = surfTexts.filter(t => t.startsWith(PROSE_CHECKPOINT_PREFIX)).length
  assert.equal(cpCount, 1, '整轮段单检查点')
  const pointers = surfTexts.filter(t => t.startsWith('[elided seq='))
  assert.ok(pointers.length >= 1, '破段轮的 textA 逐原子指针必须存在（U2）')
  assert.ok(!surfTexts.some(t => t.includes('T2-user')), 'U2 已被指针顶替（部分驱逐）')
  assert.ok(surfTexts.some(t => t.includes('官方 developer 公告')), '不可吞 X 原位不动')
  assert.ok(surfTexts.some(t => t.includes('T3-user')), '清扫式也停不住破段轮：turn3 散文不动（PC2 锁段语义）')
  assert.ok(surfTexts.some(t => t.includes('doing bash c2')), 'A(args) 不逐原子去（孤儿化风险）')
})

test('T4 输入形状（§9.36 全栈终裁）：摘要请求含 U/A + CALL/RESULT 原文，焦点轮除外（PC4 反转锁）', async () => {
  const { ctx, internals } = await boot()
  const session = makeSession('prose-input')
  internals.bindSession(session)
  buildHistory(session)
  let capturedPrompt = ''
  const prose = new ProseCondenser(ctx, internals as never, {
    focalTurns: 1,
    complete: async (_spec, prompt) => { capturedPrompt = prompt; return '正文' },
  })
  await prose.condense(session, { provider: 't', model: 'm' }, 100)
  assert.ok(capturedPrompt.includes('U: T1-user'), 'user 原文带 U: 标记入面')
  assert.ok(capturedPrompt.includes('A: doing bash'), 'assistant 原文带 A: 标记入面')
  assert.ok(capturedPrompt.includes('CALL bash'), '★tool/call（K 面）必须入摘要请求（不拆 UA，连带 tool 进压缩）')
  assert.ok(capturedPrompt.includes('RESULT R1-TOOL-OUTPUT'), '★tool/result（R 面）原文必须入摘要请求（旧"仅 sys+散文"已废）')
  assert.ok(!capturedPrompt.includes('焦点轮不动'), '焦点轮不进（受保护；H4 最新消息不变量同款）')
  assert.ok(capturedPrompt.includes('## Critical Context'), '指令 v2 段式在尾部')
  assert.ok(capturedPrompt.includes('## Actions and Findings'), '指令 v2 工具叙事段必须在（全栈指令）')
})

test('T10 清扫式刀深（PC7 锁，§9.36 H2 终裁）：span 顶到焦点线一轮全吞，不按"需量"收刀', async () => {
  const { ctx, internals } = await boot()
  const session = makeSession('prose-sweep')
  internals.bindSession(session)
  buildHistory(session)
  let capturedPrompt = ''
  const prose = new ProseCondenser(ctx, internals as never, {
    focalTurns: 1,
    complete: async (_spec, prompt) => { capturedPrompt = prompt; return '正文' },
  })
  // 分离带数学（probe 实锤 .tmp/probe-sweep.ts 口径：cpt=3.5；需量入账只认 textA——
  // 带 tool-call 的 A 是 rPair 不计，每轮入账=U 108；proseAll=814、sys=13）：
  // windowTokens=290 ⇒ 触发线=floor(290×3.5×0.5)=507 ⇒ need=13+814−507=320；
  // 旧贪心累计 108/216/324 ⇒ turn3 顶到 324≥320 收刀 ⇒ turn4 缺席（变异红点）；
  // 清扫式不看需量 ⇒ turn4 必在（span 只受焦点/open/洞界约束）。
  const result = await prose.condense(session, { provider: 't', model: 'm' }, 290)
  assert.ok(result !== null, '闸一过线必须动作')
  assert.ok(capturedPrompt.includes('T4-user'), '★清扫式必须吞到焦点线前一转（needChars 收刀复辟=浅刀回震病根，PC7）')
  assert.ok(!capturedPrompt.includes('焦点轮不动'), '焦点轮仍不动（清扫只到焦点线为止）')
})

test('T13 桩族原文替位（PC8 锁，§9.36 H1）：已贴桩 R 以日志原文入摘要请求，桩文禁入', async () => {
  const { ctx, internals } = await boot()
  const session = makeSession('prose-stub')
  internals.bindSession(session)
  buildHistory(session)
  // 现场贴桩 turn2 的 R：与生产同账目形——compaction/prune（带 shadowedSeqs）→ 紧邻替位事件
  const nodes = [...session.surface.nodes] as unknown as number[]
  const events = sessionEvents(session) as unknown as Array<{ type?: string } | undefined>
  const rSeqs = nodes.filter(s => events[s]?.type === 'tool/result')
  const r2Seq = rSeqs[1]
  assert.ok(r2Seq !== undefined, 'fixture 须含 ≥2 个 tool/result 面')
  session.append('compaction/prune', { shadowedRange: { start: r2Seq as never, end: r2Seq as never }, shadowedSeqs: [r2Seq as never], shadowedTokenCount: 10 } as never)
  // 与生产同形（prune-tx G2）：克隆原 R data，**只**改 inner text（session 强制 tool/result
  // replace may change only content）
  const origData = JSON.parse(JSON.stringify((sessionEvents(session) as unknown as Array<{ data?: unknown }>)[r2Seq]?.data ?? {}))
  origData.message.content[0].content = [{ type: 'text', text: '[已剪·因子] bash → command:npm；recall_history(command:npm) 取回原文' }]
  session.append('tool/result', origData as never, {
    surfaceOp: { op: 'replace', startSeq: r2Seq as never, endSeq: r2Seq as never },
    sourceEventSeqs: [r2Seq as never],
  } as never)
  let capturedPrompt = ''
  const prose = new ProseCondenser(ctx, internals as never, {
    focalTurns: 1,
    complete: async (_spec, prompt) => { capturedPrompt = prompt; return '正文' },
  })
  const result = await prose.condense(session, { provider: 't', model: 'm' }, 100)
  assert.ok(result !== null, '桩可吞 ⇒ span 不被贴桩轮腰斩')
  assert.ok(capturedPrompt.includes('RESULT R2-TOOL-OUTPUT'), '★桩位必须以原文替位入摘要请求（H1：输入面不受桩化影响）')
  assert.ok(!capturedPrompt.includes('[已剪·因子]'), '桩文禁入摘要请求（替位不叠位）')
})

test('T7 声明窗守卫：windowTokens<=0（声明未知）⇒ 不动作不猜（PC5 锁）', async () => {
  const { ctx, internals } = await boot()
  const session = makeSession('prose-window')
  internals.bindSession(session)
  buildHistory(session)
  let calls = 0
  const prose = new ProseCondenser(ctx, internals as never, {
    focalTurns: 1,
    complete: async () => { calls += 1; return 'x' },
  })
  const result = await prose.condense(session, { provider: 't', model: 'm' }, 0)
  assert.equal(result, null, '分母=声明窗：未知不猜')
  assert.equal(calls, 0, '零 LLM 调用')
})

test('T8 open 轮位置守卫：进行中轮的散文不驱逐（PC6 锁）', async () => {
  const { ctx, internals } = await boot()
  const session = makeSession('prose-open')
  internals.bindSession(session)
  buildHistory(session)
  // open turn 6（日志尾 turn/start 未闭合）
  session.append('turn/start', { turn: 6 } as never)
  // open 轮散文体量调大：清扫式默认顶到 open 界 ⇒ 位置守卫（而非需量）是拦住 open 轮的唯一防线
  appendUser(session, 'open 轮进行中：' + '进'.repeat(1500), 6)
  const prose = new ProseCondenser(ctx, internals as never, {
    focalTurns: 0, // 焦点守卫关：open 位置守卫是唯一防线（PC6 变异才咬得住）
    complete: async () => '正文',
  })
  const result = await prose.condense(session, { provider: 't', model: 'm' }, 100)
  assert.ok(result !== null)
  const surfTexts = surfTextsOf(session)
  assert.ok(surfTexts.some(t => t.includes('open 轮进行中')), '★open 轮散文必须原位保留（位置守卫；H4 最新消息不变量）')
})

test('T9 LLM 空输出：保原文零发射', async () => {
  const { ctx, internals } = await boot()
  const session = makeSession('prose-empty')
  internals.bindSession(session)
  buildHistory(session)
  const nodesBefore = (session.surface.nodes as readonly number[]).length
  const prose = new ProseCondenser(ctx, internals as never, {
    focalTurns: 1,
    complete: async () => '   ',
  })
  const result = await prose.condense(session, { provider: 't', model: 'm' }, 100)
  assert.equal(result, null, '空摘要 = 本轮不浓缩（保原文）')
  assert.equal((session.surface.nodes as readonly number[]).length, nodesBefore, 'surface 零改写')
})

// ---------------------------------------------------------------------------
// 引擎侧双闸之二（condenseGate）与输出预算（H5）
// ---------------------------------------------------------------------------

test('T11 输出预算（PC10 锁，§9.36 H5 终裁）：20480 常数帽 + 0.2×声明窗预留收缩', () => {
  assert.equal(summaryMaxTokensOut(262144), 20480, '262K 声明窗=常数帽 20480（回放实测 8192 顶被掐的修正）')
  assert.equal(summaryMaxTokensOut(32768), Math.floor(32768 * 0.2) - 512, '小窗按 0.2×窗−512 预留收缩（摘要自己装得下）')
  assert.ok(summaryMaxTokensOut(32768) < 32768 * 0.2, '预留语义：严格小于 0.2×声明窗')
  assert.equal(summaryMaxTokensOut(0), 20480, '声明未知=纯防御常数（调用点已挡）')
})

test('T12 ctx 闸（PC9 锁，§9.36 闸二 + H6 锚点前提）：anchored ≥ 触发线才驱浓缩', async () => {
  const { internals } = await boot() // 显式 windowTokens=100 ⇒ 触发线=100
  const session = makeSession('prose-gate2')
  internals.bindSession(session)
  buildHistory(session)
  const logs: string[] = []
  ;(internals as unknown as EngineInternals & { log: EngineInternals['log'] }).log = {
    info: m => { logs.push(m) }, warn: m => { logs.push(m) }, error: m => { logs.push(m) },
  }
  const st = internals.stateOf(session) as { lastRealPromptTokens: number; lastRealAnchorSeq: number }
  const gate = internals as unknown as {
    condenseGate(agent: { session: Session; options: Record<string, never> }, signal: AbortSignal, incoming: number): Promise<void>
  }
  const lastSeq = [...session.surface.nodes].pop() as number
  const signal = new AbortController().signal
  // ① 断锚（H6：退 chars/est 估=禁触发破坏性改写，宁缺勿错）
  st.lastRealPromptTokens = 999; st.lastRealAnchorSeq = -1
  await gate.condenseGate({ session, options: {} }, signal, 0)
  assert.ok(!logs.some(l => l.includes('ctx 闸过线')), '断锚数字再大也禁驱（宁缺勿错）')
  // ② 锚好但未过线（90 < 100）
  st.lastRealPromptTokens = 90; st.lastRealAnchorSeq = lastSeq
  await gate.condenseGate({ session, options: {} }, signal, 0)
  assert.ok(!logs.some(l => l.includes('ctx 闸过线')), '未过触发线不驱')
  // ③ 过线 ⇒ 驱浓缩调用（route={} ⇒ spec 不可解析 ⇒ disabled 日志=调用真实到达，零网络）
  st.lastRealPromptTokens = 150
  await gate.condenseGate({ session, options: {} }, signal, 0)
  assert.ok(logs.some(l => l.includes('ctx 闸过线')), '≥ windowRatio×声明窗必须驱')
  assert.ok(logs.some(l => l.includes('LLM 后端不可用')), 'condense 调用真实到达（无路由=disabled 日志，零网络）')
  // ④ 未发射不写 note 的守卫生效路径：condense 返回 null ⇒ 无浓缩节点落面
  assert.ok(!surfTextsOf(session).some(t => t.startsWith(PROSE_CHECKPOINT_PREFIX)), 'disabled 路径零改写')
})

test('T1b 闸一分母=声明窗：40% 声明窗不触发（旧 windowTokens 分母会误开）', async () => {
  const { ctx, internals } = await boot()
  const session = makeSession('prose-gate-denom')
  internals.bindSession(session)
  // 散文合计 ≈1460 字（persona 13 + turn1 1450 + turn2 10）：占声明 1000 的 42%
  // （>40% 旧 windowTokens 分母线，<50% 声明窗新线）。turn2 是焦点轮（不驱逐），
  // turn1 可整轮驱逐——旧分母下门会开且真会发浓缩（mutation 必红）。
  appendUser(session, 'x'.repeat(1450), 1)
  appendUser(session, 'focus task', 2)
  let calls = 0
  const prose = new ProseCondenser(ctx, internals as never, {
    focalTurns: 1,
    complete: async () => { calls += 1; return '摘要' },
  })
  // windowTokens=800（=1000×0.8 触发线），declaredWindow=1000
  const result = await prose.condense(session, { provider: 't', model: 'm' }, 800, undefined, 1000)
  assert.equal(result, null, '43% < 50% 声明窗：不动作')
  assert.equal(calls, 0, '零 LLM 调用')
})

test('planProseEviction ⑥：非原子表面节点是硬洞——span 不得跨洞（否则宿主 replace throw）', () => {
  const atoms = [
    atom(1, 1, 'U', 'U1-'.padEnd(60, '文')),
    atom(2, 1, 'A', 'A1-'.padEnd(60, '答')),
    // seq=3 是 system/message（atomize 不产出）
    atom(4, 2, 'U', 'U2-'.padEnd(60, '文')),
  ]
  const plan = planProseEviction(atoms, noProbe, [1, 2, 3, 4], {
    needChars: Number.POSITIVE_INFINITY, protectFromTurn: 99, openTurnFromPos: null,
  })
  assert.deepStrictEqual(plan.spanSeqs, [1, 2], '洞后 turn2 不得并入同一区间')
  assert.ok(!plan.spanSeqs.includes(4))
})

test('planProseEviction ⑦：factor 指针墓碑（无 recall_pruned）可吞——否则中断轮永久卡住清扫', () => {
  const atoms = [
    atom(1, 1, 'U', 'U1-'.padEnd(60, '文')),
    atom(2, 1, 'X', '[elided seq=9; 原文在 append-only 日志]'),
    atom(3, 1, 'A', 'A1-'.padEnd(60, '答')),
  ]
  const plan = planProseEviction(atoms, noProbe, [1, 2, 3], {
    needChars: Number.POSITIVE_INFINITY, protectFromTurn: 99, openTurnFromPos: null,
  })
  assert.ok(plan.spanSeqs.includes(2), 'factor 墓碑必须可吞')
  assert.ok(plan.spanSeqs.includes(3), '墓碑后的 A 同段')
})
