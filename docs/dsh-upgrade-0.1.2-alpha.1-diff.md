# dsh 升级 diff：0.1.1-rc.2 → 0.1.2-alpha.1

> 2026-08-30 记录。范围：核查 0.1.2-alpha.1（2026-08-27 发布）对 dsh-argp 1.0.0 依赖面（pin 0.1.1-rc.2）的影响，供 Discussion #2876 兼容声明使用。
> 方法：本地 deepseek-harness 快照的 git tag diff（`b150a551..cd5ef81481`，1079 commits，6421 文件），逐包核对 ARGP 实际 import 的符号。
> 注意：0.1.2-alpha.1 仅经 GitHub tag 发布，**未上 npm**（各 `@deepseek-ai/dsh-*` 包版本止步 0.1.1-rc.2），故 dsh-argp 的包引用无法指向该版本。

## 各包变动一览（ARGP 依赖面）

| 包（本地路径） | ARGP import 的符号 | src 变动 | 对 ARGP 影响 |
|---|---|---|---|
| `dsh-compaction`（compaction/compaction） | `CompactionEngine, CompactionId, compactCheckpointSource, toolPairingBalancedAfter/Before, CompactionAgentContext, CompactionResult, CompactionTrigger` | **零**（仅 README/package.json/一个 test） | **零影响**。CompactionEngine 契约在 rc.7→rc.8→rc.2→alpha.1 整条链上零改动 |
| `dsh-session`（core/session） | `Session, SessionEvent, deriveEventMessage` | 有（chunk-rows 打包编码增强、新增 `isChunkRow`/`chunkRowLength`、导出面**只增** `decodeSeqRanges/encodeSeqRanges`、`CallId→ToolCallId` 内部改名、sqlite schema v17→v19） | **零影响**。`deriveEventMessage`（surface.ts）未动；Session/SessionEvent 类型定义未动；变更全在存储编码与 persistence 层 |
| `dsh-llm`（llm/llm） | `createUserMessage, CONTEXT_WINDOW_EXCEEDED_CODE` | 有（brand `CallId→ToolCallId` 重命名、新增 `image-tokens.ts`/`request-pricing.ts`、`LlmRuntime` 改继承 `TypertRemoteService`、discovery 签名加 `signal?`） | **零影响**。ARGP 两个符号所在文件（message.ts 的 createUserMessage）未动其导出面；`CallId→ToolCallId` 是 dsh 包内部 import 改名，ARGP 不直接 import brand 类型 |
| `dsh-tools`（core/tools） | `defineTool` | 有（`defineTool` 本体未动；类型级 `CallId→ToolCallId`、`Code Mode→PTC` 重命名、新增 `FIRST_PARTY_SECTION_ORDER` 导入） | **零影响** |
| `dsh-commands`（interaction/commands） | `CommandId`（from `/brand`） | 有（仅 index.ts 换 `randomUUID` import 来源；**brand.ts 未动**） | **零影响** |
| `dsh-agent`（core/agent） | `Agent, PreStepDecision, RequestErrorAction`（type-only，宿主提供，**未声明于 peerDeps**） | 有（见下） | **零影响**，但有两处值得注意的结构性变化（见 §Agent 类型） |
| `cordis`（vendor/cordis） | `Context` | **零**（版本 4.0.1→4.0.1，src 0 文件改动） | **零影响** |

## dsh-agent 的两处结构性变化（对 ARGP 无碍，但需记账）

1. **`PreStepDecision` enter 分支新增可选字段**：`{ kind:'enter'; messages: UserMessage[]; startsRequestSeries?: true }`。纯增量（optional），现有构造/判型全部兼容；语义是"声明独立的模型消息序列"，与 ARGP 的 pre-step 钩子使用方式（读 messages、返回决定）无交集。
2. **`Agent` 接口重构为 declaration merging**：rc.2 时代 `Agent` 完整定义在 `runtime-types.ts`（id/options/session/inbox/status/ctx…）；alpha.1 拆成 `types.ts` 基座 `{ readonly id: SessionId }` + `runtime-types.ts` 的 `declare module './types.ts'` 合并扩展。合并后**最终形状不变**（ARGP 用的 `agent.session`、`agent.id` 均在扩展侧保留）。type-only import，无运行时面。

## 与 release notes 的对照

- **"上下文压缩会计入图片占用"**：实现落在 `dsh-llm` 新增 `image-tokens.ts` + `LlmRuntime.imageRequestPricing()`（route 级图片计价，token meter 每次计量时解析）。**属预算计量口径变化，不触碰 CompactionEngine 接口**——对 ARGP 是中性信号（官方开始把图片算进压缩预算的精确性，与 B 系列反馈同向）。
- **"插件支持在模型设置页添加提供方登录配置"**：宿主 UI 层新能力，插件接口面无变化。
- **ApiProxy 移除 → TypertRemote 网关**：`LlmRuntime` 改继承 `TypertRemoteService` 即此。ARGP **不引用 ApiProxy**（已 grep 证实），中性。
- **B-1~B-6**：diff 中未见 tombstone 事件 / 占位符元数据的新接口提供（notes 与源码一致：未提供）。

## 结论

**无破坏性变更**：ARGP 1.0.0 依赖的全部符号（7 包约 15 个）在 0.1.2-alpha.1 中**零变化**，CompactionEngine 契约延续整条版本链的稳定记录。兼容声明可写为："1.0.0 构建并验证于 0.1.1-rc.2；接口在 rc.7→rc.8→rc.2→alpha.1 整条链上零变动（alpha.1 经源码 tag diff 复核）"。

**包引用决策**：0.1.2-alpha.1 未上 npm，peerDeps **保持 0.1.1-rc.2 不动**（这是可安装、可验证的最新版本线）；待官方 npm 发布 alpha.1 后再升级。

**遗留记账项**：dsh-argp 从 `@deepseek-ai/dsh-agent` import 了 3 个 type-only 符号但未在 peerDeps 声明（宿主提供，运行时无碍）——建议后续补声明或在注释中显式说明宿主依赖。
