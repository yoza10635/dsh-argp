/**
 * spike 2：surfaceOp 剪枝路径验证（关键判别，设计稿 §10 spike 2 / §8.3）
 *
 * 事件序号实况（每轮 6 个事件）：T1 u1 a2 r3 | T2 u7 a8 r9 | T3 u13 a14 r15 | T4 u19 a20 r21（末轮留 open turn）
 * 已实证语义（前两轮 dump + 源码确认）：
 *  - replace 事件获得新 seq（追加至日志尾），但在 surface 上**原位插入**被替换区间的位置；
 *  - tool/result 投影为 user 角色消息、内含 tool-result 块（孤儿检测按块形状扫描）；
 *  - 配对助手对 corrupt surface 直接 throw（throw 即检出）；
 *  - assertToolResultRewrite：tool/result 单节点改写只许变块 content，message 其余字段（含随机 id）必须相等
 *    → 合规构造 = 克隆原 message 保留 id 仅换 content；
 *  - invariant.ts：tool/result replace 必须发生在 open turn 内 → 场景末轮保持 open。
 *
 * 判决项：
 *  1. 路径 a（多段 replace）：剪 T1 的 a2..r3（保留 u1）→ tombstone 原位落位、切点平衡、无孤儿、token 回收
 *  2. 负例：只剪 a8 不剪 r9 → append 拒绝 / 孤儿 / pairing throw，至少一个被捕获
 *  3. 路径 b（单节点占位改写）：r15 → 合规占位（克隆原 message 仅换 content）→ 节点数不减、字符量大降、
 *     配对在正确切点上平衡（a14 之前 / 占位新节点之后；被替换 seq 退出 surface）
 *  3n. 路径 b 越界形态：user tombstone 覆写 tool/result → 实证为合法能力（assertToolResultRewrite 仅约束
 *      tool/result 作替换事件），但留下孤儿 tool-call → 配对必须由 ARGP 剪除决策自保（整对同剪）
 *  4. 顺序两段 replace 组合：先剪 T1 再剪 T3 → 二次 replace 按现存 seq 指认仍正确
 *  5. assistant 节点剪除：a11..r12 整对 → user tombstone → 请求重建干净
 */
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import {
  CallId,
  createMessage,
  createUserMessage,
  createToolResultMessage,
} from '@deepseek-ai/dsh-llm'
import { toolPairingBalancedAfter, toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction'

// ---------- 场景构造（末轮 T4 留 open turn，满足 tool/result replace 的 open-turn 约束） ----------
function buildSession(): Session {
  const session = Session.create(SessionId('spike-2'))
  for (let turn = 1; turn <= 4; turn += 1) {
    const callId = CallId('call-' + turn)
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'user turn ' + turn }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('assistant/message', {
      turn,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'tool-call', id: callId, name: 'probe', arguments: '{}' }],
      }),
    }, { surfaceOp: 'append' })
    session.append('tool/result', {
      turn,
      step: 1,
      message: createToolResultMessage({
        callId,
        content: [{ type: 'text', text: 'RESULT '.repeat(200) + ' turn ' + turn }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    if (turn < 4) session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  return session
}

function tombstone(text: string) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'argp-spike' },
  })
}

const surfaceSeqs = (session: Session): number[] => [...session.surface.nodes]
const nodeEvent = (session: Session, seq: number) => session.events[seq]

/** 从 surface 推导 LLM 消息并按块形状扫描孤儿（tool-call 无配对 tool-result / 反之）。 */
function orphanReport(session: Session): string[] {
  const messages = session.deriveMessages()
  const problems: string[] = []
  const openCalls = new Map<string, number>()
  messages.forEach((message, index) => {
    for (const block of message.content) {
      if (block.type === 'tool-call') openCalls.set(block.id, index)
      if (block.type === 'tool-result') {
        const id = (block as { toolCallId?: string }).toolCallId
        if (id === undefined) { problems.push('msg[' + index + '] tool-result without toolCallId'); continue }
        if (!openCalls.delete(id)) problems.push('msg[' + index + '] orphan tool-result for ' + id)
      }
    }
  })
  for (const [id, index] of openCalls) problems.push('msg[' + index + '] unanswered tool-call ' + id)
  return problems
}

function surfaceChars(session: Session): number {
  let total = 0
  for (const message of session.deriveMessages()) {
    for (const block of message.content) {
      if (block.type === 'text') total += block.text.length
      if (block.type === 'tool-result') {
        for (const inner of (block as { content: { type: string; text?: string }[] }).content ?? []) {
          if (inner.type === 'text') total += inner.text?.length ?? 0
        }
      }
    }
  }
  return total
}

/** 配对助手对 corrupt surface 会 throw；throw 视为"检出"。 */
function safeBalance(fn: () => boolean): { ok: boolean; threw: string } {
  try { return { ok: fn(), threw: '' } } catch (error) {
    return { ok: false, threw: error instanceof Error ? error.message : String(error) }
  }
}

const failures: string[] = []
const verdict = (name: string, ok: boolean, detail: string): void => {
  console.log((ok ? '[PASS ' : '[FAIL ') + name + '] ' + detail)
  if (!ok) failures.push(name + ': ' + detail)
}

// ---------- 判决 1：路径 a 多段 replace（剪 T1 的 a2..r3，保留 u1） ----------
{
  const session = buildSession()
  const before = surfaceSeqs(session)
  const charsBefore = surfaceChars(session)
  const tombSeq = session.append('user/message', tombstone('[ARGP tombstone: turn 1 pruned]'),
    { surfaceOp: { op: 'replace', start: 2, end: 3 }, sourceEventSeqs: [2, 3] }).seq

  const after = surfaceSeqs(session)
  // tombstone 原位插入：surface 应为 [1, tombSeq, 7, 8, ...]
  const inPlace = after.length === before.length - 1 && after[0] === 1 && after[1] === tombSeq
  const balLeft = safeBalance(() => toolPairingBalancedAfter(session, 1))
  const balRight = safeBalance(() => toolPairingBalancedBefore(session, 7))
  const orphans = orphanReport(session)
  verdict('1a-replace', inPlace, 'surface ' + JSON.stringify(before) + ' -> ' + JSON.stringify(after) + '; tombstone seq=' + tombSeq)
  verdict('1b-pairing', balLeft.ok && balRight.ok, 'cut after u1=' + balLeft.ok + ', cut before T2-u(seq7)=' + balRight.ok)
  verdict('1c-orphans', orphans.length === 0, orphans.length === 0
    ? 'deriveMessages clean; chars ' + charsBefore + ' -> ' + surfaceChars(session) + ' (回收 ' + (charsBefore - surfaceChars(session)) + ')'
    : orphans.join('; '))
}

// ---------- 判决 2：负例——只剪 a8 不剪 r9（不配对区间） ----------
{
  const session = buildSession()
  let rejected = ''
  try {
    session.append('user/message', tombstone('[bad prune]'),
      { surfaceOp: { op: 'replace', start: 8, end: 8 }, sourceEventSeqs: [8] })
  } catch (error) {
    rejected = error instanceof Error ? error.message : String(error)
  }
  if (rejected !== '') {
    verdict('2-unpaired', true, 'append 层直接拒绝：' + rejected.slice(0, 140))
  } else {
    let orphans: string[] = []
    let detectErr = ''
    try { orphans = orphanReport(session) } catch (error) { detectErr = error instanceof Error ? error.message : String(error) }
    const bal = safeBalance(() => toolPairingBalancedBefore(session, 9))
    const caught = orphans.length > 0 || detectErr !== '' || bal.threw !== ''
    verdict('2-unpaired', caught, caught
      ? 'append 未拒绝但检出后果——orphans: ' + (orphans.join('; ') || '(无)') + '; derive/pairing 异常: ' + (detectErr || bal.threw || '(无)')
      : '危险：不配对 replace 既未被拒绝也未产生可检出后果')
  }
}

// ---------- 判决 3：路径 b 合规形态——r15 单节点改写，克隆原 message 保留 id 仅换 content ----------
{
  const session = buildSession()
  const nodesBefore = surfaceSeqs(session).length
  const charsBefore = surfaceChars(session)
  const original = nodeEvent(session, 15) as { data: { message: { id: string; role: 'user'; source: unknown } } }
  const placeholderSeq = session.append('tool/result', {
    turn: 3,
    step: 1,
    message: {
      ...original.data.message,
      content: [{ type: 'tool-result', toolCallId: CallId('call-3'), content: [{ type: 'text', text: '[elided: content pruned by ARGP, recall via catalog]' }], isError: false }],
    },
  }, { surfaceOp: { op: 'replace', start: 15, end: 15 }, sourceEventSeqs: [15] }).seq

  const nodesAfter = surfaceSeqs(session).length
  const charsAfter = surfaceChars(session)
  // 被替换 seq 退出 surface，占位新节点原位顶替：平衡断言落在 a14 之前与占位节点之后
  const balBefore = safeBalance(() => toolPairingBalancedBefore(session, 14))
  const balAfter = safeBalance(() => toolPairingBalancedAfter(session, placeholderSeq))
  const onSurface = surfaceSeqs(session).includes(placeholderSeq) && !surfaceSeqs(session).includes(15)
  const orphans = orphanReport(session)
  verdict('3a-placeholder', nodesAfter === nodesBefore && charsAfter < charsBefore && onSurface,
    'nodes ' + nodesBefore + ' -> ' + nodesAfter + '; chars ' + charsBefore + ' -> ' + charsAfter + '; placeholder seq=' + placeholderSeq + ' on surface, seq15 retired')
  verdict('3b-pairing', balBefore.ok && balAfter.ok && orphans.length === 0,
    'cutBefore(a14)=' + balBefore.ok + ' cutAfter(placeholder)=' + balAfter.ok + ' orphans=' + orphans.length)
}

// ---------- 判决 3n：user tombstone 覆写 tool/result——实证合法，但必留孤儿（配对须 ARGP 自保） ----------
{
  const session = buildSession()
  let rejected = ''
  try {
    session.append('user/message', tombstone('[tombstone over tool/result]'),
      { surfaceOp: { op: 'replace', start: 15, end: 15 }, sourceEventSeqs: [15] })
  } catch (error) {
    rejected = error instanceof Error ? error.message : String(error)
  }
  if (rejected !== '') {
    verdict('3n-toolresult-override', true, 'append 层拒绝（约束比预期更严）：' + rejected.slice(0, 120))
  } else {
    const orphans = orphanReport(session)
    verdict('3n-toolresult-override', orphans.length > 0, orphans.length > 0
      ? '覆写合法且孤儿可检出（配对必须整对同剪，ARGP 责任）：' + orphans.join('; ')
      : '危险：覆写放行且无孤儿检出，配对约束无兜底')
  }
}

// ---------- 判决 4：顺序两段 replace 组合（先剪 T1 a2..r3，再剪 T3 a14..r15） ----------
{
  const session = buildSession()
  session.append('user/message', tombstone('[tombstone T1]'),
    { surfaceOp: { op: 'replace', start: 2, end: 3 }, sourceEventSeqs: [2, 3] })
  let secondOk = true
  let secondDetail = ''
  try {
    session.append('user/message', tombstone('[tombstone T3]'),
      { surfaceOp: { op: 'replace', start: 14, end: 15 }, sourceEventSeqs: [14, 15] })
  } catch (error) {
    secondOk = false
    secondDetail = error instanceof Error ? error.message : String(error)
  }
  const after = surfaceSeqs(session)
  const orphans = orphanReport(session)
  const tombstones = after.filter(seq => {
    const event = nodeEvent(session, seq)
    return event?.type === 'user/message' && JSON.stringify(event.data).includes('tombstone')
  }).length
  verdict('4-two-pass', secondOk && tombstones === 2 && orphans.length === 0,
    secondOk
      ? 'two sequential replaces landed; surface=' + JSON.stringify(after) + '; tombstones=' + tombstones + '; orphans=' + orphans.length
      : 'second replace rejected: ' + secondDetail.slice(0, 140))
}

// ---------- 判决 5：assistant 节点剪除（a20..r21 整对 → user tombstone） ----------
{
  const session = buildSession()
  const charsBefore = surfaceChars(session)
  session.append('user/message', tombstone('[ARGP tombstone: step pruned, graph node dropped]'),
    { surfaceOp: { op: 'replace', start: 20, end: 21 }, sourceEventSeqs: [20, 21] })
  const after = surfaceSeqs(session)
  const orphans = orphanReport(session)
  const lastKept = after[after.length - 2] ?? -1
  const bal = safeBalance(() => toolPairingBalancedAfter(session, lastKept))
  verdict('5-assistant-pair-prune', orphans.length === 0 && bal.ok,
    'surface=' + JSON.stringify(after) + '; orphans=' + orphans.length
    + '; chars ' + charsBefore + ' -> ' + surfaceChars(session))
}

console.log(failures.length === 0
  ? 'SPIKE 2 VERDICT: PASS（surfaceOp 双路径与配对不变式全部验证）'
  : 'SPIKE 2 VERDICT: FAIL（' + failures.length + ' 项未过：' + failures.join('; ') + '）')
process.exit(failures.length === 0 ? 0 : 1)

