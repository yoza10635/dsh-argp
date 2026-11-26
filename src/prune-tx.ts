/**
 * ARGP 剪枝事务模块：事务骨架（pruneIntervals：start → summary → 每区间 checkpoint
 * replace → end）+ 墓碑可合并判据（isMergeableTombstone）+ 事务记录类型
 * （GraphPruneRecord）。手动区间族（compactRegion/compactRegions/selectManualRanges/
 * consolidateTombstones）不在 2.0 factor 面（引擎 compactRegion 直接拒发）。
 *
 * 循环 import 规避：本模块**不** import hub 运行时，也**不** import session-lifecycle
 * （否则 session-lifecycle → prune-tx → session-lifecycle 成环）。需要调用引擎方法的函数
 * 通过窄接口 {@link PruneTxHost} 上的**方法引用**调用（host.bindSession / host.atomize），
 * 而非模块 import——方法在运行时经传入的实例（即 hub 的 class）分派，编译期零依赖。
 * 依赖方向：hub → prune-tx（单向）。
 */
import { randomUUID } from 'node:crypto'
import type { Session } from '@deepseek-ai/dsh-session'
import { CompactionId, compactCheckpointSource, toolPairingBalancedAfter, toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction'
import type { CompactionAgentContext, CompactionResult, ManualCompactAgentContext } from '@deepseek-ai/dsh-compaction'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { CommandId } from '@deepseek-ai/dsh-commands'
import type { Atom, AtomType } from './argp-types.js'
import type { SessionRuntimeState } from './session-state.js'
import { sessionEvents, eventText, asSeq, asSeqs, detectOpenTurn, resolveRootSeqs } from './log-access.js'
import { classifyUserMessage } from './atomize.js'
import { visibleChars, visibleCharStats } from './budget.js'
import { estTokensFromStats } from './cjk.js'
import { shadowedTokensOf } from './constants.js'
import { pushBounded } from './telemetry.js'
import { isMergeableTombstoneText, seqRangeTombstone } from './tombstone-text.js'

/**
 * tombstone 可合并判据。
 *
 * 判据是**语法级前缀**（`[elided ` 空格族 = 可合并 / `[elided:` 冒号族 = tool 占位）。
 * 不能用自然语言子串（如旧口径的 `pruned by ARGP`）：文案会变，判据随之失效。
 * 实现下沉到 `tombstone-text.ts`，与文案生成同处一文件——两者不再可能各自漂移。
 *
 * 语义：X 原子中仅「本引擎剪枝墓碑」可安全合并。其余 X（宿主 system-reminder、
 * 官方摘要 checkpoint、注入型 checkpoint）不可动；`consolidateTombstones` 另有一道
 * **事件类型**过滤（只认 user/message），与文本判据构成双保险，防孤儿 tool_calls。
 * 导出供测试锁定行为。
 */
/** §G2 摘要信封：provider/model/maxTokens/usage（含 cacheReadTokens）/rawOutput/llmStreamCall。 */
export interface CompactionSummaryMeta {
  provider?: string
  model?: string
  maxTokens?: number
  usage?: { inputTokens: number; outputTokens: number; cacheReadTokens?: number }
  rawOutput?: unknown[]
  llmStreamCall?: true
}

export function isMergeableTombstone(text: string): boolean {
  return isMergeableTombstoneText(text)
}

export interface GraphPruneRecord {
  at: string
  compactionId: string
  /** /compact 发起命令 ID（presentation correlation；自动压缩时为 undefined）。 */
  sourceCommandId?: CommandId
  intervals: { start: number; end: number; tombstoneSeq: number }[]
  startEventSeq: number
  summaryEventSeq: number
  endEventSeq: number
  shadowedSeqs: number[]
  prunedAtoms: { id: number; type: AtomType; seq: number }[]
  semanticEdges: number
  candidates: number
  charsBefore: number
  charsAfter: number
  forced: boolean
  /**
   * 事务以 error end 收尾时携带错误消息：该事务是 partial（已落地的
   * replace 子集真实有效，但整体未成功）。带 error 的记录**不参与**墓碑重定向表
   * （intervals 为空），账本重建侧据此与成功事务区分。
   */
  error?: string
}

/**
 * F3：旧 seq → 当前替身 seq（墓碑）的重定向表。
 *
 * **病灶**：declarer 写入侧 `collectDeclAtoms` 走 `sessionEvents`（**原始 append-only 日志**），
 * 已被 replace 离场的旧 seq 仍在 `toBySeq` 校验白名单内（模型引用它**合法**，
 * `accepted=N, invalid=0`）；而消费侧 `buildInjectEdges` 的 `idBySeq` 建自**当前投影**，
 * 查表必然 miss ⇒ 边被 `droppedByMissingEndpoint` 丢弃。实测 `session-fceb1ccc`：
 * 4 条声明边中 2 条 critical（`toSeq=18`）因 18 已墓碑化为 seq=53 而全丢。
 *
 * **映射源** = `GraphPruneRecord.intervals`（`prune-tx.ts:282/:300` 写 replace 时逐区间记录
 * `{start,end,tombstoneSeq}`；`rebuildLedgerFromLog` 亦从 `compaction/end` 重建）。
 * 同一 seq 多次替换时**后者胜**（取最新替身）；多跳链（墓碑再被墓碑替换）由调用侧迭代解析，
 * 本函数只给一跳。`start === tombstoneSeq` 的区间跳过（防自映射/自环）。
 *
 * ⚠️ **已知限制**：`rebuildLedgerFromLog` 重建的 `intervals` 把一次压缩的所有 seq 压成
 * **单条** `[first..last] → compaction/end seq`，而 end 是 **off-surface** 事件 ⇒
 * **resume（跨进程重载）后本表对多区间压缩无效**；同进程内为精确值。
 */
export function buildTombstoneRedirect(
  records: readonly { intervals: readonly { start: number; end: number; tombstoneSeq: number }[] }[],
): Map<number, number> {
  const map = new Map<number, number>()
  for (const rec of records) {
    for (const iv of rec.intervals) {
      for (let s = iv.start; s <= iv.end; s += 1) {
        if (s !== iv.tombstoneSeq) map.set(s, iv.tombstoneSeq)
      }
    }
  }
  return map
}

/**
 * 剪枝事务模块函数访问引擎状态所需的窄接口。
 * 仅列出各事务函数实际读写的字段与方法；hub 的 ArgpEngine 以
 * `this as unknown as PruneTxHost` 满足它。
 *
 * bindSession / atomize 以**方法引用**形式声明：调用时经传入实例分派（即 hub 的
 * class 方法），本模块因此**无需** import session-lifecycle（避免
 * session-lifecycle → prune-tx 的环）。
 * charsPerToken / recencyGuard / turnGuard 在 class 上是 getter——经 host 读取时
 * getter 以真实实例为 this 调用，语义与 this.<getter> 完全一致。
 */
export interface PruneTxHost {
  bindSession: (session: Session) => void
  atomize: (session: Session) => Atom[]
  log: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void }
  /** 会话态（台账/目录/召回预算/usage 锚点）分桶访问。 */
  stateOf: (session: Session) => SessionRuntimeState
  compactSourceCommandId: CommandId | undefined
  charsPerToken: number
  telemetryCap: number
}

/**
 * 一笔事务剪多个极大连续区间：start → summary → 每区间 checkpoint replace → end。
 * 发射前先做**相邻同文 user 墓碑归并**（surface 紧邻 + 文本逐字节相同 ⇒ 并条；
 * 2026-11-26 桩游程治理，见 pruneIntervals 内注释）。
 *
 * **2.2.2 根修（2026-11-26 session-43df801e 存档加载失败案）：surface replace 只允许
 * user 检查点。** tool/result 与 developer 形态的 replace 已从本模块整类删除——宿主
 * v4 fold 对它们执行 `requireTurn()`/`requireStep()`（加载侧 dsh-session-format-v3-to-v4），
 * 而压缩事务可能落在轮间隙（手动 /compact 是宿主 idle maintenance，实证
 * `compaction/start.data.turn === null`），此时无任何合法表达；写入侧 `Session.append`
 * 不拦 ⇒ 当场成功、下次加载整档判 corrupt 拒载。user 检查点不受轮/步约束，是唯一
 * 与压缩时点无关的合法 surface 写回形态。
 *
 * 结构性保证（不再依赖"计划时有开放轮"的时点判断）：
 *  - 本函数的 tombstones 参数类型只接受 `{type:'user'}`；其它形态在 TypeScript 层不可达，
 *    运行时另有防线（收到非 user 墓碑直接 throw，见函数头）。
 *  - 唯一剩余的 tool/result 语义（C10 夹剪文本 = 头尾留真预览）改由组剪检查点的
 *    **文本**承载（factor/engine.ts `groupCheckpointText`），不再改写 R 节点本体。
 */
export function pruneIntervals(
  host: PruneTxHost,
  session: Session,
  intervals: { seqs: number[]; chars: number; atoms: Atom[] }[],
  semanticEdges: number,
  candidateCount: number,
  forced: boolean,
  tombstones?: readonly ({ type: 'user'; text: string })[],
  summaryKind?: 'graph-prune' | 'tombstone-merge' | 'factor-prose' | 'factor-prune',
  /** §G2：LLM 摘要调用的真实账单/信封回填 compaction/summary（宿主字段词典；0-LLM 事务不传）。 */
  summaryMeta?: CompactionSummaryMeta,
): CompactionResult | null {
  const st = host.stateOf(session)
  // 运行时结构锁：TS 层已收窄为 user-only，这里防历史 JS 调用方/setup 绕过注入毒形态。
  for (const ts of tombstones ?? []) {
    const kind = (ts as { type?: unknown }).type
    if (kind !== 'user') {
      throw new Error('prune-tx: surface replace may only emit user/message checkpoints (got tombstone type '
        + JSON.stringify(kind) + '); host v4 fold rejects non-append tool/result outside an open turn — '
        + 'this shape was removed in 2.2.2 (session-43df801e archive-load failure)')
    }
  }
  const openTurnPre = detectOpenTurn(session)
  let useIntervals = intervals
  let useTombstones = tombstones

  // 位置序排序（2026-11-11 CB 四臂实锤 P0 修复）：调用方给的区间序 = 决策优先序
  // （factor 压力剪按 retention 最差优先逐条成区间；图剪按决策清单序），不是 surface 位置序
  // → 首尾位置倒挂直接撞下方 span 守卫整笔拒发 = 压力剪**静默蒸发**（CB 22 题 11 个会话中招，
  // factor 臂压缩大面积失效 → 上下文失控涨到 35K+ 撞 provider 槽墙，轮死呈 finish=length/1-token）。
  // 宿主契约（compaction/compaction/types.ts:107-117）明示：shadowedRange 是 surface **位置** span、
  // shadowedSeqs（surface 序）才是权威集——排序按 indexOf(seqs[0])；区间与墓碑**原子**换位，
  // 保住 resolvedTombstones[i] 逐位配对；未落位区间（indexOf=-1）稳定沉底，若仍为首尾之一
  // 则属真 span 损坏，守卫照拒（方向正确）。区间恒位置升序：sort 稳定 = 恒等，零行为变化。
  const txSurfaceNodes = session.surface.nodes
  const txPosOf = (iv: { seqs: number[] }): number => {
    const i = txSurfaceNodes.indexOf(asSeq(iv.seqs[0] as number))
    return i < 0 ? Number.MAX_SAFE_INTEGER : i
  }
  if (useIntervals.length > 1) {
    const order = useIntervals.map((_iv, i) => i)
    order.sort((a, b) => txPosOf(useIntervals[a] as { seqs: number[] }) - txPosOf(useIntervals[b] as { seqs: number[] }))
    const sortedIntervals = order.map(i => useIntervals[i] as { seqs: number[]; chars: number; atoms: Atom[] })
    if (useTombstones !== undefined && useTombstones.length === useIntervals.length) {
      const srcTs = useTombstones
      useTombstones = order.map(i => srcTs[i] as typeof srcTs[number])
    }
    useIntervals = sortedIntervals
  }
  // ---- 相邻同文墓碑归并（2026-11-26 session-43df801e 审计）----
  // 一笔 114 区间的扫荡在表面产出 run=96 的同 9 字桩连排：角色交替破坏，模型读到
  // 「用户连说 96 遍同一句话」。§11.8 归并通道随图臂退役（compactRegion 拒发），factor
  // 世界零桩治理。规则：区间在 surface.nodes 上**紧邻**（next.seqs[0] 恰随 prev 末 seq，
  // 中间无活体）且两条墓碑文本**逐字节相同** ⇒ 传递并条。同文相邻对模型本已不可分辨
  // ⇒ 归并零信息损失；交互/夹剪检查点文本含各自 keys/预览 ⇒ 不并（指针与信息语义保留）。
  // 2.2.2 根修后墓碑只剩 user 一种形态（tool/developer 结构桩整类删除）。
  // P1-5 数量校验随 resolved 计算上移到 start 事件之前：错配更早拒发，不再留 start+summary 死括号。
  if (useTombstones !== undefined && useTombstones.length !== useIntervals.length) {
    // 审查 P1-5：绝不能静默回退到 seq 指针墓碑（零指针纪律）；数量错配 = 调用方 bug。
    throw new Error('prune-tx: tombstone count mismatch (' + useTombstones.length + ' vs ' + useIntervals.length + '); refusing pointer fallback')
  }
  let resolvedTombstones: readonly { type: 'user'; text: string }[] =
    useTombstones !== undefined && useTombstones.length === useIntervals.length
      ? useTombstones
      : useIntervals.map(iv => ({
          type: 'user' as const,
          text: seqRangeTombstone(iv.seqs[0] as number, iv.seqs[iv.seqs.length - 1] as number),
        }))
  if (useIntervals.length > 1) {
    const txPosMap = new Map<number, number>()
    for (let i = 0; i < txSurfaceNodes.length; i += 1) txPosMap.set(txSurfaceNodes[i] as number, i)
    const mergedIntervals: typeof useIntervals = []
    const mergedTombstones: { type: 'user'; text: string }[] = []
    for (let i = 0; i < useIntervals.length; i += 1) {
      const iv = useIntervals[i] as { seqs: number[]; chars: number; atoms: Atom[] }
      const ts = resolvedTombstones[i] as { type: 'user'; text: string }
      const prevIv = mergedIntervals[mergedIntervals.length - 1]
      const prevTs = mergedTombstones[mergedTombstones.length - 1]
      let merged = false
      if (prevIv !== undefined && prevTs !== undefined && ts.text === prevTs.text) {
        const p = txPosMap.get(prevIv.seqs[prevIv.seqs.length - 1] as number)
        const q = txPosMap.get(iv.seqs[0] as number)
        if (p !== undefined && q === p + 1) {
          mergedIntervals[mergedIntervals.length - 1] = { seqs: [...prevIv.seqs, ...iv.seqs], chars: prevIv.chars + iv.chars, atoms: [...prevIv.atoms, ...iv.atoms] }
          merged = true
        }
      }
      if (!merged) {
        mergedIntervals.push({ seqs: [...iv.seqs], chars: iv.chars, atoms: [...iv.atoms] })
        mergedTombstones.push(ts)
      }
    }
    useIntervals = mergedIntervals
    useTombstones = mergedTombstones
    resolvedTombstones = mergedTombstones
  }
  const charsBefore = visibleChars(session)
  const openTurn = openTurnPre
  // 'argp-graph-' = 历史 wire 前缀（会话日志既有形态）：非压缩时点零改写不变量 + 旧日志
  // 零成本兼容 ⇒ **勿随 2.1.0 类名重构（ArgpGraphEngine→ArgpEngine）改动**（design-2.1.0-batch §1.7）。
  const compactionId = CompactionId('argp-graph-' + randomUUID())
  const lifecycle = { compactionId, turn: openTurn }
  // /compact 溯源：发起命令 ID 随事务事件落账（UI presentation correlation）。
  // sourceCommandId 一致性契约（宿主 dsh-compaction invariant validateSourceCommandId +
  // v3-to-v4 relationships.compactionOwner）：start/summary/end 三事件必须携带**同一个**
  // sourceCommandId——只 start 带而 summary/end 不带，加载期 v3-to-v4 fold 会 throw
  // "no matching compaction/start"（2026-09-23 实测：/compact 过的会话无法重新加载）。
  // 故把可选字段提出来，三个事件统一展开（自动压缩时 compactSourceCommandId 为 undefined，
  // 三事件一致为 undefined，同样满足契约）。
  const sourceCommandIdField: { sourceCommandId?: CommandId } =
    host.compactSourceCommandId === undefined ? {} : { sourceCommandId: host.compactSourceCommandId }
  const allSeqs = useIntervals.flatMap(iv => iv.seqs)
  const first = useIntervals[0]?.seqs[0] ?? 0
  const last = useIntervals[useIntervals.length - 1]?.seqs[useIntervals[useIntervals.length - 1]!.seqs.length - 1] ?? first

  const startEvent = session.append('compaction/start', {
    ...lifecycle,
    ...sourceCommandIdField,
  })
  // 事务括号配对守卫（2026-09-23）：成功 end 之后仍有可抛语句（checkpoint 记 seq、记账、
  // 锚点重置、返回体构造），一旦抛出，catch 会再补一条 end ⇒ 同一 compactionId 出现**两条** end。
  // 写入侧不校验，加载期第二条 end 命中 invariant 的
  // "compaction/end has no matching compaction/start" ⇒ 会话永久打不开。ended 保证恰好一条 end。
  let ended = false
  try {
    const shadowedTokenCount = shadowedTokensOf(useIntervals.reduce((s, iv) => s + iv.chars, 0))
    // ---- compaction/summary 先于 prune/replace 循环发出（宿主 span() 契约，Issue #2 同类修复）----
    // 旧实现在整轮墓碑 replace 循环**之后**才发 summary，shadowedSeqs 取 pre-replace 原原子
    // （多区间在 surface 上不连续）——到 summary 被接收时原原子已离开 surface，加载期
    // span() 命不中 current surface span（休眠 bug：全库 0 条 argp-graph-* 事件、从未实测触发）。
    // 修法同 peratom flush：summary 移到循环**之前**（发出时刻整段仍完整），shadowedSeqs 取
    // 整段 [first,last] 的连续 surface 切片（surface 顺序），逐区间 prune+replace 随后落在段内；
    // 防御自检：整段不是当前 surface 的有效连续 span（或覆盖受保护 system head）时直接 throw，
    // catch 落带 error 的 end（不发 summary），宁可本轮不剪，也不写"落盘静默成功、重启才炸"的坏记录。
    const surfaceNodes = session.surface.nodes
    const startIdx = surfaceNodes.indexOf(asSeq(first))
    const endIdx = surfaceNodes.indexOf(asSeq(last))
    if (startIdx < 0 || endIdx < startIdx) {
      throw new Error(`prune-tx: range [${first}, ${last}] is not a valid current surface span (startIdx=${startIdx}, endIdx=${endIdx}); refusing to emit a corrupt compaction/summary`)
    }
    if (startIdx === 0) {
      const headEvent = sessionEvents(session)[surfaceNodes[0]]
      if (headEvent !== undefined && headEvent.type === 'system/message') {
        throw new Error('prune-tx: range covers the protected system head; refusing to emit a corrupt compaction/summary')
      }
    }
    const rangeSeqs = surfaceNodes.slice(startIdx, endIdx + 1)
    // 人类可读剪枝摘要（2026-08-28 UI 联调）：compaction 节点的展示文本来自
    // compaction/summary 事件；不发则 WebUI 显示"压缩摘要不可用"。off-surface
    // 日志事件，模型不可见。payload 按 CompactionSummary 词典填诚实值，类型走 as never。
    const prunedCount = useIntervals.reduce((sum, iv) => sum + iv.atoms.length, 0)
    const charsBefore0 = useIntervals.reduce((sum, iv) => sum + iv.chars, 0)
    session.append('compaction/summary', {
      ...lifecycle,
      ...sourceCommandIdField,
      summary: [{
        type: 'text',
        text: summaryKind === 'tombstone-merge'
          // 归并事务的区间 atoms 恒空（剪的是桩本身）⇒ 计数取表面节点数，不取 atoms。
          ? `ARGP 墓碑归并（§11.8①）：${useIntervals.reduce((s, iv) => s + iv.seqs.length, 0)} 墓碑 / ${useIntervals.length} 区间归并为聚合占位（约 ${shadowedTokensOf(charsBefore0)} tok 回收）；0-LLM；原文保留在 append-only 日志，search_history(keyword) / recall_history(labels) 可取回`
          : summaryKind === 'factor-prune'
            ? `ARGP 协议组剪：${prunedCount} 原子 / ${useIntervals.length} 区间（约 ${shadowedTokensOf(charsBefore0)} tok）；A+R 组整体离场 + 压缩检查点占位（普通组中性标记「已压缩剪枝次要原子」；交互组专段带 tool: 即时指针）；原文保留在 append-only 日志，recall_history(labels) 可取回`
            : summaryKind === 'factor-prose'
              ? `ARGP 散文浓缩：${prunedCount} 原子 / ${useIntervals.length} 区间（约 ${shadowedTokensOf(charsBefore0)} tok）；清扫式合并（焦点外前缀一轮全吞，§9.36 H2 终裁）+ one-shot 原生式 LLM 浓缩（输入=U+final A/textA，工具原子零进）；无逐字转写带（原始信息有 recall 兜底），整轮段无逐原子墓碑`
              : `ARGP 图剪：${prunedCount} 原子 / ${useIntervals.length} 区间（约 ${shadowedTokensOf(charsBefore0)} tok）；确定性排序，0-LLM；原文保留在 append-only 日志，recall_pruned(seq) / list_pruned 可取回`,
      }],
      shadowedRange: { start: first, end: last },
      shadowedSeqs: rangeSeqs,
      shadowedTokenCount: shadowedTokensOf(charsBefore0),
      provider: summaryMeta?.provider ?? 'argp',
      model: summaryMeta?.model ?? (summaryKind === 'factor-prose' ? 'llm-prose-checkpoint' : 'deterministic-guards'),
      ...(summaryMeta?.usage !== undefined ? { usage: summaryMeta.usage } : {}),
      ...(summaryMeta?.maxTokens !== undefined ? { maxTokens: summaryMeta.maxTokens } : {}),
      ...(summaryMeta?.rawOutput !== undefined ? { rawOutput: summaryMeta.rawOutput } : {}),
      ...(summaryMeta?.llmStreamCall === true ? { llmStreamCall: true } : {}),
    } as never)
    // P1-5 校验与 resolvedTombstones（含相邻同文归并）已上移至事务开始**之前**
    // （2026-11-26 桩游程治理）：错配拒发不再留下已落盘的 start+summary 死括号。
    const intervalRecords: { start: number; end: number; tombstoneSeq: number }[] = []
    let firstPruneSeq: number | undefined
    for (let i = 0; i < useIntervals.length; i += 1) {
      const iv = useIntervals[i]
      if (iv === undefined) continue
      const start = iv.seqs[0] as number
      const end = iv.seqs[iv.seqs.length - 1] as number
      // Shadow-price 契约（宿主 token-meter foldSurfaceProjection）：compaction/prune 的
      // shadowedRange 必须与紧随其后的 surface replace 范围**严格相等**，否则重放投影 throw
      // （2026-09-01 实测：多区间事务发一个总跨度 claim 再逐区间 replace，第一个 replace
      // 即撞总 claim → resume 报 "no adjacent shadow price"）。故每区间一个 shadow-price
      // 事件，范围=该单区间，与官方 compaction-tool-result-pruner 同模式；末尾 summary 的
      // 总范围 claim 被紧随的 off-surface compaction/end 清掉，无契约冲突。
      const intervalPrune = session.append('compaction/prune', {
        shadowedRange: { start: asSeq(start), end: asSeq(end) },
        shadowedSeqs: asSeqs(iv.seqs),
        shadowedTokenCount: shadowedTokensOf(iv.chars),
      })
      if (firstPruneSeq === undefined) firstPruneSeq = intervalPrune.seq
      const ts = resolvedTombstones[i]
      // 2.2.2 根修：surface replace 只有 user 检查点一种合法形态（tool/developer 分支已整类
      // 删除）。文本来源：调用方给定（普通/交互/夹剪预览检查点），缺省为 seq 区间墓碑。
      const text = ts !== undefined
        ? ts.text
        : seqRangeTombstone(iv.seqs[0] as number, iv.seqs[iv.seqs.length - 1] as number)
      const tombstone = session.append('user/message', createUserMessage({
        content: [{ type: 'text', text }],
        // checkpoint 的 source.sourceCommandId 必须与 start 一致（宿主 invariant
        // validateCheckpoint → validateSourceCommandId）：/compact 手动压缩时传发起命令 ID，
        // 自动压缩时 compactSourceCommandId 为 undefined（与 start 一致为 undefined）。
        source: compactCheckpointSource(compactionId, host.compactSourceCommandId),
      }), {
        surfaceOp: { op: 'replace', startSeq: asSeq(start), endSeq: asSeq(end) },
        sourceEventSeqs: asSeqs([startEvent.seq, intervalPrune.seq, ...iv.seqs]),
      })
      intervalRecords.push({ start, end, tombstoneSeq: tombstone.seq })
    }
    // compaction/end 不携带 catalog 快照域（旧日志里的该字段仍原样保留，只是没有读者）。
    const endEvent = session.append('compaction/end', {
      ...lifecycle,
      ...sourceCommandIdField,
    })
    ended = true
    // 批次 3-5（beta.1）：事务后 tool-pairing 不变量审计——per-atom 墓碑保配对是设计保证，
    // 此处是对该保证的可观测护栏）。任何悬空 tool_call 必然穿过 surface 尾切，对最后
    // 一个节点做一次 toolPairingBalancedAfter 即全局检测；孤儿 tool result 会使助手
    // throw，同计违例。事务已提交：只观测不改写（错误日志 + auditWarnings 留痕）。
    try {
      const postNodes = session.surface.nodes
      const tail = postNodes[postNodes.length - 1]
      if (tail !== undefined && !toolPairingBalancedAfter(session, tail)) {
        throw new Error('unanswered tool call crosses the trailing surface cut')
      }
    } catch (pairError: unknown) {
      const pairMsg = 'tool-pairing invariant violated after compaction: '
        + (pairError instanceof Error ? pairError.message : String(pairError))
        + ' (transaction committed; observability guard)'
      host.log.error('[argp-engine] ' + pairMsg)
      st.auditWarnings.push(pairMsg)
      if (st.auditWarnings.length > host.telemetryCap) st.auditWarnings.shift()
    }
    const charsAfter = visibleChars(session)
    pushBounded(st.records, {
      at: new Date().toISOString(),
      compactionId,
      ...host.compactSourceCommandId === undefined ? {} : { sourceCommandId: host.compactSourceCommandId },
      intervals: intervalRecords,
      startEventSeq: startEvent.seq,
      summaryEventSeq: firstPruneSeq ?? startEvent.seq,
      endEventSeq: endEvent.seq,
      shadowedSeqs: allSeqs,
      prunedAtoms: useIntervals.flatMap(iv => iv.atoms.map(a => ({ id: a.id, type: a.type, seq: a.seq }))),
      semanticEdges,
      candidates: candidateCount,
      charsBefore,
      charsAfter,
      forced,
    }, host.telemetryCap)
    // P7：一笔 compaction 事务成功即重置 recall 字数预算（视图已换代，旧累计不应继续压制新一轮召回）；
    // 2026-11-14 起预算另有跨轮重置（recall.ts budgetRecallText 轮变归零），此处归零保留为双保险。
    st.recallCharsUsed = 0
    // 2026-08-23：压缩换代 surface——旧真实锚点（压缩前的 provider usage）失效，
    // 若保留会用大锚点 + 增量导致压缩后立即误触发。用压缩后 surface 估算重置锚点
    // （压缩后 surface 小、估算误差影响小；下一次请求的 usage 会再次精确锚定）。
    // 锚点语义（budget.measureTokens 同口径）：lastRealPromptTokens 覆盖 seq < anchor
    // 的事件，增量按 seq >= anchor 计。这里 promptTokens 是**当前 surface 全量估算**
    // （已含刚落的墓碑/检查点），故 anchor 必须取 log 尾后的下一个 seq（session.seq），
    // 否则中间位置的替换副本会被 delta 二次计入（prose 检查点可达 20K tok）。
    // Issue5：锚点重置换 CJK 加权估算（审查 F4：这里是「标着 anchored 的 chars 估算
    // 敞口」——不改则压缩换代后 3.5 偏差原样回归）。非 CJK surface = chars/3.5 逐字等价。
    const anchorStats = visibleCharStats(session)
    st.lastRealPromptTokens = Math.ceil(estTokensFromStats(anchorStats.chars, anchorStats.cjk))
    st.lastRealAnchorSeq = session.seq
    // 永久冻结：落剪不再刷新 frozenCatalog（见 bindSession 注释）。剪枝本身已让可见上下文换代，
    // 那一步的前缀缓存失效是上下文真实变更的必然代价；但 catalog 文本恒定，不在这条路上再变一次。
    return {
      compactionId,
      startSeq: asSeq(startEvent.seq),
      summarySeq: asSeq(firstPruneSeq ?? startEvent.seq),
      endSeq: asSeq(endEvent.seq),
      summary: resolvedTombstones.map(ts => ({ type: 'text', text: ts.text })),
      shadowedRange: { start: asSeq(first), end: asSeq(last) },
      shadowedSeqs: asSeqs(allSeqs),
      shadowedTokenCount,
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    // ended 为真 ⇒ 成功 end 已落地，此处**不可**再补 end（否则双 end，重启必炸）。
    if (!ended) {
      try {
        session.append('compaction/end', { ...lifecycle, ...sourceCommandIdField, error: message })
      } catch {
        // 关闭失败保留未配对 start，可被 inspectCompactionEntryState 检出
      }
    }
    throw error
  }
}
