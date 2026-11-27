/**
 * dsh-argp client half.
 *
 * One responsibility: contributes a dedicated ARGP card to the Plugins settings
 * page, editing the single `dsh-argp` knob (2.0.1 roster: compactionThreshold)
 * live. The 1.x `assistantDisplay` filter (it hid the citation-protocol marker)
 * was removed in 2.2.2 together with that protocol — do not reintroduce a
 * display-side hook without a real payload to filter.
 *
 *    dsh 0.1.7+ 的接线方式：服务端在插件上声明 `static Config`（§3.4 名册的旋钮标
 *    `.volatile()`；engine 判别式刻意非 volatile——宿主 volatile form 不携带非
 *    volatile 键，写则 throw，卡片因此既读不到也写不了它），宿主把读写句柄暴露为
 *    `ctx.configForms.get('dsh-argp')`；客户端把该句柄适配成卡片模型所需的 scope 接口，
 *    注册进 `settings.plugins.tab`（宿主实测：auto 生成表单**没有渲染器**，
 *    settings README「no shipped client does so yet」——本卡是唯一渲染面）。
 *
 *    0.1.7 之前的旧机制（`settingsScope.bind({ namespace })` + `settings.plugin.item`
 *    slot，配合服务端 `settings.register(ns, schema, { base })`）已随 #4587
 *    `profile-owned-live-configuration` 整体移除；两端 namespace 仍须一致。
 *
 * Graceful degradation: the card uses a NESTED `ctx.inject([...], ...)` on
 * purpose — the same reason dsh-market documents for its own card. `ctx.get` is
 * an immediate read: a service not yet composed at that instant reads as absent,
 * and the card would silently never register depending on nothing but plugin
 * load order. `inject` waits for the dependency, and on a host that lacks the
 * plugin-configuration page entirely the callback simply never runs, so the
 * rest of this bundle keeps working. A third-party bundle carries zero
 * cross-plugin value imports (client bundle purity gate) — collaboration
 * happens through the cordis service, the sanctioned cross-plugin channel.
 *
 * Re-apply safety: the registration this bundle makes is effect-owned
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
 * `configForms` is deliberately NOT named here (it replaced the `settingsScope`
 * service removed in 0.1.7 #4587): a host without the plugin configuration
 * page would otherwise refuse to mount the whole bundle. The card instead nests
 * `ctx.inject(['configForms', 'locale', 'slots'], ...)`, so on such a host the
 * card simply never appears and the rest of this bundle keeps working.
 */
export declare const inject: string[];
export declare function apply(ctx: ArgpClientContext): void;
export {};
