/**
 * spike 33 — P1 验收前置：PeratomCompressor 本地真模型实测（llama.cpp OpenAI 兼容端点）
 *
 * 背景（2026-08-25）：P1 代码层完成（gate/compressor + 119 单测），但全部 LLM 交互是
 * fetch 替身。本 spike 用本地 Qwen（QWEN_BASE，默认 :8080）补三类真实证据：
 *   Phase A  端点能力探测：response_format=json_schema 是否被接受；enable_thinking 关闭
 *            对 <think> 污染与 JSON 可解析率的影响（3 变体 × 2 样本）
 *   Phase B  引擎端到端（真 fetch 替换替身）：
 *     B1     compressCurrentTurn 全链路：收集→单次调用→resolveSplit→事务括号→断言组
 *     B2     后续轮行为：纯对话轮零调用 / 压缩副本与原文同键 → 版本链硬排除零调用
 *     B3     两段式时序：prepareCurrentTurn 只暂存不落盘 → 下一轮 turn/start 后 flushStashed 落盘
 *
 * 判决项：
 *   VA-schema    llama.cpp 接受 response_format json_schema（HTTP 200）
 *   VA-parse     至少一个变体 2/2 样本可解析出合法 decision
 *   VB-e2e       B1 事务落地：compaction start..end 配对无 error 且 appliedReplaces ≥1
 *   VB-dual      split 场景双事件：dialog 原位 replace + U-info append（info/sourceSeq/summary）
 *   VB-contentonly  tool 副本与原文仅内层 content 不同（dsh-session 硬约束实证）
 *   VB-norec     纯对话轮与版本链轮均零调用（calls 不增长）
 *   VB-twophase  两段式：暂存阶段零事件追加，flush 后事务完整落地
 *
 * 用法：
 *   node --import ./scripts/ts-import-rewrite-loader.mjs spike/33-peratom-live.ts
 *   QWEN_MODEL=Qwen3.6-35B-A3B ...（默认即此值；服务未起则 Phase A/B 全 FAIL 并给出探针输出）
 * 产物：spike/out/33-peratom-live-<时间戳>.json
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Session as SessionT } from '@deepseek-ai/dsh-session'
import { ARG_NS } from '../src/peratom/types.ts'
import { PeratomCompressor } from '../src/peratom/compressor.ts'
import type { CompressRecord } from '../src/peratom/compressor.ts'

const BASE = process.env['QWEN_BASE'] ?? 'http://127.0.0.1:8080/v1'
const MODEL = process.env['QWEN_MODEL'] ?? 'Qwen3.6-35B-A3B'
const ENDPOINT = BASE.replace(/\/$/, '') + '/chat/completions'
const TIMEOUT_MS = 240_000

const failures: string[] = []
const verdict = (name: string, ok: boolean, detail: string): void => {
  console.log((ok ? '[PASS ' : '[FAIL ') + name + '] ' + detail)
  if (!ok) failures.push(name + ': ' + detail)
}

const watchdog = setTimeout(() => {
  console.log('[FATAL] spike 33 watchdog timeout (20 min)')
  process.exit(2)
}, 20 * 60 * 1000)

// ---------------------------------------------------------------------------
// 语料：多区间交错长 user + 大 tool result（与 compressor 单测同构）
// ---------------------------------------------------------------------------

const DIALOG_QUOTE_A = '根据第二段的超时报错修一下重试逻辑，'
const USER_TEXT = '看一下这些信息：\n'
  + '[svc-a] 2026-08-24T10:15:01 WARN upstream timeout after 5000ms host=pay-gw\n'
  + '[svc-a] 2026-08-24T10:15:04 retry 1/3 failed code=ETIMEDOUT\n'
  + DIALOG_QUOTE_A + '\n'
  + '注意别动数据库连接池的配置。\n'
  + '[db] 2026-08-24T10:15:09 ERROR deadlock detected on table orders\n'
  + '[db] 2026-08-24T10:15:09 SQLSTATE=40001 victim=txn#8821\n'
const TOOL_LINE = 'at Socket.socketOnEnd (node:_http_client:512:26) code=ECONNRESET req_id=r-'.padEnd(60, '.') + '\n'
const TOOL_TEXT = TOOL_LINE.repeat(14) // ≈840 字符 ≥512

function buildTurn(session: SessionT, turn: number, opts: { user?: string | null; callId: string; toolText?: string | null }): void {
  session.append('turn/start', { turn })
  const user = opts.user === undefined ? USER_TEXT : opts.user
  if (user !== null && user !== '') {
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: user }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  }
  session.append('assistant/message', {
    turn,
    step: 1,
    message: {
      role: 'assistant',
      id: 'am_t' + turn,
      source: { kind: 'model', provider: 'local', model: MODEL },
      content: [
        { type: 'tool-call', id: opts.callId, name: 'read_file', arguments: '{"path":"log.txt"}' },
        { type: 'text', text: 'on it' },
      ],
    },
  } as never, { surfaceOp: 'append' })
  const toolText = opts.toolText === undefined ? TOOL_TEXT : opts.toolText
  if (toolText !== null) {
    session.append('tool/result', {
      turn,
      step: 1,
      message: {
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: opts.callId, content: [{ type: 'text', text: toolText }], isError: false }],
        source: { kind: 'tool', callId: opts.callId },
        id: 'm_' + opts.callId,
      },
    } as never, { surfaceOp: 'append' })
  }
  session.append('turn/end', { turn, reason: { kind: 'completed' } } as never)
}

// ---------------------------------------------------------------------------
// Phase A：端点能力探测
// ---------------------------------------------------------------------------

const PROBE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['splits', 'tools'],
  properties: {
    splits: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['seq', 'quotes'],
        properties: { seq: { type: 'integer' }, quotes: { type: 'array', items: { type: 'string' } } },
      },
    },
    tools: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['seq', 'level', 'text'],
        properties: { seq: { type: 'integer' }, level: { type: 'string', enum: ['extract', 'summary'] }, text: { type: 'string' } },
      },
    },
  },
} as const

interface ProbeResult {
  variant: string
  status: number | null
  error?: string
  ms: number
  contentPreview: string
  thinkPollution: boolean
  parsed: boolean
  splits: number
  tools: number
}

/** 与 compressor.extractJson 同口径的最小防御性提取（spike 内自足）。 */
function probeExtractJson(raw: string): unknown {
  const cleaned = raw.replace(/<think>[\s\S]*?<\/think>/g, '')
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(cleaned)
  const text = (fenced?.[1] ?? cleaned).trim()
  try { return JSON.parse(text) as unknown } catch { /* fall through */ }
  const last = text.lastIndexOf('}')
  if (last > 0) {
    for (let first = text.lastIndexOf('{', last - 1); first >= 0; first = text.lastIndexOf('{', first - 1)) {
      try { return JSON.parse(text.slice(first, last + 1)) as unknown } catch { /* keep scanning */ }
    }
  }
  return undefined
}

function probeNormalize(cand: unknown): { splits: number; tools: number } | null {
  if (cand === null || typeof cand !== 'object') return null
  const o = cand as { splits?: unknown; tools?: unknown }
  if (!Array.isArray(o.splits) && !Array.isArray(o.tools)) return null
  const countValid = (arr: unknown, need: string[]): number =>
    Array.isArray(arr) ? arr.filter(x => x !== null && typeof x === 'object' && need.every(k => k in (x as object))).length : 0
  return { splits: countValid(o.splits, ['seq', 'quotes']), tools: countValid(o.tools, ['seq', 'level', 'text']) }
}

async function probeOnce(variant: string, useSchema: boolean, disableThinking: boolean): Promise<ProbeResult> {
  const body: Record<string, unknown> = {
    model: MODEL,
    messages: [{
      role: 'user',
      content: '你是会话压缩器。把用户消息拆为指令(dialog)片段与资料余量：quotes 数组逐字抄写每段连续指令原文（必须与原文完全一致）；'
        + '工具结果给 extract 摘要。只输出 JSON 对象 {"splits":[{"seq":1,"quotes":["…"]}],"tools":[]}。\n\n'
        + '<ATOM seq=1 kind="user-long">\n' + USER_TEXT + '\n</ATOM>\n\n'
        + '<ATOM seq=2 kind="tool-result">\n' + TOOL_TEXT.slice(0, 200) + '\n…</ATOM>',
    }],
    max_tokens: 600,
    temperature: 0,
  }
  if (useSchema) {
    body['response_format'] = { type: 'json_schema', json_schema: { name: 'argp_probe', strict: true, schema: PROBE_SCHEMA } }
  }
  if (disableThinking) body['chat_template_kwargs'] = { enable_thinking: false }
  const t0 = Date.now()
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer dummy-local' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      body: JSON.stringify(body),
    })
    const ms = Date.now() - t0
    if (!res.ok) {
      const text = await res.text()
      return { variant, status: res.status, error: text.slice(0, 200), ms, contentPreview: '', thinkPollution: false, parsed: false, splits: 0, tools: 0 }
    }
    const json = await res.json() as { choices?: { message?: { content?: string } }[] }
    const content = json.choices?.[0]?.message?.content ?? ''
    const norm = probeNormalize(probeExtractJson(content))
    return {
      variant,
      status: res.status,
      ms,
      contentPreview: content.slice(0, 160).replace(/\n/g, '\\n'),
      thinkPollution: /<think>/.test(content),
      parsed: norm !== null,
      splits: norm?.splits ?? 0,
      tools: norm?.tools ?? 0,
    }
  } catch (error) {
    return { variant, status: null, error: error instanceof Error ? error.message : String(error), ms: Date.now() - t0, contentPreview: '', thinkPollution: false, parsed: false, splits: 0, tools: 0 }
  }
}

async function phaseA(): Promise<void> {
  console.log(`\n=== Phase A 端点能力探测 @ ${MODEL} (${ENDPOINT}) ===`)
  const variants: Array<{ name: string; schema: boolean; noThink: boolean }> = [
    { name: 'schema-only', schema: true, noThink: false },
    { name: 'schema+nothink', schema: true, noThink: true },
    { name: 'bare+nothink', schema: false, noThink: true },
  ]
  const results: ProbeResult[] = []
  for (const v of variants) {
    for (let i = 0; i < 2; i += 1) {
      const r = await probeOnce(v.name, v.schema, v.noThink)
      results.push(r)
      console.log(`[${v.name}#${i + 1}] status=${r.status ?? 'ERR'} ${r.ms}ms parsed=${r.parsed}`
        + ` splits=${r.splits} tools=${r.tools}${r.thinkPollution ? ' [THINK]' : ''}`
        + (r.error !== undefined ? ` error=${r.error}` : ''))
      if (i === 0 && r.error === undefined) console.log(`           preview: ${r.contentPreview}`)
    }
  }
  const okSchema = results.some(r => r.variant.startsWith('schema') && r.status === 200)
  verdict('VA-schema', okSchema, okSchema ? 'llama.cpp 接受 response_format json_schema' : 'json_schema 被拒（compressor 将走降级路径，功能不损但失去强制解码）')
  const perfect = variants.find(v => results.filter(r => r.variant === v.name).every(r => r.parsed))
  verdict('VA-parse', perfect !== undefined, perfect !== undefined ? `变体 ${perfect.name} 2/2 样本可解析` : '无变体达到 2/2 解析率（需人工看 preview）')
  const thinkFree = results.filter(r => r.variant.includes('nothink')).every(r => !r.thinkPollution)
  console.log('[info] nothink 变体 <think> 污染: ' + (thinkFree ? '无' : '存在（extractJson 已兜底剥离）'))
}

// ---------------------------------------------------------------------------
// Phase B：引擎端到端（真 fetch）
// ---------------------------------------------------------------------------

interface BContext {
  ctx: Context
  compressor: PeratomCompressor
}

async function makeEngine(): Promise<BContext> {
  const ctx = new Context()
  const compressor = new PeratomCompressor(ctx, {
    endpoint: ENDPOINT,
    apiKey: 'dummy-local',
    model: MODEL,
    timeoutMs: TIMEOUT_MS,
    // spike 33 Phase A 实证：llama.cpp 上 json_schema 与思考模式互斥（不关思考 content 为空）
    chatTemplateKwargs: { enable_thinking: false },
  })
  return { ctx, compressor }
}

function kindsOf(session: SessionT): string[] {
  return session.events.map(e => e.type)
}

async function phaseB(): Promise<void> {
  console.log('\n=== Phase B 引擎端到端 ===')
  const { ctx, compressor } = await makeEngine()
  const session = Session.create(SessionId('spike33-live'))

  // --- B1：全链路 ---
  buildTurn(session, 1, { callId: 'c1' })
  const uSeq = 1
  const rSeq = 3
  const record: CompressRecord | null = await compressor.compressCurrentTurn(session)

  console.log('[B1] record=' + JSON.stringify(record))
  console.log('[B1] calls=' + compressor.calls + ' events=' + kindsOf(session).join(','))

  const kinds = kindsOf(session)
  const endIdx = kinds.lastIndexOf('compaction/end')
  const startIdx = kinds.lastIndexOf('compaction/start')
  const txLanded = startIdx > 0 && endIdx === kinds.length - 1
    && (session.events[endIdx]?.data as { error?: string }).error === undefined
  verdict('VB-e2e', txLanded && (record?.appliedReplaces ?? 0) >= 1,
    txLanded ? `事务落地 appliedReplaces=${record?.appliedReplaces} calls=${compressor.calls} ms=${record?.ms}` : '事务未干净收尾')

  if (txLanded) {
    const dialogEvent = session.events[endIdx - 3]
    const infoEvent = session.events[endIdx - 2]
    const toolEvent = session.events[endIdx - 1]
    const dData = dialogEvent?.data as unknown as { content?: { text?: string }[]; [k: string]: unknown }
    const iData = infoEvent?.data as unknown as { [k: string]: unknown }
    const tData = toolEvent?.data as unknown as { message?: { content?: { content?: { text?: string }[] }[] }; [k: string]: unknown }

    const hasSplit = dialogEvent?.type === 'user/message' && dData[ARG_NS] === undefined
      && typeof dData.content?.[0]?.text === 'string'
      && infoEvent?.type === 'user/message'
      && (iData[ARG_NS] as { info?: boolean; sourceSeq?: number; summary?: string } | undefined)?.info === true
      && (iData[ARG_NS] as { sourceSeq: number }).sourceSeq === uSeq
    verdict('VB-dual', hasSplit || (record?.skippedFallbackDialog ?? 0) > 0,
      hasSplit
        ? `dialog="${String(dData.content?.[0]?.text).slice(0, 40)}…" U-info.summary="${String((iData[ARG_NS] as { summary?: string }).summary).slice(0, 40)}…"`
        : `模型走了回退路径 skippedFallbackDialog=${record?.skippedFallbackDialog}（保真不变式生效，非缺陷）`)

    // VB-contentonly：副本与原文除内层 content 外逐键一致（含无新增顶层键）
    let contentOnly = toolEvent?.type === 'tool/result' && !(ARG_NS in (tData as object))
    if (contentOnly) {
      const orig = session.events[rSeq]?.data as { [k: string]: unknown }
      const copy = tData as { [k: string]: unknown }
      const keysMatch = Object.keys(orig).length === Object.keys(copy).length
        && Object.keys(orig).every(k => k in copy)
      const origMsg = orig['message'] as { content: [{ content: unknown }] }
      const copyMsg = copy['message'] as { content: [{ content: unknown }] }
      const strip = (m: { content: [{ content: unknown }] }): unknown =>
        ({ ...m, content: m.content.map(b => ({ ...b, content: null })) })
      contentOnly = keysMatch && JSON.stringify(strip(origMsg)) === JSON.stringify(strip(copyMsg))
        && (copyMsg.content[0].content as { text?: string }[])?.[0]?.text !== undefined
    }
    verdict('VB-contentonly', contentOnly, contentOnly ? 'tool 副本仅内层 content 变化（无 ARG_NS 键）' : 'tool 副本形状偏离（会被宿主校验拒绝的形状）')

    console.log('[B1] dialog 文本: ' + JSON.stringify(dData.content?.[0]?.text))
    console.log('[B1] U-info summary 前 120 字: ' + JSON.stringify(String((iData[ARG_NS] as { summary?: string }).summary ?? '').slice(0, 120)))
    console.log('[B1] tool extract 前 120 字: ' + JSON.stringify(String(tData.message?.content?.[0]?.content?.[0]?.text ?? '').slice(0, 120)))
  }

  const callsAfterB1 = compressor.calls

  // --- B2a：纯对话轮零调用 ---
  buildTurn(session, 2, { user: '收到，谢谢。', callId: 'c2-none', toolText: null })
  const rec2 = await compressor.compressCurrentTurn(session)
  verdict('VB-pure-dialog-zero-call', rec2?.called === false && compressor.calls === callsAfterB1,
    `called=${rec2?.called} calls=${callsAfterB1}->${compressor.calls}`)

  // --- B2b：版本链硬排除（同键 read_file log.txt 第三次出现）---
  buildTurn(session, 3, { user: 'short q', callId: 'c3' })
  const collect3 = compressor.collectCurrentTurn(session)
  const rec3 = await compressor.compressCurrentTurn(session)
  verdict('VB-versionchain-excluded', collect3?.toolResults.length === 0 && rec3?.called === false && compressor.calls === callsAfterB1,
    `collect.toolResults=${collect3?.toolResults.length} called=${rec3?.called} calls=${callsAfterB1}->${compressor.calls}`)

  // --- B3：两段式时序 ---
  const session2 = Session.create(SessionId('spike33-two-phase'))
  buildTurn(session2, 1, { callId: 'p1' })
  const eventsBeforePrepare = session2.events.length
  const prepRec = await compressor.prepareCurrentTurn(session2)
  const stashedOnly = session2.events.length === eventsBeforePrepare
  session2.append('turn/start', { turn: 2 }) // 模拟下一次 agent/pre-step 的 open-turn 窗口
  compressor.flushStashed(session2)
  const kinds2 = kindsOf(session2)
  const flushed = kinds2.includes('compaction/end') && (prepRec?.called === true || (prepRec?.called === false))
  verdict('VB-twophase', stashedOnly && flushed && prepRec !== null,
    `prepare: called=${prepRec?.called} 零落盘=${stashedOnly}; flush 后尾部=${kinds2.slice(-3).join(',')}`)

  await ctx.fiber.dispose()
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`[spike33] base=${BASE} model=${MODEL}`)
  await phaseA()
  await phaseB()

  const outDir = path.join(process.cwd(), 'spike', 'out')
  fs.mkdirSync(outDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const outFile = path.join(outDir, `33-peratom-live-${stamp}.json`)
  fs.writeFileSync(outFile, JSON.stringify({
    meta: { base: BASE, model: MODEL, runAt: new Date().toISOString(), failures },
  }, null, 2))
  console.log(`\n产物：${outFile}`)
  if (failures.length > 0) {
    console.log(`\n=== 结论：${failures.length} 项待处理 ===`)
    for (const f of failures) console.log(' - ' + f)
    process.exitCode = 1
  } else {
    console.log('\n=== 结论：全部判决项 PASS —— P1 真实环境冒烟通过 ===')
  }
  clearTimeout(watchdog)
}

main().catch(err => {
  console.error(err)
  process.exitCode = 1
})
