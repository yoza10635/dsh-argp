import type { Session } from '@deepseek-ai/dsh-session';
import type { CompactionAgentContext, CompactionResult } from '@deepseek-ai/dsh-compaction';
import type { CommandId } from '@deepseek-ai/dsh-commands/brand';
import type { Atom, AtomType } from './argp-types.js';
/**
 * tombstone 可合并判据（v1.2.x §11.8① 修复）。X 原子中仅「本引擎剪枝墓碑」可安全合并：
 * 文本以 `[elided` 开头、含 pruned by ARGP 与 recall_pruned 取回提示（覆盖默认区间
 * 墓碑与 closure 墓碑两种形态；tool 占位墓碑 `[elided: ...` 缺 pruned by ARGP → 不合并，
 * 且 consolidateTombstoneRuns 只认 user/message 事件，双保险防孤儿 tool_calls）。
 * 其余 X（宿主 system-reminder、官方摘要 checkpoint、注入型 checkpoint）不可动。
 * 导出供测试锁定行为。
 */
export declare function isMergeableTombstone(text: string): boolean;
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
/**
 * 剪枝事务模块函数访问引擎状态所需的窄接口（C 报告关键设计决策 1）。
 * 仅列出各事务函数实际读写的字段与方法；hub 的 ArgpGraphEngine 以
 * `this as unknown as PruneTxHost` 满足它。
 *
 * bindSession / atomize 以**方法引用**形式声明：compactRegion / compactRegions /
 * selectManualRanges 调用它们时经传入实例分派（即 hub 的 class 方法），本模块
 * 因此**无需** import session-lifecycle（避免 session-lifecycle → prune-tx 的环）。
 * charsPerToken / recencyGuard / turnGuard 在 class 上是 getter——经 host 读取时
 * getter 以真实实例为 this 调用，语义与 this.<getter> 完全一致。
 */
export interface PruneTxHost {
    bindSession: (session: Session) => void;
    atomize: (session: Session) => Atom[];
    log: {
        info: (msg: string) => void;
        warn: (msg: string) => void;
        error: (msg: string) => void;
    };
    prunedNodeIndex: Map<number, {
        seq: number;
        type: AtomType;
        turn: number;
        firstLine: string;
        citedBySeq: number[];
        eff: number;
        latestOfPath?: number;
    }>;
    compactSourceCommandId: CommandId | undefined;
    charsPerToken: number;
    records: GraphPruneRecord[];
    telemetryCap: number;
    recallCharsUsed: number;
    lastRealPromptTokens: number;
    lastRealAnchorSeq: number;
    tombstoneMergeMinRun: number;
    recencyGuard: number;
    turnGuard: number;
}
/**
 * 一笔事务剪多个极大连续区间：start → summary → 每区间 checkpoint replace → end。
 *  tombstone 类型（2026-08-23 半拆组）：'user' = 普通/闭包墓碑文本；'tool' = tool/result
 *  占位墓碑（克隆原 R data、只改 tool-result block 的 inner text，保留 callId/isError/role/id
 *  ——dsh assertToolResultRewrite 只允许改 inner text），配对 issuer A 的 tool_calls 防 400。
 *
 * 原 class 私有方法；this.x → host.x。
 */
export declare function pruneIntervals(host: PruneTxHost, session: Session, intervals: {
    seqs: number[];
    chars: number;
    atoms: Atom[];
}[], semanticEdges: number, candidateCount: number, forced: boolean, tombstones?: ({
    type: 'user';
    text: string;
} | {
    type: 'tool';
    seq: number;
    callId: string;
})[], summaryKind?: 'graph-prune' | 'tombstone-merge'): CompactionResult | null;
/**
 * tombstone 归并（v1.2.x §11.8① 修复）。扫描 surface，找**连续**的「可合并墓碑」X 段
 * （user/message + isMergeableTombstone 文本），段长 ≥ tombstoneMergeMinRun 时一笔事务
 * replace 成单条聚合墓碑（列出原 tombstone seqs → 原文仍 recall_pruned(seq) 可取回）。
 * 复用 pruneIntervals 事务骨架（含 shadow-price 契约、summary、锚点重置）。
 * 每 pass 至多一段——失败回退范围清晰。返回被归并的墓碑节点数（0 = 无可归并）。
 * tool 占位墓碑（type=tool）与 system-reminder / 官方 checkpoint（不含 pruned by ARGP）
 * 均被 isMergeableTombstone / 事件类型过滤挡住，不会被吞。
 *
 * 原 class 私有方法；this.x → host.x。
 */
export declare function consolidateTombstones(host: PruneTxHost, session: Session): number;
/** 手动多区间压缩：逐段复核边界后合并为一笔事务剪除。
 *  边界复核与 compactRegion 同口径（配对平衡 / 段内不含 U/X / 段内有可剪原子），
 *  任一区间不合格则**静默剔除该区间**（而非整体失败）——手动入口的语义是"能剪多少剪多少"。
 *  返回 null = 全部区间都被剔除（无可剪内容），调用方据此显示 "No compactable history yet."。
 *
 * 原 class 私有方法；this.x → host.x，this.bindSession → host.bindSession，
 * this.atomize → host.atomize，this.pruneIntervals → pruneIntervals(host, ...)。
 */
export declare function compactRegions(host: PruneTxHost, ranges: {
    start: number;
    end: number;
}[], agent: CompactionAgentContext, signal: AbortSignal): CompactionResult | null;
/** 为手动 compactNow 选择**全部**可剪的极大连续 A/R 段（确定性、由旧到新）。
 *
 *  入选判据（与旧版一致，仅去掉"遇阻即停"）：段内原子必须
 *  ① 是对话载体 A/R（U/X 不参剪，手动入口不剪骨架，见 compactRegion 的 P5 约束）；
 *  ② 不落在 turnGuard（最近 N 轮）与 recencyGuard（surface 末尾 N 节点）保护窗口内。
 *
 *  修复（2026-09-21）：旧实现扫到第一个不合格节点就 `break`，而真实会话的 surface 被
 *  用户消息切成「U A R A R U A R …」多段结构 ⇒ 手动 /compact 永远只剪最老一小段
 *  （表现为"图剪压不动"）。现在改为收集全部极大连续段，交给一笔 pruneIntervals 事务剪除。
 *
 * 原 class 私有方法；this.atomize → host.atomize，this.recencyGuard/turnGuard → host.*。
 */
export declare function selectManualRanges(host: PruneTxHost, session: Session): {
    start: number;
    end: number;
}[];
/**
 * 手动单区间压缩（override compactRegion）。
 *
 * 原 class override 方法；this.x → host.x，this.bindSession → host.bindSession，
 * this.atomize → host.atomize，this.pruneIntervals → pruneIntervals(host, ...)。
 */
export declare function compactRegion(host: PruneTxHost, start: number, end: number, agent: CompactionAgentContext, signal?: AbortSignal): CompactionResult;
