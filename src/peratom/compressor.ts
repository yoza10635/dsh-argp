/**
 * PeratomCompressor（Stage-1，plan P1）：eager 轮末熵降管线。
 *
 * 宿主身份（plan §0）：**普通 cordis 服务，非 ctx.compaction 服务位**——Stage-2 的
 * ArgpGraphEngine 独占 compaction 位，本服务走事件钩子，失败隔离免费获得。
 *
 * 触发与发射的两段式设计（对齐 dsh-session 不变量）：
 *  - `agent/status: idle` 钩子触发（spike 06 idle 判定口径）：此刻当轮已闭
 *    （agent-loop kick() 在 turn/end 之后的 finally 才 setPhase idle）。收集当轮原子 +
 *    发起 LLM 调用（网络等待在轮外，不阻塞任何 waterfall），结果暂存 pending 队列。
 *  - 事务发射推迟到下一次 `agent/pre-step`（新轮已开、其 user/message 尚未入日志——
 *    loop 先跑 preStep 再落盘消息）。原因：dsh-session invariant 规定 tool/result 的
 *    surface replace 是"durable turn work"，只允许在 open turn 内追加；idle 时 openTurn=null。
 *    推迟发射不损缓存语义：前 N-1 轮前缀字节不变，替换发生在下一次请求组装之前。
 *  - 防重复 turn 处理：prepare 阶段按 (session, turn) 记账，重复 idle / pre-step 幂等跳过。
 *  - `compressCurrentTurn(session)` 公开入口：立即收集+调用+发射（P4 溢出三步路径②与单测用），
 *    绕过两段式延迟。
 *
 * 单次调用覆盖当轮全部可压原子（user quotes 拆分 + tool extract/summary），OpenAI 兼容
 * fetch + JSON Schema 强制输出（复用 spike 30/32 模式；response_format 被端点拒绝时
 * 自动降级为裸 prompt + 防御性 JSON 提取——spike 32 extractJson 同款）。
 *
 * 无再压缩路径（决策⑦）：collect 只取"原始态"原子——已是 U-info/replace 副本的 seq 直接跳过；
 * 版本链成员硬排除（gate 决策序①）；被中断轮次整轮排除（filterInterruptedAtoms 内嵌）。
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { compactCheckpointSource, CompactionId } from '@deepseek-ai/dsh-compaction'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { ARG_NS, SPLIT_THRESHOLD_CHARS } from './types.js'
import { completeViaDshLlm } from './llm-adapter.js'
import type { DshLlmSpec } from './llm-adapter.js'
import type { SplitResolution } from './split.js'
import { buildDialogText, buildInfoText, resolveSplit } from './split.js'
import {
  DEFAULT_SMALL_RESULT_CHARS,
  buildToolNameIndex,
  buildVersionChainIndex,
  collectInterruptedTurns,
  fidelityGuard,
  filterInterruptedAtoms,
  projectSurfaceText,
  rNeedCompress,
  turnCompressible,
  userIsLong,
} from './gate.js'
import type { GateOptions, GateToolResult, GateUserLong, NeedCompress, VersionChainIndex } from './gate.js'

/** 插件署名（dialog replace / U-info append 副本的 message.source.plugin）。 */
const PLUGIN_NAME = 'dsh-argp'

// ---------------------------------------------------------------------------
// 配置与端点解析（spike 32 resolveEndpoint 同款环境变量口径）
// ---------------------------------------------------------------------------

export interface PeratomCompressorConfig {
  /** OpenAI 兼容 chat/completions 端点全 URL。缺省按环境变量解析（见 defaultEndpoint）。 */
  endpoint?: string
  apiKey?: string
  model?: string
  /**
   * dsh-llm 生产后端（P5 后债务清算）：经宿主 LlmRuntime 调用，优先于 endpoint/apiKey
   * （fetch 遗产路径）。多模型分工：与 declarer 各自指定 provider/model（lite 档可选）。
   */
  llm?: DshLlmSpec
  /** 用户长消息阈值（默认 SPLIT_THRESHOLD_CHARS=100）。 */
  splitThresholdChars?: number
  /** 工具结果小结果阈值（默认 DEFAULT_SMALL_RESULT_CHARS=512）。 */
  smallResultChars?: number
  /** 单次请求超时（默认 180s，spike 32 同款）。 */
  timeoutMs?: number
  /**
   * 追加到请求体的模板参数（如本地 llama.cpp + Qwen3 的 `{ enable_thinking: false }`）。
   * 实测（spike 33）：llama.cpp 上 json_schema 强制输出与思考模式互斥——不关思考则
   * token 预算全烧在推理上、content 为空。官方端点会忽略未知字段，默认不发送。
   */
  chatTemplateKwargs?: Record<string, unknown>
  /**
   * 初始 tool 对照表（设计 §6-2）：工具种类名 → 压缩档位。运行期可经
   * `setToolPolicy(toolName, policy)` 增改；构造期传入便于单测 / 声明式挂载预置。
   */
  toolPolicies?: ReadonlyMap<string, NeedCompress>
  /** fetch 注入点（测试替身；生产缺省 globalThis.fetch）。 */
  fetchImpl?: typeof fetch
}

interface ResolvedEndpoint {
  endpoint: string
  model: string
  apiKey: string
}

/**
 * 缺省端点解析：ARGP_MODEL_SOURCE=qwen-local → QWEN_BASE/QWEN_MODEL（本地推理）；
 * 否则 DeepSeek 生产端点 + DEEPSEEK_API_KEY。apiKey 缺失 → disabled（静默跳过，
 * 开发/离线环境零网络副作用）。
 */
export function defaultEndpoint(env: NodeJS.ProcessEnv = process.env): ResolvedEndpoint | null {
  if (env['ARGP_MODEL_SOURCE'] === 'qwen-local') {
    return {
      endpoint: (env['QWEN_BASE'] ?? 'http://127.0.0.1:8080/v1') + '/chat/completions',
      model: env['QWEN_MODEL'] ?? 'Qwen3.8-27B',
      apiKey: env['DEEPSEEK_API_KEY'] ?? 'dummy-local',
    }
  }
  const apiKey = env['DEEPSEEK_API_KEY']
  if (apiKey === undefined || apiKey === '') return null
  return {
    endpoint: env['DEEPSEEK_BASE'] !== undefined ? env['DEEPSEEK_BASE'] + '/chat/completions' : 'https://api.deepseek.com/chat/completions',
    model: env['DEEPSEEK_MODEL'] ?? 'deepseek-v4-flash',
    apiKey,
  }
}

// ---------------------------------------------------------------------------
// 结构化输出契约（JSON Schema 强制 + 防御性提取双保险）
// ---------------------------------------------------------------------------

export interface UserSplit {
  seq: number
  quotes: string[]
  /**
   * 资料（info）压缩档位（设计 §10 决策 1 补实现）：`false`=原样 / `summary`=概括 /
   * `extract`=逐字摘取。用户源 info 默认偏好 summary（设计 L54：叙述类资料保意图）；
   * shell 报错/含精确串 → extract。缺省（undefined）= 不压缩（引擎回退原文切片）。
   */
  infoLevel?: 'false' | 'summary' | 'extract'
  /**
   * 压缩后的 info 文本：summary/extract 时必填；false 或缺省时留空/缺省（引擎回退逐字切片）。
   * 单档（§10 决策 7"只有两种形态"）：surface 放此文本、`data[ARG_NS].summary` 存同文本。
   */
  infoText?: string
}

export interface ToolAction {
  seq: number
  /**
   * 工具结果压缩档位（设计对称：与 info 同级显式信号）。`false`=全是关键内容、
   * 无可压空间（典型如完整源码模块）→ 原子保原文、不 emit replace；`text` 此时可空。
   */
  level: 'extract' | 'summary' | 'false'
  text: string
}

/** 单次压缩调用的输出形状（覆盖当轮全部可压原子）。 */
export interface CompressDecision {
  splits: UserSplit[]
  tools: ToolAction[]
}

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['splits', 'tools'],
  properties: {
    splits: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['seq', 'quotes', 'infoLevel', 'infoText'],
        properties: {
          seq: { type: 'integer' },
          quotes: { type: 'array', items: { type: 'string' } },
          infoLevel: { type: 'string', enum: ['false', 'summary', 'extract'] },
          infoText: { type: 'string' },
        },
      },
    },
    tools: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['seq', 'level', 'text'],
        properties: {
          seq: { type: 'integer' },
          level: { type: 'string', enum: ['extract', 'summary', 'false'] },
          text: { type: 'string' },
        },
      },
    },
  },
} as const

/**
 * 防御性 JSON 提取（spike 32 extractJson 原样复刻）：剥 <think>、剥代码围栏、
 * 从最后一个 } 向前找配对 {。response_format 失效的端点上兜底。
 */
function extractJson(raw: string): unknown {
  const cleaned = raw.replace(/<think>[\s\S]*?<\/think>/g, '')
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(cleaned)
  const text = (fenced?.[1] ?? cleaned).trim()
  try { return JSON.parse(text) as unknown } catch { /* fall through */ }
  const last = text.lastIndexOf('}')
  if (last > 0) {
    for (let first = text.lastIndexOf('{', last - 1); first >= 0; first = text.lastIndexOf('{', first - 1)) {
      try { return JSON.parse(text.slice(first, last + 1)) as unknown } catch { /* keep scanning */ }
    }
  }
  return undefined
}

/** 模型输出 → CompressDecision（信任边界：seq/quotes/level/text 全字段校验，异形丢弃）。 */
export function normalizeDecision(cand: unknown): CompressDecision | null {
  if (cand === null || typeof cand !== 'object') return null
  const o = cand as { splits?: unknown; tools?: unknown }
  if (!Array.isArray(o.splits) && !Array.isArray(o.tools)) return null
  const splits: UserSplit[] = []
  const tools: ToolAction[] = []
  for (const item of Array.isArray(o.splits) ? o.splits : []) {
    const seq = (item as { seq?: unknown } | undefined)?.seq
    const quotes = (item as { quotes?: unknown } | undefined)?.quotes
    if (typeof seq !== 'number' || !Number.isInteger(seq)) continue
    if (!Array.isArray(quotes)) continue
    const rawLevel = (item as { infoLevel?: unknown } | undefined)?.infoLevel
    // 档位白名单；缺省/异形 → undefined（planReplacements 回退逐字，安全方向）。
    const infoLevel = rawLevel === 'summary' || rawLevel === 'extract' || rawLevel === 'false' ? rawLevel : undefined
    const rawText = (item as { infoText?: unknown } | undefined)?.infoText
    // summary/extract 必须带非空压缩文本，否则弃档（回退逐字）；false/缺省允许空串。
    const infoText = typeof rawText === 'string'
      && (infoLevel === undefined || infoLevel === 'false' || rawText.length > 0)
      ? rawText
      : undefined
    splits.push({ seq, quotes: quotes.filter((q): q is string => typeof q === 'string'), infoLevel, infoText })
  }
  for (const item of Array.isArray(o.tools) ? o.tools : []) {
    const t = item as { seq?: unknown; level?: unknown; text?: unknown }
    if (typeof t?.seq !== 'number' || !Number.isInteger(t.seq)) continue
    // 显式"不压"信号（设计对称：与 info 同级）。text 可空，planReplacements 直接跳过。
    if (t.level === 'false') {
      tools.push({ seq: t.seq, level: 'false', text: typeof t.text === 'string' ? t.text : '' })
      continue
    }
    if (t.level !== 'extract' && t.level !== 'summary') continue
    if (typeof t.text !== 'string' || t.text.length === 0) continue
    tools.push({ seq: t.seq, level: t.level, text: t.text })
  }
  return { splits, tools }
}

// ---------------------------------------------------------------------------
// 收集结构
// ---------------------------------------------------------------------------

/** collectCurrentTurn 产物：当轮可压原子（已内嵌中断过滤 + 版本链硬排除 + 门控筛选）。 */
export interface CurrentTurnCollect {
  turn: number
  /** 当轮事件 seq 区间（含 step 标记等非 surface 事件）；sourceEventSeqs ⊆ 区间断言的界。 */
  startSeq: number
  endSeq: number
  /** 当轮命中中断标记：两个数组恒空，调用门控必然 false（零 LLM 调用）。 */
  interrupted: boolean
  userLong: GateUserLong[]
  toolResults: GateToolResult[]
}

/** 一次压缩尝试的观测记录（测试断言直接读这里）。 */
export interface CompressRecord {
  at: string
  turn: number | null
  called: boolean
  ms?: number
  parseFailed?: boolean
  appliedReplaces?: number
  skippedFallbackDialog?: number
  /** 保真守卫拒绝的 tool 副本数（缺高信号 token → 原文保面，spike 34 驱动）。 */
  skippedFidelity?: number
  /** 模型显式选 false（不压）的 tool 原子数（设计对称：与 info 同级显式信号）。 */
  skippedFalse?: number
  /** no-op 守卫拒的 tool 副本数（收益 ≤5% 视同 false；spike 37 全文照抄实锤驱动）。 */
  skippedNoopGain?: number
  /** 被保真守卫拒的副本中缺失的高信号 token 汇总（诊断白压根因）。 */
  fidelityMissing?: string[]
  /**
   * summary 副本的守卫审计清单（level-aware 放行，spike36 复盘驱动）：
   * 模型自选 summary 时守卫不做硬拒，但原文中被概括丢掉的高信号 token
   * 逐条入账，供 LLM 审核 / 人工审核事后评判。空数组/缺省 = 无丢失。
   */
  summaryDropped?: string[]
  /** 当轮原子 seq 快照（prompt 里给出的值；调试 seq 信任边界用）。 */
  atomSeqs?: { userLong: number[]; toolResults: number[] }
  /** 模型原始 decision（解析成功时留痕；调试服从率用）。 */
  decision?: CompressDecision
  /** 模型原始响应文本（无论解析成败都留痕；调试 parseFailed 根因用）。 */
  rawResponse?: string
  /** dsh-llm 后端的 usage 记账（fetch 后端经 meteringFetch 在 spike 侧独立计量）。 */
  usage?: { promptTokens: number; completionTokens: number }
  anomalies?: number
  error?: string
  /**
   * called=false 时的短路原因（观测"合法跳过"用，review 严重发现 #2）：
   * - 'no-candidate'：门控判无可压原子（纯 dialog / 全部原子 < 小结果阈值或版本链成员）；
   * - 'interrupted'：轮次被中断（error/aborted 收尾，半成品原子被 filterInterruptedAtoms 清空，
   *   与"门控判无可压"是两种性质——前者是环境/模型失败，后者是正常判决。19:50 复跑里
   *   LLM 连接失败的轮次曾误显示为 no-candidate，VK-plan-c 无法区分，故拆出）；
   * - 缺省（undefined）表示 called=true 的正常调用。
   */
  skipReason?: 'no-candidate' | 'interrupted'
}

// ---------------------------------------------------------------------------
// 引擎侧确定性规划（模型输出 → 落盘动作，全部策略裁决在引擎侧）
// ---------------------------------------------------------------------------

interface PlannedStep {
  kind: 'replace' | 'append'
  type: 'user/message' | 'tool/result'
  /** replace 的目标 seq（append 时无意义）。 */
  at: number
  data: unknown
  sourceEventSeqs: number[]
}

interface PlanResult {
  steps: PlannedStep[]
  replaces: number
  skippedFallbackDialog: number
  skippedFidelity: number
  /** 模型显式选 false（不压）的 tool 原子数（设计对称：与 info 同级显式信号）。 */
  skippedFalse: number
  /** no-op 守卫拒的 tool 副本数（收益 ≤5% 视同 false；spike 37 全文照抄实锤驱动）。 */
  skippedNoopGain: number
  /** 被保真守卫拒的副本中，缺失的高信号 token 汇总（诊断"白压"根因用）。 */
  fidelityMissing: string[]
  /** summary 副本审计：被概括丢弃的高信号 token（放行但入账，供审核）。 */
  summaryDropped: string[]
  anomalies: number
}

/** user/message 副本载荷：plugin 署名；meta 存在时挂 data[ARG_NS]（U-info 标记 + summary）。 */
function userCopyPayload(text: string, meta?: { sourceSeq: number; summary: string }): unknown {
  const msg = createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: PLUGIN_NAME },
  })
  if (meta === undefined) return msg
  return { ...msg, [ARG_NS]: { info: true, sourceSeq: meta.sourceSeq, summary: meta.summary } }
}

/**
 * tool/result replace 副本载荷。dsh-session 硬约束："tool/result surface replacement
 * may change only content"——替换数据与原文除 message.content[0].content 外必须逐键
 * 深度相等，因此**不能**携带 data[ARG_NS] 元数据（多余键即拒绝）。
 * summary 语义由副本正文本身承载；P3 recall_summary 对无 data[ARG_NS].summary 的节点
 * 按设计降级返回 extract 副本文本，信息无损。防再压缩由版本链索引天然兜住：
 * 原文与副本同 (tool|args) 键 → 计数 ≥2 → 双双硬排除。
 */
function toolCopyPayload(origData: unknown, text: string): unknown {
  const d = origData as { message?: { content?: Array<Record<string, unknown>> } } | undefined
  const block = d?.message?.content?.[0]
  if (block === undefined || typeof block !== 'object') {
    throw new Error('peratom-compressor: cannot rewrite tool/result without a content block')
  }
  return {
    ...(d as object),
    message: {
      ...(d?.message as object),
      content: [{ ...block, content: [{ type: 'text', text }] }],
    },
  }
}

/**
 * 引擎侧规划：模型输出过信任边界（seq 必须命中本轮收集集，先到先得去重），
 * 用户消息过 resolveSplit 全套保守策略（定位失败回退 dialog / 覆盖率翻转 / 空隙归 info）。
 * 返回落盘步骤序列；steps 为空 = 本轮无可落地动作（不开发务括号）。
 */
export function planReplacements(
  collect: CurrentTurnCollect,
  decision: CompressDecision,
  events: readonly SessionEvent[],
): PlanResult {
  const userBySeq = new Map(collect.userLong.map(u => [u.seq, u]))
  const toolBySeq = new Map(collect.toolResults.map(t => [t.seq, t]))
  const steps: PlannedStep[] = []
  let replaces = 0
  let skippedFallbackDialog = 0
  let skippedFidelity = 0
  let skippedFalse = 0
  let skippedNoopGain = 0
  const fidelityMissing: string[] = []
  const summaryDropped: string[] = []
  let anomalies = 0

  const seenUserSeqs = new Set<number>()
  for (const split of decision.splits) {
    const atom = userBySeq.get(split.seq)
    if (atom === undefined) { anomalies += 1; continue }
    if (seenUserSeqs.has(split.seq)) { anomalies += 1; continue }
    seenUserSeqs.add(split.seq)
    const res: SplitResolution = resolveSplit(atom.text, split.quotes)
    if (res.kind === 'split') {
      const dialogText = buildDialogText(atom.text, res.dialogSpans)
      const verbatimInfo = buildInfoText(atom.text, res.infoSpans)
      // info 压缩（设计 §10 决策 1 补实现）：summary/extract 用模型压缩文本；false/缺省回退逐字切片。
      // guard 的 original 取 info 片段而非整条 user——dialog 里的路径/错误码不要求出现在 info 副本中。
      let infoText = verbatimInfo
      if (split.infoLevel === 'summary' || split.infoLevel === 'extract') {
        const candidate = split.infoText ?? ''
        if (candidate.length > 0) {
          const guard = fidelityGuard(verbatimInfo, candidate)
          if (!guard.ok) {
            if (split.infoLevel === 'summary') {
              // summary 审计放行：概括天然丢精确串，缺失清单入账供审核（与 tool summary 同档纪律）。
              summaryDropped.push(...guard.missing)
              infoText = candidate
            } else {
              // extract 硬拒：缺任一高信号 token 即回退逐字（原文保面，错误方向只往"少压"错）。
              skippedFidelity += 1
              fidelityMissing.push(...guard.missing)
            }
          } else {
            infoText = candidate
          }
        }
      }
      steps.push({
        kind: 'replace',
        type: 'user/message',
        at: atom.seq,
        data: userCopyPayload(dialogText),
        sourceEventSeqs: [atom.seq],
      })
      replaces += 1
      // U-info append：tail-only 管线（flush 窗口内恰落在当轮尾部）；原文天然留日志。
      // 单档（§10 决策 7）：surface 放压缩态文本，data[ARG_NS].summary 存同文本——
      // recall_summary 直接可用；recall_detail 从 append-only 日志还原原文。
      steps.push({
        kind: 'append',
        type: 'user/message',
        at: atom.seq,
        data: userCopyPayload(infoText, { sourceSeq: atom.seq, summary: infoText }),
        sourceEventSeqs: [atom.seq],
      })
    } else if (res.kind === 'info-only') {
      // 零标注退化：整条 U-info 单事件 replace（纯资料消息的自然情形，非特判）。
      steps.push({
        kind: 'replace',
        type: 'user/message',
        at: atom.seq,
        data: userCopyPayload(atom.text, { sourceSeq: atom.seq, summary: atom.text }),
        sourceEventSeqs: [atom.seq],
      })
      replaces += 1
    } else {
      // fallback-dialog / unsplit（覆盖率翻转、无余量、空消息）：放弃拆分，整条保留 dialog。
      skippedFallbackDialog += 1
    }
  }

  const origDataBySeq = new Map<number, unknown>()
  for (const event of events) {
    if (event.type === 'tool/result') origDataBySeq.set(event.seq, event.data)
  }
  const seenToolSeqs = new Set<number>()
  for (const action of decision.tools) {
    if (action.level === 'false') { skippedFalse += 1; continue } // 显式"不压"：原子保原文，不 emit replace
    const atom = toolBySeq.get(action.seq)
    if (atom === undefined) { anomalies += 1; continue }
    if (seenToolSeqs.has(action.seq)) { anomalies += 1; continue }
    seenToolSeqs.add(action.seq)
    // no-op 守卫（spike 37 两次跑批实锤）：模型对源码类 tool-result 全文照抄（2.5K 模块
    // 原样返回）→ fidelityGuard 平凡通过（token 全在）→ 零收益 replace 白花 surface 换代、
    // 污染逐原子审计。副本收益 ≤5%（含持平/变长）视同显式 false：原文保面 + 计数入账
    //（对齐 87c66de「拿不准选 false」的设计意图）。用户路径不受此守卫——'info-only' 的
    // 同文 replace 承载 data[ARG_NS] 元数据，有结构作用，不能省。
    if (action.text.length >= atom.text.length * 0.95) {
      skippedNoopGain += 1
      continue
    }
    // 保真守卫（spike 34 驱动）：原文的高信号 token 必须在副本里 verbatim 存活。
    // level-aware 分级（spike36 复盘驱动）：extract 维持硬拒——缺任一 token 即拒绝替换、
    // 原文保面（错误方向只允许往"少压"错）；summary 是模型自选的概括档，概括天然
    // 会丢精确串，硬拒会让该档位永远不可用——改为审计式放行：缺失清单入账
    // summaryDropped，供 LLM 审核 / 人工审核事后评判。
    const guard = fidelityGuard(atom.text, action.text)
    if (!guard.ok) {
      if (action.level === 'summary') {
        summaryDropped.push(...guard.missing)
      } else {
        skippedFidelity += 1; fidelityMissing.push(...guard.missing); continue
      }
    }
    steps.push({
      kind: 'replace',
      type: 'tool/result',
      at: action.seq,
      data: toolCopyPayload(origDataBySeq.get(action.seq), action.text),
      sourceEventSeqs: [action.seq],
    })
    replaces += 1
  }

  return { steps, replaces, skippedFallbackDialog, skippedFidelity, skippedFalse, skippedNoopGain, fidelityMissing, summaryDropped, anomalies }
}

// ---------------------------------------------------------------------------
// Prompt（单次调用覆盖当轮全部可压原子；规则前言吸收 P0 三层对冲 + 已知债务 6 修正）
// ---------------------------------------------------------------------------

const PROMPT_RULES = [
  '你是会话压缩器。输入列出本轮全部可压缩原子，你的输出决定它们的压缩形态。',
  '',
  '## 用户长消息拆分（splits）',
  '- 把每条用户消息划分为指令(dialog)片段与资料(info)余量：指令=用户要求做的事、提出的问题、约束或偏好（包括"注意X""别动Y""用Z"限定语）；资料=用户粘贴/附带的一切非指令内容，例如日志、代码、配置、报错、外部评审/方案、文献原文、说明、表格数据、文档引用等。',
  '- quotes 数组逐字抄写每段连续指令原文：必须与原文完全一致（空白、换行、标点、大小写、全角半角、emoji），禁止改写、翻译、增删任何字符。',
  '- 片段按原文出现顺序排列；同一段连续指令不要拆成多段，不相邻的指令不要合并成一段。',
  '- 保守纪律：任何可能包含指令语义的片段都必须抄入 quotes——错误方向只允许往 dialog 错；存档/转发类引导语算资料。',
  '- 未抄写的部分视为资料，会被聚合成可压缩副本。',
  '- infoLevel 决定资料的压缩方式：false=资料很短或无可压空间（infoText 留空，保留原文）；summary=叙述性资料（外部评审、方案、讨论记录、说明）用简洁概括，概括中保留出现的函数名、版本号、API、路径、错误码等精确串；extract=含精确串的资料（shell 报错、日志行、代码片段）逐字保留有用部分、丢弃噪声，infoText 必须与原文逐字一致（空白、换行、标点、大小写全部原样），禁止改写。',
  '- 档位判断：外部 AI 的评审/方案/记录、长段说明 → summary；shell 报错、含错误码/路径/行号的内容 → extract；短小或无冗余 → false。',
  '- infoText 必填：summary/extract 时写入压缩结果；false 时留空字符串。',
  '',
  '## 工具结果压缩（tools）',
  '- 对每个原子做三选一判断（extract / summary / false），把判断与压缩内容写进同一条 {"seq","level","text"}：',
  '- 判断为摘取（level="extract"）：内容含结构化数据或精确串（日志行、配置、代码、命令输出），关键信息依赖原文措辞 → text 必须是所选原文片段的逐字完整拷贝——与原文完全一致（空白、换行、标点、大小写、全角半角、emoji 全部原样），禁止改写、翻译、增删、合并或重新组织任何字符；未选中的行视为噪声直接丢弃。',
  '- 判断为摘要（level="summary"）：内容是冗长叙述性文本、概括不损失关键信息 → text 用简洁概括替换全文；若原文仍有个别必须精确保留的串（错误码、标识符、路径等），把它们原样写进概括文本。',
  '- 判断为不压（level="false"）：原子全是关键内容、无可丢弃的噪声（典型如完整源码模块、无任何冗余的文本）→ 保留原文，text 留空字符串，不要输出压缩副本。',
  '- 档位由你按每个原子的内容性质自行判断，不必统一。判断标准：确有可丢弃的噪声/冗余时才选 extract 或 summary（text 必须比原文显著缩短）；没有可压空间或拿不准时，显式选 false（从输出里省略该 seq 也等价）。禁止全文照抄一遍（如 level=extract 且 text≈原文），那既浪费 token 又无压缩收益。',
  '',
  '## 输出',
  '只输出一个 JSON 对象：{"splits":[{"seq":<整数>,"quotes":["…"]}],"tools":[{"seq":<整数>,"level":"extract"|"summary"|"false","text":"…"}]}',
  '- seq 原样返回输入给出的值；不需要压缩的原子不要出现在输出里（视为保原文）。',
].join('\n')

function buildPrompt(collect: CurrentTurnCollect): string {
  const atoms: string[] = []
  for (const u of collect.userLong) {
    atoms.push(`<ATOM seq=${u.seq} kind="user-long">\n${u.text}\n</ATOM>`)
  }
  for (const t of collect.toolResults) {
    atoms.push(`<ATOM seq=${t.seq} kind="tool-result">\n${t.text}\n</ATOM>`)
  }
  return PROMPT_RULES + '\n\n' + atoms.join('\n\n')
}

// ---------------------------------------------------------------------------
// LLM 调用（OpenAI 兼容 fetch + JSON Schema 强制输出，失败降级裸 prompt）
// ---------------------------------------------------------------------------

interface ChatCompletionResponse {
  choices?: { message?: { content?: string } }[]
  usage?: { completion_tokens?: number }
}

async function postChat(
  fetchImpl: typeof fetch,
  ep: ResolvedEndpoint,
  prompt: string,
  timeoutMs: number,
  useJsonSchema: boolean,
  chatTemplateKwargs?: Record<string, unknown>,
): Promise<string> {
  const body: Record<string, unknown> = {
    model: ep.model,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0,
  }
  if (useJsonSchema) {
    // JSON Schema 强制输出：支持结构化解码的端点上消灭自由生成失控（plan 已知债务 7 的
    // "服务端 schema 约束"路径）；strict=true 要求全部字段受 schema 约束。
    body['response_format'] = {
      type: 'json_schema',
      json_schema: { name: 'argp_peratom_turn', strict: true, schema: OUTPUT_SCHEMA },
    }
  }
  if (chatTemplateKwargs !== undefined && Object.keys(chatTemplateKwargs).length > 0) {
    body['chat_template_kwargs'] = chatTemplateKwargs
  }
  const res = await fetchImpl(ep.endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ep.apiKey}` },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const json = await res.json() as ChatCompletionResponse
  return json.choices?.[0]?.message?.content ?? ''
}

// ---------------------------------------------------------------------------
// PeratomCompressor 服务本体
// ---------------------------------------------------------------------------

interface PendingEntry {
  session: Session
  collect: CurrentTurnCollect
  decision: CompressDecision
  /** callAndStash 创建的观测记录；簿记直接写回此引用，不依赖 records 数组反查。 */
  record: CompressRecord
}

/** 日志尾部的 open turn（flush 时刻 compaction 括号的 owner；null=standalone）。 */
function detectOpenTurn(session: Session): number | null {
  for (let index = session.events.length - 1; index >= 0; index -= 1) {
    const event = session.events[index]
    if (event === undefined) continue
    if (event.type === 'turn/start') return (event.data as { turn: number }).turn
    if (event.type === 'turn/end') return null
  }
  return null
}

export class PeratomCompressor {
  static inject = [] as const

  readonly splitThresholdChars: number
  readonly smallResultChars: number
  readonly timeoutMs: number
  private readonly chatTemplateKwargs: Record<string, unknown> | undefined

  private readonly endpoint: ResolvedEndpoint | null
  private readonly dshLlm: DshLlmSpec | null
  private readonly fetchImpl: typeof fetch
  private readonly ctx: Context

  /** LLM 压缩调用计数器（纯 dialog 轮零调用的断言读这里）。 */
  private _calls = 0
  get calls(): number { return this._calls }

  /** 全部压缩尝试记录（时间序）。 */
  readonly records: CompressRecord[] = []

  /** 当前暂存待发射的事务数（测试/P4 判断 stash 是否就绪）。 */
  get pendingCount(): number { return this.pending.length }

  /** 防重复 turn 处理：(session, turn) 记账于 prepare 阶段。 */
  private readonly doneTurns = new WeakMap<Session, Set<number>>()
  /** idle 阶段产出、等待下一次 open-turn 窗口发射的事务。 */
  private readonly pending: PendingEntry[] = []
  /**
   * tool 对照表 / 作者声明（设计 §6-2）：工具种类名 → 压缩档位。
   * 未声明的工具缺席默认（走大小启发式）；声明只放宽/收紧启发式，不可越过版本链硬排除。
   */
  private readonly toolPolicies = new Map<string, NeedCompress>()

  /** tool 对照表查询（测试 / P4 接线断言用）。 */
  getToolPolicy(toolName: string): NeedCompress | undefined { return this.toolPolicies.get(toolName) }

  /**
   * 声明某工具种类的压缩档位（设计 §6-2 `setToolPolicy(toolName, policy)`）。
   * `false`=永不压缩（保原文）；'summary'=一句话概括；'extract'=关键内容摘录。
   * 传 `undefined` 撤销声明（回启发式默认）。声明是"提示非命令"：
   * 版本链硬排除（决策序第 1 层）与保真守卫仍先行，错误方向只往"少压"错。
   */
  setToolPolicy(toolName: string, policy: NeedCompress | undefined): void {
    if (policy === undefined) this.toolPolicies.delete(toolName)
    else this.toolPolicies.set(toolName, policy)
  }

  /** 门控选项快照：大小阈值 + tool 对照表（prepare / compressCurrentTurn 两处同口径）。 */
  private gateOptions(): GateOptions {
    return { smallResultChars: this.smallResultChars, toolPolicies: this.toolPolicies }
  }

  constructor(ctx: Context, config: PeratomCompressorConfig = {}) {
    this.ctx = ctx
    this.dshLlm = config.llm ?? null
    this.endpoint = config.endpoint !== undefined
      ? {
          endpoint: config.endpoint,
          model: config.model ?? 'deepseek-v4-flash',
          apiKey: config.apiKey ?? '',
        }
      : (config.apiKey !== undefined ? { endpoint: config.endpoint ?? 'https://api.deepseek.com/chat/completions', model: config.model ?? 'deepseek-v4-flash', apiKey: config.apiKey } : defaultEndpoint())
    this.splitThresholdChars = config.splitThresholdChars ?? SPLIT_THRESHOLD_CHARS
    this.smallResultChars = config.smallResultChars ?? DEFAULT_SMALL_RESULT_CHARS
    this.timeoutMs = config.timeoutMs ?? 180_000
    this.chatTemplateKwargs = config.chatTemplateKwargs
    if (config.toolPolicies !== undefined) {
      for (const [name, policy] of config.toolPolicies) this.toolPolicies.set(name, policy)
    }
    this.fetchImpl = config.fetchImpl ?? ((...args) => fetch(...args))
    if (this.endpoint === null && this.dshLlm === null) {
      ctx.logger.warn('peratom-compressor: no LLM backend resolved (set DEEPSEEK_API_KEY, pass config.llm, or pass config); compressor disabled')
    }

    // 触发钩子：轮末 idle（当轮必已闭）→ 收集 + LLM（异步，不阻塞状态切换）。
    ctx.on('agent/status', ({ agent, status }) => {
      if (status !== 'idle') return
      void this.prepareCurrentTurn(agent.session).catch(error => {
        this.ctx.logger.warn(`peratom-compressor prepare failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    })

    // 发射窗口：下一次 agent/pre-step（open turn 已开、新 user/message 未落盘）。
    // 只 flush 已就绪条目，绝不 await 网络——waterfall 内同步追加后立刻放行。
    ctx.on('agent/pre-step', async ({ agent }, next) => {
      this.flushStashed(agent.session)
      return next()
    })
  }

  // -- 收集 ---------------------------------------------------------------

  /**
   * 收集当前（最新闭合）轮的可压原子。内嵌三道确定性过滤：
   * ① 中断轮整轮排除（filterInterruptedAtoms，interrupted=true 时数组恒空）；
   * ② 版本链成员硬排除（决策④，need_compress=false）；③ 大小启发式门控。
   * 无再压缩路径：U-info 副本 / plugin checkpoint 一律跳过（决策⑦）。
   */
  collectCurrentTurn(session: Session): CurrentTurnCollect | null {
    const events = session.events
    let closed: number | null = null
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i]
      if (event?.type === 'turn/end') { closed = (event.data as { turn: number }).turn; break }
    }
    if (closed === null) return null
    // 归轮按位置：user/message 事件不携带 turn 字段（rc.2 类型），其归属 =
    // 当前开放的 turn（turn/start..end 之间的日志区间）。assistant/tool 事件自带
    // turn 字段做二次校验。替换副本（dialog/U-info/tool copy）落在本窗口内的，
    // 由 plugin-source 跳过 / 版本链同键硬排除兜住，不会被误当原始态原子。
    const turnEvents: SessionEvent[] = []
    let startSeq = Number.MAX_SAFE_INTEGER
    let endSeq = -1
    let open: number | null = null
    for (const event of events) {
      if (event.type === 'turn/start') { open = (event.data as { turn: number }).turn; continue }
      if (event.type === 'turn/end') { open = null; continue }
      if (open !== closed) continue
      if (event.type !== 'user/message') {
        const turn = (event.data as { turn?: unknown } | undefined)?.turn
        if (typeof turn === 'number' && turn !== closed) continue
      }
      turnEvents.push(event)
      if (event.seq < startSeq) startSeq = event.seq
      if (event.seq > endSeq) endSeq = event.seq
    }
    return this.collectFromWindow(session, closed, turnEvents, startSeq, endSeq)
  }

  /**
   * 收集当前开放轮（最后一条 turn/start 之后、尚无 turn/end）的可压原子。
   * P4 溢出三步路径②专用：溢出发生在 open turn 的请求上，第②步要降熵的正是
   * 这个 open turn——closed-turn 口径会错压上一闭合轮（2026-08-29 review 中项，
   * 与 per-atom 设计 §8「对当前轮大原子降熵」的意图不符）。过滤与闭合轮完全
   * 同款（中断/版本链/大小门控；U-info/checkpoint 跳过）；open turn 无 turn/end，
   * 不会出现在中断集里。无 turn/start（会话头）返回 null。
   */
  collectOpenTurn(session: Session): CurrentTurnCollect | null {
    const events = session.events
    let openSeq = -1
    let openTurn: number | null = null
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i]
      if (event?.type === 'turn/start') {
        openSeq = event.seq
        openTurn = (event.data as { turn: number }).turn
        break
      }
    }
    if (openTurn === null || openSeq < 0) return null
    // open 窗口 = 最后一条 turn/start 之后的全部事件。user/message 按位置归属；
    // assistant/tool 事件自带 turn 字段做二次校验（应恒等于 openTurn）。
    const turnEvents: SessionEvent[] = []
    let startSeq = Number.MAX_SAFE_INTEGER
    let endSeq = -1
    for (const event of events) {
      if (event.seq <= openSeq) continue
      if (event.type !== 'user/message' && event.type !== 'turn/end') {
        const turn = (event.data as { turn?: unknown } | undefined)?.turn
        if (typeof turn === 'number' && turn !== openTurn) continue
      }
      turnEvents.push(event)
      if (event.seq < startSeq) startSeq = event.seq
      if (event.seq > endSeq) endSeq = event.seq
    }
    return this.collectFromWindow(session, openTurn, turnEvents, startSeq, endSeq)
  }

  /** 窗口→候选的共享尾部（中断/版本链/大小门控 + 原子化）。closed/open 两口径共用。 */
  private collectFromWindow(
    session: Session,
    turn: number,
    turnEvents: SessionEvent[],
    startSeq: number,
    endSeq: number,
  ): CurrentTurnCollect | null {
    const events = session.events
    if (endSeq < 0) return null

    const interrupted = collectInterruptedTurns(events).has(turn)
    const collect: CurrentTurnCollect = {
      turn,
      startSeq,
      endSeq,
      interrupted,
      userLong: [],
      toolResults: [],
    }
    if (interrupted) return collect

    // 中断过滤作用于投影前的原始事件流：被标记轮次的残留原子不进候选。
    const chain: VersionChainIndex = buildVersionChainIndex(events)
    const nameByCall = buildToolNameIndex(events)
    const rawAtoms: Array<GateUserLong | GateToolResult> = []
    for (const event of turnEvents) {
      const data = event.data as Record<string, unknown> | undefined
      if (event.type === 'user/message') {
        // 无再压缩路径：U-info 聚合副本已是压缩态；plugin 无标记副本是 checkpoint/X。
        const source = (data as { source?: { kind?: string } } | undefined)?.source?.kind
        if (source === 'plugin') continue
        const text = projectSurfaceText(event)
        if (userIsLong(text, this.splitThresholdChars)) {
          rawAtoms.push({ kind: 'user-long', seq: event.seq, turn, text })
        }
        continue
      }
      if (event.type === 'tool/result') {
        const callId = (data as { message?: { source?: { callId?: string } } } | undefined)?.message?.source?.callId
        const text = projectSurfaceText(event)
        // 工具种类名（callId→name 反查）：tool 对照表 / 作者声明的查找键（设计 §6-2）。
        const toolName = callId !== undefined ? nameByCall.get(callId) : undefined
        rawAtoms.push({ kind: 'tool-result', seq: event.seq, turn, text, callId, toolName })
      }
      // assistant/message 不压缩（设计 §1）。
    }
    const survivors = filterInterruptedAtoms(rawAtoms, events)
    for (const atom of survivors) {
      if (atom.kind === 'user-long') {
        collect.userLong.push(atom)
      } else if (rNeedCompress(atom, chain, this.gateOptions()) !== false) {
        collect.toolResults.push(atom)
      }
    }
    return collect
  }

  // -- 两段式：idle 准备 → pre-step 发射 ----------------------------------

  /** idle 触发段：记账防重 → 收集 → 门控 → LLM → 暂存待发射。返回观测记录。 */
  async prepareCurrentTurn(session: Session): Promise<CompressRecord | null> {
    const collect = this.collectCurrentTurn(session)
    if (collect === null) return null
    const done = this.doneTurns.get(session) ?? new Set<number>()
    this.doneTurns.set(session, done)
    if (done.has(collect.turn)) return null // 防重复 turn 处理
    done.add(collect.turn)

    const chain = buildVersionChainIndex(session.events)
    if (collect.interrupted) {
      const record: CompressRecord = { at: new Date().toISOString(), turn: collect.turn, called: false, skipReason: 'interrupted' }
      this.records.push(record)
      return record // 中断轮：error/aborted 收尾，半成品不进候选（宁全勿漏）
    }
    if (!turnCompressible([...collect.userLong, ...collect.toolResults], chain, this.gateOptions())) {
      const record: CompressRecord = { at: new Date().toISOString(), turn: collect.turn, called: false, skipReason: 'no-candidate' }
      this.records.push(record)
      return record // 纯 dialog / 版本链成员 / 全小结果：零调用短路
    }
    return this.callAndStash(session, collect)
  }

  /** 发射段：把该 session 的全部就绪事务落入下一次 open-turn 窗口（同步追加，吞错记账）。 */
  flushStashed(session: Session): void {
    while (true) {
      const idx = this.pending.findIndex(e => e.session === session)
      if (idx < 0) return
      const [entry] = this.pending.splice(idx, 1)
      try {
        this.flushEntry(entry.session, entry.collect, entry.decision, entry.record)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.ctx.logger.warn(`peratom-compressor flush failed: ${message}`)
        this.records.push({ at: new Date().toISOString(), turn: entry.collect.turn, called: true, error: message })
      }
    }
  }

  /** 公开入口（P4 溢出三步路径② / 单测）：立即收集+调用+发射，绕过两段式延迟。 */
  async compressCurrentTurn(session: Session): Promise<CompressRecord | null> {
    const collect = this.collectCurrentTurn(session)
    return this.compressCollect(session, collect)
  }

  /**
   * 公开入口（P4 溢出三步路径② 生产接线）：对当前 open turn 立即收集+调用+发射。
   * 溢出发生在 open turn 的请求上，第②步必须压它而不是最新闭合轮（设计 §8
   * 「对当前轮大原子降熵」；closed 口径会错压上一轮，2026-08-29 review 中项）。
   * open turn 压缩后标记 doneTurns——该轮闭合时 idle prepare 因已 done 跳过
   * （替换副本本就被 plugin-source 排除，双保险防重压缩）。
   */
  async compressOpenTurn(session: Session): Promise<CompressRecord | null> {
    const collect = this.collectOpenTurn(session)
    return this.compressCollect(session, collect)
  }

  /** 共享压缩尾部：防重记账 + 中断/无候选短路 + callAndStash + 立即 flush。 */
  private async compressCollect(session: Session, collect: CurrentTurnCollect | null): Promise<CompressRecord | null> {
    if (collect === null) return null
    const done = this.doneTurns.get(session) ?? new Set<number>()
    this.doneTurns.set(session, done)
    if (done.has(collect.turn)) return null
    done.add(collect.turn)
    const chain = buildVersionChainIndex(session.events)
    if (collect.interrupted) {
      const record: CompressRecord = { at: new Date().toISOString(), turn: collect.turn, called: false, skipReason: 'interrupted' }
      this.records.push(record)
      return record
    }
    if (!turnCompressible([...collect.userLong, ...collect.toolResults], chain, this.gateOptions())) {
      const record: CompressRecord = { at: new Date().toISOString(), turn: collect.turn, called: false, skipReason: 'no-candidate' }
      this.records.push(record)
      return record
    }
    const entry = await this.callAndStash(session, collect)
    this.flushStashed(session)
    return entry
  }

  // -- LLM 调用与暂存 ------------------------------------------------------

  private async callAndStash(session: Session, collect: CurrentTurnCollect): Promise<CompressRecord> {
    const record: CompressRecord = { at: new Date().toISOString(), turn: collect.turn, called: true }
    this.records.push(record)
    if (this.endpoint === null && this.dshLlm === null) {
      record.error = 'no-endpoint'
      return record
    }
    this._calls += 1
    const started = Date.now()
    try {
      const prompt = buildPrompt(collect)
      record.atomSeqs = {
        userLong: collect.userLong.map(u => u.seq),
        toolResults: collect.toolResults.map(t => t.seq),
      }
      this.ctx.logger.info(`[argp-peratom] compressor: turn ${collect.turn} candidates=${collect.userLong.length}u+${collect.toolResults.length}r (dsh-llm=${this.dshLlm !== null})`)
      let raw: string
      let ms = Date.now() - started
      if (this.dshLlm !== null) {
        // dsh-llm 生产后端：GenerateOptions 无 response_format——schema 约束仅在 fetch
        // 后端可用，此路径一次到位，依赖 extractJson 兜底解析（无 schema 重试舞蹈）。
        const res = await completeViaDshLlm(this.ctx, this.dshLlm, prompt, this.timeoutMs)
        raw = res.text
        if (res.usage !== undefined) record.usage = res.usage
        ms = Date.now() - started
      } else {
        try {
          raw = await postChat(this.fetchImpl, this.endpoint as ResolvedEndpoint, prompt, this.timeoutMs, true, this.chatTemplateKwargs)
          ms = Date.now() - started
        } catch (schemaError) {
          // response_format 被端点拒绝/网络抖动：spike 30/32 兼容模式重试一次（裸 prompt）。
          raw = await postChat(this.fetchImpl, this.endpoint as ResolvedEndpoint, prompt, this.timeoutMs, false, this.chatTemplateKwargs)
          ms = Date.now() - started
          record.anomalies = (record.anomalies ?? 0) + 1
          void schemaError
        }
      }
      record.ms = ms
      record.rawResponse = raw
      const decision = normalizeDecision(extractJson(raw))
      if (decision === null) {
        record.parseFailed = true
        return record // 解析失败静默跳过：本轮保原文（安全方向），绝不阻断会话
      }
      record.decision = decision
      this.pending.push({ session, collect, decision, record })
      const extract = decision.tools.filter(t => t.level === 'extract').length
      const summary = decision.tools.filter(t => t.level === 'summary').length
      const falseActions = decision.tools.filter(t => t.level === 'false').length
      this.ctx.logger.info(`[argp-peratom] compressor: turn ${collect.turn} decision splits=${decision.splits.length} extract=${extract} summary=${summary} false=${falseActions} ms=${record.ms ?? '?'}`)
    } catch (error) {
      record.error = error instanceof Error ? error.message : String(error)
      this.ctx.logger.warn(`[argp-peratom] compressor: turn ${collect.turn} LLM call failed: ${record.error}`)
    }
    return record
  }

  // -- 事务括号发射（仿 t1：start..end，双事件/多事件发射，断言内联）-------

  private flushEntry(session: Session, collect: CurrentTurnCollect, decision: CompressDecision, record: CompressRecord): void {
    const plan = planReplacements(collect, decision, session.events)
    if (plan.steps.length === 0) {
      // 全部动作被拒（保真守卫/回退）或零动作：不开空事务，但统计直接落账到本次记录。
      record.skippedFallbackDialog = plan.skippedFallbackDialog
      record.skippedFidelity = plan.skippedFidelity
      record.skippedFalse = plan.skippedFalse
      record.skippedNoopGain = plan.skippedNoopGain
      if (plan.summaryDropped.length > 0) record.summaryDropped = plan.summaryDropped
      record.fidelityMissing = plan.fidelityMissing
      record.anomalies = (record.anomalies ?? 0) + plan.anomalies
      return
    }

    const openTurn = detectOpenTurn(session)
    const compactionId = CompactionId('argp-peratom-' + randomUUID())
    const lifecycle = { compactionId, turn: openTurn }
    const genBefore = session.surface.replaceGeneration

      session.append('compaction/start', lifecycle)
      try {
        let replaceCount = 0
        for (const step of plan.steps) {
          // UI checkpoint 关联（2026-08-28）：user/message 替换副本的 source 换为
          // compact checkpoint（与图剪墓碑同款）——宿主 CompactionNodeView 据此把事务
          // 渲染为"上下文已压缩"节点。tool/result 替换受宿主硬约束"只许改 content"，
          // 不能换 source，故仅 user/message 步骤携带。
          if (step.type === 'user/message') {
            step.data = { ...(step.data as Record<string, unknown>), source: compactCheckpointSource(compactionId) }
          }
        // 断言 1：sourceEventSeqs ⊆ 当轮区间（越界即 bug，plan P1 硬性要求）。
        for (const seq of step.sourceEventSeqs) {
          if (seq < collect.startSeq || seq > collect.endSeq) {
            throw new Error(
              `sourceEventSeq ${seq} outside current turn range [${collect.startSeq}, ${collect.endSeq}] (turn ${collect.turn})`,
            )
          }
        }
        if (step.kind === 'replace') {
          const g0 = session.surface.replaceGeneration
          session.append(step.type, step.data as never, {
            surfaceOp: { op: 'replace', start: step.at, end: step.at },
            sourceEventSeqs: step.sourceEventSeqs,
          })
          const g1 = session.surface.replaceGeneration
          // 断言 2：每次 replace 必须推进 replaceGeneration（替换真实落地）。
          if (g1 <= g0) {
            throw new Error(`replaceGeneration did not advance after replacing seq ${step.at} (${g0} -> ${g1})`)
          }
          replaceCount += 1
        } else {
          session.append(step.type, step.data as never, {
            surfaceOp: 'append',
            sourceEventSeqs: step.sourceEventSeqs,
          })
        }
      }
      // 人类可读压缩摘要（2026-08-28 UI 联调）：compaction/summary 是 off-surface 日志
      // 事件（模型不可见），WebUI 的 compaction 节点用它作为展示文本——不发则节点显示
      // "压缩摘要不可用"（宿主 CompactionNodeView 的 summary 缺省文案）。payload 按
      // 宿主 CompactionSummary 词典填诚实值；类型收窄走 as never（代码库既有惯例）。
      const extractCount = decision.tools.filter(t => t.level === 'extract').length
      const summaryCount = decision.tools.filter(t => t.level === 'summary').length
      const falseCount = decision.tools.filter(t => t.level === 'false').length
      const shadowedChars = [...collect.userLong, ...collect.toolResults]
        .reduce((sum, atom) => sum + atom.text.length, 0)
      session.append('compaction/summary', {
        ...lifecycle,
        summary: [{
          type: 'text',
          text: `ARGP 逐原子压缩（turn ${collect.turn}）：${decision.splits.length} 拆分 / ${extractCount} 提取 / ${summaryCount} 摘要 / ${falseCount} 保原文；原文保留在 append-only 日志，recall_detail(seq) 可取回`,
        }],
        shadowedRange: { start: collect.startSeq, end: collect.endSeq },
        shadowedSeqs: plan.steps.flatMap(step => step.sourceEventSeqs),
        shadowedTokenCount: Math.ceil(shadowedChars / 3.5),
        provider: this.dshLlm?.provider ?? 'fetch',
        model: this.dshLlm?.model ?? (this.endpoint !== null ? String(this.endpoint) : 'disabled'),
      } as never)
      session.append('compaction/end', lifecycle)
      // 断言 2b：整事务代数增量 === replace 步数（append 步不推进代数）。
      const delta = session.surface.replaceGeneration - genBefore
      if (delta !== replaceCount) {
        throw new Error(`replaceGeneration delta ${delta} != planned replaces ${replaceCount}`)
      }
      // 统计在事务成功落地后记账（失败路径由 flushStashed 的 error 记录承载）。
      record.appliedReplaces = replaceCount
      record.skippedFallbackDialog = plan.skippedFallbackDialog
      record.skippedFidelity = plan.skippedFidelity
      record.skippedFalse = plan.skippedFalse
      record.skippedNoopGain = plan.skippedNoopGain
      if (plan.summaryDropped.length > 0) record.summaryDropped = plan.summaryDropped
      record.fidelityMissing = plan.fidelityMissing
      record.anomalies = (record.anomalies ?? 0) + plan.anomalies
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      try {
        session.append('compaction/end', { ...lifecycle, error: message })
      } catch {
        // 关闭失败保留未配对 start，可被 inspectCompactionEntryState 检出（t1 同纪律）
      }
      throw error
    }
  }
}

export default PeratomCompressor
