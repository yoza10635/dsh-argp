/**
 * 压缩事务「被隐藏历史体量」估算（2026-11-27 统计口径修复）。
 *
 * 背景：`shadowedTokenCount`（= 被替换在场节点文本 ÷ 4）是宿主 token-meter 的记账口径
 * （`dsh-token-meter` 用它扣减自估上下文），必须保持原样；但它描述的是「本次从 surface 上
 * 拿掉了多少字」，不是「压掉了多少历史」。两者在两类事务上会严重分离：
 *  - 图剪 / 组剪：被替换节点是活体原文 ⇒ 两者接近（实测 79,122 vs 真实 194,285，偏差来自
 *    chars/4 对中文的 2.4× 低估，属另一条已知问题）；
 *  - §11.8 墓碑归并：被替换的是 9 字桩，桩背后代表的历史（`sourceEventSeqs` 链）可达数十万
 *    字符 ⇒ 只报 300 余 tok（实测 145 桩 = 339 tok）会被读成「本次压缩收益 300 tok」，荒谬。
 *
 * 本模块沿 `sourceEventSeqs` 链解析被替换节点代表的历史原文（去重、升序），用 CJK 自适应
 * 密度（3.5 / 1.7）估算 token，得到「历史体量」——只用于日志 / 摘要展示，
 * **不写入任何宿主契约字段**，不影响 token-meter 记账、不影响召回账本。
 */

import type { Session } from '@deepseek-ai/dsh-session'
import { rawEventFaces, sessionEvents } from '../log-access.js'
import { countCjkChars, estTokensFromStats } from '../cjk.js'

/** 解析结果：历史体量估算（只读展示口径）。 */
export interface HiddenHistoryEstimate {
  /** 解析出的原始事件 seq（去重、升序；无 `sourceEventSeqs` 时为在场节点自身）。 */
  originSeqs: number[]
  /** 历史原文总字符数。 */
  chars: number
  /** 其中 CJK 字符数（countCjkChars 口径）。 */
  cjkChars: number
  /** CJK 自适应密度估算的 token 数（3.5 / 1.7，浮点向上取整）。 */
  tokens: number
  /** 触及 `MAX_NODES` 上限被截断（结果偏小，仅供 debug 行标注，不静默吞掉）。 */
  capped: boolean
}

/** 解析深度/节点上限（防病态日志导致的链式爆炸）。 */
const MAX_NODES = 20_000

/** 记账事件类型：它们**不是**历史内容（无文本面），绝不计入「原始事件」条数。 */
const BOOKKEEPING_TYPES: ReadonlySet<string> = new Set([
  'compaction/start', 'compaction/summary', 'compaction/prune', 'compaction/end',
  'turn/start', 'turn/end', 'step/start', 'step/end',
])

/**
 * 估算一组在场节点「代表的历史体量」。
 *
 * 规则（2026-11-27 复核修正）：
 *  1. 从给定节点出发沿 `sourceEventSeqs` 递归展开（替换副本 → 其代表的原始事件）；
 *  2. **只计量叶子**（自身无 `sourceEventSeqs` 的节点）= 真正的历史原文；
 *  3. 中间替换副本（桩/检查点）一律**不计量**——它是替代品，其文本与它所代表的原文
 *     是同一份信息的两层表示，两者都计就会重复计入（实测「摘要的摘要」两层链即虚高
 *     3.39×：原文 10,000 字 + 中间检查点头尾预览 26,000 字全进同一个 chars）；
 *  4. 记账事件（compaction/*、turn/*、step/*）不入叶子集也不入计数（实测 1 条真历史
 *     曾被报成 4 条「原始事件」）；
 *  5. 全部 seq 全局去重（`seen`），同一历史不会经多枚桩重复计入。
 */
export function estimateHiddenHistory(session: Session, nodeSeqs: readonly number[]): HiddenHistoryEstimate {
  const events = sessionEvents(session)
  const seen = new Set<number>()
  const queue: number[] = []
  for (const s of nodeSeqs) {
    if (Number.isInteger(s) && s >= 0 && !seen.has(s)) { seen.add(s); queue.push(s) }
  }

  const leaves: number[] = []
  let visited = 0
  let capped = false
  while (queue.length > 0) {
    if (visited >= MAX_NODES) { capped = true; break }
    const seq = queue.pop() as number
    visited += 1
    const ev = events[seq] as { type?: string; sourceEventSeqs?: unknown } | undefined
    const raw = ev?.sourceEventSeqs
    if (!Array.isArray(raw) || raw.length === 0) {
      // 叶子：无来源的节点就是历史原文本身；记账事件除外。
      if (ev !== undefined && !BOOKKEEPING_TYPES.has(ev.type ?? '')) leaves.push(seq)
      continue
    }
    // 有来源 ⇒ 中间替换副本：只继续向上展开，本节点文本不计量（规则 3）。
    for (const s of raw) {
      if (typeof s !== 'number' || !Number.isInteger(s) || s < 0 || seen.has(s)) continue
      seen.add(s)
      queue.push(s)
    }
  }

  let chars = 0
  let cjkChars = 0
  const measured = new Set<number>()
  for (const seq of leaves) {
    if (measured.has(seq)) continue
    measured.add(seq)
    for (const face of rawEventFaces(session, seq)) {
      chars += face.text.length
      cjkChars += countCjkChars(face.text)
    }
  }
  const originSeqs = [...measured].sort((a, b) => a - b)

  return {
    originSeqs,
    chars,
    cjkChars,
    tokens: Math.ceil(estTokensFromStats(chars, cjkChars)),
    capped,
  }
}
