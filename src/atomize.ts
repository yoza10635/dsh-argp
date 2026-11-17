/**
 * ARGP 原子化模块（2.0 factor-only 收窄）：atomize + cites 提取（extractCites）+
 * user 分类（classifyUserMessage）+ ask 检测（looksAskText）。
 *
 * 读侧保留 `data.argpCites` 的归一化读（历史会话的 A 原子在 atomize 里照旧取用，见下）。
 *
 * 循环 import 规避：本模块**不** import hub 运行时。atomize 接收窄接口
 * {@link GraphBuildHost} 而非具体 class；hub 的 class 以
 * `this as unknown as GraphBuildHost` 传入（编译期断言，运行时即真实实例，
 * 私有字段经 host 类型可读写/重赋值）。依赖方向：hub → atomize（单向）。
 */
import type { Session } from '@deepseek-ai/dsh-session'
import type { Atom } from './argp-types.js'
import { sessionEvents, eventText } from './log-access.js'
import { matchCitesTail, parseCitesBlock } from './cites-strip.js'
import type { ParsedCite } from './cites-strip.js'
import { ARG_NS, isArgpUserInfo, isOwnSourceKind } from './llm/types.js'

/** cites 服从率度量台账（历史 C7-cites 口径；atomize 仍累计，诊断用）。 */
export interface CiteStats { aAtoms: number; declared: number; resolved: number; ambiguous: number; failed: number }

/**
 * 原子化访问引擎状态所需的窄接口。
 * 仅列出 atomize 实际读写的字段；hub 的 ArgpEngine 以
 * `this as unknown as GraphBuildHost` 满足它。
 */
export interface GraphBuildHost {
  session: Session | null
  citeStats: CiteStats
}

/**
 * A8（问题 10 修订）：ask 检测中英双语纯函数。
 * 英文：'?' / ask / what；中文：？/ 吗 / 呢 / 什么 / 怎么 / 如何 / 能否 / 能不能。
 * /帮我/ 由子串收窄为句首（^请|^帮我|^能不能|^能否），避免 "顺便帮我带个话" 之类
 * 非问句/非请求主语误命中；疑问词 什么/怎么/如何 仍保留子串（问句核心成分，方向保守=少剪）。
 * 导出供测试直接锁定收窄行为。
 */
export function looksAskText(text: string): boolean {
  const t = text.trim()
  return t.endsWith('?') || /\bask\b/i.test(t) || /\bwhat\b/i.test(t)
    || t.endsWith('？') || /吗[？?。]?$/.test(t) || /呢[？?。]?$/.test(t)
    || /什么|怎么|如何|能否|能不能/.test(t)
    || /^(请|帮我|能不能|能否)/.test(t)
}

/**
 * user/message 原子分类（P0 分类陷阱防线）。
 *
 * 顺序不可交换：先识别 `data[argp].info === true`（U-info 聚合副本——由 peratom 管线
 * 插件 append，但必须按 U 待遇参与剪枝候选），再落「非 `user` 源 → X」（注入/checkpoint）
 * 判定。若先判非-user-source，U-info 会被分类成 X 而**全局不可剪**，
 * P4 的候选放行将永远失效。
 *
 * 判据**版本无关**：真实用户消息恒带 `source.kind === 'user'`（宿主 createUserMessage
 * 约定）；注入（V3 `plugin` / V4 `argp` / `compact-checkpoint`）命中自有来源白名单 ⇒ X。
 * 其余非-user kind（dsh-agent merge 扩展）不是 X——由正交的性质轴（form）裁决。
 * 导出供测试直接锁定顺序行为（A8 先例）。
 */
export function classifyUserMessage(data: unknown): 'U' | 'X' {
  if (isArgpUserInfo(data)) return 'U'
  return isOwnSourceKind((data as { source?: { kind?: string } } | undefined)?.source?.kind) ? 'X' : 'U'
}

/**
 * 提取 A 文本尾部的 cites JSON（支持裸 JSON 与 ```json 围栏）；返回剥离后正文与引用列表。
 * V6 分级契约：条目可为字符串（视为 supporting）或 {t, l} 对象（l ∈ c|s|x）。
 * 形状不合法（如混入数字/对象缺 t）→ parseFailed 保守保护。
 */
export function extractCites(text: string): { body: string; cites: ParsedCite[]; attempted: boolean; parseFailed: boolean } {
  const matched = matchCitesTail(text)
  const attempted = text.includes('"cites"')
  if (matched === null) {
    return { body: text, cites: [], attempted, parseFailed: attempted }
  }
  const cites = parseCitesBlock(matched.raw)
  if (cites === null) {
    return { body: text, cites: [], attempted: true, parseFailed: true } // JSON 合法但形状不对 → 解析失败，保守保护
  }
  return { body: text.slice(0, text.length - matched.span).trimEnd(), cites, attempted: true, parseFailed: false }
}

/**
 * 原子化（§4.1）：只投影 surface 节点；U/X/R/A 四类（tool/call 不进 surface，无 T 类）。
 * cites 统计在 A 原子处累计。
 *
 * switch 认四类 surface 事件：`user/message` / `assistant/message` / `tool/result` /
 * `developer/message`；唯一不产出原子的 surface 类型是 `system/message`——
 *
 * node 0 保护（2026-09-10，dsh 0.1.5 起）：宿主把 system prompt 表示为 surface node 0 的
 * `system/message`，并在 surface.ts `assertSystemHeadRewrite` 里硬性保护——任何覆盖 node 0 的
 * replace 必须是"恰好覆盖该单节点的 system/message"，否则 throw。
 * `system/message` **静默跳过、不产出原子**，因此 node 0 永远不会进入 ARGP 的剪枝区间，
 * 上述宿主断言不会被触发。**这是有意依赖，不是巧合**——若日后要支持剪系统提示，
 * 必须同时改这里与宿主契约。
 *
 * `developer/message`（V4 保留类型：tool-addition / tool-removal 块；宿主 ContentBlockMap
 * 注释"providers and UI reject them until their producers and consumers are implemented
 * together"）不像 system head 那样被宿主硬保护，故**显式归类 X**（与 checkpoint 同档）：
 * 进原子台账（手动剪枝段在它处作为**有意边界**断开），但永不压缩、永不被剪。
 * 宿主若日后激活该类型，边界已在此定义，而不是一个意外的非原子漏点。
 */
export function atomize(host: GraphBuildHost, session: Session): Atom[] {
  const atoms: Atom[] = []
  for (const seq of session.surface.nodes) {
    const event = sessionEvents(session)[seq]
    if (event === undefined) continue
    const data = event.data as Record<string, unknown> | undefined
    const turn = typeof data?.turn === 'number' ? (data.turn as number) : 0
    if (event.type === 'user/message') {
      // P0 分类陷阱防线：先认 data[argp].info（U-info 聚合副本），再判 plugin-source → X
      const kind = classifyUserMessage(data)
      // P4：U-info 投影 sourceSeq（原始用户消息日志 seq）——历史 U-info 副本的恢复目标。
      const uInfoMeta = (data as Record<string, unknown> | undefined)?.[ARG_NS] as { sourceSeq?: unknown } | undefined
      const uSourceSeq = typeof uInfoMeta?.sourceSeq === 'number' ? (uInfoMeta.sourceSeq as number) : undefined
      const userAtom: Atom = { id: atoms.length, seq, type: kind, turn, text: eventText(session, seq), toolCallIds: [], cites: [], citesFailed: false }
      if (uSourceSeq !== undefined) userAtom.sourceSeq = uSourceSeq
      atoms.push(userAtom)
      continue
    }
    if (event.type === 'assistant/message') {
      const raw = eventText(session, seq)
      const stored = (data as { argpCites?: ParsedCite[] | string[] }).argpCites
      const parsed = extractCites(raw)
      // 优先用 surface 剥离时存入的 argpCites，保证跨压缩引用图不丢（文本已无 cites）。
      // ⚠ 归一化兜底（防 shape 漂移）：写回格式是 ParsedCite `{text, level}`，但历史存档
      // 与契约原文会出现别的形状；判据若只认单一形状，会把对象塞进 text →
      // 下游 .trim() 抛 TypeError → 压缩静默失败。
      // 故兼容 ParsedCite[] / string[]（V5 产物）/ graded {t,l}（契约原文）三种形状。
      let cites: ParsedCite[]
      if (Array.isArray(stored)) {
        cites = stored
          .map(c => {
            if (typeof c === 'string') return { text: c, level: 'supporting' as const }
            if (c !== null && typeof c === 'object') {
              const o = c as { text?: unknown; t?: unknown; level?: unknown; l?: unknown }
              const text = typeof o.text === 'string' ? o.text : typeof o.t === 'string' ? o.t : ''
              if (text === '') return null
              let level: ParsedCite['level'] = 'supporting'
              const lv = (typeof o.level === 'string' ? o.level : typeof o.l === 'string' ? o.l : '').trim().toLowerCase()
              if (lv === 'c' || lv === 'critical') level = 'critical'
              else if (lv === 'x' || lv === 'contextual') level = 'contextual'
              return { text, level }
            }
            return null
          })
          .filter((c): c is ParsedCite => c !== null)
      } else {
        cites = parsed.cites
      }
      const body = parsed.body
      const msg = (data as { message?: { content?: unknown[] } })?.message
      const content = Array.isArray(msg?.content) ? (msg?.content as { type: string; id?: string }[]) : []
      const toolCallIds = content.filter(b => b.type === 'tool-call' && typeof b.id === 'string').map(b => b.id as string)
      host.citeStats.aAtoms += 1
      if (cites.length > 0) host.citeStats.declared += cites.length
      if (parsed.parseFailed) host.citeStats.failed += 1
      atoms.push({ id: atoms.length, seq, type: 'A', turn, text: body, toolCallIds, cites, citesFailed: parsed.parseFailed })
      continue
    }
    if (event.type === 'tool/result') {
      // callId 双读（审查 P0-4）：model.source.callId（V4 常见）→ 内容块 toolCallId
      // （V3 内嵌 tool-result）→ message.toolCallId（V4 tool 角色）。与 factor-atoms 同口径。
      const d = data as {
        message?: {
          source?: { callId?: string }
          toolCallId?: string
          content?: Array<{ toolCallId?: string }>
        }
      }
      const rawCallId = d?.message?.source?.callId
        ?? d?.message?.content?.find(b => b?.toolCallId !== undefined)?.toolCallId
        ?? d?.message?.toolCallId
      const callId = typeof rawCallId === 'string' ? rawCallId : undefined
      atoms.push({ id: atoms.length, seq, type: 'R', turn, text: eventText(session, seq), toolCallIds: callId === undefined ? [] : [callId], cites: [], citesFailed: false })
      continue
    }
    if (event.type === 'developer/message') {
      // V4 保留类型（tool-addition / tool-removal；宿主尚未激活生产者/消费者）。
      // 显式 X：与 checkpoint 同档——进台账、永不被剪。
      atoms.push({ id: atoms.length, seq, type: 'X', turn, text: eventText(session, seq), toolCallIds: [], cites: [], citesFailed: false })
      continue
    }
  }
  return atoms
}
