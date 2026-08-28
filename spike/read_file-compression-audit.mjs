// 统计 A 臂：哪些 turn 触发了压缩、这些 turn 里 read_file 的数量、是否 zero-gain
import { readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'

// 解析完整事件流，重建 turn 边界
const eventsPath = 'D:/workspace/ARGP/dsh-argp/spike/out/37-three-arm-A-2026-08-27T01-50-41-428Z/events.jsonl'
const events = readFileSync(eventsPath, 'utf8').trim().split('\n').map(JSON.parse)

let openTurn = null
const turns = []
for (const e of events) {
  if (e.type === 'turn/start') {
    openTurn = e.data.turn
    turns.push({ turn: openTurn, events: [], compressed: false, readFileCount: 0, replaceCount: 0 })
  } else if (e.type === 'turn/end') {
    openTurn = null
  } else if (openTurn !== null) {
    const t = turns[turns.length - 1]
    t.events.push(e)
    if (e.type === 'tool/call') {
      const callData = e.data
      if (callData.name === 'read_file') {
        t.readFileCount++
      }
    }
    if (e.type === 'compaction/start') {
      t.compressed = true
      // 统计替换数
      t.replaceCount = (e.data.replacements ?? []).length
    }
    if (e.type === 'compaction/replace') {
      // 逐条 replace
      // 但 compaction/start 里通常已汇总
    }
  }
}

const compressedTurns = turns.filter(t => t.compressed)
console.log(`Total turns: ${turns.length}`)
console.log(`Compressed turns (compaction/start): ${compressedTurns.length}`)

// read_file 触发压缩的 turn
const readfileCompressed = compressedTurns.filter(t => t.readFileCount > 0)
console.log(`read_file triggered compression: ${readfileCompressed.length}`)

// 哪些 turn 的 read_file 没有产生任何 replace
// (compaction/start 里没有 emit replace 的情况)
const readfileNoReplace = readfileCompressed.filter(t => t.replaceCount === 0)
console.log(`read_file no-replace (no-op): ${readfileNoReplace.length}`)

// 有效压缩（有 replace）
const readfileWithReplace = readfileCompressed.filter(t => t.replaceCount > 0)
console.log(`read_file with effective compression: ${readfileWithReplace.length}`)

// 打印详细信息
console.log('\n--- 有 read_file 的压缩轮 (readfileCompressed) ---')
for (const t of readfileCompressed) {
  console.log(`Turn ${t.turn}: read_file=${t.readFileCount}, replace=${t.replaceCount}`)
}
