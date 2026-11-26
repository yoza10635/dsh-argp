import type { Session } from '@deepseek-ai/dsh-session';
import { type CompactionResult } from '@deepseek-ai/dsh-compaction';
import { VOCAB_NOTE_MARKER } from '../constants.ts';
import { type PruneTxHost } from '../prune-tx.ts';
import type { Atom } from '../argp-types.ts';
import { type RTagInput } from './factor-atoms.ts';
import { FactorLedger, type RenderVocabularyResult } from './factor-ledger.ts';
import { type PrunePlan } from './retention-score.ts';
import type { FileSnapshot } from './types.ts';
export interface FactorEngineConfig {
    /** 焦点轮数（§2.5 默认 1，可 2 防摆荡）。2.0.0 零旋钮：ArgpEngine 传固化常量 getter；直接构造（测试/评测）可传值。 */
    focalTurns?: number | (() => number);
    /** 词表每类 topN（§1.4）。2.0.0 零旋钮：装配面传固化常量 getter；直接构造可传值。 */
    vocabTopN?: number | (() => number);
    /** sticky 闭集观察窗（轮）。 */
    stickyWindowTurns?: number;
    /** 词表渲染预算（字符）。 */
    vocabBudgetChars?: number;
    /**
     * 焦点分级策略档（§2.5 提案栈 v1.1/v1.4）。**内部裸项，严禁进 static Config
     * schema**（零旋钮面由 ZK1/preset 键锁机器化保证）：
     *  - 'flat'（缺省）：现行为字节级不变；
     *  - 'tiered'：焦点文档全枚 hard（宽度熔断兜底 FOCAL_DOC_HARD_WIDTH_RATIO）
     *    + superseded 焦点豁免（v1.4）+ 裸 errorcode 焦点降出 hard（v1.2 路由）。
     */
    focalTiered?: 'flat' | 'tiered';
    /**
     * C10 夹剪层开关（三态保留）。同 focalTiered 纪律：**内部裸项，严禁进
     * static Config schema**，env ARGP_FACTOR_CLIP 唯一触达通道（resolveClipEnabled）。
     */
    clipEnabled?: boolean;
    /**
     * §D 量化排序臂（软集净代价标量序）。同 clip 纪律：内部裸项，严禁进 static
     * Config schema，env ARGP_FACTOR_QSCORE 唯一触达通道（resolveQScoreEnabled）。
     */
    qScoreEnabled?: boolean;
    /**
     * 散文扫描带上限（design-prose-keyword-recall §1.1）。内部裸项，严禁进 static
     * Config（ZK1）：undefined=窗相对现算 defaultProseCapChars；测试/bench 直给小值
     * 触发截断路径；**0=search_history 散文带整体关闭**（评测对照臂，S6 裁定 config
     * 注入为唯一形、不开数值 env 第二形）。
     */
    proseScanCapChars?: number;
}
/**
 * focalTiered 的 env 逃生口（T-3 两臂实跑唯一触达通道）：tiered 是策略档，
 * 禁入 static Config（P5-b 裁定，ZK1/preset 键锁不变），生产装配路径
 * 缺省恒 flat——要跑 tiered 臂只能经此 env。非法值 ⇒ flat（缺省安全）；
 * 生效=构造快照（档切换=策略文档换版，须重挂引擎，不做活读）。
 */
export declare function resolveFocalTiered(env?: NodeJS.ProcessEnv): 'flat' | 'tiered';
/**
 * P6-④ 触发收敛的评测逃生口（focalTiered 同款纪律：禁入 static Config，env 是唯一通道）：
 * 缺省 = 估算驱动退役（只认手动 compact + context 报错两信号，估算永不触发破坏性改写）；
 * env 置 1 恢复旧 pre-step 估算驱动路径（压力剪 + 缺口摘要 + note 每 pre-step 刷新，
 * 旧世界字节级复现，供修前/修后对照臂）。非法值 ⇒ 缺省（退役生效，安全方向）。
 * 生效 = 构造期快照（档切换须重挂引擎，不做活读）。
 */
export declare function resolvePressureTriggerEnabled(env?: NodeJS.ProcessEnv): boolean;
/**
 * C10 夹剪层评测逃生口（focalTiered 同款纪律：禁入 static Config，
 * ZK1/preset 键锁不变，env 是唯一通道）：缺省关=shadow 二态（R1 行为字节
 * 不变）；env 置 1 开启三态（归位见 planPrune.clipOrder，剪形见 clip-shape.ts）。
 * 生效=构造快照（层切换=策略文档换版，须重挂引擎）。非法值 ⇒ 关（缺省安全）。
 */
export declare function resolveClipEnabled(env?: NodeJS.ProcessEnv): boolean;
/**
 * §D 影子反事实逃生口（同 clip 纪律：env 唯一通道，缺省关=字节不变）：
 * `ARGP_FACTOR_SHADOW=1` 打开；日志落到 `ARGP_FACTOR_SHADOW_LOG`（未设则只读不写）。
 * 只旁路重算并**记录**「把 sticky/focal/err 从硬保护降级为软评分」后的剪序差异，
 * 发射用的 plan 不受任何影响。
 */
export declare function resolveShadowEnabled(env?: NodeJS.ProcessEnv): boolean;
/**
 * §D 量化排序臂（同 clip/shadow 纪律：env 唯一通道，缺省关=字典序字节不变）：
 * `ARGP_FACTOR_QSCORE=1` ⇒ 软集按净保留代价标量排序（retention-score.qPriority）。
 * 硬保护位不解锁（§D 影子实锤）；A/B 达标才谈翻缺省。
 */
export declare function resolveQScoreEnabled(env?: NodeJS.ProcessEnv): boolean;
/**
 * §9.37 出口闸解析（每次 pre-step 调用，读实时设置——设置页改动免重挂生效）：
 *  - env ARGP_FACTOR_EGRESS=0 = 硬关（对照臂覆盖一切，压缩阈值设置也不开）；
 *  - 设置 compactionThreshold > 0 = 开，线 = 声明窗 × 比例（「压缩阈值」语义，
 *    2026-11-15 用户裁定：可开启并自行设置比例）；
 *  - env ARGP_FACTOR_EGRESS=1（无设置）= 开，线 = 旧公式（窗 − 输出预算 − 2%，
 *    评测/对照口径）；
 *  - 都没设：**接管世界（ARGP_FACTOR_DISPATCH 缺省=takeover）⇒ 开（旧公式线）**；
 *    off/shadow 世界 ⇒ 关（撞墙 400 兜底，旧世界发射字节不变）。
 *    2026-11-25 翻转依据：宿主把 max_tokens 钳至 窗−估算prompt，钳制线（≈W−输出预算）
 *    低于 pressure 线（0.8W）——大固定面会话落入两线间死亡带时，缺省世界无任何压缩
 *    触发点，轮次被钳到 out=1 空转（台架 6 轮死复现；README 亦记录过真实端点同款
 *    「门关轮次空转」）。接管判据表三域+64K 实机与门关 6/44 vs 门开 44/44 对照背书后，
 *    旧保守裁定的前提不再成立。逃生口：ARGP_FACTOR_EGRESS=0 显式关。
 */
export interface EgressResolution {
    enabled: boolean;
    /** 非 null = 设置比例线（线 = 声明窗 × ratio）；null = 旧公式线（窗 − 输出预算 − 2%）。 */
    lineRatio: number | null;
}
export declare function resolveEgress(env?: NodeJS.ProcessEnv, compactionThreshold?: number): EgressResolution;
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
    /** C10 夹剪层档（遥测：夹剪臂/shadow 臂区分；归位集在 plan.clipOrder）。 */
    clipEnabled: boolean;
    /** §D 量化排序臂档（遥测：quant/lex 区分）。 */
    qScoreEnabled: boolean;
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
    /** P6-③ 裁定 3：强制先行段（中断轮半截 A + 孤儿工具对；已含在 plan.pruneOrder 头部）。 */
    interruptedForcedSeqs: number[];
    /**
     * 焦点尾窗是否降级（2026-11-13 用户裁定）：最新轮 A/R 占比 ≥50% 且该轮
     * 协议组 >10 ⇒ 焦点从整轮收窄到最新 10 组。false = 现行整轮焦点（字节不变）。
     */
    focusEscalated: boolean;
    /** 降级后的焦点原子集（A 与其全部 callId R）；未降级时为空集。 */
    focusSeqs: ReadonlySet<number>;
    /** 焦点区内协议组总数（遥测：是否触发尾窗/宽度账）。 */
    focusGroupCount: number;
    /** 最新轮 A/R 字节占全部 A/R 字节的比例（遥测/触发线复核）。 */
    latestTurnShare: number;
    /**
     * A1 降级集（2.2.1 包二，仅非升级态）：位置带（超名额）∧ 事实门（全组 defined R
     * 均 superseded 判死）双过的组的全部 seq。发射端（planProtocolGroups）据此放宽
     * 位置/轮次门；事实门（missing/live R/附件/连续性）一律不放宽。空集 = 零行为变化。
     */
    demotedSeqs: ReadonlySet<number>;
    /** 事实门后实际降级组数（遥测；[argp-quota] 影子列）。 */
    demotedGroupCount: number;
    /** 降级带候选组数（仅位置门，事实门之前；遥测）。 */
    quotaBandGroups: number;
    /** δ·W_eff 收缩后实际生效的焦点名额（遥测；窗未知 = 固化 N）。 */
    quotaUsed: number;
}
/** 词表 note 的行首标记（单一事实源在 constants.ts；此处保留 re-export 供既有测试/调用方）。 */
export { VOCAB_NOTE_MARKER };
export interface ProtocolGroup {
    aSeq: number;
    rSeqs: number[];
    /** surface 序、连续切片；prune-tx 的 shadowedRange 必须与 replace 范围严格相等。 */
    seqs: number[];
    chars: number;
    atoms: Atom[];
}
export interface ProtocolGroupPlan {
    groups: ProtocolGroup[];
    /** 未被组吸收的 selected R（A 保留）→ 空 tool/result 克隆，配对不破。 */
    rOnly: number[];
}
export interface FocusTailPlan {
    /** 是否触发降级（最新轮 A/R 占比 ≥ 阈值且该轮协议组数 > cap）。 */
    escalated: boolean;
    /** 降级后的焦点原子集（最新 cap 组 A + 全部 live R）；未降级时为空集。 */
    focusSeqs: Set<number>;
    /** 焦点区内（最近 focalTurns 轮）协议组总数（遥测）。 */
    groupCount: number;
    /** 最新轮协议组数（触发判据原料）。 */
    latestTurnGroupCount: number;
    /** 最新轮 A/R 字节 / 全部 A/R 字节。 */
    latestTurnShare: number;
    /**
     * A1 降级带候选（2.2.1 包二，**仅非升级态**）：超出焦点名额的组（barrier/附件组豁免
     * 不占名额；open 区组不入带）。本函数只管位置与组形；**事实门**（全组 defined R 均
     * 被 superseded 判死）在 decide 裁决。升级态为空。
     */
    demotedGroups: number[][];
    /** δ·W_eff 收缩后本笔实际生效的名额数（遥测；窗未知 = 固化 N）。
     *  注意：升级态 cap=10 路径获胜，本字段仍是 δ 折算值（计算先于 cap 分流）——
     *  纯计算量非生效量；升级态 demotedGroups=[] 且 [argp-quota] 行不发（band=0），
     *  观察哨不会读到幻影名额。 */
    quotaUsed: number;
}
/**
 * 焦点尾窗规划（2026-11-13 用户裁定）：**只在最新轮自身过大时**把焦点从整轮
 * 降级为该轮最新的至多 `cap` 个 A+R 协议组。正常轮（占比 <阈值或组数 ≤cap）
 * 原样返回 escalated=false，硬保护/组剪/排序全部走现行 turn 判据（零行为变化）。
 *
 * 判据用 A/R 字节占比作代理（本轮真实 token 密度未知；用户原话"最后一轮上下文
 * 占比超过已有的一半"）。组按 A 的 surface 位置排序，取最新 cap 组；焦点集含
 * A 与其全部 live R（闭包，组不拆分）。
 *
 * 2.2.1 包二（A1）追加：非升级态下产出**降级带候选**（超出焦点名额的旧组）——
 * 位置门放宽，事实门（superseded 判死）在 decide 裁决；升级态走原 cap 路径字节不变。
 */
export declare function planFocusTail(atoms: readonly Atom[], surfaceSeqs: readonly number[], opts: {
    protectFromTurn: number;
    cap: number;
    latestTurn: number;
    shareThreshold: number;
    /** A1 名额（2.2.1）：非升级态硬保护的尾部组数 N（δ 收缩前上界）与折算参数。 */
    quotaGroups: number;
    openTurn: number | null;
    charsPerToken: number;
    /** 附件 R 的 seq（barrier 面）：附件组豁免——不占名额、永不入降级带。 */
    attachmentSeqs: ReadonlySet<number>;
    quotaBudgetRatio: number;
    /** W_eff（token）；未知/≤0 ⇒ 名额不收缩（manual 无快照回退 N）。 */
    windowEffTokens?: number;
}): FocusTailPlan;
/**
 * A+R 组剪选择（2026-11-13 用户裁定，design-group-prune）：
 *  - R 入选（或已是因子桩）且 A 的全部 callId 闭包成立 ⇒ A+R 整组驱逐；
 *  - 旧 A+桩组（K pack）即使 R 未入选也驱逐（死重 GC，回收 K 面 args）；
 *  - A 有 live R（未入选）⇒ A 保留，selected R 走空 tool 桩；
 *  - 缺失 R 的 A（中断轮）只有在 forced（in selected）时才整组驱逐；
   *  - 焦点/open 保护：默认（focusSeqs=null）非 forced 组必须 turn < protectFromTurn
   *    且不在 open turn；焦点尾窗降级（focusSeqs≠null）时改按焦点原子集保护，焦点外
   *    组（含 open 轮内）可整组驱逐；
   *  - A1 降级集（2.2.1 包二，demotedSeqs，仅 focusSeqs=null 侧生效）：事实门已判死
   *    的组放宽位置/轮次两道**位置门**；missing/live R/附件/连续性**事实门一律不放宽**；
   *  - 组 seqs 必须是 surface 连续切片（防止 replace 区间吞掉夹在中间的节点）。
   */
export declare function planProtocolGroups(atoms: readonly Atom[], surfaceSeqs: readonly number[], selected: ReadonlySet<number>, opts: {
    protectFromTurn: number;
    openTurn: number | null;
    /** null = 未降级（turn/open 判据）；非 null = 焦点尾窗降级（只保护该集合）。 */
    focusSeqs: ReadonlySet<number> | null;
    stubSeqs: ReadonlySet<number>;
    attachmentSeqs: ReadonlySet<number>;
    /**
     * A1 降级集（2.2.1 包二）：decide 事实门（全组 R superseded 判死）放行的组 A seq
     * 及其 R。仅 focusSeqs=null（非升级态）时被消费：放宽本函数的 turn/位置两道保护门，
     * 其余事实门照常。null/缺省 = 零行为变化（旧调用方字节不变）。
     */
    demotedSeqs?: ReadonlySet<number> | null;
}): ProtocolGroupPlan;
export declare class FactorEngine {
    /**
     * 被剪账本**按会话分桶**：账本键是 rootSeq（会话内 seq），引擎却是宿主进程级单例。
     * 共享一份 = A 会话的 seq 被 B 会话的 recall_history 取到 B 的无关事件（静默串台），
     * 且 addPruned 的 rootSeq 去重会让第二个会话的同 seq 条目被丢弃。
     * `ledger` 兼容读 = 最近一次被 observe/decide/vocabulary 触达的桶（单会话测试/诊断）。
     */
    private readonly ledgers;
    private lastLedger;
    private states;
    private readonly host;
    private readonly cfg;
    constructor(host: FactorEngineHost, config?: FactorEngineConfig);
    /** 会话账本（懒建；见 ledgers 字段注释）。public：召回工具按执行会话取桶。 */
    /** 散文带 cap 覆盖（search_history 装配读；undefined ⇒ 装配层按窗相对现算）。 */
    proseScanCapOverride(): number | undefined;
    ledgerOf(session: Session): FactorLedger;
    /** 兼容读：最近一次被 observe/decide/vocabulary 触达的会话账本（诊断/单会话测试）。 */
    get ledger(): FactorLedger;
    /**
     * 召回入口账本（冷 resume 修复）：新进程里进程内账本是空的，而账本的唯一真相是
     * 日志（被剪 R 的 shadowed 投影 + 原事件仍在）。召回工具直接读账本 ⇒ 必须先在
     * 首召回时补一次 observe 重放；否则 resume 后 `list_labels` 谎报 0 条、
     * `recall_history` 永远 no match，直到下一次压缩事务才"突然恢复"。
     * 幂等：observe 的 rootSeq 去重保证重复重放不双计；每会话每进程至多补一次
     * （后续压缩事务已在线更新）。
     */
    ledgerForRecall(session: Session): FactorLedger;
    private stateOf;
    /**
     * 观察路（sticky 通道 + 被剪账本 + 在线文件快照）。幂等：ledger rootSeq 去重。
     */
    private observe;
    /** 纯决策（无发射副作用）：单测主对象。targetReleaseChars = 需释放的下界。 */
    decide(session: Session, targetReleaseChars: number, opts?: {
        windowEffTokens?: number;
    }): FactorDecision;
    /**
     * §D 影子反事实记录（只读）：在同一批候选上，把 sticky/focal/err 从硬保护降级为
     * 软排序后重算一次 planPrune，把「多释放了哪些枚、各因哪个降级位、cur vs shadow 的
     * released/shortfall」写进日志。发射用的 plan 完全不受影响——本方法不返回、不改状态。
     */
    private logShadowCounterfactual;
    /**
     * 压力剪一笔：决策 → 协议组（A+R 整组 + K pack）/ R-only 空桩 → prune-tx 成对发射。
     * 目标不达不放宽；组剪收益按区间实际 chars 复核。
     *
     * **2.2.2 根修（2026-11-26 session-43df801e 存档加载失败案）：本引擎不再发射任何
     * 非 append 的 tool/result。** 旧 C10 夹剪臂以「R-only tool/result replace 改写
     * inner text 保 callId 配对」发射，宿主 v4 fold 对该形态执行 requireTurn()，而压缩
     * 事务可落在轮间隙（手动 /compact 走宿主 idle maintenance，实证
     * compaction/start.data.turn === null）⇒ 无合法表达、写入侧不拦、下次加载整档
     * corrupt 拒载。根修把夹剪从「改写 R 节点」改为「组剪检查点的文本变体」：
     * 同一整组区间照常以 user/message 检查点离场（user replace 不受轮约束），
     * 检查点文本携带该组 R 的头尾预览（clip-shape 模板）而不是中性标记。
     * 因此 C10 的信息轴（信息悬崖 vs 头尾留真）保留，且发射形态与压缩时点无关。
     */
    compactIfNeeded(session: Session, targetReleaseChars: number, opts?: {
        windowEffTokens?: number;
    }): CompactionResult | null;
    /**
     * 表面桩游程随剪回收（2026-11-26 审计：桩 kind=compact-checkpoint ⇒ atomize 判 X，
     * 永不进 A+R 剪枝面；prose 三桶带按 own-kind 排除 ⇒ 双盲不可回收；§11.8 归并通道
     * 随图臂退役 ⇒ 跨事务累积泄漏 + 同文连排破坏角色交替）。
     * 事务内的相邻同文并条（prune-tx 归并 pass）已阻断新游程生成；本方法处理**跨事务
     * 累积与存量会话**：扫当前表面极大同文 checkpoint 桩游程（≥FACTOR_STUB_RUN_MIN），
     * 发一笔 tombstone-merge 事务每条并一。纪律：判据认 kind+逐字节同文，不认文案子串
     * （避开图臂 '[elided ' 文案漂移坑）；同文 ⇒ 归并零信息损失（交互桩文本含各自
     * keys，异文自然不并，指针语义保留）。**绝不独立发维护事务**——只在 compactIfNeeded
     * 已有事务落地（surface 已换代、换代税已交）后随剪执行；异常只记日志不影响主事务。
     */
    private reclaimStubRuns;
    /**
     * §B-2a 结构去重驱逐（0-LLM）：宿主**每次压缩后**把再注入三件套
     * （agent-instructions/runtime-context/skill-catalog）重新注入一份——档案实锤
     * 2026-11-25（prose 域 catalog ×4 = 首注 + 3 次压缩）。旧副本与新副本内容同源，
     * 驱逐无需摘要、无需入账（U 无召回标签）。每 kind 保留 surface 最新一枚，旧者
     * 整节点离场（中性检查点墓碑）。时机：重复只在**下一笔事务前**存在（重注入发生
     * 在压缩事务之后），本方法在接管事务的开头回收。
     */
    dedupeReinjected(session: Session): CompactionResult | null;
    /**
     * 组剪检查点文本（2.2.2 根修后 C10 夹剪层的唯一合法落点）：把一个整组区间压缩成
     * **单条 user/message 检查点**（user replace 不受轮/步约束，压缩事务可安全落在轮间隙），
     * 文本三态由组内成员决定：
     *  - 夹剪（clip 开 ∧ 组内有 clipOrder 成员 ∧ 原始 R 文本可读）⇒ 头尾预览文本；
     *  - 交互组 ⇒ 专段带 tool: 即时指针（P7 带 + ZT7/ZT10）；
     *  - 其余 ⇒ 零指针中性标记。
     *
     * 旧夹剪臂直接 replace 原 R 节点本体（tool/result replace）——宿主 v4 fold 的
     * `requireTurn()` 让它在轮间隙无合法表达（session-43df801e 存档加载失败案）；
     * 根修把「信息保留」从节点形态挪到检查点文本，且组剪决策面与 clip 关闭时相同，
     * A/B 变量只剩「检查点是否携带头尾预览」。多 R 组取最大一枚的预览（预算有界）。
     */
    private groupCheckpointText;
    /** 实体标签选择序：document → command → errorcode → scope → **tool**（夹剪检查点
     *  首行共用）。scope 也是词表键（factor-ledger.indexKeys）；漏掉会让只有目录的 grep R
     *  被标 "无实体标签"，而模型其实可以 recall_history(scope:…)。
     *  tool 尾位（2026-11-16 design-tool-facet §1）：非空门槛同 indexKeys。 */
    private stubKey;
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
