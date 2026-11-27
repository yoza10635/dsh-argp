#!/usr/bin/env node
/**
 * 变异台账复核器（测试体系审计 T2，2026-11-27）。
 *
 * 病灶：变异重跑脚本一直在仓外（一次性探针），而「EV-x 已逐条执行 ⇒ 摘锁必红」这类
 * 声称写进了几十个测试文件头注——没有任何仓内机制能复跑它们，实测已腐烂一条
 * （EV1 声称摘除守卫必红，现场摘除后 436 例全绿）。**「测试全绿」不是验证，
 * 能被重放的失败才是。**
 *
 * 契约：读 `test/mutation-ledger.json`（`[{id, file, from, to, all?, expectTest,
 * expectCase, expectKill?}]`），逐条施加源码变异 → **只跑 expectTest 文件** → 断言失败
 * 子用例中必须出现 `expectCase`（红且红对地方；整文件红但目标用例绿 = MISSING-CASE，
 * 同样不算杀死）→ 无论断言成败逐字节还原（finally + process exit 兜底）。
 * 锚点未命中 = ANCHOR-MISS（源码漂移，台账本身失效）⇒ 也算失败。
 * `expectKill: false` 登记**已论证的等价变异**（守卫是深度防御、摘除无行为差）：
 * 存活=通过；被杀死=失败（说明冗余层变了，等位论证失效、该重新审视判别面或守卫）。
 * 这类条目仍然值回票价——锚点漂移检测对守卫被重构删除一样报警。
 * 验收：`npm run mutate` 输出 `NOT-RED: 0`（非零全灭 exit 1）。
 * 位置：进 `prerelease:check`（发布前必跑），**不进 push CI**（发布节奏门禁，
 * 不是每次 push 的回归面）。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LEDGER = path.join(ROOT, 'test', 'mutation-ledger.json')
const entries = JSON.parse(readFileSync(LEDGER, 'utf8'))

// 变异跑测必须在全缺省世界：宿主 env 策略旋钮（ARGP_*）改判据 ⇒ 杀红口径漂移。
const env = { ...process.env }
for (const k of Object.keys(env)) {
  if (k.startsWith('ARGP_')) delete env[k]
}

/** 当前在飞的还原动作（异常/中断兜底：process exit 前把文件写回原字节）。 */
const live = []
const restoreAll = () => {
  while (live.length > 0) {
    const { file, bytes } = live.pop()
    try { writeFileSync(file, bytes) } catch { /* 尽力还原 */ }
  }
}
process.on('exit', restoreAll)

let notRed = 0
for (const e of entries) {
  const file = path.join(ROOT, e.file)
  const original = readFileSync(file)
  const src = original.toString('utf8')
  // 多行锚点的 EOL 变体：台账按 LF 记账，工作区文件可能是 CRLF（编辑器/平台差异），
  // 两者都算命中；替换用命中的那个变体，还原走字节级 backup 不受影响。
  const eolPair = (s) => [s, s.includes('\n') ? s.replace(/\n/g, '\r\n') : null].filter(Boolean)
  const fromVar = eolPair(e.from).find(v => src.includes(v))
  const toVar = fromVar === undefined ? null : eolPair(e.to).find(v => v.length - v.replace(/\n/g, '').length === fromVar.length - fromVar.replace(/\n/g, '').length) ?? e.to
  if (fromVar === undefined) {
    console.log(`ANCHOR-MISS ${e.id}\n      ${e.file}: 锚点未命中（源码已漂移，台账需更新）`)
    notRed += 1
    continue
  }
  const mutated = e.all === true ? src.split(fromVar).join(toVar) : src.replace(fromVar, toVar)
  live.push({ file, bytes: original })
  try {
    writeFileSync(file, mutated)
    const r = spawnSync(process.execPath, [
      '--import', './scripts/ts-import-rewrite-loader.mjs', '--test', '--test-reporter=tap', e.expectTest,
    ], { cwd: ROOT, encoding: 'utf8', env, timeout: 300_000 })
    const out = (r.stdout ?? '') + (r.stderr ?? '')
    const failedCases = [...out.matchAll(/^ *not ok \d+ - (.+?)(?: \(|\n)/gm)].map(m => m[1].trim())
    const killed = failedCases.some(name => name.includes(e.expectCase))
    if (e.expectKill === false) {
      if (killed) {
        console.log(`SURVIVOR-BROKEN ${e.id}\n      登记为等价变异却红了「${e.expectCase}」——冗余层论证已失效，重审判别面`)
        notRed += 1
      } else {
        console.log(`SURVIVES  ${e.id}（登记的等价变异：深度防御，无行为差）`)
      }
    } else if (killed) {
      console.log(`RED       ${e.id}`)
    } else if (r.status === 0) {
      console.log(`NOT-RED   ${e.id}\n      ${e.expectTest} 全绿——锁面不判别该守卫（或测试腐烂）`)
      notRed += 1
    } else {
      console.log(`MISSING-CASE ${e.id}\n      ${e.expectTest} 红了但失败用例里没有「${e.expectCase}」：${failedCases.slice(0, 4).join(' | ') || '(未解析到子用例失败)'}}`)
      notRed += 1
    }
  } finally {
    restoreAll()
  }
}

console.log(`\nNOT-RED: ${notRed}（共 ${entries.length} 条台账）`)
process.exit(notRed === 0 ? 0 : 1)
