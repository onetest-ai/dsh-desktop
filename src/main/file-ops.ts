import { cpSync, existsSync, renameSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { resolveInRoot } from './file-tree'

/** The outcome of an operation on one entry. */
export type OpResult = { ok: true; relative: string } | { ok: false; reason: string }

/** Refusal for anything that does not name one entry inside the project. */
const NOT_A_NAME = 'That is not a usable name.'

/**
 * Resolve a name that is being created beside an existing entry.
 *
 * The name must be a single segment inside the given parent: these come from
 * the renderer, and a rename that could write `../` is a rename that can
 * leave the project.
 * @param parent - the absolute directory it goes in.
 * @param name - the single name segment.
 * @returns the absolute path, or undefined when the name is not one segment.
 */
function within(parent: string, name: string): string | undefined {
  if (name === '' || name === '.' || name === '..') return undefined
  if (name.includes('/') || name.includes('\0')) return undefined
  return join(parent, name)
}

/**
 * Rename one entry, keeping it where it is.
 * @param root - the project directory.
 * @param relative - the entry's current path within it.
 * @param name - the new name, one segment.
 * @returns the entry's new path, or why it did not move.
 */
export function renameEntry(root: string, relative: string, name: string): OpResult {
  const from = resolveInRoot(root, relative)
  if (from === undefined) return { ok: false, reason: 'That is not in the project.' }
  const to = within(dirname(from), name)
  if (to === undefined) return { ok: false, reason: NOT_A_NAME }
  if (existsSync(to)) return { ok: false, reason: 'Something with that name is already there.' }
  try {
    renameSync(from, to)
  } catch (error) {
    return { ok: false, reason: (error as Error).message }
  }
  const parent = dirname(relative)
  return { ok: true, relative: parent === '.' ? name : `${parent}/${name}` }
}

/**
 * Delete one entry, and everything inside it when it is a directory.
 *
 * The caller is expected to have asked first: this does not prompt, and there
 * is no undo — the entry does not go to the Trash, because a `rm` that
 * pretends to be recoverable is worse than one that does not.
 * @param root - the project directory.
 * @param relative - the entry's path within it.
 * @returns what was deleted, or why it was not.
 */
export function deleteEntry(root: string, relative: string): OpResult {
  const target = resolveInRoot(root, relative)
  if (target === undefined) return { ok: false, reason: 'That is not in the project.' }
  // The project itself is not something this deletes, however it was named.
  if (target === resolveInRoot(root, '')) return { ok: false, reason: 'That is the project itself.' }
  try {
    rmSync(target, { recursive: true, force: false })
  } catch (error) {
    return { ok: false, reason: (error as Error).message }
  }
  return { ok: true, relative }
}

/**
 * Copy or move one entry into a directory.
 *
 * A name already taken gets a suffix rather than a refusal or an overwrite:
 * pasting beside the original is the common case, and losing what is there
 * would be the worst possible answer.
 * @param root - the project directory.
 * @param relative - the entry's path within it.
 * @param intoRelative - the destination directory's path within it, '' for the root.
 * @param move - whether to move rather than copy.
 * @returns where it landed, or why it did not.
 */
export function pasteEntry(root: string, relative: string, intoRelative: string, move: boolean): OpResult {
  const from = resolveInRoot(root, relative)
  const into = resolveInRoot(root, intoRelative)
  if (from === undefined || into === undefined) return { ok: false, reason: 'That is not in the project.' }
  if (!statSync(into).isDirectory()) return { ok: false, reason: 'That is not a folder.' }
  // A directory cannot go inside itself or its own descendant: moving takes
  // the destination with it, and copying recurses forever. Refused here so
  // both answer the same way rather than one surfacing an fs error.
  if (into === from || into.startsWith(`${from}/`)) {
    return { ok: false, reason: `A folder cannot be ${move ? 'moved' : 'copied'} into itself.` }
  }
  const name = freeName(into, basename(from))
  const to = join(into, name)
  try {
    if (move) renameSync(from, to)
    else cpSync(from, to, { recursive: true, errorOnExist: true, force: false })
  } catch (error) {
    return { ok: false, reason: (error as Error).message }
  }
  return { ok: true, relative: intoRelative === '' ? name : `${intoRelative}/${name}` }
}

/**
 * A name free in that directory, adding ` copy` as many times as it takes.
 *
 * The suffix goes before the extension, so a copy of `notes.md` is
 * `notes copy.md` and still opens as markdown.
 * @param into - the absolute destination directory.
 * @param name - the name being brought in.
 * @returns a name nothing in that directory uses.
 */
function freeName(into: string, name: string): string {
  if (!existsSync(join(into, name))) return name
  const extension = extname(name)
  const stem = name.slice(0, name.length - extension.length)
  for (let attempt = 1; ; attempt += 1) {
    const candidate = `${stem} copy${attempt === 1 ? '' : ` ${String(attempt)}`}${extension}`
    if (!existsSync(join(into, candidate))) return candidate
  }
}
