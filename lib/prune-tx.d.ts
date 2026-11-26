import type { Session } from '@deepseek-ai/dsh-session';
import type { CompactionResult } from '@deepseek-ai/dsh-compaction';
import type { CommandId } from '@deepseek-ai/dsh-commands';
import type { Atom, AtomType } from './argp-types.js';
import type { SessionRuntimeState } from './session-state.js';
/**
 * tombstone 可合并判据。
 *
 * 判据是**语法级前缀**（`[elided ` 空格族 = 可合并 / `[elided:` 冒号族 = tool 占位）。
 * 不能用自然语言子串（如旧口径的 `pruned by ARGP`）：文案会变，判据随之失效。
 * 实现下沉到 `tombstone-text.ts`，与文案生成同处一文件——两者不再可能各自漂移。
 *
 * 语义：X 原子中仅「本引擎剪枝墓碑」可安全合并。其余 X（宿主 system-reminder、
 * 官方摘要 checkpoint、注入型 checkpoint）不可动；`consolidateTombstones` 另有一道
 * **事件类型**过滤（只认 user/message），与文本判据构成双保险，防孤儿 tool_calls。
 * 导出供测试锁定行为。
 */
/** §G2 摘要信封：provider/model/maxTokens/usage（含 cacheReadTokens）/rawOutput/llmStreamCall。 */
export interface CompactionSummaryMeta {
    provider?: string;
    model?: string;
    maxTokens?: number;
    usage?: {
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens?: number;
    };
    rawOutput?: unknown[];
    llmStreamCall?: true;
}
export declare function isMergeableTombstone(text: string): boolean;
export interface GraphPruneRecord {
    at: string;
    compactionId: string;
    /** /compact 发起命令 ID（presentation correlation；自动压缩时为 undefined）。 */
    sourceCommandId?: CommandId;
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
    /**
     * 事务以 error end 收尾时携带错误消息：该事务是 partial（已落地的
     * replace 子集真实有效，但整体未成功）。带 error 的记录**不参与**墓碑重定向表
     * （intervals 为空），账本重建侧据此与成功事务区分。
     */
    error?: string;
}
/**
 * F3：旧 seq → 当前替身 seq（墓碑）的重定向表。
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
 * 剪枝事务模块函数访问引擎状态所需的窄接口。
 * 仅列出各事务函数实际读写的字段与方法；hub 的 ArgpEngine 以
 * `this as unknown as PruneTxHost` 满足它。
 *
 * bindSession / atomize 以**方法引用**形式声明：调用时经传入实例分派（即 hub 的
 * class 方法），本模块因此**无需** import session-lifecycle（避免
 * session-lifecycle → prune-tx 的环）。
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
    /** 会话态（台账/目录/召回预算/usage 锚点）分桶访问。 */
    stateOf: (session: Session) => SessionRuntimeState;
    compactSourceCommandId: CommandId | undefined;
    charsPerToken: number;
    telemetryCap: number;
}
/**
 * 一笔事务剪多个极大连续区间：start → summary → 每区间 checkpoint replace → end。
 * 发射前先做**相邻同文 user 墓碑归并**（surface 紧邻 + 文本逐字节相同 ⇒ 并条；
 * 2026-11-26 桩游程治理，见 pruneIntervals 内注释）。
 *  tombstone 类型（半拆组）：'user' = 普通/闭包墓碑文本；'tool' = tool/result
 *  占位墓碑（克隆原 R data、只改 inner text——V4 换 content 为单 text block / V3 改 tool-result block，
 *  保留 callId/isError/role/id——dsh assertToolResultRewrite 只允许改 inner text），配对 issuer A 的 tool_calls 防 400；
 *  'developer' = 协议组整组离场的空占位（content:[]，source.form='argp-removed'；宿主请求投影
 *  丢弃未注册 developer ⇒ 模型零可见，不是 user 消息、不伪造轮边界）。
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
    text?: string;
} | {
    type: 'developer';
    form?: string;
    kind?: 'group' | 'a' | 'orphan';
})[], summaryKind?: 'graph-prune' | 'tombstone-merge' | 'factor-prose' | 'factor-prune', 
/** §G2：LLM 摘要调用的真实账单/信封回填 compaction/summary（宿主字段词典；0-LLM 事务不传）。 */
summaryMeta?: CompactionSummaryMeta): CompactionResult | null;
