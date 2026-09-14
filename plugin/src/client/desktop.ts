/** A file or folder the user asked to reference in the chat. */
export interface ChatReference {
  /** The absolute path. */
  path: string
  /** Whether it is a directory. */
  directory: boolean
}

/**
 * A compose the desktop app asked us to run against the open session.
 *
 * Re-declared here rather than imported from the app: the two halves compile
 * separately (this bundle ships inside the harness, that one inside Electron),
 * and this shape is kept identical to the app's copy by hand — the repo's
 * standing rule for anything crossing the preload boundary.
 */
export interface ComposeRequest {
  /** What the user typed. */
  text: string
  /** The project to run it in; absent leaves the current session's own. */
  workspaceId?: string
  /** The model to switch to first; absent leaves the current one. */
  model?: string
  /** Send it (true) or only drop it in the box for the user to send (false). */
  send: boolean
}

/** The projects and models the desktop app can offer for a compose. */
export interface ComposerOptions {
  /** Every open project, with the one the current session runs in marked. */
  workspaces: { id: string; title: string; current: boolean }[]
  /**
   * The models the user can pick, if this runtime exposes any. Omitted — not
   * an empty array — when no model feed is reachable, so the app hides the
   * control rather than showing an empty one.
   */
  models?: { id: string; label: string; current: boolean }[]
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
  /**
   * Hear about a compose the user built in that app's mini-composer, to run it
   * through the harness's real session APIs instead of the app's DOM path.
   * Optional: a desktop older than this feature never calls it, so the plugin
   * feature-detects before registering.
   */
  onCompose?(listener: (req: ComposeRequest) => void): void
  /**
   * Tell it which projects (and models, when there are any) it may offer, so
   * its mini-composer's dropdowns are real data rather than scraped DOM.
   * Optional, for the same reason as {@link onCompose}.
   */
  reportComposerOptions?(opts: ComposerOptions): void
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
