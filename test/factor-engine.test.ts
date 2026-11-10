/**
 * src/factor/engine.ts 组合根契约测试（design-2.0 §3.2；真 Session + graph 引擎当宿主）。
 *
 * 契约面：
 *  - 决策序：覆盖证明/新鲜度/体积驱动 pruneOrder（无 LLM）；
 *  - 硬保护：sticky 交集成员、未闭合轮 R、焦点非再生不落剪；
 *  - 发射：prune-tx 成对（shadowedRange=replace 范围逐区间）、桩 content-only、
 *    R 节点离场否——**永不离场**；桩文案禁引退役工具名；
 *  - 重放幂等：重复 decide 不双计、已剪（shadowed）不再入候选；
 *  - 可再生性时序纪律：重放批不采快照（regenerable 恒未知），在线新 R 才采样。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ArgpGraphEngine } from '../src/argp-graph-engine.ts'
import { FactorEngine, type FactorEngineHost } from '../src/factor/engine.ts'
import { sessionEvents } from '../src/log-access.ts'

async function makeFactorEngine(fileSnap?: Map<string, { mtimeMs: number; size: number }>): Promise<{ host: FactorEngineHost; factor: FactorEngine }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: 'factor test persona' } })
  await ctx.plugin(ArgpGraphEngine, { windowTokens: 100, retainTokens: 50, recencyGuard: 0, maxPasses: 8 })
  const engine = ctx.compaction as ArgpGraphEngine
  const host = engine as unknown as FactorEngineHost
  if (fileSnap !== undefined) host.fileSnapshot = (key: string) => fileSnap.get(key) ?? null
  return { host, factor: new FactorEngine(host) }
}

function appendUser(session: Session, text: string): void {
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
}

/** 一条完整协议组：A(内嵌 tool-call 块) × tool/call 日志事件 × tool/result(V3 形态)。 */
function appendGroup(session: Session, turn: number, callId: string, tool: string, args: string, resultText: string, isError = false): void {
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
      content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: resultText }], isError }],
      source: { kind: 'tool', callId },
      id: 'm_' + callId,
    },
  } as never, { surfaceOp: 'append' })
}

const READ_ARGS = '{"file_path":"C:/Proj/a.ts"}'

function makeSession(id: string): Session {
  const session = Session.create(SessionId(id))
  session.append('system/message', { content: 'persona' } as never, { surfaceOp: 'append' })
  return session
}

test('决策序：焦点实体被保护、非焦点旧 read 入剪；发射成对、桩 content-only、R 节点不离场', async () => {
  const { host, factor } = await makeFactorEngine()
  const session = makeSession('factor-order')
  host.bindSession(session)
  appendUser(session, '开始任务')
  // turn1 读 a.ts（旧），turn2 焦点转向 b.ts——a.ts 离开焦点即入排序；
  // 焦点内实体 + 无再生证明 = focalNonRegenerable 硬保护（§2.3 第一层）。
  appendGroup(session, 1, 'c1', 'read', READ_ARGS, 'OLD CONTENT'.repeat(50))
  appendGroup(session, 2, 'c2', 'read', '{"file_path":"C:/Proj/b.ts"}', 'NEW CONTENT'.repeat(50))
  appendUser(session, '收尾')

  const decision = factor.decide(session, 1000)
  assert.equal(decision.plan.pruneOrder.length, 1, '只有非焦点旧 read 可剪')
  const focalR = [...decision.candidates.entries()].find(([, x]) => x.turn === 2)
  assert.ok(focalR !== undefined)
  assert.equal(decision.plan.pruneOrder.includes(focalR[0]), false, '焦点实体非再生 → 硬保护')

  const result = factor.compactIfNeeded(session, 1000)
  assert.ok(result !== null, '压力目标可达必须发射')
  const events = sessionEvents(session) as unknown as Array<{ type: string; data?: Record<string, unknown> }>
  const prunes = events.filter(e => e.type === 'compaction/prune')
  const replaces = events.filter(e => e.type === 'tool/result' && e.data?.['message'] !== undefined
    && JSON.stringify(e.data).includes('已剪·因子'))
  assert.equal(prunes.length, replaces.length, 'shadow-price 逐区间成对：prune 事件数 = 桩 replace 数')
  assert.ok(prunes.length >= 1)
  // 每条桩 shadowedRange 与紧随 replace 单节点等值由 prune-tx 保证——此处验形态：
  // 桩内容 content-only（role 仍是 tool/result 的 user 形态 + toolCallId 保留）
  const stub = replaces[0]?.data?.['message'] as { content?: Array<{ toolCallId?: string; content?: Array<{ text?: string }> }> }
  assert.ok(stub.content?.[0]?.toolCallId !== undefined, '桩必须保留 callId（孤儿 tool result = provider 400）')
  const stubText = stub.content?.[0]?.content?.[0]?.text ?? ''
  assert.ok(stubText.includes('recall_history('), '桩自带触发钩子')
  assert.ok(!stubText.includes('recall_pruned'), '桩文案禁引退役工具名（§1.6）')
  // R 节点永不离场：replace 换 content 不换节点（离场即孤儿 tool result →
  // provider 400）——surface 节点数不缩（桩是 append 新事件，只会更多）
  assert.ok(session.surface.nodes.length >= 4, 'R 节点不离场：surface 节点数不缩')
  assert.ok(factor.ledger.prunedCount >= 1, '被剪账本入账（shadowed diff 投影）')
})

test('重放幂等：重复 decide 不双计；已剪不重复入候选', async () => {
  const { host, factor } = await makeFactorEngine()
  const session = makeSession('factor-replay')
  host.bindSession(session)
  appendUser(session, '任务')
  appendGroup(session, 1, 'c1', 'read', READ_ARGS, 'X'.repeat(500))
  appendGroup(session, 2, 'c2', 'bash', '{"command":"npm run build"}', 'ok')
  factor.compactIfNeeded(session, 100)
  const n1 = factor.ledger.prunedCount
  factor.decide(session, 100)
  factor.decide(session, 100)
  assert.equal(factor.ledger.prunedCount, n1, 'rootSeq 去重：重复观察不双计')
})

test('硬保护：sticky 交集成员不落剪（同文件×错误码复发夹修复宣称）', async () => {
  const { host, factor } = await makeFactorEngine()
  const session = makeSession('factor-sticky')
  host.bindSession(session)
  appendUser(session, '修 CI')
  appendGroup(session, 1, 'f1', 'edit', '{"file_path":"C:/Proj/a.ts"}', 'ERROR ERESOLVE cannot resolve\nexit code 1', true)
  appendGroup(session, 2, 'w1', 'write', '{"file_path":"C:/Proj/a.ts"}', 'written')
  appendGroup(session, 3, 'f2', 'edit', '{"file_path":"C:/Proj/a.ts"}', 'ERROR ERESOLVE cannot resolve\nexit code 1', true)
  appendUser(session, '继续')

  const d = factor.decide(session, 10000)
  const fSeq = [...d.candidates.entries()].find(([, x]) => x.tags.errorcodes.includes('ERESOLVE') && x.turn === 1)
  assert.ok(fSeq !== undefined, '失败 R 在候选集')
  assert.equal(d.plan.pruneOrder.includes(fSeq[0]), false, 'sticky 交集成员绝不入剪枝区间')
  assert.ok(d.stickyActive >= 1)
  const vocab = factor.vocabulary(session)
  assert.ok(vocab.text.includes('ERESOLVE'), 'sticky 标注行进词表')
})

test('resume 重放：新引擎实例从日志重建被剪账本与词表；桩不冒充 R', async () => {
  const { host, factor } = await makeFactorEngine()
  const session = makeSession('factor-resume')
  host.bindSession(session)
  appendUser(session, '开始任务')
  appendGroup(session, 1, 'c1', 'read', READ_ARGS, 'OLD'.repeat(100))
  appendGroup(session, 2, 'c2', 'read', '{"file_path":"C:/Proj/b.ts"}', 'focus elsewhere')
  const r = factor.compactIfNeeded(session, 1000)
  assert.ok(r !== null)
  const n = factor.ledger.prunedCount
  // 模拟 resume：同 session 全新 FactorEngine（§1.5-9 无版本 pin 的续跑断言）
  const { FactorEngine: FE } = await import('../src/factor/engine.ts')
  const resumed = new FE(host)
  const vocab = resumed.vocabulary(session)
  assert.ok(vocab.text.includes('document:c:/proj/a.ts'), '被剪标签经日志重放重建（原 R 已离场 surface）')
  assert.equal(resumed.ledger.prunedCount, n, '重放账本与在线一致')
  const d = resumed.decide(session, 10)
  assert.ok(![...d.candidates.values()].some(x => x.resultText.startsWith('[已剪·因子]')),
    '桩不是新 R：不得入候选/sticky 通道（resolveRootSeqs 折链 + STUB_PREFIX 排除）')
})

test('open 轨不硬保护：单次失败（无宣称无复发）的 R 离开焦点后照常可剪', async () => {
  const { host, factor } = await makeFactorEngine()
  const session = makeSession('factor-open-track')
  host.bindSession(session)
  appendUser(session, '任务')
  appendGroup(session, 1, 'f1', 'edit', '{"file_path":"C:/Proj/a.ts"}', 'npm ERR! ERESOLVE unresolved\ncode 1', true)
  appendGroup(session, 2, 'c2', 'read', '{"file_path":"C:/Proj/b.ts"}', 'focus elsewhere')
  const d = factor.decide(session, 10000)
  const failed = [...d.candidates.entries()].find(([, x]) => x.tags.errorcodes.includes('ERESOLVE'))
  assert.ok(failed !== undefined)
  assert.equal(d.plan.pruneOrder.includes(failed[0]), true,
    'open 轨是观察对象不是硬保护位（误报防线：否则文本信号误报即杀剪枝面）')
})

test('未闭合轮硬保护：turn/start 未闭合时本轮 R 不参剪', async () => {
  const { host, factor } = await makeFactorEngine()
  const session = makeSession('factor-openturn')
  host.bindSession(session)
  appendUser(session, '任务')
  appendGroup(session, 1, 'c1', 'read', READ_ARGS, 'OLD'.repeat(200))
  session.append('turn/start', { turn: 2 })
  // bash 族：command 键不会被 A 文本命中 ⇒ fresh 非焦点，硬保护位只能来自未闭合轮
  appendGroup(session, 2, 'c2', 'bash', '{"command":"cargo test"}', 'error: test failed\ncode 101')

  const d = factor.decide(session, 10000)
  const fresh = [...d.candidates.entries()].find(([, x]) => x.turn === 2)
  assert.ok(fresh !== undefined)
  assert.equal(d.plan.pruneOrder.includes(fresh[0]), false, '未闭合轮的 R 不进剪枝区间')
})

test('可再生性时序纪律：重放批恒未知，在线新增 R 才采样放行', async () => {
  // a.ts 键也在表里：MD6 变异（重放批也采样）会让 c1 拿到"伪事件时快照"而误放行
  const snap = new Map<string, { mtimeMs: number; size: number }>([
    ['c:/proj/a.ts', { mtimeMs: 500, size: 7 }],
    ['c:/proj/b.ts', { mtimeMs: 1000, size: 10 }],
  ])
  const { host, factor } = await makeFactorEngine(snap)
  const session = makeSession('factor-regen')
  host.bindSession(session)
  appendUser(session, '任务')
  appendGroup(session, 1, 'c1', 'read', READ_ARGS, 'REPLAYED'.repeat(100))
  // 首观察 = 重放批：不采快照 → regenerable 恒未知（保守不可再生）
  const d1 = factor.decide(session, 10000)
  assert.ok([...d1.candidates.values()][0] !== undefined)
  assert.equal(d1.plan.pruneOrder.length, 0, '重放批无再生证明 ⇒ 无硬保护例外时仍按排序走；此处 a.ts 非焦点本可剪？——'
    + '实际焦点判据：turn1 即 latest 轮，a.ts 被 A args 回显引用 → 焦点非再生硬保护')
  // 在线新增 read b.ts（焦点内但**有再生证明**）：焦点不护可再生者（§2.3 难点1 答案）
  appendGroup(session, 2, 'c2', 'read', '{"file_path":"C:/Proj/b.ts"}', 'ONLINE'.repeat(100))
  const d2 = factor.decide(session, 10000)
  assert.ok(d2.plan.pruneOrder.length >= 1, '可再生证明使在线 R 入剪')
  const firstSeq = d2.plan.pruneOrder[0]
  assert.equal(d2.candidates.get(firstSeq)?.turn, 2, '可再生（①键）压倒一切：焦点内可再生者先剪，焦点非再生者反而留守')
})

test('降级链：目标不可达只报缺口，不拉硬保护入区、不静默', async () => {
  const { host, factor } = await makeFactorEngine()
  const session = makeSession('factor-shortfall')
  host.bindSession(session)
  appendUser(session, '任务')
  session.append('turn/start', { turn: 1 })
  appendGroup(session, 1, 'c1', 'read', READ_ARGS, 'BIG'.repeat(300)) // 唯一候选在未闭合轮 → 硬保护
  const before = sessionEvents(session).length
  const result = factor.compactIfNeeded(session, 500)
  assert.equal(result, null, '可剪面为零：不发射')
  assert.equal(sessionEvents(session).length, before, '不发射 = 零写入')
})
