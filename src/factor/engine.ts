/**
 * 因子引擎组合根（design-2.0 §3.2）：贴标 → 排序 → plan → prune-tx 成对发射。
 *
 * 全链 0 LLM（G7 口径）：本文件无 LLM import；摘要在 ua-summarizer（P2）。
 *
 * 账本一致性策略：**被剪账本 = shadowed 集合的投影**——发射侧零手动记账，
 * resume 重放与在线新增走同一条观察路（scanShadowedSeqs 引擎无关，
 * §1.5-9 无版本 pin 裁定的落点）。observeR/addPruned 由 ledger 的 rootSeq
 * 去重保证幂等，重复扫描无害——P1-d 正确性优先，增量缓存留给 P3 性能项。
 *
 * 可再生性采样的时序纪律（释放向，I-DIR）：**只在事件首次在线观察到时采样**
 * 文件基线；重放批（引擎挂上前的历史）不采样——启动后才 stat 到的 mtime
 * 无法区分"R 读后文件没动"与"R 读后已变又恰好没再变"，一律按未知（不可再生）。
 *
 * 挂载侧不变量（分发入口执行，见 argp-graph-engine factor 分支）：
 *  - engine='factor' ⇒ compressor/declarer/zoom 三管线不挂、cites 通道硬关；
 *  - 本类只剪 R（content-only 最小桩，宿主 assertToolResultRewrite 形态）；
 *    A 永不入剪枝区间（恒留待摘要），协议组互锁因此天然满足。
 */
import type { Session } from '@deepseek-ai/dsh-session'
import type { CompactionResult } from '@deepseek-ai/dsh-compaction'
import { detectOpenTurn, scanShadowedSeqs, sessionEvents } from '../log-access.ts'
import { pruneIntervals, type PruneTxHost } from '../prune-tx.ts'
import type { Atom } from '../argp-types.ts'
import { focalLabels, sessionCwdFromEvents, supersededMarks, tagRs, type AtomLike, type EventLike, type RTagInput } from './factor-atoms.ts'
import { FactorLedger, indexKeys, renderVocabulary, type RenderVocabularyResult } from './factor-ledger.ts'
import { computeScore, planPrune, type PrunePlan, type ScoredEntry } from './retention-score.ts'
import { READ_TOOLS } from './tag-extract.ts'
import type { FileSnapshot } from './types.ts'

export interface FactorEngineConfig {
  /** 焦点轮数（§2.5 默认 1，可 2 防摆荡）。 */
  focalTurns?: number
  /** 词表每类 topN（§1.4）。 */
  vocabTopN?: number
  /** sticky 闭集观察窗（轮）。 */
  stickyWindowTurns?: number
  /** 词表渲染预算（字符）。 */
  vocabBudgetChars?: number
}

/** 复用 prune-tx 的窄宿主 + 文件快照探针（可再生性证明原料；缺 ⇒ 永不放行）。 */
export interface FactorEngineHost extends PruneTxHost {
  fileSnapshot?: (canonicalKey: string) => FileSnapshot | null
}

export interface FactorDecision {
  plan: PrunePlan
  /** 非 shadowed 的 R 候选（seq → 原料），供发射与遥测。 */
  candidates: Map<number, RTagInput>
  tagsBySeq: Map<number, RTagInput>
  latestTurn: number
  focalSize: number
  stickyActive: number
  /** §2.3 降级链上报量（>0 时调用方必须可见，不静默）。 */
  shortfallChars: number
}

interface SessionFactorState {
  /** 已观察到的日志尾 seq；-1 = 尚未首观察（首观察批 = 重放批，不采快照）。 */
  observedUpToSeq: number
  /** 在线采到的事件时文件基线（seq → key → 快照）。 */
  snapshots: Map<number, Map<string, FileSnapshot>>
}

export class FactorEngine {
  readonly ledger = new FactorLedger()
  private states = new WeakMap<Session, SessionFactorState>()
  private readonly host: FactorEngineHost
  private readonly cfg: {
    focalTurns: number; vocabTopN: number; stickyWindowTurns: number; vocabBudgetChars: number
  }

  constructor(host: FactorEngineHost, config: FactorEngineConfig = {}) {
    this.host = host
    this.cfg = {
      focalTurns: config.focalTurns ?? 1,
      vocabTopN: config.vocabTopN ?? 10,
      stickyWindowTurns: config.stickyWindowTurns ?? 8,
      vocabBudgetChars: config.vocabBudgetChars ?? 4000,
    }
  }

  private stateOf(session: Session): SessionFactorState {
    let st = this.states.get(session)
    if (st === undefined) {
      st = { observedUpToSeq: -1, snapshots: new Map() }
      this.states.set(session, st)
    }
    return st
  }

  /**
   * 观察路（sticky 通道 + 被剪账本 + 在线文件快照）。幂等：ledger rootSeq 去重。
   */
  private observe(session: Session): { atoms: Atom[]; tagsBySeq: Map<number, RTagInput>; cwd: string | undefined } {
    const events = sessionEvents(session) as unknown as EventLike[]
    const atoms = this.host.atomize(session)
    const cwd = sessionCwdFromEvents(events)
    const st = this.stateOf(session)
    const first = st.observedUpToSeq === -1
    const tagsBySeq = tagRs(events, atoms as AtomLike[], cwd)
    const shadowed = scanShadowedSeqs(session)
    for (const [seq, input] of tagsBySeq) {
      this.ledger.observeR(seq, input.turn, input.tags)
      if (shadowed.has(seq)) this.ledger.addPruned({ rootSeq: seq, turn: input.turn, tags: input.tags })
    }
    // 在线快照采样：仅首观察且非重放批的 R
    if (this.host.fileSnapshot !== undefined) {
      for (const [seq, input] of tagsBySeq) {
        if (seq <= st.observedUpToSeq || (first && seq <= (events[events.length - 1]?.seq ?? -1))) continue
        if (!READ_TOOLS.has(input.tool) || input.tags.files.length === 0 || st.snapshots.has(seq)) continue
        const snap = new Map<string, FileSnapshot>()
        for (const key of input.tags.files.slice(0, 4)) {
          const s = this.host.fileSnapshot(key)
          if (s !== null && s !== undefined) snap.set(key, s)
        }
        if (snap.size > 0) st.snapshots.set(seq, snap)
      }
    }
    const tailSeq = events.length > 0 ? (events[events.length - 1]?.seq ?? st.observedUpToSeq) : st.observedUpToSeq
    st.observedUpToSeq = Math.max(st.observedUpToSeq, tailSeq)
    this.ledger.sweepClosed(atoms.reduce((m, a) => Math.max(m, a.turn), 0), this.cfg.stickyWindowTurns)
    return { atoms, tagsBySeq, cwd }
  }

  /** 纯决策（无发射副作用）：单测主对象。targetReleaseChars = 需释放的下界。 */
  decide(session: Session, targetReleaseChars: number): FactorDecision {
    const { atoms, tagsBySeq, cwd } = this.observe(session)
    const latestTurn = atoms.reduce((m, a) => Math.max(m, a.turn), 0)
    const openTurn = detectOpenTurn(session)
    const shadowed = scanShadowedSeqs(session)
    const focal = focalLabels(atoms as AtomLike[], latestTurn, this.cfg.focalTurns, cwd)
    const superseded = supersededMarks(tagsBySeq)
    const st = this.stateOf(session)
    const sticky = this.ledger.stickyActive()
    const entries: ScoredEntry[] = []
    const candidates = new Map<number, RTagInput>()
    for (const a of atoms) {
      if (a.type !== 'R') continue
      if (shadowed.has(a.seq)) continue
      const input = tagsBySeq.get(a.seq)
      if (input === undefined) continue
      candidates.set(a.seq, input)
      // 未闭合轮的 R：本轮协议现场（模型可能尚未消化），硬保护不进排序
      const inOpenTurn = openTurn !== null && a.turn >= openTurn
      const keys = indexKeys(input.tags)
      const focalMatch = keys.some(k => focal.has(k))
      let regenerable: boolean | undefined
      const snap = st.snapshots.get(a.seq)
      if (snap !== undefined && this.host.fileSnapshot !== undefined && READ_TOOLS.has(input.tool)) {
        const cur = this.host.fileSnapshot(input.tags.files[0] ?? '')
        regenerable = cur !== null && cur !== undefined
          && [...snap.values()].every(s => s.mtimeMs === cur.mtimeMs && s.size === cur.size)
      }
      // 硬保护只认**已定型 sticky** 轨；open 轨是词表观察对象——open 也保护会把
      // 文本信号的一切误报升级为硬保护（实测：正常输出挂 ALL_CAPS 候选码即成轨）。
      const stickyMember = input.tags.errorcodes.length > 0 && input.tags.files.some(f =>
        sticky.some(t => t.state === 'sticky' && t.file === f && input.tags.errorcodes.includes(t.errorcode)))
      entries.push({
        rootSeq: a.seq,
        score: computeScore({
          rootSeq: a.seq, turn: a.turn, currentTurn: latestTurn, tags: input.tags,
          hard: {
            failureNoFollowR: inOpenTurn,
            stickyMember,
            attachment: input.resultText.length === 0,
            focalNonRegenerable: focalMatch && regenerable !== true,
          },
          regenerable,
          superseded: superseded.get(a.seq) === true ? true : undefined,
          focal: focalMatch,
        }),
      })
    }
    const plan = planPrune(entries, { targetReleaseChars })
    return {
      plan, candidates, tagsBySeq, latestTurn,
      focalSize: focal.size, stickyActive: sticky.length, shortfallChars: plan.shortfallChars,
    }
  }

  /**
   * 压力剪一笔：决策 → pruneIntervals 成对发射（每区间 shadow-price claim +
   * content-only 桩 replace，宿主契约由 prune-tx 保证）。目标不达不放宽。
   */
  compactIfNeeded(session: Session, targetReleaseChars: number): CompactionResult | null {
    if (targetReleaseChars <= 0) return null
    const decision = this.decide(session, targetReleaseChars)
    const { plan, tagsBySeq } = decision
    if (plan.pruneOrder.length === 0) {
      if (plan.shortfallChars > 0) {
        this.host.log.warn('[argp-factor] 降级链：可剪面释放不足，缺口 ' + plan.shortfallChars
          + ' chars（硬保护成员未入区；少剪并上报，不放宽判据）')
      }
      return null
    }
    const atomsBySeq = new Map<number, Atom>()
    for (const a of this.host.atomize(session)) atomsBySeq.set(a.seq, a)
    const intervals: { seqs: number[]; chars: number; atoms: Atom[] }[] = []
    const tombstones: { type: 'tool'; seq: number; callId: string; text: string }[] = []
    for (const seq of plan.pruneOrder) {
      const atom = atomsBySeq.get(seq)
      const input = tagsBySeq.get(seq)
      if (atom === undefined || input === undefined || input.callId === undefined) continue
      intervals.push({ seqs: [seq], chars: input.tags.sizeChars, atoms: [atom] })
      tombstones.push({ type: 'tool', seq, callId: input.callId, text: this.stubText(input) })
    }
    if (intervals.length === 0) return null
    const result = pruneIntervals(this.host, session, intervals, 0, intervals.length, false, tombstones, 'factor-prune')
    if (result !== null) {
      // 发射成功立即入账（词表零轮延迟）；下一轮 shadowed-diff 重放被 rootSeq
      // 去重吸收。逐条以**真实 shadowed** 复核——prune-tx 预检（canCloneTool）剔除
      // 的区间未落 shadowed，不得误记。
      const shadowedNow = scanShadowedSeqs(session)
      for (const iv of intervals) {
        const seq = iv.seqs[0] as number
        if (!shadowedNow.has(seq)) continue
        const atom = atomsBySeq.get(seq)
        const input = tagsBySeq.get(seq)
        if (atom !== undefined && input !== undefined) {
          this.ledger.addPruned({ rootSeq: seq, turn: atom.turn, tags: input.tags })
        }
      }
      this.host.log.info('[argp-factor] 剪 ' + intervals.length + ' R / ' + plan.releasedChars
        + ' chars；sticky 活跃 ' + decision.stickyActive + '；焦点标签 ' + decision.focalSize)
    }
    return result
  }

  /** 最小桩（§1.2 ~30 字符物理下限；禁引退役工具名）。 */
  private stubText(input: RTagInput): string {
    const key = input.tags.files[0] !== undefined ? 'document:' + input.tags.files[0]
      : input.tags.commands[0]
        ?? (input.tags.errorcodes[0] !== undefined ? 'errorcode:' + input.tags.errorcodes[0] : undefined)
    const head = '[已剪·因子] ' + (input.tool !== '' ? input.tool : 'tool')
    return key === undefined
      ? head + '（无实体标签，原文仍在日志）'
      : head + ' → ' + key + '（需要原文时 recall_history(' + key + ')）'
  }

  /** 词表段（surface 剪枝区头部注入位在 P2 接线；本函数是渲染出口）。 */
  vocabulary(session: Session): RenderVocabularyResult {
    this.observe(session)
    return renderVocabulary({
      ledger: this.ledger,
      topNPerFacet: this.cfg.vocabTopN,
      budgetChars: this.cfg.vocabBudgetChars,
    })
  }
}
