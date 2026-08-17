/**
 * ARGP spike 1 探针引擎：最小 CompactionEngine——compactIfNeeded 空转 + 日志。
 * 不做任何剪枝，只记录 harness 何时以何种触发调用引擎，验证挂载与生命周期。
 * 自动注册方式仿 compaction-basic（引擎自挂 agent/pre-step 压力钩子）。
 */
import type { Context } from '@deepseek-ai/cordis';
import { CompactionEngine } from '@deepseek-ai/dsh-compaction';
import type { CompactionAgentContext, CompactionResult, CompactionTrigger, ManualCompactAgentContext } from '@deepseek-ai/dsh-compaction';
/** 一次引擎调用的观测记录。 */
export interface ProbeCall {
    at: string;
    method: 'compactIfNeeded' | 'compactNow' | 'compactRegion';
    trigger?: CompactionTrigger;
    surfaceNodes?: number;
    eventCount?: number;
}
/** 只观测、不剪枝的最小引擎。 */
export declare class ArgpProbeEngine extends CompactionEngine {
    /** 全部观测记录（spike 断言直接读这里）。 */
    readonly calls: ProbeCall[];
    constructor(ctx: Context);
    compactIfNeeded(agent: CompactionAgentContext, trigger: CompactionTrigger, _signal: AbortSignal): Promise<CompactionResult | null>;
    compactNow(agent: ManualCompactAgentContext, _signal: AbortSignal): Promise<CompactionResult | null>;
    compactRegion(_start: number, _end: number, _agent: CompactionAgentContext, _signal?: AbortSignal): Promise<CompactionResult>;
}
export default ArgpProbeEngine;
