/**
 * 实际 resolve hook：默认解析失败且 specifier 是相对 `.js`、parent 是 `.ts` 时，
 * 重试同目录 `.ts`。由 ts-import-rewrite-loader.mjs 注册。
 */
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context)
  } catch (err) {
    const parent = context.parentURL ?? ''
    const isRelativeJs = (specifier.startsWith('./') || specifier.startsWith('../')) && specifier.endsWith('.js')
    if (isRelativeJs && parent.endsWith('.ts') && (err?.code === 'ERR_MODULE_NOT_FOUND' || err?.code === 'ERR_UNSUPPORTED_DIR_IMPORT')) {
      const tsSpecifier = specifier.slice(0, -3) + '.ts'
      try {
        return await nextResolve(tsSpecifier, context)
      } catch {
        // 保留原始错误
      }
    }
    throw err
  }
}
