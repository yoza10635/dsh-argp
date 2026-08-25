/**
 * spike 26：real-coding t-long 长程复测（编码任务形态，50 轮，DeepSeek v4-flash）
 *
 * 设计稿：docs/experiment-realcoding-design.md
 * 与 spike 6（合成遥测形态）的骨架同构，任务体换成"实现一个 mini 限流微服务"——
 * 真实工具流量（write/read/edit 交错 + 错误-纠正循环），复测三件事：
 *   1. R 找回闭环在异构内容上依然成立（合成 7/7 → 真实内容分布复测）
 *   2. 压缩率精确兑现 + 0 失败事务在真实工具流量下复现
 *   3. cites 通路在无冲突措辞的真实形态下激活（A 臂 citeStats = "赌注赢了"数据）
 *
 * 口径（§2）：headless 真实模型长程复测——真实模型 + 真实工具流量 + 真实引擎路径，
 * 仅传输层是脚本，不经 WebUI。对外不得写成"WebUI 生产对话"。
 *
 * 臂（§5）：ARGP_ARM=A（ArgpGraphEngine，主臂）| B（BasicCompactionEngine 对照，预期 R 不可找回）。
 * 配置固定（§3）：工具集 read/write/edit 三文件工具；中性 persona；
 * ARGP_CONTEXT_WINDOW=200000（A/B 触发线均从它派生 ×0.8=160K，口径干净）；
 * A 臂不显式传 window/retain → 引擎 ratio 0.8/0.2 派生 160K/32K（逐位复现 160K 定稿）。
 *
 * 任务骨架（§4，50 轮）：
 *   1          setup（任务总述）
 *   2-11       事实埋点 F1–F10（每轮 1 个 + 读 ctx/ctx-k.md 制造早期工具流量）
 *   12-35      实现段 24 轮（8 文件 write + 3 验收问 + 3 报错纠正 + 读回核对）
 *   36-45      探针段 10 轮（每轮 U+R 双针，口径与 06 一致）
 *   46-50      收尾段 5 轮（全文件读回核对，制造末次膨胀）
 *
 * 判决（§6）：
 *   L1 long-run-stable：50 轮完成 + 事务 ≥ minBoundaries + 0 孤儿 + 事务事件完整
 *   L2 u-protection：U 探针 ≥8/10（U 永不参剪，surface 直读）
 *   L3 r-recovery：R 探针 ≥7/10（B 臂预期不可达，如实记录）
 *   L4 functional（软，记录不硬卡）：8 文件落盘 + 验收自答 + 伪提示纠正
 *   METRIC：citeStats.declared/resolved、边密度、recall 调用量/命中率、误差曲线
 *
 * 冒烟：ARGP_MAX_TURNS=8 截短跑（setup + 2 事实 + 2 文件 + 1 探针），~¥0.05。
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
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import TokenMeter from '@deepseek-ai/dsh-token-meter'

const failures: string[] = []
const verdict = (name: string, ok: boolean, detail: string): void => {
  console.log((ok ? '[PASS ' : '[FAIL ') + name + '] ' + detail)
  if (!ok) failures.push(name + ': ' + detail)
}

// 看门狗：50 轮 high 档 + 重试余量，3 小时封顶（B 臂摘要事务多，可上调 ARGP_WATCHDOG_MIN）
const WATCHDOG_MIN = Number(process.env['ARGP_WATCHDOG_MIN'] ?? 180)
const watchdog = setTimeout(() => {
  console.log('[FATAL] spike 26 watchdog timeout (' + WATCHDOG_MIN + ' min)')
  process.exit(2)
}, WATCHDOG_MIN * 60 * 1000)
watchdog.unref()

// ---------- 配置（§3 固定 + 可复现开关） ----------
const arm = (process.env['ARGP_ARM'] ?? 'A').toUpperCase() as 'A' | 'B'
const isArgp = arm === 'A'
const runName = process.env['ARGP_RUN_NAME'] ?? ('26-tlong-coding-' + arm.toLowerCase())
const maxPasses = Number(process.env['ARGP_MAX_PASSES'] ?? 256)
// 压载版门槛：参考文件压载（4×~90K 字符）使单事务可剪量更大 → 事务数比纯编码任务少，
// 默认门槛从 8 降到 5（仍要求压缩真实发生）；可用 ARGP_MIN_BOUNDARIES 覆盖。
const minBoundaries = Number(process.env['ARGP_MIN_BOUNDARIES'] ?? 5)
// A 臂 ARGP 触发/保留：显式传 160000/32000，与 160K 定稿 run（scan-32k）同挂载口径（显式传值，
// 不依赖运行时 requestContext 解析——确定性优先）。数值上 = contextWindow 200K × 0.8 / × 0.2。
const windowTokens = Number(process.env['ARGP_WINDOW_TOKENS'] ?? 160_000)
const retainTokens = Number(process.env['ARGP_RETAIN_TOKENS'] ?? 32_000)
const contextWindow = Number(process.env['ARGP_CONTEXT_WINDOW'] ?? 200_000)
const MAX_TURNS = Number(process.env['ARGP_MAX_TURNS'] ?? 50)
const baselineMaxTokens = Number(process.env['ARGP_BASELINE_MAX_TOKENS'] ?? 32_768)

// 中性 persona（§3 固定串；无 {{model}} 模板，无 "nothing else" 冲突措辞）
const PERSONA = 'You are a coding agent implementing a mini rate-limit microservice. A reference module (ref-module.ts) is in the working directory; you will be asked to read and analyze parts of it. Working directory is the task sandbox. Follow user instructions precisely.'

// ---------- 参考文件压载（§4 压载版：真实模块进沙箱，制造 >160K 触发线以上的上下文压力） ----------
// 取主引擎源码为压载材料：体量 ~25K token/次读取，是真实代码而非填充噪声。
// 去契约占位：整块删除文件里三个 ARGP 契约 section（argp-contract / argp-cites / argp-catalog）——消除
// "模型在文件里再读一遍 cites 契约 → 声明率虚高"的污染。压载文件从不被编译/导入（只是
// read_file 读出的文本材料），删块零语法风险；且 section 是独立语句，删后结构仍完整。
// 深埋锚点（extractCites / compactIfNeeded / recall 预算）都在契约块之外，保留。
const BALLAST_REL = 'ref-module.ts'
const BALLAST_SRC = path.join(import.meta.dirname, '..', 'src', 'argp-graph-engine.ts')
function makeBallast(): { path: string; sectionsDropped: number } {
  const lines = fs.readFileSync(BALLAST_SRC, 'utf8').split('\n')
  const drop = new Set<number>()
  let sections = 0
  for (let i = 0; i < lines.length; i += 1) {
    if (!/name: 'argp-(contract|cites|catalog)'/ .test(lines[i])) continue
    let begin = i
    while (begin > 0 && !lines[begin].includes('ctx.systemPrompt.section')) begin -= 1
    let end = i
    while (end < lines.length - 1 && !/^\s{4}\}\)\s*$/.test(lines[end])) end += 1
    for (let k = begin; k <= end; k += 1) drop.add(k)
    sections += 1
    i = end
  }
  const out = lines.filter((_, idx) => !drop.has(idx)).join('\n')
  const target = path.join(workDir, BALLAST_REL)
  fs.writeFileSync(target, out, 'utf8')
  return { path: target, sectionsDropped: sections }
}
// cites 契约提示（仅 A 臂有契约；B 臂无 cites，置空）
const citeCue = isArgp
  ? ' When your reply depends on something you were told earlier or a file you read, append the ARGP citation block as instructed in the system prompt.'
  : ''

// ---------- 产物目录 ----------
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const outDir = path.join(import.meta.dirname, 'out', runName + '-' + stamp)
const workDir = path.join(outDir, 'work')
fs.mkdirSync(path.join(workDir, 'ctx'), { recursive: true })
fs.mkdirSync(path.join(workDir, 'logs'), { recursive: true })

// 生成参考文件压载（须在 workDir 声明之后调用，makeBallast 内部引用 workDir）
const ballast = makeBallast()
if (ballast.sectionsDropped < 2) {
  console.warn('[diag] ballast dropped ' + ballast.sectionsDropped + '/2 contract sections — 引擎文件契约 section 可能改版，压载文件含原始契约文本（cites 污染风险）')
}

// ---------- 确定性编码（与 06 同函数，跨 spike 期望值可比） ----------
const code = (n: number): string => ((n * 48_271) % 1_679_616).toString(36).toUpperCase().padStart(4, '0')

// ---------- 8 个实现文件（marker 针 j=1..8） ----------
const FILES: { j: number; name: string }[] = [
  { j: 1, name: 'config.ts' },
  { j: 2, name: 'window.ts' },
  { j: 3, name: 'counter.ts' },
  { j: 4, name: 'store.ts' },
  { j: 5, name: 'router.ts' },
  { j: 6, name: 'middleware.ts' },
  { j: 7, name: 'ratelimit.test.ts' },
  { j: 8, name: 'README.md' },
]
const markerLine = (j: number, name: string): string => '// edge-rl ' + name + ' — impl ref RLX-' + j + '-MARKER-' + code(j)
const marker = (j: number): string => 'RLX-' + j + '-MARKER-' + code(j)

// ---------- 两个深埋值（R 针，埋在文件中部） ----------
const STORE_EPOCH = parseInt(code(200), 36) // store.ts 中部常量值
const TEST_RETRIES = parseInt(code(201), 36) // ratelimit.test.ts 断言期望值

// ---------- 10 个确定性事实（U 针，埋点轮 2-11 的用户消息） ----------
interface Fact { id: number; embed: string }
const FACTS: Fact[] = [
  { id: 1, embed: 'the service token for this service is `TK-' + code(101) + '`' },
  { id: 2, embed: 'the Redis key prefix is `rl:prod:' + code(102) + '`' },
  { id: 3, embed: 'the rate-limit parameters are window = 60 seconds and burst = 128' },
  { id: 4, embed: 'whenever we return 429, the response body must include a `retry-after-ms` field' },
  { id: 5, embed: 'the log file path is `logs/ratelimit-' + code(105) + '.log`' },
  { id: 6, embed: 'the rate-limit window is aligned to the epoch minute (truncated to whole minutes) — NOT a sliding window' },
  { id: 7, embed: 'the test suite must cover the burst boundary with exactly three cases: 127, 128, and 129' },
  { id: 8, embed: 'the error codes are `RL_EXCEEDED`, `RL_MISCONFIG`, and `RL_INTERNAL`' },
  { id: 9, embed: 'the config file format is JSON, not YAML' },
  { id: 10, embed: 'the timeout budget is 50 ms, and on timeout the system fails open (allows the request through)' },
]

// 早期工具流量：预生成 10 个小 ctx 文件（事实埋点轮各读一个）
function makeCtx(k: number): string {
  const lines: string[] = [
    'system context note ' + k,
    'subsystem=ratelimit-stage-' + k,
    'revision=REV-' + code(300 + k),
    'status=ok',
  ]
  for (let n = 0; n < 12; n += 1) {
    lines.push('  field-' + (n + 1) + '=' + (40 + ((n * k) % 90)) + ' shard=' + ((n + k) % 16) + ' note="context filler ' + k + '-' + n + '"')
  }
  return lines.join('\n')
}
for (let k = 1; k <= 10; k += 1) {
  fs.writeFileSync(path.join(workDir, 'ctx', 'ctx-' + k + '.md'), makeCtx(k), 'utf8')
}

// ---------- 装配（臂相关） ----------
const ctx = new Context()
await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: PERSONA } })
if (!isArgp) {
  // B 臂：BasicCompactionEngine 依赖 tokenMeter（07 B-4 修复——不挂则压力通道静默 no-op）
  await ctx.plugin(TokenMeter)
  if (typeof ctx.tokenMeter?.measure !== 'function') throw new Error('spike 26(B): tokenMeter did not mount; basic pressure channel will be silent no-op')
  console.log('[diag] tokenMeter mounted ok')
}
await ctx.plugin(AgentLoop, { agents: [] })
const modelMount = await mountModel(ctx) // 挂载 deepseek 适配器（catalog contextWindow = ARGP_CONTEXT_WINDOW）
if (isArgp) {
  // A 臂：显式传 window/retain（与 scan-32k 定稿 run 同口径；确定性优先，不走运行时 ratio 解析）
  await ctx.plugin(ArgpGraphEngine, { windowTokens, retainTokens, maxPasses })
} else {
  // B 臂：触发线 = contextWindow×thresholdRatio = 200K×0.8 = 160K（与 A 同源自，口径干净）
  // retainTokens 与 A 臂同源（ARGP_RETAIN_TOKENS，默认 32K），保证 A/B 同参对照
  await ctx.plugin(BasicCompactionEngine, {
    maxTokens: baselineMaxTokens,
    modelPolicies: [{ provider: DEEPSEEK_PROVIDER, model: DEEPSEEK_MODEL, thresholdRatio: 0.8, retainTokens }],
  })
}
const argp: ArgpGraphEngine | null = isArgp ? (ctx.compaction as ArgpGraphEngine) : null

// ---------- 沙箱工具：read_file / write_file / edit_file（§3 固定 3 文件工具） ----------
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
ctx.tools.register(defineTool({
  name: 'edit_file',
  description: 'Replace the first exact occurrence of old_string in a file. Path is relative to the working directory. old_string must match the file content exactly (whitespace-sensitive) and must differ from new_string.',
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
    } catch {
      return 'edit_file: no such file: ' + input.path
    }
  },
}))

const agent = ctx.agentLoop.create(SessionId('spike-26-tlong-coding'), {
  provider: modelMount.provider,
  model: modelMount.model,
  reasoningEffort: modelMount.reasoning,
})
if (argp) argp.setSession(agent.session)

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
      turn: event.data.turn as number,
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

/** 探活：当前模型单请求 PONG。 */
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
      const waitMs = alive ? 15_000 : attempt === 1 ? 90_000 : 150_000
      console.log('[diag] turn failed (attempt ' + attempt + '/3); probe=' + (alive ? 'alive' : 'unreachable') + ', ' + Math.round(waitMs / 1000) + 's 后重试')
      await new Promise(r => setTimeout(r, waitMs))
    }
  }
  return false
}

// ---------- 任务编排 ----------
const setupText =
  'We are building a small, self-contained rate-limit microservice together over the next several turns. '
  + 'First I will give you a set of constraints one at a time — remember each, I will ask about them later. '
  + 'Then we will implement it file by file using your file tools (write_file, read_file, edit_file). '
  + 'The working directory is the task sandbox; start from scratch, there is no existing code. '
  + 'Work carefully and precisely.' + citeCue

const factText = (k: number): string =>
  'Note (keep it; no acknowledgment needed): ' + FACTS[k - 1].embed + '. '
  + 'Also, use the read tool to read the file ctx/ctx-' + k + '.md and just confirm you read it.'

// 实现段 24 条 prompt（轮 12-35），每文件首行 marker 逐字给出；F6 伪提示 + 3 报错纠正 + 3 验收问
const implPrompts: string[] = [
  // 12 write config.ts
  'Start implementing. Create the file config.ts. Its FIRST LINE must be exactly this, character-for-character, with nothing before or after it on that line: `' + markerLine(1, 'config.ts') + '`.'
  + ' The rest is a JSON-backed config loader: export a function loadConfig() that returns { windowSeconds, burst, redisPrefix, svcToken }. Use the service token and the redis key prefix I gave you earlier as the defaults, and remember the config format is JSON.' + citeCue,
  // 13 验收 Q1（读回 config.ts）
  'Before moving on, use the read tool to read config.ts back and answer statically (do not guess): with the defaults I specified, what are the exact values of svcToken and redisPrefix that loadConfig() returns?' + citeCue,
  // 14 write window.ts（故意留与 F6 矛盾的伪提示：滑动窗口）
  'Create the file window.ts. Its FIRST LINE must be exactly this: `' + markerLine(2, 'window.ts') + '`.'
  + ' The rest is a windowing helper: export alignWindow(epochSeconds). For now I think a plain sliding window is fine, so implement it that way.' + citeCue,
  // 15 报错纠正 1（window.ts 改 epoch 对齐）
  'Hold on — I need to correct myself on window.ts. The window must be aligned to the epoch minute (truncated to whole minutes), NOT a sliding window. Please use the edit tool to change window.ts so alignWindow() truncates epochSeconds to whole minutes.' + citeCue,
  // 16 write counter.ts
  'Create the file counter.ts. Its FIRST LINE must be exactly this: `' + markerLine(3, 'counter.ts') + '`.'
  + ' The rest is an in-memory token counter with burst support: export a RateCounter class with incr() and reset(). Use the burst limit value I gave you earlier (128).' + citeCue,
  // 17 验收 Q2（counter.ts 静态追踪）
  'Use the read tool to read counter.ts back and answer statically (do not run it): with burst = 128, what does the 129th incr() within a single window return? Trace the code and give me the return value.' + citeCue,
  // 18 write store.ts（含深埋常量）
  'Create the file store.ts. Its FIRST LINE must be exactly this: `' + markerLine(4, 'store.ts') + '`.'
  + ' The rest is a key-value store adapter. In the MIDDLE of the file, include this exact line, verbatim, character-for-character: `export const STORE_BUCKET_EPOCH = ' + STORE_EPOCH + ';` It is used to align bucket epochs.' + citeCue,
  // 19 报错纠正 2（store.ts 加 makeKey）
  'In store.ts, I want the store key to combine the redis prefix I gave you earlier with the bucket epoch. Please use the edit tool to add a makeKey(bucketEpoch) helper that combines the redis prefix and STORE_BUCKET_EPOCH.' + citeCue,
  // 20 读回 store.ts
  'Use the read tool to read store.ts back and confirm three things: (a) the first-line marker, (b) the exact STORE_BUCKET_EPOCH value, (c) the makeKey helper signature.' + citeCue,
  // 21 write router.ts
  'Create the file router.ts. Its FIRST LINE must be exactly this: `' + markerLine(5, 'router.ts') + '`.'
  + ' The rest is an HTTP-style router (no framework, pure functions) that returns 429 when rate-limited. The 429 response body must include the retry-after-ms field I specified, and map failures to the error codes I gave you.' + citeCue,
  // 22 验收 Q3（router.ts 静态）
  'Use the read tool to read router.ts back and answer statically: when a request is rate-limited, what is the exact field name in the 429 body, and what are the three error-code identifiers this file can return?' + citeCue,
  // 23 write middleware.ts
  'Create the file middleware.ts. Its FIRST LINE must be exactly this: `' + markerLine(6, 'middleware.ts') + '`.'
  + ' The rest is a middleware that wraps the handler, applies the rate limiter, and on timeout (use the timeout budget I gave you) fails open.' + citeCue,
  // 24 报错纠正 3（middleware.ts fail-open + 日志）
  'In middleware.ts, make sure the timeout path explicitly fails open (allows the request through on timeout) and logs to the log file path I gave you earlier. Use the edit tool.' + citeCue,
  // 25 write ratelimit.test.ts（含深埋断言）
  'Create the file ratelimit.test.ts. Its FIRST LINE must be exactly this: `' + markerLine(7, 'ratelimit.test.ts') + '`.'
  + ' The rest is a plain-assertion test file (no framework) covering the burst boundary. In the MIDDLE of the file, include this exact line, verbatim: `expect(retries).toBe(' + TEST_RETRIES + ');` Also cover the three burst-boundary cases I specified (127, 128, 129).' + citeCue,
  // 26 读回 test.ts
  'Use the read tool to read ratelimit.test.ts back and confirm the first-line marker, the exact retries assertion value, and the three boundary cases.' + citeCue,
  // 27 write README.md
  'Create the file README.md. Its FIRST LINE must be exactly this: `' + markerLine(8, 'README.md') + '`.'
  + ' The rest is a short readme describing the mini rate-limit microservice, including the log file path I specified and the config file format.' + citeCue,
  // 28 读回 README
  'Use the read tool to read README.md back and confirm the first-line marker and the log path it mentions.' + citeCue,
  // 29 读回核对（保留：制造 read→edit→read 版本链）
  'Consistency pass: use the read tool to read config.ts and counter.ts back and tell me — does config.ts use JSON (not YAML), and does counter.ts use the burst value I specified?' + citeCue,
  // 30-34 压载读轮（5×读 ref-module.ts 真实模块，~25K token/次，把上下文顶过 160K 触发线 → 触发真实压缩）
  'Now switch to the reference module I mentioned. Use the read tool to read ref-module.ts (it is a sizeable TypeScript source file, read it in full) and tell me: what is the name of the exported function that extracts the cites JSON block from the end of an A message?' + citeCue,
  'Read ref-module.ts again (use the read tool, in full) and answer: what is the name of the method that performs the in-place context compaction / pruning pass?' + citeCue,
  'Read ref-module.ts once more (use the read tool, in full). In its recall tool budget logic, how many recall calls are allowed per turn before the budget is exceeded?' + citeCue,
  'Read ref-module.ts again (use the read tool, in full) and describe, in one or two sentences, what the engine does when a model request returns a context-window-exceeded error.' + citeCue,
  'Read ref-module.ts one final time (use the read tool, in full) and confirm two things: (a) does it export a function named scaleBudgets, and (b) what is the name of the method that decides whether to compact based on current context pressure?' + citeCue,
  // 35 最终预检（保留：末段膨胀 + 值重申）
  'Final pre-check: use the read tool to read config.ts, window.ts, store.ts, and ratelimit.test.ts back, and restate the service token, the window alignment strategy, STORE_BUCKET_EPOCH, and the retries assertion value.' + citeCue,
]

// 探针段（轮 36-45，10 个双针）
interface UProbe { factId: number; question: string; match: (a: string) => boolean }
interface RProbe { kind: 'marker' | 'deep'; file: string; value: string; targetDesc: string; hint: string; match: (a: string) => boolean }
const U_PROBES: UProbe[] = [
  // match 入参已是小写归一（判决处传 a.toLowerCase()）；期望值统一小写
  { factId: 3, question: 'What is the burst limit value I specified for the rate limiter?', match: (a) => a.includes('128') },
  { factId: 8, question: 'What are the three error-code identifiers I specified? (comma-joined)', match: (a) => a.includes('rl_exceeded') },
  { factId: 1, question: 'What is the exact service token value I specified? (it starts with TK-)', match: (a) => a.includes('tk-' + code(101).toLowerCase()) },
  { factId: 7, question: 'Which three burst-boundary test cases did I require?', match: (a) => a.includes('127') && a.includes('128') && a.includes('129') },
  { factId: 10, question: 'What is the timeout budget, and what does the system do on timeout?', match: (a) => a.includes('50') && (a.includes('fail open') || a.includes('fails open') || a.includes('fail-open')) },
  { factId: 4, question: 'What is the exact field name that must appear in the 429 response body?', match: (a) => a.includes('retry-after-ms') },
  { factId: 9, question: 'Which config file format did I specify — JSON or YAML?', match: (a) => a.includes('json') && !a.includes('yaml') },
  { factId: 6, question: 'How is the rate-limit window aligned — a sliding window, or truncated to the epoch minute?', match: (a) => a.includes('epoch') },
  { factId: 5, question: 'What is the exact log file path I specified?', match: (a) => a.includes(code(105).toLowerCase()) },
  { factId: 2, question: 'What is the exact Redis key prefix I specified? (it starts with rl:prod:)', match: (a) => a.includes('rl:prod:' + code(102).toLowerCase()) },
]
const R_PROBES: RProbe[] = [
  // match 入参已是小写归一；marker 期望值 code() 全大写 → 期望小写
  { kind: 'marker', file: 'config.ts', value: marker(1), targetDesc: 'the full RLX-1-MARKER token from config.ts first line', hint: 'the read_file tool result for config.ts whose first line begins with "// edge-rl config.ts"', match: (a) => a.includes(marker(1).toLowerCase()) },
  { kind: 'marker', file: 'window.ts', value: marker(2), targetDesc: 'the full RLX-2-MARKER token from window.ts first line', hint: 'the read_file tool result for window.ts whose first line begins with "// edge-rl window.ts"', match: (a) => a.includes(marker(2).toLowerCase()) },
  { kind: 'marker', file: 'counter.ts', value: marker(3), targetDesc: 'the full RLX-3-MARKER token from counter.ts first line', hint: 'the read_file tool result for counter.ts whose first line begins with "// edge-rl counter.ts"', match: (a) => a.includes(marker(3).toLowerCase()) },
  { kind: 'deep', file: 'store.ts', value: String(STORE_EPOCH), targetDesc: 'the exact numeric value of STORE_BUCKET_EPOCH in store.ts', hint: 'the read_file tool result for store.ts that contains "STORE_BUCKET_EPOCH"', match: (a) => a.includes(String(STORE_EPOCH)) },
  { kind: 'marker', file: 'store.ts', value: marker(4), targetDesc: 'the full RLX-4-MARKER token from store.ts first line', hint: 'the read_file tool result for store.ts whose first line begins with "// edge-rl store.ts"', match: (a) => a.includes(marker(4).toLowerCase()) },
  { kind: 'marker', file: 'router.ts', value: marker(5), targetDesc: 'the full RLX-5-MARKER token from router.ts first line', hint: 'the read_file tool result for router.ts whose first line begins with "// edge-rl router.ts"', match: (a) => a.includes(marker(5).toLowerCase()) },
  { kind: 'deep', file: 'ratelimit.test.ts', value: String(TEST_RETRIES), targetDesc: 'the exact number in the expect(retries).toBe(...) assertion in ratelimit.test.ts', hint: 'the read_file tool result for ratelimit.test.ts that contains "expect(retries)"', match: (a) => a.includes(String(TEST_RETRIES)) },
  { kind: 'marker', file: 'middleware.ts', value: marker(6), targetDesc: 'the full RLX-6-MARKER token from middleware.ts first line', hint: 'the read_file tool result for middleware.ts whose first line begins with "// edge-rl middleware.ts"', match: (a) => a.includes(marker(6).toLowerCase()) },
  // probe 9：压载深埋值 A——ref-module.ts 里提取 cites JSON 块的导出函数名
  // （该值只出现在被剪的 ref-module.ts 读回结果里，逼 recall_pruned 找回）
  { kind: 'deep', file: 'ref-module.ts', value: 'extractcites', targetDesc: 'the exported function name in ref-module.ts that extracts the cites JSON block from the end of an A message', hint: 'a read_file tool result for ref-module.ts that contains that function definition', match: (a) => a.includes('extractcites') },
  // probe 10：压载深埋值 B——ref-module.ts 里执行上下文压缩/剪枝的方法名
  { kind: 'deep', file: 'ref-module.ts', value: 'compactifneeded', targetDesc: 'the method name in ref-module.ts that performs the in-place context compaction / pruning pass', hint: 'a read_file tool result for ref-module.ts that contains that method', match: (a) => a.includes('compactifneeded') },
]
const probeText = (label: string, u: UProbe, r: RProbe): string => {
  return 'Long-term memory check ' + label + '.\n\n'
    + 'Part U — answer from the constraints I gave you earlier (they are still in our conversation):\n' + u.question + '\n'
    + 'Put that value on the U-ANSWER line.\n\n'
    + 'Part R — if the target value below is not currently visible in your context, recover it with recall_pruned: call recall_pruned on the pruned placeholders one at a time until you find ' + r.hint + '. Then copy the exact target value. Do not guess.\n'
    + 'Target: ' + r.targetDesc + '\n'
    + 'Put it on the R-ANSWER line. If you cannot recover it after trying recall_pruned on all placeholders, write NOT-RECOVERABLE.\n\n'
    + 'Reply with exactly two lines and nothing else:\n'
    + 'U-ANSWER: <value>\n'
    + 'R-ANSWER: <value or NOT-RECOVERABLE>'
}

const wrapPrompts: string[] = [
  'Now use the read tool to read ALL eight files back in full, and give a one-line status for each (exists? first-line marker intact?).' + citeCue,
  'Use the read tool to read config.ts, store.ts, and ratelimit.test.ts back, and restate: the service token, the redis prefix, STORE_BUCKET_EPOCH, the retries assertion value, and the three error codes.' + citeCue,
  'Summarize the complete file inventory (all eight files with their first-line markers) and confirm the config format and the log path.' + citeCue,
  'Use the read tool to read window.ts and router.ts back. Confirm epoch-minute alignment and the 429 retry-after-ms field, then restate the timeout budget and fail-open behavior.' + citeCue,
  'Final closing checklist: list the ten constraints I gave you (service token, redis prefix, window/burst, 429 field, log path, window alignment, boundary test cases, error codes, config format, timeout) with the exact value for each. Then we are done.' + citeCue,
]

type Item = { label: string; text: string; kind: 'setup' | 'fact' | 'impl' | 'probe' | 'wrap'; factK?: number; uProbe?: UProbe; rProbe?: RProbe; probeMark?: string }
const SMOKE = MAX_TURNS < 50
// 冒烟序列（ARGP_MAX_TURNS=8）：setup + 2 事实 + 3 write + 1 edit + 1 探针，
// 专门命中装配 / 文件落盘 / edit 工具 / 探针两行解析（设计稿 §8.2）。
// 探针问 F1（服务令牌，冒烟里 fact-1 已埋）+ 找 config.ts marker（smoke-write-config 已写）——二者都真实出现过，信号干净。
const smokePlan: { text: string; kind: Item['kind']; label: string; factK?: number; uProbe?: UProbe; rProbe?: RProbe }[] = [
  { text: setupText, kind: 'setup', label: 'setup' },
  { text: factText(1), kind: 'fact', label: 'fact-1', factK: 1 },
  { text: implPrompts[0], kind: 'impl', label: 'smoke-write-config' },   // write config.ts
  { text: factText(2), kind: 'fact', label: 'fact-2', factK: 2 },
  { text: implPrompts[2], kind: 'impl', label: 'smoke-write-window' },   // write window.ts（含伪提示）
  { text: implPrompts[4], kind: 'impl', label: 'smoke-write-counter' },  // write counter.ts
  { text: implPrompts[3], kind: 'impl', label: 'smoke-edit-window' },    // edit window.ts 纠正 epoch
  { text: probeText('smoke-probe-1', U_PROBES[2], R_PROBES[0]), kind: 'probe', label: 'smoke-probe-1', uProbe: U_PROBES[2], rProbe: R_PROBES[0], probeMark: 'Long-term memory check smoke-probe-1' },
]
const items: Item[] = []
if (SMOKE) {
  for (const s of smokePlan.slice(0, Math.min(MAX_TURNS, smokePlan.length))) {
    items.push({ label: s.label, text: s.text, kind: s.kind, factK: s.factK, uProbe: s.uProbe, rProbe: s.rProbe })
  }
  console.log('[info] SMOKE mode: ' + items.length + ' turns（write/edit/probe 压缩序列）')
} else {
  items.push({ label: 'setup', text: setupText, kind: 'setup' })
  for (let turn = 2; turn <= MAX_TURNS; turn += 1) {
    if (turn >= 2 && turn <= 11) {
      const k = turn - 1
      items.push({ label: 'fact-' + k, text: factText(k), kind: 'fact', factK: k })
    } else if (turn >= 12 && turn <= 35) {
      const idx = turn - 12
      items.push({ label: 'impl-' + idx, text: implPrompts[idx], kind: 'impl' })
    } else if (turn >= 36 && turn <= 45) {
      const p = turn - 35
      const mark = 'Long-term memory check probe-' + p
      items.push({ label: 'probe-' + p, text: probeText('probe-' + p, U_PROBES[p - 1], R_PROBES[p - 1]), kind: 'probe', uProbe: U_PROBES[p - 1], rProbe: R_PROBES[p - 1], probeMark: mark })
    } else if (turn >= 46 && turn <= 50) {
      const idx = turn - 46
      items.push({ label: 'wrap-' + idx, text: wrapPrompts[idx], kind: 'wrap' })
    }
  }
}

const startedAt = Date.now()
const turnLog: { label: string; ok: boolean; boundariesAfter: number; seconds: number }[] = []
let consecutiveFailedTurns = 0
let aborted = false
for (const item of items) {
  const turnStart = Date.now()
  const ok = await runTurn(item.text)
  const boundariesAfter = argp ? argp.records.length : countCompactions([...agent.session.events])
  turnLog.push({ label: item.label, ok, boundariesAfter, seconds: Math.round((Date.now() - turnStart) / 1000) })
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

function countCompactions(events: { type: string }[]): number {
  return events.filter(e => e.type === 'compaction/start').length
}

const events = [...agent.session.events]

// ---------- turn 映射（判决用，与 06 同源：按文案 marker 匹配 user/message，取所属轮） ----------
const promptMarkers = new Map<string, string>([
  ['setup', 'rate-limit microservice together over the next several turns'],
  ...items.filter(i => i.kind === 'fact').map(i => ['fact-' + i.factK, 'ctx/ctx-' + String(i.factK) + '.md'] as [string, string]),
  ...items.filter(i => i.kind === 'impl').map(i => [i.label, implMarker(i.label) as string] as [string, string]),
  ...items.filter(i => i.kind === 'probe').map(i => [i.label, i.probeMark ?? ''] as [string, string]),
  ...items.filter(i => i.kind === 'wrap').map(i => [i.label, wrapMarker(i.label) as string] as [string, string]),
])
function implMarker(label: string): string | undefined {
  const idx = Number(label.slice(5))
  const t = implPrompts[idx] ?? ''
  // 取该 prompt 里独有的稳定片段
  const m = t.match(/Create the file ([\w.]+)\.|read ([\w.]+) back|all eight files/)
  return m ? (m[1] ?? m[2] ?? 'all eight files') : undefined
}
function wrapMarker(label: string): string | undefined {
  const idx = Number(label.slice(5))
  const t = wrapPrompts[idx] ?? ''
  const m = t.match(/(ALL eight files back in full|closing checklist: list the ten constraints|complete file inventory|epoch-minute alignment and the 429|service token, the redis prefix)/)
  return m ? m[1] : undefined
}
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

/** 从 surface 推导 LLM 消息并按块形状扫描孤儿（同 06）。 */
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
const boundaries = argp ? argp.records.length : starts
const orphans = orphanReport()
const completedTurns = turnLog.filter(t => t.ok).length
// A 臂 checkpoint 完整性（tombstone 事件 source=plugin/compact）。
// 例外：R 独立剪枝的 tool tombstone 是 tool/result 内文改写（edba7bf），
// 事件 data 无 source 字段——这类事件存在且非空即视为合法。
const checkpointOk = argp
  ? argp.records.every(r => r.intervals.every(iv => {
    const event = agent.session.events[iv.tombstoneSeq] as { type: string; data?: { source?: { kind: string; plugin?: string } } }
    if (event === undefined) return false
    if (event.data?.source === undefined) return true // tool-tombstone rewrite
    return event.data.source.kind === 'plugin' && event.data.source.plugin === 'compact'
  }))
  : true
// 冒烟豁免"压缩量"门槛（上下文仅 ~5K，远低于 160K 触发线，本就不该压缩）；
// 但装配一致性（事务事件 start/summary/end 配对、孤儿、checkpoint source）仍全查。
const l1MinBoundariesOk = SMOKE ? true : boundaries >= minBoundaries
verdict('L1-long-run-stable', !aborted && completedTurns === items.length && l1MinBoundariesOk
  && orphans.length === 0 && starts === boundaries && summaries === boundaries
  && ends.length === boundaries && endsWithError === 0 && checkpointOk,
  'turns=' + completedTurns + '/' + items.length + (aborted ? ' (aborted)' : '')
  + (SMOKE ? ' (SMOKE: boundaries 门槛豁免)' : '')
  + '; arm=' + arm + '; boundaries=' + boundaries + '; orphans=' + orphans.length
  + '; tx start/summary/end=' + starts + '/' + summaries + '/' + ends.length + ' (error=' + endsWithError
  + '); checkpoint source=compact:' + checkpointOk)

// ---------- 误差曲线：逐 probe 判 U/R 双针 ----------
const shadowedAll = argp ? new Set(argp.records.flatMap(r => r.shadowedSeqs)) : new Set<number>()
interface CurvePoint {
  probe: number; turn: number; boundaries: number
  uCorrect: boolean; rCorrect: boolean; targetShadowed: boolean
  recallCallsAtProbe: number; uAnswer: string; rAnswer: string; uFactId: number; rFile: string
}
const curve: CurvePoint[] = []
// recall 归属：按事件流计 probe 轮内 recall_pruned 的 tool/call 次数（06 已证 engine.recallCalls 增量口径不可靠）
const recallToolCalls = events.filter(e => e.type === 'tool/call' && (e.data as { name?: string }).name === 'recall_pruned')
let probeSeq = 0
for (const item of items.filter(i => i.kind === 'probe')) {
  const u = item.uProbe
  const r = item.rProbe
  if (u === undefined || r === undefined) continue
  probeSeq += 1
  const p = probeSeq
  const turn = turnOf.get(item.label) ?? -1
  const raw = events.filter(e => e.type === 'assistant/message' && (e.data as { turn?: number }).turn === turn)
    .map(e => eventRawText(e)).join('\n')
  const uMatch = raw.match(/U-ANSWER:\s*(.+)/)
  const rMatch = raw.match(/R-ANSWER:\s*(.+)/)
  // 小写归一后匹配（match 期望值均为小写）；result.json 记录归一值
  const uAnswer = (uMatch?.[1] ?? '').trim().toLowerCase()
  const rAnswer = (rMatch?.[1] ?? '').trim().toLowerCase()
  const uCorrect = uAnswer.length > 0 && uAnswer !== 'not-recoverable' && u.match(uAnswer)
  const rCorrect = rAnswer.length > 0 && rAnswer !== 'not-recoverable' && r.match(rAnswer)
  // 目标是否已遮蔽：事件文本含目标值的 tool/result 全部 shadowed（A 臂；B 臂无 shadowed 集 → false）
  const targetSeqs = events.filter(e => e.type === 'tool/result' && eventRawText(e).toUpperCase().includes(r.value.toUpperCase())).map(e => e.seq)
  const targetShadowed = argp !== null && targetSeqs.length > 0 && targetSeqs.every(seq => shadowedAll.has(seq))
  const boundariesAtProbe = turnLog.find(t => t.label === item.label)?.boundariesAfter ?? boundaries
  const probeRecalls = recallToolCalls.filter(e => (e.data as { turn?: number }).turn === turn)
  curve.push({
    probe: p, turn, boundaries: boundariesAtProbe,
    uCorrect, rCorrect, targetShadowed,
    recallCallsAtProbe: probeRecalls.length,
    uAnswer, rAnswer, uFactId: u.factId, rFile: r.file,
  })
  console.log('[probe ' + p + '] boundaries=' + boundariesAtProbe
    + ' U(F' + u.factId + ']=' + (uCorrect ? 'OK' : 'MISS(' + uAnswer.slice(0, 40) + ')')
    + ') R(' + r.file + ']=' + (rCorrect ? 'OK' : 'MISS(' + rAnswer.slice(0, 40) + ')')
    + ') shadowed=' + targetShadowed + ' recall=' + probeRecalls.length)
}
const uCorrectCount = curve.filter(p => p.uCorrect).length
const rCorrectCount = curve.filter(p => p.rCorrect).length
const uThreshold = Math.max(1, Math.round(curve.length * 0.8))
const rThreshold = Math.max(1, Math.round(curve.length * 0.7))
verdict('L2-u-protection', uCorrectCount >= uThreshold,
  'U probes correct ' + uCorrectCount + '/' + curve.length + '（U 针永不参剪，surface 直读）')
verdict('L3-r-recovery', rCorrectCount >= rThreshold,
  'R probes correct ' + rCorrectCount + '/' + curve.length + '（目标已遮蔽 ' + curve.filter(p => p.targetShadowed).length
  + '/' + curve.length + '；recall 调用总量 ' + recallToolCalls.length
  + '；B 臂无 recall_pruned，预期不可达，如实记录）')
console.log('[METRIC error-curve] ' + JSON.stringify(curve.map(p => ({ probe: p.probe, b: p.boundaries, u: p.uCorrect ? 1 : 0, r: p.rCorrect ? 1 : 0, sh: p.targetShadowed ? 1 : 0, rc: p.recallCallsAtProbe }))))

// ---------- L4 functional（软，记录不硬卡） ----------
const writtenFiles = FILES.map(f => path.join(workDir, f.name)).filter(p => fs.existsSync(p))
const markerIntact = FILES.filter(f => {
  const p = path.join(workDir, f.name)
  if (!fs.existsSync(p)) return false
  const firstLine = fs.readFileSync(p, 'utf8').split('\n')[0]?.trim() ?? ''
  return firstLine.includes(marker(f.j))
}).length
// 伪提示纠正：window.ts 最终是否含 epoch 对齐而非滑动窗口（软探针，仅记录）
let windowEpochCorrect = false
{
  const wp = path.join(workDir, 'window.ts')
  if (fs.existsSync(wp)) {
    const wc = fs.readFileSync(wp, 'utf8').toLowerCase()
    windowEpochCorrect = wc.includes('epoch') || wc.includes('floor') || wc.includes('truncat') || wc.includes('60')
  }
}
// 冒烟只写 3 个文件（config/window/counter），正式跑 8 个
const expectedFiles = SMOKE ? 3 : 8
const requiredMarkers = SMOKE ? 3 : 7
verdict('L4-functional-soft', writtenFiles.length === expectedFiles && markerIntact >= requiredMarkers,
  'files written ' + writtenFiles.length + '/' + expectedFiles + (SMOKE ? ' (SMOKE)' : '')
  + '; markers intact ' + markerIntact + '/' + expectedFiles + '; window epoch-aligned(corrected)= ' + windowEpochCorrect)

// ---------- citeStats / 边密度 / recall 命中（A 臂 METRIC） ----------
const citeStats = argp ? argp.citeStats : { declared: 0, resolved: 0 }
// 原子数（A 臂）：surface 节点数近似
const atomCount = argp ? argp.records.reduce((s, r) => s + r.intervals.length, 0) : 0
const edgeDensity = atomCount > 0 ? (citeStats.resolved / atomCount) : 0
console.log('[METRIC cites] declared=' + citeStats.declared + ' resolved=' + citeStats.resolved
  + ' atoms≈' + atomCount + ' edgeDensity≈' + edgeDensity.toFixed(3)
  + (argp ? ' recallCalls=' + argp.recallCalls.length + ' hit=' + argp.recallCalls.filter(c => c.hit).length : ''))

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
  arm,
  at: new Date().toISOString(),
  model: modelMount.provider + '/' + modelMount.model,
  reasoning: modelMount.reasoning,
  contextWindow,
  windowTokens: argp ? argp.windowTokens : Math.floor(contextWindow * 0.8),
  retainTokens: argp ? argp.retainTokens : retainTokens,
  maxPasses,
  minBoundaries,
  wallSeconds: Math.round((Date.now() - startedAt) / 1000),
  turnsPlanned: items.length,
  turnsCompleted: completedTurns,
  aborted,
  pruneTransactions: boundaries,
  shadowedNodes: argp ? argp.records.reduce((sum, r) => sum + r.shadowedSeqs.length, 0) : 0,
  curve,
  uCorrect: uCorrectCount,
  rCorrect: rCorrectCount,
  filesWritten: writtenFiles.length,
  markersIntact: markerIntact,
  windowEpochCorrected: windowEpochCorrect,
  recallToolCalls: recallToolCalls.length,
  citeStats,
  edgeDensityApprox: Number(edgeDensity.toFixed(4)),
  reasoningChars,
  surfaceCharsEnd: surfaceChars,
  surfaceTokensEndApprox: Math.ceil(surfaceChars / 3.5),
  turnStats,
  turnLog,
  records: argp ? argp.records : null,
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
  ? 'SPIKE 26 (' + arm + ') VERDICT: PASS（real-coding 50 轮：稳定 + U 保护 + R 找回 + 功能软判）'
  : 'SPIKE 26 (' + arm + ') VERDICT: FAIL（' + failures.length + ' 项未过：' + failures.join('; ') + '）')
process.exit(failures.length === 0 ? 0 : 1)
