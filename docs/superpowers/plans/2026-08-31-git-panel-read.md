# Git Panel (read) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A git button on the rail that opens a panel listing the changed files in the project's repositories, where clicking a file shows its diff inline in the editor column.

**Architecture:** Every git operation shells out to the user's own `git` binary through one module in main. Parsing `git status --porcelain=2 -z --branch` is a pure function that spawns nothing, so it is table-driven against recorded bytes. The renderer is a view: it receives a structure over IPC and draws it. The panel shares the side column with the file tree, the way Explorer and Source Control share one VS Code sidebar.

**Tech Stack:** TypeScript, Electron 33 (`WebContentsView`), Vitest, esbuild for the renderer bundles, Monaco for the diff.

**Spec:** [`docs/notes/git-panel.md`](../../notes/git-panel.md)

**Scope:** This is plan 1 of 3. It delivers the read-only panel. Plan 2 adds the checkbox selection, stage/unstage/discard and commit; plan 3 adds fetch/pull/push and the credential failure surface. Both build on what this produces and neither is assumed by it.

## Global Constraints

- **Never spawn `git` outside `git-run.ts`.** Every call goes through it, so the environment below cannot be forgotten at one call site.
- **Every git child gets:** `GIT_TERMINAL_PROMPT=0`, `GIT_SSH_COMMAND` containing `-o BatchMode=yes`, `SSH_ASKPASS_REQUIRE=never`, and no `GIT_ASKPASS`. Copied verbatim from the spec's *Failing loudly*.
- **No git logic in `src/renderer/**`.** Main turns bytes into structure; the renderer draws. `src/renderer/pane/**` is excluded from `tsconfig.json` and is the half that cannot be unit-tested the same way.
- **Renderer never imports from `src/main/`, and main never imports from `src/renderer/`.** This boundary is enforced by convention throughout the repo; do not break it.
- **JSDoc on every export**, stating the reasoning that is not recoverable from the code. Comments state facts and consequences, not narration. This is the project's stated convention.
- **Prove tests non-vacuous.** When a test guards something important, break the code deliberately and confirm the test fails before moving on.
- **Run `npm test` and `npx tsc -p tsconfig.json --noEmit && npx tsc -p tsconfig.pane.json --noEmit` before every commit.**
- **There is no formatter configured.** Do not run `prettier`; it is not a dependency and will reformat whole files.

## File Structure

**Created:**

| File | Responsibility |
| --- | --- |
| `src/main/git-run.ts` | The only place a git child is spawned. Environment, cwd, timeout, exit code and streams. |
| `src/main/git-status.ts` | Pure. Porcelain v2 `-z` bytes in, `RepoStatus` out. Spawns nothing. |
| `src/main/git-find.ts` | Locate the binary; discover repos in a project, one level down. |
| `src/main/git-model.ts` | Ties the three together: refresh a repo, produce the two sides of a diff. |
| `src/renderer/git.html` | The panel's page. |
| `src/renderer/pane/git.ts` | The panel's view. Draws what main sends; no git knowledge. |
| `src/renderer/pane/git-rows.ts` | Pure grouping and sorting for the rows. |

**Modified:** `src/main/window.ts` (a `git` view), `src/main/index.ts` (IPC, rail wiring, menu item), `src/main/layout.ts` (the side column's chosen view), `src/preload/pane.ts`, `src/renderer/pane/bridge.ts`, `src/renderer/shell.html` and `shell.js` (rail button), `src/renderer/pane/editor.ts` and `monaco-surface.ts` (the diff changes), `package.json` (bundle the new entry point), `README.md`.

---

### Task 1: Spawning git, once

**Files:**
- Create: `src/main/git-run.ts`
- Test: `src/main/git-run.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `runGit(cwd: string, args: string[], gitPath?: string): Promise<GitResult>` where `interface GitResult { code: number; stdout: Buffer; stderr: string }`. Also `gitEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv`.

- [ ] **Step 1: Write the failing test for the environment**

```ts
import { describe, expect, it } from 'vitest'
import { gitEnv } from './git-run'

describe('gitEnv', () => {
  // reason: without all four, an unattended git blocks forever on a prompt
  // that has no terminal to appear in, holding the panel on a spinner.
  it('stops git and ssh asking for anything', () => {
    const env = gitEnv({ PATH: '/usr/bin' })
    expect(env.GIT_TERMINAL_PROMPT).toBe('0')
    expect(env.GIT_SSH_COMMAND).toContain('BatchMode=yes')
    expect(env.SSH_ASKPASS_REQUIRE).toBe('never')
    expect(env.GIT_ASKPASS).toBeUndefined()
  })

  it('keeps the rest of the environment, which is where PATH lives', () => {
    expect(gitEnv({ PATH: '/usr/bin', HOME: '/h' }).PATH).toBe('/usr/bin')
  })

  // reason: an askpass inherited from the user's own shell would reintroduce
  // the GUI prompt the other three variables exist to prevent.
  it('drops an inherited GIT_ASKPASS', () => {
    expect(gitEnv({ GIT_ASKPASS: '/usr/bin/x' }).GIT_ASKPASS).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/main/git-run.spec.ts`
Expected: FAIL — `Failed to resolve import "./git-run"`.

- [ ] **Step 3: Write `git-run.ts`**

```ts
import { execFile } from 'node:child_process'

/** What one git invocation reported back. */
export interface GitResult {
  code: number
  /** Raw, because porcelain `-z` output is NUL-delimited and not always UTF-8. */
  stdout: Buffer
  stderr: string
}

/** How long a git call may take before it is killed. */
const TIMEOUT_MS = 30_000

/**
 * The environment every git child runs in.
 *
 * All four entries are load-bearing. Without `GIT_TERMINAL_PROMPT` git blocks
 * asking for a username on a terminal this app does not have; without the ssh
 * pair it asks for a key passphrase instead, or raises a GUI prompt — and an
 * askpass inherited from the user's own shell would do the same. This app
 * deliberately supplies no askpass of its own: a credential it never sees is
 * one it cannot leak, which is the same choice the MCP token store made.
 * @param base - the environment to derive from, normally `process.env`.
 * @returns the environment for the child.
 */
export function gitEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...base, GIT_TERMINAL_PROMPT: '0', SSH_ASKPASS_REQUIRE: 'never' }
  env.GIT_SSH_COMMAND = `${base.GIT_SSH_COMMAND ?? 'ssh'} -o BatchMode=yes`
  delete env.GIT_ASKPASS
  return env
}

/**
 * Run git, and report what it said.
 *
 * The only place in this app a git child is started, so the environment above
 * cannot be forgotten at one call site out of twenty. A non-zero exit is a
 * result rather than a throw: git says why on stderr, and the panel shows it.
 * @param cwd - the working directory, normally a repository.
 * @param args - the arguments, without the program name.
 * @param gitPath - the binary to run; `git` from `PATH` by default.
 * @returns the exit code and both streams.
 */
export async function runGit(cwd: string, args: string[], gitPath = 'git'): Promise<GitResult> {
  return await new Promise<GitResult>((resolve) => {
    execFile(
      gitPath,
      args,
      { cwd, env: gitEnv(process.env), timeout: TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : ((error as NodeJS.ErrnoException & { code?: number }).code ?? 1)
        resolve({
          code: typeof code === 'number' ? code : 1,
          stdout: stdout as unknown as Buffer,
          stderr: (stderr as unknown as Buffer).toString('utf8'),
        })
      },
    )
  })
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run src/main/git-run.spec.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Add the test that runs a real git**

Append to `src/main/git-run.spec.ts`:

```ts
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runGit } from './git-run'

describe('runGit', () => {
  it('reports what git said, and its exit code', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'git-run-'))
    expect((await runGit(dir, ['init', '-q'])).code).toBe(0)
    writeFileSync(join(dir, 'a.txt'), 'a\n')
    const status = await runGit(dir, ['status', '--porcelain'])
    expect(status.code).toBe(0)
    expect(status.stdout.toString('utf8')).toContain('a.txt')
  })

  // reason: a failure is a result the panel shows, not an exception it has to
  // catch at every call site.
  it('returns a non-zero code rather than throwing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'git-run-'))
    const out = await runGit(dir, ['rev-parse', 'HEAD'])
    expect(out.code).not.toBe(0)
    expect(out.stderr).not.toBe('')
  })
})
```

- [ ] **Step 6: Run the whole file**

Run: `npx vitest run src/main/git-run.spec.ts`
Expected: PASS, 5 tests. If git is not installed the last two fail — that is correct; install git.

- [ ] **Step 7: Prove the environment test is not vacuous**

Delete the `delete env.GIT_ASKPASS` line, run the file, and confirm "drops an inherited GIT_ASKPASS" fails. Put it back.

- [ ] **Step 8: Commit**

```bash
npm test && npx tsc -p tsconfig.json --noEmit
git add src/main/git-run.ts src/main/git-run.spec.ts
git commit -m "feat(git): run git in one place, where it cannot ask for anything"
```

---

### Task 2: Reading a repository's status

**Files:**
- Create: `src/main/git-status.ts`
- Test: `src/main/git-status.spec.ts`

**Interfaces:**
- Consumes: nothing. This module spawns nothing and imports nothing from `git-run`.
- Produces:

```ts
export type Section = 'staged' | 'changed' | 'untracked'
export interface GitEntry { path: string; status: string; from?: string }
export interface RepoStatus {
  branch: string
  ahead: number
  behind: number
  staged: GitEntry[]
  changed: GitEntry[]
  untracked: GitEntry[]
}
export function parseStatus(stdout: Buffer): RepoStatus
```

- [ ] **Step 1: Write the failing tests**

`git status --porcelain=2 -z --branch` emits NUL-terminated records. A `1` record is an ordinary change, `2` a rename — **and a rename carries its original path as an extra NUL-delimited field after the record**, which is the single detail this parser most easily gets wrong. `?` is untracked. The `XY` field is two letters: `X` is the staged state, `Y` the unstaged one, and `.` means unchanged.

```ts
import { describe, expect, it } from 'vitest'
import { parseStatus } from './git-status'

/** Records as git writes them: NUL-terminated, no trailing newline. */
const bytes = (...records: string[]): Buffer => Buffer.from(records.map((r) => `${r}\0`).join(''), 'utf8')

const HASH = '78981922613b2afb6025042ff6bd878ac1994e85'

describe('parseStatus', () => {
  it('reads the branch and how far it has diverged', () => {
    const status = parseStatus(bytes('# branch.head main', '# branch.ab +2 -3'))
    expect(status.branch).toBe('main')
    expect(status.ahead).toBe(2)
    expect(status.behind).toBe(3)
  })

  // reason: a detached HEAD reports this literally, and it is a state to show
  // rather than a name to print as though it were a branch.
  it('reports a detached HEAD as it is, with no divergence', () => {
    const status = parseStatus(bytes('# branch.head (detached)'))
    expect(status.branch).toBe('(detached)')
    expect(status.ahead).toBe(0)
    expect(status.behind).toBe(0)
  })

  it('puts a staged change in staged and an unstaged one in changed', () => {
    const status = parseStatus(
      bytes(
        `1 M. N... 100644 100644 100644 ${HASH} ${HASH} staged.ts`,
        `1 .M N... 100644 100644 100644 ${HASH} ${HASH} changed.ts`,
      ),
    )
    expect(status.staged).toEqual([{ path: 'staged.ts', status: 'M' }])
    expect(status.changed).toEqual([{ path: 'changed.ts', status: 'M' }])
  })

  // reason: a file staged and then edited again is in both, and they mean
  // different content — the recorded version and the edits made since.
  it('lists a file that is both staged and edited in both sections', () => {
    const status = parseStatus(bytes(`1 MM N... 100644 100644 100644 ${HASH} ${HASH} both.ts`))
    expect(status.staged).toEqual([{ path: 'both.ts', status: 'M' }])
    expect(status.changed).toEqual([{ path: 'both.ts', status: 'M' }])
  })

  // reason: a rename record carries its original path as an EXTRA
  // NUL-delimited field. A parser that splits on NUL and treats every field
  // as a record reads that path as a record of its own and produces garbage.
  it('reads a rename without mistaking its old path for another record', () => {
    const status = parseStatus(
      bytes(`2 R. N... 100644 100644 100644 ${HASH} ${HASH} R100 new.ts`, 'old.ts', '? untracked.ts'),
    )
    expect(status.staged).toEqual([{ path: 'new.ts', status: 'R', from: 'old.ts' }])
    expect(status.untracked).toEqual([{ path: 'untracked.ts', status: '?' }])
  })

  it('collects untracked files, and ignores ignored ones', () => {
    const status = parseStatus(bytes('? new.ts', '! ignored.ts'))
    expect(status.untracked).toEqual([{ path: 'new.ts', status: '?' }])
  })

  // reason: an unmerged path is neither staged nor merely changed, and
  // dropping it would show a conflicted repo as clean.
  it('reports an unmerged path as a conflict in changed', () => {
    const status = parseStatus(
      bytes(`u UU N... 100644 100644 100644 100644 ${HASH} ${HASH} ${HASH} conflict.ts`),
    )
    expect(status.changed).toEqual([{ path: 'conflict.ts', status: 'U' }])
  })

  it('reads a clean repository as clean', () => {
    const status = parseStatus(bytes('# branch.head main'))
    expect(status.staged).toEqual([])
    expect(status.changed).toEqual([])
    expect(status.untracked).toEqual([])
  })

  // reason: a path may contain a space, and every field before it is fixed —
  // so the path is what remains, not the last word.
  it('keeps a path that contains spaces whole', () => {
    const status = parseStatus(bytes(`1 .M N... 100644 100644 100644 ${HASH} ${HASH} a file.ts`))
    expect(status.changed).toEqual([{ path: 'a file.ts', status: 'M' }])
  })
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run src/main/git-status.spec.ts`
Expected: FAIL — cannot resolve `./git-status`.

- [ ] **Step 3: Write `git-status.ts`**

```ts
/** Which list an entry belongs in. */
export type Section = 'staged' | 'changed' | 'untracked'

/** One changed path, as the panel shows it. */
export interface GitEntry {
  path: string
  /** The porcelain letter: `M`, `A`, `D`, `R`, `C`, `U`, or `?`. */
  status: string
  /** Where a rename came from. */
  from?: string
}

/** A repository's state, as the panel draws it. */
export interface RepoStatus {
  branch: string
  ahead: number
  behind: number
  staged: GitEntry[]
  changed: GitEntry[]
  untracked: GitEntry[]
}

/** How many fixed fields precede the path in a `1` record. */
const ORDINARY_FIELDS = 8

/** How many precede it in a `2` record, which carries a rename score. */
const RENAME_FIELDS = 9

/** How many precede it in a `u` record, which carries three stages. */
const UNMERGED_FIELDS = 10

/**
 * The path at the end of a record, kept whole.
 *
 * Everything before it is a fixed number of space-separated fields, so the
 * path is what remains rather than the last word — a path may contain spaces,
 * and splitting on them would truncate it.
 * @param record - one porcelain record, without its NUL.
 * @param fields - how many fields precede the path.
 * @returns the path.
 */
function pathAfter(record: string, fields: number): string {
  let at = 0
  for (let field = 0; field < fields; field += 1) at = record.indexOf(' ', at) + 1
  return record.slice(at)
}

/**
 * Read `git status --porcelain=2 -z --branch`.
 *
 * Pure, and given bytes rather than a string: the output is NUL-delimited,
 * and a path is bytes the filesystem accepted rather than anything guaranteed
 * to be text. Nothing here spawns git, which is what lets every shape below
 * be tested against recorded output.
 *
 * A `2` record carries its original path as a further NUL-delimited field, so
 * the walk consumes two fields for one entry; a parser that treats every
 * field as a record reads that path as an entry of its own.
 * @param stdout - what git wrote.
 * @returns the repository's state.
 */
export function parseStatus(stdout: Buffer): RepoStatus {
  const status: RepoStatus = { branch: '', ahead: 0, behind: 0, staged: [], changed: [], untracked: [] }
  const records = stdout.toString('utf8').split('\0')
  for (let at = 0; at < records.length; at += 1) {
    const record = records[at]
    if (record === '') continue
    if (record.startsWith('# branch.head ')) {
      status.branch = record.slice('# branch.head '.length)
    } else if (record.startsWith('# branch.ab ')) {
      const [ahead, behind] = record.slice('# branch.ab '.length).split(' ')
      status.ahead = Number.parseInt(ahead, 10)
      status.behind = Number.parseInt(behind, 10)
    } else if (record.startsWith('1 ')) {
      const [staged, unstaged] = [record[2], record[3]]
      const path = pathAfter(record, ORDINARY_FIELDS)
      if (staged !== '.') status.staged.push({ path, status: staged })
      if (unstaged !== '.') status.changed.push({ path, status: unstaged })
    } else if (record.startsWith('2 ')) {
      const [staged, unstaged] = [record[2], record[3]]
      const path = pathAfter(record, RENAME_FIELDS)
      // The original path is the next field, not the next record.
      at += 1
      const from = records[at]
      if (staged !== '.') status.staged.push({ path, status: staged, from })
      if (unstaged !== '.') status.changed.push({ path, status: unstaged, from })
    } else if (record.startsWith('u ')) {
      // Neither staged nor merely changed: a conflict is shown as one.
      status.changed.push({ path: pathAfter(record, UNMERGED_FIELDS), status: 'U' })
    } else if (record.startsWith('? ')) {
      status.untracked.push({ path: record.slice(2), status: '?' })
    }
    // `!` is ignored, and ignored files are not shown.
  }
  return status
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `npx vitest run src/main/git-status.spec.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Prove the rename test is not vacuous**

Delete the `at += 1` line. Run the file. "reads a rename without mistaking its old path for another record" must fail. Put it back.

- [ ] **Step 6: Check the parser against a real repository**

```bash
cd /tmp && rm -rf gp && mkdir gp && cd gp && git init -q \
  && git config user.email t@t && git config user.name t \
  && echo a > a.txt && git add a.txt && git commit -qm one \
  && git mv a.txt r.txt && echo new > u.txt \
  && git status --porcelain=2 -z --branch | tr '\0' '\n'
```

Confirm the shape matches the fixtures: a `2 RM …` record followed by the old path on its own line, then `? u.txt`. If your git differs, update the fixtures to what it actually emits — the recorded bytes are the contract.

- [ ] **Step 7: Commit**

```bash
npm test && npx tsc -p tsconfig.json --noEmit
git add src/main/git-status.ts src/main/git-status.spec.ts
git commit -m "feat(git): read porcelain v2, including the rename's extra field"
```

---

### Task 3: Finding git, and finding the repositories

**Files:**
- Create: `src/main/git-find.ts`
- Test: `src/main/git-find.spec.ts`

**Interfaces:**
- Consumes: `runGit` from Task 1.
- Produces: `findRepos(root: string): string[]` and `hasGit(gitPath?: string): Promise<boolean>`.

- [ ] **Step 1: Write the failing test**

```ts
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { findRepos } from './git-find'

/** A temporary tree with a `.git` directory at each named path. */
function tree(...repos: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'git-find-'))
  for (const repo of repos) mkdirSync(join(root, repo, '.git'), { recursive: true })
  return root
}

describe('findRepos', () => {
  it('finds a repository at the root itself', () => {
    const root = tree('.')
    expect(findRepos(root)).toEqual([root])
  })

  it('finds repositories one level down when the root is not one', () => {
    const root = tree('alpha', 'beta')
    expect(findRepos(root).sort()).toEqual([join(root, 'alpha'), join(root, 'beta')])
  })

  // reason: a project that is itself a repository and holds checkouts is the
  // case that prompted scanning at all.
  it('finds the root and its children together', () => {
    const root = tree('.', 'inner')
    expect(findRepos(root).sort()).toEqual([root, join(root, 'inner')].sort())
  })

  // reason: a dependency tree holds hundreds of repositories nobody is
  // working in, and scanning it is slow as well as wrong.
  it('never looks inside node_modules', () => {
    const root = tree('node_modules/pkg')
    expect(findRepos(root)).toEqual([])
  })

  // reason: one level is the scan depth; deeper is a different feature.
  it('does not look two levels down', () => {
    const root = tree('outer/inner')
    expect(findRepos(root)).toEqual([])
  })

  it('reports nothing for a directory with no repositories', () => {
    expect(findRepos(tree())).toEqual([])
  })

  it('reports nothing for a path that does not exist', () => {
    expect(findRepos('/nowhere/at/all')).toEqual([])
  })
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run src/main/git-find.spec.ts`
Expected: FAIL — cannot resolve `./git-find`.

- [ ] **Step 3: Write `git-find.ts`**

```ts
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
```

- [ ] **Step 4: Run and watch it pass**

Run: `npx vitest run src/main/git-find.spec.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Prove the node_modules test is not vacuous**

Remove `'node_modules'` from `SKIP`, run, confirm "never looks inside node_modules" fails. Put it back.

- [ ] **Step 6: Commit**

```bash
npm test && npx tsc -p tsconfig.json --noEmit
git add src/main/git-find.ts src/main/git-find.spec.ts
git commit -m "feat(git): find the repositories in a project, one level down"
```

---

### Task 4: The model that ties them together

**Files:**
- Create: `src/main/git-model.ts`
- Test: `src/main/git-model.spec.ts`

**Interfaces:**
- Consumes: `runGit`/`GitResult` (Task 1), `parseStatus`/`RepoStatus`/`Section` (Task 2), `findRepos` (Task 3).
- Produces:

```ts
export interface Repo { path: string; name: string; status: RepoStatus }
export type ProjectGit =
  | { ok: true; repos: Repo[] }
  | { ok: false; reason: string }
export function readProject(root: string, run?: typeof runGit): Promise<ProjectGit>
export function diffSides(
  repo: string, path: string, section: Section, run?: typeof runGit,
): Promise<{ ok: true; original: string; modified: string } | { ok: false; reason: string }>
```

`run` is injected so the tests never spawn git.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from 'vitest'
import { diffSides, readProject } from './git-model'
import type { GitResult } from './git-run'

const ok = (out: string): GitResult => ({ code: 0, stdout: Buffer.from(out, 'utf8'), stderr: '' })
const fail = (why: string): GitResult => ({ code: 128, stdout: Buffer.alloc(0), stderr: why })

describe('diffSides', () => {
  // reason: which two things are compared depends on the section the row was
  // in, and getting it wrong shows a diff that is quietly about something
  // else — the most expensive kind of wrong.
  it('compares the index with the working tree for an unstaged change', async () => {
    const run = vi.fn(async () => ok('indexed\n'))
    const sides = await diffSides('/r', 'a.ts', 'changed', run)
    expect(run).toHaveBeenCalledWith('/r', ['show', ':a.ts'])
    expect(sides).toMatchObject({ ok: true, original: 'indexed\n' })
  })

  it('compares HEAD with the index for a staged change', async () => {
    const run = vi.fn(async () => ok('committed\n'))
    await diffSides('/r', 'a.ts', 'staged', run)
    expect(run).toHaveBeenCalledWith('/r', ['show', 'HEAD:a.ts'])
  })

  // reason: an untracked file has no previous version at all, and asking git
  // for one fails rather than returning nothing.
  it('compares an untracked file against nothing, without asking git', async () => {
    const run = vi.fn(async () => ok('unused'))
    const sides = await diffSides('/r', 'new.ts', 'untracked', run)
    expect(run).not.toHaveBeenCalled()
    expect(sides).toMatchObject({ ok: true, original: '' })
  })

  // reason: a file added and staged has no version in HEAD, which git reports
  // as an error — but "it is new" is the answer, not a failure.
  it('treats a missing previous version as empty rather than an error', async () => {
    const run = vi.fn(async () => fail("fatal: path 'a.ts' does not exist in 'HEAD'"))
    expect(await diffSides('/r', 'a.ts', 'staged', run)).toMatchObject({ ok: true, original: '' })
  })
})

describe('readProject', () => {
  it('says so when the project holds no repository', async () => {
    expect(await readProject('/nowhere/at/all', vi.fn(async () => ok('')))).toEqual({ ok: true, repos: [] })
  })

  // reason: the panel reports which repository failed and why; a git that
  // will not run is not a reason to show nothing at all.
  it('reports a repository git refused to read', async () => {
    const run = vi.fn(async () => fail('fatal: not a git repository'))
    const out = await readProject(process.cwd(), run)
    expect(out.ok).toBe(false)
  })
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run src/main/git-model.spec.ts`
Expected: FAIL — cannot resolve `./git-model`.

- [ ] **Step 3: Write `git-model.ts`**

```ts
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
```

- [ ] **Step 4: Run and watch it pass**

Run: `npx vitest run src/main/git-model.spec.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Prove the section test is not vacuous**

Change `section === 'staged' ? \`HEAD:${path}\` : \`:${path}\`` to always use `:${path}`. Confirm "compares HEAD with the index for a staged change" fails. Put it back.

- [ ] **Step 6: Commit**

```bash
npm test && npx tsc -p tsconfig.json --noEmit
git add src/main/git-model.ts src/main/git-model.spec.ts
git commit -m "feat(git): read a project's repositories, and a row's two sides"
```

---

### Task 5: A diff that takes both sides, and does not evict your tab

**Files:**
- Modify: `src/renderer/pane/editor.ts` (`showDiff`, around line 180), `src/renderer/pane/monaco-surface.ts:141`
- Test: `src/renderer/pane/editor.spec.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `Editor.showTexts(file: OpenFile, original: string, modified: string, inline: boolean): void`, and `documents.openDiff(original, proposed, name, inline: boolean)`. Task 8 calls `showTexts`.

Read the spec's *The diff* before starting: both changes below are behavioural, and the existing behaviour they change is deliberate.

- [ ] **Step 1: Write the failing tests**

Append inside the existing `describe('Editor', …)` in `src/renderer/pane/editor.spec.ts`:

```ts
  // reason: `showDiff` reads disk as the original because it was written for
  // an agent proposing a change. A git diff supplies both sides itself.
  describe('showTexts', () => {
    it('opens a diff from two texts, reading nothing from disk', async () => {
      const d = deps()
      const editor = await withOpen(d, FILE)
      d.readFile.mockClear()
      editor.showTexts({ root: '/p/demo', relative: 'x.ts' }, 'before', 'after', true)
      expect(d.readFile).not.toHaveBeenCalled()
      expect(editor.openTabs.some((tab) => tab.mode === 'diff')).toBe(true)
    })

    // reason: a file with unsaved edits is exactly when its diff is most
    // worth seeing. `showDiff` refuses in that case, to protect the user's
    // work from an agent's proposal; that rule does not apply here.
    it('leaves the editor tab open, and opens beside it even when dirty', async () => {
      const d = deps()
      const editor = await withOpen(d, FILE)
      const tab = editor.openTabs[0]
      ;(tab.document as unknown as { buffer: string }).buffer = 'edited'
      editor.showTexts(FILE, 'before', 'after', true)
      expect(editor.openTabs.length).toBe(2)
      expect(editor.openTabs.filter((each) => each.mode === 'diff').length).toBe(1)
      expect(editor.openTabs.some((each) => each.mode === 'file')).toBe(true)
    })

    it('replaces its own diff tab rather than stacking them up', async () => {
      const editor = await withOpen(deps(), FILE)
      editor.showTexts(FILE, 'a', 'b', true)
      editor.showTexts(FILE, 'c', 'd', true)
      expect(editor.openTabs.filter((each) => each.mode === 'diff').length).toBe(1)
    })
  })
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run src/renderer/pane/editor.spec.ts`
Expected: FAIL — `editor.showTexts is not a function`.

- [ ] **Step 3: Give diff tabs their own identity**

In `src/renderer/pane/editor.ts`, tabs are found by file. A diff tab and a file tab for the same path must now coexist, so the lookup takes the mode into account. Add beside `find`:

```ts
  /**
   * The tab for one file in one mode.
   *
   * A file may have an editor tab and a git diff tab open at once, so the
   * mode is part of a tab's identity: looking one up by path alone would
   * return whichever was opened first and close the wrong one.
   * @param file - the file to look for.
   * @param mode - which of its tabs is wanted.
   * @returns the tab, or undefined.
   */
  private findIn(file: OpenFile, mode: Tab['mode']): Tab | undefined {
    return this.tabs.find(
      (tab) => tab.file.root === file.root && tab.file.relative === file.relative && tab.mode === mode,
    )
  }
```

- [ ] **Step 4: Add `showTexts`**

```ts
  /**
   * Show a diff between two texts the caller already has.
   *
   * Unlike `showDiff`, neither side is read from disk and the file's own
   * editor tab is left alone — a git diff is a second view of a file rather
   * than a proposal to replace what the user is editing, so it neither
   * closes that tab nor refuses because it has unsaved edits.
   * @param file - which file the diff is about.
   * @param original - the left-hand text.
   * @param modified - the right-hand text.
   * @param inline - true for one pane rather than two.
   */
  showTexts(file: OpenFile, original: string, modified: string, inline: boolean): void {
    const already = this.findIn(file, 'diff')
    if (already !== undefined) this.drop(already)
    this.add({
      file,
      document: this.deps.documents.openDiff(original, modified, file.relative, inline),
      saved: modified,
      mode: 'diff',
    })
  }
```

- [ ] **Step 5: Let the surface render inline**

In `src/renderer/pane/monaco-surface.ts:141`, `openDiff` takes a fourth argument and passes it through:

```ts
    openDiff: (original, proposed, name, inline = false) => {
      // …existing body…
      const editor = monaco.editor.createDiffEditor(element, {
        // …existing options…
        // One pane rather than two: a git diff is read the way a patch is.
        renderSideBySide: !inline,
      })
```

Update the `openDiff` signature in the `documents` interface (`editor.ts:49`) to `openDiff(original: string, proposed: string, name: string, inline?: boolean): Document`, and add the fourth parameter to the fake in `editor.spec.ts`'s `deps()`.

- [ ] **Step 6: Run and watch them pass**

Run: `npx vitest run src/renderer/pane/editor.spec.ts`
Expected: PASS. The existing `showDiff` tests must still pass unchanged — if any fail, you have altered the agent's proposal behaviour, which this task must not do.

- [ ] **Step 7: Prove the identity test is not vacuous**

Make `showTexts` call `this.find(file)` instead of `this.findIn(file, 'diff')`. Confirm "leaves the editor tab open" fails. Put it back.

- [ ] **Step 8: Commit**

```bash
npm test && npx tsc -p tsconfig.json --noEmit && npx tsc -p tsconfig.pane.json --noEmit
git add src/renderer/pane/editor.ts src/renderer/pane/editor.spec.ts src/renderer/pane/monaco-surface.ts
git commit -m "feat(editor): diff two texts inline, beside the tab being edited"
```

---

### Task 6: The rows, as pure functions

**Files:**
- Create: `src/renderer/pane/git-rows.ts`
- Test: `src/renderer/pane/git-rows.spec.ts`

**Interfaces:**
- Consumes: the `RepoStatus` shape from Task 2, redeclared locally — the renderer must not import from `src/main/`.
- Produces: `rowsFor(status: RepoStatusView): RowGroup[]`, `label(entry: EntryView): string`, `colourOf(status: string): string`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { colourOf, label, rowsFor } from './git-rows'

const EMPTY = { branch: 'main', ahead: 0, behind: 0, staged: [], changed: [], untracked: [] }

describe('rowsFor', () => {
  it('groups the three sections in the order they are read', () => {
    const groups = rowsFor({
      ...EMPTY,
      staged: [{ path: 'a.ts', status: 'M' }],
      changed: [{ path: 'b.ts', status: 'M' }],
      untracked: [{ path: 'c.ts', status: '?' }],
    })
    expect(groups.map((group) => group.section)).toEqual(['staged', 'changed', 'untracked'])
  })

  // reason: an empty heading is noise in a panel read at a glance.
  it('leaves out a section with nothing in it', () => {
    expect(rowsFor({ ...EMPTY, changed: [{ path: 'b.ts', status: 'M' }] }).map((g) => g.section)).toEqual(['changed'])
  })

  it('sorts by path, so a row does not move as the status changes', () => {
    const groups = rowsFor({
      ...EMPTY,
      changed: [{ path: 'z.ts', status: 'M' }, { path: 'a.ts', status: 'D' }],
    })
    expect(groups[0].entries.map((entry) => entry.path)).toEqual(['a.ts', 'z.ts'])
  })
})

describe('label', () => {
  it('shows the filename, with its directory after it', () => {
    expect(label({ path: 'src/main/a.ts', status: 'M' })).toBe('a.ts src/main')
  })

  it('shows a file at the root with no directory', () => {
    expect(label({ path: 'a.ts', status: 'M' })).toBe('a.ts')
  })

  // reason: a rename that only moved a file says nothing useful unless it
  // says where from.
  it('says where a rename came from', () => {
    expect(label({ path: 'b.ts', status: 'R', from: 'a.ts' })).toBe('b.ts ← a.ts')
  })
})

describe('colourOf', () => {
  it('gives each status its own colour, and an unknown one the default', () => {
    expect(new Set(['A', 'M', 'D', '?'].map(colourOf)).size).toBe(4)
    expect(colourOf('X')).toBe(colourOf('M'))
  })
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run src/renderer/pane/git-rows.spec.ts`
Expected: FAIL — cannot resolve `./git-rows`.

- [ ] **Step 3: Write `git-rows.ts`**

```ts
/** One changed path, as the panel receives it. */
export interface EntryView {
  path: string
  status: string
  from?: string
}

/** A repository's state, as the panel receives it. */
export interface RepoStatusView {
  branch: string
  ahead: number
  behind: number
  staged: EntryView[]
  changed: EntryView[]
  untracked: EntryView[]
}

/** One section of a repository's rows. */
export interface RowGroup {
  section: 'staged' | 'changed' | 'untracked'
  title: string
  entries: EntryView[]
}

/** What each section is called, in the order they are read. */
const SECTIONS = [
  { section: 'staged' as const, title: 'Staged Changes' },
  { section: 'changed' as const, title: 'Changes' },
  { section: 'untracked' as const, title: 'Untracked' },
]

/**
 * The sections to draw for one repository.
 *
 * Sorted by path rather than by status, so a row does not jump as a file is
 * edited — a list that reorders under the pointer is one you click wrong.
 * An empty section is left out entirely: a heading with nothing under it is
 * noise in a panel that is read at a glance.
 * @param status - the repository's state.
 * @returns the sections that have anything in them.
 */
export function rowsFor(status: RepoStatusView): RowGroup[] {
  return SECTIONS.map(({ section, title }) => ({
    section,
    title,
    entries: [...status[section]].sort((left, right) => left.path.localeCompare(right.path)),
  })).filter((group) => group.entries.length > 0)
}

/**
 * How one row reads: the filename first, its directory after it.
 *
 * The name is what is being looked for and the directory is what
 * disambiguates it, which is the order VS Code uses and the reason it scans.
 * @param entry - the changed path.
 * @returns the row's text.
 */
export function label(entry: EntryView): string {
  const at = entry.path.lastIndexOf('/')
  const name = at === -1 ? entry.path : entry.path.slice(at + 1)
  if (entry.from !== undefined) return `${name} ← ${entry.from}`
  return at === -1 ? name : `${name} ${entry.path.slice(0, at)}`
}

/** The token each status is drawn in, defaulting to the modified colour. */
const COLOURS: Record<string, string> = {
  A: 'var(--dsh-git-added)',
  M: 'var(--dsh-git-modified)',
  D: 'var(--dsh-git-deleted)',
  '?': 'var(--dsh-git-untracked)',
}

/**
 * The colour for a status letter.
 * @param status - the porcelain letter.
 * @returns a CSS colour value.
 */
export function colourOf(status: string): string {
  return COLOURS[status] ?? COLOURS.M
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `npx vitest run src/renderer/pane/git-rows.spec.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
npm test && npx tsc -p tsconfig.pane.json --noEmit
git add src/renderer/pane/git-rows.ts src/renderer/pane/git-rows.spec.ts
git commit -m "feat(git): group and label the panel's rows"
```

---

### Task 7: The page, the view, and the rail button

**Files:**
- Create: `src/renderer/git.html`, `src/renderer/pane/git.ts`
- Modify: `src/main/window.ts` (a `git` view), `src/main/layout.ts` (which view the side column shows), `src/main/index.ts` (IPC, rail, menu), `src/preload/pane.ts`, `src/renderer/pane/bridge.ts`, `src/renderer/shell.html`, `src/renderer/shell.js`, `package.json`

**Interfaces:**
- Consumes: `readProject`/`ProjectGit` (Task 4), `rowsFor`/`label`/`colourOf` (Task 6).
- Produces: the IPC channels `git:read` (invoke, returns `ProjectGit`), `git:changed` (main → page, "refresh yourself"), and `git:open-diff` (page → main, `(repo, path, section)`), consumed by Task 8.

This task is wiring rather than logic, so its test is the one thing in it that can be got wrong silently: which view the side column shows.

- [ ] **Step 1: Write the failing test for the side column's view**

In `src/main/layout.spec.ts`:

```ts
  // reason: the tree and the git panel take turns in one column, so pressing
  // a rail button either switches the view or closes the column — pressing
  // git while git is showing must not leave the column open and empty.
  it('switches the side column between its two views, and closes on a repeat', () => {
    expect(nextSideView({ open: true, view: 'files' }, 'git')).toEqual({ open: true, view: 'git' })
    expect(nextSideView({ open: true, view: 'git' }, 'git')).toEqual({ open: false, view: 'git' })
    expect(nextSideView({ open: false, view: 'git' }, 'git')).toEqual({ open: true, view: 'git' })
    expect(nextSideView({ open: true, view: 'git' }, 'files')).toEqual({ open: true, view: 'files' })
  })
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run src/main/layout.spec.ts`
Expected: FAIL — `nextSideView is not a function`.

- [ ] **Step 3: Add `nextSideView` to `src/main/layout.ts`**

```ts
/** Which view the side column is showing. */
export type SideView = 'files' | 'git'

/**
 * What a rail button does to the side column.
 *
 * The tree and the git panel share one column, as Explorer and Source
 * Control share one VS Code sidebar. Pressing the button for the view
 * already showing closes the column; pressing the other one switches to it
 * without closing anything.
 * @param state - whether the column is open, and what it is showing.
 * @param pressed - the view whose rail button was pressed.
 * @returns the column's next state.
 */
export function nextSideView(
  state: { open: boolean; view: SideView },
  pressed: SideView,
): { open: boolean; view: SideView } {
  if (state.open && state.view === pressed) return { open: false, view: state.view }
  return { open: true, view: pressed }
}
```

Add `view: SideView` to the `files` entry of `Columns`, defaulting to `'files'` wherever columns are constructed or read from `desktop.json`.

- [ ] **Step 4: Run and watch it pass**

Run: `npx vitest run src/main/layout.spec.ts`
Expected: PASS.

- [ ] **Step 5: Add the view and the page**

In `src/main/window.ts`, beside `files`: a `git` `WebContentsView` with the same `webPreferences` as `files` (`contextIsolation: true`, `nodeIntegration: false`, `preload: pane.js`), added to `contentView` after `files`, and loaded up front with `void git.webContents.loadURL(\`${PANE_ORIGIN}/git.html\`)` — for the reason already stated there: an unloaded view never finishes loading and an automation client attaching to the window waits on it. Add `git: WebContentsView` to `MainWindow`, and `git` to the `views` object.

`applyLayout` gives the `git` view the side column's rectangle when `columns.files.view === 'git'`, and gives `files` a zero-size rectangle then — whichever is not showing gets no space rather than being hidden by CSS.

`src/renderer/git.html` mirrors `files.html`: the same stylesheet links, a `<main id="repos">`, and `<script src="./git-bundle.js"></script>`.

In `package.json`'s `build:pane`, add an esbuild entry for `src/renderer/pane/git.ts` → `dist/renderer/git-bundle.js`, with the same flags as `files.ts`. In `build:renderer`, add `src/renderer/git.html` to the copied files.

- [ ] **Step 6: Add the rail button and the menu item**

In `src/renderer/shell.html`, a `rail-git` button between `rail-files` and `rail-web`, matching the others (`class="rail-button"`, `aria-pressed="false"`, `aria-label="Source Control"`, `title="Source Control (⌘⌥G)"`) with a 16×16 `currentColor` SVG. Move `rail-button-last` if the ordering changes which button is last.

In `shell.js`, wire it to send `shell:toggle-git`, the way `rail-files` sends its own message.

In `src/main/index.ts`: an `ipcMain.on('shell:toggle-git', …)` calling `nextSideView`, storing the columns and re-laying out; and a **Toggle Source Control** item with accelerator `CmdOrCtrl+Alt+G` in the View menu beside Toggle File Tree, calling the same function — the rail and the menu must go through one function, since 0.3.0 shipped a fix for exactly the case where they did not.

- [ ] **Step 7: Add the IPC and the page**

In `src/main/index.ts`:

```ts
    ipcMain.handle('git:read', async () => {
      const project = currentProject
      if (project === undefined) return { ok: true, repos: [] }
      return await readProject(project.path)
    })
```

In `src/preload/pane.ts`: `readGit: () => ipcRenderer.invoke('git:read')`, and `onGitChanged: (listener: () => void) => { ipcRenderer.on('git:changed', () => listener()) }`. Declare both in `src/renderer/pane/bridge.ts`.

`src/renderer/pane/git.ts` calls `window.pane.readGit()` and draws, for each repository in the result, one section per `rowsFor` group with `label` and `colourOf`. It re-reads on `onGitChanged`, and follows the harness theme with `followHarnessTheme` as `files.ts` does.

**One repository gets no header.** With a single repo in the result its name, its collapse control, and its branch line are drawn as a plain header row above the sections rather than as a collapsible group — the common case deserves no ceremony. With two or more, each becomes a collapsible group headed by its name and branch, collapsed state held in the page and not persisted. The three empty states from the spec are literal strings, not a shrug: "No repository in this project.", "Nothing has changed.", and "git is not on your PATH. Add it under Settings → Advanced → Extra PATH entries."

- [ ] **Step 8: Refresh when something changes**

Send `git:changed` to `views.git.webContents` when the project changes, when the window is focused, and when a watcher on each repo's `.git/index`, `.git/HEAD` and `.git/refs` fires — debounced by 200 ms, reusing the project watcher already in `index.ts`. Serialise per repo: hold the in-flight `readProject` promise and, if one is running when another is asked for, return the running one rather than starting a second.

- [ ] **Step 9: See it work**

```bash
npm run build && npx electron .
```

Quit any running copy first — closing the window hides the app to the tray, and the single-instance lock will otherwise make this exit immediately. Press ⌘⌥G. Confirm the panel opens in the side column, the tree closes, the changed files of this repository are listed, and ⌘⌥G again closes the column.

- [ ] **Step 10: Commit**

```bash
npm test && npx tsc -p tsconfig.json --noEmit && npx tsc -p tsconfig.pane.json --noEmit
git add -A
git commit -m "feat(git): a source-control panel sharing the side column"
```

---

### Task 8: Clicking a row opens its diff

**Files:**
- Modify: `src/renderer/pane/git.ts`, `src/main/index.ts`, `src/preload/pane.ts`, `src/renderer/pane/bridge.ts`, `src/renderer/pane/main.ts`, `README.md`

**Interfaces:**
- Consumes: `diffSides` (Task 4), `Editor.showTexts` (Task 5), the `git:open-diff` channel (Task 7).
- Produces: nothing later tasks depend on. This closes plan 1.

- [ ] **Step 1: Write the failing test for the path check**

In `src/main/index.spec.ts`, or a new `src/main/git-open.spec.ts` if the handler is extracted:

```ts
  // reason: this channel is reachable from a renderer and names a path and a
  // repository, so it is checked rather than trusted — the same rule the
  // web view's own file loading follows.
  it('refuses a diff for a repository outside the open project', async () => {
    expect(await gitDiffFor('/etc', 'passwd', 'changed', () => ['/p/demo'])).toBeUndefined()
  })

  it('allows one inside it', async () => {
    expect(await gitDiffFor('/p/demo', 'a.ts', 'changed', () => ['/p/demo'])).toBeDefined()
  })
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run src/main/git-open.spec.ts`
Expected: FAIL — `gitDiffFor is not a function`.

- [ ] **Step 3: Write the handler**

```ts
/**
 * The two sides of a row's diff, if that row may be read.
 *
 * The repository is checked against the repositories actually discovered in
 * the open project rather than taken as given: this is reachable from a
 * renderer, and a path it names is not evidence of anything.
 * @param repo - the repository's directory.
 * @param path - the file's path within it.
 * @param section - which list the row was in.
 * @param known - the repositories currently discovered.
 * @returns both texts, or undefined when the row may not be read.
 */
export async function gitDiffFor(
  repo: string,
  path: string,
  section: Section,
  known: () => string[],
): Promise<{ original: string; modified: string } | undefined> {
  if (!known().includes(repo)) return undefined
  const sides = await diffSides(repo, path, section)
  return sides.ok ? { original: sides.original, modified: sides.modified } : undefined
}
```

Wire `ipcMain.handle('git:open-diff', …)` to it, and on a result send `pane:diff-texts` to `views.pane.webContents` with the file, both texts, and `inline: true`.

- [ ] **Step 4: Run and watch it pass**

Run: `npx vitest run src/main/git-open.spec.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Connect both ends**

In `src/renderer/pane/git.ts`, a click on a row calls `window.pane.openGitDiff(repo, path, section)`. In `src/preload/pane.ts`, add that and `onDiffTexts`. In `src/renderer/pane/main.ts`:

```ts
// Sent by main when a row in the git panel is clicked. Both sides come from
// git, so nothing is read from disk and the file's own tab is left alone.
window.pane.onDiffTexts((root, relative, original, modified) => {
  editor.showTexts({ root, relative }, original, modified, true)
})
```

- [ ] **Step 6: See it work**

```bash
npm run build && npx electron .
```

Edit a file in this repository, press ⌘⌥G, click the row. Confirm: the diff opens in the editor column as **one pane**, coloured; the file's own tab stays open beside it; and clicking the row again reuses the diff tab rather than opening a second.

Then edit that file without saving and click its row again — the diff must still open, because that is the case `showDiff` refuses and `showTexts` deliberately does not.

- [ ] **Step 7: Document it**

Add a paragraph to the README's side-pane section: the rail's Source Control button and ⌘⌥G, what the panel lists, that clicking a row shows the diff inline in the editor column, and that this reads local git only — no account, no tokens. State that staging, committing and the remote are not in it yet, so nobody goes looking.

- [ ] **Step 8: Commit**

```bash
npm test && npx tsc -p tsconfig.json --noEmit && npx tsc -p tsconfig.pane.json --noEmit
git add -A
git commit -m "feat(git): show a changed file's diff in the editor column"
```

---

## What plan 1 does not do

Deliberately absent, so nobody implements half of them by accident: the checkboxes and the selection they carry, stage, unstage, discard, commit, fetch, pull, push, and the credential failure surface. Plan 2 covers the first six; plan 3 the rest. The spec's *Committing*, *Acting on a repo*, *The remote* and *Failing loudly* sections are theirs — except `gitEnv`, which lands in Task 1 because there is no reason to spawn git without it even once.
