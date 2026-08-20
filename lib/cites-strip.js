/**
 * Shared trailing-cites-block matching/stripping primitives.
 *
 * Pure module (zero imports) so the exact same logic runs on the server
 * (engine surface stripping via `extractCites`) and in the browser (client
 * display filter) without duplication or platform drift.
 */
const CITES_TAIL_FENCED = /```(?:json)?\s*(\{[\s\S]*?\})\s*```\s*$/;
const CITES_TAIL_BARE = /(\{\s*"cites"\s*:[\s\S]*?\})\s*$/;
/**
 * Match a trailing ARGP cites JSON block (bare JSON or ```json fence).
 * @param text - assistant reply text.
 * @returns the raw JSON and its trailing span, or null when no block is present.
 */
export function matchCitesTail(text) {
    const fenced = text.match(CITES_TAIL_FENCED);
    const bare = text.match(CITES_TAIL_BARE);
    const raw = fenced?.[1] ?? bare?.[1];
    if (raw === undefined)
        return null;
    const span = (fenced?.[0] ?? bare?.[0] ?? '').length;
    return { raw, span };
}
/**
 * Parse a cites JSON block into its string list.
 * @param raw - JSON text of the block.
 * @returns the cites array when well-formed (`{"cites": string[]}`), else null.
 */
export function parseCitesBlock(raw) {
    try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed.cites) && parsed.cites.every(c => typeof c === 'string')) {
            return parsed.cites;
        }
        return null;
    }
    catch {
        return null;
    }
}
/**
 * Strip a trailing well-formed cites block from text, returning the body.
 * Returns the input unchanged when no well-formed block is present.
 * @param text - assistant reply text.
 */
export function stripCitesTail(text) {
    const matched = matchCitesTail(text);
    if (matched === null)
        return text;
    if (parseCitesBlock(matched.raw) === null)
        return text;
    return text.slice(0, text.length - matched.span).trimEnd();
}
