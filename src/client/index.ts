/**
 * dsh-argp client half: hides the ARGP citation protocol marker (a trailing
 * `{"cites":[...]}` JSON block) from assistant chat rendering.
 *
 * Why: the server engine strips the marker from the model-visible surface
 * only. The human transcript intentionally renders append-origin text verbatim
 * (core session surface.ts — "replacement copies stay model-only"), so the
 * marker would otherwise stay visible in the Web UI. This bundle registers a
 * display filter on the native `assistantDisplay` seam (ui-conversation) that
 * strips the trailing block at render time — display only, never touching the
 * log, the model surface, or the stored message.
 *
 * The seam's service face is declared structurally below so this bundle
 * carries zero cross-plugin value imports (client bundle purity gate);
 * collaboration happens through the cordis service, exactly the sanctioned
 * cross-plugin channel.
 */
import { stripCitesTail } from '../cites-strip.js'

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

/** Structural root context the cordis loader provides to apply. */
interface ArgpClientContext {
  assistantDisplay: AssistantDisplaySeam
}

/** Services this bundle requires before apply runs. */
export const inject = ['assistantDisplay']

export function apply(ctx: ArgpClientContext): void {
  ctx.assistantDisplay.register((blocks) => {
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
