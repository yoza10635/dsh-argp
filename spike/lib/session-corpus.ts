/**
 * 真实 session 语料读取器（供 spike / 离线验证使用）。
 *
 * ⚠️ **隐私铁律**：真实 session 是用户本人的工作数据（项目代码、设计文档、对话原文）。
 *   - 本模块**只读**，绝不写回、绝不修改 `~/.dsh/sessions`；
 *   - **任何 session 原文都不得提交进仓库**（不要生成包含真实文本的 fixture）；
 *   - 需要可复现性时，只提交**派生聚合量**（计数/分布/分位数），不提交内容；
 *   - 依赖真实语料的测试必须能在目录缺失时**优雅跳过**（CI 上通常没有）。
 *
 * 为什么需要这个模块：根 `tsconfig.json` 只检查 `src/**` + `test/**`，而真实语料
 * 只能从本机 `~/.dsh/sessions` 读；把读取逻辑固化在一处，避免每个 spike 各写一份
 * 多帧 zstd 解析（踩过的坑见下）。
 *
 * **文件格式坑**：`session.v3.jsonl.zstd` 是**多帧 zstd 拼接**（每次 append 压一帧，
 * 实测单文件 502 帧），Node 的 `zlib.zstdDecompressSync` **只解第一帧**且不报错
 * （会把 1.5MB 文件解成 193 字节而不报错）。正确做法：按 magic `28 B5 2F FD` 扫出
 * 每个帧起点，逐帧解压再拼接；伪命中帧解压会抛错，跳过即可。实测 0 坏帧、
 * `seq` 无缺口（历史完整）。
 *
 * 目录布局：`~/.dsh/sessions/<cwd-slug>/session-<uuid>/session.v3.jsonl.zstd`，
 * 其中 `<cwd-slug>` 是工作目录（如 `--C-workspace--`）。
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as zlib from 'node:zlib'
import type { OntologyAtom } from '../../src/token-ontology.ts'

/** zstd 帧 magic（little-endian 0xFD2FB528）。 */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 默认 session 根目录（`~/.dsh/sessions`）。 */
export function defaultSessionRoot(): string {
  return path.join(os.homedir(), '.dsh', 'sessions')
}

export interface RawSessionEvent {
  type: string
  seq: number
  surfaceOp?: unknown
  data: Record<string, unknown>
}

export interface LoadStats {
  /** 扫到的 zstd 帧数（含伪命中）。 */
  frames: number
  /** 解压失败的帧数（压缩数据里的伪 magic）——健康应为 0。 */
  badFrames: number
  /** 日志总行数（非空）。 */
  lines: number
  /** 解析成功的事件数（含头部事件）。 */
  events: number
  /**
   * 无 `seq` 的头部事件数。`session` 头按设计**没有** seq 字段
   * （只有 version/id/createdAt/cwd/isSeeded/delegationDepth/agentPreset）——
   * 这是正常形态，**不是**损坏，必须与 `malformed` 区分。
   */
  headEvents: number
  /** 非法行数（JSON 解析失败 / 既非头部又无 seq）——健康应为 0。 */
  malformed: number
  /** 有 seq 的事件数。 */
  seqCount: number
  seqMin: number
  seqMax: number
  /** `[seqMin, seqMax]` 内缺失的 seq 个数——健康应为 0（历史完整）。 */
  seqGaps: number
  /** 重复 seq 个数——健康应为 0。 */
  seqDups: number
}

/** 头部事件类型（无 seq，正常形态）。 */
const HEAD_EVENT_TYPES = new Set(['session'])

/**
 * 读取多帧 zstd JSONL：按 magic 扫帧起点，逐帧解压拼接，逐行 JSON.parse。
 * 返回事件按 seq 升序；同时给出**完整性账目**（坏帧 / 非法行 / seq 缺口 / 重复），
 * 供调用方直接断言"历史被完整复原"。
 */
export function loadSessionEvents(file: string): { events: RawSessionEvent[]; heads: RawSessionEvent[]; stats: LoadStats } {
  const buf = fs.readFileSync(file)
  const events: RawSessionEvent[] = []
  const heads: RawSessionEvent[] = []
  let frames = 0
  let badFrames = 0
  let lines = 0
  let headEvents = 0
  let malformed = 0
  const seqs: number[] = []
  for (let i = 0; i <= buf.length - 4; i += 1) {
    if (buf.compare(ZSTD_MAGIC, 0, 4, i, i + 4) !== 0) continue
    frames += 1
    let text: string
    try {
      text = zlib.zstdDecompressSync(buf.subarray(i), { maxOutputLength: 1 << 28 }).toString('utf8')
    } catch {
      badFrames += 1 // 压缩数据里的伪 magic
      continue
    }
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      lines += 1
      let ev: RawSessionEvent
      try {
        ev = JSON.parse(line) as RawSessionEvent
      } catch {
        malformed += 1
        continue
      }
      if (typeof ev.seq === 'number') {
        events.push(ev)
        seqs.push(ev.seq)
      } else if (HEAD_EVENT_TYPES.has(ev.type)) {
        headEvents += 1 // 正常头部事件（无 seq）
        heads.push(ev)
      } else {
        malformed += 1
      }
    }
  }
  events.sort((a, b) => a.seq - b.seq)
  seqs.sort((a, b) => a - b)
  const uniq = new Set(seqs)
  const seqMin = seqs.length > 0 ? seqs[0]! : -1
  const seqMax = seqs.length > 0 ? seqs[seqs.length - 1]! : -1
  let seqGaps = 0
  for (let i = seqMin; i <= seqMax; i += 1) if (!uniq.has(i)) seqGaps += 1
  return {
    events,
    heads,
    stats: {
      frames, badFrames, lines,
      events: events.length + headEvents,
      headEvents,
      malformed,
      seqCount: seqs.length,
      seqMin, seqMax, seqGaps,
      seqDups: seqs.length - uniq.size,
    },
  }
}

/**
 * 读**普通 JSONL**（受控跑批 harness 的产物，如 `pilot-tN.jsonl`）：每行一个事件，
 * **没有**多帧 zstd 容器，因此不需要扫 magic。
 *
 * 与 `loadSessionEvents` 返回同一形状与同一 stats 口径，审计脚本可统一消费。
 * 注意 harness 产物**没有 `session` 头部事件**（无 `cwd`/`agentPreset` 元数据），
 * 所以 `headEvents` 通常为 0——那是正常形态，不是损坏。
 */
export function loadPlainJsonl(file: string): { events: RawSessionEvent[]; heads: RawSessionEvent[]; stats: LoadStats } {
  const text = fs.readFileSync(file, 'utf8')
  const events: RawSessionEvent[] = []
  const heads: RawSessionEvent[] = []
  let lines = 0
  let malformed = 0
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    lines += 1
    try {
      const ev = JSON.parse(line) as RawSessionEvent
      if (typeof ev.seq === 'number') events.push(ev)
      else if (HEAD_EVENT_TYPES.has(ev.type)) heads.push(ev)
      else malformed += 1
    } catch {
      malformed += 1
    }
  }
  events.sort((a, b) => a.seq - b.seq)
  const seqs = events.map(e => e.seq)
  const uniq = new Set(seqs)
  const seqMin = seqs.length === 0 ? 0 : Math.min(...seqs)
  const seqMax = seqs.length === 0 ? 0 : Math.max(...seqs)
  let seqGaps = 0
  for (let i = seqMin; i <= seqMax; i += 1) if (!uniq.has(i)) seqGaps += 1
  return {
    events,
    heads,
    stats: {
      frames: 0, badFrames: 0, lines,
      events: events.length + heads.length,
      headEvents: heads.length,
      malformed,
      seqCount: seqs.length,
      seqMin, seqMax, seqGaps,
      seqDups: seqs.length - uniq.size,
    },
  }
}

/** 事件类型 → 原子类型（与引擎 `atomize` 同口径：U 用户 / A 助手 / R 工具结果）。 */
const TYPE_MAP: Readonly<Record<string, string>> = {  'user/message': 'U',
  'assistant/message': 'A',
  'tool/result': 'R',
}

/** 从 content 块里抽文本（三种信封形状共用：text 块 / tool-result 嵌套块）。 */
function grabText(blocks: unknown): string[] {
  if (!Array.isArray(blocks)) return []
  const out: string[] = []
  for (const b of blocks) {
    if (b === null || typeof b !== 'object') continue
    const bb = b as { type?: string; text?: string; content?: unknown }
    if (bb.type === 'text' && typeof bb.text === 'string') out.push(bb.text)
    else if (bb.type === 'tool-result') out.push(...grabText(bb.content))
  }
  return out
}

/** surfaceOp 是否为原始写入（排除 ARGP 的 replace/剪枝副本）。 */
function isOriginalAppend(ev: RawSessionEvent): boolean {
  const so = ev.surfaceOp
  if (so === 'append') return true
  if (so !== null && typeof so === 'object') return (so as { op?: string }).op === 'append'
  return false
}

/**
 * 事件流 → 原子序列（OntologyAtom：seq/turn/type/text）。
 * 只保留**原始 append 写入**：ARGP 自己的 replace 副本 / prune 影子节点不参与
 * ——语料要的是"压缩前的真实历史"，即压缩器的输入。
 *
 * 注意信封形状差异（实测）：`user/message` 的 content 在 `data.content`；
 * `tool/result` 与 `assistant/message` 在 `data.message.content`。
 */
export function atomsFromEvents(events: readonly RawSessionEvent[]): OntologyAtom[] {
  const out: OntologyAtom[] = []
  let turn = 0
  for (const ev of events) {
    if (ev.type === 'turn/start') {
      turn = (ev.data as { turn?: number }).turn ?? turn
      continue
    }
    const type = TYPE_MAP[ev.type]
    if (type === undefined) continue
    if (!isOriginalAppend(ev)) continue
    const d = ev.data as { content?: unknown; message?: { content?: unknown } }
    const blocks = ev.type === 'user/message' ? d.content : d.message?.content
    for (const text of grabText(blocks)) {
      if (text.trim() === '') continue
      out.push({ seq: ev.seq, turn, type, text })
    }
  }
  return out
}

export interface RealSession {
  /** session 目录名（如 `session-a56061c2-…`）。 */
  id: string
  /** 工作目录 slug（如 `--C-workspace--`）。 */
  cwdSlug: string
  file: string
  stats: LoadStats
  /** session 头信息（version/cwd/createdAt/agentPreset）。 */
  header: Record<string, unknown> | undefined
  atoms: OntologyAtom[]
}

/**
 * 载入根目录下全部真实 session。`root` 不存在时返回 `[]`（调用方据此优雅跳过，
 * 让依赖真实语料的用例在 CI 上不失败）。
 */
export function loadRealCorpus(root: string = defaultSessionRoot()): RealSession[] {
  if (!fs.existsSync(root)) return []
  const out: RealSession[] = []
  for (const slug of fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name)) {
    const slugDir = path.join(root, slug)
    for (const id of fs.readdirSync(slugDir)) {
      const file = path.join(slugDir, id, 'session.v3.jsonl.zstd')
      if (!fs.existsSync(file)) continue
      const { events, heads, stats } = loadSessionEvents(file)
      const header = heads.find(e => e.type === 'session')?.data
      out.push({ id, cwdSlug: slug, file, stats, header, atoms: atomsFromEvents(events) })
    }
  }
  return out
}
