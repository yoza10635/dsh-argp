/**
 * spike 7（M3）：基线臂 —— dsh 原版 BasicCompactionEngine 跑 t-long 同款任务（50 轮，medium 档）
 *
 * 目的：与 spike 6（ArgpGraphEngine 臂）构成同任务对照（C2/C3/C6）：
 *  - 摘要压缩的墙钟/token 成本（每笔事务 1 次额外 LLM 摘要请求，ARGP 为 0）
 *  - 长程信息保真：摘要改写 vs 占位+recall 找回。基线臂无 recall 通道，
 *    被摘要掉的内容若丢失即不可恢复——预期 R 针显著劣化（这就是 C3/C4 的对照证据）
 *
 * 与 spike 6 的差异（仅此四处，其余逐字一致）：
 *  1. 引擎：BasicCompactionEngine 替代 ArgpGraphEngine；无 recall_pruned、无 cites 契约
 *  2. 压力基线对齐：contextWindow=196608 × thresholdRatio=0.052 ≈ 10224 tokens ≈ ARGP 阈值
 *     （10240 tokens = 35840 chars）；retainTokens=7168 与 ARGP 同值。
 *     口径差异如实披露：basic 按 meter 请求 token 估算，ARGP 按 surface 可见 chars/3.5。
 *  3. probe 文案删去 recall_pruned 提示（基线臂无此工具，防幻觉调用）
 *  4. 判决适配：事务量按事件流 compaction/start|summary|end 计（basic 无 records API）；
 *     L2/L3 不设通过线预期——基线臂的退化幅度本身就是度量（METRIC），只保留 L1 稳定性判决
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'

const failures: string[] = []
const verdict = (name: string, ok: boolean, detail: string): void => {
  console.log((ok ? '[PASS ' : '[FAIL ') + name + '] ' + detail)
  if (!ok) failures.push(name + ': ' + detail)
}

// 看门狗：摘要臂每笔事务多一次摘要请求，预算放宽到 4 小时
const watchdog = setTimeout(() => {
  console.log('[FATAL] spike 7 watchdog timeout (240 min)')
  process.exit(2)
}, 240 * 60 * 1000)
watchdog.unref()

// ---------- 产物目录 ----------
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const outDir = path.join(import.meta.dirname, 'out', '07-baseline-' + stamp)
const workDir = path.join(outDir, 'work')
fs.mkdirSync(path.join(workDir, 'logs'), { recursive: true })

// ---------- needle 编码（与 spike 6 同函数，期望值两侧可比） ----------
const code = (n: number): string => ((n * 48_271) % 1_679_616).toString(36).toUpperCase().padStart(4, '0')
const uToken = (k: number): string => 'TK-' + code(k * 7 + 3)

// filler 语料与 spike 6 逐字一致（每片约 14.7K chars，首行埋 R 针）
function makeChunk(i: number): string {
  const lines: string[] = ['chunk ' + i + ' telemetry export — incident ref INC-' + i + '-MARKER-' + code(i)]
  for (let n = 0; n < 150; n += 1) {
    lines.push('2026-07-' + String(10 + (i % 20)) + '-' + String(((n % 28) + 1)).padStart(2, '0')
      + 'T' + String(n % 24).padStart(2, '0') + ':' + String((n * 7 + i) % 60).padStart(2, '0') + ':00Z '
      + 'level=' + (n % 13 === 0 ? 'WARN' : 'INFO') + ' svc=ingest-' + ((n % 7) + 1)
      + ' latency=' + (40 + ((n * i) % 90)) + 'ms queue=' + ((n * 3 + i) % 50)
      + ' msg="heartbeat ok shard=' + ((n + i) % 16) + '"')
  }
  return lines.join('\n')
}
const chunkCount = 42
for (let i = 1; i <= chunkCount; i += 1) {
  fs.writeFileSync(path.join(workDir, 'logs', 'chunk-' + i + '.md'), makeChunk(i), 'utf8')
}

// ---------- 装配：与 spike 6 同 provider 配置，引擎换 BasicCompactionEngine ----------
process.env['ARGP_LOCAL_KEY'] = 'local-no-auth'

const ctx = new Context()
await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: 'spike-7 t-long archival persona' } })
await ctx.plugin(AgentLoop, { agents: [] })
await ctx.plugin(LlmPiAi, {
  providers: {
    local: {
      displayName: 'Local llama.cpp',
      apiKeyEnv: 'ARGP_LOCAL_KEY',
      api: 'openai-completions',
      baseURL: 'http://localhost:8080/v1',
      compat: { thinkingFormat: 'qwen' },
      models: [{
        id: 'Qwen3.8-27B',
        name: 'Qwen3.8-27B (local SOTA)',
        contextWindow: 196_608,
        maxTokens: 65_536,
        reasoningEfforts: { off: 'false', high: 'true' },
      }],
    },
  },
})
// 压力对齐 ARGP 臂：threshold ≈ 196608 × 0.052 = 10223 tokens（ARGP 10240）；retain 7168 同值
await ctx.plugin(BasicCompactionEngine, {
  modelPolicies: [{
    provider: 'local',
    model: 'Qwen3.8-27B',
    thresholdRatio: 0.052,
    retainTokens: 7_168,
  }],
})

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

const agent = ctx.agentLoop.create(SessionId('spike-7-baseline'), {
  provider: 'local',
  model: 'Qwen3.8-27B',
  reasoningEffort: 'high',
})

ctx.on('agent/request-error', ({ failure }) => {
  console.log('[diag] request-error: ' + JSON.stringify({ code: failure.code, message: String(failure.message).slice(0, 300) }))
})
ctx.on('session/event', (session, event) => {
  if (session !== agent.session) return
  if (event.type === 'turn/end' || event.type === 'llm/retry' || event.type === 'compaction/start' || event.type === 'compaction/end') {
    console.log('[diag] ' + event.type + ': ' + JSON.stringify(event.data).slice(0, 300))
  }
})
const turnStats: { turn: number; promptTokens: number; completionTokens: number }[] = []
ctx.on('session/event', (session, event) => {
  if (session !== agent.session) return
  if (event.type === 'assistant/message') {
    const usage = (event.data as { usage?: { inputTokens?: number; outputTokens?: number } }).usage
    turnStats.push({
      turn: event.data.turn as number,
      promptTokens: usage?.inputTokens ?? -1,
      completionTokens: usage?.outputTokens ?? -1,
    })
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

/** 探活：health + 单请求 PONG（同 spike 6）。 */
async function serverProbe(): Promise<boolean> {
  try {
    const health = await fetch('http://localhost:8080/health', { signal: AbortSignal.timeout(5_000) })
    if (!health.ok) return false
    const res = await fetch('http://localhost:8080/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(120_000),
      body: JSON.stringify({ model: 'Qwen3.8-27B', messages: [{ role: 'user', content: 'Reply with exactly: PONG' }], max_tokens: -1 }),
    })
    return res.ok
  } catch {
    return false
  }
}

/** 单轮：followup + 等 idle；失败则探活后重试，最多 3 次（同 spike 6）。 */
async function runTurn(text: string): Promise<boolean> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let failed = false
    const dispose = ctx.on('session/event', (session, event) => {
      if (session !== agent.session) return
      if (event.type === 'turn/end' && (event.data as { reason?: { kind?: string } }).reason?.kind === 'error') failed = true
    })
    agent.followup(createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }))
    await waitForIdle(agent)
    dispose()
    if (!failed) return true
    if (attempt < 3) {
      const alive = await serverProbe()
      const waitMs = alive ? 15_000 : attempt === 1 ? 90_000 : 150_000
      console.log('[diag] turn failed (attempt ' + attempt + '/3); server probe=' + (alive ? 'alive' : 'unreachable/loading') + ', ' + Math.round(waitMs / 1000) + 's 后重试')
      await new Promise(r => setTimeout(r, waitMs))
    }
  }
  return false
}

// ---------- 任务编排：与 spike 6 逐字一致（probe 文案删 recall_pruned 提示） ----------
const PROBE_TURNS = [14, 20, 26, 32, 38, 44, 50]
const NEEDLE_TURNS = [3, 6, 9, 12, 17, 23, 29]
const setupText = 'We are starting a long-running archival session. From time to time I will hand you archival notes containing the service token of a node — keep them in mind. On most turns I will ask you to read a log file and report its line count; those are routine work. Occasionally I will send a long-term memory check; for those, follow the exact answer format given in the check itself. Work carefully.'
const fillerBody = (j: number): string =>
  'Use the read tool to read the entire file logs/chunk-' + j + '.md. After reading, reply with exactly one line and nothing else: the file name, a space, and its line count.'
const probeText = (k: number): string =>
  'Long-term memory check ' + k + '. Reply with exactly two lines and nothing else, in this format:\n'
  + 'U-ANSWER: <the service token from my archival note for node-' + k + '>\n'
  + 'R-ANSWER: <the full incident reference marker from the first line of the chunk file you read on the same turn I gave you the archival note for node-' + k + '>\n'
  + 'If you cannot recover a value, write NOT-RECOVERABLE on that line.'

type Item = { label: string; text: string; kind: 'setup' | 'filler' | 'probe'; probeK?: number; chunkIndex?: number; needleK?: number }
const items: Item[] = [{ label: 'setup', text: setupText, kind: 'setup' }]
let fillerIdx = 0
for (let turn = 2; turn <= 50; turn += 1) {
  const probePos = PROBE_TURNS.indexOf(turn)
  if (probePos >= 0) {
    const k = probePos + 1
    items.push({ label: 'probe-' + k, text: probeText(k), kind: 'probe', probeK: k })
    continue
  }
  fillerIdx += 1
  const needlePos = NEEDLE_TURNS.indexOf(turn)
  const needleK = needlePos >= 0 ? needlePos + 1 : undefined
  const text = needleK === undefined
    ? fillerBody(fillerIdx)
    : 'Archival note (remember it; no acknowledgment needed): the service token for node-' + needleK + ' is ' + uToken(needleK) + '.\n' + fillerBody(fillerIdx)
  items.push({ label: 'filler-' + fillerIdx, text, kind: 'filler', chunkIndex: fillerIdx, needleK })
}
const expected = new Map<number, { u: string; r: string; chunkIndex: number }>()
for (const item of items) {
  if (item.kind === 'filler' && item.needleK !== undefined) {
    const j = item.chunkIndex as number
    expected.set(item.needleK, { u: uToken(item.needleK), r: 'INC-' + j + '-MARKER-' + code(j), chunkIndex: j })
  }
}

// 事务计数（basic 无 records API，按事件流计）
let txCount = 0
ctx.on('session/event', (session, event) => {
  if (session !== agent.session) return
  if (event.type === 'compaction/start') txCount += 1
})

const startedAt = Date.now()
const turnLog: { label: string; ok: boolean; boundariesAfter: number; seconds: number }[] = []
let consecutiveFailedTurns = 0
let aborted = false
for (const item of items) {
  const turnStart = Date.now()
  const ok = await runTurn(item.text)
  turnLog.push({ label: item.label, ok, boundariesAfter: txCount, seconds: Math.round((Date.now() - turnStart) / 1000) })
  if (!ok) {
    consecutiveFailedTurns += 1
    console.log('[diag] ' + item.label + ' FAILED after 3 attempts')
    if (consecutiveFailedTurns >= 2) {
      console.log('[FATAL] 连续 2 轮重试耗尽 —— 放弃，保留已产生的产物')
      aborted = true
      break
    }
    continue
  }
  consecutiveFailedTurns = 0
  console.log('[turn] ' + item.label + ' done in ' + Math.round((Date.now() - turnStart) / 1000) + 's'
    + '; compactions=' + txCount)
}

const events = [...agent.session.events]

// turn 映射（与 spike 5/6 同源逻辑）
const promptMarkers = new Map<string, string>([
  ['setup', 'long-running archival session'],
  ...items.filter(i => i.kind === 'filler').map(i => [i.label, 'logs/chunk-' + String(i.chunkIndex) + '.md'] as [string, string]),
  ...items.filter(i => i.kind === 'probe').map(i => [i.label, 'Long-term memory check ' + String(i.probeK)] as [string, string]),
])
const turnOf = new Map<string, number>()
{
  const userEvs = events.filter(e => e.type === 'user/message' && (e.data as { source?: { kind?: string } }).source?.kind === 'user')
  const turnStarts = events.filter(e => e.type === 'turn/start').map(e => ({ seq: e.seq, turn: (e.data as { turn: number }).turn }))
  const turnOfUser = (seq: number): number | null => {
    let best: { seq: number; turn: number } | null = null
    for (const t of turnStarts) if (t.seq < seq && (best === null || t.seq > best.seq)) best = t
    return best?.turn ?? null
  }
  for (const item of items) {
    const marker = promptMarkers.get(item.label)
    if (marker === undefined) continue
    const matched = userEvs.filter(e => JSON.stringify((e.data as { content?: unknown }).content ?? '').includes(marker))
    const last = matched[matched.length - 1]
    if (last !== undefined) {
      const turn = turnOfUser(last.seq)
      if (turn !== null) turnOf.set(item.label, turn)
    }
  }
  console.log('[diag] turnOf resolved ' + turnOf.size + '/' + items.length)
}

/** 从单个事件提取模型可见文本（同 spike 6）。 */
function eventRawText(event: { type: string; data?: unknown }): string {
  const data = event.data as Record<string, unknown> | undefined
  if (event.type === 'tool/call') {
    const d = data as { name?: string; arguments?: unknown }
    return '[tool-call ' + (d?.name ?? '?') + '(' + (typeof d?.arguments === 'string' ? d.arguments : JSON.stringify(d?.arguments ?? {})) + ')]'
  }
  const message = (data as { message?: { content?: unknown[] } } | undefined)?.message
  const content = Array.isArray(message?.content) ? (message.content as { type: string; text?: string; content?: { type: string; text?: string }[] }[]) : []
  const parts: string[] = []
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    if (block.type === 'tool-result') {
      for (const inner of block.content ?? []) if (inner.type === 'text' && typeof inner.text === 'string') parts.push(inner.text)
    }
  }
  return parts.join('\n')
}

/** 从 surface 推导 LLM 消息并按块形状扫描孤儿（同 spike 2/4/5/6）。 */
function orphanReport(): string[] {
  const messages = agent.session.deriveMessages()
  const problems: string[] = []
  const openCalls = new Map<string, number>()
  messages.forEach((message, index) => {
    for (const block of message.content) {
      if (block.type === 'tool-call') openCalls.set(block.id, index)
      if (block.type === 'tool-result') {
        const id = (block as { toolCallId?: string }).toolCallId
        if (id === undefined) { problems.push('msg[' + index + '] tool-result without toolCallId'); continue }
        if (!openCalls.delete(id)) problems.push('msg[' + index + '] orphan tool-result for ' + id)
      }
    }
  })
  for (const [id, index] of openCalls) problems.push('msg[' + index + '] unanswered tool-call ' + id)
  return problems
}

// ---------- L1：长程稳定（轮次完成 + 事务完整 + 0 孤儿；事务量不设下限——摘要臂触发频率本身是度量） ----------
const completedTurns = turnLog.filter(t => t.ok).length
const orphans = orphanReport()
const starts = events.filter(e => e.type === 'compaction/start').length
const summaries = events.filter(e => e.type === 'compaction/summary').length
const ends = events.filter(e => e.type === 'compaction/end')
const endsWithError = ends.filter(e => (e.data as { error?: string }).error !== undefined).length
verdict('L1-long-run-stable', !aborted && completedTurns === items.length
  && orphans.length === 0 && starts === summaries && summaries === ends.length && endsWithError === 0,
  'turns=' + completedTurns + '/' + items.length + (aborted ? ' (aborted)' : '')
  + '; compactions=' + starts + '; orphans=' + orphans.length
  + '; tx start/summary/end=' + starts + '/' + summaries + '/' + ends.length + ' (error=' + endsWithError + ')')

// ---------- 误差曲线：逐 probe 判 U/R 两针（基线臂退化幅度 = 对照证据，METRIC） ----------
const shadowedAll = new Set<number>()
for (const e of events) {
  const seqs = (e.data as { shadowedSeqs?: number[] } | undefined)?.shadowedSeqs
  if (seqs !== undefined) for (const s of seqs) shadowedAll.add(s)
}
interface CurvePoint {
  probe: number; turn: number; compactions: number
  uCorrect: boolean; rCorrect: boolean; targetChunkIndex: number; targetShadowed: boolean
  uAnswer: string; rAnswer: string
}
const curve: CurvePoint[] = []
for (const item of items.filter(i => i.kind === 'probe')) {
  const k = item.probeK as number
  const exp = expected.get(k)
  if (exp === undefined) continue
  const turn = turnOf.get(item.label) ?? -1
  const raw = events.filter(e => e.type === 'assistant/message' && (e.data as { turn?: number }).turn === turn)
    .map(e => eventRawText(e)).join('\n')
  const uMatch = raw.match(/U-ANSWER:\s*([A-Za-z0-9-]+)/)
  const rMatch = raw.match(/R-ANSWER:\s*([A-Za-z0-9-]+)/)
  const uAnswer = uMatch?.[1]?.toUpperCase() ?? ''
  const rAnswer = rMatch?.[1]?.toUpperCase() ?? ''
  const markerNeedle = 'INC-' + exp.chunkIndex + '-MARKER-' + code(exp.chunkIndex)
  const targetSeqs = events.filter(e => e.type === 'tool/result' && eventRawText(e).includes(markerNeedle)).map(e => e.seq)
  const targetShadowed = targetSeqs.length > 0 && targetSeqs.every(seq => shadowedAll.has(seq))
  const compactionsAtProbe = turnLog.find(t => t.label === item.label)?.boundariesAfter ?? txCount
  curve.push({
    probe: k, turn, compactions: compactionsAtProbe,
    uCorrect: uAnswer === exp.u, rCorrect: rAnswer === exp.r,
    targetChunkIndex: exp.chunkIndex, targetShadowed,
    uAnswer, rAnswer,
  })
  console.log('[probe ' + k + '] compactions=' + compactionsAtProbe + ' U=' + (uAnswer === exp.u ? 'OK' : 'MISS(' + uAnswer + ')')
    + ' R=' + (rAnswer === exp.r ? 'OK' : 'MISS(' + rAnswer + ')') + ' shadowed=' + targetShadowed)
}
const uCorrectCount = curve.filter(p => p.uCorrect).length
const rCorrectCount = curve.filter(p => p.rCorrect).length
console.log('[METRIC baseline-accuracy] U=' + uCorrectCount + '/' + curve.length + ' R=' + rCorrectCount + '/' + curve.length
  + '（对照 spike 6 ARGP 臂：U 7/7、R 7/7 via recall）')
console.log('[METRIC error-curve] ' + JSON.stringify(curve.map(p => ({ probe: p.probe, c: p.compactions, u: p.uCorrect ? 1 : 0, r: p.rCorrect ? 1 : 0, sh: p.targetShadowed ? 1 : 0 }))))

// ---------- 统计与产物落盘 ----------
const reasoningChars = events.filter(e => e.type === 'assistant/message').reduce((sum, e) => {
  const content = (e.data as { message: { content: { type: string; text?: string }[] } }).message?.content ?? []
  return sum + content.filter(b => b.type === 'reasoning').reduce((s, b) => s + (b.text?.length ?? 0), 0)
}, 0)
const surfaceChars = [...agent.session.surface.nodes].reduce((sum, seq) => {
  const ev = agent.session.events[seq]
  return sum + (ev === undefined ? 0 : eventRawText(ev).length)
}, 0)
const summarizeChars = events.filter(e => e.type === 'compaction/summary').reduce((sum, e) => {
  const s = (e.data as { summary?: string }).summary
  return sum + (s?.length ?? 0)
}, 0)
const result = {
  spike: '07-baseline',
  at: new Date().toISOString(),
  engine: 'BasicCompactionEngine (dsh stock)',
  model: 'local/Qwen3.8-27B',
  pressureConfig: { thresholdRatio: 0.052, retainTokens: 7_168, contextWindow: 196_608 },
  wallSeconds: Math.round((Date.now() - startedAt) / 1000),
  turnsPlanned: items.length,
  turnsCompleted: completedTurns,
  aborted,
  compactions: starts,
  shadowedNodes: shadowedAll.size,
  summaryCharsTotal: summarizeChars,
  curve,
  uCorrect: uCorrectCount,
  rCorrect: rCorrectCount,
  reasoningChars,
  surfaceCharsEnd: surfaceChars,
  surfaceTokensEndApprox: Math.ceil(surfaceChars / 3.5),
  turnStats,
  turnLog,
  verdict: { failures },
}
fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2), 'utf8')
fs.writeFileSync(path.join(outDir, 'events.jsonl'),
  events.map(e => JSON.stringify(e)).join('\n'), 'utf8')
console.log('[info] artifacts: ' + outDir)
console.log('[info] wall=' + result.wallSeconds + 's; reasoning chars=' + reasoningChars
  + '; final surface~' + result.surfaceTokensEndApprox + ' tokens')

await ctx.fiber.dispose()
console.log(failures.length === 0
  ? 'SPIKE 7 VERDICT: PASS（基线臂长程稳定；U/R 准确率见 METRIC，与 spike 6 对照）'
  : 'SPIKE 7 VERDICT: FAIL（' + failures.length + ' 项未过：' + failures.join('; ') + '）')
process.exit(failures.length === 0 ? 0 : 1)
