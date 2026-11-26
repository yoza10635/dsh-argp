#!/usr/bin/env node
// ============================================================================
// DSH 宿主 session 存档（v4）离线 fold 健康检查 / 撤回式修复
// ----------------------------------------------------------------------------
// 存档 = 每个会话目录下的 session.v4.jsonl.zstd：zstd 压缩的 JSONL。
// 注意：真实存档是**多帧 zstd**（一次 append 写一帧，帧内若干完整行），
//       Node 的 zstdDecompressSync 只解第一帧，所以这里先按 zstd 帧格式
//       （RFC 8878）切帧再逐帧解压，最后把明文按行拼回 JSONL。
//
// 宿主的 fold 规则（与本脚本相关的部分，逐条复刻）：
//   1. 事件可选顶层 surfaceOp：
//        "append"                          -> 追加到 surface 尾；
//        {op:"replace",startSeq,endSeq}    -> 替换 surface 上的一段；
//        无该字段                          -> 非 surface 事件（turn/start、compaction/prune…）。
//      宿主还要求 surface 类型事件必须带 surfaceOp，非 surface 事件不允许带。
//   2. surface 类型集合 = {assistant/message, developer/message, system/message, tool/result, user/message}
//   3. 致命规则：type === "tool/result" 且 surfaceOp !== "append" 时宿主调用 requireTurn()：
//      若此刻没有开放轮（最近一个 turn/start 未配对 turn/end）→
//      抛 SessionFormatError("tool/result is outside an open turn")，整档判 corrupt 拒载。
//   4. replace 形态要求：startSeq/endSeq 必须当前仍在 surface 上、start 索引 <= end 索引，
//      且被替换掉的那段 surface 节点必须全部出现在事件顶层 sourceEventSeqs 里
//      （否则抛 "replacement sourceEventSeqs omit a shadowed surface node"）。
//   5. 轮状态机：turn/start 的 data.turn 开启该轮；turn/end 关闭。
//
// 修复策略（仅 --fix，默认只读审计）——撤回式修复，绝不改类型：
//   对每一处"轮外 replace 型 tool/result"（判据 3），识别紧邻成对的
//   compaction/prune 事件，成对删除（撤销这次剪枝，原 R 节点回到 surface），
//   然后全量重编号 seq 并改写所有 seq 引用（surfaceOp.startSeq/endSeq、
//   sourceEventSeqs、shadowedSeqs、shadowedRange、messageSeqs、headerSeq…）。
//   不把 tool/result 改成 user/message：那会让原 tool-call 变成孤儿 A。
//   写盘前备份 .bak-<yyyyMMdd-HHmmss>，写盘后重读自检（0 违规 + 恢复节点在 surface），
//   自检失败从备份回滚并以退出码 3 报错。
//
// 说明：除任务要求的判据 3/4/5 外，还顺带复刻了宿主 surface fold 的其它拒载判据
// （tool/result replace 只许改 content、protected system head、compaction span 必须
// 精确等于当前 surface 区间），因此结果比"只查 3/4/5"更接近真实可加载性。
//
// 用法：
//   node spike/09-session-fold-audit.mjs [--root <目录>] [--json]
//   node spike/09-session-fold-audit.mjs [--root <目录>] --fix [--fix-max 64] [--dry-run] [--json]
//
// 默认 --root = %USERPROFILE%\.dsh\sessions（若 %USERPROFILE%\.dsh\profiles 存在也递归扫描）。
// 退出码：0 = 全部干净；1 = 存在违规/修复被拒绝；2 = 环境或参数问题；3 = 修复后自检失败已回滚。
//
// 纯 Node ESM、零第三方依赖；不 import 仓库内 TS/JS。
// ============================================================================

import {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  copyFileSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, resolve as resolvePath } from 'node:path'
import * as nodeZlib from 'node:zlib'

// Node >= 22.15 才有 zstd 同步 API。用命名空间导入而不是具名导入：
// 旧 Node 上具名导入会直接抛 SyntaxError，无法打印可读的错误提示。
const zstdDecompressSync =
  typeof nodeZlib.zstdDecompressSync === 'function' ? nodeZlib.zstdDecompressSync : null
const zstdCompressSync =
  typeof nodeZlib.zstdCompressSync === 'function' ? nodeZlib.zstdCompressSync : null

const SESSION_FILE_NAME = 'session.v4.jsonl.zstd'
const ZSTD_MAGIC = 0xfd2fb528 // 标准 zstd 帧魔数（小端字节序 28 B5 2F FD）
const ZSTD_SKIPPABLE_MIN = 0x184d2a50 // 可跳过帧魔数区间 [0x184D2A50, 0x184D2A5F]
const ZSTD_SKIPPABLE_MAX = 0x184d2a5f
const DEFAULT_FIX_MAX = 64
const FIX_WRITE_BATCH_LINES = 64 // 重写时每帧装多少行（保持"多帧压缩"的落盘形态）

// 宿主 SURFACE_TYPES（消息可见面类型集合）
const SURFACE_TYPES = new Set([
  'assistant/message',
  'developer/message',
  'system/message',
  'tool/result',
  'user/message',
])
const TURN_START = 'turn/start'
const TURN_END = 'turn/end'
const COMPACTION_START = 'compaction/start'
const COMPACTION_SUMMARY = 'compaction/summary'
const COMPACTION_PRUNE = 'compaction/prune'
const COMPACTION_END = 'compaction/end'

// 违规类别。前四条是任务要求的宿主判据；其余是宿主 fold 中同样会导致拒载、
// 顺手一起校验的判据（见文件顶部注释与 README 说明）。
const V = {
  OUTSIDE_TURN: 'outside-turn-tool-result-replace', // 判据 3：轮外 replace 型 tool/result
  RANGE_NOT_ON_SURFACE: 'replace-range-not-on-surface', // 判据 4：替换范围不在当前 surface
  RANGE_INVALID: 'replace-op-invalid', // replace 形态本身非法（范围引用未来事件等）
  SOURCES_OMIT: 'replace-sources-omit-shadowed', // 判据 4：sourceEventSeqs 漏掉被 shadow 节点
  SOURCES_INVALID: 'source-event-seqs-invalid', // sourceEventSeqs 非数组/含重复/引用未来事件
  SURFACE_OP_MISSING: 'surface-op-missing', // surface 事件缺 surfaceOp
  SURFACE_OP_INVALID: 'surface-op-invalid', // surfaceOp 形状非法
  SEQ_CONTIGUITY: 'seq-not-contiguous', // 事件 seq 与下标不一致（宿主要求 0 起连续）
  EVENT_SHAPE: 'event-shape-invalid', // 事件不是带 type 的对象
  TURN_MARKER: 'turn-marker-invalid', // turn/start、turn/end 的 data.turn 非法
  TOOL_RESULT_REWRITE: 'tool-result-rewrite-not-content-only', // 宿主：tool/result replace 只允许改 content
  SYSTEM_HEAD: 'system-head-illegal-rewrite', // 宿主：首节点 system prompt 只允许 system/message 单节点改写
  COMPACTION_SPAN: 'compaction-span-mismatch', // 宿主：prune/summary 的 shadowedRange/Seqs 必须等于当前 surface 区间
  NON_SURFACE_MARKER: 'non-surface-event-carries-surface-marker', // 已知非 surface 事件带了 surfaceOp
  JSON_INVALID: 'json-parse-error', // 某一行不是合法 JSON
  FRAME_CORRUPT: 'zstd-frame-corrupt', // zstd 帧结构/解压错误
  HEADER_INVALID: 'session-header-invalid', // 首行不是合法 v4 session header
}

const VIOLATION_LABELS = {
  [V.OUTSIDE_TURN]: '轮外 replace 型 tool/result（宿主 requireTurn 直接拒载）',
  [V.RANGE_NOT_ON_SURFACE]: 'replace 范围不在当前 surface',
  [V.RANGE_INVALID]: 'replace surfaceOp 非法',
  [V.SOURCES_OMIT]: 'sourceEventSeqs 漏掉被 shadow 的 surface 节点',
  [V.SOURCES_INVALID]: 'sourceEventSeqs 不合法',
  [V.SURFACE_OP_MISSING]: 'surface 事件缺少 surfaceOp',
  [V.SURFACE_OP_INVALID]: 'surfaceOp 非法',
  [V.SEQ_CONTIGUITY]: '事件 seq 不连续',
  [V.EVENT_SHAPE]: '事件结构非法',
  [V.TURN_MARKER]: '轮标记非法',
  [V.TOOL_RESULT_REWRITE]: 'tool/result 替换改了 content 以外的字段',
  [V.SYSTEM_HEAD]: '非法改写 protected system head',
  [V.COMPACTION_SPAN]: 'compaction span 与当前 surface 不一致',
  [V.NON_SURFACE_MARKER]: '非 surface 事件携带 surface 标记',
  [V.JSON_INVALID]: 'JSON 行解析失败',
  [V.FRAME_CORRUPT]: 'zstd 帧损坏',
  [V.HEADER_INVALID]: 'session header 非法',
}

const MAX_DISPLAY_PER_KIND = 10 // 人类可读输出里每类最多展示 10 条

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 宿主 isEventSeq：非负安全整数（事件 seq 坐标）。 */
function isEventSeq(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** 宿主 isReplaceOp：exact {op:"replace",startSeq,endSeq}，不允许多余键。 */
function isReplaceOp(value) {
  return (
    isObject(value) &&
    Object.keys(value).length === 3 &&
    Object.hasOwn(value, 'op') &&
    Object.hasOwn(value, 'startSeq') &&
    Object.hasOwn(value, 'endSeq') &&
    value.op === 'replace' &&
    isEventSeq(value.startSeq) &&
    isEventSeq(value.endSeq)
  )
}

/** 宿主 isDeepStrictEqual 的 JSON 值域等价实现（避免 node:util 依赖之外的差异）。 */
function isDeepEqualJson(a, b) {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, index) => isDeepEqualJson(item, b[index]))
  }
  if (!isObject(a) || !isObject(b)) return false
  const aKeys = Object.keys(a)
  if (aKeys.length !== Object.keys(b).length) return false
  return aKeys.every((key) => Object.hasOwn(b, key) && isDeepEqualJson(a[key], b[key]))
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return String(bytes)
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`
}

/** 本地时间 yyyyMMdd-HHmmss（备份文件后缀）。 */
function formatTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  )
}

function displayPath(root, filePath) {
  const rel = relative(root, filePath)
  return rel === '' ? filePath : rel
}

/** 汇总违规：按类别分组，供输出/JSON 使用。 */
function groupViolations(violations) {
  const groups = new Map()
  for (const violation of violations) {
    const list = groups.get(violation.kind) ?? []
    list.push(violation)
    groups.set(violation.kind, list)
  }
  return groups
}

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    root: null,
    fix: false,
    dryRun: false,
    json: false,
    fixMax: DEFAULT_FIX_MAX,
    help: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    switch (token) {
      case '--root': {
        const value = argv[index + 1]
        if (value === undefined || value.startsWith('--')) throw new Error('--root 需要一个目录参数')
        args.root = value
        index += 1
        break
      }
      case '--fix':
        args.fix = true
        break
      case '--dry-run':
        args.dryRun = true
        break
      case '--json':
        args.json = true
        break
      case '--fix-max': {
        const value = argv[index + 1]
        if (value === undefined) throw new Error('--fix-max 需要一个正整数参数')
        const parsed = Number(value)
        if (!Number.isSafeInteger(parsed) || parsed <= 0) {
          throw new Error(`--fix-max 必须是正整数（收到 ${value}）`)
        }
        args.fixMax = parsed
        index += 1
        break
      }
      case '--help':
      case '-h':
        args.help = true
        break
      default:
        throw new Error(`未知参数: ${token}`)
    }
  }
  if (args.dryRun && !args.fix) throw new Error('--dry-run 只能与 --fix 一起使用')
  return args
}

const HELP_TEXT = `DSH v4 session 存档离线 fold 健康检查 / 撤回式修复

用法:
  node spike/09-session-fold-audit.mjs [--root <目录>] [--json]
  node spike/09-session-fold-audit.mjs [--root <目录>] --fix [--fix-max <n>] [--dry-run] [--json]

选项:
  --root <目录>   扫描根（默认 %USERPROFILE%\\.dsh\\sessions，并附加存在的 %USERPROFILE%\\.dsh\\profiles）
  --fix           只读审计后，对"轮外 replace 型 tool/result"做撤回式修复：
                  删除紧邻的 compaction/prune + replace 事件对，全量重编号并改写 seq 引用；
                  写盘前备份为 session.v4.jsonl.zstd.bak-<yyyyMMdd-HHmmss>，写后自检，失败回滚。
  --dry-run       与 --fix 连用：只打印修复计划与内存自检结果，不写盘。
  --fix-max <n>   一次最多修复的违规数（默认 ${DEFAULT_FIX_MAX}）；超过则整次拒绝。
  --json          stdout 只输出一份机器可读 JSON。
  -h, --help      显示本帮助。

退出码: 0 全部干净 / 1 存在违规或被拒绝 / 2 环境或参数问题 / 3 修复自检失败已回滚
`

// ---------------------------------------------------------------------------
// 根目录与文件遍历
// ---------------------------------------------------------------------------

/** 解析扫描根：显式 --root 时只用该根；默认 sessions +（存在的）profiles。 */
function resolveRoots(args) {
  const candidates = []
  if (args.root !== null) {
    candidates.push(resolvePath(args.root))
  } else {
    candidates.push(join(homedir(), '.dsh', 'sessions'))
    const profiles = join(homedir(), '.dsh', 'profiles')
    if (existsSync(profiles)) candidates.push(profiles)
  }
  const seen = new Set()
  const roots = []
  for (const candidate of candidates) {
    const abs = resolvePath(candidate)
    if (seen.has(abs)) continue
    seen.add(abs)
    roots.push(abs)
  }
  return roots
}

/**
 * 递归找出所有 session.v4.jsonl.zstd（含隐藏目录；跳过 node_modules/.git）。
 * 返回 [{ file, root }]，按路径排序，按绝对路径去重。
 */
function walkFiles(roots) {
  const found = []
  const seen = new Set()
  const walk = (root, dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return // 不可读目录：跳过（审计工具不应因个别目录权限失败）
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue
        walk(root, full)
      } else if (entry.isFile() && entry.name === SESSION_FILE_NAME) {
        const abs = resolvePath(full)
        if (seen.has(abs)) continue
        seen.add(abs)
        found.push({ file: abs, root })
      }
    }
  }
  for (const root of roots) {
    let stats
    try {
      stats = statSync(root)
    } catch {
      continue
    }
    if (stats.isFile()) {
      if (basename(root) === SESSION_FILE_NAME && !seen.has(resolvePath(root))) {
        seen.add(resolvePath(root))
        found.push({ file: resolvePath(root), root: dirname(resolvePath(root)) })
      }
    } else if (stats.isDirectory()) {
      walk(root, root)
    }
  }
  found.sort((left, right) => (left.file < right.file ? -1 : left.file > right.file ? 1 : 0))
  return found
}

// ---------------------------------------------------------------------------
// zstd 多帧解析
// ---------------------------------------------------------------------------

/** 读 n 字节并前移偏移；越界抛 RangeError（调用方据此判定"尾部截断"）。 */
function take(buffer, offset, count) {
  if (offset + count > buffer.length) throw new RangeError('frame body truncated')
  return offset + count
}

/**
 * 解析单个 zstd 帧从帧头到帧尾的字节偏移（不依赖解压器）。
 * 帧结构：Magic(4) + Frame_Header_Descriptor(1) + [Window_Descriptor] + [Dict_ID] + [Frame_Content_Size]
 *        + 若干 Block（3 字节头 + 负载）+ [Content_Checksum(4)]。
 * Block_Header: bit0 = last, bit1..2 = type, bit3..23 = blockSize。
 * type 0 raw（负载 blockSize）、1 RLE（负载 1 字节）、2 compressed（负载 blockSize）、3 保留（非法）。
 * @returns 帧尾偏移（下一个帧的起点）
 */
function skipZstdFrame(buffer, offset) {
  offset += 4 // magic 已由调用方校验
  offset = take(buffer, offset, 1)
  const descriptor = buffer[offset - 1]
  const frameContentSizeFlag = (descriptor >> 6) & 0x3
  const singleSegment = (descriptor >> 5) & 0x1
  const checksumFlag = (descriptor >> 2) & 0x1
  const dictionaryIdFlag = descriptor & 0x3
  if (!singleSegment) offset = take(buffer, offset, 1) // Window_Descriptor
  if (dictionaryIdFlag === 1) offset = take(buffer, offset, 1)
  else if (dictionaryIdFlag === 2) offset = take(buffer, offset, 2)
  else if (dictionaryIdFlag === 3) offset = take(buffer, offset, 4)
  if (frameContentSizeFlag === 0) {
    if (singleSegment) offset = take(buffer, offset, 1) // 单段帧：1 字节 FCS
  } else if (frameContentSizeFlag === 1) offset = take(buffer, offset, 2)
  else if (frameContentSizeFlag === 2) offset = take(buffer, offset, 4)
  else offset = take(buffer, offset, 8)
  for (;;) {
    offset = take(buffer, offset, 3)
    const header = buffer[offset - 3] | (buffer[offset - 2] << 8) | (buffer[offset - 1] << 16)
    const lastBlock = header & 0x1
    const blockType = (header >> 1) & 0x3
    const blockSize = header >>> 3
    if (blockType === 3) throw new RangeError('reserved zstd block type')
    offset = take(buffer, offset, blockType === 1 ? 1 : blockSize)
    if (lastBlock === 1) break
  }
  if (checksumFlag) offset = take(buffer, offset, 4)
  return offset
}

/**
 * 切分 zstd 多帧文件。
 * 返回 { frames: [{start,end}], truncation: null | {offset, reason} }。
 * 尾部截断（会话仍在写盘时被读取）只记 warning，不当作损坏；
 * 中段魔数非法则抛错，由 readSession 记为 zstd-frame-corrupt 违规。
 */
function splitZstdFrames(buffer) {
  const frames = []
  let offset = 0
  let truncation = null
  while (offset < buffer.length) {
    const remaining = buffer.length - offset
    if (remaining < 4) {
      truncation = { offset, reason: `尾部仅剩 ${remaining} 字节，不足一个 zstd 魔数` }
      break
    }
    const magic = buffer.readUInt32LE(offset)
    if (magic >= ZSTD_SKIPPABLE_MIN && magic <= ZSTD_SKIPPABLE_MAX) {
      if (remaining < 8) {
        truncation = { offset, reason: '尾部 skippable 帧头不完整' }
        break
      }
      const size = buffer.readUInt32LE(offset + 4)
      const end = offset + 8 + size
      if (end > buffer.length) {
        truncation = { offset, reason: '尾部 skippable 帧负载不完整' }
        break
      }
      offset = end
      continue
    }
    if (magic !== ZSTD_MAGIC) {
      throw new Error(`偏移 ${offset} 处不是 zstd 魔数（0x${magic.toString(16)}），文件可能被其他格式覆盖`)
    }
    const start = offset
    let end
    try {
      end = skipZstdFrame(buffer, offset)
    } catch (error) {
      truncation = { offset: start, reason: `帧结构不完整：${error.message}` }
      break
    }
    frames.push({ start, end })
    offset = end
  }
  return { frames, truncation }
}

/** 解压每个完整帧并拼接成明文（帧按写入顺序 = 行顺序）。 */
function decompressFrames(buffer, frames) {
  const parts = []
  const errors = []
  for (const frame of frames) {
    try {
      parts.push(zstdDecompressSync(buffer.subarray(frame.start, frame.end)))
    } catch (error) {
      errors.push({ offset: frame.start, reason: error.message })
    }
  }
  return { text: Buffer.concat(parts).toString('utf8'), errors }
}

// ---------------------------------------------------------------------------
// 读档
// ---------------------------------------------------------------------------

/**
 * 读取一个 session 存档为 { header, headerLine, events } 并做结构级检查。
 * 返回对象同时带 warnings / violations（结构级）与帧统计。
 */
function readSession(filePath, root) {
  const session = {
    filePath,
    root,
    id: basename(dirname(filePath)),
    header: null,
    headerLine: null,
    events: [],
    frames: 0,
    compressedBytes: 0,
    decompressedBytes: 0,
    warnings: [],
    violations: [],
  }
  const buffer = readFileSync(filePath)
  session.compressedBytes = buffer.length
  let split
  try {
    split = splitZstdFrames(buffer)
  } catch (error) {
    session.violations.push({
      kind: V.FRAME_CORRUPT,
      seq: null,
      type: null,
      detail: error.message,
    })
    return session
  }
  session.frames = split.frames.length
  if (split.truncation !== null) {
    session.warnings.push(
      `zstd 尾部不完整（偏移 ${split.truncation.offset}）：${split.truncation.reason}；` +
        `可能是会话仍在写盘，已忽略尾部残缺帧（${split.frames.length} 帧完整）`,
    )
  }
  const { text, errors } = decompressFrames(buffer, split.frames)
  for (const error of errors) {
    session.violations.push({
      kind: V.FRAME_CORRUPT,
      seq: null,
      type: null,
      detail: `偏移 ${error.offset} 的 zstd 帧解压失败：${error.reason}`,
    })
  }
  session.decompressedBytes = Buffer.byteLength(text, 'utf8')
  const lines = text.split('\n').filter((line) => line.length > 0)
  if (lines.length === 0) {
    session.violations.push({
      kind: V.HEADER_INVALID,
      seq: null,
      type: null,
      detail: '解压后没有任何 JSONL 行',
    })
    return session
  }
  session.headerLine = lines[0]
  try {
    session.header = JSON.parse(lines[0])
  } catch (error) {
    session.violations.push({
      kind: V.JSON_INVALID,
      seq: null,
      type: null,
      detail: `首行 header 不是合法 JSON：${error.message}`,
    })
    return session
  }
  if (!isObject(session.header) || session.header.type !== 'session') {
    session.violations.push({
      kind: V.HEADER_INVALID,
      seq: null,
      type: null,
      detail: `首行不是 session header（type=${JSON.stringify(session.header?.type)}）`,
    })
  } else if (session.header.version !== 4) {
    session.violations.push({
      kind: V.HEADER_INVALID,
      seq: null,
      type: null,
      detail: `header.version=${JSON.stringify(session.header.version)}，本工具面向 v4`,
    })
  }
  if (typeof session.header?.id === 'string' && session.header.id.length > 0) {
    session.id = session.header.id
  }
  for (let index = 1; index < lines.length; index += 1) {
    let event
    try {
      event = JSON.parse(lines[index])
    } catch (error) {
      session.violations.push({
        kind: V.JSON_INVALID,
        seq: index - 1,
        type: null,
        detail: `第 ${index + 1} 行（逻辑 seq ${index - 1}）JSON 解析失败：${error.message}`,
      })
      break
    }
    session.events.push(event)
  }
  return session
}

// ---------------------------------------------------------------------------
// fold 模拟（宿主判据复刻）
// ---------------------------------------------------------------------------

/**
 * 在一个会话的事件流上复刻宿主的 surface fold + 轮状态机 + 关键关系校验。
 *
 * 说明：宿主 accept() 的顺序是 foldSurface(event) 先、switch(tool/…) 后，
 * 因此 replace 型 tool/result 会先过范围/shadow 校验，再走 requireTurn；
 * 本函数保持同样的顺序（范围本身非法时不会再报轮外，与宿主一致）。
 *
 * @param {object[]} events 逻辑事件（文件顺序；严格模式下要求 seq === 下标）
 * @returns {{violations, surface, openTurn, stats}}
 */
function simulateFold(events) {
  const violations = []
  const surface = []
  let openTurn = null
  const stats = {
    appends: 0,
    replacements: 0,
    turnStarts: 0,
    turnEnds: 0,
    compactionSpans: 0,
  }
  const push = (kind, event, detail) => {
    violations.push({
      kind,
      seq: isEventSeq(event?.seq) ? event.seq : null,
      type: typeof event?.type === 'string' ? event.type : null,
      detail,
    })
  }

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    if (!isObject(event)) {
      push(V.EVENT_SHAPE, null, `下标 ${index} 处的事件不是对象`)
      continue
    }
    if (event.seq !== index) {
      // 宿主 replan 时以数组下标为 expectedSeq；seq 与下标不一致即拒载。
      push(
        V.SEQ_CONTIGUITY,
        event,
        `事件 seq=${JSON.stringify(event.seq)} 与数组下标 ${index} 不一致（宿主要求 0 起连续）`,
      )
    }
    if (typeof event.type !== 'string') {
      push(V.EVENT_SHAPE, event, '事件 type 不是字符串')
      continue
    }
    const type = event.type

    // ---------------- surface 类型事件 ----------------
    if (SURFACE_TYPES.has(type)) {
      const op = event.surfaceOp
      if (op === undefined) {
        // 宿主 validateSurfaceMetadata：surface-eligible 事件必须带 surfaceOp，
        // 否则在 foldSurface 阶段抛错。
        push(V.SURFACE_OP_MISSING, event, 'surface 类型事件必须带 surfaceOp，"append" 或 replace 对象')
        continue
      }
      if (op === 'append') {
        validateSourceEventSeqs(event, undefined, push)
        surface.push(event.seq)
        stats.appends += 1
        continue // append 型 tool/result 不触发 requireTurn，宿主直接进 tool 生命周期校验
      }

      let rangeValid = false
      if (!isReplaceOp(op)) {
        // 宿主 isReplaceOp：exact {op:"replace",startSeq,endSeq}，且坐标必须是非负安全整数。
        push(
          V.SURFACE_OP_INVALID,
          event,
          `非法 replace surfaceOp：${JSON.stringify(op)}（要求恰好 {op:"replace",startSeq,endSeq}）`,
        )
      } else if (op.startSeq >= event.seq || op.endSeq >= event.seq) {
        // 宿主：startSeq/endSeq 必须引用更早的事件。
        push(
          V.RANGE_INVALID,
          event,
          `startSeq=${op.startSeq} / endSeq=${op.endSeq} 必须引用更早事件（当前 seq=${event.seq}）`,
        )
      } else {
        const startIdx = surface.indexOf(op.startSeq)
        const endIdx = surface.indexOf(op.endSeq)
        if (startIdx < 0 || endIdx < 0) {
          // 判据 4：范围端点必须仍在当前 surface 上。
          const missing = []
          if (startIdx < 0) missing.push(`startSeq=${op.startSeq}`)
          if (endIdx < 0) missing.push(`endSeq=${op.endSeq}`)
          push(
            V.RANGE_NOT_ON_SURFACE,
            event,
            `替换范围端点不在当前 surface：${missing.join('、')}`,
          )
        } else if (startIdx > endIdx) {
          // 判据 4：start 的 surface 索引必须 <= end。
          push(
            V.RANGE_NOT_ON_SURFACE,
            event,
            `startSeq=${op.startSeq}（surface 索引 ${startIdx}）晚于 endSeq=${op.endSeq}（索引 ${endIdx}）`,
          )
        } else {
          rangeValid = true
          const shadowed = surface.slice(startIdx, endIdx + 1)
          // 判据 4 后半：被替换掉的 surface 节点必须都在 sourceEventSeqs 里。
          validateSourceEventSeqs(event, shadowed, push)
          // 宿主附加判据：tool/result 只允许改 message.content；首节点 system prompt 保护。
          validateToolResultRewrite(event, shadowed, events, push)
          validateSystemHeadRewrite(event, type, surface, shadowed, events, push)
          surface.splice(startIdx, shadowed.length, event.seq)
          stats.replacements += 1
        }
      }

      // 判据 3：type === "tool/result" 且 surfaceOp !== "append" -> requireTurn()。
      // 宿主在 foldSurface 之后才走这一步，所以范围非法时不会到达这里。
      if (rangeValid && type === 'tool/result' && openTurn === null) {
        const previous = index > 0 ? events[index - 1] : null
        push(
          V.OUTSIDE_TURN,
          event,
          `轮外 replace 型 tool/result：当前没有开放轮，宿主 requireTurn() 抛 ` +
            `"tool/result is outside an open turn"，整档判 corrupt；` +
            `替换范围 ${op.startSeq}..${op.endSeq}，前一条事件 ${previous?.type ?? '<无>'} seq=${previous?.seq ?? '-'}`,
        )
      }
      continue
    }

    // ---------------- 非 surface 事件 ----------------
    // 已知的非 surface 关系事件不允许携带 surfaceOp / sourceEventSeqs（宿主 surfaceOpOf 会抛）。
    if (event.surfaceOp !== undefined && (type.startsWith('compaction/') || type.startsWith('turn/') || type.startsWith('step/'))) {
      push(V.NON_SURFACE_MARKER, event, `非 surface 事件 ${type} 不允许携带 surfaceOp`)
    }

    if (type === TURN_START) {
      // 判据 5：turn/start 的 data.turn 开启该轮。
      const turn = event.data?.turn
      if (!Number.isSafeInteger(turn) || turn <= 0) {
        push(V.TURN_MARKER, event, `turn/start.data.turn=${JSON.stringify(turn)} 不是正整数`)
      } else {
        openTurn = turn
        stats.turnStarts += 1
      }
    } else if (type === TURN_END) {
      // 判据 5：turn/end 关闭该轮。
      const turn = event.data?.turn
      if (!Number.isSafeInteger(turn) || turn <= 0) {
        push(V.TURN_MARKER, event, `turn/end.data.turn=${JSON.stringify(turn)} 不是正整数`)
      }
      openTurn = null
      stats.turnEnds += 1
    } else if (type === COMPACTION_PRUNE || type === COMPACTION_SUMMARY) {
      // 宿主 compact().span()：prune/summary 的 shadowedRange/shadowedSeqs 必须精确等于
      // 当前 surface 的对应连续区间。它同样会让整档拒载，这里一并校验。
      validateCompactionSpan(event, surface, push)
      stats.compactionSpans += 1
    }
  }

  return { violations, surface, openTurn, stats }
}

/** 宿主 surface replace 的 sourceEventSeqs 校验（合法性与 shadow 覆盖）。 */
function validateSourceEventSeqs(event, shadowed, push) {
  const raw = event.sourceEventSeqs
  if (raw === undefined) {
    if (shadowed !== undefined) {
      push(
        V.SOURCES_OMIT,
        event,
        `replace 缺少 sourceEventSeqs（宿主要求包含被 shadow 的节点：${shadowed.join(', ')}）`,
      )
    }
    return
  }
  if (event.type === 'assistant/message') {
    push(V.SOURCES_INVALID, event, 'assistant/message 内嵌 source stream，不允许再带 sourceEventSeqs')
  }
  if (!Array.isArray(raw)) {
    push(V.SOURCES_INVALID, event, `sourceEventSeqs 必须是数组（收到 ${typeof raw}）`)
    if (shadowed !== undefined && shadowed.length > 0) {
      push(V.SOURCES_OMIT, event, `sourceEventSeqs 不是数组，无法包含被 shadow 节点 ${shadowed.join(', ')}`)
    }
    return
  }
  if (raw.length === 0) push(V.SOURCES_INVALID, event, 'sourceEventSeqs 不能是空数组')
  if (!raw.every((value) => isEventSeq(value))) {
    push(V.SOURCES_INVALID, event, 'sourceEventSeqs 含非"非负安全整数"的元素')
  }
  if (new Set(raw).size !== raw.length) {
    push(V.SOURCES_INVALID, event, 'sourceEventSeqs 含重复 seq')
  }
  const late = raw.find((value) => isEventSeq(value) && value >= event.seq)
  if (late !== undefined) {
    push(V.SOURCES_INVALID, event, `sourceEventSeqs 引用了不早于自身的事件 seq ${late}（event.seq=${event.seq}）`)
  }
  if (shadowed !== undefined) {
    const sources = new Set(raw.filter((value) => isEventSeq(value)))
    const missing = shadowed.filter((seq) => !sources.has(seq))
    if (missing.length > 0) {
      // 宿主原文：replacement sourceEventSeqs omit a shadowed surface node
      push(V.SOURCES_OMIT, event, `sourceEventSeqs 缺少被 shadow 的 surface 节点：${missing.join(', ')}`)
    }
  }
}

/** 宿主 assertToolResultRewrite：tool/result 的 replace 只能改写 1 个 tool/result 节点的 content。 */
function validateToolResultRewrite(event, shadowed, events, push) {
  if (event.type !== 'tool/result') return
  if (shadowed.length !== 1) {
    push(
      V.TOOL_RESULT_REWRITE,
      event,
      `tool/result 的 replace 必须恰好改写 1 个当前节点（实际 ${shadowed.length} 个：${shadowed.join(', ')}）`,
    )
    return
  }
  const original = events[shadowed[0]]
  if (!isObject(original) || original.type !== 'tool/result') {
    push(V.TOOL_RESULT_REWRITE, event, `目标 seq ${shadowed[0]} 不是 tool/result（实际 ${original?.type ?? '缺失'}）`)
    return
  }
  if (!isObject(original.data) || !isObject(event.data)) {
    push(V.TOOL_RESULT_REWRITE, event, 'tool/result 替换的事件 data 不是对象')
    return
  }
  const originalRest = { ...original.data, message: { ...original.data.message, content: null } }
  const replacementRest = { ...event.data, message: { ...event.data.message, content: null } }
  if (!isDeepEqualJson(originalRest, replacementRest)) {
    push(V.TOOL_RESULT_REWRITE, event, `tool/result replace 只允许改 data.message.content，其余字段必须与原事件一致`)
  }
}

/** 宿主 assertSystemHeadRewrite：surface 首节点若为 system prompt，只允许 system/message 单节点改写。 */
function validateSystemHeadRewrite(event, type, surface, shadowed, events, push) {
  if (surface.length === 0 || surface[0] !== shadowed[0]) return
  const head = events[surface[0]]
  if (!isObject(head) || head.type !== 'system/message') return
  if (event.type !== 'system/message' || shadowed.length !== 1) {
    push(
      V.SYSTEM_HEAD,
      event,
      `surface 首节点 seq=${surface[0]} 是 protected system prompt，只能用 system/message 单节点改写`,
    )
  }
}

/** 宿主 compact().span()：shadowedRange/shadowedSeqs 必须精确等于当前 surface 的连续区间。 */
function validateCompactionSpan(event, surface, push) {
  const data = event.data
  if (!isObject(data)) {
    push(V.COMPACTION_SPAN, event, 'data 不是对象')
    return
  }
  const range = data.shadowedRange
  if (!isObject(range) || !isEventSeq(range.start) || !isEventSeq(range.end)) {
    push(V.COMPACTION_SPAN, event, `shadowedRange 缺失或非法：${JSON.stringify(range)}`)
    return
  }
  if (range.start >= event.seq || range.end >= event.seq) {
    push(V.COMPACTION_SPAN, event, `shadowedRange ${range.start}..${range.end} 必须引用更早事件（当前 seq=${event.seq}）`)
    return
  }
  const startIdx = surface.indexOf(range.start)
  const endIdx = surface.indexOf(range.end)
  if (startIdx < 0 || endIdx < 0) {
    push(
      V.COMPACTION_SPAN,
      event,
      `shadowedRange 端点不在当前 surface：${startIdx < 0 ? `start=${range.start} ` : ''}${endIdx < 0 ? `end=${range.end}` : ''}`.trim(),
    )
    return
  }
  if (startIdx > endIdx) {
    push(V.COMPACTION_SPAN, event, `shadowedRange start=${range.start} 的 surface 索引晚于 end=${range.end}`)
    return
  }
  if (!Array.isArray(data.shadowedSeqs)) {
    push(V.COMPACTION_SPAN, event, 'shadowedSeqs 缺失或不是数组')
    return
  }
  const expected = surface.slice(startIdx, endIdx + 1)
  if (!isDeepEqualJson(expected, data.shadowedSeqs)) {
    push(
      V.COMPACTION_SPAN,
      event,
      `shadowedSeqs 与当前 surface 区间不一致（surface 区间 [${expected.join(',')}]，记录 [${data.shadowedSeqs.join(',')}]）`,
    )
  }
}

// ---------------------------------------------------------------------------
// 单个存档审计
// ---------------------------------------------------------------------------

/** 审计一个存档（只读）：读档 + fold 模拟 + 汇总。 */
function auditFile(filePath, root) {
  const session = readSession(filePath, root)
  session.id = session.header?.id ?? session.id
  const fold = simulateFold(session.events)
  const violations = [...session.violations, ...fold.violations]
  const result = {
    filePath,
    root,
    displayPath: displayPath(root, filePath),
    id: session.id,
    events: session.events.length,
    frames: session.frames,
    compressedBytes: session.compressedBytes,
    decompressedBytes: session.decompressedBytes,
    warnings: session.warnings,
    violations,
    surfaceNodeCount: fold.surface.length,
    surface: fold.surface,
    session, // 供 --fix 复用；默认审计输出不包含它
  }
  return result
}

/** 把审计结果序列化为对外报告对象（丢掉内部 session）。 */
function toSessionReport(result) {
  const groups = groupViolations(result.violations)
  const counts = {}
  for (const [kind, list] of groups) counts[kind] = list.length
  return {
    id: result.id,
    path: result.filePath,
    relativePath: result.displayPath,
    events: result.events,
    frames: result.frames,
    compressedBytes: result.compressedBytes,
    decompressedBytes: result.decompressedBytes,
    surfaceNodeCount: result.surfaceNodeCount,
    warnings: result.warnings,
    violations: result.violations,
    counts,
  }
}

// ---------------------------------------------------------------------------
// 撤回式修复
// ---------------------------------------------------------------------------

/** 修复流程内部的可预期中止（不写盘、退出码 1，或自检失败退出码 3）。 */
class FixProblem extends Error {
  constructor(message, exitCode = 1) {
    super(message)
    this.exitCode = exitCode
  }
}

/**
 * 规划 --fix：只处理"轮外 replace 型 tool/result"，且必须能识别出
 * 紧邻前一条成对的 compaction/prune。返回可修对/不可修项。
 */
function planFix(session) {
  const { events } = session
  const violations = simulateFold(events).violations
  const outsideTurnSeqs = violations
    .filter((violation) => violation.kind === V.OUTSIDE_TURN)
    .map((violation) => violation.seq)
  const otherViolations = violations.filter((violation) => violation.kind !== V.OUTSIDE_TURN)

  const plan = {
    pairs: [],
    unfixable: [],
    otherViolations,
  }
  if (outsideTurnSeqs.length === 0) return plan

  // 修复依赖"seq === 数组下标"，否则重编号无法安全建立映射。
  for (let index = 0; index < events.length; index += 1) {
    if (!isObject(events[index]) || events[index].seq !== index) {
      throw new FixProblem(`事件 seq 不连续（下标 ${index} 处 seq=${JSON.stringify(events[index]?.seq)}），拒绝自动修复`)
    }
  }
  if (otherViolations.length > 0) {
    // 其它类别不在本修复范围内；修完也无法通过 0 违规自检，直接拒绝写盘。
    throw new FixProblem(
      `该项除"轮外 replace 型 tool/result"外还有 ${otherViolations.length} 条其它违规，` +
        `撤回式修复无法清零，拒绝写盘（请人工处理）：` +
        otherViolations
          .slice(0, 5)
          .map((violation) => `${violation.kind}@seq ${violation.seq}`)
          .join('，'),
    )
  }

  const bySeq = new Map(events.map((event) => [event.seq, event]))
  const plannedNodes = new Set()
  for (const seq of outsideTurnSeqs) {
    const event = events[seq]
    const unreachable = (reason) => plan.unfixable.push({ seq, reason })
    if (!isObject(event) || event.type !== 'tool/result') {
      unreachable(`seq ${seq} 不是 tool/result`)
      continue
    }
    if (!isReplaceOp(event.surfaceOp)) {
      unreachable(`seq ${seq} 的 surfaceOp 不是合法 replace 形态`)
      continue
    }
    const prune = events[seq - 1]
    if (!isObject(prune) || prune.type !== COMPACTION_PRUNE) {
      unreachable(`seq ${seq} 前一条不是 compaction/prune（实际 ${prune?.type ?? '缺失'}），无法识别成对剪枝`)
      continue
    }
    const op = event.surfaceOp
    if (op.startSeq !== op.endSeq) {
      unreachable(`seq ${seq} 的替换范围 ${op.startSeq}..${op.endSeq} 不是单节点，无法与单条 prune 配对`)
      continue
    }
    const nodeSeq = op.startSeq
    if (plannedNodes.has(nodeSeq)) {
      unreachable(`节点 seq ${nodeSeq} 已被另一个可修对覆盖`)
      continue
    }
    const prunedNodes = Array.isArray(prune.data?.shadowedSeqs) ? prune.data.shadowedSeqs : null
    if (
      prunedNodes === null ||
      prunedNodes.length !== 1 ||
      prunedNodes[0] !== nodeSeq ||
      !isObject(prune.data?.shadowedRange) ||
      prune.data.shadowedRange.start !== nodeSeq ||
      prune.data.shadowedRange.end !== nodeSeq
    ) {
      unreachable(
        `prune seq ${prune.seq} 的 shadowedRange/Seqs 不是恰好 [${nodeSeq}]（实际 ${JSON.stringify({
          range: prune.data?.shadowedRange,
          seqs: prune.data?.shadowedSeqs,
        })}），无法确认成对关系`,
      )
      continue
    }
    const original = bySeq.get(nodeSeq)
    if (!isObject(original) || original.type !== 'tool/result') {
      unreachable(`原节点 seq ${nodeSeq} 不是 tool/result（实际 ${original?.type ?? '缺失'}），撤回剪枝后不是合法 append 节点`)
      continue
    }
    if (!Array.isArray(event.sourceEventSeqs) || !event.sourceEventSeqs.includes(prune.seq) || !event.sourceEventSeqs.includes(nodeSeq)) {
      unreachable(
        `seq ${seq} 的 sourceEventSeqs 未同时引用 prune seq ${prune.seq} 与原节点 seq ${nodeSeq}，无法确认成对关系`,
      )
      continue
    }
    plannedNodes.add(nodeSeq)
    plan.pairs.push({
      pruneSeq: prune.seq,
      replaceSeq: seq,
      nodeSeq,
      pruneTokenCount: Number.isFinite(prune.data?.shadowedTokenCount) ? prune.data.shadowedTokenCount : null,
    })
  }
  return plan
}

/**
 * 撤回式修复内存变换：
 *  1. 删除每对 (compaction/prune, replace) 事件；
 *  2. 剩余事件按顺序重编号 seq = 新下标；
 *  3. 递归改写所有指向事件的 seq 引用（surfaceOp / sourceEventSeqs / shadowedSeqs /
 *     shadowedRange / messageSeqs / headerSeq / sourceEventSeq / 其它 *Seq* 键）；
 *  4. best-effort 调整 compaction/summary 的派生统计字段。
 * 返回 { events, seqMap, stats, derived }（不改磁盘）。
 */
function applyFixInMemory(session, pairs) {
  const { events } = session
  const deleted = new Map() // 旧 seq -> 所属修复对
  for (const pair of pairs) {
    deleted.set(pair.pruneSeq, pair)
    deleted.set(pair.replaceSeq, pair)
  }
  const kept = events.filter((event) => !deleted.has(event.seq))
  const seqMap = new Map()
  for (let index = 0; index < kept.length; index += 1) seqMap.set(kept[index].seq, index)

  const stats = {
    scannedRefs: 0,
    rewrittenRefs: 0,
    droppedRefs: 0,
    byField: {},
  }
  const say = (field) => {
    stats.byField[field] = (stats.byField[field] ?? 0) + 1
  }

  const nextEvents = kept.map((event) => {
    const clone = structuredClone(event)
    // 顶层 seq 单独处理，避免递归 walker 二次改写。
    clone.seq = seqMap.get(event.seq)
    return clone
  })
  for (const clone of nextEvents) {
    for (const [key, value] of Object.entries(clone)) {
      if (key === 'seq') continue
      clone[key] = rewriteSeqReferences(value, key, seqMap, deleted, stats, say)
    }
    assertEventReferencesResolvable(clone)
  }

  const derived = adjustDerivedCounts(session, nextEvents, pairs, seqMap)

  return { events: nextEvents, seqMap, stats, derived }
}

/** 旧 seq -> 新 seq；被删事件返回 null（调用方决定报警还是丢弃）。 */
function mapSeq(value, seqMap, deleted) {
  if (deleted.has(value)) return null
  if (!seqMap.has(value)) throw new FixProblem(`引用指向不存在的旧 seq ${value}`)
  return seqMap.get(value)
}

/** 递归改写事件里的 seq 引用。只改"键名像 seq"的数值，避免误改 turn/step/usage 等数字。 */
function rewriteSeqReferences(value, key, seqMap, deleted, stats, say) {
  if (Array.isArray(value)) {
    if (/seqs$/i.test(key)) {
      // seq 数组（sourceEventSeqs / shadowedSeqs / messageSeqs / …）：
      // 被删事件的引用直接移除；其余按映射改写。
      const output = []
      for (const item of value) {
        if (!Number.isSafeInteger(item)) {
          output.push(item)
          continue
        }
        const mapped = mapSeq(item, seqMap, deleted)
        if (mapped === null) {
          stats.droppedRefs += 1
          say(`${key}.dropped`)
          continue
        }
        stats.scannedRefs += 1
        if (mapped !== item) {
          stats.rewrittenRefs += 1
          say(key)
        }
        output.push(mapped)
      }
      return output
    }
    return value.map((item) => rewriteSeqReferences(item, key, seqMap, deleted, stats, say))
  }
  if (isObject(value)) {
    const output = {}
    for (const [childKey, childValue] of Object.entries(value)) {
      if (childKey === 'shadowedRange' && isObject(childValue)) {
        // 宿主 compact().span() 读取 shadowedRange.start/end，也是 seq 坐标。
        const range = { ...childValue }
        for (const field of ['start', 'end']) {
          if (!Number.isSafeInteger(range[field])) continue
          const mapped = mapSeq(range[field], seqMap, deleted)
          if (mapped === null) throw new FixProblem(`shadowedRange.${field} 指向被删除事件 seq ${range[field]}`)
          stats.scannedRefs += 1
          if (mapped !== range[field]) {
            stats.rewrittenRefs += 1
            say(`shadowedRange.${field}`)
          }
          range[field] = mapped
        }
        output[childKey] = range
        continue
      }
      output[childKey] = rewriteSeqReferences(childValue, childKey, seqMap, deleted, stats, say)
    }
    return output
  }
  if (typeof value === 'number' && /seq$/i.test(key) && Number.isSafeInteger(value)) {
    // 单值 seq 引用（surfaceOp.startSeq/endSeq、headerSeq、sourceEventSeq…）。
    const mapped = mapSeq(value, seqMap, deleted)
    if (mapped === null) throw new FixProblem(`${key} 指向被删除事件 seq ${value}`)
    stats.scannedRefs += 1
    if (mapped !== value) {
      stats.rewrittenRefs += 1
      say(key)
    }
    return mapped
  }
  return value
}

/** 修复后事件必须满足的引用完整性（不存在的 seq / 指向未来事件都不允许）。 */
function assertEventReferencesResolvable(event) {
  const seq = event.seq
  if (!isEventSeq(seq)) throw new FixProblem(`修复后事件 seq 非法：${JSON.stringify(seq)}`)
  const op = event.surfaceOp
  if (isReplaceOp(op)) {
    for (const field of ['startSeq', 'endSeq']) {
      if (!isEventSeq(op[field]) || op[field] >= seq) {
        throw new FixProblem(`修复后事件 seq ${seq} 的 surfaceOp.${field}=${op[field]} 未指向更早事件`)
      }
    }
  }
  if (event.sourceEventSeqs !== undefined) {
    if (!Array.isArray(event.sourceEventSeqs)) throw new FixProblem(`修复后事件 seq ${seq} 的 sourceEventSeqs 不是数组`)
    const seen = new Set()
    for (const source of event.sourceEventSeqs) {
      if (!isEventSeq(source) || source >= seq) {
        throw new FixProblem(`修复后事件 seq ${seq} 的 sourceEventSeqs 含非法/未来引用 ${source}`)
      }
      if (seen.has(source)) throw new FixProblem(`修复后事件 seq ${seq} 的 sourceEventSeqs 含重复 ${source}`)
      seen.add(source)
    }
  }
  if (Array.isArray(event.data?.shadowedSeqs)) {
    for (const source of event.data.shadowedSeqs) {
      if (!isEventSeq(source)) throw new FixProblem(`修复后事件 seq ${seq} 的 shadowedSeqs 含非法 seq ${source}`)
    }
  }
  if (isObject(event.data?.shadowedRange)) {
    for (const field of ['start', 'end']) {
      const value = event.data.shadowedRange[field]
      if (!isEventSeq(value)) throw new FixProblem(`修复后事件 seq ${seq} 的 shadowedRange.${field} 非法`)
    }
  }
}

/**
 * best-effort 调整派生统计字段：撤回剪枝后，把被删 prune 的 shadowedTokenCount
 * 从所属 compaction/summary 的计数里扣回（仅统计口径，不影响宿主加载）。
 */
function adjustDerivedCounts(session, nextEvents, pairs, seqMap) {
  const adjustments = []
  if (pairs.length === 0) return adjustments
  const bySeq = new Map(nextEvents.map((event) => [event.seq, event]))
  const events = session.events
  // 扫描原事件，为每个 prune 找到它所在 compaction 的 summary。
  const summaryForPrune = new Map()
  const stack = []
  for (const event of events) {
    if (event.type === COMPACTION_START) {
      stack.push({ summarySeq: null })
    } else if (event.type === COMPACTION_SUMMARY && stack.length > 0) {
      stack[stack.length - 1].summarySeq = event.seq
    } else if (event.type === COMPACTION_END && stack.length > 0) {
      stack.pop()
    } else if (event.type === COMPACTION_PRUNE && stack.length > 0) {
      summaryForPrune.set(event.seq, stack[stack.length - 1].summarySeq)
    }
  }
  const perSummary = new Map()
  for (const pair of pairs) {
    const summaryOldSeq = summaryForPrune.get(pair.pruneSeq) ?? null
    if (summaryOldSeq === null) continue
    const entry = perSummary.get(summaryOldSeq) ?? { tokens: 0, prunes: 0 }
    entry.tokens += pair.pruneTokenCount ?? 0
    entry.prunes += 1
    perSummary.set(summaryOldSeq, entry)
  }
  for (const [summaryOldSeq, entry] of perSummary) {
    const newSeq = seqMap.get(summaryOldSeq)
    const summary = newSeq === undefined ? undefined : bySeq.get(newSeq)
    if (!isObject(summary?.data)) continue
    const beforeTokens = summary.data.shadowedTokenCount
    const beforePruned = summary.data.prunedCount
    let adjusted = false
    if (Number.isFinite(beforeTokens) && entry.tokens > 0) {
      summary.data.shadowedTokenCount = Math.max(0, beforeTokens - entry.tokens)
      adjusted = true
    }
    if (Number.isFinite(beforePruned) && entry.prunes > 0) {
      summary.data.prunedCount = Math.max(0, beforePruned - entry.prunes)
      adjusted = true
    }
    if (adjusted) {
      adjustments.push({
        summaryOldSeq,
        summaryNewSeq: newSeq,
        shadowedTokenCount: Number.isFinite(beforeTokens)
          ? { before: beforeTokens, after: summary.data.shadowedTokenCount }
          : null,
        prunedCount: Number.isFinite(beforePruned)
          ? { before: beforePruned, after: summary.data.prunedCount }
          : null,
      })
    }
  }
  return adjustments
}

/**
 * 修复后自检：重新读盘 → 再跑 fold 复刻 → 断言 0 违规；
 * 同时断言原 R 节点（重编号后）在 surface 上、事件数正确、引用无悬挂。
 * 返回 { ok, problems, session, fold }。
 */
function verifyFixedFile(filePath, root, expected) {
  const problems = []
  const session = readSession(filePath, root)
  const fold = simulateFold(session.events)
  for (const warning of session.warnings) problems.push(`警告：${warning}`)
  for (const violation of [...session.violations, ...fold.violations]) {
    problems.push(`违规：${violation.kind}${violation.seq === null ? '' : `@seq ${violation.seq}`} — ${violation.detail}`)
  }
  if (session.events.length !== expected.eventCount) {
    problems.push(`事件数 ${session.events.length} != 预期 ${expected.eventCount}`)
  }
  for (let index = 0; index < session.events.length; index += 1) {
    if (session.events[index]?.seq !== index) {
      problems.push(`seq 不连续：下标 ${index} 处 seq=${JSON.stringify(session.events[index]?.seq)}`)
      break
    }
  }
  const surfaceSet = new Set(fold.surface)
  for (const nodeOldSeq of expected.restoredNodes) {
    const nodeNewSeq = expected.seqMap.get(nodeOldSeq)
    if (nodeNewSeq === undefined) {
      problems.push(`原 R 节点 seq ${nodeOldSeq} 未出现在修复后的 seq 映射中`)
    } else if (!surfaceSet.has(nodeNewSeq)) {
      problems.push(`原 R 节点 seq ${nodeOldSeq}（新 seq ${nodeNewSeq}）不在修复后的 surface 上`)
    }
  }
  return { ok: problems.length === 0, problems, session, fold }
}

/** 把多行 JSONL 明文重新压成多帧 zstd（保持宿主读取的多帧落盘形态）。 */
function encodeZstdMultiFrame(text) {
  if (zstdCompressSync === null) {
    throw new FixProblem('当前 Node 没有 zlib.zstdCompressSync（需要 Node >= 22.15），无法重写存档', 2)
  }
  const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n')
  const chunks = []
  for (let index = 0; index < lines.length; index += FIX_WRITE_BATCH_LINES) {
    const batch = lines.slice(index, index + FIX_WRITE_BATCH_LINES).join('\n') + '\n'
    chunks.push(zstdCompressSync(Buffer.from(batch, 'utf8')))
  }
  return Buffer.concat(chunks)
}

/** 把修复后的事件序列化回 JSONL（header 行保持原文字节不变）。 */
function serializeSession(session, fixedEvents) {
  const lines = [session.headerLine]
  for (const event of fixedEvents) lines.push(JSON.stringify(event))
  return lines.join('\n') + '\n'
}

/**
 * 真正落盘：备份 -> 临时文件 -> rename 覆盖 -> 重读自检；自检失败从备份回滚。
 * dry-run 由调用方在写盘前挡掉。
 */
function applyFix(session, plan, options) {
  const { dryRun } = options
  const fixed = applyFixInMemory(session, plan.pairs)
  const text = serializeSession(session, fixed.events)
  const compressed = encodeZstdMultiFrame(text)
  const restoredNodes = plan.pairs.map((pair) => pair.nodeSeq)
  const beforeFold = simulateFold(session.events)
  const expected = {
    eventCount: fixed.events.length,
    seqMap: fixed.seqMap,
    restoredNodes,
    deletedCount: plan.pairs.length * 2,
  }
  const report = {
    file: session.filePath,
    pairs: plan.pairs,
    unfixable: plan.unfixable,
    violationsBefore: beforeFold.violations.length,
    violationsAfter: null,
    framesAfter: null,
    deletedEvents: plan.pairs.flatMap((pair) => [
      { seq: pair.pruneSeq, type: COMPACTION_PRUNE },
      { seq: pair.replaceSeq, type: 'tool/result' },
    ]),
    renumber: {
      deletedCount: plan.pairs.length * 2,
      firstDeletedSeq: Math.min(...plan.pairs.flatMap((pair) => [pair.pruneSeq, pair.replaceSeq])),
      lastDeletedSeq: Math.max(...plan.pairs.flatMap((pair) => [pair.pruneSeq, pair.replaceSeq])),
      oldEventCount: session.events.length,
      newEventCount: fixed.events.length,
    },
    scannedRefs: fixed.stats.scannedRefs,
    rewrittenRefs: fixed.stats.rewrittenRefs,
    droppedRefs: fixed.stats.droppedRefs,
    rewrittenByField: fixed.stats.byField,
    derivedAdjustments: fixed.derived,
    dryRun,
    backupPath: null,
    selfCheck: null,
  }

  if (dryRun) {
    // dry-run：在内存里对"修复后事件"跑同样的 fold 复刻与断言。
    const fold = simulateFold(fixed.events)
    const problems = []
    for (const violation of fold.violations) {
      problems.push(`违规：${violation.kind}${violation.seq === null ? '' : `@seq ${violation.seq}`} — ${violation.detail}`)
    }
    const surfaceSet = new Set(fold.surface)
    for (const nodeOldSeq of restoredNodes) {
      const nodeNewSeq = fixed.seqMap.get(nodeOldSeq)
      if (nodeNewSeq === undefined || !surfaceSet.has(nodeNewSeq)) {
        problems.push(`原 R 节点 seq ${nodeOldSeq} 不在修复后的 surface 上`)
      }
    }
    report.selfCheck = { ok: problems.length === 0, problems, eventCount: fixed.events.length }
    report.violationsAfter = fold.violations.length
    if (!report.selfCheck.ok) {
      throw new FixProblem(`dry-run 内存自检失败：${problems.slice(0, 5).join('；')}`, 3)
    }
    return report
  }

  // 备份文件名：session.v4.jsonl.zstd.bak-<yyyyMMdd-HHmmss>（同秒冲突时追加 -n）。
  const stamp = formatTimestamp(new Date())
  let backupPath = `${session.filePath}.bak-${stamp}`
  let suffix = 1
  while (existsSync(backupPath)) {
    backupPath = `${session.filePath}.bak-${stamp}-${suffix}`
    suffix += 1
  }
  copyFileSync(session.filePath, backupPath)
  report.backupPath = backupPath

  const tempPath = `${session.filePath}.fix-tmp-${process.pid}-${Date.now()}`
  try {
    writeFileSync(tempPath, compressed)
    renameSync(tempPath, session.filePath)
  } catch (error) {
    try {
      rmSync(tempPath, { force: true })
    } catch {
      /* 清理临时文件失败不掩盖原始错误 */
    }
    throw new FixProblem(`写入失败，原存档未修改（备份保留在 ${backupPath}）：${error.message}`, 3)
  }

  // 写后自检：重读新文件、再跑 fold 复刻；任一断言失败从备份回滚。
  let verification
  try {
    verification = verifyFixedFile(session.filePath, session.root, expected)
  } catch (error) {
    // 自检本身读不了新文件时同样回滚（宁可不动存档，也不留半成品）。
    try {
      copyFileSync(backupPath, session.filePath)
    } catch (rollbackError) {
      throw new FixProblem(
        `自检读取失败且回滚失败！备份在 ${backupPath}，请手动恢复。自检错误：${error.message}；回滚错误：${rollbackError.message}`,
        3,
      )
    }
    throw new FixProblem(`自检读取失败，已从备份回滚（${backupPath}）：${error.message}`, 3)
  }
  report.selfCheck = {
    ok: verification.ok,
    problems: verification.problems,
    eventCount: verification.session.events.length,
    surfaceNodeCount: verification.fold.surface.length,
    violations: verification.fold.violations.length,
  }
  report.violationsAfter = verification.fold.violations.length
  report.framesAfter = verification.session.frames
  if (!verification.ok) {
    try {
      copyFileSync(backupPath, session.filePath)
    } catch (rollbackError) {
      throw new FixProblem(
        `自检失败且回滚失败！备份在 ${backupPath}，请手动恢复。自检问题：` +
          `${verification.problems.slice(0, 5).join('；')}；回滚错误：${rollbackError.message}`,
        3,
      )
    }
    throw new FixProblem(
      `自检失败，已从备份回滚（${backupPath}）。问题：${verification.problems.slice(0, 5).join('；')}`,
      3,
    )
  }
  return report
}

// ---------------------------------------------------------------------------
// 输出渲染
// ---------------------------------------------------------------------------

function renderHumanAudit(report) {
  const lines = []
  lines.push('DSH v4 session 存档 fold 健康检查（只读审计）')
  lines.push(`  扫描根: ${report.roots.join('  |  ')}`)
  lines.push(`  zstd: node:zlib.zstdDecompressSync（可用）`)
  lines.push('')
  for (const session of report.sessions) {
    if (session.violations.length === 0 && session.warnings.length === 0) {
      lines.push(
        `[干净] ${session.id}  events=${session.events}  frames=${session.frames}  ` +
          `size=${formatBytes(session.compressedBytes)}  ${session.relativePath}`,
      )
      continue
    }
    lines.push(
      `[违规] ${session.id}  events=${session.events}  frames=${session.frames}  ` +
        `size=${formatBytes(session.compressedBytes)}  ${session.relativePath}`,
    )
    for (const warning of session.warnings) lines.push(`    警告: ${warning}`)
    const groups = groupViolations(session.violations)
    for (const [kind, list] of groups) {
      lines.push(`    - ${kind} × ${list.length}（${VIOLATION_LABELS[kind] ?? '未知类别'}）`)
      for (const violation of list.slice(0, MAX_DISPLAY_PER_KIND)) {
        const coordinate = violation.seq === null ? 'seq=?' : `seq=${violation.seq}`
        lines.push(`        · ${coordinate} type=${violation.type ?? '?'}: ${violation.detail}`)
      }
      if (list.length > MAX_DISPLAY_PER_KIND) {
        lines.push(`        · …… 另有 ${list.length - MAX_DISPLAY_PER_KIND} 条同类违规未展示`)
      }
    }
  }
  lines.push('')
  lines.push(
    `汇总: 扫描 ${report.summary.scanned} 档；干净 ${report.summary.clean}；` +
      `违规 ${report.summary.dirty}；违规条目 ${report.summary.violations}`,
  )
  return lines.join('\n')
}

function renderHumanFix(reports) {
  const lines = []
  if (reports.length === 0) {
    lines.push('修复: 没有需要修复的"轮外 replace 型 tool/result"违规。')
    return lines.join('\n')
  }
  for (const report of reports) {
    lines.push('')
    lines.push(`修复计划（撤回式，${report.dryRun ? 'dry-run 不写盘' : '写盘'}）: ${report.file}`)
    const total = report.pairs.length
    lines.push(`  将修复 ${total} 枚；删除 ${report.renumber.deletedCount} 条事件（prune + replace 成对）`)
    lines.push(
      `  事件数: ${report.renumber.oldEventCount} → ${report.renumber.newEventCount}` +
        `（删除区间 seq ${report.renumber.firstDeletedSeq}..${report.renumber.lastDeletedSeq} 之后整体前移）`,
    )
    lines.push('  删除事件（原 seq）:')
    for (const deleted of report.deletedEvents) {
      lines.push(`    - seq ${deleted.seq} ${deleted.type}`)
    }
    lines.push(
      `  引用改写: 实际变化 ${report.rewrittenRefs} 处（扫描 seq 引用 ${report.scannedRefs} 处；移除被删事件引用 ${report.droppedRefs} 处）`,
    )
    const fieldPairs = Object.entries(report.rewrittenByField)
      .sort((left, right) => right[1] - left[1])
      .map(([field, count]) => `${field}×${count}`)
    if (fieldPairs.length > 0) lines.push(`    字段分布: ${fieldPairs.join('，')}`)
    if (report.derivedAdjustments.length > 0) {
      for (const adjustment of report.derivedAdjustments) {
        lines.push(
          `  派生统计（best-effort，仅影响统计口径不影响加载）: compaction/summary ` +
            `seq ${adjustment.summaryOldSeq}→${adjustment.summaryNewSeq} ` +
            `shadowedTokenCount ${JSON.stringify(adjustment.shadowedTokenCount)}`,
        )
      }
    }
    if (report.unfixable.length > 0) {
      lines.push('  不可安全修复（仅报告）:')
      for (const item of report.unfixable) lines.push(`    - seq ${item.seq}: ${item.reason}`)
    }
    if (report.backupPath !== null) lines.push(`  备份: ${report.backupPath}`)
    const check = report.selfCheck
    lines.push(`  违规数: ${report.violationsBefore} → ${report.violationsAfter /* dry-run 内存 fold 的结果 */}`)
    lines.push(
      `  自检（${report.dryRun ? '内存 fold 复刻' : '重读新文件 + fold 复刻'}）: ` +
        `${check.ok ? '通过，0 违规' : '失败'}；事件数 ${check.eventCount}` +
        `${report.framesAfter === null ? '' : `；重写后帧数 ${report.framesAfter}`}`,
    )
    if (!check.ok) {
      for (const problem of check.problems.slice(0, 10)) lines.push(`    - ${problem}`)
    }
    if (!report.dryRun) lines.push('  写盘完成')
  }
  return lines.join('\n')
}

/** 汇总 -fix 结果里的计数（供退出码和 JSON 使用）。 */
function summarizeFix(reports, fixMax) {
  const applied = reports.filter((report) => !report.dryRun && report.selfCheck?.ok).length
  const fixedPairs = reports.reduce((sum, report) => sum + report.pairs.length, 0)
  const rewrittenRefs = reports.reduce((sum, report) => sum + report.rewrittenRefs, 0)
  const remaining = reports.reduce((sum, report) => sum + report.unfixable.length, 0)
  const violationsBefore = reports.reduce((sum, report) => sum + (report.violationsBefore ?? 0), 0)
  const violationsAfter = reports.reduce((sum, report) => sum + (report.violationsAfter ?? 0), 0)
  const eventsBefore = reports.reduce((sum, report) => sum + report.renumber.oldEventCount, 0)
  const eventsAfter = reports.reduce((sum, report) => sum + report.renumber.newEventCount, 0)
  return {
    fixMax,
    applied,
    dryRun: reports.every((report) => report.dryRun),
    fixedPairs,
    rewrittenRefs,
    unfixable: remaining,
    violationsBefore,
    violationsAfter,
    eventsBefore,
    eventsAfter,
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function fail(args, exitCode, message) {
  if (args?.json) {
    process.stdout.write(JSON.stringify({ ok: false, error: message, exitCode }, null, 2) + '\n')
  }
  process.stderr.write(`错误: ${message}\n`)
  return exitCode
}

function main(argv) {
  let args
  try {
    args = parseArgs(argv)
  } catch (error) {
    return fail(null, 2, error.message)
  }
  if (args.help) {
    process.stdout.write(HELP_TEXT)
    return 0
  }
  // 解压能力是硬前提：Node >= 22.15 才提供 zstd API。
  if (zstdDecompressSync === null) {
    return fail(
      args,
      2,
      `当前 Node（${process.version}）没有 node:zlib.zstdDecompressSync；` +
        '存档是 zstd 压缩的，需要 Node >= 22.15（可升级 Node 或改用带 zstd 的运行时）',
    )
  }
  if (args.fix && zstdCompressSync === null) {
    return fail(
      args,
      2,
      `当前 Node（${process.version}）没有 node:zlib.zstdCompressSync，无法重写 zstd 存档；需要 Node >= 22.15`,
    )
  }

  const roots = resolveRoots(args)
  const missingRoots = roots.filter((root) => !existsSync(root))
  if (missingRoots.length > 0) {
    return fail(args, 2, `扫描根不存在: ${missingRoots.join(', ')}`)
  }
  const files = walkFiles(roots)
  if (files.length === 0) {
    return fail(args, 2, `在扫描根下没有找到任何 ${SESSION_FILE_NAME}: ${roots.join(', ')}`)
  }

  // 只读审计全部存档。注意：逐个审计后立即转成轻量报告并丢弃事件流，
  // 否则 177 个会话的全部事件同时驻留内存，会在 zstd 解压时触发 allocation 失败。
  const sessionReports = []
  const rootOfFile = new Map()
  for (const { file, root } of files) {
    rootOfFile.set(file, root)
    let result
    try {
      result = auditFile(file, root)
    } catch (error) {
      result = {
        filePath: file,
        root,
        displayPath: displayPath(root, file),
        id: basename(dirname(file)),
        events: 0,
        frames: 0,
        compressedBytes: 0,
        decompressedBytes: 0,
        warnings: [],
        violations: [
          { kind: V.FRAME_CORRUPT, seq: null, type: null, detail: `读取失败：${error.message}` },
        ],
        surfaceNodeCount: 0,
      }
    }
    sessionReports.push(toSessionReport(result))
  }
  const report = {
    tool: 'dsh-session-fold-audit',
    generatedAt: new Date().toISOString(),
    node: process.version,
    roots,
    summary: {
      scanned: sessionReports.length,
      clean: sessionReports.filter((session) => session.violations.length === 0).length,
      dirty: sessionReports.filter((session) => session.violations.length > 0).length,
      violations: sessionReports.reduce((sum, session) => sum + session.violations.length, 0),
    },
    sessions: sessionReports,
    fix: null,
  }
  let exitCode = report.summary.dirty > 0 ? 1 : 0
  let fixProblem = null

  if (args.fix && report.summary.dirty > 0) {
    const reports = []
    try {
      // 只对存在 outside-turn 违规的存档做修复；全部先在内存里规划，超过 --fix-max 整次拒绝。
      const targets = sessionReports.filter((session) =>
        session.violations.some((violation) => violation.kind === V.OUTSIDE_TURN),
      )
      const planned = []
      for (const target of targets) {
        // --fix 只处理离线存档：读盘发现尾部残缺（仍在写盘）即拒绝。
        const session = readSession(target.path, rootOfFile.get(target.path) ?? dirname(target.path))
        if (session.warnings.length > 0) {
          throw new FixProblem(`拒绝修复仍在写盘/尾部残缺的存档（${session.warnings[0]}）`)
        }
        const plan = planFix(session)
        planned.push({ session, plan })
      }
      const totalPairs = planned.reduce((sum, item) => sum + item.plan.pairs.length, 0)
      if (targets.length === 0) {
        throw new FixProblem(
          '存在违规，但没有"轮外 replace 型 tool/result"这一类（本修复只处理该类别），仅报告不写盘',
        )
      }
      if (totalPairs === 0) {
        throw new FixProblem(
          '找到"轮外 replace 型 tool/result"违规，但没有可安全识别成对 compaction/prune 的修复项（仅报告不写盘）',
        )
      }
      if (totalPairs > args.fixMax) {
        throw new FixProblem(
          `可修 ${totalPairs} 处，超过 --fix-max ${args.fixMax}；整次拒绝，未写任何文件（可用 --fix-max 调大）`,
        )
      }
      const unfixable = planned.flatMap((item) =>
        item.plan.unfixable.map((entry) => `${item.session.filePath} seq ${entry.seq}: ${entry.reason}`),
      )
      if (unfixable.length > 0) {
        // 只要有一处"轮外 replace 型 tool/result"无法安全撤回，整次拒绝：
        // 部分修复后仍会残留违规，写盘没有意义。
        throw new FixProblem(
          `有 ${unfixable.length} 处轮外 replace 型 tool/result 无法安全配对撤回，整次拒绝（未写任何文件）：` +
            unfixable.slice(0, 5).join('；'),
        )
      }
      for (const { session, plan } of planned) {
        reports.push(
          applyFix(session, plan, {
            dryRun: args.dryRun,
          }),
        )
      }
      report.fix = summarizeFix(reports, args.fixMax)
      report.fix.targets = reports.map((fixReport) => ({
        file: fixReport.file,
        pairs: fixReport.pairs,
        unfixable: fixReport.unfixable,
        violationsBefore: fixReport.violationsBefore,
        violationsAfter: fixReport.violationsAfter,
        deletedEvents: fixReport.deletedEvents,
        renumber: fixReport.renumber,
        scannedRefs: fixReport.scannedRefs,
        rewrittenRefs: fixReport.rewrittenRefs,
        droppedRefs: fixReport.droppedRefs,
        rewrittenByField: fixReport.rewrittenByField,
        derivedAdjustments: fixReport.derivedAdjustments,
        framesAfter: fixReport.framesAfter,
        backupPath: fixReport.backupPath,
        dryRun: fixReport.dryRun,
        selfCheck: fixReport.selfCheck,
      }))
      if (!args.dryRun) {
        // 修复成功的档不再算违规；仍有不可修项则保留 exit 1。
        const unfixable = reports.reduce((sum, fixReport) => sum + fixReport.unfixable.length, 0)
        exitCode = unfixable > 0 ? 1 : 0
      }
    } catch (error) {
      fixProblem = error
      if (error instanceof FixProblem) {
        report.fix = { error: error.message, exitCode: error.exitCode, targets: [] }
        exitCode = error.exitCode
        if (error.exitCode === 3) {
          // 自检失败已回滚：仍按"存在违规"提示。
          exitCode = 3
        }
      } else {
        report.fix = { error: error.message, exitCode: 2, targets: [] }
        exitCode = 2
      }
    }

    if (args.json) {
      process.stdout.write(JSON.stringify(report, null, 2) + '\n')
    } else {
      process.stdout.write(renderHumanAudit(report) + '\n')
      if (fixProblem !== null) {
        // 修复被拒绝/中止：不打印"修复计划"，避免与中止原因混淆。
        process.stderr.write(`\n修复中止: ${fixProblem.message}\n`)
      } else {
        process.stdout.write('\n' + renderHumanFix(reports) + '\n')
      }
    }
    return exitCode
  }

  if (args.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  } else {
    process.stdout.write(renderHumanAudit(report) + '\n')
    if (args.fix) process.stdout.write('\n修复: 全部存档干净，无需修复。\n')
    process.stdout.write(`\n退出码 ${exitCode}（${exitCode === 0 ? '全部干净' : '存在违规'}）\n`)
  }
  return exitCode
}

process.exitCode = main(process.argv.slice(2))
