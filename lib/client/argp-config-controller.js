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
};
/** Simplified Chinese copy. */
export const zh = {
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
/**
 * A number field with optional range/integer constraints. Empty clears;
 * non-finite, out-of-range, or non-integer text is invalid (blocks the save,
 * never silently stored).
 */
export function numberField(field, spec) {
    return {
        field,
        format: value => (typeof value === 'number' ? String(value) : ''),
        parse: (text) => {
            const trimmed = text.trim();
            if (trimmed === '')
                return { kind: 'clear' };
            const parsed = Number(trimmed);
            if (!Number.isFinite(parsed))
                return undefined;
            if (spec !== undefined) {
                if (spec.integer === true && !Number.isInteger(parsed))
                    return undefined;
                if (spec.min !== undefined && parsed < spec.min)
                    return undefined;
                if (spec.max !== undefined && parsed > spec.max)
                    return undefined;
            }
            return { kind: 'set', value: parsed };
        },
    };
}
/**
 * A text field with an optional enum constraint (used for the sortMode enum).
 * Empty clears; a value outside the enum is invalid (never silently stored).
 */
export function textField(field, spec) {
    return {
        field,
        format: value => (typeof value === 'string' ? value : ''),
        parse: (text) => {
            const trimmed = text.trim();
            if (trimmed === '')
                return { kind: 'clear' };
            if (spec?.enum !== undefined && !spec.enum.includes(trimmed))
                return undefined;
            return { kind: 'set', value: trimmed };
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
        // Explicit field (not a parameter property): the client bundle is also
        // evaluated by Node's strip-only TS loader in tests, which rejects
        // parameter properties.
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
        try {
            for (const write of writes)
                landed = (await write()) && landed;
        }
        catch (error) {
            // A host `set`/`unset` rejection (network, permission, validation) must not
            // wedge the card on "Saving…" or leak an unhandled rejection: swallow it,
            // mark the save failed, and let the finally block re-publish the shell.
            landed = false;
            console.warn('[dsh-argp] settings save failed:', error);
        }
        finally {
            if (landed)
                this.staged.clear();
            this.saving = false;
            this.failed = !landed;
            this.publish();
        }
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
            sortMode: this.form.field('sortMode'),
        };
    }
    /** Build the face the card's slot registration injects. */
    inject() {
        return { hooks: { argpConfig: this.store }, ...this.form.actions() };
    }
}
