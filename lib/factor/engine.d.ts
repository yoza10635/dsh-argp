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
import type { Session } from '@deepseek-ai/dsh-session';
import type { CompactionResult } from '@deepseek-ai/dsh-compaction';
import { type PruneTxHost } from '../prune-tx.ts';
import { type RTagInput } from './factor-atoms.ts';
import { FactorLedger, type RenderVocabularyResult } from './factor-ledger.ts';
import { type PrunePlan } from './retention-score.ts';
import type { FileSnapshot } from './types.ts';
export interface FactorEngineConfig {
    /** 焦点轮数（§2.5 默认 1，可 2 防摆荡）。 */
    focalTurns?: number;
    /** 词表每类 topN（§1.4）。 */
    vocabTopN?: number;
    /** sticky 闭集观察窗（轮）。 */
    stickyWindowTurns?: number;
    /** 词表渲染预算（字符）。 */
    vocabBudgetChars?: number;
}
/** 复用 prune-tx 的窄宿主 + 文件快照探针（可再生性证明原料；缺 ⇒ 永不放行）。 */
export interface FactorEngineHost extends PruneTxHost {
    fileSnapshot?: (canonicalKey: string) => FileSnapshot | null;
}
export interface FactorDecision {
    plan: PrunePlan;
    /** 非 shadowed 的 R 候选（seq → 原料），供发射与遥测。 */
    candidates: Map<number, RTagInput>;
    tagsBySeq: Map<number, RTagInput>;
    latestTurn: number;
    focalSize: number;
    stickyActive: number;
    /** §2.3 降级链上报量（>0 时调用方必须可见，不静默）。 */
    shortfallChars: number;
}
export declare class FactorEngine {
    readonly ledger: FactorLedger;
    private states;
    private readonly host;
    private readonly cfg;
    constructor(host: FactorEngineHost, config?: FactorEngineConfig);
    private stateOf;
    /**
     * 观察路（sticky 通道 + 被剪账本 + 在线文件快照）。幂等：ledger rootSeq 去重。
     */
    private observe;
    /** 纯决策（无发射副作用）：单测主对象。targetReleaseChars = 需释放的下界。 */
    decide(session: Session, targetReleaseChars: number): FactorDecision;
    /**
     * 压力剪一笔：决策 → pruneIntervals 成对发射（每区间 shadow-price claim +
     * content-only 桩 replace，宿主契约由 prune-tx 保证）。目标不达不放宽。
     */
    compactIfNeeded(session: Session, targetReleaseChars: number): CompactionResult | null;
    /** 最小桩（§1.2 ~30 字符物理下限；禁引退役工具名）。 */
    private stubText;
    /** 词表段（surface 剪枝区头部注入位在 P2 接线；本函数是渲染出口）。 */
    vocabulary(session: Session): RenderVocabularyResult;
}
