/**
 * spike 8：game.html 真实编码 trace（拉爆上下文版）
 *
 * 目的：用真实大文件（game.html，1137 行 / 单次 read ≈ 15K token）跑一条多需求迭代任务，
 *   把 surface 涨到触发压缩，观察 ARGP 在真实大文件场景的完整链路：
 *   1. 重复读频率 + 版本链去重（θ=0.8）在「read→edit→read 同一文件」迭代里的实际剪除量
 *   2. edit old_string 是否取自先前 read（决定「砍 result 后 recall 低频/高频」）
 *   3. cites 服从率（语义边稀疏度）
 *   4. 压缩次数 / recall_pruned 触发 / reasoning 是否暴涨 / 成本
 *
 * 与 07 的关键差异：
 *   - 素材：单文件 game.html（15K token/次 read），而非 30 行 store.ts
 *   - windowTokens 默认 80K（读 5 次即触发压缩，让版本链在压缩前累积多版本，07 是 80K 永不触发）
 *   - 验证：每条需求改完 run `node check.js`（JS 语法检查，逼出「改完验证」闭环）
 *   - 需求：10 条真实需求按热点函数分 3 个 batch（聚焦 updatePlayer/buildWave/drawHUD），
 *     每 batch 连续 read→edit 同一函数，压缩前累积多版本 → 逼出版本链去重
 *
 * 产物（spike/out/08-game-trace-<stamp>/）：
 *   - events.jsonl  完整事件流（离线重放）
 *   - trace.json    观测聚合 + turnStats + citeStats + 成本
 *
 * 运行（Windows，bash 5.2 可用）：
 *   node --import ./scripts/ts-import-rewrite-loader.mjs spike/08-game-trace.ts
 * 环境变量：
 *   ARGP_WINDOW_TOKENS（默认 80000）/ ARGP_RETAIN_TOKENS（默认 16000）
 *   ARGP_CONTEXT_WINDOW（默认 200000）/ ARGP_MAX_TURNS（默认 10）
 *   ARGP_DEEPSEEK_THINKING=enabled 时 reasoning=high（观察 cites 档位效应）
 *   ARGP_GAME_HTML（game.html 源路径，默认 C:/Users/LDH/Desktop/game.html）
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
const MAX_TURNS = Number(process.env['ARGP_MAX_TURNS'] ?? 10)
const GAME_HTML_SOURCE = process.env['ARGP_GAME_HTML'] ?? 'C:/Users/LDH/Desktop/game.html'

const watchdog = setTimeout(() => {
  console.log('[FATAL] spike 8 watchdog timeout (150 min)')
  process.exit(2)
}, 150 * 60 * 1000)
watchdog.unref()

// ---------- 产物目录 + 真实工作目录 ----------
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const outDir = path.join(import.meta.dirname, 'out', '08-game-trace-' + stamp)
const workDir = path.join(outDir, 'work')
fs.mkdirSync(workDir, { recursive: true })

// 初始项目文件：game.html（从桌面源复制）+ check.js（语法校验脚本）
const gameHtmlContent = fs.readFileSync(GAME_HTML_SOURCE, 'utf8')
const checkJsContent = [
  "const fs = require('fs');",
  "const s = fs.readFileSync('game.html', 'utf8');",
  "const m = s.match(/<script>([\\s\\S]*)<\\/script>/);",
  "if (!m) { console.log('NO <script> FOUND'); process.exit(1); }",
  "try { new Function(m[1]); console.log('JS syntax OK'); }",
  "catch (e) { console.log('SYNTAX ERROR: ' + e.message); process.exit(1); }",
].join('\n')
fs.writeFileSync(path.join(workDir, 'game.html'), gameHtmlContent, 'utf8')
fs.writeFileSync(path.join(workDir, 'check.js'), checkJsContent, 'utf8')
console.log('[info] game.html 源: ' + GAME_HTML_SOURCE + ' (' + gameHtmlContent.length + ' chars, ' + gameHtmlContent.split('\n').length + ' lines)')

// ---------- 装配 ----------
const ctx = new Context()
await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: 'spike-8 game coding trace persona' } })
await ctx.plugin(AgentLoop, { agents: [] })
const modelMount = await mountModel(ctx)
await ctx.plugin(ArgpGraphEngine, { windowTokens, retainTokens, maxPasses, enableOverlapChain: true })
const engine = ctx.compaction as ArgpGraphEngine

const agent = ctx.agentLoop.create(SessionId('spike-8-game-trace'), {
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

// ---------- 任务编排：10 条真实需求，按热点函数分 3 个 batch（聚焦同函数反复 read→edit→read） ----------
const setupText = 'We are working on a single-file HTML5 bullet-hell shooter game named game.html. It is ~1137 lines with CSS and vanilla JS (no framework, no build step). Use read_file / edit_file / write_file / run_command to accomplish the tasks I give you. IMPORTANT WORKFLOW: (1) read_file game.html first to see the CURRENT code before EVERY edit; (2) prefer edit_file with an exact old_string for small changes (do NOT rewrite the whole file with write_file unless truly necessary); (3) after EVERY edit, run `node check.js` to verify the JS syntax is still valid; (4) keep prior context in mind and do not break unrelated code.'

const stages: string[] = [
  // --- Batch 1：聚焦 updatePlayer() 武器系统（连续 3 次 read→edit，压缩前累积多版本）---
  'WEAPON 1: Player weapon level 4 is overpowered (fires 4 shots including two spread shots in updatePlayer()). Change level 4 to a 3-shot fan (one center + two slight spread). Keep levels 1-2 unchanged. Read game.html, locate the firing section in updatePlayer(), edit, then run `node check.js`.',
  'WEAPON 2: Now give weapon level 3 a slight spread (about ±10 degrees) too, distinct from level 4. Read game.html again (it changed since last read), locate updatePlayer(), edit the level-3 branch, then run `node check.js`.',
  'WEAPON 3: Add a charge-shot mechanic in updatePlayer(): while holding Space, a charge meter builds; releasing Space fires a stronger piercing bullet if fully charged. Read game.html again, edit updatePlayer() (firing + fireCd logic), then run `node check.js`.',
  // --- Batch 2：聚焦 buildWave + spawnEnemy（难度/敌人，跨一次压缩）---
  'ENEMY 1: In buildWave(), the shooter formula `n >= 2 ? 1 + n : 0` grows too fast (6 shooters by wave 5). Change it to `1 + Math.floor(n / 2)`. Read game.html, locate buildWave(), edit, then run `node check.js`.',
  'ENEMY 2: Bug + feature. (a) The tank formula `n >= 4 ? Math.floor((n - 2) / 3) : 0` yields 0 at n=4 so tanks never spawn on wave 4 — fix to `n >= 4 ? 1 + Math.floor((n - 4) / 3) : 0`. (b) Add an elite variant: normal enemies have 8% chance to be elite with an extra breakable shield of 3 points (consumed before HP), gold tint, and 2x score. Read game.html, edit buildWave()/spawnEnemy()/ENEMY_DEF/updateCollisions()/drawEnemies(), then run `node check.js`.',
  'ENEMY 3: Adjust drop rates: grunt drop chance 0.07 is too low; raise grunt/shooter/darter drop rates modestly and guarantee at least one drop from a boss. Read game.html, edit killEnemy()/dropPower(), then run `node check.js`.',
  // --- Batch 3：聚焦 updatePlayer + drawHUD（僚机/护盾/结算，再跨一次压缩）---
  'FEATURE 1: Add a drone (僚机) system. New powerup `G` (drone) spawns a drone (max 2); drones follow the player, auto-fire periodically, and get stronger with weapon level. This touches game state (drones array + resetGame), POWER_DEF/dropPower/applyPower, updatePlayer() (drone movement + firing), and draw functions. Read game.html thoroughly, implement across all needed areas, then run `node check.js`.',
  'FEATURE 2: Add shield regeneration. When the shield (p.shield) runs out, start a 3-second cooldown; when it ends, auto-refill to 2 seconds of shield. Distinguish picked-up 6s shield from regenerated 2s shield with a comment. Read game.html, edit updatePlayer()/hitPlayer()/applyPower(), then run `node check.js`.',
  'FEATURE 3: Combo multiplier caps at 24 (x2.2) in killEnemy() via `Math.min(game.combo, 24) * .05`. Raise the cap to 40 (x3.0) and update the combo bar width in drawHUD(). Read game.html, edit both places, then run `node check.js`.',
  'FEATURE 4: Add a stats panel to the game-over screen showing this run\'s kills, survival time, max combo, and powerups collected; also persist historical max combo to localStorage. Read game.html, edit gameOver()/game state/HTML overlay section, then run `node check.js`.',
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

// ---------- 观测 1：重复读频率 ----------
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

// ---------- 观测 2：edit old_string 是否来自先前 read ----------
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

// ---------- 观测 3：cites 服从率 ----------
let assistantMessages = 0, withCites = 0, totalCites = 0, citesFailed = 0
for (const e of events) {
  if (e.type !== 'assistant/message') continue
  assistantMessages += 1
  const ac = (e.data as { argpCites?: unknown[] }).argpCites
  if (Array.isArray(ac) && ac.length > 0) { withCites += 1; totalCites += ac.length }
}

// ---------- 成本（同 06c 口径）----------
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
  spike: '08-game-trace',
  at: new Date().toISOString(),
  model: DEEPSEEK_PROVIDER + '/' + DEEPSEEK_MODEL,
  reasoning: modelMount.reasoning,
  windowTokens, retainTokens, contextWindow, maxPasses,
  gameHtmlSource: GAME_HTML_SOURCE,
  gameHtmlChars: gameHtmlContent.length,
  wallSeconds: Math.round((Date.now() - startedAt) / 1000),
  turnsPlanned: allTurns.length,
  turnsCompleted: turnLog.filter(t => t.ok).length,
  readPattern: { totalReads, uniqueReadPaths, rereads, rereadPathCounts: rereadPaths, readPaths },
  editPattern: {
    totalEdits: editOps.length,
    editFromRead, editNotFromRead,
    editSourceDetail,
    editOps: editOps.map(o => ({ seq: o.seq, turn: o.turn, path: o.path, oldStringLen: o.oldString.length, oldStringHead: o.oldString.slice(0, 120) })),
  },
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

console.log('=== spike 8 trace 摘要 ===')
console.log('[read] 总读 ' + totalReads + ' 次 / 唯一文件 ' + uniqueReadPaths + ' / 重复读 ' + rereads + ' 次')
console.log('[read] 重复读 TOP: ' + rereadPaths.slice(0, 5).map(([p, n]) => p + ' x' + n).join(', '))
console.log('[edit] 总编辑 ' + editOps.length + ' 次 / old_string 取自 read ' + editFromRead + ' / 未取自 ' + editNotFromRead)
console.log('[cites] assistant 消息 ' + assistantMessages + ' / 带 cites ' + withCites + ' / declares ' + totalCites + ' (服从率 ' + (assistantMessages > 0 ? (100 * withCites / assistantMessages).toFixed(1) : 0) + '%)')
console.log('[compress] 压缩次数 ' + engine.records.length + ' / surface 末字符 ' + surfaceChars + ' (≈' + Math.ceil(surfaceChars / 3.5) + ' token)')
console.log('[cost] ¥' + cost.toFixed(3) + '; cacheHit=' + hitRate.toFixed(1) + '%')
console.log('[info] artifacts: ' + outDir)

await ctx.fiber.dispose()
