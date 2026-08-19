/**
 * ARGP recall 引擎（spike 3）：CompactionEngine 子类，挂载时注册
 *  - recall_pruned 工具：按被遮蔽 seq 从 append-only 日志找回被剪原文
 *  - argp-contract PromptSection：引用契约（占位内容必须 recall 而非编造）
 *
 * spike 3 设计妥协（记入注释）：session 由 harness 注入（闭包持有）——真实多 agent
 * 场景需按 scope 注册或从 exec.agent 取 session，M1 后再定。
 */
import { CompactionEngine } from '@deepseek-ai/dsh-compaction';
import type { CompactionResult, CompactionTrigger } from '@deepseek-ai/dsh-compaction';
import type { Session } from '@deepseek-ai/dsh-session';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { Context } from '@deepseek-ai/cordis';
import type { NodeState } from './log-access.js';
export interface RecallHandle {
    /** 注入/替换 recall 服务的 session（append-only 日志引用，剪枝后自动可见）。 */
    setSession(session: Session): void;
    /** 按被遮蔽 seq 找回原文；未命中返回 null。 */
    recall(seq: number): string | null;
}
export declare class ArgpRecallEngine extends CompactionEngine {
    static inject: string[];
    private session;
    readonly recallCalls: {
        seq: number;
        hit: boolean;
        state?: NodeState;
    }[];
    constructor(ctx: Context);
    setSession(session: Session): void;
    recall(seq: number): string | null;
    compactIfNeeded(_agent: Agent, _trigger: CompactionTrigger, _signal: AbortSignal): Promise<CompactionResult | null>;
    compactNow(_agent: Agent, _signal?: AbortSignal): Promise<CompactionResult | null>;
    compactRegion(): Promise<CompactionResult>;
}
export default ArgpRecallEngine;
