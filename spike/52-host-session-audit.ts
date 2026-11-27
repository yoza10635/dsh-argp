/**
 * 真宿主会话存档的 T-D 判据离线读数（2026-11-27）。
 *
 * 目的：把「真活体验收」的判据从人眼盯控制台，变成对**已结束的会话存档**复算——
 * 存档里有逐请求 usage 与压缩事务的完整事件流，`cache-audit` 的判据函数直接复用
 * （同一份代码，不另立口径），于是这几条可以离线判：
 *
 *  #3 剪枝账：事务括号配对、区间/项数、字符前后、有无 error/告警；
 *  #5 provider 是否真报 cached tokens（不报 ⇒ #4 记「不可测」而不是通过）；
 *  #4 压缩后首请求判据 + 续作是否仍失配（`isLowCacheHit`，重灌次数 / 失配次数）；
 *  #6 手动压缩的摘要调用 usage（`compaction/summary` 事件里的 usage）命中是否 ≥90%。
 *
 * #1（boot 探针日志）与 #2（`/argp` 世界行）是宿主进程侧输出，不落存档 ⇒ 本脚本
 * 如实标「存档不可见」，不得脑补。
 *
 * 存档是多帧 zstd（一次 append 一帧），Node 的一次性/流式解压器只解第一帧，
 * 故先按 RFC 8878 切帧再逐帧解压（帧逻辑与 spike/09 同源）。
 *
 * 用法：node --import ./scripts/ts-import-rewrite-loader.mjs spike/52-host-session-audit.ts <session 目录或 .zstd 文件>
 */
import fs from 'node:fs'
import path from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import {
  buildRequestCacheSample, classifyCacheSample, isLowCacheHit,
  REFILL_MAX_HIT_RATIO, REFILL_MIN_PROMPT_TOKENS,
} from '../src/cache-audit.ts'

const ZSTD_MAGIC = 0xfd2fb528
const SKIPPABLE_MIN = 0x184d2a50
const SKIPPABLE_MAX = 0x184d2a5f

function take(buf: Buffer, off: number, n: number): number {
  if (off + n > buf.length) throw new RangeError('frame body truncated')
  return off + n
}

function skipZstdFrame(buf: Buffer, off: number): number {
  off += 4
  off = take(buf, off, 1)
  const d = buf[off - 1]
  const fcsFlag = (d >> 6) & 0x3
  const single = (d >> 5) & 0x1
  const checksum = (d >> 2) & 0x1
  const dictFlag = d & 0x3
  if (!single) off = take(buf, off, 1)
  if (dictFlag === 1) off = take(buf, off, 1)
  else if (dictFlag === 2) off = take(buf, off, 2)
  else if (dictFlag === 3) off = take(buf, off, 4)
  if (fcsFlag === 0) { if (single) off = take(buf, off, 1) }
  else if (fcsFlag === 1) off = take(buf, off, 2)
  else if (fcsFlag === 2) off = take(buf, off, 4)
  else off = take(buf, off, 8)
  for (;;) {
    off = take(buf, off, 3)
    const h = buf[off - 3] | (buf[off - 2] << 8) | (buf[off - 1] << 16)
    const last = h & 1
    const type = (h >> 1) & 0x3
    const size = h >>> 3
    if (type === 3) throw new RangeError('reserved zstd block type')
    off = take(buf, off, type === 1 ? 1 : size)
    if (last === 1) break
  }
  if (checksum) off = take(buf, off, 4)
  return off
}

function decodeArchive(file: string): unknown[] {
  const buf = fs.readFileSync(file)
  const parts: Buffer[] = []
  let off = 0
  while (off < buf.length) {
    const magic = buf.readUInt32LE(off)
    if (magic >= SKIPPABLE_MIN && magic <= SKIPPABLE_MAX) {
      off = off + 8 + buf.readUInt32LE(off + 4)
      continue
    }
    if (magic !== ZSTD_MAGIC) throw new Error('偏移 ' + off + ' 处不是 zstd 魔数')
    const end = skipZstdFrame(buf, off)
    parts.push(zstdDecompressSync(buf.subarray(off, end)))
    off = end
  }
  const text = Buffer.concat(parts).toString('utf8')
  const rows: unknown[] = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (t === '') continue
    try { rows.push(JSON.parse(t)) } catch { /* 头部行与非 JSON 行由下面按形态分流 */ }
  }
  return rows
}

interface Row { seq?: number; type?: string; data?: Record<string, unknown> }

const target = process.argv[2]
if (!target) { console.error('usage: spike/52-host-session-audit.ts <session 目录 | .zstd 文件>'); process.exit(1) }
const file = fs.statSync(target).isDirectory() ? path.join(target, 'session.v4.jsonl.zstd') : target
const rows = decodeArchive(file) as Array<Row & { header?: unknown }>

const events = rows.filter(r => typeof r.type === 'string') as Required<Row>[]
const hist = new Map<string, number>()
for (const e of events) hist.set(e.type, (hist.get(e.type) ?? 0) + 1)

console.log('存档 ' + path.basename(file) + '  事件 ' + events.length + '  行 ' + rows.length)
console.log('事件直方图：')
for (const [t, n] of [...hist.entries()].sort((a, b) => b[1] - a[1])) console.log('  ' + t + ' × ' + n)

// ── #3 剪枝账：事务括号与内容 ──
const compaction = events.filter(e => (e.type as string).startsWith('compaction/'))
const starts = compaction.filter(e => e.type === 'compaction/start')
const ends = compaction.filter(e => e.type === 'compaction/end')
console.log('')
console.log('#3 压缩事务：start=' + starts.length + ' end=' + ends.length
  + ' 括号配对=' + (starts.length === ends.length ? 'OK' : '不配对'))
for (const e of compaction) {
  const d = e.data ?? {}
  const keys = Object.keys(d)
  const brief = keys.filter(k => ['compactionId', 'sourceCommandId', 'source', 'error', 'forced', 'shadowedSeqs',
    'shadowedRange', 'messageSeqs', 'usage', 'provider', 'model', 'trigger', 'reason'].includes(k))
    .map(k => {
      const v = d[k]
      if (Array.isArray(v)) return k + '[]=' + v.length
      if (k === 'usage') return 'usage=' + JSON.stringify(v)
      return k + '=' + JSON.stringify(v)
    })
    .join(' ')
  console.log('  seq ' + e.seq + ' ' + e.type + (brief === '' ? ' (data keys: ' + keys.join(',') + ')' : ' ' + brief))
}

// ── 逐请求 usage（#5 / #4 / #6 的取数面）──
interface UsageRow { seq: number; turn: unknown; step: unknown; at: number; input: number; cacheRead: number; cacheWrite: number }
const usages: UsageRow[] = []
for (const e of events) {
  if (e.type !== 'assistant/message') continue
  const d = (e.data ?? {}) as Record<string, unknown>
  const u = d.usage as Record<string, unknown> | undefined
  if (u === undefined || typeof u.inputTokens !== 'number') continue
  usages.push({
    seq: e.seq as number, turn: d.turn, step: d.step,
    at: Date.parse(String(d.timestamp ?? (e as { at?: unknown }).at ?? '')) || 0,
    input: u.inputTokens,
    cacheRead: typeof u.cacheReadTokens === 'number' ? u.cacheReadTokens : 0,
    cacheWrite: typeof u.cacheWriteTokens === 'number' ? u.cacheWriteTokens : 0,
  })
}
// 压缩事务的归属：按 end 事件 seq 之后归属该事务（与引擎口径一致：事务后、下次事务前）
const endSeqs = ends.map(e => e.seq as number).sort((a, b) => a - b)
const endAts = ends.map(e => Date.parse(String((e.data ?? {}).timestamp ?? '')) || 0)
console.log('')
console.log('#5 provider 是否报 cached tokens：' + usages.length + ' 发有 usage，其中 cached>0 的 '
  + usages.filter(u => u.cacheRead > 0).length + ' 发 ⇒ '
  + (usages.some(u => u.cacheRead > 0) ? '可判' : '不可判（该 provider 不报 cached，#4 记不可测）'))
const samples = usages.map((u, i) => {
  // 归属：本请求之前最后一个事务 end 的 seq；首请求 = 该事务后**第一条** usage。
  const owner = endSeqs.reduce((acc, s, k) => (s < (u.seq as number) ? k : acc), -1)
  const firstAfter = owner >= 0 && usages.findIndex(x => endSeqs[owner] < (x.seq as number)) === i
  return buildRequestCacheSample({
    at: u.at > 0 ? u.at : i,
    turn: typeof u.turn === 'number' ? u.turn : null,
    step: typeof u.step === 'number' ? u.step : null,
    inputTokens: u.input,
    cacheReadTokens: u.cacheRead,
    cacheWriteTokens: u.cacheWrite,
    compaction: owner >= 0
      ? { id: String((ends[owner].data ?? {}).compactionId ?? owner), at: endAts[owner] > 0 ? endAts[owner] : endSeqs[owner] }
      : null,
    firstAfterCompaction: firstAfter,
  })
})
console.log('')
console.log('逐请求 usage（cache-audit 同口径）：')
for (const s of samples) {
  console.log('  轮 ' + (s.turn ?? '?') + ' 步 ' + (s.step ?? '?')
    + ' · prompt ' + s.promptTokens + ' / cached ' + s.cachedTokens
    + '（' + Math.round(s.hitRatio * 100) + '%）'
    + ' ' + classifyCacheSample(s)
    + (s.firstAfterCompaction ? ' FIRST' : '')
    + (s.compactionId === null ? '' : ' tx=' + s.compactionId.slice(0, 12)))
}

// ── #4 重灌 / 失配计数（与 /argp 缓存段汇总同式）──
const refills = samples.filter(s => classifyCacheSample(s) === 'post-compaction-refill').length
const repeats = samples.filter(s => classifyCacheSample(s) === 'unexpected-refill' && isLowCacheHit(s)).length
const repeatsRaw = samples.filter(s => classifyCacheSample(s) === 'unexpected-refill').length
console.log('')
console.log('#4 压缩后：保留段重灌 ' + refills + ' 次 · 续作仍失配 ' + repeats + ' 次'
  + '（未过 ' + REFILL_MIN_PROMPT_TOKENS + ' tok 块粒度门槛的低命中另有 ' + (repeatsRaw - repeats) + ' 次，不计）')
console.log('   通过线 重灌=1、失配=0；低命中线 命中<' + Math.round(REFILL_MAX_HIT_RATIO * 100) + '%')

// ── #6 摘要调用 usage（手动压缩的那一发）──
const summaryEvents = compaction.filter(e => e.type === 'compaction/summary')
console.log('')
console.log('#6 摘要调用 usage（compaction/summary 事件）：')
if (summaryEvents.length === 0) {
  console.log('  存档内无 compaction/summary 事件（或该事件不落 usage）⇒ 需宿主日志的 [host-form] 行')
}
for (const e of summaryEvents) {
  const d = (e.data ?? {}) as Record<string, unknown>
  const u = (d.usage ?? (d.message as Record<string, unknown> | undefined)?.usage) as Record<string, unknown> | undefined
  if (u === undefined) {
    // model 词典（prune-tx.ts:377-378）：factor-prose 事务带 llm-prose-checkpoint；
    // 'deterministic-guards' ⇒ R 贴标/归并等零 LLM 事务，摘要未调模型 ⇒ #6 不适用。
    const model = String(d.model ?? '')
    console.log('  seq ' + e.seq + ' summary 事件无 usage 字段（model=' + model + '）⇒'
      + (model === 'llm-prose-checkpoint'
        ? ' 走了 LLM 但 usage 未回填，需宿主日志 [argp-factor-prose] 行定性'
        : ' 零 LLM 事务（R 贴标/归并面），本条不适用'))
    continue
  }
  const cacheRead = typeof u.cacheReadTokens === 'number' ? u.cacheReadTokens : 0
  const prompt = (typeof u.inputTokens === 'number' ? u.inputTokens : 0) + cacheRead
  console.log('  seq ' + e.seq + ' prompt=' + prompt + ' cached=' + cacheRead
    + '（' + (prompt > 0 ? Math.round((cacheRead / prompt) * 100) : 0) + '%）'
    + (prompt > 0 && cacheRead / prompt >= 0.9 ? ' ⇒ ≥90% 通过线达标' : ' ⇒ 未达 90%（需与宿主日志 [host-form] 标记对照定性）'))
}

console.log('')
console.log('#1 boot 探针 / #2 /argp 世界行 / #3 手动 vs 自动（若 sourceCommandId 未落档）：存档不可见，需现场输出')
