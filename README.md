[English](README.en.md) | 中文

# dsh-argp — dsh 的上下文压缩插件

[![CI](https://github.com/yoza10635/dsh-argp/actions/workflows/ci.yml/badge.svg)](https://github.com/yoza10635/dsh-argp/actions/workflows/ci.yml)
[![GitHub Release](https://img.shields.io/github/v/release/yoza10635/dsh-argp)](https://github.com/yoza10635/dsh-argp/releases)
[![npm version](https://img.shields.io/npm/v/dsh-argp)](https://www.npmjs.com/package/dsh-argp)
[![npm downloads](https://img.shields.io/npm/dm/dsh-argp)](https://www.npmjs.com/package/dsh-argp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**dsh-argp 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的第三方上下文压缩插件。** 工具结果按实体标签**确定性剪枝（0 LLM）**，散文只在压缩事务内**一次性浓缩**，出口闸拦住"必然超窗"的请求；被剪掉的原文留在 append-only 日志里，模型可以按标签用 `recall_history` 逐字取回。

> 1.x 图引擎已退役：老方案冻结在 npm **`1.11.2`**（tag `v1.11.2`）。2.x 只维护 factor 引擎；老 profile 里的 graph 旋钮会被宽容读取并告警忽略。

## 安装

```bash
dsh plugin --profile <name> add dsh-argp
```

**安装即挂，无需手工配置**：插件包自带 bundle patch（关掉宿主自带的 `compaction-basic` 并挂载本插件），profile 层只做配置覆盖。

**宿主要求**：DeepSeek Harness `>=0.2.0-rc.1 <0.3.0-0`（预发布参与匹配；当前最新 `0.2.2-rc.3` 已实测）。

> **发布后 24 小时内安装，请显式指定版本。** pnpm 11 的 `minimumReleaseAge` 默认为 24 小时，刚发布的版本会被静默跳过、回落到旧版本。用 `dsh plugin --profile <name> add dsh-argp@<版本>`，或在 profile 的 `pnpm-workspace.yaml` 写 `minimumReleaseAgeExclude: [dsh-argp]`。

> **极简（minimal）preset 下默认不生效**（`skipPresets: ['minimal']`）。需要时在 profile 层 modify 加 `config: { skipPresets: [] }`。

## 上手

- 会话里输入 **`/argp`**：查看预算、触发线、剪枝与召回统计。
- **`/compact`**：手动压缩一次（全量剪 + 散文浓缩）。
- 自动压缩：上下文接近窗口时，出口闸先拦下超窗请求 → 执行标准压缩事务 → 再发；provider 400 只作最后兜底。
- 召回工具对模型自动可用：`recall_history`（按标签取回原文）、`list_labels`（浏览词表）。

```text
ARGP 2.0.0 · engine: factor · preset: standard
budget: trigger 209.7k / retain 41.9k · now 88.4k (source=anchored)
prunes: 7 · last 3 ranges / 41 items / 12.8k→3.1k · pruned index 156
recall: 12 calls · 9 hits (75%)
```

`source=anchored` 表示占用锚定在 provider 回报的真实 usage；`ARGP inactive` 表示命中 `skipPresets`。

## 零配置

2.0.0 起没有设置页旋钮：六项策略值固定为触发线 0.8×声明窗、保留目标 0.2、估算 3.5
字符/token、焦点 1 轮、词表每类 10 行、召回缺省 5 条。老 profile 里的同名键会被宽容
读取并告警忽略，行为始终按固化缺省运行。

## 它怎么工作

- **剪枝（0 LLM）**：工具结果按实体身份贴标签（`document:<path>` / `command:<family>` / `errorcode:<CODE>` / `scope:<dir>`），按"过期读、被新版取代、非焦点轮"确定性打分，可剪的换成一行标签桩；散文永远不剪，焦点轮受保护。
- **散文浓缩**：插件唯一的 LLM 通路，只在压缩事务内、两道闸都过线时触发（散文占声明窗 ≥50%，且上下文 ≥ 0.8×声明窗）；空输出或异常保原文。
- **出口闸**：在请求发出前用 anchored 算术判断"这一发必然超窗"，是就不发——先压缩再发；provider 400 只作兜底。
- **召回**：桩里带标签，原文从日志按标签逐字取回；两个召回工具共享单次 5% / 累计 10% 窗的字符预算，耗尽会显式说明。压缩后词表 note 会提示模型按标签召回。

相比 LLM 摘要式压缩：剪枝同输入同输出、可复算；遗忘可撤销（原文一直在日志里）；历史只在压缩事务里改写，不会被逐轮重写打碎前缀缓存。事务协议、宿主兼容面与不变量见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 实测对照（2026-11-14/15，46 轮同款工作量，本地 Qwen3.8-Flash-Next）

同一 46 轮工作量（同提示词、同材料、全串行单臂、同端点/模型/窗 262,144）；token 用量按 provider
回报 usage 全部分解列示，并由三项折算出一行 DeepSeek 闲时参考定价（元）：

| 维度 | v1.11.2 | 原生（宿主 compaction-basic） | v2.0.0 |
|---|---|---|---|
| 压缩机制 | LLM 摘要 + 连续剪重写 + 系统头逐轮重写 | est 估算预钳 prune + 定期 LLM 摘要 | **确定性标签组剪** + 散文浓缩双闸 + 轮界预算触发器 |
| 墙钟 | 114.7 min | 61.8 min | 43.3 min |
| 输入未命中 tokens（miss） | 9.287M | 1.979M | 1.363M |
| 输入命中 tokens（hit） | 46.21M | 43.49M | 60.06M |
| 输出 tokens（output） | 0.343M | 0.378M | 0.283M |
| 前缀缓存命中率 | 0.833 | 0.956 | 0.978 |
| **DeepSeek 闲时参考定价** | **11.58 元** | **4.36 元** | **3.69 元** |
| 声明窗上下文利用率 | 78.9% | 50.0% | 98.4% |
| 遗忘可撤销 | ✓ `recall`/`recall_detail` | ✗ | ✓ `recall_history` 按标签逐字取回 |
| 长程记忆（允许召回轮） | 7/10 | 2/10 | 8/10（补充召回轮） |
| 隐藏工件套件（T0） | 19/20 | 18/20 | 20/20 |

注：

- **数据基座**：本地 Qwen3.8-Flash-Next（声明窗 262,144）、同一 46 轮工作量、全串行单臂、每臂 n=1。
- **token 与价格口径**：token 按 provider 回报 usage 全程求和（miss=输入未命中，hit=输入命中，output=输出）；参考价按 **DeepSeek 闲时 1 / 0.02 / 4 元每百万 tokens** 折算。
- **v2.0.0 列**：出口闸关配置的 46 轮实测；声明窗上下文利用率按服务端 cached_tokens（KV 驻留前缀）计，305K 是请求规模、非上下文。
- **长程记忆**：v2.0.0 单轮先答 3 问全中（覆盖 3/10），追加 3 个补充召回轮（每轮预算重置）补回 5 问 → **8/10**；剩余 2 问因个别材料页未被标签覆盖而不可召回，模型如实答 C。1.x 的 7/10 来自 seq 直取召回栈（`recall`/`recall_detail`），能力真实，代价 2.4× 价格/2.3× 墙钟。
- **T0**：隐藏工件 20/20；完整对照数据与逐轮明细见 `CHANGELOG` 2.0.0。

## 模型要求

- **剪枝与出口闸不依赖模型**：任何模型上行为一致（0 LLM 确定性）。
- **散文浓缩**需要一条 compaction 用途的 LLM 路由，缺省自动跟随宿主 `agent.options`；路由不可用时浓缩自动关闭、零网络、保原文。浓缩质量随模型指令遵循能力缩放，失败方向永远是"少压"。
- 标签来自工具参数与输出，不要求模型配合输出任何引用协议。

## 已知限制

- **B-6 窗口截断盲区**：未被替换的 live 节点在逼近 contextWindow 时会被请求组装层截掉最旧部分，且不留痕迹——它们不在剪枝词表里，标签召回也取不回。缓解：比例预算前移触发点；根治在 dsh 侧（B-6 立案中）。
- **散文浓缩的输出税**：浓缩是唯一的 LLM 调用，只在事务内；摘要过长会吃掉节省，闸一（散文 ≥50%）与 20480 输出预算共同限幅，极端长文仍可能不划算。
- **无实体标签的内容不可剪**：纯聊天、没有路径/命令/错误码的输出不会被剪枝触及，只能等散文浓缩。这是"标签是唯一地址"的另一面（fail-closed：不猜身份）。
- **旧日志读侧**：老墓碑文法（v1.3.x–v1.7.x）与老 `data.argpCites` 仍可读，但 2.0 不再生成它们。

## 开发与验证

- `npm run check`：typecheck + smoke + 单测（269 测）+ 构建。
- 出口闸单测：`npm run test -- --test-name-pattern=EG-`。
- 46 轮对照的逐轮明细见 `CHANGELOG` 2.0.0；1.x 实验脚本归档在 `spike/retired-1x/`（不参与编译）。

## 问题反馈

- **Bug**：开 [Issue](https://github.com/yoza10635/dsh-argp/issues)。附 `dsh --version`、本包版本、profile 配置与最小复现步骤。
- **设计讨论 / 使用问题**：开 [Discussion](https://github.com/yoza10635/dsh-argp/discussions)。

## License

MIT
