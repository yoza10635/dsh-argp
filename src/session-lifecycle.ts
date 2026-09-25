/**
 * 会话生命周期 + 构造期装配（P5 Wave 3 第 4 步，C 报告 S1 + §4 蓝图 A：session-lifecycle 模块）。
 *
 * 从 hub `argp-graph-engine.ts` 迁出：
 *  - 构造期装配四函数中的三个：normalizeConfig（字段归一）/ registerSettings（UI 设置页注册）/
 *    mountPeratomStack（peratom 三管线自挂载 + maxOverflowRetries 提升 + citesObligation 解析）。
 *    （第四个 registerRecallTools 在 recall-tools.ts。）
 *  - 运行时方法：bindSession（统一绑定 + 账目懒重建）/ rebuildLedgerFromLog（A7 事务账目重建）/
 *    rearmReactive（反应式零候选重挂）/ compactNow（/compact 手动压缩入口）。
 *
 * 所有函数体逐字保留，仅 `this.x` → `host.x`（窄接口 LifecycleHost + `this as unknown as
 * LifecycleHost` 调用，编译期类型、运行时同一实例；方法引用经 host 派发回 class 薄编排方法，
 * this 绑定语义不变）。构造期副作用顺序由 hub 构造器调用次序保证（normalizeConfig →
 * registerSettings → mountPeratomStack → registerRecallTools → systemPrompt sections → ctx.on），
 * 与原先逐字一致。
 *
 * 设置页常量（ARG_SETTINGS_KEY / ArgpUserSettingsSchema / NAMESPACE_PATTERN / ARG_SETTINGS_NS）
 * 随 registerSettings 一并迁入本模块：ArgpUserSettingsSchema 是运行时值（z.object 产物），
 * 若留在 hub 会迫使本模块运行时 import hub 形成环；迁入后 hub 反向 import 本模块并 re-export，
 * 公共 API 不变（index.ts 的 `export *` 透出）。
 *
 * ArgpGraphConfig 经 type-only import 取用（编译期擦除，无运行时环）；它是 hub 侧的宽接口
 * （引用 peratom 三管线 config），若迁入本模块会迫使本模块 import peratom
 * 全部 config 类型，故按「深度依赖则留 hub」原则保留在 hub，本模块仅 type-only 引用。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CompactionAgentContext, CompactionResult, ManualCompactAgentContext } from '@deepseek-ai/dsh-compaction'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
import z from '@deepseek-ai/schemastery'
import type { Atom, AtomType, SemanticEdge, ArgpUserSettings } from './argp-types.js'
import { sessionEvents, turnOf } from './log-access.js'
import { classifyUserMessage } from './graph-build.js'
import { pushBounded, DEFAULT_TELEMETRY_CAP } from './telemetry.js'
import { DEFAULT_CHARS_PER_TOKEN, DEFAULT_MAX_PASSES, DEFAULT_RETAIN_RATIO, DEFAULT_RETAIN_TOKENS, DEFAULT_WINDOW_RATIO, DEFAULT_WINDOW_TOKENS } from './constants.js'
import { acquireTokenMeter, type TokenMeter } from './budget.js'
import { PeratomCompressor, type PeratomCompressorConfig } from './peratom/compressor.js'
import { CiteDeclarer, type CiteDeclarerConfig } from './peratom/cite-declarer.js'
import { RecallZoom, type RecallZoomConfig } from './peratom/recall-zoom.js'
import type { InferredEdgeOptions } from './token-ontology.js'
import type { PrunedNodeInfo } from './prune-selection.js'
import { selectManualRanges, compactRegions, buildTombstoneRedirect, type GraphPruneRecord, type PruneTxHost } from './prune-tx.js'
import type { ArgpGraphConfig } from './argp-graph-engine.js' // type-only：编译期擦除，无运行时环

// ── 设置页常量（自 hub 迁入；ARG_SETTINGS_KEY / ArgpUserSettingsSchema 经 hub re-export 维持公共 API）──
//
// NOTE: intentionally NO import of `installSettingsSection` / `settingsNamespace`
// from `@deepseek-ai/dsh-settings`: dsh 0.1.2-alpha.1 deleted both. A missing
// NAMED EXPORT is not a missing service — an ESM named import that resolves to
// nothing is a SyntaxError at module evaluation, which cordis reports as a
// failed entry and the host exits 1 (installing this plugin stops the host
// booting at all). Verified against the reference implementation
// (dshmarket/src/settings.ts) and confirmed by live probe on this host:
// `@deepseek-ai/dsh-settings` resolves but exports only
// SettingsConflictError / SettingsProvider / default / redactSecrets.
// The `settings` SERVICE itself never changed, so we call
// `settings.register(ns, schema, { base })` through `ctx.inject` — the
// graceful-degradation boundary — and validate the namespace locally.

/** 设置页 namespace key（同时是 Host 服务端与客户端卡片的 key，须一致才进渲染交集）。 */
export const ARG_SETTINGS_KEY = 'dsh-argp'

/** 引擎设置 schema（schemastery）：校验 UI 写入 + 提供 describe 视图。默认值=引擎既有默认。 */
export const ArgpUserSettingsSchema = z.object({
  windowRatio: z.number().min(0.1).max(1).default(DEFAULT_WINDOW_RATIO),
  retainRatio: z.number().min(0.05).max(1).default(DEFAULT_RETAIN_RATIO),
  maxPasses: z.number().step(1).min(1).default(DEFAULT_MAX_PASSES),
  recencyGuard: z.number().step(1).min(0).default(4),
  turnGuard: z.number().step(1).min(0).default(1),
  minSpanChars: z.number().step(1).min(0).default(0),
  enableSummarize: z.boolean().default(false),
  sortMode: z.string().default('density'),
  charsPerToken: z.number().min(0.5).max(8).default(DEFAULT_CHARS_PER_TOKEN),
}) as z<ArgpUserSettings>

/**
 * The namespace pattern `settingsNamespace` enforced before it was removed.
 * Kept as a literal check rather than an import (see the note above).
 */
const NAMESPACE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

/** Namespace the card on the browser side keys itself to. */
const ARG_SETTINGS_NS: string = ARG_SETTINGS_KEY

if (!NAMESPACE_PATTERN.test(ARG_SETTINGS_NS)) {
  throw new TypeError(`settings namespace "${ARG_SETTINGS_NS}" must match ${String(NAMESPACE_PATTERN)}`)
}

/**
 * 窄宿主接口：本模块函数实际触达的引擎成员（字段 + 方法引用）。
 * 方法引用（shadowedSeqsOf/rebuildLedgerFromLog/restoreUsageAnchor/catalogText/bindSession）
 * 经 host 派发到 class 上的薄编排方法，运行时 this 仍是引擎实例——与原先 `this.method(...)` 一致。
 */
export interface LifecycleHost {
  // 构造期字段（normalizeConfig / registerSettings / mountPeratomStack 写入）
  windowTokens: number
  retainTokens: number
  explicitWindowTokens: boolean
  explicitRetainTokens: boolean
  reserveTokens: number
  telemetryCap: number
  tokenMeterFn?: (session: Session) => { contextTokens: number; surfaceTokens: number }
  tokenMeter: TokenMeter | undefined
  degradationStrategy: 'lifecycle' | 'summarize' | 'force' | 'fail'
  turnBasis: 'semantic' | 'all'
  maxOverflowRetries: number
  midTurnPruneEnabled: boolean
  midTurnLegacyGuard: boolean
  midTurnTurnGuard: number
  reactiveRetries: number
  continuationNotice: string
  onOverflowCompress?: (session: Session) => Promise<void>
  onPrePressureCompress?: (session: Session) => Promise<void>
  closureWindowK: number
  citeMinPrefixLen: number
  overlapTheta: number
  enableOverlapChain: boolean
  injectEdges: ((atoms: Atom[]) => SemanticEdge[]) | undefined
  disableCiteEdges: boolean
  disableInferredEdges: boolean
  tombstoneMergeMinRun: number
  inferredOpts: InferredEdgeOptions
  peratomStack: {
    compressor: PeratomCompressor | null
    declarer: CiteDeclarer | null
    zoom: RecallZoom | null
  } | null
  citesObligation: boolean
  citesObligationAuto: boolean
  log: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void }
  // 运行时字段（bindSession / rebuildLedgerFromLog / rearmReactive / compactNow 读写）
  session: Session | null
  rebuiltCompactionIds: Set<string>
  frozenCatalog: string | null
  auditWarnings: string[]
  records: GraphPruneRecord[]
  prunedNodeIndex: Map<number, PrunedNodeInfo>
  reactivePending: WeakMap<Session, true>
  compactSourceCommandId: CommandId | undefined
  // 方法引用
  shadowedSeqsOf: (session: Session) => Set<number>
  rebuildLedgerFromLog: () => void
  restoreUsageAnchor: (session: Session) => void
  catalogText: (maxItems?: number, snippetChars?: number, tokenBudget?: number) => string
  bindSession: (session: Session) => void
}

/**
 * 构造期字段归一（纯字段赋值，无 ctx 副作用）：windowTokens/retainTokens 静态默认 + 顶层旋钮
 * 缺省 + 三级触发旋钮 + 推断边参数。原先分散在构造器两处（settings 注册块前后），现合并为单一
 * 纯函数；字段赋值与任何 ctx 副作用无交互（settings 回调不读本批字段），故整体置于
 * registerSettings 之前不改变可观测行为。tokenMeter 获取（acquireTokenMeter(ctx)）是唯一的
 * ctx 读取，保持在 settings 注册之前（与原 line 541 次序一致）。
 */
export function normalizeConfig(ctx: Context, host: LifecycleHost, config: ArgpGraphConfig): void {
  // 静态默认（兼容显式配置路径）：若 config 显式给 windowTokens/retainTokens 用之；
  // 否则运行时在 compactIfNeeded 按 contextWindow × ratio 解析（见 resolveScaledBudgets）。
  host.windowTokens = config.windowTokens ?? DEFAULT_WINDOW_TOKENS
  host.retainTokens = config.retainTokens ?? DEFAULT_RETAIN_TOKENS
  host.explicitWindowTokens = config.windowTokens !== undefined
  host.explicitRetainTokens = config.retainTokens !== undefined
  // 顶层旋钮（windowRatio/retainRatio/recencyGuard/turnGuard/minSpanChars/charsPerToken/
  // maxPasses/enableSummarize/sortMode）改由 ctx.inject(['settings']) 经 settings 源 thunk 驱动
  // （见下方 settings 注册块），此处不再逐字段赋值；getter 读取 this.argpSettings。
  host.reserveTokens = config.reserveTokens ?? 0
  host.telemetryCap = config.telemetryCap ?? DEFAULT_TELEMETRY_CAP
  host.tokenMeterFn = config.measureTokens
  // tokenMeter 不作为 required inject（避免测试/最小化组合缺少该服务时构造失败），
  // 运行时尝试从 ctx 获取；真会话中 dsh-token-meter 已挂载即可使用。
  // P5 Wave 3 第 4 步：获取逻辑迁 budget.acquireTokenMeter（纯函数，逻辑逐字保留）。
  host.tokenMeter = acquireTokenMeter(ctx)
  host.degradationStrategy = config.degradationStrategy ?? 'lifecycle'
  // 2026-08-23 拍板：默认 density（spike 18 离线 + spike 19 真实验证：同达成度下 recall 2→0、
  // 保留集单位信息量更高；eff 同档大 token 先剪 = 分数背包贪心）。需回退可显式传 sortMode:'legacy'。
  host.turnBasis = config.turnBasis ?? 'semantic'
  host.maxOverflowRetries = config.maxOverflowRetries ?? 1
  // 三级触发（1.5.0）：① 轮初主动 ② 轮中压力剪（step>1，放宽 turnGuard）③ 截断后剪+续写。
  // 轮中剪默认**开**：超额的来源是上一批 tool result（轮中），只在轮初判定的 L1 看不见它；
  // 而轮中剪落在那个 pre-step 里，剪完同一步的请求即已瘦身 ⇒ 天然自动继续。
  // 兼容 1.4.0 的 `midTurnActive`：true = 开+默认守卫（1.3.x 对照），false = 关。
  host.midTurnPruneEnabled = config.midTurnPrune ?? config.midTurnActive ?? true
  host.midTurnLegacyGuard = config.midTurnActive === true
  host.midTurnTurnGuard = Math.max(0, config.midTurnTurnGuard ?? 0)
  host.reactiveRetries = Math.max(0, config.reactiveRetries ?? 2)
  host.continuationNotice = config.continuationNotice
    ?? '[argp] 你上一条输出被宿主的输出预算截断了（不是你的错误）。上下文已压缩，请从截断处接着完成当前任务，不要重述已写内容。'
  host.onOverflowCompress = config.onOverflowCompress
  host.onPrePressureCompress = config.onPrePressureCompress
  host.closureWindowK = config.closureWindowK ?? 2
  // 默认 4：ASCII 词（如 "the"=3）被拒；CJK 双字（"读书"=2×2=4）放行（问题 5 修订）
  host.citeMinPrefixLen = config.citeMinPrefixLen ?? 4
  host.overlapTheta = config.overlapTheta ?? 0.8
  host.enableOverlapChain = config.enableOverlapChain ?? false
  host.injectEdges = config.injectEdges
  host.disableCiteEdges = config.disableCiteEdges ?? false
  // v1.2.0 组件 A（PROPOSAL-token-ontology）：推断边参数（默认启用，可单独关停）。
  host.disableInferredEdges = config.disableInferredEdges ?? false
  // v1.2.x §11.8①：tombstone 归并阈值（默认 8；显式 0 = 关闭，对照组实验用）。
  if (config.tombstoneMergeMinRun !== undefined) host.tombstoneMergeMinRun = config.tombstoneMergeMinRun
  if (config.inferredMinTokenLen !== undefined) host.inferredOpts.minTokenLen = config.inferredMinTokenLen
  if (config.inferredStopwordRatio !== undefined) host.inferredOpts.stopwordRatio = config.inferredStopwordRatio
  if (config.inferredMaxEdgesPerAtom !== undefined) host.inferredOpts.maxEdgesPerAtom = config.inferredMaxEdgesPerAtom
  if (config.inferredWindowTurns !== undefined) host.inferredOpts.windowTurns = config.inferredWindowTurns
}

/**
 * 设置页可见性声明（dsh 0.1.7+）。
 *
 * 宿主 0.1.7（#4587，`profile-owned-live-configuration`）移除了
 * `settings.register(ns, schema, { base })`：Settings 改为扫描插件的 `static Config`
 * 生成表单，表单值写回 profile 的 `cordis.patch.yml`。因此本函数不再注册任何东西，
 * 只做一件事——声明本插件实例允许设置页自动生成表单（auto: true，因为没有自定义
 * settings 页面）。引擎的旋钮值由 `ArgpGraphEngine.Config` 的 volatile 引用提供。
 *
 * ⚠️ 旧实现的构造期快照（`host.argpSettings` / `host.settingsSource`）已删除：
 * 那套"注册后把基线与 scope.get() 二选一"的回退逻辑是为被移除的 register API 服务的。
 */
export function registerSettings(ctx: Context, _host: LifecycleHost, _config: ArgpGraphConfig): void {
  ctx.inject(['settings'], (scopedCtx: Context) => {
    // 宿主 0.1.7 的 settings 服务没有 `register`，只有 `configure`（页面展示策略）。
    // dsh-settings 不是本包依赖（缺 Named export 会让整个 entry 加载失败，见文件头 NOTE），
    // 故本地声明只触达 `configure` 的窄接口——这与 settings 服务缺失时的降级边界一致。
    const scoped = scopedCtx as unknown as Context & {
      settings: { configure: (presentation: { auto?: boolean }, owner?: unknown) => () => void }
    }
    // auto: true —— 本插件无自定义 settings 页面，交由设置页按 schema 生成。
    scopedCtx.effect(() => scoped.settings.configure({ auto: true }, ctx.fiber))
  })
}

/**
 * P0 双引擎自挂载：peratom 配置块存在时，Stage-1 三管线在构造期挂载并接线
 * （与 mountPeratomStack 同拓扑：三管线 hook 注册进 ctx 事件总线，本引擎作为
 * ctx.compaction 接收 injectEdges / onOverflowCompress）。
 * ⚠️ 显式判 object（而非只判 `!== undefined`）：YAML 里"关掉 Stage-1"最自然的写法是
 * `peratom: false`，而布尔装箱后 `.compressor` 取到 undefined → `?? {}` → 三管线全挂，
 * 与写配置的人意图**完全相反**。false / null 一律按"不挂"处理（与缺省同语义）。
 *
 * 含两个构造期派生赋值：maxOverflowRetries 缺省提升（挂 compressor 时 1→3）与
 * citesObligation auto 解析（declarer 已武装即关）——两者都依赖本函数先完成 peratomStack
 * 挂载，故一并收在本函数内（保持原构造器 line 617-662 的相对次序）。
 */
export function mountPeratomStack(ctx: Context, host: LifecycleHost, config: ArgpGraphConfig): void {
  if (config.peratom !== undefined && typeof config.peratom === 'object' && config.peratom !== null) {
    if (config.onOverflowCompress !== undefined || config.injectEdges !== undefined) {
      host.log.warn('[argp-graph] peratom block set; explicit injectEdges/onOverflowCompress ignored (wired internally)')
    }
    const compressor = config.peratom.compressor === false ? null : new PeratomCompressor(ctx, config.peratom.compressor ?? {})
    const declarer = config.peratom.declarer === false ? null : new CiteDeclarer(ctx, config.peratom.declarer ?? {})
    const zoom = config.peratom.zoom === false ? null : new RecallZoom(ctx, config.peratom.zoom ?? {})
    if (declarer !== null) {
      // F3（1.7.1）：端点 seq → 当前替身（墓碑）seq 的重定向表，喂给 buildInjectEdges。
      // 失效戳取 records **尾条**的 compactionId（records 是 FIFO 有界队列，
      // 达到 telemetryCap 后 length 恒定 ⇒ 不能用 length 当戳）。
      let redirectTable: Map<number, number> | null = null
      let redirectStamp = ''
      const redirect = (seq: number): number | undefined => {
        const tail = host.records[host.records.length - 1]
        const stamp = tail === undefined ? '' : tail.compactionId
        if (redirectTable === null || redirectStamp !== stamp) {
          redirectTable = buildTombstoneRedirect(host.records)
          redirectStamp = stamp
        }
        return redirectTable.get(seq)
      }
      host.injectEdges = (atoms) => declarer.buildInjectEdges(atoms, redirect)
    }
    if (compressor !== null) {
      host.onOverflowCompress = async (session: Session): Promise<void> => {
        // 溢出发生在当前 open turn 的请求上——第②步要降熵的正是它。closed-turn
        // 口径会错压上一闭合轮（2026-08-29 review 中项），改用 open-turn 入口。
        await compressor.compressOpenTurn(session)
      }
      // P6：轮内压力达标时先压缩 open turn 原子再图剪（与 onOverflowCompress 同入口，
      // 区别只在触发条件：压力 vs 溢出错误）。
      host.onPrePressureCompress = async (session: Session): Promise<void> => {
        await compressor.compressOpenTurn(session)
      }
    }
    host.peratomStack = { compressor, declarer, zoom }
  }

  // P4 修复（2026-08-29 review，严重项）：peratom 第②步（onOverflowCompress）挂载时，
  // 重试上限缺省从 1 提到 3——否则事件#2（retries=1）在重试上限守卫处直接保留原错误，
  // 三步序列的第②步在默认配置下永不触发（测试显式传 3/5 掩盖了缺口，生产挂载路径
  // 无人设值）。显式配置始终优先；耗尽判定（retries≥2，见 request-error 钩子）独立于
  // 本上限，第③步后照旧收束，不会多空转。未挂 compressor（第②步不存在）时维持 1。
  if (config.maxOverflowRetries === undefined && host.onOverflowCompress !== undefined) {
    host.maxOverflowRetries = 3
  }

  // 回复级 cites 义务 auto 口径：declarer 已武装（有 LLM 后端）→ 结构化旁路建边
  // 接管，回复协议关闭；显式 true/false 覆盖。declarer 挂载但未武装时保持开启，
  // 避免"两种边来源同时归零"（见 citesObligation 配置注释）。
  // 2026-09-21 时序修复：autoLlm 兜底的 declarer 构造期未武装（路由要等真会话的
  // agent/status 钩子才解析），构造期布尔无法覆盖它——auto 口径下 section 恒注册，
  // 由 text 回调在 armed 翻转后动态返回 ''（见注册处）；显式覆盖保持静态语义。
  host.citesObligationAuto = config.citesObligation === undefined
  host.citesObligation = config.citesObligation ?? !(host.peratomStack?.declarer?.armed === true)
}

/**
 * A7（问题 3 修订）：session 绑定统一入口——setSession / agent/pre-step / compactIfNeeded 首次绑定
 * 都走这里。绑定后若 records 为空且日志含 compaction/start 事件（resume 场景：账目丢失仅日志在），
 * 懒触发 rebuildLedgerFromLog() 自动重建；幂等由 rebuiltCompactionIds 去重保证。
 */
export function bindSession(host: LifecycleHost, session: Session): void {
  if (host.session === session) return
  host.session = session
  host.rebuiltCompactionIds.clear() // 跨 session 重置告警/重建去重
  host.shadowedSeqsOf(session) // setSession 时初始化一次；后续仅扫描新追加事件
  try {
    host.rebuildLedgerFromLog() // 懒触发：仅当 records 空 + 日志含事务事件时真正重建
  } catch { /* 重建失败不阻断 turn */ }
  // 锚点回填（2026-09-21）：换 session 身份 = 进程重启后 resume / 新会话，
  // 此时内存锚点要么属于上一个 session（失效），要么为空 ⇒ 必须从日志恢复，
  // 否则压力检查静默退化为 chars 口径（详见 restoreUsageAnchor 注释）。
  host.restoreUsageAnchor(session)
  // 永久冻结 catalog：仅在首次绑定（frozenCatalog 仍为 null）时拍一次快照。
  // 后续任何重绑（agent/pre-step 每步传来的 session 对象可能换新身份，见 line 870）或落剪
  // 都不再改写 —— 这是 1.0.2 仍漏的 bug：session 对象换位时 bindSession 重跑会把
  // frozenCatalog 重算成当时 catalogText 值（有时返回 ''），导致 catalog 段在非剪枝步骤
  // 凭空消失/重现、打穿前缀缓存。现改为"只冻一次"，system 块全程逐字节恒定、KV 100% 命中。
  // 代价：catalog 文本停在首绑时刻（recall_pruned / list_pruned 仍扫原始日志，发现能力不丢）。
  if (host.frozenCatalog === null) host.frozenCatalog = host.catalogText(20, 70)
}

/**
 * A7 事务账目重建：resume 时从 append-only 日志扫描 compaction/start、compaction/prune、
 * compaction/end 事件重建 records/prunedNodeIndex/shadowedSeqsOf 状态；无 end 的 start 记 warn。
 * 不引入 WAL——日志本身即账目。幂等：已重建过的 compactionId 跳过（rebuiltCompactionIds 去重），
 * 使「setSession 自动重建」与「测试显式清空 records 后再重建」两种路径都安全。
 */
export function rebuildLedgerFromLog(host: LifecycleHost): void {
  if (host.session === null) return
  const events = sessionEvents(host.session)
  const starts: { seq: number; compactionId: string; lifecycle: Record<string, unknown> }[] = []
  const prunes: { seq: number; start: number; end: number; shadowedSeqs: number[]; shadowedTokenCount: number }[] = []
  const ends = new Set<number>()
  const endByStart = new Map<number, { endSeq: number; error?: string }>()
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i]
    if (event === undefined) continue
    if (event.type === 'compaction/start') {
      starts.push({ seq: i, compactionId: String((event.data as { compactionId?: unknown }).compactionId ?? ''), lifecycle: event.data as Record<string, unknown> })
    } else if (event.type === 'compaction/prune') {
      const d = event.data as { shadowedRange?: { start?: number; end?: number }; shadowedSeqs?: number[]; shadowedTokenCount?: number }
      prunes.push({ seq: i, start: d.shadowedRange?.start ?? 0, end: d.shadowedRange?.end ?? 0, shadowedSeqs: d.shadowedSeqs ?? [], shadowedTokenCount: d.shadowedTokenCount ?? 0 })
    } else if (event.type === 'compaction/end') {
      ends.add(i)
      const d = event.data as { compactionId?: unknown; error?: unknown }
      const s = starts.find(st => st.compactionId === d.compactionId)
      if (s !== undefined) endByStart.set(s.seq, { endSeq: i, error: typeof d.error === 'string' ? d.error : undefined })
    }
  }
  // 账目重建：shadowed 集合直接复用 shadowedSeqsOf 的增量游标（问题 8：删重复扫描循环，
  // shadowedSeqsOf 已从上次扫描处继续到 events.length，同一游标不冲突）
  host.shadowedSeqsOf(host.session)
  // 事件类型反查（问题 8）：从日志真实事件反推原子类型/轮次，不再一律占位 'A'/turn 0。
  // 分类口径与 atomize 一致：统一走 classifyUserMessage（先 data[argp].info → U，再 plugin 源 → X）。
  const typeOfSeq = (seq: number): AtomType => {
    const event = host.session === null ? undefined : sessionEvents(host.session)[seq]
    if (event === undefined) return 'X'
    if (event.type === 'user/message') return classifyUserMessage(event.data)
    if (event.type === 'assistant/message') return 'A'
    if (event.type === 'tool/result') return 'R'
    // developer/message（V4 保留类型）与 atomize 同档显式归 X（有意边界，非漏点）。
    if (event.type === 'developer/message') return 'X'
    return 'X'
  }
  const turnOfSeq = (seq: number): number => {
    const event = host.session === null ? undefined : sessionEvents(host.session)[seq]
    return event === undefined ? 0 : (turnOf(event) ?? 0)
  }
  // 逐 start 配对：收集该事务区间（start..end）内的**全部** compaction/prune 与 end。
  // 2026-09-01 修复：pruneIntervals 改为逐区间发 prune（每区间一个 shadow-price 事件，
  // 对齐宿主 foldSurfaceProjection 严格相等契约），一个事务含多个 prune；
  // 旧"start 后最近一个 prune"假设失效 → 改为收集事务内全部并合并（兼容旧单 prune 日志：
  // 此时区间内恰一个，合并结果等同旧行为）。
  for (const s of starts) {
    // 幂等守卫：已重建过则跳过（防止 setSession 自动重建后，测试显式 rebuildLedgerFromLog 再重建）
    if (host.rebuiltCompactionIds.has(s.compactionId)) continue
    const end = endByStart.get(s.seq)
    if (end === undefined) {
      // 未闭合 start：仅告警，不重建记录；标记已处理防止重复告警
      if (!host.rebuiltCompactionIds.has(s.compactionId)) {
        pushBounded(host.auditWarnings, 'unclosed compaction start at seq ' + s.seq + ' (compactionId=' + s.compactionId + '); transaction may have been interrupted', host.telemetryCap)
        host.rebuiltCompactionIds.add(s.compactionId)
      }
      continue
    }
    const txPrunes = prunes
      .filter(p => p.seq > s.seq && p.seq < end.endSeq)
      .sort((a, b) => a.seq - b.seq)
    if (txPrunes.length === 0) continue
    // 标记已重建（重建后不重复，防止再次 rebuildLedgerFromLog 时追加）
    host.rebuiltCompactionIds.add(s.compactionId)
    const txPrune = txPrunes[0]!
    const intervalSeqs = txPrunes.flatMap(p => p.shadowedSeqs)
    const charsBefore = 0 // 日志无快照，账目重建不伪造数值
    const charsAfter = 0
    const intervalRecords = intervalSeqs.length > 0
      ? [{ start: intervalSeqs[0] as number, end: intervalSeqs[intervalSeqs.length - 1] as number, tombstoneSeq: end.endSeq }]
      : []
    const prunedAtoms: { id: number; type: AtomType; seq: number }[] = intervalSeqs.map(seq => ({ id: seq, type: typeOfSeq(seq), seq }))
    pushBounded(host.records, {
      at: String((s.lifecycle as { at?: unknown }).at ?? ''),
      compactionId: s.compactionId,
      intervals: intervalRecords,
      startEventSeq: s.seq,
      summaryEventSeq: txPrune.seq,
      endEventSeq: end.endSeq,
      shadowedSeqs: intervalSeqs,
      prunedAtoms,
      semanticEdges: 0,
      candidates: 0,
      charsBefore,
      charsAfter,
      forced: false,
    }, host.telemetryCap)
    for (const seq of intervalSeqs) {
      if (!host.prunedNodeIndex.has(seq)) {
        host.prunedNodeIndex.set(seq, {
          seq,
          type: typeOfSeq(seq), // 问题 8：真实类型反查（R/U 不再一律 'A'）
          turn: turnOfSeq(seq),
          firstLine: '(rebuilt from log) seq=' + seq,
          citedBySeq: [],
          eff: 0,
        })
      }
    }
  }
}

/**
 * 反应式"零候选"重挂：把钳制信号留给下一次机会（下个 pre-step / 下一轮 turn-stopping），
 * 那时阶梯已 +1 ⇒ 守卫放宽，原本剪不动的局面（turnGuard 保护当前轮）才可能剪动。
 * 额度用尽则不再重挂（避免"每步白压"）。
 */
export function rearmReactive(host: LifecycleHost, session: Session, used: number): void {
  if (used < host.reactiveRetries) host.reactivePending.set(session, true)
}

/**
 * /compact 手动压缩入口（override CompactionEngine.compactNow）。
 * 统一绑定 + 账目懒重建后，选全部可剪极大段（selectManualRanges）合并为一笔事务剪除
 * （compactRegions）；runMaintenance 可用时经其执行（宿主维护窗口），否则直接跑。
 */
export async function compactNow(
  host: LifecycleHost,
  agent: ManualCompactAgentContext,
  signal: AbortSignal,
  sourceCommandId?: CommandId,
): Promise<CompactionResult | null> {
  host.bindSession(agent.session) // A7（问题 3）：统一绑定 + 账目懒重建
  signal.throwIfAborted()
  // /compact 链路（command-compact 调用方传入 commandId）：透传给事务事件做
  // presentation correlation（对齐 compaction-basic 的 sourceCommandId 语义）。
  host.compactSourceCommandId = sourceCommandId
  try {
    const run = async (agentSignal: AbortSignal): Promise<CompactionResult | null> => {
      const opSignal = AbortSignal.any([signal, agentSignal])
      opSignal.throwIfAborted()
      // 多段收集（2026-09-21 修复）：surface 被用户消息切成多段时，旧实现只剪最老一段。
      const ranges = selectManualRanges(host as unknown as PruneTxHost, agent.session)
      return compactRegions(host as unknown as PruneTxHost, ranges, agent, opSignal)
    }
    if (typeof agent.runMaintenance === 'function') {
      return agent.runMaintenance(run)
    }
    return run(signal)
  } finally {
    host.compactSourceCommandId = undefined
  }
}
