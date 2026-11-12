/**
 * ARGP settings card: client-side staged form over the `dsh-argp` settings
 * namespace, plus the locale bundles the card renders.
 *
 * This is a self-contained port of the host `ui-settings-plugins` card model
 * (card-form.ts + bash-card-controller.ts). The host primitives
 * (`@deepseek-ai/dsh-client-store`, `@deepseek-ai/dsh-client-ui-settings`,
 * `@deepseek-ai/dsh-client-ui-slots`, the card CSS modules) are NOT installed
 * in this package, so we reimplement the small slice we need: a minimal
 * snapshot store, a structural settings-scope interface, and a `CardForm`
 * that stages edits and writes them on save. Only `react` is externalized at
 * bundle time (the web shell preloads it).
 *
 * The form publishes through a snapshot store because slot components read
 * through a snapshot selector, while both the scope and the local drafts
 * change underneath; every projection is rebuilt from the two together.
 */

/**
 * The 2.0 settings roster (design-2.0 §3.4): SIX knobs — three engine-agnostic
 * (windowRatio/retainRatio/charsPerToken) plus three factor-arm (focalTurns/vocabTopN/
 * recallLimit). The retired graph knobs (maxPasses/recencyGuard/
 * turnGuard/minSpanChars/sortMode) are gone from the card; the graph arm keeps
 * consuming them from cordis config (tolerated-read, see server normalizeConfig).
 * The `engine` discriminator is NOT here on purpose: it is non-volatile, and the
 * host's volatile form never carries non-volatile keys (settings/schema.ts
 * volatileForm — verified against the host checkout), so the card could neither
 * read nor write it. Profile/patch layers own that key.
 */
export interface ArgpUserSettings {
  /** Compaction window as a fraction of the context budget (both arms). */
  windowRatio: number
  /** Tokens retained after compaction, as a fraction of the window (both arms). */
  retainRatio: number
  /** Characters-per-token heuristic for budget math (both arms). */
  charsPerToken: number
  /** Focal turns kept verbatim — never pruned, never summarized (factor arm). */
  focalTurns: number
  /** Vocabulary note entries per category (factor arm). */
  vocabTopN: number
  /** Default items recall_history returns when no limit is given (factor arm). */
  recallLimit: number
}

/** Settings namespace this card owns (must equal the server-registered one). */
export const ARG_SETTINGS_KEY = 'dsh-argp'

// ── Locale ──────────────────────────────────────────────────────────────────

/** Locale keys the ARGP card renders (§3.4 roster: 2 core + 4 advanced rows). */
export type ArgpLocaleKey =
  | 'argpTitle' | 'argpDescription'
  | 'windowRatio' | 'windowRatioHint'
  | 'retainRatio' | 'retainRatioHint'
  | 'charsPerToken' | 'charsPerTokenHint'
  | 'focalTurns' | 'focalTurnsHint'
  | 'vocabTopN' | 'vocabTopNHint'
  | 'recallLimit' | 'recallLimitHint'
  | 'advanced'
  | 'overridden' | 'reset' | 'readOnly' | 'expand' | 'collapse'
  | 'save' | 'saving' | 'discard' | 'unsaved' | 'saveFailed' | 'invalidNumber'

/** English copy. */
export const en: Record<ArgpLocaleKey, string> = {
  argpTitle: 'ARGP context compaction',
  argpDescription: 'Automatically trims a long conversation to free up room. Changes apply live, no restart.',
  windowRatio: 'Prune trigger threshold',
  windowRatioHint: 'Ratio of the context limit',
  retainRatio: 'Compression rate',
  retainRatioHint: 'Ratio of the conversation window',
  charsPerToken: 'Chars per token',
  charsPerTokenHint: 'Character-to-token ratio used by the character-based estimates; the real usage anchor from the provider takes precedence',
  focalTurns: 'Focal turns',
  focalTurnsHint: 'The newest N turns stay verbatim — never pruned and never summarized (factor engine)',
  vocabTopN: 'Vocabulary entries per category',
  vocabTopNHint: 'How many labels each category shows in the vocabulary note; the rest stay reachable through list_labels (factor engine)',
  recallLimit: 'Recall default items',
  recallLimitHint: 'Items recall_history returns when it is called without a limit (cap 20; factor engine)',
  advanced: 'Advanced',
  overridden: 'Changed',
  reset: 'Reset to default',
  readOnly: 'This deployment stores settings read-only.',
  expand: 'Show settings',
  collapse: 'Hide settings',
  save: 'Save',
  saving: 'Saving…',
  discard: 'Discard',
  unsaved: 'Unsaved',
  saveFailed: 'These values were not accepted; they were left for you to correct.',
  invalidNumber: 'Enter a number, or leave blank to use the default.',
}

/** Simplified Chinese copy. */
export const zh: Record<ArgpLocaleKey, string> = {
  argpTitle: 'ARGP 上下文压缩',
  argpDescription: '对话太长时自动精简，腾出空间继续聊。改动立即生效，无需重启。',
  windowRatio: '剪枝触发阈值',
  windowRatioHint: '相较于上下文上限的比例',
  retainRatio: '压缩率',
  retainRatioHint: '相较于对话消息窗口的比例',
  charsPerToken: '字符/Token 比',
  charsPerTokenHint: '字符口径估算用的比值；真实估算以 provider usage 锚点为准',
  focalTurns: '焦点轮数',
  focalTurnsHint: '最近 N 轮保持逐字，不剪枝也不摘要（因子引擎）',
  vocabTopN: '词表每类条数',
  vocabTopNHint: '词表 note 每类最多列出的标签数，其余经 list_labels 下钻（因子引擎）',
  recallLimit: '召回默认条数',
  recallLimitHint: 'recall_history 未指定 limit 时的默认返回条数（上限 20；因子引擎）',
  advanced: '高级设置',
  overridden: '已修改',
  reset: '恢复默认',
  readOnly: '本部署的设置为只读。',
  expand: '展开设置',
  collapse: '收起设置',
  save: '保存',
  saving: '保存中…',
  discard: '放弃修改',
  unsaved: '未保存',
  saveFailed: '这些值没有被接受，已保留供你修改。',
  invalidNumber: '请填数字；留空表示使用默认值。',
}

// ── Snapshot store (port of @deepseek-ai/dsh-client-store) ──────────────────

/**
 * A minimal external-store shape compatible with React's useSyncExternalStore.
 * MUST match the host's `ObservableSnapshot` contract (`getSnapshot` + `subscribe`)
 * — the slot renderer's `observableHook` → `bindSnapshotSelector` calls
 * `source.getSnapshot()`, so a `get()` spelling here crashes the card at render.
 */
export interface SnapshotStore<S> {
  /** Read the current snapshot (uSES contract name). */
  getSnapshot(): S
  /** Replace the snapshot. */
  set(next: S): void
  /** Subscribe a listener; returns an unsubscribe function. */
  subscribe(listener: () => void): () => void
}

/** Create a snapshot store seeded with `initial`. */
export function createSnapshotStore<S>(initial: S): SnapshotStore<S> {
  let current = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => current,
    set: (next) => {
      current = next
      for (const listener of listeners) listener()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

// ── Settings scope (structural; the runtime object is from ctx.settingsScope.bind) ─

/** Snapshot a bound settings scope publishes. */
export interface SettingsScopeSnapshot {
  /** 'ready' when the namespace is served to this client. */
  status: 'ready' | 'loading' | 'unavailable'
  /** Whether the Host document accepts writes. */
  writable: boolean
  /** Effective values (user layer over composition layer over schema default). */
  value: Record<string, unknown>
  /** Composition-layer values. */
  base: Record<string, unknown>
  /** User-layer values, or undefined when the user has set nothing. */
  user: Record<string, unknown> | undefined
}

/** The bound settings scope a card's form reads and writes. */
export interface SettingsScopeLike<T> {
  /** Re-publish the form when the scope changes underneath. */
  subscribe(listener: () => void): void
  /** Current scope snapshot. */
  getSnapshot(): SettingsScopeSnapshot
  /** Write one field. */
  set(field: string, value: unknown): Promise<void>
  /** Clear one field (re-inherit the composition layer). */
  unset(field: string): Promise<void>
}

// ── Card form model (port of host card-form.ts) ─────────────────────────────

/** The write one field's staged text performs when the card is saved. */
type FieldWrite = { kind: 'set'; value: unknown } | { kind: 'clear' }

/** How one section field converts between its stored value and its draft text. */
export interface CardFieldSpec {
  /** Field name inside the namespace section. */
  field: string
  /** Render a stored value as draft text; the empty string when none. */
  format: (value: unknown) => string
  /** The write this draft text stages, or undefined when the text is invalid. */
  parse: (text: string) => FieldWrite | undefined
}

/** One field as a card's control renders it. */
export interface CardFieldState {
  /** Draft text the control renders. */
  text: string
  /** Whether saving would leave a user-layer entry for this field. */
  overridden: boolean
  /** Whether the draft is not a value this field accepts (blocks saving). */
  invalid: boolean
}

/** Form state every plugin card shares. */
export interface CardShell {
  /** False while the namespace is not served; the card renders nothing. */
  available: boolean
  /** Whether the Host document accepts writes. */
  writable: boolean
  /** Whether the form holds edits that a save would write. */
  dirty: boolean
  /** Whether any staged draft is invalid (blocks the save). */
  invalid: boolean
  /** Whether a save is crossing the wire. */
  saving: boolean
  /** Whether the last save did not land as staged. */
  failed: boolean
}

/** The write actions every plugin card injects. */
export interface CardActions {
  /** Stage draft text for one field. */
  edit: (field: string, text: string) => void
  /** Stage a clear so saving re-inherits the composition layer. */
  resetField: (field: string) => void
  /** Write every staged edit, then re-seed from what the Host accepted. */
  save: () => void
  /** Drop every staged edit. */
  discard: () => void
}

/** Range/integer constraints for a number field (mirrors the server-side schema bounds). */
export interface NumberFieldSpec {
  /** Inclusive lower bound. */
  min?: number
  /** Inclusive upper bound. */
  max?: number
  /** Require an integral value. */
  integer?: boolean
}

/**
 * A number field with optional range/integer constraints. Empty clears;
 * non-finite, out-of-range, or non-integer text is invalid (blocks the save,
 * never silently stored).
 */
export function numberField(field: string, spec?: NumberFieldSpec): CardFieldSpec {
  return {
    field,
    format: value => (typeof value === 'number' ? String(value) : ''),
    parse: (text) => {
      const trimmed = text.trim()
      if (trimmed === '') return { kind: 'clear' }
      const parsed = Number(trimmed)
      if (!Number.isFinite(parsed)) return undefined
      if (spec !== undefined) {
        if (spec.integer === true && !Number.isInteger(parsed)) return undefined
        if (spec.min !== undefined && parsed < spec.min) return undefined
        if (spec.max !== undefined && parsed > spec.max) return undefined
      }
      return { kind: 'set', value: parsed }
    },
  }
}

/** Constraints for a text field. */
export interface TextFieldSpec {
  /** Accepted values; any other value is invalid (blocks the save). */
  enum?: readonly string[]
}

/**
 * A text field with an optional enum constraint (generic card-form primitive;
 * the roster has no enum row since 2.0, tests keep the shape under lock).
 * Empty clears; a value outside the enum is invalid (never silently stored).
 */
export function textField(field: string, spec?: TextFieldSpec): CardFieldSpec {
  return {
    field,
    format: value => (typeof value === 'string' ? value : ''),
    parse: (text) => {
      const trimmed = text.trim()
      if (trimmed === '') return { kind: 'clear' }
      if (spec?.enum !== undefined && !spec.enum.includes(trimmed)) return undefined
      return { kind: 'set', value: trimmed }
    },
  }
}

interface StagedEdit {
  text: string
  /** True when this edit clears the field whatever text it shows. */
  clear: boolean
}

interface PlannedWrite {
  field: string
  run: (() => Promise<boolean>) | undefined
}

/** Stages one card's edits over one settings namespace and writes them on save. */
export class CardForm<T> {
  private readonly scope: SettingsScopeLike<T>
  private readonly specs: Map<string, CardFieldSpec>
  private readonly staged = new Map<string, StagedEdit>()
  private readonly listeners = new Set<() => void>()
  private saving = false
  private failed = false

  constructor(
    scope: SettingsScopeLike<T>,
    specs: CardFieldSpec[],
  ) {
    // Explicit field (not a parameter property): the client bundle is also
    // evaluated by Node's strip-only TS loader in tests, which rejects
    // parameter properties.
    this.scope = scope
    this.specs = new Map(specs.map(spec => [spec.field, spec]))
    scope.subscribe(() => { this.publish() })
  }

  /** Publish a projection rebuilt whenever the scope or a draft changes. */
  bind<S>(project: () => S): SnapshotStore<S> {
    const store = createSnapshotStore(project())
    this.listeners.add(() => { store.set(project()) })
    return store
  }

  /** Read the card-level state: what the Host serves, and what a save would do. */
  shell(): CardShell {
    const snapshot = this.scope.getSnapshot()
    const plan = this.plan()
    return {
      available: snapshot.status === 'ready',
      writable: snapshot.writable,
      dirty: plan.length > 0,
      invalid: plan.some(item => item.run === undefined),
      saving: this.saving,
      failed: this.failed,
    }
  }

  /** Read one control's state. */
  field(field: string): CardFieldState {
    const staged = this.staged.get(field)
    const spec = this.spec(field)
    if (staged === undefined) {
      return {
        text: spec.format(this.sectionValue(field)),
        overridden: this.stored(field),
        invalid: false,
      }
    }
    const write = staged.clear ? { kind: 'clear' as const } : spec.parse(staged.text)
    return {
      text: staged.text,
      overridden: write?.kind === 'set',
      invalid: write === undefined,
    }
  }

  /** Build the edit/reset/save/discard actions bound to this form. */
  actions(): CardActions {
    return {
      edit: (field, text) => { this.stage(field, { text, clear: false }) },
      resetField: (field) => {
        this.stage(field, { text: this.spec(field).format(this.baseValue(field)), clear: true })
      },
      save: () => { void this.save() },
      discard: () => {
        if (this.staged.size === 0 && !this.failed) return
        this.staged.clear()
        this.failed = false
        this.publish()
      },
    }
  }

  /** Write every staged edit, then re-seed from what the Host accepted. */
  private async save(): Promise<void> {
    const plan = this.plan()
    const writes = plan.flatMap(item => (item.run === undefined ? [] : [item.run]))
    if (plan.length === 0 || this.saving || writes.length !== plan.length) return
    this.saving = true
    this.failed = false
    this.publish()
    let landed = true
    try {
      for (const write of writes) landed = (await write()) && landed
    } catch (error) {
      // A host `set`/`unset` rejection (network, permission, validation) must not
      // wedge the card on "Saving…" or leak an unhandled rejection: swallow it,
      // mark the save failed, and let the finally block re-publish the shell.
      landed = false
      console.warn('[dsh-argp] settings save failed:', error)
    } finally {
      if (landed) this.staged.clear()
      this.saving = false
      this.failed = !landed
      this.publish()
    }
  }

  /** Every staged edit a save would write. */
  private plan(): PlannedWrite[] {
    const plan: PlannedWrite[] = []
    for (const [field, staged] of this.staged) {
      const spec = this.spec(field)
      if (staged.clear) {
        if (this.stored(field)) plan.push({ field, run: () => this.clear(field) })
        continue
      }
      if (staged.text === spec.format(this.sectionValue(field))) continue
      const write = spec.parse(staged.text)
      if (write === undefined) plan.push({ field, run: undefined })
      else if (write.kind === 'clear') plan.push({ field, run: () => this.clear(field) })
      else plan.push({ field, run: () => this.store(field, write.value) })
    }
    return plan
  }

  private async clear(field: string): Promise<boolean> {
    await this.scope.unset(field)
    return this.settle(() => !this.stored(field))
  }

  private async store(field: string, value: unknown): Promise<boolean> {
    await this.scope.set(field, value)
    return this.settle(() => this.userLayer()?.[field] === value)
  }

  /**
   * 批次 3-2（beta.1）：`set`/`unset` 的 Promise 只保证写入落盘，**不保证**快照已随之
   * 刷新（宿主快照经事件总线异步重发布）。旧实现写后立即读快照校验，读到陈旧 user 层
   * ⇒ 每次保存/恢复默认都被误判失败（"restore-default 恒失败"）。改为等待快照收敛：
   * 60ms 轮询（订阅监听会重发布表单，轮询只读快照），1.5s 超时按当时快照判——真实
   * 被宿主拒绝的写入仍会如期显示失败。
   */
  private settle(pred: () => boolean, timeoutMs = 1500): Promise<boolean> {
    return new Promise<boolean>(resolve => {
      const start = Date.now()
      const check = (): void => {
        if (pred()) { resolve(true); return }
        if (Date.now() - start >= timeoutMs) { resolve(false); return }
        setTimeout(check, 60)
      }
      check()
    })
  }

  private stage(field: string, edit: StagedEdit): void {
    this.staged.set(field, edit)
    this.failed = false
    this.publish()
  }

  private spec(field: string): CardFieldSpec {
    const spec = this.specs.get(field)
    if (spec === undefined) throw new Error(`ARGP config card has no field ${field}`)
    return spec
  }

  private sectionValue(field: string): unknown {
    return (this.scope.getSnapshot().value as Record<string, unknown> | undefined)?.[field]
  }

  private baseValue(field: string): unknown {
    return (this.scope.getSnapshot().base as Record<string, unknown> | undefined)?.[field]
  }

  private userLayer(): Record<string, unknown> | undefined {
    return this.scope.getSnapshot().user as Record<string, unknown> | undefined
  }

  private stored(field: string): boolean {
    const user = this.userLayer()
    return user !== undefined && Object.hasOwn(user, field)
  }

  private publish(): void {
    for (const listener of this.listeners) listener()
  }
}

// ── ARGP card controller ─────────────────────────────────────────────────────

/** The card's full render state (§3.4 roster: six fields, one per rendered row). */
export interface ArgpConfigState extends CardShell {
  windowRatio: CardFieldState
  retainRatio: CardFieldState
  charsPerToken: CardFieldState
  focalTurns: CardFieldState
  vocabTopN: CardFieldState
  recallLimit: CardFieldState
}

/** The registration-side face the slot entry injects. */
export interface ArgpConfigFace extends CardActions {
  hooks: { argpConfig: SnapshotStore<ArgpConfigState> }
}

/** Bridges the `dsh-argp` scope onto the ARGP card's staged form. */
export class ArgpConfigController {
  private readonly form: CardForm<ArgpUserSettings>
  private readonly store: SnapshotStore<ArgpConfigState>

  /** @param scope - the bound settings scope for the `dsh-argp` namespace. */
  constructor(scope: SettingsScopeLike<ArgpUserSettings>) {
    // Bounds mirror `ArgpGraphEngine.Config` (the host-validated source; the client
    // must reject out-of-spec drafts before they are staged, since a rejected host
    // write would surface as an opaque save failure). The six fields stay 1:1
    // with the card's rendered rows (knob parity, §3.4 roster).
    this.form = new CardForm(scope, [
      numberField('windowRatio', { min: 0.1, max: 1 }),
      numberField('retainRatio', { min: 0.05, max: 1 }),
      numberField('charsPerToken', { min: 0.5, max: 8 }),
      numberField('focalTurns', { min: 0, integer: true }),
      numberField('vocabTopN', { min: 1, integer: true }),
      numberField('recallLimit', { min: 1, integer: true }),
    ])
    this.store = this.form.bind(() => this.projection())
  }

  private projection(): ArgpConfigState {
    return {
      ...this.form.shell(),
      windowRatio: this.form.field('windowRatio'),
      retainRatio: this.form.field('retainRatio'),
      charsPerToken: this.form.field('charsPerToken'),
      focalTurns: this.form.field('focalTurns'),
      vocabTopN: this.form.field('vocabTopN'),
      recallLimit: this.form.field('recallLimit'),
    }
  }

  /** Build the face the card's slot registration injects. */
  inject(): ArgpConfigFace {
    return { hooks: { argpConfig: this.store }, ...this.form.actions() }
  }
}
