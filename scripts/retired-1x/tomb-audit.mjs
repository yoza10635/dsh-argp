#!/usr/bin/env node
/**
 * ARGP 墓碑审计（tomb-audit）—— 回答"墓碑该不该放回上下文"这类设计问题。
 *
 * 用**宿主权威 foldSurface** 重建末态 surface，然后统计：
 *  1. 末态构成（A/R/U/system 各多少、各自多少个墓碑、字符量）
 *  2. R 墓碑的**配对状态**：它的 issuer（A 的 tool-call）是否还在末态
 *     - 在 ⇒ 占位必需（删了会产生孤儿 tool_call，API 400）
 *     - 不在 ⇒ 孤儿墓碑（纯浪费）
 *  3. 墓碑性价比：沿 replace 链回溯到 append 根源，算「原始内容字符 / 墓碑字符」
 *  4. 补 seq 成本：给每个不带 seq 的墓碑插 " seq=N" 要多少字符
 *  5. A 的 text / toolArgs 拆分（评估 C 方案靶子大小）
 *
 * 用法：
 *   1) 先用 python 把多帧 zstd 解成明文（Node 的 zstdDecompressSync 只解第一帧！）
 *      python -c "import sys,zstandard;d=zstandard.ZstdDecompressor();\
 *        open(sys.argv[2],'wb').write(d.stream_reader(open(sys.argv[1],'rb')).read())" \
 *        <session.v4.jsonl.zstd> session.jsonl
 *   2) node scripts/tomb-audit.mjs session.jsonl
 *
 * 宿主模块路径可用环境变量覆盖：DSH_PROFILE_NODE_MODULES（默认 ~/.dsh/profiles/node_modules）
 * 只读。
 */
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { homedir } from 'node:os'
import { join } from 'node:path'

const NM = process.env.DSH_PROFILE_NODE_MODULES ?? join(homedir(), '.dsh', 'profiles', 'node_modules')
const surfacePath = join(NM, '@deepseek-ai', 'dsh-session', 'lib', 'types', 'surface.js')
const { foldSurface } = await import(pathToFileURL(surfacePath).href)

const K = c => (c * 0.385 / 1000).toFixed(0)
const k1 = c => (c * 0.385 / 1000).toFixed(1)
const pct = (a, b) => (100 * a / Math.max(1, b)).toFixed(1)

const all = readFileSync(process.argv[2], 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l))
const events = all.slice(1)
console.log(`header.type = ${all[0]?.type} | events = ${events.length}`)
const fold = foldSurface(events)
console.log(`surface nodes = ${fold.nodes.length} | replacements = ${fold.replacements.length}\n`)

const evOf = s => events[s]
const blocksOf = e => {
  if (!e) return []
  const d = e.data || {}
  return e.type === 'user/message' ? (Array.isArray(d.content) ? d.content : [])
                                : (Array.isArray(d.message?.content) ? d.message.content : [])
}
// ⚠️ 口径必须与宿主/log-access.eventTextOf 逐字一致：**只认 type==='text' + tool-call(args)**。
// 历史坑：A 的 content 里有 `{type:'reasoning', text}` block（本档 422 个）——朴素的
// `if (typeof b.text === 'string')` 会把 reasoning 全算进可见字符（本档虚增 872K 字符 ≈ 13×）。
const textOf = e => {
  if (!e) return ''
  if (e.type === 'tool/call') return ''
  let out = ''
  for (const b of blocksOf(e)) {
    if (b?.type === 'text' && typeof b.text === 'string') out += b.text
    if (b?.type === 'tool-call') out += '[tool-call ' + (b.name ?? '?') + '(' + (typeof b.arguments === 'string' ? b.arguments : JSON.stringify(b.arguments ?? {})) + ')]'
    if (b?.type === 'tool-result') for (const ib of b.content ?? []) if (ib?.type === 'text' && typeof ib.text === 'string') out += ib.text
  }
  return out
}
const TOMB = t => t.includes('[elided')
/** 沿 replace 链回溯到 append 根源（链式替换会让 iv.seqs 指向上一代墓碑） */
function rootSeq(seq) {
  let cur = seq, g = 0
  while (g++ < 80) {
    const e = evOf(cur); if (!e) return cur
    const op = e.surfaceOp
    if (!op || op === 'append' || typeof op !== 'object' || op.op !== 'replace') return cur
    cur = op.startSeq
  }
  return cur
}

// ---------- 1) 末态构成 ----------
const per = {}; let totalChars = 0
for (const s of fold.nodes) {
  const e = evOf(s); const ty = e?.type ?? '?'; const t = textOf(e)
  totalChars += t.length
  const p = per[ty] ||= { n: 0, tomb: 0, ch: 0, tombCh: 0 }
  p.n++; p.ch += t.length
  if (TOMB(t)) { p.tomb++; p.tombCh += t.length }
}
console.log(`--- 末态节点 ---  总字符 ${totalChars} (≈${K(totalChars)}K tok @0.385)`)
for (const [ty, p] of Object.entries(per).sort((a, b) => b[1].n - a[1].n)) {
  console.log(`  ${String(ty).padEnd(18)} total=${String(p.n).padEnd(5)} tomb=${String(p.tomb).padEnd(5)} chars=${String(p.ch).padEnd(8)} tombChars=${p.tombCh}`)
}

// ---------- 2) R 墓碑配对 ----------
const issuer = new Map()
for (const s of fold.nodes) {
  const e = evOf(s); if (!e) continue
  if (e.type === 'tool/call' && e.data?.callId) {
    const a = typeof e.data.arguments === 'string' ? e.data.arguments : JSON.stringify(e.data.arguments ?? {})
    issuer.set(e.data.callId, { seq: s, type: 'tool/call', name: e.data.name ?? '?', argChars: a.length, argsStr: a })
  }
  for (const b of blocksOf(e)) {
    if (b?.type === 'tool-call' && (b.id ?? b.callId)) {
      const a = typeof b.arguments === 'string' ? b.arguments : JSON.stringify(b.arguments ?? {})
      issuer.set(b.id ?? b.callId, { seq: s, type: 'A', name: b.name ?? '?', argChars: a.length, argsStr: a })
    }
  }
}
const rTombs = []
for (const s of fold.nodes) {
  const e = evOf(s); if (!e || e.type !== 'tool/result') continue
  const t = textOf(e); if (!TOMB(t)) continue
  const cid = e.data?.message?.toolCallId ?? e.data?.toolCallId
  const root = rootSeq(s)
  const origChars = evOf(root)?.type === 'tool/result' ? textOf(evOf(root)).length : 0
  rTombs.push({ seq: s, len: t.length, cid, root, origChars, iss: cid ? issuer.get(cid) : undefined })
}
const paired = rTombs.filter(x => x.iss)
const totOrig = rTombs.reduce((a, x) => a + x.origChars, 0)
const totTomb = rTombs.reduce((a, x) => a + x.len, 0)
console.log(`\n--- R 墓碑 ${rTombs.length} 个 ---`)
console.log(`  配对 A 存活（占位必需）= ${paired.length}    孤儿（可整删）= ${rTombs.length - paired.length}`)
console.log(`  覆盖原始内容 = ${totOrig} 字符 (≈${K(totOrig)}K tok) vs 墓碑 ${totTomb} 字符 (≈${k1(totTomb)}K tok)`)
console.log(`  ⇒ 压缩比 ${(totOrig / Math.max(1, totTomb)).toFixed(0)}:1 ；墓碑占末态 surface 字符 ${pct(totTomb, totalChars)}%`)
const names = {}
for (const x of paired) names[x.iss.name] = (names[x.iss.name] || 0) + 1
console.log('  配对 A 的 tool 分布:', JSON.stringify(Object.entries(names).sort((a, b) => b[1] - a[1]).slice(0, 10)))

// ---------- 3) 可寻址性 ----------
const noSeq = rTombs.filter(x => !/seq=/.test(textOf(evOf(x.seq))))
let add = 0
for (const x of noSeq) add += (` seq=${x.root}`).length
console.log('\n--- 可寻址性 ---')
console.log(`  R 墓碑自带 seq = ${rTombs.length - noSeq.length} / ${rTombs.length}`)
console.log(`  补 " seq=N" ⇒ 净增 ${add} 字符 (≈${K(add)}K tok)，末态占比升到 ${pct(totTomb + add, totalChars)}%`)
const ok = rTombs.filter(x => evOf(x.root)?.type === 'tool/result' && textOf(evOf(x.root)).length > 42).length
console.log(`  rootSeq 指向真实原文的 = ${ok} / ${rTombs.length} ⇒ recall_pruned(该 seq) 可一步取回`)

// ---------- 3.5) 空转统计（核心：多少 replace 是"墓碑换墓碑"） ----------
// ⚠️ 2026-09-25 修正（旧判据有三类假阳性）：
//   ① **自指**：`textOf(target).includes('[elided')` 会把「原文里含墓碑模板」的节点误判——
//      read 到的源码（argp-graph-engine.ts / prune-tx.ts 内含墓碑字面量）与 **system prompt 自身
//      内嵌的墓碑模板** 都命中，实测把 41271→1108 字符这种大额收益判成"收益 0"。
//   ② **区间合并**：span>1 的替换只比 `events[startSeq]` 一个节点的字符 ⇒ 忽略被并掉的其余墓碑。
//   ③ **判据口径**：宿主 `invariant.ts` 的 shadowed span 是**位置切片**
//      `surface.nodes.slice(indexOf(start), indexOf(end)+1)`，不是数值范围过滤。
// 现判据：按位置切片取"替换前该 span 的当前字符总和"，与新文本比 —— after >= before 才算空转。
const surfaceAt = new Array(events.length)
let liveNodes = []
for (let j = 0; j < events.length; j += 1) {
  surfaceAt[j] = liveNodes
  liveNodes = foldSurface(events.slice(0, j + 1)).nodes
}
let repl = 0, noGain = 0, gain = 0
let skipped = 0
const noGainBy = {}, gainBy = {}
/** 锚定判据：整段文本就是一块墓碑（排除"原文里恰好含墓碑字面量"的自指假阳性）。 */
const isTombText = (s) => /^\[elided[ :\]]/.test(s.trim()) && s.trim().length < 400
for (let j = 0; j < events.length; j += 1) {
  const e = events[j]
  const op = e.surfaceOp
  if (!op || typeof op !== 'object' || op.op !== 'replace') continue
  const afterText = textOf(e)
  // 非墓碑产物 = 内容替换/摘要/summary 回填/system 块刷新，不属"空转"统计面
  if (!isTombText(afterText)) { skipped += 1; continue }
  repl++
  const surface = surfaceAt[j] ?? []
  const si = surface.indexOf(op.startSeq)
  const ei = surface.indexOf(op.endSeq)
  const covered = si >= 0 && ei >= si ? surface.slice(si, ei + 1) : [op.startSeq]
  const before = covered.reduce((n, s) => n + textOf(events[s]).length, 0)
  const after = afterText.length
  const targetType = events[op.startSeq]?.type ?? '?'
  if (after >= before) {
    noGain++
    noGainBy[targetType] = (noGainBy[targetType] || 0) + 1
  } else {
    gain++
    gainBy[targetType] = (gainBy[targetType] || 0) + 1
  }
}
const comp = {}
for (const e of events) if (String(e.type).startsWith('compaction/')) comp[e.type] = (comp[e.type] || 0) + 1
console.log('\n--- 空转统计（真·墓碑换墓碑 = 墓碑产出且字符零收益或负收益）---')
console.log(`  墓碑类 replace 事件 = ${repl}（另有 ${skipped} 条非墓碑产物：内容/摘要替换、system 块刷新，不计入）`)
console.log(`  ├ 字符零/负收益（空转或改写变长）= ${noGain} (${pct(noGain, repl)}%)  ${JSON.stringify(noGainBy)}`)
console.log(`  └ 字符有收益（含区间合并）= ${gain} (${pct(gain, repl)}%)  ${JSON.stringify(gainBy)}`)
console.log(`  compaction/start = ${comp['compaction/start'] ?? 0}  vs  compaction/prune = ${comp['compaction/prune'] ?? 0}`)
console.log('  ⚠️ 非 0 时先分类：合并墓碑/族别改写（为可合并铺路）属设计内，只有 1:1 等长重立碑才算真回归')


// ---------- 4) A 的拆分 ----------
let aText = 0, aArgs = 0, aN = 0
for (const s of fold.nodes) {
  const e = evOf(s); if (e?.type !== 'assistant/message') continue
  aN++
  for (const b of blocksOf(e)) {
    if (b?.type === 'text' && typeof b.text === 'string') aText += b.text.length
    if (b?.type === 'tool-call') aArgs += JSON.stringify(b.arguments ?? {}).length
  }
}
console.log(`\n--- A 拆分（${aN} 个）---`)
console.log(`  text = ${aText} (${pct(aText, aText + aArgs)}%)   toolArgs = ${aArgs} (${pct(aArgs, aText + aArgs)}%)`)

// ---------- 5) A 生命史（append 口径：只看原始 A，不数链式中间产物） ----------
// 目的：回答「A 在任何情况下都不能被剪吗」——把「被剪的 A」按有无 tool-call 拆开。
const liveSet = new Set(fold.nodes)
const posOf = new Map(fold.nodes.map((s, i) => [s, i]))
const isAppend = e => { const op = e.surfaceOp; return !op || op === 'append' }
const tcsOf = e => blocksOf(e).filter(b => b?.type === 'tool-call').filter(b => b.id ?? b.callId)
let aAll = 0, aLiveN = 0, aPrunedN = 0
let aAllTC = 0, aLiveTC = 0, aPrunedTC = 0
let aPrunedChars = 0, aLiveChars = 0
const prunedATC = []
for (const e of events) {
  if (e.type !== 'assistant/message' || !isAppend(e)) continue
  const tcs = tcsOf(e); const t = textOf(e)
  aAll++
  if (tcs.length > 0) aAllTC++
  if (liveSet.has(e.seq)) { aLiveN++; aLiveChars += t.length; if (tcs.length > 0) aLiveTC++ }
  else { aPrunedN++; aPrunedChars += t.length; if (tcs.length > 0) { aPrunedTC++; prunedATC.push(e.seq) } }
}
console.log(`\n--- A 生命史（append 口径，原始 A 共 ${aAll} 个）---`)
console.log(`  被剪 = ${aPrunedN} (${pct(aPrunedN, aAll)}%)  存活 = ${aLiveN}  存活字符 = ${aLiveChars}`)
console.log(`  ├ 带 tool-call 的 A 共 ${aAllTC}：被剪 ${aPrunedTC} / 存活 ${aLiveTC}`)
console.log(`  └ 纯文本 A（无 tool-call）共 ${aAll - aAllTC}：被剪 ${aPrunedN - aPrunedTC} / 存活 ${aLiveN - aLiveTC}`)
// R 组是否仍在末态 ⇒ A10 是否仍有锁定对象。
// ⚠️ 口径关键：stub 墓碑是**新 seq**、继承原 callId ⇒ 必须按「末态 surface 里还有没有持有该
// callId 的 tool/result」判，不能按「原 R 的 append seq 是否在场」判（后者会把 stub 误判成离场）。
const liveCallIds = new Set()
const callIdOfEvent = e => e.data?.message?.source?.callId ?? e.data?.message?.toolCallId ?? e.data?.toolCallId
for (const s of fold.nodes) {
  const e = evOf(s)
  if (e?.type !== 'tool/result') continue
  const cid = callIdOfEvent(e)
  if (cid) liveCallIds.add(cid)
}
let liveTCRGroupAlive = 0
for (const e of events) {
  if (e.type !== 'assistant/message' || !isAppend(e) || !liveSet.has(e.seq)) continue
  const tcs = tcsOf(e); if (tcs.length === 0) continue
  if (tcs.some(b => liveCallIds.has(b.id ?? b.callId))) liveTCRGroupAlive++
}
console.log(`  存活且带 tool-call 的 A 中，R 组在末态仍非空 = ${liveTCRGroupAlive}/${aLiveTC} ⇒ 这些正是 A10 的锁定对象`)
// 被剪的带 tc 的 A：R 是否一并离场（协议安全：剪 A 必须连带剪 R）
let drag = 0, leftBehind = 0
for (const seq of prunedATC) {
  const e = evOf(seq)
  for (const b of tcsOf(e)) {
    if (liveCallIds.has(b.id ?? b.callId)) leftBehind++ // A 走了 R 占位还在 ⇒ 潜在孤儿 tool 消息
    else drag++
  }
}
console.log(`  被剪的带 tc 的 A：连带剪掉的 R = ${drag}，A 走了但 R 占位仍在 = ${leftBehind}`)
console.log(`  末态持有 callId 的 tool/result 节点 = ${liveCallIds.size}（含 stub 墓碑）`)

// ---------- 6) 「把 req 带上」成本 ----------
// 墓碑文案现在是固定 42 字符、不含 seq。若要在墓碑里带"这是什么调用"的线索，量化 4 档成本。
const { findLoadBearingTokens } = await import(new URL('../lib/token-ontology.js', import.meta.url).href)
const pathFromArgs = a => {
  const m = a.match(/"[^"]*[\\/][^"]*"/g)
  if (!m) return ''
  const cand = m.map(x => x.slice(1, -1)).sort((x, y) => y.length - x.length)[0] ?? ''
  return (cand.split(/[\\/]/).filter(Boolean).pop() ?? '').slice(0, 24)
}
const lbFromText = t => {
  const toks = findLoadBearingTokens(t).sort((x, y) => y.length - x.length)
  return (toks[0] ?? '').slice(0, 24)
}
let o1 = 0, o2 = 0, o3 = 0, o4 = 0, c1 = 0, c2 = 0, c3 = 0, c4 = 0
let adjacent = 0, far = 0, issGone = 0
for (const x of rTombs) {
  const rootText = x.root !== undefined ? textOf(evOf(x.root)) : ''
  const iss = x.iss
  const seqAdd = ' seq=' + x.root
  o1 += seqAdd.length; c1++
  if (!iss) { issGone++; continue }
  o2 += (' ' + iss.name + seqAdd).length; c2++
  const pk = pathFromArgs(iss.argsStr ?? '')
  if (pk) { o3 += (' ' + iss.name + ' ' + pk + seqAdd).length; c3++ }
  const lk = lbFromText(rootText)
  if (lk) { o4 += (' ' + iss.name + ' ' + lk + seqAdd).length; c4++ }
  // 线索是否"已在上下文"：issuer A 是否存活且紧邻墓碑
  const ip = posOf.get(iss.seq)
  const tp = posOf.get(x.seq)
  if (ip === undefined) issGone++
  else if (tp !== undefined && Math.abs(ip - tp) <= 2) adjacent++
  else far++
}
console.log(`\n--- 「把 req 带上」成本（R 墓碑 ${rTombs.length} 个，现文案 ${totTomb / Math.max(1, rTombs.length) | 0} 字符）---`)
console.log(`  O1  加 " seq=N"            = +${o1} 字符 (≈${k1(o1)}K tok) 覆盖 ${c1}/${rTombs.length}`)
console.log(`  O2  + tool 名              = +${o2} 字符 (≈${k1(o2)}K tok) 覆盖 ${c2}/${rTombs.length}`)
console.log(`  O3  + 名 + 参数里的文件名   = +${o3} 字符 (≈${k1(o3)}K tok) 覆盖 ${c3}/${rTombs.length}`)
console.log(`  O4  + 名 + 原文承重 token   = +${o4} 字符 (≈${k1(o4)}K tok) 覆盖 ${c4}/${rTombs.length}`)
console.log('  ⚠️ 对照：A 的 toolArgs 全量 = ' + aArgs + ' 字符（把 req 逐字带上 = 退回不压缩）')
console.log('--- 线索是否已在上下文 ---')
console.log(`  issuer A 仍存活且紧邻墓碑(位置距≤2) = ${adjacent}   存活但远离 = ${far}   issuer A 已离场 = ${issGone}`)

console.log('\n--- 样例（墓碑seq → rootSeq）---')
for (const x of rTombs.slice(0, 6)) {
  console.log(`  tomb=${x.seq} → root=${x.root} (原文 ${x.origChars}c) issuer=${x.iss?.type ?? '-'}:${x.iss?.name ?? '-'} | ${textOf(evOf(x.root)).slice(0, 50).replace(/\n/g, ' ')}`)
}
