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

import { stripCitesTail } from '../cites-strip.js'
import {
  ArgpConfigController,
  ARG_SETTINGS_KEY,
  en,
  zh,
  type ArgpUserSettings,
  type SettingsScopeLike,
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

/** Structural face of the slots service (cordis). */
interface SlotsService {
  inject(name: string, factory: () => unknown): void
  register(
    options: {
      readonly name: string
      readonly key: string
      readonly locale: string
      readonly inject: () => unknown
    },
    component: (props: any) => any,
  ): unknown
}

/** Structural face of the locale service (cordis). */
interface LocaleService {
  register(namespace: string, dictionary: { readonly zh: Record<string, string>; readonly en: Record<string, string> }): void
}

/** Structural root context the cordis loader provides to apply. */
interface ArgpClientContext {
  /** cordis optional service fetch: returns undefined for absent services. */
  get<T>(name: string): T | undefined
}

/** The injection entry point a client context exposes for waiting on a service. */
interface InjectableContext {
  /** Run `callback` once every named service is composed; re-run on recompose. */
  inject(services: string[], callback: (scoped: ArgpClientContext) => void): void
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
function registerArgpSettingsCard(ctx: ArgpClientContext): void {
  const locale = ctx.get<LocaleService>('locale')
  if (locale?.register !== undefined) {
    // Register the card's copy under its own namespace; the slot's `locale`
    // field points the card's `t` at it.
    locale.register(ARG_SETTINGS_KEY, { zh, en })
  }

  const injectable = ctx as unknown as InjectableContext
  if (typeof injectable.inject !== 'function') return
  injectable.inject(['settingsScope'], (scoped) => {
    try {
      const settingsScope = scoped.get<SettingsScopeService>('settingsScope')
      const slots = scoped.get<SlotsService>('slots')
      if (settingsScope?.bind === undefined || slots?.inject === undefined) return

      const bound = settingsScope.bind({ namespace: ARG_SETTINGS_KEY })
      const controller = new ArgpConfigController(bound)
      slots.inject('settings.plugin.item', () => slots.register(
        {
          name: 'settings.plugin.item',
          key: ARG_SETTINGS_KEY,
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
    display.register((blocks) => {
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
    })
  }

  registerArgpSettingsCard(ctx)
}
