import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { resolveInRoot } from './file-tree'

/** A file the pane may edit, or why it may not. */
export type FileRead = { ok: true; text: string } | { ok: false; reason: string }

/** The outcome of a save. */
export type FileWrite = { ok: true } | { ok: false; reason: string }

/**
 * The largest file the editor will open.
 *
 * CodeMirror holds the whole document in memory and re-highlights it; past a
 * few megabytes that stops being an editor and starts being a hang. A file
 * this size is a log or a dump, which the user has better tools for.
 */
export const MAX_EDITABLE_BYTES = 2_000_000

/** How much of a file is examined to decide whether it is text. */
const SNIFF_BYTES = 8_192

/**
 * Read a file for the editor.
 *
 * Rooted in a project exactly as the tree is: the relative path arrives from
 * the renderer and from the model, and `resolveInRoot` is the check that
 * keeps either from naming a file outside the project.
 * @param root - the project directory.
 * @param relative - the file's path within it.
 * @returns its text, or why it cannot be edited.
 */
export function readTextFile(root: string, relative: string): FileRead {
  const target = resolveInRoot(root, relative)
  if (target === undefined) return { ok: false, reason: 'That file is not inside the project.' }
  let size: number
  try {
    const stats = statSync(target)
    if (stats.isDirectory()) return { ok: false, reason: 'That is a directory.' }
    size = stats.size
  } catch (error) {
    return { ok: false, reason: (error as Error).message }
  }
  if (size > MAX_EDITABLE_BYTES) {
    return { ok: false, reason: `That file is ${Math.round(size / 1_000_000)}MB — too large to open here.` }
  }
  let buffer: Buffer
  try {
    buffer = readFileSync(target)
  } catch (error) {
    return { ok: false, reason: (error as Error).message }
  }
  // A NUL byte in the first pages is what every editor uses to tell a binary
  // from text, and it is what keeps an image from being rendered as mojibake
  // the user could then save back over the original.
  if (buffer.subarray(0, SNIFF_BYTES).includes(0)) return { ok: false, reason: 'That file is not text.' }
  return { ok: true, text: buffer.toString('utf8') }
}

/**
 * Save a file the editor opened.
 *
 * Only over a file that already exists: `resolveInRoot` resolves through the
 * filesystem, so a path with no file behind it is refused. Creating files is
 * the agent's job, not this pane's.
 * @param root - the project directory.
 * @param relative - the file's path within it.
 * @param text - the new contents.
 * @returns ok, or why nothing was written.
 */
export function writeTextFile(root: string, relative: string, text: string): FileWrite {
  const target = resolveInRoot(root, relative)
  if (target === undefined) return { ok: false, reason: 'That file is not inside the project.' }
  try {
    if (statSync(target).isDirectory()) return { ok: false, reason: 'That is a directory.' }
    writeFileSync(target, text, 'utf8')
  } catch (error) {
    return { ok: false, reason: (error as Error).message }
  }
  return { ok: true }
}
