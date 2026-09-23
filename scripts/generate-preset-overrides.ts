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
  const presetsDir = process.argv[2] !== undefined ? resolve(process.argv[2]) : defaultPresetsDir()
  if (!existsSync(presetsDir)) {
    throw new Error(`presets dir not found: ${presetsDir} (pass it as argv[2] or set DSH_WEB_APP_PRESETS)`)
  }
  console.log(`[generate-preset-overrides] presets dir: ${presetsDir}`)

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
  await writeFile(PATCH_PATH, next, 'utf8')
  console.log(`[generate-preset-overrides] wrote ${overrides.length} override(s) to ${PATCH_PATH}`)
}

main().catch((error) => {
  console.error('[generate-preset-overrides] failed:', error)
  process.exitCode = 1
})
