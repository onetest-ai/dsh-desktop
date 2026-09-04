import { realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { listBranches, type BranchView } from './git-branch'
import { findRepos } from './git-find'
import { runGit } from './git-run'
import { listStashes, type StashView } from './git-stash'
import { parseStatus, type RepoStatus, type Section } from './git-status'

/** One repository, as the panel draws it. */
export interface Repo {
  path: string
  /** Its directory's own name, which is what the header shows. */
  name: string
  status: RepoStatus
  /** The branches this repository has, local and remote-tracking. */
  branches: BranchView[]
  /** What is stashed in it, newest first. */
  stashes: StashView[]
}

/** What the panel is showing, or why it is showing nothing. */
export type ProjectGit = { ok: true; repos: Repo[] } | { ok: false; reason: string }

/**
 * Read every repository in a project.
 *
 * A project with no repositories is an empty list rather than a failure: the
 * panel says so in words, and there is nothing wrong.
 * @param root - the project directory.
 * @param run - how to run git; injected so tests spawn nothing.
 * @returns the repositories, or why they could not be read.
 */
export async function readProject(root: string, run: typeof runGit = runGit): Promise<ProjectGit> {
  const repos: Repo[] = []
  for (const path of findRepos(root)) {
    // Together rather than in turn: none of the three depends on another,
    // and a project holding several repositories would otherwise pay for
    // every round trip three times over.
    const [status, branches, stashes] = await Promise.all([
      run(path, ['status', '--porcelain=2', '-z', '--branch']),
      listBranches(path, run),
      listStashes(path, run),
    ])
    if (status.code !== 0) {
      return { ok: false, reason: `${basename(path)}: ${status.stderr.split('\n')[0]}` }
    }
    repos.push({ path, name: basename(path), status: parseStatus(status.stdout), branches, stashes })
  }
  return { ok: true, repos }
}

/**
 * The two texts a row's diff compares.
 *
 * Which two depends on the section, as it does in VS Code: an unstaged change
 * is the index against the working tree, a staged one is `HEAD` against the
 * index, and an untracked file is nothing against the working tree.
 *
 * A version git does not have is empty rather than an error. A file added in
 * this commit has nothing in `HEAD`, and git reports that as a fatal — but
 * "it is new" is the answer the diff wants, not a failure to show.
 * @param repo - the repository's directory.
 * @param path - the file's path within it.
 * @param section - which list the row was in.
 * @param run - how to run git; injected so tests spawn nothing.
 * @returns both sides, or why they could not be read.
 */
export async function diffSides(
  repo: string,
  path: string,
  section: Section,
  run: typeof runGit = runGit,
): Promise<{ ok: true; original: string; modified: string } | { ok: false; reason: string }> {
  let original = ''
  if (section !== 'untracked') {
    const spec = section === 'staged' ? `HEAD:${path}` : `:${path}`
    const out = await run(repo, ['show', spec])
    original = out.code === 0 ? out.stdout.toString('utf8') : ''
  }
  if (section === 'staged') {
    const out = await run(repo, ['show', `:${path}`])
    return { ok: true, original, modified: out.code === 0 ? out.stdout.toString('utf8') : '' }
  }
  try {
    return { ok: true, original, modified: await readFile(join(repo, path), 'utf8') }
  } catch {
    // Deleted in the working tree: the modification is its absence.
    return { ok: true, original, modified: '' }
  }
}

/**
 * The two sides of a row's diff, if that row may be read.
 *
 * `git:open-diff` is reachable from a renderer and names a repository and a
 * path, which is not evidence of anything: the repository is checked against
 * the repositories actually discovered in the currently open project, the
 * same rule the web view's own local-file loading follows, rather than
 * trusted because the panel drew the row.
 * @param repo - the repository's directory, as the row named it.
 * @param path - the file's path within it.
 * @param section - which list the row was in.
 * @param known - the repositories currently discovered in the open project.
 * @returns both texts, or undefined when the row may not be read.
 */
export async function gitDiffFor(
  repo: string,
  path: string,
  section: Section,
  known: () => string[],
): Promise<{ original: string; modified: string } | undefined> {
  if (!known().includes(repo)) return undefined
  if (pathInRepo(repo, path) === undefined) return undefined
  const sides = await diffSides(repo, path, section)
  return sides.ok ? { original: sides.original, modified: sides.modified } : undefined
}

/**
 * Resolve a git-reported path inside a repository, or undefined when it
 * escapes.
 *
 * `resolveInRoot` (`file-tree.ts`) does this for the tree, but it refuses a
 * target that does not exist on disk — and a row for a file deleted in the
 * working tree names exactly that, which `diffSides` deliberately still
 * answers with `modified: ''` rather than a refusal. So this resolves through
 * `realpath` the way `resolveInRoot` does, to catch a symlink pointing out of
 * the repository, but falls back to resolving the containing directory alone
 * — exactly one level, not a walk up — when the path itself is missing: the
 * file can be gone without its directory being gone too, and that directory
 * is the part a symlink could still escape through. A path whose directory is
 * also missing is resolved no further; nothing will be read from it either
 * way, and `resolve` has already collapsed any `..` it carried.
 *
 * The repository is checked separately by the caller; this only answers
 * whether `path` stays inside whichever repository it is given.
 * @param repo - the repository's directory, already known to be a real one.
 * @param path - the path within it, as git reported it.
 * @returns the resolved path, or undefined when it names something outside `repo`.
 */
function pathInRepo(repo: string, path: string): string | undefined {
  // An absolute path would silently replace the root below, the same escape
  // `resolveInRoot` refuses for the same reason.
  if (isAbsolute(path)) return undefined
  let realRoot: string
  try {
    realRoot = realpathSync(repo)
  } catch {
    return undefined
  }
  const target = resolve(realRoot, path)
  let real = target
  try {
    real = realpathSync(target)
  } catch {
    try {
      // The file itself is gone; its directory usually is not, and that is
      // as far up as a symlink still needs checking.
      real = join(realpathSync(dirname(target)), basename(target))
    } catch {
      // Neither exists. Nothing will be read from it either way, and the
      // `..` this might still carry was already collapsed by `resolve`.
    }
  }
  return real === realRoot || real.startsWith(realRoot + sep) ? real : undefined
}

/**
 * The repository and paths an action may act on, or why it may not.
 *
 * One gate for every write channel rather than a check per handler: these are
 * reachable from a renderer, which supplies both the repository and the paths,
 * and the read side was already found reading `/etc/passwd` through a handler
 * that validated only the repository. A gate written once is a gate that
 * cannot be forgotten at the ninth call site.
 *
 * The branch and stash channels name no paths and pass an empty list; the
 * repository check still applies to them, since a repository the project does
 * not hold is not one this app may check out or stash in either.
 * @param repo - the repository named by the caller.
 * @param paths - the paths named by the caller; may be empty.
 * @param known - the repositories currently discovered in the open project.
 * @returns nothing when allowed, or the refusal to return to the caller.
 */
export function refuseUnlessInProject(
  repo: string,
  paths: string[],
  known: () => string[],
): { ok: false; reason: string } | undefined {
  if (!known().includes(repo)) return { ok: false, reason: 'That repository is not in the open project.' }
  for (const path of paths) {
    if (pathInRepo(repo, path) === undefined) return { ok: false, reason: 'That file is not in the repository.' }
  }
  return undefined
}
