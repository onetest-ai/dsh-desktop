# Git Panel: The Remote Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the source-control panel Fetch, Pull and Push — each doing exactly one thing, each cancellable — and turn the four credential failures that actually happen into sentences with a way out.

**Architecture:** A new `git-remote.ts` in main holds the three operations and the pure function that recognises what git said when one of them failed. `git-run.ts` gains an optional timeout and an `AbortSignal`, because a network git needs longer than thirty seconds and has to be killable; it stays the only place a git child is spawned. Main serialises the operations per repository, holds the controller that cancels one, and gates every channel through the same `refuseUnlessInProject` the writes already use. The renderer adds a sync menu on the repository header, a running state, and — when git refused for want of a credential — a note offering **Open in Terminal**, which starts a shell in that repository so git's own credential helper can cache what it needs.

**Tech Stack:** TypeScript, Node's `child_process.execFile`, Electron IPC, Vitest (jsdom for the renderer half), the user's own `git`.

**Spec:** `docs/notes/git-panel.md` — sections *The remote*, *Failing loudly*, and *Where it lives*.

## Global Constraints

- **No formatter is configured.** Do NOT run `prettier`, `eslint --fix`, or any other formatter. Match the surrounding style by hand: 2-space indent, no semicolons, single quotes, ~120-column lines.
- **Stage only the files your task names.** Never `git add -A`, `git add .`, or `git commit -a`. The repository has untracked files at its root (`index.js`, `tree-menu.js`) that belong to the user and must never be committed.
- **Every exported symbol carries a JSDoc block** with `@param` and `@returns`, in the voice of the surrounding code: say *why*, not *what*. Read the neighbouring file before writing one.
- **Tests are colocated**: `src/main/git-remote.spec.ts` beside `src/main/git-remote.ts`.
- **A test that guards something important is broken deliberately once** to confirm it fails, then repaired. Record that you did it.
- Commands: `npm test` (all 1591+ tests), `npx vitest run <file>` (one), `npx tsc -p tsconfig.json --noEmit` (main), `npx tsc -p tsconfig.pane.json --noEmit` (renderer/pane). Both typechecks must be clean before every commit.
- **Nothing about git reaches the renderer except through the bridge.** The renderer never names a git argument, a directory outside a repository, or a shell.
- **`git push` is never `--force`**, behind no modifier, at no point.
- The panel's failure text is one line: the repository's name and what git said, never a stack trace.

---

## File Structure

**Modified:**
- `src/main/git-run.ts` — an optional timeout and abort signal on `runGit`.
- `src/main/index.ts` — per-repo serialisation, the cancel controller, five new IPC channels, and a terminal opened at a repository.
- `src/preload/pane.ts` — the new bridge methods.
- `src/preload/terminal.ts` — `onOpenNew`.
- `src/renderer/pane/bridge.ts` — their types.
- `src/renderer/pane/git.ts` — the sync menu, the running state, the trouble note.
- `src/renderer/terminal/main.ts` — open a session when main asks.
- `src/renderer/pane.css` — the menu, the spinner, the note.
- `docs/notes/git-panel.md` — amended for publish and for what Open in Terminal actually opens.
- `README.md` — one paragraph.

**Created:**
- `src/main/git-remote.ts` + `.spec.ts` — the operations and the trouble table.

---

### Task 1: A git child that can be given longer, and killed

`runGit` hard-codes a 30-second timeout and throws its `ChildProcess` away. A `git fetch` over a slow link takes longer than that, and a fetch that is going nowhere has to be stoppable. Both are options on the existing function rather than a second spawner, because `git-run.ts` being the only place a git child starts is what makes the credential environment impossible to forget.

**Files:**
- Modify: `src/main/git-run.ts`
- Test: `src/main/git-run.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export interface RunOptions { timeoutMs?: number; signal?: AbortSignal }
  export async function runGit(cwd: string, args: string[], gitPath?: string, opts?: RunOptions): Promise<GitResult>
  ```
  The options are the **fourth** parameter so every existing `run: typeof runGit` injection and every existing call site keeps compiling untouched.

- [ ] **Step 1: Write the failing tests**

Append to `src/main/git-run.spec.ts`, inside the existing `describe('runGit', …)` block if there is one, otherwise as a new `describe` at the end of the file. `gitInstalled` already exists at the top of that file.

```ts
describe('runGit under options', () => {
  // `git hash-object --stdin` reads until end of input, and nothing here ever
  // closes the child's stdin, so it is a hang this machine can rely on.
  const HANG = ['hash-object', '--stdin']

  // reason: a fetch over a slow link takes longer than the default, and one
  // that is going nowhere has to stop when it is told to rather than holding
  // the panel on a spinner for the rest of the timeout.
  it.skipIf(!gitInstalled)('stops when the signal is aborted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'git-abort-'))
    execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' })
    const stop = new AbortController()
    const running = runGit(dir, HANG, 'git', { signal: stop.signal })
    stop.abort()
    const out = await running
    expect(out.code).not.toBe(0)
  }, 10_000)

  // reason: without a timeout of its own every remote operation would be cut
  // off at the default thirty seconds, which is a normal clone's first fetch.
  it.skipIf(!gitInstalled)('honours a timeout it was given', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'git-timeout-'))
    execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' })
    const began = Date.now()
    const out = await runGit(dir, HANG, 'git', { timeoutMs: 200 })
    expect(out.code).not.toBe(0)
    // Far below the 30s default: this asserts the option was used, not merely
    // that a hanging git eventually ends.
    expect(Date.now() - began).toBeLessThan(10_000)
  }, 20_000)

  // reason: a caller that passes no options must keep the behaviour every
  // existing call site was written against.
  it.skipIf(!gitInstalled)('still works with no options at all', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'git-plain-'))
    execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' })
    const out = await runGit(dir, ['rev-parse', '--is-inside-work-tree'])
    expect(out.code).toBe(0)
    expect(out.stdout.toString('utf8').trim()).toBe('true')
  }, 20_000)
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/main/git-run.spec.ts`
Expected: the abort and timeout tests hang until Vitest's own limit and fail — `runGit` ignores the fourth argument today, so the child never dies.

- [ ] **Step 3: Implement**

In `src/main/git-run.ts`, add the interface above `runGit` and widen the signature:

```ts
/** What a caller may change about one git child. */
export interface RunOptions {
  /** How long it may take, in milliseconds; `TIMEOUT_MS` when absent. */
  timeoutMs?: number
  /**
   * Aborts the child.
   *
   * A remote operation is the only git here that waits on something outside
   * this machine, so it is the only one a user can be left watching with no
   * way to stop it. `execFile` kills the child on abort, which is what makes
   * Cancel a real cancel rather than a button that hides a spinner.
   */
  signal?: AbortSignal
}
```

Then, in `runGit`, replace the options object passed to `execFile` and add the fourth parameter:

```ts
export async function runGit(
  cwd: string,
  args: string[],
  gitPath = 'git',
  opts: RunOptions = {},
): Promise<GitResult> {
  return await new Promise<GitResult>((resolve) => {
    execFile(
      gitPath,
      args,
      {
        cwd,
        env: gitEnv(process.env, gitPathSource()),
        timeout: opts.timeoutMs ?? TIMEOUT_MS,
        signal: opts.signal,
        maxBuffer: 64 * 1024 * 1024,
        encoding: 'buffer',
      },
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

Extend the JSDoc on `runGit` with:

```
 * @param opts - a timeout of its own and a signal that kills it; see `RunOptions`.
```

A killed or timed-out child resolves with a non-zero code and, usually, nothing on either stream. That is deliberate: `runGit` reports rather than throws, and the caller that holds the controller is the one that knows an empty failure was a cancel rather than a silence.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/main/git-run.spec.ts`
Expected: PASS.

- [ ] **Step 5: Prove the abort test is not vacuous**

Delete `signal: opts.signal,` from the `execFile` options. Re-run. Expected: the abort test now fails or times out. Restore the line.

- [ ] **Step 6: Typecheck the whole main project**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: clean — every existing `run: typeof runGit` double takes fewer parameters, which TypeScript accepts.

- [ ] **Step 7: Commit**

```bash
git add src/main/git-run.ts src/main/git-run.spec.ts
git commit -m "feat(git): a git child that can be given longer, and killed"
```

---

### Task 2: What git said when the remote refused

The pure half, alone, because it is the half with the bugs in it and it tests without spawning anything. Four failures are recognised because they are the four that actually happen on a developer's machine, and a fifth — a branch with no upstream — because it is what `git push` says the first time on every branch anyone creates.

**Files:**
- Create: `src/main/git-remote.ts`
- Test: `src/main/git-remote.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export type TroubleKind = 'https' | 'publickey' | 'hostkey' | 'rejected' | 'no-upstream'
  export interface Trouble { kind: TroubleKind; say: string }
  export function remoteTrouble(text: string): Trouble | undefined
  ```

- [ ] **Step 1: Write the failing test**

Create `src/main/git-remote.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { remoteTrouble } from './git-remote'

describe('remoteTrouble', () => {
  // reason: this is what GIT_TERMINAL_PROMPT=0 turns an HTTPS credential
  // prompt into, and pasting it at the user tells them what git could not do
  // rather than what they can.
  it('recognises an HTTPS credential it does not have', () => {
    const said = "fatal: could not read Username for 'https://github.com': terminal prompts disabled"
    expect(remoteTrouble(said)?.kind).toBe('https')
    expect(remoteTrouble(said)?.say).toContain('HTTPS credential')
  })

  // reason: BatchMode=yes turns a passphrase prompt into this, and the remedy
  // is the ssh agent rather than anything in this app.
  it('recognises a key the agent is not holding', () => {
    const said = 'git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.'
    expect(remoteTrouble(said)?.kind).toBe('publickey')
    expect(remoteTrouble(said)?.say).toContain('SSH key')
  })

  it('recognises a host that is not in known_hosts', () => {
    expect(remoteTrouble('Host key verification failed.')?.kind).toBe('hostkey')
  })

  // reason: a cached credential that has been revoked or has expired fails
  // differently from one that was never there, and the remedies differ too.
  it('recognises a credential the remote rejected', () => {
    const said = "remote: Invalid username or password.\nfatal: Authentication failed for 'https://github.com/a/b.git/'"
    expect(remoteTrouble(said)?.kind).toBe('rejected')
  })

  // reason: the commonest push failure there is — the first push of every
  // branch anyone creates — and the one with a one-button answer.
  it('recognises a branch with nowhere to push to', () => {
    const said = 'fatal: The current branch feat/x has no upstream branch.\nTo push the current branch...'
    expect(remoteTrouble(said)?.kind).toBe('no-upstream')
  })

  it('recognises the other wording git uses for the same thing', () => {
    expect(remoteTrouble('fatal: no upstream configured for branch \'feat/x\'')?.kind).toBe('no-upstream')
  })

  // reason: a rejected non-fast-forward is a real failure with no button on
  // it — the answer is to pull, which the panel already offers — so it must
  // not be dressed up as a credential problem.
  it('says nothing about a failure it does not know', () => {
    expect(remoteTrouble('! [rejected] main -> main (fetch first)')).toBeUndefined()
    expect(remoteTrouble('')).toBeUndefined()
  })

  // reason: git wraps and capitalises differently across versions, and a
  // table that only matched one casing would go quiet after an upgrade.
  it('reads what git said whatever case it said it in', () => {
    expect(remoteTrouble('FATAL: COULD NOT READ USERNAME FOR X')?.kind).toBe('https')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/main/git-remote.spec.ts`
Expected: FAIL — `Failed to resolve import "./git-remote"`.

- [ ] **Step 3: Implement**

Create `src/main/git-remote.ts` with only this much for now:

```ts
/** Which of the failures the panel knows how to talk about this was. */
export type TroubleKind = 'https' | 'publickey' | 'hostkey' | 'rejected' | 'no-upstream'

/** A failure the panel recognises, and the sentence it says instead. */
export interface Trouble {
  kind: TroubleKind
  /** One line, in the panel's own voice; never git's wrapping and advice. */
  say: string
}

/**
 * The failures worth translating, in the order they are looked for.
 *
 * Ordered because more than one can match: a push to a branch with no
 * upstream over a remote whose credential is also missing says both, and the
 * upstream is the one with a button on it. Matched case-insensitively on a
 * fragment rather than a whole line — git wraps, capitalises and phrases
 * these differently across versions, and a table matching whole lines would
 * go quiet after an upgrade with nothing to say it had.
 */
const KNOWN: { has: string; kind: TroubleKind; say: string }[] = [
  {
    has: 'no upstream',
    kind: 'no-upstream',
    say: 'This branch has no upstream yet, so git does not know where to push it.',
  },
  {
    has: 'could not read username',
    kind: 'https',
    say: 'This remote needs an HTTPS credential this app does not have.',
  },
  {
    has: 'permission denied (publickey',
    kind: 'publickey',
    say: 'The SSH key for this remote is not loaded in your agent.',
  },
  {
    has: 'host key verification failed',
    kind: 'hostkey',
    say: 'This host is not in your known_hosts yet.',
  },
  {
    has: 'authentication failed',
    kind: 'rejected',
    say: 'The stored credential for this remote was rejected.',
  },
]

/**
 * Recognise a remote failure the panel can say something useful about.
 *
 * This app deliberately supplies no askpass of its own — a credential it
 * never sees is one it cannot leak — so the cost is stated rather than
 * hidden: a repository whose credential is not already cached cannot push
 * from the panel. That cost is only acceptable if the panel says which of
 * these it hit and offers the terminal, so it is worth recognising them
 * exactly and saying nothing about the rest.
 *
 * A failure that is not here comes through as git's own first line, which is
 * the right answer for a non-fast-forward or a hook: those are ordinary
 * refusals with nothing this panel can add.
 * @param text - what git wrote, normally stderr.
 * @returns which failure it was and what to say, or nothing when it is not one of these.
 */
export function remoteTrouble(text: string): Trouble | undefined {
  const said = text.toLowerCase()
  const found = KNOWN.find((one) => said.includes(one.has))
  return found === undefined ? undefined : { kind: found.kind, say: found.say }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/main/git-remote.spec.ts`
Expected: PASS, all eight.

- [ ] **Step 5: Prove the table is load-bearing**

Change `'no upstream'` to `'no upstreamX'`. Re-run. Expected: both no-upstream tests fail. Restore.

- [ ] **Step 6: Typecheck and commit**

Run: `npx tsc -p tsconfig.json --noEmit`

```bash
git add src/main/git-remote.ts src/main/git-remote.spec.ts
git commit -m "feat(git): recognise the four remote failures that actually happen"
```

---

### Task 3: Fetch, pull, push — and publish

Each does exactly one thing. Not a combined Sync: sync is pull-then-push, and a compound operation that half-succeeded is one the panel then has to explain. Pull respects the user's own `pull.rebase` rather than imposing merge or rebase on them.

**Files:**
- Modify: `src/main/git-remote.ts`
- Test: `src/main/git-remote.spec.ts`

**Interfaces:**
- Consumes: `runGit`, `RunOptions` from `./git-run`; `ActionOutcome`, `firstLine` from `./git-actions`; `remoteTrouble`, `Trouble` from this file.
- Produces:
  ```ts
  export type RemoteOp = 'fetch' | 'pull' | 'push' | 'publish'
  export type RemoteOutcome = ActionOutcome & { trouble?: TroubleKind }
  export const REMOTE_TIMEOUT_MS: number
  export async function remote(repo: string, op: RemoteOp, signal?: AbortSignal, run?: typeof runGit): Promise<RemoteOutcome>
  ```

- [ ] **Step 1: Write the failing tests**

Append to `src/main/git-remote.spec.ts`. Add the imports at the top of the file: `import { remote, remoteTrouble, REMOTE_TIMEOUT_MS } from './git-remote'` and `import type { GitResult } from './git-run'`.

```ts
/**
 * A git that answers from a script, recording what it was asked.
 * @param answers - one answer per call, in order; the last repeats.
 * @returns the double and the calls it recorded.
 */
function fakeGit(answers: Partial<GitResult>[]): {
  run: (cwd: string, args: string[], gitPath?: string, opts?: unknown) => Promise<GitResult>
  calls: { args: string[]; opts: unknown }[]
} {
  const calls: { args: string[]; opts: unknown }[] = []
  let turn = 0
  return {
    calls,
    run: async (_cwd, args, _gitPath, opts) => {
      calls.push({ args, opts })
      const answer = answers[Math.min(turn, answers.length - 1)] ?? {}
      turn += 1
      return { code: answer.code ?? 0, stdout: answer.stdout ?? Buffer.from(''), stderr: answer.stderr ?? '' }
    },
  }
}

describe('remote', () => {
  it('fetches with one command and nothing added to it', async () => {
    const git = fakeGit([{ code: 0 }])
    expect(await remote('/r', 'fetch', undefined, git.run as never)).toEqual({ ok: true })
    expect(git.calls[0].args).toEqual(['fetch'])
  })

  // reason: `--rebase` or `--no-rebase` here would override the user's own
  // pull.rebase, which is a decision about their repository, not this app's.
  it('pulls plainly, so the user\'s own pull.rebase decides', async () => {
    const git = fakeGit([{ code: 0 }])
    await remote('/r', 'pull', undefined, git.run as never)
    expect(git.calls[0].args).toEqual(['pull'])
  })

  // reason: a force push from a panel is a force push nobody meant to do.
  it('pushes plainly, never with force', async () => {
    const git = fakeGit([{ code: 0 }])
    await remote('/r', 'push', undefined, git.run as never)
    expect(git.calls[0].args).toEqual(['push'])
    expect(git.calls[0].args.join(' ')).not.toContain('force')
  })

  it('reports what git said when it failed', async () => {
    const git = fakeGit([{ code: 1, stderr: '! [rejected] main -> main (fetch first)\nhint: ignore me' }])
    const out = await remote('/r', 'push', undefined, git.run as never)
    expect(out).toEqual({ ok: false, reason: '! [rejected] main -> main (fetch first)' })
  })

  // reason: the kind is what the panel hangs a button on; without it every
  // credential failure is a sentence the user can only read.
  it('names which trouble it was when it recognises one', async () => {
    const git = fakeGit([{ code: 1, stderr: "fatal: could not read Username for 'https://x': terminal prompts disabled" }])
    const out = await remote('/r', 'push', undefined, git.run as never)
    expect(out.ok).toBe(false)
    expect(out.trouble).toBe('https')
    if (!out.ok) expect(out.reason).toContain('HTTPS credential')
  })

  // reason: `git remote` names the remote, so nothing the renderer typed ever
  // reaches the command line — and HEAD names the branch, so nothing does.
  it('publishes to the only remote, by HEAD', async () => {
    const git = fakeGit([{ code: 0, stdout: Buffer.from('origin\n') }, { code: 0 }])
    expect(await remote('/r', 'publish', undefined, git.run as never)).toEqual({ ok: true })
    expect(git.calls[0].args).toEqual(['remote'])
    expect(git.calls[1].args).toEqual(['push', '--set-upstream', 'origin', 'HEAD'])
  })

  // reason: guessing which of several remotes the user meant is how work ends
  // up on a fork nobody was watching.
  it('refuses to guess between two remotes', async () => {
    const git = fakeGit([{ code: 0, stdout: Buffer.from('origin\nupstream\n') }])
    const out = await remote('/r', 'publish', undefined, git.run as never)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toContain('more than one remote')
    expect(git.calls).toHaveLength(1)
  })

  it('says so when there is no remote at all', async () => {
    const git = fakeGit([{ code: 0, stdout: Buffer.from('') }])
    const out = await remote('/r', 'publish', undefined, git.run as never)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toContain('no remote')
  })

  // reason: a cancel that reported git's silence as "git failed without
  // saying why" would read as a fault rather than as the thing just done.
  it('says a cancelled run was cancelled', async () => {
    const stop = new AbortController()
    stop.abort()
    const git = fakeGit([{ code: 1, stderr: '' }])
    const out = await remote('/r', 'fetch', stop.signal, git.run as never)
    expect(out).toEqual({ ok: false, reason: 'Cancelled.' })
  })

  // reason: the default thirty seconds is a normal first fetch on a large
  // repository, and being cut off there looks like a network fault.
  it('gives a remote operation longer than a local one', async () => {
    const git = fakeGit([{ code: 0 }])
    await remote('/r', 'fetch', undefined, git.run as never)
    expect((git.calls[0].opts as { timeoutMs: number }).timeoutMs).toBe(REMOTE_TIMEOUT_MS)
    expect(REMOTE_TIMEOUT_MS).toBeGreaterThan(30_000)
  })

  it('passes the signal through so the child can be killed', async () => {
    const stop = new AbortController()
    const git = fakeGit([{ code: 0 }])
    await remote('/r', 'fetch', stop.signal, git.run as never)
    expect((git.calls[0].opts as { signal: AbortSignal }).signal).toBe(stop.signal)
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/main/git-remote.spec.ts`
Expected: FAIL — `remote is not a function`.

- [ ] **Step 3: Implement**

Append to `src/main/git-remote.ts`, and add at the top: `import { firstLine, type ActionOutcome } from './git-actions'` and `import { runGit } from './git-run'`.

```ts
/** The four things the panel asks a remote for. */
export type RemoteOp = 'fetch' | 'pull' | 'push' | 'publish'

/** What one remote operation reported, with the trouble when it was one. */
export type RemoteOutcome = ActionOutcome & { trouble?: TroubleKind }

/**
 * How long a remote operation may take.
 *
 * Four times the local timeout. A first fetch on a large repository over a
 * domestic link runs past thirty seconds routinely, and being cut off there
 * is indistinguishable to the user from the network being broken. It is still
 * bounded, and Cancel is the answer for an operation going nowhere.
 */
export const REMOTE_TIMEOUT_MS = 120_000

/** What the panel says instead of git's silence when the user stopped it. */
const CANCELLED = 'Cancelled.'

/**
 * The remote a branch would be published to, when there is exactly one.
 *
 * Read from `git remote` rather than taken from the caller: the name reaches
 * a command line, and the only names that do so here are ones git itself
 * produced. Several remotes is a refusal rather than a guess — publishing to
 * a fork nobody was watching is not a mistake the panel should be able to
 * make on the user's behalf.
 * @param repo - the repository.
 * @param signal - kills the child.
 * @param run - how to run git.
 * @returns the remote's name, or why there is not exactly one.
 */
async function onlyRemote(
  repo: string,
  signal: AbortSignal | undefined,
  run: typeof runGit,
): Promise<{ ok: true; name: string } | { ok: false; reason: string }> {
  const out = await run(repo, ['remote'], 'git', { timeoutMs: REMOTE_TIMEOUT_MS, signal })
  if (out.code !== 0) return { ok: false, reason: firstLine(out.stderr, out.stdout.toString('utf8')) }
  const names = out.stdout
    .toString('utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
  if (names.length === 0) return { ok: false, reason: 'This repository has no remote to publish to.' }
  if (names.length > 1) {
    return { ok: false, reason: 'This repository has more than one remote, so push it once from the terminal.' }
  }
  return { ok: true, name: names[0] }
}

/**
 * The arguments for one operation.
 *
 * `publish` is absent because it needs a remote read first; see `remote`.
 * @param op - which operation.
 * @returns the arguments, without the program name.
 */
function argsFor(op: Exclude<RemoteOp, 'publish'>): string[] {
  // Plain, every one of them. `pull` without `--rebase` or `--no-rebase`
  // respects the user's own pull.rebase; `push` without `--force` is the only
  // push this panel makes, behind no modifier, at no point.
  return [op]
}

/**
 * Ask a remote for one thing.
 *
 * One command each, never a combined Sync: sync is pull-then-push, and a
 * compound operation that half-succeeded is one the panel then has to
 * explain — usually while the user is looking at a repository in a state
 * neither half described.
 *
 * A failure the panel recognises is said in the panel's own words with its
 * kind attached, so a note can hang a button on it; everything else comes
 * through as git's own first line, which is the right answer for a
 * non-fast-forward or a hook.
 * @param repo - the repository.
 * @param op - which operation.
 * @param signal - kills the child; an aborted one is reported as a cancel rather than as git's silence.
 * @param run - how to run git; injected so tests spawn nothing.
 * @returns success, or why not and which trouble it was.
 */
export async function remote(
  repo: string,
  op: RemoteOp,
  signal?: AbortSignal,
  run: typeof runGit = runGit,
): Promise<RemoteOutcome> {
  let args: string[]
  if (op === 'publish') {
    const found = await onlyRemote(repo, signal, run)
    if (!found.ok) return signal?.aborted === true ? { ok: false, reason: CANCELLED } : found
    args = ['push', '--set-upstream', found.name, 'HEAD']
  } else {
    args = argsFor(op)
  }
  const out = await run(repo, args, 'git', { timeoutMs: REMOTE_TIMEOUT_MS, signal })
  if (out.code === 0) return { ok: true }
  // Before anything is read off the streams: a killed child usually wrote
  // nothing to either, and `firstLine` would report that as "git failed
  // without saying why" — a fault, rather than the thing just asked for.
  if (signal?.aborted === true) return { ok: false, reason: CANCELLED }
  const said = out.stderr === '' ? out.stdout.toString('utf8') : out.stderr
  const trouble = remoteTrouble(said)
  if (trouble !== undefined) return { ok: false, reason: trouble.say, trouble: trouble.kind }
  return { ok: false, reason: firstLine(out.stderr, out.stdout.toString('utf8')) }
}
```

Note that `HEAD` is used for the branch in `publish`: it names the branch you are on without any name crossing a boundary, and it fails honestly on a detached HEAD, which is a state nothing should be published from.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/main/git-remote.spec.ts`
Expected: PASS.

- [ ] **Step 5: Prove the cancel branch is load-bearing**

Delete the `if (signal?.aborted === true) return { ok: false, reason: CANCELLED }` line after the run. Re-run. Expected: "says a cancelled run was cancelled" fails with `git failed without saying why.`. Restore.

- [ ] **Step 6: Typecheck and commit**

Run: `npx tsc -p tsconfig.json --noEmit`

```bash
git add src/main/git-remote.ts src/main/git-remote.spec.ts
git commit -m "feat(git): fetch, pull, push, and publish a branch that has no upstream"
```

---

### Task 4: Main runs one remote operation per repository, and can stop it

The gate is the same one every other git channel goes through. What is new is that these operations take seconds rather than milliseconds, so two can be asked for at once and one can need stopping.

**Files:**
- Modify: `src/main/index.ts`
- Test: `src/main/index.spec.ts` (append; the file already tests `gitStageFor` and its siblings — follow its shape exactly)

**Interfaces:**
- Consumes: `remote`, `RemoteOp`, `RemoteOutcome` from `./git-remote`; `refuseUnlessInProject` from `./git-model`.
- Produces:
  ```ts
  export async function gitRemoteFor(repo: string, op: RemoteOp, known: () => string[], jobs?: Map<string, AbortController>): Promise<RemoteOutcome>
  export function gitCancelRemote(repo: string, jobs?: Map<string, AbortController>): void
  ```
  IPC: `git:remote` (invoke, `(repo, op)` → `RemoteOutcome`), `git:cancel-remote` (send, `(repo)`).

- [ ] **Step 1: Write the failing tests**

`src/main/index.spec.ts` does not import `./index` at the top level — it mocks
every neighbour and then imports the module fresh per test through its own
`exports()` helper. Follow that exactly; a top-level import would run the
module before its mocks were in place.

First, beside the existing `vi.mock('./git-stash', …)` near line 441:

```ts
const remoteMock = vi.fn(async (): Promise<unknown> => ({ ok: true }))
vi.mock('./git-remote', () => ({
  remote: (...args: unknown[]) => remoteMock(...(args as [])),
}))
```

Then add `remoteMock` to the reset loop near line 685, so a test that changes
its answer does not change it for the next one:

```ts
  for (const mock of [stageMock, unstageMock, discardMock, commitMock, checkoutMock, createBranchMock, pushStashMock, applyStashMock, dropStashMock, remoteMock]) {
```

Then the tests, inside the same `describe` block that holds the `gitStageFor`
tests — it already creates a real temporary directory in `repo`:

```ts
  describe('the remote', () => {
    // reason: the same gate every other git channel goes through — a
    // directory the project does not hold is not one this app fetches into.
    it('refuses a repository the project does not hold', async () => {
      const { gitRemoteFor } = await exports()
      expect(await gitRemoteFor('/elsewhere', 'fetch', () => [repo])).toEqual({
        ok: false,
        reason: 'That repository is not in the open project.',
      })
      expect(remoteMock).not.toHaveBeenCalled()
    })

    it('runs the operation it was asked for', async () => {
      const { gitRemoteFor } = await exports()
      expect(await gitRemoteFor(repo, 'pull', () => [repo])).toMatchObject({ ok: true })
      expect(remoteMock).toHaveBeenCalledWith(repo, 'pull', expect.anything())
    })

    // reason: an agent rebasing in the terminal panel and a user pressing
    // Fetch twice both produce two git children in one repository, and two
    // remote operations in one working tree race for the same index lock.
    it('refuses a second operation while one is running in the same repo', async () => {
      const { gitRemoteFor } = await exports()
      const jobs = new Map<string, AbortController>([[repo, new AbortController()]])
      const out = await gitRemoteFor(repo, 'pull', () => [repo], jobs)
      expect(out.ok).toBe(false)
      if (!out.ok) expect(out.reason).toContain('already running')
      expect(remoteMock).not.toHaveBeenCalled()
    })

    it('lets a different repository run at the same time', async () => {
      const { gitRemoteFor } = await exports()
      const jobs = new Map<string, AbortController>([['/p/other', new AbortController()]])
      expect(await gitRemoteFor(repo, 'fetch', () => [repo, '/p/other'], jobs)).toMatchObject({ ok: true })
    })

    // reason: a job left in the map after the operation ended would refuse
    // every later fetch in that repository for the life of the window.
    it('forgets the job once it has finished', async () => {
      const { gitRemoteFor } = await exports()
      const jobs = new Map<string, AbortController>()
      await gitRemoteFor(repo, 'fetch', () => [repo], jobs)
      expect(jobs.has(repo)).toBe(false)
    })

    // reason: an operation that threw would otherwise leave its job behind,
    // which is the same panel-stops-working failure by another route.
    it('forgets the job even when the operation threw', async () => {
      const { gitRemoteFor } = await exports()
      remoteMock.mockRejectedValueOnce(new Error('boom'))
      const jobs = new Map<string, AbortController>()
      await expect(gitRemoteFor(repo, 'fetch', () => [repo], jobs)).rejects.toThrow('boom')
      expect(jobs.has(repo)).toBe(false)
    })

    it('aborts the job running in that repository', async () => {
      const { gitCancelRemote } = await exports()
      const stop = new AbortController()
      gitCancelRemote(repo, new Map([[repo, stop]]))
      expect(stop.signal.aborted).toBe(true)
    })

    // reason: a cancel arriving after the operation already finished is
    // ordinary — the user pressed it as the spinner cleared — and must not
    // throw across the bridge.
    it('does nothing when there is no job to stop', async () => {
      const { gitCancelRemote } = await exports()
      expect(() => gitCancelRemote(repo, new Map())).not.toThrow()
    })
  })
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/main/index.spec.ts`
Expected: FAIL — the two functions do not exist.

- [ ] **Step 3: Implement the helpers**

In `src/main/index.ts`, add to the imports near line 57:

```ts
import { remote, type RemoteOp, type RemoteOutcome } from './git-remote'
```

Then, beside `gitStashDropFor`:

```ts
/**
 * The remote operation running in each repository, and what stops it.
 *
 * Per repository rather than one at a time overall: a project holding several
 * checkouts is the case this panel was built for, and a fetch in one has
 * nothing to say about a fetch in another. Within one repository they are
 * serialised, because two remote operations in the same working tree race for
 * the same index lock and the loser reports a fault the user did not cause.
 */
const remoteJobs = new Map<string, AbortController>()

/**
 * Fetch, pull, push or publish, if the caller may act on the repository.
 *
 * No paths, so an empty list — the repository check still applies. A second
 * operation in a repository that already has one is refused rather than
 * queued: the panel shows the first one running, and a queue would leave a
 * button that did nothing visible for as long as the first one took.
 * @param repo - the repository.
 * @param op - which operation.
 * @param known - the repositories currently discovered.
 * @param jobs - the running operations; injected so tests hold their own.
 * @returns what the operation reported, or the refusal.
 */
export async function gitRemoteFor(
  repo: string,
  op: RemoteOp,
  known: () => string[],
  jobs: Map<string, AbortController> = remoteJobs,
): Promise<RemoteOutcome> {
  const refusal = refuseUnlessInProject(repo, [], known)
  if (refusal !== undefined) return refusal
  if (jobs.has(repo)) return { ok: false, reason: `Something is already running in ${basename(repo)}.` }
  const stop = new AbortController()
  jobs.set(repo, stop)
  try {
    return await remote(repo, op, stop.signal)
  } finally {
    // In a finally, and only when it is still ours: a job left behind would
    // refuse every later operation in that repository for the life of the
    // window, which is a panel that stops working with nothing to say why.
    if (jobs.get(repo) === stop) jobs.delete(repo)
  }
}

/**
 * Stop whatever remote operation is running in a repository.
 *
 * Nothing when there is none: a cancel pressed as the spinner cleared is
 * ordinary, and an error for it would be an error for doing the right thing.
 * @param repo - the repository.
 * @param jobs - the running operations; injected so tests hold their own.
 */
export function gitCancelRemote(repo: string, jobs: Map<string, AbortController> = remoteJobs): void {
  jobs.get(repo)?.abort()
}
```

`basename` is already imported in `index.ts`; confirm it before adding an import.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/main/index.spec.ts`
Expected: PASS. Nothing here spawns git: `./git-remote` is mocked, so every one of these asserts the gate, the map and the cleanup rather than anything about a network.

- [ ] **Step 5: Wire the channels**

Beside the `git:stash-drop` handler near line 2537:

```ts
    // Fetch, pull, push and publish. Serialised per repository inside the
    // helper, and refreshed afterwards either way: a failed pull still moves
    // the ahead and behind counts often enough that not refreshing would
    // leave the header lying about where the branch stands.
    ipcMain.handle('git:remote', async (_event, repo: string, op: RemoteOp) => {
      const out = await gitRemoteFor(repo, op, gitRepoPaths)
      notifyGitChanged()
      return out
    })
    ipcMain.on('git:cancel-remote', (_event, repo: string) => {
      // Gated like every other channel, even though a cancel can only ever
      // stop something this app itself started: the check costs nothing and
      // the rule that every git channel is checked is worth more than the
      // exception.
      if (refuseUnlessInProject(repo, [], gitRepoPaths) === undefined) gitCancelRemote(repo)
    })
```

- [ ] **Step 6: Add them to the preload and the bridge types**

In `src/preload/pane.ts`, beside `dropStash`:

```ts
  gitRemote: (repo: string, op: string) => ipcRenderer.invoke('git:remote', repo, op),
  cancelGitRemote: (repo: string) => ipcRenderer.send('git:cancel-remote', repo),
```

In `src/renderer/pane/bridge.ts`, inside the `pane` interface beside `dropStash`:

```ts
      // `trouble` says which failure it was, so the note can offer the way
      // out of that particular one rather than a generic apology.
      gitRemote(
        repo: string,
        op: 'fetch' | 'pull' | 'push' | 'publish',
      ): Promise<GitResult & { trouble?: 'https' | 'publickey' | 'hostkey' | 'rejected' | 'no-upstream' }>
      cancelGitRemote(repo: string): void
```

- [ ] **Step 7: Typecheck both projects**

Run: `npx tsc -p tsconfig.json --noEmit && npx tsc -p tsconfig.pane.json --noEmit`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add src/main/index.ts src/main/index.spec.ts src/preload/pane.ts src/renderer/pane/bridge.ts
git commit -m "feat(git): one remote operation per repository, and a way to stop it"
```

---

### Task 5: A terminal in the repository that could not push

This is what makes failing loudly acceptable. The app has no askpass of its own, so a repository whose credential is not cached cannot push from the panel — and the answer is to run it once by hand and let git's own credential helper cache what it needs.

The terminal's preload says the page never names a shell or a directory. That stays true: main holds the directory, and the page is only told to open a session.

**Files:**
- Modify: `src/main/index.ts`, `src/preload/pane.ts`, `src/preload/terminal.ts`, `src/renderer/terminal/main.ts`, `src/renderer/pane/bridge.ts`
- Test: `src/main/index.spec.ts`

**Interfaces:**
- Consumes: `gitRepoPaths`, `refuseUnlessInProject`.
- Produces:
  ```ts
  export function terminalCwdFor(repo: string, known: () => string[], project: string | undefined): string
  ```
  IPC: `git:open-terminal` (send, `(repo)`), `terminal:open-new` (main → terminal page).

- [ ] **Step 1: Write the failing test**

Append inside the same `describe` block that holds the `gitStageFor` tests in
`src/main/index.spec.ts`, so it has that block's real temporary `repo` and its
`exports()` helper:

```ts
  describe('terminalCwdFor', () => {
    it('starts the shell in the repository that was named', async () => {
      const { terminalCwdFor } = await exports()
      expect(terminalCwdFor(repo, () => [repo], '/p')).toBe(repo)
    })

    // reason: the directory reaches a shell's cwd, which is the one place in
    // this app where an unchecked path becomes a working directory somebody
    // then runs commands in.
    it('falls back to the project for a repository it does not hold', async () => {
      const { terminalCwdFor } = await exports()
      expect(terminalCwdFor('/elsewhere', () => [repo], '/p')).toBe('/p')
    })

    it('falls back to nothing nameable when no project is open', async () => {
      const { terminalCwdFor } = await exports()
      expect(terminalCwdFor('/elsewhere', () => [repo], undefined)).toBe('')
    })
  })
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/main/index.spec.ts`
Expected: FAIL — not a function.

- [ ] **Step 3: Implement**

In `src/main/index.ts`, near `startTerminal`:

```ts
/**
 * Where a shell opened from the git panel should start.
 *
 * Through the same gate as every git write, because this is the one place a
 * path from the renderer becomes a working directory somebody then runs
 * commands in. A repository the project does not hold falls back to the
 * project rather than being refused: the user asked for a terminal and a
 * terminal is what they get, in the place every other terminal opens.
 * @param repo - the repository the panel named.
 * @param known - the repositories currently discovered.
 * @param project - the open project's path, or nothing when none is open.
 * @returns the directory to start in; empty when there is nowhere to name.
 */
export function terminalCwdFor(repo: string, known: () => string[], project: string | undefined): string {
  if (refuseUnlessInProject(repo, [], known) === undefined) return repo
  return project ?? ''
}

/**
 * Where the next shell should start, when it is not the project root.
 *
 * Held here rather than passed from the page, so the terminal's preload keeps
 * its rule: the page names only a size, and main decides what runs and where.
 * Consumed by the next `terminal:start` and cleared, so a session opened any
 * other way afterwards lands in the project as it always did.
 */
let nextTerminalCwd: string | undefined
```

In `startTerminal`, replace the `cwd` line:

```ts
  const cwd = nextTerminalCwd ?? currentProject?.path ?? app.getPath('home')
  nextTerminalCwd = undefined
```

Add the channel beside `git:cancel-remote`:

```ts
    // The way out of a credential failure: a shell in that repository, where
    // git's own helper can cache what it needs and the panel works from then
    // on. A new session rather than the panel's existing one — a `cd` typed
    // into a shell that is in the middle of something is not a courtesy.
    ipcMain.on('git:open-terminal', (_event, repo: string) => {
      const cwd = terminalCwdFor(repo, gitRepoPaths, currentProject?.path)
      if (cwd === '') return
      nextTerminalCwd = cwd
      if (!columns.terminal.open) {
        setColumn('terminal', { open: true })
        storeColumns()
      }
      if (views === undefined || views.window.isDestroyed()) return
      const target = views.terminal.webContents
      // A page still loading drops what is sent to it; this is that page's
      // first moments after boot, which is exactly when a rail press lands.
      if (target.isLoading()) {
        target.once('did-finish-load', () => {
          target.send('terminal:open-new')
        })
        return
      }
      target.send('terminal:open-new')
    })
```

`terminal:open-new` is sent instead of `terminal:shown` deliberately: `shown` starts a session only when the panel has none, so a panel already holding shells would open the column, focus an old shell, and leave `nextTerminalCwd` set for whatever started next.

- [ ] **Step 4: Carry it to the pages**

In `src/preload/terminal.ts`, beside `onShown`:

```ts
  onOpenNew: (listener: () => void) => {
    ipcRenderer.on('terminal:open-new', () => {
      listener()
    })
  },
```

In `src/renderer/terminal/main.ts`, add `onOpenNew(listener: () => void): void` to the `window.terminal` declaration, and beside the `onShown` handler at the end:

```ts
window.terminal.onOpenNew(() => {
  // Always a new session, never a focus: main has already decided this one
  // starts somewhere other than the project, and an existing shell cannot be
  // moved there without typing into work that may be running.
  void open()
})
```

In `src/preload/pane.ts`, beside `cancelGitRemote`:

```ts
  openGitTerminal: (repo: string) => ipcRenderer.send('git:open-terminal', repo),
```

In `src/renderer/pane/bridge.ts`, beside `cancelGitRemote`:

```ts
      openGitTerminal(repo: string): void
```

- [ ] **Step 5: Run the tests and both typechecks**

Run: `npm test`
Run: `npx tsc -p tsconfig.json --noEmit && npx tsc -p tsconfig.pane.json --noEmit`
Expected: all pass, both clean.

- [ ] **Step 6: Prove the gate is load-bearing**

In `terminalCwdFor`, replace the guard with `return repo`. Re-run `npx vitest run src/main/index.spec.ts`. Expected: "falls back to the project" fails. Restore.

- [ ] **Step 7: Commit**

```bash
git add src/main/index.ts src/main/index.spec.ts src/preload/pane.ts src/preload/terminal.ts src/renderer/terminal/main.ts src/renderer/pane/bridge.ts
git commit -m "feat(git): a terminal in the repository that could not push"
```

---

### Task 6: The sync menu, and what it looks like while it runs

The repository header already carries the branch and its `↓2 ↑1`. Fetch, Pull and Push go behind a menu on the same header, drawn in the page like the branch list rather than popped natively — it is opened by a left click on a control that is part of the panel, and it has to be reachable by tab like everything else here.

**Files:**
- Modify: `src/renderer/pane/git.ts`, `src/renderer/pane.css`
- Test: `src/renderer/pane/git.spec.ts`

**Interfaces:**
- Consumes: `window.pane.gitRemote`, `window.pane.cancelGitRemote` from Task 4.
- Produces: nothing other tasks import; Task 7 adds to the same module.

- [ ] **Step 1: Write the failing tests**

In `src/renderer/pane/git.spec.ts`, add to `StubBridge`:

```ts
  gitRemote: (
    repo: string,
    op: string,
  ) => Promise<StubResult & { trouble?: string }>
  cancelGitRemote: (repo: string) => void
  openGitTerminal: (repo: string) => void
```

and to `stubBridge`'s options: `remote?: (StubResult & { trouble?: string })[]`, plus a `hold?: boolean` that makes `gitRemote` return a promise the test resolves. Implement inside `stubBridge`, recording into the existing `gitCalls`:

```ts
  let remotes = 0
  let release: ((answer: StubResult & { trouble?: string }) => void) | undefined
```

```ts
    gitRemote: async (repo, op) => {
      gitCalls.push(['remote', repo, op])
      if (options.hold === true) {
        return await new Promise<StubResult & { trouble?: string }>((resolve) => {
          release = resolve
        })
      }
      const answers = options.remote ?? [{ ok: true } as StubResult]
      const answer = answers[Math.min(remotes, answers.length - 1)]
      remotes += 1
      return answer
    },
    cancelGitRemote: (repo) => {
      gitCalls.push(['cancel-remote', repo])
    },
    openGitTerminal: (repo) => {
      gitCalls.push(['open-terminal', repo])
    },
    /** Answer the held `gitRemote`, as main would when git finished. */
    finish: (answer: StubResult & { trouble?: string } = { ok: true }) => release?.(answer),
```

Add `finish: (answer?: StubResult & { trouble?: string }) => void` to the `StubBridge` interface.

Then the tests:

```ts
describe('the remote', () => {
  /**
   * Press the header's sync control, and then one item in the menu it opens.
   * @param label - the item's accessible name, as `Fetch`, `Pull` or `Push`.
   */
  function pressSync(label: string): void {
    const open = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.getAttribute('aria-label') === 'Fetch, pull or push',
    )
    open?.click()
    const item = [...document.querySelectorAll<HTMLButtonElement>('.sync-item')].find(
      (button) => button.textContent === label,
    )
    item?.click()
  }

  it('offers fetch, pull and push behind one control', async () => {
    const bridge = stubBridge({ repos: [repo({})] })
    await load(bridge)
    const open = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.getAttribute('aria-label') === 'Fetch, pull or push',
    )
    expect(open).toBeDefined()
    open?.click()
    expect([...document.querySelectorAll('.sync-item')].map((node) => node.textContent)).toEqual([
      'Fetch',
      'Pull',
      'Push',
    ])
  })

  it('asks main for the operation that was chosen', async () => {
    const bridge = stubBridge({ repos: [repo({})] })
    await load(bridge)
    pressSync('Pull')
    for (let turn = 0; turn < 4; turn += 1) await Promise.resolve()
    expect(bridge.gitCalls).toContainEqual(['remote', '/p/repo', 'pull'])
  })

  // reason: these take seconds, and a panel that looked idle through all of
  // them would be pressed again — which main refuses, so the second press
  // would read as the panel being broken.
  it('shows that it is running, and offers to stop it', async () => {
    const bridge = stubBridge({ repos: [repo({})], hold: true })
    await load(bridge)
    pressSync('Fetch')
    for (let turn = 0; turn < 4; turn += 1) await Promise.resolve()
    expect(document.querySelector('.sync-running')?.textContent).toContain('Fetching')
    const cancel = document.querySelector<HTMLButtonElement>('.sync-cancel')
    expect(cancel).not.toBeNull()
    cancel?.click()
    expect(bridge.gitCalls).toContainEqual(['cancel-remote', '/p/repo'])
  })

  it('clears the running state when the operation answers', async () => {
    const bridge = stubBridge({ repos: [repo({})], hold: true })
    await load(bridge)
    pressSync('Fetch')
    for (let turn = 0; turn < 4; turn += 1) await Promise.resolve()
    bridge.finish({ ok: true })
    for (let turn = 0; turn < 6; turn += 1) await Promise.resolve()
    expect(document.querySelector('.sync-running')).toBeNull()
  })

  // reason: a failure with nothing recognisable in it is an ordinary failure,
  // and the note is where every other ordinary failure in this panel is said.
  it('says what git said when it was not a trouble it knows', async () => {
    const bridge = stubBridge({ repos: [repo({})], remote: [{ ok: false, reason: 'fetch first' }] })
    await load(bridge)
    pressSync('Push')
    for (let turn = 0; turn < 6; turn += 1) await Promise.resolve()
    expect(document.getElementById('git-note')?.textContent).toBe('fetch first')
  })

  // reason: two operations at once in one repository is what main refuses, so
  // the panel should not be able to ask for it.
  it('does not offer the menu while something is running', async () => {
    const bridge = stubBridge({ repos: [repo({})], hold: true })
    await load(bridge)
    pressSync('Fetch')
    for (let turn = 0; turn < 4; turn += 1) await Promise.resolve()
    const open = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.getAttribute('aria-label') === 'Fetch, pull or push',
    )
    expect(open).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/renderer/pane/git.spec.ts`
Expected: FAIL — there is no control with that label.

- [ ] **Step 3: Implement the state and the menu**

In `src/renderer/pane/git.ts`, beside `branchMenu` near line 75:

```ts
/** Which repository has its Fetch/Pull/Push menu open, if any. */
let syncMenu: string | undefined

/** The remote operation running in each repository, by the word for it. */
const running = new Map<string, 'Fetching' | 'Pulling' | 'Pushing' | 'Publishing'>()

/** What the running state is called for each operation. */
const DOING = {
  fetch: 'Fetching',
  pull: 'Pulling',
  push: 'Pushing',
  publish: 'Publishing',
} as const
```

Add the runner, beside `stashAndSwitch`:

```ts
/**
 * Ask a remote for one thing, and show that it is happening.
 *
 * These are the only operations in this panel that wait on something outside
 * this machine, so they are the only ones that need a state between pressed
 * and answered. Without it the panel looks idle for the seconds a fetch takes
 * and is pressed again — which main refuses, since two remote operations in
 * one working tree race for the same lock, so the second press would read as
 * the panel being broken rather than as the panel being busy.
 * @param repo - the repository to act on.
 * @param op - which operation.
 * @returns resolution once it has answered and been drawn.
 */
async function runRemote(repo: string, op: 'fetch' | 'pull' | 'push' | 'publish'): Promise<void> {
  say('')
  syncMenu = undefined
  trouble = undefined
  running.set(repo, DOING[op])
  draw()
  const out = await window.pane.gitRemote(repo, op)
  running.delete(repo)
  if (!out.ok) {
    // A trouble the panel knows gets a note with a way out of it; anything
    // else is an ordinary failure and belongs where every other one goes.
    if (out.trouble !== undefined) trouble = { repo, kind: out.trouble, say: out.reason }
    else say(out.reason)
  }
  draw()
}
```

`trouble` is declared in Task 7; declare it here as `let trouble: { repo: string; kind: string; say: string } | undefined` and Task 7 narrows the type.

The menu, beside `branchList`:

```ts
/**
 * The list the sync control opens: one operation each, never a combined Sync.
 *
 * Sync is pull-then-push, and a compound operation that half-succeeded is one
 * the panel then has to explain — usually while the user is looking at a
 * repository in a state neither half described.
 * @param repo - the repository the menu belongs to.
 * @returns the menu, ready to append.
 */
function syncList(repo: RepoView): HTMLElement {
  const menu = document.createElement('div')
  menu.className = 'branch-menu sync-menu'
  menu.setAttribute('role', 'group')
  menu.setAttribute('aria-label', `Remote operations in ${repo.name}`)
  const item = (op: 'fetch' | 'pull' | 'push', label: string, hint: string): HTMLButtonElement => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'branch-item sync-item'
    button.dataset.key = keyOf(repo.path, 'sync', op, 'pick')
    button.textContent = label
    button.title = hint
    button.addEventListener('click', () => {
      void runRemote(repo.path, op)
    })
    return button
  }
  menu.append(item('fetch', 'Fetch', 'Bring the remote branches up to date, changing nothing here'))
  menu.append(item('pull', 'Pull', 'Fetch and integrate, however your pull.rebase says to'))
  menu.append(item('push', 'Push', 'Send this branch to its upstream'))
  return menu
}

/**
 * What the header shows instead of its controls while a remote runs.
 * @param repo - the repository.
 * @param doing - the word for what is happening.
 * @returns the line, ready to append.
 */
function runningNote(repo: RepoView, doing: string): HTMLElement {
  const line = document.createElement('span')
  line.className = 'sync-running'
  const text = document.createElement('span')
  text.className = 'sync-running-text'
  text.textContent = `${doing}…`
  line.append(text)
  const stop = document.createElement('button')
  stop.type = 'button'
  stop.className = 'row-action sync-cancel'
  stop.dataset.key = keyOf(repo.path, '', '', 'cancel-remote')
  stop.title = `Stop ${doing.toLowerCase()} in ${repo.name}`
  stop.setAttribute('aria-label', `Stop ${doing.toLowerCase()} in ${repo.name}`)
  stop.textContent = '×'
  // Kills the child rather than only hiding the spinner: an operation that
  // was going nowhere is still going nowhere with the spinner gone.
  stop.addEventListener('click', () => {
    window.pane.cancelGitRemote(repo.path)
  })
  line.append(stop)
  return line
}
```

In `repoActions`, before the `return actions`:

```ts
  // While one is running the header shows that instead of the control: main
  // refuses a second operation in the same repository, so a menu that could
  // still be opened would only offer a refusal.
  const doing = running.get(repo.path)
  if (doing !== undefined) {
    actions.append(runningNote(repo, doing))
    return actions
  }
  actions.append(
    iconButton(at('sync'), 'Fetch, pull or push', '⇅', () => {
      branchMenu = undefined
      syncMenu = syncMenu === repo.path ? undefined : repo.path
      draw()
    }),
  )
```

In `drawRepo`, beside the `branchMenu === repo.path` block:

```ts
  if (syncMenu === repo.path && asking === undefined) block.append(syncList(repo))
```

and inside the existing Escape handler, clear `syncMenu` alongside `branchMenu`. In `branchTag`'s click handler, set `syncMenu = undefined` alongside `asking = undefined`, so only one menu is ever open.

- [ ] **Step 4: Style it**

In `src/renderer/pane.css`, beside the `.branch-menu` rules:

```css
/* The running state stands where the header's actions were, so the eye does
   not have to find a new place to look for the answer to what it just did. */
.sync-running {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.sync-running-text {
  font-size: 11px;
  opacity: 0.75;
}
```

Match the surrounding file: read `.branch-menu` and `.row-action` first and follow their spacing, tokens and comment voice.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/renderer/pane/git.spec.ts`
Expected: PASS.

- [ ] **Step 6: Prove the running state is load-bearing**

Delete `running.set(repo, DOING[op])`. Re-run. Expected: "shows that it is running" and "does not offer the menu while something is running" both fail. Restore.

- [ ] **Step 7: Typecheck and commit**

Run: `npx tsc -p tsconfig.pane.json --noEmit && npm test`

```bash
git add src/renderer/pane/git.ts src/renderer/pane/git.spec.ts src/renderer/pane.css
git commit -m "feat(git): fetch, pull and push from the repository header"
```

---

### Task 7: The note that says which credential is missing, and the way out

The four failures get a note of their own rather than the one-line `#git-note`, because each carries an action: a terminal in that repository, or — for the branch with no upstream — one button that publishes it.

**Files:**
- Modify: `src/renderer/pane/git.ts`, `src/renderer/pane.css`, `docs/notes/git-panel.md`, `README.md`
- Test: `src/renderer/pane/git.spec.ts`

**Interfaces:**
- Consumes: `window.pane.openGitTerminal` (Task 5), `runRemote` and `trouble` (Task 6).
- Produces: nothing.

- [ ] **Step 1: Write the failing tests**

Append to the `describe('the remote', …)` block in `src/renderer/pane/git.spec.ts`:

```ts
  /**
   * Press a sync item and let the answer land.
   * @param label - the item to press.
   * @returns resolution once the panel has redrawn.
   */
  async function sync(label: string): Promise<void> {
    pressSync(label)
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
  }

  // reason: this app has no askpass of its own by design, so the cost is that
  // an uncached credential cannot push from the panel — and that cost is only
  // acceptable if the panel says so and offers the way out.
  it('offers a terminal in the repository when a credential is missing', async () => {
    const bridge = stubBridge({
      repos: [repo({})],
      remote: [{ ok: false, reason: 'This remote needs an HTTPS credential this app does not have.', trouble: 'https' }],
    })
    await load(bridge)
    await sync('Push')
    const note = document.querySelector('.sync-trouble')
    expect(note?.textContent).toContain('HTTPS credential')
    expect(note?.textContent).toContain('repo')
    const open = document.querySelector<HTMLButtonElement>('.sync-trouble-terminal')
    expect(open).not.toBeNull()
    open?.click()
    expect(bridge.gitCalls).toContainEqual(['open-terminal', '/p/repo'])
  })

  it('offers the same way out for a key the agent is not holding', async () => {
    const bridge = stubBridge({
      repos: [repo({})],
      remote: [{ ok: false, reason: 'The SSH key for this remote is not loaded in your agent.', trouble: 'publickey' }],
    })
    await load(bridge)
    await sync('Push')
    expect(document.querySelector('.sync-trouble-terminal')).not.toBeNull()
  })

  // reason: the first push of every branch anyone creates hits this, and it
  // is the one trouble with a real answer inside the panel.
  it('offers to publish a branch that has no upstream', async () => {
    const bridge = stubBridge({
      repos: [repo({})],
      remote: [
        { ok: false, reason: 'This branch has no upstream yet, so git does not know where to push it.', trouble: 'no-upstream' },
        { ok: true },
      ],
    })
    await load(bridge)
    await sync('Push')
    const publish = document.querySelector<HTMLButtonElement>('.sync-trouble-publish')
    expect(publish).not.toBeNull()
    publish?.click()
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
    expect(bridge.gitCalls).toContainEqual(['remote', '/p/repo', 'publish'])
  })

  // reason: a note left up after the thing it described was fixed is a note
  // that says the panel is still broken when it is not.
  it('clears the note when the next operation is started', async () => {
    const bridge = stubBridge({
      repos: [repo({})],
      remote: [{ ok: false, reason: 'x', trouble: 'hostkey' }, { ok: true }],
    })
    await load(bridge)
    await sync('Push')
    expect(document.querySelector('.sync-trouble')).not.toBeNull()
    await sync('Fetch')
    expect(document.querySelector('.sync-trouble')).toBeNull()
  })

  // reason: a note about one repository hanging under another is worse than
  // no note: it names the wrong place to go and fix it.
  it('shows the note only under the repository it is about', async () => {
    const bridge = stubBridge({
      repos: [repo({ path: '/p/one' }), repo({ path: '/p/two' })],
      remote: [{ ok: false, reason: 'x', trouble: 'https' }],
    })
    await load(bridge)
    await sync('Push')
    const notes = document.querySelectorAll('.sync-trouble')
    expect(notes).toHaveLength(1)
  })
```

The two-repository test needs `pressSync` to act on the first repository; the menu opener it finds is the first in document order, which is `/p/one`'s. Confirm `repo()` accepts a `path` — it does, per its options — and that both repositories draw headers, since `alone` is false with two.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/renderer/pane/git.spec.ts`
Expected: FAIL — there is no `.sync-trouble`.

- [ ] **Step 3: Implement**

In `src/renderer/pane/git.ts`, narrow the declaration Task 6 added:

```ts
/** Which of the failures the panel knows how to talk about main reported. */
type TroubleKind = 'https' | 'publickey' | 'hostkey' | 'rejected' | 'no-upstream'

/**
 * The remote failure a note is up for, if any.
 *
 * One at a time and per repository: these are answered one at a time, and a
 * note about a repository that is not the one it hangs under names the wrong
 * place to go and fix it.
 */
let trouble: { repo: string; kind: TroubleKind; say: string } | undefined
```

and in `runRemote`, `if (out.trouble !== undefined) trouble = { repo, kind: out.trouble, say: out.reason }`.

Add the note, beside `blockedNote`:

```ts
/**
 * The note shown when a remote refused for a reason the panel recognises.
 *
 * Every one of these names the repository and offers the terminal: run it
 * once by hand, let git's own credential helper cache what it needs, and the
 * panel works from then on. That escape hatch is what makes this app's having
 * no askpass of its own acceptable rather than merely principled — a
 * credential it never sees is one it cannot leak, and the cost is a shell.
 * @param at - the repository, which trouble it was, and the sentence for it.
 * @param name - the repository's display name.
 * @returns the note, ready to append.
 */
function troubleNote(at: { repo: string; kind: TroubleKind; say: string }, name: string): HTMLElement {
  const note = document.createElement('div')
  note.className = 'branch-blocked sync-trouble'
  const text = document.createElement('p')
  text.className = 'branch-blocked-text'
  text.textContent = `${name}: ${at.say}`
  note.append(text)
  // The one trouble with an answer inside the panel. Publishing is
  // `--set-upstream` to the only remote there is, which is what anyone
  // pushing a new branch for the first time means by it; main refuses to
  // guess when there is more than one.
  if (at.kind === 'no-upstream') {
    const publish = document.createElement('button')
    publish.type = 'button'
    publish.className = 'branch-blocked-button sync-trouble-publish'
    publish.dataset.key = keyOf(at.repo, 'sync', '', 'publish')
    publish.textContent = 'Publish branch'
    publish.addEventListener('click', () => {
      void runRemote(at.repo, 'publish')
    })
    note.append(publish)
  }
  const open = document.createElement('button')
  open.type = 'button'
  open.className = 'branch-blocked-button sync-trouble-terminal'
  open.dataset.key = keyOf(at.repo, 'sync', '', 'terminal')
  open.textContent = 'Open in Terminal'
  open.addEventListener('click', () => {
    window.pane.openGitTerminal(at.repo)
  })
  note.append(open)
  return note
}
```

In `drawRepo`, beside the `blocking?.repo === repo.path` line:

```ts
  if (trouble?.repo === repo.path) block.append(troubleNote(trouble, repo.name))
```

- [ ] **Step 4: Style it**

In `src/renderer/pane.css`, beside `.branch-blocked`:

`.branch-blocked` is already a flex column, which stacks the no-upstream
note's two buttons one under the other. They belong side by side, wrapping
only when the column is too narrow:

```css
/* The no-upstream note carries two buttons where the blocked-switch note
   carries one, so they sit in a row under a sentence that keeps the width. */
.sync-trouble {
  flex-flow: row wrap;
  align-items: center;
}

.sync-trouble .branch-blocked-text {
  flex: 1 0 100%;
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/renderer/pane/git.spec.ts`
Expected: PASS.

- [ ] **Step 6: Prove the per-repository check is load-bearing**

Change `trouble?.repo === repo.path` to `trouble !== undefined`. Re-run. Expected: "shows the note only under the repository it is about" fails with two notes. Restore.

- [ ] **Step 7: Amend the spec**

In `docs/notes/git-panel.md`, under *The remote*, after the paragraph beginning "Not a combined Sync", add:

```markdown
A branch with no upstream is the fifth failure recognised, and the only one
with an answer inside the panel: **Publish branch** runs `git push
--set-upstream` to the repository's only remote. The remote is read from `git
remote` rather than named by the panel, and the branch is `HEAD` rather than a
name — so nothing typed anywhere reaches the command line — and a repository
with more than one remote is a refusal rather than a guess, because publishing
to a fork nobody was watching is not a mistake to make on someone's behalf.
```

Under *Failing loudly*, replace the sentence "Each names the repo and offers **Open in Terminal**, which opens the terminal panel in that repo's directory" with:

```markdown
Each names the repo and offers **Open in Terminal**, which opens the terminal
panel and starts a *new* shell in that repository — never a `cd` typed into a
shell that may be in the middle of something. Main holds the directory and the
terminal page is only told to open a session, so the terminal's own rule holds:
the page names a size, and main decides what runs and where.
```

- [ ] **Step 8: A paragraph in the README**

In the Source Control section of `README.md`, after the existing description, add one paragraph in the README's voice:

```markdown
Fetch, pull and push are on the repository header, one command each — never a
combined sync. The app supplies no askpass of its own, deliberately: a
credential it never sees is one it cannot leak. So a repository whose
credential is not already cached says which one is missing and offers a
terminal in that repository, where git's own helper can cache it once.
```

- [ ] **Step 9: The whole suite and both typechecks**

Run: `npm test`
Expected: every test passes; the count is at least 1591 plus what this plan added.
Run: `npx tsc -p tsconfig.json --noEmit && npx tsc -p tsconfig.pane.json --noEmit`
Expected: both clean.

- [ ] **Step 10: Commit**

```bash
git add src/renderer/pane/git.ts src/renderer/pane/git.spec.ts src/renderer/pane.css docs/notes/git-panel.md README.md
git commit -m "feat(git): say which credential is missing, and open a terminal where it can be cached"
```

---

## Manual verification

None of this is provable by a test that mocks git, so it is checked by hand once, in a packaged build (`npm run pack`, then quit any running copy from the tray first — the single-instance lock will otherwise make the new build exit immediately):

1. **Fetch** on a repository with a remote: the header shows `Fetching…`, then the counts move if the remote had moved.
2. **Cancel** a fetch on a large repository, or one whose remote is unreachable: the spinner clears and the note says `Cancelled.`, not a git error.
3. **Push** on a branch with no upstream: the note offers **Publish branch**; pressing it sets the upstream and pushes.
4. **Push** on a repository whose HTTPS credential is not cached: the note names the repository and the missing credential, and **Open in Terminal** opens a new shell *in that repository* — check the tab's title.
5. **Two repositories** in one project: a fetch running in one leaves the other's control usable.
6. **Pull** on a repository with `pull.rebase = true`: it rebases; the panel imposes nothing.
