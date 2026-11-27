# Contributing to dsh-argp

dsh-argp 是个人维护的开源项目。本项目遵循 **trunk-based 直推 `main`** 工作流：`main` 永远是可构建、可测试、产物一致的状态（由 CI 保证），提交以**原子 + conventional commits** 组织。

## 质量门禁（CI 会自动跑，本地也有钩子）

| 检查 | 命令 | 说明 |
|---|---|---|
| Typecheck | `npm run typecheck` | `tsc --noEmit` |
| Smoke | `npm run smoke` | 纯模块加载检查，无模型依赖 |
| 单元测试 | `npm test` | `node --test test/*.test.ts`，testkit mock，无模型依赖 |
| Build | `npm run build` | 产出 `lib/` |
| **产物一致性** | `git diff --exit-code lib/` | `lib/` 提交进 git（市场扫描直接 clone 使用），**改 `src/` 必须同步 build 并提交 `lib/`**；本地 `npm run check` 末尾即拦（build 后 diff），CI 与发布门再兜底 |
| **死代码棘轮** | `npm run ratchet` | 临时开 `noUnusedLocals/noUnusedParameters` 跑 build 作用域 tsc，unused 告警**基线 8 只许减不许增**（存量见 `scripts/tsc-ratchet.mjs`，清零后开常设旗删脚本）；已串入 `check` |

> 模型实验（`spike/*deepseek*`、`spike/08a-production-synthetic.ts`）需要模型与密钥，**不进入 CI**，在本地按需运行。

## 专项回归与上游哨兵

- **一键门禁**：`npm run check`（typecheck + spike typecheck + smoke + 单测 + 构建 + lib 一致性 diff + tsc 死代码棘轮）。改 `src/` 不发 check 全绿不提交。
- **变异台账**：`npm run mutate`（`test/mutation-ledger.json` + `scripts/mutate.mjs`）——「摘锁必红」声称的唯一复放机制：锚点漂移=ANCHOR-MISS、红不对地方=MISSING-CASE、已论证的等价变异显式登记 `expectKill:false`；串入 `prerelease:check`（发布节奏门禁，不进 push CI）。往测试头注写「EV-x 已执行」前先入台账。
- **出口闸矩阵（EG-）**：`test/factor-egress-gate.test.ts` 覆盖 EG- 全组（含压缩阈值比例线 / env 优先级），随全量测试运行；动 `resolveEgress`/egressGate 语义先跑 `node --import ./scripts/ts-import-rewrite-loader.mjs --test test/factor-egress-gate.test.ts` 定向回归（裸 `node --test` 缺 loader 会 `ERR_MODULE_NOT_FOUND`），再补变异验证。
- **preset 漂移哨兵（独立 workflow `preset-drift`，每日）**：`cordis.patch.yml` 尾部 GENERATED 段是宿主 shipped preset 的**整段替换快照**（宿主 patch 层对 preset 无局部手术语义），漂移发生在**上游**、我们仓库没动静时 push CI 看不见——故独立 workflow + schedule。哨兵从宿主仓库 sparse 拉 `packages/bundle/web-app/presets`，基线 = npm `@deepseek-ai/dsh` 的 `dist-tags.latest` 对应 tag `dsh-v<version>`（**稳定频道用户手里的宿主**；peer 包版本线与宿主不同步，勿拿 `@deepseek-ai/dsh-agent` 当基线），用 `scripts/generate-preset-overrides.ts --check`（只比对不写盘）与包内快照比对。**红灯处置**：人工重跑 `node --import ./scripts/ts-import-rewrite-loader.mjs scripts/generate-preset-overrides.ts <presetsDir>` 重生成并提交——先过目宿主 diff（issue #4 教训：幽灵键被非 strict zod 静默剥离、失效三轮才被发现）。本地 `test/preset-patch-entries.test.ts` 只锁 patch 自身不变量（毒子路径/幽灵键），锁不住宿主漂移，两者互补、都不可省。前瞻未发布宿主线（master / alpha tag）用 workflow_dispatch 的 `ref` 输入，不占红灯。
- **1.x 退役基线**：graph 引擎已退役，老方案冻结在 npm `1.11.2`（tag `v1.11.2`）；对照老行为从该 tag 检出，不在 main 上维护。

## 提交规范（conventional commits）

自 2026-08-18 起生效（历史提交不重写）：

```
<type>[(<scope>)]: <subject>
```

| type | 用途 |
|---|---|
| `feat` | 引擎功能、新能力 |
| `fix` | 缺陷修复 |
| `docs` | 文档（README、注释、CHANGELOG 说明） |
| `refactor` | 不改变行为的重构 |
| `test` | 测试用例 |
| `build` | 构建/产物/发布配置（package.json、lib/、.npmrc） |
| `ci` | CI / 钩子 / 工作流配置 |
| `chore` | 杂项 |
| `experiment` | **仅限 `spike/` 与实验文档**，与产品变更清晰分离 |

示例：

```
feat(engine): ratio-driven compaction budgets (window=ctx×0.8)
fix(recall): prevent preview bypass of recall probe
docs(mount): record P4 declarative mount validation
ci: add quality gate workflow with lib/ sync check
experiment(160k): final A-vs-baseline cost comparison
```

## 本地钩子（可选但推荐）

```bash
git config core.hooksPath .githooks
```

- `pre-push`：推送前自动跑 `npm run check` + 提交信息规范检查。

## 分支与协作

- 单分支 `main`，直接推送；**CI 通过是唯一放行条件**。
- **当日必推**：trunk 提交当天推出去，不过夜。CI 与 oldest 臂只覆盖「已推送的 main」——本地攒提交会让「main 恒绿」的前提被推送滞后击穿（oldest 臂事故根因：修复停在本地，远端 main 继续红着接新提交）。
- 若提交破坏了 `main`（CI 红）：优先 `git revert` 最近提交，而非 force-push。
- 未来引入协作者时再启用 PR 流程与分支保护。

## 锁宿主新 API 的测试：能力守卫范式

测试用到**只在部分宿主线存在**的 API（如 `systemPrompt.refreshContext`）时，必须运行时能力守卫：`typeof` 探测缺席即 `t.skip`，在场走全契约；**调用保持方法形态**（`svc.method()`，不解构）——服务实现依赖 `this`。范本 `test/vocab-context.test.ts`（peer 地板装树上该契约不存在 ⇒ skip；生产侧同样按服务存在性降级，非回归）。裸调会让 oldest 矩阵格红在「树上根本没有该 API」上，把能力探测伪装成产品回归。

## 发布流程

### 发布节奏（cadence）

> **批量，不逐提交发版。** trunk-based 下 `main` 持续累积变更、CI 持续把关；发版是**攒够一批再切**的决策，不是每提交一次的反射。

- **最小间隔**：同一自然周**至多一次正式（non-prerelease）发版**；P0/P1 hotfix 可破例，但要在 commit / CHANGELOG 写明理由。
- **发版门槛**：只有**使用者可感知的变更**（新功能 / 修复 / 行为调整 / 依赖升级）才值得一个版本号；纯内部改动（`ci` / `test` / `chore` / 无行为变化的 `refactor`）**攒着**，随下一次正式版一起走。
- **beta 与正式分离**：beta 用于验证、可多发；**正式 promote 只在 beta 稳定后**，且不与上一个正式版同日连发（1.8.0 → 1.9.0 同日是反面教材）。
- **发版前自问**：「这一版对使用者意味着什么？」答不出可感知差异 ⇒ 不发，攒到下一批。

### 版本号语义（semver）

版本号按**变更的性质**分三档——设计变动 / 破坏性变更 / 微小变动：

| 档位 | 触发条件 | 典型例子 |
|---|---|---|
| **major** `X.0.0` | **设计层面的大变动** | 架构或引擎形态重构；配置平面 / 数据契约重新设计；不再向后兼容的接口换代 |
| **minor** `X.Y.0` | **破坏性变更**：现有配置/行为不再按原样工作 | 重命名/删除配置键；改现有键的语义或类型；默认值翻转致结果变化 |
| **patch** `X.Y.Z` | **bugfix / 性能优化等微小变动** | 缺陷修复；性能优化；无行为变化的内部调整 |

- **拿不准就升一档**：分不清 minor/patch ⇒ 按 minor；分不清 major/minor ⇒ 按 major（宁可让使用者多留意，不可让破坏性变更藏进 patch）。
- **minor 必配「注意」行**：CHANGELOG 的 `### 提示` 段用 `注意：…` 开头一行，直接回答「能不能升、要不要动手」（见「CHANGELOG 写作规范」）。minor 是破坏性档位，这行是使用者判断「要不要动手」的唯一入口。
- **宿主版本不直接定档**：宿主 peer 升级本身只是依赖变更（dsh-argp 侧按 **minor**，如 1.7.0→1.8.0 对齐宿主 0.2.0-rc.1）；只有当宿主变更**迫使** dsh-argp 改自己的配置/行为契约时，才按那个契约变更的档位定（可能 major）。

### 操作（手动 tag 驱动）

tag 推送自动触发 CI 中的 Release job（生成 GitHub Release），同步发布 npm。实际入口：

```bash
npm version X.Y.Z --no-git-tag-version   # bump package.json + lock（不打 tag）
npm run build                            # 刷新 lib/（提交进 git，市场扫描直接 clone 使用）
git add -A && git commit -m "chore(release): vX.Y.Z — …"
npm run release                          # prerelease:check → --tag 建 annotated tag → npm publish → git push origin main --tags
```

> 把**不可逆**的 `npm publish` 排在**可逆**的 tag 之后：publish 之后唯一可能失败的是 push，可原样重跑，不再产生「npm 已发布但 tag/push 未完成」的死局（`scripts/prerelease-check.mjs` 的脏树 / 残留 tag 闸门在此把关）。

> npm 账号 `yoza10635`（与 GitHub 同名）。认证 token（Granular Access Token：All packages + Bypass 2FA）保存在**用户级 `~/.npmrc`**，不进 git（项目级 `.npmrc` 只含 registry 行）。tag 已存在的版本直接 `npm publish` 即可，无需重新打 tag。

> **换设备后重建凭证（2026-09-17 实测）**：
> 1. npm token 写入必须用**限定 registry 形式** `npm config set '//registry.npmjs.org/:_authToken' <token>`——本机全局 registry 配的是 npmmirror 镜像，裸 `_authToken=` 行可能把 token 发给镜像站。发布时显式 `npm publish --registry=https://registry.npmjs.org/`。
> 2. 本网络环境下 **HTTPS git push 到 github.com 被干扰**（timeout / Connection reset），但 **SSH 22 端口通**（`ssh -T git@github.com` 验证）。仓库 origin 已切为 `git@github.com:yoza10635/dsh-argp.git`，公钥在 GitHub Settings→SSH keys 注册即可；`ssh.github.com:443` 是同场景的备用端口。
> 3. 旧设备重装系统后其 SSH key 不可恢复（私钥不在），记得把 GitHub 上的 dead key 条目删掉；npm token 同理，换新后 revoke 旧 token。

## CHANGELOG 写作规范（2026-09-24 起）

参考 [llama.cpp releases](https://github.com/ggml-org/llama.cpp/releases) 与 [WorkBuddy 更新日志](https://www.workbuddy.cn/docs/workbuddy/Changelog)：**一行一条、分三大类，不写长文**。

```markdown
## [1.8.0] - 2026-09-25

### 新功能
- corpus: 新增 v4 会话格式读取，0.1.8 起的会话不再漏读

### 优化
- preset: 优化 override 生成，跳过已净化的 preset
- deps: 升级宿主到 0.1.8-alpha.1

### 修复
- prune-tx: 修复压缩后会话重启打不开（`shadowedSeqs` 与当前 surface 不匹配，#2）

### 提示
- 注意：需宿主 ≥ 0.1.8；仍在 0.1.7 的部署请勿升级
- 测试：全量 372 例通过
```

- **三个固定类目，按此顺序**：`### 新功能` / `### 优化` / `### 修复`。**空类目整段省略**（不写「无」）。
  - 新功能 ← `feat`；优化 ← 使用者可感知的 `perf` / `refactor` / `build` / 依赖升级 / 行为调整；修复 ← `fix`。
  - 纯内部改动（`ci` / `test` / `chore` / 无行为变化的 `refactor`）**不进 CHANGELOG**。
- **尾部 `### 提示`（视情况追加）**：放升级前置条件、破坏性变更、已知限制、测试基线。**没有就不写这一段**。破坏性变更写成 `注意：…` 开头的一行——直接回答使用者「能不能升、要不要动手」。
- **一条一行**：格式 `<scope>: <一句话>（#issue）`，**直接由该版 commit subject 收敛**——去掉 `type` 前缀、保留 scope、附上 issue 号。scope 沿用提交规范里的那套（`factor` / `prune-tx` / `client` / `preset` / `corpus` / `deps` / `docs` / `ci`）。
- **长度**：一句话，尽量 ≤ 60 字；一条只讲一件事——写不下就说明该拆成两条。
- **动词开头**：新增 / 优化 / 修复 / 移除 / 调整（英文条目用 Add / Improve / Fix / Remove）。
- **类目内排序**：影响面大的在前（会话打不开 / 数据损坏 > 功能缺失 > 体验问题）。
- **不写**：修法、根因推导、字段取值、实测数字、设计取舍——这些留在 **commit body**（本仓习惯已足够详细）与本地 `docs/`。想深挖的读者去看提交。
- **不用**：表格、代码块、加粗。只允许行内代码标注配置名 / 函数名（如 `shadowedSeqs`、`/compact`）。
- **每版一条测试基线**：`测试：全量 N 例通过`（放在 `### 提示` 段末）。
- ⚠️ **标题格式锁死**：必须是 `## [X.Y.Z] - YYYY-MM-DD`。`release.yml` 的 awk 用精确子串 `## [X.Y.Z]` 抽段作为 GitHub Release 正文，改标题格式会**静默回退**成自动摘要。
- ⚠️ **类目一律用 `###`（三级）**：抽段以「下一个 `## [` 行」为段界（正则 `/^## \[/` 要求 `##` 后紧跟空格与 `[`），`###` 不触发截断（已实测）。

## 实验纪律（ARGP 特有）

- 实验脚本放 `spike/`，产物放 `spike/out/`（已在 .gitignore）。
- 实验提交用 `experiment:` 类型；实验结论写入本地 `docs/`（**整个目录不进仓库**，见 `.gitignore`）或 commit message——**CHANGELOG 只放一行式条目**（见上「CHANGELOG 写作规范」），长推导与数据不进 CHANGELOG。需要长期对外可见的结论落在 `ARCHITECTURE.md` / README 这类仓库内文档里。
- 实验数据必须带产物位置（`spike/out/...`）才能进对外文档；受控对照不中途调参。

## 反馈渠道

- Bug / 建议：GitHub [Issues](https://github.com/yoza10635/dsh-argp/issues)（Bug 开 Issue；设计讨论 / 使用问题开 [Discussions](https://github.com/yoza10635/dsh-argp/discussions)）。附 `dsh --version`、本包版本与最小复现步骤。
