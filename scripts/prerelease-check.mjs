// prerelease-check.mjs — 发布前置闸门 + tag 创建（P0.2 release 加固）
//
// 用法:
//   node scripts/prerelease-check.mjs            # 只检查：脏树 + 目标 tag 状态（release 流程第一步）
//   node scripts/prerelease-check.mjs --tag     # 检查通过后创建 annotated tag v<version>（幂等）
//
// 为什么用 spawnSync 而不是 shell:
//   旧 release 脚本 `git tag v$(node -p …)` 在 Windows cmd 下 $(…) 不展开（已实际踩坑），
//   且 `npm publish && git tag && git push` 三段 && 非原子：npm publish 先成功且不可重发，
//   随后 git tag 因 tag 已存在报 fatal、&& 链中断 ⇒ "npm 已发布但 tag/push 未完成"的半发布死局。
//   本脚本全部 git 调用走 spawnSync（直接 argv，不经 shell），version 用 fs 直读 package.json，
//   Windows cmd / Git Bash / Linux 行为完全一致，彻底避免 shell 展开问题。
//
// release 流程（package.json 的 "release"）:
//   prerelease:check → --tag → npm publish → git push origin main --tags
//   把不可逆的 npm publish 放到可逆的 tag 之后:
//     - tag 不存在        → 创建 annotated tag（指向当前 HEAD）
//     - tag 已存在且指向 HEAD → 幂等跳过创建（上次 publish 失败的重跑场景，本次直接补完发布）
//     - tag 已存在但指向旧提交 → 拒绝（残留 tag，先删或 bump version）
//     - publish 之后唯一可能失败的是 push，可原样重跑，不再产生死局
//   脏树拒绝发布：npm publish 打包工作树、tag 指向 HEAD，脏树时二者分叉。
//
// 退出码: 0 = 通过 / tag 创建（或幂等跳过）成功；1 = 脏树 / 残留 tag / git 失败
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const wantTag = process.argv.includes('--tag')

function git(args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  if (r.error) {
    console.error(`[prerelease] 无法执行 git ${args.join(' ')}: ${r.error.message}`)
    process.exit(1)
  }
  return {
    status: r.status === null ? -1 : r.status,
    stdout: (r.stdout ?? '').trim(),
    stderr: (r.stderr ?? '').trim(),
  }
}

function fail(msg) {
  console.error(`[prerelease] ${msg}`)
  process.exit(1)
}

// ── 1) 脏树检查：npm publish 打包工作树，tag 指向 HEAD，脏树时二者分叉 ──
const status = git(['status', '--porcelain'])
if (status.status !== 0) fail(`git status 失败: ${status.stderr}`)
if (status.stdout.length > 0) {
  console.error('[prerelease] 工作树不干净，拒绝发布（npm publish 打包工作树，tag 指向 HEAD，二者会分叉）:')
  for (const line of status.stdout.split('\n').filter(Boolean)) console.error('   ' + line)
  console.error('   → 先提交或暂存全部变更（含未跟踪文件），再运行 npm run release')
  process.exit(1)
}

// ── 2) version：fs 直读 package.json，不依赖 shell 的 $(node -p …) 展开 ──
let version
try {
  version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
} catch (e) {
  fail(`读取 package.json 的 version 失败: ${e.message}`)
}
if (typeof version !== 'string' || !/^\d+\.\d+\.\d+/.test(version)) {
  fail(`package.json 的 version 非法: ${String(version)}`)
}
const tag = `v${version}`

// ── 3) 目标 tag 状态 ──
const head = git(['rev-parse', 'HEAD'])
if (head.status !== 0) fail(`git rev-parse HEAD 失败: ${head.stderr}`)
const verify = git(['rev-parse', '-q', '--verify', `refs/tags/${tag}`])
const tagExists = verify.status === 0
let tagCommit = null
if (tagExists) {
  const peel = git(['rev-parse', `refs/tags/${tag}^{commit}`])
  if (peel.status !== 0) fail(`解析 tag ${tag} 指向的 commit 失败: ${peel.stderr}`)
  tagCommit = peel.stdout
}

if (tagExists && tagCommit !== head.stdout) {
  // 残留 tag：指向的 commit 不是当前 HEAD
  console.error(`[prerelease] 目标 tag ${tag} 已存在，但指向 ${tagCommit}，而当前 HEAD 是 ${head.stdout}（残留 tag）:`)
  console.error(`   - 若 ${version} 尚未 npm publish：删除残留 tag 后重试 → git tag -d ${tag} && npm run release`)
  console.error(`     （若该 tag 已推送到远端，还需 → git push origin :refs/tags/${tag}）`)
  console.error(`   - 若 ${version} 已 npm publish：不要删 tag 重发（npm 不可重发同版本），bump package.json 的 version 后重新走 release`)
  process.exit(1)
}

if (wantTag) {
  if (tagExists) {
    console.log(`[prerelease] tag ${tag} 已存在且指向 HEAD，幂等跳过创建（若该版本已发布，npm publish 会被 npm 拒绝；若是上次 publish 失败残留，本次将补完发布）`)
  } else {
    const r = git(['tag', '-a', tag, '-m', `release: ${tag}`])
    if (r.status !== 0) fail(`创建 tag ${tag} 失败: ${r.stderr}`)
    console.log(`[prerelease] 已创建 annotated tag ${tag} → ${head.stdout}`)
  }
} else if (tagExists) {
  console.log(`[prerelease] 注意: tag ${tag} 已存在且指向 HEAD（该版本可能已发布过，或为上次 publish 失败残留；release 流程会幂等处理）`)
} else {
  console.log(`[prerelease] ok: 工作树干净，tag ${tag} 尚未创建，可以发布`)
}
