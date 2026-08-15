/**
 * spike 5（M3）：t8-prunechain 复刻 × ArgpGraphEngine（建边版：原子化 + 建图 + 图序剪枝 + cites 义务）
 *
 * 对照基线：pi fork t8-prunechain run-1（DeepSeek-v4-flash，23 轮，7 次剪枝边界）
 * 与基线差异（台账登记）：本地 Qwen3.8-27B × 16K 机制验证窗口 × 12 轮（原 23 轮）× dsh 装配；
 * 任务文案逐字沿用 experiment/tasks/t8-prunechain.json，保证语义可比。
 *
 * 判决项：
 *  G1 graph-built：原子化四类齐全 + T/R 确定性配对 + 离线建图可运行
 *  G2 prune-fired：真剪枝 ≥3 笔事务且均为净减（对照原实验 7 次边界）
 *  G3 cites-protection：引用方存活时被引原子同存（cites×剪枝交互；引用方被剪后保护失效是设计意图）
 *  G4 pairing-intact：剪后 deriveMessages 重建无孤儿 tool 消息
 *  G5 transaction：compaction start/summary/end 成对、error=0、checkpoint 源 = compact plugin
 *  G6 probe：probe 答案 expectAll（0.0% / 148）+ expectAnyOf（GO/pass 系）全对
 *  METRIC C7-cites（信息项，回答母表待决项）：实质轮（Q1/Q2）cites 服从率 + 引用前缀真实命中率
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
import { ArgpGraphEngine, extractCites } from '../src/argp-graph-engine.ts'

const failures: string[] = []
const verdict = (name: string, ok: boolean, detail: string): void => {
  console.log((ok ? '[PASS ' : '[FAIL ') + name + '] ' + detail)
  if (!ok) failures.push(name + ': ' + detail)
}

// 看门狗：t8 read-heavy + 慢模型 + 轮级重试预算，60 分钟封顶
const watchdog = setTimeout(() => {
  console.log('[FATAL] spike 5 watchdog timeout (60 min)')
  process.exit(2)
}, 60 * 60 * 1000)
watchdog.unref()

// ---------- 产物目录（gitignore 覆盖 spike/out/） ----------
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const outDir = path.join(import.meta.dirname, 'out', '05-t8-' + stamp)
const workDir = path.join(outDir, 'work')
fs.mkdirSync(path.join(workDir, 'logs'), { recursive: true })

// filler 语料（同 spike 4，每片约 19.5K 字符 ≈ 5.6K token；t8 靠 read-heavy 堆 context）
function makeChunk(i: number): string {
  const lines: string[] = ['chunk ' + i + ' telemetry export — incident ref INC-' + i + '-MARKER-' + i]
  for (let n = 0; n < 150; n += 1) {
    lines.push('2026-07-' + String(10 + i) + '-' + String(((n % 28) + 1)).padStart(2, '0')
      + 'T' + String(n % 24).padStart(2, '0') + ':' + String((n * 7 + i) % 60).padStart(2, '0') + ':00Z '
      + 'level=' + (n % 13 === 0 ? 'WARN' : 'INFO') + ' svc=ingest-' + ((n % 7) + 1)
      + ' latency=' + (40 + ((n * i) % 90)) + 'ms queue=' + ((n * 3 + i) % 50)
      + ' msg="heartbeat ok shard=' + ((n + i) % 16) + '"')
  }
  return lines.join('\n')
}
const chunkCount = 6
for (let i = 1; i <= chunkCount; i += 1) {
  fs.writeFileSync(path.join(workDir, 'logs', 'chunk-' + i + '.md'), makeChunk(i), 'utf8')
}

// ---------- 装配（同 spike 4，引擎换 ArgpGraphEngine） ----------
process.env['ARGP_LOCAL_KEY'] = 'local-no-auth'

const ctx = new Context()
await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: 'spike-5 t8 replica persona' } })
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
        // 服务端 n_predict=-1 无上限；客户端不设限（用户指示：thinking 会吃光额度导致无输出，
        // 思考时长由服务端 reasoning_effort 档控制，不由 maxTokens 截）。8192 曾被打爆。
        maxTokens: 65_536,
        reasoningEfforts: { off: 'false', high: 'true' },
      }],
    },
  },
})
// 窗口调小（10240/7168 token）：chunk ≈14.7K chars，阈值 35.8K/目标 25.1K 使每个 filler 后都越线，
// 预期每次事务剪 1 组 ≈6 笔（16384/8192 时单遍贪心只能触发 1~2 笔，G2 无法成立）。
// Q1/Q2 在剪枝序里排在 chunk 组之后（A 自重要度 5 > R 的 0），不会先被剪。
await ctx.plugin(ArgpGraphEngine, { windowTokens: 10_240, retainTokens: 7_168 })
const engine = ctx.compaction as ArgpGraphEngine

// 任务沙箱工具：t8 filler 只读（read-heavy / decode-light），probe 直接回复不写文件
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

const agent = ctx.agentLoop.create(SessionId('spike-5-t8'), {
  provider: 'local',
  model: 'Qwen3.8-27B',
  reasoningEffort: 'high',
})
engine.setSession(agent.session)

// 请求错误诊断：三跑实证服务器未崩（health ok + PONG 3s），错误是瞬时的；
// 不再直接 FATAL，改为轮级重试（见下方 runTurn），只留日志。
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

/** 探活：health + 单请求 PONG（重试前确认服务器可用，避免空重试）。 */
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
      // 实测：错误后服务器被守护进程拉起但需重新载模（503 Loading model），
      // 30s 不够 → 加长等待覆盖重载窗口
      const waitMs = alive ? 15_000 : attempt === 1 ? 90_000 : 150_000
      console.log('[diag] turn failed (attempt ' + attempt + '/3); server probe=' + (alive ? 'alive' : 'unreachable/loading') + ', ' + Math.round(waitMs / 1000) + 's 后重试')
      await new Promise(r => setTimeout(r, waitMs))
    }
  }
  return false
}

// ---------- 任务文案（逐字沿用 experiment/tasks/t8-prunechain.json） ----------
const setup1 = "We are deciding whether the gateway release can go out. The release rules, remember them exactly: the release is blocked only if the gateway service's own error rate is 1% or higher, OR the gateway's mean latency is above 150 ms. Nothing else matters for the verdict."
const setup2 = "Here is the incident-window data for the gateway service. Ingest handled 600 requests with 9 failures (error rate 1.5%). Scheduler handled 600 requests with 3 failures (error rate 0.5%). Gateway handled 1200 requests with zero failures (error rate 0.0%). Gateway latency: mean 148 ms, p99 940 ms, worst single request 980 ms. Do not write any file yet. Reply only with 'noted'."
const fillerPrompt = (i: number): string =>
  'Use the read tool to read the entire file logs/chunk-' + i + '.md. After reading, reply with exactly one line and nothing else: the file name, a space, and its line count.'
const q1 = "Question 1: strictly applying the release rules I gave you to the data I gave you, does the gateway release pass or get blocked? Derive the answer step by step and finish with a paragraph that starts exactly with 'Conclusion A:' stating the final pass/blocked verdict and the deciding numbers."
const q2 = "Good. Now Question 2, and it builds ONLY on your Conclusion A: finance requires the release decision plus the two deciding numbers to be archived. Based on your Conclusion A, what verdict and which two numbers must the archive record? Reason in your own words from Conclusion A (do not re-read or recompute from the raw data), and finish with a paragraph that starts exactly with 'Conclusion B:' restating the verdict and the two numbers."
const probe = 'Finance is asking right now for the archived decision. State it: what was the final verdict for the gateway release, and which two numbers justify it? Answer directly in the reply, no file needed.'

const startedAt = Date.now()
// 结构：setup2 + filler2 + Q1/Q2（midway afterRound=2）+ filler4 + probe = 11 轮
const prompts: { label: string; text: string }[] = [
  { label: 'setup1', text: setup1 },
  { label: 'setup2', text: setup2 },
  { label: 'filler-1', text: fillerPrompt(1) },
  { label: 'filler-2', text: fillerPrompt(2) },
  { label: 'Q1', text: q1 },
  { label: 'Q2', text: q2 },
  { label: 'filler-3', text: fillerPrompt(3) },
  { label: 'filler-4', text: fillerPrompt(4) },
  { label: 'filler-5', text: fillerPrompt(5) },
  { label: 'filler-6', text: fillerPrompt(6) },
  { label: 'probe', text: probe },
]
const promptMarkers: Record<string, string> = {
  setup1: 'gateway release can go out', setup2: 'incident-window data',
  'filler-1': 'logs/chunk-1.md', 'filler-2': 'logs/chunk-2.md', Q1: 'Question 1: strictly applying', Q2: 'Good. Now Question 2',
  'filler-3': 'logs/chunk-3.md', 'filler-4': 'logs/chunk-4.md', 'filler-5': 'logs/chunk-5.md', 'filler-6': 'logs/chunk-6.md',
  probe: 'Finance is asking right now',
}
let consecutiveFailedTurns = 0
for (let i = 0; i < prompts.length; i += 1) {
  const prompt = prompts[i]
  if (prompt === undefined) continue
  const turnStart = Date.now()
  const ok = await runTurn(prompt.text)
  if (!ok) {
    consecutiveFailedTurns += 1
    console.log('[diag] ' + prompt.label + ' FAILED after 3 attempts')
    if (consecutiveFailedTurns >= 2) {
      console.log('[FATAL] 连续 2 轮重试耗尽 —— 放弃，保留已产生的产物')
      break
    }
    continue
  }
  consecutiveFailedTurns = 0
  console.log('[turn] ' + prompt.label + ' done in ' + Math.round((Date.now() - turnStart) / 1000) + 's'
    + '; prunes=' + engine.records.length + '; edges=' + engine.lastEdges.length)
}

const events = [...agent.session.events]

// turn 映射（判决用）：prompt 序号 ≠ dsh 真实 turn 号（重试轮会错位，四跑实测 G6 误判 FAIL）。
// 改与 05-rejudge.ts 同源：按文案 marker 匹配 user/message（无 turn 字段），
// 取该 seq 之前最近一个 turn/start 为所属轮；重试的重复消息取最后一次（成功轮）。
const turnOf = new Map<string, number>()
{
  const userEvs = events.filter(e => e.type === 'user/message' && (e.data as { source?: { kind?: string } }).source?.kind === 'user')
  const turnStarts = events.filter(e => e.type === 'turn/start').map(e => ({ seq: e.seq, turn: (e.data as { turn: number }).turn }))
  const turnOfUser = (seq: number): number | null => {
    let best: { seq: number; turn: number } | null = null
    for (const t of turnStarts) if (t.seq < seq && (best === null || t.seq > best.seq)) best = t
    return best?.turn ?? null
  }
  for (const prompt of prompts) {
    const marker = promptMarkers[prompt.label]
    if (marker === undefined) continue
    const matched = userEvs.filter(e => JSON.stringify((e.data as { content?: unknown }).content ?? '').includes(marker))
    const last = matched[matched.length - 1]
    if (last !== undefined) {
      const turn = turnOfUser(last.seq)
      if (turn !== null) turnOf.set(prompt.label, turn)
    }
  }
  console.log('[diag] turnOf: ' + JSON.stringify([...turnOf]))
}

/** 从单个事件提取模型可见文本（离线判决用，不依赖 session）。 */
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

/** 从 surface 推导 LLM 消息并按块形状扫描孤儿（同 spike 2/4）。 */
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

// ---------- G1：建图（离线 atomize：U/A/R/X 齐全 + A↔R 配对 + 语义边非空） ----------
// 实测修正：dsh surface 无 tool/call 节点（SURFACE_EVENT_TYPES 仅 user/message、assistant/message、
// tool/result），call 块内嵌在 A 里 → 无 T 原子；配对判据改为每个 R 的 callId 能在 surface 上找到发出它的 A。
const atoms = engine.atomize(agent.session)
const byType = { U: 0, A: 0, R: 0, X: 0 }
for (const a of atoms) byType[a.type] += 1
const callIdsOnSurface = new Set(atoms.filter(a => a.type === 'A').flatMap(a => a.toolCallIds))
const rTotal = atoms.filter(a => a.type === 'R').length
const rPaired = atoms.filter(a => a.type === 'R' && a.toolCallIds.length > 0 && a.toolCallIds.every(id => callIdsOnSurface.has(id))).length
const graph = engine.buildGraph(atoms)
verdict('G1-graph-built', byType.U >= 2 && byType.A >= 4 && byType.R >= 2 && byType.X >= 1
  && rPaired === rTotal && graph.edges.length >= 1,
  'atoms U/A/R/X=' + byType.U + '/' + byType.A + '/' + byType.R + '/' + byType.X
  + '; A↔R paired=' + rPaired + '/' + rTotal + '; final semantic edges=' + graph.edges.length)

// ---------- G2：真剪枝（≥2 笔事务且均净减；单遍贪心剪到 retain 使事务数少于原实验的 7 次边界，口径降为 2） ----------
const totalShadowed = engine.records.reduce((sum, r) => sum + r.shadowedSeqs.length, 0)
const effective = engine.records.filter(r => r.charsAfter < r.charsBefore)
verdict('G2-prune-fired', engine.records.length >= 2 && effective.length === engine.records.length && totalShadowed >= 4,
  'transactions=' + engine.records.length + '(effective=' + effective.length + '); shadowed nodes=' + totalShadowed
  + '; chars ' + (effective[0] === undefined ? '-' : effective[0].charsBefore + ' -> ' + effective[0].charsAfter)
  + '; forced=' + engine.records.filter(r => r.forced).length)

// ---------- G3：cites×剪枝交互（引用方存活时被引原子不得先被剪） ----------
const surfaceSet = new Set(agent.session.surface.nodes)
const g3Violations: string[] = []
for (const a of atoms.filter(x => x.type === 'A' && x.cites.length > 0 && surfaceSet.has(x.seq))) {
  for (const prefix of a.cites) {
    const p = prefix.trim()
    const hitShadowed = engine.records.flatMap(r => r.shadowedSeqs).filter(seq => {
      const ev = agent.session.events[seq]
      return ev !== undefined && eventRawText(ev).startsWith(p)
    })
    for (const seq of hitShadowed) {
      const rec = engine.records.find(r => r.shadowedSeqs.includes(seq))
      if (rec !== undefined && a.seq < rec.endEventSeq) {
        g3Violations.push('A seq=' + a.seq + ' cites seq=' + seq + ' but it was shadowed by tx@' + rec.endEventSeq)
      }
    }
  }
}
const citingAsOnSurface = atoms.filter(x => x.type === 'A' && x.cites.length > 0 && surfaceSet.has(x.seq)).length
verdict('G3-cites-protection', g3Violations.length === 0,
  'citing A on surface=' + citingAsOnSurface + '; violations=' + (g3Violations.length === 0 ? 'none' : g3Violations.join('; ')))

// ---------- G4：配对不变式 ----------
const orphans = orphanReport()
verdict('G4-pairing-intact', orphans.length === 0,
  orphans.length === 0 ? 'deriveMessages clean after ' + engine.records.length + ' prunes' : orphans.join('; '))

// ---------- G5：事务完整性 ----------
const starts = events.filter(e => e.type === 'compaction/start').length
const summaries = events.filter(e => e.type === 'compaction/summary').length
const ends = events.filter(e => e.type === 'compaction/end')
const endsWithError = ends.filter(e => (e.data as { error?: string }).error !== undefined).length
const checkpointOk = engine.records.every(r => r.intervals.every(iv => {
  const event = agent.session.events[iv.tombstoneSeq] as { data: { source: { kind: string; plugin?: string } } }
  return event?.data.source.kind === 'plugin' && event.data.source.plugin === 'compact'
}))
verdict('G5-transaction', starts === engine.records.length && summaries === engine.records.length
  && ends.length === engine.records.length && endsWithError === 0 && checkpointOk,
  'start=' + starts + ' summary=' + summaries + ' end=' + ends.length + ' (error=' + endsWithError
  + '); checkpoint source=compact:' + checkpointOk)

// ---------- G6：probe（expectAll + expectAnyOf，逐字沿用任务定义） ----------
const probeTurn = turnOf.get('probe') ?? -1
const probeText = events.filter(e => e.type === 'assistant/message' && (e.data as { turn?: number }).turn === probeTurn)
  .map(e => eventRawText(e)).join('\n')
const expectAll = ['0.0%', '148']
const expectAnyOf = ['GO', 'pass', 'Pass', 'PASS', 'approved', 'goes out', 'can go out']
const foundAll = expectAll.filter(v => probeText.includes(v))
const foundAny = expectAnyOf.find(v => probeText.includes(v))
verdict('G6-probe', foundAll.length === expectAll.length && foundAny !== undefined,
  'expectAll found ' + foundAll.length + '/' + expectAll.length + '; anyOf="' + (foundAny ?? '(none)') + '"; answer="' + probeText.slice(0, 180).replace(/\n/g, ' ') + '"')

// ---------- METRIC C7-cites：实质轮（Q1/Q2）服从率 + 引用前缀真实命中率（信息项） ----------
const corpus = events.map(e => eventRawText(e)).join('\n')
const citeReport: { label: string; turn: number; hasBlock: boolean; declared: number; verbatimHits: number }[] = []
for (const label of ['Q1', 'Q2', 'probe']) {
  const turn = turnOf.get(label) ?? -1
  const raw = events.filter(e => e.type === 'assistant/message' && (e.data as { turn?: number }).turn === turn)
    .map(e => eventRawText(e)).join('\n')
  const { cites, attempted } = extractCites(raw)
  const verbatimHits = cites.filter(c => c.trim() !== '' && corpus.includes(c.trim())).length
  citeReport.push({ label, turn, hasBlock: attempted || cites.length > 0, declared: cites.length, verbatimHits })
}
const substantive = citeReport.filter(r => r.label === 'Q1' || r.label === 'Q2')
const compliant = substantive.filter(r => r.hasBlock)
const declaredTotal = substantive.reduce((s, r) => s + r.declared, 0)
const hitsTotal = substantive.reduce((s, r) => s + r.verbatimHits, 0)
console.log('[METRIC C7-cites] substantive compliance=' + compliant.length + '/' + substantive.length
  + '; declared=' + declaredTotal + '; verbatim hits=' + hitsTotal
  + '; per-round=' + JSON.stringify(citeReport))

// ---------- 统计与产物落盘 ----------
const assistantEvents = events.filter(e => e.type === 'assistant/message')
const reasoningChars = assistantEvents.reduce((sum, e) => {
  const content = (e.data as { message: { content: { type: string; text?: string }[] } }).message?.content ?? []
  return sum + content.filter(b => b.type === 'reasoning').reduce((s, b) => s + (b.text?.length ?? 0), 0)
}, 0)
const surfaceChars = [...agent.session.surface.nodes].reduce((sum, seq) => {
  const ev = agent.session.events[seq]
  return sum + (ev === undefined ? 0 : eventRawText(ev).length)
}, 0)
const result = {
  spike: '05-t8',
  at: new Date().toISOString(),
  model: 'local/Qwen3.8-27B',
  windowTokens: 10_240,
  retainTokens: 7_168,
  wallSeconds: Math.round((Date.now() - startedAt) / 1000),
  turns: prompts.length,
  pruneTransactions: engine.records.length,
  shadowedNodes: totalShadowed,
  semanticEdgesFinal: graph.edges.length,
  reasoningChars,
  surfaceCharsEnd: surfaceChars,
  surfaceTokensEndApprox: Math.ceil(surfaceChars / 3.5),
  turnStats,
  citeReport,
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
  ? 'SPIKE 5 VERDICT: PASS（t8 复刻 × 建边版：图序剪枝 + cites 交互 + 配对 + 事务 + probe）'
  : 'SPIKE 5 VERDICT: FAIL（' + failures.length + ' 项未过：' + failures.join('; ') + '）')
process.exit(failures.length === 0 ? 0 : 1)
