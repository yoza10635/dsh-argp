// spike 5 离线重判：修 turn 映射（prompt 序号 ≠ dsh 真实 turn 号）后重算 G6 与 C7-cites。
// 用法：node spike/05-rejudge.ts <产物目录名>
import fs from 'node:fs'
import path from 'node:path'

const dir = path.join(import.meta.dirname, 'out', process.argv[2] ?? '')
const evs = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse) as
  { type: string; seq: number; data: Record<string, any> }[]

const prompts: [string, string][] = [
  ['setup1', 'We are deciding whether the gateway release can go out.'],
  ['setup2', 'Here is the incident-window data for the gateway service.'],
  ['filler-1', 'logs/chunk-1.md'], ['filler-2', 'logs/chunk-2.md'],
  ['Q1', 'Question 1: strictly applying'], ['Q2', 'Good. Now Question 2'],
  ['filler-3', 'logs/chunk-3.md'], ['filler-4', 'logs/chunk-4.md'],
  ['filler-5', 'logs/chunk-5.md'], ['filler-6', 'logs/chunk-6.md'],
  ['probe', 'Finance is asking right now'],
]
const userEvs = evs.filter(e => e.type === 'user/message' && e.data?.source?.kind === 'user')
// user/message 无 turn 字段（实测形状 {content,source,role,id}）：user 消息追加在 turn/start 之后，
// 取该 seq 之前最近一个 turn/start 即为所属轮（重试轮的重复消息自然归入各自轮）
const turnStarts = evs.filter(e => e.type === 'turn/start').map(e => ({ seq: e.seq, turn: e.data.turn as number }))
const turnOfUser = (seq: number): number | null => {
  let best: { seq: number; turn: number } | null = null
  for (const t of turnStarts) if (t.seq < seq && (best === null || t.seq > best.seq)) best = t
  return best?.turn ?? null
}
const turnOf = new Map<string, number>()
for (const [label, marker] of prompts) {
  // 重试会留下重复 user 消息：按文案匹配并取最后一次（重试成功轮）
  const matched = userEvs.filter(e => JSON.stringify(e.data.content ?? '').includes(marker))
  const last = matched[matched.length - 1]
  if (last !== undefined) {
    const turn = turnOfUser(last.seq)
    if (turn !== null) turnOf.set(label, turn)
  }
}
console.log('turnOf:', JSON.stringify([...turnOf]))

function rawText(e: { data: Record<string, any> }): string {
  const c = e.data?.message?.content ?? []
  return (c as { type: string; text?: string }[]).filter(b => b.type === 'text').map(b => b.text ?? '').join('\n')
}

// G6 重判
const probeTurn = turnOf.get('probe') ?? -1
const probeText = evs.filter(e => e.type === 'assistant/message' && e.data.turn === probeTurn).map(rawText).join('\n')
const expectAll = ['0.0%', '148']
const expectAnyOf = ['GO', 'pass', 'Pass', 'PASS', 'approved', 'goes out', 'can go out']
const foundAll = expectAll.filter(v => probeText.includes(v))
const foundAny = expectAnyOf.find(v => probeText.includes(v))
console.log('[G6 re-judge]', foundAll.length === 2 && foundAny !== undefined ? 'PASS' : 'FAIL',
  '| expectAll', foundAll.length + '/2', '| anyOf=' + String(foundAny))
console.log('probe answer head:', probeText.slice(0, 200).replace(/\n/g, ' '))

// C7-cites 重判
const corpus = evs.map(e => rawText(e)).join('\n')
const fence = /```(?:json)?\s*(\{[\s\S]*?\})\s*```\s*$/
const bare = /(\{\s*"cites"\s*:[\s\S]*?\})\s*$/
for (const label of ['Q1', 'Q2', 'probe']) {
  const turn = turnOf.get(label) ?? -1
  const raw = evs.filter(e => e.type === 'assistant/message' && e.data.turn === turn).map(rawText).join('\n')
  const rawBlock = fence.exec(raw)?.[1] ?? bare.exec(raw)?.[1]
  let cites: string[] = []
  if (rawBlock !== undefined) {
    try {
      const parsed = JSON.parse(rawBlock) as { cites?: unknown }
      if (Array.isArray(parsed.cites)) cites = parsed.cites.filter(c => typeof c === 'string')
    } catch { /* 解析失败 */ }
  }
  const hits = cites.filter(c => c.trim() !== '' && corpus.includes(c.trim())).length
  console.log('[C7]', label, 'turn', turn, '| hasBlock', rawBlock !== undefined, '| declared', cites.length, '| verbatimHits', hits)
}
