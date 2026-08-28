# 1.0.0 命名与定位候选（决策待用户拍板）

> 背景：1.0.0 叙事换轨（"确定性剪枝工具" → "带守卫的上下文虚拟化"）后，现名 **ARGP = Atomic Reference Graph Pruning** 的 "Pruning" 只覆盖 Stage-2——名字不再覆盖系统。本文列候选与代价，**不擅自改名**。

## 约束

- npm 包名 / 仓库名 `dsh-argp` 已有 9 个版本、~1.4K 月下载、市场收录与安装文档——**改名 = 重新冷启动**，代价远大于收益。
- 因此所有候选都是"保留 dsh-argp 包名，改副标题/描述/全称展开"级别。

## 候选

| # | 方案 | 副标题 / 全称 | 评价 |
|---|---|---|---|
| A（推荐） | **保留 ARGP,降级为产品词** | 中："双引擎上下文压缩:逐原子守卫压缩 + 引用图确定性剪枝";EN:"Two-engine context compaction: guarded per-atom compression + deterministic reference-graph pruning" | npm/GitHub/install 文档零迁移;缩写展开只在历史文档保留;README 已按此落地 |
| B | 重定义缩写 | ARGP = **A**tomic **R**endering with **G**uaranteed **P**rovenance（原子渲染与保真溯源）——"上下文是日志的渲染视图"叙事 | 缩写自救,但"重定义缩写"有雕琢感,且 Rendering 未被外部验证过 |
| C | 完全换产品词 | dsh-keep / dsh-zoom / dsh-twospeed 等 | 全部迁移成本 + 丢 SEO/下载历史;除非 1.0.0 后另立新产品,否则不做 |

## GitHub repo description（About 一句话,候选 A 落地文案）

- 现：「0-LLM compaction for DeepSeek Harness (dsh): deterministic atomic reference-graph pruning…」——"0-LLM" 需退役（Stage-1 调 LLM）。
- 新（EN）：`Guarded context compaction for DeepSeek Harness: the LLM proposes, deterministic guards dispose — per-atom shrink (eager) + reference-graph eviction (0-LLM, lazy) + byte-exact recall from an append-only log.`
- 新（中文尾巴保留）：`…压缩率精确兑现,历史永不销毁。1.0.0 双引擎形态。`

## 关联物料清单（拍板后一次改齐）

> **2026-08-28 用户拍板：方案 A。** 落地状态：
- [x] README 首段（已按候选 A 落地）
- [x] package.json `description`（已换 A 文案，随 1.0.0 publish 生效）
- [ ] **GitHub repo description（About）——需手动**（本机无 gh CLI）：About 一句话改为下文 EN 文案 + 中文尾巴
- [ ] npm `description` 字段：随 1.0.0 publish 自动带出（即 package.json 本次改动）
- [ ] Discussion 帖标题、市场 topic：随 1.0.0 发帖时改

About 建议文案（EN + 中文尾巴）：
`Guarded context compaction for DeepSeek Harness: the LLM proposes, deterministic guards dispose — eager per-atom shrink (eager) + reference-graph eviction (0-LLM, lazy) + byte-exact recall from an append-only log. 压缩率精确兑现，历史永不销毁。`
（注意上句 "eager per-atom shrink (eager)" 在 package.json 里已修正为 "eager per-atom shrink (extract/summary/false under verbatim guards)"，About 手动改时用 package.json 版。）
