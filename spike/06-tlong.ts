/**
 * spike 6（M3）：t-long 长程误差曲线 × ArgpGraphEngine（50 轮，DeepSeek v4-flash）
 *
 * 目标（设计稿 §10）：probe 准确率随剪枝边界数增长的误差累积曲线；真剪枝链长程稳定性。
 * 结构：setup 1 + filler 42 + probe 7（轮 14/20/26/32/38/44/50）= 50 轮。
 * 双针设计：
 *  - U 针 ×7：埋在第 3/6/9/12/17/23/29 轮的 filler 用户消息（archival note，node-k token）。
 *    U 永不参剪（不变式 6）→ U 探针应全对，检验长程 U 载体保护。
 *  - R 针 ×42：每个 chunk 首行唯一 marker（INC-j-MARKER-xxxx）。chunk 读后被剪 →
 *    R 探针检验"被剪内容经 recall_pruned 找回"闭环（C4 长程）。
 * 曲线点：probe k 时的边界数（engine.records.length）× U/R 正确率 × 目标是否已遮蔽。
 *
 * 判决项：
 *  L1 long-run-stable：50 轮全完成 + 事务 ≥10 + 0 孤儿 + 事务事件完整
 *  L2 u-protection：U 探针正确 ≥6/7（U 永在 surface，只是读回）
 *  L3 r-recovery：R 探针正确 ≥4/7（允许 recall 失败余量；曲线为 METRIC）
 *  METRIC：误差曲线数组、recall 使用量、citeStats、token 统计
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { DEEPSEEK_MODEL, DEEPSEEK_PROVIDER, DEEPSEEK_REASONING_EFFORT } from './deepseek.ts'
import { mountModel } from './model-mount.ts'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ArgpGraphEngine } from '../src/argp-graph-engine.ts'

const failures: string[] = []
const verdict = (name: string, ok: boolean, detail: string): void => {
  console.log((ok ? '[PASS ' : '[FAIL ') + name + '] ' + detail)
  if (!ok) failures.push(name + ': ' + detail)
}

// 看门狗：50 轮 × ~93s ≈ 80min，叠加重试/自死重载余量，3 小时封顶
const watchdog = setTimeout(() => {
  console.log('[FATAL] spike 6 watchdog timeout (180 min)')
  process.exit(2)
}, 180 * 60 * 1000)
watchdog.unref()

// 预算档环境开关：spike 8 生产档用 100000/33000/256，原 t-long 档为默认 10240/7168/16。
const runName = process.env['ARGP_RUN_NAME'] ?? '06-tlong-deepseek'
const windowTokens = Number(process.env['ARGP_WINDOW_TOKENS'] ?? 10_240)
const retainTokens = Number(process.env['ARGP_RETAIN_TOKENS'] ?? 7_168)
const maxPasses = Number(process.env['ARGP_MAX_PASSES'] ?? 16)
const minBoundaries = Number(process.env['ARGP_MIN_BOUNDARIES'] ?? 10)
// 边价值实验开关：ARGP_CITES_ON=false → fillerBody 去掉 cites 指令句（A₁/A₀ 臂：模型不产 cites → 无语义边）
const citesOn = process.env['ARGP_CITES_ON'] !== 'false'

// ---------- 产物目录 ----------
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const outDir = path.join(import.meta.dirname, 'out', runName + '-' + stamp)
const workDir = path.join(outDir, 'work')
fs.mkdirSync(path.join(workDir, 'logs'), { recursive: true })

// ---------- needle 编码（确定性伪随机，脚本侧持有期望值） ----------
const code = (n: number): string => ((n * 48_271) % 1_679_616).toString(36).toUpperCase().padStart(4, '0')
const uToken = (k: number): string => 'TK-' + code(k * 7 + 3)

// filler 语料：首行埋 R 针（唯一 marker），其余为遥测噪声（每片约 14.7K chars @150 行；600 行 ≈ 17K tokens/轮，用于 160K 触发档）
const chunkLines = Number(process.env['ARGP_CHUNK_LINES'] ?? 150)
function makeChunk(i: number): string {
  const lines: string[] = ['chunk ' + i + ' telemetry export — incident ref INC-' + i + '-MARKER-' + code(i)]
  for (let n = 0; n < chunkLines; n += 1) {
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

// ---------- D 依赖针（边价值实验核心新增探针） ----------
// 选 3 个早期 chunk（2/5/8，对应 filler 轮 3/6/9，新近度最低、最易被剪）的 telemetry 统计作答案源。
// 答案 = 这 3 个 chunk 中「level=WARN 且 queue>40」行的 shard 并集（模型不被告知 chunk 号）。
const D_CHUNKS = [2, 5, 8]
function dChunkWarnShards(i: number): Set<number> {
  const s = new Set<number>()
  for (let n = 0; n < chunkLines; n += 1) {
    if (n % 13 === 0 && ((n * 3 + i) % 50) > 40) s.add((n + i) % 16)
  }
  return s
}
const dExpected = new Set<number>()
for (const i of D_CHUNKS) for (const sh of dChunkWarnShards(i)) dExpected.add(sh)
function dProbeText(): string {
  return 'Long-term memory cross-check. Earlier in this session you read several telemetry chunk files (logs/chunk-*.md). '
    + 'Across chunks ' + D_CHUNKS.join(', ') + ', find every line where level=WARN and queue>40, and list the shard numbers '
    + '(the "shard=N" field) that appear in those lines. If a chunk\'s content is no longer visible, recover it with recall_pruned '
    + '(the chunk file first line reads "chunk <n> telemetry export — incident ref INC-<n>-MARKER-xxxx"; use list_pruned if you do not know the seq). '
    + 'Reply with exactly one line: D-ANSWER: <space-separated sorted shard numbers, or NOT-RECOVERABLE if you cannot recover them>'
}

// ---------- 装配：模型（ARGP_MODEL_SOURCE 切换 deepseek / qwen-local）+ ArgpGraphEngine ----------
const ctx = new Context()
await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: 'spike-6 t-long archival persona' } })
await ctx.plugin(AgentLoop, { agents: [] })
const modelMount = await mountModel(ctx)
// 边价值实验 seam：citesOn=false（A₁/A₀）→ disableCiteEdges=true → 确定性无边，
// 与 A3 重放 clear 源一致；citesOn=true（A₂）→ 允许从模型 cites 块建语义边。
await ctx.plugin(ArgpGraphEngine, { windowTokens, retainTokens, maxPasses, disableCiteEdges: !citesOn })
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

const agent = ctx.agentLoop.create(SessionId('spike-6-tlong'), {
  provider: modelMount.provider,
  model: modelMount.model,
  reasoningEffort: modelMount.reasoning,
})
engine.setSession(agent.session)

ctx.on('agent/request-error', ({ failure }) => {
  console.log('[diag] request-error: ' + JSON.stringify({ code: failure.code, message: String(failure.message).slice(0, 300) }))
})
ctx.on('session/event', (session, event) => {
  if (session !== agent.session) return
  if (event.type === 'turn/end' || event.type === 'llm/retry') {
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

/** 探活：当前模型单请求 PONG（本地模式探 llama.cpp 端点）。 */
async function serverProbe(): Promise<boolean> {
  try {
    const apiKey = process.env['DEEPSEEK_API_KEY']
    if (apiKey === undefined || apiKey.length === 0) return false
    const endpoint = modelMount.reasoning === 'off' && process.env['ARGP_MODEL_SOURCE'] === 'qwen-local'
      ? (process.env['QWEN_BASE'] ?? 'http://127.0.0.1:8080/v1') + '/chat/completions'
      : 'https://api.deepseek.com/chat/completions'
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(120_000),
      body: JSON.stringify({ model: modelMount.model, messages: [{ role: 'user', content: 'Reply with exactly: PONG' }], max_tokens: 8 }),
    })
    return res.ok
  } catch {
    return false
  }
}

/** 单轮：followup + 等 idle；失败（turn/end reason=error）则探活后重试，最多 3 次。 */
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
      // 实测：错误后服务器被守护进程拉起但需重新载模（503 Loading model），等待覆盖重载窗口
      const waitMs = alive ? 15_000 : attempt === 1 ? 90_000 : 150_000
      console.log('[diag] turn failed (attempt ' + attempt + '/3); server probe=' + (alive ? 'alive' : 'unreachable/loading') + ', ' + Math.round(waitMs / 1000) + 's 后重试')
      await new Promise(r => setTimeout(r, waitMs))
    }
  }
  return false
}

// ---------- 任务编排：setup 1 + filler N + probe（默认 50 轮；可用 ARGP_MAX_TURNS 截短） ----------
const MAX_TURNS = Number(process.env['ARGP_MAX_TURNS'] ?? 50)
const PROBE_TURNS = [14, 20, 26, 32, 38, 44, 50].filter(t => t <= MAX_TURNS)
const NEEDLE_TURNS = [3, 6, 9, 12, 17, 23, 29] // 全局轮号，均为 filler 轮；probe k 针对 needle k
const setupText = 'We are starting a long-running archival session. From time to time I will hand you archival notes containing the service token of a node — keep them in mind. On most turns I will ask you to read a log file and report its line count; those are routine work. Occasionally I will send a long-term memory check; for those, follow the exact answer format given in the check itself. Work carefully.'
const fillerBody = (j: number): string => {
  const base = 'Use the read tool to read the entire file logs/chunk-' + j + '.md. After reading, reply with the file name, a space, and its line count.'
  return citesOn
    ? base + ' If your reply depends on earlier context (the file content, the instruction, an archival note), append the ARGP citation block as instructed.'
    : base
}
const probeText = (k: number): string =>
  'Long-term memory check ' + k + '. You need the first line of the chunk file that was read on the same turn as the archival note for node-' + k + '. That first line is not visible; recover it with recall_pruned before answering.\n'
  + 'To recover, call recall_pruned for each placeholder seq you are unsure about, one at a time, until you find the tool result whose text starts with "chunk <n> telemetry export". Copy the exact INC-<n>-MARKER-<code> from that recovered text. Do not guess.\n'
  + 'Reply with exactly two lines and nothing else, in this format:\n'
  + 'U-ANSWER: <the service token from my archival note for node-' + k + '>\n'
  + 'R-ANSWER: <the full incident reference marker from the first line of the chunk file you read on the same turn I gave you the archival note for node-' + k + '>\n'
  + 'If after trying recall_pruned for all placeholders you still cannot recover it, write NOT-RECOVERABLE on that line.'

type Item = { label: string; text: string; kind: 'setup' | 'filler' | 'probe' | 'dprobe'; probeK?: number; chunkIndex?: number; needleK?: number }
const items: Item[] = [{ label: 'setup', text: setupText, kind: 'setup' }]
let fillerIdx = 0
for (let turn = 2; turn <= MAX_TURNS; turn += 1) {
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
// D 依赖针：综合 3 早期 chunk 的 WARN&queue>40 shard 并集（独立探针，不进 U/R 曲线）
items.push({ label: 'dprobe', text: dProbeText(), kind: 'dprobe' })
// 期望值登记：probe k → needle k（U token + 同轮所读 chunk 的 R marker）
const expected = new Map<number, { u: string; r: string; chunkIndex: number }>()
for (const item of items) {
  if (item.kind === 'filler' && item.needleK !== undefined) {
    const j = item.chunkIndex as number
    expected.set(item.needleK, { u: uToken(item.needleK), r: 'INC-' + j + '-MARKER-' + code(j), chunkIndex: j })
  }
}

const startedAt = Date.now()
const turnLog: { label: string; ok: boolean; boundariesAfter: number; seconds: number }[] = []
let consecutiveFailedTurns = 0
let aborted = false
for (const item of items) {
  const turnStart = Date.now()
  const ok = await runTurn(item.text)
  turnLog.push({ label: item.label, ok, boundariesAfter: engine.records.length, seconds: Math.round((Date.now() - turnStart) / 1000) })
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
    + '; boundaries=' + engine.records.length)
}

const events = [...agent.session.events]

// turn 映射（判决用）：与 spike 5 同源逻辑——按文案 marker 匹配 user/message（无 turn 字段），
// 取该 seq 之前最近一个 turn/start 为所属轮；重试的重复消息取最后一次（成功轮）。
const promptMarkers = new Map<string, string>([
  ['setup', 'long-running archival session'],
  ...items.filter(i => i.kind === 'filler').map(i => [i.label, 'logs/chunk-' + String(i.chunkIndex) + '.md'] as [string, string]),
  ...items.filter(i => i.kind === 'probe').map(i => [i.label, 'Long-term memory check ' + String(i.probeK)] as [string, string]),
  ['dprobe', 'Long-term memory cross-check'],
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

/** 从单个事件提取模型可见文本（离线判决用）。 */
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

/** 从 surface 推导 LLM 消息并按块形状扫描孤儿（同 spike 2/4/5）。 */
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

// ---------- L1：长程稳定（轮次完成 + 事务量 + 配对 + 事务完整） ----------
const completedTurns = turnLog.filter(t => t.ok).length
const orphans = orphanReport()
const starts = events.filter(e => e.type === 'compaction/start').length
const summaries = events.filter(e => e.type === 'compaction/summary' || e.type === 'compaction/prune').length
const ends = events.filter(e => e.type === 'compaction/end')
const endsWithError = ends.filter(e => (e.data as { error?: string }).error !== undefined).length
const checkpointOk = engine.records.every(r => r.intervals.every(iv => {
  const event = agent.session.events[iv.tombstoneSeq] as { type?: string; data?: { source?: { kind?: string; plugin?: string }; message?: { content?: { content?: { text?: string }[] }[] } } } | undefined
  if (event === undefined) return false
  // 两种合法墓碑：①user/message compact checkpoint（source.plugin='compact'）；
  // ②tool/result 占位墓碑（半拆组 2026-08-23：克隆原 R + elided 文本，无 plugin source）
  if (event.type === 'user/message') {
    const src = event.data?.source
    return src?.kind === 'plugin' && src?.plugin === 'compact'
  }
  if (event.type === 'tool/result') {
    const text = event.data?.message?.content?.[0]?.content?.[0]?.text
    return typeof text === 'string' && text.startsWith('[elided')
  }
  return false
}))
verdict('L1-long-run-stable', !aborted && completedTurns === items.length && engine.records.length >= minBoundaries
  && orphans.length === 0 && starts === engine.records.length && summaries === engine.records.length
  && ends.length === engine.records.length && endsWithError === 0 && checkpointOk,
  'turns=' + completedTurns + '/' + items.length + (aborted ? ' (aborted)' : '')
  + '; boundaries=' + engine.records.length + '; orphans=' + orphans.length
  + '; tx start/summary/end=' + starts + '/' + summaries + '/' + ends.length + ' (error=' + endsWithError
  + '); checkpoint source=compact:' + checkpointOk)

// ---------- 误差曲线：逐 probe 判 U/R 两针 ----------
const shadowedAll = new Set(engine.records.flatMap(r => r.shadowedSeqs))
interface CurvePoint {
  probe: number; turn: number; boundaries: number
  uCorrect: boolean; rCorrect: boolean; targetChunkIndex: number; targetShadowed: boolean
  recallCallsAtProbe: number; uAnswer: string; rAnswer: string
}
const curve: CurvePoint[] = []
// recall 归属（修正）：实测 engine.recallCalls 的增量口径不可靠（本次跑出 21/0/…/0 与事件流
// 每 probe 轮 3 次矛盾），改按事件流计：probe 轮内 recall_pruned 的 tool/call 次数与命中。
const recallToolCalls = events.filter(e => e.type === 'tool/call' && (e.data as { name?: string }).name === 'recall_pruned')
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
  // 目标 chunk 的 tool/result seq：事件文本含 marker 者；是否已遮蔽
  const markerNeedle = 'INC-' + exp.chunkIndex + '-MARKER-' + code(exp.chunkIndex)
  const targetSeqs = events.filter(e => e.type === 'tool/result' && eventRawText(e).includes(markerNeedle)).map(e => e.seq)
  const targetShadowed = targetSeqs.length > 0 && targetSeqs.every(seq => shadowedAll.has(seq))
  const boundariesAtProbe = turnLog.find(t => t.label === item.label)?.boundariesAfter ?? engine.records.length
  const probeRecalls = recallToolCalls.filter(e => (e.data as { turn?: number }).turn === turn)
  curve.push({
    probe: k, turn, boundaries: boundariesAtProbe,
    uCorrect: uAnswer === exp.u, rCorrect: rAnswer === exp.r,
    targetChunkIndex: exp.chunkIndex, targetShadowed,
    recallCallsAtProbe: probeRecalls.length,
    uAnswer, rAnswer,
  })
  console.log('[probe ' + k + '] boundaries=' + boundariesAtProbe + ' U=' + (uAnswer === exp.u ? 'OK' : 'MISS(' + uAnswer + ')')
    + ' R=' + (rAnswer === exp.r ? 'OK' : 'MISS(' + rAnswer + ')') + ' shadowed=' + targetShadowed)
}
const uCorrectCount = curve.filter(p => p.uCorrect).length
const rCorrectCount = curve.filter(p => p.rCorrect).length
verdict('L2-u-protection', uCorrectCount >= 6,
  'U probes correct ' + uCorrectCount + '/' + curve.length + '（U 针永不参剪，surface 直读）')
verdict('L3-r-recovery', rCorrectCount >= 4,
  'R probes correct ' + rCorrectCount + '/' + curve.length + '（目标 chunk 已遮蔽 ' + curve.filter(p => p.targetShadowed).length
  + '/' + curve.length + '；recall 调用总量 ' + engine.recallCalls.length
  + '，命中 ' + engine.recallCalls.filter(c => c.hit).length + '）')
console.log('[METRIC error-curve] ' + JSON.stringify(curve.map(p => ({ probe: p.probe, b: p.boundaries, u: p.uCorrect ? 1 : 0, r: p.rCorrect ? 1 : 0, sh: p.targetShadowed ? 1 : 0 }))))

// ---------- D 依赖针评估（综合 ≥3 个 R 原子；模型不被告知 chunk 号） ----------
const dTurn = turnOf.get('dprobe') ?? -1
const dRaw = events.filter(e => e.type === 'assistant/message' && (e.data as { turn?: number }).turn === dTurn).map(e => eventRawText(e)).join('\n')
const dMatch = dRaw.match(/D-ANSWER:\s*([0-9\s]+|NOT-RECOVERABLE)/i)
const dAnswerRaw = dMatch?.[1]?.trim() ?? ''
const dCorrect = dAnswerRaw !== 'NOT-RECOVERABLE' && (() => {
  const got = new Set(dAnswerRaw.split(/\s+/).filter(Boolean).map(Number))
  if (got.size !== dExpected.size) return false
  for (const sh of dExpected) if (!got.has(sh)) return false
  return true
})()
// 有效性预检：D 针目标 chunk 的 tool/result 是否已被遮蔽（无边时须被剪 → 探针有鉴别力；oracle 边须保留）
const dMarkerNeedles = D_CHUNKS.map(i => 'INC-' + i + '-MARKER-' + code(i))
const dTargetSeqs = events.filter(e => e.type === 'tool/result' && dMarkerNeedles.some(m => eventRawText(e).includes(m))).map(e => e.seq)
const dTargetShadowed = dTargetSeqs.length > 0 && dTargetSeqs.every(seq => shadowedAll.has(seq))
verdict('L4-d-cross-retention', dCorrect && dTargetShadowed,
  'D probe correct ' + (dCorrect ? 'yes' : 'no(' + dAnswerRaw + ')') + '; expected shards=' + [...dExpected].sort((a, b) => a - b).join(',')
  + '; target chunks shadowed=' + dTargetShadowed + ' (' + dTargetSeqs.length + ' seqs)')
console.log('[dprobe] D=' + (dCorrect ? 'OK' : 'MISS(' + dAnswerRaw + ')') + ' expected=' + [...dExpected].sort((a, b) => a - b).join(',') + ' targetShadowed=' + dTargetShadowed)

// ---------- 统计与产物落盘 ----------
const reasoningChars = events.filter(e => e.type === 'assistant/message').reduce((sum, e) => {
  const content = (e.data as { message: { content: { type: string; text?: string }[] } }).message?.content ?? []
  return sum + content.filter(b => b.type === 'reasoning').reduce((s, b) => s + (b.text?.length ?? 0), 0)
}, 0)
const surfaceChars = [...agent.session.surface.nodes].reduce((sum, seq) => {
  const ev = agent.session.events[seq]
  return sum + (ev === undefined ? 0 : eventRawText(ev).length)
}, 0)
const result = {
  spike: runName,
  at: new Date().toISOString(),
  model: modelMount.model,
  windowTokens,
  retainTokens,
  maxPasses,
  minBoundaries,
  wallSeconds: Math.round((Date.now() - startedAt) / 1000),
  turnsPlanned: items.length,
  turnsCompleted: completedTurns,
  aborted,
  pruneTransactions: engine.records.length,
  shadowedNodes: engine.records.reduce((sum, r) => sum + r.shadowedSeqs.length, 0),
  curve,
  uCorrect: uCorrectCount,
  rCorrect: rCorrectCount,
  citesOn,
  dCorrect,
  dExpected: [...dExpected].sort((a, b) => a - b),
  dTargetShadowed,
  recallCalls: engine.recallCalls,
  citeStats: engine.citeStats,
  reasoningChars,
  surfaceCharsEnd: surfaceChars,
  surfaceTokensEndApprox: Math.ceil(surfaceChars / 3.5),
  turnStats,
  turnLog,
  records: engine.records,
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
  ? 'SPIKE 6 VERDICT: PASS（t-long 50 轮长程：稳定 + U 保护 + R 找回）'
  : 'SPIKE 6 VERDICT: FAIL（' + failures.length + ' 项未过：' + failures.join('; ') + '）')
process.exit(failures.length === 0 ? 0 : 1)
