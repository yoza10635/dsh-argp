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

## B-5：摘要调用间歇性空流（2026-08-17 定稿实验实证，优先级：高）

**现象**：`ctx.llm.stream()` 在高思考档（reasoningEffort=high）返回空流——0 chunk、0 usage、误报 `"summarization produced no text summary content"`。160K 主流档 50 轮实测（`spike/out/07-baseline-deepseek-2026-08-17T10-05-07-507Z/`）：30 笔事务中 **23 笔 error（77%），全部为区间内 0 usage 的空流**。

**关键证据（排除 maxTokens 假设）**：
- B-5 初诊（`.tmp/diag-thinking.mjs`）显示默认 maxTokens=8192 下 reasoning 需 ~13.5K tokens → text=0，建议 maxTokens≥32K
- **定稿实验将 maxTokens 设 32768 后，77% error 依旧**——23 笔全为空流（0 usage），与 maxTokens 无关
- 间歇性：同一 turn 内连续两次调用一空一正常（turn 10：ERR 0 usage → OK output=1823 / cacheRead=152960），前缀缓存一致（99.7% 命中）→ **排除上下文大小因素，疑似流式连接竞态**（连接建立/读取时序）
- 引擎行为：error 后自动重试（同 turn 内连续触发压力检查），重试耗尽静默放弃、流程不中断（L1 50/50 仍 PASS），但上下文不收缩持续膨胀

**影响**：摘要引擎（compaction-basic）在 high 思考档系统性不可靠，error 不产生 usage 但浪费重试轮；第三方引擎若依赖 stream 也会撞上。

**建议变更**（任选）：
1. stream 空流（0 chunk）增加重试或明确告警（当前静默吞掉、误报 no text）
2. 摘要调用允许降级为非流式（一次性返回），绕开流式竞态
3. 或至少在 error 时区分"空流"与"内容为空"，避免误报误导诊断

---

## B-6：surface 窗口丢弃无痕迹，窗口边界对压缩引擎不可见（2026-08-19 追加，优先级：高）

**现象**：非 shadowed（live surface）节点在模型可见窗口内消失后**不留任何痕迹**——无占位、无 seq、无计数；压缩引擎与模型都无法发现它曾存在。live 节点掉出渲染/请求窗口发生在 **surface fold 之后、适配器组装请求时**（按 contextWindow 截断最旧 surface 消息），`session.events` 与 `surface.nodes` 中节点仍然完好——因此**会话日志级取证无法观测这一丢落**（对事件流重放完全透明，正是"无痕迹"的实锤）。模型对已丢内容无 seq 可查，recall 原语又只认"被替换过的 pruned 节点"，于是表现为：内容确实说过、模型确实看不到、任何召回入口都拒答。压缩契约里的 "never guess"（缺失内容不得臆造）在窗口边界内不可执行——模型不知道去查，查了也查不到。

**取证路径（需适配器级证据）**：对比 `Session.deriveMessages()` 投影输出与实际发给模型的请求（或在请求头里查 `[context] removed N` 类摘要头），即可得到被窗口丢落的 live seq 列表。注意：会话 jsonl 里出现的"tombstone 区间包含某 seq 但该 seq 不在遮蔽集合"现象，通常是 tool/call 等非 surface 事件被区间数值误覆盖（非本问题证据），立案时勿引用。

**影响**：① 模型侧不可发现、不可召回 → 长会话中早期 live 内容静默丢失，与 recall 契约（never guess）冲突；② 压缩引擎与适配器各持一份"可见性账目"（引擎知 shadowed 集、适配器知窗口切分线），互不可见，无法协同计算真补集；③ 现有回避手段（插件侧全日志 recall 升级）只能解决"知道 seq 就能取"，解决不了"模型怎么知道被丢的 seq"。

**建议的 API 变更**（二选一）：
1. 渲染/请求层对每个被丢节点留一个带 seq 的占位（与现有 `[context] removed N` 头同构，按节点粒度）——对模型最鲁棒，顺带解决"tombstone 无 seq 导致两跳后不可召回"；
2. 或最小 API：把可见窗口边界（首个可见 seq / 被丢 seq 区间）通过 surface 事件或引擎输入暴露给 CompactionEngine——引擎已知 shadowed 集，只差 dsh 侧的窗口切分线，拿到后即可精确操作"真补集"。

**与 B-1 联动**：占位若带结构化 meta（B-1 通道），seq/state 无需编码进文本，tombstone 文本可回归纯人类可读。

---

## 汇总：官方改动 ↔ ARGP 解锁能力 对照

> **2026-08-21 修订**：按"官方改什么 ↔ ARGP 得到什么"重排；所有建议均限定为**纯加法、向后兼容**形态（新增可选字段 / 新增事件类型 / 新增可观测输出，不改既有行为与既有事件语义）。有破坏风险的原方案已撤回或改写（见"撤回项"）。rc.8（08-19 发布）已逐包复验，五条对应的包均无变化。

### 功能解锁类（采纳后 ARGP 获得新能力）

| # | 官方改动（纯加法） | ARGP 解锁的能力 | 兼容性 | 优先级 |
|---|---|---|---|---|
| B-6 | 渲染/请求层对每个被窗口丢掉的节点留一个**带 seq 的占位**（按节点粒度）；或最小形态：把可见窗口边界（首个可见 seq / 被丢区间）作为可选输入暴露给 CompactionEngine | recall 契约（never guess）**完整闭环**：模型能感知"这段内容存在但被窗口丢掉了"→ 自动调 recall 取回；长会话早期 live 内容静默丢失这一 ARGP 最大暗箱消除；tombstone 两跳后不可召回一并解决 | 纯加法：占位是新增请求内容（rc.8 请求组装层无此类节点粒度占位，已核实）；窗口边界是可选输入，不订阅的引擎不受影响 | 高 |
| B-1 | 为 surface 替换事件提供**可选** `meta` 字段（放行 tool/result 替换场景）；或允许替换节点携带附加标注字段 | tombstone 元数据（剪枝原因 / 图节点引用 / 可召回标记）出文本：占位文本回归**纯人类可读**，插件侧旁路文本解析（当前脆弱点）退役；与 B-6 联动后 seq/state 不再编码进文本 | 纯加法：可选字段，旧插件读不到即忽略 | 中 |
| B-3 | 新增 `compaction/tombstone` 事件类型（数据形状同 summary，语义为占位换出，**豁免摘要类约束**） | prune 独立成事务括号：按事件原生区分"LLM 摘要"与"算法剪枝"（当前靠伪字段）；未来官方若对 summary 加质量校验/token 上限，算法剪枝不被误伤 | 纯加法：新事件类型，不触碰 compaction/summary 既有语义与状态机 | 中 |

### 实验正确性类（非功能解锁，但决定对照实验与第三方插件可靠性）

| # | 官方改动（纯加法） | 解锁的收益 | 兼容性 | 优先级 |
|---|---|---|---|---|
| B-4 | testkit（mountAgentLoopTestDependencies）补 tokenMeter 装配，或在文档标注 Basic 引擎装配前置条件；pre-step 静默 warn 提升为可观测（事件或首错 throw） | "与官方压缩同条件对照"实验设计恢复可行（当前靠显式手动挂 TokenMeter 绕过）；杜绝任何第三方插件在缺失依赖下**静默失效不报错**——生产期表现为"压缩从未发生"且不可见 | 纯加法：测试装配补件 + 日志级别提升，不改生产路径行为 | 高 |

### 附：bug 修复建议（非功能需求，对 ARGP 为中性）

**B-5 摘要调用间歇性空流**：high 思考档 77% 空流、maxTokens 修复无效、疑似流式连接竞态（证据见 B-5 节）。建议：空流（0 chunk）重试或明确告警 / error 时区分"空流"与"内容为空"。**rc.8 已把默认重试 2→5**，方向一致，继续观察即可。说明：此条是 compaction-basic 侧的 bug——ARGP 压缩阶段 0-LLM 本身不受影响，**不把它当作对 ARGP 的功能解锁**；保留此条是希望官方压缩在 high 档恢复可用，以保证生态内对照实验的数据质量。原建议中的"降级为非流式"选项撤回（涉及 provider 适配器行为面，超出纯加法范围）。

### 撤回项（原建议中有破坏风险，不再建议）

- ~~B-3 原方案 1："prune 纳入不变式状态机（复用 summarized 位）"~~——复用 summarized 位会改动既有摘要事务的判定路径，超出纯加法；改为仅建议新增 tombstone 事件类型。
- ~~B-5 原方案 2："摘要调用降级为非流式"~~——改变 provider 适配器调用形态，影响面超出 compaction；仅保留空流重试/告警的可观测类建议。

**期望**：dsh 团队评估上述改动哪些适合进入后续 rc 系列；任何一条如需更多复现细节或配合验证，ARGP 侧可提供（含离线事件流重放材料）。

**联系方式**：通过 ARGP 仓库（dsh-argp）issue 或本建议书回传均可。
