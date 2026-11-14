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
/** Structural root context the cordis loader provides to apply. */
interface ArgpClientContext {
    /** cordis optional service fetch: returns undefined for absent services. */
    get<T>(name: string): T | undefined;
    /**
     * cordis disposal-aware effect: runs `execute` now and disposes whatever it
     * returns when the owning fiber unloads or is replaced. Optional only for
     * degenerate hosts/stubs — every real client context carries it.
     */
    effect?(execute: () => unknown, label?: string): unknown;
}
export declare function apply(ctx: ArgpClientContext): void;
export {};
