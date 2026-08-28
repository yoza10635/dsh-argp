# 上下文口径标定：什么算"模型可见"、什么算"成本"

> 目的：把 2026-08-27 双引擎审计中踩过的口径陷阱沉淀为正式规范。所有水位对比、压缩率、成本三元组的对外数字，必须先声明本文档所列口径；口径变更须在实验台账标注（既有纪律）。
>
> 背景：初版 liveChars 用事件全量文本（含 reasoning），导致 A 臂末轮水位虚高 66.6%，并派生出两个错误结论（"A 类原子占 63% 不可压""最大活原子是数行推理正文"）——均在 2026-08-27 修正作废（commit bc25ed5）。本文件是那次修正的规范化。

## 1. 模型可见上下文（visLen 口径）

**计入**：
- message 的 text 块（user / assistant 正文）
- tool-result 的内层 content（`block.content[].text`，**必须递归下钻**——非递归 extractor 会把嵌套文本漏判为 0）
- tool-call 的 arguments

**不计入**：
- reasoning 块。`dsh-llm-deepseek` 的 `serializeAssistant` 把 reasoning 序列化为独立 `reasoning_content` 字段（不并入 content）；本地 llama.cpp / Qwen chat template **直接丢弃该字段**——决定性实验：两个仅差 reasoning_content 的请求（380 chars 文本），prompt_tokens 差值 = 0。

**环境依赖警告**：reasoning_content 被丢弃是本地 llama.cpp/Qwen 行为。官方 DeepSeek API 对 reasoning 的计费与计入行为**未验证**；对外引用水位/压缩率数字时必须标注测量环境。若部署环境将 reasoning 计入 prompt，visLen 口径需重新标定。

## 2. 事件流 ≠ 模型可见

事件全量文本（`events[seq].data` 递归取文本）≠ 模型可见文本。差异来源：
1. reasoning 块（§1）；
2. ARGP 的 data 层元数据（`argpCites`、`data[argp].info/summary`）——挂在事件 data 上，不在 message.content 里，序列化不进 wire；
3. 压缩事务的 tombstone/replace 历史事件——模型只见 surface 的当前代，不见事件史。

**审计红线**（详见 `spike/atom-audit.mjs` 头注与台账 2026-08-27 行）：剪枝类型不能靠 `surface.at(seq)`（tombstone 返空），权威来源是 `engine.records[].prunedAtoms`；replace 事件的 `e.seq` 是事件自身序号，被替换 seq 在 `surfaceOp.start`；压缩前长度必须从 **append 事件**取（轮末快照时 firstLen 已等于压缩后长度）。

## 3. 压缩器的 side-channel（不进上下文，但进成本）

PeratomCompressor / CiteDeclarer 的 LLM 调用是 **side-channel**：
- 代码路径：`postChat(fetchImpl, endpoint, prompt, ...)` 直连独立端点，不走 agent loop、不写 session 事件；
- 实证（A 臂 30 轮事件流全量扫描）：压缩 prompt 特征词 0 次出现、replace 写回内容无 JSON 残留、session 内 compress tool/call = 0；27 次调用的 usage 全在 aux 独立计量（prompt 175755 / completion 7252 tok），不进 session events 的 usage。

结论：**进上下文的只有引擎解析 + 守卫后写回的替换原子文本**；压缩 prompt 与模型原始输出永不进上下文。但它们计入总成本——成本核算必须分"主请求（session 事件 usage）"与"引擎 aux（独立计量）"两本账，台账 D 臂行的 `allLlmCost` 全口径即为此设。

## 4. 缓存口径

- 前缀稳定性判据：逐轮请求的 system+历史前缀指纹流（llm-log-proxy 指纹法）；spike/37 内建 deriveEventMessage 指纹比对。
- "非压缩轮命中率"与"绝对命中率"是两个判据：前者是同模型不劣化的 operational 闸门，后者受模型/服务商标定上限约束（本地 Qwen 天花板 ≈85%，绝对 95% 仅适用于 DeepSeek 标定）——对外引用必须注明是哪一条。

## 5. 已被口径修正作废的数字（禁止再引用）

| 作废数字 | 原因 | 替代口径 |
|---|---|---|
| "A 类活原子占 63%、不可压" | reasoning 虚高 | 修正后最大活原子全是 R 类文件内容 |
| "per-atom 压缩上下文收益 6-12%" | 同上 + 对照臂选择错误（C 臂也硬剪，非干净对照） | E vs A（visLen）：末轮降幅 59.8%、均值 39.2%（30 轮口径） |
| 26 / 36 个高信号 token（spike36） | 修复前后产物混引 | 以最新产物 `36-peratom-soak-2026-08-26T07-34-11-688Z` 口径为准 |
| 74% / 79.2% / 80.1%（spike36 VK-ratio） | 语料/口径演进残留 | 现行口径 = noise200 语料理论 68.9% / 实测 69.7%；压缩率按原子度量（VK-atom 94.7%） |
