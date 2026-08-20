/**
 * Shared trailing-cites-block matching/stripping primitives.
 *
 * Pure module (zero imports) so the exact same logic runs on the server
 * (engine surface stripping via `extractCites`) and in the browser (client
 * display filter) without duplication or platform drift.
 */
/** One matched trailing cites block: the raw JSON text and the tail span it occupies. */
export interface CitesTailMatch {
    /** Raw JSON text of the block (fence removed when present). */
    readonly raw: string;
    /** Length of the whole matched trailing segment (fence included when present). */
    readonly span: number;
}
/**
 * Match a trailing ARGP cites JSON block (bare JSON or ```json fence).
 * @param text - assistant reply text.
 * @returns the raw JSON and its trailing span, or null when no block is present.
 */
export declare function matchCitesTail(text: string): CitesTailMatch | null;
/**
 * Parse a cites JSON block into its string list.
 * @param raw - JSON text of the block.
 * @returns the cites array when well-formed (`{"cites": string[]}`), else null.
 */
export declare function parseCitesBlock(raw: string): string[] | null;
/**
 * Strip a trailing well-formed cites block from text, returning the body.
 * Returns the input unchanged when no well-formed block is present.
 * @param text - assistant reply text.
 */
export declare function stripCitesTail(text: string): string;
