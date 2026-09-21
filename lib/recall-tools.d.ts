/**
 * 召回工具注册（P5 Wave 3 第 4 步，C 报告 S1 + §4 蓝图 A：recall-tools 模块）。
 *
 * 从 hub `argp-graph-engine.ts` 构造器迁出的三个 defineTool 闭包：
 * `recall_pruned`（按 seq 召回原文，含版本链重定向）/ `list_pruned`（pruned 列表 +
 * 区间模式原始日志扫描）/ `recall`（内容查询召回）。闭包体逐字保留，仅 `this.x` →
 * `host.x`（窄接口 + `this as unknown as RecallToolsHost` 调用，编译期类型、运行时
 * 同一实例，方法引用经 host 派发回 class 薄编排方法，this 绑定语义不变）。
 *
 * 构造器侧副作用顺序不变：本函数在构造器原位置被调用，三个
 * `ctx.tools.register(...)` 的先后次序与原先逐字一致。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Session } from '@deepseek-ai/dsh-session';
import type { NodeState } from './log-access.js';
import type { PrunedNodeInfo } from './prune-selection.js';
/**
 * 窄宿主接口：三个工具闭包实际触达的引擎成员（字段 + 方法引用）。
 * 方法引用（shadowedSeqsOf/noteRecallHit/budgetRecallText/recallQuery）经 host 派发
 * 到 class 上的薄编排方法，运行时 this 仍是引擎实例——与原先闭包内 `this.method(...)`
 * 完全一致。
 */
export interface RecallToolsHost {
    session: Session | null;
    recallCallsThisTurn: number;
    recallCalls: {
        seq: number;
        hit: boolean;
        state?: NodeState;
    }[];
    telemetryCap: number;
    prunedNodeIndex: Map<number, PrunedNodeInfo>;
    recallSourceSeq: number;
    recallResultSeq: number;
    shadowedSeqsOf: (session: Session) => Set<number>;
    noteRecallHit: (seq: number) => void;
    budgetRecallText: (text: string) => string;
    recallQuery: (query: string, maxResults?: number) => string;
}
/**
 * 注册三个召回工具到 ctx.tools。构造器在原先内联定义工具的位置调用本函数，
 * 保持 register 调用顺序逐字不变。
 */
export declare function registerRecallTools(ctx: Context, host: RecallToolsHost): void;
