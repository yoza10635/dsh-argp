/**
 * spike 4（M2）：t1-credentials 复刻 × ArgpT1Engine（16K 压缩窗口机制验证版）
 *
 * 对照基线：experiment/runs/C-argp/t1-credentials/run-10（pi fork，deepseek-v4-flash，120K 窗口，21 轮）
 * 与 run-10 的差异（台账登记）：本地 Qwen3.8-27B × 16K 机制验证窗口 × dsh 装配；
 * 任务文案逐字沿用 experiment/tasks/t1-credentials.json，保证语义可比。
 *
 * 判决项：
 *  V1 prune-fired：真剪枝发生（records ≥1、shadowed 节点 ≥2、surface 字符回收）
 *  V2 pairing-intact：剪后 deriveMessages 重建无孤儿 tool 消息（配对不变式）
 *  V3 u-protection：needle U（setup 轮 user 节点）永不遮蔽且仍在 surface
 *  V4 transaction：compaction start/summary/end 成对且 error=0，checkpoint 源 = compact plugin
 *  V5 recall-loop：shadowed seq 从 append-only 日志找回原文（含 chunk marker）
 *  V6 retention：probe 写出 deploy/prod.json 三件套全对（对应 run-10 retention 语义）
 *  METRIC C7（信息项，不计入总判决）：recall 探针轮的自发 recall_pruned 调用与答案正确性，
 *  作为新模型服从率基线（母表 C7）
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
import { ArgpT1Engine } from '../src/argp-t1-engine.ts'

const failures: string[] = []
const verdict = (name: string, ok: boolean, detail: string): void => {
  console.log((ok ? '[PASS ' : '[FAIL ') + name + '] ' + detail)
  if (!ok) failures.push(name + ': ' + detail)
}

// 看门狗：本地慢模型 + 单并发，25 分钟封顶（服务器挂死时避免无声卡住）
const watchdog = setTimeout(() => {
  console.log('[FATAL] spike 4 watchdog timeout (25 min) — 大概率 llama-server 又挂了')
  process.exit(2)
}, 25 * 60 * 1000)
watchdog.unref()

// ---------- 产物目录（原始数据位置，登记台账用；gitignore 覆盖 spike/out/） ----------
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const outDir = path.join(import.meta.dirname, 'out', '04-t1-' + stamp)
const workDir = path.join(outDir, 'work')
fs.mkdirSync(path.join(workDir, 'logs'), { recursive: true })

// filler 语料（对照原实验 chunkChars 的机制验证缩小版，每片约 19.5K 字符 ≈ 5.6K token）
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

// ---------- 装配 ----------
// 本地 llama-server 无鉴权，但 pi-ai 对手工路由强制要求凭据：给个哑值（spike 4a 已钉死）
process.env['ARGP_LOCAL_KEY'] = 'local-no-auth'

const ctx = new Context()
// mountAgentLoopTestDependencies 内部已挂 LlmRuntime，勿重复
await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: 'spike-4 t1 replica persona' } })
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
        // 服务端 --reasoning-budget 16384：maxTokens 需给 thinking 与回答共同留足空间
        maxTokens: 8192,
        reasoningEfforts: { off: 'false', high: 'true' },
      }],
    },
  },
})
await ctx.plugin(ArgpT1Engine, { windowTokens: 16_384, retainTokens: 8_192 })
const engine = ctx.compaction as ArgpT1Engine

// 任务沙箱工具：read_file / write_file（限 workDir，probe 需 write）
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
ctx.tools.register(defineTool({
  name: 'write_file',
  description: 'Write text content to a file by path relative to the task working directory, creating parent directories as needed.',
  parameters: {
    path: { type: 'string', description: 'file path relative to the working directory' },
    content: { type: 'string', description: 'full file content to write' },
  },
  output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
  execute: async (args): Promise<string> => {
    const input = args as { path?: string; content?: string }
    if (input.path === undefined || input.path === '') return 'write_file: missing path'
    const target = sandbox(input.path)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, input.content ?? '', 'utf8')
    return 'write_file: wrote ' + (input.content ?? '').length + ' chars to ' + input.path
  },
}))

const agent = ctx.agentLoop.create(SessionId('spike-4-t1'), {
  provider: 'local',
  model: 'Qwen3.8-27B',
  reasoningEffort: 'high',
})
engine.setSession(agent.session)

// 诊断与统计监听（同 spike 4a）
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

// ---------- 任务文案（逐字沿用 experiment/tasks/t1-credentials.json） ----------
const setup1 = "We are preparing the ops console deployment. I'm telling you three parameters verbally, do not write them to any file, just remember them: (1) the database password is ZEBRA-9417; (2) the service listens on port 8471; (3) the backup mirror domain is mirror-3.internal.example. Reply only with 'noted'."
const setup2 = "Good. Also note: the log files under ./logs contain raw telemetry from last week's incident. I need you to triage them one by one later. For now just reply 'ready'."
const fillerPrompt = (i: number): string =>
  'Read the file logs/chunk-' + i + '.md and summarize its content in ONE short sentence. Do not write any file.'
const probe = "The deployment was just approved by the security team. I now explicitly lift the earlier 'do not write them to any file' restriction for those three parameters: you are authorized to persist them. Write the deployment config file deploy/prod.json. It must contain exactly three fields: \"dbPassword\" with the database password I told you at the start of this session, \"port\" with the service port I told you, and \"backupMirror\" with the backup mirror domain I told you. Use the write tool to create the file, then reply 'done'."
// recall 探针（新增，非原任务）：chunk-2 应已被剪，度量契约服从与 recall 可用性
const recallProbe = 'Before rollout, one audit question: what was the incident reference id mentioned in logs/chunk-2.md? Answer in one short line.'

const startedAt = Date.now()
const prompts: { label: string; text: string }[] = [
  { label: 'setup1', text: setup1 },
  { label: 'setup2', text: setup2 },
  ...Array.from({ length: chunkCount }, (_, k) => ({ label: 'filler-' + (k + 1), text: fillerPrompt(k + 1) })),
  { label: 'probe', text: probe },
  { label: 'recall-probe', text: recallProbe },
]

const recallCallsBeforeRecallProbe = { value: 0 }
for (const prompt of prompts) {
  const turnStart = Date.now()
  if (prompt.label === 'recall-probe') recallCallsBeforeRecallProbe.value = engine.recallCalls.length
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: prompt.text }],
    source: { kind: 'user' },
  }))
  await waitForIdle(agent)
  console.log('[turn] ' + prompt.label + ' done in ' + Math.round((Date.now() - turnStart) / 1000) + 's'
    + '; surface~' + engine.estimateTokens(agent.session) + ' tokens; prunes=' + engine.records.length)
}

const events = [...agent.session.events]

/** 从 surface 推导 LLM 消息并按块形状扫描孤儿（同 spike 2）。 */
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

// ---------- V1：真剪枝发生（看有效事务：剪后可见量净减） ----------
const totalShadowed = engine.records.reduce((sum, r) => sum + r.shadowedSeqs.length, 0)
const effective = engine.records.filter(r => r.charsAfter < r.charsBefore)
const first = effective[0]
verdict('V1-prune-fired', effective.length >= 1 && totalShadowed >= 2
  && first !== undefined && (first.charsBefore - first.charsAfter) > 1000,
  'transactions=' + engine.records.length + '(effective=' + effective.length + '); shadowed nodes=' + totalShadowed
  + (first !== undefined ? '; first effective prune chars ' + first.charsBefore + ' -> ' + first.charsAfter : ''))

// ---------- V2：配对不变式 ----------
const orphans = orphanReport()
verdict('V2-pairing-intact', orphans.length === 0,
  orphans.length === 0 ? 'deriveMessages clean after ' + engine.records.length + ' prunes' : orphans.join('; '))

// ---------- V3：U 载体保护（user/message 事件 data = { content, source, role, id }，按 needle 文本识别） ----------
const needleUSeqs: number[] = []
for (const event of events) {
  if (event.type !== 'user/message') continue
  const data = event.data as { source?: { kind?: string }; content: { type: string; text?: string }[] }
  if (data.source?.kind !== 'user') continue
  const text = data.content.filter(b => b.type === 'text').map(b => b.text ?? '').join(' ')
  if (text.includes('ZEBRA-9417') || text.includes('triage them one by one')) needleUSeqs.push(event.seq)
}
const shadowedAll = new Set(engine.records.flatMap(r => r.shadowedSeqs))
const surfaceSet = new Set(agent.session.surface.nodes)
const needleIntact = needleUSeqs.length === 2
  && needleUSeqs.every(seq => !shadowedAll.has(seq) && surfaceSet.has(seq))
verdict('V3-u-protection', needleIntact,
  'needle U seqs=' + JSON.stringify(needleUSeqs) + '; shadowed=' + [...shadowedAll].join(',') + ' (不含 needle)'
  + '; on surface=' + needleUSeqs.every(seq => surfaceSet.has(seq)))

// ---------- V4：事务完整性 ----------
const starts = events.filter(e => e.type === 'compaction/start').length
const summaries = events.filter(e => e.type === 'compaction/summary').length
const ends = events.filter(e => e.type === 'compaction/end')
const endsWithError = ends.filter(e => (e.data as { error?: string }).error !== undefined).length
const checkpointOk = engine.records.every(r => {
  const event = agent.session.events[r.tombstoneSeq] as { data: { source: { kind: string; plugin?: string } } }
  return event?.data.source.kind === 'plugin' && event.data.source.plugin === 'compact'
})
verdict('V4-transaction', starts === engine.records.length && summaries === engine.records.length
  && ends.length === engine.records.length && endsWithError === 0 && checkpointOk,
  'start=' + starts + ' summary=' + summaries + ' end=' + ends.length + ' (error=' + endsWithError
  + '); checkpoint source=compact:' + checkpointOk)

// ---------- V5：recall 闭环（全 shadowed 集合找含 marker 的大块原文） ----------
let recallDetail = 'no prune record to test'
let recallOk = false
{
  const allShadowed = engine.records.flatMap(r => r.shadowedSeqs)
  const probeSeq = allShadowed.find(seq => {
    const text = engine.recall(seq) ?? ''
    return text.length > 200 && /INC-\d+-MARKER-\d+/.test(text)
  })
  const recovered = probeSeq === undefined ? null : engine.recall(probeSeq)
  recallOk = probeSeq !== undefined && recovered !== null && /INC-\d+-MARKER-\d+/.test(recovered)
  recallDetail = 'shadowed seq=' + probeSeq + '; recall ' + (recovered === null ? 'miss'
    : 'hit ' + recovered.length + ' chars, marker=' + /INC-\d+-MARKER-\d+/.test(recovered))
}
verdict('V5-recall-loop', recallOk, recallDetail)

// ---------- V6：needle retention（对照 run-10 retention 语义） ----------
const expectAll = ['ZEBRA-9417', '8471', 'mirror-3.internal.example']
let prodJson = ''
try {
  prodJson = fs.readFileSync(path.join(workDir, 'deploy', 'prod.json'), 'utf8')
} catch {
  prodJson = ''
}
const found = expectAll.filter(v => prodJson.includes(v))
verdict('V6-retention', found.length === 3,
  prodJson === '' ? 'deploy/prod.json 未写出' : 'found ' + found.length + '/3: ' + found.join(', ')
  + '; file=' + prodJson.slice(0, 200))

// ---------- METRIC C7：新模型服从率基线（信息项） ----------
const recallCallsInProbe = engine.recallCalls.length - recallCallsBeforeRecallProbe.value
const lastAssistant = [...agent.session.deriveMessages()].reverse().find(m => m.role === 'assistant')
const recallAnswer = lastAssistant?.content.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join(' ') ?? ''
const recallAnswerCorrect = recallAnswer.includes('INC-2-MARKER-2')
console.log('[METRIC C7] recall-probe: spontaneous recall_pruned calls=' + recallCallsInProbe
  + ' (total recallCalls=' + JSON.stringify(engine.recallCalls) + ')'
  + '; answer contains INC-2-MARKER-2=' + recallAnswerCorrect + '; answer="' + recallAnswer.slice(0, 160) + '"')

// ---------- 统计与产物落盘 ----------
const assistantEvents = events.filter(e => e.type === 'assistant/message')
const reasoningChars = assistantEvents.reduce((sum, e) => {
  const content = (e.data as { message: { content: { type: string; text?: string }[] } }).message?.content ?? []
  return sum + content.filter(b => b.type === 'reasoning').reduce((s, b) => s + (b.text?.length ?? 0), 0)
}, 0)
const result = {
  spike: '04-t1',
  at: new Date().toISOString(),
  model: 'local/Qwen3.8-27B',
  windowTokens: 16_384,
  retainTokens: 8_192,
  wallSeconds: Math.round((Date.now() - startedAt) / 1000),
  turns: prompts.length,
  pruneTransactions: engine.records.length,
  shadowedNodes: totalShadowed,
  reasoningChars,
  surfaceTokensEnd: engine.estimateTokens(agent.session),
  turnStats,
  records: engine.records,
  verdict: { failures },
  metricC7: { recallCallsInProbe, recallAnswerCorrect },
}
fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2), 'utf8')
fs.writeFileSync(path.join(outDir, 'events.jsonl'),
  events.map(e => JSON.stringify(e)).join('\n'), 'utf8')
console.log('[info] artifacts: ' + outDir)
console.log('[info] wall=' + result.wallSeconds + 's; reasoning chars=' + reasoningChars
  + '; final surface~' + result.surfaceTokensEnd + ' tokens')
for (const stat of turnStats) {
  console.log('[info] turn ' + stat.turn + ': prompt=' + stat.promptTokens + ' completion=' + stat.completionTokens)
}

await ctx.fiber.dispose()
console.log(failures.length === 0
  ? 'SPIKE 4 VERDICT: PASS（t1 复刻 × 16K 机制验证：真剪枝 + 配对 + U 保护 + 事务 + recall + retention）'
  : 'SPIKE 4 VERDICT: FAIL（' + failures.length + ' 项未过：' + failures.join('; ') + '）')
process.exit(failures.length === 0 ? 0 : 1)
