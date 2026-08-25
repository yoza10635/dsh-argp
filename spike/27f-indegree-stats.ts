// spike 27f：验证"双重保护死循环"假设——入度 0 的原子是否集中在尾部/最新轮
// 数据源：26-v4-fix50（v4 修复后 50 轮完整跑，25 次压缩）
// 统计：入度 0 原子分布（turn / 从尾部位置 / 是否落入新鲜保护区）
import fs from 'node:fs'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ArgpGraphEngine } from '../src/argp-graph-engine.ts'

const OUT_DIR = process.argv[2] ?? 'spike/out/26-v4-fix50-2026-08-22T12-49-03-413Z'

async function main(): Promise<void> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: 'argp spike27f stats' } })
  await ctx.plugin(ArgpGraphEngine, {
    windowTokens: 80_000, retainTokens: 16_000, minSpanChars: 20, recencyGuard: 0, maxPasses: 16,
  })
  const engine = ctx.compaction as ArgpGraphEngine
  const session = Session.create(SessionId('spike27f-replay'))

  const lines = fs.readFileSync(path.resolve(OUT_DIR, 'events.jsonl'), 'utf8').split('\n').filter(Boolean)
  const SURFACE_TYPES = new Set(['user/message', 'assistant/message', 'assistant/chunk', 'tool/result', 'tool/call'])
  for (const l of lines) {
    const e = JSON.parse(l)
    if (!SURFACE_TYPES.has(e.type) && e.type !== 'compaction/start' && e.type !== 'compaction/end' && e.type !== 'compaction/prune') continue
    try {
      session.append(e.type, e.data ?? {}, { surfaceOp: e.surfaceOp ?? 'append' } as never)
    } catch {
      /* skip */
    }
  }
  engine.setSession(session)

  const eng = engine as unknown as {
    atomize(s: Session): { id: number; seq: number; type: string; turn: number; text: string }[]
    buildGraph(atoms: unknown[]): { edges: { from: number; to: number; level: string }[]; inDegree: Map<number, number> }
  }
  const atoms = eng.atomize(session)
  const { inDegree } = eng.buildGraph(atoms)
  const surfaceSeqs = [...session.surface.nodes]
  const posOf = new Map(surfaceSeqs.map((seq, i) => [seq, i]))
  const latestTurn = atoms.reduce((m, a) => Math.max(m, a.turn), 0)
  const n = atoms.length
  const surfaceLen = surfaceSeqs.length
  // 默认保护参数（引擎默认 recencyGuard=4 / turnGuard=1）
  const recencyGuard = 4
  const turnGuard = 1

  const deg0 = atoms.filter(a => (inDegree.get(a.id) ?? 0) === 0)
  const degGt0 = atoms.filter(a => (inDegree.get(a.id) ?? 0) > 0)
  const stat = (label: string, list: typeof atoms): void => {
    const fromEnd = list.map(a => surfaceLen - 1 - (posOf.get(a.seq) ?? -1))
    const fresh = list.filter(a => (posOf.get(a.seq) ?? -1) >= surfaceLen - recencyGuard)
    const newTurn = list.filter(a => a.turn > latestTurn - turnGuard)
    const oldOrphan = list.filter(a => !fresh.includes(a) && !newTurn.includes(a))
    console.log(label + ': n=' + list.length)
    console.log('  从尾部位置分布: 最近4=' + fresh.length + ' 最近5-10=' + list.filter(a => { const p = posOf.get(a.seq) ?? -1; const fe = surfaceLen - 1 - p; return fe > 4 && fe <= 10 }).length
      + ' 中部(11-50%)=' + list.filter(a => { const p = posOf.get(a.seq) ?? -1; return p < surfaceLen * 0.5 && p >= surfaceLen - 10 }).length
      + ' 前半(<50%)=' + list.filter(a => (posOf.get(a.seq) ?? -1) < surfaceLen * 0.5).length)
    console.log('  最新轮(turn>' + (latestTurn - turnGuard) + ')=' + newTurn.length + ' 新鲜保护区(尾部' + recencyGuard + ')=' + fresh.length)
    console.log('  【真实可剪候选】= 入度0 ∩ 非新鲜 ∩ 非最新轮 = ' + oldOrphan.length)
  }
  stat('全部原子', atoms)
  stat('入度=0（孤立）', deg0)
  stat('入度>0（被引用）', degGt0)

  console.log('\nsurface.nodes=' + surfaceLen + ' 原子数=' + n + ' latestTurn=' + latestTurn)
  console.log('入度0占比=' + (100 * deg0.length / n).toFixed(1) + '%')
  // 入度0 且旧的样例（前 8 个）
  const oldOrphans = deg0.filter(a => (posOf.get(a.seq) ?? -1) < surfaceLen - recencyGuard && a.turn <= latestTurn - turnGuard)
  console.log('可剪候选样例（前8）: ' + oldOrphans.slice(0, 8).map(a => 'seq=' + a.seq + ' type=' + a.type + ' turn=' + a.turn + ' fromEnd=' + (surfaceLen - 1 - (posOf.get(a.seq) ?? -1))).join(' | '))
}

main().catch(err => { console.error(err); process.exit(1) })
