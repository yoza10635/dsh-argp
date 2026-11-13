/**
 * ARGP 召回模块（2.0 factor-only 收窄）：被遮蔽 seq 增量账本（shadowedSeqsOf）+
 * 召回字数预算（budgetRecallText）。
 *
 * 1.x 图时代的 catalogText / recallQuery / recall / recallAnyState / nodeState /
 * latestTurnOf / noteRecallHit 随 stage-2 图臂退役；factor 召回面（recall_history /
 * list_labels）直接走 log-access 的字节级取回，本模块只留两条共享语义：
 * "被剪账本 = compaction/prune.shadowedSeqs 的投影" 与 "召回字符预算"。
 *
 * 循环 import 规避：本模块**不** import hub 运行时。需要读/写引擎可变字段的函数接收
 * 窄接口 {@link RecallHost} 而非具体 class；hub 的 class 以 `this as unknown as
 * RecallHost` 传入（编译期断言，运行时即真实实例）。依赖方向：hub → recall（单向）。
 */
import type { Session } from '@deepseek-ai/dsh-session';
import type { SessionRuntimeState } from './session-state.js';
/**
 * 召回侧模块函数访问引擎状态所需的窄接口。
 * 会话态经 `stateOf(session)` 分桶访问；
 * 函数签名一律显式带 session（异步调用方不得依赖引擎焦点指针）。
 */
export interface RecallHost {
    stateOf: (session: Session) => SessionRuntimeState;
    charsPerToken: number;
}
/**
 * 增量维护被遮蔽 surface seq 集合：事件日志只追加，游标从上次扫描处继续，
 * 避免每次召回/剪枝都 O(事件总量) 重扫。session 切换时重置。
 */
export declare function shadowedSeqsOf(host: RecallHost, session: Session): Set<number>;
/**
 * recall 预算：单次结果与累计结果都按窗口比例截断（窗口取最近解析的有效预算）。
 *
 * P7 修复：recallCharsUsed 原本只增不减、全会话无 reset —— 累计触顶后 allowed=0，
 * 返回值退化成纯 '…(truncated)' 且不说明原因，长会话静默丢 recall。现在
 *  1) 预算耗尽时显式说明剩余额度与何时恢复（不再静默）；
 *  2) 每笔 compaction 事务成功后归零（见 pruneIntervals 末尾）；
 *  3) 2026-11-14 用户裁定：**跨轮也重置**——T44 措辞实验实锤 73,400/73,400 用尽后
 *     同轮后续召回全部空手、模型放弃核对原文；轮变即归零（recallBudgetTurn 游标），
 *     压缩归零保留（双保险，语义一致）。
 */
/**
 * 召回预算读数（装配式 full 视图用，2026-11-14）：**纯读**——只做与 budgetRecallText
 * 相同的惰性轮变归零，不写 recallCharsUsed。对抗审查 B 项四不变量之一：装配侧与钳位侧
 * 必须看到同一预算快照，否则同一回复前后自相矛盾（装配判耗尽、钳位却放行）。
 */
export declare function recallBudgetState(host: RecallHost, session: Session | null): {
    perCallLimit: number;
    remaining: number;
    totalLimit: number;
};
export declare function budgetRecallText(host: RecallHost, session: Session | null, text: string): string;
/** 当前轮号（日志尾向前找最近 turn/start；找不到 = 0）——预算重置与召回安全阀共用。 */
export declare function currentTurnOf(session: Session): number;
