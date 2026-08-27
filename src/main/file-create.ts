import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { resolveInRoot } from './file-tree'

/** The outcome of creating something in a project. */
export type CreateResult = { ok: true; relative: string } | { ok: false; reason: string }

/**
 * Names that cannot be created, whatever the rest of the path says.
 *
 * `.` and `..` are path syntax rather than names, and an empty segment is a
 * double slash — none of them names a file the user meant to make.
 */
const RESERVED = new Set(['', '.', '..'])

/**
 * Check one relative path and resolve where it would go.
 *
 * The parent must already exist inside the project: creating a file also
 * creating three directories on the way is a typo doing more than the user
 * asked. A directory creates only itself, for the same reason.
 * @param root - the project directory.
 * @param relative - the path to create within it.
 * @returns the absolute path, or why it was refused.
 */
function target(root: string, relative: string): { path: string } | { reason: string } {
  if (isAbsolute(relative)) return { reason: 'Give a name, not an absolute path.' }
  const segments = relative.split('/')
  if (segments.some((segment) => RESERVED.has(segment))) return { reason: 'That is not a usable name.' }
  if (segments.some((segment) => segment.includes('\0'))) return { reason: 'That is not a usable name.' }

  const parent = resolveInRoot(root, segments.slice(0, -1).join('/'))
  if (parent === undefined) return { reason: 'That folder is not in the project.' }
  const path = join(parent, segments[segments.length - 1])
  // Resolved again after joining: a name is one segment, and anything that
  // climbs out of the parent is not one.
  if (resolve(path) !== path || !path.startsWith(parent + sep)) return { reason: 'That is not a usable name.' }
  if (existsSync(path)) return { reason: 'Something with that name is already there.' }
  return { path }
}

/**
 * Create an empty file in a project.
 * @param root - the project directory.
 * @param relative - the file's path within it.
 * @returns where it was created, or why it was not.
 */
export function createFile(root: string, relative: string): CreateResult {
  const where = target(root, relative)
  if ('reason' in where) return { ok: false, reason: where.reason }
  try {
    // `wx`: two creations racing must not have one silently overwrite the
    // other, and the existence check above cannot rule that out on its own.
    writeFileSync(where.path, '', { flag: 'wx' })
  } catch (error) {
    return { ok: false, reason: (error as Error).message }
  }
  return { ok: true, relative }
}

/**
 * Create a directory in a project.
 * @param root - the project directory.
 * @param relative - the directory's path within it.
 * @returns where it was created, or why it was not.
 */
export function createFolder(root: string, relative: string): CreateResult {
  const where = target(root, relative)
  if ('reason' in where) return { ok: false, reason: where.reason }
  try {
    mkdirSync(where.path)
  } catch (error) {
    return { ok: false, reason: (error as Error).message }
  }
  return { ok: true, relative }
}

/**
 * The directory a new entry belongs in, given what is selected in the tree.
 *
 * Selecting a file means "beside this one", which is what every editor does:
 * the new entry goes in that file's directory rather than inside the file.
 * @param selected - the selected entry's path within the project, or '' for the root.
 * @param directory - whether that entry is a directory.
 * @returns the directory to create in, as a path within the project.
 */
export function creationParent(selected: string, directory: boolean): string {
  if (selected === '') return ''
  return directory ? selected : dirname(selected) === '.' ? '' : dirname(selected)
}
