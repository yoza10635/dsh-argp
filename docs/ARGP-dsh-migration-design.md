# ARGP → DeepSeek Harness 迁移设计稿（v1.0 详细实施版，源码复核 + 评审对照 + novelty 尽调）

目标：仅凭本设计稿 + dsh 仓库即可完整实现迁移。设计部分自包含（算法、数据结构、契约文本全部内联）；引用仅出现在可行性论证处。
状态：已提前开工（用户 2026-08-15 拍板，限定 M1 spike 范围，不等三选二信号；卡点攒 2~3 条打包向上建议）。原开工信号（三选二）：dsh 1.0 / 接口冻结声明 / 第三方 compaction 插件出现。
v0.4 更新（2026-08-14）：对照 dsh 源码（0.1.0-rc.5，commit 47f9438）完成六项外部偏差报告复核——CompactionEngine / PromptSection / ctx.systemPrompt.section 均实际存在（命名误报）；config patches 是按顶层字段浅替换；llm 包名实际为 dsh-llm-pi-ai / dsh-llm-deepseek（不存在 dsh-deepseek-adapter）；surfaceOp 存在但仅限单连续区间 replace（无 delete）；breaking-changes 声明属实。§1/§8/§9/§10/§11 相应修订。
v0.5 更新（2026-08-15）：对照针对原始设计（v1.0）的外部评审逐项交叉核验——P0-2 不适用（recall 机制已在 §6 完整定义）、P0-3 实现已防住（每轮动态复核，§4.5）；新增：领域定位（§1.1）、cites 失败保守语义（§4.7）、版本链悬垂引用权衡（§4.4）、重建幂等不变式（§9.9）、标注不可靠性缓解层级（§9.10）、长程/recall/ask 回归验收与里程碑隔离（§10）、回返主动提示（§11）。
v0.6 更新（2026-08-15）：§1.1 novelty 尽调——对"用引用图决定遗忘顺序"做学术/工业/开源三维先行检索：未发现先例，novelty 成立；同时修正两处不实引用（NeurIPS 2025 SeqCV 实际是多智能体工作流依赖验证、ContextWeaver 未找到对应记忆论文）；补入最接近的遗忘排序工作（LUFY/MemoryBank/FSFM 均为打分排序、无依赖图）与开源实现活跃度。
v0.7 更新（2026-08-15）：二次尽调（对照外部提供的候选表）——ContextWeaver 真身确认存在（arXiv 2604.23069，"依赖结构化记忆"论文属实，此前检索遗漏），升级为最接近的最近邻并重新校准 novelty 声明；新纳入 Context Compression 综述（F1–F3 失败分类）、A-MEM（NeurIPS 2025）、Git Context Controller（arXiv 2508.00031）、LLMLingua/RECOMP/SWE-Pruner。
v0.8 更新（2026-08-15）：子代理全文研读 ContextWeaver 原文——依赖边获取方式确认（辅助 LLM 逐节点判父+摘要，每步 2 次 LLM 调用，读节点摘要非原文；非执行 agent 自身声明）；确认图仅做 inclusion（历史永不删除、无 eviction、无 token 预算驱动机制）、非确定性（论文自报 5 runs 方差）、固定节点数 W 非预算、未开源；novelty 声明定稿，四大支柱均未被覆盖；新发现待查线索：其引用的 The Complexity Trap（arXiv 2508.21433，observation masking vs LLM summarization）。
v0.9 更新（2026-08-15）：新增 §9.11 设计决策记录——边获取分叉（辅助 LLM vs 自身声明）的脑测理由与实测归宿；架构已以"cites 是增强非前提"吸收边密度证伪结果。
v1.0 修正（2026-08-15）：§9.11 措辞纠错（用户指正）——"强制引用提升逻辑有效性"（引用义务作为回答逻辑链的正则化器）**不能算被证伪**：实测测到的是服从率/边密度，与回答质量是两个不同变量；该假设至今未测，且本质上难以客观度量（主观判断/LLM-as-judge），列为开放问题而非已结论。
v1.1 更新（2026-08-15）：外部实证吸收——新增 §1.2 四条可迁移实证锚点（E1 token 构成 83.9%/E2 masking≥summarization/E3 级联摘要 60% 事实销毁/E4 占位保留推理链有效）；据此修订：§8.3 主路径倒向占位改写、§10 spike 基线升级为 recency+占位、新增 §9.12 禁止摘要的摘要不变式。
v1.2 更新（2026-08-15）：M1 开工实测回写——spike 1 PASS（挂载/触发/无干扰）；spike 2 PASS（surfaceOp 双路径 + 配对不变式，9 项判决全过）；§8.3 按实测修正：replace 节点原位插入、start/end 指认现存 surface 节点 seq、tool/result 单节点改写须克隆原 message 保 id 仅换 content；卡点 B-1 登记（占位改写无结构化元数据通道，见 blocker-log.md）。
v1.3 更新（2026-08-15）：spike 3 PASS（recall 工具 + PromptSection 契约，5 项判决全过）——M1 三 spike 全部通过，核心可行性判决成立，spike 4（M2）解锁。实测补充两条装配语义：ctx.plugin 返回 cordis fiber 而非服务实例（实例由 Service 构造器注册在 ctx.<name>，且是代理对象——身份判定用 instanceof）；CompactionEngine 子类在 fiber 内访问 tools/systemPrompt 必须声明 static inject。无新卡点（blocker-log 维持 B-1 一条）。
v1.4 更新（2026-08-15）：spike 4（M2，t1 复刻）全 PASS——ArgpT1Engine（16K 窗口/0 LLM/占位主路径）V1–V6 六项判决全过（6 事务 shadowed 17 节点、配对不变式干净、U 载体保护 needle 未剪、事务括号完整、recall 命中 14658 chars、needle 三件套 3/3），新本地 SOTA 模型（Qwen3.8-27B）上机制验证成立。实测补充三条：①user/message 事件 data 形状为 { content, source, role, id }（无 turn/message 包裹字段）；②compaction/prune 事件不进 start/summary/end 不变式状态机，无 LLM 剪枝只能借 compaction/summary 语义进事务括号（候选卡点 B-3，已登记）；③微剪枝下限需求：reasoning-only 助手节点可见文本 0，剪了净增 tombstone 字符且白付 KV 失效代价（引擎加 minSpanChars=512）。spike 4a 冒烟判决 C = NOT replayed（llama-server 日志 f_keep=0.082 交叉验证）——历史 thinking 不进 prompt，引擎无需 thinking 剥离机制，reasoning 块不计入预算。C7 服从率基线初步分层：两 run 分别出现自发 recall 3 次与 0 次但答案均对（样本待扩）。
v1.5 更新（2026-08-19）：UI cites 残留根因修正 + 契约 V5。①认知修正：dsh 核心的人类转录（Web UI）**固定取 append 起源事件**，surface replace 副本是 model-only（core session surface.ts 注释："Append-origin events are that transcript's durable source material; replacement copies stay model-only"；客户端 assistant-step 节点定义只匹配 `isAppendSurfaceEvent`）——因此 §8.3/strip 机制"避免残留 surface 而被 UI 渲染"的假设不成立：strip 只治理模型侧 surface，**永远改不到 UI 显示**（本会话日志实证：原始事件 seq 287 含 `{"cites":[]}`，剥离替换事件 seq 288 正常落盘且 argpCites 存根保留，UI 仍显示 287 的原文）。②契约 V5：空引用时"完全不输出 block"（V4 的"write {\"cites\":[]}"废止）——空块对引用图零信息（无入边、不计 declared），只能在源头不产出；引擎对"无块"本就是常态（§4.7），无回归。③非空 block 在 UI 中作为原始回复的一部分可见（模型侧仍被剥离）；若要 UI 也不显示，只能走客户端插件展示层过滤（侵入 shell 内部）或上游改人类转录取数规则（read-only，不可行），均不推荐。
v1.6 更新（2026-08-20）：B-7 落地——UI 层显示过滤走**原生 seam + 插件客户端半边**（用户拍板路线 B）。①原生侧（ui-conversation，纯增量 ~60 行，默认空过滤器 = 行为不变）：新增 `assistantDisplay` 服务（`AssistantDisplayService`，register/apply，effect 生命周期），在 assistant 投影层单点应用（`projectAssistant` 一处覆盖渲染、复制按钮文本、turn-tail 三消费方，`data.finalNode.blocks` 同步过滤）；`assistantDefinition` 改为工厂 + 保留无过滤导出供测试。②插件侧（dsh-argp）：新增客户端 bundle（`dsh.client` 声明 + `exports["./client"]` + esbuild `__ModuleLoader__` 格式），在 seam 上注册"剥离尾部 cites JSON"过滤器；共享纯模块 `src/cites-strip.ts` 供服务端 extractCites 与客户端过滤器复用。③边界：显示过滤只作用于渲染层，不触日志/surface/模型文本；非空 cites 仍进引用图。④生效条件：重建 ui-conversation client bundle（monorepo client pass）+ profile 安装同步 + dsh web 重启。

## 1. 可行性结论（引用调研与实验证据）

- `ctx.compaction` 是抽象 CompactionEngine seam，dsh 文档明示 "Load one implementation per context"——ARGP 可作为独立后端整体替换 compaction-basic（依据：dsh docs/subsystems/compaction；源码实证：`abstract class CompactionEngine extends Service`，抽象方法 compactIfNeeded/compactNow/compactRegion）
- Session = 不可变事件日志 + surface 视图：剪枝 = 节点移出 surface，shadowed 节点永留日志，recall 从日志找回——ARGP 需要的"完整历史 + 可重建视图"是 dsh 原生能力（依据：docs/subsystems/capability-seams；源码实证：core/session/src/surface.ts 的 fold/SurfaceManager）
- `ctx.tools.register` / `ctx.systemPrompt.section({name, order, text})`：recall 与契约均有标准挂载点（源码实证：PromptSection 接口存在，text 支持动态函数；另有 system-prompt/assemble waterfall 可变换整体 assembly）（依据：docs/extensions、cookbook/adding-a-tool）
- LLM 适配器：`@deepseek-ai/dsh-llm-pi-ai`（与 pi-main 同源——本地 llama-server 零障碍）与 `@deepseek-ai/dsh-llm-deepseek`（官方 API）均存在
- 风险确认：README 明示 developer preview "THERE WILL BE COMPATIBILITY-BREAKING CHANGES"（当前 0.1.0-rc.5）——开工信号等待策略不变
- 核心算法已在 pi fork 上完成在线验证：73 单测 + t1/t6/t7/t8 实验；其中 t8 为 7 次真剪枝边界的 DeepSeek 全链路验证（probe 全对、孤儿 tool 消息 0）。定稿形态：无编号 + catalog + recall + 精简契约 + 版本链去重 + cites 义务（强模型）

### 1.1 与已有工作对比（定位、外部引用与 novelty 尽调，2026-08-15 核实）

**A. 评审点名的四个候选（逐个核实）**

- Zep/Graphiti（getzep/graphiti，20k+ star，ThoughtWorks Radar 2026 Trial）：时序知识图谱记忆——双时态有效窗口、旧事实"标记失效而非删除"（与 ARGP 版本链思想同源）；但图用于**检索**（BM25+向量+图遍历混合），写入侧依赖 LLM 抽取三元组，不做上下文 eviction 排序。定位差异确认成立
- MemGPT/Letta：主上下文 + 外部存储 + 分页/召回，是 §6 recall 工具的设计先例（机制同构）；遗忘决策靠 LLM 判断与启发式分页，无依赖图
- ContextWeaver（arXiv 2604.23069，2026-04，Amazon 团队）：**最接近的最近邻**，已读原文（v0.8）。把交互轨迹原子化为推理步节点，建"前序步→后序步"依赖图，沿父边 BFS 取祖先子图（≤W 节点）为下一步构造上下文。**已确认的四大差异**：①依赖边由辅助 LLM（Logical Dependency Analyzer）逐节点判定——读候选节点摘要列表输出父节点+置信度，每步另一次 LLM 摘要调用；非执行 agent 在自身输出中声明（与 ARGP 的 cites 契约形式相反），也不是 embedding/启发式；②图只做 inclusion（选择保留），历史永不删除——非祖先条目仅将 Observation 置占位符，无 eviction、无遗忘序；③建图+摘要每步均调 LLM（自称 "LLM-based controller"），非 0-LLM；④收敛靠固定节点数 W（非 token 预算）且非确定性（论文以 5 runs mean±std 报告方差）。未开源。唯一实质交集：都把历史原子化+建"后继依赖前序"图以超越 recency/sliding-window——related work 应正面引用；其 LLM-per-step 开销与非确定性正是 ARGP 的差异化空间。另注意其引用了 The Complexity Trap（arXiv 2508.21433，observation masking vs LLM summarization），待排查
- NeurIPS 2025 "Can Dependencies Induced by LLM-Agent Workflows Be Trusted?"（poster 115805）：**核实后修正原引用定位**——该文实际讨论多智能体子任务依赖图的条件独立性假设失效问题，提出 SeqCV 顺序执行+一致性校验；并非针对"上下文引用声明"的可信度研究。只能作为**较弱的类比佐证**（LLM 诱导的依赖结构普遍存疑），不能作为 A1 的直接证据

**B. 遗忘排序的最近邻工作（核心判断：有没有人用依赖图排遗忘顺序）**

- LUFY（Sumida et al., arXiv 2409）：心理学启发的记忆剪枝——唤醒度/惊讶度/LLM 重要性/提取诱发遗忘/时间衰减打分排序。**打分排序，无依赖图**
- MemoryBank（Ebbinghaus 遗忘曲线）与 FSFM（遗忘机制分类学：被动衰减/主动删除/安全触发/自适应强化）：同上，均为打分或策略分类，无图
- LLMLingua 系/RECOMP/SWE-Pruner：提示词与工具输出压缩的成熟家族，重要性来自困惑度/学习式编码器/启发式——与 ARGP 同属 pruning 类但无 LLM 声明的引用边，无依赖感知
- Selective Context（liyucheng09/Selective_Context，开源）：自信息驱动的 token 剪枝，无图；LogicRAG（2508.06105）：图剪枝+上下文剪枝双轨，但剪枝靠 LLM 摘要滚动记忆，非确定性
- OrcaLoca/CoSIL：距离感知的代码图剪枝，但作用于检索到的仓库上下文而非对话历史
- 工业 compaction（OpenCode/Codex/Claude Code 实测拆解）：规则剪枝（工具结果/旧轮次）+ LLM 五段式摘要，"选择性失忆"靠 LLM 参与
- **结论：未发现用引用/依赖图对对话上下文做 token 预算驱动遗忘排序的先例**——唯一用依赖图管交互轨迹的是 ContextWeaver（arXiv 2604.23069），但方向是选择构造而非剪枝收敛（见 A）；其余遗忘排序全部是衰减/重要性打分或 LLM 判断
- 综述坐标：《Context Compression for LLM Agents》（preprints.org 202605.2065，自动化所/上交/UCSD/合工大，配 Awesome-Context-Compression 仓库）将方法分为 masking/summarization/pruning/externalization/表示压缩，自评现状"fragmented, preliminary, disjointed"；其失败分类 F1（压缩前决策错误）/F2（压缩中信息丢失）/F3（压缩后访问失败）与 ARGP 的 A1（标注不可靠）/剪枝保护机制（U 载体+ask-cover）/catalog+recall 逐项对应，可作交叉印证。ARGP 恰好占据其分类学的空位：机制=显式依赖剪枝、控制=确定性算法

**C. 开源实现核查（有无现成可比实现）**

| 项目 | 活跃度 | 与 ARGP 可比性 |
|---|---|---|
| ContextWeaver（arXiv 2604.23069） | 论文（2026-04），未开源（已读原文） | **最接近的最近邻**：依赖边由辅助 LLM 逐节点判定（每步 2 次 LLM 调用）；图仅做 inclusion（历史永不删除）；固定节点数 W 非 token 预算；非确定性（自报 5 runs 方差）——与 ARGP 四大支柱全不同，方向互补可组合 |
| A-MEM（agiresearch/A-mem，NeurIPS 2025，412 引用） | 开源活跃 | Zettelkasten 式笔记动态链接，图用于记忆组织与检索非剪枝顺序；链接靠语义相似度非引用声明 |
| Git Context Controller（arXiv 2508.00031，SWE-Bench-Lite 48%） | 论文+已开源 | 上下文当版本控制文件系统（COMMIT/BRANCH/MERGE/CONTEXT）——支撑"剪枝=视图、可恢复"方向（与设计罗盘同思想），但无依赖图无预算收敛 |
| getzep/graphiti | 20k+ star，Radar Trial | 时序图+失效窗口思想同源；但目标是检索记忆非上下文剪枝，写入需 LLM |
| SimpleMem（aiming-lab/SimpleMem，3.1k star） | 活跃（arXiv 2601.02553，2026-01） | **同思想家族非反例**：压缩优先/原子化/写入时去重/检索找回三阶段与 ARGP 同构；其"压缩优于图"结论针对的是图作为持久化记忆存储（Zep/Mem0g/A-MEM），不触及窗口内 eviction 排序问题；作用层互补（跨会话记忆 vs 会话内剪枝），唯一对立轴是 LLM 参与度（SimpleMem 用 LLM 门控/合成/规划，ARGP 0-LLM） |
| rohitg00/agentmemory（8.6k star） | 活跃 | BM25+向量+图谱 RRF 融合检索；图用于检索增强非剪枝排序 |
| Codex/Claude Code/OpenCode 内置 compaction | 工业现役 | 均含 LLM 摘要步骤，无 0-LLM 确定性剪枝路径 |

未发现"引用图决定 eviction 顺序 + 0-LLM + 确定性收敛"的开源实现。

**D. novelty 声明（二次尽调后定稿措辞）**

用引用图决定遗忘顺序 + 压缩阶段 0 LLM 调用 + 确定性收敛——先行检索未发现同向先例：已有工作用图做记忆/检索（Graphiti/agentmemory/A-MEM），遗忘排序用衰减/打分（LUFY/MemoryBank/FSFM）或 LLM 判断（MemGPT/工业 compaction）。唯一在交互轨迹上建依赖图的 ContextWeaver（arXiv 2604.23069）经原文研读确认与 ARGP 四大支柱全不同：边由辅助 LLM 判定（非自身声明）、图只做 inclusion（无 eviction）、每步调 LLM（非 0-LLM）、固定节点数且非确定性（非预算驱动收敛）；它回答"下一步带什么进上下文"，ARGP 回答"预算不够先丢什么"，方向互补可组合。三点组合（图排序 × 0-LLM × 确定性收敛）为差异化定位，**定稿**。声明边界：本结论基于公开网络检索与关键最近邻原文研读（非系统性文献综述），措辞以"未发现先例"为准，不作绝对断言。综述坐标：《Context Compression for LLM Agents》自评分类学"fragmented, preliminary, disjointed"，ARGP 占据其中显式依赖剪枝+确定性控制的空位，F1–F3 失败分类与 A1/保护机制/recall 可交叉印证。对最接近的 SimpleMem（arXiv 2601.02553）：其理论基础与 ARGP 同家族（压缩优先/原子化/写入时去重/检索找回），非背离；其"压缩优于图"证据针对图存储型记忆，不能证伪图排序型剪枝；两者作用层互补（跨会话记忆 vs 会话内 eviction），仅在 LLM 参与度上对立——而 SimpleMem 自身"迭代过滤成本过高"的动机恰支持 ARGP 的 0-LLM 目标。

### 1.2 可迁移的外部实证锚点（用于修正方法论，2026-08-15 吸收）

仅收录**结论级、可迁移**的实证；跨层指标（SimpleMem 30×、Graphiti 18.5%、FlowKV、SeqCV）层不对口，只作定位佐证不迁移数字。

- **E1 token 构成**（The Complexity Trap arXiv 2508.21433 + SWE-Pruner）：coding agent 轨迹中 Observation 占 83.9%、Read 操作占 76.1% → 剪枝优先级以工具输出（R 原子）为第一目标，升格为显式排序先验（ARGP 现状已吻合）
- **E2 masking ≥ summarization**（The Complexity Trap，SWE-bench Verified 五模型配置，开源仓库+原始数据）：简单 observation masking 效果与 LLM summarization 持平甚至略优、成本降 ~50%；摘要会掩盖停止信号导致多跑轮次（runtime +15%）；混合策略再省 7~11%；效应泛化到 OpenHands → ARGP 的占位改写路径获得实证支持（§8.3 主路径倒向占位）；且 ARGP 恰好补上 masking 已知致命弱点（细节回看彻底丢失）——catalog+recall 是其严格超集
- **E3 级联摘要的生产实证灾难**（Codified Context，283 sessions/108k 行代码库）：compaction 中 60% 事实销毁、级联摘要导致 54% 行为漂移；对照（哈希寻址事实元组移出窗口）100% 准确率、成本低 252× → 实证强化"不改写原文"正确性，新增 §9.12 不变式：任何重压缩必须从原文重建，禁止摘要的摘要
- **E4 占位保留推理链有效**（ContextWeaver，SWE-Bench Verified/Lite）：非祖先条目仅 Observation 置占位、Thought/Action 永久保留即优于 sliding-window → §10 spike 对照基线从 naive 滑窗升级为 recency+占位（ARGP 的增量价值必须在已被实证证明有效的更强基线上证明）
- **验收含义**：E2 的"停止信号被掩盖"风险纳入 t-long 长程验收（§10）——除误差累积外，增加"剪枝后任务收敛轮数不劣化"观测项

## 2. 总体架构

数据流（每次 harness 请求前）：

```
session 事件日志（不可变，dsh 原生）
   → 触发判断（API 报告 token > window - reserve）
   → atomize（消息 → U/A/T/R 原子）
   → buildGraph（确定性边 + cites 语义边）
   → prune（前置去重 → 主循环 → 降级）
   → 持久化 compaction 事件（retained 集 + 剪枝日志 + 摘要原子）
   → surface 视图重建（summary → catalog → 保留历史 → 新消息）
```

四个插件组件：

| 组件 | dsh 挂载点 | 职责 |
|---|---|---|
| argp-compaction | 自定义 CompactionEngine | 触发判断、原子化、建图、剪枝、cites 解析、去重；输出 compaction 事件 |
| argp-render | compaction 输出侧（surface 视图构建） | catalog tombstone、summary 锚点、配对修复 |
| argp-recall | ctx.tools.register | 按关键词找回被剪原子 |
| argp-contract | ctx.systemPrompt PromptSection（order 100-199） | 压缩契约 + cites 义务，随配置动态求值 |

composition：cordis.yml 里 disable compaction-basic、挂载 argp 包（include+patches overlay 模式）。

## 3. 核心数据结构

```ts
type AtomType = "U" | "A" | "T" | "R";           // 用户 / 助手文本 / 工具调用 / 工具结果
type EdgeLevel = "critical" | "supporting" | "contextual";
const EDGE_WEIGHTS = { critical: 10, supporting: 5, contextual: 2 };

interface Atom {
  id: number;             // 全局单调递增，永不复用（重建视图时编号稳定）
  type: AtomType;
  entryId: string;        // 所属 session 节点 id
  round: number;          // 所属 U 原子的序号（轮次，从 0 起）
  tokens: number;         // 估算 = ceil(字符数 / 4)
  selfImportance: number; // 默认：A=5, U=3, T=0, R=0（模型未声明时）
  refs: ResolvedRef[];    // 仅 A：声明的出边（结论 -> 依据）
  toolCallId?: string;    // T/R 配对键
  assistantAtomId?: number; // T 的所属 A
  text: string;           // 文本表示（A 已剥离 cites JSON）
}

interface Edge { from: number; to: number; kind: "deterministic" | "semantic"; level?: EdgeLevel; }

interface PruningRecord {         // 持久化为 compaction 事件（剪枝边界）
  tokensBefore: number; tokensAfter: number;
  retainedEntryIds: string[]; retainedAtomIds: number[];
  pruneLog: PruneLogItem[];       // atomId/type/tokens/level/importance/reason/remainingTokens
  summarizeCount: number; status: "ok" | "force_pruned" | "failed";
  syntheticAtoms: SyntheticAtomRecord[]; // 降级摘要原子（视图渲染 + 重建时物化）
  nextId: number;                 // 边界后新原子从此续编
}
```

## 4. argp-compaction 详细设计

### 4.1 原子化 atomize

- U：每条 user 消息一个原子；A：assistant 回复的文本块（多个 text 块拼接；cites JSON 剥离进持久化字段）；T：assistant 消息里每个 toolCall 块一个原子（text = `toolName(argsJSON)`）；R：每条 toolResult 消息一个原子
- T 记录 toolCallId + assistantAtomId；R 记录 toolCallId——出处签名与配对修复都靠它
- id 分配：按路径顺序全局递增；边界重建时对边界前全量重新原子化以保持原编号

### 4.2 建图 buildGraph

- 确定性边：A→T（assistantAtomId）、T→R（toolCallId 匹配）
- 语义边：cites 解析结果，from=引用方 A、to=目标原子、level=supporting
- 派生量：in-degree（仅算保留集内）、effective_importance = max(self, 入边权重传递)、lastRefRound

### 4.3 触发与预算（关键教训）

- 触发线：API 报告 contextTokens > contextWindow − reserveTokens（reserve 建议 30000）
- 剪枝预算：`budgetTokens = contextWindow − reserveTokens`
- **基准一致性规则**：触发用 API 报告值，剪枝内部用原子估算值（chars/4，不含 system prompt/工具定义），两者必须换算——`pruneBudget = budgetTokens × atomTokensBefore / contextTokens`。pi fork 曾因直接用两个不同基准比较，出现"触发但永不剪枝"的死循环

### 4.4 前置版本链去重（仅超预算时运行）

- origin 签名：R 原子经 toolCallId 反查配对 T，继承 `toolName + 规范化参数`（参数键排序后 JSON 序列化）签名；A 原子用全局文本桶；**U 原子永不参与**
- 相似度：字符 5-gram shingle Jaccard，θ=0.8；同签名才比较（不同文件/工具来源永不并链）
- union-find 成链，每链保留最新；链内有 critical 入边的成员豁免；T 随配对的可剪 R 成对剔除（无悬空半截）
- 剪除标记 reason="version_dedup"
- 已知权衡：指向被剔版本的非 critical 引用（supporting/contextual）悬垂不重定向（换零复杂度，且被剔版本本就非最新事实）；若 phase2 数据显示伤害，改为"引用即保留，仅无引用版本剔除"（外部评审建议的更保守默认）

### 4.5 剪枝主循环

候选条件（保留集内）：in-degree = 0，或 ask-exempt 的 U。ask-exempt 的两个严格条件：① **cover 证据**——覆盖者（该轮 U 后首个 A）必须对该 U 声明过语义边（防"空泛覆盖"：仅靠 "noted" 式确认不构成覆盖）；② **每轮动态复核**——候选计算每轮重查"当前全部保留入边均来自覆盖者"（静态预分类只是快速路径提示），跨轮引用一旦到达豁免自动失效，不变式 2 不被破坏（外部评审 P0-3 所指失败模式已被此机制防住；移植时必须保留动态复核，不能只留静态标记）。
保护（永不进候选）：
- 最新 U（latestUId）
- 新鲜 A（round > latestRound − 1）
- 未覆盖 U：没有任何保留原子引用它时，它是用户内容的唯一载体（retention 的支柱，见 §9.6）

每轮取候选排序第一者剪除，直至 token ≤ 预算。排序键：
1. 最低关联语义级别：候选原子**关联（入边或出边）**的语义边最低级别；纯候选 in-degree=0 时事实上只有出向 cites 边，ask-exempt 候选的覆盖者入边也计入；isolated < contextual < supporting < critical；确定性边不计级别（外部评审 P2-6 表述已按实现收紧）
2. effective_importance 升序
3. lastRefRound 升序（久未被引用者优先）

### 4.6 降级路径（候选耗尽）

1. summarize：选最旧 critical 链（critical 语义边连通分量，种子取 lastRefRound 最小者；≤10 原子、≤2× 超额量），LLM 摘要为 S 原子（≤链 token 30%，selfImportance=10），外部入边重定向到 S，链内原子解除唯一载体保护后由主循环回收；每次剪枝最多 3 次
2. force_prune：忽略图约束剪最弱者（排序键同主循环），保留 latestU
3. failed：单原子超预算 / 无可剪原子 / 循环守卫耗尽——上报而非硬撑

### 4.7 cites 解析与消歧

- 提取：A 文本尾部的 `{"cites":["被引项开头原句",...]}`；支持裸 JSON 或 ```json 围栏（强模型会包围栏）；剥离后正文保持纯文本
- 解析（头部匹配）：候选 = 可见原子中文本以该前缀开头者；排除引用方自己 entry 内的原子；唯一命中直接采纳；多命中（AMBIG）→ **最早命中 + U 优先**
- 生成 supporting 语义边；被引原子经 in-degree 候选排除自动获得保护；引用方被剪后保护自然失效（设计意图，不是缺陷）

**失败语义（保守方向，外部评审 P0-1 采纳）**：
- 无 cites 块 → 常态（该 A 视为孤立参与排序；定稿形态下多数轮次如此，算法照样收敛——标注是增强而非前提）
- **检测到 cites 尝试但解析失败**（文本含 `"cites"` 但 JSON 无效，重试一次仍败）→ 保守保护：该 A 本边界不进入候选集（pruneLog 记录），避免"标注失败 → 当孤立 → 优先被剪"的最坏默认
- 引用前缀全部解析失败（无命中或 AMBIG）→ 该条边不成立，引用方 A 自身不受影响
- 漏报（该写未写）不可检测，是残余风险：由 U 载体保护 + 模型从 U 重推导兕底（t8 已实证：结论链被剪但 probe 全对），长程误差累积由 §10 长程验收度量

### 4.8 输出

PruningRecord（§3）持久化为 compaction 事件；历史原文永留事件日志，视图只是投影。

## 5. argp-render：视图重建

渲染顺序：summary 原子（`[summary] ...` 前缀）→ catalog tombstone → 保留历史 → 边界后新消息。dsh surface 天然无编号，[N] 仿写问题不存在——本组件只负责 catalog 与 summary 渲染和配对修复。

catalog 规则：只列被剪的 U/A 原子（T/R 可重新获取），U 排前；≤20 条；每条 snippet ≤70 字符；总预算 ≤600 token；头部 `[context] Compression removed N earlier item(s) from the visible context:`；recall 启用时追加提示句（catalog snippet 是 recall 关键词来源）。

**配对修复（必须实现，t8 实测缺陷）**——OpenAI 兼容 API 要求每个 tool 消息之前必须有声明其 tool_call 的 assistant 消息：
1. A 被剪但其 toolCall 存活（force_prune/降级路径会破坏"A 在则 T 在"不变式）：不能丢弃整个 assistant 消息，须发射最小 assistant = 占位文本 `"(reply text removed by compression)"` + 存活的 toolCall 块
2. R 保留但配对 T 被剪：降级为 user 文本 `"tool result (toolName):\n<内容>"`

验收不变式：任何重建出的请求中不得存在孤儿 tool 消息。

## 6. argp-recall 工具

```
schema: { query: string, maxTokens?: number }
```

- 搜索范围：最近一个剪枝边界之前、未被该边界保留、文本非空的原子（重放事件日志 + atomize 即可，dsh 里就是读 session 日志）
- 匹配：query 按空白拆词、小写子串命中；排序 = 命中词数降序 → selfImportance 降序 → id 升序
- 预算（防 recall 自身撑爆上下文）：每轮 ≤3 次调用；单次结果 ≤ 窗口 5%；会话累计 ≤ 窗口 10%；超预算截断该行并标注 `(truncated)`
- 输出：`Recalled N pruned atom(s) (~T tokens) for "query":` + 每行 `[U3] <原文>`；结果作为普通 toolResult 回流，原子化为 R 原子参与后续建图
- dsh 形态：`ctx.tools.register(defineTool(...))`，约 30 行；预算状态挂会话级存储，每轮重置调用计数

## 7. argp-contract 契约（全文）

定稿形态使用"精简契约 + cites 义务"，原文如下（英文即注入文本）：

```
Context compression (ARGP):
Your conversation context is managed under a compression budget. Older parts of the conversation may be compressed or removed at any time.

Rules:
- Every reply must be self-contained plain text: state facts, conclusions, and content directly in natural language. Never answer by pointing at earlier context items instead of restating the needed content.
- Your visible context is a pruned view: earlier parts of the conversation may have been removed by compression, so absence from the visible context does not mean it was never said. When compression happened, a catalog near the start of the context lists the removed items with short snippets. When the user refers to something discussed earlier (values, instructions, facts) that you cannot find in the visible context, ALWAYS call the recall tool with relevant keywords first (the catalog snippets are good keyword sources) — never conclude it was never provided without recalling.
- Citation declaration: at the end of every substantive reply, append ONE JSON block listing the earlier context items your reply depends on, each identified by quoting its opening words:
{"cites":["the gateway release passes. Neither","Here is the incident-window data"]}
  - Each entry copies verbatim the first roughly 10-20 words of one earlier item (a user message, a tool result, or one of your earlier replies) that your reply actually used.
  - Only cite items you genuinely depended on (facts, conclusions, instructions). If there are none, output {"cites":[]}.
  - Never invent a quote: every entry must appear word-for-word in your visible context.
  - The reply body before the block stays plain text. The block may be wrapped in a ```json code fence. Output nothing after it.
```

> **V5 修订（2026-08-19，实现现状以此为准）**：cites 义务已拆分为独立 PromptSection `argp-cites`（order 151），措辞升级 V4（"读了工具结果并作答 = 必须引用该结果"，spike/24 实测声明率 0→43.6%）后于 2026-08-19 再升 V5：上引文 "If there are none, output {\"cites\":[]}" 改为 **"If your reply used nothing from earlier items, output no block at all — never an empty {"cites":[]} block."**，且 "Append ONE JSON block…" 限定为 "When your reply depends on at least one earlier item"。理由见 v1.5 更新（UI 人类转录取 append 原文，空块只能在源头不产出）。

动态求值规则（保持契约与真实可用机制一致，顺序重要）：
1. recall 关闭 → 先摘除 recall 句（"When the user refers to something discussed earlier … without recalling." 整句）
2. catalog 关闭 → 再摘除 catalog 句（"When compression happened, a catalog … snippets." 整句）及短语 "(the catalog snippets are good keyword sources) "

挂载：PromptSection，order 100-199，动态求值（读配置而非环境变量——环境变量是 pi fork 的实验开关形态，dsh 用插件配置）。

## 8. dsh 接线要点（对照源码修订）

### 8.1 cordis composition 与 patches 语义

- 方式：`@deepseek-ai/cordis-plugin-include` + patches overlay（同 examples/headless-agent/compaction.cordis.snapshot.yml 的用法）
- patches 语义（源码确认，**按顶层字段浅替换，非深度合并**）：带匹配 `id` 的 patch 执行 `target[key] = value` 字段级替换——patch 里写了 `config` 就整个替换原 config；`insert` 追加新条目；未匹配的 patch 警告并跳过
- 因此 argp 挂载 = 两步：① patch `compaction-basic` 为 `disabled: true`；② `insert` argp 包条目。不存在"把 argp 配置合并进 compaction-basic"的形态

### 8.2 CompactionEngine

- 继承 `@deepseek-ai/dsh-compaction` 的 `CompactionEngine`，实现三个抽象方法 `compactIfNeeded(agent, trigger, signal)` / `compactNow` / `compactRegion`，作为插件加载即注册为 ctx.compaction
- compactIfNeeded 内做 §4.3 触发判断 + 完整剪枝流水线；trigger 取值 `'pressure' | 'context-overflow'`
- 剪枝结果以 `compactCheckpointSource(compactionId)` 的替换 user 消息写回 surface；compaction 包导出的 `toolPairingBalancedBefore/After` 助手做边界平衡校验（§9.1 配对不变式有原生工具）

### 8.3 surfaceOp 已确认约束（源码 core/session/src/surface.ts）

- 仅 user/message、assistant/message、tool/result 三类事件可进 surface；每个事件必须携带 surfaceOp 标记（`'append'` 或 `{op:'replace', start, end}`）
- replace 是**单连续区间** → 替换为一个新节点；替换节点的 `sourceEventSeqs` 必须覆盖全部被遮蔽 seq；tool/result 的 replace 只允许改写单节点 content（head+marker+tail 式，同 compaction-tool-result-pruner）。**spike 2 实测补充**：替换事件获新 seq（日志尾追加）但在 surface 上**原位插入**被替区间位置；start/end 指认现存 surface 节点的 seq（多次顺序 replace 可组合，二次指认不漂移）；tool/result 单节点改写受 `assertToolResultRewrite` 硬约束：须克隆原 message 保随机 id 仅换块内层 content（新建 message 即拒），且无结构化元数据通道（卡点 B-1）；user tombstone 覆写单 tool/result 节点不被 surface 层拦但必留孤儿 tool-call → **配对必须整对同剪，由 ARGP 剪除决策自保**（孤儿可被 deriveMessages 扫描检出）
- **无 delete 操作**：纯删除不可行，每个被剪区间必须换出至少一个新节点（最小占位或摘要）
- 因此 ARGP 散布式多点剪枝有两条实现路径（spike 2 判决主路径；外部实证先验 §1.2 E2/E4：masking≥summarization、占位保留推理链已被证明有效——**b) 占位路径为默认主路径**，a) 仅在节点数压力确证时启用，混合策略对应 E2 的"再省 7~11%"结论）：
  - a) 多段 replace：把被剪原子归并为极大连续 surface 区间，每段发一次 replace（区间两端必须 tool 配对平衡），替换节点承载 summary/catalog 内容；节点数真正下降
  - b) 逐节点改写（pruner 模式）：把被剪节点 content 改写为占位，保留 tool 配对与 KV cache 部分复用，但节点数不减、需靠 content 缩小回收 token

### 8.4 其余挂载

- recall：ctx.tools 注册（§6）
- 契约：`ctx.systemPrompt.section({ name, order, text })`——PromptSection 接口存在，text 支持动态函数（每次 assembly 求值，对应 §7 开关动态摘句）；order 约定：-100 harness 身份、0 persona、100–199 工具指引——契约用 100–199 段；同名 section 重复注册报错，scoped section 遮蔽同名全局 section
- 持久化：cites/refs 与剪枝记录放事件 meta 或 sidecar（需 spike 确认，见 §11）
- 本地模型：`@deepseek-ai/dsh-llm-pi-ai` + 自定义 provider baseUrl（同 pi fork models.json 方式）
- 实验基建：headless profile 替代自建 run.ts；t1/t6/t8 任务语义迁移（filler/probe 编排）

## 9. 不变式与陷阱清单（实现必查）

1. **tool 配对不变式**：剪掉 assistant 消息必须保全 toolCall/toolResult 配对，否则 API 400（pi fork t8 实测踩坑，§5 两条修复分支是硬要求）；dsh 侧有原生校验助手 `toolPairingBalancedBefore/After`，compactRegion 明确要求区间两端平衡
2. **预算基准一致性**：触发判断与剪枝判断必须换算到同一 token 基准（§4.3），否则"触发但永不剪枝"死循环
3. **去重陷阱一（事实重现）**：同一事实出现在用户 setup 与后来的工具结果中（实测 sim=0.802）→ U 原子永不参与去重
4. **去重陷阱二（同内容异出处）**：两个不同文件/工具读出近全同内容，纯文本去重会误并链毁出处 → origin 签名前置判别（同签名才比相似度）
5. **契约真实性**：契约描述的机制必须与实际启用的一致（recall/catalog 关闭时同步摘句），否则模型按不存在的机制行动
6. **U 载体保护是 retention 支柱**：t8 判决——结论链可以不幸存，probe 仍全对，因为 U（原始数据唯一载体）受保护 + 模型重推导。引擎必须保证 U 非被覆盖永不遮蔽
7. **结论原子无入边即无保护**：cites 只保护被引原子；重要结论若无后续引用仍会被剪。结论级保留（前向引用/importance 上调）是 phase2 议题，不阻塞迁移
8. **服从率分层**：cites 义务只在强模型上成立（实质轮 5/5）；小模型服从崩塌（1/3）——本地模型跑时建议关 cites 义务
9. **重建确定性（幂等）**：同一事件日志 + 同一边界记录 → 渲染出的视图必须逐位一致；dsh 的 session 回放/重启/克隆一致性都依赖它（视图是日志的纯函数投影，无隐藏状态）
10. **标注不可靠性的缓解层级**（外部评审 A1 风险的回应）：漏 cites 只损失一条保护边（不影响收敛）；U 载体保护、新鲜度、latestU 保护均不依赖标注；解析失败走保守保护（§4.7）；长程误差累积必须用长程验收度量（§10），不得用短实验外推
11. **边获取方式的决策记录（脑测 vs 实测）**：初始分叉是辅助 LLM 组图（ContextWeaver 路线，读摘要判父）vs 自身声明（cites 契约）。选自身声明的脑测理由两条——①省 LLM 调用；②强制依赖引用可提升回答的逻辑有效性（引用义务作为推理正则化器：要求引用 vs 不要求引用时，前者的逻辑链更强）。实测归宿需区分两个变量：①被证实（压缩全程 0-LLM，t8 全链路通过）；②**未被测过，不是被证伪**——实验测到的是服从率/边密度（refs/cites 层仅 0~25%，DS 最好 6/24 实质回复、本地 0/24），它与回答逻辑链质量是两个不同变量；而②若真要测，本质上是主观判断（或 LLM-as-judge，同样主观），列为开放问题（§11）。被服从率数据真正证伪的是原设计的另一个隐含依赖："边密度足以支撑剪枝决策"——故定稿形态把 cites 降级为稀疏增强信号（增强非前提，§9.10/§4.7）。决策正确性不在任何脑测理由成立，而在架构对边稀疏/缺失免疫：无 cites 时剪枝靠 self-importance+新近度照样收敛。谱系中另一极端也被实测排除：纯被动前缀挖掘（0 调用）因改写式复述完全失效（B 复述 A 时 10~40 字符前缀匹配 0 命中）。注意：辅助 LLM 路线的边正确性同样未被证明（ContextWeaver 只报端到端 pass@1 与 confidence 字段，未测边精度）——"花 2 次调用换更可靠的边"也是未经实测的假设；若 dsh 迁移后重启此议题，先做边精度对照实验再决策
12. **禁止摘要的摘要**（外部实证锚点 §1.2 E3：级联摘要导致 60% 事实销毁/54% 行为漂移）：任何重压缩/tombstone snippet/catalog 片段必须从事件日志的**原文**提取或重建，不得基于先前压缩产物再次压缩；视图重建一律从日志原文出发（与 §9.9 幂等不变式同源）

## 10. 验收标准与 spike 计划

验收复刻（与 pi fork 对照）：
- t1-credentials（本地）：needle 三件套全对、0 仿写残留、视图无编号标记
- t8-prunechain（DeepSeek）：真剪枝发生（≥3 次边界）、probe 全对（PASS + 0.0% + 148 ms）、重建请求孤儿 tool 消息 = 0、实质性轮 cites 服从
- **t-long 长程（新增，外部评审 P0-1/P1-4）**：≥50 轮（目标 100+）真剪枝链，度量 probe 准确率随边界数增长的误差累积曲线；用 prefill 大文件策略控成本（t8 已证明可行）；短实验结论不得外推为长程结论；另增"剪枝后任务收敛轮数不劣化"观测项（§1.2 E2：摘要会掩盖停止信号导致多跑轮次）
- **对照基线升级（§1.2 E4）**：可行性对照不得只打 naive 滑窗——recency+占位（ContextWeaver 式，已被实证证明优于滑窗）是最低合格基线，ARGP 的增量价值必须在其之上证明
- **recall 专项（新增，外部评审 P0-2）**：构造"用户问及被剪内容"场景，度量命中率（top-3 ≥90%）与三重预算有效性；关键词机制若命中率不达标，embedding + 墓碑根 U 锚点是既定升级路径（索引成本届时补进成本表）
- **ask 跨轮引用回归（新增，外部评审 P0-3）**：真 ask + 后续跨轮引用场景，验证豁免自动失效（pi fork 73 单测需确认覆盖此用例，缺失则移植时补）
- **跨模型交叉（已实质完成）**：消融期已在本地小模型（t1/t6）与 DeepSeek（t8）交叉验证，服从率分层结论在 §9.8；迁移后复跑两模型即可

里程碑隔离（采纳外部评审 P1-1，映射到 spike）：M1 = spike 1+2+3（引擎挂载 + 剪枝路径 + recall/契约）→ 核心可行性判决；M2 = spike 4 的 t1 复刻；M3 = t8/t-long 真剪枝复刻。**M1 不达标 → M2/M3 不启动**，把"方案整体不可行"的风险隔离在最小内核上。**M1 已全部 PASS（2026-08-15）；spike 5（t8 复刻建边版）G1–G6 + C7-cites 全 PASS（2026-08-16）；spike 6 t-long 50 轮双跑（run-A + extractCites 修复后受控对照 run-B）L1/L2/L3 全 PASS（2026-08-16）→ M3 完成。**后续为发文增强项：spike 7 基线臂（dsh 原版 BasicCompactionEngine 同任务对照，脚本已备）。

spike 计划（已提前开工，限定 M1；spike 1/2/3 均已 PASS，见 dsh-argp 仓库）：
1. 最小 CompactionEngine：compactIfNeeded 空转 + 日志，验证挂载与生命周期（半天）——✅ PASS（挂载为 ctx.compaction / pre-step 压力钩子触发 / 空转不干扰轮次）
2. surfaceOp 剪枝路径验证：按 §8.3 两条路径（多段连续区间 replace vs 逐节点占位改写）各构造最小场景；**配对不变式检查**（遮蔽带 tool_calls 的 assistant 节点后重建请求，确认无孤儿 tool 消息，用 toolPairingBalancedBefore/After）；确认 token 回收量与 KV cache 失效代价（半天，关键判别）——✅ PASS（9 项判决：双路径均可行、不配对剪枝被孤儿扫描/配对 throw 检出、单次剪枝回收约 24% 字符量；撞出卡点 B-1）
3. recall 工具 + PromptSection 契约（半天）——✅ PASS（5 项判决：引擎挂载为 ctx.compaction 且 recall_pruned 进 tools.schemas / argp-contract section 进 assembly 且动态 text 被求值 / 被遮蔽 seq 从 append-only 日志找回原文（含 tool-call 节点投影）、未剪与不存在 seq 正确未命中 / ctx.tools.execute 真实派发命中未命中语义正确 / 追加剪枝后 recall 立即可见）
4. t1 复刻（headless + llama-server）对照 run-10；t8 复刻确认真剪枝路径（1 天）——✅ 机制验证版 PASS（V1–V6 全过，产物 spike/out/04-t1-2026-08-15T05-00-41-774Z/；与定稿差距：无 LLM 建边/服从率样本未扩，属 M3 范围；撞出候选卡点 B-3）——spike 5 t8 复刻（ArgpGraphEngine 建边版 10240/7168，medium 档）✅ 全 PASS（2026-08-16，G1–G6：atoms U/A/R/X=12/13/2/4、语义边 2；2 事务均净减 shadowed 8 节点、首笔 47613→18184 chars；cites×剪枝交互 0 违例；0 孤儿；事务事件无错；probe expectAll 2/2 anyOf=pass；wall=1025s。C7-cites：实质轮服从 2/2、逐字引用全命中 → 本地新 SOTA 模型可启用 cites 义务。产物 spike/out/05-t8-2026-08-15T18-42-28-947Z/。实测修正：dsh surface 无 tool/call 节点（SURFACE_EVENT_TYPES 仅三类型，call 块内嵌 A）→ 引擎改组同剪（A 含 tool-call 块 + 应答 R 整组同剪）；cites 匹配 startsWith→includes；窗口 16384/8192→10240/7168 使事务频率成立；判决脚本 turn 映射须按文案匹配 + turn/start 定位（prompt 序号在重试轮错位，G6 曾误判 FAIL，05-rejudge.ts 重判通过））
5. t-long 长程误差曲线（spike 6，50 轮 medium 档）——✅ 双跑全 PASS（2026-08-16）。run-A（产物 spike/out/06-tlong-2026-08-15T19-28-31-109Z/）：50 轮完成、24 事务 shadowed 118、0 孤儿；U 7/7、R 7/7，误差曲线全平（边界 6→24 正确率恒 100%）；recall 21 调用命中 14；wall=3687s。run-B（extractCites 修复后受控对照，产物 spike/out/06-tlong-2026-08-16T06-39-26-665Z/）：35 事务 shadowed 119、0 孤儿；U 7/7、R 7/7（边界 5→35 曲线全平）；recall 36 调用命中 14；citeStats declared 13→227、failed 549→41；wall=4334s。归因：run-A 的 failed=549 系 extractCites 把合法空块 {"cites":[]} 误判 parseFailed → 保守保护挡候选；修复后候选池扩大（事务 24→35）、cites 声明回升使边保护生效。长程新形态（入开放问题 8）：run-B 后段 visible 稳态 31K→62K 爬升，现空剪（keptIntervals=0）+ 被引大块内容受保护
6. 基线臂（spike 7，dsh 原版 BasicCompactionEngine 同任务）——❌ FAIL（2026-08-16，集成失效非算法结论）：全程 0 笔 compaction，请求累积 201633 tokens 撞窗口 400，turn 36 中止（产物 spike/out/07-baseline-2026-08-16T07-55-41-633Z/）；卡点 B-4（basic 引擎压力通道在测试装配下未触发，疑 tokenMeter 未注册/口径含 reasoning + pre-step 钩子静默 warn）入 blocker-log 打包向上建议。附带证据价值：与 pi 侧三臂 A 臂同构 → 同任务无有效压缩必溢出，ARGP 臂 50 轮全完且 prompt 峰值仅 26.9K tokens（对照终态 ~109K）。同压力档基线重跑（修装配后）列入迁移后遗留清单

全部通过 → 启动整体迁移；任一失败 → 重新评估停留 pi fork 的成本。

## 11. 开放问题

1. surfaceOp 已确认仅单连续区间 replace、无 delete（§8.3）——spike 2 已判决：多次顺序 replace 可组合且指认不漂移；双路径均可行，占位主路径结论不变（§1.2 E2/E4 实证先验）；新发现问题：tool/result 占位改写无结构化元数据通道（卡点 B-1，待向上建议）
2. dsh 节点是否允许自定义 metadata（cites/剪枝记录持久化位置）
3. catalog tombstone 的注入形态：surface 是节点级遮蔽，tombstone 需作为新节点注入还是 PromptSection 附加
4. compaction 事件与 ARGP 剪枝边界的一对一映射粒度（一次剪枝 = 一个事件是否足够承载 PruningRecord；多段 replace 时 checkpoint 源如何关联）
5. 用户回返的主动检测（外部评审 P1-3）：新 U 与某墓碑根 U 相似度高时主动注入提示（"存在相关已剪内容，可 recall"）；当前依赖契约义务的自发 recall + catalog snippet 提示，主动注入是 phase2 扩展（需廉价关键词重叠或 embedding 检查）
6. 引用义务的推理正则化效应（§9.11 理由②）：要求 cites vs 不要求时，回答的逻辑链是否更强——未被测过且本质难以客观度量（主观判断/LLM-as-judge 同样主观）；若未来想验证，只能接受主观评估的局限（如盲评配对比较），不作为迁移阻塞项
7. 建边覆盖率保底（2026-08-15 讨论）：提案"要求回答至少直接引用问题一次"以保证每节点出度——判决不宜走契约层：①服从是概率非保证（强模型 t8 probe 轮也漏写）；②强制边无依赖信息且使最新 U 成 hub，与既有 latestU/新鲜度保护重复；③逐字引用耗 token 且诱导回显仿写，改写式复述又击穿文本匹配检测。候选形态：图构建器无条件加"回答→触发问题"架构先验边（覆盖率 100%、0 token、0 服从依赖，显式标记为先验边而非声明边），cites 维持细粒度增强；是否另测简化契约版待 spike 4 新模型服从率基线后定
8. 长程可见量爬升与空剪（2026-08-16，spike 6 run-B 实测）：cites 边保护生效后，被引大块内容（filler 应答引用 chunk 内容）长期驻留 surface，visible 稳态从 31K 爬至 62K chars；候选组小而碎时整组剪除后区间 < minSpanChars（512）被放回 → 空剪（keptIntervals=0，本轮无事务但仍超阈）。不变式未破（62K 仍低于模型窗口，R 针 7/7 未受影响），但预算利用率下降。候选改进：①入度保护加新鲜度衰减（被引但久未再引的原子降级候选）；②minSpan 下限与组合并策略联动（碎组合并成大区间再剪）；③空剪时升格 force 通道。不阻塞 M3，入 phase2 改进清单
