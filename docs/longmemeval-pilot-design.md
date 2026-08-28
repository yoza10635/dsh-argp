# LongMemEval pilot 设计（待拍板执行）

> 状态：设计稿。路线图 P5 挂账项；外部视角最高杠杆的"第三方可复现基准"。拍板点见 §6。

## 1. 为什么是 LongMemEval

- 外部评审对自造基准（t-long、spike 37 合成任务）的第一问就是"有没有公认基准"；LongMemEval 是长会话记忆/上下文管理的现行公开基准（多会话 haystack + 五类能力探针：信息抽取 / 多会话推理 / 时序推理 / 知识更新 / 弃答）。
- 与 ARGP 的匹配点：**haystack 会话可确定性注入**（不需要 LLM 重放历史）——只有回答问题那一步花模型调用，成本可控；弃答（abstention）能力与 ARGP 的 recall never-guess 契约天然对齐。

## 2. 规模与抽样

- 用 **LongMemEval-S**（约 500 题）抽样子集：首期 **n=100**（分层按五类能力等比），置信区间够看方向。
- haystack 上下文量：S 档单题历史 ≈ 数万-数十万 token,天然触达压缩触发线——正是 ARG 的主场。

## 3. 试验臂

| 臂 | 配置 | 备注 |
|---|---|---|
| ARGP-graph | 仅 Stage-2（graph） | **首期主臂**——0-LLM,历史注入零额外成本 |
| ARGP-dual | Stage-1 + Stage-2 | 成本× hayastack 轮数(Stage-1 每轮一次 LLM);首期仅在 n=10 子样上试跑估成本,不进主表 |
| basic | dsh 原生摘要压缩 | 对照;注意 B-5 空流口径标注 |
| none | 无压缩（截断依赖请求组装层） | 下界对照 |

## 4. 流程

1. 数据准备（离线）：下载 LongMemEval-S，抽 n=100，把每题的 haystack 会话映射为 dsh session append 事件（user/assistant 交替按原文构造，turn 边界=会话轮）——**纯确定性，零模型调用**。
2. 注入后做一次 `compactIfNeeded('pressure')`（或按比例预算触发）让 ARGP/basic 各自压缩到预算。
3. 追加问题 turn，真模型回答一次；判分用 LongMemEval 官方判分（字符串/IOU/LLM 判分按题型）。
4. 指标：五类能力正确率 + 弃答正确率 + 每题成本（miss/hit/out）+ 压缩事务数。

## 5. 已知坑（预注册）

- haystack 注入的 user/assistant 原文里若含 "nothing else" 类指令措辞 → DeepSeek cites declared=0（README 已知特性）——臂内一致即可,不影响臂间对比。
- basic 臂 B-4（testkit tokenMeter）必须显式挂 TokenMeter（spike 7 教训）。
- 弃答题：无压缩臂靠"没看到"弃答,压缩臂靠"剪了但 recall 找回"——答对路径不同,判分口径按官方,不做有利于己的裁剪。
- 结论外推纪律：n=100 只说"方向性优于/不劣于",不外推 SOTA 声明。

## 6. 拍板点

1. 成本预估：n=100 × 4 臂 × 每题 1 次回答（haystack 注入免费）≈ 400 次模型调用 + 压缩开销；DeepSeek v4-flash 计价约 ¥__（跑前用 n=5 冒烟实测填空）。
2. 先跑哪两臂：建议首轮 ARGP-graph + none（最干净的价值证明）,basic 次轮。
3. 结果发布口径：n=100 方向性结论可进 README/发帖;≥300 题再谈"基准级"。
