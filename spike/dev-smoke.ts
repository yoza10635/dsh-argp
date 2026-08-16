/**
 * dev-check smoke: load the current argp-graph-engine module and exercise its
 * pure cite extractor. This fails fast on module-level syntax/runtime errors
 * without needing a Cordis context or a live model.
 *
 * Run through dev-check.bat; output lands in dev-check-out.txt.
 */
import { eventText, extractCites } from '../src/argp-graph-engine.ts'

const sample = 'body text\n{"cites":["gateway release passes"]}'
const result = extractCites(sample)
if (result.cites.length !== 1 || result.cites[0] !== 'gateway release passes' || result.body !== 'body text') {
  console.error('[smoke] extractCites mismatch:', result)
  process.exit(1)
}

const userSession = { events: [{ type: 'user/message', data: { content: [{ type: 'text', text: 'user needle' }] } }] } as any
if (eventText(userSession, 0) !== 'user needle') {
  console.error('[smoke] eventText user/message mismatch:', JSON.stringify(eventText(userSession, 0)))
  process.exit(1)
}

console.log('[smoke] argp-graph-engine module loaded; extractCites + user eventText ok')
