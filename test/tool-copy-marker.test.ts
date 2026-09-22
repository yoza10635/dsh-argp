/**
 * tool/result 压缩副本**头部标记**（v1.6.1）专项。
 *
 * 存在理由（2026-09-23 核查）：dsh-session 硬约束使 tool/result 副本**不能**挂
 * `data[ARG_NS]` 元数据、也**不能**换 source（`decision.toolCopyPayload` /
 * `flush.flushEntry` 注释），且副本 `source.kind` 仍是 `'tool'` ⇒ 压缩副本在 LLM 侧
 * 与真实工具输出不可辨。extract 档尤甚：prompt 契约要求 text 是原文**逐字**片段，
 * 与完整工具输出逐字同形。头部标记是宿主硬约束下**唯一**的 model-visible 通道。
 *
 * 召回指引**不**写进副本（每原子重复一段指引纯属浪费上下文），统一由 `argp-contract`
 * system 段一次性声明 ⇒ 标记只需带 seq（模型在 tool/result 里看不到 seq，不带则
 * recall_detail(N) 无参数可调，召回通路实际是断的）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import {
  PeratomCompressor,
  planReplacements,
  toolCopyMarkerText,
  TOOL_COPY_MARKER_RE,
} from '../src/peratom/compressor.ts'
import type { CompressDecision, CurrentTurnCollect } from '../src/peratom/compressor.ts'
import { fidelityGuard, repairWithTrailer } from '../src/token-ontology.ts'

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/** 纯散文原文（刻意不含 file:line / 路径 / UUID 等高信号 token ⇒ 保真守卫平凡通过）。 */
const PROSE = 'the migration job finished and every shard reported success with no retries and no conflict detected during the whole run; the destination store now holds all records in the expected order and the gateway accepted them'
const PROSE_CANDIDATE = 'migration finished: all shards reported success, no retries, no conflicts; destination store holds all records in expected order'

/** 含高信号 token（`src/db/pool.ts:88`）的原文：candidate 丢 token ⇒ 保真守卫不通过。 */
const TOKEN_TEXT = 'Error: the connection pool refused new sessions with EADDRINUSE at src/db/pool.ts:88 after thirty seconds of retries, and the reporting job failed to obtain any connection; rollback the pool config change and restart the gateway to recover the service.'
const TOKEN_CANDIDATE = 'connection pool refused new sessions after retries; reporting job could not obtain a connection; rollback pool config and restart gateway'

function makeCollect(seq: number, text: string): CurrentTurnCollect {
  return {
    turn: 1,
    startSeq: seq,
    endSeq: seq,
    interrupted: false,
    userLong: [],
    toolResults: [{ kind: 'tool-result', seq, turn: 1, text, callId: 'c1' }],
  }
}

function makeEvent(seq: number, text: string, callId = 'c1'): never {
  return {
    type: 'tool/result',
    seq,
    time: 0,
    surfaceOp: 'append',
    data: {
      message: {
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }], isError: false }],
        source: { kind: 'tool', callId },
      },
    },
  } as never
}

/** 取 replace 步骤的落地正文（tool/result 副本的 content[0].content[0].text）。 */
function stepText(step: unknown): string {
  const d = step as { data: { message: { content: Array<{ content: Array<{ type: string; text: string }> }> } } }
  return d.data.message.content[0]!.content[0]!.text
}

// ---------------------------------------------------------------------------
// 标记落地
// ---------------------------------------------------------------------------

test('marker=on：extract 副本头部带 [已压缩-摘取 seq=N]', () => {
  const plan = planReplacements(
    makeCollect(5, PROSE),
    { splits: [], tools: [{ seq: 5, level: 'extract', text: PROSE_CANDIDATE }] },
    [makeEvent(5, PROSE)],
    { marker: 'on' },
  )
  assert.equal(plan.steps.length, 1, '副本落地')
  assert.equal(plan.skippedNoopGain, 0)
  assert.equal(stepText(plan.steps[0]), '[已压缩-摘取 seq=5]\n' + PROSE_CANDIDATE)
  assert.ok(stepText(plan.steps[0]).startsWith(toolCopyMarkerText('extract', 5)))
})

test('marker=on：summary 副本头部带 [已压缩-摘要 seq=N]（分档 = 措辞可信度信号）', () => {
  const plan = planReplacements(
    makeCollect(9, PROSE),
    { splits: [], tools: [{ seq: 9, level: 'summary', text: PROSE_CANDIDATE }] },
    [makeEvent(9, PROSE)],
    { marker: 'on' },
  )
  assert.equal(plan.steps.length, 1)
  assert.equal(stepText(plan.steps[0]), '[已压缩-摘要 seq=9]\n' + PROSE_CANDIDATE)
  // 分档的实质收益：argp-cites 要求"逐字抄前 10-20 词"，summary 档措辞是改写而非原文，
  // 标记给模型一个"这段不能逐字引用"的信号；extract 档是原文子串，可以逐字引用。
  assert.ok(stepText(plan.steps[0]).includes('摘要'), 'summary 档标记明示措辞非原文')
})

test('缺省 / marker=off：v1.6 行为逐字节不变（独立调用方保守默认，既有单测零改动）', () => {
  const decision: CompressDecision = { splits: [], tools: [{ seq: 5, level: 'extract', text: PROSE_CANDIDATE }] }
  const def = planReplacements(makeCollect(5, PROSE), decision, [makeEvent(5, PROSE)])
  assert.equal(stepText(def.steps[0]!), PROSE_CANDIDATE, '缺省无标记')
  const off = planReplacements(makeCollect(5, PROSE), decision, [makeEvent(5, PROSE)], { marker: 'off' })
  assert.equal(stepText(off.steps[0]!), PROSE_CANDIDATE, '显式 off 无标记')
})

// ---------------------------------------------------------------------------
// 收益门必须计入标记长度（否则"加了标记反而持平/变长"的白压）
// ---------------------------------------------------------------------------

test('收益门：标记开销计入 no-op 守卫 ⇒ 加标记后无收益的原子退回原文保面', () => {
  const base = 'the migration job completed across every shard without any error and all records landed in the destination store in order '
  const toolText = base.repeat(2).slice(0, 200)
  const candidate = toolText.slice(0, 180)
  const markerLen = toolCopyMarkerText('extract', 5).length + 1 // +1 = 标记后的换行
  // fixture 自检：不加标记能过门、加了标记刚好跌破门限——否则本例断言无意义。
  assert.ok(candidate.length < toolText.length * 0.95, `fixture：裸副本须过门（${candidate.length} < ${toolText.length * 0.95}）`)
  assert.ok(candidate.length + markerLen >= toolText.length * 0.95, `fixture：加标记须跌破门限（${candidate.length + markerLen} >= ${toolText.length * 0.95}）`)

  const decision: CompressDecision = { splits: [], tools: [{ seq: 5, level: 'extract', text: candidate }] }
  const on = planReplacements(makeCollect(5, toolText), decision, [makeEvent(5, toolText)], { marker: 'on' })
  assert.equal(on.skippedNoopGain, 1, '加标记后收益归零 ⇒ 保原文（错误方向仍是少压）')
  assert.equal(on.steps.length, 0)

  const off = planReplacements(makeCollect(5, toolText), decision, [makeEvent(5, toolText)], { marker: 'off' })
  assert.equal(off.steps.length, 1, '对照：同一文本不加标记则落地')
})

// ---------------------------------------------------------------------------
// 与既有机制的互不干扰
// ---------------------------------------------------------------------------

test('标记与 HLS 尾注共存：标记在头、[restored] 尾注在尾，保真语义不变', () => {
  const missing = fidelityGuard(TOKEN_TEXT, TOKEN_CANDIDATE).missing
  assert.ok(missing.length > 0, 'fixture：候选确有缺失硬 token（HLS 才会介入）')
  const plan = planReplacements(
    makeCollect(5, TOKEN_TEXT),
    { splits: [], tools: [{ seq: 5, level: 'extract', text: TOKEN_CANDIDATE }] },
    [makeEvent(5, TOKEN_TEXT)],
    { hlsMode: 'trailer', marker: 'on' },
  )
  assert.equal(plan.hlsRepairs, 1, 'HLS 修复照旧落地')
  const text = stepText(plan.steps[0]!)
  assert.equal(text, '[已压缩-摘取 seq=5]\n' + repairWithTrailer(TOKEN_CANDIDATE, missing))
  assert.ok(text.endsWith('[restored] ' + missing.join(' ')), '尾注仍在尾部，未被标记顶掉')
  assert.equal(fidelityGuard(TOKEN_TEXT, text.replace(TOOL_COPY_MARKER_RE, '')).ok, true, '剥离标记后 100% 硬 token 保真')
})

test('剥离正则：语料侧审计可还原副本正文（防自指假阳性）', () => {
  const marked = toolCopyMarkerText('extract', 7) + '\nbody text'
  assert.equal(marked.replace(TOOL_COPY_MARKER_RE, ''), 'body text')
  assert.equal('body text'.replace(TOOL_COPY_MARKER_RE, ''), 'body text', '无标记文本不受影响')
  assert.equal(TOOL_COPY_MARKER_RE.test('\n' + marked), false, '只认行首（正文中的同形串不算标记）')
})

// ---------------------------------------------------------------------------
// 生产默认与逃生阀
// ---------------------------------------------------------------------------

test('生产默认开启（宿主硬约束下默认给 LLM 可辨信号）+ config 可显式关闭', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  const cfg = { endpoint: 'http://fake.test/v1/chat/completions', apiKey: 'test-key', model: 'test-model' }
  assert.equal(new PeratomCompressor(ctx, cfg).toolCopyMarker, true, '生产默认 on')
  assert.equal(new PeratomCompressor(ctx, { ...cfg, toolCopyMarker: false }).toolCopyMarker, false, '逃生阀可关')
})
