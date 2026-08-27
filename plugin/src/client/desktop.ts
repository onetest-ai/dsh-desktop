/** The calls the desktop app's preload exposes on the harness page. */
export interface DesktopBridge {
  /** Show the desktop app's file tree, or hide it when it is already showing. */
  toggleFiles(): void
  /** Show its browser, or hide it when that is what it is showing. */
  toggleWeb(): void
}

/**
 * The desktop app's bridge, or undefined when not running inside it.
 *
 * Read through a function rather than captured at module load: the browser
 * half is bundled once and served to whatever page loads it, and only that
 * page knows whether a preload put the bridge there.
 *
 * Both calls are required before this reports a bridge: a desktop older than
 * these buttons exposes neither, and half a bridge would render a button that
 * does nothing.
 * @returns the bridge, or undefined in a plain browser.
 */
export function desktop(): DesktopBridge | undefined {
  const candidate = (globalThis as { dshDesktop?: unknown }).dshDesktop
  if (candidate === null || typeof candidate !== 'object') return undefined
  const { toggleFiles, toggleWeb } = candidate as { toggleFiles?: unknown; toggleWeb?: unknown }
  return typeof toggleFiles === 'function' && typeof toggleWeb === 'function'
    ? (candidate as DesktopBridge)
    : undefined
}
