/**
 * Token 本体（PROPOSAL-token-ontology.md，v1.2.0 组件 A/B 共享地基）：
 * 承重 token 词表是**一套词表、两种机制**的唯一事实源——
 *
 *  1. **原子内保真**（fidelityGuard）：peratom 压缩副本必须 verbatim 存活原文的高信号
 *     token（extract 硬拒 / summary 审计）——自 v1.0.0 起存在于 gate.ts，本文件将其提升
 *     为共享叶子模块（gate.ts 改 re-export，既有 import 路径不变）。
 *  2. **原子间推断边**（deriveInferredEdges）：较新的 A 原子**逐字包含**较旧数据原子
 *     （U/R）的承重 token → 派生 `inferred` 语义边（0 LLM，建图期完成）。当模型声明
 *     通道（回复级 cites / CiteDeclarer）空窗时，选择性由构造恢复——保护集只增不减，
 *     错误方向仍只往"少剪"错（与版本链硬排除同一保守哲学）。
 *
 * 本模块**零运行时依赖**（纯函数 + 词表），与 cites-strip.ts 同纪律：
 * 引擎（Stage-2）与 peratom（Stage-1）双向引用都不产生模块环。
 */
/**
 * 承重 token 模式集（spike 34 实证驱动：本地模型对 ALL-CAPS 错误码保真完美，
 * 但对 file:line 定位与 key=value 分隔符会不自觉改写）。
 */
export declare const LOAD_BEARING_PATTERNS: RegExp[];
/** 提取原文中必须在压缩副本里 verbatim 存活的高信号 token（去重）。 */
export declare function findLoadBearingTokens(text: string): string[];
/** 守卫裁决：missing 非空 = 该副本不得按原样落盘（原文保面 / HLS 修复，由调用方选档）。 */
export declare function fidelityGuard(originalText: string, compressedText: string): {
    ok: boolean;
    missing: string[];
};
/**
 * HLS 尾注修复（构造性 100% 硬 token 保真）：
 * 模型候选文本 + 守卫缺失清单按原文顺序逐字补全。
 *
 *  - 只**追加**原文 token、不重写模型 prose、不删 candidate 任何字符（I-B3）；
 *  - 对任意 candidate，`fidelityGuard(original, repaired)` 平凡通过（I-B1，
 *    构造性：缺失清单恰为原文承重 token 在 candidate 中的补集）；
 *  - prose 有损性等同 summary 档的受控损失，但**硬 token 零损失**——
 *    填补现有两档（extract=软无损+硬无损 / summary=软有损+硬有损）之间的缺格。
 *
 * `missing` 空 = 候选已全含（此时调用方根本不会走到修复档，此处防御性返回原文）。
 *
 * 注意：本函数是**无条件的构造性修复**，不含经济学判断。是否值得修复由调用方
 * 经 `hlsRepairEconomics(...).accept` 门控决定（见下）——值不值不是构造的问题。
 */
export declare function repairWithTrailer(candidate: string, missing: readonly string[]): string;
/** 尾注文本（长度口径的唯一事实源：`repairWithTrailer` 与门控共用，保证两者不分叉）。 */
export declare function trailerText(missing: readonly string[]): string;
/**
 * 默认 ROI 门槛 θ = 1：净释放预算必须 ≥ 尾注占用，修复才放行。
 *
 * 记 L_orig / L_cand / L_rep 为原文 / 候选 / 修复文本长度：
 *  - 增益 B = L_orig − L_cand（候选 prose 相对原文省下的字符）；
 *  - 代价 C = L_rep − L_cand（尾注占用 = `'\n[restored] ' + missing.join(' ')`）；
 *  - 净释放 N = L_orig − L_rep = B − C（相对「原文保面」的预算净释放，可负）；
 *  - **ROI = N / C**。
 *
 * θ=1 的语义是「尾注替自己买单」：净释放的预算至少与尾注占用相当。
 * N < 0（修复后比原文还长）必然被拒——这正是 spike39 实测的 F1/F4 区间
 * （ROI 0.02 / 0.07，修复后 2.05× 于候选、几乎退化为原文保面）。
 * 被拒即退回 v1.1「原文保面」，错误方向仍只往「少压」错。
 *
 * **这是 HLS 原先缺失的代价盲修正**：修复档此前无论值不值一律补全。
 */
export declare const DEFAULT_HLS_ROI_THRESHOLD = 1;
export interface HlsRepairEconomics {
    /** 增益 B = L_orig − L_cand。 */
    readonly proseGain: number;
    /** 代价 C = 尾注字符数。 */
    readonly trailerCost: number;
    /** 净释放 N = L_orig − L_rep（可负）。 */
    readonly netRelease: number;
    /** ROI = N / C（C = 0 → +∞）。 */
    readonly roi: number;
    /** 是否放行修复（`roi ≥ threshold`）。 */
    readonly accept: boolean;
}
/**
 * HLS 修复档的代价—收益核算（纯函数，0 依赖）。调用方以 `accept` 决定「修复」或「回退原文」。
 * `missing` 空（C = 0）→ ROI = +∞、accept = true（防御性：调用方只在守卫失败、missing 非空时进入）。
 */
export declare function hlsRepairEconomics(originalLength: number, candidateLength: number, missing: readonly string[], threshold?: number): HlsRepairEconomics;
/** 最小结构契约：graph engine 的 `Atom`（id/seq/turn/type/text）结构性满足。 */
export interface OntologyAtom {
    seq: number;
    turn: number;
    type: string;
    text: string;
}
export interface InferredEdgeOptions {
    /**
     * 种子 token 最小长度（默认 6）。守卫词表本身只要求 ≥4（保真场景宁严勿松）；
     * 边派生需要更强区分度——4-5 字符短 token（'ERROR' 之类）在边场景是噪音源。
     */
    minTokenLen?: number;
    /**
     * 停词阈值（默认 0.15）：出现在**全部原子** >15% 中的 token 不派生边
     * （防公共路径/端口/通用标识稀释信号）。分母 = 本次建图的全部原子（含 A/X）。
     */
    stopwordRatio?: number;
    /** 每个 A 原子的推断边上限（默认 8，防 token 密集回复边爆炸）。 */
    maxEdgesPerAtom?: number;
    /**
     * 声明窗口轮数（默认 20）：仅 `turn > latestTurn - windowTurns` 的 A 原子可作
     * 边源；更旧的 A 的 token 重复视为陈旧引用，不再提供新保护（目标侧不限制，
     * 保护的是较旧的数据原子）。
     */
    windowTurns?: number;
}
/** seq 空间的推断边对（消费端映射为 Atom id；声明先行去重在消费端完成）。 */
export interface InferredEdgePair {
    /** 较新 A 原子的 seq（引用方）。 */
    readonly fromSeq: number;
    /** 较旧数据原子（U/R）的 seq（被引用方，严格 < fromSeq）。 */
    readonly toSeq: number;
}
/**
 * 派生推断边（纯函数，0 LLM，I-A2）：
 * 对每个窗口内的 A 原子，取其承重 token（≥minTokenLen、非停词）逐字命中的**更旧**
 * 数据原子（U/R，seq 严格更小）为候选目标；每 A 至多 maxEdgesPerAtom 条
 * （多目标时 seq 降序——最近的原子最可能是实际参照）。
 *
 * 不变式 I-A1（构造性）：每条返回的 (fromSeq, toSeq) 都存在某 token t，
 * t ∈ tokens(A_from.text) 且 t 逐字 ⊆ R/U_to.text。
 *
 * 确定性：同输入必同输出（token 集去重后按原文出现序、候选按 seq 排序）。
 */
export declare function deriveInferredEdges(atoms: readonly OntologyAtom[], opts?: InferredEdgeOptions): InferredEdgePair[];
