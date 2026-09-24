#!/usr/bin/env node
/**
 * dsh-argp boot doctor —— 兼容性预检的「静默跳过」探测器。
 *
 * 背景（宿主 **0.1.7-rc.1** 引入；**0.1.7-alpha.2 及更早无此机制**）：宿主启动时对
 * profile 的每个 **bundle** 跑 `evaluatePluginCompatibility`——把 bundle manifest 里
 * `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 的 peerDependencies 逐一用
 * `semver.satisfies(运行时版本, range, { includePrerelease: true })` 对照当前运行时；
 * 任一 peer 不满足且无精确版本豁免 ⇒ 该 bundle 的 patch 层**不应用**，宿主只在
 * stderr 打一行 `skipping profile bundle …` 就照常启动。
 *
 * 机制出处（可在任意 0.1.7-rc.1 检出中直接读到，**不依赖 PR 号**——本检出是镜像/
 * fork，其 commit message 里的 PR 号在规范仓库上解析到别的内容，故不引用）：
 *   packages/boot/app-boot/src/plugin-compatibility.ts    （evaluatePluginCompatibility）
 *   packages/boot/app-boot/src/profile-compatibility.ts   （compatibility.json 精确豁免）
 *   packages/boot/app-boot/src/compatibility-preflight.ts （profile/preset 行准入）
 *   packages/boot/app-boot/src/profile.ts                 （loadProfileDirectory 的 bundle 准入）
 * ⚠️ 该机制在**源码**里；若某检出的 `lib/`（gitignored 构建产物）切到 rc.1 后未重新构建，
 * 则实际运行的 `dsh`（bin 指向 lib/）仍是预检前的行为。本 doctor 判定的是**源码声明的
 * rc.1 契约**，与"当前这个检出是否已重新构建 lib/"无关。
 *
 * 关键事实（本 doctor 存在的原因）：**bundle 被跳过时，dsh-argp 的代码根本不会被
 * 加载**——所以「构造期自检」在它要探测的那个场景里永远不会执行。唯一能在
 * 「压缩悄悄不生效」时给出诊断的，是一个**独立于插件是否被加载**的诊断器。
 *
 * 本脚本正是这个诊断器：它**不复用**插件运行时，而是
 *   1) 从你指定的 dsh 安装里找到宿主实际使用的 `semver`（保证与宿主判定逐字节一致，
 *      尤其是 prerelease 序 `rc > alpha` 这类微妙点）；
 *   2) 逐字复刻宿主 `evaluatePluginCompatibility` 的判定逻辑（见 plugin-compatibility.ts）；
 *   3) 对给定的 dsh-argp manifest 报告「准入 / 将被跳过」，跳过时给出宿主同款
 *      `dsh plugin allow-version … --accept-risk` 补救命令。
 *
 * 用法：
 *   node scripts/doctor.mjs --dsh <dsh 安装根>            # 推荐：自动读版本 + 找 semver
 *   node scripts/doctor.mjs --dsh <根> --dsh-version 0.1.7-rc.1   # 覆盖要检查的版本
 *   node scripts/doctor.mjs --dsh <根> --manifest <pkg.json>      # 检查指定 manifest
 *   node scripts/doctor.mjs --dsh <根> --profile web             # 补救命令带 --profile
 *
 * 退出码：0 = 准入（无需豁免）；1 = 将被跳过（需豁免）；2 = 用法/环境错误。
 * CI 友好：`node scripts/doctor.mjs --dsh <根>` 在升级宿主后跑一遍即可守住准入。
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, resolve, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const SCRIPT_DIR = fileURLToPath(new URL('..', import.meta.url))

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--dsh') out.dsh = argv[++i]
    else if (a === '--dsh-version') out.dshVersion = argv[++i]
    else if (a === '--manifest') out.manifest = argv[++i]
    else if (a === '--profile') out.profile = argv[++i]
    else if (a === '--help' || a === '-h') out.help = true
    else out._.push(a)
  }
  return out
}

function usage() {
  return [
    'dsh-argp boot doctor — 检测 dsh-argp 是否会被宿主兼容性预检静默跳过',
    '',
    '用法:',
    '  node scripts/doctor.mjs --dsh <dsh 安装根> [--dsh-version <v>] [--manifest <pkg.json>] [--profile <name>]',
    '  （--dsh 必填；其余可选）',
    '',
    '选项:',
    '  --dsh <path>        [必填] dsh 宿主安装根（monorepo 源码检出或已发布安装）。',
    '                      脚本从它读取运行时版本，并定位宿主实际使用的 semver。',
    '  --dsh-version <v>   要对照的 dsh 版本（缺省 = 从 --dsh 安装读取）。',
    '                      用于检查「未来/其它」版本下的准入，无需真的装那个版本。',
    '  --manifest <path>   要检查的 dsh-argp package.json（缺省 = 本仓库的）。',
    '  --profile <name>    补救命令里的 --profile（仅影响提示文案）。',
    '',
    '退出码: 0 = 准入；1 = 将被跳过；2 = 用法/环境错误。',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// 从 dsh 安装里定位 semver（宿主 app-boot 声明 ^7.8.5）
//   覆盖三种布局：flat npm / pnpm 虚拟存储 / workspace 符号链接。
//   取版本最高者，保证与宿主实际加载的一致。
// ---------------------------------------------------------------------------
function findSemver(dshRoot) {
  const candidates = []
  const flat = join(dshRoot, 'node_modules', 'semver')
  if (existsSync(flat)) candidates.push(flat)
  const pnpm = join(dshRoot, 'node_modules', '.pnpm')
  if (existsSync(pnpm)) {
    for (const entry of readdirSync(pnpm)) {
      if (entry.startsWith('semver@')) {
        const dir = join(pnpm, entry, 'node_modules', 'semver')
        if (existsSync(dir)) candidates.push(dir)
      }
    }
  }
  const ws = join(dshRoot, 'packages', 'boot', 'app-boot', 'node_modules', 'semver')
  if (existsSync(ws)) candidates.push(ws)

  // 取版本最高且可加载者。用**加载到的 semver 自带的 gt** 做版本比较（完整 semver
  // 优先级，正确处理 prerelease：7.8.5 > 7.8.5-alpha、7.8.5 > 7.7.4），而非手写三段
  // 数值比较（后者把 7.8.5 与 7.8.5-alpha 视为相等，同存两版时选择是未定义序）。
  let best = null
  for (const dir of [...new Set(candidates)]) {
    let version
    try { version = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version } catch { continue }
    let semver
    try { semver = createRequire(join(dir, 'package.json'))('semver') } catch { continue }
    if (typeof semver.satisfies !== 'function') continue
    if (best === null || semver.gt(version, best.version)) best = { semver, path: dir, version }
  }
  return best
}

// ---------------------------------------------------------------------------
// 从 dsh 安装读取运行时版本
//   monorepo 源码检出: packages/boot/app-boot/package.json
//   已发布安装:       node_modules/@deepseek-ai/dsh-app-boot/package.json
// ---------------------------------------------------------------------------
function readDshVersion(dshRoot) {
  const candidates = [
    join(dshRoot, 'packages', 'boot', 'app-boot', 'package.json'),
    join(dshRoot, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'package.json'),
    join(dshRoot, 'package.json'),
  ]
  for (const p of candidates) {
    if (!existsSync(p)) continue
    try {
      const pkg = JSON.parse(readFileSync(p, 'utf8'))
      // 只认 app-boot 包或名为 dsh 的根包，避免误读无关 package.json
      if (pkg.name === '@deepseek-ai/dsh-app-boot' || pkg.name === 'dsh' || pkg.name === 'deepseek-harness') {
        if (typeof pkg.version === 'string') return pkg.version
      }
    } catch {
      // 尝试下一个
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// 逐字复刻宿主 evaluatePluginCompatibility 的判定（plugin-compatibility.ts）
//   返回 { peers, name, version }：peers 为空 = 准入。
// ---------------------------------------------------------------------------
function evaluatePluginCompatibility(manifest, runtimeVersion, semver) {
  if (typeof manifest !== 'object' || manifest === null) throw new Error('manifest must be an object')
  if (!Object.hasOwn(manifest, 'peerDependencies')) return { peers: {}, name: manifest.name, version: manifest.version }
  const dependencies = manifest.peerDependencies
  if (typeof dependencies !== 'object' || dependencies === null || Array.isArray(dependencies)) {
    throw new Error('peerDependencies must be an object')
  }
  const peers = {}
  for (const [name, range] of Object.entries(dependencies)) {
    if (typeof range !== 'string') throw new Error(`peerDependencies[${name}] must be a string`)
    // 宿主只检查 dsh 系 peer；cordis / schemastery 等不在准入范围
    if (name !== '@deepseek-ai/dsh' && !name.startsWith('@deepseek-ai/dsh-')) continue
    const requirement = ['workspace:^', 'workspace:~', 'workspace:*'].includes(range) ? runtimeVersion : range
    if (requirement.trim() === '' || !semver.satisfies(runtimeVersion, requirement, { includePrerelease: true })) {
      peers[name] = range
    }
  }
  return { peers, name: manifest.name, version: manifest.version }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(usage())
    return 0
  }

  // 1) 定位 dsh 安装 + semver
  let dshRoot = args.dsh
  if (!dshRoot) {
    console.error('error: 缺少 --dsh <dsh 安装根>（脚本需从它读取运行时版本并定位宿主实际使用的 semver）')
    console.error('')
    console.error(usage())
    return 2
  }
  dshRoot = resolve(isAbsolute(dshRoot) ? dshRoot : process.cwd(), dshRoot)
  if (!existsSync(dshRoot)) {
    console.error(`error: --dsh 路径不存在: ${dshRoot}`)
    return 2
  }
  const found = findSemver(dshRoot)
  if (!found) {
    console.error(`error: 在 ${dshRoot} 里找不到可用的 semver（宿主 app-boot 依赖它做准入判定）`)
    console.error('       确认 --dsh 指向的是完整安装（含 node_modules）。')
    return 2
  }

  // 2) 确定要对照的 dsh 版本
  const runtimeVersion = args.dshVersion ?? readDshVersion(dshRoot)
  if (!runtimeVersion) {
    console.error(`error: 无法从 ${dshRoot} 读取 dsh 版本；请显式传 --dsh-version <v>`)
    return 2
  }
  if (!found.semver.valid(runtimeVersion)) {
    console.error(`error: dsh 版本 "${runtimeVersion}" 不是合法 semver`)
    return 2
  }

  // 2.5) 机制适用性：兼容性预检是 0.1.7-rc.1 才引入的。对照版本早于它时，
  //      宿主根本没有这道准入检查——bundle 不会因 peer 不兼容被跳过，
  //      下面的"准入"结论是空真（vacuous），提示以免误读。
  if (found.semver.lt(runtimeVersion, '0.1.7-rc.1')) {
    console.log(`⚠️  dsh ${runtimeVersion} 早于 0.1.7-rc.1——兼容性预检机制尚不存在。`)
    console.log(`    该宿主不会因 peer 不兼容跳过 bundle；本次"准入"结论是空真，`)
    console.log(`    不代表对 0.1.7-rc.1+ 的准入。要检查未来准入请用 --dsh-version 0.1.7-rc.1 或更高。`)
    console.log('')
  }

  // 3) 读取要检查的 dsh-argp manifest
  const manifestPath = args.manifest
    ? resolve(isAbsolute(args.manifest) ? args.manifest : process.cwd(), args.manifest)
    : join(SCRIPT_DIR, 'package.json')
  if (!existsSync(manifestPath)) {
    console.error(`error: manifest 不存在: ${manifestPath}`)
    return 2
  }
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    console.error(`error: manifest 不是合法 JSON: ${error.message}`)
    return 2
  }

  // 4) 判定
  let result
  try {
    result = evaluatePluginCompatibility(manifest, runtimeVersion, found.semver)
  } catch (error) {
    console.error(`error: manifest 的 peerDependencies 形状非法: ${error.message}`)
    return 2
  }

  const { name, version, peers } = result
  const key = `${name}@${version}`
  const peerCount = Object.keys(manifest.peerDependencies ?? {}).filter(
    (n) => n === '@deepseek-ai/dsh' || n.startsWith('@deepseek-ai/dsh-'),
  ).length

  console.log(`dsh-argp boot doctor`)
  console.log(`  manifest   : ${key}  (${manifestPath})`)
  console.log(`  dsh runtime: ${runtimeVersion}  (semver ${found.version} @ ${found.path})`)
  console.log(`  dsh peers  : ${peerCount} 个 @deepseek-ai/dsh* peer 受准入检查`)
  console.log('')

  if (Object.keys(peers).length === 0) {
    console.log(`✅ 准入：${key} 与 dsh ${runtimeVersion} 兼容，所有 dsh peer 均满足。`)
    console.log(`   无需豁免；bundle 的 patch 层会被正常应用，dsh-argp 会加载。`)
    return 0
  }

  console.log(`❌ 将被跳过：${key} 与 dsh ${runtimeVersion} 不兼容。`)
  console.log(`   不满足的 peer：`)
  for (const [p, range] of Object.entries(peers)) {
    console.log(`     - ${p}: "${range}"  不满足运行时 ${runtimeVersion}`)
  }
  console.log('')
  console.log(`   后果：宿主启动时该 bundle 的 patch 层不应用，dsh-argp 不会加载，`)
  console.log(`         压缩/剪枝静默失效——宿主只在 stderr 打一行 "skipping profile bundle"。`)
  console.log('')
  const profileFlag = args.profile ? ` --profile ${args.profile}` : ''
  console.log(`   若确认要承担该风险，授予精确版本豁免（宿主同款命令）：`)
  console.log(`     dsh plugin${profileFlag} allow-version ${key} --dsh-version ${runtimeVersion} --accept-risk`)
  console.log(`   或升级 dsh-argp 到与该 dsh 运行时兼容的版本（推荐）。`)
  return 1
}

process.exit(main())
