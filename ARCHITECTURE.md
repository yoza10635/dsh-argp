# ARCHITECTURE — dsh-argp 实现说明

> 本文档讲**怎么实现的**。能干什么、凭什么选它见 [README.md](README.md)。
> 读者：想读懂/二次开发本插件的人，不需要读完整设计史。

## 1. 一句话架构

ARGP 把对话历史拆成**原子**（U/A/T/R 四类事件），LLM 每轮声明**引用边**建出依赖图，压缩时按"孤立→contextual→supporting→critical"的**反向拓扑序**纯算法摘除被剪节点——**压缩决策阶段 0 LLM 调用**。被剪内容不销毁，走 recall 从 append-only 日志找回。

```
对话事件流（append-only 日志）
      │
      ▼
┌─────────────────────────────────────────────┐
│ Stage-1  per-atom 管线（turn 尾，eager）      │
│  gate(门控) → split(拆分) → compressor(熵降) │
│        + cite-declarer(引用边声明)            │
└─────────────────────────────────────────────┘
      │ 压缩副本落 surface + 引用边入图
      ▼
┌─────────────────────────────────────────────┐
│ Stage-2  图引擎（窗口将满时，lazy）            │
│  buildGraph → 反向拓扑序 pruneIntervals       │
│  → 逐区间成对发射（shadowedRange + replace）  │
└─────────────────────────────────────────────┘
      │
      ▼
  recall（两级 zoom：summary 档 / detail 档 verbatim）
```

双引擎的分工：**Stage-1 是有损压缩**（熵降，LLM 参与，信息保底可恢复）；**Stage-2 是删除**（剪枝，0-LLM 确定性，被删内容靠 recall 兜底）。

## 2. 事件原子化与引用边

| 原子类型 | 含义 | 来源 |
|---|---|---|
| **U** | user 输入 | 原生 user 事件 |
| **A** | assistant 回复 | 原生 assistant 事件 |
| **T** | tool call | 原生 tool 事件 |
| **R** | tool result | 原生 toolResult 事件 |

**引用边（cites）**：模型每轮回复尾部可携带 `{"cites":[seq,...]}` 尾块，声明"本轮引用了哪些历史节点"。引擎侧 `cites-strip.ts` 剥离尾块（纯函数，服务端/客户端共用同一逻辑），解析出的边入图。

**边的两种来源**（可共存，不能同时归零）：
- **回复级 cites**：`argp-cites` PromptSection（order 151）驱动模型在回复里声明——默认 `auto`，declarer 管线武装时自动关闭（避免双保险）；
- **结构化 declarer**：`cite-declarer` 管线在 turn 尾单独调 LLM 声明边，不污染主回复（消灭 UI 显示泄漏）。

**T→R 确定性边**：tool call 与它的 result 之间无需模型声明，引擎自动连边（`toolPairingBalancedBefore/After`）。

## 3. 反向拓扑剪枝（Stage-2 核心）

```
inDegree 计算（每 pass 重推）
   │
   ▼
按 孤立(inDeg=0) → contextual → supporting → critical 分层
   │
   ▼
逐层摘除：摘一个 pass 后**重推 inDegree**——
多引用的节点须**所有**引用方都被剪后才解锁
   │
   ▼
pruneIntervals 逐区间成对发射（见 §5 shadow-price 契约）
```

关键不变式：
- **inDegree 每 pass 重推**（不是剪完一次就算）：A 被 B、C 两节点引用，必须 B、C 都被剪，A 才解锁。
- **0 LLM 调用**：整个剪枝循环是纯图算法，LLM 只在边声明阶段（Stage-1）参与。

## 4. 双引擎生产挂载

`peratom/mount.ts` 的 `mountPeratomStack` 是声明式入口：把三条 Stage-1 管线 + Stage-2 图引擎组装成一个 compaction 插件，挂在宿主 `ctx.compaction` 位。

```
ctx.compaction === ArgpGraphEngine（peratom 已武装）
   ├─ compressor  — turn 尾 eager 熵降（Stage-1 P1）
   ├─ declarer    — turn 尾引用边声明（Stage-1 P2）
   └─ zoom        — 两级 recall 工具（Stage-1 P3）
```

组件 config 传 `llm: { provider, model }` 走宿主 dsh-llm（生产形态）；不传则按各组件 fetch 环境变量解析（本地实验形态，缺失自然 disabled，零网络）。`peratom: false` 关闭整条 Stage-1 管线，只剩 Stage-2 图引擎。

## 5. shadow-price 契约（与宿主的硬约束）

宿主 `token-meter/surface-projection.ts foldSurfaceProjection` 要求：**每次 prune/summary 的 `shadowedRange` 必须与紧随其后的 surface `replace` 范围严格相等**，否则 resume 投影 throw。

实现口径：
- `pruneIntervals` **逐区间成对发射**（对齐官方 `compaction-tool-result-pruner`），不是一口气发射所有区间；
- `shadowedSeqsOf` 只收 `op==='replace'` 且**无 `argpCites` 字段**的 replace——cites 剥离写回（单点 replace + `data.argpCites`）不算"被剪节点"，误收会让 catalog 谎报压缩 → system 前缀每轮变 → 跨轮缓存全断（commit `6d252cf` 修）。

**固有权衡**：任何压缩都会丢一次 KV 缓存（摘要式同样），属设计接受的成本，非缺陷。

## 6. sessionEvents 双宿主兼容

ARGP 需要读会话事件日志，但宿主 API 在 dsh 版本间有 breaking 变化：

| 宿主版本 | 事件日志 API |
|---|---|
| rc.2（0.1.1） | `session.events`（getter，返回全日志数组） |
| alpha.4（0.1.2+） | `session.snapshotEvents(from?, toExcl?)`（`events` getter 已移除） |

`log-access.ts` 的 `sessionEvents(session)` 是**全代码库唯一允许碰事件日志的入口**：运行时探测 `snapshotEvents`（modern）/ 回退 `events`（legacy），两者皆无则 throw。所有 `.length` 读取改用 `session.seq`（branded 类型，seq/offset 分离）。

## 7. recall 两级 zoom

被剪/被压内容不销毁，从 append-only 日志找回：

| 工具 | 档位 | 数据源 | 成本 |
|---|---|---|---|
| `recall_summary(seq)` | gist（"这内容关于什么"） | 优先存储 summary → 降级压缩副本 → 降级原文 | 便宜（预算 4×） |
| `recall_detail(seq)` | exact（"确切字符串"） | append-only 日志 verbatim 原文 | 贵（预算 1×） |

程序化入口：`recallAnyState()` / `nodeState()`（不受工具门控）。引擎侧 `recall(seq)` 是窄接口，**仅**命中被剪节点（pruned-only 语义，给宿主/测试探针用）。

## 8. 模块职责表

| 文件 | 职责 | 依赖 |
|---|---|---|
| `argp-graph-engine.ts` | Stage-2 图引擎：建图 + 反向拓扑剪枝 + cites 义务 | log-access, peratom/* |
| `argp-t1-engine.ts` | 早期机制验证引擎（16K 窗口），历史保留 | — |
| `probe-engine.ts` | 最小探针引擎（验证挂载/生命周期，不剪枝） | — |
| `recall-engine.ts` | recall 工具 + argp-contract PromptSection | log-access |
| `log-access.ts` | 事件日志唯一入口（sessionEvents）+ 日志级访问原语 | dsh-session |
| `cites-strip.ts` | cites 尾块匹配/剥离（纯函数，零依赖） | — |
| `peratom/types.ts` | Stage-1 共享类型与常量（叶子模块） | — |
| `peratom/gate.ts` | 门控判定（纯函数，0 LLM/0 Session） | — |
| `peratom/split.ts` | 拆分解析与策略（纯函数） | — |
| `peratom/compressor.ts` | Stage-1 eager 熵降管线 | gate, split, llm-adapter |
| `peratom/cite-declarer.ts` | Stage-1 引用边声明管线 | gate, llm-adapter |
| `peratom/recall-zoom.ts` | Stage-1 两级 recall 工具 | log-access |
| `peratom/llm-adapter.ts` | LLM 调用后端（dsh-llm 生产 / fetch 本地） | dsh-llm |
| `peratom/mount.ts` | 双引擎声明式挂载工厂 | 以上全部 |
| `client/index.ts` | 客户端：隐藏 cites 尾块（chat 渲染） | cites-strip |
| `index.ts` | 公共导出 | — |

## 9. 关键不变式清单

1. **压缩阶段 0 LLM**：剪枝循环纯图算法。
2. **append-only**：原始事件永不改写，只加新事件；被剪 = surface 上不可见 + shadowedRange 标记。
3. **inDegree 每 pass 重推**：多引用须全部引用方被剪才解锁。
4. **shadowedRange === surface replace 范围**（逐区间成对）。
5. **cites 剥离写回 ≠ 被剪节点**（不收进 shadowedSeqs）。
6. **sessionEvents 是唯一事件日志入口**：不直接碰 `session.events` / `session.snapshotEvents`。
7. **lib/ 与 src/ 字节一致**：CI 强制 `git diff --exit-code lib/`，改 src 必须 build 提交 lib。
