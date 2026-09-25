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
 * 2. Contributes a dedicated ARGP card to the Plugins settings page, editing
 *    the nine `dsh-argp` engine knobs live.
 *
 *    dsh 0.1.7+ 的接线方式：服务端在插件上声明 `static Config`（schema 里九个旋钮
 *    标 `.volatile()`），宿主 Settings 扫描该 schema 生成表单并把读写句柄暴露为
 *    `ctx.configForms.get('dsh-argp')`；客户端把该句柄适配成卡片模型所需的 scope 接口，
 *    注册进 `settings.plugins.tab`。
 *
 *    0.1.7 之前的旧机制（`settingsScope.bind({ namespace })` + `settings.plugin.item`
 *    slot，配合服务端 `settings.register(ns, schema, { base })`）已随 #4587
 *    `profile-owned-live-configuration` 整体移除；两端 namespace 仍须一致。
 *
 * Graceful degradation: the cites filter probes `assistantDisplay` through
 * `ctx.get()` (returns undefined for absent services, no throw). The card
 * instead uses a NESTED `ctx.inject([...], ...)` on purpose — the
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

import { stripCitesTail } from '../cites-strip.js'
import {
  ArgpConfigController,
  ARG_SETTINGS_KEY,
  en,
  zh,
  type ArgpUserSettings,
  type SettingsScopeLike,
  type SettingsScopeSnapshot,
} from './argp-config-controller.js'
import { ArgpConfigCard } from './argp-config-card.js'

/** Structural shape of the assistant blocks the chat renders. */
interface DisplayBlock {
  readonly kind: string
  readonly text?: unknown
  readonly [key: string]: unknown
}

/** Structural face of the native assistantDisplay seam (ui-conversation). */
interface AssistantDisplaySeam {
  register(
    filter: (
      blocks: readonly DisplayBlock[],
      info: { readonly streaming: boolean },
    ) => readonly DisplayBlock[],
  ): () => void
}

/** The bound settings scope the ARGP card's controller consumes. */
interface SettingsScopeService {
  bind(namespace: { namespace: string }): SettingsScopeLike<ArgpUserSettings>
}

/**
 * dsh 0.1.7+ 的配置表单（取代已移除的 `settingsScope`）。
 *
 * 宿主 0.1.7（#4587）删掉了客户端 `settingsScope` 服务和 `settings.plugin.item` slot；
 * 设置页改由 `static Config` schema 驱动，客户端经 `ctx.configForms.get(ns)` 拿到
 * namespace 的读写句柄。本接口就是那个句柄的形状（见宿主
 * `packages/client/ui-settings/src/client/config-form-types.ts`）。
 */
interface ConfigFormLike<T> {
  getSnapshot(): {
    status: 'loading' | 'ready' | 'unavailable'
    value: T | undefined
    base: unknown
    user: unknown
    revision: number | undefined
    writable: boolean
  }
  subscribe(listener: () => void): () => void
  set(field: string, value: unknown): Promise<boolean>
  unset(field: string): Promise<boolean>
}

/**
 * 把 0.1.7 的 `ConfigForm` 适配成 ARGP 卡片模型所需的 `SettingsScopeLike`。
 *
 * 卡片控制器（`ArgpConfigController`）与读写后端是解耦的：它只依赖
 * `subscribe/getSnapshot/set/unset` 四个方法。宿主换掉了后端但语义一一对应，
 * 故这里做一层薄适配即可，字段校验、staged 编辑、reset 等 UI 逻辑全部保留。
 */
function asSettingsScope<T>(form: ConfigFormLike<T>): SettingsScopeLike<T> {
  return {
    subscribe(listener: () => void): void {
      // 适配器在插件 fiber 生命周期内常驻，故不需要退订；宿主在 reload 时
      // 会整体重新 apply 本 bundle，届时本对象一并丢弃。
      form.subscribe(listener)
    },
    getSnapshot(): SettingsScopeSnapshot {
      const snapshot = form.getSnapshot()
      return {
        status: snapshot.status === 'loading' ? 'loading'
          : snapshot.status === 'unavailable' ? 'unavailable' : 'ready',
        writable: snapshot.writable,
        value: (snapshot.value ?? {}) as Record<string, unknown>,
        base: (snapshot.base ?? {}) as Record<string, unknown>,
        user: snapshot.user as Record<string, unknown> | undefined,
      }
    },
    async set(field: string, value: unknown): Promise<void> {
      await form.set(field, value)
    },
    async unset(field: string): Promise<void> {
      await form.unset(field)
    },
  }
}

/** Structural face of the client configuration forms service (cordis). */
interface ConfigFormsService {
  get<T>(namespace: string): ConfigFormLike<T>
}

/** Structural face of the slots service (cordis). */
interface SlotsService {
  inject(name: string, factory: () => unknown): void
  register(
    options: {
      readonly name: string
      /** Tab key（0.1.7 的 `settings.plugins.tab` 用 `id`；旧 `settings.plugin.item` 用 `key`）。 */
      readonly id: string
      readonly order?: number
      /** Registrant-localized tab text. */
      readonly label?: () => string
      readonly locale: string
      readonly inject: () => unknown
    },
    component: (props: any) => any,
  ): unknown
}

/**
 * Structural face of the locale service (cordis).
 *
 * `register` returns the disposer that removes exactly the dictionaries this
 * call added. The disposer is load-bearing, not decorative: registering a
 * namespace+locale the service already holds THROWS — `locale namespace
 * "dsh-argp" already has locale "zh"` — so the disposer is the only thing that
 * makes a second `apply()` of this bundle legal (see `registerDisposable`).
 */
interface LocaleService {
  register(
    namespace: string,
    dictionary: { readonly zh: Record<string, string>; readonly en: Record<string, string> },
  ): () => void
}

/** Structural root context the cordis loader provides to apply. */
interface ArgpClientContext {
  /** cordis optional service fetch: returns undefined for absent services. */
  get<T>(name: string): T | undefined
  /**
   * cordis disposal-aware effect: runs `execute` now and disposes whatever it
   * returns when the owning fiber unloads or is replaced. Optional only for
   * degenerate hosts/stubs — every real client context carries it.
   */
  effect?(execute: () => unknown, label?: string): unknown
}

/** The injection entry point a client context exposes for waiting on a service. */
interface InjectableContext {
  /** Run `callback` once every named service is composed; re-run on recompose. */
  inject(services: string[], callback: (scoped: ArgpClientContext) => void): void
}

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
function registerDisposable(ctx: ArgpClientContext, execute: () => unknown, label: string): void {
  if (typeof ctx.effect === 'function') {
    ctx.effect(execute, label)
    return
  }
  // Degenerate host without `effect` (structural stubs): still register, but
  // there is no fiber to own the disposer.
  execute()
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
export const inject = ['locale', 'slots']

/**
 * Register the ARGP settings card once the host's configuration forms are composed.
 *
 * Nesting the dependency rather than reading it is deliberate (see the file
 * header, and dsh-market's own comment on its card): the wait is what makes
 * registration independent of plugin activation order, and the fallback on a
 * host without the settings page is to register nothing and leave the rest of
 * this bundle intact.
 *
 * dsh 0.1.7+：`settingsScope` 服务与 `settings.plugin.item` slot 都已移除，改为
 * `configForms` + `settings.plugins.tab`（插件设置页的 tab 座位，选项用 `id`/`label`
 * 而非旧 slot 的 `key`）。namespace 仍是 `dsh-argp`——服务端 `static Config` 所在的
 * profile entry id，两端必须一致。
 *
 * @param ctx - the browser plugin context.
 */
function registerArgpSettingsCard(ctx: ArgpClientContext): void {
  const locale = ctx.get<LocaleService>('locale')
  if (locale?.register !== undefined) {
    // Register the card's copy under its own namespace; the slot's `locale`
    // field points the card's `t` at it. Effect-wrapped so a re-apply disposes
    // the previous dictionary first — a leaked one makes the service throw
    // (see `registerDisposable`).
    registerDisposable(
      ctx,
      () => locale.register(ARG_SETTINGS_KEY, { zh, en }),
      'dsh-argp: settings card dictionaries',
    )
  }

  const injectable = ctx as unknown as InjectableContext
  if (typeof injectable.inject !== 'function') return
  injectable.inject(['configForms', 'locale', 'slots'], (scoped) => {
    try {
      const configForms = scoped.get<ConfigFormsService>('configForms')
      const slots = scoped.get<SlotsService>('slots')
      if (configForms?.get === undefined || slots?.inject === undefined) return

      const form = configForms.get<ArgpUserSettings>(ARG_SETTINGS_KEY)
      const controller = new ArgpConfigController(asSettingsScope(form))
      slots.inject('settings.plugins.tab', () => slots.register(
        {
          name: 'settings.plugins.tab',
          id: ARG_SETTINGS_KEY,
          order: 20,
          // Tab 文案用中性缩写：ARGP 是专有名词，各语言同形，且切换语言时宿主
          // 会重新求值本函数，无需在这层做 locale 绑定。
          label: () => 'ARGP',
          locale: ARG_SETTINGS_KEY,
          inject: () => controller.inject(),
        },
        ArgpConfigCard,
      ))
    } catch (err) {
      // A registration failure must never blank the whole settings dialog; the
      // host's own cards follow the same containment rule.
      console.error('[dsh-argp] settings card registration failed:', err)
    }
  })
}

export function apply(ctx: ArgpClientContext): void {
  const display = ctx.get<AssistantDisplaySeam>('assistantDisplay')
  if (display?.register !== undefined) {
    // Effect-wrapped for the same reason as the locale dictionary: a re-apply
    // that kept the old filter would stack a second one on the render seam.
    registerDisposable(ctx, () => display.register((blocks) => {
      // Only the trailing text block can carry the protocol marker.
      let lastText = -1
      for (let i = blocks.length - 1; i >= 0; i -= 1) {
        const block = blocks[i]
        if (block !== undefined && block.kind === 'text' && typeof block.text === 'string') {
          lastText = i
          break
        }
      }
      if (lastText === -1) return blocks
      const text = blocks[lastText]!.text as string
      const body = stripCitesTail(text)
      if (body === text) return blocks
      const next = blocks.slice()
      next[lastText] = { ...blocks[lastText], text: body }
      return next
    }), 'dsh-argp: cites display filter')
  }

  registerArgpSettingsCard(ctx)
}
