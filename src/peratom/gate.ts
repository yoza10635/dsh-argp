/**
 * Per-Atom 门控模块（Stage-1 共用，plan P1）：确定性判定，LLM 只执行动作。
 *
 * 职责三块（全部纯函数、零 LLM / 零 Session 运行时依赖，cite-declarer 同用）：
 *  1. 中断轮次一等公民化（dsh 0.1.1-rc.2 diff「利好 2」）：从事件流精确识别被中断轮次，
 *     `filterInterruptedAtoms` 把同一 turn 的残留原子排除——半成品内容不得进入压缩候选 /
 *     引用图 / 版本链。compressor 与 atomize 同步过滤（本函数是唯一事实源）。
 *  2. 压缩门控谓词：turnCompressible / rNeedCompress（设计 §2 决策序）。
 *  3. 版本链索引（决策④硬排除的判定底座）：同 (tool name + arguments) 键出现 ≥2 次的
 *     R 原子视为版本链成员，强制 need_compress=false。
 *
 * 中断标记口径（rc.2 实测类型 + diff 文档双读，宁全勿漏）：
 *  - `assistant/message.interrupted === true`：流中取消轮次把已交付前缀 finalize 为该事件
 *    （dsh-session types.d.ts 明文）；未派发工具调用缺席 → 该 turn 的原子全是残留。
 *  - `turn/end.reason.kind ∈ { aborted, error, interrupted }`：非正常收尾（取消 / 失败 /
 *    崩溃孤儿收尾）。diff 文档记作「turn/end 新增 interrupted?: true」，rc.2 实际落在
 *    reason.kind 上；本模块两种形态都认，另兼容 data.interrupted 直挂标记的前向演进。
 *  - completed / blocked / max-tokens 不算中断：内容已完整交付（max-tokens 只是截断），
 *    后续步骤可能合法引用，排除方向只允许往"少压"错。
 */
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { isArgpUserInfo } from './types.js'

// ---------------------------------------------------------------------------
// 1. 中断轮次识别
// ---------------------------------------------------------------------------

/** turn/end 非正常收尾的 reason.kind 集合（见文件头口径说明）。 */
export const INTERRUPTED_END_REASONS = ['aborted', 'error', 'interrupted'] as const
export type InterruptedEndReason = (typeof INTERRUPTED_END_REASONS)[number]

/**
 * 判定一个 turn/end 事件是否把该轮标记为中断。
 * 三种形态：reason.kind 命中集合 / data.interrupted 直挂真值（diff 文档口径）/ 兜底未知形状不误判。
 */
export function isInterruptedTurnEnd(data: unknown): boolean {
  if (data === null || typeof data !== 'object') return false
  const d = data as { interrupted?: unknown; reason?: unknown }
  if (d.interrupted === true) return true
  const kind = (d.reason as { kind?: unknown } | undefined)?.kind
  return typeof kind === 'string'
    && (INTERRUPTED_END_REASONS as readonly string[]).includes(kind)
}

/** assistant/message 的流中取消前缀标记（rc.2 实测落点）。 */
function isInterruptedAssistantMessage(data: unknown): boolean {
  return (data as { interrupted?: unknown } | undefined)?.interrupted === true
}

/**
 * 全日志扫描：返回被中断轮次的 turn 号集合。
 *
 * 只依赖事件形状（不依赖 Session 实例），离线重放/单测/引擎三处共用同一实现。
 * 无 turn/end 的开放轮（正在进行的轮）不算中断——它还没有"收尾"，等 idle 判定时它必然已闭。
 */
export function collectInterruptedTurns(events: readonly SessionEvent[]): Set<number> {
  const turns = new Set<number>()
  for (const event of events) {
    if (event.type === 'turn/end') {
      if (isInterruptedTurnEnd(event.data)) {
        const turn = (event.data as { turn?: unknown }).turn
        if (typeof turn === 'number') turns.add(turn)
      }
      continue
    }
    if (event.type === 'assistant/message' && isInterruptedAssistantMessage(event.data)) {
      const turn = (event.data as { turn?: unknown }).turn
      if (typeof turn === 'number') turns.add(turn)
    }
  }
  return turns
}

/**
 * 排除被中断轮次的残留原子：同一 turn 号的全部原子一并剔除（半成品没有"保留一半"的价值——
 * 未派发工具调用已缺席，已交付前缀是截断产物）。输入宽容：atoms 只要求带 turn 字段，
 * 引擎 Atom / gate GateAtom / 测试桩通用。
 */
export function filterInterruptedAtoms<T extends { readonly turn: number }>(
  atoms: readonly T[],
  events: readonly SessionEvent[],
): T[] {
  const interrupted = collectInterruptedTurns(events)
  if (interrupted.size === 0) return [...atoms]
  return atoms.filter(a => !interrupted.has(a.turn))
}

// ---------------------------------------------------------------------------
// 2. 版本链索引（决策④：版本链成员 → 强制 false，哈希/去重依赖 verbatim）
// ---------------------------------------------------------------------------

export interface VersionChainIndex {
  /** 出现 ≥2 次的版本链键（tool name|arguments JSON，或无 issuer 时的 text| 回退键）。 */
  readonly keys: Set<string>
  /** 单个 R 原子的链键（callId 查 issuer；缺失退化为 text| 键，与图引擎 rKey 同构）。 */
  keyOf(callId: string | undefined, text: string): string
  /** 成员判定：键在 keys 集合中即版本链成员。 */
  isMember(callId: string | undefined, text: string): boolean
}

/**
 * 全日志构建 R 版本链键索引。与 argp-graph-engine findVersionDuplicates 的 rKey 口径一致
 * （issuer A 的 tool name + arguments JSON；callId 缺失退化 r.text），但判定更保守：
 * 键重复出现即视为链成员（图引擎还要求 inDegree=0 才剪旧版，压缩侧不做图分析，
 * 一律按 verbatim 保护处理——错误方向只允许往"少压"错）。
 */
/**
 * 全日志构建 callId → 工具种类名索引（tool 对照表的查找底座，设计 §6-2）。
 * 工具名只落在 assistant/message 内嵌 tool-call 块的 name 上；tool/result 只带 callId，
 * 故须经 callId 反查。无 issuer（孤立 tool/result）→ 无名字，策略表跳过，落回启发式默认。
 */
export function buildToolNameIndex(events: readonly SessionEvent[]): Map<string, string> {
  const nameByCall = new Map<string, string>()
  for (const event of events) {
    if (event.type !== 'assistant/message') continue
    const content = (event.data as { message?: { content?: unknown[] } } | undefined)?.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content as Array<{ type?: string; id?: string; name?: string }>) {
      if (block?.type !== 'tool-call' || typeof block.id !== 'string') continue
      if (typeof block.name === 'string' && block.name.length > 0) nameByCall.set(block.id, block.name)
    }
  }
  return nameByCall
}

export function buildVersionChainIndex(events: readonly SessionEvent[]): VersionChainIndex {
  // pass 1：callId → issuer 键（assistant/message 内嵌 tool-call 块）
  const issuerKeyByCall = new Map<string, string>()
  for (const event of events) {
    if (event.type !== 'assistant/message') continue
    const content = (event.data as { message?: { content?: unknown[] } } | undefined)?.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content as Array<{ type?: string; id?: string; name?: string; arguments?: unknown }>) {
      if (block?.type !== 'tool-call' || typeof block.id !== 'string') continue
      const argsStr = block.arguments !== undefined
        ? (typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments))
        : ''
      issuerKeyByCall.set(block.id, (block.name ?? '?') + '|' + argsStr)
    }
  }
  // pass 2：R 计数（同键 ≥2 即链）
  const counts = new Map<string, number>()
  for (const event of events) {
    if (event.type !== 'tool/result') continue
    const callId = (event.data as { message?: { source?: { callId?: string } } } | undefined)
      ?.message?.source?.callId
    const key = callId !== undefined && issuerKeyByCall.has(callId)
      ? issuerKeyByCall.get(callId)!
      : 'text|' + surfaceTextOf(event).trim()
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const keys = new Set<string>()
  for (const [key, count] of counts) if (count >= 2) keys.add(key)
  return {
    keys,
    keyOf(callId, text) {
      return callId !== undefined && issuerKeyByCall.has(callId)
        ? issuerKeyByCall.get(callId)!
        : 'text|' + text.trim()
    },
    isMember(callId, text) {
      return keys.has(this.keyOf(callId, text))
    },
  }
}

// ---------------------------------------------------------------------------
// 3. 投影与门控谓词
// ---------------------------------------------------------------------------

/**
 * 事件 → 模型可见文本（text + tool-call 概要 + tool-result 内层 text；reasoning 不算）。
 * 与 argp-graph-engine eventText 同口径的本模块私有镜像：gate 保持叶子纯净，
 * 不为投影功能反向依赖 Stage-2 引擎模块。
 */
export function projectSurfaceText(event: SessionEvent): string {
  const data = event.data as Record<string, unknown> | undefined
  const parts: string[] = []
  if (event.type === 'tool/call') {
    const d = data as { name?: string; arguments?: unknown }
    parts.push('[tool-call ' + (d?.name ?? '?') + '(' + (typeof d?.arguments === 'string' ? d.arguments : JSON.stringify(d?.arguments ?? {})) + ')]')
    return parts.join('\n')
  }
  const rawContent = event.type === 'user/message'
    ? (data as { content?: unknown[] } | undefined)?.content
    : (data as { message?: { content?: unknown[] } } | undefined)?.message?.content
  const content = Array.isArray(rawContent)
    ? (rawContent as Array<{ type: string; text?: string; name?: string; arguments?: unknown; content?: Array<{ type: string; text?: string }> }>)
    : []
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    if (block.type === 'tool-call') {
      parts.push('[tool-call ' + (block.name ?? '?') + '(' + (typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments ?? {})) + ')]')
    }
    if (block.type === 'tool-result') {
      for (const inner of block.content ?? []) {
        if (inner.type === 'text' && typeof inner.text === 'string') parts.push(inner.text)
      }
    }
  }
  return parts.join('\n')
}

function surfaceTextOf(event: SessionEvent): string {
  return projectSurfaceText(event)
}

/** need_compress 三档（false=保原文 / summary=一句话概括 / extract=关键内容摘录）。 */
export type NeedCompress = false | 'summary' | 'extract'

/**
 * 大小启发式默认档线（字符）：低于此值的工具结果不值得 replace（净增副本元数据 +
 * KV 失效代价，与 t1 minSpanChars=512 的实测理由同源）；达到即 extract 档。
 */
export const DEFAULT_SMALL_RESULT_CHARS = 512

export interface GateUserLong {
  kind: 'user-long'
  seq: number
  turn: number
  text: string
}

export interface GateToolResult {
  kind: 'tool-result'
  seq: number
  turn: number
  text: string
  callId?: string
  /** 工具种类名（tool 对照表 / 作者声明的查找键，设计 §6-2）。callId→name 由 buildToolNameIndex 解析。 */
  toolName?: string
}

export type GateAtom = GateUserLong | GateToolResult

export interface GateOptions {
  /** 工具结果小结果阈值（默认 DEFAULT_SMALL_RESULT_CHARS）。 */
  smallResultChars?: number
  /**
   * 工具作者声明通道 / **tool 对照表**（设计 §6-2 `setToolPolicy(toolName, policy)`，
   * 决策序第 2 层，上限提示非强制）。键 = **工具种类名**（toolName），非 callId——
   * 同一工具的多条结果应同档。声明只放宽/收紧启发式默认，不可越过版本链硬排除
   * （决策序第 1 层先行短路）；未声明的工具走大小启发式（缺席默认，设计 §6-5）。
   */
  toolPolicies?: ReadonlyMap<string, NeedCompress>
}

/**
 * R 档位裁决（设计 §2 决策序，先命中先生效）：
 * ① 版本链成员 → false（硬排除，不可覆盖）；② 作者声明 → 采纳；③ 大小启发式默认。
 */
export function rNeedCompress(
  r: Pick<GateToolResult, 'text' | 'callId' | 'toolName'>,
  chain: VersionChainIndex,
  opts: GateOptions = {},
): NeedCompress {
  if (chain.isMember(r.callId, r.text)) return false
  // ② 作者声明 / tool 对照表：按工具种类名查（非 callId）。孤立结果无名字 → 跳过声明。
  const declared = r.toolName !== undefined ? opts.toolPolicies?.get(r.toolName) : undefined
  if (declared !== undefined) return declared
  const threshold = opts.smallResultChars ?? DEFAULT_SMALL_RESULT_CHARS
  return r.text.length >= threshold ? 'extract' : false
}

/** user 长消息判定（拆分阈值，types.ts SPLIT_THRESHOLD_CHARS 口径由调用方传入比较）。 */
export function userIsLong(text: string, thresholdChars: number): boolean {
  return text.length > thresholdChars
}

/**
 * 当轮调用门控（plan P1 / 设计 §2 调用门控）：仅当轮存在可压缩原子才触发 LLM——
 * 任一 User 长消息 ∨ 任一 Tool 的 need_compress ≠ false。纯 dialog 轮直接跳过：
 * 零调用（计数器可断言）、零 cites（孤立原子规则）。
 */
export function turnCompressible(atoms: readonly GateAtom[], chain: VersionChainIndex, opts: GateOptions = {}): boolean {
  return atoms.some(a =>
    a.kind === 'user-long'
    || (a.kind === 'tool-result' && rNeedCompress(a, chain, opts) !== false),
  )
}

// ---------------------------------------------------------------------------
// extract 保真守卫（决策③"四类保真串"的结构化表达，spike 34 实证驱动）
//
// spike 34 首轮实测：本地模型对 ALL-CAPS 错误码保真完美（6/6），但对 file:line 定位
// （2/6）与 key=value 分隔符（victim=txn#8821 被转述成 victim txn#8821）会不自觉改写。
// 本守卫从原文确定性地提取高信号 token，要求 extract 逐一 verbatim 包含；
// 缺任一个即拒绝该条替换（原文保面）——错误方向只允许往"少压"错，
// 与版本链硬排除同一保守哲学。纯函数，可单测。
// ---------------------------------------------------------------------------

const LOAD_BEARING_PATTERNS: RegExp[] = [
  /https?:\/\/\S+/g,                                   // URL
  /\/?\b[\w.@-]+(?:\/[\w.@-]+)+\.\w{1,8}\b/g,          // 带扩展名的路径（绝对或相对，含前导斜杠）
  /\b[\w-]+\.\w{1,8}:\d+(?::\d+)?\b/g,                 // file:line[:col] 行号定位
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, // UUID
  /\b[a-f0-9]{32,64}\b/gi,                             // 十六进制哈希
  /\b[A-Z][A-Z0-9_]{4,}\b/g,                           // ALL_CAPS 错误码
  /\b[A-Za-z][\w-]{1,28}=[^\s,;'"]{2,}/g,              // key=value（保留原分隔符）
]

/** 提取原文中必须在压缩副本里 verbatim 存活的高信号 token（去重）。 */
export function findLoadBearingTokens(text: string): string[] {
  const out = new Set<string>()
  for (const re of LOAD_BEARING_PATTERNS) {
    re.lastIndex = 0
    let m: RegExpExecArray | null = re.exec(text)
    while (m !== null) {
      const tok = m[0].replace(/[.,;)\]}'"]+$/, '')
      if (tok.length >= 4) out.add(tok)
      if (m.index === re.lastIndex) re.lastIndex += 1 // 防零宽匹配死循环
      m = re.exec(text)
    }
  }
  return [...out]
}

/** 守卫裁决：missing 非空 = 该副本不得落盘（原文保面）。 */
export function fidelityGuard(originalText: string, compressedText: string): { ok: boolean; missing: string[] } {
  const missing = findLoadBearingTokens(originalText).filter(tok => !compressedText.includes(tok))
  return { ok: missing.length === 0, missing }
}
