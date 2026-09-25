/**
 * ARGP 剪枝选择模块（P5 结构重构 Wave 3 第 4 步，C 报告 §4 A 表）。
 *
 * 从 3,380 行 hub `argp-graph-engine.ts`（God Class）拆出的**剪枝选择侧**函数：
 * 单原子/组候选判定（isAtomCandidate / isGroupCandidate）+ 排序键（sortKey）
 * + 区间归并（mergeIntervals）+ tombstone 生成（buildTombstones）+ 闭包选择
 * （selectClosureToMerge）+ 它们的共享类型（PruneInterval / PruneTombstone /
 * PruneState / PrunedNodeInfo）。
 *
 * 循环 import 规避（C 报告关键设计决策 1）：本模块**不** import hub 运行时。
 * selectClosureToMerge 需要读/写引擎可变字段（nextClosureId++ / closureLastRecalled /
 * closureWindowK），接收窄接口 {@link PruneSelectionHost} 而非具体 class；hub 的
 * class 以 `this as unknown as PruneSelectionHost` 传入（编译期断言，运行时即真实
 * 实例，私有字段经 host 类型可读写/重赋值）。依赖方向：hub → prune-selection（单向）。
 *
 * 行为逐字节不变：函数体逻辑逐字保留（this.x → host.x），仅 `this` 换 `host`。
 * isAtomCandidate / isGroupCandidate / sortKey / mergeIntervals / buildTombstones
 * 为纯函数（无 this，入参显式 state）。
 */
import type { Session } from '@deepseek-ai/dsh-session'
import type { Atom, AtomType, SemanticEdge, DeterministicEdge } from './argp-types.js'
import { LEVEL_ORDER } from './argp-types.js'
import { TOMBSTONE_MAX_CHARS, closureTombstone, isTombstoneText, seqRangeTombstone } from './tombstone-text.js'

/** 剪枝区间（区间归并产物）。hasSoloR = 区间含「issuer A 未被剪」的独立 R（tool 占位墓碑配对约束）。 */
export interface PruneInterval {
  seqs: number[]
  chars: number
  atoms: Atom[]
  hasSoloR: boolean
}

/** 区间 tombstone 规格：user 文本墓碑 或 tool 占位墓碑（保留 callId 配对 issuer A 的 tool_calls）。 */
export type PruneTombstone = { type: 'user'; text: string } | { type: 'tool'; seq: number; callId: string }

/**
 * compactIfNeeded 拆出纯函数共享的显式 state：原 3 个闭包捕获的 this 字段与局部量。
 * - turnGuard / sortMode / charsPerToken：原闭包读 this.<getter>；此处快照为值（方法执行期间
 *   guardOverride/argpSettings 稳定，快照等价）。
 * - curInDegree / curInDegreeDecl：每 pass 重推（链式解锁），方法内每 pass 更新本字段，
 *   纯函数按调用时读取当前 pass 值（与原闭包捕获 let 绑定的语义一致）。
 * - chainLen：findVersionDuplicates 产物；仅 sortKey 使用，且 sortKey 只在 pass 循环内调用
 *   （届时已回填），构造期占位空 Map 不会被读到。
 */
export interface PruneState {
  turnGuard: number
  askCoverage: Map<number, number>
  position: Map<number, number>
  recencyCut: number
  latestTurn: number
  edges: SemanticEdge[]
  atoms: Atom[]
  curInDegree: Map<number, number>
  curInDegreeDecl: Map<number, number>
  deterministicEdges: DeterministicEdge[]
  touchesSemantic: Set<number>
  eff: Map<number, number>
  sortMode: 'legacy' | 'density' | 'density-chain'
  chainLen: Map<number, number>
  lastRef: Map<number, number>
  charsPerToken: number
  /** 1.5.1：A 原子有效体积（字符）= 自身文本 + 其应答 R 之和（drag 集合）。仅带 tool-call 的 A 有值。 */
  aGroupChars: Map<number, number>
}

/**
 * 单原子剪枝候选判定（原 compactIfNeeded 内 isAtomCandidate 闭包，逐字保留 this.x→state.x）。
 * ask-exempt U（dialog）须被首个 A 的 supporting 边覆盖才参剪；A/R/U-info 走
 * recencyGuard/turnGuard/citesFailed/A10 结构保护/入度门槛。
 *
 * C（B3）起：A10 结构保护多一条**前置放行**——组内 R 全部已立碑 ⇒ 该组已收割完毕，
 * 保护失去对象，A 照常参剪（详见下方 A10 块注释）。
 */
export function isAtomCandidate(a: Atom, allowInDegree: boolean, state: PruneState): boolean {
  if (a.type === 'U' && a.sourceSeq === undefined) {
    // 普通 U（含 task-init dialog）：ask-exempt 路径——须被首个 A 的 supporting
    // 边覆盖才参剪。dialog 永不剪不变（无覆盖 → 不可剪）。
    const coverer = state.askCoverage.get(a.id)
    if (coverer === undefined) return false
    const pos = state.position.get(a.seq)
    if (pos === undefined || pos >= state.recencyCut) return false
    if (a.turn > state.latestTurn - state.turnGuard) return false
    // 动态复核：所有保留入边都必须来自覆盖者，否则豁免失效
    const incoming = state.edges.filter(e => e.to === a.id)
    if (incoming.length === 0 || incoming.some(e => e.from !== coverer)) return false
    return true
  }
  // P4：U-info（a.sourceSeq 有值）按 R 待遇参剪——跳过 ask-exempt（其不是 ask
  // 文本、永远拿不到覆盖），走下方与 A/R 相同的 recencyGuard/turnGuard/
  // citesFailed/入度门槛。dialog 不受影响（仍走上方 ask-exempt 分支）。
  if (a.type !== 'A' && a.type !== 'R' && a.type !== 'U') return false
  // G1（1.7.1）：已立碑 = 终止态。
  //
  // 病灶：1.7.0 的 isAtomCandidate 没有任何"已是墓碑"判定，只看位置/年龄/citesFailed/
  // A10/入度 ⇒ 42 字符的 tool 占位墓碑（type 仍是 'R'，与普通 R 原子无区别）满足全部
  // 条件 ⇒ **每轮重新入候选**，每轮产出一条同等长度的新墓碑。实测 session-16188a24：
  // replace 事件 2,047 中 **1,560（76.2%）**是"墓碑换墓碑"，收益恒为 0；链式证据
  // `seq 17 (115c) → 708 → 1578 → 3136 → 3926 → 4729 → 5496 → 6274`，链长分布
  // `{5:109, 6:105, 9:78}`，每一步收益为 0；30 个 compaction/start 却产生 2,045 个
  // compaction/prune。逻辑上是 2026-08-23 半拆组的回归（解绑前 R 受 A10 连带保护，
  // 解绑后墓碑成了独立候选）。
  //
  // 长度安全阀（TOMBSTONE_MAX_CHARS）：极长墓碑仍允许参剪，避免地板卡死。
  // 归并（consolidateTombstones / isMergeableTombstoneText）走**事件层**，不经本函数，
  // 故"地板靠归并压下去"的机制不受影响。user 墓碑（X 类）在上一行已被排除——本行
  // 显式化的是同一件事，语义更清楚且覆盖 R 墓碑（真正的空转来源）。
  if (isTombstoneText(a.text) && a.text.length <= TOMBSTONE_MAX_CHARS) return false
  const pos = state.position.get(a.seq)
  if (pos === undefined || pos >= state.recencyCut) return false
  if (a.turn > state.latestTurn - state.turnGuard) return false
  if (a.citesFailed) return false
  // A10（必补，收窄版）：A 带 R 组但漏 cites 时，该 A 对 R 无语义边 → 闭包守卫（inDegreeByClosure）
  // 防不住整闭包被剪。但**仅当组内 R 均无来自组外的其他入边**才结构性保护（设计 §4 收窄版 + 问题 1 修订）：
  //  - A 漏 cites 且 R 无任何外部入边（组内只有 issuer 的确定性配对边）→ 整组失去外部保护，
  //    A 不可剪（防整闭包被剪；单轮 1U+1A+1R 探针场景即此形态，**应保护**——评审探针的
  //    “工具 A 永久不可剪”是旧版无脑全保护的结论，收窄后仅漏 cites 且无外部引用的组受保护）
  //  - R 被组外原子 cites 或引用（语义入度 >0，或来自其他 A 的确定性边）→ R 已被外部保护，A 照常可剪
  //  - A 有 cites 指向组内 R → 有边，不触发保护
  // 判定依据：语义边（edges）+ 确定性边（deterministicEdges）均只数「组外来源」——
  // 组内 issuer 自己的配对边不算“其他入边”，否则“有 R 就保护”退化为无脑全保护（问题 1）。
  // force_prune（allowInDegree=true）路径同样走此判定——结构性保护优先于强制降级。
  if (a.type === 'A' && a.toolCallIds.length > 0) {
    const groupIds = new Set<number>([a.id])
    const groupRs = state.atoms.filter(x => x.type === 'R' && a.toolCallIds.includes(x.toolCallIds[0] ?? ''))
    for (const r of groupRs) groupIds.add(r.id)
    if (groupRs.length > 0) {
      // C（B3）：组内 R **全部已立碑** ⇒ 该组已被收割完毕 ⇒ A10 失去保护对象，放行。
      //
      // 病灶：本处的 groupRs 用 `toolCallIds` 匹配，而 stub **完整继承原 callId**
      // （实测 1,971/1,971）⇒ **R 被立碑后 groupRs 仍非空** ⇒ "收割过的组"在 A10 眼里
      // 与"没收割过的组"完全一样 ⇒ A 被永久结构保护。A0 闸级重放实测（session-16188a24，
      // `npm run gate-replay`）：末态活体 A 388 条里 **371 条（95.6%）的首个拦截闸就是本处**；
      // 其中 **312 条的 R 组早已全部是墓碑** —— 此时保护已无意义：R 的内容早已不在 surface
      // 上，A10 保住的只是 A 自己的 tool-call 参数，却让整组永久占位
      // （实测 268,086 字符 ≈ 103.2K tok，见 docs/plan-compaction-fixes §7.6）。
      //
      // 判据 = `isTombstoneText`（全四族、**不设长度上限**）：与量出那 312 个靶子的口径
      // 逐字一致（`spike/47-gate-replay.ts` ⑤ 段 / `scripts/step-audit.mjs`）。
      // ⚠️ 两点不要"顺手改"：
      //  - **不用 `isToolTombstoneText`**（窄口径）：R 的墓碑也可能是区间/闭包族，按 tool 族
      //    过滤会与靶子口径漂移（A10 放过一部分、另一部分仍锁）；
      //  - **不套 `TOMBSTONE_MAX_CHARS` 安全阀**：该阀服务于 G1 的"地板卡死"（长墓碑说明
      //    还有东西可丢），与"内容是否已不在 surface"是两件不同的事。
      //
      // 放行后 A 并不"随便剪"：仍要过下方第 5 道闸（`curInDegree`）与位置/年龄守卫；
      // 且必须**整组退场**（A 被剪 ⇒ 其全部 R 同批进 pruned），由 `argp-graph-engine.ts`
      // pass 循环的 drag 分支 + 剪前回退保护负责 —— 否则留下的 `tool/result` 失去配对
      // A ⇒ 孤儿 `role:'tool'` 消息 ⇒ provider 400。
      const allStubbed = groupRs.every(r => isTombstoneText(r.text))
      if (!allStubbed) {
        const aCitesR = state.edges.some(e => e.from === a.id && groupRs.some(r => e.to === r.id))
        // R 的外部入边：语义边来自组外原子，或确定性边来自组外原子（其他 A 调用了同一 callId 链）
        const anyRExternalIncoming = groupRs.some(r =>
          (state.curInDegreeDecl.get(r.id) ?? 0) > 0 || // 语义**声明**入度（cites/inject）——排除 inferred（见上方实验注释）
          state.deterministicEdges.some(e => e.to === r.id && !groupIds.has(e.from))) // 确定性：组外 A→R
        if (!aCitesR && !anyRExternalIncoming) return false
      }
    }
  }
  if (!allowInDegree && (state.curInDegree.get(a.id) ?? 0) > 0) return false
  return true
}

/** 组候选判定（原 isGroupCandidate 闭包）：组内全部原子均候选。 */
export function isGroupCandidate(g: Atom[], allowInDegree: boolean, state: PruneState): boolean {
  return g.every(a => isAtomCandidate(a, allowInDegree, state))
}

/**
 * 排序键（原 sortKey 闭包，§4.5 + spike 18 提案）：默认 legacy = [lvl, eff, lastRef, seq]；
 * density = eff 同档内 token 降序（大 token 先剪）；density-chain = density + 链代表 eff 叠加。
 * 键格式 = 定宽补零整数以 '|' 连接；**比较必须走 compareSortKeys**（localeCompare 对
 * 负数组件方向反了，见 1.5.1 修复）。
 */
export function sortKey(a: Atom, state: PruneState): string {
  const lvl = state.touchesSemantic.has(a.id) ? LEVEL_ORDER.supporting : LEVEL_ORDER.isolated
  const effV = state.eff.get(a.id) ?? 0
  if (state.sortMode === 'legacy') {
    return [lvl, effV, state.lastRef.get(a.id) ?? 0, a.seq].map(n => String(n).padStart(10, '0')).join('|')
  }
  const chainBonus = state.sortMode === 'density-chain' ? (state.chainLen.get(a.id) ?? 1) - 1 : 0
  // density/density-chain：token 降序（负数入键，大 token 数值小排前）。
  // 1.5.1：带 tool-call 的 A 有效体积 = 自身文本 + 其应答 R 之和（drag 集合）——剪 A 必无条件
  // 连带剪其 R（防孤儿 tool 400），排序须把 R 体积计入 A，否则"能带走大 R 的 A"排不到前面，
  // 贪心达标慢、大 R 死重滞留。
  const ownChars = a.type === 'A' && a.toolCallIds.length > 0 ? (state.aGroupChars.get(a.id) ?? a.text.length) : a.text.length
  const tokNeg = -Math.ceil(ownChars / state.charsPerToken)
  return [lvl, effV + chainBonus, tokNeg, state.lastRef.get(a.id) ?? 0, a.seq].map(n => String(n).padStart(10, '0')).join('|')
}

/**
 * 排序键数值比较（1.5.1 修复 localeCompare 符号 bug）。
 *
 * 病灶：localeCompare 的 locale 排序把 '-' 当可变权重字符、主比较级忽略 ⇒ 负数组件
 * （density 档 token 降序键）在**同位数**内比较方向反了（'-18' 排在 '-24' 前，而意图
 * 是"大 token 先剪" = -24 排前）；跨位数时补零位移又碰巧方向对 ⇒ 表现为"大致按
 * 绝对值升序"，与设计意图相反。
 * 修法：键格式不变（定宽补零整数以 '|' 连接），比较改为按组件数值比较。
 * ⚠ 关键坑：padStart(10,'0') 对负数把 0 塞到负号**前**，产出 "0000000-18" 这种
 * Number() 无法解析的串（= NaN）⇒ 朴素 `Number(xc[i])` 让比较恒返 NaN ⇒ Array.sort
 * 视其为相等 ⇒ 排序退化为"保 surface 原序"的 no-op（drag 权重完全失效）。
 * 故须先剥掉负号前的前导 0 还原 "-18" 再解析；非负组件无 '-'，replace 不命中、行为不变。
 */
export function compareSortKeys(x: string, y: string): number {
  const parse = (s: string): number => Number(s.replace(/^0+(?=-)/, ''))
  const xc = x.split('|')
  const yc = y.split('|')
  for (let i = 0; i < xc.length; i += 1) {
    const d = parse(xc[i] as string) - parse(yc[i] as string)
    if (d !== 0) return d
  }
  return 0
}

/**
 * 区间归并（原 compactIfNeeded 内区间归并段，逐字保留）。
 * 按极大连续区间归并 pruned 原子；R 原子（issuer A 未被剪）强制单独成区间（tool 占位墓碑
 * 的 surface replace 必须恰好替换 1 节点）；双向守卫防孤儿 tool 消息；
 * 区间可见量 < minSpanChars 的放回（不剪）。
 * 入参 = pruned 原子集合 + position/issuerByCall 局部量 + minSpanChars（原 this.minSpanChars）；
 * 出参 = 归并后区间 kept + droppedIntervals（放回区间数，原方法内计算但未被读取，保留以逐字对应）。
 */
export function mergeIntervals(
  pruned: Map<number, Atom>,
  position: Map<number, number>,
  issuerByCall: Map<string, Atom>,
  minSpanChars: number,
): { kept: PruneInterval[]; droppedIntervals: number } {
  const prunedSeqs = [...pruned.values()].map(a => a.seq).sort((x, y) => x - y)
  const intervals: PruneInterval[] = []
  for (const seq of prunedSeqs) {
    const a = [...pruned.values()].find(x => x.seq === seq)
    if (a === undefined) continue
    const isSoloR = a.type === 'R' && a.toolCallIds[0] !== undefined
      && (() => {
        const issuer = issuerByCall.get(a.toolCallIds[0] as string)
        return issuer !== undefined && !pruned.has(issuer.id)
      })()
    const lastInterval = intervals[intervals.length - 1]
    const prevPos = lastInterval !== undefined ? position.get(lastInterval.seqs[lastInterval.seqs.length - 1] as number) : undefined
    const curPos = position.get(seq)
    if (!isSoloR && lastInterval !== undefined && lastInterval.hasSoloR === false
      && prevPos !== undefined && curPos !== undefined && curPos === prevPos + 1) {
      lastInterval.seqs.push(seq)
      lastInterval.chars += a.text.length
      lastInterval.atoms.push(a)
    } else {
      intervals.push({ seqs: [seq], chars: a.text.length, atoms: [a], hasSoloR: isSoloR })
    }
  }
  const keptRaw = intervals.filter(iv => iv.chars >= minSpanChars)
  // 2026-08-23 兜底防线：双向守卫后结构上不应再出现「混剪区间含 issuer 存活的 R」，
  // 但降级路径不能假设不变式处处成立——最后校验一遍，违例则把该 R 原子拆出成独立区间；
  // 拆后原区间低于微剪枝下限则整段放回（宁可不剪，不破配对）。
  const kept: typeof keptRaw = []
  const rescued: typeof keptRaw = []
  for (const iv of keptRaw) {
    if (iv.seqs.length <= 1) { kept.push(iv); continue }
    const rest = { seqs: [] as number[], chars: 0, atoms: [] as Atom[], hasSoloR: false }
    for (const a of iv.atoms) {
      const soloHere = a.type === 'R' && a.toolCallIds[0] !== undefined
        && (() => {
          const issuer = issuerByCall.get(a.toolCallIds[0] as string)
          return issuer !== undefined && !pruned.has(issuer.id)
        })()
      if (soloHere) rescued.push({ seqs: [a.seq], chars: a.text.length, atoms: [a], hasSoloR: true })
      else { rest.seqs.push(a.seq); rest.chars += a.text.length; rest.atoms.push(a) }
    }
    if (rest.chars >= minSpanChars) kept.push(rest)
  }
  kept.push(...rescued)
  kept.sort((x, y) => (x.seqs[0] as number) - (y.seqs[0] as number))
  const droppedIntervals = intervals.length - kept.length
  return { kept, droppedIntervals }
}

/**
 * 区间 tombstone 生成（原 compactIfNeeded 内 tombstone 段，逐字保留；1.7.1 文案收敛）。
 * 区间原子全部来自同一闭包 → 闭包 tombstone（带 root/计数，recall 消歧）；
 * 单 R 区间（issuer A 未被剪）→ tool 占位墓碑（保留 callId 配对 A 的 tool_calls）；
 * 否则默认 user 文本墓碑。
 *
 * 1.7.1（G2/G3）：文案不再在本函数内拼接，统一走 `tombstone-text.ts` 生成器
 * （此前区间文案在本函数、`prune-tx` 的两处 fallback 里各存一份，共 3 份拷贝）。
 * `forced` 保留入参但**不再影响文案**：新文案把"被剪的是什么 / 怎么取回"交给 system
 * 契约说一次，强制降级的标记随之取消（原 `, forced` 后缀）——它只对诊断有意义，而
 * `GraphPruneRecord.forced` 已记录该事实。
 */
export function buildTombstones(
  kept: PruneInterval[],
  closureSeqMeta: Map<number, { closureId: string; rootPreview: string; closureTotal: number }>,
  issuerByCall: Map<string, Atom>,
  pruned: Map<number, Atom>,
  forced: boolean,
): PruneTombstone[] {
  void forced
  return kept.map(iv => {
    const start = iv.seqs[0] as number
    const end = iv.seqs[iv.seqs.length - 1] as number
    const metas = iv.atoms
      .map(a => closureSeqMeta.get(a.seq))
      .filter((m): m is { closureId: string; rootPreview: string; closureTotal: number } => m !== undefined)
    const first = metas[0]
    if (first !== undefined && metas.every(m => m.closureId === first.closureId)) {
      return { type: 'user' as const, text: closureTombstone(first.closureId, start, end, first.rootPreview) }
    }
    const r0 = iv.atoms[0]
    if (iv.atoms.length === 1 && r0.type === 'R' && r0.toolCallIds[0] !== undefined) {
      const issuer = issuerByCall.get(r0.toolCallIds[0])
      if (issuer !== undefined && !pruned.has(issuer.id)) {
        return { type: 'tool', seq: r0.seq, callId: r0.toolCallIds[0] }
      }
    }
    return { type: 'user' as const, text: seqRangeTombstone(start, end) }
  })
}

/** list_pruned 工具的剪枝节点目录条目。 */
export interface PrunedNodeInfo {
  seq: number
  type: AtomType
  turn: number
  firstLine: string
  citedBySeq: number[]
  /** 被剪瞬间的有效重要性（recall 价值继承的来源，§3-3）。 */
  eff: number
  /** 版本链重定向（2026-08-23）：被剪旧快照 recall 时，指向同一路径（tool name+arguments）下最新存活版本的 seq。
   *  未参与版本链去重的被剪节点无此字段（undefined）。 */
  latestOfPath?: number
}

/**
 * 闭包选择模块函数访问引擎状态所需的窄接口（C 报告关键设计决策 1）。
 * 仅列出 selectClosureToMerge 实际读写的字段；hub 的 ArgpGraphEngine 以
 * `this as unknown as PruneSelectionHost` 满足它。
 */
export interface PruneSelectionHost {
  nextClosureId: number
  closureLastRecalled: Map<number, number>
  closureWindowK: number
}

/** P2 选择侧（2026-08-22 拆出）：选一个 PRUNABLE 闭包并返回其原子/区间，不执行剪枝。
 *  `alreadyPruned` 用于排除已由正常候选/版本重复剪过的原子——修复前独立闭包事务
 *  按整闭包（含已剪原子）独立剪枝并 return，导致正常候选成果被丢弃；现改为"选择并入
 *  pruned、统一事务剪"（compactIfNeeded 降级链内联），闭包原子需与已剪集合去重
 *  （如 A1/A2 已正常剪 → 闭包仅剩 root U，单独退休 root U 是有意设计：P5 注释
 *  "自动闭包生命周期确实会连 root U 一起剪除"）。
 *
 * 原 class 私有方法；this.x → host.x（nextClosureId++ 经 host 重赋值落到真实字段）。
 */
export function selectClosureToMerge(
  host: PruneSelectionHost,
  session: Session,
  atoms: Atom[],
  edges: SemanticEdge[],
  inDegree: Map<number, number>,
  askCover: Map<number, number>,
  latestTurn: number,
  alreadyPruned: Set<number>,
): {
  closureId: string
  root: Atom
  rootPreview: string
  /** 闭包全量 seq（含已由正常候选剪过的原子）——closurePrunes 记录用（noteRecallHit 反查 rootSeq）。 */
  seqs: number[]
  /** 本事务实际并入 pruned 的原子（过滤 alreadyPruned）。 */
  atoms: Atom[]
  intervals: { seqs: number[]; chars: number; atoms: Atom[] }[]
} | null {
  const roots = atoms
    .filter(a => a.type === 'U' && a.sourceSeq === undefined && !askCover.has(a.id))
    // P4：排除 U-info 作 root——U-info 是"可丢弃可召回"的资料副本，不是开启新
    // 任务的 task-init 根。若不排除，闭包生命周期会以 U-info 为根把其后整段
    // dialog/A/R 拖进闭包退休（语义错误）。普通 U（dialog）仍为合法根。
    .sort((a, b) => a.seq - b.seq)
  if (roots.length === 0) return null
  const closureOf = new Map<number, string>()
  const rootByClosure = new Map<string, Atom>()
  for (let i = 0; i < roots.length; i += 1) {
    const root = roots[i]
    const nextRoot = roots[i + 1]
    const id = 'closure-' + (host.nextClosureId++)
    rootByClosure.set(id, root)
    for (const a of atoms) {
      if (a.type === 'U' && a.id !== root.id) continue
      if (a.seq >= root.seq && (nextRoot === undefined || a.seq < nextRoot.seq)) {
        closureOf.set(a.id, id)
      }
    }
  }
  const lastRefByClosure = new Map<string, number>()
  const inDegreeByClosure = new Map<string, number>()
  const atomById = new Map(atoms.map(a => [a.id, a]))
  for (const e of edges) {
    const fromClosure = closureOf.get(e.from)
    const toClosure = closureOf.get(e.to)
    const from = atomById.get(e.from)
    if (from !== undefined && toClosure !== undefined) {
      const ref = from.turn
      lastRefByClosure.set(toClosure, Math.max(lastRefByClosure.get(toClosure) ?? 0, ref))
    }
    if (fromClosure !== undefined && toClosure !== undefined && fromClosure !== toClosure) {
      // A1 不变量 2′：仅 external **critical** 边计入闭包守卫入度
      if (e.level === 'critical') {
        inDegreeByClosure.set(toClosure, (inDegreeByClosure.get(toClosure) ?? 0) + 1)
      }
    }
  }
  const k = host.closureWindowK
  const candidates: { id: string; root: Atom; lastRef: number; seqs: number[]; prunableSeqs: number[] }[] = []
  const lastRootSeq = roots.length > 0 ? roots[roots.length - 1]?.seq : -1
  for (const [id, root] of rootByClosure) {
    if (root.seq === lastRootSeq) continue
    const lastRecalled = host.closureLastRecalled.get(root.seq)
    if (lastRecalled !== undefined && latestTurn - lastRecalled < k) continue
    const lastRef = lastRefByClosure.get(id) ?? 0
    if (lastRef > latestTurn - k) continue
    if ((inDegreeByClosure.get(id) ?? 0) > 0) continue
    const seqs = atoms.filter(a => closureOf.get(a.id) === id).map(a => a.seq).sort((x, y) => x - y)
    if (seqs.length === 0) continue
    // 过滤已剪原子：只剩已剪原子的闭包无可剪内容，不选；prunable 用于 intervals，seqs 全量用于记录
    const prunableSeqs = seqs.filter(s => !alreadyPruned.has(s))
    if (prunableSeqs.length === 0) continue
    candidates.push({ id, root, lastRef, seqs, prunableSeqs })
  }
  if (candidates.length === 0) return null
  candidates.sort((a, b) => a.lastRef - b.lastRef || a.root.seq - b.root.seq)
  const chosen = candidates[0]
  if (chosen === undefined) return null
  const surfaceSeqs = session.surface.nodes
  const position = new Map<number, number>(surfaceSeqs.map((seq, i) => [seq, i]))
  const chosenSet = new Set(chosen.prunableSeqs)
  const bySeq = new Map(atoms.map(a => [a.seq, a]))
  const intervals: { seqs: number[]; chars: number; atoms: Atom[] }[] = []
  let current: number[] = []
  for (const seq of surfaceSeqs) {
    if (!chosenSet.has(seq)) {
      if (current.length > 0) {
        const intervalAtoms = current.map(s => bySeq.get(s)).filter((a): a is Atom => a !== undefined)
        const chars = intervalAtoms.reduce((sum, a) => sum + a.text.length, 0)
        intervals.push({ seqs: current, chars, atoms: intervalAtoms })
        current = []
      }
      continue
    }
    current.push(seq)
  }
  if (current.length > 0) {
    const intervalAtoms = current.map(s => bySeq.get(s)).filter((a): a is Atom => a !== undefined)
    const chars = intervalAtoms.reduce((sum, a) => sum + a.text.length, 0)
    intervals.push({ seqs: current, chars, atoms: intervalAtoms })
  }
  if (intervals.length === 0) return null
  const chosenAtoms = chosen.prunableSeqs
    .map(s => bySeq.get(s))
    .filter((a): a is Atom => a !== undefined)
  const rootPreview = chosen.root.text.split('\n').map(l => l.trim()).find(l => l !== '') ?? ''
  return {
    closureId: chosen.id,
    root: chosen.root,
    rootPreview,
    seqs: chosen.seqs,
    atoms: chosenAtoms,
    intervals,
  }
}
