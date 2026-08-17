[English](README.md) | 中文

# ARGP — DeepSeek Harness 的 0-LLM 确定性上下文压缩引擎

ARGP（**A**tomic **R**eference **G**raph **P**runing，原子引用图剪枝）是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的第三方 `CompactionEngine`，**压缩阶段零 LLM 调用**：不把历史重写为摘要，而是选择性遗忘。

- **压缩阶段 0 次 LLM 调用**——纯图规则，确定性、可收敛
- **选择性遗忘而非重写**——被剪内容留在 append-only 会话日志，可通过内置 `recall_pruned` 工具取回
- **引擎无关的接缝**——通过标准 `CompactionEngine` 接口挂载，作为 `compaction-basic` 的替代后端

> 状态：研究/验证阶段。全链路（挂载 → 剪枝 → recall，事务不变式）已在 dsh `0.1.0-rc.6` + DeepSeek v4-flash 上验证。声明式生产挂载（P4）进行中。

## 为什么

摘要式压缩（如 `compaction-basic`）在压缩时调用 LLM 重写历史：成本随上下文线性放大、信息有损、压缩率不可控。ARGP 走相反路线：依赖关系在对话发生时以结构化方式沉淀（每轮小额标注），压缩时只按引用图的反向拓扑序"摘除"原子——每个原子 token 数已知、剪枝确定性、降级链收敛到预算。

## 核心机制

1. **原子化**——历史拆分为原子（用户输入 / Agent 输出 / 工具结果）。dsh surface 无独立 tool/call 节点，call 块内嵌在 assistant 原子内。
2. **建图**——确定性边（assistant → 其工具结果，经 `toolCallId`）+ 语义边（assistant 输出中声明的引用前缀 `{"cites": [...]}`）。
3. **拓扑剪枝**——反复摘除入度为 0 的原子，排序键：边等级 → 有效重要性 → 最近引用轮次。被剪引用方的出边随之消失，目标入度递减解锁（每 pass 动态有效入度）。`U`（用户）原子与墓碑永不参剪。
4. **闭包生命周期**——已完成任务的闭包（以任务型 U 原子为根锚）可整体摘除，墓碑进入 recall 索引。
5. **recall**——`recall_pruned(seq)` 从日志取回被剪原子；`list_pruned` 展示剪枝目录。预算：每轮 ≤3 次、单次 ≤5% window、累计 ≤10%。
6. **版本去重**——完全重复的 assistant 原子 / 同 issuer 的工具结果成对剪除（设计稿 θ=0.8 版本链去重的简化形态）。

设计细节、不变式与设计↔实现差异见 [`docs/`](docs/)。

## 仓库结构

| 路径 | 内容 |
|---|---|
| `src/argp-graph-engine.ts` | 主引擎（建图、剪枝、闭包生命周期、recall/list 工具） |
| `src/argp-t1-engine.ts` | 早期的单事务验证引擎 |
| `src/recall-engine.ts` / `src/probe-engine.ts` | recall / probe 辅助 |
| `test/` | 测试套件（`argp-graph-engine.test.ts`、`chain-unlock.test.ts`） |
| `spike/` | 复现/验证脚本（每个 `node spike/NN-*.ts` 自包含） |
| `docs/` | 设计稿（v1.0）、迁移设计、路线图、实验记录、设计↔实现追踪 |

## 快速开始

```bash
npm install
npm run check        # typecheck + 本地 smoke + 单元测试
```

DeepSeek 实测需要 dsh 标准凭据（dsh 凭据位置）：

```bash
npm run smoke:deepseek   # 10a + 10b + 10d 单轮冒烟
```

## 复现

关键验证（产物本地保留；脚本已提交）：

| 实验 | 命令 | 验证内容 |
|---|---|---|
| 50 轮 t-long（high 思考档） | `ARGP_DEEPSEEK_THINKING=enabled node spike/06-tlong.ts` | L1/L2/L3 不变式、7/7 锚点、7/7 needle 经 recall 找回 |
| 生产档 | `ARGP_DEEPSEEK_THINKING=enabled ARGP_WINDOW_TOKENS=100000 ARGP_RETAIN_TOKENS=33000 ARGP_MAX_PASSES=256 node spike/06-tlong.ts` | 大事务剪枝（单笔 34–35 原子） |
| 基线对照（compaction-basic） | `node spike/07-baseline.ts` | 同任务下 stock 摘要器对照 |
| 合成 0-LLM | `npm run spike8a` | 28 原子单事务、零 LLM 调用 |

实验结论与 claims 记录在 [`docs/experiment-2026-08-16-separated-contract-probe.md`](docs/experiment-2026-08-16-separated-contract-probe.md)，每个数字都带产物路径。

## 平台缺口反馈（给 dsh）

开发非 LLM 压缩后端暴露了 compaction 接缝的三处扩展性缺口，细节与复现脚本见 [`docs/dsh-api-feedback-2026-08-17.md`](docs/dsh-api-feedback-2026-08-17.md)：

1. **tool/result 替换无结构化元数据通道**——占位必须克隆原 message，只能改 content。
2. **`compaction/prune` 游离于事务不变式状态机**——算法剪枝没有原生事件类型，第三方引擎只能借 `summary` 语义 + 填伪字段。
3. **headless 测试装配静默失效**——`mountAgentLoopTestDependencies` 不注册 `tokenMeter`，pre-step 的 catch 吞掉错误。

## License

MIT
