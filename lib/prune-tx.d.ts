import type { Session } from '@deepseek-ai/dsh-session';
import type { CompactionAgentContext, CompactionResult } from '@deepseek-ai/dsh-compaction';
import type { CommandId } from '@deepseek-ai/dsh-commands/brand';
import type { Atom, AtomType } from './argp-types.js';
/**
 * tombstone 可合并判据（v1.2.x §11.8① 修复；1.7.1 换判别轴）。
 *
 * 1.7.0 判据 = `startsWith('[elided') && includes('pruned by ARGP') && includes('recall_pruned')`
 * —— `pruned by ARGP` 是一段**自然语言**，且被故意作为 tool 占位墓碑的"缺项"来区分两族
 * （见下方 consolidateTombstones 注释）。1.7.1 文案统一后该子串消失，判据随之失效，
 * 故换轴为**语法级前缀**（`[elided ` 空格族 = 可合并 / `[elided:` 冒号族 = tool 占位）。
 * 实现下沉到 `tombstone-text.ts`，与文案生成同处一文件——两者不再可能各自漂移。
 *
 * 语义不变：X 原子中仅「本引擎剪枝墓碑」可安全合并。其余 X（宿主 system-reminder、
 * 官方摘要 checkpoint、注入型 checkpoint）不可动；`consolidateTombstones` 另有一道
 * **事件类型**过滤（只认 user/message），与文本判据构成双保险，防孤儿 tool_calls。
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
 * F3（1.7.1）：旧 seq → 当前替身 seq（墓碑）的重定向表。
 *
 * **病灶**：declarer 写入侧 `collectDeclAtoms` 走 `sessionEvents`（**原始 append-only 日志**），
 * 已被 replace 离场的旧 seq 仍在 `toBySeq` 校验白名单内（模型引用它**合法**，
 * `accepted=N, invalid=0`）；而消费侧 `buildInjectEdges` 的 `idBySeq` 建自**当前投影**，
 * 查表必然 miss ⇒ 边被 `droppedByMissingEndpoint` 丢弃。实测 `session-fceb1ccc`：
 * 4 条声明边中 2 条 critical（`toSeq=18`）因 18 已墓碑化为 seq=53 而全丢。
 *
 * **映射源** = `GraphPruneRecord.intervals`（`prune-tx.ts:282/:300` 写 replace 时逐区间记录
 * `{start,end,tombstoneSeq}`；`rebuildLedgerFromLog` 亦从 `compaction/end` 重建）。
 * 同一 seq 多次替换时**后者胜**（取最新替身）；多跳链（墓碑再被墓碑替换）由调用侧迭代解析，
 * 本函数只给一跳。`start === tombstoneSeq` 的区间跳过（防自映射/自环）。
 *
 * ⚠️ **已知限制**：`rebuildLedgerFromLog` 重建的 `intervals` 把一次压缩的所有 seq 压成
 * **单条** `[first..last] → compaction/end seq`，而 end 是 **off-surface** 事件 ⇒
 * **resume（跨进程重载）后本表对多区间压缩无效**；同进程内为精确值。
 */
export declare function buildTombstoneRedirect(records: readonly {
    intervals: readonly {
        start: number;
        end: number;
        tombstoneSeq: number;
    }[];
}[]): Map<number, number>;
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
 *  占位墓碑（克隆原 R data、只改 inner text——V4 换 content 为单 text block / V3 改 tool-result block，
 *  保留 callId/isError/role/id——dsh assertToolResultRewrite 只允许改 inner text），配对 issuer A 的 tool_calls 防 400。
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
 * tool 占位墓碑（type=tool）与 system-reminder / 官方 checkpoint（non-mergeable 文本）
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
