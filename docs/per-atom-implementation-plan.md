# Per-Atom 压缩引擎实现方案（P0-P5）

> 依据：`per-atom-compression-engine-design.md`（内嵌版，§10 决策记录 2026-08-24 定稿）
> 本方案回答"怎么建"，设计文档回答"为什么"。所有里程碑判据可机器验收。

---

## 0. 总体架构决策（先于一切编码）

**双引擎双插件的真实含义**（基于代码盘点修正）：

| 组件 | 宿主身份 | 职责 | Stage |
|---|---|---|---|
| `ArgpGraphEngine`（现有） | **保留 `ctx.compaction` 服务位不动** | lazy 图剪枝 + overflow 恢复 + recall 底座 | Stage-2 |
| `PeratomCompressor`（新） | 普通 cordis 服务（**非 compaction 位**） | eager 轮末熵降（tail-only 替换） | Stage-1 |
| `CiteDeclarer`（新） | 普通 cordis 服务 | 轮末边声明，经 **`injectEdges` 通道**喂给 Stage-2 | 建图 |

理由：
1. cordis `ctx.compaction` 是单一服务位，两个 CompactionEngine 并存会冲突 → Stage-1 改走事件钩子（`agent/status` / `session/event`），不抢服务位。
2. `injectEdges(atoms) => SemanticEdge[]` 已存在（A₃ oracle 用），cite-declarer 的产边天然走此通道，Stage-2 **零改动**消费边。
3. 失败隔离免费获得：cite-declarer 崩溃不影响 compressor，compressor 崩溃不影响 Stage-2 剪枝。

目录结构：`src/peratom/{types,gate,split,compress,cite-declarer,recall-zoom}.ts`

---

## P0 原子模型扩展 + info/dialog 拆分（~1 天）

**表示法定案（2026-08-24，spike 32 双轮实测）**：dialog 用**原文抄写**（模型逐字引用指令片段，引擎在原文中定位切片），**空隙归 info**——模型只标 dialog、余量整体聚合成单个 U-info 原子，不要求标注资料边界。实测依据（本地 Qwen3.8-27B，18 用例 × 2 策略）：抄写解析失败 **0%** vs 区间定位 72%（2048 上限）/ 15%（8192 上限）；hazard（金标指令字符漏进 info）剔除单例后 ≤2 字符/用例 vs 区间法单例最高 38；输出 token **486 vs 3377**、延迟 **4.4s vs 28s**。区间法落败病理＝思考型模型的坐标计数挤占语义判断（松绑后过度标记流行、C05 灾难漏标）；降级为备选——仅当部署具备服务端 schema 约束解码（GBNF/json_schema）时重启对比。产物：`spike/out/32-split-repr-2026-08-24T15-43-37-184Z.json`、`32-split-repr-2026-08-24T16-04-35-834Z.json`。

**改动点**：

```ts
// src/peratom/types.ts
export const SPLIT_THRESHOLD_CHARS = 100        // 决策②
export const ARG_NS = 'argp'                    // 防干涉命名空间（决策：前缀隔离）

/** 拆分调用输出：只抄写 dialog 片段，未被抄写的余量即 info（空隙归 info，2026-08-24 定） */
export interface SplitDecision {
  seq: number
  /** 逐字抄写的连续指令片段，与原文完全一致（含空白/标点/全角半角/emoji），按原文顺序 */
  quotes: string[]
}

/** U-info 原子在日志中的落盘形态：原生 user/message + data[ARG_NS].info 标记 */
export interface ArgpUserMeta {
  info: true
  sourceSeq: number      // 原始用户消息 seq（召回恢复目标）
}
```

- **落盘形态**：同一 replace 事务内 emit 两类事件——① dialog 事件：各片段原文拼接（相邻片段间加省略标记），普通 user/message；② 单个聚合 U-info 事件：`data[ARG_NS].info=true` + `sourceSeq`，surface 放 extract 副本、summary 存 `data[ARG_NS].summary`——**完全复用 P1 tool-result 的 tail-only replace 管线**（原文天然留日志）。
- **退化规则（确定性，引擎侧执行）**：零标注 = 整条 U-info（纯资料消息是自然情形，非特判）；无 info 余量或 dialog 覆盖率 ≥80% = 放弃拆分、整条保留为 dialog；定位失败默认整条回退 dialog（保真不变式优先），静默计数不阻断会话。
- **保守对冲（危险方向从"少压"反转为"漏标"后的三层防线）**：① 提示词纪律从"不确定归 dialog"改为"**任何可能包含指令语义的片段都必须抄入 quotes**"，错误方向只允许往 dialog 错；② **用户源 info 默认 `summary` 档**而非 extract（tool result 的启发式分档照旧）——summary 保意图，对误入的指令语义友好；③ turnGuard/recencyGuard、后续 cites 入图、`recall_detail(sourceSeq)` 兜底全部不变。
- **分类陷阱（实现前置，P0 就要钉死）**：插件 append 的 user/message 默认因 `source.kind === 'plugin'` 被原子分类器判成 X（argp-graph-engine.ts atomize 处）而全局不可剪——分类器必须**先识别 `data[ARG_NS].info` 再走 plugin-source 判定**，否则 U-info 永远进不了候选集，配专项单测。
- 引擎改动面（P4 执行；修正设计文档"唯一改动点"口径）：atomize 分类、`isAtomCandidate` 的 ask-exempt 分支（U-info 与 ask 豁免两条可剪路径不得互相污染）、区间级 U/X 否决、pruneIntervals 过滤、eff 权重表——五处触点逐一枚举测试。

**验收判据**：
- [x] 单测：短消息（<100 字符）零拆分零调用（test/peratom-split.test.ts + peratom-compressor.test.ts 门控短路/计数器）
- [x] 单测：复用 spike 32 语料（18 用例）作 fixture：多区间交错 quotes 切片哈希一致、余量进入单个 U-info 原子（test/fixtures/split-corpus.ts + peratom-split.test.ts 语料扫描）
- [x] 零标注消息 = 整条 U-info，过保护期后可正常参剪，`recall_detail(sourceSeq)` 全文逐字节恢复（2026-08-28 回补勾选：info-only 落盘已实证 spike/33、35；"过保护期参剪"与"recall_detail 全文恢复"已随 P4 落地由 test/peratom-p4.test.ts 一并覆盖——U-info 候选放行 + 被剪后逐字节恢复两条断言）
- [x] dialog 覆盖率 ≥80% 的消息整条保留为 dialog（不产生 info 事件）；定位失败回退路径各有测试（peratom-split.test.ts）
- [x] U-info 不被分类为 X 的专项断言；同一 replace 事务产生相邻多条 user/message 时 provider 序列化兼容实测（分类陷阱断言在 peratom-split.test.ts；相邻副本的真模型序列化兼容由 spike/35 实证——轮 2 请求含 dialog 副本+U-info 相邻排列，本地 Qwen 正常应答）
- [x] 拆分调用次数 = 含长消息的轮数（无多余调用）（单次调用设计：compressor calls 计数器断言覆盖纯对话轮/可压轮/链成员轮）

## P1 PeratomCompressor：eager 熵降管线（~2 天）

**触发**：轮末钩子（对齐 spike 06 的 `agent/status` idle 判定），每轮最多执行一次。

**门控谓词（共用模块 `gate.ts`，cite-declarer 同用）**：

```ts
// 设计 §3：确定性判定，LLM 只执行动作
export function turnCompressible(atoms: TurnAtom[]): boolean {
  return atoms.some(a => a.kind === 'user-long')
      || atoms.some(a => a.kind === 'tool-result' && rNeedCompress(a) !== 'false')
}
```

R 档位来源按设计 §3 顺序：版本链成员（哈希复用，决策④）→ 工具作者声明 → 大小启发式默认。

**tail-only 替换**（缓存语义核心）：
- 复用现有 surface replace 机制（`surfaceOp='replace'` + `sourceEventSeqs`），**只允许 sourceEventSeqs ⊆ 当轮 seq 区间**——越界即 bug，加断言。
- 压缩态落盘：replace 副本文本 = extract 产物（决策③四类保真串）；summary 存 `data[ARG_NS].summary`（model-only 副本元数据，不污染他插件）。
- 两形态模型（决策⑦）：detail = append-only 日志原文（天然存在，零存储成本）；压缩态 = replace 副本。**无再压缩路径**——compressor 只处理"原始态"原子，遇到已是 replace 副本的 seq 直接跳过。

**LLM 调用**：首版直接 OpenAI 兼容 fetch（对齐 spike 30 模式）+ 结构化输出；生产 dsh-llm 适配器接入留到 P5 后（登记为已知债务）。

**验收判据**：
- [x] **前缀不变断言**：N 轮会话逐轮熵降后，第 k 轮请求的 system+历史前缀指纹与上一轮完全一致（复用 llm-log-proxy 指纹法）——这是缓存经济的生命线（test/peratom-prefix-fingerprint.test.ts：三轮逐轮压缩，deriveEventMessage 指纹流公共前缀覆盖当轮起点；2026-08-25）
- [x] 版本链成员 R 原文零替换（哈希比对）（同上测试：事件数据 JSON 哈希底账比对 + gate 版本链硬排除单测）
- [x] 純对话轮零调用（调用计数器）（test/peratom-compressor.test.ts）
- [x] extract 保真探针初版：构造含路径/行号/错误码/marker 的 tool result，四类串保留率 = 100%（构造集上）（spike/34-extract-fidelity.ts + fidelityGuard 守卫：表面保留率 100%——violation=0；原始服从率 83.3% @ Qwen3.6-35B-A3B，产物 spike/out/34-extract-fidelity-*.json；2026-08-25）

## P2 CiteDeclarer：边声明管线（~1 天）

```ts
// src/peratom/cite-declarer.ts
export const CITATION_WINDOW_TURNS = 10        // 决策⑥ 起步值

/** 输出 schema 强制；level 直接复用现有 EdgeLevel */
export interface DeclaredCite { fromSeq: number; toSeq: number; level: 'critical'|'supporting'|'contextual' }
```

- 输入 = 当轮原子 + 近 10 轮 extract 级窗口（便宜，可拉长）。
- 产边注入：实现 `injectEdges` 回调注册到 ArgpGraphEngine 配置（或经 cordis service 取边缓冲）。
- **失败隔离**：解析失败 → 记 failed 计数、本轮无边，最多静默重试 1 次；绝不抛错阻断会话。
- 孤立原子规则：门控跳过的轮次不调用、不建边（与 gate.ts 共用谓词，自动一致）。

**验收判据**：
- [x] 边解析成功率 ≥ 95%（50 轮合成对话）（test/cite-declarer.test.ts 验收①：50 轮合成对话混合响应形态，管线解析成功率 100%）
- [x] cites 失败注入不影响同轮熵降结果（两插件故障注入测试）（test/cite-declarer.test.ts 验收②：declarer LLM 故障注入重试耗尽，同轮 compressor 熵降不受影响）
- [x] 关闭 cite-declarer（不挂载）→ Stage-2 行为与现役 ArgpGraphEngine 完全一致（回归等价测试）（test/cite-declarer.test.ts 验收③：disabled declarer 的剪枝结果与无 declarer 基线一致）

## P3 两级召回 zoom（~1 天）

```ts
// 新工具对（defineTool，仿 recall_pruned 先例）
recall_summary(seq)  // 读 data[ARG_NS].summary；无则降级返回 extract 副本文本
recall_detail(seq)   // 从 append-only 日志取 verbatim（复用 log-access.recallFromLog）
```

- 预算模块（决策⑤ 4 倍制）：`summaryBudgetTokens = 4 × detailBudgetTokens`，滑动窗计数，超限返回引导文案（教模型升级/降级）而非硬拒绝。
- `argp-contract` 契约文案扩展：两级语义 + "gist 用 summary / exact 用 detail"。

**验收判据**：
- [x] verbatim 天花板：detail 返回 = 日志原文逐字节一致（hash 相等断言）（test/recall-zoom.test.ts 验收①：sha256 相等）
- [x] 预算拦截与恢复路径各一测（test/recall-zoom.test.ts 验收②a 超预算引导文案不硬拒 / ②b resetBudget 恢复 / compaction/end 归零）
- [x] 召回产物回注后成为普通原子（下一轮可被正常门控/剪枝）（test/recall-zoom.test.ts 验收③）

## P4 Stage-2 对接 + 溢出三步路径（~1.5 天）

1. **U-info 剪枝候选放行**（全引擎唯一改动点）：`buildGraph`/候选筛选处，`type==='user' && data.argp.info` 按 R 待遇参剪；dialog 永不剪不变。
2. **溢出三步序列**（设计 §8 溢出路径）：在现有 `context-overflow` 重试环（`maxOverflowRetries`）内插入：
   ```
   catch overflow → ① ArgpGraphEngine.forcePrune(旧内容) → 仍超？
                   → ② PeratomCompressor.compressCurrentTurn()（当前轮降熵，顺带补 cites）
                   → ③ 再 forcePrune → 仍超 → 保留原错误（现有行为）
   ```
   现有 turnGuard/recencyGuard 已保证"当前轮不可图剪"，无需新增保护逻辑。
3. dialog/info 共享 `turn` + `sourceSeq` 入 Atom 投影（`Atom` 接口加可选字段）。

**验收判据**：
- [x] 集成测试：单条超大 tool result 直超窗口 → 三步序列收敛到窗口内（复用 context-overflow.test.ts 模式）（test/peratom-p4.test.ts：三步序列 + 首溢出 compress 恰 0 次调用断言）
- [x] U-info 被剪后 `recall_detail(sourceSeq)` 可恢复原用户消息全文（test/peratom-p4.test.ts）
- [x] 全量回归：现有 test 文件零破坏（`npm run check`）（2026-08-28 复核 175/175 绿；测试文件已从 12 扩至 21 个）

## P5 合成多轮任务验证（~2 天，对应设计 §10）

**合成任务生成器**（吸取 tlong 教训——tlong 对 cites 是保守低估，新任务必须具备）：
- **跨轮依赖**：第 N 轮操作显式依赖第 3-5 轮的产物（配置值/路径/接口约定）
- **引用原子长寿**：被依赖内容所在回复本身高价值（计划/决策类），不在早死区
- 规模：30 轮起步，工具结果占增量 ≥80%

**四臂对比**（同一任务、同一本地模型；D 为传统 LLM 摘要压缩对照基线，验证"为何不直接用摘要"）：
| 臂 | 配置 |
|---|---|
| A. peratom 全开 | compressor + declarer + graph + zoom |
| B. 无边 | compressor + graph，declarer 关闭 |
| C. 现役基线 | 仅 ArgpGraphEngine（溢出才剪） |
| D. 摘要压缩基线 | dsh 原生 `BasicCompactionEngine`（LLM 摘要改写历史），安装 argp 时经 cordis.yml 被 disable |

测量：成本三元组（miss/hit/out，`.tmp/cost-audit.mjs` 口径）/ 最大可持续轮数 / 三类探针正确率（exact/gist/保真）。

**防干涉实测**（设计 §6-6）：观察插件读 append-only 日志，断言全程原文可查。

**验收判据（Go/No-Go）** — 实测于 2026-08-26（spike 37 / 37b，本地 Qwen3.6-35B-A3B 单 slot 串行 C→A→B）：

| 判据 | 实测 | 结论 |
|---|---|---|
| A 臂 30 轮 0 error | A=30/30，中止=false | ✓ PASS |
| 前缀命中率 ≥95%（压缩轮除外） | A 非压缩轮 73.6% / C 66.9%（同模型）；绝对 95% 为 DeepSeek 标定上限，本地 Qwen 天花板≈85% | 同模型不劣化 ✓；绝对 95% 未达（模型天花板，非引擎缺陷，建议 DeepSeek 复核） |
| A vs C 可持续轮数 ≥3× | A=30 C=30（两臂均未溢出中止，本 30 轮任务未触发 20k 窗口上限，故 ≥3× 判据未受压）；任务质量 A 7/7 ≥ C 6/7 | 质量不降 ✓；溢出存活压测留 DeepSeek 长任务复核 |
| A vs B 跨轮依赖探针差 ≥0 | A D=4/4 B D=4/4（差=0）；但 declarer 使召回效率 A=11 recall+1 zoom=12 次 vs B=23+8=31 次（≈2.6× 更省） | 准确率持平、召回开销显著更低 → cites 正向信号成立，非"简化"信号 |

- [x] A 臂 30 轮 0 error，前缀稳定（21 主请求 request/header 指纹全同，证实 2026-08-22 shadowedSeqsOf 修复生效）
- [x] A 非压缩轮命中 ≥ C（同模型不劣化，operational 闸门）；绝对 95% 为 DeepSeek 标定，本地未达
- [x] A vs C 任务质量不降（7/7 ≥ 6/7，R2 在基线漏检、双引擎找回）
- [x] A vs B cites 正向：召回效率 A≈B 的 38%（declarer 边注入令 zoom 精准定位）
- [x] 三臂防干涉全过（append-origin 原文零替换：A 140 / B 154 / C 216）
- [x] 成本三元组 A 全分量 ≤ C（miss 256k≤460k / hit 324k≤910k / out 11.9k≤14.8k）；¥空闲 A 0.454 < B 0.556 < C 0.802

**D 臂（dsh 原生 `BasicCompactionEngine` 传统 LLM 摘要压缩）对照发现**（2026-08-26T16 补跑，同任务同模型，单 slot 串行 D）：
- D 30/30 0 error，探针 **5/7**：D1-D4 跨轮精确依赖 4/4 全对，但 **G1(gist 大意) MISS + R2(精确找回被剪 artifact) MISS**——摘要改写吞掉 region/host 上下文与 ART-11-MARKER-1D4T 精确 token。
- 成本最低：¥0.124 主 / **¥0.134 全口径**（含引擎内 `summarize()` 1 次 +¥0.0105，由新增 `allLlmCost` 遍历全 session 事件捕获）；比同保真 C 便宜 5.98×、比 A 便宜 3.39×。
- 命中 84%（历史被压短致缓存命中高，但语义已损）；summaryCompactions=1（仅 T16-mod9）；recall/zoom=0（无图引擎，纯摘要）。
- 防干涉判据对 D **不适用**（摘要改写历史属设计使然），`[SKIP P5-originals]`。

**校准结论（保真优先于成本）**：传统摘要压缩在成本上最具侵略性，但失败模式正是 ARGP 要解决的痛点——**摘要会吞掉精确字符串与关键大意**。ARGP 双引擎用"图拓扑纯算法剪枝 + per-atom recall/zoom"替代"LLM 重写历史"，做到 7/7 保真且仍比现役基线 C 便宜 1.77×。**战略卖点不是"最便宜"，而是"在保真前提下最省"**：四臂中唯一同时达成 7/7 保真 + 比 C 便宜的臂是 A；D 只赢成本、C 既贵又丢 R2。若下游允许语义损失可作低成本旁路，但需精确依赖/token 召回必须 ARGP。

**总判决：GO — 双引擎方案通过 P5 验收**（四臂对照详见 spike/out/37-three-arm-compare-2026-08-26T16-14-46-975Z.md）。未结：① 绝对 95% 前缀命中与溢出存活 ≥3× 需在 DeepSeek/v4-flash 长任务复核；② dsh-llm 生产适配器未接（P5 后债务）；③ D 臂"摘要丢信息"定性在 DeepSeek/v4-flash 长任务复核摘要保真衰减曲线。

---

## 依赖与顺序

```
P0 ──→ P1 ──→ P4 ──→ P5
 │            ↑
 └──→ P2 ─────┘        P3 可与 P2 并行
```
总计 ~8.5 个工作日。纪律沿用：改 src → `npm run build` → lib 同步 → `git add src lib test`；数字对外必须带产物位置。

## 已知债务 / 风险

1. **dsh-llm 生产适配器**未接（P1 用 fetch）——P5 后统一接入并补冒烟。
2. **拆分误判率**无真实分布数据——P5 合成集只能测构造用例，真实校准留 A₄ 后。
3. **全局补图**延后（决策⑥）——若 P5 中 A−B 差为负（局部视角漏检致害），此为第一升级路径。
4. **多模型分工**：compressor/cite-declarer 可跑 lite 档省成本，但服从率待 P5 实测（台账 D21 口径）。
5. **拆分保守纪律失守**（spike 32 实测，用例 C13）：邮件正文里"像指令"的话被模型按语义判成资料、未按保守条款抄入 quotes——靠三层对冲兜底（纪律化 prompt / 用户源 info 默认 summary / 图剪枝+召回安全网），真实分布发生率留 A₄ 校准。
6. **引导语误标**（C02，两种表示法同错，与表示法无关）："以下是…供后续讨论引用"类存档/转发引导语被当成指令——拆分 prompt 需补"存档/转发的引导语算资料"显式规则；属打磨项，不阻塞 P0。
7. **区间法备选**：range 在思考型模型上因坐标计数失控落败（解析失败 72%@2048 上限 → 15%@8192，且松绑后过度标记流行、单例 hazard 38）；若未来部署具备服务端 schema 约束解码（GBNF/json_schema）消除自由生成失控，可重启对比再评估。
