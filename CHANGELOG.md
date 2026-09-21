# Changelog

本项目使用 conventional commits 记录变更，版本由 `package.json` + git tag 锚定。双分发渠道：**GitHub Release**（tag 驱动）+ **npm registry**（`dsh-argp`，账号 `yoza10635`）。

> **版本号说明**：1.3.2 为 npm 孤儿版本（bump 事务延迟完成上了 registry，unpublish 被 bypass-2FA 政策拒），`latest` 已指回 1.3.1；1.3.2 号永久作废，下一版直接 **1.3.3**。

## [1.5.0] - 未发布（2026-09-21 起开发；1.4.1 号作废不发布）

> 本条目自 1.5.0 开发起累积：首笔 = 被钳不再等于任务中断（轮中压力剪 + 截断自动续写）；排期 P1–P5 的修复将陆续并入本条目，全部完成并复审后一次性发布。

**问题（用户纠正 + 存档实证）**：1.4.0 把轮中主动压缩关掉、只留"下一个 pre-step 强制剪"，且续写要等用户开口。但上下文超限的两个主要形态恰恰都在轮内——(a) **拿到 tool result 之后才超**（L1 只在轮初判定，看不见它）；(b) **输出过程中被钳**。两者都应在图剪之后**自动继续推进当前轮次的任务**，而 1.4.0 做不到：存档全库 5/5 次钳制后面紧跟的都是 `step/end > turn/end`（`77c64e66`@2318/2326/2356、`a56061c2`@1071/1081/1091/1103；其中 `a56061c2`@1071 发生在 **turn 5 step 15**——典型"轮内长跑被 tool result 推爆"），没有一次续跑。

### Added —— 轮中压力剪（L1'）

- **`step > 1` 且压力达标即剪**，且**只做 0-LLM 图剪**（不跑 per-atom LLM pass——那是 79s–3min 的阻塞，轮内不划算；轮初/轮末另有专门通道）。剪落在那个 pre-step ⇒ **同一个 step 的请求即已瘦身** = 天然自动继续本 turn。
- **放宽 `turnGuard`（`midTurnTurnGuard`，默认 0）**——这是与 1.3.x 轮中剪的关键差别，也是后者"几乎无效"的根因：超额的来源就是**本轮**的 tool result，而 `turnGuard=1` 恰把整轮保护起来（实测只能剪到 **1 原子 / 154 tok**）。`recencyGuard` 照常保护最新节点（刚收到的 tool result 不动），模型需要更早的 tool result 时走既有 recall 通道。

### Added —— 截断自动续写（L3，本版核心）

- **新钩子 `agent/turn-stopping`**：本轮要收时若仍有待消费的钳制信号 ⇒ ① 就地强制剪（`turn/end` 尚未落账，编号 bracket 仍属本 turn）；② 剪**确有腾空**时 `agent.steer(续写消息)` ⇒ 宿主循环以 `target='next-step'` **续同一个 turn**，用户不必再发"继续"。依据：宿主 `agent.ts:483` 在 `finish.kind === 'max-tokens'` 时**先于** `executeToolCalls` 直接 return（该步 tool calls 被丢弃），`turn()` 随即因 inbox 空而收轮——`turn-stopping` 是最后一个可干预点；harness 自带契约测试逐字锁定 *"steer() from an agent/turn-stopping listener continues the same turn"*（`contract-regressions.spec.ts:323`）。
- **续写消息形状**：`createUserMessage` + `source = {kind:'plugin', plugin:'dsh-argp', form:'notice'}`。宿主与本引擎都把 `plugin` 源归为 **X**（可见、不参剪）⇒ 既进请求又不会被剪掉，UI 按 notice 渲染、不伪装成用户输入。文案默认点明"输出被宿主的输出预算截断（不是你的错）+ 上下文已压缩 + 接着写勿重述"，可用 `continuationNotice` 覆盖（空串 = 只剪不续）。
- **零腾空则不续写**：剪不动还 steer 只会立刻再被钳一次；此时把信号**重挂**（`rearmReactive`）留给下一次机会（通常是用户开口后那一轮，那时阶梯已 +1、守卫放宽）。
- **续写阶梯**：`reactiveRescues` 每 turn 重置，同一 turn 内第 2 次起放宽 `recencyGuard`/`turnGuard`，`reactiveRetries`（默认 2）用尽即放手让本轮结束——既保证"连续被钳能升级"，又封住无限续。

### Changed —— 兼容与默认值

- **`midTurnPrune`（默认 `true`）/ `midTurnTurnGuard`（默认 0）** 成为正式旋钮。1.4.0 的 `midTurnActive` 保留为别名：`true` = 轮中剪开 + 沿用默认 `turnGuard`（1.3.x 逐 pre-step 档，含 per-atom pass，对照用）；`false` = 轮中剪关（1.4.0 档）。
- `reactiveRetries` 语义收窄为"**每次连续被钳 episode** 内的续写次数"（旧文档描述的是逐 pre-step 重试）。

### Changed —— recall 契约（P2.5，D2 混合方案）

- **C1 截断做实**：`recall_detail` 新增 `from`（字符偏移，默认 0）/ `limit`（单次最多返回字符数）分页参数；被预算或 limit 截断时，截断标记回传"下一步该传什么"（`…(truncated at N/M chars; call recall_detail(seq=…, from=N) to continue)`）——被剪的长代码/长工具输出可逐页完整拿回，截断不再是不可恢复的信息丢失。
- **P1 重建诚实化**：`recall_detail` 改走新 raw-text 访问器 `log-access.rawEventText`（`eventText` 共享投影行为不变）：text 块返回日志字面量（多块时块间分隔符为投影，标注）；tool-call 参数宿主存字符串（raw JSON）→ 逐字，宿主存对象 → JSON 语义等价重建并在返回里精确标注（`[note: …]`）。
- **P2 散文 guard 诚实化**：recall 工具描述 + 契约 section + 压缩 prompt 明确"保真仅保证结构化承重 token（URL/路径/file:line/UUID/哈希/key=value，`token-ontology.ts` LOAD_BEARING_PATTERNS）逐字；散文级引用不保证逐字"；README/ARCHITECTURE 的"逐字节"宣称同步收窄。

### Fixed —— 正确性热修（P1，6 项）

- **per-atom 水位在 LLM/解析失败时仍推进**（`peratom/flush.ts` `prepareCurrentTurn`/`compressCollect`）：`callAndStash` 三条失败路径（no-endpoint / parseFailed / LLM 抛错）都返回"失败 record"不抛异常，旧代码却无条件 `advanceWaterMark` ⇒ 一次瞬时 LLM 抖动即让该轮原子被水位过滤（`event.seq <= since`）**永久排除**出 per-atom 候选，与 1.3.4 水位语义（"成功 pass 才推进水位"）直接矛盾。修复：仅当 `entry.error === undefined && !entry.parseFailed` 才推进水位（两处调用点）。
- **单 R 占位墓碑克隆失败回退成 user/message**（`prune-tx.ts` `pruneIntervals`）：单 R 区间的 tool_calls 不可克隆时，旧代码回退成 user/message 占位 ⇒ tool_calls 悬空 ⇒ **provider 400**（爆炸半径最高）。修复：事务前预校验 `canCloneTool(seq)`，不可克隆的单 R 区间从本次 pass 剔除并 warn（不再发出非法占位）。
- **`resolveModelInfo` 的 AbortSignal 无超时**（`budget.ts`）：冷启动 pre-step 创建的 `new AbortController().signal` 从未被 abort ⇒ LLM 服务挂起时 pre-step **永久卡死**（外层 try/catch 只对 rejection 生效，对 hang 无效）。修复：`setTimeout(() => ac.abort(), 5000)` + `finally clearTimeout`。
- **配置面板 `save()` 缺 try/finally**（`client/argp-config-controller.ts`）：写循环中途抛错时面板**永久卡「Saving…」**。修复：包 try/catch/finally 恢复状态。
- **`doneTurns` 只读不写**（`peratom/cite-declarer.ts`）：Set 全程无 `.add()` ⇒ 幂等短路永不触发，同一闭合轮**重复烧 LLM 调用**。修复：门控通过后 `done.add(collect.turn)`。
- **A2 debug 把完整 wire（含用户消息历史）`writeFileSync` 落盘**（`peratom/llm-adapter.ts`）：仅 env 门控、无脱敏。修复：默认（仅设 `ARGP_PERATOM_A2_DEBUG`）只写**脱敏摘要**（消息数、每条 role+长度、整段 wire 的 sha256）——不落正文；确需逐字节对齐的完整 wire 须**额外显式**设 `ARGP_PERATOM_A2_DEBUG_FULL=1`。数据责任在 SECURITY.md 明示。

### Changed —— 工程卫生与构建（P4）

- **日志统一**：双 sink 混用（`this.log` / `ctx.logger`）+ 前缀不一致 ⇒ 统一单一 sink + 前缀表；生产代码裸 `console.log`（LLM 请求序列化热路径）改 `ctx.logger.debug`。
- **常量集中**：跨 5 文件裸字面重复的核心魔法数字（16_384 / 8_192 / 3.5 / 132_000 / 0.8 / 0.2 / 180_000 / 16）⇒ 新建 `src/constants.ts` 具名常量，全引擎 `??` 引用。
- **LLM 超时统一**：compressor 180s vs declarer 120s ⇒ 统一 `DEFAULT_LLM_TIMEOUT_MS`（180_000）。
- **遥测有界化**：实例级诊断数组（`records`/`recallCalls` 等 9 个，常驻 server 插件只增不减）⇒ `src/telemetry.ts` `pushBounded` 有界环形缓冲（保留最近 N 条，`DEFAULT_TELEMETRY_CAP=256`）。
- **配置值校验**（`client/argp-config-controller.ts`）：`windowRatio`/`retainRatio`/`charsPerToken`/`maxPasses`/`recencyGuard`/`turnGuard`/`minSpanChars`/`sortMode` 加范围/整数/枚举校验；非法值在 parse 期拒绝（`CardFieldState.invalid`，save 被拒），不再静默落盘。
- **构建/工具加固**：typescript `^5.5.0`→`^5.7.0`（build 需 5.7+）；client 产物嵌 version banner + 开 sourcemap；`check-commit-msg.mjs` 改 spawnSync + ref 白名单（消除命令注入）；新增 `prerelease-check.mjs`（脏树守卫 + tag 幂等，防"半发布"死局）；`release`/`check`/`prepublishOnly` 统一为全量闸门。
- **lib/ 入库策略（D4）**：维持入库 + CI 校验（`git diff --exit-code lib/`），不 gitignore。

### Removed —— 三个 spike 时代 alt-engine（P3.4，D3）

- 删除 `argp-t1-engine.ts` / `probe-engine.ts` / `recall-engine.ts`（564 行）及其 spike 脚本（`spike/01-mount.ts` / `03-recall.ts` / `04-t1.ts`）：零引用、未从 `index.ts` 导出、已被 `argp-graph-engine.ts` 取代；此前随 `tsconfig.build.json` 的 `include: ["src/**/*.ts"]` 编译进 `lib/` 随包发布（死代码）。公共 API 面 name-for-name 不变（`index.ts` 逐字节 diff 验证）。

### Refactored —— 结构重构（P5，5 步）

> 纯结构重构，运行时行为逐字节不变（Wave 4 功能复审以归一化 diff 独立验证：全部方法体逐字相同、构造函数副作用次序与 ctx.on/systemPrompt/tools 块逐字保留；append-only / shadow-price / 三级触发 / recall paging+rawEventText / verbatim guard 五条核心不变量全部完好）。

- **抽 `argp-types.ts` 叶子**：`Atom`/`AtomType`/`SemanticEdge`/`DeterministicEdge`/`EdgeLevel`/`ArgpUserSettings`/`EDGE_WEIGHTS`/`LEVEL_ORDER` 从 3,313 行 hub 下沉到中性叶子；peratom/* 只依赖它 + `log-access`，**斩断 `argp-graph-engine ⇄ peratom/*` 类型回边**（仅 type-only import，编译期擦除，无运行时环）。`eventText` 下沉 `log-access.ts`。
- **拆 `compactIfNeeded`**：`isAtomCandidate`/`isGroupCandidate`/`sortKey` 三个闭包提为模块级纯函数，`mergeIntervals`/`buildTombstones` 抽为独立可测函数。
- **删 `tryPruneClosures` 死代码**（生产零调用、仅测试引用）+ `detectOpenTurn`/`mainChainReasoningEffort`/`turnOf` 收敛到 `log-access` 叶子（替代 13 处 `as { turn }` 强转）。
- **hub 拆 7 模块**（3,313 → 1,646 行，−51%）：`graph-build` / `budget` / `recall` / `prune-selection` / `prune-tx` / `recall-tools` / `session-lifecycle`；构造函数拆 4 函数（`normalizeConfig`/`registerSettings`/`mountPeratomStack`/`registerRecallTools`）。class 变为薄组合根：持有字段 + 1–4 行薄转发方法。
- **compressor 拆 6 模块**（1,520 → 362 行，−76%）：`compressor-types` / `decision` / `collect` / `prompt` / `flush`。
- **窄宿主接口模式**：各模块定义窄 `*Host` 接口，class 经 `this as unknown as Host` 调用，模块只 type-only import 组合根（编译期擦除）⇒ 运行时依赖图为真 DAG（0 环），公共 API 面 name-for-name 不变。

### Tests

- `test/trigger-levels.test.ts` 扩到 **14 例**：新增 L1⑤（放宽 `turnGuard` 才能剪动"独占当前轮"的 tool result——legacy 档剪不动、默认档剪得动，同会话同时点对照）、L3①–⑤（剪+steer 的载荷形状 / 无信号对照 / 剪不动不续写 / 次数上限 / 阶梯按 turn 重置）；L2 各例改到独立口径（`windowTokens` 极大 ⇒ 只有强制路径可剪，避免与 L1' 混淆）。
- 新增 **`test/auto-continue-e2e.test.ts`（3 例，真 AgentLoop + 脚本化适配器）**：E2E① 被钳后请求数 3 且 `turn/start` 仍为 **2**（= 同一 turn 续跑，未新开轮）、第 3 次请求确实带上续写提示；E2E② 正常收尾不续（对照）；E2E③ 额度用尽即收轮，不无限续。
- **变异检查**（3 处，各自只打掉对应断言、对照组全绿）：① 永不 steer ⇒ E2E①/③ + L3①/④/⑤ 失败；② 不放宽 `turnGuard` ⇒ L1⑤ 失败；③ 不重挂信号 ⇒ L2③ 失败。
- 全量 **285/285**（276 + 6 + 3），typecheck 与 build 干净。
- **P3.3** 新增 `test/cites-strip.test.ts`（**16 例**）：三个纯函数（双端共享事实源）独立契约测试，含"禁止 `includes('c')` 误升 critical"安全契约（硬回归）。
- **P3.2** 新增 `test/client.test.ts`（**13 例**）：`client/*` 整目录此前零测试——`assistantDisplay` 显示过滤器（cites 协议防 UI 泄漏 JSON 标记的唯一关口）、静默降级、`ARG_SETTINGS_KEY` 跨端契约。
- **P2.5** `test/recall-zoom.test.ts` 14 → **18 例**（+4）：新增 C1 分页续读（截断标记回传 from + 续读逐字拿回剩余）、limit 单次上限、P1 参数对象/字符串两态（重建标注 vs 逐字无标注）；原"预算截断"断言改为断言续读指引格式。
- 全量 **318/318**（285 + 16 + 13 + 4），typecheck 与 build 干净。

## [1.4.0] - 2026-09-21（三级触发：轮初主动 + 轮中只反应式）

> ⚠️ 本版的「② 轮中只反应式」已被 **1.5.0** 修订：轮中恢复压力剪（放宽 `turnGuard`），并新增"被钳后剪 + steer 续写同一 turn"。保留下文作为当时的判定依据与实测记录。

真环境实证来源：`session-77c64e66` 全 232 请求的 finish 词表（`tool-calls 232 / stop 13 / max-tokens 3`）+ 三次被钳事件的用量（**1,911 / 1 / 4,714** vs 请求 32,768）+ 宿主 `agent-loop/src/agent.ts:244/250`（先 `claim` 再 dispatch pre-step）与 `compaction/src/invariant.ts:165-177`（编号 bracket 必须落在自己的 open turn 内）。

### Changed —— 触发口径重排为三级

- **① 轮初主动（主力）**：只在**每轮首个 pre-step**（`payload.step === 1`）做压力判定，阈值沿用 `windowRatio`（0.8）。关键修正：估值**计入本步已 claiming、尚未落盘进 surface 的 user 消息**（`payload.messages`）。宿主 `agent.ts:244` 先 `inbox.claim()`、`:250` 才 dispatch pre-step，故轮初拿到的是**新 user 消息的精确内容**——不是预测，也不需要"预测 + 复核"两遍；而旧口径沿用上一请求的 usage 锚点，整块漏掉"这一轮的启动量"，用户恰恰常在轮初粘贴大段文本。
- **② 轮中只反应式（取消轮内主动阈值）**：轮内**默认不做**主动压缩。两条实测理由：(a) **近乎无效**——turnGuard 保护当前轮，209K 上下文的一次轮内图剪只剪得动 **1 原子 / 154 tok**；(b) 每次落地都是一次**轮中** surface 替换 = 断一次前缀缓存，收益却接近零。取而代之的判据 = 输出被**外部**钳制：`assistant/message` 的 `data.stream` 末项 `finish.reason.kind === 'max-tokens'` **且** `data.usage.outputTokens <` 本次请求声明的 `maxTokens`（由 `agent/request` waterfall 捕获；适配器的钳制发生在其后）。真值分辨：`outputTokens` 远小于预算 = 宿主/适配器把输出啃小了（= 容量压力）；`≈ maxTokens` = 模型自己写满预算，不构成压缩理由。
- **③ overflow 强制路径**：不变（provider 400 → P4 三步）。

### Added

- **反应式补救（执行面）**：被钳信号置位后，**下一个 pre-step** 以 `compactIfNeeded('context-overflow')` 强制剪一次——该 trigger 绕过阈值早检，"仍未回线"的真信号由上游继续钳输出给出。**升级**：第 2 次起临时放宽 `recencyGuard`/`turnGuard`（连当前轮一起进入候选），"被钳后回线"才有可能。**上限**：`reactiveRetries`（默认 **2**）用尽即停手并交回 overflow 路径——避免"每步都被钳 → 每步白压"的死循环（那比现状更糟：每圈多吃一次输出）。
- **`midTurnActive`（默认 `false`）**：逃生阀。置 `true` 恢复 1.3.x 的逐 pre-step 主动压缩（对照实验用）。

### 设计取舍（为什么不做"轮末决定 + 下轮落地"的两段式）

图剪 `consolidateTombstones` 是**纯同步、0-LLM**（体内无 await / 无网络）⇒ 判定与落地可以在**同一时刻**完成，拆两段零收益。真正贵的那一件（peratom 的 LLM pass，79s–3min）本来就在轮末起跑、并在 pre-step 有界等待（1.3.5 的 `flushWaitMs`），与图剪无关，保持不动。落点选**轮初**而非轮末：轮末看不到下一条 user 消息（低估），轮初能拿到精确值；且轮初天然复用现成调用点与**编号** bracket（轮末需另开 standalone 路径）。附带修正一条此前的记录：`invariant.ts:165-177` 只要求**编号** bracket 落在自己的 open turn 内，`turn === null` 的 standalone bracket 在轮间是**合法**的——"轮末根本不能图剪"的说法不成立，轮末只是不划算。

### Tests

- 新增 `test/trigger-levels.test.ts`（**8 例**）：轮初含 messages 越线即剪 / 同会话 messages 为空不剪 / 轮内默认不剪 / `midTurnActive:true` 轮内仍剪（对照）/ 被钳强制剪（压力未达标也剪）/ `outputTokens === maxTokens` 不触发 / 放宽守卫升级（只剩当前轮可剪时第 2 次剪动）/ 次数用尽不再重试。**变异检查**：去掉 `step === 1` 门、把 `< budget` 放宽成 `<= budget` ⇒ 对应断言如期失败（L2④ 被探针 1 连带），确认断言非空转。全量 **276/276**（268 + 8）。
- `test/peratom-pre-pressure.test.ts` 显式改为 `midTurnActive: true`（其锁定对象由"主路径"变为"逃生阀 / 对照"，文件头注释同步更新）。

## [1.3.5] - 2026-09-21（peratom 轮末 pass「落地等待」+ 手动 /compact 多段剪）

真环境实证来源：`session-77c64e66`（9 次 peratom 事务逐条核对落点；判据 = "压缩事件是否落在上一轮 `turn/end` 与新轮 `user/message` 之间"）。

### Fixed

- **轮末 pass 在飞时，下一个 user message 会绕过压缩（替换副本落到新轮中途）**。两段式设计的发射窗口是下一轮首个 `agent/pre-step`，旧实现却显式"绝不 await 网络"（只 flush 已就绪条目）⇒ 若轮末 LLM 调用仍在飞而用户已发下一条消息，新轮首个 pre-step **无条目可发射**，事务被顺延到新轮任意后续 pre-step。实测（#9，跨进程 resume 场景）：**晚 6 步**落盘（13:38:41 新轮开 → **13:44:41** 才发），新轮 step 1–6 全跑在未压缩上下文上（step 1 `in=191,116`），且替换点落在轮中途 ⇒ 断一次前缀缓存。修复：pre-step **先有界等待在飞轮末 pass**，再发射——等到 ⇒ 本轮首个请求即带压缩结果；超时 ⇒ WARN 后照旧放行（事务顺延，即旧行为）。新旋钮 **`flushWaitMs`（默认 180_000 ms = 与 `timeoutMs` 同量级；`0` = 关闭等待）**。登记方式 = 屏障 promise（`prior.then(() => pass)`）：新 pass 串联在既有屏障之后，**不改变 pass 自身的并发性**，只让一次等待覆盖该 session 的全部在飞 pass。9 次事务回看：7 次本就在窗口内及时落盘（新逻辑等价）、1 次为轮内压力路径（`compressOpenTurn`，本就在轮内压，不受影响）、1 次即 #9（本次目标场景）。
- **手动 `/compact` 压不动（只剪最老一小段）**。`selectManualRange` 扫描 surface 时，遇到第一个不合格节点（U/X、或落在 turnGuard / recencyGuard 保护窗内）就 `break`，而真实会话的 surface 是「U A R A R U A R …」被用户消息切碎的多段结构 ⇒ `/compact` **永远只剪最老一段**（表现为"图剪压不动"：手动触发后上下文几乎不降）。修复：改为收集**全部**极大连续 A/R 段（`selectManualRanges`），逐段复核边界（配对平衡 / 段内不含 U/X / 段内有可剪原子）后合并为**一笔** `pruneIntervals` 事务剪除；不合格区间**静默剔除**而非整体失败（旧实现下首个区间边界不平衡会直接 `throw`）。保护语义不变：turnGuard / recencyGuard 窗内原子仍不参剪，U/X 骨架仍不剪。
- 单测 **1 项**新增（`test/manual-compact.test.ts`）：被 U 切碎的多段 A/R 全部剪除。**变异检查**（把段闭合改回旧的"遇阻即停"）⇒ 该例如期失败（`both A/R segments must be pruned, got 2` = 旧行为只剪最老一段），确认用例非空转。
- 文档：`Config.turnGuard` 注释里的默认值由错误的 `2` 修正为 `1`（与 schema `default(1)`、构造回退 `?? 1` 一致）。
- 单测 **4 项**新增（`test/peratom-flush-wait.test.ts`）：在飞必须等待（旧实现此处立即放行）/ 超时上界生效后放行 / 已就绪时立即发射（不引入额外等待）/ `flushWaitMs:0` 逃生阀。并做**变异检查**（临时注释掉等待 ⇒ 前两例如期失败），确认用例非空转。全量回归 **268/268**（263 + 4 + 1）。

## [1.3.4] - 2026-09-21（resume 锚点回填 + peratom 压缩水位）

真环境实测来源：`session-77c64e66`（standard-argp，11 轮 / 232 步 / 334 工具调用）逐事件复盘 + 存档重放（`.sess-tools/replay-real.mjs` / `replay-sweep.mjs`）。

> **口径勘误（同日，重要）**：复盘初期据 `profiles/web/cordis.patch.yml` 的 `windowRatio: 0.3815`（09-17 层）推定"压力检查迟触发 2.1×、图剪全程只跑 1 次 = 缺陷"，属**读错配置层**。该会话实际生效的是更外层的 `~/.dsh/settings.yaml` → `dsh-argp.windowRatio: 0.8`（写入时刻 03:14:56，turn 1 内），触发线 = 262144 × 0.8 = **209,715**。
> 按 0.8 复算：该会话 232 个请求中**仅 1 个**越过触发线（turn 6 step 84，真实 210,719 = 线的 100.5%）；锚定估算在 **pre-step 85 = 213,070 ≥ 209,715** 触发（step 84 的估算 209,639 差 **76 tok** 未越）⇒ **引擎在越线后一步即压缩，行为与设计完全一致**。"图剪只跑 1 次"是"只有一次越线"的必然结果，非缺陷。
> 同理，"锚点丢失"这一诊断不成立：若锚点真的缺失，chars 口径在该会话的上限只有 ≈118K，**永不可能越过 209,715**，与实测的触发事件自相矛盾。故下文 ① 的定位由"修复生产缺陷"下调为"补齐 resume 首请求前的口径精度"。
> ✅ **配置层对齐（同日）**：`windowRatio` 原存两处不一致值——`~/.dsh/settings.yaml`（0.8，运行时生效）与 `~/.dsh/profiles/web/cordis.patch.yml`（0.3815，2026-09-15 语料跑批用）。现已把 profile 层同样改为 **0.8**，两层一致 ⇒ 既消除"settings 键被重置即静默滑回 100K 触发线"的陷阱，也使 0.8/0.2（触发线 ≈209,715 / 保留 ≈41,943）成为唯一口径。代码内置默认值本就是 0.8（schema `:76`、回退 `:138`、构造器 `:643`），无需改动。跑语料若需 100K 触发线，请在跑批 profile 显式覆盖（`docs/corpus-run-spec.md` §3.4 已加现状注记）。

### Fixed

- **resume 首请求前压力估算退化为字符启发式**（防御性修复；非本次实测缺陷）。`lastRealPromptTokens` / `lastRealAnchorSeq` 原先**只**由 `ctx.on('session/event')` 的 `assistant/message` 处理器写入 ⇒ 宿主进程重启后 resume 既有会话时锚点为空，`measureTokens` 在首个真实 usage 到达前回退 `visibleChars / charsPerToken`，而该投影口径**不含 reasoning** ⇒ 实测低估到真值的 **0.56–0.61 倍**（turn 6 逐 step 重放：0.633 → 0.556，差值 ≈ system+tools + 整轮 reasoning tokens，随轮单调增长）。后果有限但真实：resume 后的**第一个** pre-step 压力检查可能漏触发。修复：`bindSession` 检测会话身份变化时从 `snapshotEvents()` 反向扫**最后一条带 `usage.inputTokens` 的 `assistant/message`** 回填锚点（口径 = `in + cacheRead + cacheWrite`，与 usage 处理器同式）；日志无 usage（全新会话）则重置 `0 / -1`，保持既有回退行为。新增两个对照用例（回填驱动触发 / 日志无 usage 时不误触发）。**重放验证**（0.8 档）：回填态估算/真实 = **0.981–0.998**（`source=anchored`），清零态 = 0.556（`source=chars`）。
- **peratom 每轮一次性配额被轮内压力 pass 吃掉**（语义缺陷；0.8 档下影响受限于"越线次数少"）。`doneTurns` 原为"轮级一次性"记账，且 `done.add` 在候选门控**之前**：① 轮内压力 pass（turn 6 step 85）用掉该轮唯一配额 ⇒ 该轮此后新增内容**永不入压**（其尾巴 step 85-92 与后续 `idle` pass 全被跳过；本会话该尾巴合计仅 1,772 字符 ⇒ 实际代价小，但机制上不成立）；② 一次 `no-candidate` 短路即**永久作废该轮**，即使之后来了大原子。修复：改为**压缩水位**——成功 pass 推进 `(session, turn) → endSeq`，后续 pass 只收 `seq > 水位` 的原子 ⇒ 轮末 `idle` pass 可补压轮内新增；门控短路 / 中断轮**不推进**水位（该轮仍可被后续 pass 处理）；无新增原子时窗口为空 ⇒ 零 LLM 调用短路（幂等）。配套新增统一判据 `isMaterial`（对话载体 U/A/R ∧ `surfaceOp` 非 `replace` ∧ `user/message` 非 `plugin-source`），**同时**用于候选筛选与窗口边界：压缩产物（替换副本）与插件注入（A 形态前缀指令 / U-info 聚合副本 / checkpoint）均不算材料，既防副本被二次摘要，也避免"纯产物窗口"反复记 `no-candidate`。新增 3 个用例（轮内 pass → 轮末补压新增原子 / `no-candidate` 不烧配额 / 无新增时幂等零调用）。

全量回归 **263/263**。

## [1.3.3] - 2026-09-21（citesObligation autoLlm 时序修复）

### Fixed

- **auto 兜底（autoLlm）下回复级 cites 协议未被屏蔽**：`citesObligation` 的 auto 口径在**构造期**读 `declarer.armed` 定死，而 auto 兜底的 declarer 构造期未武装（路由要等真会话 `agent/status` → `rememberRoute` 才解析）⇒ `citesObligation` 恒 `true` ⇒ `argp-cites` system section 恒注册全文 ⇒ 模型持续输出 `{"cites":...}` 尾（dsh 宿主无 assistantDisplay 服务，UI 显示过滤器不生效，泄漏到用户可见回复）。修复：auto 口径（config 未显式给 `citesObligation`）下 section **恒注册**，`text` 回调在 `declarer.armed` 翻转后**动态返回 `''`**——`renderPrompt` 过滤空 section ⇒ system 块不再含协议，渲染结果与旧"不注册"逐字一致。`armed` 单调递增（`autoLlm` 只赋值不清除）⇒ 至多翻转一次，代价 = 一次 system 块 KV 失效（通常发生在首个请求之前，可忽略）；始终未武装时保持全文（两种边来源不能同时归零）。显式 `true`/`false` 覆盖保持静态语义不变（A₁-A₃ 实验臂不受影响）。新增回归测试（autoLlm 会话中期武装 → section text 翻转 `''`，走真实 `agent/status` 事件路径），全量回归 **258/258**。

## [1.3.1] - 2026-09-21（preset-cleaner isolate 残留修复）

### Fixed

- **preset-cleaner 净化副本残留 `isolate` 块导致 preset 挂载失败（建不了新会话）**：从 shipped preset 生成的净化副本 `<id>-argp` 只摘除了 `compaction-basic`/`tool-result-pruner` 行，却保留了 `compaction` 组上的 `isolate: { compaction: true, ... }`。cordis `isolate(name)` 的语义是被隔离的服务按**新 symbol** 解析、**不回落**宿主平面的 `compaction`（ArgpGraphEngine）——提供者被摘除后该隔离 realm 无提供者，`command-compact`（`inject=['commands','compaction']`）永久 "waiting for compaction" → 整个 preset 挂载失败（`agent-preset/invalid: 1 row(s) did not activate`），`agent-presets.default` 指向该 preset 时**所有新会话无法创建**。修复：新增 `stripIsolateBlock`，摘除 stock 行后同步摘掉对应组的 `isolate` 块，`command-compact` 的 `compaction` 恢复沿 scope 链解析到宿主平面的 ArgpGraphEngine，`/compact` 仍指向 ARGP 确定性 compactNow（零额外接线）。模块 doc-comment 同步勘误（旧注释"沿 scope 链向上解析到宿主平面"的假设在 isolate 存在时不成立）。preset-cleaner 测试扩至 11 项（含 `stripIsolateBlock` 4 例：命中剥离/无 isolate 不动/多 isolate 键只摘目标组/组内多行不受影响），全量回归 **257/257**。

## [1.3.0] - 2026-09-20（P6 轮内压力压缩「方案 B」+ Stage-1 生产路径修复）

### Fixed

- **压缩调用输出 cap 4096 → 16384（按 262,144 墙重标定）**：plan 的 quotes 部分 = dialog 保真保留（用户指令逐字转写，尺寸与原子原文同量级，不可省）⇒ cap 截断 = JSON 不完整 = parse 失败 = 整轮保原文。实弹（record 端到端，3-turn 语料）证实 4096 在首个大轮即截断（`completion_tokens=4096`）。防爆余量重算：触发线 100,007 + agent maxTokens 32,768 + cap 16,384 ≈ 149K ≪ 262,144（旧 174K 墙时代"让 margin"的推导过时；KV 池 933K 下 16K 响应的 prefill 搅动可忽略）。
- **prefixWithinBudget 读 usage 挂载路径错误 + 口径低估（P6 验证闭环抓到）**：真实 `assistant/message` 事件 usage 挂 **data 顶层**（agent-loop 落账 `{turn, step, message, usage, stream}`），旧实现读 `data.message.usage` 恒 undefined ⇒ **生产上 A 形态前缀被静默全量降级 C**（方案 B 复用收益不生效；压缩本身安全 = 保守方向）。且只算 `inputTokens`（未命中）会低估 prompt——billed 口径 = `inputTokens + cacheReadTokens + cacheWriteTokens`（与引擎真实锚点同式）。compressor / cite-declarer 两处同修；回归锁 = "inputTokens 10K + cacheRead 130K 超 132K 预算必须降级"用例。实弹：修复后压缩请求 6/6 全部 A 形态带前缀。

### Added

- **P6 轮内压力压缩（方案 B）**：turn N 上下文达标（与图剪 `compactIfNeeded('pressure')` 同口径的 `isPressureExceeded`）且存在 open turn ⇒ **同一 pre-step 窗口内先 per-atom 压缩 open turn 原子、再图剪头部**（两变异合成态 = "剪枝后老轮 + 压缩过的新轮"，无独立 restore 机制）。接线双路：`config.onPrePressureCompress` 显式注入 + `config.peratom` 自挂载时自动接 `compressor.compressOpenTurn`；回调失败隔离（吞错照常图剪）；无 open turn（全闭合）不压（活跃态守卫，闭合轮归 idle 边界路径）。配套：`resolveEffectiveCtk`（`enable_thinking:false` + `preserve_thinking:false` + 主链 `reasoning_effort` 从 `request/header` config 重建——LlmCallConfig 无 ctk 字段）、`doneTurns` 跨路径防重（open turn 压过 ⇒ 该轮闭合后 idle prepare 零调用跳过）。
- **A 形态前缀预算门控**：`prefixBudgetTokens`（默认 132,000）超预算该次**降级 C**（丢前缀只发指令），`degradedToC='prefix-budget'` 留痕——"全前缀或无前缀"二元；无 usage 可参照（会话头）保守降级。
- 单测 11 项（`test/peratom-pre-pressure.test.ts`）：pre-step 顺序（压先于剪）、压力同口径、无 open turn 守卫、失败隔离、集成（真 compressor 自挂载 + fetch 替身 + 图剪零 LLM）、doneTurns 跨路径防重、预算门控三例（预算内/三和口径超限/无 usage）、ctk 形状两例（主链 effort 继承 / 缺省不发 re 键）。`npm test` **253/253**（1.2.0 基线 242 + 11）。
- 实弹验证（record 端到端 + 线级 metrics 真值）：轮内触发时序、A 形态前缀与 ctk 在真实 wire 全部生效、输出 cap 防爆精确截断；KV 命中率 72.9–79.5%（metrics Δ，新引擎池 933K 无驱逐压力）。
- **Stage-1（双引擎）无生产挂载路径**（规格 §11.13.1）：`ArgpGraphEngine` 的 Stage-1 三管线只在 `config.peratom` 为对象时构造（`src/argp-graph-engine.ts:679`），而 `cordis.patch.yml` 的**整个 git 历史从未写入 `peratom`**——自 **2026-08-28**（`41fa600`）`config.peratom` 闸门引入起，bundle patch 就没有同步补上声明（bundle / profile / agent preset 三层皆无，历史备份逐字相同）→ 实际分发形态是**纯 Stage-2（0-LLM）**。插件自己的类型文档早已记录此缺口（`peratom?` doc-comment 原文："本块存在的意义是真宿主 bundle patch 只能声明式挂一个插件入口（发现一：default export 只有 graph 引擎 = 双引擎无生产路径）"，2026-08-28），bundle patch 头部注释亦自称 "mounts the 0-LLM ARGP engine"。后果：**组件 B（HLS repair）在默认安装下结构性不可达**（受控语料两臂 `[restored]` 计数均为 0、6386 次替换全是 `[elided]` 墓碑、`拆分/提取/摘要` 计数全 0、标签恒为 `argp/deterministic-guards`）。
- **关停陷阱 `peratom: false` 反向挂满**（同上，顺带修复）：闸门旧写法只判 `config.peratom !== undefined`，而 YAML 里"关掉 Stage-1"最自然的写法 `peratom: false` **会通过闸门** —— 布尔装箱后 `.compressor` 取到 `undefined` → `?? {}` → **三管线全挂**，与写配置者的意图完全相反。改判 `typeof config.peratom === 'object' && config.peratom !== null`，`false`/`null` 一律按"不挂"（与缺省同语义）。

### Added

- **宿主路由自动兜底 `autoDshLlmSpec(ctx, route)`**（`peratom/llm-adapter.ts`）：`PeratomCompressor` / `CiteDeclarer` 的 LLM 后端在**显式 `config.llm` 与 fetch（endpoint/apiKey/env）两路都缺省**时改为**延迟解析**——在真会话的 `agent/status` / `agent/pre-step` 钩子里现取 `agent.options.{provider,model}`（`rememberRoute`），配合宿主 `ctx.llm`（`LlmRuntime`）合成 `DshLlmSpec`。宿主换模型自动跟随，分发物不必钉死 provider/model。判定从严：路由缺任一项、或宿主无 llm 服务即返回 `null`，组件保持 disabled（**零网络**，与既有语义逐字一致；构造期日志由 `warn` 降为 `info` 并说明 auto 模式）。选路优先序 `backend()`：显式 `config.llm` > fetch > 自动兜底；`compaction/summary` 的 `provider`/`model` 标签同步反映**实际选路**（审计据此判"Stage-1 是否真的跑过"）。`CiteDeclarer.armed` 随路由到位翻转。
- 单测 5 项（`test/peratom-llm-adapter.test.ts` + `test/peratom-mount.test.ts`）：`autoDshLlmSpec` 边界（路由缺项/空串/宿主无 llm）、compressor 未武装→路由到位后武装（provider/model 跟随、fetch 零调用、落盘链路一致）、显式 `config.llm` 优先于兜底、declarer `armed` 翻转 + 声明边入缓存、`peratom: false` 不挂。`npm test` **242/242** 全绿（1.2.0 基线 237 + 5）。
- 规格文档 §11.13.1：根因定位（挂载闸门 + 逐层配置表 + 类型文档自述）+ 处置与**开启配方**（profile 层 modify 加 `peratom` 块；改后须开新会话）。

## [1.2.0] - 2026-09-17（token-ontology 组件 A/B + §11.8① 墓碑地板修复）— **BREAKING（宿主基线迁移）**

> **宿主基线再次跳档**：1.2.0 起 peer 对齐 **dsh ≥ 0.1.6-alpha.1**（cordis ≥4.0.2）。0.1.5-rc.1 宿主请继续使用 **1.1.0**。
> 沿 1.1.0 惯例——dsh 无真 stable 线，其 `latest` 即 rc 构建，故跟随宿主线仍发 stable 版本号。
> 本版核心 API 零漂移（alpha 线实测 build/237 测试全绿），迁移面仅依赖下限；另有三项默认行为变化见下方 Added/Fixed（均可旋钮回退）。

### Fixed

- **§11.8① 墓碑地板不可再剪（tombstone-merge）**：X 原子在 `isAtomCandidate` 结构性不可剪（`type ∉ {A,R,U}` 直接 return false）→ 每次压缩注入的 `[elided …]` 墓碑单调累积成"地板"，剪到候选耗尽仍超窗。受控语料两臂独立复现同形态 `CONTEXT_WINDOW_EXCEEDED`（run1 T17 / run2 T16，provider 报错数字同为 `141,313+32,768>174,080`）；run2 dump 重放投影实测 **1297/1310 surface 节点是墓碑、284,786 chars ≈142K tok、最长连续段 1295**。修复：新增导出纯函数 `isMergeableTombstone`（三判据 `[elided` 开头 + `pruned by ARGP` + `recall_pruned`；宿主注入 / 官方 checkpoint / tool 占位墓碑不合并）+ `consolidateTombstones()`（找第一段 ≥N 连续墓碑，tool-pairing 平衡校验后复用 `pruneIntervals` 事务骨架归并为单条聚合墓碑——聚合碑保持可再归并形态，地板随轮次收敛到常数；失败非致命）；挂点 `compactIfNeeded` 压力门槛后、建图前（热路径零开销）。旋钮 `tombstoneMergeMinRun`（默认 8，**0=关闭**，对照臂 A/B 用）。端到端实测：run2 T16 归并 ×1294 碑 → 1 条 192 字符聚合碑，surface elided 从 1297 节点/285K chars 塌至 6 节点/1459 chars，T16–T22 全部跑完、零再撞墙（237/237 测试绿，新增 4 项）。详见 `docs/corpus-run-spec.md` §11.8.1。

### Added

- **HLS 经济学门控（组件 B 的代价盲修正，I-B5）**：`repairWithTrailer` 原先**无论值不值一律补全**——spike39 实测尾注开销 1003 字符 = 原文 41%、修复后 = 候选的 2.05×，F1/F4 两例 ROI 仅 0.02/0.07（几乎退化为"原文保面"）。新增 `token-ontology.ts` 的 `hlsRepairEconomics()` 纯函数与 `trailerText()`（尾注长度唯一事实源），判据：
  `B = L_orig − L_cand`（prose 增益）、`C =` 尾注占用、`N = B − C`（净释放）、`ROI = N / C`，仅当 `ROI ≥ θ` 才修复。
  默认 `θ = DEFAULT_HLS_ROI_THRESHOLD = 1`（尾注须替自己买单）；`N < 0`（越修越长）在任意 `θ ≥ 0` 下都被拒，退回 v1.1「原文保面」。配置面 `hlsRoiThreshold`（`PeratomCompressorConfig` + `PlanOptions`）；新增台账 `hlsRoiSkipped`（plan + `CompressRecord`）度量该区间频率。spike39 六例 ROI：F1=0.02 / F2=1.48 / F3=0.80 / F4=0.07 / F5=0.29 / F6=2.14（聚合 0.49）→ θ=1 下仅 F2/F6 存活。
- **`spike/40-edge-precision.ts`（`npm run spike40`）——组件 A 误连率实测**：受控植入真值（唯一 handle 数据原子 + A 原子植入"真依赖 T / 仅提及 M"），0-LLM 离线。结论：无噪音基线 precision=recall=1；误连率曲线精确等于 `m/(2+m)`（m=0/1/2/3 → 0%/33.3%/50%/60%）；半公共 handle（DF 13.2% < 15% 停词阈）漏网产生误连（**F40-1 HIGH**：停词是全或无二值，缺 DF 衰减）；`maxEdgesPerAtom` 按 seq 降序截断会丢更旧的真依赖（**F40-2 MEDIUM**）。
- **`npm run typecheck:spike`（`tsconfig.spike.json`）**：补齐覆盖率缺口——根 `tsconfig.json` 的 `include` 只有 `src/**` + `test/**`，**spike/ 一直不在类型检查内**（spike38 的未定义变量、spike39 的已移除 API 都只能靠运行时暴露）。新增配置把**当前世代 spike（38–42 + `spike/lib`）**纳入检查并挂到 `npm run check`；历史 spike（01–37）因 dsh API 漂移尚有约 130 个既有错误，暂不纳入（待单独清理）。
- **`spike/42-edge-labels.ts`（`npm run spike42`）——真实边标注工作表 / 打分器**：把真实语料上派生的边做成**盲化**工作表（实测 68 条：单 token 支撑 61 / ≥2 支撑 7），并给出打分器（总 precision + 分层 precision + Wilson 95% CI + 分层差 Δ）。**标注单位 = 配对**（A 摘录 + R 摘录 + 共同 token），**不用整轮对话**——整轮会泄露"后来发生了什么"这条捷径（该 session `read` 144 次 / `recall` 仅 2 次，静默降级是常态）。支撑强度单放 `.key.json` 以保盲化；判读规则先定死（Δ 显著为正才支持"≥k 独立 token 建边"）。**隐私**：工作表写 gitignored 的 `spike/out/labels/`，绝不提交。
- **`spike/lib/session-corpus.ts` + `spike/41-real-corpus.ts`（`npm run spike41`）——真实 session 语料能力**：本机 `~/.dsh/sessions` 的 session 可作测试语料。读取器要点：`session.v3.jsonl.zstd` 是**多帧 zstd 拼接**（单文件实测 502 帧），Node 的 `zstdDecompressSync` **只解第一帧且不报错**（会把 1.5MB 静默解成 193 字节）→ 需按 magic `28 B5 2F FD` 扫帧起点逐帧解压。**隐私铁律**：只读、绝不写回；**任何 session 原文不得提交进仓库**；需要可复现性时只提交派生聚合量；用例须能在目录缺失时优雅跳过。实测 4 个 session / 646 原子 / 1,052,502 字符，读取器 **0 坏帧、0 非法行、seq 缺口 0、重复 0**。
- **`spike/43-corpus-audit.ts`（`npm run spike43`）——受控语料自检**：跑完一份受控 session 后判定**这份语料能测什么、不能测什么**（不给"大概行"）。四组：①结构验收（chars/atoms/prune 量，`compaction/start` 因含 overflow-retry 膨胀仅作参考）②场景有效性（cites 声明率、跨轮 handle、extract 候选量、推断边）③**驱逐代价**（prune-then-reread）④**组件 B 生产线观测**（替换副本里的 `[restored]` 尾注 → 逐例复算 ROI、统计 θ=1 会拦下多少）。
- 真实日志的免费观察 + **两处自我纠错**：① `cites` 声明在 4 个 session 合计 **2 次**（1 处 / 136 条 assistant 原始回复 = 1.5%，其余为 0）而引擎做了 265 次 `compaction/prune` → 组件 A 基本是唯一语义选择性通道；**此前记为"0 次"是错的**（计数须只扫 append 原始写入的 assistant 正文，扫全日志会因 replace 副本虚增到 28）。② **`[restored]` 真实落盘 0 例**；裸文本搜索得到的 41 处**全是假阳性**（来自"对话在讨论 HLS 机制本身的源码"）→ 正确判据是 **I-B3 构造性**（尾注 token 逐字 ⊆ 原文承重词表）。③ 引入非循环指标 **prune-then-reread**：被驱逐路径 24/30（80%）在同 session 被再次读取——**上限值，可归因代价须由对照组做差**。

### Changed

- **宿主依赖线对齐 0.1.6-alpha.1**（发包前置，用户拍板走 alpha 档而非 rc.2 保守档）：18 个 `@deepseek-ai/dsh-*` peer+dev 从 `^0.1.5-rc.1`/精确 `0.1.5-rc.1` 升 `0.1.6-alpha.1`；`cordis` `^4.0.1`→`^4.0.2`（alpha 全线要求）；`schemastery` 不动（alpha 不约束）。零 API 漂移（typecheck/spike/smoke/237 测试全绿）。harness 侧 54/55 包同步（`dsh-code-runtime` 例外：alpha 线不存在、无人 peer，留 `0.1.5-alpha.2`）。坑：旧 lockfile 树毒 ERESOLVE 解析，须删 lock+node_modules 全新解析。
- **spike39 口径分离**：机制不变量（I-B1/I-B3）改测 `repairWithTrailer` **本体**，经济性（I-B5 门控）测 `planReplacements` 的放行/拒收。此前二者混用（用 plan 度量不变量）——门控一经引入即全线误报 FAIL。新增 **S39-6 门控一致性**（落盘集 == `{ROI ≥ θ}`；放行⇒`hlsRepairs=1/skippedFidelity=0`，拒收⇒`hlsRoiSkipped=1/steps=0/skippedFidelity=1`）与 `θ=0` 对照臂；S39-3 节省率改在**落盘子集**上计算（2/6 落盘，落盘子集节省 39.4%），不再被"退回原文"的零改动稀释。结果：ALL PASS（S39-1/2/3/5/6）。
- **spike38 S38-4 清账**：原断言拿常量 `7` 对表 `citeStats`（引擎内 `+=`，**跨 buildGraph 累加**）与 `inferredStats`（**最近一次建图**口径）→ 多趟 pass 下必然误判。改断不变量：ON/OFF 剪枝序列逐位一致 + 最终图 0 条推断边 + `accepted=0` + **两通道保护集完全重合**（原 INFO S38-5b 提升为硬判据）；原始计数降为 INFO（S38-4b/4c）。结果：spike38 ALL PASS（S38-1..S38-5）。
- **spike39 live 臂 API 修复**：`session.events` 在 dsh 0.1.5 已移除（1.1.0 CHANGELOG「Session.events 彻底消失」），live 臂仍用它 → 只因"无本地模型"长期跳过而潜伏。改经 `log-access.sessionEvents()`（与 spike38 同纪律）。

### Verified

- `npm run typecheck` 干净；`npm run typecheck:spike` 干净（38/39/40 零错误）；`npm test` **237/237** 全绿（较 1.1.0 基线 229 累计新增 8 项：HLS 门控/token-ontology 5 项 `trailerText` 口径、`hlsRepairEconomics` 数值与 θ 灵敏度、tool/info 两路门控放行与退回 + 墓碑归并 3 项）。
- `spike38` **ALL PASS**（S38-1..S38-5；S38-4 清账后转绿）、`spike39` **ALL PASS**（S39-1/2/3/5/6）、`spike40` 度量成立（2 PASS + 2 如实 FAIL = 机制边界 + 2 FINDING）、`spike41` **ALL PASS**（读取器完整性 0 坏帧/0 非法行/seq 零缺口；真实语料 2 条 FINDING）。
- 真实语料校准（spike41）的净结论：**不降低组件 A 的有效性，降低的是"稀有 handle 共现 ≈ 语义信号"这一信念**。受益侧（spike38 S38-3 的 3/3 保护）不受影响；暴露的是信号**判别力弱**（89.7% 单 token 支撑——而单 token 恰是真引用与巧合提及的**共同形态**，故不等于误连率高）与停词阈**结构性空转**（F41-1，maxDF 17 ≪ 阈 33）。**同时撤回上一版的两条修法建议**（"停词按 DF 衰减"、"≥k 独立 token 才建边"）：前者无从衰减，后者会误杀真引用。**在拿到真实误连率标注前不应改门控。**
- 文档：`PROPOSAL-token-ontology.md` 新增 §2.1「已知边界」（spike40 结论 + 缺口 2 能力边界 + §5 生命周期 2/3 结构天花板）与 §3 门控口径；§5 验收表补 Spike 40 / 门控单测行。

## [1.1.0] - 2026-09-10（dsh 0.1.5 支持：V3 会话信封迁移）— **BREAKING**

> **宿主兼容性跳代。** 1.1.0 起要求 **dsh ≥ 0.1.5-alpha.1**；rc.2 ~ 0.1.3-alpha.2 宿主请继续使用 **1.0.5**。两代不兼容，且无法在同一个构建内兼容——详见下方「为什么不能两代通吃」。

### Added

- **`asSeq` / `asSeqs` 边界收窄 helper（`log-access.ts`）**：dsh 0.1.5 起 `SessionSeq = BrandedNumber<'SessionSeq'>` 是品牌类型，而 ARGP 内部模型（原子/区间/账目/预算）一律用裸 `number` 做算术。约定：**内部永远裸 number，只在写入/查询 dsh API 的边界收窄**，不做重复运行时校验（宿主 `Session.append` 已对 seq 做权威校验，重复校验只会把错误信息推离现场、并制造第二份需同步维护的真相）。
- **node-0 系统提示保护用例 + `atomize` 显式注释**：0.1.5 把系统提示表示为 surface node 0 的 `system/message`，宿主 `assertSystemHeadRewrite` 硬性保护该位置。`atomize` 只认 user/assistant/tool-result、`system/message` 静默跳过 → node 0 永不进入剪枝区间。原先这是隐式依赖，现已写进注释并由测试钉死（`argp-graph-engine.test.ts`）。

### Changed — 迁移到 V3 会话信封

- **`SurfaceOp` 判别键改名 `start`/`end` → `startSeq`/`endSeq`**（dsh commit `657e68186a`，V3 canonical session envelopes），5 处 production 写点 + 12 处测试同步改名。
- **`assistant/message` 禁止携带 `sourceEventSeqs`**（类型层 `?: never` + 运行时 `assertProvenance` throw）。删掉 cites 剥离写回处的该字段——安全性由「`shadowedSeqsOf` 只认 `compaction/prune.shadowedSeqs` 权威账本」保证，不再从 replace 事件反推被遮节点。
- **`Session.events` 彻底消失**：1.0.4 引入的 `sessionEvents()` 双分支中，legacy 分支在受支持基线上已不可达，仅作防御保留（改由 stub 用例覆盖）。
- **`assistant/message` 新增必填 `stream` 字段**、`testkit` 的 `systemPrompt.persona` → `personaPrefix`、`dsh-llm` 的 `CallId` → `ToolCallId`。
- **依赖基线整体升到 `0.1.5-rc.1`**（peer + dev 全部）；`cordis` 保持 `^4.0.1`（master 用 4.0.2，caret 已覆盖）。

### 为什么不能两代通吃

两代都强制 `Object.keys(surfaceOp).length === 3`（rc.2 认 `op/start/end`，0.1.5 认 `op/startSeq/endSeq`），**同时写两套键必然被拒**。一个构建要同时支持两代只能加运行时版本嗅探——对主打确定性的引擎而言是不必要的不确定性来源，故取舍为：**1.0.5 守住老宿主，1.1.0 走新格式。**

### Verified

- `npm run check` 全绿（**211/211**，2026-09-10），新增/改写用例含：node-0 保护、`sessionEvents` 当前基线实证 + legacy stub、V3 键名全链路。
- 依赖基线换代前的红灯对照：只改代码不改依赖时 209 总 / 133 过 / **76 失败**（全部 `carries an invalid replace surfaceOp`）——这是「测试基线落后于目标宿主」的直证，也是本次必须同步升依赖的原因。

### Known

- 0.1.5 起 dsh 默认模型切到 **DeepSeek-V41-Flash**（V4-Flash 仍保留可选）。ARGP 既有的 v4-flash 成本标定数字**不得外推**到新默认档。

## [1.0.5] - 2026-09-04（preset 净化自动生成 + WebUI 设置卡片）

### Added

- **Preset 净化器（Q8 双引擎收口）：引擎挂载期自动生成 `<id>-argp` 净化 preset（`preset-cleaner.ts`，commit 2881669）**：dsh rc.2 把 agent 组成迁入 preset 平面后，standard/cordis/ptc 各自在隔离 realm 内挂官方 `compaction-basic`，宿主 profile 的 `disabled: true` 物理管不到（平面错位，非 loader bug）→ 官方摘要器与 ARGP 双引擎同秒抢 `agent/pre-step`，有损摘要抢跑图剪。修复：`ArgpGraphEngine` 构造期经 `ctx.inject(['agentPresets'])` 触发 `cleanShippedPresets()`——对每个仍挂 stock compaction 的 shipped preset 走官方 `copy()` API 生成 `<id>-argp` 副本（落 `~/.dsh/.agent-presets/`），缩进感知行手术摘除 `compaction-basic` + `tool-result-pruner`（零 YAML 依赖，`!!js` 行不触碰）；**保留 `command-compact`**——realm 内 `compaction` 服务沿 scope 链解析到宿主平面 ARGP 引擎，`/compact` 自动指向确定性 `compactNow`，零额外接线。幂等 + 漂移自愈 + fail-soft，写回靠 standing-mount 文件戳热生效（新会话免重启）。`config.presetClean: false` 可关。shipped preset 源文件逐字不动（单测断言），净化是增项不是替换。首启实证（2026-09-04）：`cordis-argp`/`ptc-argp`/`standard-argp` 三副本落盘，stock 行 grep 零命中。
- **WebUI 设置卡片（commit 5e1ec38）**：Settings → 插件 → 插件配置新增 ARGP 卡（`src/client/`，自绘 React 无 JSX），编辑 9 个引擎旋钮（windowRatio/retainRatio/maxPasses/recencyGuard/turnGuard/minSpanChars/enableSummarize/sortMode/charsPerToken），含 overridden 徽标 + 单字段 reset、脏态暂存与保存/放弃。

### Fixed

- **设置卡片浅色主题黑底不可读（commit f5c341f）**：卡片内联样式引用宿主不存在的变量（`--bg-elevated`/`--border`/`--bg-input`/`--accent`/`--danger` 等），全部落到暗色回退字面量 → 浅色主题下黑底黑字。改用宿主 `--dsw-alias-*` 主题体系（浅/深双套自动适配），回退字面量全部换浅色安全值，chrome 对齐宿主 `PluginCard`。

### Verified

- `npm run check` 全绿（209/209 PASS，2026-09-04），含 preset-cleaner 7 条单测（缩进手术幂等/漂移自愈/源文件不变式/白名单）。

## [1.0.4] - 2026-09-03（dsh 0.1.2-alpha.4 兼容 + 仓库定位收敛）

### Fixed

- **dsh 0.1.2-alpha.4 升级阻断：`Session.events` getter 被移除（breaking `27bf1039db`），插件崩溃 `Cannot read properties of undefined (reading 'length')`（2026-09-02 定位）**：全库事件日志读取原直接访问 `session.events`（rc.2 专属 API）。修复：新增 `sessionEvents(session)` helper（`log-access.ts`，运行时探测 `snapshotEvents`→alpha.4 / 回退 `events`→rc.2），作为全库唯一事件日志入口；事件计数 `.length` 改读 `session.seq`。8 文件 46 处收口，`npm run check` 202/202 全绿 + 双宿主实证（legacy `events`=alpha.1 WebUI 真挂载；modern `snapshotEvents`=alpha.4 探针）。`SESSION_FORMAT_VERSION` 仍为 0，存量会话字节兼容。
- **spike 基建误伤（1cb4f18）**：1.0.3 后的 spike 精简误删了仍被 8 个存留 harness import 的共享挂载工具 `spike/deepseek.ts` / `spike/model-mount.ts`（`npm run smoke:deepseek`、spike6/7/8/26 全部悬空）→ 自 `eb99d74` 恢复。

### Changed

- **peerDependencies 放宽为 `^0.1.1-rc.2`**（原为精确钉死），兼容 rc.2 → 0.1.2-alpha.4 双宿主（eb99d74）。

### Docs（仓库定位收敛：面向直接安装用户的非学术仓库）

- 新增根级 **`ARCHITECTURE.md`**：面向使用者的实现说明（事件原子化与引用边 / 反向拓扑剪枝不变式 / 双引擎生产挂载 / shadow-price 契约 / sessionEvents 双宿主 / recall zoom / 不变式清单），与 README 的特性介绍分工。
- README（中/英）定性化改写：水位与轮次放大改定性口径；测试数更新为 202/202（2026-09-03 实测）；证据落点收敛到 CHANGELOG（`spike/out/` 为 gitignored 本地产物目录，外部读者不可见）。
- 内部台账（设计基准/证据链/上游投递稿，15 篇 docs + 11 个零引用 spike 脚本）迁出公开仓库；`docs/` 仅保留 `dsh-argp-mount-example.md` 与 `dsh-llm-adapter.md` 两篇用户向文档；spike/ 收敛至 26 个有活引用的脚本。

### Verified

- `npm run check` 全绿（202/202 PASS，2026-09-03）。

## [1.0.3] - 2026-09-01（KV 前缀缓存击穿深层修复：永久冻结 catalog）

### Fixed

- **1.0.2 的「冻结-on-剪枝」仍漏：agent/pre-step 每步重绑 session 致 catalog 段非剪枝轮显隐（2026-09-01 定位）**：`agent/pre-step` 每步调 `bindSession(agent.session)`，dsh 每步传入的 session 对象可能换新身份 → `if (this.session === session) return` 对象恒等守卫失效 → `bindSession` 重跑 → `frozenCatalog` 被重算成当时 `catalogText` 值（某些步返回 `''`）→ `argp-catalog` 段在**非剪枝轮**凭空消失/重现 → system 块字节变、整块 KV 丢弃（用户报「glob 后重新注入提示词」）。证据：实时会话 `session-ef109049-…` 里 5 个 `request/header` 事件 system 块变 3 次、且**全部在非剪枝步**；`compaction/prune` 全挤在 seq 16707–16721、落在两个字节完全相同的稳定请求之间 → 变化与剪枝不同步，变化文本即 `[context] Compression removed N` catalog 块。修复：**永久冻结**——`bindSession` 仅在 `frozenCatalog === null`（首次绑定）拍一次快照；`pruneIntervals` 落剪不再刷新；`argp-catalog` section fallback 为 `''`（极端 null 也恒定，不再 live 重算）。system 块全程逐字节恒定、KV 100% 命中（含真实落剪轮——剪枝那步失效本是压缩固有权衡，catalog 文本不再额外变一次）。

### Verified

- `npm run check` 全绿（198/198 PASS），含 2 条回归测试（catalog 永久冻结、跨真实落剪仍恒定）。
- 端到端 spike `verify-frozen-catalog-cache.ts`：12 轮 / 4 次真实落剪 / **system 块变化 0 次 [PASS]**。
- 多引擎审计：peratom/recall（`recall-engine.ts`、`peratom/recall-zoom.ts`）的 system section 均为静态字面量、pre-step 不碰 system；bundle 仅挂载 `ArgpGraphEngine`，`ArgpRecallEngine` 与之互斥不共存 → 无多引擎叠加 KV 威胁。

### Docs

- 代价说明：catalog 冻结在首次绑定时刻值（全新会话通常 `''`），inline "Compression removed N" 目录不再显示；`recall_pruned` / `list_pruned` 仍扫原始日志、发现能力不丢。

## [1.0.2] - 2026-09-01（KV 前缀缓存击穿修复）

### Fixed

- **每步 assemble 重求值 argp-catalog 致整段前缀缓存 KV 失效（2026-09-01 定位）**：`argp-catalog`（order 9999）原为动态 PromptSection，每步 `systemPrompt.assemble()` 重求值；ARGP `agent/pre-step` 每步 `compactIfNeeded('pressure')`，剪枝压力下 `shadowedSeqsOf` 增长使 `catalogText` 输出变化，改动单条被前缀缓存的 system message 块 → 整块 KV 丢弃（剪枝压力在轮末达峰，故"最后一步"显形，用户报"所有 KV 缓存丢失"）。修复：catalog 改为**全程冻结快照**——`bindSession` 拍初值、`argp-catalog` section 回放 `frozenCatalog`、唯一刷新点在 `pruneIntervals` 落剪成功末尾（恰在可见上下文因剪枝换代之后）。无剪枝整段对话 system 块逐字节一致 → 前缀缓存全段命中；剪枝那一步的失效是上下文真实变更的必然代价（与摘要式压缩同源权衡）。`npm run check` 全绿（196/196 PASS）。

## [1.0.1] - 2026-09-01（resume 投影契约修复 + 反馈通道补齐）

### Fixed

- **graph 剪枝违反宿主 shadow-price 严格相等契约，导致 WebUI resume 投影 throw（2026-09-01 定位）**：`pruneIntervals` 原发「一个总跨度 `compaction/prune`（shadowedRange=全区间 first..last）+ N 个逐区间 replace」，而宿主 `token-meter/surface-projection.ts foldSurfaceProjection` 要求 shadow-price 事件的范围与紧随其后的 surface replace **严格相等**，否则重放投影 throw（`"token surface: replace at seq N ... no adjacent shadow price (armed claim covers A-B)"`）。alpha.2 新增 per-turn usage 投影（dsh #3005）接入 resume 路径后该矛盾首次暴露（rc.2 同数据可正常 resume，故长期未被发现）。修复：对齐宿主官方 `compaction-tool-result-pruner` 的逐节点模式——**每区间 1 个 `compaction/prune`（shadowedRange=该单区间）+ 紧邻该区间 replace**；末尾 `compaction/summary`（总范围，off-surface）保留，其 claim 被紧随的 off-surface `compaction/end` 清掉。`rebuildLedgerFromLog` 同步改为合并事务内全部 prune（兼容旧单 prune 日志）。新增 fold 契约回归测试（复刻宿主 fold 判定，旧结构必 throw / 新结构必过）。存量脏会话日志有配套修复脚本（不改 `shadowedSeqs`，recall/账本能力保留，宿主真实 fold 函数金标准验证零 throw）。

### Added

- **peerDependencies 补 `@deepseek-ai/dsh-agent: 0.1.1-rc.2`**（与其余 dsh-* peer 对齐，此前漏列）。

### Docs

- **反馈通道补齐**：README（中/英）新增「问题反馈 / Reporting issues」节（Bug→Issue，设计讨论/使用问题→Discussion，附 dsh 版本 + 本包版本 + 最小复现指引）；`package.json` 补 `bugs.url`（npm 详情页直接挂报错入口）；CONTRIBUTING 反馈渠道改为「Bug 开 Issue，讨论开 Discussion」——修正此前「不启用 Issues」的表述（仓库 Issues 实际开启中）。

## [1.0.0] - 2026-08-29（双引擎落地版）

> **发版门槛结案（2026-08-29）**：① 轮次放大判据实测 **PASS 8.57×**（溢出存活：A 臂 60/60 轮零中止 vs E 臂零压缩 T8 死亡；8K 窗预注册压测，产物 `spike/out/37-three-arm-{E,A}-2026-08-29T07-04-*`，）。② 复核三项经用户拍板（2026-08-29，DeepSeek 额度不足）改为**本地机制验证**：引擎稳态缓存零税（healthy 峰 86-87% ≡ E 对照 84.7%，三次测量两模型两窗口交叉钉死；双峰口径修正见审计脚本头注）、保真判据未受压（D 7/7）。DeepSeek/v4-flash 标定降级为 post-1.0.0 可选补充；对外措辞按三禁规则执行（数字带窗口/任务/模型三要素）。同日独立 review 两处坐实缺陷修复（见 Fixed）。

### Added — 双引擎（Stage-1 per-atom，此前的 0.x 版本只有 Stage-2 graph）

- **PeratomCompressor**（eager 轮末熵降）：确定性门控（`gate.ts` 判"是否可压"）+ 单次 LLM 调用逐原子决策（`extract` 逐字摘录 / `summary` 概括入账 / `false` 显式不压）；长 user 消息 dialog 抄写拆分 + U-info 聚合（空隙归 info，spike 32 实测定案）；tail-only 替换 + 前缀指纹不变断言（缓存经济生命线）。
- **CiteDeclarer**（轮末边声明）：模型按近 10 轮窗口声明跨轮引用边，经 `injectEdges` 通道喂给 Stage-2 建图——实测召回效率 ≈ 无边臂 2.6×。
- **RecallZoom**（两级召回）：`recall_summary` / `recall_detail`（日志原文逐字节一致，sha256 测试锁定）+ 4 倍制预算（超限引导不硬拒）。
- **Stage-2 对接 + 溢出三步**（P4）：U-info 按 R 待遇参剪（唯一引擎改动点，五处触点枚举测试）；context-overflow 恢复环插入 forcePrune→compress→forcePrune 序列；生产挂载工厂（`mountPeratomStack`）+ 引擎 `config.peratom` 自挂载块（bundle patch 单插件入口，P0）。
- **dsh-llm 生产适配器**：compressor/declarer `config.llm = {provider, model}` 走宿主 LlmRuntime（`purpose='compaction'`、usage 入 record、多模型分工独立指定）；fetch 遗产路径行为不变作 fallback；严格宿主下免 inject 解析（`resolveLlmRuntime` 双通道）。
- **压缩事务 UI checkpoint**：peratom user 替换携带 compact checkpoint 署名 + 双管线事务追加 `compaction/summary` 展示事件（诚实计量；`compaction/prune` 仍是唯一权威账本）——替换型压缩首次在 WebUI 可见并显示真实计量。
- **citesObligation 门控**：回复级 cites 协议退役——declarer 已武装（解析到 LLM 后端）时不再注入 `argp-cites` system section，边声明走结构化旁路，回复正文不再携带 `{"cites":...}` 尾；显式 true/false 覆盖（A₁-A₃ 实验臂可强制开）。
- **预算手动旋钮显式化**：`windowRatio` / `retainRatio`（或绝对值 `windowTokens` / `retainTokens`）+ 压力测量来源标注（`anchored`/`tokenMeter`/`config`/`chars`，进压力日志供实验审计）。
- spike/37 五臂 harness（A/B/C/D/E）+ K_no 死亡检测 + 反事实轨迹 + 放大倍数计算（P5-bis 就绪）；spike/atom-audit.mjs 逐原子审计、cache-waste-audit.mjs 缓存归因审计（双峰口径内建）。

### Fixed

- **no-op replace**：模型对源码类 tool-result 全文照抄（收益 ≤5%）时 fidelityGuard 平凡通过 → 零收益 replace；新增 no-op 守卫视同 false 拒绝（spike 37 两次跑批 6 例实锤，计数 `skippedNoopGain` 可观测）。
- **溢出三步第②步默认失效（review 坐实，严重）**：`maxOverflowRetries` 缺省 1 时事件#2 在重试上限守卫直接保留原错误，per-atom 降熵在默认配置下永不触发（测试显式传值掩盖、生产挂载无人设值）。修复：挂载 compressor 且未显式配置时缺省提到 3；耗尽判定独立存在不空转。
- **溢出第②步轮归属错配（review 坐实，中等）**：原接线压"最新闭合轮"，但溢出发生在当前 open turn——与设计 §8「对当前轮大原子降熵」不符。修复：新增 `collectOpenTurn`/`compressOpenTurn`（过滤同款），两处接线改压 open turn，doneTurns 防闭合后重压。
- **边合并双计**：模型残留 cites 尾与 declarer 声明同 (from,to) 时 inDegree 双计——injectEdges 合并按边去重（先到优先）。
- **锚定口径加固**：usage 锚点和补 `cacheWriteTokens`（与 UI ContextMeter 分子同口径）；声明窗口缓存（request/context 权威口径，物理探测 7.7× 口径差根除）。
- 早期 0.3.x 系列发布级修复（压缩静默失效、跨轮缓存全断）见 [0.3.2]/[0.3.1]。

### Changed

- per-atom prompt 定义式迭代：资料定义改开放集（"一切非指令内容"）、quotes 规则强化（粘贴物正文的建议性表述算资料）、tools false 档（"不压"为显式信号）、info 压缩落地（设计 §10 决策 1）。
- shadowed 账本只认 compaction/prune——per-atom 压缩 replace 不再谎报为剪枝（catalog "Compression removed N" 不再误增）。
- 14 处裸 console 直调收敛至 ctx.logger 门面；产物命名规范（INVALID-* 隔离污染 run）。
- 定位换轨（方案 A，2026-08-28 拍板）："确定性剪枝工具" → "带守卫的上下文虚拟化"；ARGP 降级为产品词，README/package description 已按「the LLM proposes, deterministic guards dispose」落地。

### Verified

- P5 四臂对照 **GO**（2026-08-26，spike 37/37b）：A 臂 30/30 零 error、探针 7/7、成本 A≤C 全分量；D 臂（摘要基线）最便宜但探针 5/7——保真优先于成本校准定调。
- 60 轮放开对比：末轮水位 A=E 的 40%（模型可见口径）；E vs A 30 轮末轮降幅 59.8%。
- 本地复核三件（2026-08-29）：溢出存活 **8.57×**；稳态缓存零税（healthy 86-87% ≡ E）；保真判据未受压。判据与产物路径见本节及上方产物目录。
- 真宿主联调（2026-08-28/29，rc.2 部署 + ModelScope）：验收三项闭环（双引擎挂载、窗口口径、cites 剥离）、checkpoint 节点实测、回复协议退役实测（新轮次零 cites 尾 + declarer 建边开火）。联调细节见内部台账（已迁出公开仓库）。
- 质量门禁：`npm run check` **195/195 全绿**（2026-08-29）。

## [0.3.2] - 2026-08-22

### Fixed
- **压缩静默失效（发布级 bug：任何超线场景 boundaries 恒为 0）**：atomize 重建引用图时，`argpCites` 的形状判据检查的是 V6 graded 字段 `c.t`，但 `stripTrailingCitesIfNeeded` 实际写回的是 `ParsedCite`（`{text, level}`）→ `every()` 恒 false → 误落进 string[] 分支、把对象塞进 `text` → `buildGraph` 的 `cite.text.trim()` 抛 `TypeError` → pressure prune 被静默 catch 吞掉 → 估算超触发线也从不压缩（本地 100K/80K/16K 与 v4-flash 同复现；`compaction/start` 从未发出、`boundaries=0`、cites `resolved=0`）。修复：① atomize 对 argpCites 归一化，兼容 `ParsedCite[]` / `string[]`（V5 旧产物）/ graded `{t,l}`（契约原文）三种形状；② buildGraph 对非字符串 `cite.text` 防御性跳过（cites 来自不可信模型输入），压缩主体绝不再抛错。

### Tests
- 既有 72 用例全过（typecheck + `npm test`）。
- 真实长程验证（spike/26，v4-flash 50 轮，100K/80K/16K）：**VERDICT PASS**——25 次压缩事务（start/summary/end 全配对、0 error，修复前为 0）、cites `declared=182 / resolved=182`（修复前 resolved=0）、U 探针 8/10、R 探针 8/10、8/8 文件、stderr 零抛错。产物 `spike/out/26-v4-fix50-*`。

## [0.3.1] - 2026-08-22

### Fixed
- **跨轮 prompt cache 全断（发布级 bug，前缀稳定性核心论点受损）**：`shadowedSeqsOf` 原来把**任何** `surfaceOp !== 'append'` 事件都计入 shadowedSet，而 cites 剥离写回（`stripTrailingCitesIfNeeded`：模型回复落盘后以单点 `surfaceOp:{op:'replace',start:seq,end:seq}` + `data.argpCites` 原地改写）被误判为"被剪节点" → catalog 谎报 `Compression removed N items`（压缩事务数为 0 时也逐轮增长）→ system message 前缀每轮变化 → 跨轮 KV/prefix cache 从变化点起全部失效（本地实测：每轮首请求 miss = 全上下文 28K→42K、`progress` 从 0.15 重新 prefill）。修复：只认 `op==='replace'` 且**无 `argpCites` 字段**的 replace 为剪枝（真压缩 tombstone 是 user/message 无此字段；单点/区间真剪枝都保留，防单点压缩漏剪）。
- **动态 catalog 位置（连带修复，前缀稳定性的一部分）**：`argp-catalog` 从 `argp-contract`（order 150，system 靠前）拆出、独立注册于 order 9999（system 末尾）——压缩后仅 catalog 尾巴 miss，persona+契约正文+cites 静态前缀保持可缓存。recall 协议不依赖 catalog 在 system 靠前。

### Tests
- 既有 72 用例全过（typecheck + `npm test`）。
- 诊断工具（spike/ 下，不入库）：`llm-log-proxy.mjs`（请求捕获代理，diff 每轮真实 system 前缀）、`.tmp/extract-usage.mjs`（events.jsonl 逐轮 usage 提取）、`large-prefix-cache-probe.mjs`（大前缀缓存探针）。

## [0.3.0] - 2026-08-20

### Added
- **assessment-v2 A 轨实现（12 项 A1–A12，评估文档已迁出公开仓库）**：基于逻辑链（引用依赖拓扑）的上下文压缩引擎重大功能升级。
  - **A1 V6 分级 cites**：`parseCitesBlock` 返回 `{text, level}`，严格等级匹配（`c`/`critical`、`x`/`contextual`、裸字符串/非法值回退 `supporting`，禁止子串误判）；critical 边激活闭包守卫不变量 2′（仅 external critical 边计入 `inDegreeByClosure`）。
  - **A2 前缀守卫**：默认 `citeMinPrefixLen=4`，统一 `ascii + wide*2` 折算（`"the"` 拒 / `"读书"` 放行）；歧义消解取最长公共前缀最深原子。
  - **A3 R 版本键修复（N1）**：issuer A 工具名 + 参数 JSON（原 issuer 文本），修复同措辞不同参数误归链。
  - **A4 版本链去重**：`mergeOlderR` 按合并后组成员数计 `chainLen`（无重复累加）；可选 θ 行重叠链式（默认关）。
  - **A5 n-gram 倒排索引**：候选收窄 + 验证谓词分离；前缀过短回退全扫描。
  - **A7 resume 账目重建**：`bindSession()` 统一 `setSession`/`agent/pre-step`/`compactIfNeeded`/`compactNow` 绑定，records + prunedNodeIndex 从追加日志懒重建（幂等、`rebuiltCompactionIds` 去重；未闭合 start → 仅 audit 告警）。
  - **A8 ask 检测**：导出纯函数 `looksAskText()`，CJK 句首锚定（`^(请|帮我|能不能|能否)`），句尾"帮我"不再误命中。
  - **A9 catalog 扩 R**：字符预算驱动（`charBudget = tokenBudget * charsPerToken`）。
  - **A10（必补项，收窄版）**：带 R 组的工具 A 仅当组内 R 无任何组外入边（语义 `curInDegree` + 组外确定性边）才保护；被外部 cites 后 R 解锁 → A 可剪。force 路径同判据。
  - **A11 参数化**：`closureWindowK`/`citeMinPrefixLen`/`overlapTheta`/`enableOverlapChain` 进 `ArgpGraphConfig`（带默认）。
  - **A12 spike/25 中合规合成臂**。
  - **A6 summarize 终端**：留作未实现（文档标注，默认关）。

### Tests
- 新增 10 用例：level 解析 / 前缀守卫 / A10 受保护·可剪双控 / chainLen / critical 闭包守卫 / ask 收窄（纯函数 + 集成）；crash-recovery 扩至真实 resume 流程。`npm run check` 72/72 通过。

## [0.2.9] - 2026-08-20

### Fixed
- **引擎不挂载（发布级 bug，v0.2.6–v0.2.8）**：`cordis.patch.yml` 的 `- id: dsh-argp` 普通条目（modify）**不创建 entry**——bundle include 只应用包的 patch、不为包本身建 entry（entry 只能由 patch 的 `insert` 创建，实测 vendor/loader + apps/cli profile-boot）。v0.2.6 修 duplicate 时把 `insert` 改成 modify → **没有任何代码创建 dsh-argp entry → 引擎从不挂载**（`ctx.compaction` 仍是 stock；cites 契约 PromptSection 不进系统提示，Qwen3.8-27B 真会话 cites 服从率 0/18 实锤）。修复：包 patch 恢复 `insert`（创建 entry）；profile 层只做 modify 覆盖（勿重复 insert，否则 duplicate）。README 双语安装段同步更正。
- **客户端加载失败（发布级 bug，v0.2.8）**：优雅降级写法 `ctx.assistantDisplay?.register` 仍触发 cordis proxy 检查（读未声明服务的属性即抛 `cannot get property "assistantDisplay" without inject`，可选链不豁免）。修复：改用 `ctx.get('assistantDisplay')`（服务缺失返回 undefined 不抛错）——无 seam 宿主静默跳过，有 seam 宿主注册过滤器。

## [0.2.8] - 2026-08-20

### Fixed
- **客户端加载失败（发布级 hotfix）**：`dsh.client.inject` 误把包名 `@deepseek-ai/dsh-client-ui-conversation` 当服务名声明 → web shell 去加载 npm latest（0.0.1-rc.1 旧包，无 `assistantDisplay` seam）→ apply 报 `cannot get property "assistantDisplay" without inject`。修复：`inject` 置空（对齐官方 client 包惯例，如 connection）；服务依赖由 `src/client/index.ts` 的 static `inject: ['assistantDisplay']` 声明，seam 由宿主 rc.7 的 ui-conversation 提供。

## [0.2.7] - 2026-08-20

### Added
- **客户端显示过滤（建议书候选 B-7 落地：cites 块 UI 隐藏）**：dsh-argp 新增客户端半边——`package.json` 声明 `dsh.client` + `exports["./client"]`，`scripts/build-client.mjs`（esbuild）产出 `window.__ModuleLoader__.load` 格式的 `lib/client.js` bundle（与 tsdown client preset 同构，零外部依赖）。客户端在原生 ui-conversation 新增的通用 **`assistantDisplay` 显示过滤 seam** 上注册"剥离尾部 cites JSON"过滤器：assistant 回复末尾的 `{"cites":[...]}` 块（裸 JSON 或 ```json 围栏、空或非空）在 Web UI 渲染层被隐藏——仅显示层，不触日志/surface/模型文本；非空 cites 仍正常进入引用图。共享纯模块 `src/cites-strip.ts`（`matchCitesTail`/`parseCitesBlock`/`stripCitesTail`），服务端 `extractCites` 与客户端过滤器复用同一匹配逻辑，零漂移。seam 原生侧为纯增量改动（默认空过滤器 = 行为不变），已同步至本地 dsh 检出；构建校验：monorepo client pass 全绿、8/8 测试过、bundle 加载契约 mock 验证过
- **`/compact` 手动压缩链路补全**：`compactNow` 补 `sourceCommandId` 参数（对齐基类三参签名与 compaction-basic），透传至事务事件（`compaction/start` data）与 `GraphPruneRecord` 台账，供 UI presentation correlation（`/compact` 触发的事务可溯源到命令）。`peerDependencies` 补 `@deepseek-ai/dsh-commands`（`CommandId` 品牌类型，官方同款）。回归测试 `test/manual-compact.test.ts` 4 用例（可剪会话选块 / 全 U 返回 null / sourceCommandId 透传且自动压缩不污染 / 手动 span 含 U-X 拒绝）

## [0.2.6] - 2026-08-20

### Fixed
- **bundle patch 重复挂载修复（发布级 hotfix）**：`cordis.patch.yml` 原用 `insert` 挂载 `id=dsh-argp`——但 `dsh plugin add` 后 dsh 已把包 include 进 profile 层（entry id = 包名），再 insert 同名 entry 导致 loader 报 `duplicate loader entry id: dsh-argp` 启动失败（v0.2.5 起 reconcile 自动把 dsh-argp 加入 bundles 后必现）。修复：patch 改普通配置覆盖条目（modify 不 insert）；README 安装段同步修正（双语）。

## [0.2.5] - 2026-08-19

### Added
- **context-overflow 溢出恢复**：模型请求返回 400 `exceed_context_size_error` 时自动强制剪枝并重发请求——`agent/request-error` 钩子按稳定错误码 `CONTEXT_WINDOW_EXCEEDED` 识别（不写死 token 数），`compactIfNeeded(agent, 'context-overflow')` 跳过 pressure 门槛强制压缩（估算可能低估实际请求），surface 换代后返回 `{kind:'retry'}` 让 agent loop 从替换后的 surface 重发同一任务请求。恢复路径 **0 次新增 LLM 调用**（纯算法剪枝，对比原生 summarize 恢复的 1 次摘要请求，无新增失败面）。`maxOverflowRetries` 默认 1（对齐 compaction-basic），成功应答 / agent idle 时重置计数。回归测试 `test/context-overflow.test.ts`

### Changed
- cites 契约 V5：空引用时**完全不输出 block**（V4 的 `{"cites":[]}` 废止）；记录 UI 转录 append-origin 根因（Web UI 人类转录取 append 起源事件、surface replace 副本 model-only，服务端 strip 改不到 UI 显示——UI 层过滤需客户端 seam，见建议书候选 B-7）

## [0.2.4] - 2026-08-19

P1–P7 审计修复全量落地 + 依赖升级 rc.7 + npm 首发。

### Added
- **全日志 recall（P1 修复路线 b）**：`recall_pruned` 三引擎去门控——对任意界内 seq 返回原文（含 live / off-surface 节点），返回值带 `[recall seq=N state=shadowed|live|off-surface]` 状态标签，只有越界才报错；共享模块 `src/log-access.ts`
- `list_pruned` 区间模式（`fromSeq`/`toSeq`）：扫描全日志带 state 标签，作为"可见窗口补集查询"发现原语
- 程序化全日志入口 `recallAnyState()` / `nodeState()`（基类 `recall()` 保留 pruned-only 语义，spike 探针依赖）
- B-6 立案（API 反馈建议书）：surface 渲染窗口丢弃无痕迹、窗口边界对压缩引擎不可见（H1 框架，需适配器级取证）

### Fixed
- **P2**：recall 防抖 key 从 per-pass 重发的 `closureId` 改为跨 pass 稳定的 `rootSeq`（原实现写入/读取永不相等，防抖分支死代码）；回归测试 `test/closure-debounce.test.ts`
- **P3/P6**：closure tombstone 嵌入 `seqs=first..last` + `K of N`（tombstone-within-tombstone 两跳后 seq 不丢失）
- **P4**：latestTurn 统一为 surface 节点口径，`turnBasis=semantic`（默认）排除注入型 reminder 推进轮次
- **P5**：`compactRegion` 守卫文案 scoped 到手动入口（自动闭包生命周期确实会剪 U root / X checkpoint）
- **P7**：recall 字数预算每笔 compaction 事务后重置；预算耗尽时显式说明（不再静默返回纯 `…(truncated)`）
- 表面剥离尾随 `{"cites":[...]}` JSON（assistant-message 提交时零窗口改写，`argpCites` 存根保留引用图跨压缩不丢）

### Changed
- 依赖升级：`@deepseek-ai/dsh-*` 0.1.0-rc.6 → **0.1.0-rc.7**（实测无 API breaking，check 49/49 通过）
- README 双语补充 npm registry 安装 / `update` 升级 / GitHub 备选源
- 发布：**npm 首发 `dsh-argp@0.2.4`**（账号开通后），与 GitHub Release v0.2.4 同版本对齐

## [0.2.3] - 2026-08-19

### Added
- `turnGuard` 配置：保护最近 N 个完整 turn 的原子不参剪（真会话一个 turn 常含多个 surface 节点，recencyGuard 按节点位置保护易截断当前轮）

### Fixed
- 真会话压缩预算解析：`resolveScaledBudgets` 优先读 `session.requestContext()` 的 `contextWindow`（原路径 `llm.resolveModelInfo` 在真会话失败 → 错误 fallback 到 16384 触发线，导致 25% 占用就触发压缩）；`measureTokens` 优先接 `ctx.tokenMeter`

## [0.2.2] - 2026-08-19

### Fixed
- 真会话连续压缩循环：`minSpanChars` 默认 512→**0**（区间放回导致可见量压不到 retain 目标，每个 pre-step 重复触发）；`maxPasses` 16→**256**（大上下文一次调用压到位）

## [0.2.1] - 2026-08-18

### Added
- tag 驱动 GitHub Release workflow（`release.yml`，npm publish deferred）
- pre-push 钩子 + 提交信息规范检查（conventional commits）
- CHANGELOG / CONTRIBUTING 建档

### Changed
- bundle patch 移至仓库根 `cordis.patch.yml`（市场扫描按根路径检查），删除过期 `cordis/` 目录，修复 `files` 字段
- cites 契约升级（V4 措辞）：10-turn 重跑实测 declared 0 → **43.6%**、resolved 100%

## [0.2.0] - 2026-08-18

首个 tagged 版本（GitHub Release: `v0.2.0`）。主要内容：

### Added
- 产物型发布包：`lib/` 构建产物、`cordis/argp.cordis.patch.yml` 挂载补丁、`dsh` plugin 市场契约（STANDARD.md §2 合规）
- ratio-driven 压缩预算（window=ctx×0.8，retain=window×0.2），含 adapter-contextWindow 解析与降级回退
- 错误重试机制与反事实成本分析（13 失败 turn 归因）
- 提交规范与质量门禁：CI workflow（typecheck/smoke/test/build + lib 一致性检查）、pre-push 钩子、CONTRIBUTING.md

### Changed
- 包名 `argp-dsh` → `dsh-argp`（与公开仓库对齐）
- README 中文为主（README.md）+ 英文版（README.en.md），补充 P4 挂载验证、160K 验证、B-5 平台缺口
- repository 字段补全（市场识别契约）

### Fixed
- B-5 空流缺口证据固化（77% error、maxTokens 无关），进入正式 API 反馈建议书

### Verified
- 160K 场景定稿对比：ARGP A 档 U 7/7 R 7/7、0 error、压缩率精确兑现（200K→160K 触发→32K 保留）
- 声明式生产挂载（`dsh plugin` CLI + profile patch）在 dsh 0.1.0-rc.6 上验证通过
