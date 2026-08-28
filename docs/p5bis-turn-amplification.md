# P5-bis：轮次放大（context window 虚拟化）实验设计——判据预注册

> 状态：**判据预注册，实验未执行**（需模型窗口）。本文档在开跑前定稿；开跑后判据不得回改，实测结果另行登记台账。
> 背景：2026-08-27 用户校准——P5 四臂（成本三元组 + 探针保真）未触达最初设计初衷「相同上下文长度下，pre-turn 压缩使可支撑轮次扩大数倍」。本实验补上这个主判据。harness 支持已落地（`spike/37-peratom-three-arm.ts`，本文 §3）。

## 1. 定义（口径全部遵循 docs/visible-context-calibration.md 的 visLen）

| 记号 | 定义 |
|---|---|
| B | 有效窗口（tokens），默认 = `ARGP_WINDOW_TOKENS`，可独立覆盖 `ARGP_EFF_WINDOW_TOKENS`。chars 口径 = B × 3.5；scope = surface 活原子（不含 reasoning / system），与引擎 surfaceTokens 同口径，臂间公平 |
| cfChars(t) | 反事实水位：截至 t 轮的 append-origin 事件 visLen 累计——即「假如全程零压缩，水位应是多少」。**任意臂的自身日志都可离线复算**，E 臂实跑用于校准该口径 |
| K_no | 无压缩最大可持续轮数 =（cfChars 首次超 B 的轮次）− 1 |
| K_arm | 本臂在 liveChars 不超 B 前提下的完成轮数 |
| 放大倍数 | K_arm / K_no（result.json `amplification` 字段） |

## 2. 判据预注册（开跑前钉死，跑后不改）

| # | 判据 | 阈值 | 性质 |
|---|---|---|---|
| G1 | **压强充足**：E 臂在 MAX_TURNS 内死亡（cfChars 触 B） | deathTurn ≠ undefined | 门槛——不满足则实验作废，调小 B 或加大每轮增量重跑（教训：08-27 四臂「未受压」自标 GO，主次指标放反） |
| G2 | **A 臂守窗**：A 臂 liveChars 全程 ≤ B | armDeathTurn = undefined | 门槛 |
| G3 | **放大主判据**：K_A ≥ 2 × K_no | ≥ 2× | 主判据——达成即 1.0.0 叙事的数字支撑 |
| G4 | 放大理想值：K_A ≥ 3 × K_no | ≥ 3× | 次判据——达成则对外用"3×+"措辞 |
| G5 | **放大且不失真**：A 臂探针 | ≥ 6/7（exact D 组 4/4 必须） | 主判据的组成部分——放大以保真为前提，丢了保真的放大不是 ARGP 的卖点 |
| G6 | 同模型不劣化（沿 P5）：A 非压缩轮前缀命中 ≥ E 对应值 | operational | 闸门（绝对 95% 是 DeepSeek 标定口径，本地只判相对） |

**1.0.0 措辞与结果绑定（预承诺）**：
- G3 + G5 达成 → 对外说「固定 16K 有效窗口下可持续轮数 ≥2×（合成多轮编码任务口径）」，模板数字按实测填
- 仅 G4 额外达成 → 可用「3×+」
- G3 未达成 → 轮次放大**退出** 1.0.0 叙事，卖点回落到「水位降低（E vs A 末轮 −59.8% @30 轮）+ 7/7 保真 + 前缀缓存稳定」，且此回落须在发帖/README 如实执行
- 任何放大数字必须带三要素：窗口 B、任务口径、模型；禁裸「N×」

## 3. harness 支持（已落地，待跑）

`spike/37-peratom-three-arm.ts` 新增：
- `ARGP_EFF_WINDOW_TOKENS`（默认 = ARGP_WINDOW_TOKENS）、`CHARS_PER_TOKEN=3.5` → `EFF_WINDOW_CHARS`
- 逐轮 `counterfactualChars`（append-origin visLen 累计）入 `contextTraj`；`deathTurn` / `armDeathTurn` / `kNo` / `amplification` 入 result.json
- E 臂触窗即提前收队（职责=K_no 校准，探针不判），`deathReason='context-window-exceeded'`
- 判决项：`P5-K-no-observed`（E 臂压强门槛 G1）、`P5-window-hold`（非 E 臂 G2）、`P5-turns` 对 E 臂死亡豁免
- E 臂必须跑（不能只靠 A 臂反事实）：E 实跑死亡轮与 A 臂日志离线复算的反事实死亡轮应一致（±1 轮），不一致说明 visLen/append 口径有漂移，先修口径再谈数字

## 4. 跑法

```
# 串行（单 slot 防 GPU 污染），同任务同模型：
ARGP_ARM=E ARGP_MAX_TURNS=60 ARGP_WINDOW_TOKENS=16000 ARGP_RETAIN_TOKENS=4000 ... spike/37
ARGP_ARM=A ARGP_MAX_TURNS=60 ARGP_WINDOW_TOKENS=16000 ARGP_RETAIN_TOKENS=4000 ... spike/37
```
- **B=16000（16K 档）为默认推荐**：60 轮外推显示该档 K_no≈20 / K_A≈56（均在实测轨迹内插值区间，非远端外推），60 轮预算足够判 G3
- MAX_TURNS=60：探针块沉底（harness 参数化保证 30/60 兼容）；若 K_no 实测 <15，无需跑满 60 可提前判 G3/G4
- 跑前先 3 轮冒烟确认 `[death]`/`cfChars` 字段出现在 console 与 result.json

## 5. 60 轮放开对比的外推模型（2026-08-26 产物实算）

产物：`spike/out/37-three-arm-E-2026-08-26T18-11-31-448Z`（E）/ `37-three-arm-A-2026-08-26T18-14-40-110Z`（A），filler 段（T30-52）增速 E≈524 / A≈375 chars/轮（A=E 的 72%）。K(B) = 首次超 B×3.5 chars 的轮次（60 轮内为观测，超出按 filler 增速线性外推）：

| B (tokens) | K_E | K_A | 放大 K_A/K_E | 区间性质 |
|---|---|---|---|---|
| 8K | 8 | 8 | **1.00** | 实测（预热段共享，窗口先于分化到） |
| **16K** | **20** | **56** | **2.80** | **60 轮轨迹内实测——G3 默认档** |
| 32K | 103 | 198 | 1.92 | 外推 |
| 64K | 317 | 497 | 1.57 | 外推 |
| 128K | 765 | 1122 | 1.47 | 外推 |
| 256K | 1641 | 2345 | 1.43 | 外推（渐近 = 增速比 1/0.72 ≈ 1.39×） |

**结构性结论（预注册认知，跑后修正须留痕）**：
1. 放大倍数**强依赖 B**，不是单一数字：超小窗口被共享预热段压平（→1×），中等窗口峰值（16K 档 2.8×），大窗口渐近于「压缩后增速比」≈1.4×。「轮次放大 N×」必须绑定 B 与任务口径。
2. 08-27 记录的「外推 1.5-1.6×」对应 64-128K 档；16K 档（ARGP 内部预算的常用档）更有利。
3. 放大倍数的上限 = 增速比 = 1 − (per-atom 净削减 / E 增速)。要提高上限只能提高可压占比（更"真实编程"的任务：大 build 日志/长文件读回）——合成任务的 1.4× 渐近线是任务属性，不是引擎缺陷。

## 6. 真实编程任务展望（P5-bis-c，另行立项）

合成任务可压占比低 → 渐近 1.4×；真实编程会话（读大文件、build 日志、test 输出占增量 ≥80%）增速比理论上限更高。路径：用真实会话日志（如本仓库开发过程的 dsh 会话）做原子大小分布采样，代入同模型外推；若需实测，把 spike/37 剧本换成真实任务回放（需要 dsh-llm 适配器先落地——依赖关系）。
