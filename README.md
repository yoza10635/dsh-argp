[English](README.en.md) | 中文

# dsh-argp — 实体标签上下文压缩：工具结果按标签确定性剪枝（0 LLM）+ 对话正文压缩时 LLM 摘要

[![CI](https://github.com/yoza10635/dsh-argp/actions/workflows/ci.yml/badge.svg)](https://github.com/yoza10635/dsh-argp/actions/workflows/ci.yml)
[![GitHub Release](https://img.shields.io/github/v/release/yoza10635/dsh-argp)](https://github.com/yoza10635/dsh-argp/releases)
[![npm version](https://img.shields.io/npm/v/dsh-argp)](https://www.npmjs.com/package/dsh-argp)
[![npm downloads](https://img.shields.io/npm/dm/dsh-argp)](https://www.npmjs.com/package/dsh-argp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**长会话吃满窗口，逐轮 LLM 摘要贵且打碎前缀缓存。** 本插件是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的上下文压缩插件：只把「过时、被取代、非焦点轮」的工具结果按实体标签**确定性剪掉（0 LLM）**，剪掉的原文留在日志、按标签逐字取回；对话正文只在压缩事务内做 LLM 摘要；上下文过线自动浓缩，超窗被拒收时自动剪枝重试。

46 轮实测：墙钟 43.3 min · DeepSeek 闲时参考价 3.69 元 · 前缀缓存命中率 97.8%（n=1，口径见表后注）。

## 安装

```bash
dsh plugin --profile <name> add dsh-argp
```

**装完即用，无需手工配置**：插件包自带 bundle patch（关掉宿主自带的 `compaction-basic` 并挂载本插件），profile 层只做配置覆盖。

**宿主要求**：DeepSeek Harness `>=0.2.0-rc.1 <0.3.0-0`（预发布参与匹配；当前最新 `0.2.2-rc.3` 已实测）。宿主须在 **0.2.x 线**（npm `next` 渠道或对应桌面版）；npm `latest` 渠道（0.1.x）不在准入区间，插件会被宿主**静默跳过**。装完不见 `[argp]` 日志 / `/argp` 命令时，克隆本仓库跑预检：`node scripts/doctor.mjs --dsh <dsh 安装根>`。

> **发布后 24 小时内安装，请显式指定版本。** pnpm 11 的 `minimumReleaseAge` 默认为 24 小时，刚发布的版本会被静默跳过、回落到旧版本。用 `dsh plugin --profile <name> add dsh-argp@<版本>`，或在 profile 的 `pnpm-workspace.yaml` 写 `minimumReleaseAgeExclude: [dsh-argp]`。

> **极简（minimal）preset 下默认不生效**（`skipPresets: ['minimal']`）。需要时在 profile 层 modify 加 `config: { skipPresets: [] }`。

## 上手

- 会话里输入 **`/argp`**：查看预算、触发线、剪枝与召回统计。
- **`/compact`**：手动压缩一次（全量剪 + 散文浓缩）。
- 自动压缩：上下文过线（0.8×声明窗）先浓缩散文再继续；请求超窗被 provider 拒收（400）时自动剪枝并重试。
- 召回工具对模型自动可用：`recall_history`（按实体标签取回被剪原文）、`search_history`（按字面 keyword 发现并取回，含已被浓缩请离场的对话正文）、`list_labels`（浏览词表）。

```text
ARGP 2.0.0 · engine: factor · preset: standard
budget: trigger 209.7k / retain 41.9k · now 88.4k (source=anchored)
prunes: 7 · last 3 ranges / 41 items / 12.8k→3.1k · pruned index 156
recall: 12 calls · 9 hits (75%)
```

`source=anchored` 表示占用锚定在 provider 回报的真实 usage（最准）；`ARGP inactive` 表示命中 `skipPresets`。

## 它怎么工作

策略值固化：触发线 0.8×声明窗、保留目标 0.2、估算按字符类别加权（非中文 3.5、CJK 1.7 字符/token，κ 以 Qwen3.8 tokenizer 标定，换端点不自动重标定——估算只是兜底口径，占用以 provider usage 为锚）、焦点 1 轮、词表每类 10 行、召回缺省 5 条。**唯一设置项「压缩阈值」**（Settings → Plugins，默认关闭）：设为 0–1 的比例后，上下文达到声明窗 × 该比例即**先压缩再发送**（设置即时生效，免重挂；比例 >0.8 时 0.8×窗的散文浓缩线先动作，阈值线在其上追加剪枝）；**关闭时由模型撞墙（provider 拒收超窗请求）自动压缩兜底**——适合真实墙≈声明窗的端点；网关自动升档等「真实墙≫声明窗」的端点建议开启。其余五枚旧旋钮保持退役（老 profile 同名键宽容读 + 告警）。

**总原则：工具结果可剪，对话正文只在压缩事务内动。**

- **剪枝（0 LLM）**：工具结果按实体身份贴标签（`document:<path>` / `command:<family>` / `errorcode:<CODE>` / `scope:<dir>`），按"过期读、被新版取代、非焦点轮"确定性打分，可剪的换成一行标签桩；散文永远不剪，焦点轮受保护。
- **散文浓缩**：插件唯一的 LLM 通路，只在压缩事务内、两道闸都过线时触发（散文占声明窗 ≥50%，且上下文 ≥ 0.8×声明窗）；空输出或异常保原文。
- **超窗兜底**：请求被 provider 以超窗拒收（400）时，自动执行一次标准压缩事务（全量剪 + 散文浓缩）再重试。
- **召回**：桩里带标签，原文从日志按标签逐字取回（`recall_history`）；无标签的已离场内容——尤其被浓缩的对话正文——按字面 keyword 发现并逐字取回（`search_history`，2.1.0：命中给分层预览，`hit=` 第二跳取全文，命中过多回标签分布逼细化）；三个工具共享单次 5% / 累计 10% 窗的字符预算，耗尽会显式说明。压缩后词表 note 会提示模型按标签或 keyword 召回。

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
| 前缀缓存命中率 | 83.3% | 95.6% | 97.8% |
| **DeepSeek 闲时参考定价** | **11.58 元** | **4.36 元** | **3.69 元** |
| 声明窗上下文利用率 | 78.9% | 50.0% | 98.4% |
| 遗忘可撤销 | ✓ `recall`/`recall_detail` | ✗ | ✓ `recall_history` 按标签逐字取回 |
| 长程记忆（允许召回轮） | 7/10 | 2/10 | 8/10（补充召回轮） |
| 隐藏工件套件（T0） | 19/20 | 18/20 | 20/20 |

注：

- **数据基座**：本地 Qwen3.8-Flash-Next（声明窗 262,144）、同一 46 轮工作量、全串行单臂、每臂 n=1。
- **token 与价格口径**：token 按 provider 回报 usage 全程求和（miss=输入未命中，hit=输入命中，output=输出）；参考价按 **DeepSeek 闲时 1 / 0.02 / 4 元每百万 tokens** 折算。
- **v2.0.0 列**：超窗预检关闭形态的 46 轮实测（2.0.1 起即缺省形态；评测档位细节见 [ARCHITECTURE.md](ARCHITECTURE.md) §11）；声明窗上下文利用率按服务端 cached_tokens（KV 驻留前缀）计，305K 是请求规模、非上下文。
- **长程记忆**：v2.0.0 单轮先答 3 问全中（覆盖 3/10），追加 3 个补充召回轮（每轮预算重置）补回 5 问 → **8/10**；剩余 2 问不可召回：1 页只被目录级 grep 触及（仅 scope 目录地址，召回引导只教 document/command/errorcode），1 页从未被读取、内容从未进入会话日志——模型如实答 C。1.x 的 7/10 来自 seq 直取召回栈（`recall`/`recall_detail`），能力真实，代价 2.4× 价格/2.3× 墙钟。
- **T0**：隐藏工件 20/20；对照汇总见 `CHANGELOG` 2.0.0。

## 模型要求

- **剪枝不依赖模型**：任何模型上行为一致（0 LLM 确定性）。
- **散文浓缩**需要一条 compaction 用途的 LLM 路由，缺省自动跟随宿主 `agent.options`；路由不可用时浓缩自动关闭、零网络、保原文。浓缩质量随模型指令遵循能力缩放，失败方向永远是"少压"。
- 标签来自工具参数与输出，不要求模型配合输出任何引用协议。

## 已知限制

- **窗口逼近与盲区诊断**：不可剪的 live 节点（无标签、不在剪枝词表）在占用逼近声明窗时构成诊断盲区，`/argp` 状态卡在不可剪 live 达声明窗 80% 时显式露出风险行（近似诊断）。实测（2026-11-19，声明窗 40K 探针）：当前宿主对超窗请求**不做无痕截断**——全量发出并返回显式 `CONTEXT_WINDOW_EXCEEDED`，会话档案恒完整；因此离场内容不丢，可经 `search_history(keyword=...)` 按内容逐字取回（2.1.0）。缓解：设「压缩阈值」（比例线）或 `ARGP_FACTOR_EGRESS=1` 开启超窗预检（先压后发）可前移触发点。
- **兜底网的适用前提**：出口闸缺省关闭依赖「真实墙≈声明窗」——provider 拒收超窗请求（400）时兜底链才会触发自动剪枝。若端点真实墙远大于声明窗（网关自动升档、模型多档位），400 永不触发，缺省形态下自动剪枝将失活（只剩散文浓缩与手动 `/compact`），此类端点建议设 `ARGP_FACTOR_EGRESS=1`（真实 DeepSeek 端点实测：门关形态生成预算被客户端钳至最小值、轮次空转；门开形态全程正常）。
- **散文浓缩的输出税**：浓缩是唯一的 LLM 调用，只在事务内；摘要过长会吃掉节省，闸一（散文 ≥50%）与 20480 输出预算共同限幅，极端长文仍可能不划算。
- **剪后地址覆盖面**：每枚工具结果至少带一枚 `tool:<注册名>` 地址（工具名缺失的孤儿结果除外），剪后词表/交互段必列地址与预览——"没有实体标签就找不回"的旧口径已随 tool 因子键退役。纯聊天正文不进工具剪枝、不猜身份所以**没有标签地址**（fail-closed），但 2.1.0 起可按字面 keyword 经 `search_history` 从日志逐字取回（含已被浓缩请离场的原文）——标签是地址、keyword 是内容通道。
- **超大结果与宿主全局预剪的交互**：轮内上下文压力触发压缩事务时，宿主的 tool/result 全局预剪（阈值 ≈8192 chars，不认工具名）会把超限的**当轮刚返回**的 `recall_history`/`list_labels` 结果一并切成头/中/尾——头尾可见、中段轮内不可见（原文恒在 append-only 日志，账本可再取全文）。需要精确长内容的召回，优先 item 钻取小片段或分轮召回，勿依赖单轮超大 full 视图的中段完整。
- **旧日志读侧**：老墓碑文法（v1.3.x–v1.7.x）与老 `data.argpCites` 仍可读，但 2.0 不再生成它们。

## 开发与验证

- `npm run check`：typecheck + smoke + 单测（336 测）+ 构建。
- 超窗预检单测：`npm run test -- --test-name-pattern=EG-`。
- 46 轮对照的汇总口径见 `CHANGELOG` 2.0.0；1.x 实验脚本归档在 `spike/retired-1x/`（不参与编译）。

## 从 1.x 升级

1.x 图引擎已退役：老方案冻结在 npm **`1.11.2`**（tag `v1.11.2`）。2.x 只维护 factor 引擎；老 profile 里的 graph 旋钮会被宽容读取并告警忽略，历史 CHANGELOG 保留。

## 问题反馈

- **Bug**：开 [Issue](https://github.com/yoza10635/dsh-argp/issues)。附 `dsh --version`、本包版本、profile 配置与最小复现步骤。
- **设计讨论 / 使用问题**：开 [Discussion](https://github.com/yoza10635/dsh-argp/discussions)。

## License

MIT
