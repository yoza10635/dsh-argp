/**
 * C10 夹剪层——剪形模板（**位置归确定性**）：归位在 retention-score.planPrune
 * （语义：不可再生且未被覆盖的软序成员归 clip），机制在 prune-tx 的**组剪检查点文本**
 * （本模块只产替换文本，不碰事务）。
 *
 * 三态保留（C10 设计案 2026-11-12；2.2.2 根修后落点统一为 user 检查点）：
 *  - full   —— 不入剪序（现状不变）；
 *  - clip   —— 组离场时检查点文本携带该组 R 的头尾留真 + 中段省略标记（本模块模板）；
 *  - shadow —— 中性标记全遮（FACTOR_COMPACTED_MARKER / 交互专段，现行为）。
 *
 * 可逆性契约：clip 文本随组检查点写入 **user/message**（宿主 v4 fold 对 user replace
 * 无轮/步约束），原文留在 append-only 日志，recall_history(labels) 原样取回；组内
 * A+R 成对离场，不产孤儿 tool_call。无实体标签的文本不可按标签召回（文本里如实说明，
 * 不指向不存在的工具）。
 *
 * 历史注记（2.2.2 存档加载失败案）：旧实现把 clip 文本写回**原 R 节点本体**
 * （非 append 的 tool/result replace）——宿主 v4 fold 的 requireTurn() 在轮间隙无合法
 * 表达 ⇒ 整档 corrupt 拒载。根修把信息保留从节点形态挪到检查点文本，形态与轮状态解耦。
 *
 * 文本族纪律：首行以 STUB_PREFIX 开头——tagRsFromLog 的桩排除判据
 * （factor-atoms.ts `startsWith(STUB_PREFIX)`）据此把夹剪文本自动排除出再贴标；
 * 文本不在 `[elided` 族（非可合并墓碑），consolidateTombstones 永不吞它。
 */
import { COMMAND_TOOLS, GREP_TOOLS, READ_TOOLS, WRITE_TOOLS } from "./tag-extract.js";
import { STUB_PREFIX } from "./factor-atoms.js";
export function clipFamilyOf(tool) {
    if (COMMAND_TOOLS.has(tool))
        return 'command';
    if (READ_TOOLS.has(tool))
        return 'read';
    if (GREP_TOOLS.has(tool))
        return 'grep';
    if (WRITE_TOOLS.has(tool))
        return 'write';
    return 'other';
}
/**
 * 头尾预算（**字符**，工具族模板，确定性——G1 spike 按工具族分列的形态读数直接
 * 转译）：命令输出报错/终态在尾 ⇒ 尾重；读文件签名/头部结构 ⇒ 头重；grep 命中
 * 序在前 ⇒ 头重；写回执与未知族对称。
 */
export const CLIP_SHAPE = {
    command: { head: 160, tail: 640 },
    read: { head: 640, tail: 160 },
    grep: { head: 520, tail: 160 },
    write: { head: 240, tail: 240 },
    other: { head: 320, tail: 320 },
};
/** 首行 + 省略分隔线的预留（字符）：夹剪收益账用，防 releasedChars 虚报。 */
export const CLIP_OVERHEAD_CHARS = 160;
/** 低于此节省量不剪形（夹剪不放字节就没有存在理由）⇒ 回落最小桩。 */
export const CLIP_MIN_SAVING_CHARS = 2000;
/** 夹剪一枚固定占用的字符数（头+尾+结构线）；planPrune 的收益核算按此扣除。 */
export function clipReserveChars(family) {
    const s = CLIP_SHAPE[family];
    return s.head + s.tail + CLIP_OVERHEAD_CHARS;
}
/** 夹剪文本识别标记（clipText 首行固定形态；遥测计数用，勿改 clipText 结构线）。 */
export const CLIP_MARK = STUB_PREFIX + ' clip ';
/**
 * 夹剪替换文本；`null` = 尺寸不值得夹剪（含头尾重叠风险区）⇒ 调用方回落最小桩。
 * 结构：`STUB_PREFIX clip <tool>[ → key]〔夹剪元数据行〕\n<head>\n……省略线……\n<tail>`。
 */
export function clipText(i) {
    const s = CLIP_SHAPE[clipFamilyOf(i.tool)];
    if (i.text.length <= s.head + s.tail + CLIP_OVERHEAD_CHARS)
        return null;
    const head = i.text.slice(0, s.head);
    const tail = i.text.slice(-s.tail);
    const elided = i.text.length - head.length - tail.length;
    const recall = i.key === undefined
        ? '原文仍在日志，无实体标签（不可按标签召回）'
        : '需要原文时 recall_history(' + i.key + ')';
    return STUB_PREFIX + ' clip ' + (i.tool !== '' ? i.tool : 'tool')
        + (i.key === undefined ? '' : ' → ' + i.key)
        + '〔夹剪：留头 ' + head.length + '/尾 ' + tail.length + ' 字，中段 ' + elided + ' 字省略；' + recall + '〕\n'
        + head + '\n……〔中段省略 ' + elided + ' 字〕……\n' + tail;
}
