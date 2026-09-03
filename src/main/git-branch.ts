import type { ActionOutcome } from './git-actions'
import { runGit } from './git-run'

/** One branch, as the menu draws it. */
export interface BranchView {
  name: string
  /** What it tracks, or empty when it tracks nothing. */
  upstream: string
  current: boolean
  /** Whether it is a remote-tracking branch rather than a local one. */
  remote: boolean
}

/** How the branch list is asked for, tab-separated so a name may hold spaces. */
const FORMAT = '%(refname:short)%09%(upstream:short)%09%(HEAD)'

/**
 * Read `git branch --list --all --format=…`.
 *
 * Pure, and given bytes: a branch name is bytes a ref accepted rather than
 * anything guaranteed to be text. Tab-separated because a branch name may
 * contain spaces and the fields must still be told apart.
 * @param stdout - what git wrote.
 * @returns the branches, in the order git listed them.
 */
export function parseBranches(stdout: Buffer): BranchView[] {
  return stdout
    .toString('utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const [name, upstream, head] = line.split('\t')
      return { name, upstream: upstream ?? '', current: head === '*', remote: name.includes('/') }
    })
    // `--all` lists the remote's HEAD pointer, which is not a branch anyone
    // checks out and reads as a nonsense entry at the top of the menu.
    .filter((branch) => !branch.name.endsWith('/HEAD'))
}

/**
 * The branches in a repository, local and remote-tracking.
 * @param repo - the repository.
 * @param run - how to run git; injected so tests spawn nothing.
 * @returns the branches, or none when git refused.
 */
export async function listBranches(repo: string, run: typeof runGit = runGit): Promise<BranchView[]> {
  const out = await run(repo, ['branch', '--list', '--all', `--format=${FORMAT}`])
  return out.code === 0 ? parseBranches(out.stdout) : []
}

/** The line git prints before naming the files a checkout would overwrite. */
const BLOCKED_BY = 'would be overwritten by checkout'

/**
 * The files git said were in the way of a checkout.
 *
 * They are the content of the offer to stash: an offer that cannot say what
 * it would stash is a shrug with a button on it. Git indents each one with a
 * tab under a sentence naming the problem.
 * @param stderr - what git wrote.
 * @returns the paths, or undefined when this was not that failure.
 */
function blockedFiles(stderr: string): string[] | undefined {
  if (!stderr.includes(BLOCKED_BY)) return undefined
  const paths = stderr
    .split('\n')
    .filter((line) => line.startsWith('\t'))
    .map((line) => line.slice(1).trim())
  return paths.length === 0 ? undefined : paths
}

/**
 * Switch to a branch, attempting it rather than preventing it.
 *
 * Git carries uncommitted changes across whenever they do not collide, which
 * is most of the time — refusing while anything is uncommitted would make
 * the branch list useless exactly when it is reached for. When git does
 * refuse, the files it names come back so the caller can offer to stash
 * them.
 * @param repo - the repository.
 * @param name - the branch to switch to.
 * @param run - how to run git.
 * @returns success, or the failure and what blocked it.
 */
export async function checkout(
  repo: string,
  name: string,
  run: typeof runGit = runGit,
): Promise<ActionOutcome & { blocked?: string[] }> {
  const out = await run(repo, ['checkout', name])
  if (out.code === 0) return { ok: true }
  const blocked = blockedFiles(out.stderr)
  const reason = out.stderr.split('\n')[0].trim() || 'git failed without saying why.'
  return blocked === undefined ? { ok: false, reason } : { ok: false, reason, blocked }
}

/**
 * Create a branch from where you are, and switch to it.
 *
 * Only a blank name is refused here. Git's own rules for a ref name are long
 * and it enforces them itself; reimplementing them would drift.
 * @param repo - the repository.
 * @param name - the branch to create.
 * @param run - how to run git.
 * @returns success, or why not.
 */
export async function createBranch(repo: string, name: string, run: typeof runGit = runGit): Promise<ActionOutcome> {
  if (name.trim() === '') return { ok: false, reason: 'Name the branch first.' }
  const out = await run(repo, ['checkout', '-b', name])
  return out.code === 0 ? { ok: true } : { ok: false, reason: out.stderr.split('\n')[0].trim() }
}
