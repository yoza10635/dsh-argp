# 受控语料跑批规格（corpus run spec）

> 目的：**故意跑一份真实工作流 session**，作为可测量的语料。与 spike41 的"考古本机旧 session"
> 不同——本规格产出的语料是**按已知条件构造的**，因此它的统计结论可比、可复现、可归因。
>
> 配套自检：`npm run spike43`（跑完立刻判定这份语料**能**支撑哪些测量、**不能**支撑哪些）。

---

## 0. 一句话

**构建固定 + 模型固定 + 触发线固定 + 任务量级达标 + 探针轮留真值。**

五条缺一条，产出的语料就只能做描述性统计，不能做结论。

---

## 1. 构建（被测插件版本）

| 项 | 值 |
|---|---|
| 被测 | 工作树 `dsh-argp`（含 v1.2.0 未提交改动：A10 修正 + HLS 经济学门控 + token 本体） |
| 记录 | `git rev-parse --short HEAD` + `git status --porcelain`（脏标记，必须留档） |
| 对照组 | **同一构建** + `disableInferredEdges: true`（可选再加 `hlsMode: 'off'`），**同题重跑** |
| 旋钮快照 | `cordis.patch.yml` 的 config（当前 `maxPasses: 256` / `recencyGuard: 10`）+ profile 层 `~/.dsh/profiles/web/cordis.patch.yml`（见 §3.4） |
| **构建/安装** | ⚠️ **`npm run build` + 安装到 `~/.dsh/profiles/web/node_modules/dsh-argp` + 开新会话**，否则跑的是旧构建（见 §3.5） |

> 为什么必须留脏标记：未提交改动意味着"这份语料对应哪份代码"无法从 commit 复原，事后无法归因。

## 2. 模型 + preset（固定，且必须是目标场景）

| 项 | 当前环境值 |
|---|---|
| provider / model | `localhost` / `Qwen3.8-27B` |
| endpoint | `http://<vllm-host>:1234/v1`（**注意：不是 `:8080`**） |
| preset | `standard-argp`（`agent-presets.default`） |
| maxTokens | `32768`（`~/.dsh/settings.yaml`，2026-09-15 由 16384 上调；声明 contextWindow 仍 262144） |

**约束**：如果目标是"本地小模型的 `extract` 会不自觉改写 file:line / 错误码"这一场景
（即 spike34 语料的来源、HLS 修复档的存在理由），**必须用本地模型**——云端默认模型不产生该失效模式。

## 3. 上下文预算（**改 windowRatio + retainRatio 这一对，不要改 contextWindow**）

推导链（`argp-graph-engine.ts:135-148` + `:2013-2020`）：

```
windowTokens = contextWindow × windowRatio      (缺省 windowRatio = 0.8)
retainTokens = windowTokens × retainRatio       (缺省 retainRatio = 0.2)
触发线       = windowTokens − reserveTokens     (缺省 reserveTokens = 0)
```

### 3.1 关键：`windowTokens` 门的是**总 prompt**，不是历史

`measureTokens()`（`:1510`）优先用 provider 回传的**真实 prompt token 锚点**（`lastRealPromptTokens`）
再加 surface 增量 —— 即 `contextTokens ≈ 系统提示 + 工具 schema + 历史`。
所以：

```
历史可用预算 = windowTokens − O        （O = 系统提示 + 工具 schema 的固定开销）
```

**本机实测 O ≈ 8–10K tokens**（取真实 session 首轮 `assistant/message` 的
`usage.inputTokens`：a56061c2 = **9976**、e96831b8 = **8146**、ffefa0f7 = **8142**；
其中系统提示本体 2604–4458 tok，余下是工具 schema + 极少历史）。
⚠️ 口径陷阱：`usage` 的字段名是 **`inputTokens`**，不是 `promptTokens`（按后者取会全部为空）。

**推论**：`windowTokens = 32768` 时**历史只剩 ~23K 可用**，而压缩目标 `retain = 32768 × 0.2 = 6553`
—— **低于单轮工作集**（一轮读 2–4 个源码文件 ≈ 10–15K tok）→ 历史在 6.5K↔23K 间抖动，
**每 1–2 轮压一次且压到工作集以下**，语料偏向"极端压力形态"，任务也更容易卡住。
**建议约束**：`windowTokens ≥ 4 × O` ≈ **40K 起**，否则历史被固定开销挤死。

### 3.2 压缩次数要按 `window − retain` 算，不是按 `window` 算

每完成一次压缩能"吸收"的新增内容 ≈ `windowTokens − retainTokens`，所以：

```
压缩次数 ≈ 总追加 tokens / (windowTokens − retainTokens)
```

### 3.3 推荐配置（**成对设定**）

| windowRatio | 触发线 | retainRatio | 保留 | 每次吸收 | 22 轮（≈250K tok）压缩次数 | 历史震荡区间 |
|---|---|---|---|---|---|---|
| 0.8（缺省） | 209715 | 0.2 | 41943 | 167772 | **0–1** | 不适合作语料（几乎压不动） |
| **0.25（推荐）** | **65536** | **0.25** | **16384** | 49152 | **≈5** | **16K–55K** ✅ |
| 0.125 | 32768 | 0.2 | 6553 | 26215 | ≈9（偏多） | **6.5K–23K**（低于工作集，抖动） |

**首选 `windowRatio = 0.25` + `retainRatio = 0.25`**：
- 安全：触发线 65K + O 10K ≪ cw 262144（4 倍余量，**绝不会**踩 `clampMaxTokensToContext`）；
- 不挤：历史预算 55K，保留 16K > 单轮工作集；
- 够观测：≈5 次压缩，满足 A2/A3；
- 代表性：`触发:保留 = 4:1`，接近生产的 5:1（0.125/0.2 的 5:1 配 6.5K 绝对量才是真问题）。

**调参纪律**：若实测"一轮就结束、根本没触发压缩"，**补轮次（加量）而不是缩窗口**——
缩窗口是在拿代表性换压缩次数。若实测 Agent 每轮都在重读、任务停滞，把 `windowRatio` 提到 0.375
（触发 98304）重跑。

**记录实际解析值**，不要只记配置：日志里应能看到 `windowTokens/retainTokens` 的解析结果
（`declared contextWindow changed` 一类）以及 `request/context` 事件里的 `contextWindow`。

### 3.4 本次已落地的配置（2026-09-15，用户拍板）

| 项 | 值 | 落在哪 |
|---|---|---|
| `contextWindow` | 262144（不动） | `~/.dsh/settings.yaml` → `llm-pi-ai.providers.localhost.models[Qwen3.8-27B]` |
| `maxTokens` | **16384 → 32768** | 同上（写代码任务输出量大，16K 偏紧；输入上限 229376 ≫ 触发线，无钳制风险） |
| `windowRatio` | **0.3815** | `~/.dsh/profiles/web/cordis.patch.yml`（profile 层，**modify 行，不 insert**） |
| `retainRatio` | 0.2（显式重述） | 同上 |
| `maxPasses` / `recencyGuard` | 256 / 10（显式重述，防被本层覆盖） | 同上 |

**解析后的预期值**（**必须在跑批首轮实测核对**）：

```
触发线 = 262144 × 0.3815 ≈ 100,007 tok（≈100K）
保留   = 100,007 × 0.2   ≈ 20,001 tok
历史可用预算 = 100,007 − O(≈10K) ≈ 90K
压缩次数 ≈ 总追加 250K / (100,007 − 20,001 = 80,006) ≈ 3 次
```

> ⚠️ **若实测解析值不是 ≈100007/20001**，说明 profile 层的 modify 行被 no-op 了
> （插件包自己的注释里提过 "patch: entry dsh-argp not found" 这一失败模式）。
> **兜底顺序**：① 把同样的 `config` 写进插件包自己的 `cordis.patch.yml`（bundle 层的 insert 一定生效）；
> ② 或用 `windowTokens: 100000` 显式值替代 `windowRatio`。任一兜底都要按 §1 记录并在跑批后还原。

### 3.5 构建与安装（**易踩：改了 src 不等于改了运行时**）

运行中的插件是 **`~/.dsh/profiles/web/node_modules/dsh-argp` 的实体拷贝**，**不是指向工作树的软链**。
2026-09-15 实测：该拷贝是 **Sep 14 的旧构建**，`lib/` 里**没有** `token-ontology.js`、
`compressor.js` 里**没有** `hlsRoiSkipped` → **组件 A/B 根本不存在**，此时跑语料是废数据。

**跑批前必做**：

```bash
cd C:/workspace/Project/dsh-argp
npm run build                                   # tsc -p tsconfig.build.json + build-client
# 核对产物
ls lib | grep token-ontology                    # 必须有 token-ontology.js
grep -c hlsRoiSkipped lib/peratom/compressor.js # 必须 > 0
grep -c curInDegreeDecl lib/argp-graph-engine.js # 必须 > 0（A10 修正）

# 备份后安装到运行位置（备份放 node_modules 之外，避免被包扫描拾取）
BK=~/.dsh/backups/dsh-argp-$(date +%Y%m%d-%H%M%S)
mkdir -p "$BK" && cp -r ~/.dsh/profiles/web/node_modules/dsh-argp/. "$BK/"
INST=~/.dsh/profiles/web/node_modules/dsh-argp
rm -rf "$INST/lib" && cp -r lib "$INST/lib"
cp -f package.json cordis.patch.yml "$INST/"
```

**装上之后必须开新会话**（旧进程的模块已在 ESM 缓存里，不会热更）。
并按 §1 记录：`git rev-parse --short HEAD` + `git status --porcelain` + 安装时间戳 + 备份路径。

## 4. 任务规格（决定语料到不到量）

三条硬要求，缺一条就测不到对应机制：

| 要求 | 门槛 | 为什么 |
|---|---|---|
| **跨轮依赖** | ≥3 处（同一路径/错误码在 ≥2 轮被再次引用） | 否则 `deriveInferredEdges` 零命中，组件 A **无数据** |
| **带承重 token 的真 tool result** | ≥30 个 | 真实 shell 报错 + 源码 `read` 天然满足（路径 / 行号 / 错误码） |
| **总追加量** | **压缩次数 ≈ 总追加 tokens / (window − retain) ≥ 3，目标 ≈5** | 次数按 `window − retain` 算（见 §3.2）；推荐配置下 ≈250K tokens 追加量即可 |

> ⚠️ 早期版本此处写"总历史 ≥5× 触发线"，**公式是错的**（应除以 `window − retain`）；
> 且它会诱导"缩窗口凑次数"这一拿代表性换观测量的做法。已改为上面的次数公式。

参照：本机现有真实 session 一趟 14 轮 = 417K 字符 = 238 原子。**量级上 15–25 轮就够**，不需要长跑。

**另需固定**：
- **起始 commit**：仓库必须干净（`git status --porcelain` 为空），否则"任务前状态"不可复现；
- **任务书**：写成固定 prompt 序列（可直接贴），使对照组能**同题重跑**。

## 5. 探针轮（产生"非循环"真值——本节最重要）

在设计的轮次插入**只能从早前 tool result 回答**的问题，记录三态：

| 观测 | 含义 |
|---|---|
| 直接答对 | 早前内容仍在 surface（或已被模型记住） |
| **重新读取**（re-read 同一路径） | **早前那份内容确实被需要，且已被剪掉** ← 驱逐代价的直接证据 |
| 答错 / 编造 | 最严重：信息丢失且未察觉 |

设计约束：
- 探针 **3–5 个**，间隔 **≥5 轮**，避免同一次压缩同时命中多个探针；
- 探针指向的源原子应落在**会被剪的区间**（较老的数据原子，而非 recency 保护区）；
- 探针问题里**不要**复述答案所需的 handle（否则等于把内容重新写进上下文，探针失效）。

> 这一步把"压缩有没有丢东西"从**主观判断**变成**行为观测**——不依赖人工标注，也不循环。

## 6. 复跑

| 次数 | 目的 |
|---|---|
| 主臂 ≥2 次 | 估计模型随机性带来的方差（不同种子/温度下剪枝序列会不同） |
| 对照臂 1 次 | 同题、关掉被测机制，做差 |

## 7. 跑完自检（`npm run spike43`）
```
npm run spike43                              # 审最新 session
npm run spike43 -- <session.v3.jsonl.zstd>   # 审指定 session
```

审计四组：

1. **结构验收**：turns / atoms / chars / `compaction/start` 次数 / `compaction/prune` 次数与去重 seq 数
2. **场景有效性**：`cites` 声明数（应为 **0** = 空窗场景成立）、跨轮依赖数、承重 token 密度、推断边数
3. **驱逐代价（非循环）**：**prune-then-reread**——内容被驱逐后，同一路径是否被再次 `read`/`grep`
4. **结论**：逐条判定这份语料**能**支撑哪些测量、**不能**支撑哪些（不给"大概行"）

> 自检不通过就**不要拿它下结论**——这是本规格存在的意义。

## 8. 隐私

真实 session 是用户本人的工作数据。语料**只落 gitignored 的 `spike/out/`**，
**仓库里只允许出现聚合量**（计数 / 分布 / 分位数），不得出现原文摘录。

## 9. 自指语料的假阳性陷阱（实测踩过，必须防）

如果受控任务**本身就是在开发被测机制**（例如任务书就是"改 `token-ontology.ts` 的 HLS 门控"），
那么日志里会出现**机制源码与机制讨论的原文**，于是：

- 裸文本搜索 `[restored]` 会命中 `return candidate + '\n[restored] ' + missing.join(' ')` 这行源码
  → 本机实测 **41 处假阳性，真实 HLS 落盘 0 例**；
- 裸搜索 `"cites"` 会命中**工具 schema 的字段说明**与 **replace 副本**（同一份声明被重复计入）。

**规则**：
1. **被测机制的字面量绝不能用裸文本搜索判定**——一律加**构造性校验**
   （如 HLS 用 I-B3：尾注 token 逐字 ⊆ 原文承重词表）；
2. 计数只扫**原始写入**（`surfaceOp === 'append'`），排除 replace 副本；
3. 强烈建议**受控语料的任务与被测代码解耦**——比如在一个**无关的小仓库**里跑任务，
   只把 dsh-argp 当插件挂上去。这样既避免自指假阳性，也让"任务前状态"干净可复现。

## 10. 已装配的任务书

| 项 | 值 |
|---|---|
| 选题 | **中型项目：基于 Canvas 的吸血鬼幸存者**（`AgentCodingTest/中型项目/…`） |
| 任务书 | [`corpus-run-taskbook-vs.md`](./corpus-run-taskbook-vs.md) — 22 轮逐字可贴 + 5 个探针 |
| 目标仓库 | `C:\workspace\Project\vs-corpus`（已 `git init` + 空起始提交；`git status` 干净） |
| 为什么不选另外两档 | 微型（单文件智能配置中心）量太少；大型（分布式定时任务平台，全栈 10 模块）跑不完 |
| 为什么不给参考实现 | 该题目自带 `reference/game/`（19 个模块）——**给 Agent 就退化成抄写**，承重 token 与自然报错都没了 |

**量级实测锚点（T1–T3 小样，2026-09-15）**：跑了 3 轮（T1 完成 582s；T2/T3 各 600s 超时，
未跑完）→ 累计 **86 原子 / 44,937 字符 / 最后一次请求 `inputTokens=62,781`**。
- **每轮增量 ≈ 20K prompt tokens**（usage 序列 `3,526 → 28,982 → 62,781`）
- 触发线 100,007 → **约 5–6 轮才触发第一次压缩**（实测 `compaction/*` 事件数 = 0，与"62,781 < 100,007"自洽）
- 22 轮全跑完 ≈ 440K tokens 追加 → **约 4–5 次压缩** ✓ 达 §4 门槛
- ⚠️ **单轮耗时约 10 分钟**（本地 27B）→ 22 轮 × 2 臂 ≈ **7 小时**；正式跑批要单独排期
- 组件 A 数据在积累（`spike43`）：推断边 **7 → 25 条**，跨轮 handle 27，cites 2.1%

**量级估算**（未实测，仅上界推算）：22 轮 × 约 10 次工具调用 × 约 4K 字符/结果 ≈ **880K 字符
≈ 250K tokens 追加量**。按本次落地配置（触发 100,007 / 保留 20,001，每次吸收 80,006 tok）
→ **约 3 次压缩**，达到 §4 的 `≥3 次` 门槛但处在下限。若实测只有 1–2 次，
**按任务书 §6 补"重构/扩展"轮**，不要在探针轮加量。

## 11. 自动跑批（通过 API 程序化驱动）—— 可行性已验（2026-09-15）

### 11.1 三个前提（均已实测通过）

| 前提 | 实测结果 |
|---|---|
| 本地模型端点在 | `http://<vllm-host>:1234/v1` → `qwen3.8-27b-vllm`（**vLLM**，`max_model_len=174080`） |
| tool calling 可用 | 直接 `POST /chat/completions` 带 `tools` → **`finish_reason = "tool_calls"`**，参数正确 |
| 驱动范式已有 | `spike/35-peratom-agentloop.ts`：`new Context()` → `mountAgentLoopTestDependencies` → `InvariantRegistry` + `applySessionInvariant` → `AgentLoop` → `LlmPiAi`（`providers.local.baseURL` 指向本地）→ 注册工具 → `ctx.agentLoop.create(SessionId, {provider,model})` → `agent.followup(createUserMessage(...))` → `waitIdle`。`spike/38` 另有挂 `ArgpGraphEngine` 的范式 |

真格式落盘用 **`dsh-session-persistence`**。

**⚠️ 修正（同日）**：本节初版写"缺 `read`/`edit`/`grep`/`glob` 的独立包 → harness 需自建"——**错了**。
错因：只看了 **dsh-argp 自己的 devDeps** 就下结论。实际上它们存在，只是 dsh-argp 没依赖：
`@deepseek-ai/dsh-tool-fs`（read/write/edit）、`@deepseek-ai/dsh-tool-fs-search`（grep/glob）、
`dsh-persona`、`dsh-agent-instructions` 等 —— **全部可从 npmmirror 装**（已逐个验证版本可查）。

### 11.2 复用标准模式（ARGP）：可以，且这才是首选路线

**`standard-argp` preset 本身是一份标准 cordis loader 配置**
（`~/.dsh/.agent-presets/standard-argp/agent.cordis.yml`，12.6KB），列的就是生产 agent 的插件图：

| 组 | 插件 |
|---|---|
| 提示 | `dsh-persona`、`dsh-agent-instructions` |
| Shell | `dsh-tool-bash` / `dsh-tool-pwsh`（`!!js` 平台条件） |
| **文件** | **`dsh-tool-fs`**（read/write/edit）、**`dsh-tool-fs-search`**（grep/glob） |
| 其它 | `dsh-tool-jobs`、`dsh-tool-todo`、`dsh-tool-ask-user`、skill / goal / plan-mode / web / subagent / workflow |
| 压缩 | `compaction` 组 → `command-compact`（**`compaction-basic` 已被 ARGP 净化器摘掉**，这就是 "-argp" 的含义） |

**三条路线（修正后）**：

| | **A2 · 挂真 preset（首选）** | A1 · 自建工具集 | C · UI 手动跑 |
|---|---|---|---|
| agent 形态 | **≈生产**（同插件包、同 tool schema、同提示） | ⚠️ 自建，偏差大 | =生产 |
| 自动化 | ✅ | ✅ | ❌ 人盯 22×2 轮 |
| 门槛 | 需补装 preset 的包 + 实测哪些插件能脱离 app 运行时 | 无 | 无 |

**A2 的已知偏差与风险（如实记录）**：
1. `agent.cordis.yml` 含 `!!js` 自定义 YAML 标签与 `cordis:group`，**直接"解析后加载"需要 dsh 的 loader**；
   harness 更实际的做法是**按该 yml 显式挂同一套插件**（yml 仍作清单事实源），
   并允许"已挂子集"的偏差（首版可只挂编码必需：persona + instructions + bash/fs + fs-search + todo）。
2. **版本对齐**：preset 未 pin 版本，实际版本由 app 内的 bundle 决定（在 `app.asar` 里）。
   从镜像装 latest 可能与宿主 bundle 不一致 → **需实测**，不一致时如实记录。
3. 部分插件（subagent / workflow / web）可能依赖 host 服务，未必能脱离 app 运行时。

**推荐**：**A2 先跑 T1–T3 小样**验证管道（挂载 + 工具调用 + ARGP + 持久化 + `spike43` 审计全通），
并核验窗口解析值 ≈100007/20001。小样是"预演"，**不替代正式跑批的代表性**。

### 11.2.1 另一个发现：`dsh-argp` 是 npm 依赖，不是本地链接

`~/.dsh/profiles/web/package.json`：

```json
{ "dependencies": { "dsh-argp": "^1.1.0" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-argp"] } } }
```

→ **这才是那份 Sep 14 旧构建的根源**：profile 从 **npm registry** 拉 `dsh-argp@^1.1.0`。
本节 §3.5 的"手工覆盖安装"是**应急补丁**，**下次 `pnpm install` / 更新会被还原**。
要长期让 dev 构建生效，应改为装**本地 tarball**（`npm pack` 后 `pnpm add ./dsh-argp-x.y.z.tgz`）
或把依赖指到本地路径。**跑批记录里必须写明用的是哪种安装方式。**

### 11.3 专用 preset `corpus-vs-a2`（**已创建**，2026-09-15）

**为什么必须新建，而不是直接用 `standard-argp`** —— 三个硬理由：

1. **`standard-argp` 是生成物，改不得。** 它由 ARGP 净化器管理，对目标副本的策略是
   「目标已存在时按自愈语义**重跑手术**」（`preset-cleaner.ts:207`）→ 手改会被回灌覆盖。
2. **受控跑批必须摘掉会跑崩/污染语料的组**，而这些在 `standard-argp` 里不能改：
   - **`tool-ask-user`**：headless 跑批里 agent 一旦反问就**永久挂住**（真实 session 里它被调用过 1 次）。
   - **`delegation`（整组：subagent / workflow / ralph）**：派生**嵌套会话**，语料不再是单会话。
   - **`tool-web`**：外部服务 + 凭证 → 不确定性。
   - **`skill-filesystem` + `tool-skill`**：扫技能目录 → **环境依赖**（换台机器就不同）→ 不可复现。
3. **单一事实源 + UI 也能选**：harness 只「加载 preset」，不在 TS 里复刻插件清单；
   且**同一 preset 可在 WorkBuddy UI 里选中** → 路线 A2 与 C 变成同一份配置，可比性最好。

**生成方式**（复用仓库自己的行手术，已单测覆盖）：

```ts
import { stripPresetRows, dropEmptyGroups } from './src/preset-cleaner.ts'
const { text } = stripPresetRows(sourceText, ['tool-ask-user','delegation','tool-web','skill-filesystem','tool-skill'])
fs.writeFileSync(target, dropEmptyGroups(text))
```

**须知机制（三条，均由源码实证）**：
- 净化器只处理 **`row.trust === 'system'`** 的 shipped preset（`:221-224`）→
  **用户层新 id（`trust: 'user'`）永不会被它碰**，所以新 preset 安全。
- roster 的 `ensureStanding` 以 **composition 文件戳（mtime+size）判定世代** →
  **写回后新会话自动挂新 generation，无需重启宿主**；已开口的会话固定旧组成。
- 目标目录 = **用户根** `~/.dsh/.agent-presets/<id>/`（净化器声明「只 copy/写 user root，
  永不触碰 shipped 安装目录」）。官方创建 API 是 `agentPresets.copy(from, id, name)`。

**本次落地**：

| 项 | 值 |
|---|---|
| id | `corpus-vs-a2` |
| 运行位置 | `~/.dsh/.agent-presets/corpus-vs-a2/`（`agent.cordis.yml` + `preset.yml`） |
| **归档** | **`docs/presets/corpus-vs-a2.agent.cordis.yml`**（含 sha256，供复现/比对） |
| sha256 | `f6f579b493c3df9856465c2fdd9a1390b545ab4c92c39d980c0f9e65187884b5` |
| 摘除 | `skill-filesystem` `tool-skill` `delegation`(整组) `tool-ask-user` `tool-web` |
| 保留 | `persona` `agent-instructions` `tool-bash`\`tool-pwsh` `tool-fs` `tool-fs-search` `tool-jobs` `command-goal` `tool-goal` `planning`\`plan-mode` `compaction`\`command-compact` `tool-todo` `present` |
| 结构自检 | 空 `config:` 孤儿 **0**；`compaction-basic` 仅存在于**注释**（无实际引用）→ 无 stock 压缩器；`command-compact` + `isolate.compaction` 保留（按设计沿 scope 链解析到宿主 ARGP） |
| 体量 | 9061 字符（源 11412） |

**保留 `tool-goal` 的风险提示**：goal 会让 agent 自循环多轮。若要更受控，把它也摘掉
（或把 `max_goal_rounds` 设小）。**保留 `plan-mode` 的代价**：agent 可能进入"只出计划"的状态。
两者都属"纯本地能力、贴近生产"，故默认保留并在此声明，**跑批记录需注明是否调整**。

**待人工确认**：新 preset 是否在 UI 里被列为可选项（roster 扫描 user root 的行为无法在脚本里验证）。

### 11.4 harness 实现要点（2026-09-15 实测，全部踩过）

**位置**：`C:/workspace/Project/dsh-corpus-harness/`（**独立包，不在 dsh-argp 仓库内**）——
`run.ts`（驱动）+ `taskbook.ts`（从 markdown 任务书抽 T1..T22 的逐字 prompt）+ `package.json`。
跑：`node --import ../dsh-argp/scripts/ts-import-rewrite-loader.mjs run.ts --turns N`。

**为什么必须独立包**：把 preset 的工具包装进 dsh-argp 会**破坏它的依赖树**——
`npm i --legacy-peer-deps` 会忽略 peer 依赖，把锁文件里**靠 peer 装上的包**（`dsh-scope`、
`dsh-session-projection`、`dsh-fs`）当多余项**清掉** → 测试从 234/234 掉到 32 跑 / 25 失败。
恢复靠 `npm ci`（按锁文件重装）。**教训：受控跑批的依赖树要与被测仓库隔离。**

**版本线：必须用 `0.1.5-rc.1` 同线包（这一条踩过三次，代价最大）。**
`@deepseek-ai/dsh-*` 的 preset 工具包**每个都有 `0.1.5-rc.1` 版本**，与 dsh-argp 钉的核心同线。
**用错线的后果分三层，且一层比一层隐蔽**：

| 层 | 症状 | 触发线 |
|---|---|---|
| import | 进程直接起不来（`does not provide an export named 'PERSONA_ORDER'` / `'assertNever'`） | `dsh-persona` / `dsh-agent-instructions` 用 0.1.1-rc.2 |
| **服务接口** | **挂载"成功"、工具"注册成功"，调用时才报 `ctx.fs.resolve is not a function` / `ctx.shell.resolve is not a function`** | `dsh-tool-fs`/`dsh-tool-bash` 用 0.1.1-rc.2（核心 0.1.5-rc.1 的 `FileSystem` 只有 `constructor/sandboxMode/processPathFromHostPath`，**没有 `resolve`**） |
| config | `invalid config:` 挂载被拒 | `dsh-tool-fs-search` 用旧线 |

**为什么第一次挑错了版本**：`npm view <pkg> versions` 的输出被 `tail -14` 截断，只看到 `…0.1.3-alpha.2`，
于是误判"最高只到 0.1.2-alpha"，把整条 `0.1.5-rc.1` 线排除在外。
**教训：查可用版本必须列全（`| tr ',' '\n' | grep -v '^$'`），不要截断后再下结论。**

**同线替换命令**（一次换齐 8 个包）：
```bash
npm i --legacy-peer-deps --registry=https://registry.npmmirror.com \
  @deepseek-ai/dsh-tool-fs@0.1.5-rc.1 @deepseek-ai/dsh-tool-fs-search@0.1.5-rc.1 \
  @deepseek-ai/dsh-tool-bash@0.1.5-rc.1 @deepseek-ai/dsh-tool-todo@0.1.5-rc.1 \
  @deepseek-ai/dsh-persona@0.1.5-rc.1 @deepseek-ai/dsh-agent-instructions@0.1.5-rc.1 \
  @deepseek-ai/dsh-output-retention@0.1.5-rc.1 @deepseek-ai/dsh-spill@0.1.5-rc.1
```
**注**：`--legacy-peer-deps` 在 **harness 里**用是安全的（独立包，树由 core 版本清单照搬而来）；
**在 dsh-argp 仓库里用会破坏它的依赖树**（见上条），这是两个场景的关键差别。

**挂载写法（两个必知坑）**：
1. **必须传模块命名空间**（`{apply, inject, name}`），不能传 `mod.apply` / `mod.default`
   —— 传后者会**丢掉 `inject`**，报 `cannot get property "tools" without inject`。
2. **`agentLoop.create()` 在 0.1.5 返回 Promise** → 必须 `await`；Agent 的发消息/等待方法是
   **`followup(msg)` / `whenIdle()`**（不是 `agent.session` 直取后的 `agent.followup` on Promise）。
3. **工具插件的服务依赖：只挂"具体后端"，绝不挂抽象基类；形状再逐个核对。** 缺任一环时工具会
   **静默不注册**（插件本身合法 → 仍出现在"挂载成功"里），现象是**模型直接说"我没有可用的
   文件/终端工具"、然后吐一段贴代码块的伪交付**，目标仓库零文件（已踩）。

   **规律一（最隐蔽的一层，务必记）**：`dsh-fs` / `dsh-shell` / `dsh-subprocess` 都是**抽象基类**
   （README 首行即 "Abstract filesystem provider"），它们的 `resolve()` 是**空抽象方法**。
   挂了基类后服务名被基类实例占住，具体后端再挂报 `service "shell" has been registered at
   <ShellExecutor>`，而工具拿到的是**没有 `resolve` 的对象** → 调用时报
   `ctx.fs.resolve is not a function` / `ctx.shell.resolve is not a function`。
   **挂载成功、工具注册成功、只在调用时炸**——三层里最隐蔽。

   **规律二**：形状分两类，传错报 `invalid plugin, expect function or object with an "apply"
   method, received object`。

   | 包 | 类型 | 形状 / inject | 提供 |
   |---|---|---|---|
   | `dsh-fs-local` | **后端** | `default`（LocalFileSystem） | `fs` ✅ |
   | `dsh-bash-local` | **后端** | `default`（inject: `["subprocess"]`） | `shell` ✅ |
   | `dsh-subprocess-local` | **后端** | `default`（LocalSubprocessRuntime） | `subprocess` ✅ |
   | `dsh-sandbox` | 后端 | `default`（SandboxProvider） | `sandbox` |
   | `dsh-shell-env` | 命名空间 | `apply`/`inject`/`name` | `shellEnv` |
   | `dsh-tool-fs` | 命名空间 | inject: `["tools","fs","systemPrompt"]` | 文件工具 |
   | `dsh-tool-bash` | 命名空间 | inject: `["tools","shell","systemPrompt","shellEnv"]` | 终端工具 |
   | ~~`dsh-fs`~~ / ~~`dsh-shell`~~ / ~~`dsh-subprocess`~~ | **抽象基类** | **不要挂** | 会占住服务名 |

   **规律三（同线包的额外要求）**：`dsh-persona` / `dsh-agent-instructions` / `dsh-tool-fs-search`
   有 **required config 字段**，不给就报 **`invalid config:`（错误详情为空！）**。
   必须内省 `m.Config.dict` 才知道缺什么：`persona.prefix`、`agent-instructions.maxBytes`、
   `tool-fs-search.sampleOverCapGlobResults`。

   **验收动作**：跑完第一轮必须打印**请求头里的 `tools[]`**（工具清单是唯一可见性来源），
   并断言文件类（`read|write|edit|list|glob|grep`）与终端类工具存在。
   ⚠️ 工具**出现**只证明注册成功，**不证明可用**——上面那层接口不匹配时工具照样出现在清单里。
   最终验收是**目标仓库真的出现文件**。
4. **`dsh-argp/lib/log-access.js` 不在包的 `exports` 面里** → harness 取事件要在本地内联
   `session.snapshotEvents()`（或加一等公民导出）。
5. **凭证：本地无鉴权端点仍必须给凭据——保留 `apiKeyEnv` 引用 + 进程内设哑值。**
   pi-ai 对**手工路由**（非目录路由）强制要求凭据，两条失败路径要分清：
   - **写了 `apiKeyEnv` 但解析不到** → `dsh-llm-pi-ai` 的 seam 抛 `MISSING_CREDENTIAL`
     （`ctx.get('credentials')` 不存在时 fallback `launchEnvironmentOf(ctx).get(ref)`，
     而 `dsh-credentials-local` 不在 0.1.5-rc.1 树里）
   - **省略 `apiKeyEnv`** → seam 不抛错，但 pi-ai 自己抛 **`PI_AI_ERROR` "No API key for
     provider: local"**（在 `assistant/attempt` 的 stream 里，`turn/end.reason.kind = 'error'`）
   **正解**：`apiKeyEnv: 'ARGP_LOCAL_KEY'` + `process.env['ARGP_LOCAL_KEY'] = 'local-no-auth'`。
   依据：`launchEnvironmentOf(ctx)` = `ctx.get('launchEnvironment') ?? createLaunchEnvironmentSnapshot([{source:'process', values: process.env}])`
   —— **无 launchEnvironment 服务时直接读 `process.env`**。宿主 `settings.yaml` 用
   `apiKeyEnv: LOCALHOST_API_KEY`（宿主有 credentials 服务），**harness 不能照抄那行**。
6. **失败轮会被误报成 ok。** `await agent.whenIdle()` 只说明 agent 静下来了——**无凭证 / 400 /
   截断同样是 idle**。turn 的真实结果在 `turn/end.data.reason.kind`（`'error'` = 失败）。
   只判 `whenIdle` 会把失败记成 `ok:true`（已踩）。失败后应 **break**，后续轮次无观测价值。
7. **进程跑完不退出。** `await ctx.fiber.dispose()` 之后仍有存活 handle（driver 定时器等）→
   实测挂 7min+ 且不报错、无输出。收尾必须显式 `process.exit(0)`。
8. **窗口核验：不要读 `engine.windowTokens` 字段——那是假的。**
   它是**构造函数里的 fallback 静态默认**（`16_384`），运行时真值由
   `resolveScaledBudgets(agent)` 从适配器声明的 `contextWindow × windowRatio` 解析，
   且**必须等首个 `request/context` 落账之后**才有值。
   读字段会得到"config 未生效"的**假警报**（已踩）。
   **正确做法**：turn 循环结束后调 `engine.resolveScaledBudgets({ session, options:{ provider, model } })`
   （TS private，运行时仍在），拿 `{ windowTokens, retainTokens, declaredKnown }`；
   `declaredKnown=false` 表示声明窗口未知 → **压力检查会被跳过**（引擎刻意"宁缺勿错"）。
   **反推校验**：若 `windowTokens` 真是 16384，则 usage 序列里 `inputTokens` 一到 17K 就该触发压缩——
   没触发即证明解析值远大于它。
9. **超时 ≠ 未完成：用"目标仓库 HEAD 是否变化"判定，别一刀切停机。**
   任务书是**连续依赖**的（T3 依赖 T2 的实体基类），所以停止条件是三态而非二态：

   | 状态 | 判据 | 动作 |
   |---|---|---|
   | `idle` | `whenIdle()` 在 timeout 内 resolve + `turn/end.reason.kind !== 'error'` | 继续 |
   | `failed` | `turn/end.reason.kind === 'error'`（无凭证 / 400 / 截断） | **停** |
   | `timeout` 且**无新提交** | `!idle` + `git rev-parse HEAD` 未变 | **停**（叠加下一轮会建在不存在的产物上） |
   | `timeout` 但**已提交** | `!idle` + HEAD 变了 | **继续**（实测 T2：600s 超时，但已完成并提交 `feat: 实体抽象 + 空间分区`） |

   **只看 `whenIdle()` 会把 T2 这种"超时但完成"轮误记成失败**（已踩）。实测**本地 27B 单轮约 10 分钟**，
   timeout 默认放宽到 **20 分钟**。另注意 `whenIdle()` 返回 true 只说明"静下来了"——
   失败同样是 idle，必须靠 `turn/end.reason.kind` 才能与超时区分。
10. **`--out` 的相对路径必须在 `chdir(REPO)` 之前解析成绝对路径。**
    `main()` 开头会 `process.chdir(REPO)`，此后相对路径按**目标仓库**解析 ——
    实测把冒烟产物写进了 `vs-corpus/spike-out/`（**污染语料仓库**，且它是 gitignored 盲区，
    只看 `git status` 不一定及时发现）。正解：`path.resolve(import.meta.dirname, argv('--out','spike-out'))`
    （`path.resolve(dir, abs)` 对绝对入参原样返回，显式传绝对路径仍正确）。
11. **每轮增量落盘（`dumpLive`）。** 只在进程结束 dump 会把 22 轮 ≈7h 的风险全押在"不崩"上。
    每轮写一份 `pilot-live.jsonl`（全量事件）+ `pilot-live.meta.json`（含 `turnLog`），
    崩溃/手工终止后至少拿到到那轮为止的语料。**这条同时给出了"多跑几轮"的底气**：
    可以 `--turns 8` 先超量起跑，一旦 `compaction/*` 出现就终止，不必为"怕少跑"而重跑整段。

### 11.6 ⚠️ 22 轮必须在**同一个连续 session** 内完成（探针设计的硬约束）

**这是决定"能不能中途续跑"的前提，跑批排期前必须先认清。**

`corpus-run-taskbook-vs.md` §4 的五个探针里，**P3（T19）的源原子落在 T1/T4/T6/T9，
P4（T20）的源原子落在 T2**（"这条**只能**从 T2 的内容回答 —— 是四个探针里源原子最老的一个"）。
→ 若 session 从 T3 起跑，**T1/T2 的原子根本不在场**，P3/P4 失去源 → 探针失效 → 语料只能做
描述性统计，不能支撑"压缩是否丢东西"的结论（违反 §0 的五条之一）。

**推论（三条，都已实测确认）**：

1. **不能中途换进程续跑。** harness 每进程建全新 in-memory session（`SessionId('corpus-vs-a2-pilot')`
   固定，但 `dsh-session-persistence` **未挂**）→ 上一轮的 T1–T3 事件**只在内存里**，
   靠 harness 结尾自己 dump 成 jsonl；**事后无法续载**。
2. **`AgentLoop.resume(ownerCtx, { resumeSessionId, agentOptions })` 是官方续载入口**
   （`dsh-agent` 的 `ResumeAgentOptions`；声明式配置面另有 `resumeSessionId`），
   但要挂**具体持久化后端**才行。
3. **持久化后端：可以接，且已选定 `-jsonl`。** ⚠️ **本节初版结论是错的，此处更正**。
   初版写"后端都在 `0.0.1-rc.1` 线、与 `0.1.5-rc.1` 不满足 → 现在不接"——
   **错因：只看了 `latest` dist-tag，没列全 `versions`**（`latest` 是 `0.0.1-rc.1`，属于历史错线）。
   **这正是 §11.4 已经记过的同一个坑，同日又踩了一次。**

   实测（`npm view <pkg> versions` 列全）：

   | 后端 | 有无 `0.1.5-rc.1` | 结论 |
   |---|---|---|
   | `dsh-session-persistence-jsonl` | ✅ **有**（也有 `0.1.5-rc.2` / `0.1.6-alpha.1`） | **采用** |
   | `dsh-session-persistence-sqlite` | ❌ 最高 `0.1.2-alpha.2`（`latest` 也是 `0.0.1-rc.1`） | 不采用 |

   `jsonl@0.1.5-rc.1` 的 peerDeps = `dsh-session ^0.1.5-rc.1` / `dsh-session-persistence ^0.1.5-rc.1` /
   `cordis ^4.0.2` —— **与 harness 全树完全对齐，零 peer 冲突**。

   **接入形状（已内省确认）**：**类默认导出**（`JsonlSessionPersistence`）、**无 `static inject`**；
   `Config = { root: string（必填）, compression?: 'zstd'|'none'（缺省 zstd） }`。
   注册为 `ctx.sessionPersistence`；**必须在 `agentLoop.create()/resume()` 之前挂**
   （create 时才读 `ctx.get('sessionPersistence')`，挂晚了本次不落盘**且不报错**）。
   缺省 zstd → 落 `session.v3.jsonl.zstd` = **生产同格式** → `spike43` / `spike/lib/session-corpus.ts`
   可直接读，语料也与真实 session 可比。含 `win32.d.ts`，Windows 有专门处理。

   **原生依赖风险已排除**：依赖含 `koffi@^3.1.0` + `@deepseek-ai/node-addon-system`，
   独立目录实测 `npm i` 17s 装成、`require('koffi')` 加载正常（v3.3.0，**自带预编译，无需构建工具**）。

   **落盘位置**：harness 用独立 root（默认 `~/.dsh/sessions-corpus`），
   **刻意不复用** `~/.dsh/sessions` —— 既避免污染真实会话目录，也避免被 spike41 的考古扫描误收。

   **接上之后必须补的 harness 能力**（否则续跑会重复驱动）：`--resume <sessionId>` +
   `--skip <n>`（跳过已完成的**前导轮数**，因为 turn 循环从 `TASK_BOOK[0]` 起）。
   注意 API 形状**不对称**：`create()` 返回 `Agent`，`resume(ownerCtx, {resumeSessionId, agentOptions})`
   返回 **`AgentHandle { agent, dispose }`**。

   → **本节结论改为：22 轮长跑接持久化，按"可续的分段进程"排期**；
   `dumpLive`（§11.4 第 11 条）作为**第二道保险**保留（持久化只保到"最后一次 flush"，
   进程被强杀时的尾部事件仍靠它兜住）。

**对已跑过的 T1–T3 小样的处置**：该 session 不可续载，且其 `pilot-run.json` 是**三态修正前**
的产物（`turnLog` 缺 `status`/`committed`/`headAfter`；`turn/end` 只有 2 条而 `turn/start` 3 条
→ **T3 是被 600s 超时打断的，不是"完成"，四步里只做了第 1 步**）。
→ 保留为**预演记录**，不作为正式语料；正式跑批从基线（`9bd0c32`）**整体重跑**。
（`pilot-run.json` 的三态修正前产物**不要**与修正后的判读混用。）

### 11.5 声明窗口与真实上限必须成对（反直觉，勿单独"修正"）

服务端 `max_model_len = 174080`，而声明 `contextWindow = 262144`（**大 51%**）。推演：

- 缺省 `windowRatio 0.8` → 触发线 209715 **> 真实上限** → 必然一串 400；
- 把声明**改成真实的 174080** → pi-ai 膨胀估算（≈1.65×）下 `110K×1.65 + 32768 > 174080`
  → **钳到 1 → 死循环**（就是之前修过的坑）；
- 当前组合：单请求峰值 = 触发线 100007 + O(10K) + maxTokens 32768 = **142,775**，余量 **31,305**。

→ **262144 的声明是被 pi-ai 膨胀"保护"着的（防钳制）；真实上限由 100K 触发线兜住。两者必须成对。**
⚠️ usage 字段名分两层：原始 API = `prompt_tokens`；session 日志 = `inputTokens`。

### 11.7 ⚠️ `thinkingFormat: 'qwen'` 关不掉思考 → 轮次空转（T1–T8 实测，正式跑批的真阻塞项）

**症状**：T1–T8 跑批里 **T5、T8 两轮（25%）零产出**——轮内事件只有
`step/start → assistant/message → step/end → turn/end`，**没有任何 tool call**，
assistant 内容只有 `[reasoning]`（无 `text`），`outputTokens = 32768` = **正好撞 maxTokens 上限**。
即：**模型把整个输出预算烧在 reasoning 块里，还没吐出可执行内容就被截断**。

**根因（三层，逐层实测/读源钉死）**：

1. **vLLM 只认 `chat_template_kwargs.enable_thinking`，顶层 `enable_thinking` 被**静默忽略**
   （`probe-think2.mjs` 实测：顶层形式烧光 3000 tok、`content` 只有 2 字符 `""`；
   嵌套形式 `finish=stop`、正文 4690 字符、reasoning=0）。
2. **pi-ai 的 `thinkingFormat:'qwen'` 分支发的恰是顶层形式**
   （`openai-completions.js` qwen 分支：`params.enable_thinking = !!options?.reasoningEffort`）；
   `'qwen-chat-template'` 分支才发嵌套形式（`chat_template_kwargs:{enable_thinking, preserve_thinking:true}`）。
3. **`reasoningEffort:'off'` 在 pi-ai 内被解析成 `undefined`**
   （`openai-completions.js:540`：`clampedReasoning === "off" ? undefined : clampedReasoning`；
   上游 `dsh-llm-pi-ai` 的 `profileOptions` 对 `'off'` 直接略去该键）→
   `!!undefined = false` ✓ 嵌套形式能正确发 `enable_thinking:false`。

**修法（harness 已改）**：`compat: { thinkingFormat: 'qwen-chat-template' }`。
**注意两条反直觉的坑**：
- `reasoningEfforts` **不能**改成 `false`（"非推理模型"）——那会让 `model.reasoning=false`
  （`dsh-llm-pi-ai/lib/index.js:565`），`qwen-chat-template` 分支的 `&& model.reasoning` 守卫
  直接不触发 → 又回到什么都不发 → 思考默认开。保留 `{ off:'false', high:'true' }` 才能让
  `model.reasoning=true`（`:582`）。
- `reasoningEfforts.off` 的线值 `'false'` **不会被发出**（'off' 在 pi-ai 内变 undefined），
  所以即使 vLLM 的 `reasoning_effort` 合法值只有 `none/minimal/low/medium/high/xhigh/max`
  （发 `'false'` 会 400），也不会踩到。

**对生产的影响（已实测修正，2026-09-16）**：`~/.dsh/settings.yaml` 的 `Qwen3.8-27B` 没有声明
`thinkingFormat` → 走自动探测落 `'openai'`（effort undefined 时**什么都不发**）→ 理论上同样暴露给
服务端默认思考。但**扫 4 份真实 session（351 条 assistant）实测：0 条"reasoning-only 撞输出上限"轮**
（仅 4 条纯 reasoning 但未撞上限、未成整轮空转）→ **生产未因此 bug 失血**，与 harness 的
T5/T8（2/8 轮、out=32768 撞顶）**不同病**。为何同为"默认思考开"两端表现不同，机制未闭环
（疑与生产请求带 `reasoning_effort` 字段 / 模型档位选择有关），但**不影响语料侧修复成立**。
给生产加 `compat: {thinkingFormat: 'qwen-chat-template'}` 或直接在**模型服务端**配默认
`enable_thinking=false`（probe 已证本服务端**接受** `chat_template_kwargs`），是把"关思考"
做在宿主层的两条正路——是否做、在哪层做，属独立决策。

**对语料的影响（必须记录）**：T5 的活在 T6 被自然补上并提交（`092536a` 含三武器+弹道+结算），
**T8 的活（升级与三选一）因是最后一轮而永远没做** → 这份 T1–T8 语料的**有效工作量是 6/8 轮**，
spike43 的 A1/B3 FAIL 里有一部分要归因于它。**正式 22 轮跑批必须先落此修复**，
否则按 25% 空转率，探针轮（P1–P5）很可能撞上 → 语料作废。

**旁证（同型失败）**：`probe-think2` 的 [A] 顶层形式在 `max_tokens=3000` 下也是
`content=2ch`（`""`）——与 T5/T8 的 32768 全烧完全同型，可复现、可归因。

### 11.8 ⚠️ run1 撞穿服务端真实上限：轮内无界增长 × 测量失准 × 墓碑不可再剪（引擎缺陷，已立卷待修）

**症状**（2026-09-16 正式跑批 run1）：T1–T15 全绿后 **T16 轮末 overflow 恢复环耗尽**
（agent 抛死，17 文件留工作树），**T17 首发即 400**：
`141,313 input + 32,768 output = 174,081 > max_model_len 174,080`——**超 1 个 token 撞墙**。
resume 后 `--precompact` 报 `pruned=0`：可剪的早已剪光，剩余全是"结构性不可剪"。

**根因（三条叠加，各有代码/事件证据）**：

1. **`pruneIntervals` 的 `[elided …]` 墓碑自身永不参剪**
   （`argp-graph-engine.ts:2526` 生成的是普通 user 消息、无 `sourceSeq` → `atomize` 走
   "普通 U"分支 → ask-exempt 不命中）。碎片化阶段一次事务注 789 条 × ~130 字符 →
   **压缩在"释放旧内容"与"注入回执"之间净收益衰减**（run1 后段实测每次压缩注入量 ≈ 释放量的 55%）。
   ⚠️ 初版法证曾误判为"墓碑在 surface 投影里累积"——**错**；墓碑 seq 被后续 replace 折叠，
   问题不是"累积"而是"回执注入量挤占净收益"。留此更正防后人再误。
2. **`turnGuard=1`（缺省）→ 当前轮原子全部不参剪** → 重轮（T16 实测 ~135 步 / ~2000 调用）
   **轮内 surface 无界增长**；`windowTokens` 门的是"下次请求的 prompt"，**挡不住轮内**。
   ⚠️ **勘误（2026-09-16 晚）**："挡不住轮内"表述有误——`agent/pre-step` 钩子（
   `argp-graph-engine.ts`，注册于 mount）**每个 step（=每次 LLM 请求前）都在跑** `compactIfNeeded('pressure')`，
   轮内检查本就存在且确实在触发（run2 日志 T16 段每步 compaction 事件可证）。真正的问题是
   **查了但剪不动**：原因 1 的墓碑地板 + 本条的当轮豁免 + 原因 3 的低估，三者合起来让每次
   step 边界的压力检查空转。步与步之间只隔一次增量（一次应答 + 其工具结果），量级通常远小于
   触发线→硬墙的余量——**单次跑穿的通道不是步增量，而是原因 3 的系统性低估**：
   run1 T17 估 ~52K vs 真实 141K，每次 pre-step 检查都"合格放行"，攒到 provider 才爆。
3. **`charsPerToken=3.5` 按拉丁文校准 → 中英混排系统性低估 2.7×**
   （alive 182,258 chars：引擎估 ~52K，vLLM 实数 141,313）→ 触发线对真实窗口失去约束力。

**语料侧绕过（run2 起，均为已暴露的旋钮、不改引擎）**：
`charsPerToken: 2.0`（校准实锚 1.3–1.5 偏保守）+ `turnGuard: 0`（允许剪当轮旧原子，
`recencyGuard=10` 仍保底）+ `windowRatio: 0.30`（触发 78,643，给轮内增量 + 32,768 留真实余量）。
**对照臂必须同旋钮**，否则 A/B 差值不可归因。

**旋钮不能救地板（2026-09-16 run2 T16 实测，本条修正上文根因 1 的"不是累积"判断）**：
run2 换旋钮后仍在 T16 首发 `CONTEXT_WINDOW_EXCEEDED`，**错误数字 `141,313+32,768>174,080`
与 run1 T17 分毫不差**（两臂独立复现）。对 run2 明文 dump 重放 surface 投影实测：
**1297/1310 节点是墓碑、284,786 chars（≈142K tok）、最长连续段 1295**。
→ 墓碑地板**确实是累积**（非"仅回执注入挤占净收益"）；旋钮只改触发频率，挡不住单调增长，
且压缩更频繁反而令地板爬升更快（run2 15 轮到 135K，早于 run1 的 16 轮）。**引擎必须修**。

### 11.8.1 ✅ 修复①（tombstone-merge）已实现 + 端到端验证（v1.2.x，2026-09-16）

**代码落点**（`argp-graph-engine.ts`）：
- `isMergeableTombstone(text)`（导出纯函数）：仅认引擎自身墓碑——`[elided` 开头 +
  含 `pruned by ARGP` + 含 `recall_pruned`。宿主 system-reminder / 官方 checkpoint /
  tool 占位墓碑（`[elided: …`，缺 `pruned by ARGP`）一律不合并。
- `consolidateTombstones(session)`（私有）：扫 surface 找第一段 ≥`tombstoneMergeMinRun`
  的连续墓碑，校验事务边界 tool-pairing 平衡后，复用 `pruneIntervals` 骨架一笔事务
  replace 成单条聚合墓碑（`[elided consolidated ×N seqs=A..B …`——**保持可再归并形态**，
  地板随压缩轮次收敛到常数）；失败非致命（try/catch，回退由 overflow 三步序列兜底）。
- 挂点：`compactIfNeeded` 在 `atomize/buildGraph` **之前**调用（压力门槛之后，
  低频路径，不拖慢热路径）。图剪部分若因归并已降到 retain 内 → 返回 NULL（正常）。
- 旋钮 `tombstoneMergeMinRun`（默认 8，**0 = 关闭**，对照臂 A/B 用）。

**测试**（`test/argp-graph-engine.test.ts` +4，全套件 237/237 绿）：判据 5 形态、10 连碑归并成
1、`minRun=0` 关闭不动。

**端到端实测**（run2 T16，resume5，改后 `npm run build` 生效）：归并事务落盘，
聚合墓碑 `[elided consolidated ×1294 seqs=76042..77828]`（**一条 192 字符**顶掉 1294 条碑），
归并 summary 落账；重放投影核对当前 surface → 仅 6 条 elided / 1,459 chars（**地板从 ~142K tok
塌到 <1K tok**）；T16 正常推进、日志无 `CONTEXT_WINDOW_EXCEEDED`（此前此时早已 400）。

**待修候选（后续）**：② `charsPerToken` 按内容 CJK 占比自适应（仍是真缺口）。
③"轮内 step 边界压力检查"经代码核实**本已存在**（`agent/pre-step` 钩子每步跑
`compactIfNeeded('pressure')`，见上文勘误），从候选清单移除——run1/run2 的真实缺口是
①（地板）+ ③的"剪不动"部分（现由 tombstone-merge 修复）+ turnGuard 豁免（语料侧已置 0）。
run1 坏 session（`sessions-corpus/_no-cwd/formal-t22/`）+ run2 T16 dump = **缺陷复现证据**，
保留不删，spike43 可直接审。

**harness 新增开关（同日）**：`--precompact on|auto|off`（resume 时先跑一次
`compactIfNeeded(agent,'context-overflow')` 强制压——overflow 触发无视 declaredKnown/threshold
两道门，是唯一能主动打回地板的公开入口）；带诊断打印 surface/atoms/measurement/lastRealPromptTokens。

### 11.9 对照臂（组件 A off）跑批结论：**N=1 被混淆项吃掉，测不出驱逐代价**（2026-09-16）

**设置**：`--arm off --session-id formal-t22-off`（`run.ts` 新旋钮 `disableInferredEdges: ARM==='off'`，
**其余旋钮与 ON 臂全同**、同一份修好 tombstone-merge 的 lib 构建）；目标仓库另起独立克隆
`vs-corpus`（重置到基线 `9bd0c32`、删 origin remote + 全部 remote-tracking refs 防未来历史泄漏；
ON 完成态归档 `vs-corpus-on`）。两臂各 22 轮 + 各自瞬断续跑。

**能下的硬结论**：
1. **修复引擎跨两臂稳定**：两臂全程 prompt 峰值 70–81.5K（触发线 78.6K 附近），零撞墙；
   spike43 **两臂全部验收项通过**（ON 39578/1414 原子、OFF 7080 去重 seq/1965 原子）。
2. **探针三态两臂全"回读"**（ON/OFF 的 T19/T20/T22 答对前都先 read/grep/recall）
   → 对这些探针常量，组件 A 也没能保护到留在 live context（与 spike41"推断边判别力弱"吻合）。

**段级 C1（各自 T16 锚→末尾，同为修复态、无撞墙）——结果反直觉但不可采信**：

| | ON（A开）| OFF（A关）|
|---|---|---|
| 驱逐 seq | 1263 | 825 |
| 涉及路径 / 重读 | 28 / **100%** | 19 / **63.2%** |
| 碑后重读 seq | 250 | 36 |
| 恢复调用 | `recall_pruned×1` | `recall×3 / list_pruned×1 / recall_pruned×2` |
| 段内 steps / tool 调用 | **205 / 213** | **103 / 103** |

表面像"A 反而更糟"（ON 驱逐更多、重读率更高），实为**假信号**，三个混淆项：
- **工作量不等（致命）**：ON 段步数/调用数是 OFF 的 ~2× → C1 的重读率/驱逐量/碑后重读数
  **全随总内容量单调涨**，100% vs 63% 被"谁活多"支配，不反映保护效果。
- **两臂仓库已分叉**：同 T16 prompt，ON 面对 `e8eaa1e`（含 T15 修复的 affix bug），
  OFF 面对 `c9eda79`（OFF 自身演化线）。模型非确定性 → 在做**不同代码库上的不同 bug**。
- ON 段起点带 pre-fix 聚合碑基线（`×1294`），OFF 干净起步。

**要真正量组件 A 驱逐代价，须其一**：① 每臂 3–5 seed 取 C1 分布做差（对非确定性建模）；
② record-replay 固定 agent 轨迹、只切引擎开关。

**附带 harness bug（同日已修）**：`pilot-t{N}.jsonl` 等产物按固定名落盘 → OFF 跑完
**覆盖了 ON 臂明文 dump**（明文丢；spike43 与段级 C1 全读权威 `.zstd`，结论无损）。
已改为**会话前缀隔离**：产物统一 `${ART}-pilot-*`（`ART` = resume-id 或 session-id 净化后），
多臂/多次跑批共用 OUT 不再互相踩踏。两臂 zstd session 与 run1 坏 session 全部保留不删。

### 11.10 官方重跑整批作废：**两臂写进同一个仓库**（2026-09-17，事故 + 护栏）

**背景**：对齐 `0.1.6-alpha.1` + 发布 `dsh-argp@1.2.0` 后，用**分发物**重跑两臂（22 轮 × 2），
会话 `official-t22-on` / `official-t22-off`。

**症状**：ON 臂 **17 轮全部 `无新提交`**（`head=9bd0c32` 纹丝不动），而它的目标仓库
`vs-corpus-on` 里始终只有 180 字节 README；OFF 臂却每轮正常提交。

**根因链**（三层叠加，任一层设防都不会出事）：

1. `run.ts` 的 `--repo` **只做两件事**：`process.chdir(REPO)` + 以 `cwd: REPO` 读 `git rev-parse`。
   它**不替换注入 prompt 里的路径** —— 注入是 `agent.followup(text: t.prompt)`，逐字。
2. 任务书 `corpus-run-taskbook-vs.md:100` 把目标仓库**逐字写死**：
   `在 C:\workspace\Project\vs-corpus 里从零做一个 Canvas 2D 的"吸血鬼幸存者"类游戏。`
3. 于是 ON 臂（`--repo …/vs-corpus-on`）的 agent 照 prompt 里的绝对路径行事，把工程**全写进了
   `vs-corpus`**。实测该会话工具目标分布：

   | 会话 | write | edit | read | bash |
   |---|---|---|---|---|
   | `official-t22-on` | OFF 仓 **76** | OFF 仓 **126** | OFF 仓 **64** | OFF 仓 **163** |
   | ↳ 指向 `vs-corpus-on` | **0** | **0** | **0** | **0** |

**雪上加霜：两臂在同一仓库上交替续跑且零重置**。六个进程段依次是
ON r1 `09:21→10:16`、OFF r1 `10:18→11:33`、ON r2 `11:33→11:55`、OFF r2 `11:55→12:09`、
ON r3 `12:09→12:36`、OFF r3 `12:36→12:55`。`vs-corpus` 的提交时间线正好印证交错：
`09:26–10:12`=ON r1 的 T3–T11 → `10:18` `reset to minimal skeleton`=OFF r1 的 T1（**直接压在
ON 的 T11 状态上**）→ `10:21–11:31`=OFF r1 的 T2–T12 → `11:47/11:52`=ON r2 的 T13/T14 →
`11:59/12:07`=OFF r2 的 T14/T15 → `12:16/12:33`=ON r3 的 T15/T16 → `12:46/12:52`=OFF r3 的 T16/T17。

**结论**：两臂既不共享基线、也不物理隔离 —— 这正是 §11.9 已记为"致命混淆项"的坑，这次更极端
（那次至少是各自演化线，这次是互相覆盖）。**整批数据不可归因，作废**。产物保留为失败证据：
`spike-out/official-t22-{on,off}-pilot-*.jsonl`、`harness/.tmp/official-*.log`、归档目录
`vs-corpus-invalid-20260917`（45 提交 / 6 脏文件）。

**重做方案（用户 2026-09-17 拍板："换仓隔离"）**：两臂**都用任务书里的字面路径**跑，prompt 一字不改
（放弃 `--repo` 的"多仓"用法），臂间靠**目录改名归档 + 从基线重建**实现物理隔离：

```
C:\workspace\Project\
  vs-corpus                  工作仓（每臂开跑前 = 基线）
  vs-corpus-baseline         基线模板（单提交 9bd0c32 / 零 remote / 零 tag），重建用
  vs-corpus-on               ON 臂跑完的归档
  vs-corpus-off              OFF 臂跑完的归档
  vs-corpus-invalid-20260917 本次作废批次的归档（证据）
  vs-corpus-on-run1-archive  run1（§11.9）ON 归档
```

- 基线**必须从基线树重建**，不能 `git clone`：实测 clone 会带过来归档仓的 `refs/tags/pilot-t2`
  → 历史泄漏。重建命令（`git init` + 从源仓 `git archive 9bd0c32` 解包 + 同 author/date 提交）
  产出的 SHA 与 `9bd0c32` 逐位一致。
- 臂间切换：`mv vs-corpus vs-corpus-on` → `cp -r vs-corpus-baseline vs-corpus`。

**harness 新增护栏（同日落地，见 `run.ts`）**：把这类事故压成"启动即失败/首轮即失败"，
而不是跑满 7 小时才发现。

| 护栏 | 时机 | 判据 | 失败动作 |
|---|---|---|---|
| **G1** | 启动、**chdir 之前** | 任务书首轮 prompt 里写死的目标仓库 == `resolve(--repo)` | `exit(1)` + 打印正确做法 |
| **G2** | 启动、非 resume | 仓库 HEAD 在基线 `9bd0c32` 上 ∧ 历史恰 1 个提交 ∧ 无分支外 ref ∧ 工作树干净 | `exit(1)` + 打印重建命令 |
| **G3a** | 每轮结束 | 本轮新增 `tool/call` 的 `file_path` **全部**落在 `REPO` 内 | `exit(1)` |
| **G3** | 每轮结束 | 连续 2 轮**应产出**轮次"零产出"（HEAD 未动 ∧ 工作树为空）。**纯探针轮 `[探针]` 对计数透明** | `dumpLive` 后中止，收尾 `exit(2)` |

G1 之所以放在 chdir 之前：否则 `--repo` 指向不存在目录时会先炸 `ENOENT`，报出的是症状不是病因。

**G3a 的坑（同日踩到）**：`agent` 在 bash 里最常用 **Git-Bash/MSYS 形式** `/c/workspace/Project/vs-corpus/…`，
而 `path.resolve('/c/foo')` 在 Windows 上解析成**当前盘根的 `\c\foo`**（完全不同的位置）→ 不做归一化
就把合法写入误判成"越界"（首次启用护栏时 T1 被误杀）。归一化必须含：`/c/x` → `C:/x`，再统一小写、
反斜杠转正斜杠。回归用例见 `harness/.tmp/normpath-test.mjs`（8 例：MSYS/反斜杠/正斜杠/仓库根/相对路径
/另一仓/前缀陷阱 `vs-corpus2`/完全无关目录）。

**G3 的坑（同日踩到，ON 臂 r3 实测）**：G3 的原始判据是**假设"每一轮都必须落代码"**——但任务书里有
**纯探针轮**（tag `[探针]`，T19/T20/T22），它们**按设计只做观测/回溯、不写任何文件**。于是
T19(244s) + T20(93s) 两个**相邻**探针轮天然"零产出" → **必然误杀**：`exit(2)`，白丢 T21/T22。
（当时还伴随一条**归因错误**的提示语：把"探针轮不提交"报成了"语料写到了别的仓库"。事故形态与正常形态
在此**判据重合**，护栏自己分不开。）

修法：**按 tag 分类，而不是按"是否提交"猜**。
- `taskbook.ts` 在解析时把标题行里的 `` `[...]` `` 标记**抓进 `tags` 字段**再剥离 —— 必须在剥离前抓，
  因为 `title` 会把标记清掉，事后无法从 title 反查（第一版按 `title` 判，**一个都匹配不上**）；
- 导出 `isProbeOnlyTurn(t)`：`tags` 含 `探针` **且不含** `探针-…` → 纯探针轮。**`探针-功能型` 不算**
  （T14/T18 那种要求真的产出功能代码，仍是"应产出"轮）；
- G3 计数里纯探针轮**透明**（既不加也不清零），并在日志里显式打印该轮被豁免，便于对账。
  加载任务书时也列出全部纯探针轮（`[taskbook] 纯探针轮 …: T19 T20 T22`）。

**教训（比补丁更重要）**：护栏的判据必须**来自任务书的显式意图**，不能从"看起来没干活"反推 ——
否则正常形态（探针轮）会被当成事故形态。凡是"零产出即异常"这类启发式，都要先问一句
**"任务书里有没有合法的零产出轮？"**

**同时补挂官方传输层重试**：`@deepseek-ai/dsh-llm-retry` 是**官方 `dsh-base` bundle 的宿主平面成员**
（`packages/bundle/base/cordis.patch.yml` 的 insert `- id: llm-retry`），**不在** `standard-argp` /
`corpus-vs-a2` 的 agent 平面 preset 里 —— 所以只照 preset 摘插件的 harness 必然漏挂它。补上**是回归
官方，不是偏离**。它是失败轮 `TRANSPORT` 的官方解；

**⚠️ 根因订正（2026-09-17 16:41，用户通报）**：此前把 `TRANSPORT` 记为"客户端 keep-alive 死 socket
（undici ↔ uvicorn 5s 空闲关闭竞态）"，**该假设撤回**。真实病因是**显存驱逐 → 模型重载的死循环**：
vLLM 容器在 VRAM 被驱逐后进入"驱逐→重载→再驱逐"的循环，端点**连续数分钟不接受请求**（TCP 仍
accept，HTTP 返回空响应 —— 实测 `curl -v` 报 `Empty reply from server`）。证据链：`podman inspect`
显示 `Created` 与 `Started` **同一秒**（16:33:23）= 容器是被销毁重建的（`RestartCount=0`、
`Policy=no`、`ExitCode=0`，排除崩溃自愈）。

**性质：一次性人为事件，非系统性缺陷**（用户 2026-09-17 16:45 通报）—— 触发条件是**运维侧在调试
硬件**（当时 GPU 侧 `VRAM 34.2 GB 总 / 31.98 GB 已用`，余量仅 ~2.2 GB，任何额外申请都会引发驱逐）。
**故不在 harness 侧加防**（不做赛前探活、不放宽重试预算）—— 针对一次性人为事件的加固会把 harness
复杂化，且这类中断 harness 本来就无法预防。此前"有复发土壤"的推断作废。

**但要记住的推论**：默认重试预算（5 次 / 初始 500ms / 上限 10s ≈ 覆盖 16s）**扛不住分钟级重载窗口**
——实测 T13 用满 `llm/retry:7` 仍失败。因此**任何合理重试预算都不能替代 resume**；retry 的价值在于
吞掉秒级抖动，分钟级中断的唯一恢复路径是 `--resume --skip N`（本次 T13 即如此恢复，重驱动 146s 完成）。
挂载后校验：不在 `mounted` 列表就 `exit(1)`（插件"挂载成功"≠"生效"，inject 不满足会静默 skipped）。

**轮超时（`--turn-timeout-ms`）默认 1200000 偏紧**：T1–T12 一气跑完（最长 641s）后，T13（BOSS）在
1200s 被截断 —— 不是卡死，它已完成 12 步（写出 4 个新文件 + 改 2 处），卡在第 13 步验证。本地 27B
生成大段文件写入均摊 **~92s/步**，T13/T16 这类"长写入轮"会顶到上限。**重跑统一用
`--turn-timeout-ms 2400000`（40 min）**，两臂一致；已在前 12 轮跑完的段不因此重跑（那 12 轮没有一轮
接近 1200s，等价）。被截断轮的遗留文件若属"已完成但没来得及提交"，用 `--commit-pending on` 落袋后
`--resume --skip N` 重驱动（见 run.ts 该旋钮注释；审计时须把这类的"harness 现场恢复"提交与语料轮次提交区分开）。


### 11.11 官方配置重跑（换仓隔离版）两臂审计结论：**轨迹分叉 3.65×，C1 不可归因**（2026-09-17）

#### 批次规格（可比性前提已逐项核验）

| 项 | ON 臂 | OFF 臂 |
|---|---|---|
| session | `official-on3` | `official-off3` |
| 臂开关 | `disableInferredEdges: false` | `disableInferredEdges: true` |
| 会话产物 | `sessions-corpus/_no-cwd/official-on3/session.v3.jsonl.zstd`（2,241,772 B） | 同路径 `official-off3`（3,105,981 B） |
| 仓库 | `vs-corpus-on`（归档） | `vs-corpus-off`（归档） |
| 基线 | `9bd0c32`（单提交、零 remote、零 tag） | 同 |
| 窗口 | `windowTokens=100007 / retainTokens=20001` | **逐字相同** |
| 插件集 | 16 个（含官方 `llm-retry`） | **相同** |
| retryPolicy | `normal/maxRetries=5/[EMPTY_RESPONSE,RATE_LIMIT,SERVER,TIMEOUT,TRANSPORT]` | **相同** |
| 轮超时 | 2400000 ms | **相同** |

两臂都是 T1→T22 一气跑完（ON 因 G3 探针轮误杀分两次续跑，见 §11.10），均 `exit 0`。

#### 审计对照（`npm run spike43 -- <zstd>`）

| 指标 | ON | OFF | 比（OFF/ON） |
|---|---|---|---|
| turns | 24 | 22 | — |
| **原始写入 chars（≈tok）** | **341,329（≈97.5K）** | **1,245,131（≈355.8K）** | **3.65×** |
| atoms（数据原子） | 759（650） | 1097（717） | 1.45× |
| compaction/start | 38 | 38 | **1.00** |
| compaction/summary | 38 | 38 | **1.00** |
| compaction/prune 事件 | 3834 | 2432 | 0.63× |
| 被驱逐去重 seq | 4674 | 3769 | 0.81× |
| replace | 3837 | 2549 | 0.66× |
| cites 声明率 | 0.8%（5/628） | 2.1%（14/677） | 2.6× |
| 跨轮 handle | 157 | 259 | 1.65× |
| 承重 tool result（≥512 字符） | 230（145） | 279（218） | 1.21× |
| 推断边（**离线可推断量**，非引擎输出） | 115（单 token 85） | 432（单 token 298） | 3.76× |
| C1 被驱逐路径 → 被重读 | 18 → **17（94.4%）** | 47 → **38（80.9%）** | — |
| C1 有后续重读的被驱逐 seq | 239 | 317 | 1.33× |
| A1 volume（≥400K chars） | **FAIL** | PASS | — |
| A2/A3/B1–B4 | 全 PASS | 全 PASS | — |

#### 结论一：**单臂差值的符号都不一致 ⇒ 任何差值都不能归因于组件 A**

分歧不是"同向放大"而是**互相矛盾**：OFF 的原始内容 3.65× ON、tool/call 1.11× ON、
但 **ON 的 tool/result 事件 1.68× OFF**、prune/replace 反而更多；而**压缩次数两臂巧合地完全相等（38/38）**。
一个真实有因果的机制不会同时在多个量纲上给出相反符号。

这与既有纪律完全一致，并且**把混淆量级又抬高了一档**：§11.9 那轮是 2×（ON 段 205 步 vs OFF 段 103 步），
本轮是 **3.65×**。**方向还不稳定** —— §11.9 里 ON 步数更多，本轮 ON 步数更少（630 vs 677）。
⇒ **N=1 两臂做差在本场景下无判别力**，必须**每臂 3–5 个 seed 取分布**，
或 **record/replay 固定轨迹后只切开关**。C1 的 94.4% vs 80.9%、推断边 115 vs 432，**都不可作为组件 A 的效果证据**。

#### 结论二：组件 B（HLS repair）在两臂 **0 落盘**，且**不是配置问题**

两臂原始 jsonl 里 `[restored]` 尾注计数 **均为 0**（spike43 D1 亦报"无真实 HLS 落盘"）。
归因已排除配置侧：`compressor.ts:778` 是 `this.hlsMode = config.hlsMode ?? 'trailer'`（**默认即 trailer**），
`run.ts` 未覆盖该键 ⇒ 生效值确实是 `'trailer'`；且 `planReplacements` 确实被走到（有 3834/2549 次 replace）。
⇒ 唯一剩下的原因是 **"extract 缺 token 守卫"从未报警**（即 LLM 抽取始终保真，组件 B 无机会介入）。

**这是好消息也是坏消息**：组件 B 作为安全网从未需要部署（说明抽取保真度够）；
但**它的 ROI 分布无法从生产语料测出** —— 想要组件 B 的真实数据，只能**定向构造缺 token 场景**
（spike39 `HLS recovery` 的职责），不能指望跑批自发生成。

#### 结论三：这份语料能测什么（与 spike43 的判定一致）

- ✔ 组件 A 的**保护面/影响半径**（B2/B3/B4 达标：跨轮 handle 157/259、承重 tool result 充足、离线可推断边有量）
- ✔ **prune-then-reread 的操作性信号**（C1 有量），但**仅为上限**，必须对照组做差
- ✘ 组件 A **误连率（precision）**——需要真值标注，用 spike42
- ✘ 组件 B 的 **ROI 分布**——需定向构造（见上）
- ✘ **收敛/指纹回归**——需跨多轮压缩序列，单份 session 不够
- ⚠️ ON 臂 A1 volume **未达标**（341K < 400K chars）——按现有门槛这份 ON 语料**体量偏小**；
  OFF 臂达标。若下一轮要把 chars 拉到门槛以上，**按 §4 给任务书加"重构/扩展"轮**，不要在探针轮加量。

#### 提交噪声（对账规则）

任务书 §35 明确 **"无 git 提交要求（避免噪声）"**，所以**提交是 agent 自愿行为**，两臂粒度必然不同：
ON 臂每轮都提交（且单轮可产多提交，如 T7/T8 间的 `bb776d0`），OFF 臂 T1–T8 完全不提交、T9 才批量提交，
T15 之后又完全不提交（收尾遗留 15 个文件，用 `--commit-pending on` 补成一条
`chore(harness): …现场恢复，非语料轮次` 提交）。**⇒ 对账必须按提交信息映射，不能按提交数量**；
且**提交粒度差异不是臂效应**（任务书未要求提交，模型自发行为）。

#### 下一步（按优先级）

1. **每臂 3–5 seed**：现有 1 组只能证明"护栏与流程正确"，不能证明机制效果。
2. 或 **record/replay 固定轨迹只切开关**——同一轨迹下两臂内容量恒定，差值才可归因。
3. 组件 B 走 **spike39 定向构造**，不要等跑批自发。
4. 组件 A precision 走 **spike42**（需真值标注）。
