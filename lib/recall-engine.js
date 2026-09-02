/**
 * ARGP recall 引擎（spike 3）：CompactionEngine 子类，挂载时注册
 *  - recall_pruned 工具：按被遮蔽 seq 从 append-only 日志找回被剪原文
 *  - argp-contract PromptSection：引用契约（占位内容必须 recall 而非编造）
 *
 * spike 3 设计妥协（记入注释）：session 由 harness 注入（闭包持有）——真实多 agent
 * 场景需按 scope 注册或从 exec.agent 取 session，M1 后再定。
 */
import { CompactionEngine } from '@deepseek-ai/dsh-compaction';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { deriveEventMessage } from '@deepseek-ai/dsh-session';
import { formatRecallOutcome, recallFromLog, sessionEvents } from './log-access.js';
/** 收集当前日志里全部被遮蔽的 surface seq（replace 事件 sourceEventSeqs 的并集）。 */
function shadowedSeqs(session) {
    const shadowed = new Set();
    for (const event of sessionEvents(session)) {
        const op = event.surfaceOp;
        if (op !== undefined && op !== 'append') {
            for (const seq of event.sourceEventSeqs ?? []) {
                shadowed.add(seq);
            }
        }
    }
    return shadowed;
}
/** 从一个事件投影出模型可见文本（text + tool-call 概要 + tool-result 内层 text）。 */
function eventText(session, seq) {
    const event = sessionEvents(session)[seq];
    if (event === undefined)
        return '';
    const message = deriveEventMessage(event);
    if (message === null)
        return '';
    const parts = [];
    for (const block of message.content) {
        if (block.type === 'text')
            parts.push(block.text);
        if (block.type === 'tool-call') {
            parts.push('[tool-call ' + block.name + '(' + (typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments)) + ')]');
        }
        if (block.type === 'tool-result') {
            for (const inner of block.content ?? []) {
                if (inner.type === 'text')
                    parts.push(inner.text);
            }
        }
    }
    return parts.join('\n');
}
export class ArgpRecallEngine extends CompactionEngine {
    // cordis 约束：fiber 内访问其他服务必须先声明 inject（仿 compaction-basic）
    static inject = ['tools', 'systemPrompt'];
    session = null;
    recallCalls = [];
    constructor(ctx) {
        super(ctx);
        const recallTool = defineTool({
            name: 'recall_pruned',
            description: 'Retrieve the original content of any conversation node by its log seq, whether or not it is still in visible context. The reply is prefixed with [recall seq=N state=shadowed|live|off-surface]. Everything ever said stays in the append-only log; use this instead of guessing.',
            parameters: { seq: { type: 'integer', description: 'log seq of the node to recover; placeholders show the seqs they replaced' } },
            output: {
                schema: { type: 'string' },
                render: (_args, value) => [{ type: 'text', text: value }],
            },
            execute: async (args) => {
                const seq = args.seq;
                if (seq === undefined || this.session === null)
                    return 'recall_pruned: no session bound';
                // P1 修复 (b)：去掉 shadowedSeqs 门控，只有越界才算失败（与 argp-graph-engine 同构）
                const shadowed = shadowedSeqs(this.session);
                const outcome = recallFromLog(this.session, seq, s => shadowed.has(s), eventText);
                this.recallCalls.push({ seq, hit: outcome.ok, state: outcome.ok ? outcome.state : undefined });
                return formatRecallOutcome('recall_pruned', seq, outcome);
            },
        });
        ctx.tools.register(recallTool);
        // 引用契约：order 150（tool guidance 带 100–199 约定内）
        ctx.systemPrompt.section({
            name: 'argp-contract',
            order: 150,
            text: () => 'ARGP contract: some history nodes are no longer in visible context — replaced by placeholders like [elided seq=N ...], or dropped from the render window with no placeholder at all. '
                + 'When your answer depends on such content, call recall_pruned with that seq first (it works on any seq in the log) — never reconstruct missing facts from memory.',
        });
        // 契约义务（§4.5 动态复核的最小代理）：每步前若有剪枝则日志可查
        ctx.on('agent/pre-step', async ({ signal }, next) => {
            if (signal.aborted)
                return next();
            return next();
        });
    }
    setSession(session) {
        this.session = session;
    }
    recall(seq) {
        if (this.session === null)
            return null;
        if (!shadowedSeqs(this.session).has(seq))
            return null;
        const text = eventText(this.session, seq);
        return text === '' ? null : text;
    }
    async compactIfNeeded(_agent, _trigger, _signal) {
        return null;
    }
    async compactNow(_agent, _signal) {
        return null;
    }
    async compactRegion() {
        throw new Error('not implemented in spike 3');
    }
}
export default ArgpRecallEngine;
