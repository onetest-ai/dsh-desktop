import type { DesktopBridge } from './desktop.ts'

/**
 * Prefix of the harness's own file resource addresses:
 * `dsh-resource://file/session/<sessionId>/<workspace-relative path>`, each
 * segment `encodeURIComponent`-encoded. Mirrored from the harness by hand — we
 * only read the address it already built, never construct one — and guarded so
 * that anything not shaped like it falls through to the harness untouched.
 */
const FILE_ADDRESS_PREFIX = 'dsh-resource://file/session/'

/** `decodeURIComponent`, but undefined instead of throwing on a malformed segment. */
function decode(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment)
  } catch {
    return undefined
  }
}

/**
 * The absolute file path a harness file-resource address points at, or
 * undefined when the address is not a session file, names the workspace root
 * itself, cannot be decoded, or is workspace-relative in a session whose root
 * we do not know.
 *
 * The harness stores the path either already-absolute (leading `/`) or relative
 * to the session's workspace root; a relative one is joined onto the cwd the
 * caller resolves for that session.
 * @param address - the `dsh-resource://…` address `openResource` was handed.
 * @param cwdFor - the workspace root of a session id, when known.
 * @returns the absolute path, or undefined to leave the open to the harness.
 */
export function absoluteFileFromAddress(address: string, cwdFor: (sessionId: string) => string | undefined): string | undefined {
  if (!address.startsWith(FILE_ADDRESS_PREFIX)) return undefined
  const segments = address.slice(FILE_ADDRESS_PREFIX.length).split('/')
  const sessionId = decode(segments[0] ?? '')
  if (sessionId === undefined || sessionId === '') return undefined
  const parts = segments.slice(1).map(decode)
  if (parts.some((part) => part === undefined)) return undefined
  const path = (parts as string[]).join('/')
  if (path === '') return undefined
  if (path.startsWith('/')) return path
  const cwd = cwdFor(sessionId)
  if (cwd === undefined || cwd === '') return undefined
  return `${cwd.replace(/\/+$/, '')}/${path}`
}

/** The slice of the client context this redirect reads. */
export interface RedirectContext {
  sidebarRight?: { openResource?: (address: string, options?: unknown) => unknown }
  sessions?: { list?: { getSnapshot?: () => { byId?: Record<string, { cwd?: string } | undefined> } } }
}

/** The workspace root of one session, read defensively from the session list. */
function cwdOf(ctx: RedirectContext, sessionId: string): string | undefined {
  return ctx.sessions?.list?.getSnapshot?.().byId?.[sessionId]?.cwd
}

/**
 * Send the harness page's own file "Open" into the desktop app's panes.
 *
 * The deliverable card's main "Open" (and the harness file tree's open) call
 * `ctx.sidebarRight.openResource`, which renders the file in the harness's own
 * side tab. Inside the desktop app the user wants it in the app's editor/web
 * pane instead, so `openResource` is wrapped: a session file address is decoded
 * to an absolute path and handed to the app; when the app takes it, the harness
 * tab is skipped; when it declines (a path outside any open project) or the
 * address is anything else, the harness opens it its own way, unchanged.
 *
 * A no-op outside the desktop app (no `openPath` bridge) or where no right
 * sidebar exists — the same feature-detected quietness as the rest of this
 * plugin. The harness's "Open in default app" and "Show in Finder" go nowhere
 * near this; they stay native.
 * @param ctx - the client context carrying `sidebarRight` and `sessions`.
 * @param bridge - the desktop app's preload bridge.
 */
export function installFileOpenRedirect(ctx: RedirectContext, bridge: DesktopBridge): void {
  const openPath = bridge.openPath
  if (openPath === undefined) return
  const sidebarRight = ctx.sidebarRight
  if (sidebarRight === undefined || typeof sidebarRight.openResource !== 'function') return
  const original = sidebarRight.openResource.bind(sidebarRight)
  sidebarRight.openResource = (address: string, options?: unknown) => {
    const path = absoluteFileFromAddress(address, (id) => cwdOf(ctx, id))
    if (path === undefined) return original(address, options)
    void openPath(path)
      .then((handled) => {
        if (!handled) original(address, options)
      })
      .catch(() => original(address, options))
    return undefined
  }
}
