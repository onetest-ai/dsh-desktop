import type { ActionOutcome } from './git-actions'
import { firstLine } from './git-actions'
import { runGit } from './git-run'

/** One stash entry, as the panel lists it. */
export interface StashView {
  /** `stash@{0}` and so on — what every other stash command takes. */
  ref: string
  /** The branch it was made on. */
  branch: string
  /** What it was called, or what git called it when it was not named. */
  message: string
}

/** How the list is asked for: the ref, a tab, and the reflog subject. */
const FORMAT = '%gd%x09%gs'

/**
 * Read `git stash list --format=…`.
 *
 * The subject is `On <branch>: <message>`, or `WIP on <branch>: …` when the
 * stash was pushed without one. Split on the FIRST colon only: a message
 * like `fix: the thing` is ordinary, and splitting on all of them reports
 * the wrong branch for every stash anyone names that way.
 * @param stdout - what git wrote.
 * @returns the stashes, newest first, as git lists them.
 */
export function parseStashes(stdout: Buffer): StashView[] {
  return stdout
    .toString('utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const [ref, subject = ''] = line.split('\t')
      const at = subject.indexOf(':')
      const head = at === -1 ? '' : subject.slice(0, at)
      const branch = head.replace(/^WIP on /, '').replace(/^On /, '')
      return { ref, branch, message: at === -1 ? subject : subject.slice(at + 1).trim() }
    })
}

/**
 * The stashes in a repository.
 * @param repo - the repository.
 * @param run - how to run git.
 * @returns the stashes, or none when git refused.
 */
export async function listStashes(repo: string, run: typeof runGit = runGit): Promise<StashView[]> {
  const out = await run(repo, ['stash', 'list', `--format=${FORMAT}`])
  return out.code === 0 ? parseStashes(out.stdout) : []
}

/**
 * Stash the working tree.
 *
 * A clean tree makes git print "No local changes to save" and exit zero, so
 * success alone would leave the user believing a stash exists that does not.
 * @param repo - the repository.
 * @param message - what to call it; blank pushes without one.
 * @param run - how to run git.
 * @returns success, or why nothing was stashed.
 */
export async function pushStash(repo: string, message: string, run: typeof runGit = runGit): Promise<ActionOutcome> {
  const args = message.trim() === '' ? ['stash', 'push'] : ['stash', 'push', '-m', message]
  const out = await run(repo, args)
  if (out.code !== 0) return { ok: false, reason: firstLine(out.stderr) }
  if (out.stdout.toString('utf8').includes('No local changes to save')) {
    return { ok: false, reason: 'There is nothing to stash.' }
  }
  return { ok: true }
}

/**
 * Put a stash back, keeping it or removing it.
 * @param repo - the repository.
 * @param ref - the stash, as `stash@{n}`.
 * @param pop - true to remove it once applied.
 * @param run - how to run git.
 * @returns success, or why not — a conflicting pop is a failure, since it
 *   leaves the stash in place and the tree half-merged.
 */
export async function applyStash(
  repo: string,
  ref: string,
  pop: boolean,
  run: typeof runGit = runGit,
): Promise<ActionOutcome> {
  const out = await run(repo, ['stash', pop ? 'pop' : 'apply', ref])
  return out.code === 0 ? { ok: true } : { ok: false, reason: firstLine(out.stderr) }
}

/**
 * Throw a stash away.
 * @param repo - the repository.
 * @param ref - the stash to drop.
 * @param run - how to run git.
 * @returns success, or why not.
 */
export async function dropStash(repo: string, ref: string, run: typeof runGit = runGit): Promise<ActionOutcome> {
  const out = await run(repo, ['stash', 'drop', ref])
  return out.code === 0 ? { ok: true } : { ok: false, reason: firstLine(out.stderr) }
}
