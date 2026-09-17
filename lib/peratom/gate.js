// ---------------------------------------------------------------------------
// 1. 中断轮次识别
// ---------------------------------------------------------------------------
/** turn/end 非正常收尾的 reason.kind 集合（见文件头口径说明）。 */
export const INTERRUPTED_END_REASONS = ['aborted', 'error', 'interrupted'];
/**
 * 判定一个 turn/end 事件是否把该轮标记为中断。
 * 三种形态：reason.kind 命中集合 / data.interrupted 直挂真值（diff 文档口径）/ 兜底未知形状不误判。
 */
export function isInterruptedTurnEnd(data) {
    if (data === null || typeof data !== 'object')
        return false;
    const d = data;
    if (d.interrupted === true)
        return true;
    const kind = d.reason?.kind;
    return typeof kind === 'string'
        && INTERRUPTED_END_REASONS.includes(kind);
}
/** assistant/message 的流中取消前缀标记（rc.2 实测落点）。 */
function isInterruptedAssistantMessage(data) {
    return data?.interrupted === true;
}
/**
 * 全日志扫描：返回被中断轮次的 turn 号集合。
 *
 * 只依赖事件形状（不依赖 Session 实例），离线重放/单测/引擎三处共用同一实现。
 * 无 turn/end 的开放轮（正在进行的轮）不算中断——它还没有"收尾"，等 idle 判定时它必然已闭。
 */
export function collectInterruptedTurns(events) {
    const turns = new Set();
    for (const event of events) {
        if (event.type === 'turn/end') {
            if (isInterruptedTurnEnd(event.data)) {
                const turn = event.data.turn;
                if (typeof turn === 'number')
                    turns.add(turn);
            }
            continue;
        }
        if (event.type === 'assistant/message' && isInterruptedAssistantMessage(event.data)) {
            const turn = event.data.turn;
            if (typeof turn === 'number')
                turns.add(turn);
        }
    }
    return turns;
}
/**
 * 排除被中断轮次的残留原子：同一 turn 号的全部原子一并剔除（半成品没有"保留一半"的价值——
 * 未派发工具调用已缺席，已交付前缀是截断产物）。输入宽容：atoms 只要求带 turn 字段，
 * 引擎 Atom / gate GateAtom / 测试桩通用。
 */
export function filterInterruptedAtoms(atoms, events) {
    const interrupted = collectInterruptedTurns(events);
    if (interrupted.size === 0)
        return [...atoms];
    return atoms.filter(a => !interrupted.has(a.turn));
}
/**
 * 全日志构建 R 版本链键索引。与 argp-graph-engine findVersionDuplicates 的 rKey 口径一致
 * （issuer A 的 tool name + arguments JSON；callId 缺失退化 r.text），但判定更保守：
 * 键重复出现即视为链成员（图引擎还要求 inDegree=0 才剪旧版，压缩侧不做图分析，
 * 一律按 verbatim 保护处理——错误方向只允许往"少压"错）。
 */
/**
 * 全日志构建 callId → 工具种类名索引（tool 对照表的查找底座，设计 §6-2）。
 * 工具名只落在 assistant/message 内嵌 tool-call 块的 name 上；tool/result 只带 callId，
 * 故须经 callId 反查。无 issuer（孤立 tool/result）→ 无名字，策略表跳过，落回启发式默认。
 */
export function buildToolNameIndex(events) {
    const nameByCall = new Map();
    for (const event of events) {
        if (event.type !== 'assistant/message')
            continue;
        const content = event.data?.message?.content;
        if (!Array.isArray(content))
            continue;
        for (const block of content) {
            if (block?.type !== 'tool-call' || typeof block.id !== 'string')
                continue;
            if (typeof block.name === 'string' && block.name.length > 0)
                nameByCall.set(block.id, block.name);
        }
    }
    return nameByCall;
}
export function buildVersionChainIndex(events) {
    // pass 1：callId → issuer 键（assistant/message 内嵌 tool-call 块）
    const issuerKeyByCall = new Map();
    for (const event of events) {
        if (event.type !== 'assistant/message')
            continue;
        const content = event.data?.message?.content;
        if (!Array.isArray(content))
            continue;
        for (const block of content) {
            if (block?.type !== 'tool-call' || typeof block.id !== 'string')
                continue;
            const argsStr = block.arguments !== undefined
                ? (typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments))
                : '';
            issuerKeyByCall.set(block.id, (block.name ?? '?') + '|' + argsStr);
        }
    }
    // pass 2：R 计数（同键 ≥2 即链）
    const counts = new Map();
    for (const event of events) {
        if (event.type !== 'tool/result')
            continue;
        const callId = event.data
            ?.message?.source?.callId;
        const key = callId !== undefined && issuerKeyByCall.has(callId)
            ? issuerKeyByCall.get(callId)
            : 'text|' + surfaceTextOf(event).trim();
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const keys = new Set();
    for (const [key, count] of counts)
        if (count >= 2)
            keys.add(key);
    return {
        keys,
        keyOf(callId, text) {
            return callId !== undefined && issuerKeyByCall.has(callId)
                ? issuerKeyByCall.get(callId)
                : 'text|' + text.trim();
        },
        isMember(callId, text) {
            return keys.has(this.keyOf(callId, text));
        },
    };
}
// ---------------------------------------------------------------------------
// 3. 投影与门控谓词
// ---------------------------------------------------------------------------
/**
 * 事件 → 模型可见文本（text + tool-call 概要 + tool-result 内层 text；reasoning 不算）。
 * 与 argp-graph-engine eventText 同口径的本模块私有镜像：gate 保持叶子纯净，
 * 不为投影功能反向依赖 Stage-2 引擎模块。
 */
export function projectSurfaceText(event) {
    const data = event.data;
    const parts = [];
    if (event.type === 'tool/call') {
        const d = data;
        parts.push('[tool-call ' + (d?.name ?? '?') + '(' + (typeof d?.arguments === 'string' ? d.arguments : JSON.stringify(d?.arguments ?? {})) + ')]');
        return parts.join('\n');
    }
    const rawContent = event.type === 'user/message'
        ? data?.content
        : data?.message?.content;
    const content = Array.isArray(rawContent)
        ? rawContent
        : [];
    for (const block of content) {
        if (block.type === 'text' && typeof block.text === 'string')
            parts.push(block.text);
        if (block.type === 'tool-call') {
            parts.push('[tool-call ' + (block.name ?? '?') + '(' + (typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments ?? {})) + ')]');
        }
        if (block.type === 'tool-result') {
            for (const inner of block.content ?? []) {
                if (inner.type === 'text' && typeof inner.text === 'string')
                    parts.push(inner.text);
            }
        }
    }
    return parts.join('\n');
}
function surfaceTextOf(event) {
    return projectSurfaceText(event);
}
/**
 * 大小启发式默认档线（字符）：低于此值的工具结果不值得 replace（净增副本元数据 +
 * KV 失效代价，与 t1 minSpanChars=512 的实测理由同源）；达到即 extract 档。
 */
export const DEFAULT_SMALL_RESULT_CHARS = 512;
/**
 * R 档位裁决（设计 §2 决策序，先命中先生效）：
 * ① 版本链成员 → false（硬排除，不可覆盖）；② 作者声明 → 采纳；③ 大小启发式默认。
 */
export function rNeedCompress(r, chain, opts = {}) {
    if (chain.isMember(r.callId, r.text))
        return false;
    // ② 作者声明 / tool 对照表：按工具种类名查（非 callId）。孤立结果无名字 → 跳过声明。
    const declared = r.toolName !== undefined ? opts.toolPolicies?.get(r.toolName) : undefined;
    if (declared !== undefined)
        return declared;
    const threshold = opts.smallResultChars ?? DEFAULT_SMALL_RESULT_CHARS;
    return r.text.length >= threshold ? 'extract' : false;
}
/** user 长消息判定（拆分阈值，types.ts SPLIT_THRESHOLD_CHARS 口径由调用方传入比较）。 */
export function userIsLong(text, thresholdChars) {
    return text.length > thresholdChars;
}
/**
 * 当轮调用门控（plan P1 / 设计 §2 调用门控）：仅当轮存在可压缩原子才触发 LLM——
 * 任一 User 长消息 ∨ 任一 Tool 的 need_compress ≠ false。纯 dialog 轮直接跳过：
 * 零调用（计数器可断言）、零 cites（孤立原子规则）。
 */
export function turnCompressible(atoms, chain, opts = {}) {
    return atoms.some(a => a.kind === 'user-long'
        || (a.kind === 'tool-result' && rNeedCompress(a, chain, opts) !== false));
}
// ---------------------------------------------------------------------------
// extract 保真守卫（决策③"四类保真串"的结构化表达，spike 34 实证驱动）
//
// spike 34 首轮实测：本地模型对 ALL-CAPS 错误码保真完美（6/6），但对 file:line 定位
// （2/6）与 key=value 分隔符（victim=txn#8821 被转述成 victim txn#8821）会不自觉改写。
// 守卫从原文确定性地提取高信号 token，要求 extract 逐一 verbatim 包含；
// 缺任一个即拒绝该条替换（原文保面 / v1.2.0 HLS 修复档，由调用方选档）——
// 错误方向只允许往"少压"错，与版本链硬排除同一保守哲学。纯函数，可单测。
//
// v1.2.0：词表与守卫实现迁至 `src/token-ontology.ts`（一套词表、两种机制：
// 原子内保真 + 原子间推断边共享唯一事实源）；本模块 re-export 保既有 import 兼容。
// ---------------------------------------------------------------------------
export { LOAD_BEARING_PATTERNS, findLoadBearingTokens, fidelityGuard } from '../token-ontology.js';
export { deriveInferredEdges, repairWithTrailer } from '../token-ontology.js';
