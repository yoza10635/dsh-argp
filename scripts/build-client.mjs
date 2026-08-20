/**
 * Build the dsh-argp client bundle (lib/client.js).
 *
 * Emits the closure-factory artifact the web shell's module loader expects:
 * the bundle calls `window.__ModuleLoader__.load({ id, factory })`, resolves
 * its externals through the injected require, and returns module.exports from
 * the factory — the exact shape tsdown's shared client preset produces for the
 * platform client packages (see deepseek-harness packages/client/tsdown.client.ts).
 *
 * This bundle is fully self-contained: it imports only package-local code
 * (src/cites-strip.js), so there are no externals to keep external.
 */
import { build } from 'esbuild'

const ID = 'dsh-argp'

await build({
  entryPoints: ['src/client/index.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  outfile: 'lib/client.js',
  banner: {
    js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {\n`
      + 'var module = { exports: {} }; var exports = module.exports;',
  },
  footer: {
    js: 'return module.exports; } });',
  },
  sourcemap: false,
  logLevel: 'info',
})
