/** 工具族（剪形模板的键；与 tag-extract 族集同源，禁另立名册）。 */
export type ClipFamily = 'command' | 'read' | 'grep' | 'write' | 'other';
export declare function clipFamilyOf(tool: string): ClipFamily;
export interface ClipShape {
    head: number;
    tail: number;
}
/**
 * 头尾预算（**字符**，工具族模板，确定性——G1 spike 按工具族分列的形态读数直接
 * 转译）：命令输出报错/终态在尾 ⇒ 尾重；读文件签名/头部结构 ⇒ 头重；grep 命中
 * 序在前 ⇒ 头重；写回执与未知族对称。
 */
export declare const CLIP_SHAPE: Readonly<Record<ClipFamily, ClipShape>>;
/** 首行 + 省略分隔线的预留（字符）：夹剪收益账用，防 releasedChars 虚报。 */
export declare const CLIP_OVERHEAD_CHARS = 160;
/** 低于此节省量不剪形（夹剪不放字节就没有存在理由）⇒ 回落最小桩。 */
export declare const CLIP_MIN_SAVING_CHARS = 2000;
/** 夹剪一枚固定占用的字符数（头+尾+结构线）；planPrune 的收益核算按此扣除。 */
export declare function clipReserveChars(family: ClipFamily): number;
/** 该尺寸入剪时的净释放（字符）：夹剪成员按净量入目标账。 */
export declare function clipNetGainChars(sizeChars: number, family: ClipFamily): number;
/** 夹剪文本识别标记（clipText 首行固定形态；遥测计数用，勿改 clipText 结构线）。 */
export declare const CLIP_MARK: string;
export interface ClipEmitInput {
    tool: string;
    /** 实体标签（document:/command:/errorcode: 选择序同 stubText）；无 ⇒ undefined。 */
    key: string | undefined;
    /** 原 R 事件 seq（召回通道指路用）。 */
    seq: number;
    /** 原文（rawEventText(session, seq).text）。 */
    text: string;
}
/**
 * 夹剪替换文本；`null` = 尺寸不值得夹剪（含头尾重叠风险区）⇒ 调用方回落最小桩。
 * 结构：`STUB_PREFIX clip <tool>[ → key]〔夹剪元数据行〕\n<head>\n……省略线……\n<tail>`。
 */
export declare function clipText(i: ClipEmitInput): string | null;
