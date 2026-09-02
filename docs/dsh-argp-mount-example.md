# ARGP dsh 声明式挂载示例（P4）

仓库根目录提供最终可用的挂载补丁 `cordis.patch.yml`（`package.json` 的 `dsh.bundle.patch` 指向它，市场安装时自动注册到 profile）：

```yaml
- id: compaction-basic
  disabled: true
- insert:
    - id: dsh-argp
      name: dsh-argp
      config: { maxPasses: 16 }
```

## 要点

- `disabled: true` 关闭 dsh 自带的摘要压缩引擎（`compaction-basic`），由 ARGP 接管。
- `insert:` 是新增 entry 的正确语法——patch 顶层数组按 `id` 匹配**已加载**的 entry，新增必须用 `insert`（直接给 `id`+`name` 会报 "entry not found"）。
- 预算默认**比例驱动**：`windowTokens = contextWindow × windowRatio(默认0.8)`、`retainTokens = windowTokens × retainRatio(默认0.2)`，上下文容量由模型适配器（其他插件）声明提供。手动旋钮（2026-08-29 显式化）：`windowRatio` / `retainRatio` 直接在 `config` 里设百分比；要绝对值则传 `windowTokens` / `retainTokens`（显式值优先于比例）。contextWindow 在 dsh settings 的 models 条目声明——它是 UI ContextMeter 分母与 ARGP 触发线的共同锚点，与模型原生上限（能力元数据，Qwen3.8-Flash-Next=256K）是两个不同的数，不要混设。

## 验证（2026-08-17 实测通过）

1. `dsh plugin --profile <name> add file:<本仓库路径>` 安装（或市场收录后 `add <包名>`）
2. `dsh --profile <name> --dump-config` → 确认 `compaction-basic` 已禁用、`dsh-argp` 已插入
3. 实例化检查：boot 后 `ctx.compaction.constructor === ArgpGraphEngine`（验证方法见 `ARCHITECTURE.md` §4 双引擎生产挂载）
4. WebUI 可正常启动（`dsh web`，端口 3080），真会话剪枝/recall 流程待实际对话验证
