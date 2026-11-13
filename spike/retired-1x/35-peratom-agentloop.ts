/**
 * spike 35 — PeratomCompressor 真实 agent loop 端到端冒烟（本地 Qwen × 宿主不变量校验）
 *
 * 背景：spike 33/34 验证了压缩链路与保真，但都是手工构造 Session 直调方法。
 * 本 spike 挂完整 agent loop（真模型、真工具、真 idle/pre-step 时序），并挂载
 * dsh-session 不变量 companion（宿主同款校验器）实证两段式设计的合法性：
 * idle 阶段只暂存，事务在下一轮 open-turn 窗口发射。
 *
 * 时序剧本：
 *   轮 1  长 user（指令+粘贴混合）→ 模型调 read_error_log 工具（大结果 ≥512 字符）
 *   idle  触发 prepareCurrentTurn：LLM 压缩调用完成 → 事务入 stash（零落盘）
 *   轮 2  短对话；其 pre-step 窗口 flush → 轮 1 事务落地（compaction 括号 owner=轮 2）
 *   idle  轮 2 为纯对话轮 → 门控短路零调用
 *
 * 判决项：
 *   VA-defer      idle 后 stash 已就绪但日志未增长（防重复+延迟发射语义）
 *   VB-flush      轮 2 pre-step 落事务：括号配对无 error，且事件 seq 位于 turn/end(1) 与轮 2 内容之间
 *   VC-owner      compaction/start.turn === 2（编号 owner=开放轮，契约口径）
 *   VD-dual       dialog 原位 replace + U-info append（info/sourceSeq/summary），副本位置正确
 *   VE-contentonly  tool 副本仅内层 content 变化（挂校验器后仍通过 = 宿主真校验实证）
 *   VF-originals  全部原文零替换（JSON 哈希比对）
 *   VG-pure       轮 2 门控短路零调用（calls 计数不增）
 *
 * 用法：npm run spike35（需本地 llama.cpp :8080 与 QWEN_MODEL 匹配）
 * 产物：spike/out/35-peratom-agentloop-<时间戳>.json
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { InvariantRegistry } from '@deepseek-ai/dsh-invariants'
import { apply as applySessionInvariant } from '@deepseek-ai/dsh-session/invariant'
import { ARG_NS } from '../src/peratom/types.ts'
import { PeratomCompressor } from '../src/peratom/compressor.ts'

const BASE = (process.env['QWEN_BASE'] ?? 'http://127.0.0.1:8080/v1').replace(/\/$/, '')
const MODEL = process.env['QWEN_MODEL'] ?? 'Qwen3.6-35B-A3B'

const failures: string[] = []
const verdict = (name: string, ok: boolean, detail: string): void => {
  console.log((ok ? '[PASS ' : '[FAIL ') + name + '] ' + detail)
  if (!ok) failures.push(name + ': ' + detail)
}

const watchdog = setTimeout(() => {
  console.log('[FATAL] spike 35 watchdog timeout (15 min)')
  process.exit(2)
}, 15 * 60 * 1000)

// ---------------------------------------------------------------------------
// 语料与工具
// ---------------------------------------------------------------------------

const TURN1_USER = '服务起不来了。请调用 read_error_log 工具读取完整错误日志，然后告诉我根因和第一行错误码。\n'
  + '部署输出留档：\n'
  + '[deploy] step 12/18 build ok sha 9f2c1ab\n[deploy] step 13/18 push ok\n'
  + '[deploy] step 14/18 smoke FAILED BUILD_FAILED_EXIT=134\n[deploy] canary-2 unhealthy (503)\n'
  + '[deploy] canary-1 healthy (200)\n[deploy] rollback NOT attempted (auto=false)\n'

const TOOL_TEXT = 'ERROR BOOT_SEQUENCE_ABORTED stage=health-check\n'
  + '    at Boot.run (/opt/app/src/boot.ts:141:19)\n'
  + '    at main (/opt/app/src/main.ts:31:5)\n'
  + 'caused by ECONNREFUSED 10.0.3.17:5432 (postgres orders primary)\n'
  + 'retry policy: backoff=exp base=200ms attempts=5 exhausted\n'
  + 'trace-id=9f2c1ab7-e5d4-4b3a-8c1d-2e3f4a5b6c7d node=canary-2 region=cn-north-1\n'
  + 'hint: check pg_hba.conf and security group egress 5432; last known good sha 9f2c1ab\n'
  + 'context: upstream pg primary failover incomplete; wal segment 0000000100000000000000F3 missing on standby\n'
  + 'env: NODE_ENV=production PGPOOL_MAX=25 CONNECT_TIMEOUT_MS=5000 feature_flags=rollback-auto-off\n'
  + 'timeline: 22:14:03 deploy start; 22:14:41 smoke fail; 22:15:02 boot abort; supervisor restart loop x3\n'

// ---------------------------------------------------------------------------
// 等待辅助
// ---------------------------------------------------------------------------

async function waitFor(desc: string, pred: () => boolean, timeoutMs: number): Promise<boolean> {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (pred()) return true
    await new Promise(r => setTimeout(r, 250))
  }
  console.log(`[wait-timeout] ${desc} (${timeoutMs}ms)`)
  return false
}

function waitIdle(ctx: Context, agent: { session: Session }): Promise<void> {
  return new Promise(resolve => {
    const dispose = ctx.on('agent/status', ({ agent: a, status }: { agent: { session: Session }; status: string }) => {
      if (a.session === agent.session && status === 'idle') { dispose(); resolve() }
    })
  })
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`[spike35] base=${BASE} model=${MODEL}`)
  process.env['ARGP_LOCAL_KEY'] = process.env['ARGP_LOCAL_KEY'] ?? 'local-no-auth'

  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: 'spike-35 peratom e2e persona' } })
  // 宿主同款会话不变量：turn 生命周期 + surface 替换规则的真实校验器
  await ctx.plugin(InvariantRegistry, {})
  await applySessionInvariant(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LlmPiAi, {
    providers: {
      local: {
        displayName: 'Local llama.cpp',
        apiKeyEnv: 'ARGP_LOCAL_KEY',
        api: 'openai-completions',
        baseURL: BASE,
        compat: { thinkingFormat: 'qwen' },
        models: [{ id: MODEL, name: MODEL, contextWindow: 196_608, maxTokens: 4096, reasoningEfforts: { off: 'false', high: 'true' } }],
      },
    },
  })

  const compressor = new PeratomCompressor(ctx, {
    endpoint: BASE + '/chat/completions',
    apiKey: 'dummy-local',
    model: MODEL,
    timeoutMs: 240_000,
    chatTemplateKwargs: { enable_thinking: false }, // spike 33：schema 必须关思考
  })

  ctx.tools.register(defineTool({
    name: 'read_error_log',
    description: 'Read the full error log of the failed deployment.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    execute: async () => TOOL_TEXT,
  }))

  const agent = ctx.agentLoop.create(SessionId('spike-35-peratom'), {
    provider: 'local',
    model: MODEL,
    reasoningEffort: 'off',
  })
  const session = agent.session

  ctx.on('agent/request-error', ({ failure }) => {
    console.log('[diag] request-error: ' + JSON.stringify({ code: failure.code }).slice(0, 200))
  })

  const snapshotData = (seq: number): string => JSON.stringify(session.events[seq]?.data)
  const kindsOf = (): string[] => session.events.map(e => e.type)
  const findSeqs = (type: string): number[] => session.events.filter(e => e.type === type).map(e => e.seq)

  // ---- 轮 1：长 user + 工具调用 ----
  agent.followup(createUserMessage({ content: [{ type: 'text', text: TURN1_USER }], source: { kind: 'user' } }))
  await waitIdle(ctx, agent)
  const turnEnd1 = Math.max(...findSeqs('turn/end'))
  const u1Seq = findSeqs('user/message')[0] ?? -1
  const r1SeqList = findSeqs('tool/result')
  const r1Seq = r1SeqList.length > 0 ? Math.max(...r1SeqList) : -1
  const originalHashes = new Map([[u1Seq, snapshotData(u1Seq)], [r1Seq, snapshotData(r1Seq)]])
  console.log(`[t1] turn/end@${turnEnd1} u1@${u1Seq} r1@${r1Seq} events=${session.events.length}`)

  // ---- VA-defer：idle 触发压缩调用；等 stash 真正就绪（LLM 返回后）且日志不动 ----
  const prepared = await waitFor('turn1 压缩到达终态（stash 就绪或失败）', () =>
    compressor.pendingCount > 0
    || compressor.records.some(r => r.turn === 1 && (r.parseFailed === true || r.error !== undefined)), 180_000)
  const lastRec = compressor.records[compressor.records.length - 1]
  const eventsAtDefer = session.events.length
  const genAtDefer = session.surface.replaceGeneration
  verdict('VA-defer', prepared && compressor.pendingCount === 1
    && session.events.length === eventsAtDefer && session.surface.replaceGeneration === genAtDefer,
    `pending=${compressor.pendingCount} ms=${lastRec?.ms} parseFailed=${lastRec?.parseFailed} 零落盘=true`)

  // ---- 轮 2：短对话；其 pre-step 应 flush 轮 1 事务 ----
  agent.followup(createUserMessage({ content: [{ type: 'text', text: '收到，谢谢。' }], source: { kind: 'user' } }))
  await waitIdle(ctx, agent)

  const kinds = kindsOf()
  const starts = findSeqs('compaction/start')
  const ends = findSeqs('compaction/end')
  const startSeq = starts.length > 0 ? Math.max(...starts) : -1
  const endSeq = ends.length > 0 ? Math.max(...ends) : -1
  // 真·轮 2 用户输入：append 起源 + user 署名 + 无 ARG_NS 标记（排除 replace 副本与 U-info）
  const user2Seqs = findSeqs('user/message').filter(s => {
    if (s <= turnEnd1) return false
    const ev = session.events[s]
    if ((ev?.surfaceOp as string) !== 'append') return false
    const d = ev?.data as { source?: { kind?: string }; [k: string]: unknown }
    return d?.source?.kind === 'user' && d[ARG_NS] === undefined
  })
  const user2First = user2Seqs.length > 0 ? Math.min(...user2Seqs) : -1
  if (process.env['SPIKE35_DUMP'] === '1') {
    for (let i = Math.max(0, turnEnd1); i <= Math.min(session.events.length - 1, endSeq + 3); i += 1) {
      const ev = session.events[i]
      if (ev === undefined) continue
      const op = (ev as { surfaceOp?: unknown }).surfaceOp
      console.log(`[dump] ${i} ${ev.type} op=${op === undefined ? '-' : JSON.stringify(op)} src=${JSON.stringify((ev.data as { source?: unknown }).source ?? '-')}${ev.data && typeof ev.data === 'object' && ARG_NS in (ev.data as object) ? ' [ARG]' : ''}`)
    }
  }

  const endData = session.events[endSeq]?.data as { error?: string; turn?: number | null } | undefined

  // 位置断言：start 在 turn/end(1) 之后、end 在轮 2 第一条 user/message 之前（pre-step 窗口）
  const posOk = startSeq > turnEnd1 && endSeq > startSeq
    && (user2First === -1 || endSeq < user2First)
  verdict('VB-flush', posOk && endData?.error === undefined,
    `[turn/end(1)=${turnEnd1}] < start=${startSeq} .. end=${endSeq} < [轮2首条=${user2First}] error=${endData?.error ?? 'none'}`)

  const startData = session.events[startSeq]?.data as { turn?: number | null } | undefined
  verdict('VC-owner', startData?.turn === 2, `compaction/start.turn=${startData?.turn}（期望 2=开放轮 owner）`)

  // ---- VD-dual / VE-contentonly / VF-originals ----
  let dialogSeq = -1
  let infoSeq = -1
  let toolCopySeq = -1
  if (posOk) {
    for (let i = startSeq + 1; i < endSeq; i += 1) {
      const ev = session.events[i]
      if (ev?.type !== 'user/message' && ev?.type !== 'tool/result') continue
      const data = ev.data as Record<string, unknown>
      if (ev.type === 'user/message') {
        if (data[ARG_NS] !== undefined) infoSeq = ev.seq
        else dialogSeq = ev.seq
      } else toolCopySeq = ev.seq
    }
  }
  const dialogData = session.events[dialogSeq]?.data as { content?: { text?: string }[] } | undefined
  const infoData = session.events[infoSeq]?.data as { [k: string]: unknown } | undefined
  const infoMeta = infoData?.[ARG_NS] as { info?: boolean; sourceSeq?: number; summary?: string } | undefined
  const dualOk = dialogSeq > 0 && infoSeq > 0
    && (session.events[dialogSeq]?.sourceEventSeqs ?? []).includes(u1Seq)
    && (session.events[infoSeq]?.surfaceOp as string) === 'append'
    && infoMeta?.info === true && infoMeta.sourceSeq === u1Seq
    && typeof infoMeta.summary === 'string' && infoMeta.summary.length > 0
    && typeof dialogData?.content?.[0]?.text === 'string'
  verdict('VD-dual', dualOk, `dialog@${dialogSeq}(replace u1) info@${infoSeq}(append, sourceSeq=${infoMeta?.sourceSeq})`)
  if (dualOk) {
    console.log('[t2] dialog 前 80 字: ' + JSON.stringify(String(dialogData?.content?.[0]?.text).slice(0, 80)))
    console.log('[t2] U-info summary 前 80 字: ' + JSON.stringify(infoMeta!.summary.slice(0, 80)))
  }

  let contentOnly = toolCopySeq > 0
  if (contentOnly) {
    const orig = session.events[r1Seq]?.data as Record<string, unknown>
    const copy = session.events[toolCopySeq]?.data as Record<string, unknown>
    const strip = (d: Record<string, unknown>): string => {
      const m = d['message'] as { content: Array<Record<string, unknown>> }
      return JSON.stringify({ ...d, message: { ...m, content: m.content.map(b => ({ ...b, content: null })) } })
    }
    const copyText = ((copy['message'] as { content?: Array<{ content?: Array<{ text?: string }> }> })
      .content?.[0]?.content?.[0]?.text) ?? ''
    contentOnly = Object.keys(orig).length === Object.keys(copy).length
      && Object.keys(orig).every(k => k in copy)
      && strip(orig) === strip(copy)
      && copyText.length > 0
      && !(ARG_NS in copy)
    console.log('[t2] tool extract 前 100 字: ' + JSON.stringify(copyText.slice(0, 100)))
  }
  verdict('VE-contentonly', contentOnly, `copy@${toolCopySeq} 仅内层 content 变化（宿主校验器下通过）`)

  let originalsOk = true
  for (const [seq, hash] of originalHashes) {
    if (snapshotData(seq) !== hash) { originalsOk = false; break }
  }
  verdict('VF-originals', originalsOk, `原文 ${[...originalHashes.keys()].join(',')} 零替换`)

  // ---- VG-pure：轮 2 门控短路 ----
  const rec2 = compressor.records.findLast(r => r.turn === 2)
  const callsAfterT1 = 1
  verdict('VG-pure', rec2?.called === false && compressor.calls <= callsAfterT1,
    `轮2 record.called=${rec2?.called} calls=${compressor.calls}`)

  // ---- 收尾 ----
  console.log('\n[event kinds] ' + kinds.join(','))
  const outDir = path.join(process.cwd(), 'spike', 'out')
  fs.mkdirSync(outDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const outFile = path.join(outDir, `35-peratom-agentloop-${stamp}.json`)
  fs.writeFileSync(outFile, JSON.stringify({
    meta: { base: BASE, model: MODEL, runAt: new Date().toISOString(), failures },
    calls: compressor.calls,
    records: compressor.records,
    eventKinds: kinds,
    keySeqs: { u1Seq, r1Seq, turnEnd1, startSeq, endSeq, dialogSeq, infoSeq, toolCopySeq },
  }, null, 2))
  console.log(`产物：${outFile}`)
  if (failures.length > 0) {
    console.log(`\n=== 结论：${failures.length} 项待处理 ===`)
    for (const f of failures) console.log(' - ' + f)
    process.exitCode = 1
  } else {
    console.log('\n=== 结论：全部判决项 PASS —— 真实 agent loop 两段式端到端通过（含宿主不变量校验器）===')
  }
  clearTimeout(watchdog)
  await ctx.fiber.dispose()
}

main().catch(err => {
  console.error(err)
  process.exitCode = 1
})
