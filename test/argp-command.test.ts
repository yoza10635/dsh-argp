/**
 * `/argp` 只读状态命令回归测试。
 *
 * 契约边界（铁律 3）：命令的注册与生命周期（`command/run` ↔ `command/done`）由
 * **宿主真实 `CommandRuntime`** 负责，本测试不自己复刻——直接 `ctx.plugin(CommandRuntime)`
 * 后经 `runtime.execute()` 真跑一遍，断言宿主写出的生命周期事件与本命令的输出文本。
 *
 * 断言：
 *  1) 引擎挂载后 `/argp` 出现在宿主命令发现列表（descriptor 形态正确）
 *  2) 执行成功：输出分段详单（身份 / 预算 / 剪枝 / 召回 / cites）；cites 段**随引擎形态
 *     自适应**——双引擎（默认，declarer 在位）输出，纯 Stage-2（`peratom: false`）省略，
 *     不输出恒零噪声
 *  3) 生命周期：session log 落 `command/run` + `command/done`，commandId 配对；
 *     `recordInput: false` ⇒ `command/run` 不带 `args`
 *  4) 只读：执行前后 session 的 surface 节点与 seq 总数不变（不触发压缩、不写业务事件）
 *  5) 降级：宿主无 commands 服务时不注册、不抛错，引擎其余能力照常（不新增 boot 失败面）
 *  6) 剪枝后状态反映真实台账：压缩一次后 `prunes: 1` 且末次形状与 records 一致
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { ArgpGraphEngine } from '../src/argp-graph-engine.ts'
import { ARGP_COMMAND_NAME, ARGP_STATUS_VERSION } from '../src/argp-command.ts'
import { sessionEvents } from '../src/log-access.ts'

/** 构造：宿主命令服务 + ARGP 引擎 + 一个带会话的 agent 替身。 */
async function makeStack(config: Record<string, unknown> = {}): Promise<{
  ctx: Context
  engine: ArgpGraphEngine
  runtime: CommandRuntime
  session: Session
  agent: Agent
}> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: 'argp command test' } })
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(ArgpGraphEngine, {
    windowTokens: 100,
    retainTokens: 50,
    minSpanChars: 20,
    recencyGuard: 0,
    maxPasses: 16,
    ...config,
  })
  const runtime = ctx.commands
  const session = Session.create(SessionId('argp-command-test'))
  // 命令侧只需 `session`；compactNow 侧还需要 `runMaintenance`（手动压缩空闲串行化）。
  const agent = {
    session,
    runMaintenance: (task: (signal: AbortSignal) => Promise<unknown>) => task(new AbortController().signal),
  } as unknown as Agent
  return { ctx, engine: ctx.compaction as ArgpGraphEngine, runtime, session, agent }
}

/** 追加一轮 user/assistant（turn 递增），供压缩用例制造可剪内容。 */
function appendTurn(session: Session, turn: number, userText: string, assistantText: string): void {
  session.append('user/message', {
    turn,
    ...createUserMessage({ content: [{ type: 'text', text: userText }], source: { kind: 'user' } }),
  } as never, { surfaceOp: 'append' })
  session.append('assistant/message', {
    stream: [],
    turn,
    step: 1,
    message: createAssistantMessage({
      source: { provider: 'test', model: 'test' },
      content: [{ type: 'text', text: assistantText }],
    }),
  } as never, { surfaceOp: 'append' })
}

test('/argp: 注册进宿主命令发现列表', async () => {
  const { runtime, agent } = await makeStack()
  const names = runtime.list(agent).map((d) => d.name)
  assert.ok(names.includes(ARGP_COMMAND_NAME), 'expected /argp in command list, got ' + JSON.stringify(names))
  const descriptor = runtime.list(agent).find((d) => d.name === ARGP_COMMAND_NAME)
  assert.ok(descriptor !== undefined)
  assert.match(descriptor.description, /ARGP/)
  assert.equal(descriptor.input?.hint, '(no arguments)')
})

test('/argp: 执行输出分段详单（身份 / 预算 / 剪枝 / 召回）', async () => {
  const { runtime, agent, session } = await makeStack()
  appendTurn(session, 1, 'hello world', 'hi there')
  const execution = await runtime.execute(agent, '/argp', [], AbortSignal.timeout(5000))
  assert.ok(execution !== undefined, 'expected /argp to resolve')
  assert.equal(execution.result.kind, 'success')
  const text = execution.result.kind === 'success' ? (execution.result.text ?? '') : ''
  const lines = text.split('\n')
  assert.ok(lines.length >= 4, 'expected >=4 status lines, got ' + text)
  assert.ok(lines[0].startsWith('ARGP ' + ARGP_STATUS_VERSION), 'head line: ' + lines[0])
  assert.ok(lines[0].includes('engine: graph'), 'engine mode missing: ' + lines[0])
  assert.ok(text.includes('budget: trigger'), 'budget line missing: ' + text)
  assert.ok(text.includes('prunes: 0'), 'prune line missing: ' + text)
  assert.ok(text.includes('recall: 0 calls'), 'recall line missing: ' + text)
  // 默认双引擎（declarer 在位）⇒ cites 段应出现
  assert.ok(text.includes('cites:'), 'cites段应在 declarer 在位时出现: ' + text)
})

test('/argp: 纯 Stage-2（peratom:false）省略 cites 段，engine 形态如实反映', async () => {
  const { runtime, agent, session } = await makeStack({ peratom: false })
  appendTurn(session, 1, 'hello world', 'hi there')
  const execution = await runtime.execute(agent, '/argp', [], AbortSignal.timeout(5000))
  assert.ok(execution !== undefined)
  const text = execution.result.kind === 'success' ? (execution.result.text ?? '') : ''
  assert.ok(text.includes('engine: graph+peratom') === false, 'engine 形态应为纯 graph: ' + text)
  assert.ok(!text.includes('cites:'), '纯 Stage-2 下 cites 段应省略: ' + text)
})

test('/argp: 生命周期由宿主写入（command/run ↔ command/done 配对，recordInput=false）', async () => {
  const { runtime, agent, session } = await makeStack()
  const before = sessionEvents(session).length
  const execution = await runtime.execute(agent, '/argp', [], AbortSignal.timeout(5000))
  assert.ok(execution !== undefined)
  const added = sessionEvents(session).slice(before)
  const runs = added.filter((e) => e.type === 'command/run')
  const dones = added.filter((e) => e.type === 'command/done')
  assert.equal(runs.length, 1, 'expected exactly one command/run')
  assert.equal(dones.length, 1, 'expected exactly one command/done')
  // SessionEvent 是判别联合，payload 在 `data` 上。
  const run = runs[0] as unknown as { data?: { commandId?: string; name?: string; args?: string } }
  const done = dones[0] as unknown as { data?: { commandId?: string; kind?: string } }
  assert.equal(run.data?.name, ARGP_COMMAND_NAME)
  assert.equal(run.data?.commandId, done.data?.commandId, 'commandId 必须与 command/done 配对')
  assert.equal(execution.commandId, run.data?.commandId)
  assert.equal(run.data?.args, undefined, 'recordInput:false ⇒ command/run 不带 args')
  assert.equal(done.data?.kind, 'success')
})

test('/argp: 只读——不触发压缩、不改 surface', async () => {
  const { runtime, agent, session } = await makeStack()
  appendTurn(session, 1, 'x'.repeat(400), 'y'.repeat(400))
  const surfaceBefore = [...session.surface.nodes]
  const seqBefore = sessionEvents(session).length
  await runtime.execute(agent, '/argp', [], AbortSignal.timeout(5000))
  assert.deepEqual([...session.surface.nodes], surfaceBefore, 'surface 不应被 /argp 改动')
  // 只允许宿主写的两条生命周期事件
  assert.equal(sessionEvents(session).length, seqBefore + 2, '除 command/run+command/done 外不应有新增事件')
})

test('/argp: 宿主无 commands 服务时静默降级（不抛、引擎照常）', async () => {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: 'argp degrade test' } })
  // 不挂 CommandRuntime
  await ctx.plugin(ArgpGraphEngine, { windowTokens: 100, retainTokens: 50, minSpanChars: 20, recencyGuard: 0 })
  assert.equal(ctx.get('commands'), undefined, '本用例前提：无 commands 服务')
  const engine = ctx.compaction as ArgpGraphEngine
  assert.ok(engine !== undefined, '引擎不应因命令注册缺失而构造失败')
})

test('/argp: 压缩一次后状态反映真实台账', async () => {
  const { engine, runtime, agent, session } = await makeStack({ turnGuard: 0 })
  for (let turn = 1; turn <= 4; turn++) {
    appendTurn(session, turn, 'q' + turn + ' ' + 'a'.repeat(300), 'r' + turn + ' ' + 'b'.repeat(300))
  }
  const result = await engine.compactNow(agent, AbortSignal.timeout(5000), undefined)
  assert.notEqual(result, null, '前置条件：应剪到内容')
  assert.equal(engine.records.length, 1)
  const execution = await runtime.execute(agent, '/argp', [], AbortSignal.timeout(5000))
  assert.ok(execution !== undefined)
  const text = execution.result.kind === 'success' ? (execution.result.text ?? '') : ''
  assert.ok(text.includes('prunes: 1'), 'expected prunes: 1, got ' + text)
  const last = engine.records[0]
  assert.ok(text.includes('/ ' + last.shadowedSeqs.length + ' items'), 'items 计数应来自 records: ' + text)
  assert.ok(text.includes('pruned index ' + engine.prunedNodeIndex.size), 'pruned index: ' + text)
})
