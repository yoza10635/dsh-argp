// 多轮累积对话探针：复现真实 agent 负载（每轮 messages 递增），
// 观察 llama.cpp 在「前缀逐轮增长」下是否仍复用 KV cache。
// 不传 cache_prompt（与 dsh 适配器一致，验证自动前缀缓存）。
const base = process.env['QWEN_BASE'] ?? 'http://127.0.0.1:8080/v1'
const model = process.env['QWEN_MODEL'] ?? 'Qwen3.8-27B'

const BLOCK = '系统：你是一个辅助编程助手。请实现下面的函数并保持接口稳定。'.repeat(20)

async function chatOnce(messages) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 60000)
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
        max_tokens: 16,
        temperature: 0,
      }),
    })
    if (!r.ok) { console.log('  HTTP', r.status); return null }
    const text = await r.text()
    let usage = null
    for (const l of text.split('\n').filter(x => x.startsWith('data:'))) {
      const d = l.slice(5).trim()
      if (d === '[DONE]') continue
      try { const j = JSON.parse(d); if (j.usage) usage = j.usage } catch {}
    }
    return usage
  } catch (e) { console.log('  err:', String(e.cause?.code ?? e.message)); return null }
  finally { clearTimeout(t) }
}

console.log('[MULTITURN] base =', base, '| model =', model)
let history = []
for (let turn = 1; turn <= 6; turn++) {
  // 每轮：前缀 = 之前所有轮（system 固定 + 历史），再追加本轮 user
  history.push({ role: 'user', content: BLOCK + ` 第${turn}轮任务：写 sum 函数并加类型注释。` })
  const u = await chatOnce([{ role: 'system', content: BLOCK }, ...history])
  const hit = u?.prompt_tokens_details?.cached_tokens ?? u?.prompt_cache_hit_tokens ?? 0
  const prompt = u?.prompt_tokens ?? 0
  const ratio = prompt ? (hit / prompt * 100).toFixed(1) : '0'
  console.log(`  turn ${turn}: prompt=${prompt} cached=${hit} (${ratio}%) miss=${prompt - hit}`)
  // 模拟 agent 回填 assistant 回复（真实负载会追加到 history）
  history.push({ role: 'assistant', content: `第${turn}轮已完成的实现代码与说明。` .repeat(8) })
}
console.log('\n[VERDICT] 若 turn>=2 时 cached 持续为 0/极低 → 跨请求前缀缓存未生效（llama.cpp 需显式 cache_prompt 或 prefix 不匹配）。')
