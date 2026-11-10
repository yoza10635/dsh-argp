/**
 * 召回工具注册：三个 defineTool 闭包——`recall_pruned`（按 seq 召回原文，含版本链
 * 重定向）/ `list_pruned`（pruned 列表 + 区间模式原始日志扫描）/ `recall`（内容查询
 * 召回）。闭包经窄接口 RecallToolsHost 触达引擎（`this as unknown as
 * RecallToolsHost`，运行时同一实例，方法引用派发回 class 薄编排方法，this 绑定语义不变）。
 *
 * `sessionOfToolCall` 与 `RECALL_CALLS_PER_TURN_LIMIT` 同时是 factor 臂召回面
 * （factor/recall-labels.ts）的单点复用——会话解析与防循环安全阀双臂不得各写一份。
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
    /** 引擎累计绑定过的不同会话数（多会话回退拒绝判据；ArgpGraphEngine.sessionCount）。 */
    sessionCount: () => number;
    /** 1.11.0-beta.0（1-1/1-2）：会话态分桶访问 + 方法显式带 session。 */
    stateOf: (session: Session) => SessionRuntimeState;
    shadowedSeqsOf: (session: Session) => Set<number>;
    noteRecallHit: (session: Session, seq: number) => void;
    budgetRecallText: (session: Session, text: string) => string;
    recallQuery: (session: Session, query: string, maxResults?: number) => string;
}
/**
 * 工具调用的目标会话解析（1-2）：优先 exec.agent.session（agent loop 设置，多会话/
 * 子代理宿主下逐调用正确）。回退焦点绑定**只在引擎只见过一个会话时允许**（beta.1 评审
 * D2 同族：多会话宿主下 exec.agent 缺席的静默回退会把 B 会话的上下文喂给 A 的调用；
 * 单会话宿主与无 agent 上下文的测试路径不受影响）。ToolRunContext.agent 是
 * dsh-agent-loop 的运行时 Agent（带 live session）；类型上经窄 cast 读取。
 */
export declare function sessionOfToolCall(exec: unknown, host: RecallToolsHost): Session | null;
/**
 * 每轮召回**调用次数**上限（1.7.1：由硬闸门 `3` 提升为宽松安全阀 `20`）。
 *
 * 1.7.0 用 `>= 3` 作主闸门：每轮第三次之后的召回直接被拒。实测（session-16188a24，
 * 15 轮）该闸门**从未触顶**——全会话 6 次召回调用分散在 2 轮（后 11 轮归零），
 * 跨会话基线 0.76%，配额白设；它唯一的实际作用是"模型真需要第四次召回时拿不到东西"，
 * 与"墓碑只给指针、把取回决定交给模型"的方向相反（负优化）。
 *
 * 1.7.1 把主闸门改为**字符预算**（`budgetRecallText` 的 `recallCharsUsed` 窗口，
 * 压缩换代时归零、耗尽时显式说明剩余额度），本计数退化为**防循环安全阀**：
 * 只拦"模型陷入召回循环"这种病态行为，不参与"要不要多取几次"的正常决策。
 * 取值参考：本档 493 次工具调用 / 15 轮 ≈ 33 次/轮 ⇒ 20 次/轮 仍是合理上限。
 */
export declare const RECALL_CALLS_PER_TURN_LIMIT = 20;
/**
 * 注册三个召回工具到 ctx.tools；register 顺序即工具在 ctx.tools 中的列出次序。
 */
export declare function registerRecallTools(ctx: Context, host: RecallToolsHost): void;
