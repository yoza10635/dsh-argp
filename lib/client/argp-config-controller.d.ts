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
    windowRatio: number;
    /** Tokens retained after compaction, as a fraction of the window. */
    retainRatio: number;
    /** Max graph-pruning passes per compaction. */
    maxPasses: number;
    /** Recency guard: newest N turns never pruned. */
    recencyGuard: number;
    /** Turn guard: keep at least this many turns. */
    turnGuard: number;
    /** Minimum span length (chars) worth keeping. */
    minSpanChars: number;
    /** Enable extractive summarization of pruned spans. */
    enableSummarize: boolean;
    /** Eviction ordering strategy. */
    sortMode: 'legacy' | 'density' | 'density-chain';
    /** Characters-per-token heuristic for budget math. */
    charsPerToken: number;
}
/** Settings namespace this card owns (must equal the server-registered one). */
export declare const ARG_SETTINGS_KEY = "dsh-argp";
/** Locale keys the ARGP card renders. */
export type ArgpLocaleKey = 'argpTitle' | 'argpDescription' | 'windowRatio' | 'windowRatioHint' | 'retainRatio' | 'retainRatioHint' | 'maxPasses' | 'maxPassesHint' | 'recencyGuard' | 'recencyGuardHint' | 'turnGuard' | 'turnGuardHint' | 'minSpanChars' | 'minSpanCharsHint' | 'enableSummarize' | 'enableSummarizeHint' | 'sortMode' | 'sortModeHint' | 'charsPerToken' | 'charsPerTokenHint' | 'overridden' | 'reset' | 'readOnly' | 'expand' | 'collapse' | 'save' | 'saving' | 'discard' | 'unsaved' | 'saveFailed' | 'invalidNumber';
/** English copy. */
export declare const en: Record<ArgpLocaleKey, string>;
/** Simplified Chinese copy. */
export declare const zh: Record<ArgpLocaleKey, string>;
/**
 * A minimal external-store shape compatible with React's useSyncExternalStore.
 * MUST match the host's `ObservableSnapshot` contract (`getSnapshot` + `subscribe`)
 * — the slot renderer's `observableHook` → `bindSnapshotSelector` calls
 * `source.getSnapshot()`, so a `get()` spelling here crashes the card at render.
 */
export interface SnapshotStore<S> {
    /** Read the current snapshot (uSES contract name). */
    getSnapshot(): S;
    /** Replace the snapshot. */
    set(next: S): void;
    /** Subscribe a listener; returns an unsubscribe function. */
    subscribe(listener: () => void): () => void;
}
/** Create a snapshot store seeded with `initial`. */
export declare function createSnapshotStore<S>(initial: S): SnapshotStore<S>;
/** Snapshot a bound settings scope publishes. */
export interface SettingsScopeSnapshot {
    /** 'ready' when the namespace is served to this client. */
    status: 'ready' | 'loading' | 'unavailable';
    /** Whether the Host document accepts writes. */
    writable: boolean;
    /** Effective values (user layer over composition layer over schema default). */
    value: Record<string, unknown>;
    /** Composition-layer values. */
    base: Record<string, unknown>;
    /** User-layer values, or undefined when the user has set nothing. */
    user: Record<string, unknown> | undefined;
}
/** The bound settings scope a card's form reads and writes. */
export interface SettingsScopeLike<T> {
    /** Re-publish the form when the scope changes underneath. */
    subscribe(listener: () => void): void;
    /** Current scope snapshot. */
    getSnapshot(): SettingsScopeSnapshot;
    /** Write one field. */
    set(field: string, value: unknown): Promise<void>;
    /** Clear one field (re-inherit the composition layer). */
    unset(field: string): Promise<void>;
}
/** The write one field's staged text performs when the card is saved. */
type FieldWrite = {
    kind: 'set';
    value: unknown;
} | {
    kind: 'clear';
};
/** How one section field converts between its stored value and its draft text. */
export interface CardFieldSpec {
    /** Field name inside the namespace section. */
    field: string;
    /** Render a stored value as draft text; the empty string when none. */
    format: (value: unknown) => string;
    /** The write this draft text stages, or undefined when the text is invalid. */
    parse: (text: string) => FieldWrite | undefined;
}
/** One field as a card's control renders it. */
export interface CardFieldState {
    /** Draft text the control renders. */
    text: string;
    /** Whether saving would leave a user-layer entry for this field. */
    overridden: boolean;
    /** Whether the draft is not a value this field accepts (blocks saving). */
    invalid: boolean;
}
/** Form state every plugin card shares. */
export interface CardShell {
    /** False while the namespace is not served; the card renders nothing. */
    available: boolean;
    /** Whether the Host document accepts writes. */
    writable: boolean;
    /** Whether the form holds edits that a save would write. */
    dirty: boolean;
    /** Whether any staged draft is invalid (blocks the save). */
    invalid: boolean;
    /** Whether a save is crossing the wire. */
    saving: boolean;
    /** Whether the last save did not land as staged. */
    failed: boolean;
}
/** The write actions every plugin card injects. */
export interface CardActions {
    /** Stage draft text for one field. */
    edit: (field: string, text: string) => void;
    /** Stage a clear so saving re-inherits the composition layer. */
    resetField: (field: string) => void;
    /** Write every staged edit, then re-seed from what the Host accepted. */
    save: () => void;
    /** Drop every staged edit. */
    discard: () => void;
}
/** A whole-number field. Empty clears; non-finite blocks the save. */
export declare function numberField(field: string): CardFieldSpec;
/** A free-text field (used for the sortMode enum). Empty clears. */
export declare function textField(field: string): CardFieldSpec;
/** A boolean field rendered as a checkbox ('true'/'false' draft). */
export declare function booleanField(field: string): CardFieldSpec;
/** Stages one card's edits over one settings namespace and writes them on save. */
export declare class CardForm<T> {
    private readonly scope;
    private readonly specs;
    private readonly staged;
    private readonly listeners;
    private saving;
    private failed;
    constructor(scope: SettingsScopeLike<T>, specs: CardFieldSpec[]);
    /** Publish a projection rebuilt whenever the scope or a draft changes. */
    bind<S>(project: () => S): SnapshotStore<S>;
    /** Read the card-level state: what the Host serves, and what a save would do. */
    shell(): CardShell;
    /** Read one control's state. */
    field(field: string): CardFieldState;
    /** Build the edit/reset/save/discard actions bound to this form. */
    actions(): CardActions;
    /** Write every staged edit, then re-seed from what the Host accepted. */
    private save;
    /** Every staged edit a save would write. */
    private plan;
    private clear;
    private store;
    private stage;
    private spec;
    private sectionValue;
    private baseValue;
    private userLayer;
    private stored;
    private publish;
}
/** The card's full render state. */
export interface ArgpConfigState extends CardShell {
    windowRatio: CardFieldState;
    retainRatio: CardFieldState;
    maxPasses: CardFieldState;
    recencyGuard: CardFieldState;
    turnGuard: CardFieldState;
    minSpanChars: CardFieldState;
    enableSummarize: CardFieldState;
    sortMode: CardFieldState;
    charsPerToken: CardFieldState;
}
/** The registration-side face the slot entry injects. */
export interface ArgpConfigFace extends CardActions {
    hooks: {
        argpConfig: SnapshotStore<ArgpConfigState>;
    };
}
/** Bridges the `dsh-argp` scope onto the ARGP card's staged form. */
export declare class ArgpConfigController {
    private readonly form;
    private readonly store;
    /** @param scope - the bound settings scope for the `dsh-argp` namespace. */
    constructor(scope: SettingsScopeLike<ArgpUserSettings>);
    private projection;
    /** Build the face the card's slot registration injects. */
    inject(): ArgpConfigFace;
}
export {};
