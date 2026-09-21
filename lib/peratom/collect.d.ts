/**
 * PeratomCompressor 收集模块（P5 结构重构 Wave 3 第 5 步，C 报告 §4 B 表）。
 *
 * 从 1,520 行 `compressor.ts`（God Class）拆出的**收集侧**方法：
 *  - 材料判据（isMaterial：唯一判据，三处共用——纯函数）；
 *  - 压缩水位（waterMarkOf / advanceWaterMark：(session, turn) → 已规划最大 seq）；
 *  - 窗口→候选共享尾部（collectFromWindow：中断/版本链/大小门控 + 原子化）；
 *  - 闭合轮收集（collectCurrentTurn）+ 开放轮收集（collectOpenTurn）。
 *
 * 循环 import 规避（C 报告关键设计决策 1）：本模块**不** import compressor 运行时，
 * 仅 type-only import（编译期擦除，无运行时环）。需要实例状态的方法经窄接口
 * {@link CollectHost} 访问（host.passWatermark / host.splitThresholdChars /
 * host.gateOptions）；isMaterial 是纯函数（只依赖入参 event），无需宿主。
 * 依赖方向：compressor-types（叶）← collect ← flush ← compressor（组合根）。
 *
 * 行为逐字节不变：函数体逻辑逐字保留（this.x → host.x / this.method → 模块函数），
 * 仅 `this` 换 `host`。
 */
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';
import type { GateOptions } from './gate.js';
import type { CurrentTurnCollect } from './compressor-types.js';
/**
 * 收集侧窄宿主接口（C 报告关键设计决策 1）：只含本模块所需成员。
 *  - `passWatermark`：压缩水位表（waterMarkOf / advanceWaterMark 读写）；
 *  - `splitThresholdChars`：用户长消息阈值（collectFromWindow 大小门控）；
 *  - `gateOptions`：门控选项快照（collectFromWindow 的 rNeedCompress 入参）。
 */
export interface CollectHost {
    passWatermark: WeakMap<Session, Map<number, number>>;
    splitThresholdChars: number;
    gateOptions: () => GateOptions;
}
/** 某轮已规划过的最大 seq（-1 = 未压过）。 */
export declare function waterMarkOf(host: CollectHost, session: Session, turn: number): number;
/** 成功落地后推进水位（单调不回退）。 */
export declare function advanceWaterMark(host: CollectHost, session: Session, turn: number, endSeq: number): void;
/** 窗口→候选的共享尾部（中断/版本链/大小门控 + 原子化）。closed/open 两口径共用。 */
export declare function collectFromWindow(host: CollectHost, session: Session, turn: number, turnEvents: SessionEvent[], startSeq: number, endSeq: number): CurrentTurnCollect | null;
/**
 * 收集当前（最新闭合）轮的可压原子。内嵌三道确定性过滤：
 * ① 中断轮整轮排除（filterInterruptedAtoms，interrupted=true 时数组恒空）；
 * ② 版本链成员硬排除（决策④，need_compress=false）；③ 大小启发式门控。
 * 无再压缩路径：U-info 副本 / plugin checkpoint 一律跳过（决策⑦）。
 */
export declare function collectCurrentTurn(host: CollectHost, session: Session, afterSeq?: number): CurrentTurnCollect | null;
/**
 * 收集当前开放轮（最后一条 turn/start 之后、尚无 turn/end）的可压原子。
 * P4 溢出三步路径②专用：溢出发生在 open turn 的请求上，第②步要降熵的正是
 * 这个 open turn——closed-turn 口径会错压上一闭合轮（2026-08-29 review 中项，
 * 与 per-atom 设计 §8「对当前轮大原子降熵」的意图不符）。过滤与闭合轮完全
 * 同款（中断/版本链/大小门控；U-info/checkpoint 跳过）；open turn 无 turn/end，
 * 不会出现在中断集里。无 turn/start（会话头）返回 null。
 */
export declare function collectOpenTurn(host: CollectHost, session: Session, afterSeq?: number): CurrentTurnCollect | null;
