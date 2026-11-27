# Changelog

本项目使用 conventional commits 记录变更，版本由 `package.json` + git tag 锚定。双分发渠道：**GitHub Release**（tag 驱动）+ **npm registry**（`dsh-argp`，账号 `yoza10635`）。

> **版本号说明**：1.3.2 为 npm 孤儿版本（bump 事务延迟完成上了 registry，unpublish 被 bypass-2FA 政策拒），`latest` 已指回 1.3.1；1.3.2 号永久作废，下一版直接 **1.3.3**。**1.7.1 从未发布**（无 tag、未上 registry，仅存在于工作树），其内容并入 **1.8.0-beta.0**，该版本号永久作废。

> **2.0.0 说明**：1.x 图引擎已退役，老方案冻结在 npm `1.11.2`（tag `v1.11.2`）。2.x 只维护 factor 引擎；老 profile 的 graph 旋钮宽容读 + 告警忽略。

## [Unreleased]

### Fixed
- **摘要调用的终态 `finish` 不再被丢弃（失败与取消可分辨）**。宿主 `LlmRuntime.stream()` 把超时、取消、provider 报错统一归一成终态 `finish` chunk 而不抛异常；适配器此前只认 `text-delta`/`usage`，四种性质不同的失败在调用侧全部塌缩成同一条「空摘要」警告，且**外部取消被当成“本轮不处置”返回 `null`**——违反 `compactNow` 的「取消必须向上传播」。现在适配器带回 `finish.reason`（`PeratomLlmResult.finish`），`classifyLlmFinish` 分流：`stop` 正常、`max-tokens` 记截断警告、`tool-calls` 明确「模型吐工具调用、适配器不回收」、`aborted` 在外部 signal 已取消时抛 `AbortError`（仅超时才保原文并明示“超时”）、`error` 带 failure 文案保原文。host 形态同步透传（`callLlmCtx` 曾把 finish 丢掉）。锁 `llm-adapter` 两例（finish 原样带回、五路分流）+ `dispatch-takeover` 两例（provider error 不落事务、外部取消必抛，均带“确实走到 LLM”断言）。
- **分派器的摘要发送判据改为以 host 形态为准**：发送可行性此前按 legacy A 形态算「可浓缩散文 transcript ×1.1」，而 2.3.0 起摘要实际回放 surface 头到 span 末的全部路由消息 + `tools`——输出预算被系统性高估，摘要请求自己会顶到窗口（被宿主钳成极短 checkpoint，严格端点直接 400）。现在 `roomForOutput = W_eff − C − 指令 − 2%·W_eff（tools/分词面余量）`，`outBudget` 随之收缩；C 贴窗时本轮改走仅剪，等下一轮新前缀热起来再摘。随之撤销「剪不剪工具，摘要请求一样大」的旧论证（host 形态下剪枝确实会缩小摘要请求，但先剪打断热前缀会让摘要掉回全量 prefill，故 `prune-then-summarize` 仍不发射）。锁 `dispatch` 用例：C=63.5K/64K 由「先摘后剪」翻为「仅剪」、三域摘要行与 T42 仍放行、不变量改为 host prompt。
- **多文件读的可再生性判定改为逐文件对比**：`regenerable` 此前拿 `files[0]` 的当前快照去和该 R 的**全部**文件基线比，一次读多个文件时必然不等 ⇒ 恒判不可再生（该剪的剪不掉，占用虚高）。现在每个文件与自己的基线比 mtime+size，全部未变才算可再生。锁 `factor-engine` 一例：两文件均未变 ⇒ 最新轮也能凭再生证明先剪；任一已变 ⇒ 回落旧者先剪。
- **`search_history` 冷启动与另两个召回工具对齐**：它此前用 `ledgerOf`，新进程首查时账本还没从日志重放 ⇒ 工具带恒零候选（散文带不受影响）；改用 `ledgerForRecall` 后 `recall_history` / `list_labels` / `search_history` 三个入口的冷启动语义一致。锁 SH17（新引擎实例首查 tool×1）。
- **CI 提交信息检查真正生效**：`.github/workflows/ci.yml` 的 `${{ github.event_before }}` 不是合法 context（应为 `github.event.before`），展开为空串 ⇒ 范围退化为 `HEAD..HEAD`，`check-commit-msg` 恒过。修正后推送才真正校验提交信息规范。

### Changed
- **`/argp` 增加世界指纹（env 派生档 + 生效时机）**：新增 `env-world.ts` 把 9 枚 `ARGP_FACTOR_*` 与 peratom 调试开关收成一次聚合——显示的是 resolver 的**派生档**（非法值显示缺省，不照抄原始字面）、标注 `@boot`（构造快照，改 env 须重挂）或 `@live`（每请求活读），并原样回显显式设置过的 env。出口闸线取当前「压缩阈值」，与真实发射判据同源。既有 env 名称与语义一概不动（老启动脚本/对照臂保持有效）。锁 `config-roster` 四例（缺省世界、非法值派生、阈值优先、卡面渲染）。
- **热路径去掉重复全日志重扫、覆盖判定去掉二次方**：`factor/engine` 的被遮蔽 seq 改走 `recall.ts` 的增量账本（同 session 游标，只扫新追加事件；口径与 `scanShadowedSeqs` 相同，L9 双向锁），`decide`、发射后复核、桩判定四处不再各自全量重扫；`supersededMarks` 改为按文件分桶 + 二分定位后续读（原先每对候选都跑全量 `files.includes`，O(R²·F)），语义等价由 300 组随机对照锁死（`superseded-marks.test.ts`）。**仍未做**：每次 `decide` 的全量重贴标（`tagRsFromLog`）——决策面消费全量标签表，增量缓存需先定义 replace 链增长的失效规则。
- **长会话内存结构有界化**：`FactorLedger.observed` 与 `shadowedSet` 从 `Set<number>` 换为 `SeqBitset`（seq 稠密，1 bit/seq；10 万事件约 12.5 KB，替代 `Set` 的 ~30–40 B/项）。两者**不截断**——丢一枚会让重放双计 sticky 失败、或把已剪节点谎报成 live。`sticky` 轨道上限 1024（优先淘汰已闭集、其次最旧；窗内保护不变），`prunedNodeIndex` 明细上限 4096 并用单调计数 `prunedNodeTotal` 供 `/argp` 报数（不再因淘汰少报）。`entries`/`inverted` 不设上限：按标签取回的承诺覆盖全部被剪原子。锁 `factor-ledger` 四例 + `seq-bitset` 四例 + `logic-locks` L11。
- **日志读取后端收口为可替换接缝，并对宿主弃用面加探针**：宿主把 `eventAt` / `snapshotEvents` / `ownEvents` 标为 `@deprecated … new calls are prohibited`，而 ARGP 是同步引擎（`decide()` 不能 await）——依赖无法消除，但迁移面收敛到一处。`log-access` 新增 `LogBackend` 接口（`snapshotEvents` 与 legacy `events` 两个同步实现，按 session 弱缓存），`sessionEvents`、新增的按位读取 `eventAt` 与 boot 探针 `inspectLogAccess` 共用同一后端对象；`prose-condenser` 的 `buildCtxInput` 不再直接调宿主 `session.eventAt()`。`bindSession` 首次绑定打印一行 `[argp] log-access backend=… length=…`；`scripts/doctor.mjs` 增加宿主声明文件探针（`snapshotEvents`/`eventAt`/`events getter` 是否仍在），三者皆无时退出码 3 并给出迁移提示。锁 `session-events-compat` 三例（后端判别 / 按位读取与越界 / 探针报告与报错）。
- **死代码与过期头注清理**：`tombstone-text.ts` 移除零引用的 `isToolTombstoneText` / `isTombstoneText` / `TOMBSTONE_GRAMMARS` / `seqSpan` / `seqsSpan` / `RETRIEVE_HINT` 与两枚前缀导出（`isMergeableTombstoneText` 保留——它仍是 `prune-tx` 与散文浓缩的活判据），头注重写为「只读识别，不生成文案」；`llm-adapter.ts` 头注删去不存在的 fetch 后端 / `response_format` / 多模型分工，并标明 `serializeWireMessages` 仅测试探针使用；`client/index.ts` 移除 assistantDisplay 过滤器遗留接口与相关注释；`factor/engine.ts` 修正「A 永不入剪枝区间」「剪成空克隆」两处与实现相反的注释；`argp-engine.ts` 修正出口闸缺省态注释（接管=开）。删除两处不可达分支（`planProtocolGroups` 的无 R 非 forced 判定、`prose-condenser` 的 `intervals.length===0`）。

### Removed
- **死 API 清理**：`HardFlags.protocolUnclosed`（全库无赋值）、`HardFlags.node0`（仅测试赋）、`RTags.argsFp` / `cwdSeen` 及 `canonicalArgsFp`/`canonicalJson` 计算（生产零消费者，"失败-重试配对键"从未实现）。顺带省掉每枚 R 的 args 规范化 CPU。

## [2.3.0] - 2026-11-27（minor 直发：词表目录迁 `systemPrompt.context`；每请求缓存审计；出处语义收紧为三句话并撤销五态标记；手动压缩摘要改宿主装配（缓存 0 → 98.8%）；缓存告警门限按块粒度修正；1.x 死字段清理；无新增配置面）

### Added
- **每请求缓存审计（`/argp` 段 5 + 日志）**：压缩是否打断前缀缓存，此前只能靠首字延迟反推（混入排队/采样噪声）；现在直接读 provider usage——`inputTokens`（未命中，必须真 prefill）与 `cacheReadTokens`（复用前缀）互斥，`prompt = 未命中 + 命中 + 写缓存`。每次带 usage 的应答落一条会话桶采样（有界），归因到最近一次**成功**收尾的压缩事务（`compaction/end` 无 error；失败事务不置游标），并区分四类：压缩后**首请求**低命中 = 保留段整条重灌（必然代价，info）、同一次压缩后的**续作**仍低命中 = 另有抖前缀源（warn）、首请求高命中 = 追加式续作、无事务低命中 = 冷启。小 prompt 的低命中不报异常（门限按块粒度取 8192 token，理由见 Fixed），避免冷启噪声淹没真信号。`/argp` 露出最近 3 条 `prompt/cached/命中率` 与「重灌 / 续作失配」计数。锁 `test/cache-audit.test.ts` 十一例（互斥求和、四类判定、失败事务不置游标、跨轮陈旧标记、状态卡行文）。

### Changed
- **证据被剪 ≠ 结论改判（摘要与检查点的出处语义，最终形态：三句话）**。病灶不是幻觉而是**出处丢失**：剪枝删掉工具结果后，助手结论仍以散文留在面上，摘要再把它压成检查点；原检查点框架语 "Treat the captured context as established background" 单独存在时，等于把整份摘要（含未经确认的推断）都读作既定事实——结论可能仍然正确，但模型看到的是高置信、无出处的断言。最终只落三句话（写侧）+ 一句读法（读侧），不引入任何标记：① 写侧摘要指令——承重结论要说出来源（工具输出 / 用户原话 / 自己的推断），判不清就如实说、**不许编来源**；支撑证据可能已被压走，**它既不确认也不反驳结论**，不得据此把结论写得更确定或更不确定，要给读者指召回而不是替他猜；纠正双边可见（`X (was corrected by Y)`，不删被纠正项），未决项写明"什么观察能定案"、猜测不得冒充决定。② 读侧：`CHECKPOINT_PREAMBLE` 与宿主基线**故意分叉**——"既定背景"限定为**连续性**，并补"证据可能已被压走 ⇒ 既不确认也不反驳，要证据就召回"；词表引导（`systemPrompt.context`）同位一条 **Elision is not a verdict**。③ **撤销一度引入的五态标记**（`[observed]` / `[user]` / `[inferred]` / `[observed, evidence elided]` / `[provenance unknown]`）：摘要发生在剪枝**之后**，摘要器看不到原始证据，标记只能靠它自述——标错比不标更有害（读者会把它当出处权威），且每份检查点常驻 ~65 token、每次摘要 ~250 token。锁 `test/provenance-contract.test.ts` 五例，其中一条是**反向锁**：写侧/读侧重新出现上述标记即红。
- **动态词表目录迁到 `systemPrompt.context`（会话快照）**：压缩事务成功收尾时冻结本会话目录（账本 epoch + 渲染文本），provider 只读快照、不读 live ledger；两次事务之间字节稳定。宿主在 `pre-step` 之后、发请求前 `refreshContext` 会重新求值 context，故本次压缩请求即可看到新目录，而 system section 保持稳定；无 `systemPrompt` 服务的宿主继续走原词表 note 回退，注册成功后不再写 note 目录，避免双份目录与 steer 失败导致地址不可见。

### Fixed
- **缓存审计的告警门槛按块粒度修正（1000 → 8192 token）**。实测（`spike/51-cache-refill-probe.ts`，真端点）：provider 前缀缓存按**块**命中，所有 `cached_tokens` 都是 2048 的倍数；一次把 19 万字符压到 3.2K 的压缩之后，请求 prompt 只剩 1,011 token、cached=0——按旧门槛（≥1000）会被判成「压缩后续作又失配」并 warn，实际是"块粒度未达"。门槛改 8K（≈4 块），`/argp` 的 `refill`/`repeat-miss` 标记与两枚计数同用这一道门，避免卡面自造噪声。
- **手动 `/compact` 的摘要调用改走宿主同款装配（缓存命中 0 → 98.8%）**。旧路径 `callLlm` 重建 `U:/A:` transcript：**没有 system 头、正文带行内角色标记**，与主对话请求从第 0 个 token 就不同 ⇒ 前缀缓存必然全量未命中。实测（真端点）：一次 118,135 token prompt / `cached=0` / 33.3s。改为 `CondenseDispatch.form:'host'`（与 `approved` **正交**：只换输入形态，不继承分派器的闸一豁免与淘汰口径）后，同一请求 `cached=116,736`（98.8%）/ 14.0s；host 形态也回填 `compaction/summary.usage`，手动压缩的缓存命中从此可核。锁 `dispatch-takeover` 两例（host 形态取 header 路由 + tools 透传 + usage 回填；未过闸一仍零 LLM）。
- **旧 A 形态摘要调用的账单可见**：`callLlm` 现在把 `completeViaDshLlm` 的 usage 带回，压缩收尾落一行 `摘要调用 usage: prompt=… cached=…(…%) [legacy A-form]`（仅无 `form:'host'` 的旧宿主/对照臂会走到）。不改其行为（legacy 不写 usage meta 的既有契约保持），只让成本可见。

### Removed
- **`PrunedNodeInfo.latestOfPath`（1.x 版本链死字段）**：注释写"被剪旧快照 recall 时指向同路径最新存活版本的 seq"，实际全仓零写入零读取——它许诺的能力从未实现。也不实现：`recall_history(labels, view:'outline')` 已逐行列出同一标签的全部版本（`item=<seq> · turn=<n>`），且 `order:"fresh"` 按新到旧排序；更晚的同类观察若仍 live 则本就在可见面上。再加一层"新旧指针"只是重复列表信息，还会诱导模型把"这版旧"推论成"结论错"。

### Docs
- **对外口径按实测收窄**：README 两条卖点改写——「遗忘可撤销」补上约束（逐字取回受召回字符预算限制，被剪节点不回原位："撤销的是读不到，不是没剪过"）；「不打碎前缀缓存」改为「缓存断点只在压缩时机」（一次事务必然让保留段在压缩后首请求重灌一次，97.8% 是跨轮稳态口径）。已知限制新增「压缩后首个请求必然重灌」（附实测 239.5K prompt / ≈0.2K 命中 / 47s 首字，并指向 `/argp` 的 `cache` 段区分 refill 与 repeat-miss）。ARCHITECTURE §3.3 改写为 **「出处语义（证据被剪 ≠ 结论改判）」**（写侧三句指令、读侧框架语、刻意不做的标记体系及其理由、锁面）。

## [2.2.2] - 2026-11-27（stable 直发：两起"落盘静默成功、重启整档拒载"封堵；三代理独立审查修复批；压缩统计口径与用户文案重做；1.x 遗留清理；无新增配置面）

### Removed
- **1.x 遗留物清理（图引擎退役后的死码与死文案）**。扫描口径 = 导出符号在 src+test 的零消费者 + 1.x 词汇在活代码中的残留。删：① `toolTombstone` / `toolTombstoneSummary` / `factorAssistantTombstone` 三个生成器（全仓零消费者；`compactClipArm` 那枚死 import 一并删）；② `retrieve()` 与 `seqRangeTombstone()` —— 它们是 `recall_pruned(<seq>)` 的**最后两个生产者**，而 2.x 只注册 `recall_history` / `list_labels` / `search_history`，即模型可见文案在点名一个**不存在的工具**（比不留指针更糟：模型会去调一条没有的通道并自信失败）；`pruneIntervals` 的 `tombstones` 参数同时改**必填**，缺省回退分支连同这一类文案结构性消失；③ `semanticEdges` 形参与 `GraphPruneRecord.semanticEdges` 字段（四个调用方恒传 0，是 1.x 引用图的边数记账）；④ 测试夹具里的幽灵配置键 `tombstoneMergeMinRun: 8`（`PruneTxHost` 既不声明也不读取，活缺省是常量 `FACTOR_STUB_RUN_MIN = 2`，留着纯属误导）。**保留**：历史墓碑文法正则与 `RETIRED_GRAPH_KEYS` 键名——存量档案逐字识别 / 老 profile 宽容告警所需，不是活路径。新增锁 **⑩ 词表纪律**（事务写出的 surface 文本含 `recall_pruned` / `list_pruned` 即红；变异自证：注入退役名 ⇒ ⑩ 立即红）。全量 390 例（388 通过、2 跳过、0 失败），行为逐字不变。

### Fixed
- **协议组闭包：部分选中不再整组空转（零释放静默失效）**。`planPrune` 逐枚原子累计达标（`retention-score.ts:217-229`，`takenChars += gain; if (takenChars >= target) break`），对 A+R 成组零感知；而发射门 `planProtocolGroups` 要求**全组 R 都已被选中**（`defined.every(selected||stub)`）才允许整组离场。错配后果：部分选中的组被整组 `continue` 留下，但这些 R 的字符**已经**算进 `releasedChars` ⇒ `shortfallChars` 归零 ⇒ 既不剪也不 warn（旧 warn 判据是 `shortfallChars > 0`）⇒ **静默零释放空转**，窗口继续上涨（实测 `seed23 round4/5：selR=13 / held=13 / res=null`，chars 65013→65778）。这是 2.2.2 废止「空 tool/result 克隆桩」后暴露的缺口——v2.2.1 不停摆恰恰是因为它把这些散 R 用毒桩发出去了。改：① 门改**闭包** `defined.some(...)`：组内至少一枚 live R 被选中 ⇒ 整组（A + 全部 live R + 夹心节点）一起离场、一条 user 检查点；`seqSet` 本就收录该 A 的全部 live R，故只是放开一道门，无新增结构。依据：调用块长在 A 里，A 离场后单独保留其余 R 无语义，"打包带走"本就是原子定义。② **硬保护一道不放宽**：焦点/open 轮的 turn 与位置守卫（L456-462/484-487）、附件 sibling（L469）、surface 不连续（L483）、无 R 的 A（L470）全部照旧拦。③ 缺口口径修正：held 与附件保留量计入真实缺口 `gap = max(shortfallChars, heldChars)` 并**必 warn**，"一笔不释放"从此不可静默；`releasedChars` 语义降为下界（闭包会超计划释放）。锁 `test/group-closure.test.ts` 五条（闭包成组 / 无选中不动 / 附件阻断 / 焦点阻断 / 不连续阻断），**变异自证**：`some` 改回 `every` ⇒ ① 立即红。全量 389 例（387 通过、2 跳过、0 失败）。
- **cites 剥离死路径清理（1.x 协议残留，2.x 不再要求模型输出 cites）**。`stripTrailingCitesIfNeeded` 以 `surfaceOp:{op:'replace'}` 改写 `assistant/message`，而宿主两条约束互斥：写入侧要求"replace 的 `sourceEventSeqs` 必须覆盖全部被遮节点"，同时 `assistant/message` 自带 provider stream、**禁止**携带 `sourceEventSeqs` ⇒ **两种形态都必抛**（实测：不带 ⇒ `must include every shadowed surface node`；带 ⇒ `embeds its source stream and cannot carry sourceEventSeqs`）。后果三条：① 该剥离自 2.2.x 起**从未生效**（`{"cites":[...]}` 残差一直留在模型可见文本，`argpCites` 恒空），调用点的 `try/catch` 把宿主报错吞成静默；② 为它配的写侧守卫 `canAppendSurfaceReplace` 是死代码，且其类型联合收录 `tool/result` —— 对轮内 tool/result 返回 `true`，等于给未来调用方**放行事故形态**（正是两起整档拒载的毒形状）；③ `test/strip-cites.test.ts` 用替身 session 断言"守卫必须放行"，把真宿主必然拒收的形态当红线锁住 = 局部假绿。删：函数体 + 微任务调用点 + `canAppendSurfaceReplace` + 其守卫用例。**保留**仍在真用的两处读侧：`atomize.extractCites`（解析历史会话 A 原子的引用图 + `CiteStats` 诊断）与 `client/index.ts` 的 `stripCitesTail`（1.x 时代存档的人类转录显示剥离），以及 `atomize` 对 `data.argpCites` 的归一化读（历史兼容，零成本）。全库 surface replace 发射点收敛为**二**：`prune-tx` 组剪检查点、词表 note，皆为 `user/message`。
- **1.x 引用协议（cites）子系统整体摘除（续上条，2.x 不向下兼容）**。cites 是图引擎时代的**引用边**协议，2.0 factor 退役图引擎后召回按实体标签寻址，**没有边召回这条路**——`Atom.cites` / `Atom.citesFailed` 在 src 中只有写入、零读取，`CiteStats` 只有累加与一个无人调用的 getter。删：`src/cites-strip.ts`、`test/cites-strip.test.ts`（16 例）、`extractCites`、A 分支的 `data.argpCites` 三形状归一化读、`CiteStats` 全链（atomize 累加 → session-state 存储 → `argp-engine` getter）、`client/index.ts` 的显示剥离（去掉剥离后该注册恒等直通，连注册一并删除）。**保留**两处**逐字历史字面量**（不是活路径，也不是兼容层）：`tombstone-text.ts` v1.3–v1.7 历史墓碑文法正则（存量会话重放需逐字识别）、`session-lifecycle.ts` 退役配置键 `citesObligation`（老 profile 宽容告警按字符串等值匹配）——二者曾被误以 `[i]` 字符类 / `\u0069` 转写来规避关键字扫描，已还原为原文。后果如实记录：若模型因历史惯性再吐尾随 `{"cites":[...]}`，UI 与 A 原子文本都将**原样承载**（此前唯一隐藏层就是那个客户端过滤器）。用例净减 22，全量 389 例 0 失败。
- **半截事务毒 prune（第二起整档拒载事故，三代理独立审查实机复现）：区间落点重导 + 重叠复核 + 轮号 -1 哨兵拒发**。事故形：散文浓缩在 LLM **之前**取整段 span 快照（`prose-condenser.ts:415`），等模型数秒后才发射（:491）；窗口内任何 surface replace（宿主原生 `toolResultPruner`、外来压缩引擎）落在 span **中段**时，summary 守卫只校验首尾两点 ⇒ 整笔放行 ⇒ `compaction/prune` 按**陈旧 seqs** 落盘 → 紧随的 replace 被写入侧拒（`sourceEventSeqs must include every shadowed surface node`）→ catch 只补 error end ⇒ **毒 prune 永久留在日志**；加载侧对每条 prune 无条件跑 `span()`（error end 关闭的事务同样校验）⇒ 整档拒载。复现件：单区间 `[1,2,3,4]` + 中段 2 被外部替换 ⇒ 旧码落盘 `prune.shadowedSeqs=[1,2,3,4]`（2 已离面）。修：① `compaction/start` **之前**用现读 surface 重导每个区间 = 首尾之间的当前连续切片（切片内新出现的节点本来就会被本次 replace 覆盖，必须进 claim），首尾任一离面 ⇒ 拒发；② 位置序排序**之后**做重叠复核（按喂入序判会把正常倒序喂入误拒）；③ `detectOpenTurn()` 的 `-1` fail-closed 哨兵不再当轮号写进 `compaction/*.turn`（宿主 `sessionFormatCount` 要求非负，-1 整档拒载），改为事务前 throw。锁 **⑨ 落点重导**（正向：外来替换落在中段 ⇒ 事务成功且声明全在场、n2 不入声明）+ **brackets ②/②b 改写**（陈旧区间现在**零事件落盘**；受保护 system head 仍锁"start 之后抛 ⇒ 必补 error end"）。
- **压缩统计三处失真（rev-search 复核）：历史体量重复计入、记账事件充数、释放量口径说反**。① `estimateHiddenHistory` 原把**中间替换副本的文本**与它所代表的原文**都**计入（实测两层链虚高 3.39×：原文 10,000 字 ⇒ 报 36,900；可达路径 = 夹剪组检查点头尾预览 ~26K、散文检查点 ~20K、旧检查点被后续 span 吞并 ⇒「摘要的摘要」每层多计一层）；改为**只计量叶子**。② `compaction/*`、`turn/*`、`step/*` 被算进「原始事件条数」（实测 1 条真历史报成 4 条）⇒ 此前对外引用的「145 枚桩代表 475 条原始事件」同样被这条污染，需按新口径重算。③ `estimateSurfaceRelease` 的 docstring 把因果说反——压缩**瞬间** UI「上下文使用量」的即时降幅走宿主 `deltaTokens`（÷4、且 `iv.chars` 经 atomize 排除 reasoning），不是这个含 reasoning 的 CJK 估算（后者与**下一发真实 usage 的 prompt 降幅**同阶）；文案措辞与注释改正，并改为**净释放**（扣掉本次写回的检查点文本；归并 145→31 时回填仍占位）。④ 新增 `capped` 标志（`MAX_NODES` 截断不再静默偏小）。锁 history-estimate 第三条（输入只给最新一枚桩 ⇒ chars 恰等原文长度、originSeqs 恰 1 条）。
- **压缩回执计数失真（rev-search 复核）：「已压缩 N 处工具调用」约 2× 虚高 + 类目错配**。`prunedCount = Σ atoms.length` 而组区间的 atoms = **1 枚 A + n 枚 R** ⇒ 一次调用报 2、三次报 6；用户句改用 `toolCalls`（R 原子数）。散文 atoms 含被吞并的旧检查点（X）⇒ 段数剔除 X。`dedupeReinjected` 驱逐的是宿主再注入三件套副本（runtime-context / skill-catalog 的 U 原子），却复用 `factor-prune` 文案说成"工具调用历史" ⇒ 新增第五种 `injection-dedupe`（「已清理 N 条重复的系统注入内容」）。未知 kind 不再回落默认句式（宁可 throw，也不给计数口径错误的用户文案）。
- **压缩回执改成用户能读懂的话并补「原文可找回」承诺**。旧摘要形如「ARGP 墓碑归并（§11.8①）：145 墓碑 / 31 区间归并为聚合占位（约 327 tok 回收）」——§编号、墓碑、surface、原子、聚合占位、0-LLM 全是开发者黑话，装插件的普通用户无法理解。新增 `src/compaction-report.ts`：① 四种事务统一成「做了什么 + 省了多少 + 原文还在」句式（如「已压缩 12 处工具调用历史（约释放 19.4 万 token）。原文仍在日志里，需要时可逐字找回。」）；② token 数走「万/千/个」可读格式；③ 释放量改用 CJK 自适应估算（`estimateSurfaceRelease`，按节点真实文本面，中文不再被 4 字/token 低估），与宿主记账字段 `shadowedTokenCount` 解耦；④ 精确口径（nodes/intervals/host_shadow_tokens/history_tokens/…）降级为 `host.log.info` 的 debug 行，不进 UI。锁 `test/compaction-report.test.ts`：四类文案不得含术语、必须含找回承诺、万/千格式、CJK 估算不低估；`stub-run-reclaim` 的摘要 needle 同步改新文案。全量 411 例（409 通过、2 跳过、0 失败）。
- **压缩统计口径拆分：`surface 释放` 与 `历史体量` 分报，不再把 §11.8 归并的 300 余 tok 当收益**。事故：00:30 手动 /compact 的归并事务（145 墓碑 → 31 聚合占位）日志只报「约 339 tok 回收」——`shadowedTokenCount` 按被替换节点（9 字桩）文本 ÷4 计（宿主 token-meter 记账口径，**保持不动**），而 145 枚桩经 `sourceEventSeqs` 链代表的历史是 **475 条原始事件 / 824,761 字符**。修：① 新增 `src/factor/history-estimate.ts`——沿 `sourceEventSeqs` 递归解析桩背后的历史原文（全局去重、CJK 自适应密度 3.5/1.7 估算），输出「历史体量」；② `pruneIntervals` 四种摘要文案与日志统一改为「surface 释放 ≈ X tok；历史体量 ≈ Y tok（Z 字符 / N 条原始事件，估算）」，归并事务措辞为「增量 surface 释放（仅桩文本合并）；代表历史 ≈ …」；③ 不写入任何宿主契约字段，token-meter 记账与召回账本零变化。锁 `test/history-estimate.test.ts`：桩文本口径（≈6 tok）与历史体量（≈2000 tok）必须分离、链式解析回到同一原始事件且全局去重。全量 407 例（405 通过、2 跳过、0 失败）。
- **存档加载失败根修（取代同日两项止血）：ARGP 彻底不产 `tool/result` 形态的 surface 桩；C10 夹剪改走组检查点文本**。事故复盘（session-43df801e）：宿主 v4 fold 对非 append 的 `tool/result` 执行 `requireTurn()`、对 system/developer/assistant replace 执行 `requireStep()`，而压缩事务可落在轮间隙（手动 /compact 走宿主 idle maintenance，实证 `compaction/start.data.turn === null`）；写入侧 `Session.append` 只校验 content-only、**不校验轮** ⇒ 当场成功、下次加载整档判 corrupt 拒载。止血版（半拆不剪 / prune-tx 无轮剔除 / 夹剪臂整臂跳过）只是把已知形态挡在门外，仍残留「计划时判轮 vs 落点判轮」与功能损失。根修：① `pruneIntervals` 的 tombstone 类型收窄为 `{type:'user'}`，tool/developer 形态**整类删除**（运行时结构锁：非 user 墓碑在事务前 throw）——surface replace 只剩与轮/步状态无关的 user 检查点；② C10 夹剪从「改写原 R 节点本体」改为「组剪检查点的文本变体」：组选择/保护/守卫与 clip 关闭时相同，clip 只决定检查点是否携带该组 R 的头尾预览（`groupCheckpointText`），轮内/轮间隙行为一致，删 `compactClipArm`/`stubText`/`replacementText`；③ 残余非 user replace（cites 剥离的 assistant replace）加**写侧落点守卫** `canAppendSurfaceReplace`（append 前一刻读日志尾状态，逐条复刻宿主 requireTurn/requireStep；无法判定的宿主替身保持旧行为）；④ 锁换成**宿主真实校验器 oracle**：`test/surface-fold-legality.test.ts` 直接 import `assertReleasedV4Relationships`，轮内/轮间隙正向日志必须被宿主接受，轮间隙手工补一枚 tool/result replace 必须被宿主拒载（阴性对照自证判别力）；`prune-tx-order ⑥/⑦`、`factor-clip CL4/CL10` 同步改标。全量 404 例（402 通过、2 跳过、0 失败）。
- **夹剪臂轮间隙地雷：无开放轮整臂跳过（`tool/result` replace 的最后一个生产点）**。`compactClipArm`（`ARGP_FACTOR_CLIP=1` 对照臂）是 2.x 里唯一仍会发「非 append `tool/result`」的路径：它以 `replace(startSeq=R.seq, endSeq=R.seq)` 改写原 R 的 inner text 保 callId 配对，而宿主 v4 fold 对这类节点执行 `requireTurn()`——手动 /compact 可落在轮间隙（存档实锤 `compaction/start.data.turn === null`），此时该形态**无任何合法表达**，下次加载整档判 corrupt 拒载。修：① 调用点先判 `detectOpenTurn(session)`，无开放轮 ⇒ **整臂跳过并回落标准组剪**（用户检查点不受轮约束，压缩照常发生，仅失去夹剪收益；半拆缺口照旧进 shortfall 账）；② `compactClipArm` 内部加同判据二次防线：非 issuer 离场的 R 一律不剪、不落桩（warn 计数），防未来调用点绕过。锁 **CL10 轮间隙锁**：夹具 `openTurn:false` 复刻轮间隙，断言发射后零「非 append `tool/result`」（该判据即宿主 fold 的 corrupt 判据）。〔同日根修后该止血版整体被取代：夹剪不再跳过而是改走组检查点文本，见上条〕
- **补召轮 0/7 根因：冷恢复「窗口初值伪装已解析值」**。`session-state` 桶的 `resolvedWindowTokens` 初值 = `DEFAULT_WINDOW_TOKENS`(16,384)，只有 `resolveScaledBudgets` 跑过才会被真实声明窗覆盖；而出口闸关闭、本进程无压力事务的低压力轮（headless resume 每轮新进程）**全程零次解析**，散文检索面 cap = `window × charsPerToken × 2.7` 便按 16K 种子算——262K 声明窗会话实测 cap=110,861，与事故指纹逐位吻合，素材页整程不进检索带。修：`restoreDeclaredWindow` 回填声明窗的同时向会话桶播种 `min(声明窗, observedCap) × windowRatio`（显式窗配置让位、首次真解析自然覆盖）。锁 L7 三态 + 变异账 LL7。
- **检索不可翻页：`search_history` 新增 `offset` 续读游标**。旧行为散文带「cap 触线即 break」且页脚只说 retry/refine——重试恒从最旧重扫，更新内容永远出不了界；`hit=` 二跳对超长原文只回头部切片、"retry next turn" 是空承诺。修：扫描侧改**事件对齐选择窗** `[offset, offset+cap)`（首事件超 cap 照收防分页死锁），二跳侧按 offset 切读取窗；两处页脚如实给 `offset=<next>` 续翻指针与总面读数，越界如实报而非返回空文本。锁 SH15/SH16。
- 定点回放（`spike/08-recall-cap-replay.ts`，真存档→真 Session→真工具面，金值只在进程内比对）：修复前 0/7、修复后 **7/7**；全量套件 390 例（388 通过、2 跳过）。
- **桩游程治理：相邻同文检查点两层归并**。真存档审计（session-43df801e）：114 组扫荡在表面产出 **96 连排同 9 字压缩检查点桩**——角色交替破坏（模型读到「用户连说 96 遍同一句话」），且桩常规通道双盲不可回收（atomize 判 X + prose 三桶 own-kind 排除 + §11.8 图臂归并通道已退役）⇒ 跨事务累积泄漏。修两层同判据（surface 位置紧邻 + 文本逐字节相同）：**事务内**`pruneIntervals` 发射前归并 pass 把相邻同文 user 墓碑区间传递并条（新游程不再产生；交互桩异文不并、tool/developer 结构桩类型门豁免）；**跨事务**`reclaimStubRuns` 在主压缩事务落地后顺带扫表面 ≥`FACTOR_STUB_RUN_MIN`(2) 同文游程发一笔 `tombstone-merge` 并条（**绝不独立发维护事务**，换代税只交一次；归并后游程塌缩为 1 ⇒ 收敛）。零桩不是 API 可达形态——shadow-price 契约要求每个被剪区间留原位节点，「一段游程一枚桩」即上限。锁 prune-tx-order ④⑤⑥ + stub-run-reclaim RR1–RR3；G1/FT6/CL2 桩数锁按归并语义改标；全量 396 例（394 通过、2 跳过）。
- **`tombstone-merge` 摘要文案收口**：取回通道指称由退役工具名（recall_pruned/list_pruned）改为现势双通道 `search_history(keyword) / recall_history(labels)`；归并事务计数改取表面节点数（其区间 atoms 恒空，atoms 口径恒报 0）。
- **存档加载失败根修：半拆组「空 `tool/result` 桩」分支废止（打包带走裁定回归本义）**。真档事故（session-43df801e）：轮次间隙手动 /compact 的事务落 6 枚 `tool/result` replace 桩——宿主 v4 fold 要求非 append 的 tool/result 必须处于**开放轮内**，写入侧（`Session.append` 核心）不拦、加载侧整档判 corrupt 拒载（d66bc041 同款 1 枚；全语料 175 档扫描 2 档中招）。修两层：① factor 组剪半拆（issuer A 在世只剪 R）与不连续回退**一律改为不剪**（组不齐 ⇒ R 随活体保留、缺口进 shortfall 账，「A+R 打包带走」字面执行）；② `pruneIntervals` 预检加**无开放轮剔除**：`detectOpenTurn===null` 时一切 tool 桩区间剔除+warn（clip opt-in 臂同受罩；不可降级 user 桩——issuer 广告仍在，孤儿 tool result 撞 provider 400）。自动路径恒在轮内 ⇒ 常态零行为变化。锁：prune-tx-order ⑦（毒形态结构性缺席）+ G2/G10 改标不剪 + ⑥/CL/ZT2 fixture 补 `turn/start`（照实 pre-step 在轮内）；G1/FT6/CL2 桩数口径不变。

### Docs
- ARCHITECTURE 新增 **§3.1 账本三本分治**（prune=召回权威账本 / summary=发射时点 span claim（宿主 fold 计价契约，非召回依据）/ records=引擎视图），以 session-43df801e 的 343 vs 260「超声称」为实锤案例——审计口径钉死：**剪没剪只查 prune**；**§3.2 桩游程治理**两层机制与豁免面。

## [2.2.1] - 2026-11-26（stable 直发：分派判据规则A + A1 焦点名额；行为调优班车，无新增配置面）

### Changed
- **分派判据②③由「释放量预测」改「存在性判据」（规则A）**：旧口径问「total 散文补不补得上缺口」，新口径问 **aged（整轮 span 实际可驱逐口径）≥ 开单地板 max(1536, 5%·W_eff)**。扫荡式 span 整吞下 total 远超 aged（T36 aged 38K 实吞 115K），缺口口径把 T42 型负载推成浅剪连发；反事实回放合形 ~32% vs 浅剪连发 ~15.4%。判据①缺口地板与④transcript（total 口径）不动。
- **决策序 3.5 新增份额闸**：工具面（toolCallA+rPair）/C ≥ θ(0.5) ⇒ 仅剪。θ 固化不进设置；工具面饥饿由序 3 前提 F>R 结构保证；纯工具稳态循环归观察哨。
- **A1 焦点名额**：非升级态焦点保护从「整轮」归一为**名额制**——名额 = `min(20, ⌊0.3·W_eff·3.5 ÷ 组均字节⌋)`，下限 1，窗未知回退 20（字节兼容）。planFocusTail 产出降级带候选（barrier/附件组豁免不占名额、open 区不入带）；decide **事实门**裁决：全组 defined R 均 superseded（同文件后续成功读覆盖原范围）才判死，整组 A+R 同进退；发射端仅对降级组放宽 turn/位置两道位置门，missing/live R/附件/连续性事实门一律不放宽。升级态（焦点占比 ≥50% ∧ 组 >10）cap=10 原语义字节不变。decide/compactIfNeeded 增可选 windowEffTokens 管道，仅 dispatch 两调用点透传，manual/legacy 逃生口不传。
- **三桶合并扫描（包一a）**：scanProseBuckets 一次遍历产出同域三桶 aged/fresh/total（total=旧 proseStats 口径字节不变，proseStats 合并退役）；planProseEviction 增 spanProseChars 与 evictedProseChars 分账；压缩快照新增可选字段 condensableProseAgedTokens / toolFaceTokens（缺省值 ⇒ 旧快照字节不变、份额闸恒不触发）。
- **[argp-quota] 影子列**：quota 记录（t/mode/quotaUsed/quotaBandGroups/demotedGroups/evictedGroups/evictedChars）随 `ARGP_FACTOR_DISPATCH_LOG` 通道与 dispatch 决策同文件落盘——观察哨「降级档驱逐组数」信号走活路径。

### Fixed
- **§F churn 清账只看浓缩实果**：summarize 分支改为仅 `proseResult !== null` 时清账——断供轮（barrier 散点不发射/浓缩异常）surface 未重建却每轮抹账，g2 型浅剪连发复活；新增跨断供轮抑制复现（修复前红/修复后绿）。
- **畸形 `turn/start` 的 open 带 fail-closed**：轮号不可读的未闭合 turn/start 旧被折叠成「无开放轮」，open 区协议现场可被整组判死降级（fail-open）；修后 detectOpenTurn 返回 -1 哨兵——降级带清零、驱逐全停、随事务预剪跳过（FT13 锁 + 变异锁）。
- **「宿主全局预剪」归因勘误（基线非缺陷）**：接管下宿主自主预剪已被 preset 摘除，唯一活调用方 = nativePruneToolResults 随事务发生；NP10a/c 按宿主拒收语义（open-turn 外 tool/result replace 被格式校验拒绝、真实 pruner fail-fast）钉死老轮超限 R 漏剪基线。

### Docs
- 双语 README 已知限制：**D-2 W_min 建议线**（建议窗 ≥64K，不含附件面与超大粘贴；barrier 为唯一无机制可释放项不计入；F 硬面标近似）。
- ARCHITECTURE §2 焦点保护形态归一节（planFocusTail 两态与事实门）、§7.5 事务预剪节。

### 提示
- **口径裁定**：32K 场景不做适配，64K≈W_min 即极限场景——focus-32k（58K 固定面+32K 窗）的钳制风暴是建议线的实证，不记回归。
- 测试：全量 387 例（385 通过、2 跳过）；名额 FT7–FT12 六锁 + 四变异验红（摘事实门→FT8、摘透传→FT7、摘豁免→FT11、摘排除→FT12）。
- 门禁实测（2.2.1 构建）：46 轮头条负载 46/46 完赛 0 死轮、**96.14% 命中 / 44.6 min / 4.41 元**（vs 2.2.0 账 96.5%/40.8min/4.18：−0.34pp 为事务轮税加深与非事务 +2pp 的结构性对冲，总 miss 反降 ~20K；峰值 246K→151K、尾部 miss −176.5K）；三域台架 g13 形态全对（focus-64k 76/76、0 死、6 笔）；T0 隐藏套件 cand **19/20**（单红=历史同条 plugin_error_isolated）、native 臂 17/20；名额实料离线回放 9 笔事务零驱逐（T−1 剪 27 组、事实门 0/27——超带缘组全是活读被锁，设计行为）；长程记忆补充召回轮首基线：逐字 0/7 为材料散文结构性出带（扫荡合入无逐字转写带、散文带固定最旧 ~110.8K 字符不可翻页），诚实轴 7/7 C 如实、零编造锚点。

## [2.2.0] - 2026-11-26（stable 直发：压缩分派接管 + 摘要缓存形 + 出口闸缺省开；preset 快照对齐宿主 0.2.3-alpha.2）

### Added
- **压缩分派器（判据表主权）** `ARGP_FACTOR_DISPATCH`：未设=接管、`1`=影子（只记录不改发射）、`0`=旧双闸逃生口。单函数纯判据：C≤R→none；F>W_eff→terminal-b6（连 3 轮不再发剪/摘事务，结构去重照旧）；缺口 ≤ max(1536, 0.2×W_eff)→仅剪；散文补不上缺口→求生剪不摘；否则摘要先行（输出预算=W_eff−transcript−指令）。「先剪后摘」在本架构不可达（摘要请求自起就不含工具原子），枚举位保留。
- **摘要输入=宿主同款上下文装配（§G）**：摘要请求与前驱 agent 请求逐字节同前缀——surface 头部到驱逐 span 末的全部可派生消息（含检查点/note 等头原子）+ `requestHeader().tools` + 路由连 `reasoningEffort` 原值照搬 `header.config` + 尾部指令 user 消息。radiance 实锤：流式×`reasoning_effort=null` 不复用深前缀（同字节 body 读 0~2048 块 vs 同值 medium 97.6%，low 与 medium 不共享）。三域实测摘要命中 93-98%，摘要侧计费 −77%。
- **G2 摘要账单落库**：`compaction/summary` 事件回填 provider/model/maxTokens/usage（含 `cacheReadTokens`）/rawOutput/llmStreamCall——摘要调用在账单里不再是隐形人。
- **结构去重驱逐（0-LLM）**：宿主再注入三件套旧副本按 kind 保最新整节点离场；接管事务摘要先行、去重排在摘要发出后（热前缀不被扰动）。
- **churn 最小保护（§F）**：prune-only 上次实际释放 < max(1536, 5%×W_eff) 且入场无新可剪面 ⇒ 跳过组剪（结构去重照发）；摘要发射清零账本；健康锯齿（每轮释放 ≥ 地板）不受影响。
- **observedCap 有效窗（§A）**：从数字型 400 学真实上限，预算/出口闸/散文分母统一 min(声明, 真实)。
- **量化排序对照臂（§D）** `ARGP_FACTOR_QSCORE=1`：绝对净代价排序；三域 A/B 焦点域回退，缺省维持字典序，臂归档。
- **影子判据流水通道** `ARGP_FACTOR_SHADOW=1` + `ARGP_FACTOR_SHADOW_LOG=<path>`：三形态判据的只记不发记录流，独立于分派开关——判据离线核验与台架三域影子审计流由此供数。
- **preset 快照漂移哨兵**：`generate-preset-overrides.ts` 加 `--check`（重建 GENERATED 段与包内快照只比对不写盘，漂移退 1）+ 独立 `preset-drift` workflow（宿主 preset 不随 npm 发包，从宿主仓库 sparse 拉 presets 目录；push/PR/每日定时）。

### Changed
- preset: 覆盖块对宿主 dsh-v0.2.3-alpha.2 重生成（standard 新增 tool-cordis 条目、cordis 的 tool-skill 新增 excludedSkills、ptc 的 skill-filesystem 新增 customSkillDirs 且 plugin-manager 恢复出厂启用条件，均出厂对齐）
- **出口闸在接管世界缺省开启**（旧公式线 = 窗 − 输出预算 − 2%）：封死「宿主 max_tokens 钳制线（≈窗−输出预算）低于 pressure 线（0.8×窗）」的贴线饿死死亡带——大固定面会话落带时压缩无触发点、轮次被钳成 out=1 空转（台架 58K 词汇表面第 6-8 轮死复现；真实端点同款「门关轮次空转」README 曾有记录）。58K 面翻转后 44/44 满程（g12 复测：47 次介入全 prune-only、闸线最小入场 23962；尾部 3 轮因轮内工具增长越过 pre-step 闸可见位、被宿主钳制截断 out<1.2K——轮内增量的钳制尾差留档后续）；off/shadow 世界缺省仍关，`ARGP_FACTOR_EGRESS=0` 硬关逃生口、设置「压缩阈值」比例线仍优先。
- 接管组剪与出口闸同口径测量（含 incomingTokens），修复此前双事务/双驱逐。
- 散文双闸主权移交判据表：approved 跳闸一；宿主再注入原子不计散文（exclude 分类与接管同进退）。
- README：出口闸/盲区缓解段改写为「接管缺省开」；EG 套显式钉 `ARGP_FACTOR_DISPATCH=0` 旧世界。

### Fixed
- deps: CommandId 类型导入改 dsh-commands 根出口，规避宿主 0.2.3 移除 ./brand 子路径的报错（运行时行为零变化）
- 摘要领头原子错位：跳过领头检查点使第 2 条起摘要前缀从 msg#1 分叉、缓存掉回 1 块（g4 实锤）——全前缀回放修复，单测锁。
- takeover 主权闭环：快照异常/窗口未知的决策缺失不再落回旧双闸（旧闸 condense 为 legacy transcript 形：缓存不友好、绕过判据主权、G2 不可见），兜底 prune-only 0-LLM 求生剪 + `decision-failed` 取证流水。
- terminal-b6 空转：连 3 轮不发事务。
- 召回副本可见性裁决：缺省查询/词表/sticky 观察面剔除召回工具自身被剪的结果（「副本的副本」不再冒充证据面），点名 `tool:` 召回族键保留审计通道（RV1–RV5 契约锁）。
- pre-step 独立浓缩闸补世界门控：接管下 §9.36 闸二不再挂载——该闸五参直调不经分派核准，过线时会以旧形（再注入原子计回散文）绕过判据表发摘要且对 G2 账单隐形（发布前审查实锤调用点无门控；EG-15 锁）。off/shadow 旧世界照旧。
- `/argp` 风险行文案对齐 2026-11-19 勘误：「宿主无痕截断最旧 live」改为实测形态「输出预算钳到窗−prompt（轮次趋零空转）/严格端点 400 拒收」，并注明出口闸接管下缺省已开。

### 提示
- 注意：2.2.0 直发 stable（npm `latest`）。preset 覆盖块按宿主 0.2.3-alpha.2 出厂对齐——对 stable 宿主 0.2.2-rc.5 经逐项 diff 核验：出厂条目零丢失，仅 4 处良性对齐（standard +tool-cordis 在 0.2.2 可解析可加载；tool-skill.excludedSkills 被 0.2.2 宽容忽略；ptc customSkillDirs 0.2.2 已支持；plugin-manager 启用条件与其他 preset 一致）
- 测试：全量 371 例（369 通过、2 跳过）；46 轮头条负载全量复测（2026-11-26，2.2.0 构建）：46/46 完赛、0 死轮（T37 客户端断流一次重发即过，INFRA 不计）、96.5% 命中、40.8 min、4.18 元——同负载 2.0.0 旧账 3.69 元/98.4% 利用率的差即出口闸前移的定价（本配置 mct=65536，线=W−mct−2%）；README 头条表保持 2.0 线撞墙触发口径（前移触发与撞墙触发两种触发策略不互替），本复测以前移触发独立口径记入 README 附录；三域台架 32K 全长 + 64K 76 轮 + 58K 固定面实机（read 62/62、probe 2/2（tool）、hit 88-92%、dead=0）；focus 域第二探测轮在缺省新时序下 1/2×2（模型选路漂移：view=outline/绝对路径 label；原文恒在日志、正确 label+full 视图可逐字取回，改进项入 2.2.0）

## [2.1.0] - 2026-11-19（tool 因子键 + 交互族预览 + search_history 内容发现 + 外评 Issue3/4/5）

### Added

- **`tool:<注册名>` 因子键全量升格**：每枚工具结果至少带一枚 `tool:` 地址（工具名缺失的孤儿结果除外）——剪后词表、`list_labels(category:'tool')`、`recall_history` 标签召回全链可用；「没有实体标签就找不回」的旧口径随 tool 键退役（README 已知限制同步）。
- **交互族词表预览**：`ask_user_question` / `exit_plan_mode` 检查点专段带 `tool:` 地址与 Q/A 侧写预览（逐问拼接、answers 解析、80 字符截断、secret 侧弃、控制符压平），压缩后模型能看到「当时问过什么、答了什么」。
- **`search_history` 内容发现工具**（散文 keyword 召回，2026-11-19）：新增第三个召回工具，把「无标签散文原子不可追」缺口补上——按字面内容子串扫描被剪工具原子 **∪ user/assistant 散文原文**（含已被浓缩请离场的正文，原文恒在 append-only 日志）。三工具正交分工：`search_history`=找（内容）、`recall_history`=取（标签地址）、`list_labels`=看（词表）；keyword 通道从 `recall_history` **整体迁出**至 `search_history`（keyword 通道从未正式发布=零 wire 兼容成本）。两步走=命中行带 `hit=<seq>` 句柄+分层预览（N≤20→100 tok、N≤250→20 tok、显式 limit 页→200 tok），`hit=` 第二跳取逐字全文（白名单=临时索引单槽，新查询整体覆盖；索引外 seq 严拒=无任意 seq 注入面）。N>250 走**标签分布直方图**（faceted 形：工具命中按其他标签 ×n(hits)、`(no-label)` 兜底桶、count desc→key asc；散文按 User/Assistant 分桶；无预览逼细化）。排序 `score=min(hits,10)`（TF 饱和=BM25 饱和项整数形，防单个巨原子霸榜）。**单原子多次命中**：行内报原始命中次数 `· ×N`（非饱和形，类比 grep -c），宽档（≥50 tok）从分散命中点取**最多 2 个互不重叠 fragment 窗**（Lucene unified highlighter 形；命中聚一簇则单窗），其余位置 hit= 全文可见。散文带谓词：仅 text 块投影（args 不入面）、kind 主防线排除插件自写 note/检查点 + 宿主 runtime-context/skill-catalog boilerplate、replace 副本排除（顶层 `surfaceOp.op==='replace'`，非 sourceEventSeqs）；从旧到新独立 cap + fail-visible 截断页脚（cap=0 关带=评测对照臂）。两带合并文本恰过一次共享预算（5%/10%）。
- **`/argp` 状态卡盲区风险行**（外评 Issue4）：不可剪 live 面（非 R 原子 + 未闭合轮）≥ 0.8×声明窗时显式露出近似诊断行（只读渲染，禁走 decide() 压缩状态面）；声明窗未知=零告警（宁缺勿错，交 400 兜底网口径）。**2026-11-19 实测勘误**：原「B-6 无痕截断」前提证伪——当前宿主对超窗请求全量发出并返回显式 `CONTEXT_WINDOW_EXCEEDED`（声明窗探针，档案恒完整、零截断），非无痕消失；卡片保留为「逼近窗预警」（仍真，撞到的就是这个显式错误），README 已知限制与措辞同步勘误。
- **CJK 自适应密度估算**（外评 Issue5 B 案）：字符估算从统一 3.5 chars/token 改为 `nonCjk/3.5 + cjk/κ`，κ=1.7（Qwen3.8 tokenizer 同帧配对差分标定，两独立语料组 1.714/1.675 收敛）——中文重负载内容不再被系统性低估 ~2×。白名单=CJK 统一表意+扩展 A+中日韩标点+假名；其余字符（含全角/西里尔/谚文/emoji）一律走 3.5 桶=非 CJK 文本估算逐字不变。覆盖 anchored 增量、锚点重置、deficit→chars 反向换算、召回预算、浓缩闸一容量线；`ARGP_FACTOR_PRESSURE=1` 逃生口与宿主 shadow 定价口径（HOST_CHARS_PER_TOKEN=4）刻意不改。跨 tokenizer 不自动重标定=刻意简化（README 口径声明）。

### Changed

- **命名遗留清偿**（外评 Issue3）：`ArgpGraphEngine`→`ArgpEngine`、`ArgpGraphConfig`→`ArgpConfig`（旧名保留为 @deprecated 别名，下一 major 移除）；`argp-graph-engine.ts`→`argp-engine.ts`、`graph-build.ts`→`atomize.ts`、`peratom/`→`llm/`；日志前缀 `[argp-graph]`→`[argp-engine]`。`compactionId` 的 `argp-graph-` wire 前缀保留（历史日志重建按 id 去重，无解析点）。
- README：估算口径/B-6 缓解句同步新形态；策略值句改「按字符类别加权」。

### Fixed

- **在轮召回结果不再被同轮压缩事务剪空**（注入预审实锤 P1）：裁定 2「召回对可再生=再召回一次」原实现把**尚未闭合轮内**刚返回的 `recall_history`/`list_labels` 结果也保持无条件可剪——高压场景（估算线已过、散文浓缩闸未触发、大块 U 原子不在剪序）下唯一可剪原子=刚返回的召回结果，模型下一步请求前它就被剪成空 `tool/result` 克隆，召回面在最需要它的时刻自废。「下次压缩驱逐」语义修正为**轮闭合后的下一事务**：在轮召回 R 硬排除剪序，轮闭合后照旧无条件进剪序（含 sticky/焦点/附件位失效面不变）。回归锁 EV1/EV1b 双向变异（M27/M28）。
- **`ARGP_FACTOR_PRESSURE=1` 逃生口在 CJK 会话恢复字节级复现契约**（对抗审查 ADV-1）：Issue5 把 measureTokens 全局 CJK 加权后，逃生口的 deficit 随上游失真（CJK 会话 ≈2× 过剪），「估算口径冻结 1.x」名存实亡。逃生口路径改走 `legacyPlain=true` 朴素密度估算（本函数级 pin，正常链零触碰；锁 M30/M31）。
- **交互预览 secret 跨截断线穿透口**（ADV-5）：`shrinkSide` 原「先 80 截断后 secret 检测」会把 `sk-`/JWT 切成残缺形令正则失配，≤79 字符 secret 前缀可进词表行；改为原串先验 secret（仅 secret 类拒收，`long` 拒仍由截断消化）、截后照旧复检（锁 M32）。

### Changed

- 命名遗留清偿二期（ADV-3/4）：`spike/retired-1x` 归档脚本 import 改指 `argp-engine`（消除死路径与 grep 残留）；ARCHITECTURE/SECURITY 的 `peratom/` 旧目录路径改 `llm/`。
- README 已知限制新增：**超大结果与宿主全局预剪的交互**——轮内压力事务中宿主 tool/result 全局预剪（≈8192 chars，不认工具名）会切当轮召回结果的中段（头尾存活）；精确长内容请 item 钻取或分轮召回（ADV-2 裁定入册）。

### Testing

- 336 测全绿（新增 B6×5、CT1-CT6、EV1/EV1b 重写、ADV-1 逃生口接线锁、ADV-6 b6 只读红线锁、PS1-PS6 散文扫描带、SH1-14 search_history 装配/命中索引/分布档/多命中双片段、TG1 note 逃生句）；变异面 51 刀全红（新增 M22-M49，run_mut 仓库外）；κ 标定读数表与语料工件在仓库外台账（design-2.1.0-batch §5，不进仓库）。二轮对抗审查台账=design-2.1.0-batch §7（ADV-1..12）；散文 keyword 召回三轮审查+P13 实测+IR 方法论对齐=design-prose-keyword-recall §5/§6/§6.5/§6.6/§9（全部亲验）。

## [2.0.2] - 2026-11-16（preset 覆盖块对 rc.3 重生成对齐——issue #4）

### Fixed

- **`cordis.patch.yml` preset 覆盖块（bundle patch 的 GENERATED 段）从旧宿主快照对 0.2.2-rc.3 重生成**（issue #4 实锤）：快照停在 1.7.0-beta 时代的宿主 preset，其后宿主键改名/增删，而覆盖块是整体替换 preset config——漂移在装了 dsh-argp 的会话里全部真实生效。具体：`modelSelectionSettings` → `modelSelection`（旧拼写在现行宿主 schema 里是幽灵键，被非 strict zod 静默剥离 ⇒ **subagent 模型选择被无声关闭三轮版本**）；删 `backgroundMode`（已出宿主 schema，同类幽灵）；补宿主新增条目（`time-context`/`tool-schedule`/`tool-office`/`dsh-plugin-market/tools`）；摘宿主已删条目（`tool-subagent-codex`/`claude-code`/`ralph`）；`modelDiscovery` 等其余出厂项随之对齐。宿主升级后重跑 `scripts/generate-preset-overrides.ts` 的义务自此有回归锁兜底。
- 回归锁：`test/preset-patch-entries.test.ts` 新增幽灵键锁（`modelSelectionSettings`/`backgroundMode` 禁入 + `modelSelection: true`×3 出厂对齐，变异验证：塞回幽灵键 ⇒ 红）；包子路径白名单补 `@deepseek-ai/dsh-plugin-market/tools`（rc.3 检出 `packages/boot/plugin-market` exports 实载 `./tools`，2026-11-16 核实）。

## [2.0.1] - 2026-11-15（出口闸转缺省关 + 压缩阈值设置项 + scope/command 召回引导）

### Added

- **压缩阈值（唯一设置项，可设比例的出口闸）**：Settings → Plugins 新增 `compactionThreshold`（0–1，volatile 免重挂即时生效）——上下文达到声明窗 × 比例即**先压缩再发送**；0/留空 = 关闭（撞墙 400 兜底，见下）。设置比例线优先于 `ARGP_FACTOR_EGRESS=1` 的旧公式线；`ARGP_FACTOR_EGRESS=0` 仍为对照硬覆盖。默认关闭。

### Changed

- **出口闸（超窗预检）缺省改为关闭**：46 轮实测的对照臂形态即缺省形态——贴墙由 provider 400 兜底网 + 浓缩闸二接管，上下文贴线（README 对照表的利用率口径）优先于预检防线的提前回落。开启面 = 设置「压缩阈值」或 `ARGP_FACTOR_EGRESS=1`（评测/对照口径）。**适用前提**：缺省形态依赖「真实墙≈声明窗」——若端点真实墙远大于声明窗（网关自动升档、模型多档位），provider 永不拒收超窗请求，自动剪枝将失活（只剩散文浓缩与手动 `/compact`），此类端点建议显式开启本闸（真实 DeepSeek 端点实测背书：门关形态生成预算被客户端钳至最小值、轮次空转；门开形态全程正常）。
- **召回引导补双逃生通道（command + scope）**：词表 note 引导、`recall_history` 描述、空标签错误文案补 `command:<family>`（经 shell 命令读入的内容只挂命令族标签）与目录级 `scope:<dir>`（只被目录级 grep 触及的内容）两类地址，及 `list_labels(category:'command' or 'scope')` 发现链——没有 document 标签的内容，模型现在可发现并按标签逐字召回（真实端点长程记忆测验实锤两类洞各 1 例：scope 型=目录级 grep、command 型=pwsh 读入；查询/账本索引机制本就存在，纯引导缺口）。`list_labels` 缺省扫掠仍不含 scope（目录键量大，按需查）。

### Fixed

- README：对照表注改「缺省配置实测」口径，前缀缓存命中率改百分比；移除指向 CHANGELOG 的「逐轮明细」悬空引用（CHANGELOG 只承载汇总口径）。
- README 安装节：补宿主发布渠道说明（npm `latest` 渠道 0.1.x 不在准入区间会被静默跳过）与 doctor 预检入口（仓库内 `scripts/doctor.mjs`，不随 npm 包分发）。

## [2.0.0] - 2026-11-15（factor 引擎正式版：标签剪枝 + 散文浓缩 + 出口闸 + 零旋钮）

2.0 是 factor 引擎的干净形态：**工具结果按实体标签确定性剪枝（0 LLM）**、**散文只在压缩事务内一次性浓缩（唯一 LLM 通路、双闸把关）**、**出口闸保证必然超窗的请求根本不发出**；被剪原文永远留在 append-only 日志，可按标签 `recall_history` 逐字取回。

### Added

- **确定性标签组剪（0 LLM）**：工具结果按 `document` / `command` / `errorcode` / `scope` 贴标，按过期读、被新版取代、非焦点轮确定性打分；A+R 协议组整组离场（检查点占位），R-only 落空克隆；A 永不剪、U 受焦点保护；被剪账本按会话分桶。
- **散文浓缩**：唯一 LLM 摘要通路，只在压缩事务内触发；双闸合取（散文占声明窗 ≥50% 且上下文 ≥0.8×声明窗）；one-shot 原生式，空输出或异常保原文。
- **出口闸（缺省开）**：pre-step 用 anchored 算术判断必然超窗的请求，先压缩再发；输出预算三源取 max；provider 400 仅作兜底。冷 resume 从日志回填声明窗，首召回懒重放账本。
- **召回面**：`recall_history` / `list_labels`（标签制，无 seq 通道）；真 AND 语义、outline/item/offset 两级视图、order 三档、路径后缀归一、预算跨轮重置；空结果、未命中、预算耗尽均显式说明。
- **零旋钮**：设置页与六枚旋钮（windowRatio / retainRatio / charsPerToken / focalTurns / vocabTopN / recallLimit）全部退役，缺省值固化（0.8 / 0.2 / 3.5 / 1 / 10 / 5）；老 profile 同名键宽容读 + 告警。
- **回归锁**：历史 issue #1（cites 剥离的 provenance 冲突）与 #2（compaction/summary 宿主 strict 重载）补验收层锁，含宿主完整加载链与负控。
- **实测（46 轮同款工作量，本地 Qwen3.8-Flash-Next）**：墙钟 43.3min；miss 1.363M / hit 60.06M / output 0.283M；DeepSeek 闲时参考价 3.69 元；前缀缓存命中 0.978；声明窗上下文利用率 98.4%；T0 隐藏工件 20/20；长程记忆补充召回轮 8/10。vs 1.11.2：账单 −56%、墙钟 −62%。回归 269 测（267 过 / 2 skip），typecheck / smoke / build 全绿。

### Changed

- **引擎收窄为 factor-only**：graph 臂与 peratom 三管线退役；`compactRegion` 在 factor 下明确拒绝；构造面保留显式 `windowTokens` / `retainTokens`。
- **压缩动作序**：先组剪、后原生 pruner 二次收紧；pruner 切片可在下一笔整组驱逐；焦点尾窗降级（最新轮占比 ≥50% 且组数 >10 时收窄到最新 10 组）。
- **触发收敛**：破坏性改写只认手动 `/compact` 与 provider 400；pre-step 估算驱动压力剪退为 `ARGP_FACTOR_PRESSURE=1` 对照口。
- **引导位置**：模型侧压缩/召回说明从 system 前缀常驻改为随词表 note 在首次压缩后注入；`recall_history` 工具描述精简——固定开销约省 600+ tokens/请求。
- **README 面向插件用户重构**：安装 → 上手 → 零配置 → 机制简版 → 实测对照；实现细节归位 `ARCHITECTURE.md`；退役首屏概览图。

### Fixed

- 召回安全阀退化为整会话永久闸（按轮自同步归零）；被剪账本跨会话串台（按会话分桶）。
- 焦点重绑重放账目重复；事务后锚点被旧 usage 复活；measureTokens 漏掉锚点事件。
- skipPresets 不覆盖 pre-step 通道；空转刷新词表 note 导致 400 恢复误判。
- 散文闸一分母错误（改用声明窗）；散文 span 跨非原子节点；partial-only 白付 LLM；factor 墓碑不可吞；clip 文案指向退役工具。
- staleness 误判（end_line 当 limit、读失败当覆盖证据、cwd 来源错误）；文本+附件混合 R 被文本桩吞。
- error-end 事务的 prune 误入 shadowed 账；epoch 漂移游标未归零；list_labels 绕过安全阀；冷 resume 首召回账本为空。

### Removed

- Stage-1 三管线（compressor / declarer / recall-zoom / gate / mount / flush / prompt / collect 等）与 Stage-2 图剪（prune-selection / token-ontology / recall-tools）。
- 旧栈测试与 1.x 实验脚本（归档 `spike/retired-1x/`，不参与编译）。

### 读侧兼容（保留）

- 老墓碑文法（v1.3.x–v1.7.x）、老 `data.argpCites`（三种历史形状归一）、`prune-tx` 的 tool/result 克隆配对契约；老日志可读，2.0 不再生成这些形态。

## [1.11.2] - 2026-11-09（hotfix：preset 死子路径条目炸新建会话，issue #3）

> **发行说明**：P0 可用性热修（release-cadence 的 hotfix 例外）。三个 preset 的 delegation 组各有一条 `tool-subagent-list-agents` 指向 `@deepseek-ai/dsh-tool-subagent-control/list-agents`——该子路径在当前宿主包线（0.2.0-rc.1 起）的 `exports` 中**不存在**，凡装树里有此包者 preset 组装即抛 `agent-preset/invalid … never started`，**新建会话整体失败**（已有会话不受影响）。条目在 1.7.0 引入时对当时宿主正确，上游后来收掉该 export，1.11.1 时代在 0.2.2 线环境引爆。外部报告者（Maco0829，issue #3）与本机真机双向实证：删除前"新建会话失败"必现，删除后正常。

### Fixed

- **preset 删除不可解析的 `tool-subagent-list-agents` 条目**（三 preset 各一处）：`dsh-tool-subagent-control` 实载 exports 仅 `. / ./src/* / ./package.json / ./locale/*.json`；且 `list_agents` 工具本就由该包主入口 `apply(ctx)` 首步 `registerListAgents(ctx)` 注册，删除**零功能损失**（真机复核工具仍在）。宿主对"包缺席"宽容跳过、对"包在而子路径解析失败"严格报错——这解释了为何只有装了该包的环境（含桌面宿主 bundle 自带）会炸。

### Added

- **`test/preset-patch-entries.test.ts` 回归锁**：preset 的 `name:` 出现包子路径必须过白名单（白名单成员须附 exports 核实依据）。变异验证：塞回毒行 ⇒ 双测红。该测试首跑即抓到现存三处 `@deepseek-ai/dsh-plugin-manager/tools`，逐包核实其 exports 含 `./tools` 合法入名单——同类地雷自此进不了 CI。

## [1.11.1] - 2026-11-08（宿主 0.2.2-rc.1 线兼容 + /argp 状态卡多语言）

> **发行说明**：两个攒批提交——**宿主 0.2.2-rc.1 升级向上兼容全量验证**与 **`/argp` 状态卡绑定宿主语言**。`src/` 运行时代码除状态卡渲染外无行为变化、无配置迁移；准入仍由 `engines.dsh: ">=0.2.0-rc.1 <0.3.0-0"` 单独决定（未动），对宿主 0.2.0-rc.1 ~ 0.2.2-rc.1 全区间兼容，0.2.2-rc.1 上编译/单测/活体/真机四层验证通过。

### Added

- **/argp 状态卡跟随宿主语言设置（服务端多语言呈现）**：新叶子 `src/ui-locale.ts` 经 `settings.describe()` 从宿主设置 `locale` 命名空间的 preference **现取**语言（设置页切换后下一条命令即生效，无需重启），`renderArgpStatus` 拆出 `StatusCopy` 双语文案表——en/zh 两份实现经同一接口互为完整性校验（缺键编译错）；技术记号不翻译（preset id、`source=`、cites、引擎形态值），英文输出逐字节不变（回归锁定）。全形态防御：服务缺席/无 describe/异形值/调用抛错一律回退英文；"自动"模式（跟随浏览器语言）服务端不可见 client locale，维持英文——完全解需宿主在命令调用携带 locale（可提 feature request）。突变验证：拆除 handler locale 接线 ⇒ zh 端到端红，还原全绿。

### Changed

- **devDeps 升宿主 0.2.2-rc.1 线（向上兼容全量验证）**：`@deepseek-ai/*` 0.2.1-rc.3→0.2.2-rc.1、cordis 4.0.5→4.1.0（`dsh-agent@rc.1` peer 锁 `cordis ~4.1.0`，宿主 bundle 同载 4.1.0）。0.2.2 的两处变化均只落在**测试适配**：`ctx.tools.execute` 改批式（入参 `{calls,signal,agent?}`，返回 `{results:[{callId,result}]}`），ctx 总线新挂载的 `SessionProjectionRegistry.drive()` 校验 `event.seq`（合成 `session/event` fixture 补 seq，真实追加事件自带）。验证链：installer-asar 静态对照（session v4 不变、`register`/`defineTool` 兼容、compaction 包逐字节相同）→ tsc 干净 → Tier A 463/463 → Tier B 活体通过 → 真机桌面宿主 0.2.2-rc.1 启动并列载本插件无 incompatible 标记。**装树说明**：互斥 peer 三角——`dsh-invariants@0.2.0-rc.1`（无 rc.1 可升，钉死旧线）peer cordis `~4.0.4` vs dsh-agent@rc.1 peer `~4.1.0`，另有 rc.1 包带指回 rc.3 的传递 pin。package.json 已声明 `overrides: {"@deepseek-ai/cordis": "4.1.0"}` 全树统一（与宿主 bundle 实载一致），`npm install` / `npm ci` 均免 flag 直过（首版 tag 的 CI 正是在裸 `npm ci` 上 ERESOLVE，本补丁修复）。

## [1.11.0] - 2026-10-27（stable 推进：真机浸泡通过 + Tier B 活体测试 + 死代码清扫）

> **发行说明（汇总版）**：本版 = **1.11.0-beta.1 全部内容**（见下一节：预算真值 + D2 焦点漂移修复 + stable 前收尾批 + Tier A 集成测试）加上推进期两个提交：**Tier B 活体集成测试**与**死代码/陈旧注释清扫**。beta → stable 的推进依据：真机 web profile（宿主 0.2.1-rc.2，Qwen3.8-Flash-Next）浸泡通过——多会话交错下 `/argp` 桶各自独立（A/B 的 retain/now 各自取值无串台）、服务重启后会话 resume 记忆完整（模型准确回起重启前内容）、`/argp` 显示版本号/`graph+peratom`/`source=anchored`/`[this process]` 全部在位、服务日志零 error。

### Added

- **Tier B 活体集成测试**（`npm run test:live`）：testkit harness 上 agent 轮保持脚本化（驱动确定性），`purpose='compaction'` 调用经生产 wire 序列化器转发真实 OpenAI 兼容端点——与生产 dsh-llm 路径同形态（无 response_format，靠 extractJson 兜底）。`ARGP_ITEST_LLM` 门控（默认 `http://127.0.0.1:1234/v1` 经 `scripts/live-env.mjs` 预置；未设/不可达整文件自跳过，`npm test` 保持零网络）。L1 单轮契约（解析零失败 / 零调用错误 / 会话不破 / 事务括号配对）+ L2 五轮采样质量门（完成解析 5/5、可落地决策 ≥1、flush 事务 ≥3、相对无压缩基线净瘦 ≥1000 字符）。对 Qwen3.8-Flash-Next 三连跑全部可复现（temperature 0）。
  - **真模型服从率发现**：Qwen Flash 在后续轮 4/5 次省略 `infoLevel`/`infoText`（提示词已声明必填，dsh-llm 路径 schema 仅文本描述）——引擎信任边界按设计回退逐字保面（安全方向，零损坏）；首压（干净上下文）服从完整。提示词硬化（few-shot 等）留待 1.11.x。
  - **HLS 尾注修复档实证**：turn-1 的 extract 候选 86 字符被保真守卫拒收后机械补全缺失硬 token，3225→1065 字符（67% 瘦身）落地。

### Changed

- **死代码与陈旧注释清扫**：删 `hostHasLlm`（全库零引用）、client `booleanField`（enableSummarize 卡片行撤除后的孤儿工厂）、`SplitDecision`（零引用类型）、client `ArgpUserSettings.enableSummarize` 接口残留；降级链注释对齐现状（summarize 撤除后 lifecycle≡force，唯一分叉是 fail，三档保留为公开配置契约）。零行为变化；ts-prune 全库扫描的误报（barrel/测试在用/宿主 loader 契约）已逐一核实排除。

## [1.11.0-beta.1] - 2026-10-26（beta 渠道：预算真值 + 焦点漂移 + stable 前收尾批）

> **发行说明**：三段攒批。批次 2（预算真值，9a48edb）+ 评审二批（D2 焦点漂移，dede2ac）+ Tier A 集成测试（3f4c3b6）+ 批次 3（stable 前收尾「诚实面与工程」，本提交）。评审二批来源：`docs/design-review-v1.11.0-beta.1-2026-10-25.md` D2/§7 的可动项——评审确认 `this.rt` 焦点指针在 async 恢复点会被其他会话抢绑换装，且 beta.0 的 abort 反例存在恒真断言（未锁住任何行为）。

### Changed（批次 3：stable 前收尾「诚实面与工程」）

- **宿主依赖升 0.2.1-rc.3 线全量验证**（3-6）：devDeps 钉 0.2.1-rc.3（testkit 同步，评审参考宿主线），peer 放宽 `^0.2.0-rc.1`（覆盖 0.2.0 宿主到 0.2.1 finals，桌面 rc.2 不破）。全量 460 例在 rc.3 生产回路上绿（含集成测试）。
- **summarize 档撤除**（3-1）：`degradationStrategy: 'summarize'` 与 `enableSummarize` 旋钮移除——原为恒返回 null 的 stub（A6 保守决策），与"可选降级"的宣称不符；存量配置值运行时自然落入 lifecycle→force 链，无破坏。
- **frozenCatalog 核验为真（非死段）**（3-1）：评审"首绑即冻结为空、机制不存在"的判断对新会话成立、对 **resume 会话不成立**——重启后首绑时账本先从日志重建，catalog 拍到真实目录并在本进程恒定回放（测试锁定）。修正了过度声明的"恒为空串"注释。
- **/argp 报数纠正**（3-2）：台账/召回/cites 改按**发起命令的会话**取桶（旧实现读引擎焦点桶，多会话下显示别的会话的账）；retain 口径与引擎一致（显式值走 capRetain 绝对上界并在截断时标注 `(capped from N)`；比例值 = 可压缩内容 × retainRatio，不再是误导的 window×ratio；显式窗口未解析时显示配置值而非默认 16384）；无台账时按日志真值报数（不再伪造 0）；recall/cites 标注 `[this process]`（重启归零非会话真值）；auditWarnings 露出。
- **设置卡 restore-default 恒失败修复**（3-2）：`set`/`unset` 落盘后快照异步刷新，写后立即校验读到陈旧 user 层 ⇒ 每次保存/恢复默认误判失败。改为等待快照收敛（60ms 轮询 + 1.5s 超时）。
- **旋钮数对齐**（3-2）：schema 8 项 = 卡片 8 行（补上缺渲染的 minSpanChars/charsPerToken，撤 enableSummarize），中英 locale 同步。
- **rawResponse 默认脱敏**（3-3）：peratom 遥测的模型原始响应只保头 200 字符 + 全文 sha256 短摘要（响应可能回显会话内容/密钥类敏感串）；`ARGP_PERATOM_RAW_FULL=1` 显式 opt-in 全文。
- **发布与 CI**（3-4）：release.yml 加 tag=package.json=CHANGELOG 三方一致硬校验（正文抽取不再静默回退）；CI 加宿主契约矩阵（最低 0.2.0-rc.1/最新 0.2.1-rc.3 × Node 22/24 × Win/Linux，跑全量测试）+ tarball 安装冒烟；新增提示词组装"无未展开模板变量"闸（`{{cwd}}` 类复发防线，压缩请求体逐字节扫描）。
- **三处正确性修正**（3-5）：recallQuery 平分排序比较器反对称化（旧式在 U-U 相遇时恒 -1，V8 小数组插入排序会把同分 U 倒序）+ maxResults 夹取 1..20（工具入参未夹取）；pruneIntervals 事务后 tool-pairing 不变量审计（自动图剪路径此前无校验——悬空 tool_call 必穿 surface 尾切，一次调用全局检测，违例落 auditWarnings）；shadowedSeqs 增量账本核验锁定（恰等于 compaction/prune 逐事件真值、整段 summary claim 不污染、被记节点必已离 surface）。

### Fixed（评审二批：焦点漂移 / D2）

- **async 恢复点回绑焦点**：`compactIfNeeded`/`isPressureExceeded` 在 `await resolveScaledBudgets`（内含最长 5s 模型探测）后、pre-step 处理器在 peratom 压缩 await 后，全部先 `bindSession(本会话)` 再继续——否则 `measureTokens` 锚点、`guardOverride` 守卫覆盖全部读到抢绑会话的桶（多会话串台）。`turn-stopping`/`runReactivePrune` 补入口绑定（原实现入口不绑，A 的反应式守卫放宽可能写进 B 的桶）。
- **`resolvedWindowTokens` 会话桶化**：原为引擎级共享字段——B 的预算解析会覆盖 A 的 recall 字符限额与 /argp 报数。现入 `SessionRuntimeState`，`resolveScaledBudgets` 经 `stateOf(调用方会话)` 直写；`/argp` 状态页 trigger 改读**发起命令的会话**的桶。
- **abort 不占 flush 失败预算**：`flushStashed` 的 catch 原本把 `throwIfAborted` 的取消也计入 `FLUSH_MAX_FAILURES`——同一次 flush 里连吃两次 abort 就触发"有界放弃"把条目丢掉，恰与"取消 = 保留待下窗重试"相反。取消现在直接上抛，条目与失败计数都不动。
- **召回路由多会话拒绝**：`exec.agent` 缺席时的焦点回退只在引擎**只见过一个会话**时允许；见过 ≥2 个会话后拒绝并显式说明（此前会静默把焦点会话 B 的内容喂给 A 的调用）。recall-tools 三工具与 recall-zoom 两工具同判据。
- **zoom detail 预算会话化**：`recall_detail`/`recall_summary` 的单窗预算不再锚死进程级 `DEFAULT_WINDOW_TOKENS`（16384），优先按该会话 `requestContext()` 声明的真实窗口推导（显式 `detailBudgetTokens` 配置恒定优先）。
- **`compactIfNeeded` 接线 signal**（原 `_signal` 未用）：进入即取消返回 null；预算 await 后、任何事务写点前 `throwIfAborted`；`onOverflowCompress`/`onPrePressureCompress` 回调签名加可选 signal 并透传给 `compressOpenTurn`（溢出恢复被取消时 peratom 的 LLM await 立即断流）。
- **恒真断言修复**（评审 §7）：`session-ownership` 的 abort-flush 反例原断言 `pending.length >= 0`（永不红）；改为精确断言（抛出 + 条目保留 + 零新增事务事件），连带暴露并修复上一条 abort 占预算 bug。

### Changed（批次 2：预算真值，已含于 9a48edb）

- **retain 绝对上界**（2-1）：`capRetain = min(目标, window − reserve − 10% headroom)`，floor 0——小窗口/大 reserve/大输出预算部署上按比例保留的量可能根本放不进窗口。
- **预算地面真值优先级**（2-2）：声明窗口未知时宁缺勿错（物理口径 n_ctx 会放阈值 7×+），request/context 事件优先于模型探测。
- **事务后 token 复测**（2-3）：图剪事务落盘后复测可见量，仍超 retain 记 `auditWarnings`（可见性告警，不改变成功返回）；正常 finish 顺带清 `reactivePending`（陈旧钳制信号不再滞留）。
- **LLM 错误分类**（2-5）：`postChat` 非 2xx 附 `httpStatus`；schema 降级重试仅限 400/422（429/5xx 上抛由调用方调度，abort 永不重试）；dsh-llm 通路补发 `maxTokens`。
- **召回预算复位口径**（2-6）：统一为"compaction 事务**成功**才复位"（带 error 的 end 是 partial 事务，不奖励新一轮全额召回预算）。

### 提示

- 测试：全量 460 例通过（批次 3 新增 9 例：排序反对称/clamp、pairing 审计、账本核验、frozenCatalog resume、/argp 报数、CardForm 迟快照、rawResponse 脱敏、模板变量闸 + 突变 4/4 RED；此前批次合计突变 15/15 RED）。
- **Tier A 集成测试**（评审 §7 第 3 层的进程内形态，随本批补入）：新增 `test/integration-loop.test.ts` 3 例——`mountAgentLoopTestHarness` 挂**生产 AgentLoop**（真实 inbox claim / pre-step / turn-stopping / idle / maintenance 事件序）+ `ctx.llm.registerAdapter` 脚本化 `LlmAdapter`（唯一抽象方法 `stream`；peratom 的 dsh-llm 通路经 `autoDshLlmSpec` 复用同一适配器）。I1 两段式水位经真实事件序（轮末提案暂存 → 下轮 pre-step flush → turn-2 真实请求已无原文）；I2 双 agent 探测窗口交错（不破坏 + 解析窗口按会话分桶 + 锚点不串台；写桶/桶隔离两突变均红）；I3 真实 maintenance 相位空任务（括号配对、下一轮照常——2-4 已知限制的安全侧）。结构性发现：首轮 pre-step 时 open turn 尚无 surface 原子（user 消息在 pre-step 之后落盘），探测窗口的 D2 压力场景在真实回路上无可观测后果——其锁位在单元反例集（focus-drift），集成层锁端到端不变量。
- beta 渠道发布（`latest` 不动）；真机浸泡一晚后转 1.11.0 正式版。

## [1.11.0-beta.0] - 2026-10-25（会话所有权：per-Session 状态分桶 + exec 路由 + 提交语义）

> **发行说明**：两份外部评审在根因层收敛的第一个架构主题——**多会话/多代理健壮性（〔Q〕评分 D 的两大 BLOCKER / 〔K〕阶段 A+B）**。此前引擎的全部会话态（台账、召回预算、shadowed 游标、usage 锚点、冻结 catalog、声明边缓存）是**进程级单例**：子代理/双会话宿主下 A→B 切换时 B 读到 A 的剪枝索引（同 seq 不同内容 = 跨会话泄漏）、A 的预算压制 B 的召回、A 的锚点让 B 误触发。本版全部按 `Session` 分桶（WeakMap），异步路径显式经 `exec.agent.session` 路由。**beta 期验证焦点：多会话宿主下的召回正确性与压缩事务完整性**；单会话行为不变（437 例全绿 + 10 例反例集）。

### Changed

- **会话运行时状态 per-Session 分桶**（1-1，〔Q〕M4）：新增 `src/session-state.ts`（`SessionRuntimeState`，约 22 字段/桶）+ 引擎 `stateOf(session)`（WeakMap 懒建）。台账（records/prunedNodeIndex/closurePrunes）、召回预算与计数、shadowed 三件套、冻结 catalog、usage 锚点、账本重建去重集、守卫覆盖全部随会话切换；同步路径（图剪）经 getter 兼容层读焦点桶（零调用点改动），异步路径显式带 session。闭包 id 计数器保持进程级单调（跨会话唯一无害）。
- **召回工具 + recall-zoom 按 `exec.agent.session` 路由**（1-2）：三个召回工具与 recall_summary/recall_detail 的 execute 改收 `(args, exec)`，会话解析 = `exec.agent.session`（多会话宿主逐调用正确）→ 焦点绑定兜底（单会话语义不变）。zoom 的两档召回预算滑窗同步 per-session（A 会话的 compaction/end 不再归零 B 的预算）。
- **declarer 边缓存会话键化**（1-6）：`edgeCache` 进程单例 → `WeakMap<Session, Map>` 每会话 512 条 LRU——A 会话声明的 18→25 不再注入 B 会话的建图。`buildInjectEdges` 加可选 session 参数（有 session 只注入该桶；历史调用方合并全部桶）。声明失败从"await 前记账永久跳过"改为**有界重试**（同轮 ≤2 次，成功才记账；解析失败/网络失败同待遇）。

### Fixed

- **水位语义：提交成功才推进**（1-3，〔K〕P1-3 裁决定案）：旧实现"LLM 规划成功即推水位"，而发射段 `flushStashed` 是**先 splice 后吞错**——规划成功但落盘失败的窗口被消费即弃（pending 已删、水位已进），该批原子永久跳过且无任何错误痕迹。现在：`flushStashed` 先试后删（flushEntry 成功才 splice 并推水位）、失败保留条目自动重试（单条 ≤2 次，超限有界放弃并留错误账）、零动作窗口视为"已考虑"照常推进（防无限重规划）。两段式的 idle 段只暂存不推水位（`peratom-pre-pressure` ⑦ 的锁已按新语义更新）。
- **stale-surface 代际守卫**（1-4）：idle 暂存 → 下一次 pre-step 发射的窗口期里，并发图剪/手动 /compact 可能已把同一批 seq 换掉；旧决策写向换代后的 surface 要么撞宿主 span 校验要么写错对象。发射前校验收集窗口目标是否已被 replace 副本覆盖（surfaceOp 挂在**副本事件**上，判定必须扫 replace 覆盖集而非目标事件自身）⇒ 过期决策放弃发射（skipReason=stale-surface 入账，不重试）。
- **同会话 pass 串行**（1-4）：两个 idle pass 不再并发读写同一窗口（新 pass 排在既有在飞链之后）；跨会话互不阻塞（分桶 per-session）。
- **AbortSignal 贯穿 peratom LLM 链**（1-5）：compressor/declarer 的 LLM 调用全部收 signal，`AbortSignal.any` 合并超时（abort 与超时任一触发即断流）；abort 不进 schema 兼容重试（不是网络失败）；暂存前/写点前各有 `throwIfAborted` 取消点——abort 后半成品不入队、已入队条目留在 pending 等下一窗口。

### 提示

- **beta ≠ stable**：本版走 beta 渠道（npm dist-tag 的 `beta`），`latest` 不动；转 stable 前需多会话反例集在真实宿主全绿（`test/session-ownership.test.ts` 10 例为进程内版本）。
- 测试：全量 437 例通过（新增 `session-ownership.test.ts` 10 例反例集：双会话泄漏/预算分桶/水位提交语义/不重不漏/stale 守卫/abort 三时点/边隔离）。
- 无配置迁移、无 breaking API（引擎公共面签名向后兼容）。

## [1.10.2] - 2026-10-25（外部评审核验修复批：附件通路 / info-only 压缩 / 免疫毒化 / 召回账目）

> **发行说明**：两份外部评审（本地逐条核验后）收敛出的小而独立的已核验修复批——8 项全部带"删掉修复即变红"的回归锁（`test/repair-1-10-2.test.ts` 等，变异验证过）。无 API 变化、无配置迁移；四项是真实缺陷修复（附件保留自 1.7.0 起在真实宿主上整体 no-op、info-only 分支丢弃模型压缩输出、文本形状可制造永久免剪、归并墓碑召回指错层），其余为账目诚实化与文案纠偏。

### Fixed

- **peratom: 附件保留自 1.7.0 起在真实宿主上整体 no-op**（0-1，〔Q〕M1）：`attachmentBlocksOf` 读 `data.message.content`，而 user/message 的 content 在 `data.content`（无 message 层，与本仓 log-access 口径相悖）⇒ 真实宿主上 U-info 副本的附件块恒为空、附件被纯文本副本静默丢出上下文；测试 fixture 当时用了同样的错误形状，双双自洽从未暴露。修形状 + fixture 改真实宿主形状。
- **peratom: info-only 分支（纯资料消息）丢弃模型的 `infoLevel`/`infoText`**（0-2，〔K〕P1-7）：整条 U-info 的 replace 写死原文 `atom.text`，模型的 summary/extract 压缩输出整档 no-op。与 split 分支共用同款裁决（`resolveInfoCopy`）：summary 审计放行、extract 缺硬 token 回退原文（回退仍保留 ARG_NS 元数据的结构作用）。
- **graph: 文本形状可零成本制造永久免剪——两处免疫判据换结构锚定**（0-3，〔Q〕M3，双 BLOCKER）：
  - `citesFailed` 闸（正文含 `"cites"` 字面量但协议解析失败 → 保守保护）改为 **force 降级可越**：该标志源于不可信文本的形状检测，不可越 = 模型/工具输出复述一个字面量即可让原子永生（实测 force_prune 也剪不动、50 次重建全保留）。正常路径的保守保护不变。
  - 墓碑终止态（G1）与 A10 的"组已收割"判定（allStubbed）从裸文本前缀改为 **`tombstoneReplaceSeqs` 结构锚**（replace 事件 + 墓碑文法整串匹配串联，`buildTombstoneReplaceSeqs` 单一事实源）：意外碰撞（源码引用/日志转录的前缀片段）不再命中；刻意照抄完整文法的 **append** 事件也永不获终止态——真墓碑只能由 surfaceOp replace 产生。文法表覆盖现行四族 + git 历史全部遗留族（v1.3.0–v1.7.0 逐字核对），存量老会话重放不受影响。
- **recall: `list_pruned` 默认模式无界渲染**（0-4，〔Q〕M6）：此前默认模式列全部 shadowed 节点（长会话数千行一次性进上下文），range 模式反而有 50/200 顶。默认模式加同款硬顶（默认 50、上限 200）+ **最新优先**（封顶后不停在最老 50 条）+ 计入召回字符预算（此前只有取正文类工具付费，发现类列表可无限白嫖）。
- **graph: 账本重建把 error-end 事务重建成成功墓碑**（0-5，〔K〕P1-4）：`rebuildLedgerFromLog` 此前对带 error 的 `compaction/end` 一视同仁——partial 事务重建成成功记录、`tombstoneSeq` 指向 off-surface 的 error end 事件（喂给 `buildTombstoneRedirect` 产出假重定向）。现在：error 显式入账（`GraphPruneRecord.error`）、不产墓碑重定向记录、`prunedNodeIndex` 只收**确实离场**的 seq（被 claim 却仍在 surface 的不入剪索引，按实际 replace 恢复提交子集）。
- **recall: 归并墓碑的召回指针指向墓碑副本自身——递归空手而归**（0-6，〔Q〕M6）：聚合墓碑的 `seqs=`/`recall_pruned(N)` 写的是被归并墓碑副本的 seq，recall 打过去只会取回又一层墓碑文本。归并时沿 surfaceOp replace 链回溯到 **append 根源**（`resolveRootSeqs`）写进文案；存量旧聚合墓碑由 `recall_pruned` 的墓碑重定向兜底——检测"seq 的事件是 replace 且文本为墓碑"⇒ 返回根源原文（多根源逐条带 seq 头）。

### Added

- **构造期配置形状校验**（0-8，〔K〕P2-11 部分）：`skipPresets` 非数组（旧实现 spread 成字符数组 = preset 快照静默永不匹配）、NaN/Infinity 数值旋钮（预算与守卫静默偏移）在构造期**收集全部违例一次性显式拒绝**（插件激活失败并报清单，而非表面正常行为悄然错乱）。volatile 设置页旋钮不在此路径（到达时是 thunk 对象），归 settings schema 与 `sortMode` getter 兜底（非法值回退 `density`）。

### Docs

- **README / locale 过度声明纠偏**（0-7，〔Q〕§6 + 〔K〕§9）：「压缩率精确兑现」→「压缩目标按字符口径收敛（字符 ≠ provider 实际 token）」；「逐字节精确召回 / 历史永不销毁」→「文本块逐字、结构化参数 JSON 语义等价重建，原文保留在日志」；t-long 基准的 32K 数字标注对应已退役的旧 retain 公式。中英 locale 的 `meta.description` 同步收窄。

### 提示

- 测试：全量 426 例通过（新增 12 例修复锁 + 既有口径锁按新语义更新 3 处）。
- `spike/47-gate-replay.ts` 的闸级镜像与 `isAtomCandidate` 同步换锚（一致性自校验 0 不一致）。
- 本版无安装约束变化、无迁移动作。

## [1.10.1] - 2026-10-12（显示层与模型口径：插件页两层文案分离 + 退役模型名迁移 + README 可读性重构）

> **发行说明**：三件互相独立的小事打包——① 插件管理页双层文案（包卡片与组件行）曾试验 exports 子路径分离方案，实测会截肢 client half，已回退（本版双层文案行为与 1.10.0 相同，新增 prerelease-check 回归锁防止复发）。② 直连 DeepSeek 后端的内置默认模型名从已退役的 `deepseek-v4-flash` 迁到 `deepseek-flash`。③ README 首屏重构（概览图 / npm 徽章 / 30 秒上手），并修正两处与 1.9.1 之后行为不符的旧口径。
> **10-17 追加**：补上 `engines.dsh` 兼容性声明（宿主 0.2.1 官方要求的适配，见下），并修掉一个 0.2.1 上每轮必炸的提示词组装失败（preset override 携带了宿主已退役的 `{{cwd}}` 变量，见 Fixed）——后者是本版唯一会打断运行的缺陷，建议 0.2.1 用户务必升到本版。

### Added

- **`engines.dsh: ">=0.2.0-rc.1 <0.3.0-0"` 兼容性声明**：宿主 **0.2.1-rc.1** 起（`plugin-compatibility.ts` 的 `unmetRequirements`），插件 manifest 自带 `engines.dsh` 时**该范围单独决定 boot 准入、`peerDependencies` 整个被忽略**；不满足 ⇒ bundle patch 层静默跳过、压缩静默失效。上界写成 `<0.3.0-0` 而非 `<0.3.0`：peer `^0.2.0-rc.1` 实际展开为 `>=0.2.0-rc.1 <0.3.0-0`（semver 的 caret 展开排除 next-major 预发布），只有逐字对齐才能让两条声明对 `0.3.0-alpha.1` 这类版本给出同一答案——新宿主上赢的是 `engines.dsh`，两条分叉时 peer 会变成误导文档。声明与 peer 线双向 `semver.subset` 等价（prerelease-check 加锁），对运行时判定零行为变化；收益是 dsh.so / Discover 类市场页能按官方契约正确渲染兼容性标签。
  - `scripts/doctor.mjs` 同步换代：按运行时版本分流两代语义（<0.2.1-rc.1 走旧 peer 判定；≥0.2.1-rc.1 且声明了 `engines.dsh` 时只按该范围判定），输出显示实际判定依据。
  - `scripts/prerelease-check.mjs` 加锁：发布前断言 `engines.dsh` 存在、且每条 dsh peer 范围是其子集（防止两条声明日后分叉——分叉时新宿主上赢的是 `engines.dsh`，peer 会变成误导文档）。

### Fixed

- **0.2.1 宿主上每轮必炸：`unknown prompt variable "{{cwd}}" in section "deployment:persona-suffix"`**（表现为"本轮运行失败"，任何模型请求之前即失败）：
  - 起因是宿主 0.2.1 的破坏性变更——工作目录从"提示词变量"改为由 `working-directory` 服务注入的非插值 context（`packages/session/working-directory`，`interpolate: false`），`{{cwd}}` **不再注册**；组装期只剩 `model-selection` 注入的 `provider`/`model` 两个变量（宿主 `system-prompt` README 明文：custom persona templates must not depend on a built-in `{{cwd}}` variable）。官方同一提交（`2eb058d887`）也把自己 bundle 的三份 preset 的 `personaSuffix` 一并删了。
  - 我们 `cordis.patch.yml` 里三份 preset override（standard / cordis / ptc）是照抄宿主旧 preset 的，于是把已退役变量又带了回来，**且 preset override 是整块替换 config，宿主自己改了不算数**——升级到 0.2.1 后只要挂载这三份 preset，提示词组装必抛错。
  - 修法与官方一致：删掉 `suffix` 子句（工作目录信息由 working-directory context 自动提供，无需在 persona 里复述）。`prefix` 里的 `{{model}}` 仍由 model-selection 注册，保留不动。
  - `scripts/prerelease-check.mjs` 新增 **2.9 回归锁**：补丁里出现的任何 `{{var}}` 必须在宿主注册集 `{model, provider}` 内，否则拒发布（正/负控实测捕获正确）。
  - ⚠️ 自定义 profile 补丁里若也写过 `Working directory: {{cwd}}`（如自定义 preset / `personaSuffix`），同样会在 0.2.1 上每轮炸——按宿主 README 删掉该子句即可。

### 提示

- **直连后端模型名迁移**：未显式配置 Stage-1 的 `llm` 且走 `endpoint`/`apiKey` 直连（或 `DEEPSEEK_MODEL` 未设）时，默认模型从 `deepseek-v4-flash` 改为 **`deepseek-flash`**（2026-09 起官方 GA 名；`deepseek-v4-flash` 已退役、旧名仅作兼容路由至 V4.1-Flash）。自动跟随宿主路由的部署不受影响；**显式钉过 `model: deepseek-v4-flash` 的部署建议手动换到 `deepseek-flash`**——旧名虽仍可路由，但实际已由 V4.1-Flash 承接，钉旧名会掩盖这层迁移。
- 本版无安装约束变化、无迁移动作（`engines` 与 `keywords` 在 1.10.0 已生效）。

### Changed

- **插件管理页双层文案实验回退**（1.10.1 内部往返，最终行为 = 1.10.0）：曾尝试把组件行改走 `dsh-argp/engine` exports 子路径以让包卡片与组件行文案分离，实测**该方案会整体截肢 client half**（见 Fixed），已回退：`cordis.patch.yml` 组件行 `name` 恢复裸包名 `dsh-argp`；exports 移除 `./engine/package.json` 与 `./engine/locale/*`（保留 `./engine` 入口与 `./locale/*` 展示字典）；删除 `engine.package.json`、`locale-engine/`。两层文案维持同源重复（宿主显示层的既有限制，非本版回归）。
- **Stage-1 直连默认模型**：`deepseek-v4-flash` → `deepseek-flash`（`peratom/compressor.ts`、`peratom/cite-declarer.ts`、`peratom/compressor-types.ts` 共 6 处 fallback）。
- **`spike/deepseek.ts` 共享挂载随迁**：`DEEPSEEK_MODEL` 改为 `env['DEEPSEEK_MODEL'] ?? 'deepseek-flash'`（新增 env 覆盖能力）；历史产物不可在新 API 原样复现，已在 README 复现节披露口径（其余 spike 单点硬编码属历史台账，保留原样）。

### Docs

- README(.en) 首屏重构：一句话定位 + 概览图（`.github/assets/argp-overview.svg`，GitHub/npm 双端可见）+ 30 秒上手命令 + npm version / downloads 徽章；中英同步。
- README(.en) 口径修正：安装节「npm 默认 = 纯 Stage-2」旧文案（1.5.x 遗留）改为「安装即挂、双引擎全开」；「在 profile 层禁用 compaction-basic」改为「已随包完成、无需手工步骤」。
- README(.en) 复现节补**历史 DeepSeek 臂模型口径**（退役说明 + 不可原样复现 + 重跑方式）；测试计数更正为 415/415。英文版同步了 Stage-2 retain 公式（1.5.1 起 = 可压缩内容 × 0.2）与 tombstone 召回链路两处历史失实。

### Tests

- `test/peratom-llm-adapter.test.ts` 的模型名 fixture 随迁（mock 后端，零真实网络）。
- 全量 415/415、typecheck 0 错。

## [1.10.0] - 2026-10-12（`/argp` 状态命令：压缩状态第一次有了人类可见出口 + 声明 Node 引擎约束）

> **发行说明**：此前 ARGP 的全部状态——预算、剪枝台账、召回命中、cites 统计、双引擎到底挂没挂——**只存在于日志里**，判断「压缩生效了没有」只能去翻 log。本版新增 `/argp` 命令，把这套内观测面搬到一行命令上：只读、零模型交互、零副作用。同时补上 `engines.node` 声明（与宿主 dsh 自身要求对齐），并补齐 npm `keywords`。

### 提示

注意：本版新增 `engines.node = "^22.19.0 || >=24.0.0"`（与宿主 dsh 根 `package.json` 同口径）。**Node 20 / 21 的环境安装会被 npm 拦下**（`EBADENGINE`）——这类环境本来也跑不了宿主，但此前不会在**安装 argp 时**报错。仍在旧 Node 上的部署请先升 Node 再升级本插件。`/argp` 是纯新增命令，不改动任何既有配置键与行为，无迁移项。

### Added

- **`/argp` 只读状态命令**（分段详单，5~6 行）：
  - `ARGP <版本> · engine: graph|graph+peratom · preset: <id>`（preset 命中 `skipPresets` 时附 `ARGP inactive`，一眼看出「为什么没压缩」）
  - `budget: trigger X / retain Y · now Z (source=anchored|tokenMeter|config|chars)`——触发线 / 保留目标 / 当前占用及估算来源
  - `prunes: N · last R ranges / I items / A→B (forced) · pruned index P`——剪枝次数与末次形状
  - `recall: N calls · H hits (P%)`
  - `cites: …`（仅双引擎 declarer 在位时输出；纯 Stage-2 下整段省略，不输出恒零噪声）
- **`engines.node`**：`^22.19.0 || >=24.0.0`（宿主同口径；随包 patch 含 `process.getBuiltinModule`，需 Node ≥ 22.3）。
- **`keywords`**：补 13 个 npm 关键词（`dsh-plugin` / `context-compression` / `token-optimization` 等），进 npm 与 dsh 生态发现工具的抓取面。

### 设计边界（为什么要记下来）

- **只读，不做 `/argp compact`**：手动压缩已有宿主官方 `/compact`（`@deepseek-ai/dsh-command-compact`，由各 preset 层挂载），它调 `ctx.compaction.compactNow(agent, signal, commandId)` —— 落到的就是本引擎。再开一个入口是重复命令，还多背一条 `sourceCommandId` 契约面（铁律 1③）。
- **不新增 boot 期失败面**：命令服务经嵌套 `ctx.inject(['commands'], ...)` 获取（与 `registerSettings` 同款），宿主无 commands 服务时回调不执行 ⇒ 静默不注册，引擎其余装配完全不受影响。这一点在 dsh.so L5.2 web boot 失败排查未结案的当下是硬要求——任何「缺服务即抛」的写法都会污染那边归因。
- **生命周期由宿主负责**：`command/run` ↔ `command/done` 配对事件由宿主 `CommandRuntime` 写入（log-only，不进 model surface），本模块只提供 `{name, description, input, recordInput, handler}`。`recordInput: false`——无参数命令不往日志里堆空 `args`。
- **版本号不漂移**：`ARGP_STATUS_VERSION` 常量由 `scripts/prerelease-check.mjs` 断言与 `package.json` 的 `version` 一致（忘了改直接卡发布）。

### Docs

- README / README.en：补 dsh.so 检测口径说明——**L4（沙盒安装层）全站通过率 100%、L5（web 启动层）74.5%**，徽章显示的是「该 dsh 版本下**最近一次**检测结果」，不是永久状态。

### Tests

- 新增 `test/argp-command.test.ts`（7 例，全绿）：注册进宿主命令发现列表（descriptor 形态）、输出分段详单、双引擎/纯 Stage-2 下 cites 段自适应、宿主 `CommandRuntime` 写出的 `command/run` ↔ `command/done` 配对（`commandId` 一致、`args` 缺席）、只读性（surface 不变、除两条生命周期事件外无新增事件）、无 commands 服务时静默降级、压缩一次后 `prunes: 1` 与台账一致。
- 测试跑**宿主真实 `CommandRuntime`**（`ctx.plugin(CommandRuntime)` + `runtime.execute()`），不自己复刻宿主契约（铁律 3）。

## [1.9.1] - 2026-09-30（修复：双引擎缺省即挂——安装即用，不再依赖 profile 层手工挂载）

> **发行说明**：收口 §11.13.1 的**结构性缺陷**——Stage-1（双引擎）此前**没有生产挂载路径**，用户必须按文档在 profile 层手写 `peratom` 块才可能挂上；而那条「开启配方」本身还是脆的（见下）。现在判据落在代码里：`peratom` **缺省即挂**，市场安装后即为双引擎，零手工配置。显式 `peratom: false` / `null` 仍是关停，语义不变。

> **节奏破例（P0）**：本版与 v1.9.0（09-29）同周，按「最小间隔」条属破例，理由记此备查——该缺陷使**本插件的核心卖点（双引擎）对所有用户结构性不可达**，且文档给出的唯一开启方式会被外层 config 静默冲掉，属「功能等于不存在」，故不等下个窗口。

### 提示

注意：升级后 **Stage-1 默认开启**，compressor / declarer 会按宿主路由发起 LLM 调用（`purpose='compaction'`）。只想保留 0-LLM 图剪枝的部署，请在 profile 层显式写 `peratom: false`（片段见文末「升级注意」）。

### 背景：为什么默认值必须落在代码里

dsh 各层 patch 的 `config` 是**整块替换**而非深合并（`dsh-app-boot`：*"A patch config replaces the whole config"*，层序 bundle → profile → home → CLI）。因此把默认值写在包的 bundle patch（`cordis.patch.yml` 的 `insert` 行）里并**不可靠**：用户在设置页动任一旋钮（表单值写回 profile 的 `cordis.patch.yml`）就会整块冲掉 `peratom`，双引擎**静默**退回纯 Stage-2（0-LLM）——正是 §11.13.1「Stage-1 无生产挂载路径」缺口复发的形态。判据落在代码里，则任何层只要不显式关停都保持挂载。

### Fixed

- **Stage-1 无生产挂载路径（§11.13.1 收口，主修复）**：`mountPeratomStack` 闸门由 opt-in 反转为 opt-out——`peratom` 缺省 / `true` / 对象 ⇒ **挂**；`false` / `null` ⇒ 不挂（YAML 关停写法，两种等价）。安装即双引擎。
- **`src/peratom/mount.ts` 工厂重复挂载**：工厂自行构造三管线并显式接线，必须传 `peratom: false` 关停引擎的构造期自挂载——否则闸门反转后引擎会再挂一套 Stage-1，并把工厂注入的接线判为「显式传入」而忽略，工厂返回的句柄与实际生效的管线脱钩。
- **`ArgpGraphConfig.peratom` 类型补齐 `boolean | null`**：此前类型只允许对象，而运行时与文档一直支持 `peratom: false` 关停写法（typecheck 报 TS2559 / TS2367）。类型与运行时语义自此一致。

### Added（兼容规则）

- `peratom` **缺省**且调用方自带 `injectEdges` / `onOverflowCompress` / `onPrePressureCompress` 时**不自动挂载**（尊重调用方自装配，避免把调用方的注入判成「显式传入」而忽略）。显式给了 `peratom` 时仍按 peratom 优先，沿用原「显式接线被忽略并告警」语义。
- 缺省挂载后 Stage-1 的 LLM 后端解析不变：`peratom` 内未配 `llm` 时自动跟随宿主路由（`autoDshLlmSpec`）；三路都解不出时组件 disabled（零网络）。

### Docs

- README / README.en：「npm 默认 = 0-LLM 图剪枝，即仅 Stage-2」→「默认 = 双引擎全开，安装即挂」；「启用 Stage-1（双引擎）」小节重写为「Stage-1（双引擎）：缺省即挂 / 如何关停」，补上关停写法、后端配置与「默认值为何在代码里」的说明。
- `docs/`（`.gitignore` 排除，不进 git、也不进 npm 包）：`dsh-argp-mount-example.md` 同步口径（bundle patch 不再被描述为「只挂 0-LLM 图引擎」）。

### Tests

- 新增 4 例：缺省即挂（三管线 + `injectEdges`/`onOverflowCompress`/`onPrePressureCompress` 自动接线 + 重试上限 1→3）、`peratom: null` 关停、缺省但调用方自带接线时不抢占、overflow retries 新默认（3）。
- 按新默认修正 6 处夹具：`test/peratom-p4.test.ts`（`makeEngine`）、`test/auto-continue-e2e.test.ts`（`makeHarness`）、`test/peratom-mount.test.ts`（纯基线臂）、`test/argp-graph-engine.test.ts`（overflow retries 用例）显式写 `peratom: false`。
- 全量 **408/408 通过**；`typecheck` + `typecheck:spike` 0 错误。

### 升级注意

老部署升级后 **Stage-1 默认开启**：compressor / declarer 会按宿主路由发起 LLM 调用（`purpose='compaction'`）。只想保留 0-LLM 图剪枝的部署，请在 profile 层显式写：

```yaml
- id: dsh-argp
  config:
    peratom: false
```

## [1.9.0] - 2026-09-29（极简 preset 保留原生态：skipPresets）

> **发行说明**：本版新增 `skipPresets` 配置——在列出的 agent preset 下 ARGP **不生效**（不剪枝/不压缩），会话历史保持原生态。默认 `['minimal']`：极简 preset 本身无 compaction 组，本插件在其下不介入，与「未安装 dsh-argp」的原生行为一致。

### 背景

dsh-argp 的 `ArgpGraphEngine` 注册为宿主的 `compaction` 服务，对**所有**会话生效——包括「极简（minimal）」preset。但 minimal preset 的设计意图是**最简、原生态**（无 compaction 组、无 ARGP 介入）。此前 ARGP 会在 minimal 会话上照常剪枝/压缩，与该 preset 的原生态意图相悖。本版让 ARGP 在 minimal 下退场，把压缩决策完全交回宿主原生行为。

### Added

- **`skipPresets` 配置（默认 `['minimal']`）**：在这些 agent preset 下 ARGP 不生效——`compactIfNeeded`（轮初压力 / 上下文溢出 / 反应式三条自动路径）与手动 `/compact` 的 `compactNow` 均直接返回 `null`：不剪枝、不压缩、不产生事务。判定按**会话实际运行的 preset**（session projection `agentPreset`，可被 `agent-preset/selected` 事件切换）；无 preset 信息的会话（headless/CLI profile 无 preset registry）不受影响。设为 `[]` 关闭该行为（所有 preset 下都生效）。
- **`test/argp-graph-engine.test.ts`：+4 例回归**——minimal 不剪 / standard 照常剪 / `skipPresets:[]` 时 minimal 也剪 / 无 preset 信息照常剪。摘掉任一闸门必变红（mutation 验证）。

### 实现要点

- 读取 `agentPreset` 经 `ctx.get('sessionProjections')`（reflect 层「无需 inject」的读法）——直接属性访问 `ctx.sessionProjections` 会抛 `cannot get property … without inject`（本插件 `static inject` 只声明 `tools`/`systemPrompt`）。`sessionProjections` 是 dsh-base 核心服务（恒在）；`agentPreset` projection key 由 web-app 的 `agent-preset-registry` 注册，dsh-argp **不依赖**该包，故经结构类型窄接口读取，服务缺失时安全降级为「不跳过」。
- **零新增 peer/dep**：宿主 peer 契约（`^0.2.0-rc.1` 等）不变，准入预检行为与 1.8.0 完全一致。

### 提示

- **测试**：全量 **405 例**通过（含新增 4 例）。
- **宿主**：仍要求 `0.2.0-rc.1`+（peer 不变）。
- **生效方式**：需发布并重装 dsh-argp（`dsh plugin --profile <name> add dsh-argp@1.9.0`）；已装 1.8.0 的 profile 升级到 1.9.0 后，minimal 会话即恢复原生态。

## [1.8.0] - 2026-09-29（宿主 0.2.0-rc.1 对齐 + shadow-price 口径统一 + 剪枝选择索引化）

> **发行说明（汇总版）**：本版汇总两批改动——已发布但未 promote 的 **1.8.0-beta.0**（A10 结构保护放行 + 组内 R 全立碑整组退场，解除压缩率上限）与**本轮 0.2.0-rc.1 对齐批**。**代码适配量为 0 行**（0.2.0-rc.1 对 argp 的全部运行时增量只有 `dsh-session` 的 repair 重构；`compaction`/`llm`/`agent`/`tools` 四包 lib 零差异），但**宿主基线上移本身是破坏性的**：`1.7.0` 用户在 `0.1.7` 宿主上会被准入预检静默跳过。

### 升级指引

- **npm `latest` 由 `1.7.0` 进入 `1.8.0`**——`1.8.0-beta.0` 的内容并入本版，beta 号不再单独存在。
- **本版要求宿主 `0.2.0-rc.1`**：peer 范围 `^0.2.0-rc.1` 按 semver 预发布规则**含** `0.2.0` 正式版及全部 `0.2.x`、**不含** `0.1.7-*` 全套。**仍在 `0.1.7` 宿主上的部署不要升到 1.8.0**：宿主自 **0.1.7-rc.1** 起有 boot 期 bundle 准入预检（`packages/boot/app-boot/src/plugin-compatibility.ts` 的 `evaluatePluginCompatibility`），peer 不满足且未豁免时该 profile bundle 在 **patch 层被静默跳过**（仅在 stderr 打一行 `skipping profile bundle`）⇒ **压缩无声失效**（无报错、无告警、无 UI 提示）。`npm run doctor` 可独立探测该判定。
- **需留在 `0.1.7` 宿主**请用 `dsh-argp@1.7.0`。
- **会话格式零变化**：`session-format*` 六个包在本区间**只有版本号变动**，**无 v4→v5**；`Session.append` 对 `compaction/*` 的**写入侧校验仍未加**（三条宿主契约照旧由 argp 侧自守，见 1.7.0 节的 Fixed ①②③）。
- **无需重建会话**：本版不改变墓碑文案的**可识别性**（1.7.0 的旧文案仍可识别与归并），老会话继续压缩即可。

### Changed

- **依赖 bump `0.1.7-alpha.2 → 0.2.0-rc.1`**：6 个 `peerDependencies`（agent / commands / compaction / llm / session / tools）+ 21 个 `devDependencies` 全对齐；`cordis ^4.0.2` / `schemastery ^3.18.1` 不动。**类型层零迁移**——实测 `npm run typecheck` 0 错误（对照 0.1.6→0.1.7 那次的 18 处）。
- **文档基线修正**：`ARCHITECTURE.md` §6.1 与 `SECURITY.md` 的宿主支持基线由 `0.1.6-alpha.1` 修正为 `0.1.7-alpha.2`（补 1.7.0 批的文档欠账）。

### 优化

- **constants: 新增 `HOST_CHARS_PER_TOKEN = 4` 与 `shadowedTokensOf(chars)`**，作为 `shadowedTokenCount`（宿主契约字段）的**唯一定价点**；全部发射点禁止各自裸写除数。
- **prune-selection: 新增 `buildPruneIndexes()`**——每次 `compactIfNeeded` 建一次边/原子索引（`incomingEdges` / `outgoingEdges` / `incomingDetEdges` / `rsByCallId`，O(A+E)），把 `isAtomCandidate` 的 per-atom `edges.filter`（O(E)）、A10 块的两个 `.some`（O(E)/O(DE)）与组内找 R 的 `atoms.filter`（O(R)）全部降为 O(1)。索引按原数组顺序 push ⇒ 命中集合与原线性扫描**逐字等价**。
- **prune-selection: `mergeIntervals` 的 O(n²) → O(n)**——`seq→atom` 索引提到循环外建一次（旧实现每轮迭代全表 `find`）。实测 8000 原子单次压缩 **126ms → ~1ms**。
- **argp-graph-engine / spike47: 同步复用入边索引**——`citedBySeq` 由 `edges.filter` 改查 `pruneState.incomingEdges`；两处 `pruneState` 构造点（引擎 + gate-replay）与测试 `makeState` 统一走 `buildPruneIndexes`（单一事实源）。

### 修复

- **shadow-price 口径统一（P0，账目一致性）**：1.8.0 前**三处发射器三种口径**在同一条 shadow-price fold 流上记两本账——peratom 整窗 `summary` 用硬编码 `/3.5`、peratom per-atom `prune` 用 `/4`、`prune-tx` 的 summary/prune 用**旋钮** `host.charsPerToken`（可被用户改成任意值）。三处现统一经 `shadowedTokensOf`（`/4` = 宿主 `dsh-token-meter` 的 `CHARS_PER_TOKEN`）。漂移后果是宿主 running total 与 WebUI 每笔剪枝显示**系统性偏移**（非协议违约——invariant 只查非负整数，故此前长期未被发现）。`prune-tx` summary 文案里的「约 N tok」显示同源修正。
- **tombstone-text: 文案长度注释与实测对齐**——区间 115 → 46、单节点 43、tool 占位 42 → 44（均 **1 位 seq 基准**，随位数增长）；补「2 位 seq 区间 = 49、4 位 tool 占位 = 50」对照，替代 1.8.0 前「42 → 50」的单值口径。

### Added

- **`test/tool-call-recovery.test.ts`（宿主契约回归锁）**：0.2.0-rc.1 把 `tool/result` 的消账条件从「按 callId 无条件消账」收紧为「必须 `surfaceOp === 'append'` 且 turn/step 相等」（宿主写死为 `repair.spec.ts` 的 `does NOT synthesize a result for a tool-call that already has one`），而 argp 的 per-atom 压缩副本正是 **replace** 形态 ⇒ 显式锁住。两例均跑宿主**真实** `interruptedTurnClosers`：① argp 真实产物形态（原始 append 应答在日志 + replace 压缩副本）⇒ 补结果数 = **0**；② 判别力对照（同一条日志，**唯一变量**＝把该 tool/result 的 `surfaceOp` 由 `append` 改成 `replace`）⇒ 立刻补 **1** 条。
- **`test/compaction-prune-017.test.ts` 口径锁定测试（+64 行）**：对 `shadowedTokensOf` 与真实发射路径双重验锁——摘掉任一发射点的该函数调用**必须变红**。

### 提示

- **测试**：全量 **401 例**通过。
- **准入判据**：`npm run doctor --dsh-version 0.2.0-rc.1` → **exit 0**（1.8.0-beta.0 时为 exit 1、6 个 peer 全 FAIL）。
- **本版含 beta.0 的剪枝语义变更**（A10 结构保护放行 + 组内 R 全立碑整组退场）：老会话可直接受益，无需重建；如需回退旧行为请用 `1.7.0`。
- **宿主侧语义变更（已判定不伤 argp）**：`dsh-session/repair.ts` 重构 + 新增 `ToolCallRecovery`；同时新增**失败步恢复**——宿主自行给未应答的 tool-call 补 `TOOL_OUTCOME_UNKNOWN` / `TOOL_NOT_STARTED` 结果。若你在 argp 侧或部署脚本里有针对「步抛异常 ⇒ 悬空 tool-call ⇒ provider 400」的**自建兜底，可以删**。

## [1.8.0-beta.0] - 2026-09-25

> **发行说明（汇总版）**：本版汇总两批改动——未发布的 **1.7.1** 批与 **C 批（A10 结构保护放行 + 整组退场）**。C 是本版唯一改变剪枝语义的机制改动：带 tool-call 的 A 类原子，在其应答组 R 全部立碑后不再永久受保护。

### 新功能

- recall: 召回入口降闸——`recall(query)` 提为首选，每轮硬上限由 3 次改为按字符预算
- cites: 新增 `ARGP_CITES_DUMP` 声明边落盘（每条 cites 与注入边丢弃/重定向计数，默认关）

### 优化

- prune-selection: A10 结构保护加前置放行——组内 R 已全部立碑时该组失去保护对象，A 恢复可剪，解除压缩率上限
- prune-selection: 组内 R 全立碑的候选组整组退场，区块边界回退避免把 A 与其 R 拆开
- prune-tx: 墓碑文案去冗，区间墓碑 115 → 46 字符，tool 占位墓碑 42 → 44 字符（均 1 位 seq 基准、随位数增长；4 位 tool 占位 = 50）
- prune-tx: 墓碑文案与识别判据合并到新叶模块 `tombstone-text.ts`，不再手工同步 9 处
- settings: 设置页旋钮迁移到宿主 live config，改动不再需要重挂插件
- docs: README 的 tombstone 召回限制改写为当前现状

### 修复

- prune-selection: 修复"墓碑换墓碑"空转——已立碑节点按终止态排除，不再每轮重入候选
- prune-selection: 新增整组退场后的配对校验，A 被剪则其 R 必须同批，避免区间边界挤出孤儿 tool/result
- prune-tx: 修复 tool 占位墓碑 0% 带 seq——改后 100% 带原节点 seq，`recall_pruned` 一跳可取回
- tests: 修复 `trigger-levels` L3⑤ 夹具（原依赖长墓碑制造的假压力，文案缩短后失效）
- cites: 修复声明边因端点已墓碑化而被整体丢弃

### 提示

- 会话格式双向兼容；1.7.0 的旧墓碑文案仍可被识别与归并，老会话可继续压缩
- 本版改变剪枝语义：老会话可直接受益，无需重建；如需回退到旧行为请置于 beta 前版本
- 实测（5 轮真实会话 + 进程重启）：0 孤儿 tool/result、0 provider 400、三套宿主契约 0 违规、重启可重开
- 测试：全量 396 例通过

## [1.7.0] - 2026-09-23（宿主 0.1.7 全量对齐 + 三条「重启才炸」加载期契约修复；汇总 beta.0~beta.5）

> **发行说明（汇总版）**：本版由 **1.7.0-beta.0 ~ beta.5** 六个 beta **汇总**而成（另含未 promote 的 **1.6.1-beta.0**）。其中 beta.0 / beta.1 / beta.2 / beta.3 曾以 `npm publish --tag beta` 单独发布；**beta.4 / beta.5 从未单独发布**（仅存在于工作树），内容一并并入本版。
>
> 宿主基线 **`0.1.6-alpha.1` → `0.1.7-alpha.2`** 是**破坏性**迁移：0.1.7 把 tool/result 升为一等 `role:'tool'` 消息（日志格式 V3→V4）、取消 `source.kind:'plugin'` 兜底 kind、把 `compaction/prune` 提升为原生事件，并在 `token-meter` 引入 **shadow-price 协议**、在 `compaction` 侧收紧两条加载期校验。本版一次性吸收全部结构性变更，并修掉**三条**「`compaction/*` 写入侧不校验 ⇒ 落盘静默成功；重启 `session/created` 重放才 throw ⇒ **会话永久打不开**」的契约违约。

### 升级指引

- **npm `latest` 由 `1.6.2` 直接进入 `1.7.0`**——不补发 beta.4 / beta.5，也不 promote `1.6.1-beta.0`。
- 本版要求宿主 **`0.1.7-alpha.2`**；peer 范围 `^0.1.7-alpha.2` 按 semver 预发布规则**含** `0.1.7-rc.1`、**不含** `0.1.6-*`。仍在 `0.1.6` 宿主上的部署**不要**升到 1.7.0：实测 1.6.0 代码 × 0.1.7 宿主 = **6 个真回归 + 18 处类型错误**，反向亦然（`^0.1.6-alpha.1` 同样排除 0.1.7 全套）。
- **会话格式双向兼容**：V3（`session.v3.jsonl.zstd`）与 V4（`session.v4.jsonl.zstd`）都可读；语料读取器已改为 glob 两者（不改会**静默漏读** 0.1.7 起的全部 v4 会话）。
- **已被 beta.2 / beta.4 / beta.5 写坏的会话不会自动恢复**——损坏已落盘为 `compaction/*` 日志事件（off-surface，不改变可见内容）。升级只保证**新写入**不再产生坏记录；存量坏会话需按其派生事件带备份重写。

### Fixed ① —— 三条「写入无感、重启才炸」的加载期契约（会话永久打不开）

四条修复同属一类失败模式：`Session.append` **不校验** `compaction/*` ⇒ 落盘静默成功，**重启加载**（`session/created` 重放）才抛 ⇒ 会话打不开。

| # | 进入版本 | 违约内容 | 宿主校验（0.1.7） | 触发面 |
|---|---|---|---|---|
| ① | beta.2（Issue #2） | `compaction/summary` 的 `shadowedSeqs` 取「真正被替换的**离散**原子」，而非「**发出时刻**当前 surface 在 `[range.start, range.end]` 的**连续切片**」；且 summary 发在 replace 循环**之后**（原原子已离开 surface） | `dsh-compaction` invariant `validateShadowedSeqs` + v3-to-v4 `Relationships.span()` | peratom flush + Stage-2 图剪，**每次压缩** |
| ② | beta.4 | peratom flush 发**一条整窗** `summary`（range=整轮窗口）+ **多条单原子** `replace`（range=该原子）⇒ 首个 replace 撞整窗 claim，范围**不严格相等** | `token-meter` `foldSurfaceProjection` 的 **shadow-price 协议**（append 与 replay **两侧**都跑 ⇒ 活轮与重启**双双**炸） | peratom flush，**每次压缩** |
| ③ | beta.5 | `/compact` 事务只在 `compaction/start` 带 `sourceCommandId`，`summary` / `end` / **压缩 checkpoint** 不带 | invariant `validateSourceCommandId` + v3-to-v4 `Relationships.compactionOwner` | **跑过 `/compact` 且会话被重新加载** |
| ④ | **1.7.0（本版新增）** | 成功 `compaction/end` 之后的语句（断言 2b / 记账 / 遥测）抛出时，`catch` **无条件**再补一条 end ⇒ 同一 `compactionId` 写出**两条 end** | invariant `applyCompactionTransition`（对 `end` 无分支 ⇒ 首条 end 已清空 `trace.compaction`，第二条命中 `compaction/end has no matching compaction/start`） | 需先有内部不一致（可达性低，但后果**不可逆**） |

- **① 修法**（beta.2）：`compaction/summary` 移到 replace 循环**之前**（发出时刻整窗仍完整），`shadowedSeqs` = 整窗连续 surface 切片（离散性被"整窗"吸收）；加**防御自检**（窗口非有效当前 span / 覆盖受保护 system head ⇒ throw + 落带 `error` 的 `end`，**不发坏 summary**）。peratom 与 prune-tx 同失败类一并修。
- **② 修法**（beta.4）：对齐 `prune-tx` 既有纪律——每条 replace 前各发一条 **per-atom `compaction/prune`**，`shadowedRange = {start: seq, end: seq}`（与该 replace **严格相等**）、`shadowedSeqs = [seq]`（单节点连续切片，同时满足 ①）、`shadowedTokenCount = ceil(原字符数 / 4)`（宿主 `CHARS_PER_TOKEN = 4`）。整窗 `summary` 的 claim 被首条 prune 覆盖、末尾被 off-surface `end` 清掉，无冲突。
- **③ 修法**（beta.5）：把可选 `sourceCommandId` 提成 `sourceCommandIdField`，在 `start` / `summary` / 成功 `end` / catch 错误 `end` **四处统一展开**；压缩 checkpoint 改 `compactCheckpointSource(compactionId, host.compactSourceCommandId)` ⇒ 一笔事务的**全部五个**受校验事件（start / summary / end / checkpoint）同值（自动压缩时一致为 `undefined`，同样合法）。
- **④ 修法（本版新增）**：`ended` 守卫——成功 `end` 落地后置 `true`，`catch` 内 `if (!ended)`。把"防御性断言把可恢复错误升级为不可逆损坏"这条路径关掉。

### Fixed ② —— 其它

- **客户端 half 注册泄漏**（beta.3）：`apply()` 里 `locale.register(ns, dict)` 与 `assistantDisplay.register(filter)` 都丢弃了返回的 disposer。宿主的"重新激活" = **dispose 旧 fiber + 重新 apply client half**（设置页 enable/disable、客户端版本变更——**每次装新版都会触发**、HMR 重载都走这条），泄漏的字典在 teardown 时无人摘除 ⇒ 第二次 apply 时 `dsh-client-locale` 直接抛 `locale namespace "dsh-argp" already has locale "zh"`，设置页报「本页面的插件未能完成同步」并**回滚激活**；`assistantDisplay` 不抛但会**叠加**过滤器。修法：新增 `registerDisposable(ctx, execute, label)`（= `ctx.effect(execute, label)`，无 `effect` 的退化 ctx 直接执行），两处注册改走它。
- **中断轮并入下一轮**（beta.0）：中断轮 N 的**完整**原子（U-long + R）不在 N 自己的 pass 压（轮刚被中断，racy），而是**并入下一轮 N+1 的 pass**（settled，无 race）；`collect` / `flush` / `cite-declarer` 三处语义对齐，落地后**同时推进** `closed` 与 `prevTurn` 两个水位。边界：连续多轮中断时只并入"紧邻上一轮"。
- **语料读取器 v3+v4**（beta.0）：从硬编码 `session.v3.jsonl.zstd` 改为 glob `['session.v3.jsonl.zstd','session.v4.jsonl.zstd']` 取存在者——不改则 0.1.7 起的 v4 会话被**静默漏读**，语料审计/回归系统性偏少。

### Added

- **U-info 副本保留附件块**（beta.0；`decision.attachmentBlocksOf` + `userCopyPayload` 第三参）：peratom 压缩一条**带图片/文件附件**的 user 消息时，U-info 副本 = 压缩文本 + **原样 image/file 块**（不再静默丢弃）。宿主附件模型里附件是**引用块**（指向持久存储），LLM 侧只渲染为 `[image omitted]` 占位 ⇒ 旧实现产出纯文本 content 会把附件块**从模型实时上下文静默丢掉**（原文仍在 append-only 日志可 recall，但 surface 没了）。宿主合法性已核：`planSurfaceEvent` 对 user/message 的 surface replace 只校验 range + provenance。无附件场景产物与 1.6 逐字节一致（零回归）。**前瞻防御**——受控语料 18 session / 251 条 user 消息中 0 条带附件。
- **`OWN_SOURCE_KINDS` 正向白名单 + `isOwnSourceKind(kind)`**（beta.0）：`['plugin','argp','compact-checkpoint']`，替代散落的 `kind === 'plugin'` 字面比较。取舍依据：反转逻辑（`kind === 'user' ? 'U' : 'X'`）的失败模式是"新的真实用户 kind 被误判 ⇒ **丢召回**（数据丢失）"；正向白名单的失败模式是"新的注入 kind 被当 U ⇒ **轻微噪声**"。**白名单失败模式更安全。**
- **`llm-source-augment.d.ts`**（beta.0）：向宿主 `MessageSourceMap` 声明 `argp` kind（`{kind:'argp'} & ContextFormed`），使 `{kind:'argp'}` 字面量通过 0.1.7 的 `createUserMessage` 类型检查（宿主自家包同款先例）。纯 `.d.ts`，不参与 `lib/` 发射、运行时无影响。
- **tool/result 压缩副本头部标记**（来自未 promote 的 **1.6.1-beta.0**）：副本正文头部拼 `[已压缩-摘取 seq=N]`（extract）/ `[已压缩-摘要 seq=N]`（summary），生产默认 `config.toolCopyMarker = true`。理由：extract 档 prompt 契约要求 text 是原文**逐字**片段，与完整工具输出**同形**；summary 档是改写 ⇒ 标记明示"这段不可逐字引用"。**带 seq 是必需的**——seq 是日志内部序号，模型在 tool/result 里看不到，不带则 `recall_detail(N)` 无参数可调、召回通路实际是断的。配套：no-op 守卫改为按**落地后**真实长度（`action.text.length + marker.length`）判收益，消除"加标记反而持平/变长"的白压；导出 `toolCopyMarkerText` / `TOOL_COPY_MARKER_RE` 供语料审计剥离标记。
- **`compaction/prune` 0.1.7 协议核验测试**（beta.0）：核 0.1.7 宿主**接受** dsh-argp 的 `compaction/prune` 发射（无 `ignorable` 也过准入）+ shadow-price 协议在 0.1.7 成立。
- **事务括号配对测试**（1.7.0）：`test/compaction-tx-brackets.test.ts`——prune-tx 侧两条（守卫回归 + 反向对照），peratom 侧见 `test/peratom-flush-reload.test.ts` ①c。

### Changed

- **依赖 bump `0.1.6-alpha.1 → 0.1.7-alpha.2`**（beta.0）：`peerDependencies`（dsh-agent / commands / compaction / llm / session / tools）+ `devDependencies`（含 dsh-agent-loop / compaction-basic / invariants / llm-deepseek / llm-pi-ai / session / system-prompt / token-meter / tool-bash / tools）全对齐 `0.1.7-alpha.2`；`cordis ^4.0.2` / `schemastery ^3.18.1` 不动。
- **V3→V4 tool/result 双形状（写侧）**（beta.0）：`decision.toolCopyPayload` 与 `prune-tx` tool 占位墓碑都按 `role === 'tool'`（V4：content 换单 text block，顶层 `role`/`source`/`toolCallId`/`isError` 经展开原样保留，满足 `assertToolResultRewrite`"只改 content"）与 `role === 'user'` 内嵌 `tool-result`（V3：只改该 block 的 inner text）双分支产出。**读侧零改动**（V4 直接数组走既有 `block.type === 'text'` 分支；callId 全走 `source.callId`）。
- **source.kind 去 `'plugin'` 化**（beta.0）：steer 通知 `{kind:'plugin', plugin:'dsh-argp', form:'notice'}` → `{kind:'argp', form:'notice'}`（唯一裸 plugin 持久化写点）；`userCopyPayload` `{kind:'plugin'}` → `{kind:'argp'}`（瞬时，flush 统一覆盖成 `compact-checkpoint`）。读点统一改走 `isArgpUserInfo(data)`（U-info 恒 U，先判）+ `isOwnSourceKind(kind) ? 'X' : 'U'`，三场景（新建 V4 / 迁移 V3→V4 / 纯 V3）判据全部正确。
- **0.1.7 preset-cleaner 重写为 override-only 自净化**（beta.1）：0.1.7 把 agent 平面移入 **agent preset**，默认 preset（standard / cordis / ptc）的 `compaction` 组自带**隔离的 stock provider** ⇒ 默认 preset 下 ARGP 的 Stage-2 图剪被 stock `compaction-basic` **遮蔽**；而 0.1.6 的 preset-cleaner（复制到用户根 + 运行时手术）在 0.1.7 **结构性失效**（`AgentPresetRegistry` 无 copy/read/mutate API，`register()` 对重复 id 直接 throw）。新方案：`scripts/generate-preset-overrides.ts` 读 shipped preset patch → 纯文本净化（`purifyPresetPatch`：摘除 stock `compaction-basic` + `tool-result-pruner` 行与该组 `isolate` 块，**保留** `command-compact` ⇒ 组变普通组、`inject` 回落到宿主 ARGP 的 scope 链）→ 转成**顶层 modify 行**（`toModifyRow`）烘焙进本包 `cordis.patch.yml`。dsh-argp 是 bundle 顺序**最后一位** ⇒ modify 覆盖 web-app 的 insert（last-write-wins）。保留 planning / delegation 的 isolate 与 cordis 的 `tool-cordis` / ptc 的 `tool-presentation`；幂等（重复运行字节一致，已净化的 preset 是 no-op）。同时删除 0.1.6 的 `cleanShippedPresets` 系列导出与 `argp-graph-engine` 的构造期净化挂载点，`index.ts` 导出与 `ARCHITECTURE.md` 模块表同步。
- **语料读取器 v3+v4**（见上）。

### Tests

- 全量 **370 例**（`npm run check`：typecheck + typecheck:spike + smoke + test + build）。逐版本增量：beta.0 → 351 绿（+17）、beta.1 → 354（14 例 preset-cleaner 重写）、beta.2 → 359（`peratom-flush-reload` 5 例）、beta.3 → 364（`client` 第 ④ 层 +5）、beta.4/beta.5 复跑、**1.7.0 → 370**。
- **变异实测**（在独立 worktree 注入候选改动后摘除修复，主树零风险）：P0-A（per-atom prune）⇒ 1 red；P0-B（prune-tx `sourceCommandId`）⇒ 1 red；P0-B₂（只摘 checkpoint 第 2 参）⇒ 同 1 red；**④（`ended` 守卫，两处同摘）⇒ 恰 2 red**（`compaction-tx-brackets` ① + `peratom-flush-reload` ①c），而反向对照 ② 仍绿 ⇒ 判别力精准、非平凡通过。
- **端到端契约验证**（独立集成测试工程，不入本仓库）：用宿主真实加载期校验栈（SessionStore + InvariantRegistry + CompactionInvariant）跑 `compactNow`——修复路径三事件 + checkpoint 一致、invariant 实时通过；对照旧形态被 invariant 拦截。

### 已知问题与限制

- **① `preset-cleaner` 的 modify 行是整块 config 重述**（0.1.7 机制固有，beta.1 起）：不自动合并未来 builtin 变更——若 web-app 未来改某 preset 的**非 compaction** 字段，本 override 会遮蔽该变更直到重新生成（`node scripts/generate-preset-overrides.ts <presets-dir>`）。
- **② 连续多轮中断时只并入"紧邻上一轮"**（beta.0 起）：更早的中断轮可能漏压（罕见，后续可扩为"全部未处理中断轮"）。
- **③ `cordis.yml` 不能用于验证 preset override**：该文件内容恒为 `[]`——组合树由 `package.json` 的 `dsh.profile.bundles` + `cordis.patch.yml` 在**加载期**组装，**不落盘**。preset override 只能**行为验证**（`/compact` 产出 `[elided seq=N..M]` 墓碑、被剪内容可 recall）。
- **④ profile 的 `windowRatio` 是两层配置**：`~/.dsh/settings.yaml`（运行时赢）> `~/.dsh/profiles/*/cordis.patch.yml`。跑受控语料需**显式覆盖** `windowRatio`（覆盖值随跑批规格书维护，该规格书为内部文档、不随包发布）。

## [1.7.0-beta.5] - 2026-09-23（P0 回归修复：prune-tx 的 sourceCommandId 一致性）

> **发布状态**：**未单独发布**（仅存在于工作树），内容**并入 [1.7.0]**（见上）。承接 1.7.0-beta.4（peratom shadow-price 修复）。本版修 **Stage-2 图剪（`prune-tx.ts`）的 P0 缺陷**——`/compact` 手动压缩事务的 `compaction/start` 携带发起命令 `sourceCommandId`，但 `compaction/summary` 与 `compaction/end` 不携带，违反宿主 **sourceCommandId 一致性契约**，导致**任何跑过 `/compact` 的会话在重启加载期必炸**（`SessionFormatError: compaction/summary has no matching compaction/start`）。

**现象**：集成测试 T4（Stage-2 图剪）跑 `/compact` 后，会话 `session-bffe40b6` 在**最终重启**（首次包含该图剪事务）加载失败：`failed to project session ...: compaction/summary has no matching compaction/start`（gateway/internal）。此前 T1 的两次重启都在 `/compact` 之前，故未触发——该缺陷是**预存在**的（非 beta 系列引入），只在「跑过 `/compact` 且会话被重新加载」时显现。

**根因**：宿主对一笔压缩事务的 `compaction/start` / `compaction/summary` / `compaction/end` 三事件要求携带**同一个** `sourceCommandId`（可选，标识发起的手动命令），由两处独立校验：
- `dsh-compaction` invariant 的 `validateSourceCommandId`（`invariant.ts:85`）：`summary`/`end` 的 `sourceCommandId` 必须 `=== start` 的（`undefined !== 'cmd-...'` 即 fail）。
- `session-format-v3-to-v4` 的 `Relationships.compactionOwner`（`relationships.ts:248`）：`start` 把 `command: data['sourceCommandId']` 记入 open compaction，`summary`/`end` 要求 `this.compaction.command === data['sourceCommandId']`，不等则 throw（错误信息误导为 "no matching compaction/start"，实为 sourceCommandId 不匹配）。

`prune-tx.ts` 的 `pruneIntervals` 只在 `compaction/start`（`line 159`）展开 `sourceCommandId: host.compactSourceCommandId`，`compaction/summary`（`line 192`）与两处 `compaction/end`（成功 `line 281` / catch 错误 `line 324`）只展开 `lifecycle`（无 sourceCommandId）。`/compact` 路径 `compactSourceCommandId` 非空 ⇒ start 带、summary/end 不带 ⇒ 加载期 fold 违约。peratom 路径 `compactSourceCommandId` 恒为 `undefined`（自动压缩），三事件一致为 `undefined`，故 peratom 事务不受影响——这也解释了为何缺陷只在 `/compact` 触发。

**修法**：把可选 `sourceCommandId` 提成一个 `sourceCommandIdField`（`compactSourceCommandId === undefined ? {} : { sourceCommandId }`），在 `start` / `summary` / 成功 `end` / catch 错误 `end` 四处**统一展开**——三事件（含失败路径）恒携带同一个值（自动压缩时一致为 `undefined`，同样满足契约）。此外，**压缩 checkpoint**（`user/message` + `compactCheckpointSource`）是宿主 invariant 校验的**第五个**事件——`validateCheckpoint` 要求其 `source.sourceCommandId` 与 start 同值，而旧实现 `compactCheckpointSource(compactionId)` 只传 compactionId（`sourceCommandId` 缺省 `undefined`）⇒ 手动 `/compact` 时同样违约。修法：`compactCheckpointSource(compactionId, host.compactSourceCommandId)`。`CommandId` 类型本就 import，`host.compactSourceCommandId` 本就是 `CommandId | undefined`，类型闭合。peratom 路径 `compactSourceCommandId` 恒为 `undefined`，其 checkpoint 本就一致，不受影响。

### Changed

- `src/prune-tx.ts`：`pruneIntervals` 新增 `sourceCommandIdField`，`compaction/start` / `compaction/summary` / `compaction/end`（成功 + catch 错误两路径）四处统一展开；压缩 checkpoint 改 `compactCheckpointSource(compactionId, host.compactSourceCommandId)`——保证一笔事务的**全部五个**受校验事件（start / summary / end / checkpoint）`sourceCommandId` 同值。

### Tests

- `test/manual-compact.test.ts` 新增回归例「sourceCommandId 一致性——start/summary/end 三事件同值」：`/compact` 带命令 ID 后，数据层直接断言 start/summary/end **及压缩 checkpoint** 的 `sourceCommandId` 逐字相等（确定性、不依赖 invariant 是否安装）。旧代码下 summary/end/checkpoint 为 `undefined` ≠ start 的命令 ID，此例必失败——正是本次 P0 的回归锁。
- 端到端契约验证（独立集成测试工程中的 `verify-scid` 脚本，不入本仓库）：用宿主真实加载期校验栈（SessionStore + InvariantRegistry + CompactionInvariant）跑已构建 beta.5 的 `compactNow`——① 修复路径三事件 + checkpoint 一致、invariant 实时校验通过；② 对照旧形态（start 带 scid / summary 不带）被 invariant 拦截（`compaction/summary sourceCommandId undefined does not match compaction/start`）——证明测试能区分新旧形态。
- 集成测试 T4 后续的最终重启（首次含 `/compact` 图剪事务）：修复前 `SessionFormatError`，修复后会话正常加载。
- `npm run check` 全绿：typecheck + typecheck:spike + smoke + test（365 例）+ build。

## [1.7.0-beta.4] - 2026-09-23（P0 回归修复：peratom flush 的 shadow-price 契约）

> **发布状态**：**未单独发布**（仅存在于工作树），内容**并入 [1.7.0]**（见上）。承接 1.7.0-beta.3（客户端 locale 注册泄漏修复）。本版修 **beta.2 的 Issue #2 修复引入的 P0 回归**——peratom flush 的 `compaction/summary` + 多 replace 组合违反宿主 0.1.7 新增的 **shadow-price 协议**，导致**会话重启加载必炸**（`token surface: replace at seq N over range X-X has no adjacent shadow price (armed claim covers S-E)`）。

**现象**：peratom 压缩一次后，会话重启（`session/created` 重放）即报 `failed to project session ...: token surface: replace at seq 56 over range 28-28 has no adjacent shadow price (armed claim covers 8-48)`，会话打不开。集成测试 T1（压缩一次后连重启两遍）首次复现。

**根因**：宿主 0.1.7 在 `token-meter/surface-projection.ts` 引入 **shadow-price 协议**——surface `replace` 前**紧邻**的计量事件（`compaction/summary` 或 `compaction/prune`）必须声明**被替换范围**的启发式 token 价，`foldSurfaceProjection` 要求 `claim.start === op.startSeq && claim.end === op.endSeq`（范围**严格相等**），否则 throw。beta.2 的 `flushEntry` 发**一条整窗** `compaction/summary`（`shadowedRange = {start: collect.startSeq, end: collect.endSeq}`，如 8-48）+ **多条单原子** replace（`{op:'replace', startSeq: step.at, endSeq: step.at}`，如 28-28）——首条 replace 撞上整窗 claim（8-48 ≠ 28-28）即 throw。该 fold 在 **append 与 replay 两侧都跑**（`usage-projection.ts` 的 `contextPressureProjectionDefinition.apply`），故**活轮与重启加载双双炸**。

**修法**：对齐 `prune-tx.ts` 的既有纪律——每条 replace 前各发一条 `compaction/prune`，`shadowedRange = {start: step.at, end: step.at}`（该单原子，与紧随的 replace 范围**严格相等**），`shadowedSeqs = [step.at]`（单节点连续切片，同时满足加载期 `validateShadowedSeqs`），`shadowedTokenCount = ceil(原原子字符数 / 4)`（宿主 `CHARS_PER_TOKEN = 4` 口径）。开头整窗 `compaction/summary` 的 claim 被首条 prune 覆盖、末尾被 off-surface `compaction/end` 清掉，无契约冲突。`compaction/prune` 是**独立**事件（`invariant.ts` 只对它跑 `validateShadowedSeqs`，不要求事务上下文），故 per-atom 发射合法。

### Changed

- `src/peratom/flush.ts`：`flushEntry` 的 replace 循环每条 replace 前各发一条 per-atom `compaction/prune`（range = 该单原子）；新增 `textLenBySeq`（原原子 seq → 字符数）供 `shadowedTokenCount` 估算。整窗 `compaction/summary` 保留（UI 展示 + 审计），其 claim 被首条 prune 覆盖。

### Tests

- 集成测试 T1（压缩一次后连重启两遍）：修复前**必炸**（`no adjacent shadow price`），修复后会话正常加载、二次重启复用已持久化事件亦正常。
- `npm run check` 全绿：typecheck + typecheck:spike + smoke + test + build。

## [1.7.0-beta.3] - 2026-09-23（客户端 locale 注册泄漏：插件 enable/disable 与设置页同步失败）

> **发布状态**：`npm publish --tag beta`；**`latest` 保持 1.6.0**。承接 1.7.0-beta.2（Issue #2 加载期契约修复）。本版修**客户端 half 的注册泄漏**——它让 dsh-argp 在「宿主 retract 后重新激活」这条路径上**必然**失败，也就是设置页里的插件 enable/disable、客户端版本变更（每次装新版都会触发）、HMR 重载。

**现象**：设置页报 `dsh-argp: Error: locale namespace "dsh-argp" already has locale "zh"`，并提示「本页面的插件未能完成同步；服务端的启用状态保持不变」⇒ 激活事务被整段回滚，插件状态无法同步。

**根因**：`src/client/index.ts` 的 `apply()` 里两处注册都没把 disposer 交给 fiber：

- `locale.register('dsh-argp', { zh, en })`：宿主 `dsh-client-locale`（`lib/client.js:1393`）对**同 namespace + 同 locale 的二次注册直接抛错**，而 `register()` 返回的 disposer 正是唯一让二次 apply 合法的东西。
- `assistantDisplay.register(filter)`：泄漏则不抛错，但每次 apply 静默叠加一个渲染过滤器。

宿主「重新激活」的语义 = **dispose 旧 fiber + 重新 apply client half**（`dsh-cordis-client-runner` `lib/client.js:637` `fiber?.dispose()`）。我们泄漏的字典在 fiber teardown 时无人摘除 ⇒ 第二次 apply 抛错 ⇒ 页面回滚激活。宿主自带的客户端插件全部写成 `ctx.effect(() => ctx.locale.register(NS, {...}))`，正是为此免疫。

**修法**：新增 `registerDisposable(ctx, execute, label)`（= `ctx.effect(execute, label)`；无 `effect` 的退化 ctx 直接执行）；两处注册改走它，标签 `dsh-argp: cites display filter` / `dsh-argp: settings card dictionaries`。

### Tests

`test/client.test.ts` 新增第 ④ 层（5 例，合计 18 例）：effect 标签契约；**宿主 retract 后二次 apply 不抛**（复现被报告的失败点）；**负控**（未 dispose 就二次 apply 必须抛——证明 locale stub 忠实复刻宿主语义、修复确实依赖回收而非 stub 宽容）；assistantDisplay 过滤器不叠加；无 `effect` 的退化路径仍完成注册。locale stub 复刻宿主「重复注册即抛」语义。

### 发布后核验

- `npm run check` 全绿：typecheck + typecheck:spike + smoke + test（364 例）+ build。
- `test/client.test.ts` 18 例全过（原 13 + 新 5）。
- 产物一致性：本地 `npm pack` 的 `sha512-`（base64）应与 publish 输出的 `integrity` 逐字符相同。

## [1.7.0-beta.2] - 2026-09-23（Issue #2 修复：peratom / prune-tx 的 compaction/summary 加载期契约）

> **发布状态**：`npm publish --tag beta`；**`latest` 保持 1.6.0**。承接 1.7.0-beta.1（preset-cleaner override-only 自净化），本版修复 **Issue #2**——peratom flush 与 prune-tx 的 `compaction/summary` 在**会话重启加载期**违约（`shadowedSeqs` 非"发出时刻当前 surface 连续切片"）导致**会话打不开**。是 1.7.0 正式版前最后一个正确性修复。

**问题（Issue #2 根因）**：旧 `flushEntry`（peratom）与 `prune-tx` 的 `compaction/summary` **发射顺序错误**——先发 replace 循环（原原子离开 surface）、**后**发 summary，且 `shadowedSeqs` 只平铺真正被替换的**离散**原子（`plan.steps` 的 user-then-tool 序，非 surface 连续切片）。宿主加载期校验（`dsh-compaction` invariant 的 `validateShadowedSeqs` / v3-to-v4 `Relationships.span()`）要求 summary 的 `shadowedSeqs` 在**发出时刻**逐字等于 `[shadowedRange.start, shadowedRange.end]` 对应的**当前 surface 连续切片**（顺序敏感）。写入侧 `Session.append` **不校验** `compaction/*` ⇒ 落盘静默成功；**重启加载**（`session/created` 重放）才炸 ⇒ 会话打不开（Issue #2 报告的现象）。

**修法**：把 `compaction/summary` 移到 replace 循环**之前**（发出时刻整轮窗口仍完整），`shadowedSeqs` 取整轮收集窗口的**连续 surface 切片**（`surface.slice(startIdx, endIdx+1)`，surface 顺序）——离散性被"整窗"吸收。加**防御自检**：窗口非有效当前 surface span / 覆盖受保护 system head ⇒ throw，catch 落带 `error` 的 `compaction/end`，**不发坏 summary**。peratom 与 prune-tx 同失败类，一并修复。

### Changed

- **`src/peratom/flush.ts`**：`flushEntry` 重排——`compaction/summary` 先于 replace 循环；`shadowedSeqs` = 整轮窗口连续 surface 切片；防御自检（非有效 span / 覆盖 system head ⇒ throw + errored `compaction/end`）。
- **`src/prune-tx.ts`**：同失败类修复——`compaction/summary` 先于 prune/replace 循环；`shadowedSeqs` = 整窗连续 surface 切片；防御自检（`surfaceNodes` 局部变量避免与既有 `nodes` 冲突）。

### Tests

- 新增 `test/peratom-flush-reload.test.ts`（**5 例**，Issue #2 要求的两层，不可互替）：
  - **① 单测**：stub host + 真 Session，**直接调 `flushEntry`**，断言发射顺序 `compaction/start → compaction/summary → replace → compaction/end`，且 `summary.shadowedSeqs` = 发出时刻整轮窗口连续切片、`shadowedRange.start/end` = `seqs[0]/seqs.at(-1)`。
  - **①b 单测（负）**：`collect.startSeq` 指向非 surface 事件（turn/start）⇒ `flushEntry` throw（非有效 span），不发 summary，`compaction/end` 带 `error`。
  - **② 回归（e2e）**：真 `PeratomCompressor.compressCurrentTurn` 端到端 flush → 全事件流经**加载期契约重放**（`validateShadowedSeqs` 逐字复刻）+ 宿主 `foldSurface`，必须通过（= 重启加载不炸）。
  - **②-负控**：手工构造旧 bug 形态（replace 先于 summary + 离散 user-then-tool seqs）⇒ 加载期契约**必拒**（证明校验器非平凡通过）。
  - **②c 回归（e2e 多步）**：user split + 两互异 tool 同事务 → 重放 + `foldSurface` 通过。
- 全量 **359 全绿**（typecheck + typecheck:spike + test + build 全过）。

### 发布后核验（用户侧）

- 重启宿主后，之前因 peratom flush 损坏而**打不开**的会话应能正常加载（`session/created` 重放不 throw）。
- profile 的 Stage-1 peratom（`cordis.patch.yml` 的 `peratom` 块）实战：压缩后**重启会话不炸**。

## [1.7.0-beta.1] - 2026-09-23（0.1.7 preset-cleaner：override-only 自净化）

> **发布状态**：`npm publish --tag beta`；**`latest` 保持 1.6.0**。承接 1.7.0-beta.0（宿主 0.1.7 三处结构性变更全吸收 + U-info 附件保留），本版补上 0.1.7 下 **preset 对 ARGP 的遮蔽**这一遗漏——是 1.7.0 正式版的最后一块。

**问题**：0.1.7 把 agent 平面移入 **agent preset**（`@deepseek-ai/dsh-agent-preset` 声明式 patch 行，由 `AgentPresetRegistry.register()` 装配）。默认 preset（standard / cordis / ptc）的 `compaction` 组是 `isolate:{compaction,toolResultPruner}` + stock `compaction-basic`。agent scope 把 `compaction` 解析到 **preset 自带的隔离 stock provider**，而非宿主的 `ArgpGraphEngine` ⇒ 默认 preset 下 ARGP 的 Stage-2 图剪被 stock compaction-basic **遮蔽**（`command-compact` 的 `inject:['commands','compaction']` 命中隔离的 stock，而非宿主 ARGP）。0.1.6 的 preset-cleaner（复制到用户根 + 运行时手术）在 0.1.7 **结构性失效**——`AgentPresetRegistry` 无 copy/read/mutate API，`register()` 对重复 id 直接 throw。

**修法（C 方案，override-only）**：0.1.7 唯一的 preset 覆盖机制是 **patch 组合的 modify 行**（last-write-wins 整块替换 `config`）。新增 build 脚本 `scripts/generate-preset-overrides.ts`：
- 读 shipped preset patch（`web-app/presets/{standard,cordis,ptc}.patch.yml`），
- 纯文本净化（`purifyPresetPatch`）：摘除 stock `compaction-basic` + `tool-result-pruner` 行 + 该组 `isolate` 块，**保留** `command-compact`（组变普通组 ⇒ `inject` 回落到宿主 ARGP 的 scope 链）；
- 转成**顶层 modify 行**（`toModifyRow`：去 `- insert:` 包裹 + 反缩进），烘焙进本包 `cordis.patch.yml` 两条幂等标记之间；
- dsh-argp 是 bundle 顺序**最后一位** ⇒ 其 modify 覆盖 web-app 的 insert（last-write-wins）；
- **保留** planning / delegation 的 isolate（其它服务的正确生命周期隔离）+ cordis 的 `tool-cordis` + ptc 的 `tool-presentation`；
- 幂等：重复运行字节一致；已净化的 preset 是 no-op。

**已知限制（0.1.7 机制固有）**：modify 行是**整块 config 重述**，不自动合并未来 builtin 变更——若 web-app 未来改某 preset 的**非 compaction** 字段，本 override 会遮蔽该变更直到重新生成（`node scripts/generate-preset-overrides.ts <presets-dir>`）。

### Changed

- **`preset-cleaner.ts` 重写为 override-only**：删除 0.1.6 的 `cleanShippedPresets` / `PresetRosterLike` / `PresetRow` / `PresetCleanOptions` / `PresetCleanReport`（依赖运行时 registry 的 copy 路径，0.1.7 无此 API）；保留三个纯文本手术助手（`stripPresetRows` / `dropEmptyGroups` / `stripIsolateBlock`）+ `DEFAULT_STRIP_ROWS`；新增 `purifyPresetPatch` / `toModifyRow` / `PurifyOptions` / `PurifyResult` / `DEFAULT_ISOLATE_GROUP`。
- **`argp-graph-engine.ts` 摘除 0.1.6 挂载块**：删除 `presetClean` 配置项 + 构造期 `ctx.inject(['agentPresets'], ...)` 的 `cleanShippedPresets` 调用（0.1.7 无 registry 变更 API，运行时净化不可行）；hub 不再依赖 preset-cleaner。
- **`index.ts` 导出更新**：`purifyPresetPatch` / `toModifyRow` / `DEFAULT_STRIP_ROWS` / `DEFAULT_ISOLATE_GROUP` / 三个手术助手 + `PurifyOptions` / `PurifyResult` 类型（替换旧的 `cleanShippedPresets` 导出）。
- **`cordis.patch.yml` 烘焙 3 条 override**：`preset-standard` / `preset-cordis` / `preset-ptc` 各一条顶层 modify 行（compaction 组只留 `command-compact`）。`minimal` 无 compaction 组，跳过。
- **文档**：`ARCHITECTURE.md` 模块表更新（preset-cleaner 改 override-only 描述 + hub 依赖去掉 preset-cleaner）；`session-lifecycle.ts` / `argp-types.ts` 注释去掉已删的 `presetClean` / `PresetCleanOptions` 引用。

### Tests

- `test/preset-cleaner.test.ts` 重写：**14 例**（8 手术助手 + 6 `purifyPresetPatch`/`toModifyRow`：insert→modify 转换、摘 stock+isolate 但保 command-compact 与他组 isolate、幂等、已净化 no-op、去包裹+反缩进、无包裹 no-op）。
- 全量 **354 全绿**（typecheck + typecheck:spike + test + build 全过）。

### 发布后核验（用户侧）

- 重启宿主后，`/compact`（或上下文压力触发）应走宿主 ARGP 而非 stock：产出 `[elided seq=N..M]` 墓碑、被剪内容可 recall。
  - ⚠️ **核验方式更正（2026-09-23 实测）**：原文让 grep `profile` 的 `cordis.yml`，但该文件内容就是 `[]`——组合树在**加载期**由 `package.json` 的 `dsh.profile.bundles` + `cordis.patch.yml` 组装，**不落盘**，grep 必然为空。preset override 只能**行为验证**。
- ⚠️ profile 层 `cordis.patch.yml` 的 `windowRatio`（现 0.8）与 `~/.dsh/settings.yaml` 的 `dsh-argp.windowRatio` 是**另一层**（运行时赢），与本 preset override 正交，勿混。

## [1.7.0-beta.0] - 2026-09-23（宿主 0.1.7 结构性变更全吸收 + U-info 附件保留）

> **发布状态**：以 **`1.7.0-beta.0`**（宿主 0.1.7 三处结构性变更 + U-info 附件）→ **`1.7.0-beta.1`**（preset-cleaner override-only 自净化）先行发布（`npm publish --tag beta`）；**`latest` 保持 1.6.0**（不 promote 1.6.1-beta.0，按用户拍板）。待用户实战 session 核查效果后再决定 1.7.0 正式版。

**问题**：宿主 `0.1.6-alpha.1 → 0.1.7-alpha.2` 引入三处**结构性**变更，dsh-argp 若不吸收，在 0.1.7 宿主上会**类型编译失败 + 运行时准入被拒**：
1. **V3→V4**：tool/result 从 `role:'user'` 内嵌 `tool-result` 包装块，变成**一等 `role:'tool'` 消息**（content 直接数组、`toolCallId`/`isError` 升顶层）；日志文件 `session.v3.jsonl.zstd` → `session.v4.jsonl.zstd`。
2. **source.kind 去 `'plugin'` 化**：0.1.7 的 `MessageSourceMap` 是 merge-extensible 联合，**没有共享 `plugin` 兜底 kind**（源码注释："each producer declares its own `kind` in its own module; there is no shared catch-all `plugin` kind"）⇒ `{kind:'plugin'}` 字面量在 0.1.7 是**类型错误**，且原生 V4 准入**拒绝裸 `'plugin'`**。
3. **compaction/prune 成为原生事件**：`known-event-types` 新增 `'compaction/prune'`，准入规则变化（span 命名精确 surface 节点 + 排除受保护头，不要求 owner 字段）。

本版一次性吸收全部三处 + 两个前瞻修复（U-info 附件保留、语料读取器 v4）。

### Added

- **U-info 副本保留附件块**（`decision.attachmentBlocksOf` + `userCopyPayload` 第三参）：peratom 压缩一条**带图片/文件附件**的 user 消息时，U-info 副本 = 压缩文本 + **原样 image/file 块**（不再静默丢弃）。
  - **为什么**：宿主附件模型里，用户上传的文件/图片在会话流是**引用块**（`{type:'image'|'file', attachment:{attachmentId,...}}`，指向持久存储，内容不在消息里）；LLM 侧 `flattenWireText` 把它们渲染成 `[image omitted]`/`[file omitted]` 占位 ⇒ peratom 的 LLM 提取 pass 对附件**零贡献**（只压伴随文本）。旧 `userCopyPayload` 产出**纯文本** `content:[{type:'text'}]` ⇒ 压缩带附件的 user 消息会把附件块**从模型实时上下文静默丢掉**（原文留 append-only 日志可 recall，但 surface 没了）。
  - **宿主合法性**：worker.cjs `planSurfaceEvent` 对 user/message 的 surface replace **只校验 range + provenance，无 content 级约束**（`assertToolResultRewrite` 只约束 tool/result、`assertSystemHeadRewrite` 只护 node 0）⇒ 带附件块的副本合法。
  - **零回归**：无附件场景 `userCopyPayload` 产出与 v1.6 逐字节一致（`attachments` 缺省 / 空数组 ⇒ 纯文本 content）。
  - **前瞻**：受控语料 18 session / 251 条 user 消息 **0 条带附件**（spike 46 扫描）⇒ 非已发生回归，是前瞻防御。
- **`OWN_SOURCE_KINDS` 正向白名单**（`peratom/types.ts`）：`['plugin','argp','compact-checkpoint']` + `isOwnSourceKind(kind)`——读侧"是否本引擎注入"的**版本无关**判据，替代散落的 `kind === 'plugin'` 字面比较。
- **`llm-source-augment.d.ts`**（module augmentation）：向宿主 `MessageSourceMap` 声明 `argp` kind（`{kind:'argp'} & ContextFormed`），使 `{kind:'argp'}` 字面量通过 0.1.7 的 `createUserMessage` 类型检查（宿主自家包 acp / session-query / compaction-basic 测试同款先例）。纯 `.d.ts`，不参与 `lib/` 发射、运行时无影响。
- **compaction/prune 0.1.7 协议核验测试**（`test/compaction-prune-017.test.ts`）：0.1.7 宿主**接受** dsh-argp 的 `compaction/prune` 发射（无 `ignorable` 也过准入）+ **shadow-price 协议**在 0.1.7 成立（resume 重放无 "no adjacent shadow price"）。

### Changed

- **依赖 bump `0.1.6-alpha.1 → 0.1.7-alpha.2`**：`peerDependencies`（dsh-agent / commands / compaction / llm / session / tools）+ `devDependencies`（含 dsh-agent-loop / compaction-basic / invariants / llm-deepseek / llm-pi-ai / session / system-prompt / token-meter / tool-bash / tools）全对齐 0.1.7-alpha.2（`cordis ^4.0.2` / `schemastery ^3.18.1` 不动）。
- **V4 tool/result 双形状（写侧）**：
  - `decision.toolCopyPayload`：`role === 'tool'`（V4）⇒ content 换单 text block，顶层 `role`/`source`/`toolCallId`/`isError` 经对象展开原样保留（满足 `assertToolResultRewrite`"只改 content"）；`role === 'user'` 内嵌 `tool-result`（V3）⇒ 只改该 block 的 inner text。
  - `prune-tx` tool 占位墓碑：同双形状（V4 换 content 为单 text block / V3 改 tool-result block inner text）。
  - `prune-tx.canCloneTool`：类型注解放宽为"content 数组存在且非空即可"（V3/V4 都成立，功能不变）。
  - **读侧零改动**：`eventTextOf`/`rawEventText` 对 tool/result 读 `data.message.content`，V4 直接数组走既有 `block.type === 'text'` 分支；callId 全走 `source.callId`（V4 保留）。
- **source.kind 去 `'plugin'` 化**：
  - **写点**：steer 通知（`argp-graph-engine`）`{kind:'plugin', plugin:'dsh-argp', form:'notice'}` → **`{kind:'argp', form:'notice'}`**（唯一裸 plugin 持久化写点）；`userCopyPayload` `{kind:'plugin'}` → **`{kind:'argp'}`**（瞬时，flush 统一覆盖成 `compact-checkpoint`）。
  - **读点**（统一 U-info 先判 + `isOwnSourceKind` 正向白名单）：`graph-build.classifyUserMessage` / `log-access.logRowType` / `collect.isMaterial` / `cite-declarer` 全改走 `isArgpUserInfo(data)`（U-info 恒 U，先判）+ `isOwnSourceKind(kind) ? 'X' : 'U'`。
  - **兼容性**：三场景（新建 V4 / 迁移 V3→V4 / 纯 V3）读侧判据全部正确——U-info 走 `data[argp].info`（版本无关）、真实用户恒 `kind:'user'`、注入（`plugin`/`argp`/`compact-checkpoint`）走白名单 ⇒ X。
  - ⚠️ **与设计方案 §2.3 的偏差**：设计方案建议**反转逻辑**（`kind === 'user' ? 'U' : 'X'`，"更面向未来"），实现改用**正向白名单**（`OWN_SOURCE_KINDS`）。取舍：反转逻辑的失败模式是"新的真实用户 kind（≠'user'）被误判 X ⇒ **丢召回**（数据丢失）"；正向白名单的失败模式是"新的注入 kind（不在白名单）被当 U ⇒ 轻微噪声"（**无数据丢失**）。**白名单失败模式更安全**，且 1.6.1 的 form 轴门控（`skipContextForms=['relay','notice']`）已在 `isMaterial` 单独处理子代理 relay/settled ⇒ 白名单只需枚举三个已知注入 kind。
- **中断轮并入下一轮**（`collect` / `flush` / `cite-declarer`）：中断轮 N 的**完整**原子（U-long + R）不在 N 自己的 pass 压（轮刚被中断，racy），而是**并入下一轮 N+1 的 pass**（settled，无 race）。
  - `collect.collectFromWindow`：保留 early return（中断轮**自己**的 pass 跳过、不压）。
  - `collect.collectCurrentTurn`：找到 last closed turn（N+1）后，若 `prevTurn = N` 被中断，事件扫描从"只收 `open === closed`"扩展为"收 `open === closed` **或** `open === prevTurn`"；prevTurn 段水位用 `waterMarkOf(session, prevTurn)`（-1 = 未处理）；成功落地后**同时推进** `closed` 与 `prevTurn` 两个水位。
  - `cite-declarer.toAtoms`：过滤从"排除一切中断轮"改为"排除中断轮，**但保留 `closed - 1`**（若它中断）"。
  - **边界**：连续多轮中断时只并入"紧邻上一轮"；更早的中断轮可能漏（罕见，注明限制，后续可扩为"全部未处理中断轮"）。
- **语料读取器 v3+v4**（`spike/lib/session-corpus.ts`）：从硬编码 `session.v3.jsonl.zstd` 改为 glob `['session.v3.jsonl.zstd','session.v4.jsonl.zstd']` 取存在者。
  - ⚠️ **隐藏坑**：不改则 0.1.7 起的所有 v4 session 被**静默漏读**，语料审计/回归系统性偏少。

### Tests

- 新增 5 个专项文件 **17 例**：`tool-result-v4`（V4 tool/result 双形状 × V3/V4）、`compaction-prune-017`（0.1.7 准入 + shadow-price resume）、`interrupted-merge`（N 中断 + N+1 闭合，水位双推进）、`session-corpus-v3v4`（混合 v3/v4 目录都载入）、`uinfo-attachment`（U-info 副本保留附件块，9 例）。
- 既有全量 **351 全绿**（原 334 + 新 17）。
- 供应链核验：0.1.7-alpha.2 沿用既有核验法（`npm pack` → 解包 → 与 node_modules 逐文件 sha256 diff + registry `time`/`maintainers`/`dist.integrity` 溯源）。

## [1.6.1-beta.0] - 2026-09-23（tool/result 压缩副本头部标记）

**问题**：逐原子压缩用压缩文本替换 tool/result，但副本在 LLM 侧与真实工具输出**不可辨**。dsh-session 硬约束使副本不能挂 `data[ARG_NS]` 元数据（`decision.toolCopyPayload`）、也不能换 source（`flush.flushEntry` ⇒ UI 同样看不出），且副本 `source.kind` 仍是 `'tool'`——宿主约束下**没有任何** model-visible 信号。extract 档尤甚：prompt 契约要求 text 是原文**逐字**片段，与完整工具输出同形。图剪路径早有标记体系（`[elided seq=N..M]` 墓碑 + `argp-contract` 告知），逐原子路径是唯一缺口。
（背景：该缺口此前未被实证检验——`cordis.patch.yml` 整个 git 历史从未写入 `peratom` 块，Stage-1 在默认安装下结构性不可达，受控语料里 6386 次替换全是 `[elided]` 墓碑。一旦 Stage-1 挂载，缺口即成实际风险。）

### Added

- **tool/result 压缩副本头部标记**（`PlanOptions.marker`；生产 `config.toolCopyMarker` 默认 `true`）：副本正文头部拼 `[已压缩-摘取 seq=N]`（extract）/ `[已压缩-摘要 seq=N]`（summary）。
  - **分档**给出措辞可信度信号：`argp-cites` 要求"逐字抄前 10-20 词"，而 summary 档措辞是改写而非原文 ⇒ 标记明示"这段不可逐字引用"；extract 档是原文子串，可逐字引用。成本与单一标记等同（同字数）。
  - **带 seq 是必需的**：seq 是日志内部序号，模型在 tool/result 里看不到它 ⇒ 不带则 `recall_detail(N)` 无参数可调，召回通路实际是断的（图剪墓碑把 seq 写进正文是同一理由）。
  - **召回指引不进副本**：每原子重复一段指引纯属浪费上下文，统一由 `argp-contract` system 段一次性声明（静态段，不破坏前缀缓存）。
- **no-op 守卫计入标记长度**：守卫原本只在模型输出 `action.text` 上判收益，看不见标记开销 ⇒ 会出现"加了标记反而与原文持平/变长"的白压。现按**落地后**真实长度判（`action.text.length + marker.length`），这类原子退回原文保面（错误方向仍是少压）。
- **导出 `toolCopyMarkerText` / `TOOL_COPY_MARKER_RE`**：后者供语料侧审计剥离标记——新增字面量会进入语料正文，须按 `^\[已压缩-(摘取|摘要) seq=\d+\]\n` 剥离后再统计，否则重复 `[restored]` / `cites` 字面量假阳性的老问题。
- **上下文形态门控 `DEFAULT_SKIP_CONTEXT_FORMS = ['relay','notice']`**：`source.form` 命中该清单的 user-role 消息**不进逐原子压缩候选**（`collect.isMaterial` 第三道判据）。
  - **为什么需要**：子代理的成果汇报在主流里落地为 `user/message`，其 source 是 dsh-agent 的 **merge 扩展 kind**（`agent-message` / `subagent-settled`）——它们**不等于 `'plugin'`**，因此逃过既有的「插件注入」判据，被当成普通长用户消息送进 Stage-1。实测（session-53e3e89f）：relay 4 条 19,347ch + settled 4 条 17,453ch 全部进候选。
  - **为什么该跳过**：这两类是**已浓缩过一次的产物**——子代理把 46K–75K 字符的工作过程提炼成 3.6–7.1K 字符报告（10–20×）。实测行重复率 **0%**（无内部冗余可丢）、承重 token 密度 0.1–1.5%（散文式报告而非结构化数据）⇒ 逐原子压缩只会造成二次损失。它们适合 Stage-2 图剪：全留或全删 + 墓碑 + `recall_pruned(seq)` 可召回，而非中间态的有损摘要。
  - **两条正交轴别混用**：`source.kind === 'plugin'` 是**来源**轴（谁生产的），`form` 是**性质**轴（这是什么）。本次只加性质轴；`kind='plugin'` 的消息（含 `tool-jobs` / `tool-goal` / `system-prompt` 等带 form 的）仍由既有判据排除。
  - **逃生阀**：`config.skipContextForms` / `GateOptions.skipContextForms` 传空数组 = 关闭门控，退回 v1.6.0 行为。

### Changed

- **`argp-contract` system 段新增一条**：说明压缩副本不是完整原文、两种标记形态、以及引用前先用 `recall_detail(N)` / `recall_pruned(N)` 取原文。
- **旧用例开逃生阀而非改断言**：`peratom-compressor.test.ts` 的"可压轮单次调用"断言副本正文逐字等于模型输出（v1.6 契约），改走 `makeHarness({ toolCopyMarker: false })`；新契约由 `test/tool-copy-marker.test.ts` 专项覆盖。独立调用 `planReplacements` 缺省 `marker:'off'` ⇒ v1.6 行为逐字节不变。

### Tests

- 新增 `test/tool-copy-marker.test.ts`（7 例）：extract/summary 分档落地、缺省与显式 off 无标记、收益门计入标记长度（fixture 自检 + off 臂对照）、标记与 HLS `[restored]` 尾注共存（头标记 + 尾尾注，剥离后 100% 硬 token 保真）、剥离正则只认行首、生产默认 on + config 可关。
- 新增 `test/context-form-gate.test.ts`（5 例）：relay/notice 被排除、`kind='plugin'` 仍按来源轴排除、无 form 的 `user`/`agent-message`/`goal` 不误伤、空数组逃生阀关闭门控（同构造 on/off 双臂对照）、生产默认 = `DEFAULT_SKIP_CONTEXT_FORMS`。
  - ⚠️ 构造教训：一轮里只有被排除的那条时 `collectFromWindow` 因窗口为空返回 **null**（而非空候选）⇒ 断言 `userLong.length === 0` 拿到 undefined，无法区分「精确排除」与「整轮没材料」。测试须加一条普通 user 作锚，断言「收到 1 条、正是锚」才能证明门控是**选择性**的。
- 全量 **334 全绿**（原 322 + 新 12）。

## [1.6.0] - 2026-09-22（剪枝终止条件补全 + id/seq 错配修复 + 配置卡片简化）

**问题**：1.5.1 的剪枝 pass 循环有两个潜伏缺陷——(a) 候选耗尽降级到闭包生命周期时，`selectClosureToMerge` 的 `alreadyPruned` 误传**原子 id 集合**（`pruned.keys()`），但其内部按 **seq** 过滤，id≠seq 永不命中 ⇒ 已剪闭包被反复选中 → 空闭包 `continue` 死转、`force_prune` 饿死（压缩率仅 ~5%，c2344 空转 161.6s）；(b) 循环缺少「一轮无进展」判停，极端空转只能靠 `maxPasses` 硬上限兜底（旧默认 16，对 7/9 实战快照 binding，把「剪到达标」压成「增量式 16 组」）。

### Fixed

- **`selectClosureToMerge` 的 `alreadyPruned` 改传 seq 集合**：原传 `pruned.keys()`（原子 id，局部 0 递增），内部 `seqs.filter(s => !alreadyPruned.has(s))` 按事件 seq（数千量级）过滤 ⇒ id 与 seq 永不碰撞 ⇒ 已剪原子永不被排除。改传 `pruned.values()` 的 seq 集合后，空闭包消失、`force_prune` 可达。c2344 剪枝率 5.2%→96.5%、161.6s→1.35s（127×）。
- **剪枝 pass 循环新增「无进展固定点」判停**：某 pass 未新增任何原子（`pruned.size` 不变）即 break（O(1)/pass）。`pruned` 单调增、每 pass 结果仅由 `pruned` 决定 ⇒ 无进展即真固定点，再跑必空转。正常终止仍靠「压缩率达标 / 全保护」，此判停只兜底任何残留空转。

### Changed

- **`DEFAULT_MAX_PASSES` 16 → 10000（退化为纯安全上限）**：修 id/seq 后空转本已消失，正常压缩在「达标 / 无可剪 / 无进展」处自然停，`maxPasses` 不再 binding（旧 16 对 7/9 实战快照 binding）。提到 10000 仅作极端空转的安全网。
- **配置卡片简化为「2 核心 + 4 高级」+ 紧凑文案**：主视图只留 `windowRatio`（剪枝触发阈值）+ `retainRatio`（压缩率）两个核心旋钮；`maxPasses` / `recencyGuard` / `turnGuard` / `sortMode` 折叠进「高级设置」；`minSpanChars` / `enableSummarize` / `charsPerToken` 降为 schema-only 逃生阀（UI 不再暴露）。6 个暴露旋钮统一「术语 · 简短说明」紧凑文案（zh/en 双写）；`sortMode` 选项改友好标签（信息密度优先 / 按出现顺序 / 密度+版本链）。

### 口径说明

- **剪枝 vs 压缩**：本插件 **剪枝(prune)=图剪枝 pass 循环**，**压缩(compaction)=整体压缩事件/retain 目标**，二者文案不混用。
- **压缩率 = retain 比例**：`retainRatio` 0.2 ⇒ 压缩率 20%（剪枝率 80%）。c2344 的「96.5%」是 **JSON-wire 口径的剪枝率**（非压缩率）；其「冲过 20% 目标」源于**闭包粒度**（闭包不可拆 + 每 pass 一个 + lifecycle 最旧优先退休），对 context-overflow 触发是必要的 by-design（引擎必须压到硬限以下）。

## [1.5.1] - 2026-09-22（doneTurns 记账修复 + retain 恒定压缩率 + drag-weight 排序）

**问题**：1.5.0 发布后回归审查发现 `CiteDeclarer` 的幂等记账时机缺陷——`done.add(turn)` 位于所有短路分支**之前**，`no-endpoint`（自动模式路由未就绪 / 启动期 env 未设，属**瞬时态**）命中即把该闭合轮永久标记"已处理"，后端就绪后同一轮重试仍被 `done.has` 跳过 ⇒ **该轮的 citation 边永久缺失**。既有 auto-arm 用例是"turn-1 no-endpoint → turn-2 重试"（两次针对不同轮，`done.has` 永不命中），抓不到此缺陷。

### Fixed

- **`done.add` 下沉到 `backend === null` 检查之后**：仅"过门控且有端点"的轮才记账；`interrupted` / `gate-skipped` / `no-endpoint` 三个短路态一律不记账，可重试。与 compressor 的 `passWatermark`「仅成功规划才推进」同语义。

### Tests

- 补 1.5.0 审查发现的 3 个测试洞（318 → **321**）：
  - **同轮 no-endpoint 后重试必须真声明**：对**同一闭合轮**连续两次 `declareCurrentTurn`，必然命中幂等门。变异验证：`done.add` 挪回短路之前 ⇒ 本例失败（`record.called` 期望 true 实得 false），还原后通过。
  - **A-2 wire dump 默认脱敏**：非 hex 标记串断言默认 dump 不含用户消息正文（含 `wireSha256` + role/length 摘要），仅 `ARGP_PERATOM_A2_DEBUG_FULL=1` 才落完整 wire。
  - **`resolveModelInfo` 挂起被 5s 超时兜底**：信号感知的"永不 resolve"替身 + 6s 守卫赛跑（超时失效 ⇒ 守卫 reject 而非无限挂起）；降级断言走静态默认、`declaredKnown=false`。

### Fixed (CI)

- **`lib/` 产物按 LF 源码重建**：esbuild 把 `sourcesContent`（源码原文）嵌进 `lib/client.js.map`；此前提交的 lib 由 CRLF 工作区构建（map 69.2kb），CI 检出受 `.gitattributes` `eol=lf` 约束重建出 66.7kb ⇒ `git diff --exit-code lib/` 必挂（本地 CRLF 工作区不复现）。15 个 `src/` 文件归一 LF 后重建提交。
- `package-lock.json` 根版本 1.3.0 → 1.5.0 对齐（不动依赖解析）。

### Changed

- **保留目标改为「可压缩内容 × retainRatio」（恒定压缩率）**：旧公式 `retain = windowTokens × retainRatio = 0.8W × 0.2 = 0.16W` 用**含固定开销（system+tools+MCP）的触发线**做基数，但剪枝目标量 `visible`（原子文本和）**不含**固定开销——两阈值口径不对称（触发线含、目标线不含）。新公式 `retain = initialVisible × retainRatio`，`initialVisible` = 剪枝前全部 U/A/R 原子文本和 = 完整请求 − 固定开销，天然排除不可剪前缀 ⇒ 压缩率恒定 `1 − retainRatio`（默认 80%），不再随触发点浮动。显式 `retainTokens` 保留旧绝对值语义（逃生阀：配置了绝对目标的用户行为不变）。
- **剪枝排序键计入 A 的应答 R 体积（drag 集合）**：剪 A 必无条件连带剪其全部 R（防孤儿 tool 400），但旧 `sortKey` 的 token 键只算 A 自身文本 ⇒ 两个同级别 A，一个带 90K 大 R、一个带 1K 小 R，"能带走大 R 的"排不到前面，贪心达标慢、大 R 死重滞留。现带 tool-call 的 A 用「自身文本 + 应答 R 之和」（`PruneState.aGroupChars` 静态快照）作 token 键，大 R 的 A 先剪。

### Fixed

- **`compareSortKeys` 数值比较修复 `localeCompare` 符号 bug + NaN 陷阱**：density 档 token 降序键含负数组件，`localeCompare` 把 `-` 当可变权重字符、主比较级忽略 ⇒ 同位数内方向反了（`-18` 排在 `-24` 前，而意图是"大 token 先剪"=`-24` 排前）。改用逐组件数值比较 `compareSortKeys`。**关键坑**：`padStart(10,'0')` 对负数把 0 塞到负号**前**（`"0000000-18"`），`Number()` 解析为 NaN ⇒ 朴素 `Number(xc[i])` 让比较恒返 NaN ⇒ `Array.sort` 视其相等 ⇒ 排序退化为"保 surface 原序"的 no-op（drag 权重完全失效）。修法：解析前先 `replace(/^0+(?=-)/,'')` 剥掉负号前的前导 0 还原 `-18`；非负组件无 `-`、`replace` 不命中、行为不变。

## [1.5.0] - 2026-09-21（轮中压力剪 + 截断自动续写；1.4.1 号作废不发布）

> 本条目自 1.5.0 开发起累积：首笔 = 被钳不再等于任务中断（轮中压力剪 + 截断自动续写）；排期 P1–P5 的修复全部并入本条目后一次性发布。

**问题（用户纠正 + 存档实证）**：1.4.0 把轮中主动压缩关掉、只留"下一个 pre-step 强制剪"，且续写要等用户开口。但上下文超限的两个主要形态恰恰都在轮内——(a) **拿到 tool result 之后才超**（L1 只在轮初判定，看不见它）；(b) **输出过程中被钳**。两者都应在图剪之后**自动继续推进当前轮次的任务**，而 1.4.0 做不到：存档全库 5/5 次钳制后面紧跟的都是 `step/end > turn/end`（`77c64e66`@2318/2326/2356、`a56061c2`@1071/1081/1091/1103；其中 `a56061c2`@1071 发生在 **turn 5 step 15**——典型"轮内长跑被 tool result 推爆"），没有一次续跑。

### Added —— 轮中压力剪（L1'）

- **`step > 1` 且压力达标即剪**，且**只做 0-LLM 图剪**（不跑 per-atom LLM pass——那是 79s–3min 的阻塞，轮内不划算；轮初/轮末另有专门通道）。剪落在那个 pre-step ⇒ **同一个 step 的请求即已瘦身** = 天然自动继续本 turn。
- **放宽 `turnGuard`（`midTurnTurnGuard`，默认 0）**——这是与 1.3.x 轮中剪的关键差别，也是后者"几乎无效"的根因：超额的来源就是**本轮**的 tool result，而 `turnGuard=1` 恰把整轮保护起来（实测只能剪到 **1 原子 / 154 tok**）。`recencyGuard` 照常保护最新节点（刚收到的 tool result 不动），模型需要更早的 tool result 时走既有 recall 通道。

### Added —— 截断自动续写（L3，本版核心）

- **新钩子 `agent/turn-stopping`**：本轮要收时若仍有待消费的钳制信号 ⇒ ① 就地强制剪（`turn/end` 尚未落账，编号 bracket 仍属本 turn）；② 剪**确有腾空**时 `agent.steer(续写消息)` ⇒ 宿主循环以 `target='next-step'` **续同一个 turn**，用户不必再发"继续"。依据：宿主 `agent.ts:483` 在 `finish.kind === 'max-tokens'` 时**先于** `executeToolCalls` 直接 return（该步 tool calls 被丢弃），`turn()` 随即因 inbox 空而收轮——`turn-stopping` 是最后一个可干预点；harness 自带契约测试逐字锁定 *"steer() from an agent/turn-stopping listener continues the same turn"*（`contract-regressions.spec.ts:323`）。
- **续写消息形状**：`createUserMessage` + `source = {kind:'plugin', plugin:'dsh-argp', form:'notice'}`。宿主与本引擎都把 `plugin` 源归为 **X**（可见、不参剪）⇒ 既进请求又不会被剪掉，UI 按 notice 渲染、不伪装成用户输入。文案默认点明"输出被宿主的输出预算截断（不是你的错）+ 上下文已压缩 + 接着写勿重述"，可用 `continuationNotice` 覆盖（空串 = 只剪不续）。
- **零腾空则不续写**：剪不动还 steer 只会立刻再被钳一次；此时把信号**重挂**（`rearmReactive`）留给下一次机会（通常是用户开口后那一轮，那时阶梯已 +1、守卫放宽）。
- **续写阶梯**：`reactiveRescues` 每 turn 重置，同一 turn 内第 2 次起放宽 `recencyGuard`/`turnGuard`，`reactiveRetries`（默认 2）用尽即放手让本轮结束——既保证"连续被钳能升级"，又封住无限续。

### Changed —— 兼容与默认值

- **`midTurnPrune`（默认 `true`）/ `midTurnTurnGuard`（默认 0）** 成为正式旋钮。1.4.0 的 `midTurnActive` 保留为别名：`true` = 轮中剪开 + 沿用默认 `turnGuard`（1.3.x 逐 pre-step 档，含 per-atom pass，对照用）；`false` = 轮中剪关（1.4.0 档）。
- `reactiveRetries` 语义收窄为"**每次连续被钳 episode** 内的续写次数"（旧文档描述的是逐 pre-step 重试）。

### Changed —— recall 契约（P2.5，D2 混合方案）

- **C1 截断做实**：`recall_detail` 新增 `from`（字符偏移，默认 0）/ `limit`（单次最多返回字符数）分页参数；被预算或 limit 截断时，截断标记回传"下一步该传什么"（`…(truncated at N/M chars; call recall_detail(seq=…, from=N) to continue)`）——被剪的长代码/长工具输出可逐页完整拿回，截断不再是不可恢复的信息丢失。
- **P1 重建诚实化**：`recall_detail` 改走新 raw-text 访问器 `log-access.rawEventText`（`eventText` 共享投影行为不变）：text 块返回日志字面量（多块时块间分隔符为投影，标注）；tool-call 参数宿主存字符串（raw JSON）→ 逐字，宿主存对象 → JSON 语义等价重建并在返回里精确标注（`[note: …]`）。
- **P2 散文 guard 诚实化**：recall 工具描述 + 契约 section + 压缩 prompt 明确"保真仅保证结构化承重 token（URL/路径/file:line/UUID/哈希/key=value，`token-ontology.ts` LOAD_BEARING_PATTERNS）逐字；散文级引用不保证逐字"；README/ARCHITECTURE 的"逐字节"宣称同步收窄。

### Fixed —— 正确性热修（P1，6 项）

- **per-atom 水位在 LLM/解析失败时仍推进**（`peratom/flush.ts` `prepareCurrentTurn`/`compressCollect`）：`callAndStash` 三条失败路径（no-endpoint / parseFailed / LLM 抛错）都返回"失败 record"不抛异常，旧代码却无条件 `advanceWaterMark` ⇒ 一次瞬时 LLM 抖动即让该轮原子被水位过滤（`event.seq <= since`）**永久排除**出 per-atom 候选，与 1.3.4 水位语义（"成功 pass 才推进水位"）直接矛盾。修复：仅当 `entry.error === undefined && !entry.parseFailed` 才推进水位（两处调用点）。
- **单 R 占位墓碑克隆失败回退成 user/message**（`prune-tx.ts` `pruneIntervals`）：单 R 区间的 tool_calls 不可克隆时，旧代码回退成 user/message 占位 ⇒ tool_calls 悬空 ⇒ **provider 400**（爆炸半径最高）。修复：事务前预校验 `canCloneTool(seq)`，不可克隆的单 R 区间从本次 pass 剔除并 warn（不再发出非法占位）。
- **`resolveModelInfo` 的 AbortSignal 无超时**（`budget.ts`）：冷启动 pre-step 创建的 `new AbortController().signal` 从未被 abort ⇒ LLM 服务挂起时 pre-step **永久卡死**（外层 try/catch 只对 rejection 生效，对 hang 无效）。修复：`setTimeout(() => ac.abort(), 5000)` + `finally clearTimeout`。
- **配置面板 `save()` 缺 try/finally**（`client/argp-config-controller.ts`）：写循环中途抛错时面板**永久卡「Saving…」**。修复：包 try/catch/finally 恢复状态。
- **`doneTurns` 只读不写**（`peratom/cite-declarer.ts`）：Set 全程无 `.add()` ⇒ 幂等短路永不触发，同一闭合轮**重复烧 LLM 调用**。修复：门控通过后 `done.add(collect.turn)`。
- **A2 debug 把完整 wire（含用户消息历史）`writeFileSync` 落盘**（`peratom/llm-adapter.ts`）：仅 env 门控、无脱敏。修复：默认（仅设 `ARGP_PERATOM_A2_DEBUG`）只写**脱敏摘要**（消息数、每条 role+长度、整段 wire 的 sha256）——不落正文；确需逐字节对齐的完整 wire 须**额外显式**设 `ARGP_PERATOM_A2_DEBUG_FULL=1`。数据责任在 SECURITY.md 明示。

### Changed —— 工程卫生与构建（P4）

- **日志统一**：双 sink 混用（`this.log` / `ctx.logger`）+ 前缀不一致 ⇒ 统一单一 sink + 前缀表；生产代码裸 `console.log`（LLM 请求序列化热路径）改 `ctx.logger.debug`。
- **常量集中**：跨 5 文件裸字面重复的核心魔法数字（16_384 / 8_192 / 3.5 / 132_000 / 0.8 / 0.2 / 180_000 / 16）⇒ 新建 `src/constants.ts` 具名常量，全引擎 `??` 引用。
- **LLM 超时统一**：compressor 180s vs declarer 120s ⇒ 统一 `DEFAULT_LLM_TIMEOUT_MS`（180_000）。
- **遥测有界化**：实例级诊断数组（`records`/`recallCalls` 等 9 个，常驻 server 插件只增不减）⇒ `src/telemetry.ts` `pushBounded` 有界环形缓冲（保留最近 N 条，`DEFAULT_TELEMETRY_CAP=256`）。
- **配置值校验**（`client/argp-config-controller.ts`）：`windowRatio`/`retainRatio`/`charsPerToken`/`maxPasses`/`recencyGuard`/`turnGuard`/`minSpanChars`/`sortMode` 加范围/整数/枚举校验；非法值在 parse 期拒绝（`CardFieldState.invalid`，save 被拒），不再静默落盘。
- **构建/工具加固**：typescript `^5.5.0`→`^5.7.0`（build 需 5.7+）；client 产物嵌 version banner + 开 sourcemap；`check-commit-msg.mjs` 改 spawnSync + ref 白名单（消除命令注入）；新增 `prerelease-check.mjs`（脏树守卫 + tag 幂等，防"半发布"死局）；`release`/`check`/`prepublishOnly` 统一为全量闸门。
- **lib/ 入库策略（D4）**：维持入库 + CI 校验（`git diff --exit-code lib/`），不 gitignore。

### Removed —— 三个 spike 时代 alt-engine（P3.4，D3）

- 删除 `argp-t1-engine.ts` / `probe-engine.ts` / `recall-engine.ts`（564 行）及其 spike 脚本（`spike/01-mount.ts` / `03-recall.ts` / `04-t1.ts`）：零引用、未从 `index.ts` 导出、已被 `argp-graph-engine.ts` 取代；此前随 `tsconfig.build.json` 的 `include: ["src/**/*.ts"]` 编译进 `lib/` 随包发布（死代码）。公共 API 面 name-for-name 不变（`index.ts` 逐字节 diff 验证）。

### Refactored —— 结构重构（P5，5 步）

> 纯结构重构，运行时行为逐字节不变（Wave 4 功能复审以归一化 diff 独立验证：全部方法体逐字相同、构造函数副作用次序与 ctx.on/systemPrompt/tools 块逐字保留；append-only / shadow-price / 三级触发 / recall paging+rawEventText / verbatim guard 五条核心不变量全部完好）。

- **抽 `argp-types.ts` 叶子**：`Atom`/`AtomType`/`SemanticEdge`/`DeterministicEdge`/`EdgeLevel`/`ArgpUserSettings`/`EDGE_WEIGHTS`/`LEVEL_ORDER` 从 3,313 行 hub 下沉到中性叶子；peratom/* 只依赖它 + `log-access`，**斩断 `argp-graph-engine ⇄ peratom/*` 类型回边**（仅 type-only import，编译期擦除，无运行时环）。`eventText` 下沉 `log-access.ts`。
- **拆 `compactIfNeeded`**：`isAtomCandidate`/`isGroupCandidate`/`sortKey` 三个闭包提为模块级纯函数，`mergeIntervals`/`buildTombstones` 抽为独立可测函数。
- **删 `tryPruneClosures` 死代码**（生产零调用、仅测试引用）+ `detectOpenTurn`/`mainChainReasoningEffort`/`turnOf` 收敛到 `log-access` 叶子（替代 13 处 `as { turn }` 强转）。
- **hub 拆 7 模块**（3,313 → 1,646 行，−51%）：`graph-build` / `budget` / `recall` / `prune-selection` / `prune-tx` / `recall-tools` / `session-lifecycle`；构造函数拆 4 函数（`normalizeConfig`/`registerSettings`/`mountPeratomStack`/`registerRecallTools`）。class 变为薄组合根：持有字段 + 1–4 行薄转发方法。
- **compressor 拆 6 模块**（1,520 → 362 行，−76%）：`compressor-types` / `decision` / `collect` / `prompt` / `flush`。
- **窄宿主接口模式**：各模块定义窄 `*Host` 接口，class 经 `this as unknown as Host` 调用，模块只 type-only import 组合根（编译期擦除）⇒ 运行时依赖图为真 DAG（0 环），公共 API 面 name-for-name 不变。

### Tests

- `test/trigger-levels.test.ts` 扩到 **14 例**：新增 L1⑤（放宽 `turnGuard` 才能剪动"独占当前轮"的 tool result——legacy 档剪不动、默认档剪得动，同会话同时点对照）、L3①–⑤（剪+steer 的载荷形状 / 无信号对照 / 剪不动不续写 / 次数上限 / 阶梯按 turn 重置）；L2 各例改到独立口径（`windowTokens` 极大 ⇒ 只有强制路径可剪，避免与 L1' 混淆）。
- 新增 **`test/auto-continue-e2e.test.ts`（3 例，真 AgentLoop + 脚本化适配器）**：E2E① 被钳后请求数 3 且 `turn/start` 仍为 **2**（= 同一 turn 续跑，未新开轮）、第 3 次请求确实带上续写提示；E2E② 正常收尾不续（对照）；E2E③ 额度用尽即收轮，不无限续。
- **变异检查**（3 处，各自只打掉对应断言、对照组全绿）：① 永不 steer ⇒ E2E①/③ + L3①/④/⑤ 失败；② 不放宽 `turnGuard` ⇒ L1⑤ 失败；③ 不重挂信号 ⇒ L2③ 失败。
- 全量 **285/285**（276 + 6 + 3），typecheck 与 build 干净。
- **P3.3** 新增 `test/cites-strip.test.ts`（**16 例**）：三个纯函数（双端共享事实源）独立契约测试，含"禁止 `includes('c')` 误升 critical"安全契约（硬回归）。
- **P3.2** 新增 `test/client.test.ts`（**13 例**）：`client/*` 整目录此前零测试——`assistantDisplay` 显示过滤器（cites 协议防 UI 泄漏 JSON 标记的唯一关口）、静默降级、`ARG_SETTINGS_KEY` 跨端契约。
- **P2.5** `test/recall-zoom.test.ts` 14 → **18 例**（+4）：新增 C1 分页续读（截断标记回传 from + 续读逐字拿回剩余）、limit 单次上限、P1 参数对象/字符串两态（重建标注 vs 逐字无标注）；原"预算截断"断言改为断言续读指引格式。
- 全量 **318/318**（285 + 16 + 13 + 4），typecheck 与 build 干净。

## [1.4.0] - 2026-09-21（三级触发：轮初主动 + 轮中只反应式）

> ⚠️ 本版的「② 轮中只反应式」已被 **1.5.0** 修订：轮中恢复压力剪（放宽 `turnGuard`），并新增"被钳后剪 + steer 续写同一 turn"。保留下文作为当时的判定依据与实测记录。

真环境实证来源：`session-77c64e66` 全 232 请求的 finish 词表（`tool-calls 232 / stop 13 / max-tokens 3`）+ 三次被钳事件的用量（**1,911 / 1 / 4,714** vs 请求 32,768）+ 宿主 `agent-loop/src/agent.ts:244/250`（先 `claim` 再 dispatch pre-step）与 `compaction/src/invariant.ts:165-177`（编号 bracket 必须落在自己的 open turn 内）。

### Changed —— 触发口径重排为三级

- **① 轮初主动（主力）**：只在**每轮首个 pre-step**（`payload.step === 1`）做压力判定，阈值沿用 `windowRatio`（0.8）。关键修正：估值**计入本步已 claiming、尚未落盘进 surface 的 user 消息**（`payload.messages`）。宿主 `agent.ts:244` 先 `inbox.claim()`、`:250` 才 dispatch pre-step，故轮初拿到的是**新 user 消息的精确内容**——不是预测，也不需要"预测 + 复核"两遍；而旧口径沿用上一请求的 usage 锚点，整块漏掉"这一轮的启动量"，用户恰恰常在轮初粘贴大段文本。
- **② 轮中只反应式（取消轮内主动阈值）**：轮内**默认不做**主动压缩。两条实测理由：(a) **近乎无效**——turnGuard 保护当前轮，209K 上下文的一次轮内图剪只剪得动 **1 原子 / 154 tok**；(b) 每次落地都是一次**轮中** surface 替换 = 断一次前缀缓存，收益却接近零。取而代之的判据 = 输出被**外部**钳制：`assistant/message` 的 `data.stream` 末项 `finish.reason.kind === 'max-tokens'` **且** `data.usage.outputTokens <` 本次请求声明的 `maxTokens`（由 `agent/request` waterfall 捕获；适配器的钳制发生在其后）。真值分辨：`outputTokens` 远小于预算 = 宿主/适配器把输出啃小了（= 容量压力）；`≈ maxTokens` = 模型自己写满预算，不构成压缩理由。
- **③ overflow 强制路径**：不变（provider 400 → P4 三步）。

### Added

- **反应式补救（执行面）**：被钳信号置位后，**下一个 pre-step** 以 `compactIfNeeded('context-overflow')` 强制剪一次——该 trigger 绕过阈值早检，"仍未回线"的真信号由上游继续钳输出给出。**升级**：第 2 次起临时放宽 `recencyGuard`/`turnGuard`（连当前轮一起进入候选），"被钳后回线"才有可能。**上限**：`reactiveRetries`（默认 **2**）用尽即停手并交回 overflow 路径——避免"每步都被钳 → 每步白压"的死循环（那比现状更糟：每圈多吃一次输出）。
- **`midTurnActive`（默认 `false`）**：逃生阀。置 `true` 恢复 1.3.x 的逐 pre-step 主动压缩（对照实验用）。

### 设计取舍（为什么不做"轮末决定 + 下轮落地"的两段式）

图剪 `consolidateTombstones` 是**纯同步、0-LLM**（体内无 await / 无网络）⇒ 判定与落地可以在**同一时刻**完成，拆两段零收益。真正贵的那一件（peratom 的 LLM pass，79s–3min）本来就在轮末起跑、并在 pre-step 有界等待（1.3.5 的 `flushWaitMs`），与图剪无关，保持不动。落点选**轮初**而非轮末：轮末看不到下一条 user 消息（低估），轮初能拿到精确值；且轮初天然复用现成调用点与**编号** bracket（轮末需另开 standalone 路径）。附带修正一条此前的记录：`invariant.ts:165-177` 只要求**编号** bracket 落在自己的 open turn 内，`turn === null` 的 standalone bracket 在轮间是**合法**的——"轮末根本不能图剪"的说法不成立，轮末只是不划算。

### Tests

- 新增 `test/trigger-levels.test.ts`（**8 例**）：轮初含 messages 越线即剪 / 同会话 messages 为空不剪 / 轮内默认不剪 / `midTurnActive:true` 轮内仍剪（对照）/ 被钳强制剪（压力未达标也剪）/ `outputTokens === maxTokens` 不触发 / 放宽守卫升级（只剩当前轮可剪时第 2 次剪动）/ 次数用尽不再重试。**变异检查**：去掉 `step === 1` 门、把 `< budget` 放宽成 `<= budget` ⇒ 对应断言如期失败（L2④ 被探针 1 连带），确认断言非空转。全量 **276/276**（268 + 8）。
- `test/peratom-pre-pressure.test.ts` 显式改为 `midTurnActive: true`（其锁定对象由"主路径"变为"逃生阀 / 对照"，文件头注释同步更新）。

## [1.3.5] - 2026-09-21（peratom 轮末 pass「落地等待」+ 手动 /compact 多段剪）

真环境实证来源：`session-77c64e66`（9 次 peratom 事务逐条核对落点；判据 = "压缩事件是否落在上一轮 `turn/end` 与新轮 `user/message` 之间"）。

### Fixed

- **轮末 pass 在飞时，下一个 user message 会绕过压缩（替换副本落到新轮中途）**。两段式设计的发射窗口是下一轮首个 `agent/pre-step`，旧实现却显式"绝不 await 网络"（只 flush 已就绪条目）⇒ 若轮末 LLM 调用仍在飞而用户已发下一条消息，新轮首个 pre-step **无条目可发射**，事务被顺延到新轮任意后续 pre-step。实测（#9，跨进程 resume 场景）：**晚 6 步**落盘（13:38:41 新轮开 → **13:44:41** 才发），新轮 step 1–6 全跑在未压缩上下文上（step 1 `in=191,116`），且替换点落在轮中途 ⇒ 断一次前缀缓存。修复：pre-step **先有界等待在飞轮末 pass**，再发射——等到 ⇒ 本轮首个请求即带压缩结果；超时 ⇒ WARN 后照旧放行（事务顺延，即旧行为）。新旋钮 **`flushWaitMs`（默认 180_000 ms = 与 `timeoutMs` 同量级；`0` = 关闭等待）**。登记方式 = 屏障 promise（`prior.then(() => pass)`）：新 pass 串联在既有屏障之后，**不改变 pass 自身的并发性**，只让一次等待覆盖该 session 的全部在飞 pass。9 次事务回看：7 次本就在窗口内及时落盘（新逻辑等价）、1 次为轮内压力路径（`compressOpenTurn`，本就在轮内压，不受影响）、1 次即 #9（本次目标场景）。
- **手动 `/compact` 压不动（只剪最老一小段）**。`selectManualRange` 扫描 surface 时，遇到第一个不合格节点（U/X、或落在 turnGuard / recencyGuard 保护窗内）就 `break`，而真实会话的 surface 是「U A R A R U A R …」被用户消息切碎的多段结构 ⇒ `/compact` **永远只剪最老一段**（表现为"图剪压不动"：手动触发后上下文几乎不降）。修复：改为收集**全部**极大连续 A/R 段（`selectManualRanges`），逐段复核边界（配对平衡 / 段内不含 U/X / 段内有可剪原子）后合并为**一笔** `pruneIntervals` 事务剪除；不合格区间**静默剔除**而非整体失败（旧实现下首个区间边界不平衡会直接 `throw`）。保护语义不变：turnGuard / recencyGuard 窗内原子仍不参剪，U/X 骨架仍不剪。
- 单测 **1 项**新增（`test/manual-compact.test.ts`）：被 U 切碎的多段 A/R 全部剪除。**变异检查**（把段闭合改回旧的"遇阻即停"）⇒ 该例如期失败（`both A/R segments must be pruned, got 2` = 旧行为只剪最老一段），确认用例非空转。
- 文档：`Config.turnGuard` 注释里的默认值由错误的 `2` 修正为 `1`（与 schema `default(1)`、构造回退 `?? 1` 一致）。
- 单测 **4 项**新增（`test/peratom-flush-wait.test.ts`）：在飞必须等待（旧实现此处立即放行）/ 超时上界生效后放行 / 已就绪时立即发射（不引入额外等待）/ `flushWaitMs:0` 逃生阀。并做**变异检查**（临时注释掉等待 ⇒ 前两例如期失败），确认用例非空转。全量回归 **268/268**（263 + 4 + 1）。

## [1.3.4] - 2026-09-21（resume 锚点回填 + peratom 压缩水位）

真环境实测来源：`session-77c64e66`（standard-argp，11 轮 / 232 步 / 334 工具调用）逐事件复盘 + 存档重放（`.sess-tools/replay-real.mjs` / `replay-sweep.mjs`）。

> **口径勘误（同日，重要）**：复盘初期据 `profiles/web/cordis.patch.yml` 的 `windowRatio: 0.3815`（09-17 层）推定"压力检查迟触发 2.1×、图剪全程只跑 1 次 = 缺陷"，属**读错配置层**。该会话实际生效的是更外层的 `~/.dsh/settings.yaml` → `dsh-argp.windowRatio: 0.8`（写入时刻 03:14:56，turn 1 内），触发线 = 262144 × 0.8 = **209,715**。
> 按 0.8 复算：该会话 232 个请求中**仅 1 个**越过触发线（turn 6 step 84，真实 210,719 = 线的 100.5%）；锚定估算在 **pre-step 85 = 213,070 ≥ 209,715** 触发（step 84 的估算 209,639 差 **76 tok** 未越）⇒ **引擎在越线后一步即压缩，行为与设计完全一致**。"图剪只跑 1 次"是"只有一次越线"的必然结果，非缺陷。
> 同理，"锚点丢失"这一诊断不成立：若锚点真的缺失，chars 口径在该会话的上限只有 ≈118K，**永不可能越过 209,715**，与实测的触发事件自相矛盾。故下文 ① 的定位由"修复生产缺陷"下调为"补齐 resume 首请求前的口径精度"。
> ✅ **配置层对齐（同日）**：`windowRatio` 原存两处不一致值——`~/.dsh/settings.yaml`（0.8，运行时生效）与 `~/.dsh/profiles/web/cordis.patch.yml`（0.3815，2026-09-15 语料跑批用）。现已把 profile 层同样改为 **0.8**，两层一致 ⇒ 既消除"settings 键被重置即静默滑回 100K 触发线"的陷阱，也使 0.8/0.2（触发线 ≈209,715 / 保留 ≈41,943）成为唯一口径。代码内置默认值本就是 0.8（schema `:76`、回退 `:138`、构造器 `:643`），无需改动。跑语料若需 100K 触发线，请在跑批 profile 显式覆盖（受控语料跑批规格书 §3.4 已加现状注记；该规格书为内部文档，不随包发布）。

### Fixed

- **resume 首请求前压力估算退化为字符启发式**（防御性修复；非本次实测缺陷）。`lastRealPromptTokens` / `lastRealAnchorSeq` 原先**只**由 `ctx.on('session/event')` 的 `assistant/message` 处理器写入 ⇒ 宿主进程重启后 resume 既有会话时锚点为空，`measureTokens` 在首个真实 usage 到达前回退 `visibleChars / charsPerToken`，而该投影口径**不含 reasoning** ⇒ 实测低估到真值的 **0.56–0.61 倍**（turn 6 逐 step 重放：0.633 → 0.556，差值 ≈ system+tools + 整轮 reasoning tokens，随轮单调增长）。后果有限但真实：resume 后的**第一个** pre-step 压力检查可能漏触发。修复：`bindSession` 检测会话身份变化时从 `snapshotEvents()` 反向扫**最后一条带 `usage.inputTokens` 的 `assistant/message`** 回填锚点（口径 = `in + cacheRead + cacheWrite`，与 usage 处理器同式）；日志无 usage（全新会话）则重置 `0 / -1`，保持既有回退行为。新增两个对照用例（回填驱动触发 / 日志无 usage 时不误触发）。**重放验证**（0.8 档）：回填态估算/真实 = **0.981–0.998**（`source=anchored`），清零态 = 0.556（`source=chars`）。
- **peratom 每轮一次性配额被轮内压力 pass 吃掉**（语义缺陷；0.8 档下影响受限于"越线次数少"）。`doneTurns` 原为"轮级一次性"记账，且 `done.add` 在候选门控**之前**：① 轮内压力 pass（turn 6 step 85）用掉该轮唯一配额 ⇒ 该轮此后新增内容**永不入压**（其尾巴 step 85-92 与后续 `idle` pass 全被跳过；本会话该尾巴合计仅 1,772 字符 ⇒ 实际代价小，但机制上不成立）；② 一次 `no-candidate` 短路即**永久作废该轮**，即使之后来了大原子。修复：改为**压缩水位**——成功 pass 推进 `(session, turn) → endSeq`，后续 pass 只收 `seq > 水位` 的原子 ⇒ 轮末 `idle` pass 可补压轮内新增；门控短路 / 中断轮**不推进**水位（该轮仍可被后续 pass 处理）；无新增原子时窗口为空 ⇒ 零 LLM 调用短路（幂等）。配套新增统一判据 `isMaterial`（对话载体 U/A/R ∧ `surfaceOp` 非 `replace` ∧ `user/message` 非 `plugin-source`），**同时**用于候选筛选与窗口边界：压缩产物（替换副本）与插件注入（A 形态前缀指令 / U-info 聚合副本 / checkpoint）均不算材料，既防副本被二次摘要，也避免"纯产物窗口"反复记 `no-candidate`。新增 3 个用例（轮内 pass → 轮末补压新增原子 / `no-candidate` 不烧配额 / 无新增时幂等零调用）。

全量回归 **263/263**。

## [1.3.3] - 2026-09-21（citesObligation autoLlm 时序修复）

### Fixed

- **auto 兜底（autoLlm）下回复级 cites 协议未被屏蔽**：`citesObligation` 的 auto 口径在**构造期**读 `declarer.armed` 定死，而 auto 兜底的 declarer 构造期未武装（路由要等真会话 `agent/status` → `rememberRoute` 才解析）⇒ `citesObligation` 恒 `true` ⇒ `argp-cites` system section 恒注册全文 ⇒ 模型持续输出 `{"cites":...}` 尾（dsh 宿主无 assistantDisplay 服务，UI 显示过滤器不生效，泄漏到用户可见回复）。修复：auto 口径（config 未显式给 `citesObligation`）下 section **恒注册**，`text` 回调在 `declarer.armed` 翻转后**动态返回 `''`**——`renderPrompt` 过滤空 section ⇒ system 块不再含协议，渲染结果与旧"不注册"逐字一致。`armed` 单调递增（`autoLlm` 只赋值不清除）⇒ 至多翻转一次，代价 = 一次 system 块 KV 失效（通常发生在首个请求之前，可忽略）；始终未武装时保持全文（两种边来源不能同时归零）。显式 `true`/`false` 覆盖保持静态语义不变（A₁-A₃ 实验臂不受影响）。新增回归测试（autoLlm 会话中期武装 → section text 翻转 `''`，走真实 `agent/status` 事件路径），全量回归 **258/258**。

## [1.3.1] - 2026-09-21（preset-cleaner isolate 残留修复）

### Fixed

- **preset-cleaner 净化副本残留 `isolate` 块导致 preset 挂载失败（建不了新会话）**：从 shipped preset 生成的净化副本 `<id>-argp` 只摘除了 `compaction-basic`/`tool-result-pruner` 行，却保留了 `compaction` 组上的 `isolate: { compaction: true, ... }`。cordis `isolate(name)` 的语义是被隔离的服务按**新 symbol** 解析、**不回落**宿主平面的 `compaction`（ArgpGraphEngine）——提供者被摘除后该隔离 realm 无提供者，`command-compact`（`inject=['commands','compaction']`）永久 "waiting for compaction" → 整个 preset 挂载失败（`agent-preset/invalid: 1 row(s) did not activate`），`agent-presets.default` 指向该 preset 时**所有新会话无法创建**。修复：新增 `stripIsolateBlock`，摘除 stock 行后同步摘掉对应组的 `isolate` 块，`command-compact` 的 `compaction` 恢复沿 scope 链解析到宿主平面的 ArgpGraphEngine，`/compact` 仍指向 ARGP 确定性 compactNow（零额外接线）。模块 doc-comment 同步勘误（旧注释"沿 scope 链向上解析到宿主平面"的假设在 isolate 存在时不成立）。preset-cleaner 测试扩至 11 项（含 `stripIsolateBlock` 4 例：命中剥离/无 isolate 不动/多 isolate 键只摘目标组/组内多行不受影响），全量回归 **257/257**。

## [1.3.0] - 2026-09-20（P6 轮内压力压缩「方案 B」+ Stage-1 生产路径修复）

### Fixed

- **压缩调用输出 cap 4096 → 16384（按 262,144 墙重标定）**：plan 的 quotes 部分 = dialog 保真保留（用户指令逐字转写，尺寸与原子原文同量级，不可省）⇒ cap 截断 = JSON 不完整 = parse 失败 = 整轮保原文。实弹（record 端到端，3-turn 语料）证实 4096 在首个大轮即截断（`completion_tokens=4096`）。防爆余量重算：触发线 100,007 + agent maxTokens 32,768 + cap 16,384 ≈ 149K ≪ 262,144（旧 174K 墙时代"让 margin"的推导过时；KV 池 933K 下 16K 响应的 prefill 搅动可忽略）。
- **prefixWithinBudget 读 usage 挂载路径错误 + 口径低估（P6 验证闭环抓到）**：真实 `assistant/message` 事件 usage 挂 **data 顶层**（agent-loop 落账 `{turn, step, message, usage, stream}`），旧实现读 `data.message.usage` 恒 undefined ⇒ **生产上 A 形态前缀被静默全量降级 C**（方案 B 复用收益不生效；压缩本身安全 = 保守方向）。且只算 `inputTokens`（未命中）会低估 prompt——billed 口径 = `inputTokens + cacheReadTokens + cacheWriteTokens`（与引擎真实锚点同式）。compressor / cite-declarer 两处同修；回归锁 = "inputTokens 10K + cacheRead 130K 超 132K 预算必须降级"用例。实弹：修复后压缩请求 6/6 全部 A 形态带前缀。

### Added

- **P6 轮内压力压缩（方案 B）**：turn N 上下文达标（与图剪 `compactIfNeeded('pressure')` 同口径的 `isPressureExceeded`）且存在 open turn ⇒ **同一 pre-step 窗口内先 per-atom 压缩 open turn 原子、再图剪头部**（两变异合成态 = "剪枝后老轮 + 压缩过的新轮"，无独立 restore 机制）。接线双路：`config.onPrePressureCompress` 显式注入 + `config.peratom` 自挂载时自动接 `compressor.compressOpenTurn`；回调失败隔离（吞错照常图剪）；无 open turn（全闭合）不压（活跃态守卫，闭合轮归 idle 边界路径）。配套：`resolveEffectiveCtk`（`enable_thinking:false` + `preserve_thinking:false` + 主链 `reasoning_effort` 从 `request/header` config 重建——LlmCallConfig 无 ctk 字段）、`doneTurns` 跨路径防重（open turn 压过 ⇒ 该轮闭合后 idle prepare 零调用跳过）。
- **A 形态前缀预算门控**：`prefixBudgetTokens`（默认 132,000）超预算该次**降级 C**（丢前缀只发指令），`degradedToC='prefix-budget'` 留痕——"全前缀或无前缀"二元；无 usage 可参照（会话头）保守降级。
- 单测 11 项（`test/peratom-pre-pressure.test.ts`）：pre-step 顺序（压先于剪）、压力同口径、无 open turn 守卫、失败隔离、集成（真 compressor 自挂载 + fetch 替身 + 图剪零 LLM）、doneTurns 跨路径防重、预算门控三例（预算内/三和口径超限/无 usage）、ctk 形状两例（主链 effort 继承 / 缺省不发 re 键）。`npm test` **253/253**（1.2.0 基线 242 + 11）。
- 实弹验证（record 端到端 + 线级 metrics 真值）：轮内触发时序、A 形态前缀与 ctk 在真实 wire 全部生效、输出 cap 防爆精确截断；KV 命中率 72.9–79.5%（metrics Δ，新引擎池 933K 无驱逐压力）。
- **Stage-1（双引擎）无生产挂载路径**（规格 §11.13.1）：`ArgpGraphEngine` 的 Stage-1 三管线只在 `config.peratom` 为对象时构造（`src/argp-graph-engine.ts:679`），而 `cordis.patch.yml` 的**整个 git 历史从未写入 `peratom`**——自 **2026-08-28**（`41fa600`）`config.peratom` 闸门引入起，bundle patch 就没有同步补上声明（bundle / profile / agent preset 三层皆无，历史备份逐字相同）→ 实际分发形态是**纯 Stage-2（0-LLM）**。插件自己的类型文档早已记录此缺口（`peratom?` doc-comment 原文："本块存在的意义是真宿主 bundle patch 只能声明式挂一个插件入口（发现一：default export 只有 graph 引擎 = 双引擎无生产路径）"，2026-08-28），bundle patch 头部注释亦自称 "mounts the 0-LLM ARGP engine"。后果：**组件 B（HLS repair）在默认安装下结构性不可达**（受控语料两臂 `[restored]` 计数均为 0、6386 次替换全是 `[elided]` 墓碑、`拆分/提取/摘要` 计数全 0、标签恒为 `argp/deterministic-guards`）。
- **关停陷阱 `peratom: false` 反向挂满**（同上，顺带修复）：闸门旧写法只判 `config.peratom !== undefined`，而 YAML 里"关掉 Stage-1"最自然的写法 `peratom: false` **会通过闸门** —— 布尔装箱后 `.compressor` 取到 `undefined` → `?? {}` → **三管线全挂**，与写配置者的意图完全相反。改判 `typeof config.peratom === 'object' && config.peratom !== null`，`false`/`null` 一律按"不挂"（与缺省同语义）。

### Added

- **宿主路由自动兜底 `autoDshLlmSpec(ctx, route)`**（`peratom/llm-adapter.ts`）：`PeratomCompressor` / `CiteDeclarer` 的 LLM 后端在**显式 `config.llm` 与 fetch（endpoint/apiKey/env）两路都缺省**时改为**延迟解析**——在真会话的 `agent/status` / `agent/pre-step` 钩子里现取 `agent.options.{provider,model}`（`rememberRoute`），配合宿主 `ctx.llm`（`LlmRuntime`）合成 `DshLlmSpec`。宿主换模型自动跟随，分发物不必钉死 provider/model。判定从严：路由缺任一项、或宿主无 llm 服务即返回 `null`，组件保持 disabled（**零网络**，与既有语义逐字一致；构造期日志由 `warn` 降为 `info` 并说明 auto 模式）。选路优先序 `backend()`：显式 `config.llm` > fetch > 自动兜底；`compaction/summary` 的 `provider`/`model` 标签同步反映**实际选路**（审计据此判"Stage-1 是否真的跑过"）。`CiteDeclarer.armed` 随路由到位翻转。
- 单测 5 项（`test/peratom-llm-adapter.test.ts` + `test/peratom-mount.test.ts`）：`autoDshLlmSpec` 边界（路由缺项/空串/宿主无 llm）、compressor 未武装→路由到位后武装（provider/model 跟随、fetch 零调用、落盘链路一致）、显式 `config.llm` 优先于兜底、declarer `armed` 翻转 + 声明边入缓存、`peratom: false` 不挂。`npm test` **242/242** 全绿（1.2.0 基线 237 + 5）。
- 规格文档 §11.13.1：根因定位（挂载闸门 + 逐层配置表 + 类型文档自述）+ 处置与**开启配方**（profile 层 modify 加 `peratom` 块；改后须开新会话）。

## [1.2.0] - 2026-09-17（token-ontology 组件 A/B + §11.8① 墓碑地板修复）— **BREAKING（宿主基线迁移）**

> **宿主基线再次跳档**：1.2.0 起 peer 对齐 **dsh ≥ 0.1.6-alpha.1**（cordis ≥4.0.2）。0.1.5-rc.1 宿主请继续使用 **1.1.0**。
> 沿 1.1.0 惯例——dsh 无真 stable 线，其 `latest` 即 rc 构建，故跟随宿主线仍发 stable 版本号。
> 本版核心 API 零漂移（alpha 线实测 build/237 测试全绿），迁移面仅依赖下限；另有三项默认行为变化见下方 Added/Fixed（均可旋钮回退）。

### Fixed

- **§11.8① 墓碑地板不可再剪（tombstone-merge）**：X 原子在 `isAtomCandidate` 结构性不可剪（`type ∉ {A,R,U}` 直接 return false）→ 每次压缩注入的 `[elided …]` 墓碑单调累积成"地板"，剪到候选耗尽仍超窗。受控语料两臂独立复现同形态 `CONTEXT_WINDOW_EXCEEDED`（run1 T17 / run2 T16，provider 报错数字同为 `141,313+32,768>174,080`）；run2 dump 重放投影实测 **1297/1310 surface 节点是墓碑、284,786 chars ≈142K tok、最长连续段 1295**。修复：新增导出纯函数 `isMergeableTombstone`（三判据 `[elided` 开头 + `pruned by ARGP` + `recall_pruned`；宿主注入 / 官方 checkpoint / tool 占位墓碑不合并）+ `consolidateTombstones()`（找第一段 ≥N 连续墓碑，tool-pairing 平衡校验后复用 `pruneIntervals` 事务骨架归并为单条聚合墓碑——聚合碑保持可再归并形态，地板随轮次收敛到常数；失败非致命）；挂点 `compactIfNeeded` 压力门槛后、建图前（热路径零开销）。旋钮 `tombstoneMergeMinRun`（默认 8，**0=关闭**，对照臂 A/B 用）。端到端实测：run2 T16 归并 ×1294 碑 → 1 条 192 字符聚合碑，surface elided 从 1297 节点/285K chars 塌至 6 节点/1459 chars，T16–T22 全部跑完、零再撞墙（237/237 测试绿，新增 4 项）。详见受控语料跑批规格书 §11.8.1（内部文档，不随包发布）。

### Added

- **HLS 经济学门控（组件 B 的代价盲修正，I-B5）**：`repairWithTrailer` 原先**无论值不值一律补全**——spike39 实测尾注开销 1003 字符 = 原文 41%、修复后 = 候选的 2.05×，F1/F4 两例 ROI 仅 0.02/0.07（几乎退化为"原文保面"）。新增 `token-ontology.ts` 的 `hlsRepairEconomics()` 纯函数与 `trailerText()`（尾注长度唯一事实源），判据：
  `B = L_orig − L_cand`（prose 增益）、`C =` 尾注占用、`N = B − C`（净释放）、`ROI = N / C`，仅当 `ROI ≥ θ` 才修复。
  默认 `θ = DEFAULT_HLS_ROI_THRESHOLD = 1`（尾注须替自己买单）；`N < 0`（越修越长）在任意 `θ ≥ 0` 下都被拒，退回 v1.1「原文保面」。配置面 `hlsRoiThreshold`（`PeratomCompressorConfig` + `PlanOptions`）；新增台账 `hlsRoiSkipped`（plan + `CompressRecord`）度量该区间频率。spike39 六例 ROI：F1=0.02 / F2=1.48 / F3=0.80 / F4=0.07 / F5=0.29 / F6=2.14（聚合 0.49）→ θ=1 下仅 F2/F6 存活。
- **`spike/40-edge-precision.ts`（`npm run spike40`）——组件 A 误连率实测**：受控植入真值（唯一 handle 数据原子 + A 原子植入"真依赖 T / 仅提及 M"），0-LLM 离线。结论：无噪音基线 precision=recall=1；误连率曲线精确等于 `m/(2+m)`（m=0/1/2/3 → 0%/33.3%/50%/60%）；半公共 handle（DF 13.2% < 15% 停词阈）漏网产生误连（**F40-1 HIGH**：停词是全或无二值，缺 DF 衰减）；`maxEdgesPerAtom` 按 seq 降序截断会丢更旧的真依赖（**F40-2 MEDIUM**）。
- **`npm run typecheck:spike`（`tsconfig.spike.json`）**：补齐覆盖率缺口——根 `tsconfig.json` 的 `include` 只有 `src/**` + `test/**`，**spike/ 一直不在类型检查内**（spike38 的未定义变量、spike39 的已移除 API 都只能靠运行时暴露）。新增配置把**当前世代 spike（38–42 + `spike/lib`）**纳入检查并挂到 `npm run check`；历史 spike（01–37）因 dsh API 漂移尚有约 130 个既有错误，暂不纳入（待单独清理）。
- **`spike/42-edge-labels.ts`（`npm run spike42`）——真实边标注工作表 / 打分器**：把真实语料上派生的边做成**盲化**工作表（实测 68 条：单 token 支撑 61 / ≥2 支撑 7），并给出打分器（总 precision + 分层 precision + Wilson 95% CI + 分层差 Δ）。**标注单位 = 配对**（A 摘录 + R 摘录 + 共同 token），**不用整轮对话**——整轮会泄露"后来发生了什么"这条捷径（该 session `read` 144 次 / `recall` 仅 2 次，静默降级是常态）。支撑强度单放 `.key.json` 以保盲化；判读规则先定死（Δ 显著为正才支持"≥k 独立 token 建边"）。**隐私**：工作表写 gitignored 的 `spike/out/labels/`，绝不提交。
- **`spike/lib/session-corpus.ts` + `spike/41-real-corpus.ts`（`npm run spike41`）——真实 session 语料能力**：本机 `~/.dsh/sessions` 的 session 可作测试语料。读取器要点：`session.v3.jsonl.zstd` 是**多帧 zstd 拼接**（单文件实测 502 帧），Node 的 `zstdDecompressSync` **只解第一帧且不报错**（会把 1.5MB 静默解成 193 字节）→ 需按 magic `28 B5 2F FD` 扫帧起点逐帧解压。**隐私铁律**：只读、绝不写回；**任何 session 原文不得提交进仓库**；需要可复现性时只提交派生聚合量；用例须能在目录缺失时优雅跳过。实测 4 个 session / 646 原子 / 1,052,502 字符，读取器 **0 坏帧、0 非法行、seq 缺口 0、重复 0**。
- **`spike/43-corpus-audit.ts`（`npm run spike43`）——受控语料自检**：跑完一份受控 session 后判定**这份语料能测什么、不能测什么**（不给"大概行"）。四组：①结构验收（chars/atoms/prune 量，`compaction/start` 因含 overflow-retry 膨胀仅作参考）②场景有效性（cites 声明率、跨轮 handle、extract 候选量、推断边）③**驱逐代价**（prune-then-reread）④**组件 B 生产线观测**（替换副本里的 `[restored]` 尾注 → 逐例复算 ROI、统计 θ=1 会拦下多少）。
- 真实日志的免费观察 + **两处自我纠错**：① `cites` 声明在 4 个 session 合计 **2 次**（1 处 / 136 条 assistant 原始回复 = 1.5%，其余为 0）而引擎做了 265 次 `compaction/prune` → 组件 A 基本是唯一语义选择性通道；**此前记为"0 次"是错的**（计数须只扫 append 原始写入的 assistant 正文，扫全日志会因 replace 副本虚增到 28）。② **`[restored]` 真实落盘 0 例**；裸文本搜索得到的 41 处**全是假阳性**（来自"对话在讨论 HLS 机制本身的源码"）→ 正确判据是 **I-B3 构造性**（尾注 token 逐字 ⊆ 原文承重词表）。③ 引入非循环指标 **prune-then-reread**：被驱逐路径 24/30（80%）在同 session 被再次读取——**上限值，可归因代价须由对照组做差**。

### Changed

- **宿主依赖线对齐 0.1.6-alpha.1**（发包前置，用户拍板走 alpha 档而非 rc.2 保守档）：18 个 `@deepseek-ai/dsh-*` peer+dev 从 `^0.1.5-rc.1`/精确 `0.1.5-rc.1` 升 `0.1.6-alpha.1`；`cordis` `^4.0.1`→`^4.0.2`（alpha 全线要求）；`schemastery` 不动（alpha 不约束）。零 API 漂移（typecheck/spike/smoke/237 测试全绿）。harness 侧 54/55 包同步（`dsh-code-runtime` 例外：alpha 线不存在、无人 peer，留 `0.1.5-alpha.2`）。坑：旧 lockfile 树毒 ERESOLVE 解析，须删 lock+node_modules 全新解析。
- **spike39 口径分离**：机制不变量（I-B1/I-B3）改测 `repairWithTrailer` **本体**，经济性（I-B5 门控）测 `planReplacements` 的放行/拒收。此前二者混用（用 plan 度量不变量）——门控一经引入即全线误报 FAIL。新增 **S39-6 门控一致性**（落盘集 == `{ROI ≥ θ}`；放行⇒`hlsRepairs=1/skippedFidelity=0`，拒收⇒`hlsRoiSkipped=1/steps=0/skippedFidelity=1`）与 `θ=0` 对照臂；S39-3 节省率改在**落盘子集**上计算（2/6 落盘，落盘子集节省 39.4%），不再被"退回原文"的零改动稀释。结果：ALL PASS（S39-1/2/3/5/6）。
- **spike38 S38-4 清账**：原断言拿常量 `7` 对表 `citeStats`（引擎内 `+=`，**跨 buildGraph 累加**）与 `inferredStats`（**最近一次建图**口径）→ 多趟 pass 下必然误判。改断不变量：ON/OFF 剪枝序列逐位一致 + 最终图 0 条推断边 + `accepted=0` + **两通道保护集完全重合**（原 INFO S38-5b 提升为硬判据）；原始计数降为 INFO（S38-4b/4c）。结果：spike38 ALL PASS（S38-1..S38-5）。
- **spike39 live 臂 API 修复**：`session.events` 在 dsh 0.1.5 已移除（1.1.0 CHANGELOG「Session.events 彻底消失」），live 臂仍用它 → 只因"无本地模型"长期跳过而潜伏。改经 `log-access.sessionEvents()`（与 spike38 同纪律）。

### Verified

- `npm run typecheck` 干净；`npm run typecheck:spike` 干净（38/39/40 零错误）；`npm test` **237/237** 全绿（较 1.1.0 基线 229 累计新增 8 项：HLS 门控/token-ontology 5 项 `trailerText` 口径、`hlsRepairEconomics` 数值与 θ 灵敏度、tool/info 两路门控放行与退回 + 墓碑归并 3 项）。
- `spike38` **ALL PASS**（S38-1..S38-5；S38-4 清账后转绿）、`spike39` **ALL PASS**（S39-1/2/3/5/6）、`spike40` 度量成立（2 PASS + 2 如实 FAIL = 机制边界 + 2 FINDING）、`spike41` **ALL PASS**（读取器完整性 0 坏帧/0 非法行/seq 零缺口；真实语料 2 条 FINDING）。
- 真实语料校准（spike41）的净结论：**不降低组件 A 的有效性，降低的是"稀有 handle 共现 ≈ 语义信号"这一信念**。受益侧（spike38 S38-3 的 3/3 保护）不受影响；暴露的是信号**判别力弱**（89.7% 单 token 支撑——而单 token 恰是真引用与巧合提及的**共同形态**，故不等于误连率高）与停词阈**结构性空转**（F41-1，maxDF 17 ≪ 阈 33）。**同时撤回上一版的两条修法建议**（"停词按 DF 衰减"、"≥k 独立 token 才建边"）：前者无从衰减，后者会误杀真引用。**在拿到真实误连率标注前不应改门控。**
- 文档：`PROPOSAL-token-ontology.md` 新增 §2.1「已知边界」（spike40 结论 + 缺口 2 能力边界 + §5 生命周期 2/3 结构天花板）与 §3 门控口径；§5 验收表补 Spike 40 / 门控单测行。

## [1.1.0] - 2026-09-10（dsh 0.1.5 支持：V3 会话信封迁移）— **BREAKING**

> **宿主兼容性跳代。** 1.1.0 起要求 **dsh ≥ 0.1.5-alpha.1**；rc.2 ~ 0.1.3-alpha.2 宿主请继续使用 **1.0.5**。两代不兼容，且无法在同一个构建内兼容——详见下方「为什么不能两代通吃」。

### Added

- **`asSeq` / `asSeqs` 边界收窄 helper（`log-access.ts`）**：dsh 0.1.5 起 `SessionSeq = BrandedNumber<'SessionSeq'>` 是品牌类型，而 ARGP 内部模型（原子/区间/账目/预算）一律用裸 `number` 做算术。约定：**内部永远裸 number，只在写入/查询 dsh API 的边界收窄**，不做重复运行时校验（宿主 `Session.append` 已对 seq 做权威校验，重复校验只会把错误信息推离现场、并制造第二份需同步维护的真相）。
- **node-0 系统提示保护用例 + `atomize` 显式注释**：0.1.5 把系统提示表示为 surface node 0 的 `system/message`，宿主 `assertSystemHeadRewrite` 硬性保护该位置。`atomize` 只认 user/assistant/tool-result、`system/message` 静默跳过 → node 0 永不进入剪枝区间。原先这是隐式依赖，现已写进注释并由测试钉死（`argp-graph-engine.test.ts`）。

### Changed — 迁移到 V3 会话信封

- **`SurfaceOp` 判别键改名 `start`/`end` → `startSeq`/`endSeq`**（dsh commit `657e68186a`，V3 canonical session envelopes），5 处 production 写点 + 12 处测试同步改名。
- **`assistant/message` 禁止携带 `sourceEventSeqs`**（类型层 `?: never` + 运行时 `assertProvenance` throw）。删掉 cites 剥离写回处的该字段——安全性由「`shadowedSeqsOf` 只认 `compaction/prune.shadowedSeqs` 权威账本」保证，不再从 replace 事件反推被遮节点。
- **`Session.events` 彻底消失**：1.0.4 引入的 `sessionEvents()` 双分支中，legacy 分支在受支持基线上已不可达，仅作防御保留（改由 stub 用例覆盖）。
- **`assistant/message` 新增必填 `stream` 字段**、`testkit` 的 `systemPrompt.persona` → `personaPrefix`、`dsh-llm` 的 `CallId` → `ToolCallId`。
- **依赖基线整体升到 `0.1.5-rc.1`**（peer + dev 全部）；`cordis` 保持 `^4.0.1`（master 用 4.0.2，caret 已覆盖）。

### 为什么不能两代通吃

两代都强制 `Object.keys(surfaceOp).length === 3`（rc.2 认 `op/start/end`，0.1.5 认 `op/startSeq/endSeq`），**同时写两套键必然被拒**。一个构建要同时支持两代只能加运行时版本嗅探——对主打确定性的引擎而言是不必要的不确定性来源，故取舍为：**1.0.5 守住老宿主，1.1.0 走新格式。**

### Verified

- `npm run check` 全绿（**211/211**，2026-09-10），新增/改写用例含：node-0 保护、`sessionEvents` 当前基线实证 + legacy stub、V3 键名全链路。
- 依赖基线换代前的红灯对照：只改代码不改依赖时 209 总 / 133 过 / **76 失败**（全部 `carries an invalid replace surfaceOp`）——这是「测试基线落后于目标宿主」的直证，也是本次必须同步升依赖的原因。

### Known

- 0.1.5 起 dsh 默认模型切到 **DeepSeek-V41-Flash**（V4-Flash 仍保留可选）。ARGP 既有的 v4-flash 成本标定数字**不得外推**到新默认档。

## [1.0.5] - 2026-09-04（preset 净化自动生成 + WebUI 设置卡片）

### Added

- **Preset 净化器（Q8 双引擎收口）：引擎挂载期自动生成 `<id>-argp` 净化 preset（`preset-cleaner.ts`，commit 2881669）**：dsh rc.2 把 agent 组成迁入 preset 平面后，standard/cordis/ptc 各自在隔离 realm 内挂官方 `compaction-basic`，宿主 profile 的 `disabled: true` 物理管不到（平面错位，非 loader bug）→ 官方摘要器与 ARGP 双引擎同秒抢 `agent/pre-step`，有损摘要抢跑图剪。修复：`ArgpGraphEngine` 构造期经 `ctx.inject(['agentPresets'])` 触发 `cleanShippedPresets()`——对每个仍挂 stock compaction 的 shipped preset 走官方 `copy()` API 生成 `<id>-argp` 副本（落 `~/.dsh/.agent-presets/`），缩进感知行手术摘除 `compaction-basic` + `tool-result-pruner`（零 YAML 依赖，`!!js` 行不触碰）；**保留 `command-compact`**——realm 内 `compaction` 服务沿 scope 链解析到宿主平面 ARGP 引擎，`/compact` 自动指向确定性 `compactNow`，零额外接线。幂等 + 漂移自愈 + fail-soft，写回靠 standing-mount 文件戳热生效（新会话免重启）。`config.presetClean: false` 可关。shipped preset 源文件逐字不动（单测断言），净化是增项不是替换。首启实证（2026-09-04）：`cordis-argp`/`ptc-argp`/`standard-argp` 三副本落盘，stock 行 grep 零命中。
- **WebUI 设置卡片（commit 5e1ec38）**：Settings → 插件 → 插件配置新增 ARGP 卡（`src/client/`，自绘 React 无 JSX），编辑 9 个引擎旋钮（windowRatio/retainRatio/maxPasses/recencyGuard/turnGuard/minSpanChars/enableSummarize/sortMode/charsPerToken），含 overridden 徽标 + 单字段 reset、脏态暂存与保存/放弃。

### Fixed

- **设置卡片浅色主题黑底不可读（commit f5c341f）**：卡片内联样式引用宿主不存在的变量（`--bg-elevated`/`--border`/`--bg-input`/`--accent`/`--danger` 等），全部落到暗色回退字面量 → 浅色主题下黑底黑字。改用宿主 `--dsw-alias-*` 主题体系（浅/深双套自动适配），回退字面量全部换浅色安全值，chrome 对齐宿主 `PluginCard`。

### Verified

- `npm run check` 全绿（209/209 PASS，2026-09-04），含 preset-cleaner 7 条单测（缩进手术幂等/漂移自愈/源文件不变式/白名单）。

## [1.0.4] - 2026-09-03（dsh 0.1.2-alpha.4 兼容 + 仓库定位收敛）

### Fixed

- **dsh 0.1.2-alpha.4 升级阻断：`Session.events` getter 被移除（breaking `27bf1039db`），插件崩溃 `Cannot read properties of undefined (reading 'length')`（2026-09-02 定位）**：全库事件日志读取原直接访问 `session.events`（rc.2 专属 API）。修复：新增 `sessionEvents(session)` helper（`log-access.ts`，运行时探测 `snapshotEvents`→alpha.4 / 回退 `events`→rc.2），作为全库唯一事件日志入口；事件计数 `.length` 改读 `session.seq`。8 文件 46 处收口，`npm run check` 202/202 全绿 + 双宿主实证（legacy `events`=alpha.1 WebUI 真挂载；modern `snapshotEvents`=alpha.4 探针）。`SESSION_FORMAT_VERSION` 仍为 0，存量会话字节兼容。
- **spike 基建误伤（1cb4f18）**：1.0.3 后的 spike 精简误删了仍被 8 个存留 harness import 的共享挂载工具 `spike/deepseek.ts` / `spike/model-mount.ts`（`npm run smoke:deepseek`、spike6/7/8/26 全部悬空）→ 自 `eb99d74` 恢复。

### Changed

- **peerDependencies 放宽为 `^0.1.1-rc.2`**（原为精确钉死），兼容 rc.2 → 0.1.2-alpha.4 双宿主（eb99d74）。

### Docs（仓库定位收敛：面向直接安装用户的非学术仓库）

- 新增根级 **`ARCHITECTURE.md`**：面向使用者的实现说明（事件原子化与引用边 / 反向拓扑剪枝不变式 / 双引擎生产挂载 / shadow-price 契约 / sessionEvents 双宿主 / recall zoom / 不变式清单），与 README 的特性介绍分工。
- README（中/英）定性化改写：水位与轮次放大改定性口径；测试数更新为 202/202（2026-09-03 实测）；证据落点收敛到 CHANGELOG（`spike/out/` 为 gitignored 本地产物目录，外部读者不可见）。
- 内部台账（设计基准/证据链/上游投递稿，15 篇 docs + 11 个零引用 spike 脚本）迁出公开仓库；`docs/` 仅保留 `dsh-argp-mount-example.md` 与 `dsh-llm-adapter.md` 两篇用户向文档；spike/ 收敛至 26 个有活引用的脚本。

### Verified

- `npm run check` 全绿（202/202 PASS，2026-09-03）。

## [1.0.3] - 2026-09-01（KV 前缀缓存击穿深层修复：永久冻结 catalog）

### Fixed

- **1.0.2 的「冻结-on-剪枝」仍漏：agent/pre-step 每步重绑 session 致 catalog 段非剪枝轮显隐（2026-09-01 定位）**：`agent/pre-step` 每步调 `bindSession(agent.session)`，dsh 每步传入的 session 对象可能换新身份 → `if (this.session === session) return` 对象恒等守卫失效 → `bindSession` 重跑 → `frozenCatalog` 被重算成当时 `catalogText` 值（某些步返回 `''`）→ `argp-catalog` 段在**非剪枝轮**凭空消失/重现 → system 块字节变、整块 KV 丢弃（用户报「glob 后重新注入提示词」）。证据：实时会话 `session-ef109049-…` 里 5 个 `request/header` 事件 system 块变 3 次、且**全部在非剪枝步**；`compaction/prune` 全挤在 seq 16707–16721、落在两个字节完全相同的稳定请求之间 → 变化与剪枝不同步，变化文本即 `[context] Compression removed N` catalog 块。修复：**永久冻结**——`bindSession` 仅在 `frozenCatalog === null`（首次绑定）拍一次快照；`pruneIntervals` 落剪不再刷新；`argp-catalog` section fallback 为 `''`（极端 null 也恒定，不再 live 重算）。system 块全程逐字节恒定、KV 100% 命中（含真实落剪轮——剪枝那步失效本是压缩固有权衡，catalog 文本不再额外变一次）。

### Verified

- `npm run check` 全绿（198/198 PASS），含 2 条回归测试（catalog 永久冻结、跨真实落剪仍恒定）。
- 端到端 spike `verify-frozen-catalog-cache.ts`：12 轮 / 4 次真实落剪 / **system 块变化 0 次 [PASS]**。
- 多引擎审计：peratom/recall（`recall-engine.ts`、`peratom/recall-zoom.ts`）的 system section 均为静态字面量、pre-step 不碰 system；bundle 仅挂载 `ArgpGraphEngine`，`ArgpRecallEngine` 与之互斥不共存 → 无多引擎叠加 KV 威胁。

### Docs

- 代价说明：catalog 冻结在首次绑定时刻值（全新会话通常 `''`），inline "Compression removed N" 目录不再显示；`recall_pruned` / `list_pruned` 仍扫原始日志、发现能力不丢。

## [1.0.2] - 2026-09-01（KV 前缀缓存击穿修复）

### Fixed

- **每步 assemble 重求值 argp-catalog 致整段前缀缓存 KV 失效（2026-09-01 定位）**：`argp-catalog`（order 9999）原为动态 PromptSection，每步 `systemPrompt.assemble()` 重求值；ARGP `agent/pre-step` 每步 `compactIfNeeded('pressure')`，剪枝压力下 `shadowedSeqsOf` 增长使 `catalogText` 输出变化，改动单条被前缀缓存的 system message 块 → 整块 KV 丢弃（剪枝压力在轮末达峰，故"最后一步"显形，用户报"所有 KV 缓存丢失"）。修复：catalog 改为**全程冻结快照**——`bindSession` 拍初值、`argp-catalog` section 回放 `frozenCatalog`、唯一刷新点在 `pruneIntervals` 落剪成功末尾（恰在可见上下文因剪枝换代之后）。无剪枝整段对话 system 块逐字节一致 → 前缀缓存全段命中；剪枝那一步的失效是上下文真实变更的必然代价（与摘要式压缩同源权衡）。`npm run check` 全绿（196/196 PASS）。

## [1.0.1] - 2026-09-01（resume 投影契约修复 + 反馈通道补齐）

### Fixed

- **graph 剪枝违反宿主 shadow-price 严格相等契约，导致 WebUI resume 投影 throw（2026-09-01 定位）**：`pruneIntervals` 原发「一个总跨度 `compaction/prune`（shadowedRange=全区间 first..last）+ N 个逐区间 replace」，而宿主 `token-meter/surface-projection.ts foldSurfaceProjection` 要求 shadow-price 事件的范围与紧随其后的 surface replace **严格相等**，否则重放投影 throw（`"token surface: replace at seq N ... no adjacent shadow price (armed claim covers A-B)"`）。alpha.2 新增 per-turn usage 投影（dsh #3005）接入 resume 路径后该矛盾首次暴露（rc.2 同数据可正常 resume，故长期未被发现）。修复：对齐宿主官方 `compaction-tool-result-pruner` 的逐节点模式——**每区间 1 个 `compaction/prune`（shadowedRange=该单区间）+ 紧邻该区间 replace**；末尾 `compaction/summary`（总范围，off-surface）保留，其 claim 被紧随的 off-surface `compaction/end` 清掉。`rebuildLedgerFromLog` 同步改为合并事务内全部 prune（兼容旧单 prune 日志）。新增 fold 契约回归测试（复刻宿主 fold 判定，旧结构必 throw / 新结构必过）。存量脏会话日志有配套修复脚本（不改 `shadowedSeqs`，recall/账本能力保留，宿主真实 fold 函数金标准验证零 throw）。

### Added

- **peerDependencies 补 `@deepseek-ai/dsh-agent: 0.1.1-rc.2`**（与其余 dsh-* peer 对齐，此前漏列）。

### Docs

- **反馈通道补齐**：README（中/英）新增「问题反馈 / Reporting issues」节（Bug→Issue，设计讨论/使用问题→Discussion，附 dsh 版本 + 本包版本 + 最小复现指引）；`package.json` 补 `bugs.url`（npm 详情页直接挂报错入口）；CONTRIBUTING 反馈渠道改为「Bug 开 Issue，讨论开 Discussion」——修正此前「不启用 Issues」的表述（仓库 Issues 实际开启中）。

## [1.0.0] - 2026-08-29（双引擎落地版）

> **发版门槛结案（2026-08-29）**：① 轮次放大判据实测 **PASS 8.57×**（溢出存活：A 臂 60/60 轮零中止 vs E 臂零压缩 T8 死亡；8K 窗预注册压测，产物 `spike/out/37-three-arm-{E,A}-2026-08-29T07-04-*`，）。② 复核三项经用户拍板（2026-08-29，DeepSeek 额度不足）改为**本地机制验证**：引擎稳态缓存零税（healthy 峰 86-87% ≡ E 对照 84.7%，三次测量两模型两窗口交叉钉死；双峰口径修正见审计脚本头注）、保真判据未受压（D 7/7）。DeepSeek/v4-flash 标定降级为 post-1.0.0 可选补充；对外措辞按三禁规则执行（数字带窗口/任务/模型三要素）。同日独立 review 两处坐实缺陷修复（见 Fixed）。

### Added — 双引擎（Stage-1 per-atom，此前的 0.x 版本只有 Stage-2 graph）

- **PeratomCompressor**（eager 轮末熵降）：确定性门控（`gate.ts` 判"是否可压"）+ 单次 LLM 调用逐原子决策（`extract` 逐字摘录 / `summary` 概括入账 / `false` 显式不压）；长 user 消息 dialog 抄写拆分 + U-info 聚合（空隙归 info，spike 32 实测定案）；tail-only 替换 + 前缀指纹不变断言（缓存经济生命线）。
- **CiteDeclarer**（轮末边声明）：模型按近 10 轮窗口声明跨轮引用边，经 `injectEdges` 通道喂给 Stage-2 建图——实测召回效率 ≈ 无边臂 2.6×。
- **RecallZoom**（两级召回）：`recall_summary` / `recall_detail`（日志原文逐字节一致，sha256 测试锁定）+ 4 倍制预算（超限引导不硬拒）。
- **Stage-2 对接 + 溢出三步**（P4）：U-info 按 R 待遇参剪（唯一引擎改动点，五处触点枚举测试）；context-overflow 恢复环插入 forcePrune→compress→forcePrune 序列；生产挂载工厂（`mountPeratomStack`）+ 引擎 `config.peratom` 自挂载块（bundle patch 单插件入口，P0）。
- **dsh-llm 生产适配器**：compressor/declarer `config.llm = {provider, model}` 走宿主 LlmRuntime（`purpose='compaction'`、usage 入 record、多模型分工独立指定）；fetch 遗产路径行为不变作 fallback；严格宿主下免 inject 解析（`resolveLlmRuntime` 双通道）。
- **压缩事务 UI checkpoint**：peratom user 替换携带 compact checkpoint 署名 + 双管线事务追加 `compaction/summary` 展示事件（诚实计量；`compaction/prune` 仍是唯一权威账本）——替换型压缩首次在 WebUI 可见并显示真实计量。
- **citesObligation 门控**：回复级 cites 协议退役——declarer 已武装（解析到 LLM 后端）时不再注入 `argp-cites` system section，边声明走结构化旁路，回复正文不再携带 `{"cites":...}` 尾；显式 true/false 覆盖（A₁-A₃ 实验臂可强制开）。
- **预算手动旋钮显式化**：`windowRatio` / `retainRatio`（或绝对值 `windowTokens` / `retainTokens`）+ 压力测量来源标注（`anchored`/`tokenMeter`/`config`/`chars`，进压力日志供实验审计）。
- spike/37 五臂 harness（A/B/C/D/E）+ K_no 死亡检测 + 反事实轨迹 + 放大倍数计算（P5-bis 就绪）；spike/atom-audit.mjs 逐原子审计、cache-waste-audit.mjs 缓存归因审计（双峰口径内建）。

### Fixed

- **no-op replace**：模型对源码类 tool-result 全文照抄（收益 ≤5%）时 fidelityGuard 平凡通过 → 零收益 replace；新增 no-op 守卫视同 false 拒绝（spike 37 两次跑批 6 例实锤，计数 `skippedNoopGain` 可观测）。
- **溢出三步第②步默认失效（review 坐实，严重）**：`maxOverflowRetries` 缺省 1 时事件#2 在重试上限守卫直接保留原错误，per-atom 降熵在默认配置下永不触发（测试显式传值掩盖、生产挂载无人设值）。修复：挂载 compressor 且未显式配置时缺省提到 3；耗尽判定独立存在不空转。
- **溢出第②步轮归属错配（review 坐实，中等）**：原接线压"最新闭合轮"，但溢出发生在当前 open turn——与设计 §8「对当前轮大原子降熵」不符。修复：新增 `collectOpenTurn`/`compressOpenTurn`（过滤同款），两处接线改压 open turn，doneTurns 防闭合后重压。
- **边合并双计**：模型残留 cites 尾与 declarer 声明同 (from,to) 时 inDegree 双计——injectEdges 合并按边去重（先到优先）。
- **锚定口径加固**：usage 锚点和补 `cacheWriteTokens`（与 UI ContextMeter 分子同口径）；声明窗口缓存（request/context 权威口径，物理探测 7.7× 口径差根除）。
- 早期 0.3.x 系列发布级修复（压缩静默失效、跨轮缓存全断）见 [0.3.2]/[0.3.1]。

### Changed

- per-atom prompt 定义式迭代：资料定义改开放集（"一切非指令内容"）、quotes 规则强化（粘贴物正文的建议性表述算资料）、tools false 档（"不压"为显式信号）、info 压缩落地（设计 §10 决策 1）。
- shadowed 账本只认 compaction/prune——per-atom 压缩 replace 不再谎报为剪枝（catalog "Compression removed N" 不再误增）。
- 14 处裸 console 直调收敛至 ctx.logger 门面；产物命名规范（INVALID-* 隔离污染 run）。
- 定位换轨（方案 A，2026-08-28 拍板）："确定性剪枝工具" → "带守卫的上下文虚拟化"；ARGP 降级为产品词，README/package description 已按「the LLM proposes, deterministic guards dispose」落地。

### Verified

- P5 四臂对照 **GO**（2026-08-26，spike 37/37b）：A 臂 30/30 零 error、探针 7/7、成本 A≤C 全分量；D 臂（摘要基线）最便宜但探针 5/7——保真优先于成本校准定调。
- 60 轮放开对比：末轮水位 A=E 的 40%（模型可见口径）；E vs A 30 轮末轮降幅 59.8%。
- 本地复核三件（2026-08-29）：溢出存活 **8.57×**；稳态缓存零税（healthy 86-87% ≡ E）；保真判据未受压。判据与产物路径见本节及上方产物目录。
- 真宿主联调（2026-08-28/29，rc.2 部署 + ModelScope）：验收三项闭环（双引擎挂载、窗口口径、cites 剥离）、checkpoint 节点实测、回复协议退役实测（新轮次零 cites 尾 + declarer 建边开火）。联调细节见内部台账（已迁出公开仓库）。
- 质量门禁：`npm run check` **195/195 全绿**（2026-08-29）。

## [0.3.2] - 2026-08-22

### Fixed
- **压缩静默失效（发布级 bug：任何超线场景 boundaries 恒为 0）**：atomize 重建引用图时，`argpCites` 的形状判据检查的是 V6 graded 字段 `c.t`，但 `stripTrailingCitesIfNeeded` 实际写回的是 `ParsedCite`（`{text, level}`）→ `every()` 恒 false → 误落进 string[] 分支、把对象塞进 `text` → `buildGraph` 的 `cite.text.trim()` 抛 `TypeError` → pressure prune 被静默 catch 吞掉 → 估算超触发线也从不压缩（本地 100K/80K/16K 与 v4-flash 同复现；`compaction/start` 从未发出、`boundaries=0`、cites `resolved=0`）。修复：① atomize 对 argpCites 归一化，兼容 `ParsedCite[]` / `string[]`（V5 旧产物）/ graded `{t,l}`（契约原文）三种形状；② buildGraph 对非字符串 `cite.text` 防御性跳过（cites 来自不可信模型输入），压缩主体绝不再抛错。

### Tests
- 既有 72 用例全过（typecheck + `npm test`）。
- 真实长程验证（spike/26，v4-flash 50 轮，100K/80K/16K）：**VERDICT PASS**——25 次压缩事务（start/summary/end 全配对、0 error，修复前为 0）、cites `declared=182 / resolved=182`（修复前 resolved=0）、U 探针 8/10、R 探针 8/10、8/8 文件、stderr 零抛错。产物 `spike/out/26-v4-fix50-*`。

## [0.3.1] - 2026-08-22

### Fixed
- **跨轮 prompt cache 全断（发布级 bug，前缀稳定性核心论点受损）**：`shadowedSeqsOf` 原来把**任何** `surfaceOp !== 'append'` 事件都计入 shadowedSet，而 cites 剥离写回（`stripTrailingCitesIfNeeded`：模型回复落盘后以单点 `surfaceOp:{op:'replace',start:seq,end:seq}` + `data.argpCites` 原地改写）被误判为"被剪节点" → catalog 谎报 `Compression removed N items`（压缩事务数为 0 时也逐轮增长）→ system message 前缀每轮变化 → 跨轮 KV/prefix cache 从变化点起全部失效（本地实测：每轮首请求 miss = 全上下文 28K→42K、`progress` 从 0.15 重新 prefill）。修复：只认 `op==='replace'` 且**无 `argpCites` 字段**的 replace 为剪枝（真压缩 tombstone 是 user/message 无此字段；单点/区间真剪枝都保留，防单点压缩漏剪）。
- **动态 catalog 位置（连带修复，前缀稳定性的一部分）**：`argp-catalog` 从 `argp-contract`（order 150，system 靠前）拆出、独立注册于 order 9999（system 末尾）——压缩后仅 catalog 尾巴 miss，persona+契约正文+cites 静态前缀保持可缓存。recall 协议不依赖 catalog 在 system 靠前。

### Tests
- 既有 72 用例全过（typecheck + `npm test`）。
- 诊断工具（spike/ 下，不入库）：`llm-log-proxy.mjs`（请求捕获代理，diff 每轮真实 system 前缀）、`.tmp/extract-usage.mjs`（events.jsonl 逐轮 usage 提取）、`large-prefix-cache-probe.mjs`（大前缀缓存探针）。

## [0.3.0] - 2026-08-20

### Added
- **assessment-v2 A 轨实现（12 项 A1–A12，评估文档已迁出公开仓库）**：基于逻辑链（引用依赖拓扑）的上下文压缩引擎重大功能升级。
  - **A1 V6 分级 cites**：`parseCitesBlock` 返回 `{text, level}`，严格等级匹配（`c`/`critical`、`x`/`contextual`、裸字符串/非法值回退 `supporting`，禁止子串误判）；critical 边激活闭包守卫不变量 2′（仅 external critical 边计入 `inDegreeByClosure`）。
  - **A2 前缀守卫**：默认 `citeMinPrefixLen=4`，统一 `ascii + wide*2` 折算（`"the"` 拒 / `"读书"` 放行）；歧义消解取最长公共前缀最深原子。
  - **A3 R 版本键修复（N1）**：issuer A 工具名 + 参数 JSON（原 issuer 文本），修复同措辞不同参数误归链。
  - **A4 版本链去重**：`mergeOlderR` 按合并后组成员数计 `chainLen`（无重复累加）；可选 θ 行重叠链式（默认关）。
  - **A5 n-gram 倒排索引**：候选收窄 + 验证谓词分离；前缀过短回退全扫描。
  - **A7 resume 账目重建**：`bindSession()` 统一 `setSession`/`agent/pre-step`/`compactIfNeeded`/`compactNow` 绑定，records + prunedNodeIndex 从追加日志懒重建（幂等、`rebuiltCompactionIds` 去重；未闭合 start → 仅 audit 告警）。
  - **A8 ask 检测**：导出纯函数 `looksAskText()`，CJK 句首锚定（`^(请|帮我|能不能|能否)`），句尾"帮我"不再误命中。
  - **A9 catalog 扩 R**：字符预算驱动（`charBudget = tokenBudget * charsPerToken`）。
  - **A10（必补项，收窄版）**：带 R 组的工具 A 仅当组内 R 无任何组外入边（语义 `curInDegree` + 组外确定性边）才保护；被外部 cites 后 R 解锁 → A 可剪。force 路径同判据。
  - **A11 参数化**：`closureWindowK`/`citeMinPrefixLen`/`overlapTheta`/`enableOverlapChain` 进 `ArgpGraphConfig`（带默认）。
  - **A12 spike/25 中合规合成臂**。
  - **A6 summarize 终端**：留作未实现（文档标注，默认关）。

### Tests
- 新增 10 用例：level 解析 / 前缀守卫 / A10 受保护·可剪双控 / chainLen / critical 闭包守卫 / ask 收窄（纯函数 + 集成）；crash-recovery 扩至真实 resume 流程。`npm run check` 72/72 通过。

## [0.2.9] - 2026-08-20

### Fixed
- **引擎不挂载（发布级 bug，v0.2.6–v0.2.8）**：`cordis.patch.yml` 的 `- id: dsh-argp` 普通条目（modify）**不创建 entry**——bundle include 只应用包的 patch、不为包本身建 entry（entry 只能由 patch 的 `insert` 创建，实测 vendor/loader + apps/cli profile-boot）。v0.2.6 修 duplicate 时把 `insert` 改成 modify → **没有任何代码创建 dsh-argp entry → 引擎从不挂载**（`ctx.compaction` 仍是 stock；cites 契约 PromptSection 不进系统提示，Qwen3.8-27B 真会话 cites 服从率 0/18 实锤）。修复：包 patch 恢复 `insert`（创建 entry）；profile 层只做 modify 覆盖（勿重复 insert，否则 duplicate）。README 双语安装段同步更正。
- **客户端加载失败（发布级 bug，v0.2.8）**：优雅降级写法 `ctx.assistantDisplay?.register` 仍触发 cordis proxy 检查（读未声明服务的属性即抛 `cannot get property "assistantDisplay" without inject`，可选链不豁免）。修复：改用 `ctx.get('assistantDisplay')`（服务缺失返回 undefined 不抛错）——无 seam 宿主静默跳过，有 seam 宿主注册过滤器。

## [0.2.8] - 2026-08-20

### Fixed
- **客户端加载失败（发布级 hotfix）**：`dsh.client.inject` 误把包名 `@deepseek-ai/dsh-client-ui-conversation` 当服务名声明 → web shell 去加载 npm latest（0.0.1-rc.1 旧包，无 `assistantDisplay` seam）→ apply 报 `cannot get property "assistantDisplay" without inject`。修复：`inject` 置空（对齐官方 client 包惯例，如 connection）；服务依赖由 `src/client/index.ts` 的 static `inject: ['assistantDisplay']` 声明，seam 由宿主 rc.7 的 ui-conversation 提供。

## [0.2.7] - 2026-08-20

### Added
- **客户端显示过滤（建议书候选 B-7 落地：cites 块 UI 隐藏）**：dsh-argp 新增客户端半边——`package.json` 声明 `dsh.client` + `exports["./client"]`，`scripts/build-client.mjs`（esbuild）产出 `window.__ModuleLoader__.load` 格式的 `lib/client.js` bundle（与 tsdown client preset 同构，零外部依赖）。客户端在原生 ui-conversation 新增的通用 **`assistantDisplay` 显示过滤 seam** 上注册"剥离尾部 cites JSON"过滤器：assistant 回复末尾的 `{"cites":[...]}` 块（裸 JSON 或 ```json 围栏、空或非空）在 Web UI 渲染层被隐藏——仅显示层，不触日志/surface/模型文本；非空 cites 仍正常进入引用图。共享纯模块 `src/cites-strip.ts`（`matchCitesTail`/`parseCitesBlock`/`stripCitesTail`），服务端 `extractCites` 与客户端过滤器复用同一匹配逻辑，零漂移。seam 原生侧为纯增量改动（默认空过滤器 = 行为不变），已同步至本地 dsh 检出；构建校验：monorepo client pass 全绿、8/8 测试过、bundle 加载契约 mock 验证过
- **`/compact` 手动压缩链路补全**：`compactNow` 补 `sourceCommandId` 参数（对齐基类三参签名与 compaction-basic），透传至事务事件（`compaction/start` data）与 `GraphPruneRecord` 台账，供 UI presentation correlation（`/compact` 触发的事务可溯源到命令）。`peerDependencies` 补 `@deepseek-ai/dsh-commands`（`CommandId` 品牌类型，官方同款）。回归测试 `test/manual-compact.test.ts` 4 用例（可剪会话选块 / 全 U 返回 null / sourceCommandId 透传且自动压缩不污染 / 手动 span 含 U-X 拒绝）

## [0.2.6] - 2026-08-20

### Fixed
- **bundle patch 重复挂载修复（发布级 hotfix）**：`cordis.patch.yml` 原用 `insert` 挂载 `id=dsh-argp`——但 `dsh plugin add` 后 dsh 已把包 include 进 profile 层（entry id = 包名），再 insert 同名 entry 导致 loader 报 `duplicate loader entry id: dsh-argp` 启动失败（v0.2.5 起 reconcile 自动把 dsh-argp 加入 bundles 后必现）。修复：patch 改普通配置覆盖条目（modify 不 insert）；README 安装段同步修正（双语）。

## [0.2.5] - 2026-08-19

### Added
- **context-overflow 溢出恢复**：模型请求返回 400 `exceed_context_size_error` 时自动强制剪枝并重发请求——`agent/request-error` 钩子按稳定错误码 `CONTEXT_WINDOW_EXCEEDED` 识别（不写死 token 数），`compactIfNeeded(agent, 'context-overflow')` 跳过 pressure 门槛强制压缩（估算可能低估实际请求），surface 换代后返回 `{kind:'retry'}` 让 agent loop 从替换后的 surface 重发同一任务请求。恢复路径 **0 次新增 LLM 调用**（纯算法剪枝，对比原生 summarize 恢复的 1 次摘要请求，无新增失败面）。`maxOverflowRetries` 默认 1（对齐 compaction-basic），成功应答 / agent idle 时重置计数。回归测试 `test/context-overflow.test.ts`

### Changed
- cites 契约 V5：空引用时**完全不输出 block**（V4 的 `{"cites":[]}` 废止）；记录 UI 转录 append-origin 根因（Web UI 人类转录取 append 起源事件、surface replace 副本 model-only，服务端 strip 改不到 UI 显示——UI 层过滤需客户端 seam，见建议书候选 B-7）

## [0.2.4] - 2026-08-19

P1–P7 审计修复全量落地 + 依赖升级 rc.7 + npm 首发。

### Added
- **全日志 recall（P1 修复路线 b）**：`recall_pruned` 三引擎去门控——对任意界内 seq 返回原文（含 live / off-surface 节点），返回值带 `[recall seq=N state=shadowed|live|off-surface]` 状态标签，只有越界才报错；共享模块 `src/log-access.ts`
- `list_pruned` 区间模式（`fromSeq`/`toSeq`）：扫描全日志带 state 标签，作为"可见窗口补集查询"发现原语
- 程序化全日志入口 `recallAnyState()` / `nodeState()`（基类 `recall()` 保留 pruned-only 语义，spike 探针依赖）
- B-6 立案（API 反馈建议书）：surface 渲染窗口丢弃无痕迹、窗口边界对压缩引擎不可见（H1 框架，需适配器级取证）

### Fixed
- **P2**：recall 防抖 key 从 per-pass 重发的 `closureId` 改为跨 pass 稳定的 `rootSeq`（原实现写入/读取永不相等，防抖分支死代码）；回归测试 `test/closure-debounce.test.ts`
- **P3/P6**：closure tombstone 嵌入 `seqs=first..last` + `K of N`（tombstone-within-tombstone 两跳后 seq 不丢失）
- **P4**：latestTurn 统一为 surface 节点口径，`turnBasis=semantic`（默认）排除注入型 reminder 推进轮次
- **P5**：`compactRegion` 守卫文案 scoped 到手动入口（自动闭包生命周期确实会剪 U root / X checkpoint）
- **P7**：recall 字数预算每笔 compaction 事务后重置；预算耗尽时显式说明（不再静默返回纯 `…(truncated)`）
- 表面剥离尾随 `{"cites":[...]}` JSON（assistant-message 提交时零窗口改写，`argpCites` 存根保留引用图跨压缩不丢）

### Changed
- 依赖升级：`@deepseek-ai/dsh-*` 0.1.0-rc.6 → **0.1.0-rc.7**（实测无 API breaking，check 49/49 通过）
- README 双语补充 npm registry 安装 / `update` 升级 / GitHub 备选源
- 发布：**npm 首发 `dsh-argp@0.2.4`**（账号开通后），与 GitHub Release v0.2.4 同版本对齐

## [0.2.3] - 2026-08-19

### Added
- `turnGuard` 配置：保护最近 N 个完整 turn 的原子不参剪（真会话一个 turn 常含多个 surface 节点，recencyGuard 按节点位置保护易截断当前轮）

### Fixed
- 真会话压缩预算解析：`resolveScaledBudgets` 优先读 `session.requestContext()` 的 `contextWindow`（原路径 `llm.resolveModelInfo` 在真会话失败 → 错误 fallback 到 16384 触发线，导致 25% 占用就触发压缩）；`measureTokens` 优先接 `ctx.tokenMeter`

## [0.2.2] - 2026-08-19

### Fixed
- 真会话连续压缩循环：`minSpanChars` 默认 512→**0**（区间放回导致可见量压不到 retain 目标，每个 pre-step 重复触发）；`maxPasses` 16→**256**（大上下文一次调用压到位）

## [0.2.1] - 2026-08-18

### Added
- tag 驱动 GitHub Release workflow（`release.yml`，npm publish deferred）
- pre-push 钩子 + 提交信息规范检查（conventional commits）
- CHANGELOG / CONTRIBUTING 建档

### Changed
- bundle patch 移至仓库根 `cordis.patch.yml`（市场扫描按根路径检查），删除过期 `cordis/` 目录，修复 `files` 字段
- cites 契约升级（V4 措辞）：10-turn 重跑实测 declared 0 → **43.6%**、resolved 100%

## [0.2.0] - 2026-08-18

首个 tagged 版本（GitHub Release: `v0.2.0`）。主要内容：

### Added
- 产物型发布包：`lib/` 构建产物、`cordis/argp.cordis.patch.yml` 挂载补丁、`dsh` plugin 市场契约（STANDARD.md §2 合规）
- ratio-driven 压缩预算（window=ctx×0.8，retain=window×0.2），含 adapter-contextWindow 解析与降级回退
- 错误重试机制与反事实成本分析（13 失败 turn 归因）
- 提交规范与质量门禁：CI workflow（typecheck/smoke/test/build + lib 一致性检查）、pre-push 钩子、CONTRIBUTING.md

### Changed
- 包名 `argp-dsh` → `dsh-argp`（与公开仓库对齐）
- README 中文为主（README.md）+ 英文版（README.en.md），补充 P4 挂载验证、160K 验证、B-5 平台缺口
- repository 字段补全（市场识别契约）

### Fixed
- B-5 空流缺口证据固化（77% error、maxTokens 无关），进入正式 API 反馈建议书

### Verified
- 160K 场景定稿对比：ARGP A 档 U 7/7 R 7/7、0 error、压缩率精确兑现（200K→160K 触发→32K 保留）
- 声明式生产挂载（`dsh plugin` CLI + profile patch）在 dsh 0.1.0-rc.6 上验证通过
