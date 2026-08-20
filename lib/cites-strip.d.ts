/**
 * Shared trailing-cites-block matching/stripping primitives.
 *
 * Pure module (zero imports) so the exact same logic runs on the server
 * (engine surface stripping via `extractCites`) and in the browser (client
 * display filter) without duplication or platform drift.
 */
/** Citation-grade levels (A1: cites grading V6 contract).
 *  - critical (c): forces the closure guard to treat it as an external critical edge (invariant 2').
 *  - supporting (s): default grade — one semantic edge, no special protection beyond in-degree.
 *  - contextual (x): weakest grade. */
export type CiteLevel = 'critical' | 'supporting' | 'contextual';
/** One parsed citation entry. `level` is 'supporting' for the legacy bare-string form. */
export interface ParsedCite {
    text: string;
    level: CiteLevel;
}
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
 * Parse a cites JSON block into its normalized entry list.
 * @param raw - JSON text of the block.
 * @returns the cite entries when well-formed, else null.
 *
 * Accepts two shapes (A1 V6 contract, backward-compatible):
 *  - legacy: `{"cites": ["prefix", ...]}` — every entry becomes grade `supporting`.
 *  - graded: `{"cites": [{"t": "prefix", "l": "c|s|x"}, ...]}` — grade from `l`.
 */
export declare function parseCitesBlock(raw: string): ParsedCite[] | null;
/**
 * Strip a trailing well-formed cites block from text, returning the body.
 * Returns the input unchanged when no well-formed block is present.
 * @param text - assistant reply text.
 */
export declare function stripCitesTail(text: string): string;
