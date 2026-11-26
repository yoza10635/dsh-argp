/**
 * 用户可见压缩回执文案回归锁（2026-11-27）。
 *
 * 事故背景：旧摘要形如「ARGP 墓碑归并（§11.8①）：145 墓碑 / 31 区间归并为聚合占位（约 327 tok 回收）」
 * ——§编号、墓碑、聚合占位、tok 全是开发者黑话，装插件的普通用户根本读不懂，且 327 这个数
 * 与「压缩了多少历史」无关。
 *
 * 本锁保证 UI 摘要满足：① 无内部术语（§/墓碑/surface/原子/0-LLM/sourceEventSeqs）；
 * ② 数字走「万/千」可读格式；③ 必带「原文还在、可逐字找回」。
 *
 * 变异映射：
 *  - 有人把 §/墓碑 之类的黑话加回 compactionSummaryText ⇒ 用例 2 红；
 *  - 去掉「原文还在」这句 ⇒ 用例 3 红；
 *  - formatTokenCount 退回裸数字 ⇒ 用例 1 红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { formatTokenCount, compactionSummaryText, estimateSurfaceRelease, type ReportKind } from '../src/compaction-report.ts'

const KINDS: ReportKind[] = ['tombstone-merge', 'factor-prune', 'factor-prose', 'graph-prune']
const JARGON = ['§', '墓碑', 'surface', '原子', '0-LLM', 'sourceEventSeqs', 'tok ', '聚合占位', '协议组剪']

test('formatTokenCount：万/千/个 三档可读格式', () => {
  assert.equal(formatTokenCount(327), '327 token')
  assert.equal(formatTokenCount(1500), '1.5 千 token')
  assert.equal(formatTokenCount(79_122), '7.9 万 token')
  assert.equal(formatTokenCount(194_285), '19.4 万 token')
})

test('compactionSummaryText：四种事务均无内部术语', () => {
  for (const kind of KINDS) {
    const text = compactionSummaryText(kind, { count: 145, intervals: 31, releaseTokens: 327 })
    for (const word of JARGON) {
      assert.ok(!text.includes(word), `${kind} 文案出现内部术语「${word}」：${text}`)
    }
  }
})

test('compactionSummaryText：必带「原文还在、可找回」的安全感句', () => {
  for (const kind of KINDS) {
    const text = compactionSummaryText(kind, { count: 3, intervals: 2, releaseTokens: 12_000 })
    assert.ok(text.includes('原文') && text.includes('找回'), `${kind} 缺少找回承诺：${text}`)
  }
})

test('estimateSurfaceRelease：CJK 内容不按 4 字/token 低估', () => {
  const session = Session.create(SessionId('report-release'))
  session.append('system/message', { content: 'persona' } as never, { surfaceOp: 'append' })
  const zh = '上下文压缩'.repeat(100) // 500 个汉字 ⇒ 1.7 口径 ≈ 295 tok；4 字口径只有 125
  const ev = session.append('assistant/message', {
    stream: [], turn: 1, step: 1,
    message: { source: { provider: 't', model: 't' }, content: [{ type: 'text', text: zh }] },
  } as never, { surfaceOp: 'append' })
  const tokens = estimateSurfaceRelease(session, [(ev as unknown as { seq: number }).seq])
  assert.ok(tokens > 250, `中文 500 字应估 >250 tok，实测 ${tokens}`)
})
