/**
 * tiered 策略档契约测试（design-2.0 §2.5 提案栈 P5-a：v1.1 docStrongAll +
 * 宽度熔断 + v1.4 superseded 焦点豁免 + v1.2 裸码降出 hard）。
 *
 * 变异锁纪律：每条断言在对应机制被移除时必须变红——
 *  - 焦点文档全枚 hard（含可再生枚）；
 *  - 宽度熔断（焦点文档 hard 字节占比 > FOCAL_DOC_HARD_WIDTH_RATIO ⇒ 每文档最新一枚）；
 *  - 裸 errorcode 焦点降出 hard（tiered 下焦点 hard 只认 document facet）；
 *  - superseded 焦点豁免的排序翻转（flat 焦点旧版插队先剪 ↔ tiered 沉到非焦点后）；
 *  - flat 缺省与显式 'flat' 输出全等（现行为字节级不变的地基锁）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ArgpGraphEngine } from '../src/argp-graph-engine.ts'
import { FactorEngine, type FactorEngineHost } from '../src/factor/engine.ts'
import { sessionEvents } from '../src/log-access.ts'

async function makeTiered(tiered: 'flat' | 'tiered'): Promise<{ host: FactorEngineHost; factor: FactorEngine }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: 'tiered test persona' } })
  await ctx.plugin(ArgpGraphEngine, { windowTokens: 100, retainTokens: 50, recencyGuard: 0, maxPasses: 8 })
  const host = ctx.compaction as unknown as FactorEngineHost
  host.fileSnapshot = (key: string) => ({ key, mtimeMs: 1000, size: 100, exists: true })
  return { host, factor: new FactorEngine(host, { focalTiered: tiered }) }
}

/** 真实宿主给 user/message 带 data.turn；缺省 0 会被焦点窗口（turn > latest−focalTurns）滤光。 */
function appendUser(session: Session, turn: number, text: string): void {
  session.append('user/message', { ...createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), turn } as never, { surfaceOp: 'append' })
}

function appendGroup(session: Session, turn: number, callId: string, tool: string, args: string, resultText: string, isError = false): void {
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
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: resultText }], isError }],
      source: { kind: 'tool', callId },
      id: 'm_' + callId,
    },
  } as never, { surfaceOp: 'append' })
}

function makeSession(id: string): Session {
  const session = Session.create(SessionId(id))
  session.append('system/message', { content: 'persona' } as never, { surfaceOp: 'append' })
  return session
}

const A_PATH = 'C:/Proj/a.ts'
const READ_A = '{"file_path":"' + A_PATH + '"}'

test('flat 地基锁：缺省构造与显式 flat 的决策输出全等（现行为字节级不变）', async () => {
  // 同一事件序列灌进两台引擎（缺省 vs 显式 flat），plan 全等 + 遥测归零
  const build = async (tiered: 'flat' | 'tiered' | undefined): Promise<string> => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: 'flat lock persona' } })
    await ctx.plugin(ArgpGraphEngine, { windowTokens: 100, retainTokens: 50, recencyGuard: 0, maxPasses: 8 })
    const host = ctx.compaction as unknown as FactorEngineHost
    const factor = new FactorEngine(host, tiered === undefined ? {} : { focalTiered: tiered })
    const session = makeSession('flat-lock-' + String(tiered))
    host.bindSession(session)
    appendUser(session, 1, '开始任务')
    appendGroup(session, 1, 'c1', 'read', READ_A, 'X'.repeat(800))
    appendGroup(session, 1, 'c2', 'read', '{"file_path":"C:/Proj/z.ts"}', 'Z'.repeat(800))
    appendGroup(session, 2, 'c3', 'read', '{"file_path":"C:/Proj/z.ts"}', 'Z2'.repeat(800))
    appendUser(session, 2, '继续处理 ' + A_PATH)
    const d = factor.decide(session, 500)
    return JSON.stringify({ prune: d.plan.pruneOrder, hard: d.plan.hardProtected, docHard: d.focalDocHardChars, fuse: d.focalDocFuse, tier: d.focalTiered })
  }
  const implied = await build(undefined)
  const explicit = await build('flat')
  assert.equal(explicit, implied, '显式 flat 必须与缺省逐字段全等')
  const parsed = JSON.parse(implied) as { docHard: number; fuse: boolean; tier: string }
  assert.equal(parsed.docHard, 0, 'flat 档 focalDocHardChars 恒 0')
  assert.equal(parsed.fuse, false)
  assert.equal(parsed.tier, 'flat')
})

test('tiered：焦点文档的**可再生**枚也全枚 hard（flat 下该枚按可再生最先放剪）', async () => {
  // 两段时序（可再生快照纪律：重放批不采样）：先 decide 定基线，再灌在线读。
  const run = async (tiered: 'flat' | 'tiered'): Promise<{ softHasOnline: boolean; onlineSeq: number }> => {
    const { host, factor } = await makeTiered(tiered)
    const session = makeSession('docstrong-' + tiered)
    host.bindSession(session)
    appendUser(session, 1, '开始任务')
    appendGroup(session, 1, 'c1', 'read', READ_A, 'OLD'.repeat(300))
    factor.decide(session, 10) // 首观察=重放批
    appendUser(session, 2, '继续改 ' + A_PATH + ' 里的构造函数')
    appendGroup(session, 2, 'c2', 'read', READ_A, 'NEW'.repeat(300))
    appendGroup(session, 2, 'c3', 'bash', '{"command":"npm run build"}', 'ok') // 闭合 turn2（防 openTurn 混入）
    const d = factor.decide(session, 1000)
    const online = [...d.candidates.entries()].find(([, x]) => x.turn === 2 && x.tool === 'read')
    assert.ok(online !== undefined, '在线读必须在候选中')
    return { softHasOnline: d.plan.pruneOrder.includes(online[0]), onlineSeq: online[0] }
  }
  const flat = await run('flat')
  const tiered = await run('tiered')
  assert.equal(flat.softHasOnline, true, 'flat：焦点+可再生证明 ⇒ 按 §2.3 释放向放剪（现行为）')
  assert.equal(tiered.softHasOnline, false, 'tiered：用户裁定"涉及 document ⇒ 全枚保留"——可再生枚也 hard')
})

test('tiered：裸 errorcode 焦点降出 hard（flat 按 focalNonRegenerable 硬保）', async () => {
  const run = async (tiered: 'flat' | 'tiered'): Promise<boolean> => {
    const { host, factor } = await makeTiered(tiered)
    const session = makeSession('barecode-' + tiered)
    host.bindSession(session)
    appendUser(session, 1, '开始任务')
    appendGroup(session, 1, 'c1', 'bash', '{"command":"npm run build"}', 'FAILED: ENOENT while building', true)
    appendUser(session, 1, 'ENOENT error 这个还没解决') // 焦点轮文本只点名 errorcode，不点名文件
    const d = factor.decide(session, 1000)
    const errR = [...d.candidates.entries()].find(([, x]) => x.tags.errorcodes.length > 0)
    assert.ok(errR !== undefined, 'ENOENT 必须被贴码')
    return d.plan.hardProtected.includes(errR[0])
  }
  assert.equal(await run('flat'), true, 'flat：焦点非再生硬保（现行为）')
  assert.equal(await run('tiered'), false, 'tiered：裸码焦点不入 hard（v1.2 路由：码的价值在共现与频次，不在逐枚保留）')
})

test('tiered 宽度熔断：焦点文档 hard 占比超阈 ⇒ 每文档只保最新一枚（阈下全保）', async () => {
  const run = async (copies: number, filler: number): Promise<{ hardCopies: number; fuse: boolean }> => {
    const { host, factor } = await makeTiered('tiered')
    const session = makeSession('fuse-' + copies + '-' + filler)
    host.bindSession(session)
    appendUser(session, 1, '开始任务')
    for (let i = 0; i < copies; i++) appendGroup(session, 1, 'a' + i, 'read', READ_A, 'A'.repeat(2000))
    for (let i = 0; i < filler; i++) appendGroup(session, 1, 'f' + i, 'read', '{"file_path":"C:/Proj/f' + i + '.ts"}', 'F'.repeat(2000))
    appendUser(session, 2, '回顾 ' + A_PATH)
    appendGroup(session, 2, 'z1', 'bash', '{"command":"dir"}', 'listing ok') // 闭合焦点轮
    const d = factor.decide(session, 100000)
    const aSeqs = [...d.candidates.entries()].filter(([, x]) => x.tags.files.some(f => f.toLowerCase().endsWith('a.ts'))).map(([s]) => s)
    const hardCopies = aSeqs.filter(s => d.plan.hardProtected.includes(s)).length
    return { hardCopies, fuse: d.focalDocFuse }
  }
  // 2 枚焦点 / 30 枚填充 ⇒ 6KB/64KB ≈ 9.4% < 15% ⇒ 全保
  const under = await run(2, 30)
  assert.equal(under.fuse, false, '阈下不得触发熔断')
  assert.equal(under.hardCopies, 2, '阈下焦点文档全枚 hard')
  // 12 枚焦点 / 30 枚填充 ⇒ 24KB/84KB ≈ 28.6% > 15% ⇒ 熔断 ⇒ 只保最新一枚
  const over = await run(12, 30)
  assert.equal(over.fuse, true, '超阈必须熔断（保险不反噬预算）')
  assert.equal(over.hardCopies, 1, '熔断后每文档最新一枚')
})

test('tiered 三值焦点带：strong(文档)=2 > medium(白名单命令)=1 > none=0（medium 永不 hard）', async () => {
  // 焦点窗=turn3：npm 调用（args 通道 ⇒ medium 标签）；文本点名 a.ts（⇒ strong 文档标签）。
  const { host, factor } = await makeTiered('tiered')
  const session = makeSession('band3')
  host.bindSession(session)
  appendUser(session, 1, '开始任务')
  appendGroup(session, 2, 's1', 'read', READ_A, 'OLD ver A'.repeat(40))
  appendGroup(session, 2, 's2', 'read', READ_A, 'NEW ver A'.repeat(40))
  appendGroup(session, 2, 'm1', 'bash', '{"command":"npm run build"}', 'build ok')
  appendGroup(session, 2, 'n1', 'read', '{"file_path":"C:/Proj/y.ts"}', 'Y'.repeat(400))
  appendUser(session, 3, '回到 ' + A_PATH + ' 这个文件')
  appendGroup(session, 3, 'z', 'bash', '{"command":"npm run build"}', 'built again') // 焦点窗内的 npm 调用
  const d = factor.decide(session, 100000)
  const band = (id: string): number => {
    const s = [...d.candidates.entries()].find(([, x]) => x.callId === id)?.[0]
    assert.ok(s !== undefined, 'missing ' + id)
    return d.focalBandBySeq.get(s) as number
  }
  assert.equal(d.focalMediumSize, 1, '焦点窗 npm 调用 ⇒ medium 标签 1 个')
  assert.equal(band('s2'), 2, '焦点文档最新枚 = strong 带')
  assert.equal(band('s1'), 2, '焦点文档旧枚也占 strong 带（hard 归熔断管，带位归 facet 管）')
  assert.equal(band('m1'), 1, 'npm 命令原子 = medium 带')
  assert.equal(band('n1'), 0, '普通读 = none')
  assert.ok(!d.plan.hardProtected.includes((([...d.candidates.entries()].find(([, x]) => x.callId === 'm1')) as [number, unknown])[0]),
    'medium 严禁进 hard（§2.5 双变量隔离）')
  const idx = (id: string): number => d.plan.pruneOrder.indexOf(
    ([...d.candidates.entries()].find(([, x]) => x.callId === id) as [number, unknown])[0])
  assert.ok(idx('n1') < idx('m1'), 'none 带先剪于 medium 带（同 fresh 下带位先于体积）')
})

test('tiered 命令白名单：非白名单族（cd）不进 medium 标签', async () => {
  const { host, factor } = await makeTiered('tiered')
  const session = makeSession('bandcd')
  host.bindSession(session)
  appendUser(session, 1, '开始任务')
  appendGroup(session, 2, 'm1', 'bash', '{"command":"cd C:/Proj && dir"}', 'listing')
  appendGroup(session, 2, 'n1', 'read', '{"file_path":"C:/Proj/y.ts"}', 'Y'.repeat(400))
  appendUser(session, 3, '看看目录')
  appendGroup(session, 3, 'z', 'bash', '{"command":"cd C:/Proj && dir"}', 'listing2') // cd 族焦点调用
  const d = factor.decide(session, 100000)
  assert.equal(d.focalMediumSize, 0, 'cd 族被白名单挡在门外（爆炸半径定谳）')
  const m1 = [...d.candidates.entries()].find(([, x]) => x.callId === 'm1')?.[0]
  assert.equal(d.focalBandBySeq.get(m1 as number), 0, '非白名单命令原子停在 none 带')
})

test('flat 三值不越权：缺省构造命令焦点不产生标签/带位=布尔（地基锁补面）', async () => {
  const run = async (tiered: 'flat' | undefined): Promise<string> => {
    const { host, factor } = await makeTiered(tiered ?? 'flat')
    const session = makeSession('flatband-' + String(tiered))
    host.bindSession(session)
    appendUser(session, 1, '开始任务')
    appendGroup(session, 2, 'm1', 'bash', '{"command":"npm run build"}', 'build ok')
    appendGroup(session, 2, 'n1', 'read', '{"file_path":"C:/Proj/y.ts"}', 'Y'.repeat(400))
    appendUser(session, 3, '继续构建')
    appendGroup(session, 3, 'z', 'bash', '{"command":"npm run build"}', 'built')
    const d = factor.decide(session, 100000)
    return JSON.stringify({ prune: d.plan.pruneOrder, hard: d.plan.hardProtected, med: d.focalMediumSize, mediumChars: d.mediumBandChars })
  }
  assert.equal(await run('flat'), await run(undefined), 'flat 缺省与显式全等')
  assert.equal(JSON.parse(await run('flat')).med, 0, 'flat 不产 medium 标签（事件通道同关）')
})

test('tiered 豁免排序翻转：焦点命中的 superseded 旧版从"插队先剪"沉回非焦点之后', async () => {
  // C1=日志旧读（成功全读⇒可再生——错误扑空枚不可再生会被 flat 的 focalNonRegenerable
  // 硬保根本进不了剪序，矛盾面只有可再生枚能演示）；正文含 'ENOENT error' ⇒ 条件挂码，
  // 焦点经 errorcode 命中（非文档 ⇒ tiered 下不触 docStrong hard）；被 C2 同文件全量新读覆盖。
  // 四组必须走**在线段**（首 decide 之后）：可再生证明要求 append 时采样过快照。
  const run = async (tiered: 'flat' | 'tiered'): Promise<number[]> => {
    const { host, factor } = await makeTiered(tiered)
    const session = makeSession('exempt-' + tiered)
    host.bindSession(session)
    appendUser(session, 1, '开始任务')
    appendGroup(session, 1, 's0', 'read', '{"file_path":"C:/Proj/s.ts"}', 'SEED'.repeat(50))
    factor.decide(session, 10) // 首观察=重放批（不采样）
    appendGroup(session, 2, 'c1', 'read', '{"file_path":"C:/Proj/log.txt"}', 'ENOENT error at boot (old copy)')
    appendGroup(session, 2, 'c2', 'read', '{"file_path":"C:/Proj/log.txt"}', 'BOOT CLEAN now')
    appendGroup(session, 2, 'cy', 'read', '{"file_path":"C:/Proj/y.ts"}', 'Y'.repeat(400))
    appendUser(session, 3, 'ENOENT error 还没消停') // 焦点=errorcode:ENOENT
    appendGroup(session, 3, 'zq', 'bash', '{"command":"dir"}', 'listing ok') // 闭合轮
    const d = factor.decide(session, 100000)
    const idx = (callId: string): number => {
      const s = [...d.candidates.entries()].find(([, x]) => x.callId === callId)?.[0]
      assert.ok(s !== undefined, 'missing ' + callId)
      const at = d.plan.pruneOrder.indexOf(s)
      assert.ok(at >= 0, callId + ' 必须在剪序（本测试不验 hard）')
      return at
    }
    return [idx('c1'), idx('c2'), idx('cy')]
  }
  const flat = await run('flat')
  const tiered = await run('tiered')
  // flat：superseded 位排在 focal 前 ⇒ 焦点旧版插队先剪（§9.12 冲突面成因）
  assert.ok(flat[0] < flat[2], 'flat：superseded 排在 focal 前——焦点旧版插队先剪')
  // tiered：豁免只禁插队——c1 不再占 superseded=0 位，与 cy 同批按体积（cy 400B 先剪）。
  // （band 语义下 errorcode 命中的焦点带位=0 是 v1.2 裁定的本意，沉底由三值带测单锁。）
  assert.ok(tiered[0] > tiered[2], 'tiered：豁免生效——焦点命中的旧版不再插队')
})
