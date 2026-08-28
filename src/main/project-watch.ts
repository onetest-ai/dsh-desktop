import { watch, type FSWatcher } from 'node:fs'
import { sep } from 'node:path'
import { IGNORED } from './file-tree'

/** A running watch over one project. */
export interface ProjectWatch {
  /** Stop watching. */
  close(): void
}

/**
 * How long changes are collected before the tree is told.
 *
 * Writing a file produces several events, and a tool that rewrites a
 * directory produces one per entry; redrawing on each would make the tree
 * flicker through states nobody asked to see.
 */
export const SETTLE_MS = 150

/**
 * The directory a changed path sits in, or undefined when it is ignored.
 *
 * The tree lists directories, so a change to a file is a change to its
 * parent's listing. Anything under an ignored directory is dropped here
 * rather than at the listing: `node_modules` alone can emit tens of thousands
 * of events during an install, none of which the tree would draw.
 * @param filename - the changed path, relative to the project root, as the
 *   platform's watcher reports it.
 * @returns the directory's path within the root, `''` for the root itself, or
 *   undefined when the change is in a directory the tree never shows.
 */
export function changedDirectory(filename: string): string | undefined {
  const segments = filename.split(sep)
  // The last segment is the entry that changed; the ones before it are the
  // directories it is in, and an ignored name anywhere along that path means
  // the tree is not showing this change.
  if (segments.some((segment) => IGNORED.has(segment))) return undefined
  return segments.slice(0, -1).join('/')
}

/**
 * Watch a project and report which directories changed.
 *
 * Recursive, because the tree can have any directory open and a change the
 * user can see may be arbitrarily deep. The callback names a directory rather
 * than a file so the tree re-reads one listing; it fires only for directories
 * the tree could be showing.
 * @param root - the project directory.
 * @param onChanged - called with each directory's path within the root once
 *   changes have settled.
 * @returns the watch, or undefined when the platform or the directory will
 *   not support one.
 */
export function watchProject(root: string, onChanged: (relative: string) => void): ProjectWatch | undefined {
  const pending = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let watcher: FSWatcher
  try {
    watcher = watch(root, { recursive: true, persistent: false }, (_event, filename) => {
      // Some platforms report a change without saying what changed; the root
      // listing is the one thing that is always worth re-reading.
      const directory = filename === null ? '' : changedDirectory(filename.toString())
      if (directory === undefined) return
      pending.add(directory)
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = undefined
        const directories = [...pending]
        pending.clear()
        for (const each of directories) onChanged(each)
      }, SETTLE_MS)
      timer.unref?.()
    })
  } catch (error) {
    // A project on a filesystem that cannot be watched still browses; it just
    // shows what it read, and the user reopens the folder to see more.
    console.warn(`dsh-desktop: ${root} could not be watched for changes: ${(error as Error).message}`)
    return undefined
  }
  return {
    close: () => {
      if (timer !== undefined) clearTimeout(timer)
      watcher.close()
    },
  }
}
