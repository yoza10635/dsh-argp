/**
 * dsh-argp client half.
 *
 * One responsibility: **hide the ARGP citation protocol marker** (a trailing
 * `{"cites":[...]}` JSON block) from assistant chat rendering. The server
 * engine strips the marker from the model-visible surface only; the human
 * transcript renders append-origin text verbatim, so the marker would
 * otherwise stay visible in the Web UI. This bundle registers a display filter
 * on the native `assistantDisplay` seam that strips the trailing block at
 * render time — display only, never touching the log, the model surface, or the
 * stored message.
 *
 * 2.0.0：设置卡整体退役（零旋钮）——本 bundle 不再注册 settings.plugins.tab、
 * 不再携带 locale 字典。原六枚旋钮（windowRatio/retainRatio/charsPerToken/
 * focalTurns/vocabTopN/recallLimit）缺省值固化在服务端 constants.ts。
 *
 * Graceful degradation: the filter probes `assistantDisplay` through
 * `ctx.get()` (returns undefined for absent services, no throw), so hosts
 * without that seam (headless/CLI) simply skip the display filter.
 *
 * Re-apply safety: the filter registration is effect-owned
 * (`registerDisposable`), because the host retracts a plugin by disposing its
 * fiber and applying the client half afresh — an HMR reload or a version bump
 * takes that path; a leaked filter would stack a second one on the seam.
 */
import { stripCitesTail } from '../cites-strip.js';
/**
 * Run one registration inside a cordis effect so its disposer is owned by the
 * plugin fiber. Required for re-apply safety: `assistantDisplay.register`
 * would silently stack a second filter after a retract without disposal.
 *
 * @param ctx - the browser plugin context.
 * @param execute - the registration call; returns its disposer.
 * @param label - cordis effect label, surfaced in disposal diagnostics.
 */
function registerDisposable(ctx, execute, label) {
    if (typeof ctx.effect === 'function') {
        // cordis runs `execute` now and owns the returned disposer at fiber teardown.
        ctx.effect(execute, label);
        return;
    }
    execute();
}
export function apply(ctx) {
    const display = ctx.get('assistantDisplay');
    if (display?.register !== undefined) {
        // Effect-wrapped: a re-apply that kept the old filter would stack a second
        // one on the render seam.
        registerDisposable(ctx, () => display.register((blocks) => {
            // Only the trailing text block can carry the protocol marker.
            let lastText = -1;
            for (let i = blocks.length - 1; i >= 0; i -= 1) {
                const block = blocks[i];
                if (block !== undefined && block.kind === 'text' && typeof block.text === 'string') {
                    lastText = i;
                    break;
                }
            }
            if (lastText === -1)
                return blocks;
            const text = blocks[lastText].text;
            const body = stripCitesTail(text);
            if (body === text)
                return blocks;
            const next = blocks.slice();
            next[lastText] = { ...blocks[lastText], text: body };
            return next;
        }), 'dsh-argp: cites display filter');
    }
}
