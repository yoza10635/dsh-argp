#!/usr/bin/env node
/**
 * 死代码棘轮（测试体系审计 T5，2026-11-27）。
 *
 * 病灶：`noUnusedLocals/noUnusedParameters` 在常设 tsconfig 里是关的（一开即数十处
 * 历史告警，宿主 peer 类型下还误报），于是「新写的死 import / 死参数」没有任何门禁
 * 会拦。本脚本**临时**开着这两面旗跑一遍 tsc（build 作用域 = src），只数 unused 类
 * 错误码（TS6133/TS6192/TS6196/TS6198），基线 8 ⇒ 只许减不许增：新增一枚即红。
 * 清偿存量后可下调 `BASELINE`；降到 0 时请直接开常设旗并删本脚本。
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BASELINE = 8

const r = spawnSync(process.execPath, [
  path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
  '-p', path.join(ROOT, 'tsconfig.build.json'),
  '--noEmit', '--noUnusedLocals', '--noUnusedParameters',
], { cwd: ROOT, encoding: 'utf8' })

const out = (r.stdout ?? '') + (r.stderr ?? '')
const unused = out.split(/\r?\n/).filter(l => /error TS(6133|6192|6196|6198)/.test(l))
const other = out.split(/\r?\n/).filter(l => l.includes('error TS') && !/error TS(6133|6192|6196|6198)/.test(l))

if (other.length > 0) {
  console.error(`tsc-ratchet: build 作用域出现非 unused 类错误 ${other.length} 条（先修编译，棘轮不谈）：`)
  for (const l of other.slice(0, 10)) console.error('  ' + l)
  process.exit(1)
}
if (unused.length > BASELINE) {
  console.error(`tsc-ratchet: unused 告警 ${unused.length} > 基线 ${BASELINE}（只许减不许增）。新增项：`)
  for (const l of unused.slice(0, 30)) console.error('  ' + l)
  process.exit(1)
}
console.log(`tsc-ratchet: unused ${unused.length} / 基线 ${BASELINE}（存量待清，新增即红）`)
