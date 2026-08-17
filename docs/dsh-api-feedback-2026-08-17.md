# API 反馈建议书：dsh compaction 事件模型与测试装配的三处缺口

> **提交方**：ARGP（Atomic Reference Graph Pruning）插件开发
> **对象**：DeepSeek Harness（dsh）团队
> **日期**：2026-08-17
> **版本**：@deepseek-ai/dsh-* 0.1.0-rc.6（本地快照 rc.5，commit 47f9438 对照）
> **性质**：第三方 compaction 插件在真实开发中撞到的 3 个平台缺口/隐患，均已有最小复现，建议纳入下一版本评估

---

## 背景

ARGP 是以"0-LLM 确定性占位改写"为核心形态的 CompactionEngine 后端（整体替换 compaction-basic）。开发期累计登记 4 条卡点（blocker-log.md），其中 B-2 已内部消化，以下 B-1 / B-3 / B-4 三条为平台侧缺口，在此打包提交。三条均已用最小复现脚本验证，dsh 团队如需复现材料可随时提供。

---

## B-1：tool/result 占位改写无处安放剪枝元数据（优先级：中）

**现象**：tool/result 单节点 replace 受 `assertToolResultRewrite` 硬约束——只许改 tool-result 块内层 `content`，message 其余字段（含随机生成的 `id`）必须与原节点逐字段深相等；且替换事件本身必须仍是 tool/result（用 user tombstone 覆写单节点虽能过 surface 层，但留下孤儿 tool-call，配对校验报 corrupt surface）。合规占位唯一形态 = 克隆原 message 保 id 仅换 content（即 ToolResultPruner 形态）。

**最小复现**：`spike/02-surfaceop.ts` 判决 3/3n——克隆原 message 换 content 则通过；新建 message（新 id）则报 `tool/result surface replacement may change only content`。

**影响**：占位文本里可以塞纯文本 catalog 指针，但**没有结构化字段可挂压缩元数据**（剪枝原因、图节点引用、可召回性标记）。元数据只能 (a) 编码进占位文本（脏但可行）或 (b) 存插件侧旁路索引、靠 seq 关联（seq 稳定，已被实证）。这同时限制了两类机制的设计空间：节点自定义 metadata、tombstone 注入形态。

**建议的 API 变更**（二选一）：
1. 为 surface 替换事件提供可选结构化元数据通道（如 `SurfaceIntent.meta` 或事件级 `meta` 字段），放行 tool/result 替换场景；
2. 或允许 `assertToolResultRewrite` 下的替换节点携带附加标注字段。
当前 ARGP 用旁路 (b) 绕过，不阻塞开发，但长期看占位文本解析脆弱。

---

## B-3：compaction/prune 事件不进事务不变式状态机（优先级：中）

**现象**：dsh-compaction 的 invariant.ts 只对 `compaction/start/summary/end` 维护事务括号状态机（open/summarized/owner 校验）；`compaction/prune` 事件不置 summarized 位、`validateCompactionEvent` 对其返回 undefined——它是游离事件，无法单独构成一笔完整事务。而 ARGP 的剪枝是 0-LLM 确定性占位替换，语义上是"换出"而非"摘要"，没有原生事件类型可用。

**最小复现**：源码 compaction/src/invariant.ts（summarized 位仅由 compaction/summary 置位）+ spike 4 实测：ArgpT1Engine 只能借 compaction/summary 语义进括号，provider/model 字段填 'argp'/'algorithmic-tombstone' 伪值标记算法剪枝。

**影响**：① 语义失真——tombstone 占位文本被迫充当 summary 内容，遮蔽账目（shadowedTokenCount 等）挂在名义摘要下；② provider/model 字段被填假值，未来想按事件区分"LLM 摘要"与"算法剪枝"无原生通道；③ 若 dsh 后续对 summary 语义加约束（摘要质量校验、token 上限），算法剪枝会被误伤。

**建议的 API 变更**（二选一）：
1. 将 compaction/prune 纳入不变式状态机（独立置位或复用 summarized，配独立 owner 校验），使其可独立成括号；
2. 新增 compaction/tombstone 事件类型（数据形状同 summary，但语义为占位换出，豁免摘要类约束）。
当前以借道方案绕过，事务判决全过，不阻塞开发。

---

## B-4：BasicCompactionEngine 在 headless 测试装配下压力通道全程静默失效（优先级：高）

**现象**：spike 7 基线臂用 `mountAgentLoopTestDependencies` + `ctx.plugin(BasicCompactionEngine, { modelPolicies: [...] })` 装配，50 轮 t-long 任务全程 **0 笔 compaction**，请求累积至 201633 tokens 撞 196608 窗口 400，任务 turn 36 中止；连引擎自带的 overflow 恢复钩子也未救回。显式 modelPolicies 与默认档（0.8×窗口）均未触发。已定位根因（2026-08-16 源码复核确认）。

**最小复现**：`spike/07-baseline.ts`，产物 `spike/out/07-baseline-2026-08-16T07-55-41-633Z/`（wall=5024s，final surface ~109370 tokens，tx 0/0/0）。

**根因**：`mountAgentLoopTestDependencies` 只挂 llm/session/systemPrompt/tools/agent，**不挂 tokenMeter**；`BasicCompactionEngine` 的 `static inject` 含 `tokenMeter`，pre-step 中 `this.ctx.tokenMeter.measure` 在缺失装配下抛错，被 pre-step 钩子 catch 分支的 `ctx.logger.warn` **静默吞掉**——压力通道从未进入。`TokenMeter.measure` 估算口径对 reasoning 块计 token；若走 provider usage anchor 则按 usage input/cache/output 合计。

**影响**："与 dsh 官方压缩同条件对照"的实验设计被集成问题阻断（修复：装配时显式 `await ctx.plugin(TokenMeter)`）。更普遍的风险：**任何第三方插件在缺失依赖装配下都可能静默失效而不报错**——测试期浪费大量算力，生产期则表现为"压缩从未发生"。

**建议的 API 变更**：
1. 测试 harness（mountAgentLoopTestDependencies）明确注册 tokenMeter，或在文档标注 Basic 引擎的装配前置条件；
2. pre-step 钩子的静默 warn 提升为可观测通道（事件或首错 throw），杜绝"压缩从未触发"类静默失效。

---

## 汇总

| # | 主题 | 优先级 | 现状绕过 | 建议变更 |
|---|---|---|---|---|
| B-1 | tool/result 替换无结构化元数据通道 | 中 | 旁路索引靠 seq 关联 | 替换事件 meta 通道 / 放行附加字段 |
| B-3 | compaction/prune 游离于事务状态机 | 中 | 借 summary 语义 + 伪字段 | prune 入状态机 / 新增 tombstone 事件 |
| B-4 | testkit 缺 tokenMeter 致 Basic 引擎静默失效 | 高 | 显式挂 TokenMeter | testkit 补装配 / warn 提升为可观测 |

**期望**：dsh 团队评估上述三条中哪些适合进入 rc 系列；任何一条如需更多复现细节或配合验证，ARGP 侧可提供（含离线事件流重放材料）。

**联系方式**：通过 ARGP 仓库（argp-dsh）issue 或本建议书回传均可。
