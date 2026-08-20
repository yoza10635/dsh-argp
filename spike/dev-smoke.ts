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
// V6 分级契约（A1）：cites[] 元素从 string → { text, level }，裸字符串降级为 supporting
const c0 = result.cites[0] as { text?: string; level?: string } | undefined
if (result.cites.length !== 1 || c0 === undefined || c0.text !== 'gateway release passes' || c0.level !== 'supporting' || result.body !== 'body text') {
  console.error('[smoke] extractCites mismatch:', result)
  process.exit(1)
}

// V6 分级契约（A1）：{"t","l"} 对象条目解析
const gradedSample = 'body text\n{"cites":[{"t":"gateway release","l":"c"}]}'
const graded = extractCites(gradedSample)
const g0 = graded.cites[0] as { text?: string; level?: string } | undefined
if (graded.cites.length !== 1 || g0 === undefined || g0.text !== 'gateway release' || g0.level !== 'critical') {
  console.error('[smoke] V6 graded cites mismatch:', graded)
  process.exit(1)
}

const userSession = { events: [{ type: 'user/message', data: { content: [{ type: 'text', text: 'user needle' }] } }] } as any
if (eventText(userSession, 0) !== 'user needle') {
  console.error('[smoke] eventText user/message mismatch:', JSON.stringify(eventText(userSession, 0)))
  process.exit(1)
}

console.log('[smoke] argp-graph-engine module loaded; extractCites + user eventText ok')
