/**
 * preset-cleaner 单元测试（0.1.7 版：patch-composition override）。
 *
 * 覆盖：
 * - 行手术的块边界（缩进/空行/注释归属）、幂等性、空组级联删除、无匹配原文返回
 *   （stripPresetRows / dropEmptyGroups / stripIsolateBlock，纯文本，不解析）；
 * - {@link purifyPresetPatch} 把 shipped preset 的 `- insert:` 声明转成顶层
 *   modify override 行（去缩进 4、丢弃包装与前导注释）、摘除 stock compaction
 *   行 + compaction 组 isolate、保留 command-compact 与其他组的 isolate、幂等；
 * - {@link toModifyRow} 的包装转换与无包装 no-op。
 * fixture 含 `!!js` 标签行，确保手术不触碰不解析的行。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { dropEmptyGroups, purifyPresetPatch, stripIsolateBlock, stripPresetRows, toModifyRow } from '../src/preset-cleaner.js'

/** composition 文本样例（standard 的结构等价，含 `!!js` 标签行）。 */
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
  "  disabled: !!js process.platform === 'win32'",
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

/** shipped preset patch 文件样例（含 `- insert:` 包装 + compaction/planning 两组）。 */
const PRESET_FIXTURE = [
  '# Agent preset standard: test fixture.',
  '- insert:',
  '    - id: preset-standard',
  "      name: '@deepseek-ai/dsh-agent-preset'",
  '      config:',
  '        id: standard',
  '        order: 1',
  '        plugins:',
  '          - id: persona',
  "            name: '@deepseek-ai/dsh-persona'",
  '          - id: planning',
  '            name: cordis:group',
  '            group: true',
  '            isolate:',
  '              planMode: true',
  '            config:',
  '              - id: plan-mode',
  "                name: '@deepseek-ai/dsh-plan-mode'",
  '          - id: compaction',
  '            name: cordis:group',
  '            group: true',
  '            isolate:',
  '              compaction: true',
  '              toolResultPruner: true',
  '            config:',
  '              - id: compaction-basic',
  "                name: '@deepseek-ai/dsh-compaction-basic'",
  '              - id: command-compact',
  "                name: '@deepseek-ai/dsh-command-compact'",
  '              - id: tool-result-pruner',
  "                name: '@deepseek-ai/dsh-compaction-tool-result-pruner'",
  '                config:',
  '                  thresholdChars: 8192',
].join('\n')

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

test('stripIsolateBlock removes the isolate block from the target group only', () => {
  const { text, removed } = stripIsolateBlock(FIXTURE, 'compaction')
  assert.ok(removed)
  assert.ok(!text.includes('isolate:'))
  assert.ok(!text.includes('toolResultPruner: true'))
  // 组结构保留（id/name/group/config 都在）
  assert.ok(text.includes('- id: compaction\n  name: cordis:group\n  group: true'))
  assert.ok(text.includes('config:'))
  assert.ok(text.includes('command-compact'))
  // 其他组不受影响
  assert.ok(text.includes('- id: delegation'))
  assert.ok(text.includes('- id: persona'))
})

test('stripIsolateBlock is a no-op when the group has no isolate block', () => {
  const noIsolate = FIXTURE.replace(/  isolate:\n    compaction: true\n    toolResultPruner: true\n/, '')
  const { text, removed } = stripIsolateBlock(noIsolate, 'compaction')
  assert.ok(!removed)
  assert.equal(text, noIsolate)
})

test('stripIsolateBlock is idempotent', () => {
  const once = stripIsolateBlock(FIXTURE, 'compaction')
  const twice = stripIsolateBlock(once.text, 'compaction')
  assert.equal(twice.text, once.text)
  assert.ok(!twice.removed)
})

test('stripIsolateBlock does not touch other groups\' isolate blocks', () => {
  // 构造一个含两个 isolate 组的 fixture：compaction + planning
  const multi = [
    '- id: compaction',
    '  name: cordis:group',
    '  group: true',
    '  isolate:',
    '    compaction: true',
    '  config:',
    '    - id: command-compact',
    "      name: '@deepseek-ai/dsh-command-compact'",
    '',
    '- id: planning',
    '  name: cordis:group',
    '  group: true',
    '  isolate:',
    '    planMode: true',
    '  config:',
    '    - id: plan-mode',
    "      name: '@deepseek-ai/dsh-plan-mode'",
    '',
  ].join('\n')
  const { text, removed } = stripIsolateBlock(multi, 'compaction')
  assert.ok(removed)
  // compaction 的 isolate 被摘除
  assert.ok(!text.includes('compaction: true'))
  // planning 的 isolate 保留
  assert.ok(text.includes('planMode: true'))
  assert.ok(text.includes('- id: planning'))
})

test('purifyPresetPatch converts - insert: to a top-level modify override row', () => {
  const { text, removed, changed } = purifyPresetPatch(PRESET_FIXTURE)
  assert.ok(changed)
  assert.deepEqual(removed, ['compaction-basic', 'tool-result-pruner', 'isolate:compaction'])
  // - insert: 包装消失；行变顶层
  assert.ok(!text.includes('- insert:'))
  assert.ok(text.startsWith('- id: preset-standard\n'))
  // name/config 逐字段重述（override 整体替换 config）
  assert.ok(text.includes("  name: '@deepseek-ai/dsh-agent-preset'"))
  assert.ok(text.includes('  config:'))
  assert.ok(text.includes('    id: standard'))
  assert.ok(text.includes('    order: 1'))
  // 去缩进 4：plugins 项落到 column 6
  assert.ok(text.includes('      - id: persona'))
  assert.ok(text.includes('        name:'))
})

test('purifyPresetPatch strips stock compaction + compaction isolate but keeps command-compact and other groups\' isolate', () => {
  const { text } = purifyPresetPatch(PRESET_FIXTURE)
  // stock compaction 行消失
  assert.ok(!text.includes('dsh-compaction-basic'))
  assert.ok(!text.includes('tool-result-pruner'))
  assert.ok(!text.includes('thresholdChars'))
  // compaction 组的 isolate 消失（compaction: true / toolResultPruner: true 不再出现）
  assert.ok(!text.includes('toolResultPruner: true'))
  // command-compact 保留（/compact 将沿 scope 链回落到宿主 ARGP）
  assert.ok(text.includes('- id: command-compact'))
  // compaction 组仍在（command-compact 幸存，非空组）
  assert.ok(text.includes('- id: compaction'))
  // planning 组的 isolate 保留（各自服务的正确生命周期隔离，不能动）
  assert.ok(text.includes('planMode: true'))
  assert.ok(text.includes('- id: planning'))
})

test('purifyPresetPatch is idempotent', () => {
  const once = purifyPresetPatch(PRESET_FIXTURE)
  const twice = purifyPresetPatch(once.text)
  assert.equal(twice.text, once.text)
  assert.ok(!twice.changed)
  assert.deepEqual(twice.removed, [])
})

test('purifyPresetPatch is a no-op for an already-clean preset', () => {
  const clean = purifyPresetPatch(PRESET_FIXTURE).text
  const result = purifyPresetPatch(clean)
  assert.ok(!result.changed)
  assert.equal(result.text, clean)
})

test('toModifyRow de-indents the - insert: wrapped row and drops the wrapper + leading comments', () => {
  const out = toModifyRow(PRESET_FIXTURE)
  assert.ok(!out.includes('- insert:'))
  assert.ok(!out.startsWith('#'))
  assert.ok(out.startsWith('- id: preset-standard\n'))
  assert.ok(out.includes("  name: '@deepseek-ai/dsh-agent-preset'"))
  assert.ok(out.includes('    id: standard'))
})

test('toModifyRow is a no-op when there is no - insert: wrapper', () => {
  const modifyRow = '- id: preset-standard\n  name: x\n  config:\n    id: standard'
  assert.equal(toModifyRow(modifyRow), modifyRow)
})
