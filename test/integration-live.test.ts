/**
 * 活体集成测试（Tier B，2026-10-26）：Stage-1 压缩决策由真实本地 LLM 产生。
 *
 * 与 Tier A（integration-loop.test.ts，脚本化 LlmAdapter）的分工：A 锁引擎行为
 * （时序 / 桶隔离 / 信号——响应内容由脚本决定）；B 锁**提示词模板 × 真实模型输出**
 * 的契约——模型真会吐什么（think 块、代码围栏、啰嗦前言）只有真模型能回答，
 * extractJson 的三重防御与 normalizeDecision 信任边界的实际有效性在这里暴露。
 * 驱动因此保持确定性：agent 轮文本走脚本队列，只有 purpose='compaction' 的调用
 * 转发真实 HTTP——与生产 dsh-llm 路径同形态（GenerateOptions 无 response_format，
 * 靠 extractJson 兜底，正是被测契约）。
 *
 * 门控：ARGP_ITEST_LLM（OpenAI 兼容 base，如 http://127.0.0.1:1234/v1）。
 * 未设置或不可达 ⇒ 全文件 skip——`npm test`（CI / 发布门）保持零网络、确定性；
 * `npm run test:live` 经 scripts/live-env.mjs 预置默认地址后点亮。
 *
 *  L1. 单轮端到端契约：真实决策解析成功（零 parseFailed / 零 error）、会话不破
 *      （轮 2 照常完成）、若决策落地则事务括号配对。
 *  L2. 五轮采样质量门：可压缩真实感内容连续采样，解析成功率 5/5、flush 事务 ≥3、
 *      surface 真实瘦身（压缩生效而非空转）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { AgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session as SessionType } from '@deepseek-ai/dsh-session'
import { ArgpGraphEngine } from '../src/argp-graph-engine.ts'
import { eventText } from '../src/log-access.ts'
import { serializeWireMessages } from '../src/peratom/llm-adapter.ts'

// ---------------------------------------------------------------------------
// 门控与预检（env 未设 ⇒ 零网络，直接整文件 skip）
// ---------------------------------------------------------------------------

const LIVE = process.env['ARGP_ITEST_LLM'] ?? ''
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

// ---------------------------------------------------------------------------
// 活体适配器：agent 轮脚本化（确定性驱动），compaction 调用转发真实 HTTP
// ---------------------------------------------------------------------------

interface LiveCompactionCall {
  ms: number
  promptChars: number
  wireMsgs: number
  finishReason: string
  /** 响应正文头 200 字符（诊断用；与生产 rawResponse 脱敏口径一致，不落全文）。 */
  rawHead: string
}

class LiveHttpLlm extends LlmAdapter {
  readonly compactionCalls: LiveCompactionCall[] = []
  readonly resolveCalls: string[] = []
  /** agent 轮脚本队列（单 provider 'a'；活体层无多 agent 交错用例）。 */
  turnQueue: string[] = []

  readonly base: string
  readonly model: string

  constructor(base: string, model: string) {
    super()
    this.base = base
    this.model = model
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const purpose = (options as { purpose?: string }).purpose
    if (purpose === 'compaction') {
      // 生产 dsh-llm 路径的请求形态：宿主 LlmRuntime 序列化前的 Message[]——
      // 适配器自己转 OpenAI wire（复用生产序列化器，消息形状与真宿主一致）。
      const wire = serializeWireMessages(options.messages as readonly Message[])
      const signal = (options as { signal?: AbortSignal }).signal
      const started = Date.now()
      const res = await fetch(this.base.replace(/\/+$/, '') + '/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          messages: wire,
          temperature: options.temperature ?? 0,
          ...(options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
          stream: false,
        }),
        signal,
      })
      const body = await res.json() as {
        choices?: { message?: { content?: string | null }; finish_reason?: string }[]
        usage?: { prompt_tokens?: number; completion_tokens?: number }
      }
      if (!res.ok) throw new Error(`live llm HTTP ${res.status}: ${JSON.stringify(body).slice(0, 200)}`)
      const text = body.choices?.[0]?.message?.content ?? ''
      this.compactionCalls.push({
        ms: Date.now() - started,
        promptChars: JSON.stringify(wire).length,
        wireMsgs: wire.length,
        finishReason: body.choices?.[0]?.finish_reason ?? '',
        rawHead: text.slice(0, 200),
      })
      yield { type: 'block-start', index: 0, blockType: 'text' }
      if (text !== '') yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      if (body.usage !== undefined) {
        yield { type: 'usage', usage: { inputTokens: body.usage.prompt_tokens ?? 0, outputTokens: body.usage.completion_tokens ?? 0 } }
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    const script = this.turnQueue.shift()
    if (script === undefined) throw new Error('live adapter: agent turn with empty script queue')
    yield { type: 'block-start', index: 0, blockType: 'text' }
    if (script !== '') yield { type: 'text-delta', index: 0, text: script }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: script } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  override async resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string; context: { contextWindow: number } }> {
    this.resolveCalls.push(provider)
    // 声明窗口沿用 Tier A 夹具口径（2000）：预算解析已被确定性层覆盖，活体层测的是
    // 决策契约；真模型上下文（262144）会让压力永远不触发，轮末 pass 就不发射了。
    return { provider, id: model, name: 'live fixture model', context: { contextWindow: 2000 } }
  }
}

// ---------------------------------------------------------------------------
// harness 组装 + 驱动（与 Tier A 同构；config 沿用 I1 已证明触发轮末 pass 的组合）
// ---------------------------------------------------------------------------

async function makeLiveLoop(): Promise<{
  ctx: Context
  adapter: LiveHttpLlm
  engine: ArgpGraphEngine
  harness: AgentLoopTestHarness
}> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: 'integration-live test' } })
  const adapter = new LiveHttpLlm(LIVE, servedModel)
  ;(ctx.get('llm') as unknown as { registerAdapter(p: string[], a: LlmAdapter): unknown }).registerAdapter(['a'], adapter)
  await ctx.plugin(ArgpGraphEngine, {
    peratom: { declarer: false },
    windowTokens: 8000, retainTokens: 4000, recencyGuard: 0, turnGuard: 0, minSpanChars: 20,
  })
  const harness = await mountAgentLoopTestHarness(ctx)
  return { ctx, adapter, engine: ctx.compaction as ArgpGraphEngine, harness }
}

function say(agent: Agent, text: string): void {
  agent.send(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), 'next-turn', true)
}

async function until(cond: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (cond()) return
    await new Promise(r => setTimeout(r, 40))
  }
  assert.ok(cond(), '等待超时：' + what)
}

function compactionEvents(session: SessionType): { type: string; error?: unknown }[] {
  return session.snapshotEvents()
    .filter(e => e.type.startsWith('compaction/'))
    .map(e => ({ type: e.type, error: (e.data as { error?: unknown } | undefined)?.error }))
}

interface LiveRecord {
  turn: number
  called: boolean
  error?: string
  parseFailed?: boolean
  decision?: unknown
  skipReason?: string
  ms?: number
  rawResponse?: string
  degradedToC?: string
}

function compressorOf(engine: ArgpGraphEngine): { records: LiveRecord[] } {
  const stack = (engine as unknown as { peratomStack: { compressor: unknown } | null }).peratomStack
  assert.ok(stack !== null, 'peratom 栈已挂载（引擎自挂载句柄）')
  return stack.compressor as { records: LiveRecord[] }
}

function describeRecords(records: LiveRecord[]): string {
  return records.map(r =>
    `  turn=${r.turn} called=${r.called} parseFailed=${r.parseFailed === true} error=${r.error ?? '-'} skip=${r.skipReason ?? '-'} ms=${r.ms ?? '-'} decision=${r.decision === undefined ? 'none' : 'yes'}`,
  ).join('\n')
}

/** L2 采样载荷：纯日志体（无天然 dialog 句），独占标记嵌在正文中段——压缩落地
 *  则标记随原文一起离开 surface；标记仍在 = 模型显式不压或逐字回退（可诊断）。 */
function logPayload(i: number): string {
  const marker = `L2MARK${i}X${(i * 7919) % 10000}`
  const lines: string[] = []
  for (let n = 0; n < 48; n++) {
    const extra = n === 24 ? ` marker=${marker}` : ''
    lines.push(`2026-10-25T12:${String(i).padStart(2, '0')}:${String(n).padStart(2, '0')} INFO [worker-${i}] batch=${i}${n} tokens=${137 + n * 7} status=ok${extra}`)
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// L1. 单轮端到端契约：真实决策必须解析成功，会话不破
// ---------------------------------------------------------------------------

test('L1: 真实模型决策——解析零失败、无 error、轮 2 照常、事务括号配对', { skip: liveSkip || undefined, timeout: 360_000 }, async () => {
  const { ctx, adapter, engine, harness } = await makeLiveLoop()
  try {
    const agent = await harness.create(SessionId('int-live-l1'), { provider: 'a', model: 'm' } as never)
    const session = agent.session
    const compressor = compressorOf(engine)

    adapter.turnQueue.push('ok')
    say(agent, logPayload(1))
    await agent.whenIdle()
    await until(() => compressor.records.some(r => r.called), 180_000, '轮 1 idle prepare（真实 LLM 调用）记账')

    adapter.turnQueue.push('done')
    say(agent, 'continue')
    await agent.whenIdle()
    await until(() => adapter.turnQueue.length === 0, 30_000, '轮 2 完成')

    // 契约核心：真实输出过 extractJson + normalizeDecision，零解析失败、零调用错误
    assert.equal(compressor.records.filter(r => r.parseFailed === true).length, 0, '真实输出解析零失败（失败时 rawResponse 见诊断）\n' + describeRecords(compressor.records))
    assert.equal(compressor.records.filter(r => r.error !== undefined).length, 0, '压缩调用零 error\n' + describeRecords(compressor.records))
    assert.ok(adapter.compactionCalls.length >= 1, '至少一次真实 compaction HTTP 调用')
    assert.ok(adapter.compactionCalls.every(c => c.rawHead !== ''), '每次调用都有非空响应正文')
    // 会话不破：轮 2 真实完成（脚本队列消费完毕 + 无未捕获 error 事件）
    assert.ok(adapter.turnQueue.length === 0, '轮 2 已完成')
    // 若决策落地：事务括号配对
    const events = compactionEvents(session)
    assert.equal(events.filter(e => e.type === 'compaction/start').length, events.filter(e => e.type === 'compaction/end').length, '事务括号配对')
    console.log(`[L1] compaction calls=${adapter.compactionCalls.length} ms=${adapter.compactionCalls.map(c => c.ms).join(',')} transactions=${events.filter(e => e.type === 'compaction/end').length}`)
  } finally {
    await ctx.fiber.dispose()
  }
})

// ---------------------------------------------------------------------------
// L2. 五轮采样质量门：解析成功率、flush 事务数、surface 真实瘦身
// ---------------------------------------------------------------------------

test('L2: 五轮真实决策采样——解析 5/5、事务 ≥3、surface 瘦身、末轮提案不重压', { skip: liveSkip || undefined, timeout: 900_000 }, async () => {
  const { ctx, adapter, engine, harness } = await makeLiveLoop()
  try {
    const agent = await harness.create(SessionId('int-live-l2'), { provider: 'a', model: 'm' } as never)
    const session = agent.session
    const compressor = compressorOf(engine)
    const payloads = [1, 2, 3, 4, 5].map(i => logPayload(i))
    const totalPayloadChars = payloads.reduce((a, p) => a + p.length, 0)

    for (let i = 0; i < 5; i++) {
      const recordsBefore = compressor.records.length
      adapter.turnQueue.push('ok ' + i)
      say(agent, payloads[i])
      await agent.whenIdle()
      await until(() => compressor.records.length > recordsBefore, 180_000, `第 ${i + 1} 轮 idle prepare（真实 LLM 调用）记账`)
    }
    // 第六轮只驱动 flush：pre-step 冲走第 5 轮暂存提案
    adapter.turnQueue.push('final')
    say(agent, 'wrap up')
    await agent.whenIdle()
    await until(() => adapter.turnQueue.length === 0, 30_000, '第 6 轮完成')

    const records = compressor.records
    // 完成口径：决策/失败/错误任一落定才算完成（末轮提案断言时可能仍在飞）。
    const completed = records.filter(r => r.decision !== undefined || r.parseFailed === true || r.error !== undefined)
    const parsed = completed.filter(r => r.decision !== undefined && r.parseFailed !== true).length
    const actionable = completed.filter(r => {
      const d = r.decision as { splits?: { quotes?: string[]; infoLevel?: string; infoText?: string }[] } | undefined
      return (d?.splits ?? []).some(s => (s.quotes?.length ?? 0) > 0 || ((s.infoLevel === 'summary' || s.infoLevel === 'extract') && (s.infoText ?? '').length > 0))
    }).length
    const parseFailed = records.filter(r => r.parseFailed === true).length
    const errored = records.filter(r => r.error !== undefined).length
    const events = compactionEvents(session)
    const ends = events.filter(e => e.type === 'compaction/end' && e.error === undefined).length
    const starts = events.filter(e => e.type === 'compaction/start').length
    const endsAll = events.filter(e => e.type === 'compaction/end').length
    const surfaceText = [...session.surface.nodes].map(s => eventText(session, s)).join('\n')

    // 诊断先行（断言失败时决策内容可见）：每条决策的 split 形态与体积账
    const decisionLines = records.map(r => {
      const d = r.decision as { splits?: { seq?: number; quotes?: string[]; infoLevel?: string; infoText?: string }[]; tools?: unknown[] } | undefined
      if (d === undefined) return `  turn=${r.turn} <无决策> parseFailed=${r.parseFailed === true} error=${r.error ?? '-'}`
      const quoteChars = (d.splits ?? []).reduce((a, s) => a + (s.quotes ?? []).reduce((x, q) => x + q.length, 0), 0)
      const infoChars = (d.splits ?? []).reduce((a, s) => a + (s.infoText ?? '').length, 0)
      const levels = (d.splits ?? []).map(s => s.infoLevel ?? '-').join(',')
      return `  turn=${r.turn} splits=${d.splits?.length ?? 0} levels=[${levels}] quoteChars=${quoteChars} infoChars=${infoChars} tools=${d.tools?.length ?? 0}`
    })
    console.log(`[L2] calls=${adapter.compactionCalls.length} parsed=${parsed}/${records.length} transactions=${ends} surface=${surfaceText.length}/${totalPayloadChars} (${Math.round(surfaceText.length / totalPayloadChars * 100)}%) ms=[${adapter.compactionCalls.map(c => c.ms).join(',')}] finish=[${adapter.compactionCalls.map(c => c.finishReason).join(',')}]`)
    console.log('[L2] 决策形态：\n' + decisionLines.join('\n'))
    console.log('[L2] 原始响应头：\n' + adapter.compactionCalls.map((c, i) => `  #${i + 1}: ${c.rawHead.slice(0, 120).replace(/\n/g, '⏎')}`).join('\n'))
    const nodeBreakdown = [...session.surface.nodes].map(s => {
      const ev = session.snapshotEvents()[s]
      return { type: ev?.type ?? '?', len: eventText(session, s).length }
    })
    console.log('[L2] surface 节点：' + nodeBreakdown.map(n => `${n.type}:${n.len}`).join(' ') + ` 总=${nodeBreakdown.reduce((a, n) => a + n.len, 0)}`)

    assert.equal(parseFailed, 0, '五轮采样解析零失败\n' + describeRecords(records))
    assert.equal(errored, 0, '五轮采样零调用错误\n' + describeRecords(records))
    assert.ok(parsed >= 5, `完成采样解析成功数 ${parsed} ≥ 5\n` + describeRecords(records))
    assert.ok(actionable >= 1, `可落地决策 ${actionable} ≥ 1（模型至少一次给出完整契约字段——零服从 = 提示词契约断裂或模型不可用）\n` + describeRecords(records))
    assert.ok(ends >= 3, `成功 flush 事务 ${ends} ≥ 3（决策持续落地，不是空转）\n` + describeRecords(records))
    assert.equal(starts, endsAll, '事务括号配对')
    // 瘦身门：以「无压缩基线」为参照（system + 五轮载荷 + 助手回复余量），
    // 净瘦 ≥1000 字符——零有效压缩 ⇒ 红；具体瘦多少是模型服从率的遥测（console）不是断言。
    const systemLen = [...session.surface.nodes].reduce((a, s) => {
      const ev = session.snapshotEvents()[s]
      return ev?.type === 'system/message' ? a + eventText(session, s).length : a
    }, 0)
    const baseline = systemLen + totalPayloadChars + 200
    assert.ok(surfaceText.length < baseline - 1000, `surface 净瘦 ≥1000 字符：${surfaceText.length} < 基线 ${baseline}（无压缩口径）——零有效压缩`)
    assert.ok(adapter.turnQueue.length === 0, '全部 6 轮完成（会话健康）')
  } finally {
    await ctx.fiber.dispose()
  }
})
