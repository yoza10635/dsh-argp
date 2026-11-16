/**
 * preset 补丁数据不变量锁：issue #3（不可解析包子路径 ⇒ never started）+
 * issue #4（宿主 schema 外幽灵键 ⇒ 非 strict zod 静默剥离、配置无声失效）。
 *
 * 事故形态（报告者真机实证）：条目 `@deepseek-ai/dsh-tool-subagent-control/list-agents`
 * 在该包 exports（`. / ./src/* / ./package.json / ./locale/*.json`）里不存在，
 * preset 组装抛 `agent-preset/invalid … never started` ⇒ **新建会话整体失败**，
 * 已有会话不受影响。宿主对"包整个缺席"宽容跳过，对"包在、子路径解析失败"严格报错——
 * 所以装树里没有 subagent-control 的开发环境永远不会替你拦住这行。
 *
 * 本文件是数据不变量断言（变异验证：恢复毒行 ⇒ 红）。删掉本测试或往 preset 塞回
 * 任何子路径条目都必须先确认目标包 exports 真的有那个子路径。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
const names = [...patch.matchAll(/^\s+name: '(@[^']+)'$/gm)].map(m => m[1])

/** 已逐包核实过 exports 确实含该子路径的白名单（核实日期与依据写在注释里）。
 *  新增子路径条目必须先把目标包装进临时目录、读 package.json exports 核对，再把条目加进来。 */
const ALLOWED_SUBPATHS = new Set([
  // '@deepseek-ai/dsh-plugin-manager' 0.2.2-rc.1 exports 实载含 "./tools"（2026-09 preset 设计如此，2026-11-09 复核实）
  '@deepseek-ai/dsh-plugin-manager/tools',
  // '@deepseek-ai/dsh-plugin-market' rc.3 出厂 standard/cordis/ptc 自带此行；
  // packages/boot/plugin-market/package.json exports 实载 "./tools"（2026-11-16 对 rc.3 检出核实的）
  '@deepseek-ai/dsh-plugin-market/tools',
])

test('preset 不许出现未核实的包子路径条目（issue #3 毒行 never started 教训）', () => {
  assert.ok(names.length > 50, 'name 抽取本身要有效（防正则空转）：实抽 ' + names.length + ' 条')
  const unverified = names.filter(n => n.split('/').length > 2 && !ALLOWED_SUBPATHS.has(n)) // @scope/pkg 之外的更深路径
  assert.deepEqual(unverified, [], '出现未核实的子路径条目：' + unverified.join(', ') + '——目标包 exports 未必含之（list-agents 即前车之鉴），核实 exports 后加入白名单或删除')
})

test('delegation 组三 preset 完整：control 与 subagent 各 3 处，list-agents 残留为 0', () => {
  assert.equal(patch.includes('tool-subagent-list-agents'), false, 'list-agents 毒行被塞回来了')
  assert.equal((patch.match(/id: tool-subagent-control/g) ?? []).length, 3, 'tool-subagent-control 应恰好 3 处（standard/cordis/ptc）')
  assert.equal((patch.match(/^ {10}- id: tool-subagent$/gm) ?? []).length, 3, 'tool-subagent 应恰好 3 处')
})

test('幽灵键锁（issue #4 教训）：宿主 schema 外键禁入，modelSelection×3 与出厂对齐', () => {
  // modelSelectionSettings / backgroundMode 是 1.7.0-beta 时代快照从当时宿主 preset 拷来的
  // 幽灵键，宿主 schema 其后改名/删除（tool-subagent src/index.ts Config：modelSelection）。
  // 非 strict zod 静默剥离未知键 ⇒ 配置无声失效（subagent 模型选择就此丢了三轮版本）。
  // 快照过期就红在这里：重生成对齐后变绿（变异验证：塞回幽灵键 ⇒ 红）。
  assert.equal(patch.includes('modelSelectionSettings'), false, '幽灵键 modelSelectionSettings 溜回来了（正键 = modelSelection）')
  assert.equal(patch.includes('backgroundMode'), false, 'backgroundMode 已不在宿主 tool-subagent schema（幽灵键）')
  assert.equal((patch.match(/^ {14}modelSelection: true$/gm) ?? []).length, 3, '三 preset 的 tool-subagent 行须带 modelSelection: true（rc.3 出厂对齐）')
})
