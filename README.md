[English](README.en.md) | 中文

# dsh-argp — 实体标签上下文压缩：工具结果按标签确定性剪枝（0 LLM）+ 对话正文压缩时 LLM 摘要

[![CI](https://github.com/yoza10635/dsh-argp/actions/workflows/ci.yml/badge.svg)](https://github.com/yoza10635/dsh-argp/actions/workflows/ci.yml)
[![GitHub Release](https://img.shields.io/github/v/release/yoza10635/dsh-argp)](https://github.com/yoza10635/dsh-argp/releases)
[![npm version](https://img.shields.io/npm/v/dsh-argp)](https://www.npmjs.com/package/dsh-argp)
[![npm downloads](https://img.shields.io/npm/dm/dsh-argp)](https://www.npmjs.com/package/dsh-argp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**长会话吃满上下文窗口，逐轮 LLM 摘要又贵又打碎前缀缓存。** 本插件是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的上下文压缩插件：只把「过时、被取代、非焦点轮」的工具结果按实体标签**确定性剪掉（0 LLM）**，剪掉的原文留在 append-only 日志、按标签或关键词逐字取回；对话正文只在压缩事务内做 LLM 摘要。

同一 46 轮工作量实测（n=1，**2.1.0 构建、2026-11-14/15**，口径见文末附录；2.1.1 已改压缩分派/摘要缓存形/出口闸缺省开，本组数字待下一轮全量复测更新）：**11.58 元 → 3.69 元** · **114.7 min → 43.3 min** · **前缀缓存命中率 97.8%**。2026-11-23 全卷重放：宿主原生压缩**全程零唤醒**，4 笔 ARGP 压缩事务、合计遮蔽约 66 万 tok——下图为桌面端实拍。

![桌面端实拍：第 40 轮压缩事务，113 原子 / 约 155,576 tok 一笔入账](assets/desktop-compaction-t40.png)

- **0 LLM 剪枝**：只依据已发生的事实判定（同文件的更新读取、文件被改、当轮引用标签），同输入同输出、可复算，不要求模型配合。
- **遗忘可撤销**：剪枝桩带标签地址，原文恒在日志——`recall_history` 按标签逐字取回，`search_history` 按字面 keyword 发现并逐字取回（含已被浓缩请离场的对话正文）。
- **不打碎前缀缓存**：历史只在压缩事务内改写，系统头不逐轮重写；97.8% 命中率由此而来。
- **LLM 永远备着但不抢活**：工具压力全走 0-LLM 剪枝通道；对话正文摘要有双闸（正文 ≥ 50% 声明窗且 ≥ 0.8×声明窗），常规负载约 120 轮才够线——短会话与常规工具会话全程零 LLM 开销。

## 安装

```bash
dsh plugin --profile <name> add dsh-argp
```

装完即用：包自带 bundle patch（关掉宿主 `compaction-basic` 并挂载本插件），profile 层只做配置覆盖。宿主准入区间与 minimal preset 的注意点在文末附录。

## 上手

- 会话里输入 **`/argp`**：查看预算、触发线、剪枝与召回统计。**`/compact`**：手动压缩一次（全量剪 + 正文浓缩）。
- 自动压缩（缺省形态）：请求被 provider 以超窗拒收（400）时，自动执行一次标准压缩事务（全量剪 + 正文浓缩）再重试；想在**撞墙之前**压，设置唯一设置项「压缩阈值」（Settings → Plugins，缺省关闭）——上下文达到声明窗 × 比例即先压缩再发送。
- 召回工具对模型自动可用：`recall_history` / `search_history` / `list_labels`（三工具共享单次 5%、累计 10% 窗的字符预算，耗尽会显式说明）。

```text
ARGP 2.0.0 · engine: factor · preset: standard
budget: trigger 209.7k / retain 41.9k · now 88.4k (source=anchored)
prunes: 7 · last 3 ranges / 41 items / 12.8k→3.1k · pruned index 156
recall: 12 calls · 9 hits (75%)
```

`source=anchored` 表示占用锚定在 provider 回报的真实 usage；`ARGP inactive` 表示命中 `skipPresets`。

## 它怎么工作

**总原则：工具结果可剪，对话正文只在压缩事务内动。**

- **剪枝（0 LLM）**：工具结果按实体身份贴标签（`document:<path>` / `command:<family>` / `errorcode:<CODE>` / `scope:<dir>`，另有 `tool:<注册名>` 兜底地址）；判定成立的换成一行标签桩，判不上的按新旧与体积排队。正文永远不剪，焦点受保护。
- **正文浓缩**：插件唯一的 LLM 通路，只在压缩事务内、两道闸都过线才触发；空输出或异常保原文。双闸把它限定为「重粘贴域专用出口」：常规每轮只新增数百 token 正文，262K 声明窗下约 120 轮才堆过线（纯聊天 ≈200 轮；粘贴越重触发越早，这正是该通道的设计对象）。重放实拍：4 笔压缩全是 ARGP 有界事务，宿主原生压缩一次都没醒。
- **超窗兜底（缺省形态下压缩事务的入口）**：请求被 provider 以超窗拒收（400）时，自动执行一次标准压缩事务（全量剪 + 正文浓缩）再重试。
- **召回**：桩里带标签，原文按标签逐字取回；无标签的已离场内容——尤其被浓缩的对话正文——按字面 keyword 发现并逐字取回（2.1.0：命中给分层预览，`hit=` 第二跳取全文，命中过多回标签分布逼细化）。压缩后词表 note 会提示模型按标签或 keyword 召回。

策略值固化（触发线 0.8×声明窗、保留目标 0.2、焦点 1 轮、召回缺省 5 条），唯一设置项「压缩阈值」缺省关闭——细节见附录。事务协议、宿主兼容面与不变量见 [ARCHITECTURE.md](ARCHITECTURE.md)；相比 LLM 摘要式压缩的结构性优势：可复算、可撤销、缓存不碎。

## 实测对照（2026-11-14/15，46 轮同款工作量，本地 Qwen3.8-Flash-Next）

同提示词、同材料、全串行单臂、同端点/模型/窗 262,144；token 按 provider 回报 usage 全分解列示，最后一行按 DeepSeek 闲时价折算（口径注释见文末附录）：

| 维度 | v1.11.2 | 原生（宿主 compaction-basic） | v2.0.0 |
|---|---|---|---|
| 压缩机制 | LLM 摘要 + 连续剪重写 + 系统头逐轮重写 | est 估算预钳 prune + 定期 LLM 摘要 | **确定性标签组剪** + 正文浓缩双闸 + 轮界预算触发器 |
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

## 模型要求

- **剪枝不依赖模型**：任何模型上行为一致（0 LLM 确定性）。
- **正文浓缩**需要一条 compaction 用途的 LLM 路由，缺省自动跟随宿主 `agent.options`；路由不可用时浓缩自动关闭、零网络、保原文。浓缩质量随模型指令遵循能力缩放，失败方向永远是「少压」。
- 标签来自工具参数与输出，不要求模型配合输出任何引用协议。

## 已知限制

- **窗口逼近与盲区诊断**：不可剪的 live 节点（无标签、不在剪枝词表）在占用逼近声明窗时构成诊断盲区，`/argp` 状态卡在不可剪 live 达声明窗 80% 时显式露出风险行（近似诊断）。实测（2026-11-19，声明窗 40K 探针）：当前宿主对超窗请求**不做无痕截断**——全量发出并返回显式 `CONTEXT_WINDOW_EXCEEDED`，会话档案恒完整；因此离场内容不丢，可经 `search_history(keyword=...)` 按内容逐字取回（2.1.0）。缓解：超窗预检（先压后发）在压缩接管下已缺省开启，触发点可用设置「压缩阈值」（比例线）前移。
- **出口闸在压缩接管下缺省开启**（2.1.1 起）：pre-step 按「窗 − 输出预算 − 2%」线先剪后发，防两件事——① 真实墙≫声明窗的端点（网关自动升档、模型多档位）400 永不触发，而宿主会把 max_tokens 钳到「窗 − prompt」：大固定面（超大 AGENTS.md、大量工具 schema）会话落入「钳制线 < pressure 线(0.8×窗)」的死亡带时，轮次被钳成空转（台架与真实 DeepSeek 端点均实测过门关形态的「生成预算钳至最小、轮次空转」，门开全程正常）；② 注定超窗请求的 400→重试→全量重灌浪费。对照/评测臂 `ARGP_FACTOR_EGRESS=0` 硬关（关后回退「400 兜底网」形态，其适用前提=真实墙≈声明窗）；设置「压缩阈值」>0 自定义比例线。压缩器旧世界（`ARGP_FACTOR_DISPATCH=0/1`）缺省仍关，现网行为不变。
- **正文浓缩的输出税**：浓缩是唯一的 LLM 调用，只在事务内；摘要过长会吃掉节省，闸一（正文 ≥50%）与 20480 输出预算共同限幅，极端长文仍可能不划算。
- **剪后地址覆盖面**：每枚工具结果至少带一枚 `tool:<注册名>` 地址（工具名缺失的孤儿结果除外），剪后词表/交互段必列地址与预览——「没有实体标签就找不回」的旧口径已随 tool 因子键退役。纯聊天正文不进工具剪枝、不猜身份所以**没有标签地址**（fail-closed），但 2.1.0 起可按字面 keyword 经 `search_history` 从日志逐字取回（含已被浓缩请离场的原文）——标签是地址、keyword 是内容通道。
- **超大结果与宿主全局预剪的交互**：轮内上下文压力触发压缩事务时，宿主的 tool/result 全局预剪（阈值 ≈8192 chars，不认工具名）会把超限的**当轮刚返回**的 `recall_history`/`list_labels` 结果一并切成头/中/尾——头尾可见、中段轮内不可见（原文恒在 append-only 日志，账本可再取全文）。需要精确长内容的召回，优先 item 钻取小片段或分轮召回，勿依赖单轮超大 full 视图的中段完整。
- **旧日志读侧**：老墓碑文法（v1.3.x–v1.7.x）与老 `data.argpCites` 仍可读，但 2.0 不再生成它们。

## 附录：安装与宿主兼容

- **宿主要求**：DeepSeek Harness `>=0.2.0-rc.1 <0.3.0-0`（预发布参与匹配）。npm `latest` 与 `next` 现均为 `0.2.2-rc.5`（0.2.x 线，任一渠道可直接安装，对应桌面版同线；安装冒烟实测于 rc.3）。宿主仍停在 `0.1.x` 老线时不在准入区间，插件会被**静默跳过**。装完不见 `[argp]` 日志 / `/argp` 命令时，克隆本仓库跑预检：`node scripts/doctor.mjs --dsh <dsh 安装根>`。
- **极简（minimal）preset 下默认不生效**（`skipPresets: ['minimal']`）。需要时在 profile 层 modify 加 `config: { skipPresets: [] }`。
- **preset 覆盖块（整段替换快照）**：包尾 GENERATED 段对 `standard / cordis / ptc` 三枚默认 preset 做整段 modify——摘除其组内 `compaction-basic` / `tool-result-pruner` 行与 `isolate` 块（宿主 patch 层对 preset 没有局部手术语义，整段替换是缺省 preset 下关掉原生压缩的唯一机制）。层次序：profile 层的 patch 在所有 bundle 层之后应用——**你的自定义赢过本包**，不是反过来；这三枚之外的自定义 preset id 本包完全不碰。若你自己的 preset 的 compaction 组是从宿主模板复制的，需做同款手术（摘上述两行 + 整个 `isolate:` 块，三者缺一不可：摘 provider 留 isolate 会让 `/compact` 永久等待；留 stock 行则正文压缩静默回退原生）。宿主更新 shipped preset 后需重跑 `scripts/generate-preset-overrides.ts` 重生成快照对齐，期间快照会遮蔽宿主改动。

## 附录：调参与实测口径

- **固化策略值**：触发线 0.8×声明窗、保留目标 0.2、估算按字符类别加权（非中文 3.5、CJK 1.7 字符/token，κ 以 Qwen3.8 tokenizer 标定，换端点不自动重标定——估算只是兜底口径，占用以 provider usage 为锚）、焦点 1 轮、词表每类 10 行、召回缺省 5 条。
- **唯一设置项「压缩阈值」**（Settings → Plugins，默认关闭）：设为 0–1 的比例后，上下文达到声明窗 × 该比例即**先压缩再发送**（设置即时生效，免重挂；正文浓缩的双闸——正文 ≥ 50% 声明窗且 anchored ≥ 0.8×声明窗——仍决定事务内正文带动不动）。**缺省关闭时，压缩事务由 provider 超窗拒收（400）兜底触发，或手动 `/compact`**——适合真实墙≈声明窗的端点；网关自动升档等「真实墙≫声明窗」的端点建议开启。其余五枚旧旋钮保持退役（老 profile 同名键宽容读 + 告警）。
- **数据基座**：本地 Qwen3.8-Flash-Next（声明窗 262,144）、同一 46 轮工作量、全串行单臂、每臂 n=1。
- **token 与价格口径**：token 按 provider 回报 usage 全程求和（miss=输入未命中，hit=输入命中，output=输出）；参考价按 **DeepSeek 闲时 1 / 0.02 / 4 元每百万 tokens** 折算。
- **v2.0.0 列**：超窗预检关闭形态的 46 轮实测（2.0.1 起即缺省形态；评测档位细节见 [ARCHITECTURE.md](ARCHITECTURE.md) §11）；声明窗上下文利用率按服务端 cached_tokens（KV 驻留前缀）计，305K 是请求规模、非上下文。
- **长程记忆**：v2.0.0 单轮先答 3 问全中（覆盖 3/10），追加 3 个补充召回轮（每轮预算重置）补回 5 问 → **8/10**；剩余 2 问不可召回：1 页只被目录级 grep 触及（仅 scope 目录地址，召回引导只教 document/command/errorcode），1 页从未被读取、内容从未进入会话日志——模型如实答 C。1.x 的 7/10 来自 seq 直取召回栈（`recall`/`recall_detail`），能力真实，代价 2.4× 价格/2.3× 墙钟。
- **T0**：隐藏工件 20/20；对照汇总见 `CHANGELOG` 2.0.0。

## 从 1.x 升级

1.x 图引擎已退役：老方案冻结在 npm **`1.11.2`**（tag `v1.11.2`）。2.x 只维护 factor 引擎；老 profile 里的 graph 旋钮会被宽容读取并告警忽略，历史 CHANGELOG 保留。

## 开发

全门禁一键：`npm run check`（typecheck + smoke + 单测 + 构建 + 产物一致性）。门禁矩阵与专项回归见 [CONTRIBUTING.md](CONTRIBUTING.md)；事务协议与设计基准见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 问题反馈

- **Bug**：开 [Issue](https://github.com/yoza10635/dsh-argp/issues)。附 `dsh --version`、本包版本、profile 配置与最小复现步骤。
- **设计讨论 / 使用问题**：开 [Discussion](https://github.com/yoza10635/dsh-argp/discussions)。

## License

MIT
