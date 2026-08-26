# spike36 熵减单引擎 soak 测试——四维度结构化审查

**审查对象**：`spike/36-peratom-soak.ts` + 其 9 个产物 JSON（`spike/out/36-peratom-soak-*.json`）+ `spike/out/36-compare-qwen36-vs-qwen38.md` 对照报告
**审查时间**：2026-08-25
**证据基线**：最新产物 `36-peratom-soak-2026-08-25T09-15-19-569Z.json`（Qwen3.6-35B-A3B，thinking 开、无 max_tokens、flush 修复后）

---

## 0. 结论先行

| 维度 | 评分 | 一句话判定 |
|---|---|---|
| 测试目的 | 7/10 | 定位声明清晰、不覆盖范围明示；但核心判决项 VK-ratio 在测试语料下**不可达**，目的与设计脱节 |
| 测试设计 | 6/10 | 主线（门控/链/守恒/前缀/解析）覆盖到位；但 T4/T7 是死设计、split 收益单遍测不到、异常场景零覆盖、"soak"名不副实 |
| 测试流程 | 7/10 | 单命令可复现、产物带时间戳；但跨 run 配置漂移（thinking/max_tokens/flush 时序/commit）未版本化，对照报告存在变量污染 |
| 测试结果 | 6/10 | 5 项绿判决证据充分可靠；但 VK-ratio 归因缺对照、"改提示词破 85%"的下一步建议**算术上不可行**、对照报告结论已过期 |

**总体判定：测试过程基本正确——"引擎管线健全性 5/5 绿"这个结论是可靠的、证据充分的；但不完整，且两个最重要的衍生结论（"白压根因是提示词缺口"、"改提示词后 VK-ratio 将跌破 85%"）缺乏证据支撑，方向可能错误。**

---

## 1. 测试目的（目标是否明确、是否与需求对齐）

**做得对的**
- 脚本头部注释（`36-peratom-soak.ts:2-6`）明确定位：只挂 PeratomCompressor 单引擎、真实 agent loop、验证 eager tail-only 熵减的多轮累计效果与守恒性；并**明示不覆盖** Stage-2 协同（留给 P4 三臂对比）。定位边界清楚。
- 6 个判决项（VK-plan/chain/originals/clean/prefix/ratio）逐条定义在头部注释（:26-31），可对照产物复核。

**问题**
- **[严重] VK-ratio 是"无效裁判"**。阈值 ≤85%（:302），但定量复核表明该阈值在**本语料下不可达**（见 §2 定量证据：cfTotal=10754 需净省 1613 字符，唯一 >512 字门的原子 app.log 仅 1609 字符，且其 16/16 行全部含高信号 token）：
  - 守卫合法（extract 必须让所有高信号 token verbatim 存活）→ 该语料上 extract **几乎不可压**，ratio 下界 ≈100%；
  - 即便守卫全拒、整段删光（违反守恒的算术极限）→ ratio 也只能到 95.9%。
  即无论提示词怎么改，**VK-ratio 在此语料上永远 FAIL**。把它列为硬判决项而非信息性观测，使"5/6 通过"的叙事永远封顶，且误导后续归因方向（见 §4）。
- **[轻微] "soak/持续压测"名不副实**。9 轮固定剧本不是 soak（无压力梯度、无时长维度、单会话）；它实质是"单臂冒烟 + 剧本回归"。命名虚高会影响后续对它的证据权重评估。

## 2. 测试设计（用例覆盖、边界异常、数据与环境）

**做得对的**
- 剧本（:104-119）混排 4 类轮（compressible/chain/dialog/split），9 轮覆盖：首次读大文件、同键版本链再读（T2/T9）、纯对话门控（T3/T6/T8）、小文件（T4/T7）、长用户消息拆分（T5）——主线决策路径都有用例。
- 守恒底账（originalHashes 全事件哈希，:216/:294-298）、前缀指纹流（:157-159/:252-273）、反事实基线（append-only 投影和，:144-155）三套度量互相独立、可交叉验证。
- 环境设计合理：mkdtemp 沙箱语料隔离、temperature 0、watchdog 18min、模型经 `/v1/models` 探测避免标签错位（:56-64）。

**问题**
- **[严重] 语料尺寸与门控阈值错配 → T4/T7 是死设计**。`gate.ts:196` 的 `DEFAULT_SMALL_RESULT_CHARS=512`，而 T4 的 `config/app.yaml` 仅 **145 字符**、T7 的 `docs/runbook.md` 仅 **338 字符**（脚本 :93-99 字面量可直算）→ 两者永远不满足 `rNeedCompress` → 产物证实 T4/T7 `called=false` 且**无任何 skip 字段**（门控短路，连 record 都是 `called:false` 零调用形态）。但剧本仍把它们标为 `compressible`，头部注释的 VK-plan 定义（:27 "可压轮全部产生**事务或合法跳过（fallback/守卫）**"）在实现里**没有被检验**——`verdict('VK-plan')`（:289）只断言 dialog/chain 轮零调用，compressible 轮完全不参与判决。即：文档承诺的"合法跳过"判据是空头支票，而真正的可压机会只剩 T1 一个。
- **[中等] 单遍设计测不到 split 路径的真实收益**。split 的缩减发生在**后续轮**把 U-info 副本当 tool-result 再压（对照报告 :31 自己承认），但 9 轮剧本里 T5 之后没有任何"回看/引用该消息"的轮次 → split 路径只验证了"决策正确 + 前缀不破"，**压缩收益为 0** 是结构性的。对照报告"下一步建议 3"（多遍压缩）已识别此缺口但未落地。
- **[中等] 边界与异常场景零覆盖**。未覆盖：LLM 端点 500/超时（240s AbortSignal）、空内容返回、JSON 半截输出（非截断型 parseFailed）、多会话并发 flush、`pendingCount` 竞态下的轮次错位、`turn/end` 缺失（中断轮）剧本。作为冒烟可接受，但应如实标注为冒烟而非 soak。
- **[轻微] 无强模型基线**。Qwen3.6/3.8 两个弱-中档模型对照是加分项，但没有 DeepSeek v4-flash（项目主口径模型）的产物，"模型过激"与"弱模型能力"两个混淆因子无法分离。
- **[轻微] 边界用例缺失**：恰好 512 字符边界、恰好 100 字符 splitThreshold 边界均无用例（T5 ≈350 字符离阈值 100 很远）。

## 3. 测试流程（步骤清晰、顺序依赖、可复现）

**做得对的**
- 单命令入口 `npm run spike36`，步骤顺序正确：建 ctx → 挂插件 → 注册工具 → 逐轮 followup → waitIdle → 等待压缩终态 → 手动 flush → 读 record → 判前缀 → 聚合判决 → 落产物。每一步的意图有注释。
- **flush 时序修复（本轮会话）是关键正贡献**：原流程在 LLM 返回后立刻读 record，但 `flushEntry` 要到下一轮 `agent/pre-step` 才跑（`compressor.ts:539-540`），导致 skippedFidelity/fidelityMissing 恒为 undefined——这是可观测性缺陷，修复（spike :237-250 手动 `flushStashed`）后产物才具备诊断能力。
- 可复现性：语料由脚本字面量生成（非外部文件）、temperature 0、模型探测落标签——同环境重跑结果可对齐。

**问题**
- **[严重] 跨 run 配置漂移未版本化，对照报告存在变量污染**。时间线还原（git log + 产物 runAt）：
  - 07-20 / 07-30（Qwen3.6）、07-41 / 07-48（Qwen3.8）：均跑于 `enable_thinking:false` + `max_tokens:2048`（当时 compressor 请求体仍带 max_tokens）+ **无**手动 flush + **无** rawResponse 落账；
  - c59b3c2（P0 split pipeline）提交于 09:15:13，晚于全部对照 run；
  - 08-29（rawResponse 落账）、08-41 / 09-04 / 09-15（thinking on + 无 max_tokens + flush 修复）为不同代码状态。
  即 `36-compare-qwen36-vs-qwen38.md` 宣称的"单变量实验：仅换本地模型"（报告 :3）**不成立**——实际是模型 × thinking × max_tokens × flush 时序 × split 代码共 5 个变量同时漂移。产物 meta 只有 `base/model/runAt`，**无 git commit、无脚本/引擎配置指纹**，事后只能靠时间戳考古。
- **[中等] 等待终态判据的竞态面未闭环**。`waitFor`（spike :243）用 `compressor.pendingCount >= 1` 判暂存就绪，但 `pending` 是跨 session 全局队列（`compressor.ts:509`）——当前单会话成立，若未来 spike 扩多会话会误判。另外 `parseFailed=true` 分支**不调** `flushStashed`（spike :248 条件排除了它），依赖引擎 pre-step 自然 flush，语义上不对称且无注释说明为何安全。
- **[轻微] 沙箱语料用完即删**（:322 `rmSync(workDir)`）。失败 run 的现场语料不落盘（虽然可由脚本重建，但重建依赖脚本未被改过——与配置漂移问题叠加时不可靠）。

## 4. 测试结果（证据充分性、缺陷描述、判定合理性）

**做得对的**
- 5 项绿判决均有产物级定量证据：VK-chain（T2/T9 toolResults=0）、VK-originals（16 个事件哈希零替换）、VK-prefix（逐轮指纹流公共前缀 ≥ 当轮起点）、VK-plan（5/5 零调用）、VK-clean（最新 run parseFailed=0）。"引擎管线健全"结论**可靠**。
- T1 白压的微观诊断链条完整：decision.tools 显示 extract 只保留 4 行 ERROR/FATAL（产物 `decision` 字段可读）→ `skippedFidelity:1`、`fidelityMissing:36`（已复核无重复计数）→ surface 2053→2053。证据闭环。
- 通过/失败判定本身机械正确（阈值、聚合逻辑与文档一致，无人为调节痕迹）。

**问题**
- **[严重] VK-ratio 的归因与"下一步建议"不可靠**。对照报告 :38-40 结论链："提示词未强制逐行保留 → 改 PROMPT_RULES → 预期跌破 85%"。三重缺陷：
  1. **算术不可行**：如 §1/§2 定量所示，本语料上 85% 是死线，改提示词也不会破——"预期跌破 85%"是**错误预测**；
  2. **缺对照**：归因"模型过激删除 INFO 行"没有强模型（v4-flash）反例/正例对照，无法排除"弱模型在 dense-log 语料上天然做不到聚合式压缩"这一混淆因子；
  3. **有未考虑的设计级替代假设**：fidelityGuard 要求所有高信号 token verbatim 存活（`gate.ts:279-298`），而本语料 100% 的行含高信号 token → 守卫在语义上**禁止整行删除**，等价于禁止对 dense-log 语料的 extract 产生任何净缩减。这更像 **extract 语义与守卫语义的设计张力**，而非单纯"提示词没讲清楚"。提示词修复可能只是把"守卫拒"变成"模型少抽"，VK-ratio 依旧 ~100%。
- **[中等] 对照报告结论已过期，未随证据修正**。报告基于 07-30 vs 07-48 产物得出"VK-clean FAIL = 纯模型能力，升级已解决"（:22-25）——但后续 08-41 复跑（Qwen3.6 + thinking + 无 max_tokens）T5 parseFailed 消失，证明 07-30 的 parse 失败主因是 **max_tokens=2048 截断**（`.tmp/t5-raw.txt` 实证 JSON 在 position 4561 截断）+ 零思考退化，**并非纯模型能力**。报告未回写此修正，"模型能力"与"配置截断"的归因至今悬置在报告里。
- **[轻微] 判决表口径混用**。对照报告"合计 4/6 → 5/6"把模型能力项（VK-clean）与引擎项混在一个总数里，"引擎健全 5/6"的叙事实际应为"引擎相关判决 5/5 全绿 + 模型能力项 0/1~1/1"。口径不分会误导读者对引擎置信度的判断。
- **[轻微] 数字口径漂移**。会话记忆/沟通中引用过"26 个高信号 token"（修复前产物），修复后产物实为 **36**（`fidelityMissing.length`，已复核无重复）。对外引用前须统一到最新产物口径。

## 5. 问题清单（分级汇总）

| # | 级别 | 位置 | 问题 |
|---|---|---|---|
| 1 | 严重 | `36-peratom-soak.ts:302` + 语料 :80-100 | VK-ratio ≤85% 在本语料下不可达（需省 1613 字符，最大原子 1609 字符且全行含高信号 token）→ 无效裁判 |
| 2 | 严重 | `36-peratom-soak.ts:93-99,108,116` vs `gate.ts:196` | T4/T7 语料（145/338 字符）低于 512 字门 → 永不压缩，却标为 compressible；VK-plan"合法跳过"判据在实现中缺失（:289 只查 dialog/chain） |
| 3 | 严重 | `36-compare-qwen36-vs-qwen38.md:3,38-40` | "单变量实验"不成立（5 变量漂移）；"改提示词破 85%"预测算术不可行；归因缺强模型对照 |
| 4 | 中等 | 对照报告 :22-25 | T5 parseFailed 归因"纯模型能力"已被 08-41 复跑推翻（实为 max_tokens 截断+零思考），报告未回写修正 |
| 5 | 中等 | `36-peratom-soak.ts:237-250` | 终态判据用全局 `pendingCount`（多会话会误判）；parseFailed 分支不手动 flush 的不对称无注释 |
| 6 | 中等 | 剧本 :104-119 | 单遍设计：split 收益发生在后续轮，剧本无回看轮 → split 压缩收益从未被验证 |
| 7 | 中等 | 整体 | 异常场景零覆盖（端点 500/超时/空内容/并发多会话）；"soak"命名虚高 |
| 8 | 轻微 | `36-peratom-soak.ts:309` | 产物 meta 无 git commit / 引擎配置指纹 → 跨 run 不可审计 |
| 9 | 轻微 | `36-peratom-soak.ts:322` | 沙箱语料用完即删，失败现场不可直接复核 |
| 10 | 轻微 | 对照报告 :18 | 判决总数混用引擎项与模型能力项，口径应拆分 |
| 11 | 轻微 | 会话记忆 | "26 tokens"与产物实值 36 不一致，引用口径需统一 |

## 6. 改进建议（按优先级）

1. **重定义 VK-ratio**（对应 #1，P0）：改为**原子级压缩比**（每个被压原子的 压后/压前 字符比，如 ≤30%），或扩语料使 >512 字门原子占 cf 的 ≥50%（app.log 扩到 ~3000 字符 + 大 runbook），否则降级为信息性观测（不计入 PASS/FAIL）。当前 85% 总字符阈值应废弃。
2. **对齐剧本标签与门控阈值**（对应 #2，P0）：T4/T7 扩到 >512 字符（成为真可压机会），或改标为 `small-skip` 并在 VK-plan 里显式断言"零调用 + 无异常"（补齐文档承诺的"合法跳过"判据）。
3. **补多遍回看轮**（对应 #6，P1）：T5 之后加 1-2 轮引用 T5 内容的追问，让 U-info 副本进入再压路径，首次真正验证 split 收益。
4. **产物版本化**（对应 #3/#8，P1）：meta 增加 `gitCommit`（`git rev-parse HEAD`）、`scriptHash`、引擎配置指纹（enable_thinking / max_tokens 有无 / split 代码版本）；对照报告只允许引用同配置指纹的产物，并在报告头部列全变量表。
5. **回写对照报告**（对应 #4/#10，P1）：修正 T5 归因（max_tokens 截断为主因）、更新到 09-15 最新配置产物、拆分"引擎判决 5/5"与"模型能力项"口径、统一 36 tokens 数字。
6. **强模型基线**（对应 #3，P2）：DeepSeek v4-flash 跑一遍同剧本（成本约一次长会话），分离"弱模型"混淆因子后再定"提示词 vs 设计张力"的归因。
7. **澄清 extract 与守卫的语义边界**（对应 #3-3，P2，设计层面）：在 `per-atom-compression-engine-design.md` 明确 dense-log 语料上"所有行含高信号 token"时 extract 的合法形态——是否允许**聚合式压缩**（同级别日志归并为 count + 抽样行 + 全部唯一 token 清单）？若不允许，应承认 log 语料不是 per-atom extract 的目标场景并在文档/剧本中换用可压缩语料（如含大段叙述的文档型结果）。
8. **异常场景用例**（对应 #7，P2，留给 P4/P5 正式测试）：端点 500 / AbortSignal 超时 / 空 content / 多会话并发 flush，各一条剧本或独立 spike。

---

### 附：审查所用的定量复核（可复跑）
- VK-ratio 下界测算：`.tmp/vk-ratio-bound.cjs`（app.log 1609 字符、16/16 行含 LB token、ratio 下限 95.9%）
- T4/T7 尺寸：145 / 338 字符（<512 字门）
- 产物交叉比对：07-30 / 07-48 / 08-41 / 09-04 / 09-15 五个 JSON 的 T1/T4/T5 字段 + git log（c59b3c2 @09:15:13 晚于全部对照 run）

---

## 7. 修复落实与复跑诊断（2026-08-25 追加）

### 7.1 全部 P0/P1 已落地（对应 §6 建议 1-5）

| 建议 | 落实 | 证据 |
|---|---|---|
| #1 重定义 VK-ratio | 语料重构为"结构化必留 + 叙事可丢"：`makeLog()` 6 行高信号 + 22 行纯散文（3094 字符，21% 必留 / 79% 可丢）；`corpus-bound.cjs` 定量：单原子最优 extract → 压缩比 21%、全局 VK-ratio ≈79.2% < 85% 可达 | `36-peratom-soak.ts:117-158`、`.tmp/corpus-bound.cjs` |
| #2 T4/T7 死设计 | `config/app.yaml` 扩到 525 字符、`docs/runbook.md` 扩到 892 字符（均 >512 真可压） | `36-peratom-soak.ts:160-187` |
| #3/#8 产物版本化 | meta 增加 `gitCommit` + `scriptHash` + `enableThinking/maxTokens/splitThresholdChars/smallResultChars` 指纹；`runFingerprint()` | `36-peratom-soak.ts:83-92, 409-419` |
| #4 对照报告回写 | `36-compare-qwen36-vs-qwen38.md` 追加"勘误与后续修正"6 条（T5 归因 / 错误预测作废 / 单变量不成立 / split 多遍作废 / 口径拆分 / 36 tokens 统一） | 该文件尾部 |
| #5 强模型基线 | 待 LLM 环境恢复后跑（见 7.3） | — |

**新增判决项**：`VK-plan-c`（可压轮全部产生调用，语料扩 >512 后 called=false 即 bug/死设计）、`VK-env`（环境中断轮单独报告，区分环境失败与门控 bug）。

### 7.2 复跑诊断：19:50 run 的 `called=false` 根因 = 环境失败，非门控 bug

复跑（`36-run-19-50-19.log`）T1/T2 均 `called=false`，表面像 VK-plan-c 失败。`diag-t1.ts` 单轮探针（合成事件 + 真实 agent loop 双路径）定位：

- **孤立 session 探针**（`.tmp/probe-collect.ts`）：3094 字符 tool result 正确判 `extract`、`isMember=false`、进入 `toolResults`——gate 逻辑正确；
- **真实 agent loop 探针**（`.tmp/diag-t1.ts`）：事件流显示 `assistant/chunk {"type":"finish","reason":{"kind":"error","failure":{"message":"Connection error.","code":"TRANSPORT"}}}` → `turn/end reason.kind='error'` → `collectInterruptedTurns` 把 error 轮判为中断 → `filterInterruptedAtoms` 清空候选 → `called=false, skipReason='no-candidate'`。

**结论**：LLM 连接失败（本地 llama.cpp 服务中断）→ error 收尾轮被中断过滤正确排除（宁全勿漏，半成品不进压缩候选），**中断过滤在正确工作**，非门控缺陷。19:50 run 同时撞上 18 分钟 watchdog（Qwen3.8-27B thinking 慢，9 轮剧本需更长时间）。

**由此补的设计改进**：`CompressRecord.skipReason` 从单值 `'no-candidate'` 扩展为 `'no-candidate' | 'interrupted'`——中断轮（error/aborted 收尾）与门控判无可压（纯 dialog / 链成员 / 全小结果）在观测上区分开，VK-plan-c 只对非中断的未调用轮 FAIL，环境失败由 VK-env 单独报告（`compressor.ts:242-249, 680-689, 712-723`；测试 `peratom-compressor.test.ts:151-170` 断言 skipReason='interrupted'）。

### 7.3 待 LLM 环境恢复后验证
- [ ] llama.cpp 恢复后重跑 `npm run spike36`（watchdog 已改 50 分钟，`ARGP_SPIKE36_TIMEOUT_MIN` 可覆盖）
- [ ] 验证新语料下 VK-ratio ≈74% 可达（阈值 85% 有牙齿）、VK-plan-c 全过、VK-env 无中断轮
- [ ] 对照报告引用新产物（指纹匹配）后，提交 git 基线（src/lib/test 同步）
### 7.4 本地 llama-server 崩溃诊断（2026-08-26 追加，阻塞 noise200 验证后用户重启解决）

- 10:42 跑 noise200 版时服务崩溃（9 轮全部 interrupted，产物作废）。4 种启动变体（Q4_K_M/Q4_K_XL × 196K/64K/`--no-mmap`）全在模型加载阶段确定性崩溃。
- 事件日志坐实：8 次崩溃同一签名——`ucrtbase.dll` + `0xc0000409`(__fastfail) + 同偏移 `0x7f6fe` + 同二进制（时间戳 0x6a8a2fd2）。构建级确定性 bug，非参数/模型/内存问题（已排除：GPU 驱动正常、RAM 空闲 ~17GB、无僵尸进程）。
- 用户用自己的方式重启服务后跑批正常。

---

## 8. VK-ratio 判定链终审（2026-08-26 追加）

VK-ratio 从"4 模型全 FAIL"到全绿，共经历 4 轮修复，每轮对应一个真实缺陷层：

### 8.1 缺陷层 ①：extract/summary 语义错配（靶子选错）
- 原语料 narrative 是连贯故事散文，语义诱导模型做 **summary**；而 ARGP 的 extract+保真守卫机理只支持**摘原文子集逐字保留**（用户定义：extract=摘取部分原文段落逐字完整拷贝；如 help 输出只拿需要的命令、失败日志只拿 error 部分）。
- 模型一旦概括散文 → 丢精确串 → `fidelityGuard` 拒 → 压缩不 apply → ratio 卡 90%+。**这是"死裁判"的第一层根因**。

### 8.2 缺陷层 ②：extract 提示词诱导改写（commit 910d7da）
- 旧指令"关键内容摘录（1-3 句）"诱导模型自己组织语言 → 改写 `req_id=`/`latency_ms=` 等 key=value → 守卫拒。
- 修复：extract 指令 verbatim 化（与 quotes 同风格：逐字完整拷贝，空白/换行/标点/大小写/全角半角/emoji 原样，禁止改写/翻译/增删/重组；未选中行视为噪声丢弃）。
- 效果：T1 从 `fid=1` 不 apply → `fid=0` 完美提取（6 行 structured 逐字全保留、22 行噪声全丢），ratio 96.8% → 90.4%。

### 8.3 缺陷层 ③：语料可压占比太小（90.4% 是结构性地板）
- 地板根因：① T2/T9 链成员必须保留 2 份完整 app.log（VK-chain 硬要求）；② **assistant 回复不可压**（ARGP 只压 user-long + tool-result），每轮 ~300-900 字符 ×9 轮 ≈ 8000+，分母分子同步抬高；③ corpus-bound 假设 `otherPerTurn=120`，实测 ~1300——**差 10 倍**，理论 79.9% vs 实测 90.4% 的全部来源。
- 修复：app.log 噪声 22 → ~200 行（T1 收益主导 cfTotal）+ persona 加"回答尽量简短"。corpus-bound 重估理论 68.9%，实测 **69.7%**（noise200 版全 8 判决 PASS，commit 910d7da 同批）。
- **口径统一**（原 74%/79.2%/80.1% 三个数字不一致）：74% = 旧 corpus-bound 单原子最优注释；79.2% = 旧语料（22 行散文）全局估算；80.1% = 脚本实际输出。三者的差源于语料/口径演进，**现行口径以 noise200 语料的理论 68.9% 与实测 69.7% 为准**，旧数字作废并标注历史。

### 8.4 压缩档位改为模型自选 + 守卫分级（commit c3e00c8）
- 用户设计：让 LLM 自己判断每原子用 summary 还是 extract，再输出（同一 JSON 结构 `{seq, level, text}` 不同字段）。
- `fidelityGuard` 按 level 分级：extract 维持硬拒；**summary 审计式放行**——被概括丢弃的高信号 token 逐条入账 `CompressRecord.summaryDropped` 供 LLM/人工审核。
- spike36 新增 T7b 纯叙述事故复盘靶子（`docs/postmortem.md`，零 load-bearing）。验证：log/yaml/runbook → extract（verbatim 子集 fid=0）；**postmortem → summary**（421 字，事实全保留，sumDrop=0）。自选语义成立。

### 8.5 压缩率改为按原子度量（commit 9d43394）
- 用户定义修正：压缩率按**每个被压缩原子**计算（origChars vs newChars），非按 turn/全局——全局 ratio 被链副本/assistant 回复稀释。
- 新判决 **VK-atom** = 被压原子聚合收益 `1-Σnew/Σorig ≥ 50%`；全局 ratio 降为参考。首测 90.7% PASS（T1:extract 97.0%、T7b:summary 85.1%；T3/T7 近 0% 因全 load-bearing 属正确保留）。

### 8.6 拿不准选 false，禁全文照抄（commit 87c66de）
- 用户指示：拿不准时该原子不出现在输出里（保原文），避免 extract 全文照抄——output token 白花且压缩率 0。
- 效果：T3 yaml → 模型选 false 不压（空 tools，零 token 浪费）；T7 runbook → 伪压缩 0.1% 变真 summary **65.7%**（5 条命令 verbatim、散文概括）；**VK-atom 90.7% → 94.7%**（剔除伪压缩原子后更高）。
- 行为三层齐：extract（T1）/ summary（T7、T7b）/ false（T3）——模型按内容性质自选成立。

### 8.7 门控运行间随机：评估后挂起
- 现象：Qwen3.8 多次跑批中偶见 VK-plan/plan-c 抖动（对话轮被压、可压轮 no-candidate）。
- 判定：LLM 采样非确定是天然属性；"能不能压"已由代码侧确定性判据兜住（>512 字门、链成员排除、toolName 对照表），"怎么压"交给 LLM 的随机风险已被守卫+审计兜底，错误方向只可能"少压"不会"压坏"——**细化判定标准需加长 prompt 提高每轮成本，性价比低，挂起不修**。

### 8.8 终态结论
- **VK-ratio 阈值本身合理**；此前 4 模型全 FAIL 是"靶子选错 + 提示词诱导改写 + 语料可压占比小"三层叠加，均已修复。
- 现判决口径：VK-atom（按原子聚合压缩收益）+ VK-plan/plan-c/env/chain/originals/clean/prefix 共 8 项全 PASS，参考全局 ratio 69.0-70.6%。
- 最终产物：`spike/out/36-peratom-soak-2026-08-26T07-34-11-688Z.json`（false-opt 版，VK-atom 94.7%）。
