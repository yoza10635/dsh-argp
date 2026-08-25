/**
 * P0 拆分解析与策略（纯函数，零 LLM / 零 Session 依赖）。
 *
 * 职责边界：模型返回 SplitDecision.quotes 之后、落盘（P1 的 replace 事务）之前的全部
 * 确定性逻辑都在这里——定位（indexOf）、策略裁决（回退/翻转/退化）、dialog/info 文本构建。
 * 全部可单测；策略口径与 docs/per-atom-implementation-plan.md P0 一一对应。
 *
 * 危险方向说明（plan「保守对冲」节）：空隙归 info 后，失败模式是"漏标的指令片段变成
 * 可剪内容"。因此本模块的一切歧义都向 dialog 方向回退：
 *   - 任一片段定位失败 → 整条回退 dialog（保真不变式优先，静默计数由调用方负责）；
 *   - 抄写覆盖率 ≥ COVERAGE_FLIP → 整条保留为 dialog（模型实际在说"这都是指令"）；
 *   - 零有效片段 → 整条 U-info（纯资料消息的自然退化，非特判）。
 */

export type Span = readonly [number, number]

/** dialog 复合文本中，替代被摘除资料位置的省略标记（与剪枝墓碑 [elided …] 惯用法同构）。 */
export const SPLIT_ELLIPSIS = '\n[…]\n'

/** dialog 覆盖率翻转阈值（plan P0 退化规则）：≥80% 视为整条指令。 */
export const COVERAGE_FLIP = 0.8

/** 定位结果：首个出现位置（indexOf）命中的区间 + 定位失败的原文片段。 */
export interface LocatedQuotes {
  spans: Span[]
  misses: string[]
}

/**
 * 在原文中逐条定位抄写片段。重叠/乱序输入按排序后合并处理（合并不视为错误——
 * 与 range 法不同，抄写的"错"几乎都是定位失败而非坐标漂移）。
 */
export function locateQuotes(quotes: unknown, message: string): LocatedQuotes {
  const spans: Span[] = []
  const misses: string[] = []
  if (!Array.isArray(quotes)) return { spans, misses: ['<not-an-array>'] }
  for (const q of quotes) {
    if (typeof q !== 'string' || q.length === 0) {
      misses.push(typeof q === 'string' ? q : String(q))
      continue
    }
    const idx = message.indexOf(q)
    if (idx < 0) misses.push(q)
    else spans.push([idx, idx + q.length])
  }
  spans.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const merged: Span[] = []
  for (const s of spans) {
    const prev = merged[merged.length - 1]
    if (prev !== undefined && s[0] <= prev[1]) {
      merged[merged.length - 1] = [prev[0], Math.max(prev[1], s[1])]
    } else merged.push(s)
  }
  return { spans: merged, misses }
}

/** 拆分策略裁决。 */
export type SplitResolution =
  | { kind: 'unsplit'; reason: 'coverage-flip' | 'no-info-remainder' | 'empty-message' }
  | { kind: 'info-only' }
  | { kind: 'fallback-dialog' }
  | { kind: 'split'; dialogSpans: Span[]; infoSpans: Span[] }

/**
 * 计算补集间隙（未被 dialog 区间覆盖的部分），丢弃纯空白间隙——
 * 格式性噪音不值得成为 info 原子（其字符仍留在日志原文中，可 recall_detail 全文恢复）。
 */
export function complementGaps(spans: Span[], len: number, text?: string): Span[] {
  const gaps: Span[] = []
  let cursor = 0
  for (const [s, e] of spans) {
    if (s > cursor) gaps.push([cursor, s])
    cursor = Math.max(cursor, e)
  }
  if (cursor < len) gaps.push([cursor, len])
  if (text === undefined) return gaps
  return gaps.filter(([s, e]) => text.slice(s, e).trim().length > 0)
}

/**
 * 策略主入口：给定原文与（可能不可信的）quotes 输出，裁决最终拆分形态。
 * 输入宽容：quotes 接受 unknown（模型产物未经校验），一切异常走 fallback-dialog。
 */
export function resolveSplit(message: string, quotes: unknown, coverageFlip = COVERAGE_FLIP): SplitResolution {
  if (message.length === 0) return { kind: 'unsplit', reason: 'empty-message' }
  const { spans, misses } = locateQuotes(quotes, message)
  // 定位失败 → 整条回退 dialog：抄写保真不变式（surface 上不得出现模型改写的文本）优先，
  // 代价是当轮压缩收益归零——这正是 plan 债务 5 安全网的机械表达。
  if (misses.length > 0) return { kind: 'fallback-dialog' }
  if (spans.length === 0) return { kind: 'info-only' }
  const covered = spans.reduce((sum, [s, e]) => sum + (e - s), 0)
  if (covered / message.length >= coverageFlip) return { kind: 'unsplit', reason: 'coverage-flip' }
  const infoSpans = complementGaps(spans, message.length, message)
  if (infoSpans.length === 0) return { kind: 'unsplit', reason: 'no-info-remainder' }
  return { kind: 'split', dialogSpans: spans, infoSpans }
}

/** dialog 复合文本：各片段原文逐字拼接，片段间以省略标记连接（相邻引文间的资料位置）。 */
export function buildDialogText(message: string, spans: Span[]): string {
  return spans.map(([s, e]) => message.slice(s, e)).join(SPLIT_ELLIPSIS)
}

/** info 聚合文本：各余量段原文拼接（单段时即原文切片）。 */
export function buildInfoText(message: string, spans: Span[]): string {
  return spans.map(([s, e]) => message.slice(s, e)).join(SPLIT_ELLIPSIS)
}
