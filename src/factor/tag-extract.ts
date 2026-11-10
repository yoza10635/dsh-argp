/**
 * R 贴标器（design-2.0 §2.2）：args 键值通道为主（P0 实测：file 族 document 覆盖 ≈100%），
 * 文本侧仅在 args 通道为空时兜底（增量口径）。纯函数——resultText 由引擎经
 * `rawEventText` 注入（嵌套 tool-result content 的展开是引擎侧职责，P0 坑账第 2 条）。
 */
import { canonicalArgsFp, canonicalPath, labelAllowed } from './tag-canonical.ts'
import type { ExtractInput, LabelReject, RTags } from './types.ts'

// ---------------------------------------------------------------------------
// 工具分族（P0 实测名单，spike/48 逐工具账；G1 定稿口径 = 按族分列）
// ---------------------------------------------------------------------------
export const GREP_TOOLS: ReadonlySet<string> = new Set(['grep', 'glob', 'search', 'rg', 'list_dir', 'ls'])
export const WRITE_TOOLS: ReadonlySet<string> = new Set(['write', 'edit', 'multi_edit', 'delete', 'patch', 'apply_patch', 'notebook_edit'])
export const READ_TOOLS: ReadonlySet<string> = new Set(['read', 'view'])
export const COMMAND_TOOLS: ReadonlySet<string> = new Set(['bash', 'shell', 'terminal', 'exec', 'run_command', 'run', 'pwsh', 'powershell', 'cmd'])

const FILE_KEYS = ['file_path', 'notebook_path', 'target_file', 'path', 'destination', 'new_path', 'old_path'] as const
const SCOPE_KEYS = ['path', 'paths', 'dir', 'cwd', 'directory'] as const

/** ALL_CAPS 错误码的通用噪音词（不配当标签；errorish 标志照举）。 */
const ALLCAPS_STOP: ReadonlySet<string> = new Set(['ERROR', 'WARNING', 'SUCCESS', 'NOTICE', 'TRACEBACK', 'EXCEPTION', 'PANIC', 'FAILED', 'TODO', 'FIXME', 'FALSE', 'NULL', 'TRUE', 'DEBUG', 'INFO'])

// ---------------------------------------------------------------------------
// 提取正则（文本侧兜底 + 错误信号）
// ---------------------------------------------------------------------------
const ALLCAPS_RE = /\b[A-Z][A-Z0-9_]{4,}\b/g
const EXITCODE_RE = /\bexit(?:ed)?\s+(?:with\s+)?(?:code|status)\s+(-?\d+)/gi
const STATUS_RE = /\bstatus\s*[:=]\s*(-?\d+)\b/gi
const ERR_HINT_RE = /\b(error|err!|failed|failure|fatal|exception|traceback|panic|denied|refused|unresolved)\b/i
const WIN_PATH_RE = /[A-Za-z]:[\\/][^\s'"`,;)\]{}]+/g
const UNIX_PATH_RE = /(?:[\w.@-]+\/)+[\w.@-]+\.\w{1,8}/g

function parseArgsObj(raw: unknown): Record<string, unknown> | null {
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

function strOf(o: Record<string, unknown>, key: string): string | null {
  const v = o[key]
  return typeof v === 'string' && v.trim().length > 0 ? v : null
}

function strArray(o: Record<string, unknown>, key: string): string[] {
  const v = o[key]
  if (typeof v === 'string') return [v]
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string')
  return []
}

function collect(into: Set<string>, raws: readonly string[], cwd: string | undefined, rejects: Partial<Record<LabelReject, number>>, cap: number): void {
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

/** bash 命令行 → 命令族（剥 `cd X &&` 前缀/环境赋值/sudo；多行取首行）。 */
export function commandFamily(cmd: string): { family: string | null; cwdHint: string | null } {
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

/** read 类 args → 读取范围（staleness 覆盖证明原料；全量读 = offset/limit 均 null）。 */
function readRangeOf(args: Record<string, unknown>): RTags['readRange'] {
  const offsetRaw = args['offset'] ?? args['start_line']
  const limitRaw = args['limit'] ?? args['count'] ?? args['end_line']
  const offset = typeof offsetRaw === 'number' && Number.isFinite(offsetRaw) ? offsetRaw : null
  const limit = typeof limitRaw === 'number' && Number.isFinite(limitRaw) ? limitRaw : null
  if (offset === null && limit === null) return null
  return { offset, limit }
}

/**
 * 对一个 R 贴标。通道纪律（§2.2）：
 *  - 命令族：command 标签 + cwd/dir 作用域（args.cwd/dir 是事件时环境的第二来源）；
 *  - grep 族：path/paths 进 scope（目录语义），不进 document；
 *  - file 族/未知工具：FILE_KEYS 逐个试（值须含 `/ : . \`之一，防 grep pattern 混入）；
 *  - 文本侧兜底**仅在 args 通道空**时启用（增量口径，P0 实测覆盖率按 args 通道计）。
 */
export function extractTags(input: ExtractInput): RTags {
  const args = parseArgsObj(input.rawArgs)
  const rejects: RTags['rejects'] = {}
  const files = new Set<string>()
  const scopes = new Set<string>()
  const commands = new Set<string>()
  const codes = new Set<string>()

  const tool = input.tool
  let cwd = input.sessionCwd
  let cwdSeen = false

  if (args !== null) {
    const cwdArg = strOf(args, 'cwd') ?? strOf(args, 'dir')
    if (cwdArg !== null) {
      cwdSeen = true
      const cp = canonicalPath(cwdArg, input.sessionCwd)
      if (cp !== null) cwd = cp.key
    }
    if (COMMAND_TOOLS.has(tool)) {
      const cmd = strOf(args, 'command') ?? strOf(args, 'cmd')
      if (cmd !== null) {
        const fam = commandFamily(cmd)
        if (fam.family !== null) {
          const label = 'command:' + fam.family
          const rej = labelAllowed(label)
          if (rej === null) commands.add(label)
          else rejects[rej] = (rejects[rej] ?? 0) + 1
        }
        if (fam.cwdHint !== null) collect(scopes, [fam.cwdHint], cwd, rejects, 4)
      }
    } else if (GREP_TOOLS.has(tool)) {
      const scopeRaws: string[] = []
      for (const k of SCOPE_KEYS) scopeRaws.push(...strArray(args, k))
      collect(scopes, scopeRaws, cwd, rejects, 8)
    } else {
      // 不像路径的原始值先丢（防 grep pattern / 裸词混入）——必须在 canonical 绑 cwd 前判，
      // 绑完 cwd 的键必含 '/'，事后过滤形同虚设（契约测试抓到的首轮病灶）
      const fileRaws: string[] = []
      for (const k of FILE_KEYS) fileRaws.push(...strArray(args, k))
      collect(files, fileRaws.filter(r => /[/.:\\]/.test(r.trim())), cwd, rejects, 8)
    }
  }

  if (files.size === 0 && scopes.size === 0) {
    const textRaws = [
      ...(input.resultText.match(WIN_PATH_RE) ?? []),
      ...(input.resultText.match(UNIX_PATH_RE) ?? []),
    ]
    collect(files, textRaws, cwd, rejects, 24)
  }

  let errorish = input.isError === true
  for (const m of input.resultText.matchAll(EXITCODE_RE)) {
    if (m[1] !== undefined && m[1] !== '0') {
      errorish = true
      codes.add('exit:' + m[1])
    }
  }
  for (const m of input.resultText.matchAll(STATUS_RE)) {
    if (m[1] !== undefined && m[1] !== '0') codes.add('status:' + m[1])
  }
  for (const m of input.resultText.matchAll(ALLCAPS_RE)) {
    const c = m[0] ?? ''
    if (!ALLCAPS_STOP.has(c)) codes.add(c)
  }
  if (!errorish && ERR_HINT_RE.test(input.resultText)) errorish = true
  if (codes.size > 0) errorish = true

  return {
    tool,
    files: [...files],
    scopes: [...scopes],
    commands: [...commands],
    errorcodes: [...codes].slice(0, 16),
    errorish,
    writeish: WRITE_TOOLS.has(tool),
    cwdSeen,
    argsFp: canonicalArgsFp(input.rawArgs),
    readRange: READ_TOOLS.has(tool) && args !== null ? readRangeOf(args) : null,
    sizeChars: input.resultText.length,
    rejects,
  }
}
