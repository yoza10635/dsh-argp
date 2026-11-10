/**
 * err 签名 exemplar 契约测试（design-2.0 §2.5 提案栈 P5-c：v1.2 路由 + v1.3 exemplar）。
 *
 * 变异锁纪律：每条在对应机制被移除时必须变红——
 *  - sticky 归因一枚化（摘 ⇒ 测1 旧枚在 tiered 被硬保）；
 *  - n≥2 准入线（摘门槛 ⇒ 测2 n=1 枚被硬保）；
 *  - 成功后失效（摘 ⇒ 测3 exemplar 不释放）；
 *  - 裸码（仅 tool 因子）走词表不进 hard（摘 ⇒ 测4 被硬保）；
 *  - errSig 线独立于 sticky 成立（摘 ⇒ 测5 exemplar 掉出 hard）；
 *  - flat 缺省与显式 flat 输出全等（现行为字节级不变地基锁）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ArgpGraphEngine } from '../src/argp-graph-engine.ts'
import { FactorEngine, type FactorEngineHost } from '../src/factor/engine.ts'

async function makeErrsig(tiered: 'flat' | 'tiered' | undefined): Promise<{ host: FactorEngineHost; factor: FactorEngine }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: 'errsig test persona' } })
  await ctx.plugin(ArgpGraphEngine, { windowTokens: 100, retainTokens: 50, recencyGuard: 0, maxPasses: 8 })
  const host = ctx.compaction as unknown as FactorEngineHost
  host.fileSnapshot = (key: string) => ({ key, mtimeMs: 1000, size: 100, exists: true })
  return { host, factor: new FactorEngine(host, tiered === undefined ? {} : { focalTiered: tiered }) }
}

/** 真实宿主给 user/message 带 data.turn；末条纯文本 U 兼作"焦点窗内无标签"的清场枚。 */
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
const WRITE_A = '{"file_path":"' + A_PATH + '"}'
const ERR1 = 'ENOENT error on ' + A_PATH
const ERR2 = 'ENOENT error again ' + A_PATH

interface ProbeOut {
  d: ReturnType<FactorEngine['decide']>
  seqOf: (callId: string) => number
  isHard: (id: string) => boolean
  inPrune: (id: string) => boolean
}

/** 焦点窗只扫末轮 U/A 文本；所有 fixture 以纯文本 U 收尾 ⇒ focal 恒空，隔离本测因子。 */
async function decideBoth(idTag: string, build: (s: Session) => void): Promise<{ flat: ProbeOut; tiered: ProbeOut }> {
  const probe = async (tiered: 'flat' | 'tiered'): Promise<ProbeOut> => {
    const { host, factor } = await makeErrsig(tiered)
    const session = makeSession(idTag + '-' + tiered)
    host.bindSession(session)
    build(session)
    const d = factor.decide(session, 100000)
    const seqOf = (callId: string): number => {
      const s = [...d.candidates.entries()].find(([, x]) => x.callId === callId)?.[0]
      assert.ok(s !== undefined, 'missing ' + callId)
      return s
    }
    return { d, seqOf, isHard: (id: string) => d.plan.hardProtected.includes(seqOf(id)), inPrune: (id: string) => d.plan.pruneOrder.includes(seqOf(id)) }
  }
  return { flat: await probe('flat'), tiered: await probe('tiered') }
}

test('tiered sticky 归因一枚化：(file×code) 对只保最新一枚；flat 保持逐枚硬保', async () => {
  const { flat, tiered } = await decideBoth('stickyex', s => {
    appendUser(s, 1, '开始任务')
    appendGroup(s, 1, 'e1', 'read', READ_A, ERR1, true)
    appendGroup(s, 2, 'w1', 'write', WRITE_A, 'patched ok') // 修复宣称 ⇒ 夹成 sticky 轨
    appendGroup(s, 3, 'e2', 'read', READ_A, ERR2, true)
    appendUser(s, 4, '先这样')
  })
  assert.ok(flat.isHard('e1') && flat.isHard('e2'), 'flat：sticky 逐枚硬保（现行为，spike53 白烧面 249KB 的成因）')
  assert.ok(tiered.isHard('e2'), 'tiered：exemplar（最新一枚）保住')
  assert.ok(!tiered.isHard('e1') && tiered.inPrune('e1'), 'tiered：旧枚释放进剪序')
})

test('tiered n=1 豁免：仅出现 1 次的签名组合不进 hard（1 次=100% 假捆绑）', async () => {
  const { tiered } = await decideBoth('nsingle', s => {
    appendUser(s, 1, '开始任务')
    appendGroup(s, 1, 'e1', 'read', READ_A, ERR1, true)
    appendUser(s, 2, '好的')
  })
  assert.equal(tiered.d.errSigHardCount, 0, 'n=1 组必须一个都不硬')
  assert.ok(!tiered.isHard('e1') && tiered.inPrune('e1'), 'tiered：n=1 签名枚走普通排序')
})

test('tiered 成功后失效：同文件后续成功读 ⇒ exemplar 释放（sticky/errSig 共用释放阀）', async () => {
  const { flat, tiered } = await decideBoth('release', s => {
    appendUser(s, 1, '开始任务')
    appendGroup(s, 1, 'e1', 'read', READ_A, ERR1, true)
    appendGroup(s, 2, 'w1', 'write', WRITE_A, 'patched ok') // sticky 成立
    appendGroup(s, 3, 'e2', 'read', READ_A, ERR2, true)
    appendGroup(s, 4, 'ok1', 'read', READ_A, 'FILE CONTENT now fine') // 成功清障
    appendUser(s, 5, '好的')
  })
  assert.ok(flat.isHard('e2'), 'flat：sticky 轨不因成功读解除（现行为：只随窗口闭合）')
  assert.ok(!tiered.isHard('e2') && tiered.inPrune('e2'), 'tiered：成功后失效——exemplar 也释放')
  assert.ok(!tiered.isHard('e1'), 'tiered：旧枚本就不硬')
})

test('tiered 裸码走词表：仅 tool 因子的签名复发 ≥2 也不进 hard（v1.2 路由）', async () => {
  const { tiered } = await decideBoth('bare', s => {
    appendUser(s, 1, '开始任务')
    appendGroup(s, 1, 'q1', 'webfetch', '{"url":"http://x"}', 'ECONNREFUSED error here', true)
    appendGroup(s, 2, 'q2', 'webfetch', '{"url":"http://y"}', 'ECONNREFUSED error again', true)
    appendUser(s, 3, '好的')
  })
  assert.equal(tiered.d.errSigHardCount, 0, '裸码（无 file/cmd 因子）组不得入 errSig hard')
  assert.ok(!tiered.isHard('q1') && !tiered.isHard('q2'), 'tiered：裸码枚走词表 note/普通排序')
})

test('tiered errSig 线独立于 sticky：复发两连但无修复宣称 ⇒ exemplar 仍硬', async () => {
  // 两连失败之间无成功写 ⇒ 轨停在 open（sticky 不成立）——flat 零保护，tiered 由 n≥2 线保住 exemplar。
  const { flat, tiered } = await decideBoth('erronly', s => {
    appendUser(s, 1, '开始任务')
    appendGroup(s, 1, 'e1', 'read', READ_A, ERR1, true)
    appendGroup(s, 2, 'e2', 'read', READ_A, ERR2, true)
    appendUser(s, 3, '好的')
  })
  assert.ok(!flat.isHard('e1') && !flat.isHard('e2'), 'flat：open 轨不保护（现行为）')
  assert.ok(tiered.isHard('e2'), 'tiered：会话内复发 ≥2 ⇒ exemplar 硬保（两条 hard 准入线之二）')
  assert.ok(!tiered.isHard('e1') && tiered.inPrune('e1'), 'tiered：只保 exemplar 一枚')
})

test('flat 地基锁（错误签名场景）：缺省与显式 flat 决策输出全等', async () => {
  const build = async (tiered: 'flat' | undefined): Promise<string> => {
    const { host, factor } = await makeErrsig(tiered)
    const session = makeSession('flatlock-' + String(tiered))
    host.bindSession(session)
    appendUser(session, 1, '开始任务')
    appendGroup(session, 1, 'e1', 'read', READ_A, ERR1, true)
    appendGroup(session, 2, 'w1', 'write', WRITE_A, 'patched ok')
    appendGroup(session, 3, 'e2', 'read', READ_A, ERR2, true)
    appendGroup(session, 3, 'q1', 'webfetch', '{"url":"http://x"}', 'ECONNREFUSED error here', true)
    appendUser(session, 4, '先这样')
    const d = factor.decide(session, 500)
    return JSON.stringify({
      prune: d.plan.pruneOrder, hard: d.plan.hardProtected,
      docHard: d.focalDocHardChars, fuse: d.focalDocFuse, tier: d.focalTiered, errSig: d.errSigHardCount,
    })
  }
  const implied = await build(undefined)
  const explicit = await build('flat')
  assert.equal(explicit, implied, '显式 flat 必须与缺省逐字段全等')
  assert.equal((JSON.parse(implied) as { errSig: number }).errSig, 0, 'flat 档 errSigHardCount 恒 0')
})
