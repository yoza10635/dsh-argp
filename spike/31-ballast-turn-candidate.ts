// spike 31：复现"压载轮内压缩剪不动"——大 R（ref-module 读取结果）是 latestTurn 原子，
// 被 turnGuard 保护 → 压缩只能剪零星旧原子 → 上下文净增 → 死循环。
// 目的：确认 turnGuard/recencyGuard 对压载大 R 的拦截（零 LLM 成本，引擎内临时 _diag 统计）。
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { ArgpGraphEngine } from '../src/argp-graph-engine.ts'

async function main(): Promise<void> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: 'argp spike31 ballast-turn' } })
  // 与 A 臂同参：recencyGuard=4 默认、turnGuard=1 默认、maxPasses 足够
  await ctx.plugin(ArgpGraphEngine, { windowTokens: 8_000, retainTokens: 2_000, maxPasses: 64 })
  const engine = ctx.compaction as ArgpGraphEngine
  const session = Session.create(SessionId('spike31'))

  // 30 轮普通小对话（turn 1-30，模拟实现段 12-27 + 读回）
  for (let t = 1; t <= 30; t += 1) {
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `u${t}: task constraint item ${t} ${'x'.repeat(40)}` }],
      source: { kind: 'user' },
    }) as never, { surfaceOp: 'append' })
    session.append('assistant/message', {
      turn: t, step: 1,
      message: createAssistantMessage({
        source: { provider: 'test', model: 'test' },
        content: [{ type: 'text', text: `A${t}: implementation ${t} ${'y'.repeat(60)}` }],
      }),
    }, { surfaceOp: 'append' })
  }

  // 压载轮：turn 31 读 ref-module —— user + A(tool-call) + 大 R（~90K 字符，latestTurn 原子）
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'u31: read ref-module.ts in full and summarize' }],
    source: { kind: 'user' },
  }) as never, { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn: 31, step: 1,
    message: createAssistantMessage({
      source: { provider: 'test', model: 'test' },
      content: [{ type: 'tool-call', id: 'call_31' as never, name: 'read_file', arguments: '{"path":"ref-module.ts"}' }],
    }),
  }, { surfaceOp: 'append' })
  const big = Array.from({ length: 1300 }, (_, i) => `export function fn${i}(a: number, b: string): boolean { return a > 0 && b.length > ${i % 7}; } // line ${i}`).join('\n')
  session.append('tool/result', {
    turn: 31, step: 1,
    message: createToolResultMessage({ callId: 'call_31' as never, content: [{ type: 'text', text: big }], isError: false }),
  }, { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn: 31, step: 1,
    message: createAssistantMessage({
      source: { provider: 'test', model: 'test' },
      content: [{ type: 'text', text: 'A31: extractCites is the key function.' }],
    }),
  }, { surfaceOp: 'append' })

  engine.setSession(session)
  const engAny = engine as unknown as {
    visibleChars(s: Session): number
    measureTokens(s: Session): { contextTokens: number; surfaceTokens: number }
    atomize(s: Session): { id: number; seq: number; type: string; text: string; turn: number }[]
    _diag: Record<string, number>
  }
  console.log('[31][dbg] visibleChars=' + engAny.visibleChars(session))
  console.log('[31][dbg] measureTokens=' + JSON.stringify(engAny.measureTokens(session)))
  const atoms = engAny.atomize(session)
  console.log('[31][dbg] atoms=' + atoms.length
    + ' U=' + atoms.filter(a => a.type === 'U').length
    + ' A=' + atoms.filter(a => a.type === 'A').length
    + ' R=' + atoms.filter(a => a.type === 'R').length
    + ' 最新turn=' + Math.max(...atoms.map(a => a.turn)))
  const bigR = atoms.filter(a => a.type === 'R')
  console.log('[31][dbg] R 原子 turn 分布: ' + bigR.map(a => `seq${a.seq}(turn${a.turn})`).join(','))

  const result = await engine.compactIfNeeded({ session } as never, 'pressure', new AbortController().signal)
  console.log('[31] compactIfNeeded: ' + (result === null ? 'null（未触发）' : 'TRIGGERED shadowed=' + result.shadowedSeqs.length))
  console.log('[31][diag] 拦截统计: ' + JSON.stringify(engAny._diag ?? {}))
  if (result !== null) {
    const bigRSeq = bigR[0]?.seq
    console.log('[31] 大 R(seq' + bigRSeq + ') 被剪: ' + result.shadowedSeqs.includes(bigRSeq as number))
    const charsAfter = engAny.visibleChars(session)
    console.log('[31] 压缩后 visibleChars: ' + charsAfter + '（剪 ' + (133733 - charsAfter) + ' 字符 = '
      + ((1 - charsAfter / 133733) * 100).toFixed(1) + '%）')
    console.log('[31] retain 目标: 2000 token ≈ ' + 2000 * 3.5 + ' 字符')
  }
  await ctx.fiber.dispose()
}

void main()
