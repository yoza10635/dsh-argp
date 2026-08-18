/**
 * spike 24：cites 契约模板变体重放测试（prompt 工程诊断）
 *
 * 方法：从真实 50 轮产物提取 turn 1-3 消息序列（第一次压缩前），
 * 拼装为完整 chat 上下文，切换 6 个 cites 契约模板，逐个打 DeepSeek API。
 * 每版跑 3 次，统计 declared 数——3 次全 0 判无效（用户拍板规则）。
 *
 * 输出：每版 declared/attempts + 首个成功模板的完整回复。
 *
 * 用法：node spike/24-cites-replay.ts [--limit N] [--only <templateName>]
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { ensureDeepSeekApiKey } from './deepseek.ts'

const DATA = 'spike/out/06-tlong-deepseek-2026-08-16T12-37-15-811Z/events.jsonl'
const API = 'https://api.deepseek.com/chat/completions'

// ---------- 1. 从 events.jsonl 提取 turn 1-3 的 chat 消息 ----------
interface ChatMsg { role: 'system' | 'user' | 'assistant' | 'tool'; content: unknown; toolCallId?: string }

function extractMessages(): ChatMsg[] {
  const events = fs.readFileSync(DATA, 'utf8').split('\n')
    .filter(l => l.trim() !== '')
    .map(l => JSON.parse(l))
  const turns: Record<number, unknown[]> = {}
  let cur: number | null = null
  for (const e of events) {
    if (e.type === 'turn/start') { cur = e.data?.turn; turns[cur] = [] }
    else if (cur !== null && turns[cur] !== undefined) {
      turns[cur].push(e)
      if (e.type === 'turn/end') cur = null
    }
  }
  const out: ChatMsg[] = []
  for (const t of [1, 2, 3]) {
    for (const e of turns[t] ?? []) {
      const d = e.data ?? {}
      if (e.type === 'user/message') {
        const c = d.content
        const text = Array.isArray(c) ? c.map((b: { type?: string; text?: string }) => b.type === 'text' ? b.text ?? '' : '').join('\n') : String(c ?? '')
        if (text.trim() !== '') out.push({ role: 'user', content: text })
      } else if (e.type === 'assistant/message') {
        const c = d.message?.content ?? []
        // 合并同一步的 tool-call 与 text/reasoning
        const toolCalls: { id: string; name: string; arguments: string }[] = []
        const texts: string[] = []
        const reasonings: string[] = []
        for (const b of c) {
          if (b.type === 'tool-call') toolCalls.push({ id: b.id, name: b.name, arguments: b.arguments })
          else if (b.type === 'text') texts.push(b.text ?? '')
          else if (b.type === 'reasoning') reasonings.push(b.text ?? '')
        }
        // 工具调用消息：assistant 带 tool_calls（OpenAI 格式）
        if (toolCalls.length > 0) {
          out.push({ role: 'assistant', content: texts.length > 0 ? texts.join('\n') : null, toolCallId: undefined })
          out[out.length - 1].content = texts.length > 0 ? texts.join('\n') : ''
          // 补 tool_calls 字段——OpenAI 需要；DeepSeek 兼容
          ;(out[out.length - 1] as unknown as { toolCalls?: unknown[] }).toolCalls = toolCalls.map(tc => ({
            id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.arguments },
          }))
        } else if (texts.length > 0 || reasonings.length > 0) {
          // 纯文本回复：保留 text（reasoning 丢弃——replay 不需要思考链）
          const body = texts.join('\n').trim()
          if (body !== '') out.push({ role: 'assistant', content: body })
        }
      } else if (e.type === 'tool/result') {
        const c = d.message?.content ?? []
        const txt = c.map((b: { type?: string; content?: unknown }) => {
          if (b.type === 'tool-result') {
            const inner = (b.content ?? []) as { type?: string; text?: string }[]
            return inner.map(x => x.text ?? '').join('\n')
          }
          return ''
        }).join('\n').trim()
        if (txt !== '') out.push({ role: 'tool', content: txt, toolCallId: d.message?.source?.callId })
      }
    }
  }
  // 重放设计：截掉最后一条 assistant 纯文本回复（turn 3 的真实最终答复），
  // 让模型在 tool result 之后自己生成最终回复——测模板能否诱导 cites。
  while (out.length > 0 && out[out.length - 1].role === 'assistant') out.pop()
  // 同时保证最后一条是 tool（模型刚读完 chunk-2），符合"基于工具结果作答"场景。
  return out
}

// ---------- 1b. 放开 user 指令的 "nothing else"（根因修复后的重放序列） ----------
function extractMessagesRelaxed(): ChatMsg[] {
  const base = extractMessages()
  // 找到 turn 3 的 user 消息（含 "nothing else"），改写为允许附加 cites 块
  for (const m of base) {
    if (m.role === 'user' && typeof m.content === 'string' && m.content.includes('nothing else')) {
      m.content = m.content.replace(
        'reply with exactly one line and nothing else: the file name, a space, and its line count.',
        'reply with exactly one line: the file name, a space, and its line count. You may append the ARGP citation block after that line.',
      )
    }
  }
  return base
}

// ---------- 2. cites 契约模板变体 ----------
const CITES_TEMPLATES: Record<string, string> = {
  // V0：当前（基线）
  'V0-current': `Citation declaration (ARGP):
If your final reply used one or more earlier visible items, append ONE JSON block at the end of your final text, after your complete answer:
{"cites":["the gateway release passes. Neither","Here is the incident-window data"]}
- Each entry must copy verbatim the first 10-20 words of one earlier item you actually used.
- Only cite items you genuinely depended on. If none, omit the block entirely.
- The block belongs in the final reply body only, never in reasoning. Output nothing after it.`,

  // V1：默认开启 + 空数组兜底
  'V1-always': `Citation declaration (ARGP):
Append ONE JSON block to the END of every final reply, ALWAYS:
{"cites":["..."]}
- Cite every earlier item you reused, summarized, answered about, or built upon — including tool results you read.
- Each entry copies verbatim the first 10-20 words of that earlier item.
- Used nothing this turn? Write {"cites":[]} (valid, normal).
- The block goes in the final reply body, never in reasoning. Nothing after it.`,

  // V2：few-shot 场景化（读日志→引用）
  'V2-fewshot': `Citation declaration (ARGP):
Your reply is part of an ongoing reference graph. ALWAYS end your final reply with one JSON block:

{"cites":["..."]}

When to cite — include an entry for any earlier item you actually relied on:
- a tool result you read and answered from (e.g. read_file output)
- a user instruction you followed
- an earlier assistant claim you repeated or built upon

Example (you read a log file, then answer a question about it):
[user] Read logs/chunk-3.md and report the incident reference.
[assistant] Incident ref: INC-3-MARKER-9G2K
{"cites":["chunk 3 telemetry export — incident ref INC-3-MARKER-9G2K"]}

Rules:
- Each entry = verbatim first 10-20 words of the earlier item you used.
- Used nothing this turn? Write {"cites":[]}.
- Block goes in the final reply body, never in reasoning. Nothing after it.`,

  // V3：XML 结构化模板
  'V3-xml': `Citation declaration (ARGP):
Structure EVERY final reply as:
<answer>your plain-text answer</answer>
<cites>["verbatim first 10-20 words of each earlier item used", ...]</cites>
- <cites> lists every earlier user message, tool result, or prior assistant reply you relied on.
- No reliance this turn? <cites>[]</cites>.
- Never invent quotes; every entry must appear word-for-word in your visible context.
- Output nothing after </cites>.`,

  // V4：明示"读了工具结果就算引用"（针对 t-long 场景）
  'V4-toolresult': `Citation declaration (ARGP):
In this session you frequently read files with read_file and answer from their content. EVERY time your final reply is based on a tool result you read, you MUST cite it.

Append ONE JSON block to the end of your final reply:
{"cites":["..."]}
- When you answered from a file you read, cite that file's tool result: copy verbatim the first 10-20 words of its content.
- Cite user instructions you followed and earlier assistant claims you built upon too.
- If your reply used nothing from earlier items (rare here), write {"cites":[]}.
- The block goes in the final reply body, never in reasoning. Nothing after it.`,

  // V5：前置声明 + 极简格式（预填充思路）
  'V5-prefix': `ARGP citation protocol:
Every final reply MUST end with:
{"cites":[...]}
Rules:
1. The array lists each earlier context item (user message / tool result / prior reply) that your answer depends on.
2. Each entry: verbatim first 10-20 words of the item.
3. Reading a file and reporting from it = citing that tool result. Following an instruction = citing that user message.
4. No dependencies → {"cites":[]}.
5. Nothing after the block. Never put it in reasoning.`,

  // V6：V5 结构 + V4 的 tool-result 明确指向（融合）
  'V6-merge': `ARGP citation protocol:
Every final reply MUST end with:
{"cites":[...]}
Rules:
1. The array lists each earlier context item (user message / tool result / prior reply) that your answer depends on.
2. Each entry: verbatim first 10-20 words of the item.
3. In this session you read files with read_file and report from them. EVERY time your reply is based on a file you read, you MUST cite that file's tool result — copy verbatim the first 10-20 words of its content (the line starting with the telemetry header).
4. Also cite user instructions you followed and earlier assistant claims you built upon.
5. No dependencies → {"cites":[]}.
6. Nothing after the block. Never put it in reasoning.`,
}

// ---------- 3. 调用 DeepSeek ----------
async function callChat(system: string, history: ChatMsg[], attempt: number): Promise<{ text: string; declared: boolean }> {
  ensureDeepSeekApiKey()
  const key = process.env['DEEPSEEK_API_KEY'] as string
  const messages: unknown[] = [{ role: 'system', content: system }]
  for (const m of history) {
    if (m.role === 'assistant' && (m as unknown as { toolCalls?: unknown[] }).toolCalls !== undefined) {
      messages.push({
        role: 'assistant',
        content: (m.content as string) || null,
        tool_calls: (m as unknown as { toolCalls?: unknown[] }).toolCalls,
      })
    } else if (m.role === 'tool') {
      messages.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content })
    } else {
      messages.push({ role: m.role, content: m.content })
    }
  }
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(120_000),
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages,
      max_tokens: 200,
      stream: false,
    }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const body = (await res.json()) as { choices: { message: { content: string } }[] }
  const text = body.choices[0]?.message?.content ?? ''
  // 判定：输出非空 cites（[] 不算建边，只算"承认机制"）
  const empty = /cites"\]\s*:\s*\[\s*\]/.test(text)
  const nonEmpty = /cites/.test(text) && !empty
  return { text, declared: nonEmpty, blockPresent: /cites/.test(text), empty }
}

// ---------- 4. main ----------
async function run(): Promise<void> {
  const only = process.argv.find((_, i) => i > 1 && process.argv[i - 1] === '--only')
  const limitArg = process.argv.find((_, i) => i > 1 && process.argv[i - 1] === '--limit')
  const limit = limitArg !== undefined ? Number(limitArg) : 3

  const history = extractMessagesRelaxed()
  const baseSystem = `You are an AI agent powered by DeepSeek Harness.

spike-6 t-long archival persona

Context compression (ARGP):
Your conversation context is managed under a compression budget. Older parts of the conversation may be compressed or removed at any time.

Rules:
- Every reply must be self-contained plain text: state facts, conclusions, and content directly in natural language. Never answer by pointing at earlier context items instead of restating the needed content.
- Your visible context is a pruned view: earlier parts of the conversation may have been removed by compression, so absence from the visible context does not mean it was never said. When the user refers to something discussed earlier (values, instructions, facts) that you cannot find in the visible context, ALWAYS call the recall_pruned tool with the seq shown in the placeholder first — never conclude it was never provided without recalling.

`
  console.log(`history messages: ${history.length}`)
  for (const m of history.slice(-4)) {
    const c = typeof m.content === 'string' ? m.content.slice(0, 90) : JSON.stringify(m.content).slice(0, 90)
    console.log(`  ${m.role}: ${c}`)
  }

  const results: Record<string, { declared: number; attempts: number; samples: string[] }> = {}
  for (const [name, citesTemplate] of Object.entries(CITES_TEMPLATES)) {
    if (only !== undefined && name !== only) continue
    let declared = 0
    const samples: string[] = []
    for (let a = 1; a <= limit; a += 1) {
      try {
        const { text, declared: ok, blockPresent, empty } = await callChat(baseSystem + citesTemplate, history, a)
        if (ok) declared += 1
        if (samples.length < 1) samples.push(text.slice(0, 200).replace(/\n/g, ' '))
        const tag = ok ? 'NON-EMPTY ✅' : blockPresent ? `empty [] 🟡` : 'no-block ❌'
        console.log(`[${name}] attempt ${a}: ${tag} — ${text.slice(0, 80).replace(/\n/g, ' ')}`)
      } catch (err) {
        console.log(`[${name}] attempt ${a}: ERROR ${String(err).slice(0, 120)}`)
      }
    }
    results[name] = { declared, attempts: limit, samples }
    console.log(`[${name}] verdict: ${declared}/${limit} ${declared === 0 ? 'INVALID' : 'WORKS'}`)
  }

  // 汇总
  console.log('\n=== 汇总 ===')
  for (const [name, r] of Object.entries(results)) {
    console.log(`${name}: ${r.declared}/${r.attempts} ${r.declared === 0 ? '❌ 无效' : r.declared >= 2 ? '✅ 稳定' : '🟡 偶发'}`)
    if (r.declared > 0 && r.samples.length > 0) console.log(`   sample: ${r.samples[0]}`)
  }
}

void run()
