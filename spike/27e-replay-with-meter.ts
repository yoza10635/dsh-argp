// spike 27c：用真实 events.jsonl 重建 session，直接调 compactIfNeeded
// 验证：真实会话（含 tool/result、argpCites、cites 剥离）下压缩主体是否抛错
// 数据源：26-formal-a-fix（v4 修复后 50 轮完整跑，events.jsonl 有全部事件）
import fs from 'node:fs'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { ArgpGraphEngine } from '../src/argp-graph-engine.ts'

const OUT_DIR = process.argv[2] ?? 'spike/out/26-formal-a-fix-2026-08-22T10-33-30-593Z'

async function makeEngine(): Promise<{ ctx: Context; engine: ArgpGraphEngine }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: 'argp spike27e replay' } })
  await ctx.plugin(TokenMeter)
  await ctx.plugin(ArgpGraphEngine, {
    windowTokens: 80_000, retainTokens: 16_000, minSpanChars: 20, recencyGuard: 0, maxPasses: 16,
  })
  return { ctx, engine: ctx.compaction as ArgpGraphEngine }
}

async function main(): Promise<void> {
  const { engine } = await makeEngine()
  const session = Session.create(SessionId('spike27c-replay'))

  // 重放真实 events.jsonl 到 session（带 surfaceOp 保留）
  const lines = fs.readFileSync(path.resolve(OUT_DIR, 'events.jsonl'), 'utf8').split('\n').filter(Boolean)
  let events = 0
  for (const l of lines) {
    const e = JSON.parse(l)
    // 跳过元事件（turn/start、step/start 等不产生 surface 节点的）
    const SURFACE_TYPES = new Set(['user/message', 'assistant/message', 'assistant/chunk', 'tool/result', 'tool/call'])
    if (!SURFACE_TYPES.has(e.type) && e.type !== 'compaction/start' && e.type !== 'compaction/end' && e.type !== 'compaction/prune') continue
    try {
      session.append(e.type, e.data ?? {}, { surfaceOp: e.surfaceOp ?? 'append' } as never)
      events += 1
    } catch (err) {
      // 某些事件结构 append 可能失败，跳过
      console.log('[replay] skip seq=' + e.seq + ' type=' + e.type + ': ' + (err instanceof Error ? err.message.slice(0, 80) : String(err)))
    }
  }
  console.log('[replay] 重放事件=' + events + ' session.events=' + session.events.length + ' surface.nodes=' + session.surface.nodes.length)

  engine.setSession(session)
  const mt = engine as unknown as {
    measureTokens(s: Session): { contextTokens: number; surfaceTokens: number }
    visibleChars(s: Session): number
  }
  // 诊断：tokenMeter 是否参与（真实跑 spike 26 挂了 ctx.tokenMeter）
  const engAny = engine as unknown as { tokenMeter?: unknown; tokenMeterFn?: unknown }
  console.log('[replay] engine.tokenMeter=' + (engAny.tokenMeter ? '有（dsh tokenMeter）' : '无') + ' tokenMeterFn=' + (engAny.tokenMeterFn ? '有' : '无'))
  let m
  try {
    m = mt.measureTokens(session)
  } catch (err) {
    console.log('[replay] measureTokens 抛错: ' + (err instanceof Error ? err.message : String(err)))
    m = { contextTokens: -1, surfaceTokens: -1 }
  }
  console.log('[replay] 估算 contextTokens=' + m.contextTokens + ' surfaceTokens=' + m.surfaceTokens + ' visibleChars=' + mt.visibleChars(session))

  const agent = { session } as Parameters<ArgpGraphEngine['compactIfNeeded']>[0]
  try {
    const r = await engine.compactIfNeeded(agent, 'pressure', new AbortController().signal)
    console.log('[replay] compactIfNeeded 返回: ' + (r === null ? 'null（skip）' : 'TRIGGERED shadowed=' + r.shadowedSeqs.length + ' tokenCount=' + r.shadowedTokenCount))
    console.log('[replay] records=' + engine.records.length)
  } catch (err) {
    console.error('[replay] compactIfNeeded 抛错:')
    console.error(err instanceof Error ? err.message : String(err))
    if (err instanceof Error && err.stack) console.error(err.stack.split('\n').slice(0, 10).join('\n'))
  }
}

void main()
