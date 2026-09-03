# Git Panel (write) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the read-only git panel into one you work in: tick files, stage and unstage them, discard changes, commit, stash, and switch branches.

**Architecture:** Every new git operation is a function in main taking an injected `run`, so its tests spawn nothing. Two new pure parsers — branches and stashes — join `git-status.ts` and are table-driven against recorded bytes. The renderer gains selection state and controls but no git knowledge. Destructive actions are confirmed by main through `dialog.showMessageBox`, where a renderer cannot fake the answer.

**Tech Stack:** TypeScript, Electron 33 (`WebContentsView`, `dialog`), Vitest, esbuild for the renderer bundle.

**Spec:** [`docs/notes/git-panel.md`](../../notes/git-panel.md)

**Scope:** This is plan 2 of 3. Plan 1 (`2026-08-31-git-panel-read.md`) shipped the panel, the file list and the diff. This plan adds every local write: selection, stage/unstage/discard, commit, stash, and branches. Plan 3 adds fetch/pull/push and the credential failure surface — nothing here depends on it.

## Global Constraints

- **Never spawn `git` outside `git-run.ts`.** Every new operation goes through `runGit`, which carries `GIT_TERMINAL_PROMPT=0`, `GIT_SSH_COMMAND` with `-o BatchMode=yes`, `SSH_ASKPASS_REQUIRE=never`, no `GIT_ASKPASS`, and the composed login-shell PATH.
- **Every git argument that names a path is validated before use**, with `pathInRepo` in `git-model.ts`. A renderer names paths; a name is not evidence. This plan adds several channels that take paths — each one validates, and there is no exception for "it came from our own page".
- **No git logic in `src/renderer/**`.** Main turns bytes into structure; the renderer draws and reports clicks.
- **Renderer never imports from `src/main/`, and main never from `src/renderer/`.** `src/renderer/pane/**` is typechecked by `tsconfig.pane.json`; everything else by `tsconfig.json`. Run both.
- **Destructive confirmations are raised in main** with `dialog.showMessageBox`, following `pane:delete-entry` at `src/main/index.ts:2297`. A confirmation a renderer could answer for itself is not a confirmation.
- **JSDoc on every export**, stating the reasoning not recoverable from the code. Comments state facts and consequences, not narration.
- **Prove tests non-vacuous.** Where a step names a break-it check, run it and paste the real output. Plan 1 found a sign bug, a test that asserted nothing, and a security hole this way.
- **Run `npm test` and both typechecks before every commit.** The suite stands at **1445 tests across 72 files**; never reduce it.
- **No formatter is configured.** Do not run `prettier`.

## File Structure

**Created:**

| File | Responsibility |
| --- | --- |
| `src/main/git-actions.ts` | Stage, unstage, discard, commit. Takes an injected `run`. |
| `src/main/git-branch.ts` | Parse `git branch --format`; list, checkout, create. |
| `src/main/git-stash.ts` | Parse `git stash list --format`; push, apply, pop, drop. |
| `src/renderer/pane/git-select.ts` | Pure selection state: what is ticked, per repo, across refreshes. |

**Modified:** `src/main/git-model.ts` (repo view gains branches and stashes), `src/main/index.ts` (IPC and confirmations), `src/preload/pane.ts`, `src/renderer/pane/bridge.ts`, `src/renderer/pane/git.ts`, `src/renderer/pane/git-rows.ts`, `src/renderer/git.html`, `src/renderer/pane.css`, `README.md`.

---

### Task 1: Staging, unstaging, discarding

**Files:**
- Create: `src/main/git-actions.ts`
- Test: `src/main/git-actions.spec.ts`

**Interfaces:**
- Consumes: `runGit`/`GitResult` from `src/main/git-run.ts` (`{ code: number; stdout: Buffer; stderr: string }`; a non-zero exit is a result, never a throw).
- Produces:

```ts
export type ActionOutcome = { ok: true } | { ok: false; reason: string }
export function stage(repo: string, paths: string[], run?: typeof runGit): Promise<ActionOutcome>
export function unstage(repo: string, paths: string[], run?: typeof runGit): Promise<ActionOutcome>
export function discard(repo: string, paths: string[], untracked: string[], run?: typeof runGit): Promise<ActionOutcome>
```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from 'vitest'
import { discard, stage, unstage } from './git-actions'
import type { GitResult } from './git-run'

const ok = (): GitResult => ({ code: 0, stdout: Buffer.alloc(0), stderr: '' })
const fail = (why: string): GitResult => ({ code: 1, stdout: Buffer.alloc(0), stderr: `${why}\nstack line\n` })

describe('stage', () => {
  it('adds exactly the paths it was given, after a terminator', async () => {
    const run = vi.fn(async () => ok())
    expect(await stage('/r', ['a.ts', 'b.ts'], run)).toEqual({ ok: true })
    expect(run).toHaveBeenCalledWith('/r', ['add', '--', 'a.ts', 'b.ts'])
  })

  // reason: a path beginning with a dash is a filename, and without `--`
  // git reads it as an option — on `add` that is merely an error, but the
  // habit has to be uniform or the one place it matters gets missed.
  it('never lets a path be read as an option', async () => {
    const run = vi.fn(async () => ok())
    await stage('/r', ['-rf'], run)
    expect(run.mock.calls[0][1]).toEqual(['add', '--', '-rf'])
  })

  it('does nothing at all when given no paths', async () => {
    const run = vi.fn(async () => ok())
    expect(await stage('/r', [], run)).toEqual({ ok: true })
    expect(run).not.toHaveBeenCalled()
  })

  // reason: the panel shows the first line; git's own second line is a hint
  // for a terminal, and a stack is never shown at all.
  it('reports only the first line of a failure', async () => {
    const run = vi.fn(async () => fail('fatal: pathspec did not match'))
    expect(await stage('/r', ['a.ts'], run)).toEqual({
      ok: false,
      reason: 'fatal: pathspec did not match',
    })
  })
})

describe('unstage', () => {
  it('restores the named paths in the index only', async () => {
    const run = vi.fn(async () => ok())
    await unstage('/r', ['a.ts'], run)
    expect(run).toHaveBeenCalledWith('/r', ['restore', '--staged', '--', 'a.ts'])
  })
})

describe('discard', () => {
  // reason: a tracked file is restored from the index; an untracked one has
  // nothing to restore to and must be deleted. One command cannot do both,
  // and `restore` silently ignores a path it does not track — so an
  // untracked file passed to it would be reported as discarded and still
  // be sitting there.
  it('restores tracked paths and removes untracked ones, separately', async () => {
    const run = vi.fn(async () => ok())
    expect(await discard('/r', ['tracked.ts'], ['new.ts'], run)).toEqual({ ok: true })
    expect(run.mock.calls.map((call) => call[1])).toEqual([
      ['restore', '--worktree', '--', 'tracked.ts'],
      ['clean', '-f', '--', 'new.ts'],
    ])
  })

  it('skips the command it has no paths for', async () => {
    const run = vi.fn(async () => ok())
    await discard('/r', [], ['new.ts'], run)
    expect(run.mock.calls.map((call) => call[1])).toEqual([['clean', '-f', '--', 'new.ts']])
  })

  it('stops at the first failure rather than carrying on', async () => {
    const run = vi.fn(async () => fail('error: unable to unlink'))
    const out = await discard('/r', ['a.ts'], ['b.ts'], run)
    expect(out).toEqual({ ok: false, reason: 'error: unable to unlink' })
    expect(run).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/main/git-actions.spec.ts`
Expected: FAIL — cannot resolve `./git-actions`.

- [ ] **Step 3: Write `git-actions.ts`**

```ts
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
 * Throw away changes to the named paths.
 *
 * Two commands, because they are two different things: a tracked file is
 * restored from the index, and an untracked one has nothing to restore to
 * and is deleted. `restore` ignores a path it does not track, so an
 * untracked file sent to it would be reported as discarded and still be
 * there — which is the worst possible answer for an action that cannot be
 * undone.
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
  if (untracked.length > 0) return await act(repo, ['clean', '-f', '--', ...untracked], run)
  return { ok: true }
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `npx vitest run src/main/git-actions.spec.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Prove the discard split is not vacuous**

Change `discard` to send both lists to `restore` in one command. Run the file. "restores tracked paths and removes untracked ones, separately" must fail. Put it back.

- [ ] **Step 6: Commit**

```bash
npm test && npx tsc -p tsconfig.json --noEmit
git add src/main/git-actions.ts src/main/git-actions.spec.ts
git commit -m "feat(git): stage, unstage, and discard"
```

---

### Task 2: Committing what is ticked

**Files:**
- Modify: `src/main/git-actions.ts`
- Test: `src/main/git-actions.spec.ts`

**Interfaces:**
- Consumes: `stage`, `unstage`, `ActionOutcome` from Task 1.
- Produces: `commit(repo: string, message: string, selected: string[], staged: string[], run?: typeof runGit): Promise<ActionOutcome>`.

Read the spec's **Committing** section first. The tick is a *selection*, not the index, and making a commit match the selection means reconciling the index to it — which has a consequence the spec states plainly and this task must implement exactly.

- [ ] **Step 1: Write the failing test**

```ts
import { commit } from './git-actions'

describe('commit', () => {
  // reason: the tick means "include this", and `git commit` commits the whole
  // index — so anything staged but unticked would ride along. Reconciling the
  // index to the selection is the only way the commit matches what was asked
  // for, and the spec states the consequence: an unticked file that was
  // staged is unstaged, and stays that way.
  it('stages what is ticked, unstages what is staged but is not, then commits', async () => {
    const run = vi.fn(async () => ok())
    expect(await commit('/r', 'a message', ['new.ts', 'both.ts'], ['both.ts', 'unwanted.ts'], run)).toEqual({
      ok: true,
    })
    expect(run.mock.calls.map((call) => call[1])).toEqual([
      ['add', '--', 'new.ts', 'both.ts'],
      ['restore', '--staged', '--', 'unwanted.ts'],
      ['commit', '-m', 'a message'],
    ])
  })

  it('skips the reconciliation commands it has nothing for', async () => {
    const run = vi.fn(async () => ok())
    await commit('/r', 'm', ['a.ts'], ['a.ts'], run)
    expect(run.mock.calls.map((call) => call[1])).toEqual([
      ['add', '--', 'a.ts'],
      ['commit', '-m', 'm'],
    ])
  })

  // reason: committing with nothing ticked would make an empty commit, and
  // committing with no message opens an editor that has no terminal to
  // appear in — the panel disables the button for both, and this is the
  // second door.
  it('refuses an empty message and an empty selection, without running git', async () => {
    const run = vi.fn(async () => ok())
    expect(await commit('/r', '   ', ['a.ts'], [], run)).toEqual({
      ok: false,
      reason: 'Write a commit message first.',
    })
    expect(await commit('/r', 'm', [], [], run)).toEqual({
      ok: false,
      reason: 'Tick at least one file to commit.',
    })
    expect(run).not.toHaveBeenCalled()
  })

  // reason: a failing hook is the common case, and its own output is the
  // only thing that says what to fix.
  it('reports a failure without committing anything after it', async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(fail('hook declined the commit'))
    const out = await commit('/r', 'm', ['a.ts'], [], run)
    expect(out).toEqual({ ok: false, reason: 'hook declined the commit' })
  })
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run src/main/git-actions.spec.ts -t commit`
Expected: FAIL — `commit is not a function`.

- [ ] **Step 3: Implement `commit`**

```ts
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
```

- [ ] **Step 4: Run and watch it pass**

Run: `npx vitest run src/main/git-actions.spec.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Prove the reconciliation is not vacuous**

Delete the `unstage` call. Run the file. "stages what is ticked, unstages what is staged but is not, then commits" must fail. Put it back.

- [ ] **Step 6: Commit**

```bash
npm test && npx tsc -p tsconfig.json --noEmit
git add src/main/git-actions.ts src/main/git-actions.spec.ts
git commit -m "feat(git): commit what the ticks name, and only that"
```

---

### Task 3: Branches

**Files:**
- Create: `src/main/git-branch.ts`
- Test: `src/main/git-branch.spec.ts`

**Interfaces:**
- Consumes: `runGit`, `GitResult`; `ActionOutcome` from `git-actions.ts`.
- Produces:

```ts
export interface BranchView { name: string; upstream: string; current: boolean; remote: boolean }
export function parseBranches(stdout: Buffer): BranchView[]
export function listBranches(repo: string, run?: typeof runGit): Promise<BranchView[]>
export function checkout(repo: string, name: string, run?: typeof runGit): Promise<ActionOutcome & { blocked?: string[] }>
export function createBranch(repo: string, name: string, run?: typeof runGit): Promise<ActionOutcome>
```

The command is `git branch --list --all --format='%(refname:short)%09%(upstream:short)%09%(HEAD)'`. Real output from git 2.50.1, tab-separated, for a repo on `main` with a `feature` branch:

```
feature		 
main		*
```

The third field is `*` for the current branch and a space otherwise. With `--all`, remote branches appear as `origin/feature` and never carry `*`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from 'vitest'
import { checkout, createBranch, parseBranches } from './git-branch'
import type { GitResult } from './git-run'

const bytes = (...lines: string[]): Buffer => Buffer.from(`${lines.join('\n')}\n`, 'utf8')
const ok = (out = ''): GitResult => ({ code: 0, stdout: Buffer.from(out, 'utf8'), stderr: '' })
const fail = (why: string): GitResult => ({ code: 1, stdout: Buffer.alloc(0), stderr: why })

describe('parseBranches', () => {
  it('reads the name, its upstream, and which one is current', () => {
    expect(parseBranches(bytes('feature\t\t ', 'main\torigin/main\t*'))).toEqual([
      { name: 'feature', upstream: '', current: false, remote: false },
      { name: 'main', upstream: 'origin/main', current: true, remote: false },
    ])
  })

  // reason: a remote-tracking branch is offered so it can be checked out,
  // which creates the local branch that follows it — but it is not itself a
  // branch you are ever on, and listing it beside local ones unmarked reads
  // as a duplicate.
  it('marks a remote-tracking branch as remote', () => {
    expect(parseBranches(bytes('origin/main\t\t '))).toEqual([
      { name: 'origin/main', upstream: '', current: false, remote: true },
    ])
  })

  // reason: `--all` lists this pointer, and it is not a branch anyone checks
  // out — leaving it in puts a nonsense entry at the top of the menu.
  it('leaves out the remote HEAD pointer', () => {
    expect(parseBranches(bytes('origin/HEAD\t\t ', 'main\t\t*')).map((each) => each.name)).toEqual(['main'])
  })

  it('reads nothing from nothing', () => {
    expect(parseBranches(Buffer.alloc(0))).toEqual([])
  })
})

describe('checkout', () => {
  it('switches to the branch it was given', async () => {
    const run = vi.fn(async () => ok())
    expect(await checkout('/r', 'feature', run)).toEqual({ ok: true })
    expect(run).toHaveBeenCalledWith('/r', ['checkout', 'feature'])
  })

  // reason: git refuses only when the changes would be overwritten, and it
  // names the files. Those names are the whole content of the offer to stash
  // — an offer that cannot say what is in the way is a shrug with a button.
  it('reports which files blocked a refused switch', async () => {
    const run = vi.fn(async () =>
      fail(
        'error: Your local changes to the following files would be overwritten by checkout:\n' +
          '\ta.ts\n\tsrc/b.ts\n' +
          'Please commit your changes or stash them before you switch branches.\n',
      ),
    )
    const out = await checkout('/r', 'feature', run)
    expect(out.ok).toBe(false)
    expect(out.blocked).toEqual(['a.ts', 'src/b.ts'])
  })

  it('reports an ordinary failure with no blocked list', async () => {
    const run = vi.fn(async () => fail("error: pathspec 'nope' did not match any file(s) known to git"))
    const out = await checkout('/r', 'nope', run)
    expect(out).toMatchObject({ ok: false })
    expect(out.blocked).toBeUndefined()
  })
})

describe('createBranch', () => {
  it('creates the branch and switches to it', async () => {
    const run = vi.fn(async () => ok())
    expect(await createBranch('/r', 'feature', run)).toEqual({ ok: true })
    expect(run).toHaveBeenCalledWith('/r', ['checkout', '-b', 'feature'])
  })

  // reason: git's own rules are long and this is not the place to
  // reimplement them — but a blank name and a leading dash are worth
  // catching before a command is built out of them.
  it('refuses a blank name without running git', async () => {
    const run = vi.fn(async () => ok())
    expect(await createBranch('/r', '  ', run)).toEqual({ ok: false, reason: 'Name the branch first.' })
    expect(run).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run src/main/git-branch.spec.ts`
Expected: FAIL — cannot resolve `./git-branch`.

- [ ] **Step 3: Write `git-branch.ts`**

```ts
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
```

- [ ] **Step 4: Run and watch it pass**

Run: `npx vitest run src/main/git-branch.spec.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Check the format against real git**

```bash
cd /tmp && rm -rf gb && mkdir gb && cd gb && git init -q \
  && git config user.email t@t && git config user.name t \
  && echo a > a.txt && git add . && git commit -qm one && git branch feature \
  && git branch --list --all --format='%(refname:short)%09%(upstream:short)%09%(HEAD)'
```

Confirm two tab-separated lines with `*` on the current one. If your git differs, the fixtures are what change — say so loudly in your report.

- [ ] **Step 6: Prove the blocked-files parse is not vacuous**

Make `blockedFiles` always return `undefined`. Run the file. "reports which files blocked a refused switch" must fail. Put it back.

- [ ] **Step 7: Commit**

```bash
npm test && npx tsc -p tsconfig.json --noEmit
git add src/main/git-branch.ts src/main/git-branch.spec.ts
git commit -m "feat(git): list branches, switch, and say what blocked a switch"
```

---

### Task 4: Stashes

**Files:**
- Create: `src/main/git-stash.ts`
- Test: `src/main/git-stash.spec.ts`

**Interfaces:**
- Consumes: `runGit`, `GitResult`, `ActionOutcome`.
- Produces:

```ts
export interface StashView { ref: string; message: string; branch: string }
export function parseStashes(stdout: Buffer): StashView[]
export function listStashes(repo: string, run?: typeof runGit): Promise<StashView[]>
export function pushStash(repo: string, message: string, run?: typeof runGit): Promise<ActionOutcome>
export function applyStash(repo: string, ref: string, pop: boolean, run?: typeof runGit): Promise<ActionOutcome>
export function dropStash(repo: string, ref: string, run?: typeof runGit): Promise<ActionOutcome>
```

The command is `git stash list --format='%gd%x09%gs'`. Real output from git 2.50.1:

```
stash@{0}	On main: wip thing
```

The subject is `On <branch>: <message>`, or `WIP on <branch>: <sha> <subject>` when the stash was made without one.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from 'vitest'
import { applyStash, dropStash, parseStashes, pushStash } from './git-stash'
import type { GitResult } from './git-run'

const bytes = (...lines: string[]): Buffer => Buffer.from(`${lines.join('\n')}\n`, 'utf8')
const ok = (): GitResult => ({ code: 0, stdout: Buffer.alloc(0), stderr: '' })
const fail = (why: string): GitResult => ({ code: 1, stdout: Buffer.alloc(0), stderr: why })

describe('parseStashes', () => {
  it('reads the ref, the branch it was made on, and the message', () => {
    expect(parseStashes(bytes('stash@{0}\tOn main: wip thing'))).toEqual([
      { ref: 'stash@{0}', branch: 'main', message: 'wip thing' },
    ])
  })

  // reason: a stash pushed without a message gets git's own subject, which
  // names the commit it was taken from — useless as a label but all there
  // is, so it is shown rather than blanked.
  it('reads an unnamed stash, keeping what git called it', () => {
    const [stash] = parseStashes(bytes('stash@{1}\tWIP on feature: 1a2b3c4 earlier subject'))
    expect(stash.branch).toBe('feature')
    expect(stash.message).toBe('1a2b3c4 earlier subject')
  })

  // reason: a colon in the message must not be read as the branch separator,
  // or every stash named "fix: something" reports the wrong branch.
  it('splits on the first colon only', () => {
    const [stash] = parseStashes(bytes('stash@{0}\tOn main: fix: the thing'))
    expect(stash.branch).toBe('main')
    expect(stash.message).toBe('fix: the thing')
  })

  it('reads nothing from nothing', () => {
    expect(parseStashes(Buffer.alloc(0))).toEqual([])
  })
})

describe('pushStash', () => {
  it('pushes the working tree with the message it was given', async () => {
    const run = vi.fn(async () => ok())
    expect(await pushStash('/r', 'wip thing', run)).toEqual({ ok: true })
    expect(run).toHaveBeenCalledWith('/r', ['stash', 'push', '-m', 'wip thing'])
  })

  it('pushes without a message when none was written', async () => {
    const run = vi.fn(async () => ok())
    await pushStash('/r', '   ', run)
    expect(run).toHaveBeenCalledWith('/r', ['stash', 'push'])
  })

  // reason: `git stash push` on a clean tree exits 0 and does nothing, so a
  // panel that just reports success leaves the user believing a stash
  // exists.
  it('says so when there was nothing to stash', async () => {
    const run = vi.fn(async () => ({ code: 0, stdout: Buffer.from('No local changes to save\n'), stderr: '' }))
    expect(await pushStash('/r', '', run)).toEqual({ ok: false, reason: 'There is nothing to stash.' })
  })
})

describe('applyStash', () => {
  it('applies without removing, and pops with removing', async () => {
    const run = vi.fn(async () => ok())
    await applyStash('/r', 'stash@{0}', false, run)
    await applyStash('/r', 'stash@{0}', true, run)
    expect(run.mock.calls.map((call) => call[1])).toEqual([
      ['stash', 'apply', 'stash@{0}'],
      ['stash', 'pop', 'stash@{0}'],
    ])
  })

  // reason: a pop that conflicts leaves the stash in place and the tree
  // half-merged; reporting success would hide both.
  it('reports a conflicting pop as a failure', async () => {
    const run = vi.fn(async () => fail('CONFLICT (content): Merge conflict in a.ts'))
    expect(await applyStash('/r', 'stash@{0}', true, run)).toEqual({
      ok: false,
      reason: 'CONFLICT (content): Merge conflict in a.ts',
    })
  })
})

describe('dropStash', () => {
  it('drops exactly the ref it was given', async () => {
    const run = vi.fn(async () => ok())
    await dropStash('/r', 'stash@{2}', run)
    expect(run).toHaveBeenCalledWith('/r', ['stash', 'drop', 'stash@{2}'])
  })
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run src/main/git-stash.spec.ts`
Expected: FAIL — cannot resolve `./git-stash`.

- [ ] **Step 3: Write `git-stash.ts`**

```ts
import type { ActionOutcome } from './git-actions'
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
  if (out.code !== 0) return { ok: false, reason: out.stderr.split('\n')[0].trim() }
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
  return out.code === 0 ? { ok: true } : { ok: false, reason: out.stderr.split('\n')[0].trim() }
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
  return out.code === 0 ? { ok: true } : { ok: false, reason: out.stderr.split('\n')[0].trim() }
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `npx vitest run src/main/git-stash.spec.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Check the format against real git**

```bash
cd /tmp && rm -rf gs && mkdir gs && cd gs && git init -q \
  && git config user.email t@t && git config user.name t \
  && echo a > a.txt && git add . && git commit -qm one \
  && echo b >> a.txt && git stash -q -m "wip thing" \
  && git stash list --format='%gd%x09%gs'
```

Expected: `stash@{0}	On main: wip thing`.

- [ ] **Step 6: Prove the first-colon split is not vacuous**

Change `subject.indexOf(':')` to `subject.lastIndexOf(':')`. Run the file. "splits on the first colon only" must fail. Put it back.

- [ ] **Step 7: Commit**

```bash
npm test && npx tsc -p tsconfig.json --noEmit
git add src/main/git-stash.ts src/main/git-stash.spec.ts
git commit -m "feat(git): list stashes, push, apply, pop, and drop"
```

---

### Task 5: Branches and stashes reach the panel

**Files:**
- Modify: `src/main/git-model.ts`, `src/main/git-model.spec.ts`, `src/renderer/pane/git-rows.ts`

**Interfaces:**
- Consumes: `listBranches`/`BranchView` (Task 3), `listStashes`/`StashView` (Task 4), the existing `readProject`.
- Produces: `Repo` gains `branches: BranchView[]` and `stashes: StashView[]`. The renderer's `RepoStatusView` neighbour types gain matching `BranchRowView` and `StashRowView` — **redeclared** in `git-rows.ts`, never imported across the boundary.

- [ ] **Step 1: Write the failing test**

```ts
// In src/main/git-model.spec.ts
it('reads each repository with its branches and its stashes', async () => {
  const run = vi.fn(async (_cwd: string, args: string[]) => {
    if (args[0] === 'status') return ok('# branch.head main\0')
    if (args[0] === 'branch') return ok('main\t\t*\n')
    if (args[0] === 'stash') return ok('stash@{0}\tOn main: wip\n')
    return ok('')
  })
  const out = await readProject(process.cwd(), run)
  expect(out).toMatchObject({ ok: true })
  if (!out.ok) return
  expect(out.repos[0].branches).toEqual([{ name: 'main', upstream: '', current: true, remote: false }])
  expect(out.repos[0].stashes).toEqual([{ ref: 'stash@{0}', branch: 'main', message: 'wip' }])
})

// reason: three commands per repository, and a project may hold several —
// asking for them one after another triples the time the panel takes to
// appear for no reason, since none depends on another.
it('asks for status, branches and stashes together rather than in turn', async () => {
  const order: string[] = []
  const run = vi.fn(async (_cwd: string, args: string[]) => {
    order.push(`start:${args[0]}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
    order.push(`end:${args[0]}`)
    return args[0] === 'status' ? ok('# branch.head main\0') : ok('')
  })
  await readProject(process.cwd(), run)
  expect(order.slice(0, 3).every((entry) => entry.startsWith('start:'))).toBe(true)
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run src/main/git-model.spec.ts`
Expected: FAIL — `branches` is undefined on the repo.

- [ ] **Step 3: Widen `Repo` and read the three together**

In `src/main/git-model.ts`, add to the `Repo` interface:

```ts
  /** The branches this repository has, local and remote-tracking. */
  branches: BranchView[]
  /** What is stashed in it, newest first. */
  stashes: StashView[]
```

and inside `readProject`'s loop, replace the single status call with:

```ts
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
```

- [ ] **Step 4: Mirror the shapes in the renderer**

In `src/renderer/pane/git-rows.ts`, beside `RepoStatusView`, add — **redeclared, not imported**, since the renderer may never import from `src/main/`:

```ts
/** One branch, as the panel receives it. Mirrors main's `BranchView`. */
export interface BranchRowView {
  name: string
  upstream: string
  current: boolean
  remote: boolean
}

/** One stash, as the panel receives it. Mirrors main's `StashView`. */
export interface StashRowView {
  ref: string
  branch: string
  message: string
}
```

- [ ] **Step 5: Run and watch it pass**

Run: `npm test`
Expected: PASS. `git.ts`'s `RepoView` also needs the two new fields — add them there, mirroring the same shapes.

- [ ] **Step 6: Commit**

```bash
npm test && npx tsc -p tsconfig.json --noEmit && npx tsc -p tsconfig.pane.json --noEmit
git add -A
git commit -m "feat(git): read branches and stashes alongside status"
```

---

### Task 6: The ticks

**Files:**
- Create: `src/renderer/pane/git-select.ts`, `src/renderer/pane/git-select.spec.ts`

**Interfaces:**
- Consumes: `EntryView`, `RepoStatusView` from `git-rows.ts`.
- Produces:

```ts
export class Selection {
  ticked(repo: string, path: string): boolean
  toggle(repo: string, path: string): void
  setSection(repo: string, paths: string[], on: boolean): void
  selected(repo: string, status: RepoStatusView): string[]
  reconcile(repo: string, status: RepoStatusView): void
}
```

Read the spec's **The checkbox is a selection, not the index** before starting. The default state is the part that matters.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { Selection } from './git-select'

const status = (over: Partial<Record<'staged' | 'changed' | 'untracked', { path: string; status: string }[]>> = {}) => ({
  branch: 'main',
  ahead: 0,
  behind: 0,
  staged: [],
  changed: [],
  untracked: [],
  ...over,
})

describe('Selection', () => {
  // reason: committing a file nobody noticed is how build output, scratch
  // files and credentials reach a repository, and an untracked file is by
  // definition one git has never seen before.
  it('ticks tracked changes by default and leaves untracked ones alone', () => {
    const selection = new Selection()
    const state = status({ changed: [{ path: 'a.ts', status: 'M' }], untracked: [{ path: 'new.ts', status: '?' }] })
    selection.reconcile('/r', state)
    expect(selection.ticked('/r', 'a.ts')).toBe(true)
    expect(selection.ticked('/r', 'new.ts')).toBe(false)
  })

  it('remembers a tick and an untick across a refresh', () => {
    const selection = new Selection()
    const state = status({ changed: [{ path: 'a.ts', status: 'M' }], untracked: [{ path: 'new.ts', status: '?' }] })
    selection.reconcile('/r', state)
    selection.toggle('/r', 'a.ts')
    selection.toggle('/r', 'new.ts')
    selection.reconcile('/r', state)
    expect(selection.ticked('/r', 'a.ts')).toBe(false)
    expect(selection.ticked('/r', 'new.ts')).toBe(true)
  })

  // reason: a file that has gone must not keep a tick that would be applied
  // to a different file of the same name later.
  it('forgets a path that is no longer changed', () => {
    const selection = new Selection()
    selection.reconcile('/r', status({ changed: [{ path: 'a.ts', status: 'M' }] }))
    selection.toggle('/r', 'a.ts')
    selection.reconcile('/r', status({}))
    selection.reconcile('/r', status({ changed: [{ path: 'a.ts', status: 'M' }] }))
    expect(selection.ticked('/r', 'a.ts')).toBe(true)
  })

  // reason: two repositories in one project may hold a file of the same
  // name, and ticking one must not tick the other.
  it('keeps repositories apart', () => {
    const selection = new Selection()
    const state = status({ changed: [{ path: 'a.ts', status: 'M' }] })
    selection.reconcile('/one', state)
    selection.reconcile('/two', state)
    selection.toggle('/one', 'a.ts')
    expect(selection.ticked('/one', 'a.ts')).toBe(false)
    expect(selection.ticked('/two', 'a.ts')).toBe(true)
  })

  it('sets or clears a whole section at once', () => {
    const selection = new Selection()
    const state = status({ changed: [{ path: 'a.ts', status: 'M' }, { path: 'b.ts', status: 'M' }] })
    selection.reconcile('/r', state)
    selection.setSection('/r', ['a.ts', 'b.ts'], false)
    expect(selection.selected('/r', state)).toEqual([])
    selection.setSection('/r', ['a.ts', 'b.ts'], true)
    expect(selection.selected('/r', state)).toEqual(['a.ts', 'b.ts'])
  })

  // reason: a file staged and then edited again appears in two sections, and
  // committing it twice would be a nonsense argument list.
  it('names a path once even when it is in two sections', () => {
    const selection = new Selection()
    const state = status({
      staged: [{ path: 'both.ts', status: 'M' }],
      changed: [{ path: 'both.ts', status: 'M' }],
    })
    selection.reconcile('/r', state)
    expect(selection.selected('/r', state)).toEqual(['both.ts'])
  })
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run src/renderer/pane/git-select.spec.ts`
Expected: FAIL — cannot resolve `./git-select`.

- [ ] **Step 3: Write `git-select.ts`**

```ts
import type { EntryView, RepoStatusView } from './git-rows.ts'

/** Every path a repository's status mentions, each once. */
function paths(status: RepoStatusView): string[] {
  const all = [...status.staged, ...status.changed, ...status.untracked].map((entry: EntryView) => entry.path)
  return [...new Set(all)]
}

/**
 * Which files are ticked, per repository.
 *
 * The tick is a selection rather than the index: it says only *include this
 * in the next commit*, and nothing runs until Commit is pressed. Held in the
 * page rather than on disk — a selection is about the commit being composed
 * right now, and one restored from a previous session would be a claim about
 * files the user has not looked at.
 */
export class Selection {
  /** Ticked paths, by repository. A path absent from the set is unticked. */
  private readonly ticks = new Map<string, Set<string>>()

  /** Paths already reconciled once, so a default is applied only on arrival. */
  private readonly seen = new Map<string, Set<string>>()

  /**
   * Whether one path is ticked.
   * @param repo - the repository's path.
   * @param path - the file's path within it.
   * @returns whether it would be committed.
   */
  ticked(repo: string, path: string): boolean {
    return this.ticks.get(repo)?.has(path) ?? false
  }

  /**
   * Turn one path's tick over.
   * @param repo - the repository's path.
   * @param path - the file's path within it.
   */
  toggle(repo: string, path: string): void {
    const set = this.ticks.get(repo) ?? new Set<string>()
    if (set.has(path)) set.delete(path)
    else set.add(path)
    this.ticks.set(repo, set)
  }

  /**
   * Tick or clear every path in a section at once.
   * @param repo - the repository's path.
   * @param wanted - the paths in the section.
   * @param on - true to tick them, false to clear them.
   */
  setSection(repo: string, wanted: string[], on: boolean): void {
    const set = this.ticks.get(repo) ?? new Set<string>()
    for (const path of wanted) {
      if (on) set.add(path)
      else set.delete(path)
    }
    this.ticks.set(repo, set)
  }

  /**
   * The ticked paths of a repository, each once.
   *
   * A file that was staged and then edited again is in two sections and must
   * still be named once: the same path twice is a nonsense argument list.
   * @param repo - the repository's path.
   * @param status - its current state.
   * @returns the paths to commit, in the order the status listed them.
   */
  selected(repo: string, status: RepoStatusView): string[] {
    return paths(status).filter((path) => this.ticked(repo, path))
  }

  /**
   * Bring the ticks in line with a fresh status.
   *
   * A path arriving for the first time takes its default: tracked changes
   * start ticked, untracked files do not, because committing a file nobody
   * noticed is how build output and credentials reach a repository. A path
   * that has gone is forgotten entirely, so a file of the same name
   * appearing later does not inherit a decision made about a different one.
   * @param repo - the repository's path.
   * @param status - its current state.
   */
  reconcile(repo: string, status: RepoStatusView): void {
    const present = new Set(paths(status))
    const untracked = new Set(status.untracked.map((entry) => entry.path))
    const seen = this.seen.get(repo) ?? new Set<string>()
    const set = this.ticks.get(repo) ?? new Set<string>()
    for (const path of present) {
      if (seen.has(path)) continue
      if (!untracked.has(path)) set.add(path)
      seen.add(path)
    }
    for (const path of [...seen]) if (!present.has(path)) seen.delete(path)
    for (const path of [...set]) if (!present.has(path)) set.delete(path)
    this.seen.set(repo, seen)
    this.ticks.set(repo, set)
  }
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `npx vitest run src/renderer/pane/git-select.spec.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Prove the untracked default is not vacuous**

Remove the `if (!untracked.has(path))` guard so every arriving path is ticked. Run the file. "ticks tracked changes by default and leaves untracked ones alone" must fail. Put it back.

- [ ] **Step 6: Commit**

```bash
npm test && npx tsc -p tsconfig.pane.json --noEmit
git add src/renderer/pane/git-select.ts src/renderer/pane/git-select.spec.ts
git commit -m "feat(git): remember which files are ticked for the next commit"
```

---

### Task 7: The channels, and the confirmations

**Files:**
- Modify: `src/main/index.ts`, `src/main/index.spec.ts`, `src/preload/pane.ts`, `src/renderer/pane/bridge.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–4, plus `pathInRepo` and the known-repository check already inside `gitDiffFor` in `git-model.ts`.
- Produces these channels, each returning `ActionOutcome`:

| Channel | Arguments |
| --- | --- |
| `git:stage` / `git:unstage` | `repo`, `paths: string[]` |
| `git:discard` | `repo`, `tracked: string[]`, `untracked: string[]` — confirms |
| `git:commit` | `repo`, `message`, `selected: string[]`, `staged: string[]` |
| `git:checkout` / `git:create-branch` | `repo`, `name` |
| `git:stash-push` | `repo`, `message` |
| `git:stash-apply` | `repo`, `ref`, `pop: boolean` |
| `git:stash-drop` | `repo`, `ref` — confirms |

- [ ] **Step 1: Write the failing test**

```ts
// In src/main/index.spec.ts
describe('the git write channels', () => {
  // reason: every one of these names a repository and most name paths. A
  // renderer supplies both, and a name is not evidence — the read side was
  // already found reading /etc/passwd this way before `pathInRepo` existed.
  it('refuses a repository that is not in the open project', async () => {
    expect(await gitStageFor('/etc', ['passwd'], () => ['/p/demo'])).toEqual({
      ok: false,
      reason: 'That repository is not in the open project.',
    })
  })

  it('refuses a path that escapes the repository', async () => {
    expect(await gitStageFor('/p/demo', ['../../etc/passwd'], () => ['/p/demo'])).toEqual({
      ok: false,
      reason: 'That file is not in the repository.',
    })
  })

  it('allows a path inside it', async () => {
    expect(await gitStageFor('/p/demo', ['src/a.ts'], () => ['/p/demo'])).toMatchObject({ ok: true })
  })
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run src/main/index.spec.ts -t "git write channels"`
Expected: FAIL — `gitStageFor is not a function`.

- [ ] **Step 3: Write one gate, used by every channel**

In `src/main/git-model.ts`:

```ts
/**
 * The repository and paths an action may act on, or why it may not.
 *
 * One gate for every write channel rather than a check per handler: these
 * are reachable from a renderer, which supplies both the repository and the
 * paths, and the read side was already found reading `/etc/passwd` through a
 * handler that validated only the repository. A gate written once is a gate
 * that cannot be forgotten at the ninth call site.
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
```

Then in `src/main/index.ts`, one exported helper per channel that calls it before the action — for example:

```ts
/**
 * Stage paths, if the caller may act on them.
 * @param repo - the repository.
 * @param paths - the paths to stage.
 * @param known - the repositories currently discovered.
 * @returns what the action reported, or the refusal.
 */
export async function gitStageFor(repo: string, paths: string[], known: () => string[]): Promise<ActionOutcome> {
  return refuseUnlessInProject(repo, paths, known) ?? (await stage(repo, paths))
}
```

Write the same shape, and these exact names, for the rest: `gitUnstageFor`, `gitDiscardFor`, `gitCommitFor`, `gitCheckoutFor`, `gitCreateBranchFor`, `gitStashPushFor`, `gitStashApplyFor`, `gitStashDropFor`. Task 7's dialog code and Task 8's tests both refer to them by these names. The branch and stash channels name no paths, so they pass `[]` — the repository check still applies.

- [ ] **Step 4: Confirm the two destructive ones in main**

Discard and stash-drop raise a dialog before acting, following `pane:delete-entry` at `src/main/index.ts:2297` — in main, where a renderer cannot answer for itself:

```ts
    ipcMain.handle('git:discard', async (_event, repo: string, tracked: string[], untracked: string[]) => {
      const refusal = refuseUnlessInProject(repo, [...tracked, ...untracked], gitRepoPaths)
      if (refusal !== undefined) return refusal
      if (views === undefined || views.window.isDestroyed()) return { ok: false, reason: '' }
      const count = tracked.length + untracked.length
      const { response } = await dialog.showMessageBox(views.window, {
        type: 'warning',
        buttons: ['Discard', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        message: count === 1 ? `Discard changes to ${[...tracked, ...untracked][0]}?` : `Discard changes to ${count} files?`,
        detail: 'The changes are thrown away. This cannot be undone, and there is nothing in the reflog to recover.',
      })
      if (response !== 0) return { ok: false, reason: '' }
      const out = await gitDiscardFor(repo, tracked, untracked, gitRepoPaths)
      notifyGitChanged()
      return out
    })
```

Stash-drop takes the same shape, with `buttons: ['Drop', 'Cancel']`, `message: \`Drop ${ref}?\``, and `detail: 'The stash is thrown away. It is reachable only by a hash this panel never showed you.'`

Every other channel is a plain `ipcMain.handle` calling its helper and then `notifyGitChanged()`.

- [ ] **Step 5: Add the preload and bridge entries**

In `src/preload/pane.ts`, one line per channel, e.g. `stageFiles: (repo: string, paths: string[]) => ipcRenderer.invoke('git:stage', repo, paths)`, and declare each in `src/renderer/pane/bridge.ts` returning `Promise<{ ok: true } | { ok: false; reason: string }>`.

- [ ] **Step 6: Run and watch it pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Prove the gate is not vacuous**

Make `refuseUnlessInProject` always return `undefined`. Run `npx vitest run src/main/index.spec.ts`. Both refusal tests must fail. Put it back.

- [ ] **Step 8: Commit**

```bash
npm test && npx tsc -p tsconfig.json --noEmit && npx tsc -p tsconfig.pane.json --noEmit
git add -A
git commit -m "feat(git): the write channels, behind one gate and two confirmations"
```

---

### Task 8: Checkboxes, row actions, and the commit box

**Files:**
- Modify: `src/renderer/pane/git.ts`, `src/renderer/git.html`, `src/renderer/pane.css`
- Test: `src/renderer/pane/git.spec.ts`

**Interfaces:**
- Consumes: `Selection` (Task 6), the bridge calls (Task 7), `parts`/`rowsFor`/`colourOf` from `git-rows.ts`.
- Produces: nothing later tasks consume.

- [ ] **Step 1: Write the failing test**

`src/renderer/pane/git.spec.ts` already exists — it was added when plan 1's `refresh()` gained a failure path, and it drives the module in jsdom against a stub bridge. Extend that stub with the new calls rather than writing a second harness; `stubBridge`, `load`, and the recording arrays below are its existing shape.

```ts
// In src/renderer/pane/git.spec.ts, against the existing stub bridge.
it('commits the ticked paths, with the message that was typed', async () => {
  const bridge = stubBridge({
    repos: [
      {
        path: '/r',
        name: 'r',
        status: { branch: 'main', ahead: 0, behind: 0, staged: [], changed: [{ path: 'a.ts', status: 'M' }], untracked: [{ path: 'new.ts', status: '?' }] },
        branches: [],
        stashes: [],
      },
    ],
  })
  await load(bridge)
  ;(document.getElementById('commit-message') as HTMLTextAreaElement).value = 'a message'
  ;(document.getElementById('commit') as HTMLButtonElement).click()
  await Promise.resolve()
  expect(bridge.commitCalls).toEqual([['/r', 'a message', ['a.ts'], []]])
})

it('does not commit an untracked file nobody ticked', async () => {
  // as above; assert 'new.ts' is absent from the selected list
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run src/renderer/pane/git.spec.ts`
Expected: FAIL — no `commit-message` element.

- [ ] **Step 3: Add the commit box to `git.html`**

Above `#repos`:

```html
<form id="commit-form" class="commit">
  <textarea id="commit-message" class="commit-message" rows="2" placeholder="Message" aria-label="Commit message"></textarea>
  <button type="submit" id="commit" class="commit-button">Commit</button>
</form>
```

- [ ] **Step 4: Draw a checkbox on every row, and one per section**

In `drawSection`, before the file icon:

```ts
    const tick = document.createElement('input')
    tick.type = 'checkbox'
    tick.className = 'git-tick'
    tick.checked = selection.ticked(repo.path, entry.path)
    tick.setAttribute('aria-label', `Include ${entry.path} in the next commit`)
    // The row is a button and the tick is inside it: without this a tick
    // opens the diff as well as changing the selection.
    tick.addEventListener('click', (event) => {
      event.stopPropagation()
      selection.toggle(repo.path, entry.path)
      draw()
    })
    row.append(tick)
```

and in the section heading, a tick whose `indeterminate` is set when some but not all of its entries are ticked, calling `selection.setSection(repo.path, group.entries.map((entry) => entry.path), on)`.

- [ ] **Step 5: Add the row actions**

Each row gains a trailing group of icon buttons, shown on hover and on focus so the keyboard reaches them. `stopPropagation` on every one: the row itself is a button that opens the diff.

```ts
/**
 * One action button on a row.
 *
 * `stopPropagation` because the row is itself a button: without it every
 * action also opens the diff behind it.
 * @param label - what it does, for the tooltip and the screen reader.
 * @param glyph - the character to show.
 * @param act - what to run.
 * @returns the button.
 */
function rowAction(label: string, glyph: string, act: () => Promise<unknown>): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'row-action'
  button.title = label
  button.setAttribute('aria-label', label)
  button.textContent = glyph
  button.addEventListener('click', (event) => {
    event.stopPropagation()
    void act()
  })
  return button
}
```

Used per section — untracked paths go to discard's `untracked` argument and tracked ones to `tracked`, which is the distinction Task 1 exists for:

```ts
    const actions = document.createElement('span')
    actions.className = 'row-actions'
    const one = [entry.path]
    if (group.section === 'staged') {
      actions.append(rowAction('Unstage', '−', () => window.pane.unstageFiles(repo.path, one)))
    } else {
      actions.append(rowAction('Stage', '+', () => window.pane.stageFiles(repo.path, one)))
      const tracked = group.section === 'untracked' ? [] : one
      const untracked = group.section === 'untracked' ? one : []
      actions.append(rowAction('Discard', '↺', () => window.pane.discardFiles(repo.path, tracked, untracked)))
    }
    row.append(actions)
```

- [ ] **Step 5b: The same actions on the right-click menu**

The spec asks for them on hover *and* in the right-click menu, because hover is unreachable from the keyboard and invisible on a trackpad until you are already over the row. The tree's menu is native and lives in main (`treeMenu` in `src/main/tree-menu.ts`, popped by `popTreeMenu`); this one follows it rather than inventing an in-page menu.

Add to `src/main/tree-menu.ts`:

```ts
/** What a right-click on a git row offers. */
export type GitRowAction = 'stage' | 'unstage' | 'discard' | 'open-diff'

/**
 * The menu for one row of the git panel.
 *
 * Staging a staged row and unstaging an unstaged one are both nonsense, so
 * each row offers only the direction it can go.
 * @param section - which list the row is in.
 * @returns the items to show, in order.
 */
export function gitRowMenu(section: 'staged' | 'changed' | 'untracked'): TreeMenuItem[] {
  return [
    { action: 'open-diff', label: 'Open Diff' },
    { separator: true },
    ...(section === 'staged'
      ? ([{ action: 'unstage', label: 'Unstage' }] as TreeMenuItem[])
      : ([{ action: 'stage', label: 'Stage' }, { action: 'discard', label: 'Discard…' }] as TreeMenuItem[])),
  ]
}
```

with tests asserting a staged row offers Unstage and neither Stage nor Discard, and a changed row the reverse. Widen `TreeAction` to include the four, pop it from a `git:row-menu` handler beside `pane:tree-menu`, and call it from the row's `contextmenu` listener.

- [ ] **Step 5c: The per-repo actions**

The repo header carries **Stage All**, **Unstage All** and **Discard All**, which the spec names alongside the row actions. Each acts on every path in the matching sections, and Discard All names the count in its confirmation rather than a filename — which Task 7's handler already does when it is given more than one path.

```ts
  head.append(
    rowAction('Stage all', '+', () =>
      window.pane.stageFiles(repo.path, [...repo.status.changed, ...repo.status.untracked].map((e) => e.path)),
    ),
  )
  head.append(rowAction('Unstage all', '−', () => window.pane.unstageFiles(repo.path, repo.status.staged.map((e) => e.path))))
  head.append(
    rowAction('Discard all', '↺', () =>
      window.pane.discardFiles(
        repo.path,
        repo.status.changed.map((e) => e.path),
        repo.status.untracked.map((e) => e.path),
      ),
    ),
  )
```

- [ ] **Step 6: Wire the commit button**

```ts
el('commit-form').addEventListener('submit', (event) => {
  event.preventDefault()
  const box = el('commit-message') as HTMLTextAreaElement
  const repo = onlyRepo()
  if (repo === undefined) return
  void window.pane.commitFiles(
    repo.path,
    box.value,
    selection.selected(repo.path, repo.status),
    repo.status.staged.map((entry) => entry.path),
  ).then((out) => {
    if (out.ok) box.value = ''
    else say(out.reason)
  })
})
```

`onlyRepo()` returns the single repository when there is one and, when there are several, the one whose section the message box sits under — the commit box is drawn per repository in that case, since a message means nothing across two.

- [ ] **Step 7: Style them**

Ticks are 13px, aligned with the icon column. Row actions sit at the row's end before the status letter, `opacity: 0`, becoming visible on `.row:hover` and `.row:focus-within`. The commit box is a textarea that grows to four rows and no further; the button is disabled while the message is blank or nothing is ticked, and says why in its `title`.

- [ ] **Step 8: Run and watch it pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
npm test && npx tsc -p tsconfig.json --noEmit && npx tsc -p tsconfig.pane.json --noEmit
git add -A
git commit -m "feat(git): tick files, act on a row, and commit"
```

---

### Task 9: The branch menu and the stashes

**Files:**
- Modify: `src/renderer/pane/git.ts`, `src/renderer/pane.css`, `src/main/index.ts`
- Test: `src/renderer/pane/git.spec.ts`

**Interfaces:**
- Consumes: `BranchRowView`, `StashRowView` (Task 5), the branch and stash channels (Task 7).

- [ ] **Step 1: Write the failing test**

```ts
it('offers to stash when a switch is blocked, naming what is in the way', async () => {
  const bridge = stubBridge({ repos: [repoWith({ branches: [{ name: 'feature', upstream: '', current: false, remote: false }] })] })
  bridge.checkoutOutcome = { ok: false, reason: 'error: local changes', blocked: ['a.ts'] }
  await load(bridge)
  await pickBranch('feature')
  const offer = document.querySelector('.branch-blocked')
  expect(offer?.textContent).toContain('a.ts')
  ;(offer?.querySelector('button') as HTMLButtonElement).click()
  await Promise.resolve()
  expect(bridge.stashPushCalls.length).toBe(1)
  expect(bridge.checkoutCalls.length).toBe(2)
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run src/renderer/pane/git.spec.ts`
Expected: FAIL — no `.branch-blocked`.

- [ ] **Step 3: Make the branch name a control**

The repo header's branch tag becomes a `<button>` opening a list: local branches first with the current one marked, remote-tracking ones under a divider, then **New branch…**, which swaps the header for a text input that commits on Enter and cancels on Escape.

Choosing a branch calls `checkout`. On `{ ok: false, blocked }`, the header shows a `.branch-blocked` note naming those files and carrying one button, **Stash and switch**, which calls `stashPush` with the message `Switching to <name>`, then `checkout` again, then `stashApply(ref, true)` on the far side. Any failure in that chain stops it and says which step failed — a half-done switch that reports success is worse than one that stops.

On `{ ok: false }` with no `blocked`, the reason is shown and nothing else happens.

- [ ] **Step 4: Draw the stashes**

A **Stashes** section per repository, drawn only when `repo.stashes` is non-empty, below the file sections. Each row is the message, the branch it was made on dimmed after it, and three buttons on hover: **Apply**, **Pop**, **Drop**. A **Stash** button sits in the repo header beside the branch, prompting for an optional message inline in the same way New branch does.

- [ ] **Step 5: Run and watch it pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: See the whole thing work**

```bash
npm run pack
```

Quit any running copy first — closing the window hides the app to the tray, and the single-instance lock will otherwise make the new one exit immediately. Then, in a scratch repository: tick and untick files, stage and unstage one from its row, discard one and confirm the dialog names it, write a message and commit, stash with a message and pop it back, create a branch, switch to it, and — with an uncommitted change in the way — confirm the blocked note names the file and that Stash and switch completes.

- [ ] **Step 7: Document it**

Update the README's git paragraph: what the ticks mean and that they are not the index, that Commit stages what is ticked, that Discard and Drop are confirmed and unrecoverable, that branches switch by attempting and offer to stash when refused, and that fetch/pull/push are still to come.

- [ ] **Step 8: Commit**

```bash
npm test && npx tsc -p tsconfig.json --noEmit && npx tsc -p tsconfig.pane.json --noEmit
git add -A
git commit -m "feat(git): switch branches, and keep a stash"
```

---

## What plan 2 does not do

Fetch, pull, push, ahead/behind refreshed from a remote, and the credential failure surface — `GIT_TERMINAL_PROMPT=0` and its three companions are already in `git-run.ts`, but nothing yet reaches the network. Plan 3 covers them. Also still out, and unchanged from the spec: merge conflict resolution, history and blame, submodules, commit amend, and force push.
