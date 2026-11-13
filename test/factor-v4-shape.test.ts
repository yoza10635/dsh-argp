/**
 * tool/result **V4 宿主形**（role:'tool' + 顶层 toolCallId/isError + content 单 text 块）
 * 的因子臂回归锁（2026-11-11 ai-server npm headless 0.2.2-rc.1 生产病灶）。
 *
 * 病灶：tagRsFromLog 只认 V3 形 content[0].toolCallId ⇒ V4 会话全部 R 的 callId
 * undefined ⇒ compactIfNeeded 发射循环逐条 continue ⇒ 决策剪 11 枚、replace 零落盘，
 * 全程静默（DIAG 取证见 docs §9.21 补记 3）。prune-tx 发射骨架本就双形兼容，
 * 漏点仅此一处。
 *
 * 变异纪律：摘除 factor-atoms.ts 的 `?? msg?.toolCallId` 兜底 ⇒ 两测全红。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ArgpGraphEngine } from '../src/argp-graph-engine.ts'
import { FactorEngine, type FactorEngineHost } from '../src/factor/engine.ts'
import { tagRsFromLog, type EventLike } from '../src/factor/factor-atoms.ts'
import { sessionEvents, resolveRootSeqs } from '../src/log-access.ts'

/** npm headless 实测形（session.v4.jsonl.zstd 原样）：message 顶层挂 toolCallId/isError。 */
function appendGroupV4(session: Session, turn: number, callId: string, tool: string, args: string, resultText: string): void {
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
      role: 'tool',
      source: { kind: 'tool', callId },
      toolCallId: callId,
      content: [{ type: 'text', text: resultText }],
      isError: false,
      id: 'm_' + callId,
    },
  } as never, { surfaceOp: 'append' })
}

function makeSession(id: string): Session {
  const session = Session.create(SessionId(id))
  session.append('system/message', { content: 'v4 persona' } as never, { surfaceOp: 'append' })
  return session
}

function appendUser(session: Session, turn: number, text: string): void {
  session.append('user/message', { ...createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), turn } as never, { surfaceOp: 'append' })
}

async function makeV4Factor(): Promise<{ host: FactorEngineHost; factor: FactorEngine }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: 'v4 shape persona' } })
  await ctx.plugin(ArgpGraphEngine, { windowTokens: 100, retainTokens: 50, recencyGuard: 0, maxPasses: 8 })
  const host = ctx.compaction as unknown as FactorEngineHost
  host.fileSnapshot = (key: string) => ({ key, mtimeMs: 1000, size: 100, exists: true })
  return { host, factor: new FactorEngine(host, {}) }
}

test('tagRsFromLog V4 形：顶层 toolCallId 提取 callId + 经 tool/call 归名（V3 fixture 对照）', () => {
  const session = makeSession('v4-atoms')
  appendUser(session, 1, '看两个文件')
  appendGroupV4(session, 1, 'c1', 'read', '{"file_path":"C:/Proj/a.ts"}', 'V4 CONTENT ' + 'A'.repeat(300))
  // SessionEvent 各变体的 data 是具体消息类型（无索引签名）；tagRsFromLog 的门面类型
  // EventLike.data 走 Record——运行时无差，类型层桥一下（8de0927 存量裂口，typecheck 门修）。
  const events = sessionEvents(session) as readonly EventLike[]
  const tags = tagRsFromLog(events, undefined, seq => resolveRootSeqs(events, seq))
  assert.equal(tags.size, 1, 'V4 形 R 必须入贴标')
  const r = [...tags.values()][0] as { callId: string | undefined; tool: string }
  assert.equal(r.callId, 'c1', '★V4 顶层 toolCallId 必须兜底提取（病灶行）')
  assert.equal(r.tool, 'read', 'callId 通了才能经 tool/call 归名')
})

test('端到端 V4 形会话：compactIfNeeded 真落 replace 事务（发射不再静默空转）', async () => {
  const { factor } = await makeV4Factor()
  const session = makeSession('v4-e2e')
  appendUser(session, 1, '先看 a 再看 b')
  appendGroupV4(session, 1, 'c1', 'read', '{"file_path":"C:/Proj/a.ts"}', 'OLD ' + 'A'.repeat(900))
  appendGroupV4(session, 2, 'c2', 'read', '{"file_path":"C:/Proj/b.ts"}', 'NEW ' + 'B'.repeat(900))
  const result = factor.compactIfNeeded(session, 500)
  assert.notEqual(result, null, 'V4 形会话必须剪成功（旧形下决策过但发射全 continue）')
  const evs = sessionEvents(session) as unknown as Array<{ seq: number }>
  const dump = [...session.surface.nodes].map(s => JSON.stringify(evs[s as number])).join('\n')
  assert.ok(dump.includes('"kind":"compact-checkpoint"') && dump.includes('已压缩剪枝次要原子'),
    'surface 必须出现压缩检查点（A+R 组 replace 真改写，非仅内存决策）')
  assert.ok(!dump.includes('OLD ' + 'A'.repeat(900)), '旧 A+R 组原文离场（surface 判据；日志原文恒留）')
})
