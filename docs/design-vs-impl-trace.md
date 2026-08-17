# 设计 ↔ 实现追踪表（argp-dsh）

> 生成：2026-08-17。用途：接手者快速判断"设计文档声明的机制在代码里以什么形态落地"。
> 方法：对照 `docs/ARGP-design-v1.0.md`（§5 机制章节）与 `src/argp-graph-engine.ts`（1085 行，dsh 版主引擎）逐项定位。
> 状态图例：✅ 完整实现 ｜ 🟡 简化/适配实现（有差异，见备注）｜ ⬜ 未实现（含有意降级）
> ⚠️ 本表是代码注释"差异记入台账"的落点——此前无独立台账，差异散落在文件头注释里（且注释已部分过时）。

## 1. 追踪总表

| 设计机制 | 设计章节 | 代码锚点 | 状态 | 备注 |
|---|---|---|---|---|
| 原子模型 U/A/T/R | §5.1 | `Atom` (L28-37)、`atomize` (~L440-470) | 🟡 | **无独立 T 类型**：dsh surface 无 tool/call 节点，call 块内嵌在 A 里；实际类型 U/A/R/X（X=compact tombstone/checkpoint） |
| 编号全局递增/被剪保留 | §5.1 | `id: number // 本次投影内局部递增` | 🟡 | 投影内局部编号（非全局持久编号），seq 为事件级稳定锚点 |
| 确定性边 A→T、T↔R | §5.1 | `buildGraph` deterministicEdges (L480-489) | ✅ | 按 toolCallId 配对生成 A→R（无 T 节点，直接 A→R） |
| 语义边（LLM 声明分级） | §5.2 | `buildGraph` cites 匹配 (L490-506) | 🟡 | **不是 LLM 声明 refs JSON**：cites 前缀子串匹配（消融 E6 形态），**一律 supporting 级**，critical/contextual 从不生成；AMBIG→最早命中+U 优先 |
| 引用分级四级+权重 | §5.2 | `EdgeLevel`/`EDGE_WEIGHTS`/`LEVEL_ORDER` (L39-43) | 🟡 | 类型与权重表移植，但建边只用 supporting → 排序实际退化为 isolated/supporting 两档 |
| 不变量 1 effective_importance | §5.3 | `eff` (L767-769) | 🟡 | 公式一致（max(自评, 入边权重)），但自评是类型默认值（A=5/U=3/R=0），**非 LLM 声明的 importance** |
| 不变量 2 critical 闭包守恒 | §5.3 | — | ⬜ | 无 critical 边生成 → 闭包守恒退化为闭包级整体剪（tryPruneClosures 的 in_degree==0 检查承担） |
| 不变量 3 反向拓扑剪枝 | §5.4 | `isAtomCandidate` (L814-833)、pass 循环 (L849-871) | 🟡 | **⚠️ 入度是静态的**（buildGraph 一次算完），剪除引用方不会解锁被引用方（设计说剪后出边消失→新候选）；多 pass 只重扫同入度==0 组。保守行为，需确认是有意简化还是缺口 |
| 剪枝排序键 | §5.4 | `sortKey` (L836-838) | 🟡 | 等级→eff→lastRef→seq 一致，但等级仅 isolated/supporting 两档 |
| 新鲜度保护 | §5.4/§5.8 | `recencyGuard` (L765, 默认 4) | 🟡 | surface 末尾 N 节点不参剪（替代设计的"最近 1 轮 A/R"） |
| lastRefRound 时间降级 | §5.8 | `lastRef` (L770-774) | ✅ | 建边时 O(E) 算一次，剪枝只读 |
| askCover 检测 | §5.7 | `askCoverage` (L777-788) | 🟡 | **启发式简化版**：文本启发（`?`/ask/what）+ 首个 A 有 supporting 边 + 动态复核入边全来自 coverer；非设计的形式化判定式（入边集合 ⊆ {A_{i+1}}） |
| 降级链 lifecycle/summarize/force/fail | §5.9 | `degradationStrategy` (L60)、候选耗尽分支 (L855-866) | 🟡 | 配置与分支齐全；**summarize 默认关且为 stub**（L615-623 返回 null）；lifecycle→force 是实际路径 |
| recall 工具+预算 | §5.10 | `recall_pruned` (L192-215)、`budgetRecallText` (L602-613) | ✅ | 每轮 ≤3 次、单次 ≤5% window、累计 ≤10% window、truncated 标注 |
| list_pruned 剪枝目录 | §5.10 配套 | `list_pruned` (L217-261)、`prunedNodeIndex` (L165) | ✅ | P1.4 catalog 规则移植；preview 含完整首行 marker（已知：模型可能抄 preview 绕过 recall） |
| 闭包生命周期 | §5.11 | `tryPruneClosures` (L626-733) | 🟡 | 根锚=U∧¬askCover、seq 窗口初界、K=2 静止、叶序 lastRef 升序、latestU 守卫、recall 回拉防抖（L592-600）均实现；**⚠️ 无"弱连通收紧/孤岛入游离池"**——直接用 seq 窗口切分 |
| 闭包处置策略 memory/tips/tombstone | §5.12 | — | ⬜ | 只做 tombstone（X 原子占位 + prunedNodeIndex）；memory/tips 按 roadmap 推后 |
| R 版本链 diff 去重 | §5.13 | `findVersionDuplicates` (L527-579) | 🟡 | **简化版**：A 文本全等 / R 按 issuer A 文本全等分组去重（in_degree==0 才剔、A/R 成对）；**非设计的 overlapCoefficient/sim≥0.8 部分重叠归链** |
| 配对自保（A+R 成组同剪） | 迁移稿/实测 | `groups` (L792-813) | ✅ | 防孤儿 toolCall/result → API 400 |
| 头脑风暴模式 | §5.5 | — | ⬜ | 未实现（roadmap 未排入 P1-P5） |
| summarize-critical 摘要原子 | §5.9 | `summarizeCriticalChain` (L615-623) | ⬜ | stub，默认关（本地单 slot 模型下破坏 KV cache） |
| auto_backfill 残留回填 | §5.10 | — | ⬜ | 按 roadmap 不实现（默认 off） |
| 微剪枝下限 | 实测（spike 4） | `minSpanChars` (L49, 默认 512) | ✅ | 区间可见量 < 512 放回不剪 |
| maxPasses 参数化 | 实测 | `maxPasses` (L52, 默认 16) | ✅ | 生产档 256 |
| 预算估算 | 实测 | `charsPerToken`=3.5、`measureTokens` (L520-525) | 🟡 | 默认字符估算退化；tokenMeter 显式传入才精确；reasoning 块不计入 |

## 2. 已确认的偏差

1. **静态入度 + 无剪后解锁 → 已修复（2026-08-17）**：设计 §5.4"剪除后其出边消失，指向的原子入边减少，可能成为新候选"。原实现 inDegree 由 buildGraph 一次算完，pass 循环不更新。`spike/17-chain-unlock-probe.ts` 四臂实证后修复：
   - **修复方案**：每 pass 从"未被剪原子的边"重推动态有效入度（`curInDegree`，src/argp-graph-engine.ts compactIfNeeded）；被剪引用方的出边不再计入 → 目标入度递减
   - **多引用正确性**（用户约束：B 可能有 A/C/D 多个引用）：有效入度 = 仍存活的引用方数，B 须等全部引用方被剪才解锁；重复 cites 按边数逐条减；force 剪与版本预剪同样纳入（下一 pass 重推自然覆盖）
   - **回归测试**：`test/chain-unlock.test.ts` 3 用例（单引用链解锁 / 多引用全剪解锁 / 保留引用方不解锁），全量 27 测试绿
   - **口径影响**：forced 触发大幅减少（本应软剪的原子不再被标 force）；既往实验（spike 6/8）forced 数据对比需标注此变更
2. **语义边只有 supporting 级**（§5.2 vs L490-506）：cites 匹配一律 supporting。EDGE_WEIGHTS 的 critical/contextual 与不变量 2 在 dsh 版实际不生效。若后续要 critical 语义，需在 cites 契约里加 level 或独立通道。
3. **版本链去重是"全等"不是"相似"**（§5.13 vs L527-579）：设计 θ=0.8 行级重叠归链；实现只去完全相同的 A 文本/同 issuer 的 R。高重叠但非全等（如 read→edit→read）不会被合并。
4. **闭包无弱连通收紧**（§5.11 vs L638-651）：孤岛原子直接随窗口归属闭包，无"游离池"概念；跨闭包借用边只按语义边统计。

## 3. 设计稿未覆盖的提案（2026-08-17，用户提出，spike 18 离线模拟已验证）

> 两个候选机制均未写入 ARGP-design-v1.0.md。`spike/18-density-sim.ts` 离线模拟（复刻引擎剪枝决策：建边/eff/版本链/成组/pass 循环，排序键可配置）已量化增益，结论如下——是否采纳进代码待用户拍板。

1. **单位 token 重要性（预算密度排序）**：设计 §5.4 排序键为 `[edgeLevel, eff, lastRef, seq]`（绝对 eff 升序），忽略原子体积。但压缩本质是"retain 预算内保留最大信息"——该问题的标准贪心解是按 **eff/tokens** 降序剪（分数背包）。盲点：10K token 的工具结果被引用后 eff 提升，链式解锁后仍排在小原子后面，剪它一次减 10K vs 剪 100 个 100 token 原子——预算削减效率差一个数量级。落地方案（模拟采用"分级"）：
   - 纯密度 `eff/tokens`：数学最优，但 eff 绝对值语义被稀释（10K 的 eff=5 会排在 100 的 eff=1 前面）
   - 分级（模拟采用）：eff 同档内插 tokens **降序**（大 token 先剪），保守可控
   - 折中 `eff/log(tokens)`：惩罚递减
   - 硬约束：edgeLevel 仍是第一键（设计 L77"等级比绝对值稳定"）；U 原子保护（isAtomCandidate L830-836）与墓碑不受影响
   - 诚实限定：eff 只有 5 档粗粒度，增益被粗糙度封顶——预期是"剪枝效率"（同预算少剪原子/pass），非信息保留质变
   - **spike 18 实证**（同档内大小悬殊场景）：B 配置 2 原子达标 vs A 现状 9 原子（效率 4.5×），保留 eff 48 vs 13（3.7×）；均匀场景无差异（合理）；组合场景少剪 1 原子 +5 eff。**⚠️ 排序方向坑**：tokens 需降序（负数入键），升序会先剪小原子反噬

2. **版本链存活代表的重要性叠加**：当前 `findVersionDuplicates`（L548-577）按文本全等去重，older 被预剪、newer 存活，但 **链长（count）未保留**，且存活代表若本身入度 0 会在后续 pass 被当普通原子剪掉 → 整条链信息从 surface 消失（只能 recall 找回）。提案：给版本链记账（`Map<string, {atom, count}>`），存活代表的 eff 叠加 `(count-1)×w`（模拟 w=1）。约束：
   - 叠加只提升 eff 层（edgeLevel 内 tie-break），不跨等级——与密度排序正交可组合
   - 与密度排序有张力：链代表若是 10K 大 R，叠加后仍按密度排——叠加量需防"被密度淹没"也防"大 token 永不剪"，离线模拟调参
   - **spike 18 实证**：C 配置（叠加）在场景 2/3 稳定比 B 多保留 +2 eff（链长 3 → (3−1)×1），链代表存活率提升

## 4. 过时注释/文档（需清理）

- `src/argp-graph-engine.ts` L5 文件头注释"无版本链去重（§4.4）"——**过时**：findVersionDuplicates 已实现（P1.4 提交 29f5ea2），注释未更新。
- `docs/dsh-roadmap.md` §P5.1 基线重跑"待做"——**过时**：2026-08-17 已重跑完成（spike/out/07-baseline-deepseek-2026-08-17T01-55-34-648Z）。
- 文件头注释自称"差异记入台账"——台账此前不存在，即本表。

## 5. 状态小结

- 完整实现：确定性边 / lastRefRound / recall+预算 / list_pruned / 配对自保 / 微剪枝下限 / maxPasses
- 简化实现（有意适配）：原子类型（无 T）、cites 建边（仅 supporting）、askCover 启发式、降级链（summarize 关）、版本去重（全等）、闭包分区（无游离池）
- 未实现（有意降级/未排期）：头脑风暴模式、summarize-critical、closureDisposition（memory/tips）、auto_backfill
- 已确认缺口 → **已修复**：静态入度不递减（§5.4 反向拓扑链式解锁缺失，见 §2-1，2026-08-17）
- **提案已验证（spike 18 离线模拟）**：单位 token 重要性（密度排序）同档大原子先剪效率 4.5×/eff 3.7×；版本链存活代表 eff 叠加 +2 eff（见 §3，采纳与否待拍板）
