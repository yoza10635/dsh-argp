/**
 * ARGP 墓碑判据叶模块——**只读识别**，不再生成文案。
 *
 * 2.2.2 根修后，本插件不再发射 `[elided …]` 形态的 tool/result 墓碑（宿主 v4 fold
 * 要求非 append 的 tool/result 必须落在开放轮内，而压缩事务可发生在轮间隙 ⇒ 该形态
 * 是不可重新加载的毒源）。现行压缩只写两种 user/message 节点：组剪的
 * `FACTOR_COMPACTED_MARKER` 与散文浓缩的 `<compacted-summary>` 检查点。
 * `[elided …]` 因此只作为**历史文法**存在——存量会话的 surface 里仍有它们，
 * 识别它们是「不重复归并、不误判终止态」的判据，不是 2.x 的写出路径。
 *
 * 现存两个判据（唯一消费者）：
 *  - `isFactorTombstoneText`：factor 半截 A 的检查点文案
 *    （`[elided seq=N; 原文在 append-only 日志]`），散文浓缩用它区分「已离场半截 A」
 *    与真散文；
 *  - `isMergeableTombstoneText`：`consolidateTombstones` 的可合并判据
 *    （`[elided ` 空格族 + 含 `recall_pruned(`；`[elided:` 冒号族不可合并）。
 *
 * ## 零 import（硬约束）
 *
 * `prune-tx` 是 hub 的下游、要 import 本模块；若本模块反向 import 任一运行时模块即成
 * 循环依赖（仓库既有的"单向依赖：hub → X"设计决策）。故本模块**没有任何 import**
 * （含 type-only）。
 *
 * ## 判别子
 *
 * "不可合并 vs 可合并"由**语法级前缀**承担：`[elided:`（冒号）= tool 占位墓碑，
 * `[elided `（空格）= 可合并族。不要用自然语言子串（措辞一改就失效）；前缀是语法级、
 * 不随修辞漂移，且与判据同处一文件。
 */

/**
 * 全部 ARGP 墓碑的公共前缀。
 * ⚠️ 判据必须校验**紧随其后的字符**（空格或冒号），否则 `[elidedFoo` 这类
 * 用户自造文本会被误认为墓碑（`startsWith('[elided')` 单独用是不够的）。
 */
const TOMBSTONE_PREFIX = '[elided'

/** tool 占位墓碑前缀（冒号形态）——`isMergeableTombstoneText` 的"不可合并"判别子。 */
const TOOL_TOMBSTONE_PREFIX = '[elided:'

/** `[elided` 且紧随空格或冒号 ⇒ 确认为 ARGP 墓碑（排除 `[elidedFoo` 类误判）。 */
function hasTombstonePrefix(t: string): boolean {
  if (!t.startsWith(TOMBSTONE_PREFIX)) return false
  const next = t.charAt(TOMBSTONE_PREFIX.length)
  return next === ' ' || next === ':'
}

/**
 * factor 指针墓碑（半截 A / 孤儿 R 的检查点）：带 seq、不带取回工具名
 * ——2.x 只有标签召回，A 无标签。整串锚定到固定尾部，避免把用户正文里
 * 恰好复述 `[elided seq=` 的片段认作检查点。
 */
export function isFactorTombstoneText(text: string): boolean {
  const t = text.trimStart()
  return t.startsWith(TOMBSTONE_PREFIX + ' seq=') && t.includes('原文在 append-only 日志]')
}

/**
 * 是否为**可合并**墓碑（`consolidateTombstones` 的判据）。
 *
 * 可合并 = ARGP 墓碑（`[elided ` 空格族，排除 tool 占位）+ 含 `recall_pruned(` 取回指引。
 * 两条排除项都是**双保险**性质：
 *  - `consolidateTombstones` 本就只扫 `user/message` 事件（tool 墓碑是 `tool/result`），
 *    故 tool 墓碑到不了这里；前缀判别子防的是"有人把这个纯函数用到别处"。
 *  - 要求 `recall_pruned(` 排除宿主 system-reminder / 官方 checkpoint / 恰好提到
 *    `recall_pruned` 的用户正文（测试用例锁定）。
 */
export function isMergeableTombstoneText(text: string): boolean {
  const t = text.trimStart()
  if (!hasTombstonePrefix(t)) return false
  if (t.startsWith(TOOL_TOMBSTONE_PREFIX)) return false
  return t.includes('recall_pruned(')
}
