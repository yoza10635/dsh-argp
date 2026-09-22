import type { Context } from '@deepseek-ai/cordis';
import type { Message, ToolSchema } from '@deepseek-ai/dsh-llm';
import type { Session } from '@deepseek-ai/dsh-session';
import type { AgentRouteHint, DshLlmSpec } from './llm-adapter.js';
import type { GateOptions } from './gate.js';
import type { CompressDecision, CompressRecord, CurrentTurnCollect } from './compressor-types.js';
import { type LlmBackend } from './prompt.js';
/**
 * 发射侧窄宿主接口（C 报告关键设计决策 1）：只含本模块所需成员。
 *  - 字段：records / telemetryCap（观测台账）、_calls（调用计数）、ctx（宿主日志）、
 *    fetchImpl / timeoutMs / maxCompletionTokens（fetch 后端）、pending（暂存事务）、
 *    hlsMode / hlsRoiThreshold（HLS 修复档）、inFlightPass / flushWaitMs（在飞 pass 屏障）、
 *    llmAutoEligible / autoLlm（自动兜底）、chatTemplateKwargs / prefixBudgetTokens（ctk / 预算）；
 *  - 方法：backend（→ prompt 模块）、gateOptions（类方法）、collectCurrentTurn /
 *    collectOpenTurn / advanceWaterMark（→ collect 模块）。
 */
export interface FlushHost {
    records: CompressRecord[];
    telemetryCap: number;
    _calls: number;
    ctx: Context;
    fetchImpl: typeof fetch;
    timeoutMs: number;
    maxCompletionTokens: number;
    pending: PendingEntry[];
    hlsMode: 'trailer' | 'off';
    hlsRoiThreshold: number;
    /** tool/result 压缩副本头部标记开关（v1.6.1）；生产由 PeratomCompressor 配置驱动。 */
    toolCopyMarker: boolean;
    inFlightPass: WeakMap<Session, Promise<unknown>>;
    flushWaitMs: number;
    llmAutoEligible: boolean;
    autoLlm: DshLlmSpec | null;
    chatTemplateKwargs: Record<string, unknown> | undefined;
    prefixBudgetTokens: number;
    backend: () => LlmBackend;
    gateOptions: () => GateOptions;
    collectCurrentTurn: (session: Session, afterSeq?: number) => CurrentTurnCollect | null;
    collectOpenTurn: (session: Session, afterSeq?: number) => CurrentTurnCollect | null;
    advanceWaterMark: (session: Session, turn: number, endSeq: number) => void;
}
export interface PendingEntry {
    session: Session;
    collect: CurrentTurnCollect;
    decision: CompressDecision;
    /** callAndStash 创建的观测记录；簿记直接写回此引用，不依赖 records 数组反查。 */
    record: CompressRecord;
}
/**
 * A 形态前缀快照（设计文档 §4 tail-only 语义的落地）：agent 当前
 * `deriveMessages()` + `requestHeader().tools` + 主链 ctk。
 *
 * 时序依据（2026-09-18/19 record 实测）：
 * - 轮边界触发（idle）：derive = 刚结束轮的全量，复用对象 = P_last / 下一轮第一发；
 * - 轮内触发（pre-step，P6）：derive = 进行到一半的 turn N，复用对象 = 紧随其后的
 *   step k+1 请求。两条路径共用本快照函数，前缀 = 触发时刻的 deriveMessages()。
 * 无 header 事件（会话首请求前）时 tools 缺省，消息前缀仍可用。
 */
export declare function buildContextPrefix(session: Session): {
    messages: Message[];
    tools?: ToolSchema[];
};
/**
 * 方案 B ctk（2026-09-19 定案，替代旧的"强制 pt:true"）：
 *   { enable_thinking:false, preserve_thinking:false, reasoning_effort:<主链同值?>, ...config 基础层 }
 * 三字段各自的理由：
 *  - `preserve_thinking:false`（方案 B 核心）：压缩请求末尾必是 user 指令 ⇒ 模板把
 *    last_query_index 推到末尾 ⇒ 历史轮内 reasoning 被剥 = **剥离态**。这恰好与
 *    "下一轮第一发 agent 请求"（末尾也是 user，同为剥离态）**同态** ⇒ 前缀逐 token
 *    一致（plan B 实测 LCP 99.4%）。强制 pt:true 反而把跨轮 reasoning 渲染回来，
 *    与参照不同态（LCP 12.7% < pt:false 30.3%）。
 *  - `enable_thinking:false`：压缩响应是 JSON plan，不烧 thinking（spike 33）。
 *  - `reasoning_effort`：与主链对齐（若声明了）——匹配主链的渲染 token 序列，
 *    跨模型可移植（不依赖 Qwen3 专属 pt 语义）。
 * 主链 reasoningEffort 取自最近 `request/header` 事件的 config（LlmCallConfig 无
 * chat_template_kwargs 字段，只有 reasoningEffort——故从它重建，非读现成 ctk）。
 */
export declare function resolveEffectiveCtk(host: FlushHost, session: Session): Record<string, unknown>;
/**
 * 前缀预算门控（防爆上限核心防线）：估算 A 形态请求的 prompt_tokens
 * = 最近一次真实 agent 请求的 billed input + 指令字符估算（/4，chars/4 对
 * 指令这种短文本偏安全）。usage 挂 assistant/message 事件的 data **顶层**
 * （agent-loop 落账实证 `{turn, step, message, usage, stream}`，读
 * `data.message.usage` 恒 undefined ⇒ A 形态会被静默全量降级 C）；billed
 * 口径 = inputTokens（未命中）+ cacheReadTokens + cacheWriteTokens，与引擎
 * 真实锚点同式——只算未命中会在高缓存命中率时大幅低估、漏放行超预算请求。
 * 超预算 ⇒ 返回 false，调用方**该次降级 C 形态**（丢前缀只发指令）——
 * "全前缀或无前缀"二元门控：截断前缀要么砍最近历史（质量最伤）要么 0 命中
 * 还比 C 贵（被支配）。无 usage 可参照（会话头）⇒ 保守返回 false（降级 C）。
 */
export declare function prefixWithinBudget(host: FlushHost, session: Session, promptChars: number): boolean;
export declare function callAndStash(host: FlushHost, session: Session, collect: CurrentTurnCollect): Promise<CompressRecord>;
/** idle 触发段：记账防重 → 收集 → 门控 → LLM → 暂存待发射。返回观测记录。 */
export declare function prepareCurrentTurn(host: FlushHost, session: Session): Promise<CompressRecord | null>;
/** 发射段：把该 session 的全部就绪事务落入下一次 open-turn 窗口（同步追加，吞错记账）。 */
export declare function flushStashed(host: FlushHost, session: Session): void;
/** 公开入口（P4 溢出三步路径② / 单测）：立即收集+调用+发射，绕过两段式延迟。 */
export declare function compressCurrentTurn(host: FlushHost, session: Session): Promise<CompressRecord | null>;
/**
 * 公开入口（P4 溢出三步路径② 生产接线）：对当前 open turn 立即收集+调用+发射。
 * 溢出发生在 open turn 的请求上，第②步必须压它而不是最新闭合轮（设计 §8
 * 「对当前轮大原子降熵」；closed 口径会错压上一轮，2026-08-29 review 中项）。
 * 水位语义（2026-09-21 修订）：open turn 压缩后**只推进该轮水位**（= 本次窗口 endSeq），
 * 该轮闭合时 idle prepare 仍会跑，但只收水位之后的新增原子（原先的"轮级一次性"
 * 记账会让轮内 pass 吃掉轮末 pass，使该轮尾部永不入压）。
 */
export declare function compressOpenTurn(host: FlushHost, session: Session): Promise<CompressRecord | null>;
/** 共享压缩尾部：中断/无候选短路（不推进水位）+ callAndStash + 立即 flush（成功才推进水位）。 */
export declare function compressCollect(host: FlushHost, session: Session, collect: CurrentTurnCollect | null): Promise<CompressRecord | null>;
export declare function flushEntry(host: FlushHost, session: Session, collect: CurrentTurnCollect, decision: CompressDecision, record: CompressRecord): void;
/**
 * 有界等待在飞的轮末 pass（见 `PeratomCompressorConfig.flushWaitMs`）。
 * 取走屏障（同一批 pass 只在首个 pre-step 等一次）；超时/失败都不抛——宁可放行让
 * 事务顺延到后续窗口，也不把用户这一轮卡死。
 */
export declare function awaitInFlightPass(host: FlushHost, session: Session): Promise<void>;
/**
 * 记住 agent 路由（§11.13.1 自动兜底）。构造期拿不到路由，只能在真会话的
 * `agent/status` / `agent/pre-step` 钩子里现取。非自动模式直接短路。
 */
export declare function rememberRoute(host: FlushHost, agent: {
    options?: AgentRouteHint;
} | undefined): void;
