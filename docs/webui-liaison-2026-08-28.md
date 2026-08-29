# WebUI 真环境联调记录（2026-08-28）——dsh web profile × dsh-argp 0.3.2 × 本地 Qwen3.6-35B-A3B

对应 dsh-roadmap P4-3（WebUI 真会话验证）。真宿主 = 本地源码 dsh（commit 141eb6f，端口 3080），argp profile 经 bundle patch 声明式挂载 dsh-argp 0.3.2（`compaction-basic disabled + insert dsh-argp`，`--dump-config` 组合验证通过）。真会话经浏览器驱动：冒烟（读 1 文件）+ 压力（连读 8 个 24KB 规格文件，上下文顶满声明窗口 32K）。

## 过关项

- **声明式挂载链全通**：dump-config 组合正确（dsh-argp patch 生效）→ web 真启动 → 插件 0.2.9→0.3.2 刷新（`dsh plugin --profile argp remove/add file:`）→ `ctx.compaction = ArgpGraphEngine` 挂载成功，每请求压力检查日志可见（`[argp-graph] pressure check`）。
- **真会话工具链全通**：模型真实调用 read_file 读 24KB 文件并正确概括（115 tok/s，首 token 8.1s）；ARGP 的 system prompt 注入生效（"Context compression (ARGP)" + "Citation declaration (ARGP)" 两段协议原文在 request/header.system 中验证）；**cite 协议模型服从**——回复尾部按协议输出 `{"cites":[{"t":"...","l":"s"}]}`。
- 环境修复（保留价值）：本机 hosts 的 `localhost` 映射损坏（v4/v6 均不通），llamacpp baseURL 必须显式 `127.0.0.1`；settings.yaml 已改。

## 发现一（P0 级，阻断 1.0.0 叙事）：双引擎没有生产挂载路径

真宿主上 dsh-argp 的 default export = `ArgpGraphEngine`，bundle patch 只挂 Stage-2 图引擎（C 臂形态）。**PeratomCompressor / CiteDeclarer / RecallZoom 三管线（`mountPeratomStack`）没有任何声明式挂载入口**——`ctx.llm` dsh-llm 生产适配器（commit 2afbd53）在真宿主上一行都没跑到。1.0.0 的"双引擎"叙事在真环境里目前只兑现了单引擎。**需要**：插件入口按 config 分叉挂 `mountPeratomStack`，compressor/declarer 的 llm spec 从插件 config 声明（provider/model 走宿主 llm 服务或独立 endpoint 配置）。

## 发现二（P1，复测后改判 + 精确化）：窗口口径三重错位——声明窗口被绕过，原生摘要器抢跑

**原始观察（20:0x，web profile 实为陈旧 0.3.0）**：引擎账本 9054 tok vs 服务端实测 69,907 tok prompt（7.7× 低估）。**改判**：web profile 装的是 0.3.0（08-20 拷贝），而 usage 真值锚定（`lastRealPromptTokens`，08-23 修复）只在工作区 0.3.2 构建——`grep -c lastRealPromptTokens`：0.3.0 lib=0 处，0.3.2 lib=6 处。原观察是**部署陈旧伪影**，且路线图 P4 已知注意事项（file: 复制需重装同步）再次被验证。

**0.3.2 复测（20:08 新会话，同 8 文件压力任务）暴露两个真问题**：

1. **引擎阈值跟物理窗口走，声明窗口被绕过**。web 组合里 dsh-argp 行 config 无 `windowTokens` → 运行时按 `contextWindow × 0.8` 解析，日志实测 threshold=**209,715 = 262,144 × 0.8**（llama.cpp 物理 `-c 262144`），而 settings 声明的 `contextWindow: 32000` 被忽略。结果：真实 prompt 94,618 tok（服务端日志 task 354：69,907 miss + 24,711 hit，与 usage 事件逐字吻合）远超声明窗口 3 倍，ARGP 纹丝不动。
2. **dsh 原生 `session-checkpoint-policy` 摘要器抢跑**。99% 声明水位时，UI"已压缩 9 条历史记录（约 7011 tokens）"来自 dsh 原生 checkpoint 摘要器（`compaction/summary` 事件 + "## Primary Request and Intent" 格式 + "automatically generated checkpoint" 消息）——**lossy 摘要，恰是 ARGP 存在要避免的东西**。web 组合中 compaction-basic 已被禁（web-app 与 dsh-argp 双重 patch 验证），但 session-checkpoint-policy 是独立行、无人禁。另有两次 checkpoint 尝试以 "summarization produced no text summary content" 失败（Qwen 空输出），三次尝试才成功一次——摘要器本身也不稳。

**修复方向（1.0.0 验收项）**：①引擎 windowTokens 运行时解析必须用**模型声明 contextWindow**（adapter catalog 声明值，与 compaction-basic 同源），物理窗口只做溢出恢复兜底；②argp 托管 profile 的 bundle patch 应同时禁 `session-checkpoint-policy`，让 ARGP 成为唯一压缩权威（否则声明窗口越小、原生摘要器越抢跑）。

## 发现三（P2，原报告结论维持但补细节）：cite 协议"只教不收"

system prompt 教了完整 cites 协议（V6 分级 s/c/x），模型正确服从并在回复体输出 JSON 块，但 WebUI 显示层没有剥离——用户直接看到 `{"cites":[...]}`。spike 里 strip 由测试 harness 做；生产显示路径缺这一环。修复方向：宿主侧 assistant 消息渲染前剥 cites 块（或引擎在 surface replace 时消化）。

## 次要观察

- 模型输出撞 max_tokens 上限时反复截断（"Think All" 大表格重输出两轮），配合 dsh `tool-*` 的 head/tail 截断，真环境的截断行为比 spike 复杂——P5-bis 数字外推到真环境时须再打折。
- 复测会话里 ARGP 的 pressure check 日志只在 turn-1 出现一次（`contextTokens=0`，usage 锚建立前的空转值）；turn-2 无第二条日志且剪枝未发生——pressure check 的触发钩子覆盖面（每 turn 一次？仅首轮？）与 usage 锚的时序衔接需要一次代码级复查，本记录只对日志可见事实负责。
- 复测取证产物：`~/.dsh/sessions/--D-workspace-ARGP--/session-5e1ac918-388b-4790-ba32-0c6070c76727/`（解压件 `.tmp/session-retest.jsonl`：compaction 三对事件 + usage 逐请求记录）；首轮会话 `session-165d98aa-...`（0.3.0 时代）。压力工作区 `.tmp/liantest/`。
- 联调后 settings.yaml 已还原默认模型（glm），保留 llamacpp 条目 + 127.0.0.1 修复；web profile 插件已刷至 0.3.2；web 宿主进程留在 3080 供人工查看。

## 对 1.0.0 门槛的影响

P5-bis 实测（轮次放大 ≥3.2×）成立的前提是"窗口=声明窗口"；复测表明真环境需修两项才能兑现同叙事。**1.0.0 验收清单更新为三项**：①双引擎声明式挂载入口 + ctx.llm 真跑通（P0，原判维持）；②窗口口径归一（声明 contextWindow 进引擎阈值 + session-checkpoint-policy 处置）+ 真会话复测 ARGP 实际触发图剪（P1，改判后精确化）；③cites 块显示层剥离（P2，随显示层修复走）。

## §4 插件侧修复与第三轮验证（2026-08-28 晚，commit 10c584b）

P1 插件侧修复落地（发现二的 ARGP 部分）：①引擎缓存 `request/context` 事件的声明 contextWindow（WeakMap per session），`resolveScaledBudgets` 优先 requestContext() → 事件缓存 → 探测回退；②声明值未知时 pressure 检查宁缺勿错跳过（显式配置 windowTokens 不受影响）；③无 `argp-` 前缀的外来 `compaction/start` 打 warn（抢跑可见性）。质量门禁 184/184 绿。

**第三轮端到端验证（web profile + ModelScope Qwen3.8-Flash-Next，用户配置接入）**：

- **声明窗口口径修复实证**：threshold=**25,600**（32K×0.8）贯穿全部检查；contextTokens 锚定读数 20504→23234 连续真实（此前 0 或 9K 假值）。
- **外来压缩告警实证**：幽灵摘要器两次触发被实时告警抓住（turn 2，裸 UUID）。
- **幽灵危害升级实证**：本轮幽灵第三次运行"成功"但产出**空摘要**——UI 显示"上下文已压缩 压缩摘要不可用"，上下文被压掉而内容不可恢复。比 lossy 更糟：无损历史换来了零信息占位。幽灵 compaction-basic 绕过 disabled row 的机制未最终定位（所有 dump 视图均 disabled:true；源码无旁路 import；profile 本地 node_modules 与源码的 web-app patch 同为禁用）——已到上游问题边界，建议以本节证据向上游反馈（dsh-api-feedback 通道）。
- ModelScope 观察项：首 token 2.7s（显著快于本地 8-13s）、108 tok/s；`缓存命中 0%`（openai-completions 路径不回 cacheReadTokens，ARGP 锚定退化为纯 inputTokens，功能不受损）；thinking 默认开（reasoning_content 存在但 content 正确）。
- settings 注记：modelscope 两个模型条目已补 `contextWindow: 32000`（声明口径，驱动压缩阈值；如需真实物理口径可改）。

## §5 部署宿主更新与 rc.2 验证（2026-08-28 深夜）

部署宿主 `D:\deepseek-harness` 从 rc.7 更新至 **0.1.1-rc.2**（浅抓 tag `dsh-v0.1.1-rc.2` @ b150a55，pnpm install + 全量 build，200 产物）——与 dsh-argp 钉住的 `@deepseek-ai/dsh-*` 0.1.1-rc.2 API 对齐。注意：`D:\deepseek-harness`（部署）与 `D:\workspace\ARGP\deepseek-harness`（rc.8 快照，只读参考）共享 `~/.dsh` home，profile 内 argp 0.3.2 对两宿主同时生效。

**rc.2 部署宿主复测（web + ModelScope Flash-Next，压力任务）**：

- P1 修复在 rc.2 完整生效：threshold=25600 贯穿、锚定 15178→22471 真实、boot 零错误。
- **幽灵摘要器跨版本定论**：rc.2 上 turn 1 即两次外来压缩（裸 UUID）——排除"旧部署伪影"，`compaction-basic 绕过 disabled row`是当前上游（含最新 rc.2）的普遍行为，上游反馈证据链补全（rc.7 时代 UI 有 lossy checkpoint + rc.8/rc.2 有告警日志 + 三次运行两次空摘要错误一次空摘要"成功"）。
- 待办联动：P0 双引擎挂载入口后续验证一律以 rc.2 部署宿主为准（用户的真实环境），快照宿主退回只读参考位。

## §6 P0 双引擎生产挂载——修复与真宿主全栈验证（2026-08-28 深夜，commit a96fcbe）

发现一的插件侧修复 + 端到端验证，**1.0.0 验收第①项达成**：

**实现**（三件）：
1. `ArgpGraphConfig.peratom` 自挂载块：构造期挂三管线，`injectEdges`/`onOverflowCompress` 内部接线（显式同名键忽略并告警），`false` 关闭单管线；与 `mountPeratomStack` 同拓扑，测试/三臂工厂不受影响。启用方式=profile 用户层 patch 给 dsh-argp 行加 peratom config（bundle patch 保持 graph-only 默认）。
2. `resolveLlmRuntime`：属性访问优先（测试替身 loose ctx），抛错回退 `ctx.get('llm')`——真宿主 cordis 对属性访问做 inject 检查（`cannot get property "llm" without inject`），`ctx.get(name)` 官方语义即免 inject 读取。
3. compressor/declarer 生产诊断日志（`[argp-peratom]` 前缀：触发/候选/decision/LLM 失败），告别纯静默。

**rc.2 部署宿主全栈验证**（web profile + ModelScope Qwen3.8-Flash-Next，用户层 peratom config 指向 modelscope）：

- compressor：turn-1 触发，2u+1r 候选，32,459 chars prompt 经 ctx.llm 发出 → 175s 返回 **splits=2 extract=1**（usage 捕获）。
- declarer：同 turn 触发（from=6 to=0；turn-1 无 prior 原子，空声明正确——优化注记：to=0 可零调用短路）。
- 发射段：turn-2 pre-step 落账 **`argp-peratom-*` 事务**（compaction/start+end 无错），同 turn **`argp-graph-*` 图剪事务**亦触发（P1 修复后真宿主首次真实图剪）——**双引擎同会话协同，id 前缀区分**。
- 会话回答全程正确（130ms/retry=3/72ms 三问全对）；上下文注入面板出现两条 dsh-argp 行（graph+peratom 事件注入）。
- ModelScope aux 调用观察：32KB prompt 175s（慢但可用）；配额消耗约 3 calls/turn（compressor+declarer+可能重试），60 轮会话预估 ~180 calls——与 215/日额度同量级，长程实验需分日或切回本地模型。
- 新缺口注记：幽灵摘要器的"压缩摘要不可用"节点仍在（§4），它与 ARGP 的 replace 并存于同一会话——上游反馈更紧迫。

## §7 UI 插件通道核实与 P2 消解（2026-08-28 深夜）

用户指出官方 UI 是插件化管理——核实结果修正两件事：

1. **发现三（cites 泄漏）实际已消解，P2 划勾**。dsh-argp 的 client 半区（`src/client/index.ts`，v0.3.0 自带）注册 `assistantDisplay` seam（ui-conversation 官方显示层扩展点，注册过滤器在渲染前转换 assistant 块），rc.2 部署宿主当前会话实测 **cites JSON 已不可见**。早上看到的泄漏系当天早期部署态伪影（陈旧 0.3.0 / 未完成 client 组合），与发现二同款教训：**引用 0.3.2 行为前必须确认部署态新鲜**。
2. **peratom 可见性的正确通道与边界**。UI 对话节点渲染 = ui-conversation 的 `conversation.chat.node` keyed slot + 宿主侧节点投影。`CompactionNodeView` 只渲染**带 checkpoint 用户消息的摘要型事务**（幽灵摘要器那种），ARGP 替换型事务（peratom 内联 replace / graph tombstone）无 node key → 不可见。插件侧现状：graph 剪枝的 `[elided seq=N..M]` tombstone 是 surface 用户消息、UI 本来可见；peratom 内联替换要可见需投影层 seam（第三方 client 目前插不进投影）。**上游反馈清单合并为三项**：①幽灵摘要器绕过 disabled row；②替换型压缩事务的 UI 节点投影 seam（或第三方 chat.node 注册通道）；③cites 泄漏根因解释（client seam 0.3.0 已修，附验证方法）。

## §8 checkpoint 节点落地（2026-08-28 深夜，commit 23e8c43）

用户问"我们的不能做成带 checkpoint 的吗"→ 核查后**归因修正 + 实现**：

- **归因修正**：图剪的 `[elided]` 墓碑 0.3.x 起就带 `compactCheckpointSource`，宿主 `CompactionNodeView` 一直在为它渲染"上下文已压缩"节点——此前误归因给幽灵摘要器。节点显示"压缩摘要不可用"是因为 ARGP 不发 `compaction/summary`（宿主节点的显示文本通道），而非节点缺席。
- **实现**：①peratom `flushEntry` 的 user/message 替换副本 source 换为 compact checkpoint（tool/result 替换受宿主"只许改 content"硬约束不携带）；②peratom 与图剪事务均追加 `compaction/summary`（off-surface 日志事件，模型不可见），填诚实值（拆分/提取/摘要/保原文计数 + shadowed 计量 + aux 模型来源）。
- **设计修订并注明**：`compaction/prune` 仍是唯一权威账本（accounting 只读它），summary 仅供 UI 展示；对应测试改名守护，3 处位置敏感断言随事务序列更新，186/186 绿。
- **实测**：rc.2 部署宿主节点显示「已压缩 2 条历史记录（约 1720 tokens）」——替换型压缩事务首次在 UI 可见且带真实计量。
- 剩余边界：peratom 纯 tool extract 事务（无 user 替换）无 checkpoint 消息 → 无节点（summary 事件已落账，UI 侧展示需宿主支持 summary-only 节点，可并入上游清单）。

## §9 citesObligation 门控：回复级协议退役（2026-08-29，commit e8e9ea0）

用户追问"双引擎建边应搭压缩便车，回复里不该有 cites，是不是旧版残留"→ 全链路核查结论：

1. **不是残留，是双轨并行的现状**。`argp-cites` system section（order 151）自 v0.3.x 起无条件注册，从未有"declarer 上线即退役回复协议"的实现；设计 §7 的"搭便车主方案"也未落地（compressor OUTPUT_SCHEMA 只有 splits/tools，无 cites 字段），declarer 实为独立 aux 调用。
2. **UI 泄漏根因升级（并入上游清单②证据）**：rc.2 上游只发货了 `AssistantDisplayService` 类（`packages/client/ui-conversation/lib/types/client/assistant-display.js`，注释点名 citation JSON 场景）但**零接线**——无实例化、无 provide、渲染路径无 `.apply()`（实测页面加载的 ui-conversation 与 cordis-client-runner 服务 bundle 中 0 引用）。client 过滤器注册时 `ctx.get('assistantDisplay')` 为 undefined，按设计优雅降级。工作区 rc.5 快照连类都没有 → rc.2 是"类已进、接线未做"的中间态。
3. **实现（用户拍板：declarer 在即默认关）**：`ArgpGraphConfig.citesObligation?: boolean`，缺省 auto——`peratomStack.declarer.armed`（dsh-llm/endpoint 任一解析到）即不注册 `argp-cites` 段；未武装保持开启（两种边来源不能同时归零）；显式 true/false 覆盖（A₁-A₃ 实验臂强制开）。协议关闭不影响引擎侧 flush 剥离与 buildGraph cites 解析（偶发残留尾仍被消费为加菜边）。
4. **实测（rc.2 部署宿主，重装同步+重启后）**：同任务形态（read_file→回答 timeout），回复 **零 cites 尾**；服务端日志 `declarer: turn 1 from=5 to=0 (dsh-llm=true)` 确认结构化旁路建边接管；`compressor: turn 1 candidates=2u+1r` 正常；窗口 threshold 25600 贯穿（P1 持续有效）。质量门禁 190/190（+4 citesObligation 单测）。
5. **部署同步教训（再验证）**：pnpm 对 file: 依赖按 package.json 版本判变更，版本不 bump 时 `pnpm install`/`dsh plugin add` 均 "Already up to date" 不刷新副本——**必须手动整包复制**（rm + cp + 清 .git/node_modules）后重启宿主。
