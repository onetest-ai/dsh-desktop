import type { Context } from '@deepseek-ai/cordis'
import { redirectOpenToDesktop, resolveOpenPort, shellForwarder, type DesktopOpenTarget } from './open-in-desktop.ts'

/**
 * Required service: the session controller, whose native "open a workspace
 * file" this plugin redirects into the desktop app's own panes.
 */
export const inject = ['sessionController']

/**
 * Node half: redirect the harness's native file opens into the desktop app.
 *
 * The harness opens a declared file by shelling out (`open <path>`), which
 * sends an `.html` deliverable to the system browser — outside this app. When
 * this app launched the harness it put its loopback open-endpoint port in the
 * child's environment; reading it here is also how the plugin stays inert
 * anywhere else (no port, no redirect), the same way the browser half does
 * nothing without this app's preload bridge. See `redirectOpenToDesktop` for
 * what is swapped and what is left native.
 * @param ctx - the plugin context, carrying the injected `sessionController`.
 */
export function apply(ctx: Context): void {
  const port = resolveOpenPort(process.env.DSH_DESKTOP_OPEN_PORT)
  if (port === undefined) return
  const sessionController = (ctx as unknown as { sessionController?: DesktopOpenTarget }).sessionController
  if (sessionController === undefined) return
  redirectOpenToDesktop(sessionController, shellForwarder(port))
}
