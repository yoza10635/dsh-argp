/**
 * canonical 单点（design-2.0 §1.3 P0 不变量）：贴标侧与查询侧**必须共用**本模块，
 * 两侧各写一份 normalize 是本方案最可能的静默死法（变异测试钉死于 test/tag-canonical.test.ts）。
 *
 * 纯函数、零依赖（含零 fs——事件时 cwd 由调用方作为参数注入，缺失即 rel: 标记，
 * 绝不拿调用方当前 cwd 凑）。
 */
import type { LabelReject } from './types.ts'

// ---------------------------------------------------------------------------
// fail-closed 注入面文法（§1.3：词表是给模型看的 prompt，标签源自不可信的 args/文本）
// ---------------------------------------------------------------------------

const SECRET_RES: RegExp[] = [
  /\b(?:sk|pk|ghp|gho|ghu|ghs|ghr|github_pat|xox[bpars])[-_][A-Za-z0-9_-]{8,}/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/, // JWT
  /-----BEGIN[A-Z ]*PRIVATE KEY-----/,
  /\b(?:api[_-]?key|token|secret|password|passwd)\s*[:=]\s*\S{6,}/i,
]

/** null = 允许；非 null = 拒收原因。拒收者留索引、不进 prompt（fail-closed）。 */
export function labelAllowed(label: string): LabelReject | null {
  if (label.length === 0) return 'empty'
  if (label.length > 200) return 'long'
  if (/[\r\n\t\x00-\x1f]/.test(label)) return 'newline'
  for (const re of SECRET_RES) {
    re.lastIndex = 0
    if (re.test(label)) return 'secret'
  }
  return null
}

// ---------------------------------------------------------------------------
// canonical 路径
// ---------------------------------------------------------------------------

export interface CanonicalPath {
  key: string
  /** 相对路径且无事件时 cwd 可绑（canonical 冲突审计计数对象；保守不合并）。 */
  unboundRel: boolean
}

function normalizeSlashes(s: string): string {
  return s.replace(/\\/g, '/')
}

/** 剥离尾部行号引用（`a.ts:12:3` → `a.ts`）——document 键按文件粒度归并。 */
export function stripLineRef(raw: string): string {
  return raw.replace(/:\d+(?::\d+)?$/, '')
}

/** msys `/c/x` → `c:/x`；盘符键整体小写（Windows 大小写不敏感）。契约测试抓到过 slice 拼形病灶。 */
function normalizeAbsForm(s: string): string {
  if (/^\/[a-z]\//i.test(s)) s = (s[1] ?? '').toLowerCase() + ':' + s.slice(2)
  return /^[a-z]:\//i.test(s) ? s.toLowerCase() : s
}

function isAbsLike(s: string): boolean {
  return /^[a-z]:\//i.test(s) || s.startsWith('/') || s.startsWith('~/')
}

function finalize(s: string): string {
  return s.replace(/\/{2,}/g, '/').replace(/\/+$/, '')
}

/**
 * 规则（P0 实测形态，spike/48）：
 *  反斜杠归一 → `./` 剥离 → 行号剥离 → msys/盘符归形 → 尾/双斜杠归并；
 *  unix 绝对路径与 `~/` 保留大小写，盘符键小写合并。
 *  相对路径：只绑**事件在场 cwd**（参数注入，同一归形管道）；
 *  无 cwd → `rel:` 前缀 + unboundRel（保守不合并）。
 */
export function canonicalPath(raw: string, cwd?: string): CanonicalPath | null {
  let s = raw.trim().replace(/^['"`]+|['"`]+$/g, '')
  if (s.length === 0) return null
  s = normalizeSlashes(s)
  s = s.replace(/^\.\//, '')
  s = stripLineRef(s)
  s = normalizeAbsForm(s)
  if (isAbsLike(s)) {
    const key = finalize(s)
    return key.length === 0 ? null : { key, unboundRel: false }
  }
  if (cwd !== undefined && cwd.length > 0) {
    const base = finalize(normalizeAbsForm(normalizeSlashes(cwd.trim())))
    const key = finalize(base.replace(/\/+$/, '') + '/' + s)
    return key.length === 0 ? null : { key, unboundRel: false }
  }
  return { key: 'rel:' + s, unboundRel: true }
}

// ---------------------------------------------------------------------------
// args 语义指纹（失败-重试配对键，§1.3：语义 canonical JSON，非 raw 文本）
// ---------------------------------------------------------------------------

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = canonicalJson((value as Record<string, unknown>)[k])
    }
    return out
  }
  return value
}

/**
 * args → 语义指纹：string 先 JSON.parse（宿主两态，log-access.ts:195-199），对象直用；
 * 键深度排序 + 空白规整 ⇒ `{a:1,b:2}` 与 `{"b":2, "a":1}` 同指纹。
 * 不可解析 → trim 后的原文（仍可比，只是退化为字面）。
 */
export function canonicalArgsFp(raw: unknown): string {
  if (raw === undefined || raw === null) return ''
  let parsed: unknown = raw
  if (typeof raw === 'string') {
    const t = raw.trim()
    if (t.startsWith('{') || t.startsWith('[')) {
      try {
        parsed = JSON.parse(t)
      } catch {
        return t
      }
    } else {
      return t
    }
  }
  try {
    return JSON.stringify(canonicalJson(parsed))
  } catch {
    return String(raw).trim()
  }
}
