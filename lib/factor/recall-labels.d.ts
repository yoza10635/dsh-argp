/**
 * 因子臂召回面（design-2.0 §1.4/§3.2）：`recall_history` + `list_labels` 两个
 * defineTool——factor 臂**只挂这两个**，graph 臂三件套（recall_pruned/list_pruned/
 * recall）不挂（挂载分流在 argp-graph-engine 构造期，按 engine 判别式）。
 *
 * 与 graph 臂的口径差：
 *  - 入口是**标签**不是 seq——factor 桩只写标签（seq 不进 prompt 是 §1.2 物理下限的
 *    直接推论），词表行同样只给标签；
 *  - 查询内核 = FactorLedger.queryPruned（交集优先 + 新鲜度降序 + cursor/epoch
 *    分页；epoch 漂移如实告警不假装稳定）；原文经 rawEventText 取日志 append 根源
 *    （被剪 R 的原事件仍在 append-only 日志里，text 块逐字；重建部分带 note）；
 *  - 预算照抄 graph 臂契约（budgetRecallText：单次 5% + 累计 10% 窗口、耗尽显式
 *    说明、压缩事务归零）——发现类工具 list_labels 同付费（0-4 教训：白嫖通道会把
 *    预算挤占面变成发现面本身）。
 *
 * 单点复用（禁各写一份）：sessionOfToolCall / RECALL_CALLS_PER_TURN_LIMIT ← recall-tools.ts。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Session } from '@deepseek-ai/dsh-session';
import type { SessionRuntimeState } from '../session-state.ts';
import type { FactorEngine } from './engine.ts';
/** 窄宿主：两个闭包实际触达的引擎成员（同 recall-tools 的窄接口纪律）。 */
export interface RecallLabelsHost {
    /** 焦点会话（exec.agent.session 缺席时的单会话兜底）。 */
    session: Session | null;
    sessionCount: () => number;
    stateOf: (session: Session) => SessionRuntimeState;
    shadowedSeqsOf: (session: Session) => Set<number>;
    budgetRecallText: (session: Session, text: string) => string;
    /** recallLimit 旋钮活读（P2-4 设置卡；缺省 ⇒ 5，与 P2-1 固定默认逐字一致）。 */
    recallLimitOf?: () => number;
}
/**
 * 注册因子臂召回两工具。`factor` 闭包捕获引擎的**同一个** FactorEngine 实例
 * （账本/epoch 与发射侧共享，构造期装配一次）。
 */
export declare function registerRecallLabels(ctx: Context, factor: FactorEngine, host: RecallLabelsHost): void;
