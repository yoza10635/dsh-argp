/**
 * Preset 净化器（2026-09-04 Q8 根因的产品化收口）。
 *
 * 背景：dsh rc.2 起 agent 组成迁入 agent preset 平面，standard/cordis/ptc 的
 * `agent.cordis.yml` 在 `compaction` 组内各自挂载 `compaction-basic`——宿主 profile
 * 的 `disabled: true` 只作用于宿主组成树，管不到 preset 子树（mount.ts 经 Include
 * 直挂文件，不经任何 patch 层）。结果是官方摘要器与 ARGP 双引擎并存：外来 lossy
 * 摘要先于图剪发生（外来压缩检测告警的根因），且其英文 checkpoint 大块注入会把
 * 会话语言锚点拽向英文。
 *
 * 本模块在 ARGP 挂载期（宿主平面）对 roster 中每个仍挂 stock compaction 的 shipped
 * preset 自动生成净化副本 `<id>-argp`：整体目录 copy（官方 authoring API，处理权限
 * 与元数据）→ 文本级行手术摘除 `compaction-basic`（及可选 `tool-result-pruner`）
 * → 写回。保留 `command-compact` 行：其 `inject=['commands','compaction']` 在 realm
 * 内失去发布者后沿 scope 链向上解析到宿主平面的 `ctx.compaction`——即本插件的
 * ArgpGraphEngine（extends CompactionEngine，服务名 `compaction`）。因此净化副本里
 * `/compact` 自动指向 ARGP 的确定性 compactNow，零额外接线。
 *
 * 安全边界：
 * - 只 copy/写 user root（`~/.dsh/.agent-presets/`），永不触碰 shipped 安装目录；
 * - 幂等：目标已存在时只做自愈式重清理（内容无 stock 行则零写入）；
 * - 行手术按缩进块整体删除 YAML 列表项，不解析不求值（shipped 文件带 `!!js` 标签，
 *   通用 YAML 库会拒载），删除整个列表项不会破坏文档语法；组内清空时连组删除；
 * - 全程 fail-soft：任何失败只记日志，绝不阻断引擎挂载。
 *
 * 世代语义：roster 的 ensureStanding 以 composition 文件戳（mtime+size）判定世代，
 * 写回后下一个新会话自动挂新 generation——无需重启宿主；已开过口的会话固定旧组成。
 * @module dsh-argp/preset-cleaner
 */

import { writeFile } from 'node:fs/promises'

/** preset 文件里必须摘除的 stock compaction 行（compaction-basic 是双引擎冲突本体）。 */
export const DEFAULT_STRIP_ROWS = ['compaction-basic', 'tool-result-pruner'] as const

/** dsh-compaction-basic 的包名——presence 判定用，避免匹配到注释外的普通词。 */
const STOCK_BASIC_PACKAGE = "'@deepseek-ai/dsh-compaction-basic'"

/** roster 服务（@deepseek-ai/dsh-agent-presets 的 AgentPresets）的最小结构面。 */
export interface PresetRosterLike {
  list(): Promise<PresetRow[]>
  copy(from: string, id: string, name?: string): Promise<void>
  read(id: string): Promise<string>
}

/** roster.list() 行（AgentPreset 的结构子集）。 */
export interface PresetRow {
  id: string
  trust: 'system' | 'user'
  /** composition 文件（agent.cordis.yml）的绝对路径。 */
  path: string
  name?: string
  broken?: string
}

/** 净化选项。 */
export interface PresetCleanOptions {
  /** 摘除的行 id 集合；默认 compaction-basic + tool-result-pruner（8192 截断破坏 R 原子保真）。 */
  strip?: readonly string[]
  /** 目标 id 后缀；默认 `-argp`。 */
  suffix?: string
  /** 只处理这些源 id；缺省 = 全部含 stock compaction 的 shipped preset。 */
  sources?: readonly string[]
}

/** 单 preset 的净化结果。 */
export interface PresetCleanOutcome {
  source: string
  target: string
  status: 'created' | 'healed' | 'already-clean' | 'skipped'
  removed: string[]
  reason?: string
}

/** 一轮净化的总报告。 */
export interface PresetCleanReport {
  outcomes: PresetCleanOutcome[]
}

/**
 * 从 preset composition 文本中整块删除指定 `- id: <row>` 列表项。
 *
 * 项块 = 该行 + 后续所有「更深缩进或空行/注释（跟随至下一非空行归属判定）」的行。
 * 只删列表项不碰其他行，语法不可能被破坏；组内清空交给 {@link dropEmptyGroups}。
 * @param source - composition 文本。
 * @param rows - 要摘除的行 id 集合。
 * @returns 净化后文本与实际摘除的 id（顺序 = 文件出现序）。
 */
export function stripPresetRows(source: string, rows: readonly string[]): { text: string; removed: string[] } {
  const lines = source.split('\n')
  const out: string[] = []
  const removed: string[] = []
  let i = 0
  while (i < lines.length) {
    const match = /^(\s*)- id: (\S+)\s*$/.exec(lines[i])
    if (match !== null && rows.includes(match[2])) {
      const rowIndent = match[1].length
      // 扫描项块：空行/注释行先缓存，由下一非空行的缩进决定归属——
      // 更深 = 块内（连同缓存一并丢弃），否则 = 块外（缓存放回）。
      let j = i + 1
      let pending: string[] = []
      while (j < lines.length) {
        const line = lines[j]
        if (line.trim() === '' || line.trimStart().startsWith('#')) {
          pending.push(line)
          j += 1
          continue
        }
        const indent = line.length - line.trimStart().length
        if (indent > rowIndent) {
          pending = []
          j += 1
          continue
        }
        break
      }
      removed.push(match[2])
      out.push(...pending)
      i = j
      continue
    }
    out.push(lines[i])
    i += 1
  }
  return { text: out.join('\n'), removed }
}

/**
 * 删除 `config:` 列表已被清空的 `group: true` 组块。
 *
 * 行手术可能把组内唯一成员摘净，留下 `config:` 空值——loader 的 entryListProblem
 * 会判「group must hold a list」而拒绝整个 preset，故必须连组删除。
 * @param source - composition 文本。
 * @returns 清理后文本（无空组时原样返回）。
 */
export function dropEmptyGroups(source: string): string {
  const lines = source.split('\n')
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const match = /^(\s*)- id: (\S+)\s*$/.exec(lines[i])
    let groupEnd = -1
    if (match !== null) {
      const rowIndent = match[1].length
      let j = i + 1
      let pending: string[] = []
      let hasGroupMarker = false
      let configEmpty = false
      while (j < lines.length) {
        const line = lines[j]
        if (line.trim() === '' || line.trimStart().startsWith('#')) {
          pending.push(line)
          j += 1
          continue
        }
        const indent = line.length - line.trimStart().length
        if (indent <= rowIndent) break
        pending = []
        // group/config 键只认组直接子级（rowIndent+2）：嵌套更深的同名键（如叶子行
        // 的 config map）不是组结构，绝不能触发空组判定（否则误删整组）。
        if (indent === rowIndent + 2 && /^\s*group:\s*true\s*$/.test(line)) hasGroupMarker = true
        if (indent === rowIndent + 2 && /^config:\s*$/.test(line.trim())) {
          // config 列表为空 = 其后到块尾没有更深缩进的 `- ` 项
          let k = j + 1
          let sawItem = false
          let pendingK: string[] = []
          while (k < lines.length) {
            const inner = lines[k]
            if (inner.trim() === '' || inner.trimStart().startsWith('#')) {
              pendingK.push(inner)
              k += 1
              continue
            }
            const innerIndent = inner.length - inner.trimStart().length
            if (innerIndent > indent && inner.trimStart().startsWith('- ')) {
              sawItem = true
              break
            }
            if (innerIndent <= indent) break
            pendingK = []
            k += 1
          }
          if (!sawItem) configEmpty = true
        }
        j += 1
      }
      if (hasGroupMarker && configEmpty) {
        groupEnd = j
        out.push(...pending)
      }
    }
    if (groupEnd !== -1) {
      i = groupEnd
      continue
    }
    out.push(lines[i])
    i += 1
  }
  return out.join('\n')
}

/**
 * 净化 roster 中所有仍挂 stock compaction 的 shipped preset。
 *
 * 对每个 `trust === 'system'` 且 composition 含 `dsh-compaction-basic` 引用的 preset：
 * 目标副本 `<id><suffix>` 不存在时经官方 `copy()` 生成（权限/元数据由 authoring 承担），
 * 随后对副本做行手术并写回。目标已存在时按自愈语义重跑手术（内容已净则零写入）。
 * 源 preset 无 stock compaction（如 minimal）时跳过。单 preset 失败不阻断其余。
 * @param presets - roster 服务的结构面（构造期经 `ctx.inject(['agentPresets'])` 取得）。
 * @param options - strip 集合 / 后缀 / 源白名单。
 * @returns 每个 preset 的处置报告（日志与测试消费）。
 */
export async function cleanShippedPresets(
  presets: PresetRosterLike,
  options: PresetCleanOptions = {},
): Promise<PresetCleanReport> {
  const strip = options.strip ?? DEFAULT_STRIP_ROWS
  const suffix = options.suffix ?? '-argp'
  const outcomes: PresetCleanOutcome[] = []
  const roster = await presets.list()
  const candidates = roster.filter(row =>
    row.trust === 'system'
    && row.broken === undefined
    && (options.sources === undefined || options.sources.includes(row.id)),
  )
  for (const source of candidates) {
    try {
      const sourceText = await presets.read(source.id)
      if (!sourceText.includes(STOCK_BASIC_PACKAGE)) {
        outcomes.push({ source: source.id, target: '', status: 'skipped', removed: [], reason: 'no stock compaction-basic' })
        continue
      }
      const targetId = source.id + suffix
      const existing = roster.find(row => row.id === targetId)
      let targetPath: string
      let status: PresetCleanOutcome['status']
      if (existing === undefined) {
        await presets.copy(source.id, targetId, `${source.name ?? source.id} (ARGP)`)
        const refreshed = (await presets.list()).find(row => row.id === targetId)
        if (refreshed === undefined) throw new Error(`copy reported success but roster lost ${targetId}`)
        targetPath = refreshed.path
        status = 'created'
      } else {
        targetPath = existing.path
        status = existing.broken !== undefined ? 'skipped' : 'healed'
      }
      if (status === 'skipped') {
        outcomes.push({ source: source.id, target: targetId, status, removed: [], reason: 'existing target is broken' })
        continue
      }
      const targetText = await presets.read(targetId)
      const stripped = stripPresetRows(targetText, strip)
      const finalText = dropEmptyGroups(stripped.text)
      if (finalText === targetText) {
        outcomes.push({ source: source.id, target: targetId, status: 'already-clean', removed: [], reason: status === 'created' ? 'copy already clean' : 'no drift' })
        continue
      }
      await writeFile(targetPath, finalText, 'utf8')
      outcomes.push({ source: source.id, target: targetId, status, removed: stripped.removed })
    } catch (error) {
      outcomes.push({ source: source.id, target: source.id + suffix, status: 'skipped', removed: [], reason: String(error) })
    }
  }
  return { outcomes }
}
