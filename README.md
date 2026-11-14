[English](README.en.md) | 中文

# dsh-argp 2.0 — 因子压缩引擎：实体标签剪枝 + 散文浓缩 + 出口闸

[![CI](https://github.com/yoza10635/dsh-argp/actions/workflows/ci.yml/badge.svg)](https://github.com/yoza10635/dsh-argp/actions/workflows/ci.yml)
[![GitHub Release](https://img.shields.io/github/v/release/yoza10635/dsh-argp)](https://github.com/yoza10635/dsh-argp/releases)
[![npm version](https://img.shields.io/npm/v/dsh-argp)](https://www.npmjs.com/package/dsh-argp)
[![npm downloads](https://img.shields.io/npm/dm/dsh-argp)](https://www.npmjs.com/package/dsh-argp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**dsh-argp 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的第三方上下文压缩引擎**。2.0 是 factor 引擎的干净形态：**工具结果按实体标签确定性剪枝（0-LLM）**、**散文只在压缩事务内一次性浓缩（唯一 LLM 通路、双闸把关）**、**出口闸保证必然超窗的请求根本不发出**；被剪原文永远留在 append-only 日志，按标签 `recall_history` 逐字取回。

> **1.x 图引擎已退役。** 老方案（stage-2 引用图 + peratom 三管线 + cites 边）冻结在 **npm latest `1.11.2`**（tag `v1.11.2`），不再进入 2.x 主线；老 profile 里的 graph 旋钮在 2.0 下宽容读 + 告警忽略。历史 CHANGELOG 保留。

![dsh-argp 概览](https://raw.githubusercontent.com/yoza10635/dsh-argp/main/.github/assets/argp-overview.svg)

```bash
dsh plugin --profile <name> add dsh-argp    # 安装即挂；会话里输入 /argp 查看实时状态
```

## 三个机制

- **R 贴标剪枝（主体，0-LLM）**——工具结果按实体身份贴标签（`document:<path>` / `command:<family>` / `errorcode:<CODE>` / `scope:<dir>`），按"过期读、被新版本取代、非焦点轮"的确定性判据打分，把可剪的 R 换成一行最小桩（`[已剪·因子 read → document:…（需要原文时 recall_history(…)）]`）。**A 永不入剪枝区间**（散文归浓缩链管），U 受焦点/轮次保护。词表 note 只在压缩事务收尾刷新（缓存断点频率=压缩频率）。
- **散文浓缩（唯一 LLM 摘要通路）**——只在压缩事务内触发，双闸合取：①散文（system+对话散文）占声明窗 ≥50%；②anchored 总上下文 ≥ `windowRatio×声明窗`。one-shot 原生式摘要，barrier/受保护跨度不动；空输出或异常**保原文**（宁缺勿错）。
- **§9.37 出口闸**——pre-step 位（上一请求 usage 已锚、下一请求未发）做确定性容量算术：anchored 投影（含本步增量）≥ 声明窗 − 输出预算 − 2% 提前量 ⇒ **请求根本不发**，先走标准压缩事务再发。输出预算三源取 max（`agent.options.maxTokens` / `request/response` 观测 / `resolveModelInfo().defaultMaxTokens`），全缺退 0.25×窗。400 overflow 网保留为最后兜底。

召回面只有两个工具：**`recall_history`**（按标签取回日志原文，交集优先、cursor/epoch 续读、epoch 漂移如实告警）与 **`list_labels`**（词表下钻）。没有 seq 通道——标签是唯一地址；两者共享字符预算（单次 5% / 累计 10% 窗口，耗尽显式说明）。

## 为什么

摘要式压缩（LLM 重写历史）有三重代价：

1. **信息有损**——精确 token（路径、错误码、配置值）在改写中最先死，且不可找回；
2. **缓存全断**——重写后的历史使 system+前缀逐轮变化，跨轮 KV/prefix cache 从变化点起全部失效；
3. **压缩率失控**——摘要长度由模型心情决定，预算不可兑现。

factor 的回答：**剪枝是确定性的**——同输入同输出、0 LLM、可复算；**遗忘可撤销**——桩只是一行标签，原文在 append-only 日志里按字节取回；**LLM 只做它擅长的一件事**——散文浓缩，且只在事务内、双闸都过线时才发生。

## 三方案实测对照（T24-J，2026-11-14/15；v2.0.0 列 = 出口闸关配对定谳值）

同一 46 轮工作量（同提示词、同材料、全串行单臂、同端点/模型/窗 262,144）、逐轮账单口径
`miss + 0.06×cache + 3×output`、cache 命中率与峰值取全程实际请求：

| 维度 | v1.11.2 | 原生（宿主 compaction-basic） | v2.0.0 |
|---|---|---|---|
| 压缩机制 | LLM 摘要 ×6 + 连续剪重写 ×768 + 系统头逐轮重写 | est 估算预钳 prune ×45 + LLM 摘要 ×6（每 5-6 轮一次） | **确定性标签组剪（0 LLM）** + 散文浓缩双闸 + 轮界预算触发器；出口闸关（配对臂配置） |
| 墙钟 | 114.7 min | 61.8 min | **43.3 min（−62% vs 1.x）** |
| 账单（miss+0.06c+3o） | 13.09M | 5.72M | **5.815M（−56% vs 1.x；vs 原生 +1.7% 噪声级）** |
| 账单（DeepSeek 闲时 1/.02/4） | 11.58M | 4.36M | **3.69M（−68% vs 1.x；−15% vs 原生，全场最低）** |
| 前缀缓存命中 | 0.833（系统头重写逐轮毁缓存） | 0.956 | **0.978** |
| 峰值 KV 驻留上下文（cached_tokens 口径，占申报窗） | 78.9%（raw 请求规模 80%） | 50.0%（raw 51%） | **98.4%（= 窗 − 4,096 块对齐，双臂复现；raw 请求规模峰值 116%）** |
| 遗忘可撤销 | ✗ 摘要改写不可逆 | ✗ | ✓ `recall_history` 按标签逐字取回 |
| 材料针记忆（禁工具轮） | 0/12 | 0/12 | 1/12 |
| 长程记忆（允许召回轮） | **7/10**（老 seq 召回栈，但背后是 2.4× 账单/2.3× 墙钟） | 2/10（结构性失忆，诚实"不确定"） | 3/10（人审：Q1/Q2/Q9 逐字命中，余 7 问召回预算未及未答） |
| 隐藏工件套件（T0） | 19/20 | 18/20 | 17/20（merge3 形态差 + plugin_error_isolated + cli_error_line_format） |

读法与注意事项：每臂 n=1（单跑，非多次均值）；墙钟含昼夜服务器噪声（±7%，已用无压缩轮对照校验）；
1.x 的 P45 优势来自 seq 直取召回栈——能力真实，但价格不成比例；材料针禁工具轮（T44）测的是
"无召回通道时的记忆"，不是压缩质量本身（措辞实验见报告 §6.6）。完整七臂数据与逐轮明细见
`CHANGELOG` 2.0.0-alpha.5 与仓库报告 §12–13。
v2.0.0 列读法 = egress0b 配对定谳值（同 profile/env/运行时跑满 46 轮；**出口闸关配置**，门开
缺省家族带 43.8–51.6min / 5.39–6.62M 详见报告 §6–9）；单跑结论必须过三道检验（轮级散布带→
同配置复跑→配对全程）；run1（+50% bill）已归档为离群轨迹上界样本，不入表。
峰值口径注（用户裁定 2026-11-15）：上下文按**服务端 cached_tokens（KV 驻留前缀）**计——
七臂无一越窗（v2.0.0 = 258,048 = 窗−4,096 块对齐，双臂逐 token 复现；门开家族 71.9–72.7%）；
raw 请求规模（cached+fresh）峰值 305K/116% 只是请求尺寸，服务端如何处置其位置语义属端点
内部（admission=raw 计数，臂窗口/探针窗口行为不一致待运营侧核实）。T0 注：三个失败全是
**未锁形态的轨迹判定**（merge3 返回类型 spec 未锁、测试容错 3 种、模型选了第 4 种 dataclass；
CLI 错误行包 CB 码系超纲约定（材料只定义异常码），alpha5 恰好超额实现；plugin_error_isolated
为 alpha 家族共病）——非压缩/召回质量回归。P45 注：auto 提取按行截断，3 条实 HIT 误记
MISS，人审以 transcript 原文为准。后续 tag 口径 = **2.0.0**。

**第 7 臂——出口闸价值定谳（egress0，2026-11-14）**：alpha5 同款 + `ARGP_FACTOR_EGRESS=0`
（出口闸/pre-send 拦截关；预算触发器仍在，实跑 5 笔 0-LLM 组剪）+ length-stop 恢复链兜底：
**bill 8.59M（+50%）/ 墙钟 60.6min（+17%，慢回原生水平）/ cache 体积 +65%（89.2M vs 54.2M）/
峰值 305K = 申报窗 116%**；46/46 零死亡、零撞墙、零 max-tokens。
**配对复跑定谳（egress0b，同 profile/env/运行时跑满 46 轮）**：471 步 / bill 5.815M / 墙钟
43.3min——全部落 rc.1 家族带内，与 alpha5 差 **+1.6%（噪声级；DeepSeek 闲时口径反而 -5%）**
⇒ run1 的 +50% = 离群轨迹（「勤勉取证」风格的会话级抽签，T03 逐案实锤），非门关效应。
真正的门关结构性签名**双臂复现**：上下文天花板 ~305K（run1 T32 = 305,101 / egress0b T39 =
305,008，Δ0.03% 跨轨迹——预算触发线 + 轮内协议增长的决定性组合）vs 门开 191.7K；本端点
cache-aware admission 下无害（fresh 峰 47K 远离 fresh 墙），严格 admission 端点上即 400 →
溢出链兜底（设计场景）。**出口闸最终定位：严格 admission 端点的 pre-send 防线 + 上下文
天花板压制；经济面在 cache-aware 端点上无显著差**。`ARGP_FACTOR_EGRESS` 缺省开的推荐
不变（理由：端点保险，非省成本）。
运行时注记：本端点对运行时路径的 admission 呈**前缀缓存感知**（cache-assisted 305K 放行、
fresh 峰值仅 47K；无缓存探针按总量 400）——申报窗 262,144 对运行时路径实质是 fresh 预算；
length-stop 恢复链在此世界无事可救（零触发），其兜底价值在严格 admission 端点（探针 400 语义）。
数据：报告 §12 与探针 `wallhit-probe3-admission.json`。

## 工作方式

### 压缩事务（prune-tx）

一笔事务 = `compaction/start` → `compaction/summary` → 每个区间一次 `compaction/prune` + 对应 `replace` → `compaction/end`。宿主 `foldSurfaceProjection` 要求 `shadowedRange` 与 replace 范围**严格相等**（逐区间成对发射）。tool 桩克隆原 R 的 data 只改内文（保留 callId / role / id），配对 issuer A 的 tool_calls 防 400；事务尾把 usage 锚重置为 chars 估算，下一笔成功请求即重锚真 usage。

### 触发（两条信号 + 出口闸）

1. **手动 `/compact`**——全量剪（能剪多少剪多少，硬保护兜底）+ 散文浓缩。
2. **provider 400 `CONTEXT_WINDOW_EXCEEDED`**——强制剪一次后重试（`maxOverflowRetries` 缺省 1，对齐官方 compaction-basic）。
3. **§9.37 出口闸**——在请求发出前用 anchored 算术拦截"必然超窗"的发送，把 400 从触发器改回兜底网。

> pre-step 的**估算驱动**压力剪已退役（`ARGP_FACTOR_PRESSURE=1` 仅作旧世界对照臂）。破坏性改写只认上述确定性信号。

### 召回

`recall_history(labels)` 从**日志 append 根源**取原文（不是桩、不是摘要），每行带 `state=shadowed|live` 与命中标签；`list_labels(category)` 按 facet 列词表与覆盖数。预算耗尽、无命中、未知类别都**显式说明**，不静默空手。

## 模型要求

- **剪枝与出口闸不依赖模型**：任何模型上行为一致（0-LLM 确定性）。
- **散文浓缩**需要一条 compaction 用途的 LLM 路由：缺省自动跟随宿主 `agent.options.{provider,model}` + `ctx.llm`；路由不可用 ⇒ 浓缩 disabled、零网络、保原文。浓缩质量随模型指令遵循能力缩放，但失败方向永远是"少压"。
- 标签来自工具参数与输出（read/edit 路径、命令族、错误码），不要求模型配合输出任何引用协议。

## 安装与挂载

```bash
dsh plugin --profile <name> add dsh-argp
```

**安装即挂，无需手工配置**：包的 bundle patch（`cordis.patch.yml`）自带 `- id: compaction-basic / disabled: true`（关掉 stock 摘要器）并 `insert` 本插件；profile 层只做配置覆盖（modify），不要再 insert（否则 `duplicate loader entry id`）。

> **⚠️ 新版发布后 24 小时内安装，请显式指定版本。** pnpm 11 起 `minimumReleaseAge` 默认为 **1440 分钟（24h）**：刚发布的版本会被跳过，pnpm **静默回落到上一个已过冷却期的旧版本**——不报错，只是装错版本。报错里的版本号比 npm `latest` 旧，就是撞上了这个冷却期。解法：`dsh plugin --profile <name> add dsh-argp@<最新版本>`，或在 profile 的 `pnpm-workspace.yaml` 写 `minimumReleaseAgeExclude: [dsh-argp]`。

> **极简（minimal）preset 下不生效**：ARGP 在 `skipPresets` 列出的 preset 下退场——默认 `['minimal']`，历史保持原生态。要让 ARGP 在 minimal 下也生效，在 profile 层 modify 加 `config: { skipPresets: [] }`。

### 设置页旋钮（6 枚）

Settings → Plugins → ARGP 卡片（全部 volatile，改完即生效，无需重启）：

| 键 | 缺省 | 含义 |
|---|---|---|
| `windowRatio` | 0.8 | 触发线 = 声明窗 × 该值（出口闸的 ctx 线 / 浓缩闸二共用） |
| `retainRatio` | 0.2 | 压缩后保留目标 = 触发线 × 该值 |
| `charsPerToken` | 3.5 | 字符→token 估算比（anchored usage 在位时以其为准） |
| `focalTurns` | 1 | 焦点轮数：最新 N 轮的工具结果永不被剪 |
| `vocabTopN` | 10 | 词表 note 每类最多列几行（其余经 `list_labels` 可查） |
| `recallLimit` | 5 | `recall_history` 未给 limit 时的缺省取回条数（上限 20） |

### 评测/调试环境变量（构造期快照，切换须重挂）

| 变量 | 作用 |
|---|---|
| `ARGP_FACTOR_EGRESS=0` | 关出口闸（对照臂；结构效应 = 上下文天花板 305K vs 192K，经济面无显著差——缺省开 = 严格 admission 端点的 pre-send 防线） |
| `ARGP_FACTOR_PRESSURE=1` | 恢复旧 pre-step 估算驱动压力剪（旧世界复现） |
| `ARGP_FACTOR_TIER=tiered` | 焦点分级策略档（hard/medium 焦点带；缺省 flat） |
| `ARGP_FACTOR_CLIP=1` | C10 夹剪层（三态保留；缺省关） |
| `ARGP_PERATOM_A2_DEBUG=<dir>` | LLM wire 落盘（默认脱敏；`_FULL=1` 才含正文） |

### 查看状态：`/argp`

```text
ARGP 2.0.0-alpha.0 · engine: factor · preset: standard
budget: trigger 209.7k / retain 41.9k · now 88.4k (source=anchored)
prunes: 7 · last 3 ranges / 41 items / 12.8k→3.1k · pruned index 156
recall: 12 calls · 9 hits (75%)
```

`engine` 恒为 `factor`；`preset` 后附 `ARGP inactive` 表示命中 `skipPresets`。`source=anchored` 表示占用锚定在 provider 回报的真实 usage（最准）。手动压缩走宿主原生 `/compact`。

## 验证

- **T24-J 六臂对照（2026-11-14，46 轮 × 6 臂全串行完赛）**：alpha2/alpha3/alpha4/alpha5（2.0 factor 各代）+ 原生 compaction-basic + 1.11.2 老方案，同款 turns2 协议——上表数字出处；2.0 各代全程零死轮零 400，召回面 v2（alpha.4）实现零 empty 标签失配、召回预算跨轮重置被模型实战使用、长程记忆 6/10 全场 factor 最高。
- **第 7 臂 egress0（出口闸关 + length-stop 链兜底，同日完赛）**：bill +50%/墙钟 +17%/cache 体积 +65%，零压缩零撞墙——**出口闸缺省开为唯一合算配置**（对照表下"出口闸价值定谳"段）；length-stop 恢复链以 bench 克隆运行时（rc.3 asar 手术 + stub 双验证）随臂搭载，零触发符合预期。
- **回归**：`npm run check` = typecheck + typecheck:spike + smoke + 单测（275 测，273 过 / 0 败 / 2 skip）+ build；出口闸 EG-1…14b 含冷 resume 回填锁；召回面 v2 装配四不变量与预算跨轮重置有变异锁。
- 历史 1.x 图引擎的实测（四臂 7/7 探针、50 轮 t-long 等）见 CHANGELOG 与 git 历史；它们**不是 2.0 的数字**，不可直接引用。

## 已知限制

- **B-6 窗口截断盲区**：未被替换的 live 节点在逼近 contextWindow 时被请求组装层截掉最旧部分、不留痕迹——它们不在剪枝词表里，标签召回取不回。缓解：比例预算前移触发点；根治在 dsh 侧（B-6 立案中）。
- **散文浓缩的输出税**：浓缩是唯一 LLM 调用，only-in-transaction；摘要过长会吃掉节省，闸一（散文≥50%）与 20480 输出预算共同限幅，极端长文仍可能不划算。
- **无实体标签的内容不可剪**：纯聊天、无路径/命令/错误码的输出不会被 R 剪枝触及，只能等散文浓缩。这是"标签是唯一地址"的另一面（fail-closed：不猜身份）。
- **旧日志读侧**：老墓碑文法（v1.3.x–v1.7.x）、老 `data.argpCites` 仍可读；但 2.0 不再生成它们。

## 复现

| 实验 | 命令 | 验证内容 |
|---|---|---|
| 全量门 | `npm run check` | typecheck / spike 类型 / smoke / 275 测 / 构建 |
| 出口闸单测 | `npm run test -- --test-name-pattern=EG-` | 三源预算、冷 resume、hatch 互斥 |
| 语料回放 | `node --import ./scripts/ts-import-rewrite-loader.mjs spike/50-t2-replay.ts` | 离线重放（语料目录缺失时优雅跳过） |

1.x 的图臂/peratom 实验脚本已移入 `spike/retired-1x/`（**不参与编译**，仅留档；其结论在 CHANGELOG 与 git 历史里）。

## 问题反馈

- **Bug**：开 [Issue](https://github.com/yoza10635/dsh-argp/issues)。附 `dsh --version`、本包版本、profile 配置（`windowTokens`/`retainTokens` 等）与最小复现步骤。
- **设计讨论 / 使用问题**：开 [Discussion](https://github.com/yoza10635/dsh-argp/discussions)。

## License

MIT
