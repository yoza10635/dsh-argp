/**
 * dsh-argp client half.
 *
 * Two responsibilities:
 *
 * 1. Hides the ARGP citation protocol marker (a trailing `{"cites":[...]}`
 *    JSON block) from assistant chat rendering. The server engine strips the
 *    marker from the model-visible surface only; the human transcript renders
 *    append-origin text verbatim, so the marker would otherwise stay visible in
 *    the Web UI. This bundle registers a display filter on the native
 *    `assistantDisplay` seam that strips the trailing block at render time —
 *    display only, never touching the log, the model surface, or the stored
 *    message.
 *
 * 2. Contributes a dedicated ARGP card to Settings → Plugins → Plugin
 *    configuration, editing the nine `dsh-argp` engine knobs live. The card is
 *    registered into the `settings.plugin.item` slot keyed by the `dsh-argp`
 *    namespace — the same namespace the server registers through
 *    `ctx.inject(['settings'])` + `settings.register(...)`. The
 *    configurable-plugins tab renders the intersection of two ledgers: the
 *    namespaces the host serves and the cards registered into the slot,
 *    matched by the entry's `key`. Both halves must agree on the name.
 *
 * Graceful degradation: the cites filter probes `assistantDisplay` through
 * `ctx.get()` (returns undefined for absent services, no throw). The card
 * instead uses a NESTED `ctx.inject(['settingsScope'], ...)` on purpose — the
 * same reason dsh-market documents for its own card. `ctx.get` is an immediate
 * read: a service not yet composed at that instant reads as absent, and the
 * card would silently never register depending on nothing but plugin load
 * order. `inject` waits for the dependency, and on a host that lacks the
 * plugin-configuration page entirely the callback simply never runs, so the
 * rest of this bundle keeps working. A third-party bundle carries zero
 * cross-plugin value imports (client bundle purity gate) — collaboration
 * happens through the cordis service, the sanctioned cross-plugin channel.
 *
 * Re-apply safety: both registrations this bundle makes are effect-owned
 * (`registerDisposable`), because the host retracts a plugin by disposing its
 * fiber and applying the client half afresh — the settings page's enable-state
 * sync, an HMR reload, and a version bump all take that path. A leaked locale
 * dictionary makes that second apply throw (`locale namespace "dsh-argp"
 * already has locale "zh"`), which the page surfaces as "插件未能完成同步"
 * while leaving the server-side enable state unchanged.
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
/**
 * Module-level dependency list for the client half. `locale` and `slots` are
 * core browser services every host bundles, so naming them here only guarantees
 * they are composed before `apply` runs — the card's copy registers correctly
 * and `ctx.get('locale')` returns the service instead of undefined.
 *
 * `settingsScope` is deliberately NOT named here: a host without the plugin
 * configuration page would otherwise refuse to mount the whole bundle, which
 * would also drop the assistant-display marker filter below. The card instead
 * nests `ctx.inject(['settingsScope'], ...)` (see dsh-market's own card), so on
 * such a host the card simply never appears and the rest of this bundle keeps
 * working.
 */
export declare const inject: string[];
export declare function apply(ctx: ArgpClientContext): void;
export {};
