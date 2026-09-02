# Changelog

本项目使用 conventional commits 记录变更，版本由 `package.json` + git tag 锚定。双分发渠道：**GitHub Release**（tag 驱动）+ **npm registry**（`dsh-argp`，账号 `yoza10635`）。

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
