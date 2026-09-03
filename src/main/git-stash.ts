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
 * Stash the working tree, and name what was created.
 *
 * A clean tree makes git print "No local changes to save" and exit zero, so
 * success alone would leave the user believing a stash exists that does not.
 *
 * The sha comes back because `stash@{0}` is a position, not an identity: it
 * means "whatever is on top of the stack right now". Anything else stashing
 * in the same repository — an agent running `git pull --rebase --autostash`
 * in the terminal panel, which this app exists to have running beside the
 * panel — pushes every entry down one, and a caller that later pops
 * `stash@{0}` would apply that agent's work, destroy its entry, and strand
 * the user's own. A sha is the only handle that cannot slide.
 *
 * Resolved with `rev-parse` immediately after the push rather than built with
 * `stash create` + `stash store`: `create` records a commit and does not
 * touch the working tree, so taking that route would mean reproducing what
 * `push` does to the tree — the reset, and the untracked and ignored cases —
 * by hand, which is exactly the divergence shelling out to git exists to
 * avoid. The window between the two commands is narrow but not zero, and it
 * is why `applyStash` re-resolves rather than trusting a sha to still be
 * where it was.
 * @param repo - the repository.
 * @param message - what to call it; blank pushes without one.
 * @param run - how to run git.
 * @returns success and the sha of the entry created, or why nothing was
 *   stashed. `ref` is absent when the stash was made but git would not name
 *   it, which a caller that needs to pop it again must treat as a stop.
 */
export async function pushStash(
  repo: string,
  message: string,
  run: typeof runGit = runGit,
): Promise<ActionOutcome & { ref?: string }> {
  const args = message.trim() === '' ? ['stash', 'push'] : ['stash', 'push', '-m', message]
  const out = await run(repo, args)
  if (out.code !== 0) return { ok: false, reason: firstLine(out.stderr) }
  if (out.stdout.toString('utf8').includes('No local changes to save')) {
    return { ok: false, reason: 'There is nothing to stash.' }
  }
  const found = await run(repo, ['rev-parse', 'stash@{0}'])
  const ref = found.stdout.toString('utf8').trim()
  // Still a success: the stash was made, and reporting a failure for it would
  // send the user looking for changes that are safely in the list.
  if (found.code !== 0 || ref === '') return { ok: true }
  return { ok: true, ref }
}

/** A stash named by its position in the stack rather than by its content. */
const POSITIONAL = /^stash@\{\d+\}$/

/** How the list is asked for when a sha has to be turned back into a ref. */
const BY_SHA = '%gd %H'

/**
 * Which `stash@{n}` currently holds one sha, if any.
 *
 * `git stash pop <sha>` is refused by git for anything that is not a stash
 * reflog entry, so the position has to be found even though the sha is the
 * thing being identified. Reading it here rather than trusting a position the
 * caller remembered is the whole point: between the two, the stack may have
 * moved.
 * @param repo - the repository.
 * @param sha - the entry's commit.
 * @param run - how to run git.
 * @returns the ref it is at now, or undefined when it is no longer listed.
 */
async function positionOf(repo: string, sha: string, run: typeof runGit): Promise<string | undefined> {
  const out = await run(repo, ['stash', 'list', `--format=${BY_SHA}`])
  if (out.code !== 0) return undefined
  for (const line of out.stdout.toString('utf8').split('\n')) {
    const [ref, hash] = line.split(' ')
    if (hash === sha) return ref
  }
  return undefined
}

/**
 * Put a stash back, keeping it or removing it.
 *
 * A sha is re-resolved to its position before anything is applied, and a sha
 * that is no longer in the list is refused rather than guessed at. Applying
 * the wrong entry is silent and unrecoverable — it puts someone else's work
 * in the tree and, for a pop, deletes their stash — so "it has moved" has to
 * be a refusal and not a fallback to `stash@{0}`.
 * @param repo - the repository.
 * @param ref - the stash, as `stash@{n}` or as the sha `pushStash` returned.
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
  let target = ref
  if (!POSITIONAL.test(ref)) {
    const at = await positionOf(repo, ref, run)
    if (at === undefined) return { ok: false, reason: `The stash ${ref} is no longer in the list; nothing was applied.` }
    target = at
  }
  const out = await run(repo, ['stash', pop ? 'pop' : 'apply', target])
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
