/**
 * ARGP 剪枝事务模块：事务骨架（pruneIntervals：start → summary → 每区间 checkpoint
 * replace → end）+ 墓碑可合并判据（isMergeableTombstone）+ 事务记录类型
 * （GraphPruneRecord）。手动区间族（compactRegion/compactRegions/selectManualRanges/
 * consolidateTombstones）不在 2.0 factor 面（引擎 compactRegion 直接拒发）。
 *
 * 循环 import 规避：本模块**不** import hub 运行时，也**不** import session-lifecycle
 * （否则 session-lifecycle → prune-tx → session-lifecycle 成环）。需要调用引擎方法的函数
 * 通过窄接口 {@link PruneTxHost} 上的**方法引用**调用（host.bindSession / host.atomize），
 * 而非模块 import——方法在运行时经传入的实例（即 hub 的 class）分派，编译期零依赖。
 * 依赖方向：hub → prune-tx（单向）。
 */
import { randomUUID } from 'node:crypto';
import { CompactionId, compactCheckpointSource, toolPairingBalancedAfter } from '@deepseek-ai/dsh-compaction';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { notePrunedNode } from './session-state.js';
import { sessionEvents, asSeq, asSeqs, detectOpenTurn, turnOf, eventText } from './log-access.js';
import { classifyUserMessage } from './atomize.js';
import { visibleChars, visibleCharStats } from './budget.js';
import { estTokensFromStats } from './cjk.js';
import { shadowedTokensOf } from './constants.js';
import { pushBounded } from './telemetry.js';
import { isMergeableTombstoneText } from './tombstone-text.js';
import { estimateHiddenHistory } from './factor/history-estimate.js';
import { compactionDebugLine, compactionSummaryText, estimateSurfaceRelease } from './compaction-report.js';
export function isMergeableTombstone(text) {
    return isMergeableTombstoneText(text);
}
/**
 * F3：旧 seq → 当前替身 seq（墓碑）的重定向表。
 *
 * **病灶**：declarer 写入侧 `collectDeclAtoms` 走 `sessionEvents`（**原始 append-only 日志**），
 * 已被 replace 离场的旧 seq 仍在 `toBySeq` 校验白名单内（模型引用它**合法**，
 * `accepted=N, invalid=0`）；而消费侧 `buildInjectEdges` 的 `idBySeq` 建自**当前投影**，
 * 查表必然 miss ⇒ 边被 `droppedByMissingEndpoint` 丢弃。实测 `session-fceb1ccc`：
 * 4 条声明边中 2 条 critical（`toSeq=18`）因 18 已墓碑化为 seq=53 而全丢。
 *
 * **映射源** = `GraphPruneRecord.intervals`（`prune-tx.ts:282/:300` 写 replace 时逐区间记录
 * `{start,end,tombstoneSeq}`；`rebuildLedgerFromLog` 亦从 `compaction/end` 重建）。
 * 同一 seq 多次替换时**后者胜**（取最新替身）；多跳链（墓碑再被墓碑替换）由调用侧迭代解析，
 * 本函数只给一跳。`start === tombstoneSeq` 的区间跳过（防自映射/自环）。
 *
 * ⚠️ **已知限制**：`rebuildLedgerFromLog` 重建的 `intervals` 把一次压缩的所有 seq 压成
 * **单条** `[first..last] → compaction/end seq`，而 end 是 **off-surface** 事件 ⇒
 * **resume（跨进程重载）后本表对多区间压缩无效**；同进程内为精确值。
 */
export function buildTombstoneRedirect(records) {
    const map = new Map();
    for (const rec of records) {
        for (const iv of rec.intervals) {
            for (let s = iv.start; s <= iv.end; s += 1) {
                if (s !== iv.tombstoneSeq)
                    map.set(s, iv.tombstoneSeq);
            }
        }
    }
    return map;
}
function firstLineOf(text) {
    return text.split('\n', 1)[0].slice(0, 200);
}
/**
 * §8-11 活体入账的明细构造：atoms 在手优先用（组剪/散文/去重臂带真实 type/turn/text）；
 * tombstone-merge 臂 `atoms: []`（factor/engine.ts 归并只带 seqs）以及 atoms 未覆盖的
 * seq 走日志反查——口径与 `session-lifecycle` 重建侧 typeOfSeq/turnOfSeq 一致
 * （user/message 经 classifyUserMessage 分 U/X，assistant→A，tool/result→R，
 * developer 与未知显式归 X）。
 */
function prunedNodeInfoFor(session, seq, atom) {
    if (atom !== undefined) {
        return { seq, type: atom.type, turn: atom.turn, firstLine: firstLineOf(atom.text), citedBySeq: [], eff: 0 };
    }
    const event = sessionEvents(session)[seq];
    let type = 'X';
    if (event !== undefined) {
        if (event.type === 'user/message')
            type = classifyUserMessage(event.data);
        else if (event.type === 'assistant/message')
            type = 'A';
        else if (event.type === 'tool/result')
            type = 'R';
    }
    return {
        seq,
        type,
        turn: event === undefined ? 0 : (turnOf(event) ?? 0),
        firstLine: event === undefined ? '' : firstLineOf(eventText(session, seq)),
        citedBySeq: [],
        eff: 0,
    };
}
/**
 * 一笔事务剪多个极大连续区间：start → summary → 每区间 checkpoint replace → end。
 * 发射前先做**相邻同文 user 墓碑归并**（surface 紧邻 + 文本逐字节相同 ⇒ 并条；
 * 2026-11-26 桩游程治理，见 pruneIntervals 内注释）。
 *
 * **2.2.2 根修（2026-11-26 session-43df801e 存档加载失败案）：surface replace 只允许
 * user 检查点。** tool/result 与 developer 形态的 replace 已从本模块整类删除——宿主
 * v4 fold 对它们执行 `requireTurn()`/`requireStep()`（加载侧 dsh-session-format-v3-to-v4），
 * 而压缩事务可能落在轮间隙（手动 /compact 是宿主 idle maintenance，实证
 * `compaction/start.data.turn === null`），此时无任何合法表达；写入侧 `Session.append`
 * 不拦 ⇒ 当场成功、下次加载整档判 corrupt 拒载。user 检查点不受轮/步约束，是唯一
 * 与压缩时点无关的合法 surface 写回形态。
 *
 * 结构性保证（不再依赖"计划时有开放轮"的时点判断）：
 *  - 本函数的 tombstones 参数类型只接受 `{type:'user'}`；其它形态在 TypeScript 层不可达，
 *    运行时另有防线（收到非 user 墓碑直接 throw，见函数头）。
 *  - 唯一剩余的 tool/result 语义（C10 夹剪文本 = 头尾留真预览）改由组剪检查点的
 *    **文本**承载（factor/engine.ts `groupCheckpointText`），不再改写 R 节点本体。
 */
export function pruneIntervals(host, session, intervals, candidateCount, forced, tombstones, summaryKind, 
/** §G2：LLM 摘要调用的真实账单/信封回填 compaction/summary（宿主字段词典；0-LLM 事务不传）。 */
summaryMeta) {
    const st = host.stateOf(session);
    // 运行时结构锁：TS 层已收窄为 user-only，这里防历史 JS 调用方/setup 绕过注入毒形态。
    for (const ts of tombstones ?? []) {
        const kind = ts.type;
        if (kind !== 'user') {
            throw new Error('prune-tx: surface replace may only emit user/message checkpoints (got tombstone type '
                + JSON.stringify(kind) + '); host v4 fold rejects non-append tool/result outside an open turn — '
                + 'this shape was removed in 2.2.2 (session-43df801e archive-load failure)');
        }
    }
    const openTurnPre = detectOpenTurn(session);
    if (openTurnPre === -1) {
        // -1 = 有未闭合 turn/start 但轮号不可读（畸形日志）的 fail-closed 哨兵，不是轮号。
        // 宿主 compaction/start 的 turn 走 non-negative safe integer 校验，-1 直接整档拒载；
        // 折叠成 null 又会让轮间隙事务带着错误轮号落盘。任何一头都是死档 ⇒ 事务前拒发。
        throw new Error('prune-tx: open turn number is unreadable (-1, malformed log); refusing to emit compaction/start with an unusable turn');
    }
    // ---- 落点重导（2026-11-27 rev-fold 复核 blocker）----
    // 调用方给的 `iv.seqs` 是**决策时刻的 surface 快照**，而"决策 → 发射"之间可能有 await：散文浓缩
    // 在 LLM 之前取整段 span（prose-condenser.ts:415），随后等模型数秒（:457/:473）才发射（:491）。
    // 窗口内任何 surface replace（宿主原生 toolResultPruner 切 R、外来压缩引擎）落在 span **中段**时，
    // 下方 summary 守卫只校验首尾两点（startIdx/endIdx）⇒ 整笔放行 ⇒ 每区间 prune 按**陈旧 seqs** 落盘
    // → 紧随的 replace 被写入侧拒（`sourceEventSeqs must include every shadowed surface node`）
    // → catch 只补 error end ⇒ **毒 prune 永久留在日志**：加载侧对每条 compaction/prune 无条件跑
    // span()（error end 关闭的事务同样校验）⇒ 整档拒载（实测复现，2026-11-27）。
    // 修法：start 之前用**现读 surface** 重导每个区间的 seqs = 首尾之间的当前连续切片。切片内新出现的
    // 节点本来就会被这次 replace 一并覆盖，因此必须进 claim（否则又是不一致声明）。首尾任一离面
    // ⇒ 整笔拒发（宁可本轮不压，也不留半截声明）。区间/墓碑的配对与位置序在下面照旧。
    const liveNodes = session.surface.nodes;
    const livePosOf = (q) => liveNodes.indexOf(asSeq(q));
    const rederived = [];
    for (const iv of intervals) {
        if (iv.seqs.length === 0)
            continue;
        const head = iv.seqs[0];
        const tail = iv.seqs[iv.seqs.length - 1];
        const i = livePosOf(head);
        const j = livePosOf(tail);
        if (i < 0 || j < i) {
            throw new Error(`prune-tx: interval [${head}, ${tail}] is not a current surface slice (startIdx=${i}, endIdx=${j}); refusing to emit a stale compaction/prune`);
        }
        rederived.push({ seqs: liveNodes.slice(i, j + 1), chars: iv.chars, atoms: iv.atoms });
    }
    let useIntervals = rederived;
    let useTombstones = tombstones;
    // 位置序排序（2026-11-11 CB 四臂实锤 P0 修复）：调用方给的区间序 = 决策优先序
    // （factor 压力剪按 retention 最差优先逐条成区间；图剪按决策清单序），不是 surface 位置序
    // → 首尾位置倒挂直接撞下方 span 守卫整笔拒发 = 压力剪**静默蒸发**（CB 22 题 11 个会话中招，
    // factor 臂压缩大面积失效 → 上下文失控涨到 35K+ 撞 provider 槽墙，轮死呈 finish=length/1-token）。
    // 宿主契约（compaction/compaction/types.ts:107-117）明示：shadowedRange 是 surface **位置** span、
    // shadowedSeqs（surface 序）才是权威集——排序按 indexOf(seqs[0])；区间与墓碑**原子**换位，
    // 保住 resolvedTombstones[i] 逐位配对；未落位区间（indexOf=-1）稳定沉底，若仍为首尾之一
    // 则属真 span 损坏，守卫照拒（方向正确）。区间恒位置升序：sort 稳定 = 恒等，零行为变化。
    const txSurfaceNodes = session.surface.nodes;
    const txPosOf = (iv) => {
        const i = txSurfaceNodes.indexOf(asSeq(iv.seqs[0]));
        return i < 0 ? Number.MAX_SAFE_INTEGER : i;
    };
    if (useIntervals.length > 1) {
        const order = useIntervals.map((_iv, i) => i);
        order.sort((a, b) => txPosOf(useIntervals[a]) - txPosOf(useIntervals[b]));
        const sortedIntervals = order.map(i => useIntervals[i]);
        if (useTombstones.length === useIntervals.length) {
            const srcTs = useTombstones;
            useTombstones = order.map(i => srcTs[i]);
        }
        useIntervals = sortedIntervals;
    }
    // 重叠复核必须在**位置序排序之后**：调用方喂入序 = 决策优先序（新者优先/retention 最差优先），
    // 倒序喂入是常态（test ①②⑤ 即此形），按喂入序判重叠会把正常事务误拒。
    {
        let prevLiveEnd = -1;
        for (const iv of useIntervals) {
            const i = livePosOf(iv.seqs[0]);
            const j = livePosOf(iv.seqs[iv.seqs.length - 1]);
            if (i < 0 || j < i) {
                throw new Error(`prune-tx: interval [${iv.seqs[0]}, ${iv.seqs[iv.seqs.length - 1]}] left the surface during ordering; refusing to emit a stale compaction/prune`);
            }
            if (i <= prevLiveEnd) {
                throw new Error(`prune-tx: intervals overlap on the current surface (slice starts at position ${i}, previous ends at ${prevLiveEnd}); refusing to emit a stale compaction/prune`);
            }
            prevLiveEnd = j;
        }
    }
    // ---- 相邻同文墓碑归并（2026-11-26 session-43df801e 审计）----
    // 一笔 114 区间的扫荡在表面产出 run=96 的同 9 字桩连排：角色交替破坏，模型读到
    // 「用户连说 96 遍同一句话」。§11.8 归并通道随图臂退役（compactRegion 拒发），factor
    // 世界零桩治理。规则：区间在 surface.nodes 上**紧邻**（next.seqs[0] 恰随 prev 末 seq，
    // 中间无活体）且两条墓碑文本**逐字节相同** ⇒ 传递并条。同文相邻对模型本已不可分辨
    // ⇒ 归并零信息损失；交互/夹剪检查点文本含各自 keys/预览 ⇒ 不并（指针与信息语义保留）。
    // 2.2.2 根修后墓碑只剩 user 一种形态（tool/developer 结构桩整类删除）。
    // P1-5 数量校验随 resolved 计算上移到 start 事件之前：错配更早拒发，不再留 start+summary 死括号。
    if (useTombstones.length !== useIntervals.length) {
        // 审查 P1-5：绝不能静默回退到 seq 指针墓碑（零指针纪律）；数量错配 = 调用方 bug。
        throw new Error('prune-tx: tombstone count mismatch (' + useTombstones.length + ' vs ' + useIntervals.length + '); refusing pointer fallback');
    }
    let resolvedTombstones = useTombstones;
    if (useIntervals.length > 1) {
        const txPosMap = new Map();
        for (let i = 0; i < txSurfaceNodes.length; i += 1)
            txPosMap.set(txSurfaceNodes[i], i);
        const mergedIntervals = [];
        const mergedTombstones = [];
        for (let i = 0; i < useIntervals.length; i += 1) {
            const iv = useIntervals[i];
            const ts = resolvedTombstones[i];
            const prevIv = mergedIntervals[mergedIntervals.length - 1];
            const prevTs = mergedTombstones[mergedTombstones.length - 1];
            let merged = false;
            if (prevIv !== undefined && prevTs !== undefined && ts.text === prevTs.text) {
                const p = txPosMap.get(prevIv.seqs[prevIv.seqs.length - 1]);
                const q = txPosMap.get(iv.seqs[0]);
                if (p !== undefined && q === p + 1) {
                    mergedIntervals[mergedIntervals.length - 1] = { seqs: [...prevIv.seqs, ...iv.seqs], chars: prevIv.chars + iv.chars, atoms: [...prevIv.atoms, ...iv.atoms] };
                    merged = true;
                }
            }
            if (!merged) {
                mergedIntervals.push({ seqs: [...iv.seqs], chars: iv.chars, atoms: [...iv.atoms] });
                mergedTombstones.push(ts);
            }
        }
        useIntervals = mergedIntervals;
        useTombstones = mergedTombstones;
        resolvedTombstones = mergedTombstones;
    }
    const charsBefore = visibleChars(session);
    const openTurn = openTurnPre;
    // 'argp-graph-' = 历史 wire 前缀（会话日志既有形态）：非压缩时点零改写不变量 + 旧日志
    // 零成本兼容 ⇒ **勿随 2.1.0 类名重构（ArgpGraphEngine→ArgpEngine）改动**（design-2.1.0-batch §1.7）。
    const compactionId = CompactionId('argp-graph-' + randomUUID());
    const lifecycle = { compactionId, turn: openTurn };
    // /compact 溯源：发起命令 ID 随事务事件落账（UI presentation correlation）。
    // sourceCommandId 一致性契约（宿主 dsh-compaction invariant validateSourceCommandId +
    // v3-to-v4 relationships.compactionOwner）：start/summary/end 三事件必须携带**同一个**
    // sourceCommandId——只 start 带而 summary/end 不带，加载期 v3-to-v4 fold 会 throw
    // "no matching compaction/start"（2026-09-23 实测：/compact 过的会话无法重新加载）。
    // 故把可选字段提出来，三个事件统一展开（自动压缩时 compactSourceCommandId 为 undefined，
    // 三事件一致为 undefined，同样满足契约）。
    const sourceCommandIdField = host.compactSourceCommandId === undefined ? {} : { sourceCommandId: host.compactSourceCommandId };
    const allSeqs = useIntervals.flatMap(iv => iv.seqs);
    // 统计口径（2026-11-27）：`shadowedTokenCount` = 本次从 surface 拿掉的文本（宿主 token-meter
    // 记账口径，不可改）；`hiddenHistory` = 这些节点代表的历史原文体量（沿 sourceEventSeqs 链解析，
    // CJK 自适应密度）。二者在 §11.8 墓碑归并上分离极大（145 桩 = 339 tok vs 代表历史数十万 tok），
    // 日志/摘要必须分别报，否则「压缩收益 300 tok」会被读成事故。
    const hiddenHistory = estimateHiddenHistory(session, allSeqs);
    const first = useIntervals[0]?.seqs[0] ?? 0;
    const last = useIntervals[useIntervals.length - 1]?.seqs[useIntervals[useIntervals.length - 1].seqs.length - 1] ?? first;
    const startEvent = session.append('compaction/start', {
        ...lifecycle,
        ...sourceCommandIdField,
    });
    // 事务括号配对守卫（2026-09-23）：成功 end 之后仍有可抛语句（checkpoint 记 seq、记账、
    // 锚点重置、返回体构造），一旦抛出，catch 会再补一条 end ⇒ 同一 compactionId 出现**两条** end。
    // 写入侧不校验，加载期第二条 end 命中 invariant 的
    // "compaction/end has no matching compaction/start" ⇒ 会话永久打不开。ended 保证恰好一条 end。
    let ended = false;
    try {
        const shadowedTokenCount = shadowedTokensOf(useIntervals.reduce((s, iv) => s + iv.chars, 0));
        // ---- compaction/summary 先于 prune/replace 循环发出（宿主 span() 契约，Issue #2 同类修复）----
        // 旧实现在整轮墓碑 replace 循环**之后**才发 summary，shadowedSeqs 取 pre-replace 原原子
        // （多区间在 surface 上不连续）——到 summary 被接收时原原子已离开 surface，加载期
        // span() 命不中 current surface span（休眠 bug：全库 0 条 argp-graph-* 事件、从未实测触发）。
        // 修法同 peratom flush：summary 移到循环**之前**（发出时刻整段仍完整），shadowedSeqs 取
        // 整段 [first,last] 的连续 surface 切片（surface 顺序），逐区间 prune+replace 随后落在段内；
        // 防御自检：整段不是当前 surface 的有效连续 span（或覆盖受保护 system head）时直接 throw，
        // catch 落带 error 的 end（不发 summary），宁可本轮不剪，也不写"落盘静默成功、重启才炸"的坏记录。
        const surfaceNodes = session.surface.nodes;
        const startIdx = surfaceNodes.indexOf(asSeq(first));
        const endIdx = surfaceNodes.indexOf(asSeq(last));
        if (startIdx < 0 || endIdx < startIdx) {
            throw new Error(`prune-tx: range [${first}, ${last}] is not a valid current surface span (startIdx=${startIdx}, endIdx=${endIdx}); refusing to emit a corrupt compaction/summary`);
        }
        if (startIdx === 0) {
            const headEvent = sessionEvents(session)[surfaceNodes[0]];
            if (headEvent !== undefined && headEvent.type === 'system/message') {
                throw new Error('prune-tx: range covers the protected system head; refusing to emit a corrupt compaction/summary');
            }
        }
        const rangeSeqs = surfaceNodes.slice(startIdx, endIdx + 1);
        // 人类可读剪枝摘要（2026-08-28 UI 联调）：compaction 节点的展示文本来自
        // compaction/summary 事件；不发则 WebUI 显示"压缩摘要不可用"。off-surface
        // 日志事件，模型不可见。payload 按 CompactionSummary 词典填诚实值，类型走 as never。
        const prunedCount = useIntervals.reduce((sum, iv) => sum + iv.atoms.length, 0);
        // 用户计数口径（2026-11-27 rev-search）：组剪 atoms = 1 枚 A + n 枚 R，报 atoms 会把
        // 一次调用说成「2 处工具调用」（≈2× 虚高）⇒ 用户句用 R 计数；散文 atoms 含被吞并的
        // 旧检查点（X）⇒ 段数剔除 X。
        const toolCallCount = useIntervals.reduce((sum, iv) => sum + iv.atoms.filter(a => a.type === 'R').length, 0);
        const proseSegments = useIntervals.reduce((sum, iv) => sum + iv.atoms.filter(a => a.type !== 'X').length, 0);
        const charsBefore0 = useIntervals.reduce((sum, iv) => sum + iv.chars, 0);
        // 用户可见回执（2026-11-27）：只说他能懂的三件事——压缩了什么、省了多少、原文还在。
        // 内部术语（§编号/墓碑/surface/原子/历史体量）一律只进下面的 debug 行，不进 UI。
        const reportKind = summaryKind ?? 'graph-prune';
        const reportStats = {
            count: reportKind === 'tombstone-merge'
                ? useIntervals.reduce((s, iv) => s + iv.seqs.length, 0)
                : reportKind === 'factor-prose' ? proseSegments : prunedCount,
            toolCalls: toolCallCount,
            intervals: useIntervals.length,
            // 净释放：扣掉本次写回的检查点文本（归并 145→31 时回填仍占位，毛值会把省下的算多）。
            releaseTokens: estimateSurfaceRelease(session, allSeqs, resolvedTombstones.map(ts => ts.text).join('')),
        };
        session.append('compaction/summary', {
            ...lifecycle,
            ...sourceCommandIdField,
            summary: [{
                    type: 'text',
                    text: compactionSummaryText(reportKind, reportStats),
                }],
            shadowedRange: { start: first, end: last },
            shadowedSeqs: rangeSeqs,
            shadowedTokenCount: shadowedTokensOf(charsBefore0),
            provider: summaryMeta?.provider ?? 'argp',
            model: summaryMeta?.model ?? (summaryKind === 'factor-prose' ? 'llm-prose-checkpoint' : 'deterministic-guards'),
            ...(summaryMeta?.usage !== undefined ? { usage: summaryMeta.usage } : {}),
            ...(summaryMeta?.maxTokens !== undefined ? { maxTokens: summaryMeta.maxTokens } : {}),
            ...(summaryMeta?.rawOutput !== undefined ? { rawOutput: summaryMeta.rawOutput } : {}),
            ...(summaryMeta?.llmStreamCall === true ? { llmStreamCall: true } : {}),
        });
        // P1-5 校验与 resolvedTombstones（含相邻同文归并）已上移至事务开始**之前**
        // （2026-11-26 桩游程治理）：错配拒发不再留下已落盘的 start+summary 死括号。
        const intervalRecords = [];
        let firstPruneSeq;
        for (let i = 0; i < useIntervals.length; i += 1) {
            const iv = useIntervals[i];
            if (iv === undefined)
                continue;
            const start = iv.seqs[0];
            const end = iv.seqs[iv.seqs.length - 1];
            // Shadow-price 契约（宿主 token-meter foldSurfaceProjection）：compaction/prune 的
            // shadowedRange 必须与紧随其后的 surface replace 范围**数值逐等配对**，否则重放投影
            // throw（2026-09-01 实测：多区间事务发一个总跨度 claim 再逐区间 replace，第一个
            // replace 即撞总 claim → resume 报 "no adjacent shadow price"）。故每区间一个
            // shadow-price 事件，范围=该单区间，与官方 compaction-tool-result-pruner 同模式；
            // 末尾 summary 的总范围 claim 被紧随的 off-surface compaction/end 清掉，无契约冲突。
            // 端点语义（§8-12 定性收口，2026-11-27）：start/end 取 iv.seqs（**面序**）的首/尾，
            // 是**面位置端点**，不是 seq 数值区间端点——宿主契约（dsh-compaction types.ts
            // CompactionResult.shadowedRange 头注）明文允许 `start > end`（"a surface-POSITION
            // span … start can be GREATER than end"）：早先 replace 把高 seq 检查点落进更旧区间的
            // 位置后，面上相邻游程天然倒挂/交叉。claim↔replace 永远同形同倒，token-meter 的
            // 数值配对与加载侧的索引折叠 + shadowedSeqs 逐等全部容忍（surface-fold-legality 锁）。
            // **勿天真排序**：claim 单独排序即断数值配对（resume 死），连 replace 一起排序则加载侧
            // 按索引序折叠整档拒载。下游凡假设 start≤end 的消费方（UI 压缩节点、离线读数）以
            // shadowedSeqs（权威集，面序）为准，不得用端点推算。
            const intervalPrune = session.append('compaction/prune', {
                shadowedRange: { start: asSeq(start), end: asSeq(end) },
                shadowedSeqs: asSeqs(iv.seqs),
                shadowedTokenCount: shadowedTokensOf(iv.chars),
            });
            if (firstPruneSeq === undefined)
                firstPruneSeq = intervalPrune.seq;
            const ts = resolvedTombstones[i];
            // 2.2.2 根修：surface replace 只有 user 检查点一种合法形态（tool/developer 分支已整类
            // 删除）。文本来源：调用方给定（普通/交互/夹剪预览检查点），缺省为 seq 区间墓碑。
            const text = ts.text;
            const tombstone = session.append('user/message', createUserMessage({
                content: [{ type: 'text', text }],
                // checkpoint 的 source.sourceCommandId 必须与 start 一致（宿主 invariant
                // validateCheckpoint → validateSourceCommandId）：/compact 手动压缩时传发起命令 ID，
                // 自动压缩时 compactSourceCommandId 为 undefined（与 start 一致为 undefined）。
                source: compactCheckpointSource(compactionId, host.compactSourceCommandId),
            }), {
                surfaceOp: { op: 'replace', startSeq: asSeq(start), endSeq: asSeq(end) },
                sourceEventSeqs: asSeqs([startEvent.seq, intervalPrune.seq, ...iv.seqs]),
            });
            intervalRecords.push({ start, end, tombstoneSeq: tombstone.seq });
        }
        // compaction/end 不携带 catalog 快照域（旧日志里的该字段仍原样保留，只是没有读者）。
        const endEvent = session.append('compaction/end', {
            ...lifecycle,
            ...sourceCommandIdField,
        });
        ended = true;
        // 开发者 debug 行（host.log.info，不进 UI）：保留精确口径——宿主记账值、校准后的
        // surface 释放、被隐藏的历史体量（§11.8 归并时可达数十万 tok）。
        host.log.info(compactionDebugLine(reportKind, reportStats, {
            shadowedTokenCount,
            historyTokens: hiddenHistory.tokens,
            historyChars: hiddenHistory.chars,
            originEvents: hiddenHistory.originSeqs.length,
            capped: hiddenHistory.capped,
        }));
        // 批次 3-5（beta.1）：事务后 tool-pairing 不变量审计——per-atom 墓碑保配对是设计保证，
        // 此处是对该保证的可观测护栏）。任何悬空 tool_call 必然穿过 surface 尾切，对最后
        // 一个节点做一次 toolPairingBalancedAfter 即全局检测；孤儿 tool result 会使助手
        // throw，同计违例。事务已提交：只观测不改写（错误日志 + auditWarnings 留痕）。
        try {
            const postNodes = session.surface.nodes;
            const tail = postNodes[postNodes.length - 1];
            if (tail !== undefined && !toolPairingBalancedAfter(session, tail)) {
                throw new Error('unanswered tool call crosses the trailing surface cut');
            }
        }
        catch (pairError) {
            const pairMsg = 'tool-pairing invariant violated after compaction: '
                + (pairError instanceof Error ? pairError.message : String(pairError))
                + ' (transaction committed; observability guard)';
            host.log.error('[argp-engine] ' + pairMsg);
            st.auditWarnings.push(pairMsg);
            if (st.auditWarnings.length > host.telemetryCap)
                st.auditWarnings.shift();
        }
        const charsAfter = visibleChars(session);
        pushBounded(st.records, {
            at: new Date().toISOString(),
            compactionId,
            ...host.compactSourceCommandId === undefined ? {} : { sourceCommandId: host.compactSourceCommandId },
            intervals: intervalRecords,
            startEventSeq: startEvent.seq,
            summaryEventSeq: firstPruneSeq ?? startEvent.seq,
            endEventSeq: endEvent.seq,
            shadowedSeqs: allSeqs,
            prunedAtoms: useIntervals.flatMap(iv => iv.atoms.map(a => ({ id: a.id, type: a.type, seq: a.seq }))),
            candidates: candidateCount,
            charsBefore,
            charsAfter,
            forced,
        }, host.telemetryCap);
        // §8-11 活体入账（2026-11-27）：已剪明细目录（prunedNodeIndex）过去只在冷 resume 的
        // 账本重建里材质化——活体事务不入账，`/argp` 的 `pruned index` 列在 compact 后不重启的
        // 进程恒报 0。事务已提交（成功 end 落地 + records 入台账），逐 seq 经 notePrunedNode
        // 补记：与重建路共用同一幂等入口（Map.has 吞掉冷重放撞进的已入账 seq，不双计）。
        const atomBySeq = new Map();
        for (const iv of useIntervals) {
            for (const a of iv.atoms)
                atomBySeq.set(a.seq, a);
        }
        for (const seq of allSeqs) {
            notePrunedNode(st, seq, prunedNodeInfoFor(session, seq, atomBySeq.get(seq)));
        }
        // P7：一笔 compaction 事务成功即重置 recall 字数预算（视图已换代，旧累计不应继续压制新一轮召回）；
        // 2026-11-14 起预算另有跨轮重置（recall.ts budgetRecallText 轮变归零），此处归零保留为双保险。
        st.recallCharsUsed = 0;
        // 2026-08-23：压缩换代 surface——旧真实锚点（压缩前的 provider usage）失效，
        // 若保留会用大锚点 + 增量导致压缩后立即误触发。用压缩后 surface 估算重置锚点
        // （压缩后 surface 小、估算误差影响小；下一次请求的 usage 会再次精确锚定）。
        // 锚点语义（budget.measureTokens 同口径）：lastRealPromptTokens 覆盖 seq < anchor
        // 的事件，增量按 seq >= anchor 计。这里 promptTokens 是**当前 surface 全量估算**
        // （已含刚落的墓碑/检查点），故 anchor 必须取 log 尾后的下一个 seq（session.seq），
        // 否则中间位置的替换副本会被 delta 二次计入（prose 检查点可达 20K tok）。
        // Issue5：锚点重置换 CJK 加权估算（审查 F4：这里是「标着 anchored 的 chars 估算
        // 敞口」——不改则压缩换代后 3.5 偏差原样回归）。非 CJK surface = chars/3.5 逐字等价。
        const anchorStats = visibleCharStats(session);
        st.lastRealPromptTokens = Math.ceil(estTokensFromStats(anchorStats.chars, anchorStats.cjk));
        st.lastRealAnchorSeq = session.seq;
        // 永久冻结：落剪不再刷新 frozenCatalog（见 bindSession 注释）。剪枝本身已让可见上下文换代，
        // 那一步的前缀缓存失效是上下文真实变更的必然代价；但 catalog 文本恒定，不在这条路上再变一次。
        return {
            compactionId,
            startSeq: asSeq(startEvent.seq),
            summarySeq: asSeq(firstPruneSeq ?? startEvent.seq),
            endSeq: asSeq(endEvent.seq),
            summary: resolvedTombstones.map(ts => ({ type: 'text', text: ts.text })),
            shadowedRange: { start: asSeq(first), end: asSeq(last) },
            shadowedSeqs: asSeqs(allSeqs),
            shadowedTokenCount,
        };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // ended 为真 ⇒ 成功 end 已落地，此处**不可**再补 end（否则双 end，重启必炸）。
        if (!ended) {
            try {
                session.append('compaction/end', { ...lifecycle, ...sourceCommandIdField, error: message });
            }
            catch {
                // 关闭失败保留未配对 start，可被 inspectCompactionEntryState 检出
            }
        }
        throw error;
    }
}
