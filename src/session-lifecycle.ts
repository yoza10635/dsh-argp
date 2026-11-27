/**
 * 会话生命周期 + 构造期装配（2.0 factor-only）：
 *  - 构造期：normalizeConfig（字段归一并拒坏形状）/ registerSettings（声明设置页 auto 表单）。
 *  - 运行时：bindSession（统一绑定 + 账目懒重建）/ rebuildLedgerFromLog（A7 事务账目重建）。
 *
 * 函数经窄接口 LifecycleHost 触达引擎（`this as unknown as LifecycleHost`，编译期类型、
 * 运行时同一实例；方法引用经 host 派发回 class 薄编排方法，this 绑定语义不变）。
 * 构造期副作用顺序由 hub 构造器调用次序保证：normalizeConfig → registerSettings →
 * FactorEngine/ProseCondenser → registerRecallLabels → systemPrompt sections → ctx.on。
 *
 * 设置页常量（ARG_SETTINGS_KEY / ArgpUserSettingsSchema / NAMESPACE_PATTERN / ARG_SETTINGS_NS）
 * 在本模块：ArgpUserSettingsSchema 是运行时值（z.object 产物），若放在 hub 会迫使本模块
 * 运行时 import hub 形成环；hub 反向 import 本模块并 re-export，公共 API 不变
 * （index.ts 的 `export *` 透出）。
 *
 * ArgpConfig 经 type-only import 取用（编译期擦除，无运行时环）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import z from '@deepseek-ai/schemastery'
import type { ArgpUserSettings } from './argp-types.js'
import { notePrunedNode, type PrunedNodeInfo, type SessionRuntimeState } from './session-state.js'
import { inspectLogAccess, sessionEvents, turnOf } from './log-access.js'
import { classifyUserMessage } from './atomize.js'
import { pushBounded, DEFAULT_TELEMETRY_CAP } from './telemetry.js'
import { DEFAULT_RETAIN_TOKENS, DEFAULT_WINDOW_TOKENS } from './constants.js'
import { acquireTokenMeter, type TokenMeter } from './budget.js'
import type { GraphPruneRecord } from './prune-tx.js'
import type { ArgpConfig } from './argp-engine.js' // type-only：编译期擦除，无运行时环

// ── 设置页常量（ARG_SETTINGS_KEY / ArgpUserSettingsSchema 经 hub re-export 维持公共 API）──
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
// `settings.configure` through `ctx.inject` — the graceful-degradation boundary —
// and validate the namespace locally.

/** 设置页 namespace key（同时是 Host 服务端与客户端卡片的 key，须一致才进渲染交集）。 */
export const ARG_SETTINGS_KEY = 'dsh-argp'

/**
 * 引擎设置 schema（schemastery）：**2.0.0 起零旋钮**——原六枚设置项
 * （windowRatio/retainRatio/charsPerToken + focalTurns/vocabTopN/recallLimit）
 * 全部退役，缺省值固化在 constants.ts；2.0.1 起名册唯一活键 = `compactionThreshold`
 * （压缩阈值：出口闸触发线 = 声明窗 × 比例；0=关闭，撞墙 400 兜底）。
 *
 * 真实校验面是 `ArgpEngine.Config`（宿主 0.1.7+ 扫描 static Config 生成
 * volatile form；settings.register 已随 #4587 移除，本 schema 经 hub re-export
 * 维持公共 API 与文档口径）。两面键集必须一致。
 *
 * 1.x graph 臂旋钮与 2.0 五枚退役旋钮在 cordis 非 strict 解析下一律宽容透传
 * （宿主实测未声明键原样透传）；normalizeConfig 对非缺省旧值告警忽略。
 */
export const ArgpUserSettingsSchema = z.object({
  compactionThreshold: z.number().min(0).max(1).default(0),
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
 * 方法引用（shadowedSeqsOf/rebuildLedgerFromLog/restoreUsageAnchor/bindSession）
 * 经 host 派发到 class 上的薄编排方法，运行时 this 仍是引擎实例。
 */
export interface LifecycleHost {
  // 构造期字段（normalizeConfig 写入）
  windowTokens: number
  retainTokens: number
  explicitWindowTokens: boolean
  explicitRetainTokens: boolean
  reserveTokens: number
  telemetryCap: number
  tokenMeterFn?: (session: Session) => { contextTokens: number; surfaceTokens: number }
  tokenMeter: TokenMeter | undefined
  maxOverflowRetries: number
  log: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void }
  // 运行时字段（bindSession / rebuildLedgerFromLog 读写）
  session: Session | null
  stateOf: (session: Session) => SessionRuntimeState
  rebuiltCompactionIds: Set<string>
  auditWarnings: string[]
  records: GraphPruneRecord[]
  prunedNodeIndex: Map<number, PrunedNodeInfo>
  // 方法引用
  bindRuntimeState: (session: Session) => void
  shadowedSeqsOf: (session: Session) => Set<number>
  rebuildLedgerFromLog: () => void
  restoreUsageAnchor: (session: Session) => void
  bindSession: (session: Session) => void
}

/** 1.x graph 臂旋钮（2.0 退位）：出现即告警忽略——老 profile 不炸但不静默。 */
const RETIRED_GRAPH_KEYS: readonly string[] = [
  'maxPasses', 'recencyGuard', 'turnGuard', 'minSpanChars', 'sortMode',
  'midTurnPrune', 'midTurnActive', 'midTurnTurnGuard', 'continuationNotice', 'reactiveRetries',
  'degradationStrategy', 'turnBasis', 'closureWindowK', 'citeMinPrefixLen', 'overlapTheta',
  'enableOverlapChain', 'injectEdges', 'disableCiteEdges', 'disableInferredEdges',
  'inferredMinTokenLen', 'inferredStopwordRatio', 'inferredMaxEdgesPerAtom', 'inferredWindowTurns',
  'tombstoneMergeMinRun', 'citesObligation', 'peratom', 'onOverflowCompress', 'onPrePressureCompress',
]

/**
 * 2.0.0 起退役的六枚设置旋钮（零旋钮形态）：出现即告警忽略——缺省值固化在
 * constants.ts（0.8 / 0.2 / 3.5 / 1 / 10 / 5）。老 profile 带这些键不炸，
 * 但行为按固化缺省运行，不静默沿用旧值。
 */
const RETIRED_KNOB_KEYS: readonly string[] = [
  'windowRatio', 'retainRatio', 'charsPerToken', 'focalTurns', 'vocabTopN', 'recallLimit',
]

/**
 * 构造期字段归一（纯字段赋值，无 ctx 副作用）：windowTokens/retainTokens 静态默认 +
 * 顶层旋钮缺省。字段赋值与任何 ctx 副作用无交互（settings 回调不读本批字段），故整体
 * 置于 registerSettings 之前。tokenMeter 获取（acquireTokenMeter(ctx)）是唯一的 ctx 读取，
 * 保持在 settings 注册之前。
 */
export function normalizeConfig(ctx: Context, host: LifecycleHost, config: ArgpConfig): void {
  // 构造期配置形状校验——收集全部违例**一次性**抛出。此前错误形状静默通过：
  // skipPresets 非数组被 spread 成字符数组 = 永不匹配（preset 快照静默失效）、
  // NaN/Infinity 数值让预算与守卫静默偏移。cordis 对插件 config 不做 schema 校验
  // （YAML 手写层尤甚），形状责任在本插件。
  // ⚠️ 只校验**构造期按裸值消费**的字段；2.0.0 起六枚设置旋钮已退役
  // （static Config 为空对象），老 profile 的同名键由下面的宽容读告警处理。
  const violations: string[] = []
  const checkNum = (v: unknown, name: string, opts: { min?: number; max?: number } = {}): void => {
    if (v === undefined) return
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      violations.push(name + ': expected finite number, got ' + JSON.stringify(v))
      return
    }
    if (opts.min !== undefined && v < opts.min) violations.push(name + ': expected >= ' + opts.min + ', got ' + v)
    if (opts.max !== undefined && v > opts.max) violations.push(name + ': expected <= ' + opts.max + ', got ' + v)
  }
  checkNum(config.windowTokens, 'windowTokens', { min: 1 })
  checkNum(config.retainTokens, 'retainTokens', { min: 1 })
  checkNum(config.reserveTokens, 'reserveTokens', { min: 0 })
  checkNum(config.telemetryCap, 'telemetryCap', { min: 1 })
  checkNum(config.maxOverflowRetries, 'maxOverflowRetries', { min: 0 })
  if (config.engine !== undefined && config.engine !== 'factor') {
    ctx.logger.warn('[argp-factor] engine=' + JSON.stringify(config.engine)
      + ' 已退役（2.0 = factor-only）：按 factor 引擎运行；老方案锁定在 npm latest 1.11.2')
  }
  if (config.skipPresets !== undefined
    && (!Array.isArray(config.skipPresets) || config.skipPresets.some(p => typeof p !== 'string'))) {
    violations.push('skipPresets: expected string[], got ' + JSON.stringify(config.skipPresets))
  }
  if (violations.length > 0) {
    throw new Error('[argp-engine] invalid config (plugin will not activate): ' + violations.join('; '))
  }
  // 旧 graph 键宽容读 + 告警：cordis 非 strict 合并（宿主实测未声明键透传）⇒ 老 profile
  // 不炸 = 宽容读；2.0 起这些键**全部**不再被消费（图臂退役），出现即告警，不让沉默
  // 改变用户预期。volatile 包装经 get() 拆封。
  const touched: string[] = []
  for (const key of RETIRED_GRAPH_KEYS) {
    const raw = (config as unknown as Record<string, unknown>)[key]
    if (raw === undefined) continue
    const value = raw !== null && typeof raw === 'object' && 'get' in (raw as object)
      ? (raw as { get(): unknown }).get() : raw
    if (value === undefined) continue
    touched.push(key + '=' + String(Array.isArray(value) ? '[array]' : value))
  }
  if (touched.length > 0) {
    ctx.logger.warn('[argp-factor] 旧 graph 臂旋钮（' + touched.join(', ')
      + '）已随 1.x 图臂退役：宽容读、已忽略；焦点保护位由固化缺省接管')
  }
  // 2.0.0 六枚设置旋钮退役：老 profile 里出现即告警忽略（缺省固化，不静默沿用旧值）。
  const retiredKnobs: string[] = []
  for (const key of RETIRED_KNOB_KEYS) {
    const raw = (config as unknown as Record<string, unknown>)[key]
    if (raw === undefined) continue
    const value = raw !== null && typeof raw === 'object' && 'get' in (raw as object)
      ? (raw as { get(): unknown }).get() : raw
    if (value === undefined) continue
    retiredKnobs.push(key + '=' + String(Array.isArray(value) ? '[array]' : value))
  }
  if (retiredKnobs.length > 0) {
    ctx.logger.warn('[argp-factor] 设置旋钮（' + retiredKnobs.join(', ')
      + '）已随 2.0.0 零旋钮形态退役：宽容读、已忽略；缺省固化 '
      + 'windowRatio=0.8 / retainRatio=0.2 / charsPerToken=3.5 / focalTurns=1 / vocabTopN=10 / recallLimit=5')
  }
  // 压缩阈值（2.0.1 唯一活键）的 YAML 手写层形状告警：settings 源驱动的 volatile
  // 值有 schema 校验；YAML 直写的裸值没有——出界形状静默降级（字符串→0=关、
  // >1→闸几乎不触发），这里显式告警不静默（审查 P2-7）。
  const rawThreshold = (config as unknown as Record<string, unknown>)['compactionThreshold']
  const thresholdValue = rawThreshold !== null && typeof rawThreshold === 'object' && 'get' in (rawThreshold as object)
    ? (rawThreshold as { get(): unknown }).get() : rawThreshold
  if (thresholdValue !== undefined && thresholdValue !== null
    && (typeof thresholdValue !== 'number' || !Number.isFinite(thresholdValue)
      || thresholdValue < 0 || thresholdValue > 1)) {
    ctx.logger.warn('[argp-factor] 压缩阈值 compactionThreshold=' + String(Array.isArray(thresholdValue) ? '[array]' : thresholdValue)
      + ' 不是 0–1 之间的数字：按 0（关闭，撞墙 400 兜底）处理')
  }
  // 静态默认（兼容显式配置路径）：若 config 显式给 windowTokens/retainTokens 用之；
  // 否则运行时在 compactIfNeeded 按 contextWindow × ratio 解析（见 resolveScaledBudgets）。
  host.windowTokens = config.windowTokens ?? DEFAULT_WINDOW_TOKENS
  host.retainTokens = config.retainTokens ?? DEFAULT_RETAIN_TOKENS
  host.explicitWindowTokens = config.windowTokens !== undefined
  host.explicitRetainTokens = config.retainTokens !== undefined
  host.reserveTokens = config.reserveTokens ?? 0
  host.telemetryCap = config.telemetryCap ?? DEFAULT_TELEMETRY_CAP
  host.tokenMeterFn = config.measureTokens
  // tokenMeter 不作为 required inject（避免测试/最小化组合缺少该服务时构造失败），
  // 运行时尝试从 ctx 获取；真会话中 dsh-token-meter 已挂载即可使用。
  host.tokenMeter = acquireTokenMeter(ctx)
  host.maxOverflowRetries = config.maxOverflowRetries ?? 1
}

/**
 * 设置页可见性声明（dsh 0.1.7+）。
 *
 * 宿主 0.1.7（#4587，`profile-owned-live-configuration`）移除了
 * `settings.register(ns, schema, { base })`：Settings 改为扫描插件的 `static Config`
 * 生成表单，表单值写回 profile 的 `cordis.patch.yml`。因此本函数不再注册任何东西，
 * 只做一件事——声明本插件实例允许设置页自动生成表单（auto: true，因为没有自定义
 * settings 页面）。引擎的旋钮值由 `ArgpEngine.Config` 的 volatile 引用提供。
 *
 * ⚠️ 旧实现的构造期快照（`host.argpSettings` / `host.settingsSource`）已删除：
 * 那套"注册后把基线与 scope.get() 二选一"的回退逻辑是为被移除的 register API 服务的。
 */
export function registerSettings(ctx: Context, _host: LifecycleHost, _config: ArgpConfig): void {
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
 * A7（问题 3 修订）：session 绑定统一入口——setSession / agent/pre-step / compactIfNeeded
 * 首次绑定都走这里。绑定后若 records 为空且日志含 compaction/start 事件（resume 场景：
 * 账目丢失仅日志在），懒触发 rebuildLedgerFromLog() 自动重建；幂等由 rebuiltCompactionIds
 * 去重保证。
 */
/** A1 探针只报一次：同一进程内会话切换不重复刷屏；宿主升级后重启进程会重新报。 */
let logAccessReported = false

export function bindSession(host: LifecycleHost, session: Session): void {
  if (host.session === session) return
  host.session = session
  if (!logAccessReported) {
    // A1：同步读后端是宿主 @deprecated 面上的单点依赖——首次绑定就把「实际走哪条」
    // 写进日志，宿主升级移除同步读时这里先给出可行动的结论（而不是深层 undefined 级联）。
    logAccessReported = true
    try {
      const cap = inspectLogAccess(session)
      host.log.info('[argp] log-access backend=' + cap.backend + ' length=' + cap.length
        + '（宿主同步读 API 标 @deprecated，ARGP 读取面收口于 log-access；升级宿主后先跑 scripts/doctor.mjs）')
    } catch (error) {
      host.log.error('[argp] log-access unavailable: ' + (error instanceof Error ? error.message : String(error)))
    }
  }
  host.bindRuntimeState(session) // 1-1：焦点桶换装为该会话的 SessionRuntimeState（台账/预算/锚点全部随桶切换）
  // 不 clear rebuiltCompactionIds：桶本身按会话隔离（1-1），切回同一会话时
  // 去重集必须保留——clear 会触发整段日志重放，records 每次焦点切回都追加一遍。
  host.shadowedSeqsOf(session) // setSession 时初始化一次；后续仅扫描新追加事件
  try {
    host.rebuildLedgerFromLog() // 懒触发：仅当 records 空 + 日志含事务事件时真正重建
  } catch { /* 重建失败不阻断 turn */ }
  // 锚点回填（2026-09-21）：换 session 身份 = 进程重启后 resume / 新会话，
  // 此时内存锚点要么属于上一个 session（失效），要么为空 ⇒ 必须从日志恢复，
  // 否则压力检查静默退化为 chars 口径（详见 restoreUsageAnchor 注释）。
  host.restoreUsageAnchor(session)
}

/**
 * A7 事务账目重建：resume 时从 append-only 日志扫描 compaction/start、compaction/prune、
 * compaction/end 事件重建 records/prunedNodeIndex/shadowedSeqsOf 状态；无 end 的 start 记 warn。
 * 不引入 WAL——日志本身即账目。幂等：已重建过的 compactionId 跳过（rebuiltCompactionIds 去重），
 * 使「setSession 自动重建」与「测试显式清空 records 后再重建」两种路径都安全。
 * §8-11 后活体事务已由 prune-tx 成功收尾入账 prunedNodeIndex；同进程重放撞进的 seq 由
 * notePrunedNode 的 seq 幂等吞掉，不双计。
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
  const typeOfSeq = (seq: number): 'U' | 'A' | 'R' | 'X' => {
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
    let intervalSeqs = txPrunes.flatMap(p => p.shadowedSeqs)
    // error-end = partial 事务。已落地的 replace 子集真实有效，但：
    //  ① prunedNodeIndex 只收**确实离场**的 seq（prune claim 可能先于 replace 抛错——
    //     被 claim 却仍在 surface 的 seq 不入剪索引，按实际 replace 恢复提交子集）；
    //  ② 不产 intervalRecords——tombstoneSeq=end.endSeq 对 error 事务是双重新话
    //     （end 是 off-surface 事件，且该事务没有成功墓碑），喂给 buildTombstoneRedirect
    //     会造出指向 error end 的假重定向；
    //  ③ 记录带 error 字段，与成功事务显式区分（此前 partial 被重建得与成功逐字同形）。
    const isErrorEnd = end.error !== undefined
    if (isErrorEnd && host.session !== null) {
      const live = new Set<number>(host.session.surface.nodes as unknown as number[])
      intervalSeqs = intervalSeqs.filter(seq => !live.has(seq))
    }
    const charsBefore = 0 // 日志无快照，账目重建不伪造数值
    const charsAfter = 0
    const intervalRecords = !isErrorEnd && intervalSeqs.length > 0
      ? [{ start: intervalSeqs[0] as number, end: intervalSeqs[intervalSeqs.length - 1] as number, tombstoneSeq: end.endSeq }]
      : []
    const prunedAtoms: { id: number; type: 'U' | 'A' | 'R' | 'X'; seq: number }[] = intervalSeqs.map(seq => ({ id: seq, type: typeOfSeq(seq), seq }))
    pushBounded(host.records, {
      at: String((s.lifecycle as { at?: unknown }).at ?? ''),
      compactionId: s.compactionId,
      intervals: intervalRecords,
      startEventSeq: s.seq,
      summaryEventSeq: txPrune.seq,
      endEventSeq: end.endSeq,
      shadowedSeqs: intervalSeqs,
      prunedAtoms,
        candidates: 0,
      charsBefore,
      charsAfter,
      forced: false,
      ...(isErrorEnd ? { error: end.error } : {}),
    }, host.telemetryCap)
    const sessionState = host.session === null ? null : host.stateOf(host.session)
    if (sessionState !== null) {
      for (const seq of intervalSeqs) {
        notePrunedNode(sessionState, seq, {
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
  void ends
}
