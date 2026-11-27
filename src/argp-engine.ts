/**
 * ARGP 压缩引擎（2.0 factor-only）。
 *
 * 宿主面 = `CompactionEngine`：pre-step 三通道（压力逃生口 / §9.37 出口闸 / §9.36
 * 浓缩闸二）、溢出 400 恢复、手动 `/compact`、`/argp` 只读状态。
 * 事务内核 = factor 引擎（R 贴标剪枝，0-LLM）+ 散文浓缩（唯一 LLM 摘要通路）。
 *
 * 读侧兼容：老墓碑文法、`prune-tx` 的 tool/result
 * 克隆配对契约（老会话档案可回放）。
 *
 * 循环 import 规约：引擎是唯一组合根，向下单向依赖各功能模块；各模块经窄接口
 * （LifecycleHost / BudgetHost / RecallHost / PruneTxHost / FactorEngineHost …）回指，
 * 编译期断言、运行时同一实例。
 */
import { appendFileSync } from 'node:fs'
import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { CompactionEngine } from '@deepseek-ai/dsh-compaction'
import type {
  CompactionAgentContext,
  CompactionResult,
  CompactionTrigger,
  ManualCompactAgentContext,
} from '@deepseek-ai/dsh-compaction'
import { CONTEXT_WINDOW_EXCEEDED_CODE, createUserMessage, isContextWindowExceededError } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { Agent, PreStepDecision, RequestErrorAction } from '@deepseek-ai/dsh-agent'
import type { CommandId } from '@deepseek-ai/dsh-commands'
import { asSeq, detectOpenTurn, sessionEvents, turnOf } from './log-access.js'
export type { NodeState } from './log-access.js'
// eventText 转发自 log-access，维持既有公共 API 与测试 import。
export { eventText } from './log-access.js'
// 通用类型在叶子 argp-types：本地使用 + 转发维持公共 API。
import type { Atom, ArgpUserSettings } from './argp-types.js'
export type { Atom, AtomType, ArgpUserSettings } from './argp-types.js'
import { DEFAULT_CHARS_PER_TOKEN, DEFAULT_EGRESS_MARGIN_RATIO, DEFAULT_EGRESS_OUTPUT_RATIO, DEFAULT_FOCAL_TURNS, DEFAULT_RETAIN_RATIO, DEFAULT_VOCAB_TOP_N, DEFAULT_WINDOW_RATIO, DEFAULT_WINDOW_TOKENS } from './constants.js'
import { createSessionRuntimeState, type PrunedNodeInfo, type SessionRuntimeState } from './session-state.js'
export type { PrunedNodeInfo } from './session-state.js'
import { pushBounded } from './telemetry.js'
// A2 世界指纹：env 派生档聚合（/argp 一行打印；不改名、不新增 env）。
import { describeWorld, type WorldFingerprint } from './env-world.js'
// 每请求缓存审计：压缩是否打断前缀缓存的直接读数（纯观测，不参与决策）。
import { buildRequestCacheSample, classifyCacheSample, isLowCacheHit } from './cache-audit.js'
// 原子化模块：atomize/classifyUserMessage/looksAskText。本地使用 + 转发。
import { looksAskText, classifyUserMessage, atomize, type GraphBuildHost } from './atomize.js'
export { looksAskText, classifyUserMessage } from './atomize.js'
// 预算/度量模块：scaleBudgets/resolveScaledBudgets/measureTokens/acquireTokenMeter。
import { resolveScaledBudgets, measureTokens, liveBlendCharsPerToken, type BudgetHost, type TokenMeter } from './budget.js'
import { countCjkChars, estTokensFromStats } from './cjk.js'
export { scaleBudgets } from './budget.js'
import { FactorEngine, resolveClipEnabled, resolveEgress, resolveFocalTiered, resolvePressureTriggerEnabled, resolveQScoreEnabled, type FactorEngineHost } from './factor/engine.ts'
import { registerRecallLabels, type RecallLabelsHost } from './factor/recall-labels.ts'
import { registerSearchHistory } from './factor/search-history.ts'
import { ProseCondenser, summarySendTokens, summaryMaxTokensOut } from './factor/prose-condenser.ts'
import { planForm, resolveDispatchMode, resolveDispatchShadowLogPath, CHURN_MIN_RELEASE_TOKENS, CHURN_RELEASE_FLOOR_RATIO, type DispatchDecision } from './factor/dispatch.ts'
// 召回模块（2.0 只留共享语义）：shadowed 增量账本 + 召回字符预算。本地使用。
import { shadowedSeqsOf, budgetRecallText, type RecallHost } from './recall.js'
import type { SeqSet } from './seq-bitset.js'
// 剪枝事务模块：prune-tx 事务骨架（factor 参数化复用）+ 台账记录类型。
import type { GraphPruneRecord, PruneTxHost } from './prune-tx.js'
export type { GraphPruneRecord } from './prune-tx.js'
// /argp 只读状态命令：经嵌套 ctx.inject(['commands']) 注册，宿主无命令服务时静默不注册。
import { registerArgpCommand, type ArgpStatusHost } from './argp-command.js'
// 会话生命周期 + 构造期装配：normalizeConfig/registerSettings/bindSession/rebuildLedgerFromLog。
// 设置页常量（ARG_SETTINGS_KEY/ArgpUserSettingsSchema）在 session-lifecycle，此处转发维持公共 API。
import { normalizeConfig, registerSettings, bindSession, rebuildLedgerFromLog, ARG_SETTINGS_KEY, ArgpUserSettingsSchema, type LifecycleHost } from './session-lifecycle.js'
export { ARG_SETTINGS_KEY, ArgpUserSettingsSchema } from './session-lifecycle.js'

/**
 * 引擎构造配置（2.0 factor-only 面）。
 *
 * **2.0.0 起零旋钮**：原六枚设置项（windowRatio/retainRatio/charsPerToken/focalTurns/
 * vocabTopN/recallLimit）已退役，缺省值固化在 constants.ts（0.8/0.2/3.5/1/10/5）；
 * 老 profile 里的同名键由 normalizeConfig 宽容读 + 告警忽略。构造面保留显式
 * windowTokens/retainTokens（bench/高级部署按 token 直给，不依赖比例旋钮）。
 *
 * 1.x graph 臂的旋钮（maxPasses/recencyGuard/turnGuard/minSpanChars/sortMode/闭包/引用协议/推断边/peratom…）同样已退位——cordis 非 strict 合并仍会把它们透传进来，
 * normalizeConfig 宽容读 + 告警忽略（老 profile 不炸，但不静默改变预期）。
 */
export interface ArgpConfig {
  /** 触发线（token）。不传时默认 = 适配器声明的 contextWindow × 0.8。 */
  windowTokens?: number
  /** 保留目标（token）。不传时默认 = 触发线 × 0.2（压缩率 1/5）。 */
  retainTokens?: number
  /** 触发保留余量（token）；默认 0。windowTokens 会先减去该值作为触发线。 */
  reserveTokens?: number
  /** 诊断/遥测数组容量上限（保留最近 N 条，默认 256；P4.5 有界化）。 */
  telemetryCap?: number
  /**
   * 散文扫描带上限（search_history；FactorEngine 同名裸项透传）。**严禁进 static
   * Config**（ZK1 单键名册）：仅构造面直给（测试/bench），缺省=窗相对现算。
   */
  proseScanCapChars?: number
  /** 可选显式 token 测量函数；不传则退化为字符估算。 */
  measureTokens?: (session: Session) => { contextTokens: number; surfaceTokens: number }
  /** 上下文溢出恢复的最大重试次数（context-overflow trigger），缺省 1（对齐官方 compaction-basic）。 */
  maxOverflowRetries?: number
  /**
   * 在这些 agent preset 下**不生效**（不剪枝/不压缩，会话历史保持原生态）的 preset id 列表。
   * 默认 `['minimal']`。判定按**会话实际运行的 preset**（session projection `agentPreset`）；
   * 无 preset 信息的会话（如 headless/CLI profile 无 preset registry）不受影响。
   * 设为 `[]` 关闭该行为（所有 preset 下都生效）。
   */
  skipPresets?: string[]
  /** 2.0 判别式仅剩 'factor'：旧的 'graph' 值宽容读但在构造期告警并按 factor 运行。 */
  engine?: 'factor'
  /**
   * 压缩阈值（2.0.1 唯一活旋钮，volatile）：出口闸触发线 = 声明窗 × 本比例。
   * 0/缺省 = 关闭（模型撞墙 400 → 自动压缩兜底）。宿主 settings 源驱动时到达
   * Volatile thunk，经 getter `.get()` 读实时值（设置页改动免重挂生效）；profile
   * 直给裸数字也认（getter 两态兼容）。
   */
  compactionThreshold?: Volatile<number> | number
}


/** 默认在这些 preset 下不生效（极简 preset 保留原生态）。 */
const DEFAULT_SKIP_PRESETS: readonly string[] = ['minimal']

/**
 * factor 压缩的模型侧引导：2.2.3 起动态目录由宿主 `systemPrompt.context` 承担
 * （事务成功收尾时冻结快照，`step()` 的 refreshContext 在本次请求即可见）；
 * 无 systemPrompt 服务时退回旧的词表 note（见 factor/engine.ts）。
 */

/**
 * 宿主原生 `toolResultPruner` 的窄接口（`@deepseek-ai/dsh-compaction-tool-result-pruner`）。
 * 只依赖 `pruneSession`；服务缺失（未挂载/被 preset 禁用）时整层 no-op。
 */
interface NativeToolResultPruner {
  pruneSession?: (session: Session) => { pruned?: readonly unknown[]; charsRemoved?: number }
}

/**
 * 宿主 `systemPrompt.context` 的窄接口（不 import dsh-system-prompt 类型，避免把
 * 可选服务变成加载期硬依赖）。`text` 会在每次请求装配/refreshContext 时求值；
 * 本引擎只返回**事务收尾时冻结的会话快照**，绝不在这里读 live ledger。
 */
interface SystemPromptContextLike {
  context(config: {
    name: string
    order: number
    required?: boolean
    text: (context: { agent?: { session?: Session } }) => string
  }): () => void
}

/**
 * §A：从 400 溢出报文里解析**真实上下文上限**（observedCap）。只在报文带了明确
 * 数字上限时返回；pi-ai 通用文案（"detected context overflow"，无数）返回 undefined
 * ⇒ 调用方保留声明窗（行为不变）。返回的是模型窗（token），取报文里的"上限"侧数字。
 * 导出供单测。
 */
export function parseObservedContextCap(message: string | undefined): number | undefined {
  if (message === undefined || message === '') return undefined
  const num = (s: string): number => parseInt(s.replace(/,/g, ''), 10)
  const rules: Array<[RegExp, (m: RegExpMatchArray) => number]> = [
    [/maximum context length[^0-9]*([0-9][0-9,]*)\s*tokens/i, m => num(m[1] as string)],
    [/context (?:window )?length\D*([0-9][0-9,]*)/i, m => num(m[1] as string)],
    [/prompt is too long[^0-9]*[0-9][0-9,]*\s*tokens?[^\d]*([0-9][0-9,]*)/i, m => num(m[1] as string)],
    [/([0-9][0-9,]*)\s*tokens?\s*(?:exceeds|>)\s*(?:the\s*)?(?:model'?s?\s*)?[^0-9]*([0-9][0-9,]*)/i, m => num(m[2] as string)],
    [/(?:max(?:imum)?|limit(?:\s+of)?|of)\D{0,15}([0-9][0-9,]*)\s*tokens/i, m => num(m[1] as string)],
  ]
  for (const [re, pick] of rules) {
    const m = message.match(re)
    if (m !== null) {
      const v = pick(m)
      if (Number.isFinite(v) && v >= 1024) return v
    }
  }
  return undefined
}

export class ArgpEngine extends CompactionEngine {
  /**
   * UI 设置页旋钮（dsh 0.1.7+）。Settings 通过扫描插件的 `static Config` 生成
   * 表单；2.0.1 起名册唯一活键 = `compactionThreshold`（压缩阈值）：出口闸触发线
   * = 声明窗 × 本比例，0=关闭（模型撞墙 400 → 自动压缩兜底）。volatile = 设置页
   * 改动免重挂即生效。其余五枚旧旋钮保持退役（constants 固化 + 老键宽容告警）。
   */
  static Config = z.object({
    compactionThreshold: z.number().min(0).max(1).default(0).volatile(),
  })

  static inject = ['tools']

  /** 2.0 因子引擎（构造期恒装配、会话内不变）。 */
  private readonly factor!: FactorEngine

  /** P6-④ 散文浓缩链（factor 唯一 LLM 摘要通路，只在压缩事务内被调；见 prose-condenser.ts）。 */
  private readonly prose!: ProseCondenser
  /**
   * 每会话的词表快照（systemPrompt.context 的模型可见目录）。
   *
   * 只在压缩事务成功收尾时刷新；两次事务之间即使 provider 被重复调用也返回同一
   * 字节串。用 WeakMap 而非引擎字段，避免多会话目录串台。
   */
  private readonly vocabSnapshots = new WeakMap<Session, { text: string; epoch: number }>()
  /** 是否已成功注册 systemPrompt.context（注册后 note 只作为无该服务时的回退）。 */
  private vocabContextRegistered = false
  /** P6-④ 触发收敛逃生口（构造期快照，ARGP_FACTOR_TIER 同款纪律）：env 置 1 恢复旧估算驱动压力剪。 */
  private readonly pressureTriggerEnabled: boolean = false
  /** 原始构造 config（压缩阈值 volatile 读实时值的取数面）。 */
  private readonly rawConfig: ArgpConfig

  readonly windowTokens!: number
  readonly retainTokens!: number
  /** true = config 显式给 windowTokens；false = 运行时按 contextWindow × windowRatio 解析。 */
  private readonly explicitWindowTokens!: boolean
  /** true = config 显式给 retainTokens；false = 运行时按 windowTokens × retainRatio 解析。 */
  private readonly explicitRetainTokens!: boolean
  readonly reserveTokens!: number
  readonly tokenMeterFn?: (session: Session) => { contextTokens: number; surfaceTokens: number }
  /** 在这些 preset 下不生效的 preset id 列表（构造期定，默认 ['minimal']）。 */
  private readonly skipPresets: string[]
  /** 已就"跳过"记过日志的会话（每会话只记一次，避免 pre-step 每步刷屏）。 */
  private readonly skipLogged = new WeakSet<Session>()
  /** 已就"toolResultPruner 缺失"记过日志的会话（每会话一次，防压缩事务刷屏）。 */
  private readonly nativePrunerMissingLogged = new WeakSet<Session>()
  /**
   * 2.0.0 起零旋钮：以下读取点返回 constants.ts 的固化缺省（原设置页六枚旋钮已退役）。
   * 显式 windowTokens/retainTokens 仍走构造配置；比例与估算口径不再可调。
   */
  get windowRatio(): number { return DEFAULT_WINDOW_RATIO }
  get retainRatio(): number { return DEFAULT_RETAIN_RATIO }
  get charsPerToken(): number { return DEFAULT_CHARS_PER_TOKEN }
  readonly maxOverflowRetries!: number
  /** dsh token-meter 服务；真会话中可用时优先用于 token 测量和 contextWindow 探测。 */
  private readonly tokenMeter!: TokenMeter | undefined

  /** 遥测数组容量上限（P4.5：records/recallCalls/auditWarnings 有界）。 */
  readonly telemetryCap!: number
  // ---------------------------------------------------------------------
  // 会话运行时状态（1-1 起按会话分桶）：以下成员住在 SessionRuntimeState
  //（WeakMap<Session> 分桶，见 sessionStates/stateOf）。引擎上的 getter/setter 是
  // **焦点兼容层**——同步方法沿用 this.x 写法零改动。
  // ---------------------------------------------------------------------
  get records(): GraphPruneRecord[] { return this.rt.records }
  get recallCalls(): { seq: number; hit: boolean; state?: import('./log-access.js').NodeState }[] { return this.rt.recallCalls }
  /** 已剪节点目录（seq -> 元数据），供 /argp 与账目重建。 */
  get prunedNodeIndex(): Map<number, PrunedNodeInfo> { return this.rt.prunedNodeIndex }
  /**
   * A2：当前世界指纹（env 派生档 + 生效时机 + 显式 env 回显）。`/argp` 直接打印；
   * 出口闸线取本引擎当前「压缩阈值」（设置页活读），故与真实发射判据同源。
   */
  worldFingerprint(): WorldFingerprint {
    return describeWorld(process.env, this.compactionThreshold)
  }
  get recallCallsThisTurn(): number { return this.rt.recallCallsThisTurn }
  get recallCharsUsed(): number { return this.rt.recallCharsUsed }
  /** context-overflow 恢复：每个 agent 的重试计数（assistant/message 成功或 idle 时重置）。 */
  private readonly overflowRetries = new WeakMap<Agent, number>()
  /** session → agent 映射，供成功后重置重试计数（agent loop 上下文经 session/event 取不到 agent）。 */
  private readonly overflowAgents = new WeakMap<Session, Agent>()
  /** 最近一次请求的真实 prompt token（usage.inputTokens + cacheReadTokens + cacheWriteTokens，
   *  provider 回报，与 UI ContextMeter 分子同口径）。
   *  pressure check 用它锚定 + 增量估算，替代 tokenMeter 的 chars/4 启发式（低估 30%+，
   *  导致迟触发/窗口保护失效，2026-08-23）。 */
  get lastRealPromptTokens(): number { return this.rt.lastRealPromptTokens }
  set lastRealPromptTokens(v: number) { this.rt.lastRealPromptTokens = v }
  /** 声明窗口缓存（session → 适配器声明的 contextWindow，来自 request/context 事件）。
   *  真环境联调实证：物理窗口探测（llama.cpp n_ctx=262144）与声明窗口（32000）
   *  在 pre-step 时刻可能错位，声明值缺失时宁可跳过检查也不用物理口径。 */
  private readonly declaredContextWindows = new WeakMap<Session, number>()
  /** §A observedCap（session → 从数字型 400 报文学到的**真实**上下文上限）。
   *  仅当 provider 在 400 里报了真实 max（如 OpenAI "maximum context length is N tokens"）
   *  才落账；未知 ⇒ 有效窗退回声明（行为不变）。用于 `W_eff = min(声明, observedCap)`，
   *  修「声明窗 > 真实上限 ⇒ 压力/散文闸永不触发」的死锁。 */
  private readonly observedContextWindows = new WeakMap<Session, number>()
  /** 锚点：lastRealPromptTokens 已覆盖的 surface 最大 seq（其后新增内容需增量估算）。 */
  get lastRealAnchorSeq(): number { return this.rt.lastRealAnchorSeq }
  set lastRealAnchorSeq(v: number) { this.rt.lastRealAnchorSeq = v }
  /** 本会话最近解析的有效窗口（桶化随 rt；budget.ts 经 stateOf 直写本桶，见 session-state.ts）。 */
  get resolvedWindowTokens(): number { return this.rt.resolvedWindowTokens }
  set resolvedWindowTokens(v: number) { this.rt.resolvedWindowTokens = v }
  /** /compact 手动压缩的发起命令 ID（presentation correlation，透传给事务事件）。 */
  private compactSourceCommandId: CommandId | undefined = undefined
  /** A7：账本重建后追加的审计警告（供测试断言/诊断；per-session）。 */
  get auditWarnings(): string[] { return this.rt.auditWarnings }
  /** A7：已重建过的 compactionId 集合（per-session 分桶后天然跨会话隔离，幂等 + 告警不重复）。 */
  get rebuiltCompactionIds(): Set<string> { return this.rt.rebuiltCompactionIds }
  /** 本次请求声明的输出预算（`agent/request` 捕获；适配器的钳制发生在其后，故这里拿到的是请求值）。 */
  private readonly requestMaxTokens = new WeakMap<Session, number>()
  /** §9.37 出口闸·输出预算档③：llm `resolveModelInfo().defaultMaxTokens` 探测缓存
   *  （请求缺 maxTokens 时 llm 服务在 agent/request 瀑布**之后**注入它——观测档盲区，
   *  宿主 llm/src/index.ts resolveCallWithInfo 实证）。0 = 已探无（不重探）；缺键 = 未探。 */
  private readonly modelDefaultMaxTokensCache = new WeakMap<Session, number>()

  private session: Session | null = null
  /** 会话运行时状态分桶（1-1）：stateOf 懒建；rt = 当前焦点会话的桶（bindRuntimeState 换装）。 */
  private readonly sessionStates = new WeakMap<Session, SessionRuntimeState>()
  private rt: SessionRuntimeState = createSessionRuntimeState()
  /** 绑定过的会话身份登记（sessionCount 用；WeakSet 不持有引用）。 */
  private readonly seenSessions = new WeakSet<Session>()
  private seenSessionCount = 0
  stateOf(session: Session): SessionRuntimeState {
    let st = this.sessionStates.get(session)
    if (st === undefined) {
      st = createSessionRuntimeState()
      this.sessionStates.set(session, st)
    }
    return st
  }
  /** bindSession 专用：把焦点桶换装为该会话的桶（session-lifecycle 经 LifecycleHost 调用）。 */
  bindRuntimeState(session: Session): void {
    this.rt = this.stateOf(session)
    // 会话可见性登记：召回工具的"焦点回退"只在引擎只见过一个会话时允许；
    // 多会话宿主下 exec.agent 缺席的回退会静默串台，改为显式拒绝。
    if (!this.seenSessions.has(session)) {
      this.seenSessions.add(session)
      this.seenSessionCount += 1
    }
  }
  /** 引擎累计绑定过的不同会话数（WeakSet 计数；>1 时召回工具不得回退焦点会话）。 */
  sessionCount(): number { return this.seenSessionCount }
  /** 结构化日志门面（构造期自 ctx 捕获）。 */
  private readonly log: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void }

  constructor(ctx: Context, config: ArgpConfig = {}) {
    super(ctx)
    // 结构化日志门面（2026-08-29 review 轻微项）：替换裸 console 直调，日志进宿主
    // 统一管道（ctx.logger 门面；warn/error/info 三级均被 cordis logger 支持）。
    this.log = ctx.logger
    this.rawConfig = config
    // 在这些 preset 下不生效（构造期定；默认 ['minimal']）。
    this.skipPresets = [...(config.skipPresets ?? DEFAULT_SKIP_PRESETS)]
    normalizeConfig(ctx, this as unknown as LifecycleHost, config)
    registerSettings(ctx, this as unknown as LifecycleHost, config)
    // 旋钮已退役（2.0.0 零旋钮）：焦点/词表口径用 constants.ts 固化缺省。
    this.factor = new FactorEngine(this as unknown as FactorEngineHost, {
      focalTurns: () => DEFAULT_FOCAL_TURNS,
      vocabTopN: () => DEFAULT_VOCAB_TOP_N,
      // 策略档 env 逃生口（T-3 两臂实跑）：缺省 flat=现行为字节不变，
      // 禁入 static Config ⇒ env 是生产触达 tiered 的唯一通道（resolveFocalTiered 注释）。
      focalTiered: resolveFocalTiered(),
      // C10 夹剪层（三态保留）：构造期快照 env，缺省关=shadow 二态字节不变（R2 A/B 通道）。
      clipEnabled: resolveClipEnabled(),
      qScoreEnabled: resolveQScoreEnabled(),
      // 散文扫描带 cap 裸项透传（缺省 undefined=窗相对现算；0=关闭散文带）。
      proseScanCapChars: config.proseScanCapChars,
    })
    // P6-④ 散文浓缩链：factor 唯一 LLM 摘要通路，只在压缩事务内被调
    // （compactIfNeeded——overflow 或出口闸驱进的 'pressure' 且闸二 ctx 线补检通过 /
    // compactNow 免闸二；估算驱动零触达）。
    this.prose = new ProseCondenser(ctx, this as unknown as PruneTxHost, {
      focalTurns: () => DEFAULT_FOCAL_TURNS,
    })
    // 动态词表目录：走 systemPrompt.context（不是 system section）。
    // 宿主在 pre-step 之后、真正发请求前会 refreshContext；压缩事务在 pre-step 内
    // 收尾刷新快照，因此本次压缩后的请求就能看到新目录，而 system 头部保持不变。
    this.registerVocabularyContext(ctx)
    // 触发收敛逃生口：构造期快照 env（档位语义同 resolveFocalTiered——策略切换须重挂引擎）。
    this.pressureTriggerEnabled = resolvePressureTriggerEnabled()
    // §9.37 出口闸：缺省面随 dispatch 世界——接管=开（死亡带唯一防线），off/shadow=关
    // （旧世界行为不变，见 resolveEgress）。2026-11-25 翻转；2026-11-15 的"缺省关"已作废。
    // 另外两枚覆盖：设置「压缩阈值」(compactionThreshold>0，volatile 实时读) 或 env 显式档。
    // 每次 pre-step 经 resolveEgress 实时解析（设置页改动免重挂生效）。
    // 召回面 = recall_history / list_labels（标签制）+ search_history（内容发现，2.1.0）。
    registerRecallLabels(ctx, this.factor, this as unknown as RecallLabelsHost)
    registerSearchHistory(ctx, this.factor, this as unknown as RecallLabelsHost)
    this.log.info('[argp] engine=factor-only（2.0）：R 贴标剪枝 + 散文浓缩；召回面 = recall_history/list_labels（标签）+ search_history（内容发现）')
    // /argp 状态命令：只读出口，放在工具注册之后（依赖 commands 服务，缺失时
    // inject 回调不执行 ⇒ 不改变其余装配的可观测行为）。
    registerArgpCommand(ctx, this as unknown as ArgpStatusHost)

    // 压缩/恢复引导：动态目录由本构造器上方注册的 systemPrompt.context 承担；
    // 无该服务的宿主退回首次压缩后的词表 note（VOCAB_NOTE_GUIDE）。

    ctx.on('session/event', (session, event) => {
      // 声明窗口缓存（真环境联调实证）：request/context 事件携带适配器声明的
      // contextWindow（settings 模型条目），是权威口径。pre-step 压力检查可能早于首个
      // request/context 事件落账（新会话 turn-1），此缓存使后续检查/重启会话立即拿到
      // 声明值，不再退化为物理窗口探测（llama.cpp 场景 262144 vs 声明 32000，7.7× 口径差）。
      if (event.type === 'request/context') {
        const declared = (event.data as { contextWindow?: number } | undefined)?.contextWindow
        if (typeof declared === 'number' && declared > 0) {
          const previous = this.declaredContextWindows.get(session)
          if (previous !== undefined && previous !== declared) {
            this.log.info(`[argp-engine] declared contextWindow changed: ${previous} -> ${declared}`)
          }
          this.declaredContextWindows.set(session, declared)
        }
      }
      // 外来压缩事务可见性（真环境联调实证）：本插件的 compactionId 一律带
      // `argp-` 前缀；不带前缀的 compaction/start = 其他压缩实现（如原生摘要器）在
      // 本 ctx.compaction 位之外运作——lossy 摘要会先于本引擎事务发生，必须在日志可见。
      if (event.type === 'compaction/start') {
        const cid = (event.data as { compactionId?: string } | undefined)?.compactionId
        if (typeof cid === 'string' && !cid.startsWith('argp-')) {
          this.log.warn(`[argp-engine] foreign compaction detected (id=${cid}, turn=${turnOf(event) ?? '?'})`
            + ' — a non-ARGP compaction engine is active; lossy summarization may pre-empt ARGP pruning')
        }
      }
      // 缓存审计（2.2.3）：`compaction/end` 无 error = 事务成功收尾，记下事务 id 与
      // 收尾时刻；此后第一条带 usage 的应答即「压缩后首请求」，是唯一能直接读出
      // 「保留段是否整条重灌」的观测点（见 cache-audit.ts）。
      if (event.type === 'compaction/end') {
        this.noteCompactionEnd(session, event)
      }
      // 真实 token 锚点（2026-08-23）：assistant/message 携带 provider 回报的 usage，
      // inputTokens（未命中）+ cacheReadTokens（命中）+ cacheWriteTokens（写缓存，
      // Anthropic 风格 provider 上报；OpenAI 兼容端点缺省 0）= 本次请求的真实 prompt token。
      // pressure check 优先用它，避免 tokenMeter chars/4 低估导致的迟触发。
      // 与 UI ContextMeter 分子同口径（connection client contextPressureOf）。
      if (event.type === 'assistant/message') {
        const usage = (event as { data?: { usage?: { inputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number } } }).data?.usage
        const seq = (event as { seq?: unknown }).seq
        if (usage !== undefined && typeof usage.inputTokens === 'number') {
          const usageSt = this.stateOf(session)
          usageSt.lastRealPromptTokens = (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
          if (typeof seq === 'number') usageSt.lastRealAnchorSeq = seq
          this.recordCacheSample(session, event, usage)
        }
        // 一次成功的模型应答 = 溢出恢复序列的终结点：重置该 agent 的重试计数，
        // 即使工具调用让同一 turn 继续（对齐 compaction-basic 的 overflowAgents 模式）。
        const agent = this.overflowAgents.get(session)
        if (agent !== undefined) this.overflowRetries.delete(agent)
      }
    })
    ctx.on('agent/status', ({ agent, status }) => {
      if (status === 'idle') this.overflowRetries.delete(agent)
    })
    // 上下文溢出恢复（官方机制，与 compaction-basic 同构）：模型请求返回
    // 400 exceed_context_size_error（稳定错误码 CONTEXT_WINDOW_EXCEEDED，不写死
    // token 数）时，强制剪枝并把请求重发出去。识别靠 LlmFailure.code ——
    // provider 特定错误（DeepSeek 的 {"type":"exceed_context_size_error"}）由
    // dsh-llm 适配器归一化到该稳定码。
    ctx.on('agent/request-error', async (
      { agent, failure, signal },
      next,
    ): Promise<RequestErrorAction> => {
      // P6-④ 报错事件核验补强（2026-11-12，17+20 真实样本核验结论）：两报错类在生产
      // 已归一 CONTEXT_WINDOW_EXCEEDED——t24v 21 死轮实锤走 pi-ai usage-based
      // isContextOverflow 分支（模板消息 "pi-ai detected context overflow" 本身不过
      // isContextWindowExceededError 文本分类器，但 code 已是稳定码，钩子按 code 路由 ✓）。
      // 残余缺口 = pi-ai 通用适配器对**非词语化** 400（裸 exceed_context_size_error type、
      // 无词语文本）落 PI_AI_ERROR（classifyPiAiError 词面全不中）——加文本回兜：
      // message 命中 isContextWindowExceededError 同样进拦截；rate-limit/网络/余额词面
      // 判假已核（本地对照 5 例全过），回兜不误伤非溢出类。
      const overflowLike = failure.code === CONTEXT_WINDOW_EXCEEDED_CODE
        || isContextWindowExceededError(failure.message ?? '')
      if (!overflowLike || signal.aborted) return next()
      // §A：报文若报了真实上限（如 "maximum context length is 131072 tokens"），
      // 学到 observedCap → 后续有效窗 = min(声明, 真实)，解开声明>真实的压力/散文闸死锁。
      // pi-ai 通用文案无数 ⇒ parse 返回 undefined ⇒ 不记（行为不变）。取更小者为准。
      const cap = parseObservedContextCap(failure.message)
      if (cap !== undefined) {
        const prev = this.observedContextWindows.get(agent.session)
        if (prev === undefined || cap < prev) {
          this.observedContextWindows.set(agent.session, cap)
          const declaredNow = this.declaredContextWindows.get(agent.session) ?? 0
          this.log.info(`[argp-engine] observedCap learned: ${cap} tokens`
            + (declaredNow > 0 ? ` (declared=${declaredNow}, effective=${Math.min(cap, declaredNow)})` : '')
            + `; 400 msg: ${(failure.message ?? '').slice(0, 140)}`)
        }
      }
      this.overflowAgents.set(agent.session, agent)
      const retries = this.overflowRetries.get(agent) ?? 0
      if (retries >= this.maxOverflowRetries) return next()
      // 溢出恢复只剩一步（forcePrune 后 retry）；重试上限缺省 1（对齐官方 compaction-basic）。
      const session = agent.session
      const genBefore = session.surface.replaceGeneration
      let result: CompactionResult | null
      try {
        result = await this.compactIfNeeded(agent, 'context-overflow', signal)
      } catch (recoveryError: unknown) {
        const message = recoveryError instanceof Error ? recoveryError.message : String(recoveryError)
        // 剪枝可能在摘要之类后续阶段抛错前已落地（模型无关的确定性占位
        // 替换）。只要 surface 换代了，这次减量就是重试的充分凭证，不丢弃。
        if (!signal.aborted && session.surface.replaceGeneration > genBefore) {
          // 审查 P1-1：durable surface progress ≠ 减够；仍 ≥ 窗则不 retry（同一超窗请求重发只会再 400）。
          const declaredAfterCatch = this.effectiveWindowFor(session)
          if (declaredAfterCatch > 0 && this.postPruneProjection(session) >= declaredAfterCatch) {
            this.log.warn(`[argp-engine] overflow prune partial progress but still ≥ window: ${message}; not retrying`)
            return next()
          }
          this.log.warn(`[argp-engine] overflow prune failed after durable surface progress: ${message}; retrying from the replacement surface`)
          this.overflowRetries.set(agent, retries + 1)
          return { kind: 'retry' }
        }
        this.log.warn(`[argp-engine] overflow prune failed: ${message}; ${signal.aborted ? 'cancellation prevents retry' : 'preserving the original request error'}`)
        return next()
      }
      if (signal.aborted || session.surface.replaceGeneration <= genBefore) return next()
      if (result !== null) {
        this.log.info(
          `[argp-engine] context-overflow prune: shadowed ${result.shadowedSeqs.length} surface nodes `
          + `(seqs ${result.shadowedRange.start}-${result.shadowedRange.end}, ~${result.shadowedTokenCount} tokens)`,
        )
      }
      // 2026-11-13 T34 实锤：surface 换代 ≠ 减够。事务后二次测量；仍 ≥ 声明窗 ⇒ 不 retry
      // （重发同一超窗请求只会再吃一发 400），保留原始错误交给下一轮/用户。
      const declaredForGuard = this.effectiveWindowFor(session)
      if (declaredForGuard > 0) {
        const after = this.postPruneProjection(session)
        if (after >= declaredForGuard) {
          this.log.warn('[argp-engine] overflow prune 后仍 ≥ 声明窗（projected=' + after
            + ' ≥ ' + declaredForGuard + '）：不 retry 同一超窗请求')
          return next()
        }
      }
      this.overflowRetries.set(agent, retries + 1)
      return { kind: 'retry' }
    })
    // 本次请求声明的输出预算（L2 判据的一半）。只读 waterfall：不改配置，仅记录，供
    // assistant/message 落账时区分"输出被**外部**钳制"与"模型自己写满预算"。
    ctx.on('agent/request', async ({ agent }, next) => {
      const config = await next()
      if (typeof config.maxTokens === 'number' && config.maxTokens > 0) {
        this.requestMaxTokens.set(agent.session, config.maxTokens)
      }
      return config
    })
    ctx.on('agent/pre-step', async ({ agent, messages, step, signal }, next): Promise<PreStepDecision> => {
      this.bindSession(agent.session) // A7（问题 3）：生产 resume 点，账目缺失时自动重建
      // skipPresets 必须在**所有**破坏性路径之前判：出口闸/浓缩闸二/压力逃生口都在本
      // 钩子内直调事务，若只在 compactIfNeeded/compactNow 里判，minimal preset 会被
      // 浓缩链改写（"ARGP 不生效"承诺破裂）。命中即整钩子退场（含后续 next()）。
      if (this.skipIfPreset(agent.session)) return next()
      // factor 分发（P6-④ 触发收敛）：pre-step 估算驱动退役——破坏性改写只认
      // 手动 compact + context 报错两信号，外加 §9.37 出口闸（anchored 确定性容量算术，
      // 非估算驱动）。词表目录同步迁出 pre-step（变化时机 = 压缩时机，事务收尾冻结
      // 到 systemPrompt.context 快照；无该服务时退回 note）。
      // ARGP_FACTOR_PRESSURE=1 = 评测逃生口，恢复旧估算驱动路径。
      const incoming = this.incomingTokens(messages)
      if (!signal.aborted && this.pressureTriggerEnabled) {
        try {
          await this.factorPressure(agent, incoming)
        } catch (e) {
          this.log.warn('[argp-factor] pre-step 压力剪失败（不阻断本步）: ' + (e instanceof Error ? e.message : String(e)))
        }
      }
      // §9.37 出口闸（2026-11-25 起：接管世界缺省开=旧公式线；off/shadow 缺省关，
      // ARGP_FACTOR_EGRESS=1 或设置「压缩阈值」>0 恒开）：必然超窗的请求根本不发——
      // 先剪后发，根除撞墙 400/钳位→重试→全量重灌链，并封死「宿主 max_tokens 钳制线
      // 低于 pressure 线」的贴线饿死带（大固定面会话，g7f58/g7e58 对照实锤）。
      // env=0 为对照硬覆盖（设置也不开）。
      // 返回真值=本步已发剪事务，浓缩闸顺延（同 step 不吃二次重铸）。
      const egress = resolveEgress(process.env, this.compactionThreshold)
      // 与 PRESSURE 逃生口互斥（审查 F5）：hatch=旧世界字节级复现契约，两 env 各管各的
      // 对照世界——要"旧世界+出口闸"的第三组合请显式改码，别靠 env 叠乘出第四态。
      let egressPruned = false
      if (!signal.aborted && egress.enabled && !this.pressureTriggerEnabled) {
        try {
          const gate = await this.egressGate(agent, signal, incoming, egress.lineRatio)
          if (gate === 'blocked') {
            // 剪后仍 ≥ 声明窗：不进入本步请求（宿主 PreStepDecision 硬拒）。但若本步已
            // claim 了用户消息，reject 会让这条 prompt 永久丢失（宿主 claim 已从 inbox
            // 移除）——此时绝不 reject，交 400 兜底网，下一轮再剪。
            if (messages.length > 0) {
              this.log.warn('[argp-factor-egress] 剪后仍超窗，但本步有用户输入：不硬拒（避免丢 prompt），交 400 兜底')
            } else {
              this.log.warn('[argp-factor-egress] pre-step 硬拒：事务后仍超窗，本步不发送')
              return { kind: 'reject' }
            }
          }
          egressPruned = gate === true
        } catch (e) {
          this.log.warn('[argp-factor-egress] pre-step 出口闸异常（不阻断本步）: ' + (e instanceof Error ? e.message : String(e)))
        }
      }
      // §9.36 浓缩通道闸二（ctx 闸）：上一请求 usage 已锚、下一请求未发——双闸合取里
      // "总上下文 ≥ windowRatio×声明窗"的把关位（闸一散文线在 condense 内）。
      // 接管世界（2.2.0 起）本独立通道不挂：正文浓缩主权在分派判据表——pressure 线与
      // 出口闸事务都经 dispatch 核准发 summarize 形（§G 缓存形与 G2 账单只在核准路径
      // 生效）；本闸五参直调不经核准，过线时以旧形（hrMode 退回 prose）绕过判据表发
      // 摘要且对 G2 隐形（发布前审查实锤：调用点原无世界门控）。旧世界 off/shadow 照旧。
      if (!signal.aborted && !egressPruned && resolveDispatchMode(process.env) !== 'takeover') {
        try {
          await this.condenseGate(agent, signal, incoming)
        } catch (e) {
          this.log.warn('[argp-factor-prose] pre-step ctx 闸异常（不阻断本步）: ' + (e instanceof Error ? e.message : String(e)))
        }
      }
      void step
      return next()
    })
  }

  /**
   * A7（问题 3 修订）：session 绑定统一入口——setSession / agent/pre-step / compactIfNeeded 首次绑定
   * 都走这里。绑定后若 records 为空且日志含 compaction/start 事件（resume 场景：账目丢失仅日志在），
   * 懒触发 rebuildLedgerFromLog() 自动重建；幂等由 rebuiltCompactionIds 去重保证。
   */
  private bindSession(session: Session): void {
    bindSession(this as unknown as LifecycleHost, session)
    // 2026-11-13 R2 实锤：headless 每轮新起 dsh 进程 resume，历史 request/context 不在
    // 活事件流里——只靠 session/event 写 WeakMap 会让 §9.37 出口闸读到 0 直接放行。
    this.restoreDeclaredWindow(session)
  }

  setSession(session: Session): void {
    this.bindSession(session)
  }

  /**
   * 真实 token 锚点回填（2026-09-21 修，问题定位见内部根因台账）。
   *
   * 背景：`lastRealPromptTokens` / `lastRealAnchorSeq` 原先**只**由 `ctx.on('session/event')`
   * 的 `assistant/message` 处理器写入。宿主进程重启后 resume 的会话若不再把该事件喂给本
   * 引擎（真环境 2026-09-21 实证：同一会话 turn 1 锚点正常、turn 2 起恒为 0），
   * `measureTokens` 会静默走回退分支 `visibleChars / charsPerToken`——而 `visibleChars`
   * 的投影口径**不含 reasoning**。实测该估算 ≈ 真实 prompt 的 **0.48 倍**：
   *   turn 6 真实 prompt 210,719 tok 时估算仅 ≈102,703 ⇒ 触发线 100,007 一路不越线，
   *   直到真实 prompt 210,719 才触发（迟 2.1×，66 步空转）。
   *
   * 口径与 usage 处理器**完全一致**（in + cacheRead + cacheWrite = provider 回报的 billed
   * prompt），取日志中最后一条带 `usage.inputTokens` 的 `assistant/message`——即本进程
   * 重启前最后一次真实请求的 prompt 规模。日志无带 usage 的应答（全新会话）⇒ 重置为
   * 0 / -1，保持既有回退行为（新会话首轮本就没有可用锚点）。
   *
   * 幂等与成本：反向扫描在最后一条带 usage 的应答处提前返回（通常就是最后一条应答）；
   * 会话身份每步换新（见 bindSession 注释）时重复回填的值恒等于 live 处理器写入的值
   * （日志 append-only，最后一条 usage 恒 ≥ 内存锚点），故重复执行不会回退。
   */
  private restoreUsageAnchor(session: Session): void {
    let restored = false
    const st = this.stateOf(session)
    // 内存桶已有锚点（本进程上一次绑定/事务后估算）⇒ 不动：日志里的最后一条 usage
    // 可能早于本进程的压缩事务，盲目回填会把"压缩后 retain 位"重置回压缩前大值，
    // 出口闸随后误判并触发整段重剪（多会话/子代理切换焦点时必现）。冷 resume
    // （新进程，桶为空）才需要从日志回填。
    if (st.lastRealAnchorSeq >= 0 || st.lastRealPromptTokens > 0) return
    try {
      const events = sessionEvents(session)
      for (let i = events.length - 1; i >= 0; i -= 1) {
        const event = events[i]
        if (event?.type !== 'assistant/message') continue
        const usage = (event.data as { usage?: { inputTokens?: unknown; cacheReadTokens?: unknown; cacheWriteTokens?: unknown } } | undefined)?.usage
        if (usage === undefined || typeof usage.inputTokens !== 'number') continue
        const read = typeof usage.cacheReadTokens === 'number' ? usage.cacheReadTokens : 0
        const write = typeof usage.cacheWriteTokens === 'number' ? usage.cacheWriteTokens : 0
        st.lastRealPromptTokens = usage.inputTokens + read + write
        st.lastRealAnchorSeq = typeof event.seq === 'number' ? event.seq : -1
        restored = true
        break
      }
    } catch { restored = false }
    if (!restored) {
      // 新会话 / 日志无 usage：清掉可能属于上一个 session 的失效锚点。
      st.lastRealPromptTokens = 0
      st.lastRealAnchorSeq = -1
      return
    }
    this.log.info('[argp-engine] usage anchor restored from log: real prompt='
      + st.lastRealPromptTokens + ' tok at seq=' + st.lastRealAnchorSeq)
  }

  /**
   * 声明窗锚点回填（2026-11-13，R2 修后世界实锤）：`declaredContextWindows` 原先**只**
   * 由活 `session/event` 的 `request/context` 写入。headless 驱动每轮新起一个 dsh 子进程
   * （`--session-id` resume），历史 `request/context` 不会重放到新进程的 WeakMap ⇒
   * `egressGate` 读到 `declaredWindow=0` 直接 `return false`，§9.37 出口闸在 T02 起就死了，
   * 400→剪→重试→全量重灌链原样复活（cand-shadow-fix T13/T18/T2x 共 4 笔死流实锤）。
   * 与 `restoreUsageAnchor` 同模式：反向扫日志取最后一条声明值；每 session/进程只扫一次
   * （WeakMap 已有值即早退；活事件更新不受影响）。
   */
  private restoreDeclaredWindow(session: Session): void {
    const cached = this.declaredContextWindows.get(session) ?? 0
    if (cached > 0) {
      this.seedBucketFromDeclared(session, cached)
      return
    }
    try {
      const events = sessionEvents(session)
      for (let i = events.length - 1; i >= 0; i -= 1) {
        const event = events[i]
        if (event?.type !== 'request/context') continue
        const declared = (event.data as { contextWindow?: unknown } | undefined)?.contextWindow
        if (typeof declared === 'number' && declared > 0) {
          this.declaredContextWindows.set(session, declared)
          this.seedBucketFromDeclared(session, declared)
          this.log.info('[argp-engine] declared contextWindow restored from log: ' + declared)
          return
        }
      }
    } catch {
      // 日志不可读：保持未知，宁缺勿错交给 400 兜底网（与 resolveScaledBudgets 同纪律）。
    }
  }

  /**
   * 声明窗→会话桶播种（定点回放实锤 2026-11-26）：出口闸关且本进程无压力事务时
   * `resolveScaledBudgets` 零执行，`stateOf(session).resolvedWindowTokens` 保持初始种子
   * `DEFAULT_WINDOW_TOKENS=16,384` 并伪装成已解析值——派生读数（如散文扫描 cap
   * = window × charsPerToken × 2.7）缩到声明窗的 1/16，262K 窗补召轮的素材页全程
   * 不进检索带（46 轮 campaign 补充召回 0/7 根因，cap 实测 110,861 与 16K 种子
   * 算术逐位吻合）。播种只覆盖"从未被解析触碰"的默认种子；首次真解析（含
   * observedCap）由 resolveScaledBudgets 的桶写入自然覆盖。显式窗配置以显式值为
   * 准，不播种。
   */
  private seedBucketFromDeclared(session: Session, declared: number): void {
    if (this.explicitWindowTokens) return
    const st = this.stateOf(session)
    if (st.resolvedWindowTokens !== DEFAULT_WINDOW_TOKENS) return
    const observed = this.observedContextWindow(session)
    const effective = observed !== undefined && observed > 0 && observed < declared ? observed : declared
    st.resolvedWindowTokens = Math.floor(effective * this.windowRatio)
  }

  /**
   * 增量维护被遮蔽 surface seq 集合（账本语义见 recall.ts；A5 起为位图）。
   */
  private shadowedSeqsOf(session: Session): SeqSet {
    return shadowedSeqsOf(this as unknown as RecallHost, session)
  }

  /**
   * 原子化（§4.1）：只投影 surface 节点；U/X/R/A 四类（tool/call 不进 surface，无 T 类）。
   *
   * node 0 保护（2026-09-10，dsh 0.1.5 起）：宿主把 system prompt 表示为 surface node 0 的
   * `system/message`，并在 surface.ts `assertSystemHeadRewrite` 里硬性保护——任何覆盖 node 0 的
   * replace 必须是"恰好覆盖该单节点的 system/message"，否则 throw。
   * 本投影**静默跳过** system/message，因此 node 0 永远不会进入 ARGP 的剪枝区间。
   */
  atomize(session: Session): Atom[] {
    return atomize(this as unknown as GraphBuildHost, session)
  }

  /** 测量当前上下文 token。优先「真实 usage 锚点 + 增量估算」（2026-08-23，
   *  替代 tokenMeter chars/4 低估导致的迟触发/窗口保护失效）；无锚点才回退
   *  dsh tokenMeter / 配置函数 / 字符估算。source 标注估计来源。
   *  `extraTokens`：本步**已 claim 但尚未落盘**的 user 消息估值。轮初它既不在
   *  surface 里、也不在锚点覆盖范围内，漏掉就等于漏算"这一轮的启动量"——而用户恰恰
   *  常在轮初粘贴大段文本。
   */
  private measureTokens(session: Session, extraTokens = 0, legacyPlain = false): { contextTokens: number; surfaceTokens: number; source: 'anchored' | 'tokenMeter' | 'config' | 'chars' } {
    return measureTokens(this as unknown as BudgetHost, session, extraTokens, legacyPlain)
  }

  /**
   * 剪后投影（审查 P1-1）：取 max(锚点估算, tokenMeter 总量)。prune-tx 事务后锚点被
   * 重置为 `visibleChars/charsPerToken`（不含 system + tool schemas），单用它会低估算；
   * tokenMeter 在真会话可用时是含 tools/system 的权威值。
   */
  private postPruneProjection(session: Session, extraTokens = 0): number {
    const m = this.measureTokens(session, extraTokens)
    let total = m.contextTokens
    if (this.tokenMeter !== undefined) {
      try {
        total = Math.max(total, this.tokenMeter.measure(session).totalTokens + extraTokens)
      } catch { /* tokenMeter 不可用：保持锚点估算 */ }
    }
    return total
  }

  /**
   * 本步已 claiming（尚未落盘进 surface）的 user 消息估值（Issue5 起为 CJK 加权：
   * nonCjk/3.5 + cjk/κ）。与 `measureTokens` 的增量口径同基准，可直接相加；
   * 非 CJK 输入 = chars/3.5 逐字等价。
   */
  private incomingTokens(messages: readonly unknown[]): number {
    let chars = 0
    let cjk = 0
    for (const message of messages) {
      const content = (message as { content?: unknown }).content
      if (!Array.isArray(content)) continue
      for (const block of content) {
        const b = block as { text?: unknown; content?: unknown }
        if (typeof b.text === 'string') { chars += b.text.length; cjk += countCjkChars(b.text) }
        if (!Array.isArray(b.content)) continue
        for (const inner of b.content) {
          const t = (inner as { text?: unknown }).text
          if (typeof t === 'string') { chars += t.length; cjk += countCjkChars(t) }
        }
      }
    }
    return chars === 0 ? 0 : Math.ceil(estTokensFromStats(chars, cjk))
  }

  /**
   * recall 预算：单次结果与累计结果都按窗口比例截断（窗口取最近解析的有效预算）。
   * 预算耗尽时显式说明剩余额度与何时恢复；每笔 compaction 事务成功后归零
   * （见 prune-tx 事务尾）。
   */
  private budgetRecallText(session: Session, text: string): string {
    return budgetRecallText(this as unknown as RecallHost, session, text)
  }

  /**
   * 预算解析：显式配置用显式值；否则从适配器声明的 contextWindow 按比例推导——
   *  windowTokens = contextWindow × windowRatio（默认 0.8），retainTokens = windowTokens × retainRatio（默认 0.2）。
   *  上下文容量由其他插件（模型适配器声明）决定，本引擎不硬编码。
   *  解析顺序：1) session.requestContext()（request/context 事件，真会话最可靠）；
   *           2) llm.resolveModelInfo(provider, model)；3) 静态默认值。
   */
  private async resolveScaledBudgets(
    agent: CompactionAgentContext,
  ): Promise<{ windowTokens: number; retainTokens: number; declaredKnown: boolean }> {
    return resolveScaledBudgets(this as unknown as BudgetHost, agent)
  }

  /**
   * 会话当前运行的 agent preset id（从 session projection 读取）。
   *
   * 返回：
   *  - `undefined`：本 profile 无 agent-preset-registry（无 preset 概念，如 headless/CLI）
   *    → 不跳过（按现状工作）。
   *  - `null`：registry 在，但会话头未记录 preset（非 preset 流程创建）→ 不跳过。
   *  - 字符串：会话实际运行的 preset id（可被 `agent-preset/selected` 事件切换）。
   *
   * `sessionProjections` 是 dsh-base 的核心服务（恒在），但 `agentPreset` 这个
   * projection key 由 web-app 的 agent-preset-registry 注册——dsh-argp 不依赖该包，
   * 故经结构类型窄接口读取（避免新增 peer/dep），服务缺失时安全降级为 undefined。
   */
  private activePresetOf(session: Session): string | null | undefined {
    // 经 ctx.get() 读取（reflect 层"无需 inject"的读法）：直接属性访问 ctx.sessionProjections
    // 会抛 "cannot get property … without inject"（本插件 static inject 只声明 tools）。
    // sessionProjections 是 dsh-base 的核心服务（恒在）；服务缺失时 get() 返回 undefined，安全降级。
    const projections = (this.ctx as unknown as {
      get?: (name: string) => { stateOf: (session: Session, key: string) => string | null | undefined } | undefined
    }).get?.('sessionProjections')
    if (projections === undefined) return undefined
    try {
      return projections.stateOf(session, 'agentPreset')
    } catch {
      return undefined
    }
  }

  /**
   * 会话是否运行在 skipPresets 列出的 preset 下（= ARGP 不生效，保留原生态）。
   * 无 preset 信息（undefined/null）时不跳过。命中时记一次日志（每会话一次）。
   */
  private skipIfPreset(session: Session): boolean {
    if (this.skipPresets.length === 0) return false
    const preset = this.activePresetOf(session)
    if (preset === undefined || preset === null) return false
    if (!this.skipPresets.includes(preset)) return false
    if (!this.skipLogged.has(session)) {
      this.skipLogged.add(session)
      this.log.info('[argp-engine] session runs under preset "' + preset + '" (in skipPresets); ARGP compaction disabled for this session (stock behavior)')
    }
    return true
  }

  /**
   * §9.36 浓缩通道闸二（ctx 闸；用户裁定 2026-11-13：检查点可在发送之后=usage 账单锚）：
   * pre-step 位（上一请求 usage 已落锚、下一请求未发）测得总上下文 ≥ 触发线
   * （windowRatio×声明窗，缺省 0.8）⇒ 驱一发清扫式浓缩（prose.condense 内查闸一）。
   * 锚点健康前提（H6）：source='anchored'（usage 真锚；断锚退 chars 估=禁触发破坏性
   * 改写，宁缺勿错）+ 声明窗已知。手动 compactNow 免本闸（手动语义保留）。
   * 0.2×声明窗留给摘要输出（输出预算=summaryMaxTokensOut(声明窗)）。
   */
  private async condenseGate(agent: CompactionAgentContext, signal: AbortSignal, incomingTokens: number): Promise<void> {
    const session = agent.session
    const { windowTokens, declaredKnown } = await this.resolveScaledBudgets(agent)
    this.bindSession(session) // D2：await 窗口内焦点可能换装——回绑后再读锚点
    if (!declaredKnown || windowTokens <= 0 || signal.aborted) return
    const measurement = this.measureTokens(session, incomingTokens)
    if (measurement.source !== 'anchored') return
    if (measurement.contextTokens < windowTokens) return
    this.log.info('[argp-factor-prose] ctx 闸过线: contextTokens=' + measurement.contextTokens
      + ' ≥ ' + windowTokens + '（声明窗=' + (this.declaredContextWindows.get(session) ?? '?') + '），清扫式浓缩')
    const res = await this.prose.condense(session, agent.options, windowTokens, signal, this.effectiveWindowFor(session))
    if (res !== null) await this.refreshFactorNoteSafe(agent) // P6-② note 纪律：变化时机=压缩时机（未发射不写 note）
  }

  /**
   * §9.37 出口闸（接管世界缺省开=旧公式线；off/shadow 缺省关；env=1 或设置
   * 「压缩阈值」>0 恒开；env=0 对照硬覆盖）——2026-11-15 裁定「关为缺省」的前提
   * （旧双闸误触发风险 + 真实墙≈声明窗时 400 兜底可达）已被接管判据表实机 +
   * 真实墙≫声明窗端点的钳制饿死证据推翻，2026-11-25 翻转。它根除的链见 P6-④
   * 贴墙账（T24-J R2 实锤）：
   * 贴墙轮先发出**必然超窗**的请求（`400 … request (273639
   * tokens) exceeds the available context size (262144)`——6 笔零 usage 死流恰每笔事务
   * 轮一发，这串 prefill 在 usage 账里完全隐形）→ 拒收后剪 → 重试再全量重灌；端点窗边
   * 行为还分叉：有时静默把 max_tokens 钳到 窗−prompt 再打满（T23 out=1,617，marker 丢轮）。
   * 出口闸 = pre-step 位（上一请求 usage 已锚、下一请求未发）做确定性容量算术：
   *   anchored 实测（含本步增量估值）≥ 声明窗 − 输出预算 − 提前量 ⇒ 请求根本不发，
   *   先走标准压缩事务（compactIfNeeded('pressure') factor 分发：R 剪 0-LLM 在前，
   *   散文浓缩按 §9.36 双闸跟后）再发。剪的目标位是 retain（既有 deficit 口径）而非
   *   贴线微剪——首笔过线的驱逐深度=窗×(触发线−retain)量级，账（审查 F3）：方向与
   *   "多留=早一点剪（可召回）"一致。只认 anchored（断锚禁驱动破坏性改写，P6-④
   *   "只有确定性的才可以"原样保留）。anchored 标签≠真锚：事务后 prune-tx 把锚重置为
   *   chars 估算仍标 'anchored'（审查 F4）——敞口有界：事务后上下文已回落 retain 位，
   *   且下一笔成功请求即重锚真 usage；根治=锚 provenance 位（挂后）。
   * 输出预算三源取 **max**（保守侧：多留早剪，漏留撞墙）：①`agent.options.maxTokens`
   * ——宿主 buildRequest 正是拿它发请求（agent-loop agent.ts 组装段实证），headless
   * 每轮新进程时首轮唯一可得；②requestMaxTokens 观测（agent/request 瀑布，本进程
   * step≥2 才有）；③`llm.resolveModelInfo().defaultMaxTokens`——请求缺 maxTokens 时
   * llm 服务在瀑布**之后**注入（resolveCallWithInfo 实证），②对它失明、①会被
   * adapterDefaults 剥除。三源全缺（端点缺省 mct 在请求面不可见）才退
   * DEFAULT_EGRESS_OUTPUT_RATIO×声明窗。2026-11-14 撞墙探针勘误：本端点 400 计数是
   * prompt 单独（288,292 与显式 max_tokens=1024 同数），prompt+65,536 联合超窗**照跑**
   * 并被服务端钳位到窗−prompt（精确到 token）——R2「273,639=prompt+65,536」系误读；
   * 预留 mct 的依据改为「严格 provider 强制 prompt+mct≤窗 + 钳位区是静默截断区
   * （T23）」，不再是「本端点按 prompt+mct 拒收」。
   * 逃生口互斥（审查 F5）：ARGP_FACTOR_PRESSURE=1 的"旧世界字节级复现"契约要求本闸
   * 不挂（调用点门控）——两 env 各管各的对照世界，不叠乘。
   * 400 overflow 通路在缺省关形态下是主自动触发（网即通路）；开闸时它退为最后兜底
   * （网不拆：声明窗未知/断锚/剪空/线≤0 → 照发，由 overflow 链接管——严格不差于现状）。
   * @returns true = 本步已发剪事务（调用方把同 step 的浓缩闸顺延，不吃二次重铸）。
   */
  /** 压缩阈值实时值（volatile thunk / 裸值两态兼容；0 或缺省 = 关）。 */
  private get compactionThreshold(): number {
    const raw = this.rawConfig.compactionThreshold as unknown
    if (typeof raw === 'number') return raw
    const get = (raw as Volatile<number> | undefined)?.get
    return typeof get === 'function' ? get.call(raw) : 0
  }

  /**
   * §A 有效上下文窗：`min(声明窗, observedCap)`；任一未知则取已知的那个。
   * 只有当 400 报文报出真实上限（observedCap）时才会 < 声明窗，进而修死锁；
   * observedCap 未知 ⇒ 等于声明窗（默认行为字节不变）。
   */
  private effectiveWindowFor(session: Session): number {
    const declared = this.declaredContextWindows.get(session) ?? 0
    const observed = this.observedContextWindows.get(session) ?? 0
    if (declared > 0 && observed > 0) return Math.min(declared, observed)
    return Math.max(declared, observed)
  }

  /** §A budget.ts 钩子：本会话已学到的 observedCap（未学到 ⇒ undefined，budget 不封顶）。 */
  observedContextWindow(session: Session): number | undefined {
    const v = this.observedContextWindows.get(session)
    return v !== undefined && v > 0 ? v : undefined
  }

  /**
   * Issue4（2026-11-17，design-2.1.0-batch §2）：B-6 盲区风险摘要——**只读、近似诊断**。
   * 触发 = 不可剪 live 估算 ≥ windowRatio × 声明窗：可剪面全剪光后仍会逼近声明窗，
   * 宿主组装层将无痕截断最旧 live 节点（README 已知限制 B-6，根治在 dsh 侧）。
   * 近似口径（台账 §6-R4 裁定的落点）：不可剪 = 非 R 原子（U/A/X/system 可见面）
   * + 未闭合轮 R；焦点/sticky/召回对等硬保护位**未计**（方向=低估不可剪量=漏报风险，
   * 卡面文案带「近似」）。**禁走 `FactorEngine.decide`**——其 observe() 有
   * ledger/观察游标/快照采样副作用（factor/engine.ts:459-496），卡面渲染不得污染压缩状态。
   */
  b6RiskSummary(session: Session): { declaredWindow: number; nonPrunableTokens: number; ratioPct: number; warn: boolean } {
    const declared = this.effectiveWindowFor(session)
    if (declared <= 0) return { declaredWindow: 0, nonPrunableTokens: 0, ratioPct: 0, warn: false }
    const openTurn = detectOpenTurn(session)
    const atoms = atomize(this as unknown as GraphBuildHost, session)
    let chars = 0
    let cjk = 0
    for (const a of atoms) {
      if (a.type === 'R' && (openTurn === null || a.turn < openTurn)) continue
      chars += a.text.length
      cjk += countCjkChars(a.text)
    }
    const tokens = Math.ceil(estTokensFromStats(chars, cjk))
    return {
      declaredWindow: declared,
      nonPrunableTokens: tokens,
      ratioPct: Math.round((tokens / declared) * 100),
      warn: tokens >= declared * this.windowRatio,
    }
  }

  /**
   * live surface 样本混合密度（Issue5）：token→chars 反向换算（deficit→chars、
   * /argp 卡面历史字符数换算）共用口径。非 CJK-only 样本精确回 charsPerToken
   * （等价锁，见 budget.liveBlendCharsPerToken）。
   */
  liveCharsPerToken(session: Session): number {
    return liveBlendCharsPerToken(session, this.charsPerToken)
  }

  private async egressGate(agent: CompactionAgentContext, signal: AbortSignal, incomingTokens: number, lineRatio: number | null = null): Promise<boolean | 'blocked'> {
    const session = agent.session
    if (signal.aborted) return false
    this.bindSession(session) // D2：同钩子内 factorPressure（逃生口开时）的 await 窗口可能已换桶——回绑再测量
    let declaredWindow = this.declaredContextWindows.get(session) ?? 0
    if (declaredWindow <= 0) {
      // 冷 resume 第二道兜底（2026-11-13 R2 实锤）：历史日志缺失/裁剪时，宿主
      // requestContext() 仍持有权威声明值；拿到即回填，避免闸再次失明。
      const reqCtx = (session as unknown as { requestContext?: () => { contextWindow?: number } | undefined }).requestContext?.()
      if (reqCtx?.contextWindow !== undefined && reqCtx.contextWindow > 0) {
        declaredWindow = reqCtx.contextWindow
        this.declaredContextWindows.set(session, declaredWindow)
      }
    }
    if (declaredWindow <= 0) return false // 声明窗未知：宁缺勿错，交给 400 兜底网
    // §A：若学到真实上限，压力线按有效窗（min 声明/真实）计——否则声明>真实时
    // 0.8×声明线永不可达、闸永不触发（死锁）。
    const observedEgress = this.observedContextWindows.get(session) ?? 0
    if (observedEgress > 0) declaredWindow = Math.min(declaredWindow, observedEgress)
    const measurement = this.measureTokens(session, incomingTokens)
    if (measurement.source !== 'anchored') return false
    // 两种线形（resolveEgress）：设置「压缩阈值」比例线（lineRatio 非空）直接取窗×比例，
    // 不做输出预算三源探测；env=1 旧公式线保留三源取 max（预算语义见 docblock 头部）。
    let outputBudget = 0
    let line: number
    if (lineRatio !== null) {
      line = Math.round(declaredWindow * lineRatio)
    } else {
      const knownBudgets = [
        (agent.options as { maxTokens?: number }).maxTokens,
        this.requestMaxTokens.get(session),
        await this.modelDefaultMaxTokens(agent), // await 后无 this.rt 裸读（measurement 已定格；compactIfNeeded 自回绑）
      ].filter((n): n is number => typeof n === 'number' && n > 0)
      outputBudget = knownBudgets.length > 0
        ? Math.max(...knownBudgets)
        : Math.floor(declaredWindow * DEFAULT_EGRESS_OUTPUT_RATIO)
      line = declaredWindow - outputBudget - Math.round(declaredWindow * DEFAULT_EGRESS_MARGIN_RATIO)
    }
    if (line <= 0 || measurement.contextTokens < line) return false // 线≤0=输出预算吃满窗：闸自缚，400 网接（审查 F7 入账）
    this.log.info('[argp-factor-egress] 出口闸过线·先剪后发: projected=' + measurement.contextTokens
      + ' ≥ line=' + line + '（声明窗=' + declaredWindow + (lineRatio !== null ? '，压缩阈值=' + lineRatio : '，输出预算=' + outputBudget) + '）')
    const result = await this.compactIfNeeded(agent, 'pressure', signal, incomingTokens)
    // 2026-11-13 硬校验（长跑 T34 实锤）：事务后二次测量；仍 ≥ 声明窗 ⇒ 拒绝发送
    // （pre-step 返回 {kind:'reject'}），绝不把注定 400 的请求发出去。组剪正常时应远低于窗。
    const after = this.postPruneProjection(session, incomingTokens)
    if (after >= declaredWindow) {
      this.log.warn('[argp-factor-egress] 剪后仍超窗：projected=' + after
        + ' ≥ 声明窗=' + declaredWindow + '；本步拒绝发送（不再发注定 400 的请求）')
      return 'blocked'
    }
    if (after >= line) {
      this.log.info('[argp-factor-egress] 剪后仍在线上但未超窗：projected=' + after
        + ' ≥ line=' + line + '（估计误差；本步放行，下轮再剪）')
    }
    return result !== null
  }

  /** §9.37 出口闸·输出预算档③：模型注册面的缺省输出预算（每会话探一次，0=已探无）。 */
  private async modelDefaultMaxTokens(agent: CompactionAgentContext): Promise<number | undefined> {
    const session = agent.session
    const cached = this.modelDefaultMaxTokensCache.get(session)
    if (cached !== undefined) return cached > 0 ? cached : undefined
    const provider = agent.options.provider
    const model = agent.options.model
    if (provider === undefined || model === undefined) return undefined // 无路由信息：不探也不缓存（拿到路由的会话再探）
    const llm = this.ctx.get('llm') as
      | { resolveModelInfo?: (p: string, m: string, s: AbortSignal) => Promise<{ defaultMaxTokens?: number }> }
      | undefined
    if (llm?.resolveModelInfo === undefined) {
      this.modelDefaultMaxTokensCache.set(session, 0)
      return undefined
    }
    const ac = new AbortController()
    const timer = setTimeout(() => { ac.abort() }, 5000) // P1.3 同口径：hang 转 rejection，pre-step 绝不被探测卡死
    try {
      const info = await llm.resolveModelInfo(provider, model, ac.signal)
      const declared = info?.defaultMaxTokens
      this.modelDefaultMaxTokensCache.set(session, typeof declared === 'number' && declared > 0 ? declared : 0)
    } catch {
      this.modelDefaultMaxTokensCache.set(session, 0)
    } finally {
      clearTimeout(timer)
    }
    const v = this.modelDefaultMaxTokensCache.get(session)
    return v !== undefined && v > 0 ? v : undefined
  }

  /**
   * 宿主原生 tool-result-pruner 二次收紧（2026-11-13 引入，2026-11-14 裁定改为组剪之后）。
   *
   * 与 factor 组剪**同一笔** `compactIfNeeded` 动作：先按 alpha2 口径把 A+R 协议组
   * 整组归零（目标 = 真实缺口），再对剩余 surface 上所有 > thresholdChars 的
   * `tool/result` 切成 head/middle/tail（0-LLM、确定性、原文恒留 append-only 日志）——
   * 后者专打组剪动不了的部分（焦点/open 轮 read、A 仍存活的 R）。
   * pruner 的 `compaction/prune` 事件落在我们的 `compaction/end` 之后，因此
   * `rebuildLedgerFromLog` 不会把它并进组剪事务账；`shadowedSeqsOf` 照常计入。
   *
   * 约束：宿主只允许 open turn 内做 `tool/result` replace（durable turn work）；
   * 轮间 manual compact 无 open turn ⇒ 跳过。服务缺失/异常 ⇒ no-op，不阻断组剪。
   */
  private nativePruneToolResults(session: Session): { pruned: number; charsRemoved: number } {
    const pruner = this.ctx.get('toolResultPruner') as NativeToolResultPruner | undefined
    if (pruner?.pruneSession === undefined) {
      if (!this.nativePrunerMissingLogged.has(session)) {
        this.nativePrunerMissingLogged.add(session)
        this.log.info('[argp-factor-native-prune] toolResultPruner 服务未挂载，跳过全局预剪')
      }
      return { pruned: 0, charsRemoved: 0 }
    }
    // null=无开放轮（宿主只允许改写 open-turn 的 tool/result，闭合态改写必被拒）；
    // -1=开放轮号不可读（畸形日志，fail-closed 哨兵）——同样不赌改写，跳过。
    const openTurnForPrune = detectOpenTurn(session)
    if (openTurnForPrune === null || openTurnForPrune < 0) {
      this.log.info('[argp-factor-native-prune] 无 open turn，跳过 tool/result 全局预剪')
      return { pruned: 0, charsRemoved: 0 }
    }
    try {
      const result = pruner.pruneSession(session)
      const pruned = Array.isArray(result?.pruned) ? result.pruned.length : 0
      const charsRemoved = typeof result?.charsRemoved === 'number' ? result.charsRemoved : 0
      if (pruned > 0) {
        this.log.info('[argp-factor-native-prune] 全局预剪 ' + pruned + ' 枚 / ' + charsRemoved + ' chars')
      }
      return { pruned, charsRemoved }
    } catch (e) {
      this.log.warn('[argp-factor-native-prune] 全局预剪异常（不阻断，继续 factor 组剪）：'
        + (e instanceof Error ? e.message : String(e)))
      return { pruned: 0, charsRemoved: 0 }
    }
  }

  override async compactIfNeeded(
    agent: CompactionAgentContext,
    trigger: CompactionTrigger,
    signal: AbortSignal,
    /** 本步已 claim 未落盘的 user 消息估值（轮初专用；其余调用点省略）。 */
    incomingTokens = 0,
  ): Promise<CompactionResult | null> {
    const session = agent.session
    if (signal.aborted) return null // 进入即已取消：不动 surface，调用方各自的 aborted 分支接管
    if (this.skipIfPreset(session)) return null
    this.bindSession(session) // A7（问题 3）：compactIfNeeded 也走统一绑定（含账目懒重建）
    const { windowTokens, retainTokens, declaredKnown } = await this.resolveScaledBudgets(agent)
    // D2（beta.1 评审）：上面这个 await 的窗口内，其他会话的 pre-step 可能已把焦点桶
    // （this.rt）换装——恢复后必须先回绑本会话再继续，否则 measureTokens 的锚点
    // 等 getter 层字段全部落到别人的桶（多会话串台）。回绑幂等（焦点未动即早退）。
    this.bindSession(session)
    signal.throwIfAborted() // 取消优先于任何事务写点（错误分类：abort 不属于可重试类别）
    const thresholdTokens = windowTokens - this.reserveTokens
    // thresholdTokens 只用于压力口径的早退；context-overflow 是 provider 已确认超窗，
    // reserve 再大也必须尝试事务（否则 400 恢复被静默禁用，请求原样失败）。
    if (thresholdTokens <= 0 && trigger !== 'context-overflow') {
      this.log.info('[argp-engine] pressure check: reserveTokens exceeds windowTokens, skip')
      return null
    }
    let measurement = this.measureTokens(session, incomingTokens)
    // §B 分派（ARGP_FACTOR_DISPATCH=1 影子 / =2 接管）：只读采快照 → 纯函数定形态。
    // shadow 只记日志不改发射；takeover 按形态走 compactByDispatch（判据表主权）。
    const dispatchMode = resolveDispatchMode()
    let dispatchDecision: DispatchDecision | null = null
    if (dispatchMode !== 'off' && (trigger === 'context-overflow' || declaredKnown)) {
      try {
        const wEff = this.effectiveWindowFor(session)
        const b6 = this.b6RiskSummary(session)
        // 'exclude'：宿主再注入三件套不计散文（假量）。takeover 事务开头有结构去重
        // （dedupeReinjected），旧副本回收通道在接管形态下已闭合。
        // 口径注记（审查 F5）：shadow 世界照此 'exclude' 采快照，但其实际发射走旧双闸
        // （hrMode='prose'）——影子行的散文量与旧世界发射口径有系统性小偏差，仅记录面、
        // 不改发射；影子审计比数时按此折价。
        // 三桶合并扫描（§1.2）：total=旧 proseStats 口径字节不变；aged=span 实际可驱逐。
        const pst = this.prose.scanProseBuckets(session, 'exclude')
        const cpt = Math.max(1, this.liveCharsPerToken(session))
        const proseTok = Math.ceil(pst.totalChars / cpt)
        const sendTok = summarySendTokens(wEff)
        const cTok = measurement.contextTokens
        const snapshot = {
          trigger, contextTokens: cTok, retainTokens, windowEff: wEff,
          floorTokens: b6.nonPrunableTokens, prunableTokens: Math.max(0, cTok - b6.nonPrunableTokens),
          condensableProseTokens: proseTok, summarySendTokens: sendTok,
          condensableProseAgedTokens: Math.ceil(pst.agedChars / cpt),
          toolFaceTokens: Math.ceil(pst.toolFaceChars / cpt),
        }
        dispatchDecision = planForm(snapshot)
        const record = { t: Date.now(), mode: dispatchMode, ...snapshot, form: dispatchDecision.form, reason: dispatchDecision.reason, outBudget: dispatchDecision.outBudget }
        this.log.info('[argp-dispatch] ' + JSON.stringify(record))
        const dispatchLogPath = resolveDispatchShadowLogPath()
        if (dispatchLogPath !== undefined) {
          try { appendFileSync(dispatchLogPath, JSON.stringify(record) + '\n') } catch { /* 落盘失败不改变任何发射 */ }
        }
      } catch (e) {
        const msg = e instanceof Error ? (e.stack ?? e.message) : String(e)
        this.log.warn('[argp-dispatch] 分派决策异常（不影响发射）：' + msg)
        const failPath = resolveDispatchShadowLogPath()
        if (failPath !== undefined) {
          try { appendFileSync(failPath, JSON.stringify({ t: Date.now(), mode: dispatchMode, form: 'decision-failed', reason: msg.split('\n')[0] }) + '\n') } catch { /* 落盘失败不改变任何发射 */ }
        }
        dispatchDecision = null
      }
    }
    if (dispatchMode === 'takeover') {
      // dispatchDecision 非 null 已蕴含进入条件（overflow 或 declaredKnown）。
      // 主权闭环：决策缺失（快照异常/window 未知）不得落回旧双闸——旧闸 condense 是
      // legacy transcript 形（缓存不友好、绕过判据主权、G2 不可见，g5-focus 实锤漏道）；
      // 兜底形 = prune-only 0-LLM 求生剪（dedup+组剪，LLM 杠杆在无决策时禁用）。
      return await this.compactByDispatch(agent, session,
        dispatchDecision ?? { form: 'prune-only', reason: 'takeover 兜底：分派决策缺失（快照异常或窗口未知），禁用 LLM 通路' },
        windowTokens, retainTokens, incomingTokens, signal)
    }
    // ── factor 分发（P6-④ 触发收敛后口径）：本方法只被两信号驱进
    // （手动 compactNow / request-error 钩子的 context-overflow）——pre-step 估算驱动已
    // 退役（factorPressure 仅存于 ARGP_FACTOR_PRESSURE=1 逃生口）。事务内动作序：
    // A+R 组剪（0-LLM，整组归零；deficit = 真实口径 − retain）→ 原生 pruner 二次收紧
    // 剩余大 R（0-LLM，head/middle/tail；焦点/open 轮里组剪动不了的 read）→ 散文浓缩
    // （(sys+散文)÷声明窗 > 50% 才动，one-shot 原生式，factor 臂唯一 LLM 摘要通路）→
    // 词表 note 事务收尾（P6-② 违规点整改：note 变化时机 = 压缩时机）。
    if (trigger === 'context-overflow' || declaredKnown) {
      // 2026-11-14 用户裁定：先组剪、后 pruner。反序（pruner 先切）会把大 R 变成派生
      // 克隆，组剪随后按 root 建账认不到克隆，整组反而驱逐不了，留下永久配重。
      let pruned: CompactionResult | null = null
      const deficit = measurement.contextTokens - retainTokens
      if (deficit > 0) {
        // Issue5：deficit→chars 按 live 面样本混合密度（CJK 重的面同额 token 只需更少字符）
        // 包二 A1：W_eff 透传 ⇒ 焦点名额按 δ·W_eff 预算收缩（窗未知才回退固化 N）。
        pruned = this.factor.compactIfNeeded(session, Math.floor(deficit * this.liveCharsPerToken(session)),
          { windowEffTokens: this.effectiveWindowFor(session) })
      }
      let native = { pruned: 0, charsRemoved: 0 }
      if (trigger === 'context-overflow' || measurement.contextTokens > retainTokens) {
        native = this.nativePruneToolResults(session)
      }
      if (native.pruned > 0) {
        this.log.info('[argp-factor] 同笔压缩：组剪目标 ' + Math.max(0, deficit) + ' tok → native pruner 二次收紧 '
          + native.pruned + ' 枚 / ' + native.charsRemoved + ' chars')
      }
      let proseResult: CompactionResult | null = null
      // §9.36 闸二（ctx ≥ windowRatio×声明窗）契约="由调用点保证"：overflow 天然满足
      // （provider 已拒收）；'pressure' 现由 §9.37 出口闸驱进且线可低至任意 >0（设置
      // 压缩阈值比例线）或 ≈0.73×窗（env=1 旧公式线）——闸二必须在此补检，LLM 浓缩链
      // 不得被自动通路提前触达（审查 F2；手动 compactNow 免闸二不受影响）。
      const proseGateOk = trigger === 'context-overflow' || measurement.contextTokens >= windowTokens
      if (declaredKnown && proseGateOk) {
        try {
          proseResult = await this.prose.condense(session, agent.options, windowTokens, signal, this.effectiveWindowFor(session))
        } catch (e) {
          this.log.warn('[argp-factor-prose] 散文浓缩异常（本轮不处置）：' + (e instanceof Error ? e.message : String(e)))
        }
      }
      // note 只在**真有事务**时刷新：空转（无可剪面且无可浓缩段）也 replace note 会
      // 让 surface.replaceGeneration 增长——400 恢复钩子会把它误判成"已减量"而重发
      // 同一超窗请求（并且违背 note 变化时机=压缩时机的前缀纪律）。
      if (proseResult !== null || pruned !== null) await this.refreshFactorNoteSafe(agent)
      return proseResult ?? pruned
    }
    return null
  }

  /**
   * §B-2b 接管事务（ARGP_FACTOR_DISPATCH=2）：按分派形态发射，双闸主权在判据表。
   * 公共前缀：结构去重（宿主再注入旧副本回收，0-LLM）。形态语义：
   *  - prune-only → 组剪 + native 收紧，**不调**浓缩链；
   *  - summarize-then-prune → 先浓缩（dispatchApproved + 分派器输出预算）→ **复测**，
   *    仍有 deficit 才补组剪（§B 定稿：复测判据，不凭决策时的旧 deficit）；
   *  - summarize-only → 只浓缩；
   *  - terminal-b6 → 会话级连续计数：≥3 轮不空转（去重 + 上报，不再组剪），
   *    否则降级求生组剪（能减一点是一点）；
   *  - none → 如实上报（below-retain 不该进到这里 / stop+report）。
   * note 刷新沿用现不变量：有真事务才刷（空转不动 surface）。
   */
  private async compactByDispatch(
    agent: CompactionAgentContext,
    session: Session,
    decision: DispatchDecision,
    windowTokens: number,
    retainTokens: number,
    /** 本步已 claim 未落盘的 user 消息估值——必须与出口闸/进入判据**同口径**计入，
     *  否则每笔事务系统性欠剪「本轮启动量」一档（工具域实锤：残留高一档 → 出口闸
     *  再触发 → 入账笔数与累计驱逐翻倍，read 35→27）。 */
    incomingTokens: number,
    signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    // §G 排序：摘要形态必须**先发 LLM**（P 还是热前缀，逐字节复用缓存），dedup/组剪
    // 等 surface 变更一律排在其后；其余形态 dedup 照旧打头。
    const isSummarize = decision.form === 'summarize-only' || decision.form === 'summarize-then-prune'
    let dedup: CompactionResult | null = isSummarize ? null : this.factor.dedupeReinjected(session)
    signal.throwIfAborted()
    let pruned: CompactionResult | null = dedup
    let proseResult: CompactionResult | null = null
    const st = this.stateOf(session)
    const doGroupPrune = (): CompactionResult | null => {
      // 复测口径：浓缩/去重后 surface 已变，deficit 用当前测量重算（含 incomingTokens）。
      const deficit = this.measureTokens(session, incomingTokens).contextTokens - retainTokens
      let r: CompactionResult | null = null
      // 包二 A1：W_eff 透传（复测口径下 surface 已变，名额按当前窗重折）。
      if (deficit > 0) r = this.factor.compactIfNeeded(session, Math.floor(deficit * this.liveCharsPerToken(session)),
        { windowEffTokens: this.effectiveWindowFor(session) })
      this.nativePruneToolResults(session)
      return r
    }
    switch (decision.form) {
      case 'terminal-b6': {
        st.b6Streak += 1
        if (st.b6Streak >= 3) {
          this.log.warn('[argp-dispatch] terminal-b6 连续 ' + st.b6Streak + ' 轮：不空转（仅去重+上报）：' + decision.reason)
          if (dedup !== null) await this.refreshFactorNoteSafe(agent)
          return dedup
        }
        this.log.warn('[argp-dispatch] terminal-b6（第 ' + st.b6Streak + ' 轮）：降级求生组剪：' + decision.reason)
        pruned = doGroupPrune() ?? dedup
        break
      }
      case 'summarize-only':
      case 'summarize-then-prune': {
        st.b6Streak = 0
        try {
          proseResult = await this.prose.condense(session, agent.options, windowTokens, signal,
            this.effectiveWindowFor(session),
            { approved: true, maxOutputTokens: decision.outBudget ?? summaryMaxTokensOut(this.effectiveWindowFor(session)) })
        } catch (e) {
          if (signal.aborted) throw e
          this.log.warn('[argp-dispatch] 散文浓缩异常（本轮不处置）：' + (e instanceof Error ? e.message : String(e)))
        }
        signal.throwIfAborted()
        this.bindSession(session) // D2：condense await 窗口内焦点可能换装——回绑再写 surface
        dedup = this.factor.dedupeReinjected(session) // 摘要请求已发出，surface 现在可以动了
        // §F：只有摘要**真的重建了面**才作废 churn 旧账。proseResult=null（barrier 断供/
        // 散点不发射/浓缩异常）⇒ surface 未动，此处清账会让断供轮每轮抹掉 §F 账、
        // g2 型浅剪连发复活（2.2.x 设计稿 §1.2 附带修复）。
        if (proseResult !== null) {
          st.lastPruneRelease = -1
          st.lastPruneEntryCtx = 0
        }
        pruned = (decision.form === 'summarize-then-prune' ? doGroupPrune() : null) ?? dedup
        break
      }
      case 'prune-only': {
        st.b6Streak = 0
        // §F 最小 churn 保护（两因子，缺一不可）：上一次 prune-only 事务**实际释放**
        // < 地板（事务无效——g2 实锤：26-29K 同一面 11 连发、bill 416K）∧ 本次入场
        // 相对上次处置点无 ≥地板 的增长（没有新可剪面进来）。健康锯齿（focus 求生剪
        // 每次释放 ~14K）第一因子即不成立，不受影响；结构去重照发（防再注入累积）。
        const churnFloor = Math.max(CHURN_MIN_RELEASE_TOKENS, Math.round(CHURN_RELEASE_FLOOR_RATIO * this.effectiveWindowFor(session)))
        const ctxBefore = this.measureTokens(session, incomingTokens).contextTokens
        if (st.lastPruneRelease >= 0 && st.lastPruneRelease < churnFloor
          && st.lastPruneEntryCtx > 0 && ctxBefore - st.lastPruneEntryCtx < churnFloor) {
          this.log.warn('[argp-dispatch] churn 抑制：上次 prune-only 仅释放 ' + st.lastPruneRelease +
            ' tok 且入场无新面（' + st.lastPruneEntryCtx + '→' + ctxBefore + '，地板 ' + churnFloor + '），本轮跳过组剪：' + decision.reason)
          st.lastPruneEntryCtx = ctxBefore
          pruned = dedup
          break
        }
        this.log.info('[argp-dispatch] prune-only：' + decision.reason)
        pruned = doGroupPrune() ?? dedup
        if (pruned !== null) {
          st.lastPruneRelease = ctxBefore - this.measureTokens(session, incomingTokens).contextTokens
          st.lastPruneEntryCtx = ctxBefore
        }
        break
      }
      default: {
        // 'none'（below-retain / stop+report）与不可达形态的防御出口：不动作，只上报。
        st.b6Streak = decision.form === 'none' && decision.reason.includes('无需压缩') ? 0 : st.b6Streak
        if (decision.reason.includes('停止并上报') || decision.form === 'prune-then-summarize') {
          this.log.warn('[argp-dispatch] stop+report：' + decision.reason)
        }
        pruned = dedup
      }
    }
    if (proseResult !== null || pruned !== null) await this.refreshFactorNoteSafe(agent)
    return proseResult ?? pruned
  }

  override async compactNow(
    agent: ManualCompactAgentContext,
    signal: AbortSignal,
    sourceCommandId?: CommandId,
  ): Promise<CompactionResult | null> {
    if (this.skipIfPreset(agent.session)) return null
    // factor 手动压缩（P6-④：手动 compact 是两信号之一）：全量剪（能剪多少剪多少——
    // 目标 = 全部可剪面，硬保护自然兜底）→ 散文浓缩 → 词表 note 事务收尾。与
    // compactIfNeeded factor 分发同一动作序；sourceCommandId 经 host 透传三事件
    // （prune-tx 契约），事务后复位防串账。
    if (signal.aborted) return null
    this.bindSession(agent.session)
    this.compactSourceCommandId = sourceCommandId
    try {
      // 手动压缩必须走 runMaintenance（宿主契约：idle 任务，活跃 turn 中调用会同步
      // throw"already active"）——旧实现经 session-lifecycle.compactNow 有这一层，
      // factor 直调后丢了；直接改 surface 会与驱动轮交错。
      const run = async (agentSignal: AbortSignal): Promise<CompactionResult | null> => {
        const opSignal = AbortSignal.any([signal, agentSignal])
        opSignal.throwIfAborted()
        // 同一动作序（2026-11-14 用户裁定）：factor 组剪（手动=全量，目标 MAX）→
        // 原生 pruner 二次收紧剩余大 R。宿主 manual compact 走 idle maintenance，
        // 通常无 open turn ⇒ pruner no-op。
        const pruned = this.factor.compactIfNeeded(agent.session, Number.MAX_SAFE_INTEGER)
        const native = this.nativePruneToolResults(agent.session)
        if (native.pruned > 0) {
          this.log.info('[argp-factor] 手动压缩：native pruner 二次收紧 ' + native.pruned + ' 枚 / ' + native.charsRemoved + ' chars')
        }
        opSignal.throwIfAborted()
        let proseResult: CompactionResult | null = null
        const { windowTokens, declaredKnown } = await this.resolveScaledBudgets(agent)
        opSignal.throwIfAborted() // await 窗口内被取消：按契约抛 AbortError，不吞成"成功"
        this.bindSession(agent.session) // D2：await 窗口内焦点可能换装——回绑再写 surface
        if (declaredKnown) {
          try {
            // form:'host'（2026-11-27 实测修正）：手动压缩的摘要也走宿主同款装配，
            // 复用主对话热前缀。旧 A 形态会重建 U:/A: transcript（无 system 头、带行内
            // 角色标记），与上一发请求从第 0 个 token 就不同 —— 实测 118K prompt /
            // cached=0 / 33.3s。不借 approved：散文闸一与淘汰口径保持手动语义。
            proseResult = await this.prose.condense(agent.session, agent.options, windowTokens, opSignal, this.effectiveWindowFor(agent.session), { form: 'host' })
          } catch (e) {
            if (opSignal.aborted) throw e // 取消不是"本轮不处置"：必须向上传播
            this.log.warn('[argp-factor-prose] 手动散文浓缩异常（本轮不处置）：' + (e instanceof Error ? e.message : String(e)))
          }
        }
        const result = proseResult ?? pruned
        if (result !== null) await this.refreshFactorNoteSafe(agent)
        return result
      }
      return typeof agent.runMaintenance === 'function'
        ? await agent.runMaintenance(run)
        : await run(signal)
    } finally {
      this.compactSourceCommandId = undefined
    }
  }

  override async compactRegion(
    _start: number,
    _end: number,
    _agent: CompactionAgentContext,
    _signal?: AbortSignal,
  ): Promise<CompactionResult> {
    // factor 臂只剪 R（A 永不入剪枝区间），没有"按区间剪"的语义。
    throw new Error('[argp-factor] 2.0 factor-only 引擎不支持按区间手动压缩（请在 UI 用 /compact 全量压缩）')
  }

  /**
   * 注册动态词表目录（宿主 `systemPrompt.context`）。
   *
   * 关键时序（2026-11-27 宿主源码核对）：`agent/pre-step` 的 system prompt
   * **在本钩子之前**已 assemble；但 `step()` 在发请求前会再调用
   * `systemPrompt.refreshContext()`，context provider 会重新求值。因此：
   *  - `systemPrompt.section` 在这里更新只会下一次请求可见，并可能额外打穿前缀缓存；
   *  - `systemPrompt.context` 可在本次压缩请求的 refreshContext 中看到事务收尾快照。
   *
   * 服务缺失（旧宿主/测试最小组合）时不注册，保留 refreshFactorNoteSafe 的
   * note 降级路径；注册成功后 note 不再承担目录，避免双份目录。
   */
  private registerVocabularyContext(ctx: Context): void {
    ctx.inject(['systemPrompt'], (scopedCtx: Context) => {
      const prompt = (scopedCtx as unknown as { systemPrompt?: SystemPromptContextLike }).systemPrompt
      if (prompt === undefined || typeof prompt.context !== 'function') return
      scopedCtx.effect(() => prompt.context({
        name: 'argp:vocabulary',
        // 放在运行时 context 尾部；不与宿主工作目录/审批/沙箱等前置上下文抢位置。
        order: 9999,
        // 压缩后的地址是模型续作所需的运行事实，不允许被 host 可选 context 关闭。
        required: true,
        text: ({ agent }) => {
          const session = agent?.session
          if (session === undefined) return ''
          return this.vocabularyContextText(session)
        },
      }))
      this.vocabContextRegistered = true
      this.log.info('[argp] vocabulary context registered (systemPrompt.context; synced with successful compaction)')
    })
  }

  /**
   * 读取 systemPrompt.context 的会话快照。首次访问时从当前账本拍一次快照
   * （冷 resume/测试直挂场景）；之后只读快照，不在 provider 内重复 observe。
   */
  private vocabularyContextText(session: Session): string {
    let snapshot = this.vocabSnapshots.get(session)
    if (snapshot === undefined) {
      snapshot = this.factor.vocabularySnapshot(session)
      this.vocabSnapshots.set(session, snapshot)
    }
    return snapshot.text
  }

  /** 事务成功收尾：冻结本会话的目录快照；失败/空事务不得调用。 */
  private refreshVocabularySnapshot(session: Session): void {
    this.vocabSnapshots.set(session, this.factor.vocabularySnapshot(session))
  }

  /**
   * 记录一次成功的压缩事务收尾（`compaction/end` 无 error）。
   *
   * 只有成功收尾才置游标：失败/中断的 end 带 `error`，其后的请求并没有经历
   * "历史被改写"这件事，算成压缩后重灌会把失败压缩的代价记到成功账上。
   */
  private noteCompactionEnd(session: Session, event: unknown): void {
    const data = (event as { data?: { compactionId?: unknown; error?: unknown } }).data
    const cid = data?.compactionId
    if (typeof cid !== 'string' || data?.error !== undefined) return
    const st = this.stateOf(session)
    st.lastCompaction = { id: cid, at: Date.now(), turn: turnOf(event as never) ?? null }
    st.compactionAwaitingReply = true
  }

  /**
   * 每请求缓存采样（2.2.3，见 cache-audit.ts）。
   *
   * 观测点选在 `assistant/message` 的 usage 上：`cacheReadTokens` 与 `inputTokens`
   * 互斥，前者=复用前缀、后者=必须真 prefill。压缩改动早期上下文后，保留段在
   * 首请求里必然 miss 一次；**同一次压缩后的续作仍低命中**才是异常（另有抖前缀源）。
   *
   * 「首请求」用事务游标判定而不是时间窗：`compaction/end` 无 error 置位，
   * 下一条带 usage 的应答消费之。若事务后跨了轮次才有应答（请求被中止/报错，
   * 根本没发出去），视为陈旧标记——不把它算作「压缩后首请求」，否则正常冷启会被
   * 误报成重灌。
   */
  private recordCacheSample(
    session: Session,
    event: unknown,
    usage: { inputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number },
  ): void {
    try {
      const st = this.stateOf(session)
      const data = (event as { data?: { turn?: unknown; step?: unknown } }).data
      const turn = typeof data?.turn === 'number' ? data.turn : null
      const step = typeof data?.step === 'number' ? data.step : null
      const last = st.lastCompaction
      const firstAfter = st.compactionAwaitingReply && last !== null
        && (last.turn === null || turn === null || turn <= last.turn + 1)
      const stale = st.compactionAwaitingReply && !firstAfter
      const sample = buildRequestCacheSample({
        at: Date.now(),
        turn,
        step,
        inputTokens: usage.inputTokens ?? 0,
        cacheReadTokens: usage.cacheReadTokens ?? 0,
        cacheWriteTokens: usage.cacheWriteTokens ?? 0,
        compaction: last === null || stale ? null : last,
        firstAfterCompaction: firstAfter,
      })
      pushBounded(st.cacheSamples, sample, this.telemetryCap)
      st.compactionAwaitingReply = false
      const verdict = classifyCacheSample(sample)
      const pct = Math.round(sample.hitRatio * 100)
      // `+Xms` = 事务收尾到本次应答的间隔（压缩后首请求上≈prefill+生成，是首字延迟的
      // 粗代理；权威读数仍是 cached/prompt）。
      const where = 'prompt=' + sample.promptTokens + ' cached=' + sample.cachedTokens + ' (' + pct + '%)'
        + (sample.compactionId === null
          ? ''
          : ' tx=' + sample.compactionId + ' +' + (sample.sinceCompactionMs ?? 0) + 'ms')
      if (verdict === 'post-compaction-refill') {
        // info：压缩本身必然打断前缀一次，是设计代价而不是缺陷；留读数供验收比对。
        this.log.info('[argp-cache] post-compaction refill (expected once): ' + where)
      } else if (verdict === 'unexpected-refill' && isLowCacheHit(sample)) {
        // warn：同一事务后的续作仍低命中 ⇒ 还有别的抖前缀源（目录/系统段/宿主装配）。
        this.log.warn('[argp-cache] unexpected refill after compaction: ' + where
          + ' — the post-compaction repeat request still misses the prefix cache')
      }
    } catch (e) {
      // 观测失败不得影响请求主链（usage 锚点已在调用方落好）。
      this.log.warn('[argp-cache] sample failed: ' + (e instanceof Error ? e.message : String(e)))
    }
  }

  /**
   * 词表 note 迁入压缩事务收尾（P6-② 违规点整改，note 前缀炸弹案施工①）：note 变化时机
   * = 压缩时机——"缓存断点频率=压缩频率"不变量的 note 特化（T-3 定量证实每步一改一炸）。
   *
   * 2.2.3 起有 `systemPrompt.context` 时**不再写 note 目录**：目录由 context 快照承担；
   * note 仅作为无 systemPrompt 服务的降级路径（测试最小宿主/旧宿主）。
   *
   * steer 仅首注需要（更新走单节点 replace，指针以标记回溯为准）；本入口拿不到 steer
   * （CompactionAgentContext 无该成员）时首注跳过——下个有 steer 的压缩机会自然重试。
   */
  private async refreshFactorNoteSafe(agent: CompactionAgentContext): Promise<void> {
    // 先刷新目录快照：即使 note 注入失败/steer 不可用，context 仍能在本次请求发出去。
    try {
      this.refreshVocabularySnapshot(agent.session)
    } catch (e) {
      this.log.warn('[argp-factor] 词表快照刷新失败（压缩事务收尾，本轮跳过）：' + (e instanceof Error ? e.message : String(e)))
    }
    if (this.vocabContextRegistered) return
    const steerFn = (agent as unknown as { steer?: (message: unknown) => unknown }).steer
    try {
      await this.factor.refreshVocabularyNote(agent.session, text => {
        if (steerFn === undefined) throw new Error('steer unavailable at this compaction entry')
        return steerFn(createUserMessage({
          content: [{ type: 'text', text }],
          // auto-continue 同款 notice 形态：宿主按 X 归类（进请求、不参剪、UI 渲染 notice）。
          source: { kind: 'argp', form: 'notice', summary: 'factor vocabulary (pruned labels; recall_history keys)' },
        }))
      })
    } catch (e) {
      this.log.warn('[argp-factor] 词表 note 刷新失败（压缩事务收尾，本轮跳过）：' + (e instanceof Error ? e.message : String(e)))
    }
  }

  /**
   * factor 臂轮内维护（**仅 ARGP_FACTOR_PRESSURE=1 逃生口**，P6-④ 前旧世界复现）：
   * 先词表 note（旧时机 = 每 pre-step），后压力剪（估算驱动）。缺省路径（收敛后）不进本函数
   * ——note 已迁压缩事务收尾（refreshFactorNoteSafe）。
   */
  private async factorPressure(
    agent: CompactionAgentContext & { steer(message: unknown): unknown },
    incomingTokens = 0,
  ): Promise<void> {
    // 词表视图吞错自隔离：注入失败丢的是提示，不能把同钩子的压力剪一并带走。
    // 有 systemPrompt.context 时目录只跟成功事务刷新（快照不得在无事务时漂移）；
    // 无该服务时才走旧 note 降级。
    try {
      if (!this.vocabContextRegistered) {
        await this.factor.refreshVocabularyNote(agent.session, text => agent.steer(createUserMessage({
          content: [{ type: 'text', text }],
          // auto-continue 同款 notice 形态：宿主按 X 归类（进请求、不参剪、UI 渲染 notice）。
          source: { kind: 'argp', form: 'notice', summary: 'factor vocabulary (pruned labels; recall_history keys)' },
        })))
      }
    } catch (e) {
      this.log.warn('[argp-factor] 词表视图刷新失败（本轮跳过）：' + (e instanceof Error ? e.message : String(e)))
    }
    const { retainTokens, declaredKnown } = await this.resolveScaledBudgets(agent)
    if (!declaredKnown) return
    this.bindSession(agent.session) // D2：上方 await 窗口内焦点可能被其他会话的装配换桶——回绑后再测量
    const m = this.measureTokens(agent.session, incomingTokens, true)
    const deficit = m.contextTokens - retainTokens
    if (deficit <= 0) return
    // R 剪清不动（可剪面被硬保护占满）即本轮终态：无摘要兜底——factor 臂唯一 LLM
    // 摘要通路是散文浓缩链（prose-condenser），只在压缩事务内被调（触发收敛口径）。
    // ⚠️ Issue5 显式不改 + ADV-1 裁定（2026-11-17）：本函数=ARGP_FACTOR_PRESSURE=1
    // 逃生口的旧世界字节级复现契约——估算分量经 legacyPlain=true 冻结在 1.x 朴素密度
    // （measureTokens 上游已全局 CJK 加权，不 pin 则 CJK 会话 deficit 失真 ≈2×），
    // 此处再乘裸 charsPerToken 同为冻结面。勿"顺手"加权。
    const result = this.factor.compactIfNeeded(agent.session, Math.floor(deficit * this.charsPerToken))
    // 目录快照只跟成功事务走；本逃生口不产生事务（null）时保持上一版快照。
    if (result !== null && this.vocabContextRegistered) {
      try {
        this.refreshVocabularySnapshot(agent.session)
      } catch (e) {
        this.log.warn('[argp-factor] 词表快照刷新失败（压力剪收尾，本轮跳过）：' + (e instanceof Error ? e.message : String(e)))
      }
    }
    return
  }

  /**
   * A7 事务账目重建：resume 时从 append-only 日志扫描 compaction/start、compaction/prune、
   * compaction/end 事件重建 records/prunedNodeIndex/shadowedSeqsOf 状态；无 end 的 start 记 warn。
   * 不引入 WAL——日志本身即账目。幂等：已重建过的 compactionId 跳过（rebuiltCompactionIds 去重），
   * 使「setSession 自动重建」与「测试显式清空 records 后再重建」两种路径都安全。
   */
  rebuildLedgerFromLog(): void {
    rebuildLedgerFromLog(this as unknown as LifecycleHost)
  }
}

export default ArgpEngine
