/**
 * patch 组合不变量（P2-4c；2.0.0 零旋钮后保留 BR2）。
 *
 * 宿主实测锚点：profile 层 `- id: <插件>, config:` = **整块替换**该行 config
 * （vendor/include/src/index.ts:120-123，无深合并）；schema 缺席键不剥离不 throw。
 * 2.0.0 起六枚设置旋钮退役、static Config 为空集，原 BR1（旋钮 schema 缺省落位）
 * 随旋钮一并退役；保留 BR2 锁住挂载形态。
 *
 * 变异台账（摘锁必须变红）：
 *  BR2 patch 文件里往 dsh-argp 插 modify 行（duplicate loader entry id 事故形态）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')

test('BR2 patch 文件不变量：dsh-argp 只由 insert 行注册；MARK 段只 modify preset 行', () => {
  const begin = '# === ARGP preset overrides (GENERATED — do not edit by hand) ==='
  const end = '# === end ARGP preset overrides ==='
  assert.equal(patch.split(begin).length - 1, 1, 'GENERATED 段起止标记各恰一次')
  assert.equal(patch.split(end).length - 1, 1)
  const gen = patch.slice(patch.indexOf(begin), patch.indexOf(end))
  assert.ok(!/^- id: dsh-argp$/m.test(gen), 'GENERATED 段禁含 dsh-argp modify 行（对未入组合的 id 静默 no-op；对已入组合的重复注册 = duplicate loader entry id）')
  const modifyRows = [...gen.matchAll(/^- id: (\S+)$/gm)].map(m => m[1] as string)
  assert.ok(modifyRows.length >= 3 && modifyRows.every(id => id.startsWith('preset-')),
    'GENERATED 段只逐条 modify preset-* 行：实见 ' + modifyRows.join(', '))
  assert.ok(/^- insert:\n(?:^ {4}.*\n)*?^ {4}- id: dsh-argp$/m.test(patch),
    'dsh-argp 必须经顶层 insert 行注册（文件头注释：plain modify 行静默 no-op，引擎永不挂载）')
})
