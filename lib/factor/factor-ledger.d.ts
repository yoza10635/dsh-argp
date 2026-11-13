import type { Facet, RTags, StickyState } from './types.ts';
export declare function indexKeys(tags: RTags): string[];
/** 词表可列类别（tool 仅展示不进查询键、scope 仅辅助排序——都不渲染进行）。 */
export declare const VOCAB_FACETS: readonly ["document", "command", "errorcode"];
export type VocabFacet = (typeof VOCAB_FACETS)[number];
export declare function facetOfKey(key: string): Facet | null;
export interface LedgerEntry {
    /** append root seq：去重键，也是稳定排序基。 */
    rootSeq: number;
    turn: number;
    tags: RTags;
}
export interface InvertedStat {
    rootSeqs: number[];
    count: number;
    lastSeenTurn: number;
}
export interface StickyTrack {
    /** `${documentKey}|${errorcode}`（交集区键，§2.2）。 */
    key: string;
    file: string;
    errorcode: string;
    state: StickyState;
    failCount: number;
    firstFailTurn: number;
    lastFailTurn: number;
    /** 相邻两次失败之间出现过对该文件的成功写（修复宣称）——sticky 触发条件。 */
    fixClaimedBetween: boolean;
    /** 出现过的 tool 类（闭集论证用；闭集判据不依赖它，见 sweepClosed）。 */
    toolClasses: Set<string>;
}
export interface StickyView {
    key: string;
    file: string;
    errorcode: string;
    state: StickyState;
    failCount: number;
    firstFailTurn: number;
    lastFailTurn: number;
    fixClaimedBetween: boolean;
}
export interface PrunedQuery {
    /** 全键形标签（`document:c:/x`、`command:npm`、`errorcode:ERESOLVE`）。
     *  2026-11-14 起语义 = **真 AND**：候选必须携带全部在场标签（不在账本的标签剔除回显、
     *  不参与求交）。anyOf（OR 逃生口）2026-11-14 对抗审查裁定缓办：零实测需求牵引、
     *  排序键/解析管线/翻页护栏四处新语义未定，等 AND 在真实会话跑出"双标签无交集"
     *  频率后再议。 */
    labels: string[];
    limit: number;
    /**
     * 排序档位（缺省 relevant）：
     *  - relevant：hitLabels 数降序 → turn 降序 → rootSeq 降序（历史行为；纯 AND 下
     *    hitLabels 数为常数 ⇒ 与 fresh 等价，契约文案如实说明）；
     *  - fresh：turn 降序 → rootSeq 降序；
     *  - timeline：turn 升序 → rootSeq 升序（episode 因果阅读序）。
     */
    order?: 'relevant' | 'fresh' | 'timeline';
    /** 分页游标 = 上一次结果的 nextCursor；与 epoch 配套才有效。翻页必须原样重传
     *  全部查询参数（labels/limit/order）——cursor 是"当前排序的 offset"，换参数 =
     *  换排序，语义不作跨参数延续。 */
    cursor?: number;
    /** 快照 epoch：与账本当前值不符 ⇒ 期间有剪枝入账，排序已漂移。 */
    epoch?: number;
}
export interface PrunedQueryResult {
    rows: Array<{
        rootSeq: number;
        turn: number;
        hitLabels: string[];
        /** outline/词表行原料（全部来自贴标期 RTags；verdict 只认宿主结构化失败）。 */
        tool: string;
        failed: boolean;
        errorish: boolean;
    }>;
    nextCursor: number | null;
    epoch: number;
    /** 传入 epoch 与当前不符：游标失效，调用方须从头重查（不假装稳定分页）。 */
    epochStale: boolean;
}
export declare class FactorLedger {
    private entries;
    private inverted;
    /** sticky 通道独立去重：观察流含存活 R，与剪枝通道互不污染。 */
    private observed;
    private sticky;
    private _epoch;
    get epoch(): number;
    get prunedCount(): number;
    /**
     * 剪枝入账。rootSeq 重复（replace 链 / 重放双计）⇒ 返回 false，绝不双计。
     * 不合文法的标签照单入索引（§1.3：留索引），出口渲染处拦截。
     */
    addPruned(entry: LedgerEntry): boolean;
    /**
     * sticky 状态机进料：**全部** R 事件（含存活者——"两次失败夹成功写"的观察
     * 面本来就在存活区）。rootSeq 去重与 addPruned 独立。
     */
    observeR(rootSeq: number, turn: number, tags: RTags): void;
    /**
     * 闭集扫描（引擎每轮调用）。I-DIR 严口径：窗内**任何** tool 类复发都重置
     * 观察窗（三条件交集版更松，弃用）；只有 sticky 且窗内零复发才 closed。
     */
    sweepClosed(currentTurn: number, windowTurns: number): void;
    /** open/sticky 全量视图（引擎排序硬保护 + 词表标注行消费）。 */
    stickyActive(): StickyView[];
    stat(key: string): InvertedStat | null;
    /** item 句柄校验（recall_history item= 钻取）：rootSeq 必须在**被剪账本**内——
     *  对 live seq 用 item 必须拒绝，否则 item 就是无标签限制的 seq 召回通道（假通道复辟）。 */
    hasEntry(rootSeq: number): boolean;
    /** item 钻取的行元数据（仅账本内 seq 有值；outline/item 路径共用）。 */
    entryOf(rootSeq: number): {
        turn: number;
        tool: string;
        failed: boolean;
        errorish: boolean;
    } | null;
    /**
     * 标签 **AND** 召回（§1.4 需求驱动通道；2026-11-14 用户批准的 Kimi 方案 R2 内核）。
     * 候选 = 在场标签倒排集的交集；不在账本的标签剔除回显（droppedLabels 同口径），
     * 不参与求交（一个空想标签不杀死整个查询）。
     * 未命中的查询标签如实剔除并回显（droppedLabels），不静默。
     */
    queryPruned(q: PrunedQuery): PrunedQueryResult;
    /** cursor/epoch 分页（从 queryPruned 拆出：排序与分页两个正交关注点）。 */
    private pageOf;
    /** queryPruned 的 droppedLabels（组合根转发用，免调用方摸索引）。 */
    droppedLabels(labels: string[]): string[];
    /**
     * 路径后缀归一匹配（2026-11-14 用户裁定；alpha4 T19/T30 实锤：模型猜相对路径标签
     * `document:.material/p02-1.md`，账本存绝对路径 ⇒ no-match 后模型放弃召回、凭记忆作答）。
     * 只对路径形键（document:/scope:）；`rel:` 前缀键剥离后同权。多候选时调用方
     * fail-closed 列出候选，绝不猜（与词表 fail-closed 同纪律）。
     */
    matchBySuffix(prefix: 'document:' | 'scope:', tail: string): string[];
    /**
     * 词表行（每类 topN，数量降序 → 新鲜度降序）。**只从被剪账本派生**。
     * 出口 fail-closed：不合当前文法的键（文法表改版/历史污染）剔除并计数。
     * 行内线索（Kimi R4 紧版，2026-11-14）：lastTool/lastFailed 取最后一条的宿主结构化
     * verdict；err-sig 只**计数**不判死——errorish 是文本信号（日志正文含 ENOENT 也置真），
     * 绝不当"该次调用失败"渲染（types.ts RTags.failed 注释纪律）。
     */
    vocabularyRows(facet: VocabFacet, topN: number): {
        rows: Array<{
            key: string;
            count: number;
            lastSeenTurn: number;
            lastTool: string;
            lastFailed: boolean;
            errSigCount: number;
        }>;
        omitted: number;
        rejected: number;
    };
}
export interface RenderVocabularyOptions {
    ledger: FactorLedger;
    topNPerFacet?: number;
    budgetChars?: number;
    /** 触发钩子文案：默认中文，preset 双语在 P2 接。 */
    stickyHook?: (v: StickyView) => string;
}
export interface RenderVocabularyResult {
    text: string;
    /** 各类被 topN 裁掉的数量（>0 时尾部有 list_labels 下钻提示）。 */
    omitted: Partial<Record<VocabFacet, number>>;
    /** 预算截断：后续类别整类未渲染（诚实标记，不静默丢）。 */
    truncated: boolean;
    rejectedLabels: number;
}
export declare function renderVocabulary(o: RenderVocabularyOptions): RenderVocabularyResult;
