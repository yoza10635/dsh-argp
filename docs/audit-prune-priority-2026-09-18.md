# ARGP 剪枝机制与优先级全面审查（2026-09-18）

> 目的：为"可剪池枯竭"缺陷的诊断与修复提供完整事实基础。所有结论附代码位置（`src/argp-graph-engine.ts`，除注明外）。
> 数据来源：corpus-r2-on（ON 臂 22 轮 medium，T1–T4 实测）会话审计 + 源码逐段核对。

---

## 0. 执行摘要（先看这段）

**结构**：3 个触发入口 → 1 套排序键 → 5 级降级链 → 3 类绝对豁免 → 2 道事务护栏。

**核心矛盾**：降级链的设计意图是"逐层来剪，不存在完全不可剪"（用户设计），但实现里有两处断点：

| # | 断点 | 位置 | 后果 |
|---|---|---|---|
| **G1** | **A10 结构组保护是绝对否决**——force_prune 路径同样走此判定 | `:2235-2246`（注释 :2234 明写"结构性保护优先于强制降级"） | 质量最大的 A 原子（tool-call arguments 携带文件内容）整组不可剪 |
| **G2** | **summarize 末环是 stub，恒返回 null** | `:1779-1781` | 信息保底降级从未存在；降级链实际只有 force 一层 |
| G3 | 触发线按**声明**窗口算（262,144×0.3815=100,007），真实 prompt 上限 = 174,080−32,768 = **141,312** | `scaleBudgets :134`、`:2105` | 压缩地板只要 > 100,007 即永久棘轮（余量 41K 不足以吸收） |
| G4 | 组件 B（per-atom 降熵）只在**溢出第②步**跑，平时不降熵 | `:690-696` | 大 A/R 只在 400 之后才被拆解，属于事后补救 |
| G5 | harness 自接的 `agent/request-error` 钩子与引擎自带三步序列**重叠** | `run.ts:565-628` vs `:999-1059` | 冗余（引擎已覆盖）；应移除或降级为纯诊断 |

**实测佐证（T4）**：11 次压缩 / 299 次 prune，合计回收 **6,484 tok（平均 21 tok/条）**，而同期 prompt 从 102,258 爬到 115,251（压缩后仅降 34 tok）。可剪池只剩碎屑，压缩净产出 ≈ 0。

---

## 1. 触发面：谁调用压缩

| 入口 | 位置 | 触发条件 | 目标 |
|---|---|---|---|
| 压力剪枝 | `ctx.on('agent/pre-step')` `:1060` | 每步发起请求前，`measurement.contextTokens ≥ windowTokens − reserveTokens` | 剪到 `retainTokens` 以下 |
| 溢出恢复（三步序列） | `ctx.on('agent/request-error')` `:999-1059` | provider 返回 400，`failure.code === CONTEXT_WINDOW_EXCEEDED` | ①forcePrune →（仍超）②per-atom 降熵+③forcePrune →（仍超）保留原错误 |
| 手动 `/compact` | `compactNow` `:2462` | 命令触发 | `selectManualRange` 指定区间 |
| 墓碑归并（前置步骤） | `consolidateTombstones` `:2034`，由 `compactIfNeeded:2128` 调用 | 图剪前，存在连续 ≥`tombstoneMergeMinRun`(默认 8) 可合并墓碑 | 压低"墓碑地板" |

**重要订正（2026-09-18）**：引擎**自带**上述压力与溢出两个钩子（`:1060` / `:999`），不依赖 `dsh-compaction-basic`。此前"harness 没挂 compaction-basic → 引擎应急层从未执行"的判断**错误**。xhigh 误配那次的 T4 硬失败，真相是：三步序列**执行了但耗尽**（① 强剪只捞到碎屑 → 重发仍 400 → ②③ 同样 → 事件#3 保留原错误）。`dsh-compaction-basic` 屏蔽的真实含义只是"不让它的 LLM 摘要压缩器抢占 `ctx.compaction`"。

**重试预算**：`maxOverflowRetries` 默认 1；挂载 peratom compressor 时自动提到 3（`:705-707`）。计数存 `overflowRetries`（agent→次数），`agent/status === 'idle'` 时清零（`:991-993`）。

---

## 2. 原子模型（`AtomType :100`, `classifyUserMessage :177`）

| 类型 | 来源 | 文本内容 | 参剪性 |
|---|---|---|---|
| `U` 普通 | 真实 user/message（含 task-init dialog） | 用户消息 | 仅 ask-exempt 路径可剪 |
| `U` U-info | peratom 追加的 `data[argp].info===true` 聚合副本 | 资料副本 | 按 R 待遇（`sourceSeq` 有值即识别） |
| `A` | assistant message（**含 tool-call arguments**） | 回复文本（cites JSON 已剥离） | 主要剪枝对象 |
| `R` | tool/result | 工具回执 | 半拆组后可独立剪 |
| `X` | 墓碑/checkpoint（plugin source、无 argp meta） | 占位文本 | **永不参剪** |

分类顺序不可交换（`:167-176`）：先判 U-info，再判 plugin-source→X。反了会让 U-info 变 X 而全局不可剪。

> **语料事实**：coding 工作流里"写文件"的内容全在 **A 的 tool-call arguments**（write 25.5K + edit 4.2K tok，占 T4 总量 ~40%）；R 反而都是小回执（write 均 52 字符）。

---

## 3. 候选资格矩阵（`isAtomCandidate :2203-2250`）

判定按下述顺序，命中任一否决即不可剪：

| 序 | 条件 | 位置 | 说明 |
|---|---|---|---|
| 1 | 普通 U 无 ask 覆盖 → 否 | `:2204-2215` | ask-exempt 需同时满足：有覆盖者、位置 < recencyCut、turn 不过新、且**所有**保留入边来自覆盖者 |
| 2 | 类型 ∉ {A,R,U} → 否 | `:2220` | X（墓碑/checkpoint）结构性不可剪 |
| 3 | `pos ≥ recencyCut` → 否 | `:2222` | recencyGuard（schema 默认 4，**宿主 patch=10 节点**） |
| 4 | `turn > latestTurn − turnGuard` → 否 | `:2223` | turnGuard 默认 1（保护当前轮） |
| 5 | `citesFailed` → 否 | `:2224` | §4.7 保守保护：检测到 cites 尝试但解析失败 |
| 6 | **A10 结构组保护** → 否 | `:2235-2246` | A 有 toolCallIds 且组内 R 无组外声明入边且 A 未 cites 组内 R → **整组否决（force 亦然）** |
| 7 | `allowInDegree=false` 且 `curInDegree > 0` → 否 | `:2248` | 仅软阶段门槛；**`curInDegree` 含 inferred 边**（`:2282-2284`） |

**A10 判据细节**：外部入边取 `curInDegreeDecl`（**排除 inferred**，`:2286`）或 `deterministicEdges` 中组外来源。即组件 A 的推断边不能"救活"A10 组的 A。

**三处绝对豁免（凌驾所有层之上）**：① A10 组保护；② recencyCut + turnGuard；③ X 与无覆盖 dialog-U。

---

## 4. 排序优先级：谁先被剪（`sortKey :2266-2276`）

```
sortMode='density'（宿主默认）：
  键 = [lvl, eff + chainBonus, −ceil(chars/charsPerToken), lastRef, seq]
sortMode='legacy'：  [lvl, eff, lastRef, seq]
sortMode='density-chain'：density + 版本链长度加成
```

- `lvl`：命中语义边的原子 = supporting 档，其余 = isolated 档（**isolated 先剪**）
- `eff` = max(selfImportance, 入边权重)：selfImportance `A=5, U=3, U-info/R=0`（`:2149`）；边权重 `critical 10 / supporting 5 / contextual 2 / inferred 1`（`:130`）
- `density` 模式在**同 lvl/eff 档内按 token 降序**——大块先剪（这是"压缩率导向"的设计取向）
- `lastRef`：最后一次被引用轮次（越旧越先剪）
- recall 价值继承：被 cites 命中的 recall 结果原子继承旧原子 eff×0.5（`:2156-2163`）

---

## 5. 降级链（`compactIfNeeded` 主循环 `:2278-2348`）

```
for pass in 0..maxPasses(宿主 256):
    ┌─ 每 pass 重推动态入度（§5.4 链式解锁：已剪方不再计入目标入度）:2280-2287
    ├─ 达标即停：visible ≤ retainChars → break :2290
    │
    ├─【层 0】版本链去重（pass 前一次，`:2259-2263`）
    │    重复 A 文本的旧版 → 整组淘汰（A+其全部 R），无条件先剪
    │
    ├─【层 1】软候选 = isGroupCandidate(g, false) :2292
    │    门槛：入度=0 + 上面全部豁免
    │
    └─ 若候选为空（:2301）：
         ├─【层 2】闭包归并 selectClosureToMerge :2310
         │    条件：非最后一个 root / 最近 k=2 轮未被引用 / 无 external **critical** 入边
         │    粒度：整闭包退休（一个 task-init U 到下一个 U 之间的全部原子）
         │
         ├─【层 3】summarize :2325  ← 🔴 stub 恒 null（:1779-1781），且 enableSummarize 默认 false
         │
         ├─【层 4】force_prune = isGroupCandidate(g, true) :2329（忽略入度门槛）
         │    🔴 但仍走 A10 / recency / turn / citesFailed 否决
         │
         └─【层 5】仍空 → break :2330（剩余质量＝不可剪，函数带累积成果落剪）
    ⇢ 剪 A 连带其全部 R（:2341-2346，防孤儿 tool 消息）
```

`degradationStrategy`（默认 `lifecycle`）：`fail`（候选耗尽即返回 null）`/ summarize / force / fail`。

**为什么"完全不可剪"会出现**：层 1–2 受入度/闭包条件限制，层 3 不存在，层 4 被 A10 否决 → 层 5 直接跳出。A10 覆盖的恰是 coding 语料里质量最大的 A 组。

---

## 6. 事务与墓碑（`pruneIntervals :2552-2713`）

| 环节 | 规则 | 位置 |
|---|---|---|
| 区间合并 | 相邻 seq 合并；**solo-R 强制独立成区间**（tool 墓碑必须恰好替换 1 节点） | `:2368-2400` |
| 微剪枝下限 | `minSpanChars`（默认 0）；低于下限整段放回（宁可不剪） | `:2380` |
| 孤儿双向守卫 | 混剪区间含"issuer 存活的 R"→ 拆出该 R；拆后低于下限则整段放回 | `:2381-2400` |
| shadow-price 契约 | **每区间一个** `compaction/prune`（范围必须与紧随的 replace 严格相等），末尾 summary 总跨度 claim 由 off-surface `compaction/end` 清掉 | `:2591-2601` |
| 墓碑形态 | ① 闭包墓碑（带 root/计数，P3/P6 消歧）② **tool 占位墓碑**（克隆原 R data、仅改 inner text，保 callId 配对）③ 普通 user 墓碑 | `:2436-2458`, `:2604-2630` |
| 展示摘要 | `compaction/summary` = **UI 用的人类可读摘要，0-LLM**（`provider:'argp'`, `model:'deterministic-guards'`）——**不是** LLM 压缩 | `:2645-2663` |
| 锚点重置 | 压缩换代 → `lastRealPromptTokens` 重置为"压缩后 surface 估算"（旧 provider usage 锚点已失效） | `:2684-2690` |
| 可恢复性 | 原文永久留在 append-only 日志；`recall_pruned(seq)` / `list_pruned` 取回 | `:714`, `:2421-2429` |

---

## 7. 辅助护栏与组件交互

| 机制 | 作用 | 位置 |
|---|---|---|
| 墓碑归并 §11.8① | 连续 ≥8 可合并墓碑 → 单条聚合墓碑；修"墓碑地板单调累积" | `:2034-2083`（`tombstoneMergeMinRun` 默认 8，0=关） |
| 版本链重定向 | 被剪旧 R 记录该路径最新存活版本 seq，`recall_pruned` 命中时重定向 | `:2411-2419` |
| 半拆组（2026-08-23） | R 与 issuer A 解耦，允许独立剪 + tool 占位墓碑配对 | `:2184-2189` |
| 组件 A（inferred edges） | declarer `buildInjectEdges` → 权重 1 保底层；**计入软阶段入度，但不计入 A10 判据** | `:689`, `:2141-2143`, `:2286` |
| 组件 B（HLS repair） | peratom compressor 内，`hlsRepairEconomics(原长, 候选长, missing, θ)` ROI 门控；仅溢出第②步跑 | `token-ontology.ts:124`, `peratom/compressor.ts:473,571` |
| 账目重建 | resume 时从日志重建 records/prunedNodeIndex（无 WAL，日志即账目） | `:2721` |
| 锚定测量 | `measureTokens`：优先真实 usage（`inputTokens+cacheRead+cacheWrite`）+ 锚点后增量估算 | `:1540` |

---

## 8. 缺口清单与建议优先级

| # | 缺口 | 证据 | 建议 | 优先级 |
|---|---|---|---|---|
| **G0** | **reasoning 回放进 prompt，但剪枝器完全看不见它**（`eventText:355` "reasoning 不算"、`:10` "不计入预算"） | **实测（2026-09-18）**：T4 会话 reasoning 合计 252,427 字符 ≈ 84K tok，占 115K prompt 的 ~70%；pi-ai `replayedAssistant:199-204` **无条件**把 reasoning 转成 wire `thinking` 块；本地 vLLM 实测带 thinking 块历史 prompt_tokens +1500（`preserve_thinking:false` 无效） | **floor ≈ 84K(reasoning) + 20K(固定) > 100,007 触发线 → 永久棘轮**。修法二选一：**① wire 层不回放 reasoning**（对齐引擎设计假设与 Qwen3 官方默认 `preserve_thinking=false`）；② 引擎把 reasoning 建模为可剪/可丢原子。**必须先定此项再评估 G1** | **P0** |
| **G1** | A10 绝对否决使 A 侧质量块不可剪 | 299 prune/6,484 tok；`average 21 tok/条`；A 侧 tool args 31K tok 被罩 | force 末端加"穿透 A10"最深层（限全层饿死后触发；协议安全机械已在 `:2341-2346` + solo-R 墓碑）；config 默认关、harness 显式开 | **P1** |
| **G2** | summarize 末环是 stub | `:1779-1781` 注释明写"保守选项 a：不实现" | 二选一：实装（信息保底，代价=LLM churn）或**显式废弃**（删 `summarize` 策略、文档标注 force 为终端） | P2 |
| G3 | 触发线按声明窗口（100,007）≠ 真实上限（141,312） | `scaleBudgets` + 实测 | 有 G1 后优先级下降；若要改，注意**不要动 contextWindow**（钳 1 死循环风险），只调 windowRatio 或用真实窗口系数 | P2 |
| G4 | 组件 B 只在溢出第②步跑 | `:690-696` | 评估是否需要在压力路径也做 per-atom 降熵（大 A args 的常态治理） | P3 |
| G5 | harness 自接溢出钩子与引擎三步序列重叠 | `run.ts:565-628` vs `:999-1059` | 移除自接层（或只留 diag 日志），避免误导与多余 prune | **P1（清理）** |

---

## 9. 数据佐证（corpus-r2-on，T1–T4 实测）

| 指标 | 数值 |
|---|---|
| prompt 曲线 | 3.9K → 43.9K(T2) → 77.3K(T3) → **115.3K(T4 步9)** |
| 触发线 | 100,007（声明 262,144 × 0.3815）；真实上限 141,312 |
| 压缩次数 / prune 数 | 11 / 299（T4 内） |
| 压缩回收量 | 6,484 tok 合计，**平均 21 tok/条** |
| 压缩后 prompt 变化 | 102,258 → 102,224（−34） |
| reasoning 档位 | medium 生效（多数 35–3K 字符；每轮开场 planning 烧满 8192 预算：56.5K/37K/74.3K 字符） |
| T4 工具调用 | 51 次（write 22 / edit 13 / bash 13 / read 3） |
| T4 终止原因 | `--turn-timeout-ms` 1200s 超时（无提交）→ 整跑按 design 中止 |

**质量构成**：A 侧 tool-call arguments ≈ 31K tok（write 25.5K + edit 4.2K）；R 侧回执 ≈ 11K tok（**无 >3K 字符的大 R**）；assistant/user 文本 ≈ 2.2K tok；其余为固定开销（system + 12 工具 schema + persona，不在 surface）。

**结论**：本缺陷不是"压缩率（retainRatio）不够"，而是**合格候选耗尽**——可剪面被 A10 + recency + 固定开销三重挤压后只剩 21 tok 级碎屑。

---

## 10. G0 追加发现（本轮深挖）：reasoning 是最大的不可剪质量

> ⚠️ **本节（§10 与 §10.1）的结论已被 §10.2 的实弹验证取代**：真因不是"pi-ai 承载形态缺陷"，而是「kwarg 配错层 + 分支选错 + 模板 `last_query_index` 子句」。本节保留为**当时的推理轨迹**，作为方法学对照（它示范了"从会话事件反推 wire 行为"会走到哪里）。**以 §10.3 为准**（§10.2 本身另有 4 处已被 §10.3 更正）。

**事实链**：

1. **引擎侧**：`eventText :355` 明写"从一个事件投影出模型可见文本（text + tool-call 概要 + tool-result 内层 text；**reasoning 不算**）"；`:10` "reasoning 块不计入预算（spike 4a 判决 C）"。即：**reasoning 既不计入估算，也不进原子图，因此永远不可剪**。
2. **wire 侧**：`dsh-llm-pi-ai/lib/index.js:199-204` `replayedAssistant` 把持久化的 reasoning 块**无条件**映射为 pi-ai `{type:'thinking', thinking, thinkingSignature}` 发送——此处没有 `preserve_thinking` 门控。
3. **服务端实测**：对本地 vLLM 构造两个同构请求（历史里助手消息带 / 不带 thinking 块），`prompt_tokens` 46 vs 1546 → **thinking 块确实被渲染进 prompt**，即使 `chat_template_kwargs.preserve_thinking=false`。（原因：`preserve_thinking` 管的是 `reasoning_content` 字段，而 pi-ai 把思考放进 `content` 的 `thinking` 块 → 模板逐块渲染，门控失效。）
4. **语料实测**：T4 会话 39 条 assistant 消息的 reasoning 合计 **252,427 字符 ≈ 84K tok**，而 prompt 在 T4 末为 115,251 tok。
5. **增量核对**：T2/T3/T4 的开场步 `prompt_{n+1} − prompt_n` 分别 +19,124 / +11,965 / +24,181，与对应 `outputTokens` 19,047 / 12,045 / 25,100 **几乎完全相等** → 上一步的**全部输出（含 reasoning）**都进入了下一步的 prompt。

**量化根因**：

```
floor = reasoning(~84K) + 固定开销(system+12 schema+persona ≈ 20K) + A10 焊住的可剪面
      ≈ 104K  >  触发线 100,007
⇒ 压缩器每一步都在触发、但每步只能从"可见且可剪"的碎屑里捞 21 tok
⇒ 真实 prompt 单调爬升 → 141,312 墙 / 轮超时
```

**这解释了两臂差异**：OFF 22 轮不撞墙，是因为其每步输出/增量小，碎屑产出恰好够用；ON 臂 medium 下每轮开场大量 reasoning（预算烧满 8192），增量洪流把 floor 顶过触发线。

### 10.2 实弹验证与修正（2026-09-18 13:0x–13:4x，**本节取代 §10 与 §10.1 的结论**）

> ↪️ **后续更正见 §10.3**：本节的方向（三坑、坑③ 为真因）成立，但有 4 处需修正 —— ① 坑② 的因果（真机制是 `preserve_thinking` **缺席=undefined** 而非被 true 覆盖）；② "pi-ai 走 content 块"的推断作废（实走字段）；③ "字段名不匹配导致落空"作废（字段名等价）；④ "棘轮 100% 来自轮内"需再分为**轮内瞬时** vs **跨轮地板**，后者已被 ①② 消掉。

> 方法：**线级录制代理**（`dsh-corpus-harness/.tmp/wire-proxy2.mjs`，本地 127.0.0.1:8123 → vLLM，逐条记下请求体**全键画像**与响应 delta 字段名）+ 直连 curl 二分 + **从容器导出真模板**（`podman exec qwen38-27b-vllm cat /model/chat_template.jinja`）。
> 证据：`.tmp/wire-g0-BROKEN-config.jsonl`（错配置）、`.tmp/wire-g2.jsonl`（修后）、`.tmp/qwen38-chat_template.jinja`。探针两轮：`probe-g1-wire`(242s/14 步/提交 a5128ad)、`probe-g2-wire`(10 步)。

**结论：不是"pi-ai 承载形态缺陷"，而是三个叠在一起的坑，其中第 ③ 个才是棘轮真因。**

| # | 事实 | 证据 |
|---|---|---|
| ① | **`chatTemplateKwargs` 配在 model entry 顶层 = 死配置**。pi-ai 只读 `compat.chatTemplateKwargs`（openai-completions.js:661）；`model.compat` 由适配器按「route 级 compat + entry 的 `compat`」合并（`resolveModelCompat` :606-624），顶层那份**从不被读** | 线上 `chat_template_kwargs` **完全缺席**（`detectCompat` 默认 `{}` :1303 → `buildChatTemplateValues` 返回 undefined）→ 连 `enable_thinking` 都没发出 |
| ② | **`thinkingFormat` 必须 `'chat-template'`**；`'qwen-chat-template'` 硬编码 `preserve_thinking:true` 并整体替换 kwarg 表（:654-658） | 修后 wire 实测 `{"enable_thinking":true,"preserve_thinking":false,"reasoning_effort":"medium"}` ✓ —— `reasoning_effort` **第一次真正上线** |
| ③ | **`preserve_thinking` 只门得住"已完结的历史轮"，管不住"当前轮"** —— 这是棘轮真因 | 见下 |

**真模板（vLLM 0.9.3 / radiance 镜像，容器内 `/model/chat_template.jinja` 第 116 行）**：

```jinja
{%- if preserve_thinking is undefined or preserve_thinking is true or loop.index0 > ns.last_query_index %}
    {{- '<|im_start|>' + message.role + '\n<think>\n' + reasoning_content + '\n</think>\n\n' + content }}
{%- else %}
    {{- '<|im_start|>' + message.role + '\n' + content }}
{%- endif %}
```

`ns.last_query_index`（同文件 :88-98）= **最后一条"非 `<tool_response>` 包裹"的 user 消息下标**。
⇒ **最后一条 user 之后的全部 assistant 消息（即当前轮的多步工具循环）无视 `preserve_thinking`，恒渲染 reasoning。**

**决定性实验**（同一条 assistant 消息，只改末尾是否补一条 user；`preserve_thinking:false` 固定；reasoning=1718 字符≈860 tok）：

| 消息序列 | 带 reasoning | 不带 | 差 | 判定 |
|---|---|---|---|---|
| `[user, asst(reasoning+tool_call), tool]` | 959 | 99 | **860** | ❌ **全额渲染**（`loop.index0 > last_query_index` 短路了门控） |
| `[user, asst(reasoning), user]` | 67 | 67 | 0 | ✓ 被门控 |
| `[user, asst(reasoning+tool_call), tool, user]` | 101 | 101 | 0 | ✓ 被门控（同一条消息，只因末尾多了 user 就"升格为历史轮"） |

**对棘轮的含义**：T4dump 的大跳**全是轮内跳**——`2.1→2.2` Δin=19124 ↔ prevOut=19047（该步 reasoning 56512 字符），而轮边界 `1.8→2.1` 只有 987。⇒ **棘轮 100% 由"当前轮内 reasoning 累积"造成；`preserve_thinking` 从原理上修不了它。** 修 ①② 只能削掉**跨轮**（已完结轮）的那部分（T4 全会话 reasoning 252K 字符中，跨轮部分随每轮结束而失效）。

**修正后的修法清单（① ② 已落地，③ 待拍板）**：

| 方案 | 做法 | 评价 |
|---|---|---|
| ①② 配置级（**已实施**） | kwarg 挪进 `compat` + `thinkingFormat:'chat-template'` | 零官方源码改动；`reasoning_effort` 真上线、跨轮 reasoning 不再回放。**是必要前提，但不解决棘轮** |
| ③-a 熔断 | 超触发线 N 步仍压不下来 → 硬 summary / 降 maxTokens / 截断最老受保护块 | 直击"可剪池枯竭"；需引擎改动 |
| ③-b 轮守卫渐进化 | 落地用户已拍板的设计（轮守卫作为层 5 及之前的**渐进式**守卫；近因凌驾所有层） | 让"当前轮内"的肥块可剪；需引擎改动 + 保持 A/R 配对不破 |
| ③-c 思考预算上限 | `compat.supportsThinkingTokenBudget:true` + `thinkingBudgets`（medium→8192） | 只限**每步**产生速率，不阻止逐步累积；且会截断思维链（非官方语义）。`thinkingBudgets` 目前**根本没上线**（`supportsThinkingTokenBudget` 检测为 false → `thinkingTokenBudgetField` undefined → :741 不写） |
| ③-d 语料侧拆轮 | 限制单轮工具步数 | 止血非根治，且改变语料形态 |

**另附模板注记（实读，非猜测）**：`reasoning_effort` 合法值仅 `low|medium|xhigh`，非法值 → `raise_exception`（**400**，非静默回落）；`xhigh`/`low` 会**往 system 段注入一句思考指令**（medium 不注入，实测差 ~38 tok）⇒ **换档会改变 prompt 文本**，档位不是纯生成侧参数；`messages[0].role` 只认 `system`（其余角色落到消息循环 else → `raise_exception('Unexpected message role.')` :159-160），实测本机 vLLM 把 **`developer` 归一化为 `system`**（738 vs 738、13 vs 13）故 persona 正常进 prompt。

**方法学教训**：① 不要从会话事件反推 wire 行为（`eventText` 排除 reasoning，dump 里的"Δin≈prevOut"只是间接证据）；② 不要在字段名上先入为主——pi-ai 的历史思考字段名取自**流式 delta 的字段名**（:428-431），本机 vLLM 发的是 **`reasoning`** 而非 `reasoning_content`（代理 v1 只查 `reasoning_content` → 误判成"没回放"）；③ `| head -N` 会 SIGPIPE 截断导出（曾据此误判"模板缺消息循环"）。

### 10.3 决定性矩阵：门控的真实判据 + 对 §10 / §10.1 / §10.2 的四处更正（2026-09-18 12:4x）

> 方法：合成请求矩阵（`dsh-corpus-harness/.tmp/decisive-matrix.py`）——**只改一个维度**、其余逐字一致，`max_tokens=1` 只读 `prompt_tokens`；同一 vLLM、同一模板；reasoning 载荷 2000 字符。
> 动机：§10.2 的表里仍有两条是**推断**（"pi-ai 走 content 块"、"字段名不匹配"），本节把它们全部落到实测。

| # | 序列 | ctk.preserve_thinking | reasoning 字段名 | prompt_tokens | Δ vs 基线 |
|---|---|---|---|---|---|
| 00 | 基线（无 reasoning，**无 tools**） | false | — | 785 | — |
| A1 | **轮内**（无尾随 user） | false | `reasoning` | 2037 | +1252 |
| A2 | 轮内 | false | `reasoning_content` | 2037 | +1252 |
| A3 | 轮内 | **true** | `reasoning` | 2037 | +1252 |
| A4 | 轮内 | **true** | `reasoning_content` | 2037 | +1252 |
| A5 | 轮内，content 里 thinking 块 | false | — | 2038 | +1253 |
| B1 | **已完结轮**（尾随 user） | false | `reasoning` | 1038 | **+253** |
| B2 | 已完结轮 | false | `reasoning_content` | 1038 | **+253** |
| B3 | 已完结轮 | **true** | `reasoning` | 2043 | +1258 |
| B4 | 已完结轮 | **true** | `reasoning_content` | 2043 | +1258 |
| B5 | 已完结轮，content 里 thinking 块 | false | — | 2040 | +1255 |
| C1 | 轮内，**不带 ctk** | （缺席） | `reasoning` | 2075 | +1290 |
| C2 | 轮内，**不带 ctk** | （缺席） | `reasoning_content` | 2075 | +1290 |

A/B 各变体均带 tools schema，00 不带 → **B1 的 +253 ≈ tools schema 本身，即已完结轮门控下 reasoning 渲染量 = 0**。

**五条硬结论（含更正）**

1. **字段名无关**：A1=A2、B1=B2、B3=B4 —— `reasoning` 与 `reasoning_content` **完全等价**（vLLM 在模板渲染前已归一）。⇒ §10.1 里"模板只认 `reasoning_content` 而 pi-ai 发 `reasoning`，故字段落空"这条推断**不成立，作废**。
2. **轮内恒渲染，坑③ 复核成立**：A1–A4 全部 +1252，与 `preserve_thinking` **和**字段名都无关。
3. **`preserve_thinking:false` 对已完结轮**真的有效**：B1/B2 渲染量 = 0。⇒ **①② 配置修复的真实收益边界 = 削掉跨轮 reasoning**。
4. **`preserve_thinking` 缺席 ≠ false ⇒ 恒渲染**：C1/C2 = 2075（全额）。模板 `:116` 的第一个分支就是 `preserve_thinking is undefined`。⇒ 旧错配置（kwarg 配错层导致 `chat_template_kwargs` **整个缺席**）之所以最惨，**不是"门控被 true 覆盖"，而是"门控参数根本不存在"**。§10.2 坑② 的因果表述据此收紧（`'qwen-chat-template'` 那次确实是硬编码 true；顶层配错那次是 undefined —— 两条路径殊途同归，但成因不同，勿混为一谈）。
5. **content 内 thinking 块确实绕开门控**（B5：已完结轮 + `pt=false` 仍 +1255）。**但 pi-ai 不走这条路**——`wire-g2` 实录 assistant 消息键 = `{role, content, reasoning, tool_calls}`，`content` 为 `null` 或纯文本。⇒ §10 第 2 点"`replayedAssistant` 无条件转 thinking 块"**作废**；B5 保留为**换适配器时的警戒线**。

**修后配置下 reasoning 的量的分布（`wire-g2`，直录，T1 全程）**

- 末次请求 23 条消息、其中 assistant 9 条，**9/9 带 `reasoning` 字段**；reasoning 合计 **12,313 字符**，占该请求 wire 全字符（31,133）的 **~40%**（单条最大 8,363 字符）。
- 轮内每步增量**很小**：Δin = 132 / 222 / 277 / 374 / 391 / 414 / 628 / 640 / 682 / 1175 / 1276 / 1793 / 4543（中位数 ≈ 400）。T1 全程 prompt **3,874 → 11,883**（14 步）——**没有任何棘轮迹象**。
- 会话侧存储形态核验：`assistant/message.data.message.content` 内为 `{type:'reasoning', text}`，**10/10 条都有**，首条 **1718 字符**与 wire 的 `reasoning=1718` **逐字对齐** ⇒ 映射 1:1，计量侧可直接读该块。

**⇒ 对"棘轮是否已被 ①② 消灭"的判断修正**

§10.2 说"棘轮 100% 来自轮内累积"，但"轮内"在时间轴上要再分两块，**性质完全不同**：

- **轮内瞬时**：每条 assistant 的 reasoning 只在本轮后续步里出现，**轮一结束即被丢弃**（模板位置门控）。
- **跨轮地板**：已完结轮的 reasoning，只需 `preserve_thinking:false` 就不再回放 → 是**地板**项（每轮叠加、只增不减）。

旧配置下两块**同时**存在（`undefined` → 全渲染）→ 地板 = 全会话 reasoning 252K 字符 ≈ 84K tok **> 触发线 100,007** → 单调爬升到墙。
修后只剩"轮内瞬时"（T1 实测仅 ~4.9K tok、且随轮重置）→ **地板回落到 ~20K（固定开销）量级**，**不再必然越过触发线**。

⇒ **待验收的结论（已于 §10.4 实跑验收：①② 成立、棘轮消除；③ 降级为健壮性项）**：**①② 有可能已经足够，③ 未必需要。** 判定标准**原定为**"修后 4 轮跑批 T4 能否正常完成"——实测 T4 仍**墙钟**超时（峰值为墙的 58.5%、0 溢出），故**判据应改为"prompt 峰值是否逼近 174,080 墙 / 压缩与剪枝是否失控"**，而非"是否超时"。对照基线现成：`dsh-corpus-harness/spike-out/medium-probe-on.log`（旧配置：T1 596s / T2 551s / T3 933s / **T4 TIMEOUT 1200s**；`compaction/start:17`、`compaction/prune:744`、`turn/end:3`）。

**计量缺口的正确落点（精确化 §10.2 的"修计量"建议）**

`eventText` 是**双用途**函数，**不能**直接给它加 reasoning 分支：

| 用途 | 调用点 |
|---|---|
| **计量**（应含 reasoning，对齐官方 `estimateContent` 的 text/reasoning 同价） | `:1532` `visibleChars`、`:1551` 锚点增量、`:2689` 压缩后锚点重置 |
| **图 / 原子文本 / 语义**（**不应**因计量而变） | `:1295`(U 原子) `:1343`(R 原子) `:2067`(原子) `:2044`(可归并墓碑判据) `:836/:1153/:1178/:1246`(重要性/边打分) `:731/:798/:1257`(recall) |

⇒ 正确做法：**新增一个"计量专用投影"**（= `eventText` + `{type:'reasoning'}` 块文本），**只**替换"计量"那三处；图侧一字不动。若直接改 `eventText`，reasoning 会连带进入原子文本 → 改变边/重要性/剪枝语义，那是**静默的行为变更**，比计量偏差更危险。

### 10.4 验收跑实测：①② 确实消灭了棘轮（2026-09-18 13:0x–14:0x）

> 配置：ON 臂 / medium / 4 轮 / 经线级代理直录（`.tmp/wire-g3.jsonl`，**74 条主循环请求**）；仓库先由 `vs-corpus-baseline` 重建（G2 ✓ HEAD=9bd0c32）。日志 `.tmp/probe-g3.log`，会话 dump `spike-out/probe-g3-wire-pilot-t4.jsonl`。对照 = 修前 `medium-probe-on`（`.tmp/old-session-stats.mjs` 逐轮统计）。

**结论：棘轮机制已消除。①② 达到预期收益；③ 从"必需"降级为"健壮性项"。**
> ⚠️ **幅值口径见 §10.5**：本节"修前 vs 修后"的对比还混着第二个变量 —— 修前配置**实际跑的是 xhigh**（模板回落，已用 +38 tok 的 prompt 算术证实），修后才是真 medium ⇒ 下表那些改善量级**不能全部归因于门控修复**。机制性结论（负增量、第 1 轮零剪枝）不受影响。

**证据 1｜轮边界 prompt 出现负增量**（修前是单调爬升）

| 轮边界 | 前轮 reasoning | 观测 Δin | 比值 |
|---|---|---|---|
| T1 → T2 | 4,188 tok | **−3,995** | 95% |
| T2 → T3 | 42,417 | **−46,030** | 109% |
| T3 → T4 | 23,335 | **−22,523** | 97% |

**最干净的一击**：**第 1 轮零压缩、零剪枝**（`compaction/start:0`、`compaction/prune:0`），而 T2 首步 prompt 仍比 T1 末步**低 3,995 tok** ≈ T1 的 reasoning 4,188 tok。**没有剪枝可供归因 ⇒ 这段跌落只能来自"跨轮 reasoning 被模板位置门控丢弃"**。修前该位置是 `Δin=19,124 ↔ prevOut=19,047` 的爬升。

**证据 2｜上下文压力与破坏性剪枝塌陷**

| 指标 | 修前对照 | 修后验收 | 变化 |
|---|---|---|---|
| **最大轮首地板**（跨轮累积的真实起点） | **105,097 —— 已越触发线 100,007** | **60,883 —— 未越线**（余量 39K） | **−42%** |
| 逐轮地板轨迹 | 3,912 → 39,740 → 77,034 → **105,097**（单调爬升） | 3,874 → 12,000 → 42,383 → **60,883** | T2/T3/T4 各降 70% / 45% / 42% |
| `compaction/start` | 17 | **3** | −82% |
| `compaction/prune` | 744（回收 19,191 tok） | **85**（回收 10,367 tok） | **−89%** |
| 剪枝效率 | 26 tok/条（≈碎屑） | **122 tok/条** | **4.7×** |
| prompt 峰值（`usage.inputTokens`） | **127,161**（墙的 73.0%） | **101,830**（58.5%） | −20% |
| 400 / 上下文溢出 | 有（撞 174,080） | **0** | — |
| 留在上下文里的真实内容（tool 参数 tok） | 25,266 | **36,881** | **+46%** |

**为什么"轮首地板越线"是最强的证据**：修前 T4 的**起手**就已 105,097 > 触发线 100,007 ⇒ **该轮每一步都在触发压力剪枝，且只能回收 26 tok/条的碎屑**（522 条 prune 仅回收 10,910 tok）—— 这正是"棘轮"的定义式：**剪不动、但每步都在剪**。修后 T4 起手 60,883，距触发线尚有 39K 余量，剪枝落到 85 条且每条回收 122 tok。⇒ **地板回到触发线之下，棘轮的成因（地板越线）消失。**

> 口径修正：本节此前写"修前峰值 115,251"，该数来源不明；以 `assistant/message.data.usage.inputTokens` 为准（已与线上 `prompt_tokens` 双源对账逐值一致）应为 **127,161**。同法复算：修前 744 条 prune 实际回收 **19,191 tok**（26 tok/条），印证 §10.2 记的"平均 21 tok/条碎屑"。

**证据 3｜坑③（轮内累积）仍在，但不再致命**

- 修后仍可见"Δin ≈ prevOut"的轮内大跳：req#27→28 `39,049 → 67,073`（**+28,024**，上一步输出 27,926）；req#44→45 `+13,303`（上一步 13,207）；req#47→48 `+14,129`（上一步 14,076）⇒ **当前轮 reasoning 依旧全程重渲染**（模板位置门控，配置层无解）。
- 但它是**轮内瞬时**：轮一结束即被丢弃（证据 1）⇒ 抬高**轮内峰值**、不抬高**跨轮地板**。
- 修后轮内净增：T1 +12,121 / T2 +76,413 / T3 +41,023 / T4 +40,947；峰值仅**擦过**触发线一次。

**⚠️ 未达成的验收项（诚实记录）**：`--turn-timeout-ms` 默认 1200s，**T2 与 T4 仍是 TIMEOUT**（T2 跑 29 步、T4 跑 12 步），T4 无新提交。
- 但**成因已不同**：修前 T4 = 522 次剪枝 + prompt 压到 115K 逼近 174,080 墙；修后 T4 峰值 101,830（58.5%）、**0 次溢出**、仅 2 次压缩 ⇒ 超时是**墙钟 + 步数**问题，**不是上下文问题**。
- ⇒ **全量 ON/OFF 跑批的前置条件变更**：必须先调 `--turn-timeout-ms`（或加步数上限），否则 T2/T4 被截断，两臂在"每轮做了多少工作"上不可比。

**⚠️ 顺带修正一条口径误解（重要）**：请求体里的 `scalars.reasoning`（pi-ai 发出去的字段）**≠ 进 prompt 的 reasoning**。修后请求体累计 **338,224 字符 ≈ 96.6K tok** reasoning，但模板只渲染当前轮那部分 ⇒ 末条请求体含 328,766 字符 reasoning，`prompt_tokens` 却只有 101,830。**判"reasoning 是否进上下文"只能看 `prompt_tokens`，不能看请求体**——这是 §10 那条教训的第三次发作。

### 10.5 🔴 自我订正：§10.4 的"修前 vs 修后"还混着第二个变量（实际档位 xhigh → medium）

> 起因：用户提出"reasoning 量差是不是因为修前 reasoning 跨轮进上下文"。查证过程中发现——**跨轮回放不是量差的根因**（见下），但**修前配置实际跑的是 xhigh，不是 medium**，这使 §10.4 的对比被污染。

**发现 1｜修前的 `reasoning_effort` 从未上线，服务端回落到默认 xhigh**

模板实读（`qwen38-chat_template.jinja:47`）：`{%- set resolved_reasoning_effort = reasoning_effort|default('xhigh') %}` —— **字段缺席 = xhigh**。而修前的 `thinkingFormat:'qwen-chat-template'` 分支（pi-ai `:654-658`）把整个 kwarg 表替换成硬编码的 `{enable_thinking, preserve_thinking:true}`，**丢掉了 `reasoning_effort`** ⇒ 模板回落到 **xhigh**。

**实测证据（`.tmp/effort-fallback.py`，同一条消息只改 ctk，`max_tokens=1`）**：

| 变体 | ctk | prompt_tokens | Δ vs medium |
|---|---|---|---|
| E1 | `{enable_thinking, preserve_thinking:true}`（**= 修前线上真实形态**） | **778** | **+38** |
| E2 | `{…, reasoning_effort:'medium'}`（= 修后形态） | 740 | — |
| E3 | `{…, reasoning_effort:'xhigh'}`（显式） | **778** | **+38** |
| E4 | `{…, reasoning_effort:'low'}` | 766 | +26 |
| E5 | `{enable_thinking:false, …}` | 742 | +2 |

**E1 ≡ E3（逐值相同）** ⇒ 不传 effort 与显式 xhigh **完全等价**，证实回落。
**独立交叉验证**：三次真实跑批的**首个请求** prompt = 修前 **3,912** / 修后 **3,874** / 修后 **3,874** —— 差值 **+38**，与 E1−E2 **逐值吻合**。这是从"prompt 长度算术"这一完全不同的方向，独立确认了此前只能从 wire ctk 得出的结论。

**发现 2｜量差的真因是"档位 + 采样"，不是"跨轮回放"**

T1 是判别器：**T1 之前不存在任何历史 reasoning**（新会话 + 空仓库基线），所以"跨轮回放"在 T1 上不可能起作用。而 T1 的每步 reasoning 就已差 12 倍：

| 跑次 | 首请求 prompt | T1 步数 | T1 reasoning | **每步 reasoning** | 说明 |
|---|---|---|---|---|---|
| 修前对照 | 3,912 | 19 | 20,545 tok | **1,081 tok** | 实际 xhigh（+38 证实） |
| 修后 probe-g3 | 3,874 | 12 | 4,188 tok | **349 tok** | 真 medium |
| 修后 ab4-on | 3,874 | 10 | 896 tok | **90 tok** | 真 medium，同一配置 |

⇒ 第一段落差（1,081 → 349，**3.1×**）来自 **档位**（xhigh → medium）；第二段落差（349 → 90，**3.9×**）发生在**配置完全相同、起点完全相同**（首请求都是 3,874）的两次跑之间 ⇒ **只能是采样方差**。服务端 `generation_config.json` 实测为 `do_sample:true, temperature:1.0, top_p:0.95, top_k:20`，而 harness **不固定** temperature/seed（`run.ts` 无 temperature/top_p/seed 传参）⇒ 同 prompt 下生成长度天然大幅波动。

**⇒ 对 §10.4 的影响（必须连带修正）**：§10.4 的"`compaction/prune` 744→85、轮首地板 105,097→60,883"是**两个原因叠加**的结果 —— ①（预期变量）跨轮门控；②（未预期的混杂变量）实际档位 xhigh→medium，使每步 reasoning 量掉了约 3×。因此这些**幅值不能全部归因于门控修复**，只能说"方向一致、量级不可分"。

**仍然干净的证据（同 run 内、机制闭环，不受混杂影响）**：
- 轮边界出现负增量：T1→T2 `−3,995` / T2→T3 `−46,030` / T3→T4 `−22,523`；
- 且**第 1 轮零压缩零剪枝**，T2 首步仍比 T1 末步低 3,995 ≈ T1 的 reasoning 4,188 tok ⇒ 无剪枝可归因，**只能**是模板位置门控丢弃了跨轮 reasoning。

**⇒ 正确的受控实验（已列入待办）**：**修后配置 + `reasoning_effort:'xhigh'`** 跑 ON 臂 —— 把档位与修前对齐，使**唯一变量 = 跨轮门控**，才能隔离门控自身的贡献。附带价值：xhigh 是**最坏情形**（烧满思考预算），正好压力测试"地板是否仍不越线"。同时应**固定采样**（temperature/seed）或做多 seed，否则任何跨 run 比较都不成立。

### 10.1 补证：纯宿主栈（无插件）如何对待 reasoning（2026-09-18 实测）

> ⚠️ 阅读顺序提示：本节编号在 §10.2 之后，但**结论已被前面的 §10.2 修正**（下表末行的"pi-ai 走块"是错的）。本节保留为原始推理轨迹。

**问题**：官方口径下 reasoning 是否占预算、是否进入拼装上下文？

| 维度 | 判定 | 证据 |
|---|---|---|
| **占预算** | **是** | `dsh-token-meter/lib/types/estimate.js` 的 `estimateContent`：`case 'text': case 'reasoning':` **同价计费**（`CHARS_PER_TOKEN=4` + 每块 `BLOCK_OVERHEAD=4`）。该校验正是 `foldSurfaceProjection`（context-pressure 投影）的定价函数，官方 compaction-basic 的压力判定建立其上 |
| **进拼装上下文** | **取决于承载形态**，宿主设计意图是**不进** | 实测（本地 vLLM，`preserve_thinking:false`）：基线 27 tok；`reasoning_content` **字段**形态亦 **27**（门控生效，不进）；`content` 内 `thinking` **块**形态 **1527**（**绕开门控**，进） |
| **两个官方适配器的形态差异** | **❌ 本节原判作废**（§10.2 更正）：**两者都走字段、都不走 content 块** | 原判"deepseek 走字段、pi-ai 走块"**错误**。实况：pi-ai 也把历史 thinking 写成**字段**，字段名 = `thinkingSignature` = **流式 delta 的字段名**（`openai-completions.js:428-431`、`:1001-1007`），本机 vLLM 的 qwen3 parser 发的是 **`reasoning`**（不是 `reasoning_content`）|

**结论**：宿主设计意图是"历史 reasoning 不回放"（`preserve_thinking` 默认 false）。**但实测（§10.2）表明 `preserve_thinking` 的语义边界比预期窄得多：它只门住"最后一条 user 之前"的历史轮；当前轮内（多步工具循环）的 reasoning 由模板无条件渲染。** 因此：

- harness 的行为是 pi-ai 路径的真实行为（已核对非 harness 特有），→ harness 保真度无偏；
- 而 argp 的 `eventText` 排除 reasoning，在"推理不回放"的预期世界里接近正确，但在当前实际 wire 下**严重低估**真实上下文（少算 ~70%）；
- ~~因此正确修法是 **A**：修 pi-ai 的承载形态（或按门控剥离），使预期世界成为现实~~ → **§10.2 更正**：pi-ai 的承载形态**没有问题**，配置层两个错误已修（kwarg 层 + thinkingFormat）；**剩余的 ~70% 是模板语义（轮内 reasoning 恒渲染），只能靠引擎侧机制修**（熔断 / 轮守卫渐进化 / 思考预算 / 拆轮，见 §10.2 修法清单）。
- 记录为一条 **harness 偏差**（仍然成立）：使用 pi-ai 路径（Qwen 系）时，**当前轮内**的历史 reasoning 会进入请求 → 与 `preserve_thinking=false` 的朴素预期不符（根因在模板，非适配器）。

---

### 10.6 A/B 四轮跑批实测（`ab4-on` vs `ab4-off`，2026-09-18 14:2x–15:1x）：两臂全自然收尾，但**实验轴自身不对称**

> 前提修复：`TURN_TIMEOUT_MS` 20min→60min + 逐轮步数日志。两臂各 4 轮、**8/8 全部 `completed` 自然收尾**，0 wall 溢出、0 撞墙；轮首地板 21,276 / 50,038 均未越触发线 100,007 ⇒ ①② 之后**无棘轮形态**。

| 指标 | ON（`ab4-on`） | OFF（`ab4-off`） | ON/OFF |
|---|---|---|---|
| 轮 / 收尾 | 4 / 全 completed | 4 / 全 completed | — |
| 步数 Σ | 56 | 61 | 0.92× |
| 墙钟 Σ | **1,110s**（T1 77 / T2 300 / T3 236 / T4 497） | **3,104s**（513 / 548 / 909 / 1,134） | **0.36×** |
| 峰值 input | **45,500**（占墙 26.1%） | **99,997**（占墙 57.4%） | 0.46× |
| 最大轮首地板 | 21,276 | 50,038 | 0.43× |
| reasoning≈tok Σ | **27,629** | **87,058** | **0.32×** |
| 工具参数≈tok Σ | 15,302 | 38,727 | 0.40× |
| 工具结果≈tok Σ | 4,059 | 8,120 | 0.50× |
| 压缩机制 | **`argp-peratom-*` 3 周期**（T2/T3/T4 各 1） | **`argp-graph-*` 1 周期**（T4） | — |
| 实际回收 | 266+791+289 = **1,346 tok**（449/周期） | 53 区间 = **15,545 tok**（293/区间） | 0.087× |
| 压缩后端 | LLM（`provider:'fetch'`） | 0-LLM 确定性图剪 | — |
| 工具调用数 | 54 | 86 | 0.63× |
| 首请求 prompt | 3,874 | 3,667 | Δ**207** |

**⚠️ 发现 1｜实验轴不对称（by design，但必须披露）**：三处差异**全由 `peratom` 一个开关联动**，本次跑的不是"压缩算法 A/B"而是"**整套 ON 栈 vs 整套 OFF 栈**"：

| 维度 | ON | OFF | 联动源头 |
|---|---|---|---|
| 引用协议段 | **无** | **有** `Citation declaration (ARGP)` 7 行（"EVERY time … MUST cite" + V6 分级） | `argp-graph-engine.ts:712`：`citesObligation = config.citesObligation ?? !(declarer.armed)` ⇒ OFF 无 declarer ⇒ 回落显式引用义务 |
| 召回段 | **有** `Two-tier recall`（order 151） | **无** | `peratom/recall-zoom.ts:213`（peratom 专属） |
| 工具集 | **12**（多 `recall_summary`/`recall_detail`） | **10** | 同上 |

⇒ ON 的系统提示反而**短 545 字符**，但多 2 个工具定义 → 首请求 prompt **净 +207 tok**。

**⚠️ 发现 2｜两臂的压缩*机制*根本不同**：ON = Stage-1 逐原子（**LLM 后端**，3 周期共 1,346 tok）；OFF = Stage-2 确定性图剪（1 周期 53 区间 15,545 tok）。**OFF 的回收量是 ON 的 11.5×** —— 这不是"ON 算法更强"，而是 OFF 臂 agent 更啰嗦、上下文涨得更快，图剪被迫做更多功。

**⚠️ 发现 3｜主导方差在上游，不在压缩算法**：T1 是判别器（新会话 + 空仓基线，**T1 之前无任何历史**，压缩机制无可作用）——ON 10 步 / 896 tok，OFF 20 步 / 16,187 tok，**每步 90 vs 809 tok（9×）**。看首个 assistant：OFF 带 869 字符 reasoning + `todo_write` 先规划，ON 只 70 字符直连 bash ⇒ 轨迹**分叉**（简洁 vs 啰嗦，且自增强）在压缩机制之前就发生，源头只能是**采样（temp=1.0，无 seed）+ 提示面/工具面差异**。

**🔧 计量修正（`.tmp/an-session.mjs`）**：回收量**权威口径 = `compaction/summary.shadowedTokenCount`**（每压缩周期一条）。原 prune 求和口径对 ON 臂**漏计 1,346 tok**（逐原子无 prune 事件）；而图剪周期 summary 汇总（15,545）与逐条 prune 求和（15,573）是**同一批操作的两种记法**（差 28 tok 舍入）——**两者不可相加**，否则 OFF 被双计成 31,118。

**🐞 缺陷修复**：`peratom/compressor.ts:1218` 审计字段 `model` 在 fetch 分支写 `String(summaryBackend.endpoint)`，而 `endpoint` 是 `ResolvedEndpoint` **对象** `{endpoint, model, apiKey}` ⇒ 线上实测落成 **`"[object Object]"`**，URL 与模型名双丢。已修为 `${model} @ ${endpoint}`；**需 `npm run build` + 装回 profile 才生效**。

**⇒ 结论与下一步（顺序不可颠倒）**：
1. **方向可信**：ON 明显更轻（峰值 0.46× / reasoning 0.32× / 墙钟 0.36×），**零图剪 churn、零 elision 墓碑**；OFF 出现 7 条 `[elided …]` 墓碑 user/message（图剪的下游产物）。
2. **幅值不可归因，连方向都不纯净**——提示面/工具面按设计不同，N=1 且采样未固定。
3. **先修采样（阻塞项）**：`temperature` 在 dsh 是一等字段（`LlmCallConfig.temperature` → `dsh-llm-pi-ai/lib/index.js:1872` → `openai-completions.js:609`），但 harness **从未设置**。固定 `temperature:0`（或固定 seed）是任何跨 run 比较成立的前提。
4. **再拉平提示面**：`citesObligation` 是**布尔**（`:323`），可强制两臂一致；或加**第三臂 `ON + citesObligation:true`** 直接隔离"引用义务"对啰嗦度的贡献（4 轮，成本低）。
5. **然后**才是多 seed A/B 与 22 轮全量重跑。

### 10.7 🔴 `temperature:0` 拿不到可复现 —— 两个独立噪声源（2026-09-18 15:2x–15:4x，**本节取代 §10.6 下一步的第 3 条**）

**动机**：§10.6 的结论是"跨 run 比较不成立，因为采样未固定"。于是固定采样。

**已落地**：`--temperature`（默认 `0`）+ `agent/request` waterfall 注入（`run.ts`）。三段独立实测确认上线：① 日志 `采样固定：request config ← temperature=0`（每请求一条）；② 线上 body 的 `keys` 含 `temperature`；③ dump `request/header.config.temperature = 0`，即 `{provider,model,reasoningEffort:"medium",temperature:0,maxTokens}`。

**验收（同配置两次跑 / 1 轮）= 失败**：三次尝试 tempcheck vs detcheck（9 vs 10 步、64 vs 58 事件）、detA vs detB（8 vs 12 步、50 vs 68 事件）**无一复现**。

**已排除服务端采样（`.tmp/greedy-repro.mjs`）**：同一个请求体**顺序**发 3 次 → `reasoning_content` 与 `content` **逐字节相同（3/3）**。服务端贪心是确定的。

**根因 1｜工具输出带时间戳（harness 侧，已证）** —— step0 `ls -la` 结果的首次字符差异 @49：

| 跑 | `.`（= vs-corpus） | `..`（= Project） |
|---|---|---|
| tempcheck | `Sep 18 15:12` | `Sep 18 15:29` |
| detcheck | `Sep 18 15:36` | `Sep 18 15:36` |

两串的 **token 数恰好相同** ⇒ `inputTokens` 前两项逐值相同（3874/4237）而**字节不同** ⇒ 模型第 1 步即分叉（A `head -20` vs B `head -10`）。
⚠️ **教训：只比 token 数会漏掉这类污染，必须逐字比对工具结果。**

**修法 1 已试、未成功（两点原因都值得记）**：persona 明令禁止 `ls -l/-la/stat/date/find -printf` + 预置固定 mtime（`touch -d 2026-01-01`）：
1. **模型无视该禁令，照跑 `ls -la`**（首调 args 逐字仍是 `ls -la ...`）；
2. `touch` 只能管 `.`/`..`，而 `cp -r` 会给仓内每个文件盖上"当下"时间戳（`Sep 18 15:4x`）⇒ 初始 listing 仍逐字不同；
3. 即便初始 listing 被抹平，agent 一旦新建文件、之后再 `ls -la`，mtime 又回到"当下" ⇒ **环境侧无法根治**。

**根因 2｜并发批组成（基建侧，已证）**：把**同一请求体并发**发 8 份（temperature 0）→ **3 种不同输出**（长度 896/1076/1111）。vLLM 连续批处理改变浮点归约顺序 → argmax 翻转。该机 VRAM 93.5%、有他人流量 ⇒ **与温度无关；单跑比较在本机永不可归因。**

**⇒ 方法论含义**：`--temperature` 仍有价值（消除采样随机性，把差异收敛到可诊断的少数源），但**不是"可复现"的充分条件**。要拿到**可归因的幅值**，只有三条路：

| 路 | 做法 | 成本 | 根治度 |
|---|---|---|---|
| **A 统计** | 同配置 N≥3 跑，比分布（中位/极差） | ×N | 只压方差，不根治 |
| **B 输出归一化** | 工具结果送入模型前抹平时间戳 | 小（需自接钩子） | 治根因 1；根因 2 仍在 |
| **C record/replay** | 录一次 agent 轨迹（助手输出 + 工具结果），两臂重放 | 新建 harness 模式 | **根治：唯一变量 = 引擎** |

⚠️ dsh 只暴露 5 个 waterfall（`agent/pre-step`、`agent/request`、`agent/request-error`、`fs/edit-intent`、`fs/write-intent`），**没有工具结果钩子** ⇒ B 只能在 `agent/pre-step` 改写消息、或包一层 bash 工具；C 需自建。

⚠️⚠️ **C 的能力边界（必须与"唯一变量 = 引擎"一起记，勿过度承诺）**：full replay **冻住 agent 行为** ⇒ 它**恰恰测不出"提示面差异是否会改变 agent 行为"**那一类问题（如 §10.6 的"引用义务 → 啰嗦度"）：行为被冻死，指令怎么变都影响不到输出。C 干净回答的是**引擎归因**（ARGP vs 传统压缩的代价/稳定性），**行为类问题只能靠 live 模型 + 重复统计（路 A）**。⇒ **引擎归因与行为归因需要两套工具，不是一套。**

⚠️ **C 的计量代价**：回放时不真发请求就拿不到服务端 `usage.prompt_tokens`，账目须改用 dsh 自己的 `dsh-token-meter`（`CHARS_PER_TOKEN=4` + 每块 `BLOCK_OVERHEAD`）**本地估算** —— 对两臂对比无碍（同一把尺子，且去掉了服务端缓存命中/上报波动），但绝对值不再与官方口径可比。变体：**仍发请求、丢弃回复** ⇒ 保留权威 token 数、行为仍冻结，代价 = 一次真跑的 GPU。

**C 的落地形态**：录一次正常跑（每步的助手消息 + 工具结果）→ 回放时挂**回放 provider**（按步序把录到的助手消息当流式响应喂回，不真调模型）+ **回放工具**（按 `(工具名, 参数)` 喂回录到的结果）；agent loop 与会话照常演进，**引擎全程存活**。

**🐞 操作陷阱（本轮新踩）**：**后台 shell 不继承沙箱豁免** ⇒ 跨 workspace 写（`rm -rf`/`cp -r` 复位 `vs-corpus`）**静默失败**，G2 因此连续中止两次跑；前台命令则拿到 `Sandbox bypassed (escalation-approved)`。⇒ **跑批前必须在前台复位并验证 HEAD/脏文件，再启动后台跑批。**

**附**：本轮新增两个诊断工具 —— `.tmp/det-check.mjs`（逐请求 inputTokens / reasoning 字符 / 工具名序列 / 事件计数的逐值比对，直接指出"首个差异 @i"）与 `.tmp/greedy-repro.mjs`（绕开 dsh 直打端点，测服务端贪心确定性，含并发模式）。

### 10.8 C 路（record/replay）落地：设计定稿 + 两处对 §10.7 的更正（2026-09-18 16:0x–）

**用户拍板走 C。**

#### 10.8.1 先探明 dsh 是否已自带（结论：没有，但顺手澄清了一个误读）

`assistant/message.data.message.source` 里带 **`replayState`**（`{response:{kind:'pi-ai',version:2,api:'openai-completions',…},blocks:[…]}`），`data.stream` 里还有**完整流式 chunk 序列**，`dsh-llm-pi-ai` 也有 `replayedAssistant()`。看着像现成的回放通道 —— 但读实现后确认：

> `replayState` 是**历史重发时的保真度**机制（把先前助手消息按原生签名/签名块还原，供下一次请求回填历史），**不是"冻结模型"模式**。`dsh-session-persistence-jsonl` 的 seed 校验（"seed assistant/message at index N replay state disagrees with its embedded stream"）同样只服务**会话重开时回放既有步骤**，新步骤照样真调模型。

⇒ **必须自建**。已装包中无 replay/cassette 类包（`dsh-agent-loop-testkit` 只有 prerequisite 挂载与 Inbox stub）。

#### 10.8.2 🔧 更正一：**只需冻结模型，不需要回放工具**（§10.7「落地形态」那条写多了）

§10.7 写的是"回放 provider **+ 回放工具**"。实际不需要后者，理由是一条链：

```
模型被冻结（第 k 步返回固定响应） ⇒ 第 k 步的工具调用固定 ⇒ 仓库演化固定 ⇒ 工具结果固定（模掉时间戳）
```

即**工具侧的确定性是模型确定性的推论**。故桩只需拦在 LLM 这一层，工具照常真跑。
（这也顺带保住了"引擎全程存活"与我们真正想测的东西 —— 引擎对**真实工具结果**做了什么压缩。）

#### 10.8.3 🔧 更正二：桩按**下标**服务、**不看 prompt 内容** —— 这不是偷懒，是唯一可行解

两臂的 prompt **必然不同**（这正是引擎的作用），所以"按 prompt 哈希匹配剧本"在跨臂场景下**没有解**。
按 (通道, 下标) 服务则天然成立：步序列由桩的响应决定 ⇒ 步数固定 ⇒ 每步一次请求 ⇒ 下标序列与臂无关。
**推论（重要）**：剧本内容是什么都无所谓，**"固定"才是它的全部价值** —— 故录制臂不必追求"跑得好"。

#### 10.8.4 通道必须分开（否则下标互相错位）

引擎自己也会调 LLM（peratom 的 compressor/declarer/zoom）。若与 agent 请求混在同一序列里，**下标立刻错位**。
故代理按**路径**分两通道，各持独立计数器：

| 客户端入口 | 通道 | 谁在用 |
|---|---|---|
| `http://127.0.0.1:P/agent/v1` | `agent` | agent 主循环（`LlmPiAi` 的 `providers.local.baseURL`）|
| `http://127.0.0.1:P/compressor/v1/chat/completions` | `compressor` | 引擎内部三条子通道 |

**为此改了一处硬编码**：`run.ts` 里 peratom 的 `compressor/declarer/zoom.endpoint` 原本是**字面量**
（`http://192.168.110.2:1234/v1/chat/completions`），意味着只能给 agent 通道改址、压缩请求仍打真服务端
—— "冻结模型"会只做一半。现改为 `COMPRESSOR_ENDPOINT`（默认从 `BASE` 派生，`ARGP_LLM_ENDPOINT` 可覆盖），
并在 engineConfig 构建后**在 `delete engineConfig.peratom` 之后**整体改址（顺序错了 OFF 臂会被重新装上 peratom）。

#### 10.8.5 🐞 首录即炸：路径重复前缀（1s 内失败，代价极小）

首录日志：`rec agent#0 404 req=15972B res=22B` → `T1 FAILED · reason=error 404 status code (no body)`。
根因：`BASE` 形如 `http://host:1234/v1`，若拿它当 base 再拼客户端 sub-path `/v1/chat/completions`
⇒ 转发成 `.../v1/v1/chat/completions`。**修法**：取 `new URL(base).origin` 拼 sub-path（客户端 sub-path 恰好等于上游 path）。

**配套纪律（本轮新增）**：这类"拼错了要等 45 分钟才发现"的错误，一律用**秒级预检**挡掉 ——
`.tmp/rp-preflight.ts`（录制侧：两通道各打一发，断言 200 + trace 出 2 条）与
`.tmp/rp-replay-preflight.ts`（回放侧：断言 ① 逐字节还原 ② 请求落盘 ③ 剧本耗尽返回 500 且计入 miss）。

#### 10.8.6 耐久性：trace 逐条同步 append

一次 4 轮录制 ≈50min。若把 trace 缓在内存、只在收尾落盘，中途任一崩溃/手工中断就**整次作废**。
故 record 模式改为**先截断、再逐条 `appendFileSync`**；`flushSync()` 另挂 `process.on('exit')` 兜底
（`main()` 有多条 `process.exit()` 路径，异步 `close()` 根本不会被 await 到）—— 回放模式的请求日志同理。

#### 10.8.7 剩下的噪声与判读纪律（**别把 C 读成"绝对干净"**）

C 只冻结模型，不冻结工具 ⇒ 工具输出里的 mtime 仍在（§10.7 根因 1）。于是：

> 跨臂 Δ 必须 **≫ 同臂重跑的 Δ**（噪声地板）才可归因；否则只能说"落在噪声内"。

故**同一臂要跑两遍**测地板，且分析器额外给一列"剔除时间戳形态后再比"（`归一化Σ`）作交叉验证。

#### 10.8.8 读数口径：**system 段与正文段必须分开**（§10.6 的混淆不能在读数里重演）

`--arm on/off` 同时改了压缩算法**和**提示面（`citesObligation` 缺省 `?? !(declarer.armed)` ⇒ ON 不注册
`Citation declaration` 段、OFF 注册）。若只比"总字符数"，差值是两件事叠加。故 `.tmp/rp-attrib.mjs` 按
**Σsystem 字符 / Σ正文字符** 分开统计：

- **Δsystem** = 提示面差异（指令层，与压缩无关）
- **Δ正文** = 上下文压缩差异（**这才是引擎效应**）

另附逐下标"消息条数"分岔点（压缩器在**哪一步**开始改结构）与对齐检查（请求数不等 ⇒ 直接判该臂不可用）。

#### 10.8.9 本轮交付物

| 文件 | 作用 |
|---|---|
| `dsh-corpus-harness/replay-proxy.ts` | 录制/回放代理（双通道、逐条 append、耗尽硬报错）|
| `dsh-corpus-harness/run.ts` | `--record` / `--replay` 旋钮；`COMPRESSOR_ENDPOINT` 可改址；`retargetPeratom()`；代理统计入 summary；耗尽 → exit 3 |
| `.tmp/rp-preflight.ts` / `.tmp/rp-replay-preflight.ts` | 秒级预检（录制侧 / 回放侧）|
| `.tmp/rp-attrib.mjs` | 归因分析器（system/正文分离 + 噪声地板 + 归一化列）|
| `.tmp/dump-schema.mjs` | dump schema 勘察（事件直方图 / assistant 完整度 / recall 调用排查）|

**录制臂的选择依据**：录 **ON** 臂 —— ① 只有 ON 会产生 compressor 流量，ON 回放才有剧本可放；
② 已核验 ON 臂 4 轮 54 次工具调用中 **`recall_*` 零调用**（只有 `bash/write/edit/todo_write`），
故同一份剧本对 OFF 臂也可执行（OFF 工具集 ⊆ ON ⇒ 无"工具不存在"发散）。


### 11.1 A10 结构组保护（`isAtomCandidate :2235-2246`）

**是什么**：对"发起了 tool call 的 A"（`a.toolCallIds.length > 0`），若它与其 R 组满足下列**全部**条件 → 整组（A + 其全部 R）不可剪：

1. A **没有** cites 指向组内 R（`!aCitesR`）——即缺失声明边；
2. 组内 **所有** R 都没有**组外**入边（`!anyRExternalIncoming`）——语义声明入度 `curInDegreeDecl` 为 0（**排除 inferred**）且组外确定性边（其他 A 的配对边）也为 0。

**设计出处**：assessment-v2 A 轨 A10「必补项，**收窄版**」（`CHANGELOG.md:227`）："带 R 组的工具 A 仅当组内 R 无任何组外入边（语义 `curInDegree` + 组外确定性边）才保护；被外部 cites 后 R 解锁 → A 可剪。**force 路径同判据**。"代码注释 `:2234` 再次强调"结构性保护优先于强制降级"。

**它要解决的问题**：防"整闭包被剪"。若 A 与 R 之间没有声明边，且 R 无外部引用，则 R 在图上表现得像"入度 0 的孤立节点"→ 先被剪；A 因无出边也可剪 → §5.4 链式解锁把"请求 + 结果"整对带走，模型再也看不到"我调用过什么、拿到什么"。

**收窄的原因（问题 1 修订）**：判据只数**组外**来源。若把组内 issuer 自己的确定性配对边也算作"入边"，则"有 R 就保护"→ 退化为无脑全保护。

**为什么它在 coding 语料里致命**：write/edit 的 tool-call **参数就是文件正文**；其 R 是"写入成功"小回执，**永远不会被别的原子 cites** → 必然满足"无组外入边" → A（携带文件正文）被永久罩住。T4 实测：A 侧 tool-call arguments 32.4K tok（write 25.5K + edit 4.2K）全部落在保护区内。

**代价与例外**：受保护内容仍可被 ① 版本链去重（重复 A 文本的旧版整组淘汰）② 闭包归并（整闭包退休）③ tombstone-merge 间接处理；但**单点强剪（force）穿不透**。

### 11.2 墓碑 / checkpoint（X）——结构性不可剪

**是什么**：`classifyUserMessage`（`:177`）把"非 argp U-info 且 `source.kind === 'plugin'`"的 user/message 判为 X。来源三类：① 官方 checkpoint（compaction-basic 的压缩摘要块）；② **ARGP 自己的压缩墓碑**（`compactCheckpointSource`）；③ 其他宿主插件注入的 user 消息。

**为什么不可剪**：
- X 本身已是"占位文本"——再剪不回收真实信息；
- 官方 checkpoint 是宿主协议载体（剪掉破坏 UI/resume 语义）；
- ARGP 墓碑是 recall 的索引锚——剪掉后模型看不到"此处曾有内容、可用 `recall_pruned(seq)` 取回"，可恢复性设计随之失效。

**它的正确治理方式不是"剪"而是"归并"**：`consolidateTombstones`（§11.8①，`:2034-2083`）在图剪**之前**把连续 ≥`tombstoneMergeMinRun`（默认 8）个可合并墓碑压成一条聚合墓碑；归并前校验 tool-pairing 平衡，不平衡即放弃（宁可不并）。历史病灶：run2 曾出现 1297/1310 surface 节点是墓碑（≈142K tok）——"墓碑地板单调累积"，已由本机制治理。

**实测体量（T4）**：4 个墓碑节点、504 字符 ≈ **168 tok** ——当前不是瓶颈；风险在长程/多次压缩后。

### 11.3 dialog-U（无 ask 覆盖的普通用户消息）

**是什么**：普通 U（`u.sourceSeq === undefined`，即 dialog 副本）在候选层需要 ask-exempt 放行，条件全部满足才可剪：① 存在 ask 覆盖者（首个 A 对其有 supporting 边）；② 位置 `pos < recencyCut`；③ `turn ≤ latestTurn − turnGuard`；④ **所有**保留入边都来自覆盖者（动态复核，`incoming.some(e => e.from !== coverer)` 即失格）。

**为什么保护**：用户消息是任务的"根"。剪掉任务陈述会让后续全部对话失去语义锚（模型不知道自己被要求做什么）。ask-exempt 是精细豁免：**提问式**请求且被后续 A 引用 → 说明其信息已被 A 吸收，可以剪。

**关键精度（勿误述为"永不参剪"）**：dialog-U 在**候选层**不可剪，但**闭包归并层能连带退休 root U**（`:1795-1796` 注释引 P5："自动闭包生命周期确实会连 root U 一起剪除"），条件是整闭包满足：非最后一个 root / 近 k=2 轮未被引用 / 无 external **critical** 入边。准确表述：**候选层保护，闭包层可整体退休**。

**实测体量（T4）**：4 条任务 U、771 字符 ≈ **256 tok** ——可忽略。
