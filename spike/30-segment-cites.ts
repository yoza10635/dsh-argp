// spike 30：分段前向引用标注实验（用户 2026-08-24 提出）
// 思路：不跑全流程 agent 循环，直接取现成的多轮对话（26-v4-fix50 events.jsonl，
// 50 轮 tlong），切成 N 段，每段 1 次 LLM 调用标注"段内最后一个 turn 的前向引用
// （cites）"，收集边集 → 用 28 的离线重放（oracle 注入）对比 无边/标注边 的保留集（P1）。
// 输出：<SEG_SRC>/annotated-cites.json（[{fromSeq,toSeq,level}]，供 EDGE_SOURCE=oracle 注入）
import fs from 'node:fs'
import path from 'node:path'

const SRC = process.env['SEG_SRC'] ?? 'spike/out/26-v4-fix50-2026-08-22T12-49-03-413Z'
// SEG_MAX：分段数（默认 10 段；设 50 = 每轮一段、标注全部轮次的前向引用）
const MAX_SEGMENTS = Number(process.env['SEG_MAX'] ?? 10)
const QWEN_BASE = process.env['QWEN_BASE'] ?? 'http://127.0.0.1:8080/v1'
const QWEN_MODEL = process.env['QWEN_MODEL'] ?? 'Qwen3.8-27B'

interface Ev { seq: number; type: string; data?: Record<string, unknown>; surfaceOp?: unknown }

const SURFACE_TYPES = new Set(['user/message', 'assistant/message', 'tool/result', 'tool/call'])

function eventText(ev: Ev): string {
  const data = ev.data ?? {}
  if (ev.type === 'tool/call') {
    return '[tool-call ' + String(data.name ?? '?') + '(' + JSON.stringify(data.arguments ?? {}) + ')]'
  }
  const raw = ev.type === 'user/message' ? data.content : (data.message as { content?: unknown } | undefined)?.content
  const blocks = Array.isArray(raw) ? raw as { type?: string; text?: string; name?: string; content?: { type?: string; text?: string }[] }[] : []
  const parts: string[] = []
  for (const b of blocks) {
    if (b?.type === 'text' && typeof b.text === 'string') parts.push(b.text)
    if (b?.type === 'tool-call') parts.push('[tool-call ' + (b.name ?? '?') + ']')
    if (b?.type === 'tool-result') for (const inner of b.content ?? []) if (inner?.type === 'text') parts.push(inner.text)
  }
  return parts.join('\n')
}

const truncate = (s: string, n: number): string => (s.length <= n ? s : s.slice(0, n) + '\n...[truncated]')

async function annotate(segmentText: string): Promise<number[]> {
  const prompt = 'You are annotating dependency references in a conversation segment.\n'
    + 'Below, each line is labeled with a [seq]. The LAST assistant reply is the annotation target.\n'
    + '---\n' + segmentText + '\n---\n'
    + 'Task: list the seq numbers of the EARLIER items (user messages, tool results, assistant replies) '
    + 'that the LAST assistant reply DEPENDS ON. Only include items the reply actually builds on '
    + '(e.g., the tool result it reports from, the instruction it follows). '
    + 'If it depends on nothing earlier, output an empty array.\n'
    + 'Reply with ONLY a strict JSON array of integers, e.g. [12, 18]. No other text.'
  const resp = await fetch(QWEN_BASE + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: QWEN_MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 300, stream: false, temperature: 0.2,
      chat_template_kwargs: { enable_thinking: false },
    }),
  })
  if (!resp.ok) throw new Error('LLM HTTP ' + resp.status)
  const json = await resp.json() as { choices?: { message?: { content?: string } }[] }
  const content = json.choices?.[0]?.message?.content ?? ''
  const m = content.match(/\[[\d\s,]*\]/)
  if (m === null) return []
  try {
    const arr = JSON.parse(m[0]) as unknown
    return Array.isArray(arr) ? arr.filter((x): x is number => typeof x === 'number') : []
  } catch { return [] }
}

async function main(): Promise<void> {
  // 1. 读素材对话（跳过压缩事件），按 turn 分组
  const lines = fs.readFileSync(path.resolve(SRC, 'events.jsonl'), 'utf8').split('\n').filter(Boolean)
  const evs: Ev[] = []
  for (const l of lines) {
    const e = JSON.parse(l) as Ev
    if (e.type.startsWith('compaction/')) continue
    if (!SURFACE_TYPES.has(e.type)) continue
    try { JSON.stringify(e.data ?? {}) } catch { continue }
    evs.push(e)
  }
  const turnOf = (ev: Ev): number => typeof (ev.data as { turn?: unknown } | undefined)?.turn === 'number'
    ? (ev.data as { turn: number }).turn : -1
  const byTurn = new Map<number, Ev[]>()
  for (const ev of evs) {
    const t = turnOf(ev)
    if (t < 1) continue
    if (!byTurn.has(t)) byTurn.set(t, [])
    byTurn.get(t)!.push(ev)
  }
  const turns = [...byTurn.keys()].sort((a, b) => a - b)
  console.log('[30] 素材=' + SRC + ' 事件=' + evs.length + ' turn=' + turns.length + '（' + turns[0] + '..' + turns[turns.length - 1] + '）')

  // 2. 切段：每 SEG_TURNS 轮一段，段内最后 1 轮为标注目标
  const segments: { startTurn: number; endTurn: number; evs: Ev[]; targetReplySeq: number }[] = []
  const perSeg = Math.max(1, Math.floor(turns.length / MAX_SEGMENTS))
  for (let i = 0; i < Math.min(MAX_SEGMENTS, Math.ceil(turns.length / perSeg)); i += 1) {
    const segTurns = turns.slice(i * perSeg, Math.min((i + 1) * perSeg, turns.length))
    if (segTurns.length === 0) continue
    const segEvs = segTurns.flatMap(t => byTurn.get(t) ?? [])
    const lastTurnEvs = byTurn.get(segTurns[segTurns.length - 1]) ?? []
    const targetReplySeq = [...lastTurnEvs].reverse().find(e => e.type === 'assistant/message')?.seq ?? -1
    segments.push({ startTurn: segTurns[0], endTurn: segTurns[segTurns.length - 1], evs: segEvs, targetReplySeq })
  }
  console.log('[30] 分段=' + segments.length + '（每段 ' + perSeg + ' 轮，标注每段最后 1 轮）')

  // 3. 逐段标注（LLM 只看段内内容，tool result 截断）
  const edges: { fromSeq: number; toSeq: number; level: string }[] = []
  const allSeqs = new Set(evs.map(e => e.seq))
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i]
    const text = seg.evs.map(ev => {
      const t = ev.type === 'user/message' ? 'user' : ev.type === 'assistant/message' ? 'assistant' : ev.type === 'tool/call' ? 'tool-call' : 'tool-result'
      return '[seq ' + ev.seq + '] (' + t + ') ' + truncate(eventText(ev), 500)
    }).join('\n')
    console.log('[30] 段#' + (i + 1) + '/' + segments.length + ' turns ' + seg.startTurn + '..' + seg.endTurn
      + ' targetReply=' + seg.targetReplySeq + ' 标注中...')
    let toSeqs: number[] = []
    try { toSeqs = await annotate(text) } catch (err) {
      console.log('[30]  标注失败: ' + (err instanceof Error ? err.message : String(err)))
    }
    const valid = toSeqs.filter(s => Number.isInteger(s) && s < seg.targetReplySeq && allSeqs.has(s))
    for (const s of valid) edges.push({ fromSeq: seg.targetReplySeq, toSeq: s, level: 's' })
    console.log('[30]  标注 cites → ' + valid.length + ' 条（原始 ' + toSeqs.length + '，无效滤掉 ' + (toSeqs.length - valid.length) + '）')
  }

  // 4. 输出边集
  const outPath = path.resolve(SRC, 'annotated-cites.json')
  fs.writeFileSync(outPath, JSON.stringify(edges, null, 2), 'utf8')
  console.log('\n[30] 边集已写 ' + outPath + '（' + edges.length + ' 条边）')
  console.log('[30] 下一步：')
  console.log('  EDGE_SOURCE=clear ARGP_WINDOW_TOKENS=80000 ARGP_RETAIN_TOKENS=16000 node --import ./scripts/ts-import-rewrite-loader.mjs spike/28-simulated-replay.ts ' + SRC)
  console.log('  EDGE_SOURCE=oracle ORACLE_EDGES=' + outPath + ' ARGP_WINDOW_TOKENS=80000 ARGP_RETAIN_TOKENS=16000 node --import ./scripts/ts-import-rewrite-loader.mjs spike/28-simulated-replay.ts ' + SRC)
}

void main()
