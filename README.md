[English](README.en.md) | 中文

# dsh-argp — 双引擎上下文压缩：逐原子守卫压缩 + 引用图确定性剪枝

[![CI](https://github.com/yoza10635/dsh-argp/actions/workflows/ci.yml/badge.svg)](https://github.com/yoza10635/dsh-argp/actions/workflows/ci.yml)
[![GitHub Release](https://img.shields.io/github/v/release/yoza10635/dsh-argp)](https://github.com/yoza10635/dsh-argp/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

dsh-argp 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的第三方上下文压缩引擎（双引擎形态；**npm 默认 = 0-LLM 图剪枝，即仅 Stage-2**，Stage-1 经 `peratom` 配置块启用，见"安装与挂载"）：

- **Stage-1 逐原子压缩（eager，每轮）**——轮末对当轮原子做"缩放"而非丢弃：模型按原子自选 `extract`（逐字摘录）/ `summary`（概括，丢弃项入账审计）/ `false`（保留原文），**确定性守卫裁定提案能否落地**——extract 缺任一高信号 token 即整体拒绝。LLM 只提议，永不销毁。
- **Stage-2 引用图剪枝（lazy，三级触发）**——原子引用图（确定性 A→R 配对边 + 模型声明的语义 cites 边）上按反向拓扑序整原子摘除，**压缩阶段 0 次 LLM 调用**，压缩率精确兑现；触发为三级阶梯：轮初主动 / 轮中压力剪 / 截断自动续写（见"三级触发"）。
- **append-only 日志是唯一事实源**——被压/被剪内容原文永远在日志里，两级召回 `recall_summary` / `recall_detail`（逐字节一致，哈希测试锁定）随取随回。上下文是日志的一个渲染视图，不是历史本身。

## 为什么

摘要式压缩（LLM 重写历史）有三重代价：

1. **信息有损**——精确 token（路径、错误码、配置值）在改写中最先死，且不可找回；
2. **缓存全断**——重写后的历史使 system+前缀逐轮变化，跨轮 KV/prefix cache 从变化点起全部失效；
3. **压缩率失控**——摘要长度由模型心情决定，预算不可兑现。

ARGP 的回答：**LLM 在环内、但戴着镣铐**——它的输出永远是"不可信输入提案"，守卫按 verbatim 纪律裁决；**遗忘是确定性的**——0-LLM 图规则保证收敛与预算；**历史不可变**——append-only 日志承载全部原文，召回契约（never guess）兜底。

实测（30 轮合成多轮编码任务，四臂对照，spike 37）：四臂中唯一同时达成 **7/7 探针保真**且成本低于现役基线的臂是双引擎全开臂（A）；传统摘要基线（D）最便宜但探针 5/7——吞掉精确字符串与关键大意。**卖点不是"最便宜"，是"保真前提下最省"**（A 全成本分量 ≤ 基线 C；比 D 贵 3.39×——这个差距就是保真的价格，明码标价）。

> 实现方式（双引擎管线、反向拓扑剪枝、shadow-price 契约、模块职责）见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 核心机制

### Stage-1：PeratomCompressor（eager 熵降）

1. **确定性门控**（`gate.ts`）：纯谓词判定"该轮是否可压"（长 user 消息 / 超 512 字符 tool result / 非版本链成员）；LLM 只执行"怎么压"。
2. **逐原子决策**：单次 LLM 调用返回 `{seq, level, text}` 决策——`extract`（逐字子集拷贝，守卫硬拒缺失）/ `summary`（概括放行，丢弃 token 逐条入账 `summaryDropped` 供审核）/ `false`（显式不压，保原文）；长 user 消息走拆分（dialog 逐字抄写 + 余量聚合 U-info，空隙归 info）。
3. **no-op 守卫**：收益 ≤5% 的"全文照抄"副本视同 false，不 emit replace（0 收益替换白花 surface 换代）。
4. **tail-only 替换**：只允许 sourceEventSeqs ⊆ 当轮区间（越界即 bug，断言锁定）；前缀指纹测试证明 N 轮逐轮压缩后请求前缀稳定（缓存经济的生命线）。

### Stage-2：ArgpGraphEngine（lazy 图剪枝，0-LLM）

1. **原子化 + 建图**：确定性边（assistant → 其 tool result，经 toolCallId）+ 语义边（模型按契约输出的 `{"cites":[{"t":"前缀","l":"c|s|x"}]}`，四级分级 critical/supporting/contextual/isolated）。
2. **拓扑剪枝**：反复摘除入度为 0 的原子（边等级 → 有效重要性 → 最近引用轮次排序），被剪引用方的出边消失、下游逐 pass 解锁；闭包生命周期（ACTIVE→COMPLETED→PRUNABLE→PRUNED）整闭包退休已完成任务。
3. **压缩率精确兑现**：触发线 window = contextWindow×0.8（默认）、保留目标 retain = window×0.2；触发时机是三级阶梯（见下节"三级触发"）；降级链 lifecycle→force→fail（summarize 档是恒返回 null 的 stub——A6 保守选项 a 不实现，`enableSummarize` 默认 false）收敛到预算或显式失败，实测 200K→160K 触发→32K 保留精确落地。

### 三级触发（Stage-2 触发阶梯）

Stage-2 的"lazy"不是单一阈值检查，而是三级阶梯（1.4.0 引入、1.5.0 修订）：

1. **轮初主动（L1）**：只在每轮首个 pre-step（`step === 1`）做压力判定，阈值 = window（默认 contextWindow×0.8）。估值**计入本步已 claim、尚未落盘进 surface 的 user 消息**——宿主先 claim 新 user 消息再 dispatch pre-step，轮初拿到的是精确内容而非预测，用户轮初的大段粘贴不会漏；轮初同时跑 per-atom LLM pass（原子降熵）+ 图剪。
2. **轮中压力剪（L1'，0-LLM）**：`midTurnPrune` 默认 **true**——`step > 1` 且压力达标时**只做 0-LLM 图剪**（不跑 per-atom LLM pass——那是 79s–3min 的阻塞，轮内不划算），并把 `turnGuard` 放宽到 `midTurnTurnGuard`（默认 **0**，允许剪本轮的旧 A/R；`recencyGuard` 照常保护最新节点）。超额的来源恰恰是本轮的 tool result，旧守卫（turnGuard=1）把整轮保护起来正是 1.3.x 轮中剪"几乎无效"的根因；剪落在那个 pre-step ⇒ 同一个 step 的请求即已瘦身 ⇒ 天然自动继续本 turn。
3. **截断自动续写（L3）**：输出被外部钳制（`finish=max-tokens` 且 `outputTokens <` 本次请求的 `maxTokens` = 宿主/适配器把输出预算啃小了，容量压力的真信号）时：若本 turn 随后要结束（`agent/turn-stopping` 钩子）⇒ 就地强制剪 + `steer` 一条续写消息，**同一个 turn 继续推进**（用户不必再发"继续"）；否则（turn 还在跑）⇒ 下一个 pre-step 强制剪。续写文案可用 `continuationNotice` 覆盖（空串 = 只剪不续）；上限 `reactiveRetries`（默认 **2**，每次"连续被钳" episode 内，第 2 次起放宽 recency/turn 守卫，用尽交回 overflow 路径）。

配置旋钮：`midTurnPrune`（默认 true）/ `midTurnTurnGuard`（默认 0）/ `continuationNotice`（默认内置一句）/ `reactiveRetries`（默认 2）；1.4.0 的 `midTurnActive` 保留为兼容别名（true = 轮中剪开 + 沿用默认守卫的 1.3.x 对照档，false = 关）。

### 桥接与召回

- **CiteDeclarer**（每轮）：模型按窗口声明跨轮引用边，经 `injectEdges` 通道喂给 Stage-2——实测召回效率 ≈ 无边臂的 2.6×（zoom 精准定位）。
- **RecallZoom**：`recall_summary(seq)`（读压缩态）/ `recall_detail(seq)`（日志原文逐字节）；4 倍制预算（summary 预算 = 4×detail），超限返回引导文案而非硬拒。历史被剪原子另有 `recall_pruned` / `list_pruned`。

## 模型要求

per-atom 的拆分/压缩决策质量依赖模型指令遵循能力；**守卫保证任何模型上都"不会压坏"（错误方向只往少压错），但收益随服从率缩放**：

- 实测基准：本地 Qwen3.6-35B-A3B / Qwen3.8-27B 全链路 30/60 轮 0 error、探针 7/7；拆分抄写表示法解析失败 0%（vs 区间定位法 72%）。
- **DeepSeek 系模型的已知特性**：系统提示词与用户指令冲突时（如任务 prompt 写 "nothing else"）cites 声明可为 0——语义选择性归零，但 Stage-1 守卫压缩与 Stage-2 确定性剪枝照常工作、不变式全过（50 轮 v4-flash 实证）。任务 prompt 给 cites 留出口后声明率恢复（10 轮实测 43.6%）。

## 安装与挂载

从 npm 安装。**npm 默认 = 0-LLM 图剪枝（仅 Stage-2）**：包的 bundle patch（`cordis.patch.yml`）只挂图引擎（config 仅 `maxPasses: 256` / `recencyGuard: 10`，无 `peratom` 块），Stage-1 三管线默认不挂载：

```bash
dsh plugin --profile <name> add dsh-argp
```

profile 的 `cordis.patch.yml` 中禁用 stock 摘要器：

```yaml
- id: compaction-basic
  disabled: true
```

> 挂载由包的 bundle patch（`cordis.patch.yml`）负责（`insert` 创建 entry）；profile 层只做配置覆盖（modify），不要再 insert（否则 `duplicate loader entry id`）。

### 启用 Stage-1（双引擎）

生产挂载路径是**引擎构造期经 `config.peratom` 自挂**：`peratom` 块为对象时，Stage-1 三管线（compressor / declarer / zoom）在构造期挂载并内部接线；`peratom: false` / `null` = 不挂（与缺省同语义）。在 profile 层 modify 加 `peratom` 嵌套块（改后须开新会话生效）：

```yaml
- id: dsh-argp
  config:
    peratom:
      compressor:
        llm: { provider: deepseek-official, model: deepseek-v4-flash }   # dsh-llm 后端
      declarer:
        llm: { provider: deepseek-official, model: deepseek-v4-flash }   # 可指向独立 lite 档
      # zoom: {}   # 两级 recall；块内缺省即挂载
```

`llm` 子块可省：`llm` 与 `endpoint`/`apiKey` 两路皆缺时**自动跟随宿主路由**（1.3.0 的 `autoDshLlmSpec`：真会话里现取 `agent.options.{provider,model}` + 宿主 `ctx.llm` 服务，宿主换模型自动跟随）；三路都解不出时组件自然 disabled（零网络）。配了 `llm` 走宿主 dsh-llm（生产形态）；否则按 `endpoint`/`apiKey` config 或环境变量走 OpenAI 兼容直连（本地 llama.cpp 实验形态）。Stage-2 预算默认比例驱动（window=ctx×0.8 / retain=window×0.2），无须硬编码。

`presetClean` **默认开启**：挂载期对仍挂 stock 摘要器的 shipped preset 生成净化副本 `<id>-argp`（摘除 `compaction-basic`/`tool-result-pruner`、保留 `command-compact`——`/compact` 自动指向 ARGP 图剪），幂等、fail-soft；`presetClean: false` 关闭。

## 验证结果

### 四臂对照（30 轮合成多轮编码，本地 Qwen3.6-35B-A3B，spike 37）

| 臂 | 配置 | 探针 | 成本（空闲价） | 结论 |
|---|---|---|---|---|
| **A 双引擎全开** | compressor + declarer + graph + zoom | **7/7** | ¥0.454 | 唯一 7/7 且 ≤ 基线成本的臂 |
| B 无边 | declarer 关 | 7/7 | ¥0.556 | 召回次数 31 vs A 的 12（declarer ≈2.6× 更省） |
| C 现役基线 | 仅 graph（溢出才剪） | 6/7（R2 漏检） | ¥0.802 | A 全成本分量 ≤ C |
| D 摘要基线 | dsh 原生 BasicCompactionEngine | 5/7（丢精确 token + 大意） | ¥0.134 | 最便宜但丢保真——反衬"保真前提下最省" |

防干涉：A/B/C 三臂 append-origin 原文零替换（A 140 / B 154 / C 216 事件）；前缀稳定：A 臂 21 个主请求指纹全同。

### 水位与轮次放大

固定窗口（16K tok）下的实测行为（P5-bis，本地 Qwen3.6-35B-A3B，2026-08-28；证据细节见 CHANGELOG）：

- **轮数显著放大**：零压缩对照在 ~20 轮触窗终止，双引擎同预算下持续存活至满预算（~60 轮量级）——固定窗口下的可持续轮数呈数量级提升（下界口径，禁裸引用"数倍"，须带窗口/任务/模型三要素）。
- **缓存逐请求前缀稳定性零劣化**：双引擎与零压缩对照的逐请求前缀指纹分布一致；压缩事件仅引入一次性重算税，无持续累积劣化。

### Graph 引擎历史验证（v0.3.x，DeepSeek v4-flash / Qwen3.8-27B）

50 轮 t-long：U 锚点 7/7、needle 7/7（5/7 经 recall 找回）、4 事务 0 error、压缩目标精确兑现（32K）；200K 主流档成本 ¥2.695 vs 基线 high ¥3.087（该基线含 77% 空流 error，系平台 B-5 缺陷——对照数字按此口径解读，disabled 档 ¥3.19 为更干净的对照）。

## 复现

| 实验 | 命令 | 验证内容 |
|---|---|---|
| 四臂对照（需本地模型） | `ARGP_ARM=A\|B\|C\|D\|E node spike/37-peratom-three-arm.ts` | 探针保真、成本三元组、防干涉、K_no/放大 |
| per-atom soak | `npm run spike36` | 门控/链/守恒/前缀/VK-atom 八判决 |
| 50 轮 t-long | `ARGP_DEEPSEEK_THINKING=enabled node spike/06-tlong.ts` | L1/L2/L3 不变式、锚点/needle、精确预算 |
| 合成 0-LLM | `npm run spike8a` | 单事务零 LLM 调用 |
| 逐原子审计 | `node spike/atom-audit.mjs <产物目录>` | 事件驱动逐原子压缩/剪枝明细 |

`npm run check` = typecheck + smoke + 单测（202/202 全绿，2026-09-02）。每个数字都带产物路径（证据落点见 `CHANGELOG.md`）。

## 平台缺口反馈（给 dsh）

tool/result 替换无结构化元数据通道（B-1）、compaction/prune 游离于事务状态机（B-3）、headless 测试装配 tokenMeter 静默失效（B-4）、摘要空流（B-5）、surface 窗口丢弃无痕迹（B-6）——正式记录见 [dsh Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions)（#1090 及关联帖）。

## 已知限制

- **B-6 窗口截断盲区**：未被 ARGP 替换的 live 节点在逼近 contextWindow 时被请求组装层截掉最旧部分、不留痕迹——`recall_pruned` 取不回它们。缓解：比例预算前移触发点；根治在 dsh 侧（B-6 立案中）。
- **模型依赖（如实版，见上）**：守卫保证安全，收益依赖服从率；lite 档多模型分工的服从率未实测（台账 D21）。
- **per-atom 输出税**：Stage-1 每轮的压缩调用是 side-channel 成本（30 轮实测 completion 7.2K tokens，不进上下文但计入总成本）；dsh-llm 后端的 usage 已入 record，spike 汇总口径接入中。
- **tombstone 两跳召回**：占位文本经多轮演化后原 seq 可能丢失，`recall_pruned(seq)` 需正确编号（B-6 落地后一并消除）。

## 问题反馈

- **Bug**：开 [Issue](https://github.com/yoza10635/dsh-argp/issues)。附 `dsh --version`、本包版本、profile 配置（`windowTokens`/`retainTokens` 等）与最小复现步骤，定位会快很多。
- **设计讨论 / 使用问题**：开 [Discussion](https://github.com/yoza10635/dsh-argp/discussions)。

## License

MIT
