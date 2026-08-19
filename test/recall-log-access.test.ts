/**
 * P1 修复 (b) 回归测试：recall 原语从「查 pruned 索引」升级为「按 seq 查 append-only 日志」。
 *
 * 断言矩阵：
 *  1) recall_pruned 对 shadowed seq：原文 + [recall seq=N state=shadowed] 前缀
 *  2) recall_pruned 对 live seq（从未被 ARGP 替换）：原文 + state=live —— 这是旧实现
 *     报 "not a pruned node" 的死角，也是「适配器窗口丢弃节点」盲区的最小可测形态
 *  3) recall_pruned 对越界 seq：out of range（旧语义「非剪节点即拒绝」已翻转）
 *  4) recall_pruned 对 off-surface seq（turn/start 等无正文事件）：no model-visible text
 *  5) list_pruned 默认模式只列 shadowed；区间模式（fromSeq/toSeq）扫描全日志并带 state 标签
 *  6) 程序化接口 recallAnyState / nodeState
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { CallId, createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ArgpGraphEngine } from '../src/argp-graph-engine.ts'

async function makeEngine(config: Record<string, unknown> = {}): Promise<{ ctx: Context; engine: ArgpGraphEngine }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: 'argp recall-log-access test' } })
  await ctx.plugin(ArgpGraphEngine, { windowTokens: 100, retainTokens: 50, minSpanChars: 20, recencyGuard: 0, maxPasses: 16, ...config })
  return { ctx, engine: ctx.compaction as ArgpGraphEngine }
}

/**
 * 会话布局（seq = events 数组索引）：
 *   0 turn/start(turn1)             —— off-surface，无正文
 *   1 user/message U1               —— live
 *   2 assistant/message A1 (cites)  —— live → 被 replace 遮蔽 → shadowed
 *   3 user/message plugin tombstone —— replace [2..2] sourceEventSeqs=[2]
 *   4 turn/start(turn2)             —— off-surface，无正文
 *   5 user/message U2               —— live
 */
function buildSession(): Session {
  const session = Session.create(SessionId('recall-log-access'))
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'who ate the cookie?' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: createAssistantMessage({ source: { provider: 'test', model: 'test' }, content: [{ type: 'text', text: 'COOKIE-FACT: it was the dog.' }] }),
  }, { surfaceOp: 'append' })
  const a1 = session.events.length - 1 // seq 2：assistant/message A1
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: '[elided seq=2: pruned by ARGP; recall_pruned(seq) to retrieve]' }],
    source: { kind: 'plugin', plugin: 'argp-test' },
  }), { surfaceOp: { op: 'replace', start: a1, end: a1 }, sourceEventSeqs: [a1] })
  session.append('turn/start', { turn: 2 })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'and the milk?' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  return session
}

async function runTool(ctx: Context, name: string, args: Record<string, unknown>): Promise<string> {
  const res = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: CallId('recall-log-' + name + '-' + Math.random().toString(36).slice(2)),
    name,
    arguments: args,
  })
  const text = res.content[0]?.type === 'text' ? res.content[0].text : ''
  return text
}

test('recall_pruned: shadowed 节点返回原文 + state=shadowed 标签', async () => {
  const { ctx, engine } = await makeEngine()
  try {
    const session = buildSession()
    engine.setSession(session)
    const text = await runTool(ctx, 'recall_pruned', { seq: 2 })
    assert.ok(text.includes('state=shadowed'), 'must carry state=shadowed label, got: ' + text.slice(0, 80))
    assert.ok(text.includes('COOKIE-FACT'), 'must return the original text')
    assert.ok(text.includes('[recall seq=2 '), 'must carry the recall header')
  } finally {
    await ctx.fiber.dispose()
  }
})

test('recall_pruned: live 节点（旧盲区）返回原文 + state=live 标签', async () => {
  const { ctx, engine } = await makeEngine()
  try {
    const session = buildSession()
    engine.setSession(session)
    const text = await runTool(ctx, 'recall_pruned', { seq: 1 })
    assert.ok(text.includes('state=live'), 'live node must carry state=live, got: ' + text.slice(0, 80))
    assert.ok(text.includes('who ate the cookie'), 'must return the live node text')
    const u2 = await runTool(ctx, 'recall_pruned', { seq: 5 })
    assert.ok(u2.includes('state=live') && u2.includes('and the milk'), 'second live node recallable')
  } finally {
    await ctx.fiber.dispose()
  }
})

test('recall_pruned: 越界 seq 报 out of range（旧 "not a pruned node" 语义已翻转）', async () => {
  const { ctx, engine } = await makeEngine()
  try {
    const session = buildSession()
    engine.setSession(session)
    const text = await runTool(ctx, 'recall_pruned', { seq: 99 })
    assert.ok(text.includes('out of range'), 'must report out-of-range, got: ' + text)
    assert.ok(!text.includes('not a pruned node'), 'old gate message must be gone')
  } finally {
    await ctx.fiber.dispose()
  }
})

test('recall_pruned: off-surface 事件（无正文）提示 no model-visible text', async () => {
  const { ctx, engine } = await makeEngine()
  try {
    const session = buildSession()
    engine.setSession(session)
    const text = await runTool(ctx, 'recall_pruned', { seq: 0 })
    assert.ok(text.includes('no model-visible text'), 'turn/start is log-only, got: ' + text)
  } finally {
    await ctx.fiber.dispose()
  }
})

test('list_pruned: 默认模式只列 shadowed，区间模式列出 live 节点（带 state 标签）', async () => {
  const { ctx, engine } = await makeEngine()
  try {
    const session = buildSession()
    engine.setSession(session)
    // 默认模式：只有被 ARGP 遮蔽的 seq 2
    const prunedOnly = await runTool(ctx, 'list_pruned', {})
    assert.ok(prunedOnly.includes('seq=2'), 'default mode must list the shadowed node, got: ' + prunedOnly.slice(0, 120))
    assert.ok(prunedOnly.includes('state=shadowed'), 'default rows carry state=shadowed')
    assert.ok(!prunedOnly.includes('seq=1 ') && !prunedOnly.includes('seq=5 '), 'default mode must NOT list live nodes')
    // 区间模式：全日志扫描，live 节点（seq 1/5）出现且带 state=live
    const ranged = await runTool(ctx, 'list_pruned', { fromSeq: 0, toSeq: 5 })
    assert.ok(ranged.includes('seq=1 '), 'range mode must reveal live seq 1')
    assert.ok(ranged.includes('seq=5 '), 'range mode must reveal live seq 5')
    assert.ok(ranged.includes('state=live'), 'range rows carry state=live for live nodes')
    assert.ok(ranged.includes('seq=2 '), 'range mode also lists shadowed seq 2')
    assert.ok(ranged.includes('state=shadowed'), 'range rows carry state=shadowed for pruned nodes')
    // 无正文的 turn/start（seq 0/4）被过滤
    assert.ok(!ranged.includes('seq=0 '), 'no-text events filtered out of range mode')
  } finally {
    await ctx.fiber.dispose()
  }
})

test('程序化接口: recallAnyState 全日志取回 + nodeState 三态判定', async () => {
  const { ctx, engine } = await makeEngine()
  try {
    const session = buildSession()
    engine.setSession(session)
    const live = engine.recallAnyState(1)
    assert.ok(live !== null && live.state === 'live' && live.text.includes('who ate the cookie'), 'recallAnyState(live)')
    const shadowed = engine.recallAnyState(2)
    assert.ok(shadowed !== null && shadowed.state === 'shadowed' && shadowed.text.includes('COOKIE-FACT'), 'recallAnyState(shadowed)')
    const offSurface = engine.recallAnyState(0)
    assert.ok(offSurface === null, 'no-text event yields null from recallAnyState')
    assert.ok(engine.recallAnyState(99) === null, 'out-of-range yields null')
    // nodeState 三态
    assert.equal(engine.nodeState(2), 'shadowed')
    assert.equal(engine.nodeState(1), 'live')
    assert.equal(engine.nodeState(0), 'off-surface')
    assert.equal(engine.nodeState(99), 'off-surface', 'out-of-range falls through to off-surface')
  } finally {
    await ctx.fiber.dispose()
  }
})
