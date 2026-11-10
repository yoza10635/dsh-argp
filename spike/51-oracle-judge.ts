#!/usr/bin/env node
/**
 * spike 51 — T-2 oracle 判卷（design-2.0 §4.2 的"判卷"半边：决策集逐条 oracle）。
 *
 * ## 判什么
 *
 * spike50 给出"引擎保了谁/剪了谁"；本件回答**该不该**：
 *  ① 确定性信号（全量零成本）：reReadLater=后续成功读了同文件（内容被再次需要）；
 *     mentionLater=后续 U/A 文本提到同文件路径；kindLater=同 command/errorcode 再现；
 *  ② LLM judge（本地端点分层抽样）：给"工具+参数+结果节选+后续对话片段"判
 *     keep/prune/unsure——**出题不含信号与保护因由**（防锚定），两路对表才谈可信；
 *  ③ focal 触发 facet 分层：每个 focal 保护原子标注命中的 facet 集
 *     （document/command/errorcode/scope），keep 率按主 facet 分列——直接检验
 *     "文件路径焦点 > 命令/工具焦点"的分级假设（用户 2026-11-10 提出）。
 *
 * ## 判卷纪律
 *
 * 控制组=base 决策剪掉的 @cut 前缀：judge 若对控制组大面积说 keep ⇒ judge 不可信，
 * 本轮数据整体作废；稳定性抽检=focal:document 层前 20 条重判报一致率；judge 输出
 * 必须 ∈ {keep,prune,unsure}，解析失败重试一次后记 parse-fail（不计票）。
 * 隐私：原文只进本地端点（127.0.0.1）；stdout 只聚合量；明细落 spike/out/（gitignored）。
 *
 * ## 用法
 *
 * ```bash
 * npm run oracle -- --no-judge             # 只跑确定性信号（全量，零 GPU）
 * npm run oracle -- --judge-per 25         # 每层至多 25 条进 judge
 * npm run oracle -- --limit 10 --judge-per 8
 * ```
 *
 * LLM 通道 = ARGP_ITEST_LLM（缺省 http://127.0.0.1:1234/v1，同 test:live）；
 * 模型缺省取 /v1/models 首个，可 ARGP_JUDGE_MODEL 覆盖。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { detectOpenTurn, sessionEvents } from '../src/log-access.ts'
import {
  focalLabels, sessionCwdFromEvents,
  type AtomLike, type EventLike, type RTagInput,
} from '../src/factor/factor-atoms.ts'
import { indexKeys } from '../src/factor/factor-ledger.ts'
import { loadSessionEvents } from './lib/session-corpus.ts'
import {
  collectArchives, crossCheck, defaultRoots, mountVariant, toPristineSession,
} from './lib/t2-replay-core.ts'

const argv = process.argv.slice(2)
function flagOf(name: string): string | undefined {
  const eq = argv.find(a => a.startsWith('--' + name + '='))
  if (eq !== undefined) return eq.slice(name.length + 3)
  const i = argv.indexOf('--' + name)
  return i >= 0 ? argv[i + 1] : undefined
}
const LIMIT = Number(flagOf('limit') ?? '0') // 达标档案数上限，0=不限
const MIN_TURNS = Number(flagOf('min-turns') ?? '4')
const JUDGE_PER = Number(flagOf('judge-per') ?? '25')
const NO_JUDGE = argv.includes('--no-judge')
const CUT_CHARS = Number(flagOf('cut') ?? '30000')
const OUT_DIR = flagOf('out') ?? path.join('spike', 'out', 't2')
const ROOTS = (flagOf('roots') ?? defaultRoots().join(path.delimiter)).split(path.delimiter).filter(r => r !== '')
const LLM_BASE = process.env.ARGP_ITEST_LLM ?? 'http://127.0.0.1:1234/v1'

// ---------------------------------------------------------------------------
// 条目模型
// ---------------------------------------------------------------------------

type Facet = 'document' | 'command' | 'errorcode' | 'scope'
/** 分级假设的先验序（用户 2026-11-10）：文件路径 > 错误码 ≈ 命令族 > 目录域。 */
const FACET_RANK: Facet[] = ['document', 'errorcode', 'command', 'scope']

interface Item {
  key: string
  seq: number
  turn: number
  tool: string
  label: string | undefined
  argsText: string
  chars: number
  /** 保护因由（crossCheck 独立复算口径）；控制组=''。 */
  why: string
  focalFacets: Facet[]
  stratum: string
  signals: { reReadLater: boolean; mentionLater: boolean; kindLater: boolean }
  /** judge 出题原料（skip 层不留）。 */
  resultText: string
  laterText: string
}

function facetOfKey(k: string): Facet | null {
  if (k.startsWith('document:')) return 'document'
  if (k.startsWith('errorcode:')) return 'errorcode'
  if (k.startsWith('command:')) return 'command'
  if (k.startsWith('scope:')) return 'scope'
  return null
}

function stratumOf(why: string, focalFacets: Facet[]): string {
  if (why === '') return 'control_pruned'
  const parts = why.split('+')
  // 结构性保护（附件不可 stub / 未闭合轮协议现场）不由"被需要性"裁决，跳过。
  if (parts.includes('openTurn') || parts.includes('attachment')) return 'skip_structural'
  if (parts.includes('focal')) {
    const top = FACET_RANK.find(f => focalFacets.includes(f)) ?? 'scope'
    return 'focal:' + top
  }
  if (parts.includes('sticky')) return 'sticky'
  return 'skip_other'
}

const JUDGEABLE = (s: string): boolean => s !== 'skip_structural' && s !== 'skip_other'

function eventTextOf(e: EventLike): string {
  const d = (e.data ?? {}) as Record<string, unknown>
  const blocks = Array.isArray(d['content']) ? d['content'] as unknown[]
    : Array.isArray((d['message'] as Record<string, unknown> | undefined)?.['content'])
      ? ((d['message'] as Record<string, unknown>)['content'] as unknown[]) : []
  return blocks.filter(b => (b as { type?: string }).type === 'text')
    .map(b => String((b as { text?: unknown }).text ?? '')).join('\n')
}

// ---------------------------------------------------------------------------
// LLM judge
// ---------------------------------------------------------------------------

interface JudgeResult { verdict: 'keep' | 'prune' | 'unsure'; evidence: string; reason: string }
type JudgeOutcome = JudgeResult | 'parse-fail'

let modelCache: string | null = null
async function judgeModel(): Promise<string> {
  if (modelCache !== null) return modelCache
  const env = process.env.ARGP_JUDGE_MODEL
  if (env !== undefined && env !== '') { modelCache = env; return modelCache }
  const res = await fetch(LLM_BASE + '/models', { signal: AbortSignal.timeout(8000) })
  const body = await res.json() as { data?: Array<{ id: string }> }
  const first = body.data?.[0]?.id
  if (first === undefined) throw new Error('端点无模型可取：' + LLM_BASE)
  modelCache = first
  return first
}

/**
 * 证据优先出题（校准门实锤后的形态）：初版"还被需要吗"式开放题在控制组
 * keep 66.7% 且 7/12 无 trace ⇒ yes-bias 压不住，判卷作废重出。现题：
 * prune 为缺省、keep 必须引用后续原文当证据（引不出=prune）。
 */
function judgePrompt(it: Item): string {
  const head = it.resultText.slice(0, 350)
  const tail = it.resultText.length > 550 ? '\n…（中略）…\n' + it.resultText.slice(-150) : ''
  return [
    '你在审计对话压缩的保留决策：某工具调用刚结束时被问"这个结果以后还用得上吗"。',
    '**基率：绝大多数工具结果之后再未被引用——prune 是缺省答案。keep 必须举证**：',
    '在【后续对话】里找到依赖它的具体证据并摘录（≤30字），三种才算证据：',
    '① 重新读取/查询了同一对象；② 引用/改写了该结果里的具体内容；③ 继续对同一对象做后续操作。',
    '摘不出证据就答 prune。若证据疑似存在但被截断看不到全文，才允许 unsure。',
    `【工具】${it.tool} ${(it.argsText || '（参数不可得）').slice(0, 160)}`,
    `【结果节选】${head}${tail}`,
    `【后续对话（最多1600字）】\n${it.laterText.slice(0, 1600) || '（无后续——这是会话尾部，直接 prune）'}`,
    '输出 JSON：{"verdict":"keep|prune|unsure","evidence":"后续原文摘录，prune 时为空串","reason":"不超过15字"}',
  ].join('\n')
}

/**
 * 两两对比判卷（绝对题在两个模型上都被 yes-bias 打平：控制组 keep 50–75%、
 * 分层间无差 ⇒ 绝对题不可信，改相对排序——yes-bias 对 A/B 等强，成对差分抵消）。
 * 校准门：focal 层对控制组的胜率 ≥60% 才有判别力，否则 judge 整轮弃用。
 */
interface PairOutcome { choice: 'A' | 'B' | 'similar'; evidence: string }

function pairPrompt(a: Item, b: Item, sharedLater: string): string {
  const brief = (tag: string, it: Item): string =>
    `【${tag}】${it.tool} ${(it.argsText || it.label || '').slice(0, 120)}\n结果节选：${(it.resultText.slice(0, 260) || '（空）').replace(/\n/g, ' ')}`
  return [
    '同一会话里有两个先后发生的工具调用结果（A 与 B）。按后续对话的实际走向判断：',
    '**哪一个的内容之后更被需要**（被重读/被引用/在其上继续操作）？',
    brief('A', a),
    brief('B', b),
    `【两者的后续对话（共享，最多1600字）】\n${sharedLater.slice(0, 1600) || '（无后续）'}`,
    '输出 JSON：{"choice":"A|B|similar","evidence":"后续原文摘录≤30字"}',
  ].join('\n')
}

async function judgePairOnce(prompt: string): Promise<PairOutcome | 'parse-fail'> {
  const model = await judgeModel()
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const res = await fetch(LLM_BASE + '/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model, temperature: 0.1,
          messages: [
            { role: 'system', content: '你是对话压缩审计员。只输出一个 JSON 对象。' },
            { role: 'user', content: prompt },
          ],
        }),
        signal: AbortSignal.timeout(60_000),
      })
      const body = await res.json() as { choices?: Array<{ message?: { content?: string } }> }
      const raw = body.choices?.[0]?.message?.content ?? ''
      const m = /\{[^{}]*"choice"[^{}]*\}/.exec(raw)
      if (m === null) continue
      const v = JSON.parse(m[0]) as { choice?: string; evidence?: string }
      if (v.choice === 'A' || v.choice === 'B' || v.choice === 'similar') {
        return { choice: v.choice, evidence: String(v.evidence ?? '').slice(0, 60) }
      }
    } catch { /* 重试一次 */ }
  }
  return 'parse-fail'
}

async function judgeOnce(prompt: string): Promise<JudgeOutcome> {
  const model = await judgeModel()
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const res = await fetch(LLM_BASE + '/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model, temperature: 0.1,
          messages: [
            { role: 'system', content: '你是对话压缩保留决策的评审员。只输出一个 JSON 对象，不要解释、不要代码块。' },
            { role: 'user', content: prompt },
          ],
        }),
        signal: AbortSignal.timeout(60_000),
      })
      const body = await res.json() as { choices?: Array<{ message?: { content?: string } }> }
      const raw = body.choices?.[0]?.message?.content ?? ''
      const m = /\{[^{}]*"verdict"[^{}]*\}/.exec(raw)
      if (m === null) continue
      const v = JSON.parse(m[0]) as { verdict?: string; evidence?: string; reason?: string }
      if (v.verdict === 'keep' || v.verdict === 'prune' || v.verdict === 'unsure') {
        // 纪律执行：keep 却没带证据 ⇒ 降为 unsure（yes-bias 的硬闸门）
        const evidence = String(v.evidence ?? '').slice(0, 60)
        const verdict = v.verdict === 'keep' && evidence === '' ? 'unsure' as const : v.verdict
        return { verdict, evidence, reason: String(v.reason ?? '').slice(0, 60) }
      }
    } catch { /* 网络/解析抖动 → 重试一次 */ }
  }
  return 'parse-fail'
}

// ---------------------------------------------------------------------------
// 重放 + 条目收集（与 spike50 同核心：lib/t2-replay-core）
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const archives = collectArchives(ROOTS)
  if (archives.length === 0) { console.log('无语料：' + ROOTS.join(', ')); return }

  const items: Item[] = []
  let doneArchives = 0

  for (const arc of archives) {
    if (LIMIT > 0 && doneArchives >= LIMIT) break
    let events
    try { events = loadSessionEvents(arc.file).events } catch { continue }
    const { session } = toPristineSession(events, arc.slug)
    const eventsLike = sessionEvents(session) as unknown as EventLike[]
    let turnEstimate = 0
    for (const e of eventsLike) {
      const t = (e.data as { turn?: number } | undefined)?.turn
      if (typeof t === 'number' && t > turnEstimate) turnEstimate = t
    }
    if (turnEstimate < MIN_TURNS) continue
    doneArchives += 1

    const mounted = await mountVariant({})
    mounted.bind(session)
    const atoms = mounted.atomize(session)
    const latestTurn = atoms.reduce((m, a) => Math.max(m, a.turn), 0)
    const decision = mounted.factor.decide(session, Number.MAX_SAFE_INTEGER)
    const cwd = sessionCwdFromEvents(eventsLike)
    const openTurn = detectOpenTurn(session)
    const focalSet = focalLabels(atoms as unknown as AtomLike[], latestTurn, 1, cwd)
    const cc = crossCheck(atoms, decision.tagsBySeq, focalSet, openTurn,
      mounted.factor.ledger.stickyActive(), decision.plan.pruneOrder, decision.plan.hardProtected)

    // args 索引（tool/call 事件按 callId）与后续文本面
    const argsByCallId = new Map<string, string>()
    const texts: Array<{ seq: number; turn: number; text: string }> = []
    for (const e of eventsLike) {
      if (e.type === 'tool/call') {
        const d = (e.data ?? {}) as { callId?: string; arguments?: unknown }
        if (typeof d.callId === 'string') {
          argsByCallId.set(d.callId, typeof d.arguments === 'string' ? d.arguments : JSON.stringify(d.arguments ?? ''))
        }
      } else if (e.type === 'user/message' || e.type === 'assistant/message') {
        const t = eventTextOf(e)
        if (t !== '') texts.push({ seq: e.seq, turn: (e.data as { turn?: number } | undefined)?.turn ?? 0, text: t })
      }
    }

    // mention 判据（探针实锤）：会话正文提文件用**相对路径/短名**（src/main.js），
    // tags.files 是规范化绝对路径——直匹恒 0。两形匹配：全路径 或 去 cwd 前缀的
    // 相对形（分隔符/大小写归一）；basename 单匹假阳高，不用。
    const pathNorm = (p: string): string => p.toLowerCase().replace(/\\/g, '/')
    const cwdNorm = cwd !== undefined ? pathNorm(cwd).replace(/\/+$/, '') : null
    const mentionsFile = (text: string, file: string): boolean => {
      const t = pathNorm(text)
      const full = pathNorm(file)
      if (t.includes(full)) return true
      if (cwdNorm !== null && full.startsWith(cwdNorm + '/')) {
        const rel = full.slice(cwdNorm.length + 1)
        return rel.length > 5 && t.includes(rel)
      }
      return false
    }
    const mk = (seq: number, why: string, input: RTagInput): void => {
      const keys = indexKeys(input.tags)
      const focalFacets = [...new Set(keys
        .filter(k => focalSet.has(k))
        .map(facetOfKey)
        .filter((f): f is Facet => f !== null))]
      const label = input.tags.files[0] !== undefined ? 'document:' + input.tags.files[0]
        : input.tags.commands[0] ?? (input.tags.errorcodes[0] !== undefined ? 'errorcode:' + input.tags.errorcodes[0] : undefined)
      const laterRs = [...decision.tagsBySeq.values()].filter(x => x.seq > seq)
      const files = input.tags.files
      const signals = {
        reReadLater: files.length > 0 && laterRs.some(x =>
          (x.tool === 'read' || x.tool === 'view') && x.tags.files.some(f => files.includes(f))),
        mentionLater: files.length > 0 && texts.some(x => x.seq > seq
          && files.some(f => mentionsFile(x.text, f))),
        kindLater: input.tags.commands.length > 0
          ? laterRs.some(x => x.tags.commands.some(c => input.tags.commands.includes(c)))
          : input.tags.errorcodes.length > 0
            ? laterRs.some(x => x.tags.errorcodes.some(c => input.tags.errorcodes.includes(c)))
            : false,
      }
      const stratum = stratumOf(why, focalFacets)
      if (!JUDGEABLE(stratum)) return
      items.push({
        key: arc.slug + '|s' + seq, seq, turn: input.turn, tool: input.tool, label,
        argsText: input.callId !== undefined ? argsByCallId.get(input.callId) ?? '' : '',
        chars: input.tags.sizeChars, why, focalFacets, stratum, signals,
        resultText: input.resultText,
        laterText: texts.filter(x => x.seq > seq && x.turn >= input.turn)
          .map(x => `[T${x.turn}] ${x.text}`).join('\n'),
      })
    }

    for (const [seq, why] of cc.independent) {
      const input = decision.tagsBySeq.get(seq)
      if (input !== undefined) mk(seq, why, input)
    }
    let acc = 0
    for (const seq of decision.plan.pruneOrder) {
      const input = decision.tagsBySeq.get(seq)
      if (input === undefined) continue
      acc += input.tags.sizeChars
      if (acc > CUT_CHARS) break
      mk(seq, '', input)
    }
    process.stdout.write('· ' + arc.slug.padEnd(26) + ' 条目累计=' + items.length + '\n')
  }

  // ---- 分层（确定性 stride 抽样） ----
  const byStratum = new Map<string, Item[]>()
  for (const it of items) {
    const arr = byStratum.get(it.stratum) ?? []
    arr.push(it)
    byStratum.set(it.stratum, arr)
  }
  const sampled: Item[] = []
  if (!NO_JUDGE) {
    for (const [, arr] of byStratum) {
      const per = Math.min(arr.length, JUDGE_PER)
      const stride = per > 0 ? Math.max(1, Math.floor(arr.length / per)) : arr.length + 1
      for (let i = 0; i < arr.length && sampled.filter(s => s.stratum === arr[i]!.stratum).length < per; i += stride) {
        sampled.push(arr[i] as Item)
      }
    }
  }

  // ---- judge ----
  const judged: Array<{ key: string; stratum: string; tool: string; label?: string; chars: number; signals: Item['signals']; judge: JudgeOutcome }> = []
  let stabilityPct: number | null = null
  if (sampled.length > 0) {
    console.log('\njudge ' + sampled.length + ' 条 → ' + LLM_BASE)
    const results = new Map<string, JudgeOutcome>()
    let n = 0
    for (const it of sampled) {
      const r = await judgeOnce(judgePrompt(it))
      results.set(it.key, r)
      judged.push({ key: it.key, stratum: it.stratum, tool: it.tool, label: it.label, chars: it.chars, signals: it.signals, judge: r })
      n += 1
      if (n % 20 === 0) process.stdout.write('  judged ' + n + '/' + sampled.length + '\n')
    }
    // 稳定性抽检：focal:document 前 20 条重判
    const stab = sampled.filter(i => i.stratum === 'focal:document').slice(0, 20)
    let agree = 0
    for (const it of stab) {
      const again = await judgeOnce(judgePrompt(it))
      const first = results.get(it.key)
      if (again !== 'parse-fail' && first !== undefined && first !== 'parse-fail' && again.verdict === first.verdict) agree += 1
    }
    stabilityPct = stab.length > 0 ? Math.round(100 * agree / stab.length) : null
    console.log('稳定性抽检 n=' + stab.length + ' 一致率=' + (stabilityPct ?? '-') + '%')
  }

  // ---- 两两对比判卷（focal/sticky 层 vs 同档控制组；胜率≥60% 才过判别力门） ----
  const pairPer = Number(flagOf('pair-per') ?? '0')
  const pairStats: Record<string, { pairs: number; win: number; similar: number; lose: number; winRatePct: number; parseFail: number }> = {}
  const pairDetail: Array<Record<string, unknown>> = []
  if (pairPer > 0) {
    const doSwap = argv.includes('--pair-swap')
    console.log('\npair 判卷 ' + pairPer + '/层 → ' + LLM_BASE + (doSwap ? '（含换位一致检查）' : ''))
    for (const strat of ['focal:document', 'focal:errorcode', 'sticky']) {
      let swapAgree = 0
      let swapN = 0
      const arr = byStratum.get(strat) ?? []
      const control = byStratum.get('control_pruned') ?? []
      const used = new Set<string>()
      let win = 0
      let sim = 0
      let lose = 0
      let pf = 0
      let n = 0
      for (const a of arr) {
        if (n >= pairPer) break
        const slug = a.key.split('|')[0]
        const mates = control.filter(c => c.key.split('|')[0] === slug && !used.has(c.key))
        if (mates.length === 0) continue
        const b = mates[(n * 3 + arr.indexOf(a)) % mates.length] as Item
        used.add(b.key)
        n += 1
        const shared = a.seq <= b.seq ? a.laterText : b.laterText
        const r = await judgePairOnce(pairPrompt(a, b, shared))
        pairDetail.push({ stratum: strat, aKey: a.key, bKey: b.key, aLabel: a.label, bLabel: b.label, r })
        if (r === 'parse-fail') pf += 1
        else if (r.choice === 'A') win += 1
        else if (r.choice === 'similar') sim += 1
        else lose += 1
        if (doSwap) {
          // 换位一致：A/B 角色互换后应选同一实物（A↔B 翻转或同 similar）
          swapN += 1
          const rs = await judgePairOnce(pairPrompt(b, a, shared))
          if (rs !== 'parse-fail' && r !== 'parse-fail') {
            const flip = (rs.choice === 'A' && r.choice === 'B') || (rs.choice === 'B' && r.choice === 'A')
              || (rs.choice === 'similar' && r.choice === 'similar')
            if (flip) swapAgree += 1
          }
        }
      }
      const judgedN = win + sim + lose
      pairStats[strat] = {
        pairs: judgedN, win, similar: sim, lose,
        winRatePct: judgedN > 0 ? Number((100 * (win + 0.5 * sim) / judgedN).toFixed(1)) : 0,
        parseFail: pf,
        ...(doSwap ? { swapAgreePct: swapN > 0 ? Number((100 * swapAgree / swapN).toFixed(1)) : 0 } : {}),
      }
      console.log('  ' + strat + ' → ' + JSON.stringify(pairStats[strat]))
    }
  }

  // ---- 聚合 ----
  const pct = (a: number, d: number): number => d > 0 ? Number(((100 * a) / d).toFixed(1)) : 0
  const strata: Record<string, unknown> = {}
  for (const [name, arr] of [...byStratum.entries()].sort()) {
    const ok = judged.filter(j => j.stratum === name && j.judge !== 'parse-fail') as
      Array<{ judge: JudgeResult; signals: Item['signals'] }>
    const keep = ok.filter(j => j.judge.verdict === 'keep').length
    const prune = ok.filter(j => j.judge.verdict === 'prune').length
    strata[name] = {
      n: arr.length,
      reReadPct: pct(arr.filter(i => i.signals.reReadLater).length, arr.length),
      mentionPct: pct(arr.filter(i => i.signals.mentionLater).length, arr.length),
      kindLaterPct: pct(arr.filter(i => i.signals.kindLater).length, arr.length),
      judged: ok.length,
      keepPct: pct(keep, ok.length), prunePct: pct(prune, ok.length),
      unsurePct: pct(ok.length - keep - prune, ok.length),
      keepAndReRead: ok.filter(j => j.judge.verdict === 'keep' && j.signals.reReadLater).length,
      pruneButReRead: ok.filter(j => j.judge.verdict === 'prune' && j.signals.reReadLater).length,
      keepNoTrace: ok.filter(j => j.judge.verdict === 'keep' && !j.signals.reReadLater && !j.signals.mentionLater).length,
    }
  }
  const focalFacetMix: Record<string, number> = {}
  for (const it of items) for (const f of it.focalFacets) focalFacetMix[f] = (focalFacetMix[f] ?? 0) + 1
  const parseFail = judged.length - judged.filter(j => j.judge !== 'parse-fail').length

  const outFile = path.join(OUT_DIR, 'oracle-' + new Date().toISOString().slice(0, 10) + '.json')
  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.writeFileSync(outFile, JSON.stringify({
    stamp: new Date().toISOString(), llm: LLM_BASE, cutChars: CUT_CHARS, judgePer: NO_JUDGE ? 0 : JUDGE_PER,
    archives: doneArchives, itemsTotal: items.length, parseFail, stabilityPct, focalFacetMix, strata, pairStats, judgedDetail: judged, pairDetail,
  }, null, 1))
  console.log('\n=== oracle 分层（' + items.length + ' 条目 / ' + doneArchives + ' 档；明细勿入库：' + outFile + '）===')
  console.log(JSON.stringify({ parseFail, stabilityPct, focalFacetMix, strata, pairStats }, null, 1))
}

main().catch(err => { console.error(err); process.exit(1) })
