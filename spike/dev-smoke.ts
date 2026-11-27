/**
 * dev-check smoke: load the current argp-engine module and exercise its pure
 * eventText read path. This fails fast on module-level syntax/runtime errors
 * without needing a Cordis context or a live model.
 *
 * Run through dev-check.bat; output lands in dev-check-out.txt.
 *
 * 2.2.2：原尾块提取器探针已随 1.x 引用协议子系统整体删除。
 */
import { eventText } from '../src/argp-engine.ts'

const userSession = { events: [{ type: 'user/message', data: { content: [{ type: 'text', text: 'user needle' }] } }] } as any
if (eventText(userSession, 0) !== 'user needle') {
  console.error('[smoke] eventText user/message mismatch:', JSON.stringify(eventText(userSession, 0)))
  process.exit(1)
}

console.log('[smoke] argp-engine module loaded; user eventText ok')
