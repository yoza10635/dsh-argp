/**
 * 1.5.1 回归：A 原子排序键计入其应答 R 的体积（drag 集合）。
 *
 * 病灶（旧 sortKey）：A 的 token 键只算自身文本。剪 A 必无条件连带剪其 R（防孤儿
 * tool 400），但排序看不见 R 的体积 ⇒ 两个同级别 A，一个带 90K 大 R、一个带 1K 小 R，
 * 若 A 自身文本相近，"能带走大 R 的"不一定先被剪；贪心在中间达标时大 R 死重滞留。
 *
 * 修复：sortKey 对带 tool-call 的 A 用「自身文本 + 应答 R 之和」作 token 键
 * （PruneState.aGroupChars，静态快照）。
 *
 * 本 fixture 让「A 自身文本大小」与「有效体积大小」关系相反：
 *   a1 自身 61 字符但带 611 字符大 R（有效 672）
 *   a2 自身 81 字符但带 33 字符小 R（有效 114）
 * 旧键（自身文本）⇒ a2 先剪（81>61）⇒ 两轮把两组全剪（断言"a2 保留"失败）；
 * 新键（有效体积）⇒ a1 先剪（672>114）⇒ 一轮达标（221≤301），a2+r2 保留。
 *
 * ⚠ 必须 turnGuard=0（与 recencyGuard=0 一致）：user 消息不带 turn 字段 ⇒
 * latestTurn=2（a2 的 turn），默认 turnGuard=1 会把 a2（最新 A turn）整轮保护 ⇒
 * a2 永不可候选 ⇒ 排序无从比较、本测试失去判别力。关守卫后两个 A 均可候选，
 * 排序（drag 权重）成为唯一决定因素。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { asSeq } from '../src/log-access.ts'
import { ArgpGraphEngine } from '../src/argp-graph-engine.ts'

async function makeEngine(config: Record<string, unknown> = {}): Promise<{ ctx: Context; engine: ArgpGraphEngine }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: 'argp drag-weight sort test' } })
  // retainTokens=86 ⇒ retainChars = 86 × 3.5 = 301，落在 (剪 a1+r1 后 221, 剪 a2+r2 后 781) 区间
  // turnGuard=0 + recencyGuard=0：关掉新鲜度守卫，让两个 A 均可候选，隔离"排序"这一变量
  await ctx.plugin(ArgpGraphEngine, { windowTokens: 100, retainTokens: 86, minSpanChars: 20, recencyGuard: 0, turnGuard: 0, maxPasses: 16, ...config })
  return { ctx, engine: ctx.compaction as ArgpGraphEngine }
}

function appendUser(session: Session, turn: number, text: string): void {
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
}

/** 混合 assistant：tool-call 块在前、text 块（尾部带 cites JSON）在后——
 *  cites 必须落在 eventText 末尾（CITES_TAIL_BARE 锚 $），故 text 块在后。 */
function appendCitingToolAssistant(session: Session, turn: number, callId: string, argumentsStr: string, text: string): number {
  session.append('assistant/message', {
    stream: [],
    turn,
    step: 1,
    message: createAssistantMessage({
      source: { provider: 'test', model: 'test' },
      content: [
        { type: 'tool-call', id: callId as never, name: 'read_file', arguments: argumentsStr },
        { type: 'text', text },
      ],
    }),
  }, { surfaceOp: 'append' })
  return session.snapshotEvents().length - 1
}

function appendToolResult(session: Session, turn: number, callId: string, text: string): number {
  session.append('tool/result', {
    turn,
    step: 1,
    message: createToolResultMessage({ callId: callId as never, content: [{ type: 'text', text }], isError: false }),
  }, { surfaceOp: 'append' })
  return session.snapshotEvents().length - 1
}

/** wire 配对不变式：surface 上每个存活 tool-call 都有应答（含占位），无孤儿。 */
function assertNoOrphan(session: Session): void {
  const callIds = new Set<string>()
  const resultIds = new Set<string>()
  for (const seq of session.surface.nodes) {
    const ev = session.snapshotEvents()[seq] as { type: string; data?: { message?: { content?: { type: string; id?: string; toolCallId?: string }[]; source?: { callId?: string } } } }
    const blocks = ev.data?.message?.content ?? []
    for (const b of blocks) {
      if (b.type === 'tool-call' && b.id !== undefined) callIds.add(b.id)
      if (b.type === 'tool-result' && b.toolCallId !== undefined) resultIds.add(b.toolCallId)
    }
    if (ev.data?.message?.source?.callId !== undefined) resultIds.add(ev.data.message.source.callId)
  }
  for (const id of callIds) assert.ok(resultIds.has(id), 'unanswered tool-call on surface (orphan): ' + id)
}

test('drag-weight: 大 R 的 A 先剪（有效体积排序），小 R 组保留', async () => {
  const { ctx, engine } = await makeEngine({ enableOverlapChain: false })
  try {
    const session = Session.create(SessionId('drag-weight-sort'))

    // turn 1：a1 自身文本小（~63 字符）+ 大 R（611 字符）
    appendUser(session, 1, 'context filler one ' + 'a'.repeat(28))
    const a1 = appendCitingToolAssistant(session, 1, 'call_1', '{"path":"f1"}', 'A1: ' + 'x'.repeat(20) + '\n{"cites":["MARKER-BIG"]}')
    const r1 = appendToolResult(session, 1, 'call_1', 'MARKER-BIG ' + 'd'.repeat(600))

    // turn 2：a2 自身文本大（~83 字符）+ 小 R（31 字符）
    appendUser(session, 2, 'context filler two ' + 'b'.repeat(28))
    const a2 = appendCitingToolAssistant(session, 2, 'call_2', '{"path":"f2"}', 'A2: ' + 'y'.repeat(40) + '\n{"cites":["MARKER-SMALL"]}')
    const r2 = appendToolResult(session, 2, 'call_2', 'MARKER-SMALL ' + 'e'.repeat(20))

    // 尾部 user 消息（user 消息不带 turn 字段；ask-exempt 不可剪，仅占 visible）
    appendUser(session, 3, 'latest anchor')

    engine.setSession(session)
    const result = await engine.compactIfNeeded({ session } as never, 'pressure', new AbortController().signal)
    assert.ok(result !== null, 'compaction must trigger')

    const surface = new Set(session.surface.nodes)
    // 新键：a1 有效体积 674 > a2 的 114 ⇒ a1+r1 先剪，一轮即达标（221 ≤ 301）
    assert.equal(surface.has(asSeq(a1)), false, 'a1（带大 R）应先被剪')
    assert.equal(surface.has(asSeq(r1)), false, 'r1 随 a1 连带剪')
    // 旧键在此失败：a2 自身 83 > a1 自身 63 ⇒ a2 先剪 ⇒ 两轮把两组全剪
    assert.ok(surface.has(asSeq(a2)), 'a2（带小 R）应保留——目标在剪 a1+r1 后已达标')
    assert.ok(surface.has(asSeq(r2)), 'r2 随 a2 保留')

    // 核心不变式：无孤儿（a2 的 tool-call 由 r2 应答；a1+r1 整组移除不产生孤儿）
    assertNoOrphan(session)
  } finally {
    await ctx.fiber.dispose()
  }
})
