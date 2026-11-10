/**
 * 因子臂 U/A 批次摘要的**输入层纯函数**（design-2.0 §2.4；LLM 调用与发射在
 * ua-summarizer.ts——本文件零 LLM、零事件读取，事件形态经 probe 回调注入）。
 *
 * 纪律：
 *  - 分类器四类（+rPair 随行料）：`textA | toolCallA（含配对 R）| excluded
 *    （relay/notice、X、已浓缩副本）| barrier（附件）`——relay/notice 与 U-info 聚合
 *    副本都是**已浓缩产物**（DEFAULT_SKIP_CONTEXT_FORMS 教训），二次摘要禁入；
 *  - span 是**连续 surface 切片**（prune-tx replace 的硬前提；"连续"按 surface 序列
 *    论——tool/call 占 log 格不进 surface，A/R 之间的洞合法，closeRun 注释有实测）：
 *    excluded/barrier/
 *    孤儿 R/不可参摘原子一律切段（它们绝不能被摘要副本吞掉）；协议组不劈——
 *    段尾未闭合的 toolCallA 弹出（连同其后内容弃入下批重规划）；
 *  - 约束带逐字：命中约束词法的 **U 句**取原文子串进带，不参与生成；
 *    高召回词法，误报代价 = 多几行逐字文本；
 *  - 未闭合轮与焦点轮不入池：本轮协议现场/任务活体，语义同 R 剪的硬保护位。
 */
import type { Atom } from '../argp-types.ts';
export type SummaryInputClass = 'textA' | 'toolCallA' | 'rPair' | 'excluded' | 'barrier';
/** 事件读侧探针（atom 上无 source.form / 附件块——编排侧从日志投影后喂进来）。 */
export interface UaEventProbe {
    /** source.form（relay/notice ⇒ excluded）。 */
    form?: string;
    /** 内容含 image/file 块 ⇒ barrier（摘要不吃附件，且切断段）。 */
    attachment: boolean;
}
/** 已浓缩形态（二次摘要禁令；与 constants.DEFAULT_SKIP_CONTEXT_FORMS 同名单）。 */
export declare const SKIP_SUMMARY_FORMS: readonly string[];
export declare function classifyUaAtom(atom: Atom, probe: UaEventProbe): SummaryInputClass;
/** 约束词法（§2.4 名单 + 同族扩展）：命中即整句逐字进约束带。 */
export declare const CONSTRAINT_LEXICON_RE: RegExp;
/**
 * 逐字约束句：按句末标点/换行切句，返回**原文子串**（不改写；trim 只切两端空白）。
 */
export declare function constraintLinesOf(text: string): string[];
export interface UaSpan {
    /** 连续 surface seq（含 rPair——replace 范围逐节点覆盖）。 */
    seqs: number[];
    atoms: Atom[];
    /** 段内 U+A 字符量（阈值池口径；R 是配对随行料不计池）。 */
    poolChars: number;
    /** 段内全量字符（发射记账）。 */
    allChars: number;
    firstTurn: number;
    lastTurn: number;
    /** 段内 U 原子的约束句（逐字，出现序）。 */
    constraintLines: string[];
}
export interface UaPlanResult {
    /** 由旧到新。 */
    spans: UaSpan[];
    poolChars: number;
    /** 规划时日志尾（发射只覆盖 seq < watermark；异步期新事件天然入下批）。 */
    watermark: number;
    /** 全部段约束句合并（去重保序）。 */
    constraintLines: string[];
}
export interface UaPlanOptions {
    probe: (seq: number) => UaEventProbe;
    /** detectOpenTurn：本轮协议现场不参摘（遇该 turn 原子切段）。 */
    openTurn: number | null;
    /** turn >= 此值不参摘（焦点轮活体；null = 不护）。 */
    protectFromTurn: number | null;
    /** 规划时刻日志尾（调用方传 session.seq）。 */
    watermark: number;
}
export declare function planUaSpans(atoms: readonly Atom[], opts: UaPlanOptions): UaPlanResult;
