// spike 6 离线分析：citeStats.failed=549 溯源 + recall 命中形态
import fs from 'node:fs'
import path from 'node:path'

const dir = path.join(import.meta.dirname, 'out', '06-tlong-2026-08-15T19-28-31-109Z')
const evs = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse) as
  { type: string; seq: number; data: Record<string, any> }[]

const txt = (e: { data: Record<string, any> }): string => {
  const c = e.data?.message?.content ?? []
  return (Array.isArray(c) ? c : []).filter((b: any) => b.type === 'text').map((b: any) => b.text ?? '').join('\n')
}

// 1) assistant 消息里含 "cites" 字面量的数量与形态
let withCites = 0
let validBlock = 0
const samples: string[] = []
for (const e of evs) {
  if (e.type !== 'assistant/message') continue
  const t = txt(e)
  if (!t.includes('"cites"')) continue
  withCites += 1
  const fence = t.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```\s*$/)
  const bare = t.match(/(\{\s*"cites"\s*:[\s\S]*?\})\s*$/)
  if (fence?.[1] ?? bare?.[1]) validBlock += 1
  if (samples.length < 3) samples.push('turn=' + e.data.turn + ' | ' + t.slice(0, 220).replace(/\n/g, ' '))
}
console.log('assistant msgs with "cites":', withCites, '| with trailing valid block:', validBlock)
for (const s of samples) console.log('  sample:', s)

// 2) 各类消息数量（atomize 每次压缩检查都重数 —— citeStats 是累计值不是唯一原子数）
const counts: Record<string, number> = {}
for (const e of evs) counts[e.type] = (counts[e.type] ?? 0) + 1
console.log('event counts:', JSON.stringify(counts))

// 3) 用引擎同款 extractCites 对全量 assistant 消息重算，定位 failed 来源
const { extractCites } = await import('../src/argp-graph-engine.ts')
let ok = 0, failed = 0, none = 0
const failedSamples: string[] = []
for (const e of evs) {
  if (e.type !== 'assistant/message') continue
  const { cites, attempted } = extractCites(txt(e))
  if (attempted && cites.length === 0) {
    failed += 1
    if (failedSamples.length < 3) failedSamples.push('turn=' + e.data.turn + ' | ' + txt(e).slice(-260).replace(/\n/g, ' '))
  } else if (cites.length > 0) ok += 1
  else none += 1
}
console.log('extractCites over 103 msgs: ok=' + ok + ' failed=' + failed + ' none=' + none)
for (const s of failedSamples) console.log('  failed sample:', s)

// 4) recall 调用的目标形态：命中 seq 的原文头部
const recallSeqs = [2750, 2752, 9437, 9439, 22973, 32056, 44889, 61643, 72047]
for (const seq of recallSeqs) {
  const e = evs.find(x => x.seq === seq)
  console.log('recall target seq=' + seq + ' type=' + (e?.type ?? '?') + ' head=' + (e ? txt(e).slice(0, 90).replace(/\n/g, ' ') : '-'))
}
