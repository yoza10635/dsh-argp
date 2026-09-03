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
 */
/** Structural root context the cordis loader provides to apply. */
interface ArgpClientContext {
    /** cordis optional service fetch: returns undefined for absent services. */
    get<T>(name: string): T | undefined;
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
