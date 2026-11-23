/**
 * 因子臂召回面（design-2.0 §1.4/§3.2）：`recall_history` + `list_labels` 两个
 * defineTool——2.0 factor-only 引擎**只挂这两个**。
 *
 * 口径：
 *  - 入口是**标签**不是 seq——factor 桩只写标签（seq 不进 prompt 是 §1.2 物理下限的
 *    直接推论），词表行同样只给标签；
 *  - 查询内核 = FactorLedger.queryPruned（交集优先 + 新鲜度降序 + cursor/epoch
 *    分页；epoch 漂移如实告警不假装稳定）；原文经 rawEventText 取日志 append 根源
 *    （被剪 R 的原事件仍在 append-only 日志里，text 块逐字；重建部分带 note）；
 *  - 预算照抄 graph 时代契约（budgetRecallText：单次 5% + 累计 10% 窗口、耗尽显式
 *    说明、压缩事务归零）——发现类工具 list_labels 同付费（0-4 教训：白嫖通道会把
 *    预算挤占面变成发现面本身）。
 *
 * 会话解析与防循环安全阀单点落在本文件——两个工具共用这一个 resolveSession/上限，
 * 不得各写一份。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Session } from '@deepseek-ai/dsh-session';
import type { SessionRuntimeState } from '../session-state.ts';
import { type FactorLedger } from './factor-ledger.ts';
import type { FactorEngine } from './engine.ts';
/** 窄宿主：两个闭包实际触达的引擎成员。 */
export interface RecallLabelsHost {
    /** 焦点会话（exec.agent.session 缺席时的单会话兜底）。 */
    session: Session | null;
    sessionCount: () => number;
    stateOf: (session: Session) => SessionRuntimeState;
    shadowedSeqsOf: (session: Session) => Set<number>;
    budgetRecallText: (session: Session, text: string) => string;
    /** 窗口字符密度（recallBudgetState 装配读数用；hub 侧 charsPerToken getter 同源）。 */
    charsPerToken: number;
    /** 观测数组容量上限（recallCalls 有界，/argp 报数用）。 */
    telemetryCap: number;
}
/**
 * 工具调用的目标会话解析（1-2）：优先 exec.agent.session（agent loop 设置，多会话/
 * 子代理宿主下逐调用正确）。回退焦点绑定**只在引擎只见过一个会话时允许**（beta.1 评审
 * D2 同族：多会话宿主下 exec.agent 缺席的静默回退会把 B 会话的上下文喂给 A 的调用；
 * 单会话宿主与无 agent 上下文的测试路径不受影响）。
 */
export declare function sessionOfToolCall(exec: unknown, host: RecallLabelsHost): Session | null;
/** per-turn 安全阀（召回面工具共用）：轮变归零 → 判上限 → 计数。返回 true = 已拒绝。 */
export declare function recallCallBlocked(st: SessionRuntimeState, session: Session): boolean;
/**
 * 查询标签解析单点（recall_history 与 search_history 共用；刀 B 从 recall 体抽出，
 * 行为逐字不变——KR/ZT/L 系锁全绿为准）：wanted 去重 → facet 精确/大小写两形展开 →
 * 路径后缀唯一归一（fail-closed 多候选不猜）。
 */
export declare function resolveQueryLabels(ledger: FactorLedger, raw: unknown): {
    wanted: string[];
    keys: Set<string>;
    unknown: string[];
    remapped: string[];
    ambiguous: string[];
};
/** keyword 通道文法闸（现由 search_history 消费；2.1.0 D8′ 迁出后 recall_history 不再用）。
 *  字面子串口径：不 regex（ReDoS）、不模糊、不嵌入——0-LLM 与确定性由 indexOf 语义天然成立。 */
export declare const KEYWORD_MIN_CHARS = 2;
export declare const KEYWORD_MAX_CHARS = 100;
/**
 * 注册因子臂召回两工具。`factor` 闭包捕获引擎的**同一个** FactorEngine 实例
 * （账本/epoch 与发射侧共享，构造期装配一次）。
 */
export declare function registerRecallLabels(ctx: Context, factor: FactorEngine, host: RecallLabelsHost): void;
