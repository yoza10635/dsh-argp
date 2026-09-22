/**
 * PeratomCompressor 类型与端点解析叶子（P5 结构重构 Wave 3 第 5 步，C 报告 §4 B 表）。
 *
 * 从 1,520 行 `compressor.ts`（God Class）拆出的**纯类型 + 纯函数**侧：
 * 配置（PeratomCompressorConfig）+ 端点解析（ResolvedEndpoint / defaultEndpoint）
 * + 结构化输出契约类型（UserSplit / ToolAction / CompressDecision）
 * + 收集结构（CurrentTurnCollect）+ 观测记录（CompressRecord）
 * + 规划选项（PlanOptions）。
 *
 * 依赖方向（C 报告 §4 B 表）：本模块是**叶子**——不 import 任何 peratom 运行时，
 * 仅 type-only import（编译期擦除，无运行时环）：
 *   - `DshLlmSpec`（llm-adapter）：PeratomCompressorConfig.llm 的类型；
 *   - `GateUserLong` / `GateToolResult` / `NeedCompress`（gate）：
 *     CurrentTurnCollect 的原子数组 + tool 对照表值类型。
 * 依赖方：decision / collect / prompt / flush / compressor（组合根）单向依赖本模块。
 *
 * 行为逐字节不变：类型定义与 defaultEndpoint 函数体逐字保留，仅搬家。
 */
import type { DshLlmSpec } from './llm-adapter.js'
import type { GateUserLong, GateToolResult, NeedCompress } from './gate.js'

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
   * 轮末 pass 的"落地等待"上界（ms，默认 180_000 = 与 timeoutMs 同量级；0 = 不等）。
   *
   * 两段式设计下，轮末 idle 发起的 LLM 调用本应在**轮外**跑完，再由下一轮首个
   * `agent/pre-step` 发射事务。但若调用仍在飞、用户已经发了下一条消息，新轮首个
   * pre-step 无条目可发射 ⇒ 替换副本被顺延到新轮的**任意后续** pre-step：新轮前几步
   * 跑在未压缩上下文上（"付了钱的压缩"没兑现），替换点还落在轮中途（断一次前缀缓存）。
   * 真环境实证（session-77c64e66 #9，2026-09-21）：跨进程 resume 的在飞 pass 晚 **6 步**
   * 落盘（13:38:41 新轮开 → 13:44:41 才发）。
   *
   * 本旋钮让 pre-step **有界等待**在飞 pass：等到 ⇒ 本轮首个请求即带上压缩结果；
   * 超时 ⇒ 告警后照旧放行（事务在后续窗口落地，即旧行为）。
   */
  flushWaitMs?: number
  /** 诊断/遥测数组容量上限（保留最近 N 条，默认 256；P4.5 有界化）。 */
  telemetryCap?: number
  /**
   * 追加到请求体的模板参数**基础层**（如本地 llama.cpp + Qwen3 的 `{ enable_thinking: false }`）。
   * A 形态（带前缀）下，`resolveEffectiveCtk` 会以**最近一次真实 agent 请求的
   * `chat_template_kwargs` 为基础**再叠加本基础层 + `enable_thinking:false` 覆盖
   * （2026-09-19 定案：同态渲染 = 继承主链 ctk；强制 pt:true 反而把跨轮 reasoning
   * 渲染回来，LCP 12.7% < pt:false 30.3%）。C 形态（无前缀）直接用本基础层。
   * 实测（spike 33）：不关思考则 token 预算全烧在推理上、content 为空。
   */
  chatTemplateKwargs?: Record<string, unknown>
  /**
   * 压缩调用输出 cap（token，默认 16384）。plan 的 quotes 部分 = dialog 保真保留
   * （用户指令逐字转写，尺寸与原子原文同量级，不可省）⇒ cap 必须容纳"dialog +
   * tools plan"而不是"几百 token"——cap 截断 = JSON 不完整 = parse 失败 = 整轮
   * 保原文（2026-09-20 r3 实弹：3-turn 语料 T1 任务书全指令型 user 即打满 4096）。
   * 防爆余量按新窗口重标定：触发线 100,007 + agent maxTokens 32,768 + cap 16,384
   * ≈ 149K ≪ 262,144 墙（旧 174K 墙时代 4096 的"让 margin"推导已过时；KV 池
   * 933K 下 16K 响应的 prefill 搅动也可忽略）。
   */
  maxCompletionTokens?: number
  /**
   * A 形态前缀预算（token，默认 132000 ≈ 0.76×174080 墙）：前缀快照估算
   * `prompt_tokens` 超预算时**该次降级 C 形态**（丢前缀、只发指令）——防爆上限的
   * 核心防线（"全前缀或无前缀"二元门控，截断前缀要么质量最伤要么比 C 还贵）。
   * 估算源 = 最近一次真实 agent 请求的 usage.prompt_tokens（同源，误差 < 1K）。
   */
  prefixBudgetTokens?: number
  /**
   * 初始 tool 对照表（设计 §6-2）：工具种类名 → 压缩档位。运行期可经
   * `setToolPolicy(toolName, policy)` 增改；构造期传入便于单测 / 声明式挂载预置。
   */
  toolPolicies?: ReadonlyMap<string, NeedCompress>
  /**
   * HLS 修复档（PROPOSAL-token-ontology 组件 B，v1.2.0；默认 'trailer'）：
   * extract 被保真守卫拒收（缺高信号 token）时不再整条丢弃（收益全损），
   * 改为守卫机械补全——候选文本 + 缺失 token 按原文顺序尾注（`[restored]`），
   * 硬 token 保真由构造（100%），prose 损失受控（等同 summary 档），
   * 缺失清单入 `restoredByGuard` 台账（与 summaryDropped 同级可审）。
   * 'off' = v1.1 行为（拒收即原文保面）。
   */
  hlsMode?: 'trailer' | 'off'
  /**
   * HLS 经济学门槛 θ（默认 1，见 token-ontology `DEFAULT_HLS_ROI_THRESHOLD`）：
   * 仅当 ROI = 净释放预算 / 尾注占用 ≥ θ 才修复，否则退回原文保面。
   * 修复后比原文还长（ROI < 0）在任何 θ ≥ 0 下都被拒——这是代价盲的修正。
   */
  hlsRoiThreshold?: number
  /**
   * tool/result 压缩副本的头部标记开关（v1.6.1，默认 `true`）：
   * `true` = 副本正文头部拼 `[已压缩-摘取 seq=N]` / `[已压缩-摘要 seq=N]`，使 LLM 能
   * 把压缩副本与真实工具输出区分开（详见 `PlanOptions.marker` 的存在理由）。
   *
   * 宿主硬约束下这是**唯一**的 model-visible 通道（不能挂元数据、不能换 source），
   * 故默认开启；`false` 退回 v1.6 无标记行为（供 A/B 或极端省 token 场景逃生）。
   * 代价：每原子约 8-12 token，且收益门已计入该长度（`decision.planReplacements`）。
   */
  toolCopyMarker?: boolean
  /**
   * 逐原子压缩**跳过**的上下文形态（`source.form`，dsh-llm `ContextForm` 词汇表；
   * v1.6.1，缺省 `DEFAULT_SKIP_CONTEXT_FORMS` = `relay`/`notice`）。
   *
   * 这两类是子代理**已浓缩过一次的产物**（实战语料实证：行重复率 0%、承重密度
   * 0.1–1.5%，本身是 10–20× 提炼结果）⇒ 不进逐原子压缩，交给 Stage-2 图剪处理。
   * 传**空数组** = 关闭门控，退回 v1.6.0 行为。
   */
  skipContextForms?: readonly string[]
  /** fetch 注入点（测试替身；生产缺省 globalThis.fetch）。 */
  fetchImpl?: typeof fetch
}

export interface ResolvedEndpoint {
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
  /**
   * HLS 修复档计数（v1.2.0 组件 B）：extract 副本被拒后经守卫尾注补全落地的数量。
   * 与 skippedFidelity 互斥语义：前者 = 保真由构造地落地，后者 = 保守回退原文。
   */
  hlsRepairs?: number
  /**
   * HLS 审计台账（与 summaryDropped 同级可审）：守卫从原文补进尾注的高信号 token。
   * 空数组/缺省 = 无修复发生。spike39 用其度量"拒收挽回率"。
   */
  restoredByGuard?: string[]
  /**
   * HLS 经济学门控拒收数（v1.2.0 门控修正）：缺 token 但 ROI < θ → 退回原文保面。
   * 空/缺省 = 无门控拦截。用于观测「代价盲区间」（修复越修越长）在真实语料的频率。
   */
  hlsRoiSkipped?: number
  /** 当轮原子 seq 快照（prompt 里给出的值；调试 seq 信任边界用）。 */
  atomSeqs?: { userLong: number[]; toolResults: number[] }
  /** 模型原始 decision（解析成功时留痕；调试服从率用）。 */
  decision?: CompressDecision
  /** A 形态降级 C 的原因（'prefix-budget' = 前缀超预算丢前缀只发指令；防爆上限门控留痕）。 */
  degradedToC?: string
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
// 引擎侧确定性规划选项
// ---------------------------------------------------------------------------

/**
 * planReplacements 选项（v1.2.0）：`hlsMode` 对独立调用方缺省 'off'（保守默认，
 * 既有行为不变）；PeratomCompressor 类显式传自身配置（生产缺省 'trailer'）。
 */
export interface PlanOptions {
  hlsMode?: 'trailer' | 'off'
  /** HLS 经济学门槛 θ（缺省 1）；仅 trailer 档生效。 */
  hlsRoiThreshold?: number
  /**
   * tool/result 压缩副本的**头部标记**（v1.6.1）：`'on'` = 副本正文头部拼
   * `[已压缩-摘取 seq=N]` / `[已压缩-摘要 seq=N]`（详见 decision.toolCopyMarkerText）。
   *
   * 独立调用方缺省 `'off'`（v1.6 既有行为逐字节不变，既有单测零改动）；
   * 生产路径由 `PeratomCompressor` 传自身配置（config 缺省 `'on'`）。
   *
   * 存在理由（2026-09-23 核查）：dsh-session 硬约束使 tool/result 副本**不能**挂
   * `data[ARG_NS]` 元数据、也**不能**换 source（`decision.toolCopyPayload` /
   * `flush.flushEntry` 注释），且副本 `source.kind` 仍是 `'tool'` ⇒ LLM 侧没有任何
   * 信号能把它与真实工具输出区分开。extract 档尤甚：prompt 要求 text 是原文**逐字**
   * 片段，与完整工具输出逐字不可辨。标记是宿主硬约束下唯一的 model-visible 通道。
   */
  marker?: 'on' | 'off'
}
