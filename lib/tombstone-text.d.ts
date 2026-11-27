/**
 * ARGP 墓碑文案叶模块——墓碑文本与判据的**单一事实源**。
 *
 * 墓碑文本有 4 个生成点（区间、单节点、闭包、聚合；tool 占位是独立一族）与 3 个消费
 * 判据（`isToolTombstoneText` / `isTombstoneText` / `isMergeableTombstoneText`）。
 * 文案与判据放进同一文件，使二者**物理上不可分离**：任何措辞改动若绕过判据，测试即红
 * （漏改可合并判据 ⇒ tool 占位墓碑被归并 ⇒ callId 蒸发 ⇒ issuer A 的 tool_calls 失去
 * 应答 ⇒ provider 400；漏改终止态谓词 ⇒ "墓碑换墓碑"空转）。
 *
 * ## 零 import（硬约束）
 *
 * `prune-tx` 是 hub 的下游、要 import 本模块；若本模块反向 import 任一运行时模块即成
 * 循环依赖（仓库既有的"单向依赖：hub → X"设计决策）。故本模块**没有任何 import**
 * （含 type-only）。
 *
 * ## 文案形态（统一短文案，带 `for detail` 劝说语）
 *
 * ```
 * [elided seq=A..B; recall_pruned(A) for detail]                  区间
 * [elided seq=A; recall_pruned(A) for detail]                     单节点
 * [elided closure <id> seqs=A..B[; root=<preview>]; recall_pruned(A) for detail]
 * [elided consolidated ×N seqs=A..B; recall_pruned(A) for detail]
 * [elided: seq=A; recall_pruned(A) for detail]                    tool 占位
 * ```
 *
 * 设计要点：
 * 1. **`[elided` 前缀保留**：既有 `startsWith('[elided')` 类判据不破；但判据必须校验
 *    紧随字符（空格/冒号），裸前缀会把用户自造文本误认成墓碑。
 * 2. **"被剪的是什么 / 怎么取回"只在系统级词表 context 里说一次**（2.2.3 起走
 *    systemPrompt.context；无该服务时退回压缩后的词表 note），不在每条墓碑重复——
 *    单条重复是指引膨胀的结构性根因。
 * 3. **seq 一律是原始节点的 log seq**（不是 replace 副本 seq）：取回指针才是合法入参；
 *    只写 `recall_pruned(seq)` 却不给 seq 会让通路等于断的。
 * 4. **`for detail`** 是劝说语：+11 字符买"召回入口指引"，缺的是入口而非能力。
 *    与之配套：召回上限是**字符预算**（见 `recall.ts` budgetRecallText），不是次数闸。
 *
 * ## 判别子
 *
 * "不可合并 vs 可合并"由**语法级前缀**承担：`[elided:`（冒号）= tool 占位墓碑，
 * `[elided `（空格）= 可合并族。不要用自然语言子串（措辞一改就失效）；前缀是语法级、
 * 不随修辞漂移，且与文案生成同处一文件。
 */
/**
 * 全部 ARGP 墓碑的公共前缀。
 * ⚠️ 判据必须校验**紧随其后的字符**（空格或冒号），否则 `[elidedFoo` 这类
 * 用户自造文本会被误认为墓碑（`startsWith('[elided')` 单独用是不够的）。
 */
export declare const TOMBSTONE_PREFIX = "[elided";
/** tool 占位墓碑前缀（冒号形态）——`isMergeableTombstoneText` 的"不可合并"判别子。 */
export declare const TOOL_TOMBSTONE_PREFIX = "[elided:";
/** 取回指引（`recall_pruned(<seq>) for detail`）。 */
/** factor 指针墓碑（A 半截/孤儿 R）：不带取回工具名——2.0 只有标签召回，A 无标签。 */
export declare function isFactorTombstoneText(text: string): boolean;
/** 是否为 tool 占位墓碑文本（`[elided:` 冒号族）。 */
export declare function isToolTombstoneText(text: string): boolean;
/**
 * 是否为 ARGP 墓碑文本（**全部**四族，现行 + 已知历史文法的整串匹配）。
 *
 * G1/A10 的终止态判定 = 文本判据 + replace 事件锚串联
 * 使用本函数；单用文本判据不足以承担终止态语义。peratom 的压缩副本标记
 * （`[已压缩-摘取 seq=N]` / `[已压缩-摘要 seq=N]`）**不算**墓碑 —— 它是 LLM 压缩过的
 * 摘要，仍含信息，应当可继续被剪。
 */
export declare function isTombstoneText(text: string): boolean;
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
export declare function isMergeableTombstoneText(text: string): boolean;
