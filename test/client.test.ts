/**
 * `./client` 发布级公开入口（src/client/index.ts）契约测试。
 *
 * 2.0.0 起客户端只剩一个职责：apply() 注册 assistantDisplay 显示过滤器，
 * 对 DisplayBlock 数组的末个 text 块做手术剥离尾随 cites JSON 块（裸 JSON /
 * ```json fence）。设置卡与其 controller/locale 字典随六枚旋钮一并退役。
 *
 * 覆盖：
 *  ① 过滤器行为（剥离、不拷贝、只动末块、畸形块不动、末块非 text）；
 *  ② assistantDisplay 缺失 → 静默降级不抛错；
 *  ③ 注册挂在 ctx.effect 上（标签即契约），dispose 后二次 apply 不叠加；
 *  ④ 无 effect 的退化 ctx：注册照旧发生。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../src/client/index.ts'

interface DisplayBlock {
  kind: string
  text?: unknown
  [key: string]: unknown
}

type DisplayFilter = (blocks: readonly DisplayBlock[], info: { readonly streaming: boolean }) => readonly DisplayBlock[]

interface AssistantDisplaySeam {
  register(filter: DisplayFilter): () => void
}

interface EffectHost {
  get<T>(name: string): T | undefined
  effect(execute: () => unknown, label?: string): unknown
  disposeEffects(): void
  effectLabels(): string[]
}

function makeCtx(services: Record<string, unknown>): EffectHost {
  const disposers: Array<() => void> = []
  const labels: string[] = []
  return {
    get: (name) => (name in services ? (services[name] as never) : undefined),
    effect: (execute, label) => {
      labels.push(label ?? 'anonymous')
      const disposer = execute()
      if (typeof disposer === 'function') disposers.push(disposer as () => void)
      return disposer
    },
    disposeEffects: () => {
      for (const disposer of disposers.splice(0).reverse()) disposer()
    },
    effectLabels: () => labels.slice(),
  }
}

function registeredFilter(): DisplayFilter {
  let registered: DisplayFilter | undefined
  const ctx = makeCtx({
    assistantDisplay: {
      register: (filter: DisplayFilter) => {
        registered = filter
        return () => {}
      },
    } satisfies AssistantDisplaySeam,
  })
  apply(ctx)
  assert.equal(typeof registered, 'function', 'apply() must register an assistantDisplay filter')
  return registered!
}

test('① apply() 注册 assistantDisplay 过滤器：剥离末块裸 JSON cites 尾', () => {
  const filter = registeredFilter()
  const first: DisplayBlock = { kind: 'text', text: 'body' }
  const last: DisplayBlock = { kind: 'text', text: 'answer\n{"cites":["alpha"]}' }
  const input = [first, last]
  const out = filter(input, { streaming: false })
  assert.notEqual(out, input, '剥离发生时返回新数组')
  assert.equal(out.length, 2)
  assert.equal(out[0], first, '非末块共享引用（只手术末块）')
  assert.notEqual(out[1], last, '末块被替换')
  assert.equal(out[1].text, 'answer')
})

test('① 过滤器：```json fence 尾同样剥离', () => {
  const filter = registeredFilter()
  const out = filter([{ kind: 'text', text: 'x\n```json\n{"cites":["a"]}\n```' }], { streaming: false })
  assert.equal(out[0].text, 'x')
})

test('① 过滤器：无 cites 块 → 返回原数组（不拷贝）', () => {
  const filter = registeredFilter()
  const input: DisplayBlock[] = [{ kind: 'text', text: 'no marker' }]
  assert.equal(filter(input, { streaming: false }), input)
})

test('① 过滤器：只手术末个 text 块——更早块的标记不剥', () => {
  const filter = registeredFilter()
  const input: DisplayBlock[] = [
    { kind: 'text', text: 'earlier {"cites":["x"]}' },
    { kind: 'text', text: 'later' },
  ]
  const out = filter(input, { streaming: false })
  assert.equal(out, input, '末块无标记 → 整体不变')
  assert.equal(out[0].text, 'earlier {"cites":["x"]}')
})

test('① 过滤器：畸形 cites 块 → 原文不变', () => {
  const filter = registeredFilter()
  const input: DisplayBlock[] = [{ kind: 'text', text: 'tail {"cites": [broken' }]
  const out = filter(input, { streaming: false })
  assert.equal(out, input)
  assert.equal(out[0].text, 'tail {"cites": [broken')
})

test('① 过滤器：末块非 text / 空数组 → 返回原数组', () => {
  const filter = registeredFilter()
  const noText: DisplayBlock[] = [{ kind: 'tool', text: 'whatever {"cites":["x"]}' }]
  assert.equal(filter(noText, { streaming: false }), noText)
  const empty: DisplayBlock[] = []
  assert.equal(filter(empty, { streaming: false }), empty)
})

test('② assistantDisplay 缺失 → apply() 不抛错', () => {
  assert.doesNotThrow(() => apply(makeCtx({})))
  assert.doesNotThrow(() => apply(makeCtx({ assistantDisplay: {} })))
})

test('③ 过滤器注册挂在 effect 上（标签即契约）', () => {
  const ctx = makeCtx({ assistantDisplay: { register: () => () => {} } satisfies AssistantDisplaySeam })
  apply(ctx)
  assert.deepEqual(ctx.effectLabels(), ['dsh-argp: cites display filter'])
})

test('③ re-apply：dispose 后二次 apply 不叠加，且旧 filter 已摘除', () => {
  const active = new Set<DisplayFilter>()
  const ctx = makeCtx({
    assistantDisplay: {
      register: (filter: DisplayFilter) => {
        active.add(filter)
        return () => { active.delete(filter) }
      },
    } satisfies AssistantDisplaySeam,
  })
  apply(ctx)
  assert.equal(active.size, 1, '首次 apply 只挂一个 filter')
  const first = [...active][0]!
  ctx.disposeEffects()
  assert.equal(active.size, 0, 'fiber 卸载后旧 filter 必须被摘除')
  apply(ctx)
  assert.equal(active.size, 1, '二次 apply 后仍只有一个 filter（不叠加）')
  assert.ok(!active.has(first), '活跃的是新 filter，不是泄漏的旧 filter')
})

test('④ 无 effect 的退化 ctx：注册照旧发生（无 fiber 可持有 disposer 时不抛）', () => {
  let called = 0
  const ctx = {
    get: <T,>() => ({ register: () => { called += 1; return () => {} } }) as unknown as T,
  }
  assert.doesNotThrow(() => apply(ctx))
  assert.equal(called, 1, '退化 ctx 也必须完成注册')
})
