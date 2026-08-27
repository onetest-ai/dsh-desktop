import { defineConfig } from 'tsdown'

/**
 * Module specifiers the harness shell shares through its frozen module table.
 *
 * Anything here must be left as an external `require`: the shell hands the
 * bundle its own React and its own services, and a second copy bundled in
 * would register into a different slot registry than the one on the page.
 */
const MODULE_TABLE = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-runtime/client',
])

const ID = '@onetest/dsh-desktop-pane'
const isShared = (specifier: string): boolean => MODULE_TABLE.has(specifier)

export default defineConfig([
  {
    name: '@onetest/dsh-desktop-pane/client',
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2024',
    dts: false,
    clean: false,
    sourcemap: true,
    deps: {
      neverBundle: isShared,
      alwaysBundle: (specifier: string) => !isShared(specifier),
    },
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    },
    outputOptions: {
      // One package, one bundle, wrapped the way the browser module system
      // expects: the harness serves exactly `/plugins/<id>/client.js` and its
      // `require` resolves only seed words and boot-graph rows, so an emitted
      // sibling chunk would be unroutable — and `files` would not publish it.
      codeSplitting: false,
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
