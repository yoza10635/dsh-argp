# dsh 升级 diff：0.1.0-rc.7 → 0.1.1-rc.2

> 2026-08-25 记录。范围：@deepseek-ai/dsh-* 依赖基线升级（commit 6a99938）。
> 方法：npm tarball 对比 rc.7 与 0.1.1-rc.2（跨 rc.8 / 0.1.1-rc.1 的净变化）。

## 各包变动一览

| 包 | lib 代码变动 | 内容 |
|---|---|---|
| `dsh-compaction` | **无** | 仅 README 文档链接重命名（.md → .zh.md 索引）。CompactionEngine 三操作（survey/compact/checkpoint）契约**零改动** |
| `dsh-llm` | 有 | ① 默认重试 2→5，`maxRetries`/`retryableCodes` 进 ALWAYS_POLICY_KEYS（可配置）；② 新增 `interruptedBlocks()`：中断流安全 finalize 已交付文本/reasoning 前缀（闭/开块、非空白、按流序；工具调用省略因中断先于派发）；③ 图像 offload：超限/仅文本模型的图片替换为确定性占位文本（`textOnlyImageText`/`requestImageHandleText` 等） |
| `dsh-session` | 有 | ① `turn/end` 新增 `interrupted?: true` —— 中断轮次把已交付前缀 finalize 为该事件并显式标记；未派发工具调用缺席；完全无内容的中止轮次无此事件；② 新增 4 个 team 事件类型：`team/member`、`team/message/delivered`、`team/message/queued`、`team/task`（多智能体团队协作） |
| `dsh-commands` | 有 | ① 命令输入支持 `images: true` 附件准入（admitEncodedImages，无附件 store/超限/未声明均 settle 为 error）；② `command/done` 生命周期事件新增 `sourceEventSeq` 等字段（命令 ↔ 源事件关联） |
| `dsh-tools` / `dsh-system-prompt` | 无 | 仅文档 |

## 对 ARGP 的利好（按相关度排序）

1. **CompactionEngine 接口零变动（直接利好）**：宿主契约在整条版本链上稳定，升级零适配成本；typecheck + 96/96 test 已实证。
2. **中断语义一等公民化（利好）**：`turn/end.interrupted` + `interruptedBlocks()` 让"被中断轮次"可从事件流精确识别，不再靠形态推断。ARGP 原子化（atomize）可据此排除中断残留，避免半成品内容误入引用图/版本链；对 recall 与版本链判定更精确。对应叙事：dsh 正显式支持"失败/中断轮次的保留语义"，与 ARGP 的 reserve/降级链设计同向。
3. **重试默认 2→5（实验稳定性利好）**：缓解"空流 error"型瞬时失败。既往基线实验（如 160K 基线 high 档 30 事务 23 空流 error）的口径需注意：新版本下空流 error 率预期下降，**历史对比数据引用时须标注 dsh 版本口径**。
4. **command/done.sourceEventSeq（引用来源利好）**：命令生命周期事件显式携带源事件 seq，ARGP 的 cites 构建（用户指令→命令→工具结果）可获更明确的 provenance。
5. **team/* 新事件（中性，潜在扩展点）**：ARGP 对未知类型 fallback 为 X 原子，不破坏构建；若 dsh 默认启用团队协作，team 事件会占图空间但无引用边——可作为未来原子类型扩展的候选（如 T/team 类）。
6. **图像 offload 占位文本（中性）**：图片被确定性占位文本替代，ARGP 按普通文本处理，无碍。

## 结论

无破坏性变更；对 ARGP 是净利好（接口稳定 + 中断语义显式化 + 重试更稳健）。无必须适配项，`interrupted` 语义可作为双引擎方案落地时原子化精度的候选增强点。
