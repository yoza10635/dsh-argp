/**
 * spike 38 — info 压缩契约服从率实测（本地 Qwen3.6-35B-A3B @ :8080，免费）
 *
 * 背景（2026-08-27）：commit e9194ee 补实现设计 §10 决策 1——splits 扩 infoLevel/infoText，
 * 模型须在拆分调用里顺带产出资料压缩（false/summary/extract + infoText）。本 spike 用
 * 真实 compressCurrentTurn 全链路（收集→LLM→normalizeDecision→planReplacements→flush）
 * 验证三类内容的档位服从与保真：
 *
 *   S1 prose   外部 AI 评审/方案（叙述文体）→ 期望 summary（内容类型引导）
 *   S2 shell   shell 报错（错误码/路径:行号/key=value）→ 期望 extract 且 guard 全过（逐字）
 *   S3 short   短小资料 → 期望 false（或极短 summary）
 *
 * 判定：
 *   VA-parse   三场景 decision 均可解析（normalizeDecision 非 null）
 *   VB-level   S1→summary、S2→extract、S3→false（或极短 summary），档位引导生效
 *   VC-guard   S2 extract 被 fidelityGuard 放行（verbatim 保留高信号 token）
 *   VD-surface 各场景 U-info 节点落盘 = 模型压缩文本（非逐字回退）；S1/S2 压缩比 > 0
 *
 * 用法：
 *   node --import ./scripts/ts-import-rewrite-loader.mjs spike/38-info-obedience.ts
 * 产物：spike/out/38-info-obedience-<ts>.json
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ARG_NS } from '../src/peratom/types.ts'
import { PeratomCompressor } from '../src/peratom/compressor.ts'
import type { CompressRecord } from '../src/peratom/compressor.ts'

const BASE = process.env['QWEN_BASE'] ?? 'http://127.0.0.1:8080/v1'
const MODEL = process.env['QWEN_MODEL'] ?? 'Qwen3.6-35B-A3B'
const ENDPOINT = BASE.replace(/\/$/, '') + '/chat/completions'
const TIMEOUT_MS = 240_000

interface Scenario {
  name: string
  expectLevel: 'summary' | 'extract' | 'false' | 'any'
  text: string
}

const S1_PROSE = '根据这个评审意见重构一下服务：\n'
  + '评审人认为当前 PaymentService.deduct 的幂等策略过度依赖数据库唯一索引，'
  + '建议改用 version 字段乐观锁（version=0 起步，每次更新 +1）。'
  + '同时指出 retry 上限 3 次过于激进，建议退避 100ms/400ms/1600ms 指数退避，'
  + '并对 429 响应做特殊处理而不是一律重试。'
  + '另外要求把超时配置从 config.json 的 timeout_ms=5000 抽到环境变量，'
  + '并补充单元测试覆盖并发扣款场景。'
  + '整体方向认可，但希望在下个迭代里把重试风暴的观测指标（retry_total）接入监控大盘。'

const S2_SHELL = '帮我看下这个部署报错：\n'
  + 'Error: listen EADDRINUSE :::8080\n'
  + '    at Server.setupListen (node:net:1917:16)\n'
  + '    at processTicksAndRejections (node:internal/process/task_queues:95:5)\n'
  + '    at Object.<anonymous> (/opt/app/dist/server.js:42:11)\n'
  + '    at Module._compile (node:internal/modules/cjs/loader:1256:14)\n'
  + 'exit code=1 pid=8821'

const S3_SHORT = '看下这个配置：\n'
  + 'server.port=8080\n'
  + 'server.host=0.0.0.0\n'
  + 'db.pool_size=20\n'
  + 'cache.ttl_seconds=3600\n'
  + 'feature.rate_limit.enabled=true'

const SCENARIOS: Scenario[] = [
  { name: 'S1-prose', expectLevel: 'summary', text: S1_PROSE },
  { name: 'S2-shell', expectLevel: 'extract', text: S2_SHELL },
  // S3：短配置 key=value 无冗余可摘，false 与 extract（逐字）均可接受——期望 any
  { name: 'S3-config', expectLevel: 'any', text: S3_SHORT },
]

interface Result {
  scenario: string
  expectLevel: string
  called: boolean
  parseFailed?: boolean
  skipReason?: string
  error?: string
  decision?: { splits: Array<{ seq: number; quotes: string[]; infoLevel?: string; infoText?: string }>; tools: unknown[] }
  /** planReplacements 统计（从 record 读）。 */
  appliedReplaces?: number
  skippedFidelity?: number
  summaryDropped?: string[]
  /** U-info 节点落盘信息（从 session 反查）。 */
  surfaceText?: string
  surfaceIsCompressed?: boolean
  /** verbatim info 长度（用于压缩比估算；近似 = 模型 infoText 长度 vs 原 info 长度）。 */
  origLen: number
  infoTextLen?: number
  guardOk?: boolean
}

const failures: string[] = []
const verdict = (name: string, ok: boolean, detail: string): void => {
  console.log((ok ? '[PASS ' : '[FAIL ') + name + '] ' + detail)
  if (!ok) failures.push(name + ': ' + detail)
}

function appendUser(session: Session, text: string): number {
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  return session.events.length - 1
}

async function runScenario(ctx: Context, s: Scenario, out: Result): Promise<void> {
  const compressor = new PeratomCompressor(ctx, {
    endpoint: ENDPOINT,
    apiKey: 'dummy-local',
    model: MODEL,
    timeoutMs: TIMEOUT_MS,
    // spike 33 Phase A 实证：llama.cpp 上 json_schema 与思考模式互斥（不关思考 content 为空）
    chatTemplateKwargs: { enable_thinking: false },
  })
  const session = Session.create(SessionId('spike38-' + s.name))
  session.append('turn/start', { turn: 1 })
  const uSeq = appendUser(session, s.text)
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

  const record: CompressRecord | null = await compressor.compressCurrentTurn(session)
  out.called = record?.called ?? false
  out.parseFailed = record?.parseFailed
  out.skipReason = record?.skipReason
  out.error = record?.error
  out.appliedReplaces = record?.appliedReplaces
  out.skippedFidelity = record?.skippedFidelity
  out.summaryDropped = record?.summaryDropped
  out.origLen = s.text.length

  const dec = record?.decision as { splits?: Array<{ seq: number; quotes: string[]; infoLevel?: string; infoText?: string }> } | undefined
  out.decision = dec as Result['decision']
  const split = dec?.splits?.find(x => x.seq === uSeq)
  out.infoTextLen = split?.infoText?.length
  if (split?.infoLevel !== undefined) out.guardOk = undefined // 由 surface 反查判

  // 反查 U-info 节点（ARG_NS.info=true 的 append）
  const events = session.events
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i]
    if (e?.type !== 'user/message') continue
    const data = e.data as Record<string, unknown> | undefined
    const meta = data?.[ARG_NS] as { info?: boolean } | undefined
    if (meta?.info === true) {
      const content = (data?.content as Array<{ type?: string; text?: string }> | undefined) ?? []
      const text = content.map(b => (b.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('\n')
      out.surfaceText = text
      // 压缩比近似：surface 文本 vs 整条 user 原文（保守下界）
      out.surfaceIsCompressed = text.length < s.text.length
      break
    }
  }
}

async function main(): Promise<void> {
  console.log(`[info-obedience] base=${BASE} model=${MODEL}`)
  const ctx = new Context()
  const results: Result[] = []
  try {
    for (const s of SCENARIOS) {
      console.log(`\n=== ${s.name} (expect ${s.expectLevel}) ===`)
      const r: Result = { scenario: s.name, expectLevel: s.expectLevel, origLen: s.text.length }
      await runScenario(ctx, s, r)
      results.push(r)
      console.log('  record:', JSON.stringify(r, null, 2).split('\n').map(l => '  ' + l).join('\n'))
      // 原始响应太长，仅记录是否留痕
    }

    // 判定
    for (const r of results) {
      const parsed = r.called === true && r.parseFailed !== true && r.decision !== undefined
      verdict('VA-parse-' + r.scenario, parsed, parsed ? 'decision 解析成功' : `parseFailed=${r.parseFailed} skip=${r.skipReason} err=${r.error}`)
      const level = r.decision?.splits?.[0]?.infoLevel
      const expectAny = r.expectLevel === 'any'
      verdict('VB-level-' + r.scenario, expectAny || level === r.expectLevel,
        `模型档位=${level ?? '<缺省>'} 期望=${r.expectLevel}`)
      if (r.scenario === 'S2-shell') {
        const guardOk = (r.skippedFidelity ?? 0) === 0 && (r.summaryDropped?.length ?? 0) === 0
        verdict('VC-guard-S2', guardOk,
          `extract 保真守卫：skippedFidelity=${r.skippedFidelity} summaryDropped=${r.summaryDropped?.length ?? 0}`)
      }
      const compressed = r.surfaceIsCompressed === true
      verdict('VD-surface-' + r.scenario, compressed,
        `U-info surface ${r.surfaceText === undefined ? '<无>' : r.surfaceText.slice(0, 60) + '…'}（len=${r.surfaceText?.length ?? '?'} vs 原 ${r.origLen}）`)
    }
  } finally {
    await ctx.fiber.dispose()
  }

  const outDir = path.join(import.meta.dirname ?? '.', 'out')
  fs.mkdirSync(outDir, { recursive: true })
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const outFile = path.join(outDir, `38-info-obedience-${ts}.json`)
  fs.writeFileSync(outFile, JSON.stringify({ base: BASE, model: MODEL, results, failures }, null, 2))
  console.log(`\n产物：${outFile}`)
  console.log(failures.length === 0 ? 'ALL PASS' : `FAILURES: ${failures.join('; ')}`)
  process.exit(failures.length === 0 ? 0 : 1)
}

void main()
