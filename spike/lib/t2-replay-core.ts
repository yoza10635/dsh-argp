/**
 * T-2 重放核心（spike50 决策重放 / spike51 oracle 判卷共用，防两 harness 漂移）。
 *
 * 收录三件**实测换来的**能力，任何一条改动都必须两个 spike 同步回归：
 *  - pristine 重建：剥 A 引擎痕迹 + 旧归档 error 结果补形（§9.6-15：缺 message.isError
 *    会被现宿主 validateSessionEventData 拒回灌）；
 *  - 变体挂载：因子引擎**直接构造组合根**（§9.6-12：stickyWindowTurns 等名册外键经
 *    plugin config 静默丢失，永远到不了引擎）+ 一会话一套挂载（§9.6-14：FactorLedger
 *    按 rootSeq 跨会话去重，复用挂载会串账）；
 *  - 不剪集交叉校验：独立复算四件套 vs 引擎 plan.hardProtected（spike47 铁律镜像版）。
 *
 * 隐私铁律同 session-corpus.ts：只读；调用方只打印聚合量。
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Atom } from '../../src/argp-types.ts'
import { ArgpGraphEngine } from '../../src/argp-graph-engine.ts'
import { FactorEngine } from '../../src/factor/engine.ts'
import { indexKeys } from '../../src/factor/factor-ledger.ts'
import type { RTagInput } from '../../src/factor/factor-atoms.ts'
import type { RawSessionEvent } from './session-corpus.ts'

// ---------------------------------------------------------------------------
// 语料收集
// ---------------------------------------------------------------------------

export interface Archive { file: string; slug: string }

export function defaultRoots(): string[] {
  return [
    path.join(os.homedir(), '.dsh', 'sessions'),
    path.join(os.homedir(), '.dsh', 'sessions-corpus'),
  ]
}

export function collectArchives(roots: readonly string[]): Archive[] {
  const best = new Map<string, { file: string; v: number }>()
  const walk = (dir: string, depth: number): void => {
    if (depth > 6) return
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) { walk(full, depth + 1); continue }
      const m = /^session\.v(\d+)\.jsonl(\.zstd)?$/.exec(e.name)
      if (m === null) continue
      const dirKey = path.dirname(full)
      const v = Number(m[1])
      const prev = best.get(dirKey)
      if (prev === undefined || v > prev.v) best.set(dirKey, { file: full, v })
    }
  }
  for (const root of roots) walk(root, 0)
  return [...best.entries()]
    .map(([dirKey, x]) => ({
      file: x.file,
      slug: path.basename(dirKey).replace(/^--+|--+$/g, '').slice(0, 48),
    }))
    .sort((a, b) => a.file.localeCompare(b.file))
}

// ---------------------------------------------------------------------------
// pristine 重建
// ---------------------------------------------------------------------------

const KEEP_TYPES = new Set(['system/message', 'user/message', 'assistant/message', 'tool/call', 'tool/result'])

/** argp 自产条目（notice/摘要/U-info 副本/词表 note）——原始流里没有它们。 */
export function isArgpGenerated(e: RawSessionEvent): boolean {
  const d = e.data as Record<string, unknown> | undefined
  if (d === undefined) return false
  const sources = [d['source'], (d['message'] as Record<string, unknown> | undefined)?.['source']]
  return sources.some(s => s !== undefined && (s as { kind?: string }).kind === 'argp')
}

/** 宽化签名的 append（归档事件形与宿主键形的接缝；语义零改动）。
 *  ⚠️ 必须保持方法调用形：把 append 摘成自由函数会丢 this（实测全量
 *  "Cannot read properties of undefined" 静默进 reject 计数）。 */
function appendLoose(session: Session, type: string, data: Record<string, unknown>, options: Record<string, unknown>): void {
  const wide = session as unknown as { append(t: string, d: unknown, o: unknown): void }
  wide.append(type, data, options)
}

export function toPristineSession(events: readonly RawSessionEvent[], slug: string): { session: Session; skipped: Map<string, number> } {
  const session = Session.create(SessionId('t2-' + slug.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 24)))
  const skipped = new Map<string, number>()
  for (const e of events) {
    let why: string | null = null
    if (!KEEP_TYPES.has(e.type)) why = 'type:' + e.type
    else if (e.surfaceOp !== undefined && e.surfaceOp !== 'append') why = 'replace-copy'
    else if (isArgpGenerated(e)) why = 'argp-generated'
    if (why !== null) {
      skipped.set(why, (skipped.get(why) ?? 0) + 1)
      continue
    }
    let data = e.data as Record<string, unknown>
    // 旧宿主错误结果形态补形（§9.6-15）：`data.error` 在场但 message 缺 isError——
    // 现宿主校验 error ⇒ message.isError===true；补齐即现宿主写入形态。
    if (e.type === 'tool/result' && data['error'] !== undefined) {
      const msg = data['message']
      if (msg === undefined || typeof msg !== 'object') {
        skipped.set('broken-error-result', (skipped.get('broken-error-result') ?? 0) + 1)
        continue
      }
      if ((msg as { isError?: boolean }).isError !== true) {
        data = { ...data, message: { ...msg as object, isError: true } }
        skipped.set('repair:isError', (skipped.get('repair:isError') ?? 0) + 1)
      }
    }
    try {
      // surfaceOp 照归档原样回灌：'append' 显式给；缺省（tool/call 的 log-only 形态）不给。
      // append 的键形经宽化别名回灌（归档 type 是 string，宿主签名要 keyof SessionEventMap；
      // 运行时按原样透传，校验拒收走 catch 计数）。
      appendLoose(session, e.type, data, e.surfaceOp === 'append' ? { surfaceOp: 'append' } : {})
    } catch (err) {
      const key = 'append-reject:' + e.type + ':' + String((err as Error).message).slice(0, 40)
      skipped.set(key, (skipped.get(key) ?? 0) + 1)
    }
  }
  return { session, skipped }
}

// ---------------------------------------------------------------------------
// 变体挂载（组合根直构，§9.6-12/-14）
// ---------------------------------------------------------------------------

export interface Mounted { factor: FactorEngine; atomize(session: Session): Atom[]; bind(session: Session): void }

export async function mountVariant(knobs: Record<string, number>): Promise<Mounted> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: 't2 replay persona' } })
  await ctx.plugin(ArgpGraphEngine, { engine: 'factor', windowTokens: 100, retainTokens: 50 } as never)
  const internals = ctx.compaction as unknown as {
    atomize(session: Session): Atom[]
    bindSession(session: Session): void
  }
  const factor = new FactorEngine(internals as never, knobs as never)
  return {
    factor,
    atomize: session => internals.atomize(session),
    bind: session => internals.bindSession(session),
  }
}

// ---------------------------------------------------------------------------
// 不剪集交叉校验
// ---------------------------------------------------------------------------

export interface CrossCheck {
  violations: Array<{ seq: number; why: string }>
  onlyIndependent: number[]
  onlyEngine: number[]
  /** 保护因由组合计数（'focal+openTurn' 等）：保护面归因分解用。 */
  reasonHist: Record<string, number>
  /** seq → 保护因由（供判卷/取证层取单条）。 */
  independent: Map<number, string>
}

/**
 * 独立复算逐条对齐 engine.ts decide() 的 hard 面（178-188）：openTurn / 附件空 R /
 * focal（重放 ⇒ regenerable 恒 undefined ⇒ focalMatch 即硬）/ 已定型 sticky。
 * 判卷以引擎真值为准，两集不等即漂移。
 */
export function crossCheck(
  atoms: readonly Atom[],
  tagsBySeq: ReadonlyMap<number, RTagInput>,
  focalSet: ReadonlySet<string>,
  openTurn: number | null,
  sticky: ReadonlyArray<{ state: string; file: string; errorcode: string }>,
  pruneOrder: readonly number[],
  hardProtected: readonly number[],
): CrossCheck {
  const independent = new Map<number, string>()
  for (const a of atoms) {
    if (a.type !== 'R') continue
    const input = tagsBySeq.get(a.seq)
    if (input === undefined) continue
    const why: string[] = []
    if (openTurn !== null && a.turn >= openTurn) why.push('openTurn')
    if (input.resultText.length === 0) why.push('attachment')
    if (indexKeys(input.tags).some(k => focalSet.has(k))) why.push('focal')
    if (input.tags.errorcodes.length > 0 && input.tags.files.some(f =>
      sticky.some(t => t.state === 'sticky' && t.file === f && input.tags.errorcodes.includes(t.errorcode)))) why.push('sticky')
    if (why.length > 0) independent.set(a.seq, why.join('+'))
  }
  const engineHard = new Set(hardProtected)
  const violations: Array<{ seq: number; why: string }> = []
  for (const seq of pruneOrder) {
    const w = independent.get(seq)
    if (w !== undefined) violations.push({ seq, why: w })
  }
  const reasonHist: Record<string, number> = {}
  for (const why of independent.values()) reasonHist[why] = (reasonHist[why] ?? 0) + 1
  return {
    violations,
    onlyIndependent: [...independent.keys()].filter(s => !engineHard.has(s)).sort((a, b) => a - b),
    onlyEngine: [...engineHard].filter(s => !independent.has(s)).sort((a, b) => a - b),
    reasonHist,
    independent,
  }
}
