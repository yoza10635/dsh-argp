/**
 * 词表 note 注入契约（design-2.0 §1.4 注入位定稿：会话流 notice，**不进 system 前缀**）。
 * refreshVocabularyNote 直接驱动（pre-step 钩子级留给 P3 T-1 fixture 批）。
 *
 * 锁面：
 *  - 首注经 steer（notice 通道），surface 恰一条词表 note；宿主归类 X（进请求、不参剪）；
 *  - epoch 未变 = 零写入（提示静止时不打扰模型、不动缓存）；
 *  - epoch 变化 = 单节点 replace 原地重写（surface 仍恰一条；禁第二副本——X 永不参剪，
 *    多副本=不可剪地板）；裸 replace 无配对的前提=无 armed claim（pre-step 事务已收口）；
 *  - resume 经 VOCAB_NOTE_MARKER 回溯找回指针；标记判据防误认领（他引擎 note 不背锅）；
 *  - note 永不进被剪账本（user/message 不进 tagRsFromLog）。
 *
 * 变异台账（摘锁必须变红，已逐条执行）：
 *  VV1 删 epoch-equal 早退 → T2 红（静止期多写一笔）；
 *  VV2 删 resume 指针找回 → T4 红（steer 通道被再次动用）；
 *  VV3 找回判据去掉 marker 前缀检查 → T5 红（误认领他 note 并被改写）；
 *  VV4 replace 改裸 append → T3 红（surface 出第二条词表副本）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ArgpGraphEngine } from '../src/argp-graph-engine.ts'
import { FactorEngine, VOCAB_NOTE_MARKER } from '../src/factor/engine.ts'
import { sessionEvents } from '../src/log-access.ts'

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

interface EngineInternals {
  factor: FactorEngine | null
  bindSession(session: Session): void
  atomize(session: Session): Array<{ seq: number; type: string; text: string }>
}

async function bootFactor(): Promise<{ engine: ArgpGraphEngine; internals: EngineInternals; factor: FactorEngine }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: 'vocab note persona' } })
  await ctx.plugin(ArgpGraphEngine, { engine: 'factor', windowTokens: 100, retainTokens: 50, recencyGuard: 0 })
  const engine = ctx.compaction as ArgpGraphEngine
  const internals = engine as unknown as EngineInternals
  return { engine, internals, factor: internals.factor as FactorEngine }
}

/** 首剪场景：turn1 a.ts 被剪（document 键入词表），turn2 焦点转向 b.ts。 */
function prunedReadPair(session: Session, factor: FactorEngine): void {
  appendUser(session, '开始任务')
  appendGroup(session, 1, 'c1', 'read', '{"file_path":"C:/Proj/a.ts"}', 'OLD CONTENT'.repeat(50))
  appendGroup(session, 2, 'c2', 'read', '{"file_path":"C:/Proj/b.ts"}', 'NEW CONTENT'.repeat(50))
  assert.ok(factor.compactIfNeeded(session, 1000) !== null, '前置剪枝必须发射')
}

/** 测试侧 steer：模拟宿主落盘契约（steer = append 一条带 source 的 user/message，
 *  与 argp-graph-engine factorPressure 里 closure 的构造形一致）。 */
function steerSpyOf(session: Session, counter: { n: number }): (text: string) => void {
  return (text: string): void => {
    counter.n += 1
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'argp', form: 'notice', summary: 'factor vocabulary (pruned labels; recall_history keys)' },
    }), { surfaceOp: 'append' })
  }
}

interface EvLike {
  seq: number
  type: string
  data?: {
    source?: { kind?: string; form?: string }
    content?: Array<{ type?: string; text?: string }>
    message?: { content?: Array<{ type?: string; text?: string }> }
  }
}

/** user/message 的正文块在 data.content（rawEventText 同口径）；双形态兼容读。 */
function firstBlockOf(e: EvLike): { type?: string; text?: string } | undefined {
  const d = e.data
  if (d === undefined) return undefined
  if (Array.isArray(d.content)) return d.content[0]
  if (Array.isArray(d.message?.content)) return d.message.content[0]
  return undefined
}

function evs(session: Session): EvLike[] {
  return sessionEvents(session) as unknown as EvLike[]
}

/** surface 上带词表标记的节点 seq 列表（replace 链只认存活节点）。 */
function surfaceNoteSeqs(session: Session): number[] {
  const bySeq = new Map(evs(session).map(e => [e.seq, e]))
  const out: number[] = []
  for (const seq of session.surface.nodes) {
    const e = bySeq.get(seq as number)
    if (e === undefined || e.type !== 'user/message') continue
    const first = firstBlockOf(e)
    if (first?.type === 'text' && first.text !== undefined && first.text.startsWith(VOCAB_NOTE_MARKER)) out.push(seq as number)
  }
  return out
}

test('首注：steer notice 一条词表 note；宿主归类 X（进请求不参剪）；note 不入被剪账本', async () => {
  const { internals, factor } = await bootFactor()
  const session = makeSession('vocab-first')
  internals.bindSession(session)
  prunedReadPair(session, factor)
  const prunesBefore = (sessionEvents(session) as unknown as Array<{ type: string }>).filter(e => e.type === 'compaction/prune').length
  const counter = { n: 0 }
  await factor.refreshVocabularyNote(session, steerSpyOf(session, counter))
  assert.equal(counter.n, 1, '首注必须走 steer（notice 通道由宿主落盘）')
  const notes = surfaceNoteSeqs(session)
  assert.equal(notes.length, 1, 'surface 恰一条词表 note')
  const noteSeq = notes[0] as number
  const ev = evs(session).find(e => e.seq === noteSeq)
  assert.ok(ev !== undefined)
  assert.ok((firstBlockOf(ev)?.text ?? '').includes('document:c:/proj/a.ts'), '词表内容 = 被剪账本标签')
  assert.equal(ev.data?.source?.kind, 'argp', 'notice 归类：宿主按 X 处理（不参剪、UI 不伪装用户输入）')
  assert.equal(ev.data?.source?.form, 'notice')
  const atom = internals.atomize(session).find(a => a.seq === noteSeq)
  assert.ok(atom !== undefined && atom.type === 'X', '词表 note 是 X——focal 只看 U/A，注入不得放大焦点')
  const prunesAfter = (sessionEvents(session) as unknown as Array<{ type: string }>).filter(e => e.type === 'compaction/prune').length
  assert.equal(prunesAfter, prunesBefore, 'note 注入零剪枝事件（不是剪枝事务）')
  assert.ok(factor.ledger.stat('document:c:/proj/a.ts') !== null, '账本里 note 不是被剪项（账本只有 R）')
})

test('epoch 未变 = 零写入（steer 不再动用、日志一字不多）（VV1 锁）', async () => {
  const { internals, factor } = await bootFactor()
  const session = makeSession('vocab-idle')
  internals.bindSession(session)
  prunedReadPair(session, factor)
  await factor.refreshVocabularyNote(session, steerSpyOf(session, { n: 0 }))
  const n = sessionEvents(session).length
  let steered = 0
  await factor.refreshVocabularyNote(session, () => { steered += 1 })
  await factor.refreshVocabularyNote(session, () => { steered += 1 })
  assert.equal(steered, 0, 'epoch 静止期禁重写')
  assert.equal(sessionEvents(session).length, n, '静止期零写入')
})

test('epoch 变化：单节点 replace 原地重写，surface 恒恰一条（VV4 锁）', async () => {
  const { internals, factor } = await bootFactor()
  const session = makeSession('vocab-update')
  internals.bindSession(session)
  prunedReadPair(session, factor)
  await factor.refreshVocabularyNote(session, steerSpyOf(session, { n: 0 }))
  const firstSeq = surfaceNoteSeqs(session)[0] as number
  // 新剪一笔（turn3 bash 旧、turn4 焦点转移）⇒ epoch 前进
  appendGroup(session, 3, 'b1', 'bash', '{"command":"npm run build"}', 'out ' + 'x'.repeat(400))
  appendGroup(session, 4, 'c4', 'read', '{"file_path":"C:/Proj/d.ts"}', 'focus elsewhere')
  assert.ok(factor.compactIfNeeded(session, 1000) !== null, 'bash R 必须被剪（epoch 前进的燃料）')
  let steered = 0
  await factor.refreshVocabularyNote(session, () => { steered += 1 })
  assert.equal(steered, 0, '更新走 replace，不再 steer 第二条')
  const notes = surfaceNoteSeqs(session)
  assert.equal(notes.length, 1, 'surface 恒恰一条词表 note（禁副本累积——X 永不参剪）')
  assert.notEqual(notes[0], firstSeq, 'replace 副本是新事件 seq（surface 节点换代）')
  const noteEv = evs(session).find(e => e.seq === notes[0])
  const text = noteEv === undefined ? '' : (firstBlockOf(noteEv)?.text ?? '')
  assert.ok(text.includes('command:npm') && text.includes('document:c:/proj/a.ts'), '重写后两键齐（旧键不得因更新丢失）')
})

test('resume：新引擎实例按 marker 找回指针；epoch 一致时零动作零 steer（VV2 锁）', async () => {
  const { internals, factor } = await bootFactor()
  const session = makeSession('vocab-resume')
  internals.bindSession(session)
  prunedReadPair(session, factor)
  await factor.refreshVocabularyNote(session, steerSpyOf(session, { n: 0 }))
  const n = sessionEvents(session).length
  const resumed = new FactorEngine(internals as never)
  // steer 若被动用直接炸（证明没走找回路）
  await resumed.refreshVocabularyNote(session, () => { throw new Error('resume 后不应 steer 第二条') })
  assert.equal(sessionEvents(session).length, n, '找回后 epoch 一致 ⇒ 零写入')
  assert.equal(surfaceNoteSeqs(session).length, 1)
})

test('找回判据只认 marker 前缀：他引擎 note 不背锅（VV3 锁）', async () => {
  const { internals, factor } = await bootFactor()
  const session = makeSession('vocab-marker')
  internals.bindSession(session)
  prunedReadPair(session, factor)
  await factor.refreshVocabularyNote(session, steerSpyOf(session, { n: 0 }))
  const ownSeq = surfaceNoteSeqs(session)[0] as number
  // 尾置一条形似而非 marker 前缀的 argp note（自动续写提示同族形态）
  appendUser(session, 'argp notice from another channel — must not be claimed as vocabulary')
  const plainSeq = (sessionEvents(session) as unknown as Array<{ seq: number }>).length - 1
  // resume + 新剪一笔推 epoch ⇒ 找回必须落在自己的 note 上
  const resumed = new FactorEngine(internals as never)
  await resumed.refreshVocabularyNote(session, () => { throw new Error('找回成功则不该 steer') })
  appendGroup(session, 3, 'b1', 'bash', '{"command":"npm run lint"}', 'out ' + 'y'.repeat(400))
  appendGroup(session, 4, 'c4', 'read', '{"file_path":"C:/Proj/e.ts"}', 'focus elsewhere')
  assert.ok(resumed.compactIfNeeded(session, 1000) !== null)
  await resumed.refreshVocabularyNote(session, () => { throw new Error('更新走 replace，不该 steer') })
  const notes = surfaceNoteSeqs(session)
  assert.equal(notes.length, 1, '词表 note 仍恰一条（他 note 未被认领改写）')
  assert.notEqual(notes[0], plainSeq, 'replace 落点不是他引擎 note')
  assert.notEqual(notes[0], ownSeq, 'surface 节点已换代')
  const plainEv = evs(session).find(e => e.seq === plainSeq)
  const plainText = plainEv === undefined ? '' : (firstBlockOf(plainEv)?.text ?? '')
  assert.ok(plainText.startsWith('argp notice'), '他 note 原文逐字未动')
})
