[English](README.en.md) | 中文

# dsh-argp — 基于逻辑链的原子引用图剪枝式上下文压缩引擎

[![CI](https://github.com/yoza10635/dsh-argp/actions/workflows/ci.yml/badge.svg)](https://github.com/yoza10635/dsh-argp/actions/workflows/ci.yml)
[![GitHub Release](https://img.shields.io/github/v/release/yoza10635/dsh-argp)](https://github.com/yoza10635/dsh-argp/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

dsh-argp（ARGP = **A**tomic **R**eference **G**raph **P**runing，原子引用图剪枝）是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的第三方 `CompactionEngine`：**基于逻辑链（引用依赖拓扑）的原子级选择性遗忘**——历史中"被依赖"的内容按引用图保留，"孤立"内容按反向拓扑序摘除，压缩阶段零 LLM 调用，不把历史重写为摘要。

- **压缩阶段 0 次 LLM 调用**——纯图规则，确定性、可收敛
- **基于逻辑链决策**——剪枝依据是引用依赖拓扑（"谁被依赖"），不是新旧位置或模型偏好
- **选择性遗忘而非重写**——被剪内容留在 append-only 会话日志，可通过内置 `recall_pruned` / `recall` 工具取回
- **引擎无关的接缝**——通过标准 `CompactionEngine` 接口挂载，作为 `compaction-basic` 的替代后端
- **压缩率精确兑现**——实测 200K 上下文 → 160K 触发 → 32K 保留，输出大小可控

> 状态：研究/验证阶段。全链路（挂载 → 剪枝 → recall，事务不变式）已在 dsh `0.1.0-rc.7` + DeepSeek v4-flash 上完成 50 轮验证；声明式生产挂载已验证（`dsh plugin` CLI 加载）。

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

## 模型要求（建边密度与指令遵循能力挂钩）

语义边来自模型在对话时按 prompt 契约输出的 `{"cites": [...]}` 声明——**建边密度直接取决于模型的指令遵循能力**：

- **遵循能力强**：按契约声明 cites → 引用图反映真实依赖 → 剪枝选择性高
- **遵循能力弱**：漏声明（图稀疏，只剩确定性边）或乱声明（图过密）→ 剪枝选择性下降，事务形态改变

实测对照（50 轮 t-long，同引擎同参数、**同任务指令**）：DeepSeek v4-flash（high 档）cites declared=0、每笔事务剪 34–35 原子（稀疏图）；Qwen3.8-27B declared=547、每笔事务只剪 4 原子、37 笔事务（密集图）——**同一引擎在不同模型上呈现不同剪枝形态**，但两者 L1/L2/L3 不变式均 PASS。

一个关键的模型差异（实测）：t-long 任务指令本身写有 "reply with exactly one line and nothing else"（与 cites 契约存在冲突），**DeepSeek v4-flash 的系统提示词优先级低于用户指令**——"nothing else" 压住了 cites 声明（declared=0）；**Qwen3.8-27B 则系统提示词优先级高于用户指令，声明更稳健**——即使指令说 "nothing else"，它仍在回复后追加 cites 声明（declared=547）。**系统提示词与用户指令冲突时的取舍，由模型训练决定，而非提示词措辞**——这是建边密度差异的深层原因，prompt 模板优化对服从率的提升存在天花板（实测各模板 ≤40%）。

**对使用者的警示**：DeepSeek 系模型在"系统提示词 vs 用户指令"冲突时更易被用户指令压制——如果你的任务/工具 prompt 恰好写了类似 "nothing else"、要求严格格式输出等与 cites 契约冲突的措辞，DeepSeek 可能全程 0 建边。这不影响压缩功能（见下一条"零建边保证"），只是失去语义选择性；任务 prompt 给 cites 留出口后（实测 10 轮）声明率即可恢复到 43.6%、解析 100%。

约束含义：建议搭配指令遵循能力强的模型使用；弱模型下压缩依然安全（0-LLM 确定性 + `U` 锚点保护 + `recall` 兜底在任何模型上成立），只是选择性收益降低。

**一个重要保证：即使全程零建边（cites declared=0，语义引用层完全缺失），也不影响压缩中其他剪枝优先级机制的正常运作**。语义边只是压缩决策的**增强信号**，不是必要条件——剪枝的核心路径（确定性边配对、`eff` 重要性排序、`U` 锚点永不剪、lastRef 最近引用轮次、density 密度排序、闭包生命周期、版本链去重）全部独立于 cites 声明独立工作。DeepSeek v4-flash 档（declared=0）的 50 轮实测即为此保证的完整证据：L1/L2/L3 全 PASS、压缩率精确兑现、recall 正常兜底——**跨轮逻辑链缺失时引擎退化为"确定性边 + 位置/重要性排序"的普通剪枝，功能完整，只是选择性增益消失**。

## 安装与挂载

### CLI 声明式挂载（已验证）

从 **npm registry** 安装（当前 `v0.2.4`）：

```bash
dsh plugin --profile <name> add dsh-argp
```

升级到最新版（`dsh plugin` 是 pnpm 转发器，`update` 直接拉取 npm registry 新版）：

```bash
dsh plugin --profile <name> update dsh-argp
```

备选：从 GitHub 安装同一版本（源码直达，不经 npm）：

```bash
dsh plugin --profile <name> add github:yoza10635/dsh-argp
```

然后在 profile 的 `cordis.patch.yml` 中插入引擎并禁用 stock 摘要器：

```yaml
- id: compaction-basic
  disabled: true
- insert:
    - id: dsh-argp
      name: dsh-argp
      config: { maxPasses: 16 }   # 预算默认按比例驱动，无需硬编码
```

启动后 `ctx.compaction` 即为 ARGP 引擎。

### 预算比例驱动（默认）

- `windowTokens = contextWindow × 0.8`（上下文 80% 触发）
- `retainTokens = windowTokens × 0.2`（压缩率 1/5）

上下文容量读自模型适配器声明，换模型自动适配；需要时也可显式覆盖（见 [config](src/argp-graph-engine.ts)）。

### 本地开发

```bash
npm install
npm run check        # typecheck + 本地 smoke + 单元测试
```

DeepSeek 实测需要 dsh 标准凭据：

```bash
npm run smoke:deepseek   # 10a + 10b + 10d 单轮冒烟
```

## 验证结果

DeepSeek v4-flash，50 轮 t-long 任务；完整数字与产物路径见 [`docs/experiment-2026-08-16-separated-contract-probe.md`](docs/experiment-2026-08-16-separated-contract-probe.md)。

| 指标 | dsh-argp | compaction-basic（同任务 high 档） |
|---|---|---|
| 预算模式 | 比例驱动（200K → 160K 触发 → 32K 保留） | 固定 32K 意图，不可控 |
| 事务 / error | 4 / 0 | 30 / 23（77%，全为空流） |
| U 锚点保留 | 7/7 | 7/7 |
| needle 找回 | 7/7（5/7 经 recall） | 0/7（不可找回） |
| 压缩目标兑现 | 精确（32K） | 实际 67K（失控） |
| 成本（空闲价） | ¥2.695 | ¥3.087 |

研究档对照：dsh-argp ¥0.355（U 7/7 R 7/7）vs `compaction-basic` ¥0.911（U 0/7 R 0/7）。

## 复现

| 实验 | 命令 | 验证内容 |
|---|---|---|
| 50 轮 t-long（high 思考档） | `ARGP_DEEPSEEK_THINKING=enabled node spike/06-tlong.ts` | L1/L2/L3 不变式、7/7 锚点、7/7 needle 经 recall 找回 |
| 160K 主流档 | `ARGP_CONTEXT_WINDOW=200000 ARGP_CHUNK_LINES=600 node spike/06-tlong.ts` | 压缩率精确兑现、比例预算 |
| 基线对照（compaction-basic） | `node spike/07-baseline.ts` | 同任务下 stock 摘要器对照 |
| 合成 0-LLM | `npm run spike8a` | 28 原子单事务、零 LLM 调用 |

每个数字都带产物路径（见实验记录文档）。

## 平台缺口反馈（给 dsh）

开发非 LLM 压缩后端暴露了 compaction 接缝的四处扩展性缺口，细节与复现脚本见 [`docs/dsh-api-feedback-2026-08-17.md`](docs/dsh-api-feedback-2026-08-17.md)：

1. **tool/result 替换无结构化元数据通道**——占位必须克隆原 message，只能改 content。
2. **`compaction/prune` 游离于事务不变式状态机**——算法剪枝没有原生事件类型，第三方引擎只能借 `summary` 语义 + 填伪字段。
3. **headless 测试装配静默失效**——`mountAgentLoopTestDependencies` 不注册 `tokenMeter`，pre-step 的 catch 吞掉错误。
4. **摘要调用间歇性空流（B-5）**——high 思考档 77% 事务空流失败，`maxTokens=32768` 无效，疑似流式连接竞态。

## License

MIT
