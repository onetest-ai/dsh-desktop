/** A service whose native "open a workspace path" this app redirects. */
export interface DesktopOpenTarget {
  openPath?: (path: string, signal?: AbortSignal) => Promise<unknown>
}

/**
 * Parse the shell's open-endpoint port out of the value it sets in the harness
 * child's environment.
 *
 * Anything that is not a plain TCP port — absent (the plugin is running outside
 * this app), empty, non-numeric, zero, negative, fractional, or above 65535 —
 * yields undefined, which leaves the native opener in place. This is what keeps
 * the plugin inert everywhere except inside this app, matching the browser
 * half's "bridge absent, do nothing" behavior.
 * @param value - the raw environment value, if any.
 * @returns the port, or undefined when it is not a usable one.
 */
export function resolveOpenPort(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined
  return port
}

/**
 * Build the `forward` an override uses to hand a path to the desktop shell.
 *
 * The shell runs a loopback endpoint whose port it passes to this plugin at
 * boot. A `200` means the shell placed the file in one of its panes; any other
 * answer (`204` for a path it will not place, or an error) means the caller
 * should fall back to the native opener.
 * @param port - the shell's loopback open endpoint port.
 * @param fetchImpl - the HTTP carrier; injectable for tests.
 * @returns a forwarder resolving true only when the shell handled the path.
 */
export function shellForwarder(port: number, fetchImpl: typeof fetch = fetch): (path: string) => Promise<boolean> {
  return async (path) => {
    const response = await fetchImpl(`http://127.0.0.1:${port}/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path }),
    })
    return response.status === 200
  }
}

/**
 * Redirect the harness's native "open a workspace file" into the desktop shell.
 *
 * The harness opens a declared file by shelling out (`open <path>` on macOS),
 * which for an `.html` deliverable lands in the system browser — outside this
 * app entirely. This replaces the `sessionController`'s `openPath` with one that
 * hands the path to the shell (which puts it in this app's own editor or web
 * pane) and falls back to the original native opener whenever the shell cannot
 * place it: a path outside any project the app has opened, a directory, or the
 * shell being unreachable. Only `openPath` is touched — `revealPath` (Reveal in
 * Finder) and `canOpenPath` are left native, so the route stays enabled.
 * @param target - the service carrying the native opener; a no-op when it has none.
 * @param forward - hands the path to the shell, resolving true when the shell
 *   opened it and false when the caller should fall back to the native opener.
 */
export function redirectOpenToDesktop(
  target: DesktopOpenTarget,
  forward: (path: string) => Promise<boolean>,
): void {
  const native = target.openPath
  if (native === undefined) return
  target.openPath = async (path, signal) => {
    let handled = false
    try {
      handled = await forward(path)
    } catch {
      // The shell is this app's own loopback endpoint; if it is unreachable or
      // errors, the file must still open, so fall through to the native opener.
      handled = false
    }
    if (handled) return undefined
    return native.call(target, path, signal)
  }
}
