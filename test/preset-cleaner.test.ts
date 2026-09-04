/**
 * preset-cleaner 单元测试（2026-09-04 Q8 收口）。
 *
 * 覆盖：行手术的块边界（缩进/空行/注释归属）、幂等性、空组级联删除、
 * 无匹配原文返回，以及 cleanShippedPresets 对 fake roster 的编排语义
 * （copy→strip→写回、已存在自愈、已净化零写入、broken/无 stock 跳过）。
 * fixture 为 shipped standard/agent.cordis.yml 的结构等价样例（含 `!!js`
 * 标签行，确保手术不触碰不解析的行）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { copyFile, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanShippedPresets, dropEmptyGroups, stripPresetRows, type PresetRosterLike, type PresetRow } from '../src/preset-cleaner.js'

const FIXTURE = [
  '# The `standard` agent preset: the full coding agent.',
  '',
  '- id: persona',
  "  name: '@deepseek-ai/dsh-persona'",
  '  config:',
  '    text: You are a coding agent powered by the {{model}} model.',
  '',
  '- id: tool-bash',
  "  name: '@deepseek-ai/dsh-tool-bash'",
  '  disabled: !!js process.platform === \'win32\'',
  '',
  '- id: compaction',
  '  name: cordis:group',
  '  group: true',
  '  isolate:',
  '    compaction: true',
  '    toolResultPruner: true',
  '  config:',
  '    - id: compaction-basic',
  "      name: '@deepseek-ai/dsh-compaction-basic'",
  '',
  '    - id: command-compact',
  "      name: '@deepseek-ai/dsh-command-compact'",
  '',
  '    - id: tool-result-pruner',
  "      name: '@deepseek-ai/dsh-compaction-tool-result-pruner'",
  '      config:',
  '        thresholdChars: 8192',
  '        headChars: 4096',
  '        tailChars: 1024',
  '',
  '- id: delegation',
  '  name: cordis:group',
  '  group: true',
  '  config:',
  '    - id: tool-subagent',
  "      name: '@deepseek-ai/dsh-tool-subagent'",
  '',
].join('\n')

function row(id: string, path: string, trust: 'system' | 'user', broken?: string): PresetRow {
  return { id, trust, path, ...(broken === undefined ? {} : { broken }) }
}

/** 磁盘 roster：copy = 文件复制，read = 磁盘读，list 每次重扫目录（对齐 discovery 语义）。 */
function diskRoster(dir: string, knownTrust: ReadonlyMap<string, 'system' | 'user'>): PresetRosterLike {
  const pathOf = (id: string): string => join(dir, id + '.yml')
  return {
    async list(): Promise<PresetRow[]> {
      const names = (await readdir(dir)).filter(n => n.endsWith('.yml')).map(n => n.slice(0, -4))
      return names.map(id => row(id, pathOf(id), knownTrust.get(id) ?? 'user'))
    },
    async copy(from: string, id: string): Promise<void> {
      if (existsSync(pathOf(id))) throw new Error(`preset id ${id} already taken`)
      await copyFile(pathOf(from), pathOf(id))
    },
    async read(id: string): Promise<string> {
      return await readFile(pathOf(id), 'utf8')
    },
  }
}

test('stripPresetRows removes target rows whole and keeps siblings byte-exact', () => {
  const { text, removed } = stripPresetRows(FIXTURE, ['compaction-basic', 'tool-result-pruner'])
  assert.deepEqual(removed, ['compaction-basic', 'tool-result-pruner'])
  // 目标行及其 name/config 子行全部消失
  assert.ok(!text.includes('dsh-compaction-basic'))
  assert.ok(!text.includes('tool-result-pruner\n      name:'))
  assert.ok(!text.includes('thresholdChars'))
  // 兄弟行与无关行逐字保留
  assert.ok(text.includes("    - id: command-compact\n      name: '@deepseek-ai/dsh-command-compact'"))
  assert.ok(text.includes("disabled: !!js process.platform === 'win32'"))
  assert.ok(text.includes('- id: persona'))
  assert.ok(text.includes('- id: delegation'))
  // compaction 组仍在（command-compact 幸存）
  assert.ok(text.includes('- id: compaction\n  name: cordis:group'))
})

test('stripPresetRows is idempotent', () => {
  const once = stripPresetRows(FIXTURE, ['compaction-basic', 'tool-result-pruner'])
  const twice = stripPresetRows(once.text, ['compaction-basic', 'tool-result-pruner'])
  assert.equal(twice.text, once.text)
  assert.deepEqual(twice.removed, [])
})

test('stripPresetRows returns source unchanged when nothing matches', () => {
  const { text, removed } = stripPresetRows(FIXTURE, ['nonexistent-row'])
  assert.equal(text, FIXTURE)
  assert.deepEqual(removed, [])
})

test('dropEmptyGroups removes the compaction group once its config is emptied', () => {
  const allStripped = stripPresetRows(FIXTURE, ['compaction-basic', 'command-compact', 'tool-result-pruner'])
  const cleaned = dropEmptyGroups(allStripped.text)
  assert.ok(!cleaned.includes('compaction-basic'))
  assert.ok(!cleaned.includes('command-compact'))
  assert.ok(!cleaned.includes('- id: compaction\n  name: cordis:group'))
  // 空组删除不伤及前后组
  assert.ok(cleaned.includes('- id: persona'))
  assert.ok(cleaned.includes('- id: delegation'))
  // 非空组不受影响
  const partial = dropEmptyGroups(stripPresetRows(FIXTURE, ['compaction-basic']).text)
  assert.ok(partial.includes('- id: compaction\n  name: cordis:group'))
  assert.ok(partial.includes('command-compact'))
})

test('cleanShippedPresets copies + strips shipped presets and leaves user presets alone', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'argp-preset-'))
  const standardFile = join(dir, 'standard.yml')
  await writeFile(standardFile, FIXTURE, 'utf8')
  const minimalFile = join(dir, 'minimal.yml')
  await writeFile(minimalFile, FIXTURE.replace(/- id: compaction[\s\S]*?\n\n(?=- id: delegation)/, ''), 'utf8')
  const userFile = join(dir, 'my-preset.yml')
  await writeFile(userFile, FIXTURE, 'utf8')
  const roster = diskRoster(dir, new Map([['standard', 'system'], ['minimal', 'system'], ['my-preset', 'user']] as const))
  const report = await cleanShippedPresets(roster)
  // minimal 无 stock → 跳过；user preset 永不触碰；standard 生成净化副本
  const bySource = new Map(report.outcomes.map(o => [o.source, o]))
  assert.equal(bySource.get('minimal')?.status, 'skipped')
  assert.equal(bySource.get('my-preset'), undefined)
  const std = bySource.get('standard')
  assert.equal(std?.status, 'created')
  assert.equal(std?.target, 'standard-argp')
  assert.deepEqual(std?.removed, ['compaction-basic', 'tool-result-pruner'])
  const cleanedText = await roster.read('standard-argp')
  assert.ok(!cleanedText.includes('dsh-compaction-basic'))
  assert.ok(cleanedText.includes('command-compact'))
  // 源文件逐字未动
  assert.equal(await readFile(standardFile, 'utf8'), FIXTURE)
  // 净化副本落盘
  const argpFile = join(dir, 'standard-argp.yml')
  assert.ok((await readFile(argpFile, 'utf8')).includes('command-compact'))
})

test('cleanShippedPresets is idempotent and heals drifted targets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'argp-preset-'))
  await writeFile(join(dir, 'standard.yml'), FIXTURE, 'utf8')
  const roster = diskRoster(dir, new Map([['standard', 'system']] as const))
  const first = await cleanShippedPresets(roster)
  assert.equal(first.outcomes[0]?.status, 'created')
  // 第二轮：副本已净 → already-clean，零写入
  const second = await cleanShippedPresets(roster)
  assert.equal(second.outcomes[0]?.status, 'already-clean')
  // 漂移自愈：向副本塞回一行 stock → healed 并再次摘除
  const targetFile = join(dir, 'standard-argp.yml')
  await writeFile(targetFile, (await readFile(targetFile, 'utf8')) + "    - id: compaction-basic\n      name: '@deepseek-ai/dsh-compaction-basic'\n", 'utf8')
  const third = await cleanShippedPresets(roster)
  assert.equal(third.outcomes[0]?.status, 'healed')
  assert.deepEqual(third.outcomes[0]?.removed, ['compaction-basic'])
  assert.ok(!(await roster.read('standard-argp')).includes('dsh-compaction-basic'))
})

test('cleanShippedPresets honors sources whitelist and reports unknown-source absence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'argp-preset-'))
  await writeFile(join(dir, 'standard.yml'), FIXTURE, 'utf8')
  const roster = diskRoster(dir, new Map([['standard', 'system']] as const))
  const report = await cleanShippedPresets(roster, { sources: ['minimal'] })
  assert.deepEqual(report.outcomes, [])
})
