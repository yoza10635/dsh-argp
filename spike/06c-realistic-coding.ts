/**
 * spike 6c：t-long 真实编码长程 × 多压缩场景（50 轮，DeepSeek v4-flash）
 *
 * 改造自 06-tlong（均匀多次压缩结构 + 双针）与 spike 26（真实编码工具 + B 臂 + 缓存命中统计）。
 * 补齐 spike 26 缺失的三类真实编码场景（每轮 filler 轮换其一）：
 *  - 大型代码库读取：read_file codebase/mod-N.ts（~400 行真实风代码，首行 R 针）
 *  - 读终端输出：run_command `cat outputs/run-N.txt`（真实命令输出，首行 R 针）
 *  - 多次修改文件：edit_file 反复改 app/app.ts，读 edits/snap-N.txt 快照（首行 R 针）
 * 每轮 filler 均匀膨胀 → 上下文均匀分布增长 → 多次压缩自然触发（window 80K/retain 16K）。
 *
 * 双针：U 针（archival note，永不参剪）+ R 针（每轮所读 artifact 首行唯一 marker，被剪经 recall_pruned 找回）。
 * 臂：
 *  A = ArgpGraphEngine（主臂，0-LLM 可逆）+ 双针判决 L1/L2/L3
 *  B = BasicCompactionEngine（摘要式对照，依赖 TokenMeter；无 recall_pruned → 预期 R 不可找回 + 成本高）
 *  C = BasicCompactionEngine + recall_search（grep 侧存档召回，验证「摘要式+关键词召回」能否补上不可逆短板）
 * B 臂仅判决 L1（完成+压缩配对+无错误），U/R 找回如实记录为 N/A（即不可逆证据，是论点核心）。
 * C 臂按 A 同标准判 U/R（R 经 grep 找回），但召回机制是手动关键词检索而非图感知自动召回。
 *
 * 判决项：
 *  L1 long-run-stable：完成轮数=计划 + 或phans=0 + 压缩事件配对 + 无错误
 *  L2 u-protection：U 探针正确 ≥80%（A 臂；B 臂仅记录）
 *  L3 r-recovery：R 探针正确 ≥70%（A 臂；B 臂预期失败，仅记录）
 *  METRIC：压缩次数、误差曲线、recall 使用量、token 统计（含 cacheReadTokens）
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
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
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import TokenMeter from '@deepseek-ai/dsh-token-meter'

const failures: string[] = []
const verdict = (name: string, ok: boolean, detail: string): void => {
  console.log((ok ? '[PASS ' : '[FAIL ') + name + '] ' + detail)
  if (!ok) failures.push(name + ': ' + detail)
}

// ---------- 臂相关环境 ----------
const arm = (process.env['ARGP_ARM'] ?? 'A').toUpperCase() as 'A' | 'B' | 'C'
const isArgp = arm === 'A'
const runName = process.env['ARGP_RUN_NAME'] ?? ('06c-realistic-' + arm.toLowerCase())
const watchdogMin = Number(process.env['ARGP_WATCHDOG_MIN'] ?? 180)
const windowTokens = Number(process.env['ARGP_WINDOW_TOKENS'] ?? 80_000)
const retainTokens = Number(process.env['ARGP_RETAIN_TOKENS'] ?? 16_000)
const maxPasses = Number(process.env['ARGP_MAX_PASSES'] ?? 256)
const minBoundaries = Number(process.env['ARGP_MIN_BOUNDARIES'] ?? 5)
const contextWindow = Number(process.env['ARGP_CONTEXT_WINDOW'] ?? 200_000)
const MAX_TURNS = Number(process.env['ARGP_MAX_TURNS'] ?? 50)
const baselineMaxTokens = Number(process.env['ARGP_BASELINE_MAX_TOKENS'] ?? 32_768)

// 看门狗：50 轮 × ~90s ≈ 75min，叠加重试/重载余量，封顶
const watchdog = setTimeout(() => {
  console.log('[FATAL] spike 6c watchdog timeout (' + watchdogMin + ' min)')
  process.exit(2)
}, watchdogMin * 60 * 1000)
watchdog.unref()

// ---------- 产物目录 ----------
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const outDir = path.join(import.meta.dirname, 'out', runName + '-' + stamp)
const workDir = path.join(outDir, 'work')
for (const d of ['codebase', 'outputs', 'edits', 'app']) fs.mkdirSync(path.join(workDir, d), { recursive: true })
// 侧存档：仅 C 臂（B+召回）使用——压缩前把每轮 artifact 原始内容 dump 到此，模型用 recall_search 检索。
// 这是对「摘要式无内置召回」的补丁：用 dsh-tools 的 grep 思路实现一个朴素关键词召回通道。
const recallArchivePath = path.join(workDir, 'recall-archive.md')

// ---------- needle 编码（确定性伪随机，脚本侧持有期望值） ----------
const code = (n: number): string => ((n * 48_271) % 1_679_616).toString(36).toUpperCase().padStart(4, '0')
const uToken = (k: number): string => 'TK-' + code(k * 7 + 3)
const rMarker = (j: number): string => 'ART-' + j + '-MARKER-' + code(j)

// ---------- 真实编码 artifact 生成 ----------
type Scenario = 'codebase' | 'terminal' | 'edit'
const scenarioOf = (j: number): Scenario => (['codebase', 'terminal', 'edit'] as const)[(j - 1) % 3]
const artifactPath = (j: number): string => {
  const s = scenarioOf(j)
  if (s === 'codebase') return 'codebase/mod-' + j + '.ts'
  if (s === 'terminal') return 'outputs/run-' + j + '.txt'
  return 'edits/snap-' + j + '.txt'
}

// 大型代码库模块（首行 R 针）
function makeCodebaseModule(j: number): string {
  const lines: string[] = [
    '// ' + rMarker(j) + ' — generated large codebase module (simulated real source)',
    'export interface Module' + j + 'Config {',
    '  id: number',
    '  name: string',
    '  enabled: boolean',
    '  retries: number',
    '  sinks: string[]',
    '}',
    '',
    "import { Logger } from './logger'",
    "import { Cache } from './cache'",
    "import { Dispatch } from './dispatch'",
    '',
    '/**',
    ' * Module ' + j + ' — handles inbound telemetry records and dispatches to downstream sinks.',
    ' * This is a representative file from a large monorepo; it is read whole during the session.',
    ' */',
    'export class Module' + j + ' {',
    '  private readonly config: Module' + j + 'Config',
    '  private readonly logger: Logger',
    '  private readonly cache: Cache',
    '  private readonly dispatch: Dispatch',
    '  private state: Map<string, unknown> = new Map()',
    '  constructor(config: Module' + j + 'Config, logger: Logger, cache: Cache, dispatch: Dispatch) {',
    '    this.config = config',
    '    this.logger = logger',
    '    this.cache = cache',
    '    this.dispatch = dispatch',
    '  }',
  ]
  for (let m = 0; m < 30; m += 1) {
    lines.push('  async processRecord' + m + '(record: Record<string, unknown>): Promise<void> {')
    lines.push('    if (!this.config.enabled) { this.logger.warn(\'module ' + j + ' disabled; skip rec \' + JSON.stringify(record).slice(0, 64)); return }')
    lines.push('    const key = \'rec:\' + String(record[\'id\'] ?? \'none\') + \':\' + ' + m)
    lines.push('    const cached = await this.cache.get(key)')
    lines.push('    if (cached !== null && cached !== undefined) { this.state.set(key, cached); return }')
    for (let s = 0; s < 9; s += 1) {
      lines.push('    const step' + s + ' = this.transform' + m + '_' + s + '(record, this.config.retries + ' + s + ')')
      lines.push('    this.state.set(key + \':step' + s + '\', step' + s + ')')
    }
    lines.push('    await this.cache.set(key, this.state.get(key))')
    lines.push('    this.dispatch.emit(\'module.' + j + '.processed\', { m: ' + m + ', ok: true })')
    lines.push('  }')
    lines.push('  private transform' + m + '_0(r: Record<string, unknown>, retries: number): unknown {')
    lines.push('    return { ok: true, module: ' + j + ', retries, payload: r, ts: Date.now(), tag: \'t' + m + '\' }')
    lines.push('  }')
  }
  lines.push('}')
  return lines.join('\n')
}

// 终端输出（首行 R 针）
function makeTerminalOutput(j: number): string {
  const lines: string[] = [
    '=== ' + rMarker(j) + ' === build output begin',
    '$ tsc --noEmit -p tsconfig.json',
  ]
  for (let n = 0; n < 400; n += 1) {
    const mod = (n % 24) + 1
    const ln = (n % 90) + 1
    lines.push('src/module' + mod + '/file' + n + '.ts:' + ln + ':  export function handler' + n + '(ctx: Context): Promise<unknown> {')
    lines.push('src/module' + mod + '/file' + n + '.ts:' + ln + ':    return dispatch(ctx, payload' + n + ') // refs module ' + mod + ' sink ' + ((n % 5) + 1))
  }
  lines.push('Found 0 errors. Watching for file changes.')
  return lines.join('\n')
}

// 编辑快照（首行 R 针 + 当前 app/app.ts 全量；lazy 生成，反映累积编辑）
function makeEditSnapshot(j: number): string {
  const appPath = path.join(workDir, 'app', 'app.ts')
  const app = fs.existsSync(appPath) ? fs.readFileSync(appPath, 'utf8') : '// (empty)'
  return '// ' + rMarker(j) + ' — snapshot of app/app.ts after edit step ' + j + '\n' + app
}

// app/app.ts 初始桩
fs.writeFileSync(path.join(workDir, 'app', 'app.ts'),
  '// app/app.ts — accumulated implementation (edit scenario target)\n' +
  'export const VERSION = 1\n' +
  '// NEXT-EDIT-HERE\n', 'utf8')

// 预生成 codebase / terminal（edit 快照 lazy）
const fillerCount = MAX_TURNS - 1 - 7 // setup 1 + probe 7
for (let j = 1; j <= fillerCount; j += 1) {
  const s = scenarioOf(j)
  if (s === 'codebase') fs.writeFileSync(path.join(workDir, artifactPath(j)), makeCodebaseModule(j), 'utf8')
  else if (s === 'terminal') fs.writeFileSync(path.join(workDir, artifactPath(j)), makeTerminalOutput(j), 'utf8')
}

// ---------- 装配（臂相关） ----------
const ctx = new Context()
await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: 'spike-6c realistic coding long session persona' } })
if (!isArgp) {
  await ctx.plugin(TokenMeter)
  if (typeof (ctx as { tokenMeter?: { measure?: unknown } }).tokenMeter?.measure !== 'function') {
    throw new Error('spike 6c(B): tokenMeter did not mount; basic pressure channel will be silent no-op')
  }
  console.log('[diag] tokenMeter mounted ok')
}
await ctx.plugin(AgentLoop, { agents: [] })
const modelMount = await mountModel(ctx)
if (isArgp) {
  await ctx.plugin(ArgpGraphEngine, { windowTokens, retainTokens, maxPasses })
} else {
  // B 臂：触发线 = contextWindow × thresholdRatio，令其恒等于 A 臂 windowTokens（口径干净可比）。
  // 例：contextWindow=200K、windowTokens=80K → ratio=0.4 → 触发线 = 200K×0.4 = 80K = A 臂 windowTokens。
  const thresholdRatio = windowTokens / contextWindow
  await ctx.plugin(BasicCompactionEngine, {
    maxTokens: baselineMaxTokens,
    modelPolicies: [{ provider: DEEPSEEK_PROVIDER, model: DEEPSEEK_MODEL, thresholdRatio, retainTokens }],
  })
}
const engine: ArgpGraphEngine | null = isArgp ? (ctx.compaction as ArgpGraphEngine) : null

// ---------- 沙箱工具 ----------
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
      return 'edit_file: replaced 1 occurrence in ' + input.path + ' (' + input.old_string.length + ' -> ' + input.new_string.length + ' chars)'
    } catch (e) {
      return 'edit_file error: ' + String((e as { message?: string }).message ?? e).slice(0, 500)
    }
  },
}))

// C 臂专属：朴素 grep 召回通道（摘要式无内置 recall，用侧存档 + 关键词检索补上）
if (arm === 'C') {
  fs.writeFileSync(recallArchivePath, '')
  ctx.tools.register(defineTool({
    name: 'recall_search',
    description: 'Search the session recall archive (a side store of artifacts compacted away by summarization) for a keyword or marker. Use it to recover content no longer in context. Returns matching lines.',
    parameters: { query: { type: 'string', description: 'keyword or marker substring to search for, e.g. "node-3" or "MARKER"' } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async (args): Promise<string> => {
      const q = ((args as { query?: string }).query ?? '').toLowerCase()
      if (q.length === 0) return 'recall_search: empty query'
      try {
        const text = fs.readFileSync(recallArchivePath, 'utf8')
        const lines = text.split('\n').filter(l => l.toLowerCase().includes(q))
        if (lines.length === 0) return 'recall_search: no matches for "' + q + '"'
        return 'recall_search: ' + lines.length + ' matching line(s):\n' + lines.slice(0, 30).join('\n')
      } catch {
        return 'recall_search: archive unavailable'
      }
    },
  }))
}

const agent = ctx.agentLoop.create(SessionId('spike-6c-realistic'), {
  provider: modelMount.provider,
  model: modelMount.model,
  reasoningEffort: modelMount.reasoning,
})
if (engine) engine.setSession(agent.session)

ctx.on('agent/request-error', ({ failure }) => {
  console.log('[diag] request-error: ' + JSON.stringify({ code: failure.code, message: String(failure.message).slice(0, 300) }))
})
ctx.on('session/event', (session, event) => {
  if (session !== agent.session) return
  if (event.type === 'turn/end' || event.type === 'llm/retry' || event.type === 'compaction/start' || event.type === 'compaction/end') {
    console.log('[diag] ' + event.type + ': ' + JSON.stringify(event.data).slice(0, 300))
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

// ---------- 任务编排：setup 1 + filler(fillerCount) + probe 7 ----------
const PROBE_TURNS = [14, 20, 26, 32, 38, 44, 50].filter(t => t <= MAX_TURNS)
const NEEDLE_TURNS = [3, 6, 9, 12, 17, 23, 29]
const setupText = 'We are starting a long-running coding session. From time to time I will hand you a service token for a node — keep it in mind. On most turns I will ask you to read a large codebase file, run a terminal command and read its output, or edit a source file — those are routine work that grows our shared context. Occasionally I will send a long-term memory check; for those, follow the exact answer format given in the check itself. Work carefully and keep prior context in mind.'
const fillerBody = (j: number): string => {
  const s = scenarioOf(j)
  if (s === 'codebase') {
    return 'Use the read_file tool to read the entire file `codebase/mod-' + j + '.ts`. After reading, reply with the file name, a space, its line count, and the ART marker from its first comment line (format ART-<n>-MARKER-<code>). If your reply depends on earlier context, append the ARGP citation block as instructed.'
  }
  if (s === 'terminal') {
    return 'Use the run_command tool to run the command `cat outputs/run-' + j + '.txt`. Reply with the command, its output line count, and the ART marker from the first line of the output (format ART-<n>-MARKER-<code>).'
  }
  return 'Use the edit_file tool to replace the exact line `// NEXT-EDIT-HERE` in `app/app.ts` with `export function step' + j + '(): number { return ' + j + ' }\\n// NEXT-EDIT-HERE`. Then use read_file to read `edits/snap-' + j + '.txt` and reply with its first-line ART marker (format ART-<n>-MARKER-<code>).'
}
const probeText = (k: number): string => {
  if (arm === 'C') {
    // C 臂：用 grep 召回通道（recall_search）找回被摘要丢弃的 marker
    return 'Long-term memory check ' + k + '. On an earlier turn I gave you an archival note for node-' + k + '; on that same turn you read or acted on an artifact whose FIRST line contains a unique marker of the form ART-<n>-MARKER-<XXXX>. That first line is no longer visible; recover it with recall_search before answering.\n' +
      'To recover, call recall_search with query "node-' + k + '" to fetch the archived first-line marker for that node, then copy the exact ART-<n>-MARKER-<code> from the returned line. Do not guess.\n' +
      'Reply with exactly two lines and nothing else, in this format:\n' +
      'U-ANSWER: <the service token from my archival note for node-' + k + '>\n' +
      'R-ANSWER: <the full ART marker from the first line of the artifact you read/acted on during the same turn I gave you the archival note for node-' + k + '>\n' +
      'If recall_search returns nothing for node-' + k + ', write NOT-RECOVERABLE on that line.'
  }
  return 'Long-term memory check ' + k + '. On an earlier turn I gave you an archival note for node-' + k + '; on that same turn you read or acted on an artifact (a codebase module, a command output, or an edit snapshot) whose FIRST line contains a unique marker of the form ART-<n>-MARKER-<XXXX>. That first line is no longer visible; recover it with recall_pruned before answering.\n' +
    'To recover, call recall_pruned for each placeholder seq you are unsure about, one at a time, until you find the tool result whose text starts with "ART-" and contains "MARKER-". Copy the exact ART-<n>-MARKER-<code> from that recovered text. Do not guess.\n' +
    'Reply with exactly two lines and nothing else, in this format:\n' +
    'U-ANSWER: <the service token from my archival note for node-' + k + '>\n' +
    'R-ANSWER: <the full ART marker from the first line of the artifact you read/acted on during the same turn I gave you the archival note for node-' + k + '>\n' +
    'If after trying recall_pruned for all placeholders you still cannot recover it, write NOT-RECOVERABLE on that line.'
}

type Item = { label: string; text: string; kind: 'setup' | 'filler' | 'probe'; probeK?: number; chunkIndex?: number; needleK?: number }
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
  const j = fillerIdx
  const needlePos = NEEDLE_TURNS.indexOf(turn)
  const needleK = needlePos >= 0 ? needlePos + 1 : undefined
  const text = needleK === undefined
    ? fillerBody(j)
    : 'Archival note (remember it; no acknowledgment needed): the service token for node-' + needleK + ' is ' + uToken(needleK) + '.\n' + fillerBody(j)
  items.push({ label: 'filler-' + j, text, kind: 'filler', chunkIndex: j, needleK })
}
// 期望值登记：needle-k → U token + 同轮所读 artifact 的 R marker
const expected = new Map<number, { u: string; r: string; chunkIndex: number }>()
for (const item of items) {
  if (item.kind === 'filler' && item.needleK !== undefined) {
    const j = item.chunkIndex as number
    expected.set(item.needleK, { u: uToken(item.needleK), r: rMarker(j), chunkIndex: j })
  }
}

const startedAt = Date.now()
const turnLog: { label: string; ok: boolean; boundariesAfter: number; seconds: number }[] = []
let consecutiveFailedTurns = 0
let aborted = false
for (const item of items) {
  // edit 场景：运行前 lazy 生成快照（反映累积编辑后的 app.ts）
  if (item.kind === 'filler' && scenarioOf(item.chunkIndex as number) === 'edit') {
    fs.writeFileSync(path.join(workDir, artifactPath(item.chunkIndex as number)), makeEditSnapshot(item.chunkIndex as number), 'utf8')
  }
  const turnStart = Date.now()
  const ok = await runTurn(item.text)
  const boundariesAfter = agent.session.events.filter(e => e.type === 'compaction/start').length
  turnLog.push({ label: item.label, ok, boundariesAfter, seconds: Math.round((Date.now() - turnStart) / 1000) })
  // filler 轮读完后：C 臂先把 artifact 原始内容 dump 到侧存档（grep 召回源），再删文件。
  // A/B 臂不存档（A 靠结构化剪枝自留，B 预期不可逆丢失）。
  if (item.kind === 'filler' && ok) {
    if (arm === 'C') {
      try {
        const ap = path.join(workDir, artifactPath(item.chunkIndex as number))
        const content = fs.readFileSync(ap, 'utf8')
        const firstLine = (content.split('\n')[0] ?? '').trim()
        fs.appendFileSync(recallArchivePath,
          '\n=== ' + item.label + (item.needleK ? ' (node-' + item.needleK + ') ' + firstLine : '') + ' ===\n' + content)
      } catch { /* 忽略 */ }
    }
    try { fs.unlinkSync(path.join(workDir, artifactPath(item.chunkIndex as number))) } catch { /* 已删或不存在 */ }
  }
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
  console.log('[turn] ' + item.label + ' done in ' + Math.round((Date.now() - turnStart) / 1000) + 's; boundaries=' + boundariesAfter)
}

const events = [...agent.session.events]

// turn 映射（判决用）：按文案 marker 匹配 user/message，取该 seq 之前最近一个 turn/start 的轮号
const promptMarkers = new Map<string, string>([
  ['setup', 'long-running coding session'],
  ...items.filter(i => i.kind === 'filler').map(i => [i.label, artifactPath(i.chunkIndex as number)] as [string, string]),
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

// ---------- 事务计数（臂相关） ----------
const starts = events.filter(e => e.type === 'compaction/start').length
const summaries = events.filter(e => e.type === 'compaction/summary' || e.type === 'compaction/prune').length
const ends = events.filter(e => e.type === 'compaction/end')
const endsWithError = ends.filter(e => (e.data as { error?: string }).error !== undefined).length
const boundaries = isArgp && engine ? engine.records.length : starts
const orphans = orphanReport()
const completedTurns = turnLog.filter(t => t.ok).length
const checkpointOk = isArgp && engine
  ? engine.records.every(r => r.intervals.every(iv => {
    const event = agent.session.events[iv.tombstoneSeq] as { data?: { source?: { kind: string; plugin?: string } } }
    if (event === undefined) return false
    if (event.data?.source === undefined) return true // tool-tombstone rewrite
    return event.data.source.kind === 'plugin' && event.data.source.plugin === 'compact'
  }))
  : true

// ---------- L1：长程稳定（臂相关） ----------
if (isArgp) {
  verdict('L1-long-run-stable', !aborted && completedTurns === items.length && boundaries >= minBoundaries
    && orphans.length === 0 && starts === boundaries && summaries === boundaries
    && ends.length === boundaries && endsWithError === 0 && checkpointOk,
    'turns=' + completedTurns + '/' + items.length + (aborted ? ' (aborted)' : '')
    + '; arm=' + arm + '; boundaries=' + boundaries + '; orphans=' + orphans.length
    + '; tx start/summary/end=' + starts + '/' + summaries + '/' + ends.length + ' (error=' + endsWithError
    + '); checkpoint source=compact:' + checkpointOk)
} else {
  // B 臂：BasicCompactionEngine 无 records/shadowed 集，跳过 checkpoint 与 needle 判决；
  // L1 仅查 完成 + 配对 + 无错误（验证摘要式压缩也能跑完长程，但预期 U/R 不可找回）。
  verdict('L1-long-run-stable', !aborted && completedTurns === items.length
    && orphans.length === 0 && starts === summaries && ends.length === starts && endsWithError === 0,
    'turns=' + completedTurns + '/' + items.length + (aborted ? ' (aborted)' : '')
    + '; arm=' + arm + ' (BasicCompactionEngine); boundaries=' + boundaries
    + '; tx start/summary/end=' + starts + '/' + summaries + '/' + ends.length + ' (error=' + endsWithError + ')')
}

// ---------- 误差曲线：逐 probe 判 U/R 双针（A 臂全判；B 臂仅记录，不可逆证据） ----------
const shadowedAll = isArgp && engine ? new Set(engine.records.flatMap(r => r.shadowedSeqs)) : new Set<number>()
interface CurvePoint {
  probe: number; turn: number; boundaries: number
  uCorrect: boolean; rCorrect: boolean; targetShadowed: boolean
  recallCallsAtProbe: number; uAnswer: string; rAnswer: string
}
const curve: CurvePoint[] = []
const recallToolCalls = events.filter(e => e.type === 'tool/call'
  && ['recall_pruned', 'recall_search'].includes((e.data as { name?: string }).name ?? ''))
for (const item of items.filter(i => i.kind === 'probe')) {
  const k = item.probeK as number
  const exp = expected.get(k)
  if (exp === undefined) continue
  const turn = turnOf.get(item.label) ?? -1
  const raw = events.filter(e => e.type === 'assistant/message' && (e.data as { turn?: number }).turn === turn)
    .map(e => eventRawText(e)).join('\n')
  const uMatch = raw.match(/U-ANSWER:\s*(.+)/)
  const rMatch = raw.match(/R-ANSWER:\s*(.+)/)
  const uAnswer = (uMatch?.[1] ?? '').trim().toUpperCase()
  const rAnswer = (rMatch?.[1] ?? '').trim().toUpperCase()
  const uCorrect = uAnswer.length > 0 && uAnswer !== 'NOT-RECOVERABLE' && uAnswer === exp.u
  const rCorrect = rAnswer.length > 0 && rAnswer !== 'NOT-RECOVERABLE' && rAnswer === exp.r
  const markerNeedle = exp.r
  const targetSeqs = events.filter(e => e.type === 'tool/result' && eventRawText(e).toUpperCase().includes(markerNeedle)).map(e => e.seq)
  const targetShadowed = isArgp && targetSeqs.length > 0 && targetSeqs.every(seq => shadowedAll.has(seq))
  const boundariesAtProbe = turnLog.find(t => t.label === item.label)?.boundariesAfter ?? boundaries
  const probeRecalls = recallToolCalls.filter(e => (e.data as { turn?: number }).turn === turn)
  curve.push({
    probe: k, turn, boundaries: boundariesAtProbe,
    uCorrect, rCorrect, targetShadowed,
    recallCallsAtProbe: probeRecalls.length,
    uAnswer, rAnswer,
  })
  console.log('[probe ' + k + '] boundaries=' + boundariesAtProbe + ' U=' + (uCorrect ? 'OK' : 'MISS(' + uAnswer + ')')
    + ' R=' + (rCorrect ? 'OK' : 'MISS(' + rAnswer + ')') + ' shadowed=' + targetShadowed)
}
const uCorrectCount = curve.filter(p => p.uCorrect).length
const rCorrectCount = curve.filter(p => p.rCorrect).length
const uThreshold = Math.max(1, Math.round(curve.length * 0.8))
const rThreshold = Math.max(1, Math.round(curve.length * 0.7))
const judgeRecall = isArgp || arm === 'C'
if (judgeRecall) {
  verdict('L2-u-protection', uCorrectCount >= uThreshold,
    'U probes correct ' + uCorrectCount + '/' + curve.length + '（U 针永不参剪，surface 直读）')
  const recallKind = isArgp ? 'recall_pruned（图感知·自动）' : 'recall_search（grep 侧存档·手动）'
  verdict('L3-r-recovery', rCorrectCount >= rThreshold,
    'R probes correct ' + rCorrectCount + '/' + curve.length + '（机制=' + recallKind
    + '；召回调用总量 ' + recallToolCalls.length + '）')
} else {
  console.log('[info] B arm: U recovery observed ' + uCorrectCount + '/' + curve.length
    + '; R recovery observed ' + rCorrectCount + '/' + curve.length
    + '（BasicCompactionEngine 无 recall_pruned → 被剪内容不可逆，预期不可找回；如实记录，非判决项）')
}
console.log('[METRIC error-curve] ' + JSON.stringify(curve.map(p => ({ probe: p.probe, b: p.boundaries, u: p.uCorrect ? 1 : 0, r: p.rCorrect ? 1 : 0, sh: p.targetShadowed ? 1 : 0 }))))

// ---------- 统计与产物落盘 ----------
const reasoningChars = events.filter(e => e.type === 'assistant/message').reduce((sum, e) => {
  const content = (e.data as { message: { content: { type: string; text?: string }[] } }).message?.content ?? []
  return sum + content.filter(b => b.type === 'reasoning').reduce((s, b) => s + (b.text?.length ?? 0), 0)
}, 0)
const surfaceChars = [...agent.session.surface.nodes].reduce((sum, seq) => {
  const ev = agent.session.events[seq]
  return sum + (ev === undefined ? 0 : eventRawText(ev).length)
}, 0)

// 成本（v4-flash 价格：miss ¥1.5/M、hit ¥0.05/M、output ¥4.5/M）
const P_MISS = 1.5, P_HIT = 0.05, P_OUT = 4.5
let miss = 0, hit = 0, out = 0
for (const t of turnStats) { miss += Math.max(0, t.promptTokens); hit += t.cacheReadTokens; out += Math.max(0, t.completionTokens) }
const cost = miss * P_MISS / 1e6 + hit * P_HIT / 1e6 + out * P_OUT / 1e6
const hitRate = (hit + miss) > 0 ? (100 * hit / (hit + miss)) : 0

const result = {
  spike: runName,
  arm,
  at: new Date().toISOString(),
  model: process.env['ARGP_MODEL_SOURCE'] === 'qwen-local'
    ? ('qwen-local/' + (process.env['QWEN_MODEL'] ?? 'Qwen3.8-27B'))
    : 'deepseek-official/deepseek-v4-flash',
  windowTokens,
  retainTokens,
  maxPasses,
  minBoundaries,
  contextWindow,
  wallSeconds: Math.round((Date.now() - startedAt) / 1000),
  turnsPlanned: items.length,
  turnsCompleted: completedTurns,
  aborted,
  compressionCount: boundaries,
  pruneTransactions: boundaries,
  shadowedNodes: isArgp && engine ? engine.records.reduce((sum, r) => sum + r.shadowedSeqs.length, 0) : 0,
  cost: {
    missTokens: miss, missYuan: +(miss * P_MISS / 1e6).toFixed(4),
    hitTokens: hit, hitYuan: +(hit * P_HIT / 1e6).toFixed(4),
    outTokens: out, outYuan: +(out * P_OUT / 1e6).toFixed(4),
    totalYuan: +cost.toFixed(4),
    cacheHitRatePct: +hitRate.toFixed(1),
  },
  curve,
  uCorrect: uCorrectCount,
  rCorrect: rCorrectCount,
  recallCalls: recallToolCalls.length,
  reasoningChars,
  surfaceCharsEnd: surfaceChars,
  surfaceTokensEndApprox: Math.ceil(surfaceChars / 3.5),
  turnStats,
  turnLog,
  records: isArgp && engine ? engine.records : null,
  verdict: { failures },
}
fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2), 'utf8')
fs.writeFileSync(path.join(outDir, 'events.jsonl'),
  events.map(e => JSON.stringify(e)).join('\n'), 'utf8')
console.log('[info] artifacts: ' + outDir)
console.log('[info] wall=' + result.wallSeconds + 's; compressions=' + boundaries
  + '; cost=¥' + cost.toFixed(3) + '; cacheHit=' + hitRate.toFixed(1) + '%')

await ctx.fiber.dispose()
console.log(failures.length === 0
  ? 'SPIKE 6C VERDICT: PASS（' + arm + ' 臂 真实编码长程 多压缩：稳定'
    + (isArgp ? ' + U 保护 + R 找回(recall_pruned 图感知)'
      : arm === 'C' ? ' + U 保护 + R 找回(recall_search grep 召回)'
        : '；U/R 找回 N/A=不可逆') + '）'
  : 'SPIKE 6C VERDICT: FAIL（' + failures.length + ' 项未过：' + failures.join('; ') + '）')
process.exit(failures.length === 0 ? 0 : 1)
