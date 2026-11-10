#!/usr/bin/env node
/**
 * spike 48 — 标签提取审计（P0，只读，零 LLM）。
 *
 * 裁决对象（design-2.0-factor-engine.md §6 G1 + §3.5）：
 *  ① 分 facet 覆盖率（**剔除 tool facet**）：document（args 通道）/ command / errorcode
 *     ——advisory 线各 ≥80%（G1 口径），实际阈值以本审计分布为准可再议；
 *  ② canonical 冲突账：同键并合数、相对路径无事件时 cwd（unboundRel）、
 *     fail-closed 拒收（secret/long/newline）——词表注入面的安全边界实测；
 *  ③ 查询侧模拟：同一 canonical 文件被工具**二次经手**时，先前是否存在带该标签的 R
 *     （命中率 = 提取双侧对称性代理；零结果率 = 交集稀疏度）；
 *  ④ sticky 预审计：(file × errorcode) 重复对与"修复宣称"（夹 write）的真实出现率——
 *     sticky 因子在真实语料里到底有没有料；
 *  ⑤ 事件时环境可得率：bash cwd 参数在场比例（相对路径绑定的可行性，§1.3）。
 *
 * **隐私铁律**（同 spike/lib/session-corpus.ts）：只读；只打印聚合量与分布，
 * 绝不打印路径原文/标签原文/会话内容。
 *
 * 用法：
 *   npm run spike48                       # 默认扫 ~/.dsh/sessions + sessions-corpus
 *   npm run spike48 -- <dir-or-glob>...   # 指定目录/文件
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { loadSessionEvents, type RawSessionEvent } from './lib/session-corpus.ts'
import { facetsOf, indexCalls, issuerOf, resultTextOf, sessionCwdOf } from './lib/tag-proto.ts'

// ---------------------------------------------------------------------------
// 输入展开
// ---------------------------------------------------------------------------
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
      if (ent.name === 'node_modules') continue
      findArchives(p, out)
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
  const st = fs.existsSync(i) && fs.statSync(i).isDirectory()
  if (st) findArchives(i, archives)
  else if (fs.existsSync(i)) archives.push(i)
}
if (archives.length === 0) {
  console.error('[FAIL] 未找到任何 session 归档（真实语料只在个人机上；CI 上本 spike 应跳过）')
  process.exit(1)
}

// ---------------------------------------------------------------------------
// 聚合器（只存计数与分布，不存原文）
// ---------------------------------------------------------------------------
const G = {
  archives: 0,
  archivesFailed: 0,
  events: 0,
  rAtoms: 0,
  rArgsParseable: 0,
  // 覆盖（args 通道 file facet / command / errorcode）
  rWithFile: 0,
  rWithScopeOnly: 0,
  rFileTextSideOnly: 0, // args 无文件标签、文本侧兜底才有的增量
  bashR: 0,
  bashRCmd: 0,
  errorishR: 0,
  errorishRCoded: 0,
  // canonical/fail-closed 账
  unboundRelR: 0,
  bashCwdSeen: 0,
  rejectSecret: 0,
  rejectLong: 0,
  rejectNewline: 0,
  // 查询模拟/sticky：索引一律**会话内**（跨会话全局会把热点文件宽度虚增——
  // 首轮踩过）；此处只留聚合账
  simQueries: 0,
  simHits: 0,
  simResultSizes: [] as number[],
  stickyPairs: 0,
  stickyRepeat: 0,
  stickyWithFixClaim: 0,
  // 同一 callId 只算一次：剪枝 replace 会复写同 callId 的 tool/result 事件
  //（tool/result 62.5K vs tool/call 12.4K 实核），副本不是新的 R
  dedupCallIds: 0,
  // 逐工具账（工具名可打印——非用户内容）
  perTool: new Map<string, { r: number; file: number; err: number; code: number }>(),
}

const pct = (a: number, b: number): string => (b === 0 ? '  n/a' : (100 * a / b).toFixed(1) + '%')
const quantile = (sorted: number[], q: number): number =>
  sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))] ?? 0

for (const file of archives) {
  let events: RawSessionEvent[]
  let heads: RawSessionEvent[]
  try {
    const loaded = loadSessionEvents(file)
    events = loaded.events
    heads = loaded.heads
  } catch {
    G.archivesFailed += 1
    continue
  }
  G.archives += 1
  G.events += events.length
  const cwd = sessionCwdOf(heads)
  const calls = indexCalls(events)
  // 会话内索引（宽度/sticky 只在同一会话内有意义）
  const docsIndex = new Map<string, number[]>()
  const sticky = new Map<string, { first: number; last: number }>()
  const fileWrites: { seq: number; files: string[] }[] = []
  const seenCallIds = new Set<string>()

  for (const e of events) {
    if (e.type !== 'tool/result') continue
    const issuer = issuerOf(e, calls)
    if (issuer === null) continue
    const cidKey = String(issuer.seq)
    if (seenCallIds.has(cidKey)) {
      G.dedupCallIds += 1
      continue
    }
    seenCallIds.add(cidKey)
    const text = resultTextOf(e)
    const bag = facetsOf(issuer.name, issuer.args, text, cwd)
    G.rAtoms += 1
    if (issuer.args !== null && issuer.args !== undefined) G.rArgsParseable += 1

    const pt = G.perTool.get(bag.tool) ?? { r: 0, file: 0, err: 0, code: 0 }
    pt.r += 1
    if (bag.files.length > 0) {
      G.rWithFile += 1
      pt.file += 1
    } else if (bag.scopes.length > 0) {
      G.rWithScopeOnly += 1
    }
    if (bag.errorish) {
      G.errorishR += 1
      if (bag.errorcodes.length > 0) {
        G.errorishRCoded += 1
        pt.err += 1
      }
      pt.code += 1
    }
    if (bag.commands.length > 0) {
      G.bashR += 1
      G.bashRCmd += 1
    } else if (issuer.name === 'bash' || issuer.name === 'shell') {
      G.bashR += 1
    }
    if (bag.rejects['secret'] !== undefined) G.rejectSecret += bag.rejects['secret'] ?? 0
    if (bag.rejects['long'] !== undefined) G.rejectLong += bag.rejects['long'] ?? 0
    if (bag.rejects['newline'] !== undefined) G.rejectNewline += bag.rejects['newline'] ?? 0
    // unboundRel 账：facetsOf 内部已把 rel: 前缀塞进 files——这里重扫一遍 args 侧成本高，
    // 简化口径：files 以 rel: 开头的即 unbound（canonical 审计口径）
    if (bag.files.some(f => f.startsWith('rel:')) || bag.scopes.some(s => s.startsWith('rel:'))) G.unboundRelR += 1
    if (bag.cwdSeen) G.bashCwdSeen += 1

    // 查询模拟（会话内，seq 天然升序遍历）
    for (const f of bag.files) {
      const prior = docsIndex.get(f)
      if (prior !== undefined && prior.length > 0) {
        G.simQueries += 1
        G.simHits += 1
        G.simResultSizes.push(prior.length)
      }
      const arr = docsIndex.get(f)
      if (arr !== undefined) arr.push(e.seq)
      else docsIndex.set(f, [e.seq])
    }
    if (bag.writeish && !bag.errorish && bag.files.length > 0) {
      fileWrites.push({ seq: e.seq, files: bag.files })
    }
    if (bag.errorish) {
      for (const f of bag.files) {
        for (const c of bag.errorcodes) {
          const k = f + '\u0000' + c
          const cur = sticky.get(k)
          if (cur === undefined) sticky.set(k, { first: e.seq, last: e.seq })
          else cur.last = e.seq
        }
      }
    }
    G.perTool.set(bag.tool, pt)
  }

  // sticky 的"修复宣称"回填（会话内）
  G.stickyPairs += sticky.size
  for (const [k, v] of sticky) {
    if (v.last <= v.first) continue
    G.stickyRepeat += 1
    const file = k.split('\u0000')[0] ?? ''
    if (fileWrites.some(w => w.seq > v.first && w.seq < v.last && w.files.includes(file))) G.stickyWithFixClaim += 1
  }
}

// ---------------------------------------------------------------------------
// 输出（聚合量；sticky/docs 的键是真实路径，一律不打印，只给计数）
// ---------------------------------------------------------------------------
G.simResultSizes.sort((a, b) => a - b)

console.log('=== spike48 · tag-extract audit（聚合量，无原文）===')
console.log(`archives = ${G.archives} (failed ${G.archivesFailed}) | events = ${G.events}`)
console.log(`R atoms(去重后真实工具调用) = ${G.rAtoms} | 剪枝副本跳过 = ${G.dedupCallIds} | args 可解析 = ${pct(G.rArgsParseable, G.rAtoms)}`)
console.log('')
console.log('--- G1 advisory（剔除 tool facet；线 = 各 ≥80%）---')
console.log(`document facet（args 通道）: ${pct(G.rWithFile, G.rAtoms)}  （仅 scope 无文件: ${G.rWithScopeOnly}）`)
console.log(`command facet（bash/shell R 内）: ${pct(G.bashRCmd, G.bashR)} (${G.bashRCmd}/${G.bashR})`)
console.log(`errorcode facet（errorish R 内）: ${pct(G.errorishRCoded, G.errorishR)} (${G.errorishRCoded}/${G.errorishR}) | errorish 占全体: ${pct(G.errorishR, G.rAtoms)}`)
console.log('')
console.log('--- canonical / fail-closed 账 ---')
console.log(`unboundRel R（相对路径无事件时 cwd）: ${G.unboundRelR} (${pct(G.unboundRelR, G.rAtoms)})`)
console.log(`bash 在场 cwd 可得（cwdSeen）: ${G.bashCwdSeen} / ${G.bashR} bash R = ${pct(G.bashCwdSeen, G.bashR)}`)
console.log(`fail-closed 拒收: secret=${G.rejectSecret} long=${G.rejectLong} newline=${G.rejectNewline}`)
console.log('')
console.log('--- 查询侧模拟（同一 canonical 文件二次经手时，先前有无可召回 R）---')
console.log(`simQueries=${G.simQueries} hitRate=${G.simQueries === 0 ? 'n/a' : pct(G.simHits, G.simQueries)}（对称性代理：提取侧全有或全无，此处应≈100%——<100% 即键漂移）`)
console.log(`召回集宽度 |prior|: p50=${quantile(G.simResultSizes, 0.5)} p90=${quantile(G.simResultSizes, 0.9)} p99=${quantile(G.simResultSizes, 0.99)} max=${quantile(G.simResultSizes, 1)}`)
console.log('')
console.log('--- sticky 预审计（会话内 (file×errorcode) 重复 × 修复宣称）---')
console.log(`pairs=${G.stickyPairs} repeat(≥2 次)=${G.stickyRepeat} withFixClaim=${G.stickyWithFixClaim}`)
console.log(G.stickyRepeat === 0
  ? '  → 真实语料里 sticky 无料：保护位保留但排序权重靠 T-2 ablation 再定'
  : `  → sticky 有料（repeat 率 ${pct(G.stickyRepeat, G.rAtoms)}，修复宣称率 ${pct(G.stickyWithFixClaim, G.stickyRepeat)}）`)
console.log('')
console.log('--- 逐工具（top 15，按 R 数）---')
const rows = [...G.perTool.entries()].sort((a, b) => b[1].r - a[1].r).slice(0, 15)
console.log('tool'.padEnd(18) + 'R'.padStart(7) + 'file%'.padStart(8) + 'err%'.padStart(8))
for (const [name, v] of rows) {
  console.log(name.padEnd(18) + String(v.r).padStart(7) + pct(v.file, v.r).padStart(8) + pct(v.err, v.code).padStart(8))
}
