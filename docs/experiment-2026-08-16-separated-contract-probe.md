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
