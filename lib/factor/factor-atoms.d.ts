import type { RTags } from './types.ts';
/** 事件形状的最小结构型（SessionEvent 的读侧投影，避免 import 宿主类型传染）。 */
export interface EventLike {
    seq: number;
    type: string;
    data?: Record<string, unknown>;
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
 * R 事件文本投影：text 块 + tool-result 嵌套 content 递归（spike48 首轮病灶锁）。
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
}
/**
 * 对全部 R 原子贴标（seq → 输入+结果）。issuer 缺失（悬挂/损坏事件）不丢弃：
 * tool=''/args=null 走文本兜底通道，贴不出的标签由覆盖率口径如实登记。
 */
export declare function tagRs(events: readonly EventLike[], atoms: readonly AtomLike[], sessionCwd: string | undefined): Map<number, RTagInput>;
/**
 * 焦点标签集（§2.5 定稿措辞）：最近 focalTurns 轮**存活 U/A** 文本命中的 canonical
 * 标签（extractTags 文本兜底通道，同 canonical 单点）——**不是**"最近轮全部原子"。
 * U/A 是 cue 链载体，A 恒留正是前提；R 的键要成为焦点须经 U/A 叙事引用。
 */
export declare function focalLabels(atoms: readonly AtomLike[], latestTurn: number, focalTurns: number, sessionCwd: string | undefined): Set<string>;
/** old ⊆ new（同为对该文件的成功 read；new 更新）。 */
export declare function rangeCovered(old: RTags['readRange'], next: RTags['readRange']): boolean;
/**
 * seq → 是否被后续同文件成功读覆盖。只看 READ 类成功 R；错误读不作覆盖证据。
 * P1-d 保守：issuer 工具名缺失（''）不认 read 类（与 retention-score 的族下限同口径）。
 */
export declare function supersededMarks(tagsBySeq: ReadonlyMap<number, RTagInput>): Map<number, boolean>;
