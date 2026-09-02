# Security Policy

dsh-argp 是个人维护的开源项目（上下文压缩插件，运行在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 宿主内，处理对话历史数据）。

## 报告安全漏洞

发现疑似安全漏洞时，请**优先使用 GitHub 的私有漏洞报告**（若本仓库已启用）：

1. 打开仓库 [Security 标签页](https://github.com/yoza10635/dsh-argp/security/advisories)；
2. 若看到 **Report a vulnerability** 按钮，直接在那里提交——内容不会公开，只有维护者可见。

若仓库未启用私有漏洞报告（Security 页只有 "New vulnerability" 或无按钮），则**直接开一个普通 Issue 并标注 `[security]` 前缀**，或私信维护者 `yoza10635`。提交前请尽量包含：

- 受影响组件（compaction 引擎 / recall / session 事件读取 / 挂载）
- 最小复现步骤或受影响代码路径
- 你观察到的影响（信息泄漏 / 拒绝服务 / 其它）

> 请勿在未确认维护者知晓前就把漏洞细节公开到 Issue / Discussion。

## 响应承诺

- **目标**：5 个工作日内确认收到并初步评估；修复版本视严重程度决定发布节奏（安全修复走 `npm version patch` 即时发版，见 [CONTRIBUTING.md](CONTRIBUTING.md)）。
- 本项目为**个人维护**，无专职安全团队，响应时间可能长于大型项目，请理解。

## 范围内（In scope）

- 压缩引擎（`src/argp-graph-engine.ts`、`src/peratom/*`）：闭包生命周期、反向拓扑摘除、cites 引用边
- recall 子系统（`src/recall-engine.ts`、`src/probe-engine.ts`）：pruned/shadowed 节点召回
- session 事件读取（`src/log-access.ts` 的 `sessionEvents()`）：双宿主兼容（rc.2 / alpha.4）
- 声明式挂载（`client.js`、profile 注入）

## 范围外（Out of scope）

- 宿主 dsh 本体的漏洞（请在 [deepseek-harness 仓库](https://github.com/deepseek-ai/deepseek-harness) 报告，或走其官方 Discussions 渠道）
- 模型 API 服务（DeepSeek / 本地 Qwen）自身的漏洞
- 未随本包分发的实验脚本（`spike/`、`experiment/`）
- 通过滥用/绕过宿主既有权限机制构造的攻击面

## 已知限制（非漏洞，但请知悉）

- 压缩**必然丢弃一次 KV 缓存**（摘要式压缩同样如此），属固有权衡，非缺陷。
- 压缩后部分被剪节点仍可通过 recall 召回；若某节点被摘除后不可召回，属设计预期（按"孤立→contextual→supporting→critical"反向拓扑序），不是数据丢失 bug。
- 会话日志格式版本 `SESSION_FORMAT_VERSION = 0`，存量会话字节兼容；格式升级时会提供迁移说明。
