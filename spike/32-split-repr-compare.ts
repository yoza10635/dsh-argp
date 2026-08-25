/**
 * Spike 32 — P0 前置实验：长用户消息拆分的 dialog 表示法对比
 *            区间定位（range）vs 原文抄写（transcribe）
 *
 * 背景（2026-08-24 讨论链，承接 per-atom-implementation-plan P0）：
 *   拆分采用「仅标 dialog、余量归 info」方案后，dialog 的表示法有两个候选：
 *   - range      ：模型输出字符偏移区间 [{start,end}]（UTF-16 单元，slice 语义），
 *                  引擎确定性切片。保真由构造保证；风险是模型的坐标计数能力（已知弱项）。
 *   - transcribe ：模型逐字抄写指令片段 ["..."]，引擎在原文 indexOf 定位。
 *                  抄写是模型原生技能（假设更稳）；风险是微改写导致定位失败、
 *                  短片段在原文多处出现时的位置歧义。
 *
 * 统一口径：
 *   - 打分全部字符级（UTF-16 单元）：recall = 预测dialog ∩ 金标dialog / 金标；
 *     precision = 交 / 预测；hazard = 金标 dialog 字符漏进 info 的数量（危险方向，
 *     对应"空隙归 info"的失败模式）。金标空时 recall 记 1。
 *   - 引擎侧策略两策略共享：区间非法丢弃并计 anomaly；dialog 覆盖率 ≥80% 整条翻转为
 *     dialog（防过度标记）；gaps 归 info。
 *   - transcribe 定位失败默认整条回退 dialog（SPLIT_T_MISS_POLICY=drop 可改为仅丢弃
 *     失败片段——更省但 hazard 直接上升），回退保证保真不变式但损失当轮压缩收益。
 *
 * 用法：
 *   npm run spike32                                  # 离线自检（无网络）：模拟输出走通校验+打分
 *   SPLIT_LIVE=1 npm run spike32                     # 实测 deepseek-v4-flash（DEEPSEEK_API_KEY 或凭证文件）
 *   SPLIT_LIVE=1 ARGP_MODEL_SOURCE=qwen-local npm run spike32   # 实测本地 Qwen（QWEN_BASE/QWEN_MODEL）
 *   SPLIT_LIVE=1 SPLIT_CASES=C04,C07 npm run spike32 # 只跑指定用例
 * 产物：spike/out/32-split-repr-<时间戳>.json（仅实测模式）
 */

type Span = readonly [number, number]
type Strategy = 'range' | 'transcribe'

// ---------------------------------------------------------------------------
// 语料：程序化构建，金标 span 由 D/I 片段自动推导（零手工数坐标）
// ---------------------------------------------------------------------------

interface Part { kind: 'D' | 'I'; text: string }
const D = (text: string): Part => ({ kind: 'D', text })
const I = (text: string): Part => ({ kind: 'I', text })

interface CorpusCase {
  id: string
  tags: string[]
  note: string
  parts: Part[]
}

function buildText(parts: Part[]): { text: string; goldSpans: Span[] } {
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

const CORPUS: CorpusCase[] = [
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
    id: 'C04', tags: ['shape', 'multi-interval'], note: '多区间交错（讨论链原型用例）：dialog 三段夹两段资料',
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
    id: 'C07', tags: ['locate-hazard'], note: '重复子串：「看一下这个」在资料里已出现一次；抄写过短会定位到错误位置（文本相同则字符级打分仍通过，位置歧义被记录为已知宽容）',
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
    id: 'C09', tags: ['scale'], note: '超长粘贴（约 14K 字符）：坐标计数压力（range）/ 抄写长度无关性（transcribe）',
    parts: [
      D('这批压测日志太长了不用逐行看，只需要告诉我整体错误率有没有超过 1%：\n'),
      I(synthLog(320, i => `[2026-08-24T10:${String(10 + Math.floor(i / 60)).padStart(2, '0')}:`
        + `${String(i % 60).padStart(2, '0')}.123Z] ${i % 37 === 0 ? 'ERROR' : 'INFO'} req_id=r-${1000 + i}`
        + ` latency_ms=${20 + (i * 7) % 400} status=${i % 37 === 0 ? 502 : 200}`)),
    ],
  },
  {
    id: 'C10', tags: ['whitespace'], note: '空白陷阱：粘贴含行尾空格/\\r\\n/tab；指令内嵌双空格——抄写若被模型"顺手规范化"即定位失败',
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
    id: 'C13', tags: ['hazard-direction'], note: '保守策略金标：邮件正文里"像指令"的话按保真条款记入 dialog（policy-gold，非语义金标）——测模型是否遵守"不确定归 dialog"',
    parts: [
      I('转发邮件全文：\n发件人：老板\n主题：今晚发布\n\n'),
      D('这个 bug 今天必须修完，请尽快处理，有问题随时找我。\n'),
      I('以上为邮件正文节选。\n附件清单：buglist.txt, rollback.md'),
    ],
  },
  {
    id: 'C14', tags: ['over-mark-risk'], note: '强耦合资料：schema 是 load-bearing 但属于资料——防"整段都算指令"的过度标记',
    parts: [
      D('用下面的 schema 建表，字段名和类型都不要改动：\n'),
      I('CREATE TABLE users (\n  id BIGSERIAL PRIMARY KEY,\n  email TEXT NOT NULL UNIQUE,\n'
        + '  created_at TIMESTAMPTZ DEFAULT now()\n);'),
    ],
  },
  {
    id: 'C15', tags: ['multi-interval', 'tiny-connectives'], note: '极短连接语（4-6 字）夹两段资料：gap=info 方案的最坏情形',
    parts: [
      D('先看A：'),
      I('svc-b: ERROR boot failed, missing env PAYMENT_KEY'),
      D('再看B：'),
      I('svc-c: ERROR boot failed, port 3000 in use'),
      D('最后汇总成一张对比表。'),
    ],
  },
  {
    id: 'C16', tags: ['adversarial'], note: '数字密集 CSV：抄写易错位/丢位（transcribe 弱项预期），坐标无碍',
    parts: [
      D('从这份压测汇总里找出响应时间超过 900ms 的行，告诉我有几行以及对应节点：\n'),
      I(synthLog(36, i => `node-${String(Math.floor(i / 6) + 1).padStart(2, '0')},`
        + `${(1500 + i * 37.5).toFixed(2)},${(60 + i % 40).toFixed(1)},${i % 5 === 0 ? 'fail' : 'ok'}`)),
    ],
  },
  {
    id: 'C17', tags: ['adversarial'], note: 'Markdown 围栏粘贴：抄写易规范化反引号/缩进',
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
        + 'TypeError: Cannot read properties of undefined (reading \'maxAttempts\')'),
    ],
  },
]

// ---------------------------------------------------------------------------
// 共享规则 + 双策略 prompt（规则前言完全一致，只有输出规格不同）
// ---------------------------------------------------------------------------

const RULES = [
  '你是一个用户消息切分器。把给定的用户消息划分为两类片段：',
  '- 指令(dialog)：用户要求助手做的事情、提出的问题、给出的约束或偏好（包括"注意X""别动Y""用Z"这类限定语）。',
  '- 资料(info)：被粘贴进来的日志、代码、配置、报错文本、文档引用等参考内容。',
  '判定纪律（保守策略）：任何可能包含指令语义的片段都必须归入指令；只有确定是纯参考资料的部分才可以归入资料。',
].join('\n')

const WRAP = (msg: string): string =>
  `用户消息如下（偏移/内容以 <MSG> 与 </MSG> 标记之间为准）：\n<MSG>\n${msg}\n</MSG>`

const RANGE_PROMPT = (msg: string): string => RULES + '\n'
  + '只输出一个 JSON 对象，格式：{"spans":[{"start":<整数>,"end":<整数>}]}\n'
  + '- start/end 是原文字符偏移：UTF-16 编码单元（即 JS String.prototype.slice 语义），含头不含尾。\n'
  + '- 偏移从用户消息的第一个字符计为 0。\n'
  + '- 区间按原文顺序排列且互不重叠；未被任何区间覆盖的部分视为资料。\n'
  + '记住：只输出 JSON，不要输出任何其他文字。\n\n' + WRAP(msg)

const TRANSCRIBE_PROMPT = (msg: string): string => RULES + '\n'
  + '只输出一个 JSON 对象，格式：{"quotes":["指令片段1","指令片段2"]}\n'
  + '- 每个元素逐字抄写一段连续的指令原文：必须与原文完全一致，包括空格、换行、标点、大小写、全角半角、emoji；禁止改写、翻译、增删任何字符。\n'
  + '- 片段按原文出现顺序排列；同一段连续指令不要拆成多段，不相邻的指令不要合并成一段。\n'
  + '- 未抄写的部分视为资料。\n'
  + '记住：只输出 JSON，不要输出任何其他文字。\n\n' + WRAP(msg)

// ---------------------------------------------------------------------------
// 引擎侧：解析 → 校验/定位 → 策略（与打分解耦，可单测）
// ---------------------------------------------------------------------------

function extractJson(raw: string): unknown {
  // 防御：部分推理端点会把 <think>…</think> 内联进 content，其中可能出现裸 `{`
  const cleaned = raw.replace(/<think>[\s\S]*?<\/think>/g, '')
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(cleaned)
  const text = (fenced?.[1] ?? cleaned).trim()
  try { return JSON.parse(text) as unknown } catch { /* fall through */ }
  // 从最后一个 `}` 向前找配对 `{`（推理模型常在正文前输出杂讯）
  const last = text.lastIndexOf('}')
  if (last > 0) {
    for (let first = text.lastIndexOf('{', last - 1); first >= 0; first = text.lastIndexOf('{', first - 1)) {
      try { return JSON.parse(text.slice(first, last + 1)) as unknown } catch { /* keep scanning */ }
    }
  }
  return undefined
}

/** range 校验：非法区间丢弃计 anomaly；排序；重叠合并计 anomaly。 */
function normalizeRanges(cand: unknown, msgLen: number): { spans: Span[]; anomalies: string[] } {
  const anomalies: string[] = []
  const spans: Span[] = []
  const arr = Array.isArray(cand) ? cand : (cand as { spans?: unknown } | undefined)?.spans
  if (!Array.isArray(arr)) return { spans, anomalies: ['not-an-array'] }
  for (const item of arr) {
    const start = (item as { start?: unknown } | undefined)?.start
    const end = (item as { end?: unknown } | undefined)?.end
    if (typeof start !== 'number' || typeof end !== 'number' || !Number.isInteger(start) || !Number.isInteger(end)) {
      anomalies.push(`non-integer-span(${JSON.stringify(item)})`); continue
    }
    if (start < 0 || end > msgLen || start >= end) {
      anomalies.push(`out-of-range(${start},${end})`); continue
    }
    spans.push([start, end])
  }
  spans.sort((a, b) => a[0] - b[0])
  const merged: Span[] = []
  for (const s of spans) {
    const prev = merged[merged.length - 1]
    if (prev !== undefined && s[0] <= prev[1]) {
      merged[merged.length - 1] = [prev[0], Math.max(prev[1], s[1])]
      anomalies.push(`overlap-merged(${s[0]},${s[1]})`)
    } else merged.push(s)
  }
  return { spans: merged, anomalies }
}

/** 共享策略：dialog 覆盖率 ≥80% → 整条翻转（模型实际在说"这都是指令"）。 */
const COVERAGE_FLIP = 0.8
function applyCoverageFlip(spans: Span[], msgLen: number): { spans: Span[]; flipped: boolean } {
  const covered = spans.reduce((sum, s) => sum + (s[1] - s[0]), 0)
  if (msgLen > 0 && covered / msgLen >= COVERAGE_FLIP) return { spans: [[0, msgLen]], flipped: true }
  return { spans, flipped: false }
}

/** transcribe 定位：逐条 indexOf 取首个出现位置；-1 计 miss。 */
function locateQuotes(quotes: unknown, msg: string): { spans: Span[]; misses: string[] } {
  const spans: Span[] = []
  const misses: string[] = []
  if (!Array.isArray(quotes)) return { spans, misses: ['not-an-array'] }
  for (const q of quotes) {
    if (typeof q !== 'string' || q.length === 0) { misses.push(String(q)); continue }
    const idx = msg.indexOf(q)
    if (idx < 0) misses.push(q)
    else spans.push([idx, idx + q.length])
  }
  spans.sort((a, b) => a[0] - b[0])
  return { spans, misses }
}

const T_MISS_POLICY = (process.env['SPLIT_T_MISS_POLICY'] ?? 'fallback') as 'fallback' | 'drop'
/** 单次调用生成上限（含思考 token；默认 2048，可用 SPLIT_MAX_TOKENS 放宽做 range 诊断）。 */
const MAX_TOKENS = Number(process.env['SPLIT_MAX_TOKENS'] ?? 2048)

/** transcribe 策略层：定位失败 → 整条回退 dialog（保真不变式优先）或仅丢弃失败片段。 */
function applyTranscribePolicy(
  located: Span[], missCount: number, msgLen: number,
): { spans: Span[]; fallbackWhole: boolean } {
  if (missCount > 0 && T_MISS_POLICY === 'fallback') return { spans: [[0, msgLen]], fallbackWhole: true }
  return { spans: located, fallbackWhole: false }
}

// ---------------------------------------------------------------------------
// 打分：字符级 mask
// ---------------------------------------------------------------------------

function maskOf(spans: Span[], len: number): Uint8Array {
  const m = new Uint8Array(len)
  for (const [s, e] of spans) m.fill(1, s, e)
  return m
}

export interface SplitScore {
  recall: number
  precision: number
  hazardChars: number
  predChars: number
  goldChars: number
}

function score(predSpans: Span[], goldSpans: Span[], len: number): SplitScore {
  const pred = maskOf(predSpans, len)
  const gold = maskOf(goldSpans, len)
  let inter = 0
  let g = 0
  let p = 0
  for (let i = 0; i < len; i += 1) {
    if (gold[i] === 1) g += 1
    if (pred[i] === 1) p += 1
    if (pred[i] === 1 && gold[i] === 1) inter += 1
  }
  return {
    recall: g === 0 ? 1 : inter / g,
    precision: p === 0 ? 1 : inter / p,
    hazardChars: g - inter,
    predChars: p,
    goldChars: g,
  }
}

// ---------------------------------------------------------------------------
// 离线自检：模拟典型模型输出（含典型错误形态），断言校验/定位/打分全链路
// ---------------------------------------------------------------------------

const approx = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9

interface SelfCheckRow { caseId: string; scenario: string; strategy: Strategy; pass: boolean; detail: string }

function runSelftest(): void {
  const rows: SelfCheckRow[] = []
  const check = (caseId: string, scenario: string, strategy: Strategy,
                 cond: boolean, detail: string): void => {
    rows.push({ caseId, scenario, strategy, pass: cond, detail })
  }

  // ---- range 分支 ----
  {
    const c = buildText(CORPUS.find(x => x.id === 'C04')!.parts)
    const len = c.text.length
    const gold = c.goldSpans
    // 1) 完美标注
    const ok = normalizeRanges({ spans: gold.map(([s, e]) => ({ start: s, end: e })) }, len)
    const flipOk = applyCoverageFlip(ok.spans, len)
    const sOk = score(flipOk.spans, gold, len)
    check('C04', 'perfect', 'range',
      approx(sOk.recall, 1) && approx(sOk.precision, 1) && sOk.hazardChars === 0
      && !flipOk.flipped && ok.anomalies.length === 0,
      `recall=${sOk.recall} precision=${sOk.precision}`)
    // 2) off-by-one：末尾少 1 个字符 → hazard 恰好 1
    const lastGold = gold[gold.length - 1]!
    const offByOne = normalizeRanges(
      { spans: [...gold.slice(0, -1).map(([s, e]) => ({ start: s, end: e })), { start: lastGold[0], end: lastGold[1] - 1 }] }, len)
    const sOff = score(offByOne.spans, gold, len)
    check('C04', 'off-by-one-end', 'range', sOff.hazardChars === 1, `hazard=${sOff.hazardChars}`)
    // 3) 倒置区间被丢弃 + 缺失一段 → hazard = 该段长度
    const firstGold = gold[0]!
    const inverted = normalizeRanges(
      { spans: [{ start: lastGold[1], end: lastGold[0] }, { start: firstGold[0], end: firstGold[1] }] }, len)
    check('C04', 'inverted-dropped', 'range',
      inverted.spans.length === 1 && inverted.anomalies.length === 1,
      `spans=${inverted.spans.length} anomalies=${JSON.stringify(inverted.anomalies)}`)
    const sInv = score(inverted.spans, gold, len)
    // 丢弃末段后，中段 B 与末段 C 均未覆盖 → hazard = len(B) + len(C)
    const midGold = gold[1]!
    check('C04', 'missing-later-segments', 'range',
      sInv.hazardChars === (midGold[1] - midGold[0]) + (lastGold[1] - lastGold[0]),
      `hazard=${sInv.hazardChars} expected=${(midGold[1] - midGold[0]) + (lastGold[1] - lastGold[0])}`)
    // 4) 过度标记全覆盖 → 触发翻转 → recall=1 但 precision 掉到 gold 占比
    const sFlip = applyCoverageFlip([[0, len]], len)
    const sFlipScore = score(sFlip.spans, gold, len)
    check('C04', 'over-mark-flip', 'range',
      sFlip.flipped && approx(sFlipScore.recall, 1) && approx(sFlipScore.precision, sFlipScore.goldChars / len),
      `precision=${sFlipScore.precision.toFixed(3)} expected≈${(sFlipScore.goldChars / len).toFixed(3)}`)
    // 5) 越界区间丢弃
    const oob = normalizeRanges({ spans: [{ start: 0, end: len + 10 }] }, len)
    check('C04', 'out-of-bounds-dropped', 'range', oob.spans.length === 0, `spans=${oob.spans.length}`)
  }

  // ---- transcribe 分支 ----
  {
    const c = buildText(CORPUS.find(x => x.id === 'C04')!.parts)
    const len = c.text.length
    const gold = c.goldSpans
    const goldTexts = gold.map(([s, e]) => c.text.slice(s, e))
    // 1) 完美抄写
    const loc = locateQuotes(goldTexts, c.text)
    const pol = applyTranscribePolicy(loc.spans, loc.misses.length, len)
    const sOk = score(pol.spans, gold, len)
    check('C04', 'perfect-transcribe', 'transcribe',
      loc.misses.length === 0 && !pol.fallbackWhole && approx(sOk.recall, 1) && approx(sOk.precision, 1),
      `misses=${loc.misses.length}`)
    // 2) 微改写（一个字之差）→ 定位失败 → fallback 整条 → recall=1、precision 大跌但安全
    const corrupted = goldTexts.map((t, i) => (i === 0 ? t.slice(0, -1) + '。' : t))
    const locBad = locateQuotes(corrupted, c.text)
    const polBad = applyTranscribePolicy(locBad.spans, locBad.misses.length, len)
    const sBad = score(polBad.spans, gold, len)
    check('C04', 'paraphrase→fallback-whole', 'transcribe',
      locBad.misses.length === 1 && polBad.fallbackWhole && approx(sBad.recall, 1)
      && approx(sBad.precision, sBad.goldChars / len),
      `precision=${sBad.precision.toFixed(3)} expected≈${(sBad.goldChars / len).toFixed(3)} fallbackWhole=${polBad.fallbackWhole}`)
    // 3) drop 策略对照：同一失败下 hazard = 漏掉片段长度
    const polDrop = applyTranscribePolicy(locBad.spans, locBad.misses.length, len)
    const dropSimulated = polDrop.fallbackWhole ? locBad.spans : polDrop.spans
    const sDrop = score(dropSimulated, gold, len)
    check('C04', 'paraphrase→drop-policy', 'transcribe',
      sDrop.hazardChars === goldTexts[0]!.length,
      `hazard=${sDrop.hazardChars} expected=${goldTexts[0]!.length}`)
    // 4) 空白陷阱 C10：抄写若规范化了行尾空格 → 定位失败（这正是要实测的风险）
    const c10 = buildText(CORPUS.find(x => x.id === 'C10')!.parts)
    const dSpan10 = c10.goldSpans[0]!
    const dText10 = c10.text.slice(dSpan10[0], dSpan10[1])
    const normalized = dText10.replace(/\s+/g, ' ').trim()
    const loc10 = locateQuotes([normalized], c10.text)
    check('C10', 'whitespace-normalized-copy-miss', 'transcribe', loc10.misses.length === 1,
      `normalized="${normalized}" misses=${loc10.misses.length}`)
  }

  // ---- 语料健全性：纯 info 金标为空、纯 dialog 金标全覆盖 ----
  {
    const c02 = buildText(CORPUS.find(x => x.id === 'C02')!.parts)
    check('C02', 'pure-info-empty-gold', 'corpus', c02.goldSpans.length === 0, `gold=${c02.goldSpans.length}`)
    const c03 = buildText(CORPUS.find(x => x.id === 'C03')!.parts)
    check('C03', 'pure-dialog-full-gold', 'corpus',
      c03.goldSpans.length === 1 && c03.goldSpans[0]![0] === 0 && c03.goldSpans[0]![1] === c03.text.length,
      `gold=${JSON.stringify(c03.goldSpans)} len=${c03.text.length}`)
  }

  const failed = rows.filter(r => !r.pass)
  console.log(`\n=== Spike32 自检（离线，${rows.length} 项断言）===`)
  for (const r of rows) {
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  [${r.caseId}/${r.strategy}] ${r.scenario} — ${r.detail}`)
  }
  if (failed.length > 0) {
    console.error(`\n自检失败 ${failed.length}/${rows.length} 项`)
    process.exitCode = 1
  } else {
    console.log(`\n全部通过（${rows.length}/${rows.length}）。校验/定位/打分链路可用，可进入 SPLIT_LIVE=1 实测。`)
  }
}

// ---------------------------------------------------------------------------
// 实测模式：真实模型 × 全语料 × 双策略
// ---------------------------------------------------------------------------

interface LiveRow extends SplitScore {
  caseId: string
  strategy: Strategy
  parseFail: boolean
  anomalies: number
  misses: number
  fallbackWhole: boolean
  flipped: boolean
  completionTokens: number
  ms: number
}

async function resolveEndpoint(): Promise<{ endpoint: string; model: string; key: string }> {
  if (process.env['ARGP_MODEL_SOURCE'] === 'qwen-local') {
    return {
      endpoint: (process.env['QWEN_BASE'] ?? 'http://127.0.0.1:8080/v1') + '/chat/completions',
      model: process.env['QWEN_MODEL'] ?? 'Qwen3.8-27B',
      key: process.env['DEEPSEEK_API_KEY'] ?? 'dummy-local',
    }
  }
  const { ensureDeepSeekApiKey } = await import('./deepseek.js')
  ensureDeepSeekApiKey()
  return {
    endpoint: 'https://api.deepseek.com/chat/completions',
    model: 'deepseek-v4-flash',
    key: process.env['DEEPSEEK_API_KEY']!,
  }
}

async function callModel(
  ep: { endpoint: string; model: string; key: string },
  prompt: string,
): Promise<{ raw: string; completionTokens: number; ms: number }> {
  const t0 = Date.now()
  const res = await fetch(ep.endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ep.key}` },
    signal: AbortSignal.timeout(180_000),
    body: JSON.stringify({
      model: ep.model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: MAX_TOKENS,
      temperature: 0,
    }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const body = await res.json() as {
    choices?: { message?: { content?: string } }[]
    usage?: { completion_tokens?: number }
  }
  const raw = body.choices?.[0]?.message?.content ?? ''
  return { raw, completionTokens: body.usage?.completion_tokens ?? 0, ms: Date.now() - t0 }
}

async function runLive(): Promise<void> {
  const ep = await resolveEndpoint()
  const filter = (process.env['SPLIT_CASES'] ?? '').split(',').map(s => s.trim()).filter(Boolean)
  const cases = CORPUS.filter(c => filter.length === 0 || filter.includes(c.id))
  console.log(`=== Spike32 实测：${cases.length} 用例 × 2 策略 @ ${ep.model} ===`)
  console.log(`transcribe 定位失败策略：${T_MISS_POLICY}\n`)

  const rows: LiveRow[] = []
  const stratFilter = (process.env['SPLIT_STRATEGIES'] ?? 'range,transcribe')
    .split(',').map(s => s.trim()).filter(Boolean)
  for (const c of cases) {
    const { text, goldSpans } = buildText(c.parts)
    for (const strategy of (['range', 'transcribe'] as const).filter(s => stratFilter.includes(s))) {
      const prompt = strategy === 'range' ? RANGE_PROMPT(text) : TRANSCRIBE_PROMPT(text)
      let parsed: unknown
      let completionTokens = 0
      let ms = 0
      let parseFail = false
      // 解析失败静默重试 1 次（与 P2 cite-declarer 同纪律）
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const r = await callModel(ep, prompt)
          parsed = extractJson(r.raw)
          completionTokens = r.completionTokens
          ms = r.ms
          if (parsed !== undefined) break
          parseFail = true
        } catch (err) {
          parseFail = true
          console.warn(`[${c.id}/${strategy}] attempt ${attempt + 1} error: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      let sc: SplitScore
      let anomalies = 0
      let misses = 0
      let fallbackWhole = false
      let flipped = false
      if (parsed === undefined) {
        sc = { recall: NaN, precision: NaN, hazardChars: NaN, predChars: 0, goldChars: 0 }
      } else if (strategy === 'range') {
        const norm = normalizeRanges(parsed, text.length)
        const pol = applyCoverageFlip(norm.spans, text.length)
        anomalies = norm.anomalies.length
        flipped = pol.flipped
        sc = score(pol.spans, goldSpans, text.length)
      } else {
        const quotes = (parsed as { quotes?: unknown }).quotes
        const loc = locateQuotes(quotes, text)
        const pol = applyTranscribePolicy(loc.spans, loc.misses.length, text.length)
        misses = loc.misses.length
        fallbackWhole = pol.fallbackWhole
        sc = score(pol.spans, goldSpans, text.length)
      }
      rows.push({
        caseId: c.id, strategy, ...sc,
        parseFail: parsed === undefined, anomalies, misses, fallbackWhole, flipped,
        completionTokens, ms,
      })
      console.log(
        `[${c.id}/${strategy}] recall=${isNaN(sc.recall) ? 'PARSE_FAIL' : sc.recall.toFixed(3)}`
        + ` precision=${isNaN(sc.precision) ? '-' : sc.precision.toFixed(3)}`
        + ` hazard=${sc.hazardChars} outTok=${completionTokens} ${ms}ms`
        + `${fallbackWhole ? ' [FALLBACK]' : ''}${flipped ? ' [FLIP]' : ''}`
        + `${anomalies > 0 ? ` [anom×${anomalies}]` : ''}${misses > 0 ? ` [miss×${misses}]` : ''}`,
      )
    }
  }

  // 聚合 + 决策提示
  const agg = (strategy: Strategy): Record<string, number> => {
    const rs = rows.filter(r => r.strategy === strategy && !r.parseFail)
    const all = rows.filter(r => r.strategy === strategy)
    const n = Math.max(rs.length, 1)
    return {
      cases: all.length,
      parseFailRate: (all.length - rs.length) / Math.max(all.length, 1),
      meanRecall: rs.reduce((s, r) => s + r.recall, 0) / n,
      meanPrecision: rs.reduce((s, r) => s + r.precision, 0) / n,
      totalHazard: rs.reduce((s, r) => s + r.hazardChars, 0),
      fallbackRate: rs.filter(r => r.strategy === 'transcribe' && r.fallbackWhole).length / n,
      meanOutTokens: rs.reduce((s, r) => s + r.completionTokens, 0) / n,
      totalOutTokens: all.reduce((s, r) => s + r.completionTokens, 0),
      meanMs: rs.reduce((s, r) => s + r.ms, 0) / n,
    }
  }
  const ra = agg('range')
  const ta = agg('transcribe')
  const cols = ([['range', ra], ['transcribe', ta]] as const).filter(([, a]) => (a['cases'] as number) > 0)
  console.log('\n=== 聚合（字符级，越低 hazard 越好；parseFail/fallback 越低越好）===')
  for (const k of Object.keys(ra)) {
    const f = k.includes('Rate') ? ((v: number) => (v * 100).toFixed(1) + '%') : ((v: number) => v.toFixed(2))
    const line = cols.map(([name, a]) => `${name}=${f(a[k] as number)}`).join('  ')
    if (line.length > 0) console.log(`${k.padEnd(16)} ${line}`)
  }
  console.log('\n决策提示（供人工判读，非自动结论）：')
  console.log('- 若 transcribe 的 parseFail/fallback 显著更低且 totalHazard 不高于 range 的 ~110%，')
  console.log('  支持"抄写更稳"假设，可采纳 transcribe 为 P0 默认表示法；')
  console.log('- 若 range 的 totalHazard 更低且异常率可控，维持区间方案（保真构造性最强）；')
  console.log('- C07（重复子串）/C10（空白陷阱）/C16（数字墙）是两策略的分水岭用例，单独看。')

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const fs = await import('node:fs')
  const path = await import('node:path')
  const outDir = path.join(process.cwd(), 'spike', 'out')
  fs.mkdirSync(outDir, { recursive: true })
  const outFile = path.join(outDir, `32-split-repr-${stamp}.json`)
  fs.writeFileSync(outFile, JSON.stringify({
    meta: {
      model: ep.model, endpoint: ep.endpoint, tMissPolicy: T_MISS_POLICY,
      coverageFlip: COVERAGE_FLIP,
      corpus: CORPUS.map(c => ({ id: c.id, tags: c.tags, note: c.note })),
      runAt: new Date().toISOString(),
    },
    rows, aggregate: { range: ra, transcribe: ta },
  }, null, 2))
  console.log(`\n产物：${outFile}`)
}

async function main(): Promise<void> {
  if (process.env['SPLIT_LIVE'] === '1') await runLive()
  else runSelftest()
}

main().catch(err => {
  console.error(err)
  process.exitCode = 1
})
