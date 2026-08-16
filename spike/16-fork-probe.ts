/**
 * spike 16：fork 探针矩阵执行器。
 *
 * 从既有 06-tlong events.jsonl 中 fork 出目标 probe 轮之前的完整前缀，
 * 只重放一个 probe 轮。这样每个变体/每个 probe 的成本只有 1 轮，
 * 不需要重跑完整 50 轮。
 *
 * 环境：
 *   ARGP_FORK_BASE            事件源目录（默认 disabled rerun）
 *   ARGP_FORK_PROBE_INDEX     probe 序号 1..7（默认 2）
 *   ARGP_PROBE_VARIANT        v0/v1/v4（默认 v0）
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ArgpGraphEngine, eventText } from '../src/argp-graph-engine.ts'
import { DEEPSEEK_MODEL, DEEPSEEK_PROVIDER, DEEPSEEK_REASONING_EFFORT, mountDeepSeekFlash } from './deepseek.ts'

const baseDir = process.env['ARGP_FORK_BASE'] ?? 'spike/out/06-tlong-disabled-rerun-2026-08-16T14-02-21-785Z'
const probeIndex = Number(process.env['ARGP_FORK_PROBE_INDEX'] ?? 2)
const variant = process.env['ARGP_PROBE_VARIANT'] ?? 'v0'
const PROBE_TURNS = [14, 20, 26, 32, 38, 44, 50]
const NEEDLE_TURNS = [3, 6, 9, 12, 17, 23, 29]
const probeTurnPlanned = PROBE_TURNS[probeIndex - 1] ?? 20
const runName = '16-fork-probe' + probeIndex + '-' + variant

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const outDir = path.join(import.meta.dirname, 'out', runName + '-' + stamp)
fs.mkdirSync(outDir, { recursive: true })

const code = (n: number): string => ((n * 48_271) % 1_679_616).toString(36).toUpperCase().padStart(4, '0')
const uToken = (k: number): string => 'TK-' + code(k * 7 + 3)
const probesBeforeThisNeedle = PROBE_TURNS.filter(t => t < (NEEDLE_TURNS[probeIndex - 1] ?? 0)).length
const expectedChunk = (NEEDLE_TURNS[probeIndex - 1] ?? 1) - 1 - probesBeforeThisNeedle
const expectedU = uToken(probeIndex)
const expectedR = 'INC-' + expectedChunk + '-MARKER-' + code(expectedChunk)

const events = fs.readFileSync(path.join(baseDir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
const cutoff = events.findIndex(e => e.type === 'turn/start' && (e.data?.turn ?? 0) === probeTurnPlanned)
if (cutoff < 0) throw new Error('turn/start not found for turn ' + probeTurnPlanned)
let seedEnd = cutoff
while (seedEnd > 0 && events[seedEnd - 1]?.type !== 'turn/end') seedEnd -= 1
const seed = events.slice(0, seedEnd)
console.log('[diag] base=' + baseDir + ' probeIndex=' + probeIndex + ' plannedTurn=' + probeTurnPlanned + ' seedEnd=' + seedEnd + ' seedEvents=' + seed.length)

const PROBE_VARIANTS: Record<string, (k: number) => string> = {
  v0: (k) => 'Long-term memory check ' + k + '. Reply with exactly two lines and nothing else, in this format:\n'
    + 'U-ANSWER: <the service token from my archival note for node-' + k + '>\n'
    + 'R-ANSWER: <the full incident reference marker from the first line of the chunk file you read on the same turn I gave you the archival note for node-' + k + '>\n'
    + 'If you still cannot recover a value after trying recall_pruned, write NOT-RECOVERABLE on that line.',
  v1: (k) => 'Long-term memory check ' + k + '. If the chunk file content you read on the same turn as the archival note is not visible, call recall_pruned with the placeholder seq to recover it before answering. Do not guess.\n'
    + 'Reply with exactly two lines and nothing else, in this format:\n'
    + 'U-ANSWER: <the service token from my archival note for node-' + k + '>\n'
    + 'R-ANSWER: <the full incident reference marker from the first line of the chunk file you read on the same turn I gave you the archival note for node-' + k + '>\n'
    + 'If after trying recall_pruned you still cannot recover a value, write NOT-RECOVERABLE on that line.',
  v4: (k) => 'Long-term memory check ' + k + '. Reply with exactly two lines and nothing else, in this format:\n'
    + 'U-ANSWER: <the service token from my archival note for node-' + k + '>\n'
    + 'R-ANSWER: <the full incident reference marker from the first line of the chunk file you read on the same turn I gave you the archival note for node-' + k + '>\n'
    + 'If a needed value is not visible, call recall_pruned with the placeholder seq before answering. If after trying recall_pruned you still cannot recover, write NOT-RECOVERABLE on that line.',
  v5: (k) => 'Long-term memory check ' + k + '. You need the first line of the chunk file that was read on the same turn as the archival note for node-' + k + '. That first line is not visible; recover it with recall_pruned before answering.\n'
    + 'To recover, call recall_pruned for each placeholder seq you are unsure about, one at a time, until you find the tool result whose text starts with "chunk <n> telemetry export". Copy the exact INC-<n>-MARKER-<code> from that recovered text. Do not guess.\n'
    + 'Reply with exactly two lines and nothing else, in this format:\n'
    + 'U-ANSWER: <the service token from my archival note for node-' + k + '>\n'
    + 'R-ANSWER: <the full incident reference marker from the first line of the chunk file you read on the same turn I gave you the archival note for node-' + k + '>\n'
    + 'If after trying recall_pruned for all placeholders you still cannot recover it, write NOT-RECOVERABLE on that line.',
  v6: (k) => 'Long-term memory check ' + k + '. If the first line of the chunk file read with the archival note for node-' + k + ' is not visible, call recall_pruned to recover it before answering.\n'
    + 'Never answer with a marker unless you recovered that exact marker text via recall_pruned; guessing is not allowed.\n'
    + 'Reply with exactly two lines and nothing else, in this format:\n'
    + 'U-ANSWER: <the service token from my archival note for node-' + k + '>\n'
    + 'R-ANSWER: <the full incident reference marker from the first line of the chunk file you read on the same turn I gave you the archival note for node-' + k + '>\n'
    + 'If after trying recall_pruned you still cannot recover the exact marker, write NOT-RECOVERABLE on that line.',
}
const probeText = PROBE_VARIANTS[variant]?.(probeIndex)
if (probeText === undefined) throw new Error('unknown ARGP_PROBE_VARIANT: ' + variant)

const workDir = path.join(baseDir, 'work')
const sandbox = (rel: string): string => {
  const resolved = path.resolve(workDir, rel)
  if (!resolved.startsWith(workDir)) throw new Error('path escapes workdir: ' + rel)
  return resolved
}

const ctx = new Context()
await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: 'spike-16 fork probe persona' } })
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

const handle = await ctx.agents.create({
  sessionId: SessionId('spike-16-fork-' + probeIndex + '-' + variant + '-' + Date.now()),
  seed,
  agentOptions: { provider: DEEPSEEK_PROVIDER, model: DEEPSEEK_MODEL, reasoningEffort: DEEPSEEK_REASONING_EFFORT },
})
const agent = handle.agent
engine.setSession(agent.session)

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

const allToolCalls = [...agent.session.events].filter(e => e.type === 'tool/call' && (e.data as { turn?: number }).turn === turn)
const recallCalls = allToolCalls.filter(e => (e.data as { name?: string }).name === 'recall_pruned')
const toolCallSeq = (call: { data?: unknown }): number | null => {
  const rawArgs = (call.data as { arguments?: unknown } | undefined)?.arguments
  const parsed = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : (rawArgs as { seq?: unknown } | undefined)
  const seq = (parsed as { seq?: unknown } | undefined)?.seq
  return typeof seq === 'number' ? seq : null
}
const recallHits = recallCalls.map(toolCallSeq).filter((seq): seq is number => seq !== null && engine.recall(seq) !== null).length
const probeAssistant = [...agent.session.events].filter(e => e.type === 'assistant/message' && (e.data as { turn?: number }).turn === turn)
const finalAssistant = probeAssistant[probeAssistant.length - 1]
const rawFinal = finalAssistant !== undefined ? eventText(agent.session, finalAssistant.seq) : ''
const uAnswer = /U-ANSWER:\s*([A-Za-z0-9-]+)/.exec(rawFinal)?.[1]?.toUpperCase() ?? ''
const rAnswer = /R-ANSWER:\s*([A-Za-z0-9-]+)/.exec(rawFinal)?.[1]?.toUpperCase() ?? ''
const uCorrect = uAnswer === expectedU
const rCorrect = rAnswer === expectedR
const recallTriggered = recallCalls.length > 0

console.log('[diag] probe turn=' + turn)
console.log('[diag] all tool/call=' + JSON.stringify(allToolCalls.map(e => ({ name: (e.data as { name?: string }).name, args: (e.data as { arguments?: string }).arguments }))))
console.log('[diag] recall tool/call=' + recallCalls.length + ' hits=' + recallHits)
console.log('[diag] final raw=' + JSON.stringify(rawFinal.slice(0, 300)))
console.log('[diag] U=' + uAnswer + ' expected=' + expectedU + ' ok=' + uCorrect)
console.log('[diag] R=' + rAnswer + ' expected=' + expectedR + ' ok=' + rCorrect)
console.log('[METRIC] fork probe=' + probeIndex + ' variant=' + variant + ' turn=' + turn + ' recallTriggered=' + recallTriggered + ' recallCalls=' + recallCalls.length + ' recallHits=' + recallHits + ' rCorrect=' + rCorrect + ' uCorrect=' + uCorrect)

const result = {
  spike: runName,
  at: new Date().toISOString(),
  model: 'deepseek-official/deepseek-v4-flash',
  thinking: process.env['ARGP_DEEPSEEK_THINKING'] === 'enabled' ? 'enabled/high' : 'disabled/off',
  baseDir,
  probeIndex,
  probeTurnPlanned,
  actualTurn: turn,
  variant,
  probeText,
  expectedU,
  expectedR,
  recallTriggered,
  recallToolCalls: recallCalls.length,
  recallHits,
  allToolCalls: allToolCalls.map(e => ({ name: (e.data as { name?: string }).name, args: (e.data as { arguments?: string }).arguments })),
  rawFinal,
  uAnswer,
  rAnswer,
  uCorrect,
  rCorrect,
}
fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2), 'utf8')
console.log('[info] artifacts: ' + outDir)

await handle.dispose()
await ctx.fiber.dispose()
console.log('SPIKE 16 VERDICT: COMPLETE probe=' + probeIndex + ' variant=' + variant)
process.exit(0)
