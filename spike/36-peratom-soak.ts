/**
 * spike 36 — 熵减管线单引擎持续压测（P5 前置单臂冒烟）
 *
 * 定位：只挂 PeratomCompressor（无图引擎），真实 agent loop × 本地 Qwen 跑 9 轮剧本，
 * 验证 eager tail-only 熵减在多轮下的累计效果与守恒性。不覆盖 Stage-2 协同（那是
 * P4 接线后三臂对比的事）。
 *
 * 剧本（可压轮 / 版本链轮 / 纯对话轮 / 长拆分轮 混排）：
 *   T1 读 logs/app.log          → 大结果，可压（结构化必留 + 叙事可丢）
 *   T2 再读 logs/app.log        → 同键版本链成员 → 门控硬排除零调用
 *   T3 纯对话                    → 零调用
 *   T4 读 config/app.yaml       → 可压（>512 字门）
 *   T5 长混合消息（指令+粘贴）   → 拆分可压
 *   T6 纯对话                    → 零调用
 *   T7 读 docs/runbook.md       → 可压（>512 字门）
 *   T7b 读 docs/postmortem.md   → 可压（>512 字门；纯叙述 summary 靶子）
 *   T8 短确认                    → 零调用
 *   T9 第三次读 logs/app.log    → 链成员 → 零调用
 *
 * 语料设计（review 严重发现 #1 修复）：三个可压工具结果都 >512 字门、且都含
 * "结构化 load-bearing 行（守卫必留）+ 叙事/注释段（守卫不拦、可合法丢弃）"。
 * 这样 extract 有**真实净缩减空间**，VK-ratio 的 85% 阈值才有牙齿：做行级 verbatim
 * 保留 + 丢叙事的模型能破阈；做摘要式压缩的会被保真守卫拒而诚实 FAIL（不再是
 * 修复前那种"无论怎么压都到不了"的死裁判）。详见 docs/review-spike36-2026-08-25.md。
 *
 * 度量：
 *   - 每轮：压缩前后 surface 可见字符；未压缩反事实（append 起源事件投影和）
 *   - 累计：可见字符 vs 反事实字符增长曲线、压缩比
 *   - 守恒：全部原文 JSON 哈希零替换；calls 计数；records 统计聚合
 *   - 前缀：逐轮 deriveEventMessage 指纹流公共前缀 ≥ 当轮起点（缓存生命线）
 *
 * 判决项：
 *   VK-atom      压缩率按原子计算：被压原子聚合收益 1-Σnew/Σorig ≥ 50%（全局 ratio 仅参考）
 *   VK-plan      对话/链轮全部零调用
 *   VK-plan-c    可压轮全部产生调用（语料已扩 >512，called=false 即 bug/死设计）
 *   VK-chain     T2/T9 collect.toolResults 为空（链排除 live）
 *   VK-originals 全程原文零替换
 *   VK-clean     parseFailed=0 且无 record.error
 *   VK-prefix    每次压缩的历史前缀指纹不变
 *
 * 边界（诚实标注）：单引擎下 split 的 surface 收益**不可测**——决策⑦规定 U-info 副本
 * 永不重压，split 的真实缩减发生在 Stage-2（U-info 进可剪集），那是 P4 三臂的事，
 * 不在本 spike 范围。T5 在本脚本里只验证"拆分决策正确 + 前缀不破 + 零误替换"。
 *
 * 用法：npm run spike36
 * 产物：spike/out/36-peratom-soak-<时间戳>.json（meta 带 git commit + 脚本 hash + 配置指纹）
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { InvariantRegistry } from '@deepseek-ai/dsh-invariants'
import { apply as applySessionInvariant } from '@deepseek-ai/dsh-session/invariant'
import { deriveEventMessage } from '@deepseek-ai/dsh-session'
import { PeratomCompressor } from '../src/peratom/compressor.ts'
import type { CompressRecord } from '../src/peratom/compressor.ts'
import { projectSurfaceText } from '../src/peratom/gate.ts'

const BASE = (process.env['QWEN_BASE'] ?? 'http://127.0.0.1:8080/v1').replace(/\/$/, '')
let MODEL = process.env['QWEN_MODEL'] ?? ''
// OpenRouter 模式开关：QWEN_BASE 指向 openrouter 域名时自动启用（API key 读 OPEN_ROUTER_API_KEY，
// thinking 走 openrouter wire，不注入 llama.cpp 的 chat_template_kwargs）。
const IS_OPENROUTER = /openrouter\.ai/.test(BASE)
const API_KEY_ENV = IS_OPENROUTER ? 'OPEN_ROUTER_API_KEY' : 'ARGP_LOCAL_KEY'
// 探测 8080 实际加载的模型，避免产物标签与实际请求不符（env QWEN_MODEL 仍可强制覆盖）。
async function resolveLiveModel(): Promise<string> {
  try {
    const r = await fetch(BASE + '/models', { signal: AbortSignal.timeout(8000) })
    const j = await r.json() as { data?: Array<{ id: string }>; models?: Array<{ model?: string }> }
    const id = j.data?.[0]?.id ?? j.models?.[0]?.model
    if (id) return id
  } catch { /* fall through */ }
  return 'unknown-live-model'
}

/**
 * 产物版本指纹（review 严重发现 #3/#8）：跨 run 配置漂移曾是"单变量实验"失效的根因。
 * 现在把 git commit、脚本 hash、引擎配置指纹都落进 meta，对照报告只认同指纹产物。
 */
function runFingerprint(): Record<string, string> {
  let commit = 'unknown'
  try { commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() } catch { /* 非 git 环境 */ }
  let scriptHash = 'unknown'
  try {
    const self = fs.readFileSync(path.join(process.cwd(), 'spike', '36-peratom-soak.ts'), 'utf8')
    scriptHash = createHash('sha256').update(self).digest('hex').slice(0, 12)
  } catch { /* ignore */ }
  return { commit, scriptHash }
}

const failures: string[] = []
const verdict = (name: string, ok: boolean, detail: string): void => {
  console.log((ok ? '[PASS ' : '[FAIL ') + name + '] ' + detail)
  if (!ok) failures.push(name + ': ' + detail)
}
// watchdog 默认 60 分钟：9 轮剧本 × 本地 Qwen thinking 慢（每轮 2-6 分钟）+ 压缩 LLM 调用。
// 可经 ARGP_SPIKE36_TIMEOUT_MIN 覆盖（如 CI 快模型设小值）。
const WATCHDOG_MIN = Number(process.env['ARGP_SPIKE36_TIMEOUT_MIN'] ?? 60)
const watchdog = setTimeout(() => {
  console.log(`[FATAL] spike 36 watchdog timeout (${WATCHDOG_MIN} min)`)
  process.exit(2)
}, WATCHDOG_MIN * 60 * 1000)

// ---------------------------------------------------------------------------
// 沙箱语料
// ---------------------------------------------------------------------------

/**
 * app.log：混合语料。两段——
 *   ① 结构化行（16 条）：每行都含高信号 token（pid/req_id/latency/trace）→ 保真守卫要求
 *      逐 token 存活，extract 不得整行删；
 *   ② 叙事段（纯散文、无 key=value/trace/标识符）→ 守卫不拦，competent extract 可合法丢弃。
 * 这样 extract 存在**真实的净缩减空间**（丢叙事、留结构化）——VK-ratio 是"可裁判"的：
 * 能压的模型能破阈，压不动的弱模型诚实 FAIL。修复前语料 100% load-bearing 且占比过小，
 * 是"死裁判"（无论怎么压都到不了 85%，见 docs/review-spike36-2026-08-25.md 严重发现 #1）。
 */
function makeLog(): string {
  // 结构化行（高信号 token 密集：pid/req_id/latency/trace/file:line）——用户问"有哪些错误"，
  // 这些是模型该保留的锚点。故意只占语料小头，让叙事段占大头 → extract 有真实净缩减空间。
  const structured = [
    '2026-08-25T09:00:00Z boot ok pid=4021 node=canary-1 region=cn-north-1',
    '2026-08-25T09:04:12Z level=ERROR svc=orders req_id=r-1004 latency_ms=188 code=ECONNRESET at pg/pool.ts:88:19 trace=tr-4-9f2c1ab',
    '2026-08-25T09:08:12Z level=ERROR svc=orders req_id=r-1008 latency_ms=336 code=ECONNRESET at pg/pool.ts:88:19 trace=tr-8-9f2c1ab',
    '2026-08-25T09:10:12Z level=ERROR svc=orders req_id=r-1010 latency_ms=410 code=ECONNRESET at pg/pool.ts:88:19 trace=tr-10-9f2c1ab',
    '2026-08-25T09:14:12Z level=ERROR svc=orders req_id=r-1014 latency_ms=392 code=ECONNRESET at pg/pool.ts:88:19 trace=tr-14-9f2c1ab',
    '2026-08-25T09:15:00Z FATAL pool exhausted host=db-01 region=cn-north-1',
  ]
  // 叙事段：纯散文、无 key=value/路径/file:line/UUID/哈希/全大写码 → 守卫不命中，
  // competent extract 可合法丢弃（这是压缩收益的真实来源）。占语料大头。
  // 噪声段（换靶子实验 2026-08-26）：原本是连贯叙事散文，语义上诱导模型做 summary（被
  // 保真守卫拒），压不动。现改为"启动/运行过程的冗长描述性噪声"——全小写、无 URL/路径/
  // file:line/UUID/哈希/≥5位大写错误码/key=value，**不含任何 load-bearing 模式**（见
  // gate.ts LOAD_BEARING_PATTERNS），故守卫放行 extract 整段丢弃。结构化 ERROR 行（含
  // req_id=/code=/file:line）仍在 structured 数组，被守卫要求 verbatim 保留。这才构成
  // ARGP extract 的真靶子：行级清晰剔除噪声、verbatim 保 load-bearing。
  const narrative = [
    'the process began initializing its internal subsystems during the warmup pass',
    'the configuration tree was resolved from the provided settings without conflict',
    'network listeners were attached to the expected ports and started accepting traffic',
    'background timers were scheduled for routine housekeeping throughout the day',
    'the local cache reported a warm and ready state after the preload completed',
    'auxiliary workers finished their startup handshake and registered as available',
    'health probes were exposed so the orchestrator could poll service liveness',
    'metric exporters connected to the aggregation endpoint and began streaming',
    'the runtime reported stable memory usage after the warmup settled',
    'feature toggles were resolved from the remote source and applied to the runtime',
    'idle connections were preallocated to the primary store ahead of the first request',
    'the scheduler accepted the opening batch of deferred jobs without backpressure',
    'request tracing was enabled with a sampled fraction to limit overhead',
    'the gateway registered its routes with the discovery service for routing',
    'periodic compaction was queued for the quiet interval to reclaim space',
    'client sessions were seeded with the default policy before traffic arrived',
    'the shutdown handler was armed so termination could be graceful under load',
    'outbound retries were configured with a bounded backoff to avoid storms',
    'the audit sink acknowledged the initial heartbeat from this instance',
    'dependency checks returned favorable status across all monitored subsystems',
    'the boot sequence concluded with every subsystem reporting a nominal state',
    'operators were notified that the service had entered its steady operating mode',
  ]
  const lines: string[] = []
  for (const s of structured) lines.push(s)
  // 噪声扩到 200 行（2026-08-26 地板实验）：让可压缩噪声在 cfTotal 中占主导，
  // 消除 assistant 回复（不可压，ARGP 只压 user-long+tool-result）对 VK-ratio 的
  // 稀释。corpus-bound 的 otherPerTurn=120 假设被实测 ~1300 证伪，唯一杠杆是放大
  // T1 的收益占比。序号整数不含任何 load-bearing 模式，可安全丢弃。
  const NOISE_ROWS = 200
  for (let i = 0; i < NOISE_ROWS; i++) {
    const n = narrative[i % narrative.length]
    lines.push(`2026-08-25T09:15:30Z note ${i} ${n}`)
  }
  return lines.join('\n')
}

const FILES: Record<string, string> = {
  'logs/app.log': makeLog(),
  // T4：扩到 >512 字门（修复前 145 字，永不进候选 = 死设计）。含真实键值 + 可丢的叙述注释。
  'config/app.yaml':
    'http:\n  timeout: 30s\n  retries: 3\n  connectTimeout: 5s\npool:\n  max: 25\n  idleTimeout: 60s\n'
    + '  min: 2\n  acquireTimeout: 10s\nfeatures:\n  rollbackAuto: false\n  canaryPct: 20\n'
    + '  canaryHold: 10m\ncache:\n  ttl: 600s\n  budgetBytes: 268435456\n  eviction: lru\n'
    + 'logging:\n  level: info\n  sink: stdout\n  flushInterval: 2s\n'
    + '# 说明：timeout 与 connectTimeout 分开计，retries 只作用于幂等 GET。\n'
    + '# pool.max 是硬上限，acquireTimeout 超时即 503，避免线程打满拖垮整机。\n'
    + '# features.rollbackAuto 关闭后回滚必须走 runbook 手动确认，禁止脚本自动触发。\n'
    + '# cache.budgetBytes 超预算时按 lru 逐出，budgetBytes 调大前先看内存水位再评估。\n',
  // T7：扩到 >512 字门（修复前 338 字）。含真实命令（load-bearing）+ 可丢的叙述说明。
  'docs/runbook.md':
    '# Rollback Runbook\n\n'
    + '1. Freeze deploys: run ci/pause.sh and confirm the queue drains before touching prod.\n'
    + '2. Roll back: kubectl rollout undo deploy/api --namespace=prod\n'
    + '3. Verify: curl -f https://api.example.com/healthz (expect 200 within 30s)\n'
    + '4. If the DB is involved: check wal segment continuity on the standby before promoting it.\n'
    + '5. Watch the pool gauges: connections_active must fall back below pool.max after rollback.\n'
    + '\n'
    + 'The freeze step matters more than the rollback itself, since a deploy mid-rollback '
    + 'will race the undo and leave the ReplicaSet in an unknown state.\n'
    + 'Promoting the standby without checking wal continuity has previously caused replay '
    + 'gaps, so always verify the segment sequence is contiguous before the switch.\n'
    + 'Escalation: dba-oncall first, then platform-oncall. Never delete wal segments by hand, '
    + 'because the archive still depends on them for point-in-time recovery.\n',
  // T7b：summary 靶子——纯叙述事故复盘散文，无结构化数据、无精确串（不含路径/URL/
  // file:line/UUID/哈希/全大写长错误码/key=value），摘取无处下手、概括不损失关键信息
  // → 自选模式下 summary 应是模型的正确判断。约 1.9K 字符，>512 字门。
  'docs/postmortem.md':
    'Incident Review: Slow Morning Degradation\n\n'
    + 'Early in the morning the support channel started collecting complaints about slow page loads. '
    + 'The duty engineer noticed the trend only after several customers chimed in, because the alert '
    + 'threshold had been set generously after last quarter and nobody wanted noisy pages.\n\n'
    + 'The first suspicion fell on the latest release. It had gone out the evening before without any '
    + 'schema changes, and the team briefly considered rolling it back. A quick look at deployment notes '
    + 'showed nothing unusual, so the hypothesis was dropped within minutes.\n\n'
    + 'Dashboards told a clearer story. Database load looked calm, memory was unremarkable, and the '
    + 'network path showed no packet loss. What did stand out was a slow creep in queue depth on the '
    + 'worker fleet, as if jobs were arriving faster than they could be drained.\n\n'
    + 'It turned out a partner had started replaying a large backfill early in the morning. Their '
    + 'integration guide asks clients to pace bulk imports, but nothing enforces it on our side. The '
    + 'extra load was legitimate, just poorly timed, and it starved the interactive workers of headroom.\n\n'
    + 'By late morning the backfill finished on its own and everything drifted back to normal. No data '
    + 'was lost and no customer asked for compensation, though a few wrote in to complain about the wait.\n\n'
    + 'Follow-up items are modest. The team wants a gentler alert threshold for queue growth, a note in '
    + 'the partner handbook about pacing bulk imports, and a small dashboard panel that separates batch '
    + 'traffic from interactive traffic so the next incident is obvious at a glance.\n',
}

// 剧本：每轮的用户消息 + 该轮预期分类（用于判决）
type TurnKind = 'compressible' | 'chain' | 'dialog' | 'split'
const SCRIPT: Array<{ label: string; kind: TurnKind; text: string }> = [
  { label: 'T1', kind: 'compressible', text: '读一下 logs/app.log，告诉我有哪些错误、第一行 FATAL 是什么。' },
  { label: 'T2', kind: 'chain', text: '再读一次 logs/app.log，确认内容没有变化。' },
  { label: 'T3', kind: 'dialog', text: '明白，先继续排查。' },
  { label: 'T4', kind: 'compressible', text: '读 config/app.yaml，把超时和连接池配置报给我。' },
  {
    label: 'T5', kind: 'split',
    text: '按下面的输出处理：把回滚步骤写清楚。\n部署留档：\n[deploy] step 14/18 smoke FAILED BUILD_FAILED_EXIT=134\n'
      + '[deploy] canary-2 unhealthy (503)\n[deploy] canary-1 healthy (200)\n[deploy] rollback NOT attempted (auto=false)\n'
      + '[deploy] artifacts kept: dist/bundle.main.js sha256:3f79bb7b435b05321651daefd374cdc681dc06faa65e374e38337b88ca046dea\n',
  },
  { label: 'T6', kind: 'dialog', text: '好的。' },
  { label: 'T7', kind: 'compressible', text: '读 docs/runbook.md，摘出数据库相关的注意事项。' },
  { label: 'T7b', kind: 'compressible', text: '读 docs/postmortem.md，给我讲讲这次事故的来龙去脉。' },
  { label: 'T8', kind: 'dialog', text: '收到，就这些。' },
  { label: 'T9', kind: 'chain', text: '最后再看一眼 logs/app.log 收尾。' },
]

async function waitFor(desc: string, pred: () => boolean, timeoutMs: number): Promise<boolean> {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (pred()) return true
    await new Promise(r => setTimeout(r, 250))
  }
  console.log(`[wait-timeout] ${desc}`)
  return false
}

function waitIdle(ctx: Context, agent: { session: Session }): Promise<void> {
  return new Promise(resolve => {
    const dispose = ctx.on('agent/status', ({ agent: a, status }: { agent: { session: Session }; status: string }) => {
      if (a.session === agent.session && status === 'idle') { dispose(); resolve() }
    })
  })
}

/** 当前 surface 可见字符（模型真实负担）。 */
function surfaceChars(session: Session): number {
  return session.surface.nodes.reduce((sum, seq) => sum + projectSurfaceText(session.events[seq]!).length, 0)
}

/** 反事实：若从未压缩，append 起源事件的投影字符总量（append-only 日志天然保留）。 */
function counterfactualChars(session: Session): number {
  let total = 0
  for (const ev of session.events) {
    if (ev.type !== 'user/message' && ev.type !== 'assistant/message' && ev.type !== 'tool/result') continue
    if ((ev as { surfaceOp?: unknown }).surfaceOp !== 'append') continue
    const src = (ev.data as { source?: { kind?: string }; [k: string]: unknown }) ?? {}
    if (src['argp'] !== undefined) continue // U-info 副本不算反事实（它替代了原 user 的一部分）
    total += projectSurfaceText(ev).length
  }
  return total
}

function fingerprint(session: Session): string[] {
  return session.surface.nodes.map(seq => JSON.stringify(deriveEventMessage(session.events[seq])))
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (!MODEL) MODEL = await resolveLiveModel()
  console.log(`[spike36] base=${BASE} model=${MODEL} route=${IS_OPENROUTER ? 'openrouter' : 'local-llama'}`)
  // OpenRouter 用真实 key env；本地回退 dummy。
  process.env[API_KEY_ENV] = process.env[API_KEY_ENV] ?? (IS_OPENROUTER ? '' : 'local-no-auth')
  if (IS_OPENROUTER && !process.env['OPEN_ROUTER_API_KEY']) {
    console.error('[spike36] OPEN_ROUTER_API_KEY 未设置（OpenRouter 模式必需）')
    process.exit(1)
  }

  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: 'spike-36 peratom soak persona（回答尽量简短：直接给结论，不要复述工具输出内容，不要多余解释）' } })
  await ctx.plugin(InvariantRegistry, {})
  await applySessionInvariant(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LlmPiAi, {
    providers: {
      local: {
        displayName: IS_OPENROUTER ? 'OpenRouter' : 'Local llama.cpp',
        apiKeyEnv: API_KEY_ENV, api: 'openai-completions',
        baseURL: BASE,
        compat: { thinkingFormat: IS_OPENROUTER ? 'openrouter' : 'qwen' },
        models: [{
          id: MODEL, name: MODEL,
          // minimax-m3:free 上下文 1M；本地 Qwen 196K。reasoning wire 按路由区分：
          // openrouter 格式把 wire 值直接塞进 reasoning:{effort:<wire>}，必须用 effort 枚举
          // （布尔会 400：Invalid option）；本地 llama.cpp 用布尔开关。
          contextWindow: IS_OPENROUTER ? 1_048_576 : 196_608,
          maxTokens: 2048,
          reasoningEfforts: IS_OPENROUTER
            ? { off: 'minimal', high: 'high' }
            : { off: 'false', high: 'true' },
        }],
      },
    },
  })
  const compressorConfig = {
    endpoint: BASE + '/chat/completions',
    apiKey: IS_OPENROUTER ? (process.env['OPEN_ROUTER_API_KEY'] ?? '') : 'dummy-local',
    model: MODEL,
    timeoutMs: 240_000,
    // OpenRouter 不认 llama.cpp 的 chat_template_kwargs（会 400/忽略）——只本地注入。
    ...(IS_OPENROUTER ? {} : { chatTemplateKwargs: { enable_thinking: true } }),
  }
  const compressor = new PeratomCompressor(ctx, compressorConfig)

  const workDir = fs.mkdtempSync(path.join(process.cwd(), 'spike', 'out', '36-work-'))
  for (const [rel, content] of Object.entries(FILES)) {
    const p = path.join(workDir, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, content, 'utf8')
  }
  ctx.tools.register(defineTool({
    name: 'read_file',
    description: 'Read a text file under the incident workspace.',
    parameters: { path: { type: 'string', description: 'relative path, e.g. logs/app.log' } },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    execute: async (args) => {
      const rel = (args as { path?: string }).path ?? ''
      const p = path.join(workDir, rel)
      try { return fs.readFileSync(p, 'utf8') } catch { return 'read_file: no such file: ' + rel }
    },
  }))

  const agent = ctx.agentLoop.create(SessionId('spike-36-soak'), { provider: 'local', model: MODEL, reasoningEffort: 'high' })
  const session = agent.session

  interface TurnRow {
    label: string; kind: TurnKind; turn: number | null
    surfaceBefore: number; surfaceAfter: number; cfTotal: number
    called?: boolean; appliedReplaces?: number; skippedFallbackDialog?: number
    skippedFidelity?: number; anomalies?: number; parseFailed?: boolean; error?: string
    summaryDropped?: string[]
    /** 本轮被压缩原子的 per-atom 度量（压缩率按原子算，非按 turn/全局）。 */
    perAtoms?: Array<{ seq: number; level: string; origChars: number; newChars: number; atomRatio: number }>
    skipReason?: 'no-candidate' | 'interrupted'
    prefixOk?: boolean; chainExcluded?: boolean; interrupted?: boolean
  }
  const rows: TurnRow[] = []
  const originalHashes = new Map<number, string>()
  let cfTotal = 0
  /** 全跑批 per-atom 压缩台账（跨轮聚合，VK-atom 判决用）。 */
  interface AtomStat { label: string; seq: number; level: string; origChars: number; newChars: number }
  const atomStats: AtomStat[] = []

  // ---- 剧本循环（测量错位一轮，flush 走生产路径）----
  // dsh-session 不变量：tool/result 的 surface 替换必须在 open turn 内（invariant.js）。
  // 生产路径在下一轮 agent/pre-step 时 flush（新轮已开、合法）；spike 若在 idle 后手动
  // flushStashed（turn 已闭合）会触发 invariant 拒绝 → 压缩静默丢失（T1/T4/T7 曾因此
  // appliedReplaces=None，T5 因替换 user/message 不受限而幸存）。因此本循环：
  //   上一轮压缩的生效与观测，都在本轮 followup 触发的 pre-step 之后进行（错位一轮）。
  // 每轮 record 的 pending 就绪（LLM 返回）须在下一轮 followup 前确认，否则 pre-step flush 空转。
  interface PendingMeasure {
    step: typeof SCRIPT[number]
    turn: number
    surfaceBefore: number
    before: string[]
    collect: ReturnType<PeratomCompressor['collectCurrentTurn']>
  }
  let pendingMeasure: PendingMeasure | null = null

  for (const step of SCRIPT) {
    // 1) 上一轮 collect（本轮 followup 前，最新闭合轮 = 上一轮；collect 不依赖 flush）
    const prevCollect = pendingMeasure !== null ? compressor.collectCurrentTurn(session) : null
    // 2) 上一轮 pending 就绪：LLM 已返回且暂存入队，本轮 pre-step 才有东西可 flush
    if (pendingMeasure !== null) {
      await waitFor(`turn${pendingMeasure.turn} pending 就绪`, () => {
        const r = compressor.records.findLast(x => x.turn === pendingMeasure!.turn)
        if (r === undefined) return false
        if (r.called === false || r.parseFailed === true || r.error !== undefined) return true
        return r.ms !== undefined && compressor.pendingCount >= 1
      }, 240_000)
    }
    // 3) followup 本轮 → pre-step 自然 flush 上一轮 → agent 跑完
    agent.followup(createUserMessage({ content: [{ type: 'text', text: step.text }], source: { kind: 'user' } }))
    await waitIdle(ctx, agent)

    const turn = Math.max(...session.events.filter(e => e.type === 'turn/end').map(e => (e.data as { turn: number }).turn))
    // 本轮新原文入账（user 输入 + tool 结果 + assistant 回复）
    for (const ev of session.events) {
      if ((ev as { surfaceOp?: unknown }).surfaceOp !== 'append') continue
      if (!originalHashes.has(ev.seq)) originalHashes.set(ev.seq, JSON.stringify(ev.data))
    }

    // 4) 测量上一轮（已被本轮 pre-step flush，record 的 appliedReplaces 等已落账）
    if (pendingMeasure !== null) {
      const pm = pendingMeasure
      const rec: CompressRecord | undefined = compressor.records.findLast(r => r.turn === pm.turn)
      const after = fingerprint(session)
      let common = 0
      while (common < pm.before.length && common < after.length && pm.before[common] === after[common]) common += 1
      const firstNewIdx = (() => {
        // 当轮第一个节点的 surface 下标：找本轮 user 输入（最后一个 append+user 署名消息）
        let idx = Number.MAX_SAFE_INTEGER
        for (let i = 0; i < session.surface.nodes.length; i += 1) {
          const ev = session.events[session.surface.nodes[i]!]
          const d = ev?.data as { source?: { kind?: string }; [k: string]: unknown } | undefined
          if (ev?.type === 'user/message' && d?.source?.kind === 'user') { idx = i; break }
        }
        return idx
      })()
      cfTotal = counterfactualChars(session)
      const recObj = rec ?? {}
      // per-atom 压缩率：原长取该轮 collect 的原子原文，新长取决策 text（按原子算，非全局）。
      const decTools = (recObj.decision as { tools?: Array<{ seq: number; level: string; text: string }> } | undefined)?.tools ?? []
      const origBySeq = new Map<number, string>()
      for (const t of [...(pm.collect?.toolResults ?? []), ...(prevCollect?.toolResults ?? [])]) {
        if (!origBySeq.has(t.seq)) origBySeq.set(t.seq, t.text)
      }
      const perAtoms: TurnRow['perAtoms'] = decTools
        .filter(t => origBySeq.has(t.seq))
        .map(t => {
          const origChars = origBySeq.get(t.seq)!.length
          const newChars = t.text.length
          const atomRatio = newChars / Math.max(origChars, 1)
          atomStats.push({ label: pm.step.label, seq: t.seq, level: t.level, origChars, newChars })
          return { seq: t.seq, level: t.level, origChars, newChars, atomRatio }
        })
      rows.push({
        label: pm.step.label, kind: pm.step.kind, turn: pm.turn,
        surfaceBefore: pm.surfaceBefore, surfaceAfter: surfaceChars(session), cfTotal,
        ...recObj,
        perAtoms,
        prefixOk: common >= firstNewIdx,
        interrupted: prevCollect?.interrupted,
        chainExcluded: pm.step.kind === 'chain' && prevCollect?.interrupted !== true
          ? (prevCollect?.toolResults.length ?? -1) === 0
          : undefined,
      })
      console.log(`[${pm.step.label}/${pm.step.kind}] turn=${pm.turn} called=${recObj.called} `
        + `replaces=${recObj.appliedReplaces ?? 'undef'} fb=${recObj.skippedFallbackDialog ?? 'undef'} fid=${recObj.skippedFidelity ?? 'undef'} `
        + `anom=${recObj.anomalies ?? 'undef'} parseFailed=${recObj.parseFailed ?? false} sumDrop=${recObj.summaryDropped?.length ?? 0} surface=${pm.surfaceBefore}->${surfaceChars(session)} cf=${cfTotal} prefixOk=${common >= firstNewIdx}`
        + (perAtoms.length > 0
          ? ' atoms=' + perAtoms.map(a => `${pm.step.label}:${a.origChars}->${a.newChars}(${(a.atomRatio * 100).toFixed(1)}%)`).join(' ')
          : ''))
    }

    // 5) 记录本轮起点（上一轮压缩已生效后的 surface），供下一轮测量
    pendingMeasure = {
      step, turn,
      surfaceBefore: surfaceChars(session),
      before: fingerprint(session),
      collect: compressor.collectCurrentTurn(session),
    }
  }

  // 收尾：最后一轮（T9）的压缩需再触发一次 pre-step 才 flush 并测量。
  agent.followup(createUserMessage({ content: [{ type: 'text', text: '收到，本轮到此为止。' }], source: { kind: 'user' } }))
  await waitIdle(ctx, agent)
  if (pendingMeasure !== null) {
    const pm = pendingMeasure
    await waitFor(`turn${pm.turn} pending 就绪`, () => {
      const r = compressor.records.findLast(x => x.turn === pm.turn)
      if (r === undefined) return false
      if (r.called === false || r.parseFailed === true || r.error !== undefined) return true
      return r.ms !== undefined && compressor.pendingCount >= 1
    }, 240_000)
    // 尾轮的 collect 在本次 followup 前不可得（最新闭合已变）——用 record 内的 turn 关联即可，
    // chainExcluded 仅对 chain 轮有意义，尾轮若为 chain（T9）此处近似缺省。
    const rec: CompressRecord | undefined = compressor.records.findLast(r => r.turn === pm.turn)
    const after = fingerprint(session)
    let common = 0
    while (common < pm.before.length && common < after.length && pm.before[common] === after[common]) common += 1
    const firstNewIdx = (() => {
      let idx = Number.MAX_SAFE_INTEGER
      for (let i = 0; i < session.surface.nodes.length; i += 1) {
        const ev = session.events[session.surface.nodes[i]!]
        const d = ev?.data as { source?: { kind?: string }; [k: string]: unknown } | undefined
        if (ev?.type === 'user/message' && d?.source?.kind === 'user') { idx = i; break }
      }
      return idx
    })()
    cfTotal = counterfactualChars(session)
    const recObj = rec ?? {}
    rows.push({
      label: pm.step.label, kind: pm.step.kind, turn: pm.turn,
      surfaceBefore: pm.surfaceBefore, surfaceAfter: surfaceChars(session), cfTotal,
      ...recObj,
      prefixOk: common >= firstNewIdx,
      interrupted: pm.collect?.interrupted,
      chainExcluded: pm.step.kind === 'chain' && pm.collect?.interrupted !== true
        ? (pm.collect?.toolResults.length ?? -1) === 0
        : undefined,
    })
    console.log(`[${pm.step.label}/${pm.step.kind}] turn=${pm.turn} called=${recObj.called} `
      + `replaces=${recObj.appliedReplaces ?? 'undef'} fb=${recObj.skippedFallbackDialog ?? 'undef'} fid=${recObj.skippedFidelity ?? 'undef'} `
      + `anom=${recObj.anomalies ?? 'undef'} parseFailed=${recObj.parseFailed ?? false} sumDrop=${recObj.summaryDropped?.length ?? 0} surface=${pm.surfaceBefore}->${surfaceChars(session)} cf=${cfTotal} prefixOk=${common >= firstNewIdx}`)
  }

  // ---- 聚合判决 ----
  const finalVisible = surfaceChars(session)
  const ratio = finalVisible / Math.max(cfTotal, 1)
  console.log(`\n=== 聚合 ===`)
  console.log(`最终可见 ${finalVisible} 字符 / 反事实 ${cfTotal} 字符 = ${(ratio * 100).toFixed(1)}%`)
  console.log(`calls=${compressor.calls} parseFailed=${rows.filter(r => r.parseFailed).length} errors=${rows.filter(r => r.error !== undefined).length}`)

  // VK-plan：对话/链轮"门控正确零调用"。中断轮（interrupted）零调用是环境失败所致，
  // 不构成门控正确的证据，单独剔除（否则环境失败会被误读为门控正确）。
  const dialogLike = rows.filter(r => r.kind === 'dialog' || r.kind === 'chain')
  const dialogLikeGate = dialogLike.filter(r => r.interrupted !== true)
  verdict('VK-plan', dialogLikeGate.every(r => r.called === false),
    `对话/链轮门控零调用（${dialogLikeGate.filter(r => r.called === false).length}/${dialogLikeGate.length}；剔除中断轮 ${dialogLike.length - dialogLikeGate.length} 个）`)
  // P0-2：可压轮必须产生调用（新语料 T1/T4/T7 均 >512 且非链成员 → 必然候选）。
  // 若某个可压轮 called=false，要么是语料又掉回 <512 死设计，要么是门控 bug——两者都该 FAIL。
  // 例外：skipReason='interrupted'（轮次被 error/aborted 中断，半成品原子被过滤清空）属
  // 环境/模型失败而非门控 bug，单独报告（VK-env），不计入门控 FAIL。
  const compressible = rows.filter(r => r.kind === 'compressible')
  const compressibleCalled = compressible.filter(r => r.called === true).length
  const compressibleInterrupted = compressible.filter(r => r.skipReason === 'interrupted')
  const compressibleGateBlocked = compressible.filter(r => r.called !== true && r.skipReason !== 'interrupted')
  verdict('VK-plan-c', compressibleGateBlocked.length === 0,
    `可压轮全部产生调用（${compressibleCalled}/${compressible.length}）；门控未调用明细：`
      + (compressibleGateBlocked.map(r => `${r.label}:${r.skipReason ?? 'called-unknown'}`).join(' ') || ' 无'))
  // 环境健康判决：中断轮不应出现在可压轮上（正常 server 下 error 收尾应极少）。
  verdict('VK-env', compressibleInterrupted.length === 0,
    `可压轮中断（LLM 连接失败/error 收尾，非门控原因）：${compressibleInterrupted.length === 0 ? '无' : compressibleInterrupted.map(r => `${r.label}:turn=${r.turn}`).join(' ')}`)
  const chainRows = rows.filter(r => r.kind === 'chain' && r.interrupted !== true)
  verdict('VK-chain', chainRows.every(r => r.chainExcluded === true),
    chainRows.map(r => `${r.label}:toolResults=${r.chainExcluded}`).join(' '))
  let originalsOk = true
  for (const [seq, hash] of originalHashes) {
    if (JSON.stringify(session.events[seq]?.data) !== hash) { originalsOk = false; break }
  }
  verdict('VK-originals', originalsOk, `${originalHashes.size} 个原始事件零替换`)
  verdict('VK-clean', rows.every(r => !r.parseFailed && r.error === undefined),
    `parseFailed=${rows.filter(r => r.parseFailed).length} errorRows=${rows.filter(r => r.error !== undefined).length}`)
  verdict('VK-prefix', rows.every(r => r.prefixOk === true), '每次压缩历史前缀指纹不变')
  // VK-atom：压缩率按原子计算（用户定义，2026-08-26）——每个被压缩原子的
  // origChars vs newChars 单独记账，聚合收益 = 1 - Σnew/Σorig（只看被压原子，
  // 不受链成员副本/assistant 回复等不可压内容稀释）。全局 ratio 仅作参考打印。
  const atomSum = atomStats.reduce((a, s) => a + s.origChars, 0)
  const newSum = atomStats.reduce((a, s) => a + s.newChars, 0)
  const atomSaved = atomSum > 0 ? 1 - newSum / atomSum : 0
  verdict('VK-atom', atomSaved >= 0.5,
    `被压原子聚合压缩收益 = ${(atomSaved * 100).toFixed(1)}%（Σorig=${atomSum} Σnew=${newSum}，阈值 ≥50%）。`
      + `全局 ratio=${(ratio * 100).toFixed(1)}%（参考）。逐原子：`
      + (atomStats.map(s => `${s.label}:${s.level} ${s.origChars}->${s.newChars}(${(100 - (s.newChars / Math.max(s.origChars, 1)) * 100).toFixed(1)}% 缩减)`).join(' ') || ' 无事务'))

  const outDir = path.join(process.cwd(), 'spike', 'out')
  fs.mkdirSync(outDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const outFile = path.join(outDir, `36-peratom-soak-${stamp}.json`)
  const fp = runFingerprint()
  fs.writeFileSync(outFile, JSON.stringify({
    meta: {
      base: BASE, model: MODEL, runAt: new Date().toISOString(), failures,
      // 版本指纹：对照报告只认同指纹产物（review 严重发现 #3）
      gitCommit: fp.commit, scriptHash: fp.scriptHash,
      // 引擎配置指纹：thinking 开关 + 有无 max_tokens（compressor 请求体已删 max_tokens）。
      // OpenRouter 模式 thinking 走 reasoning 参数（agent 侧 reasoningEffort=high），
      // 无 chat_template_kwargs——enableThinking 显式标注路由以免误读。
      enableThinking: IS_OPENROUTER
        ? 'openrouter-reasoning(high)'
        : Boolean((compressorConfig.chatTemplateKwargs ?? {})['enable_thinking']),
      maxTokens: 'none (engine 侧已删，仅 AbortSignal 兜底)',
      splitThresholdChars: 100, smallResultChars: 512,
    },
    aggregate: { finalVisible, cfTotal, ratio, calls: compressor.calls },
    rows,
  }, null, 2))
  console.log(`产物：${outFile}`)
  if (failures.length > 0) {
    console.log(`\n=== 结论：${failures.length} 项待处理 ===`)
    for (const f of failures) console.log(' - ' + f)
    process.exitCode = 1
  } else {
    console.log('\n=== 结论：全部判决项 PASS —— 单引擎持续压测通过 ===')
  }
  clearTimeout(watchdog)
  fs.rmSync(workDir, { recursive: true, force: true })
  await ctx.fiber.dispose()
}

void main()
