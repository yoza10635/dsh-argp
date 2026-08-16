/**
 * spike 11：小型契约探针（prompt/tool 分离后首测）。
 *
 * 目的：在 disabled 与 high 两档下，检验同一轮里
 *   - recall_pruned 是否被触发并命中（R 针来自已剪 chunk）
 *   - 最终正文是否按 argp-cites 契约输出 cites JSON 块
 * 能否第一次同时成立。6-8 轮，便宜。
 *
 * 用法：
 *   node spike/11-contract-probe.ts                        # disabled 档
 *   ARGP_DEEPSEEK_THINKING=enabled node spike/11-contract-probe.ts
 *
 * 环境开关：
 *   ARGP_RUN_NAME       产物目录前缀（默认 11-contract-probe）
 *   ARGP_WINDOW_TOKENS  压缩触发预算（默认 800）
 *   ARGP_RETAIN_TOKENS  压缩保留预算（默认 400）
 *   ARGP_MIN_SPAN_CHARS 微剪枝下限（默认 200）
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
import { ArgpGraphEngine, extractCites, eventText } from '../src/argp-graph-engine.ts'
import { DEEPSEEK_MODEL, DEEPSEEK_PROVIDER, DEEPSEEK_REASONING_EFFORT, mountDeepSeekFlash } from './deepseek.ts'

const failures: string[] = []
const verdict = (name: string, ok: boolean, detail: string): void => {
  console.log((ok ? '[PASS ' : '[FAIL ') + name + '] ' + detail)
  if (!ok) failures.push(name + ': ' + detail)
}

const runName = process.env['ARGP_RUN_NAME'] ?? '11-contract-probe'
const windowTokens = Number(process.env['ARGP_WINDOW_TOKENS'] ?? 800)
const retainTokens = Number(process.env['ARGP_RETAIN_TOKENS'] ?? 400)
const minSpanChars = Number(process.env['ARGP_MIN_SPAN_CHARS'] ?? 200)

// ---------- 产物目录 ----------
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const outDir = path.join(import.meta.dirname, 'out', runName + '-' + stamp)
const workDir = path.join(outDir, 'work')
fs.mkdirSync(path.join(workDir, 'logs'), { recursive: true })

// ---------- 语料：目标 chunk 2 首行是 R 针 ----------
const code = (n: number): string => ((n * 48_271) % 1_679_616).toString(36).toUpperCase().padStart(4, '0')
const TARGET_CHUNK = 2
const targetFirstLine = 'chunk 2 telemetry export — incident ref INC-2-MARKER-' + code(2)
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

// ---------- 装配 ----------
const ctx = new Context()
await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: 'spike-11 contract probe persona' } })
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

const agent = ctx.agentLoop.create(SessionId('spike-11-contract-probe'), {
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
const turnStats: { turn: number; promptTokens: number; completionTokens: number }[] = []
ctx.on('session/event', (session, event) => {
  if (session !== agent.session) return
  if (event.type === 'assistant/message') {
    const usage = (event.data as { usage?: { inputTokens?: number; outputTokens?: number } }).usage
    turnStats.push({ turn: (event.data as { turn: number }).turn, promptTokens: usage?.inputTokens ?? -1, completionTokens: usage?.outputTokens ?? -1 })
  }
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

// ---------- 编排：setup + filler 至目标被剪 + probe ----------
const setupText = 'We are starting a compact archival session. On most turns I will ask you to read a log file and report its line count. Those are routine work; answer them briefly. Occasionally I will send a long-term memory check. For those, follow the exact format given in the check itself.'
const fillerBody = (j: number): string =>
  'Use the read tool to read the entire file logs/chunk-' + j + '.md. After reading, reply with exactly one line and nothing else: the file name, a space, and its line count.'
const probeText = 'Long-term memory check 1. The first line of the file logs/chunk-2.md is needed for the answer below. If that file content is not visible in the current context, call recall_pruned with the placeholder seq to recover it before answering. Do not guess. Then reply with exactly one line:\n'
  + 'R-ANSWER: <the full incident reference marker from the first line of logs/chunk-2.md>\n'
  + 'After that one line, append the citation declaration JSON block as specified in your instructions, citing the first 10-20 words of the chunk-2 file content you recovered.'

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
let fillerIdx = 0
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

// ---------- 判决 ----------
const events = [...agent.session.events]
const targetPrunedAtProbe = targetSeq !== undefined && engine.recall(targetSeq) !== null

// recall 工具调用：探针轮内 tool/call 事件计数 + 引擎执行台账
const probeRecallCalls = events.filter(e => e.type === 'tool/call'
  && (e.data as { name?: string }).name === 'recall_pruned'
  && (e.data as { turn?: number }).turn === probeTurn)
const recallExecutions = engine.recallCalls
const toolCallSeq = (call: { data?: unknown }): number | null => {
  const rawArgs = (call.data as { arguments?: unknown } | undefined)?.arguments
  const parsed = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : (rawArgs as { seq?: unknown } | undefined)
  const seq = (parsed as { seq?: unknown } | undefined)?.seq
  return typeof seq === 'number' ? seq : null
}
const probeRecallHits = probeRecallCalls.map(toolCallSeq).filter((seq): seq is number => seq !== null && engine.recall(seq) !== null).length

// 最终正文：探针轮最后一条 assistant/message
const probeAssistantEvents = events.filter(e => e.type === 'assistant/message' && (e.data as { turn?: number }).turn === probeTurn)
const finalAssistant = probeAssistantEvents[probeAssistantEvents.length - 1]
const rawFinal = finalAssistant !== undefined ? eventText(agent.session, finalAssistant.seq) : ''
const { body, cites, attempted, parseFailed } = extractCites(rawFinal)
const rAnswer = /R-ANSWER:\s*([A-Za-z0-9-]+)/.exec(rawFinal)?.[1]?.toUpperCase() ?? ''
const expectedR = 'INC-' + TARGET_CHUNK + '-MARKER-' + code(TARGET_CHUNK)
const rCorrect = rAnswer === expectedR
const citeCorrect = cites.length > 0 && cites.some(c => c.toLowerCase().includes('chunk ' + TARGET_CHUNK + ' telemetry export'))
const both = rCorrect && citeCorrect && probeRecallCalls.length > 0 && probeRecallHits > 0

console.log('[diag] probeTurn=' + probeTurn)
console.log('[diag] targetSeq=' + String(targetSeq) + ' prunedBeforeProbe=' + targetPrunedBeforeProbe + ' prunedAtProbe=' + targetPrunedAtProbe)
console.log('[diag] recall tool/call in probe turn=' + probeRecallCalls.length + '; engine.recallCalls=' + JSON.stringify(recallExecutions))
console.log('[diag] final raw=' + JSON.stringify(rawFinal.slice(0, 400)))
console.log('[diag] extractCites body=' + JSON.stringify(body.slice(0, 160)) + ' cites=' + JSON.stringify(cites) + ' attempted=' + attempted + ' parseFailed=' + parseFailed)
console.log('[diag] R-ANSWER=' + rAnswer + ' expected=' + expectedR + ' rCorrect=' + rCorrect + ' citeCorrect=' + citeCorrect)

verdict('C1-recall-triggered', probeRecallCalls.length > 0,
  'probe turn recall_pruned tool/call count=' + probeRecallCalls.length)
console.log('[METRIC recall-hit-rate] ' + probeRecallHits + '/' + probeRecallCalls.length)
verdict('C3-cites-in-final-body', citeCorrect,
  'final body cites=' + JSON.stringify(cites))
verdict('C4-both-first-try', both,
  'recall trigger + hit + R correct + cites final body all hold in the same first probe')

// ---------- 产物 ----------
const result = {
  spike: runName,
  at: new Date().toISOString(),
  model: 'deepseek-official/deepseek-v4-flash',
  thinking: process.env['ARGP_DEEPSEEK_THINKING'] === 'enabled' ? 'enabled/high' : 'disabled/off',
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
  probeRecallToolCallCount: probeRecallCalls.length,
  probeRecallHits,
  recallExecutions,
  rawFinal,
  extract: { body, cites, attempted, parseFailed },
  rAnswer,
  expectedR,
  rCorrect,
  citeCorrect,
  both,
  boundariesAfterProbe: engine.records.length,
  citeStats: engine.citeStats,
  turnStats,
  verdict: { failures },
}
fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2), 'utf8')
fs.writeFileSync(path.join(outDir, 'events.jsonl'), events.map(e => JSON.stringify(e)).join('\n'), 'utf8')
console.log('[info] artifacts: ' + outDir)
console.log('[info] wall=' + result.wallSeconds + 's')

await ctx.fiber.dispose()
console.log(failures.length === 0
  ? 'SPIKE 11 VERDICT: PASS（recall 与 cites 首次同时成立）'
  : 'SPIKE 11 VERDICT: FAIL（' + failures.length + ' 项未过：' + failures.join('; ') + '）')
process.exit(failures.length === 0 ? 0 : 1)
