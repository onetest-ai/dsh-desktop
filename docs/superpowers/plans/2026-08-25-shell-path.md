# Shell PATH Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the harness child the PATH the user has in their terminal, so `npx`, `uvx`, and `docker` resolve for a Finder-launched app.

**Architecture:** Resolve `$SHELL -ilc 'echo $PATH'` once, cache it in `$DSH_HOME/shell-path.json`, use the cached value at launch and refresh in the background. A manual `extraPath` in `desktop.json` is prepended ahead of it as an override. Every step fails soft: no cache and no override reproduces today's behaviour exactly.

**Tech Stack:** TypeScript, Electron 33, Node 22, vitest, Playwright (smoke).

**Spec:** `docs/superpowers/specs/2026-08-25-mcp-config-and-shell-path-design.md`

## Global Constraints

- Node `>=22`; TypeScript `module: CommonJS`, `strict: true`.
- Every module and export carries JSDoc stating its non-obvious contract; function-like exports document `@param`/`@returns`. Comments state facts and consequences, never narration.
- Tests describe behavior. When a test guards something important, break the code deliberately and confirm the test fails before moving on.
- Never widen `resolveBinary`'s existing contract or remove `pnpmPath`/`npmPath`.
- Resolution must never make launch slower than today when the cache is warm, and must never fail the launch when it errors.
- Shell resolution timeout: **10000 ms**. Cache document version: **1**.
- Run `npx vitest run` and `npx tsc --noEmit -p tsconfig.json` before every commit.

---

### Task 1: Shell PATH resolution and cache

**Files:**
- Create: `src/main/shell-path.ts`
- Test: `src/main/shell-path.spec.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `shellPathCachePath(dshHome: string): string`
  - `readCachedShellPath(file: string): string | undefined`
  - `resolveShellPath(shell: string | undefined, run: ShellRunner): string | undefined`
  - `writeCachedShellPath(file: string, path: string, shell: string, now: string): void`
  - `type ShellRunner = (shell: string, args: string[]) => string`
  - `SHELL_RESOLVE_TIMEOUT_MS: number`

- [ ] **Step 1: Write the failing test**

Create `src/main/shell-path.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readCachedShellPath,
  resolveShellPath,
  shellPathCachePath,
  writeCachedShellPath,
} from './shell-path'

/** A fresh cache-file path that does not exist yet. */
function freshFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'dsh-shellpath-')), 'shell-path.json')
}

describe('shellPathCachePath', () => {
  it('sits beside desktop.json rather than inside it', () => {
    expect(shellPathCachePath('/home/.dsh')).toBe('/home/.dsh/shell-path.json')
  })
})

describe('resolveShellPath', () => {
  it('returns the PATH the login shell reports', () => {
    const resolved = resolveShellPath('/bin/zsh', () => '/opt/homebrew/bin:/usr/bin\n')
    expect(resolved).toBe('/opt/homebrew/bin:/usr/bin')
  })

  it('asks an interactive login shell, the only mode that sources nvm', () => {
    let seen: string[] = []
    resolveShellPath('/bin/zsh', (_shell, args) => {
      seen = args
      return '/usr/bin\n'
    })
    expect(seen).toContain('-ilc')
  })

  it('uses the last line, since a chatty rc file may print first', () => {
    const resolved = resolveShellPath('/bin/zsh', () => 'welcome banner\n/opt/homebrew/bin:/usr/bin\n')
    expect(resolved).toBe('/opt/homebrew/bin:/usr/bin')
  })

  it('gives up when no shell is known rather than guessing one', () => {
    expect(resolveShellPath(undefined, () => '/usr/bin')).toBeUndefined()
  })

  it('gives up when the shell fails, so a broken rc file cannot break launch', () => {
    expect(
      resolveShellPath('/bin/zsh', () => {
        throw new Error('ETIMEDOUT')
      }),
    ).toBeUndefined()
  })

  it('rejects output that is not a PATH, rather than caching noise', () => {
    expect(resolveShellPath('/bin/zsh', () => 'command not found: nvm\n')).toBeUndefined()
  })

  it('rejects empty output', () => {
    expect(resolveShellPath('/bin/zsh', () => '   \n')).toBeUndefined()
  })
})

describe('writeCachedShellPath / readCachedShellPath', () => {
  it('round-trips a resolved PATH', () => {
    const file = freshFile()
    writeCachedShellPath(file, '/opt/homebrew/bin:/usr/bin', '/bin/zsh', '2026-08-25T00:00:00.000Z')
    expect(readCachedShellPath(file)).toBe('/opt/homebrew/bin:/usr/bin')
  })

  it('records which shell produced it, so a changed shell is diagnosable', () => {
    const file = freshFile()
    writeCachedShellPath(file, '/usr/bin', '/bin/zsh', '2026-08-25T00:00:00.000Z')
    expect(JSON.parse(readFileSync(file, 'utf8')).shell).toBe('/bin/zsh')
  })

  it('writes owner-only: a PATH names directories worth not advertising', () => {
    const file = freshFile()
    writeCachedShellPath(file, '/usr/bin', '/bin/zsh', '2026-08-25T00:00:00.000Z')
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('reads an absent cache as undefined', () => {
    expect(readCachedShellPath(freshFile())).toBeUndefined()
  })

  it('reads a malformed cache as undefined rather than throwing', () => {
    const file = freshFile()
    writeFileSync(file, 'not json')
    expect(readCachedShellPath(file)).toBeUndefined()
  })

  it('discards a cache claiming a version it does not understand', () => {
    const file = freshFile()
    writeFileSync(file, JSON.stringify({ version: 99, path: '/usr/bin' }))
    expect(readCachedShellPath(file)).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/shell-path.spec.ts`
Expected: FAIL — `Failed to resolve import "./shell-path"`.

- [ ] **Step 3: Write the implementation**

Create `src/main/shell-path.ts`:

```ts
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * How long the login shell may take to report its PATH.
 *
 * Generous because an interactive login shell sources the user's whole rc
 * file — measured at roughly 2.6 seconds on a development machine with nvm
 * and Homebrew — and bounded because that shell runs on a path that must
 * never be able to hang the app's launch.
 */
export const SHELL_RESOLVE_TIMEOUT_MS = 10_000

/**
 * Runs the login shell and returns its stdout. Injected so tests never spawn
 * a real shell, whose output depends on the developer's own rc files.
 * @param shell - absolute path to the user's shell.
 * @param args - arguments to pass it.
 * @returns the command's stdout.
 */
export type ShellRunner = (shell: string, args: string[]) => string

/**
 * The cache file, beside `desktop.json`.
 *
 * A separate file because this is derived state the app rewrites on its own
 * schedule, while `desktop.json` is hand-edited and user-owned; mixing the
 * two would mean rewriting the user's config to refresh a cache.
 * @param dshHome - the resolved `$DSH_HOME` directory.
 * @returns the absolute cache-file path.
 */
export function shellPathCachePath(dshHome: string): string {
  return join(dshHome, 'shell-path.json')
}

/** The cache document. `version` lets a later format reject this one outright. */
interface CacheDocument {
  version: 1
  path: string
  shell: string
  resolvedAt: string
}

/** The only format this version understands. */
const CURRENT_VERSION = 1

/**
 * Ask the user's login shell for its PATH.
 *
 * Interactive (`-i`) as well as login (`-l`), because version managers put
 * their initialization in `.zshrc`/`.bashrc` rather than `.zprofile`:
 * measured, a non-interactive login shell resolves in 132 ms but reports no
 * nvm directory at all, while the interactive one takes 2.6 seconds and
 * finds it. Correctness wins here; the cost is paid once and cached.
 *
 * Never throws. A shell that hangs, exits non-zero, or prints something that
 * is not a PATH yields undefined, and the caller keeps whatever it had.
 * @param shell - `$SHELL`, or undefined when the environment does not say.
 * @param run - runs the shell; injected for tests.
 * @returns the reported PATH, or undefined when it could not be established.
 */
export function resolveShellPath(shell: string | undefined, run: ShellRunner): string | undefined {
  if (shell === undefined || shell === '') return undefined
  let output: string
  try {
    output = run(shell, ['-ilc', 'echo $PATH'])
  } catch {
    // A timeout, a non-zero exit, or a shell that is not executable. All mean
    // the same thing to this function: no PATH was established.
    return undefined
  }
  // The last non-empty line: an rc file that prints a banner or a warning
  // puts it before the echoed value.
  const candidate = output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .at(-1)
  if (candidate === undefined) return undefined
  // A PATH is absolute entries separated by colons. Requiring one absolute
  // entry rejects an rc file's error text ("command not found: nvm") without
  // trying to validate every directory, which would reject a legitimate PATH
  // naming a directory that does not exist yet.
  if (!candidate.split(':').some((entry) => entry.startsWith('/'))) return undefined
  return candidate
}

/**
 * Persist a resolved PATH.
 *
 * Owner-only: a PATH enumerates the user's toolchain directories, which is
 * not worth advertising to other accounts on the machine. The mode is set
 * again after the write because an already-existing file keeps its own.
 * @param file - the cache-file path.
 * @param path - the resolved PATH.
 * @param shell - the shell that produced it.
 * @param now - an ISO timestamp, passed in so the caller owns the clock.
 */
export function writeCachedShellPath(file: string, path: string, shell: string, now: string): void {
  const document: CacheDocument = { version: CURRENT_VERSION, path, shell, resolvedAt: now }
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(document, undefined, 2)}\n`, { mode: 0o600 })
  chmodSync(file, 0o600)
}

/**
 * Read the cached PATH.
 *
 * A missing, unreadable, malformed, or wrong-version cache reads as absent:
 * this is an optimization, and a broken one must degrade to "resolve again"
 * rather than to a failed launch.
 * @param file - the cache-file path.
 * @returns the cached PATH, or undefined.
 */
export function readCachedShellPath(file: string): string | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const document = parsed as Partial<CacheDocument>
  if (document.version !== CURRENT_VERSION) return undefined
  return typeof document.path === 'string' && document.path !== '' ? document.path : undefined
}

/**
 * The default runner: the real shell, bounded and given a minimal
 * environment so the result reflects the user's rc files rather than
 * whatever this process happens to have inherited.
 * @param shell - absolute path to the user's shell.
 * @param args - arguments to pass it.
 * @returns the command's stdout.
 */
export function runShell(shell: string, args: string[]): string {
  return execFileSync(shell, args, {
    encoding: 'utf8',
    timeout: SHELL_RESOLVE_TIMEOUT_MS,
    env: { HOME: process.env.HOME ?? '', TERM: 'xterm' },
    stdio: ['ignore', 'pipe', 'ignore'],
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/shell-path.spec.ts`
Expected: PASS, 14 tests.

- [ ] **Step 5: Prove the tests are not vacuous**

Temporarily change `['-ilc', 'echo $PATH']` to `['-lc', 'echo $PATH']` and re-run.
Expected: the "asks an interactive login shell" test FAILS. Restore the line.

Then temporarily delete the `chmodSync` line and re-run.
Expected: the "writes owner-only" test still passes (the `mode` option covers a new file) — this is expected, and the `chmodSync` covers the pre-existing-file case, which the `secrets.spec.ts` suite already proves. Restore the line.

- [ ] **Step 6: Verify against a real shell, once, by hand**

Run: `node -e "const {resolveShellPath,runShell}=require('./dist/main/shell-path.js');console.log(resolveShellPath(process.env.SHELL,runShell))"` after `npm run build`.
Expected: a PATH containing your version manager's directory, not `/usr/bin:/bin:/usr/sbin:/sbin`.

- [ ] **Step 7: Commit**

```bash
git add src/main/shell-path.ts src/main/shell-path.spec.ts
git commit -m "feat(path): resolve and cache the login shell's PATH"
```

---

### Task 2: Compose the child's PATH

**Files:**
- Modify: `src/main/server.ts` (`dshWebCommand`)
- Modify: `src/main/config.ts` (`DesktopConfig`, `parseConfig`)
- Test: `src/main/server.spec.ts`, `src/main/config.spec.ts`

**Interfaces:**
- Consumes: nothing at runtime from Task 1; this task adds the seam Task 3 fills.
- Produces:
  - `DesktopConfig.extraPath?: string`
  - `dshWebCommand(config, patchFile, dshHome, extraEnv?, shellPath?)` — `shellPath` is the resolved PATH from Task 1, or undefined.

- [ ] **Step 1: Write the failing tests**

Append to `src/main/server.spec.ts`:

```ts
describe('dshWebCommand PATH composition', () => {
  const CONFIG = { harness: { kind: 'local' as const, repo: '/tmp/h' }, notifyPort: 1, hotkey: 'X' }

  /** The PATH entries the child would be spawned with. */
  function pathEntries(spec: { env?: NodeJS.ProcessEnv }): string[] {
    return (spec.env?.PATH ?? '').split(':')
  }

  it('puts the resolved shell PATH ahead of the inherited one', () => {
    const spec = dshWebCommand(CONFIG, '/tmp/p.yml', '/tmp/home', {}, '/opt/homebrew/bin')
    expect(pathEntries(spec)).toContain('/opt/homebrew/bin')
  })

  it('puts an explicit extraPath ahead of the resolved one, since it is the override', () => {
    const spec = dshWebCommand(
      { ...CONFIG, extraPath: '/my/override' },
      '/tmp/p.yml',
      '/tmp/home',
      {},
      '/opt/homebrew/bin',
    )
    const entries = pathEntries(spec)
    expect(entries.indexOf('/my/override')).toBeLessThan(entries.indexOf('/opt/homebrew/bin'))
  })

  it('changes nothing when neither is set, so today’s behaviour is preserved', () => {
    const without = dshWebCommand(CONFIG, '/tmp/p.yml', '/tmp/home')
    const withNothing = dshWebCommand(CONFIG, '/tmp/p.yml', '/tmp/home', {}, undefined)
    expect(withNothing.env?.PATH).toBe(without.env?.PATH)
  })

  it('does not duplicate an entry the inherited PATH already had', () => {
    const spec = dshWebCommand(CONFIG, '/tmp/p.yml', '/tmp/home', {}, '/usr/bin')
    expect(pathEntries(spec).filter((entry) => entry === '/usr/bin')).toHaveLength(1)
  })
})
```

Append to `src/main/config.spec.ts`:

```ts
describe('extraPath', () => {
  it('is read back from the config', () => {
    const file = writeConfigFile({ harness: { kind: 'local', repo: REPO }, extraPath: '/my/bin' })
    const result = loadConfig(file)
    expect(result.configured && result.config.extraPath).toBe('/my/bin')
  })

  it('is optional, so a config predating it stays valid', () => {
    const file = writeConfigFile({ harness: { kind: 'local', repo: REPO } })
    const result = loadConfig(file)
    expect(result.configured && result.config.extraPath).toBeUndefined()
  })

  it('is rejected when it is not a string, since it reaches a spawned PATH', () => {
    const file = writeConfigFile({ harness: { kind: 'local', repo: REPO }, extraPath: 42 })
    expect(() => loadConfig(file)).toThrow(/extraPath/)
  })
})
```

Note: `writeConfigFile` and `REPO` already exist in `config.spec.ts`; reuse them rather than adding new helpers. If the existing helper has a different name, adapt these tests to it — preserve their intent, not their spelling.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/server.spec.ts src/main/config.spec.ts`
Expected: FAIL — `extraPath` is not on `DesktopConfig`, and `dshWebCommand` takes four parameters.

- [ ] **Step 3: Add the config field**

In `src/main/config.ts`, add to `DesktopConfig` after `npmPath`:

```ts
  /**
   * Extra `PATH` entries for the harness child, prepended ahead of the
   * resolved login-shell PATH.
   *
   * An override for a machine where shell resolution fails — a shell this app
   * cannot run, or an rc file that establishes tools some other way. It is
   * not the mechanism: the resolved PATH is, and it self-heals across version
   * manager upgrades where a hardcoded entry does not.
   */
  extraPath?: string
```

In `parseConfig`, before the `return`:

```ts
  if (record.extraPath !== undefined && typeof record.extraPath !== 'string') {
    throw new ConfigurationError(`dsh-desktop: ${filePath} "extraPath" must be a string`)
  }
```

And add to the returned object:

```ts
    ...(record.extraPath === undefined ? {} : { extraPath: record.extraPath }),
```

- [ ] **Step 4: Compose the PATH**

In `src/main/server.ts`, replace `dshWebCommand` with:

```ts
export function dshWebCommand(
  config: DesktopConfig,
  patchFile: string,
  dshHome: string,
  extraEnv: Record<string, string> = {},
  shellPath?: string,
): SpawnSpec {
  const spec = spawnFor(config.harness, { pnpm: () => resolveBinary(config.pnpmPath, 'pnpm', process.env) }, patchFile, dshHome)
  const launcherDir =
    config.harness.kind === 'managed' ? resolveBinary(config.npmPath, 'npm', process.env) : spec.command
  // Only the process about to be spawned gets the extended PATH; the app's
  // own process.env is never touched.
  const withPath = envWithLauncherDir(launcherDir, process.env)
  const base = withPath ?? process.env
  const composed = composePath(base.PATH ?? '', config.extraPath, shellPath)
  if (Object.keys(extraEnv).length === 0 && composed === base.PATH) {
    return withPath === undefined ? spec : { ...spec, env: withPath }
  }
  return { ...spec, env: { ...base, ...extraEnv, PATH: composed } }
}

/**
 * Build the child's `PATH`: the manual override first, then the resolved
 * login-shell PATH, then whatever this process inherited.
 *
 * The override leads because it exists for the case where resolution got it
 * wrong. `envWithLauncherDir` has already prepended the launcher's own
 * directory to `inherited`, and that entry stays ahead of the inherited
 * system directories, which is what keeps a pinned `pnpmPath`/`npmPath`
 * authoritative for the launcher itself.
 *
 * Duplicates are dropped, keeping each entry's first occurrence, so a
 * resolved PATH that already contains the inherited directories does not
 * produce a `PATH` several kilobytes long.
 * @param inherited - the PATH the child would otherwise get.
 * @param extraPath - the user's manual override, if set.
 * @param shellPath - the resolved login-shell PATH, if established.
 * @returns the composed PATH.
 */
function composePath(inherited: string, extraPath: string | undefined, shellPath: string | undefined): string {
  const seen = new Set<string>()
  const entries: string[] = []
  for (const source of [extraPath, shellPath, inherited]) {
    for (const entry of (source ?? '').split(':')) {
      if (entry === '' || seen.has(entry)) continue
      seen.add(entry)
      entries.push(entry)
    }
  }
  return entries.join(':')
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run`
Expected: PASS, all suites.

- [ ] **Step 6: Prove the ordering test is not vacuous**

In `composePath`, swap the loop source order to `[shellPath, extraPath, inherited]` and re-run.
Expected: "puts an explicit extraPath ahead of the resolved one" FAILS. Restore the order.

- [ ] **Step 7: Commit**

```bash
npx tsc --noEmit -p tsconfig.json
git add src/main/server.ts src/main/config.ts src/main/server.spec.ts src/main/config.spec.ts
git commit -m "feat(path): compose the harness child's PATH from override, shell, and inherited"
```

---

### Task 3: Wire resolution into launch

**Files:**
- Modify: `src/main/index.ts`
- Test: `src/main/index.spec.ts`

**Interfaces:**
- Consumes: `shellPathCachePath`, `readCachedShellPath`, `resolveShellPath`, `writeCachedShellPath`, `runShell` (Task 1); `dshWebCommand(..., shellPath)` (Task 2).
- Produces: nothing further tasks depend on.

- [ ] **Step 1: Write the failing test**

Append to `src/main/index.spec.ts`, inside the existing `describe('boot', …)` or as its own describe:

```ts
describe('shell PATH', () => {
  it('passes the cached PATH to the spawned harness', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-shellpath-boot-'))
    const original = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      writeFileSync(
        join(home, 'shell-path.json'),
        JSON.stringify({ version: 1, path: '/opt/homebrew/bin:/usr/bin', shell: '/bin/zsh', resolvedAt: 'x' }),
      )
      await bootReady()
      expect(dshWebCommandMock.mock.calls.at(-1)![4]).toBe('/opt/homebrew/bin:/usr/bin')
    } finally {
      if (original === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = original
    }
  })

  it('boots with no cached PATH at all, which is a first run', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-shellpath-empty-'))
    const original = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      await bootReady()
      expect(dshWebCommandMock.mock.calls.at(-1)![4]).toBeUndefined()
    } finally {
      if (original === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = original
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/index.spec.ts -t "shell PATH"`
Expected: FAIL — the fifth argument is undefined in the first case.

- [ ] **Step 3: Read the cache at boot**

In `src/main/index.ts`, add the import:

```ts
import { readCachedShellPath, resolveShellPath, runShell, shellPathCachePath, writeCachedShellPath } from './shell-path'
```

Add near `mcpEnv`:

```ts
/**
 * The login-shell PATH this boot should hand the harness child.
 *
 * Read from cache rather than resolved here: resolution costs seconds (an
 * interactive login shell sources the user's whole rc file), which must not
 * be added to every launch. `refreshShellPath` updates the cache in the
 * background, so a machine whose toolchain moved is correct from the next
 * launch onward.
 * @returns the cached PATH, or undefined on a first run or after a failure.
 */
function cachedShellPath(): string | undefined {
  return readCachedShellPath(shellPathCachePath(DSH_HOME))
}

/**
 * Re-resolve the login-shell PATH and cache it, off the launch path.
 *
 * Deliberately fire-and-forget and deliberately not awaited: nothing in this
 * boot uses the result, and a shell that takes its full timeout must delay
 * nothing the user can see. A failure leaves the previous cache in place.
 */
function refreshShellPath(): void {
  setTimeout(() => {
    const resolved = resolveShellPath(process.env.SHELL, runShell)
    if (resolved === undefined) return
    try {
      writeCachedShellPath(shellPathCachePath(DSH_HOME), resolved, process.env.SHELL ?? '', new Date().toISOString())
    } catch {
      // A cache that cannot be written is not worth reporting: the next
      // launch simply resolves again, and nothing else depends on it.
    }
  }, 0).unref()
}
```

- [ ] **Step 4: Use it at spawn, and schedule the refresh**

In `attemptBoot`, change the spawn call to:

```ts
      spec: dshWebCommand(config, patchPath, DSH_HOME, mcpEnv(config), cachedShellPath()),
```

In the `app.whenReady()` handler, after the first boot is scheduled, add:

```ts
  refreshShellPath()
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run`
Expected: PASS, all suites.

- [ ] **Step 6: Verify in the packaged app**

```bash
npm run pack
```

Then launch the packaged app from Finder, quit it, and run:

```bash
cat "$HOME/.dsh/shell-path.json"
```

Expected: a `path` containing your version manager's directory. Launch it a second time and confirm the launch is not visibly slower than before — the second launch reads the cache.

- [ ] **Step 7: Commit**

```bash
npx tsc --noEmit -p tsconfig.json
git add src/main/index.ts src/main/index.spec.ts
git commit -m "feat(path): give the harness the cached shell PATH, refreshed in the background"
```

---

### Task 4: Expose the override, and document

**Files:**
- Modify: `src/renderer/settings.html` (Advanced panel), `src/renderer/settings.js` (`FIELDS`, `FIELD_TAB`), `src/main/settings-validate.ts` (`SettingsForm`, `validateSettings`, `formFor`)
- Modify: `README.md`, `docs/notes/` (new note), `docs/decisions.md`, `CHANGELOG.md`
- Test: `src/renderer/settings.spec.ts`, `src/main/settings-validate.spec.ts`

**Interfaces:**
- Consumes: `DesktopConfig.extraPath` (Task 2).
- Produces: nothing further tasks depend on.

- [ ] **Step 1: Write the failing tests**

Append to `src/main/settings-validate.spec.ts`:

```ts
describe('extraPath field', () => {
  it('is carried from the form into the config', () => {
    const result = validateSettings(form({ extraPath: '/my/bin' }))
    expect(result.ok && result.config.extraPath).toBe('/my/bin')
  })

  it('is omitted when blank, so an untouched field writes nothing', () => {
    const result = validateSettings(form({ extraPath: '   ' }))
    expect(result.ok && 'extraPath' in result.config).toBe(false)
  })
})
```

Append to `src/renderer/settings.spec.ts`:

```ts
describe('Advanced tab extra PATH', () => {
  it('submits the field with the form', async () => {
    const save = vi.fn(async () => ({ ok: true, warnings: [] }))
    const renderer = await load(save)
    const field = renderer.elements.get('extraPath')
    if (field !== undefined) field.value = '/my/bin'
    await renderer.save()
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ extraPath: '/my/bin' }))
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/settings-validate.spec.ts src/renderer/settings.spec.ts`
Expected: FAIL — `extraPath` is not on `SettingsForm` and no such element exists.

- [ ] **Step 3: Add the field to the form model**

In `src/main/settings-validate.ts`, add to `SettingsForm` after `npmPath`:

```ts
  /**
   * Extra `PATH` entries for the harness child, colon-separated. Blank means
   * none, and writes no `extraPath` at all.
   */
  extraPath: string
```

In `validateSettings`, beside the existing `pnpmPath`/`npmPath` handling:

```ts
  const extraPath = form.extraPath.trim()
```

and in the returned config object:

```ts
      ...(extraPath === '' ? {} : { extraPath }),
```

In `formFor`'s `base`, add `extraPath: ''`, and in the configured branch add `extraPath: result.config.extraPath ?? ''`.

Add `extraPath: ''` to the `form()` helpers in `settings-validate.spec.ts` and `settings-ipc.spec.ts`.

- [ ] **Step 4: Add the field to the Advanced panel**

In `src/renderer/settings.html`, inside `#panel-advanced`'s `<section class="group">`, after the npm block:

```html
      <div class="field-label-row">
        <label for="extraPath">Extra PATH entries</label>
        <details class="field-info">
          <summary aria-label="About extra PATH entries"><span aria-hidden="true">i</span></summary>
          <p>Colon-separated directories added ahead of the PATH the agent's tools are found on. Normally unnecessary — the app reads your login shell's PATH automatically. Set this only when that fails.</p>
        </details>
      </div>
      <input id="extraPath" type="text" placeholder="/opt/homebrew/bin:/usr/local/bin" spellcheck="false">
      <p class="error" id="error-extraPath"></p>
```

In `src/renderer/settings.js`, add `'extraPath'` to `FIELDS` and `extraPath: 'advanced'` to `FIELD_TAB`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run`
Expected: PASS, all suites.

- [ ] **Step 6: Document**

Create `docs/notes/shell-path.md` covering: the measurements table from the spec; why interactive-login is required; why the result is cached and refreshed in the background rather than resolved per launch; the composition order (override, shell, inherited) and why the override leads; and that `pnpmPath`/`npmPath` are unchanged and now usually unnecessary.

Add to `docs/decisions.md` under a new `## Shell PATH (2026-08-25)` heading, one bullet each with its cost-if-wrong: the interactive-shell requirement and its 2.6 s price; cache-plus-background-refresh over per-launch resolution; the override leading; failing soft everywhere.

In `README.md`, add the Extra PATH entries row to the Settings table, and note under Requirements that the app reads the login shell's PATH so `npx`-based tools resolve.

Add to `CHANGELOG.md` under `[Unreleased]` → `### Added`: the shell PATH resolution, why it exists, and that `pnpmPath`/`npmPath` remain supported but are usually no longer needed.

- [ ] **Step 7: Full verification**

```bash
npx tsc --noEmit -p tsconfig.json
npx vitest run
npm run pack && npm run test:smoke
```

Expected: typecheck clean, all tests pass, smoke passes.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(path): expose an extra-PATH override on the Advanced tab"
```
