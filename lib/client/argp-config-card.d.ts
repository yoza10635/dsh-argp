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
import type { ArgpConfigState, ArgpLocaleKey } from './argp-config-controller.js';
/** Locale reader handed to the card by the slot system. */
type T = (key: ArgpLocaleKey) => string;
/** What the slot framework passes the card. */
export interface ArgpCardProps {
    t: T;
    /** Snapshot selector derived from the controller's `hooks.argpConfig` store. */
    useArgpConfig: (selector: (s: ArgpConfigState) => ArgpConfigState) => ArgpConfigState;
    save: () => void;
    discard: () => void;
    edit: (field: string, text: string) => void;
    resetField: (field: string) => void;
}
/**
 * Render the ARGP card.
 * @param props - locale copy, the card snapshot, and its form actions.
 * @returns the card, or nothing while the namespace is unavailable.
 */
export declare function ArgpConfigCard(props: ArgpCardProps): React.ReactElement | null;
export {};
