// 最小探针：验证本地 llama.cpp 的 usage（含 cache 命中）是否可用。
// 协议与 dsh-llm-deepseek 适配器一致：stream + stream_options.include_usage。
const base = process.env['QWEN_BASE'] ?? 'http://127.0.0.1:8080/v1'
const model = process.env['QWEN_MODEL'] ?? 'Qwen3.8-27B'

const LONG = ('请逐步解释什么是前缀缓存（prefix cache），并说明它在长上下文推理中如何降低首字延迟。'.repeat(120))

async function probeModels() {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 6000)
  try {
    const r = await fetch(base + '/models', { signal: ctrl.signal })
    if (!r.ok) return { ok: false, status: r.status }
    const j = await r.json()
    return { ok: true, models: (j.data ?? []).map(m => m.id) }
  } catch (e) {
    return { ok: false, err: String(e.cause?.code ?? e.message) }
  } finally { clearTimeout(t) }
}

async function chatOnce(messages) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 30000)
  try {
    const r = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: 24,
        temperature: 0,
      }),
    })
    if (!r.ok) { console.log('  HTTP', r.status, await r.text().catch(() => '')); return null }
    const text = await r.text()
    const lines = text.split('\n').filter(l => l.startsWith('data:'))
    let usage = null
    for (const l of lines) {
      const d = l.slice(5).trim()
      if (d === '[DONE]') continue
      try { const j = JSON.parse(d); if (j.usage) usage = j.usage } catch {}
    }
    return usage
  } catch (e) {
    console.log('  chat error:', String(e.cause?.code ?? e.message))
    return null
  } finally { clearTimeout(t) }
}

const m = await probeModels()
if (!m.ok) {
  console.log('[PROBE] 本地服务不可达:', m.err ?? m.status, '| base =', base)
  console.log('[PROBE] 结论: 服务未启动（与记忆"本地 Qwen 已停"一致）。无法测试 usage。')
  process.exit(0)
}
console.log('[PROBE] 服务可达。models =', m.models, '| 目标 model =', model)

const msgs = [{ role: 'user', content: LONG }]
console.log('\n[TEST] 第 1 次（写缓存）...')
const u1 = await chatOnce(msgs)
console.log('  usage#1 =', JSON.stringify(u1))

console.log('[TEST] 第 2 次（相同前缀，应命中缓存）...')
const u2 = await chatOnce(msgs)
console.log('  usage#2 =', JSON.stringify(u2))

console.log('\n[VERDICT]')
if (!u1) { console.log('  usage 完全缺失 → 本地服务未回报 usage，dsh 也拿不到。'); }
else {
  const hit1 = u1.prompt_tokens_details?.cached_tokens ?? u1.prompt_cache_hit_tokens ?? 0
  const hit2 = u2?.prompt_tokens_details?.cached_tokens ?? u2?.prompt_cache_hit_tokens ?? 0
  console.log('  usage 存在 ✅ | 第1次命中 =', hit1, '| 第2次命中 =', hit2)
  console.log(hit2 > 0
    ? '  第2次 cached_tokens>0 → 本地服务回报缓存命中，dsh 的 cacheReadTokens 会被正常填充 ✅'
    : '  两次命中均为 0 → 服务未报 cached_tokens（老版本或不报），dsh 收不到命中信号 ⚠️')
}
