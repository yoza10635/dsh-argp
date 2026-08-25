// spike 30：引擎级验证 tool 占位墓碑路径——构造"未被 cites 引用的大 R"，压缩时应
// R 独立剪（issuer A 保留）+ 生成 tool/result 占位墓碑（配对 A 的 tool_calls 防 400）。
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { ArgpGraphEngine } from '../src/argp-graph-engine.ts'

async function main(): Promise<void> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: 'argp spike30 tool-tombstone-engine' } })
  await ctx.plugin(ArgpGraphEngine, { windowTokens: 8_000, retainTokens: 2_000, maxPasses: 64, recencyGuard: 0 })
  const engine = ctx.compaction as ArgpGraphEngine
  const session = Session.create(SessionId('spike30'))

  // 构造：user + A1(tool-call call_1) + 大 R（90K 字符，未被 cites 引用）+ A2 + A3
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'user anchor' }], source: { kind: 'user' } }) as never, { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn: 1, step: 1,
    message: createAssistantMessage({
      source: { provider: 'test', model: 'test' },
      content: [{ type: 'tool-call', id: 'call_1' as never, name: 'read_file', arguments: '{"path":"x"}' }],
    }),
  }, { surfaceOp: 'append' })
  const aSeq = session.events.length - 1
  const big = 'ref-module line ' + ('x'.repeat(30) + '\n').repeat(1200) // ~90K 字符
  session.append('tool/result', {
    turn: 1, step: 1,
    message: createToolResultMessage({ callId: 'call_1' as never, content: [{ type: 'text', text: big }], isError: false }),
  }, { surfaceOp: 'append' })
  const rSeq = session.events.length - 1
  session.append('assistant/message', {
    turn: 2, step: 1,
    message: createAssistantMessage({ source: { provider: 'test', model: 'test' }, content: [{ type: 'text', text: 'A2: done.' }] }),
  }, { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn: 3, step: 1,
    message: createAssistantMessage({ source: { provider: 'test', model: 'test' }, content: [{ type: 'text', text: 'A3: latest anchor.' }] }),
  }, { surfaceOp: 'append' })

  engine.setSession(session)
  // 调试：visibleChars / R 文本长度 / eventText
  const engAny = engine as unknown as {
    visibleChars(s: Session): number
    atomize(s: Session): { id: number; seq: number; type: string; text: string }[]
    measureTokens(s: Session): { contextTokens: number; surfaceTokens: number }
  }
  console.log('[30][dbg] visibleChars=' + engAny.visibleChars(session))
  const atoms = engAny.atomize(session)
  console.log('[30][dbg] atoms=' + atoms.length + ' R文本=' + atoms.filter(a => a.type === 'R').map(a => a.text.length))
  const m = engAny.measureTokens(session)
  console.log('[30][dbg] measureTokens=' + JSON.stringify(m))
  const result = await engine.compactIfNeeded({ session } as never, 'pressure', new AbortController().signal)
  console.log('[30] compactIfNeeded: ' + (result === null ? 'null（未触发）' : 'TRIGGERED shadowed=' + result.shadowedSeqs.length))

  // 检查 R 是否被剪 + A 是否保留 + tool 墓碑
  const shadowed = new Set(result?.shadowedSeqs ?? [])
  console.log('[30] R(seq' + rSeq + ') 被剪: ' + shadowed.has(rSeq))
  const surface = new Set(session.surface.nodes)
  console.log('[30] A(seq' + aSeq + ') 保留: ' + surface.has(aSeq))

  let toolTombstones = 0
  for (const e of session.events) {
    const ev = e as { type?: string; surfaceOp?: unknown }
    if (ev.type === 'tool/result' && ev.surfaceOp !== undefined && typeof ev.surfaceOp === 'object'
      && (ev.surfaceOp as { op?: string }).op === 'replace') toolTombstones += 1
  }
  console.log('[30] tool/result 占位墓碑数: ' + toolTombstones)
  const ok = toolTombstones > 0 && surface.has(aSeq)
  console.log('[30] VERDICT: ' + (ok ? 'PASS —— 大 R 独立剪 + tool 墓碑配对 A（不 400）' : 'FAIL'))
  await ctx.fiber.dispose()
}

void main()
