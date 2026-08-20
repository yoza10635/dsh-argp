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
 * Parse a cites JSON block into its normalized entry list.
 * @param raw - JSON text of the block.
 * @returns the cite entries when well-formed, else null.
 *
 * Accepts two shapes (A1 V6 contract, backward-compatible):
 *  - legacy: `{"cites": ["prefix", ...]}` — every entry becomes grade `supporting`.
 *  - graded: `{"cites": [{"t": "prefix", "l": "c|s|x"}, ...]}` — grade from `l`.
 */
export function parseCitesBlock(raw) {
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed.cites))
            return null;
        const out = [];
        for (const item of parsed.cites) {
            if (typeof item === 'string') {
                out.push({ text: item, level: 'supporting' });
                continue;
            }
            if (item !== null && typeof item === 'object' && typeof item.t === 'string') {
                const t = item.t;
                const l = item.l;
                let level = 'supporting';
                if (typeof l === 'string') {
                    // 精确匹配 + 全词容错（V6 契约 l ∈ c|s|x，但模型可能输出全词或拼写近似）：
                    // 先判 critical（c/critical），再 contextual（x/contextual），非法值回退 supporting。
                    // ⚠ 禁止 includes('c') 之类子串匹配——l="contextual" 会被误升成 critical（最强保护档，误判方向最危险）。
                    const lv = l.trim().toLowerCase();
                    if (lv === 'c' || lv === 'critical')
                        level = 'critical';
                    else if (lv === 'x' || lv === 'contextual')
                        level = 'contextual';
                    else
                        level = 'supporting';
                }
                out.push({ text: t, level });
                continue;
            }
            return null;
        }
        return out;
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
