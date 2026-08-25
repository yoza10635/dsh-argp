# game.html 模拟现实需求清单（v2：聚焦热点迭代 + 压缩前后版本链）

用途：spike 08 真实编码 trace 的任务设计蓝本。
素材：`C:\Users\LDH\Desktop\game.html`（1137 行 / 单次 read ≈ 15K token / 56 函数）。

## 核心设计原则（v2 关键修正）

**目标：让「同一位置」在「压缩前」和「压缩后」都被反复迭代，逼出版本链去重的完整作用。**

版本链去重（`findVersionDuplicates`）只在**压缩事务内**跑，剪的是 surface 里
「同一 read 参数（同文件）」的**旧版本副本**（text 全等，或 enableOverlapChain 时 θ=0.8 行重叠）。
所以要让它「体现作用」，必须满足：

1. **压缩前**：同一文件被 read 多次 → surface 累积多版本 → 压缩时剪掉旧版只留最新（省 4×15K=60K token）
2. **压缩后**：继续迭代同一位置 → 形成新版本链 → 下次压缩再剪

### windowTokens 最优值（基于 15K/次 read 实测）

| windowTokens | 两次压缩间可读次数 | 压缩时剪旧版本数 | 版本链信号 |
|---|---|---|---|
| 40K | 2-3 次 | 1-2 个 | 弱 |
| 64K | 4 次 | 3 个 | 中 |
| **80K（06c 口径）** | **5 次** | **4 个（省 60K）** | **强** |

**结论：windowTokens 必须调大到 80K**，而非之前设的 40K。40K 读 2-3 次就压缩，
版本还没累积就被剪，反而测不到版本链。

### 需求编排：按热点函数分组（而非功能类型分组）

把 10 条需求按「改哪个函数」分成 3 个 batch，每个 batch 内**连续反复 read→edit 同一函数**，
batch 之间（约每 5 次 read）跨越一次压缩。

---

## 热点函数地图（版本链作用最强的迭代目标）

| 热点 | 函数 | 行号 | 迭代需求 |
|---|---|---|---|
| H1 武器/开火 | updatePlayer() | L437-476 | 武器平衡×3 + 蓄力 + 护盾 + 僚机 |
| H2 难度/敌人 | buildWave() + spawnEnemy() + ENEMY_DEF | L263-333 | 公式×2 + 精英 |
| H3 击杀/连击 | killEnemy() + dropPower() | L582-655 | 倍率 + 掉落 |
| H4 HUD/结算 | drawHUD() + gameOver() | L756, L1017 | 连击条 + 统计面板 |

---

## Batch 1：聚焦 updatePlayer（武器系统，压缩前累积多版本）

> 3 条需求连续改 updatePlayer()，每次都要 read 全文再 edit → surface 累积多个 game.html 版本。

1. **武器 Lv4 平衡**：当前 Lv4 火力过强（4 发含 2 散射），改成 3 发扇形。read → edit updatePlayer → 校验。
2. **Lv3 加散射**：改完 Lv4 后，Lv3 也应加轻微散射（±10°）。再次 read → edit updatePlayer → 校验。
3. **蓄力射击模式**：新增「按住空格蓄力，松开释放强化弹」机制，涉及 updatePlayer 开火段 + fireCd。第三次 read → edit updatePlayer → 校验。

> 这 3 条让 agent 对 updatePlayer 反复 read（每次 15K），surface 里该函数累积 3+ 个版本，
> 若此时触发压缩，版本链去重剪掉旧版只留最新。

---

## Batch 2：聚焦 buildWave + spawnEnemy（难度/敌人，跨一次压缩）

4. **shooter 公式调整**：`n >= 2 ? 1 + n : 0` 增长过快，改 `1 + Math.floor(n/2)`。read → edit buildWave → 校验。
5. **tank 公式 + 精英敌人**：tank 第 4 波不出现（off-by-one bug），顺带加 8% 精英变体（额外 3 点护盾 + 2 倍分）。read → edit buildWave/spawnEnemy/ENEMY_DEF → 校验。
6. **敌人掉落概率调整**：grunt 掉率 0.07 偏低，统一上调 + BOSS 掉落保证。read → edit killEnemy/dropPower → 校验。

---

## Batch 3：聚焦 updatePlayer + drawHUD（僚机/护盾/结算，再跨一次压缩）

7. **僚机系统**：新道具 G 生成僚机（max 2），跟随 + 自动射击。跨 updatePlayer/applyPower/draw。read 多处 → edit → 校验。
8. **护盾回充**：shield 耗尽后 3 秒冷却自动回充 2 秒。read → edit updatePlayer/hitPlayer → 校验。
9. **连击倍率 + HUD**：倍率上限 24→40，HUD 连击条同步。read → edit killEnemy/drawHUD → 校验。
10. **结算统计面板**：游戏结束页加击杀数/存活时间/最高连击 + localStorage 历史最高连击。read → edit gameOver/HTML → 校验。

---

## 任务编排（每轮 followup 的强制工作流）

每条需求都要求 agent 遵守（写入 setupText）：
1. **先 read_file game.html 读当前代码**（不 read 不许 edit，因为 old_string 必须精确匹配）
2. **优先 edit_file**（小改动，不要 write_file 整文件覆盖）
3. **改完 read 回来确认**（或 run `node check.js` 验证语法）
4. 保持上下文，不破坏无关代码

这套工作流天然逼出「read→edit→read」循环，让同一文件在同一 batch 内被反复 read。

---

## 测什么（对照 ARGP 机制）

- **版本链去重剪除量**：每次压缩时，`findVersionDuplicates` 剪掉多少「同一文件的旧版本」token
  （这是 v2 的核心指标，之前 07 小文件测不到，06c 合成场景也测不到）
- **压缩次数 + 分布**：3 个 batch 是否恰好对应 2-3 次压缩，版本链是否在压缩前/后都有素材
- **重复读频率**：game.html 被 read 多少次（预期 15-25 次）
- **edit 来源**：old_string 是否取自先前 read（决定砍 result 后 recall 频率）
- **cites 服从率**：high 档在真实大文件任务里 declares 多少
- **recall_pruned**：压缩剪掉大文件后，模型是否需要 recall 找回被剪内容

## 成本预估

- 15-25 次 read × 15K = 225-375K token 进 surface
- windowTokens=80K → 触发 2-3 次压缩
- 成本 ¥0.8-1.5（与 06c A2 臂 ¥1.135 同量级）
