import { isArgpUserInfo } from './peratom/types.js';
/**
 * 跨宿主版本兼容的事件日志读取（P1 → 1.0.2 升级阻断修复）。
 *
 * dsh 0.1.2-alpha.4 的 breaking 重构 `27bf1039db refactor(session)!: distinguish
 * event seqs from log offsets` 移除了 `Session.events` getter（运行时 `undefined`），
 * 替代为 `snapshotEvents()`（frozen 全日志快照）/ `eventAt(seq)`。rc.2 仍有 `events`
 * getter。为同时兼容两个宿主，本 helper 运行时探测：
 *
 *   - 宿主 Session 提供 `snapshotEvents`（alpha.4+）→ 调 `snapshotEvents()`
 *   - 否则回退到 legacy `session.events`（rc.2）
 *
 * **1.1.0 起（2026-09-10）支持基线上移到 0.1.5-rc.1**：该版本 `events` getter 已彻底
 * 移除、`snapshotEvents()` 是唯一真实路径，故 legacy 分支在受支持范围内**不可达**，
 * 仅作为宿主形态回退的防御保留（由 stub 用例覆盖，见
 * test/session-events-compat.test.ts「legacy 分支回退 events getter」）。将来若要
 * 清理，须同步删掉该 stub 用例，否则会失去"宿主回退形态"的哨兵。
 *
 * 两个路径都返回 frozen 数组，语义完全一致（不可变、与后续 append 解耦）。
 * 本 helper 是 ARGP 全代码库唯一允许直接触碰"事件日志"的入口——任何新增
 * `session.events[...]` / `for ... of session.events` 都视为违规。
 */
export function sessionEvents(session) {
    const modern = session.snapshotEvents;
    if (typeof modern === 'function')
        return modern.call(session);
    const legacy = session.events;
    if (legacy !== undefined)
        return legacy;
    throw new Error('dsh-argp: session exposes neither events nor snapshotEvents; check dsh version compatibility');
}
/**
 * 事件 turn 号类型化访问器（C-S7 收敛，P5 Wave 3 第 3 步）。
 *
 * 根因：宿主包 dsh-session 的 `SessionEvent` 虽是判别联合，但 `turn` 不是公共字段
 * （仅 turn/start、turn/end、step/*、assistant/message 等部分事件携带），宿主类型
 * 无法加公共 `turn` 字段，代码库各处因此各自 `event.data as { turn }` 强转。
 * 本访问器把该强转集中到一处：data 带 number 型 turn 时返回 turn 号，
 * 否则 undefined（如 user/message 无 turn 字段）。
 */
export function turnOf(event) {
    const turn = event.data?.turn;
    return typeof turn === 'number' ? turn : undefined;
}
/**
 * 从一个事件投影出模型可见文本（text + tool-call 概要 + tool-result 内层 text；reasoning 不算）。
 *
 * P5 结构重构 Wave 3 第 1 步：自 hub `argp-graph-engine.ts` 迁入本叶子——本函数只依赖
 * `sessionEvents`（本模块）+ 纯数据操作，不触碰任何 hub 运行时（无 this.ctx / engine 状态），
 * 故可安全下沉。迁移消除了 peratom/recall-zoom → hub 的运行时回边（recall-zoom 现直接
 * 从本模块 import）。hub 侧保留 `export { eventText } from './log-access.js'` 转发以维持
 * 既有公共 API 与测试 import 不变。
 */
export function eventText(session, seq) {
    const event = sessionEvents(session)[seq];
    if (event === undefined)
        return '';
    const data = event.data;
    const parts = [];
    if (event.type === 'tool/call') {
        const d = data;
        parts.push('[tool-call ' + (d?.name ?? '?') + '(' + (typeof d?.arguments === 'string' ? d.arguments : JSON.stringify(d?.arguments ?? {})) + ')]');
        return parts.join('\n');
    }
    // dsh event shapes differ by type: user/message carries content at data.content,
    // assistant/message and tool/result carry it at data.message.content.
    const rawContent = event.type === 'user/message'
        ? data?.content
        : data?.message?.content;
    const content = Array.isArray(rawContent) ? rawContent : [];
    for (const block of content) {
        if (block.type === 'text' && typeof block.text === 'string')
            parts.push(block.text);
        if (block.type === 'tool-call') {
            parts.push('[tool-call ' + (block.name ?? '?') + '(' + (typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments ?? {})) + ')]');
        }
        if (block.type === 'tool-result') {
            for (const inner of block.content ?? [])
                if (inner.type === 'text' && typeof inner.text === 'string')
                    parts.push(inner.text);
        }
    }
    return parts.join('\n');
}
/**
 * 日志尾部的 open turn（从日志末尾向前找：最近的 turn/start 且其后无 turn/end）。
 *
 * P5 Wave 3 第 3 步：自 `ArgpGraphEngine.detectOpenTurn`（private 方法）与
 * `peratom/compressor.ts` 模块级函数两份逐字相同实现收敛到本叶子（只读
 * sessionEvents）。返回 open turn 号；无开放轮（末尾已闭合 / 会话头）返回 null。
 */
export function detectOpenTurn(session) {
    const events = sessionEvents(session);
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event === undefined)
            continue;
        if (event.type === 'turn/start')
            return turnOf(event) ?? null;
        if (event.type === 'turn/end')
            return null;
    }
    return null;
}
/**
 * 主链 reasoningEffort：从最近一条携带 `config.reasoningEffort` 的 `request/header`
 * 事件重建（LlmCallConfig 无 chat_template_kwargs 字段，只有 reasoningEffort——
 * 故从它重建，非读现成 ctk）。
 *
 * P5 Wave 3 第 3 步：自 `peratom/compressor.ts` 与 `peratom/cite-declarer.ts`
 * 两份逐字相同的抽取强转循环（方案 B ctk 的主链对齐部分）收敛到本叶子
 * （只读 sessionEvents）。无声明返回 undefined。
 */
export function mainChainReasoningEffort(session) {
    const events = sessionEvents(session);
    for (let i = events.length - 1; i >= 0; i -= 1) {
        const event = events[i];
        if (event?.type !== 'request/header')
            continue;
        const cfg = event.data?.header?.config;
        if (cfg?.reasoningEffort !== undefined)
            return cfg.reasoningEffort;
    }
    return undefined;
}
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
export function asSeq(value) {
    return value;
}
/**
 * {@link asSeq} 的数组版本，用于 `sourceEventSeqs` / `shadowedSeqs` 等 seq 列表字段。
 * @param values - ARGP 内部计算的 seq 列表。
 * @returns 同序新数组，元素类型收窄为 SessionSeq。
 */
export function asSeqs(values) {
    return values.map(value => value);
}
/**
 * 全日志扫描收集被遮蔽 surface seq（权威剪枝账本：compaction/prune.shadowedSeqs 的并集）。
 *
 * 2026-08-27：与 ArgpGraphEngine.shadowedSeqsOf 对齐——只认 compaction/prune 事件
 * （pruneIntervals 每次真剪枝必发，shadowedSeqs 即被剪 seq 权威清单）。此前靠
 * 「replace 形态推断」（任何 surfaceOp replace 的 sourceEventSeqs 都算 shadowed），
 * 会把 per-atom 原地压缩（peratom/compressor.ts 的副本，无 compaction/prune 事件）误判为
 * shadowed，导致 recall_summary/recall_detail 对压缩原子谎报 state=shadowed（同一反模式的
 * 第二条路径，且连 argpCites 门控都没有，比 shadowedSeqsOf 更激进）。
 */
export function scanShadowedSeqs(session) {
    const shadowed = new Set();
    for (const event of sessionEvents(session)) {
        if (event.type !== 'compaction/prune')
            continue;
        const seqs = event.data.shadowedSeqs;
        if (Array.isArray(seqs)) {
            for (const seq of seqs)
                shadowed.add(seq);
        }
    }
    return shadowed;
}
const RECON_ARGS_NOTE = 'tool-call arguments are a JSON semantic-equivalent reconstruction (the host stores them as an object), not the original literal';
/** {@link rawEventText} 的 tool-call 参数投影：字符串逐字，对象 JSON 语义等价重建。 */
function toolCallProjection(name, args) {
    if (typeof args === 'string')
        return { text: '[tool-call ' + (name ?? '?') + '(' + args + ')]', reconstructed: false };
    return { text: '[tool-call ' + (name ?? '?') + '(' + JSON.stringify(args ?? {}) + ')]', reconstructed: true };
}
export function rawEventText(session, seq) {
    const event = sessionEvents(session)[seq];
    if (event === undefined)
        return null;
    const data = event.data;
    if (event.type === 'tool/call') {
        const d = data;
        const p = toolCallProjection(d?.name, d?.arguments);
        return { text: p.text, reconstructed: p.reconstructed, note: p.reconstructed ? RECON_ARGS_NOTE : undefined };
    }
    // dsh event shapes differ by type: user/message carries content at data.content,
    // assistant/message and tool/result carry it at data.message.content.
    const rawContent = event.type === 'user/message'
        ? data?.content
        : data?.message?.content;
    const content = Array.isArray(rawContent)
        ? rawContent
        : [];
    const parts = [];
    let note = '';
    for (const block of content) {
        if (block.type === 'text' && typeof block.text === 'string') {
            parts.push(block.text);
        }
        else if (block.type === 'tool-call') {
            const p = toolCallProjection(block.name, block.arguments);
            parts.push(p.text);
            if (p.reconstructed)
                note = RECON_ARGS_NOTE;
        }
        else if (block.type === 'tool-result') {
            for (const inner of block.content ?? [])
                if (inner.type === 'text' && typeof inner.text === 'string')
                    parts.push(inner.text);
        }
    }
    if (parts.length === 0)
        return null;
    if (parts.length > 1) {
        note = (note !== '' ? note + '; ' : '') + 'multiple content blocks: each block is verbatim, the separator between blocks is a projection';
    }
    return { text: parts.join('\n'), reconstructed: note !== '', note: note !== '' ? note : undefined };
}
/** 判定单个 seq 的状态。shadowed 优先（被遮蔽的节点也可能仍留在 surface 索引之外）。 */
export function nodeStateOf(session, seq, isShadowed) {
    if (isShadowed(seq))
        return 'shadowed';
    for (const node of session.surface.nodes) {
        if (node === seq)
            return 'live';
    }
    return 'off-surface';
}
/**
 * 按 seq 从 append-only 日志取回原文，不再要求节点属于 pruned 集合。
 * 只有越界（日志里没有这个 seq）才算失败。
 */
export function recallFromLog(session, seq, isShadowed, textOf) {
    const total = session.seq;
    if (!Number.isInteger(seq) || seq < 0 || seq >= total || sessionEvents(session)[seq] === undefined) {
        return { ok: false, reason: 'out-of-range', total };
    }
    const state = nodeStateOf(session, seq, isShadowed);
    const text = textOf(session, seq);
    if (text === '')
        return { ok: false, reason: 'no-text', state };
    return { ok: true, state, text };
}
const STATE_HINT = {
    shadowed: 'pruned from the visible context by ARGP',
    live: 'still on the conversation surface, but it may sit outside the model render window',
    'off-surface': 'log-only node, never part of the rendered conversation',
};
/** 状态标签行：模型必须知道取回内容当前是否可见，才能正确执行引用契约。 */
export function stateHeader(seq, state) {
    return '[recall seq=' + seq + ' state=' + state + '] (' + STATE_HINT[state] + '; cite it if your answer uses it)';
}
/** 把 RecallOutcome 渲染成工具返回文本。budget 用于对正文套字数预算。 */
export function formatRecallOutcome(toolName, seq, outcome, budget = t => t) {
    if (outcome.ok)
        return stateHeader(seq, outcome.state) + '\n' + budget(outcome.text);
    if (outcome.reason === 'out-of-range') {
        return toolName + ': seq ' + seq + ' is out of range (log has ' + outcome.total
            + ' events, valid seq 0..' + Math.max(0, outcome.total - 1) + ')';
    }
    return toolName + ': seq ' + seq + ' (state=' + outcome.state + ') exists in the log but carries no model-visible text';
}
export function logRowType(eventType, data) {
    if (eventType === 'user/message') {
        // P0 分类陷阱防线：U-info 聚合副本（data[argp].info）按 U 展示，先于 plugin-source → X 判定
        if (isArgpUserInfo(data))
            return 'U';
        return data?.source?.kind === 'plugin' ? 'X' : 'U';
    }
    if (eventType === 'assistant/message')
        return 'A';
    if (eventType === 'tool/result')
        return 'R';
    if (eventType === 'tool/call')
        return 'T';
    return 'other';
}
/**
 * 区间发现原语：列出 [fromSeq..toSeq] 内所有有正文的日志节点（含 live / off-surface）。
 * 这是 (b) 里容易被漏掉的一半 —— 去门控只解决"知道 seq 就能取"，区间模式解决
 * "模型怎么知道被窗口丢掉的节点的 seq"，把 list 从「剪枝清单」升级为「可见窗口补集查询」。
 */
export function queryLogRange(session, query, isShadowed, textOf) {
    const total = session.seq;
    const events = sessionEvents(session);
    const from = Math.max(0, Math.min(query.fromSeq, total - 1));
    const to = Math.max(from, Math.min(query.toSeq, total - 1));
    const rows = [];
    let scanned = 0;
    let truncated = false;
    for (let seq = from; seq <= to; seq += 1) {
        const event = events[seq];
        if (event === undefined)
            continue;
        scanned += 1;
        const data = event.data;
        const type = logRowType(event.type, data);
        if (query.type !== undefined && type !== query.type)
            continue;
        const turn = typeof data?.turn === 'number' ? data.turn : 0;
        if (query.turn !== undefined && turn !== query.turn)
            continue;
        const text = textOf(session, seq);
        if (text === '')
            continue;
        if (query.keyword !== undefined && !text.includes(query.keyword))
            continue;
        if (rows.length >= query.limit) {
            truncated = true;
            break;
        }
        const firstLine = text.split('\n').map(l => l.trim()).find(l => l !== '') ?? '';
        rows.push({
            seq,
            type,
            turn,
            state: nodeStateOf(session, seq, isShadowed),
            firstLine: firstLine.length > 120 ? firstLine.slice(0, 120) + '…' : firstLine,
        });
    }
    return { rows, scanned, truncated };
}
export function formatLogRow(row, extra = '') {
    return 'seq=' + row.seq + ' type=' + row.type + ' turn=' + row.turn
        + ' state=' + row.state + extra + ' first=' + row.firstLine;
}
