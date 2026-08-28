# ARGP 评估 v2：代码复核修订 + 调整建议（双轨制）

> **归档注记（2026-08-28）**：本文档原存于工作区根目录、从未入库，而 CHANGELOG v0.3.0 与工作区 AGENTS.md 均引用 `docs/assessment-v2.md`——现移入 `docs/` 使引用落地。内容为原文照搬（最后修订 2026-08-21 v2.1），未按后续演进更新；A 轨落地状态见 §6 执行状态注记。
>
> 基础：对 `dsh-argp` 当前源码（`src/argp-graph-engine.ts` 1549 行全读、`cites-strip.ts`、`recall-engine.ts`）、`ARGP-design-v1.0.md`、`design-vs-impl-trace.md`、README、`dsh-api-feedback-2026-08-17.md`，以及 `@deepseek-ai/dsh-compaction|dsh-session`（rc.6，node_modules 实读）的逐条对照。
>
> 本版本做三件事：
> 1. **更正 v1 评估的 10 处事实性错误**（§1）；
> 2. **补入 v1 未覆盖的 6 项新发现**（§3，其中 1 项是注释与实现不一致导致的潜在错误去重）；
> 3. **把全部调整建议重组为双轨**：A 轨 = 无外部风险（纯 dsh-argp 内改动，零 dsh API 依赖）；B 轨 = 有外部风险（需 dsh 平台变更，均已立案且有插件侧绕行）（§4-§5）。

---

## 0. v2.1 审阅修订注记（2026-08-20）

对 v2 的三处修订（依据源码复核，行号均指 `argp-graph-engine.ts`）：

1. **更正 #2 的撤回理由修订**：v2 原文以"与不变量 1 相悖"否定 sum 加权入度，该论据不成立——不变量 1 约束的是建图阶段 eff 值的聚合（`max(自评, 入边权重)`），v1 建议动的是排序键的入度计数，两个是不同量。sum 该撤回的真实理由见 §1 更正 #2 修订版。
2. **更正 #6 补一个机制缺口**：A 携带 R 组（toolCallIds 非空）但漏 cites 时，buildGraph 中该 A 没有指向 R 的语义边，而 `touchesSemantic` 只判实际存在的边——该 A 及其 R 组在闭包守卫（`inDegreeByClosure`，L1006-1020）中失去保护，整闭包可被剪。这使 A10 从"可选优化"升级为**必补项**（它已列于 Phase 1，勿降级）；A10 行中"可选"一词仅指保护范围的收窄选项。
3. **A12 补一臂**：现有两臂（DeepSeek 零建边 / Qwen 高服从）未覆盖"部分服从"中间档，而 A1 分级激活后中间档最易暴露问题。建议增加"人工注入 ~50% cites 服从率的合成会话"臂，先于 GLM 执行。

---

## 1. v1 评估更正清单

| # | v1 断言 | 判定 | 证据与说明 |
|---|---|---|---|
| 1 | "贪心按入度排序：入度 1 的 critical 边原子比入度 2 的 contextual 边原子先被摘" | ❌ 不成立 | 排序键是 `[level, eff, lastRef, seq]`（argp-graph-engine.ts L1272-1276），**level 是第一键**且 critical 档 `LEVEL_ORDER=3` 排序垫底（最后剪）。入度只以二元形式进入 level（有语义边→supporting，无→isolated，L1273），eff 用 max(入边权重)（L1183），从不按入度计数排序。v1 反例不成立 |
| 2 | "建议改加权入度 sum(edge_weights)" | ❌ 建议撤回（理由修订，见 §0-1） | 原理由不成立：不变量 1（`max(自评, 入边权重)`，设计稿 L84-86）约束的是建图阶段 eff 值的聚合，v1 建议动的是排序键的入度计数，两个量不构成冲突。真实撤回理由：① sum 系统性抬高被引用多但引用皆弱的原子（max 的"一条 critical 边兜底"语义被稀释）；② 与剪枝链式解锁的动态入度（curInDegree 逐边递减，L1286-1290）按同一入度计数，sum 排序与其产生自相矛盾的双重加权 |
| 3 | "建图每轮 pre-step 都跑，500 轮会话建图从零成本变每轮几百毫秒" | ❌ 前提错误 | `compactIfNeeded` 先压力检查早退（L1164-1169：`contextTokens < threshold` 直接 return），**只有达阈值才 atomize+buildGraph**。每 pre-step 的固定成本是一次 `visibleChars` + `measureTokens`（O(可见字符)），不是建图。真实瓶颈是每次压缩时的 O(A·C·N·L) 峰值——方向不变，量级论证前提错 |
| 4 | "recall_pruned 只认被 ARGP 替换过的 pruned 节点"（B-6 首句） | 🟡 过时 | P1 修复 (b) 已去门控（L340-344 注释+实现）：任意界内 seq 返回原文 + `state=shadowed|live|off-surface` 标签；`list_pruned` 区间模式扫全日志（L384-414）。**残留问题**只剩"模型怎么知道被窗口丢掉的 seq"，与 B-6 立案文本（dsh-api-feedback L88）自身表述一致 |
| 5 | "cites 声明率从 V3 的 0% 到 V4 的 43.6%" | ❌ 数字错位 | README 无 V3/V4 对应这两个数。0% = DeepSeek v4-flash **50 轮 t-long**（"nothing else" 冲突指令，L41/L43）；43.6% = 任务 prompt 留出口后的 **10 轮**实测（L45）。口径不同，不是版本演进序列。代码里的 V4/V5 指 cites 契约措辞版本（L492-497） |
| 6 | "某轮不输出 cites → 该轮 A 原子没有入边 → 变成孤立节点优先被剪" | 🟡 因果方向写反 | 漏 cites 丢的是该 A 的**出边**，失去保护的是它本应引用的**目标**，不是它自己；且只要它有任何语义边（含出边）就在 supporting 档而非 isolated 档（L1273 `touchesSemantic` 含 from 与 to）。系统性风险（服从率整体崩→图退化）真实存在，缓解是 README L49"零建边保证"（DeepSeek 50 轮 declared=0 仍 L1/L2/L3 全 PASS）。**v2.1 补缺口（§0-2）**：A 携带 R 组（toolCallIds 非空）但漏 cites 时，该 A 对 R 无语义边，闭包守卫（`inDegreeByClosure`，L1006-1020）防不住整闭包被剪——A10 因此是必补项 |
| 7 | "配对漏建边……留下孤儿 tool-call 触发 toolPairingBalanced 校验失败" | 🟡 机制指错 | `toolPairingBalancedBefore/After` **只在手动 `/compact` 路径**调用（L1401-1402）；自动 pressure/closure 路径走 `pruneIntervals`（L1446-1535）**不做任何边界配对校验**，孤儿防护全靠 A+R 成组同剪（L1215-1239）。自动路径的孤儿风险是**静默的**（无校验、无告警），不是"校验失败" |
| 8 | "模型中途切换……没有看到重算/重剪逻辑" | ❌ 不成立 | `resolveScaledBudgets` **每次** compactIfNeeded 都重新解析（L1157→L1095-1137），优先读 `session.requestContext()`（dsh-session L1508-1514：最新 `request/context` 事件的增量折叠，换模型即更新）；压力检查每 pre-step 跑，retain 目标变小会自然触发再剪；图无持久状态、每次从 surface 重建，不存在"上一轮图状态丢失"。台账 §6-3（2026-08-18）明确"换模型自动适配"。唯一字面成立的是"已剪原子不能恢复"——平凡真且可 recall |
| 9 | "安全边界：无" | ❌ 不成立 | recall 已有三层限流：每轮 ≤3 次（L338/467）+ 单次 ≤5% 窗口 + 累计 ≤10% 窗口（L938-939），耗尽返回显式说明（P7，L941-945）。缺的只有 cite 前缀最小长度校验（该项 v1 说对了） |
| 10 | "多模型验证：DeepSeek 为主，Qwen smoke test" | 🟡 不准 | Qwen3.8-27B 已有**完整 50 轮 t-long**（declared=547、37 笔事务、L1/L2/L3 全 PASS，README L41），不是 smoke test。真正缺的是第三个模型（GLM 等） |

次要偏差（不影响结论）：建边行号 L777-793 实为 L776-792；"U→A 的 1:1 映射"措辞不准，实际是 U seq 窗口分区（L976-993）。

---

## 2. 确认保留的缺陷（v2 清单，按严重度）

### 理论层

**T1 子串共现图是质量上限（确认，核心）**
`buildGraph` L776-792：includes 匹配 + 一律 supporting（全 src 唯一出边点 L789，`'critical'/'contextual'` 仅存于 L44 类型定义）+ 歧义消解 U 优先→最早 seq（L784-788）。设计 §5.2 的 refs JSON 分级（`{"refs":[{"to":"U12","level":"critical"}]}`）未落地，四级剪枝链退化为 isolated/supporting 两档，`EDGE_WEIGHTS`（L47）空转。
已登记的有意简化（台账 §2-2），非隐藏缺陷。缓解现状：`citesFailed` 保守保护（解析失败的 A 永不参剪，L1256）、零建边保证（README L49）。

**T2 标注错误不可逆（部分确认，v1 高估了"不可发现"）**
剪错原子的原文留在全日志，且发现通道比 v1 描述的宽：tombstone 自带 seq 区间（L1073-1077）、`list_pruned` 全量+turn/type/keyword/区间四过滤（L358-451）、`recall(query)` 关键词检索（L628-659）、catalog 注入系统提示（L594-626）。
**真实残留**（v1 没说中）：catalog 只列**最旧** ≤20 条且**不含 R 类型**（L594-626：`else continue // catalog 只列 U/A`）——R 通常是最大文本块，恰是没有 catalog 发现入口的一类（见 N2）。

**T3 分级两档化（v1 的加权入度问题修订版）**
问题不在"排序用入度计数"（v1 错误），而在：level 只有两档 → 排序区分度丢失；eff 的 10/5/2 档位差（来自边权重 max）从不生效。修复路径 = T1 的分级激活（A1），**不需要** v1 建议的 sum 加权。

**T4 U 锚点闭包分区（确认，但有 v1 漏掉的三重保护）**
按 U seq 窗口切分、整闭包剪（L976-1028）。v1 漏掉的保护：跨闭包语义边使 `inDegreeByClosure > 0` 即不剪（L1006-1020）、K=2 静止窗（L1010、L1019）、recall 回拉防抖（L1016-1017，P2 修复）。
真实残留：①"一条 U 多个并行子任务"→ 分区过粗（剪少，安全方向）；②保护链全部依赖 cites 能解析——服从率崩时退化为纯位置/静止窗保护（与 README 零建边保证一致）；③"剪多"方向被跨闭包入度守卫拦住，前提是守卫计的是**所有**语义边（L1006-1007 不分 level）——分级激活后需按设计不变量 2′ 改为只计 external critical 边（见 A1）。

**T5 版本链全等去重（确认，且比 v1 说的多一个 bug）**
A 按 `text.trim()` 全等（L847）属实；θ=0.8 未实现（文件头 L5 自认）。但 v1 漏了：R 的分组键是 **issuer A 的文本**（L862-863），不是 R 自身文本也不是 toolCall 签名——见 N1，这是注释与实现不一致导致的潜在错误去重。

### 鲁棒性层

**R1 工具配对孤儿风险（确认，机制修订）**：自动路径无边界校验（见更正 #7），孤儿风险静默存在；A+R 成组（L1215-1239）覆盖同 turn 配对，跨 turn/异步回调配对漏组即静默孤儿。
**R2 中文误匹配（确认）**：无最小前缀长度（L779-780 只 trim+判空）；歧义消解在中文长对话中可建到无关节点。`citeStats.ambiguous` 有计数（L785）但只入账不出策。
**R3 建图性能（修订）**：见更正 #3。500 轮场景的真实峰值 = 每次压缩时 O(A·C·N·L)；倒排索引仍值得做（A5），但优先级低于 v1 的"每轮几百毫秒"叙事。
**R4 事务中断（确认，补两个事实）**：无 WAL/回滚（L1462-1496，catch 只补记 end+error L1526-1533）。但 ① dsh 已有 `session/end-seed` 孤儿容忍：resume 时未闭合 start 被 `inheritedOrphanStartSeqs` 标记 stale 并放行（dsh-compaction invariant.js L56-66、L173-175），不会硬失败；② 崩溃后 surface 是自洽的部分已剪状态，图从 surface 重建不产生脏图。**真实丢失** = 内存账目（`records`/`closurePrunes`/`prunedNodeIndex`），可从日志重建（见 A7，不需要 WAL）。
**R5 模型切换**：撤回（见更正 #8）。
**R6 窗口盲区（修订）**：P1(b) 已去门控；残留 = 发现性问题，唯一解在 dsh 侧（B 轨 B-6）。
**R7 recall 预算（确认）**：5%/10%/每轮 3 次三层；P7 修复后耗尽返回显式说明（有意设计，非静默）；"说明文字污染上下文"是取舍批评，可接受。
**R8 cites 服从率波动（修订）**：见更正 #6；补充一个 v1 没提的联动：某轮漏 cites 时，若该 A 携带 R 组（toolCallIds 非空），它必然用过工具结果却没声明——应按 `citesFailed` 同级的保守保护处理（见 A10）。

---

## 3. 新发现（v1 未覆盖）

**N1 R 去重键注释与实现不一致（潜在错误去重，建议 P0）**
L822-823 注释声称 R 按"配对 A 的 toolCall 签名"分组，实现（L862-863）实际用 **issuer A 的 `text.trim()`**。后果：两轮 A 措辞相同（如都是"让我读一下文件"）但工具参数不同（`read_file(a.ts)` vs `read_file(b.ts)`）时，两个内容完全不同的 R 被归入同一"版本链"，旧 R（a.ts 的内容）在 in_degree==0 时被剔——错误去重，真实信息从 surface 消失。修复成本低（键改为 tool name+arguments JSON，callId 缺失时回退 r.text），见 A3。

**N2 catalog 不含 R 且只列最旧 20 条**（L594-626）
R 原子（工具结果，通常最大）没有任何 catalog 发现入口；"剪错不可逆"的实际缓解弱于直觉。与 list_pruned 的 R 支持（L428-430）不对称。见 A9。

**N3 闭包静止窗 K=2 硬编码**（L1010 `const k = 2`）
不可配置；不同任务密度下 2 轮静止窗的松紧差异大，实验调参需改代码。

**N4 `recallResultSeq = this.session.events.length` 假设**（L352）
假设 recall 的 tool/result 事件恰好是当前事件总数（即 execute 返回后 harness 追加的下一个事件）。若 harness 在中间插入其他事件，价值继承（L1188-1195）静默失效。低风险但属隐性契约。

**N5 版本预剪用静态 inDegree**（L1265）
`findVersionDuplicates(atoms, inDegree)` 收到的是 buildGraph 初始入度，而非 pass 循环的动态 `curInDegree`（L1286-1290）。若某旧副本在预剪后被剪链解锁，预剪决策没看到最新入度。影响小（预剪方向保守：入度>0 不剔），记录在案。

**N6 ask 豁免检测只认英文**（L1206）
`text.endsWith('?') || /\bask\b/i || /\bwhat\b/i`——中文问句（"帮我查一下…"、"这是什么？"）不命中 `looksAsk`。后果方向保守（U 更不被原子级参剪，只走闭包生命周期），中文会话压缩偏少而非偏多，但 U 锚点保护语义在中英文会话间不对称。见 A8。

---

## 4. A 轨：无外部风险（纯 dsh-argp 内改动，零 dsh API 依赖）

| 编号 | 项 | 改动点 | 内容 | 验证 | 风险 |
|---|---|---|---|---|---|
| A1 | cites 分级激活 | cites-strip.ts（解析）、argp-graph-engine.ts L499-510（契约文本）、L776-792（建边）、L1006-1007（闭包 2′ 门控） | 契约升级 V6：`{"cites":[{"t":"前缀","l":"c\|s\|x"}]}`（或数组内混排 string/object，解析向后兼容：纯 string 视为 supporting）；buildGraph 用声明 level；**critical 激活后闭包守卫按不变量 2′ 只计 external critical 边** | 50 轮 t-long 双臂对照（分级开/关）：level 服从率、L1/L2/L3、剪枝形态、recall 频次 | 模型 level 声明服从率可能低 → 未标注回退 supporting（与现状等价，回归风险为零） |
| A2 | cite 前缀守卫 | L779-780 + L784-788 | 最小长度（ASCII ≥4 字符 / CJK ≥2 字符）；多命中歧义消解增强：优先"前缀出现在目标行首"与最长公共前缀匹配；ambiguous 率接入日志告警 | 单测（中文反例集）+ spike 50 轮 ambiguous 率对比 | 极低；误拒过短前缀会少建边（保守方向） |
| A3 | R 去重键修复（N1） | L862-863 | 键 = tool name + arguments JSON（callId 缺失回退 r.text）；与 L822 注释对齐 | 单测：同措辞不同参数的两个 R 不归链 | 低；只收紧错误归链 |
| A4 | θ=0.8 行级重叠归链（设计 §5.13） | findVersionDuplicates 扩展 | 行级 diff 重叠系数（`sim=|A∩B|/min(|A|,|B|)`），sim≥θ 归链，0 LLM；先只对 R 启用（A 文本短、全等已够） | 设计阶段 2 的 diff 去重专项步骤（设计稿 L367）+ 50 轮压缩率对比 | 中：阈值需专项验证（A18 风险，设计稿 L399 已登记） |
| A5 | 建图倒排索引 | buildGraph | prefix n-gram → atom id 倒排，cites 命中先精确后子串；仅压缩触发时构建 | 微基准（28 原子 / 500 轮合成 surface 建图耗时） | 低；复杂度下降但触发频率低（见更正 #3），收益是峰值保护 |
| A6 | summarize 末环决策 | L957-965 stub | **需产品决策**（技术风险低）：选项 (a) 保持默认 off + 文档明确 force_prune 为终端并保留审计记录（现状）；(b) 实现 stub 体，`degradationStrategy:'summarize'` 时 1 次 LLM 摘要兜底。配置开关已存在（L221-222），缺的只是实现体与默认值定夺 | 选 (b) 时：10 组全 critical 高密度对话四配置对照（设计稿阶段 3，L333-335） | 选 (b) 触碰"0-LLM 卖点"叙事，需同步修订对外文档（台账 §6-2 叙事准则） |
| A7 | 事务账目重建 + 未闭合审计（替代 v1 的 WAL） | setSession / 新增 resume 扫描 | resume 时扫日志：重建 `records`（compaction/start+prune+end 三元组，区间精确信息在 tombstone 事件 `sourceEventSeqs` 中，L1492）、重建 `prunedNodeIndex`（shadowedSeqs + 重算图）；发现无 end 的 start → warn 审计。**不引入 WAL**（dsh end-seed 孤儿容忍已覆盖硬失败风险，见 R4） | 崩溃注入测试：事务中途 kill 进程 → resume → 账目一致 + 图正常重建 | 低 |
| A8 | ask 检测 CJK（N6） | L1206 | 中文问句标记（？、吗、呢、什么、怎么、帮我）并入 looksAsk | 中文会话 spike：U 豁免行为对齐英文会话 | 极低 |
| A9 | catalog 扩 R（N2） | L594-626 | catalog 纳入 R 类型（或独立 R 段），条数上限改为字符预算驱动（已有 tokenBudget 参数）；或至少对 R 保留 seq 索引行 | 50 轮：模型"不知道被剪内容存在"场景（tombstone 无 seq 的 B-6 盲区外）recall 成功率 | 低；catalog 膨胀 → 预算已限幅 |
| A10 | 漏 cites 保守保护（R8） | isAtomCandidate | **必补项（§0-2，与更正 #6 联动）**：A 原子 `toolCallIds` 非空但 `cites` 为空 → 视同 `citesFailed` 保护（它必然读过工具结果；且漏 cites 使该 A 及其 R 组失去闭包守卫，见更正 #6）。保护范围可收窄：仅对"R 组在 surface 且 R 无其他入边"的 A 启用，避免过度保护 | 50 轮对照：保护开/关的误剪率 | 低；过度保护 = 压缩率略降（安全方向） |
| A11 | 参数化 | 配置 | K=2（N3）、前缀最小长度（A2）、θ（A4）入 `ArgpGraphConfig` | 既有测试回归 | 极低 |
| A12 | 实验扩展 | experiment/ | ① **部分服从中间档合成臂（§0-3，先做）**：人工注入 ~50% cites 服从率的合成会话——现有 DeepSeek 零建边 / Qwen 高服从两臂未覆盖中间档，A1 分级激活后中间档最易暴露问题；② GLM（或第二个非 DeepSeek 模型）50 轮 t-long——验证 cites 服从率跨模型；③ 滑动窗口基线（v1 说对的真缺口）；④ LongMemEval 子抽样（路线图 P5 已有，执行即可） | 各臂 L1/L2/L3 + 压缩率 + recall 频次 | 无代码风险；算力成本 |

**A 轨明确不做（撤回项）**：
- ~~v1 "加权入度 sum(edge_weights)"~~：反例不成立（更正 #1），且与不变量 1 相悖（更正 #2）。分级激活（A1）后 eff 的 max 语义自然生效。
- ~~v1 "WAL/事务回滚"~~：dsh 日志即事务日志（append-only + end-seed 孤儿容忍），崩溃状态自洽；插件侧只需 A7 的账目重建。

---

## 5. B 轨：有外部风险（需 dsh 平台变更）

三条已立案（`dsh-api-feedback-2026-08-17.md`，B-6 于 2026-08-19 追加），全部有插件侧绕行，**均不阻塞 ARGP 开发**，只决定能力上限：

| 立案 | 缺口 | 插件侧绕行（现状） | dsh 采纳后解锁 | 优先级 |
|---|---|---|---|---|
| B-6 | surface 窗口丢弃无痕迹，边界对引擎不可见 | P1(b) 全日志 recall（去门控+状态标签）+ list_pruned 区间模式——只解"知道 seq 能取"，不解"怎么知道被丢的 seq" | recall 契约（never guess）完整可执行；tombstone 无 seq 两跳丢失问题一并解决。**ARGP 当前最大暗箱** | 高 |
| B-1 | tool/result 替换无结构化元数据通道 | 旁路索引靠 seq 关联（已实证稳定） | tombstone 元数据（剪枝原因/图节点引用/可召回标记）出文本，占位回归人类可读；与 B-6 联动 | 中 |
| B-3 | compaction/prune 游离于事务状态机 | 借 compaction/prune 事件 + shadow-price 语义（L1474-1479 已用 prune 事件本身，非 summary 伪字段——注意 v1 转述的"借 summary 语义填伪字段"是 spike 4 时期的旧方案，当前代码已演进） | prune 独立成事务括号；按事件区分 LLM 摘要与算法剪枝有原生通道 | 中 |

另两条（同文档）与 ARGP 引擎核心无关但影响实验可靠性：**B-4**（testkit 缺 tokenMeter 致 Basic 引擎静默失效——对照臂实验必须显式挂 TokenMeter）、**B-5**（high 思考档摘要空流 77% error——影响 compaction-basic 对照臂数据质量）。

**看起来像外部风险、实际不是的（撤回项）**：
- ~~模型切换重算~~（更正 #8）：`session.requestContext()` 是现成 rc.6 API，引擎已消费，无需任何 dsh 变更。

跟进建议：B 轨三条按原建议书持续跟踪 rc 系列采纳状态；若长期不采纳，B-6 的残留风险应在 README"已知限制"中显式披露（目前只在 API 反馈书里），避免使用者在长会话+大窗口截断场景下误判 recall 契约。

> **rc.8 复验注记（2026-08-21）**：反馈书立案后 dsh 发布了 rc.8（08-19，反馈书基于 rc.7、B-6 于 08-19 追加——rc.8 发布当天，未及纳入）。逐包 npm diff 复验：`dsh-compaction` / `dsh-compaction-basic` / `dsh-session` / `dsh-invariants` / `dsh-token-meter` / `dsh-agent-loop` / `dsh-agent-loop-testkit` 在 rc.7→rc.8 **逐字节无变化**，B-1/B-3/B-4/B-6 均无对应 API 变化，**B 轨全部维持原状**。两点观察：① B-5 方向上 `dsh-llm` 默认重试 2→5，属容错增强而非定向修复——空流失败（返回空）重试仍为空，high 档 77% 失败面大概率仍在；② rc.8 新增 `session-reference`（跨会话引用，web UI 层类型）与 `assistant/message.interrupted`，平台向 recall/中断语义演进，与 ARGP 方向同向，但均不构成 B 轨解锁（B-6 要的是**会话内** surface 窗口丢弃痕迹，非跨会话引用）。另：rc.6→rc.7 之间引擎核心包同样全部无变化（B-1~B-6 在 rc.7 亦未落地），ARGP 固定 rc.7 为安全位置，升级 rc.8 零破坏、无直接收益，可自有节奏。

---

## 6. 建议执行顺序

> **执行状态注记（2026-08-21）**：Phase 1 四项（A2/A3/A8/A10）与 Phase 2/3 的实现项（A1 解析+建边+闭包 2′、A4 θ 链默认关、A5 倒排、A7 账目重建、A9 catalog 扩 R、A11 参数化）已随 **v0.3.0**（`411260f`，2026-08-20 发布 npm）落地，单测 72/72 绿。以下未完成项维持原口径：**A1 的 50 轮 t-long 双臂对照（分级开/关）未执行**（实现已进 v0.3.0，验证欠账）；**A6 保持默认 off + 文档标注**（v0.3.0 选 (a)，产品决策未动）；**A12 仅 ① 部分服从合成臂已落**（`spike/25-mid-compliance-synthetic.ts`），② GLM 50 轮、③ 滑动窗口基线未执行；**A10 的 50 轮保护开/关对照未执行**（实现为收窄版，单测覆盖双控）。B 轨状态另见 §5 注记（rc.8 复验未解锁）。

**Phase 1（即刻，小时级，纯防御性修复）— ✅ 已落地（v0.3.0）**
A2（前缀守卫）→ A3（R 去重键，N1 bug）→ A8（CJK ask）→ A10（漏 cites 保护，**必补项，勿降级/勿推迟**，见 §0-2）
全部是小改动 + 单测，不动任何对外行为语义。

**Phase 2（1-2 个迭代，核心卖点修复）— 实现 ✅（v0.3.0）；A1 双臂验证欠账**
A1（分级激活，含 50 轮双臂验证）→ A4（θ 重叠归链）→ A7（账目重建 + 崩溃注入测试）
A1 完成后，设计稿核心卖点（四级剪枝链、不变量 2、EDGE_WEIGHTS）从"空转"回归生效，`design-vs-impl-trace.md` 的 🟡 项转 ✅。

**Phase 3（按需）— 实现 ✅（v0.3.0，A6 维持默认 off）**
A5（倒排索引，500 轮场景出现实测压力时）→ A6（summarize 决策）→ A9（catalog 扩 R）→ A11（参数化）

**并行**
A12 实验（① 合成臂 ✅ `spike/25`；GLM 50 轮 + 滑动窗口基线优先未执行——前者回应"跨模型鲁棒性"，后者回应"只比最差的方案好"）；B 轨三条继续跟进；README 增补 B-6 残留风险披露 ✅（2026-08-21）。

**回归基线**：现有 27 测试全绿为每次改动的门槛（台账 §2-1 基线）；排序/分级类改动需同步更新"既往实验数据口径"标注（台账既有惯例）。

---

## 7. 风险台账更新（相对 v1 评估）

| 风险 | v1 状态 | v2 状态 |
|---|---|---|
| 子串共现图 | 确认 | 确认（T1，A1 修复路径） |
| 标注不可逆 | 确认（高估） | 部分缓解（发现通道已宽于 v1 描述；残留 = catalog 不含 R，N2） |
| 加权入度 | 确认（错误框架） | 撤回（T3 修订：问题是分级两档，不是排序键） |
| U 锚点分区 | 确认 | 确认（三重保护被 v1 漏掉；残留 = 分区过粗 + 依赖服从率） |
| 全等去重 | 确认 | 确认 + **新 bug**（N1 错误归链，A3） |
| 孤儿配对 | 确认（机制错） | 确认（自动路径静默无校验，R1） |
| 中文误匹配 | 确认 | 确认 + **CJK ask 检测缺失**（N6） |
| 建图性能 | 确认（频率错） | 修订（仅压缩时峰值，R3） |
| 事务中断 | 确认 | 确认（dsh 孤儿容忍 + A7 账目重建足够，无需 WAL） |
| 模型切换 | 确认 | **撤回**（自动适配） |
| 窗口盲区 | 确认（首句过时） | 修订（P1(b) 已去门控；残留唯一解在 B-6） |
| recall 预算 | 确认 | 确认（P7 后为显式设计） |
| cites 服从率 | 确认（因果错） | 修订（方向修正 + A10 保守保护） |
| 安全边界无 | 确认 | **撤回**（三层限流已存在；缺前缀最小长度，A2） |
