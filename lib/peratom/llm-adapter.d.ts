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
/** agent 路由提示：AgentContext.options 的结构最小视图（provider/model）。 */
export interface AgentRouteHint {
    provider?: string;
    model?: string;
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
export declare function autoDshLlmSpec(ctx: Context, route: AgentRouteHint | null): DshLlmSpec | null;
/** 宿主是否挂了 llm 服务（自动兜底的前提之一；测试/诊断用）。 */
export declare function hostHasLlm(ctx: Context): boolean;
