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
import type { PruneScore, RTags } from './types.ts'

/** 硬保护判据位（§2.3 第一层；引擎注入，任一 true 即保护）。 */
export interface HardFlags {
  /** 协议组未闭合的 A。 */
  protocolUnclosed?: boolean
  /** 失败无后继 R。 */
  failureNoFollowR?: boolean
  /** open/sticky 交集区成员（保护向：open 也算）。 */
  stickyMember?: boolean
  /** 附件/非文本。 */
  attachment?: boolean
  /** 焦点轮非再生 R*（条件保护：焦点 ∧ containment<满覆盖，离开焦点即入排序）。 */
  focalNonRegenerable?: boolean
  /** node 0（宿主保护）。 */
  node0?: boolean
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
  /** 焦点（标签 ∈ 焦点标签集；undefined=保守按焦点）。 */
  focal?: boolean
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
  const focal: 0 | 1 = i.focal === false ? 0 : 1
  return {
    hard: isHard ? 1 : 0,
    regenerable,
    superseded,
    focal,
    freshness: Math.max(0, i.currentTurn - i.turn),
    size: i.tags.sizeChars,
  }
}

/** 字典序比较：负 = a 先剪。 */
export function compareForPrune(a: ScoredEntry, b: ScoredEntry): number {
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
  releasedChars: number
}

/**
 * 排序 + 目标释放量选择。targetReleaseChars 是**下界**（retain 目标：释放不足
 * 则爆窗），按序取到累计 ≥ 目标即止（含首个越界项——不回头少剪）。
 * 全取仍不可达 ⇒ 如实给 shortfallChars（§2.3 降级链：少剪 + 告警），
 * 硬保护成员**任何压力下都不入 pruneOrder**。
 */
export function planPrune(
  entries: ScoredEntry[],
  opts: { targetReleaseChars?: number } = {},
): PrunePlan {
  const sizeBySeq = new Map<number, number>()
  const hard: number[] = []
  const soft: ScoredEntry[] = []
  for (const e of entries) {
    sizeBySeq.set(e.rootSeq, e.score.size)
    if (e.score.hard === 1) hard.push(e.rootSeq)
    else soft.push(e)
  }
  soft.sort(compareForPrune)
  const target = opts.targetReleaseChars ?? Infinity
  const taken: number[] = []
  let takenChars = 0
  for (const e of soft) {
    taken.push(e.rootSeq)
    takenChars += e.score.size
    if (takenChars >= target) break
  }
  return {
    pruneOrder: taken,
    hardProtected: hard.sort((a, b) => a - b),
    shortfallChars: Math.max(0, target - takenChars),
    releasedChars: takenChars,
  }
}
