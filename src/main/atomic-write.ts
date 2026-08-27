import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Write a file so no reader ever sees it half-written.
 *
 * `writeFileSync` truncates the target and then fills it, so anything reading
 * during that window gets a partial file. For this app's config files that is
 * not a rare theoretical race: the harness child reads `mcp.json` at boot,
 * this app rewrites `desktop.json` whenever a column moves, and a truncated
 * `desktop.json` reads as a broken configuration — which opens Settings and,
 * if that window is closed, quits the app.
 *
 * The temp file is created in the target's own directory so the rename stays
 * within one filesystem, where it is atomic.
 * @param filePath - the file to write.
 * @param contents - what to write.
 * @param mode - file mode to set, for files that must stay owner-only.
 */
export function writeFileAtomic(filePath: string, contents: string, mode?: number): void {
  const directory = dirname(filePath)
  mkdirSync(directory, { recursive: true })
  // Named for the process rather than randomly: two writers in one process are
  // serialized by the event loop, and a leftover from a crash is overwritten
  // by the next write rather than accumulating.
  const temporary = join(directory, `.${filePath.split('/').pop() ?? 'file'}.${String(process.pid)}.tmp`)
  try {
    writeFileSync(temporary, contents, mode === undefined ? undefined : { mode })
    // Set again after the write: an existing temp file keeps its own mode.
    if (mode !== undefined) chmodSync(temporary, mode)
    renameSync(temporary, filePath)
  } catch (error) {
    // A failed write must not leave the temp file behind to be mistaken for
    // real state, or to shadow the next attempt.
    try {
      rmSync(temporary, { force: true })
    } catch {
      // Nothing more to do: the original error is the one worth reporting.
    }
    throw error
  }
}
