/**
 * Per-Atom 门控模块（Stage-1 共用，plan P1）：确定性判定，LLM 只执行动作。
 *
 * 职责三块（全部纯函数、零 LLM / 零 Session 运行时依赖，cite-declarer 同用）：
 *  1. 中断轮次一等公民化（dsh 0.1.1-rc.2 diff「利好 2」）：从事件流精确识别被中断轮次，
 *     `filterInterruptedAtoms` 把同一 turn 的残留原子排除——半成品内容不得进入压缩候选 /
 *     引用图 / 版本链。compressor 与 atomize 同步过滤（本函数是唯一事实源）。
 *  2. 压缩门控谓词：turnCompressible / rNeedCompress（设计 §2 决策序）。
 *  3. 版本链索引（决策④硬排除的判定底座）：同 (tool name + arguments) 键出现 ≥2 次的
 *     R 原子视为版本链成员，强制 need_compress=false。
 *
 * 中断标记口径（rc.2 实测类型 + diff 文档双读，宁全勿漏）：
 *  - `assistant/message.interrupted === true`：流中取消轮次把已交付前缀 finalize 为该事件
 *    （dsh-session types.d.ts 明文）；未派发工具调用缺席 → 该 turn 的原子全是残留。
 *  - `turn/end.reason.kind ∈ { aborted, error, interrupted }`：非正常收尾（取消 / 失败 /
 *    崩溃孤儿收尾）。diff 文档记作「turn/end 新增 interrupted?: true」，rc.2 实际落在
 *    reason.kind 上；本模块两种形态都认，另兼容 data.interrupted 直挂标记的前向演进。
 *  - completed / blocked / max-tokens 不算中断：内容已完整交付（max-tokens 只是截断），
 *    后续步骤可能合法引用，排除方向只允许往"少压"错。
 */
import type { SessionEvent } from '@deepseek-ai/dsh-session';
/** turn/end 非正常收尾的 reason.kind 集合（见文件头口径说明）。 */
export declare const INTERRUPTED_END_REASONS: readonly ["aborted", "error", "interrupted"];
export type InterruptedEndReason = (typeof INTERRUPTED_END_REASONS)[number];
/**
 * 判定一个 turn/end 事件是否把该轮标记为中断。
 * 三种形态：reason.kind 命中集合 / data.interrupted 直挂真值（diff 文档口径）/ 兜底未知形状不误判。
 */
export declare function isInterruptedTurnEnd(data: unknown): boolean;
/**
 * 全日志扫描：返回被中断轮次的 turn 号集合。
 *
 * 只依赖事件形状（不依赖 Session 实例），离线重放/单测/引擎三处共用同一实现。
 * 无 turn/end 的开放轮（正在进行的轮）不算中断——它还没有"收尾"，等 idle 判定时它必然已闭。
 */
export declare function collectInterruptedTurns(events: readonly SessionEvent[]): Set<number>;
/**
 * 排除被中断轮次的残留原子：同一 turn 号的全部原子一并剔除（半成品没有"保留一半"的价值——
 * 未派发工具调用已缺席，已交付前缀是截断产物）。输入宽容：atoms 只要求带 turn 字段，
 * 引擎 Atom / gate GateAtom / 测试桩通用。
 */
export declare function filterInterruptedAtoms<T extends {
    readonly turn: number;
}>(atoms: readonly T[], events: readonly SessionEvent[]): T[];
export interface VersionChainIndex {
    /** 出现 ≥2 次的版本链键（tool name|arguments JSON，或无 issuer 时的 text| 回退键）。 */
    readonly keys: Set<string>;
    /** 单个 R 原子的链键（callId 查 issuer；缺失退化为 text| 键，与图引擎 rKey 同构）。 */
    keyOf(callId: string | undefined, text: string): string;
    /** 成员判定：键在 keys 集合中即版本链成员。 */
    isMember(callId: string | undefined, text: string): boolean;
}
/**
 * 全日志构建 R 版本链键索引。与 argp-graph-engine findVersionDuplicates 的 rKey 口径一致
 * （issuer A 的 tool name + arguments JSON；callId 缺失退化 r.text），但判定更保守：
 * 键重复出现即视为链成员（图引擎还要求 inDegree=0 才剪旧版，压缩侧不做图分析，
 * 一律按 verbatim 保护处理——错误方向只允许往"少压"错）。
 */
/**
 * 全日志构建 callId → 工具种类名索引（tool 对照表的查找底座，设计 §6-2）。
 * 工具名只落在 assistant/message 内嵌 tool-call 块的 name 上；tool/result 只带 callId，
 * 故须经 callId 反查。无 issuer（孤立 tool/result）→ 无名字，策略表跳过，落回启发式默认。
 */
export declare function buildToolNameIndex(events: readonly SessionEvent[]): Map<string, string>;
export declare function buildVersionChainIndex(events: readonly SessionEvent[]): VersionChainIndex;
/**
 * 事件 → 模型可见文本（text + tool-call 概要 + tool-result 内层 text；reasoning 不算）。
 * 与 argp-graph-engine eventText 同口径的本模块私有镜像：gate 保持叶子纯净，
 * 不为投影功能反向依赖 Stage-2 引擎模块。
 */
export declare function projectSurfaceText(event: SessionEvent): string;
/** need_compress 三档（false=保原文 / summary=一句话概括 / extract=关键内容摘录）。 */
export type NeedCompress = false | 'summary' | 'extract';
/**
 * 大小启发式默认档线（字符）：低于此值的工具结果不值得 replace（净增副本元数据 +
 * KV 失效代价，与 t1 minSpanChars=512 的实测理由同源）；达到即 extract 档。
 */
export declare const DEFAULT_SMALL_RESULT_CHARS = 512;
export interface GateUserLong {
    kind: 'user-long';
    seq: number;
    turn: number;
    text: string;
}
export interface GateToolResult {
    kind: 'tool-result';
    seq: number;
    turn: number;
    text: string;
    callId?: string;
    /** 工具种类名（tool 对照表 / 作者声明的查找键，设计 §6-2）。callId→name 由 buildToolNameIndex 解析。 */
    toolName?: string;
}
export type GateAtom = GateUserLong | GateToolResult;
export interface GateOptions {
    /** 工具结果小结果阈值（默认 DEFAULT_SMALL_RESULT_CHARS）。 */
    smallResultChars?: number;
    /**
     * 工具作者声明通道 / **tool 对照表**（设计 §6-2 `setToolPolicy(toolName, policy)`，
     * 决策序第 2 层，上限提示非强制）。键 = **工具种类名**（toolName），非 callId——
     * 同一工具的多条结果应同档。声明只放宽/收紧启发式默认，不可越过版本链硬排除
     * （决策序第 1 层先行短路）；未声明的工具走大小启发式（缺席默认，设计 §6-5）。
     */
    toolPolicies?: ReadonlyMap<string, NeedCompress>;
}
/**
 * R 档位裁决（设计 §2 决策序，先命中先生效）：
 * ① 版本链成员 → false（硬排除，不可覆盖）；② 作者声明 → 采纳；③ 大小启发式默认。
 */
export declare function rNeedCompress(r: Pick<GateToolResult, 'text' | 'callId' | 'toolName'>, chain: VersionChainIndex, opts?: GateOptions): NeedCompress;
/** user 长消息判定（拆分阈值，types.ts SPLIT_THRESHOLD_CHARS 口径由调用方传入比较）。 */
export declare function userIsLong(text: string, thresholdChars: number): boolean;
/**
 * 当轮调用门控（plan P1 / 设计 §2 调用门控）：仅当轮存在可压缩原子才触发 LLM——
 * 任一 User 长消息 ∨ 任一 Tool 的 need_compress ≠ false。纯 dialog 轮直接跳过：
 * 零调用（计数器可断言）、零 cites（孤立原子规则）。
 */
export declare function turnCompressible(atoms: readonly GateAtom[], chain: VersionChainIndex, opts?: GateOptions): boolean;
/** 提取原文中必须在压缩副本里 verbatim 存活的高信号 token（去重）。 */
export declare function findLoadBearingTokens(text: string): string[];
/** 守卫裁决：missing 非空 = 该副本不得落盘（原文保面）。 */
export declare function fidelityGuard(originalText: string, compressedText: string): {
    ok: boolean;
    missing: string[];
};
