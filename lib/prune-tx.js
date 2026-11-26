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
import { createDeveloperMessage, createUserMessage } from '@deepseek-ai/dsh-llm';
import { sessionEvents, asSeq, asSeqs, detectOpenTurn } from './log-access.js';
import { visibleChars, visibleCharStats } from './budget.js';
import { estTokensFromStats } from './cjk.js';
import { shadowedTokensOf } from './constants.js';
import { pushBounded } from './telemetry.js';
import { isMergeableTombstoneText, seqRangeTombstone, toolTombstone, toolTombstoneSummary } from './tombstone-text.js';
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
/**
 * 一笔事务剪多个极大连续区间：start → summary → 每区间 checkpoint replace → end。
 * 发射前先做**相邻同文 user 墓碑归并**（surface 紧邻 + 文本逐字节相同 ⇒ 并条；
 * 2026-11-26 桩游程治理，见 pruneIntervals 内注释）。
 *  tombstone 类型（半拆组）：'user' = 普通/闭包墓碑文本；'tool' = tool/result
 *  占位墓碑（克隆原 R data、只改 inner text——V4 换 content 为单 text block / V3 改 tool-result block，
 *  保留 callId/isError/role/id——dsh assertToolResultRewrite 只允许改 inner text），配对 issuer A 的 tool_calls 防 400；
 *  'developer' = 协议组整组离场的空占位（content:[]，source.form='argp-removed'；宿主请求投影
 *  丢弃未注册 developer ⇒ 模型零可见，不是 user 消息、不伪造轮边界）。
 */
export function pruneIntervals(host, session, intervals, semanticEdges, candidateCount, forced, tombstones, summaryKind, 
/** §G2：LLM 摘要调用的真实账单/信封回填 compaction/summary（宿主字段词典；0-LLM 事务不传）。 */
summaryMeta) {
    // P1.2（2026-09-21）：事务开始前预校验 tool 占位墓碑的可克隆性。带 tool 墓碑的单 R 区间
    // 必须克隆原 R data（只改 inner text）以配对 issuer A 的 tool_calls；若原事件
    // data/message/content 缺失（损坏事件），旧代码落入 user 墓碑分支 → R 节点被 user/message
    // 替换 → issuer A 的 tool_calls 失去应答 → 序列化 role:"tool" 悬空 → provider 400。
    // 事务前预校验 canCloneTool：无法克隆的单 R 区间从待剪集合剔除（保留该 R 活体、不剪）并
    // warn；后续循环用过滤后的区间集合。循环内守卫保留为防御性 backstop（预校验通过后可达性为零）。
    const canCloneTool = (seq) => {
        const ev = sessionEvents(session)[seq];
        const data = ev?.data;
        // 双形状：V4（role:'tool'，content 是 ContentBlock[]）与 V3（role:'user'，content[0] 是
        // tool-result block）都有非空 content ⇒ 可克隆；data/message/content 缺失即损坏事件。
        const msg = data?.message;
        return data !== undefined && msg !== undefined && msg.content?.[0] !== undefined;
    };
    const st = host.stateOf(session);
    let useIntervals = intervals;
    let useTombstones = tombstones;
    // 2.2.2 存档加载地雷锁（2026-11-26 session-43df801e 案）：宿主 v4 fold（加载侧
    // dsh-session-format-v3-to-v4 与请求侧重建同口径）要求**非 append 的 tool/result 必须
    // 处于开放轮内**，而写入侧（Session.append 核心）不拦——轮次间隙手动 /compact 落
    // tool 桩 = 当场成功、下次加载整档判 corrupt。prune-tx 是 tool 桩唯一出口，预检按
    // detectOpenTurn 一刀切：无开放轮 ⇒ tool 桩区间剔除（R 保留活体，NP10 漏剪同方向；
    // 不可降级成 user 桩——issuer 广告仍在，孤儿 tool result 撞 provider 400）。
    // 自动路径恒在轮内（pre-step 有 turn/start 无 turn/end）⇒ 常态零行为变化。
    const openTurnPre = detectOpenTurn(session);
    if (tombstones !== undefined && tombstones.length === intervals.length) {
        const droppedSeqs = [];
        const droppedNoTurn = [];
        const keptIv = [];
        const keptTs = [];
        for (let i = 0; i < intervals.length; i += 1) {
            const iv = intervals[i];
            const ts = tombstones[i];
            if (ts !== undefined && ts.type === 'tool' && iv.seqs.length === 1) {
                if (openTurnPre === null) {
                    droppedNoTurn.push(ts.seq);
                    continue;
                }
                if (!canCloneTool(ts.seq)) {
                    droppedSeqs.push(ts.seq);
                    continue;
                }
            }
            keptIv.push(iv);
            if (ts !== undefined)
                keptTs.push(ts);
        }
        if (droppedNoTurn.length > 0) {
            host.log.warn('[argp-engine] tool tombstone(s) dropped for seq(s) ' + droppedNoTurn.join(',')
                + ': no open turn (host v4 fold requires non-append tool/result inside an open turn;'
                + ' keeping those R node(s) alive — not pruned)');
        }
        if (droppedSeqs.length > 0 || droppedNoTurn.length > 0) {
            if (droppedSeqs.length > 0) {
                host.log.warn('[argp-engine] tool tombstone clone pre-check failed for seq(s) ' + droppedSeqs.join(',')
                    + '; keeping those R node(s) alive (not pruned) to preserve issuer tool_calls pairing');
            }
            // 调用方（图剪）在事务前已把这些原子索引进 prunedNodeIndex；节点保留活体，
            // 删除索引条目保持 recall 账本诚实（活体节点不应出现在 pruned 索引）。
            for (const seq of droppedSeqs)
                st.prunedNodeIndex.delete(seq);
            for (const seq of droppedNoTurn)
                st.prunedNodeIndex.delete(seq);
            useIntervals = keptIv;
            useTombstones = keptTs;
        }
    }
    if (useIntervals.length === 0)
        return null;
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
        if (useTombstones !== undefined && useTombstones.length === useIntervals.length) {
            const srcTs = useTombstones;
            useTombstones = order.map(i => srcTs[i]);
        }
        useIntervals = sortedIntervals;
    }
    // ---- 相邻同文墓碑归并（2026-11-26 session-43df801e 审计）----
    // 一笔 114 区间的扫荡在表面产出 run=96 的同 9 字桩连排：角色交替破坏，模型读到
    // 「用户连说 96 遍同一句话」。§11.8 归并通道随图臂退役（compactRegion 拒发），factor
    // 世界零桩治理。规则：区间在 surface.nodes 上**紧邻**（next.seqs[0] 恰随 prev 末 seq，
    // 中间无活体）且两条墓碑均为 user 且文本**逐字节相同** ⇒ 传递并条。同文相邻对模型
    // 本已不可分辨 ⇒ 归并零信息损失；交互桩各组文本含不同 keys ⇒ 不并（指针语义保留）；
    // tool/developer 结构性桩不参与（callId/空占位语义）。P1-5 数量校验随 resolved
    // 计算上移到 start 事件之前：错配更早拒发，不再留 start+summary 死括号。
    if (useTombstones !== undefined && useTombstones.length !== useIntervals.length) {
        // 审查 P1-5：绝不能静默回退到 seq 指针墓碑（零指针纪律）；数量错配 = 调用方 bug。
        throw new Error('prune-tx: tombstone count mismatch (' + useTombstones.length + ' vs ' + useIntervals.length + '); refusing pointer fallback');
    }
    let resolvedTombstones = useTombstones !== undefined && useTombstones.length === useIntervals.length
        ? useTombstones
        : useIntervals.map(iv => ({
            type: 'user',
            text: seqRangeTombstone(iv.seqs[0], iv.seqs[iv.seqs.length - 1]),
        }));
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
            if (prevIv !== undefined && prevTs !== undefined && ts.type === 'user' && prevTs.type === 'user' && ts.text === prevTs.text) {
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
        const charsBefore0 = useIntervals.reduce((sum, iv) => sum + iv.chars, 0);
        session.append('compaction/summary', {
            ...lifecycle,
            ...sourceCommandIdField,
            summary: [{
                    type: 'text',
                    text: summaryKind === 'tombstone-merge'
                        // 归并事务的区间 atoms 恒空（剪的是桩本身）⇒ 计数取表面节点数，不取 atoms。
                        ? `ARGP 墓碑归并（§11.8①）：${useIntervals.reduce((s, iv) => s + iv.seqs.length, 0)} 墓碑 / ${useIntervals.length} 区间归并为聚合占位（约 ${shadowedTokensOf(charsBefore0)} tok 回收）；0-LLM；原文保留在 append-only 日志，search_history(keyword) / recall_history(labels) 可取回`
                        : summaryKind === 'factor-prune'
                            ? `ARGP 协议组剪：${prunedCount} 原子 / ${useIntervals.length} 区间（约 ${shadowedTokensOf(charsBefore0)} tok）；A+R 组整体离场 + 压缩检查点占位（普通组中性标记「已压缩剪枝次要原子」；交互组专段带 tool: 即时指针）；原文保留在 append-only 日志，recall_history(labels) 可取回`
                            : summaryKind === 'factor-prose'
                                ? `ARGP 散文浓缩：${prunedCount} 原子 / ${useIntervals.length} 区间（约 ${shadowedTokensOf(charsBefore0)} tok）；清扫式合并（焦点外前缀一轮全吞，§9.36 H2 终裁）+ one-shot 原生式 LLM 浓缩（输入=U+final A/textA，工具原子零进）；无逐字转写带（原始信息有 recall 兜底），整轮段无逐原子墓碑`
                                : `ARGP 图剪：${prunedCount} 原子 / ${useIntervals.length} 区间（约 ${shadowedTokensOf(charsBefore0)} tok）；确定性排序，0-LLM；原文保留在 append-only 日志，recall_pruned(seq) / list_pruned 可取回`,
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
            // shadowedRange 必须与紧随其后的 surface replace 范围**严格相等**，否则重放投影 throw
            // （2026-09-01 实测：多区间事务发一个总跨度 claim 再逐区间 replace，第一个 replace
            // 即撞总 claim → resume 报 "no adjacent shadow price"）。故每区间一个 shadow-price
            // 事件，范围=该单区间，与官方 compaction-tool-result-pruner 同模式；末尾 summary 的
            // 总范围 claim 被紧随的 off-surface compaction/end 清掉，无契约冲突。
            const intervalPrune = session.append('compaction/prune', {
                shadowedRange: { start: asSeq(start), end: asSeq(end) },
                shadowedSeqs: asSeqs(iv.seqs),
                shadowedTokenCount: shadowedTokensOf(iv.chars),
            });
            if (firstPruneSeq === undefined)
                firstPruneSeq = intervalPrune.seq;
            const ts = resolvedTombstones[i];
            if (ts !== undefined && ts.type === 'developer') {
                // 协议组（A+R）整组离场的空占位：模型不可见（宿主请求投影丢弃未注册 developer），
                // 无文字/指针；召回走 FactorLedger 标签 + 词表 note。不是 user 消息，不伪造轮边界。
                // interval 类型自检（审查 P1-5）：developer 只允许 group / a / orphan 三形态。
                if (ts.kind === 'group' && !iv.atoms.some(a => a.type === 'A')) {
                    throw new Error('prune-tx: developer group tombstone requires an A atom in the interval');
                }
                if (ts.kind === 'a' && iv.atoms[0]?.type !== 'A') {
                    throw new Error('prune-tx: developer A tombstone requires an A-only interval');
                }
                if (ts.kind === 'orphan' && !(iv.seqs.length === 1 && iv.atoms[0]?.type === 'R')) {
                    throw new Error('prune-tx: developer orphan tombstone requires a single R interval');
                }
                const turn = typeof iv.atoms[0]?.turn === 'number'
                    ? iv.atoms[0].turn : 0;
                const tombstone = session.append('developer/message', {
                    turn,
                    step: 1,
                    message: createDeveloperMessage({
                        content: [],
                        source: { kind: 'argp', form: ts.form ?? 'argp-removed' },
                    }),
                }, {
                    surfaceOp: { op: 'replace', startSeq: asSeq(start), endSeq: asSeq(end) },
                    sourceEventSeqs: asSeqs([startEvent.seq, intervalPrune.seq, ...iv.seqs]),
                });
                intervalRecords.push({ start, end, tombstoneSeq: tombstone.seq });
                continue;
            }
            if (ts !== undefined && ts.type === 'tool' && iv.seqs.length === 1) {
                // tool 占位墓碑：克隆原 R data，只改 inner text（V4 换 content 为单 text block；V3 改 tool-result block）
                const origEvent = sessionEvents(session)[ts.seq];
                const origData = origEvent?.data;
                const origMsg = origData?.message;
                const origBlock = origMsg?.content?.[0];
                if (origData !== undefined && origMsg !== undefined && origBlock !== undefined) {
                    // G2：文案自带**原始 R 的 log seq**（ts.seq 已在手，零额外查询）——
                    // 只写 `recall_pruned(seq)` 却不给 seq 会逼模型绕一步反查，通路等于断的。
                    // factor 臂传自定义最小桩（design-2.0 §1.2：桩文本禁引退役工具名，
                    // 缺省 toolTombstone 是图臂墓碑文法）。
                    const elidedText = ts.text ?? toolTombstone(ts.seq);
                    // V4（0.1.7）：role:'tool' 顶层 toolCallId/isError 经展开保留，content 换单 text block；
                    // V3（≤0.1.6）：role:'user' 内嵌 tool-result block，只改其 inner text。
                    const newContent = origMsg.role === 'tool'
                        ? [{ type: 'text', text: elidedText }]
                        : [{
                                type: 'tool-result',
                                toolCallId: origBlock.toolCallId ?? ts.callId,
                                isError: origBlock.isError ?? false,
                                content: [{ type: 'text', text: elidedText }],
                            }];
                    const tombstone = session.append('tool/result', {
                        ...origData,
                        message: {
                            ...origMsg,
                            content: newContent,
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
                : seqRangeTombstone(iv.seqs[0], iv.seqs[iv.seqs.length - 1]);
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
            semanticEdges,
            candidates: candidateCount,
            charsBefore,
            charsAfter,
            forced,
        }, host.telemetryCap);
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
            summary: resolvedTombstones.map(ts => ({ type: 'text', text: ts.type === 'tool'
                    ? toolTombstoneSummary()
                    : ts.type === 'developer' ? 'ARGP 协议组剪（A+R 整组离场，空 developer 占位）' : ts.text })),
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
