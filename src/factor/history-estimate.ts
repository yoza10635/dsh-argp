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
}

/** 解析深度/节点上限（防病态日志导致的链式爆炸）。 */
const MAX_NODES = 20_000

/**
 * 估算一组在场节点「代表的历史体量」。
 *
 * 规则：
 *  1. 对每个节点，沿 `sourceEventSeqs` 递归展开（替换副本 → 其代表的原始事件）；
 *  2. 有来源的节点：只计其原始事件文本（桩文本是替代品，不计入历史）；
 *  3. 无来源的节点：按其自身文本计；
 *  4. 全部 seq 全局去重，避免同一历史被多个桩重复计入。
 */
export function estimateHiddenHistory(session: Session, nodeSeqs: readonly number[]): HiddenHistoryEstimate {
  const events = sessionEvents(session)
  const nodes = new Set<number>()
  for (const s of nodeSeqs) if (Number.isInteger(s) && s >= 0) nodes.add(s)

  const origin = new Set<number>()
  const seen = new Set<number>(nodes)
  const queue: number[] = [...nodes]
  const leafSeqs: number[] = []
  let visited = 0
  while (queue.length > 0 && visited < MAX_NODES) {
    const seq = queue.pop() as number
    visited += 1
    const ev = events[seq] as { sourceEventSeqs?: unknown } | undefined
    const raw = ev?.sourceEventSeqs
    if (!Array.isArray(raw) || raw.length === 0) {
      leafSeqs.push(seq)
      continue
    }
    for (const s of raw) {
      if (typeof s !== 'number' || !Number.isInteger(s) || s < 0 || seen.has(s)) continue
      seen.add(s)
      queue.push(s)
      origin.add(s)
    }
  }

  const measured = new Set<number>()
  let chars = 0
  let cjkChars = 0
  const measure = (seq: number): void => {
    if (measured.has(seq)) return
    measured.add(seq)
    for (const face of rawEventFaces(session, seq)) {
      chars += face.text.length
      cjkChars += countCjkChars(face.text)
    }
  }
  for (const seq of origin) measure(seq)
  for (const seq of leafSeqs) measure(seq)

  return {
    originSeqs: [...origin].sort((a, b) => a - b),
    chars,
    cjkChars,
    tokens: Math.ceil(estTokensFromStats(chars, cjkChars)),
  }
}
