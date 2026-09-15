import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/**
 * Write a file so no reader ever sees it half-written.
 *
 * `writeFileSync` truncates the target and then fills it, so anything reading
 * during that window gets a partial file. Here that window is not theoretical:
 * the canvas writes on every drag settle while the agent may be reading the
 * same diagram, and a truncated diagram reads as a corrupt one.
 *
 * The temp file is created in the target's own directory so the rename stays
 * within one filesystem, where it is atomic.
 * @param filePath - the file to write.
 * @param contents - text or bytes.
 */
export function writeFileAtomic(filePath: string, contents: string | Uint8Array): void {
  const directory = dirname(filePath)
  mkdirSync(directory, { recursive: true })
  // Named for the process rather than randomly: two writers in one process are
  // serialized by the event loop, and a leftover from a crash is overwritten by
  // the next write rather than accumulating.
  const temporary = join(directory, `.${basename(filePath)}.${String(process.pid)}.tmp`)
  try {
    writeFileSync(temporary, contents)
    renameSync(temporary, filePath)
  } catch (error) {
    // A failed write must not leave the temp file to be mistaken for real
    // state, or to shadow the next attempt.
    try {
      rmSync(temporary, { force: true })
    } catch {
      // Nothing more to do: the original error is the one worth reporting.
    }
    throw error
  }
}
