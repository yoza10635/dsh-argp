/**
 * ARGP 墓碑文案叶模块（1.7.1，G 组）——墓碑文本的**单一事实源**。
 *
 * ## 为什么单独成叶
 *
 * 墓碑文本有 5 个生成点（`prune-selection.buildTombstones` 的闭包/区间两族、`prune-tx`
 * 的两处 fallback、tool 占位墓碑、`CompactionResult.summary` 渲染）与 3 个消费判据
 * （`isToolTombstoneText` / `isTombstoneText` / `isMergeableTombstoneText`）。
 * 1.7.0 及以前这些字符串**各自复制**（区间文案就存在 3 份拷贝），任何措辞改动都要人肉
 * 同步 9 处，漏一处即**静默**退化：
 *   - 漏改 `isMergeableTombstone` ⇒ tool 占位墓碑被判"可合并" ⇒ 归并后 callId 蒸发 ⇒
 *     issuer A 的 tool_calls 失去应答 ⇒ provider 400（与孤儿 tool 消息同级）；
 *   - 漏改 G1 的 `isTombstoneText` 谓词 ⇒ 终止态排除静默失效（回到"墓碑换墓碑"空转）。
 * 本模块把"文案"与"判据"放进同一文件，使二者**物理上不可分离**。
 *
 * ## 零 import（硬约束）
 *
 * `prune-selection` 与 `prune-tx` 都是 hub 的下游、都要 import 本模块；若本模块反向
 * import 任一者即成循环依赖（仓库既有的"单向依赖：hub → X"设计决策）。
 * 故本模块**没有任何 import**（含 type-only）。
 *
 * ## 文案形态（1.7.1 统一短文案，带 `for detail` 劝说语）
 *
 * ```
 * [elided seq=A..B; recall_pruned(A) for detail]                  区间（115 → 55 字符）
 * [elided seq=A; recall_pruned(A) for detail]                     单节点（49）
 * [elided closure <id> seqs=A..B[; root=<preview>]; recall_pruned(A) for detail]
 * [elided consolidated ×N seqs=A..B; recall_pruned(A) for detail]
 * [elided: seq=A; recall_pruned(A) for detail]                    tool 占位（50）
 * ```
 *
 * 设计要点：
 * 1. **`[elided` 前缀保留** ⇒ 既有 `startsWith('[elided')` 类判据（spike/44 等）不破。
 * 2. **"被剪的是什么 / 怎么取回"只在 system 契约里说一次**（`argp-contract` section），
 *    不在每条墓碑重复 —— 这是 1.7.0 文案（115 字符）"太长"的结构性根因。
 * 3. **seq 一律是原始节点的 log seq**（不是 replace 副本 seq），必须是 `recall_pruned`
 *    的合法入参（`{ seq: integer }`）。1.7.0 的 tool 墓碑写着 `recall_pruned(seq)` 却
 *    **0/364 给 seq**，自相矛盾，逼模型多绕一步 `list_pruned --keyword` 反查。
 * 4. **`for detail`** 是劝说语（用户拍板）：+11 字符买"召回入口指引"，因实测每轮
 *    3 次的召回配额**从未触顶**（6 次调用分散在 2 轮），缺的是入口而非能力。
 *    与之配套：召回上限由"3 次/轮"改为**按字符预算**（见 `recall-tools.ts`）。
 *
 * ## 判别子（1.7.1 换轴）
 *
 * "不可合并 vs 可合并"改由**语法级前缀**承担：`[elided:`（冒号）= tool 占位墓碑，
 * `[elided `（空格）= 可合并族。1.7.0 用的是自然语言子串 `pruned by ARGP`（缺它 = 不可
 * 合并），措辞一改就失效；前缀是语法级、不随修辞漂移，且与文案生成同处一文件。
 */

/**
 * 全部 ARGP 墓碑的公共前缀。
 * ⚠️ 判据必须校验**紧随其后的字符**（空格或冒号），否则 `[elidedFoo` 这类
 * 用户自造文本会被误认为墓碑（`startsWith('[elided')` 单独用是不够的）。
 */
export const TOMBSTONE_PREFIX = '[elided'

/** tool 占位墓碑前缀（冒号形态）——`isMergeableTombstoneText` 的"不可合并"判别子。 */
export const TOOL_TOMBSTONE_PREFIX = '[elided:'

/**
 * 墓碑长度安全阀（G1 终止态排除的例外上限）。
 *
 * G1 把"文本已是墓碑"当作**终止态**（再剪一次仍产出墓碑 = 收益 0，实测占全部 replace
 * 的 76.2%）。但极长墓碑若被一律排除会**卡住地板**：长度是"还有东西可丢"的弱信号，
 * 超长说明它本身承载可观字符（1.7.0 的闭包墓碑曾内联整行 rootPreview，无上限）。
 * ⇒ 超过本阈值的墓碑仍允许参剪（宁少剪，不卡地板；少剪是安全方向）。
 */
export const TOMBSTONE_MAX_CHARS = 200

/**
 * 闭包墓碑里 root 预览的截断长度。
 *
 * 1.7.0 的 `rootPreview` 取 root 文本**整行、无截断**（`selectClosureToMerge`）⇒ 单条
 * 闭包墓碑可达数千字符，既抬地板又让 G1 的长度安全阀失效。截断后闭包墓碑回到百字符内。
 */
export const CLOSURE_ROOT_PREVIEW_MAX_CHARS = 40

/** 取回指引后缀（1.7.1：用户拍板带劝说语）。 */
const RETRIEVE_HINT = ' for detail'

/** 用户文本里的换行/制表会破坏单行墓碑形态；预览在生成期折叠为单空格。 */
function previewText(raw: string): string {
  const oneLine = raw.replace(/\s+/g, ' ').trim()
  return oneLine.length <= CLOSURE_ROOT_PREVIEW_MAX_CHARS
    ? oneLine
    : oneLine.slice(0, CLOSURE_ROOT_PREVIEW_MAX_CHARS) + '…'
}

/** `[elided` 且紧随空格或冒号 ⇒ 确认为 ARGP 墓碑（排除 `[elidedFoo` 类误判）。 */
function hasTombstonePrefix(t: string): boolean {
  if (!t.startsWith(TOMBSTONE_PREFIX)) return false
  const next = t.charAt(TOMBSTONE_PREFIX.length)
  return next === ' ' || next === ':'
}

/** `seq=A..B` 片段（`A === B` 时省略 `..B`，单节点形态）。 */
function seqSpan(start: number, end: number): string {
  return 'seq=' + start + (end === start ? '' : '..' + end)
}

/** `seqs=A..B` 片段（闭包/聚合族用复数，因为它们是"多段墓碑归并"的产物）。 */
function seqsSpan(start: number, end: number): string {
  return 'seqs=' + start + (end === start ? '' : '..' + end)
}

/** 取回指引（`recall_pruned(<seq>) for detail`）。 */
function retrieve(seq: number): string {
  return 'recall_pruned(' + seq + ')' + RETRIEVE_HINT
}

// ---------------------------------------------------------------------------
// 生成器（唯一文案出口）
// ---------------------------------------------------------------------------

/**
 * tool 占位墓碑（剪 R 而保留 issuer A 时使用）。
 *
 * 保留 `callId` 配对是**协议硬要求**（`assertToolResultRewrite` 只允许改 inner text），
 * 故文案本身不改结构，只补 seq —— issuer A 的 tool-call 就在紧邻位置（实测 346/364
 * 距离 ≤ 2），模型据此即可判断"这是哪次调用"，缺的只是**取回指针**。
 */
export function toolTombstone(originalSeq: number): string {
  return TOOL_TOMBSTONE_PREFIX + ' seq=' + originalSeq + '; ' + retrieve(originalSeq) + ']'
}

/** 单节点/区间 user 墓碑（`start === end` 时退化为单节点形态）。 */
export function seqRangeTombstone(start: number, end: number): string {
  return TOMBSTONE_PREFIX + ' ' + seqSpan(start, end) + '; ' + retrieve(start) + ']'
}

/** 闭包墓碑（整段闭包生命周期退休）。`rootPreview` 为空串时省略 root 片段。 */
export function closureTombstone(closureId: string, start: number, end: number, rootPreview: string): string {
  const root = previewText(rootPreview)
  return TOMBSTONE_PREFIX + ' closure ' + closureId + ' ' + seqsSpan(start, end)
    + (root === '' ? '' : '; root=' + root) + '; ' + retrieve(start) + ']'
}

/** 聚合墓碑（tombstone-merge：多条墓碑归并为一条）。 */
export function consolidatedTombstone(count: number, start: number, end: number): string {
  return TOMBSTONE_PREFIX + ' consolidated ×' + count + ' ' + seqsSpan(start, end)
    + '; ' + retrieve(start) + ']'
}

/**
 * `CompactionResult.summary` 里的 tool 墓碑渲染文本。
 *
 * 不进 prompt（`compaction/summary` 是 off-surface 日志事件，UI 展示用），故不带 seq
 * ——summary 是轮级汇总，写出某个具体 seq 会误导。
 */
export function toolTombstoneSummary(): string {
  return TOOL_TOMBSTONE_PREFIX + ' tool result compressed]'
}

// ---------------------------------------------------------------------------
// 判据（唯一识别出口）
// ---------------------------------------------------------------------------

/** 是否为 tool 占位墓碑文本（`[elided:` 冒号族）。 */
export function isToolTombstoneText(text: string): boolean {
  return text.trimStart().startsWith(TOOL_TOMBSTONE_PREFIX)
}

/**
 * 是否为 ARGP 墓碑文本（**全部**四族：tool / 区间 / 闭包 / 聚合）。
 *
 * G1 用它做"已立碑 = 终止态"判定，故必须**宽**（宁可多认也不漏认：漏认 ⇒ 空转回归；
 * 多认一个非墓碑文本 ⇒ 少剪一次，安全方向）。peratom 的压缩副本标记
 * （`[已压缩-摘取 seq=N]` / `[已压缩-摘要 seq=N]`）**不算**墓碑 —— 它是 LLM 压缩过的
 * 摘要，仍含信息，应当可继续被剪。
 */
export function isTombstoneText(text: string): boolean {
  return hasTombstonePrefix(text.trimStart())
}

/**
 * 是否为**可合并**墓碑（`consolidateTombstones` 的判据，1.7.0 的 `isMergeableTombstone`）。
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
