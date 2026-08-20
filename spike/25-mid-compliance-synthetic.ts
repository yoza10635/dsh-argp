/**
 * spike 25：A12 中间档合成臂 —— ~50% cites 服从率合成会话 0-LLM 剪枝测试。
 *
 * 目的：现有两臂（DeepSeek 零建边 / Qwen 高服从）未覆盖"部分服从"中间档，
 * A1 分级激活后中间档最易暴露问题（例如 critical 边稀疏时 closure 整体被剪）。
 *
 * 构造：交替 U/A，每隔一轮 A 注入真实 cites（指向更早 U），服从率 ~50%。
 * 验证：
 *   - 图连通性：部分服从下是否形成足够语义边
 *   - 分级边：critical 边是否对闭包守卫生效（A1 不变量 2′）
 *   - L1/L2/L3 断言：近因/轮次/cites 覆盖保护是否完整
 *   - recall：被剪节点可召回
 */
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ArgpGraphEngine, eventText } from '../src/argp-graph-engine.ts'
import { recallFromLog } from '../src/log-access.ts'
import type { Session as SessionT } from '@deepseek-ai/dsh-session'

const ctx = new Context()
await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: 'spike-25 mid-compliance' } })
await ctx.plugin(ArgpGraphEngine, {
  windowTokens: 100_000,
  retainTokens: 33_000,
  maxPasses: 64,
})
const engine = ctx.compaction as ArgpGraphEngine

const session = Session.create(SessionId('spike-25-mid'))
const aCount = 50
const aChars = 9_000
const citedUsers: number[] = [] // 记录被引用过的 U 的 seq

for (let i = 1; i <= aCount; i += 1) {
  const uSeq = session.events.length
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'User turn ' + i + ' with some context text here.' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })

  // 偶数轮（i % 2 === 0）注入 cites，指向本轮 U（即时引用）；奇数轮不注入 → ~50% 服从率。
  // 问题 6 修订：一半 cites 用 critical（l:"c"），一半用 supporting（l:"s"）——
  // 覆盖 A1 不变量 2′ 的分级路径（critical 边参与闭包守卫，supporting 不参与）。
  const shouldCite = i % 2 === 0
  const citeLevel = i % 4 === 0 ? 'c' : 's'
  const citeBlock = shouldCite
    ? '\n{"cites":[{"t":"User turn ' + i + '","l":"' + citeLevel + '"}]}'
    : ''

  session.append('assistant/message', {
    turn: i,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'A' + i + ':' + 'x'.repeat(aChars) + citeBlock }],
    }),
  }, { surfaceOp: 'append' })

  if (shouldCite) citedUsers.push(uSeq)
}

console.log('[diag] surface nodes=', session.surface.nodes.length)
console.log('[diag] citedUsers count=', citedUsers.length, 'expected ~', Math.floor(aCount / 2))

engine.setSession(session)
const agent = { session } as never
const result = await engine.compactIfNeeded(agent, 'pressure', new AbortController().signal)

const record = engine.records[0]
if (record === undefined || result === null) {
  console.log('[FAIL] expected one prune transaction, got result=', result)
  process.exit(1)
}

// L1：近因保护 —— recencyCut = surfaceSeqs.length - recencyGuard（最后 4 个 surface 节点位置受保护）
const surfaceSeqs = session.surface.nodes.map(n => n.seq)
const recencyCut = Math.max(0, surfaceSeqs.length - engine.recencyGuard)
const prunedRecent = record.prunedAtoms.filter(a => {
  const pos = surfaceSeqs.indexOf(a.seq)
  return pos !== -1 && pos >= recencyCut
}).length
console.log('[diag] prunedRecent (surface-position, should be 0)=', prunedRecent)

// L2：轮次保护 —— turnGuard 默认 1（>= latestTurn 的 A 不剪）
const latestTurn = aCount
const prunedLatestTurn = record.prunedAtoms.filter(a => {
  const event = session.events[a.seq]
  const turn = (event?.data as { turn?: number })?.turn ?? 0
  return turn >= latestTurn
}).length
console.log('[diag] prunedLatestTurn (should be 0)=', prunedLatestTurn)

// L3：cites 覆盖 —— 被 A 引用的 U 不被剪
const prunedCitedU = record.prunedAtoms.filter(a => citedUsers.includes(a.seq)).length
console.log('[diag] prunedCitedU (should be 0)=', prunedCitedU)

// 图连通性：部分服从下的语义边数
const edges = engine.lastEdges.length
console.log('[diag] semanticEdges=', edges, 'expected ~', Math.floor(aCount / 2))

// recall 可用性：用与 recall_pruned 工具相同的数据路径原语验证（recallFromLog + state 标签）
const firstShadowed = record.shadowedSeqs[0] ?? -1
if (firstShadowed >= 0) {
  const shadowed = (engine as unknown as { shadowedSeqsOf(s: Session): Set<number> }).shadowedSeqsOf(session)
  const outcome = recallFromLog(session, firstShadowed, s => shadowed.has(s), eventText)
  console.log('[diag] recall firstShadowed seq=', firstShadowed, 'state=', outcome.state, 'ok=', outcome.ok)
  if (!outcome.ok) {
    console.log('[FAIL] recall of shadowed node failed')
    process.exit(1)
  }
}

// 问题 6 修订：三处关键断言（prunedRecent/prunedLatestTurn/prunedCitedU）纳入 pass 条件，
// 不再只 console.log 不校验；另验证 critical 与 supporting 边都实际生成（分级路径生效）。
const criticalEdges = engine.lastEdges.filter(e => e.level === 'critical').length
const supportingEdges = engine.lastEdges.filter(e => e.level === 'supporting').length
console.log('[diag] criticalEdges=', criticalEdges, 'supportingEdges=', supportingEdges)

const pass = prunedRecent === 0 && prunedLatestTurn === 0 && prunedCitedU === 0
  && edges >= Math.floor(aCount / 2) - 5 // 允许少量歧义消解失败
  && criticalEdges >= 5 // ~25 条 cites 边中 critical 应 >0（i%4===0 每 4 轮一条）
  && supportingEdges >= 5
  && record.prunedAtoms.length > 0
console.log(pass ? '[PASS] mid-compliance synthetic prune ok' : '[FAIL] mid-compliance synthetic prune unexpected')
if (!pass) process.exit(1)
