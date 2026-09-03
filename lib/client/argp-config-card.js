/**
 * ARGP settings card: one collapsible card in Settings → Plugins →
 * Plugin configuration, editing the nine `dsh-argp` engine knobs.
 *
 * Self-contained port of the host `ui-settings-plugins` `BashCard` /
 * `PluginCard` / `ValueField` trio. Written with `React.createElement` (no JSX
 * syntax) so the build needs no `react` types or `jsx` tsconfig flag; the real
 * `react` is externalized and supplied by the web shell at load time. Card
 * chrome is inline-styled because the host CSS modules are not installed.
 */
import React from 'react';
const h = React.createElement;
const cardStyle = {
    listStyle: 'none',
    border: '1px solid var(--border, #2a2a2e)',
    borderRadius: 8,
    margin: '8px 0',
    background: 'var(--bg-elevated, #1e1e22)',
    overflow: 'hidden',
};
const headerStyle = {
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '12px 14px',
    background: 'transparent',
    border: 'none',
    color: 'inherit',
    cursor: 'pointer',
    textAlign: 'left',
};
const nameStyle = {
    fontWeight: 600,
    fontSize: 14,
};
const descriptionStyle = {
    opacity: 0.7,
    fontSize: 12,
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
};
const pendingStyle = {
    fontSize: 11,
    color: 'var(--accent, #6ea8fe)',
    border: '1px solid currentColor',
    borderRadius: 4,
    padding: '1px 6px',
};
const bodyStyle = {
    padding: '4px 14px 14px',
    borderTop: '1px solid var(--border, #2a2a2e)',
};
const fieldStyle = {
    margin: '12px 0',
};
const fieldHeadStyle = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginBottom: 4,
};
const labelStyle = {
    fontSize: 13,
    fontWeight: 500,
};
const badgeStyle = {
    fontSize: 10,
    opacity: 0.8,
    border: '1px solid var(--border, #2a2a2e)',
    borderRadius: 4,
    padding: '0 5px',
};
const resetStyle = {
    fontSize: 10,
    background: 'transparent',
    border: '1px solid var(--border, #2a2a2e)',
    borderRadius: 4,
    color: 'inherit',
    cursor: 'pointer',
    padding: '0 5px',
};
const inputStyle = {
    width: '100%',
    boxSizing: 'border-box',
    padding: '6px 8px',
    borderRadius: 6,
    border: '1px solid var(--border, #2a2a2e)',
    background: 'var(--bg-input, #161618)',
    color: 'inherit',
    fontSize: 13,
};
const inputInvalidStyle = {
    ...inputStyle,
    borderColor: 'var(--danger, #f0686b)',
};
const hintStyle = {
    margin: '4px 0 0',
    fontSize: 11,
    opacity: 0.65,
    lineHeight: 1.4,
};
const footerStyle = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginTop: 16,
};
const readOnlyStyle = {
    fontSize: 12,
    opacity: 0.7,
    margin: '8px 0 0',
};
const failedStyle = {
    fontSize: 12,
    color: 'var(--danger, #f0686b)',
    margin: '0 0 0 auto',
};
const btnBase = {
    padding: '6px 14px',
    borderRadius: 6,
    border: '1px solid var(--border, #2a2a2e)',
    cursor: 'pointer',
    fontSize: 13,
};
const discardBtn = {
    ...btnBase,
    background: 'transparent',
    color: 'inherit',
};
const saveBtn = {
    ...btnBase,
    background: 'var(--accent, #6ea8fe)',
    color: 'var(--accent-fg, #08121f)',
    borderColor: 'transparent',
    fontWeight: 600,
};
const chevronStyle = (open) => ({
    transition: 'transform 0.15s ease',
    transform: open ? 'rotate(0deg)' : 'rotate(-90deg)',
    opacity: 0.7,
    fontSize: 12,
});
/** A staged text/number field control. */
function TextField(props) {
    const { id, label, hint, state, numeric, t, onEdit, onReset } = props;
    return h('div', { style: fieldStyle }, h('div', { style: fieldHeadStyle }, h('label', { htmlFor: id, style: labelStyle }, label), state.overridden
        ? h('span', { style: badgeStyle }, t('overridden'), ' ', h('button', {
            type: 'button',
            style: resetStyle,
            disabled: false,
            onClick: onReset,
        }, t('reset')))
        : null), h('input', {
        id,
        type: 'text',
        style: state.invalid ? inputInvalidStyle : inputStyle,
        inputMode: numeric ? 'numeric' : undefined,
        'aria-invalid': state.invalid || undefined,
        value: state.text,
        placeholder: '',
        onChange: (e) => { onEdit(e.target.value); },
    }), h('p', { style: hintStyle }, state.invalid ? t('invalidNumber') : hint));
}
/** A boolean field rendered as a checkbox. */
function BoolField(props) {
    const { id, label, hint, state, t, onEdit, onReset } = props;
    return h('div', { style: fieldStyle }, h('div', { style: fieldHeadStyle }, h('label', { htmlFor: id, style: labelStyle }, label), state.overridden
        ? h('span', { style: badgeStyle }, t('overridden'), ' ', h('button', {
            type: 'button',
            style: resetStyle,
            disabled: false,
            onClick: onReset,
        }, t('reset')))
        : null), h('input', {
        id,
        type: 'checkbox',
        checked: state.text === 'true',
        onChange: (e) => { onEdit(e.target.checked ? 'true' : 'false'); },
    }), h('p', { style: hintStyle }, hint));
}
/** The sortMode enum rendered as a select. */
function SelectField(props) {
    const { id, label, hint, state, t, onEdit, onReset } = props;
    const options = ['legacy', 'density', 'density-chain'];
    return h('div', { style: fieldStyle }, h('div', { style: fieldHeadStyle }, h('label', { htmlFor: id, style: labelStyle }, label), state.overridden
        ? h('span', { style: badgeStyle }, t('overridden'), ' ', h('button', {
            type: 'button',
            style: resetStyle,
            disabled: false,
            onClick: onReset,
        }, t('reset')))
        : null), h('select', {
        id,
        style: inputStyle,
        value: state.text,
        onChange: (e) => { onEdit(e.target.value); },
    }, ...options.map(opt => h('option', { value: opt, key: opt }, opt))), h('p', { style: hintStyle }, hint));
}
/**
 * Render the ARGP card.
 * @param props - locale copy, the card snapshot, and its form actions.
 * @returns the card, or nothing while the namespace is unavailable.
 */
export function ArgpConfigCard(props) {
    const [open, setOpen] = React.useState(false);
    const saveStarted = React.useRef(false);
    const state = props.useArgpConfig(s => s);
    React.useEffect(() => {
        if (state.saving) {
            saveStarted.current = true;
            return;
        }
        if (!saveStarted.current)
            return;
        saveStarted.current = false;
        if (!state.dirty && !state.failed)
            setOpen(false);
    }, [state.dirty, state.failed, state.saving]);
    if (!state.available)
        return null;
    const t = props.t;
    const title = t('argpTitle');
    const blocked = !state.dirty || state.invalid || state.saving;
    return h('li', { style: cardStyle }, h('button', {
        type: 'button',
        style: headerStyle,
        'aria-expanded': open,
        onClick: () => { setOpen(!open); },
    }, h('span', { style: { display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 } }, h('span', { style: nameStyle }, title), h('span', { style: descriptionStyle }, t('argpDescription'))), state.dirty ? h('span', { style: pendingStyle }, t('unsaved')) : null, h('span', { style: chevronStyle(open) }, '▾')), open
        ? h('div', { style: bodyStyle }, !state.writable
            ? h('p', { style: readOnlyStyle, role: 'status' }, t('readOnly'))
            : null, h(TextField, {
            id: 'argp-windowRatio',
            label: t('windowRatio'),
            hint: t('windowRatioHint'),
            state: state.windowRatio,
            numeric: true,
            t,
            onEdit: (text) => { props.edit('windowRatio', text); },
            onReset: () => { props.resetField('windowRatio'); },
        }), h(TextField, {
            id: 'argp-retainRatio',
            label: t('retainRatio'),
            hint: t('retainRatioHint'),
            state: state.retainRatio,
            numeric: true,
            t,
            onEdit: (text) => { props.edit('retainRatio', text); },
            onReset: () => { props.resetField('retainRatio'); },
        }), h(TextField, {
            id: 'argp-maxPasses',
            label: t('maxPasses'),
            hint: t('maxPassesHint'),
            state: state.maxPasses,
            numeric: true,
            t,
            onEdit: (text) => { props.edit('maxPasses', text); },
            onReset: () => { props.resetField('maxPasses'); },
        }), h(TextField, {
            id: 'argp-recencyGuard',
            label: t('recencyGuard'),
            hint: t('recencyGuardHint'),
            state: state.recencyGuard,
            numeric: true,
            t,
            onEdit: (text) => { props.edit('recencyGuard', text); },
            onReset: () => { props.resetField('recencyGuard'); },
        }), h(TextField, {
            id: 'argp-turnGuard',
            label: t('turnGuard'),
            hint: t('turnGuardHint'),
            state: state.turnGuard,
            numeric: true,
            t,
            onEdit: (text) => { props.edit('turnGuard', text); },
            onReset: () => { props.resetField('turnGuard'); },
        }), h(TextField, {
            id: 'argp-minSpanChars',
            label: t('minSpanChars'),
            hint: t('minSpanCharsHint'),
            state: state.minSpanChars,
            numeric: true,
            t,
            onEdit: (text) => { props.edit('minSpanChars', text); },
            onReset: () => { props.resetField('minSpanChars'); },
        }), h(BoolField, {
            id: 'argp-enableSummarize',
            label: t('enableSummarize'),
            hint: t('enableSummarizeHint'),
            state: state.enableSummarize,
            t,
            onEdit: (text) => { props.edit('enableSummarize', text); },
            onReset: () => { props.resetField('enableSummarize'); },
        }), h(SelectField, {
            id: 'argp-sortMode',
            label: t('sortMode'),
            hint: t('sortModeHint'),
            state: state.sortMode,
            t,
            onEdit: (text) => { props.edit('sortMode', text); },
            onReset: () => { props.resetField('sortMode'); },
        }), h(TextField, {
            id: 'argp-charsPerToken',
            label: t('charsPerToken'),
            hint: t('charsPerTokenHint'),
            state: state.charsPerToken,
            numeric: true,
            t,
            onEdit: (text) => { props.edit('charsPerToken', text); },
            onReset: () => { props.resetField('charsPerToken'); },
        }), h('div', { style: footerStyle }, state.failed
            ? h('p', { style: failedStyle, role: 'status' }, t('saveFailed'))
            : null, h('button', {
            type: 'button',
            style: discardBtn,
            disabled: !state.dirty || state.saving,
            onClick: props.discard,
        }, t('discard')), h('button', {
            type: 'button',
            style: saveBtn,
            disabled: blocked,
            onClick: props.save,
        }, t(state.saving ? 'saving' : 'save'))))
        : null);
}
