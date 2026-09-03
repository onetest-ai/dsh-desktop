import type { ActionOutcome } from './git-actions'
import { firstLine } from './git-actions'
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

/** How the branch list is asked for. The full refname is what says whether a
    branch is remote — `refname:short` cannot, because a local `feature/thing`
    and a remote `origin/main` are both a name with a slash in it. */
const FORMAT = '%(refname)%09%(refname:short)%09%(upstream:short)%09%(HEAD)'

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
      const [refname, name, upstream, head] = line.split('\t')
      return { name, upstream: upstream ?? '', current: head === '*', remote: refname.startsWith('refs/remotes/') }
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

/**
 * Which of git's two "would be overwritten by checkout" refusals this was.
 *
 * They are not interchangeable, and the caller has to know which: `git stash
 * push` takes tracked changes only, so a stash offered for the untracked
 * refusal would take work nobody asked about, leave the files that actually
 * blocked the switch where they are, and hit the same refusal again.
 */
export type BlockedKind = 'tracked' | 'untracked'

/** The sentence git prints before naming tracked files in the way. */
const BLOCKED_TRACKED = 'Your local changes to the following files would be overwritten by checkout'

/** The sentence it prints before naming untracked ones. */
const BLOCKED_UNTRACKED = 'The following untracked working tree files would be overwritten by checkout'

/**
 * The files git said were in the way of a checkout, and which kind they are.
 *
 * They are the content of the offer to stash: an offer that cannot say what
 * it would stash is a shrug with a button on it. Git indents each one with a
 * tab under a sentence naming the problem.
 *
 * When both refusals appear — git prints one message per kind and can print
 * both — the untracked one wins, because it is the one an ordinary `stash
 * push` would not clear, and a stash that does not clear the block is a stash
 * the user never wanted.
 * @param stderr - what git wrote.
 * @returns the kind and the paths, or undefined when this was not that failure.
 */
function blockedFiles(stderr: string): { kind: BlockedKind; files: string[] } | undefined {
  const untracked = stderr.includes(BLOCKED_UNTRACKED)
  if (!untracked && !stderr.includes(BLOCKED_TRACKED)) return undefined
  const files = stderr
    .split('\n')
    .filter((line) => line.startsWith('\t'))
    .map((line) => line.slice(1).trim())
  return files.length === 0 ? undefined : { kind: untracked ? 'untracked' : 'tracked', files }
}

/**
 * Whether git would read this name as something other than a branch.
 *
 * The name comes from the renderer and lands in `checkout`'s ref position,
 * which has no `--` to hide behind. `git checkout -f` force-restores the
 * working tree from HEAD: every uncommitted change in the repository is gone,
 * with no dialog and nothing in the reflog to get it back from. `git checkout
 * .` does the same through the pathspec. Neither is a name git will let
 * anyone create a branch with, so refusing the shape costs nothing real —
 * and it is refused here rather than in the IPC handler so it holds for every
 * caller, not only the one that was thought of.
 * @param name - the name as it arrived.
 * @returns true when it must not be handed to git as a branch.
 */
function unsafeName(name: string): boolean {
  return name.startsWith('-') || name === '.' || name === '..'
}

/** What is said when a name would be read as an option or a pathspec. */
const NOT_A_NAME = 'That is not a branch name.'

/**
 * Switch to a branch, attempting it rather than preventing it.
 *
 * Git carries uncommitted changes across whenever they do not collide, which
 * is most of the time — refusing while anything is uncommitted would make
 * the branch list useless exactly when it is reached for. When git does
 * refuse, the files it names come back so the caller can offer to stash
 * them — with which of the two refusals it was, since the two need different
 * stashes to clear.
 *
 * For remote-tracking branches, uses `--track` to create the local branch
 * that follows it — what anyone picking `origin/feature` off a list means by
 * it. Plain checkout of a remote ref detaches HEAD, which is the whole reason
 * the flag exists.
 *
 * A name git would read as an option is refused before anything is spawned;
 * see `unsafeName` for what `git checkout -f` does to a working tree.
 * @param repo - the repository.
 * @param name - the branch to switch to.
 * @param remote - whether this is a remote-tracking branch.
 * @param run - how to run git.
 * @returns success, or the failure, what blocked it, and which kind of block.
 */
export async function checkout(
  repo: string,
  name: string,
  remote = false,
  run: typeof runGit = runGit,
): Promise<ActionOutcome & { blocked?: string[]; blockedKind?: BlockedKind }> {
  if (unsafeName(name)) return { ok: false, reason: NOT_A_NAME }
  const args = remote ? ['checkout', '--track', name] : ['checkout', name]
  const out = await run(repo, args)
  if (out.code === 0) return { ok: true }
  const blocked = blockedFiles(out.stderr)
  const reason = firstLine(out.stderr, out.stdout.toString('utf8'))
  if (blocked === undefined) return { ok: false, reason }
  return { ok: false, reason, blocked: blocked.files, blockedKind: blocked.kind }
}

/**
 * Create a branch from where you are, and switch to it.
 *
 * Only a blank name, and one git would read as an option or a pathspec, are
 * refused here. Git's own rules for a ref name are long and it enforces them
 * itself; reimplementing them would drift. The two shapes caught here are not
 * a rule about names at all — they are about what `checkout` does with an
 * argument it does not read as one; see `unsafeName`.
 * @param repo - the repository.
 * @param name - the branch to create.
 * @param run - how to run git.
 * @returns success, or why not.
 */
export async function createBranch(repo: string, name: string, run: typeof runGit = runGit): Promise<ActionOutcome> {
  if (name.trim() === '') return { ok: false, reason: 'Name the branch first.' }
  if (unsafeName(name)) return { ok: false, reason: NOT_A_NAME }
  const out = await run(repo, ['checkout', '-b', name])
  return out.code === 0 ? { ok: true } : { ok: false, reason: firstLine(out.stderr, out.stdout.toString('utf8')) }
}
