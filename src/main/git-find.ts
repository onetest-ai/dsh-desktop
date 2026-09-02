import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { runGit } from './git-run'

/** Directories never worth descending into, whatever they hold. */
const SKIP = new Set(['node_modules', '.git'])

/**
 * The repositories in a project.
 *
 * The project itself, plus one level below it. One level is VS Code's own
 * default and it covers what prompted scanning at all — a project holding
 * several checkouts — while a deeper walk wanders into vendored trees and
 * returns repositories nobody is working in.
 *
 * A `.git` that is a file rather than a directory is a worktree or a
 * submodule, and counts: `existsSync` is deliberately not a directory check.
 * @param root - the project directory.
 * @returns absolute paths, the root first when it is itself a repository.
 */
export function findRepos(root: string): string[] {
  const found: string[] = []
  if (existsSync(join(root, '.git'))) found.push(root)
  let entries: string[]
  try {
    entries = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !SKIP.has(entry.name))
      .map((entry) => entry.name)
  } catch {
    // A project that has gone away reads as no repositories, which is the
    // same thing from the panel's side.
    return found
  }
  for (const entry of entries) {
    if (existsSync(join(root, entry, '.git'))) found.push(join(root, entry))
  }
  return found
}

/**
 * Whether git can be run at all.
 *
 * Asked once at startup so the panel can say `git` is missing rather than
 * reporting every repository as broken.
 * @param gitPath - the binary to try; `git` from `PATH` by default.
 * @returns whether it ran.
 */
export async function hasGit(gitPath = 'git'): Promise<boolean> {
  return (await runGit(process.cwd(), ['--version'], gitPath)).code === 0
}
