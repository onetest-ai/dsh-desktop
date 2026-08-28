/**
 * Draw in the theme the harness is set to.
 *
 * Upstream keys its tokens off `body[data-ds-dark-theme]` (see
 * `vendor/dsh-theme/README.md`), so this app's pages set the same attribute
 * rather than defining a second mechanism — the vendored sheets then resolve
 * to exactly the values the UI beside them is using.
 *
 * Whether dark applies is decided in main and pushed here, never read from
 * `prefers-color-scheme`: that query answers for the document, and a page
 * that has not declared `color-scheme` is told light however the machine is
 * set — which is how these columns came up white beside a dark harness.
 * @param onChange - called with whether dark is in effect, whenever it changes.
 */
export function followHarnessTheme(onChange: (dark: boolean) => void): void {
  const global = globalThis as { pane?: ThemeBridge; shell?: ThemeBridge; terminal?: ThemeBridge }
  const bridge = global.pane ?? global.shell ?? global.terminal
  bridge?.onTheme((dark) => {
    if (dark) document.body.setAttribute('data-ds-dark-theme', '')
    else document.body.removeAttribute('data-ds-dark-theme')
    onChange(dark)
  })
  bridge?.askTheme()
}

/** The two calls a page needs to follow the harness's theme. */
interface ThemeBridge {
  askTheme(): void
  onTheme(listener: (dark: boolean) => void): void
}
