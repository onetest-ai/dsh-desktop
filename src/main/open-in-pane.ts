import { isAbsolute, relative as relativePath } from 'node:path'

/**
 * What placing a harness-opened file in one of this app's panes needs.
 *
 * Every dependency is injected so the routing is pure and testable: the real
 * wiring passes the app's project list, its project-file resolver, and its two
 * pane-open calls.
 */
export interface OpenInPaneDeps {
  /** The roots of the projects the harness has opened. */
  roots: () => string[]
  /** The real, in-root file the pair names, or undefined when it escapes the root. */
  resolve: (root: string, relative: string) => string | undefined
  /** Whether the web view renders this name as a page rather than showing source. */
  isWebPage: (name: string) => boolean
  /** The `file:` URL for a web page in a project, or undefined when it may not be shown. */
  webPageUrl: (root: string, relative: string) => string | undefined
  /** Show a file in the editor column (Monaco, or a tab for an image/video). */
  openEditor: (root: string, relative: string) => void
  /** Show a rendered page in the web view. */
  openWeb: (url: string) => void
}

/** A path located inside one of the app's projects. */
interface Located {
  root: string
  relative: string
}

/**
 * Find the project that contains an absolute path and its path within it.
 *
 * Lexical containment picks the candidate root; `resolve` then confirms the
 * file really lives inside that root's real directory (rejecting a `..` or a
 * symlink that climbs out), so a caller only ever acts on a verified pair.
 */
function locate(deps: OpenInPaneDeps, absolutePath: string): Located | undefined {
  for (const root of deps.roots()) {
    const relative = relativePath(root, absolutePath)
    if (relative === '' || relative.startsWith('..') || isAbsolute(relative)) continue
    if (deps.resolve(root, relative) === undefined) continue
    return { root, relative }
  }
  return undefined
}

/**
 * Open an absolute path in one of this app's panes.
 *
 * A web page (`.html`/`.htm`) goes to the web view rendered; everything else
 * goes to the editor column, which shows text in Monaco and an image or video
 * in a tab of its own. Returns whether the file was placed: a path inside no
 * open project, or a web page that may not be shown, is left unhandled so the
 * caller can fall back to the harness's native opener.
 * @param deps - the app's project list, resolver, and pane-open calls.
 * @param absolutePath - the host-verified file path from the harness.
 * @returns true when a pane took the file; false when the caller should fall back.
 */
export function openPathInPane(deps: OpenInPaneDeps, absolutePath: string): boolean {
  const located = locate(deps, absolutePath)
  if (located === undefined) return false
  const { root, relative } = located
  if (deps.isWebPage(relative)) {
    const url = deps.webPageUrl(root, relative)
    if (url === undefined) return false
    deps.openWeb(url)
    return true
  }
  deps.openEditor(root, relative)
  return true
}
