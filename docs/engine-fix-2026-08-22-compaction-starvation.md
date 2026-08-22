# 压缩饿死（Compaction Starvation）修复说明

> 日期：2026-08-22 ｜ 状态：待审 ｜ 涉及：`src/argp-graph-engine.ts` + `test/closure-debounce.test.ts`（P2 断言待阶段 2 确认）
> 产物路径：`spike/out/26-v4-fix50-2026-08-22T12-49-03-413Z/`

## 1. 摘要

真实长程跑（`spike/out/26-v4-fix50-2026-08-22T12-49-03-413Z/`，v4-flash 50 轮，100K/80K/16K）暴露：压缩事务触发 25 次，但**每次只剪 2–10 个原子、剪除率 0–2%**，最终 surface ≈74.7K token ≈ **4.7× retain 目标（16K）**——"压缩率可控且可收敛"（设计文档 §引言/§4.6）的核心卖点未兑现。

调查定位到**两层根因**：
1. **直接 bug（已落地，见 §4.1）**：pass 循环候选耗尽时 `tryPruneClosures` 的 `return` 把已累积的 `pruned`（正常候选 + 版本重复）全部丢弃，每次压缩退化为"只剪 1 个闭包"。
2. **结构性缺口（本方案主体）**：即使不丢弃，当前流程也**走不到降级链末端的 force_prune**，剪不到 retain 目标——降级循环"直到达标"（设计承诺）从未真正生效。

## 2. 现象与影响

数据源：`spike/out/26-v4-fix50-2026-08-22T12-49-03-413Z/result.json` + `events.jsonl`（成本换算见 `.tmp/cost-audit.mjs` 口径，v4-flash 闲时价）。

| 项 | 修复前实测 |
|---|---|
| 压缩事务数 | 25 次（`result.json` records.length；每次估算超 80K 触发，机制正常） |
| 每次剪除量 | 2–10 原子（一个闭包），剪除率 0–2%（records[] charsBefore→charsAfter 对比） |
| 最终 surface | 261,584 字符 ≈ 74.7K token ≈ **4.7× retain 16K**（`result.json` surfaceCharsEnd） |
| 命中率/成本 | miss 4.93M token（¥7.39）+ hit 1.75M（¥0.09）+ out 44K（¥0.20）= **¥7.68 闲时**，命中率 26.2%（`events.jsonl` usage 汇总） |

**影响**：频繁触发但剪不动 → 上下文持续高位 → 命中率被压缩次数拖低 → 成本口径失真；"任意控制压缩率"卖点（设计文档：*"压缩率可控且可收敛：…降级循环直到达标"*、*"summarize 达上限 N 仍不达标 → force-prune（剪到达标为止）"*）不成立。

## 3. 证据链（调查过程，零/低成本验证）

| 步骤 | 方法 | 结论 |
|---|---|---|
| 3.1 假设①"入度 0 ≈ 最新原子 → 双重保护死循环" | `spike/27f-indegree-stats.ts` 重放统计入度分布 | ❌ 否决：入度 0 占 90.8%（198/218）**遍布全程**（前半段 91 个），候选原子 194 个不空 |
| 3.2 假设②"R 的组内确定性边卡死候选" | `spike/27g-group-candidates.ts` 剔除组内边对比 | ❌ 否决：剔除前后候选组 30 = 30（只放行 2 组） |
| 3.3 引擎真实逻辑重放（对齐参数） | `spike/27h-replay-first-compact.ts` 截断到第一次压缩前调 compactIfNeeded | ✅ 复现 record `candidates=0 prunedAtoms=2` 与真实完全一致 |
| 3.4 引擎临时诊断（src 加 console.log，跑完已回滚） | softCandidates 统计 + pass 循环内 | **关键反转**：`softCandidates=30`（非 0！）；pass 0→30 正常剪 30 组 + 版本重复 26 = **pruned 56**；pass 30 候选空 → 闭包路径 |
| 3.5 读 tryPruneClosures 调用点 | `src/argp-graph-engine.ts:1588-1591`（修复前） | **根因坐实**：`return closureResult` 直接返回，56 个已剪原子全部作废，record 只记闭包剪的 2 个（`candidates/semanticEdges` 为闭包路径硬编码占位 0，见 :1347） |

## 4. 根因分析

### 4.1 直接 bug：闭包 return 丢弃 pruned（**已落地**）

```ts
// 修复前（:1588-1591）
if (candidateGroups.length === 0) {
  const closureResult = this.tryPruneClosures(...)
  if (closureResult !== null) return closureResult   // ← pruned（正常候选+版本重复）全丢弃
  ...
}
```

每次压缩实际执行链：正常候选剪 30 组（进 pruned）→ 版本重复 26 个（进 pruned）→ 候选空 → 闭包 return（**丢弃 pruned 56 个**）→ 只剪 1 个闭包（2–10 原子）。**每次压缩 96% 的剪枝成果被作废**。

**已落地修复**（commit `cc58960`，`src/argp-graph-engine.ts:1589-1606` 区域，带 2026-08-22 注释）：
- `degradationStrategy === 'fail'` → `return null`（**保持设计语义**，见 §4.3）；
- 否则 `pruned.size > 0` → `break`（先剪累积成果，不再被闭包 return 吞掉）；
- 闭包生命周期降级为"pruned 为空时的纯兜底"。

`spike/27h` 验证：单次压缩从 2 原子/0.06% → **56 原子/59%**。

### 4.2 结构性缺口：降级链被短路，到不了 force_prune

- 原实现：闭包 `return` 永远先于 force（force 在 :1597-1599 但不可达）；
- §4.1 的落地修复（break）：剪完正常候选就停（59% 未达标）。

两条路径都**从未真正执行 force_prune（剪到达标为止）**，违反设计承诺"降级循环直到达标"（设计文档 :145/:191）。

### 4.3 设计对齐声明（回应"生命周期优先"的误读）

设计文档 **:91 明确规定了剪除顺序**：

> "剪除顺序：先原子级正常剪（不变量 3）→ **候选耗尽时按闭包 DAG 叶序剪 COMPLETED 闭包** → 全部剪完仍不达标才落 summarize-critical"

设计降级链（:37/:139/:91）：**常规剪 → 闭包（叶序，0-LLM）→ summarize-critical（默认关）→ force_prune → fail**。本方案顺序与之**完全一致**——"闭包 0-LLM 整体剪除"（:37/:189）是闭包的成本特性（0 LLM 调用），不是优先级；优先级在 :91 已明确为"正常剪在前、闭包在候选耗尽后"。

**fail 语义（:110）**："单原子超窗/资源用尽，报警并终止"——fail = 全有或全无（`return null` 连同已累积 pruned 一起放弃，配置者显式选择"不降级也不产出"）。本方案**不改 fail 语义**，测试 `chain-unlock.test.ts:98` 断言保持不变。

## 5. 修复设计（本方案主体）

### 5.1 目标

一次压缩按设计降级链（:91/:139）推进，直到 `visible ≤ retainChars`（达标）或降级链全空（无物可剪）：

```
阶段 1  正常候选剪（入度 0，含版本重复）          → pruned 累积（不丢弃）✅ 已落地
阶段 2  候选空且未达标 → 闭包生命周期并入 pruned  → 含 root U 退休，排除已剪原子（本方案）
阶段 3  闭包空且未达标 → summarize-critical       → 默认关（P3 末环，保持原独立事务语义）
阶段 4  仍未达标 → force_prune（忽略入度）         → 继续剪到 retain 或耗尽（本方案打通）
阶段 5  统一一次事务剪全部 pruned（正常+版本+闭包+force，闭包区间带专属 tombstone）
```

> 注：阶段 2/4 是本方案新增/打通的部分；阶段 1 已落地（§4.1）；阶段 3 保持现有独立事务（替换式摘要，与剪枝不同质）。

### 5.2 代码级改动（`compactIfNeeded` + `tryPruneClosures`）

**改动 1：`tryPruneClosures` 拆分选择/执行**

新增纯选择方法（复用现 `:1240-1321` 选择逻辑）：
```ts
private selectClosureToMerge(
  session, atoms, edges, inDegree, askCover, latestTurn,
  alreadyPruned: Set<number>,   // 新增：排除已剪原子（避免重复剪）
): {
  closureId: string
  root: Atom
  seqs: number[]                 // 闭包原子 seq 列表
  atoms: Atom[]                  // ← 补：闭包原子对象列表（与 seqs 一一对应，供并入 pruned）
  rootPreview: string
} | null
```
- 闭包原子计算时过滤 `alreadyPruned`（如 A1/A2 已正常剪 → 闭包仅剩 U1）；
- `tryPruneClosures` 保留原签名供 `compactNow`/手动路径（或改为薄包装调用 select）。

**改动 2：pass 循环降级链（`:1588-1606` 重写）**

```ts
if (candidateGroups.length === 0) {
  if (this.degradationStrategy === 'fail') return null        // fail：全有或全无（设计 :110，已落地）
  if (pruned.size > 0) break                                  // 先剪累积成果（已落地）
  // ① 闭包生命周期（lifecycle，默认）：选择并入，不 return 丢弃
  const closure = this.selectClosureToMerge(session, atoms, edges, inDegree, askCoverage, latestTurn, new Set(pruned.keys()))
  if (closure !== null) {
    for (const a of closure.atoms) pruned.set(a.id, a)        // 并入（via='closure'）
    this.closurePrunes.push({ closureId, rootSeq: closure.root.seq, prunedSeqs: closure.seqs, at })  // P2 防抖依赖
    continue                                                  // 下一 pass 重推后继续（逐步退休所有可剪闭包）
  }
  // ② summarize（默认关，保持独立事务）
  if (this.degradationStrategy === 'summarize' && this.enableSummarize) { ... 原逻辑 return }
  // ③ force_prune（忽略入度，剪到达标为止）——设计 :139 兜底序列末环
  candidateGroups = liveGroups.filter(g => isGroupCandidate(g, true))
  if (candidateGroups.length === 0) break
  forced = true
}
```

**改动 3：intervals 构建带归属标记（`:1613-1629`）**

- `pruned` 改为 `Map<number, { atom: Atom; via: 'version' | 'normal' | 'closure' | 'force' }>`；
- intervals 归并后，**区间 tombstone 按归属**：区间原子全部来自同一闭包 → 闭包 tombstone（`[elided closure <id> seqs=N..M ... root=...]`，保持 P3/P6 recall 语义）；混合/其他 → 默认 tombstone；
- `prunedNodeIndex` 登记沿用现有逻辑（统一用 eff map，替代闭包路径的 selfImportance 近似，一致性提升）。

**改动 4：`pruneIntervals` 调用**（`:1655`）传合并后的 kept + tombstoneTexts（按区间归属生成）。

### 5.3 行为变更（预期）

| 场景 | 修复前 | 修复后 |
|---|---|---|
| 正常候选充足（26-v4-fix50 首压） | 剪 2 原子/0.06%（丢弃 56） | 剪 56+ 原子，降级链补剪到 retain 或耗尽 |
| 闭包可剪（P2） | 只剪闭包（含 U） | 正常候选优先剪 + **闭包补剪（含 root U 仍退休）** |
| **闭包只剩裸 root U**（A1/A2 已正常剪） | — | **有意为之**：闭包退休含 root U（P5 注释"自动闭包生命周期确实会连 root U 一起剪除"），即使只剩裸 U 也退休（任务锚点清理）；不加"剩余原子数下限" |
| force 触发 | 几乎不触发（被闭包 return 短路） | 正常执行（候选+闭包+summarize 空时，忽略入度剪弱组到 retain） |
| fail strategy | 候选空 → null 无事务 | **不变**（保持 :110 设计语义，`return null` 全有或全无） |

## 6. 测试影响（10 测试文件 / 72 用例，`npm test` 实测）

| 测试 | 当前状态（§4.1 落地后） | 完整修复后预期 |
|---|---|---|
| `chain-unlock.test.ts:98`（fail strategy） | ✅ 恢复通过（fail 保持设计语义，return null） | 不变 |
| `closure-debounce.test.ts:64`（P2 write-side） | ❌ 红（正常候选优先剪，U1 未退休） | ✅ 阶段 2 闭包并入后恢复（record 含 u1/a1/a2；closurePrunes[0].rootSeq=u1）——实现后跑测确认 |
| 其余 70 用例 | ✅ 通过 | 预期不受影响（force 排序 eff 升保护被引用原子；fresh/newTurn/citesFailed/A10/U 覆盖门槛在 force 下仍生效）——实现后全量确认 |

## 7. 验证计划（先零成本，后真实）

1. **`spike/27h` 重放（0 成本）**：完整修复后单次压缩应 `visible ≤ retainChars`（或降级链耗尽），record 带真实 candidates/semanticEdges；对照 `26-v4-fix50` 首压从 2 原子 → 全量（含闭包+force 段）。
2. **`npm test` 全量**：10 测试文件 72 用例（预期 43 恢复后全绿）。
3. **typecheck + build**：lib 同步。
4. **（后续）真实短跑确认**：v4-flash 完整 50 轮重跑（¥7-8），确认压缩次数下降、每轮压缩率达标、命中率回升。

## 8. 风险与回退

- **force 执行面扩大**：force 从"几乎不执行"变"候选+闭包+summarize 空时执行"——剪除量增大。force 排序（eff 升→lastRef 升→seq 升）+ 非入度门槛（fresh/newTurn/citesFailed/A10/U 覆盖）保留，被引用关键内容 eff 高、最后剪；风险中低。若实测 recall 负担上升，可调 `maxPasses` 或 retain 比例。
- **闭包合并的 tombstone 语义**：混合区间（闭包+正常原子）用默认 tombstone，recall 时闭包 root 信息缺失——可接受（P3 消歧是优化非硬约束），后续可细化。
- **回退**：`git revert` 单一提交即可（改动集中在 compactIfNeeded + tryPruneClosures + 测试）。

## 9. 附：本次 review 已落实事项

- §4.1 状态更新：修复已落地工作区（:1589-1606，带注释），commit hash 待完整修复提交后回填；
- §2 台账：全部数字已补产物路径（`spike/out/26-v4-fix50-2026-08-22T12-49-03-413Z/`）；
- §4.3 设计对齐声明：降级链顺序与设计 :91/:139 一致（含引用原文），fail 语义保持 :110；
- §5.2 伪代码补 `atoms` 返回字段；
- §5.3 明确裸 root U 退休为有意设计；
- §7 用例数更正为"10 测试文件 72 用例"；
- 原 `:1632` 的 `prune decision` 运行日志已删除（连带清理 `visibleNow` 死变量），引擎不再输出该诊断行。
