/**
 * 2.0 旋钮 × patch 整块替换语义（design-2.0 §3.4；P2-4c）。
 *
 * 组合语义（宿主实测锚点）：
 *  - profile 层 `- id: <插件>, config:` = **整块替换**该行的 config
 *    （vendor/include/src/index.ts:120-123 `target[key] = value`，无深合并；
 *    web-app cordis.patch.yml:5-6 注释同文）；
 *  - 层序 bundle → profile → home/CLI，后写赢（packages/boot/app-boot/src/profile.ts:8-14）；
 *  - schema 缺席键**不剥离不 throw**（非 strict merge，vendor/schemastery index.ts:821），
 *    缺省字段回 static Config default（:815-819）。
 *  ⇒ factor 旋钮的"缺省即健康"必须落在**代码/schema 缺省**（peratom opt-out 先例同一
 *  防线）：exp profile 只写 engine + 想改的键，其余被整块冲掉后必须回 schema 缺省，
 *  绝不允许"bundle insert 行独家持有缺省"。
 *
 * 变异台账（摘锁必须变红，逐条执行）：
 *  BR1 把 vocabTopN 的 schema 缺省挪走（改 static Config default 或删除 ⇒ 组合面失配）；
 *  BR2 patch 文件里往 dsh-argp 插 modify 行（duplicate loader entry id 事故形态）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ArgpGraphEngine } from '../src/argp-graph-engine.ts'

const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')

/**
 * 宿主 applyEntryPatches 的最小忠实镜像：modify 行逐 key 覆盖目标行，`config` 整体
 * 赋值（无 merge）；insert 行按 id 入索引供后续 modify 命中。
 */
function composeRows(layers: Array<Array<Record<string, unknown>>>): Map<string, Record<string, unknown>> {
  const rows = new Map<string, Record<string, unknown>>()
  for (const layer of layers) for (const row of layer) {
    const id = String(row.id)
    if (row.insert !== undefined) {
      for (const ins of row.insert as Array<Record<string, unknown>>) rows.set(String(ins.id), structuredClone(ins))
      continue
    }
    const target = rows.get(id)
    if (target === undefined) continue // 宿主：entry not found → 静默 no-op（patch 文件头注释的前车之鉴）
    for (const [key, value] of Object.entries(row)) {
      if (key === 'id') continue
      target[key] = value
    }
  }
  return rows
}

test('BR1 整块替换语义：exp profile 只写 engine+focalTurns ⇒ 其余回 schema 缺省、旧 bundle 值如实丢失', async () => {
  const bundleRow = [{
    insert: [{ id: 'dsh-argp', name: 'dsh-argp', config: { maxPasses: 256, recencyGuard: 10 } }],
  }]
  const expProfile = [{ id: 'dsh-argp', name: 'dsh-argp', config: { engine: 'factor', focalTurns: 2 } }]
  const composed = composeRows([bundleRow, expProfile]).get('dsh-argp')
  assert.ok(composed !== undefined)
  const config = composed.config as Record<string, unknown>
  // 整块替换的如实面貌（不是期待，是语义）：bundle insert 持有的 graph 值被冲掉。
  assert.deepEqual(Object.keys(config).sort(), ['engine', 'focalTurns'])
  // 缺省即健康：冲掉的键经 static Config resolve 全部回 schema 缺省。
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: 'block replace persona' } })
  const warns: string[] = []
  const logger = ctx.logger as unknown as { warn: (m: string) => void }
  const real = logger.warn.bind(ctx.logger)
  logger.warn = (m: string): void => { warns.push(m); real(m) }
  await ctx.plugin(ArgpGraphEngine, config as never)
  const internals = ctx.compaction as unknown as {
    factor: { vocabulary(s: never): { text?: string } } | null
  }
  assert.ok(internals.factor !== null, 'engine=factor 生效（组合后的 config 直达判别式）')
  // vocabTopN 无 profile 值 ⇒ schema 缺省 10（若缺省只写在 bundle insert 行，此处已悬空）。
  const live = (ctx.compaction as unknown as { args: { vocabTopN: { get(): number }; recallLimit: { get(): number } } }).args
  assert.equal(live.vocabTopN.get(), 10, 'factor 缺省必须住在 schema，不靠 patch 行')
  assert.equal(live.recallLimit.get(), 5)
  // 整块替换把老键冲没 ⇒ 宽容读面无痕：不误报"旧键被忽略"。
  assert.ok(!warns.some(w => w.includes('[argp-factor]')), '键被冲掉 ≠ 用户写了老键，不得告警')
})

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
