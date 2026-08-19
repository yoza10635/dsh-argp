import type { Context } from '@deepseek-ai/cordis';
import { CompactionEngine } from '@deepseek-ai/dsh-compaction';
import type { CompactionAgentContext, CompactionResult, CompactionTrigger, ManualCompactAgentContext } from '@deepseek-ai/dsh-compaction';
import type { Session } from '@deepseek-ai/dsh-session';
export type AtomType = 'U' | 'A' | 'R' | 'X';
export interface Atom {
    id: number;
    seq: number;
    type: AtomType;
    turn: number;
    text: string;
    toolCallIds: string[];
    cites: string[];
    citesFailed: boolean;
}
export type EdgeLevel = 'critical' | 'supporting' | 'contextual';
export interface SemanticEdge {
    from: number;
    to: number;
    level: EdgeLevel;
}
export interface DeterministicEdge {
    from: number;
    to: number;
}
export declare const EDGE_WEIGHTS: Record<EdgeLevel, number>;
/** 比例预算纯函数：window = ctx × windowRatio；retain = window × retainRatio（缺省回退）。导出供测试。 */
export declare function scaleBudgets(contextWindow: number | undefined, opts: {
    windowRatio?: number;
    retainRatio?: number;
    explicitWindow?: number;
    explicitRetain?: number;
    fallbackWindow?: number;
    fallbackRetain?: number;
}): {
    windowTokens: number;
    retainTokens: number;
};
export interface ArgpGraphConfig {
    /** 触发线（token）。不传时默认 = 适配器声明的 contextWindow × windowRatio（默认 0.8）。 */
    windowTokens?: number;
    /** 保留目标（token）。不传时默认 = 触发线 × retainRatio（默认 0.2，压缩率 1/5）。 */
    retainTokens?: number;
    /** 触发线占上下文比例（默认 0.8；仅当 windowTokens 未显式指定时生效）。 */
    windowRatio?: number;
    /** 保留目标占触发线比例（默认 0.2；仅当 retainTokens 未显式指定时生效）。 */
    retainRatio?: number;
    recencyGuard?: number;
    turnGuard?: number;
    minSpanChars?: number;
    charsPerToken?: number;
    /** 单次剪枝事务的最大贪心 pass 数（默认 16；生产档大批量剪枝应调高）。 */
    maxPasses?: number;
    /** 触发保留余量（token）；默认 0。windowTokens 会先减去该值作为触发线。 */
    reserveTokens?: number;
    /** 可选显式 token 测量函数；不传则退化为字符估算。 */
    measureTokens?: (session: Session) => {
        contextTokens: number;
        surfaceTokens: number;
    };
    /** 是否启用 summarize 降级。默认 false：本地单 slot 模型下 summarize 会破坏 KV cache，ARGP 走 force_prune。 */
    enableSummarize?: boolean;
    /** 降级链：lifecycle（默认，闭包→force） / summarize / force / fail。 */
    degradationStrategy?: 'lifecycle' | 'summarize' | 'force' | 'fail';
    /** 排序模式（spike 18 提案，默认 legacy 保持现状）：
     *  legacy： [lvl, eff, lastRef, seq]（绝对 eff，忽略体积）
     *  density：eff 同档内 token 降序（大 token 先剪，单位 token 重要性）
     *  density-chain：density + 版本链存活代表 eff 叠加 (count-1)*1 */
    sortMode?: 'legacy' | 'density' | 'density-chain';
}
export interface GraphPruneRecord {
    at: string;
    compactionId: string;
    intervals: {
        start: number;
        end: number;
        tombstoneSeq: number;
    }[];
    startEventSeq: number;
    summaryEventSeq: number;
    endEventSeq: number;
    shadowedSeqs: number[];
    prunedAtoms: {
        id: number;
        type: AtomType;
        seq: number;
    }[];
    semanticEdges: number;
    candidates: number;
    charsBefore: number;
    charsAfter: number;
    forced: boolean;
}
/** 从一个事件投影出模型可见文本（text + tool-call 概要 + tool-result 内层 text；reasoning 不算）。 */
export declare function eventText(session: Session, seq: number): string;
/** 提取 A 文本尾部的 cites JSON（支持裸 JSON 与 ```json 围栏）；返回剥离后正文与前缀列表。 */
export declare function extractCites(text: string): {
    body: string;
    cites: string[];
    attempted: boolean;
    parseFailed: boolean;
};
/** cites 服从率度量台账（C7-cites 判决用）。 */
export interface CiteStats {
    aAtoms: number;
    declared: number;
    resolved: number;
    ambiguous: number;
    failed: number;
}
/** list_pruned 工具的剪枝节点目录条目。 */
export interface PrunedNodeInfo {
    seq: number;
    type: AtomType;
    turn: number;
    firstLine: string;
    citedBySeq: number[];
    /** 被剪瞬间的有效重要性（recall 价值继承的来源，§3-3）。 */
    eff: number;
}
export declare class ArgpGraphEngine extends CompactionEngine {
    static inject: string[];
    readonly windowTokens: number;
    readonly retainTokens: number;
    readonly windowRatio: number;
    readonly retainRatio: number;
    /** true = config 显式给 windowTokens；false = 运行时按 contextWindow × windowRatio 解析。 */
    private readonly explicitWindowTokens;
    /** true = config 显式给 retainTokens；false = 运行时按 windowTokens × retainRatio 解析。 */
    private readonly explicitRetainTokens;
    /** 最近一次 resolveScaledBudgets 解析出的有效预算（recall 预算等后续同步使用点读取）。 */
    private resolvedWindowTokens;
    readonly recencyGuard: number;
    readonly turnGuard: number;
    readonly minSpanChars: number;
    readonly charsPerToken: number;
    readonly maxPasses: number;
    readonly reserveTokens: number;
    readonly tokenMeterFn?: (session: Session) => {
        contextTokens: number;
        surfaceTokens: number;
    };
    readonly enableSummarize: boolean;
    readonly degradationStrategy: 'lifecycle' | 'summarize' | 'force' | 'fail';
    readonly sortMode: 'legacy' | 'density' | 'density-chain';
    /** dsh token-meter 服务；真会话中可用时优先用于 token 测量和 contextWindow 探测。 */
    private readonly tokenMeter;
    readonly records: GraphPruneRecord[];
    readonly recallCalls: {
        seq: number;
        hit: boolean;
    }[];
    readonly recallQueryCalls: {
        query: string;
        count: number;
        hits: number;
    }[];
    readonly citeStats: CiteStats;
    /** §3-3 recall 价值继承：最近一次 recall 的旧原子 seq 与结果 R 原子 seq（建图时用）。 */
    private recallSourceSeq;
    private recallResultSeq;
    /** 最近一次建图的语义边（判决 G3 读：被引原子是否获得保护）。 */
    lastEdges: SemanticEdge[];
    /** 最近一次建图的确定性边（组内 A→R，不参与语义级别排序）。 */
    lastDeterministicEdges: DeterministicEdge[];
    /** 已剪节点目录（seq -> 元数据 + 依赖），供 list_pruned 查询；新事务覆盖旧 seq。 */
    readonly prunedNodeIndex: Map<number, PrunedNodeInfo>;
    /** 闭包生命周期剪除记录。 */
    readonly closurePrunes: {
        closureId: string;
        rootSeq: number;
        prunedSeqs: number[];
        at: string;
    }[];
    private nextClosureId;
    private closureLastRecalled;
    private recallCallsThisTurn;
    private recallCharsUsed;
    private session;
    private shadowedSession;
    private shadowedSet;
    private shadowedScanned;
    constructor(ctx: Context, config?: ArgpGraphConfig);
    setSession(session: Session): void;
    /** 生成上下文头部 catalog（设计稿 §5）：只列被剪 U/A，snippet 截断，≤maxItems 条。 */
    catalogText(maxItems?: number, snippetChars?: number, tokenBudget?: number): string;
    /** 按关键词查询被剪节点原文（设计稿 §6 的 recall(query) 简化版）。 */
    recallQuery(query: string, maxResults?: number): string;
    /**
     * 增量维护被遮蔽 surface seq 集合：事件日志只追加，游标从上次扫描处继续，
     * 避免每次 recall/剪枝压力检查都 O(事件总量) 重扫。session 切换时重置。
     */
    private shadowedSeqsOf;
    recall(seq: number): string | null;
    /** 原子化（§4.1）：只投影 surface 节点；U/X/R/A 四类（tool/call 不进 surface，无 T 类）。cites 统计在 A 原子处累计。 */
    atomize(session: Session): Atom[];
    /**
     * 建图（§4.2 + §4.7）：确定性边不计级别；cites 子串匹配生成 supporting 语义边
     * （唯一命中采纳；多命中 AMBIG → 最早命中 + U 优先）。
     * 实测修正（spike 5 首跑）：原 startsWith 头部匹配边数归零——逐字引文起点常落在
     * 原子文本中段，改 includes 子串匹配（同“被动头部匹配陷阱”教训）。
     */
    buildGraph(atoms: Atom[]): {
        edges: SemanticEdge[];
        deterministicEdges: DeterministicEdge[];
        inDegree: Map<number, number>;
    };
    /** surface 可见字符总量（与 spike 4 同基准）。 */
    private visibleChars;
    /** 测量当前上下文 token。真会话优先用 dsh tokenMeter；否则用配置函数；否则字符估算。 */
    private measureTokens;
    /** §4.4 简化版本链去重：相同 A 文本 / 同源 R（按配对 A 的 toolCall 签名）保留最新，旧副本标记为可剪；A/R 配对同剪。
     *  返回 { dupIds, chainLen }：chainLen 记录每个存活代表（newer）的链长（出现次数），供 density-chain 排序叠加 eff。 */
    private findVersionDuplicates;
    /** 当前会话最大 turn 号（用于 recall 回拉后的防抖窗口）。 */
    private latestTurnOfSession;
    /** recall 命中被剪闭包内节点时，将该闭包拉回 ACTIVE 并记下防抖轮。 */
    private noteRecallHit;
    /** recall 预算：单次结果与累计结果都按窗口比例截断（窗口取最近解析的有效预算）。 */
    private budgetRecallText;
    /** P3：summarize 末环占位。当前未实现，默认返回 null 以继续 force_prune。 */
    private summarizeCriticalChain;
    /** P2：尝试按闭包生命周期剪除一个 PRUNABLE 闭包。返回 CompactionResult 或 null。 */
    tryPruneClosures(session: Session, atoms: Atom[], edges: SemanticEdge[], inDegree: Map<number, number>, askCover: Map<number, number>, latestTurn: number): CompactionResult | null;
    /**
     * 预算解析：显式配置用显式值；否则从适配器声明的 contextWindow 按比例推导——
     *  windowTokens = contextWindow × windowRatio（默认 0.8），retainTokens = windowTokens × retainRatio（默认 0.2）。
     *  上下文容量由其他插件（模型适配器声明）决定，本引擎不硬编码。
     *  解析顺序：1) session.requestContext()（request/context 事件，真会话最可靠）；
     *           2) llm.resolveModelInfo(provider, model)；3) 静态默认值。
     */
    private resolveScaledBudgets;
    /**
     * 压力剪枝（§4.3/§4.5）：估算量 ≥ windowTokens 时重建图，按排序键逐弱剪至 ≤ retainTokens。
     * 候选：A/T/R、语义入度 0、非近因豁免区、非最新轮、非保守保护；U/X 永不参剪。
     * 排序键（§4.5）：最低关联语义级别升 → effective_importance 升 → lastRefRound 升 → seq 升。
     * 候选耗尽仍超预算 → force_prune（忽略入度，§4.6.2）。
     */
    compactIfNeeded(agent: CompactionAgentContext, _trigger: CompactionTrigger, _signal: AbortSignal): Promise<CompactionResult | null>;
    compactNow(agent: ManualCompactAgentContext, signal: AbortSignal): Promise<CompactionResult | null>;
    compactRegion(start: number, end: number, agent: CompactionAgentContext, signal?: AbortSignal): Promise<CompactionResult>;
    /** 为手动 compactNow 选择一个确定性的最老 A/R 连续块。 */
    private selectManualRange;
    /** 一笔事务剪多个极大连续区间：start → summary → 每区间 checkpoint replace → end。 */
    private pruneIntervals;
    /** 日志尾部的 open turn（pre-step 时刻用于 compaction 括号的 owner）。 */
    private detectOpenTurn;
}
export default ArgpGraphEngine;
