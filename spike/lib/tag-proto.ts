/**
 * 因子贴标原型（P0 spike/48、spike/49 共用；验收后 P1 升格为
 * `src/tag-canonical.ts` + `src/tag-extract.ts`——跑的就是这份代码，数据好才转正）。
 *
 * 设计依据：docs/design-2.0-factor-engine.md §1.3（canonical 单点/fail-closed 注入面）、
 * §2.2（因子表 v2）。纯函数、零 Session I/O。
 *
 * 三条纪律：
 *  1. **canonical 单点**：贴标侧与（未来的）查询侧必须共用 canonicalPath/labelAllowed；
 *  2. **fail-closed**：标签过不了白名单文法/长度/secret 检查 → 记 reject 原因，
 *     调用方据此"留索引、不进 prompt"；
 *  3. **事件时环境**：相对路径只用**事件在场 cwd**（session 头 / bash cwd 参数）绑定，
 *     绑不上就 rel: 前缀 + unboundRel 标记，**绝不拿调用方当前 cwd 凑**。
 */

// ---------------------------------------------------------------------------
// 工具白名单（v0，来自 spike43 targetOf 命名惯例 + dsh 常见工具名；未列工具走启发式）
// ---------------------------------------------------------------------------
const GREP_TOOLS = new Set(['grep', 'glob', 'search', 'rg', 'list_dir', 'ls'])
const FILE_TOOLS = new Set(['read', 'write', 'edit', 'multi_edit', 'delete', 'patch', 'apply_patch', 'notebook_edit', 'view'])
const WRITE_TOOLS = new Set(['write', 'edit', 'multi_edit', 'delete', 'patch', 'apply_patch', 'notebook_edit'])
const COMMAND_TOOLS = new Set(['bash', 'shell', 'terminal', 'exec', 'run_command', 'run', 'pwsh', 'powershell', 'cmd'])

/** args 里算"文件"的键（按工具族取用）。 */
const FILE_KEYS = ['file_path', 'notebook_path', 'target_file', 'path', 'destination', 'new_path', 'old_path']
/** args 里算"作用域（目录/多路径）"的键。 */
const SCOPE_KEYS = ['path', 'paths', 'dir', 'cwd', 'directory']

/** ALL_CAPS 错误码里的通用噪音词（不配当标签）。 */
const ALLCAPS_STOP = new Set(['ERROR', 'WARNING', 'SUCCESS', 'NOTICE', 'TRACEBACK', 'EXCEPTION', 'PANIC', 'FAILED', 'TODO', 'FIXME', 'FALSE', 'NULL', 'TRUE', 'DEBUG', 'INFO'])

// ---------------------------------------------------------------------------
// fail-closed 注入面文法（§1.3）
// ---------------------------------------------------------------------------
export type LabelReject = 'secret' | 'long' | 'newline' | 'empty'

const SECRET_RES: RegExp[] = [
  /\b(?:sk|pk|ghp|gho|ghu|ghs|ghr|github_pat|xox[bpars])[-_][A-Za-z0-9_-]{8,}/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/, // JWT
  /-----BEGIN[A-Z ]*PRIVATE KEY-----/,
  /\b(?:api[_-]?key|token|secret|password|passwd)\s*[:=]\s*\S{6,}/i,
]

/** null = 允许；非 null = 拒收原因（fail-closed：拒收者不得进 prompt）。 */
export function labelAllowed(label: string): LabelReject | null {
  if (label.length === 0) return 'empty'
  if (label.length > 200) return 'long'
  if (/[\r\n\t\u0000-\u001f]/.test(label)) return 'newline'
  for (const re of SECRET_RES) {
    re.lastIndex = 0
    if (re.test(label)) return 'secret'
  }
  return null
}

// ---------------------------------------------------------------------------
// canonical 路径（§1.3 规则 v0：反斜杠归一 / `./` 剥离 / msys /c/ → c:/ /
// 盘符键整体小写（Windows 大小写不敏感）/ 相对路径绑事件时 cwd，绑不上 rel: 标记）
// ---------------------------------------------------------------------------
export interface CanonicalPath {
  key: string
  /** 相对路径且无事件时 cwd 可绑 → true（canonical 冲突审计的计数对象）。 */
  unboundRel: boolean
}

function normalizeSlashes(s: string): string {
  return s.replace(/\\/g, '/')
}

export function canonicalPath(raw: string, cwd?: string): CanonicalPath | null {
  let s = raw.trim().replace(/^['"`]+|['"`]+$/g, '')
  if (s.length === 0) return null
  s = normalizeSlashes(s)
  s = s.replace(/^\.\//, '')
  // msys/cygwin 形态 /c/foo → c:/foo
  if (/^\/[a-z]\//i.test(s)) s = s.slice(1, 3).toLowerCase() + ':' + s.slice(2)
  const drive = /^[a-z]:\//i.exec(s)
  if (drive !== null) {
    s = s.toLowerCase()
  } else if (s.startsWith('/') || s.startsWith('~/')) {
    // unix 绝对 / home 相对：保留大小写
  } else {
    // 相对路径：只绑事件在场 cwd
    if (cwd !== undefined && cwd.length > 0) {
      let base = normalizeSlashes(cwd.trim())
      if (/^\/[a-z]\//i.test(base)) base = base.slice(1, 3).toLowerCase() + ':' + base.slice(2)
      s = (/^[a-z]:\//i.test(base) ? base.toLowerCase() : base).replace(/\/+$/, '') + '/' + s
    } else {
      return { key: 'rel:' + s, unboundRel: true }
    }
  }
  s = s.replace(/\/{2,}/g, '/').replace(/\/+$/, '')
  if (s.length === 0) return null
  return { key: s, unboundRel: false }
}

// ---------------------------------------------------------------------------
// args 解析（tool/call 的 arguments：raw JSON string 或对象，log-access.ts:195-199 实核两态）
// ---------------------------------------------------------------------------
export function parseToolArgs(raw: unknown): Record<string, unknown> | null {
  if (typeof raw === 'string') {
    const t = raw.trim()
    if (!t.startsWith('{')) return null
    try {
      const o: unknown = JSON.parse(t)
      return typeof o === 'object' && o !== null ? (o as Record<string, unknown>) : null
    } catch {
      return null
    }
  }
  if (typeof raw === 'object' && raw !== null) return raw as Record<string, unknown>
  return null
}

function str(o: Record<string, unknown>, key: string): string | null {
  const v = o[key]
  return typeof v === 'string' && v.trim().length > 0 ? v : null
}

// ---------------------------------------------------------------------------
// 贴标
// ---------------------------------------------------------------------------
export interface FacetBag {
  tool: string
  files: string[]
  scopes: string[]
  commands: string[]
  errorcodes: string[]
  /** 结果文本含错误信号（exit≠0 / error 词 / ALL_CAPS 码）。 */
  errorish: boolean
  /** 本事件在场 cwd（bash cwd/dir 参数；spike48 审计"事件时环境可得率"）。 */
  cwdSeen: boolean
  /** write 家族成功（sticky 闭集判据原料）。 */
  writeish: boolean
  rejects: Partial<Record<LabelReject, number>>
}

const ALLCAPS_RE = /\b[A-Z][A-Z0-9_]{4,}\b/g
const EXITCODE_RE = /\bexit(?:ed)?\s+(?:with\s+)?(?:code|status)\s+(-?\d+)/gi
const STATUS_RE = /\bstatus\s*[:=]\s*(-?\d+)\b/gi
const ERR_HINT_RE = /\b(error|err!|failed|failure|fatal|exception|traceback|panic|denied|refused|unresolved)\b/i
const WIN_PATH_RE = /[A-Za-z]:[\\/][^\s'"`,;)\]{}]+/g
const UNIX_PATH_RE = /(?:[\w.@-]+\/)+[\w.@-]+\.\w{1,8}/g

function collectLabels(into: Set<string>, raws: readonly string[], cwd: string | undefined, rejects: FacetBag['rejects'], cap: number): void {
  for (const r of raws) {
    if (into.size >= cap) return
    const cp = canonicalPath(r, cwd)
    if (cp === null) continue
    const rej = labelAllowed(cp.key)
    if (rej !== null) {
      rejects[rej] = (rejects[rej] ?? 0) + 1
      continue
    }
    into.add(cp.key)
  }
}

/** 从 bash 命令行提取命令族（首 token；剥 `cd X && ` 前缀与环境赋值，sudo 忽略）。 */
function commandFamily(cmd: string): { family: string | null; cwdHint: string | null } {
  let s = cmd.split('\n')[0] ?? ''
  let cwdHint: string | null = null
  const cd = /^cd\s+([^&|;]+)&&?\s*/.exec(s)
  if (cd !== null) {
    cwdHint = cd[1]?.trim() ?? null
    s = s.slice(cd[0].length)
  }
  s = s.replace(/^(?:sudo\s+|[\w.]+=\S+\s+)*/, '')
  const first = s.trim().split(/\s+/)[0] ?? ''
  if (first.length === 0) return { family: null, cwdHint }
  return { family: first.split('/').pop() ?? first, cwdHint }
}

/**
 * 对一个 R（tool result）贴标。toolName/args 来自其 issuer tool/call 事件，
 * resultText 是 R 的文本投影（spike 侧自行 join；P1 用 rawEventText）。
 */
export function facetsOf(toolName: string, rawArgs: unknown, resultText: string, sessionCwd?: string): FacetBag {
  const args = parseToolArgs(rawArgs)
  const bag: FacetBag = {
    tool: toolName,
    files: [], scopes: [], commands: [], errorcodes: [],
    errorish: false, cwdSeen: false, writeish: WRITE_TOOLS.has(toolName),
    rejects: {},
  }
  // 事件时 cwd：bash/命令类工具的 cwd/dir 参数优先于 session 头
  let cwd = sessionCwd
  if (args !== null) {
    const cwdArg = str(args, 'cwd') ?? str(args, 'dir')
    if (cwdArg !== null) {
      bag.cwdSeen = true
      const cp = canonicalPath(cwdArg, sessionCwd)
      if (cp !== null) cwd = cp.key
    }
  }

  const files = new Set<string>()
  const scopes = new Set<string>()
  const commands = new Set<string>()
  const codes = new Set<string>()

  if (args !== null) {
    if (COMMAND_TOOLS.has(toolName)) {
      const cmd = str(args, 'command') ?? str(args, 'cmd')
      if (cmd !== null) {
        const { family, cwdHint } = commandFamily(cmd)
        if (family !== null) commands.add('command:' + family)
        if (cwdHint !== null) {
          const cp = canonicalPath(cwdHint, cwd)
          if (cp !== null) scopes.add(cp.key)
        }
      }
    } else if (GREP_TOOLS.has(toolName)) {
      // grep/glob 的 path 是作用域（目录为主）
      const scopeRaws: string[] = []
      for (const k of SCOPE_KEYS) {
        const v = args[k]
        if (typeof v === 'string') scopeRaws.push(v)
        else if (Array.isArray(v)) for (const it of v) if (typeof it === 'string') scopeRaws.push(it)
      }
      collectLabels(scopes, scopeRaws, cwd, bag.rejects, 8)
    } else {
      // FILE_TOOLS + 未知工具启发式：FILE_KEYS 逐个试
      const fileRaws: string[] = []
      for (const k of FILE_KEYS) {
        const v = args[k]
        if (typeof v === 'string') fileRaws.push(v)
        else if (Array.isArray(v)) for (const it of v) if (typeof it === 'string') fileRaws.push(it)
      }
      collectLabels(files, fileRaws, cwd, bag.rejects, 8)
      // 值不像路径（grep pattern 混入等）的粗过滤：至少含 / : . 之一
      for (const f of [...files]) if (!/[/.:\\]/.test(f)) files.delete(f)
    }
  }

  // 文本侧兜底（args 通道之外的增量，审计里单列）
  if (files.size === 0 && scopes.size === 0) {
    const textRaws = [
      ...(resultText.match(WIN_PATH_RE) ?? []),
      ...(resultText.match(UNIX_PATH_RE) ?? []),
    ]
    collectLabels(files, textRaws, cwd, bag.rejects, 24)
  }

  // 错误信号
  let errorish = false
  for (const m of resultText.matchAll(EXITCODE_RE)) {
    if (m[1] !== undefined && m[1] !== '0') {
      errorish = true
      codes.add('exit:' + m[1])
    }
  }
  for (const m of resultText.matchAll(STATUS_RE)) {
    if (m[1] !== undefined && m[1] !== '0') codes.add('status:' + m[1])
  }
  for (const m of resultText.matchAll(ALLCAPS_RE)) {
    const c = m[0] ?? ''
    if (ALLCAPS_STOP.has(c)) continue
    codes.add(c)
  }
  if (ERR_HINT_RE.test(resultText)) errorish = true
  if (codes.size > 0) errorish = true

  bag.files = [...files]
  bag.scopes = [...scopes]
  bag.commands = [...commands]
  bag.errorcodes = [...codes].slice(0, 16)
  bag.errorish = errorish
  return bag
}

// ---------------------------------------------------------------------------
// 会话事件流上的 R↔issuer 关联（spike43 实核形态：tool/call {callId,name,arguments}
// × tool/result data.message.content[].toolCallId）
// ---------------------------------------------------------------------------
export interface CallInfo {
  name: string
  args: unknown
  seq: number
}

export interface CallIndex {
  byId: Map<string, CallInfo>
}

export function indexCalls(events: readonly { type: string; seq: number; data: Record<string, unknown> }[]): CallIndex {
  const byId = new Map<string, CallInfo>()
  for (const e of events) {
    if (e.type !== 'tool/call') continue
    const data = e.data ?? {}
    const callId = typeof data['callId'] === 'string' ? (data['callId'] as string) : undefined
    if (callId === undefined) continue
    if (!byId.has(callId)) byId.set(callId, { name: String(e.data['name'] ?? ''), args: e.data['arguments'], seq: e.seq })
  }
  return { byId }
}

/** tool/result 事件 → 其 issuer 调用（取第一个 toolCallId，与 spike43 同口径）。 */
export function issuerOf(e: { type: string; data: Record<string, unknown> }, calls: CallIndex): CallInfo | null {
  if (e.type !== 'tool/result') return null
  const msg = (e.data ?? {})['message'] as { content?: Array<{ toolCallId?: string }> } | undefined
  const cid = msg?.content?.[0]?.toolCallId
  if (typeof cid !== 'string') return null
  return calls.byId.get(cid) ?? null
}

/**
 * R 事件文本投影（审计口径足够；逐字口径是 P1 的 rawEventText）。
 * 形态（spike43 bodyOf 实核）：`data.message.content[]` 的 text 块 +
 * `tool-result` 块的**嵌套 content 递归**——只取顶层 text 会全空（spike48 首轮踩过）。
 */
export function resultTextOf(e: { data?: Record<string, unknown> }, capChars = 16_384): string {
  const msg = (e.data ?? {})['message'] as { content?: unknown } | undefined
  const parts: string[] = []
  let n = 0
  const grab = (blocks: unknown): void => {
    if (!Array.isArray(blocks)) return
    for (const b of blocks) {
      if (n >= capChars) return
      if (b === null || typeof b !== 'object') continue
      const bb = b as { type?: string; text?: string; content?: unknown }
      if (bb.type === 'text' && typeof bb.text === 'string') {
        parts.push(bb.text)
        n += bb.text.length
      } else if (bb.type === 'tool-result') {
        grab(bb.content)
      }
    }
  }
  grab(msg?.content)
  return parts.join('\n')
}

/** session 头事件的 cwd（事件时环境之一）。heads 来自 loadSessionEvents。 */
export function sessionCwdOf(heads: readonly { type: string; data?: Record<string, unknown> }[]): string | undefined {
  for (const h of heads) {
    const cwd = h.data?.['cwd']
    if (h.type === 'session' && typeof cwd === 'string') return cwd
  }
  return undefined
}
