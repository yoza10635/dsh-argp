import type { RTags } from './types.ts';
/** 事件形状的最小结构型（SessionEvent 的读侧投影，避免 import 宿主类型传染）。 */
export interface EventLike {
    seq: number;
    type: string;
    data?: Record<string, unknown>;
    surfaceOp?: unknown;
}
/** Atom 的读侧投影（argp-types.Atom 的字段子集）。 */
export interface AtomLike {
    seq: number;
    type: 'U' | 'A' | 'R' | 'X';
    turn: number;
    text: string;
    toolCallIds: string[];
}
export interface CallInfo {
    name: string;
    args: unknown;
    seq: number;
}
/** tool/call 事件 + A 事件内嵌 tool-call 块 双形态索引（先到者胜）。 */
export declare function indexCalls(events: readonly EventLike[]): Map<string, CallInfo>;
/**
 * R 事件文本投影：text 块 + tool-result 嵌套 content 递归（P0 首轮病灶锁）。
 * capChars 只影响 errorish 文本信号与 sizeChars 的口径（大输出照样被 size 键排前）。
 */
export declare function resultTextOf(e: EventLike, capChars?: number): string;
/** isError 双形态（V4 message 顶层 / V3 tool-result 块内），取 OR。 */
export declare function isErrorOf(e: EventLike): boolean;
/** session 头事件的 cwd（事件时环境；缺 undefined——绝不拿当前 cwd 凑）。 */
export declare function sessionCwdFromEvents(events: readonly EventLike[]): string | undefined;
export interface RTagInput {
    seq: number;
    turn: number;
    callId: string | undefined;
    tool: string;
    resultText: string;
    tags: RTags;
    /** R 内含 image/file 块（含 tool-result 嵌套 content）：文本桩会丢附件 ⇒ 硬保护。 */
    hasAttachment?: boolean;
}
/** 事件 data 内是否有附件块（image/file，递归 tool-result 的嵌套 content）。 */
export declare function hasAttachmentBlocks(data: unknown): boolean;
/** 桩 R 文本前缀（engine.stubText 产出）：日志驱动贴标的排除判据。 */
export declare const STUB_PREFIX = "[\u5DF2\u526A\u00B7\u56E0\u5B50]";
/**
 * **日志根事件驱动**贴标（resume 重放的正解）：遍历日志 tool/result 事件，
 * replace 副本经 `resolveRootSeqs`（log-access.ts:280）折回原 seq——被剪 R 的
 * 原事件离场 surface 后仍可入账（"账本 = shadowed 投影"在 resume 下建得起来）。
 *
 * 排除项：① replace 副本（root≠自身 seq，原文账记在原 seq 上）；② 桩事件
 * （STUB_PREFIX 文本——桩不是新 R，进 sticky/candidates 都是污染）。
 * turn 取事件 data.turn（缺 0，与 atomize 口径一致）。
 */
export declare function tagRsFromLog(events: readonly EventLike[], sessionCwd: string | undefined, resolveRoot: (seq: number) => number[]): Map<number, RTagInput>;
/**
 * 焦点标签集（§2.5 定稿措辞）：最近 focalTurns 轮**存活 U/A** 文本命中的 canonical
 * 标签（extractTags 文本兜底通道，同 canonical 单点）——**不是**"最近轮全部原子"。
 * U/A 是 cue 链载体，A 恒留正是前提；R 的键要成为焦点须经 U/A 叙事引用。
 */
export declare function focalLabels(atoms: readonly AtomLike[], latestTurn: number, focalTurns: number, sessionCwd: string | undefined): Set<string>;
/**
 * 焦点命令标签（medium 带，§2.5 v1.1：命令只参与排序、永不进 hard）。
 * 命令**实际发生过**（焦点窗内 tool/call 事件的 args）才算焦点——U/A 文本通道恒缺
 * args（focalCmd 构造级恒空的病灶，spike51）；族名过 COMMAND_MEDIUM_FAMILY_WHITELIST
 * （首 token 太粗：cd 族爆炸半径/伪家族，实测定谳）。
 */
export declare function focalCommandLabels(calls: readonly {
    turn: number;
    name: string;
    args: unknown;
}[], latestTurn: number, focalTurns: number): Set<string>;
/** old ⊆ new（同为对该文件的成功 read；new 更新）。 */
export declare function rangeCovered(old: RTags['readRange'], next: RTags['readRange']): boolean;
/**
 * seq → 是否被后续同文件成功读覆盖。只看 READ 类成功 R；错误读不作覆盖证据。
 * P1-d 保守：issuer 工具名缺失（''）不认 read 类（与 retention-score 的族下限同口径）。
 */
export declare function supersededMarks(tagsBySeq: ReadonlyMap<number, RTagInput>): Map<number, boolean>;
