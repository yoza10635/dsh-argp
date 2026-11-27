/**
 * 日志级访问原语（P1 修复路线 (b) 的公共实现）。
 *
 * 背景：多个引擎入口原本在召回工具里用同一道
 * 布尔门控 `shadowedSeqs(session).has(seq)`，未命中直接拒答 "not a pruned node"。
 * 但数据路径本来就是全日志级的（eventText 直接索引 session.events[seq]），门控是唯一障碍：
 * 掉出可见上下文但未被 ARGP 替换的节点（如适配器按 contextWindow 丢弃的 live surface 节点、
 * 或从不进 surface 的 tool/call）对模型既不可见、也不可召回 —— 即 P1「盲区」。
 *
 * 本模块把 recall 原语从"查 pruned 索引"升级为"按 seq 查 append-only 日志、无视节点状态"，
 * 并携带状态标签（shadowed / live / off-surface），使模型知道取回的内容当前是否可见
 * —— 否则 1.x 引用协议的带引义务无从执行（2.0 起该状态口径仍服务召回话术）。越界 seq 才报错。
 */
import type { Session, SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session';
/**
 * 同步读日志的后端抽象（A1：全部日志读取的唯一可替换接缝）。
 *
 * dsh 0.1.2-alpha.4 的 breaking 重构 `27bf1039db refactor(session)!: distinguish
 * event seqs from log offsets` 移除了 `Session.events` getter（运行时 `undefined`），
 * 替代为 `snapshotEvents()`（frozen 全日志快照）/ `eventAt(seq)`。rc.2 仍有 `events`
 * getter。两个形态的**判别集中在本模块**（{@link logBackendOf}），`sessionEvents()`、
 * `eventAt()` 与 boot 探针都复用同一后端对象——判别漂移只可能发生在一处。
 *
 * **宿主已把这三枚同步读 API 标注 `@deprecated … new calls are prohibited`**
 * （`eventAt` / `snapshotEvents` / `ownEvents`，dsh 0.2.x 基线）——现有逻辑允许保留，
 * 但禁止新增调用。ARGP 是同步引擎（`decide()` 不能 await），当前只能继续使用；
 * 若宿主未来移除同步读，迁移面 = 给 {@link LogBackend} 加一个异步实现（读取 + 引擎侧
 * 镜像），而不是散落各处的调用点。升级宿主后先跑 `node scripts/doctor.mjs --dsh <根>`：
 * 它检查宿主声明文件里 `snapshotEvents(` 是否仍在。
 */
export type LogReadBackend = 'snapshotEvents' | 'events';
/** 日志读取后端：当前只有同步快照实现；异步迁移另加实现，调用点不变。 */
export interface LogBackend {
    readonly kind: LogReadBackend;
    /** 全日志只读快照（frozen、与后续 append 解耦）。 */
    snapshot(): readonly SessionEvent[];
    /** 按 seq 取单个事件；越界返回 undefined（与宿主同义）。 */
    at(seq: number): SessionEvent | undefined;
}
/** 取（并缓存）该 session 的日志后端；无同步读 API 时抛可行动的版本不兼容错误。 */
export declare function logBackendOf(session: Session): LogBackend;
/** 后端判别（诊断用）；两者皆无返回 null。 */
export declare function detectLogReadBackend(session: Session): LogReadBackend | null;
/**
 * 跨宿主版本兼容的事件日志读取（升级阻断修复）。
 *
 *   - 宿主 Session 提供 `snapshotEvents`（alpha.4+）→ 调 `snapshotEvents()`
 *   - 否则回退到 legacy `session.events`（rc.2）
 *
 * **当前支持基线 0.2.0-rc.1**：该版本 `events` getter 已彻底
 * 移除、`snapshotEvents()` 是唯一真实路径，故 legacy 分支在受支持范围内**不可达**，
 * 仅作为宿主形态回退的防御保留（由 stub 用例覆盖，见
 * test/session-events-compat.test.ts「legacy 分支回退 events getter」）。将来若要
 * 清理，须同步删掉该 stub 用例，否则会失去"宿主回退形态"的哨兵。
 *
 * 两个路径都返回 frozen 数组，语义完全一致（不可变、与后续 append 解耦）。
 * 本 helper 是 ARGP 全代码库唯一允许直接触碰"事件日志"的入口——任何新增
 * `session.events[...]` / `session.snapshotEvents()` / `session.eventAt()` 都视为违规。
 */
export declare function sessionEvents(session: Session): readonly SessionEvent[];
/**
 * 按 seq 取单个事件（日志读取入口的按位形态）。
 *
 * 宿主契约：`session.seq` 恒为日志长度、seq 连续，故 seq 与快照下标同一。
 * 调用方一律走这里，不直接调宿主 `session.eventAt()`（`@deprecated`，且它是本模块要
 * 替换的那一层）；越界返回 undefined，与宿主同义。
 */
export declare function eventAt(session: Session, seq: number): SessionEvent | undefined;
/**
 * boot 探针（只读，不改变读取路径）：报告实际后端与日志长度。
 *
 * 用途是**升级后第一现场可诊断**——后端判别失败时错误在 bindSession 处带宿主契约说明，
 * 而不是在某个深层调用点炸成 undefined 级联。长度取自同一次快照，不另调宿主 `seq`
 * （保持本模块对宿主面只有一个接触点）。
 */
export interface LogAccessReport {
    backend: LogReadBackend;
    /** 绑定当时的日志长度（事件数）。 */
    length: number;
}
export declare function inspectLogAccess(session: Session): LogAccessReport;
/**
 * 事件 turn 号类型化访问器。
 *
 * 根因：宿主包 dsh-session 的 `SessionEvent` 虽是判别联合，但 `turn` 不是公共字段
 * （仅 turn/start、turn/end、step/*、assistant/message 等部分事件携带），宿主类型
 * 无法加公共 `turn` 字段，代码库各处因此各自 `event.data as { turn }` 强转。
 * 本访问器把该强转集中到一处：data 带 number 型 turn 时返回 turn 号，
 * 否则 undefined（如 user/message 无 turn 字段）。
 */
export declare function turnOf(event: SessionEvent): number | undefined;
/**
 * 从一个事件投影出模型可见文本（text + tool-call 概要 + tool-result 内层 text；reasoning 不算）。
 *
 * 本函数只依赖 `sessionEvents`（本模块）+ 纯数据操作，不触碰任何 hub 运行时
 * （无 this.ctx / engine 状态）。hub 侧保留 `export { eventText } from './log-access.js'`
 * 转发以维持既有公共 API 与测试 import 不变。
 */
export declare function eventText(session: Session, seq: number): string;
/**
 * 从单个事件投影模型可见文本（`eventText` 的纯事件形态；peratom/gate 的
 * `projectSurfaceText` 委托到这里，单一事实源）。
 */
export declare function eventTextOf(event: SessionEvent): string;
/**
 * 日志尾部的 open turn（从日志末尾向前找：最近的 turn/start 且其后无 turn/end）。
 * 返回 open turn 号；无开放轮（末尾已闭合 / 会话头）返回 null。
 * **-1 = 存在未闭合的 turn/start 但轮号不可读**（畸形日志）——fail-closed 哨兵：
 * 消费方按「一切皆开放轮」处理（焦点降级带清零、驱逐全停、预剪跳过），
 * 绝不允许把「号读不出」误折叠成 null=「无开放轮」而放行 open 区驱逐。
 */
export declare function detectOpenTurn(session: Session): number | null;
/** 当前开放 step 的步号（无开放 step ⇒ null；turn/end、step/end、turn/start 均截断）。 */
export declare function detectOpenStep(session: Session): number | null;
/**
 * `SessionSeq` 品牌收窄（dsh 0.1.5 起 `SessionSeq = BrandedNumber<'SessionSeq'>`）。
 *
 * 分工约定：**ARGP 内部模型（原子、区间、账目、预算）一律用裸 `number`**——内部要做
 * 加减与区间比较，品牌类型在算术上寸步难行；只在**写入/查询 dsh API 的边界**经此收窄。
 *
 * 这里刻意只做类型层收窄、不做运行时校验：宿主 `Session.append` 内部对 seq 有权威校验
 * （非安全整数、越界、非更早事件都即 throw），重复校验只会把错误信息推离现场、
 * 并把 dsh 的校验口径抄进 ARGP 造成第二份需要同步维护的真相。
 * @param value - ARGP 内部计算的 seq。
 * @returns 同一数值，类型收窄为 SessionSeq。
 */
export declare function asSeq(value: number): SessionSeq;
/**
 * {@link asSeq} 的数组版本，用于 `sourceEventSeqs` / `shadowedSeqs` 等 seq 列表字段。
 * @param values - ARGP 内部计算的 seq 列表。
 * @returns 同序新数组，元素类型收窄为 SessionSeq。
 */
export declare function asSeqs(values: readonly number[]): SessionSeq[];
/**
 * 节点相对可见上下文的状态：
 *  - `shadowed`：已被 surfaceOp replace 遮蔽（ARGP 剪枝产物），确定不在可见上下文里。
 *  - `live`：仍在 session.surface.nodes 上。注意"在 surface 上"不等于"模型看得见"——
 *    适配器组装请求时可能按 contextWindow 截断最旧的 surface 消息（见 B-6）。
 *  - `off-surface`：合法事件但从未进入 surface（tool/call、turn/start、compaction/* 等）。
 */
export type NodeState = 'shadowed' | 'live' | 'off-surface';
/**
 * 全日志扫描收集被遮蔽 surface seq（权威剪枝账本：compaction/prune.shadowedSeqs 的并集）。
 * 只认 compaction/prune 事件（pruneIntervals 每次真剪枝必发，shadowedSeqs 即被剪 seq
 * 权威清单），与 ArgpEngine.shadowedSeqsOf 同口径。**不可**改用「replace 形态推断」
 * （任何 surfaceOp replace 的 sourceEventSeqs 都算 shadowed）：那会把原地压缩副本
 * （无 compaction/prune 事件）误判为 shadowed，导致召回对压缩原子谎报 state=shadowed。
 */
export declare function scanShadowedSeqs(session: Session): Set<number>;
/**
 * 原始文本访问器（P2.5 / P1「能精确则精确，做不到则精确标注」）。
 *
 * `eventText` 是共享投影（recall_pruned / list_pruned / summary 降级等多调用方）：
 * 多 text 块用 `join('\n')` 塞合成换行、tool-call 参数被 `JSON.stringify` 重序列化，
 * 并非 byte-for-byte。本访问器专供 recall_detail 取**原始字面量**：
 *
 *  - **text 块**：返回日志里存的字面量本身（不塞合成换行）；多块时按原顺序保真，
 *    块间分隔符是投影（原件是离散块、无单一字符串），`reconstructed` 标注之；
 *  - **tool-call 参数**：宿主存的是字符串（dsh-session `tool/call` 的 `arguments` 即
 *    模型产出的 raw JSON string，未解析）→ 逐字；宿主存的是对象 → 字面量不可恢复，
 *    只能 `JSON.stringify` 语义等价重建，`reconstructed` + `note` 精确标注；
 *  - `[tool-call name(...)]` 框架是事件结构的确定性投影（tool/call 事件无 text 块），
 *    参数本体逐字时不算重建。
 *
 * 无正文（无 text 块 / 参数）返回 null（与 eventText 的 `''` 语义对齐，由调用方转换）。
 */
export interface RawEventText {
    /** 原始文本（text 块逐字字面量；重建部分经 note 标注）。 */
    text: string;
    /** 返回文本是否含重建部分（非存储字面量）。 */
    reconstructed: boolean;
    /** 重建部分的标注（仅 reconstructed=true 时存在）。 */
    note?: string;
}
export declare function rawEventText(session: Session, seq: number): RawEventText | null;
/**
 * 事件的面拆分（§9.36 浓缩输入面）：assistant/message 的 text/reasoning 块归 'A'、
 * tool-call 块逐块归 'K'（`name(args)` 投影，与 R1 回放 replay 形同构——tool/call 是
 * off-surface 记账事件，K 面只能从 A 的块里取）；其余类型单面返回（face 按类型给
 * 'U'/'R'/'X'），文本口径与 {@link rawEventText} 一致。
 */
export declare function rawEventFaces(session: Session, seq: number): Array<{
    face: 'U' | 'A' | 'K' | 'R' | 'X';
    text: string;
}>;
/** 判定单个 seq 的状态。shadowed 优先（被遮蔽的节点也可能仍留在 surface 索引之外）。 */
export declare function nodeStateOf(session: Session, seq: number, isShadowed: (seq: number) => boolean): NodeState;
/**
 * 沿 surfaceOp replace 链回溯到 append 根源 seq。
 *
 * 归并墓碑指向修正用：墓碑副本事件是 replace，其 [startSeq..endSeq] 指向**上一代**
 * （链式替换下是上一代墓碑而非原文）；循环回溯到 surfaceOp === 'append'（或无 op）
 * 即原文根源。append 事件（含伪造墓碑文本的普通事件）返回自身单元素数组。
 */
export declare function resolveRootSeqs(events: readonly {
    surfaceOp?: unknown;
}[], seq: number): number[];
