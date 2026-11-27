/**
 * /argp 卡面与语言解析的廉价锁（测试体系审计 T3 补面，2026-11-27）。
 *
 * 覆盖缺口两处（覆盖率门禁抬线时的定向补面，不做卡片/client 桩——成本高收益薄，
 * 台账 deferred）：
 *  ① resolveUiLocale 四形：显式 zh* → zh；显式 en/异形/缺失 → en；settings 经
 *     ctx.get 兜道命中；describe 抛错 → en（一切异常回退英文=维持现状方向）；
 *  ② renderArgpStatus 段 3：剪除索引报**会话桶真值**（批次 3-2 桶化语义），
 *     auditWarnings 露出且单条 >120 字符截断加省略号（卡面不刷屏）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ArgpEngine } from '../src/argp-engine.ts'
import { renderArgpStatus, type ArgpStatusHost } from '../src/argp-command.ts'
import { resolveUiLocale } from '../src/ui-locale.ts'

test('① resolveUiLocale 四形：zh*/异形/get 兜道/抛错回退', () => {
  assert.equal(resolveUiLocale({ settings: { describe: () => [{ ns: 'locale', value: { preference: 'zh-CN' } }] } }), 'zh')
  assert.equal(resolveUiLocale({ settings: { describe: () => [{ ns: 'locale', value: { preference: 'en-US' } }] } }), 'en')
  // settings 命名服务经 ctx.get 官方语义兜道（属性访问路径不可用时）
  assert.equal(resolveUiLocale({ get: (n: string) => n === 'settings'
    ? { describe: () => [{ ns: 'other', value: {} }, { ns: 'locale', value: { preference: 'zh' } }] } : undefined }), 'zh')
  // 缺失/异形/抛错一律回退英文（错误方向=维持现状）
  assert.equal(resolveUiLocale({}), 'en')
  assert.equal(resolveUiLocale({ settings: { describe: () => { throw new Error('boom') } } }), 'en')
  assert.equal(resolveUiLocale({ settings: { describe: () => [{ ns: 'locale', value: { preference: 42 } }] } }), 'en')
})

async function bootHost(tag: string): Promise<{ ctx: Context; host: ArgpStatusHost; session: Session }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: tag + ' persona' } })
  await ctx.plugin(ArgpEngine, { engine: 'factor', windowTokens: 4000, retainTokens: 400 })
  const host = ctx.compaction as unknown as ArgpStatusHost
  const session = Session.create(SessionId(tag))
  host.stateOf(session) // 建会话桶
  return { ctx, host, session }
}

test('② /argp 段 3 剪除索引=会话桶真值；auditWarnings 露出并 120 字符截断', async () => {
  const { ctx, host, session } = await bootHost('cmd-locks')
  try {
    const st = host.stateOf(session)
    const text = (locale: 'zh' | 'en'): string =>
      renderArgpStatus(host, { agent: { session } } as never, locale).text
    // 无告警 ⇒ 审计行不发（缺省面）
    assert.ok(!text('en').includes('audit:'), '零告警不得虚报审计行')

    st.records.push({
      id: 'tx1', charsBefore: 12_000, charsAfter: 4_000,
      intervals: [{}, {}, {}] as never[], shadowedSeqs: [1, 2, 3, 4, 5] as never, forced: false,
    } as never)
    st.prunedNodeTotal = 7
    const en = text('en')
    assert.match(en, /pruned index 7/, '★剪除索引必须报会话桶真值（批次 3-2 桶化，不读焦点桶/不伪造 0）')
    const zh = text('zh')
    assert.match(zh, /剪除索引 7/, 'zh 卡面同口径')

    st.auditWarnings.push('W'.repeat(200))
    st.auditWarnings.push('短告警')
    const en2 = text('en')
    assert.match(en2, /audit: 2 warning\(s\) · latest: 短告警/, '审计行计数=桶内条数')
    st.auditWarnings.pop()
    const en3 = text('en')
    assert.match(en3, /W{120}…/, '★超长告警截断 120 字符加省略号')
    assert.ok(!en3.includes('W'.repeat(121)), '原文 121+ 字符不得外溢')
  } finally {
    await ctx.fiber.dispose()
  }
})
