/** What the harness's Appearance row stores. */
export type ThemePreference = 'light' | 'dark' | 'system'

/**
 * Draw in the theme the harness is set to.
 *
 * Upstream keys its tokens off `body[data-ds-dark-theme]` (see
 * `vendor/dsh-theme/README.md`), so this app's pages set the same attribute
 * rather than defining a second mechanism — the vendored sheets then resolve
 * to exactly the values the UI beside them is using.
 *
 * The preference comes from the harness's own settings document, which main
 * reads and pushes: `system` defers to the OS, and the other two override it.
 * Following the harness rather than the OS alone is what keeps the columns
 * matching when someone sets dark inside the harness on a light machine.
 * @param onChange - called with whether dark is now in effect, when it changes.
 * @returns whether dark is in effect right now.
 */
export function followHarnessTheme(onChange: (dark: boolean) => void): boolean {
  const system = matchMedia('(prefers-color-scheme: dark)')
  let preference: ThemePreference = 'system'

  const apply = (): boolean => {
    const dark = preference === 'dark' || (preference === 'system' && system.matches)
    if (dark) document.body.setAttribute('data-ds-dark-theme', '')
    else document.body.removeAttribute('data-ds-dark-theme')
    return dark
  }

  const bridge = (globalThis as { pane?: ThemeBridge; shell?: ThemeBridge }).pane
    ?? (globalThis as { shell?: ThemeBridge }).shell
  bridge?.onTheme((next) => {
    preference = next === 'light' || next === 'dark' ? next : 'system'
    onChange(apply())
  })
  // The OS still matters under `system`, so its own changes are followed too.
  system.addEventListener('change', () => {
    if (preference === 'system') onChange(apply())
  })
  const dark = apply()
  bridge?.askTheme()
  return dark
}

/** The two calls a page needs to follow the harness's theme. */
interface ThemeBridge {
  askTheme(): void
  onTheme(listener: (preference: string) => void): void
}
