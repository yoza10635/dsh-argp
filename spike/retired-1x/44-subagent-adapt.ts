/**
 * S44：子代理（sub-agent / delegation）与 ARGP 压缩插件的适配性审计。
 *
 * 用法：
 *   npm run spike44 -- <主 session 目录> [<子 session 目录> ...]
 *
 * 关注三个问题（2026-09-23）：
 *  - Q1 子代理**自身**是否进行了压缩（子 session 里有没有 compaction/* 事件）？
 *  - Q2 子代理的返回消息在主 session 里以什么事件形态存在（是不是 tool/result）？
 *  - Q3 它是否构成**可识别、可压缩**的原子（过 isMaterial + 大小门控 + 版本链）？
 *
 * 隐私：只落聚合量（类型名 / 计数 / 字符数 / seq），不打印任何会话正文。
 */
import fs from 'node:fs'
import path from 'node:path'
import { loadSessionEvents, type RawSessionEvent } from './lib/session-corpus.ts'
import { findLoadBearingTokens } from '../src/token-ontology.ts'

/** 估算 token（与引擎一致的 chars/3.5）。 */
const tok = (n: number): number => Math.max(1, Math.round(n / 3.5))

/**
 * 抽样：打印指定 source 形态消息的**信息密度画像 + 正文样本首部**。
 *
 * 密度指标（判定是否值得逐原子压缩）：
 *  - 承重密度 = 承重 token 数 / 估算 token（结构化硬 token 占比；越高越"全是干货"）
 *  - 行重复率 = 1 − 去重行/总行（冗余度；高说明有大量样板/重复块）
 *  - 空白占比 / 短行占比（≤40ch 的行；高说明松散）
 *
 * ⚠️ 隐私：正文样本只打印前 N 字符到 stdout，**不写任何文件、不进仓库**。
 */
function sample(events: readonly RawSessionEvent[], wantKind: Set<string>, maxChars: number, limit: number): void {
  const hits = events.filter(e => e.type === 'user/message' && wantKind.has(String(((e.data ?? {})['source'] as { kind?: string } | undefined)?.['kind'])))
  console.log(`  SAMPLE source.kind ∈ {${[...wantKind].join(',')}}: ${hits.length} 条`)
  let totalChars = 0
  let accTok = 0
  let accLoad = 0
  for (const e of hits.slice(0, limit)) {
    const t = textOf(e)
    totalChars += t.length
    const lines = t.split('\n')
    const nonBlank = lines.filter(l => l.trim().length > 0)
    const uniq = new Set(nonBlank.map(l => l.trim()))
    const short = nonBlank.filter(l => l.length <= 40).length
    const load = findLoadBearingTokens(t)
    const est = tok(t.length)
    accTok += est
    accLoad += load.length
    console.log(`    seq=${e.seq} ${String(t.length).padStart(6)}ch ≈${String(est).padStart(5)}tok 行=${String(lines.length).padStart(4)}`
      + ` 去重行=${String(uniq.size).padStart(4)} 重复率=${(100 * (1 - (nonBlank.length === 0 ? 1 : uniq.size / nonBlank.length))).toFixed(0)}%`
      + ` 短行=${(100 * (nonBlank.length === 0 ? 0 : short / nonBlank.length)).toFixed(0)}%`
      + ` 承重token=${String(load.length).padStart(3)} 密度=${(100 * load.length / est).toFixed(1)}%`)
    console.log(`    ─── 样本（前 ${maxChars} 字符）───`)
    for (const line of t.slice(0, maxChars).split('\n')) console.log(`    | ${line}`)
    console.log('')
  }
  if (hits.length > limit) console.log(`    …另有 ${hits.length - limit} 条未展示`)
  console.log(`    合计样本 ${totalChars}ch ≈${accTok}tok，承重 token ${accLoad} 个（整体密度 ${(100 * accLoad / Math.max(1, accTok)).toFixed(1)}%）`)
}

// peratom 门控默认值（与 src/peratom/* 一致）
const SPLIT_THRESHOLD_CHARS = 100
const SMALL_RESULT_CHARS = 512

/** 取事件正文（只取长度，不落内容）。data.content 直挂 / data.message.content 两种形态都认。 */
function textOf(ev: RawSessionEvent): string {
  const d = ev.data ?? {}
  const msg = d['message'] as { content?: unknown } | undefined
  const blocks = Array.isArray(msg?.content)
    ? msg!.content as Array<Record<string, unknown>>
    : (Array.isArray(d['content']) ? d['content'] as Array<Record<string, unknown>> : [])
  const parts: string[] = []
  for (const b of blocks) {
    if (typeof b['text'] === 'string') parts.push(b['text'])
    const inner = b['content']
    if (Array.isArray(inner)) {
      for (const c of inner as Array<Record<string, unknown>>) if (typeof c['text'] === 'string') parts.push(c['text'])
    }
  }
  return parts.join('\n')
}

/** peratom collect.isMaterial 判据的等价实现（src/peratom/collect.ts:59）。 */
function isMaterial(ev: RawSessionEvent): boolean {
  if (ev.type !== 'user/message' && ev.type !== 'assistant/message' && ev.type !== 'tool/result') return false
  const surfaceOp = ev.surfaceOp
  if (surfaceOp !== undefined && surfaceOp !== 'append') return false
  if (ev.type !== 'user/message') return true
  // user/message 的 data 在实测存档里是**扁平**的 {content, source, role, id}；
  // 兼容带 message 包装的形态（部分生产者）——两处都读，取到即用。
  const d = ev.data ?? {}
  const flat = d['source'] as { kind?: string } | undefined
  const wrapped = (d['message'] as { source?: { kind?: string } } | undefined)?.source
  const kind = (flat ?? wrapped)?.kind
  return kind !== 'plugin'
}

function report(dir: string): void {
  const file = path.join(dir, 'session.v3.jsonl.zstd')
  const { events, heads, stats } = loadSessionEvents(file)
  const head = heads[0]?.data ?? {}
  console.log('\n' + '='.repeat(78))
  console.log(`[session] ${path.basename(dir)}`)
  console.log(`  头: delegationDepth=${String(head['delegationDepth'] ?? '-')} agentPreset=${String(head['agentPreset'] ?? '-')} cwd=${String(head['cwd'] ?? '-')}`)
  console.log(`  账目: 帧=${stats.frames} 坏帧=${stats.badFrames} 事件=${stats.events} seq=${stats.seqMin}..${stats.seqMax} 缺口=${stats.seqGaps} 重复=${stats.seqDups}`)

  // --- Q1：本 session 自己有没有压缩过 ---
  const compaction = events.filter(e => e.type.startsWith('compaction/'))
  const compByType = new Map<string, number>()
  for (const e of compaction) compByType.set(e.type, (compByType.get(e.type) ?? 0) + 1)
  const placeholders = events.filter(e => textOf(e).includes('[elided'))
  console.log(`  Q1 自身压缩: compaction 事件=${compaction.length} [${[...compByType].map(([k, v]) => `${k}=${v}`).join(' ')}]`)
  console.log(`     → 墓碑/占位副本(surfaceOp!=append)=${events.filter(e => e.surfaceOp !== undefined && e.surfaceOp !== 'append').length}，含 [elided 文本的事件=${placeholders.length}`)
  if (compaction.length > 0) {
    const kinds = [...new Set(compaction.map(e => String((e.data as { provider?: string })?.['provider'] ?? (e.data as { summary?: unknown })?.['summary'] !== undefined ? 'has-summary' : '?')))]
    console.log(`     → compaction 载荷形态: ${kinds.join(', ')}`)
  }

  // --- 事件类型分布 ---
  const byType = new Map<string, number>()
  for (const e of events) byType.set(e.type, (byType.get(e.type) ?? 0) + 1)
  console.log(`  类型分布: ${[...byType].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join('  ')}`)

  // --- Q2/Q3：tool 调用与返回 ---
  const callNames = new Map<string, number>()
  const resultByCall = new Map<string, { n: number; chars: number; max: number; material: number; big: number }>()
  const calls = new Map<string, string>() // callId -> name
  for (const e of events) {
    const msg = e.data?.['message'] as { content?: Array<Record<string, unknown>> } | undefined
    for (const b of Array.isArray(msg?.content) ? msg!.content : []) {
      if (b['type'] === 'tool-call' && typeof b['name'] === 'string') {
        const name = b['name']
        callNames.set(name, (callNames.get(name) ?? 0) + 1)
        if (typeof b['id'] === 'string') calls.set(b['id'], name)
      }
    }
    if (e.type === 'tool/result') {
      const inner = (msg?.content?.[0] as { toolCallId?: string } | undefined)
      const name = (inner && typeof inner['toolCallId'] === 'string' ? calls.get(inner['toolCallId']) : undefined) ?? '<unknown>'
      const t = textOf(e)
      const rec = resultByCall.get(name) ?? { n: 0, chars: 0, max: 0, material: 0, big: 0 }
      rec.n += 1
      rec.chars += t.length
      rec.max = Math.max(rec.max, t.length)
      if (isMaterial(e)) rec.material += 1
      if (t.length > SMALL_RESULT_CHARS) rec.big += 1
      resultByCall.set(name, rec)
    }
  }
  console.log(`  工具调用: ${[...callNames].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join('  ')}`)
  console.log('  Q2/Q3 tool/result 原子性（按调用工具名）:')
  for (const [name, r] of [...resultByCall].sort((a, b) => b[1].chars - a[1].chars)) {
    console.log(`     ${name.padEnd(22)} n=${String(r.n).padStart(3)} 合计=${String(r.chars).padStart(8)}ch 最大=${String(r.max).padStart(7)}ch 过isMaterial=${r.material} >${SMALL_RESULT_CHARS}ch(可压)=${r.big}`)
  }

  // --- source 画像：判定 ARGP isMaterial 能否看见（plugin-source 的 user/message 被排除）---
  const srcKey = (s: unknown): string => {
    if (s === null || typeof s !== 'object') return '<none>'
    const o = s as Record<string, unknown>
    return `kind=${String(o['kind'])}${o['plugin'] !== undefined ? ` plugin=${String(o['plugin'])}` : ''}${o['form'] !== undefined ? ` form=${String(o['form'])}` : ''}`
  }
  const umSrc = new Map<string, { n: number; chars: number; material: number }>()
  for (const e of events.filter(x => x.type === 'user/message')) {
    const k = srcKey((e.data ?? {})['source'])
    const r = umSrc.get(k) ?? { n: 0, chars: 0, material: 0 }
    r.n += 1; r.chars += textOf(e).length; if (isMaterial(e)) r.material += 1
    umSrc.set(k, r)
  }
  console.log('  user/message 的 source 画像（material=0 即 ARGP 判为插件注入、永不入候选）:')
  for (const [k, r] of [...umSrc].sort((a, b) => b[1].chars - a[1].chars)) {
    console.log(`     ${k.padEnd(46)} n=${String(r.n).padStart(3)} ${String(r.chars).padStart(7)}ch material=${r.material}`)
  }
  const spSrc = new Map<string, { n: number; chars: number; max: number }>()
  for (const e of events.filter(x => x.type === 'agent/inbox/spliced')) {
    for (const it of ((e.data ?? {})['inserted'] as Array<Record<string, unknown>> | undefined) ?? []) {
      const k = srcKey(it['source'])
      const body = Array.isArray(it['content']) ? (it['content'] as Array<Record<string, unknown>>).map(c => typeof c['text'] === 'string' ? c['text'] as string : '').join('') : ''
      const r = spSrc.get(k) ?? { n: 0, chars: 0, max: 0 }
      r.n += 1; r.chars += body.length; r.max = Math.max(r.max, body.length)
      spSrc.set(k, r)
    }
  }
  console.log('  agent/inbox/spliced 的 inserted[] source 画像（投递通道）:')
  for (const [k, r] of [...spSrc].sort((a, b) => b[1].chars - a[1].chars)) {
    console.log(`     ${k.padEnd(46)} n=${String(r.n).padStart(3)} ${String(r.chars).padStart(7)}ch 最大=${String(r.max).padStart(5)}ch`)
  }

  // --- Q3 补充：Stage-1 逐原子压缩产出的 tool/result 替换副本（是否带标记 / 是否"裸"）---
  const toolReplaces = events.filter(e => e.type === 'tool/result' && e.surfaceOp !== undefined && e.surfaceOp !== 'append')
  if (toolReplaces.length > 0) {
    console.log(`  Q3 Stage-1 tool/result 替换副本: ${toolReplaces.length} 条`)
    for (const e of toolReplaces) {
      const t = textOf(e)
      const op = (e.surfaceOp as { op?: string })?.['op'] ?? String(e.surfaceOp)
      console.log(`     seq=${String(e.seq).padStart(4)} op=${op} 长度=${String(t.length).padStart(6)}ch 以'['开头=${t.startsWith('[')} 含标记=${t.includes('[已压缩')} 含[elided=${t.includes('[elided')}`)
    }
  } else {
    console.log('  Q3 Stage-1 tool/result 替换副本: 0 条（本 session 未落地逐原子 tool 压缩）')
  }

  // --- Q2 深挖：子代理专属事件形态（ARGP 的原子白名单只有 U/A/R 三种 type）---
  const ATOM_TYPES = new Set(['user/message', 'assistant/message', 'tool/result'])
  const offWhite = new Map<string, { n: number; chars: number; max: number; keys: Set<string> }>()
  for (const e of events) {
    if (ATOM_TYPES.has(e.type)) continue
    const t = textOf(e)
    const rec = offWhite.get(e.type) ?? { n: 0, chars: 0, max: 0, keys: new Set<string>() }
    rec.n += 1
    rec.chars += t.length
    rec.max = Math.max(rec.max, t.length)
    for (const k of Object.keys(e.data ?? {})) rec.keys.add(k)
    offWhite.set(e.type, rec)
  }
  const big = [...offWhite].filter(([, r]) => r.chars > 0).sort((a, b) => b[1].chars - a[1].chars).slice(0, 8)
  if (big.length > 0) {
    console.log('  Q2 白名单外但**携带正文**的事件类型（ARGP isMaterial 一律判 false ⇒ 永不入候选）:')
    for (const [type, r] of big) {
      console.log(`     ${type.padEnd(24)} n=${String(r.n).padStart(3)} 合计=${String(r.chars).padStart(7)}ch 最大=${String(r.max).padStart(6)}ch data键=${[...r.keys].slice(0, 6).join(',')}`)
    }
  }

  // --- user/assistant 原子 ---
  for (const kind of ['user/message', 'assistant/message'] as const) {
    const arr = events.filter(e => e.type === kind && isMaterial(e))
    const chars = arr.reduce((s, e) => s + textOf(e).length, 0)
    const over = arr.filter(e => textOf(e).length > SPLIT_THRESHOLD_CHARS).length
    console.log(`  ${kind}: 材料=${arr.length} 合计=${chars}ch >${SPLIT_THRESHOLD_CHARS}ch(可压)=${over}`)
  }
}

/**
 * 探针：打印指定事件类型的 data 骨架（键 → 类型/长度），**绝不打印正文内容**。
 * 用法追加 `--probe=agent/inbox/spliced[,subagent/catalog]`
 */
function probe(events: readonly RawSessionEvent[], types: Set<string>, limit: number): void {
  for (const type of types) {
    const hits = events.filter(e => e.type === type)
    console.log(`  PROBE ${type}: ${hits.length} 条`)
    for (const e of hits.slice(0, limit)) {
      const shape = Object.entries(e.data ?? {}).map(([k, v]) => {
        const t = v === null ? 'null' : Array.isArray(v) ? `array[${v.length}]` : typeof v
        const len = typeof v === 'string' ? `(${v.length}ch)` : (Array.isArray(v) || (v !== null && typeof v === 'object')) ? `(${JSON.stringify(v).length}ch)` : ''
        return `${k}:${t}${len}`
      })
      console.log(`    seq=${e.seq} surfaceOp=${String(e.surfaceOp)} { ${shape.join('  ')} }`)
      // 压缩摘要是引擎生成的**聚合统计文本**（无人话语料），可直接打印以判引擎身份。
      const sum = (e.data ?? {})['summary']
      if (Array.isArray(sum)) {
        for (const s of sum) {
          const txt = (s as { text?: unknown })?.['text']
          if (typeof txt === 'string') console.log(`      summary: ${txt.slice(0, 240)}`)
        }
      }
      const prov = (e.data ?? {})['provider']
      if (typeof prov === 'string') console.log(`      provider: ${prov}`)
      // 数组字段展开第一层元素骨架（判 splice 载荷形态用；仍不打印正文）。
      for (const [k, v] of Object.entries(e.data ?? {})) {
        if (!Array.isArray(v) || v.length === 0) continue
        const el = v[0]
        if (el === null || typeof el !== 'object') { console.log(`      ${k}[0] = ${typeof el}`); continue }
        const inner = Object.entries(el as Record<string, unknown>).map(([ik, iv]) => {
          const it = iv === null ? 'null' : Array.isArray(iv) ? `array[${iv.length}]` : typeof iv
          const il = typeof iv === 'string' ? `(${iv.length}ch)` : (iv !== null && typeof iv === 'object') ? `(${JSON.stringify(iv).length}ch)` : ''
          return `${ik}:${it}${il}`
        })
        console.log(`      ${k}[0] { ${inner.join('  ')} }`)
        const src = (el as Record<string, unknown>)['source']
        if (src !== null && typeof src === 'object') {
          const ss = Object.entries(src as Record<string, unknown>).map(([sk, sv]) => {
            const st = sv === null ? 'null' : typeof sv
            const sl = typeof sv === 'string' ? `=${sv.length > 42 ? sv.slice(0, 42) + '…' : sv}` : ''
            return `${sk}:${st}${sl}`
          })
          console.log(`        source { ${ss.join('  ')} }`)
        }
      }
    }
  }
}

const dirs = process.argv.slice(2)
if (dirs.length === 0) {
  console.error('用法: npm run spike44 -- <session 目录> ...')
  process.exit(1)
}
const probeArg = dirs.find(a => a.startsWith('--probe='))
const probeTypes = new Set<string>(probeArg === undefined ? [] : probeArg.slice('--probe='.length).split(',').filter(Boolean))
const probeLimitArg = dirs.find(a => a.startsWith('--limit='))
const probeLimit = probeLimitArg === undefined ? 3 : Number(probeLimitArg.slice('--limit='.length)) || 3

/**
 * 重叠度：同一子代理的 relay 消息与 settled 通知是否重复投递了同一份报告。
 * 按正文首部提到的 session UUID 配对，算**行级 Jaccard**（去重行集合的交/并）。
 * 只输出数值，不输出正文。
 */
function overlap(events: readonly RawSessionEvent[]): void {
  const UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i
  const pick = (kind: string) => {
    /** 归一化：剥离 markdown 装饰符与空白，比对"实际内容"而非排版。 */
    const norm = (l: string): string => l.replace(/[|*_`#>\-]/g, ' ').replace(/[，。；：、,.;:]|\s+/g, ' ').trim().toLowerCase()
    const linesOf = (t: string): string[] => t.split('\n').map(l => l.trim()).filter(l => l.length > 0)
    // ⚠️ 同一 UUID 多条时取最大的一条（重复投递会各自成条，此处先看该路的总量）
    const m = new Map<string, { seq: number; lines: Set<string>; chars: number }>()
    const normSet = new Map<string, Set<string>>()
    for (const e of events) {
      if (e.type !== 'user/message') continue
      if (((e.data ?? {})['source'] as { kind?: string } | undefined)?.['kind'] !== kind) continue
      const t = textOf(e)
      const id = UUID_RE.exec(t)?.[1]?.toLowerCase()
      if (id === undefined) continue
      const ls = linesOf(t)
      const prev = m.get(id)
      if (prev === undefined || ls.length > prev.lines.size) {
        m.set(id, { seq: e.seq, lines: new Set(ls), chars: t.length })
        normSet.set(id, new Set(ls.map(norm).filter(x => x.length > 12)))
      }
    }
    return { map: m, norm: normSet }
  }
  // 字符 4-gram：行级与"归一化行级"都抓不到同义重排（同一份报告一种是 `- Deleted X (Y)`
  // 列表、一种是 `| X | **Deleted** (Y) |` 表格），n-gram 对词序不敏感，中英文都适用。
  const grams = (t: string, n = 4): Set<string> => {
    const s = t.toLowerCase().replace(/[\s|*_`#>]/g, '')
    const g = new Set<string>()
    for (let i = 0; i + n <= s.length; i += 1) g.add(s.slice(i, i + n))
    return g
  }
  const rPair = pick('agent-message')
  const sPair = pick('subagent-settled')
  const relay = rPair.map
  const settled = sPair.map
  console.log(`  OVERLAP relay(${relay.size}) × settled(${settled.size})：同一子代理的成果是否被投递两次`)
  for (const [id, r] of relay) {
    const s = settled.get(id)
    if (s === undefined) { console.log(`     ${id.slice(0, 8)}: relay seq=${r.seq}，无配对 settled`); continue }
    const rn = grams(textOf(events.find(e => e.seq === r.seq)!))
    const sn = grams(textOf(events.find(e => e.seq === s.seq)!))
    const inter = [...rn].filter(x => sn.has(x)).length
    const union = new Set([...rn, ...sn]).size
    const jac = union === 0 ? 0 : inter / union
    // 归属 tok 按"归一化后仍能互相覆盖的比例"摊，避免高估可省空间
    const overlapTok = Math.round(tok(r.chars + s.chars) * jac / (1 + jac))
    console.log(`     ${id.slice(0, 8)}: relay seq=${r.seq}(${r.chars}ch) settled seq=${s.seq}(${s.chars}ch)`
      + ` 4-gram 重合=${inter}/${union} Jaccard=${(100 * jac).toFixed(0)}% ⇒ 保守可回收 ≈${overlapTok}tok`)
  }
  // 基线校准：4-gram 对英文散文有天然重合（常见词缀/功能词），必须拿**不同子代理**
  // 的交叉配对做基线，否则 47% 这类数字无法解释。
  const cross: number[] = []
  for (const [id, r] of relay) {
    for (const [id2, s] of settled) {
      if (id === id2) continue
      const rn = grams(textOf(events.find(e => e.seq === r.seq)!))
      const sn = grams(textOf(events.find(e => e.seq === s.seq)!))
      const inter = [...rn].filter(x => sn.has(x)).length
      const union = new Set([...rn, ...sn]).size
      if (union > 0) cross.push(inter / union)
    }
  }
  if (cross.length > 0) {
    const avg = cross.reduce((a, b) => a + b, 0) / cross.length
    console.log(`     基线（不同子代理交叉配对 n=${cross.length}）: 平均 Jaccard=${(100 * avg).toFixed(0)}%`
      + ` 最高=${(100 * Math.max(...cross)).toFixed(0)}% ⇒ 同配对显著高于基线才算真重复`)
  }
}

const sampleArg = dirs.find(a => a.startsWith('--sample='))
const sampleKinds = new Set<string>(sampleArg === undefined ? [] : sampleArg.slice('--sample='.length).split(',').filter(Boolean))
const sampleCharsArg = dirs.find(a => a.startsWith('--chars='))
const sampleChars = sampleCharsArg === undefined ? 700 : Number(sampleCharsArg.slice('--chars='.length)) || 700

for (const d of dirs.filter(a => !a.startsWith('--'))) {
  if (!fs.existsSync(path.join(d, 'session.v3.jsonl.zstd'))) { console.error(`跳过（无 session.v3.jsonl.zstd）: ${d}`); continue }
  report(d)
  const wantOverlap = dirs.includes('--overlap')
  const { events } = (probeTypes.size > 0 || sampleKinds.size > 0 || wantOverlap)
    ? loadSessionEvents(path.join(d, 'session.v3.jsonl.zstd'))
    : { events: [] as RawSessionEvent[] }
  if (wantOverlap) overlap(events)
  if (sampleKinds.size > 0) sample(events, sampleKinds, sampleChars, probeLimit)
  if (probeTypes.size > 0) probe(events, probeTypes, probeLimit)
}
