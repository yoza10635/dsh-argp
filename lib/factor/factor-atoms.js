/**
 * 事件流 → 因子决策原料（design-2.0 §3.1 接线层；引擎侧唯一碰事件形态的地方）。
 *
 * 形态纪律（P0 真实归档实核，坑账全部内化）：
 *  - issuer 关联 = **callId**（tool/call 事件 `{callId,name,arguments}` ×
 *    tool/result `data.message.content[0].toolCallId`），不是 seq±1；
 *  - R 文本在 `tool-result` 块的**嵌套 content 递归**——只取顶层 text 会全空；
 *  - 剪枝 replace 链会产生同 callId 的 tool/result 副本——本层**不去重**，
 *    去重是 FactorLedger 的 rootSeq 职责（职责分层）；
 *  - isError 双形态：V4 `message.isError` 顶层 / V3 tool-result 块内。
 */
import { COMMAND_MEDIUM_FAMILY_WHITELIST, COMMAND_TOOLS, extractTags } from "./tag-extract.js";
import { indexKeys } from "./factor-ledger.js";
/** tool/call 事件 + A 事件内嵌 tool-call 块 双形态索引（先到者胜）。 */
export function indexCalls(events) {
    const byId = new Map();
    for (const e of events) {
        if (e.type === 'tool/call') {
            const d = e.data ?? {};
            const callId = typeof d['callId'] === 'string' ? d['callId'] : undefined;
            if (callId !== undefined && !byId.has(callId)) {
                byId.set(callId, { name: String(d['name'] ?? ''), args: d['arguments'], seq: e.seq });
            }
            continue;
        }
        if (e.type !== 'assistant/message')
            continue;
        const content = e.data?.message?.content;
        if (!Array.isArray(content))
            continue;
        for (const b of content) {
            if (b['type'] !== 'tool-call' || typeof b['id'] !== 'string')
                continue;
            if (!byId.has(b['id']))
                byId.set(b['id'], { name: String(b['name'] ?? ''), args: b['arguments'], seq: e.seq });
        }
    }
    return byId;
}
/**
 * R 事件文本投影：text 块 + tool-result 嵌套 content 递归（P0 首轮病灶锁）。
 * capChars 只影响 errorish 文本信号与 sizeChars 的口径（大输出照样被 size 键排前）。
 */
export function resultTextOf(e, capChars = 32_768) {
    const msg = (e.data ?? {})['message'];
    const parts = [];
    let n = 0;
    const grab = (blocks) => {
        if (!Array.isArray(blocks))
            return;
        for (const b of blocks) {
            if (n >= capChars)
                return;
            if (b === null || typeof b !== 'object')
                continue;
            const bb = b;
            if (bb.type === 'text' && typeof bb.text === 'string') {
                parts.push(bb.text);
                n += bb.text.length;
            }
            else if (bb.type === 'tool-result') {
                grab(bb.content);
            }
        }
    };
    grab(msg?.content);
    return parts.join('\n');
}
/** isError 双形态（V4 message 顶层 / V3 tool-result 块内），取 OR。 */
export function isErrorOf(e) {
    const msg = e.data?.message;
    if (msg?.isError === true)
        return true;
    const blocks = msg?.content;
    if (Array.isArray(blocks)) {
        for (const b of blocks) {
            if (b['type'] === 'tool-result' && b['isError'] === true)
                return true;
        }
    }
    return false;
}
/** session 头事件的 cwd（事件时环境；缺 undefined——绝不拿当前 cwd 凑）。 */
export function sessionCwdFromEvents(events) {
    for (const h of events) {
        const cwd = h.data?.['cwd'];
        if (h.type === 'session' && typeof cwd === 'string')
            return cwd;
    }
    return undefined;
}
/** 事件 data 内是否有附件块（image/file，递归 tool-result 的嵌套 content）。 */
export function hasAttachmentBlocks(data) {
    const scan = (blocks) => {
        if (!Array.isArray(blocks))
            return false;
        for (const b of blocks) {
            if (b === null || typeof b !== 'object')
                continue;
            const o = b;
            if (o.type === 'image' || o.type === 'file')
                return true;
            if (scan(o.content))
                return true;
        }
        return false;
    };
    const d = data;
    return scan(d?.content) || scan(d?.message?.content);
}
/** 桩 R 文本前缀（engine.stubText 产出）：日志驱动贴标的排除判据。 */
export const STUB_PREFIX = '[已剪·因子]';
/**
 * **日志根事件驱动**贴标（resume 重放的正解）：遍历日志 tool/result 事件，
 * replace 副本经 `resolveRootSeqs`（log-access.ts:280）折回原 seq——被剪 R 的
 * 原事件离场 surface 后仍可入账（"账本 = shadowed 投影"在 resume 下建得起来）。
 *
 * 排除项：① replace 副本（root≠自身 seq，原文账记在原 seq 上）；② 桩事件
 * （STUB_PREFIX 文本——桩不是新 R，进 sticky/candidates 都是污染）。
 * turn 取事件 data.turn（缺 0，与 atomize 口径一致）。
 */
export function tagRsFromLog(events, sessionCwd, resolveRoot) {
    const calls = indexCalls(events);
    const out = new Map();
    for (const e of events) {
        if (e.type !== 'tool/result')
            continue;
        const root = resolveRoot(e.seq)[0];
        if (root !== undefined && root !== e.seq)
            continue;
        const resultText = resultTextOf(e);
        if (resultText.startsWith(STUB_PREFIX))
            continue;
        // callId 双形：V3=content[0].toolCallId（AI SDK 标准块，testkit fixture 形）；
        // **V4（宿主 0.1.7+/npm headless 实测）= message.toolCallId 顶层 + role:'tool' +
        // content 单 text 块**。只认前者 ⇒ V4 会话全部 callId undefined ⇒ compactIfNeeded
        // 发射循环逐条 continue ⇒ 剪枝决策正确但 replace 永不落盘（2026-11-11 ai-server 实锤）。
        const msg = (e.data ?? {})['message'];
        const callId = msg?.content?.[0]?.toolCallId ?? msg?.toolCallId;
        const call = typeof callId === 'string' ? calls.get(callId) : undefined;
        const turnRaw = e.data?.['turn'];
        const tags = extractTags({
            tool: call?.name ?? '',
            rawArgs: call?.args,
            resultText,
            sessionCwd,
            isError: isErrorOf(e),
        });
        out.set(e.seq, {
            seq: e.seq, turn: typeof turnRaw === 'number' ? turnRaw : 0,
            callId: typeof callId === 'string' ? callId : undefined,
            tool: call?.name ?? '', resultText, tags, hasAttachment: hasAttachmentBlocks(e.data),
        });
    }
    return out;
}
/**
 * 焦点标签集（§2.5 定稿措辞）：最近 focalTurns 轮**存活 U/A** 文本命中的 canonical
 * 标签（extractTags 文本兜底通道，同 canonical 单点）——**不是**"最近轮全部原子"。
 * U/A 是 cue 链载体，A 恒留正是前提；R 的键要成为焦点须经 U/A 叙事引用。
 */
export function focalLabels(atoms, latestTurn, focalTurns, sessionCwd) {
    const out = new Set();
    for (const a of atoms) {
        if (a.turn <= latestTurn - focalTurns)
            continue;
        if (a.type !== 'U' && a.type !== 'A')
            continue;
        const t = extractTags({ tool: '', rawArgs: null, resultText: a.text, sessionCwd });
        for (const key of indexKeys(t))
            out.add(key);
    }
    return out;
}
/**
 * 焦点命令标签（medium 带，§2.5 v1.1：命令只参与排序、永不进 hard）。
 * 命令**实际发生过**（焦点窗内 tool/call 事件的 args）才算焦点——U/A 文本通道恒缺
 * args（focalCmd 构造级恒空的病灶，spike51）；族名过 COMMAND_MEDIUM_FAMILY_WHITELIST
 * （首 token 太粗：cd 族爆炸半径/伪家族，实测定谳）。
 */
export function focalCommandLabels(calls, latestTurn, focalTurns) {
    const out = new Set();
    if (focalTurns <= 0)
        return out;
    for (const c of calls) {
        if (c.turn <= latestTurn - focalTurns)
            continue;
        if (!COMMAND_TOOLS.has(c.name))
            continue;
        const t = extractTags({ tool: c.name, rawArgs: c.args, resultText: '' });
        for (const cmd of t.commands) {
            if (COMMAND_MEDIUM_FAMILY_WHITELIST.has(cmd.slice('command:'.length)))
                out.add(cmd);
        }
    }
    return out;
}
// ---------------------------------------------------------------------------
// staleness 覆盖证明（释放向：覆盖须**证明**，部分读永不覆盖全量读）
// ---------------------------------------------------------------------------
const INF = Number.POSITIVE_INFINITY;
function rangeOf(r) {
    if (r === null)
        return [0, INF]; // 全量读
    const start = r.offset ?? 0;
    return [start, r.limit === null || r.limit === undefined ? INF : start + r.limit];
}
/** old ⊆ new（同为对该文件的成功 read；new 更新）。 */
export function rangeCovered(old, next) {
    const [a0, a1] = rangeOf(old);
    const [b0, b1] = rangeOf(next);
    return b0 <= a0 && a1 <= b1;
}
/**
 * seq → 是否被后续同文件成功读覆盖。只看 READ 类成功 R；错误读不作覆盖证据。
 * P1-d 保守：issuer 工具名缺失（''）不认 read 类（与 retention-score 的族下限同口径）。
 */
export function supersededMarks(tagsBySeq) {
    const reads = [...tagsBySeq.values()]
        .filter(x => x.tool === 'read' || x.tool === 'view')
        .sort((a, b) => a.seq - b.seq);
    const out = new Map();
    for (const old of reads) {
        // 读**失败**（结构化 isError）的 R 不产生可用内容：它的"被覆盖"没有意义，若标
        // superseded，排序会当"已有新版"先剪——丢的是唯一的错误现场。注意不能用 errorish：
        // 成功读取的日志内容里出现 ENOENT 也会置真（本测试集 c1 即此形态）。
        if (old.tags.failed === true)
            continue;
        let covered = false;
        for (const next of reads) {
            if (next.seq <= old.seq || next.tags.errorish)
                continue;
            if (old.tags.files.some(f => next.tags.files.includes(f)) && rangeCovered(old.tags.readRange, next.tags.readRange)) {
                covered = true;
                break;
            }
        }
        if (covered)
            out.set(old.seq, true);
    }
    return out;
}
