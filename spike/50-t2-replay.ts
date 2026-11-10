#!/usr/bin/env node
/**
 * spike 50 — T-2 决策重放（design-2.0 §4.2；P3 第一刀，0 LLM / 0 GPU）。
 *
 * ## 判什么
 *
 * 固定事件流 × factor 引擎变体（base / focal0 / focal2 / sticky0），取**纯决策集**
 * （`FactorEngine.decide()` = 剪序 + 硬保护集，无发射副作用），做单因子归因：
 *  - Δ(pruned) = 旋钮保护面（§4.1 归因边界：机制结论只出自 T-2，行为臂不做归因）；
 *    focal0 多剪的 = 焦点轮保护面；focal2 少剪的 = 第二焦点轮增量保护面；
 *    sticky0 多剪的 = 已定型 sticky 保护面（sweepClosed window=0 ⇒ 全轨即闭）；
 *  - 独立复算"不剪集"与引擎 `plan.hardProtected` **集合相等**交叉校验（spike47 铁律
 *    的镜像版：不复刻闸逻辑判卷，只复刻状态推导并对照真实函数返回）。不一致 =
 *    脚本与引擎漂移，打 `[MISMATCH]`、exit 1，此时所有输出不可信；
 *  - G8 种子：硬保护四件套（openTurn 轮 / 附件空 R / 焦点非再生 / 已定型 sticky）在
 *    归档重放上必须零违例——pruneOrder ∩ 不剪集 = ∅。
 *
 * ## pristine 重建（§4.1："B 引擎吃 A 末态归档不是在线模拟"）
 *
 * 归档里 A 引擎（graph 臂）留下的 replace 副本、compaction/* 事件、source.kind='argp'
 * 的自产条目（notice/摘要/U-info 副本/词表 note）全部剥除，重建**剪枝前原始流**。
 * 重放会话的 seq 是重建后重排的（replace 事件不占位），与归档 seq 无关——指标全部
 * 以重放会话为准。tool/call 照原样回灌（占 log seq 不进 surface，§9.5 实锤同源）。
 * regenerable 恒 undefined（引擎时序纪律：重放批不采快照，engine.ts:107-141）⇒
 * focalNonRegenerable 退化为 focalMatch，与在线 resume 语义一致。
 *
 * ## 预算曲线的取法
 *
 * `planPrune` = 排序前缀取到 target 为止（retention-score.ts），故每变体只跑一次
 * target=∞ 的 decide 拿全量剪序；各预算决策 = 该序列的前缀（离线累加 sizeChars 截断）。
 *
 * ## 隐私铁律（同 spike/lib/session-corpus.ts）
 *
 * 只读；stdout 只打印聚合量与诊断标签；逐会话明细（含标签路径）只落 `spike/out/`
 * （gitignored），仓库内只留聚合量。语料缺失 → 说明后直接退出。
 *
 * ## 用法
 *
 * ```bash
 * npm run t2 -- --limit 20                       # 冒烟：前 20 个达标会话（49 号已被召回归因占用，本件为 50）
 * npm run t2 -- --budgets 8000,30000,100000      # 预算档（chars）
 * npm run t2 -- --roots "C:/custom/dir" --min-turns 8 --verbose
 * ```
 *
 * 默认 roots = `~/.dsh/sessions` + `~/.dsh/sessions-corpus`；每会话目录取最高 vN。
 * 退出码：1 = 不剪集违例或交叉校验漂移；0 = 全绿。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { detectOpenTurn, sessionEvents } from '../src/log-access.ts'
import {
  focalLabels, sessionCwdFromEvents,
  type AtomLike, type EventLike, type RTagInput,
} from '../src/factor/factor-atoms.ts'
import { indexKeys } from '../src/factor/factor-ledger.ts'
import { labelAllowed } from '../src/factor/tag-canonical.ts'
import { classifyUaAtom, planUaSpans, type UaEventProbe } from '../src/factor/ua-input.ts'
import { loadSessionEvents, type RawSessionEvent } from './lib/session-corpus.ts'
import {
  collectArchives, crossCheck, defaultRoots, mountVariant, toPristineSession,
  type Mounted,
} from './lib/t2-replay-core.ts'

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2)
/** `--k=v` 与 `--k v` 两种传法都认（冒烟时只认 `=` 会把 `--limit 12` 吞成全量跑）。 */
function flagOf(name: string): string | undefined {
  const eq = argv.find(a => a.startsWith('--' + name + '='))
  if (eq !== undefined) return eq.slice(name.length + 3)
  const i = argv.indexOf('--' + name)
  return i >= 0 ? argv[i + 1] : undefined
}
const LIMIT = Number(flagOf('limit') ?? '0') // 0 = 不限
const MIN_TURNS = Number(flagOf('min-turns') ?? '4')
const BUDGETS = (flagOf('budgets') ?? '8000,30000,100000').split(',').map(Number)
const OUT_DIR = flagOf('out') ?? path.join('spike', 'out', 't2')
const VERBOSE = argv.includes('--verbose')
const ROOTS = (flagOf('roots') ?? defaultRoots().join(path.delimiter)).split(path.delimiter).filter(r => r !== '')

// 语料收集 / pristine 重建 / 变体挂载 / 交叉校验 → ./lib/t2-replay-core.ts（spike51 共用）

// ---------------------------------------------------------------------------
// 指标工具
// ---------------------------------------------------------------------------

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0
  return sorted[Math.min(sorted.length - 1, Math.round(q * (sorted.length - 1)))] as number
}

function stat(nums: readonly number[]): { p50: number; p90: number; max: number; sum: number } {
  const s = [...nums].sort((a, b) => a - b)
  return { p50: quantile(s, 0.5), p90: quantile(s, 0.9), max: s[s.length - 1] ?? 0, sum: s.reduce((a, b) => a + b, 0) }
}

/** 全量剪序按预算截断（planPrune 前缀语义）。 */
function cutAtBudget(order: readonly number[], charsBySeq: ReadonlyMap<number, number>, target: number): { count: number; chars: number } {
  let chars = 0
  let count = 0
  for (const seq of order) {
    chars += charsBySeq.get(seq) ?? 0
    count += 1
    if (chars >= target) break
  }
  return { count, chars }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

interface VariantSpec { name: string; knobs: Record<string, number | string> }
const VARIANTS: VariantSpec[] = [
  { name: 'base', knobs: {} },
  { name: 'focal0', knobs: { focalTurns: 0 } },
  { name: 'focal2', knobs: { focalTurns: 2 } },
  { name: 'sticky0', knobs: { stickyWindowTurns: 0 } },
  { name: 'tiered', knobs: { focalTiered: 'tiered' } },
]

interface VariantRecord {
  softCount: number
  hardCount: number
  perBudget: Record<string, { count: number; chars: number }>
  violations: number
  onlyIndependent: number[]
  onlyEngine: number[]
  reasonHist: Record<string, number>
}

interface ArchiveRecord {
  slug: string
  file: string
  events: number
  skipped: Record<string, number>
  turns: number
  rAtoms: number
  /** 候选 R 的标签面字符合计（与释放量同尺）。 */
  rChars: number
  variants: Record<string, VariantRecord>
  /** Δ 明细：seq/turn/tool/首个标签（诊断标签，只进 spike/out 不进 stdout/仓库）。
   *  dir='+' = 该变体比 base 多剪（旋钮保护面）；dir='−' = 少剪（focal2 增量保护面）。 */
  details: Record<string, Array<{ seq: number; turn: number; tool: string; label?: string; chars: number; dir: '+' | '−' }>>
  ua: { poolChars: number; spans: number; constraintLines: number; classHist: Record<string, number> }
  /** 贴标 facet 覆盖 = 候选 R 的标签面（G1 口径）。**不是**账本词表：倒排行词=
   *  "已清空项"账（只由被剪入账填充），零 LLM 重放不发射 ⇒ 覆盖恒 0，探渲染/账本皆口径错。
   *  rejected=labelAllowed 对候选键的直接拒数（注入面 G1/T-1 相关）。 */
  tagging: { facet: Record<string, number>; labelKeys: number; rejected: number }
  /** 会话内 sticky 活性：全部活跃轨 / 其中已定型（state='sticky'，硬保护认它）。 */
  stickyActive: number
  stickyHard: number
  /** recallLimit 代理：base 全量剪序（≈整册被剪账本）的 document 标签组大小序列。 */
  labelGroups: number[]
}

function describeSeq(seq: number, inputs: ReadonlyMap<number, RTagInput>): { seq: number; turn: number; tool: string; label?: string; chars: number } {
  const input = inputs.get(seq)
  return {
    seq,
    turn: input?.turn ?? -1,
    tool: input?.tags.tool ?? '?',
    label: input !== undefined && input.tags.files.length > 0 ? 'document:' + (input.tags.files[0] as string)
      : input !== undefined && input.tags.commands.length > 0 ? input.tags.commands[0]
        : input !== undefined && input.tags.errorcodes.length > 0 ? 'errorcode:' + (input.tags.errorcodes[0] as string) : undefined,
    chars: input?.tags.sizeChars ?? 0,
  }
}

async function main(): Promise<void> {
  const archives = collectArchives(ROOTS)
  if (archives.length === 0) {
    console.log('无语料（roots 均缺失/无 session.vN 存档）：' + ROOTS.join(', '))
    return
  }
  const records: ArchiveRecord[] = []
  let drift = false
  let violationsTotal = 0
  let skippedAll = 0
  let decodeFails = 0
  let tooShort = 0

  for (const arc of archives) {
    if (LIMIT > 0 && records.length >= LIMIT) break
    let events: RawSessionEvent[]
    try {
      events = loadSessionEvents(arc.file).events
    } catch (err) {
      decodeFails += 1
      console.log('解码失败（跳过）：' + arc.slug + ' — ' + String((err as Error).message).slice(0, 80))
      continue
    }
    const { session, skipped } = toPristineSession(events, arc.slug)
    for (const n of skipped.values()) skippedAll += n

    // 轮数预筛（挂载前，闲聊会话不吃 4 份挂载）：data.turn 直读；正式口径仍以 atoms 为准
    let turnEstimate = 0
    for (const e of sessionEvents(session) as unknown as EventLike[]) {
      const t = (e.data as { turn?: number } | undefined)?.turn
      if (typeof t === 'number' && t > turnEstimate) turnEstimate = t
    }
    if (turnEstimate < MIN_TURNS) { tooShort += 1; continue }

    // 挂载逐会话重建：FactorLedger 的 observed 集按 rootSeq 去重，跨会话复用会把
    // 不同会话的同名 seq 判为"重放"而抑制观察、sticky 轨跨档累积——账本必须一会话一套。
    const mounts: Record<string, Mounted> = {}
    for (const v of VARIANTS) mounts[v.name] = await mountVariant(v.knobs)

    // 原子面与引擎变体无关（atomize 同源）
    const base = mounts['base'] as Mounted
    const baseAtoms = base.atomize(session)
    const latestTurn = baseAtoms.reduce((m, a) => Math.max(m, a.turn), 0)

    const eventsLike = sessionEvents(session) as unknown as EventLike[]
    const cwd = sessionCwdFromEvents(eventsLike)
    const openTurn = detectOpenTurn(session)

    const rec: ArchiveRecord = {
      slug: arc.slug, file: arc.file, events: events.length,
      skipped: Object.fromEntries(skipped), turns: latestTurn,
      rAtoms: baseAtoms.filter(a => a.type === 'R').length,
      rChars: 0, variants: {}, details: {},
      ua: { poolChars: 0, spans: 0, constraintLines: 0, classHist: {} },
      tagging: { facet: {}, labelKeys: 0, rejected: 0 },
      stickyActive: 0, stickyHard: 0,
      labelGroups: [],
    }

    // 每变体一次 decide(target=∞)：全量剪序 + 硬保护真值
    const inputsByVariant = new Map<string, ReadonlyMap<number, RTagInput>>()
    const orders = new Map<string, number[]>()
    for (const v of VARIANTS) {
      const mounted = mounts[v.name] as Mounted
      mounted.bind(session)
      const decision = mounted.factor.decide(session, Number.MAX_SAFE_INTEGER)
      inputsByVariant.set(v.name, decision.candidates)
      orders.set(v.name, [...decision.plan.pruneOrder])
      const charsBySeq = new Map<number, number>()
      for (const [seq, input] of decision.candidates) charsBySeq.set(seq, input.tags.sizeChars)
      if (v.name === 'base') {
        for (const input of decision.candidates.values()) rec.rChars += input.tags.sizeChars
      }
      const focalSet = focalLabels(baseAtoms as unknown as AtomLike[], latestTurn, Number(v.knobs['focalTurns'] ?? 1), cwd)
      const cc = crossCheck(baseAtoms, decision.tagsBySeq, focalSet, openTurn,
        mounted.factor.ledger.stickyActive(), decision.plan.pruneOrder, decision.plan.hardProtected, v.knobs['focalTiered'] === 'tiered')
      violationsTotal += cc.violations.length
      if (cc.onlyIndependent.length + cc.onlyEngine.length > 0) {
        drift = true
        console.log('[MISMATCH] ' + arc.slug + '/' + v.name
          + ' 仅独立复算=' + cc.onlyIndependent.length + ' 仅引擎=' + cc.onlyEngine.length
          + ' —— 脚本与引擎漂移，本会话输出不可信')
      }
      const perBudget: Record<string, { count: number; chars: number }> = {}
      for (const b of BUDGETS) perBudget[String(b)] = cutAtBudget(decision.plan.pruneOrder, charsBySeq, b)
      rec.variants[v.name] = {
        softCount: decision.plan.pruneOrder.length,
        hardCount: decision.plan.hardProtected.length,
        perBudget,
        violations: cc.violations.length,
        onlyIndependent: cc.onlyIndependent.slice(0, 20),
        onlyEngine: cc.onlyEngine.slice(0, 20),
        reasonHist: cc.reasonHist,
      }
    }

    // Δ 决策集明细：extra = 变体比 base 多剪（旋钮保护面）；less = 少剪（focal2 增量保护面）
    const baseOrder = new Set(orders.get('base') ?? [])
    for (const v of VARIANTS) {
      if (v.name === 'base') continue
      const s = new Set(orders.get(v.name) ?? [])
      const extra = [...s].filter(x => !baseOrder.has(x))
      const less = [...baseOrder].filter(x => !s.has(x))
      const inputs = v.name === 'base'
        ? (inputsByVariant.get('base') as ReadonlyMap<number, RTagInput>)
        : (inputsByVariant.get(v.name) as ReadonlyMap<number, RTagInput>)
      rec.details[v.name] = [
        ...extra.map(seq => ({ ...describeSeq(seq, inputs), dir: '+' as const })),
        ...less.map(seq => ({ ...describeSeq(seq, inputsByVariant.get('base') as ReadonlyMap<number, RTagInput>), dir: '−' as const })),
      ]
    }

    // UA 规划重放（纯函数层；A 永不剪 ⇒ 与剪枝决策解耦，跑 base 焦点档一次）
    {
      const probe = (seq: number): UaEventProbe => {
        const d = (sessionEvents(session)[seq]?.data ?? {}) as Record<string, unknown>
        const src = (d['source'] ?? (d['message'] as Record<string, unknown> | undefined)?.['source']) as { form?: string } | undefined
        const raw = Array.isArray(d['content']) ? d['content']
          : Array.isArray((d['message'] as Record<string, unknown> | undefined)?.['content'])
            ? ((d['message'] as Record<string, unknown>)['content'] as unknown[]) : []
        const attachment = raw.some(b => {
          const t = (b as { type?: string } | undefined)?.type
          return t === 'image' || t === 'file'
        })
        return { form: typeof src?.form === 'string' ? src.form : undefined, attachment }
      }
      const plan = planUaSpans(baseAtoms, {
        probe, openTurn, protectFromTurn: latestTurn > 0 ? latestTurn : null, watermark: session.seq,
      })
      const classHist: Record<string, number> = {}
      for (const a of baseAtoms) {
        const c = classifyUaAtom(a, probe(a.seq))
        classHist[c] = (classHist[c] ?? 0) + 1
      }
      rec.ua = { poolChars: plan.poolChars, spans: plan.spans.length, constraintLines: plan.constraintLines.length, classHist }
    }

    // 贴标 facet 覆盖（候选标签面 = G1 口径）+ labelAllowed 直判拒数 + 会话内 sticky 活性
    {
      const inputs = inputsByVariant.get('base') as ReadonlyMap<number, RTagInput>
      const facet: Record<string, number> = { document: 0, command: 0, errorcode: 0 }
      let labelKeys = 0
      let rejected = 0
      for (const input of inputs.values()) {
        if (input.tags.files.length > 0) facet.document = (facet.document ?? 0) + 1
        if (input.tags.commands.length > 0) facet.command = (facet.command ?? 0) + 1
        if (input.tags.errorcodes.length > 0) facet.errorcode = (facet.errorcode ?? 0) + 1
        for (const k of indexKeys(input.tags)) {
          labelKeys += 1
          if (labelAllowed(k) !== null) rejected += 1
        }
      }
      rec.tagging = { facet, labelKeys, rejected }
      const sticky = base.factor.ledger.stickyActive()
      rec.stickyActive = sticky.length
      rec.stickyHard = sticky.filter(t => t.state === 'sticky').length
    }

    // recallLimit 代理：base 全量剪序（在线=整册被剪账本）的 document 标签组大小分布
    {
      const inputs = inputsByVariant.get('base') as ReadonlyMap<number, RTagInput>
      const groups = new Map<string, number>()
      for (const seq of orders.get('base') ?? []) {
        const file = inputs.get(seq)?.tags.files[0]
        if (file === undefined) continue
        groups.set(file, (groups.get(file) ?? 0) + 1)
      }
      for (const g of groups.values()) rec.labelGroups.push(g)
    }

    records.push(rec)
    const baseVar = rec.variants['base'] as VariantRecord
    console.log(
      '· ' + arc.slug.padEnd(26) + ' turns=' + String(latestTurn).padStart(3)
      + ' R=' + String(rec.rAtoms).padStart(4)
      + ' 软可剪=' + String(baseVar.softCount).padStart(4)
      + ' 硬护=' + String(baseVar.hardCount).padStart(3)
      + ' 剪@30K=' + String(baseVar.perBudget['30000']?.count ?? 0).padStart(4)
      + ' 违例=' + baseVar.violations
      + (VERBOSE ? ' 剥除=' + JSON.stringify(rec.skipped) : ''),
    )
  }

  if (records.length === 0) {
    console.log('无达标会话（解码失败 ' + decodeFails + '，轮数不足 ' + tooShort + '）')
    return
  }
  const agg = aggregate(records)
  const stamp = new Date().toISOString().slice(0, 10)
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const outFile = path.join(OUT_DIR, 't2-detail-' + stamp + '.json')
  fs.writeFileSync(outFile, JSON.stringify({ stamp, budgets: BUDGETS, aggregates: agg, records }, null, 1))

  console.log('\n=== T-2 聚合（达标会话 ' + records.length + '，解码失败 ' + decodeFails + '，轮数不足 ' + tooShort + '，剥除非原始事件 ' + skippedAll + '）===')
  console.log(JSON.stringify(agg, null, 1))
  console.log('\n明细（含标签路径，只落 spike/out，勿入库）：' + outFile)
  if (violationsTotal > 0 || drift) {
    console.log('\n判读：硬保护违例 ' + violationsTotal + ' / 漂移=' + drift + ' —— 不剪集非全绿，T-2 数据不可信，先修因再跑分')
    process.exitCode = 1
  } else {
    console.log('\n判读：不剪集全绿（G8 种子在真实归档上成立）；机制归因看 deltas')
  }
}

function aggregate(records: readonly ArchiveRecord[]): Record<string, unknown> {
  const names = Object.keys((records[0]?.variants ?? {}))
  const perVariant: Record<string, Record<string, unknown>> = {}
  for (const v of names) {
    perVariant[v] = {}
    for (const b of BUDGETS) {
      const key = String(b)
      perVariant[v]![key] = {
        cutCount: stat(records.map(r => r.variants[v]?.perBudget[key]?.count ?? 0)),
        charsSharePct: stat(records.map(r => {
          const chars = r.variants[v]?.perBudget[key]?.chars ?? 0
          return r.rChars > 0 ? Number(((100 * chars) / r.rChars).toFixed(1)) : 0
        })),
      }
    }
  }
  const countOf = (v: string): { extra: number; less: number; nonzeroArchives: number } => {
    const ds = records.flatMap(r => r.details[v] ?? [])
    return {
      extra: ds.filter(d => d.dir === '+').length,
      less: ds.filter(d => d.dir === '−').length,
      nonzeroArchives: records.filter(r => (r.details[v] ?? []).length > 0).length,
    }
  }
  const labelGroups = records.flatMap(r => r.labelGroups)
  return {
    archives: records.length,
    perVariant,
    deltaCounts: {
      focal0: countOf('focal0'), focal2: countOf('focal2'), sticky0: countOf('sticky0'),
      note: 'extra=变体比 base 多剪（旋钮保护面，focal0/sticky0 期望>0）；less=少剪（focal2 期望>0）',
    },
    uaPool: {
      ...stat(records.map(r => r.ua.poolChars)),
      over40k: records.filter(r => r.ua.poolChars > 40000).length,
      spansP50: stat(records.map(r => r.ua.spans)).p50,
      constraintLinesP50: stat(records.map(r => r.ua.constraintLines)).p50,
    },
    recallLimitProxy: (() => {
      const gs = [...labelGroups].sort((a, b) => a - b)
      const over = (k: number): number => gs.filter(g => g > k).length
      return {
        docLabelGroups: gs.length,
        groupSize: stat(gs),
        shareOver5Pct: gs.length > 0 ? Number(((100 * over(5)) / gs.length).toFixed(1)) : 0,
        shareOver20Pct: gs.length > 0 ? Number(((100 * over(20)) / gs.length).toFixed(1)) : 0,
      }
    })(),
    taggingCoverageArchives: Object.fromEntries(['document', 'command', 'errorcode']
      .map(f => [f, records.filter(r => (r.tagging.facet[f] ?? 0) > 0).length])),
    taggingLabelKeysTotal: records.reduce((m, r) => m + r.tagging.labelKeys, 0),
    taggingRejectedTotal: records.reduce((m, r) => m + r.tagging.rejected, 0),
    stickyActiveArchives: records.filter(r => r.stickyActive > 0).length,
    stickyTracksTotal: records.reduce((m, r) => m + r.stickyActive, 0),
    stickyHardTracksTotal: records.reduce((m, r) => m + r.stickyHard, 0),
    stickyHardArchives: records.filter(r => r.stickyHard > 0).length,
    hardProtectedP50: stat(records.map(r => r.variants['base']?.hardCount ?? 0)).p50,
    baseProtectionReasons: (() => {
      const hist: Record<string, number> = {}
      for (const r of records) for (const [k, n] of Object.entries(r.variants['base']?.reasonHist ?? {})) hist[k] = (hist[k] ?? 0) + n
      return hist
    })(),
    violationsTotal: records.reduce((m, r) => m + Object.values(r.variants).reduce((k, v) => k + v.violations, 0), 0),
  }
}

main().catch(err => {
  console.error(err)
  process.exitCode = 1
})
