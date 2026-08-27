/**
 * Follow the harness's own light/dark switch.
 *
 * Upstream keys its tokens off `body[data-ds-dark-theme]` (see
 * `vendor/dsh-theme/README.md`), so this app's pages set the same attribute
 * rather than defining a second mechanism — the vendored sheets then resolve
 * to exactly the values the UI beside them is using.
 *
 * Driven by `prefers-color-scheme`, which is what Electron reports from the
 * OS setting, and re-read when that changes so the pane follows the system
 * without a reload.
 * @returns whether dark is currently in effect.
 */
export function followSystemTheme(): boolean {
  const dark = matchMedia('(prefers-color-scheme: dark)')
  const apply = (on: boolean): void => {
    if (on) document.body.setAttribute('data-ds-dark-theme', '')
    else document.body.removeAttribute('data-ds-dark-theme')
  }
  apply(dark.matches)
  dark.addEventListener('change', (event) => {
    apply(event.matches)
  })
  return dark.matches
}
