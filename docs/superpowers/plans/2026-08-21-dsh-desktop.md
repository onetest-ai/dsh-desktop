# dsh-desktop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an installable macOS Electron app that runs the DeepSeek Harness Web UI from a live local checkout, with tray, notifications, a global hotkey, and a `dsh://` handler.

**Architecture:** One Electron main process owns one child `dsh web` server process and one `BrowserWindow`. The server is spawned against the harness checkout with an OS-assigned port; its stdout ready line supplies both readiness and the port. All harness configuration happens through out-of-repo extension points (a `--patch` overlay and the `~/.dsh` profile directory).

**Tech Stack:** Electron 33, TypeScript (CommonJS output for the main process), Vitest for main-process unit tests, Playwright for one packaged smoke test, electron-builder for packaging.

**Spec:** `~/Development/dsh-desktop/docs/2026-08-21-dsh-desktop-design.md`

## Global Constraints

- **Zero-touch on the harness checkout.** Nothing in this project may create, modify, or delete any file under `/Users/arozumenko/Development/deepseek-harness`. `git status` there must stay clean at all times. If a task appears to require a harness edit, stop and raise it.
- Harness repo path comes from `config.json` key `harnessRepo`; the value for this machine is `/Users/arozumenko/Development/deepseek-harness`.
- The harness webserver port is always `0` (OS-assigned), set in `desktop.patch.yml`. Never hardcode 3080.
- The ready line printed by the harness is exactly `dsh web: http://127.0.0.1:<port>` and may be followed by a ` (LAN: ...)` suffix. Match the loopback URL only.
- The notification listener uses a **fixed** port, `notifyPort` in `config.json`, default `43117`.
- The `Stop` hook MUST exit 0 and print nothing to stdout. A blocking `Stop` hook forces another agent step via `steer()` and would loop forever.
- `dsh://` handling is **focus-only** in v1. Do not add session navigation; the harness web client has no URL routing.
- Node 22+ (matches the harness engines range).
- All child processes are spawned `detached: true` and killed as a process group.

---

### Task 1: Project scaffold, config loading, and preflight

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`
- Create: `config.json`, `desktop.patch.yml`
- Create: `src/main/config.ts`, `src/main/preflight.ts`
- Test: `src/main/config.spec.ts`, `src/main/preflight.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface DesktopConfig { harnessRepo: string; notifyPort: number; hotkey: string; pnpmPath?: string }`
  - `function loadConfig(filePath: string): DesktopConfig`
  - `type PreflightResult = { ok: true } | { ok: false; message: string }`
  - `function preflight(harnessRepo: string): PreflightResult`

- [ ] **Step 1: Create the project files**

`package.json`:

```json
{
  "name": "dsh-desktop",
  "version": "0.1.0",
  "private": true,
  "description": "Desktop shell for a local DeepSeek Harness checkout",
  "main": "dist/main/index.js",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "start": "npm run build && electron .",
    "pack": "npm run build && electron-builder --dir",
    "dist": "npm run build && electron-builder"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "electron": "^33.0.0",
    "electron-builder": "^25.0.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "CommonJS",
    "moduleResolution": "Node",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "sourceMap": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["src/**/*.spec.ts"]
}
```

`vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts', 'tests/**/*.spec.ts'],
    exclude: ['tests/smoke.spec.ts'],
    testTimeout: 30_000,
  },
})
```

`.gitignore`:

```
node_modules/
dist/
release/
.superpowers/
```

`config.json`:

```json
{
  "harnessRepo": "/Users/arozumenko/Development/deepseek-harness",
  "notifyPort": 43117,
  "hotkey": "CommandOrControl+Shift+D"
}
```

`desktop.patch.yml` — the harness `--patch` overlay. Port 0 means OS-assigned:

```yaml
- dsh-host-webserver:
    port: 0
```

- [ ] **Step 2: Write the failing config test**

`src/main/config.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from './config'

function writeConfig(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-desktop-config-'))
  const file = join(dir, 'config.json')
  writeFileSync(file, contents)
  return file
}

describe('loadConfig', () => {
  it('reads harnessRepo and applies defaults for the rest', () => {
    const file = writeConfig(JSON.stringify({ harnessRepo: '/tmp/harness' }))
    expect(loadConfig(file)).toEqual({
      harnessRepo: '/tmp/harness',
      notifyPort: 43117,
      hotkey: 'CommandOrControl+Shift+D',
    })
  })

  it('keeps explicit overrides', () => {
    const file = writeConfig(
      JSON.stringify({ harnessRepo: '/tmp/h', notifyPort: 5000, hotkey: 'Alt+D' }),
    )
    const config = loadConfig(file)
    expect(config.notifyPort).toBe(5000)
    expect(config.hotkey).toBe('Alt+D')
  })

  it('throws a message naming the file when harnessRepo is missing', () => {
    const file = writeConfig(JSON.stringify({}))
    expect(() => loadConfig(file)).toThrow(/harnessRepo/)
    expect(() => loadConfig(file)).toThrow(file)
  })

  it('throws a message naming the file when the JSON is malformed', () => {
    const file = writeConfig('{ not json')
    expect(() => loadConfig(file)).toThrow(file)
  })
})
```

- [ ] **Step 3: Run it to make sure it fails**

Run: `npx vitest run src/main/config.spec.ts`
Expected: FAIL — cannot find module `./config`.

- [ ] **Step 4: Implement config loading**

`src/main/config.ts`:

```ts
import { readFileSync } from 'node:fs'

/** Resolved desktop settings. `pnpmPath` pins the pnpm binary when PATH cannot find it. */
export interface DesktopConfig {
  harnessRepo: string
  notifyPort: number
  hotkey: string
  pnpmPath?: string
}

const DEFAULT_NOTIFY_PORT = 43117
const DEFAULT_HOTKEY = 'CommandOrControl+Shift+D'

/**
 * Read and validate `config.json`.
 * @param filePath - absolute path to the config file.
 * @returns the resolved settings with defaults applied.
 */
export function loadConfig(filePath: string): DesktopConfig {
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf8')
  } catch (cause) {
    throw new Error(`dsh-desktop: cannot read ${filePath}`, { cause })
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (cause) {
    throw new Error(`dsh-desktop: ${filePath} is not valid JSON`, { cause })
  }

  const record = parsed as Partial<DesktopConfig>
  if (typeof record.harnessRepo !== 'string' || record.harnessRepo === '') {
    throw new Error(`dsh-desktop: ${filePath} must set "harnessRepo" to the harness checkout path`)
  }

  return {
    harnessRepo: record.harnessRepo,
    notifyPort: record.notifyPort ?? DEFAULT_NOTIFY_PORT,
    hotkey: record.hotkey ?? DEFAULT_HOTKEY,
    ...(record.pnpmPath === undefined ? {} : { pnpmPath: record.pnpmPath }),
  }
}
```

- [ ] **Step 5: Run the config test to verify it passes**

Run: `npx vitest run src/main/config.spec.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Write the failing preflight test**

`src/main/preflight.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { preflight } from './preflight'

describe('preflight', () => {
  it('fails and names the path when the repo is absent', () => {
    const result = preflight('/definitely/not/here')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('/definitely/not/here')
  })

  it('fails naming the build command when apps/web/dist is absent', () => {
    const repo = mkdtempSync(join(tmpdir(), 'dsh-desktop-repo-'))
    const result = preflight(repo)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('pnpm run build:web')
  })

  it('passes when the repo and the built frontend both exist', () => {
    const repo = mkdtempSync(join(tmpdir(), 'dsh-desktop-repo-'))
    mkdirSync(join(repo, 'apps', 'web', 'dist'), { recursive: true })
    expect(preflight(repo)).toEqual({ ok: true })
  })
})
```

- [ ] **Step 7: Run it to make sure it fails**

Run: `npx vitest run src/main/preflight.spec.ts`
Expected: FAIL — cannot find module `./preflight`.

- [ ] **Step 8: Implement preflight**

`src/main/preflight.ts`:

```ts
import { statSync } from 'node:fs'
import { join } from 'node:path'

/** Whether the harness checkout is usable, or why it is not. */
export type PreflightResult = { ok: true } | { ok: false; message: string }

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    // statSync throws ENOENT for a missing path; absence is the answer, not an error.
    return false
  }
}

/**
 * Check that the harness checkout exists and its frontend has been built.
 * A pulled-but-unbuilt checkout serves an empty page, so the missing
 * `apps/web/dist` is reported as a build instruction rather than a blank window.
 * @param harnessRepo - absolute path to the harness checkout.
 * @returns ok, or a message naming the exact remedy.
 */
export function preflight(harnessRepo: string): PreflightResult {
  if (!isDirectory(harnessRepo)) {
    return { ok: false, message: `Harness checkout not found at ${harnessRepo}. Fix "harnessRepo" in config.json.` }
  }
  if (!isDirectory(join(harnessRepo, 'apps', 'web', 'dist'))) {
    return {
      ok: false,
      message: `The harness frontend is not built. Run "pnpm run build:web" in ${harnessRepo}.`,
    }
  }
  return { ok: true }
}
```

- [ ] **Step 9: Run both test files to verify they pass**

Run: `npx vitest run`
Expected: PASS, 7 tests.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat: project scaffold, config loading, and preflight checks"
```

---

### Task 2: Spawn the harness server and discover its URL

**Files:**
- Create: `src/main/server.ts`
- Create: `tests/fixtures/fake-server.mjs`
- Test: `src/main/server.spec.ts`

**Interfaces:**
- Consumes: `DesktopConfig` from `src/main/config.ts`.
- Produces:
  - `interface ServerHandle { url: string; stop(): Promise<void> }`
  - `interface SpawnSpec { command: string; args: string[]; cwd: string }`
  - `function dshWebCommand(config: DesktopConfig, patchFile: string): SpawnSpec`
  - `function resolvePnpm(config: DesktopConfig, env: NodeJS.ProcessEnv): string`
  - `interface StartOptions { spec: SpawnSpec; timeoutMs: number; onExit?: (code: number | null, stderrTail: string) => void; onStdoutLine?: (line: string) => void }`
  - `function startServer(options: StartOptions): Promise<ServerHandle>`

**Note on PATH:** a packaged macOS app launched from Finder inherits only `/usr/bin:/bin:/usr/sbin:/sbin`, so `pnpm` is not on PATH. `resolvePnpm` handles this; do not assume a bare `pnpm` works.

- [ ] **Step 1: Create the fake server fixture**

`tests/fixtures/fake-server.mjs` — stands in for `dsh web` so the tests exercise real process behavior rather than a mock:

```js
// Test double for `dsh web`. Modes are driven by env vars:
//   FAKE_MODE=ready       print noise, then the ready line, then stay alive
//   FAKE_MODE=silent      print noise only, never become ready
//   FAKE_MODE=crash       print to stderr and exit non-zero
//   FAKE_MODE=grandchild  like ready, but also fork a child that outlives a naive kill
import { spawn } from 'node:child_process'

const mode = process.env.FAKE_MODE ?? 'ready'
const port = process.env.FAKE_PORT ?? '54321'

console.log('some unrelated startup noise')
console.log('dsh web: warming up')

if (mode === 'crash') {
  console.error('fake server: boom')
  process.exit(3)
}

if (mode === 'grandchild') {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  })
  console.log(`grandchild: ${child.pid}`)
}

if (mode !== 'silent') {
  console.log(`dsh web: http://127.0.0.1:${port} (LAN: http://192.168.1.5:${port})`)
}

setInterval(() => {}, 1000)
```

- [ ] **Step 2: Write the failing server tests**

`src/main/server.spec.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { dshWebCommand, resolvePnpm, startServer, type ServerHandle } from './server'

const FIXTURE = join(__dirname, '..', '..', 'tests', 'fixtures', 'fake-server.mjs')

function fakeSpec(mode: string, port = '54321') {
  return {
    command: process.execPath,
    args: [FIXTURE],
    cwd: process.cwd(),
    env: { ...process.env, FAKE_MODE: mode, FAKE_PORT: port },
  }
}

let running: ServerHandle | undefined

afterEach(async () => {
  await running?.stop()
  running = undefined
})

describe('dshWebCommand', () => {
  it('runs dsh web with the patch overlay and no browser handoff', () => {
    const spec = dshWebCommand(
      { harnessRepo: '/tmp/harness', notifyPort: 1, hotkey: 'x', pnpmPath: '/usr/local/bin/pnpm' },
      '/tmp/desktop.patch.yml',
    )
    expect(spec.command).toBe('/usr/local/bin/pnpm')
    expect(spec.args).toEqual(['dsh', 'web', '--no-open', '--patch', '/tmp/desktop.patch.yml'])
    expect(spec.cwd).toBe('/tmp/harness')
  })
})

describe('resolvePnpm', () => {
  it('prefers an explicit pnpmPath', () => {
    const config = { harnessRepo: '/tmp/h', notifyPort: 1, hotkey: 'x', pnpmPath: '/opt/pnpm' }
    expect(resolvePnpm(config, {})).toBe('/opt/pnpm')
  })

  it('falls back to a bare pnpm when PATH looks like a real login environment', () => {
    const config = { harnessRepo: '/tmp/h', notifyPort: 1, hotkey: 'x' }
    expect(resolvePnpm(config, { PATH: '/opt/homebrew/bin:/usr/bin:/bin' })).toBe('pnpm')
  })
})

describe('startServer', () => {
  it('resolves with the loopback URL from the ready line, ignoring the LAN suffix', async () => {
    running = await startServer({ spec: fakeSpec('ready', '61234'), timeoutMs: 10_000 })
    expect(running.url).toBe('http://127.0.0.1:61234')
  })

  it('ignores stdout noise that precedes the ready line', async () => {
    running = await startServer({ spec: fakeSpec('ready'), timeoutMs: 10_000 })
    expect(running.url).toBe('http://127.0.0.1:54321')
  })

  it('rejects when no ready line arrives before the timeout', async () => {
    await expect(startServer({ spec: fakeSpec('silent'), timeoutMs: 500 })).rejects.toThrow(
      /did not report a URL/,
    )
  })

  it('rejects with the stderr tail when the server exits early', async () => {
    await expect(startServer({ spec: fakeSpec('crash'), timeoutMs: 10_000 })).rejects.toThrow(
      /boom/,
    )
  })
})
```

- [ ] **Step 3: Run to make sure it fails**

Run: `npx vitest run src/main/server.spec.ts`
Expected: FAIL — cannot find module `./server`.

- [ ] **Step 4: Implement the server module**

`src/main/server.ts`:

```ts
import { spawn, type ChildProcess } from 'node:child_process'
import type { DesktopConfig } from './config'

/** A running harness server and the URL its window should load. */
export interface ServerHandle {
  url: string
  stop(): Promise<void>
}

/** Everything needed to launch the server child. */
export interface SpawnSpec {
  command: string
  args: string[]
  cwd: string
  env?: NodeJS.ProcessEnv
}

export interface StartOptions {
  spec: SpawnSpec
  timeoutMs: number
  /** Called only for an exit AFTER the server became ready. */
  onExit?: (code: number | null, stderrTail: string) => void
  /** Receives every stdout line, including lines before readiness. Used for logging and tests. */
  onStdoutLine?: (line: string) => void
}

/** The harness prints this once the webserver is listening. */
const READY_PATTERN = /^dsh web: (http:\/\/127\.0\.0\.1:\d+)/

/** How much stderr to keep for failure reporting. */
const STDERR_TAIL_LIMIT = 4000

/** Grace period between SIGTERM and SIGKILL on shutdown. */
const KILL_GRACE_MS = 3000

/**
 * Decide which pnpm binary to spawn.
 *
 * A packaged macOS app launched from Finder inherits a minimal PATH that has
 * no Homebrew or Corepack shim, so a bare `pnpm` fails with ENOENT. An
 * explicit `pnpmPath` always wins; otherwise a bare `pnpm` is used only when
 * PATH carries entries beyond the system defaults.
 * @param config - the desktop settings.
 * @param env - the environment the app was launched with.
 * @returns the command to spawn.
 */
export function resolvePnpm(config: DesktopConfig, env: NodeJS.ProcessEnv): string {
  if (config.pnpmPath !== undefined) return config.pnpmPath
  const path = env.PATH ?? ''
  const systemOnly = new Set(['/usr/bin', '/bin', '/usr/sbin', '/sbin', ''])
  const hasUserPath = path.split(':').some((entry) => !systemOnly.has(entry))
  if (hasUserPath) return 'pnpm'
  throw new Error(
    'dsh-desktop: pnpm is not on PATH (a Finder launch inherits a minimal PATH). ' +
      'Set "pnpmPath" in config.json to the absolute path from `which pnpm`.',
  )
}

/**
 * Build the spawn specification for `dsh web` against the configured checkout.
 * @param config - the desktop settings.
 * @param patchFile - absolute path to this project's cordis patch overlay.
 * @returns the command, arguments, and working directory.
 */
export function dshWebCommand(config: DesktopConfig, patchFile: string): SpawnSpec {
  return {
    command: resolvePnpm(config, process.env),
    args: ['dsh', 'web', '--no-open', '--patch', patchFile],
    cwd: config.harnessRepo,
  }
}

/**
 * Spawn the harness server and resolve once it reports its URL.
 *
 * The child is detached so it becomes its own process group leader: the
 * harness spawns node-pty grandchildren, and killing only the direct child
 * would orphan them.
 * @param options - spawn specification, readiness timeout, and exit callback.
 * @returns a handle carrying the URL and a group-wide stop.
 */
export function startServer(options: StartOptions): Promise<ServerHandle> {
  const { spec, timeoutMs, onExit } = options

  return new Promise<ServerHandle>((resolve, reject) => {
    const child: ChildProcess = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env ?? process.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let ready = false
    let stdoutBuffer = ''
    let stderrTail = ''
    const handle: ServerHandle = {
      url: '',
      stop: () => stopGroup(child),
    }

    const timer = setTimeout(() => {
      if (ready) return
      void stopGroup(child)
      reject(new Error(`dsh-desktop: the harness did not report a URL within ${timeoutMs}ms.\n${stderrTail}`))
    }, timeoutMs)

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf8')
      const lines = stdoutBuffer.split('\n')
      stdoutBuffer = lines.pop() ?? ''
      for (const line of lines) {
        options.onStdoutLine?.(line)
        const match = READY_PATTERN.exec(line.trim())
        if (match === null || ready) continue
        ready = true
        clearTimeout(timer)
        handle.url = match[1]
        resolve(handle)
      }
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_LIMIT)
    })

    child.on('error', (cause) => {
      clearTimeout(timer)
      if (!ready) reject(new Error(`dsh-desktop: failed to spawn ${spec.command}`, { cause }))
    })

    child.on('exit', (code) => {
      clearTimeout(timer)
      if (ready) {
        onExit?.(code, stderrTail)
        return
      }
      reject(new Error(`dsh-desktop: the harness exited with code ${String(code)} before starting.\n${stderrTail}`))
    })
  })
}

/**
 * Terminate the child's entire process group, escalating to SIGKILL.
 * @param child - the detached child process.
 */
function stopGroup(child: ChildProcess): Promise<void> {
  return new Promise<void>((resolve) => {
    const pid = child.pid
    if (pid === undefined || child.exitCode !== null || child.signalCode !== null) {
      resolve()
      return
    }

    const finish = (): void => {
      clearTimeout(escalation)
      resolve()
    }
    child.once('exit', finish)

    const escalation = setTimeout(() => {
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        // ESRCH: the group is already gone, which is the outcome we wanted.
      }
      resolve()
    }, KILL_GRACE_MS)

    try {
      process.kill(-pid, 'SIGTERM')
    } catch {
      // ESRCH: the group exited between the liveness check and this signal.
      finish()
    }
  })
}
```

- [ ] **Step 5: Run the server tests to verify they pass**

Run: `npx vitest run src/main/server.spec.ts`
Expected: PASS, 7 tests.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: spawn the harness server and discover its URL from the ready line"
```

---

### Task 3: Process-group teardown and crash reporting

**Files:**
- Modify: `src/main/server.spec.ts` (add teardown cases)

**Interfaces:**
- Consumes: `startServer`, `ServerHandle` from Task 2.
- Produces: no new exports. This task proves the Task 2 teardown is correct.

This task exists because orphaned `node-pty` grandchildren are the single most likely defect in this app, and a passing "the window opened" test would not catch them.

- [ ] **Step 1: Write the failing teardown tests**

Append to `src/main/server.spec.ts`:

```ts
/** Whether a pid is still alive. Signal 0 performs the existence check only. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    // ESRCH means no such process, which is exactly what the caller is asking about.
    return false
  }
}

describe('stop', () => {
  it('kills grandchildren, not just the direct child', async () => {
    let grandchildPid = 0

    const handle = await startServer({
      spec: fakeSpec('grandchild'),
      timeoutMs: 10_000,
      onStdoutLine: (line) => {
        const match = /^grandchild: (\d+)$/.exec(line.trim())
        if (match !== null) grandchildPid = Number(match[1])
      },
    })

    expect(grandchildPid).toBeGreaterThan(0)
    expect(isAlive(grandchildPid)).toBe(true)

    await handle.stop()
    await new Promise((r) => setTimeout(r, 1000))

    expect(isAlive(grandchildPid)).toBe(false)
  })

  it('is safe to call twice', async () => {
    const handle = await startServer({ spec: fakeSpec('ready'), timeoutMs: 10_000 })
    await handle.stop()
    await expect(handle.stop()).resolves.toBeUndefined()
  })

  it('reports an exit through onExit once the server was ready', async () => {
    const exits: Array<{ code: number | null; tail: string }> = []
    const handle = await startServer({
      spec: fakeSpec('ready'),
      timeoutMs: 10_000,
      onExit: (code, tail) => exits.push({ code, tail }),
    })
    await handle.stop()
    await new Promise((r) => setTimeout(r, 500))
    expect(exits.length).toBe(1)
  })
})
```

- [ ] **Step 2: Run to make sure the grandchild test fails for the right reason**

Temporarily change `stopGroup` in `src/main/server.ts` to `child.kill('SIGTERM')` instead of the process-group kill.

Run: `npx vitest run src/main/server.spec.ts -t grandchildren`
Expected: FAIL — the grandchild is still alive. This proves the test detects the orphan defect rather than passing vacuously.

- [ ] **Step 3: Restore the process-group kill and run the full file**

Revert `stopGroup` to the `process.kill(-pid, ...)` implementation from Task 2.

Run: `npx vitest run src/main/server.spec.ts`
Expected: PASS, 10 tests.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "test: prove process-group teardown reaps grandchildren"
```

---

### Task 4: Window, application menu, and main entry point

**Files:**
- Create: `src/main/window.ts`, `src/main/index.ts`, `src/main/status.ts`
- Create: `src/main/error-page.ts`

**Interfaces:**
- Consumes: `loadConfig`, `preflight`, `dshWebCommand`, `startServer`.
- Produces:
  - `type ServerStatus = 'starting' | 'running' | 'failed'`
  - `function createWindow(): BrowserWindow`
  - `function showError(window: BrowserWindow, title: string, detail: string): void`
  - `function installMenu(): void`

This is the first point the app is usable.

- [ ] **Step 1: Implement the status type**

`src/main/status.ts`:

```ts
/** What the tray and window panes report about the harness child. */
export type ServerStatus = 'starting' | 'running' | 'failed'
```

- [ ] **Step 2: Implement the error page**

`src/main/error-page.ts`:

```ts
/**
 * Render a self-contained failure page.
 * Chromium's own connection-refused page tells the user nothing actionable,
 * so every failure path loads this instead.
 * @param title - the short failure summary.
 * @param detail - the remedy or captured stderr.
 * @returns a data URL holding the rendered page.
 */
export function errorPage(title: string, detail: string): string {
  const escape = (value: string): string =>
    value.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] ?? c)

  const html = `<!doctype html>
<meta charset="utf-8">
<title>dsh-desktop</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.6 -apple-system, system-ui, sans-serif; margin: 0;
         display: grid; place-items: center; height: 100vh; padding: 2rem; }
  main { max-width: 46rem; }
  h1 { font-size: 1.25rem; margin: 0 0 .75rem; }
  pre { white-space: pre-wrap; word-break: break-word; padding: 1rem;
        background: rgba(127,127,127,.12); border-radius: .5rem; }
</style>
<main>
  <h1>${escape(title)}</h1>
  <pre>${escape(detail)}</pre>
</main>`
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}
```

- [ ] **Step 3: Implement the window and menu**

`src/main/window.ts`:

```ts
import { BrowserWindow, Menu, shell } from 'electron'
import { errorPage } from './error-page'

/**
 * Create the single application window.
 * The renderer loads the harness UI unmodified, so it runs with node
 * integration off and context isolation on.
 * @returns the created window.
 */
export function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    show: false,
    titleBarStyle: 'hiddenInset',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  })

  window.once('ready-to-show', () => window.show())

  // Anything targeting a new window is an external link; hand it to the browser.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  return window
}

/**
 * Replace the window contents with a failure pane.
 * @param window - the application window.
 * @param title - short failure summary.
 * @param detail - remedy text or captured stderr.
 */
export function showError(window: BrowserWindow, title: string, detail: string): void {
  void window.loadURL(errorPage(title, detail))
  if (!window.isVisible()) window.show()
}

/**
 * Install the application menu.
 * Electron ships no usable default for a custom app, and without an Edit menu
 * the standard clipboard shortcuts do not reach the renderer.
 */
export function installMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      {
        label: 'View',
        submenu: [
          { role: 'reload' },
          { role: 'forceReload' },
          { role: 'toggleDevTools' },
          { type: 'separator' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' },
        ],
      },
      { role: 'windowMenu' },
    ]),
  )
}
```

- [ ] **Step 4: Implement the main entry point**

`src/main/index.ts`:

```ts
import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { loadConfig, type DesktopConfig } from './config'
import { preflight } from './preflight'
import { dshWebCommand, startServer, type ServerHandle } from './server'
import { createWindow, installMenu, showError } from './window'
import type { ServerStatus } from './status'

/** Config and patch overlay sit beside the app, not inside the harness checkout. */
const PROJECT_ROOT = join(__dirname, '..', '..')
const CONFIG_PATH = join(PROJECT_ROOT, 'config.json')
const PATCH_PATH = join(PROJECT_ROOT, 'desktop.patch.yml')

/** How long the harness may take to report its URL. */
const READY_TIMEOUT_MS = 60_000

let window: BrowserWindow | undefined
let server: ServerHandle | undefined
let status: ServerStatus = 'starting'

async function boot(): Promise<void> {
  if (window === undefined) return

  let config: DesktopConfig
  try {
    config = loadConfig(CONFIG_PATH)
  } catch (error) {
    status = 'failed'
    showError(window, 'Configuration problem', (error as Error).message)
    return
  }

  const check = preflight(config.harnessRepo)
  if (!check.ok) {
    status = 'failed'
    showError(window, 'The harness checkout is not ready', check.message)
    return
  }

  try {
    server = await startServer({
      spec: dshWebCommand(config, PATCH_PATH),
      timeoutMs: READY_TIMEOUT_MS,
      onExit: (code, tail) => {
        status = 'failed'
        server = undefined
        if (window !== undefined) {
          showError(window, `The harness exited (code ${String(code)})`, tail || 'No output captured.')
        }
      },
    })
  } catch (error) {
    status = 'failed'
    showError(window, 'The harness failed to start', (error as Error).message)
    return
  }

  status = 'running'
  void window.loadURL(server.url)
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (window === undefined) return
    if (window.isMinimized()) window.restore()
    window.focus()
  })

  void app.whenReady().then(async () => {
    installMenu()
    window = createWindow()
    await boot()
  })

  app.on('window-all-closed', () => app.quit())

  app.on('before-quit', async (event) => {
    if (server === undefined) return
    event.preventDefault()
    const stopping = server
    server = undefined
    await stopping.stop()
    app.quit()
  })
}
```

- [ ] **Step 5: Build and launch the app for real**

Run: `npm run start`
Expected: a window opens showing the harness Web UI. If the frontend is not built, the error pane names `pnpm run build:web` instead.

- [ ] **Step 6: Verify the zero-touch constraint holds**

Run: `git -C /Users/arozumenko/Development/deepseek-harness status --porcelain`
Expected: empty output. Any output is a bug in this task — stop and fix it.

- [ ] **Step 7: Verify no orphans survive a quit**

Quit the app, then run: `pgrep -fl "dsh web" ; pgrep -fl node-pty`
Expected: no processes matching the harness server.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: application window, menu, and boot sequence"
```

---

### Task 5: Tray and global hotkey

**Files:**
- Create: `src/main/tray.ts`
- Create: `assets/tray-running.png`, `assets/tray-starting.png`, `assets/tray-failed.png`
- Modify: `src/main/index.ts`

**Interfaces:**
- Consumes: `ServerStatus` from `src/main/status.ts`.
- Produces:
  - `interface TrayController { setStatus(status: ServerStatus): void; destroy(): void }`
  - `function createTray(actions: TrayActions): TrayController`
  - `interface TrayActions { toggleWindow(): void; restart(): void; quit(): void }`

- [ ] **Step 1: Create the tray icons**

Generate three 32x32 template PNGs. macOS renders `Template`-suffixed images monochrome, so a single shape with an alpha channel is enough:

```bash
mkdir -p assets
python3 - <<'PY'
import struct, zlib, os

def png(path, rgba, size=32):
    rows = []
    for y in range(size):
        row = b'\x00'
        for x in range(size):
            row += bytes(rgba(x, y))
        rows.append(row)
    data = zlib.compress(b''.join(rows))
    def chunk(tag, payload):
        c = struct.pack('>I', len(payload)) + tag + payload
        return c + struct.pack('>I', zlib.crc32(tag + payload) & 0xffffffff)
    out = b'\x89PNG\r\n\x1a\n'
    out += chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0))
    out += chunk(b'IDAT', data)
    out += chunk(b'IEND', b'')
    open(path, 'wb').write(out)

def disc(cx, cy, r, on, off):
    def f(x, y):
        return on if (x - cx) ** 2 + (y - cy) ** 2 <= r * r else off
    return f

png('assets/tray-running.png',  disc(16, 16, 9, (0, 0, 0, 255), (0, 0, 0, 0)))
png('assets/tray-starting.png', disc(16, 16, 9, (0, 0, 0, 110), (0, 0, 0, 0)))
png('assets/tray-failed.png',   disc(16, 16, 9, (0, 0, 0, 255), (0, 0, 0, 0)))
PY
```

Note: `tray-running` and `tray-failed` share a shape; the tooltip and menu label carry the distinction. Replace with designed art later if you care.

- [ ] **Step 2: Implement the tray**

`src/main/tray.ts`:

```ts
import { Menu, Tray, nativeImage } from 'electron'
import { join } from 'node:path'
import type { ServerStatus } from './status'

/** What the tray menu can ask the app to do. */
export interface TrayActions {
  toggleWindow(): void
  restart(): void
  quit(): void
}

/** Live handle on the tray icon. */
export interface TrayController {
  setStatus(status: ServerStatus): void
  destroy(): void
}

const ASSETS = join(__dirname, '..', '..', 'assets')

const LABELS: Record<ServerStatus, string> = {
  starting: 'Harness: starting…',
  running: 'Harness: running',
  failed: 'Harness: failed',
}

const ICONS: Record<ServerStatus, string> = {
  starting: 'tray-starting.png',
  running: 'tray-running.png',
  failed: 'tray-failed.png',
}

/**
 * Create the menu-bar tray item.
 * @param actions - callbacks the menu items invoke.
 * @returns a controller for status updates and teardown.
 */
export function createTray(actions: TrayActions): TrayController {
  const tray = new Tray(icon('starting'))

  const render = (status: ServerStatus): void => {
    tray.setImage(icon(status))
    tray.setToolTip(LABELS[status])
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: LABELS[status], enabled: false },
        { type: 'separator' },
        { label: 'Show / Hide', click: () => actions.toggleWindow() },
        { label: 'Restart harness', click: () => actions.restart() },
        { type: 'separator' },
        { label: 'Quit', click: () => actions.quit() },
      ]),
    )
  }

  render('starting')

  return {
    setStatus: render,
    destroy: () => tray.destroy(),
  }
}

function icon(status: ServerStatus) {
  const image = nativeImage.createFromPath(join(ASSETS, ICONS[status]))
  image.setTemplateImage(true)
  return image
}
```

- [ ] **Step 3: Wire the tray and hotkey into the entry point**

In `src/main/index.ts`, add imports:

```ts
import { globalShortcut } from 'electron'
import { createTray, type TrayController } from './tray'
```

Add module state beside the others:

```ts
let tray: TrayController | undefined
```

Replace every bare `status = ...` assignment with a helper that keeps the tray in sync. Add this function above `boot`:

```ts
/**
 * Record the server status and mirror it into the tray.
 * @param next - the new status.
 */
function setStatus(next: ServerStatus): void {
  status = next
  tray?.setStatus(next)
}
```

Then change the four assignments in `boot` and the `onExit` callback from `status = 'failed'` / `status = 'running'` to `setStatus('failed')` / `setStatus('running')`.

Add a restart routine below `boot`:

```ts
/** Stop the current server (if any) and boot a fresh one. */
async function restart(): Promise<void> {
  const stopping = server
  server = undefined
  await stopping?.stop()
  setStatus('starting')
  await boot()
}

/** Show the window if hidden or unfocused, otherwise hide it. */
function toggleWindow(): void {
  if (window === undefined) return
  if (window.isVisible() && window.isFocused()) {
    window.hide()
    return
  }
  window.show()
  window.focus()
}
```

Extend the `whenReady` handler:

```ts
  void app.whenReady().then(async () => {
    installMenu()
    window = createWindow()
    tray = createTray({
      toggleWindow,
      restart: () => void restart(),
      quit: () => app.quit(),
    })
    const config = safeHotkey()
    if (config !== undefined) globalShortcut.register(config, toggleWindow)
    await boot()
  })
```

Add the hotkey reader, which must not take the app down when the config is unreadable — `boot` reports that failure with a proper pane:

```ts
/**
 * Read the configured hotkey, tolerating a broken config.
 * @returns the accelerator, or undefined when unavailable.
 */
function safeHotkey(): string | undefined {
  try {
    return loadConfig(CONFIG_PATH).hotkey
  } catch {
    // boot() reports config failures in the window; the hotkey just goes unbound.
    return undefined
  }
}
```

Add cleanup to the quit path — `will-quit` fires after `before-quit` completes:

```ts
app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  tray?.destroy()
})
```

- [ ] **Step 4: Verify by hand**

Run: `npm run start`
Expected: a tray icon appears; its menu shows "Harness: running"; the hotkey (default Cmd+Shift+D) hides and shows the window; "Restart harness" reloads the UI after a pause; "Quit" exits with no orphans (`pgrep -fl "dsh web"` empty).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: tray status menu and global show/hide hotkey"
```

---

### Task 6: Turn-completion notifications

**Files:**
- Create: `src/main/notify.ts`
- Create: `hooks.json`
- Modify: `desktop.patch.yml`, `src/main/index.ts`
- Test: `src/main/notify.spec.ts`

**Interfaces:**
- Consumes: `DesktopConfig`.
- Produces:
  - `interface NotifyServer { port: number; close(): Promise<void> }`
  - `function startNotifyListener(port: number, onTurnEnd: () => void): Promise<NotifyServer>`

The harness maps the Claude Code `Stop` hook onto its `agent/turn-stopping` interception point. The hook below is deliberately **non-blocking**: it exits 0 and writes nothing to stdout. A blocking `Stop` hook feeds its reason through `steer()` and forces another agent step, which would loop forever.

- [ ] **Step 1: Write the failing listener test**

`src/main/notify.spec.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest'
import { startNotifyListener, type NotifyServer } from './notify'

let server: NotifyServer | undefined

afterEach(async () => {
  await server?.close()
  server = undefined
})

describe('startNotifyListener', () => {
  it('invokes the callback when the hook posts', async () => {
    let fired = 0
    server = await startNotifyListener(0, () => { fired += 1 })
    const response = await fetch(`http://127.0.0.1:${server.port}/turn-end`, { method: 'POST' })
    expect(response.status).toBe(204)
    expect(fired).toBe(1)
  })

  it('ignores unrelated paths', async () => {
    let fired = 0
    server = await startNotifyListener(0, () => { fired += 1 })
    const response = await fetch(`http://127.0.0.1:${server.port}/nope`, { method: 'POST' })
    expect(response.status).toBe(404)
    expect(fired).toBe(0)
  })

  it('rejects when the port is already taken', async () => {
    server = await startNotifyListener(0, () => {})
    await expect(startNotifyListener(server.port, () => {})).rejects.toThrow(/in use/)
  })
})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run src/main/notify.spec.ts`
Expected: FAIL — cannot find module `./notify`.

- [ ] **Step 3: Implement the listener**

`src/main/notify.ts`:

```ts
import { createServer, type Server } from 'node:http'

/** The running notification endpoint. */
export interface NotifyServer {
  port: number
  close(): Promise<void>
}

/**
 * Listen on loopback for turn-end pings from the harness Stop hook.
 *
 * The port is fixed rather than OS-assigned because `hooks.json` is a static
 * file the harness reads at load: the hook command cannot discover a port
 * chosen at runtime.
 * @param port - the configured port; 0 is used by tests for an ephemeral port.
 * @param onTurnEnd - invoked once per POST to `/turn-end`.
 * @returns the listening server.
 */
export function startNotifyListener(port: number, onTurnEnd: () => void): Promise<NotifyServer> {
  return new Promise<NotifyServer>((resolve, reject) => {
    const server: Server = createServer((request, response) => {
      if (request.method === 'POST' && request.url === '/turn-end') {
        request.resume()
        response.writeHead(204).end()
        onTurnEnd()
        return
      }
      request.resume()
      response.writeHead(404).end()
    })

    server.once('error', (cause: NodeJS.ErrnoException) => {
      reject(
        cause.code === 'EADDRINUSE'
          ? new Error(`dsh-desktop: notification port ${String(port)} is already in use.`)
          : cause,
      )
    })

    server.listen(port, '127.0.0.1', () => {
      const address = server.address()
      resolve({
        port: typeof address === 'object' && address !== null ? address.port : port,
        close: () => new Promise<void>((done) => server.close(() => done())),
      })
    })
  })
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/main/notify.spec.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Create the hook config**

`hooks.json` — note the `|| true`, which guarantees exit 0 even when the app is not listening.

**The port appears in two files.** `config.json`'s `notifyPort` and the URL below are the same value, and nothing enforces that. The harness reads `hooks.json` directly, so this app cannot generate it without adding a build step for one integer. If you ever change `notifyPort`, change this URL in the same edit.

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "curl -s -m 2 -X POST http://127.0.0.1:43117/turn-end > /dev/null 2>&1 || true",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

- [ ] **Step 6: Point the harness at the hook config**

Replace `desktop.patch.yml` with:

```yaml
- dsh-host-webserver:
    port: 0
- dsh-hooks-claude-code:
    configPath: /Users/arozumenko/Development/dsh-desktop/hooks.json
```

`configPath` is process-level and resolved against the launch cwd at load, so it is given as an absolute path.

- [ ] **Step 7: Install the hook bridge into the web profile**

This writes to `~/.dsh`, never to the checkout:

```bash
cd /Users/arozumenko/Development/deepseek-harness
pnpm dsh plugin --profile web add @deepseek-ai/dsh-hooks-claude-code
git status --porcelain   # MUST be empty
```

- [ ] **Step 8: Wire notifications into the entry point**

In `src/main/index.ts` add imports:

```ts
import { Notification } from 'electron'
import { startNotifyListener, type NotifyServer } from './notify'
```

Add state:

```ts
let notifier: NotifyServer | undefined
```

Add the handler:

```ts
/** Raise a turn-complete notification, but only when the user is looking elsewhere. */
function onTurnEnd(): void {
  if (window?.isFocused() === true) return
  new Notification({ title: 'DeepSeek Harness', body: 'The agent finished its turn.' }).show()
}
```

In `whenReady`, after the tray is created, start the listener. A taken port degrades to "no notifications" rather than blocking launch:

```ts
    try {
      notifier = await startNotifyListener(loadConfig(CONFIG_PATH).notifyPort, onTurnEnd)
    } catch (error) {
      console.warn((error as Error).message)
    }
```

In the `will-quit` handler, add:

```ts
  void notifier?.close()
```

- [ ] **Step 9: Verify by hand**

Run `npm run start`, send the agent a prompt, switch to another app, and wait for the turn to finish.
Expected: a macOS notification appears. The agent must **not** take an extra step after finishing — if it loops, the hook is returning a blocking decision and must be fixed.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat: turn-completion notifications via a non-blocking Stop hook"
```

---

### Task 7: Deep-link registration and packaging

**Files:**
- Create: `build/entitlements.mac.plist`
- Create: `assets/icon.icns`
- Modify: `package.json`, `src/main/index.ts`
- Test: `tests/smoke.spec.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: a packaged `.app` under `release/`.

`dsh://` is **focus-only**. The harness web client has no URL routing, so there is no address for an individual session; do not attempt session navigation.

- [ ] **Step 1: Register the protocol**

In `src/main/index.ts`, inside the `else` branch before `whenReady`:

```ts
  app.setAsDefaultProtocolClient('dsh')

  // macOS delivers deep links through open-url, not argv.
  app.on('open-url', (event) => {
    event.preventDefault()
    if (window === undefined) return
    window.show()
    window.focus()
  })
```

Extend the existing `second-instance` handler to cover a link arriving while the app runs — it already focuses the window, so no change is needed beyond confirming it.

- [ ] **Step 2: Create the app icon**

```bash
mkdir -p build assets
python3 - <<'PY'
# Minimal 512x512 solid-rounded-square PNG; replace with real art whenever you like.
import struct, zlib
size = 512
def px(x, y):
    inset, r = 40, 96
    if x < inset or y < inset or x > size - inset or y > size - inset: return (0, 0, 0, 0)
    cx = min(max(x, inset + r), size - inset - r); cy = min(max(y, inset + r), size - inset - r)
    if (x - cx) ** 2 + (y - cy) ** 2 > r * r: return (0, 0, 0, 0)
    return (32, 96, 220, 255)
rows = [b'\x00' + b''.join(bytes(px(x, y)) for x in range(size)) for y in range(size)]
def chunk(tag, payload):
    return struct.pack('>I', len(payload)) + tag + payload + struct.pack('>I', zlib.crc32(tag + payload) & 0xffffffff)
open('assets/icon.png', 'wb').write(
    b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0))
    + chunk(b'IDAT', zlib.compress(b''.join(rows))) + chunk(b'IEND', b''))
PY
mkdir -p /tmp/dsh.iconset
for s in 16 32 128 256 512; do
  sips -z $s $s assets/icon.png --out /tmp/dsh.iconset/icon_${s}x${s}.png > /dev/null
  sips -z $((s*2)) $((s*2)) assets/icon.png --out /tmp/dsh.iconset/icon_${s}x${s}@2x.png > /dev/null
done
iconutil -c icns /tmp/dsh.iconset -o assets/icon.icns
```

- [ ] **Step 3: Add the entitlements file**

`build/entitlements.mac.plist` — the app spawns a child process, which a hardened runtime otherwise blocks:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
  <key>com.apple.security.cs.disable-library-validation</key><true/>
  <key>com.apple.security.cs.allow-dyld-environment-variables</key><true/>
</dict>
</plist>
```

- [ ] **Step 4: Configure electron-builder**

Add to `package.json`:

```json
  "build": {
    "appId": "dev.arozumenko.dsh-desktop",
    "productName": "DeepSeek Harness",
    "directories": { "output": "release", "buildResources": "build" },
    "files": ["dist/**/*", "assets/**/*", "config.json", "desktop.patch.yml", "hooks.json"],
    "extraMetadata": { "main": "dist/main/index.js" },
    "mac": {
      "category": "public.app-category.developer-tools",
      "icon": "assets/icon.icns",
      "target": ["dir"],
      "hardenedRuntime": true,
      "entitlements": "build/entitlements.mac.plist",
      "entitlementsInherit": "build/entitlements.mac.plist",
      "identity": null,
      "protocols": [{ "name": "dsh", "schemes": ["dsh"] }]
    }
  }
```

`identity: null` skips signing — correct for a personal build, and the reason the app stays on this machine.

- [ ] **Step 5: Package it**

Run: `npm run pack`
Expected: `release/mac-arm64/DeepSeek Harness.app` exists.

- [ ] **Step 6: Resolve the PATH problem for the packaged app**

A Finder launch has no `pnpm` on PATH. Capture the real path and pin it:

```bash
which pnpm
```

Add the result to `config.json` as `pnpmPath`, then repackage with `npm run pack`.

- [ ] **Step 7: Write the packaged smoke test**

`tests/smoke.spec.ts`:

```ts
import { expect, test, _electron as electron } from '@playwright/test'
import { execSync } from 'node:child_process'
import { join } from 'node:path'

const APP = join(__dirname, '..', 'release', 'mac-arm64', 'DeepSeek Harness.app',
  'Contents', 'MacOS', 'DeepSeek Harness')

test('launches, renders the harness UI, and leaves no orphans', async () => {
  const app = await electron.launch({ executablePath: APP })
  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded', { timeout: 90_000 })
  expect(window.url()).toMatch(/^http:\/\/127\.0\.0\.1:\d+/)

  await app.close()
  await new Promise((r) => setTimeout(r, 2000))

  const survivors = (() => {
    try {
      return execSync('pgrep -fl "dsh web" || true').toString().trim()
    } catch {
      // pgrep exits non-zero when nothing matches, which is the passing case.
      return ''
    }
  })()
  expect(survivors).toBe('')
})
```

Install the runner and add the script:

```bash
npm install -D @playwright/test
npm pkg set scripts.test:smoke="playwright test tests/smoke.spec.ts"
```

- [ ] **Step 8: Run the smoke test**

Run: `npm run test:smoke`
Expected: PASS.

- [ ] **Step 9: Verify the deep link and the zero-touch constraint**

```bash
cp -R "release/mac-arm64/DeepSeek Harness.app" /Applications/
open "dsh://anything"
git -C /Users/arozumenko/Development/deepseek-harness status --porcelain
```

Expected: the app launches or comes to the front; the `git status` output is empty.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat: dsh:// registration and macOS packaging"
```

---

## Verification checklist

Run before calling this done:

- [ ] `npx vitest run` — all unit tests pass
- [ ] `npm run test:smoke` — packaged smoke passes
- [ ] `git -C /Users/arozumenko/Development/deepseek-harness status --porcelain` — empty
- [ ] Quit the app, then `pgrep -fl "dsh web"` — empty
- [ ] Agent finishes a turn with the app unfocused — one notification, no extra agent step
