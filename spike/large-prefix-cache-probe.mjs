// 大前缀多轮探针：复现 A 臂形态（几十 K 大前缀 + 多轮累积），
// 观察 llama-server 在真实规模下是否复用前缀缓存。
// 对齐 A 臂：system 静态大块（~12K token）+ 每轮 user/assistant 小幅追加。
// 判据：turn>=2 时 cached_tokens 应 ≈ 前轮 prompt - 本轮新增；若 cached≈0 则缓存未复用。
const base = process.env['QWEN_BASE'] ?? 'http://127.0.0.1:8080/v1'
const model = process.env['QWEN_MODEL'] ?? 'Qwen3.8-27B'

// 静态大块（模仿 dsh persona+契约+cites+早期历史），目标 ~12K token
const BLOCK = 'Edge rate-limit microservice: fixed 60s windows aligned to epoch minute; burst 128; 429 with retry-after-ms; fail-open on timeout; error codes RL_EXCEEDED/RL_MISCONFIG/RL_INTERNAL; service token TK-WHUZ; redis prefix rl:prod:XJ3U; STORE_BUCKET_EPOCH=1256120; makeKey combines prefix and bucket epoch; alignWindow truncates to whole minutes; RateCounter incr/reset; expect(retries).toBe(1304391); read_file returns file contents; write_file writes chars; edit_file replaces one occurrence; context compression contract: visible context is a pruned view; recall_pruned works on any seq; list_pruned scans seq window; citation declaration appendix; citeStats counts declared edges; shadowedSeqsOf incremental cursor; catalogText budget-driven; compactIfNeeded in-place pruning; scaleBudgets; extractCites; context-overflow recovery; retry semantics; watchdog three hours; fifty turns; ballast reads; U/R probes; marker lines; facts F1-F10;'
const SYSTEM = 'System: ' + BLOCK.repeat(120) // ~600 * 120 = 72K 字符 ≈ 12K token

async function chatOnce(messages) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 180000)
  const t0 = Date.now()
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
    const dt = ((Date.now() - t0) / 1000).toFixed(1)
    return { usage, dt }
  } catch (e) { console.log('  err:', String(e.cause?.code ?? e.message)); return null }
  finally { clearTimeout(t) }
}

console.log('[LARGE-PREFIX] base =', base, '| model =', model)
console.log('[LARGE-PREFIX] SYSTEM 长度 =', SYSTEM.length, '字符（约', Math.round(SYSTEM.length / 6), 'token，A 臂同量级）')
let history = []
for (let turn = 1; turn <= 5; turn++) {
  // 每轮追加小幅 user + assistant（模仿 agent 轮次增量，几百 token）
  history.push({ role: 'user', content: `第${turn}轮：请确认以下值并静态回答：burst limit 是多少？(answer concisely)`.repeat(3) })
  const u = await chatOnce([{ role: 'system', content: SYSTEM }, ...history])
  const hit = u?.usage?.prompt_tokens_details?.cached_tokens ?? u?.usage?.prompt_cache_hit_tokens ?? 0
  const prompt = u?.usage?.prompt_tokens ?? 0
  const ratio = prompt ? (hit / prompt * 100).toFixed(1) : '0'
  console.log(`  turn ${turn}: prompt=${prompt} cached=${hit} (${ratio}%) miss=${prompt - hit} 耗时=${u?.dt ?? '-'}s`)
  // 模拟 agent 回填 assistant 回复
  history.push({ role: 'assistant', content: `第${turn}轮回答：burst=128；耗时正常。`.repeat(4) })
}
console.log('\n[VERDICT] turn>=2 cached 持续≈0 → 大前缀下缓存未复用（复现 A 臂形态问题）；cached 逐轮上升 → 大前缀缓存正常，A 臂问题在别处。')
