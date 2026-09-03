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
/** Settings namespace this card owns (must equal the server-registered one). */
export const ARG_SETTINGS_KEY = 'dsh-argp';
/** English copy. */
export const en = {
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
};
/** Simplified Chinese copy. */
export const zh = {
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
};
/** Create a snapshot store seeded with `initial`. */
export function createSnapshotStore(initial) {
    let current = initial;
    const listeners = new Set();
    return {
        getSnapshot: () => current,
        set: (next) => {
            current = next;
            for (const listener of listeners)
                listener();
        },
        subscribe: (listener) => {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
    };
}
/** A whole-number field. Empty clears; non-finite blocks the save. */
export function numberField(field) {
    return {
        field,
        format: value => (typeof value === 'number' ? String(value) : ''),
        parse: (text) => {
            const trimmed = text.trim();
            if (trimmed === '')
                return { kind: 'clear' };
            const parsed = Number(trimmed);
            return Number.isFinite(parsed) ? { kind: 'set', value: parsed } : undefined;
        },
    };
}
/** A free-text field (used for the sortMode enum). Empty clears. */
export function textField(field) {
    return {
        field,
        format: value => (typeof value === 'string' ? value : ''),
        parse: (text) => {
            const trimmed = text.trim();
            return trimmed === '' ? { kind: 'clear' } : { kind: 'set', value: trimmed };
        },
    };
}
/** A boolean field rendered as a checkbox ('true'/'false' draft). */
export function booleanField(field) {
    return {
        field,
        format: value => (typeof value === 'boolean' ? String(value) : ''),
        parse: (text) => {
            const trimmed = text.trim().toLowerCase();
            if (trimmed === '')
                return { kind: 'clear' };
            if (trimmed === 'true')
                return { kind: 'set', value: true };
            if (trimmed === 'false')
                return { kind: 'set', value: false };
            return undefined;
        },
    };
}
/** Stages one card's edits over one settings namespace and writes them on save. */
export class CardForm {
    scope;
    specs;
    staged = new Map();
    listeners = new Set();
    saving = false;
    failed = false;
    constructor(scope, specs) {
        this.scope = scope;
        this.specs = new Map(specs.map(spec => [spec.field, spec]));
        scope.subscribe(() => { this.publish(); });
    }
    /** Publish a projection rebuilt whenever the scope or a draft changes. */
    bind(project) {
        const store = createSnapshotStore(project());
        this.listeners.add(() => { store.set(project()); });
        return store;
    }
    /** Read the card-level state: what the Host serves, and what a save would do. */
    shell() {
        const snapshot = this.scope.getSnapshot();
        const plan = this.plan();
        return {
            available: snapshot.status === 'ready',
            writable: snapshot.writable,
            dirty: plan.length > 0,
            invalid: plan.some(item => item.run === undefined),
            saving: this.saving,
            failed: this.failed,
        };
    }
    /** Read one control's state. */
    field(field) {
        const staged = this.staged.get(field);
        const spec = this.spec(field);
        if (staged === undefined) {
            return {
                text: spec.format(this.sectionValue(field)),
                overridden: this.stored(field),
                invalid: false,
            };
        }
        const write = staged.clear ? { kind: 'clear' } : spec.parse(staged.text);
        return {
            text: staged.text,
            overridden: write?.kind === 'set',
            invalid: write === undefined,
        };
    }
    /** Build the edit/reset/save/discard actions bound to this form. */
    actions() {
        return {
            edit: (field, text) => { this.stage(field, { text, clear: false }); },
            resetField: (field) => {
                this.stage(field, { text: this.spec(field).format(this.baseValue(field)), clear: true });
            },
            save: () => { void this.save(); },
            discard: () => {
                if (this.staged.size === 0 && !this.failed)
                    return;
                this.staged.clear();
                this.failed = false;
                this.publish();
            },
        };
    }
    /** Write every staged edit, then re-seed from what the Host accepted. */
    async save() {
        const plan = this.plan();
        const writes = plan.flatMap(item => (item.run === undefined ? [] : [item.run]));
        if (plan.length === 0 || this.saving || writes.length !== plan.length)
            return;
        this.saving = true;
        this.failed = false;
        this.publish();
        let landed = true;
        for (const write of writes)
            landed = (await write()) && landed;
        if (landed)
            this.staged.clear();
        this.saving = false;
        this.failed = !landed;
        this.publish();
    }
    /** Every staged edit a save would write. */
    plan() {
        const plan = [];
        for (const [field, staged] of this.staged) {
            const spec = this.spec(field);
            if (staged.clear) {
                if (this.stored(field))
                    plan.push({ field, run: () => this.clear(field) });
                continue;
            }
            if (staged.text === spec.format(this.sectionValue(field)))
                continue;
            const write = spec.parse(staged.text);
            if (write === undefined)
                plan.push({ field, run: undefined });
            else if (write.kind === 'clear')
                plan.push({ field, run: () => this.clear(field) });
            else
                plan.push({ field, run: () => this.store(field, write.value) });
        }
        return plan;
    }
    async clear(field) {
        await this.scope.unset(field);
        return !this.stored(field);
    }
    async store(field, value) {
        await this.scope.set(field, value);
        return this.userLayer()?.[field] === value;
    }
    stage(field, edit) {
        this.staged.set(field, edit);
        this.failed = false;
        this.publish();
    }
    spec(field) {
        const spec = this.specs.get(field);
        if (spec === undefined)
            throw new Error(`ARGP config card has no field ${field}`);
        return spec;
    }
    sectionValue(field) {
        return this.scope.getSnapshot().value?.[field];
    }
    baseValue(field) {
        return this.scope.getSnapshot().base?.[field];
    }
    userLayer() {
        return this.scope.getSnapshot().user;
    }
    stored(field) {
        const user = this.userLayer();
        return user !== undefined && Object.hasOwn(user, field);
    }
    publish() {
        for (const listener of this.listeners)
            listener();
    }
}
/** Bridges the `dsh-argp` scope onto the ARGP card's staged form. */
export class ArgpConfigController {
    form;
    store;
    /** @param scope - the bound settings scope for the `dsh-argp` namespace. */
    constructor(scope) {
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
        ]);
        this.store = this.form.bind(() => this.projection());
    }
    projection() {
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
        };
    }
    /** Build the face the card's slot registration injects. */
    inject() {
        return { hooks: { argpConfig: this.store }, ...this.form.actions() };
    }
}
