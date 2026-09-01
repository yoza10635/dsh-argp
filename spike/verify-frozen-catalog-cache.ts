/**
 * 验证冻结 catalog 的 KV 前缀缓存契约（2026-09-01）：
 * 逐轮（每轮 = 追加 U/A + 模拟 agent/pre-step 的 compactIfNeeded('pressure')）渲染完整 system 块，
 * 记录其 sha，断言 system 块仅在「真正落剪」的那一轮变化，其余轮逐字节稳定。
 *
 * 为什么这等于前缀缓存证明：provider 的自动前缀缓存以 system message 字节为键；只要字节稳定，
 * 缓存即命中。本 spike 不调用真实模型，只在 ARGP 引擎 + 宿主 systemPrompt.assemble() 层渲染，
 * 复刻宿主把各 section 拼成单条 system message 的行为（renderPrompt 以空行连接非空 section）。
 *
 * 运行：node --import ./scripts/ts-import-rewrite-loader.mjs spike/verify-frozen-catalog-cache.ts
 */
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import crypto from 'node:crypto'
import { ArgpGraphEngine } from '../src/argp-graph-engine.ts'

const ctx = new Context()
await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: 'verify frozen-catalog cache' } })
await ctx.plugin(ArgpGraphEngine, {
  windowTokens: 1000,
  retainTokens: 500,
  maxPasses: 64,
})
const engine = ctx.compaction as ArgpGraphEngine

const session = Session.create(SessionId('verify-frozen-catalog'))
engine.setSession(session)

const sp = ctx.systemPrompt as unknown as { assemble(): Promise<{ sections: { text?: string }[] }> }
async function renderSystemBlock(): Promise<string> {
  const a = await sp.assemble()
  return a.sections.map(s => s.text ?? '').join('\n\n')
}
function sha(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 12)
}

const TURNS = 12
let prevSha = ''
let prevRecords = 0
let changes = 0
let pruneSteps = 0
console.log('turn | pruned? | sysLen | sysSha      | blockChanged?')
console.log('-----+---------+--------+-------------+-------------')
for (let turn = 1; turn <= TURNS; turn += 1) {
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'turn ' + turn + ' question about the project status and next steps' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn,
    step: 1,
    message: createMessage({ role: 'assistant', content: [{ type: 'text', text: 'A' + turn + ':' + 'x'.repeat(400) }] }),
  }, { surfaceOp: 'append' })

  // 模拟 agent/pre-step：每步 compactIfNeeded('pressure')
  const result = await engine.compactIfNeeded({ session } as never, 'pressure', new AbortController().signal)
  const prunedThisTurn = result !== null && engine.records.length > prevRecords
  if (prunedThisTurn) pruneSteps += 1
  prevRecords = engine.records.length

  const block = await renderSystemBlock()
  const curSha = sha(block)
  const changed = prevSha !== '' && curSha !== prevSha // 首轮 prevSha='' 是基线，不算 spurious 变化
  if (changed) changes += 1
  prevSha = curSha
  console.log(
    `${String(turn).padStart(4)} | ${prunedThisTurn ? '  YES  ' : '  no   '} | ${String(block.length).padStart(6)} | ${curSha} | ${changed ? 'CHANGED' : 'stable '}`,
  )
}

// 断言：system 块变化的轮数 == 真正落剪的轮数（即只在剪枝时变，其余稳定）
const ok = changes === pruneSteps
console.log('-----+---------+--------+-------------+-------------')
console.log(`prune steps=${pruneSteps}  block changes=${changes}`)
console.log(ok
  ? '[PASS] system block changes ONLY on prune steps (byte-stable across non-prune turns → prefix cache survives)'
  : '[FAIL] system block changed on a turn with no prune (spurious cache invalidation)')
if (!ok) process.exit(1)
