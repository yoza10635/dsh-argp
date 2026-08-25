/**
 * P0 拆分单测语料（fixture）：与 spike/32-split-repr-compare.ts 的 CORPUS 保持同步
 * （2026-08-24 快照，18 用例）。金标 dialog span 由 D/I 片段程序化推导，零手工数坐标。
 *
 * 放在 test/fixtures 而非 src：语料是实验资产，不随 npm 包发布（package.json files 只有 lib）。
 * 若 spike 32 语料后续扩充，此处同步更新并在验收记录里标注口径。
 */

export interface Part { kind: 'D' | 'I'; text: string }
export const D = (text: string): Part => ({ kind: 'D', text })
export const I = (text: string): Part => ({ kind: 'I', text })

export type Span = readonly [number, number]

export interface CorpusCase {
  id: string
  tags: string[]
  note: string
  parts: Part[]
}

/** 按 D/I 片段顺序拼接，自动推导金标 dialog span（UTF-16 编码单元，slice 语义）。 */
export function buildText(parts: Part[]): { text: string; goldSpans: Span[] } {
  let text = ''
  const goldSpans: Span[] = []
  for (const p of parts) {
    const start = text.length
    text += p.text
    if (p.kind === 'D') goldSpans.push([start, text.length])
  }
  return { text, goldSpans }
}

function synthLog(lines: number, fn: (i: number) => string): string {
  const out: string[] = []
  for (let i = 0; i < lines; i += 1) out.push(fn(i))
  return out.join('\n')
}

export const SPLIT_CORPUS: CorpusCase[] = [
  {
    id: 'C01', tags: ['shape'], note: 'canonical：短指令在前 + 大粘贴',
    parts: [
      D('帮我解决下面这个报错，服务起不来了：\n'),
      I('Error: listen EADDRINUSE: address already in use :::3000\n'
        + '    at Server.setupListenListen (node:net:1917:16)\n'
        + '    at process.processTicksAndRejections (node:internal/process/task_queues:85:21)\n'
        + '{"name":"api","cmd":"start","exitCode":1,"restarts":3}'),
    ],
  },
  {
    id: 'C02', tags: ['degenerate'], note: '纯资料零指令：理想输出 = 空 dialog（整条 U-info）',
    parts: [
      I('以下是生产环境 nginx 反代配置全文，供后续讨论引用：\n'
        + 'server {\n  listen 443 ssl;\n  server_name api.example.com;\n'
        + '  location / {\n    proxy_pass http://127.0.0.1:3000;\n'
        + '    proxy_set_header Host $host;\n  }\n}'),
    ],
  },
  {
    id: 'C03', tags: ['degenerate'], note: '全指令长消息：理想输出 = 全覆盖（或触发覆盖率翻转）',
    parts: [
      D('接下来的重构任务请按以下顺序执行：先给 storage 层补齐接口的单元测试，'
        + '重点覆盖并发写入与超时路径；然后把 SQLite 方言里的 upsert 换成显式事务实现，'
        + '注意保持对旧库文件的向后兼容；最后更新 CHANGELOG 并跑一遍完整回归。'
        + '过程中不要引入新的运行时依赖，也不要动 public API 的签名。'),
    ],
  },
  {
    id: 'C04', tags: ['shape', 'multi-interval'], note: '多区间交错：dialog 三段夹两段资料',
    parts: [
      D('看一下这些信息：\n'),
      I('[svc-a] 2026-08-24T10:15:01 WARN upstream timeout after 5000ms host=pay-gw\n'
        + '[svc-a] 2026-08-24T10:15:04 retry 1/3 failed code=ETIMEDOUT\n'),
      D('根据第二段的超时报错修一下重试逻辑，\n'),
      I('[db] 2026-08-24T10:15:09 ERROR deadlock detected on table orders\n'
        + '[db] 2026-08-24T10:15:09 SQLSTATE=40001 victim=txn#8821\n'),
      D('注意别动数据库连接池的配置。'),
    ],
  },
  {
    id: 'C05', tags: ['shape'], note: '指令在后：先粘贴后要求',
    parts: [
      I('{"p50":120,"p95":480,"p99":1120,"errRate":0.004,"rps":842}\n'
        + '{"p50":118,"p95":510,"p99":1980,"errRate":0.031,"rps":913}'),
      D('\n基于以上两组指标写一份三句话的健康度摘要，重点说清 p99 恶化的可能原因。'),
    ],
  },
  {
    id: 'C06', tags: ['shape', 'inline-quote'], note: '指令内嵌来自资料的专有名词（ECONNREFUSED）',
    parts: [
      I('[api] connect ECONNREFUSED 10.0.3.17:5432\n'
        + '[api] at TCPConnectWrap.afterConnect [as onComplete] (node:net:1607:16)\n'
        + '[worker] pg pool exhausted, waiting for idle client\n'),
      D('把日志里出现 ECONNREFUSED 的那几行解释一下，然后给出修复步骤。'),
    ],
  },
  {
    id: 'C07', tags: ['locate-hazard'], note: '重复子串：「看一下这个」在资料里已出现一次；整句抄写天然消解歧义',
    parts: [
      I('同事评审意见转发：\n"建议先看一下这个工具函数的边界处理，再合入。"\n---\n'),
      D('看一下这个堆栈，帮我定位内存泄漏的原因：\n'),
      I('<stack>\n at Object.<anonymous> (src/cache.ts:88:19)\n at grow (src/lru.ts:41:7)\n</stack>'),
    ],
  },
  {
    id: 'C08', tags: ['locate-hazard'], note: '近似重复块：两个堆栈只差错误码，指令点名第二个',
    parts: [
      D('下面第一个堆栈是上周的历史记录直接忽略；第二个堆栈里的 ECONNRESET 才是本次要查的问题：\n'),
      I('[hist] request failed code=ETIMEDOUT\n    at Socket.socketOnEnd (node:_http_client:512:26)\n'
        + '[curr] request failed code=ECONNRESET\n    at Socket.socketOnEnd (node:_http_client:512:26)\n'),
    ],
  },
  {
    id: 'C09', tags: ['scale'], note: '超长粘贴（约 14K 字符）：抄写成本 ∝ 指令长度，与全文无关',
    parts: [
      D('这批压测日志太长了不用逐行看，只需要告诉我整体错误率有没有超过 1%：\n'),
      I(synthLog(320, i => `[2026-08-24T10:${String(10 + Math.floor(i / 60)).padStart(2, '0')}:`
        + `${String(i % 60).padStart(2, '0')}.123Z] ${i % 37 === 0 ? 'ERROR' : 'INFO'} req_id=r-${1000 + i}`
        + ` latency_ms=${20 + (i * 7) % 400} status=${i % 37 === 0 ? 502 : 200}`)),
    ],
  },
  {
    id: 'C10', tags: ['whitespace'], note: '空白陷阱：粘贴含行尾空格/\\r\\n/tab；指令内嵌双空格——抄写被"顺手规范化"即定位失败',
    parts: [
      I('deploy step 1 ok   \r\n\tdeploy step 2 skipped\t\r\ndeploy step 3 FAILED  \n'),
      D('\n请把  deploy step 3 FAILED  这一行解释一下，并说明 step 2 被跳过的原因。'),
    ],
  },
  {
    id: 'C11', tags: ['unicode'], note: '全角半角混排：指令含半角内联码 + 全角标点',
    parts: [
      D('把 config.yaml 里的 timeout 改成 30s，顺便确认 retry_policy 生效了没：\n'),
      I('http:\n  timeout: 100s\n  retries: 3\nretry_policy:\n  backoff: exponential\n'),
    ],
  },
  {
    id: 'C12', tags: ['unicode'], note: 'emoji + 中文：UTF-16 代理对压力（offset 跨 surrogate、抄写逐字节一致性）',
    parts: [
      D('🚀 上线前帮我看下这段部署日志里有没有 🚨 风险项，有的话列出来：\n'),
      I('[deploy] 📦 build ok (sha 9f2c1ab)\n[deploy] 🚨 health check failed on canary-2 (503)\n'
        + '[deploy] ✅ canary-1 healthy\n'),
    ],
  },
  {
    id: 'C13', tags: ['hazard-direction'], note: '保守策略金标：邮件正文里"像指令"的话按保真条款记入 dialog（policy-gold，非语义金标）',
    parts: [
      I('转发邮件全文：\n发件人：老板\n主题：今晚发布\n\n'),
      D('这个 bug 今天必须修完，请尽快处理，有问题随时找我。\n'),
      I('以上为邮件正文节选。\n附件清单：buglist.txt, rollback.md'),
    ],
  },
  {
    id: 'C14', tags: ['over-mark-risk'], note: '强耦合资料：schema 是 load-bearing 但属于资料——防过度标记',
    parts: [
      D('用下面的 schema 建表，字段名和类型都不要改动：\n'),
      I('CREATE TABLE users (\n  id BIGSERIAL PRIMARY KEY,\n  email TEXT NOT NULL UNIQUE,\n'
        + '  created_at TIMESTAMPTZ DEFAULT now()\n);'),
    ],
  },
  {
    id: 'C15', tags: ['multi-interval', 'tiny-connectives'], note: '极短连接语（4-6 字）夹两段资料：空隙归 info 方案的最坏情形',
    parts: [
      D('先看A：'),
      I('svc-b: ERROR boot failed, missing env PAYMENT_KEY'),
      D('再看B：'),
      I('svc-c: ERROR boot failed, port 3000 in use'),
      D('最后汇总成一张对比表。'),
    ],
  },
  {
    id: 'C16', tags: ['adversarial'], note: '数字密集 CSV：抄写需精确保留数字串',
    parts: [
      D('从这份压测汇总里找出响应时间超过 900ms 的行，告诉我有几行以及对应节点：\n'),
      I(synthLog(36, i => `node-${String(Math.floor(i / 6) + 1).padStart(2, '0')},`
        + `${(1500 + i * 37.5).toFixed(2)},${(60 + i % 40).toFixed(1)},${i % 5 === 0 ? 'fail' : 'ok'}`)),
    ],
  },
  {
    id: 'C17', tags: ['adversarial'], note: 'Markdown 围栏粘贴：抄写不得规范化反引号/缩进',
    parts: [
      D('解释一下这个 Python 函数为什么会死循环：\n'),
      I('```python\ndef watchdog(timeout):\n    deadline = now() + timeout\n'
        + '    while now() < deadline:\n        pass\n```\n'),
    ],
  },
  {
    id: 'C18', tags: ['mixed-lang'], note: '中英混排 + 内联标识符：抄写需保留括号/大小写',
    parts: [
      D('调用 parseConfig() 传入 retryPolicy 之后还是失败，帮我看下面的调用栈：\n'),
      I('at parseConfig (src/config.ts:142:11)\nat bootstrap (src/main.ts:31:5)\n'
        + "TypeError: Cannot read properties of undefined (reading 'maxAttempts')"),
    ],
  },
]

/** 按 id 取用例并构建原文 + 金标。 */
export function corpusCase(id: string): { text: string; goldSpans: Span[]; c: CorpusCase } {
  const c = SPLIT_CORPUS.find(x => x.id === id)
  if (c === undefined) throw new Error(`corpus case not found: ${id}`)
  const built = buildText(c.parts)
  return { ...built, c }
}
