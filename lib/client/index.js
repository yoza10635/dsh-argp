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
import { stripCitesTail } from '../cites-strip.js';
import { ArgpConfigController, ARG_SETTINGS_KEY, en, zh, } from './argp-config-controller.js';
import { ArgpConfigCard } from './argp-config-card.js';
/**
 * Run one registration inside a cordis effect so its disposer is owned by the
 * plugin fiber.
 *
 * Required for re-apply safety. The host retracts a plugin by disposing its
 * fiber and applying the (possibly new) client half afresh — the enable-state
 * sync on the settings page, an HMR reload, and a version bump all take that
 * path. Two of our registrations are single-shot by contract:
 *
 * - `locale.register(ns, dict)` throws on a namespace+locale it already holds,
 *   so a leaked dictionary turns every later apply into
 *   `locale namespace "dsh-argp" already has locale "zh"` and the page reports
 *   a failed sync instead of activating the plugin.
 * - `assistantDisplay.register(filter)` would silently stack a second filter.
 *
 * Every stock client plugin wraps its registration the same way
 * (`ctx.effect(() => ctx.locale.register(NS, {...}))`), which is what makes
 * their reloads safe. The callback returns the service's own disposer, so
 * cordis runs it at fiber teardown.
 *
 * @param ctx - the browser plugin context.
 * @param execute - the registration call; returns its disposer.
 * @param label - cordis effect label, surfaced in disposal diagnostics.
 */
function registerDisposable(ctx, execute, label) {
    if (typeof ctx.effect === 'function') {
        ctx.effect(execute, label);
        return;
    }
    // Degenerate host without `effect` (structural stubs): still register, but
    // there is no fiber to own the disposer.
    execute();
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
export const inject = ['locale', 'slots'];
/**
 * Register the ARGP settings card once the host's settings scope is composed.
 *
 * Nesting the `settingsScope` dependency rather than reading it is deliberate
 * (see the file header, and dsh-market's own comment on its card): the wait is
 * what makes registration independent of plugin activation order, and the
 * fallback on a host without the settings page is to register nothing and
 * leave the rest of this bundle intact.
 *
 * @param ctx - the browser plugin context.
 */
function registerArgpSettingsCard(ctx) {
    const locale = ctx.get('locale');
    if (locale?.register !== undefined) {
        // Register the card's copy under its own namespace; the slot's `locale`
        // field points the card's `t` at it. Effect-wrapped so a re-apply disposes
        // the previous dictionary first — a leaked one makes the service throw
        // (see `registerDisposable`).
        registerDisposable(ctx, () => locale.register(ARG_SETTINGS_KEY, { zh, en }), 'dsh-argp: settings card dictionaries');
    }
    const injectable = ctx;
    if (typeof injectable.inject !== 'function')
        return;
    injectable.inject(['settingsScope'], (scoped) => {
        try {
            const settingsScope = scoped.get('settingsScope');
            const slots = scoped.get('slots');
            if (settingsScope?.bind === undefined || slots?.inject === undefined)
                return;
            const bound = settingsScope.bind({ namespace: ARG_SETTINGS_KEY });
            const controller = new ArgpConfigController(bound);
            slots.inject('settings.plugin.item', () => slots.register({
                name: 'settings.plugin.item',
                key: ARG_SETTINGS_KEY,
                locale: ARG_SETTINGS_KEY,
                inject: () => controller.inject(),
            }, ArgpConfigCard));
        }
        catch (err) {
            // A registration failure must never blank the whole settings dialog; the
            // host's own cards follow the same containment rule.
            console.error('[dsh-argp] settings card registration failed:', err);
        }
    });
}
export function apply(ctx) {
    const display = ctx.get('assistantDisplay');
    if (display?.register !== undefined) {
        // Effect-wrapped for the same reason as the locale dictionary: a re-apply
        // that kept the old filter would stack a second one on the render seam.
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
    registerArgpSettingsCard(ctx);
}
