import { existsSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import type { EntityKind } from './entity-schema'

/** Where a project keeps its board, beside the `mcp.json` it may already carry. */
export const BOARD_DIR = join('.dsh', 'tasks')

/** Where a deleted entity goes. Never read as part of the board. */
export const TRASH_DIR = '.trash'

/**
 * The board directory of one project.
 *
 * Computed, never created. A project with no board is a state to report — a
 * view that made a directory in someone's repository because it was opened
 * would be writing to a working tree nobody asked it to touch.
 * @param project - the project's root directory.
 * @returns the board directory, whether or not it exists.
 */
export function boardRoot(project: string): string {
  return join(project, BOARD_DIR)
}

/**
 * Whether a project has a board at all.
 * @param project - the project's root directory.
 * @returns true when the board directory exists.
 */
export function hasBoard(project: string): boolean {
  try {
    return statSync(boardRoot(project)).isDirectory()
  } catch {
    return false
  }
}

/**
 * The folder path of an entity, from the slugs of it and its parents.
 *
 * The path is the entity's identity — there is no id file — so this is the one
 * place the shape of the tree is written down. A bug takes two parts when a
 * campaign owns it and three when a mission does, which is what "parented by
 * exactly one" looks like on disk.
 * @param kind - which kind the last slug names.
 * @param parts - the slugs from the campaign down, ending with this entity's.
 * @returns the folder path, relative to the board root, with forward slashes.
 */
export function folderFor(kind: EntityKind, parts: string[]): string {
  const [campaign, ...rest] = parts
  if (kind === 'campaign') return `campaigns/${campaign}`
  if (kind === 'mission') return `campaigns/${campaign}/missions/${rest[0]}`
  if (kind === 'task') return `campaigns/${campaign}/missions/${rest[0]}/tasks/${rest[1]}`
  // A bug under a campaign has one slug after it; one under a mission has two.
  if (rest.length === 1) return `campaigns/${campaign}/bugs/${rest[0]}`
  return `campaigns/${campaign}/missions/${rest[0]}/bugs/${rest[1]}`
}

/**
 * Resolve a path through symlinks as far as the filesystem allows, then apply
 * whatever segments do not exist yet on top of that, lexically.
 *
 * `realpathSync` throws on a path that is not there, and `createEntity` only
 * ever calls this on a target that does not exist yet — so realpathing "where
 * it exists" and falling back to the lexical string otherwise resolves
 * nothing, ever, for the path that matters. The symlink that escapes the
 * board can also sit several directories above the target (a campaign whose
 * `missions/` is a symlink, with the mission itself still to be created), so
 * realpathing just the immediate parent is not enough either — this walks up
 * to whichever ancestor genuinely exists.
 * @param target - an absolute, already lexically-resolved path.
 * @returns the path with every existing ancestor realpathed.
 */
function realpathAsFarAsExists(target: string): string {
  const pending: string[] = []
  let at = target
  while (!existsSync(at)) {
    const parent = dirname(at)
    if (parent === at) break // reached the filesystem root without finding anything real
    pending.unshift(basename(at))
    at = parent
  }
  const real = realpathSync(at)
  return pending.length === 0 ? real : join(real, ...pending)
}

/**
 * Turn a folder path into a real directory, or refuse it.
 *
 * The security boundary of this module. A folder path reaches here from the
 * agent's tools, and what comes back is a directory this app writes into and
 * moves to the trash — so the check is against the resolved real path, not the
 * string. A symlink inside the board pointing outside it defeats any check
 * that only compares text, and `..` is the same attack spelled differently.
 * Both the target and the board root are resolved the same way, so a project
 * whose own checkout sits under a symlink (routine on `/tmp`, an external
 * volume, or a symlinked code directory) does not make every folder inside it
 * disagree with the root it is compared against.
 *
 * The trash is refused as well. It holds folders that were deleted; acting on
 * one would resurrect an entity through a path the board no longer lists.
 * @param project - the project's root directory.
 * @param folderPath - the path within the board, as the board reports it.
 * @returns the absolute directory, or nothing when it is not inside the board.
 */
export function resolveInBoard(project: string, folderPath: string): string | undefined {
  if (folderPath === '' || isAbsolute(folderPath)) return undefined
  const root = boardRoot(project)
  const target = resolve(root, folderPath)
  const real = realpathAsFarAsExists(target)
  const base = realpathAsFarAsExists(root)
  if (real !== base && !real.startsWith(base + sep)) return undefined
  if (real === join(base, TRASH_DIR) || real.startsWith(join(base, TRASH_DIR) + sep)) return undefined
  return real
}
