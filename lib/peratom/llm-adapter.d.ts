import type { Context } from '@deepseek-ai/cordis';
/** dsh-llm 后端规格：宿主 LlmRuntime 的 provider 路由 + model。 */
export interface DshLlmSpec {
    provider: string;
    model: string;
}
export interface PeratomLlmUsage {
    promptTokens: number;
    completionTokens: number;
}
export interface PeratomLlmResult {
    text: string;
    usage?: PeratomLlmUsage;
}
/**
 * 经宿主 dsh-llm 完成一次 one-shot 补全（hand-built 请求，不带 agent-loop 标记）。
 * 超时经 AbortSignal 传给运行时；text-delta 拼装正文，usage 块记账。
 */
export declare function completeViaDshLlm(ctx: Context, spec: DshLlmSpec, prompt: string, timeoutMs: number): Promise<PeratomLlmResult>;
