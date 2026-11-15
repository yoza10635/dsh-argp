/**
 * Minimal ambient typings for the web-shell-provided `react` runtime.
 *
 * The dsh web shell preloads `react` / `react/jsx-runtime` as platform modules
 * (PLATFORM_MODULES), so the client bundle externalizes them and the shell
 * resolves them at load time — they are NOT installed in this package's
 * node_modules. (A full `npm install` here is blocked by an unrelated upstream
 * peer conflict in the existing tree, so we cannot add `@types/react`.)
 *
 * We therefore declare only the surface this card uses. This file is a
 * declaration only: esbuild drops it from the bundle and the shell supplies
 * the real implementation. The card is written with `React.createElement`
 * (no JSX syntax) so no `jsx` tsconfig flag or react types are required.
 */
declare module 'react' {
  export type Key = string | number | bigint | null | undefined
  export interface ReactElement<P = any> {
    readonly type: any
    readonly props: P
    readonly key: Key
  }
  export type ReactNode =
    | ReactElement
    | string
    | number
    | boolean
    | null
    | undefined
    | Iterable<ReactNode>
  export function createElement(
    type: any,
    props?: Record<string, any> | null,
    ...children: ReactNode[]
  ): ReactElement
  export const Fragment: any
  export function useState<S>(
    initial: S | (() => S),
  ): [S, (next: S | ((prev: S) => S)) => void]
  export function useEffect(effect: () => void | (() => void), deps?: readonly any[]): void
  export function useRef<T>(initial: T): { current: T }
}

declare module 'react/jsx-runtime' {
  export function jsx(type: any, props: any, key?: any): any
  export function jsxs(type: any, props: any, key?: any): any
  export const Fragment: any
}
