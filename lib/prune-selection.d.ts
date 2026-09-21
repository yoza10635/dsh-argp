/**
 * ARGP 剪枝选择模块（P5 结构重构 Wave 3 第 4 步，C 报告 §4 A 表）。
 *
 * 从 3,380 行 hub `argp-graph-engine.ts`（God Class）拆出的**剪枝选择侧**函数：
 * 单原子/组候选判定（isAtomCandidate / isGroupCandidate）+ 排序键（sortKey）
 * + 区间归并（mergeIntervals）+ tombstone 生成（buildTombstones）+ 闭包选择
 * （selectClosureToMerge）+ 它们的共享类型（PruneInterval / PruneTombstone /
 * PruneState / PrunedNodeInfo）。
 *
 * 循环 import 规避（C 报告关键设计决策 1）：本模块**不** import hub 运行时。
 * selectClosureToMerge 需要读/写引擎可变字段（nextClosureId++ / closureLastRecalled /
 * closureWindowK），接收窄接口 {@link PruneSelectionHost} 而非具体 class；hub 的
 * class 以 `this as unknown as PruneSelectionHost` 传入（编译期断言，运行时即真实
 * 实例，私有字段经 host 类型可读写/重赋值）。依赖方向：hub → prune-selection（单向）。
 *
 * 行为逐字节不变：函数体逻辑逐字保留（this.x → host.x），仅 `this` 换 `host`。
 * isAtomCandidate / isGroupCandidate / sortKey / mergeIntervals / buildTombstones
 * 为纯函数（无 this，入参显式 state）。
 */
import type { Session } from '@deepseek-ai/dsh-session';
import type { Atom, AtomType, SemanticEdge, DeterministicEdge } from './argp-types.js';
/** 剪枝区间（区间归并产物）。hasSoloR = 区间含「issuer A 未被剪」的独立 R（tool 占位墓碑配对约束）。 */
export interface PruneInterval {
    seqs: number[];
    chars: number;
    atoms: Atom[];
    hasSoloR: boolean;
}
/** 区间 tombstone 规格：user 文本墓碑 或 tool 占位墓碑（保留 callId 配对 issuer A 的 tool_calls）。 */
export type PruneTombstone = {
    type: 'user';
    text: string;
} | {
    type: 'tool';
    seq: number;
    callId: string;
};
/**
 * compactIfNeeded 拆出纯函数共享的显式 state：原 3 个闭包捕获的 this 字段与局部量。
 * - turnGuard / sortMode / charsPerToken：原闭包读 this.<getter>；此处快照为值（方法执行期间
 *   guardOverride/argpSettings 稳定，快照等价）。
 * - curInDegree / curInDegreeDecl：每 pass 重推（链式解锁），方法内每 pass 更新本字段，
 *   纯函数按调用时读取当前 pass 值（与原闭包捕获 let 绑定的语义一致）。
 * - chainLen：findVersionDuplicates 产物；仅 sortKey 使用，且 sortKey 只在 pass 循环内调用
 *   （届时已回填），构造期占位空 Map 不会被读到。
 */
export interface PruneState {
    turnGuard: number;
    askCoverage: Map<number, number>;
    position: Map<number, number>;
    recencyCut: number;
    latestTurn: number;
    edges: SemanticEdge[];
    atoms: Atom[];
    curInDegree: Map<number, number>;
    curInDegreeDecl: Map<number, number>;
    deterministicEdges: DeterministicEdge[];
    touchesSemantic: Set<number>;
    eff: Map<number, number>;
    sortMode: 'legacy' | 'density' | 'density-chain';
    chainLen: Map<number, number>;
    lastRef: Map<number, number>;
    charsPerToken: number;
}
/**
 * 单原子剪枝候选判定（原 compactIfNeeded 内 isAtomCandidate 闭包，逐字保留 this.x→state.x）。
 * ask-exempt U（dialog）须被首个 A 的 supporting 边覆盖才参剪；A/R/U-info 走
 * recencyGuard/turnGuard/citesFailed/A10 结构保护/入度门槛。
 */
export declare function isAtomCandidate(a: Atom, allowInDegree: boolean, state: PruneState): boolean;
/** 组候选判定（原 isGroupCandidate 闭包）：组内全部原子均候选。 */
export declare function isGroupCandidate(g: Atom[], allowInDegree: boolean, state: PruneState): boolean;
/**
 * 排序键（原 sortKey 闭包，§4.5 + spike 18 提案）：默认 legacy = [lvl, eff, lastRef, seq]；
 * density = eff 同档内 token 降序（大 token 先剪）；density-chain = density + 链代表 eff 叠加。
 */
export declare function sortKey(a: Atom, state: PruneState): string;
/**
 * 区间归并（原 compactIfNeeded 内区间归并段，逐字保留）。
 * 按极大连续区间归并 pruned 原子；R 原子（issuer A 未被剪）强制单独成区间（tool 占位墓碑
 * 的 surface replace 必须恰好替换 1 节点）；双向守卫防孤儿 tool 消息；
 * 区间可见量 < minSpanChars 的放回（不剪）。
 * 入参 = pruned 原子集合 + position/issuerByCall 局部量 + minSpanChars（原 this.minSpanChars）；
 * 出参 = 归并后区间 kept + droppedIntervals（放回区间数，原方法内计算但未被读取，保留以逐字对应）。
 */
export declare function mergeIntervals(pruned: Map<number, Atom>, position: Map<number, number>, issuerByCall: Map<string, Atom>, minSpanChars: number): {
    kept: PruneInterval[];
    droppedIntervals: number;
};
/**
 * 区间 tombstone 生成（原 compactIfNeeded 内 tombstone 段，逐字保留）。
 * 区间原子全部来自同一闭包 → 闭包 tombstone（带 root/计数，recall 消歧）；
 * 单 R 区间（issuer A 未被剪）→ tool 占位墓碑（保留 callId 配对 A 的 tool_calls）；
 * 否则默认 user 文本墓碑（forced 时标注）。
 */
export declare function buildTombstones(kept: PruneInterval[], closureSeqMeta: Map<number, {
    closureId: string;
    rootPreview: string;
    closureTotal: number;
}>, issuerByCall: Map<string, Atom>, pruned: Map<number, Atom>, forced: boolean): PruneTombstone[];
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
/**
 * 闭包选择模块函数访问引擎状态所需的窄接口（C 报告关键设计决策 1）。
 * 仅列出 selectClosureToMerge 实际读写的字段；hub 的 ArgpGraphEngine 以
 * `this as unknown as PruneSelectionHost` 满足它。
 */
export interface PruneSelectionHost {
    nextClosureId: number;
    closureLastRecalled: Map<number, number>;
    closureWindowK: number;
}
/** P2 选择侧（2026-08-22 拆出）：选一个 PRUNABLE 闭包并返回其原子/区间，不执行剪枝。
 *  `alreadyPruned` 用于排除已由正常候选/版本重复剪过的原子——修复前独立闭包事务
 *  按整闭包（含已剪原子）独立剪枝并 return，导致正常候选成果被丢弃；现改为"选择并入
 *  pruned、统一事务剪"（compactIfNeeded 降级链内联），闭包原子需与已剪集合去重
 *  （如 A1/A2 已正常剪 → 闭包仅剩 root U，单独退休 root U 是有意设计：P5 注释
 *  "自动闭包生命周期确实会连 root U 一起剪除"）。
 *
 * 原 class 私有方法；this.x → host.x（nextClosureId++ 经 host 重赋值落到真实字段）。
 */
export declare function selectClosureToMerge(host: PruneSelectionHost, session: Session, atoms: Atom[], edges: SemanticEdge[], inDegree: Map<number, number>, askCover: Map<number, number>, latestTurn: number, alreadyPruned: Set<number>): {
    closureId: string;
    root: Atom;
    rootPreview: string;
    /** 闭包全量 seq（含已由正常候选剪过的原子）——closurePrunes 记录用（noteRecallHit 反查 rootSeq）。 */
    seqs: number[];
    /** 本事务实际并入 pruned 的原子（过滤 alreadyPruned）。 */
    atoms: Atom[];
    intervals: {
        seqs: number[];
        chars: number;
        atoms: Atom[];
    }[];
} | null;
