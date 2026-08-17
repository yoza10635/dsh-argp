// 零依赖提交信息规范检查器（conventional commits，见 CONTRIBUTING.md）
//
// 用法: node scripts/check-commit-msg.mjs <rev-range>
//   e.g. node scripts/check-commit-msg.mjs "origin/main..HEAD"
//
// 退出码: 0 = 全部合规；1 = 存在不合规提交（CI / pre-push 将拒绝）
import { execSync } from 'node:child_process'

const range = process.argv[2] || 'HEAD~1..HEAD'
const TYPE_RE = /^(feat|fix|docs|refactor|test|chore|build|ci|perf|style|revert|experiment)(\([a-z0-9-]+\))?!?: .{1,120}$/

let subjects = []
try {
  // git log --format=%s 只输出 subject 行，天然跳过 sha 行
  subjects = execSync(`git log --format=%s ${range}`, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
} catch {
  // 范围不可解析（force push / 浅克隆 / 首次推送），不阻塞 —— 本地 pre-push 与人工审查兜底
  console.warn(`[commit-msg] range "${range}" not resolvable; skipping`)
  process.exit(0)
}

// 个人项目无 PR 流程，忽略 merge commit
let failed = 0
for (const s of subjects) {
  if (s.startsWith('Merge ')) continue
  if (!TYPE_RE.test(s)) {
    console.error(`[commit-msg] BAD: "${s}"`)
    failed++
  }
}

if (failed > 0) {
  console.error(
    `[commit-msg] ${failed} commit(s) violate conventional commits (feat|fix|docs|refactor|test|chore|build|ci|experiment[(scope)]: subject). See CONTRIBUTING.md.`
  )
  process.exit(1)
}
console.log(`[commit-msg] ok (${subjects.length} commit(s) in range)`)
