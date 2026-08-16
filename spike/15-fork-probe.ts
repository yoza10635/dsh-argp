/**
 * spike 15（可行性实验）：从 06-tlong 已有 events.jsonl 分叉出 probe 前的前缀 session，
 * 只跑一个 probe 轮，节约压缩前成本。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ArgpGraphEngine, eventText } from '../src/argp-graph-engine.ts'
import { DEEPSEEK_MODEL, DEEPSEEK_PROVIDER, DEEPSEEK_REASONING_EFFORT, mountDeepSeekFlash } from './deepseek.ts'

const baseDir = process.env['ARGP_FORK_BASE'] ?? 'spike/out/06-tlong-disabled-rerun-2026-08-16T14-02-21-785Z'
const probeTurn = Number(process.env['ARGP_FORK_PROBE_TURN'] ?? 20)
const variant = process.env['ARGP_PROBE_VARIANT'] ?? 'v0'
const events = fs.readFileSync(path.join(baseDir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
const cutoff = events.findIndex(e => e.type === 'turn/start' && (e.data?.turn ?? 0) === probeTurn)
if (cutoff < 0) throw new Error('turn/start not found for turn ' + probeTurn)
let seedEnd = cutoff
while (seedEnd > 0 && events[seedEnd - 1]?.type !== 'turn/end') seedEnd -= 1
const seed = events.slice(0, seedEnd)
console.log('[diag] total events=' + events.length + ' cutoff=' + cutoff + ' seedEnd=' + seedEnd + ' seed events=' + seed.length)
console.log('[diag] seed last=', JSON.stringify(seed[seed.length - 1]?.type))

// 原 run 的工作目录，read_file 沙箱复用
const workDir = path.join(baseDir, 'work')
const sandbox = (rel: string): string => {
  const resolved = path.resolve(workDir, rel)
  if (!resolved.startsWith(workDir)) throw new Error('path escapes workdir: ' + rel)
  return resolved
}

const ctx = new Context()
await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: 'spike-15 fork probe persona' } })
await ctx.plugin(AgentLoop, { agents: [] })
await mountDeepSeekFlash(ctx)
await ctx.plugin(ArgpGraphEngine, { windowTokens: 10_240, retainTokens: 7_168, maxPasses: 16 })
const engine = ctx.compaction as ArgpGraphEngine
ctx.tools.register(defineTool({
  name: 'read_file',
  description: 'Read a text file by path relative to the task working directory.',
  parameters: { path: { type: 'string', description: 'file path relative to the working directory' } },
  output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
  execute: async (args): Promise<string> => {
    const rel = (args as { path?: string }).path ?? ''
    try { return fs.readFileSync(sandbox(rel), 'utf8') } catch { return 'read_file: no such file: ' + rel }
  },
}))

const PROBE_VARIANTS: Record<string, string> = {
  v0: 'Long-term memory check 2. Reply with exactly two lines and nothing else, in this format:\n'
    + 'U-ANSWER: <the service token from my archival note for node-2>\n'
    + 'R-ANSWER: <the full incident reference marker from the first line of the chunk file you read on the same turn I gave you the archival note for node-2>\n'
    + 'If you still cannot recover a value after trying recall_pruned, write NOT-RECOVERABLE on that line.',
  v1: 'Long-term memory check 2. If the chunk file content you read on the same turn as the archival note is not visible, call recall_pruned with the placeholder seq to recover it before answering. Do not guess.\n'
    + 'Reply with exactly two lines and nothing else, in this format:\n'
    + 'U-ANSWER: <the service token from my archival note for node-2>\n'
    + 'R-ANSWER: <the full incident reference marker from the first line of the chunk file you read on the same turn I gave you the archival note for node-2>\n'
    + 'If after trying recall_pruned you still cannot recover a value, write NOT-RECOVERABLE on that line.',
}
const probeText = PROBE_VARIANTS[variant] ?? PROBE_VARIANTS.v0!

const handle = await ctx.agents.create({
  sessionId: SessionId('spike-15-fork-' + Date.now()),
  seed,
  agentOptions: { provider: DEEPSEEK_PROVIDER, model: DEEPSEEK_MODEL, reasoningEffort: DEEPSEEK_REASONING_EFFORT },
})
const agent = handle.agent
engine.setSession(agent.session)
console.log('[diag] forked session id=' + String(agent.session.id) + ' events=' + agent.session.events.length + ' surface nodes=' + agent.session.surface.nodes.length)
for (let idx = Math.max(0, agent.session.events.length - 6); idx < agent.session.events.length; idx += 1) {
  const ev = agent.session.events[idx]
  console.log('[diag] forked event ' + idx + ' ' + (ev?.type ?? '?') + ' turn=' + ((ev?.data as { turn?: number })?.turn ?? ''))
}

let currentTurn = 0
ctx.on('session/event', (session, event) => {
  if (session !== agent.session) return
  if (event.type === 'turn/start') currentTurn = (event.data as { turn: number }).turn
})
ctx.on('agent/request-error', ({ failure }) => {
  console.log('[diag] request-error: ' + JSON.stringify({ code: failure.code, message: String(failure.message).slice(0, 300) }))
})

function waitForIdle(subject: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: a, status }) => {
      if (a === subject && status === 'idle') { dispose(); resolve() }
    })
  })
}

agent.followup(createUserMessage({ content: [{ type: 'text', text: probeText }], source: { kind: 'user' } }))
await waitForIdle(agent)
const turn = currentTurn
console.log('[diag] probe turn=' + turn)
const recallCalls = [...agent.session.events].filter(e => e.type === 'tool/call'
  && (e.data as { name?: string }).name === 'recall_pruned'
  && (e.data as { turn?: number }).turn === turn)
const probeAssistant = [...agent.session.events].filter(e => e.type === 'assistant/message' && (e.data as { turn?: number }).turn === turn)
const finalAssistant = probeAssistant[probeAssistant.length - 1]
const rawFinal = finalAssistant !== undefined ? eventText(agent.session, finalAssistant.seq) : ''
const uAnswer = /U-ANSWER:\s*([A-Za-z0-9-]+)/.exec(rawFinal)?.[1]?.toUpperCase() ?? ''
const rAnswer = /R-ANSWER:\s*([A-Za-z0-9-]+)/.exec(rawFinal)?.[1]?.toUpperCase() ?? ''
const probeToolCalls = [...agent.session.events].filter(e => e.type === 'tool/call' && (e.data as { turn?: number }).turn === turn)
console.log('[diag] all tool/call in probe turn=' + JSON.stringify(probeToolCalls.map(e => ({ name: (e.data as { name?: string }).name, args: (e.data as { arguments?: string }).arguments }))))
console.log('[diag] recall tool/call=' + recallCalls.length + ' args=' + recallCalls.map(e => (e.data as { arguments?: string }).arguments).join(','))
console.log('[diag] final raw=' + JSON.stringify(rawFinal.slice(0, 300)))
console.log('[diag] U=' + uAnswer + ' R=' + rAnswer)
console.log('[METRIC] fork variant=' + variant + ' turn=' + turn + ' recall=' + recallCalls.length + ' R=' + rAnswer)

await handle.dispose()
await ctx.fiber.dispose()
console.log('SPIKE 15 VERDICT: COMPLETE')
process.exit(0)
