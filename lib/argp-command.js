import { measureTokens, visibleChars, capRetain } from './budget.js';
import { DEFAULT_WINDOW_TOKENS } from './constants.js';
/**
 * 状态行首展示的版本号。**必须与 `package.json` 的 `version` 一致**——
 * `scripts/prerelease-check.mjs` 有断言守着（发版时忘改会直接卡住发布）。
 */
export const ARGP_STATUS_VERSION = '1.11.0';
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
            description: ARGP_COMMAND_DESCRIPTION,
            input: { hint: '(no arguments)' },
            // 无参数命令：`rawInput` 不落 `command/run`，避免日志里堆空串。
            recordInput: false,
            handler: (invocation) => renderArgpStatus(host, invocation),
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
/**
 * 渲染状态文本（分段详单）。纯函数，除 `measureTokens` 的读操作外无副作用。
 *
 * 段数自适应：无意义的段（如未挂 declarer 时的 cites 段）整段省略，
 * 宁可少一行也不输出恒为 0 的噪声。
 */
export function renderArgpStatus(host, invocation) {
    const session = invocation.agent?.session ?? host.session;
    const lines = [];
    const st = session !== null && session !== undefined ? host.stateOf(session) : null;
    // 段 1：身份 + 引擎形态 + preset 生效性
    const stage1 = host.peratomStack !== null ? 'graph+peratom' : 'graph';
    let head = 'ARGP ' + ARGP_STATUS_VERSION + ' · engine: ' + stage1;
    if (session !== null && session !== undefined) {
        const preset = host.activePresetOf(session);
        const skipped = preset !== undefined && preset !== null && host.skipPresets.includes(preset);
        head += ' · preset: ' + (preset ?? 'unknown') + (skipped ? ' (ARGP inactive — in skipPresets)' : '');
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
                capNote = ' (capped from ' + fmtTokens(host.retainTokens) + ')';
        }
        else {
            retain = Math.floor(Math.ceil(visibleChars(session) / host.charsPerToken) * host.retainRatio);
        }
    }
    else {
        retain = Math.floor(trigger * host.retainRatio);
    }
    if (session === null || session === undefined) {
        lines.push('budget: trigger ' + fmtTokens(trigger) + ' / retain ' + fmtTokens(retain) + capNote + ' · no session bound yet');
    }
    else {
        const m = measureTokens(host, session);
        lines.push('budget: trigger ' + fmtTokens(trigger) + ' / retain ' + fmtTokens(retain) + capNote
            + ' · now ' + fmtTokens(m.contextTokens) + ' (source=' + m.source + ')');
    }
    // 段 3：剪枝台账（**会话桶**；批次 3-2：records 为进程内遥测——重启后由账本重建恢复，
    // 重建未及/失败时不再伪造 0，改报日志真值；auditWarnings 一并露出）
    const records = st?.records ?? [];
    const logStarts = session !== null && session !== undefined
        ? session.snapshotEvents().filter(e => e.type === 'compaction/start').length
        : 0;
    if (records.length === 0) {
        lines.push(logStarts > 0
            ? 'prunes: 0 in this process · log has ' + logStarts + ' transaction(s) (ledger rebuild pending)'
            : 'prunes: 0 (no compaction yet)');
    }
    else {
        const last = records[records.length - 1];
        if (last !== undefined) {
            const beforeTok = Math.round(last.charsBefore / host.charsPerToken);
            const afterTok = Math.round(last.charsAfter / host.charsPerToken);
            lines.push('prunes: ' + records.length
                + ' · last ' + last.intervals.length + ' ranges / ' + last.shadowedSeqs.length + ' items / '
                + fmtTokens(beforeTok) + '→' + fmtTokens(afterTok)
                + (last.forced ? ' (forced)' : '')
                + ' · pruned index ' + (st?.prunedNodeIndex.size ?? 0));
        }
    }
    if (st !== null && st.auditWarnings.length > 0) {
        const latest = st.auditWarnings[st.auditWarnings.length - 1] ?? '';
        lines.push('audit: ' + st.auditWarnings.length + ' warning(s) · latest: '
            + (latest.length > 120 ? latest.slice(0, 120) + '…' : latest));
    }
    // 段 4：召回命中（批次 3-2：会话桶 + 进程内口径标注——重启归零不是会话真值）
    const recallCalls = st?.recallCalls ?? [];
    const calls = recallCalls.length;
    const hits = recallCalls.reduce((n, r) => n + (r.hit ? 1 : 0), 0);
    lines.push('recall: ' + calls + ' calls · ' + hits + ' hits (' + fmtPct(hits, calls) + ') [this process]');
    // 段 5：cites 统计（仅双引擎 declarer 在位时输出；纯 Stage-2 下全 0 无意义）
    if (host.peratomStack?.declarer != null && st !== null) {
        const c = st.citeStats;
        lines.push('cites: ' + c.declared + ' declared · ' + c.resolved + ' resolved'
            + ' (' + c.ambiguous + ' ambiguous, ' + c.failed + ' failed) [this process]');
    }
    return { kind: 'success', text: lines.join('\n') };
}
