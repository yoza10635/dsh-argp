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
    /**
     * 焦点分级策略档（§2.5 提案栈 v1.1/v1.4）。**内部裸项，严禁进 static Config
     * schema**（设置卡零新键由 CR5/CR6/preset 精确键锁机器化保证）：
     *  - 'flat'（缺省）：现行为字节级不变；
     *  - 'tiered'：焦点文档全枚 hard（宽度熔断兜底 FOCAL_DOC_HARD_WIDTH_RATIO）
     *    + superseded 焦点豁免（v1.4）+ 裸 errorcode 焦点降出 hard（v1.2 路由）。
     */
    focalTiered?: 'flat' | 'tiered';
}
/**
 * focalTiered 的 env 逃生口（T-3 两臂实跑唯一触达通道）：tiered 是策略档，
 * 禁入 static Config/设置卡（P5-b 裁定，CR5/CR6/preset 键锁不变），生产装配路径
 * 缺省恒 flat——要跑 tiered 臂只能经此 env。非法值 ⇒ flat（缺省安全）；
 * 生效=构造快照（档切换=策略文档换版，须重挂引擎，不做活读）。
 */
export declare function resolveFocalTiered(env?: NodeJS.ProcessEnv): 'flat' | 'tiered';
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
    /** 本次决策所用策略档（遥测：评测/日志要能区分臂）。 */
    focalTiered: 'flat' | 'tiered';
    /** tiered：焦点文档 hard 的字节量（flat 恒 0）。 */
    focalDocHardChars: number;
    /** tiered：宽度熔断是否触发（触发 ⇒ 每文档只保最新一枚）。 */
    focalDocFuse: boolean;
    /** tiered：err 签名 exemplar hard 枚数（flat 恒 0；遥测/宽度账用）。 */
    errSigHardCount: number;
    /** tiered：medium 焦点标签数（focalSize 拆强/中两报，§2.5 遥测歧义账）。 */
    focalMediumSize: number;
    /** tiered：medium 带（排序位）字节量——T-2 medium 面占比闸原料。 */
    mediumBandChars: number;
    /** 逐候选焦点带（flat 语义：命中=1 未命中=0；tiered：三值）。 */
    focalBandBySeq: ReadonlyMap<number, 0 | 1 | 2>;
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
