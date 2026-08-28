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
 * 后端判定：`config.llm`（dsh-llm）优先于 endpoint/apiKey（fetch）；两者皆缺省时组件
 * 按 fetch 环境变量口径解析（既有行为不变）。
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm';
/**
 * 经宿主 dsh-llm 完成一次 one-shot 补全（hand-built 请求，不带 agent-loop 标记）。
 * 超时经 AbortSignal 传给运行时；text-delta 拼装正文，usage 块记账。
 */
export async function completeViaDshLlm(ctx, spec, prompt, timeoutMs) {
    const llm = ctx.llm;
    if (llm === undefined)
        throw new Error('dsh-llm backend: host has no llm service');
    const stream = llm.stream({
        provider: spec.provider,
        model: spec.model,
        messages: [createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } })],
        temperature: 0,
        purpose: 'compaction',
        signal: AbortSignal.timeout(timeoutMs),
    });
    let text = '';
    let usage;
    for await (const chunk of stream) {
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string')
            text += chunk.text;
        else if (chunk.type === 'usage' && chunk.usage !== undefined) {
            usage = { promptTokens: chunk.usage.inputTokens ?? 0, completionTokens: chunk.usage.outputTokens ?? 0 };
        }
    }
    return { text, usage };
}
