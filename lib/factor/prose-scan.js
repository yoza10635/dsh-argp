/**
 * 散文扫描带（design-prose-keyword-recall §1.1，2.1.0 刀 A）：keyword 内容检索的
 * 「扫描面含 user/assistant 散文」纯函数面。零引擎状态、零预算入账、从旧到新确定性
 * ——装配层（刀 B）与 golden-string 锁的确定性前提。
 *
 * 设计约束（三轮对抗审查台账 §5/§6/§6.5）：
 *  - P1★ replace 副本判据=顶层 `surfaceOp.op==='replace'`（resolveRootSeqs 同读法）——
 *    sourceEventSeqs 不可作主判据：宿主禁 assistant/message 携带（dsh-session index.js:316），
 *    cites-strip 副本故意不带（argp-engine.ts:136-147），按它排除会双计。
 *  - P2★/Q3 词表 note 首注=steer 纯 append（kind='argp'），**kind 排除即主防线**；
 *    marker 等值仅 own-kind 上二次判据——kind='user' 的伪造 marker 前缀消息不得误剔（fail-visible）。
 *  - P4★/Q1 **仅 text 块**投影：rawEventText 会把 tool-call args 投影进文本（log-access.ts:239-249），
 *    禁复用；reasoning 块显式不扫。
 *  - P11 user/message 双形读 `data.content ∨ data.message.content`（engine.ts:1059-1061 先例）。
 *  - §6.5 实测宿主 boilerplate kind：'runtime-context'（form=snapshot）/'skill-catalog'
 *    （form=catalog）（session-aacb4606 seq 9/10）；merge kind（agent-message/goal/
 *    subagent-settled）按普通材料照扫（llm/types.ts:47-52 同族裁定，subagent 报告走 notice 的价值面）。
 *  - P7★/Q2★ cap 方向=**从旧到新**（保最旧=已离场浓缩原文；切最新段多仍在场），
 *    超限 truncated 显式（fail-visible）；cap=0 ⇒ 带整体关闭（评测对照臂开关）。
 */
import { isOwnSourceKind } from "../llm/types.js";
/** 宿主注入 boilerplate 名册（§6.5 实测 kind）；own kinds 另经 isOwnSourceKind。 */
export const HOST_BOILERPLATE_SOURCE_KINDS = ['runtime-context', 'skill-catalog'];
/** cap 缺省系数：窗 tok × 密度 chars/tok × 本系数（≈2.7 倍单窗全满散文线，D3/R9④）。 */
export const DEFAULT_PROSE_SCAN_WINDOW_FACTOR = 2.7;
/** cap=0 ⇒ 关闭；缺省=窗相对值。config `proseScanCapChars` 覆盖（测试注入形）。 */
export function defaultProseCapChars(windowTokens, charsPerToken) {
    return Math.floor(windowTokens * charsPerToken * DEFAULT_PROSE_SCAN_WINDOW_FACTOR);
}
function isReplaceSurface(op) {
    return typeof op === 'object' && op !== null && op.op === 'replace';
}
/** 事件的来源 kind：user/message 挂 data.source，assistant/message 挂 data.message.source。 */
function sourceKindOf(event) {
    const d = event.data;
    return d?.source?.kind ?? d?.message?.source?.kind;
}
/** 扫描排除的来源 kind：本引擎自写（note/检查点）+ 宿主 boilerplate。 */
export function isProseExcludedKind(kind) {
    return isOwnSourceKind(kind) || (kind !== undefined && HOST_BOILERPLATE_SOURCE_KINDS.includes(kind));
}
/**
 * 仅 text 块的逐字投影（P4★：不含 tool-call 块、不含 args；reasoning 不扫）。
 * user/message 双形读（P11）。无 text 块返回 null（与 rawEventText 的 null 语义对齐）。
 * 多 text 块以 '\n' 连接（块间分隔符=投影，装配层如展示需如实注记）。
 */
export function proseTextOf(event) {
    const d = event.data;
    const raw = Array.isArray(d?.content)
        ? d.content
        : Array.isArray(d?.message?.content)
            ? d.message.content
            : null;
    if (raw === null)
        return null;
    const parts = [];
    for (const block of raw) {
        const b = block;
        if (b !== null && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string')
            parts.push(b.text);
    }
    return parts.length === 0 ? null : parts.join('\n');
}
/** 是否入扫描面的候选事件（形+kind；text 非空判定留给调用方，避免双投影）。 */
export function isProseCandidate(event) {
    const t = event.type;
    if (t !== 'user/message' && t !== 'assistant/message')
        return false;
    if (isReplaceSurface(event.surfaceOp))
        return false;
    return !isProseExcludedKind(sourceKindOf(event));
}
/** 命中位置上限（fragment 选取只用到首尾几处，封顶防超大原子的命中数组膨胀；count 仍如实全计）。 */
export const HIT_POSITIONS_CAP = 50;
/**
 * 非重叠 indexOf 收集命中：全量 count + 前 HIT_POSITIONS_CAP 个偏移（小写化文本口径）。
 * 命中面单点（search_history 工具带 + 散文带共用），杜绝两处 indexOf 漂移。
 */
export function collectHits(text, needleLower) {
    const hay = text.toLowerCase();
    const positions = [];
    let count = 0;
    for (let i = hay.indexOf(needleLower); i >= 0; i = hay.indexOf(needleLower, i + needleLower.length)) {
        count += 1;
        if (positions.length < HIT_POSITIONS_CAP)
            positions.push(i);
    }
    return { count, positions };
}
/**
 * 散文带扫描（events=sessionEvents 全量数组，needle=已小写化 needle）。
 * 从旧到新逐候选：投影 → 计数入 cap → 小写化找 hits/first；cap 触线即停。
 */
export function scanProseHits(events, needle, capChars) {
    if (capChars <= 0)
        return { hits: [], scannedChars: 0, truncated: false, disabled: true };
    const out = [];
    let scanned = 0;
    let truncated = false;
    for (let seq = 1; seq < events.length; seq += 1) {
        const ev = events[seq];
        if (ev === undefined || !isProseCandidate(ev))
            continue;
        const text = proseTextOf(ev);
        if (text === null || text === '')
            continue;
        if (scanned + text.length > capChars) {
            truncated = true;
            break;
        }
        scanned += text.length;
        const h = collectHits(text, needle);
        if (h.count === 0)
            continue;
        out.push({ seq, hits: h.count, first: h.positions[0], positions: h.positions, chars: text.length });
    }
    return { hits: out, scannedChars: scanned, truncated, disabled: false };
}
