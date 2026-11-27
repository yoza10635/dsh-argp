/**
 * 单会话运行时状态（「会话所有权」批；2.0 factor-only 收窄）。
 *
 * 病灶（〔Q〕M4 / 〔K〕P1-1，双 BLOCKER）：引擎把这些字段做成**进程级单例**——
 * 台账（prunedNodeIndex / records）、召回预算与计数、shadowed 增量游标、
 * usage 锚点、账本重建去重集全部挂在实例上。多会话/多代理宿主里
 * A→B 切换时 B 读到 A 的剪枝索引（同 seq 不同内容 = 跨会话泄漏）、A 的预算压制 B 的
 * 召回、A 的锚点让 B 误触发。
 *
 * 修法：全部字段收进本状态对象，引擎经 `WeakMap<Session, SessionRuntimeState>`
 * 分桶（`stateOf(session)` 懒建）。**同步方法**经引擎上的 getter 兼容层
 * 读"当前焦点会话"的桶（sync 期间焦点不可变，安全）；**异步路径**（召回工具执行、
 * 账本重建）显式线程 session，不得依赖焦点指针。
 *
 * 保留的全是 factor 事务与本会话可观测面实际读写的字段。
 *
 * 依赖方向：本模块是**类型叶子**——只 import type 与无依赖的 constants 常量，
 * 无运行时依赖、无环。
 */
import { DEFAULT_PRUNED_INDEX_CAP, DEFAULT_WINDOW_TOKENS } from './constants.js';
import { SeqBitset } from './seq-bitset.js';
export function createSessionRuntimeState() {
    return {
        records: [],
        recallCalls: [],
        prunedNodeIndex: new Map(),
        prunedNodeTotal: 0,
        recallCallsThisTurn: 0,
        recallTurn: -1,
        recallCharsUsed: 0,
        recallBudgetTurn: -1,
        lastRealPromptTokens: 0,
        lastRealAnchorSeq: -1,
        resolvedWindowTokens: DEFAULT_WINDOW_TOKENS,
        auditWarnings: [],
        rebuiltCompactionIds: new Set(),
        shadowedSession: null,
        shadowedSet: new SeqBitset(),
        shadowedScanned: 0,
        shadowedPending: null,
        searchIndex: null,
        searchQuery: '',
        b6Streak: 0,
        lastPruneRelease: -1,
        lastPruneEntryCtx: 0,
        cacheSamples: [],
        lastCompaction: null,
        compactionAwaitingReply: false,
    };
}
/**
 * 写入一条已剪节点明细（A5）：明细有上限（{@link DEFAULT_PRUNED_INDEX_CAP}），
 * 但 `prunedNodeTotal` 单调累计真实总数——`/argp` 报数用后者。
 * 幂等：同一 seq 已在 Map 内则不重复计数（重建按 compactionId 去重，正常不会重复）。
 */
export function notePrunedNode(st, seq, info, cap = DEFAULT_PRUNED_INDEX_CAP) {
    if (st.prunedNodeIndex.has(seq))
        return;
    st.prunedNodeIndex.set(seq, info);
    st.prunedNodeTotal += 1;
    if (st.prunedNodeIndex.size > cap) {
        // seq 递增入账 ⇒ 首个键即最旧明细；删明细不动计数。
        const oldest = st.prunedNodeIndex.keys().next();
        if (!oldest.done)
            st.prunedNodeIndex.delete(oldest.value);
    }
}
