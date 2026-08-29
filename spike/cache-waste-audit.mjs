// G6 缓存归因审计:从 spike/37 产物的 events.jsonl 重建逐请求 usage,分解命中率构成。
//
// 口径(2026-08-28 定稿,修正过两个前置错误):
//   1. dsh-llm 适配器 usage 语义:inputTokens=纯新增 miss、cacheReadTokens=命中
//      (37a 已证;0.3.1 changelog 同口径)→ prompt = miss + hit,miss 不是 prompt 的一部分。
//   2. "新增内容"必须按**请求时刻**之间的事件流 append 增量计,不能用 contextTraj 轮末
//      快照差分(相位错位:轨迹在轮末记,usage 在请求时记,tool-result 归属会错一拍)。
//   3. 灾难请求 = prompt>2000 且 hit%<5%(近全重算);剔除后得"干净命中率"——
//      引擎逐请求前缀稳定性的真实读数(灾难事件单独归因)。
//   4. ⚠️ genΔ 标签的定义盲区(2026-08-29 双槽审计虚惊后记账):genDelta 统计的是
//      surface.replaceGeneration 换代计数器,而**闭包摘除([elided closure] 墓碑写入)
//      不 bump 换代**——剪枝发生在有请求的轮时,"genΔ0 = 零改写"会漏标。等价且严格
//      的口径:改写轮 = 该请求区间内的 surface 写操作数(append+replace 事件数);
//      无闭包摘除时两者相等(8/29 run2 实测 T32: 159=159)。读 genΔ0 的分支时先核
//      对该轮剪枝事务数,或直接改用事件计数。
//   5. ⚠️ 分布形态(2026-08-29 双槽审计方法论修正):命中率是**双峰分布**(healthy 峰
//      ~87% + pinned 离散事件峰),对全体取均值会把两峰混成一个无物理意义的数
//      (healthy 笔均 miss ~700 tok vs pinned 3.5-13K tok,token 加权下少数 pinned
//      主导均值)。正确读法:healthy 峰(>70%)vs E 臂对照 = 引擎稳态税;pinned 峰
//      单独归因(冷启动 T1 定义性 0-hit 应剔除;"hit 恒定钉死跨多轮" = 槽粘性冻结
//      指纹,双槽 LCP 选错槽专属;崩塌前池驱逐 = server 侧)。pinned 成分跨 run
//      不同,跨 run 平均会混淆机制。
//
// 用法:node spike/cache-waste-audit.mjs <产物目录A> [产物目录B] ...
import { readFileSync } from 'fs'

const CPT = 3.5 // charsPerToken(项目口径)
for (const dir of process.argv.slice(2)) {
  const evs = readFileSync(dir + '/events.jsonl', 'utf8').trim().split('\n').map(JSON.parse)
  const result = (() => { try { return JSON.parse(readFileSync(dir + '/result.json', 'utf8')) } catch { return null } })()
  const genDeltaByTurn = new Map()
  if (result) for (let i = 0; i < result.turnLog.length; i++) genDeltaByTurn.set(i + 1, result.turnLog[i].genDelta ?? 0)

  // 事件流遍历:assistant/message(带 usage)= 一次请求的账目;append 增量 = 该请求的理论新增
  let cumVis = 0, lastCum = 0
  const reqs = []
  for (const e of evs) {
    const sop = e.surfaceOp
    if ((typeof sop === 'object' ? sop?.op : sop) === 'append') cumVis += visLen(e.data)
    if (e.type === 'assistant/message') {
      const u = e.data?.usage ?? {}
      if (u.inputTokens === undefined && u.cacheReadTokens === undefined) continue
      const miss = u.inputTokens ?? 0, hit = u.cacheReadTokens ?? 0
      const turn = e.data?.turn ?? -1
      reqs.push({
        turn, seq: e.seq, miss, hit, prompt: miss + hit,
        newTok: Math.round((cumVis - lastCum) / CPT),
        hitPct: miss + hit > 0 ? hit / (miss + hit) : null,
        genDelta: genDeltaByTurn.get(turn),
      })
      lastCum = cumVis
    }
  }
  const sum = rs => rs.reduce((a, r) => ({ miss: a.miss + r.miss, prompt: a.prompt + r.prompt }), { miss: 0, prompt: 0 })
  const total = sum(reqs)
  const cat = reqs.filter(r => r.prompt > 2000 && r.hitPct !== null && r.hitPct < 0.05)
  const clean = reqs.filter(r => !(r.prompt > 2000 && r.hitPct !== null && r.hitPct < 0.05))
  const tAll = sum(reqs), tCat = sum(cat), tClean = sum(clean)
  const pct = (m, p) => p > 0 ? (100 * (1 - m / p)).toFixed(1) + '%' : '-'
  const turnLabel = t => 'T' + t + (genDeltaByTurn.get(t) ? '(genΔ' + genDeltaByTurn.get(t) + ')' : '(genΔ0)')
  console.log(`===== ${dir.split('/').pop()} =====`)
  console.log(`请求数=${reqs.length}  全量 hit%=${pct(tAll.miss, tAll.prompt)}  miss=${tAll.miss}`)
  console.log(`灾难请求(hit%<5% & prompt>2K): n=${cat.length}  miss=${tCat.miss}(占全臂 miss ${(100 * tCat.miss / Math.max(1, tAll.miss)).toFixed(0)}%)`)
  console.log(`  其中换代轮关联: ${cat.filter(r => (r.genDelta ?? 0) > 0).length}/${cat.length}(换代轮基率 ${[...genDeltaByTurn.values()].filter(g => g > 0).length}/${genDeltaByTurn.size})`)
  console.log(`  明细: ${cat.map(r => turnLabel(r.turn) + '[miss' + r.miss + ']').join(' ')}`)
  console.log(`干净命中率(剔除灾难): ${pct(tClean.miss, tClean.prompt)}  ← 引擎逐请求前缀稳定性的真实读数`)
  console.log(`增量口径核对: ΣnewTok=${reqs.reduce((s, r) => s + r.newTok, 0)}(理论最小 miss;实际 miss 超出部分=服务端重算税)`)
}
function visLen(o) {
  if (!o) return 0
  const c = o.message?.content ?? o.content
  if (Array.isArray(c)) return c.reduce((s, b) => {
    if (b.type === 'text') return s + (b.text ?? '').length
    if (b.type === 'tool-result') return s + (Array.isArray(b.content) ? b.content : [b.content]).reduce((s2, x) => s2 + (x?.text ?? '').length, 0)
    if (b.type === 'tool-call') return s + (typeof b.arguments === 'string' ? b.arguments.length : JSON.stringify(b.arguments ?? '').length)
    return s
  }, 0)
  return typeof o.text === 'string' ? o.text.length : 0
}
