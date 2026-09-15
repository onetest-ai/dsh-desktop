import { existsSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'

/** Where a project keeps its architecture diagrams, beside the board's own directory. */
export const ARCH_DIR = join('.dsh', 'arch')

/**
 * The arch directory of one project.
 *
 * Computed, never created. A project with no diagrams is a state to report —
 * a plugin that made a directory in someone's repository because it loaded
 * would be writing to a working tree nobody asked it to touch.
 * @param project - the project's root directory.
 * @returns the arch directory, whether or not it exists.
 */
export function archRoot(project: string): string {
  return join(project, ARCH_DIR)
}

/**
 * Realpath every ancestor that exists, keeping the rest as written.
 *
 * A path being *created* has no realpath of its own, but its parents do — and
 * a symlinked parent is exactly how a write escapes a fence that only checked
 * the final component.
 * @param target - an absolute, already lexically-resolved path.
 * @returns the path with every existing ancestor realpathed.
 */
export function realpathAsFarAsExists(target: string): string {
  const pending: string[] = []
  let at = target
  while (!existsSync(at)) {
    const parent = dirname(at)
    if (parent === at) break // the filesystem root, without finding anything real
    pending.unshift(basename(at))
    at = parent
  }
  const real = realpathSync(at)
  return pending.length === 0 ? real : join(real, ...pending)
}

/**
 * The shared fence. Both boundaries are this function with a different base.
 *
 * The check is against the resolved real path, never the string. A symlink
 * inside the fence pointing out of it defeats any comparison of text, and
 * `..` is the same attack spelled differently. Refusal is `undefined` rather
 * than a throw, so a caller handling one bad id among many does not need a
 * try/catch per item.
 * @param base - the directory nothing may escape.
 * @param relative - the caller-supplied path, relative to `base`.
 * @returns the real absolute path, or undefined when it leaves the fence.
 */
function resolveUnder(base: string, relative: string): string | undefined {
  if (relative === '' || isAbsolute(relative)) return undefined
  const target = resolve(base, relative)
  const real = realpathAsFarAsExists(target)
  const root = realpathAsFarAsExists(base)
  // The fence root is not addressable: nothing legitimate names it, and a
  // caller reaching here with `.` is asking to write over the directory.
  if (real === root) return undefined
  if (!real.startsWith(root + sep)) return undefined
  return real
}

/**
 * Turn an agent- or renderer-supplied path into a real path inside `.dsh/arch`,
 * or refuse it. The security boundary for every diagram, layout and icon this
 * plugin writes.
 * @param project - the workspace root.
 * @param relative - the path, relative to the arch directory.
 * @returns the real absolute path, or undefined when refused.
 */
export function resolveInArch(project: string, relative: string): string | undefined {
  return resolveUnder(archRoot(project), relative)
}

/**
 * The same boundary, one fence wider: bounded to the workspace root rather
 * than the arch directory.
 *
 * `iconPaths` name folders elsewhere in the project (`docs/icons`), which
 * `resolveInArch` cannot govern. Widening that function with a flag would put
 * one `if` between a caller and the wrong fence; a second named export makes
 * the wider grant visible at every call site.
 * @param project - the workspace root.
 * @param relative - the path, relative to the workspace root.
 * @returns the real absolute path, or undefined when refused.
 */
export function resolveInWorkspace(project: string, relative: string): string | undefined {
  return resolveUnder(project, relative)
}
