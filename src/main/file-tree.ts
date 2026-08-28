import { readdirSync, realpathSync } from 'node:fs'
import { isAbsolute, join, resolve, sep } from 'node:path'

/** One entry in a directory listing. */
export interface TreeEntry {
  name: string
  directory: boolean
}

/**
 * Names never listed.
 *
 * Deliberately short. `.git` and `node_modules` are excluded because they are
 * enormous and nobody browses them here; `.DS_Store` because it is noise the
 * user did not create. Every other dotfile is shown — a project's `.dsh` and
 * `.env` are exactly what someone opens this tree to find.
 */
export const IGNORED = new Set(['.git', 'node_modules', '.DS_Store'])

/**
 * Resolve a path inside a root, or undefined when it escapes.
 *
 * Both sides are resolved through `realpath` before the comparison, so a
 * symlink pointing out of the project is refused even though its literal path
 * looks contained. The relative path arrives from the renderer and, later,
 * from the model — this is the check that keeps either from naming a file
 * outside the project it was given.
 * @param root - the project directory.
 * @param relative - the path within it, as `''` for the root itself.
 * @returns the resolved absolute path, or undefined when it is not inside the root.
 */
export function resolveInRoot(root: string, relative: string): string | undefined {
  // An absolute `relative` would silently replace the root in `resolve`,
  // which is the whole escape this refuses.
  if (isAbsolute(relative)) return undefined
  let target: string
  let realRoot: string
  try {
    realRoot = realpathSync(root)
    target = realpathSync(resolve(realRoot, relative))
  } catch {
    // A path that does not exist cannot be listed or read, and reporting it
    // as "outside the root" is the same refusal from the caller's side.
    return undefined
  }
  return target === realRoot || target.startsWith(realRoot + sep) ? target : undefined
}

/**
 * List one directory level inside a root.
 *
 * One level, not a walk: a tree that reads the whole project to draw its first
 * row would stall on any repository of size, and the renderer asks again as
 * the user opens each directory.
 *
 * Directories first, then files, each alphabetically and case-insensitively —
 * the order every file browser uses, and the one a user scans by.
 * @param root - the project directory.
 * @param relative - the directory within it, `''` for the root itself.
 * @returns the entries, or an empty list when the path escapes the root, does
 *   not exist, or cannot be read.
 */
export function readDirectory(root: string, relative: string): TreeEntry[] {
  const target = resolveInRoot(root, relative)
  if (target === undefined) return []
  let entries: TreeEntry[]
  try {
    entries = readdirSync(target, { withFileTypes: true })
      .filter((entry) => !IGNORED.has(entry.name))
      .map((entry) => ({
        name: entry.name,
        // A symlink to a directory is browsable like one; `resolveInRoot` is
        // what decides whether its target may be opened at all.
        directory: entry.isDirectory() || (entry.isSymbolicLink() && isDirectory(join(target, entry.name))),
      }))
  } catch {
    // An unreadable directory is a permission problem the user can see in
    // Finder; an empty list is the honest rendering of what this app can show.
    return []
  }
  entries.sort((left, right) => {
    if (left.directory !== right.directory) return left.directory ? -1 : 1
    return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })
  })
  return entries
}

/**
 * Whether a path resolves to a directory.
 * @param path - the path to check.
 * @returns true when it is a directory, false when it is not or cannot be read.
 */
function isDirectory(path: string): boolean {
  try {
    return readdirSync(path, { withFileTypes: true }) !== undefined
  } catch {
    // Not a directory, or unreadable — both mean "do not offer to expand it".
    return false
  }
}
