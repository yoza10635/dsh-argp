# Contributing to dsh-argp

dsh-argp 是个人维护的开源项目。本项目遵循 **trunk-based 直推 `main`** 工作流：`main` 永远是可构建、可测试、产物一致的状态（由 CI 保证），提交以**原子 + conventional commits** 组织。

## 质量门禁（CI 会自动跑，本地也有钩子）

| 检查 | 命令 | 说明 |
|---|---|---|
| Typecheck | `npm run typecheck` | `tsc --noEmit` |
| Smoke | `npm run smoke` | 纯模块加载检查，无模型依赖 |
| 单元测试 | `npm test` | `node --test test/*.test.ts`，testkit mock，无模型依赖 |
| Build | `npm run build` | 产出 `lib/` |
| **产物一致性** | `git diff --exit-code lib/` | `lib/` 提交进 git（市场扫描直接 clone 使用），**改 `src/` 必须同步 build 并提交 `lib/`**，否则 CI 红 |

> 模型实验（`spike/*deepseek*`、`spike/08a-production-synthetic.ts`）需要模型与密钥，**不进入 CI**，在本地按需运行。

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
- 若提交破坏了 `main`（CI 红）：优先 `git revert` 最近提交，而非 force-push。
- 未来引入协作者时再启用 PR 流程与分支保护。

## 发布流程

发布节奏为**手动 tag 驱动**（tag 推送自动触发 CI 中的 Release job，生成 GitHub Release），同步发布 npm：

```bash
npm version patch   # 或 minor / major；自动 bump package.json 并打 tag vX.Y.Z
npm run build       # lib/ 必须与 src/ 一致（Release job 会校验）
git push origin main
git push origin vX.Y.Z    # 触发 GitHub Release（自动跑 check + build + lib 一致性校验）
npm publish               # 发布 npm registry（prepublishOnly 自动跑 typecheck + test + build）
```

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
- peratom: 修复压缩后会话重启打不开（`shadowedSeqs` 与当前 surface 不匹配，#2）

### 提示
- 注意：需宿主 ≥ 0.1.8；仍在 0.1.7 的部署请勿升级
- 测试：全量 372 例通过
```

- **三个固定类目，按此顺序**：`### 新功能` / `### 优化` / `### 修复`。**空类目整段省略**（不写「无」）。
  - 新功能 ← `feat`；优化 ← 使用者可感知的 `perf` / `refactor` / `build` / 依赖升级 / 行为调整；修复 ← `fix`。
  - 纯内部改动（`ci` / `test` / `chore` / 无行为变化的 `refactor`）**不进 CHANGELOG**。
- **尾部 `### 提示`（视情况追加）**：放升级前置条件、破坏性变更、已知限制、测试基线。**没有就不写这一段**。破坏性变更写成 `注意：…` 开头的一行——直接回答使用者「能不能升、要不要动手」。
- **一条一行**：格式 `<scope>: <一句话>（#issue）`，**直接由该版 commit subject 收敛**——去掉 `type` 前缀、保留 scope、附上 issue 号。scope 沿用提交规范里的那套（`peratom` / `prune-tx` / `client` / `preset` / `corpus` / `deps` / `docs` / `ci`）。
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
