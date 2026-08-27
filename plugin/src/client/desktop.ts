/** The single call the desktop app's preload exposes on the harness page. */
export interface DesktopBridge {
  /** Show the side pane, or hide it when it is already showing. */
  togglePane(): void
}

/**
 * The desktop app's bridge, or undefined when not running inside it.
 *
 * Read through a function rather than captured at module load: the browser
 * half is bundled once and served to whatever page loads it, and only that
 * page knows whether a preload put the bridge there.
 * @returns the bridge, or undefined in a plain browser.
 */
export function desktop(): DesktopBridge | undefined {
  const candidate = (globalThis as { dshDesktop?: unknown }).dshDesktop
  if (candidate === null || typeof candidate !== 'object') return undefined
  const { togglePane } = candidate as { togglePane?: unknown }
  return typeof togglePane === 'function' ? (candidate as DesktopBridge) : undefined
}
