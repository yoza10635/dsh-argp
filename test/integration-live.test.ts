/**
 * 活体集成层（Tier B）：**真模型 + 真 provider usage 账单**参与的端到端门。
 *
 * ## 为什么 2026-11-27 整文件重写
 *
 * 旧 L1/L2 打的是 peratom stage-1 决策栈——`engine.peratomStack.compressor.records`、
 * `extractJson`、`normalizeDecision`、`LiveRecord.parseFailed/degradedToC`。该管线在
 * 2.x factor-only 重构中**整体退役**（`src` 里只剩注释与 `[argp-peratom]` 日志前缀），
 * 于是只要端点在线，两例必红在 `TypeError: Cannot read properties of undefined
 * (reading 'compressor')`。而 `ARGP_ITEST_LLM` 门控让它从不进 CI ⇒ 腐烂静默了一整个
 * 版本。教训与本文件的重写规则一起钉在这里：**门控掉的测试等于没有测试**，活体层每次
 * 发布前必须真跑一次（`npm run test:live`），跑不动要在发布记录里写明原因。
 *
 * ## 现在锁什么
 *
 * 2.0 只有一条 LLM 生产通路：散文浓缩（`ctx.llm.stream()`，`purpose:'compaction'`）。
 * 活体层因此只锁**只有真模型 / 真 usage 才能回答**的两组事实：
 *
 *  L1 散文浓缩契约：真模型产出的摘要能落成合法检查点（`[散文压缩]` 前缀在面上）、
 *     事务括号配对、surface 真实瘦身、面上不点名已退役工具（词表纪律 ⑩ 的活体侧）、
 *     账本零告警。
 *
 *  L2 前缀缓存判据（两道发布门槛，全部用 provider usage 读数与真实请求字节，不靠首字延迟反推）：
 *     ① 手动压缩的摘要请求必须走宿主同款装配（host-form），两道各自独立：
 *        · **结构**（L1 锁，确定性、与端点无关）：摘要请求 ≥98% 复用上一发 agent 请求的
 *          字节作前缀，只在尾部追加摘要指令（旧 A 形态重建 `U:`/`A:` transcript，头部就
 *          分叉；实测延长 100%／对照 192,262 字符）。
 *        · **命中**（L2 锁）：该请求 usage 命中 ≥90%，前提（头注 SEED_TURNS）是提示规模
 *          远小于端点 KV 驻留容量——116K 级提示下三发共 233K，端点只能整条重灌，同配方
 *          实测在 0%/27.2s 与 98%/11.1s 之间摇摆，那是容量驱逐而非装配回归。
 *     ② 压缩后**续作**请求不得再次构成低命中重灌（`isLowCacheHit`：≥8K prompt 且
 *        命中 <50%）——首请求重灌是压缩的必然代价，次发仍断才说明另有抖前缀的来源
 *        （目录 / 词表 / 系统段）。**本层边界**：手动压缩把可剪面剪尽，本机配方的保留段
 *        只有约 1K tok（低于 8K 块粒度门槛）⇒ 该处只能证「未见异常重灌」，「次发恢复」
 *        的正向证据仍需在真宿主会话（保留段十万级）上看，不得把本层的绿读成那条结论。
 *     **仪表前提**：压缩前第二发必须在 ≥8K prompt 上报出 ≥50% 命中。端点若根本不做
 *     前缀缓存，上面两条判据全是空转 ⇒ 如实失败并说明，不得静默通过。
 *
 * 与 Tier A（`integration-loop.test.ts`，脚本化 LlmAdapter）的分工不变：A 锁时序 /
 * 桶隔离 / 信号，响应内容由脚本决定；B 只在真实字节与真实账单上跑。这里**不**脚本化
 * agent 轮——被测面就是请求前缀与 usage 账单，脚本化会把它们抹平。
 *
 * 门控：`ARGP_ITEST_LLM`（OpenAI 兼容 base）+ `/models` 可达性探测；未设置或不可达
 * ⇒ 整文件 skip，`npm test`（CI / 发布门）保持零网络、确定性。`npm run test:live`
 * 经 `scripts/live-env.mjs` 预置默认地址后点亮。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { AgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter, createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ArgpEngine } from '../src/argp-engine.ts'
import { eventText, sessionEvents } from '../src/log-access.ts'
import { serializeWireMessages } from '../src/llm/llm-adapter.ts'
import { PROSE_CHECKPOINT_PREFIX } from '../src/factor/prose-condenser.ts'
import {
  classifyCacheSample, isLowCacheHit,
  REFILL_MAX_HIT_RATIO, REFILL_MIN_PROMPT_TOKENS, type RequestCacheSample,
} from '../src/cache-audit.ts'
import type { GraphPruneRecord } from '../src/prune-tx.ts'

// ---------------------------------------------------------------------------
// 门控与预检（env 未设 / 端点不可达 ⇒ 零网络，整文件 skip）
// ---------------------------------------------------------------------------

const LIVE = process.env['ARGP_ITEST_LLM'] ?? ''
const MODEL = process.env['ARGP_ITEST_MODEL'] ?? ''
let liveSkip = 'ARGP_ITEST_LLM 未设置（活体层 opt-in：npm run test:live）'
let servedModel = ''
if (LIVE !== '') {
  try {
    const res = await fetch(LIVE.replace(/\/+$/, '') + '/models', { signal: AbortSignal.timeout(4000) })
    const body = await res.json() as { data?: { id?: string }[] }
    servedModel = body.data?.[0]?.id ?? ''
    liveSkip = servedModel === '' ? `ARGP_ITEST_LLM=${LIVE} 可达但模型列表为空` : ''
  } catch (e) {
    liveSkip = `ARGP_ITEST_LLM=${LIVE} 不可达：${(e as Error).message}`
  }
}

/** 引擎算账用的声明窗（端点真实窗更大也无妨：本层只关心请求前缀与 usage 读数）。 */
const DECLARED_WINDOW = 20_000

/** 铺史规模（≈36K tok 提示；压缩前两发 + 摘要一发共约 108K，远小于本机端点 262K 窗）。
 *  规模必须留在端点 KV 驻留容量以内，否则前缀被容量驱逐，摘要请求的命中率读数与装配
 *  正确性脱钩（116K 级提示实测：同配方在 0%/27.2s 与 98%/11.1s 之间摇摆）。同时提示要
 *  明显大于 retain 带（见 runLiveFlow），否则全部散文都在保留带内 ⇒ 无面可剪。 */
const SEED_TURNS = 6
const SEED_LINES = 150

// ---------------------------------------------------------------------------
// 活体适配器：真 HTTP 转发，usage 按 dsh-llm 契约拆「未命中 / 命中」
// ---------------------------------------------------------------------------

interface LiveCall {
  purpose: string
  ms: number
  prompt: number
  cached: number
  completion: number
  /** 实际发出的 wire（JSON 文本）；用于「摘要请求 = 上一发请求的前缀延长」这一结构性判据。 */
  wire: string
  /** 请求体的非 messages 面（tools / 键集 / 角色序列）：provider 的前缀由「模板 + tools + messages」
   *  共同渲染，messages 之外的差异同样会从头打断前缀，光比 wire 字节看不见它。 */
  reqMeta: string
}

class LiveHttpLlm extends LlmAdapter {
  readonly calls: LiveCall[] = []
  private readonly base: string
  private readonly model: string
  constructor(base: string, model: string) {
    super()
    this.base = base
    this.model = model
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const purpose = String((options as { purpose?: string }).purpose ?? 'agent')
    // 本机端点（Qwen 模板）只认 role:'system' 打头；生产 vLLM build 用 'developer'。
    const wire = serializeWireMessages(options.messages as readonly Message[])
      .map(m => (m['role'] === 'developer' ? { ...m, role: 'system' } : m))
    const started = Date.now()
    const payload: Record<string, unknown> = {
      model: this.model,
      messages: wire,
      temperature: 0,
      ...(options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
      // tools 不下发：本机端点无对应工具实现，下发会让 agent 轮去调工具而挂死（本层被测面是
      // 请求前缀与 usage 账单，工具面不是）。tools 数由 reqMeta 记录供对照。
      stream: false,
    }
    const res = await fetch(this.base.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: (options as { signal?: AbortSignal }).signal,
    })
    const body = await res.json() as {
      choices?: { message?: { content?: string | null } }[]
      usage?: {
        prompt_tokens?: number
        completion_tokens?: number
        prompt_tokens_details?: { cached_tokens?: number }
      }
    }
    if (!res.ok) throw new Error('live llm HTTP ' + res.status + ': ' + JSON.stringify(body).slice(0, 500))
    const text = body.choices?.[0]?.message?.content ?? ''
    const prompt = body.usage?.prompt_tokens ?? 0
    const cached = body.usage?.prompt_tokens_details?.cached_tokens ?? 0
    const completion = body.usage?.completion_tokens ?? 0
    const wireText = JSON.stringify(wire)
    const reqMeta = 'tools=' + (Array.isArray((options as { tools?: unknown[] }).tools) ? (options as { tools?: unknown[] }).tools!.length : 0)
      + ' max_tokens=' + (payload.max_tokens === undefined ? '-' : 'yes')
      + ' msgs=' + wire.length
      + ' roles=' + wire.map(m => String(m['role'])).join(',')
    this.calls.push({ purpose, ms: Date.now() - started, prompt, cached, completion, wire: wireText, reqMeta })
    yield { type: 'block-start', index: 0, blockType: 'text' }
    if (text !== '') yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    if (body.usage !== undefined) {
      // dsh-llm 契约：inputTokens 是**未命中**部分，命中单列（两者互斥）。
      yield { type: 'usage', usage: { inputTokens: Math.max(0, prompt - cached), outputTokens: completion, cacheReadTokens: cached } }
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  override async resolveModel(provider: string, model: string) {
    return { provider, id: model, name: 'live model', context: { contextWindow: DECLARED_WINDOW } }
  }
}

// ---------------------------------------------------------------------------
// 驱动台架：铺散文史 → 稳态两发 → 手动压缩 → 续作两发（与 spike/51 同源配方）
// ---------------------------------------------------------------------------

/** 大段日志体散文（U/A 正文）：唯一能真正改写请求前缀的压缩对象是散文，不是伪造的 tool/result。 */
function logBlock(tag: string, lines: number): string {
  const out: string[] = []
  for (let n = 0; n < lines; n++) {
    out.push(`2026-11-27T10:${String(n % 60).padStart(2, '0')} INFO [${tag}] job=${n} pid=${1000 + n} status=ok bytes=${2048 + n * 37} tick=${n}`)
  }
  return out.join('\n')
}

function say(agent: Agent, text: string): void {
  agent.send(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), 'next-turn', true)
}

async function until(cond: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (cond()) return
    await new Promise(r => setTimeout(r, 50))
  }
  assert.ok(cond(), '等待超时：' + what)
}

function fmtSample(s: RequestCacheSample): string {
  return '  turn=' + (s.turn ?? '?') + ' step=' + (s.step ?? '?')
    + ' prompt=' + s.promptTokens + ' cached=' + s.cachedTokens
    + ' (' + Math.round(s.hitRatio * 100) + '%) ' + classifyCacheSample(s)
    + (s.firstAfterCompaction ? ' FIRST' : '')
    + (s.compactionId === null ? '' : ' tx=' + s.compactionId.slice(0, 8))
}

function fmtCall(c: LiveCall): string {
  return '  ' + c.purpose + ': prompt=' + c.prompt + ' cached=' + c.cached
    + ' (' + (c.prompt > 0 ? Math.round((c.cached / c.prompt) * 100) : 0) + '%) ' + c.ms + 'ms'
    + ' · ' + c.reqMeta
}

/** 两段请求体的公共前缀字符数。 */
function commonPrefixChars(a: string, b: string): number {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a[i] === b[i]) i += 1
  return i
}

/**
 * 结构性判据（与端点缓存策略无关）：摘要请求必须**以前一发 agent 请求的字节为前缀**，
 * 只在尾部追加摘要指令——这就是「宿主同款装配（host-form）」的定义。旧 A 形态在头部
 * 重建 `U:`/`A:` transcript，前缀延长会远低于 1，故回退到旧形态必红。
 */
function assertHostFormStructure(calls: readonly LiveCall[], summary: LiveCall, where: string): void {
  const idx = calls.indexOf(summary)
  const prev = calls[idx - 1]
  assert.ok(prev !== undefined && prev.purpose !== 'compaction', where + '：摘要请求之前应有一发 agent 请求可作对照')
  const diff = commonPrefixChars(prev!.wire, summary.wire)
  const ratio = diff / Math.max(1, prev!.wire.length)
  console.log('[live] ' + where + ' 前缀延长=' + Math.round(ratio * 100) + '%'
    + '（对照 ' + prev!.wire.length + ' 字符 / 摘要 ' + summary.wire.length + ' 字符，首个分叉 @' + diff + '）'
    + '；摘要请求命中 ' + summary.prompt + '/' + summary.cached + ' tok ('
    + (summary.prompt > 0 ? Math.round((summary.cached / summary.prompt) * 100) : 0) + '%) ' + summary.ms + 'ms')
  console.log('[live] ' + where + ' 分叉点上下文 上一发 …' + prev!.wire.slice(Math.max(0, diff - 70), diff + 70))
  console.log('[live] ' + where + ' 分叉点上下文 摘要发 …' + summary.wire.slice(Math.max(0, diff - 70), diff + 70))
  assert.ok(ratio >= 0.98,
    where + '：摘要请求只复用了上一发请求的 ' + Math.round(ratio * 100)
    + '% 字节作前缀 ⇒ 没有走宿主同款装配（host-form），前缀在头部就分叉')
}

/** 铺 `count` 轮大段散文（U/A 各一份），轮号自 `startTurn` 起。 */
function seedProse(session: Session, startTurn: number, count: number, tagPrefix: string): void {
  for (let t = startTurn; t < startTurn + count; t++) {
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Turn ' + t + ': build log batch, keep going.\n' + logBlock(tagPrefix + t, SEED_LINES) }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('assistant/message', {
      turn: t, step: 1,
      message: createAssistantMessage({
        source: { provider: 'live', model: servedModel || MODEL },
        content: [{ type: 'text', text: 'Turn ' + t + ': batch ' + t + ' looks like routine build output; no fatal errors.' }],
      }),
    } as never, { surfaceOp: 'append' })
  }
}

interface LiveFlow {
  ctx: Context
  adapter: LiveHttpLlm
  engine: ArgpEngine
  agent: Agent
  session: Session
  /** 压缩前的 usage 采样（稳态对照，仪表前提的取数处）。 */
  before: RequestCacheSample[]
  /** 压缩后的 usage 采样（首请求 + 续作）。 */
  after: RequestCacheSample[]
  /** 手动压缩落地的最后一笔剪枝账（未发射 ⇒ null）。 */
  record: GraphPruneRecord | null
  summaryText: string
}

/** 完整跑一遍活体流程；调用方负责 `ctx.fiber.dispose()`。 */
async function runLiveFlow(tag: string): Promise<LiveFlow> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, {
    systemPrompt: { personaPrefix: tag + '. Reply with one short sentence; no lists.' },
  })
  const adapter = new LiveHttpLlm(LIVE, servedModel || MODEL)
  ;(ctx.get('llm') as unknown as { registerAdapter(p: string[], a: LlmAdapter): unknown }).registerAdapter(['a'], adapter)
  // retain 带必须显著小于铺出的散文面，否则整个面都在保留带里 ⇒ 无面可剪、不发摘要。
  await ctx.plugin(ArgpEngine, { engine: 'factor', windowTokens: DECLARED_WINDOW, retainTokens: 6_000 })
  const engine = ctx.compaction as ArgpEngine
  const harness: AgentLoopTestHarness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create(SessionId(tag), { provider: 'a', model: 'm' } as never)
  const session = agent.session
  const samples = (): RequestCacheSample[] => engine.stateOf(session).cacheSamples

  // 1) 铺垫大段散文（U/A 各一份）：手动压缩走「全量剪 + 散文浓缩」，浓缩检查点替换早期
  //    正文 ⇒ 请求前缀真实改变，重灌才可测（伪造 tool/result 不在 loop 派生的 wire 里，
  //    剪它们请求字节不变，测不出任何东西——spike/51 实锤）。
  seedProse(session, 1, SEED_TURNS, 'prose-')

  // 2) 压缩前两发：第二发是稳态对照（端点是否真报缓存全看它）。
  say(agent, 'continue')
  await agent.whenIdle()
  say(agent, 'continue again')
  await agent.whenIdle()
  await until(() => samples().length >= 2, 240_000, '压缩前两次请求的 usage')
  const before = samples().slice()

  // 3) 手动压缩（等价宿主 /compact）。
  const result = await engine.compactNow(agent as never, new AbortController().signal)
  const records = engine.records
  const record: GraphPruneRecord | null = records.length > 0 ? records[records.length - 1] ?? null : null
  const summaryText = result === null ? '' : (result.summary ?? [])
    .map(b => (b as { text?: string }).text ?? '').join('')

  // 4) 压缩后两发：首请求（必然代价）+ 次发（判据本体）。
  say(agent, 'continue after compaction')
  await agent.whenIdle()
  say(agent, 'one more')
  await agent.whenIdle()
  await until(() => samples().length >= before.length + 2, 240_000, '压缩后两次请求的 usage')
  const after = samples().slice(before.length)

  console.log('[' + tag + '] LLM 调用账单：\n' + adapter.calls.map(fmtCall).join('\n'))
  console.log('[' + tag + '] usage 采样：\n' + samples().map(fmtSample).join('\n'))
  console.log('[' + tag + '] compactNow → ' + (result === null ? 'null（未发射）' : result.compactionId)
    + (record === null ? '' : '；末笔账 ' + record.intervals.length + ' 区间 / '
      + record.shadowedSeqs.length + ' 节点 / ' + record.charsBefore + '→' + record.charsAfter + ' 字符'))

  return { ctx, adapter, engine, agent, session, before, after, record, summaryText }
}

// ---------------------------------------------------------------------------
// L1 散文浓缩契约（真模型产出 → 合法检查点 → 事务与账本自洽）
// ---------------------------------------------------------------------------

test('L1 活体：真模型散文浓缩——检查点落地、事务括号配对、surface 真实瘦身', { skip: liveSkip || undefined, timeout: 900_000 }, async () => {
  const flow = await runLiveFlow('argp-live-l1')
  try {
    const record = flow.record
    assert.ok(record !== null, '手动压缩必须留下一笔剪枝账')
    assert.ok(record!.error === undefined, '事务不得以 error 收尾：' + String(record!.error))
    assert.ok(record!.intervals.length >= 1, '至少落地一个剪枝区间')

    // 装配正确性（与端点无关的结构性判据）：摘要请求 = 上一发 agent 请求的字节延长。
    const summaryCall = flow.adapter.calls.find(c => c.purpose === 'compaction')
    assert.ok(summaryCall !== undefined, '手动压缩必须发起真实摘要调用（purpose=compaction）')
    assertHostFormStructure(flow.adapter.calls, summaryCall!, '压缩')
    assert.ok(record!.charsAfter < record!.charsBefore,
      'surface 真实瘦身（charsBefore=' + record!.charsBefore + ' → charsAfter=' + record!.charsAfter + '）')

    // 真模型的摘要必须可见且落成检查点（不是被丢弃后静默剪）。
    assert.ok(flow.summaryText.trim().length > 0, '真模型必须产出非空摘要正文')
    const surfaceText = [...flow.session.surface.nodes].map(seq => eventText(flow.session, seq)).join('\n')
    assert.ok(surfaceText.includes(PROSE_CHECKPOINT_PREFIX),
      '面上必须存在散文检查点（前缀 ' + PROSE_CHECKPOINT_PREFIX + '）——摘要未落地却剪了 = 静默丢内容')

    // 词表纪律 ⑩ 的活体侧：事务写出的模型可见文本不得点名已退役工具。
    const retired = surfaceText.match(/recall_pruned|list_pruned/g)
    assert.equal(retired, null, '面上出现已退役工具名：' + String(retired))

    const events = sessionEvents(flow.session).filter(e => e.type.startsWith('compaction/'))
    const starts = events.filter(e => e.type === 'compaction/start').length
    const ends = events.filter(e => e.type === 'compaction/end').length
    assert.ok(ends >= 1, '至少一笔 compaction/end')
    assert.equal(starts, ends, '事务括号配对（start 与 end 数相等）')

    assert.deepEqual(flow.engine.auditWarnings, [], '账本重建/装配零告警')
  } finally {
    await flow.ctx.fiber.dispose()
  }
})

// ---------------------------------------------------------------------------
// L2 前缀缓存判据（真 usage：手动压缩摘要命中 ≥90% + 续作不得二次重灌；装配结构在 L1）
// ---------------------------------------------------------------------------

test('L2 活体：真 usage 前缀缓存——手动压缩摘要命中 ≥90%、压缩后续作不再重灌', { skip: liveSkip || undefined, timeout: 900_000 }, async () => {
  const flow = await runLiveFlow('argp-live-l2')
  try {
    // ── 仪表前提：端点必须真报前缀缓存，否则下面的命中判据是空转 ──
    const warm = flow.before[1]
    assert.ok(warm !== undefined, '压缩前应有两发稳态采样（仪表前提的取数处）')
    assert.ok(warm!.promptTokens >= REFILL_MIN_PROMPT_TOKENS,
      '仪表前提不成立：稳态第二发 prompt=' + warm!.promptTokens + ' < ' + REFILL_MIN_PROMPT_TOKENS
      + '（块粒度以下无从判断端点是否做缓存）')
    assert.ok(warm!.hitRatio >= REFILL_MAX_HIT_RATIO,
      '仪表前提不成立：稳态第二发命中 ' + Math.round(warm!.hitRatio * 100) + '% < '
      + Math.round(REFILL_MAX_HIT_RATIO * 100)
      + '% ⇒ 该端点不做前缀缓存，本层缓存判据无从谈起（换端点或明确关掉本层，不得静默通过）')

    // ── 门槛①：摘要请求的命中读数（装配结构本身由 L1 锁）──
    // 命中读数只在**提示规模远小于端点 KV 驻留容量**时才是可用仪表（见 SEED_TURNS 头注）：
    // 116K 级提示三发共 233K，端点只能整条重灌，同配方实测在 0%/27.2s 与 98%/11.1s 之间
    // 摇摆——那是容量驱逐，与装配正确性无关，拿来当回归门就是假红。
    const found = flow.adapter.calls.find(c => c.purpose === 'compaction')
    assert.ok(found !== undefined, '手动压缩必须发起真实摘要调用（purpose=compaction）')
    const sc = found!
    assert.ok(sc.prompt >= REFILL_MIN_PROMPT_TOKENS,
      '摘要请求 prompt=' + sc.prompt + ' 太小，命中率无意义（散文史铺得不够）')
    const hit = sc.cached / sc.prompt
    assert.ok(hit >= 0.9,
      '摘要请求命中 ' + Math.round(hit * 100) + '%（cached=' + sc.cached + '/prompt=' + sc.prompt
      + '）< 90%：装配结构由 L1 锁（前缀字节延长），此处仍整条重灌 ⇒ 宿主同款装配没换来'
      + '热前缀复用；先排除端点驻留容量（见 SEED_TURNS 头注），再查装配')

    // ── 门槛②：压缩后首请求重灌是必然代价；**续作**不得再断 ──
    const postFirst = flow.after.find(s => s.firstAfterCompaction)
    assert.ok(postFirst !== undefined, '压缩后首请求应有 usage 采样（compactionId + firstAfterCompaction）')
    const verdict = classifyCacheSample(postFirst!)
    assert.ok(verdict === 'post-compaction-refill' || verdict === 'post-compaction-cached',
      '压缩后首请求判据异常：' + verdict)
    if (postFirst!.promptTokens < REFILL_MIN_PROMPT_TOKENS) {
      console.log('[argp-live-l2] 注：压缩后保留段仅 ' + postFirst!.promptTokens + ' tok（< '
        + REFILL_MIN_PROMPT_TOKENS + '），provider 按块命中（实测 2048/块）'
        + ' ⇒ 低命中属「块粒度未达」，不构成重灌证据')
    }
    const followers = flow.after.filter(s => s !== postFirst)
    assert.ok(followers.length >= 1, '压缩后至少两发（次发是判据本体）')
    assert.deepEqual(followers.filter(s => isLowCacheHit(s)).map(fmtSample), [],
      '压缩后续作再次整条重灌（≥8K prompt 且命中 <50%）——首发重灌是必然代价，'
      + '次发仍断说明另有前缀重置源（目录 / 词表 / 系统段抖字节）')

  } finally {
    await flow.ctx.fiber.dispose()
  }
})
