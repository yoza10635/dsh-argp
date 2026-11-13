/**
 * dsh-llm 生产适配器契约（P5 后债务清算；2.0 factor-only 收窄）。
 *
 * 锁定四件事（1.x 时与 peratom compressor/declarer 的接线测试同文件，那些类随图臂
 * 退役后本文件只留适配器本体）：
 *  ① completeViaDshLlm：text-delta 拼装、usage 记账、purpose='compaction' 归类、
 *    宿主无 llm 服务时明确报错（不静默）；
 *  ② autoDshLlmSpec：路由齐备 + 宿主有 llm 才解析，缺一即 null；
 *  ③ A-2 wire dump：默认脱敏（无正文），FULL 才落完整 wire（数据责任 1.5.1 回归）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { completeViaDshLlm, autoDshLlmSpec, serializeWireMessages } from '../src/peratom/llm-adapter.ts'
import type { Message } from '@deepseek-ai/dsh-llm'

// ---------------------------------------------------------------------------
// 测试替身：宿主 llm 服务（LlmRuntime 结构化最小视图）
// ---------------------------------------------------------------------------

interface FakeStreamCall { provider: string; model: string; purpose?: string; messageCount: number }

function fakeLlm(responses: Array<{ text?: string; usage?: { inputTokens: number; outputTokens: number } }>): {
  service: unknown
  calls: FakeStreamCall[]
} {
  const calls: FakeStreamCall[] = []
  let i = 0
  const service = {
    async *stream(options: {
      provider: string
      model: string
      purpose?: string
      messages: unknown[]
    }) {
      calls.push({ provider: options.provider, model: options.model, purpose: options.purpose, messageCount: options.messages.length })
      const r = responses[Math.min(i, responses.length - 1)]
      i += 1
      const text = r.text ?? ''
      const mid = Math.ceil(text.length / 2)
      yield { type: 'text-delta', text: text.slice(0, mid) }
      yield { type: 'text-delta', text: text.slice(mid) }
      if (r.usage !== undefined) yield { type: 'usage', usage: r.usage }
    },
  }
  return { service, calls }
}

function ctxWithLlm(service: unknown): Context {
  const ctx = new Context()
  ;(ctx as unknown as { llm: unknown }).llm = service
  return ctx
}

test('completeViaDshLlm：text-delta 拼装 + usage 记账 + purpose=compaction + 单消息 hand-built 请求', async () => {
  const { service, calls } = fakeLlm([{ text: '{"splits":[],"tools":[]}', usage: { inputTokens: 1234, outputTokens: 56 } }])
  const res = await completeViaDshLlm(ctxWithLlm(service), { provider: 'deepseek-official', model: 'deepseek-flash' }, 'PROMPT', 1000)
  assert.equal(res.text, '{"splits":[],"tools":[]}')
  assert.deepEqual(res.usage, { promptTokens: 1234, completionTokens: 56 })
  assert.equal(calls.length, 1)
  const call = calls[0]
  assert.ok(call !== undefined)
  assert.equal(call.provider, 'deepseek-official')
  assert.equal(call.model, 'deepseek-flash')
  assert.equal(call.purpose, 'compaction', '辅助模型调用必须带 purpose=compaction（GenerateOptions 词表）')
  assert.equal(call.messageCount, 1)
})

test('completeViaDshLlm：宿主无 llm 服务 → 明确报错（不静默）', async () => {
  await assert.rejects(
    () => completeViaDshLlm(new Context(), { provider: 'p', model: 'm' }, 'PROMPT', 1000),
    /no llm service/,
  )
})

test('autoDshLlmSpec：路由齐备 + 宿主有 llm 才解析，缺一即 null', () => {
  const { service } = fakeLlm([{ text: '{}' }])
  const ctx = ctxWithLlm(service)
  assert.deepEqual(autoDshLlmSpec(ctx, { provider: 'localhost', model: 'Qwen3.8-27B' }), { provider: 'localhost', model: 'Qwen3.8-27B' })
  assert.equal(autoDshLlmSpec(ctx, null), null, '无路由 → 不兜底')
  assert.equal(autoDshLlmSpec(ctx, { provider: 'p' }), null, '缺 model → 不兜底')
  assert.equal(autoDshLlmSpec(ctx, { provider: 'p', model: '' }), null, '空 model → 不兜底')
  assert.equal(autoDshLlmSpec(ctx, { provider: '', model: 'm' }), null, '空 provider → 不兜底')
  assert.equal(autoDshLlmSpec(new Context(), { provider: 'p', model: 'm' }), null, '宿主无 llm 服务 → 不兜底')
})

test('A-2 wire dump：默认脱敏（无正文），FULL 才落完整 wire（数据责任 1.5.1 回归）', async t => {
  // 非 hex 标记串：保证「默认脱敏」模式下 sha256 摘要（纯小写 hex）不会误中
  const MARKER = 'USER_PRIVATE_MARKER_7b3e9c_DO_NOT_LEAK'

  const messages = [
    { role: 'user', content: [{ type: 'text', text: MARKER }] },
    { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
  ] as unknown as Message[]
  const logger = { debug() {} }

  const redactedDir = mkdtempSync(join(tmpdir(), 'a2-redacted-'))
  const fullDir = mkdtempSync(join(tmpdir(), 'a2-full-'))
  t.after(() => {
    rmSync(redactedDir, { recursive: true, force: true })
    rmSync(fullDir, { recursive: true, force: true })
  })

  const restoreEnv = () => {
    delete process.env['ARGP_PERATOM_A2_DEBUG']
    delete process.env['ARGP_PERATOM_A2_DEBUG_FULL']
  }
  t.after(restoreEnv)

  // 默认（仅 ARGP_PERATOM_A2_DEBUG）：dump 不含正文
  process.env['ARGP_PERATOM_A2_DEBUG'] = redactedDir
  delete process.env['ARGP_PERATOM_A2_DEBUG_FULL']
  serializeWireMessages(messages, logger)
  const redactedFile = readdirSync(redactedDir).find(f => f.startsWith('a-prefix-'))
  assert.ok(redactedFile !== undefined, '默认模式应生成 dump 文件')
  const redacted = readFileSync(join(redactedDir, redactedFile), 'utf8')
  assert.equal(redacted.includes(MARKER), false, '默认脱敏 dump 不得含用户消息正文')
  assert.ok(redacted.includes('"wireSha256"'), '默认 dump 含 wireSha256 摘要')
  assert.ok(redacted.includes('"role"'), '默认 dump 含每条 role+length 摘要')

  // FULL 模式（额外 ARGP_PERATOM_A2_DEBUG_FULL=1）：dump 含完整正文
  process.env['ARGP_PERATOM_A2_DEBUG'] = fullDir
  process.env['ARGP_PERATOM_A2_DEBUG_FULL'] = '1'
  serializeWireMessages(messages, logger)
  const fullFile = readdirSync(fullDir).find(f => f.startsWith('a-prefix-'))
  assert.ok(fullFile !== undefined, 'FULL 模式应生成 dump 文件')
  const full = readFileSync(join(fullDir, fullFile), 'utf8')
  assert.equal(full.includes(MARKER), true, 'FULL 模式 dump 必须含完整用户消息正文（数据责任：须显式开启）')
})
