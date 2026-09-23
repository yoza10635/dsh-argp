/**
 * Per-atom 引擎 LLM 调用后端（P5 后债务清算：dsh-llm 生产适配器）。
 *
 * 两个后端：
 *  - 'dsh-llm'：走宿主 `ctx.llm`（LlmRuntime.stream）——生产形态。`purpose: 'compaction'`
 *    归类为辅助模型调用（GenerateOptions 词表原生支持）；注意 GenerateOptions 无
 *    response_format——schema 约束解码仅在 fetch 后端可用，此路径依赖 extractJson 兜底。
 *  - 'fetch'：OpenAI 兼容直连（spike 30/32 遗产：response_format schema 强制 + 被拒降级
 *    重试）——本地实验与无 dsh-llm 宿主的向后兼容形态，行为不变。
 *
 * 多模型分工：compressor / cite-declarer 各自 config 的 `llm` 可指向不同 provider/model
 *（compressor 跑 lite 档省成本；台账 D21 口径——lite 服从率未实测，不作为默认）。
 * 后端判定：`config.llm`（dsh-llm）优先于 endpoint/apiKey（fetch）；两者皆缺省时
 * 按 fetch 环境变量口径解析（既有行为不变）；环境变量也缺席时走**宿主路由自动兜底**
 * （`autoDshLlmSpec`：真会话里从 `agent.options` 取 provider/model + 宿主 `ctx.llm`，
 * 2026-09-17 §11.13.1）。三条路都解不出才让组件 disabled（零网络）。
 */
import { writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, Message, ToolSchema } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'

/** dsh-llm 后端规格：宿主 LlmRuntime 的 provider 路由 + model。 */
export interface DshLlmSpec {
  provider: string
  model: string
}

export interface PeratomLlmUsage {
  promptTokens: number
  completionTokens: number
}

export interface PeratomLlmResult {
  text: string
  usage?: PeratomLlmUsage
}

/** 宿主 llm 服务的结构化最小视图（便于测试替身；真身 = LlmRuntime）。 */
interface LlmRuntimeView {
  stream(options: {
    provider: string
    model: string
    messages: unknown[]
    temperature?: number
    maxTokens?: number
    signal?: AbortSignal
    purpose?: 'compaction' | 'session-title'
    /** A 形态前缀的 tools 透传（GenerateOptions.tools，真身支持）。 */
    tools?: unknown[]
  }): AsyncIterable<{ type: string; text?: string; usage?: { inputTokens?: number; outputTokens?: number } }>
}

/** 解析宿主 llm 服务。真宿主 cordis 对属性访问做 inject 检查（2026-08-28 联调实测：
 *  "cannot get property llm without inject"），`ctx.get(name)` 官方语义即免 inject 读取；
 *  属性访问保留在前，兼容测试替身的直接赋值（loose ctx）。 */
function resolveLlmRuntime(ctx: Context): LlmRuntimeView | undefined {
  try {
    const direct = (ctx as unknown as { llm?: LlmRuntimeView }).llm
    if (direct !== undefined) return direct
  } catch { /* strict ctx: property access requires inject — fall through */ }
  try {
    return (ctx as unknown as { get?: (name: string) => unknown }).get?.('llm') as LlmRuntimeView | undefined
  } catch { return undefined }
}

/**
 * 经宿主 dsh-llm 完成一次补全（hand-built 请求，不带 agent-loop 标记）。
 * 超时经 AbortSignal 传给运行时；text-delta 拼装正文，usage 块记账。
 *
 * A 形态（contextMessages 非空）：压缩指令作为尾部 user 消息拼在 agent 当前
 * `deriveMessages()` 前缀之后，tools 透传 `requestHeader().tools`——请求与
 * agent 上一发共享前缀，KV 块原地命中（设计文档 §4；ctk 须配
 * preserve_thinking:true，见 serializeWireMessages 头注）。
 */
export async function completeViaDshLlm(
  ctx: Context,
  spec: DshLlmSpec,
  prompt: string,
  timeoutMs: number,
  contextMessages?: readonly Message[],
  contextTools?: readonly ToolSchema[],
): Promise<PeratomLlmResult> {
  const llm = resolveLlmRuntime(ctx)
  if (llm === undefined) throw new Error('dsh-llm backend: host has no llm service')
  const instr = createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } })
  const messages = contextMessages !== undefined ? [...contextMessages, instr] : [instr]
  ctx.logger.info(`[argp-peratom] dsh-llm call: provider=${spec.provider} model=${spec.model} prompt=${prompt.length} chars prefix=${contextMessages?.length ?? 0} msgs`)
  const stream = llm.stream({
    provider: spec.provider,
    model: spec.model,
    messages,
    ...(contextTools !== undefined && contextTools.length > 0 ? { tools: [...contextTools] } : {}),
    temperature: 0,
    purpose: 'compaction',
    signal: AbortSignal.timeout(timeoutMs),
  })
  let text = ''
  let usage: PeratomLlmUsage | undefined
  let chunks = 0
  try {
    for await (const chunk of stream) {
      chunks += 1
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
      else if (chunk.type === 'usage' && chunk.usage !== undefined) {
        usage = { promptTokens: chunk.usage.inputTokens ?? 0, completionTokens: chunk.usage.outputTokens ?? 0 }
      }
    }
  } finally {
    ctx.logger.info(`[argp-peratom] dsh-llm done: chunks=${chunks} text=${text.length} chars usage=${usage !== undefined ? 'yes' : 'no'}`)
  }
  return { text, usage }
}

/** agent 路由提示：AgentContext.options 的结构最小视图（provider/model）。 */
export interface AgentRouteHint {
  provider?: string
  model?: string
}

/**
 * 宿主路由自动兜底（2026-09-17，规格 §11.13.1）。
 *
 * 背景：`peratom` 三管线的 LLM 后端原本只认 `config.llm`（要宿主在 bundle/profile
 * patch 里写死 provider+model）或 fetch 环境变量。两者都缺省时组件直接 disabled
 * ——于是"双引擎"在实际分发物里退化成单引擎（Stage-2 only），且宿主换模型要改配置。
 *
 * 本函数把后端解析从"构造期一次性"改成"**延迟 + 跟随宿主**"：在真会话里从
 * `agent.options` 现取路由，配合宿主 `ctx.llm` 服务（LlmRuntime）解析出 spec。
 * 判定从严，任一条件不成立即返回 null（组件保持 disabled、零网络，与既有行为一致）：
 *   ① provider 与 model 都非空；
 *   ② 宿主确实挂了 llm 服务（`resolveLlmRuntime` 能取到）。
 *
 * 优先序由调用方保证：显式 `config.llm` > fetch（endpoint/apiKey/env）> 本兜底。
 */
export function autoDshLlmSpec(ctx: Context, route: AgentRouteHint | null): DshLlmSpec | null {
  if (route === null) return null
  const provider = route.provider
  const model = route.model
  if (provider === undefined || provider === '' || model === undefined || model === '') return null
  if (resolveLlmRuntime(ctx) === undefined) return null
  return { provider, model }
}

/** 宿主是否挂了 llm 服务（自动兜底的前提之一；测试/诊断用）。 */
export function hostHasLlm(ctx: Context): boolean {
  return resolveLlmRuntime(ctx) !== undefined
}

// ---------------------------------------------------------------------------
// A 形态前缀序列化（compressor / cite-declarer 共用）
//
// A 形态（设计文档 §4"tail-only 替换 ⇒ 前缀全部命中"）：压缩调用站在 agent 链
// 延长线上——`session.deriveMessages()` + 尾部压缩指令。要让压缩请求的 token 序列
// 与 agent 上一发请求（P_last）的 KV 块逐 token 一致，wire 序列化必须与宿主
// agent-loop 的渲染（pi-ai openai-completions 路径）字节等价。
//
// 2026-09-18 模板行为定案（.tmp/kv-ctk-settle*.mjs 探针）：Qwen3 vLLM 模板
// 渲染 assistant reasoning 的条件 = `preserve_thinking ∈ {undefined, true}`
// **或** 该 assistant 位于最后一条 user 之后（`loop.index0 > last_query_index`）。
// 2026-09-19 record2 实测定量（.tmp/kv-a2-diag5）：A 形态末尾追加 user 指令会
// **把 last_query_index 推到末尾** ⇒ 原"轮内"reasoning 全部降级为"历史"被剥
// （pt:false 时 LCP 仅 30.3%）；pt:true 又把 P_last 剥掉的跨轮 reasoning 渲染
// 回来（LCP 仅 12.7%，更差）⇒ **ctk 救不了 A 形态，末尾 user 指令本身即分叉源**。
// 正确形态 = A-4：尾部指令用 **assistant** 承载（last_query_index 不变 ⇒ 渲染
// 与 P_last 逐 token 一致，实测 LCP=100%）。详见 memory 2026-09-18.md Request 11/12。
//
// wire 形状（record-requests 真身实测，P10）：
//   developer | { role:'developer', content:string }                    ← system 消息
//   user      | { role:'user', content:string }
//   assistant | { role:'assistant', content:string|null,
//               reasoning?:string, tool_calls?:[{id,type:'function',
//               function:{name,arguments:string}}] }
//   tool      | { role:'tool', content:string, tool_call_id:string }    ← V4 一等 tool 消息
// tools       | ToolSchema[] 原样透传（{type:'function', function:{...}}）
// ---------------------------------------------------------------------------

/** dsh-llm ContentBlock[] → 纯文本（text 块拼接；image/file 落占位文本）。 */
function flattenWireText(blocks: readonly ContentBlock[]): string {
  const parts: string[] = []
  for (const block of blocks) {
    if (block.type === 'text') parts.push(block.text)
    else if (block.type === 'reasoning') continue // reasoning 走独立字段
    else if (block.type === 'tool-call') continue // tool-call 走独立字段
    else parts.push(`[${block.type} omitted]`)
  }
  return parts.join('')
}

/**
 * dsh-llm `Message` → OpenAI wire 消息数组（与 pi-ai openai-completions 的
 * transformMessages + 请求体构造等价；reasoning 字段名实测为 `reasoning`——
 * 本 vLLM build 模板读 `message.reasoning`，record-requests 真身逐字核对）。
 * 深冻结的源消息只读不改；一条 dsh Message 可能展开为多条 wire 消息
 * （user 消息内嵌 tool-result 时）。
 */
/** 最小日志面（P4.1：wire 观测走宿主 logger，不再裸 console）。 */
export interface WireLogger {
  debug: (msg: string) => void
}

export function serializeWireMessages(messages: readonly Message[], logger?: WireLogger): Record<string, unknown>[] {
  const wire: Record<string, unknown>[] = []
  for (const message of messages) {
    if (message.role === 'system') {
      wire.push({ role: 'developer', content: flattenWireText(message.content) })
      continue
    }
    if (message.role === 'assistant') {
      const text = flattenWireText(message.content)
      const reasoning = message.content
        .filter((b): b is Extract<ContentBlock, { type: 'reasoning' }> => b.type === 'reasoning')
        .map(b => b.text)
        .join('')
      const toolCalls = message.content
        .filter((b): b is Extract<ContentBlock, { type: 'tool-call' }> => b.type === 'tool-call')
        .map(b => ({ id: b.id, type: 'function', function: { name: b.name, arguments: b.arguments } }))
      const msg: Record<string, unknown> = {
        role: 'assistant',
        // record 真身：纯 tool-call 轮 content=null（pi-ai "no text → null"）
        content: text.length > 0 ? text : null,
      }
      if (reasoning.length > 0) msg['reasoning'] = reasoning
      if (toolCalls.length > 0) msg['tool_calls'] = toolCalls
      wire.push(msg)
      continue
    }
    if (message.role === 'tool') {
      // V4：tool-result 是一等 role:'tool' 消息（不再内嵌 user 消息的 content 块），
      // 直接映射为 OpenAI tool wire 消息。
      wire.push({ role: 'tool', tool_call_id: message.toolCallId, content: flattenWireText(message.content) || '(no output)' })
      continue
    }
    // user / developer 角色：纯文本成条（V4 无内嵌 tool-result）。
    const text = flattenWireText(message.content)
    if (text.length > 0) wire.push({ role: 'user', content: text })
  }
  // A 形态观测（2026-09-18 落地期）：序列化前后消息数差异 = tool-result 展开量；
  // reasoning 总量 = 前缀复用的承重变量（模板只在该字段非空时渲染 <think> 块）。
  const reasoningChars = wire
    .map(m => (typeof (m as { reasoning?: unknown }).reasoning === 'string' ? (m as { reasoning: string }).reasoning.length : 0))
    .reduce((a, b) => a + b, 0)
  if ((wire.length !== messages.length || reasoningChars > 0) && logger !== undefined) {
    logger.debug(`[argp-peratom] wire-prefix: dsh=${messages.length} msgs → wire=${wire.length} msgs (tool-result 展开 ${wire.length - messages.length >= 0 ? wire.length - messages.length : 0}) reasoning=${reasoningChars} chars`)
  }
  // A-2 落地期诊断：env 门控 dump 序列化后的 A 前缀 wire，供与 agent 实际请求
  // 逐字节对齐（验证序列化器 = agent-loop 渲染）。生产默认关。
  // 数据责任（2026-09-21 P1.6）：wire 含完整用户消息历史（敏感上下文）。默认
  // （ARGP_PERATOM_A2_DEBUG 非空）只写**脱敏摘要**——消息数、每条 role+长度、整段
  // wire 的 sha256——不落正文；确需逐字节对齐的完整 wire 须显式开
  // ARGP_PERATOM_A2_DEBUG_FULL=1（数据责任见 SECURITY.md「已知限制」）。
  const dbgDir = process.env['ARGP_PERATOM_A2_DEBUG']
  if (dbgDir !== undefined && dbgDir !== '') {
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const file = `${dbgDir}/a-prefix-${stamp}.json`
      const full = process.env['ARGP_PERATOM_A2_DEBUG_FULL'] === '1'
      const payload = full
        ? { messageCount: messages.length, wire }
        : {
            messageCount: messages.length,
            wireSha256: createHash('sha256').update(JSON.stringify(wire)).digest('hex'),
            wire: wire.map(m => ({ role: m.role, length: JSON.stringify(m).length })),
          }
      writeFileSync(file, JSON.stringify(payload, null, 2))
      // 诊断 dump 确认行：env 门控（生产默认关），保留 console 直出（无 logger 依赖）。
      console.log(`[argp-peratom] a2-debug: dump → ${file} (${full ? 'FULL' : 'redacted'})`)
    } catch { /* 诊断失败不影响主流程 */ }
  }
  return wire
}

/**
 * dsh-llm `ToolSchema[]` → OpenAI wire tools。
 *
 * 🔴 必须与 pi-ai openai-completions 的 tools 序列化**逐字节一致**（tools 在 prompt
 * 头部，任何差异 → 整段前缀分叉 → KV 全废）。pi-ai 行为（constrained-sampling.js
 * + openai-completions.js 实测）：标准工具（无 constrainedSampling）
 * `resolveJsonSchemaStrictSampling` 返回 undefined → wire 带 **`strict: false`**、
 * `parameters` 原样透传（`getJsonSchemaToolParameters` 仅 strict===true 时改写）。
 * 字段序 = agent 真身 wire 实测序：name, description, parameters, strict。
 * （2026-09-18 A-2 落地实锤：漏掉 `strict` 使 LCP 从 100% 塌到 454。）
 */
export function serializeWireTools(tools: readonly ToolSchema[] | undefined): Record<string, unknown>[] | undefined {
  if (tools === undefined || tools.length === 0) return undefined
  return tools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      strict: false,
    },
  }))
}
