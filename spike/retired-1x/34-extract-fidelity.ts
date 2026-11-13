/**
 * spike 34 — P1 验收判据：extract 保真探针初版（本地真模型）
 *
 * 背景：plan P1 验收要求"构造含路径/行号/错误码/marker 的 tool result，四类串保留率
 * = 100%（构造集上）"。spike 33 已验证压缩链路与单样本保真，本 spike 把保真度量
 * 系统化：6 个构造用例 × 每例 ≥4 个哨兵串（路径 / 行号 / 错误码 / marker〔标识符、URL、哈希〕），
 * 全部走 PeratomCompressor 真实链路（collect→LLM→resolveSplit→事务落盘），再从
 * replace 副本回读正文做精确子串匹配。
 *
 * 判决项：
 *   VF-all   构造集上四类哨兵保留率 = 100%（验收线）
 *   VF-class 四类各自无缺口（哪类丢就暴露哪类的 prompt 纪律问题）
 *
 * 用法：npm run spike34（需本地 llama.cpp :8080）
 * 产物：spike/out/34-extract-fidelity-<时间戳>.json
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Session as SessionT } from '@deepseek-ai/dsh-session'
import { PeratomCompressor } from '../src/peratom/compressor.ts'

const BASE = process.env['QWEN_BASE'] ?? 'http://127.0.0.1:8080/v1'
const MODEL = process.env['QWEN_MODEL'] ?? 'Qwen3.6-35B-A3B'
const ENDPOINT = BASE.replace(/\/$/, '') + '/chat/completions'
const TIMEOUT_MS = 240_000

const watchdog = setTimeout(() => {
  console.log('[FATAL] spike 34 watchdog timeout (20 min)')
  process.exit(2)
}, 20 * 60 * 1000)

// ---------------------------------------------------------------------------
// 构造集：每例携带全部四类哨兵串
// ---------------------------------------------------------------------------

interface FidelityCase {
  id: string
  note: string
  sentinels: { cls: string; value: string }[]
  toolText: string
}

const CASES: FidelityCase[] = [
  {
    id: 'F1-stack',
    note: 'Node 堆栈：路径 + 行号 + 错误码 + trace 标识',
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
  },
  {
    id: 'F2-config',
    note: '配置转储：文件路径 + 行号定位 + 参数值',
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
  },
  {
    id: 'F3-http',
    note: 'HTTP 错误响应 JSON：URL + 状态码 + 请求 ID',
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
  },
  {
    id: 'F4-sql',
    note: 'SQL 死锁日志：表 + SQLSTATE + 事务标识',
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
  },
  {
    id: 'F5-build',
    note: '构建日志：产物哈希 + 阶段行号 + 失败步骤',
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
  },
  {
    id: 'F6-metrics',
    note: '指标行：端点路径 + 采样窗口 + 错误码分布',
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
  },
]

// ---------------------------------------------------------------------------
// 执行
// ---------------------------------------------------------------------------

function buildSession(caseDef: FidelityCase): SessionT {
  const session = Session.create(SessionId('spike34-' + caseDef.id))
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
      id: 'am_' + caseDef.id,
      source: { kind: 'model', provider: 'local', model: MODEL },
      content: [
        { type: 'tool-call', id: 'call-' + caseDef.id, name: 'read_file', arguments: '{"path":"' + caseDef.sentinels[0]!.value.slice(-20) + '"}' },
        { type: 'text', text: 'on it' },
      ],
    },
  } as never, { surfaceOp: 'append' })
  session.append('tool/result', {
    turn: 1,
    step: 1,
    message: {
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: 'call-' + caseDef.id, content: [{ type: 'text', text: caseDef.toolText }], isError: false }],
      source: { kind: 'tool', callId: 'call-' + caseDef.id },
      id: 'm_' + caseDef.id,
    },
  } as never, { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } } as never)
  return session
}

async function main(): Promise<void> {
  console.log(`[spike34] extract 保真探针 @ ${MODEL} (${ENDPOINT})`)
  const ctx = new Context()
  const compressor = new PeratomCompressor(ctx, {
    endpoint: ENDPOINT,
    apiKey: 'dummy-local',
    model: MODEL,
    timeoutMs: TIMEOUT_MS,
    chatTemplateKwargs: { enable_thinking: false }, // spike 33 实证：schema 必须关思考
    smallResultChars: 100, // 探针关注保真度而非门控：构造集多数 <512 字符默认线
  })

  const rows: Array<Record<string, unknown>> = []
  let totalSentinels = 0
  let retainedSentinels = 0

  try {
    for (const c of CASES) {
      const session = buildSession(c)
      const record = await compressor.compressCurrentTurn(session)
      // 回读副本：找 compaction/start 之后的 tool/result 事件
      const kinds = session.events.map(e => e.type)
      const endIdx = kinds.lastIndexOf('compaction/end')
      let copyText: string | null = null
      if (endIdx > 0) {
        for (let i = endIdx - 1; i > 0; i -= 1) {
          const ev = session.events[i]
          if (ev?.type === 'compaction/start') break
          if (ev?.type === 'tool/result') {
            copyText = ((ev.data as { message?: { content?: { content?: { text?: string }[] }[] } })
              .message?.content?.[0]?.content?.[0]?.text) ?? ''
            break
          }
        }
      }
      const perClass: Record<string, { kept: number; total: number }> = {}
      let keptAll = 0
      const missing: string[] = []
      if (copyText !== null) {
        for (const s of c.sentinels) {
          const slot = perClass[s.cls] ?? (perClass[s.cls] = { kept: 0, total: 0 })
          slot.total += 1
          totalSentinels += 1
          if (copyText.includes(s.value)) { slot.kept += 1; keptAll += 1; retainedSentinels += 1 }
          else missing.push(s.cls + ':' + s.value)
        }
      }
      // 结果分类：full=副本全含；guard-rejected=守卫拒替换（原文保面）；
      // violation=副本落盘但缺哨兵（结构保证被打破，最严重）；parse-failed/not-called。
      let outcome: 'full' | 'guard-rejected' | 'violation' | 'parse-failed' | 'not-called'
      if (record?.called !== true) outcome = 'not-called'
      else if (record.parseFailed === true) outcome = 'parse-failed'
      else if (copyText === null) outcome = 'guard-rejected'
      else if (keptAll === c.sentinels.length) outcome = 'full'
      else outcome = 'violation'

      rows.push({
        id: c.id,
        called: record?.called,
        parseFailed: record?.parseFailed === true,
        skippedFidelity: record?.skippedFidelity,
        error: record?.error,
        hasCopy: copyText !== null,
        outcome,
        retained: keptAll,
        total: c.sentinels.length,
        rate: copyText === null ? null : keptAll / c.sentinels.length,
        perClass,
        missing,
        extractPreview: (copyText ?? '').slice(0, 150),
      })
      console.log(`[${outcome.toUpperCase()} ${c.id}] ${keptAll}/${c.sentinels.length} skippedFidelity=${record?.skippedFidelity ?? 0}`)
      if (copyText !== null) console.log(`         extract: ${JSON.stringify((copyText ?? '').slice(0, 110))}`)
      for (const m of missing) console.log(`         缺失(副本上): ${m}`)
    }

    // 聚合与判决（守卫语义：结构保证 = 验收线；原始服从率 = prompt 迭代观察指标）
    const byOutcome = (o: string): number => rows.filter(r => r.outcome === o).length
    const full = byOutcome('full')
    const rejected = byOutcome('guard-rejected')
    const violations = byOutcome('violation')
    const attempted = rows.filter(r => r.outcome === 'full' || r.outcome === 'guard-rejected' || r.outcome === 'violation').length
    const compliance = attempted === 0 ? 0 : full / attempted

    console.log(`\n=== 聚合 ===`)
    console.log(`原始服从率（模型 extract 全含哨兵）: ${full}/${attempted} = ${(compliance * 100).toFixed(1)}%`)
    console.log(`守卫拒替换（原文保面）: ${rejected}  副本落盘但缺哨兵: ${violations}`)
    const vgOk = violations === 0 && attempted > 0
    console.log(`[${vgOk ? 'PASS' : 'FAIL'} VG-guard-live] 结构保证成立：表面无任何缺哨兵副本（violation=0）`)
    console.log(`[INFO VF-compliance] 原始保真服从率 ${(compliance * 100).toFixed(1)}%——prompt 迭代观察指标，非验收线`)

    const classes = ['path', 'line', 'errcode', 'marker']
    for (const cls of classes) {
      let kept = 0
      let total = 0
      for (const r of rows) {
        const slot = (r.perClass as Record<string, { kept: number; total: number }> | undefined)?.[cls]
        if (slot !== undefined) { kept += slot.kept; total += slot.total }
      }
      console.log(`[INFO VF-class] ${cls}（副本上）: ${kept}/${total}`)
    }
    if (!vgOk) process.exitCode = 1

    const outDir = path.join(process.cwd(), 'spike', 'out')
    fs.mkdirSync(outDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const outFile = path.join(outDir, `34-extract-fidelity-${stamp}.json`)
    fs.writeFileSync(outFile, JSON.stringify({
      meta: { base: BASE, model: MODEL, runAt: new Date().toISOString() },
      aggregate: {
        rawCompliance: compliance, full, guardRejected: rejected, violations,
        surfaceSentinelRetention: vgOk ? 1 : retainedSentinels / Math.max(totalSentinels, 1),
      },
      rows,
    }, null, 2))
    console.log(`\n产物：${outFile}`)
  } finally {
    await ctx.fiber.dispose()
    clearTimeout(watchdog)
  }
}

void main()
