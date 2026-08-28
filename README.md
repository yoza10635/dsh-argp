[English](README.en.md) | 中文

# dsh-argp — 双引擎上下文压缩：逐原子守卫压缩 + 引用图确定性剪枝

[![CI](https://github.com/yoza10635/dsh-argp/actions/workflows/ci.yml/badge.svg)](https://github.com/yoza10635/dsh-argp/actions/workflows/ci.yml)
[![GitHub Release](https://img.shields.io/github/v/release/yoza10635/dsh-argp)](https://github.com/yoza10635/dsh-argp/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

dsh-argp 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的第三方上下文压缩引擎（1.0.0 候选，双引擎形态）：

- **Stage-1 逐原子压缩（eager，每轮）**——轮末对当轮原子做"缩放"而非丢弃：模型按原子自选 `extract`（逐字摘录）/ `summary`（概括，丢弃项入账审计）/ `false`（保留原文），**确定性守卫裁定提案能否落地**——extract 缺任一高信号 token 即整体拒绝。LLM 只提议，永不销毁。
- **Stage-2 引用图剪枝（lazy，超阈值时）**——原子引用图（确定性 A→R 配对边 + 模型声明的语义 cites 边）上按反向拓扑序整原子摘除，**压缩阶段 0 次 LLM 调用**，压缩率精确兑现。
- **append-only 日志是唯一事实源**——被压/被剪内容原文永远在日志里，两级召回 `recall_summary` / `recall_detail`（逐字节一致，哈希测试锁定）随取随回。上下文是日志的一个渲染视图，不是历史本身。

## 为什么

摘要式压缩（LLM 重写历史）有三重代价：

1. **信息有损**——精确 token（路径、错误码、配置值）在改写中最先死，且不可找回；
2. **缓存全断**——重写后的历史使 system+前缀逐轮变化，跨轮 KV/prefix cache 从变化点起全部失效；
3. **压缩率失控**——摘要长度由模型心情决定，预算不可兑现。

ARGP 的回答：**LLM 在环内、但戴着镣铐**——它的输出永远是"不可信输入提案"，守卫按 verbatim 纪律裁决；**遗忘是确定性的**——0-LLM 图规则保证收敛与预算；**历史不可变**——append-only 日志承载全部原文，召回契约（never guess）兜底。

实测（30 轮合成多轮编码任务，四臂对照，spike 37）：四臂中唯一同时达成 **7/7 探针保真**且成本低于现役基线的臂是双引擎全开臂（A）；传统摘要基线（D）最便宜但探针 5/7——吞掉精确字符串与关键大意。**卖点不是"最便宜"，是"保真前提下最省"**（A 全成本分量 ≤ 基线 C；比 D 贵 3.39×——这个差距就是保真的价格，明码标价）。

## 核心机制

### Stage-1：PeratomCompressor（eager 熵降）

1. **确定性门控**（`gate.ts`）：纯谓词判定"该轮是否可压"（长 user 消息 / 超 512 字符 tool result / 非版本链成员）；LLM 只执行"怎么压"。
2. **逐原子决策**：单次 LLM 调用返回 `{seq, level, text}` 决策——`extract`（逐字子集拷贝，守卫硬拒缺失）/ `summary`（概括放行，丢弃 token 逐条入账 `summaryDropped` 供审核）/ `false`（显式不压，保原文）；长 user 消息走拆分（dialog 逐字抄写 + 余量聚合 U-info，空隙归 info）。
3. **no-op 守卫**：收益 ≤5% 的"全文照抄"副本视同 false，不 emit replace（0 收益替换白花 surface 换代）。
4. **tail-only 替换**：只允许 sourceEventSeqs ⊆ 当轮区间（越界即 bug，断言锁定）；前缀指纹测试证明 N 轮逐轮压缩后请求前缀稳定（缓存经济的生命线）。

### Stage-2：ArgpGraphEngine（lazy 图剪枝，0-LLM）

1. **原子化 + 建图**：确定性边（assistant → 其 tool result，经 toolCallId）+ 语义边（模型按契约输出的 `{"cites":[{"t":"前缀","l":"c|s|x"}]}`，四级分级 critical/supporting/contextual/isolated）。
2. **拓扑剪枝**：反复摘除入度为 0 的原子（边等级 → 有效重要性 → 最近引用轮次排序），被剪引用方的出边消失、下游逐 pass 解锁；闭包生命周期（ACTIVE→COMPLETED→PRUNABLE→PRUNED）整闭包退休已完成任务。
3. **压缩率精确兑现**：window = contextWindow×0.8 触发、retain = window×0.2 目标；降级链 lifecycle→summarize→force→fail 收敛到预算或显式失败，实测 200K→160K 触发→32K 保留精确落地。

### 桥接与召回

- **CiteDeclarer**（每轮）：模型按窗口声明跨轮引用边，经 `injectEdges` 通道喂给 Stage-2——实测召回效率 ≈ 无边臂的 2.6×（zoom 精准定位）。
- **RecallZoom**：`recall_summary(seq)`（读压缩态）/ `recall_detail(seq)`（日志原文逐字节）；4 倍制预算（summary 预算 = 4×detail），超限返回引导文案而非硬拒。历史被剪原子另有 `recall_pruned` / `list_pruned`。

## 模型要求（如实版）

per-atom 的拆分/压缩决策质量依赖模型指令遵循能力；**守卫保证任何模型上都"不会压坏"（错误方向只往少压错），但收益随服从率缩放**：

- 实测基准：本地 Qwen3.6-35B-A3B / Qwen3.8-27B 全链路 30/60 轮 0 error、探针 7/7；拆分抄写表示法解析失败 0%（vs 区间定位法 72%）。
- **DeepSeek 系模型的已知特性**：系统提示词与用户指令冲突时（如任务 prompt 写 "nothing else"）cites 声明可为 0——语义选择性归零，但 Stage-1 守卫压缩与 Stage-2 确定性剪枝照常工作、不变式全过（50 轮 v4-flash 实证）。任务 prompt 给 cites 留出口后声明率恢复（10 轮实测 43.6%）。
- spike 38 探针（info 契约服从率）随 1.0.0 复核轮在 DeepSeek 上补测。

## 安装与挂载

从 npm 安装（当前发布版 `v0.3.2` 单引擎形态；双引擎形态随 1.0.0 发布，本仓库 HEAD 已含）：

```bash
dsh plugin --profile <name> add dsh-argp
```

profile 的 `cordis.patch.yml` 中禁用 stock 摘要器：

```yaml
- id: compaction-basic
  disabled: true
```

> 挂载由包的 bundle patch（`cordis.patch.yml`）负责（`insert` 创建 entry）；profile 层只做配置覆盖（modify），不要再 insert（否则 `duplicate loader entry id`）。

### 双引擎配置（1.0.0 形态）

Stage-1 组件默认跟随环境变量解析端点（`DEEPSEEK_API_KEY`）；生产建议显式指向宿主 dsh-llm：

```yaml
- id: dsh-argp
  config:
    compressor:
      llm: { provider: deepseek-official, model: deepseek-v4-flash }   # dsh-llm 后端
    declarer:
      llm: { provider: deepseek-official, model: deepseek-v4-flash }   # 可指向独立 lite 档
```

不配 `llm` 时按 `endpoint`/`apiKey` config 或环境变量走 OpenAI 兼容直连（本地 llama.cpp 实验形态，行为不变）。Stage-2 预算默认比例驱动（window=ctx×0.8 / retain=window×0.2），无须硬编码。

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

- E（零压缩）vs A（30 轮，模型可见口径）：末轮水位 A = E 的 40%（降幅 59.8%），均值降幅 39.2%；差距自 T11 单调拉大。
- 60 轮放开对比：末轮差距 32.6%、均值 36.6%；per-atom 使图引擎硬剪推迟 5 轮（T14→T19）且剪后维持更低水位。
- **轮次放大（固定窗口 → N× 轮）主判据：P5-bis 实验待跑**（判据已预注册：`docs/p5bis-turn-amplification.md`；60 轮轨迹外推 16K 档 ≈2.8×、大窗口渐近 ≈1.4×，实测数字填入后此处更新）。**本节数字落地前，对外请勿引用"N 倍轮次"。**

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

`npm run check` = typecheck + smoke + 单测（2026-08-28 基线 184 用例）。每个数字都带产物路径（见 `docs/publication-plan.md` 台账与各实验记录）。

## 平台缺口反馈（给 dsh）

tool/result 替换无结构化元数据通道（B-1）、compaction/prune 游离于事务状态机（B-3）、headless 测试装配 tokenMeter 静默失效（B-4）、摘要空流（B-5）、surface 窗口丢弃无痕迹（B-6）——详见 [`docs/dsh-api-feedback-2026-08-17.md`](docs/dsh-api-feedback-2026-08-17.md)。

## 已知限制

- **B-6 窗口截断盲区**：未被 ARGP 替换的 live 节点在逼近 contextWindow 时被请求组装层截掉最旧部分、不留痕迹——`recall_pruned` 取不回它们。缓解：比例预算前移触发点；根治在 dsh 侧（B-6 立案中）。
- **模型依赖（如实版，见上）**：守卫保证安全，收益依赖服从率；lite 档多模型分工的服从率未实测（台账 D21）。
- **per-atom 输出税**：Stage-1 每轮的压缩调用是 side-channel 成本（30 轮实测 completion 7.2K tokens，不进上下文但计入总成本）；dsh-llm 后端的 usage 已入 record，spike 汇总口径接入中。
- **tombstone 两跳召回**：占位文本经多轮演化后原 seq 可能丢失，`recall_pruned(seq)` 需正确编号（B-6 落地后一并消除）。

## License

MIT
