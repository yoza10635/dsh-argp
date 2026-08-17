# dsh-argp 仓库 Git 工作流优化方案

> 状态：**草案（未执行）** ｜ 日期：2026-08-18 ｜ 适用范围：github.com/yoza10635/dsh-argp
> 结论先行：当前仓库是"零门禁直推 main"模式，对已公开市场收录的仓库风险偏高。方案分 3 个阶段，Phase 1（CI 门禁）半天可落地。

---

## 一、现状诊断（2026-08-18 实测）

| 维度 | 现状 | 风险等级 |
|---|---|---|
| 分支策略 | 单分支 `main`，无保护，直接推送 | 🟡 个人项目可接受，但无兜底 |
| CI | **无任何 GitHub Actions workflow** | 🔴 main 无质量门禁，坏提交直接面向市场 |
| 本地门禁 | 无 husky / pre-commit / pre-push hook | 🔴 问题只能事后发现 |
| 提交信息 | 自由格式（`dsh-argp: xxx` 手动前缀，无类型） | 🟡 无法自动生成变更日志/release notes |
| 版本锚点 | **零 tag、零 release**（v0.2.0 未打标） | 🔴 外部用户无法按版本回溯/反馈 |
| 发布链路 | `npm run release` 已就绪，但 **npm 账号缺失**；GitHub Releases 通道未启用 | 🟡 产品已到 0.2.0 却无任何可下载/可引用版本 |
| 产物管理 | `lib/` 产物**提交进 git**（市场扫描 clone 直接用） | 🔴 改 `src/` 忘 build → 市场拿到旧产物（无一致性检查） |
| 工程门禁 | `npm run check` = typecheck + smoke + test；`prepublishOnly` 有门禁 | 🟢 基础已有，但只在发布时触发 |
| 测试/模型依赖 | smoke 纯函数无模型依赖；test 用 testkit mock，**均可进 CI** | 🟢 CI 可行性已确认 |
| 开源礼仪 | 无 CONTRIBUTING.md / SECURITY.md / CHANGELOG.md | 🟡 市场收录后外部贡献无入口 |

**核心矛盾**：这是一个已公开、已被市场扫描（GitHub topic `dsh-plugin`）的产物型仓库，但没有任何自动化门禁；同时它又是一个**个人单开发者项目**，不需要重型协作流程。

---

## 二、目标与原则

### 目标
1. `main` 永远是**可构建、可测试、产物一致**的状态——这是市场收录的信任底线。
2. 提交历史**可读、可追溯、可自动化**（生成 changelog / release notes）。
3. 发布链路**可重复、可回滚**（版本锚点先行，npm 待账号）。
4. 实验（spike/）与产品代码**清晰分离**，实验不进 CI、不污染产品提交。

### 原则（明确不做，反过度工程）
- ❌ 不引入 Git Flow / `develop` 分支 —— 个人项目 **trunk-based 直推 main** 是正确的，保持。
- ❌ 不强制 PR 流程 —— 单开发者场景 PR 是纯开销；**CI 通过即允许直推**，未来有协作者再开。
- ❌ 不引入 eslint / prettier / lint-staged —— `tsc --noEmit` 严格模式已兜底，格式化收益 < 维护成本。
- ❌ 不引入 release-please 全自动版本管理 —— 手动 bump 更可控，工具链少一环。

---

## 三、分阶段方案

### Phase 1 — CI 质量门禁（半天，最高优先）

**新增 `.github/workflows/ci.yml`**，触发：`push main` + `pull_request`（为未来 PR 预留）。

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22   # 本地已验证 22.22.2 可直接跑 TS
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm run smoke
      - run: npm test
      - run: npm run build
      # 关键：产物一致性检查——src 变更必须同步提交 lib/
      - name: Verify lib/ is in sync with src/
        run: git diff --exit-code lib/
```

要点：
- **只跑确定性检查**（typecheck/smoke/test/build），所有 DeepSeek 实验（spike/*deepseek*、08a-production-synthetic）**不进 CI**——需要模型、密钥、花钱。
- **产物一致性检查是本仓库特有且必须的一步**：`lib/` 入库是市场契约（STANDARD.md §2），`git diff --exit-code lib/` 在 build 后执行，src 改了没 build 会直接红。等价于把当前"手工记得 build"变成"build 不匹配就拒绝合并"。
- CI 本身免费（public 仓库），5 步加起来 < 2 分钟。

**为什么这步最先做**：目前没有任何机制阻止"src 改了、lib 没更新"直接进 main——一旦市场扫描窗口撞上这种提交，外部用户 clone 安装到的就是过期引擎。这是唯一会造成**外部可见损害**的缺口。

### Phase 2 — 提交规范 + 本地门禁（1 天）

**2a. 提交信息规范化（conventional commits）**

放弃手写 `dsh-argp: xxx` 前缀，改用标准类型 + scope：

```
feat(engine): ratio-driven compaction budgets (window=ctx×0.8)
fix(recall): prevent preview bypass of recall probe
docs(mount): record P4 declarative mount validation
test(chain): add chain-unlock regression cases
refactor(graph): recompute curInDegree per pass
build(marketplace): add dsh plugin bundle contract
experiment(160k): final A-vs-baseline cost comparison   ← spike/ 专用
```

- `experiment:` 类型**只用于 spike/ 与实验文档**，与产品变更一目了然分离。
- 现有历史**不需要重写**（改历史 = 重写公开仓库，破坏已 clone 的用户），新提交从规范生效日起执行。
- 约定写进新增的 **CONTRIBUTING.md**（同时补齐开源礼仪）。

**2b. pre-push 钩子（轻量，不引 husky）**

个人项目不必上 husky 全家桶，直接用原生 `.git/hooks/pre-push`（脚本 20 行内，不入库也够；要入库共享则放 `scripts/pre-push.sh` + 文档化安装）：

```bash
#!/bin/sh
# pre-push: 挡坏提交于本地，CI 是第二道防线
npm run check 2>&1 | tail -30
if [ ${PIPESTATUS[0]} -ne 0 ]; then
  echo "❌ pre-push failed: npm run check 未通过，拒绝推送"
  exit 1
fi
```

- `npm run check` 已包含 typecheck + smoke + test（不含 build，push 前没必要全 build）。
- 效果：90% 的问题在 push 前被发现，CI 主要兜住漏网的。
- 备选：若希望脚本入库共享，把钩子脚本提交到 `scripts/`，CONTRIBUTING.md 写 `git config core.hooksPath .githooks/` 一行激活。

**2c.（可选）CI 校验提交信息**

若想强制规范，CI 加一步 `commitlint`（action: wagoid/commitlint-github-action），只对 push 的提交生效。个人项目建议先**约定 + CONTRIBUTING 说明**，跑一段时间确认习惯后再上强制——避免规范未内化时反复红 CI。

### Phase 3 — 版本化发布链路（半天 ~ 1 天）

**3a. 立即：打 v0.2.0 标签 + GitHub Release（不需要 npm 账号）**

当前 package.json 已是 0.2.0，直接锚定现状：

```bash
git tag v0.2.0
git push origin v0.2.0
# 在 GitHub 页面手动建 Release，或加 workflow 自动生成
```

- Release notes 从 Phase 2 起的 conventional commits 生成（`git log --oneline v0.1.0..v0.2.0` 辅助）。
- **收益**：市场收录页、Discussion #2876 里给出的是"可下载的正式版本"，而不是裸 clone；后续用户报 B-5 等问题可直接说"v0.2.1 修复"。

**3b. 发布自动化（npm 账号就绪后接通）**

新增 `.github/workflows/release.yml`，触发：`push tags: v*`：

```yaml
on:
  push:
    tags: ['v*']
jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, registry-url: https://registry.npmjs.org/ }
      - run: npm ci
      - run: npm run check
      - run: npm run build
      - run: git diff --exit-code lib/      # 发布前强制产物一致
      - run: npm publish                    # 需要 NODE_AUTH_TOKEN secret
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
      - uses: softprops/action-gh-release@v2   # 自动建 GitHub Release + notes
```

- 发布节奏建议：**手动 tag 驱动**（`npm version patch/minor` → push tag），不搞"每次 push 都发版"。
- npm 账号拿到后只需在 GitHub Settings → Secrets 加一个 `NPM_TOKEN`，发布自动化即接通；在此之前 GitHub Releases 已能独立工作。

**3c. README badges + CHANGELOG.md**

- README 顶部加：`CI status`（badge 自动出现）、`npm version`、`license: MIT`。
- CHANGELOG.md 用手动维护的简版（个人项目足够）：版本号 + 日期 + 3~5 条要点，从 conventional commits 里挑。

### Phase 4 — 可选增强（暂缓）

| 项 | 触发条件 |
|---|---|
| main 分支保护（require CI 通过 + 防误删） | 出现第一个协作者时 |
| 自动生成 release notes（release-please 类） | 提交频率稳定、版本节奏固定后 |
| `docs/git-workflow-plan.md` 转正式 CONTRIBUTING.md | 方案确认执行后 |

---

## 四、文件变更清单

| 文件 | 动作 | 阶段 |
|---|---|---|
| `.github/workflows/ci.yml` | 新增 | P1 |
| `.github/workflows/release.yml` | 新增（npm token 就绪后启用） | P3 |
| `scripts/pre-push.sh`（或 `.githooks/`） | 新增 | P2 |
| `CONTRIBUTING.md` | 新增：提交规范 + 钩子安装 + 实验纪律 | P2 |
| `SECURITY.md` | 新增（一行：通过 GitHub Issues/Discussion 报告） | P2 |
| `CHANGELOG.md` | 新增 | P3 |
| `README.md` | badges + 版本引用 | P3 |
| `package.json` | `release` 脚本微调（build 前置已由 prepublishOnly 覆盖，可不改） | P3 |

## 五、需要你拍板的点

1. **Phase 1 是否立即执行？**（我可以直接写好 `ci.yml` 并本地验证 workflow 逻辑）
2. **v0.2.0 标签是否现在打？**（无副作用，纯锚点；但一旦打了就不能删改，除非 force-push 处理）
3. **npm 账号时间线**：近期能拿到就现在配 release.yml；拿不到就先只做 GitHub Releases。
4. **提交规范**：接受 conventional commits 迁移（新提交起生效，不重写历史）？
5. 方案文档是否纳入仓库（docs/ 下，当前为草案未提交）？

## 六、执行顺序建议

```
P1 CI 门禁 → P2 提交规范+pre-push → 打 v0.2.0 → P3 release 自动化（npm 就绪后）→ P4 视情况
```
P1 与 P2b（pre-push）零风险可立即做；P2a 规范从下一个提交开始生效；打 tag 前先确认 v0.2.0 是当前 lib/ 的真实状态。
