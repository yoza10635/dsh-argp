/**
 * 生成 cordis.patch.yml 的 ARGP preset override 段（0.1.7 C 方案的落地工具）。
 *
 * 读取 web-app 的 shipped preset patch 文件（standard/cordis/ptc），对每个应用
 * preset-cleaner 的纯文本手术（摘除 compaction 组的 stock compaction-basic /
 * tool-result-pruner 行 + isolate 块），转成顶层 modify override 行，写回
 * cordis.patch.yml 的 override 段（两个 MARK 标记之间，幂等替换）。
 *
 * 为什么需要它：0.1.7 的 AgentPresetRegistry 没有 copy/read/变更 API，preset
 * 配置只能经 patch 组合层按行 id override（last-write-wins，整体替换 config）。
 * override 是「快照」——宿主若更新 shipped preset（增删插件），需重跑本脚本
 * 重新对齐（不会自动合并宿主后续改动，registry README 明示的已知限制）。
 *
 * 用法：
 *   node --import ./scripts/ts-import-rewrite-loader.mjs scripts/generate-preset-overrides.ts [presetsDir]
 *   node --import ./scripts/ts-import-rewrite-loader.mjs scripts/generate-preset-overrides.ts --check [presetsDir]
 *     ——漂移检测（CI 用，见 .github/workflows/preset-drift.yml）：只比对不写盘，不一致退 1。
 *
 * presetsDir 缺省依次取：argv[2] → 环境变量 DSH_WEB_APP_PRESETS → 与插件仓库**同级**
 * 的 deepseek-harness checkout（`<repo>/../deepseek-harness/packages/bundle/web-app/presets`）。
 * 若宿主检出不在同级位置，请显式传 argv[2] 或设 DSH_WEB_APP_PRESETS。
 */
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { purifyPresetPatch } from '../src/preset-cleaner.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const PATCH_PATH = join(ROOT, 'cordis.patch.yml')
const MARK_BEGIN = '# === ARGP preset overrides (GENERATED — do not edit by hand) ==='
const MARK_END = '# === end ARGP preset overrides ==='
/** 带 stock compaction 组的 shipped preset（minimal 无 compaction 组，跳过）。 */
const PRESETS = ['standard', 'cordis', 'ptc'] as const

function defaultPresetsDir(): string {
  const fromEnv = process.env.DSH_WEB_APP_PRESETS
  if (fromEnv !== undefined) return resolve(fromEnv)
  // 与插件仓库同级的宿主检出——不写死任何绝对路径 / 用户目录。
  return join(resolve(ROOT, '..', 'deepseek-harness'), 'packages', 'bundle', 'web-app', 'presets')
}

async function main(): Promise<void> {
  // `--check`：漂移检测模式（CI 用）——重建 override 段与 cordis.patch.yml 现文比对，
  // 一致退 0、不一致打印首个差异并退 1，绝不写盘。宿主 preset 在 npm 发布物里没有
  // （web-app bundle 不单独发包），CI 唯一可取源是宿主仓库 sparse 拉 presets 目录。
  const checkMode = process.argv.slice(2).some(a => a === '--check')
  const positional = process.argv.slice(2).filter(a => !a.startsWith('--'))
  const presetsDir = positional[0] !== undefined ? resolve(positional[0]) : defaultPresetsDir()
  if (!existsSync(presetsDir)) {
    throw new Error(`presets dir not found: ${presetsDir} (pass it as argv[2] or set DSH_WEB_APP_PRESETS)`)
  }
  console.log(`[generate-preset-overrides] presets dir: ${presetsDir}${checkMode ? ' (check-only)' : ''}`)

  const overrides: string[] = []
  for (const preset of PRESETS) {
    const file = join(presetsDir, `${preset}.patch.yml`)
    const source = await readFile(file, 'utf8')
    const { text, removed, changed } = purifyPresetPatch(source)
    if (!changed) {
      console.log(`  ${preset}: already clean (no stock compaction) — skipped`)
      continue
    }
    console.log(`  ${preset}: removed [${removed.join(', ')}]`)
    overrides.push(text.replace(/\s+$/, ''))
  }

  const section = [
    MARK_BEGIN,
    '# Regenerate: node --import ./scripts/ts-import-rewrite-loader.mjs scripts/generate-preset-overrides.ts [presetsDir]',
    '# 宿主 preset 增删插件后重跑本脚本重新对齐（override 整体替换 config，不自动合并宿主改动）。',
    ...overrides,
    MARK_END,
  ].join('\n')

  const current = await readFile(PATCH_PATH, 'utf8')
  const beginIdx = current.indexOf(MARK_BEGIN)
  const endIdx = current.indexOf(MARK_END)
  let next: string
  if (beginIdx !== -1 && endIdx !== -1) {
    const before = current.slice(0, beginIdx)
    const after = current.slice(endIdx + MARK_END.length)
    next = before + section + after
  } else {
    next = current.replace(/\s+$/, '') + '\n\n' + section + '\n'
  }
  if (checkMode) {
    if (next === current) {
      console.log(`[generate-preset-overrides] check: in sync (${overrides.length} override(s) vs host presets)`)
      return
    }
    if (beginIdx === -1 || endIdx === -1) {
      console.error('[generate-preset-overrides] check: DRIFT — MARK 段缺失，无法比对')
      process.exitCode = 1
      return
    }
    const cur = current.slice(beginIdx, endIdx + MARK_END.length).split('\n')
    const exp = section.split('\n')
    let first = 0
    while (first < cur.length && first < exp.length && cur[first] === exp[first]) first += 1
    console.error(`[generate-preset-overrides] check: DRIFT — 宿主 preset 与包内快照不一致（首个差异在第 ${first + 1} 行，`
      + `快照 ${cur.length} 行 vs 期望 ${exp.length} 行）`)
    for (const [tag, lines] of [['current', cur], ['expected', exp]] as const) {
      for (let i = first; i < Math.min(first + 8, lines.length); i += 1) {
        console.error(`  ${tag} L${i + 1}: ${lines[i] ?? '(eof)'}`)
      }
    }
    console.error('  → 修复：本地重跑 node --import ./scripts/ts-import-rewrite-loader.mjs '
      + 'scripts/generate-preset-overrides.ts <host presets 目录> 并提交（人工审：幽灵键/子路径教训见 CHANGELOG issue #4）')
    process.exitCode = 1
    return
  }
  await writeFile(PATCH_PATH, next, 'utf8')
  console.log(`[generate-preset-overrides] wrote ${overrides.length} override(s) to ${PATCH_PATH}`)
}

main().catch((error) => {
  console.error('[generate-preset-overrides] failed:', error)
  process.exitCode = 1
})
