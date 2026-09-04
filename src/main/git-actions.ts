import { runGit } from './git-run'

/** What one action reports back. */
export type ActionOutcome = { ok: true } | { ok: false; reason: string }

/** What is said when git failed and neither stream carried a reason. */
const NOTHING_SAID = 'git failed without saying why.'

/**
 * The lines of one stream, trimmed, with the blank ones dropped.
 * @param text - a whole stream.
 * @returns the lines worth showing, in order.
 */
function spoken(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

/**
 * What git said, cut to the one line the panel shows.
 *
 * git writes a usable sentence first and hints, stacks, and advice after it.
 * A panel row is one line wide, and the rest belongs in the terminal.
 *
 * stdout is read when stderr is blank, because git's three commonest refusals
 * are not on stderr at all: a commit a hook rejected (husky and its like
 * print there), `nothing to commit, working tree clean` — which exits 1 — and
 * the `CONFLICT (content): …` of a `git stash pop` that could not merge.
 * Without this the panel's most delicate message, the one saying work is
 * still in a stash, ends "git failed without saying why."
 *
 * The LAST line of stdout rather than the first: git narrates there — `On
 * branch main`, `Auto-merging a.ts` — and the conclusion is what it finishes
 * with. stderr keeps the opposite rule for the opposite reason.
 *
 * Shared by git modules to ensure the fallback message never drifts between them.
 * @param stderr - what git wrote to stderr.
 * @param stdout - what it wrote to stdout, read only when stderr is silent.
 * @returns the line to show, or a fallback when git said nothing anywhere.
 */
export function firstLine(stderr: string, stdout: string): string {
  const said = spoken(stderr)
  if (said.length > 0) return said[0]
  const out = spoken(stdout)
  return out.length === 0 ? NOTHING_SAID : out[out.length - 1]
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
  return out.code === 0 ? { ok: true } : { ok: false, reason: firstLine(out.stderr, out.stdout.toString('utf8')) }
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
 * The panel shows a file in both Staged Changes and Changes when it was staged
 * and then edited again, with a tick in each row meaning different content:
 * staged means the version already recorded, changed means the edits since.
 * A single `selected` list cannot express this—if the user ticks only the
 * Staged row (keep what's already indexed, not the newer edits), a flat list
 * still has the path, so `stage()` would run `git add` and stage the newer
 * working-tree content, silently destroying the version the tick meant to
 * preserve. So the list is split.
 *
 * Three commands, in order, because `git commit` commits the whole index:
 * paths ticked in Changes or Untracked are staged, paths ticked only in
 * Staged Changes are left alone, paths that are staged but not ticked anywhere
 * are unstaged, and only then is the commit made. Without the middle step a
 * file staged earlier and unticked everywhere would be committed anyway.
 * That step has a consequence worth knowing: the index is reconciled to the
 * selection rather than left alone, and it stays that way afterwards.
 * Unticking a staged file unstages it for good, not only for this commit.
 * @param repo - the repository.
 * @param message - the commit message, as typed.
 * @param add - paths ticked in Changes or Untracked; these are staged.
 * @param keep - paths ticked only in Staged Changes; these are already indexed and must not be re-added.
 * @param staged - the paths currently in the index.
 * @param run - how to run git.
 * @returns success, or why nothing was committed.
 */
export async function commit(
  repo: string,
  message: string,
  add: string[],
  keep: string[],
  staged: string[],
  run: typeof runGit = runGit,
): Promise<ActionOutcome> {
  if (message.trim() === '') return { ok: false, reason: 'Write a commit message first.' }
  if (add.length === 0 && keep.length === 0) return { ok: false, reason: 'Tick at least one file to commit.' }
  const adding = await stage(repo, add, run)
  if (!adding.ok) return adding
  const dropping = await unstage(
    repo,
    staged.filter((path) => !add.includes(path) && !keep.includes(path)),
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
