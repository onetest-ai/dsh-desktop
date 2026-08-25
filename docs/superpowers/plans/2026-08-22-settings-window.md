# Settings Window and First-Run Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the last machine-specific hardcode from `dsh-desktop` and add a Settings window — opened from the menu bar, and automatically on first run — so the app's configuration is chosen by the user rather than baked into the source.

**Architecture:** A second `BrowserWindow` with its own preload hosts a plain HTML form. All validation, file access, and application of changes live in the main process; the renderer is a dumb form talking over three narrow `invoke`/`handle` channels. The main window keeps no preload, so the harness Web UI it loads can never reach the IPC bridge.

**Tech Stack:** Electron 33, TypeScript (CommonJS output), Vitest with `vi.mock('electron')`, electron-builder, Playwright for the packaged smoke test.

**Spec:** `docs/superpowers/specs/2026-08-22-settings-window-design.md`

## Global Constraints

- **Zero-touch on the harness checkout at `~/Development/deepseek-harness`.** Nothing may create, modify, or delete any file there. `git -C ~/Development/deepseek-harness status --porcelain` must print nothing.
- **No machine-specific value may be hardcoded.** Ordinary defaults that config overrides are fine and stay: `notifyPort` 43117, hotkey `CommandOrControl+Shift+D`, npx package `@deepseek-ai/dsh`, version `latest`, `READY_TIMEOUT_MS` 60000, `KILL_GRACE_MS` 3000. A filesystem path that differs per machine is not.
- **The main window keeps `contextIsolation: true`, `nodeIntegration: false`, and NO preload.** Only the settings window gets a preload. This is a security boundary, not a preference: the main window loads the harness Web UI.
- The renderer never touches `fs`, never constructs a path it did not receive from main, and cannot write anything.
- Config lives at `$DSH_HOME/desktop.json`, `DSH_HOME` defaulting to `~/.dsh`.
- **`~/.dsh` is the user's real harness home.** Only `desktop.json` may be written. Never touch `~/.dsh/settings.yaml`, `sessions/`, `storages/`, or `profiles/`.
- These invariants each fixed a Critical bug and must not regress: the `enqueue` transition chain, `quitting` + `before-quit` reaping, the child generation token, `window === undefined || window.isDestroyed()` guards at every window call site, detached spawn + process-group kill, the `--` separator on npx argv only, ENOENT-only handling on config reads.
- Node 22+. TypeScript emits CommonJS; `__dirname` is available.
- **Process safety:** kill only processes started by this work, by a PID captured at spawn. Never use a broad `pkill`/`killall` — a user's live session was lost that way earlier in this project.

---

### Task 1: Config reports "not configured" instead of guessing

**Files:**
- Modify: `src/main/config.ts`
- Modify: `src/main/harness-source.ts` (delete `defaultSource`)
- Modify: `src/main/index.ts` (drop `CANDIDATE_REPO`, adapt the two `loadConfig` call sites)
- Test: `src/main/config.spec.ts`, `src/main/harness-source.spec.ts`

**Interfaces:**
- Consumes: `DesktopConfig`, `HarnessSource` from the existing modules.
- Produces:
  - `type ConfigResult = { configured: true; config: DesktopConfig } | { configured: false }`
  - `function loadConfig(filePath: string): ConfigResult`
  - `function writeConfig(filePath: string, config: DesktopConfig): void`
  - `const DEFAULT_NOTIFY_PORT: 43117`, `const DEFAULT_HOTKEY: 'CommandOrControl+Shift+D'` (exported for the form's defaults)

`defaultSource` is deleted rather than made configurable: with no machine to guess about, guessing is the bug it was written to enable.

- [ ] **Step 1: Write the failing config tests**

Replace the first-run seeding tests in `src/main/config.spec.ts` with these, keeping every existing validation test unchanged:

```ts
  it('reports not-configured when the file does not exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-desktop-config-'))
    const file = join(dir, 'desktop.json')
    expect(loadConfig(file)).toEqual({ configured: false })
  })

  it('does not create a file when reporting not-configured', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-desktop-config-'))
    const file = join(dir, 'desktop.json')
    loadConfig(file)
    expect(existsSync(file)).toBe(false)
  })

  it('still throws loudly on a read failure that is not ENOENT', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-desktop-config-'))
    const asDirectory = join(dir, 'desktop.json')
    mkdirSync(asDirectory)
    expect(() => loadConfig(asDirectory)).toThrow(/cannot read/)
    expect(statSync(asDirectory).isDirectory()).toBe(true)
  })

  it('returns the parsed config when the file exists', () => {
    const file = writeConfigFile(JSON.stringify({
      harness: { kind: 'local', repo: '/tmp/harness' },
    }))
    expect(loadConfig(file)).toEqual({
      configured: true,
      config: {
        harness: { kind: 'local', repo: '/tmp/harness' },
        notifyPort: 43117,
        hotkey: 'CommandOrControl+Shift+D',
      },
    })
  })

  it('writeConfig round-trips through loadConfig', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-desktop-config-'))
    const file = join(dir, 'nested', 'desktop.json')
    const config = {
      harness: { kind: 'npx' as const, package: '@deepseek-ai/dsh', version: 'latest', workspace: '/tmp/ws' },
      notifyPort: 5000,
      hotkey: 'Alt+D',
    }
    writeConfig(file, config)
    expect(loadConfig(file)).toEqual({ configured: true, config })
  })
```

Add `existsSync`, `mkdirSync`, `statSync` to the `node:fs` import at the top of the file, and rename the existing local helper that writes a config file to `writeConfigFile` if it is not already named that.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/main/config.spec.ts`
Expected: FAIL — `loadConfig` still takes two arguments and seeds a file; `writeConfig` is not exported.

- [ ] **Step 3: Rewrite the read path**

In `src/main/config.ts`, delete the `defaultSource` import and the `mkdirSync`/`dirname` imports if they become unused, then replace the signature and the ENOENT branch:

```ts
/** Either the stored settings, or the first-run state where none exist yet. */
export type ConfigResult =
  | { configured: true; config: DesktopConfig }
  | { configured: false }

/**
 * Read the desktop config.
 *
 * A missing file is the first-run state, reported rather than guessed at:
 * the app has no way to know where a harness checkout lives on this machine,
 * so the user is asked instead (see the settings window).
 * @param filePath - absolute path to `desktop.json`.
 * @returns the stored settings, or the not-configured state.
 */
export function loadConfig(filePath: string): ConfigResult {
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf8')
  } catch (error) {
    // Only ENOENT means "nothing stored yet". Anything else — EACCES, or
    // EISDIR from a directory sitting where the file should be — means a real
    // config may exist and merely be unreadable, so it is rethrown loud rather
    // than being mistaken for a first run.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`dsh-desktop: cannot read ${filePath}`, { cause: error })
    }
    return { configured: false }
  }
  return { configured: true, config: parseConfig(filePath, raw) }
}
```

Move the existing JSON parsing and validation body verbatim into a new private `parseConfig(filePath: string, raw: string): DesktopConfig` — the validation rules do not change.

Export the two default constants and add the writer:

```ts
export const DEFAULT_NOTIFY_PORT = 43117
export const DEFAULT_HOTKEY = 'CommandOrControl+Shift+D'

/**
 * Persist the desktop config, creating its directory if needed.
 * @param filePath - absolute path to `desktop.json`.
 * @param config - settings to store.
 */
export function writeConfig(filePath: string, config: DesktopConfig): void {
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, `${JSON.stringify(config, undefined, 2)}\n`)
}
```

- [ ] **Step 4: Delete `defaultSource`**

Remove the `defaultSource` function from `src/main/harness-source.ts`, along with the now-unused `statSync` and `homedir` imports if nothing else uses them, and the `DEFAULT_PACKAGE` constant if it is only referenced there. Delete its `describe('defaultSource', ...)` block from `src/main/harness-source.spec.ts`.

- [ ] **Step 5: Drop the hardcode from the entry point**

In `src/main/index.ts`, delete the `CANDIDATE_REPO` constant entirely. Update both `loadConfig` call sites to the one-argument form. Where a call site needs the config object, read `result.configured ? result.config : undefined` — Task 5 gives the not-configured case its real behavior, so for now treat it the same as a config that fails to load.

- [ ] **Step 6: Verify no machine-specific path remains**

Run: `grep -rn "/Users/" src/ tests/`
Expected: no matches. A match in `src/` or `tests/` is a failure of this task.

- [ ] **Step 7: Run the whole suite**

Run: `npm run build && npx vitest run`
Expected: build clean, all tests pass. Report the count.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: report first run instead of guessing a harness checkout"
```

---

### Task 2: Settings validation, as a pure module

**Files:**
- Create: `src/main/settings-validate.ts`
- Test: `src/main/settings-validate.spec.ts`

**Interfaces:**
- Consumes: `DesktopConfig`, `HarnessSource`, `DEFAULT_NOTIFY_PORT`, `DEFAULT_HOTKEY` from Task 1.
- Produces:
  - `interface SettingsForm { kind: 'local' | 'npx'; repo: string; package: string; version: string; workspace: string; notifyPort: string; hotkey: string; pnpmPath: string; npxPath: string }`
  - `type FieldErrors = Partial<Record<keyof SettingsForm, string>>`
  - `type ValidationResult = { ok: true; config: DesktopConfig } | { ok: false; errors: FieldErrors }`
  - `function validateSettings(form: SettingsForm): ValidationResult`
  - `function formFor(config: ConfigResult): SettingsForm`

Every form field is a string because that is what an HTML form yields; conversion and validation happen here, in one place, with no Electron and no filesystem writes.

- [ ] **Step 1: Write the failing tests**

`src/main/settings-validate.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { formFor, validateSettings, type SettingsForm } from './settings-validate'

function form(overrides: Partial<SettingsForm> = {}): SettingsForm {
  return {
    kind: 'local',
    repo: mkdtempSync(join(tmpdir(), 'dsh-repo-')),
    package: '@deepseek-ai/dsh',
    version: 'latest',
    workspace: mkdtempSync(join(tmpdir(), 'dsh-ws-')),
    notifyPort: '43117',
    hotkey: 'CommandOrControl+Shift+D',
    pnpmPath: '',
    npxPath: '',
    ...overrides,
  }
}

describe('validateSettings — local source', () => {
  it('accepts a directory that exists', () => {
    const input = form()
    const result = validateSettings(input)
    expect(result).toEqual({
      ok: true,
      config: {
        harness: { kind: 'local', repo: input.repo },
        notifyPort: 43117,
        hotkey: 'CommandOrControl+Shift+D',
      },
    })
  })

  it('rejects an empty repo', () => {
    const result = validateSettings(form({ repo: '' }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.repo).toMatch(/required/i)
  })

  it('rejects a repo that does not exist', () => {
    const result = validateSettings(form({ repo: '/definitely/not/here' }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.repo).toMatch(/not a folder|does not exist/i)
  })

  it('rejects a repo that is a file rather than a directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-file-'))
    const file = join(dir, 'a-file')
    writeFileSync(file, 'x')
    const result = validateSettings(form({ repo: file }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.repo).toMatch(/not a folder/i)
  })

  it('ignores npx fields when the source is local', () => {
    const result = validateSettings(form({ package: '', version: '', workspace: '' }))
    expect(result.ok).toBe(true)
  })
})

describe('validateSettings — npx source', () => {
  it('accepts a package and workspace', () => {
    const input = form({ kind: 'npx' })
    const result = validateSettings(input)
    expect(result).toEqual({
      ok: true,
      config: {
        harness: { kind: 'npx', package: '@deepseek-ai/dsh', version: 'latest', workspace: input.workspace },
        notifyPort: 43117,
        hotkey: 'CommandOrControl+Shift+D',
      },
    })
  })

  it('rejects an empty package', () => {
    const result = validateSettings(form({ kind: 'npx', package: '  ' }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.package).toMatch(/required/i)
  })

  it('defaults an empty version to latest', () => {
    const result = validateSettings(form({ kind: 'npx', version: '' }))
    expect(result.ok).toBe(true)
    if (result.ok && result.config.harness.kind === 'npx') {
      expect(result.config.harness.version).toBe('latest')
    }
  })

  it('rejects a workspace that does not exist', () => {
    const result = validateSettings(form({ kind: 'npx', workspace: '/definitely/not/here' }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.workspace).toMatch(/not a folder|does not exist/i)
  })

  it('ignores the repo field when the source is npx', () => {
    const result = validateSettings(form({ kind: 'npx', repo: '/definitely/not/here' }))
    expect(result.ok).toBe(true)
  })
})

describe('validateSettings — port and hotkey', () => {
  it.each(['0', '65536', '-1', 'abc', '', '80.5'])('rejects the port %s', (notifyPort) => {
    const result = validateSettings(form({ notifyPort }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.notifyPort).toBeDefined()
  })

  it('accepts a port at each end of the range', () => {
    expect(validateSettings(form({ notifyPort: '1' })).ok).toBe(true)
    expect(validateSettings(form({ notifyPort: '65535' })).ok).toBe(true)
  })

  it('rejects an empty hotkey', () => {
    const result = validateSettings(form({ hotkey: '   ' }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.hotkey).toMatch(/required/i)
  })

  it('reports every bad field at once rather than stopping at the first', () => {
    const result = validateSettings(form({ repo: '', notifyPort: 'abc', hotkey: '' }))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(Object.keys(result.errors).sort()).toEqual(['hotkey', 'notifyPort', 'repo'])
    }
  })

  it('omits blank binary paths rather than storing empty strings', () => {
    const result = validateSettings(form({ pnpmPath: '  ', npxPath: '' }))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect('pnpmPath' in result.config).toBe(false)
      expect('npxPath' in result.config).toBe(false)
    }
  })

  it('keeps binary paths that were provided', () => {
    const result = validateSettings(form({ pnpmPath: '/opt/pnpm' }))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.config.pnpmPath).toBe('/opt/pnpm')
  })
})

describe('formFor', () => {
  it('fills defaults for a first run', () => {
    const filled = formFor({ configured: false })
    expect(filled.kind).toBe('local')
    expect(filled.repo).toBe('')
    expect(filled.notifyPort).toBe('43117')
    expect(filled.hotkey).toBe('CommandOrControl+Shift+D')
    expect(filled.package).toBe('@deepseek-ai/dsh')
    expect(filled.version).toBe('latest')
  })

  it('round-trips a stored local config', () => {
    const config = {
      harness: { kind: 'local' as const, repo: '/tmp/harness' },
      notifyPort: 5000,
      hotkey: 'Alt+D',
    }
    const filled = formFor({ configured: true, config })
    expect(filled.repo).toBe('/tmp/harness')
    expect(filled.notifyPort).toBe('5000')
    expect(filled.hotkey).toBe('Alt+D')
  })

  it('round-trips a stored npx config', () => {
    const config = {
      harness: { kind: 'npx' as const, package: '@acme/dsh', version: '1.2.3', workspace: '/tmp/ws' },
      notifyPort: 43117,
      hotkey: 'Alt+D',
    }
    const filled = formFor({ configured: true, config })
    expect(filled.kind).toBe('npx')
    expect(filled.package).toBe('@acme/dsh')
    expect(filled.version).toBe('1.2.3')
    expect(filled.workspace).toBe('/tmp/ws')
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/main/settings-validate.spec.ts`
Expected: FAIL — cannot find module `./settings-validate`.

- [ ] **Step 3: Implement the module**

`src/main/settings-validate.ts`:

```ts
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { DEFAULT_HOTKEY, DEFAULT_NOTIFY_PORT, type ConfigResult, type DesktopConfig } from './config'
import type { HarnessSource } from './harness-source'

/** The settings form's raw values. Every field is a string because HTML forms yield strings. */
export interface SettingsForm {
  kind: 'local' | 'npx'
  repo: string
  package: string
  version: string
  workspace: string
  notifyPort: string
  hotkey: string
  pnpmPath: string
  npxPath: string
}

/** Per-field messages for a rejected form; absent keys validated cleanly. */
export type FieldErrors = Partial<Record<keyof SettingsForm, string>>

/** A validated config, or the reasons the form was rejected. */
export type ValidationResult =
  | { ok: true; config: DesktopConfig }
  | { ok: false; errors: FieldErrors }

/** Default published package used when the form leaves it blank on a first run. */
const DEFAULT_PACKAGE = '@deepseek-ai/dsh'
/** Default dist-tag when no version is given. */
const DEFAULT_VERSION = 'latest'

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    // Any failure to stat — absent, unreadable, or a broken link — means this
    // is not a usable folder, which is the only distinction the form needs.
    return false
  }
}

/**
 * Validate a submitted form and convert it into stored settings.
 *
 * Every field is checked, so the form can show all its problems at once
 * rather than one per submission.
 * @param form - the raw form values.
 * @returns the resulting config, or per-field errors.
 */
export function validateSettings(form: SettingsForm): ValidationResult {
  const errors: FieldErrors = {}

  let harness: HarnessSource | undefined
  if (form.kind === 'local') {
    const repo = form.repo.trim()
    if (repo === '') {
      errors.repo = 'A harness checkout folder is required.'
    } else if (!isDirectory(repo)) {
      errors.repo = 'That path is not a folder on this machine.'
    } else {
      harness = { kind: 'local', repo }
    }
  } else {
    const pkg = form.package.trim()
    const workspace = form.workspace.trim()
    if (pkg === '') errors.package = 'A package name is required.'
    if (workspace !== '' && !isDirectory(workspace)) {
      errors.workspace = 'That path is not a folder on this machine.'
    }
    if (errors.package === undefined && errors.workspace === undefined) {
      harness = {
        kind: 'npx',
        package: pkg,
        version: form.version.trim() === '' ? DEFAULT_VERSION : form.version.trim(),
        workspace: workspace === '' ? homedir() : workspace,
      }
    }
  }

  const notifyPort = Number(form.notifyPort.trim())
  if (!Number.isInteger(notifyPort) || notifyPort < 1 || notifyPort > 65535) {
    errors.notifyPort = 'Enter a port between 1 and 65535.'
  }

  const hotkey = form.hotkey.trim()
  if (hotkey === '') errors.hotkey = 'A shortcut is required.'

  if (harness === undefined || Object.keys(errors).length > 0) {
    return { ok: false, errors }
  }

  const pnpmPath = form.pnpmPath.trim()
  const npxPath = form.npxPath.trim()
  return {
    ok: true,
    config: {
      harness,
      notifyPort,
      hotkey,
      ...(pnpmPath === '' ? {} : { pnpmPath }),
      ...(npxPath === '' ? {} : { npxPath }),
    },
  }
}

/**
 * Fill the form from stored settings, or with defaults on a first run.
 * @param result - what `loadConfig` returned.
 * @returns form values ready to render.
 */
export function formFor(result: ConfigResult): SettingsForm {
  const base: SettingsForm = {
    kind: 'local',
    repo: '',
    package: DEFAULT_PACKAGE,
    version: DEFAULT_VERSION,
    workspace: '',
    notifyPort: String(DEFAULT_NOTIFY_PORT),
    hotkey: DEFAULT_HOTKEY,
    pnpmPath: '',
    npxPath: '',
  }
  if (!result.configured) return base

  const { harness, notifyPort, hotkey, pnpmPath, npxPath } = result.config
  return {
    ...base,
    kind: harness.kind,
    ...(harness.kind === 'local'
      ? { repo: harness.repo }
      : { package: harness.package, version: harness.version, workspace: harness.workspace }),
    notifyPort: String(notifyPort),
    hotkey,
    pnpmPath: pnpmPath ?? '',
    npxPath: npxPath ?? '',
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/main/settings-validate.spec.ts`
Expected: PASS, 24 tests.

- [ ] **Step 5: Commit**

```bash
git add src/main/settings-validate.ts src/main/settings-validate.spec.ts
git commit -m "feat: settings form validation as a pure module"
```

---

### Task 3: The three IPC handlers, as injectable functions

**Files:**
- Create: `src/main/settings-ipc.ts`
- Test: `src/main/settings-ipc.spec.ts`

**Interfaces:**
- Consumes: `ConfigResult`, `DesktopConfig`, `writeConfig` (Task 1); `SettingsForm`, `FieldErrors`, `validateSettings` (Task 2).
- Produces:
  - `interface SettingsDeps { readConfig(): ConfigResult; writeConfig(config: DesktopConfig): void; pickFolder(): Promise<string | undefined>; probePort(port: number): Promise<boolean>; apply(previous: DesktopConfig | undefined, next: DesktopConfig): Promise<void>; isQuitting(): boolean }`
  - `type SaveResult = { ok: true } | { ok: false; errors: FieldErrors }`
  - `interface SettingsHandlers { read(): { configured: boolean; form: SettingsForm }; pickFolder(): Promise<string | undefined>; save(form: SettingsForm): Promise<SaveResult> }`
  - `function createSettingsHandlers(deps: SettingsDeps): SettingsHandlers`

Dependencies are injected so every handler is testable without Electron, without a real window, and without touching `~/.dsh`.

- [ ] **Step 1: Write the failing tests**

`src/main/settings-ipc.spec.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSettingsHandlers, type SettingsDeps } from './settings-ipc'
import type { SettingsForm } from './settings-validate'
import type { DesktopConfig } from './config'

const REPO = mkdtempSync(join(tmpdir(), 'dsh-repo-'))

function form(overrides: Partial<SettingsForm> = {}): SettingsForm {
  return {
    kind: 'local', repo: REPO, package: '@deepseek-ai/dsh', version: 'latest',
    workspace: '', notifyPort: '43117', hotkey: 'CommandOrControl+Shift+D',
    pnpmPath: '', npxPath: '', ...overrides,
  }
}

const STORED: DesktopConfig = {
  harness: { kind: 'local', repo: REPO },
  notifyPort: 43117,
  hotkey: 'CommandOrControl+Shift+D',
}

function deps(overrides: Partial<SettingsDeps> = {}): SettingsDeps {
  return {
    readConfig: () => ({ configured: true, config: STORED }),
    writeConfig: vi.fn(),
    pickFolder: vi.fn(async () => '/picked'),
    probePort: vi.fn(async () => true),
    apply: vi.fn(async () => []),
    isQuitting: () => false,
    ...overrides,
  }
}

describe('read', () => {
  it('returns the stored values as form fields', () => {
    expect(createSettingsHandlers(deps()).read()).toEqual({
      configured: true,
      form: expect.objectContaining({ kind: 'local', repo: REPO, notifyPort: '43117' }),
    })
  })

  it('returns defaults on a first run', () => {
    const handlers = createSettingsHandlers(deps({ readConfig: () => ({ configured: false }) }))
    expect(handlers.read()).toEqual({
      configured: false,
      form: expect.objectContaining({ repo: '', notifyPort: '43117' }),
    })
  })
})

describe('pickFolder', () => {
  it('returns the chosen path', async () => {
    await expect(createSettingsHandlers(deps()).pickFolder()).resolves.toBe('/picked')
  })

  it('returns undefined when cancelled', async () => {
    const handlers = createSettingsHandlers(deps({ pickFolder: async () => undefined }))
    await expect(handlers.pickFolder()).resolves.toBeUndefined()
  })
})

describe('save', () => {
  it('writes and applies a valid form', async () => {
    const d = deps()
    const result = await createSettingsHandlers(d).save(form())
    expect(result).toEqual({ ok: true, warnings: [] })
    expect(d.writeConfig).toHaveBeenCalledWith({
      harness: { kind: 'local', repo: REPO },
      notifyPort: 43117,
      hotkey: 'CommandOrControl+Shift+D',
    })
    expect(d.apply).toHaveBeenCalledWith(STORED, expect.objectContaining({ notifyPort: 43117 }))
  })

  it('returns field errors and writes nothing when invalid', async () => {
    const d = deps()
    const result = await createSettingsHandlers(d).save(form({ repo: '' }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.repo).toBeDefined()
    expect(d.writeConfig).not.toHaveBeenCalled()
    expect(d.apply).not.toHaveBeenCalled()
  })

  it('rejects a port that is already bound, naming it', async () => {
    const d = deps({ probePort: async () => false })
    const result = await createSettingsHandlers(d).save(form({ notifyPort: '5000' }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.notifyPort).toContain('5000')
    expect(d.writeConfig).not.toHaveBeenCalled()
  })

  it('does not probe a port that is unchanged', async () => {
    const d = deps()
    await createSettingsHandlers(d).save(form())
    expect(d.probePort).not.toHaveBeenCalled()
  })

  it('probes only when the port actually changes', async () => {
    const d = deps()
    await createSettingsHandlers(d).save(form({ notifyPort: '5000' }))
    expect(d.probePort).toHaveBeenCalledWith(5000)
  })

  it('refuses to save while the app is quitting', async () => {
    const d = deps({ isQuitting: () => true })
    const result = await createSettingsHandlers(d).save(form())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.kind).toMatch(/quitting|shutting down/i)
    expect(d.writeConfig).not.toHaveBeenCalled()
    expect(d.apply).not.toHaveBeenCalled()
  })

  it('passes undefined as previous on a first run', async () => {
    const d = deps({ readConfig: () => ({ configured: false }) })
    await createSettingsHandlers(d).save(form())
    expect(d.apply).toHaveBeenCalledWith(undefined, expect.anything())
  })

  it('does not apply when writing fails', async () => {
    const d = deps({ writeConfig: vi.fn(() => { throw new Error('disk full') }) })
    await expect(createSettingsHandlers(d).save(form())).rejects.toThrow(/disk full/)
    expect(d.apply).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/main/settings-ipc.spec.ts`
Expected: FAIL — cannot find module `./settings-ipc`.

- [ ] **Step 3: Implement the handlers**

`src/main/settings-ipc.ts`:

```ts
import type { ConfigResult, DesktopConfig } from './config'
import { formFor, validateSettings, type FieldErrors, type SettingsForm } from './settings-validate'

/** Everything the handlers need from the surrounding app, injected for testability. */
export interface SettingsDeps {
  readConfig(): ConfigResult
  writeConfig(config: DesktopConfig): void
  pickFolder(): Promise<string | undefined>
  /** Whether `port` can currently be bound on loopback. */
  probePort(port: number): Promise<boolean>
  /** Applies the change to the running app; returns non-blocking warnings to show. */
  apply(previous: DesktopConfig | undefined, next: DesktopConfig): Promise<string[]>
  isQuitting(): boolean
}

/** Outcome of a save attempt. `warnings` carries non-blocking problems, such as a rejected hotkey. */
export type SaveResult = { ok: true; warnings: string[] } | { ok: false; errors: FieldErrors }

/** The three operations the settings renderer can invoke. */
export interface SettingsHandlers {
  read(): { configured: boolean; form: SettingsForm }
  pickFolder(): Promise<string | undefined>
  save(form: SettingsForm): Promise<SaveResult>
}

/**
 * Build the settings handlers over injected dependencies.
 *
 * Validation runs before anything is written, so a rejected save never leaves
 * a partial config on disk, and `apply` runs only after a successful write.
 * @param deps - collaborators supplied by the main process.
 * @returns the handler set the IPC channels delegate to.
 */
export function createSettingsHandlers(deps: SettingsDeps): SettingsHandlers {
  return {
    read: () => {
      const stored = deps.readConfig()
      return { configured: stored.configured, form: formFor(stored) }
    },
    pickFolder: () => deps.pickFolder(),
    async save(form: SettingsForm): Promise<SaveResult> {
      if (deps.isQuitting()) {
        return { ok: false, errors: { kind: 'The app is shutting down; settings were not saved.' } }
      }

      const validated = validateSettings(form)
      if (!validated.ok) return validated

      const stored = deps.readConfig()
      const previous = stored.configured ? stored.config : undefined

      if (previous?.notifyPort !== validated.config.notifyPort) {
        if (!(await deps.probePort(validated.config.notifyPort))) {
          return {
            ok: false,
            errors: { notifyPort: `Port ${String(validated.config.notifyPort)} is already in use.` },
          }
        }
      }

      deps.writeConfig(validated.config)
      const warnings = await deps.apply(previous, validated.config)
      return { ok: true, warnings }
    },
  }
}
```

Delete the `_unusedMarker` import line — it is shown only to make the import block's origin explicit; the module imports types only.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/main/settings-ipc.spec.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add src/main/settings-ipc.ts src/main/settings-ipc.spec.ts
git commit -m "feat: settings IPC handlers over injected dependencies"
```

---

### Task 4: The settings window, preload, and renderer

**Files:**
- Create: `src/main/settings-window.ts`
- Create: `src/preload/settings.ts`
- Create: `src/renderer/settings.html`, `src/renderer/settings.css`, `src/renderer/settings.js`
- Modify: `package.json` (build script copies renderer assets; `files` includes them), `tsconfig.json` (emit `src/preload`)

**Interfaces:**
- Consumes: `SettingsHandlers` (Task 3).
- Produces:
  - `function openSettings(handlers: SettingsHandlers, onClosed: () => void): void`
  - Preload API on `window.settings`: `{ read(): Promise<ConfigResult>; pickFolder(): Promise<string | undefined>; save(form: SettingsForm): Promise<SaveResult> }`

- [ ] **Step 1: Make the build emit the preload and renderer**

`tsconfig.json` already has `"rootDir": "src"` and `"include": ["src/**/*.ts"]`, so `src/preload/settings.ts` compiles to `dist/preload/settings.js` with no change. Confirm that by reading the file; if `include` is narrower, widen it to `src/**/*.ts`.

The renderer's `.html`/`.css`/`.js` are not TypeScript and `tsc` will not copy them. Change the build script in `package.json`:

```json
    "build": "tsc -p tsconfig.json && npm run build:renderer",
    "build:renderer": "mkdir -p dist/renderer && cp src/renderer/settings.html src/renderer/settings.css src/renderer/settings.js dist/renderer/",
```

`src/renderer/settings.js` is plain JavaScript, not TypeScript, so `tsc` ignores it — that is deliberate, since it is a dumb form with no logic worth type-checking or testing.

- [ ] **Step 2: Write the preload**

`src/preload/settings.ts`:

```ts
import { contextBridge, ipcRenderer } from 'electron'

/**
 * The settings renderer's entire capability surface.
 *
 * Exactly three operations reach the main process. The renderer has no `fs`,
 * no path construction, and no way to write anything: every value it can
 * persist goes through `save`, which validates in main.
 */
contextBridge.exposeInMainWorld('settings', {
  read: () => ipcRenderer.invoke('settings:read'),
  pickFolder: () => ipcRenderer.invoke('settings:pick-folder'),
  save: (form: unknown) => ipcRenderer.invoke('settings:save', form),
})
```

- [ ] **Step 3: Write the window module**

`src/main/settings-window.ts`:

```ts
import { BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import type { SettingsHandlers } from './settings-ipc'
import type { SettingsForm } from './settings-validate'

let settingsWindow: BrowserWindow | undefined
let channelsRegistered = false

function isOpen(): boolean {
  return settingsWindow !== undefined && !settingsWindow.isDestroyed()
}

/**
 * Open the settings window, or focus it if it is already open.
 *
 * The preload lives only on this window: the main window loads the harness
 * Web UI, which must never reach an IPC bridge.
 * @param handlers - the operations the renderer may invoke.
 * @param onClosed - called when the window closes, however it closes.
 */
export function openSettings(handlers: SettingsHandlers, onClosed: () => void): void {
  if (isOpen()) {
    settingsWindow?.focus()
    return
  }

  if (!channelsRegistered) {
    ipcMain.handle('settings:read', () => handlers.read())
    ipcMain.handle('settings:pick-folder', () => handlers.pickFolder())
    ipcMain.handle('settings:save', (_event, form: SettingsForm) => handlers.save(form))
    channelsRegistered = true
  }

  settingsWindow = new BrowserWindow({
    width: 620,
    height: 640,
    title: 'DeepSeek Harness Settings',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(__dirname, '..', 'preload', 'settings.js'),
    },
  })

  void settingsWindow.loadFile(join(__dirname, '..', 'renderer', 'settings.html'))

  settingsWindow.on('closed', () => {
    settingsWindow = undefined
    onClosed()
  })
}
```

Channels are registered once and left registered: `ipcMain.handle` throws on a duplicate registration, and re-registering per open would need matching removals for no benefit.

- [ ] **Step 4: Write the form**

`src/renderer/settings.html`:

```html
<!doctype html>
<meta charset="utf-8">
<title>Settings</title>
<link rel="stylesheet" href="settings.css">
<main>
  <h1>DeepSeek Harness</h1>
  <p id="intro" class="hint"></p>

  <fieldset>
    <legend>Where the harness runs from</legend>
    <label><input type="radio" name="kind" value="local" checked> A local checkout</label>
    <label><input type="radio" name="kind" value="npx"> The published package (npx)</label>
  </fieldset>

  <section id="local-fields">
    <label for="repo">Checkout folder</label>
    <div class="row">
      <input id="repo" type="text" placeholder="/path/to/deepseek-harness">
      <button id="browse" type="button">Choose…</button>
    </div>
    <p class="error" id="error-repo"></p>
  </section>

  <section id="npx-fields" hidden>
    <label for="package">Package</label>
    <input id="package" type="text">
    <p class="error" id="error-package"></p>
    <label for="version">Version</label>
    <input id="version" type="text">
    <label for="workspace">Workspace folder</label>
    <div class="row">
      <input id="workspace" type="text" placeholder="defaults to your home folder">
      <button id="browse-workspace" type="button">Choose…</button>
    </div>
    <p class="error" id="error-workspace"></p>
  </section>

  <label for="notifyPort">Notification port</label>
  <input id="notifyPort" type="text" inputmode="numeric">
  <p class="error" id="error-notifyPort"></p>

  <label for="hotkey">Show/hide shortcut</label>
  <input id="hotkey" type="text">
  <p class="error" id="error-hotkey"></p>

  <details>
    <summary>Advanced</summary>
    <label for="pnpmPath">pnpm path</label>
    <input id="pnpmPath" type="text" placeholder="found on PATH by default">
    <label for="npxPath">npx path</label>
    <input id="npxPath" type="text" placeholder="found on PATH by default">
  </details>

  <p class="error" id="error-kind"></p>
  <div class="actions"><button id="save" type="button">Save</button></div>
</main>
<script src="settings.js"></script>
```

`src/renderer/settings.css`:

```css
:root { color-scheme: light dark; }
body { font: 13px/1.5 -apple-system, system-ui, sans-serif; margin: 0; padding: 1.5rem; }
main { max-width: 34rem; margin: 0 auto; display: grid; gap: .5rem; }
h1 { font-size: 1.1rem; margin: 0; }
.hint { margin: 0 0 .5rem; opacity: .75; }
label { font-weight: 500; margin-top: .5rem; }
fieldset label { font-weight: 400; display: block; }
input[type="text"] { width: 100%; box-sizing: border-box; padding: .4rem; }
.row { display: flex; gap: .5rem; }
.row input { flex: 1; }
.error { color: #d33; margin: .15rem 0 0; min-height: 1em; }
.actions { margin-top: 1rem; display: flex; justify-content: flex-end; }
button { padding: .4rem 1rem; }
```

`src/renderer/settings.js`:

```js
// Dumb form: reads values, sends them to main, renders whatever comes back.
// All validation lives in the main process.
const FIELDS = ['repo', 'package', 'version', 'workspace', 'notifyPort', 'hotkey', 'pnpmPath', 'npxPath']
const el = (id) => document.getElementById(id)
const kindOf = () => document.querySelector('input[name="kind"]:checked').value

function showKind() {
  const npx = kindOf() === 'npx'
  el('local-fields').hidden = npx
  el('npx-fields').hidden = !npx
}

function clearErrors() {
  for (const name of [...FIELDS, 'kind']) el(`error-${name}`).textContent = ''
}

function collect() {
  const form = { kind: kindOf() }
  for (const name of FIELDS) form[name] = el(name).value
  return form
}

async function load() {
  const result = await window.settings.read()
  el('intro').textContent = result.configured
    ? 'Changes are applied as soon as you save.'
    : 'Tell the app where to find the harness to get started.'
  const form = result.form
  for (const name of FIELDS) el(name).value = form[name]
  for (const radio of document.querySelectorAll('input[name="kind"]')) {
    radio.checked = radio.value === form.kind
  }
  showKind()
}

for (const radio of document.querySelectorAll('input[name="kind"]')) {
  radio.addEventListener('change', showKind)
}

el('browse').addEventListener('click', async () => {
  const picked = await window.settings.pickFolder()
  if (picked !== undefined) el('repo').value = picked
})

el('browse-workspace').addEventListener('click', async () => {
  const picked = await window.settings.pickFolder()
  if (picked !== undefined) el('workspace').value = picked
})

el('save').addEventListener('click', async () => {
  clearErrors()
  el('save').disabled = true
  try {
    const result = await window.settings.save(collect())
    if (result.ok) {
      el('error-kind').textContent = result.warnings.join(' ')
    } else {
      for (const [name, message] of Object.entries(result.errors)) {
        const target = el(`error-${name}`)
        if (target !== null) target.textContent = message
      }
    }
  } finally {
    el('save').disabled = false
  }
})

void load()
```

- [ ] **Step 5: Add the renderer to the package**

In `package.json`'s `build.files`, the existing `"dist/**/*"` already covers `dist/renderer` and `dist/preload`. Confirm by reading it; add nothing if it is already a recursive glob.

- [ ] **Step 6: Build and check the artifacts exist**

Run: `npm run build && ls dist/preload/settings.js dist/renderer/settings.html`
Expected: both paths exist. A missing preload means the window fails at creation.

- [ ] **Step 7: Run the suite**

Run: `npx vitest run`
Expected: all pass, including the updated `read` test. Report the count.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: settings window, preload bridge, and form"
```

---

### Task 5: First run, the menu, and the tray entry

**Files:**
- Modify: `src/main/index.ts`, `src/main/window.ts`, `src/main/tray.ts`
- Test: `src/main/index.spec.ts`

**Interfaces:**
- Consumes: `openSettings`, `settingsWindowOpen` (Task 4); `createSettingsHandlers` (Task 3).
- Produces: `TrayActions` gains `openSettings(): void`.

- [ ] **Step 1: Write the failing tests**

Add to `src/main/index.spec.ts`, following the existing `vi.mock('electron', ...)` setup already in that file:

```ts
  it('opens settings and does not boot when no config exists', async () => {
    configResult = { configured: false }
    await readyHandler()
    expect(openSettingsMock).toHaveBeenCalled()
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('boots without opening settings when a config exists', async () => {
    configResult = { configured: true, config: STORED }
    await readyHandler()
    expect(openSettingsMock).not.toHaveBeenCalled()
    expect(spawnMock).toHaveBeenCalled()
  })

  it('quits when first-run settings close without a config being saved', async () => {
    configResult = { configured: false }
    await readyHandler()
    closeSettings()
    expect(quitMock).toHaveBeenCalled()
  })

  it('does not quit when settings close and a config exists', async () => {
    configResult = { configured: true, config: STORED }
    await readyHandler()
    trayActions.openSettings()
    closeSettings()
    expect(quitMock).not.toHaveBeenCalled()
  })
```

`openSettingsMock` and `closeSettings` come from mocking `./settings-window`: capture the `onClosed` callback passed to `openSettings` and expose a `closeSettings()` that invokes it.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/main/index.spec.ts`
Expected: FAIL — the first-run branch does not exist.

- [ ] **Step 3: Add the first-run branch**

In `src/main/index.ts`'s `whenReady` handler, before `await enqueue(bootNow)`:

```ts
    const stored = loadConfig(CONFIG_PATH)
    if (!stored.configured) {
      // Nothing to boot and nothing to show until the user says where the
      // harness lives, so settings is the whole app until it is saved.
      showSettings()
      return
    }
```

Add the opener and its close behavior above `whenReady`:

```ts
/** Open settings, quitting if a first run closes it without configuring anything. */
function showSettings(): void {
  openSettings(settingsHandlers, () => {
    if (!loadConfig(CONFIG_PATH).configured) app.quit()
  })
}
```

`settingsHandlers` is built once, near the other module state:

```ts
const settingsHandlers = createSettingsHandlers({
  readConfig: () => loadConfig(CONFIG_PATH),
  writeConfig: (config) => writeConfig(CONFIG_PATH, config),
  pickFolder: async () => {
    const chosen = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return chosen.canceled ? undefined : chosen.filePaths[0]
  },
  probePort: portIsFree,
  apply: applySettings,
  isQuitting: () => quitting,
})
```

`applySettings` is Task 6's; for this task, stub it as `async (): Promise<string[]> => []` with a `FIXME(task-6): restart the harness / rebind the listener / re-register the hotkey` comment, and replace the stub in Task 6.

`portIsFree` goes in `src/main/notify.ts`, beside the listener that binds the port:

```ts
/**
 * Whether `port` can currently be bound on loopback.
 * @param port - the port to test.
 * @returns true when a listener could bind it right now.
 */
export function portIsFree(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const probe = createServer()
    probe.once('error', () => resolve(false))
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)))
  })
}
```

- [ ] **Step 4: Add the menu and tray entries**

In `src/main/window.ts`, `installMenu` takes an `onSettings: () => void` parameter and gains a File menu before `editMenu`:

```ts
      {
        label: 'File',
        submenu: [{ label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: onSettings }],
      },
```

Also add the same item to the `appMenu` position by replacing `{ role: 'appMenu' }` with an explicit app submenu carrying `{ label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: onSettings }`, `{ type: 'separator' }`, and `{ role: 'quit' }` — macOS convention puts it there, and the File entry was explicitly requested, so it appears in both. Update the `installMenu()` call in `index.ts` to pass `showSettings`.

In `src/main/tray.ts`, add `openSettings(): void` to `TrayActions` and a `{ label: 'Settings…', click: () => actions.openSettings() }` item above the separator that precedes Quit. Pass `openSettings: showSettings` at the `createTray` call in `index.ts`.

- [ ] **Step 5: Run the suite**

Run: `npm run build && npx vitest run`
Expected: build clean, all pass. Report the count.

- [ ] **Step 6: Verify first run by hand**

Move the real config aside, run the app, confirm settings opens and no harness spawns, then restore it:

```bash
mv ~/.dsh/desktop.json /tmp/desktop.json.bak
npm run start > /tmp/dsh-firstrun.log 2>&1 &
# inspect, then quit the app via osascript
mv /tmp/desktop.json.bak ~/.dsh/desktop.json
```

Expected: the settings window appears; `/tmp/dsh-firstrun.log` shows no harness spawn. Restoring the config is mandatory — it is the user's working configuration.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: first-run settings, menu entry, and tray entry"
```

---

### Task 6: Applying a save without restarting the app

**Files:**
- Modify: `src/main/index.ts`
- Test: `src/main/index.spec.ts`

**Interfaces:**
- Consumes: `enqueue`, `bootNow`, `stopCurrent`, `notifier`, the generation token — all existing in `index.ts`.
- Produces: `async function applySettings(previous: DesktopConfig | undefined, next: DesktopConfig): Promise<void>`

- [ ] **Step 1: Write the failing tests**

Add to `src/main/index.spec.ts`:

```ts
  it('restarts the harness when the source changes', async () => {
    await bootWith(STORED)
    spawnMock.mockClear()
    await applySettings(STORED, { ...STORED, harness: { kind: 'local', repo: OTHER_REPO } })
    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(children[0].killed).toBe(true)
  })

  it('restarts the harness when the notify port changes, because hooks.json is regenerated at boot', async () => {
    await bootWith(STORED)
    spawnMock.mockClear()
    await applySettings(STORED, { ...STORED, notifyPort: 5000 })
    expect(spawnMock).toHaveBeenCalledTimes(1)
  })

  it('rebinds the notify listener when the port changes', async () => {
    await bootWith(STORED)
    await applySettings(STORED, { ...STORED, notifyPort: 5000 })
    expect(startNotifyListenerMock).toHaveBeenLastCalledWith(5000, expect.any(Function))
  })

  it('re-registers the hotkey without restarting the harness', async () => {
    await bootWith(STORED)
    spawnMock.mockClear()
    await applySettings(STORED, { ...STORED, hotkey: 'Alt+D' })
    expect(unregisterAllMock).toHaveBeenCalled()
    expect(registerMock).toHaveBeenLastCalledWith('Alt+D', expect.any(Function))
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('restarts when a binary path changes, since it is resolved at spawn', async () => {
    await bootWith(STORED)
    spawnMock.mockClear()
    await applySettings(STORED, { ...STORED, pnpmPath: '/opt/pnpm' })
    expect(spawnMock).toHaveBeenCalledTimes(1)
  })

  it('does nothing when nothing changed', async () => {
    await bootWith(STORED)
    spawnMock.mockClear()
    unregisterAllMock.mockClear()
    await applySettings(STORED, { ...STORED })
    expect(spawnMock).not.toHaveBeenCalled()
    expect(unregisterAllMock).not.toHaveBeenCalled()
  })

  it('boots for the first time when there was no previous config', async () => {
    configResult = { configured: false }
    await readyHandler()
    spawnMock.mockClear()
    await applySettings(undefined, STORED)
    expect(spawnMock).toHaveBeenCalledTimes(1)
  })
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/main/index.spec.ts`
Expected: FAIL — `applySettings` is still the Task 5 stub.

- [ ] **Step 3: Implement it**

Replace the stub in `src/main/index.ts`. Export it so the tests can drive it directly:

```ts
/** Whether two configs differ in a way that requires respawning the harness child. */
function needsRestart(previous: DesktopConfig | undefined, next: DesktopConfig): boolean {
  if (previous === undefined) return true
  return JSON.stringify(previous.harness) !== JSON.stringify(next.harness)
    // The notify port is baked into the generated hooks.json at boot, so a
    // changed port only reaches the harness through a respawn.
    || previous.notifyPort !== next.notifyPort
    // Both binaries are resolved when the child is spawned.
    || previous.pnpmPath !== next.pnpmPath
    || previous.npxPath !== next.npxPath
}

/**
 * Apply saved settings to the running app.
 *
 * Harness-affecting changes go through `enqueue`, the same serialized
 * transition the tray's Restart uses, so a save can never interleave with a
 * boot, another restart, or shutdown.
 * @param previous - the config being replaced, or undefined on a first run.
 * @param next - the config just written to disk.
 * @returns non-blocking warnings for the settings form to display.
 */
export async function applySettings(
  previous: DesktopConfig | undefined,
  next: DesktopConfig,
): Promise<string[]> {
  const warnings: string[] = []
  if (needsRestart(previous, next)) {
    await enqueue(async () => {
      await stopCurrent()
      await bootNow()
    })
  }

  if (previous?.notifyPort !== next.notifyPort) {
    await notifier?.close()
    notifier = undefined
    try {
      notifier = await startNotifyListener(next.notifyPort, onTurnEnd)
    } catch (error) {
      warnings.push((error as Error).message)
    }
  }

  if (previous?.hotkey !== next.hotkey) {
    globalShortcut.unregisterAll()
    if (!globalShortcut.register(next.hotkey, toggleWindow)) {
      console.warn(`dsh-desktop: the hotkey ${next.hotkey} could not be registered; another app already owns it.`)
    }
  }
}
```

If `stopCurrent` is named differently in the current file, use the existing name — do not add a second teardown path.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/main/index.spec.ts`
Expected: PASS.

- [ ] **Step 5: Prove the restart tests are not vacuous**

Temporarily make `needsRestart` return `false` unconditionally. Run `npx vitest run src/main/index.spec.ts` and confirm the four restart tests FAIL. Restore it and confirm they pass. Report both observations — a routing test that passes either way is not coverage.

- [ ] **Step 6: Verify by hand, end to end**

Run the app, open Settings from the File menu, change the notification port to an unused value, save, and confirm from the log that the harness respawned and the new port appears in the regenerated `hooks.json` under the app's `userData/runtime`. Then set it back and save again. Quit and confirm no orphaned harness process survives.

Restore `~/.dsh/desktop.json` to its original contents if anything changed it.

- [ ] **Step 7: Full check and commit**

Run: `npm run build && npx vitest run && npm run test:smoke`
Expected: all three pass. Report the counts.

```bash
git add -A
git commit -m "feat: apply settings changes without restarting the app"
```

---

### Task 7: Packaged verification

**Files:**
- Modify: `tests/smoke.spec.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: no new exports.

A packaged build that omits the preload or the renderer fails only at window creation, which the existing smoke test never reaches.

- [ ] **Step 1: Extend the smoke test**

The package is built with `asar: true`, so `dist/` lives inside `app.asar`. Node's own `fs` cannot see inside that archive — only Electron's patched `fs` can. A `existsSync` check from the Playwright process would therefore report `false` for files that are present and packaged correctly. Ask the running app instead.

Add to `tests/smoke.spec.ts`, after the existing assertions and before the quit:

```ts
  // Asked of the Electron main process, whose fs understands app.asar.
  const shipped = await app.evaluate(async ({ app: electronApp }) => {
    const { existsSync } = await import('node:fs')
    const { join, dirname } = await import('node:path')
    const dist = join(dirname(electronApp.getAppPath()), 'app.asar', 'dist')
    return {
      preload: existsSync(join(dist, 'preload', 'settings.js')),
      renderer: existsSync(join(dist, 'renderer', 'settings.html')),
    }
  })
  expect(shipped).toEqual({ preload: true, renderer: true })
```

If `getAppPath()` already returns the `app.asar` path on this build, drop the `join(dirname(...), 'app.asar')` wrapping and use it directly — print the value once and read it rather than guessing which form applies.

- [ ] **Step 2: Package and run it**

Run: `npm run pack && npm run test:smoke`
Expected: PASS. A failure here means the renderer or preload is not in the package — fix the `build` config, not the test.

- [ ] **Step 3: Open Settings in the packaged app**

Launch the packaged `.app`, open Settings from the File menu, confirm the form renders with the current values, close it, and quit. Confirm no orphaned harness process survives.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "test: assert the packaged app ships its preload and renderer"
```

---

## Verification checklist

- [ ] `grep -rn "/Users/" src/ tests/` returns nothing
- [ ] `npm run build && npx vitest run` — all pass
- [ ] `npm run test:smoke` — passes against a fresh `npm run pack`
- [ ] `git -C ~/Development/deepseek-harness status --porcelain` — empty
- [ ] First run with no `desktop.json` opens Settings and boots nothing
- [ ] Closing first-run Settings without saving quits the app
- [ ] Saving a changed port respawns the harness and rebinds the listener
- [ ] `~/.dsh/desktop.json` restored to the user's working configuration
- [ ] Quitting leaves no orphaned harness process
