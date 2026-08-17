/**
 * spike 19：排序模式真实验证（legacy vs density，同一场景 1-2 轮提问对比）
 *
 * 设计（用户提议，替代全量 50 轮）：剪枝本身 0 LLM，只有后续提问花钱。
 * 铺上下文用 session.append 直接注入事件（0 LLM 成本、完全可控），
 * 压缩后各自接 1-2 轮真实 LLM 提问，回答质量差异直接可见。
 *
 * 场景（纯 A 原子，同档同 eff=5，大小悬殊）：
 *  - turn 1-4：4 个小 fact A 原子（'FACT Ki = VAL-xxx'，18 chars ≈ 5 tok）
 *  - turn 5-8：4 个大 echo A 原子（noise 全文，3583 chars ≈ 1024 tok）
 *  - 均为 isolated、eff=5、无 cites：legacy 按 seq 先剪 turn 1-4 的小 fact；
 *    density 同档内大 token 先剪 → 先剪 turn 5-8 的大 echo，fact 存活。
 *  - 剪到 retain 后提问 K1/K2：density 的 surface 里 fact 还在 → 直读即答；
 *    legacy 的 fact 被剪 → 答错或需 recall。
 *
 * 经验（首跑发现）：带工具结果的场景测不出密度——A+R 绑定组里 R 的 eff=0
 * 天然拉低组 key，两种模式都会先剪含 R 的组；密度差异只在同档纯 A 原子间显现。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { DEEPSEEK_MODEL, DEEPSEEK_PROVIDER, DEEPSEEK_REASONING_EFFORT, mountDeepSeekFlash } from './deepseek.ts'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ArgpGraphEngine } from '../src/argp-graph-engine.ts'

const sortMode = (process.env['ARGP_SORT_MODE'] ?? 'legacy') as 'legacy' | 'density' | 'density-chain'

let ctx: Context
function waitForIdle(subject: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: a, status }) => {
      if (a === subject && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

/** 驱动一轮：followup 后等 idle。 */
async function drive(agent: Agent, text: string): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await waitForIdle(agent)
}

/** 从 session events 提取最后一个 assistant 的纯文本（向前找最后一条 assistant/message 的 text 块）。 */
function lastAssistantText(session: { events: unknown[] }): string {
  for (let i = session.events.length - 1; i >= 0; i -= 1) {
    const e = session.events[i] as { type?: string; data?: { message?: { content?: { type: string; text?: string }[] } } }
    if (e?.type === 'assistant/message') {
      const parts = e.data?.message?.content?.filter(b => b.type === 'text' && b.text !== undefined).map(b => b.text as string) ?? []
      if (parts.length > 0) return parts.join(' ')
    }
  }
  return '(no assistant text found)'
}

function appendUser(session: Session, text: string): void {
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
}

function appendAssistant(session: Session, text: string, turn: number): void {
  session.append('assistant/message', {
    turn,
    step: 1,
    message: createAssistantMessage({ source: { provider: 'test', model: 'test' }, content: [{ type: 'text', text }] }),
  }, { surfaceOp: 'append' })
}

// ---------- 场景构造 ----------
const factValue = (k: number): string => 'VAL-' + ((k * 48271) % 1679616).toString(36).toUpperCase().padStart(4, '0')

// 噪声：3583 chars ≈ 1024 tokens（大 A 原子体积来源）
function makeNoise(i: number): string {
  const lines: string[] = ['noise chunk ' + i + ' — marker NK-' + i + '-MARKER-' + ((i * 48271) % 1679616).toString(36).toUpperCase().padStart(4, '0')]
  for (let n = 0; n < 40; n += 1) {
    lines.push('2026-07-1' + (i % 10) + '-' + String((n % 28) + 1).padStart(2, '0')
      + 'T' + String(n % 24).padStart(2, '0') + ':00:00Z level=INFO svc=ingest-' + ((n % 5) + 1)
      + ' latency=' + (40 + ((n * i) % 90)) + 'ms msg="heartbeat ok shard=' + ((n + i) % 16) + '"')
  }
  return lines.join('\n')
}

async function run(): Promise<void> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const outDir = path.join(import.meta.dirname, 'out', '19-sort-' + sortMode + '-' + stamp)
  fs.mkdirSync(outDir, { recursive: true })

  ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: 'spike-19 sort-mode probe' } })
  await ctx.plugin(AgentLoop, { agents: [] })
  await mountDeepSeekFlash(ctx)
  await ctx.plugin(ArgpGraphEngine, {
    windowTokens: 3_500,    // 触发：估算上下文 ≥ 3.5K
    retainTokens: 1_200,    // 压缩到 ≤ 1.2K（必须剪掉大部分 → 两种排序差异显现）
    maxPasses: 64,
    recencyGuard: 1,
    minSpanChars: 200,
    sortMode,
  })
  const engine = ctx.compaction as ArgpGraphEngine
  const agent = ctx.agentLoop.create(SessionId('spike-19-sort-' + sortMode), {
    provider: DEEPSEEK_PROVIDER,
    model: DEEPSEEK_MODEL,
    reasoningEffort: DEEPSEEK_REASONING_EFFORT,
  })
  engine.setSession(agent.session)
  const session = agent.session

  // ---------- 铺上下文（0 LLM）：anchor + 4 小 fact + 4 大 echo ----------
  appendUser(session, 'Anchor: continue a long conversation. Facts are stated below.')
  const factSeqs: number[] = []
  const echoSeqs: number[] = []
  for (let i = 0; i < 4; i += 1) {
    const text = 'FACT K' + i + ' = ' + factValue(i)
    appendAssistant(session, text, i + 1)
    factSeqs.push(session.events.length - 1)
  }
  for (let i = 4; i < 8; i += 1) {
    appendAssistant(session, makeNoise(i), i + 1)
    echoSeqs.push(session.events.length - 1)
  }
  // 最新 1 轮（recencyGuard=1 保护）
  appendAssistant(session, 'Latest: ' + 'z'.repeat(30), 9)
  const latestSeq = session.events.length - 1
  console.log(`[${sortMode}] factSeqs=${JSON.stringify(factSeqs)} echoSeqs=${JSON.stringify(echoSeqs)} latest=${latestSeq}`)

  // ---------- 触发压缩 ----------
  const before = engine.records.length
  const result = await engine.compactIfNeeded({ session } as never, 'pressure', new AbortController().signal)
  const after = engine.records.length
  const record = engine.records[after - 1]
  const prunedSeqs = record !== undefined && after > before ? record.prunedAtoms.map(a => a.seq).sort((x, y) => x - y) : []
  const prunedFacts = factSeqs.filter(s => prunedSeqs.includes(s))
  const prunedEchos = echoSeqs.filter(s => prunedSeqs.includes(s))
  console.log(`[${sortMode}] compact=${result === null ? 'null' : 'ok'} forced=${record?.forced ?? 'n/a'} pruned=${prunedSeqs.length} (facts剪=${prunedFacts.length} echos剪=${prunedEchos.length})`)
  console.log(`[${sortMode}] prunedSeqs=${JSON.stringify(prunedSeqs)}`)

  // ---------- 提问 1：surface 直读 ----------
  await drive(agent, 'What is the value of FACT K1 mentioned earlier? Answer with just the value.')
  const a1text = lastAssistantText(agent.session)
  const correct1 = a1text.includes(factValue(1))
  console.log(`[${sortMode}] Q1(K1=${factValue(1)}) correct=${correct1}`)
  console.log(`[${sortMode}] Q1 answer: ${a1text.slice(0, 240).replace(/\n/g, ' ')}`)

  // ---------- 提问 2：更早的 fact ----------
  await drive(agent, 'What is the value of FACT K2 mentioned earlier? Answer with just the value.')
  const a2text = lastAssistantText(agent.session)
  const correct2 = a2text.includes(factValue(2))
  console.log(`[${sortMode}] Q2(K2=${factValue(2)}) correct=${correct2}`)
  console.log(`[${sortMode}] Q2 answer: ${a2text.slice(0, 240).replace(/\n/g, ' ')}`)

  const recallHits = engine.recallCalls.filter(c => c.hit).length
  const recallTotal = engine.recallCalls.length
  console.log(`[${sortMode}] recall=${recallTotal} calls (${recallHits} hits) | summary: Q1=${correct1 ? 'PASS' : 'FAIL'} Q2=${correct2 ? 'PASS' : 'FAIL'}`)

  await ctx.fiber?.dispose()
  void fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify({
    sortMode, result: result === null ? null : 'ok', forced: record?.forced, prunedCount: prunedSeqs.length, prunedSeqs,
    prunedFacts, prunedEchos,
    q1: { correct: correct1, answer: a1text.slice(0, 500) }, q2: { correct: correct2, answer: a2text.slice(0, 500) },
    recall: { total: recallTotal, hits: recallHits }, stamp,
  }, null, 2), 'utf8')
}

run().catch(err => {
  console.error('[FATAL]', err)
  process.exit(1)
})
