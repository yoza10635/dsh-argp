// 离线逐原子审计：直接解析 events.jsonl（权威事件流）+ result.json（graph engine records）
// 不依赖 surface.at() 时序/墓碑，避免 run-to-run 变量与取数陷阱。
import fs from 'node:fs'

const dir = process.argv[2]
if (!dir) { console.error('usage: node _tmp_atomaudit.mjs <outDir>'); process.exit(1) }

const events = fs.readFileSync(dir + '/events.jsonl', 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
const result = JSON.parse(fs.readFileSync(dir + '/result.json', 'utf8'))

// 递归文本长度：处理 tool-result / tool-call 等嵌套 content（block.content[].text）
function blockText(b) {
  if (!b) return 0
  let s = 0
  if (typeof b.text === 'string') s += b.text.length
  if (typeof b.content === 'string') s += b.content.length
  if (Array.isArray(b.content)) s += blocksText(b.content)
  if (typeof b.arguments === 'string') s += b.arguments.length
  else if (b.arguments) s += JSON.stringify(b.arguments).length
  return s
}
function blocksText(arr) {
  let s = 0
  for (const b of arr) s += blockText(b)
  return s
}
function textLen(o) {
  if (!o) return 0
  if (typeof o.text === 'string') return o.text.length
  if (typeof o.body === 'string') return o.body.length
  const arr = o.message?.content ?? o.content
  if (Array.isArray(arr)) return blocksText(arr)
  if (typeof o.arguments === 'string') return o.arguments.length
  if (o.arguments) return JSON.stringify(o.arguments).length
  if (o.message) return JSON.stringify(o.message).length
  return JSON.stringify(o).length
}
function typeOf(o) {
  if (!o) return '?'
  if (o.type) return o.type
  if (o.role === 'user') return 'U'
  const c0 = Array.isArray(o.message?.content) ? o.message.content[0] : null
  if (c0?.type === 'tool-result') return 'R'
  if (c0?.type === 'tool-call') return 'tool/call'
  if (o.role === 'assistant' || o.message) return 'A'
  if (o.name && (o.arguments !== undefined || o.toolCallId !== undefined)) return 'tool/call'
  if (o.toolCallId !== undefined || o.toolUseId !== undefined) return 'R'
  return '?'
}

// 1) 原始长度（首次 append）+ 类型
const origLen = new Map()      // seq -> 原始字符长
const origType = new Map()     // seq -> 类型
const replaceLen = new Map()   // seq -> 末次 replace 后的字符长（per-atom 压缩后）
const replaceCount = new Map() // seq -> 被压缩替换次数

for (const e of events) {
  const sop = e.surfaceOp
  if (!sop) continue
  const isObj = typeof sop === 'object'
  const op = isObj ? sop.op : sop
  if (op === 'append') {
    const seq = e.seq
    if (typeof seq === 'number' && !origLen.has(seq)) {
      origLen.set(seq, textLen(e.data))
      origType.set(seq, typeOf(e.data))
    }
  } else if (op === 'replace') {
    const start = isObj ? sop.start : e.seq
    const end = isObj ? sop.end : e.seq
    if (typeof start === 'number' && start === end) {
      // 单原子原地替换 = per-atom 压缩
      replaceLen.set(start, textLen(e.data))
      replaceCount.set(start, (replaceCount.get(start) ?? 0) + 1)
    }
  }
}

// 2) per-atom 压缩报告（append 原文 → 末次 replace 后）
const allReplaces = []
for (const [seq, before] of origLen) {
  const after = replaceLen.get(seq)
  if (after !== undefined && before > 0) {
    allReplaces.push({
      seq,
      type: origType.get(seq) ?? '?',
      before,
      after,
      rate: +(after / before * 100).toFixed(1),
      reduced: after < before * 0.9,
      replaces: replaceCount.get(seq) ?? 1,
    })
  }
}
allReplaces.sort((a, b) => a.rate - b.rate)
const compressions = allReplaces.filter(c => c.reduced)

// 3) graph engine 剪枝报告（权威：engineRecords[0]）
const er = result.engineRecords?.[0]
const prunedAtoms = er?.prunedAtoms ?? []
const prunedSeqs = prunedAtoms.map(p => p.seq)
const prunedTypes = prunedAtoms.map(p => p.type)
const shadowedTokenCount = events.find(e => e.type === 'compaction/prune')?.data?.shadowedTokenCount ?? 0
// 剪枝原子的原文长度（从 append 事件重建）
const prunedOrigLen = prunedSeqs.map(s => origLen.get(s) ?? -1)
const prunedSet = new Set(prunedSeqs)
// 压缩后又被剪枝的原子（两段管线都作用过）
const compressedThenPruned = compressions.filter(c => prunedSet.has(c.seq))

// 4) 汇总
console.log('=== 双引擎跑通判定 ===')
console.log('verdict.failures =', JSON.stringify(result.verdict.failures))
console.log('turnsCompleted =', result.turnsCompleted, '/', result.turnsPlanned, ' aborted =', result.aborted)
console.log('compressorCalls =', result.compressorCalls, ' declarerCachedEdges =', result.declarerCachedEdges, ' recallCalls =', result.recallCalls)
console.log('graph pruneTransactions(engine.records) =', result.pruneTransactions)

console.log('\n=== 逐原子压缩（Stage-1 per-atom compressor，原地 replace）===')
console.log('被压缩替换的原子数 =', allReplaces.length, ' / 总 append 原子 =', origLen.size)
console.log('其中显著压缩(>10% 降幅) =', compressions.length, '；轻微/无压缩 =', allReplaces.length - compressions.length)
console.log('压缩最狠前 15（含「*」= 后被 Stage-2 剪枝）：')
for (const c of compressions.slice(0, 15)) {
  console.log(`  ${c.seq===c.seq?'':''}seq=${c.seq}${prunedSet.has(c.seq)?' *':''} type=${c.type} ${c.before}→${c.after} (${c.rate}%) replaces=${c.replaces}`)
}
console.log('被压缩且随后遭剪枝的原子 =', compressedThenPruned.length, compressedThenPruned.map(c=>c.seq).join(','))

console.log('\n=== 剪枝（Stage-2 graph engine，tombstone）===')
console.log('剪枝原子数 =', prunedSeqs.length)
console.log('shadowedTokenCount =', shadowedTokenCount)
console.log('range charsBefore→charsAfter =', er?.charsBefore, '→', er?.charsAfter)
const tc = {}
for (const t of prunedTypes) tc[t] = (tc[t] ?? 0) + 1
console.log('剪枝原子类型分布 =', JSON.stringify(tc))
console.log('剪枝具体原子 (seq : type : 原文长) ：')
for (let i = 0; i < prunedSeqs.length; i++) {
  console.log(`  [${i + 1}] seq=${prunedSeqs[i]} type=${prunedTypes[i]} origLen=${prunedOrigLen[i]}`)
}
