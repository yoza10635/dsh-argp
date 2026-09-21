/**
 * PeratomCompressor 两段式发射模块（P5 结构重构 Wave 3 第 5 步，C 报告 §4 B 表）。
 *
 * 从 1,520 行 `compressor.ts`（God Class）拆出的**LLM 调用 + 事务发射**侧：
 *  - A 形态前缀快照（buildContextPrefix，纯函数）+ 方案 B ctk（resolveEffectiveCtk）
 *    + 前缀预算门控（prefixWithinBudget）；
 *  - LLM 调用与暂存（callAndStash：dsh-llm / fetch 双后端 + 降级 + 观测记录）；
 *  - 两段式：idle 准备（prepareCurrentTurn）→ pre-step 发射（flushStashed / flushEntry）；
 *  - 公开入口（compressCurrentTurn / compressOpenTurn / compressCollect 共享压缩尾部）；
 *  - 在飞 pass 有界等待（awaitInFlightPass）+ agent 路由记忆（rememberRoute）。
 *
 * 循环 import 规避（C 报告关键设计决策 1）：本模块**不** import compressor 运行时，
 * 仅 type-only import（编译期擦除，无运行时环）。需要实例状态的方法经窄接口
 * {@link FlushHost} 访问；纯函数（buildContextPrefix）与同模块函数（callAndStash /
 * flushEntry / compressCollect 等）直接互调，跨模块纯函数（buildPrompt / postChat /
 * normalizeDecision / extractJson / planReplacements）直接 import。
 * 依赖方向：compressor-types（叶）← decision/prompt ← flush ← compressor（组合根）。
 *
 * 行为逐字节不变：函数体逻辑逐字保留（this.x → host.x / this.method → 模块函数），
 * 仅 `this` 换 `host`。
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { compactCheckpointSource, CompactionId } from '@deepseek-ai/dsh-compaction'
import type { Message, ToolSchema } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { asSeq, asSeqs, detectOpenTurn, mainChainReasoningEffort, sessionEvents } from '../log-access.js'
import { autoDshLlmSpec, completeViaDshLlm, serializeWireMessages, serializeWireTools } from './llm-adapter.js'
import type { AgentRouteHint, DshLlmSpec } from './llm-adapter.js'
import { buildVersionChainIndex, turnCompressible } from './gate.js'
import type { GateOptions } from './gate.js'
import { pushBounded } from '../telemetry.js'
import type { CompressDecision, CompressRecord, CurrentTurnCollect } from './compressor-types.js'
import { extractJson, normalizeDecision, planReplacements } from './decision.js'
import { buildPrompt, postChat, type LlmBackend } from './prompt.js'

/**
 * 发射侧窄宿主接口（C 报告关键设计决策 1）：只含本模块所需成员。
 *  - 字段：records / telemetryCap（观测台账）、_calls（调用计数）、ctx（宿主日志）、
 *    fetchImpl / timeoutMs / maxCompletionTokens（fetch 后端）、pending（暂存事务）、
 *    hlsMode / hlsRoiThreshold（HLS 修复档）、inFlightPass / flushWaitMs（在飞 pass 屏障）、
 *    llmAutoEligible / autoLlm（自动兜底）、chatTemplateKwargs / prefixBudgetTokens（ctk / 预算）；
 *  - 方法：backend（→ prompt 模块）、gateOptions（类方法）、collectCurrentTurn /
 *    collectOpenTurn / advanceWaterMark（→ collect 模块）。
 */
export interface FlushHost {
  records: CompressRecord[]
  telemetryCap: number
  _calls: number
  ctx: Context
  fetchImpl: typeof fetch
  timeoutMs: number
  maxCompletionTokens: number
  pending: PendingEntry[]
  hlsMode: 'trailer' | 'off'
  hlsRoiThreshold: number
  inFlightPass: WeakMap<Session, Promise<unknown>>
  flushWaitMs: number
  llmAutoEligible: boolean
  autoLlm: DshLlmSpec | null
  chatTemplateKwargs: Record<string, unknown> | undefined
  prefixBudgetTokens: number
  backend: () => LlmBackend
  gateOptions: () => GateOptions
  collectCurrentTurn: (session: Session, afterSeq?: number) => CurrentTurnCollect | null
  collectOpenTurn: (session: Session, afterSeq?: number) => CurrentTurnCollect | null
  advanceWaterMark: (session: Session, turn: number, endSeq: number) => void
}

export interface PendingEntry {
  session: Session
  collect: CurrentTurnCollect
  decision: CompressDecision
  /** callAndStash 创建的观测记录；簿记直接写回此引用，不依赖 records 数组反查。 */
  record: CompressRecord
}

// -- LLM 调用与暂存 ------------------------------------------------------

/**
 * A 形态前缀快照（设计文档 §4 tail-only 语义的落地）：agent 当前
 * `deriveMessages()` + `requestHeader().tools` + 主链 ctk。
 *
 * 时序依据（2026-09-18/19 record 实测）：
 * - 轮边界触发（idle）：derive = 刚结束轮的全量，复用对象 = P_last / 下一轮第一发；
 * - 轮内触发（pre-step，P6）：derive = 进行到一半的 turn N，复用对象 = 紧随其后的
 *   step k+1 请求。两条路径共用本快照函数，前缀 = 触发时刻的 deriveMessages()。
 * 无 header 事件（会话首请求前）时 tools 缺省，消息前缀仍可用。
 */
export function buildContextPrefix(session: Session): { messages: Message[]; tools?: ToolSchema[] } {
  const messages = session.deriveMessages()
  const header = session.requestHeader()
  return { messages, ...(header?.tools !== undefined ? { tools: header.tools } : {}) }
}

/**
 * 方案 B ctk（2026-09-19 定案，替代旧的"强制 pt:true"）：
 *   { enable_thinking:false, preserve_thinking:false, reasoning_effort:<主链同值?>, ...config 基础层 }
 * 三字段各自的理由：
 *  - `preserve_thinking:false`（方案 B 核心）：压缩请求末尾必是 user 指令 ⇒ 模板把
 *    last_query_index 推到末尾 ⇒ 历史轮内 reasoning 被剥 = **剥离态**。这恰好与
 *    "下一轮第一发 agent 请求"（末尾也是 user，同为剥离态）**同态** ⇒ 前缀逐 token
 *    一致（plan B 实测 LCP 99.4%）。强制 pt:true 反而把跨轮 reasoning 渲染回来，
 *    与参照不同态（LCP 12.7% < pt:false 30.3%）。
 *  - `enable_thinking:false`：压缩响应是 JSON plan，不烧 thinking（spike 33）。
 *  - `reasoning_effort`：与主链对齐（若声明了）——匹配主链的渲染 token 序列，
 *    跨模型可移植（不依赖 Qwen3 专属 pt 语义）。
 * 主链 reasoningEffort 取自最近 `request/header` 事件的 config（LlmCallConfig 无
 * chat_template_kwargs 字段，只有 reasoningEffort——故从它重建，非读现成 ctk）。
 */
export function resolveEffectiveCtk(host: FlushHost, session: Session): Record<string, unknown> {
  // 2026-09-21（P5 Wave 3 第 3 步）：主链 reasoningEffort 抽取收敛到 log-access 共享访问器。
  const mainChainEffort = mainChainReasoningEffort(session)
  const ctk: Record<string, unknown> = { ...(host.chatTemplateKwargs ?? {}) }
  ctk['enable_thinking'] = false
  ctk['preserve_thinking'] = false
  if (mainChainEffort !== undefined) ctk['reasoning_effort'] = mainChainEffort
  return ctk
}

/**
 * 前缀预算门控（防爆上限核心防线）：估算 A 形态请求的 prompt_tokens
 * = 最近一次真实 agent 请求的 billed input + 指令字符估算（/4，chars/4 对
 * 指令这种短文本偏安全）。usage 挂 assistant/message 事件的 data **顶层**
 * （agent-loop 落账实证 `{turn, step, message, usage, stream}`，读
 * `data.message.usage` 恒 undefined ⇒ A 形态会被静默全量降级 C）；billed
 * 口径 = inputTokens（未命中）+ cacheReadTokens + cacheWriteTokens，与引擎
 * 真实锚点同式——只算未命中会在高缓存命中率时大幅低估、漏放行超预算请求。
 * 超预算 ⇒ 返回 false，调用方**该次降级 C 形态**（丢前缀只发指令）——
 * "全前缀或无前缀"二元门控：截断前缀要么砍最近历史（质量最伤）要么 0 命中
 * 还比 C 贵（被支配）。无 usage 可参照（会话头）⇒ 保守返回 false（降级 C）。
 */
export function prefixWithinBudget(host: FlushHost, session: Session, promptChars: number): boolean {
  const events = sessionEvents(session)
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event?.type !== 'assistant/message') continue
    const usage = (event.data as { usage?: { inputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number } } | undefined)?.usage
    if (usage === undefined || typeof usage.inputTokens !== 'number') continue
    const billedInput = usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
    const estimate = billedInput + Math.ceil(promptChars / 4)
    if (estimate > host.prefixBudgetTokens) return false
    return true
  }
  return false
}

export async function callAndStash(host: FlushHost, session: Session, collect: CurrentTurnCollect): Promise<CompressRecord> {
  const record: CompressRecord = { at: new Date().toISOString(), turn: collect.turn, called: true }
  pushBounded(host.records, record, host.telemetryCap)
  const backend = host.backend()
  if (backend === null) {
    record.error = 'no-endpoint'
    return record
  }
  host._calls += 1
  const started = Date.now()
  try {
    const prompt = buildPrompt(collect)
    record.atomSeqs = {
      userLong: collect.userLong.map(u => u.seq),
      toolResults: collect.toolResults.map(t => t.seq),
    }
    // A 形态前缀 + 预算门控：超预算该次降级 C（丢前缀只发指令），防爆上限。
    const context = buildContextPrefix(session)
    const effectiveCtk = resolveEffectiveCtk(host, session)
    const usePrefix = prefixWithinBudget(host, session, prompt.length)
    if (!usePrefix) record.degradedToC = 'prefix-budget'
    host.ctx.logger.info(`[argp-peratom] compressor: turn ${collect.turn} candidates=${collect.userLong.length}u+${collect.toolResults.length}r (dsh-llm=${backend.kind === 'dsh-llm'}, prefix=${usePrefix ? context.messages.length + ' msgs' : 'OFF (degraded C)'}, ctk=${JSON.stringify(effectiveCtk)})`)
    let raw: string
    let ms = Date.now() - started
    if (backend.kind === 'dsh-llm') {
      // dsh-llm 生产后端：GenerateOptions 无 response_format——schema 约束仅在 fetch
      // 后端可用，此路径一次到位，依赖 extractJson 兜底解析（无 schema 重试舞蹈）。
      // A 形态：deriveMessages() 前缀 + 指令尾部 user；ctk 由宿主 compat 决定
      //（本机 qwen-chat-template 硬编码 preserve_thinking:true，见 llm-adapter 头注——
      // 该路径的同态对齐依赖宿主，fetch 路径才是 ctk 继承的完全控制面）。
      const res = await completeViaDshLlm(host.ctx, backend.spec, prompt, host.timeoutMs, usePrefix ? context.messages : undefined, usePrefix ? context.tools : undefined)
      raw = res.text
      if (res.usage !== undefined) record.usage = res.usage
      ms = Date.now() - started
    } else {
      const contextWire = usePrefix ? serializeWireMessages(context.messages, host.ctx.logger) : undefined
      const contextTools = usePrefix ? serializeWireTools(context.tools) : undefined
      try {
        raw = await postChat(host.fetchImpl, backend.endpoint, prompt, host.timeoutMs, true, effectiveCtk, contextWire, contextTools, host.maxCompletionTokens)
        ms = Date.now() - started
      } catch (schemaError) {
        // response_format 被端点拒绝/网络抖动：spike 30/32 兼容模式重试一次（裸 prompt）。
        raw = await postChat(host.fetchImpl, backend.endpoint, prompt, host.timeoutMs, false, effectiveCtk, contextWire, contextTools, host.maxCompletionTokens)
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
    host.pending.push({ session, collect, decision, record })
    const extract = decision.tools.filter(t => t.level === 'extract').length
    const summary = decision.tools.filter(t => t.level === 'summary').length
    const falseActions = decision.tools.filter(t => t.level === 'false').length
    host.ctx.logger.info(`[argp-peratom] compressor: turn ${collect.turn} decision splits=${decision.splits.length} extract=${extract} summary=${summary} false=${falseActions} ms=${record.ms ?? '?'}`)
  } catch (error) {
    record.error = error instanceof Error ? error.message : String(error)
    host.ctx.logger.warn(`[argp-peratom] compressor: turn ${collect.turn} LLM call failed: ${record.error}`)
  }
  return record
}

// -- 两段式：idle 准备 → pre-step 发射 ----------------------------------

/** idle 触发段：记账防重 → 收集 → 门控 → LLM → 暂存待发射。返回观测记录。 */
export async function prepareCurrentTurn(host: FlushHost, session: Session): Promise<CompressRecord | null> {
  // 水位过滤内建（collect 缺省取该轮已规划边界）：已压过的原子不再入候选 ⇒ 幂等；
  // 窗口为空（无新增原子）时 collect 返回 null ⇒ 零调用短路。
  const collect = host.collectCurrentTurn(session)
  if (collect === null) return null

  const chain = buildVersionChainIndex(sessionEvents(session))
  if (collect.interrupted) {
    const record: CompressRecord = { at: new Date().toISOString(), turn: collect.turn, called: false, skipReason: 'interrupted' }
    pushBounded(host.records, record, host.telemetryCap)
    return record // 中断轮：error/aborted 收尾，半成品不进候选（宁全勿漏）；不推进水位
  }
  if (!turnCompressible([...collect.userLong, ...collect.toolResults], chain, host.gateOptions())) {
    const record: CompressRecord = { at: new Date().toISOString(), turn: collect.turn, called: false, skipReason: 'no-candidate' }
    pushBounded(host.records, record, host.telemetryCap)
    return record // 纯 dialog / 版本链成员 / 全小结果：零调用短路；不推进水位
  }
  const entry = await callAndStash(host, session, collect)
  if (entry.error === undefined && !entry.parseFailed) host.advanceWaterMark(session, collect.turn, collect.endSeq) // 成功规划才推进水位
  return entry
}

/** 发射段：把该 session 的全部就绪事务落入下一次 open-turn 窗口（同步追加，吞错记账）。 */
export function flushStashed(host: FlushHost, session: Session): void {
  while (true) {
    const idx = host.pending.findIndex(e => e.session === session)
    if (idx < 0) return
    const [entry] = host.pending.splice(idx, 1)
    try {
      flushEntry(host, entry.session, entry.collect, entry.decision, entry.record)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      host.ctx.logger.warn(`[argp-peratom] compressor flush failed: ${message}`)
      pushBounded(host.records, { at: new Date().toISOString(), turn: entry.collect.turn, called: true, error: message }, host.telemetryCap)
    }
  }
}

/** 公开入口（P4 溢出三步路径② / 单测）：立即收集+调用+发射，绕过两段式延迟。 */
export async function compressCurrentTurn(host: FlushHost, session: Session): Promise<CompressRecord | null> {
  const collect = host.collectCurrentTurn(session)
  return compressCollect(host, session, collect)
}

/**
 * 公开入口（P4 溢出三步路径② 生产接线）：对当前 open turn 立即收集+调用+发射。
 * 溢出发生在 open turn 的请求上，第②步必须压它而不是最新闭合轮（设计 §8
 * 「对当前轮大原子降熵」；closed 口径会错压上一轮，2026-08-29 review 中项）。
 * 水位语义（2026-09-21 修订）：open turn 压缩后**只推进该轮水位**（= 本次窗口 endSeq），
 * 该轮闭合时 idle prepare 仍会跑，但只收水位之后的新增原子（原先的"轮级一次性"
 * 记账会让轮内 pass 吃掉轮末 pass，使该轮尾部永不入压）。
 */
export async function compressOpenTurn(host: FlushHost, session: Session): Promise<CompressRecord | null> {
  const collect = host.collectOpenTurn(session)
  return compressCollect(host, session, collect)
}

/** 共享压缩尾部：中断/无候选短路（不推进水位）+ callAndStash + 立即 flush（成功才推进水位）。 */
export async function compressCollect(host: FlushHost, session: Session, collect: CurrentTurnCollect | null): Promise<CompressRecord | null> {
  if (collect === null) return null
  const chain = buildVersionChainIndex(sessionEvents(session))
  if (collect.interrupted) {
    const record: CompressRecord = { at: new Date().toISOString(), turn: collect.turn, called: false, skipReason: 'interrupted' }
    pushBounded(host.records, record, host.telemetryCap)
    return record // 不推进水位：该轮仍可被后续 pass 处理
  }
  if (!turnCompressible([...collect.userLong, ...collect.toolResults], chain, host.gateOptions())) {
    const record: CompressRecord = { at: new Date().toISOString(), turn: collect.turn, called: false, skipReason: 'no-candidate' }
    pushBounded(host.records, record, host.telemetryCap)
    return record // 不推进水位（原实现在此之前 done.add ⇒ 一次 no-candidate 永久作废该轮）
  }
  const entry = await callAndStash(host, session, collect)
  if (entry.error === undefined && !entry.parseFailed) host.advanceWaterMark(session, collect.turn, collect.endSeq) // 成功规划才推进水位
  flushStashed(host, session)
  return entry
}

// -- 事务括号发射（仿 t1：start..end，双事件/多事件发射，断言内联）-------

export function flushEntry(host: FlushHost, session: Session, collect: CurrentTurnCollect, decision: CompressDecision, record: CompressRecord): void {
  const plan = planReplacements(collect, decision, sessionEvents(session), { hlsMode: host.hlsMode, hlsRoiThreshold: host.hlsRoiThreshold })
  if (plan.steps.length === 0) {
    // 全部动作被拒（保真守卫/回退）或零动作：不开空事务，但统计直接落账到本次记录。
    record.skippedFallbackDialog = plan.skippedFallbackDialog
    record.skippedFidelity = plan.skippedFidelity
    record.skippedFalse = plan.skippedFalse
    record.skippedNoopGain = plan.skippedNoopGain
    if (plan.summaryDropped.length > 0) record.summaryDropped = plan.summaryDropped
    if (plan.hlsRepairs > 0) record.hlsRepairs = plan.hlsRepairs
    if (plan.restoredByGuard.length > 0) record.restoredByGuard = plan.restoredByGuard
    if (plan.hlsRoiSkipped > 0) record.hlsRoiSkipped = plan.hlsRoiSkipped
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
      // dsh 0.1.5 起 `Session.append` 的 opts 是条件元组（`assistant/message` 禁带
      // sourceEventSeqs、其余 surface 事件允许），而 `step.type` 是
      // 'user/message' | 'tool/result' 的联合 → TS 无法为联合选定单一重载。
      // 该联合本身已保证两者都允许 sourceEventSeqs，故仅在类型层收窄掉泛型分派；
      // 运行时仍走 `Session.append` 同一条校验路径（品牌校验、surface 计划、provenance）。
      const appendSurface = session.append.bind(session) as (
        type: string,
        data: unknown,
        opts: { surfaceOp: unknown; sourceEventSeqs: readonly unknown[] },
      ) => unknown
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
        appendSurface(step.type, step.data, {
          surfaceOp: { op: 'replace', startSeq: asSeq(step.at), endSeq: asSeq(step.at) },
          sourceEventSeqs: asSeqs(step.sourceEventSeqs),
        })
        const g1 = session.surface.replaceGeneration
        // 断言 2：每次 replace 必须推进 replaceGeneration（替换真实落地）。
        if (g1 <= g0) {
          throw new Error(`replaceGeneration did not advance after replacing seq ${step.at} (${g0} -> ${g1})`)
        }
        replaceCount += 1
      } else {
        appendSurface(step.type, step.data, {
          surfaceOp: 'append',
          sourceEventSeqs: asSeqs(step.sourceEventSeqs),
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
    // 后端标签反映**实际选路**（§11.13.1）：显式/自动 dsh-llm 报宿主路由，
    // fetch 报端点 URL，三者皆无报 disabled。审计脚本按此判"Stage-1 是否真的跑过"。
    const summaryBackend = host.backend()
    session.append('compaction/summary', {
      ...lifecycle,
      summary: [{
        type: 'text',
        text: `ARGP 逐原子压缩（turn ${collect.turn}）：${decision.splits.length} 拆分 / ${extractCount} 提取 / ${summaryCount} 摘要 / ${falseCount} 保原文；原文保留在 append-only 日志，recall_detail(seq) 可取回`,
      }],
      shadowedRange: { start: collect.startSeq, end: collect.endSeq },
      shadowedSeqs: plan.steps.flatMap(step => step.sourceEventSeqs),
      shadowedTokenCount: Math.ceil(shadowedChars / 3.5),
      provider: summaryBackend?.kind === 'dsh-llm' ? summaryBackend.spec.provider : 'fetch',
      // ⚠️ fetch 分支要取 `endpoint.endpoint`（URL 字符串）：`endpoint` 本身是
      // ResolvedEndpoint 对象 {endpoint, model, apiKey}，`String(对象)` 序列化成
      // "[object Object]"（2026-09-18 ab4 跑批实测审计字段坏掉）——既丢 URL，也丢模型名，
      // 审计脚本无法判断 Stage-1 实际跑在哪个模型上。现在 model 段同时带模型名与端点 URL。
      model: summaryBackend === null
        ? 'disabled'
        : (summaryBackend.kind === 'dsh-llm'
          ? summaryBackend.spec.model
          : `${summaryBackend.endpoint.model} @ ${summaryBackend.endpoint.endpoint}`),
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
    if (plan.hlsRepairs > 0) record.hlsRepairs = plan.hlsRepairs
    if (plan.restoredByGuard.length > 0) record.restoredByGuard = plan.restoredByGuard
    if (plan.hlsRoiSkipped > 0) record.hlsRoiSkipped = plan.hlsRoiSkipped
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

// -- 在飞 pass 有界等待 + agent 路由记忆 ---------------------------------

/**
 * 有界等待在飞的轮末 pass（见 `PeratomCompressorConfig.flushWaitMs`）。
 * 取走屏障（同一批 pass 只在首个 pre-step 等一次）；超时/失败都不抛——宁可放行让
 * 事务顺延到后续窗口，也不把用户这一轮卡死。
 */
export function awaitInFlightPass(host: FlushHost, session: Session): Promise<void> {
  const pass = host.inFlightPass.get(session)
  if (pass === undefined || host.flushWaitMs <= 0) return Promise.resolve()
  host.inFlightPass.delete(session)
  host.ctx.logger.info(`[argp-peratom] compressor: turn-end pass in flight; holding this pre-step up to ${host.flushWaitMs}ms for it to land (avoids mid-turn surface replacement)`)
  return new Promise<void>(resolve => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (timedOut: boolean): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      if (timedOut) {
        host.ctx.logger.warn(`[argp-peratom] compressor: turn-end pass still in flight after ${host.flushWaitMs}ms; releasing this turn's first request without it (the transaction lands at a later pre-step window)`)
      }
      resolve()
    }
    timer = setTimeout(() => finish(true), host.flushWaitMs)
    void pass.then(() => finish(false), () => finish(false))
  })
}

/**
 * 记住 agent 路由（§11.13.1 自动兜底）。构造期拿不到路由，只能在真会话的
 * `agent/status` / `agent/pre-step` 钩子里现取。非自动模式直接短路。
 */
export function rememberRoute(host: FlushHost, agent: { options?: AgentRouteHint } | undefined): void {
  if (!host.llmAutoEligible) return
  try {
    const spec = autoDshLlmSpec(host.ctx, agent?.options ?? null)
    if (spec !== null) host.autoLlm = spec
  } catch { /* 路由解析失败：保持原值，退化为 disabled（零网络） */ }
}
