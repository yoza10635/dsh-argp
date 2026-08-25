# 联调长程任务测试设计（real-coding t-long）

> 状态：设计稿（2026-08-22 定稿待跑）
> 目的：补上第四节的"合成任务 → 真实形态任务"口径缺口。160K 三档定稿数字来自**合成遥测任务**（`06-tlong.ts`，telemetry chunk + 脚本化探针）；本文档定义一个**编码任务形态**的长程测试，用真实工具流量（write/read/edit 真实项目文件）复测核心主张，并在真实 prompt 形态下验证 cites 通路。
> 红线沿用：本文只做复测与口径扩展，所有数字带产物路径，跑完登记 `publication-plan.md` §5。

## 1. 为什么是这个形状

160K 定稿数字的形态特征与真实 coding 会话的三处差异：

| 维度 | 合成任务（06-tlong） | 真实 coding 会话 |
|---|---|---|
| 工具流量 | 42 次 `read_file` 读遥测 chunk（均匀噪声） | write/read/edit 交错，输出大小不规则，含错误-重试循环 |
| 内容结构 | 同质 telemetry 行 | 异构：代码/报错/解释/用户指令混合 |
| prompt 形态 | "nothing else" 类严格措辞 + 脚本化探针 | 自然语言多轮协作，无冲突措辞 |

要证明的三件事（按重要性）：

1. **R 找回闭环在异构内容上依然成立**（合成上 7/7，真实内容分布下复测）。
2. **压缩率精确兑现 + 0 失败事务**在真实工具流量下复现（合成上 4 事务 0 error）。
3. **cites 通路在无冲突措辞的真实形态下激活**——合成 run 里 DeepSeek 零声明是 "nothing else" 冲突压死的（README 实测：去掉冲突后 10 轮声明率恢复 43.6%、解析 100%）。真实编码任务没有这种冲突，A 臂的 citeStats 是"赌注赢了的形态"在真实任务上的第一次验证。

**不做**：与摘要式"谁摘要得更好"的质量对比（无产物支撑，红线）。成本对比只做"同任务 ARGP vs baseline"的口径扩展。

## 2. 传输层：headless 模拟 API 请求（口径先钉死）

本测试**不经 WebUI**，走 headless 脚本驱动真实模型——与 `06-tlong.ts` 同一形态：装配 `Context + AgentLoop + 真实 v4-flash`，每一轮 = 一次真实模型 API 调用。

**关键澄清**：模型的输入/输出、以及压缩引擎的整条路径（`AgentLoop` / `surface` / `ctx.compaction` 钩子）与生产完全一致。WebUI 只额外引入 client inject 层与 UI 渲染，而 **compaction 是 server 端引擎、不走 client 层**，所以 WebUI 对本测试结论零增量。

**由此口径钉死**：本复测对外措辞为「**headless 真实模型长程复测**」（真实模型 + 真实工具流量 + 真实引擎路径，仅传输层是脚本），**不得**写成「WebUI 生产对话」。WebUI 真会话验证另立独立小任务，不阻塞本数据、不阻塞发文。

## 3. 配置固定（可复现性）

headless spike **不经 preset boot**（极简/标准模式是 WebUI server 端的 agent preset 选择，控制工具集 + persona + compaction 是否挂载；spike 是手工装配 `Context`），所以"固定模式"= **钉死脚本实际挂载的组件清单**：

| 配置项 | 固定值 | 说明 |
|---|---|---|
| **工具集** | `write_file` + `read_file` + `edit_file`（3 个文件工具） | 等效"标准模式"的文件编辑子集；不挂 shell/bash/search/skills/subagent（与 06 的极简 `read_file` 不同，26 需要写文件） |
| **compaction 引擎** | `ArgpGraphEngine`（A 臂）/ `compaction-basic`（B 臂）/ 无（C 臂） | 通过 `ctx.plugin()` 挂载，与生产声明式挂载等价 |
| **persona** | 固定字符串：`You are a coding agent implementing a mini rate-limit microservice. Working directory is the task sandbox. Follow user instructions precisely.` | 不用 `{{model}}` 模板（spike 无 agent route）；内容中性、不含"nothing else"类冲突措辞 |
| **contextWindow（模型声明上限）** | `ARGP_CONTEXT_WINDOW=200000`（200K token） | 传入模型 catalog；A 臂 ARGP 与 B 臂 compaction-basic 的触发线**都从它派生**（×0.8 = 160K），故两臂在同一膨胀压力下同步触发，成本对比口径干净 |
| **ARGP 引擎参数** | 显式传 `windowTokens=160000`、`retainTokens=32000`；`maxPasses=256` | 与 160K 定稿 run（`scan-32k-2026-08-17`）**同挂载口径**（scan-32k 即显式传值，非 ratio 派生）——确定性优先，不赌 headless 运行时 `requestContext()` 解析；数值上 = contextWindow 200K × 0.8 / × 0.2 |
| **事务门槛** | `minBoundaries=5`（`ARGP_MIN_BOUNDARIES` 可覆盖） | 参考文件压载（§4）使单事务可剪量更大 → 事务数比纯编码任务少，门槛从 8 降到 5（仍要求压缩真实发生） |
| **模型 / 思考档** | `deepseek-v4-flash` / `ARGP_DEEPSEEK_THINKING=enabled`（high） | 与 160K 定稿同档 |
| **轮次** | 50（`ARGP_MAX_TURNS=50`） | 见 §4 任务骨架 |

**与 WebUI preset 的关系说明**：如果将来要在 WebUI 里复现本测试，等效选择 = "标准模式"（有文件工具 + compaction）+ 手动把 compaction 切成 ARGP（通过 profile patch 声明 `ctx.compaction = ArgpGraphEngine`）+ 在 WebUI 设置里把上下文上限设为 200K。但本测试走 headless，上述"配置固定"表就是唯一权威。

## 4. 任务骨架：`spike/26-tlong-coding.ts`

复用 `06-tlong.ts` 的装配/重试/探针/产物骨架（`mountModel`、`runTurn` 三次重试+探活、`waitForIdle`、turn 映射、orphanReport、result.json+events.jsonl 落盘），替换任务体。

**任务**：实现一个 mini 限流微服务（纯函数核心，零第三方依赖、零真实执行——见 §9 风险）。**50 轮**，探针口径与 06 完全对齐（每探针轮问 U+R 双针）。

```
轮次    段          内容
1       setup       任务总述 + 工作目录约定（从零写，无既有代码；提及 ref-module.ts 参考模块存在）
2-11    事实埋点    10 个确定性事实（F1–F10），每轮 1 个 + 一次轻 read 产生早期工具流量
12-35   实现段      8 文件 write/read/edit + 3 静态验收问题 + 3 报错纠正轮 + 读回核对
                  + 5 压载读轮（读 ref-module.ts 真实模块，见下）
36-45   探针段      10 个探针轮，每轮问 (U_k, R_k) 双答案
46-50   收尾段      全文件读回核对 + 最终清单（制造末次膨胀→触发末段压缩）
```
= 1 + 10 + 24 + 10 + 5 = 50 轮。

**参考文件压载（本轮新增，解决"膨胀不足"根因）**：纯编码任务 50 轮实测仅涨到 ~57K 上下文，够不到 160K 触发线（首跑 A 臂 `boundaries=0`，压缩引擎全程未触发）。解法：把主引擎源码 `src/argp-graph-engine.ts`（~25K token/次读取）去契约后复制为沙箱内 `ref-module.ts`，实现段插入 **5 次全量读取**（各配一个关于该模块的分析问题）。5×~25K + 编码段基线把上下文顶过 160K 数次 → 压缩真实触发，且压载读回结果正是 ARGP 最该剪的孤立 R 原子，后续探针再考"被剪后的压载内容能否 recall 回来"。
- **去契约占位**：整块删除文件里两个契约 section（`argp-contract` / `argp-cites`）——压载文件从不被编译/导入（只是 read_file 读出的文本），删块零语法风险，且两 section 是独立语句。消除"模型在文件里再读一遍 cites 契约 → 声明率虚高"的污染。
- 深埋锚点（`extractCites` / `compactIfNeeded` / `scaleBudgets` / recall 预算 3/轮）都在契约块之外，**保留**——其中 `extractCites` / `compactIfNeeded` 升级为压载 R 针。

**确定性事实（U 针，×10，埋点轮 2-11）**——脚本侧持有期望值，模型侧只出现在用户消息里：

| # | 事实 | 类型 |
|---|---|---|
| F1 | `RATELIMIT_SVC_TOKEN = TK-<code>` | 配置凭证 |
| F2 | Redis key 前缀 `rl:prod:<code>` | 配置 |
| F3 | 限流参数：window=60s, burst=128 | 数值约束 |
| F4 | 429 响应体必须含 `retry-after-ms` 字段 | API 契约 |
| F5 | 日志文件路径 `logs/ratelimit-<code>.log` | 路径约定 |
| F6 | 窗口对齐按 epoch 分钟取整（**不是**滑动窗口） | 实现约束（后段伪提示纠正依赖它） |
| F7 | 测试必须覆盖 burst 边界 127/128/129 三例 | 测试约束 |
| F8 | 错误码：`RL_EXCEEDED` / `RL_MISCONFIG` / `RL_INTERNAL` | 枚举 |
| F9 | 配置文件用 JSON 不是 YAML | 偏好（模型默认 YAML 会被纠正） |
| F10 | 超时预算 50ms，超时一律 fail-open | 语义约束 |

**R 针（×10，可 recall 目标）**：
- 6 个代码文件首行 marker：`// edge-rl <file> — impl ref RLX-<j>-MARKER-<code>`，由模型 write 时写入（模板首行在指令里逐字给出）。
- 2 个"深埋值"：`store.ts` 里一个常量、`ratelimit.test.ts` 里一个断言期望值，埋在文件中部，探针要求 recall 后精确抄出。
- **2 个压载深埋值（本轮新增）**：`ref-module.ts` 里的 `extractCites`（提取 cites JSON 块的导出函数名）与 `compactIfNeeded`（执行压缩/剪枝的方法名）——只出现在被剪的 ref-module 读回结果里，逼 recall_pruned 找回，直接考"大参考文件被剪后能否召回"。
- R 探针 = "该文件首行 impl ref / 该深埋值是什么？不在视野里就 recall_pruned 找"。

**实现段文件清单（8 个，合计约 1200-1500 行）**：`config.ts`、`window.ts`、`counter.ts`、`store.ts`、`router.ts`、`middleware.ts`、`ratelimit.test.ts`、`README.md`。指令每轮 1-2 个文件；`window.ts` 故意在指令里留一个与 F6 矛盾的伪提示（"滑动窗口即可"），模型若读回 F6 应纠正——这是"依赖真实生效"的软探针（不计入判决，只记录）。

**验收问题（静态，×3，穿插在实现段）**：预写 3 条不执行代码的验收检查（如"counter.ts 的 incr 在 burst=128 时第 129 次调用返回什么？读回代码回答"），强制模型 read 回已写文件 → 制造 `read→edit→read` 版本链流量 + 真实依赖边。

**报错纠正轮（×3，穿插在实现段）**：脚本在实现段中段发 3 条"我看了下，第 N 个文件这里应该改成 X"的纠正指令，模型需 edit 已写文件 → 制造真实 edit 流量与依赖边。

**探针（×10，探针轮 36-45，每轮双针）**：每轮问一个 U 事实（跨埋点深度选 F1/F3/F5/F6/F8/F9/F10 等）+ 一个 R 目标（覆盖早期/中期文件 + 2 个深埋值）。格式沿用 06 的两行答案制（`U-ANSWER:` / `R-ANSWER:` + `NOT-RECOVERABLE` 出口），避免自由格式解析问题。

**参数**：`ARGP_CONTEXT_WINDOW=200000` + 显式 `windowTokens=160000` / `retainTokens=32000`（**与 160K 定稿 160000/32000 同口径**）、`maxPasses=256`、`minBoundaries=5`、50 轮、看门狗 3h（单轮预算 120s）。预期膨胀：8 文件 write + 多次 read 回 + 报错纠正 + **5 压载读轮（5×~25K）** + 探针轮 → 上下文峰值越过 160K 触发线数次，预期触发 **5-15 笔**压缩事务（压载单次剪量大，事务数比纯编码任务少）。

**本地前置跑（可选，免费机制验证，不进文章成本章）**：用 `ARGP_MODEL_SOURCE=qwen-local` 跑 A 臂、上下文压到 100K（`ARGP_CONTEXT_WINDOW=100000` + `windowTokens=80000` / `retainTokens=16000`，触发线 80K），先验证"压缩真实触发 + 双针通过"再上 v4-flash 正式跑。其 token 数据可完整核算（含命中），但 ¥ 成本 = 0（自部署），文章成本章仍锁定 v4-flash 200K 正式口径（§3/§5）。

## 5. 臂设计

| 臂 | 引擎 | 模型/思考 | prompt 形态 | 作用 |
|---|---|---|---|---|
| **A** | ARGP | v4-flash high | 自然语言（无 "nothing else"） | 主臂：真实形态复测；其 citeStats 即"赌注赢了"的数据 |
| **B** | compaction-basic（high 档） | v4-flash high | 同 A | 成本/功能对照（预期复现空流失败模式） |
| **C**（可选） | 无压缩（disabled） | v4-flash high | 30 轮截短 | "无压缩必溢出"的同构证据（基线 07 的 201K 撞窗）；只为成本曲线形状，可后置 |

默认跑 **A + B 两臂**；C 视成本余量决定。各臂同任务序列、同模型、同参数、同日跑（价格口径一致：v4-flash 2026-08-17 价，闲时）。

## 6. 判决与指标

**功能类（硬判决）**：
- L1 long-run-stable：全 50 轮完成 + 事务 ≥8 + 0 孤儿 + 事务事件完整（同 06 口径）
- L2 u-protection：U 探针 ≥8/10（U 永不参剪，surface 直读）
- L3 r-recovery：R 探针 ≥7/10（口径与 06 的 R≥4/7 同比例；真实内容分布下 recall 应更稳，marker 语义自明）
- L4 functional（软判决，记录不硬卡）：实现段文件全部落盘 + 验收问题 3 条模型自答正确率 + 伪提示纠正是否发生

**声明行为类（METRIC，支撑"赌注赢了"的形态）**：
- `citeStats.declared / resolved`：预期 declared > 0（README 实测无冲突措辞下 10 轮 43.6%；50 轮预期 declared 百量级）
- 边密度 = resolved 边数 / 原子数
- recall 调用量与命中率（事件流口径，不用 engine.recallCalls——06 已证该口径不可靠）

**成本类（cost-audit.mjs 核算，亦可手算）**：
- 逐臂 input hit / input miss / output / reasoning token 分解 + 总价
- ⚠️ **reasoning 已含于 output**：`outputTokens` = `completion_tokens`（推理 + 正文合一），定价时只算 `output × 输出单价`；`reasoningTokens` 仅是诊断拆出，**绝不单列加算**（否则重复计费）
- 逐轮成本 = miss×1.5/M + hit×0.05/M + output×4.5/M（v4-flash 2026-08-17 闲时价；高峰 ×2）；hit/miss 取自 dsh `cacheReadTokens`/`inputTokens`（disjoint 拆分，不重复）
- 派生：ARGP vs baseline 成本比（预期复现 87-91% 区间）
- 记录空流失败事务数（B 臂）

**产物**：`spike/out/26-tlong-coding-<stamp>/`（result.json + events.jsonl + work/ 全量文件快照）。跑完登记 `publication-plan.md` §5。

## 7. 成本与预算

- A 臂：50 轮，含 5 压载读轮（每次读回 ~25K token 进上下文，推高 input）→ 峰值越过 160K 触发线、压缩多次 → 参照 scan-32k（25 轮 ¥2.695）外推 **¥4-8**
- B 臂：同轮数 + 摘要事务 + 空流重试 → **¥6-11**
- C 臂（可选）：30 轮无压缩，上下文一路膨胀至撞窗 → 参照 160K 定稿 disabled 基线（¥3.19）外推 **¥3-4.5**
- 合计默认（A+B）**¥10-19**，加 C 臂最高 ~¥23.5，高峰时段 ×2。**必须闲时跑**（深夜/清晨），跑前探活（PONG 单请求），跑前用 cost-audit 价格表确认当日档位。

## 8. 执行计划

1. **写脚本**：`spike/26-tlong-coding.ts`（复制 06 骨架，替换任务体；needle 期望值脚本侧持有；模板 marker 与 06 的 `code()` 伪随机同源，保证确定性）。
2. **冒烟**：`ARGP_MAX_TURNS=8` 截短跑（setup + 事实埋点 2 个 + 写 2 个文件 + 探针 1 个），确认装配/文件落盘/探针解析正常，~¥0.05。
3. **正式跑 A 臂**（闲时，3h 看门狗），出 result.json → cost-audit → 登记。
4. **正式跑 B 臂**（同日），同流程。
5. **（可选）C 臂**。
6. **出表**：A vs B 三列（功能/声明/成本），与 160K 三档表并列；若 A 臂 R 探针 ≥7/10 且 0 error，文章第四节补一句"**headless 真实编码任务复测一致**"（带产物路径，口径见 §2，不写成 WebUI 生产）。

## 9. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 模型 write 文件时改写/丢掉首行 marker | 模板指令里把首行作为逐字引用给出（"第一行必须是这一句，一字不差"）；R 探针判定容忍 marker 前后空白 |
| 真实执行代码引入 flaky（语法错/依赖） | **不做真实执行**，验收问题全部静态读回回答；文件是纯 TS 文本，无 node_modules |
| B 臂空流失败率过高导致 run 报废 | 06 骨架的三次重试+探活直接复用；空流事务数本身是 METRIC（B-5 证据），不算 run 失败 |
| 膨胀不足，事务 <5 | **本轮已根治**：5 压载读轮（读 ref-module.ts ~25K/次）把上下文顶过 160K 数次。若仍不足，调小 `ARGP_WINDOW_TOKENS` 到 80_000 或加压载读轮 |
| 膨胀过度，单轮 >120s 拖爆看门狗 | 文件规模钉死（每文件 150-250 行）；单轮 120s 预算外由重试机制兜底 |
| cites 声明解析失败率升高（真实措辞更自由） | citeStats 自带 resolved 率；若 <80%，记录为契约鲁棒性数据点（不判 FAIL） |
| 高峰时段价格 2× | 跑批前用 cost-audit 的价格表确认当日档位；跑完在产物里记录价格档位 |
| **跨轮缓存断点（引擎 bug，已修复 2026-08-22）** | 原 `shadowedSeqsOf` 把 cites 剥离写回（单点 replace + `data.argpCites`）误当"被剪节点"→ catalog 谎报 "Compression removed N items"（压缩未发生也逐轮涨）→ system 前缀每轮变 → 跨轮 prefix cache 全 miss。已修：只收 `op==='replace'` 且无 `argpCites` 的 replace（commit `6d252cf`）；代理实证修复后 system 指纹跨轮恒定、每轮首请求 miss 28-42K→1.2-4.6K。**本实验的命中率/成本对比须用修复后引擎跑** |

## 10. 决策点（已按默认值设计，可改）

1. 任务长度 **50 轮**（对齐 06 规模，探针每轮双针口径与 06 完全一致，成本较 72 轮省 ~30%）
2. 默认 **A+B 两臂**，C 臂（disabled 30 轮）后置视余量
3. 思考档 **high**（与 160K 定稿同档；disabled/low 档已有 160K 数据，不重复）
4. **传输层=headless 模拟 API 请求**（不经 WebUI；口径=「headless 真实模型长程复测」，见 §2）
5. **配置固定=§3 表**（工具集 3 文件工具 / 中性 persona / `ARGP_CONTEXT_WINDOW=200000` / 显式 `windowTokens=160000`+`retainTokens=32000` 与 160K 定稿同口径；headless 不经 preset boot，"极简/标准"是 WebUI server 端 preset 选择，spike 侧以 §3 表为唯一权威）
6. **膨胀机制=参考文件压载**（本轮新增，根治首跑 `boundaries=0`）：主引擎源码去契约后作 `ref-module.ts`，实现段 5 次全量读取把上下文顶过 160K → 压缩真实触发；`minBoundaries` 从 8 降到 5；2 个压载深埋值升级为 R 针
