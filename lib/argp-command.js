import { measureTokens, visibleChars, capRetain } from './budget.js';
import { DEFAULT_WINDOW_TOKENS } from './constants.js';
import { resolveUiLocale } from './ui-locale.js';
/**
 * 状态行首展示的版本号。**必须与 `package.json` 的 `version` 一致**——
 * `scripts/prerelease-check.mjs` 有断言守着（发版时忘改会直接卡住发布）。
 */
export const ARGP_STATUS_VERSION = '1.11.2';
/** 命令名（不带斜杠）。UI 发现列表按此展示。 */
export const ARGP_COMMAND_NAME = 'argp';
/** 命令描述（发现 UI 的一行说明）。 */
export const ARGP_COMMAND_DESCRIPTION = 'Show ARGP context-compression status for this session (read-only)';
/**
 * 注册 `/argp`（幂等、可降级）。
 *
 * 与 `registerSettings` 同构：嵌套 inject 拿到 commands 服务后才注册，注册动作
 * 包在 `ctx.effect` 里（返回的 disposer 在插件卸载/重挂载时自动注销命令）。
 */
export function registerArgpCommand(ctx, host) {
    ctx.inject(['commands'], (scopedCtx) => {
        const registry = scopedCtx.commands;
        if (registry === undefined || typeof registry.register !== 'function')
            return;
        scopedCtx.effect(() => registry.register({
            name: ARGP_COMMAND_NAME,
            // 发现列表的一行说明在**注册期**定格（注册是 boot 期一次性动作，不随语言切换
            // 重放）；状态卡正文则每次调用现取语言（见 renderArgpStatus）。
            description: ARGP_COMMAND_DESCRIPTION,
            input: { hint: '(no arguments)' },
            // 无参数命令：`rawInput` 不落 `command/run`，避免日志里堆空串。
            recordInput: false,
            handler: (invocation) => renderArgpStatus(host, invocation, resolveUiLocale(ctx)),
        }));
    });
}
/** token 数的人读格式：>=1000 显示 `xx.xk`，否则原样。 */
function fmtTokens(tokens) {
    if (!Number.isFinite(tokens))
        return '?';
    if (Math.abs(tokens) >= 1000)
        return (tokens / 1000).toFixed(1) + 'k';
    return String(Math.round(tokens));
}
/** 百分比（0 调用时返回 `n/a` 而不是 0%，避免"零命中"与"没调用"混为一谈）。 */
function fmtPct(hit, total) {
    if (total === 0)
        return 'n/a';
    return Math.round((hit / total) * 100) + '%';
}
const enCopy = {
    head: (version, stage1) => 'ARGP ' + version + ' · engine: ' + stage1,
    preset: (preset, skipped) => ' · preset: ' + preset + (skipped ? ' (ARGP inactive — in skipPresets)' : ''),
    capNote: from => ' (capped from ' + from + ')',
    budgetNoSession: (trigger, retain, capNote) => 'budget: trigger ' + trigger + ' / retain ' + retain + capNote + ' · no session bound yet',
    budgetNow: (trigger, retain, capNote, now, source) => 'budget: trigger ' + trigger + ' / retain ' + retain + capNote
        + ' · now ' + now + ' (source=' + source + ')',
    prunesNone: () => 'prunes: 0 (no compaction yet)',
    prunesRebuild: logStarts => 'prunes: 0 in this process · log has ' + logStarts + ' transaction(s) (ledger rebuild pending)',
    prunesLedger: (count, ranges, items, before, after, forced, index) => 'prunes: ' + count
        + ' · last ' + ranges + ' ranges / ' + items + ' items / ' + before + '→' + after + forced
        + ' · pruned index ' + index,
    forced: () => ' (forced)',
    audit: (count, latest) => 'audit: ' + count + ' warning(s) · latest: ' + latest,
    recall: (calls, hits, pct) => 'recall: ' + calls + ' calls · ' + hits + ' hits (' + pct + ') [this process]',
    cites: (declared, resolved, ambiguous, failed) => 'cites: ' + declared + ' declared · ' + resolved + ' resolved'
        + ' (' + ambiguous + ' ambiguous, ' + failed + ' failed) [this process]',
};
const zhCopy = {
    head: (version, stage1) => 'ARGP ' + version + ' · 引擎 ' + stage1,
    preset: (preset, skipped) => ' · 预设 ' + preset + (skipped ? '（ARGP 未生效——在 skipPresets 中）' : ''),
    capNote: from => '（自 ' + from + ' 截断）',
    budgetNoSession: (trigger, retain, capNote) => '预算：触发 ' + trigger + ' / 保留 ' + retain + capNote + ' · 尚未绑定会话',
    budgetNow: (trigger, retain, capNote, now, source) => '预算：触发 ' + trigger + ' / 保留 ' + retain + capNote
        + ' · 当前 ' + now + '（source=' + source + '）',
    prunesNone: () => '剪枝：0（尚无压缩）',
    prunesRebuild: logStarts => '剪枝：本进程 0 · 日志有 ' + logStarts + ' 笔事务（台账重建中）',
    prunesLedger: (count, ranges, items, before, after, forced, index) => '剪枝：' + count
        + ' · 末次 ' + ranges + ' 区间 / ' + items + ' 项 / ' + before + '→' + after + forced
        + ' · 剪除索引 ' + index,
    forced: () => '（强制）',
    audit: (count, latest) => '审计：' + count + ' 条警告 · 最近：' + latest,
    recall: (calls, hits, pct) => '召回：' + calls + ' 次调用 · ' + hits + ' 次命中（' + pct + '）[本进程]',
    cites: (declared, resolved, ambiguous, failed) => 'cites：声明 ' + declared + ' · 解析 ' + resolved
        + '（歧义 ' + ambiguous + '，失败 ' + failed + '）[本进程]',
};
/**
 * 渲染状态文本（分段详单）。纯函数，除 `measureTokens` 的读操作外无副作用。
 *
 * 段数自适应：无意义的段（如未挂 declarer 时的 cites 段）整段省略，
 * 宁可少一行也不输出恒为 0 的噪声。
 *
 * 多语言（1.11.x）：`locale` 由注册侧每次调用经 `resolveUiLocale` 现取
 * （settings `locale.preference`，缺省/异常回退英文）——设置页切语言后下一条
 * /argp 即生效。缺省 'en' 保持既有测试与直接调用方的输出逐字节不变。
 */
export function renderArgpStatus(host, invocation, locale = 'en') {
    const T = locale === 'zh' ? zhCopy : enCopy;
    const session = invocation.agent?.session ?? host.session;
    const lines = [];
    const st = session !== null && session !== undefined ? host.stateOf(session) : null;
    // 段 1：身份 + 引擎形态 + preset 生效性
    const stage1 = host.peratomStack !== null ? 'graph+peratom' : 'graph';
    let head = T.head(ARGP_STATUS_VERSION, stage1);
    if (session !== null && session !== undefined) {
        const preset = host.activePresetOf(session);
        const skipped = preset !== undefined && preset !== null && host.skipPresets.includes(preset);
        head += T.preset(preset ?? 'unknown', skipped);
    }
    lines.push(head);
    // 段 2：预算 + 当前占用（D2 桶化：trigger 读**发起命令的会话**的桶，不再读焦点/共享字段；
    // 批次 3-2：retain 口径与引擎一致——显式值走 capRetain 绝对上界（截断时标注），比例值
    // = 可压缩内容（visible）× retainRatio，不再是误导的 window × retainRatio）
    const trigger = host.explicitWindowTokens
        ? host.windowTokens
        : (st !== null ? st.resolvedWindowTokens : DEFAULT_WINDOW_TOKENS);
    let retain;
    let capNote = '';
    if (session !== null && session !== undefined) {
        if (host.explicitRetainTokens) {
            retain = capRetain(host.retainTokens, trigger, host.reserveTokens);
            if (retain < host.retainTokens)
                capNote = T.capNote(fmtTokens(host.retainTokens));
        }
        else {
            retain = Math.floor(Math.ceil(visibleChars(session) / host.charsPerToken) * host.retainRatio);
        }
    }
    else {
        retain = Math.floor(trigger * host.retainRatio);
    }
    if (session === null || session === undefined) {
        lines.push(T.budgetNoSession(fmtTokens(trigger), fmtTokens(retain), capNote));
    }
    else {
        const m = measureTokens(host, session);
        lines.push(T.budgetNow(fmtTokens(trigger), fmtTokens(retain), capNote, fmtTokens(m.contextTokens), m.source));
    }
    // 段 3：剪枝台账（**会话桶**；批次 3-2：records 为进程内遥测——重启后由账本重建恢复，
    // 重建未及/失败时不再伪造 0，改报日志真值；auditWarnings 一并露出）
    const records = st?.records ?? [];
    const logStarts = session !== null && session !== undefined
        ? session.snapshotEvents().filter(e => e.type === 'compaction/start').length
        : 0;
    if (records.length === 0) {
        lines.push(logStarts > 0 ? T.prunesRebuild(logStarts) : T.prunesNone());
    }
    else {
        const last = records[records.length - 1];
        if (last !== undefined) {
            const beforeTok = Math.round(last.charsBefore / host.charsPerToken);
            const afterTok = Math.round(last.charsAfter / host.charsPerToken);
            lines.push(T.prunesLedger(records.length, last.intervals.length, last.shadowedSeqs.length, fmtTokens(beforeTok), fmtTokens(afterTok), last.forced ? T.forced() : '', st?.prunedNodeIndex.size ?? 0));
        }
    }
    if (st !== null && st.auditWarnings.length > 0) {
        const latest = st.auditWarnings[st.auditWarnings.length - 1] ?? '';
        lines.push(T.audit(st.auditWarnings.length, latest.length > 120 ? latest.slice(0, 120) + '…' : latest));
    }
    // 段 4：召回命中（批次 3-2：会话桶 + 进程内口径标注——重启归零不是会话真值）
    const recallCalls = st?.recallCalls ?? [];
    const calls = recallCalls.length;
    const hits = recallCalls.reduce((n, r) => n + (r.hit ? 1 : 0), 0);
    lines.push(T.recall(calls, hits, fmtPct(hits, calls)));
    // 段 5：cites 统计（仅双引擎 declarer 在位时输出；纯 Stage-2 下全 0 无意义）
    if (host.peratomStack?.declarer != null && st !== null) {
        const c = st.citeStats;
        lines.push(T.cites(c.declared, c.resolved, c.ambiguous, c.failed));
    }
    return { kind: 'success', text: lines.join('\n') };
}
