// 探针 v2：按 dsh 的"拼接式 zstd 帧"容器逐帧解压（scanZstdFrames + zstdDecompressSync 每帧），
// 然后解析所有 request/header 事件，对比相邻请求的 system 字段是否变化。
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import fs from 'node:fs'

const file = process.argv[2]
if (!file) { console.error('usage: probe-session-system.ts <session.jsonl.zstd>'); process.exit(1) }

const buf = fs.readFileSync(file)
const ZSTD_MAGIC = 0xFD2FB528

// 复刻 dsh scanZstdFrames：定位每个完整帧的 [start,end)
function scanFrames(b: Buffer): { start: number; end: number }[] {
  const frames: { start: number; end: number }[] = []
  let offset = 0
  while (offset < b.length) {
    const start = offset
    if (b.length - offset < 4) break
    if (b.readUInt32LE(offset) !== ZSTD_MAGIC) break
    offset += 4
    if (offset === b.length) break
    const descriptor = b.readUInt8(offset); offset += 1
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (b.length - offset < remainingHeaderBytes) break
    offset += remainingHeaderBytes
    for (;;) {
      if (b.length - offset < 3) break
      const blockHeader = b.readUIntLE(offset, 3); offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) break
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (b.length - offset < payloadBytes) break
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) { if (b.length - offset < 4) break; offset += 4 }
    frames.push({ start, end: offset })
  }
  return frames
}

function shaOf(s: string) { return crypto.createHash('sha256').update(s).digest('hex').slice(0, 12) }

const frames = scanFrames(buf)
let jsonl = ''
let okFrames = 0
for (const f of frames) {
  try {
    const plain = zlib.zstdDecompressSync(buf.subarray(f.start, f.end))
    jsonl += plain.toString('utf8')
    okFrames++
  } catch (e) {
    console.error(`frame ${f.start}-${f.end} decompress failed: ${(e as Error).message.slice(0, 60)}`)
  }
}
console.log(`frames: ${frames.length}, decoded: ${okFrames}, jsonl bytes: ${jsonl.length}`)

// 落盘每个 request/header 的 system 全文，供分段 diff
const OUTDIR = 'spike/out/session-systems'
fs.mkdirSync(OUTDIR, { recursive: true })

const lines = jsonl.split('\n').filter(l => l.trim().length > 0)
console.log(`total lines: ${lines.length}`)

// 抽取 compaction/prune 事件，看 system 变化是否都由剪枝触发
const prunes: { seq: number }[] = []
for (const line of lines) {
  let ev: any
  try { ev = JSON.parse(line) } catch { continue }
  if (ev?.type === 'compaction/prune') prunes.push({ seq: ev.seq })
}
console.log(`compaction/prune events: ${prunes.length} at seqs: [${prunes.map(p => p.seq).join(', ')}]`)

const headers: { seq: number; reason: string; sysLen: number; sysSha: string; first60: string; last60: string; sys: string }[] = []
let prevSha: string | null = null
let lastSystem: string | null = null
let idx = 0
for (const line of lines) {
  let ev: any
  try { ev = JSON.parse(line) } catch { continue }
  if (ev?.type !== 'request/header') continue
  const h = ev.data?.header
  const sys = h?.system ?? ''
  const s = shaOf(sys)
  const reason = ev.data?.reason ?? '?'
  headers.push({ seq: ev.seq, reason, sysLen: sys.length, sysSha: s, first60: sys.slice(0, 60).replace(/\n/g, '\\n'), last60: sys.slice(-60).replace(/\n/g, '\\n'), sys })
  // 落盘全文
  fs.writeFileSync(`${OUTDIR}/req-${String(idx).padStart(2, '0')}-seq${ev.seq}-${reason}.txt`, sys)
  if (prevSha !== null && s !== prevSha) {
    console.log(`\n>>> SYSTEM CHANGED at seq=${ev.seq} reason=${reason} prev[${prevSha}] -> this[${s}]`)
  }
  prevSha = s
  lastSystem = sys
  idx++
}

console.log(`\n=== request/header events: ${headers.length} ===`)
for (const hh of headers) {
  console.log(`seq=${String(hh.seq).padStart(5)} reason=${hh.reason.padEnd(8)} sysLen=${String(hh.sysLen).padStart(6)} sha=${hh.sysSha} first="${hh.first60}"`)
}

let changes = 0
let p: string | null = null
for (const hh of headers) { if (p !== null && hh.sysSha !== p) changes++; p = hh.sysSha }
const reasons = headers.map(h => h.reason)
console.log(`\n=== SUMMARY: ${headers.length} requests, ${changes} system-block changes ===`)
console.log(`reasons: ${reasons.join(', ')}`)
