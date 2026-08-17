# 实验记录：prompt/tool 分离后的小型契约探针与 50 轮重跑（2026-08-16）

## 背景与目标

- 已完成 prompt/tool 分离：`argp-contract`（pruned view + recall）与 `argp-cites`（引用输出协议）独立。
- 历史问题：DeepSeek v4-flash 上 recall 与 cites 服从性分离——
  - disabled：cites 好，recall 几乎不触发；
  - high：recall 好，cites 基本为空块。
- 目标：
  1. 用小型契约探针验证分离后，disabled 与 high 两档能否在同轮首次同时做到 recall 触发 + cites 进入最终正文。
  2. 根据探针结果重跑 50 轮 t-long 正式对照。

## 实验方案：小型契约探针（spike 11）

- 脚本：`spike/11-contract-probe.ts`
- 预算：`windowTokens=800`，`retainTokens=400`，`minSpanChars=200`，`maxPasses=32`
- 语料：`logs/chunk-1..8.md`，每片约 9.5K chars；目标为 `chunk-2.md` 首行 R 针
- 编排：
  - setup 1 轮
  - filler 轮：read_file 读 chunk 并报行数，直到目标 chunk 被剪（`engine.recall(targetSeq) !== null`），上限 8 轮
  - probe 1 轮：要求模型先 recall_pruned 找回 `chunk-2.md` 首行，回答 `R-ANSWER`，并在正文末尾按 `argp-cites` 契约追加 cites JSON
- 判决：
  - C1：probe 轮 recall_pruned 是否触发（门禁）
  - C3：cites 是否进入最终正文（门禁）
  - C4：recall 触发 + 命中 + R 正确 + cites 正确是否同轮首次成立（门禁）
  - recall 命中率作为 METRIC，不做门禁

## 探针结果

| 档位 | probeTurn | target pruned | recall 触发 | recall 命中 | R-ANSWER | cites 进最终正文 | C4 同轮成立 | wall |
|---|---|---|---|---|---|---|---|---|
| disabled | 5 | true | 1 | 1/1 | 正确 | 正确 | PASS | 10s |
| high | 5 | true | 3 | 2/3 | 正确 | 正确 | PASS | 29s |

两档最终正文均形如：

```text
R-ANSWER: INC-2-MARKER-22HQ
{"cites":["chunk 2 telemetry export — incident ref INC-2-MARKER-22HQ"]}
```

`extractCites` 解析：`attempted=true`，`parseFailed=false`。

说明：high 档 3 次 recall 中 1 次 miss（探测了未剪 seq），但不影响答案正确性与 cites 输出；因此 recall 命中率作为 metric 记录，不改变 C4 结论。

## 50 轮 t-long 重跑

仍用 `spike/06-tlong.ts` 默认预算：`windowTokens=10240`，`retainTokens=7168`，`maxPasses=16`，`minBoundaries=10`。

| 档位 | run name | L1 稳定 | L2 U 保护 | L3 R 找回 | recall 调用/命中 | cites declared | wall | 产物 |
|---|---|---|---|---|---|---|---|---|
| disabled | `06-tlong-disabled-rerun` | PASS（50/50，36 tx，0 orphan） | PASS 7/7 | **FAIL 1/7** | 2/2 | 0 | 123s | `spike/out/06-tlong-disabled-rerun-2026-08-16T14-02-21-785Z/` |
| high | `06-tlong-high-rerun` | PASS（50/50，12 tx，0 orphan） | PASS 7/7 | **PASS 7/7** | 13/10 | 0 | 165s | `spike/out/06-tlong-high-rerun-2026-08-16T14-07-36-553Z/` |

- disabled 误差曲线：`[1,0,0,0,0,0,0]`（R 仅 probe-1 找回）
- high 误差曲线：`[1,1,1,1,1,1,1]`（probe-7 目标未遮蔽，surface 直读）
- cites declared=0 是因为 t-long 探针文案要求 “nothing else”，未要求 cites；cites 结论以 spike 11 为准。

## 结论与决定

1. **方案采用分离后的 prompt/tool 契约**（`argp-contract` + `argp-cites` 独立）。
2. 分离后，小型契约探针证明：disabled 与 high 两档都能在要求 cites 的场景下，同轮首次同时做到 recall 触发 + cites 进入最终正文。
3. 50 轮正式对照中：
   - high 档 L1/L2/L3 全 PASS，维持优势。
   - disabled 档 L1/L2 PASS，L3 仍 FAIL，根因是 recall 几乎不触发（2 次）。
4. 后续主要矛盾是 disabled 档的 recall 触发，而非 cites。

## 日志文件

- `spike/11-probe-disabled-out.txt`
- `spike/11-probe-high-out.txt`
- `spike/06-tlong-disabled-rerun-out.txt`
- `spike/06-tlong-high-rerun-out.txt`


## 追加：fork 分叉探针矩阵（disabled 档，无需完整 50 轮）

- 脚本：`spike/16-fork-probe.ts`
- 方法：从 `06-tlong-disabled-rerun` 的 `events.jsonl` 取目标 probe 轮前最后一个 `turn/end` 为 seed，用 `ctx.agents.create({ seed })` fork 会话，只重放一个 probe 轮。
- 成本：每个 cell 只有 1 个 probe 轮。
- 修正说明：probe 5/6/7 的目标 chunk 因前插 probe 轮，需要减去 `PROBE_TURNS` 中早于该 needle 的 probe 数量；目标 chunk 依次为 2/5/8/11/15/20/25。

### fork 矩阵结果（probes 2-7，每个 cell 5 repeats）

| 变体 | 说明 | recall 触发 | R 正确 |
|---|---|---|---|
| v0 | 06-tlong 原文 | 1/12 (8%) | 0/12 (0%) |
| v1 | 开头显式 call recall | 22/30 (73%) | 16/30 (53%) |
| v4 | 格式后显式 call recall | 21/30 (70%) | 16/30 (53%) |
| v5 | 逐步策略：逐个 recall placeholder 直到找到 chunk 首行 | **29/30 (97%)** | **28/30 (93%)** |
| v6 | 显式 + 禁止猜测 | 18/18 (100%) | 12/18 (67%) |

### 结论与改动

1. v5 最优：recall 触发 29/30，R 正确 28/30（probes 2-7）。
2. 已将 `spike/06-tlong.ts` 的 `probeText` 改为 v5 策略文案。
3. 按用户要求，不再重跑完整 50 轮；disabled 档 L3 预期由 fork 矩阵推算为高概率 PASS（R 正确率约 93%，probe-1 原已通过）。
4. 若后续需要正式 50 轮产物，再跑 `spike/06-tlong.ts` disabled 验证即可。

## 诊断脚本清单

- `spike/12-recall-trigger-probe.ts`：压缩场景 probe 文案探针。
- `spike/13-tlong-probe1-recall-diag.ts`：1:1 复刻 06-tlong 前 N 轮到指定 probe。
- `spike/15-fork-probe.ts`：fork 可行性实验。
- `spike/16-fork-probe.ts`：fork 探针矩阵执行器。


## 追加：list_pruned 工具与 v7 对比

### 实现

- `src/argp-graph-engine.ts` 新增 `list_pruned` 工具：
  - 列出当前被剪节点：`seq/type/turn/firstLine preview/citedBySeq`
  - 可选过滤：`turn`、`type`（A/R/U/X）、`keyword`
  - `argp-contract` 系统提示改为“先用 list_pruned 找 seq，再 recall_pruned 取全文”
- 新 probe 变体 v7：先 `list_pruned`，定位 `chunk <n> telemetry export` 的 R 节点 seq，再 `recall_pruned(seq)`。

### fork 对比（probes 2-7，每个 cell 3 repeats，当前引擎）

| 变体 | R 正确 | recall 触发 | 说明 |
|---|---|---|---|
| v5（当前引擎） | 17/18 (94%) | 15/18 (83%) | 保持“逐步 recall”策略 |
| v7（list_pruned + recall） | 16/18 (89%) | 9/18 (50%) | list_pruned 调用 19 次；部分答案仅靠 preview，未走 recall |

### 结论

1. `list_pruned` 能显著减少盲猜 seq，模型会主动用 `keyword/type` 过滤。
2. 但当前 preview 包含完整首行 marker，模型有时直接抄 preview，绕过 recall 全文。
3. 因此正式 probe 文案仍保留 v5；`list_pruned` 作为辅助工具保留，若后续要强制 recall，应把 preview 截断到不含 marker 码，或只返回 `seq/type/turn/citedBy`。

## 追加：P2 生产档真跑 + P5 基线重跑（2026-08-17）

### P2 生产档回归（closure lifecycle 后）

- 命令：`spike/06-tlong.ts`，high，100000/33000/maxPasses=256
- 产物：`spike/out/08-production-closure-2026-08-17T01-51-51-015Z/`
- 结果：L1/L2/L3 全 PASS；U 7/7，R 7/7；2 笔事务；wall=185s

### P5 基线重跑（BasicCompactionEngine，TokenMeter 已修复）

- 产物：`spike/out/07-baseline-deepseek-2026-08-17T01-55-34-648Z/`
- 结果：50/50 轮完成；117 次 compaction，85 次 error；U 0/7，R 0/7
- 与 ARGP 对照：ARGP high U 7/7、R 7/7；基线 U/R 全 0

### P4 声明式挂载

- 已提供 `cordis/argp.cordis.snapshot.yml` 与 `docs/dsh-argp-mount-example.md`
- 真实 `dsh` 命令验证仍待环境（当前无 dsh CLI）

## 追加：160K 主流场景三档定稿对比（2026-08-17）

### 背景

用户要求用主流上下文档（~200K 上限 → 160K 触发线）做对称对比，并明确基线只有触发线、无目标线（摘要不可控是基线固有属性）。此前研究档（10K/7.2K）的"ARGP 更便宜"叙事在主流档是否成立需要实证。三组全部同任务（600 行 chunk × 50 轮 t-long，ARGP_CHUNK_LINES=600）、同触发线（200K × 0.8 = 160K）；差异只在引擎与思考档。

### 三组配置

| 组 | 引擎 | 思考档 | 目标线 | 产物 |
|---|---|---|---|---|
| ARGP A 档 | ArgpGraphEngine | high（thinking enabled） | 32K（精确兑现） | `spike/out/scan-32k-2026-08-17T04-33-59-195Z/` |
| 基线 disabled | BasicCompactionEngine | disabled | 建议 32K（不可控） | `spike/out/07-baseline-deepseek-2026-08-17T04-44-03-384Z/` |
| 基线 high 定稿 | BasicCompactionEngine | **high** + `maxTokens=32768` | 建议 32K（不可控） | `spike/out/07-baseline-deepseek-2026-08-17T10-05-07-507Z/` |

注：基线 disabled 档的 maxTokens 为默认 8192；基线 high 定稿显式设 32768（B-5 修复验证）。ARGP 是 0-LLM 剪枝，不受 maxTokens 影响。

### 结果对比

| 指标 | ARGP A 档 | 基线 disabled | 基线 high 定稿 |
|---|---|---|---|
| 事务 / error | **4 / 0** | 25 / 16（64%） | 30 / **23（77%）** |
| U 达成 | 7/7 | **4/7**（含 NOT-RECOVERABLE） | 7/7 |
| R 达成 | **7/7**（5/7 经 recall） | 0/7 | 0/7（NOT-RECOVERABLE） |
| 压缩目标兑现 | 32K **精确** | 建议 32K → 67K | 建议 32K → 67K |
| 调用次数 | 112 | 104 | 99 |
| 总成本（空闲价） | **¥2.695** | ¥3.19 | ¥3.087 |
| wall | 378s | 227s | 631s |

### 关键结论

1. **error 根因实锤：不是 maxTokens，是空流**。基线 high 定稿 23 笔 error **全部"区间内 0 usage"**——`ctx.llm.stream()` 返回空流（0 chunk、无计费）。此前 B-5 诊断（reasoning 吃满 8192 → text=0）只在默认 8192 档成立；32768 下空流依旧 → **dsh 摘要调用在 high 档的系统性不可靠 = 引擎固有（空流 + 误报 "no text summary content"），配置无法修复**。disabled 档 16/25 error 同机制（usage=0），与 maxTokens 无关。
2. **主流档叙事定稿：达成度 > 成本**。三组成本差很小（¥2.70-3.19，最多 1.18×），但 R 达成 ARGP 7/7 vs 基线两档均 0/7（needle 全毁、不可找回）。"ARGP 更便宜"仅研究档（10K）成立（¥0.355 vs ¥0.911）；**主流档的卖点 = "同成本下达成度碾压 + 压缩率精确兑现（32K vs 67K）+ 0 error"**。
3. **思考档对基线 U 达成有改善但救不了 R**：high 档 U 从 4/7 → 7/7，但 R 仍 0/7——摘要把 needle 语义压没了，与思考档无关，是"重写即丢失"的固有属性。
4. **error 后引擎自动重试，重试耗尽则静默放弃**（events.jsonl 事件序列实证）：error 事务后立刻 `step/start` 再触发压力检查（surface 未收缩仍超阈值）；同 turn 内连续 error（turn 9 两笔 ERRERR）= 重试仍失败；失败 2-3 次后停止重试，`turn/end` 正常结束，下一轮照常——**50 轮流程不中断**（L1 turns=50/50 仍 PASS），但上下文不收缩、持续膨胀。代价：重试 step 让模型多跑一轮（调用次数膨胀），且压缩"慢性失能"。**间歇性证据**：turn 10/17/23 的 error 后重试成功（`ERROK`），成功笔 usage=1（output=1823、cacheRead=152960 前缀命中 99.7%）——空流是间歇性的（同 turn 连续调用一空一正常，排除上下文大小因素，疑似流式连接竞态）。
5. **反事实：基线全成功反而更贵（成本优势鲁棒）**。23 笔 error 中**连续 error 是同一失败事件的重试，按失败 turn 计只有 13 个失败事件**（events.jsonl 按 turn 聚合：13 FAIL + 7 OK）。反事实"13 个失败 turn 各补 1 次成功摘要"（单次成功摘要实测 ¥0.0164：input 390 + cacheRead 152960 + output 1823）：
   - 直接增量 +¥0.214（13 × ¥0.0164）→ 基线全成功成本 ¥3.301
   - 间接效应（上下文收缩省 miss）无法追平——成功摘要 cacheRead 占比 99.7%（¥0.05/M 极便宜），可省的 miss 有限
   - **结论：基线全成功也比 ARGP ¥2.695 贵 ¥0.61，且 R 0/7 不变（成功摘要同样 67K 不可控 + 丢 needle 是摘要引擎固有）**——"基线贵"不依赖 error 率，ARGP 成本优势鲁棒
6. **口径纪律**：三组成本为 2026-08-17 涨价后空闲价（v4-flash miss ¥1.5/M、hit ¥0.05/M、output ¥4.5/M），产物运行于北京 18-19 点（非高峰）；成本核算脚本 `.tmp/cost-audit.mjs`（换产物目录可重算）。

### 附带发现：ARGP 侧新机制（同日实现）

- 排序模式 `sortMode`（legacy/density/density-chain，spike 19 三模式对照：legacy 剪 4 fact 靠 recall、density 0 fact 直读）
- recall 价值继承（被 cites 的 recall 原子继承旧 eff ×0.5，提交 1c87017）
- 均默认 legacy 行为不变，27+3 测试全绿；与 160K 对比无直接关联，单独验证

