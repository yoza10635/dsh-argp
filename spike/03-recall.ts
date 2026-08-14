/**
 * spike 3：recall 工具 + PromptSection 契约（设计稿 §10 spike 3，M1 最后一棒）
 *
 * 最小装配：Context + SystemPrompt + ToolRuntime + ArgpRecallEngine（无 LLM/AgentLoop）
 *
 * 判决项：
 *  A. ArgpRecallEngine 挂载为 ctx.compaction，recall_pruned 出现在 ctx.tools.schemas()
 *  B. argp-contract section 注入 systemPrompt assembly（动态 text 函数被求值）
 *  C. recall 闭环：剪 T1 a2..r3 后，recall(2)/recall(3) 从 shadowed 日志找回原文；
 *     recall(1)（未剪节点）与 recall(99)（不存在）均正确未命中
 *  D. 工具执行管线：ctx.tools.execute 真实派发 recall_pruned，命中/未命中语义正确
 *  E. 追加剪枝后 recall 立即可见（append-only 日志引用语义）
 */
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { CallId, createMessage, createUserMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { ArgpRecallEngine } from '../src/recall-engine.ts'

// ---------- 场景构造：单轮 user + assistant(tool-call) + tool/result，然后剪 a2..r3 ----------
function buildPrunedSession(): { session: Session; prunedText: string } {
  const session = Session.create(SessionId('spike-3'))
  const prunedText = 'NEEDLE-FACT-7749 '.repeat(30).trim()
  const callId = CallId('call-1')
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'what did the probe find?' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn: 1, step: 1,
    message: createMessage({ role: 'assistant', content: [{ type: 'tool-call', id: callId, name: 'probe', arguments: '{}' }] }),
  }, { surfaceOp: 'append' })
  session.append('tool/result', {
    turn: 1, step: 1,
    message: createToolResultMessage({ callId, content: [{ type: 'text', text: prunedText }], isError: false }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  session.append('turn/start', { turn: 2 })
  // 剪枝：a2..r3 → user tombstone（spike 2 已验证路径）
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: '[elided seq=2,3: tool step pruned by ARGP; recall_pruned(seq) to retrieve]' }],
    source: { kind: 'plugin', plugin: 'argp-spike' },
  }), { surfaceOp: { op: 'replace', start: 2, end: 3 }, sourceEventSeqs: [2, 3] })
  return { session, prunedText }
}

const failures: string[] = []
const verdict = (name: string, ok: boolean, detail: string): void => {
  console.log((ok ? '[PASS ' : '[FAIL ') + name + '] ' + detail)
  if (!ok) failures.push(name + ': ' + detail)
}

// ---------- 装配 ----------
const ctx = new Context()
await ctx.plugin(SystemPrompt)
await ctx.plugin(ToolRuntime)
await ctx.plugin(ArgpRecallEngine)
// ctx.plugin 返回 cordis fiber；服务实例由 Service 构造器注册在 ctx.compaction
const engine = ctx.compaction as ArgpRecallEngine
const { session, prunedText } = buildPrunedSession()
engine.setSession(session)

// ---------- 判决 A：挂载 + 工具 schema ----------
{
  const mounted = ctx.compaction instanceof ArgpRecallEngine
  const schemas = ctx.tools.schemas()
  const recallSchema = schemas.find(s => s.name === 'recall_pruned')
  verdict('A-mount-and-schema', mounted && recallSchema !== undefined,
    'ctx.compaction is ArgpRecallEngine=' + mounted + '; tools=' + schemas.map(s => s.name).join(',')
    + '; params=' + JSON.stringify(recallSchema?.parameters))
}

// ---------- 判决 B：契约 section 进 assembly ----------
{
  const assembly = await ctx.systemPrompt.assemble()
  const section = assembly.sections.find(s => s.name === 'argp-contract')
  const toolsInAssembly = assembly.tools.map(t => t.name)
  verdict('B-contract-section', section !== undefined && section.text.includes('recall_pruned') && toolsInAssembly.includes('recall_pruned'),
    'section order=150 present=' + (section !== undefined) + '; text 摘要: ' + (section?.text.slice(0, 80) ?? '(无)')
    + '; assembly.tools=' + toolsInAssembly.join(','))
}

// ---------- 判决 C：recall 直调闭环 ----------
{
  const hit2 = engine.recall(2)
  const hit3 = engine.recall(3)
  const missKept = engine.recall(1)
  const missVoid = engine.recall(99)
  const ok = hit2 !== null && hit2.includes('tool-call probe') && hit3 !== null && hit3.includes('NEEDLE-FACT-7749')
    && missKept === null && missVoid === null
  verdict('C-recall-closed-loop', ok,
    'recall(2) ' + (hit2 !== null ? 'hit(tool-call 节点, text="' + hit2.slice(0, 40) + '")' : 'miss')
    + '; recall(3) ' + (hit3 !== null && hit3.includes(prunedText.slice(0, 16)) ? 'hit(原文完整找回, ' + hit3.length + ' chars)' : 'hit-but-wrong')
    + '; recall(1)=' + missKept + '; recall(99)=' + missVoid)
}

// ---------- 判决 D：ctx.tools.execute 真实派发 ----------
{
  const exec = { signal: new AbortController().signal, callId: CallId('spike-3-hit'), name: 'recall_pruned', arguments: { seq: 3 } }
  const hitResult = await ctx.tools.execute(exec)
  const hitText = hitResult.content[0]?.type === 'text' ? hitResult.content[0].text : ''
  const missResult = await ctx.tools.execute({ signal: new AbortController().signal, callId: CallId('spike-3-miss'), name: 'recall_pruned', arguments: { seq: 99 } })
  const missText = missResult.content[0]?.type === 'text' ? missResult.content[0].text : ''
  const ok = !hitResult.isError && hitText.includes('NEEDLE-FACT-7749') && missText.includes('not a pruned node')
  verdict('D-tool-dispatch', ok, 'hit isError=' + hitResult.isError + ', text 含 needle=' + hitText.includes('NEEDLE-FACT-7749')
    + '; miss text="' + missText + '"; engine.recallCalls=' + JSON.stringify(engine.recallCalls))
}

// ---------- 判决 E：追加剪枝后 recall 立即可见 ----------
{
  // 再剪 turn2 的一个节点：先追加一条 user 消息再剪它
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'SECOND-NEEDLE late fact' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  const lateSeq = session.events.length - 1
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: '[elided seq=' + lateSeq + ']' }],
    source: { kind: 'plugin', plugin: 'argp-spike' },
  }), { surfaceOp: { op: 'replace', start: lateSeq, end: lateSeq }, sourceEventSeqs: [lateSeq] })
  const recovered = engine.recall(lateSeq)
  verdict('E-append-visibility', recovered !== null && recovered.includes('SECOND-NEEDLE'),
    'late seq=' + lateSeq + ' recall ' + (recovered !== null ? 'hit: "' + recovered + '"' : 'miss'))
}

await ctx.fiber.dispose()

console.log(failures.length === 0
  ? 'SPIKE 3 VERDICT: PASS（recall 工具 + 契约 section 全链路验证，M1 收官）'
  : 'SPIKE 3 VERDICT: FAIL（' + failures.length + ' 项未过：' + failures.join('; ') + '）')
process.exit(failures.length === 0 ? 0 : 1)
