// spike 28：模拟回放——用修复后引擎重放真实 events.jsonl（跳过旧压缩事件），
// 在每个 user/message 后模拟 agent/pre-step 调 compactIfNeeded，复现"修复后引擎
// 从头跑 50 轮"的压缩序列。零 LLM 成本。
// 对比修复前（26-v4-fix50 真实 records：25 次压缩、每次 2-10 原子、最终 74.7K token）。
import fs from 'node:fs'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ArgpGraphEngine, type ArgpGraphConfig, type SemanticEdge, type Atom } from '../src/argp-graph-engine.ts'

const OUT_DIR = process.argv[2] ?? 'spike/out/26-v4-fix50-2026-08-22T12-49-03-413Z'

async function main(): Promise<void> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: 'argp spike28 sim-replay' } })
  // 边价值实验：三边源重放（P1 保留集差异）
  //   cites  —— 默认：从 events 内模型 cites 块重建语义边（= A₂ 保留集）
  //   clear  —— 跳过 cites 边（= A₁ 无边保留集）
  //   oracle —— 注入离线 oracle 边集（ORACLE_EDGES JSON：[{fromSeq,toSeq,level}]，见设计 §5.6）
  const EDGE_SOURCE = process.env['EDGE_SOURCE'] ?? 'cites'
  const windowTokens = Number(process.env['ARGP_WINDOW_TOKENS'] ?? 80_000)
  const retainTokens = Number(process.env['ARGP_RETAIN_TOKENS'] ?? 16_000)
  const engineConfig: ArgpGraphConfig = { windowTokens, retainTokens, maxPasses: 256 }
  if (EDGE_SOURCE === 'clear') engineConfig.disableCiteEdges = true
  if (EDGE_SOURCE === 'oracle') {
    const oraclePath = process.env['ORACLE_EDGES']
    if (oraclePath === undefined) throw new Error('EDGE_SOURCE=oracle 需要 ORACLE_EDGES 边集 JSON 路径（[{fromSeq,toSeq,level}]）')
    const rawEdges = JSON.parse(fs.readFileSync(oraclePath, 'utf8')) as { fromSeq: number; toSeq: number; level?: string }[]
    engineConfig.injectEdges = (atoms: Atom[]): SemanticEdge[] => {
      const bySeq = new Map(atoms.map(a => [a.seq, a.id]))
      const out: SemanticEdge[] = []
      for (const e of rawEdges) {
        const from = bySeq.get(e.fromSeq)
        const to = bySeq.get(e.toSeq)
        if (from === undefined || to === undefined) continue
        out.push({ from, to, level: (e.level ?? 's') as SemanticEdge['level'] })
      }
      return out
    }
  }
  await ctx.plugin(ArgpGraphEngine, engineConfig)
  const engine = ctx.compaction as ArgpGraphEngine
  const session = Session.create(SessionId('spike28-sim'))

  const lines = fs.readFileSync(path.resolve(OUT_DIR, 'events.jsonl'), 'utf8').split('\n').filter(Boolean)
  // CLEAN_SURFACE=1（分段标注实验用）：只保留 4 类有意义原子，排除 assistant/chunk 流式增量
  // 与 agent/inbox/request 等基础设施事件（它们会污染 surface 与边效应测量）。
  const SURFACE_TYPES = process.env['CLEAN_SURFACE'] === '1'
    ? new Set(['user/message', 'assistant/message', 'tool/result', 'tool/call'])
    : new Set(['user/message', 'assistant/message', 'assistant/chunk', 'tool/result', 'tool/call'])
  const SKIP_TYPES = new Set(['compaction/start', 'compaction/end', 'compaction/prune'])
  let events = 0
  let userCount = 0
  const compactionLog: { atSeq: number; turn: number; atoms: number; charsBefore: number; charsAfter: number; forced: boolean; candidates: number }[] = []
  let lastUserSeq = -1

  for (const l of lines) {
    const e = JSON.parse(l)
    if (SKIP_TYPES.has(e.type)) continue
    if (!SURFACE_TYPES.has(e.type)) continue
    try {
      session.append(e.type, e.data ?? {}, { surfaceOp: e.surfaceOp ?? 'append' } as never)
      events += 1
    } catch { continue }
    // 模拟 agent/pre-step：每个 user/message 事件后触发一次 pressure 检查
    if (e.type === 'user/message') {
      userCount += 1
      const recBefore = engine.records.length
      let result
      try {
        result = await engine.compactIfNeeded({ session } as never, 'pressure', new AbortController().signal)
      } catch (err) {
        console.log('[28] compactIfNeeded 抛错 @user#' + userCount + ': ' + (err instanceof Error ? err.message.slice(0, 120) : String(err)))
        continue
      }
      const rec = engine.records[engine.records.length - 1]
      if (rec !== undefined && engine.records.length > recBefore) {
        compactionLog.push({
          atSeq: e.seq, turn: e.data?.turn ?? userCount, atoms: rec.prunedAtoms.length,
          charsBefore: rec.charsBefore, charsAfter: rec.charsAfter,
          forced: rec.forced, candidates: rec.candidates,
        })
        // 调试：压缩后剩余原子 text 总和 vs retainChars
        const engAny = engine as unknown as {
          atomize(s: Session): { id: number; seq: number; type: string; turn: number; text: string }[]
          retainTokens: number
          charsPerToken: number
        }
        const atomsLeft = engAny.atomize(session)
        const textSum = atomsLeft.reduce((s, a) => s + a.text.length, 0)
        console.log('[28][dbg] 压缩后剩余原子=' + atomsLeft.length + ' text总和=' + textSum
          + ' retainChars=' + (engAny.retainTokens * engAny.charsPerToken))
      }
      lastUserSeq = e.seq
    }
  }

  const eng = engine as unknown as { visibleChars(s: Session): number; measureTokens(s: Session): { contextTokens: number; surfaceTokens: number } }
  const finalChars = eng.visibleChars(session)
  // 检查 tool 占位墓碑是否真实生成（半拆组验证）
  let toolTombstones = 0
  let userTombstones = 0
  for (const e of session.events) {
    const ev = e as { type?: string; surfaceOp?: unknown; data?: { content?: { type?: string; text?: string }[]; message?: { content?: { type?: string; text?: string }[] } } }
    if (ev.type === 'tool/result' && ev.surfaceOp !== undefined && typeof ev.surfaceOp === 'object'
      && (ev.surfaceOp as { op?: string }).op === 'replace') toolTombstones += 1
    const firstBlock = ev.data?.content?.[0] ?? ev.data?.message?.content?.[0]
    if (ev.type === 'user/message' && firstBlock?.type === 'text' && firstBlock.text?.includes('[elided')) userTombstones += 1
  }
  console.log('[tool-tombstone 检查] tool/result 墓碑=' + toolTombstones + ' user 墓碑=' + userTombstones)
  console.log('\n========== 模拟回放结果（修复后引擎） ==========')
  console.log('重放事件=' + events + ' user/message=' + userCount + ' surface.nodes=' + session.surface.nodes.length)
  console.log('压缩事务数=' + compactionLog.length + '（修复前真实：25）')
  let totalPruned = 0
  for (const c of compactionLog) {
    totalPruned += c.atoms
    console.log('  #' + String(compactionLog.indexOf(c) + 1).padStart(2) + ' turn=' + String(c.turn).padStart(2)
      + ' atoms=' + String(c.atoms).padStart(3) + ' chars ' + String(c.charsBefore).padStart(7) + '→' + String(c.charsAfter).padStart(7)
      + ' (' + (100 * (1 - c.charsAfter / c.charsBefore)).toFixed(0) + '%)'
      + ' forced=' + c.forced + ' candidates=' + c.candidates)
  }
  console.log('总剪原子=' + totalPruned)
  console.log('最终 surface=' + finalChars + ' 字符 ≈ ' + Math.round(finalChars / 3.5) + ' token（修复前真实：74.7K）')

  // P1 保留集输出：三边源对比用（shadowedSeqs 并集 = 被剪节点；交集差即边改变的保留集）
  const allShadowed = new Set<number>()
  for (const rec of engine.records) for (const s of rec.shadowedSeqs) allShadowed.add(s)
  fs.writeFileSync(path.join(OUT_DIR, 'shadowed-' + EDGE_SOURCE + '.json'), JSON.stringify([...allShadowed].sort((a, b) => a - b)), 'utf8')
  console.log('[edge-source=' + EDGE_SOURCE + '] 压缩事务=' + engine.records.length + ' 总遮蔽 seq=' + allShadowed.size
    + '；保留集差异源已写 ' + path.join(OUT_DIR, 'shadowed-' + EDGE_SOURCE + '.json'))
}

void main()
