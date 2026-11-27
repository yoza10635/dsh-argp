/**
 * Tier A′：进程内端到端层（测试体系审计 T1，2026-11-27 补位）。
 *
 * 原进程内层 `integration-loop.test.ts`（脚本化 LlmAdapter + 生产 AgentLoop）随
 * `a20cd10` 退役后无 2.x 对应物 ⇒ 「插件挂载 → pre-step → 出口闸 → 事务发射 →
 * 宿主可加载 → 召回逐字取回」这条全链在任何自动门禁里都不成立——单测全绿 + 全链
 * 断掉是可达状态（2.2.1「写入成功、下次加载整档拒载」事故正是这一层）。
 *
 * 本层与两侧邻居的分工：活体层（integration-live）只在真字节与真账单上跑，不脚本化
 * agent 轮；单测层锁各段局部不变量。Tier A′ 补的是中间空洞：**真 AgentLoop 事件序
 * + 脚本化 LlmAdapter + 脚本化工具（defineTool，零网络零子进程）+ 宿主加载校验器**，
 * 跑通整条因果链。宿主加载校验（assertReleasedV4Relationships）在 0.2.0-rc.1 线已
 * 存在（CI oldest 臂实测全绿）；若未来某 API 只在一线存在，按 vocab-context 的能力
 * 守卫模式加 typeof 早退。
 *
 * ★夹具几何（2026-11-27 两轮实锤，别改回手动铺史）：
 *  ① 生产 loop 的轮号来自 boot 级 phase.turn 计数器（resume 时由 turnBoundaryOf
 *     对齐，进程内恒 1,2,3…），**不读手工铺进日志的轮号** ⇒ 手动种子轮必然与后续
 *     生产轮同号；且 `detectOpenTurn` 取未闭合的 turn/start 轮号后按 `a.turn >=
 *     openTurn` 数值判定「在轮」——种子轮号 ≥ 生产当前轮时**整片种子被当本轮协议
 *     现场硬保护，剪序恒空**（egressGate 返回 'blocked'、factor 返回 null，全程
 *     静默）。⇒ 铺史必须由 loop 自己生成（脚本工具轮），轮号天然单调。
 *  ② 焦点窗（focalTurns=1）用最新轮 U/A 的 facet 硬保护同 facet 旧 R
 *     （focalNonRegenerable）：所有种子组共用同一命令（command:npm）或结果文本带
 *     全大写 token（errorcode facet 跨组互认）⇒ 每枚旧 R 全被硬保，同样零发射。
 *     ⇒ 每轮工具命令首 token 唯一（cmd<t>）、输出全小写。
 *
 * 锁面：
 *  A1 全链主干：挂载 → 工具轮累积过线（出口闸旧公式线）→ 事务发射 →
 *     宿主加载链可加载 → recall_history 逐字取回被剪原文；
 *  A2 在轮召回不被同轮第二笔事务剪空（接管 M-F 语义）：open 轮里已返回的
 *     recall_history R 面对同轮手动 compactNow 必须原文在场；
 *  A3 事务事件序自洽：括号配对、每区间 prune→replace 成对、零审计告警；
 *  A4 断锚不驱动（真实 loop 形）：usage 从未落锚的进程首步铺超重输入也不发剪——
 *     宁可不压缩，不可以估算口径压缩；
 *  A5 无事务风暴：稳态面收敛后紧接的下一轮不再发第二笔（锚点锚在压缩后 surface）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { AgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter, createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { assertReleasedV4Relationships } from '@deepseek-ai/dsh-session-format-v3-to-v4'
import { ArgpEngine } from '../src/argp-engine.ts'
import { eventText, sessionEvents, turnOf } from '../src/log-access.ts'
import { execTool, toolText } from './tool-execute-shape.ts'
import type { GraphPruneRecord } from '../src/prune-tx.ts'

// ---------------------------------------------------------------------------
// 脚本化适配器：tool 步↔final 步相位机 + 契约形 usage（inputTokens=未命中，命中单列）
// ---------------------------------------------------------------------------

const WINDOW = 4000
/** 每发 agent 请求回报的锚定用量：过线判据的锚点来源（旧线 = 4000−1000−80=2920）。
 *  2800 < 线 ⇒ 单发锚不过线；工具结果入面后的增量把下一 pre-step 顶过线 ⇒ 剪。 */
const ANCHOR_INPUT_TOKENS = 2800
/** 每轮工具输出：~630 tok 组体量 > retainTokens(400) ⇒ 稳态逐轮一剪。 */
const TOOL_OUT_CHARS = 2200

class ScriptedLlm extends LlmAdapter {
  readonly requests: { purpose: string; messages: number }[] = []
  /** 轮内相位：tool=发工具调用，final=收口文本。turn 供命令/输出编号。 */
  mode: 'tool' | 'final' = 'tool'
  turn = 0

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const purpose = String((options as { purpose?: string }).purpose ?? 'agent')
    const msgs = ((options as { messages?: Message[] }).messages ?? []).length
    this.requests.push({ purpose, messages: msgs })
    if (purpose === 'compaction') {
      // 摘要调用：给一段最小合法检查点正文（本层不测摘要质量，只测它不炸链）。
      const text = '## Primary Request and Intent\n- scripted checkpoint\n\n## Pending Jobs\n- (none)\n\n## Current Work\n- scripted\n\n## Next Step\n- (none)'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'usage', usage: { inputTokens: 500, outputTokens: 50, cacheReadTokens: 400 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    if (this.mode === 'final') {
      this.mode = 'tool'
      const text = 'final answer'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'usage', usage: { inputTokens: ANCHOR_INPUT_TOKENS, outputTokens: 20, cacheReadTokens: 0 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    const t = this.turn
    this.mode = 'final'
    const cmd = 'cmd' + t
    const argsJson = JSON.stringify({
      command: cmd + ' run build',
      payload: 'group-' + t + '-out ' + 'w'.repeat(TOOL_OUT_CHARS),
    })
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'running ' + cmd }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'running ' + cmd } }
    yield { type: 'block-start', index: 1, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 1, id: ('tc-' + t) as never, name: 'bash', argumentsDelta: argsJson }
    yield { type: 'block-end', index: 1, block: { type: 'tool-call', id: ('tc-' + t) as never, name: 'bash', arguments: argsJson } }
    yield { type: 'usage', usage: { inputTokens: ANCHOR_INPUT_TOKENS, outputTokens: 40, cacheReadTokens: 0 } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }

  override async resolveModel(provider: string, model: string) {
    return { provider, id: model, name: 'scripted', context: { contextWindow: WINDOW } }
  }
}

// ---------------------------------------------------------------------------
// 台架
// ---------------------------------------------------------------------------

interface Flow {
  ctx: Context
  engine: ArgpEngine
  agent: Agent
  session: Session
  adapter: ScriptedLlm
}

async function bootLoop(tag: string): Promise<Flow> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: tag + ' persona' } })
  // 脚本化 bash：命令面走 args.command（tag-extract COMMAND_TOOLS 白名单收 'bash'
  // ⇒ command:<首token> facet 可召回），输出=入参 payload（确定性字节，零子进程）。
  ctx.tools.register(defineTool({
    name: 'bash',
    description: 'Scripted deterministic command runner (test fixture).',
    parameters: {
      command: { type: 'string', description: 'command line' },
      payload: { type: 'string', description: 'deterministic output' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
    execute: async (args): Promise<string> => String((args as { payload?: string }).payload ?? ''),
  }))
  const adapter = new ScriptedLlm()
  ;(ctx.get('llm') as unknown as { registerAdapter(p: string[], a: LlmAdapter): unknown }).registerAdapter(['a'], adapter)
  await ctx.plugin(ArgpEngine, { engine: 'factor', windowTokens: WINDOW, retainTokens: 400 })
  const engine = ctx.compaction as ArgpEngine
  const harness: AgentLoopTestHarness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create(SessionId(tag), { provider: 'a', model: 'm' } as never)
  return { ctx, engine, agent, session: agent.session, adapter }
}

function say(agent: Agent, text: string): void {
  agent.send(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), 'next-turn', true)
}

/** 跑 `count` 个生产工具轮（loop 自己编号 ⇒ 轮号单调、无种子碰撞）。 */
async function runToolTurns(flow: Flow, count: number): Promise<void> {
  for (let i = 1; i <= count; i++) {
    flow.adapter.turn = i
    flow.adapter.mode = 'tool'
    say(flow.agent, '任务 ' + i)
    await flow.agent.whenIdle()
  }
}

/** 生产形 A/R 协议组（loop 实锤形：step/start 由调用方先发，assistant/tool/call/
 *  result 全带同一 step，step/end 由调用方后发；user/message 不带 step）。A2 手工
 *  开轮专用——开轮号 = 日志最大轮号 +1 且其后不再有任何生产轮（见头注①）。 */
function appendGroup(session: Session, turn: number, callId: string, tool: string, args: string, resultText: string): void {
  session.append('assistant/message', {
    stream: [], turn, step: 1,
    message: createAssistantMessage({
      source: { provider: 'scripted', model: 'scripted' },
      content: [{ type: 'text', text: 'doing ' + tool }, { type: 'tool-call', id: callId, name: tool, arguments: args } as never],
    }),
  } as never, { surfaceOp: 'append' })
  session.append('tool/call', { turn, step: 1, callId, name: tool, arguments: args } as never)
  session.append('tool/result', {
    turn, step: 1,
    message: {
      role: 'user',
      // ★宿主加载器要求 tool/result 的 message **顶层** toolCallId（content[0] 里的
      // 不算）——p6iii 形不过加载校验，本层要过 assertHostLoadable 必须带。
      toolCallId: callId,
      content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: resultText }], isError: false }],
      source: { kind: 'tool', callId },
      id: 'm_' + callId,
    },
  } as never, { surfaceOp: 'append' })
}

/** 日志里已占用的最大轮号 +1。 */
function nextTurn(session: Session): number {
  let max = 0
  for (const e of sessionEvents(session) as unknown as Parameters<typeof turnOf>[0][]) {
    const t = turnOf(e)
    if (t !== undefined && t > max) max = t
  }
  return max + 1
}

/** 宿主加载侧校验（同 surface-fold-legality 的伪 artifact 形）。 */
function assertHostLoadable(session: Session): void {
  const events = sessionEvents(session) as unknown as { type: string }[]
  const artifact = {
    header: {
      version: 4,
      id: String(session.id),
      createdAt: 1,
      isSeeded: false,
      delegationDepth: 0,
      cwd: 'C:/workspace/test',
    },
    events,
  }
  assertReleasedV4Relationships(artifact as never, new Set(events.map(e => e.type)) as never)
}

function surfaceTextOf(session: Session): string {
  return [...session.surface.nodes].map(seq => eventText(session, seq)).join('\n')
}

function lastRecord(engine: ArgpEngine): GraphPruneRecord | null {
  const records = engine.records
  return records.length > 0 ? records[records.length - 1] ?? null : null
}

function pruneReplacePairs(session: Session): { prune: number; replace: number; starts: number; ends: number } {
  const evs = sessionEvents(session) as unknown as { type: string; surfaceOp?: { op?: string } }[]
  return {
    prune: evs.filter(e => e.type === 'compaction/prune').length,
    replace: evs.filter(e => e.surfaceOp?.op === 'replace').length,
    starts: evs.filter(e => e.type === 'compaction/start').length,
    ends: evs.filter(e => e.type === 'compaction/end').length,
  }
}

// ---------------------------------------------------------------------------
// A1 全链主干
// ---------------------------------------------------------------------------

test('A1 全链：工具轮过出口闸线 ⇒ 事务发射 ⇒ 宿主可加载 ⇒ recall_history 逐字取回', { timeout: 120_000 }, async () => {
  const flow = await bootLoop('argp-a1')
  try {
    await runToolTurns(flow, 4)
    const rec = lastRecord(flow.engine) // whenIdle 已覆盖 pre-step→事务落盘全链（探针实锤）
    assert.ok(rec !== null, '★生产 loop 稳态必须由出口闸（pre-step 自动通路）驱动事务，而非仅手动 compact')
    assert.equal(rec!.error, undefined, '事务不得 error 收尾')
    assert.ok(rec!.intervals.length >= 1 && rec!.shadowedSeqs.length > 0)
    assert.ok(rec!.shadowedSeqs.some(s => !flow.session.surface.nodes.includes(s as never)),
      '被剪节点必须真实离场')

    assertHostLoadable(flow.session) // 事务字节必须被宿主加载链接受（2.2.1 事故面）

    // cmd1=最早工具轮组（freshness 最旧先剪，且不在最新轮焦点 facet 内）
    const hit = toolText(await execTool(flow.ctx, {
      name: 'recall_history', callId: 'q1', agentSession: flow.session, args: { labels: ['command:cmd1'] },
    }))
    assert.match(hit, /group-1-out/, '★召回必须逐字含被剪原文正文（不是只回标签）')
  } finally {
    await flow.ctx.fiber.dispose()
  }
})

// ---------------------------------------------------------------------------
// A2 在轮召回不被同轮第二笔事务剪空（M-F 语义接管）
// ---------------------------------------------------------------------------

test('A2 open 轮里已返回的 recall_history R 不被同轮手动压缩剪空', { timeout: 120_000 }, async () => {
  const flow = await bootLoop('argp-a2')
  try {
    await runToolTurns(flow, 3)
    // 开一个进行中的轮（step 已闭、轮未闭=轮内手动 /compact 形态）：
    // 模型刚召回回来的 R 是尚未消化的协议输入。其后不再有任何生产轮（见头注①）。
    const openT = nextTurn(flow.session)
    flow.session.append('turn/start', { turn: openT } as never)
    flow.session.append('step/start', { turn: openT, step: 1 } as never)
    flow.session.append('user/message', {
      ...createUserMessage({ content: [{ type: 'text', text: 'turn ' + openT + ' task' }], source: { kind: 'user' } }),
      turn: openT,
    } as never, { surfaceOp: 'append' })
    appendGroup(flow.session, openT, 'cr', 'recall_history', JSON.stringify({ labels: ['command:cmd2'] }),
      '在轮召回证据 verbatim-q9 ' + 'q'.repeat(2200))
    flow.session.append('step/end', { turn: openT, step: 1 } as never)
    const result = await flow.engine.compactNow(flow.agent as never, new AbortController().signal)
    assert.ok(result !== null, 'closed 面足够大，手动压缩必须发射')
    assertHostLoadable(flow.session)
    assert.ok(surfaceTextOf(flow.session).includes('verbatim-q9'),
      '★同轮第二笔处置不得把刚返回的召回结果剪成空克隆（P1 注入预审实锤面）')
  } finally {
    await flow.ctx.fiber.dispose()
  }
})

// ---------------------------------------------------------------------------
// A3 事务事件序自洽
// ---------------------------------------------------------------------------

test('A3 出口闸事务的事件序自洽：括号配对、prune=replace 成对、零审计告警', { timeout: 120_000 }, async () => {
  const flow = await bootLoop('argp-a3')
  try {
    await runToolTurns(flow, 4)
    assert.ok(lastRecord(flow.engine) !== null, '前置：出口闸事务已发射')

    const evs = sessionEvents(flow.session) as unknown as { type: string }[]
    const counts = pruneReplacePairs(flow.session)
    assert.equal(counts.starts, counts.ends, 'compaction/start 与 end 括号配对')
    assert.ok(counts.starts >= 1)
    assert.equal(counts.prune, counts.replace, '每条 prune 配恰一条 surface replace（括号外零 replace 的事务顺序锁）')
    const firstSummary = evs.findIndex(e => e.type === 'compaction/summary')
    const firstPrune = evs.findIndex(e => e.type === 'compaction/prune')
    if (firstSummary >= 0) assert.ok(firstSummary < firstPrune, 'summary 先于首条 prune（宿主 span() 契约）')
    assert.deepEqual(flow.engine.auditWarnings, [], '全链零审计告警')
  } finally {
    await flow.ctx.fiber.dispose()
  }
})

// ---------------------------------------------------------------------------
// A4 断锚不驱动（真实 loop 形）
// ---------------------------------------------------------------------------

test('A4 无 usage 锚点的进程首步：超重输入也不发剪（估算口径绝不驱动破坏性动作）', { timeout: 120_000 }, async () => {
  const flow = await bootLoop('argp-a4')
  try {
    // usage 从未落锚的进程第一发：measureTokens 非 anchored ⇒ 闸必须放行请求。
    flow.adapter.mode = 'final'
    say(flow.agent, '首步直发 ' + 'x'.repeat(20_000))
    await flow.agent.whenIdle()
    assert.equal(flow.engine.records.length, 0, '★断锚（无真实 usage）绝不发剪——照发交 400 兜底网')
    assert.ok(flow.adapter.requests.some(r => r.purpose === 'agent'), '请求照发（不静默卡死）')
  } finally {
    await flow.ctx.fiber.dispose()
  }
})

// ---------------------------------------------------------------------------
// A5 无事务风暴
// ---------------------------------------------------------------------------

test('A5 稳态收敛后的下一轮不再发第二笔（锚点锚在压缩后 surface）', { timeout: 120_000 }, async () => {
  const flow = await bootLoop('argp-a5')
  try {
    await runToolTurns(flow, 4)
    flow.adapter.mode = 'final'
    say(flow.agent, '收口')
    await flow.agent.whenIdle()
    assert.ok(lastRecord(flow.engine) !== null, '前置：稳态事务已发射过')
    const recordsAfter = flow.engine.records.length
    const countsAfter = pruneReplacePairs(flow.session)

    flow.adapter.turn = 9
    flow.adapter.mode = 'final'
    say(flow.agent, '再作一轮')
    await flow.agent.whenIdle()
    assert.equal(flow.engine.records.length, recordsAfter,
      '★锚点已锚在压缩后 surface，同一面不该再过线（不得连环发射）')
    assert.deepEqual(pruneReplacePairs(flow.session), countsAfter, '第二笔事务零落盘（事件面逐字段一致）')
  } finally {
    await flow.ctx.fiber.dispose()
  }
})
