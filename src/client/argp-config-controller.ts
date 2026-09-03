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

/** The nine engine knobs this card edits (mirrors the server ArgpUserSettings). */
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
  | 'minSpanChars' | 'minSpanCharsHint'
  | 'enableSummarize' | 'enableSummarizeHint'
  | 'sortMode' | 'sortModeHint'
  | 'charsPerToken' | 'charsPerTokenHint'
  | 'overridden' | 'reset' | 'readOnly' | 'expand' | 'collapse'
  | 'save' | 'saving' | 'discard' | 'unsaved' | 'saveFailed' | 'invalidNumber'

/** English copy. */
export const en: Record<ArgpLocaleKey, string> = {
  argpTitle: 'ARGP context compaction',
  argpDescription: 'Guarded context compression: eager per-atom shrink + lazy reference-graph eviction. Edits apply live, no restart.',
  windowRatio: 'Compaction window ratio',
  windowRatioHint: 'Fraction of the context budget the engine may use before it compacts (0.1–1).',
  retainRatio: 'Retain ratio',
  retainRatioHint: 'Fraction of the window kept verbatim after a compaction (0.05–1).',
  maxPasses: 'Max pruning passes',
  maxPassesHint: 'Upper bound on reference-graph eviction passes per compaction (integer ≥ 1).',
  recencyGuard: 'Recency guard (turns)',
  recencyGuardHint: 'Newest N turns are never pruned (integer ≥ 0).',
  turnGuard: 'Turn guard (turns)',
  turnGuardHint: 'Keep at least this many turns regardless of score (integer ≥ 0).',
  minSpanChars: 'Minimum span length (chars)',
  minSpanCharsHint: 'Spans shorter than this are kept; below it, pruning is not worth the overhead (integer ≥ 0).',
  enableSummarize: 'Enable extractive summarization',
  enableSummarizeHint: 'When on, pruned spans are replaced by an extractive summary instead of being dropped.',
  sortMode: 'Eviction order',
  sortModeHint: 'legacy = insertion order; density = highest information-density first; density-chain = density with overlap chaining.',
  charsPerToken: 'Chars per token',
  charsPerTokenHint: 'Heuristic used to convert characters to tokens for budget math (0.5–8).',
  overridden: 'Overridden',
  reset: 'Reset to default',
  readOnly: 'This deployment stores settings read-only.',
  expand: 'Show settings',
  collapse: 'Hide settings',
  save: 'Save',
  saving: 'Saving…',
  discard: 'Discard',
  unsaved: 'Unsaved',
  saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
  invalidNumber: 'Enter a number, or leave blank to use the default.',
}

/** Simplified Chinese copy. */
export const zh: Record<ArgpLocaleKey, string> = {
  argpTitle: 'ARGP 上下文压缩',
  argpDescription: '带护栏的上下文压缩：急切的逐原子收缩 + 惰性引用图驱逐。修改即时生效，无需重启。',
  windowRatio: '压缩窗口比例',
  windowRatioHint: '引擎在触发压缩前可使用的上下文预算占比（0.1–1）。',
  retainRatio: '保留比例',
  retainRatioHint: '每次压缩后原样保留的窗口占比（0.05–1）。',
  maxPasses: '最大驱逐轮数',
  maxPassesHint: '每次压缩引用图驱逐的最大轮数（整数 ≥ 1）。',
  recencyGuard: '新鲜度护栏（轮）',
  recencyGuardHint: '最新的 N 轮永远不会被驱逐（整数 ≥ 0）。',
  turnGuard: '轮数护栏（轮）',
  turnGuardHint: '无论评分如何至少保留这么多轮（整数 ≥ 0）。',
  minSpanChars: '最小片段长度（字符）',
  minSpanCharsHint: '短于此长度的片段会被保留；低于它，驱逐不划算（整数 ≥ 0）。',
  enableSummarize: '启用抽取式摘要',
  enableSummarizeHint: '开启后，被驱逐的片段会替换为抽取式摘要，而不是直接丢弃。',
  sortMode: '驱逐顺序',
  sortModeHint: 'legacy = 插入顺序；density = 信息密度最高者优先；density-chain = 密度优先并带重叠链路。',
  charsPerToken: '每 token 字符数',
  charsPerTokenHint: '用于把字符换算成 token 做预算估算的启发值（0.5–8）。',
  overridden: '已覆盖',
  reset: '恢复默认',
  readOnly: '本部署的设置为只读。',
  expand: '展开设置',
  collapse: '收起设置',
  save: '保存',
  saving: '保存中…',
  discard: '放弃修改',
  unsaved: '未保存',
  saveFailed: '本部署没有接受这些值，已保留供你修改。',
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

/** A whole-number field. Empty clears; non-finite blocks the save. */
export function numberField(field: string): CardFieldSpec {
  return {
    field,
    format: value => (typeof value === 'number' ? String(value) : ''),
    parse: (text) => {
      const trimmed = text.trim()
      if (trimmed === '') return { kind: 'clear' }
      const parsed = Number(trimmed)
      return Number.isFinite(parsed) ? { kind: 'set', value: parsed } : undefined
    },
  }
}

/** A free-text field (used for the sortMode enum). Empty clears. */
export function textField(field: string): CardFieldSpec {
  return {
    field,
    format: value => (typeof value === 'string' ? value : ''),
    parse: (text) => {
      const trimmed = text.trim()
      return trimmed === '' ? { kind: 'clear' } : { kind: 'set', value: trimmed }
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
  private readonly specs: Map<string, CardFieldSpec>
  private readonly staged = new Map<string, StagedEdit>()
  private readonly listeners = new Set<() => void>()
  private saving = false
  private failed = false

  constructor(
    private readonly scope: SettingsScopeLike<T>,
    specs: CardFieldSpec[],
  ) {
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
    for (const write of writes) landed = (await write()) && landed
    if (landed) this.staged.clear()
    this.saving = false
    this.failed = !landed
    this.publish()
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
  minSpanChars: CardFieldState
  enableSummarize: CardFieldState
  sortMode: CardFieldState
  charsPerToken: CardFieldState
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
    this.form = new CardForm(scope, [
      numberField('windowRatio'),
      numberField('retainRatio'),
      numberField('maxPasses'),
      numberField('recencyGuard'),
      numberField('turnGuard'),
      numberField('minSpanChars'),
      booleanField('enableSummarize'),
      textField('sortMode'),
      numberField('charsPerToken'),
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
      minSpanChars: this.form.field('minSpanChars'),
      enableSummarize: this.form.field('enableSummarize'),
      sortMode: this.form.field('sortMode'),
      charsPerToken: this.form.field('charsPerToken'),
    }
  }

  /** Build the face the card's slot registration injects. */
  inject(): ArgpConfigFace {
    return { hooks: { argpConfig: this.store }, ...this.form.actions() }
  }
}
