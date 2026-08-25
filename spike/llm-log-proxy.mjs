// log-proxy：转发到真实 llama-server（8080），同时记录每个 /v1/chat/completions 请求的
// system 前缀（messages[0]）与 messages 结构 hash，用于诊断跨轮拼装变化。
// 用法：QWEN_BASE 指向本代理端口，例如 http://127.0.0.1:8099/v1
import http from 'node:http'
import crypto from 'node:crypto'

const TARGET = process.env['PROXY_TARGET'] ?? 'http://127.0.0.1:8080'
const PORT = Number(process.env['PROXY_PORT'] ?? 8099)
const LOG = process.env['PROXY_LOG'] ?? 'spike/out/proxy-requests.jsonl'
import fs from 'node:fs'
fs.mkdirSync('spike/out', { recursive: true })

let reqCount = 0
function sha(s) { return crypto.createHash('sha256').update(s).digest('hex').slice(0, 12) }

const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST') { res.writeHead(404); res.end(); return }
  const chunks = []
  for await (const c of req) chunks.push(c)
  const body = Buffer.concat(chunks)
  let parsed
  try { parsed = JSON.parse(body.toString('utf8')) } catch { res.writeHead(400); res.end('bad json'); return }
  reqCount += 1

  const messages = Array.isArray(parsed.messages) ? parsed.messages : []
  const system = messages.find(m => m.role === 'system')
  const systemText = (typeof system?.content === 'string' ? system.content : JSON.stringify(system?.content ?? ''))
  // messages 结构指纹：每条的 role + 长度 + 内容 hash（前 2 条详记）
  const fingerprint = messages.map(m => {
    const t = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')
    return `${m.role}:${t.length}:${sha(t)}`
  })
  const record = {
    n: reqCount,
    at: new Date().toISOString(),
    messageCount: messages.length,
    systemLen: systemText.length,
    systemSha: sha(systemText),
    systemFirst80: systemText.slice(0, 80).replace(/\n/g, '\\n'),
    systemLast80: systemText.slice(-80).replace(/\n/g, '\\n'),
    systemFull: systemText, // 完整文本，供跨轮 diff
    fingerprint,
  }
  fs.appendFileSync(LOG, JSON.stringify(record) + '\n')
  console.log(`[proxy #${reqCount}] messages=${messages.length} sysLen=${systemText.length} sysSha=${record.systemSha} first="${record.systemFirst80}"`)

  // 转发到真实 llama-server（流式原样透传）
  try {
    const upstream = await fetch(TARGET + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body,
    })
    res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') ?? 'application/json' })
    if (upstream.body) {
      const reader = upstream.body.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        res.write(value)
      }
    }
    res.end()
  } catch (e) {
    res.writeHead(502); res.end('proxy upstream error: ' + String(e))
  }
})
server.listen(PORT, () => console.log(`[proxy] listening on ${PORT}, forwarding to ${TARGET}, log=${LOG}`))
