# ARCHITECTURE — dsh-argp 2.0 实现说明

> 本文档讲**怎么实现的**。能干什么、凭什么选它见 [README.md](README.md)。
> 读者：想读懂/二次开发本插件的人，不需要读完整设计史。
> 1.x 的 stage-2 图引擎/三管线实现已退役（冻结在 npm `1.11.2`，tag `v1.11.2`），
> 本文只描述 2.0 现存代码。

## 1. 一句话架构

因子引擎把对话拆成**原子**（U/A/R/X 四类 surface 事件）。压缩时**只剪 R**（工具结果）：
按实体标签与过期判据打分 → `prune-tx` 事务逐区间成对发射 `compaction/prune` + `replace`
（最小桩）→ 散文浓缩（唯一 LLM 通路，事务内双闸）→ 词表 note 收尾。**剪枝决策 0 LLM**；
被剪原文留在 append-only 日志，`recall_history(label)` 按字节取回。

```
对话事件流（append-only 日志）
      │
      ▼
┌──────────────────────────────────────────────────────────┐
│ 触发（pre-step / 手动 / 400）                              │
│  §9.37 出口闸（anchored 容量算术）                          │
│  §9.36 浓缩闸二（ctx 线）                                   │
└──────────────────────────────────────────────────────────┘
      │ compactIfNeeded / compactNow
      ▼
┌──────────────────────────────────────────────────────────┐
│ FactorEngine（0 LLM）                                     │
│  atomize → R 贴标打分 → plan（焦点/sticky/过期/宽度）       │
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

## 3. 压缩事务（prune-tx）

宿主 `token-meter/surface-projection.ts foldSurfaceProjection` 要求：**每次
`compaction/prune` 的 `shadowedRange` 必须与紧随其后的 surface `replace` 范围严格相等**，
否则 resume 投影 throw。

实现口径：

- `pruneIntervals` **逐区间成对发射**（对齐官方 `compaction-tool-result-pruner`），
  一笔事务可含多个区间；
- tool 桩**克隆原 R 的 data、只改内文**（保留 callId / role / id / isError），
  配对 issuer A 的 tool_calls 防 400（`assertToolResultRewrite` 只允许改 inner text）；
- 事务尾把 usage 锚重置为 chars 估算（`lastRealPromptTokens = visibleChars/charsPerToken`），
  下一笔成功请求由 provider usage 重锚；
- `shadowedSeqsOf` 只认 `compaction/prune.shadowedSeqs`——权威账本，不从 replace 形态推断
  （cites 剥离写回、单节点 replace 不得被误当"已剪"）；
- 召回字符预算 `recallCharsUsed` 在事务成功时归零。

## 4. 触发与两道闸

### 4.1 两条确定性信号

1. **手动 `/compact`**（宿主 `command-compact` → `compactNow`）：全量剪 + 散文浓缩；
2. **provider 400 `CONTEXT_WINDOW_EXCEEDED`**：`compactIfNeeded('context-overflow')`
   强制剪一次后重试（`maxOverflowRetries` 缺省 1）。

pre-step 的**估算驱动压力剪**已退役（`ARGP_FACTOR_PRESSURE=1` 仅旧世界对照臂）。

### 4.2 §9.37 出口闸（缺省开）

位置：pre-step（上一请求 usage 已锚、下一请求未发）。确定性算术：

```
projected = anchored usage + 本步 incoming 估值（chars/charsPerToken）
line      = 声明窗 − 输出预算 − round(声明窗 × 0.02)
projected ≥ line  ⇒  不发请求，先 compactIfNeeded('pressure')
```

- **只认 anchored**：断锚（回退 chars/tokenMeter）不驱动破坏性改写；
- **声明窗来源**：活 `request/context` 事件 → 冷 resume 时反向扫日志回填
  （`restoreDeclaredWindow`）→ 再兜底 `session.requestContext()`；全无 ⇒ 不拦（交 400 网）；
- **输出预算三源取 max**：①`agent.options.maxTokens`（宿主 buildRequest 同源）
  ②`requestMaxTokens`（`agent/request` 瀑布观测）③`llm.resolveModelInfo().defaultMaxTokens`
  （请求缺 mct 时 llm 在瀑布**之后**注入，②对它失明）；全缺退 `0.25×窗`；
- **互斥**：`ARGP_FACTOR_PRESSURE=1` 时本闸不挂（两 env 各管一个对照世界，不叠乘）；
- **事务内闸二补检**：出口闸的线可低至 ≈0.73×窗，`compactIfNeeded('pressure')` 里
  `measurement.contextTokens >= windowTokens` 必须再过一次才允许调用散文浓缩（LLM 链
  不得被自动通路提前触达）。

### 4.3 §9.36 浓缩闸二（ctx 线）

pre-step 位：`source==='anchored'` 且 `contextTokens ≥ windowRatio×声明窗` ⇒ 驱一发
清扫式浓缩（闸一在 `prose-condenser` 内：散文占比 ≥50%）。手动 `compactNow` 免闸二。

## 5. 召回面

| 工具 | 输入 | 数据源 |
|---|---|---|
| `recall_history` | `labels[]`（交集）+ `limit` + `cursor/epoch` | `rawEventText` 取日志 append 根源原文；桩不冒充 |
| `list_labels` | `category`（document/command/errorcode）+ `limit` | 被剪账本的词表（键 × 覆盖数 × 最后出现轮） |

- 查询宽容：裸标签按四 facet 展开试匹配；未命中标签**如实回显**（不静默剔除）；
- 分页：`cursor/epoch` 续读，epoch 漂移显式告警（不假装稳定分页）；
- 预算：单次 5% / 累计 10% 窗口，耗尽/截断都带余额说明；
- 防循环：每轮 20 次调用上限（安全阀，非内容限制）。

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
| **0.1.5+（当前支持基线）** | `snapshotEvents()`；`events` 已彻底不存在 |

`log-access.ts` 的 `sessionEvents(session)` 是**全代码库唯一允许碰事件日志的入口**。
所有 `.length` 读取改用 `session.seq`（branded 类型，seq/offset 分离）。

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

## 8. 模块职责表（2.0）

| 文件 | 职责 | 依赖 |
|---|---|---|
| `argp-graph-engine.ts` | 组合根：构造装配、pre-step 三通道、溢出恢复、手动压缩、/argp 注册；持有宿主面字段 | 全部下方模块 |
| `session-lifecycle.ts` | normalizeConfig / registerSettings / bindSession / rebuildLedgerFromLog；设置 schema | argp-types, log-access, graph-build, telemetry, constants, budget, prune-tx |
| `session-state.ts` | 会话运行时状态（WeakMap 分桶）：台账/剪枝索引/召回预算/usage 锚点/账本重建去重 | constants, argp-types(type), graph-build(type), prune-tx(type), log-access(type) |
| `factor/engine.ts` | 因子引擎：贴标 → 排序 → `PrunePlan` → prune-tx 成对发射；账本/词表/note | log-access, constants, prune-tx, factor-atoms, factor-ledger, retention-score, tag-extract, clip-shape |
| `factor/prose-condenser.ts` | 散文浓缩：闸一、span 选择、LLM 调用、清扫式 replace | prune-tx, peratom/llm-adapter |
| `factor/recall-labels.ts` | `recall_history` / `list_labels` 两个 defineTool + 会话解析/防循环阀 | log-access, telemetry, factor-ledger, factor/engine |
| `factor/factor-ledger.ts` | 被剪账本：索引/epoch/`queryPruned`/`vocabularyRows`/`renderVocabulary` | — |
| `factor/factor-atoms.ts` | R 原子投影：标签、焦点、sticky、cites/命令/路径抽取辅助 | tag-extract, tag-canonical |
| `factor/retention-score.ts` | 保留打分与 `planPrune`（焦点带/sticky/过期/宽度熔断/夹剪归位） | factor/types, factor-atoms |
| `factor/tag-extract.ts` | 工具参数/输出 → 实体标签（四 facet） | tag-canonical |
| `factor/clip-shape.ts` | C10 夹剪层语义（三态保留与文本形） | — |
| `graph-build.ts` | `atomize` / `extractCites` / `classifyUserMessage` / `looksAskText` | argp-types, log-access, cites-strip, peratom/types |
| `budget.ts` | `visibleChars` / `resolveScaledBudgets` / `measureTokens` / `scaleBudgets` / `acquireTokenMeter` | constants, log-access |
| `recall.ts` | `shadowedSeqsOf`（权威账本）+ `budgetRecallText`（字符预算） | log-access, session-state(type) |
| `prune-tx.ts` | 事务骨架：`pruneIntervals` / `consolidateTombstones` / 手动区间函数 / `buildTombstoneRedirect` | argp-types, log-access, graph-build |
| `tombstone-text.ts` | 墓碑文案与老文法识别（读侧兼容） | — |
| `cites-strip.ts` | cites 尾块匹配/剥离（残差清扫；纯函数，零依赖） | — |
| `peratom/llm-adapter.ts` | LLM 调用后端（dsh-llm 生产 / fetch 本地 / `autoDshLlmSpec` 宿主路由兜底） | dsh-llm |
| `peratom/types.ts` | 来源判定叶子（ARG_NS / isArgpUserInfo / isOwnSourceKind） | — |
| `argp-types.ts` | Atom / AtomType / ArgpUserSettings（叶子） | cites-strip(type-only) |
| `log-access.ts` | 事件日志唯一入口 + 日志原语（eventText / rawEventText / turnOf / detectOpenTurn） | dsh-session, peratom/types |
| `constants.ts` / `telemetry.ts` / `ui-locale.ts` | 常量 / 有界缓冲 / 服务端多语言 | — |
| `preset-cleaner.ts` | preset 净化器（override-only；build 脚本烘焙进 `cordis.patch.yml`） | —（纯文本函数） |
| `argp-command.ts` | `/argp` 只读状态命令 | budget, log-access, ui-locale |
| `client/*` | 设置卡片（6 旋钮暂存表单 + locale 包）+ 聊天渲染的 cites 尾清扫 | cites-strip |

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

### 2026-11-14 快照（2.0.0-alpha.4 + 清洁批：死代码/manual-range 族/历史注释清除后）

度量工具同前（`scripts/analysis-extract.mjs` + `analysis-metrics.mjs`，TS 编译器 API）。
口径：圈/认知 = 文件内全部函数**求和**；嵌套/单函数行 = 文件内**峰值**。"代码行"不含空行
与纯注释。src 34 文件 / 280 函数；圈 >50 的函数 10 个、认知 >60 的 14 个、嵌套 >6 的 8 个。

| 文件 | 函数 | 圈(Σ) | 认知(Σ) | 嵌套(max) | 单函数行(max) | 代码行/总行 |
|---|---:|---:|---:|---:|---:|---|
| `src/factor/engine.ts` | 26 | **329** | **709** | 5 | **221** | 743/1025 |
| `src/factor/recall-labels.ts` | 5 | **89** | **224** | 5 | **285** | 293/389 |
| `src/prune-tx.ts` | 5 | 85 | 164 | 5 | **340** | 316/470 |
| `src/argp-graph-engine.ts` | 47 | **237** | 388 | 5 | **237** | 691/1165 |
| `src/graph-build.ts` | 4 | 31 | 114 | **7** | 84 | 107/187 |
| `src/factor/prose-condenser.ts` | 16 | 45 | 102 | 5 | 113 | 410/577 |
| `src/session-lifecycle.ts` | 7 | 37 | 86 | 6 | 115 | 219/365 |
| `src/preset-cleaner.ts` | 5 | 21 | 81 | **7** | 65 | 186/311 |
| `src/factor/tag-extract.ts` | 8 | 33 | 76 | 6 | 93 | 166/221 |
| `src/factor/factor-ledger.ts` | 19 | 21 | 58 | **7** | 68 | 321/460 |
| `src/log-access.ts` | 14 | 20 | 54 | **7** | 38 | 172/325 |
| `src/peratom/llm-adapter.ts` | 5 | 20 | 51 | 5 | 70 | 161/274 |
| `src/argp-command.ts` | 26 | 30 | 45 | 3 | 68 | 148/249 |
| 其余 21 个 src 文件 | — | ≤19 | ≤43 | ≤7 | ≤147 | 最大 543（config-controller），均 ≤ 365 |

**读法（诚实记录）**：

- 复杂度集中在四处，全部是**变异锁覆盖的核心算法/事务骨架**：`factor/engine.ts`
  （decide 193 行 / compactIfNeeded 136 行 / planProtocolGroups 100 行——决策与双闸编排）、
  `prune-tx.pruneIntervals`（340 行——带 `ended` 状态机的事务骨架，start/summary/逐区间
  replace/end + 事务后不变量审计 + 错误路径不可双 end）、`recall-labels` 的 recall_history
  装配（285 行——alpha.4 四不变量）、`argp-graph-engine` 组合根（47 函数挂载全部宿主钩子）。
- **不做表演性拆分**：这三个大函数各自是一个凝聚事务/决策核，拆分收益（行数）远小于风险
  （15+ 变异锁回归、错误路径状态机断裂）。`argp-graph-engine.ts` 的体量是组合根设计
  （"引擎是唯一组合根，向下单向依赖"）的直接结果，非意外膨胀。
- 清洁批（2026-11-14）移除：13 个零引用导出、手动区间族（compactRegion/compactRegions/
  selectManualRanges/consolidateTombstones/ManualRangeHost，≈200 行死路径）、log-access 的
  1.x 日志视图族（≈140 行）、17 处迁移史注释；src 净 −~500 行，圈 >50 函数持平。

## 11. 评测与调试开关（构造期快照，切换须重挂）

面向评测对照与排障，普通使用不需要碰。环境变量在插件构造期读取，改了要重挂会话。

| 变量 | 作用 |
|---|---|
| `ARGP_FACTOR_EGRESS=0` | 关出口闸（对照臂；结构效应 = 上下文天花板 305K vs 192K；缺省开 = 严格 admission 端点的 pre-send 防线） |
| `ARGP_FACTOR_PRESSURE=1` | 恢复旧 pre-step 估算驱动压力剪（旧世界复现；与出口闸互斥） |
| `ARGP_FACTOR_TIER=tiered` | 焦点分级策略档（hard/medium 焦点带；缺省 flat） |
| `ARGP_FACTOR_CLIP=1` | C10 夹剪层（三态保留；缺省关） |
| `ARGP_PERATOM_A2_DEBUG=<dir>` | LLM wire 落盘（默认脱敏；`_FULL=1` 才含正文） |
