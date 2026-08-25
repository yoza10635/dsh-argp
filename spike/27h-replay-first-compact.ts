// spike 27h：零成本验证"真实跑 softCandidateGroups 到底多少 / 正常候选为何枯竭"
// 复用 27c 重放架构，但：
//  ① 截断到第一次 compaction/start 之前（= 真实跑第一次压缩的输入状态）
//  ② 引擎参数对齐 spike 26（windowTokens=80000 / retainTokens=16000 / maxPasses=256，其余默认）
// 不调任何 LLM，纯重放 + 引擎真实逻辑，输出 prune decision（softCandidates / prunedAtoms / 路径）
import fs from 'node:fs'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ArgpGraphEngine } from '../src/argp-graph-engine.ts'

const OUT_DIR = process.argv[2] ?? 'spike/out/26-v4-fix50-2026-08-22T12-49-03-413Z'

async function main(): Promise<void> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: 'argp spike27h replay' } })
  // 对齐 spike 26：windowTokens/retainTokens/maxPasses=256，recencyGuard/turnGuard/minSpanChars 用默认
  await ctx.plugin(ArgpGraphEngine, { windowTokens: 80_000, retainTokens: 16_000, maxPasses: 256 })
  const engine = ctx.compaction as ArgpGraphEngine
  const session = Session.create(SessionId('spike27h-replay'))

  const lines = fs.readFileSync(path.resolve(OUT_DIR, 'events.jsonl'), 'utf8').split('\n').filter(Boolean)
  // 找第一次 compaction/start 的 seq
  let firstCompactSeq = Number.MAX_SAFE_INTEGER
  for (const l of lines) {
    const e = JSON.parse(l)
    if (e.type === 'compaction/start') { firstCompactSeq = e.seq; break }
  }
  const SURFACE_TYPES = new Set(['user/message', 'assistant/message', 'assistant/chunk', 'tool/result', 'tool/call'])
  let events = 0
  for (const l of lines) {
    const e = JSON.parse(l)
    if (e.seq >= firstCompactSeq) break
    if (!SURFACE_TYPES.has(e.type)) continue
    try {
      session.append(e.type, e.data ?? {}, { surfaceOp: e.surfaceOp ?? 'append' } as never)
      events += 1
    } catch { /* skip */ }
  }
  console.log('[27h] 截断到第一次压缩前：firstCompactSeq=' + firstCompactSeq + ' 重放事件=' + events
    + ' surface.nodes=' + session.surface.nodes.length)

  engine.setSession(session)
  const eng = engine as unknown as {
    measureTokens(s: Session): { contextTokens: number; surfaceTokens: number }
    visibleChars(s: Session): number
  }
  let m
  try { m = eng.measureTokens(session) } catch (err) {
    m = { contextTokens: -1, surfaceTokens: -1 }
    console.log('[27h] measureTokens 抛错: ' + (err instanceof Error ? err.message : String(err)))
  }
  console.log('[27h] 估算 contextTokens=' + m.contextTokens + ' visibleChars=' + eng.visibleChars(session))

  const agent = { session } as Parameters<ArgpGraphEngine['compactIfNeeded']>[0]
  try {
    const r = await engine.compactIfNeeded(agent, 'pressure', new AbortController().signal)
    console.log('[27h] compactIfNeeded 返回: ' + (r === null ? 'null（skip，估算未超线）' : 'TRIGGERED shadowed=' + r.shadowedSeqs.length + ' tokenCount=' + r.shadowedTokenCount))
    const rec = engine.records[engine.records.length - 1]
    if (rec !== undefined) {
      console.log('[27h] record: candidates=' + rec.candidates + ' semanticEdges=' + rec.semanticEdges
        + ' prunedAtoms=' + rec.prunedAtoms.length + ' intervals=' + rec.intervals.length
        + ' forced=' + rec.forced + ' chars ' + rec.charsBefore + '→' + rec.charsAfter)
    }
  } catch (err) {
    console.error('[27h] compactIfNeeded 抛错: ' + (err instanceof Error ? err.message : String(err)))
    if (err instanceof Error && err.stack) console.error(err.stack.split('\n').slice(0, 8).join('\n'))
  }
}

void main()
