# ARGP dsh 声明式挂载示例（P4）

当前仓库已提供最小插件入口：
- `src/index.ts` 导出 `ArgpGraphEngine`
- `package.json` 的 `main` / `exports` 指向 `src/index.ts`

声明式挂载参考 `cordis/argp.cordis.snapshot.yml`：

1. 禁用 `compaction-basic`
2. 插入 `dsh-argp` 包
3. 传入 ARGP 配置（windowTokens / retainTokens / maxPasses / reserveTokens）

真实 `dsh` 命令验证仍未执行（需要本地模型/GPU 或 DeepSeek 真会话），这是 P4 的待验证项。
