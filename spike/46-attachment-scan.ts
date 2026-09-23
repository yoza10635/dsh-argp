/**
 * 46-attachment-scan：真实语料里 user 消息带 image/file 附件块的普遍性扫描。
 *
 * 目的：验证「用户上传的文件/图片」在实战 session 里出现频率与形态，
 * 为「附件消息是否该排除出 Stage-1 LLM 提取」提供证据（N>1，多 session）。
 *
 * 隐私铁律：只输出聚合量（计数/分布），不输出任何原文。
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as zlib from 'node:zlib'

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

function loadEvents(file: string): Array<Record<string, unknown>> {
  const buf = fs.readFileSync(file)
  const frames: Buffer[] = []
  let i = 0
  while (i < buf.length - 4) {
    if (buf.subarray(i, i + 4).equals(ZSTD_MAGIC)) {
      let j = i + 4
      while (j < buf.length - 4) {
        if (buf.subarray(j, j + 4).equals(ZSTD_MAGIC)) break
        j++
      }
      const frame = buf.subarray(i, j === buf.length ? buf.length : j)
      try { frames.push(zlib.zstdDecompressSync(frame)) } catch { /* 伪命中跳过 */ }
      i = j === buf.length ? buf.length : j
    } else i++
  }
  const text = Buffer.concat(frames).toString('utf8')
  const out: Array<Record<string, unknown>> = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line)) } catch { /* skip */ }
  }
  return out
}

function contentBlocks(data: Record<string, unknown>): Array<Record<string, unknown>> {
  const msg = data?.['message'] as Record<string, unknown> | undefined
  const c = msg?.['content']
  if (Array.isArray(c)) return c.filter((b): b is Record<string, unknown> => typeof b === 'object' && b !== null)
  // V3 user 消息 content 可能直接在 data 下
  const c2 = data?.['content']
  if (Array.isArray(c2)) return c2.filter((b): b is Record<string, unknown> => typeof b === 'object' && b !== null)
  return []
}

const root = path.join(os.homedir(), '.dsh', 'sessions')
if (!fs.existsSync(root)) { console.log('no session root'); process.exit(0) }

let totalUserMsg = 0
let withImage = 0
let withFile = 0
let withEither = 0
let textOnlyLong = 0
const perSession: Array<{ id: string; user: number; img: number; file: number }> = []
const sampleShapes: string[] = []

for (const slug of fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name)) {
  const slugDir = path.join(root, slug)
  for (const id of fs.readdirSync(slugDir)) {
    const idDir = path.join(slugDir, id)
    let entries: string[]
    try { entries = fs.readdirSync(idDir) } catch { continue }
    const files = entries.filter(f => /^session\.v\d+\.jsonl\.zstd$/.test(f))
    if (files.length === 0) continue
    files.sort((a, b) => parseInt(b.match(/v(\d+)/)![1]) - parseInt(a.match(/v(\d+)/)![1]))
    const events = loadEvents(path.join(idDir, files[0]))
    let user = 0, img = 0, file = 0
    for (const ev of events) {
      if (ev.type !== 'user/message') continue
      user++
      const blocks = contentBlocks(ev.data as Record<string, unknown>)
      const hasImg = blocks.some(b => b.type === 'image')
      const hasFile = blocks.some(b => b.type === 'file')
      if (hasImg) img++
      if (hasFile) file++
      if (hasImg || hasFile) {
        withEither++
        if (sampleShapes.length < 5) {
          const shape = blocks.map(b => {
            if (b.type === 'image') { const a = b.attachment as Record<string, unknown> | undefined; return `image(${a?.name ?? a?.attachmentId ?? '?'},${a?.bytes ?? '?'}B)` }
            if (b.type === 'file') { const a = b.attachment as Record<string, unknown> | undefined; return `file(${a?.name ?? a?.attachmentId ?? '?'},${a?.bytes ?? '?'}B)` }
            if (b.type === 'text') return `text(${String(b.text).length}ch)`
            return String(b.type)
          }).join(' + ')
          sampleShapes.push(`${id}: ${shape}`)
        }
      }
      // 纯文本长度（判断伴随文本是否长）
      const textLen = blocks.filter(b => b.type === 'text').reduce((n, b) => n + String(b.text).length, 0)
      if (textLen > 2000 && !hasImg && !hasFile) textOnlyLong++
    }
    totalUserMsg += user
    withImage += img
    withFile += file
    perSession.push({ id, user, img, file })
  }
}

const sessionsWithAttach = perSession.filter(s => s.img > 0 || s.file > 0)
console.log('=== 附件消息普遍性扫描（真实语料，仅聚合量） ===')
console.log(`session 总数: ${perSession.length}`)
console.log(`user/message 总数: ${totalUserMsg}`)
console.log(`含 image 块的 user 消息: ${withImage}`)
console.log(`含 file 块的 user 消息: ${withFile}`)
console.log(`含任一附件的 user 消息: ${withEither} (${totalUserMsg ? ((withEither / totalUserMsg) * 100).toFixed(1) : 0}%)`)
console.log(`含附件的 session 数: ${sessionsWithAttach.length} / ${perSession.length}`)
console.log(`纯文本 >2000ch 且无附件的 user 消息（对照）: ${textOnlyLong}`)
console.log('\n--- 含附件 session 明细 ---')
for (const s of sessionsWithAttach) console.log(`  ${s.id}: user=${s.user} image=${s.img} file=${s.file}`)
console.log('\n--- 附件形态样本（脱敏：仅 name/bytes/type） ---')
for (const s of sampleShapes) console.log(`  ${s}`)
