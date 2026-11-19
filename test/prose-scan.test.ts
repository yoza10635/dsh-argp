/**
 * 刀 A 纯函数锁（design-prose-keyword-recall §1.1/§4）：散文扫描带投影+谓词+cap。
 * 事件形=探针档案 session-aacb4606 实测复刻（§6.5）：user 挂 data.source、assistant
 * 挂 data.message.source、replace 副本=顶层 surfaceOp {op:'replace',startSeq,endSeq} 且
 * **无 sourceEventSeqs**（cites-strip 形，宿主禁携带 dsh-session index.js:316）。
 * 变异映射：M34 摘 replace 判据→PS3 红；M35 摘 kind 排除→PS2 红；M36 方向倒转→PS5 红；
 * M37 cap=0 当无限→PS6 红；M38 投影混入 args→PS4 红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  scanProseHits, proseTextOf, isProseCandidate, defaultProseCapChars,
  HOST_BOILERPLATE_SOURCE_KINDS, DEFAULT_PROSE_SCAN_WINDOW_FACTOR,
} from '../src/factor/prose-scan.ts'
import { FACTOR_COMPACTED_MARKER } from '../src/constants.ts'

type Ev = Record<string, unknown>

const mkUser = (text: string, kind = 'user'): Ev => ({
  type: 'user/message', surfaceOp: 'append',
  data: { source: { kind }, content: [{ type: 'text', text }], turn: 1 },
})
const mkAssistant = (blocks: Ev[], kind = 'model'): Ev => ({
  type: 'assistant/message', surfaceOp: 'append',
  data: { message: { role: 'assistant', source: { kind, provider: 'p', model: 'm' }, content: blocks } },
})
const mkReplaceCopy = (text: string, start: number, end: number, kind = 'model'): Ev => ({
  type: 'assistant/message', surfaceOp: { op: 'replace', startSeq: start, endSeq: end },
  data: { message: { role: 'assistant', source: { kind }, content: [{ type: 'text', text }] } },
})

test('PS1 基础命中与序：纯 append U/A 从旧到新，hits/first/chars 如实，大小写不敏感', () => {
  const events: Ev[] = [
    { type: 'session' },
    mkUser('先记一件事 kw-ZX9 开场'),
    mkAssistant([{ type: 'text', text: '好的，KW-zx9 收到' }]),
    mkUser('后记 kw-ZX9 kw-ZX9 结尾'),
  ]
  const r = scanProseHits(events, 'kw-zx9', 10_000)
  assert.equal(r.disabled, false)
  assert.equal(r.truncated, false)
  assert.deepEqual(r.hits.map(h => h.seq), [1, 2, 3])
  assert.deepEqual(r.hits.map(h => h.hits), [1, 1, 2])
  assert.equal(r.hits[0].first, 6)
  assert.equal(r.hits[0].chars, '先记一件事 kw-ZX9 开场'.length)
})

test('PS2 kind 排除主防线：own(argp/plugin/compact-checkpoint)+宿主 boilerplate(runtime-context/skill-catalog) 全挡；user 伪造 marker 前缀不误剔', () => {
  const events: Ev[] = [
    { type: 'session' },
    mkUser('kw-KD argp 注入', 'argp'),
    mkUser('kw-KD plugin 注入', 'plugin'),
    mkUser('kw-KD checkpoint 注入', 'compact-checkpoint'),
    mkUser('kw-KD 宿主快照', 'runtime-context'),
    mkAssistant([{ type: 'text', text: 'kw-KD 技能目录' }], 'skill-catalog'),
    mkUser(FACTOR_COMPACTED_MARKER + ' kw-KD 用户手打伪造 marker——kind=user 必须照扫'),
  ]
  const r = scanProseHits(events, 'kw-kd', 10_000)
  assert.deepEqual(r.hits.map(h => h.seq), [6], '五类注入 kind 全排除；唯一活体=kind=user 伪造 marker 消息（fail-visible）')
  assert.ok(isProseCandidate(mkAssistant([], 'agent-message') as never) && isProseCandidate(mkAssistant([], 'goal') as never), 'merge kind 按普通材料照扫（llm/types.ts 同族裁定）')
  assert.ok(HOST_BOILERPLATE_SOURCE_KINDS.includes('skill-catalog') && HOST_BOILERPLATE_SOURCE_KINDS.includes('runtime-context'))
})

test('PS3 replace 副本双计排除：cites-strip 形（顶层 replace、无 sourceEventSeqs）不入面；原文单计', () => {
  const events: Ev[] = [
    { type: 'session' },
    mkAssistant([{ type: 'text', text: '原文段 kw-CP 正文' }]),
    mkReplaceCopy('原文段 kw-CP 正文（cites 已剥的 replace 副本）', 1, 1),
  ]
  const r = scanProseHits(events, 'kw-cp', 10_000)
  assert.deepEqual(r.hits.map(h => h.seq), [1], '副本入面=双计实锤回归（P1★）')
  assert.equal(r.hits[0].hits, 1)
})

test('PS4 仅 text 块投影：tool-call args 不计不展示；reasoning-only 不入面；双形读 V3 user', () => {
  const events: Ev[] = [
    { type: 'session' },
    mkAssistant([
      { type: 'text', text: '我要读文件 kw-AR 一次' },
      { type: 'tool-call', name: 'read', arguments: { path: 'C:/kw-AR/kw-AR/kw-AR/deep/kw-AR/kw-AR.ts' } },
    ]),
    mkAssistant([{ type: 'reasoning', text: 'reasoning 里有 kw-AR 也不扫' }]),
    { type: 'user/message', surfaceOp: 'append', data: { source: { kind: 'user' }, message: { content: [{ type: 'text', text: 'V3 形 kw-AR 老会话' }] } } },
  ]
  const r = scanProseHits(events, 'kw-ar', 10_000)
  assert.deepEqual(r.hits.map(h => h.seq), [1, 3])
  assert.equal(r.hits[0].hits, 1, 'args 内 5 次 kw-AR 不得计数（P4★：扫描面禁 args）')
  assert.equal(proseTextOf(events[2] as never), null, 'reasoning 无 text 块=null')
})

test('PS5 cap 从旧到新+truncated 显式：触线保旧切新；cap=0 ⇒ disabled（非 truncated）', () => {
  const big = 'x'.repeat(100) + ' kw-CAP'
  const events: Ev[] = [{ type: 'session' }, ...[1, 2, 3].map(() => mkUser(big))]
  const r250 = scanProseHits(events, 'kw-cap', 250)
  assert.deepEqual(r250.hits.map(h => h.seq), [1, 2], '触线即停=最旧两条保留（新→旧方向会阉割已离场原文，P7★）')
  assert.equal(r250.truncated, true)
  assert.equal(r250.scannedChars, 214)
  const r350 = scanProseHits(events, 'kw-cap', 350)
  assert.equal(r350.hits.length, 3)
  assert.equal(r350.truncated, false)
  const r0 = scanProseHits(events, 'kw-cap', 0)
  assert.equal(r0.disabled, true)
  assert.equal(r0.truncated, false, '带关闭无「未扫」告警义务（评测对照臂语义）')
  assert.deepEqual(r0.hits, [])
})

test('PS6 cap 缺省=窗相对值（D3/R9④ 量纲：窗 tok × 密度 × 系数，floor 单点）', () => {
  assert.equal(defaultProseCapChars(262_144, 3.5), Math.floor(262_144 * 3.5 * DEFAULT_PROSE_SCAN_WINDOW_FACTOR))
  assert.ok(defaultProseCapChars(262_144, 1.7) < defaultProseCapChars(262_144, 3.5), 'CJK 高密面 cap 随密度收缩（同预算语义）')
  assert.equal(defaultProseCapChars(0, 3.5), 0)
})
