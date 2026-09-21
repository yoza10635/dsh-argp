/**
 * ARGP 召回模块（P5 结构重构 Wave 3 第 4 步，C 报告 §4 A 表）。
 *
 * 从 3,380 行 hub `argp-graph-engine.ts`（God Class）拆出的**召回侧**函数：
 * 被遮蔽 seq 增量账本（shadowedSeqsOf）+ catalog 生成（catalogText）+
 * 关键词召回（recallQuery）+ 程序化召回（recall / recallAnyState / nodeState）
 * + 轮次口径（latestTurnOf / latestTurnOfSession）+ 召回防抖（noteRecallHit）
 * + 召回字数预算（budgetRecallText）。
 *
 * 循环 import 规避（C 报告关键设计决策 1）：本模块**不** import hub 运行时。
 * 需要读/写引擎可变字段的函数接收窄接口 {@link RecallHost} 而非具体 class；
 * hub 的 class 以 `this as unknown as RecallHost` 传入（编译期断言，运行时即
 * 真实实例，私有字段经 host 类型可读写/重赋值）。依赖方向：hub → recall（单向）。
 *
 * 行为逐字节不变：函数体逻辑逐字保留（this.x → host.x），仅 `this` 换 `host`。
 */
import type { Session } from '@deepseek-ai/dsh-session';
import { type NodeState } from './log-access.js';
/**
 * 召回侧模块函数访问引擎状态所需的窄接口（C 报告关键设计决策 1）。
 * 仅列出各召回函数实际读写的字段；hub 的 ArgpGraphEngine 以
 * `this as unknown as RecallHost` 满足它。
 * charsPerToken 在 class 上是 getter——经 host 读取时 getter 以真实实例为
 * this 调用，语义与 this.charsPerToken 完全一致。
 */
export interface RecallHost {
    session: Session | null;
    shadowedSession: Session | null;
    shadowedSet: Set<number>;
    shadowedScanned: number;
    charsPerToken: number;
    turnBasis: 'semantic' | 'all';
    recallQueryCalls: {
        query: string;
        count: number;
        hits: number;
    }[];
    telemetryCap: number;
    closurePrunes: {
        closureId: string;
        rootSeq: number;
        prunedSeqs: number[];
        at: string;
    }[];
    closureLastRecalled: Map<number, number>;
    resolvedWindowTokens: number;
    recallCharsUsed: number;
}
/**
 * 增量维护被遮蔽 surface seq 集合：事件日志只追加，游标从上次扫描处继续，
 * 避免每次 recall/剪枝压力检查都 O(事件总量) 重扫。session 切换时重置。
 *
 * 原 class 私有方法；this.x → host.x（shadowedSession/shadowedSet/shadowedScanned
 * 经 host 重赋值落到真实字段）。
 */
export declare function shadowedSeqsOf(host: RecallHost, session: Session): Set<number>;
/** 生成上下文头部 catalog（设计稿 §5 + A9）：U/A/R 三类都列（R 带 type=R），snippet 截断，字符预算驱动（A9）。
 *
 * 原 class 方法；this.x → host.x。 */
export declare function catalogText(host: RecallHost, maxItems?: number, snippetChars?: number, tokenBudget?: number): string;
/** 按关键词查询被剪节点原文（设计稿 §6 的 recall(query) 简化版）。
 *
 * 原 class 方法；this.x → host.x。 */
export declare function recallQuery(host: RecallHost, query: string, maxResults?: number): string;
/**
 * 程序化 recall（RecallHandle 语义）：**仅**命中被遮蔽节点，未命中返回 null。
 * 这是给宿主/测试用的窄接口，故意保留 pruned-only 语义（历史 spike 系列的
 * `engine.recall(seq) !== null` 探针依赖它判定"是否已被剪"，去门控会破坏探针）；
 * 模型侧 recall_pruned 工具已按 P1 修复 (b) 去门控并带状态标签，
 * 程序化的全日志入口是 recallAnyState()。
 *
 * 原 class 方法；this.x → host.x。
 */
export declare function recall(host: RecallHost, seq: number): string | null;
/**
 * 全日志级 recall（P1 修复 (b) 的程序化入口）：对任意界内 seq 返回原文 + 状态标签，
 * 不要求节点属于 pruned 集合。越界返回 null。
 *
 * 原 class 方法；this.x → host.x。
 */
export declare function recallAnyState(host: RecallHost, seq: number): {
    text: string;
    state: NodeState;
} | null;
/** 单个 seq 相对可见上下文的状态（shadowed / live / off-surface）。
 *
 * 原 class 方法；this.x → host.x。 */
export declare function nodeState(host: RecallHost, seq: number): NodeState | null;
/**
 * 当前最大 turn 号（recall 回拉防抖窗口 / 闭包保护窗口共用口径）。
 *
 * P4 修复：旧实现遍历 **全部 events** 取 max，把 turn/start、注入型 system-reminder
 * 等非 surface 事件也算进来，与 compactIfNeeded（含内联闭包降级链）用的
 * "atoms（surface 节点）最大 turn" 口径不一致 —— 同一个防抖判定两端基准不同。
 * 现统一为 surface 节点口径；turnBasis='semantic'（默认）时进一步排除注入型 X 节点，
 * 使纯注入不推进轮次、不抬高 latestTurn-k 保护线。
 *
 * 原 class 方法；this.turnBasis → host.turnBasis。
 */
export declare function latestTurnOf(host: RecallHost, session: Session): number;
/** 当前绑定 session 的最大 turn（原 class 私有方法；this.x → host.x）。 */
export declare function latestTurnOfSession(host: RecallHost): number;
/**
 * recall 命中被剪闭包内节点时，将该闭包拉回 ACTIVE 并记下防抖轮。
 *
 * P2 修复：防抖 key 从 closureId 改为 rootSeq。closureId 由 `nextClosureId++` 生成，
 * selectClosureToMerge 每 pass 都给所有 root 重发新 id，导致此处写入的旧 id 与
 * 剪枝决策处读取的新 id 永不相等 → `continue` 防抖分支永不触发 → 刚 recall 回来的
 * 闭包下一 pass 又被剪。rootSeq 跨 pass 稳定，是闭包的天然身份。
 *
 * 原 class 私有方法；this.x → host.x。
 */
export declare function noteRecallHit(host: RecallHost, seq: number): void;
/**
 * recall 预算：单次结果与累计结果都按窗口比例截断（窗口取最近解析的有效预算）。
 *
 * P7 修复：recallCharsUsed 原本只增不减、全会话无 reset —— 累计触顶后 allowed=0，
 * 返回值退化成纯 '…(truncated)' 且不说明原因，长会话静默丢 recall。现在
 *  1) 预算耗尽时显式说明剩余额度与何时恢复（不再静默）；
 *  2) 每笔 compaction 事务成功后归零（见 pruneIntervals 末尾）。
 *
 * 原 class 私有方法；this.x → host.x（recallCharsUsed 经 host 重赋值落到真实字段）。
 */
export declare function budgetRecallText(host: RecallHost, text: string): string;
