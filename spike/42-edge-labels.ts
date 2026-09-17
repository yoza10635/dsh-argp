/**
 * spike 42 — 真实推断边的**标注工作表**生成 / 打分（PROPOSAL §2.2 的标注缺口）
 *
 * 目的：spike41 只能测"信号判别力弱"，测不出**真实误连率**——那需要真值标签。
 * 本工具把真实语料上派生出的边做成可标注的工作表，并提供打分器（含分层统计与置信区间）。
 *
 * ⚠️ **隐私**：工作表包含真实 session 摘录 → 一律写进 gitignored 的 `spike/out/labels/`，
 *   **绝不提交**；仓库里只允许出现**聚合精度数字**。
 *
 * 标注单位 = **配对**（A 文本摘录 + R 文本摘录 + 共同承重 token），**不是**整轮对话。
 * 理由：整轮会泄露"后来发生了什么"（重读 / 报错 / 被 recall）这条捷径，一旦用了它，
 * 量到的就变成"结果好不好"而非"token 共现能否代表语义引用"——那就换成了另一种循环论证。
 *
 * 盲化：工作表（`.blind.jsonl`）**不含**支撑强度；支撑强度单独放 `.key.json`，
 *   **标注完成前不要打开 key**。这样才能检验"支撑强度能否预测真值"
 *   （即"≥k 独立 token 才建边"到底是有据还是拍脑袋）。
 *
 * 用法：
 *   # 1) 生成工作表（默认取本机 ~/.dsh/sessions；无语料则跳过）
 *   npm run spike42
 *   # 2) 填写 .blind.jsonl 里每行的 label 字段：yes / no / unsure（可加 note）
 *   # 3) 打分（读已填的 blind + key）
 *   npm run spike42 -- --score spike/out/labels/<file>.blind.jsonl
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { deriveInferredEdges, findLoadBearingTokens, type OntologyAtom } from '../src/token-ontology.ts'
import { defaultSessionRoot, loadRealCorpus } from './lib/session-corpus.ts'

const outRoot = path.join(import.meta.dirname, 'out', 'labels')
const EXCERPT_RADIUS = 150

interface BlindEntry {
  edgeId: string
  session: string
  fromSeq: number
  toSeq: number
  fromType: string
  toType: string
  /** 共同承重 token（标注者**可见**，这是判断所需的全部信息）。 */
  sharedTokens: string[]
  /** A 原子文本摘录（含共同 token 邻域）。 */
  fromExcerpt: string
  toExcerpt: string
  /** 待填：yes=真引用 / no=巧合 / unsure。 */
  label: '' | 'yes' | 'no' | 'unsure'
  note: string
}

/** 取 token 邻域摘录（找不到 token 时取头部）。 */
function excerpt(text: string, tokens: readonly string[]): string {
  let idx = -1
  for (const t of tokens) {
    const i = text.indexOf(t)
    if (i >= 0 && (idx < 0 || i < idx)) idx = i
  }
  const start = idx < 0 ? 0 : Math.max(0, idx - EXCERPT_RADIUS)
  const end = Math.min(text.length, (idx < 0 ? 0 : idx) + EXCERPT_RADIUS)
  const head = start > 0 ? '…' : ''
  const tail = end < text.length ? '…' : ''
  return head + text.slice(start, end).replace(/\s+/g, ' ') + tail
}

/** 一条边由几个「不同」承重 token 支撑（与 spike41 同口径）。 */
function supportOf(from: OntologyAtom, to: OntologyAtom, stop: ReadonlySet<string>): string[] {
  const fromToks = findLoadBearingTokens(from.text)
  const toToks = new Set(findLoadBearingTokens(to.text))
  return [...new Set(fromToks.filter(t => t.length >= 6 && !stop.has(t) && toToks.has(t)))]
}

function generate(): void {
  const root = process.env['ARGP_SESSION_ROOT'] ?? defaultSessionRoot()
  const corpus = loadRealCorpus(root)
  if (corpus.length === 0) {
    console.log(`[skip] 未找到真实 session（${root}）——无工作表可生成，退出码 0`)
    return
  }
  const blind: BlindEntry[] = []
  const key: Record<string, { support: number; session: string }> = {}
  for (const s of corpus) {
    const atoms = s.atoms
    if (atoms.length === 0) continue
    const df = new Map<string, number>()
    for (const a of atoms) for (const t of new Set(findLoadBearingTokens(a.text))) df.set(t, (df.get(t) ?? 0) + 1)
    const stop = new Set([...df.entries()].filter(([, v]) => v / atoms.length > 0.15).map(([t]) => t))
    const bySeq = new Map(atoms.map(a => [a.seq, a]))
    for (const e of deriveInferredEdges(atoms)) {
      const from = bySeq.get(e.fromSeq)
      const to = bySeq.get(e.toSeq)
      if (from === undefined || to === undefined) continue
      const shared = supportOf(from, to, stop)
      if (shared.length === 0) continue
      const edgeId = `${s.id.slice(8, 16)}:${e.fromSeq}>${e.toSeq}`
      blind.push({
        edgeId,
        session: s.id.slice(8, 16),
        fromSeq: e.fromSeq,
        toSeq: e.toSeq,
        fromType: from.type,
        toType: to.type,
        sharedTokens: shared,
        fromExcerpt: excerpt(from.text, shared),
        toExcerpt: excerpt(to.text, shared),
        label: '',
        note: '',
      })
      key[edgeId] = { support: shared.length, session: s.id.slice(8, 16) }
    }
  }
  if (blind.length === 0) {
    console.log('[skip] 真实语料上未派生出可标注的边，退出码 0')
    return
  }
  fs.mkdirSync(outRoot, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const blindFile = path.join(outRoot, `edge-labels-${stamp}.blind.jsonl`)
  const keyFile = path.join(outRoot, `edge-labels-${stamp}.key.json`)
  fs.writeFileSync(blindFile, blind.map(e => JSON.stringify(e)).join('\n') + '\n')
  fs.writeFileSync(keyFile, JSON.stringify(key, null, 2))

  const single = Object.values(key).filter(k => k.support === 1).length
  console.log(`[spike42] 工作表已生成（真实语料 ${corpus.length} session）`)
  console.log(`  待标注边：${blind.length} 条（单 token 支撑 ${single} / 多 token 支撑 ${blind.length - single}）`)
  console.log(`  工作表：${blindFile}`)
  console.log(`  盲化键：${keyFile}  ← **标注完成前不要打开**（否则破坏盲化）`)
  console.log(`\n  标注说明：逐行填 label = yes（A 确实在引用 R 的内容）/ no（仅偶然共用 token）/ unsure`)
  console.log(`  判断只看 fromExcerpt + toExcerpt + sharedTokens；**不要**回看完整对话或日志——`)
  console.log(`  那会引入"后来发生了什么"这条捷径，量到的就不是 token 共现的语义判别力了。`)
  console.log(`  填完执行：npm run spike42 -- --score ${path.relative(process.cwd(), blindFile)}`)
}

// ---------------------------------------------------------------------------
// 打分
// ---------------------------------------------------------------------------

/** Wilson 95% 置信区间（小样本比例的稳健区间）。 */
function wilson(k: number, n: number): [number, number] {
  if (n === 0) return [0, 1]
  const z = 1.96
  const p = k / n
  const d = 1 + (z * z) / n
  const c = p + (z * z) / (2 * n)
  const s = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))
  return [(c - s) / d, (c + s) / d]
}

function score(blindFile: string): void {
  const keyFile = blindFile.replace('.blind.jsonl', '.key.json')
  if (!fs.existsSync(keyFile)) throw new Error(`缺少盲化键：${keyFile}`)
  const entries = fs.readFileSync(blindFile, 'utf8').split('\n').filter(l => l.trim() !== '')
    .map(l => JSON.parse(l) as BlindEntry)
  const key = JSON.parse(fs.readFileSync(keyFile, 'utf8')) as Record<string, { support: number }>
  const labeled = entries.filter(e => e.label === 'yes' || e.label === 'no')
  const unsure = entries.filter(e => e.label === 'unsure').length
  const blank = entries.filter(e => e.label === '').length
  if (blank > 0) console.log(`[warn] 仍有 ${blank} 条未标注（未计入分母）`)

  const report = (name: string, rows: BlindEntry[]): void => {
    const yes = rows.filter(e => e.label === 'yes').length
    const no = rows.filter(e => e.label === 'no').length
    const n = yes + no
    if (n === 0) { console.log(`  ${name}: 无有效标注`); return }
    const [lo, hi] = wilson(yes, n)
    console.log(`  ${name}: precision = ${yes}/${n} = ${((yes / n) * 100).toFixed(1)}%`
      + `（95% CI ${(lo * 100).toFixed(1)}–${(hi * 100).toFixed(1)}%）`)
  }

  console.log(`\n[spike42] 真实边标注打分（n=${entries.length}，unsure ${unsure} 条已排除）`)
  report('全部边      ', labeled)
  const single = labeled.filter(e => (key[e.edgeId]?.support ?? 0) === 1)
  const multi = labeled.filter(e => (key[e.edgeId]?.support ?? 0) >= 2)
  report('单 token 支撑', single)
  report('≥2 token 支撑', multi)

  // 关键判据：支撑强度是否预测真值 → "≥k 独立 token 才建边"是否有据
  const ps = single.length > 0 ? single.filter(e => e.label === 'yes').length / single.length : NaN
  const pm = multi.length > 0 ? multi.filter(e => e.label === 'yes').length / multi.length : NaN
  console.log(`\n  ★ 分层差 Δprecision = ${((pm - ps) * 100).toFixed(1)} 个百分点（≥2 支撑 − 单支撑）`)
  console.log(`  ★ 判读：Δ 显著为正 → "≥2 独立 token 才建边"有据（牺牲部分真引用换精度）；`)
  console.log(`          Δ ≈ 0   → 支撑强度无预测力，**门控改动无据**，不要动（与 F41-2 的校正一致）`)
}

const args = process.argv.slice(2)
const scoreIdx = args.indexOf('--score')
if (scoreIdx >= 0) {
  const f = args[scoreIdx + 1]
  if (f === undefined) throw new Error('--score 需要一个 .blind.jsonl 路径')
  score(path.resolve(f))
} else {
  generate()
}
