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

import React from 'react'
import type {
  ArgpConfigState,
  ArgpLocaleKey,
  CardFieldState,
} from './argp-config-controller.js'

/** Locale reader handed to the card by the slot system. */
type T = (key: ArgpLocaleKey) => string

/** What the slot framework passes the card. */
export interface ArgpCardProps {
  t: T
  /** Snapshot selector derived from the controller's `hooks.argpConfig` store. */
  useArgpConfig: (selector: (s: ArgpConfigState) => ArgpConfigState) => ArgpConfigState
  save: () => void
  discard: () => void
  edit: (field: string, text: string) => void
  resetField: (field: string) => void
}

const h = React.createElement

// All chrome uses the host theme's `--dsw-alias-*` custom properties (defined
// for both light and dark in ui-theme design-platform.css). Fallbacks are
// LIGHT-theme values: an unknown var must degrade to a readable card, never
// to the dark constants the first version shipped (black-on-black in light
// theme, because `var(--bg-elevated, #1e1e22)` always fell back — the host
// never defined that name).
const cardStyle: Record<string, string | number> = {
  listStyle: 'none',
  border: '0.5px solid var(--dsw-alias-border-l4, rgba(0, 0, 0, 0.16))',
  borderRadius: 16,
  margin: '8px 0',
  background: 'var(--dsw-alias-bg-layer-3, #ffffff)',
  overflow: 'hidden',
}
const headerStyle: Record<string, string | number> = {
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
}
const nameStyle: Record<string, string | number> = {
  fontWeight: 600,
  fontSize: 15,
  color: 'var(--dsw-alias-label-primary, #17181a)',
}
const descriptionStyle: Record<string, string | number> = {
  fontSize: 13,
  color: 'var(--dsw-alias-label-tertiary, #6b6f76)',
  flex: 1,
  minWidth: 0,
}
const pendingStyle: Record<string, string | number> = {
  fontSize: 11,
  fontWeight: 500,
  whiteSpace: 'nowrap',
  borderRadius: 999,
  padding: '1px 8px',
  background: 'var(--dsw-alias-bg-module-platform, rgba(0, 0, 0, 0.06))',
  color: 'var(--dsw-alias-label-secondary, #4c5057)',
}
const bodyStyle: Record<string, string | number> = {
  padding: '4px 16px 14px',
  borderTop: '0.5px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1))',
}
const fieldStyle: Record<string, string | number> = {
  margin: '12px 0',
}
const fieldHeadStyle: Record<string, string | number> = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  marginBottom: 4,
}
const labelStyle: Record<string, string | number> = {
  fontSize: 13,
  fontWeight: 500,
}
const badgeStyle: Record<string, string | number> = {
  fontSize: 10,
  opacity: 0.8,
  border: '1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1))',
  borderRadius: 4,
  padding: '0 5px',
}
const resetStyle: Record<string, string | number> = {
  fontSize: 10,
  background: 'transparent',
  border: '1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1))',
  borderRadius: 4,
  color: 'inherit',
  cursor: 'pointer',
  padding: '0 5px',
}
const inputStyle: Record<string, string | number> = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '6px 8px',
  borderRadius: 6,
  border: '1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1))',
  background: 'var(--dsw-alias-bg-layer-2, #ffffff)',
  color: 'var(--dsw-alias-label-primary, #17181a)',
  fontSize: 13,
}
const inputInvalidStyle: Record<string, string | number> = {
  ...inputStyle,
  borderColor: 'var(--dsw-alias-label-error, #d64550)',
}
const hintStyle: Record<string, string | number> = {
  margin: '4px 0 0',
  fontSize: 11,
  opacity: 0.65,
  lineHeight: 1.4,
}
const footerStyle: Record<string, string | number> = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  marginTop: 16,
}
const readOnlyStyle: Record<string, string | number> = {
  fontSize: 12,
  opacity: 0.7,
  margin: '8px 0 0',
}
const failedStyle: Record<string, string | number> = {
  fontSize: 12,
  color: 'var(--dsw-alias-label-error, #d64550)',
  margin: '0 0 0 auto',
}
const btnBase: Record<string, string | number> = {
  padding: '5px 14px',
  borderRadius: 8,
  border: '1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1))',
  cursor: 'pointer',
  fontSize: 13,
}
const discardBtn: Record<string, string | number> = {
  ...btnBase,
  background: 'transparent',
  color: 'var(--dsw-alias-label-secondary, #4c5057)',
}
const saveBtn: Record<string, string | number> = {
  ...btnBase,
  background: 'var(--dsw-alias-label-primary, #17181a)',
  color: 'var(--dsw-alias-bg-layer-3, #ffffff)',
  borderColor: 'transparent',
  fontWeight: 600,
}
const chevronStyle = (open: boolean): Record<string, string | number> => ({
  transition: 'transform 0.15s ease',
  transform: open ? 'rotate(0deg)' : 'rotate(-90deg)',
  opacity: 0.7,
  fontSize: 12,
})

/** A staged text/number field control. */
function TextField(props: {
  id: string
  label: string
  hint: string
  state: CardFieldState
  numeric: boolean
  t: T
  onEdit: (text: string) => void
  onReset: () => void
}): React.ReactElement {
  const { id, label, hint, state, numeric, t, onEdit, onReset } = props
  return h('div', { style: fieldStyle },
    h('div', { style: fieldHeadStyle },
      h('label', { htmlFor: id, style: labelStyle }, label),
      state.overridden
        ? h('span', { style: badgeStyle }, t('overridden'),
            ' ',
            h('button', {
              type: 'button',
              style: resetStyle,
              disabled: false,
              onClick: onReset,
            }, t('reset')))
        : null,
    ),
    h('input', {
      id,
      type: 'text',
      style: state.invalid ? inputInvalidStyle : inputStyle,
      inputMode: numeric ? 'numeric' : undefined,
      'aria-invalid': state.invalid || undefined,
      value: state.text,
      placeholder: '',
      onChange: (e: any) => { onEdit(e.target.value) },
    }),
    h('p', { style: hintStyle }, state.invalid ? t('invalidNumber') : hint),
  )
}

/** A boolean field rendered as a checkbox. */
function BoolField(props: {
  id: string
  label: string
  hint: string
  state: CardFieldState
  t: T
  onEdit: (text: string) => void
  onReset: () => void
}): React.ReactElement {
  const { id, label, hint, state, t, onEdit, onReset } = props
  return h('div', { style: fieldStyle },
    h('div', { style: fieldHeadStyle },
      h('label', { htmlFor: id, style: labelStyle }, label),
      state.overridden
        ? h('span', { style: badgeStyle }, t('overridden'),
            ' ',
            h('button', {
              type: 'button',
              style: resetStyle,
              disabled: false,
              onClick: onReset,
            }, t('reset')))
        : null,
    ),
    h('input', {
      id,
      type: 'checkbox',
      checked: state.text === 'true',
      onChange: (e: any) => { onEdit(e.target.checked ? 'true' : 'false') },
    }),
    h('p', { style: hintStyle }, hint),
  )
}

/** The sortMode enum rendered as a select. */
function SelectField(props: {
  id: string
  label: string
  hint: string
  state: CardFieldState
  t: T
  onEdit: (text: string) => void
  onReset: () => void
}): React.ReactElement {
  const { id, label, hint, state, t, onEdit, onReset } = props
  const options: string[] = ['legacy', 'density', 'density-chain']
  return h('div', { style: fieldStyle },
    h('div', { style: fieldHeadStyle },
      h('label', { htmlFor: id, style: labelStyle }, label),
      state.overridden
        ? h('span', { style: badgeStyle }, t('overridden'),
            ' ',
            h('button', {
              type: 'button',
              style: resetStyle,
              disabled: false,
              onClick: onReset,
            }, t('reset')))
        : null,
    ),
    h('select', {
      id,
      style: inputStyle,
      value: state.text,
      onChange: (e: any) => { onEdit(e.target.value) },
    }, ...options.map(opt => h('option', { value: opt, key: opt }, opt))),
    h('p', { style: hintStyle }, hint),
  )
}

/**
 * Render the ARGP card.
 * @param props - locale copy, the card snapshot, and its form actions.
 * @returns the card, or nothing while the namespace is unavailable.
 */
export function ArgpConfigCard(props: ArgpCardProps): React.ReactElement | null {
  const [open, setOpen] = React.useState(false)
  const saveStarted = React.useRef(false)
  const state = props.useArgpConfig(s => s)
  React.useEffect(() => {
    if (state.saving) {
      saveStarted.current = true
      return
    }
    if (!saveStarted.current) return
    saveStarted.current = false
    if (!state.dirty && !state.failed) setOpen(false)
  }, [state.dirty, state.failed, state.saving])

  if (!state.available) return null

  const t = props.t
  const title = t('argpTitle')
  const blocked = !state.dirty || state.invalid || state.saving

  return h('li', { style: cardStyle },
    h('button', {
      type: 'button',
      style: headerStyle,
      'aria-expanded': open,
      onClick: () => { setOpen(!open) },
    },
      h('span', { style: { display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 } },
        h('span', { style: nameStyle }, title),
        h('span', { style: descriptionStyle }, t('argpDescription')),
      ),
      state.dirty ? h('span', { style: pendingStyle }, t('unsaved')) : null,
      h('span', { style: chevronStyle(open) }, '▾'),
    ),
    open
      ? h('div', { style: bodyStyle },
          !state.writable
            ? h('p', { style: readOnlyStyle, role: 'status' }, t('readOnly'))
            : null,
          h(TextField, {
            id: 'argp-windowRatio',
            label: t('windowRatio'),
            hint: t('windowRatioHint'),
            state: state.windowRatio,
            numeric: true,
            t,
            onEdit: (text: string) => { props.edit('windowRatio', text) },
            onReset: () => { props.resetField('windowRatio') },
          }),
          h(TextField, {
            id: 'argp-retainRatio',
            label: t('retainRatio'),
            hint: t('retainRatioHint'),
            state: state.retainRatio,
            numeric: true,
            t,
            onEdit: (text: string) => { props.edit('retainRatio', text) },
            onReset: () => { props.resetField('retainRatio') },
          }),
          h(TextField, {
            id: 'argp-maxPasses',
            label: t('maxPasses'),
            hint: t('maxPassesHint'),
            state: state.maxPasses,
            numeric: true,
            t,
            onEdit: (text: string) => { props.edit('maxPasses', text) },
            onReset: () => { props.resetField('maxPasses') },
          }),
          h(TextField, {
            id: 'argp-recencyGuard',
            label: t('recencyGuard'),
            hint: t('recencyGuardHint'),
            state: state.recencyGuard,
            numeric: true,
            t,
            onEdit: (text: string) => { props.edit('recencyGuard', text) },
            onReset: () => { props.resetField('recencyGuard') },
          }),
          h(TextField, {
            id: 'argp-turnGuard',
            label: t('turnGuard'),
            hint: t('turnGuardHint'),
            state: state.turnGuard,
            numeric: true,
            t,
            onEdit: (text: string) => { props.edit('turnGuard', text) },
            onReset: () => { props.resetField('turnGuard') },
          }),
          h(TextField, {
            id: 'argp-minSpanChars',
            label: t('minSpanChars'),
            hint: t('minSpanCharsHint'),
            state: state.minSpanChars,
            numeric: true,
            t,
            onEdit: (text: string) => { props.edit('minSpanChars', text) },
            onReset: () => { props.resetField('minSpanChars') },
          }),
          h(BoolField, {
            id: 'argp-enableSummarize',
            label: t('enableSummarize'),
            hint: t('enableSummarizeHint'),
            state: state.enableSummarize,
            t,
            onEdit: (text: string) => { props.edit('enableSummarize', text) },
            onReset: () => { props.resetField('enableSummarize') },
          }),
          h(SelectField, {
            id: 'argp-sortMode',
            label: t('sortMode'),
            hint: t('sortModeHint'),
            state: state.sortMode,
            t,
            onEdit: (text: string) => { props.edit('sortMode', text) },
            onReset: () => { props.resetField('sortMode') },
          }),
          h(TextField, {
            id: 'argp-charsPerToken',
            label: t('charsPerToken'),
            hint: t('charsPerTokenHint'),
            state: state.charsPerToken,
            numeric: true,
            t,
            onEdit: (text: string) => { props.edit('charsPerToken', text) },
            onReset: () => { props.resetField('charsPerToken') },
          }),
          h('div', { style: footerStyle },
            state.failed
              ? h('p', { style: failedStyle, role: 'status' }, t('saveFailed'))
              : null,
            h('button', {
              type: 'button',
              style: discardBtn,
              disabled: !state.dirty || state.saving,
              onClick: props.discard,
            }, t('discard')),
            h('button', {
              type: 'button',
              style: saveBtn,
              disabled: blocked,
              onClick: props.save,
            }, t(state.saving ? 'saving' : 'save')),
          ),
        )
      : null,
  )
}
