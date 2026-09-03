import { runGit } from './git-run'

/** What one action reports back. */
export type ActionOutcome = { ok: true } | { ok: false; reason: string }

/**
 * The first line of what git said, which is what the panel shows.
 *
 * git writes a usable sentence first and hints, stacks, and advice after it.
 * A panel row is one line wide, and the rest belongs in the terminal.
 * @param stderr - what git wrote.
 * @returns the first line, or a fallback when it wrote nothing.
 */
function firstLine(stderr: string): string {
  return stderr.split('\n')[0].trim() || 'git failed without saying why.'
}

/**
 * Run one git command, reporting only whether it worked.
 * @param repo - the repository.
 * @param args - the arguments.
 * @param run - how to run git; injected so tests spawn nothing.
 * @returns success, or the first line of the failure.
 */
async function act(repo: string, args: string[], run: typeof runGit): Promise<ActionOutcome> {
  const out = await run(repo, args)
  return out.code === 0 ? { ok: true } : { ok: false, reason: firstLine(out.stderr) }
}

/**
 * Add paths to the index.
 *
 * `--` before the paths in every command here: a filename beginning with a
 * dash is a filename, and without the terminator git reads it as an option.
 * @param repo - the repository.
 * @param paths - the paths to stage, relative to it.
 * @param run - how to run git.
 * @returns success, or why not.
 */
export async function stage(repo: string, paths: string[], run: typeof runGit = runGit): Promise<ActionOutcome> {
  if (paths.length === 0) return { ok: true }
  return await act(repo, ['add', '--', ...paths], run)
}

/**
 * Take paths back out of the index, leaving the working tree alone.
 * @param repo - the repository.
 * @param paths - the paths to unstage.
 * @param run - how to run git.
 * @returns success, or why not.
 */
export async function unstage(repo: string, paths: string[], run: typeof runGit = runGit): Promise<ActionOutcome> {
  if (paths.length === 0) return { ok: true }
  return await act(repo, ['restore', '--staged', '--', ...paths], run)
}

/**
 * Commit exactly what is ticked.
 *
 * Three commands, in order, because `git commit` commits the whole index:
 * ticked paths are staged, paths that are staged but not ticked are
 * unstaged, and only then is the commit made. Without the middle step a file
 * staged earlier and unticked here would be committed anyway.
 *
 * That step has a consequence worth knowing: the index is reconciled to the
 * selection rather than left alone, and it stays that way afterwards.
 * Unticking a staged file unstages it for good, not only for this commit.
 * @param repo - the repository.
 * @param message - the commit message, as typed.
 * @param selected - the paths ticked in the panel.
 * @param staged - the paths currently in the index.
 * @param run - how to run git.
 * @returns success, or why nothing was committed.
 */
export async function commit(
  repo: string,
  message: string,
  selected: string[],
  staged: string[],
  run: typeof runGit = runGit,
): Promise<ActionOutcome> {
  if (message.trim() === '') return { ok: false, reason: 'Write a commit message first.' }
  if (selected.length === 0) return { ok: false, reason: 'Tick at least one file to commit.' }
  const adding = await stage(repo, selected, run)
  if (!adding.ok) return adding
  const dropping = await unstage(
    repo,
    staged.filter((path) => !selected.includes(path)),
    run,
  )
  if (!dropping.ok) return dropping
  return await act(repo, ['commit', '-m', message], run)
}

/**
 * Throw away changes to the named paths.
 *
 * Two commands, because they are two different things: a tracked file is
 * restored from the index, and an untracked one has nothing to restore to
 * and must be deleted. Passing an untracked path to `restore` fails with a
 * pathspec error rather than doing nothing, which — combined with
 * stop-at-first-failure — means a misclassified path aborts the discard
 * before the untracked half runs.
 * @param repo - the repository.
 * @param tracked - paths git knows about.
 * @param untracked - paths it does not.
 * @param run - how to run git.
 * @returns success, or the first failure.
 */
export async function discard(
  repo: string,
  tracked: string[],
  untracked: string[],
  run: typeof runGit = runGit,
): Promise<ActionOutcome> {
  if (tracked.length > 0) {
    const out = await act(repo, ['restore', '--worktree', '--', ...tracked], run)
    if (!out.ok) return out
  }
  if (untracked.length > 0) return await act(repo, ['clean', '-f', '-d', '--', ...untracked], run)
  return { ok: true }
}
