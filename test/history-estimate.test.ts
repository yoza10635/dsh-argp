/**
 * 回归锁（2026-11-27 统计口径修复）：压缩日志的「历史体量」估算。
 *
 * 事故背景：00:30 手动 /compact 的 §11.8 归并事务（145 墓碑 → 31 聚合占位）在日志里只报
 * `约 339 tok 回收`——因为 `shadowedTokenCount` 按被替换节点（9 字桩）文本 ÷ 4 计，而 145 枚桩
 * 背后代表的历史（sourceEventSeqs 链）是 475 条事件 / 82.5 万字符。用户读到的「300 多 token」
 * 显然不合理。本锁保证 `estimateHiddenHistory` 沿链解析到历史原文，而不是桩文本。
 *
 * 变异映射：
 *  - 把 estimateHiddenHistory 改成只量节点自身文本（不看 sourceEventSeqs） ⇒ 用例 1 红（≈3 tok）；
 *  - 去掉全局去重（同一历史被多桩重复计） ⇒ 用例 2 红；
 *  - 改成 AST 字符数而非 CJK 加权密度 ⇒ 用例 1 的区间断言红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { estimateHiddenHistory } from '../src/factor/history-estimate.ts'

const STUB = '已压缩剪枝次要原子'

function checkpoint(session: Session, shadowSeqs: number[], text = STUB): number {
  const ev = session.append('user/message', {
    ...createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
  } as never, {
    surfaceOp: { op: 'replace', startSeq: shadowSeqs[0] as never, endSeq: shadowSeqs[shadowSeqs.length - 1] as never },
    sourceEventSeqs: shadowSeqs as never,
  })
  return (ev as unknown as { seq: number }).seq
}

test('history-estimate: 桩代表的历史体量（而非桩文本）', () => {
  const session = Session.create(SessionId('he-origin'))
  session.append('system/message', { content: 'persona' } as never, { surfaceOp: 'append' })
  const big = 'A'.repeat(7000) // 7000 ASCII 字符 ⇒ 3.5 口径 ≈ 2000 tok
  const origin = session.append('assistant/message', {
    stream: [], turn: 1, step: 1,
    message: { source: { provider: 't', model: 't' }, content: [{ type: 'text', text: big }] },
  } as never, { surfaceOp: 'append' })
  const ckSeq = checkpoint(session, [(origin as unknown as { seq: number }).seq])

  const est = estimateHiddenHistory(session, [ckSeq])
  assert.equal(est.originSeqs.length, 1, '应解析出 1 条原始事件')
  assert.equal(est.chars, 7000, '历史字符数应来自原始事件正文')
  assert.ok(est.tokens > 1900 && est.tokens < 2100, `历史体量应≈2000 tok，实测 ${est.tokens}`)
  // 反证：只量桩文本会得到 ceil(9/1.7)=6 tok —— 与真实体量差 3 个数量级
  assert.ok(est.tokens > 100, '不得退化成桩文本口径')
})

test('history-estimate: 链式桩解析 + 全局去重（同一历史不被重复计）', () => {
  const session = Session.create(SessionId('he-chain'))
  session.append('system/message', { content: 'persona' } as never, { surfaceOp: 'append' })
  const origin = session.append('assistant/message', {
    stream: [], turn: 1, step: 1,
    message: { source: { provider: 't', model: 't' }, content: [{ type: 'text', text: 'B'.repeat(3500) }] },
  } as never, { surfaceOp: 'append' })
  const ck1 = checkpoint(session, [(origin as unknown as { seq: number }).seq])
  const ck2 = checkpoint(session, [ck1])

  // 两个桩都指向同一历史：全局去重后只计一次 3500 字符
  const est = estimateHiddenHistory(session, [ck1, ck2])
  assert.equal(est.originSeqs.length, 1, '链式解析应回到同一条原始事件')
  assert.equal(est.chars, 3500)
  assert.equal(est.tokens, Math.ceil(3500 / 3.5))
})

test('history-estimate: 输入只有最新一枚桩时，不得把中间胖检查点文本也算进历史', () => {
  // 2026-11-27 rev-search 实测旧实现虚高 3.39×：原文 10,000 字 + 中间检查点 26,000 字全进同一个
  // chars。可达路径真实存在（夹剪组检查点带头尾预览、散文检查点可达 20K，且旧检查点会被后续
  // 散文 span 吞并 ⇒「摘要的摘要」每层多计一层）。旧用例 2 恰好把 ck1 也放进输入集，绕开了这条。
  const session = Session.create(SessionId('he-fat-chain'))
  session.append('system/message', { content: 'persona' } as never, { surfaceOp: 'append' })
  const big = 'X'.repeat(10_000)
  const origin = session.append('assistant/message', {
    stream: [], turn: 1, step: 1,
    message: { source: { provider: 't', model: 't' }, content: [{ type: 'text', text: big }] },
  } as never, { surfaceOp: 'append' })
  const originSeq = (origin as unknown as { seq: number }).seq
  const ckFat = checkpoint(session, [originSeq], '头尾留真预览'.repeat(4000)) // 24K 字符的胖检查点
  const ckThin = checkpoint(session, [ckFat])

  const est = estimateHiddenHistory(session, [ckThin])
  assert.equal(est.chars, 10_000, `只应计原文 10,000 字，实测 ${est.chars}（中间桩文本被重复计入）`)
  assert.equal(est.originSeqs.length, 1, `原始事件应恰 1 条，实测 ${est.originSeqs.length}`)
  assert.deepEqual([...est.originSeqs], [originSeq], '叶子必须回到原始事件本体')
  assert.equal(est.capped, false, '未触上限不应标记 capped')
})
