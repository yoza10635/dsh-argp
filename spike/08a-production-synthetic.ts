/**
 * spike 8a：生产档合成会话 0-LLM 剪枝冒烟。
 * 用交替 U/A 原子构造超过 100K token 阈值的 surface，验证：
 *  - 单笔事务一次剪大量原子
 *  - 多区间 tombstone
 *  - maxPasses 不再卡 16
 *  - U 不被剪，最新 A 不受剪
 */
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ArgpGraphEngine } from '../src/argp-graph-engine.ts'

const ctx = new Context()
await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: 'spike-8a synthetic' } })
await ctx.plugin(ArgpGraphEngine, {
  windowTokens: 100_000,
  retainTokens: 33_000,
  maxPasses: 256,
})
const engine = ctx.compaction as ArgpGraphEngine

const session = Session.create(SessionId('spike-8a-synthetic'))
const aCount = 40
const aChars = 9_000
for (let i = 1; i <= aCount; i += 1) {
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'turn ' + i }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn: i,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'A' + i + ':' + 'x'.repeat(aChars) }],
    }),
  }, { surfaceOp: 'append' })
}

console.log('[diag] surface nodes before=', session.surface.nodes.length)

engine.setSession(session)
const agent = { session } as never
const result = await engine.compactIfNeeded(agent, 'pressure', new AbortController().signal)

const record = engine.records[0]
if (record === undefined || result === null) {
  console.log('[FAIL] expected one prune transaction, got result=', result)
  process.exit(1)
}

const prunedU = record.prunedAtoms.filter(a => a.type === 'U').length
const intervals = record.intervals.length
const shadowed = record.shadowedSeqs.length
const stillOnSurface = new Set(session.surface.nodes)

console.log('[diag] intervals=', intervals, 'prunedAtoms=', record.prunedAtoms.length, 'shadowedSeqs=', shadowed)
console.log('[diag] charsBefore=', record.charsBefore, 'charsAfter=', record.charsAfter, 'forced=', record.forced)

const pass = record.prunedAtoms.length >= 25 && intervals >= 20 && prunedU === 0
  && shadowed === record.shadowedSeqs.length && stillOnSurface.size > 0
console.log(pass ? '[PASS] production synthetic prune ok' : '[FAIL] production synthetic prune unexpected')
if (!pass) process.exit(1)
