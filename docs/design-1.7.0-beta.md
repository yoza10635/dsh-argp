# dsh-argp 1.7.0-beta 设计实现方案

> **目标**：把宿主 `0.1.6-alpha.1 → 0.1.7-alpha.2` 的全部结构性变更一次性吸收进 dsh-argp，以 **1.7.0-beta.0** 为目标版本（beta 先行发布）。
> **性质**：设计 + 实现方案，**先评审后动手**。所有行号基于当前工作区（1.6.1-beta.0）。
> **宿主事实来源**：`C:/Agent/deepseek-harness` @ `dsh-v0.1.7-alpha.2`（HEAD `00102833`）。

---

## 0. 结论速览（TL;DR）

| # | 变更块 | 性质 | 改动量 | 风险 |
|---|--------|------|--------|------|
| 1 | devDeps / peerDeps bump `0.1.6 → 0.1.7` | 依赖 | 1 文件 | 低 |
| 2 | V4 tool/result 双形状适配 | 结构 | 3 文件（写侧） | 中 |
| 3 | source.kind 去 `'plugin'` 化 | 结构 | 6 文件（2 写 + 4 读 + 类型声明） | 中 |
| 4 | compaction/prune 协议核验 | 验证 | 0 代码（加测试） | 低 |
| 5 | 中断轮并入下一轮 | 行为 | 3 文件 | 中 |
| 6 | 语料读取器 v3+v4 | 工具 | 1 文件 | 低 |

**核心判断（决定改动量为何比想象小）**：

1. **读侧 tool/result 文本投影已 V4 兼容**：`eventTextOf` / `rawEventText`（log-access.ts）对 tool/result 读 `data.message.content`，V4 里那是**直接内容数组**，走既有的 `block.type === 'text'` 分支即可；V3 的 `tool-result` 包装内层分支在 V4 变**死代码但无害**。⇒ 读侧文本投影**零改动**。
2. **读侧 callId 零改动**：graph-build / collect / cite-declarer / gate 取 callId 全走 `data.message.source.callId`，V4 保留该字段（且新增顶层 `message.toolCallId`，二者相等）。
3. **真正要改的写侧只有两处**：`toolCopyPayload`（decision.ts:176）+ tool 墓碑（prune-tx.ts:199），需**双形状**（V3 包装 vs V4 直接）。
4. **kind 适配的唯一持久化写点 = steer 通知**（argp-graph-engine.ts:844）。`userCopyPayload`（decision.ts:132）的 kind 是**瞬时的**——它产出的 user/message 步骤在 flush.ts:345 被统一覆盖成 `compactCheckpointSource`（= `kind:'compact-checkpoint'`），从不以裸 `plugin` 形态落盘。
5. **读侧 kind 判定**：U-info 先判（`isArgpUserInfo`，版本无关），其余走**正向白名单** `OWN_SOURCE_KINDS = ['plugin','argp','compact-checkpoint']`（`isOwnSourceKind`）⇒ 命中即 X、否则 U。⚠️ **实现落地时偏离了本方案 §2.3 原稿的"反转逻辑"**（`kind === 'user' ? 'U' : 'X'`）——取舍见 §2.3 末尾"实现落地偏差"框：反转逻辑的失败模式是**丢召回**（新真实用户 kind 误判 X），白名单的失败模式只是**轻微噪声**（新注入 kind 被当 U），白名单更安全。

---

## 1. 宿主 0.1.7 的三大结构性变更（事实核验）

### 1.1 V3 → V4：tool/result 成为一等 `role:'tool'` 消息

来源：`packages/session/session-format-v3-to-v4/README.md` §Tool-result representation。

| 字段 | V3 | V4 |
|------|----|----|
| `data.message.role` | `'user'` | **`'tool'`** |
| `data.message.content` | `[ { type:'tool-result', toolCallId, content:[...], isError? } ]`（**包装块**） | `[ ...直接内容块 ]`（**无包装**） |
| `data.message.toolCallId` | —（藏在 `content[0].toolCallId`） | **顶层字段**（= `source.callId`） |
| `data.message.isError` | —（藏在 `content[0].isError`） | **可选顶层字段** |
| `data.message.source` | `{ kind:'tool', callId }` | `{ kind:'tool', callId }`（**不变**） |

- 文件名 `session.v3.jsonl.zstd` → **`session.v4.jsonl.zstd`**；`SESSION_FORMAT_VERSION = 4`（types.ts:89）。
- 硬约束（surface.ts:462-491 `assertToolResultRewrite`）**V3/V4 同形**：tool/result 的 surface replace 必须**只改 `message.content`**——把两侧的 `message.content` 置 `null` 后其余字段须深度相等。V4 里"其余字段"含 `role:'tool'` / `toolCallId` / `isError` / `source` / `id`。

**对 dsh-argp 的影响面**：
- 读侧文本投影（eventTextOf / rawEventText）：**已兼容**（走 text 分支）。
- 读侧 callId（4 处）：**零改动**（`source.callId` 保留）。
- 写侧 `toolCopyPayload` + tool 墓碑：**需双形状**。
- `canCloneTool` 预校验（prune-tx.ts:115）：功能 OK，类型注解放宽。

### 1.2 source.kind 去 `'plugin'` 化（merge-extensible）

来源：`packages/llm/llm/src/message.ts:103-136`。

- `MessageSourceMap` 是**可合并扩展**的 sum 类型，**没有共享 `plugin` 兜底 kind**。源码注释原文：*"each producer declares its own `kind` in its own module; there is no shared catch-all `plugin` kind."* 基础 map 仅 `user / model / tool / system-prompt`。
- **运行时**：dsh-session 对 user-message 的 kind 校验为"任意非空字符串"，但**原生 V4 准入拒绝裸 `'plugin'`**（README §Producer attribution：*"require an object source with a nonempty, non-`plugin` kind"*）⇒ `kind:'argp'` 运行时安全。
- **类型层**：`createUserMessage({ source:{ kind:'plugin', ... } })` 在 0.1.7 是**类型错误**（`'plugin'` 不在 `MessageSourceMap`）⇒ 需 dsh-argp 用 **module augmentation** 声明自己的 kind。
- **`compactCheckpointSource`**（dsh-compaction `checkpoint.ts:19,33`）：0.1.7 产出 **`{ kind:'compact-checkpoint', compactionId }`**（不再是 `kind:'plugin', plugin:'compact'`）。

**dsh-argp 的 source 写点盘点**（关键发现——比"2 个写点"更精确）：

| 写点 | 当前 source | 是否以该形态持久化 |
|------|------------|-------------------|
| `userCopyPayload`（decision.ts:132） | `{kind:'plugin', plugin:'dsh-argp'}` | **否**——被 flush.ts:345 覆盖成 `compact-checkpoint` |
| dialog replace / U-info append（flush.ts:345） | `compactCheckpointSource` = `{kind:'compact-checkpoint'}` | 是 |
| 图剪 user 墓碑（prune-tx.ts:224） | `compactCheckpointSource` = `{kind:'compact-checkpoint'}` | 是 |
| **steer 通知（argp-graph-engine.ts:844）** | `{kind:'plugin', plugin:'dsh-argp', form:'notice'}` | **是（唯一裸 plugin kind）** |
| tool 副本 / tool 墓碑 | 克隆原 R 的 `source:{kind:'tool', callId}` | 是 |

⇒ **唯一需要改 kind 的持久化写点 = steer 通知**；`userCopyPayload` 的 kind 只需**类型合法**（改成 `'argp'` 即可，反正运行时被覆盖）。

### 1.3 compaction/prune 成为原生事件

- `known-event-types.ts:33` 现含 `'compaction/prune'`（0.1.6 无）。
- 0.1.7 准入规则（README §Lifecycle）：*"其 span 命名精确的当前 surface 节点且排除受保护头；不要求 compaction 事务或 owner 字段"*。
- **dsh-argp 已在发**（prune-tx.ts:185-189，每区间一个 shadow-price 事件，`shadowedRange` = 该单区间）⇒ **已协议合规**。
- **共享 shadow-price 协议**：surface replace 由紧邻其前的计量事件定价 ⇒ dsh-argp 的"每区间 prune + replace"模式正合此协议（prune-tx.ts:179-184 注释已述 2026-09-01 实测）。
- **无需 `ignorable` 标记**：dsh-argp 只写 0.1.7 已知事件；跨版本（0.1.6 读 V4）本就不成立（格式版本不同，0.1.6 直接拒 V4 头）。

---

## 2. 逐文件改动明细

### 2.1 `package.json`（依赖 bump）

- `peerDependencies`：`@deepseek-ai/dsh-agent|commands|compaction|llm|session|tools` 全部 `^0.1.6-alpha.1` → `^0.1.7-alpha.2`（`cordis ^4.0.2` / `schemastery ^3.18.1` 不动）。
- `devDependencies`：精确锁的 `0.1.6-alpha.1` → `0.1.7-alpha.2`；`^0.1.6-alpha.1` → `^0.1.7-alpha.2`。
- ⚠️ **供应链核验**（沿用既有核验法）：`npm pack` 0.1.7-alpha.2 → 解包 → 与 node_modules 逐文件 sha256 diff + registry `time`/`maintainers`/`dist.integrity` 溯源。

### 2.2 V4 tool/result 双形状（写侧）

**`decision.ts` `toolCopyPayload`（:176-189）**：
```ts
function toolCopyPayload(origData: unknown, text: string): unknown {
  const d = origData as { message?: { content?: Array<Record<string, unknown>> } } | undefined
  const first = d?.message?.content?.[0]
  if (first === undefined || typeof first !== 'object') {
    throw new Error('peratom-compressor: cannot rewrite tool/result without a content block')
  }
  if (first.type === 'tool-result') {
    // V3：保留包装块（type/toolCallId/isError），只换内层 content
    return { ...d, message: { ...d!.message, content: [{ ...first, content: [{ type: 'text', text }] }] } }
  }
  // V4：content 是直接数组，整体替换为单个 text 块
  // （...d.message 保留 role:'tool'/toolCallId/isError/source/id，满足"只改 content"约束）
  return { ...d, message: { ...d!.message, content: [{ type: 'text', text }] } }
}
```

**`prune-tx.ts` tool 墓碑（:199-213）**：
```ts
const first = origMsg?.content?.[0]
const tombText = '[elided: 旧版本结果已压缩；recall_pruned(seq) 找回原值]'
const newContent = first?.type === 'tool-result'
  ? [{ ...first, content: [{ type: 'text', text: tombText }] }]          // V3 包装
  : [{ type: 'text', text: tombText }]                                   // V4 直接
const tombstone = session.append('tool/result', {
  ...origData,
  message: { ...(origMsg as object), content: newContent },
} as never, { surfaceOp: {...}, sourceEventSeqs: [...] })
```

**`prune-tx.ts` `canCloneTool`（:115-120）**：类型注解从 V3 包装形状放宽为"content 数组存在且非空即可"（功能不变，`content?.[0] !== undefined` 对 V3/V4 都成立）。

**`log-access.ts` `eventTextOf` / `rawEventText`**：**不改**（功能已 V4 兼容）。可选：在 `tool-result` 内层分支加注释"V3 专用；V4 走 text 分支"，避免后人误删。

### 2.3 kind 适配

**类型声明**（新增 `src/llm-source-augment.d.ts`，纳入 tsconfig）：
```ts
import type {} from '@deepseek-ai/dsh-llm'
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    argp: { kind: 'argp'; form?: 'notice' | 'relay' | 'recall'; summary?: string }
  }
}
```
> 备选（更省事但弱类型）：写点处 `as unknown as MessageSource` 强转。推荐 augmentation（类型安全，符合"每个插件自声明 kind"的设计意图）。

**写点**：
- `argp-graph-engine.ts:844`（steer 通知）：`{kind:'plugin', plugin:'dsh-argp', form:'notice', summary}` → **`{kind:'argp', form:'notice', summary}`**。
- `decision.ts:132`（userCopyPayload）：`{kind:'plugin', plugin:'dsh-argp'}` → **`{kind:'argp'}`**（瞬时，类型合法即可）。

**读点**（统一为反转逻辑；U-info 先判，版本无关）：
- `graph-build.ts:79`（`classifyUserMessage`）：
  ```ts
  export function classifyUserMessage(data: unknown): 'U' | 'X' {
    if (isArgpUserInfo(data)) return 'U'
    const kind = (data as { source?: { kind?: string } } | undefined)?.source?.kind
    return kind === 'user' ? 'U' : 'X'
  }
  ```
- `log-access.ts:340`（`logRowType`）：`isArgpUserInfo(data)` 先判（已如此）；把 `source?.kind === 'plugin' ? 'X' : 'U'` 改成 `source?.kind === 'user' ? 'U' : 'X'`。
- `collect.ts:74`（`isMaterial`）：`if (src?.kind === 'plugin') return false` → **`if (src?.kind !== undefined && src?.kind !== 'user') return false`**（排除一切注入；U-info 是 `compact-checkpoint`，自然被排除）。其后的 `skipForms` 检查保留作防御（对新逻辑已冗余但无害）。
- `cite-declarer.ts:406`：`if (source === 'plugin') continue` → **`if (isArgpUserInfo(data)) continue`**（用版本无关的 U-info 判据，而非 kind）。

**兼容性**：反转逻辑对 V3 同样成立（V3 真实用户 = `kind:'user'`；V3 注入 = `kind:'plugin' ≠ 'user'` ⇒ X）⇒ **无需单独保留 `'plugin'` 分支**，反转逻辑天然向后兼容 V3。

> ⚠️ **实现落地偏差（2026-09-23 定稿）**：读点**没有**采用上面的反转逻辑，而是统一改用**正向白名单** `isOwnSourceKind(kind)`（`OWN_SOURCE_KINDS = ['plugin','argp','compact-checkpoint']`，`peratom/types.ts`）——`graph-build.classifyUserMessage` / `log-access.logRowType` / `collect.isMaterial` / `cite-declarer` 全部是 `isArgpUserInfo(data) ? 'U' : (isOwnSourceKind(kind) ? 'X' : 'U')`。
> **为何偏离**：反转逻辑（`kind === 'user' ? 'U' : 'X'`）的失败模式是"宿主未来新增一个**真实用户** kind（≠`'user'`）⇒ 被误判 X ⇒ **丢召回**（数据丢失）"；正向白名单的失败模式是"宿主未来新增一个**注入** kind（不在白名单）⇒ 被当 U ⇒ 轻微噪声"（**无数据丢失**）。白名单的失败模式严格更安全。且 1.6.1 的 form 轴门控（`skipContextForms=['relay','notice']`）已在 `isMaterial` 单独处理子代理 relay/settled（它们 kind 是 merge 扩展 `agent-message`/`subagent-settled`，不在白名单也无需进白名单）⇒ 白名单只需枚举三个已知注入 kind（`plugin`/V3、`argp`/V4 steer、`compact-checkpoint`/checkpoint）。三场景（新建 V4 / 迁移 / 纯 V3）下两种逻辑结果**完全一致**，偏差只影响未列出的 merge 扩展 kind。

### 2.4 compaction/prune 协议核验（0 代码，加测试）

- 加测试：0.1.7 宿主**接受** dsh-argp 的 `compaction/prune` 发射（无 `ignorable` 也能过准入）。
- 加测试：**shadow-price 协议**在 0.1.7 成立——resume 重放无 `"no adjacent shadow price"`（每区间 prune 的 `shadowedRange` 严格等于紧随的 replace 范围）。
- 验证：`shadowedRange` 排除受保护头（node 0）——dsh-argp 的 atomize 本就跳过 `system/message`，天然满足。

### 2.5 中断轮并入下一轮（用户"下一轮兜底"）

**机制**：中断轮 N 的**完整**原子（U-long + R；spike 45 实证 94% 完整、仅 1/7 有截断 A 前缀）**不在 N 自己的 pass 压**（racy——轮刚被中断），而是**并入下一轮 N+1 的 pass**（settled，无 race）。

- **`collect.ts` `collectFromWindow`（:108-117）**：**保留** early return（`if (interrupted) return collect`）——中断轮**自己的** pass 跳过、不压。
- **`collect.ts` `collectCurrentTurn`（:160-194）**：找到 last closed turn（记 `closed`，= N+1）后，计算 `prevTurn = closed - 1`，查 `collectInterruptedTurns(events).has(prevTurn)`。若命中，事件扫描从"只收 `open === closed`"扩展为"收 `open === closed` **或** `open === prevTurn`"；prevTurn 段的水位用 `waterMarkOf(session, prevTurn)`（-1 = 未处理）。成功落地后**同时推进** `closed` 与 `prevTurn` 两个水位（各取该轮原子 max seq）。
- **`flush.ts` `prepareCurrentTurn` / `compressCollect`（:228 / :282）**：`collect.interrupted` 语义保持"closed 轮自身是否中断"（保留 skip 记账）；并入的 prevTurn 原子随 closed 轮一起压，水位双推进。
- **`cite-declarer.ts` `collectDeclAtoms`（:383-437）**：保留 early return（:385）；`toAtoms` 过滤（:437）从"排除一切中断轮"改为"排除中断轮，**但保留 `closed - 1`**（若它中断）"：
  ```ts
  collect.toAtoms = [...toBySeq.values()].filter(a => a.turn === closed - 1 || !interruptedTurns.has(a.turn))
  ```

**边界**：连续多轮中断时只并入"紧邻上一轮"；更早的中断轮可能漏（罕见，注明限制，后续可扩为"全部未处理中断轮"）。

### 2.6 语料读取器 v3+v4（`spike/lib/session-corpus.ts:268`）

```ts
// 现状（硬编码 v3）：
const file = path.join(slugDir, id, 'session.v3.jsonl.zstd')
// 改为 glob v3+v4：
const file = ['session.v3.jsonl.zstd', 'session.v4.jsonl.zstd']
  .map(n => path.join(slugDir, id, n))
  .find(p => fs.existsSync(p))
if (!file) continue
```
> ⚠️ **隐藏坑**：不改则所有 v4 session 被**静默漏读**，语料审计/回归会系统性偏少。

---

## 3. 兼容性矩阵

| 场景 | U-info | checkpoint / 墓碑 | steer 通知 | 真实用户 |
|------|--------|------------------|-----------|---------|
| **新建 V4**（1.7.0 宿主） | `compact-checkpoint` + `data[argp].info` | `compact-checkpoint` | `argp` | `user` |
| **迁移 V3→V4** | `plugin:dsh-argp` + `data[argp].info` | `compact-checkpoint` | `plugin:dsh-argp` | `user` |
| **纯 V3**（旧宿主） | `plugin` + `data[argp].info` | `plugin` | `plugin` | `user` |

**读侧统一判据**（三场景全部正确，无需 per-scenario 分支）：
- **U-info**：`data[ARG_NS].info === true`（`ARG_NS='argp'`，版本无关）⇒ 恒 `'U'`（先判）。
- **真实用户**：`kind === 'user'`（三场景一致）⇒ `'U'`。
- **其余**（`compact-checkpoint` / `argp` / `plugin:dsh-argp` / `plugin`）⇒ `'X'`。

⇒ **U-info 先判 + 正向白名单**（`isOwnSourceKind`），覆盖全部三场景。（实现落地用正向白名单而非反转逻辑，见 §2.3 末尾"实现落地偏差"框；三场景下两者结果一致。）

---

## 4. 测试计划

- **既有全量测试须绿**：`typecheck` + `typecheck:spike` + `test` + `build`（`npm run check`）。
- **新增**：
  1. **V4 tool/result 双形状**：`toolCopyPayload` / tool 墓碑 各 V3 + V4 两例（断言 V4 产物 `role:'tool'`、直接 content、满足 `assertToolResultRewrite`）。
  2. **kind 反转分类**：U-info / 真实用户 / checkpoint / argp 四例 × 三场景（新建 V4 / 迁移 / 纯 V3）。
  3. **compaction/prune 0.1.7 准入 + shadow-price resume**（无 `ignorable` 也能过；resume 无 "no adjacent shadow price"）。
  4. **中断轮并入下一轮**：构造 N 中断 + N+1 闭合，断言 N 的 R 被 N+1 pass 压、`closed` 与 `prevTurn` 水位双推进、N 自身 pass 跳过。
  5. **语料读取器 v3+v4 glob**：混合 v3/v4 目录，断言两者都被载入。
- ⚠️ **测试环境不桥接 `session/event`** ⇒ 走 `ctx.on('session/event')` 的新逻辑，单测须手动 `ctx.emit(...)`。
- ⚠️ **改默认契约会打挂既有用例**（1.4.0 曾打挂 P6 四例）⇒ 处置 = 给旧用例显式开逃生阀，**不是改断言**。

---

## 5. 风险与回退

- **N=1 绝不成立**：跨 run 比较须多 seed 或 record/replay；本方案的行为变更（中断轮并入）验证须**同 run 内因果闭环**。
- **CRLF vs LF**：src 工作区归一 LF + 重建 lib（2026-09-21 曾酿全红 CI，commit `a231a2c`）；脚本字符串替换**别带 `\n`**（CRLF 静默不匹配）。
- **Edit 同文件连续编辑静默回滚**（EBUSY）⇒ 多处编辑后 grep 复核。
- **后台 shell 不继承沙箱豁免** ⇒ 跨 workspace 写静默失败 ⇒ 前台复位 + 验 HEAD/干净再启后台。
- **回退**：1.7.0-beta 出问题 → `npm dist-tag` 把 `latest` 回退到 1.6.1（已 promote）。

---

## 6. 发布流程（beta 先行）

1. **前置**：~~promote `1.6.1-beta.0` → `latest`~~ → **改为不 promote**（用户拍板"跳过 1.6.1 正式版"）：`latest` 保持 **1.6.0**，1.6.1-beta.0 留在 `beta` 轨不动。
2. 本方案全部改动落地 + 测试绿 + build。
3. 版本 bump → **`1.7.0-beta.0`**；CHANGELOG 写 `## [1.7.0]` 段（base 版本号，与 `[1.6.1]` 同惯例；段首注明当前以 `1.7.0-beta.0` 发布）。
4. `npm publish --tag beta`（偶发段错误 0xC0000005 ⇒ 手动跑完 `typecheck && test && build` 后 `npm publish --ignore-scripts`）。
5. 更新 profile 运行时副本（**实体拷贝**：覆盖 `~/.dsh/profiles/web/dsh-argp-*.tgz` + 手动原子替换 `node_modules/dsh-argp` + 对齐 `pnpm-lock.yaml` integrity/version + **开新会话**才生效）。
6. 观察期后 promote → `latest`。

---

## 7. 待决点（已全部拍板，2026-09-23）

1. **kind 取值**：✅ **`'argp'`**（简洁自声明）。读侧正向白名单对 `'argp'` 与 `'plugin:dsh-argp'` 都兼容，纯风格选择，取 `'argp'`。
2. **中断轮并入范围**：✅ **紧邻上一轮**（`prevTurn = closed - 1`，简单、覆盖 94% 场景）。更早的中断轮可能漏（罕见，注明限制，后续可扩为"全部未处理中断轮"）。
3. **1.6.1 promote 时机**：✅ **不 promote**——`latest` 保持 **1.6.0**（用户拍板"跳过 1.6.1 正式版"）。1.7.0-beta.0 走 `--tag beta`，观察期后再决定 1.7.0 正式版。
4. **类型声明方式**：✅ **module augmentation**（`src/llm-source-augment.d.ts`，类型安全，符合宿主"每个 producer 自声明 kind"设计意图）。
5. **（新增）U-info 副本附件处理**：✅ **保留附件块**（用户拍板选项 2）——U-info 副本 = 压缩文本 + 原样 image/file 块，LLM 只压文本不碰附件（见 CHANGELOG 1.7.0 Added 首条）。
