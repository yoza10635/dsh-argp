# dsh-llm 生产适配器(per-atom 引擎 LLM 后端)

> 状态:已实现 + mock 单测锁定(`test/peratom-llm-adapter.test.ts`,5 用例);真机冒烟待模型窗口。

## 背景

P0-P5 期间 compressor / cite-declarer 的 LLM 调用走 **fetch 旁路**(OpenAI 兼容 `chat/completions` 直连,spike 30/32 模式),登记为"P5 后已知债务"。1.0.0 前接入宿主 `ctx.llm`(`@deepseek-ai/dsh-llm` LlmRuntime),用户无须再为 per-atom 组件单独配 endpoint/apiKey。

## 两个后端

| 后端 | 接线 | 特性 |
|---|---|---|
| `dsh-llm`(生产) | `config.llm = { provider, model }` → `completeViaDshLlm(ctx, spec, prompt, timeoutMs)` → `ctx.llm.stream()` | `purpose: 'compaction'` 归类辅助调用;usage 从流内 usage 块记账进 `record.usage`;**无 response_format**(GenerateOptions 词表不含 schema 约束)→ 依赖 `extractJson` 兜底,无 schema 重试舞蹈 |
| `fetch`(遗产,默认) | `endpoint`/`apiKey`/`model` config 或环境变量(DEEPSEEK_API_KEY / ARGP_MODEL_SOURCE=qwen-local) | `response_format: json_schema` 强制 + 被拒降级裸 prompt 重试一次;行为与 v0.3.2 完全一致 |

**优先级**:`config.llm` 存在 → dsh-llm 后端,endpoint/apiKey 被忽略;两者皆缺省 → fetch 环境变量口径(既有行为不变,disabled 语义不变)。

## 多模型分工(台账 D21 口径)

compressor 与 cite-declarer 的 `llm` 各自独立指定,可指向不同 provider/model(如 compressor 跑 lite 档省成本)。**lite 档的压缩服从率未实测**,不作为默认推荐;切换前跑 spike 37 A 臂对照。

## 宿主要求

dsh-llm 后端要求宿主已注册 `llm` 服务(任意 LlmRuntime 实现)。服务缺失时 `completeViaDshLlm` 明确报错(`no llm service`),经 CompressRecord.error / CiteRecord.error 观测,**绝不阻断会话**(安全方向:该轮保原文)。

## 已知边界

- schema 约束解码只在 fetch 后端可用——spike 32 的实测结论(思考型模型上 json_schema 消灭坐标计数失控)依赖该路径;生产 dsh-llm 路径的拆分服从率需在 DeepSeek 复核轮里单独测一次(spike 38 探针可直接复用)。
- spike 的 aux 成本计量(meteringFetch)只包 fetch 路径;dsh-llm 路径的 usage 走 `record.usage`,spike/37 汇总口径需同步(当前 harness 未读该字段,接入时补)。
