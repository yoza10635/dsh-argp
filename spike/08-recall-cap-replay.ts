/**
 * 定点回放：召回散文扫描 cap 的修复前后对比（2026-11-26 补召轮 0/7 根因复盘）。
 *
 * 根因（仪器读数闭环）：headless 补召轮每轮新起进程、arm 配置出口闸关 ⇒
 * `resolveScaledBudgets` 全程未执行 ⇒ `st.resolvedWindowTokens` 保持
 * `session-state.ts` 初始种子 DEFAULT_WINDOW_TOKENS=16,384（与「真解析到 16K」
 * 不可区分），prose 扫描 cap = 16384×2.5061×2.7 ≈ 110,861 —— 与实测指纹逐位吻合。
 * 修复 = `restoreDeclaredWindow` 回填 WeakMap 的同时给会话桶播种声明窗。
 *
 * 本脚本把**真实会话存档**灌进真 Session，走真 `search_history` 工具面：
 *   仪器读数：日志事件数 / request/context 声明值 / 桶读数 / cap 实测页脚 N；
 *   题面派生关键词 × 7 → 行数、首地址、二跳全文；needle 比对在进程内完成，
 *   **只打印 HIT/MISS 与读数，绝不打印金值、查询原文命中片段或会话内容**。
 *
 * 隐私铁律（同 spike/lib/session-corpus.ts）：只读；不落任何会话原文到仓库产物。
 *
 * 用法（BEFORE=修复前跑一遍存 JSON，AFTER=修复后再跑）：
 *   ARGP_REPLAY_SID=session-xxxx ARGP_REPLAY_KEY=<answer_key.json 绝对路径> \
 *   ARGP_REPLAY_OUT=<输出 json> \
 *   node --import ./scripts/ts-import-rewrite-loader.mjs spike/08-recall-cap-replay.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ArgpEngine } from '../src/argp-engine.ts'
import { execTool, toolText } from '../test/tool-execute-shape.ts'
import { defaultSessionRoot, loadRealCorpus, loadSessionEvents } from './lib/session-corpus.ts'

const SID = process.env.ARGP_REPLAY_SID ?? ''
const KEY = process.env.ARGP_REPLAY_KEY ?? ''
const OUT = process.env.ARGP_REPLAY_OUT ?? ''
const ROOT = process.env.ARGP_REPLAY_ROOT ?? defaultSessionRoot()
if (SID === '' || KEY === '') {
  console.error('need ARGP_REPLAY_SID + ARGP_REPLAY_KEY')
  process.exit(2)
}

// 补召七题 ↔ needles（N18..N30）。检索词与判分都用素材核 token（CORE_RE 移植
// score_marathon.cores）：题面派生词（'补偿时限' 等）经 AFTER 全扫描实测证实**不在
// 素材原文**中（rows=0=无匹配而非出界），故定点回放的隔离探针必须用素材字面 token。
// 隐私：token 只在进程内流转，输出仅 id/计数/HIT-MISS，绝不打印 keyword 或正文。
const SUPPL: Array<{ q: string; needle: string }> = [
  { q: 'q3', needle: 'N18' },
  { q: 'q4', needle: 'N20' },
  { q: 'q5', needle: 'N23' },
  { q: 'q6', needle: 'N24' },
  { q: 'q7', needle: 'N25' },
  { q: 'q8', needle: 'N29' },
  { q: 'q9', needle: 'N30' },
]

const CORE_RE = /\b[A-Z]{2,}[-_][A-Za-z0-9-]{3,}\b|\b[0-9A-Fa-f]{6,}\b|\b[a-z][a-z0-9]*(?:-[a-z0-9]+)+\/[a-z][a-z0-9-]*\b|\b\d{4}-\d{2}-\d{2}\b|\bE-\d+\b/g
function cores(v: string): string[] {
  const found = [...new Set(v.match(CORE_RE) ?? [])]
  if (found.length === 0) found.push(...(v.match(/[一-鿿]{2,8}/g) ?? []).slice(0, 3))
  return found.sort((a, b) => b.length - a.length)
}

interface AnswerKey { needles: Array<{ id: string; verbatim: string }> }
const ak: AnswerKey = JSON.parse(fs.readFileSync(KEY, 'utf8'))
const coresOf = new Map(ak.needles.map(n => [n.id, cores(n.verbatim)]))

function findSessionFile(): string {
  const sessions = loadRealCorpus(ROOT).filter(s => s.id.startsWith(SID))
  if (sessions.length === 0) throw new Error('session not found under ' + ROOT + ' for ' + SID)
  if (sessions.length > 1) throw new Error('ambiguous sid prefix ' + SID + ' → ' + sessions.map(s => s.id).join(','))
  return sessions[0]!.file
}

interface Internals {
  bindSession(s: Session): void
  stateOf(s: Session): { resolvedWindowTokens: number; searchIndex: Map<number, unknown> | null }
  declaredContextWindows: WeakMap<Session, number>
}

async function main(): Promise<void> {
  const file = findSessionFile()
  const { events, stats } = loadSessionEvents(file)

  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: 'replay persona' } })
  // 关键：不传 windowTokens/retainTokens——与补召 arm 配置一致（无显式窗、出口闸关）。
  await ctx.plugin(ArgpEngine, { engine: 'factor', recencyGuard: 0 })
  const internals = ctx.compaction as unknown as Internals

  const session = Session.create(SessionId('replay'))
  for (const ev of events) {
    const meta = ev.surfaceOp === undefined ? undefined : { surfaceOp: ev.surfaceOp as never }
    try { session.append(ev.type as never, ev.data as never, meta as never) } catch { /* 个别宿主不接受的中间事件：跳过，不影响散文带 */ }
  }
  internals.bindSession(session)

  const reqCtx = events.filter(e => e.type === 'request/context')
    .map(e => (e.data as { contextWindow?: unknown }).contextWindow)
    .filter(v => typeof v === 'number' && v > 0)
  const declared = internals.declaredContextWindows.get(session) ?? null
  const bucket = internals.stateOf(session).resolvedWindowTokens
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    phase: (process.env.ARGP_REPLAY_PHASE ?? '?'),
    appended: events.length, appendedOk: session.snapshotEvents().length,
    stats: { malformed: stats.malformed, seqGaps: stats.seqGaps, seqDups: stats.seqDups },
    declaredInLog: reqCtx.length > 0 ? reqCtx[reqCtx.length - 1] : null,
    weakMap: declared, bucketWindow: bucket,
  }, null, 1))

  // ---- DIAG：token 在哪类事件里（分类计数，不打印 token/内容/seq 原文） ----
  if (process.env.ARGP_REPLAY_DIAG === '1') {
    const { isProseCandidate, proseTextOf } = await import('../src/factor/prose-scan.ts')
    for (const { q, needle } of SUPPL) {
      const tok = (coresOf.get(needle) ?? [])[0] ?? ''
      if (tok === '') continue
      const low = tok.toLowerCase()
      let inCandidate = 0
      const excludedShapes: string[] = []
      const evs = session.snapshotEvents() as unknown as Array<{ type?: string; data?: unknown; surfaceOp?: unknown }>
      for (let i = 1; i < evs.length; i += 1) {
        const ev = evs[i] as never
        const raw = JSON.stringify((ev as { data?: unknown }).data ?? '').toLowerCase()
        if (!raw.includes(low)) continue
        const cand = isProseCandidate(ev)
        const txt = proseTextOf(ev)
        if (cand && txt !== null && txt.toLowerCase().includes(low)) { inCandidate += 1; continue }
        const d = (ev as { data?: { source?: { kind?: string }, message?: { source?: { kind?: string } } } }).data
        excludedShapes.push([ev.type, (d?.source?.kind ?? d?.message?.source?.kind) ?? '-',
          (ev as { surfaceOp?: { op?: string } }).surfaceOp?.op ?? 'append',
          txt === null ? 'no-text-block' : 'text-but-not-in-projection'].join('/'))
      }
      // eslint-disable-next-line no-console
      console.log('DIAG ' + q + ' inCandidate=' + inCandidate + ' excluded=[' + [...new Set(excludedShapes)].join(' ; ') + ']')
    }
  }

  const rows: Array<Record<string, unknown>> = []
  let turnNo = 100
  for (const { q, needle } of SUPPL) {
    // 每题新 turn：召回预算（字符/次数）per-turn 归零，题间不串账。
    session.append('turn/start', { turn: (turnNo += 1) } as never)
    const rec: Record<string, unknown> = { q, needle }
    const cs = coresOf.get(needle) ?? []
    const kw = cs[0] ?? ''
    const probe = cs[0] ?? ''
    let found = false
    let hopChars = 0
    let totalPages = 0
    let lastCap: number | string = 'full'
    let scanOff = 0
    search_pages: for (let page = 0; page < 8; page += 1) {
      totalPages += 1
      const sArgs: Record<string, unknown> = { keyword: kw }
      if (scanOff > 0) sArgs.offset = scanOff
      const t1 = toolText(await execTool(ctx, { name: 'search_history', callId: 'rq-' + q + '-' + page, agentSession: session, args: sArgs }))
      const win = t1.match(/prose scan page = chars (\d+)–(\d+) of (\d+)/)
      if (win) lastCap = win[2] + '/' + win[3]
      const hitSeqs = [...t1.matchAll(/^- hit=(\d+)/gm)].map(mm => Number(mm[1]))
      // 二跳：逐地址回取全文（含 offset 续读循环）
      for (const seq of hitSeqs.slice(0, 6)) {
        let off = 0
        for (let hp = 0; hp < 24; hp += 1) {
          const args: Record<string, unknown> = { hit: seq }
          if (off > 0) args.offset = off
          const hop = toolText(await execTool(ctx, { name: 'search_history', callId: 'rh-' + q + '-' + seq + '-' + hp, agentSession: session, args }))
          const body = hop.slice(tagEnd(hop))
          hopChars += body.length
          if (probe !== '' && body.includes(probe)) { found = true; break search_pages }
          const ms = [...hop.matchAll(/offset=(\d+)/g)]
          const next = ms.length > 0 ? Number(ms[ms.length - 1]![1]) : NaN // 页脚续读位=最后一个 offset=（头行也带当前 off）
          if (!Number.isFinite(next) || next <= off) break
          off = next
        }
      }
      if (win === null) break // 末页（无截断页脚）
      const nextOff = Number(win[2])
      if (nextOff <= scanOff || nextOff >= Number(win[3])) break
      scanOff = nextOff
    }
    rec.pages = totalPages
    rec.cap = lastCap
    rec.hopChars = hopChars
    rec.result = found ? 'HIT' : 'MISS'
    rows.push(rec)
    // eslint-disable-next-line no-console
    console.log(q + ' needle=' + needle + ' pages=' + totalPages + ' capWin=' + lastCap + ' hopChars=' + hopChars + ' → ' + rec.result)
  }

  const summary = {
    phase: process.env.ARGP_REPLAY_PHASE ?? '?',
    bucketWindow: bucket, weakMap: declared,
    caps: [...new Set(rows.map(r => r.cap))],
    hits: rows.filter(r => r.result === 'HIT').length,
    rows,
  }
  if (OUT !== '') fs.writeFileSync(OUT, JSON.stringify(summary, null, 2))
  // eslint-disable-next-line no-console
  console.log('SUMMARY phase=' + summary.phase + ' hits=' + summary.hits + '/7 bucket=' + bucket + ' caps=' + JSON.stringify(summary.caps))
}

/** 二跳返回里正文起始偏移：跳过 `--- hit=...` 头行（单行头）。 */
function tagEnd(hop: string): number {
  const nl = hop.indexOf('\n')
  return nl < 0 ? 0 : nl + 1
}

main().catch(e => { console.error('replay failed: ' + (e instanceof Error ? e.stack ?? e.message : String(e))); process.exit(1) })
