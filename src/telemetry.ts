/**
 * 诊断/遥测数组有界化（P4.5 / C-H8）。
 *
 * dsh 是常驻 server 插件：引擎实例跨会话存活，`records`/`recallCalls` 等观测数组
 * 若只 push 不 trim，内存只增不减。统一改为**有界环形缓冲**——保留最近 N 条
 * （N 可配，默认 {@link DEFAULT_TELEMETRY_CAP}），FIFO 淘汰最旧。
 */

/** 遥测数组默认容量（保留最近 N 条）。 */
export const DEFAULT_TELEMETRY_CAP = 256

/**
 * 有界 push：追加 item，超出 cap 时从头部淘汰最旧条目。
 * 读端语义不变（数组仍是时间序、`at(-1)` 取最新）；仅长度有界。
 */
export function pushBounded<T>(arr: T[], item: T, cap: number): void {
  arr.push(item)
  if (arr.length > cap) arr.splice(0, arr.length - cap)
}
