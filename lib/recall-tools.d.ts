/**
 * 召回工具注册：三个 defineTool 闭包——`recall_pruned`（按 seq 召回原文，含版本链
 * 重定向）/ `list_pruned`（pruned 列表 + 区间模式原始日志扫描）/ `recall`（内容查询
 * 召回）。闭包经窄接口 RecallToolsHost 触达引擎（`this as unknown as
 * RecallToolsHost`，运行时同一实例，方法引用派发回 class 薄编排方法，this 绑定语义不变）。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Session } from '@deepseek-ai/dsh-session';
import type { SessionRuntimeState } from './session-state.js';
/**
 * 窄宿主接口：三个工具闭包实际触达的引擎成员（字段 + 方法引用）。
 * 方法引用（shadowedSeqsOf/noteRecallHit/budgetRecallText/recallQuery）经 host 派发
 * 到 class 上的薄编排方法，运行时 this 仍是引擎实例。
 */
export interface RecallToolsHost {
    /** 焦点回退（exec.agent.session 缺席时的兜底；单会话宿主语义不变）。 */
    session: Session | null;
    telemetryCap: number;
    /** 1.11.0-beta.0（1-1/1-2）：会话态分桶访问 + 方法显式带 session。 */
    stateOf: (session: Session) => SessionRuntimeState;
    shadowedSeqsOf: (session: Session) => Set<number>;
    noteRecallHit: (session: Session, seq: number) => void;
    budgetRecallText: (session: Session, text: string) => string;
    recallQuery: (session: Session, query: string, maxResults?: number) => string;
}
/**
 * 注册三个召回工具到 ctx.tools；register 顺序即工具在 ctx.tools 中的列出次序。
 */
export declare function registerRecallTools(ctx: Context, host: RecallToolsHost): void;
