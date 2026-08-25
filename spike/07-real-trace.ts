/**
 * spike 7：真实编码任务 trace 采集（P0 —— 单臂，不跑对照）
 *
 * 目的（回答 06c 合成场景测不出的三个行为模式，供后续离线重放/成本归因）：
 *   1. 重复读频率 —— 真实 agent 会不会反复 read 同一个正在迭代的文件？读几次？
 *      （06c 每轮读全新 mod-N.ts，0 重复 → 版本链去重 θ=0.8 完全测不到）
 *   2. edit 依赖 read 的程度 —— edit_file 的 old_string 是否取自前面 read 的内容？
 *      （06c 用固定 marker `// NEXT-EDIT-HERE` 掩盖了这一点，它决定"砍 result 后 recall 是低频还是高频"）
 *   3. cites 服从率 —— 真实编码任务里模型 declares 多少 cites？（决定 ARGP 语义边稀疏度）
 *
 * 与 06c 的关键差异：
 *   - 任务真实：一个 KV store 实现 + 迭代修复，agent 反复 read→edit→read 同一文件
 *   - 不设 U/R 探针、不做 PASS/FAIL 判决 —— 本脚本只采 trace，不验证结论
 *   - 三个观测指标全部离线可得：read 路径序列、edit old_string 序列、cites 声明
 *
 * 产物（spike/out/07-real-trace-<stamp>/）：
 *   - events.jsonl  完整事件流（供离线重放：θ=0.8 去重收益、砍 result 收益、成本下限）
 *   - trace.json     三个观测指标的聚合 + turnStats + citeStats + 成本
 *
 * 运行（Linux，bash 环境）：
 *   node --import ./scripts/ts-import-rewrite-loader.mjs spike/07-real-trace.ts
 * 环境变量（同 06c）：ARGP_WINDOW_TOKENS / ARGP_RETAIN_TOKENS / ARGP_CONTEXT_WINDOW /
 *   ARGP_MAX_TURNS / ARGP_DEEPSEEK_THINKING（enabled 时 reasoning=high，观察 cites 档位效应）
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { DEEPSEEK_MODEL, DEEPSEEK_PROVIDER } from './deepseek.ts'
import { mountModel } from './model-mount.ts'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ArgpGraphEngine } from '../src/argp-graph-engine.ts'

// ---------- 配置 ----------
const windowTokens = Number(process.env['ARGP_WINDOW_TOKENS'] ?? 80_000)
const retainTokens = Number(process.env['ARGP_RETAIN_TOKENS'] ?? 16_000)
const maxPasses = Number(process.env['ARGP_MAX_PASSES'] ?? 256)
const contextWindow = Number(process.env['ARGP_CONTEXT_WINDOW'] ?? 200_000)
const MAX_TURNS = Number(process.env['ARGP_MAX_TURNS'] ?? 30)

const watchdog = setTimeout(() => {
  console.log('[FATAL] spike 7 watchdog timeout (120 min)')
  process.exit(2)
}, 120 * 60 * 1000)
watchdog.unref()

// ---------- 产物目录 + 真实工作目录 ----------
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const outDir = path.join(import.meta.dirname, 'out', '07-real-trace-' + stamp)
const workDir = path.join(outDir, 'work')
for (const d of ['src', 'tests']) fs.mkdirSync(path.join(workDir, d), { recursive: true })

// 初始项目文件：一个"待实现"的 KV store，agent 需要反复读改它
const initialFiles: Record<string, string> = {
  'package.json': JSON.stringify({
    name: 'kv-store-task', version: '1.0.0', type: 'module',
    scripts: { test: 'node --test tests/' },
  }, null, 2),
  'src/store.ts': [
    '// store.ts — in-memory key-value store (TODO: implement)',
    '// Requirements: get / set / delete, with optional TTL expiry.',
    '',
    'export interface StoreOptions {',
    '  ttlMs?: number',
    '}',
    '',
    'export class Store {',
    '  // TODO: implement storage + methods',
    '}',
    '',
  ].join('\n'),
  'src/utils.ts': [
    '// utils.ts — shared helpers (already implemented)',
    'export const now = (): number => Date.now()',
    'export const isExpired = (ts: number, ttlMs: number): boolean => now() - ts >= ttlMs',
    '',
  ].join('\n'),
  'src/main.ts': [
    '// main.ts — entry point (TODO: integrate Store)',
    'export const VERSION = 1',
    '',
  ].join('\n'),
  'tests/store.test.ts': [
    '// store.test.ts — unit tests (TODO: fill in)',
    "import { test } from 'node:test'",
    "import assert from 'node:assert'",
    "import { Store } from '../src/store.ts'",
    '',
    'test(\'placeholder\', () => { assert.ok(true) })',
    '',
  ].join('\n'),
}
for (const [rel, content] of Object.entries(initialFiles)) {
  const target = path.join(workDir, rel)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content, 'utf8')
}

// ---------- 装配 ----------
const ctx = new Context()
await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: 'spike-7 real coding trace persona' } })
await ctx.plugin(AgentLoop, { agents: [] })
const modelMount = await mountModel(ctx)
await ctx.plugin(ArgpGraphEngine, { windowTokens, retainTokens, maxPasses })
const engine = ctx.compaction as ArgpGraphEngine

const agent = ctx.agentLoop.create(SessionId('spike-7-real-trace'), {
  provider: modelMount.provider,
  model: modelMount.model,
  reasoningEffort: modelMount.reasoning,
})
engine.setSession(agent.session)

// ---------- 沙箱工具（真实文件系统） ----------
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
    try { return fs.readFileSync(sandbox(rel), 'utf8') } catch { return 'read_file: no such file: ' + rel }
  },
}))
const runCommand = promisify(exec)
ctx.tools.register(defineTool({
  name: 'run_command',
  description: 'Run a bash command in the task working directory and return its combined output (capped).',
  parameters: { command: { type: 'string', description: 'bash command to run' } },
  output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
  execute: async (args): Promise<string> => {
    const cmd = (args as { command?: string }).command ?? ''
    try {
      const { stdout, stderr } = await runCommand(cmd, { shell: 'bash', cwd: workDir, maxBuffer: 20 * 1024 * 1024, timeout: 60_000 })
      const out = (stdout + (stderr ? '\n[stderr]\n' + stderr : '')).slice(0, 20_000)
      return out.length >= 20_000 ? out + '\n[truncated]' : out
    } catch (e) {
      return 'run_command error: ' + String((e as { message?: string }).message ?? e).slice(0, 2000)
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
ctx.tools.register(defineTool({
  name: 'edit_file',
  description: 'Replace the first exact occurrence of old_string in a file. Path is relative to the working directory.',
  parameters: {
    path: { type: 'string', description: 'file path relative to the working directory' },
    old_string: { type: 'string', description: 'exact substring to find (first occurrence is replaced)' },
    new_string: { type: 'string', description: 'replacement text (must differ from old_string)' },
  },
  output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
  execute: async (args): Promise<string> => {
    const input = args as { path?: string; old_string?: string; new_string?: string }
    if (input.path === undefined || input.path === '' || input.old_string === undefined || input.new_string === undefined) {
      return 'edit_file: missing path / old_string / new_string'
    }
    if (input.old_string === input.new_string) return 'edit_file: old_string equals new_string, nothing to change'
    const target = sandbox(input.path)
    try {
      const cur = fs.readFileSync(target, 'utf8')
      const idx = cur.indexOf(input.old_string)
      if (idx < 0) return 'edit_file: old_string not found in ' + input.path
      const next = cur.slice(0, idx) + input.new_string + cur.slice(idx + input.old_string.length)
      fs.writeFileSync(target, next, 'utf8')
      return 'edit_file: replaced 1 occurrence in ' + input.path
    } catch (e) {
      return 'edit_file error: ' + String((e as { message?: string }).message ?? e).slice(0, 500)
    }
  },
}))

ctx.on('session/event', (session, event) => {
  if (session !== agent.session) return
  if (event.type === 'turn/end' || event.type === 'compaction/start' || event.type === 'compaction/end') {
    console.log('[diag] ' + event.type + ': ' + JSON.stringify(event.data).slice(0, 200))
  }
})
const turnStats: { turn: number; promptTokens: number; completionTokens: number; cacheReadTokens: number; reasoningTokens: number }[] = []
ctx.on('session/event', (session, event) => {
  if (session !== agent.session) return
  if (event.type === 'assistant/message') {
    const usage = (event.data as { usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; reasoningTokens?: number } }).usage
    turnStats.push({
      turn: (event.data as { turn?: number }).turn ?? -1,
      promptTokens: usage?.inputTokens ?? -1,
      completionTokens: usage?.outputTokens ?? -1,
      cacheReadTokens: usage?.cacheReadTokens ?? 0,
      reasoningTokens: usage?.reasoningTokens ?? 0,
    })
  }
})

function waitForIdle(subject: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: a, status }) => {
      if (a === subject && status === 'idle') { dispose(); resolve() }
    })
  })
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
    if (attempt < 3) { console.log('[diag] turn failed, retrying'); await new Promise(r => setTimeout(r, 20_000)) }
  }
  return false
}

// ---------- 任务编排：真实 KV store 迭代实现（每阶段一个 followup，agent 反复读改 store.ts） ----------
const setupText = 'We are working in a TypeScript project at the working directory. Use read_file / write_file / edit_file / run_command to accomplish the tasks I give you. Work carefully, read files before editing them, and keep prior context in mind.'
const stages: string[] = [
  'First, explore the project: read package.json, src/store.ts, src/utils.ts, src/main.ts, and tests/store.test.ts. Then report the file list and each file\'s current state/purpose.',
  'Implement src/store.ts: an in-memory key-value store with get(key), set(key, value, opts?), and delete(key) methods using a Map. set returns boolean, get returns the value or null if missing, delete returns boolean. Match the existing style and the StoreOptions interface.',
  'Add TTL expiry to src/store.ts: set() accepts an optional ttlMs; get() returns null and removes the entry when it has expired. Use isExpired() from src/utils.ts.',
  'Bug report: calling get() on a missing key seems to throw instead of returning null. Inspect src/store.ts and fix it.',
  'Integrate the store in src/main.ts: import Store, instantiate one, and on startup write a demo key then read it back. Keep it minimal.',
  'Write tests/store.test.ts to cover get/set/delete/expire. Then run the test command and report the result.',
  'If tests fail (e.g. a TTL boundary issue), diagnose and fix src/store.ts, then re-run tests until they pass.',
]
const allTurns = [setupText, ...stages].slice(0, MAX_TURNS)

const startedAt = Date.now()
const turnLog: { idx: number; ok: boolean; seconds: number }[] = []
let idx = 0
for (const text of allTurns) {
  const t0 = Date.now()
  const ok = await runTurn(text)
  turnLog.push({ idx, ok, seconds: Math.round((Date.now() - t0) / 1000) })
  console.log('[turn] ' + idx + ' ' + (ok ? 'ok' : 'FAILED') + ' in ' + turnLog[turnLog.length - 1].seconds + 's')
  idx += 1
}

// ---------- 观测 1：重复读频率（read_file 路径序列） ----------
const events = [...agent.session.events]
const readPaths: { seq: number; turn: number; path: string }[] = []
const editOps: { seq: number; turn: number; path: string; oldString: string }[] = []
const callById = new Map<string, { name: string; turn: number }>()
for (const e of events) {
  if (e.type === 'tool/call') {
    const d = e.data as { name?: string; arguments?: string; turn?: number; callId?: string }
    if (d.callId !== undefined) callById.set(d.callId, { name: d.name ?? '?', turn: d.turn ?? -1 })
    if (d.name === 'read_file') {
      let p = ''
      try { p = JSON.parse(d.arguments ?? '{}').path ?? '' } catch { /* ignore */ }
      readPaths.push({ seq: e.seq, turn: d.turn ?? -1, path: p })
    } else if (d.name === 'edit_file') {
      let p = '', os = ''
      try { const a = JSON.parse(d.arguments ?? '{}'); p = a.path ?? ''; os = a.old_string ?? '' } catch { /* ignore */ }
      editOps.push({ seq: e.seq, turn: d.turn ?? -1, path: p, oldString: os })
    }
  }
}
const pathCounts = new Map<string, number>()
for (const r of readPaths) pathCounts.set(r.path, (pathCounts.get(r.path) ?? 0) + 1)
const rereadPaths = [...pathCounts.entries()].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1])
const totalReads = readPaths.length
const uniqueReadPaths = pathCounts.size
const rereads = totalReads - uniqueReadPaths

// ---------- 观测 2：edit old_string 是否来自先前 read 内容（离线比对） ----------
function eventText(e: { type: string; data?: unknown }): string {
  const data = e.data as Record<string, unknown> | undefined
  const message = (data as { message?: { content?: unknown[] } } | undefined)?.message
  const content = Array.isArray(message?.content) ? (message.content as { type: string; text?: string; content?: { type: string; text?: string }[] }[]) : []
  const parts: string[] = []
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    if (block.type === 'tool-result') for (const inner of block.content ?? []) if (inner.type === 'text' && typeof inner.text === 'string') parts.push(inner.text)
  }
  return parts.join('\n')
}
const readResultTexts: { seq: number; text: string }[] = []
for (const e of events) {
  if (e.type !== 'tool/result') continue
  const cid = (e.data as { message?: { source?: { callId?: string } } })?.message?.source?.callId
  if (cid === undefined || callById.get(cid)?.name !== 'read_file') continue
  readResultTexts.push({ seq: e.seq, text: eventText(e) })
}
let editFromRead = 0, editNotFromRead = 0
const editSourceDetail: { seq: number; path: string; sourced: boolean }[] = []
for (const op of editOps) {
  // 判据：old_string 全文（或其前 40 字符）出现在任一先于该 edit 的 read_file result 中。
  // 但排除「占位 marker」型 old_string：像 // NEXT-EDIT-HERE 这类文件中自带的固定锚点，
  // 它出现在 read 内容里只是巧合（文件本身含该注释），不代表 edit 依赖 read 取出的内容。
  // 判定为「占位 marker」的条件：old_string 极短（<64 字符）且以 // / # / <!-- 等注释符开头，
  // 且不含任何语义标识符（字母数字混合的“变量名/函数名”模式）。
  const looksLikeCommentMarker = /^\s*(\/\/|#|<!--|\/\*|--)/.test(op.oldString)
    && op.oldString.length < 64
    && !/[a-z_$][a-z0-9_$]*\s*\(/.test(op.oldString)
  if (looksLikeCommentMarker) { editNotFromRead += 1; editSourceDetail.push({ seq: op.seq, path: op.path, sourced: false }); continue }
  const prior = readResultTexts.filter(r => r.seq < op.seq).map(r => r.text)
  const probe = op.oldString.slice(0, 40)
  const sourced = op.oldString.length >= 8 && probe.length > 0
    && prior.some(t => t.includes(op.oldString) || t.includes(probe))
  if (sourced) editFromRead += 1; else editNotFromRead += 1
  editSourceDetail.push({ seq: op.seq, path: op.path, sourced })
}

// ---------- 观测 3：cites 服从率（从 events 里的 argpCites 统计，独立于压缩） ----------
let assistantMessages = 0, withCites = 0, totalCites = 0, citesFailed = 0
for (const e of events) {
  if (e.type !== 'assistant/message') continue
  assistantMessages += 1
  const ac = (e.data as { argpCites?: unknown[] }).argpCites
  if (Array.isArray(ac) && ac.length > 0) { withCites += 1; totalCites += ac.length }
}

// ---------- 成本（同 06c 口径） ----------
const P_MISS = 1.5, P_HIT = 0.05, P_OUT = 4.5
let miss = 0, hit = 0, out = 0
for (const t of turnStats) { miss += Math.max(0, t.promptTokens); hit += t.cacheReadTokens; out += Math.max(0, t.completionTokens) }
const cost = miss * P_MISS / 1e6 + hit * P_HIT / 1e6 + out * P_OUT / 1e6
const hitRate = (hit + miss) > 0 ? 100 * hit / (hit + miss) : 0

const surfaceChars = [...agent.session.surface.nodes].reduce((sum, seq) => {
  const ev = agent.session.events[seq]
  return sum + (ev === undefined ? 0 : eventText(ev).length)
}, 0)

const trace = {
  spike: '07-real-trace',
  at: new Date().toISOString(),
  model: DEEPSEEK_PROVIDER + '/' + DEEPSEEK_MODEL,
  reasoning: modelMount.reasoning,
  windowTokens, retainTokens, contextWindow, maxPasses,
  wallSeconds: Math.round((Date.now() - startedAt) / 1000),
  turnsPlanned: allTurns.length,
  turnsCompleted: turnLog.filter(t => t.ok).length,
  // 观测 1：重复读
  readPattern: {
    totalReads, uniqueReadPaths, rereads,
    rereadPathCounts: rereadPaths,
    readPaths,
  },
  // 观测 2：edit 依赖 read
  editPattern: {
    totalEdits: editOps.length,
    editFromRead, editNotFromRead,
    editSourceDetail,
    editOps: editOps.map(o => ({ seq: o.seq, turn: o.turn, path: o.path, oldStringLen: o.oldString.length, oldStringHead: o.oldString.slice(0, 120) })),
  },
  // 观测 3：cites 服从率
  cites: {
    assistantMessages, withCites, totalCites, citesFailed,
    declaredRatePct: assistantMessages > 0 ? +(100 * withCites / assistantMessages).toFixed(1) : 0,
    engineCiteStats: engine.citeStats,
  },
  compressionCount: engine.records.length,
  surfaceCharsEnd: surfaceChars,
  surfaceTokensEndApprox: Math.ceil(surfaceChars / 3.5),
  cost: {
    missTokens: miss, missYuan: +(miss * P_MISS / 1e6).toFixed(4),
    hitTokens: hit, hitYuan: +(hit * P_HIT / 1e6).toFixed(4),
    outTokens: out, outYuan: +(out * P_OUT / 1e6).toFixed(4),
    totalYuan: +cost.toFixed(4),
    cacheHitRatePct: +hitRate.toFixed(1),
  },
  turnStats, turnLog,
}
fs.writeFileSync(path.join(outDir, 'trace.json'), JSON.stringify(trace, null, 2), 'utf8')
fs.writeFileSync(path.join(outDir, 'events.jsonl'), events.map(e => JSON.stringify(e)).join('\n'), 'utf8')

console.log('=== spike 7 trace 摘要 ===')
console.log('[read] 总读 ' + totalReads + ' 次 / 唯一文件 ' + uniqueReadPaths + ' / 重复读 ' + rereads + ' 次')
console.log('[read] 重复读 TOP: ' + rereadPaths.slice(0, 5).map(([p, n]) => p + ' x' + n).join(', '))
console.log('[edit] 总编辑 ' + editOps.length + ' 次 / old_string 取自先前 read 的 ' + editFromRead + ' 次 / 未取自 read 的 ' + editNotFromRead + ' 次')
console.log('[cites] assistant 消息 ' + assistantMessages + ' / 带 cites ' + withCites + ' / declares ' + totalCites + ' 条 (服从率 ' + (assistantMessages > 0 ? (100 * withCites / assistantMessages).toFixed(1) : 0) + '%)')
console.log('[cites] 引擎 citeStats: ' + JSON.stringify(engine.citeStats))
console.log('[cost] ¥' + cost.toFixed(3) + '; cacheHit=' + hitRate.toFixed(1) + '%')
console.log('[info] artifacts: ' + outDir)

await ctx.fiber.dispose()
