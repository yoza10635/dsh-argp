#!/usr/bin/env node
/**
 * spike 49 — 召回发起归因观察（P0，只读，零 LLM）。
 *
 * 观察对象（design-2.0-factor-engine.md §3.5/§9 P0-1 + §1.4 触发模型）：
 *  "损失探测"旧前提是否在旧引擎**生产**中兑现过——
 *   ① recall 族工具的发起量（tool/call 事件归因；`noteRecallHit` 是闭包 debounce，不可用）；
 *   ② prune→canonical 再读：被剪 R 的 canonical 文件在剪枝之后是否被再次 read/grep
 *      ——需求来过的行为证据（比 spike43 的裸文本路径再读更准：两侧同 canonical 函数）。
 *
 * ⚠️ 证据强度限定（必须随结论打印，§9 P0-3/§9.1）：
 *  - 再读率是**上限观测量**，绝对值不可单独引用，须对照臂成对做差（spike43 自家口径）；
 *  - 发起率低有**设计混淆**：catalog 首绑一次性冻结、1.7.1 指针墓碑——不是
 *    "损失探测前提失效"的纯净观察；
 *  - 本 spike 产出 = 描述性观察，G2 的退役判定证据在 T-2 ablation，不在这里。
 *
 * **隐私铁律**：只读；只打印聚合量与逐会话计数行（无路径/内容原文）。
 * 用法：npm run spike49  [dirs...]（默认同 spike48）
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { loadSessionEvents, type RawSessionEvent } from './lib/session-corpus.ts'
import { facetsOf, indexCalls, issuerOf, resultTextOf, sessionCwdOf } from './lib/tag-proto.ts'

function findArchives(dir: string, out: string[]): void {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const ent of entries) {
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) {
      if (ent.name !== 'node_modules') findArchives(p, out)
    } else if (/session\.v\d+\.jsonl(\.zstd)?$/.test(ent.name)) {
      out.push(p)
    }
  }
}

const argv = process.argv.slice(2)
const inputs = argv.length > 0 ? argv : [
  path.join(os.homedir(), '.dsh', 'sessions'),
  path.join(os.homedir(), '.dsh', 'sessions-corpus'),
]
const archives: string[] = []
for (const i of inputs) {
  if (fs.existsSync(i) && fs.statSync(i).isDirectory()) findArchives(i, archives)
  else if (fs.existsSync(i)) archives.push(i)
}
if (archives.length === 0) {
  console.error('[FAIL] 未找到任何 session 归档')
  process.exit(1)
}

const RECALL_FAMILY = ['recall_pruned', 'list_pruned', 'recall_summary', 'recall_detail', 'recall', 'recall_reply']
const READ_FAMILY = new Set(['read', 'grep', 'glob', 'view'])

const T = {
  archives: 0,
  toolCalls: 0,
  recallCalls: 0,
  recallByName: new Map<string, number>(),
  prunes: 0,
  prunedRs: 0,
  prunedRWithFile: 0,
  // prune→再读
  rereadCanonical: 0,
  rereadSessions: 0,
  recallAfterPrune: 0,
  sessionsWithPrune: 0,
}

for (const file of archives) {
  let events: RawSessionEvent[]
  let heads: RawSessionEvent[]
  try {
    const loaded = loadSessionEvents(file)
    events = loaded.events
    heads = loaded.heads
  } catch {
    continue
  }
  T.archives += 1
  const cwd = sessionCwdOf(heads)
  const calls = indexCalls(events)

  // 第一遍：R canonical 文件表 + 发起计数 + prune 事件
  const rFiles = new Map<number, string[]>()
  let aRecall = 0
  const pruneSpans: { seq: number; seqs: Set<number> }[] = []
  for (const e of events) {
    if (e.type === 'tool/call') {
      T.toolCalls += 1
      const name = String(e.data['name'] ?? '')
      if (RECALL_FAMILY.some(f => name === f || name.startsWith(f))) {
        T.recallCalls += 1
        aRecall += 1
        T.recallByName.set(name, (T.recallByName.get(name) ?? 0) + 1)
      }
    } else if (e.type === 'tool/result') {
      const issuer = issuerOf(e, calls)
      if (issuer === null) continue
      const bag = facetsOf(issuer.name, issuer.args, resultTextOf(e), cwd)
      if (bag.files.length > 0) rFiles.set(e.seq, bag.files)
    } else if (e.type === 'compaction/prune') {
      const ss = (e.data['shadowedSeqs'] as unknown[] | undefined) ?? []
      const set = new Set<number>(ss.filter((x): x is number => typeof x === 'number'))
      if (set.size > 0) pruneSpans.push({ seq: e.seq, seqs: set })
    }
  }
  if (pruneSpans.length === 0) continue
  T.prunes += pruneSpans.length
  T.sessionsWithPrune += 1

  // 被剪 R 账（canonical 文件已知的）
  const prunedFileAt = new Map<string, number>() // canonical 文件 → 最早剪走它的 prune seq
  for (const span of pruneSpans) {
    for (const s of span.seqs) {
      const files = rFiles.get(s)
      if (files === undefined) continue
      T.prunedRs += 1
      T.prunedRWithFile += 1
      for (const f of files) {
        const cur = prunedFileAt.get(f)
        if (cur === undefined || span.seq < cur) prunedFileAt.set(f, span.seq)
      }
    }
  }

  // 第二遍：prune 后的 canonical 再读 + prune 后的 recall 发起
  let sessReread = 0
  const firstPrune = pruneSpans[0]?.seq ?? Number.POSITIVE_INFINITY
  for (const e of events) {
    if (e.type !== 'tool/call') continue
    const name = String(e.data['name'] ?? '')
    if (e.seq > firstPrune && RECALL_FAMILY.some(f => name === f || name.startsWith(f))) T.recallAfterPrune += 1
    if (!READ_FAMILY.has(name)) continue
    const bag = facetsOf(name, e.data['arguments'], '', cwd)
    for (const f of bag.files) {
      const cut = prunedFileAt.get(f)
      if (cut !== undefined && e.seq > cut) {
        sessReread += 1
        break
      }
    }
  }
  T.rereadCanonical += sessReread
  if (sessReread > 0) T.rereadSessions += 1
}

const pct = (a: number, b: number): string => (b === 0 ? 'n/a' : (100 * a / b).toFixed(1) + '%')
console.log('=== spike49 · recall 发起归因（观察量，带强度限定）===')
console.log(`archives=${T.archives}（含剪枝的 ${T.sessionsWithPrune}）| tool/calls=${T.toolCalls} | prune 事件=${T.prunes}`)
console.log(`recall 族发起: ${T.recallCalls}（占 tool/call ${pct(T.recallCalls, T.toolCalls)}）prune 后发起 ${T.recallAfterPrune}`)
for (const [n, c] of [...T.recallByName.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${n.padEnd(16)} ${c}`)
console.log(`被剪 R=${T.prunedRs}（canonical 文件已知 ${T.prunedRWithFile}）| prune→canonical 再读命中=${T.rereadCanonical}（涉及 ${T.rereadSessions} 会话）`)
console.log('')
console.log('⚠️ 强度限定：再读率=上限观测量（spike43 自家口径，须对照臂成对做差）；')
console.log('  发起率受设计混淆（catalog 首绑冻结、1.7.1 指针墓碑），不得单独引为"损失探测前提失效"证据。')
console.log('  declarer 退役判定证据 = T-2 决策重放 ablation（§6 G2），不是本表。')
