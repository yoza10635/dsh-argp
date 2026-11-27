/**
 * `./client` 发布级公开入口（src/client/index.ts）契约测试（P3.2）+ 配置值校验（P4.6）：
 *
 *  ① 1.x 引用协议尾块剥离子系统已于 2.2.2 整体删除，assistantDisplay 显示过滤器随其
 *     退位（曾是纯直通注册），现不再注册；服务缺失时的静默降级仍由 ② 锁住；
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
const { ARG_SETTINGS_KEY: serverKey } = await import('../src/argp-engine.ts')

// ── 结构化 ctx stub（镜像 src/client/index.ts 的结构化接口）────────────────

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
// ① assistantDisplay 过滤器：2.2.2 起纯直通（原剥离用例组已随子系统删除；
//    注册由 effect 持有、re-apply 不叠加的契约见 ④）
// ---------------------------------------------------------------------------

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
  const compactionThreshold = numberField('compactionThreshold', { min: 0, max: 1 })
  assert.deepEqual(compactionThreshold.parse('0.5'), { kind: 'set', value: 0.5 })
  assert.deepEqual(compactionThreshold.parse('1'), { kind: 'set', value: 1 })
  assert.deepEqual(compactionThreshold.parse('0'), { kind: 'set', value: 0 }, '0 = 关（撞墙兜底），合法值')
  assert.equal(compactionThreshold.parse('1.5'), undefined, '高于 max 1')
  assert.equal(compactionThreshold.parse('-0.1'), undefined, '低于 min 0')
  assert.equal(compactionThreshold.parse('abc'), undefined, '非数字')
  assert.deepEqual(compactionThreshold.parse(''), { kind: 'clear' }, '留空 = 关')

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
  const { scope, snapshot } = makeScope({ compactionThreshold: 0 })
  const form = new CardForm(scope, [numberField('compactionThreshold', { min: 0, max: 1 })])

  form.actions().edit('compactionThreshold', '1.5')
  assert.equal(form.field('compactionThreshold').invalid, true, '越界草稿 invalid')
  assert.equal(form.shell().invalid, true, 'invalid 草稿阻断保存')
  form.actions().save()
  await tick()
  assert.equal(snapshot().user, undefined, '越界值不得写入 user 层')
  assert.equal(snapshot().value.compactionThreshold, 0, '有效值不变')

  // 范围内值通过并落盘
  form.actions().edit('compactionThreshold', '0.5')
  assert.equal(form.field('compactionThreshold').invalid, false)
  form.actions().save()
  await tick()
  assert.equal(snapshot().user?.compactionThreshold, 0.5, '范围内值写入 user 层')
  assert.equal(snapshot().value.compactionThreshold, 0.5)
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

test('④ apply 的注册挂在 effect 上（标签即契约）', () => {
  const locale = makeLocaleService()
  const ctx = makeCtx({ locale: locale.service, assistantDisplay: { register: () => () => {} } })
  apply(ctx)
  assert.deepEqual(
    ctx.effectLabels(),
    ['dsh-argp: settings card dictionaries'],
    '注册必须由 ctx.effect 持有 disposer（否则 re-apply 泄漏/叠加）；2.2.2 起 assistantDisplay 直通过滤器已随 1.x 引用协议子系统删除，故仅剩这一处',
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

test('④ 无 effect 的退化 ctx：注册照旧发生（无 fiber 可持有 disposer 时不抛）', () => {
  const locale = makeLocaleService()
  const bare = { get: (name: string) => (name === 'locale' ? (locale.service as never) : undefined) }
  assert.doesNotThrow(() => apply(bare))
  assert.deepEqual(locale.locales(clientKey), ['en', 'zh'], '退化路径仍完成注册')
})

// ── 批次 3-2 CardForm：宿主快照异步刷新（写落盘 ≠ 快照已更新）不得误判保存失败 ──

test('批次 3-2: set/unset 落盘后快照迟刷新（20ms）——保存/恢复默认仍判成功', async () => {
  // 真实宿主形态：内部 state 即时变、**快照不可变**——getSnapshot 在重发布前一直返回
  // 旧快照（写入 Promise resolve ≠ 快照已刷新；只延迟订阅通知测不出这条路径）
  const state: SettingsScopeSnapshot = {
    status: 'ready', writable: true,
    value: { windowRatio: 0.8 }, base: { windowRatio: 0.8 }, user: undefined,
  }
  let published: SettingsScopeSnapshot = {
    status: state.status, writable: state.writable,
    value: { ...state.value }, base: { ...state.base }, user: undefined,
  }
  const listeners = new Set<() => void>()
  const republish = (): void => {
    published = {
      status: state.status, writable: state.writable,
      value: { ...state.value }, base: { ...state.base },
      user: state.user === undefined ? undefined : { ...state.user },
    }
    for (const l of listeners) l()
  }
  const lateNotify = (): void => { setTimeout(republish, 20) }
  const scope: SettingsScopeLike<Record<string, unknown>> = {
    subscribe: (l) => { listeners.add(l); return () => { listeners.delete(l) } },
    getSnapshot: () => published,
    set: async (field, val) => {
      state.value[field] = val
      state.user = { ...(state.user ?? {}), [field]: val }
      lateNotify()
    },
    unset: async (field) => {
      delete state.value[field]
      if (state.user !== undefined) delete state.user[field]
      lateNotify()
    },
  }
  const form = new CardForm(scope, [numberField('windowRatio', { min: 0.1, max: 1 })])

  // 编辑保存：写后快照 20ms 才见 —— 不得误判 failed
  form.actions().edit('windowRatio', '0.5')
  form.actions().save()
  await new Promise(r => setTimeout(r, 120))
  assert.equal(form.shell().failed, false, '迟刷新快照不得把成功保存误判为失败')
  assert.equal(form.shell().dirty, false, '成功保存清空暂存')
  assert.equal(state.user?.windowRatio, 0.5)

  // 恢复默认（clear 路径）同判据
  form.actions().resetField('windowRatio')
  form.actions().save()
  await new Promise(r => setTimeout(r, 120))
  assert.equal(form.shell().failed, false, 'restore-default 不得被迟刷新误判恒失败')
  assert.equal(state.user?.windowRatio, undefined, '恢复默认后 user 层清除')
})
