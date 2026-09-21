/**
 * ARGP 剪枝事务模块（P5 结构重构 Wave 3 第 4 步，C 报告 §4 A 表）。
 *
 * 从 3,380 行 hub `argp-graph-engine.ts`（God Class）拆出的**剪枝事务侧**函数：
 * 事务骨架（pruneIntervals：start → summary → 每区间 checkpoint replace → end）
 * + tombstone 归并（consolidateTombstones）+ 手动多区间压缩（compactRegions）
 * + 手动区间选择（selectManualRanges）+ 手动单区间压缩（compactRegion）
 * + 墓碑可合并判据（isMergeableTombstone）+ 事务记录类型（GraphPruneRecord）。
 *
 * 循环 import 规避（C 报告关键设计决策 1）：本模块**不** import hub 运行时，也**不**
 * import session-lifecycle（否则 session-lifecycle → prune-tx → session-lifecycle 成环）。
 * 需要调用引擎方法的函数（compactRegion / compactRegions / selectManualRanges 调
 * bindSession / atomize）通过窄接口 {@link PruneTxHost} 上的**方法引用**调用
 * （host.bindSession / host.atomize），而非模块 import——方法在运行时经传入的
 * 实例（即 hub 的 class）分派，编译期零依赖。依赖方向：hub → prune-tx（单向）。
 *
 * 行为逐字节不变：函数体逻辑逐字保留（this.x → host.x / this.method → host.method），
 * 仅 `this` 换 `host`。
 */
import { randomUUID } from 'node:crypto';
import { CompactionId, compactCheckpointSource, toolPairingBalancedAfter, toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { sessionEvents, eventText, asSeq, asSeqs, detectOpenTurn } from './log-access.js';
import { classifyUserMessage } from './graph-build.js';
import { visibleChars } from './budget.js';
import { pushBounded } from './telemetry.js';
/**
 * tombstone 可合并判据（v1.2.x §11.8① 修复）。X 原子中仅「本引擎剪枝墓碑」可安全合并：
 * 文本以 `[elided` 开头、含 pruned by ARGP 与 recall_pruned 取回提示（覆盖默认区间
 * 墓碑与 closure 墓碑两种形态；tool 占位墓碑 `[elided: ...` 缺 pruned by ARGP → 不合并，
 * 且 consolidateTombstoneRuns 只认 user/message 事件，双保险防孤儿 tool_calls）。
 * 其余 X（宿主 system-reminder、官方摘要 checkpoint、注入型 checkpoint）不可动。
 * 导出供测试锁定行为。
 */
export function isMergeableTombstone(text) {
    const t = text.trimStart();
    return t.startsWith('[elided') && t.includes('pruned by ARGP') && t.includes('recall_pruned');
}
/**
 * 一笔事务剪多个极大连续区间：start → summary → 每区间 checkpoint replace → end。
 *  tombstone 类型（2026-08-23 半拆组）：'user' = 普通/闭包墓碑文本；'tool' = tool/result
 *  占位墓碑（克隆原 R data、只改 tool-result block 的 inner text，保留 callId/isError/role/id
 *  ——dsh assertToolResultRewrite 只允许改 inner text），配对 issuer A 的 tool_calls 防 400。
 *
 * 原 class 私有方法；this.x → host.x。
 */
export function pruneIntervals(host, session, intervals, semanticEdges, candidateCount, forced, tombstones, summaryKind) {
    // P1.2（2026-09-21）：事务开始前预校验 tool 占位墓碑的可克隆性。带 tool 墓碑的单 R 区间
    // 必须克隆原 R data（只改 inner text）以配对 issuer A 的 tool_calls；若原事件
    // data/message/content 缺失（损坏事件），旧代码落入 user 墓碑分支 → R 节点被 user/message
    // 替换 → issuer A 的 tool_calls 失去应答 → 序列化 role:"tool" 悬空 → provider 400。
    // 事务前预校验 canCloneTool：无法克隆的单 R 区间从待剪集合剔除（保留该 R 活体、不剪）并
    // warn；后续循环用过滤后的区间集合。循环内守卫保留为防御性 backstop（预校验通过后可达性为零）。
    const canCloneTool = (seq) => {
        const ev = sessionEvents(session)[seq];
        const data = ev?.data;
        const msg = data?.message;
        return data !== undefined && msg !== undefined && msg.content?.[0] !== undefined;
    };
    let useIntervals = intervals;
    let useTombstones = tombstones;
    if (tombstones !== undefined && tombstones.length === intervals.length) {
        const droppedSeqs = [];
        const keptIv = [];
        const keptTs = [];
        for (let i = 0; i < intervals.length; i += 1) {
            const iv = intervals[i];
            const ts = tombstones[i];
            if (ts !== undefined && ts.type === 'tool' && iv.seqs.length === 1 && !canCloneTool(ts.seq)) {
                droppedSeqs.push(ts.seq);
                continue;
            }
            keptIv.push(iv);
            if (ts !== undefined)
                keptTs.push(ts);
        }
        if (droppedSeqs.length > 0) {
            host.log.warn('[argp-graph] tool tombstone clone pre-check failed for seq(s) ' + droppedSeqs.join(',')
                + '; keeping those R node(s) alive (not pruned) to preserve issuer tool_calls pairing');
            // 调用方（图剪）在事务前已把这些原子索引进 prunedNodeIndex；节点保留活体，
            // 删除索引条目保持 recall 账本诚实（活体节点不应出现在 pruned 索引）。
            for (const seq of droppedSeqs)
                host.prunedNodeIndex.delete(seq);
            useIntervals = keptIv;
            useTombstones = keptTs;
        }
    }
    if (useIntervals.length === 0)
        return null;
    const charsBefore = visibleChars(session);
    const openTurn = detectOpenTurn(session);
    const compactionId = CompactionId('argp-graph-' + randomUUID());
    const lifecycle = { compactionId, turn: openTurn };
    const allSeqs = useIntervals.flatMap(iv => iv.seqs);
    const first = useIntervals[0]?.seqs[0] ?? 0;
    const last = useIntervals[useIntervals.length - 1]?.seqs[useIntervals[useIntervals.length - 1].seqs.length - 1] ?? first;
    const startEvent = session.append('compaction/start', {
        ...lifecycle,
        // /compact 溯源：发起命令 ID 随事务事件落账（UI presentation correlation）
        ...host.compactSourceCommandId === undefined ? {} : { sourceCommandId: host.compactSourceCommandId },
    });
    try {
        const shadowedTokenCount = Math.ceil(useIntervals.reduce((s, iv) => s + iv.chars, 0) / host.charsPerToken);
        const resolvedTombstones = useTombstones !== undefined && useTombstones.length === useIntervals.length
            ? useTombstones
            : useIntervals.map(iv => ({
                type: 'user',
                text: '[elided seq=' + iv.seqs[0] + '..' + iv.seqs[iv.seqs.length - 1]
                    + ': ' + iv.seqs.length + ' surface nodes pruned by ARGP (graph order, cites-aware'
                    + (forced ? ', forced' : '') + '); recall_pruned(seq) retrieves original]',
            }));
        const intervalRecords = [];
        let firstPruneSeq;
        for (let i = 0; i < useIntervals.length; i += 1) {
            const iv = useIntervals[i];
            if (iv === undefined)
                continue;
            const start = iv.seqs[0];
            const end = iv.seqs[iv.seqs.length - 1];
            // Shadow-price 契约（宿主 token-meter foldSurfaceProjection）：compaction/prune 的
            // shadowedRange 必须与紧随其后的 surface replace 范围**严格相等**，否则重放投影 throw
            // （2026-09-01 实测：多区间事务发一个总跨度 claim 再逐区间 replace，第一个 replace
            // 即撞总 claim → resume 报 "no adjacent shadow price"）。故每区间一个 shadow-price
            // 事件，范围=该单区间，与官方 compaction-tool-result-pruner 同模式；末尾 summary 的
            // 总范围 claim 被紧随的 off-surface compaction/end 清掉，无契约冲突。
            const intervalPrune = session.append('compaction/prune', {
                shadowedRange: { start: asSeq(start), end: asSeq(end) },
                shadowedSeqs: asSeqs(iv.seqs),
                shadowedTokenCount: Math.ceil(iv.chars / host.charsPerToken),
            });
            if (firstPruneSeq === undefined)
                firstPruneSeq = intervalPrune.seq;
            const ts = resolvedTombstones[i];
            if (ts !== undefined && ts.type === 'tool' && iv.seqs.length === 1) {
                // tool 占位墓碑：克隆原 R data，只改 tool-result block 的 inner text
                const origEvent = sessionEvents(session)[ts.seq];
                const origData = origEvent?.data;
                const origMsg = origData?.message;
                const origBlock = origMsg?.content?.[0];
                if (origData !== undefined && origMsg !== undefined && origBlock !== undefined) {
                    const tombstone = session.append('tool/result', {
                        ...origData,
                        message: {
                            ...origMsg,
                            content: [{
                                    type: 'tool-result',
                                    toolCallId: origBlock.toolCallId ?? ts.callId,
                                    isError: origBlock.isError ?? false,
                                    content: [{ type: 'text', text: '[elided: 旧版本结果已压缩；recall_pruned(seq) 找回原值]' }],
                                }],
                        },
                    }, {
                        surfaceOp: { op: 'replace', startSeq: asSeq(ts.seq), endSeq: asSeq(ts.seq) },
                        sourceEventSeqs: asSeqs([startEvent.seq, intervalPrune.seq, ...iv.seqs]),
                    });
                    intervalRecords.push({ start, end, tombstoneSeq: tombstone.seq });
                    continue;
                }
                // 原 R data 不可用时回退 user 墓碑（安全方向：无结构化 tool-result → 无孤儿配对问题）
            }
            const text = ts !== undefined && ts.type === 'user'
                ? ts.text
                : '[elided seq=' + iv.seqs[0] + '..' + iv.seqs[iv.seqs.length - 1]
                    + ': ' + iv.seqs.length + ' surface nodes pruned by ARGP (graph order, cites-aware'
                    + (forced ? ', forced' : '') + '); recall_pruned(seq) retrieves original]';
            const tombstone = session.append('user/message', createUserMessage({
                content: [{ type: 'text', text }],
                source: compactCheckpointSource(compactionId),
            }), {
                surfaceOp: { op: 'replace', startSeq: asSeq(start), endSeq: asSeq(end) },
                sourceEventSeqs: asSeqs([startEvent.seq, intervalPrune.seq, ...iv.seqs]),
            });
            intervalRecords.push({ start, end, tombstoneSeq: tombstone.seq });
        }
        // 人类可读剪枝摘要（2026-08-28 UI 联调）：compaction 节点的展示文本来自
        // compaction/summary 事件；不发则 WebUI 显示"压缩摘要不可用"。off-surface
        // 日志事件，模型不可见。payload 按 CompactionSummary 词典填诚实值，类型走 as never。
        const prunedCount = useIntervals.reduce((sum, iv) => sum + iv.atoms.length, 0);
        const charsBefore0 = useIntervals.reduce((sum, iv) => sum + iv.chars, 0);
        session.append('compaction/summary', {
            ...lifecycle,
            summary: [{
                    type: 'text',
                    text: summaryKind === 'tombstone-merge'
                        ? `ARGP 墓碑归并（§11.8①）：${prunedCount} 墓碑 / ${useIntervals.length} 区间归并为聚合占位（约 ${Math.ceil(charsBefore0 / host.charsPerToken)} tok 回收）；0-LLM；原文保留在 append-only 日志，recall_pruned(seq) / list_pruned 可取回`
                        : `ARGP 图剪：${prunedCount} 原子 / ${useIntervals.length} 区间（约 ${Math.ceil(charsBefore0 / host.charsPerToken)} tok）；确定性排序，0-LLM；原文保留在 append-only 日志，recall_pruned(seq) / list_pruned 可取回`,
                }],
            shadowedRange: { start: first, end: last },
            shadowedSeqs: allSeqs,
            shadowedTokenCount: Math.ceil(charsBefore0 / host.charsPerToken),
            provider: 'argp',
            model: 'deterministic-guards',
        });
        const endEvent = session.append('compaction/end', lifecycle);
        const charsAfter = visibleChars(session);
        pushBounded(host.records, {
            at: new Date().toISOString(),
            compactionId,
            ...host.compactSourceCommandId === undefined ? {} : { sourceCommandId: host.compactSourceCommandId },
            intervals: intervalRecords,
            startEventSeq: startEvent.seq,
            summaryEventSeq: firstPruneSeq ?? startEvent.seq,
            endEventSeq: endEvent.seq,
            shadowedSeqs: allSeqs,
            prunedAtoms: useIntervals.flatMap(iv => iv.atoms.map(a => ({ id: a.id, type: a.type, seq: a.seq }))),
            semanticEdges,
            candidates: candidateCount,
            charsBefore,
            charsAfter,
            forced,
        }, host.telemetryCap);
        // P7：一笔 compaction 事务成功即重置 recall 字数预算（视图已换代，旧累计不应继续压制新一轮召回）
        host.recallCharsUsed = 0;
        // 2026-08-23：压缩换代 surface——旧真实锚点（压缩前的 provider usage）失效，
        // 若保留会用大锚点 + 增量导致压缩后立即误触发。用压缩后 surface 估算重置锚点
        // （压缩后 surface 小、估算误差影响小；下一次请求的 usage 会再次精确锚定）。
        const nodes = session.surface.nodes;
        const tailSeq = nodes.length > 0 ? nodes[nodes.length - 1] : -1;
        host.lastRealPromptTokens = Math.ceil(visibleChars(session) / host.charsPerToken);
        host.lastRealAnchorSeq = typeof tailSeq === 'number' ? tailSeq : host.lastRealAnchorSeq;
        // 永久冻结：落剪不再刷新 frozenCatalog（见 bindSession 注释）。剪枝本身已让可见上下文换代，
        // 那一步的前缀缓存失效是上下文真实变更的必然代价；但 catalog 文本恒定，不在这条路上再变一次。
        return {
            compactionId,
            startSeq: asSeq(startEvent.seq),
            summarySeq: asSeq(firstPruneSeq ?? startEvent.seq),
            endSeq: asSeq(endEvent.seq),
            summary: resolvedTombstones.map(ts => ({ type: 'text', text: ts.type === 'tool'
                    ? '[elided tool result; recall_pruned(seq) retrieves original]' : ts.text })),
            shadowedRange: { start: asSeq(first), end: asSeq(last) },
            shadowedSeqs: asSeqs(allSeqs),
            shadowedTokenCount,
        };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        try {
            session.append('compaction/end', { ...lifecycle, error: message });
        }
        catch {
            // 关闭失败保留未配对 start，可被 inspectCompactionEntryState 检出
        }
        throw error;
    }
}
/**
 * tombstone 归并（v1.2.x §11.8① 修复）。扫描 surface，找**连续**的「可合并墓碑」X 段
 * （user/message + isMergeableTombstone 文本），段长 ≥ tombstoneMergeMinRun 时一笔事务
 * replace 成单条聚合墓碑（列出原 tombstone seqs → 原文仍 recall_pruned(seq) 可取回）。
 * 复用 pruneIntervals 事务骨架（含 shadow-price 契约、summary、锚点重置）。
 * 每 pass 至多一段——失败回退范围清晰。返回被归并的墓碑节点数（0 = 无可归并）。
 * tool 占位墓碑（type=tool）与 system-reminder / 官方 checkpoint（不含 pruned by ARGP）
 * 均被 isMergeableTombstone / 事件类型过滤挡住，不会被吞。
 *
 * 原 class 私有方法；this.x → host.x。
 */
export function consolidateTombstones(host, session) {
    if (host.tombstoneMergeMinRun <= 0)
        return 0;
    const nodes = [...session.surface.nodes];
    // 1) 收集每个 surface 节点的「可合并墓碑」布尔
    const isTomb = new Array(nodes.length);
    for (let i = 0; i < nodes.length; i += 1) {
        const seq = nodes[i];
        const ev = sessionEvents(session)[seq];
        if (ev === undefined || ev.type !== 'user/message') {
            isTomb[i] = false;
            continue;
        }
        if (classifyUserMessage(ev.data) !== 'X') {
            isTomb[i] = false;
            continue;
        }
        isTomb[i] = isMergeableTombstone(eventText(session, seq));
    }
    // 2) 找第一段长度 ≥ minRun 的连续墓碑
    const minRun = host.tombstoneMergeMinRun;
    let runStart = -1, runEnd = -1;
    for (let i = 0; i <= nodes.length; i += 1) {
        const inRun = i < nodes.length && isTomb[i];
        if (inRun) {
            if (runStart === -1)
                runStart = i;
        }
        else if (runStart !== -1) {
            const len = i - runStart;
            if (len >= minRun) {
                runEnd = i - 1;
                break;
            }
            runStart = -1;
        }
    }
    if (runStart === -1 || runEnd === -1)
        return 0;
    // 3) 校验事务边界 tool-pairing 平衡（与 compactRegion 同判据），不平衡则放弃归并
    if (!toolPairingBalancedBefore(session, nodes[runStart]) || !toolPairingBalancedAfter(session, nodes[runEnd])) {
        host.log.info('[argp-graph] tombstone-merge: boundary not tool-pairing balanced, skip');
        return 0;
    }
    const tombSeqs = nodes.slice(runStart, runEnd + 1);
    const tombAtoms = tombSeqs.map(seq => ({
        id: -1, seq, type: 'X', turn: 0,
        text: eventText(session, seq), toolCallIds: [], cites: [], citesFailed: false,
    }));
    const chars = tombAtoms.reduce((s, a) => s + a.text.length, 0);
    const interval = { seqs: tombSeqs, chars, atoms: tombAtoms };
    // 聚合墓碑文本：保持「[elided … pruned by ARGP … recall_pruned」形态（自身可再归并，
    // 地板随压缩次数收敛到常数；seq 跨度显式保留，被吞聚合的内部 seq 可递归 recall）。
    const aggText = '[elided consolidated ×' + tombSeqs.length + ' seqs=' + tombSeqs[0] + '..' + tombSeqs[tombSeqs.length - 1]
        + ': these placeholder nodes were themselves pruned by ARGP (tombstone-merge, §11.8); originals remain recallable via recall_pruned(seq) / list_pruned]';
    try {
        pruneIntervals(host, session, [interval], 0, 0, true, [{ type: 'user', text: aggText }], 'tombstone-merge');
    }
    catch (error) {
        // 归并是「优化地板」的尽力步骤，失败不阻断主图剪（回退：墓碑继续累积，由 overflow 三步序列兜底）
        host.log.warn('[argp-graph] tombstone-merge failed (non-fatal): ' + (error instanceof Error ? error.message : String(error)));
        return 0;
    }
    return tombSeqs.length;
}
/** 手动多区间压缩：逐段复核边界后合并为一笔事务剪除。
 *  边界复核与 compactRegion 同口径（配对平衡 / 段内不含 U/X / 段内有可剪原子），
 *  任一区间不合格则**静默剔除该区间**（而非整体失败）——手动入口的语义是"能剪多少剪多少"。
 *  返回 null = 全部区间都被剔除（无可剪内容），调用方据此显示 "No compactable history yet."。
 *
 * 原 class 私有方法；this.x → host.x，this.bindSession → host.bindSession，
 * this.atomize → host.atomize，this.pruneIntervals → pruneIntervals(host, ...)。
 */
export function compactRegions(host, ranges, agent, signal) {
    if (ranges.length === 0)
        return null;
    host.bindSession(agent.session); // A7（问题 3）：统一绑定 + 账目懒重建
    signal.throwIfAborted();
    const session = agent.session;
    const nodes = session.surface.nodes;
    const bySeq = new Map(host.atomize(session).map(a => [a.seq, a]));
    const intervals = [];
    for (const range of ranges) {
        const startIdx = nodes.indexOf(asSeq(range.start));
        const endIdx = nodes.indexOf(asSeq(range.end));
        if (startIdx === -1 || endIdx === -1 || startIdx > endIdx)
            continue;
        if (!toolPairingBalancedBefore(session, nodes[startIdx]))
            continue;
        if (!toolPairingBalancedAfter(session, nodes[endIdx]))
            continue;
        const shadowedSeqs = nodes.slice(startIdx, endIdx + 1);
        const intervalAtoms = shadowedSeqs.map(seq => bySeq.get(seq)).filter((a) => a !== undefined);
        if (intervalAtoms.length === 0)
            continue;
        if (intervalAtoms.some(a => a.type === 'U' || a.type === 'X'))
            continue;
        const chars = intervalAtoms.reduce((sum, a) => sum + a.text.length, 0);
        intervals.push({ seqs: shadowedSeqs, chars, atoms: intervalAtoms });
    }
    if (intervals.length === 0)
        return null;
    return pruneIntervals(host, session, intervals, 0, 0, true);
}
/** 为手动 compactNow 选择**全部**可剪的极大连续 A/R 段（确定性、由旧到新）。
 *
 *  入选判据（与旧版一致，仅去掉"遇阻即停"）：段内原子必须
 *  ① 是对话载体 A/R（U/X 不参剪，手动入口不剪骨架，见 compactRegion 的 P5 约束）；
 *  ② 不落在 turnGuard（最近 N 轮）与 recencyGuard（surface 末尾 N 节点）保护窗口内。
 *
 *  修复（2026-09-21）：旧实现扫到第一个不合格节点就 `break`，而真实会话的 surface 被
 *  用户消息切成「U A R A R U A R …」多段结构 ⇒ 手动 /compact 永远只剪最老一小段
 *  （表现为"图剪压不动"）。现在改为收集全部极大连续段，交给一笔 pruneIntervals 事务剪除。
 *
 * 原 class 私有方法；this.atomize → host.atomize，this.recencyGuard/turnGuard → host.*。
 */
export function selectManualRanges(host, session) {
    const surfaceSeqs = session.surface.nodes;
    const atoms = host.atomize(session);
    const bySeq = new Map(atoms.map(a => [a.seq, a]));
    const latestTurn = atoms.reduce((m, a) => Math.max(m, a.turn), 0);
    const recencyCut = Math.max(0, surfaceSeqs.length - host.recencyGuard);
    const ranges = [];
    let start = null;
    let end = -1;
    const flush = () => {
        if (start !== null)
            ranges.push({ start, end });
        start = null;
        end = -1;
    };
    for (let i = 0; i < surfaceSeqs.length; i += 1) {
        const seq = surfaceSeqs[i];
        const atom = bySeq.get(seq);
        const eligible = atom !== undefined
            && atom.type !== 'U' && atom.type !== 'X'
            && atom.turn <= latestTurn - host.turnGuard
            && i < recencyCut;
        if (!eligible) {
            flush(); // 不合格节点就地闭合当前段（不再终止整个扫描）
            continue;
        }
        if (start === null)
            start = seq;
        end = seq;
    }
    flush();
    return ranges;
}
/**
 * 手动单区间压缩（override compactRegion）。
 *
 * 原 class override 方法；this.x → host.x，this.bindSession → host.bindSession，
 * this.atomize → host.atomize，this.pruneIntervals → pruneIntervals(host, ...)。
 */
export function compactRegion(host, start, end, agent, signal) {
    host.bindSession(agent.session); // A7（问题 3）：统一绑定 + 账目懒重建
    signal?.throwIfAborted();
    const session = agent.session;
    const nodes = session.surface.nodes;
    const startIdx = nodes.indexOf(asSeq(start));
    const endIdx = nodes.indexOf(asSeq(end));
    if (startIdx === -1)
        throw new Error('compactRegion: start seq ' + start + ' not found in surface');
    if (endIdx === -1)
        throw new Error('compactRegion: end seq ' + end + ' not found in surface');
    if (startIdx > endIdx)
        throw new Error('compactRegion: start seq ' + start + ' is after end seq ' + end + ' on the surface');
    if (!toolPairingBalancedBefore(session, nodes[startIdx]))
        throw new Error('compactRegion: start seq ' + start + ' is not a balanced boundary');
    if (!toolPairingBalancedAfter(session, nodes[endIdx]))
        throw new Error('compactRegion: end seq ' + end + ' is not a balanced boundary');
    const shadowedSeqs = nodes.slice(startIdx, endIdx + 1);
    const atoms = host.atomize(session);
    const bySeq = new Map(atoms.map(a => [a.seq, a]));
    const intervalAtoms = shadowedSeqs.map(seq => bySeq.get(seq)).filter((a) => a !== undefined);
    if (intervalAtoms.some(a => a.type === 'U' || a.type === 'X')) {
        // P5：措辞 scoped 到手动入口。自动闭包生命周期（compactIfNeeded 降级链内联）确实会连 root U
        // （task-init）与 X checkpoint 一起剪除；"ARGP never prunes U/X" 只对本手动入口成立。
        throw new Error('compactRegion (manual) does not prune U/X spans; choose a span without U/X, '
            + 'or let the automatic closure lifecycle retire those nodes together with their closure');
    }
    if (intervalAtoms.length === 0) {
        throw new Error('compactRegion: selected span contains no prunable A/R atoms');
    }
    const chars = intervalAtoms.reduce((sum, a) => sum + a.text.length, 0);
    const interval = { seqs: shadowedSeqs, chars, atoms: intervalAtoms };
    // 本入口不传 tombstones → pruneIntervals 的 P1.2 预校验不会剔除任何区间，null 不可达。
    const result = pruneIntervals(host, session, [interval], 0, 0, true);
    if (result === null)
        throw new Error('compactRegion: pruneIntervals unexpectedly returned null (no tombstones passed; unreachable)');
    return result;
}
