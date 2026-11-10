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
    /** 全键形标签（`document:c:/x`、`command:npm`、`errorcode:ERESOLVE`）。 */
    labels: string[];
    limit: number;
    /** 分页游标 = 上一次结果的 nextCursor；与 epoch 配套才有效。 */
    cursor?: number;
    /** 快照 epoch：与账本当前值不符 ⇒ 期间有剪枝入账，排序已漂移。 */
    epoch?: number;
}
export interface PrunedQueryResult {
    rows: Array<{
        rootSeq: number;
        turn: number;
        hitLabels: string[];
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
    /**
     * 标签交集召回（§1.4 需求驱动通道；工具接线在 P2，本函数是查询内核）。
     * 排序：命中标签数降序（交集优先）→ turn 降序（order=fresh）→ rootSeq 降序。
     * 未命中的查询标签如实剔除并回显（droppedLabels），不静默。
     */
    queryPruned(q: PrunedQuery): PrunedQueryResult;
    /** queryPruned 的 droppedLabels（组合根转发用，免调用方摸索引）。 */
    droppedLabels(labels: string[]): string[];
    /**
     * 词表行（每类 topN，数量降序 → 新鲜度降序）。**只从被剪账本派生**。
     * 出口 fail-closed：不合当前文法的键（文法表改版/历史污染）剔除并计数。
     */
    vocabularyRows(facet: VocabFacet, topN: number): {
        rows: Array<{
            key: string;
            count: number;
            lastSeenTurn: number;
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
    recallHook?: (key: string) => string;
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
