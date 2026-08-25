// spike 29：验证"tool/result 占位墓碑"方案可行性
// 剪 R 时用 tool/result 类型墓碑替换（保留 callId + 说明文本），
// 验证：① dsh schema 接受合成 tool/result；② deriveMessages 输出 A.tool_calls 与
// 墓碑 tool-result block 配对（→ wire 序列化必输出 assistant.tool_calls + role:"tool" → 不 400）
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'

async function main(): Promise<void> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: 'argp spike29 tool-tombstone' } })
  const session = Session.create(SessionId('spike29-tool-tombstone'))

  // 构造：user → A(tool-call call_1) → R(call_1 大结果) → 后续 A
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'user anchor' }], source: { kind: 'user' },
  }) as never, { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn: 1, step: 1,
    message: createAssistantMessage({
      source: { provider: 'test', model: 'test' },
      content: [{ type: 'tool-call', id: 'call_1' as never, name: 'read_file', arguments: '{"path":"x"}' }],
    }),
  }, { surfaceOp: 'append' })
  const aSeq = session.events.length - 1
  session.append('tool/result', {
    turn: 1, step: 1,
    message: createToolResultMessage({
      callId: 'call_1' as never,
      content: [{ type: 'text', text: 'BIG RESULT '.repeat(1000) }],
      isError: false,
    }),
  }, { surfaceOp: 'append' })
  const rSeq = session.events.length - 1
  session.append('assistant/message', {
    turn: 2, step: 1,
    message: createAssistantMessage({
      source: { provider: 'test', model: 'test' },
      content: [{ type: 'text', text: 'A2: I used the file.' }],
    }),
  }, { surfaceOp: 'append' })

  console.log('[29] 构造完成: user=' + 1 + ' A(tool-call)=seq' + aSeq + ' R=seq' + rSeq + ' A2')

  // ① schema 验证：tool/result 占位墓碑替换 R（克隆原 data，只改 tool-result block 的 inner text）
  try {
    const orig = (session.events[rSeq] as { data: Record<string, unknown> }).data
    const origMsg = (orig.message as { content: { type: string; toolCallId: string; isError?: boolean }[] })
    const origBlock = origMsg.content[0]
    const newData = {
      ...orig,
      message: {
        ...(orig.message as object),
        content: [{
          type: 'tool-result',
          toolCallId: origBlock?.toolCallId,
          isError: origBlock?.isError ?? false,   // 必须保留（dsh 置 null 比较要求其余字段全等）
          content: [{ type: 'text', text: '[elided: 旧版本结果已压缩，recall_pruned(seq) 找回原值]' }],
        }],
      },
    }
    session.append('tool/result', newData as never, { surfaceOp: { op: 'replace', start: rSeq, end: rSeq }, sourceEventSeqs: [rSeq] })
    console.log('[29] ✅ ① tool 占位墓碑 append 成功（dsh schema 校验通过）')
  } catch (err) {
    console.log('[29] ❌ ① tool 占位墓碑 append 失败: ' + (err instanceof Error ? err.message.slice(0, 200) : String(err)))
    await ctx.fiber.dispose()
    return
  }

  // ② deriveMessages 输出验证（提交 messages 的真实来源）
  const msgs = session.deriveMessages()
  console.log('[29] deriveMessages 共 ' + msgs.length + ' 条: ' + msgs.map(m => {
    const c = m.content as { type?: string }[]
    const types = Array.isArray(c) ? c.map(b => b.type).join('+') : typeof m.content
    return (m as { role?: string }).role ?? '?' + '[' + types + ']'
  }).join(' , '))

  const asst = msgs.find(m => (m.content as { type?: string }[] | undefined)?.some(b => b.type === 'tool-call'))
  const tool = msgs.find(m => (m.content as { type?: string }[] | undefined)?.some(b => b.type === 'tool-result'))
  const asstCalls = asst ? (asst.content as { type: string; id: string }[]).filter(b => b.type === 'tool-call') : []
  const toolBlocks = tool ? (tool.content as { type: string; toolCallId: string }[]).filter(b => b.type === 'tool-result') : []
  const pairing = asstCalls.length > 0 && toolBlocks.length > 0 && asstCalls.some(c => c.id === toolBlocks[0]?.toolCallId)
  console.log('[29] ② assistant.tool_calls = ' + JSON.stringify(asstCalls.map(c => c.id)))
  console.log('[29] ② tool-result.toolCallId = ' + JSON.stringify(toolBlocks.map(b => b.toolCallId)))
  console.log('[29] ② 配对（callId 匹配，wire 必输出 assistant.tool_calls + role:"tool"）: ' + pairing)

  // ③ 断言：墓碑文本在提交里可见（模型看到压缩说明）
  const tombText = tool ? JSON.stringify(tool.content).includes('已压缩') : false
  console.log('[29] ③ 墓碑说明文本进入提交: ' + tombText)

  const verdict = pairing && tombText ? 'PASS' : 'FAIL'
  console.log('\n[29] VERDICT: ' + verdict + ' —— tool 占位墓碑方案' + (verdict === 'PASS' ? '可行（配对完整，wire 序列化后不触发 provider 400）' : '不可行'))
  await ctx.fiber.dispose()
}

void main()
