/**
 * Node 22 原生 TS（type stripping）不重写相对 `.js` → `.ts` 导入（Node 24 默认支持；
 * 见 https://nodejs.org/api/typescript.html rewriteRelativeImportExtensions）。
 *
 * 本项目 src/ 内部统一用 NodeNext 的 `.js` 后缀相对导入（产物型仓库，tsc 编译为
 * lib/*.js 后 `.js` 后缀保持正确），本地 node 22 直接跑 test/spike 时会因找不到
 * `log-access.js` 而 ERR_MODULE_NOT_FOUND。本入口通过 `--import` 加载，并注册
 * resolve hook（见 ts-import-rewrite-hooks.mjs）作兜底：
 *
 *   - 默认解析成功（node 24 原生重写，或目标 `.js` 真实存在）→ 不介入；
 *   - 默认解析失败 + specifier 是相对 `.js` + parent 是 `.ts` → 重试同目录 `.ts`。
 *
 * 用法：`node --import ./scripts/ts-import-rewrite-loader.mjs <script>`
 */
import { register } from 'node:module'

register('./ts-import-rewrite-hooks.mjs', import.meta.url)
