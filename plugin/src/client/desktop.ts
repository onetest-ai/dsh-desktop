/** A file or folder the user asked to reference in the chat. */
export interface ChatReference {
  /** The absolute path. */
  path: string
  /** Whether it is a directory. */
  directory: boolean
}

/** What the desktop app's preload exposes on the harness page. */
export interface DesktopBridge {
  /** Hear about a file or folder the user picked in that app's tree. */
  onAddToChat(listener: (reference: ChatReference) => void): void
  /**
   * Tell it which directory the open session works in, so its file tree
   * follows. Optional: a desktop older than this plugin has no such call, and
   * falls back to reading the harness's own files.
   */
  setWorkspace?(cwd: string): void
}

/**
 * The desktop app's bridge, or undefined when not running inside it.
 *
 * Read through a function rather than captured at module load: this half is
 * bundled once and served to whatever page loads it, and only that page knows
 * whether a preload put the bridge there.
 * @returns the bridge, or undefined in a plain browser or an older desktop.
 */
export function desktop(): DesktopBridge | undefined {
  const candidate = (globalThis as { dshDesktop?: unknown }).dshDesktop
  if (candidate === null || typeof candidate !== 'object') return undefined
  const { onAddToChat } = candidate as { onAddToChat?: unknown }
  return typeof onAddToChat === 'function' ? (candidate as DesktopBridge) : undefined
}
