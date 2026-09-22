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
 * The engine knobs the `dsh-argp` namespace holds (mirrors the server schema).
 * The card surfaces six of them — two core (windowRatio/retainRatio) plus four
 * advanced (maxPasses/recencyGuard/turnGuard/sortMode); the remaining three
 * (minSpanChars/enableSummarize/charsPerToken) are schema-only escape hatches
 * not exposed in the UI.
 */
export interface ArgpUserSettings {
  /** Compaction window as a fraction of the context budget. */
  windowRatio: number
  /** Tokens retained after compaction, as a fraction of the window. */
  retainRatio: number
  /** Max graph-pruning passes per compaction. */
  maxPasses: number
  /** Recency guard: newest N turns never pruned. */
  recencyGuard: number
  /** Turn guard: keep at least this many turns. */
  turnGuard: number
  /** Minimum span length (chars) worth keeping. */
  minSpanChars: number
  /** Enable extractive summarization of pruned spans. */
  enableSummarize: boolean
  /** Eviction ordering strategy. */
  sortMode: 'legacy' | 'density' | 'density-chain'
  /** Characters-per-token heuristic for budget math. */
  charsPerToken: number
}

/** Settings namespace this card owns (must equal the server-registered one). */
export const ARG_SETTINGS_KEY = 'dsh-argp'

// ── Locale ──────────────────────────────────────────────────────────────────

/** Locale keys the ARGP card renders. */
export type ArgpLocaleKey =
  | 'argpTitle' | 'argpDescription'
  | 'windowRatio' | 'windowRatioHint'
  | 'retainRatio' | 'retainRatioHint'
  | 'maxPasses' | 'maxPassesHint'
  | 'recencyGuard' | 'recencyGuardHint'
  | 'turnGuard' | 'turnGuardHint'
  | 'sortMode' | 'sortModeHint'
  | 'sortModeDensity' | 'sortModeLegacy' | 'sortModeChain'
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
  maxPasses: 'Prune pass limit',
  maxPassesHint: 'Safety cap on the prune loop; it normally stops at the compression target, when nothing is left to prune, or on a no-progress pass — this only bounds extreme spin',
  recencyGuard: 'Recent protection (messages)',
  recencyGuardHint: 'Newest N messages are never pruned',
  turnGuard: 'Recent protection (turns)',
  turnGuardHint: 'Last N turns are never pruned',
  sortMode: 'Prune priority',
  sortModeHint: 'Density = drop big, low-info spans first (recommended); +chain = repeated versions pruned sooner; In order = legacy',
  sortModeDensity: 'By information density (recommended)',
  sortModeLegacy: 'In order of appearance',
  sortModeChain: 'Density + version chaining',
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
  maxPasses: '剪枝轮数上限',
  maxPassesHint: '剪枝循环的安全上限；正常到压缩率达标、无可剪或一轮无进展就停，此值只防极端空转',
  recencyGuard: '最近保护条数',
  recencyGuardHint: '最近 N 条消息不参与压缩',
  turnGuard: '最近保护轮数',
  turnGuardHint: '最近 N 轮对话不参与压缩',
  sortMode: '剪枝优先级',
  sortModeHint: '密度＝先删又大又冗余的段（推荐）；密度+版本链＝重复版本越多越先删；按出现顺序＝旧行为',
  sortModeDensity: '信息密度优先（推荐）',
  sortModeLegacy: '按出现顺序',
  sortModeChain: '密度优先 + 版本链',
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
 * A text field with an optional enum constraint (used for the sortMode enum).
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

/** A boolean field rendered as a checkbox ('true'/'false' draft). */
export function booleanField(field: string): CardFieldSpec {
  return {
    field,
    format: value => (typeof value === 'boolean' ? String(value) : ''),
    parse: (text) => {
      const trimmed = text.trim().toLowerCase()
      if (trimmed === '') return { kind: 'clear' }
      if (trimmed === 'true') return { kind: 'set', value: true }
      if (trimmed === 'false') return { kind: 'set', value: false }
      return undefined
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
    return !this.stored(field)
  }

  private async store(field: string, value: unknown): Promise<boolean> {
    await this.scope.set(field, value)
    return this.userLayer()?.[field] === value
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

/** The card's full render state. */
export interface ArgpConfigState extends CardShell {
  windowRatio: CardFieldState
  retainRatio: CardFieldState
  maxPasses: CardFieldState
  recencyGuard: CardFieldState
  turnGuard: CardFieldState
  sortMode: CardFieldState
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
    // Bounds mirror the server-side ArgpUserSettingsSchema (argp-graph-engine.ts):
    // the client must reject out-of-spec drafts before they are ever staged for
    // a write, so an out-of-range value can never silently land in the namespace.
    this.form = new CardForm(scope, [
      numberField('windowRatio', { min: 0.1, max: 1 }),
      numberField('retainRatio', { min: 0.05, max: 1 }),
      numberField('maxPasses', { min: 1, integer: true }),
      numberField('recencyGuard', { min: 0, integer: true }),
      numberField('turnGuard', { min: 0, integer: true }),
      textField('sortMode', { enum: ['legacy', 'density', 'density-chain'] }),
    ])
    this.store = this.form.bind(() => this.projection())
  }

  private projection(): ArgpConfigState {
    return {
      ...this.form.shell(),
      windowRatio: this.form.field('windowRatio'),
      retainRatio: this.form.field('retainRatio'),
      maxPasses: this.form.field('maxPasses'),
      recencyGuard: this.form.field('recencyGuard'),
      turnGuard: this.form.field('turnGuard'),
      sortMode: this.form.field('sortMode'),
    }
  }

  /** Build the face the card's slot registration injects. */
  inject(): ArgpConfigFace {
    return { hooks: { argpConfig: this.store }, ...this.form.actions() }
  }
}
