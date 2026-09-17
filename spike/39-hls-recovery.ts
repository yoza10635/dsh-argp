/**
 * spike 39 — HLS 修复档（PROPOSAL-token-ontology 组件 B）× spike34 语料重放（v1.2.0 验收）
 *
 * 背景：spike34 证实本地小模型的 extract 会不自觉改写 file:line / key=value / 错误码
 * （原始保真服从率远低于 100%）。v1.1 的处置 = 硬拒（原文保面，0% 压缩）；v1.2 的
 * HLS 修复档填补矩阵缺格 = **软有损 + 硬无损**：模型 prose 照落盘，守卫缺失的承重
 * token 按原文顺序以 [restored] 尾注逐字补全——硬 token 保真由构造（I-B1），
 * 压缩收益大部分保留。
 *
 * 两种模式：
 *   offline（恒跑，0-LLM）：6 个 spike34 构造用例（F1-F6，与 34 同语料）各配一个
 *     **经典坏候选**（本地模型实证失败形态：file:line 改写 / 错误码意译 / marker 截断 /
 *     自定义 scheme 丢失），走 planReplacements 真实管线（tool 档，trailer(θ=1)/trailer(θ=0)/off 三跑）。
 *
 *     ⚠️ 口径分离（2026-09-15 修正）：机制不变量（I-B1/I-B3）针对 `repairWithTrailer`
 *     **本体**核算——它们与"值不值得修"无关；经济性（I-B5 门控）针对 planReplacements 的
 *     放行/拒收核算。此前二者混用（用 plan 度量不变量），门控一经引入即全线误报 FAIL。
 *       S39-1 I-B1 机制级：6/6 修复副本（本体检）通过保真守卫，缺失硬 token 全部逐字补回
 *       S39-2 I-B3 机制级 + 台账：6/6 只追加（candidate 逐字节前缀、补入 ⊆ 原文 token 集）；
 *             放行例的 restoredByGuard == 守卫缺失清单，拒收例台账为空
 *       S39-3 Pareto（门控感知）：**落盘子集**的 surface 节省率 > 0 且硬 token 100%；
 *             off 臂节省 0（"软有损+硬无损"缺格成立——介于 v1.1 拒收与原样放行之间）
 *       S39-6 门控一致性（I-B5 端到端）：落盘集 == {ROI ≥ θ}；放行⇒hlsRepairs=1/skippedFidelity=0，
 *             拒收⇒hlsRoiSkipped=1/steps=0/skippedFidelity=1
 *       S39-4 哨兵口径观察（spike34 判据，机制口径）：修复副本哨兵保留 18/24——缺口全部来自
 *             **词表边界**（自定义 scheme URL / 无扩展名路径 / 'sha256:' 前缀式哈希 /
 *             复合定位被拆成多 token），非修复机制失效；hard-token 口径 100%
 *       S39-5 fixture 卫生：6 候选全部 <95% 原文（过 no-op 门，真进修复档）
 *     实测 ROI（θ=1 判据 = 净释放/尾注）逐例：F1=0.02 / F2=1.48 / F3=0.80 / F4=0.07 /
 *       F5=0.29 / F6=2.14（聚合 0.49）→ **仅 F2/F6 落盘**，其余 4 例退回原文保面——
 *       这正是"代价盲"被修正的证据（未加门控时 6/6 全补，其中 4 例修复后 ≥ 原文 = 负收益）。
 *   live（仅 QWEN_BASE :8080 存活时）：真模型生成候选，PeratomCompressor 完整链路
 *     （hlsMode trailer/off 双臂 compressCurrentTurn）：
 *       VG-live：两臂 surface 均无缺哨兵副本（violation=0）
 *       报告 live 修复次数 / 台账 / 逐臂哨兵保留率
 *
 * 用法：npm run spike39（offline 恒跑；live 自动探测 :8080，缺失则跳过并注明）
 * 产物：spike/out/39-hls-recovery-<stamp>.json
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Session as SessionT } from '@deepseek-ai/dsh-session'
import { PeratomCompressor, planReplacements, type CompressDecision, type CurrentTurnCollect } from '../src/peratom/compressor.ts'
import { sessionEvents } from '../src/log-access.ts'
import { DEFAULT_HLS_ROI_THRESHOLD, fidelityGuard, findLoadBearingTokens, hlsRepairEconomics, repairWithTrailer } from '../src/token-ontology.ts'

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const outDir = path.join(import.meta.dirname, 'out')
fs.mkdirSync(outDir, { recursive: true })

const BASE = (process.env['QWEN_BASE'] ?? 'http://127.0.0.1:8080/v1').replace(/\/$/, '')
const MODEL = process.env['QWEN_MODEL'] ?? 'Qwen3.6-35B-A3B'
const ENDPOINT = BASE + '/chat/completions'
const TIMEOUT_MS = 240_000

const failures: string[] = []
const verdict = (name: string, ok: boolean, detail: string): void => {
  console.log((ok ? '[PASS ' : '[FAIL ') + name + '] ' + detail)
  if (!ok) failures.push(name + ': ' + detail)
}

// ---------------------------------------------------------------------------
// 语料（与 spike 34 构造集逐字相同）+ 经典坏候选（本地模型实证失败形态）
// ---------------------------------------------------------------------------

interface Case {
  id: string
  note: string
  sentinels: { cls: string; value: string }[]
  toolText: string
  badCandidate: string
}

const CASES: Case[] = [
  {
    id: 'F1-stack',
    note: 'Node 堆栈：路径+行号+错误码+trace',
    sentinels: [
      { cls: 'path', value: '/opt/app/src/cache/lru.ts' },
      { cls: 'line', value: 'lru.ts:141:19' },
      { cls: 'errcode', value: 'ERR_CACHE_EVICTION_0x1F4' },
      { cls: 'marker', value: 'trace-id=9f2c1ab7-e5d4-4b3a-8c1d-2e3f4a5b6c7d' },
    ],
    toolText: `Error: ERR_CACHE_EVICTION_0x1F4 cache over budget evicted=4096 entries\n`
      + `    at LRU.evict (/opt/app/src/cache/lru.ts:141:19)\n`
      + `    at Cache.put (/opt/app/src/cache/index.ts:88:7)\n`
      + `    at handler (/opt/app/src/routes/user.ts:52:10)\n`
      + `trace-id=9f2c1ab7-e5d4-4b3a-8c1d-2e3f4a5b6c7d span=root elapsed_ms=4123\n`
      + `    at async process.processTicksAndRejections (node:internal/process/task_queues:95:5)\n`
      + `budget bytes=268435456 used=271106048 overshoot=2670592 policy=lru-ttl-600\n`,
    // 坏形态：行号改写（'line 141'）、错误码消失、trace-id 截断成裸 UUID 残段
    badCandidate: `stack: LRU.evict (/opt/app/src/cache/lru.ts line 141) and Cache.put; trace 9f2c1ab7-e5d4-4b3a-8c1d span root; budget 268435456 used 271106048 (lru-ttl-600)`,
  },
  {
    id: 'F2-config',
    note: '配置转储：文件路径+行号+错误码+连接串',
    sentinels: [
      { cls: 'path', value: '/etc/myapp/database.yml' },
      { cls: 'line', value: 'database.yml:17' },
      { cls: 'errcode', value: 'ECONNREFUSED' },
      { cls: 'marker', value: 'postgres://svc_ro@10.0.3.17:5432/orders' },
    ],
    toolText: `$ cat /etc/myapp/database.yml\n`
      + `production:\n  adapter: postgresql\n  host: 10.0.3.17\n  port: 5432\n`
      + `  database: orders\n  username: svc_ro\n  pool: 25\n  timeout: 5000 # see database.yml:17\n`
      + `$ psql check\npsql: error: connection refused (ECONNREFUSED) to postgres://svc_ro@10.0.3.17:5432/orders\n`
      + `hint: pg_hba may deny subnet 10.0.3.0/24; logs at /var/log/postgresql/postgresql-16-main.log\n`,
    // 坏形态：行号引用消失、ECONNREFUSED 意译成 refused、连接串丢 scheme
    badCandidate: `db config /etc/myapp/database.yml: adapter postgresql, host 10.0.3.17:5432, user svc_ro, pool 25 timeout 5000; psql refused to connect (refused); pg_hba may deny the subnet`,
  },
  {
    id: 'F3-http',
    note: 'HTTP 429：路径+行号+错误码+请求 ID',
    sentinels: [
      { cls: 'path', value: '/v2/users?cursor=zz90' },
      { cls: 'line', value: 'rate_limit.go:77' },
      { cls: 'errcode', value: 'RATE_LIMITED_429' },
      { cls: 'marker', value: 'x-request-id: 7c9e6679-7425-40de-944b-e07fc1f90ae7' },
    ],
    toolText: `HTTP/1.1 429 Too Many Requests\n`
      + `x-request-id: 7c9e6679-7425-40de-944b-e07fc1f90ae7\n`
      + `retry-after: 30\n\n`
      + `{"error":{"code":"RATE_LIMITED_429","message":"quota exceeded for key ak-live-8842",`
      + `"where":"rate_limit.go:77","path":"/v2/users?cursor=zz90","reset_at":"2026-08-25T04:30:00Z"}}\n`
      + `curl replay: curl -H 'Authorization: Bearer ak-live-8842' https://api.example.com/v2/users?cursor=zz90\n`,
    // 坏形态：路径丢查询串、'line 77' 改写、429 意译、请求 ID 头名丢失
    badCandidate: `HTTP 429 on /v2/users (cursor zz90): quota exceeded for key ak-live-8842 at rate_limit.go line 77; retry after 30s`,
  },
  {
    id: 'F4-sql',
    note: 'SQL 死锁：表+SQLSTATE+事务标识+日志定位',
    sentinels: [
      { cls: 'path', value: 'migration/V16__add_index.sql' },
      { cls: 'line', value: 'db/lock.log:441' },
      { cls: 'errcode', value: 'SQLSTATE=40001' },
      { cls: 'marker', value: 'victim=txn#8821' },
    ],
    toolText: `[db] 2026-08-24T10:15:09 ERROR deadlock detected on table orders\n`
      + `[db] 2026-08-24T10:15:09 SQLSTATE=40001 victim=txn#8821 blocker=txn#8790\n`
      + `[db] waiting query: UPDATE orders SET status='paid' WHERE id IN (SELECT order_id FROM fulfillment WHERE batch=77)\n`
      + `[db] full log: db/lock.log:441 context=nightly migration/V16__add_index.sql created index concurrently\n`
      + `[db] locks: relation=orders idx=idx_fulfillment_batch mode=ShareLock\n`,
    // 坏形态：'line 441' 改写、migration 文件名意译、SQLSTATE 消失、txn 标识丢分隔符
    badCandidate: `deadlock on orders: victim txn 8821 blocked by txn 8790; waiting UPDATE orders paid; full log at db/lock.log line 441; created concurrently by migration 16; lock on idx_fulfillment_batch (ShareLock)`,
  },
  {
    id: 'F5-build',
    note: '构建日志：产物+行号+失败码+哈希',
    sentinels: [
      { cls: 'path', value: 'dist/bundle.main.js' },
      { cls: 'line', value: 'build.log:210' },
      { cls: 'errcode', value: 'BUILD_FAILED_EXIT=134' },
      { cls: 'marker', value: 'sha256:3f79bb7b435b05321651daefd374cdc681dc06faa65e374e38337b88ca046dea' },
    ],
    toolText: `[deploy] step 12/18 minify ok sha256:3f79bb7b435b05321651daefd374cdc681dc06faa65e374e38337b88ca046dea\n`
      + `[deploy] step 13/18 sourcemap dist/bundle.main.js.map ok\n`
      + `[deploy] step 14/18 smoke FAILED BUILD_FAILED_EXIT=134 (SIGABRT during canary boot)\n`
      + `[deploy] detail build.log:210 node --max-old-space-size=4096 scripts/smoke.js canary-2\n`
      + `[deploy] artifacts kept: dist/bundle.main.js dist/bundle.vendor.js (7.2 MiB total)\n`,
    // 坏形态：'exit 134' 意译、行号消失、sha256 前缀式哈希整个丢失
    badCandidate: `deploy step 14/18 smoke failed (exit 134, SIGABRT) during canary boot; kept dist/bundle.main.js dist/bundle.vendor.js (7.2 MiB); detail in build.log with node --max-old-space-size=4096`,
  },
  {
    id: 'F6-metrics',
    note: '指标行：路由+采样源+错误码+节点标识',
    sentinels: [
      { cls: 'path', value: 'GET /api/orders/{id}' },
      { cls: 'line', value: 'metrics.jsonl:1002' },
      { cls: 'errcode', value: 'UPSTREAM_TIMEOUT_ETIMEDOUT' },
      { cls: 'marker', value: 'host=pay-gw-i-0fe3ab91cd24' },
    ],
    toolText: `{"window":"2026-08-24T10:00Z/5m","route":"GET /api/orders/{id}","source":"metrics.jsonl:1002"\n`
      + `,"p50_ms":120,"p95_ms":480,"p99_ms":1120,"err_rate":0.031,"codes":{"UPSTREAM_TIMEOUT_ETIMEDOUT":41,"5xx":7}\n`
      + `,"worst_node":"host=pay-gw-i-0fe3ab91cd24","notes":"retry storm suspected after deploy 22:14"\n`
      + `{"window":"2026-08-24T10:05Z/5m","route":"GET /api/orders/{id}","p99_ms":1980,"err_rate":0.058}\n`,
    // 坏形态：路由整段意译、采样源消失、错误码意译成 error rate、节点标识只剩 'pay-gw node'
    badCandidate: `orders route p99 degraded 1120ms to 1980ms with error rate 3.1% to 5.8% after 22:14 deploy; retry storm suspected on pay-gw node`,
  },
]

// ---------------------------------------------------------------------------
// offline 模式：planReplacements 双档（trailer / off）
// ---------------------------------------------------------------------------

interface OfflineRow {
  id: string
  note: string
  originalChars: number
  candidateChars: number
  trailerCost: number
  expectedRepairedChars: number
  /** 落盘文本长度（被门控拒收时为 0——原子保原文，不产生 replace 步）。 */
  landedChars: number
  tokensOriginal: number
  tokensMissing: number
  /** 机制口径：均以 `repairWithTrailer` 本体核算（与门控无关）。 */
  expectedGuardOk: boolean
  expectedAppendOnly: boolean
  expectedTokensMissing: number
  /** 经济学口径：门控判决。 */
  roi: number
  netRelease: number
  landed: boolean
  gated: boolean
  sentinelsKeptCandidate: number
  sentinelsKeptExpected: number
  sentinelsTotal: number
  planT: { steps: number; hlsRepairs: number; hlsRoiSkipped: number; skippedFidelity: number; skippedNoopGain: number }
  planM: { steps: number; hlsRepairs: number; hlsRoiSkipped: number }
  planO: { steps: number; hlsRepairs: number; hlsRoiSkipped: number; skippedFidelity: number; skippedNoopGain: number }
  restoredByGuard: string[]
  /** 守卫缺失清单（台账比对基准）。 */
  missingTokens: string[]
  candidateIsNoop: boolean
}

/**
 * replace 步的副本文本收窄视图（`PlannedStep.data` 为 unknown）。
 * 必须用具名 interface 而非内联断言：内联的嵌套泛型会写出相邻的 `>>`
 * （如 `Array<{ content: Array<{ text: string }>> }`），而 Node 的
 * type-stripping 解析器把 `>>` 当移位运算符 → ERR_INVALID_TYPESCRIPT_SYNTAX。
 */
interface StepView {
  data: { message: { content: Array<{ content: Array<{ text: string }> }> } }
}

function runOfflineCase(c: Case): OfflineRow {
  const collect: CurrentTurnCollect = {
    turn: 1,
    startSeq: 5,
    endSeq: 5,
    interrupted: false,
    userLong: [],
    toolResults: [{ kind: 'tool-result', seq: 5, turn: 1, text: c.toolText, callId: 'c_' + c.id }],
  }
  const origEvent = {
    type: 'tool/result',
    seq: 5,
    time: 0,
    surfaceOp: 'append',
    data: {
      message: {
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: 'c_' + c.id, content: [{ type: 'text', text: c.toolText }], isError: false }],
        source: { kind: 'tool', callId: 'c_' + c.id },
      },
    },
  } as never
  const decision: CompressDecision = { splits: [], tools: [{ seq: 5, level: 'extract', text: c.badCandidate }] }

  // T = trailer（θ 缺省 1）；M = trailer 但 θ=0（只要求净释放为正，用于显现 θ 旋钮效果）；O = off
  const planT = planReplacements(collect, decision, [origEvent], { hlsMode: 'trailer' })
  const planM = planReplacements(collect, decision, [origEvent], { hlsMode: 'trailer', hlsRoiThreshold: 0 })
  const planO = planReplacements(collect, decision, [origEvent], { hlsMode: 'off' })

  const guard = fidelityGuard(c.toolText, c.badCandidate)
  const expected = repairWithTrailer(c.badCandidate, guard.missing)
  const econ = hlsRepairEconomics(c.toolText.length, c.badCandidate.length, guard.missing)

  // 落盘文本：门控放行时 planT 有 1 个 replace 步；被拒时 0 步（原子保原文）
  const firstNameStep = planT.steps[0] as StepView | undefined
  const landedText: string | null = firstNameStep === undefined
    ? null
    : firstNameStep.data.message.content[0]!.content[0]!.text

  const origTokens = findLoadBearingTokens(c.toolText)
  const sentinelsKeptIn = (text: string | null): number =>
    text === null ? 0 : c.sentinels.filter(s => text.includes(s.value)).length

  // 机制不变量（I-B1/I-B3）口径 = repairWithTrailer 本体，与门控无关
  const expectedMissing = fidelityGuard(c.toolText, expected).missing.length
  const expectedAppendOnly = expected.startsWith(c.badCandidate)
    && expected.slice(c.badCandidate.length).startsWith('\n[restored] ')
    && expected.slice(c.badCandidate.length + '\n[restored] '.length).split(' ')
        .every(t => t === '' || origTokens.includes(t))

  return {
    id: c.id,
    note: c.note,
    originalChars: c.toolText.length,
    candidateChars: c.badCandidate.length,
    trailerCost: econ.trailerCost,
    expectedRepairedChars: expected.length,
    landedChars: landedText?.length ?? 0,
    tokensOriginal: origTokens.length,
    tokensMissing: guard.missing.length,
    expectedGuardOk: fidelityGuard(c.toolText, expected).ok,
    expectedAppendOnly,
    expectedTokensMissing: expectedMissing,
    roi: econ.roi,
    netRelease: econ.netRelease,
    landed: planT.hlsRepairs === 1,
    gated: planT.hlsRoiSkipped === 1,
    sentinelsKeptCandidate: sentinelsKeptIn(c.badCandidate),
    sentinelsKeptExpected: sentinelsKeptIn(expected),
    sentinelsTotal: c.sentinels.length,
    planT: {
      steps: planT.steps.length,
      hlsRepairs: planT.hlsRepairs,
      hlsRoiSkipped: planT.hlsRoiSkipped,
      skippedFidelity: planT.skippedFidelity,
      skippedNoopGain: planT.skippedNoopGain,
    },
    planM: { steps: planM.steps.length, hlsRepairs: planM.hlsRepairs, hlsRoiSkipped: planM.hlsRoiSkipped },
    planO: {
      steps: planO.steps.length,
      hlsRepairs: planO.hlsRepairs,
      hlsRoiSkipped: planO.hlsRoiSkipped,
      skippedFidelity: planO.skippedFidelity,
      skippedNoopGain: planO.skippedNoopGain,
    },
    restoredByGuard: planT.restoredByGuard,
    missingTokens: guard.missing,
    candidateIsNoop: c.badCandidate.length >= c.toolText.length * 0.95,
  }
}

// ---------------------------------------------------------------------------
// live 模式（可选）：真模型候选 × PeratomCompressor 完整链路
// ---------------------------------------------------------------------------

function buildLiveSession(c: Case): SessionT {
  const session = Session.create(SessionId('spike39-' + c.id))
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: '看看这个输出，帮我总结关键信息' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: {
      role: 'assistant',
      id: 'am_' + c.id,
      source: { kind: 'model', provider: 'local', model: MODEL },
      content: [
        { type: 'tool-call', id: 'call-' + c.id, name: 'read_file', arguments: '{"path":"x"}' },
        { type: 'text', text: 'on it' },
      ],
    },
  } as never, { surfaceOp: 'append' })
  session.append('tool/result', {
    turn: 1,
    step: 1,
    message: {
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: 'call-' + c.id, content: [{ type: 'text', text: c.toolText }], isError: false }],
      source: { kind: 'tool', callId: 'call-' + c.id },
      id: 'm_' + c.id,
    },
  } as never, { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } } as never)
  return session
}

interface LiveRow {
  id: string
  arm: 'trailer' | 'off'
  called: boolean
  outcome: string
  retained: number
  total: number
  hlsRepairs: number
  restoredByGuard: string[]
  copyPreview: string
}

async function liveEndpointAlive(): Promise<boolean> {
  try {
    const res = await fetch(BASE + '/models', { signal: AbortSignal.timeout(3000) })
    return res.ok
  } catch {
    return false
  }
}

async function runLiveCase(c: Case, arm: 'trailer' | 'off'): Promise<LiveRow> {
  const ctx = new Context()
  const compressor = new PeratomCompressor(ctx, {
    endpoint: ENDPOINT,
    apiKey: 'dummy-local',
    model: MODEL,
    timeoutMs: TIMEOUT_MS,
    chatTemplateKwargs: { enable_thinking: false },
    smallResultChars: 100,
    hlsMode: arm,
  })
  const session = buildLiveSession(c)
  const record = await compressor.compressCurrentTurn(session)
  let copyText: string | null = null
  // dsh 0.1.5 起 `Session.events` 已移除（1.1.0 CHANGELOG「Session.events 彻底消失」），
  // 一律经 log-access 的 sessionEvents() 读日志（与 spike38 同纪律）。
  const events = sessionEvents(session)
  const kinds = events.map(e => e.type)
  const endIdx = kinds.lastIndexOf('compaction/end')
  if (endIdx > 0) {
    for (let i = endIdx - 1; i > 0; i -= 1) {
      const ev = events[i]
      if (ev?.type === 'compaction/start') break
      if (ev?.type === 'tool/result') {
        copyText = ((ev.data as { message?: { content?: { content?: { text?: string }[] }[] } }).message?.content?.[0]?.content?.[0]?.text) ?? ''
        break
      }
    }
  }
  let kept = 0
  if (copyText !== null) kept = c.sentinels.filter(s => copyText.includes(s.value)).length
  let outcome: string
  if (record?.called !== true) outcome = 'not-called'
  else if (record.parseFailed === true) outcome = 'parse-failed'
  else if (copyText === null) outcome = 'guard-rejected'
  else if (kept === c.sentinels.length) outcome = 'full'
  else outcome = 'violation'
  const row: LiveRow = {
    id: c.id,
    arm,
    called: record?.called === true,
    outcome,
    retained: kept,
    total: c.sentinels.length,
    hlsRepairs: record?.hlsRepairs ?? 0,
    restoredByGuard: record?.restoredByGuard ?? [],
    copyPreview: (copyText ?? '').slice(0, 120),
  }
  await ctx.fiber.dispose()
  return row
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const t0 = Date.now()
  console.log('[spike39] HLS 修复档 × spike34 语料（6 用例 × 24 哨兵）')

  // ---------- offline（恒跑） ----------
  const rows = CASES.map(runOfflineCase)

  // S39-1 I-B1（机制口径）：不变量针对 `repairWithTrailer` 本体，与门控无关
  const allExpectedGuardOk = rows.every(r => r.expectedGuardOk)
  const totalTok = rows.reduce((s, r) => s + r.tokensOriginal, 0)
  const totalMissing = rows.reduce((s, r) => s + r.tokensMissing, 0)
  const stillMissing = rows.reduce((s, r) => s + r.expectedTokensMissing, 0)
  verdict('S39-1 I-B1-corpus', allExpectedGuardOk && stillMissing === 0,
    `6/6 修复副本（repairWithTrailer 本体）通过保真守卫；硬 token 保真 ${totalTok - stillMissing}/${totalTok} = `
    + `${(((totalTok - stillMissing) / Math.max(totalTok, 1)) * 100).toFixed(1)}%（构造性 100%；缺 ${totalMissing} 个已全部逐字补回）`)

  // S39-2 I-B3 + 台账（机制口径 + 落盘台账）
  const allAppend = rows.every(r => r.expectedAppendOnly)
  const ledgerOk = rows.every(r => r.landed
    ? JSON.stringify(r.restoredByGuard) === JSON.stringify(r.missingTokens)
    : r.restoredByGuard.length === 0)
  verdict('S39-2 I-B3+ledger', allAppend && ledgerOk,
    `6/6 只追加（candidate 逐字节前缀 + 补入 ⊆ 原文 token 集）；落盘台账 == 守卫缺失清单`
    + `（放行的 ${rows.filter(r => r.landed).length} 例）／空账（被拒的 ${rows.filter(r => r.gated).length} 例）`)

  // S39-3 Pareto（经济学口径，门控感知）：节省率只在**落盘**子集上计算
  const landedRows = rows.filter(r => r.landed)
  const landedOrig = landedRows.reduce((s, r) => s + r.originalChars, 0)
  const landedChars = landedRows.reduce((s, r) => s + r.landedChars, 0)
  const landedSavings = landedOrig === 0 ? 0 : 1 - landedChars / landedOrig
  const worstLandedSavings = landedRows.length === 0 ? 0 : Math.min(...landedRows.map(r => 1 - r.landedChars / r.originalChars))
  verdict('S39-3 pareto-gap', landedRows.length > 0 && landedSavings > 0 && allExpectedGuardOk,
    `trailer 臂：落盘 ${landedRows.length}/${rows.length} 例（${landedRows.map(r => r.id).join(',')}），`
    + `落盘子集 surface 节省 ${(landedSavings * 100).toFixed(1)}%（${landedOrig} → ${landedChars} 字符）且硬 token 100%；`
    + `off 臂节省 0%——填补 {0% 压缩, 100% 保留} 与 {全放行} 之间的"软有损+硬无损"缺格`)

  // S39-6 门控一致性（I-B5 端到端）：落盘集 == 解析判据 {ROI ≥ θ}，且放行/拒收记账互斥
  const predicted = rows.filter(r => r.roi >= DEFAULT_HLS_ROI_THRESHOLD).map(r => r.id)
  const actual = landedRows.map(r => r.id)
  const sameSet = JSON.stringify(predicted) === JSON.stringify(actual)
  const accountingOk = rows.every(r => r.landed
    ? (r.planT.hlsRepairs === 1 && r.planT.hlsRoiSkipped === 0 && r.planT.steps === 1 && r.planT.skippedFidelity === 0)
    : (r.planT.hlsRepairs === 0 && r.planT.hlsRoiSkipped === 1 && r.planT.steps === 0 && r.planT.skippedFidelity === 1))
  verdict('S39-6 gate-consistency', sameSet && accountingOk,
    `落盘集 == {ROI ≥ ${DEFAULT_HLS_ROI_THRESHOLD}}：预测 [${predicted.join(',')}] 实测 [${actual.join(',')}]；`
    + `放行⇒hlsRepairs=1/skippedFidelity=0，拒收⇒hlsRoiSkipped=1/steps=0/skippedFidelity=1（原子保原文）`)

  // 逐例明细（经济学边界现在按 ROI 排序可见）
  console.log(`[INFO S39-3b] 逐例 ROI = 净释放/尾注（θ=${DEFAULT_HLS_ROI_THRESHOLD}）：`)
  for (const r of [...rows].sort((a, b) => b.roi - a.roi)) {
    console.log(`         ${r.id}: 原文 ${r.originalChars} / 候选 ${r.candidateChars} / 尾注 ${r.trailerCost} → ROI=${r.roi.toFixed(3)} `
      + `${r.landed ? '✓落盘' : '✗退回原文'}${r.landed ? `（节省 ${((1 - r.landedChars / r.originalChars) * 100).toFixed(1)}%）` : `（修复本会到 ${r.expectedRepairedChars} 字符，反而 ${r.netRelease >= 0 ? '省' : '多'} ${Math.abs(r.netRelease)}）`}`)
  }
  console.log(`[INFO S39-3c] 代价盲修正的净效果：未加门控时 6/6 全补（合计修复 ${rows.reduce((s, r) => s + r.expectedRepairedChars, 0)} 字符，`
    + `其中 ${rows.filter(r => !r.landed).length} 例修复后 ≥ 原文 → 负收益）；加门控后落盘 ${landedRows.length} 例，`
    + `被拒的 ${rows.filter(r => r.gated).length} 例退回原文保面，杜绝"越修越长"。`)
  const planM = rows.filter(r => r.planM.hlsRepairs === 1).map(r => r.id)
  console.log(`[INFO S39-3d] θ 旋钮效果：θ=0（只要求净释放 > 0）→ 落盘 [${planM.join(',')}]（比 θ=1 多接受 ROI∈(0,1) 的边际例）`)

  const sentExp = rows.reduce((s, r) => s + r.sentinelsKeptExpected, 0)
  const sentTotal = rows.reduce((s, r) => s + r.sentinelsTotal, 0)
  const sentCandidate = rows.reduce((s, r) => s + r.sentinelsKeptCandidate, 0)
  console.log(`[INFO S39-4] 哨兵口径（spike34 判据，观察项；机制口径 = repairWithTrailer 本体检）：候选保留 ${sentCandidate}/${sentTotal}，修复副本保留 ${sentExp}/${sentTotal} = ${((sentExp / sentTotal) * 100).toFixed(1)}%`)
  // 逐用例列出修复副本仍缺的哨兵（词表边界归因）
  for (const c of CASES) {
    const r = rows.find(x => x.id === c.id)!
    const stepText = repairWithTrailer(c.badCandidate, fidelityGuard(c.toolText, c.badCandidate).missing)
    const lost = c.sentinels.filter(s => !stepText.includes(s.value)).map(s => s.cls + ':' + s.value)
    if (lost.length > 0) console.log(`         ${c.id} 修复副本仍缺（词表外哨兵）：${lost.join(' | ')}`)
  }

  const allNotNoop = rows.every(r => !r.candidateIsNoop)
  verdict('S39-5 fixture-sanity', allNotNoop,
    `6/6 候选 <95% 原文（过 no-op 门进入守卫/修复档，无 fixture 误判 no-op）`)

  // ---------- live（条件） ----------
  let live: LiveRow[] = []
  let liveSkipped = false
  if (await liveEndpointAlive()) {
    console.log(`[live] ${MODEL} @ ${ENDPOINT} 存活——跑双臂 live 链路`)
    for (const c of CASES) {
      live.push(await runLiveCase(c, 'trailer'))
      live.push(await runLiveCase(c, 'off'))
    }
    const violations = live.filter(r => r.outcome === 'violation')
    const liveFull = live.filter(r => r.outcome === 'full').length
    const liveHls = live.filter(r => r.outcome === 'guard-rejected').length
    const liveRepairs = live.reduce((s, r) => s + r.hlsRepairs, 0)
    verdict('VG-live', violations.length === 0 && live.some(r => r.called),
      `live 双臂 12 行：violation=${violations.length}（surface 无缺哨兵副本）；full=${liveFull}；`
      + `HLS 修复落盘=${liveRepairs}；guard-rejected(原文保面)=${liveHls}`)
  } else {
    liveSkipped = true
    console.log('[live] :8080 无本地模型——live 臂跳过（offline 判决独立成立；live 复跑：npm run spike39）')
  }

  // ---------- 报告 ----------
  const report = {
    meta: {
      runAt: new Date().toISOString(),
      durationMs: Date.now() - t0,
      mode: liveSkipped ? 'offline-only' : 'offline+live',
      llmCalls: live.length,
      model: liveSkipped ? null : MODEL,
    },
    rows,
    aggregate: {
      cases: rows.length,
      landedCases: landedRows.length,
      gatedCases: rows.filter(r => r.gated).length,
      landed: { originalChars: landedOrig, repairedChars: landedChars, surfaceSavingsTrailer: landedSavings, worstCaseSavings: worstLandedSavings },
      ifUngated: { repairedChars: rows.reduce((s, r) => s + r.expectedRepairedChars, 0), surfaceSavings: 1 - rows.reduce((s, r) => s + r.expectedRepairedChars, 0) / rows.reduce((s, r) => s + r.originalChars, 0) },
      surfaceSavingsOff: 0,
      hardTokenRetention: (totalTok - stillMissing) / Math.max(totalTok, 1),
      tokensMissing: totalMissing,
      hlsRoiThreshold: DEFAULT_HLS_ROI_THRESHOLD,
      sentinelsCandidate: sentCandidate,
      sentinelsRepaired: sentExp,
      sentinelsTotal: sentTotal,
    },
    live,
    verdicts: failures.length === 0 ? 'ALL PASS' : failures,
  }
  const outFile = path.join(outDir, '39-hls-recovery-' + stamp + '.json')
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2))
  console.log(`\n产物：${outFile}`)
  if (failures.length > 0) {
    console.error('\n=== FAILURES ===')
    for (const f of failures) console.error('  ' + f)
    process.exitCode = 1
  } else {
    console.log('\n=== ALL PASS ===')
  }
}

void main()
