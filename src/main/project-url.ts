import { resolveInRoot } from './file-tree'

/** The scheme host this app serves project files from. */
export const PROJECT_HOST = 'project'

/**
 * The URL a page uses to show one project file.
 *
 * The project's own path is in the URL rather than an index into a list: an
 * index would move when the harness opened another project, and a page
 * holding a stale one would show the wrong file.
 * @param origin - the app's scheme origin.
 * @param root - the project directory.
 * @param relative - the file's path within it.
 * @returns the URL.
 */
export function projectFileUrl(origin: string, root: string, relative: string): string {
  const url = new URL(origin)
  url.host = PROJECT_HOST
  url.pathname = `/${encodeURIComponent(root)}/${relative.split('/').map(encodeURIComponent).join('/')}`
  return url.toString()
}

/**
 * The file one such URL names, or undefined when it names none.
 *
 * The root must be a project the harness has opened and the file must resolve
 * inside it — the same rule every other read follows, applied here because
 * this scheme is reachable from any page this app loads.
 * @param pathname - the URL's path.
 * @param roots - the projects the harness has opened.
 * @returns the absolute path to serve, or undefined.
 */
export function projectFilePath(pathname: string, roots: string[]): string | undefined {
  const [, encodedRoot, ...rest] = pathname.split('/')
  if (encodedRoot === undefined || rest.length === 0) return undefined
  let root: string
  let relative: string
  try {
    root = decodeURIComponent(encodedRoot)
    relative = rest.map(decodeURIComponent).join('/')
  } catch {
    // A malformed escape is not a path this app serves.
    return undefined
  }
  if (!roots.includes(root)) return undefined
  return resolveInRoot(root, relative)
}
