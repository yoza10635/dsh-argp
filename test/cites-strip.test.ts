/**
 * cites-strip.ts 纯函数契约测试（P3.3）：
 *  - parseCitesBlock：legacy 裸串 → supporting；graded 单字母/全词分级；非法 l 回退 supporting
 *  - **安全契约**（cites-strip.ts:69-73 注释警告）：禁止 includes('c') 之类子串匹配——
 *    l="contextual" 绝不可被误升成 critical（最强保护档，误判方向最危险）
 *  - matchCitesTail：裸 JSON / ```json fence 尾部匹配；raw（去 fence）与 span（含 fence）口径
 *  - stripCitesTail：剥离尾部 well-formed cites 块；无块 / 畸形块 → 原文不变
 *
 * 纯模块零依赖，独立于引擎直接测。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseCitesBlock, matchCitesTail, stripCitesTail } from '../src/cites-strip.ts'

// ---------------------------------------------------------------------------
// parseCitesBlock：分级语义
// ---------------------------------------------------------------------------

test('parseCitesBlock: legacy 裸串 → 全部 supporting', () => {
  const out = parseCitesBlock('{"cites": ["alpha", "beta.ts:10"]}')
  assert.deepEqual(out, [
    { text: 'alpha', level: 'supporting' },
    { text: 'beta.ts:10', level: 'supporting' },
  ])
})

test('parseCitesBlock: graded 单字母档 c/s/x', () => {
  const out = parseCitesBlock('{"cites": [{"t":"a","l":"c"},{"t":"b","l":"s"},{"t":"c","l":"x"}]}')
  assert.deepEqual(out, [
    { text: 'a', level: 'critical' },
    { text: 'b', level: 'supporting' },
    { text: 'c', level: 'contextual' },
  ])
})

// 安全契约核心：l="contextual" 绝不可误升 critical（includes('c') 子串匹配的反例）
test('parseCitesBlock: 安全契约——l="contextual" 是 contextual 而非 critical', () => {
  const out = parseCitesBlock('{"cites": [{"t":"ctx","l":"contextual"}]}')
  assert.equal(out?.[0]?.level, 'contextual', 'contextual 含字母 c 但绝不可误升 critical（最强保护档）')
})

test('parseCitesBlock: 安全契约——l="critical" 是 critical', () => {
  const out = parseCitesBlock('{"cites": [{"t":"crit","l":"critical"}]}')
  assert.equal(out?.[0]?.level, 'critical')
})

test('parseCitesBlock: 全词容错——大小写/空白归一', () => {
  assert.equal(parseCitesBlock('{"cites": [{"t":"a","l":"CRITICAL"}]}')?.[0]?.level, 'critical')
  assert.equal(parseCitesBlock('{"cites": [{"t":"a","l":"  Contextual  "}]}')?.[0]?.level, 'contextual')
  assert.equal(parseCitesBlock('{"cites": [{"t":"a","l":"S"}]}')?.[0]?.level, 'supporting')
})

test('parseCitesBlock: 非法 l 值 → 回退 supporting', () => {
  assert.equal(parseCitesBlock('{"cites": [{"t":"a","l":"foo"}]}')?.[0]?.level, 'supporting')
  assert.equal(parseCitesBlock('{"cites": [{"t":"a","l":"banana"}]}')?.[0]?.level, 'supporting')
  // 缺 l → supporting
  assert.equal(parseCitesBlock('{"cites": [{"t":"a"}]}')?.[0]?.level, 'supporting')
  // l 非字符串（数字）→ supporting
  assert.equal(parseCitesBlock('{"cites": [{"t":"a","l":3}]}')?.[0]?.level, 'supporting')
})

test('parseCitesBlock: 混合 legacy 串 + graded 对象', () => {
  const out = parseCitesBlock('{"cites": ["plain", {"t":"graded","l":"c"}]}')
  assert.deepEqual(out, [
    { text: 'plain', level: 'supporting' },
    { text: 'graded', level: 'critical' },
  ])
})

test('parseCitesBlock: 畸形 → null', () => {
  assert.equal(parseCitesBlock('not json'), null)
  assert.equal(parseCitesBlock('{"cites": "notarray"}'), null, 'cites 非数组')
  assert.equal(parseCitesBlock('{}'), null, '缺 cites 键')
  assert.equal(parseCitesBlock('{"cites": [{"l":"c"}]}'), null, '对象缺 t（非字符串）→ 整块 null')
  assert.equal(parseCitesBlock('{"cites": [42]}'), null, '既非串也非带 t 对象 → 整块 null')
})

// ---------------------------------------------------------------------------
// matchCitesTail：尾部匹配 + raw/span 口径
// ---------------------------------------------------------------------------

test('matchCitesTail: 裸 JSON 尾部 → raw = 匹配段、span = 其长度', () => {
  const text = 'body text\n{"cites": ["a"]}'
  const m = matchCitesTail(text)
  assert.ok(m !== null)
  assert.equal(m.raw, '{"cites": ["a"]}')
  assert.equal(m.span, '{"cites": ["a"]}'.length)
  // 尾部对齐：text 末尾 m.span 字符恰为匹配段
  assert.equal(text.slice(text.length - m.span), m.raw)
})

test('matchCitesTail: 嵌套 graded 对象尾部匹配（回溯到末尾 }）', () => {
  const text = 'body\n{"cites": [{"t":"a","l":"c"}]}'
  const m = matchCitesTail(text)
  assert.ok(m !== null)
  assert.equal(m.raw, '{"cites": [{"t":"a","l":"c"}]}')
})

test('matchCitesTail: ```json fence 尾部 → raw 去 fence、span 含 fence', () => {
  const text = 'body text\n```json\n{"cites": ["a"]}\n```'
  const m = matchCitesTail(text)
  assert.ok(m !== null)
  assert.equal(m.raw, '{"cites": ["a"]}', 'raw = 去 fence 的 JSON')
  assert.ok(m.span > m.raw.length, 'span 含 fence，大于 raw')
  assert.equal(text.slice(text.length - m.span), '```json\n{"cites": ["a"]}\n```')
})

test('matchCitesTail: 无块 / 块不在尾部 → null', () => {
  assert.equal(matchCitesTail('plain text no block'), null)
  // 块后还有文本 → 不在尾部（正则锚定 $）→ null
  assert.equal(matchCitesTail('{"cites": ["a"]}\ntrailing text'), null)
})

// ---------------------------------------------------------------------------
// stripCitesTail：剥离尾部块
// ---------------------------------------------------------------------------

test('stripCitesTail: 剥离尾部裸 cites 块', () => {
  assert.equal(stripCitesTail('body text\n{"cites": ["a"]}'), 'body text')
})

test('stripCitesTail: 剥离尾部 ```json fence cites 块', () => {
  assert.equal(stripCitesTail('body text\n```json\n{"cites": ["a"]}\n```'), 'body text')
})

test('stripCitesTail: 无块 → 原文不变', () => {
  const text = 'plain text no block'
  assert.equal(stripCitesTail(text), text)
})

test('stripCitesTail: 畸形块（fence 匹配但 parse 失败）→ 原文不变', () => {
  // fence 正则匹配任意 JSON，但 parseCitesBlock 要求 cites 数组——无 cites 键 → 不剥离
  const text = 'body\n```json\n{"foo": "bar"}\n```'
  assert.equal(stripCitesTail(text), text)
})
