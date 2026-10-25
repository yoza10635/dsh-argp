/**
 * 单会话运行时状态（1.11.0-beta.0「会话所有权」批，1-1）。
 *
 * 病灶（〔Q〕M4 / 〔K〕P1-1，双 BLOCKER）：引擎把这些字段做成**进程级单例**——
 * 台账（prunedNodeIndex / records）、召回预算与计数、shadowed 增量游标、冻结 catalog、
 * usage 锚点、账本重建去重集、闭包召回表全部挂在实例上。多会话/多代理宿主里
 * A→B 切换时 B 读到 A 的剪枝索引（同 seq 不同内容 = 跨会话泄漏）、A 的预算压制 B 的
 * 召回、A 的锚点让 B 误触发。
 *
 * 修法：全部字段收进本状态对象，引擎经 `WeakMap<Session, SessionRuntimeState>`
 * 分桶（`stateOf(session)` 懒建）。**同步方法**（图剪全同步）经引擎上的 getter 兼容层
 * 读"当前焦点会话"的桶（sync 期间焦点不可变，安全）；**异步路径**（召回工具 execute、
 * peratom 三管线、账本重建）显式线程 session（exec.agent.session 路由，1-2），
 * 不得依赖焦点指针。
 *
 * 依赖方向：本模块是**类型叶子**——只 import type 与无依赖的 constants 常量，
 * 无运行时依赖、无环。
 */
import { DEFAULT_WINDOW_TOKENS } from './constants.js';
export function createSessionRuntimeState() {
    return {
        records: [],
        recallCalls: [],
        recallQueryCalls: [],
        citeStats: { aAtoms: 0, declared: 0, resolved: 0, ambiguous: 0, failed: 0 },
        recallSourceSeq: -1,
        recallResultSeq: -1,
        lastEdges: [],
        lastDeterministicEdges: [],
        lastInferredEdges: [],
        inferredStats: { candidates: 0, accepted: 0, skippedDup: 0 },
        prunedNodeIndex: new Map(),
        closurePrunes: [],
        closureLastRecalled: new Map(),
        recallCallsThisTurn: 0,
        recallCharsUsed: 0,
        frozenCatalog: null,
        lastRealPromptTokens: 0,
        lastRealAnchorSeq: -1,
        resolvedWindowTokens: DEFAULT_WINDOW_TOKENS,
        auditWarnings: [],
        rebuiltCompactionIds: new Set(),
        shadowedSession: null,
        shadowedSet: new Set(),
        shadowedScanned: 0,
        guardOverride: null,
    };
}
