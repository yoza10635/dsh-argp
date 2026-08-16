// spike 6 溯源三：INC-5-MARKER-568B 全文出现位置 + recall 调用相对 turn/start 的真实归属
import fs from 'node:fs'
import path from 'node:path'

const dir = path.join(import.meta.dirname, 'out', '06-tlong-2026-08-15T19-28-31-109Z')
const evs = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse) as
  { type: string; seq: number; data: Record<string, any> }[]

// 1) marker 568B 在哪些事件出现（原始 JSON 字符串扫描）
const hits: { seq: number; type: string; turn: unknown }[] = []
for (const e of evs) {
  if (JSON.stringify(e.data).includes('568B')) hits.push({ seq: e.seq, type: e.type, turn: e.data?.turn })
}
console.log('568B occurrences:', hits.length)
for (const h of hits) console.log('  seq=' + h.seq + ' type=' + h.type + ' turn=' + JSON.stringify(h.turn))

// 2) recall tool/call seq 与各 turn/start seq 的相对位置（不靠插值，直接列边界）
const turnStarts = evs.filter(e => e.type === 'turn/start').map(e => ({ seq: e.seq, turn: e.data.turn as number }))
const recallSeqs = evs.filter(e => e.type === 'tool/call' && e.data?.name === 'recall_pruned').map(e => e.seq)
console.log('turn/start boundaries (first 22):', JSON.stringify(turnStarts.slice(0, 22)))
console.log('recall call seqs:', JSON.stringify(recallSeqs))

// 3) probe-2 cite 声明的原文是否在任何 turn-20 之前的 surface 可见节点里 —— 全量重放 surface@turn20
const turnStart20 = turnStarts.find(t => t.turn === 20)
const surfaceAt: number[] = []
if (turnStart20 !== undefined) {
  for (const e of evs) {
    if (e.seq >= turnStart20.seq) break
    if (!['user/message', 'assistant/message', 'tool/result'].includes(e.type)) continue
    const op = (e as { surfaceOp?: unknown }).surfaceOp
    if (op === undefined || op === 'append') { surfaceAt.push(e.seq); continue }
    const { start, end } = op as { start: number; end: number }
    const i = surfaceAt.indexOf(start)
    const j = surfaceAt.indexOf(end)
    if (i >= 0 && j >= i) surfaceAt.splice(i, j - i + 1, e.seq)
    else surfaceAt.push(e.seq)
  }
}
let visibleWith568B = 0
for (const seq of surfaceAt) {
  const e = evs.find(x => x.seq === seq)
  if (e !== undefined && JSON.stringify(e.data).includes('568B')) visibleWith568B += 1
}
console.log('surface nodes at turn-20:', surfaceAt.length, '| nodes containing 568B:', visibleWith568B)

// 4) probe-1（turn 14）召回的 seq=2752 内容头部——确认是 chunk-2
const e2752 = evs.find(x => x.seq === 2752)
const c = (e2752?.data?.message?.content ?? []) as { type: string; content?: { type: string; text?: string }[] }[]
const inner = c.flatMap(b => b.type === 'tool-result' ? (b.content ?? []) : []).filter(x => x.type === 'text').map(x => x.text ?? '').join('')
console.log('seq=2752 inner head:', inner.slice(0, 100).replace(/\n/g, ' '))
