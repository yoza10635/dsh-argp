# Changelog

本项目使用 conventional commits 记录变更，版本由 `package.json` + git tag 锚定。双分发渠道：**GitHub Release**（tag 驱动）+ **npm registry**（`dsh-argp`，账号 `yoza10635`）。

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
