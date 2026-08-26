/**
 * spike 37 — P5 双引擎三臂合成多轮任务验证（per-atom-implementation-plan P5，设计 §10）
 *
 * 三臂（同一 30 轮合成任务、同一本地 Qwen3.6-35B-A3B）：
 *   A. peratom 全开  = mountPeratomStack（compressor + declarer + zoom + graph）
 *   B. 无边          = mountPeratomStack({ declarer: false })（压缩在、cites 边缺席）
 *   C. 现役基线      = 裸 ArgpGraphEngine（溢出才剪，与现役 160K 基线同形态）
 *
 * 任务（30 轮，吸取 tlong 教训——必须有跨轮依赖 + 引用原子长寿）：
 *   T1  setup + 决策（ARCHIVE-DECISION：服务端口/token/超时等 6 个 load-bearing 配置值）
 *   T2  读 logs/app.log（结构化行 + 200 行噪声，extract 真靶子）
 *   T3  读 config/app.yaml（跨轮依赖源 1：timeout/pool/rollback）
 *   T4  读 docs/api-contract.md（跨轮依赖源 2：endpoint/字段名）
 *   T5  读 codebase/service.ts（跨轮依赖源 3：类名/方法）
 *   T6-T7  纯对话确认（门控零调用检验位）
 *   T8-T22  filler：每轮读一个 codebase/mod-N.ts（~2-4K 字符，首行 ART 针），
 *           其中 T9/T15/T20 各带一条 archival note（U 针 ×3）
 *   T23  依赖探针 D1：用 T3 的 timeout/pool 值写部署配置（exact 跨轮）
 *   T24  gist 探针 G1：问 T2 日志"哪些错误、第一行 FATAL 是什么"（gist，载体已剪）
 *   T25  依赖探针 D2：用 T4 的 endpoint/字段名写客户端（exact 跨轮）
 *   T26  exact 探针 R1：恢复 T10 所读 artifact 首行 ART marker（被剪，经 recall 找回）
 *   T27  依赖探针 D3：用 T5 的类名/方法写集成测试（exact 跨轮）
 *   T28  exact 探针 R2：恢复 T18 所读 artifact 首行 ART marker
 *   T29  依赖探针 D4：用 T1 的 ARCHIVE-DECISION 值写最终报告（exact 跨轮）
 *   T30  收尾确认
 *
 * 测量（P5 口径）：
 *   - 成本三元组 (miss, hit, out)：主 agent 轮从 session 事件 usage 直接取
 *     （37a 已证适配器 inputTokens=纯新增 miss、cacheReadTokens=命中）；
 *     aux 调用（compressor/declarer 的 LLM 请求）经注入 fetchImpl 包装器旁路计量
 *     —— 本地成本≈0，但 aux 输出 token 计入"输出税"。
 *   - 最大可持续轮数：连续 2 轮重试耗尽即中止（06c 口径），记录完成轮数。
 *   - 探针正确率：U 针 / exact（D1-D4 + R1-R2）/ gist（G1），逐探针判 + 聚合。
 *   - 前缀命中率：逐轮 hit/(miss+hit)，A 臂判据"压缩轮除外 ≥95%"——
 *     压缩轮判定 = 该轮 pre-step 后 surface.replaceGeneration 较轮首增加（引擎换代）。
 *   - 防干涉（§6-6）：全部 append-origin 事件 JSON 哈希全程不变断言。
 *
 * 窗口：contextWindow 20K / window 16K / retain 4K（30 轮内多次压缩，本地 256K ctx 足够）。
 *
 * 用法：ARGP_ARM=A|B|C ARGP_MODEL_SOURCE=qwen-local QWEN_MODEL=Qwen3.6-35B-A3B \
 *   node --import ./scripts/ts-import-rewrite-loader.mjs spike/37-peratom-three-arm.ts
 * 产物：spike/out/37-three-arm-<arm>-<stamp>/{result.json,events.jsonl}
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ArgpGraphEngine } from '../src/argp-graph-engine.ts'
import { mountPeratomStack } from '../src/peratom/mount.ts'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import type { PeratomStack } from '../src/peratom/mount.ts'
import type { PeratomCompressorConfig } from '../src/peratom/compressor.ts'
import type { CiteDeclarerConfig } from '../src/peratom/cite-declarer.ts'

const BASE = (process.env['QWEN_BASE'] ?? 'http://127.0.0.1:8080/v1').replace(/\/$/, '')
const MODEL = process.env['QWEN_MODEL'] ?? 'Qwen3.6-35B-A3B'
const ARM = (process.env['ARGP_ARM'] ?? 'A').toUpperCase() as 'A' | 'B' | 'C' | 'D'
const IS_PERATOM = ARM !== 'C' && ARM !== 'D'
const HAS_DECLARER = ARM === 'A'
const CONTEXT_WINDOW = 20_000
const WINDOW_TOKENS = 16_000
const RETAIN_TOKENS = 4_000
const MAX_TURNS = 30

const failures: string[] = []
const verdict = (name: string, ok: boolean, detail: string): void => {
  console.log((ok ? '[PASS ' : '[FAIL ') + name + '] ' + detail)
  if (!ok) failures.push(name + ': ' + detail)
}

const watchdogMin = Number(process.env['ARGP_WATCHDOG_MIN'] ?? 240)
const watchdog = setTimeout(() => {
  console.log('[FATAL] spike 37 watchdog timeout (' + watchdogMin + ' min)')
  process.exit(2)
}, watchdogMin * 60 * 1000)
watchdog.unref()

// ---------- 产物目录 ----------
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const outDir = path.join(import.meta.dirname, 'out', '37-three-arm-' + ARM + '-' + stamp)
const workDir = path.join(outDir, 'work')
for (const d of ['logs', 'config', 'docs', 'codebase']) fs.mkdirSync(path.join(workDir, d), { recursive: true })

function runFingerprint(): Record<string, string> {
  let commit = 'unknown'
  try { commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() } catch { /* 非 git */ }
  let scriptHash = 'unknown'
  try {
    const self = fs.readFileSync(path.join(import.meta.dirname, '37-peratom-three-arm.ts'), 'utf8')
    scriptHash = createHash('sha256').update(self).digest('hex').slice(0, 12)
  } catch { /* ignore */ }
  return { commit, scriptHash }
}

// ---------- needle 编码（确定性，脚本侧持有期望值） ----------
const code = (n: number): string => ((n * 48_271) % 1_679_616).toString(36).toUpperCase().padStart(4, '0')
const rMarker = (j: number): string => 'ART-' + j + '-MARKER-' + code(j)
// 跨轮依赖源（T29 依赖探针 D4 的期望值，T1 决策里给出）
const DECISIONS = { port: 9471, token: 'SVC-TOK-' + code(42), timeout: '30s', poolMax: 25, endpoint: '/v1/order/query', field: 'order_no' }

// ---------- 语料 ----------
/** app.log：结构化 load-bearing 行（守卫必留）+ 200 行描述性噪声（可合法丢弃）——spike 36 同款靶子。 */
function makeAppLog(): string {
  const structured = [
    '2026-08-26T09:00:00Z boot ok pid=4021 node=canary-1 region=cn-north-1',
    '2026-08-26T09:04:12Z level=ERROR svc=orders req_id=r-1004 latency_ms=188 code=ECONNRESET at pg/pool.ts:88:19 trace=tr-4-9f2c1ab',
    '2026-08-26T09:08:12Z level=ERROR svc=orders req_id=r-1008 latency_ms=336 code=ECONNRESET at pg/pool.ts:88:19 trace=tr-8-9f2c1ab',
    '2026-08-26T09:10:12Z level=ERROR svc=orders req_id=r-1010 latency_ms=410 code=ECONNRESET at pg/pool.ts:88:19 trace=tr-10-9f2c1ab',
    '2026-08-26T09:15:00Z FATAL pool exhausted host=db-01 region=cn-north-1',
  ]
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
  ]
  const lines = [...structured]
  for (let i = 0; i < 200; i += 1) lines.push('2026-08-26T09:15:30Z note ' + i + ' ' + narrative[i % narrative.length])
  return lines.join('\n')
}

const YAMLC =
  '# app runtime configuration (production)\n'
  + 'http:\n  timeout: ' + DECISIONS.timeout + '\n  retries: 3\n  connectTimeout: 5s\n'
  + 'pool:\n  max: ' + DECISIONS.poolMax + '\n  idleTimeout: 60s\n  min: 2\n  acquireTimeout: 10s\n'
  + 'features:\n  rollbackAuto: false\n  canaryPct: 20\n  canaryHold: 10m\n'
  + 'cache:\n  ttl: 600s\n  budgetBytes: 268435456\n  eviction: lru\n'
  + 'logging:\n  level: info\n  sink: stdout\n  flushInterval: 2s\n'
  + '# 说明：timeout 与 connectTimeout 分开计，retries 只作用于幂等 GET。\n'
  + '# pool.max 是硬上限，acquireTimeout 超时即 503，避免线程打满拖垮整机。\n'
  + '# features.rollbackAuto 关闭后回滚必须走 runbook 手动确认，禁止脚本自动触发。\n'
  + '# cache.budgetBytes 超预算时按 lru 逐出，调大前先看内存水位再评估。\n'

const API_CONTRACT =
  '# Order Query API Contract v2\n\n'
  + 'Endpoint: ' + DECISIONS.endpoint + '\n'
  + 'Method: GET (idempotent, safe to retry)\n\n'
  + 'Request query parameters:\n'
  + '  ' + DECISIONS.field + ': string (required) — order identifier, format ORD-<digits>\n'
  + '  trace_id: string (optional) — for distributed tracing\n\n'
  + 'Response 200:\n'
  + '  {\n    "order_no": "ORD-20260826-1001",\n    "status": "shipped",\n    "created_at": "2026-08-26T08:12:40Z",\n'
  + '    "items": [{"sku": "SKU-77", "qty": 2}],\n    "amount": {"currency": "CNY", "value": 19900}\n  }\n\n'
  + 'Response 404: {"error": "ORDER_NOT_FOUND", "order_no": "<request>"}\n'
  + 'Response 429: {"error": "RATE_LIMITED", "retry_after_ms": 500}\n\n'
  + 'Notes: the endpoint is behind the gateway; auth is via header X-SVC-TOKEN. '
  + 'Rate limit is 100 req/s per token. The ' + DECISIONS.field + ' parameter is the ONLY required input — '
  + 'do not invent additional required fields.\n'

const SERVICE_TS = [
  '// service.ts — order query service entrypoint',
  'export class OrderQueryService {',
  '  constructor(private readonly endpoint: string, private readonly token: string) {}',
  '  async queryByOrderNo(orderNo: string): Promise<OrderDto> {',
  '    const url = this.endpoint + "?" + encodeURIComponent("' + DECISIONS.field + '") + "=" + encodeURIComponent(orderNo)',
  '    const res = await fetch(url, { headers: { "X-SVC-TOKEN": this.token } })',
  '    if (!res.ok) throw new OrderQueryError(res.status)',
  '    return res.json()',
  '  }',
  '  async batchQuery(orderNos: string[]): Promise<OrderDto[]> {',
  '    return Promise.all(orderNos.map(n => this.queryByOrderNo(n)))',
  '  }',
  '}',
  'export interface OrderDto { order_no: string; status: string; created_at: string }',
  'export class OrderQueryError extends Error { constructor(public readonly status: number) { super("order query failed") } }',
].join('\n') + '\n'

// codebase/mod-N.ts（filler artifact，首行 ART 针）
function makeMod(j: number): string {
  const lines: string[] = [
    '// ' + rMarker(j) + ' — generated module (simulated real source)',
    'export interface Mod' + j + 'Config { id: number; retries: number; sinks: string[] }',
    'export class Mod' + j + ' {',
    '  private state = new Map<string, unknown>()',
    '  constructor(private readonly config: Mod' + j + 'Config) {}',
  ]
  for (let m = 0; m < 12; m += 1) {
    lines.push('  async handle' + m + '(rec: Record<string, unknown>): Promise<void> {')
    lines.push('    const key = \'mod' + j + ':\' + String(rec[\'id\'] ?? \'none\') + \':\' + ' + m)
    lines.push('    this.state.set(key, { ok: true, ts: Date.now() })')
    lines.push('  }')
  }
  lines.push('}')
  return lines.join('\n')
}

// ---------- 沙箱工具 ----------
const sandbox = (rel: string): string => {
  const resolved = path.resolve(workDir, rel)
  if (!resolved.startsWith(workDir)) throw new Error('path escapes workdir: ' + rel)
  return resolved
}
const readFileSync = (p: string): string => { try { return fs.readFileSync(p, 'utf8') } catch { return 'read_file: no such file: ' + p } }

// ---------- 剧本 ----------
type ItemKind = 'setup' | 'filler' | 'dialog' | 'probe'
interface Item { label: string; kind: ItemKind; text: string; probe?: 'U1' | 'U2' | 'U3' | 'D1' | 'D2' | 'D3' | 'D4' | 'G1' | 'R1' | 'R2'; needleU?: string; modJ?: number }

const items: Item[] = []
items.push({
  label: 'T1-setup', kind: 'setup',
  text: 'We are starting a long-running coding session for the order service. Before the routine work begins, here is the decision record — remember every value exactly, later turns will ask you to apply them:\n'
    + 'ARCHIVE-DECISION:\n'
    + '- service port: ' + DECISIONS.port + '\n'
    + '- service token: ' + DECISIONS.token + '\n'
    + '- http timeout: ' + DECISIONS.timeout + '\n'
    + '- pool max: ' + DECISIONS.poolMax + '\n'
    + '- query endpoint: ' + DECISIONS.endpoint + '\n'
    + '- required query field: ' + DECISIONS.field + '\n'
    + 'From time to time I will hand you an archival note — keep it. Most turns are routine file reading that grows our shared context. Occasionally a long-term memory check: follow its exact answer format. Keep prior context in mind; reply briefly.',
})
items.push({ label: 'T2-log', kind: 'filler', text: 'Use read_file to read `logs/app.log`. Reply with the line count and the code on the first FATAL line, briefly.' })
items.push({ label: 'T3-yaml', kind: 'filler', text: 'Use read_file to read `config/app.yaml`. Report the http timeout and pool max values, briefly.' })
items.push({ label: 'T4-api', kind: 'filler', text: 'Use read_file to read `docs/api-contract.md`. Report the endpoint and the required query field, briefly.' })
items.push({ label: 'T5-svc', kind: 'filler', text: 'Use read_file to read `codebase/service.ts`. Report the service class name and its public methods, briefly.' })
items.push({ label: 'T6-dialog', kind: 'dialog', text: 'Got it. Continue.' })
items.push({ label: 'T7-dialog', kind: 'dialog', text: 'Thanks, noted.' })
// T8-T22 filler：读 codebase/mod-1..15（j=1..15），T9/T15/T20 带 U 针
const FILLER_START = 8
const FILLER_COUNT = 15 // T8..T22
for (let i = 0; i < FILLER_COUNT; i += 1) {
  const j = i + 1
  const turnNo = FILLER_START + i
  let text = 'Use read_file to read `codebase/mod-' + j + '.ts`. Reply with its line count and the ART marker from its first comment line, briefly.'
  let needleU: string | undefined
  if (turnNo === 9) { needleU = 'NOTE-U1-' + code(9); text = 'Archival note (remember it exactly, no acknowledgment): ' + needleU + '.\n' + text }
  if (turnNo === 15) { needleU = 'NOTE-U2-' + code(15); text = 'Archival note (remember it exactly, no acknowledgment): ' + needleU + '.\n' + text }
  if (turnNo === 20) { needleU = 'NOTE-U3-' + code(20); text = 'Archival note (remember it exactly, no acknowledgment): ' + needleU + '.\n' + text }
  items.push({ label: 'T' + turnNo + '-mod' + j, kind: 'filler', text, modJ: j, needleU })
}
// 探针轮
items.push({ label: 'T23-D1', kind: 'probe', probe: 'D1', text: 'Long-term memory check D1. Earlier you read `config/app.yaml`. Using the exact http timeout and pool max values from that file, write the file `deploy/rollout.yaml` with a yaml block containing `timeout:` and `pool.max:` (exact values from the file). Reply with only the two values you used, one per line, in format:\nD1-ANSWER: timeout=<v> poolMax=<v>\nIf you cannot see the file content, use recall tools before answering. Do not guess.' })
items.push({ label: 'T24-G1', kind: 'probe', probe: 'G1', text: 'Long-term memory check G1 (gist only). Earlier you read `logs/app.log`. From memory of that log: (a) which service was throwing errors, and (b) what was the first FATAL line about? Answer in at most two short sentences. Do NOT quote exact lines, IDs, or codes — a gist is enough. If the log is no longer visible, use recall tools (summary level is fine). If truly unrecoverable, write NOT-RECOVERABLE.\nG1-ANSWER: <service> / <fatal gist>' })
items.push({ label: 'T25-D2', kind: 'probe', probe: 'D2', text: 'Long-term memory check D2. Earlier you read `docs/api-contract.md`. Using the exact endpoint path and the required query field name from that contract, write the file `client/query.ts` as a minimal TS function `queryOrder(id: string)` that fetches the right URL with the right query parameter. Reply with only the two values you used, one per line, in format:\nD2-ANSWER: endpoint=<path> field=<name>\nIf you cannot see the contract, use recall tools before answering. Do not guess.' })
const R1_MOD_J = 3 // T10 读 mod-3 → T26 探针
items.push({ label: 'T26-R1', kind: 'probe', probe: 'R1', text: 'Long-term memory check R1 (exact). On an earlier turn you read `codebase/mod-' + R1_MOD_J + '.ts`; its FIRST line contains a unique marker of the form ART-<n>-MARKER-<XXXX>. That line is no longer visible in context. Recover it with recall_pruned (or recall_detail for a seq) before answering — copy the exact marker, do not guess.\nR1-ANSWER: <exact ART marker>' })
items.push({ label: 'T27-D3', kind: 'probe', probe: 'D3', text: 'Long-term memory check D3. Earlier you read `codebase/service.ts`. Using the exact service class name and the name of its single-order public method from that file, write the file `test/service.test.ts` as a minimal test stub that instantiates the class and calls that method. Reply with only the two values you used, one per line, in format:\nD3-ANSWER: class=<ClassName> method=<methodName>\nIf you cannot see the file, use recall tools before answering. Do not guess.' })
const R2_MOD_J = 11 // T18 读 mod-11 → T28 探针
items.push({ label: 'T28-R2', kind: 'probe', probe: 'R2', text: 'Long-term memory check R2 (exact). On an earlier turn you read `codebase/mod-' + R2_MOD_J + '.ts`; its FIRST line contains a unique marker of the form ART-<n>-MARKER-<XXXX>. That line is no longer visible in context. Recover it with recall_pruned (or recall_detail for a seq) before answering — copy the exact marker, do not guess.\nR2-ANSWER: <exact ART marker>' })
items.push({ label: 'T29-D4', kind: 'probe', probe: 'D4', text: 'Long-term memory check D4. From the ARCHIVE-DECISION record I gave you at the very start, using the exact values, write the file `report/final.md` with a markdown table containing the service port, service token, http timeout, pool max, query endpoint and required query field. Reply with the six values in exactly this one-line format:\nD4-ANSWER: port=<v> token=<v> timeout=<v> poolMax=<v> endpoint=<path> field=<name>\nIf any value is no longer in context, use recall tools before answering. Do not guess.' })
items.push({ label: 'T30-end', kind: 'dialog', text: 'That is all for this session. Thanks.' })

// 冒烟截断（ARGP_MAX_ITEMS=N 只跑前 N 轮，验证装配/模型/工具/计量，不碰探针轮）
const MAX_ITEMS = Number(process.env['ARGP_MAX_ITEMS'] ?? items.length)
if (MAX_ITEMS < items.length) items.length = MAX_ITEMS

// 预生成 filler 语料（探针轮 T26/T28 读的文件也预生成——它们已在对应 filler 轮读过）
for (const it of items) if (it.kind === 'filler' && it.modJ !== undefined) {
  fs.writeFileSync(path.join(workDir, 'codebase', 'mod-' + it.modJ + '.ts'), makeMod(it.modJ), 'utf8')
}
fs.writeFileSync(path.join(workDir, 'logs', 'app.log'), makeAppLog(), 'utf8')
fs.writeFileSync(path.join(workDir, 'config', 'app.yaml'), YAMLC, 'utf8')
fs.writeFileSync(path.join(workDir, 'docs', 'api-contract.md'), API_CONTRACT, 'utf8')
fs.writeFileSync(path.join(workDir, 'codebase', 'service.ts'), SERVICE_TS, 'utf8')

// ---------- 装配 ----------
process.env['ARGP_MODEL_SOURCE'] = 'qwen-local'
process.env['QWEN_BASE'] = BASE
process.env['QWEN_MODEL'] = MODEL
process.env['DEEPSEEK_API_KEY'] = process.env['DEEPSEEK_API_KEY'] ?? 'dummy-local'

// aux 计量：包装 fetchImpl 旁路记录 compressor/declarer 的 LLM 请求 usage
const auxStats = { calls: 0, prompt: 0, cached: 0, completion: 0 }
const meteringFetch: typeof fetch = async (input, init) => {
  const res = await fetch(input, init)
  try {
    if (res.ok && String(res.headers.get('content-type') ?? '').includes('json')) {
      const clone = res.clone()
      const j = await clone.json() as { usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } }
      if (j.usage) {
        auxStats.calls += 1
        auxStats.prompt += j.usage.prompt_tokens ?? 0
        auxStats.cached += j.usage.prompt_tokens_details?.cached_tokens ?? 0
        auxStats.completion += j.usage.completion_tokens ?? 0
      }
    }
  } catch { /* 非 json / 流式 / 解析失败：忽略 */ }
  return res
}
// 本地 llama.cpp + Qwen：schema 强制输出须关思考（spike 33 实证）
const auxCommon = { endpoint: BASE + '/chat/completions', apiKey: 'dummy-local', model: MODEL, timeoutMs: 240_000, chatTemplateKwargs: { enable_thinking: false }, fetchImpl: meteringFetch }
const compressorConfig: PeratomCompressorConfig = { ...auxCommon }
const declarerConfig: CiteDeclarerConfig = { ...auxCommon }

const ctx = new Context()
await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: 'spike-37 three-arm persona (answer briefly; when a check asks for an exact format, follow it exactly)' } })
await ctx.plugin(TokenMeter) // BasicCompactionEngine 硬依赖 ctx.tokenMeter 做压力测量（D 臂）；对 A/B/C 无害
await ctx.plugin(AgentLoop, { agents: [] })
await ctx.plugin(LlmDeepSeek, {
  thinking: 'disabled',
  reasoningEffort: 'off',
  baseURL: BASE,
  models: [{ id: MODEL, name: MODEL, contextWindow: CONTEXT_WINDOW }],
})

let stack: PeratomStack | null = null
if (IS_PERATOM) {
  stack = await mountPeratomStack(ctx, {
    graph: { windowTokens: WINDOW_TOKENS, retainTokens: RETAIN_TOKENS, maxPasses: 256 },
    compressor: compressorConfig,
    declarer: HAS_DECLARER ? declarerConfig : false,
    zoom: { windowTokens: WINDOW_TOKENS },
  })
} else if (ARM === 'C') {
  await ctx.plugin(ArgpGraphEngine, { windowTokens: WINDOW_TOKENS, retainTokens: RETAIN_TOKENS, maxPasses: 256 })
} else {
  // ARM === 'D'：dsh 原生 compaction-basic（传统 LLM 摘要压缩），与 ArgpGraphEngine 同基座、同窗口参数
  await ctx.plugin(BasicCompactionEngine, {
    thresholdRatio: WINDOW_TOKENS / CONTEXT_WINDOW, // 0.8 → thresholdTokens=16000（=WINDOW_TOKENS）
    retainTokens: RETAIN_TOKENS,
    auto: true,
  })
}
const engine = (ctx.compaction ?? (stack?.engine ?? null)) as any
if (!engine) throw new Error('spike 37: compaction engine did not mount')

ctx.tools.register(defineTool({
  name: 'read_file',
  description: 'Read a text file by path relative to the task working directory.',
  parameters: { path: { type: 'string', description: 'file path relative to the working directory' } },
  output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
  execute: async (args): Promise<string> => readFileSync(sandbox((args as { path?: string }).path ?? '')),
}))
ctx.tools.register(defineTool({
  name: 'write_file',
  description: 'Write text content to a file by path relative to the task working directory, creating parent directories as needed.',
  parameters: { path: { type: 'string' }, content: { type: 'string' } },
  output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
  execute: async (args): Promise<string> => {
    const a = args as { path?: string; content?: string }
    if (a.path === undefined || a.path === '') return 'write_file: missing path'
    const target = sandbox(a.path)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, a.content ?? '', 'utf8')
    return 'write_file: wrote ' + (a.content ?? '').length + ' chars to ' + a.path
  },
}))

const agent = ctx.agentLoop.create(SessionId('spike-37-three-arm'), {
  provider: 'deepseek-official',
  model: MODEL,
  reasoningEffort: 'off',
})

// 事件观测
const turnStats: { turn: number; input: number; hit: number; out: number }[] = []
ctx.on('session/event', (session, event) => {
  if (session !== agent.session) return
  if (event.type === 'assistant/message') {
    const u = (event.data as { usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number } }).usage
    turnStats.push({
      turn: (event.data as { turn?: number }).turn ?? -1,
      input: u?.inputTokens ?? 0,
      hit: u?.cacheReadTokens ?? 0,
      out: u?.outputTokens ?? 0,
    })
  }
  if (event.type === 'turn/end' || event.type === 'compaction/start' || event.type === 'compaction/end' || event.type === 'agent/request-error') {
    console.log('[diag] ' + event.type + ': ' + JSON.stringify(event.data ?? '').slice(0, 200))
  }
})

function waitForIdle(): Promise<void> {
  return new Promise(resolve => {
    const dispose = ctx.on('agent/status', ({ agent: a, status }) => {
      if (a === agent && status === 'idle') { dispose(); resolve() }
    })
  })
}

// 原文守恒底账：append-origin 事件 JSON 哈希（防干涉 §6-6）
const originalHashes = new Map<number, string>()
function snapshotOriginals(): void {
  for (const ev of agent.session.events) {
    if ((ev as { surfaceOp?: unknown }).surfaceOp !== 'append') continue
    if (!originalHashes.has(ev.seq)) originalHashes.set(ev.seq, JSON.stringify(ev.data))
  }
}
function verifyOriginals(): { ok: boolean; bad: number[] } {
  const bad: number[] = []
  for (const [seq, hash] of originalHashes) {
    if (JSON.stringify(agent.session.events[seq]?.data) !== hash) bad.push(seq)
  }
  return { ok: bad.length === 0, bad }
}

// ---------- 轮次执行（重试 3 次，连续 2 轮耗尽即中止） ----------
interface TurnRow { label: string; kind: ItemKind; ok: boolean; boundariesAfter: number; genDelta: number; seconds: number }
const turnLog: TurnRow[] = []
let aborted = false
let consecutiveFailed = 0
const startedAt = Date.now()

for (const item of items) {
  const t0 = Date.now()
  const genBefore = agent.session.surface.replaceGeneration
  const compGenBefore = genBefore
  let ok = false
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let failed = false
    const dispose = ctx.on('session/event', (session, event) => {
      if (session !== agent.session) return
      if (event.type === 'turn/end' && (event.data as { reason?: { kind?: string } }).reason?.kind === 'error') failed = true
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: item.text }], source: { kind: 'user' } }))
    await waitForIdle()
    dispose()
    if (!failed) { ok = true; break }
    if (attempt < 3) console.log('[diag] ' + item.label + ' attempt ' + attempt + '/3 failed, retrying')
  }
  const boundariesAfter = agent.session.events.filter(e => e.type === 'compaction/start').length
  const genDelta = agent.session.surface.replaceGeneration - compGenBefore
  // 本轮 pre-step 的引擎压缩换代：genBefore 是 followup 前快照，pre-step 在其后 → genDelta>0 即本轮发生了 surface 换代
  turnLog.push({ label: item.label, kind: item.kind, ok, boundariesAfter, genDelta, seconds: Math.round((Date.now() - t0) / 1000) })
  snapshotOriginals()
  console.log('[turn] ' + item.label + ' ' + (ok ? 'ok' : 'FAILED') + ' in ' + Math.round((Date.now() - t0) / 1000) + 's; boundaries=' + boundariesAfter + ' genΔ=' + genDelta)
  if (!ok) {
    consecutiveFailed += 1
    if (consecutiveFailed >= 2) {
      console.log('[FATAL] 连续 2 轮重试耗尽 —— 中止，保留已产生产物')
      aborted = true
      break
    }
    continue
  }
  consecutiveFailed = 0
}

// ---------- 判定 ----------
const completedTurns = turnLog.filter(t => t.ok).length
// 最大可持续轮数：从第一轮起连续 ok 的轮数（首个失败轮止）
let sustained = 0
for (const t of turnLog) { if (t.ok) sustained += 1; else break }
const maxSustained = aborted ? sustained : turnLog.filter(t => t.ok).length

// 防干涉
snapshotOriginals()
const origCheck = verifyOriginals()

// 探针判定
interface ProbeRow { probe: string; turn: number; answer: string; correct: boolean }
function rawTextOf(event: { type: string; data?: unknown }): string {
  const data = event.data as Record<string, unknown> | undefined
  const message = (data as { message?: { content?: unknown[] } } | undefined)?.message
  const content = Array.isArray(message?.content) ? (message.content as { type: string; text?: string }[]) : []
  return content.filter(b => b.type === 'text').map(b => b.text ?? '').join('\n')
}
const probes: ProbeRow[] = []
for (const item of items.filter(i => i.kind === 'probe')) {
  const label = item.label
  // 找该探针轮的最后一条 assistant 文本
  const marker = item.probe === 'D1' ? 'D1-ANSWER' : item.probe === 'D2' ? 'D2-ANSWER' : item.probe === 'D3' ? 'D3-ANSWER'
    : item.probe === 'D4' ? 'D4-ANSWER' : item.probe === 'G1' ? 'G1-ANSWER' : item.probe === 'R1' ? 'R1-ANSWER' : 'R2-ANSWER'
  const turnRow = turnLog.find(t => t.label === label)
  const turnNo = turnRow && turnRow.ok ? (() => {
    // 该探针 user 消息所在轮：取 marker 出现的 assistant 消息的 turn
    const evs = agent.session.events.filter(e => e.type === 'assistant/message' && rawTextOf(e).includes(marker))
    return evs.length > 0 ? (evs[evs.length - 1].data as { turn?: number }).turn ?? -1 : -1
  })() : -1
  const evs = agent.session.events.filter(e => e.type === 'assistant/message' && rawTextOf(e).includes(marker))
  const answer = evs.length > 0 ? (rawTextOf(evs[evs.length - 1]).match(new RegExp(marker + ':\\s*(.+)')) ?? [])[1]?.trim() ?? '' : '(no answer)'
  let correct = false
  const p = item.probe!
  const A = answer.toUpperCase()
  if (p === 'D1') {
    correct = answer.includes(DECISIONS.timeout) && answer.includes(String(DECISIONS.poolMax))
  } else if (p === 'D2') {
    correct = answer.includes(DECISIONS.endpoint) && answer.includes(DECISIONS.field)
  } else if (p === 'D3') {
    correct = A.includes('ORDERQUERYSERVICE') && A.includes('QUERYBYORDERNO')
  } else if (p === 'D4') {
    correct = answer.includes(String(DECISIONS.port)) && answer.includes(DECISIONS.token) && answer.includes(DECISIONS.timeout)
      && answer.includes(String(DECISIONS.poolMax)) && answer.includes(DECISIONS.endpoint) && answer.includes(DECISIONS.field)
  } else if (p === 'G1') {
    correct = A.includes('ORDERS') && !A.includes('NOT-RECOVERABLE')
  } else if (p === 'R1') {
    correct = A.includes(rMarker(R1_MOD_J))
  } else if (p === 'R2') {
    correct = A.includes(rMarker(R2_MOD_J))
  }
  probes.push({ probe: p, turn: turnNo, answer, correct })
  console.log('[probe ' + p + '] ' + (correct ? 'OK' : 'MISS') + ' answer=' + JSON.stringify(answer).slice(0, 160))
}
// U 针（U1-U3）无独立探针轮：filler 轮内给出、模型后续轮是否仍持有以"探针轮无异常"作弱证据；
// 不单独占 30 轮之一（避免探针过密挤占压缩触发空间）。probes 数组仅含 D1-D4/G1/R1/R2 七项。

const recallCalls = agent.session.events.filter(e => e.type === 'tool/call'
  && ['recall_pruned', 'list_pruned', 'recall_summary', 'recall_detail'].includes((e.data as { name?: string }).name ?? '')).length
const zoomCalls = agent.session.events.filter(e => e.type === 'tool/call'
  && ['recall_summary', 'recall_detail'].includes((e.data as { name?: string }).name ?? '')).length

// 成本
let miss = 0, hit = 0, out = 0
for (const t of turnStats) { miss += Math.max(0, t.input); hit += t.hit; out += Math.max(0, t.out) }
const P_MISS = 1.5, P_HIT = 0.05, P_OUT = 4.5 // v4-flash 空闲锚（本地折算下界，06c 同口径）
const cost = miss * P_MISS / 1e6 + hit * P_HIT / 1e6 + out * P_OUT / 1e6
const hitRate = hit + miss > 0 ? 100 * hit / (hit + miss) : 0
// D 臂真实成本（含引擎内部摘要 LLM 调用）：全口径，兼容 dsh(inputTokens) 与 openai(prompt_tokens) 两种 usage 格式
const eventUsage = (e: { data?: any }): { m: number; h: number; o: number } | null => {
  const u = (e as any).data?.usage
  if (!u) return null
  const m = u.inputTokens ?? u.prompt_tokens ?? 0
  const h = u.cacheReadTokens ?? u.prompt_tokens_details?.cached_tokens ?? 0
  const o = u.outputTokens ?? u.completion_tokens ?? 0
  if (m + h + o === 0) return null
  return { m, h, o }
}
let allMiss = 0, allHit = 0, allOut = 0
for (const e of agent.session.events) {
  const u = eventUsage(e)
  if (u) { allMiss += u.m; allHit += u.h; allOut += u.o }
}
const allLlmCost = {
  missTokens: allMiss, hitTokens: allHit, outTokens: allOut,
  totalYuan: +(allMiss * P_MISS / 1e6 + allHit * P_HIT / 1e6 + allOut * P_OUT / 1e6).toFixed(4),
}
// 换代轮（genΔ>0）命中率单列（A 臂判据：换代轮除外 ≥95%）。
// 注意：genΔ>0 = 该轮 surface.replaceGeneration 增加 = 该轮发生 surface 替换（缓存前缀在该点之后失效）。
// 替换来源在 A 臂有两类：图引擎 Stage-2 剪枝（compaction/start + engine.records）
// 与 peratom compressor 主动逐原子降熵（无 compaction/start，仅顶 replaceGeneration）。
// 两类都会顶换代/击穿缓存，故统一按 genΔ>0 判"换代轮"，不区分来源；来源细分见 engineRecords 与 compressorCalls。
const perTurn = turnStats.filter(s => s.input + s.hit > 0)
const genBumpTurns = turnLog.filter(t => t.genDelta > 0)
const nonCompressHit = (() => {
  // 逐轮 hit%：turnStats 按轮聚合（一轮可能多 assistant 消息）
  const byTurn = new Map<number, { m: number; h: number }>()
  for (const s of perTurn) {
    const rec = byTurn.get(s.turn) ?? { m: 0, h: 0 }
    rec.m += s.input; rec.h += s.hit
    byTurn.set(s.turn, rec)
  }
  // turnLog[i] 与 items[i] 一一对应；第 i 项是第 i+1 次 followup = assistant turn i+1（37a 实证 turn 从 1 起）
  const compressTurnSet = new Set(turnLog.filter(t => t.genDelta > 0).map((_, i) => i + 1))
  let m = 0, h = 0
  for (const [turn, rec] of byTurn) {
    if (!compressTurnSet.has(turn)) { m += rec.m; h += rec.h }
  }
  return m + h > 0 ? 100 * h / (m + h) : 100
})()

// ---------- 产物落盘 ----------
const result = {
  spike: '37-three-arm',
  arm: ARM,
  config: { contextWindow: CONTEXT_WINDOW, windowTokens: WINDOW_TOKENS, retainTokens: RETAIN_TOKENS, maxTurns: MAX_TURNS, hasDeclarer: HAS_DECLARER, isPeratom: IS_PERATOM },
  at: new Date().toISOString(),
  model: 'qwen-local/' + MODEL,
  base: BASE,
  wallSeconds: Math.round((Date.now() - startedAt) / 1000),
  turnsPlanned: items.length,
  turnsCompleted: completedTurns,
  maxSustainedTurns: maxSustained,
  aborted,
  pruneTransactions: engine.records?.length ?? 0,
  cost: {
    missTokens: miss, hitTokens: hit, outTokens: out,
    missYuan: +(miss * P_MISS / 1e6).toFixed(4), hitYuan: +(hit * P_HIT / 1e6).toFixed(4), outYuan: +(out * P_OUT / 1e6).toFixed(4),
    totalYuan: +cost.toFixed(4), cacheHitRatePct: +hitRate.toFixed(1),
    aux: auxStats, // compressor/declarer 的 LLM 调用（本地，计入输出税）
  },
  summaryCompactions: agent.session.events.filter(e => e.type === 'compaction/summary').length,
  allLlmCost, // D 臂真实成本（含引擎内部摘要 LLM 调用全口径）
  nonCompressHitRatePct: +nonCompressHit.toFixed(1),
  genBumpTurns: genBumpTurns.map(t => t.label),
  probes,
  probeCorrect: probes.filter(p => p.correct).length,
  probeTotal: probes.length,
  recallCalls,
  zoomCalls,
  engineRecords: engine.records ?? null,
  declarerCachedEdges: stack?.declarer?.cachedEdgeCount ?? 0,
  compressorCalls: stack?.compressor?.calls ?? 0,
  originals: { count: originalHashes.size, allIntact: origCheck.ok, bad: origCheck.bad },
  turnStats,
  turnLog,
  verdict: { failures },
}
fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2), 'utf8')
fs.writeFileSync(path.join(outDir, 'events.jsonl'), agent.session.events.map(e => JSON.stringify(e)).join('\n'), 'utf8')

// ---------- 判决项 ----------
verdict('P5-turns', completedTurns === items.length && !aborted,
  '完成轮数 ' + completedTurns + '/' + items.length + (aborted ? '（中止于 ' + maxSustained + '）' : ''))
if (ARM !== 'D') {
  verdict('P5-originals', origCheck.ok,
    '防干涉：' + originalHashes.size + ' 个 append-origin 事件原文' + (origCheck.ok ? '零替换' : '被替换 ' + origCheck.bad.length + ' 个: ' + origCheck.bad.slice(0, 10).join(',')))
} else {
  console.log('[SKIP P5-originals] D 臂为摘要压缩基线，历史本就被 LLM 改写，防干涉判据不适用（属设计使然）')
}
const dProbes = probes.filter(p => p.probe.startsWith('D'))
const rProbes = probes.filter(p => p.probe.startsWith('R'))
const gProbes = probes.filter(p => p.probe === 'G1')
console.log('\n=== 探针聚合 ===')
console.log('D(exact 跨轮依赖) ' + dProbes.filter(p => p.correct).length + '/' + dProbes.length
  + ' R(exact 找回) ' + rProbes.filter(p => p.correct).length + '/' + rProbes.length
  + ' G(gist) ' + gProbes.filter(p => p.correct).length + '/' + gProbes.length
  + ' | recall 调用=' + recallCalls + ' zoom 调用=' + zoomCalls)
console.log('=== 成本 ===')
console.log('miss=' + miss + ' hit=' + hit + ' out=' + out + ' hit%=' + hitRate.toFixed(1) + '（非压缩轮 ' + nonCompressHit.toFixed(1) + '%）'
  + ' aux: calls=' + auxStats.calls + ' completion=' + auxStats.completion)
console.log('=== 压缩 ===')
console.log('boundaries=' + (engine.records?.length ?? 0) + '（图引擎剪枝事务）换代轮=' + genBumpTurns.length + '（' + genBumpTurns.map(t => t.label).join(',') + '，含 peratom 主动替换）摘要压缩事务=' + agent.session.events.filter(e => e.type === 'compaction/summary').length)

console.log('\n产物：' + outDir)
console.log(failures.length === 0
  ? 'SPIKE 37 (' + ARM + '): 无失败判决项'
  : 'SPIKE 37 (' + ARM + '): ' + failures.length + ' 项未过')

await ctx.fiber.dispose()
process.exit(0)
