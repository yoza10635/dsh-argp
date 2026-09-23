/**
 * dsh-llm `MessageSourceMap` 模块增强（v1.7.0-beta，宿主 0.1.7 去 `plugin` 化适配）。
 *
 * 宿主 0.1.7 的 `MessageSourceMap` 是 **merge-extensible** 联合（`lib/types/message.d.ts:101-108`），
 * 基础表只有 `user / model / tool / system-prompt`——**没有共享的 `plugin` 兜底 kind**。
 * 注释原文："each producer declares its own `kind` in its own module; there is no shared
 * catch-all `plugin` kind"。dsh-argp 作为 producer 必须声明**自己的** kind，不能再借用
 * 0.1.6 的 `kind: 'plugin'`（该 kind 在 0.1.7 已不存在，`{ kind: 'plugin' }` 字面量
 * 无法通过 `createUserMessage` 的 `source: MessageSource` 类型检查）。
 *
 * 本文件按宿主自家包的先例（acp / session-query / compaction-basic 测试里的
 * `declare module '@deepseek-ai/dsh-llm' { interface MessageSourceMap { 'test': ... } }`）
 * 声明 `argp` kind：`{ kind: 'argp' } & ContextFormed`。`ContextFormed` 是宿主导出的
 * form 判别联合（`notice` 需 `summary`、`snapshot` 需 `sections` 等），与 `kind` 正交——
 * 缺省 `form?: never` 允许只带 `kind` 的裸注入（U-info 副本），`form: 'notice'` 则要求
 * 一行 `summary`（auto-continue 续写提示）。
 *
 * **本文件是 `.d.ts`**：只参与类型检查、**不**被 `tsc` 重新发射到 `lib/`（声明文件是
 * 输入不是输出）。运行时无任何影响——`source: { kind: 'argp' }` 只是普通对象字面量。
 * 该增强对**整个编译程序**生效（`tsconfig.json` / `tsconfig.build.json` 的 include 都
 * 覆盖 src 下全部 `.ts`，含本 `.d.ts`），故 `decision.ts` / `argp-graph-engine.ts` 里的
 * `{ kind: 'argp' }` 字面量都能通过类型检查，无需任何 `as` 强转。
 */
import type { ContextFormed } from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    argp: { kind: 'argp' } & ContextFormed
  }
}
