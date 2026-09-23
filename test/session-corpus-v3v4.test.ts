/**
 * 语料读取器 v3+v4 glob（设计文档 §2.6 / 测试计划 item 5）。
 *
 * 0.1.7 起 session 日志格式 v4（`session.v4.jsonl.zstd`）；0.1.6 及以前 v3。
 * `loadRealCorpus` 须 glob 全部版本（`session.v<N>.jsonl.zstd`）：混合 v3/v4 目录两者都
 * 载入；同一 session 目录并存多版本（迁移期）取最高版本。
 *
 * ⚠️ 隐私铁律：本测试只用**合成**最小 session（临时目录，运行时创建、用后即删），
 * 绝不包含真实 session 原文，CI 上可安全运行（目录缺失时 `loadRealCorpus` 返回 `[]`）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as zlib from 'node:zlib'
import { loadRealCorpus } from '../spike/lib/session-corpus.ts'

/** 造一个最小合法 session 日志：单帧 zstd 包裹「session 头 + 一条 user 事件」的 JSONL。 */
function makeSessionFile(dir: string, version: number): void {
  fs.mkdirSync(dir, { recursive: true })
  const header = { type: 'session', version, id: path.basename(dir), createdAt: '2026-01-01T00:00:00Z', cwd: '/test' }
  const ev = { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } } }
  const jsonl = JSON.stringify(header) + '\n' + JSON.stringify(ev) + '\n'
  fs.writeFileSync(path.join(dir, `session.v${version}.jsonl.zstd`), zlib.zstdCompressSync(Buffer.from(jsonl, 'utf8')))
}

test('loadRealCorpus: 混合 v3/v4 目录两者都载入；同目录并存取最高版本', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'argp-corpus-v3v4-'))
  try {
    const slug = '--test--'
    makeSessionFile(path.join(root, slug, 'session-aaa'), 3)
    makeSessionFile(path.join(root, slug, 'session-bbb'), 4)
    const both = path.join(root, slug, 'session-ccc')
    makeSessionFile(both, 3)
    makeSessionFile(both, 4) // v3+v4 并存 ⇒ 取 v4

    const corpus = loadRealCorpus(root)
    assert.equal(corpus.length, 3, 'all three sessions must be loaded')
    const byId = new Map(corpus.map(s => [s.id, s]))
    assert.ok(byId.get('session-aaa')?.file.endsWith('session.v3.jsonl.zstd'), 'v3 session loaded')
    assert.ok(byId.get('session-bbb')?.file.endsWith('session.v4.jsonl.zstd'), 'v4 session loaded')
    assert.ok(byId.get('session-ccc')?.file.endsWith('session.v4.jsonl.zstd'), 'coexisting v3+v4 → highest version (v4) picked')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('loadRealCorpus: root 不存在返回空数组（CI 优雅跳过）', () => {
  const missing = path.join(os.tmpdir(), 'argp-corpus-missing-' + Date.now())
  assert.deepEqual(loadRealCorpus(missing), [], 'missing root → empty array')
})
