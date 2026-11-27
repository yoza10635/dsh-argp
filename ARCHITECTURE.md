# ARCHITECTURE — dsh-argp 2.0 实现说明

> 本文档讲**怎么实现的**。能干什么、凭什么选它见 [README.md](README.md)。
> 读者：想读懂/二次开发本插件的人，不需要读完整设计史。
> 1.x 的 stage-2 图引擎/三管线实现已退役（冻结在 npm `1.11.2`，tag `v1.11.2`），
> 本文只描述 2.0 现存代码。

## 1. 一句话架构

因子引擎把对话拆成**原子**（U/A/R/X 四类 surface 事件）。压缩时**只剪 R**（工具结果）：
按实体标签与过期判据判定、排队 → `prune-tx` 事务逐区间成对发射 `compaction/prune` + `replace`
（最小桩）→ 散文浓缩（唯一 LLM 通路，事务内双闸）→ 事务成功后冻结词表目录快照
（`systemPrompt.context`；无该服务时以词表 note 回退）。**剪枝决策 0 LLM**；
被剪原文留在 append-only 日志，`recall_history(label)` 按字节取回；已离场散文（含浓缩原文）由 `search_history(keyword=...)` 按内容逐字取回。

```
对话事件流（append-only 日志）
      │
      ▼
┌──────────────────────────────────────────────────────────┐
│ 触发（pre-step / 手动 / 400）                              │
│  §9.37 出口闸（缺省关，env=1 开）                           │
│  §9.36 浓缩闸二（ctx 线）                                   │
└──────────────────────────────────────────────────────────┘
      │ compactIfNeeded / compactNow
      ▼
┌──────────────────────────────────────────────────────────┐
│ FactorEngine（0 LLM）                                     │
│  atomize → R 贴标判定 → plan（焦点/sticky/过期/宽度）       │
│  → prune-tx：start → summary → 逐区间 prune+replace → end │
└──────────────────────────────────────────────────────────┘
      │ 事务内（可选）
      ▼
┌──────────────────────────────────────────────────────────┐
│ ProseCondenser（唯一 LLM 摘要通路）                        │
│  闸一：散文占比 ≥ 50% 声明窗                                │
│  one-shot 原生式摘要；barrier/受保护跨度不动；空输出保原文    │
└──────────────────────────────────────────────────────────┘
      │
      ▼
  recall_history / list_labels（标签地址，日志原文，字符预算）
  search_history（内容子串发现：被剪 R ∪ 散文，分层预览 → hit 第二跳，同字符预算）
```

## 2. 原子模型与剪枝面

| 原子 | 含义 | 来源 | 可剪？ |
|---|---|---|---|
| **U** | user 输入 | 原生 user 事件 | 否（焦点/轮次保护；U-info 副本按 R 待遇是 1.x 口径，2.0 不产生） |
| **A** | assistant 回复（tool-call 块内嵌） | 原生 assistant 事件 | 否（散文归浓缩链） |
| **R** | tool result | 原生 toolResult 事件 | **是**（唯一剪枝面） |
| **X** | 墓碑/checkpoint/plugin 注入 | plugin-source 事件 | 否 |

标签（`factor/tag-extract.ts` + `tag-canonical.ts`）：`document:<canonical path>`（read/edit/write）、
`command:<family>`（bash/pwsh 命令族）、`errorcode:<CODE>`（ALL_CAPS + 错误信号）、
`scope:<dir>`（grep/glob 的搜索根）。**出口 fail-closed**：词表只渲染当前文法认得的键，
被拒收的键留索引不进 prompt（`list_labels` 可查拒收数）。

过期判据（`factor/retention-score.ts` + `factor-atoms.ts`）：焦点轮（最新 N 轮）、
sticky（近窗反复出现的标签）、superseded（同路径更新的读）、版本链、可再生成性
（读后文件未变 = 可重新读回）、锁定记忆。排序输出 `PrunePlan`；`plan.clipOrder` 是
C10 夹剪层的归位段（env 开）。

焦点保护形态（2.2.1 包二归一，`planFocusTail` 单机制两态）：**非升级态**按**名额**保护——
名额 = min(20 组, ⌊δ·W_eff·cpt / 组均字节⌋)，δ=0.3、下限 1，窗未知（manual/legacy 调用面）
回退 20；超出名额的旧侧组只有**全组 defined R 均被 superseded 判死**才整组降级进组剪
（事实门在 `decide`，发射端 `planProtocolGroups` 对降级组仅放宽 turn/位置两道位置门，
missing/live R/附件/连续性事实门不放宽）——barrier/附件组豁免不占名额也永不降级，open 区组
不入降级带。**升级态**（最新轮 A/R 占比 ≥50% ∧ 组 >10）维持原 cap=10 无事实离场语义。
降级账目走 `[argp-quota]` 影子列日志行（quotaUsed/quotaBandGroups/demotedGroups/evicted*），
是 §B-2b 观察哨「降级档驱逐」信号的落点。

## 3. 压缩事务（prune-tx）

宿主 `token-meter/surface-projection.ts foldSurfaceProjection` 要求：**每次
`compaction/prune` 的 `shadowedRange` 必须与紧随其后的 surface `replace` 范围严格相等**，
否则 resume 投影 throw。

实现口径：

- `pruneIntervals` **逐区间成对发射**（对齐官方 `compaction-tool-result-pruner`），
  一笔事务可含多个区间；
- **零 `tool/result` 形态桩（2.2.2 根修，session-43df801e 存档加载失败案）**：surface
  `replace` **只发 user/message 检查点**——`prune-tx` 的 tombstone 类型收窄为
  `{type:'user'}`，tool/developer 形态整类删除（运行时另有防线：收到非 user 墓碑在事务前
  throw）。动机：宿主 v4 fold 要求「非 append 的 tool/result 必须处于开放轮内」
  （`requireTurn`）、system/developer/assistant replace 还要求开放轮 + step 坐标匹配
  （`requireStep`），而压缩事务可落在轮间隙（手动 /compact 走宿主 idle maintenance，
  实证 `compaction/start.data.turn === null`）；写入侧 `Session.append` 只校验
  content-only、**不校验轮** ⇒ 当场成功、下次加载整档判 corrupt 拒载。
  user 检查点不受轮/步约束，是唯一与压缩时点无关的合法形态；
- **打包带走裁定**：半拆组（issuer A 在世只剪 R）与不连续回退一律不剪——组不齐 ⇒ R 随
  活体保留（缺口进 shortfall 账）；孤儿 R（issuer 已离场）走 user 检查点。组剪按
  `[A … 最后一个 R]` 的**整区间**替换成**单条** user 检查点（A+R 同进退，无孤儿 tool_call）；
- **C10 夹剪改走检查点文本**：旧夹剪臂直接改写原 R 节点（非 append tool/result replace，
  轮间隙无合法表达）→ 根修后 clip 只决定组检查点的**文本**（头尾留真预览 vs 中性标记），
  组选择/保护/守卫与 clip 关闭时相同（A/B 变量只剩检查点文本），轮内/轮间隙行为一致；
- **写入侧落点守卫**（残余非 user replace 的兜底，如 cites 剥离的 assistant replace）：
  `log-access.canAppendSurfaceReplace` 在 **append 前一刻**读日志尾状态，逐条复刻宿主
  fold 判据（user 恒合法；tool/result 需开放轮；step 型需轮+开放 step 且 `data.turn/step`
  匹配），非法时调用方放弃写回而不是污染存档。与"计划时判轮"不同，落点判据不会出现
  「计划有轮、落点无轮」的分叉；
- 锁：`prune-tx-order ⑥`（非 user 墓碑 fail-fast）、`prune-tx-order ⑦`
  （轮间隙 user 事务零 tool/result replace）、`factor-clip CL4/CL10`（整组离场/轮间隙）、
  `surface-fold-legality`（**直接 import 宿主 `assertReleasedV4Relationships` 当 oracle**：
  轮内/轮间隙正向日志必须被宿主接受，轮间隙手工补一枚 tool/result replace 必须被宿主
  拒载——阴性对照自证判据有判别力）；
- 事务尾把 usage 锚重置为 chars 估算（`lastRealPromptTokens = visibleChars/charsPerToken`），
  下一笔成功请求由 provider usage 重锚；
- `shadowedSeqsOf` 只认 `compaction/prune.shadowedSeqs`——权威账本，不从 replace 形态推断
  （cites 剥离写回、单节点 replace 不得被误当"已剪"）；
- 召回字符预算 `recallCharsUsed` 在事务成功时归零。

### 3.1 账本三本分治（同一事务三条影子口径，别混账看）

一笔压缩事务在日志里落三条互不相等的影子记录，各有单一权威读者：

| 记录 | 语义 | 权威读者 |
| --- | --- | --- |
| `compaction/prune[].shadowedSeqs` | **权威账本**：逐区间成对、恰=该区间被剪节点并集 | 召回面（`shadowedSeqsOf`）、剪并集审计 |
| `compaction/summary.shadowedSeqs` | **发射时点 span claim**：整个事务跨度 `[first..last]` 在当时的切片——含跨度内未剪活体 | 宿主 fold（净释放计价），**不是**召回依据 |
| `stateOf(session).records[].shadowedSeqs` | **引擎视图**：本进程事务的 `allSeqs`（诚实并集） | WebUI/遥测面板 |

实锤案例（session-43df801e，2026-11-26 审计）：summary=343 vs prune 并集=260，
"超声称" 83 = 跨度 [20..1113] 内的 33 U + 2 D（活体轮边界/系统注入）+ 28 A + 20 R
（后续事务才剪）。这是宿主 `span()` 相邻性契约的要求（§3 开头 fold 规则），不是账错；
外评把它读成"账本污染"即三本混账之误。审计口径：**剪没剪只查 prune**。

**token 计价的第四条口径（2026-11-27）：`shadowedTokenCount` ≠ 压缩收益。** 该字段 = 被替换
在场节点文本 ÷ 4（宿主 `dsh-token-meter` 的记账口径，必须保持），描述"本次从 surface 拿掉多少字"；
而节点经 `sourceEventSeqs` 链代表的历史体量由 `src/factor/history-estimate.ts` 单独估算（CJK 自适应
3.5/1.7），只进日志与摘要文案。两者在 §11.8 归并上分离极大（145 桩 = 339 tok，代表历史 475 条 /
82.5 万字符 ⇒ ≈ 30 万 tok）：只报前者会被读成"压缩收益 300 tok"。日志统一措辞：
`surface 释放 ≈ X tok；历史体量 ≈ Y tok（Z 字符 / N 条原始事件，估算）`。

### 3.2 桩游程治理（2.2.2，session-43df801e 病灶）

factor 组剪逐组落压缩检查点桩（`user/message` + `source.kind=compact-checkpoint`）；
114 组扫荡曾在表面产出 **96 连排同 9 字桩**——角色交替破坏（模型读到"用户连说 96 遍
同一句话"）。且桩常规通道双盲不可回收：atomize 判 X 类（永不进 A+R 剪枝面）+ prose
三桶按 own-kind 排除 + §11.8 图臂归并通道已退役。治理两层，同一判据（surface 位置
紧邻 + 墓碑文本逐字节相同）：

1. **事务内并条**（`pruneIntervals` 归并 pass）：同笔事务的相邻同文 user 墓碑区间
   传递合并，一条 prune+replace 对吃掉整段 ⇒ 新游程不再产生。交互桩文本含各自
   `recall_history(keys)` 指针 ⇒ 异文自然不并；tool/developer 结构桩类型门豁免。
2. **跨事务随剪回收**（`FactorEngine.reclaimStubRuns`）：主事务落地后扫表面 ≥
   `FACTOR_STUB_RUN_MIN`(=2) 的同文桩游程，顺带发一笔 `tombstone-merge` 事务每条并一。
   **绝不独立发维护事务**（surface 换代税只在主事务交一次；无事务则回收器静默）；
   异常只记日志不伤主事务。归并结果游程塌缩为 1 ⇒ 收敛不复发。

零桩不是 API 可达形态：shadow-price 契约要求每个被剪区间留一枚原位节点，聚合到
"一段游程一枚桩"即上限。1.x 旋钮 `tombstoneMergeMinRun` 已随 2.0 零旋钮退役，不复活。
锁面：prune-tx-order ④⑤⑥（事务内）+ stub-run-reclaim RR1–RR3（随剪/不独立/纪律门）。

### 3.3 出处语义（2.2.3：证据被剪 ≠ 结论改判）

剪枝只删工具结果，助手结论以散文留在面上；散文浓缩（唯一 LLM 通路）再把散文压成
检查点。于是出现一种**非幻觉的失真**：结论可能仍然正确，但支撑它的工具证据已不可见，
模型看到的是一条**高置信、无出处**的断言——不是"记错了"，是"记得却不知道凭什么"。

契约分两侧，都是**文本约定**（不改存储、不新增召回面）：

1. **写侧**（摘要指令，三句话）：① 承重结论要说出来源（工具输出 / 用户原话 / 自己的推断），
   判不清就如实说，**不许编来源**；② 支撑证据可能已被压走——**它既不确认也不反驳结论**，
   不得据此把结论写得更确定或更不确定，要给读者指召回而不是替他猜；③ 纠正双边可见
   （`X (was corrected by Y)`，不删被纠正项），未决项写明"什么观察能定案"，猜测不得冒充决定。
2. **读侧**（检查点框架语 + 词表引导）：`CHECKPOINT_PREAMBLE` 与宿主基线**故意分叉**——原句
   "Treat the captured context as established background" 单独存在等于把整份摘要升级为
   既定事实；现改为"仅作连续性背景"，并补一句"证据可能已被压走 ⇒ 既不确认也不反驳，
   别改确定性，要证据就召回"。词表引导（`systemPrompt.context` 快照，压缩事务后才出现）
   同理一条 **Elision is not a verdict**。

**刻意不做的标记体系（2026-11-27 二次裁定）**：一度引入
`[observed] / [user] / [inferred] / [observed, evidence elided] / [provenance unknown]`
五态标注，已撤销。理由：摘要发生在剪枝**之后**，摘要器看不到原始证据，标记只能靠它
自述——**标错比不标更有害**（读者会把它当出处权威）；且每份检查点常驻 ~65 token、
每次摘要 ~250 token。改为"把行为讲清"的一句话，不承诺任何逐条出处。`[conflicting]`
与"保留纠正"两件事改为自然语言要求（不依赖记号）。锁 `test/provenance-contract.test.ts`
五例，其中一条**反向锁**：写侧/读侧重新出现上述标记即红。

边界如实记录：这一层只影响**文本怎么写、怎么读**，不能保证结论为真，也不能恢复被剪
证据本身（那要 `recall_history` / `search_history`），更无法阻止模型自行重做一遍——
只能让"证据不见了"不再被当成"结论不可信/已核实"的理由。

**不做的事（2026-11-27 裁定，避免重复设计）**：不给召回结果加 `newer:` 新旧指针。
取证路径已经闭合——`recall_history(labels, view:'outline')` 逐行列出**同一标签的全部
版本**（`item=<seq> · turn=<n>`），且 `order:"fresh"` 直接按新到旧排序；更晚的同类
观察若仍 live，本来就在模型可见面上。插件的职责是给坐标，不是替模型判断"这版过期了"
（那是语义判断，且会诱导它连结论一起改判）。配套删掉 `PrunedNodeInfo.latestOfPath`
——1.x 版本链残留的死字段，注释许诺了一个从未实现的行为。

## 4. 触发与两道闸

### 4.1 两条确定性信号

1. **手动 `/compact`**（宿主 `command-compact` → `compactNow`）：全量剪 + 散文浓缩；
   **摘要调用走宿主同款装配**（`form:'host'`，2026-11-27 实测修正：旧 A 形态重建
   `U:/A:` transcript，无 system 头、正文带行内角色标记 ⇒ 与主对话热前缀从第 0 个
   token 就不同，118K prompt 全量未命中 / 33.3s；改 host 形态后 116,736/118,135 命中、
   14.0s）。`form` 与 `approved` 正交：手动只换输入形态，不继承分派器的闸一豁免。
2. **provider 400 `CONTEXT_WINDOW_EXCEEDED`**：`compactIfNeeded('context-overflow')`
   强制剪一次后重试（`maxOverflowRetries` 缺省 1）。

pre-step 的**估算驱动压力剪**已退役（`ARGP_FACTOR_PRESSURE=1` 仅旧世界对照臂）。

### 4.2 §9.37 出口闸（缺省关；设置「压缩阈值」或 env=1 开）

缺省关（2026-11-15 用户裁定：46 轮实测对照臂形态即缺省形态——贴墙由 400 兜底网 +
§9.36 闸二浓缩接管，上下文贴线优先于预检防线的提前回落）。**开启面与线形**
（`resolveEgress`，每次 pre-step 实时解析——设置页改动免重挂生效）：

- 设置「压缩阈值」`compactionThreshold > 0` → 线 = 声明窗 × 比例（阈值语义，用户自设）；
- env `ARGP_FACTOR_EGRESS=1`（无设置）→ 线 = 旧公式（窗 − 输出预算三源 max − 2%）；
- env `=0` → 硬关（对照臂覆盖设置）；都没有 → 关（撞墙 400 兜底）。

开启后位置：pre-step（上一请求 usage 已锚、下一请求未发）。确定性算术（两线形按
`resolveEgress` 分叉）：

```
projected = anchored usage + 本步 incoming 估值（chars/charsPerToken）
线形 A（设置「压缩阈值」）: line = round(声明窗 × compactionThreshold)
线形 B（env=1 旧公式）:     line = 声明窗 − 输出预算 − round(声明窗 × 0.02)
projected ≥ line  ⇒  不发请求，先 compactIfNeeded('pressure')
```

- **只认 anchored**：断锚（回退 chars/tokenMeter）不驱动破坏性改写；
- **声明窗来源**：活 `request/context` 事件 → 冷 resume 时反向扫日志回填
  （`restoreDeclaredWindow`）→ 再兜底 `session.requestContext()`；全无 ⇒ 不拦（交 400 网）；
- **输出预算三源取 max**（仅线形 B）：①`agent.options.maxTokens`（宿主 buildRequest 同源）
  ②`requestMaxTokens`（`agent/request` 瀑布观测）③`llm.resolveModelInfo().defaultMaxTokens`
  （请求缺 mct 时 llm 在瀑布**之后**注入，②对它失明）；全缺退 `0.25×窗`；
- **互斥**：`ARGP_FACTOR_PRESSURE=1` 时本闸不挂（两 env 各管一个对照世界，不叠乘）；
- **事务内闸二补检**：出口闸的线可低至比例线（任意 >0，用户自设）或 ≈0.73×窗（旧公式），
  `compactIfNeeded('pressure')` 里 `measurement.contextTokens >= windowTokens` 必须再过一次
  才允许调用散文浓缩（LLM 链不得被自动通路提前触达）；
- **两线叠合**（与 §4.3）：阈值比例 >0.8 时 0.8×窗的散文浓缩线先动作，阈值线在其上追加
  R 剪；比例 <0.8 时阈值段内只有 0-LLM R 剪（散文浓缩仍等 0.8×窗线）。

### 4.3 §9.36 浓缩闸二（ctx 线）

pre-step 位：`source==='anchored'` 且 `contextTokens ≥ windowRatio×声明窗` ⇒ 驱一发
清扫式浓缩（闸一在 `prose-condenser` 内：散文占比 ≥50%）。手动 `compactNow` 免闸二。

## 5. 召回面

| 工具 | 输入 | 数据源 |
|---|---|---|
| `recall_history` | `labels[]`（交集）+ `limit` + `cursor/epoch` + `item/offset` | `rawEventText` 取日志 append 根源原文；桩不冒充。被剪的召回工具自身结果缺省不进查询与词表统计，labels 点名 `tool:` 召回族标签时返回（2026-11-23 召回副本可见性裁决；`item=` 直钻不受限——句柄只来自先前 surfacing） |
| `list_labels` | `category`（document/command/errorcode；scope 按需 `category:'scope'`）+ `limit` | 被剪账本的词表（键 × 覆盖数 × 最后出现轮） |
| `search_history` | `keyword`（内容子串 2-100，必填）+ `labels[]`（可选 AND，仅工具带）+ `limit` + `hit`（第二跳） | 被剪 R 原文 ∪ user/assistant 散文原文（仅 text 块、kind 主防线排注入/宿主 boilerplate、replace 副本排除）；N>250 走标签分布直方图逼细化。被剪的召回工具自身结果缺省不进工具带与词表统计，labels 点名 `tool:` 召回族标签时返回（与 queryPruned 同收口） |

- 查询宽容：裸标签按四 facet 展开试匹配；未命中标签**如实回显**（不静默剔除）；
- 分页：`cursor/epoch` 续读，epoch 漂移显式告警（不假装稳定分页）；
- 预算：单次 5% / 累计 10% 窗口，耗尽/截断都带余额说明；
- 防循环：每轮 20 次调用上限（安全阀，非内容限制）；
- 模型侧引导：2.2.3 起动态目录走 **`systemPrompt.context` 会话快照**（`argp:vocabulary`，
  runtime context；模型每轮可见），压缩事务成功收尾时冻结，`step()` 的
  `refreshContext` 在本次请求即可读到新目录。快照只跟事务刷新，provider 不读 live
  ledger；两次事务之间字节稳定。宿主无 `systemPrompt` 服务时退回旧的词表 note
  （`VOCAB_NOTE_GUIDE`，首次压缩事务后 steer/replace）。引导含 command+scope 双逃生通道
  （document 未中时：shell 读入内容只挂 command 族标签、目录级触达只有 scope 地址；
  2026-11-15 真实端点野测双实锤——P45 补召回经 `command:$a=Get-Content` 族标签收回 3 题）。

## 6. 读侧兼容（不可删）

- 老墓碑文法 v1.3.x–v1.7.x（`tombstone-text.ts`）——resume 老会话时识别；
- 老 `data.argpCites` 忽略读（`atomize` 归一化三种历史形状）；
- `prune-tx` 的 tool/result 克隆/配对契约；
- 旧 `compaction/end.catalogText` 字段不再读取（图臂的 catalog 已退役）。

## 7. 宿主兼容与边界

### 7.1 事件日志读取（`sessionEvents`）

ARGP 需要读会话事件日志，但宿主 API 在 dsh 版本间有 breaking 变化：

| 宿主版本 | 事件日志 API |
|---|---|
| rc.2（0.1.1） | `session.events`（getter，返回全日志数组） |
| alpha.4（0.1.2+）～0.1.3 | `session.snapshotEvents(from?, toExcl?)`（`events` getter 已移除） |
| **0.1.5+（当前支持基线 0.2.x）** | `snapshotEvents()`；`events` 已彻底不存在 |

`log-access.ts` 的 `sessionEvents(session)` 是**全代码库唯一允许碰事件日志的入口**。
判别集中在 `logBackendOf(session)`（`LogBackend` 接口：`snapshotEvents` 与 legacy
`events` 两个实现，按 session 弱缓存），`sessionEvents` / `eventAt` / boot 探针
`inspectLogAccess` 共用同一后端对象；需要「日志长度」的同步调用方优先用
`session.seq`（branded 类型，seq/offset 分离）。

宿主 0.2.x 已把 `eventAt` / `snapshotEvents` / `ownEvents` 标为
`@deprecated … new calls are prohibited`：ARGP 是同步引擎（`decide()` 不能 await），
只能继续沿用，迁移面收敛在 `log-access.ts`（加一个异步实现即可）。升级宿主后先跑
`node scripts/doctor.mjs --dsh <根>`——它探测宿主声明文件里同步读 API 是否仍在，
三者皆无时退出码 3。

### 7.2 `SurfaceOp` 键名（`startSeq`/`endSeq`）

ARGP 的写回全部是 `surfaceOp: { op: 'replace', startSeq, endSeq }`。0.1.5 前是
`start`/`end`——**两代都强制 `Object.keys(surfaceOp).length === 3`**，同时写两套键会被
双方拒绝。`Session.append()` 内部**同步**调用 `surfaceManager.validateNext()`，键名写错
不是"剪枝静默失效"，而是**在事务中途抛错**（start 已落盘而 tombstone 未写，事务半开）。

### 7.3 `SessionSeq` 品牌类型

内部模型（原子/区间/账目/预算）一律裸 `number`；只在写入/查询 dsh API 的边界经
`asSeq()` / `asSeqs()` 收窄（`log-access.ts`），收窄处不做运行时校验（宿主已有权威校验）。

### 7.4 node 0 系统提示保护

0.1.5 把系统提示表示为 surface node 0 的 `system/message`，宿主
`assertSystemHeadRewrite` 硬性保护该位置。`atomize` 只识别
`user/message` / `assistant/message` / `tool/result` / `developer/message`，
`system/message` **静默跳过、不产出原子** → node 0 永不进入剪枝区间。有意依赖，已由
注释与测试钉死。

### 7.5 全局预剪的归因与 open-turn 硬界（`nativePruneToolResults`）

接管下宿主 preset 的 `tool-result-pruner` 行已被本包 override 摘除 ⇒ 宿主**不再自主**
轮内预剪。同一服务（`ctx.get('toolResultPruner').pruneSession`）的唯一活调用方是
`argp-engine.ts` 的 `nativePruneToolResults`：**随压缩事务**发生（组剪之后，2026-11-14
裁定），服务缺失 / 无 open turn / 异常 ⇒ no-op 不阻断。

硬界与基线（NP10a/NP10c 钉死）：宿主格式校验拒绝 open turn 外的 tool/result replace；
而 `pruneSession` 是**全表面 oldest-first 扫描**、无焦点/年龄筛选，且对被拒替换 fail-fast
（真实包 `@throws when the session rejects a replacement; replacements committed earlier
in the pass remain durable`）。因此 surface 上只要残留一枚组剪当笔没赶走的**老轮 >8192 R**，
本笔预剪整 pass 中止——open 轮超限 R（扫描序在后）连带漏剪，被拒节点留下一枚孤儿
`compaction/prune`（shadow-price 协议先落盘、正文 replace 被拒）——孤儿不落组剪事务区间账，
只给在位原 R 定价（疤痕入档）。老超限面的常态归宿是组剪兜底：随组赶旧整组离场。
台架 testkit Session 不执行该校验，假 pruner 以 `rejectOutsideOpenTurn` 开关按上述真实
语义模拟宿主拒绝。

## 8. 模块职责表（2.0）

| 文件 | 职责 | 依赖 |
|---|---|---|
| `argp-engine.ts` | 组合根：构造装配、pre-step 三通道、溢出恢复、手动压缩、/argp 注册；持有宿主面字段 | 全部下方模块 |
| `session-lifecycle.ts` | normalizeConfig / registerSettings / bindSession / rebuildLedgerFromLog；设置 schema | argp-types, log-access, atomize, telemetry, constants, budget, prune-tx |
| `session-state.ts` | 会话运行时状态（WeakMap 分桶）：台账/剪枝索引/召回预算/usage 锚点/账本重建去重；A5 起 `shadowedSet` 为位图、`prunedNodeIndex` 明细有上限（`notePrunedNode`） | constants, seq-bitset, argp-types(type), atomize(type), prune-tx(type), log-access(type) |
| `factor/engine.ts` | 因子引擎：贴标 → 排序 → `PrunePlan` → prune-tx 成对发射；账本/词表快照/note 回退 | log-access, constants, prune-tx, factor-atoms, factor-ledger, retention-score, tag-extract, clip-shape |
| `factor/prose-condenser.ts` | 散文浓缩：闸一、span 选择、LLM 调用、清扫式 replace | prune-tx, llm/llm-adapter |
| `factor/recall-labels.ts` | `recall_history` / `list_labels` defineTool + 会话解析/防循环阀/`resolveQueryLabels` 单点 | log-access, telemetry, factor-ledger, factor/engine |
| `factor/search-history.ts` | `search_history` defineTool：内容发现（被剪 R ∪ 散文）+ 分层预览 + 临时索引单槽 + 分布直方图 | log-access, budget, cjk, prose-scan, recall-labels, recall-tools, factor/engine |
| `factor/recall-tools.ts` | 召回面工具名单单一事实源（P6-③ 裁定 2 剪枝识别 + 召回副本可见性裁决谓词，叶子模块） | — |
| `factor/prose-scan.ts` | 散文扫描带纯函数面：仅 text 块投影 + kind/replace 谓词 + 从旧到新 cap | llm/types |
| `factor/factor-ledger.ts` | 被剪账本：索引/epoch/`queryPruned`/`vocabularyRows`/`renderVocabulary`；查询层统一裁决召回副本可见性；A5 起观察去重为位图、sticky 轨道有上限 | tag-canonical, recall-tools, constants, seq-bitset |
| `factor/factor-atoms.ts` | R 原子投影：标签、焦点、sticky、cites/命令/路径抽取辅助 | tag-extract, tag-canonical |
| `factor/retention-score.ts` | 保留打分与 `planPrune`（焦点带/sticky/过期/宽度熔断/夹剪归位） | factor/types, factor-atoms |
| `factor/tag-extract.ts` | 工具参数/输出 → 实体标签（四 facet） | tag-canonical |
| `factor/clip-shape.ts` | C10 夹剪层语义（三态保留与文本形） | — |
| `atomize.ts` | `atomize` / `extractCites` / `classifyUserMessage` / `looksAskText` | argp-types, log-access, cites-strip, llm/types |
| `budget.ts` | `visibleChars` / `resolveScaledBudgets` / `measureTokens` / `scaleBudgets` / `acquireTokenMeter` | constants, log-access |
| `recall.ts` | `shadowedSeqsOf`（权威账本；A5 起位图存储）+ `budgetRecallText`（字符预算） | log-access, session-state(type), seq-bitset |
| `prune-tx.ts` | 事务骨架：`pruneIntervals` / `consolidateTombstones` / 手动区间函数 / `buildTombstoneRedirect` | argp-types, log-access, atomize |
| `tombstone-text.ts` | 墓碑**读侧**识别（`isFactorTombstoneText` / `isMergeableTombstoneText`；不生成文案） | — |
| `cites-strip.ts` | cites 尾块匹配/剥离（残差清扫；纯函数，零依赖） | — |
| `llm/llm-adapter.ts` | LLM 调用后端：`dsh-llm` `LlmRuntime.stream()` 唯一生产路径（finish 分流）；`serializeWireMessages` 仅测试探针 | dsh-llm |
| `llm/types.ts` | 来源判定叶子（ARG_NS / isArgpUserInfo / isOwnSourceKind） | — |
| `seq-bitset.ts` | seq 去重位图（A5：1 bit/seq，替代 `Set<number>`；不截断） | — |
| `argp-types.ts` | Atom / AtomType / ArgpUserSettings（叶子） | cites-strip(type-only) |
| `log-access.ts` | 事件日志唯一入口 + 日志原语（eventText / rawEventText / turnOf / detectOpenTurn） | dsh-session, llm/types |
| `constants.ts` / `telemetry.ts` / `ui-locale.ts` | 常量 / 有界缓冲 / 服务端多语言 | — |
| `cache-audit.ts` | 每请求缓存审计：usage 三分量→命中率，压缩后首请求/续作分类（纯观测，零决策） | — |
| `preset-cleaner.ts` | preset 净化器（override-only；build 脚本烘焙进 `cordis.patch.yml`） | —（纯文本函数） |
| `argp-command.ts` | `/argp` 只读状态命令 | budget, log-access, ui-locale, cache-audit |
| `client/*` | 聊天渲染的 cites 尾清扫 + 设置卡（2.0.1 单旋钮「压缩阈值」；configForms 0.1.7+ 契约） | cites-strip |

## 9. 关键不变式清单

1. **剪枝决策 0 LLM**：FactorEngine 全链确定性；LLM 只在散文浓缩里出现。
2. **只剪 R**：A/U/X 永不入剪枝区间（A 归浓缩链，U 受焦点/轮次保护，X 是墓碑）。
3. **append-only**：原始事件永不改写，只加新事件；被剪 = surface 上不可见 + shadowedRange 标记。
4. **shadowedRange === surface replace 范围**（逐区间成对）。
5. **cites 剥离写回 ≠ 被剪节点**（不收进 shadowedSeqs）。
6. **sessionEvents 是唯一事件日志入口**：不直接碰 `session.events` / `session.snapshotEvents`。
7. **lib/ 与 src/ 一致**：改 src 必须 build 提交 lib（构建先清空 lib，防陈旧产物）。
8. **召回原文来自日志 append 根源**：桩/摘要不冒充原文；预算与未命中都显式。

## 10. 代码质量预算（软性指引，非门控）

**新代码**应满足下表预算；**存量超标**函数允许存在，但**修改它时应顺手降低复杂度**（棘轮原则：只紧不松）。本表不进 CI，作为 review 时的参考基线。

| 指标（单函数） | 预算 | 指标（单文件） | 预算 |
|---|---|---|---|
| 圈复杂度 | ≤ 10 | 代码行数 | ≤ 800 |
| 认知复杂度 | ≤ 15 | 代码重复率 | ≤ 5% |
| 嵌套深度 | ≤ 4 | 参数数量 | ≤ 5 |
| 函数长度 | ≤ 80 行 | | |

### 2026-11-14 快照（2.0 清洁批：死代码/manual-range 族/历史注释清除后）

度量工具同前（`scripts/analysis-extract.mjs` + `analysis-metrics.mjs`，TS 编译器 API）。
口径：圈/认知 = 文件内全部函数**求和**；嵌套/单函数行 = 文件内**峰值**。"代码行"不含空行
与纯注释。src 34 文件 / 280 函数；圈 >50 的函数 10 个、认知 >60 的 14 个、嵌套 >6 的 8 个。

| 文件 | 函数 | 圈(Σ) | 认知(Σ) | 嵌套(max) | 单函数行(max) | 代码行/总行 |
|---|---:|---:|---:|---:|---:|---|
| `src/factor/engine.ts` | 26 | **329** | **709** | 5 | **221** | 743/1025 |
| `src/factor/recall-labels.ts` | 5 | **89** | **224** | 5 | **285** | 293/389 |
| `src/prune-tx.ts` | 5 | 85 | 164 | 5 | **340** | 316/470 |
| `src/argp-engine.ts` | 47 | **237** | 388 | 5 | **237** | 691/1165 |
| `src/atomize.ts` | 4 | 31 | 114 | **7** | 84 | 107/187 |
| `src/factor/prose-condenser.ts` | 16 | 45 | 102 | 5 | 113 | 410/577 |
| `src/session-lifecycle.ts` | 7 | 37 | 86 | 6 | 115 | 219/365 |
| `src/preset-cleaner.ts` | 5 | 21 | 81 | **7** | 65 | 186/311 |
| `src/factor/tag-extract.ts` | 8 | 33 | 76 | 6 | 93 | 166/221 |
| `src/factor/factor-ledger.ts` | 19 | 21 | 58 | **7** | 68 | 321/460 |
| `src/log-access.ts` | 14 | 20 | 54 | **7** | 38 | 172/325 |
| `src/llm/llm-adapter.ts` | 5 | 20 | 51 | 5 | 70 | 161/274 |
| `src/argp-command.ts` | 26 | 30 | 45 | 3 | 68 | 148/249 |
| 其余 21 个 src 文件 | — | ≤19 | ≤43 | ≤7 | ≤147 | 最大 543（config-controller），均 ≤ 365 |

**读法（诚实记录）**：

- 复杂度集中在四处，全部是**变异锁覆盖的核心算法/事务骨架**：`factor/engine.ts`
  （decide 193 行 / compactIfNeeded 136 行 / planProtocolGroups 100 行——决策与双闸编排）、
  `prune-tx.pruneIntervals`（340 行——带 `ended` 状态机的事务骨架，start/summary/逐区间
  replace/end + 事务后不变量审计 + 错误路径不可双 end）、`recall-labels` 的 recall_history
  装配（285 行——召回面四不变量）、`argp-engine` 组合根（47 函数挂载全部宿主钩子）。
- **不做表演性拆分**：这三个大函数各自是一个凝聚事务/决策核，拆分收益（行数）远小于风险
  （15+ 变异锁回归、错误路径状态机断裂）。`argp-engine.ts` 的体量是组合根设计
  （"引擎是唯一组合根，向下单向依赖"）的直接结果，非意外膨胀。
- 清洁批（2026-11-14）移除：13 个零引用导出、手动区间族（compactRegion/compactRegions/
  selectManualRanges/consolidateTombstones/ManualRangeHost，≈200 行死路径）、log-access 的
  1.x 日志视图族（≈140 行）、17 处迁移史注释；src 净 −~500 行，圈 >50 函数持平。

## 11. 评测与调试开关（构造期快照为主；`ARGP_FACTOR_EGRESS` 例外=pre-step 实时读）

2.0.1 起设置页**唯一旋钮** = 「压缩阈值」（`compactionThreshold`，volatile 免重挂；
语义见 §4.2）；2.0.0 退役的六枚中其余五枚保持退役，缺省值固化在 `constants.ts`；
老 profile 同名键宽容透传 + 告警。本节仅列评测/调试用环境变量，普通使用不需要碰。
环境变量除 `ARGP_FACTOR_EGRESS` 外均在插件构造期读取，改了要重挂会话；
`ARGP_FACTOR_EGRESS` 自 2.0.1 起改为**每次 pre-step 实时读**（与设置「压缩阈值」合流解析，
优先级 = env=0 硬关 > 设置比例线 > env=1 旧公式线 > 关，见 §4.2）。**bench 注意**：env=1
的评测/对照臂会被用户 settings 里残留的 `compactionThreshold` 静默改吃比例线——跑 env=1 臂
前须确认用户层未设该键（或用 env=0 臂）。

| 变量 | 作用 |
|---|---|
| `ARGP_FACTOR_EGRESS=1` | 开出口闸/超窗预检（缺省关=对照臂形态：贴墙交 400 兜底网 + 闸二浓缩；开闸 = 严格 admission 端点的 pre-send 防线，结构效应 = 上下文天花板 192K vs 305K） |
| `ARGP_FACTOR_PRESSURE=1` | 恢复旧 pre-step 估算驱动压力剪（旧世界复现；与出口闸互斥） |
| `ARGP_FACTOR_TIER=tiered` | 焦点分级策略档（hard/medium 焦点带；缺省 flat） |
| `ARGP_FACTOR_CLIP=1` | C10 夹剪层（三态保留；缺省关） |
| `ARGP_PERATOM_A2_DEBUG=<dir>` | LLM wire 落盘（默认脱敏；`_FULL=1` 才含正文） |
