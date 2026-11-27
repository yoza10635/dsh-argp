/**
 * 跨宿主版本兼容的事件日志读取（升级阻断修复）。
 *
 * dsh 0.1.2-alpha.4 的 breaking 重构 `27bf1039db refactor(session)!: distinguish
 * event seqs from log offsets` 移除了 `Session.events` getter（运行时 `undefined`），
 * 替代为 `snapshotEvents()`（frozen 全日志快照）/ `eventAt(seq)`。rc.2 仍有 `events`
 * getter。为同时兼容两个宿主，本 helper 运行时探测：
 *
 *   - 宿主 Session 提供 `snapshotEvents`（alpha.4+）→ 调 `snapshotEvents()`
 *   - 否则回退到 legacy `session.events`（rc.2）
 *
 * **当前支持基线 0.1.5-rc.1**：该版本 `events` getter 已彻底
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
 * 事件 turn 号类型化访问器。
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
 * 本函数只依赖 `sessionEvents`（本模块）+ 纯数据操作，不触碰任何 hub 运行时
 * （无 this.ctx / engine 状态）。hub 侧保留 `export { eventText } from './log-access.js'`
 * 转发以维持既有公共 API 与测试 import 不变。
 */
export function eventText(session, seq) {
    const event = sessionEvents(session)[seq];
    if (event === undefined)
        return '';
    return eventTextOf(event);
}
/**
 * 从单个事件投影模型可见文本（`eventText` 的纯事件形态；peratom/gate 的
 * `projectSurfaceText` 委托到这里，单一事实源）。
 */
export function eventTextOf(event) {
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
 * 返回 open turn 号；无开放轮（末尾已闭合 / 会话头）返回 null。
 * **-1 = 存在未闭合的 turn/start 但轮号不可读**（畸形日志）——fail-closed 哨兵：
 * 消费方按「一切皆开放轮」处理（焦点降级带清零、驱逐全停、预剪跳过），
 * 绝不允许把「号读不出」误折叠成 null=「无开放轮」而放行 open 区驱逐。
 */
export function detectOpenTurn(session) {
    const events = sessionEvents(session);
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event === undefined)
            continue;
        if (event.type === 'turn/start')
            return turnOf(event) ?? -1;
        if (event.type === 'turn/end')
            return null;
    }
    return null;
}
/** 当前开放 step 的步号（无开放 step ⇒ null；turn/end、step/end、turn/start 均截断）。 */
export function detectOpenStep(session) {
    const events = sessionEvents(session);
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event === undefined)
            continue;
        if (event.type === 'step/start') {
            const step = event.data?.step;
            return typeof step === 'number' ? step : null;
        }
        if (event.type === 'step/end' || event.type === 'turn/end' || event.type === 'turn/start')
            return null;
    }
    return null;
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
 * 只认 compaction/prune 事件（pruneIntervals 每次真剪枝必发，shadowedSeqs 即被剪 seq
 * 权威清单），与 ArgpEngine.shadowedSeqsOf 同口径。**不可**改用「replace 形态推断」
 * （任何 surfaceOp replace 的 sourceEventSeqs 都算 shadowed）：那会把原地压缩副本
 * （无 compaction/prune 事件）误判为 shadowed，导致召回对压缩原子谎报 state=shadowed。
 */
export function scanShadowedSeqs(session) {
    const shadowed = new Set();
    // 事务感知：prune 的 shadowedSeqs 是**声称**，只有 end 成功收口才成账。error-end
    // （replace 中途抛错）的声称必须丢弃——否则仍在 surface 的 live 节点会被 recall
    // 谎报 state=shadowed，且剪枝候选被永久跳过（与宿主 foldSurfaceProjection 的
    // "end 时 drop claim" 口径对齐）。
    let pending = null;
    for (const event of sessionEvents(session)) {
        if (event.type === 'compaction/start') {
            pending = [];
            continue;
        }
        if (event.type === 'compaction/prune') {
            const seqs = event.data.shadowedSeqs;
            if (!Array.isArray(seqs))
                continue;
            if (pending === null)
                for (const seq of seqs)
                    shadowed.add(seq);
            else
                pending.push(...seqs);
            continue;
        }
        if (event.type === 'compaction/end' && pending !== null) {
            const errored = event.data.error !== undefined;
            if (!errored)
                for (const seq of pending)
                    shadowed.add(seq);
            pending = null;
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
/**
 * 事件的面拆分（§9.36 浓缩输入面）：assistant/message 的 text/reasoning 块归 'A'、
 * tool-call 块逐块归 'K'（`name(args)` 投影，与 R1 回放 replay 形同构——tool/call 是
 * off-surface 记账事件，K 面只能从 A 的块里取）；其余类型单面返回（face 按类型给
 * 'U'/'R'/'X'），文本口径与 {@link rawEventText} 一致。
 */
export function rawEventFaces(session, seq) {
    const event = sessionEvents(session)[seq];
    if (event === undefined)
        return [];
    if (event.type === 'assistant/message') {
        const data = event.data;
        const blocks = Array.isArray(data?.message?.content) ? data.message.content : [];
        const out = [];
        let textBuf = '';
        for (const b of blocks) {
            if ((b.type === 'text' || b.type === 'reasoning') && typeof b.text === 'string')
                textBuf += b.text;
            else if (b.type === 'tool-call') {
                const args = typeof b.arguments === 'string' ? b.arguments : JSON.stringify(b.arguments ?? {});
                out.push({ face: 'K', text: (b.name ?? '?') + '(' + args + ')' });
            }
        }
        if (textBuf.length > 0)
            out.unshift({ face: 'A', text: textBuf });
        return out;
    }
    const raw = rawEventText(session, seq);
    if (raw === null || raw.text.length === 0)
        return [];
    const face = event.type === 'user/message' ? 'U' : event.type === 'tool/result' ? 'R' : 'X';
    return [{ face, text: raw.text }];
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
/** surfaceOp replace 链回溯的深度上限（实测墓碑链长 ≤9；超出按数据损坏截断，返回已收集根）。 */
const ROOT_SEQ_MAX_DEPTH = 32;
/**
 * 沿 surfaceOp replace 链回溯到 append 根源 seq。
 *
 * 归并墓碑指向修正用：墓碑副本事件是 replace，其 [startSeq..endSeq] 指向**上一代**
 * （链式替换下是上一代墓碑而非原文）；循环回溯到 surfaceOp === 'append'（或无 op）
 * 即原文根源。append 事件（含伪造墓碑文本的普通事件）返回自身单元素数组。
 */
export function resolveRootSeqs(events, seq) {
    const roots = [];
    const walk = (s, depth) => {
        if (depth > ROOT_SEQ_MAX_DEPTH) {
            roots.push(s);
            return;
        }
        const ev = events[s];
        const op = ev?.surfaceOp;
        if (typeof op !== 'object' || op === null || op.op !== 'replace') {
            roots.push(s);
            return;
        }
        const { startSeq, endSeq } = op;
        for (let i = startSeq; i <= endSeq; i += 1)
            walk(i, depth + 1);
    };
    walk(seq, 0);
    return [...new Set(roots)].sort((a, b) => a - b);
}
