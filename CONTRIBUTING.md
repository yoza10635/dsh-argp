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
| `docs` | 文档（README、docs/、注释） |
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

发布节奏为**手动 tag 驱动**（tag 推送自动触发 CI 中的 Release job，生成 GitHub Release）：

```bash
npm version patch   # 或 minor / major；自动 bump package.json
npm run build
git add -A && git commit -m "build: bump to vX.Y.Z"
git push origin main
git push origin vX.Y.Z   # 触发 release
```

> npm publish 暂缓（等待 npm 账号），当前通过 GitHub Release 分发。

## 实验纪律（ARGP 特有）

- 实验脚本放 `spike/`，产物放 `spike/out/`（已在 .gitignore）。
- 实验提交用 `experiment:` 类型；实验结论沉淀到 `docs/` 用 `docs:` 提交。
- 实验数据必须带产物位置（`spike/out/...`）才能进对外文档；受控对照不中途调参。

## 反馈渠道

- Bug / 建议：GitHub [Discussions](https://github.com/yoza10635/dsh-argp/discussions)（本项目不启用 Issues）
