/**
 * spike 12：disabled 档 recall 触发诊断探针。
 *
 * 复刻 06-tlong 的 probe-1 场景（archival note + 同轮读 chunk2），
 * 只把 probe 文案作为实验变量，看 disabled 档在哪一种文案下会触发 recall_pruned。
 * 便宜：每个 variant 5-6 轮，只跑 disabled。
 *
 * 用法：
 *   ARGP_PROBE_VARIANT=v0 node spike/12-recall-trigger-probe.ts
 *   ARGP_PROBE_VARIANT=v1 node spike/12-recall-trigger-probe.ts
 *   ...
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

const variant = process.env['ARGP_PROBE_VARIANT'] ?? 'v0'
const runName = '12-recall-trigger-probe-' + variant
const windowTokens = Number(process.env['ARGP_WINDOW_TOKENS'] ?? 800)
const retainTokens = Number(process.env['ARGP_RETAIN_TOKENS'] ?? 400)
const minSpanChars = Number(process.env['ARGP_MIN_SPAN_CHARS'] ?? 200)

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const outDir = path.join(import.meta.dirname, 'out', runName + '-' + stamp)
const workDir = path.join(outDir, 'work')
fs.mkdirSync(path.join(workDir, 'logs'), { recursive: true })

const code = (n: number): string => ((n * 48_271) % 1_679_616).toString(36).toUpperCase().padStart(4, '0')
const uToken = (k: number): string => 'TK-' + code(k * 7 + 3)
const TARGET_CHUNK = 2
const expectedU = uToken(1)
const expectedR = 'INC-' + TARGET_CHUNK + '-MARKER-' + code(TARGET_CHUNK)
function makeChunk(i: number): string {
  const lines: string[] = ['chunk ' + i + ' telemetry export — incident ref INC-' + i + '-MARKER-' + code(i)]
  for (let n = 0; n < 90; n += 1) {
    lines.push('2026-07-' + String(10 + (i % 20)) + '-' + String(((n % 28) + 1)).padStart(2, '0')
      + 'T' + String(n % 24).padStart(2, '0') + ':' + String((n * 7 + i) % 60).padStart(2, '0') + ':00Z '
      + 'level=' + (n % 13 === 0 ? 'WARN' : 'INFO') + ' svc=ingest-' + ((n % 7) + 1)
      + ' latency=' + (40 + ((n * i) % 90)) + 'ms queue=' + ((n * 3 + i) % 50)
      + ' msg="heartbeat ok shard=' + ((n + i) % 16) + '"')
  }
  return lines.join('\n')
}
for (let i = 1; i <= 8; i += 1) {
  fs.writeFileSync(path.join(workDir, 'logs', 'chunk-' + i + '.md'), makeChunk(i), 'utf8')
}

const PROBE_VARIANTS: Record<string, string> = {
  // v0：06-tlong 原文（对照）
  v0: 'Long-term memory check 1. Reply with exactly two lines and nothing else, in this format:\n'
    + 'U-ANSWER: <the service token from my archival note for node-1>\n'
    + 'R-ANSWER: <the full incident reference marker from the first line of the chunk file you read on the same turn I gave you the archival note for node-1>\n'
    + 'If you still cannot recover a value after trying recall_pruned, write NOT-RECOVERABLE on that line.',
  // v1：开头显式指令 call recall_pruned，保留 exactly two lines and nothing else
  v1: 'Long-term memory check 1. If the chunk file content you read with the archival note is not visible, call recall_pruned with the placeholder seq to recover it before answering. Do not guess.\n'
    + 'Reply with exactly two lines and nothing else, in this format:\n'
    + 'U-ANSWER: <the service token from my archival note for node-1>\n'
    + 'R-ANSWER: <the full incident reference marker from the first line of the chunk file you read on the same turn I gave you the archival note for node-1>\n'
    + 'If after trying recall_pruned you still cannot recover a value, write NOT-RECOVERABLE on that line.',
  // v2：原格式但去掉 and nothing else
  v2: 'Long-term memory check 1. Reply with exactly two lines, in this format:\n'
    + 'U-ANSWER: <the service token from my archival note for node-1>\n'
    + 'R-ANSWER: <the full incident reference marker from the first line of the chunk file you read on the same turn I gave you the archival note for node-1>\n'
    + 'If you still cannot recover a value after trying recall_pruned, write NOT-RECOVERABLE on that line.',
  // v3：原格式 + 前置通用工具许可
  v3: 'Long-term memory check 1. You may call tools if needed before writing your final answer. Reply with exactly two lines and nothing else, in this format:\n'
    + 'U-ANSWER: <the service token from my archival note for node-1>\n'
    + 'R-ANSWER: <the full incident reference marker from the first line of the chunk file you read on the same turn I gave you the archival note for node-1>\n'
    + 'If you still cannot recover a value after trying recall_pruned, write NOT-RECOVERABLE on that line.',
  // v4：格式后显式指令（把 fallback 句替换为显式 call 指令）
  v4: 'Long-term memory check 1. Reply with exactly two lines and nothing else, in this format:\n'
    + 'U-ANSWER: <the service token from my archival note for node-1>\n'
    + 'R-ANSWER: <the full incident reference marker from the first line of the chunk file you read on the same turn I gave you the archival note for node-1>\n'
    + 'If a needed value is not visible, call recall_pruned with the placeholder seq before answering. If after trying recall_pruned you still cannot recover, write NOT-RECOVERABLE on that line.',
}
const probeText = PROBE_VARIANTS[variant]
if (probeText === undefined) {
  console.error('unknown ARGP_PROBE_VARIANT: ' + variant)
  process.exit(2)
}

const ctx = new Context()
await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: 'spike-12 recall trigger diagnostic persona' } })
await ctx.plugin(AgentLoop, { agents: [] })
await mountDeepSeekFlash(ctx)
await ctx.plugin(ArgpGraphEngine, { windowTokens, retainTokens, minSpanChars, maxPasses: 32 })
const engine = ctx.compaction as ArgpGraphEngine

const sandbox = (rel: string): string => {
  const resolved = path.resolve(workDir, rel)
  if (!resolved.startsWith(workDir)) throw new Error('path escapes workdir: ' + rel)
  return resolved
}
ctx.tools.register(defineTool({
  name: 'read_file',
  description: 'Read a text file by path relative to the task working directory.',
  parameters: { path: { type: 'string', description: 'file path relative to the working directory' } },
  output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
  execute: async (args): Promise<string> => {
    const rel = (args as { path?: string }).path ?? ''
    try {
      return fs.readFileSync(sandbox(rel), 'utf8')
    } catch {
      return 'read_file: no such file: ' + rel
    }
  },
}))

const agent = ctx.agentLoop.create(SessionId('spike-12-' + variant), {
  provider: DEEPSEEK_PROVIDER,
  model: DEEPSEEK_MODEL,
  reasoningEffort: DEEPSEEK_REASONING_EFFORT,
})
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
      if (a === subject && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

async function serverProbe(): Promise<boolean> {
  try {
    const apiKey = process.env['DEEPSEEK_API_KEY']
    if (apiKey === undefined || apiKey.length === 0) return false
    const res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(60_000),
      body: JSON.stringify({ model: DEEPSEEK_MODEL, messages: [{ role: 'user', content: 'Reply with exactly: PONG' }], max_tokens: 8 }),
    })
    return res.ok
  } catch {
    return false
  }
}

async function runTurn(text: string): Promise<boolean> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let failed = false
    const dispose = ctx.on('session/event', (session, event) => {
      if (session !== agent.session) return
      if (event.type === 'turn/end' && (event.data as { reason?: { kind?: string } }).reason?.kind === 'error') failed = true
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
    await waitForIdle(agent)
    dispose()
    if (!failed) return true
    if (attempt < 3) {
      const alive = await serverProbe()
      const waitMs = alive ? 10_000 : 60_000
      console.log('[diag] turn failed (attempt ' + attempt + '/3); serverProbe=' + (alive ? 'alive' : 'unreachable/loading') + ', ' + Math.round(waitMs / 1000) + 's 后重试')
      await new Promise(r => setTimeout(r, waitMs))
    }
  }
  return false
}

const setupText = 'We are starting a compact archival session. On most turns I will ask you to read a log file and report its line count. Those are routine work; answer them briefly. Occasionally I will send a long-term memory check. For those, follow the exact format given in the check itself.'
const fillerBody = (j: number): string =>
  'Use the read tool to read the entire file logs/chunk-' + j + '.md. After reading, reply with exactly one line and nothing else: the file name, a space, and its line count.'

const startedAt = Date.now()
const turnLog: { label: string; ok: boolean; turn: number; seconds: number; boundariesAfter: number }[] = []
let aborted = false

async function doTurn(label: string, text: string): Promise<boolean> {
  const turnStart = Date.now()
  const ok = await runTurn(text)
  turnLog.push({ label, ok, turn: currentTurn, seconds: Math.round((Date.now() - turnStart) / 1000), boundariesAfter: engine.records.length })
  console.log('[turn] ' + label + ' turn=' + currentTurn + ' ok=' + ok + ' in ' + Math.round((Date.now() - turnStart) / 1000) + 's; boundaries=' + engine.records.length)
  return ok
}

let targetSeq: number | undefined
const findTargetSeq = (): number | undefined => {
  const marker = 'INC-' + TARGET_CHUNK + '-MARKER-' + code(TARGET_CHUNK)
  const event = [...agent.session.events].find(e => e.type === 'tool/result' && eventText(agent.session, e.seq).includes(marker))
  return event?.seq
}

if (!await doTurn('setup', setupText)) aborted = true
if (!aborted && !await doTurn('filler-1', fillerBody(1))) aborted = true
if (!aborted) {
  const noteText = 'Archival note (remember it; no acknowledgment needed): the service token for node-1 is ' + expectedU + '.\n' + fillerBody(2)
  if (!await doTurn('filler-2-note-1', noteText)) aborted = true
}
let fillerIdx = 2
while (!aborted && fillerIdx < 8) {
  fillerIdx += 1
  if (!await doTurn('filler-' + fillerIdx, fillerBody(fillerIdx))) { aborted = true; break }
  targetSeq = findTargetSeq()
  if (targetSeq !== undefined && engine.recall(targetSeq) !== null) break
}
const targetPrunedBeforeProbe = targetSeq !== undefined && engine.recall(targetSeq) !== null
if (!aborted && !targetPrunedBeforeProbe) {
  console.log('[diag] WARNING: target chunk not pruned after fillers; probe will run but recall condition is not armed')
}
let probeTurn = -1
let probeOk = false
if (!aborted) {
  probeOk = await doTurn('probe-1', probeText)
  probeTurn = currentTurn
}

const events = [...agent.session.events]
const targetPrunedAtProbe = targetSeq !== undefined && engine.recall(targetSeq) !== null
const probeRecallCalls = events.filter(e => e.type === 'tool/call'
  && (e.data as { name?: string }).name === 'recall_pruned'
  && (e.data as { turn?: number }).turn === probeTurn)
const toolCallSeq = (call: { data?: unknown }): number | null => {
  const rawArgs = (call.data as { arguments?: unknown } | undefined)?.arguments
  const parsed = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : (rawArgs as { seq?: unknown } | undefined)
  const seq = (parsed as { seq?: unknown } | undefined)?.seq
  return typeof seq === 'number' ? seq : null
}
const probeRecallHits = probeRecallCalls.map(toolCallSeq).filter((seq): seq is number => seq !== null && engine.recall(seq) !== null).length
const probeAssistantEvents = events.filter(e => e.type === 'assistant/message' && (e.data as { turn?: number }).turn === probeTurn)
const finalAssistant = probeAssistantEvents[probeAssistantEvents.length - 1]
const rawFinal = finalAssistant !== undefined ? eventText(agent.session, finalAssistant.seq) : ''
const uAnswer = /U-ANSWER:\s*([A-Za-z0-9-]+)/.exec(rawFinal)?.[1]?.toUpperCase() ?? ''
const rAnswer = /R-ANSWER:\s*([A-Za-z0-9-]+)/.exec(rawFinal)?.[1]?.toUpperCase() ?? ''
const uCorrect = uAnswer === expectedU
const rCorrect = rAnswer === expectedR
const recallTriggered = probeRecallCalls.length > 0

console.log('[diag] variant=' + variant)
console.log('[diag] probeTurn=' + probeTurn)
console.log('[diag] targetSeq=' + String(targetSeq) + ' prunedBeforeProbe=' + targetPrunedBeforeProbe + ' prunedAtProbe=' + targetPrunedAtProbe)
console.log('[diag] recall tool/call in probe turn=' + probeRecallCalls.length + '; hits=' + probeRecallHits)
console.log('[diag] final raw=' + JSON.stringify(rawFinal.slice(0, 400)))
console.log('[diag] U-ANSWER=' + uAnswer + ' expected=' + expectedU + ' uCorrect=' + uCorrect)
console.log('[diag] R-ANSWER=' + rAnswer + ' expected=' + expectedR + ' rCorrect=' + rCorrect)
console.log('[METRIC] variant=' + variant + ' recallTriggered=' + recallTriggered + ' recallCalls=' + probeRecallCalls.length + ' recallHits=' + probeRecallHits + ' rCorrect=' + rCorrect)

const result = {
  spike: runName,
  at: new Date().toISOString(),
  model: 'deepseek-official/deepseek-v4-flash',
  thinking: process.env['ARGP_DEEPSEEK_THINKING'] === 'enabled' ? 'enabled/high' : 'disabled/off',
  variant,
  probeText,
  windowTokens,
  retainTokens,
  minSpanChars,
  wallSeconds: Math.round((Date.now() - startedAt) / 1000),
  targetChunk: TARGET_CHUNK,
  targetSeq,
  targetPrunedBeforeProbe,
  targetPrunedAtProbe,
  probeTurn,
  probeOk,
  turnLog,
  probeRecallCalls: probeRecallCalls.length,
  probeRecallHits,
  recallTriggered,
  rawFinal,
  uAnswer,
  expectedU,
  rAnswer,
  expectedR,
  uCorrect,
  rCorrect,
  boundariesAfterProbe: engine.records.length,
  turnStats: [],
  verdict: aborted ? 'ABORTED' : 'COMPLETE',
}
fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2), 'utf8')
fs.writeFileSync(path.join(outDir, 'events.jsonl'), events.map(e => JSON.stringify(e)).join('\n'), 'utf8')
console.log('[info] artifacts: ' + outDir)
console.log('[info] wall=' + result.wallSeconds + 's')

await ctx.fiber.dispose()
console.log('SPIKE 12 VERDICT: ' + result.verdict + ' variant=' + variant)
process.exit(aborted ? 1 : 0)
