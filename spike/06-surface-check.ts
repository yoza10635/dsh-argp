// spike 6 溯源：probe-2 的 R 针原文是否仍在 surface（判定遮蔽口径是否有误）
import fs from 'node:fs'
import path from 'node:path'

const dir = path.join(import.meta.dirname, 'out', '06-tlong-2026-08-15T19-28-31-109Z')
const evs = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse) as
  { type: string; seq: number; surfaceOp?: unknown; sourceEventSeqs?: number[]; data: Record<string, any> }[]

// 1) 重建 surface：append 追加、replace 原位替换（按 spike 2 实测语义）
const surface: number[] = []
for (const e of evs) {
  if (!['user/message', 'assistant/message', 'tool/result'].includes(e.type)) continue
  const op = e.surfaceOp
  if (op === undefined || op === 'append') { surface.push(e.seq); continue }
  const { start, end } = op as { start: number; end: number }
  const i = surface.indexOf(start)
  const j = surface.indexOf(end)
  if (i >= 0 && j >= i) surface.splice(i, j - i + 1, e.seq)
  else surface.push(e.seq)
}
console.log('final surface nodes:', surface.length)

// 2) 遮蔽集合（事件级：replace.sourceEventSeqs 并集）
const shadowed = new Set<number>()
for (const e of evs) if (e.surfaceOp !== undefined && e.surfaceOp !== 'append') for (const s of e.sourceEventSeqs ?? []) shadowed.add(s)

// 3) 各 probe 的 R 针 tool/result 是否真在 surface 外
const txt = (seq: number): string => {
  const e = evs.find(x => x.seq === seq)
  const c = e?.data?.message?.content ?? []
  return (Array.isArray(c) ? c : []).filter((b: any) => b.type === 'text' || b.type === 'tool-result').map((b: any) => {
    if (b.type === 'text') return b.text ?? ''
    return (b.content ?? []).filter((x: any) => x.type === 'text').map((x: any) => x.text ?? '').join('\n')
  }).join('\n')
}
for (const j of [2, 5, 8, 11, 15, 20, 25]) {
  const needle = 'INC-' + j + '-MARKER-'
  const holders = evs.filter(e => e.type === 'tool/result' && txt(e.seq).includes(needle))
  for (const h of holders) {
    console.log('chunk-' + j + ' tool/result seq=' + h.seq
      + ' onSurface=' + surface.includes(h.seq) + ' inShadowedSet=' + shadowed.has(h.seq)
      + ' chars=' + txt(h.seq).length)
  }
}

// 4) probe-2 时点（turn 20 的 turn/start 之前）surface 上是否含 chunk-5 原文
const turnStart20 = evs.find(e => e.type === 'turn/start' && e.data.turn === 20)
if (turnStart20 !== undefined) {
  const surfaceAt: number[] = []
  for (const e of evs) {
    if (e.seq >= turnStart20.seq) break
    if (!['user/message', 'assistant/message', 'tool/result'].includes(e.type)) continue
    const op = e.surfaceOp
    if (op === undefined || op === 'append') { surfaceAt.push(e.seq); continue }
    const { start, end } = op as { start: number; end: number }
    const i = surfaceAt.indexOf(start)
    const j = surfaceAt.indexOf(end)
    if (i >= 0 && j >= i) surfaceAt.splice(i, j - i + 1, e.seq)
    else surfaceAt.push(e.seq)
  }
  const holders = evs.filter(e => e.type === 'tool/result' && txt(e.seq).includes('INC-5-MARKER-'))
  for (const h of holders) {
    console.log('at turn-20: chunk-5 tool/result seq=' + h.seq + ' onSurface=' + surfaceAt.includes(h.seq))
  }
  console.log('surface nodes at turn-20:', surfaceAt.length)
}
