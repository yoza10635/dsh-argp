export { ArgpGraphEngine, default } from './argp-graph-engine.js'
export * from './argp-graph-engine.js'

// Preset 净化器（0.1.7：patch-composition override）。纯文本手术 + 把 shipped
// preset 的 `- insert:` 声明转成顶层 modify override 行（cordis.patch.yml 的
// override 段由 scripts/generate-preset-overrides.ts 生成，随包分发）。
export {
  purifyPresetPatch,
  toModifyRow,
  DEFAULT_STRIP_ROWS,
  DEFAULT_ISOLATE_GROUP,
  dropEmptyGroups,
  stripIsolateBlock,
  stripPresetRows,
} from './preset-cleaner.js'
export type { PurifyOptions, PurifyResult } from './preset-cleaner.js'
// /argp 只读状态命令：注册器 + 状态渲染纯函数 + 版本号常量。
export {
  ARGP_COMMAND_DESCRIPTION,
  ARGP_COMMAND_NAME,
  ARGP_STATUS_VERSION,
  registerArgpCommand,
  renderArgpStatus,
} from './argp-command.js'
export type { ArgpStatusHost } from './argp-command.js'
