import { isAbsolute, relative as relativeTo, resolve, sep } from 'node:path'

/** A file located inside one of the projects the harness has opened. */
export interface Located {
  root: string
  relative: string
}

/**
 * Find which project a path belongs to.
 *
 * The agent names files by absolute path — it knows its own working
 * directory — so this is where such a path becomes a project plus a path
 * within it, and where a path belonging to no project is refused. The longest
 * matching root wins, so a project nested inside another resolves to the
 * nearer one.
 * @param path - the absolute path the tool was given.
 * @param roots - the projects the harness has opened.
 * @returns the project and the path within it, or undefined.
 */
export function locate(path: string, roots: string[]): Located | undefined {
  if (!isAbsolute(path)) return undefined
  const target = resolve(path)
  const matches = roots
    .filter((root) => target === resolve(root) || target.startsWith(resolve(root) + sep))
    .sort((left, right) => right.length - left.length)
  if (matches.length === 0) return undefined
  return { root: matches[0], relative: relativeTo(resolve(matches[0]), target) }
}

/**
 * Whether a URL may be loaded in the web view.
 *
 * `http` and `https` only. Every other scheme either reaches the local
 * filesystem (`file:`), runs script in the page (`javascript:`), or carries
 * its own payload (`data:`) — none of which is a page the agent should be
 * able to put in front of the user unannounced.
 * @param url - the URL the tool was given.
 * @returns whether it may be loaded.
 */
export function loadableUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    // Not a URL at all, which is the same refusal from the caller's side.
    return false
  }
}
