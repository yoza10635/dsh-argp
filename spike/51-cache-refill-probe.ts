/**
 * 压缩前后前缀缓存实测探针（2026-11-27，一次性 spike，不进测试门）。
 *
 * 目的：把「压缩后首请求整条重灌、次发恢复」从首字延迟推断变成 provider usage 读数，
 * 并回答一个只有实测能回答的问题——**同一次压缩之后的续作是否还有第二次全量重灌**
 * （若有，说明目录/系统段仍在抖前缀，而不是压缩本身的代价）。
 *
 * 做法：真 agent loop + 真 HTTP（本机 Qwen 端点），历史用**伪造事件**铺（多轮大段散文），
 * 压缩走 manual compactNow（factor 全量剪 + 散文浓缩真 LLM）。每次模型请求的 usage 被
 * `cache-audit` 落进会话桶，本脚本只负责打印成表。
 *
 * ⚠️ 伪造的 `tool/result` **不会进 loop 派生的 wire**（实测：剪掉 12 万字符，请求 prompt
 * 一点没变），所以想测「剪枝把前缀打断」必须用散文浓缩路径——它是唯一真正改写请求前缀的
 * 压缩动作。
 *
 * 运行：node --import ./scripts/ts-import-rewrite-loader.mjs spike/51-cache-refill-probe.ts
 *
 * ## 实测结果（2026-11-27，本机 Qwen3.8-Flash-Next，真 usage）
 *
 * 12 轮散文（≈19 万字符）→ 手动 compactNow（散文浓缩）：
 *
 * ```
 *   turn1  prompt=117,424  cached=0       (0%)    冷启
 *   turn2  prompt=117,453  cached=116,736 (99%)   稳态
 *   ── 压缩：1 区间 / 23 节点 / 190,536→3,229 字符 ──
 *   摘要调用 prompt=118,173  cached=0      33.3s  ← 旧 A 形态，全额未命中
 *   turn3  prompt=979      cached=0       (0%)    压缩后首请求（保留段仅 979 ⇒ 重灌很便宜）
 *   turn4  prompt=1,011    cached=0       (0%)    块粒度未达（该端点 2048/块）
 * ```
 *
 * 三条结论：
 *  1. **压缩后重灌的代价 = 保留段规模**，不是固定值。释放 99% 时首请求只 prefill 979
 *     token；真实 239K 保留段的 47s 首字同理来自"保留了 239K"。
 *  2. **（修复前形态的读数）手动 compact 的摘要调用是全额未命中重发**：当时它走
 *     `callLlm`（旧 A 形态，重建 U:/A: transcript），与热前缀从头部就不同。该形态已改为
 *     `form:'host'`（`buildCtxInput` 宿主同款装配），同一请求实测 116,736/118,135 命中
 *     （98.8% / 14.0s）；本表的 118,173 / 0% / 33.3s 只作为对照保留。
 *  3. **缓存按块命中**（实测值全为 2048 的倍数）⇒ 小 prompt 的 0 命中不能当"失配"，
 *     `cache-audit` 的告警门槛据此定在 8K。
 */
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { AgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter, createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ArgpEngine } from '../src/argp-engine.ts'
import { serializeWireMessages } from '../src/llm/llm-adapter.ts'
import type { RequestCacheSample } from '../src/cache-audit.ts'

const BASE = process.env['ARGP_ITEST_LLM'] ?? 'http://127.0.0.1:1234/v1'
const MODEL = process.env['ARGP_ITEST_MODEL'] ?? 'Qwen3.8-Flash-Next'
/** 声明窗（引擎算账用；端点真实窗 524288，探针只关心缓存，不需要真墙）。 */
const DECLARED_WINDOW = 60_000

interface CallLog { purpose: string; ms: number; prompt: number; cached: number; completion: number }

class LiveAdapter extends LlmAdapter {
  readonly calls: CallLog[] = []
  readonly base: string
  readonly model: string
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
    console.log('[wire ' + purpose + '] msgs=' + wire.length + ' chars=' + JSON.stringify(wire).length
      + ' roles=' + wire.map(m => m['role']).join(','))
    if (purpose === 'compaction') console.log('[wire compaction head] ' + JSON.stringify(wire.slice(0, 2)).slice(0, 400))
    const started = Date.now()
    const res = await fetch(this.base.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages: wire,
        temperature: 0,
        ...(options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
        stream: false,
      }),
      signal: (options as { signal?: AbortSignal }).signal,
    })
    const body = await res.json() as {
      choices?: { message?: { content?: string | null } }[]
      usage?: {
        prompt_tokens?: number; completion_tokens?: number
        prompt_tokens_details?: { cached_tokens?: number }
      }
    }
    if (!res.ok) throw new Error('live llm HTTP ' + res.status + ': ' + JSON.stringify(body).slice(0, 2000))
    const text = body.choices?.[0]?.message?.content ?? ''
    const prompt = body.usage?.prompt_tokens ?? 0
    const cached = body.usage?.prompt_tokens_details?.cached_tokens ?? 0
    const completion = body.usage?.completion_tokens ?? 0
    this.calls.push({ purpose, ms: Date.now() - started, prompt, cached, completion })
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
    return { provider, id: model, name: 'probe model', context: { contextWindow: DECLARED_WINDOW } }
  }
}

function logBlock(tag: string, lines: number): string {
  const out: string[] = []
  for (let n = 0; n < lines; n++) {
    out.push(`2026-11-27T10:${String(n).padStart(2, '0')} INFO [${tag}] job=${n} pid=${1000 + n} status=ok bytes=${2048 + n * 37} tick=${n}`)
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
  throw new Error('等待超时：' + what)
}

/** 伪造一段「工具调用 + 大结果」历史（贴 document 标签 ⇒ 可被 factor 剪）。 */
function seedToolHistory(session: Session, file: string, text: string, turn: number): void {
  const callId = 'call_' + turn
  session.append('assistant/message', {
    turn, step: 1,
    message: createAssistantMessage({
      source: { provider: 'probe', model: MODEL },
      content: [
        { type: 'text', text: 'reading ' + file },
        { type: 'tool-call', id: callId, name: 'read', arguments: JSON.stringify({ file_path: file }) } as never,
      ],
    }),
  } as never, { surfaceOp: 'append' })
  session.append('tool/call', { turn, callId, name: 'read', arguments: JSON.stringify({ file_path: file }) } as never)
  session.append('tool/result', {
    turn, step: 1,
    message: {
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }], isError: false }],
      source: { kind: 'tool', callId },
      id: 'm_' + callId,
    },
  } as never, { surfaceOp: 'append' })
}

function fmt(s: RequestCacheSample): string {
  const pct = Math.round(s.hitRatio * 100)
  return `turn=${s.turn ?? '?'} step=${s.step ?? '?'} prompt=${s.promptTokens} cached=${s.cachedTokens} (${pct}%)`
    + (s.compactionId === null ? '' : ` tx=${s.compactionId} +${s.sinceCompactionMs}ms` + (s.firstAfterCompaction ? ' FIRST' : ''))
}

const ctx = new Context()
await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: 'cache refill probe. Reply with one short sentence; no lists.' } })
const adapter = new LiveAdapter(BASE, MODEL)
;(ctx.get('llm') as unknown as { registerAdapter(p: string[], a: LlmAdapter): unknown }).registerAdapter(['a'], adapter)
await ctx.plugin(ArgpEngine, { engine: 'factor', windowTokens: DECLARED_WINDOW, retainTokens: 40_000, recencyGuard: 0 })
const engine = ctx.compaction as ArgpEngine
const harness: AgentLoopTestHarness = await mountAgentLoopTestHarness(ctx)
const agent = await harness.create(SessionId('cache-refill-probe'), { provider: 'a', model: 'm' } as never)
const session = agent.session
const stateOf = (engine as unknown as { stateOf(s: Session): { cacheSamples: RequestCacheSample[]; lastCompaction: unknown } }).stateOf.bind(engine)

// 1) 铺垫：多轮大段散文（U/A 各一份）——压缩走散文浓缩，检查点会**替换掉早期正文**，
//    这是唯一能真正改变请求前缀的路径（伪造的 tool/result 不在 loop 派生的 wire 里，
//    剪它们不改变请求，测不出重灌）。
const seedTurns = 12
for (let t = 1; t <= seedTurns; t++) {
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `Turn ${t}: here is the build log batch, keep going.
` + logBlock('prose-' + t, 200) }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn: t, step: 1,
    message: createAssistantMessage({
      source: { provider: 'probe', model: MODEL },
      content: [{ type: 'text', text: `Turn ${t}: batch ${t} looks like routine build output; no fatal errors in this batch.` }],
    }),
  } as never, { surfaceOp: 'append' })
}

// 2) 压缩前两发（稳态对照）：第二发应命中缓存。
say(agent, 'continue')
await agent.whenIdle()
say(agent, 'continue again')
await agent.whenIdle()
await until(() => stateOf(session).cacheSamples.length >= 2, 120_000, '压缩前两次请求的 usage')

const before = stateOf(session).cacheSamples.slice()

// 3) 手动压缩（factor 全量剪 + 散文浓缩真 LLM）。
const pre = stateOf(session) as unknown as { records: { intervals: unknown[]; shadowedSeqs: unknown[]; charsBefore: number; charsAfter: number }[] }
const result = await engine.compactNow(agent as never, new AbortController().signal)
const rec = pre.records[pre.records.length - 1]
console.log('[probe] compactNow →', result === null ? 'null（未发射）' : result.compactionId)
console.log('[probe] last prune record:', rec === undefined ? 'none'
  : `${rec.intervals.length} ranges / ${rec.shadowedSeqs.length} nodes / ${rec.charsBefore}→${rec.charsAfter} chars`)
if (result !== null) {
  const text = (result.summary ?? []).map(b => (b as { type?: string; text?: string }).text ?? '').join('')
  console.log('[probe] summary head:', text.slice(0, 1600))
}
const contextText = (engine as unknown as { vocabularyContextText(s: Session): string }).vocabularyContextText(session)
console.log('[probe] vocabulary context chars:', contextText.length, contextText === '' ? '(empty)' : '(non-empty)')

// 4) 压缩后两发：首发应重灌，次发应恢复。
say(agent, 'continue after compaction')
await agent.whenIdle()
say(agent, 'one more')
await agent.whenIdle()
await until(() => stateOf(session).cacheSamples.length >= before.length + 2, 180_000, '压缩后两次请求的 usage')

const all = stateOf(session).cacheSamples
console.log('')
console.log('[probe] 请求级缓存读数（provider usage，prompt 含 hit+miss）')
console.log('  #  before-compaction')
for (const s of before) console.log('   · ' + fmt(s))
console.log('  #  after-compaction')
for (const s of all.slice(before.length)) console.log('   · ' + fmt(s))
console.log('')
console.log('[probe] 原始 HTTP 调用（含摘要调用）')
for (const c of adapter.calls) {
  console.log(`   · ${c.purpose} ${c.ms}ms prompt=${c.prompt} cached=${c.cached} out=${c.completion}`)
}

await ctx.fiber.dispose()
