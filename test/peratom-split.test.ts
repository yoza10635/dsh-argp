import test from 'node:test'
import assert from 'node:assert/strict'
import { ARG_NS, isArgpUserInfo, SPLIT_THRESHOLD_CHARS } from '../src/peratom/types.ts'
import type { ArgpUserMeta } from '../src/peratom/types.ts'
import {
  COVERAGE_FLIP,
  SPLIT_ELLIPSIS,
  buildDialogText,
  buildInfoText,
  complementGaps,
  locateQuotes,
  resolveSplit,
} from '../src/peratom/split.ts'
import { classifyUserMessage } from '../src/argp-graph-engine.ts'
import { corpusCase, SPLIT_CORPUS, buildText, D, I } from './fixtures/split-corpus.ts'
import type { Span } from './fixtures/split-corpus.ts'

// ---------------------------------------------------------------------------
// 常量与类型守卫
// ---------------------------------------------------------------------------

test('P0 常量口径（plan：阈值 100 / 命名空间 argp / 翻转阈值 0.8）', () => {
  assert.equal(SPLIT_THRESHOLD_CHARS, 100)
  assert.equal(ARG_NS, 'argp')
  assert.equal(COVERAGE_FLIP, 0.8)
})

test('isArgpUserInfo：识别 data[argp].info 标记，容忍异形输入', () => {
  const meta: ArgpUserMeta = { info: true, sourceSeq: 42 }
  assert.equal(isArgpUserInfo({ [ARG_NS]: meta }), true)
  // 分类只看 info 旗标：sourceSeq 缺失属于落盘 bug，但不应把副本推向 X 方向（保守原则）
  assert.equal(isArgpUserInfo({ [ARG_NS]: { info: true } }), true)
  assert.equal(isArgpUserInfo({ source: { kind: 'plugin' } }), false)
  assert.equal(isArgpUserInfo(undefined), false)
  assert.equal(isArgpUserInfo('garbage'), false)
})

// ---------------------------------------------------------------------------
// 分类陷阱（plan P0「分类陷阱」节）：info 判定必须先于 plugin-source → X
// ---------------------------------------------------------------------------

test('classifyUserMessage：U-info 即使带 plugin source 也必须是 U（陷阱主断言）', () => {
  const infoData = {
    [ARG_NS]: { info: true, sourceSeq: 7 },
    source: { kind: 'plugin' },
  }
  assert.equal(classifyUserMessage(infoData), 'U', 'U-info 被判成 X 则永远进不了剪枝候选集')
})

test('classifyUserMessage：墓碑/checkpoint（plugin 源、无 info 标记）仍是 X；普通用户消息是 U', () => {
  assert.equal(classifyUserMessage({ source: { kind: 'plugin' } }), 'X')
  assert.equal(classifyUserMessage({ source: { kind: 'user' } }), 'U')
  assert.equal(classifyUserMessage({}), 'U')
  assert.equal(classifyUserMessage(undefined), 'U')
})

// ---------------------------------------------------------------------------
// locateQuotes：定位原语
// ---------------------------------------------------------------------------

test('locateQuotes：多片段按首现位置定位并排序（乱序输入产出有序 spans）', () => {
  const msg = '指令一：AAA资料BBB指令二：CCC'
  const r = locateQuotes(['指令二：', '指令一：'], msg)
  assert.deepEqual(r.misses, [])
  assert.deepEqual(r.spans, [[0, 4], [12, 16]])
})

test('locateQuotes：改写片段记入 misses；非数组输入整体记 miss', () => {
  const r1 = locateQuotes(['不存在的片段'], '原文')
  assert.deepEqual(r1.spans, [])
  assert.deepEqual(r1.misses, ['不存在的片段'])
  const r2 = locateQuotes('not an array', '原文')
  assert.deepEqual(r2.spans, [])
  assert.deepEqual(r2.misses, ['<not-an-array>'])
})

test('locateQuotes：重叠片段合并（抄写的错是丢失而非漂移，合并不算异常）', () => {
  const r = locateQuotes(['abc', 'cde'], 'xabcdey')
  assert.deepEqual(r.spans, [[1, 6]])
})

// ---------------------------------------------------------------------------
// resolveSplit：策略裁决
// ---------------------------------------------------------------------------

test('resolveSplit：C04 多区间交错 → split，dialogSpans 与金标逐一重合', () => {
  const { text, goldSpans } = corpusCase('C04')
  const quotes = goldSpans.map(([s, e]) => text.slice(s, e))
  const res = resolveSplit(text, quotes)
  assert.equal(res.kind, 'split')
  if (res.kind !== 'split') return
  assert.deepEqual(res.dialogSpans, goldSpans)
  assert.equal(res.infoSpans.length, 2)
  for (const [s, e] of res.dialogSpans) {
    assert.ok(quotes.includes(text.slice(s, e)), 'dialog 切片必须逐字节等于原文对应段')
  }
})

test('resolveSplit：C15 极短连接语 → 三段 dialog 全部保住（空隙归 info 的最坏情形）', () => {
  const { text, goldSpans } = corpusCase('C15')
  const quotes = goldSpans.map(([s, e]) => text.slice(s, e))
  const res = resolveSplit(text, quotes)
  assert.equal(res.kind, 'split')
  if (res.kind !== 'split') return
  assert.equal(res.dialogSpans.length, 3)
  assert.equal(buildDialogText(text, res.dialogSpans),
    '先看A：' + SPLIT_ELLIPSIS + '再看B：' + SPLIT_ELLIPSIS + '最后汇总成一张对比表。')
})

test('resolveSplit：零标注 → 整条 U-info（纯资料消息的自然退化）', () => {
  const { text } = corpusCase('C02')
  assert.deepEqual(resolveSplit(text, []), { kind: 'info-only' })
})

test('resolveSplit：任一片段定位失败 → 整条回退 dialog（优先于 info-only；保真不变式优先）', () => {
  const { text } = corpusCase('C01')
  assert.deepEqual(resolveSplit(text, ['彻底编造的引用']), { kind: 'fallback-dialog' })
  assert.deepEqual(resolveSplit(text, 'not-an-array'), { kind: 'fallback-dialog' })
})

test('resolveSplit：C10 空白规范化抄写（双空格被吞）→ 定位失败 → 回退 dialog', () => {
  const { text, goldSpans } = corpusCase('C10')
  const exact = text.slice(goldSpans[0]![0], goldSpans[0]![1])
  assert.equal(resolveSplit(text, [exact]).kind, 'split', '逐字抄写应命中')
  const normalized = exact.replace(/ {2}/g, ' ').trim()
  assert.equal(resolveSplit(text, [normalized]).kind, 'fallback-dialog', '被规范化的抄写必须失败而非错切')
})

test('resolveSplit：覆盖率 ≥80% 翻转为整条 dialog；恰好 80% 也翻转；70% 正常拆分', () => {
  const msg10 = 'abcdefghij'
  assert.deepEqual(resolveSplit(msg10, ['abcdefg', 'hij']), { kind: 'unsplit', reason: 'coverage-flip' })
  assert.deepEqual(resolveSplit(msg10, ['abcdefgh']), { kind: 'unsplit', reason: 'coverage-flip' })
  assert.equal(resolveSplit(msg10, ['abcdefg']).kind, 'split')
})

test('resolveSplit：纯空白间隙被丢弃 → 无实质余量时整条保留为 dialog；空消息守卫', () => {
  assert.deepEqual(resolveSplit('指令A：\n \n指令B：', ['指令A：', '指令B：']),
    { kind: 'unsplit', reason: 'no-info-remainder' })
  assert.deepEqual(resolveSplit('', ['x']), { kind: 'unsplit', reason: 'empty-message' })
})

test('complementGaps：空白过滤开关（给文本过滤 / 不给文本为纯几何补集）', () => {
  const spans: Span[] = [[0, 2], [5, 7]]
  assert.deepEqual(complementGaps(spans, 7, 'AB   CD'), [], '补集中的纯空白间隙被过滤')
  assert.deepEqual(complementGaps(spans, 7), [[2, 5]], '不给文本则为纯几何补集')
})

// ---------------------------------------------------------------------------
// 文本构建：UTF-16 代理对（emoji）与省略标记
// ---------------------------------------------------------------------------

test('buildDialogText/buildInfoText：emoji 消息的切片逐字节正确（代理对不劈开）', () => {
  const msg = '🚀 先看风险项：\n[deploy] 🚨 canary-2 failed (503)\n列出来。'
  const res = resolveSplit(msg, ['🚀 先看风险项：', '列出来。'])
  assert.equal(res.kind, 'split')
  if (res.kind !== 'split') return
  assert.equal(buildDialogText(msg, res.dialogSpans), '🚀 先看风险项：' + SPLIT_ELLIPSIS + '列出来。')
  assert.equal(buildInfoText(msg, res.infoSpans), '\n[deploy] 🚨 canary-2 failed (503)\n')
})

// ---------------------------------------------------------------------------
// 语料级扫描：spike 32 全部 18 用例过一遍策略裁决（plan 验收判据的 fixture 化）
// ---------------------------------------------------------------------------

test('语料扫描：零标注→info-only；全覆盖→flip；其余→split 且 dialog 片段逐字节忠实', () => {
  const expectKind: Record<string, string> = {
    C02: 'info-only',
    C03: 'unsplit', // 全指令消息覆盖率 100%，触发翻转
  }
  for (const c of SPLIT_CORPUS) {
    const { text, goldSpans } = buildText(c.parts)
    const quotes = goldSpans.map(([s, e]) => text.slice(s, e))
    const res = resolveSplit(text, quotes)
    assert.equal(res.kind, expectKind[c.id] ?? 'split', `${c.id}: ${c.note}`)
    if (res.kind === 'split') {
      for (const [s, e] of res.dialogSpans) {
        assert.ok(quotes.includes(text.slice(s, e)), `${c.id} dialog 切片失真`)
      }
    }
  }
})

// ---------------------------------------------------------------------------
// 金标健全性（与 spike 32 自检同口径）
// ---------------------------------------------------------------------------

test('语料健全性：C02 纯资料金标为空；C03 全指令金标全覆盖', () => {
  const c02 = corpusCase('C02')
  assert.equal(c02.goldSpans.length, 0)
  const c03 = corpusCase('C03')
  assert.deepEqual(c03.goldSpans, [[0, c03.text.length]])
})

test('buildText：D/I 拼接顺序与偏移推导一致（fixture 自检）', () => {
  const { text, goldSpans } = buildText([D('AB'), I('xxx'), D('CD')])
  assert.equal(text, 'ABxxxCD')
  assert.deepEqual(goldSpans, [[0, 2], [5, 7]])
})
