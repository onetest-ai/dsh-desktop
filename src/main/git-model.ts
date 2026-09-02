import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { findRepos } from './git-find'
import { runGit } from './git-run'
import { parseStatus, type RepoStatus, type Section } from './git-status'

/** One repository, as the panel draws it. */
export interface Repo {
  path: string
  /** Its directory's own name, which is what the header shows. */
  name: string
  status: RepoStatus
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
    const out = await run(path, ['status', '--porcelain=2', '-z', '--branch'])
    if (out.code !== 0) {
      return { ok: false, reason: `${basename(path)}: ${out.stderr.split('\n')[0]}` }
    }
    repos.push({ path, name: basename(path), status: parseStatus(out.stdout) })
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
