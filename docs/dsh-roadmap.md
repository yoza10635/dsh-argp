# ARGP dsh 推进路线图（2026-08-17 排程）

> 前置：handoff-dsh-continuation.md（状态锚点 + 接手增量）。本文档管"接下来按什么顺序做"。
> 机制决策账本（13 项未实现机制的定性）见本文档 §0——降级项不是欠账，移植项不当新做。

## 0. 机制决策账本（排程依据）

- **弃用（2 项）**：主动检测用户回返（phase2 扩展）、建边覆盖率保底（不走契约层，候选形态搁置）
- **降级（4 项）**：summarize（0-LLM 卖点，默认关，P3 作末环恢复）、时间降级（lastRefRound 打分吸收）、完整 askCover（简化版 + 动态复核必须保）、recall 预算闸门（实测用量低，缓做）
- **被平台取代（1 项）**：确定性边 A→T→R（dsh 无 T 节点，组同剪等价保护，移植时以适配形态恢复）
- **移植（4 项，pi 侧有完整实现）**：R 版本链（version-chain.ts）、引用分级（types.ts EdgeLevel）、catalog 规则（render.ts 排序/≤20 条/snippet 70/600 token 预算）、配对修复（A 剪后最小 assistant 占位）
- **新做（3 项）**：闭包生命周期（枢纽）、开放问题 8 爬升/空剪（大部分被闭包吸收）、声明式生产挂载

## P1. 移植补齐（无 GPU，机械活，先行）

目标：dsh 引擎图能力与 pi fork 拉平。顺序按依赖：

1. **引用分级四级**（isolated/contextual/supporting/critical + 权重表）——后续一切排序的地基
2. **确定性边适配形态**（组内 A→R 确定性边，替代 pi 的 A→T→R）
3. **R 版本链去重**（origin 签名适配 dsh R 原子形状：toolCallId 反查；θ=0.8/union-find/critical 豁免/成对剔除照搬）
4. **catalog 规则 + 配对修复移植**（排序/截断/预算照搬；A 剪存活 toolCall → 最小 assistant 占位，防孤儿 400 回归）

**退出判据**：`npm run check` + smoke 全绿；对 spike 5 产物离线重放，分级/去重结果与 pi 侧语义一致。

## P2. 闭包生命周期（枢纽，实现无 GPU + 验证占 GPU）

1. 扁平分区：根锚（¬askCover 任务型 U）→ 初界（轮次窗口）→ 收紧（弱连通，孤岛入游离池）→ 闭包 DAG
2. 状态机 ACTIVE→COMPLETED（K=2 静止）→PRUNABLE（in_degree==0）→PRUNED（超预算候选耗尽，叶序剪）；任意→ACTIVE 回拉 + K 轮防抖
3. 闭包墓碑：`{闭包ID, 根U原文, 原子清单, 剪除轮, 原因}`，根 U 原文进现有 recall 通道当锚点（不新建通道）
4. closureDisposition **只做 tombstone**；memory/tips 推 P5 之后

**退出判据**：构造"多完成任务"合成会话——COMPLETED 闭包被叶序整剪、被依赖闭包不剪、recall 回拉生效；再回归 spike 8 生产档（事件流离线重放，不动 GPU 先验逻辑，再真跑一轮）。
**副作用**：开放问题 8（爬升/空剪）大部分被吸收；入度新鲜度衰减如需保留，作为 COMPLETED 信号的扩展项评估，不单独开工。

## P3. 降级链补全 + 生产硬化

1. summarize-critical 作为**末环**恢复（默认关，config 开关；闭包剪除在前）——降级链 lifecycle→summarize→force→fail 闭合
2. recall 预算闸门（每轮 ≤3 次 / 单次 ≤5% window / 累计 ≤10% / truncated 标注）——先拿 P2 生产档的 recall 用量数据定必要性再上
3. askCover 动态复核回归用例（P0-3 失败模式：跨轮引用到达 → 豁免失效）

**退出判据**：降级链四态各有单测/重放用例；recall 闸门（若上）有实测用量依据登记台账。

## P4. 声明式生产挂载（迁移本体）

1. cordis-plugin-include + patches overlay（记：include patches 是顶层字段浅替换）
2. build 产物 + 作为 dsh 插件被声明式加载（非 spike 的 ctx.plugin 手工挂载）
3. WebUI 真会话验证：Models 页接本地模型，真实对话里触发剪枝/recall 全流程

**退出判据**：`dsh` 命令声明式加载 ARGP 插件跑通一个真会话，事件流含完整事务括号。

## P5. 证据补充与发文

1. ✅ 同压力档基线重跑（B-4 已修：显式挂 TokenMeter）——2026-08-17 已完成：50/50 轮、117 compaction / 85 error、U 0/7、R 0/7（产物 `spike/out/07-baseline-deepseek-2026-08-17T01-55-34-648Z/`，记录见 experiment-2026-08-16-separated-contract-probe.md 追加）
2. 公开基准 pilot（LongMemEval 子抽样，待拍板）
3. ✅ 卡点向上建议打包（B-1/B-3/B-4）——2026-08-17 已提交 `docs/dsh-api-feedback-2026-08-17.md`，待 dsh 响应
4. 母表更新 + 能力数据速查固化

**纪律**：每个实验跑完当场登记台账（数字必带产物位置）；受控对照期间不中途调参；短实验结论不外推长程。

## 依赖与并行

- P1 → P2（分级/确定性边是闭包排序地基）；P2 → P3（降级链首环）；P3/P4 可并行；P5 依赖 P4 的挂载形态做真实环境证据
- GPU 占用点：P2 回归、P5 基线重跑/公开基准——其余阶段离线可推进
- 排期原则：P1/P2 实现期间不占 GPU，GPU 空闲窗口留给 P5 的长实验
