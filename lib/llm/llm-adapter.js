/**
 * 散文浓缩的 LLM 调用后端（dsh-llm 宿主适配器）。
 *
 * 2.0 起只有一条生产通路：`ctx.llm.stream()`（LlmRuntime，`purpose: 'compaction'`
 * 归类为辅助调用）。1.x 的 fetch/OpenAI 兼容直连、`response_format` 强约束与
 * compressor/declarer 多模型分工随图引擎一并退役——不要再按旧头注去找它们。
 *
 * 后端解析（`autoDshLlmSpec`）：真会话里从 `agent.options` 取 provider/model + 宿主
 * `ctx.llm`，两者齐备才解析；缺一即组件 disabled（零网络）。
 *
 * 终态语义（宿主契约 `llm/llm/src/types.ts`）：适配器抛错、超时、取消、provider 报错
 * 都由 `LlmRuntime.stream()` 归一成**终态 `finish` chunk**，不向调用方抛异常。本适配器
 * 把 `finish.reason` 原样带回（`PeratomLlmResult.finish`），由调用方区分
 * stop / max-tokens / tool-calls / error / aborted；丢掉它等于把这几种情形塌缩成同一条
 * “空摘要”警告。
 *
 * `serializeWireMessages`：**仅测试/探针**的 wire 等价性 oracle（生产零调用点），用于把
 * 宿主 agent-loop 的渲染与本地序列化逐字节对齐；`ARGP_PERATOM_A2_DEBUG` 门控的 dump
 * 也只存在于该 oracle 内。
 */
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
/** 解析宿主 llm 服务。真宿主 cordis 对属性访问做 inject 检查（2026-08-28 联调实测：
 *  "cannot get property llm without inject"），`ctx.get(name)` 官方语义即免 inject 读取；
 *  属性访问保留在前，兼容测试替身的直接赋值（loose ctx）。 */
function resolveLlmRuntime(ctx) {
    try {
        const direct = ctx.llm;
        if (direct !== undefined)
            return direct;
    }
    catch { /* strict ctx: property access requires inject — fall through */ }
    try {
        return ctx.get?.('llm');
    }
    catch {
        return undefined;
    }
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
export async function completeViaDshLlm(ctx, spec, prompt, timeoutMs, contextMessages, contextTools, signal, maxTokens, reasoningEffort) {
    const llm = resolveLlmRuntime(ctx);
    if (llm === undefined)
        throw new Error('dsh-llm backend: host has no llm service');
    const instr = createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } });
    const messages = contextMessages !== undefined ? [...contextMessages, instr] : [instr];
    ctx.logger.info(`[argp-peratom] dsh-llm call: provider=${spec.provider} model=${spec.model} prompt=${prompt.length} chars prefix=${contextMessages?.length ?? 0} msgs`);
    const stream = llm.stream({
        provider: spec.provider,
        model: spec.model,
        messages,
        ...(contextTools !== undefined && contextTools.length > 0 ? { tools: [...contextTools] } : {}),
        temperature: 0,
        // 输出 cap（默认 16384 tok）——此前 dsh-llm 路径不传 maxTokens，
        // 思考型模型可无限输出 reasoning 烧穿压缩调用预算（fetch 路径早有 maxCompletionTokens，
        // 双后端不对称）。completeViaDshLlm 新增可选 maxTokens 参数，调用方传 peratom 配置值。
        ...(maxTokens !== undefined ? { maxTokens } : {}),
        ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
        purpose: 'compaction',
        // 外部取消与超时合并——任一触发即断流（abort 优先透传给调用方）。
        signal: signal === undefined ? AbortSignal.timeout(timeoutMs) : AbortSignal.any([AbortSignal.timeout(timeoutMs), signal]),
    });
    let text = '';
    let usage;
    let finish;
    let chunks = 0;
    try {
        for await (const chunk of stream) {
            chunks += 1;
            if (chunk.type === 'text-delta' && typeof chunk.text === 'string')
                text += chunk.text;
            else if (chunk.type === 'usage' && chunk.usage !== undefined) {
                usage = {
                    promptTokens: chunk.usage.inputTokens ?? 0,
                    completionTokens: chunk.usage.outputTokens ?? 0,
                    ...(chunk.usage.cacheReadTokens !== undefined ? { cacheReadTokens: chunk.usage.cacheReadTokens } : {}),
                };
            }
            else if (chunk.type === 'finish') {
                const kind = chunk.reason?.kind;
                if (typeof kind === 'string' && kind !== '') {
                    const message = chunk.reason?.failure?.message;
                    finish = { kind, ...(typeof message === 'string' && message !== '' ? { failure: message } : {}) };
                }
            }
        }
    }
    finally {
        ctx.logger.info(`[argp-peratom] dsh-llm done: chunks=${chunks} text=${text.length} chars`
            + ` usage=${usage !== undefined ? 'yes' : 'no'} finish=${finish?.kind ?? '-'}`);
    }
    return { text, usage, ...(finish !== undefined ? { finish } : {}) };
}
export function classifyLlmFinish(finish) {
    if (finish === undefined)
        return { kind: 'ok' };
    const withFailure = (kind) => finish.failure !== undefined ? { kind, failure: finish.failure } : { kind };
    switch (finish.kind) {
        case 'stop': return { kind: 'ok' };
        case 'max-tokens': return { kind: 'truncated' };
        case 'tool-calls': return { kind: 'tool-calls' };
        case 'aborted': return withFailure('aborted');
        case 'error': return withFailure('error');
        // merge-extensible：适配器可扩展 kind。未知 kind 不判死——若同时没有正文，
        // 由调用方的空输出闸兜底并留下计数，而不是在这里假装成功或假装失败。
        default: return { kind: 'ok' };
    }
}
/**
 * 宿主路由自动兜底（2026-09-17，规格 §11.13.1）。
 *
 * 背景：散文浓缩的 LLM 后端若只认写死的 provider+model（bundle/profile patch）
 * 或 fetch 环境变量，两者缺省时浓缩直接 disabled，且宿主换模型要改配置。
 *
 * 本函数把后端解析从"构造期一次性"改成"**延迟 + 跟随宿主**"：在真会话里从
 * `agent.options` 现取路由，配合宿主 `ctx.llm` 服务（LlmRuntime）解析出 spec。
 * 判定从严，任一条件不成立即返回 null（组件保持 disabled、零网络，与既有行为一致）：
 *   ① provider 与 model 都非空；
 *   ② 宿主确实挂了 llm 服务（`resolveLlmRuntime` 能取到）。
 *
 * 首版 peratom 管线还接受显式 config/fetch 优先序；2.0 的散文浓缩只走本兜底。
 */
export function autoDshLlmSpec(ctx, route) {
    if (route === null)
        return null;
    const provider = route.provider;
    const model = route.model;
    if (provider === undefined || provider === '' || model === undefined || model === '')
        return null;
    if (resolveLlmRuntime(ctx) === undefined)
        return null;
    return { provider, model };
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
function flattenWireText(blocks) {
    const parts = [];
    for (const block of blocks) {
        if (block.type === 'text')
            parts.push(block.text);
        else if (block.type === 'reasoning')
            continue; // reasoning 走独立字段
        else if (block.type === 'tool-call')
            continue; // tool-call 走独立字段
        else
            parts.push(`[${block.type} omitted]`);
    }
    return parts.join('');
}
export function serializeWireMessages(messages, logger) {
    const wire = [];
    for (const message of messages) {
        if (message.role === 'system') {
            wire.push({ role: 'developer', content: flattenWireText(message.content) });
            continue;
        }
        if (message.role === 'assistant') {
            const text = flattenWireText(message.content);
            const reasoning = message.content
                .filter((b) => b.type === 'reasoning')
                .map(b => b.text)
                .join('');
            const toolCalls = message.content
                .filter((b) => b.type === 'tool-call')
                .map(b => ({ id: b.id, type: 'function', function: { name: b.name, arguments: b.arguments } }));
            const msg = {
                role: 'assistant',
                // record 真身：纯 tool-call 轮 content=null（pi-ai "no text → null"）
                content: text.length > 0 ? text : null,
            };
            if (reasoning.length > 0)
                msg['reasoning'] = reasoning;
            if (toolCalls.length > 0)
                msg['tool_calls'] = toolCalls;
            wire.push(msg);
            continue;
        }
        if (message.role === 'tool') {
            // V4：tool-result 是一等 role:'tool' 消息（不再内嵌 user 消息的 content 块），
            // 直接映射为 OpenAI tool wire 消息。
            wire.push({ role: 'tool', tool_call_id: message.toolCallId, content: flattenWireText(message.content) || '(no output)' });
            continue;
        }
        // user / developer 角色：纯文本成条（V4 无内嵌 tool-result）。
        const text = flattenWireText(message.content);
        if (text.length > 0)
            wire.push({ role: 'user', content: text });
    }
    // A 形态观测（2026-09-18 落地期）：序列化前后消息数差异 = tool-result 展开量；
    // reasoning 总量 = 前缀复用的承重变量（模板只在该字段非空时渲染 <think> 块）。
    const reasoningChars = wire
        .map(m => (typeof m.reasoning === 'string' ? m.reasoning.length : 0))
        .reduce((a, b) => a + b, 0);
    if ((wire.length !== messages.length || reasoningChars > 0) && logger !== undefined) {
        logger.debug(`[argp-peratom] wire-prefix: dsh=${messages.length} msgs → wire=${wire.length} msgs (tool-result 展开 ${wire.length - messages.length >= 0 ? wire.length - messages.length : 0}) reasoning=${reasoningChars} chars`);
    }
    // A-2 落地期诊断：env 门控 dump 序列化后的 A 前缀 wire，供与 agent 实际请求
    // 逐字节对齐（验证序列化器 = agent-loop 渲染）。生产默认关。
    // 数据责任（2026-09-21 P1.6）：wire 含完整用户消息历史（敏感上下文）。默认
    // （ARGP_PERATOM_A2_DEBUG 非空）只写**脱敏摘要**——消息数、每条 role+长度、整段
    // wire 的 sha256——不落正文；确需逐字节对齐的完整 wire 须显式开
    // ARGP_PERATOM_A2_DEBUG_FULL=1（数据责任见 SECURITY.md「已知限制」）。
    const dbgDir = process.env['ARGP_PERATOM_A2_DEBUG'];
    if (dbgDir !== undefined && dbgDir !== '') {
        try {
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            const file = `${dbgDir}/a-prefix-${stamp}.json`;
            const full = process.env['ARGP_PERATOM_A2_DEBUG_FULL'] === '1';
            const payload = full
                ? { messageCount: messages.length, wire }
                : {
                    messageCount: messages.length,
                    wireSha256: createHash('sha256').update(JSON.stringify(wire)).digest('hex'),
                    wire: wire.map(m => ({ role: m.role, length: JSON.stringify(m).length })),
                };
            writeFileSync(file, JSON.stringify(payload, null, 2));
            // 诊断 dump 确认行：env 门控（生产默认关），保留 console 直出（无 logger 依赖）。
            console.log(`[argp-peratom] a2-debug: dump → ${file} (${full ? 'FULL' : 'redacted'})`);
        }
        catch { /* 诊断失败不影响主流程 */ }
    }
    return wire;
}
