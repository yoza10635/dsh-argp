import type { Session } from '@deepseek-ai/dsh-session';
import type { CompactionResult } from '@deepseek-ai/dsh-compaction';
import { type PruneTxHost } from '../prune-tx.ts';
import { type RTagInput } from './factor-atoms.ts';
import { FactorLedger, type RenderVocabularyResult } from './factor-ledger.ts';
import { type PrunePlan } from './retention-score.ts';
import type { FileSnapshot } from './types.ts';
export interface FactorEngineConfig {
    /** 焦点轮数（§2.5 默认 1，可 2 防摆荡）。设置卡旋钮 → 引擎侧传 getter 活读（volatile 语义）。 */
    focalTurns?: number | (() => number);
    /** 词表每类 topN（§1.4）。设置卡旋钮 → 引擎侧传 getter 活读。 */
    vocabTopN?: number | (() => number);
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
/** 词表 note 的行首标记：resume 找回 note 指针的判据（改文案不得动标记）。 */
export declare const VOCAB_NOTE_MARKER = "[argp-factor \u8BCD\u8868]";
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
    /** 最小桩（§1.2 ~30 字符物理下限；禁引退役工具名）。前缀 STUB_PREFIX 是
     *  tagRsFromLog 的桩排除判据——单点引用，改文案不得动前缀。 */
    private stubText;
    /** 词表段（渲染出口；注入通路见 refreshVocabularyNote）。 */
    vocabulary(session: Session): RenderVocabularyResult;
    /**
     * 词表 note 的单一可见副本维护（§1.4 注入位定稿：**不进 system 前缀**——每轮变动
     * = 跨轮前缀缓存全断，`6d252cf` 教训；note 常驻剪枝区带、内容随 epoch 重写）。
     *
     * 通路 = pre-step 的 steer/replace（auto-continue 同款 notice 先例）：
     *  - 首注：steer 一条 notice（source.kind='argp'，宿主归 X：进请求、不参剪、UI 按
     *    notice 渲染）；指针以标记回溯为准——steer throw 或未落盘都**不记指针**
     *    （记了 resume 找不回，等于坏指针 ⇒ 下轮自然重试）。
     *  - 更新：**单节点 replace 原地重写**（墓碑归并同形态；replace 副本 model-only，
     *    UI 留首份 notice——词表本就常驻更新，旧副本进 UI 无害）。绝不再 steer 第二条
     *    （X 在 factor 臂永不参剪，多副本 = 不可剪地板累积）。
     *  - resume：进程重启后指针丢失，按 VOCAB_NOTE_MARKER 从日志尾回溯找回最新副本。
     */
    refreshVocabularyNote(session: Session, steer: (text: string) => unknown): Promise<void>;
}
