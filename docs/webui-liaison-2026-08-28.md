# WebUI 真环境联调记录（2026-08-28）——dsh web profile × dsh-argp 0.3.2 × 本地 Qwen3.6-35B-A3B

对应 dsh-roadmap P4-3（WebUI 真会话验证）。真宿主 = 本地源码 dsh（commit 141eb6f，端口 3080），argp profile 经 bundle patch 声明式挂载 dsh-argp 0.3.2（`compaction-basic disabled + insert dsh-argp`，`--dump-config` 组合验证通过）。真会话经浏览器驱动：冒烟（读 1 文件）+ 压力（连读 8 个 24KB 规格文件，上下文顶满声明窗口 32K）。

## 过关项

- **声明式挂载链全通**：dump-config 组合正确（dsh-argp patch 生效）→ web 真启动 → 插件 0.2.9→0.3.2 刷新（`dsh plugin --profile argp remove/add file:`）→ `ctx.compaction = ArgpGraphEngine` 挂载成功，每请求压力检查日志可见（`[argp-graph] pressure check`）。
- **真会话工具链全通**：模型真实调用 read_file 读 24KB 文件并正确概括（115 tok/s，首 token 8.1s）；ARGP 的 system prompt 注入生效（"Context compression (ARGP)" + "Citation declaration (ARGP)" 两段协议原文在 request/header.system 中验证）；**cite 协议模型服从**——回复尾部按协议输出 `{"cites":[{"t":"...","l":"s"}]}`。
- 环境修复（保留价值）：本机 hosts 的 `localhost` 映射损坏（v4/v6 均不通），llamacpp baseURL 必须显式 `127.0.0.1`；settings.yaml 已改。

## 发现一（P0 级，阻断 1.0.0 叙事）：双引擎没有生产挂载路径

真宿主上 dsh-argp 的 default export = `ArgpGraphEngine`，bundle patch 只挂 Stage-2 图引擎（C 臂形态）。**PeratomCompressor / CiteDeclarer / RecallZoom 三管线（`mountPeratomStack`）没有任何声明式挂载入口**——`ctx.llm` dsh-llm 生产适配器（commit 2afbd53）在真宿主上一行都没跑到。1.0.0 的"双引擎"叙事在真环境里目前只兑现了单引擎。**需要**：插件入口按 config 分叉挂 `mountPeratomStack`，compressor/declarer 的 llm spec 从插件 config 声明（provider/model 走宿主 llm 服务或独立 endpoint 配置）。

## 发现二（P1）：压力测量与真实水位脱节——图剪在真环境永不触发

实测数据（同会话）：引擎账本 `contextTokens=9054 < threshold=25600, skip`，而同一时刻真实 per-request 输入 ≈25–40K tok（UI 显示"上下文已用 100%"，llama.cpp 物理 256K 未溢出所以会话不死）。脱节构成：

1. **宿主脚手架不可见**：system prompt（20,143 chars，含 ARGP 两段协议）+ AGENTS.md 注入 + skill catalog + runtime context ≈ 15K+ tok 固定占用，不是原子、引擎不计量。spike-37 里脚手架≈0，账本≈真实，两口径重合掩盖了这一点。
2. 修复方向：`windowTokens` 语义必须从"原子预算"升级为"有效窗口预算减固定脚手架占用"（引擎 config 加 `scaffoldReserveTokens`，或宿主把不可剪 token 数喂给引擎）。否则阈值(window×0.8)在真环境系统性偏晚——直到物理溢出前图剪都不会动。

## 发现三（P2）：cite 协议"只教不收"——cites JSON 泄漏到用户可见回复

system prompt 教了完整 cites 协议（V6 分级 s/c/x），模型正确服从并在回复体输出 JSON 块，但 WebUI 显示层没有剥离——用户直接看到 `{"cites":[...]}`。spike 里 strip 由测试 harness 做；生产显示路径缺这一环。修复方向：宿主侧 assistant 消息渲染前剥 cites 块（或引擎在 surface replace 时消化）。

## 次要观察

- 模型输出撞 max_tokens 上限时反复截断（"Think All" 大表格重输出两轮），配合 dsh `tool-*` 的 head/tail 截断，真环境的截断行为比 spike 复杂——P5-bis 数字外推到真环境时须再打折。
- 压力会话取证产物：`~/.dsh/sessions/--D-workspace-ARGP--/session-165d98aa-1e84-45a8-9ab3-09727dfccdfd/`（zstd jsonl，解压件 `.tmp/session-decomp.jsonl`）；压力工作区 `.tmp/liantest/`。
- 联调后 settings.yaml 已还原默认模型（glm），保留 llamacpp 条目 + 127.0.0.1 修复；web 宿主进程留在 3080 供人工查看。

## 对 1.0.0 门槛的影响

P5-bis 实测（轮次放大 ≥3.2×）成立的前提是"窗口=原子预算"；发现二表明真环境需要 scaffoldReserve 才能兑现同叙事。**1.0.0 验收清单新增两项**：①双引擎声明式挂载入口 + ctx.llm 真跑通；②scaffoldReserve 压力口径修正 + 真会话复测图剪实际触发。发现三随显示层修复走，不单独设门槛。
