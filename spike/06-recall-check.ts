// spike 6 溯源二：recall tool/result 内容核实 + engine.recallCalls 与 tool/call 事件对应关系
import fs from 'node:fs'
import path from 'node:path'

const dir = path.join(import.meta.dirname, 'out', '06-tlong-2026-08-15T19-28-31-109Z')
const evs = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse) as
  { type: string; seq: number; data: Record<string, any> }[]
const result = JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8')) as { recallCalls: { seq: number; hit: boolean }[] }

const txt = (e: { data: Record<string, any> }): string => {
  const c = e.data?.message?.content ?? []
  return (Array.isArray(c) ? c : []).filter((b: any) => b.type === 'text').map((b: any) => b.text ?? '').join('\n')
}
const innerTxt = (e: { data: Record<string, any> }): string => {
  const c = e.data?.message?.content ?? []
  return (Array.isArray(c) ? c : []).flatMap((b: any) => b.type === 'tool-result' ? (b.content ?? []) : []).filter((x: any) => x.type === 'text').map((x: any) => x.text ?? '').join('\n')
}

// 1) 每个 recall_pruned tool/call 后随的 tool/result：长度与头部（是否真取回 chunk 原文）
const calls = evs.filter(e => e.type === 'tool/call' && e.data?.name === 'recall_pruned')
const turnStarts = evs.filter(e => e.type === 'turn/start').map(e => ({ seq: e.seq, turn: e.data.turn as number }))
const tOf = (s: number): number | null => { let b: { seq: number; turn: number } | null = null; for (const t of turnStarts) if (t.seq < s && (b === null || t.seq > b.seq)) b = t; return b?.turn ?? null }
for (const c of calls) {
  const args = JSON.parse(c.data.arguments as string) as { seq: number }
  // 紧随其后的同 callId tool/result
  const callId = (c.data.id ?? c.data.message?.content?.find?.((b: any) => b.type === 'tool-call')?.id) as string | undefined
  const res = evs.find(e => e.type === 'tool/result' && e.seq > c.seq && e.data?.message?.source?.callId === callId)
  const body = res ? innerTxt(res) : ''
  console.log('turn=' + tOf(c.seq) + ' recall(seq=' + args.seq + ') -> result len=' + body.length + ' head="' + body.slice(0, 60).replace(/\n/g, ' ') + '"')
}

// 2) result.json 的 engine.recallCalls：seq 分布与命中形态
console.log('--- engine.recallCalls (len=' + result.recallCalls.length + '):')
for (const rc of result.recallCalls) {
  const e = evs.find(x => x.seq === rc.seq)
  console.log('  seq=' + rc.seq + ' hit=' + rc.hit + ' type=' + (e?.type ?? '?') + ' eventTextLen~' + (e ? (txt(e).length + innerTxt(e).length) : 0))
}

// 3) 结论核对：probe 轮实际 recall tool/call 次数
const perTurn = new Map<number, number>()
for (const c of calls) { const t = tOf(c.seq); if (t !== null) perTurn.set(t, (perTurn.get(t) ?? 0) + 1) }
console.log('recall tool/call per turn:', JSON.stringify([...perTurn]))
