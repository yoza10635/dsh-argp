/**
 * 召回面工具名单单一事实源（叶子模块，零依赖）。
 *
 * 落点历史：名单原定义在 recall-labels.ts；2026-11-23 召回副本可见性裁决要求
 * factor-ledger（queryPruned/vocabularyRows/observeR）也按同一判据识别副本，
 * 而从 factor-ledger 反向 import recall-labels 会构成 recall-labels→factor-ledger
 * 循环，故抽到本叶子模块——factor-ledger / engine / recall-labels / search-history
 * 四方均可无循环 import。
 *
 * 名单的两次消费裁定：
 *  - **P6-③ 裁定 2（剪枝层，不动）**：召回对（call+result）轮闭合后无条件进剪序
 *    （可再生=再召回一次），全部硬保护位失效；在轮（open turn）排除同名单
 *    （2026-11-17 P1 修订：轮内剪空=高压时召回面自废）；
 *  - **召回副本可见性裁决（2026-11-23，查询层）**：被剪的召回工具自身结果（副本）
 *    携带与原文相同的 document:/errorcode: 键（tag-extract 文本侧兜底）+ 本族
 *    tool: 键（indexKeys）——缺省不进查询候选（queryPruned/search_history 工具带）、
 *    不进 sticky 观察面（observeR）、不进非 tool facet 的词表计数（vocabularyRows，
 *    维持「词表数=可查数」契约）；labels 显式点名 tool: 召回族键时放行（审计通道）。
 */
/** 名单名 = defineTool 注册名逐字（search_history 同族 2.1.0 刀 B：结果同样可再生）。 */
export declare const RECALL_TOOL_NAMES: readonly string[];
/** 副本携带的 tool 键形（indexKeys 的 `tool:` 前缀；宿主字面冒号名不折叠的 P8 口径下
 *  只匹配精确三键，`tool:tool:xxx` 恒不在列）。 */
export declare const RECALL_TOOL_KEYS: readonly string[];
/** 召回面对识别谓词：R 贴标的 tool 字段 = issuer tool/call 注册名（factor-atoms tagRsFromLog）。 */
export declare function isRecallTool(toolName: string): boolean;
/** 查询标签是否点名 tool: 召回族键——点名 ⇒ 副本可见（审计查询
 *  `['document:x','tool:recall_history']` =「该文件曾被召回过什么」必须能命中副本）。 */
export declare function namesRecallFamilyKey(labels: Iterable<string>): boolean;
