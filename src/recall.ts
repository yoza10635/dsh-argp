/**
 * ARGP 召回模块：被遮蔽 seq 增量账本（shadowedSeqsOf）+ catalog 生成（catalogText）+
 * 关键词召回（recallQuery）+ 程序化召回（recall / recallAnyState / nodeState）
 * + 轮次口径（latestTurnOf / latestTurnOfSession）+ 召回防抖（noteRecallHit）
 * + 召回字数预算（budgetRecallText）。
 *
 * 循环 import 规避：本模块**不** import hub 运行时。需要读/写引擎可变字段的函数接收
 * 窄接口 {@link RecallHost} 而非具体 class；hub 的 class 以 `this as unknown as
 * RecallHost` 传入（编译期断言，运行时即真实实例，私有字段经 host 类型可读写/重赋值）。
 * 依赖方向：hub → recall（单向）。
 */
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionRuntimeState } from './session-state.js'
import type { AtomType } from './argp-types.js'
import { sessionEvents, eventText, recallFromLog, nodeStateOf, type NodeState } from './log-access.js'
import { classifyUserMessage } from './graph-build.js'
import { pushBounded } from './telemetry.js'

/**
 * 召回侧模块函数访问引擎状态所需的窄接口。
 * 仅列出各召回函数实际读写的字段；hub 的 ArgpGraphEngine 以
 * `this as unknown as RecallHost` 满足它。
 * charsPerToken 在 class 上是 getter——经 host 读取时 getter 以真实实例为
 * this 调用，语义与 this.charsPerToken 完全一致。
 */
/**
 * 1.11.0-beta.0（1-1/1-2）起 RecallHost 的会话态经 `stateOf(session)` 分桶访问；
 * 函数签名一律显式带 session（异步调用方不得依赖引擎焦点指针——多会话交错时
 * 焦点可能已切走）。session 字段保留给"当前焦点"语义的同步调用方（catalogText）。
 */
export interface RecallHost {
  session: Session | null
  stateOf: (session: Session) => SessionRuntimeState
  charsPerToken: number
  turnBasis: 'semantic' | 'all'
  telemetryCap: number
  resolvedWindowTokens: number
}

/**
 * 增量维护被遮蔽 surface seq 集合：事件日志只追加，游标从上次扫描处继续，
 * 避免每次 recall/剪枝压力检查都 O(事件总量) 重扫。session 切换时重置。
 *
 * 原 class 私有方法；this.x → host.x（shadowedSession/shadowedSet/shadowedScanned
 * 经 host 重赋值落到真实字段）。
 */
export function shadowedSeqsOf(host: RecallHost, session: Session): Set<number> {
  const st = host.stateOf(session)
  if (st.shadowedSession !== session) {
    st.shadowedSession = session
    st.shadowedSet = new Set()
    st.shadowedScanned = 0
  }
  for (let index = st.shadowedScanned; index < session.seq; index += 1) {
    const event = sessionEvents(session)[index]
    if (event === undefined) continue
    // 权威剪枝账本：只认 compaction/prune 事件（pruneIntervals 每次真剪枝必发，
    // 且 shadowedSeqs 即被剪 surface seq 的权威清单）。不再靠「replace 形态推断」：
    // 旧实现扫 surfaceOp replace 并把 sourceEventSeqs 收进集合，会误吞两类非剪枝写回——
    //   ① cites 剥离写回（data.argpCites，仅去协议产物）——2026-08-22 已加 argpCites 门控；
    //   ② per-atom 原地压缩（peratom/compressor.ts 的 user/tool 副本，start===end、
    //      sourceEventSeqs=[被压原子]、无 compaction/prune 事件）——2026-08-27 定位：
    //      它仍穿透旧门控被当「已剪」，导致 catalog 谎报 "Compression removed N"、
    //      system 前缀逐轮变、跨轮缓存全断（60 轮 A 臂实证：catalog 显示 removed 44，
    //      而 compaction/prune 事件数 = 0，44 个全是 per-atom 原地压缩）。
    // 只读 compaction/prune.shadowedSeqs 后，per-atom 原地压缩天然不在账本内，根因消除；
    // 且不再把 compaction/start、compaction/prune 这两个 off-surface 事务 seq 误收进集合。
    if (event.type === 'compaction/prune') {
      const shadowed = (event.data as { shadowedSeqs?: number[] }).shadowedSeqs
      if (Array.isArray(shadowed)) {
        for (const seq of shadowed) st.shadowedSet.add(seq)
      }
    }
  }
  st.shadowedScanned = session.seq
  return st.shadowedSet
}

/** 生成上下文头部 catalog（设计稿 §5 + A9）：U/A/R 三类都列（R 带 type=R），snippet 截断，字符预算驱动（A9）。
 *
 * 原 class 方法；this.x → host.x。 */
export function catalogText(host: RecallHost, maxItems = 20, snippetChars = 70, tokenBudget = 600): string {
  if (host.session === null) return ''
  const session = host.session
  const shadowed = shadowedSeqsOf(host, session)
  const entries: { type: AtomType; turn: number; seq: number; snippet: string }[] = []
  const charBudget = tokenBudget * host.charsPerToken
  let usedChars = 0
  for (const seq of shadowed) {
    if (entries.length >= maxItems) break
    const event = sessionEvents(session)[seq]
    if (event === undefined) continue
    const data = event.data as Record<string, unknown> | undefined
    let type: AtomType
    if (event.type === 'user/message') {
      type = classifyUserMessage(data)
    } else if (event.type === 'assistant/message') {
      type = 'A'
    } else if (event.type === 'tool/result') {
      type = 'R' // A9：R 补入 catalog 发现入口（N2）
    } else {
      continue
    }
    const text = eventText(session, seq)
    const snippet = text.split('\n').map(l => l.trim()).find(l => l !== '') ?? ''
    const clipped = snippet.length > snippetChars ? snippet.slice(0, snippetChars) + '…' : snippet
    if (usedChars + clipped.length > charBudget && entries.length > 0) break
    usedChars += clipped.length
    const turn = typeof data?.turn === 'number' ? (data.turn as number) : 0
    entries.push({ type, turn, seq, snippet: clipped })
  }
  // U 排前，其余按 seq 升序
  entries.sort((a, b) => (a.type === 'U' ? 0 : 1) - (b.type === 'U' ? 0 : 1) || a.seq - b.seq)
  const lines = entries.map(e => '[' + e.type + (e.turn !== 0 ? e.turn : '') + '] ' + e.snippet)
  if (lines.length === 0) return ''
  return '[context] Compression removed ' + shadowed.size + ' earlier item(s) from the visible context:\n' + lines.join('\n')
}

/** 按关键词查询被剪节点原文（设计稿 §6 的 recall(query) 简化版）。
 *
 * 原 class 方法；this.x → host.x。 */
export function recallQuery(host: RecallHost, session: Session | null, query: string, maxResults = 5): string {
  if (session === null) return 'recall: no session bound'
  const st = host.stateOf(session)
  const shadowed = shadowedSeqsOf(host, session)
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  interface Hit { seq: number; score: number; text: string; type: AtomType; turn: number }
  const hits: Hit[] = []
  for (const seq of shadowed) {
    const event = sessionEvents(session)[seq]
    if (event === undefined) continue
    const data = event.data as Record<string, unknown> | undefined
    const text = eventText(session, seq)
    if (text === '') continue
    const lower = text.toLowerCase()
    let score = 0
    for (const term of terms) if (lower.includes(term)) score += 1
    if (score === 0) continue
    let type: AtomType
    if (event.type === 'user/message') type = classifyUserMessage(data)
    else if (event.type === 'assistant/message') type = 'A'
    else if (event.type === 'tool/result') type = 'R'
    else type = 'X'
    const turn = typeof data?.turn === 'number' ? (data.turn as number) : 0
    hits.push({ seq, score, text, type, turn })
  }
  hits.sort((a, b) => b.score - a.score || (a.type === 'U' ? -1 : b.type === 'U' ? 1 : a.seq - b.seq))
  const selected = hits.slice(0, maxResults)
  for (const h of selected) noteRecallHit(host, session, h.seq)
  pushBounded(st.recallQueryCalls, { query, count: selected.length, hits: selected.length }, host.telemetryCap)
  if (selected.length === 0) return 'recall: no pruned nodes match query "' + query + '"'
  const lines = selected.map(h => '[' + h.type + (h.turn !== 0 ? h.turn : '') + '] ' + h.text)
  return 'Recalled ' + selected.length + ' pruned atom(s) for "' + query + '":\n' + lines.join('\n')
}

/**
 * 程序化 recall（RecallHandle 语义）：**仅**命中被遮蔽节点，未命中返回 null。
 * 这是给宿主/测试用的窄接口，故意保留 pruned-only 语义（历史 spike 系列的
 * `engine.recall(seq) !== null` 探针依赖它判定"是否已被剪"，去门控会破坏探针）；
 * 模型侧 recall_pruned 工具已按 P1 修复 (b) 去门控并带状态标签，
 * 程序化的全日志入口是 recallAnyState()。
 *
 * 原 class 方法；this.x → host.x。
 */
export function recall(host: RecallHost, session: Session | null, seq: number): string | null {
  if (session === null) return null
  if (!shadowedSeqsOf(host, session).has(seq)) return null
  const text = eventText(session, seq)
  return text === '' ? null : text
}

/**
 * 全日志级 recall（P1 修复 (b) 的程序化入口）：对任意界内 seq 返回原文 + 状态标签，
 * 不要求节点属于 pruned 集合。越界返回 null。
 *
 * 原 class 方法；this.x → host.x。
 */
export function recallAnyState(host: RecallHost, session: Session | null, seq: number): { text: string; state: NodeState } | null {
  if (session === null) return null
  const shadowed = shadowedSeqsOf(host, session)
  const outcome = recallFromLog(session, seq, s => shadowed.has(s), eventText)
  if (!outcome.ok) return null
  return { text: outcome.text, state: outcome.state }
}

/** 单个 seq 相对可见上下文的状态（shadowed / live / off-surface）。
 *
 * 原 class 方法；this.x → host.x。 */
export function nodeState(host: RecallHost, session: Session | null, seq: number): NodeState | null {
  if (session === null) return null
  const shadowed = shadowedSeqsOf(host, session)
  return nodeStateOf(session, seq, s => shadowed.has(s))
}

/**
 * 当前最大 turn 号（recall 回拉防抖窗口 / 闭包保护窗口共用口径）。
 *
 * P4 修复：旧实现遍历 **全部 events** 取 max，把 turn/start、注入型 system-reminder
 * 等非 surface 事件也算进来，与 compactIfNeeded（含内联闭包降级链）用的
 * "atoms（surface 节点）最大 turn" 口径不一致 —— 同一个防抖判定两端基准不同。
 * 现统一为 surface 节点口径；turnBasis='semantic'（默认）时进一步排除注入型 X 节点，
 * 使纯注入不推进轮次、不抬高 latestTurn-k 保护线。
 *
 * 原 class 方法；this.turnBasis → host.turnBasis。
 */
export function latestTurnOf(host: RecallHost, session: Session): number {
  let max = 0
  for (const seq of session.surface.nodes) {
    const event = sessionEvents(session)[seq]
    if (event === undefined) continue
    const data = event.data as Record<string, unknown> | undefined
    if (host.turnBasis === 'semantic' && event.type === 'user/message'
      && classifyUserMessage(data) === 'X') {
      continue // 注入型 X（system-reminder / ARGP tombstone）不推进语义轮次；
      // U-info 聚合副本（classifyUserMessage → U）是真实用户内容的替换拷贝，照常参与——
      // 若被跳过，被拆分消息所在轮会漏报 latestTurn，recency/turnGuard 保护线随之偏移。
    }
    const t = data?.turn
    if (typeof t === 'number' && t > max) max = t
  }
  return max
}

/** 当前绑定 session 的最大 turn（原 class 私有方法；this.x → host.x）。 */
export function latestTurnOfSession(host: RecallHost): number {
  if (host.session === null) return 0
  return latestTurnOf(host, host.session)
}

/**
 * recall 命中被剪闭包内节点时，将该闭包拉回 ACTIVE 并记下防抖轮。
 *
 * P2 修复：防抖 key 从 closureId 改为 rootSeq。closureId 由 `nextClosureId++` 生成，
 * selectClosureToMerge 每 pass 都给所有 root 重发新 id，导致此处写入的旧 id 与
 * 剪枝决策处读取的新 id 永不相等 → `continue` 防抖分支永不触发 → 刚 recall 回来的
 * 闭包下一 pass 又被剪。rootSeq 跨 pass 稳定，是闭包的天然身份。
 *
 * 原 class 私有方法；this.x → host.x。
 */
export function noteRecallHit(host: RecallHost, session: Session | null, seq: number): void {
  if (session === null) return
  const st = host.stateOf(session)
  for (const c of st.closurePrunes) {
    if (c.prunedSeqs.includes(seq)) {
      st.closureLastRecalled.set(c.rootSeq, latestTurnOf(host, session))
      break
    }
  }
}

/**
 * recall 预算：单次结果与累计结果都按窗口比例截断（窗口取最近解析的有效预算）。
 *
 * P7 修复：recallCharsUsed 原本只增不减、全会话无 reset —— 累计触顶后 allowed=0，
 * 返回值退化成纯 '…(truncated)' 且不说明原因，长会话静默丢 recall。现在
 *  1) 预算耗尽时显式说明剩余额度与何时恢复（不再静默）；
 *  2) 每笔 compaction 事务成功后归零（见 pruneIntervals 末尾）。
 *
 * 原 class 私有方法；this.x → host.x（recallCharsUsed 经 host 重赋值落到真实字段）。
 */
export function budgetRecallText(host: RecallHost, session: Session | null, text: string): string {
  if (session === null) return text
  const st = host.stateOf(session)
  const perCallLimit = Math.floor(host.resolvedWindowTokens * 0.05 * host.charsPerToken)
  const totalLimit = Math.floor(host.resolvedWindowTokens * 0.10 * host.charsPerToken)
  const remaining = Math.max(0, totalLimit - st.recallCharsUsed)
  if (remaining === 0) {
    return '(recall text budget exhausted: ' + st.recallCharsUsed + '/' + totalLimit
      + ' chars used since the last compaction. Nothing was returned — this is a budget limit, '
      + 'not missing data. The budget resets on the next compaction; narrow the request or retry later.)'
  }
  const allowed = Math.min(perCallLimit, remaining)
  let result = text
  if (result.length > allowed) {
    result = result.slice(0, allowed) + '…(truncated at ' + allowed + ' chars; recall budget '
      + (st.recallCharsUsed + allowed) + '/' + totalLimit
      + ' chars used since the last compaction, resets on the next one)'
  }
  st.recallCharsUsed += result.length
  return result
}
