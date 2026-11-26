/**
 * C10 夹剪层（三态保留）契约测试——真 Session + graph 引擎宿主（factor-engine.test.ts 同款）。
 *
 * 变异锁台账：
 *  CL1 归位锁：非再生∧未覆盖的软序大 R → clipOrder + 夹剪文本（头尾留真+省略线）；
 *      变异：删归位判据/regenerable 反号 ⇒ 红。
 *  CL2 缺省关字节不变：clipEnabled=false 时发射逐字节=R1 桩形态，clipOrder 恒空；
 *      变异：缺省改开/回落链断开 ⇒ 红。
 *  CL3 族形锁：command 尾重(160/640) vs read 头重(640/160)，元数据行报实数；
 *      变异：CLIP_SHAPE 头尾对调 ⇒ 红。
 *  CL4 配对锁：夹剪 replace 保留 callId（provider 400 防线），文本 ≥30 字符下限；
 *      变异：发射丢 callId ⇒ 红。
 *  CL5 可逆锁：夹剪后 rawEventText(原 seq) 仍逐字取回原文（append-only 不破）；
 *      变异：机制误改日志本体 ⇒ 红。
 *  CL6 净账锁：同目标下 clip 记账按净收益 ⇒ 取用枚数 ≥ shadow 模式（防"名义达标"）；
 *      变异：reserve 归零/漏扣 ⇒ 红。
 *  CL7 小文本回落：净收益 < CLIP_MIN_SAVING ⇒ 归 shadow 最小桩（clip 不放字节不剪形）；
 *      变异：删收益下限 ⇒ 红。
 *  CL8 文本族锁：夹剪文本 startsWith(STUB_PREFIX)（再贴标自动排除）且不可合并
 *      （isMergeableTombstoneText=false，consolidate 永不吞）；
 *      变异：前缀漂移/误入 [elided 空格族 ⇒ 红。
 *  CL9 逃生口锁：resolveClipEnabled 只认 env==='1'（非法值=关，缺省安全）；
 *      变异：判反/真值放宽 ⇒ 红。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ArgpEngine } from '../src/argp-engine.ts'
import { FactorEngine, resolveClipEnabled, type FactorEngineHost } from '../src/factor/engine.ts'
import { CLIP_MARK, clipText } from '../src/factor/clip-shape.ts'
import { STUB_PREFIX } from '../src/factor/factor-atoms.ts'
import { isMergeableTombstone } from '../src/prune-tx.ts'
import { rawEventText, sessionEvents } from '../src/log-access.ts'
import { FACTOR_COMPACTED_MARKER } from '../src/constants.ts'

async function makeClipEngine(clipEnabled: boolean): Promise<{ host: FactorEngineHost; factor: FactorEngine }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: 'clip test persona' } })
  await ctx.plugin(ArgpEngine, { windowTokens: 100, retainTokens: 50, recencyGuard: 0, maxPasses: 8 })
  const engine = ctx.compaction as ArgpEngine
  const host = engine as unknown as FactorEngineHost
  return { host, factor: new FactorEngine(host, { clipEnabled }) }
}

function appendUser(session: Session, text: string): void {
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
}

function appendGroup(session: Session, turn: number, callId: string, tool: string, args: string, resultText: string): void {
  session.append('assistant/message', {
    stream: [], turn, step: 1,
    message: createAssistantMessage({
      source: { provider: 'test', model: 'test' },
      content: [{ type: 'text', text: 'doing ' + tool }, { type: 'tool-call', id: callId, name: tool, arguments: args } as never],
    }),
  } as never, { surfaceOp: 'append' })
  session.append('tool/call', { turn, callId, name: tool, arguments: args } as never)
  session.append('tool/result', {
    turn, step: 1,
    message: {
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: resultText }], isError: false }],
      source: { kind: 'tool', callId },
      id: 'm_' + callId,
    },
  } as never, { surfaceOp: 'append' })
}

function makeSession(id: string): Session {
  const session = Session.create(SessionId(id))
  session.append('system/message', { content: 'persona' } as never, { surfaceOp: 'append' })
  return session
}

/** 旧 bash + 旧 read（turn1）→ turn2 焦点换位（factor-engine.test.ts 同款）把 a.ts
 *  推出焦点窗 ⇒ 两枚皆软可剪；b.ts 是焦点非再生 = hard（不入序不入账）。 */
function buildOld(session: Session, bashText: string, readText: string): void {
  // 2.2.2 存档地雷锁：夹剪臂发射 tool/result replace，宿主 v4 fold 要求其在开放轮内
  // （prune-tx 预检按 detectOpenTurn 剔除轮间隙 tool 桩）；真实 pre-step 恒在轮内，
  // fixture 照实补开轮。轮号取大于全部原子轮次 ⇒ 只喂 detectOpenTurn，不动任何决策口径。
  session.append('turn/start', { turn: 999 } as never)
  appendUser(session, '开始任务')
  appendGroup(session, 1, 'cb', 'bash', '{"command":"npm test"}', bashText)
  appendGroup(session, 1, 'cr', 'read', '{"file_path":"C:/Proj/a.ts"}', readText)
  appendGroup(session, 2, 'cf', 'read', '{"file_path":"C:/Proj/b.ts"}', 'FOCUS CONTENT'.repeat(30))
  appendUser(session, '收尾')
}

function emittedTexts(session: Session): { text: string; callId: string | undefined }[] {
  const out: { text: string; callId: string | undefined }[] = []
  for (const e of sessionEvents(session) as unknown as Array<{ type: string; data?: Record<string, unknown> }>) {
    if (e.type !== 'tool/result' || e.data?.message === undefined) continue
    const msg = e.data.message as { content?: { toolCallId?: string; content?: { text?: string }[] }[] }
    for (const blk of msg.content ?? []) {
      const t = blk.content?.[0]?.text ?? ''
      if (t.startsWith(STUB_PREFIX)) out.push({ text: t, callId: blk.toolCallId })
    }
  }
  return out
}

const BIG_BASH = 'HEAD-MARKER ok\n' + 'x'.repeat(4000) + '\nerror: exit code 7 TAIL-MARKER'
const BIG_READ = 'FILEHEAD 1\n' + 'y'.repeat(4000) + '\nFILETAIL last'

/** surface 原文 dump（组剪/桩形态判据，V3 形内嵌 text 也能读到）。 */
function surfaceDump(session: Session): string {
  const evs = sessionEvents(session) as unknown as Array<{ seq: number; data?: unknown }>
  const nodes = new Set(session.surface.nodes as readonly number[])
  return [...nodes].map(s => JSON.stringify(evs[s]?.data ?? '')).join('\n')
}

/** surface 上的因子压缩检查点数（组剪默认形态：compact-checkpoint user message）。 */
function devCount(session: Session): number {
  const evs = sessionEvents(session) as unknown as Array<{ seq: number; type: string; data?: unknown }>
  const nodes = new Set(session.surface.nodes as readonly number[])
  return [...nodes].filter(s => {
    const e = evs[s]
    if (e?.type !== 'user/message') return false
    const src = (e.data as { source?: { kind?: string } } | undefined)?.source
    return src?.kind === 'compact-checkpoint' && JSON.stringify(e.data).includes(FACTOR_COMPACTED_MARKER)
  }).length
}

test('CL1 归位锁：旧大 R 入 clipOrder，夹剪文本头尾留真带省略线', async () => {
  const { host, factor } = await makeClipEngine(true)
  const session = makeSession('clip-cl1')
  host.bindSession(session)
  buildOld(session, BIG_BASH, BIG_READ)
  const decision = factor.decide(session, 6000)
  assert.ok(decision.clipEnabled, '遥测档必须可读')
  assert.equal(decision.plan.clipOrder.length, 2, 'bash+read 两枚均不可再生未覆盖 → clip')
  assert.ok(factor.compactIfNeeded(session, 6000) !== null)
  const texts = emittedTexts(session)
  assert.equal(texts.length, 2)
  for (const t of texts) {
    assert.ok(t.text.startsWith(CLIP_MARK), '夹剪文本带标记前缀')
    assert.ok(t.text.includes('中段') && t.text.includes('省略'), '省略元数据在')
    assert.ok(t.text.length < BIG_BASH.length, '净压缩')
  }
  const bash = texts.find(t => t.text.includes('bash'))!
  assert.ok(bash.text.includes('HEAD-MARKER') && bash.text.includes('TAIL-MARKER'), '头尾都在')
})

test('CL2 缺省关=组剪默认：clipOrder 空、旧 A+R 组离场 → 压缩检查点（无桩/无夹剪）', async () => {
  const { host, factor } = await makeClipEngine(false)
  const session = makeSession('clip-cl2')
  host.bindSession(session)
  buildOld(session, BIG_BASH, BIG_READ)
  const decision = factor.decide(session, 1000)
  assert.equal(decision.plan.clipOrder.length, 0, '缺省关恒空集')
  assert.equal(decision.clipEnabled, false)
  assert.ok(factor.compactIfNeeded(session, 6000) !== null)
  assert.equal(emittedTexts(session).length, 0, '新默认不产生 pointer/stub 文本')
  const dump = surfaceDump(session)
  assert.ok(!dump.includes('BIG_BASH') && !dump.includes('BIG_READ'), '旧 A+R 组原文离场')
  assert.ok(dump.includes('FOCUS CONTENT'), '焦点组保留')
  assert.equal(devCount(session), 1, '旧 bash/read 两组相邻同文 → 事务内归并一枚压缩检查点（2.2.2 桩游程治理）')
  assert.ok(!dump.includes(CLIP_MARK) && !dump.includes('省略'), '无夹剪结构线')
})

test('CL3 族形锁：同文两模板——command 尾窗 640 深，read 头窗 640 深', async () => {
  // 同一文本喂两族：近尾标记（距尾 ~409）只有尾窗 640 装得下；
  // 深头 a 串（600 连击）只有头窗 640 装得下——头尾预算对调 ⇒ 两向红。
  const T = 'HHEAD\n' + 'a'.repeat(3200) + 'MMIDNEAR\n' + 'b'.repeat(400)
  const bash = clipText({ tool: 'bash', key: undefined, seq: 3, text: T })!
  const read = clipText({ tool: 'read', key: undefined, seq: 4, text: T })!
  assert.ok(bash.includes('留头 160/尾 640'), 'command 模板实数')
  assert.ok(read.includes('留头 640/尾 160'), 'read 模板实数')
  assert.ok(!bash.includes('recall_pruned') && !read.includes('recall_pruned'), '夹剪文案禁引退役工具名（§1.6）')
  assert.ok(bash.includes('MMIDNEAR'), '尾重：近尾标记保留')
  assert.ok(!read.includes('MMIDNEAR'), '头重：尾窗 160 容不下近尾标记')
  assert.ok(read.includes('a'.repeat(600)), '头重：深头串保留（头窗 634 个 a）')
  assert.ok(!bash.includes('a'.repeat(300)), '尾重：头窗 154+尾窗前段 231 均串不满 300')
})

test('CL4 配对锁：夹剪 replace 保留 callId 且过 30 字符下限', async () => {
  const { host, factor } = await makeClipEngine(true)
  const session = makeSession('clip-cl4')
  host.bindSession(session)
  buildOld(session, BIG_BASH, BIG_READ)
  assert.ok(factor.compactIfNeeded(session, 6000) !== null)
  const texts = emittedTexts(session)
  assert.equal(texts.length, 2)
  for (const t of texts) {
    assert.ok(t.callId === 'cb' || t.callId === 'cr', 'callId 随文本一起换（配对不破）')
    assert.ok(t.text.length >= 30, '§1.2 物理下限')
  }
})

test('CL5 可逆锁：夹剪后原文逐字仍在 append-only 日志', async () => {
  const { host, factor } = await makeClipEngine(true)
  const session = makeSession('clip-cl5')
  host.bindSession(session)
  buildOld(session, BIG_BASH, BIG_READ)
  assert.ok(factor.compactIfNeeded(session, 6000) !== null)
  // 原 R 事件的 seq：surface 上被 replace 遮蔽，日志原文不动
  let checked = 0
  const events = sessionEvents(session) as unknown as Array<{ type: string; data?: Record<string, unknown> }>
  for (let seq = 0; seq < events.length; seq++) {
    const e = events[seq]!
    if (e.type !== 'tool/result' || e.data?.message === undefined) continue
    const raw = rawEventText(session, seq)
    if (raw !== null && raw.text === BIG_BASH) {
      checked++
      assert.ok(raw.text.includes('x'.repeat(4000)), '中段逐字可取')
    }
  }
  assert.ok(checked >= 1, '日志原文（append 原事件）必须仍在')
})

test('CL6 净账锁：同目标 clip 取用枚数 ≥ shadow（净收益入账防名义达标）', async () => {
  // 单枚 BIG 桩释放=size(≈4045)、clip 净=size−960(≈3085)。目标 6000：
  // shadow 两枚净=8090≥6000 取 2…同集难分叉——改用三枚同尺寸、目标=2.5×净。
  const { host: h1, factor: f1 } = await makeClipEngine(true)
  const { host: h2, factor: f2 } = await makeClipEngine(false)
  const s1 = makeSession('clip-cl6a'); h1.bindSession(s1)
  const s2 = makeSession('clip-cl6b'); h2.bindSession(s2)
  for (const s of [s1, s2]) {
    appendUser(s, '开始任务')
    for (let k = 0; k < 4; k++) appendGroup(s, 1, 'c' + k, 'bash', '{"command":"long run ' + k + '"}', 'H' + k + '\n' + 'z'.repeat(1990) + '\nT' + k)
    appendUser(s, '收尾')
  }
  // 每枚 size≈2000，净≈1040<2000 会全部回落——先验净账下限：用 BIG 两枚 + 目标略高于单枚净。
  const d1 = f1.decide(s1, 1)
  const d2 = f2.decide(s2, 1)
  assert.equal(d1.plan.clipOrder.length, 0, '小文本全回落（CL7 面）')
  // 大文本对照组：目标=2×净+1 ⇒ clip 须取 3 枚，shadow 取 2 枚
  const g1 = makeSession('clip-cl6c'); h1.bindSession(g1)
  const g2 = makeSession('clip-cl6d'); h2.bindSession(g2)
  for (const g of [g1, g2]) {
    appendUser(g, '开始任务')
    for (let k = 0; k < 3; k++) appendGroup(g, 1, 'b' + k, 'bash', '{"command":"big ' + k + '"}', 'H' + k + '\n' + 'w'.repeat(4000) + '\nT' + k)
    appendUser(g, '收尾')
  }
  // 探针：满目标跑一遍拿单枚 sizeChars（不发射，decide 纯读）——目标=2×单枚全量，
  // shadow 两枚即达标，clip 两枚净差(2×960)未达 ⇒ 必须多取一枚。
  const probe = f2.decide(g2, Number.MAX_SAFE_INTEGER)
  const perItem = probe.plan.releasedChars / probe.plan.pruneOrder.length
  const target = 2 * perItem
  const e1 = f1.decide(g1, target)
  const e2 = f2.decide(g2, target)
  assert.ok(Number.isFinite(perItem) && perItem > 960 + 2000, '探针尺寸须入夹剪收益区')
  assert.ok(e1.plan.clipOrder.length >= 1)
  assert.equal(e1.plan.shortfallChars, 0, '净账下仍须真达标')
  assert.ok(e1.plan.pruneOrder.length > e2.plan.pruneOrder.length, 'clip 须多取一枚补净差（reserve 漏扣 ⇒ 此条红）')
})

test('CL7 小文本回落：净收益不足 ⇒ 归 shadow 最小桩', async () => {
  const { host, factor } = await makeClipEngine(true)
  const session = makeSession('clip-cl7')
  host.bindSession(session)
  buildOld(session, 'short output', 'small file')
  const decision = factor.decide(session, 1)
  assert.equal(decision.plan.clipOrder.length, 0, '小文本不入 clip')
  assert.ok(factor.compactIfNeeded(session, 1) !== null)
  for (const t of emittedTexts(session)) {
    assert.ok(!t.text.startsWith(CLIP_MARK), '发射必为桩')
  }
})

test('CL8 文本族锁：夹剪文本带桩前缀、永不可合并、禁引退役工具名', async () => {
  const t = clipText({ tool: 'bash', key: 'command:x', seq: 9, text: BIG_BASH })!
  assert.ok(t.startsWith(STUB_PREFIX), 'tagRsFromLog 排除判据覆盖夹剪文本')
  assert.equal(isMergeableTombstone(t), false, '非 [elided 空格族：consolidate 永不吞')
  assert.ok(t.includes('recall_history(command:x)'), '有标签 ⇒ 指回 recall_history（模型可见通路必须真实存在）')
  assert.ok(!t.includes('recall_pruned'), '禁引退役工具名（§1.6 假通道纪律）')
})

test('CL9 逃生口锁：只认 ARGP_FACTOR_CLIP==="1"', () => {
  assert.equal(resolveClipEnabled({ ARGP_FACTOR_CLIP: '1' }), true)
  assert.equal(resolveClipEnabled({ ARGP_FACTOR_CLIP: '0' }), false)
  assert.equal(resolveClipEnabled({ ARGP_FACTOR_CLIP: 'yes' }), false, '非法值=关（缺省安全）')
  assert.equal(resolveClipEnabled({}), false)
})
