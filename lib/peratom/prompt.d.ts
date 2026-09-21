/**
 * PeratomCompressor Prompt 与 LLM 调用模块（P5 结构重构 Wave 3 第 5 步，C 报告 §4 B 表）。
 *
 * 从 1,520 行 `compressor.ts`（God Class）拆出的**Prompt / 后端选路**侧：
 *  - 规则前言（PROMPT_RULES，吸收 P0 三层对冲 + 已知债务 6 修正）；
 *  - 原子→prompt 组装（buildPrompt，纯函数）；
 *  - JSON Schema 强制输出契约（OUTPUT_SCHEMA）+ OpenAI 兼容 fetch（postChat，纯函数，
 *    失败降级裸 prompt）；
 *  - 后端选路（backend：显式 config.llm > fetch > 自动兜底，窄宿主接口）。
 *
 * 循环 import 规避（C 报告关键设计决策 1）：本模块**不** import compressor 运行时，
 * 仅 type-only import（编译期擦除，无运行时环）。buildPrompt / postChat 是纯函数
 * （只依赖入参）；backend 经窄接口 {@link PromptHost} 读三个后端字段。
 * 依赖方向：compressor-types（叶）← prompt ← flush ← compressor（组合根）。
 *
 * 行为逐字节不变：函数体逻辑逐字保留（this.x → host.x），仅 `this` 换 `host`。
 */
import type { DshLlmSpec } from './llm-adapter.js';
import type { CurrentTurnCollect, ResolvedEndpoint } from './compressor-types.js';
/**
 * 后端选路结果（§11.13.1）：dsh-llm 生产后端 / fetch 遗产路径 / null（disabled）。
 * 导出供 flush 模块的 FlushHost 与组合根引用。
 */
export type LlmBackend = {
    kind: 'dsh-llm';
    spec: DshLlmSpec;
} | {
    kind: 'fetch';
    endpoint: ResolvedEndpoint;
} | null;
/**
 * 后端选路窄宿主接口（C 报告关键设计决策 1）：只含 backend 所需成员。
 *  - `dshLlm`：显式 config.llm（优先）；
 *  - `endpoint`：fetch 遗产路径（endpoint/apiKey/env 解析）；
 *  - `autoLlm`：自动兜底（真会话里延迟解析 agent 路由）。
 */
export interface PromptHost {
    dshLlm: DshLlmSpec | null;
    endpoint: ResolvedEndpoint | null;
    autoLlm: DshLlmSpec | null;
}
export declare function buildPrompt(collect: CurrentTurnCollect): string;
/**
 * A 形态（设计文档 §4 tail-only 语义）：压缩调用站在 agent 链延长线上——
 * `[...agent 当前 deriveMessages() 的 wire 渲染, {user: 压缩指令}]`。
 *
 * ⚠️ 复用率实测（2026-09-19 record2 + .tmp/kv-a2-diag5 隔离实验，长历史）：
 * Qwen3 模板的 reasoning 渲染受"最后一条 user 位置"门控——末尾是 user 指令时，
 * 最后一条 user **之后**的 assistant reasoning 在 agent 上一发（P_last）里全渲染、
 * 在本请求里全剥离 ⇒ 前缀从该处起分叉。长历史（轮内 reasoning 多）实测 LCP 仅 30.3%
 * （pt:false）/ 12.7%（pt:true 反而更差：把 P_last 剥掉的跨轮 reasoning 又渲染回来）；
 * 短历史（turn1 末，reasoning 极少）才 ≈100%。⇒ **A 形态的真实复用率是历史长度依赖的**，
 * 此前"完全复用 / LCP=100%"的注释与结论均基于短历史假象，已作废。
 * 若要长历史下接近完全复用，需 A-4（尾部指令用 assistant 承载，实测 LCP=100%）
 * 或 A-3（前缀截断到最后一条 user，自身复用率 87.1%，compaction-basic 同款形态）。
 * 本函数在 A 形态下仍强制 `preserve_thinking:true`（维持既有行为），待形态拍板后统一调整。
 */
export declare function postChat(fetchImpl: typeof fetch, ep: ResolvedEndpoint, prompt: string, timeoutMs: number, useJsonSchema: boolean, chatTemplateKwargs?: Record<string, unknown>, 
/** A 形态前缀（serializeWireMessages 产物）；缺省 = C 形态独立 one-shot。 */
contextWire?: Record<string, unknown>[], 
/** A 形态 tools 透传（requestHeader().tools 的 wire 渲染）。 */
contextTools?: Record<string, unknown>[], 
/** 输出 cap（token）。压缩输出是 JSON plan，通常几百 token；设小 cap 给 prompt 让出 margin（防爆上限）。 */
maxCompletionTokens?: number): Promise<string>;
/**
 * 后端选路（§11.13.1）：显式 `config.llm` > fetch（endpoint/apiKey/env）> 自动兜底。
 * 三条都解不出返回 null —— 调用方按 disabled 记账（`no-endpoint`），不抛错、不阻断会话。
 */
export declare function backend(host: PromptHost): LlmBackend;
