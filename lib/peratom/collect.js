import { sessionEvents, turnOf } from '../log-access.js';
import { DEFAULT_SKIP_CONTEXT_FORMS } from '../constants.js';
import { buildToolNameIndex, buildVersionChainIndex, collectInterruptedTurns, filterInterruptedAtoms, projectSurfaceText, rNeedCompress, userIsLong, } from './gate.js';
/**
 * 该事件是否为**可压缩的原始材料**（唯一判据，三处共用）。
 *
 * 两类事件不是材料，必须同时从「候选」与「窗口边界（startSeq/endSeq）」里排除：
 *  - **压缩产物**：`surfaceOp` 存在且非 `'append'`（本压缩器 / 图剪写回的替换副本）。
 *    它是上一次 pass 的结果；水位语义下同一轮会被多次 collect，放进去会让
 *    窗口恒非空（每次 pass 都以 no-candidate 重复记账），且副本的
 *    `message.source.kind` 仍是 `'tool'`，plugin-source 判据拦不住 ⇒ 有二次摘要风险。
 *  - **插件注入**：`user/message` 且 `source.kind === 'plugin'`（A 形态前缀指令、
 *    U-info 聚合副本、checkpoint）。这类事件由引擎/本压缩器自己写入，不是会话材料；
 *    边界若把它们算进去，纯注入窗口会返回"空候选的非 null 收集"（同上噪声问题）。
 *
 * 判据口径与 `argp-t1-engine.shadowedSeqs` 的 replace 判定一致。
 *
 * 第三道（v1.6.1）：`skipForms` —— user-role 消息的 `source.form` 命中清单即排除。
 * 这是**性质**轴（"这是什么"），与上一道的**来源**轴（"谁生产的"）正交：插件注入
 * 未必是浓缩产物，而 dsh-agent 的 merge 扩展 kind（`agent-message` /
 * `subagent-settled`）不等于 `'plugin'` 却正是浓缩产物。详见
 * `DEFAULT_SKIP_CONTEXT_FORMS` 注释（含实战语料的密度实证）。
 */
function isMaterial(event, skipForms) {
    // 只有对话载体（U/A/R）才构成压缩窗口；turn/start·end、compaction/*、
    // request/header 等旁路事件既不是候选、也不该把窗口撑成"非空"。
    if (event.type !== 'user/message' && event.type !== 'assistant/message' && event.type !== 'tool/result')
        return false;
    const surfaceOp = event.surfaceOp;
    if (surfaceOp !== undefined && surfaceOp !== 'append')
        return false;
    if (event.type !== 'user/message')
        return true;
    const src = event.data?.source;
    if (src?.kind === 'plugin')
        return false;
    // 性质轴：子代理汇报 / 一次性通知 = 已浓缩产物，不进逐原子压缩（交给 Stage-2 图剪）。
    if (src?.form !== undefined && skipForms.includes(src.form))
        return false;
    return true;
}
/** 某轮已规划过的最大 seq（-1 = 未压过）。 */
export function waterMarkOf(host, session, turn) {
    return host.passWatermark.get(session)?.get(turn) ?? -1;
}
/** 成功落地后推进水位（单调不回退）。 */
export function advanceWaterMark(host, session, turn, endSeq) {
    let marks = host.passWatermark.get(session);
    if (marks === undefined) {
        marks = new Map();
        host.passWatermark.set(session, marks);
    }
    if (endSeq > (marks.get(turn) ?? -1))
        marks.set(turn, endSeq);
}
/** 窗口→候选的共享尾部（中断/版本链/大小门控 + 原子化）。closed/open 两口径共用。 */
export function collectFromWindow(host, session, turn, turnEvents, startSeq, endSeq) {
    const events = sessionEvents(session);
    if (endSeq < 0)
        return null;
    const skipForms = host.gateOptions().skipContextForms ?? DEFAULT_SKIP_CONTEXT_FORMS;
    const interrupted = collectInterruptedTurns(events).has(turn);
    const collect = {
        turn,
        startSeq,
        endSeq,
        interrupted,
        userLong: [],
        toolResults: [],
    };
    if (interrupted)
        return collect;
    // 中断过滤作用于投影前的原始事件流：被标记轮次的残留原子不进候选。
    const chain = buildVersionChainIndex(events);
    const nameByCall = buildToolNameIndex(events);
    const rawAtoms = [];
    for (const event of turnEvents) {
        if (!isMaterial(event, skipForms))
            continue; // 安全网：非材料（压缩产物 / 插件注入）永不入候选
        const data = event.data;
        if (event.type === 'user/message') {
            // U-info 聚合副本 / checkpoint / A 形态指令均为 plugin-source —— 已由 isMaterial 排除。
            const text = projectSurfaceText(event);
            if (userIsLong(text, host.splitThresholdChars)) {
                rawAtoms.push({ kind: 'user-long', seq: event.seq, turn, text });
            }
            continue;
        }
        if (event.type === 'tool/result') {
            const callId = data?.message?.source?.callId;
            const text = projectSurfaceText(event);
            // 工具种类名（callId→name 反查）：tool 对照表 / 作者声明的查找键（设计 §6-2）。
            const toolName = callId !== undefined ? nameByCall.get(callId) : undefined;
            rawAtoms.push({ kind: 'tool-result', seq: event.seq, turn, text, callId, toolName });
        }
        // assistant/message 不压缩（设计 §1）。
    }
    const survivors = filterInterruptedAtoms(rawAtoms, events);
    for (const atom of survivors) {
        if (atom.kind === 'user-long') {
            collect.userLong.push(atom);
        }
        else if (rNeedCompress(atom, chain, host.gateOptions()) !== false) {
            collect.toolResults.push(atom);
        }
    }
    return collect;
}
/**
 * 收集当前（最新闭合）轮的可压原子。内嵌三道确定性过滤：
 * ① 中断轮整轮排除（filterInterruptedAtoms，interrupted=true 时数组恒空）；
 * ② 版本链成员硬排除（决策④，need_compress=false）；③ 大小启发式门控。
 * 无再压缩路径：U-info 副本 / plugin checkpoint 一律跳过（决策⑦）。
 */
export function collectCurrentTurn(host, session, afterSeq) {
    const events = sessionEvents(session);
    const skipForms = host.gateOptions().skipContextForms ?? DEFAULT_SKIP_CONTEXT_FORMS;
    let closed = null;
    for (let i = events.length - 1; i >= 0; i -= 1) {
        const event = events[i];
        if (event?.type === 'turn/end') {
            closed = turnOf(event) ?? null;
            break;
        }
    }
    if (closed === null)
        return null;
    // 水位（2026-09-21）：缺省取该轮「已规划边界」，只收其后新增事件 ⇒ 同轮可增量再压。
    const since = afterSeq ?? waterMarkOf(host, session, closed);
    // 归轮按位置：user/message 事件不携带 turn 字段（rc.2 类型），其归属 =
    // 当前开放的 turn（turn/start..end 之间的日志区间）。assistant/tool 事件自带
    // turn 字段做二次校验。替换副本（dialog/U-info/tool copy）落在本窗口内的，
    // 由 plugin-source 跳过 / 版本链同键硬排除兜住，不会被误当原始态原子。
    const turnEvents = [];
    let startSeq = Number.MAX_SAFE_INTEGER;
    let endSeq = -1;
    let open = null;
    for (const event of events) {
        if (event.type === 'turn/start') {
            open = turnOf(event) ?? null;
            continue;
        }
        if (event.type === 'turn/end') {
            open = null;
            continue;
        }
        if (open !== closed)
            continue;
        if (event.seq <= since)
            continue; // 水位过滤：只收上次规划边界之后的新增事件
        if (!isMaterial(event, skipForms))
            continue; // 压缩产物 / 插件注入不算窗口（见 isMaterial）
        if (event.type !== 'user/message') {
            const turn = turnOf(event);
            if (turn !== undefined && turn !== closed)
                continue;
        }
        turnEvents.push(event);
        if (event.seq < startSeq)
            startSeq = event.seq;
        if (event.seq > endSeq)
            endSeq = event.seq;
    }
    return collectFromWindow(host, session, closed, turnEvents, startSeq, endSeq);
}
/**
 * 收集当前开放轮（最后一条 turn/start 之后、尚无 turn/end）的可压原子。
 * P4 溢出三步路径②专用：溢出发生在 open turn 的请求上，第②步要降熵的正是
 * 这个 open turn——closed-turn 口径会错压上一闭合轮（2026-08-29 review 中项，
 * 与 per-atom 设计 §8「对当前轮大原子降熵」的意图不符）。过滤与闭合轮完全
 * 同款（中断/版本链/大小门控；U-info/checkpoint 跳过）；open turn 无 turn/end，
 * 不会出现在中断集里。无 turn/start（会话头）返回 null。
 */
export function collectOpenTurn(host, session, afterSeq) {
    const events = sessionEvents(session);
    const skipForms = host.gateOptions().skipContextForms ?? DEFAULT_SKIP_CONTEXT_FORMS;
    let openSeq = -1;
    let openTurn = null;
    for (let i = events.length - 1; i >= 0; i -= 1) {
        const event = events[i];
        if (event?.type === 'turn/start') {
            openSeq = event.seq;
            openTurn = turnOf(event) ?? null;
            break;
        }
    }
    if (openTurn === null || openSeq < 0)
        return null;
    // 水位（2026-09-21）：缺省取该 open 轮「已规划边界」，只收其后新增事件 ⇒ 轮内
    // 压力 pass 之后，轮末 idle pass 仍能压新增原子（不再被一次性配额吃掉）。
    const since = afterSeq ?? waterMarkOf(host, session, openTurn);
    // open 窗口 = 最后一条 turn/start 之后的全部事件。user/message 按位置归属；
    // assistant/tool 事件自带 turn 字段做二次校验（应恒等于 openTurn）。
    const turnEvents = [];
    let startSeq = Number.MAX_SAFE_INTEGER;
    let endSeq = -1;
    for (const event of events) {
        if (event.seq <= openSeq)
            continue;
        if (event.seq <= since)
            continue; // 水位过滤：只收上次规划边界之后的新增事件
        if (!isMaterial(event, skipForms))
            continue; // 压缩产物 / 插件注入不算窗口（见 isMaterial）
        if (event.type !== 'user/message' && event.type !== 'turn/end') {
            const turn = turnOf(event);
            if (turn !== undefined && turn !== openTurn)
                continue;
        }
        turnEvents.push(event);
        if (event.seq < startSeq)
            startSeq = event.seq;
        if (event.seq > endSeq)
            endSeq = event.seq;
    }
    return collectFromWindow(host, session, openTurn, turnEvents, startSeq, endSeq);
}
