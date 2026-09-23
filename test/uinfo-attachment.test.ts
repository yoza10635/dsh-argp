/**
 * U-info 副本**附件保留**（1.7.0）专项。
 *
 * 存在理由（2026-09-23 核查）：宿主附件模型里，用户上传的文件/图片在会话流中是
 * **引用块**（`{type:'image'|'file', attachment:{attachmentId, name, bytes, ...}}`）——
 * 指向持久存储，文件内容不在消息里。两个机制事实：
 *  1. LLM 侧 `flattenWireText` 把 image/file 块渲染成 `[image omitted]`/`[file omitted]`
 *     占位 ⇒ peratom 的 LLM 提取 pass 对附件**零贡献**（只处理伴随文本）；
 *  2. 旧 `userCopyPayload` 产出**纯文本** `content:[{type:'text'}]` ⇒ peratom 压缩一条
 *     带附件的 user 消息时，U-info 替换会把附件块**从模型实时上下文静默丢掉**
 *     （原文留 append-only 日志可 recall，但 surface 上没了）。
 *
 * 修法（用户拍板选项 2）：U-info 副本 = 压缩文本 + **原样 image/file 块**。LLM 只压文本、
 * 不碰附件，附件原样留在副本里。宿主对 user/message 的 surface replace 无 content 级
 * 约束（worker.cjs `planSurfaceEvent` 只校验 range+provenance），带附件块的副本合法。
 *
 * 语料现状：18 个真实 session 251 条 user 消息 0 条带附件（纯前瞻，非已发生回归）⇒
 * 本测试全部用**合成** fixture（隐私安全），不依赖真实语料。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { userCopyPayload, attachmentBlocksOf, planReplacements } from '../src/peratom/compressor.ts'
import type { CompressDecision, CurrentTurnCollect } from '../src/peratom/compressor.ts'
import { ARG_NS } from '../src/peratom/types.ts'

// ---------------------------------------------------------------------------
// fixtures（合成附件块；attachmentId 为不透明存储标识，非真实路径）
// ---------------------------------------------------------------------------

// attachmentId 是宿主 branded 类型（`string & {readonly [BRAND]: 'AttachmentId'}`，BRAND 为
// 模块私有 unique symbol），无法用字面量直接构造；且 `@deepseek-ai/dsh-attachment` 是**传递**
// 依赖（未声明于 package.json），不宜直接 import 其类型 ⇒ 整块 `as unknown as ContentBlock`。
const IMG = {
  type: 'image',
  attachment: { attachmentId: 'img-1', mediaType: 'image/png', bytes: 100, width: 10, height: 10, name: 'a.png' },
} as unknown as ContentBlock
const IMG_OFFLOADED = {
  type: 'image',
  attachment: { attachmentId: 'img-2', mediaType: 'image/jpeg', bytes: 200, width: 20, height: 20 },
  offloaded: true,
} as unknown as ContentBlock
const FILE = {
  type: 'file',
  attachment: { attachmentId: 'file-1', name: 'b.txt', bytes: 50 },
} as unknown as ContentBlock

/** 合成 user/message 事件：text 块 + 可选附件块（data.message.content，V3/V4 同形）。 */
function makeUserEvent(seq: number, text: string, attachments: ContentBlock[] = []): never {
  return {
    type: 'user/message',
    seq,
    time: 0,
    surfaceOp: 'append',
    data: {
      message: {
        role: 'user',
        content: [{ type: 'text', text }, ...attachments],
        source: { kind: 'user' },
      },
    },
  } as never
}

/** 按 seq 索引的事件数组（`sessionEvents` 口径：index = seq）。 */
function eventsAt(seq: number, event: never): never[] {
  const arr = new Array<never>(seq + 1)
  arr[seq] = event
  return arr
}

// ---------------------------------------------------------------------------
// attachmentBlocksOf：从 user 事件提取 image/file 块
// ---------------------------------------------------------------------------

test('attachmentBlocksOf：提取 image + file 块（text 块排除）', () => {
  const event = makeUserEvent(5, 'hello', [IMG, FILE])
  const atts = attachmentBlocksOf(event, 5)
  assert.equal(atts.length, 2)
  assert.equal(atts[0].type, 'image')
  assert.equal(atts[1].type, 'file')
})

test('attachmentBlocksOf：保留 offloaded 标记（image-offload 决策不丢）', () => {
  const event = makeUserEvent(7, 'x', [IMG_OFFLOADED])
  const atts = attachmentBlocksOf(event, 7)
  assert.equal(atts.length, 1)
  assert.equal((atts[0] as { offloaded?: boolean }).offloaded, true)
})

test('attachmentBlocksOf：纯文本 / 无 content / 非 user 事件 / undefined → 空', () => {
  assert.deepEqual(attachmentBlocksOf(undefined), [])
  assert.deepEqual(attachmentBlocksOf(makeUserEvent(5, 'only text')), [])
  assert.deepEqual(attachmentBlocksOf({ type: 'user/message', seq: 5, data: {} } as never, 5), [])
  assert.deepEqual(attachmentBlocksOf({ type: 'assistant/message', seq: 5, data: { message: { content: [IMG] } } } as never, 5), [])
})

test('attachmentBlocksOf：seq 不匹配 → 空（防 events 索引假设错位的防御）', () => {
  const event = makeUserEvent(5, 'x', [IMG])
  assert.deepEqual(attachmentBlocksOf(event, 99), [])
})

// ---------------------------------------------------------------------------
// userCopyPayload：副本 = 压缩文本 + 原样附件块
// ---------------------------------------------------------------------------

test('userCopyPayload：带附件 ⇒ content = [text, ...attachments]，meta 挂 data[argp]', () => {
  const payload = userCopyPayload('compressed text', { sourceSeq: 5, summary: 'compressed text' }, [IMG, FILE]) as {
    content: ContentBlock[]
    [ARG_NS]?: { info: boolean; sourceSeq: number; summary: string }
  }
  assert.equal(payload.content.length, 3)
  assert.equal(payload.content[0].type, 'text')
  assert.equal((payload.content[0] as { text: string }).text, 'compressed text')
  assert.equal(payload.content[1].type, 'image')
  assert.equal(payload.content[2].type, 'file')
  assert.deepEqual(payload[ARG_NS], { info: true, sourceSeq: 5, summary: 'compressed text' })
})

test('userCopyPayload：无附件 ⇒ 纯文本 content（v1.6 行为逐字节不变，向后兼容）', () => {
  const payload = userCopyPayload('just text') as { content: ContentBlock[] }
  assert.equal(payload.content.length, 1)
  assert.equal(payload.content[0].type, 'text')
  assert.equal((payload.content[0] as { text: string }).text, 'just text')
})

test('userCopyPayload：空附件数组 ≡ 无附件（不产生多余块）', () => {
  const payload = userCopyPayload('t', { sourceSeq: 1, summary: 't' }, []) as { content: ContentBlock[] }
  assert.equal(payload.content.length, 1)
  assert.equal(payload.content[0].type, 'text')
})

// ---------------------------------------------------------------------------
// 集成：planReplacements 的 info-only 路径（空 quotes 触发）⇒ U-info 副本保留附件
// ---------------------------------------------------------------------------

test('planReplacements：info-only 路径的 U-info 副本保留原事件附件块', () => {
  const text = 'a long informational message that the model should keep as U-info'
  const collect: CurrentTurnCollect = {
    turn: 1,
    startSeq: 5,
    endSeq: 5,
    interrupted: false,
    userLong: [{ kind: 'user-long', seq: 5, turn: 1, text }],
    toolResults: [],
  }
  // 空 quotes ⇒ resolveSplit 返回 info-only ⇒ 整条 U-info 单事件 replace。
  const decision: CompressDecision = { splits: [{ seq: 5, quotes: [] }], tools: [] }
  const events = eventsAt(5, makeUserEvent(5, text, [IMG]))

  const plan = planReplacements(collect, decision, events)
  assert.equal(plan.steps.length, 1, 'info-only 产出单步 U-info replace')
  const step = plan.steps[0] as { type: string; data: { content: ContentBlock[]; [ARG_NS]?: { info: boolean; sourceSeq: number; summary: string } } }
  assert.equal(step.type, 'user/message')
  // 附件块原样保留在副本 content 里（text 块 + image 块）。
  assert.equal(step.data.content.length, 2)
  assert.equal(step.data.content[0].type, 'text')
  assert.equal(step.data.content[1].type, 'image')
  assert.equal((step.data.content[1] as { attachment?: { attachmentId?: string } }).attachment?.attachmentId, 'img-1')
  // U-info 元数据照挂（info 标记 + sourceSeq 召回目标 + summary）。
  assert.deepEqual(step.data[ARG_NS], { info: true, sourceSeq: 5, summary: text })
})

test('planReplacements：原事件无附件 ⇒ U-info 副本纯文本（无附件场景零回归）', () => {
  const text = 'a plain long message without any attachment'
  const collect: CurrentTurnCollect = {
    turn: 1,
    startSeq: 9,
    endSeq: 9,
    interrupted: false,
    userLong: [{ kind: 'user-long', seq: 9, turn: 1, text }],
    toolResults: [],
  }
  const decision: CompressDecision = { splits: [{ seq: 9, quotes: [] }], tools: [] }
  const events = eventsAt(9, makeUserEvent(9, text))

  const plan = planReplacements(collect, decision, events)
  assert.equal(plan.steps.length, 1)
  const step = plan.steps[0] as { data: { content: ContentBlock[] } }
  assert.equal(step.data.content.length, 1, '无附件 ⇒ 仅 text 块')
  assert.equal(step.data.content[0].type, 'text')
})
