# 分段前向引用标注实验（spike 30，2026-08-24）

> 目的：不经全流程 agent 循环，快速测"前向引用（cites）机制对保留质量的影响"。
> 方法（用户提出）：取现成多轮对话 → 切 N 段 → 每段 1 次 LLM 调用标注段内最后 1 轮的前向引用 → 收集边集 → 离线重放对比保留集。
> 素材：`spike/out/26-v4-fix50-2026-08-22T12-49-03-413Z/events.jsonl`（50 轮 tlong 真实对话，v4-flash）。

## 方法与成本

| 步骤 | 工具 | 成本 |
|---|---|---|
| 分段标注（50 段 × 1 轮，LLM 27B 吐 cites） | `spike/30-segment-cites.ts`（SEG_MAX=50） | **~1 分钟**（vs 全流程 5-6h） |
| 离线重放（clear / oracle，0-LLM） | `spike/28-simulated-replay.ts`（CLEAN_SURFACE=1，WT22K/RT6K） | 秒级 |

产出：`annotated-cites.json`（62 条边：37 个 assistant 回复 → 60 个 tool result + 2 个 assistant）+ `shadowed-{clear,oracle}.json`。

## 结果

- 重放健康：7 次压缩（79K→22K 等），94 个 tool 墓碑（工具结果确实被剪）。
- **cites 的 62 个引用目标（chunk tool result）在两臂（clear/oracle）全部保留** —— 边没有改变它们的保留。
- **被剪的是 94 个未被引用的工具结果** —— 剪枝正常工作，只是没剪到被引用的。
- 稀疏版（13 条边）与密集版（62 条边）结论一致。

## 解读：为什么 tlong 测不出 cites 价值（任务结构所致）

1. **tlong 的依赖琐碎且局部**：回复"chunk-j.md 412"只依赖刚读的 chunk + 指令——而刚读的 chunk 本就在新近度保护内（cites 引用的都是"安全区"内容）。
2. **有风险的旧 chunk 无人引用**：等 chunk 变老成为剪枝候选时，它的引用回复（低价值的单行回复）早已被剪 → 边随 citing 原子消亡而消失 → 保护窗口永不生效。
3. **cites 价值的前提**：被引内容同时满足 (a) 变老成为候选 + (b) 引用它的原子还活着。真实编码任务满足（计划/决策引用早期内容且自身高价值长寿）；tlong 不满足。

**结论：tlong 任务对 cites 价值是"保守低估"（null 结果 ≠ cites 无用），需要跨轮依赖的真实任务才能测出 cites 是否有价值。**

## 测量教训

`shadowedSeqs` 原始对比会被**区间伪影污染**（被剪 range 内包含非 surface 的 seq：assistant/chunk、turn/end、step/start 等）——P1 必须聚焦**引用目标原子的保留**，不能直接比 shadowed 集合本身。

## 下一步（二选一）

- **A**：构造含真实跨轮依赖的对话（第 N 轮工作依赖第 5 轮的产物，引用原子高价值长寿）→ 分段标注 → 重放 → 测 cites 是否保护"有风险但被引用"的内容。
- **B**：接受 tlong null = "琐碎任务里 cites 是装饰性的"，把 cites 价值测试并进 A₄ 验证（用真实任务）。

方法（分段标注 + 离线重放）已验证可行，是后续 cites 价值测试的快速迭代环。
