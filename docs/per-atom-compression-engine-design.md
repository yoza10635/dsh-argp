# 逐原子压缩引擎设计（A 轨提案，未批准）

> 状态：**提案**（2026-08-24 讨论产出，待批准后登记台账）
> 定位：完整压缩引擎 = **Stage-1 逐原子熵降（eager，turn 尾，LLM 参与，cites 搭便车）** + **Stage-2 组图剪枝（lazy，上下文上限时，剪枝 0-LLM 确定性）**
> 与现役 ARGP 的关系：Stage-2 复用 `ArgpGraphEngine` 的**剪枝**（0-LLM 确定性）；**组图 = Stage-1 搭便车增量构建**（主方案，§7），C 版本全局组图为备选。Stage-1 是新增前置层。**剪枝 = 删除（信息丢失）；熵降 = 有损压缩（信息保底、可升级恢复）**。

## 0. 动机与目标

- **会话长度与上下文增长解耦**：tool 结果是上下文绝对大头（tlong 实测 ~97%，真实编码 agent 保守 80%+），逐原子压 tool → 上下文膨胀大幅延缓 → 5-10× 轮数。
- **缓存保持**：tail-only replace 使前缀 token 序列不变 → 跨轮缓存累积保持（见 §3）。
- **小窗口可行**：surface 常驻小 → 可用 32K 而非 160K 窗口，服务器成本降一个量级。
- **信息可达性不丢**：两级 recall（§5）保证任何被压内容可升级恢复 verbatim（天花板）。

## 1. 原子分类与压缩策略

| 原子 | 处理 | 说明 |
|---|---|---|
| User（≤100 字符） | 原样保留（dialog） | 指令/简单对话，不压 |
| User（>100 字符） | LLM 拆分 **info/dialog** | dialog 原样（指令必须幸存）；info 标记可压缩 |
| Tool | `need_compress = false/summary/extract` | 门控见 §2；LLM 只做动作 |
| Tool（**版本链成员**） | **强制 `false`** | 版本链哈希/去重依赖 verbatim，绝不压缩 |
| Assistant | 不压缩 | 体积小 + 是后续轮次的工作内容（计划/决策），压缩破坏对话流；C 版本下无逐轮 cites，剥块逻辑仅作兼容保留 |

**为什么 assistant 不压**：①模型回复通常小，压缩省不了多少；②assistant 内容是后续轮次的工作对象（计划/决策/结论），有损压缩会破坏对话流的连续性；③C 版本组图下无逐轮 cites，不存在"压 A 毁 cites"的问题，但也不值得为微小收益付出有损代价。

**info/dialog 拆分的原子模型（2026-08-24 定，与 dsh 原生分类对齐）**：拆分仍产**两类语义不同的原子**，但**不发明新事件类型**——全部落在 dsh 原生事件上，用 ARGP 前缀 flag 区分子类（与现有 U/X 靠 `data.source.kind` 区分的模式同构）：

| dsh 原生事件 | 剪枝分类 | 语义 | 剪枝待遇 |
|---|---|---|---|
| `user/message`（无 flag） | U | dialog（指令） | 永不剪 |
| `user/message`（`argp.info=true`） | U-info | info（参考资料） | **可压缩、可剪**、低权重 |
| `assistant/message` | A | 模型回复 | 不压缩、图节点 |
| `tool/result` | R | 工具结果 | need_compress 门控，可剪（版本链除外） |
| `tool/call` | — | 不进 surface，无独立原子 | 与 A 配对 |

- **归属**：两条原子共享 `turn = 原轮` + `sourceSeq = 原始 User 消息 seq`；原始 User 消息全文留 append-only 日志（= recall_detail 的目标）。
- **引擎改动（唯一）**：`isAtomCandidate` 对 `user/message + argp.info=true` 放行（按 R 待遇可剪），其余 U 保持永不剪。
- **自然边**：拆分调用顺带产出 `dialog → info` 边（指令依赖所贴内容）——info 在指令存活期内受保护，指令被消费/过新鲜后保护随边衰减，info 恢复可剪状态。
- **后续引用**：info 可被后续原子 cites（被引用则入图保护），与孤立原子规则一致。
- **保真风险**：拆分误判（指令内容进了 info 会被压缩掉）→ 拆分 prompt 采用保守策略（不确定归 dialog）+ extract 保 load-bearing 串（§10 开放决策 3）。

## 2. need_compress 门控（确定性门控 + LLM 动作）

决策序（先命中先生效）：

1. **版本链成员 → `false`（硬排除）**：版本链的 hash/去重语义要求 tool 内容 verbatim。
2. **工具作者声明**（`ctx.argp.setToolPolicy(tool, policy)`，见 §6）→ **上限提示**，非强制。
3. **未声明 → 大小启发式默认**：小结果 → `false`；大结果 → `extract`。
4. **图重要性可覆盖**（Stage-2 组图后）：高 eff/高入度原子即使声明了 compress 也保原文。

门控全部确定性（零成本）；LLM 只执行 summary/extract **动作**。

**调用门控（省调用，2026-08-24 补充）**：per-turn LLM 调用**仅当轮存在可压缩原子才触发**：

```
可压缩 = 任一 User >100 字符 ∨ 任一 Tool 的 need_compress ∈ {summary, extract}
```

纯 dialog 轮（短 User + 回复、无工具结果）**直接跳过**——零压缩成本、零 cites。代价：此类轮次不产 cites，长程跨轮依赖可能漏——缓解：此类原子受 recency 保护（剪枝时靠后）；若验证不足由全局补图兜底（§7 开放决策）。**成本含义**：eager 从"每轮固定付费"变"按需付费"——真实会话仅 ~30% 轮次触发 → 平均每轮 ≈ ¥0.012-0.014（§8），与 batch 差距基本抹平。

## 3. Eager 处理时机与缓存语义

- **时机**：turn 结束后立即处理**当轮原子**（surface 尾部 replace）。
- **缓存语义**：下一轮 prompt = 前 N-1 轮**原样前缀** + 第 N 轮压缩版 + 新内容 → 前缀 token 序列不变 → **全 hit**；仅当轮压缩版 + 新内容 miss。压缩版落盘后稳定 → 后续轮继续 hit。
- **对比现役**：ARGP 现有压缩剪**旧原子**（中段 replace）→ 前缀一变、其后 KV 全部失效 → 全量击穿。**本方案缓存画像严格更优**。
- **例外**：版本链 / 高价值原子留在原位，不触发 replace。

## 4. 压缩级别与存储（三级）

| 级别 | 内容 | 存放 | 消费方 |
|---|---|---|---|
| **extract** | 1-2 句关键内容（最小） | surface（常驻） | 模型可见 |
| **summary** | 压缩时产的摘要 | 存储区（随原子） | `recall_summary` |
| **original** | verbatim 全文 | append-only 日志 | `recall_detail` |

压缩动作落盘为 **surface replace 副本（model-only）**，原文留 append-origin → 防干涉（§6，dsh 架构保证 "replacement copies stay model-only"）。

## 5. 两级 recall（渐进 zoom，verbatim 天花板）

| 工具 | 返回 | 成本 | 语义 |
|---|---|---|---|
| `recall_summary(seq)` | 摘要 | 输出 ~1K ≈ ¥0.005 | "这内容是关于什么的"（gist） |
| `recall_detail(seq)` | verbatim 原文 | 输出=全文（≤26K token ≈ ¥0.12） | "确切字符串"（exact） |

- `recall_detail` ≈ 现有 `recall_pruned`（verbatim 从日志恢复，现成）；`recall_summary` 需压缩时把摘要一并落盘（零额外推理）。
- **升级策略**：工具描述教 escalate——gist 查询用 summary，exact 查询用 detail。模型误用 detail 会贵、停在 summary 会答错。
- **分档预算**：现有 `recallCharsUsed` 机制扩展两档（summary 便宜多给 / detail 贵少给）。
- **闭环**：recall 结果重新进 surface（尾部 append，缓存友好），**本身再次成为可压缩原子** → 压缩-召回闭环，不因 recall 重新撑爆上下文。

## 6. 防干涉设计（插件生态安全，六条）

1. 压缩 = surface replace 副本（**model-only**），原文留 append-only 日志——dsh 架构保证（`dsh-session/lib/index.js`："replacement copies stay model-only"），UI/持久化/其他插件读原文。
2. 声明通道 = ARGP 专用 API（`ctx.argp.setToolPolicy`），**不进结果载荷、不进 defineTool 配置**。
3. 命名空间 `argp.*`（cites 先例 `data.argpCites`），杜绝字段名冲突。
4. 声明 = 上限提示，图重要性可覆盖。
5. 缺席默认 verbatim——未声明工具完全走现有 0-LLM 路径，行为零变化。
6. **真会话验证**：观察插件读 append-origin 断言原文仍在（把"架构上能排除"升级为"实测已排除"）。

## 7. Stage-2：最终压缩 = 组图 + 剪枝

**组图方式（主方案：搭便车，2026-08-24 收敛）**：模型回复不携带 cites 契约（无回复开销、无服从率问题）。**cites 搭 Stage-1 per-turn 压缩调用的便车**——该调用本来就存在（拆 info + tool extract/summary），让它顺带吐 `cites: [{to, level}]`（schema-forced function calling，服从率与压缩动作同档、可靠）。图**逐轮增量构建** → 上下文到上限时图已就绪 → **压缩事务纯 0-LLM 确定性**。

- **构建器视野**：压缩调用输入 = 当轮原子 + **近期 surface extracts**（熵降 surface 恰好是压缩表示，小而可读）→ cite 按 seq 引用。代价：**局部视角**（抓不到长程跨轮依赖）——缓解：输入窗口拉长（extracts 便宜，可喂 10-20 轮）+ 接受局部近似（agentic 依赖绝大多数是局部的）。**开放决策**：是否保留压缩时轻量全局补图（只补从未被 cite 的原子）。
- **孤立原子规则（2026-08-24 补充）**：**跳过压缩调用的轮次（§2 门控：纯 dialog 轮）= 孤立原子**——同一谓词两个效果：①省调用；②**不建轮内边**（题外话/答疑不产生自引用保护，防止污染图），原子为叶节点低权重，仅受新鲜度（recency）保护。被后续原子 cites 引用时**正常入图**（获得 inDegree 按边保护）。安全网：U 原子永不剪（指令安全）+ 新鲜度保护 + 引用入图 + recall 兜底。判定边界：长 User（>100，触发拆分）或有工具结果的轮次**不算孤立**，正常建边。
- **备选方案（C 版本全局组图）**：若局部视角经验证不够，退回到"上下文上限时批量组图"：图构建器读熵降后原子集，批量产出 `SemanticEdge[]`。成本 = 每次压缩一次 LLM 调用（输入=熵降后上下文，小 5-10 倍）；质量 = 全局视角。**边价值实验的 A₃−A₂ 差距即该升级的潜在收益空间**。
- **注入路径（两方案共用）**：复用 `ArgpGraphEngine` 的 `injectEdges` seam（与边价值 A₃ oracle 同款机制）——构建器产出经注入进入引擎；**剪枝逻辑（eff/inDegree/反向拓扑/recencyGuard/turnGuard）完全复用、保持 0-LLM 确定性**。
- 剪枝在**熵降后的 surface** 上运行：原子更小 → 同预算保留更多 → 前向引用选项更多。
- 版本链原子因 `need_compress=false` + 高 eff，天然成为图中枢节点。
- **溢出处理顺序（2026-08-24 补充）**：单轮内容**直接超窗口**（context-overflow，如单条超大 tool result / 超大 User 粘贴）时按序处理：**①图存在且有可剪候选**（过了保护期的旧内容）→ 0-LLM 图剪枝先释放（便宜、快）；**②图不可用 / 剪后仍超** → 对**当前轮大原子**降熵（extract/summary）——当前轮原子受 turnGuard/recency 保护**不可剪**，溢出内容只能靠降熵；这也是搭便车 cites 的产出时机（提前到溢出时，非轮尾）；**③降熵后仍超** → 在熵降后的 surface 上再图剪枝。硬约束：**当前轮原子不可剪**决定了溢出路径必然包含降熵，图剪枝只能先清旧内容腾空间。
- **完整性**：Stage-1（逐原子熵降，eager，搭便车吐 cites）+ Stage-2（增量图 + 0-LLM 剪枝）= 完整压缩引擎。

## 8. 成本画像（eager vs batch，v4-flash 空闲价）

| 维度 | eager（每轮 tail 压，含调用门控） | batch（溢出才压） |
|---|---|---|
| 每轮 token 成本 | miss ~5K（¥0.0075）+ 压缩 LLM **按需触发**（§2 门控：~30% 轮次 × ¥0.02）→ **均值 ≈¥0.012-0.014**（全触发上界 ¥0.027） | miss 4K（¥0.006）+ hit 累积（便宜）≈ **¥0.008** |
| 100 轮总账 | ~¥1.4（均值） | ~¥2.2（含 5×160K 击穿 ¥1.2） |
| 会话长度 | **5-10×**（extract 级） | 受窗口卡死 |
| 缓存画像 | 前缀保持 hit | 压缩时全量击穿 |
| 窗口要求 | 32K 可行 | 160K 级 |

**5-10× 算术**：tool ≥85% + extract 压到 ≤5-10% → 增长降到 ~12-19% → 5-8×；summary 级只有 2-3×。**压缩比是命门，两级 recall 解锁更激进的 extract**（信息可达性不丢，只延迟）。

**待实证**：双 regime A/B（§9）决定，纸面数字只是先验。

## 9. 验证方案

1. **双 regime A/B**（06c 成本 harness）：eager vs batch，同任务同模型（27B / v4-flash），比三件事：
   - (miss, hit, out) 三元组（成本轴）
   - 最大可持续轮数（会话长度轴）
   - 探针质量（保真轴）
2. **探针套件扩展**：
   - 现有 exact 探针（验证 detail 档 / verbatim 天花板可靠）
   - **新增 gist 探针**（验证 summary 档价值：只问大意不问精确串）
   - **extract 保真度探针**（验证 load-bearing 精确串——路径/行号/错误码/marker——是否被 extract 保留）
3. **防干涉验证**（§6-6）：观察插件断言压缩后 append-origin 原文仍在。

**边/前向引用价值（2026-08-24 分段标注实验，spike 30）**：tlong 任务上 cites 对保留质量**零效果（保守 null）**——被引 chunk 两臂全保留（本就在新近度安全区），有风险的旧 chunk 无人引用（引用回复低价值先死）。**tlong 低估 cites 价值**；cites 是否在真实任务（跨轮依赖、引用原子长寿）有价值，留给 A₄ 用真实任务 + 搭便车引擎验证，分段标注 + 离线重放方法（`spike/30-segment-cites.ts` + `28` CLEAN_SURFACE）可直接复用。测量注意：shadowed 集合有区间伪影，须聚焦引用目标保留。

## 10. 设计决策记录（2026-08-24 逐条裁定，原开放决策点）

1. **info 压缩动作**：拆分调用顺带 LLM 标注三档（false/summary/extract），§2 确定性门控做上限提示——搭便车模式第三次复用（压缩顺带 cites、拆分顺带档位标注）。
2. **拆分阈值**：固定 100 字符起步，实测后校准。
3. **extract 保真串**：四类起步——路径 / 行号 / 错误码 / marker（含标识符、URL、哈希）。
4. **版本链成员判定**：内容哈希复用宿主既有机制。
5. **召回预算**：4 倍制——summary 档总预算 = 4× detail 档。
6. **建图窗口**：局部视角 10 轮 extract 级摘要窗口起步；全局补图**延后决策与实现**（与现管线耦合度低，不阻塞首版）。
7. **再压缩**：**禁止二次压缩**——每个 info/tool result 只有两种形态（detail 原文 / summary·extract 压缩态）；召回可选任一形态；surface 上为压缩态时仍可召回 detail。无多级退化链、无再压缩状态机。

**部署拓扑（已定）**：双引擎双插件——`peratom-compressor`（熵降管线）+ `cite-declarer`（边声明管线），压缩产出与 cites 声明无数据耦合（双向检查通过），唯一共享物为触发谓词（共用门控模块）。代价 = 每可压缩轮 +1 次轻量调用（"边际成本≈0"修正为低边际成本）；收益 = cites 独立关断 / 契约独立演化 / 失败隔离。详见自包含版 §7 部署拓扑小节。

## 11. 与既有实验/设计的关系

- `edge-value-4arm-design.md`：本方案是其"新臂 A₄"（逐原子压缩 vs 纯剪枝 vs 边）的引擎来源；P1/P2/P3 门控边类型无关、可直接复用。**图来源阶梯**：A₂（回复 cites，免费/服从率低）→ 搭便车（压缩调用 cites，边际≈0/服从率高/局部视角）→ C 版本全局组图（每次压缩一次调用/全局视角）→ A₃（oracle 完美边）；相邻档差值 = 每级升级的潜在收益。
- `ARGP-design-v1.0.md`：Stage-2 复用其**剪枝**（§5.4/§5.9/§5.11）；组图来源改为 Stage-1 搭便车（经 `injectEdges` 注入），不再依赖逐轮 cites。
- 台账 D21（多模型分工 + 成本轴方法论）：双 regime A/B 的成本口径。
- 现役 0-LLM 剪枝叙事：本方案获批后对外叙事改为"LLM 辅助熵降（顺带建图）+ 0-LLM 剪枝"，成本叙事同步更新。
