/**
 * `./client` 发布级公开入口（src/client/index.ts）契约测试（P3.2）+ 配置值校验（P4.6）：
 *
 *  ① apply() 注册 assistantDisplay 显示过滤器，且过滤器对 DisplayBlock 数组的
 *     末个 text 块做手术剥离尾随 cites JSON 块（裸 JSON / ```json fence）；
 *     无块 / 无变化 → 返回原数组（不产生多余拷贝）；只动末块，其余块共享引用。
 *  ② assistantDisplay 服务缺失（或无 register）时静默降级不抛错；
 *     locale 服务存在时以 dsh-argp 命名空间注册卡片文案。
 *  ③ 跨端契约：client 的 ARG_SETTINGS_KEY === server 端 settings.register 的
 *     namespace 键（两者不一致则设置卡片永远进不了渲染交集——跨端 bug）。
 *  ④ re-apply 安全：两处注册都由 ctx.effect 持有 disposer；宿主 retract
 *     （disable→enable / HMR / 版本变更 = dispose fiber + 重新 apply）后二次
 *     apply 不得抛 `locale namespace "dsh-argp" already has locale "zh"`。
 *     locale stub 忠实复刻宿主"重复注册即抛"语义，并配负控证明修复依赖回收
 *     而非 stub 宽容。
 *
 *  P4.6：numberField/textField 的 parse 范围/整数/枚举校验——越界/非整数/非法
 *     枚举值 → parse 返回 undefined（CardFieldState.invalid，阻断保存），
 *     不静默落盘；CardForm 级验证越界草稿不写入 settings scope。
 *
 *  环境说明：client bundle 的卡片（argp-config-card.ts）静态 import `react`
 *  （构建期 externalize，由 web shell 提供；本包 node_modules 未安装 react）。
 *  测试不渲染卡片，只需模块可求值，故在动态 import src/client/index.ts 之前
 *  用 module.registerHooks 把 `react` 重定向到一个最小 stub。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import {
  ARG_SETTINGS_KEY as clientKey,
  CardForm,
  numberField,
  textField,
  type SettingsScopeLike,
  type SettingsScopeSnapshot,
} from '../src/client/argp-config-controller.ts'

// ── react stub（必须在 import src/client/index.ts 之前注册）────────────────
// 卡片模块顶层只做 `const h = React.createElement`；useState/useEffect/useRef
// 仅在被渲染时调用（测试不渲染）。stub 只需让模块求值不抛。
const REACT_STUB_URL = 'dsh-argp-test:react-stub'
const REACT_STUB_SOURCE = [
  'const React = {',
  '  createElement: () => null,',
  '  useState: (v) => [v, () => {}],',
  '  useEffect: () => {},',
  '  useRef: (v) => ({ current: v }),',
  '};',
  'export default React;',
].join('\n')

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'react' || specifier === 'react/jsx-runtime') {
      return { url: REACT_STUB_URL, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url === REACT_STUB_URL) {
      return { format: 'module', source: REACT_STUB_SOURCE, shortCircuit: true }
    }
    return nextLoad(url, context)
  },
})

// 动态 import：ESM 静态导入会被提升、先于 registerHooks 执行，
// 而 index.ts 的模块图（经 argp-config-card.ts）会 import react。
const { apply } = await import('../src/client/index.ts')
const { ARG_SETTINGS_KEY: serverKey } = await import('../src/argp-graph-engine.ts')

// ── 结构化 ctx stub（镜像 src/client/index.ts 的结构化接口）────────────────

/** 聊天渲染的 assistant 块（结构化形状）。 */
interface DisplayBlock {
  readonly kind: string
  readonly text?: unknown
  readonly [key: string]: unknown
}

/** assistantDisplay 显示过滤器。 */
type DisplayFilter = (
  blocks: readonly DisplayBlock[],
  info: { readonly streaming: boolean },
) => readonly DisplayBlock[]

/** assistantDisplay 服务面。 */
interface AssistantDisplaySeam {
  register(filter: DisplayFilter): () => void
}

/** locale 服务面（register 返回移除本次登记的 disposer）。 */
interface LocaleService {
  register(namespace: string, dictionary: { readonly zh: Record<string, string>; readonly en: Record<string, string> }): () => void
}

/**
 * 最小 client ctx：`get` + `effect`。无 inject → 设置卡片注册路径提前退出
 * （即降级路径），但 effect 通道完整，可模拟宿主 retract（dispose fiber）。
 */
interface EffectHost {
  get<T>(name: string): T | undefined
  effect(execute: () => unknown, label?: string): unknown
  /** 模拟 fiber 卸载：按逆序运行已收集的 effect disposer（同 cordis）。 */
  disposeEffects(): void
  /** 本次 apply 注册的 effect 标签（诊断/契约断言用）。 */
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

/**
 * dsh-client-locale 的最小忠实镜像：同 namespace + 同 locale 二次注册**抛错**
 * （宿主 lib/client.js:1393
 * `locale namespace "${ns}" already has locale "${locale}"`），
 * `register` 返回移除本次登记的 disposer。修复前 apply() 泄漏字典 ⇒ 宿主
 * retract 后重新 apply 必抛，正是「插件未能完成同步」的报错。
 */
function makeLocaleService(): {
  service: LocaleService
  locales: (namespace: string) => string[]
  namespaces: () => string[]
} {
  const dicts = new Map<string, Set<string>>()
  const service: LocaleService = {
    register: (namespace, dictionary) => {
      let locales = dicts.get(namespace)
      if (locales === undefined) {
        locales = new Set<string>()
        dicts.set(namespace, locales)
      }
      const added = Object.keys(dictionary)
      for (const locale of added) {
        if (locales.has(locale)) {
          throw new Error(`locale namespace "${namespace}" already has locale "${locale}"`)
        }
      }
      for (const locale of added) locales.add(locale)
      return () => {
        for (const locale of added) locales.delete(locale)
      }
    },
  }
  return {
    service,
    locales: (namespace) => [...(dicts.get(namespace) ?? [])].sort(),
    namespaces: () => [...dicts.keys()],
  }
}

// ---------------------------------------------------------------------------
// ① apply() 注册 assistantDisplay 过滤器：剥离尾随 cites 块
// ---------------------------------------------------------------------------

function registeredFilter(): DisplayFilter {
  let registered: DisplayFilter | undefined
  let unregister: (() => void) | undefined
  const ctx = makeCtx({
    assistantDisplay: {
      register: (filter: DisplayFilter) => {
        registered = filter
        unregister = () => {}
        return unregister
      },
    } satisfies AssistantDisplaySeam,
  })
  apply(ctx)
  assert.equal(typeof registered, 'function', 'apply() must register an assistantDisplay filter')
  assert.equal(typeof unregister, 'function', 'register must return an unregister function')
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

// ---------------------------------------------------------------------------
// ② assistantDisplay 缺失 → 静默降级
// ---------------------------------------------------------------------------

test('② assistantDisplay 缺失 → apply() 不抛错', () => {
  // 完全空 ctx：无 assistantDisplay、无 locale、无 inject
  assert.doesNotThrow(() => apply(makeCtx({})))
  // assistantDisplay 存在但无 register 方法 → 同样跳过
  assert.doesNotThrow(() => apply(makeCtx({ assistantDisplay: {} })))
})

test('② locale 服务存在 → 以 dsh-argp 命名空间注册卡片文案，不抛错', () => {
  const seen: string[] = []
  const locale: LocaleService = {
    register: (ns) => { seen.push(ns); return () => {} },
  }
  assert.doesNotThrow(() => apply(makeCtx({ locale })))
  assert.deepEqual(seen, [clientKey], 'locale.register 以 dsh-argp 命名空间调用')
})

// ---------------------------------------------------------------------------
// ③ 跨端契约：client 键 === server 键
// ---------------------------------------------------------------------------

test('③ 跨端契约：client ARG_SETTINGS_KEY === server settings.register 命名空间键', () => {
  assert.equal(clientKey, 'dsh-argp', 'client 键固定为 dsh-argp')
  assert.equal(serverKey, clientKey, 'client 与 server 命名空间键必须一致，否则设置卡片进不了渲染交集')
})

// ---------------------------------------------------------------------------
// P4.6：numberField / textField parse 范围/整数/枚举校验
// ---------------------------------------------------------------------------

test('P4.6 numberField：越界/非整数 → parse undefined（invalid，阻断保存）', () => {
  const windowRatio = numberField('windowRatio', { min: 0.1, max: 1 })
  assert.deepEqual(windowRatio.parse('0.5'), { kind: 'set', value: 0.5 })
  assert.deepEqual(windowRatio.parse('1'), { kind: 'set', value: 1 })
  assert.equal(windowRatio.parse('0.05'), undefined, '低于 min 0.1')
  assert.equal(windowRatio.parse('1.5'), undefined, '高于 max 1')
  assert.equal(windowRatio.parse('abc'), undefined, '非数字')
  assert.deepEqual(windowRatio.parse(''), { kind: 'clear' })

  const maxPasses = numberField('maxPasses', { min: 1, integer: true })
  assert.deepEqual(maxPasses.parse('16'), { kind: 'set', value: 16 })
  assert.equal(maxPasses.parse('1.5'), undefined, '非整数')
  assert.equal(maxPasses.parse('0'), undefined, '低于 min 1')
  assert.equal(maxPasses.parse('-1'), undefined, '负数')

  const recencyGuard = numberField('recencyGuard', { min: 0, integer: true })
  assert.deepEqual(recencyGuard.parse('0'), { kind: 'set', value: 0 })
  assert.equal(recencyGuard.parse('0.5'), undefined, '非整数')

  const charsPerToken = numberField('charsPerToken', { min: 0.5, max: 8 })
  assert.deepEqual(charsPerToken.parse('3.5'), { kind: 'set', value: 3.5 })
  assert.equal(charsPerToken.parse('0.4'), undefined, '低于 min 0.5')
  assert.equal(charsPerToken.parse('8.1'), undefined, '高于 max 8')
})

test('P4.6 textField：sortMode 枚举约束——非法值不通过', () => {
  const sortMode = textField('sortMode', { enum: ['legacy', 'density', 'density-chain'] })
  for (const ok of ['legacy', 'density', 'density-chain']) {
    assert.deepEqual(sortMode.parse(ok), { kind: 'set', value: ok })
  }
  assert.equal(sortMode.parse('banana'), undefined, '不在枚举内')
  assert.equal(sortMode.parse('DENSITY'), undefined, '大小写敏感')
  assert.deepEqual(sortMode.parse(''), { kind: 'clear' })
})

// ── P4.6 CardForm 级：越界草稿阻断保存、不写入 scope ───────────────────────

/** 最小 settings scope stub：set/unset 更新 value+user 层并通知订阅者。 */
function makeScope(value: Record<string, unknown>): {
  scope: SettingsScopeLike<Record<string, unknown>>
  snapshot: () => SettingsScopeSnapshot
} {
  const state: SettingsScopeSnapshot = {
    status: 'ready',
    writable: true,
    value: { ...value },
    base: { ...value },
    user: undefined,
  }
  const listeners = new Set<() => void>()
  const notify = (): void => { for (const l of listeners) l() }
  const scope: SettingsScopeLike<Record<string, unknown>> = {
    subscribe: (l) => { listeners.add(l); return () => { listeners.delete(l) } },
    getSnapshot: () => state,
    set: async (field, val) => {
      state.value[field] = val
      state.user = { ...(state.user ?? {}), [field]: val }
      notify()
    },
    unset: async (field) => {
      delete state.value[field]
      if (state.user !== undefined) delete state.user[field]
      notify()
    },
  }
  return { scope, snapshot: () => state }
}

const tick = (): Promise<void> => new Promise(r => setTimeout(r, 0))

test('P4.6 CardForm：越界草稿 → invalid 阻断保存，不静默落盘', async () => {
  const { scope, snapshot } = makeScope({ windowRatio: 0.8 })
  const form = new CardForm(scope, [numberField('windowRatio', { min: 0.1, max: 1 })])

  form.actions().edit('windowRatio', '1.5')
  assert.equal(form.field('windowRatio').invalid, true, '越界草稿 invalid')
  assert.equal(form.shell().invalid, true, 'invalid 草稿阻断保存')
  form.actions().save()
  await tick()
  assert.equal(snapshot().user, undefined, '越界值不得写入 user 层')
  assert.equal(snapshot().value.windowRatio, 0.8, '有效值不变')

  // 范围内值通过并落盘
  form.actions().edit('windowRatio', '0.5')
  assert.equal(form.field('windowRatio').invalid, false)
  form.actions().save()
  await tick()
  assert.equal(snapshot().user?.windowRatio, 0.5, '范围内值写入 user 层')
  assert.equal(snapshot().value.windowRatio, 0.5)
})

test('P4.6 CardForm：sortMode 非法枚举草稿 → invalid 阻断保存', async () => {
  const { scope, snapshot } = makeScope({ sortMode: 'density' })
  const form = new CardForm(scope, [textField('sortMode', { enum: ['legacy', 'density', 'density-chain'] })])

  form.actions().edit('sortMode', 'banana')
  assert.equal(form.field('sortMode').invalid, true)
  form.actions().save()
  await tick()
  assert.equal(snapshot().user, undefined, '非法枚举值不得写入 user 层')
  assert.equal(snapshot().value.sortMode, 'density')

  form.actions().edit('sortMode', 'legacy')
  assert.equal(form.field('sortMode').invalid, false)
  form.actions().save()
  await tick()
  assert.equal(snapshot().user?.sortMode, 'legacy')
})

// ---------------------------------------------------------------------------
// ④ re-apply 安全：宿主 retract（dispose fiber）后重新 apply 必须合法
//
// 宿主把插件 disable→enable、HMR 重载、或客户端版本变更都实现为
// 「dispose 旧 fiber → 重新 apply client half」（dsh-cordis-client-runner
// lib/client.js:637 `fiber?.dispose()`）。locale 服务对同 namespace+locale
// 的二次注册抛错（dsh-client-locale lib/client.js:1393），所以 apply() 的注册
// 必须挂 ctx.effect 由 fiber 持有 disposer；否则第二次 apply 抛
// `locale namespace "dsh-argp" already has locale "zh"`，宿主以
// 「插件未能完成同步；服务端的启用状态保持不变」报回。
// ---------------------------------------------------------------------------

test('④ apply 的两处注册都挂在 effect 上（标签即契约）', () => {
  const locale = makeLocaleService()
  const ctx = makeCtx({ locale: locale.service, assistantDisplay: { register: () => () => {} } })
  apply(ctx)
  assert.deepEqual(
    ctx.effectLabels(),
    ['dsh-argp: cites display filter', 'dsh-argp: settings card dictionaries'],
    '两处注册都必须由 ctx.effect 持有 disposer（否则 re-apply 泄漏/叠加）',
  )
})

test('④ re-apply：effect disposal 后二次 apply 不抛，字典被正确摘除', () => {
  const locale = makeLocaleService()
  const ctx = makeCtx({ locale: locale.service })

  apply(ctx)
  assert.deepEqual(locale.locales(clientKey), ['en', 'zh'], '首次 apply 登记 zh+en')

  // 宿主 retract：dispose fiber → effect disposer 摘除本次登记的字典
  ctx.disposeEffects()
  assert.deepEqual(locale.locales(clientKey), [], 'disposer 必须摘除本次登记的字典')

  // 重新激活同一 client half（enable 状态同步 / HMR / 版本变更路径）
  assert.doesNotThrow(() => apply(ctx), '二次 apply 必须合法（这正是被报告的失败点）')
  assert.deepEqual(locale.locales(clientKey), ['en', 'zh'], '二次 apply 后字典回到 zh+en')
})

test('④ 负控：未 dispose 就二次 apply → 忠实镜像的宿主 locale 必抛', () => {
  const locale = makeLocaleService()
  const ctx = makeCtx({ locale: locale.service })
  apply(ctx)
  // 证明：① stub 忠实复刻宿主语义；② 修复确实依赖 effect 回收，而非 stub 宽容。
  assert.throws(
    () => apply(ctx),
    /locale namespace "dsh-argp" already has locale "zh"/,
    '未回收就重注册必须抛 —— 与宿主 dsh-client-locale 行为一致',
  )
})

test('④ re-apply：assistantDisplay 过滤器不叠加（dispose 后仍只有一个）', () => {
  let active = 0
  const ctx = makeCtx({
    assistantDisplay: {
      register: () => { active += 1; return () => { active -= 1 } },
    },
  })
  apply(ctx)
  assert.equal(active, 1, '首次 apply 注册一个过滤器')
  ctx.disposeEffects()
  assert.equal(active, 0, 'disposer 必须解除注册')
  apply(ctx)
  assert.equal(active, 1, '二次 apply 不得叠加第二个过滤器')
})

test('④ 无 effect 的退化 ctx：注册照旧发生（无 fiber 可持有 disposer 时不抛）', () => {
  const locale = makeLocaleService()
  const bare = { get: (name: string) => (name === 'locale' ? (locale.service as never) : undefined) }
  assert.doesNotThrow(() => apply(bare))
  assert.deepEqual(locale.locales(clientKey), ['en', 'zh'], '退化路径仍完成注册')
})
