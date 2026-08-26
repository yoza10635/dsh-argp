import type { Context } from '@deepseek-ai/cordis';
import { CompactionEngine } from '@deepseek-ai/dsh-compaction';
import type { CompactionAgentContext, CompactionResult, CompactionTrigger, ManualCompactAgentContext } from '@deepseek-ai/dsh-compaction';
import type { Session } from '@deepseek-ai/dsh-session';
import type { CommandId } from '@deepseek-ai/dsh-commands/brand';
import type { NodeState as NodeStateLabel } from './log-access.js';
export type { NodeState, LogRow, LogRowType } from './log-access.js';
import type { ParsedCite } from './cites-strip.js';
export type { ParsedCite, CiteLevel } from './cites-strip.js';
export type AtomType = 'U' | 'A' | 'R' | 'X';
export interface Atom {
    id: number;
    seq: number;
    type: AtomType;
    turn: number;
    text: string;
    toolCallIds: string[];
    cites: ParsedCite[];
    citesFailed: boolean;
    /**
     * P4（U-info 剪枝放行）：仅 U-info 聚合副本有值——原始用户消息的日志 seq
     * （recall_detail(sourceSeq) 的恢复目标）。dialog 副本（无 argp meta）与
     * 普通 user 消息均无此字段，故 `sourceSeq !== undefined` 即 U-info 识别判据：
     * ① isAtomCandidate 按 R 待遇参剪；② 排除出闭包 root（防 U-info 误当
     * task-init 根拖整段退休）。
     */
    sourceSeq?: number;
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
/**
 * A8（问题 10 修订）：ask 检测中英双语纯函数。
 * 英文：'?' / ask / what；中文：？/ 吗 / 呢 / 什么 / 怎么 / 如何 / 能否 / 能不能。
 * /帮我/ 由子串收窄为句首（^请|^帮我|^能不能|^能否），避免 "顺便帮我带个话" 之类
 * 非问句/非请求主语误命中；疑问词 什么/怎么/如何 仍保留子串（问句核心成分，方向保守=少剪）。
 * 导出供测试直接锁定收窄行为。
 */
export declare function looksAskText(text: string): boolean;
/**
 * user/message 原子分类（P0 分类陷阱防线，plan「分类陷阱」节）。
 *
 * 顺序不可交换：先识别 `data[argp].info === true`（U-info 聚合副本——由 peratom 管线
 * 插件 append，但必须按 U 待遇参与剪枝候选），再落 `source.kind === 'plugin'` → X
 * （墓碑/checkpoint）判定。若先判 plugin-source，U-info 会被分类成 X 而**全局不可剪**，
 * P4 的候选放行将永远失效。
 *
 * 此前该规则内联在四处（catalogText / recallQuery / atomize / rebuildLedgerFromLog），
 * 现统一收敛到本纯函数；导出供测试直接锁定顺序行为（A8 先例）。
 */
export declare function classifyUserMessage(data: unknown): 'U' | 'X';
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
    /** 排序模式（spike 18 提案，2026-08-23 起默认 density）：
     *  density（默认）：eff 同档内 token 降序（大 token 先剪，单位 token 重要性；spike 19 实证同达成度 recall 2→0）
     *  legacy： [lvl, eff, lastRef, seq]（绝对 eff，忽略体积；显式传入以回退旧行为）
     *  density-chain：density + 版本链存活代表 eff 叠加 (count-1)*1 */
    sortMode?: 'legacy' | 'density' | 'density-chain';
    /**
     * latestTurn 口径（P4 修复）：
     *  semantic（默认）：只算真实 U/A/R 活动的 turn；注入型 X 节点（system-reminder、
     *    ARGP 自己的 tombstone）不推进轮次计数，避免"注入撑大 latestTurn → 闭包保护
     *    窗口 latestTurn-k 被抬高 → 本应受保护的旧闭包被提前剪"。
     *  all：旧口径，把 X 一并算进 latestTurn（既往实验数据基线；对照实验需显式指定）。
     * 注意：本项影响 turnGuard 与闭包保护窗口的判定，口径变更需在实验台账标注。
     */
    turnBasis?: 'semantic' | 'all';
    /**
     * 上下文溢出恢复的最大重试次数（context-overflow trigger，默认 1，对齐官方
     * compaction-basic 的 maxOverflowRetries）。每次「模型请求 400 exceed_context_size
     * → 强制剪枝 → retry」消耗 1 次；超限后保留原始请求错误，不再循环。
     */
    maxOverflowRetries?: number;
    /** 闭包静止窗 K（默认 2）：lastRef 须 ≤ latestTurn−K 且未被 recall 防抖才可整闭包剪除。 */
    closureWindowK?: number;
    /** cites 前缀最小长度守卫（A2，默认 2）：前缀字符数低于该值直接判失败，避免"的/a"等噪音伪引用。 */
    citeMinPrefixLen?: number;
    /** 版本链重叠归链阈值 θ（A4，默认 0.8，仅对 R 生效）：sim=|A∩B|/min(|A|,|B|) ≥ θ 视为同一版本链。 */
    overlapTheta?: number;
    /** 版本链重叠归链启用（A4，默认 false；启用后 A 文本仍走全等去重）。 */
    enableOverlapChain?: boolean;
    /**
     * 边价值实验 A₃：注入 oracle 边（离线辅助 LLM 组图，schema 强制）。
     * buildGraph 在 cites 边之后合并这些边，用于测"理论上限"保留集（A₃−A₂ = 模型服从率吃掉的价值）。
     */
    injectEdges?: (atoms: Atom[]) => SemanticEdge[];
    /**
     * 边价值实验 A₁ 离线重放：跳过 cites 边构建（仅保留确定性 A→R 边），
     * 隔离"无边"保留集，与 A₂（带 cites 边）比 shadowedSeqs 差异（P1 结构层）。
     */
    disableCiteEdges?: boolean;
    /**
     * P4 溢出三步序列第 ② 步：第一次溢出 forcePrune 后若仍超窗，
     * 回调对当前轮做 per-atom 降熵（PeratomCompressor.compressCurrentTurn：
     * U 拆分 / 大 R extract + 顺带补 cites），产生 surface 换代后由第 ③ 步
     * 再次 forcePrune 收尾。未注入（undefined）时退化为现役两步
     * （forcePrune → 保留原错误），行为与 0.3.x 完全一致。
     * 回调自身失败被吞掉（失败隔离：不影响后续 forcePrune 与原错误保留）。
     */
    onOverflowCompress?: (session: Session) => Promise<void>;
}
export interface GraphPruneRecord {
    at: string;
    compactionId: string;
    /** /compact 发起命令 ID（presentation correlation；自动压缩时为 undefined）。 */
    sourceCommandId?: string;
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
/**
 * 流式中 assistant 消息落盘后，立即剥离尾部 {"cites":[...]}（ARGP 引用协议产物），
 * 使其不残留在**模型可见 surface** 上——下一轮请求不再把协议产物当正文重读。
 * 注意（2026-08 修正认知）：Web UI 的人类转录按 dsh 核心设计固定取 append 起源
 * 事件，replace 副本是 model-only（core session surface.ts："replacement copies
 * stay model-only"），因此本剥离**不影响 UI 显示**。UI 侧残留的治理在源头：
 * cites 契约 V5 规定空引用时不产出任何 block（空块对引用图零信息）；非空 block
 * 在 UI 中作为原始回复的一部分可见（模型侧仍被剥离）。仅改写最后一个 text 块；
 * 保留 model/provider/replay 等元数据；将 cites 存入 data.argpCites，以便后续
 * compaction 经 atomize 重建引用图（文本被剥离后 extractCites 取不到 cites）。
 * 幂等：已剥离节点（含 argpCites）再次进入时直接跳过，无重入循环。
 */
export declare function stripTrailingCitesIfNeeded(session: Session, event: {
    seq: number;
    data?: Record<string, unknown>;
}): void;
/**
 * 提取 A 文本尾部的 cites JSON（支持裸 JSON 与 ```json 围栏）；返回剥离后正文与引用列表。
 * V6 分级契约：条目可为字符串（视为 supporting）或 {t, l} 对象（l ∈ c|s|x）。
 * 形状不合法（如混入数字/对象缺 t）→ parseFailed 保守保护。
 */
export declare function extractCites(text: string): {
    body: string;
    cites: ParsedCite[];
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
    /** 版本链重定向（2026-08-23）：被剪旧快照 recall 时，指向同一路径（tool name+arguments）下最新存活版本的 seq。
     *  未参与版本链去重的被剪节点无此字段（undefined）。 */
    latestOfPath?: number;
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
    readonly turnBasis: 'semantic' | 'all';
    readonly maxOverflowRetries: number;
    /** P4 溢出三步第②步回调（undefined = 退化为现役两步）。 */
    readonly onOverflowCompress?: (session: Session) => Promise<void>;
    /** 闭包静止窗 K（A11 参数化，默认 2）。 */
    readonly closureWindowK: number;
    /** cites 前缀最小长度守卫（A2，默认 2；ASCII ≥4 / CJK ≥2 的换算由守卫实现）。 */
    readonly citeMinPrefixLen: number;
    /** 版本链重叠归链阈值 θ（A4，默认 0.8）。 */
    readonly overlapTheta: number;
    /** 版本链重叠归链开关（A4，默认 false）。 */
    readonly enableOverlapChain: boolean;
    /** dsh token-meter 服务；真会话中可用时优先用于 token 测量和 contextWindow 探测。 */
    private readonly tokenMeter;
    readonly records: GraphPruneRecord[];
    readonly recallCalls: {
        seq: number;
        hit: boolean;
        state?: NodeStateLabel;
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
    /** 边价值实验 A₃：注入的 oracle 边（buildGraph 合并用）。 */
    injectEdges: ((atoms: Atom[]) => SemanticEdge[]) | undefined;
    /** 边价值实验 A₁ 离线重放：跳过 cites 边构建。 */
    disableCiteEdges: boolean;
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
    /** 闭包最近一次被 recall 回拉的轮次；key = rootSeq（跨 pass 稳定，见 P2 修复注释）。 */
    private closureLastRecalled;
    private recallCallsThisTurn;
    private recallCharsUsed;
    /** context-overflow 恢复：每个 agent 的重试计数（assistant/message 成功或 idle 时重置）。 */
    private readonly overflowRetries;
    /** session → agent 映射，供成功后重置重试计数（agent loop 上下文经 session/event 取不到 agent）。 */
    private readonly overflowAgents;
    /** 最近一次请求的真实 prompt token（usage.inputTokens + cacheReadTokens，provider 回报）。
     *  pressure check 用它锚定 + 增量估算，替代 tokenMeter 的 chars/4 启发式（低估 30%+，
     *  导致迟触发/窗口保护失效，2026-08-23）。 */
    private lastRealPromptTokens;
    /** 锚点：lastRealPromptTokens 已覆盖的 surface 最大 seq（其后新增内容需增量估算）。 */
    private lastRealAnchorSeq;
    /** /compact 手动压缩的发起命令 ID（presentation correlation，透传给事务事件）。 */
    private compactSourceCommandId;
    /** A7：账目重建后追加的审计警告（供测试断言/诊断）。 */
    readonly auditWarnings: string[];
    /** A7：已重建过的 compactionId 集合（跨 session 重置，保证幂等 + 告警不重复）。 */
    private rebuiltCompactionIds;
    private session;
    private shadowedSession;
    private shadowedSet;
    private shadowedScanned;
    constructor(ctx: Context, config?: ArgpGraphConfig);
    /**
     * A7（问题 3 修订）：session 绑定统一入口——setSession / agent/pre-step / compactIfNeeded 首次绑定
     * 都走这里。绑定后若 records 为空且日志含 compaction/start 事件（resume 场景：账目丢失仅日志在），
     * 懒触发 rebuildLedgerFromLog() 自动重建；幂等由 rebuiltCompactionIds 去重保证。
     */
    private bindSession;
    setSession(session: Session): void;
    /** 生成上下文头部 catalog（设计稿 §5 + A9）：U/A/R 三类都列（R 带 type=R），snippet 截断，字符预算驱动（A9）。 */
    catalogText(maxItems?: number, snippetChars?: number, tokenBudget?: number): string;
    /** 按关键词查询被剪节点原文（设计稿 §6 的 recall(query) 简化版）。 */
    recallQuery(query: string, maxResults?: number): string;
    /**
     * 增量维护被遮蔽 surface seq 集合：事件日志只追加，游标从上次扫描处继续，
     * 避免每次 recall/剪枝压力检查都 O(事件总量) 重扫。session 切换时重置。
     */
    private shadowedSeqsOf;
    /**
     * 程序化 recall（RecallHandle 语义）：**仅**命中被遮蔽节点，未命中返回 null。
     * 这是给宿主/测试用的窄接口，故意保留 pruned-only 语义（spike/11/12/13/16 的
     * `engine.recall(seq) !== null` 探针依赖它判定"是否已被剪"，去门控会破坏探针）；
     * 模型侧 recall_pruned 工具已按 P1 修复 (b) 去门控并带状态标签，
     * 程序化的全日志入口是 recallAnyState()。
     */
    recall(seq: number): string | null;
    /**
     * 全日志级 recall（P1 修复 (b) 的程序化入口）：对任意界内 seq 返回原文 + 状态标签，
     * 不要求节点属于 pruned 集合。越界返回 null。
     */
    recallAnyState(seq: number): {
        text: string;
        state: NodeStateLabel;
    } | null;
    /** 单个 seq 相对可见上下文的状态（shadowed / live / off-surface）。 */
    nodeState(seq: number): NodeStateLabel | null;
    /** 原子化（§4.1）：只投影 surface 节点；U/X/R/A 四类（tool/call 不进 surface，无 T 类）。cites 统计在 A 原子处累计。 */
    atomize(session: Session): Atom[];
    /**
     * A2 前缀长度守卫（问题 5 修订）：统一按「有效字符」折算——ASCII 1 字符、CJK/全角 2 字符，
     * effective = ascii + wide×2 < minLen（默认 4）即视为噪音前缀（"的""a""the"）→ 不参与匹配。
     * 效果："the"(3 ascii) 拒、"读书"(2 wide = 4) 放行、"the quick"(9 ascii) 放行。
     */
    private citePrefixTooShort;
    /** A5 倒排索引：prefix n-gram → atom id 候选集（n=3）。索引查询只给候选，命中须过验证谓词。 */
    private readonly ngramN;
    private buildNGramIndex;
    /** 查询候选集：前缀长度 < n 时返回 null（走全扫描回退）。取前缀上 ≤3 个 n-gram 交集收窄候选。 */
    private queryNGramCandidates;
    /**
     * 建图（§4.2 + §4.7 + A1/A2/A5）：确定性边不计级别；cites 子串匹配生成语义边，
     * 级别取声明级别（V6 契约，裸字符串默认 supporting；critical 参与闭包守卫不变量 2′）。
     * A5：3-gram 倒排索引候选（先精确 n-gram 命中，再子串验证）；前缀过短自动全扫描回退。
     * 歧义消解增强（A2）：命中集内 U 优先 → 最长公共前缀最深的原子优先 → 最早 seq。
     * 前缀长度守卫：过短前缀不计 declared 也不建边。
     */
    buildGraph(atoms: Atom[]): {
        edges: SemanticEdge[];
        deterministicEdges: DeterministicEdge[];
        inDegree: Map<number, number>;
    };
    /** surface 可见字符总量（与 spike 4 同基准）。 */
    private visibleChars;
    /** 测量当前上下文 token。优先「真实 usage 锚点 + 增量估算」（2026-08-23，
     *  替代 tokenMeter chars/4 低估导致的迟触发/窗口保护失效）；无锚点才回退
     *  dsh tokenMeter / 配置函数 / 字符估算。 */
    private measureTokens;
    /** A4 行级重叠相似度：sim=|A∩B|/min(|A|,|B|)（行集合）。 */
    private static lineOverlap;
    /**
     * §4.4 版本链去重（+ A3 N1 bug fix + A4 θ 重叠归链）：
     *  - A：文本全等（不变）。
     *  - R：按「issuer A 的 tool name + arguments JSON」去重（而非旧版 issuer?.text.trim()），
     *    解决「同措辞不同工具调用（如不同参数 read different files）被错误归链去重」的问题。
     *    回退：issuer 不存在时用 r.text（callId 缺失的最小退化）。
     *  - A4：enableOverlapChain 时，R 文本行重叠 sim ≥ θ（默认 0.8）也归入同一版本链
     *    （read→edit→read 等高频工具迭代）；A 文本仍走全等。
     * 返回 { dupIds, chainLen }：chainLen 记录每个存活代表（newer）的链长，供 density-chain 叠加 eff。
     */
    private findVersionDuplicates;
    /**
     * 当前最大 turn 号（recall 回拉防抖窗口 / 闭包保护窗口共用口径）。
     *
     * P4 修复：旧实现遍历 **全部 events** 取 max，把 turn/start、注入型 system-reminder
     * 等非 surface 事件也算进来，与 compactIfNeeded / tryPruneClosures 用的
     * "atoms（surface 节点）最大 turn" 口径不一致 —— 同一个防抖判定两端基准不同。
     * 现统一为 surface 节点口径；turnBasis='semantic'（默认）时进一步排除注入型 X 节点，
     * 使纯注入不推进轮次、不抬高 latestTurn-k 保护线。
     */
    latestTurnOf(session: Session): number;
    private latestTurnOfSession;
    /**
     * recall 命中被剪闭包内节点时，将该闭包拉回 ACTIVE 并记下防抖轮。
     *
     * P2 修复：防抖 key 从 closureId 改为 rootSeq。closureId 由 `nextClosureId++` 生成，
     * tryPruneClosures 每 pass 都给所有 root 重发新 id，导致此处写入的旧 id 与
     * 剪枝决策处读取的新 id 永不相等 → `continue` 防抖分支永不触发 → 刚 recall 回来的
     * 闭包下一 pass 又被剪。rootSeq 跨 pass 稳定，是闭包的天然身份。
     */
    private noteRecallHit;
    /**
     * recall 预算：单次结果与累计结果都按窗口比例截断（窗口取最近解析的有效预算）。
     *
     * P7 修复：recallCharsUsed 原本只增不减、全会话无 reset —— 累计触顶后 allowed=0，
     * 返回值退化成纯 '…(truncated)' 且不说明原因，长会话静默丢 recall。现在
     *  1) 预算耗尽时显式说明剩余额度与何时恢复（不再静默）；
     *  2) 每笔 compaction 事务成功后归零（见 pruneIntervals 末尾）。
     */
    private budgetRecallText;
    /**
     * A6（保守选项 a）：summarize 末环不实现 —— 保持默认关闭（enableSummarize=false）、
     * force_prune 为终端降级，文档明确。本 stub 恒返回 null，degradationStrategy='summarize'
     * 且 enableSummarize=true 时也不会产出 LLM 摘要；实际路径仍为 lifecycle → force。
     */
    private summarizeCriticalChain;
    /** P2 选择侧（2026-08-22 拆出）：选一个 PRUNABLE 闭包并返回其原子/区间，不执行剪枝。
     *  `alreadyPruned` 用于排除已由正常候选/版本重复剪过的原子——修复前 tryPruneClosures
     *  按整闭包（含已剪原子）独立剪枝并 return，导致正常候选成果被丢弃；现改为"选择并入
     *  pruned、统一事务剪"，闭包原子需与已剪集合去重（如 A1/A2 已正常剪 → 闭包仅剩 root U，
     *  单独退休 root U 是有意设计：P5 注释"自动闭包生命周期确实会连 root U 一起剪除"）。 */
    private selectClosureToMerge;
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
     *
     * trigger='context-overflow'（官方溢出恢复，见 agent/request-error 钩子）：
     * 模型请求已被 provider 确认超出上下文（400 exceed_context_size_error）——估算量
     * 可能与实际请求偏差（估算低于触发线但请求已撞墙），此时**跳过 pressure 门槛强制
     * 剪枝**，剪到 retain 目标（≈1/5 窗口，远低于 n_ctx）后由钩子重发请求。
     */
    compactIfNeeded(agent: CompactionAgentContext, trigger: CompactionTrigger, _signal: AbortSignal): Promise<CompactionResult | null>;
    compactNow(agent: ManualCompactAgentContext, signal: AbortSignal, sourceCommandId?: CommandId): Promise<CompactionResult | null>;
    compactRegion(start: number, end: number, agent: CompactionAgentContext, signal?: AbortSignal): Promise<CompactionResult>;
    /** 为手动 compactNow 选择一个确定性的最老 A/R 连续块。 */
    private selectManualRange;
    /** 一笔事务剪多个极大连续区间：start → summary → 每区间 checkpoint replace → end。
     *  tombstone 类型（2026-08-23 半拆组）：'user' = 普通/闭包墓碑文本；'tool' = tool/result
     *  占位墓碑（克隆原 R data、只改 tool-result block 的 inner text，保留 callId/isError/role/id
     *  ——dsh assertToolResultRewrite 只允许改 inner text），配对 issuer A 的 tool_calls 防 400。 */
    private pruneIntervals;
    /**
     * A7 事务账目重建：resume 时从 append-only 日志扫描 compaction/start、compaction/prune、
     * compaction/end 事件重建 records/prunedNodeIndex/shadowedSeqsOf 状态；无 end 的 start 记 warn。
     * 不引入 WAL——日志本身即账目。幂等：已重建过的 compactionId 跳过（rebuiltCompactionIds 去重），
     * 使「setSession 自动重建」与「测试显式清空 records 后再重建」两种路径都安全。
     */
    rebuildLedgerFromLog(): void;
    /** 日志尾部的 open turn（pre-step 时刻用于 compaction 括号的 owner）。 */
    private detectOpenTurn;
}
export default ArgpGraphEngine;
