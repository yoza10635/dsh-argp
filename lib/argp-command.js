import { measureTokens } from './budget.js';
/**
 * 状态行首展示的版本号。**必须与 `package.json` 的 `version` 一致**——
 * `scripts/prerelease-check.mjs` 有断言守着（发版时忘改会直接卡住发布）。
 */
export const ARGP_STATUS_VERSION = '1.10.0';
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
    // 段 1：身份 + 引擎形态 + preset 生效性
    const stage1 = host.peratomStack !== null ? 'graph+peratom' : 'graph';
    let head = 'ARGP ' + ARGP_STATUS_VERSION + ' · engine: ' + stage1;
    if (session !== null && session !== undefined) {
        const preset = host.activePresetOf(session);
        const skipped = preset !== undefined && preset !== null && host.skipPresets.includes(preset);
        head += ' · preset: ' + (preset ?? 'unknown') + (skipped ? ' (ARGP inactive — in skipPresets)' : '');
    }
    lines.push(head);
    // 段 2：预算 + 当前占用
    const trigger = host.resolvedWindowTokens;
    const retain = host.explicitRetainTokens ? host.retainTokens : Math.floor(trigger * host.retainRatio);
    if (session === null || session === undefined) {
        lines.push('budget: trigger ' + fmtTokens(trigger) + ' / retain ' + fmtTokens(retain) + ' · no session bound yet');
    }
    else {
        const m = measureTokens(host, session);
        lines.push('budget: trigger ' + fmtTokens(trigger) + ' / retain ' + fmtTokens(retain)
            + ' · now ' + fmtTokens(m.contextTokens) + ' (source=' + m.source + ')');
    }
    // 段 3：剪枝台账（次数 + 最近一次的形状）
    const total = host.records.length;
    if (total === 0) {
        lines.push('prunes: 0 (no compaction yet)');
    }
    else {
        const last = host.records[total - 1];
        const beforeTok = Math.round(last.charsBefore / host.charsPerToken);
        const afterTok = Math.round(last.charsAfter / host.charsPerToken);
        lines.push('prunes: ' + total
            + ' · last ' + last.intervals.length + ' ranges / ' + last.shadowedSeqs.length + ' items / '
            + fmtTokens(beforeTok) + '→' + fmtTokens(afterTok)
            + (last.forced ? ' (forced)' : '')
            + ' · pruned index ' + host.prunedNodeIndex.size);
    }
    // 段 4：召回命中（recall_pruned / recall_detail 的实际使用面）
    const calls = host.recallCalls.length;
    const hits = host.recallCalls.reduce((n, r) => n + (r.hit ? 1 : 0), 0);
    lines.push('recall: ' + calls + ' calls · ' + hits + ' hits (' + fmtPct(hits, calls) + ')');
    // 段 5：cites 统计（仅双引擎 declarer 在位时输出；纯 Stage-2 下全 0 无意义）
    if (host.peratomStack?.declarer != null) {
        const c = host.citeStats;
        lines.push('cites: ' + c.declared + ' declared · ' + c.resolved + ' resolved'
            + ' (' + c.ambiguous + ' ambiguous, ' + c.failed + ' failed)');
    }
    return { kind: 'success', text: lines.join('\n') };
}
