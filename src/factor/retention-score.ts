/**
 * 排序规约（design-2.0 §2.3——复现算法，替代"因子清单"）：
 *
 *   第一层 硬保护 = 绝不入剪枝区间（引擎给判据位，本模块 AND 消费）；
 *   第二层起 字典序（先剪者在前）：
 *     ①可再生证明 → ②staleness 覆盖证明 → ③非焦点 → ④freshness 旧者先
 *     → ⑤size 大者先 → tie: rootSeq 升序。
 *   缺失值一律取保守档（未知 → 按不可再生/未覆盖/焦点处理）。
 *   降级链：释放仍不达目标 → 少剪 + shortfall 上报；**永不放宽判据、
 *   永不拉硬保护成员入区**。
 *
 * I-DIR 落点：释放向判据（regenerable/superseded 的"放行"）在本模块内做
 * **二次核验**——引擎注入 true 也不足以放行，还必须工具族=read 类且有 document
 * 键；注入方说谎/误标时被工具族防线拦下。保护向（hard 各位）可宽。
 */
import { READ_TOOLS } from './tag-extract.ts'
import { CLIP_MIN_SAVING_CHARS } from './clip-shape.ts'
import type { PruneScore, RTags } from './types.ts'

/** 硬保护判据位（§2.3 第一层；引擎注入，任一 true 即保护）。 */
export interface HardFlags {
  /** 失败无后继 R。 */
  failureNoFollowR?: boolean
  /** open/sticky 交集区成员（保护向：open 也算）。 */
  stickyMember?: boolean
  /** 附件/非文本。 */
  attachment?: boolean
  /** 焦点轮非再生 R*（条件保护：焦点 ∧ containment<满覆盖，离开焦点即入排序）。 */
  focalNonRegenerable?: boolean
  /**
   * tiered 模式焦点文档全枚 hard（§2.5 用户裁定"本轮涉及 document ⇒ 含该因子原子
   * 全部保留"；spike52 处理感知重读 50.0% vs 8.4% 背书）。与 focalNonRegenerable
   * 互斥使用：flat 只设后者，tiered 只设前者（裸 errorcode 焦点已按 v1.2 降出 hard）。
   */
  focalDocStrong?: boolean
  /**
   * tiered v1.3：err 签名 exemplar hard——会话内同签名（code×file|cmd，v1.2 路由：
   * 仅 tool 的裸码走词表）复发 ≥2（n=1=100% 假捆绑，用户裁定）⇒ **只保最新一枚**；
   * 同因子后续成功 R ⇒ 释放（spike53：29% 组已 superseded）。flat 恒 false（逐枚 sticky 现行为）。
   */
  errSignatureHard?: boolean
}

export interface ScoreInput {
  rootSeq: number
  turn: number
  currentTurn: number
  tags: RTags
  hard?: HardFlags
  /** 可再生性证明（引擎 fs 验"文件未变"；undefined=未知=保守不可再生）。 */
  regenerable?: boolean
  /** staleness 覆盖证明（后续全量读 ⊇ 本读范围；部分读永不覆盖——引擎侧配反例）。 */
  superseded?: boolean
  /** 焦点（标签 ∈ 焦点标签集；undefined=保守按焦点）。flat 布尔通道。 */
  focal?: boolean
  /**
   * 三值焦点带（§2.5 v1.1：0 none / 1 medium 命令面 / 2 strong 文档面；tiered 通道）。
   * 给了就优先于 focal 布尔。★ `focal === false ? 0 : 1` 的严格相等回退只适用于布尔。
   */
  focalBand?: 0 | 1 | 2
}

export interface ScoredEntry {
  rootSeq: number
  score: PruneScore
}

export function computeScore(i: ScoreInput): PruneScore {
  const hard = i.hard ?? {}
  const isHard = Object.values(hard).some(v => v === true)
  // 释放向二次核验：read 类 + 有 document 键是不可绕过的下限。
  const readish = READ_TOOLS.has(i.tags.tool)
  const regenerable: 0 | 1 = i.regenerable === true && readish && i.tags.files.length > 0 ? 0 : 1
  const superseded: 0 | 1 = i.superseded === true && readish ? 0 : 1
  // 三值带优先；布尔回退保留 flat 现语义（undefined=保守按焦点=1）。
  const focal: 0 | 1 | 2 = i.focalBand ?? (i.focal === false ? 0 : 1)
  return {
    hard: isHard ? 1 : 0,
    regenerable,
    superseded,
    focal,
    freshness: Math.max(0, i.currentTurn - i.turn),
    size: i.tags.sizeChars,
  }
}

/**
 * §D 量化排序臂（ARGP_FACTOR_QSCORE=1）：**硬保护位与证明/焦点桶门一律保留**
 * （§2.3 保守档纪律不因量化让步——无桶纯标量会踩穿"可再生/已覆盖"证明门，把
 * 焦点大枚排到先剪）。量化增量落在桶内的 ④轮龄 vs ⑤size：字典序是 age 一票
 * 否决，量化臂改**绝对净代价**连续竞争（降序先剪）：
 *
 *   qPriority = (1 − keepProb) × (size − 事务税105ch)
 *
 * 建模注记（方案原式 `retentionCost/netReleasedTokens` 的证伪）：cost∝size 物理
 * ⇒ ratio 中 size 相消 = deadProb，对 age 单调 ⇒ **桶内与现字典序逐位等价**，
 * 无量化增量；非退化的唯一守恒形式是绝对净收益（税让大枚摊薄占优，④⑤真竞争）。
 * keepProb（复活概率）= band 因子(0/1/2→×1/×4/×10) × 再生证明 ×0.02 × 覆盖证明
 * ×0.05 ÷ (1+轮龄)，钳到 [0,1]。硬保护绝不入区（§D 影子实锤不解锁）。
 * 缺省字典序字节不变；翻缺省以三域 A/B 实证为门。
 *
 * **三域 A/B 裁决（2026-11-25，32K）**：工具域中性（read 36/36 vs 35/36，bill 差在
 * 噪声带）；**焦点域硬回退**（read 24/36 vs 36/36、probe 1/2 vs 2/2、压缩 9 次 vs
 * 6 次）——「中龄大枚先剪」恰好驱逐焦点域被反复重读的大文件，锚点丢失+churn 上升。
 * **结论：缺省维持 lex，本臂保留为对照档案**。量化排序在 age-vs-size 维度的连续
 * 竞争会稀释 §2.3 年龄纪律的保护价值；真正的量化增量落在判据侧（§B/§C F/地板/
 * transcript 判据），不在排序侧。
 *
 * keepProb（复活概率）= band 因子(0/1/2→×1/×4/×10) × 再生证明 ×0.02 × 覆盖证明 ×0.05
 * ÷ (1+轮龄)；事务税=每枚驱逐的固定摊销（检查点文本+账目 ≈30 tok≈105 chars）——
 * 税让 size 保持正权重（大枚摊税），比纯 ratio 退化式（size 相消）更贴物理。
 * 硬保护位仍绝不入区（不解锁，§D 实锤）；缺省字典序字节不变。
 */
export type PruneOrderMode = 'lex' | 'quant'
export const QSCORE_TAX_CHARS = 105

export function keepProb(s: PruneScore): number {
  const bandFactor = s.focal === 2 ? 10 : s.focal === 1 ? 4 : 1
  const regenFactor = s.regenerable === 0 ? 0.02 : 1
  const superFactor = s.superseded === 0 ? 0.05 : 1
  return Math.min(1, bandFactor * regenFactor * superFactor / (1 + s.freshness))
}

export function qPriority(e: ScoredEntry): number {
  const net = e.score.size - QSCORE_TAX_CHARS
  if (net <= 0) return -1
  return (1 - keepProb(e.score)) * net
}

/** 字典序比较：负 = a 先剪。`mode='quant'`（§D）：硬保护与证明/焦点**桶门保留**
 *  （§2.3 保守档纪律不因量化让步——纯标量会无视"可再生/已覆盖"证明门），
 *  只把 ④轮龄降序+⑤size 降序 两键替换为净代价标量（age 经 keepProb 连续衰减 ×
 *  事务税摊销后的 size）——桶内「留着最贵」的单标量权衡。 */
export function compareForPrune(a: ScoredEntry, b: ScoredEntry, mode: PruneOrderMode = 'lex'): number {
  if (mode === 'quant') {
    return a.score.hard - b.score.hard
      || a.score.regenerable - b.score.regenerable
      || a.score.superseded - b.score.superseded
      || a.score.focal - b.score.focal
      || qPriority(b) - qPriority(a)
      || a.rootSeq - b.rootSeq
  }
  return a.score.hard - b.score.hard
    || a.score.regenerable - b.score.regenerable
    || a.score.superseded - b.score.superseded
    || a.score.focal - b.score.focal
    || b.score.freshness - a.score.freshness
    || b.score.size - a.score.size
    || a.rootSeq - b.rootSeq
}

export interface PrunePlan {
  /** 已按目标释放量截断的剪枝序列（§2.3 序；未达目标时为全量 + shortfall）。 */
  pruneOrder: number[]
  hardProtected: number[]
  /** 目标未达成量（降级链：少剪 + 告警上报，永不放宽判据换名额）。 */
  shortfallChars: number
  /** 净释放核算量（clip 成员按净收益入账，见 planPrune.clip——shadow 成员按全量）。 */
  releasedChars: number
  /**
   * C10 夹剪归位集（pruneOrder 子序）：**不可再生 ∧ 未被覆盖**的软序成员——
   * 内容无可替代来源却仍被驱逐 ⇒ 头尾留真比全遮少丢信息。可再生/被覆盖者
   * 重读即得原文，夹剪不加分 ⇒ 留 shadow 全遮；forcedFirst（协议残渣）恒 shadow。
   * `clip` 未启用 ⇒ 恒空集（R1 行为字节不变）。
   */
  clipOrder: number[]
}

/**
 * 排序 + 目标释放量选择。targetReleaseChars 是**下界**（retain 目标：释放不足
 * 则爆窗），按序取到累计 ≥ 目标即止（含首个越界项——不回头少剪）。
 * 全取仍不可达 ⇒ 如实给 shortfallChars（§2.3 降级链：少剪 + 告警），
 * 硬保护成员**任何压力下都不入 pruneOrder**。
 *
 * `forcedFirstSeqs`（P6-③ 裁定 3）：强制先行段——中断轮半截 A + 孤儿工具对等协议残渣，
 * 无视目标量下次压缩必驱逐（"驱逐时机=下次压缩"）。与 soft 求交去重（同一 seq 不两段入账）。
 *
 * `clip`（C10 夹剪层，缺省关）：给出即启用三态归位——被归 clip 的成员在目标账上
 * 只按**净收益**（size − 头尾预留）累计，防"名义达标、实报欠火"；归位判据与
 * 预留量解耦（语义在此，形状归 clip-shape.ts 模板，预留经回调注入）。
 */
export function planPrune(
  entries: ScoredEntry[],
  opts: {
    targetReleaseChars?: number
    forcedFirstSeqs?: number[]
    clip?: { reserveCharsOf: (e: ScoredEntry) => number }
    /** §D 软集排序模式：缺省 'lex'（字典序字节不变）；'quant'=净代价标量降序。 */
    orderMode?: PruneOrderMode
  } = {},
): PrunePlan {
  const sizeBySeq = new Map<number, number>()
  const hard: number[] = []
  const soft: ScoredEntry[] = []
  for (const e of entries) {
    sizeBySeq.set(e.rootSeq, e.score.size)
    if (e.score.hard === 1) hard.push(e.rootSeq)
    else soft.push(e)
  }
  const orderMode: PruneOrderMode = opts.orderMode ?? 'lex'
  soft.sort(orderMode === 'quant' ? (a, b) => compareForPrune(a, b, 'quant') : compareForPrune)
  const target = opts.targetReleaseChars ?? Infinity
  const forced = opts.forcedFirstSeqs ?? []
  const forcedSet = new Set(forced)
  const clip = opts.clip
  const taken: number[] = []
  const clipOrder: number[] = []
  let takenChars = 0
  for (const seq of forced) {
    taken.push(seq)
    takenChars += sizeBySeq.get(seq) ?? 0
  }
  for (const e of soft) {
    if (forcedSet.has(e.rootSeq)) continue
    let gain = e.score.size
    if (clip !== undefined && e.score.regenerable === 1 && e.score.superseded === 1) {
      const net = e.score.size - clip.reserveCharsOf(e)
      if (net >= CLIP_MIN_SAVING_CHARS) {
        gain = net
        clipOrder.push(e.rootSeq)
      }
    }
    taken.push(e.rootSeq)
    takenChars += gain
    if (takenChars >= target) break
  }
  return {
    pruneOrder: taken,
    hardProtected: hard.sort((a, b) => a - b),
    shortfallChars: Math.max(0, target - takenChars),
    releasedChars: takenChars,
    clipOrder,
  }
}
