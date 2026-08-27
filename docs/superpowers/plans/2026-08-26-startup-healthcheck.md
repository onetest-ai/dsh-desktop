# Startup Healthcheck and Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reconcile what `desktop.json` declares with what is installed, before the harness boots, in a window the user can see.

**Architecture:** A pure `runHealthcheck` produces typed findings from the config and the filesystem; a repair step installs what is missing through the existing `installPlugin` path; a startup page renders both in the main window and hands off to the harness URL when done. Nothing new decides policy — the findings carry it.

**Tech Stack:** TypeScript, Electron 33, Node 22, vitest, Playwright (smoke).

**Spec:** `docs/superpowers/specs/2026-08-26-startup-healthcheck-design.md`

## Global Constraints

- Node `>=22`; TypeScript `module: CommonJS`, `strict: true`.
- Every module and export carries JSDoc stating its non-obvious contract; function-like exports document `@param`/`@returns`.
- Tests describe behavior. Break the code deliberately to prove a guard test fails before relying on it.
- `quitting` is re-checked after every `await` and before every side effect. A quit landing mid-repair must not spawn further work.
- Repair reuses `installPlugin` and `pluginStatus`. **No second install path.**
- The healthcheck never writes `desktop.json`. `ensureDefaultPlugins` remains the only writer, and runs **before** the healthcheck.
- Run `npx vitest run` and `npx tsc --noEmit -p tsconfig.json` before every commit.

---

### Task 1: Findings

**Files:**
- Create: `src/main/healthcheck.ts`
- Test: `src/main/healthcheck.spec.ts`

**Interfaces:**
- Consumes: `DesktopConfig` (`config.ts`), `PluginStatus`/`pluginStatus` (`plugin-entries.ts`), `preflight` (`preflight.ts`).
- Produces:
  - `type FindingSeverity = 'ok' | 'repairable' | 'blocked'`
  - `interface Finding { id: string; title: string; detail?: string; severity: FindingSeverity; repair?: { kind: 'install-plugin'; spec: string } }`
  - `interface HealthcheckDeps { preflight(source: HarnessSource): { ok: boolean; message?: string }; statusFor(entry: PluginEntry): PluginStatus; binaryResolves(configured: string | undefined, name: string): boolean; shellPathCached(): boolean }`
  - `runHealthcheck(config: DesktopConfig, deps: HealthcheckDeps): Finding[]`
  - `repairablePlugins(findings: Finding[]): string[]`

- [ ] **Step 1: Write the failing test**

Create `src/main/healthcheck.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { DesktopConfig } from './config'
import { repairablePlugins, runHealthcheck, type HealthcheckDeps } from './healthcheck'

/** Deps where everything is healthy, overridable per test. */
function deps(overrides: Partial<HealthcheckDeps> = {}): HealthcheckDeps {
  return {
    preflight: () => ({ ok: true }),
    statusFor: () => ({ kind: 'ready', package: 'p', entryPath: '/p/index.js', probeDirectory: '/p', packageDir: '/p' }),
    binaryResolves: () => true,
    shellPathCached: () => true,
    ...overrides,
  }
}

/** A config with the given plugins, otherwise valid. */
function config(plugins: { spec: string; version?: string }[] = []): DesktopConfig {
  return { harness: { kind: 'local', repo: '/tmp/h' }, notifyPort: 1, hotkey: 'X', plugins }
}

/** The finding with the given id, if present. */
function find(findings: ReturnType<typeof runHealthcheck>, id: string) {
  return findings.find((finding) => finding.id === id)
}

describe('runHealthcheck', () => {
  it('reports everything ok on a healthy install', () => {
    expect(runHealthcheck(config(), deps()).every((finding) => finding.severity === 'ok')).toBe(true)
  })

  it('blocks on a harness source that is not usable, since nothing else can run', () => {
    const findings = runHealthcheck(config(), deps({ preflight: () => ({ ok: false, message: 'no dist' }) }))
    expect(find(findings, 'harness')?.severity).toBe('blocked')
    expect(find(findings, 'harness')?.detail).toContain('no dist')
  })

  it('marks a declared but uninstalled plugin repairable, not failed', () => {
    const findings = runHealthcheck(
      config([{ spec: 'dsh-project-mcp-bridge@0.2.1' }]),
      deps({ statusFor: () => ({ kind: 'unavailable', package: 'dsh-project-mcp-bridge', reason: 'not installed yet' }) }),
    )
    expect(find(findings, 'plugin:dsh-project-mcp-bridge')?.severity).toBe('repairable')
  })

  it('carries the spec to install, so repair needs no second lookup', () => {
    const findings = runHealthcheck(
      config([{ spec: 'dsh-project-mcp-bridge@0.2.1' }]),
      deps({ statusFor: () => ({ kind: 'unavailable', package: 'dsh-project-mcp-bridge', reason: 'not installed yet' }) }),
    )
    expect(find(findings, 'plugin:dsh-project-mcp-bridge')?.repair).toEqual({ kind: 'install-plugin', spec: 'dsh-project-mcp-bridge@0.2.1' })
  })

  it('reports an installed plugin as ok', () => {
    const findings = runHealthcheck(config([{ spec: 'p', version: '1.0.0' }]), deps())
    expect(find(findings, 'plugin:p')?.severity).toBe('ok')
  })

  it('reports a missing binary as blocked, since installing needs it', () => {
    const findings = runHealthcheck(config(), deps({ binaryResolves: (_c, name) => name !== 'npm' }))
    expect(find(findings, 'binary:npm')?.severity).toBe('blocked')
  })

  it('reports an absent shell-PATH cache as ok, because it is an optimisation', () => {
    // A first launch has none, and the app works without it — flagging it
    // would turn a normal first run into a scary screen.
    const findings = runHealthcheck(config(), deps({ shellPathCached: () => false }))
    expect(find(findings, 'shell-path')?.severity).toBe('ok')
  })

  it('keeps findings in a stable order, so the screen does not reshuffle between runs', () => {
    const ids = runHealthcheck(config([{ spec: 'b' }, { spec: 'a' }]), deps()).map((finding) => finding.id)
    expect(ids).toEqual([...ids])
    expect(ids.slice(0, 2)).toEqual(['harness', 'binary:pnpm'])
  })
})

describe('repairablePlugins', () => {
  it('lists the specs to install, in finding order', () => {
    const findings = runHealthcheck(
      config([{ spec: 'a@1.0.0' }, { spec: 'b@2.0.0' }]),
      deps({ statusFor: () => ({ kind: 'unavailable', package: 'x', reason: 'not installed yet' }) }),
    )
    expect(repairablePlugins(findings)).toEqual(['a@1.0.0', 'b@2.0.0'])
  })

  it('lists nothing when everything is installed', () => {
    expect(repairablePlugins(runHealthcheck(config([{ spec: 'a', version: '1' }]), deps()))).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/healthcheck.spec.ts`
Expected: FAIL — `Failed to resolve import "./healthcheck"`.

- [ ] **Step 3: Write the implementation**

Create `src/main/healthcheck.ts`:

```ts
import type { DesktopConfig } from './config'
import type { HarnessSource } from './harness-source'
import { parseSpec, type PluginEntry, type PluginStatus } from './plugin-entries'

/**
 * How much a finding matters.
 *
 * `repairable` is the reason this exists: a declared plugin that is not
 * installed is a setup step the app can complete itself, and reporting it as
 * a failure — which the Plugins tab did — blames the user for a state they
 * did not create.
 */
export type FindingSeverity = 'ok' | 'repairable' | 'blocked'

/** One checked thing, and what can be done about it. */
export interface Finding {
  /** Stable identity for the renderer and for tests; never a display string. */
  id: string
  title: string
  detail?: string
  severity: FindingSeverity
  /**
   * How to fix it, when the app can. Carried on the finding so repair needs
   * no second lookup and cannot disagree with what was reported.
   */
  repair?: { kind: 'install-plugin'; spec: string }
}

/** Everything the check reads, injected so tests touch no filesystem. */
export interface HealthcheckDeps {
  /**
   * Whether the harness source is usable.
   * @param source - the configured source.
   * @returns ok, or the reason it cannot be used.
   */
  preflight(source: HarnessSource): { ok: boolean; message?: string }
  /**
   * Where one plugin entry stands.
   * @param entry - the configured entry.
   * @returns ready with its resolved paths, or unavailable with why.
   */
  statusFor(entry: PluginEntry): PluginStatus
  /**
   * Whether a launcher binary can be resolved.
   * @param configured - the configured absolute path, when set.
   * @param name - the binary name.
   * @returns whether it resolves.
   */
  binaryResolves(configured: string | undefined, name: string): boolean
  /**
   * Whether a resolved login-shell PATH is cached.
   * @returns whether the cache is present.
   */
  shellPathCached(): boolean
}

/**
 * Check the install, without changing anything.
 *
 * Order is fixed rather than derived, so the screen does not reshuffle
 * between runs: harness, binaries, shell PATH, then plugins in configured
 * order.
 * @param config - the stored settings.
 * @param deps - the injected reads.
 * @returns every finding, worst-first within its own kind but never reordered.
 */
export function runHealthcheck(config: DesktopConfig, deps: HealthcheckDeps): Finding[] {
  const findings: Finding[] = []

  const source = deps.preflight(config.harness)
  findings.push({
    id: 'harness',
    title: 'Harness',
    severity: source.ok ? 'ok' : 'blocked',
    ...(source.message === undefined ? {} : { detail: source.message }),
  })

  for (const [name, configured] of [
    ['pnpm', config.pnpmPath],
    ['npm', config.npmPath],
  ] as const) {
    const resolves = deps.binaryResolves(configured, name)
    findings.push({
      id: `binary:${name}`,
      title: name,
      severity: resolves ? 'ok' : 'blocked',
      ...(resolves ? {} : { detail: `${name} could not be found. Set its path on the Advanced tab.` }),
    })
  }

  // Always ok: the cache is an optimisation, absent on every first launch,
  // and the app works without it. Reporting it would make a normal first run
  // look broken.
  findings.push({
    id: 'shell-path',
    title: 'Shell PATH',
    severity: 'ok',
    ...(deps.shellPathCached() ? {} : { detail: 'Not resolved yet; it is read in the background.' }),
  })

  for (const entry of config.plugins ?? []) {
    const status = deps.statusFor(entry)
    const { package: pkg } = parseSpec(entry.spec)
    findings.push({
      id: `plugin:${pkg}`,
      title: pkg,
      severity: status.kind === 'ready' ? 'ok' : 'repairable',
      ...(status.kind === 'ready' ? {} : { detail: status.reason, repair: { kind: 'install-plugin', spec: entry.spec } }),
    })
  }

  return findings
}

/**
 * The plugin specs a repair pass should install.
 * @param findings - what the check produced.
 * @returns the specs, in finding order.
 */
export function repairablePlugins(findings: Finding[]): string[] {
  return findings
    .filter((finding) => finding.severity === 'repairable' && finding.repair?.kind === 'install-plugin')
    .map((finding) => finding.repair!.spec)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/healthcheck.spec.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Prove the tests are not vacuous**

Change `severity: status.kind === 'ready' ? 'ok' : 'repairable'` to always `'ok'` and re-run.
Expected: "marks a declared but uninstalled plugin repairable" FAILS. Restore.

Then delete the `repair:` property from that same push and re-run.
Expected: "carries the spec to install" FAILS, and both `repairablePlugins` tests fail. Restore.

- [ ] **Step 6: Commit**

```bash
npx tsc --noEmit -p tsconfig.json
git add src/main/healthcheck.ts src/main/healthcheck.spec.ts
git commit -m "feat(startup): check what the config declares against what is installed"
```

---

### Task 2: Repair

**Files:**
- Create: `src/main/repair.ts`
- Test: `src/main/repair.spec.ts`

**Interfaces:**
- Consumes: `repairablePlugins` (Task 1); `installPlugin` semantics from `settings-ipc.ts`'s `SettingsDeps`.
- Produces:
  - `interface RepairDeps { installPlugin(pkg: string, version: string, npmPath: string | undefined, onLine: (line: string) => void): Promise<string>; isQuitting(): boolean }`
  - `interface RepairOutcome { installed: string[]; failed: { spec: string; reason: string }[] }`
  - `repairPlugins(specs: string[], npmPath: string | undefined, deps: RepairDeps, onLine: (line: string) => void): Promise<RepairOutcome>`

- [ ] **Step 1: Write the failing test**

Create `src/main/repair.spec.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { repairPlugins, type RepairDeps } from './repair'

/** Deps whose installs succeed, overridable per test. */
function deps(overrides: Partial<RepairDeps> = {}): RepairDeps {
  return { installPlugin: vi.fn(async () => '1.0.0'), isQuitting: () => false, ...overrides }
}

describe('repairPlugins', () => {
  it('installs every missing plugin', async () => {
    const d = deps()
    const outcome = await repairPlugins(['a@1.0.0', 'b@2.0.0'], undefined, d, () => {})
    expect(outcome.installed).toEqual(['a@1.0.0', 'b@2.0.0'])
    expect(vi.mocked(d.installPlugin)).toHaveBeenCalledTimes(2)
  })

  it('installs the pinned version a spec names, rather than latest', async () => {
    const d = deps()
    await repairPlugins(['a@1.2.3'], undefined, d, () => {})
    expect(vi.mocked(d.installPlugin).mock.calls[0].slice(0, 2)).toEqual(['a', '1.2.3'])
  })

  it('installs latest for an unpinned spec', async () => {
    const d = deps()
    await repairPlugins(['a'], undefined, d, () => {})
    expect(vi.mocked(d.installPlugin).mock.calls[0].slice(0, 2)).toEqual(['a', 'latest'])
  })

  it('streams install output, which is the whole point of showing a screen', async () => {
    const lines: string[] = []
    const d = deps({ installPlugin: vi.fn(async (_p, _v, _n, onLine) => { onLine('added 101 packages'); return '1.0.0' }) })
    await repairPlugins(['a'], undefined, d, (line) => lines.push(line))
    expect(lines).toContain('added 101 packages')
  })

  it('reports a failure without abandoning the rest', async () => {
    const d = deps({
      installPlugin: vi.fn(async (pkg) => {
        if (pkg === 'a') throw new Error('registry unreachable')
        return '1.0.0'
      }),
    })
    const outcome = await repairPlugins(['a', 'b'], undefined, d, () => {})
    expect(outcome.failed).toEqual([{ spec: 'a', reason: 'registry unreachable' }])
    expect(outcome.installed).toEqual(['b'])
  })

  it('stops spawning installs once quitting lands, rather than working behind the quit', async () => {
    let quitting = false
    const d = deps({
      isQuitting: () => quitting,
      installPlugin: vi.fn(async () => {
        quitting = true
        return '1.0.0'
      }),
    })
    const outcome = await repairPlugins(['a', 'b', 'c'], undefined, d, () => {})
    expect(vi.mocked(d.installPlugin)).toHaveBeenCalledTimes(1)
    expect(outcome.installed).toEqual(['a'])
  })

  it('does nothing at all when there is nothing to repair', async () => {
    const d = deps()
    const outcome = await repairPlugins([], undefined, d, () => {})
    expect(outcome).toEqual({ installed: [], failed: [] })
    expect(vi.mocked(d.installPlugin)).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/repair.spec.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write the implementation**

Create `src/main/repair.ts`:

```ts
import { parseSpec } from './plugin-entries'

/** The effects repair needs, injected so tests spawn no `npm`. */
export interface RepairDeps {
  /**
   * Resolve and install one plugin, streaming `npm` output.
   *
   * The same call a Settings save makes: an entry repaired at startup must be
   * indistinguishable from one installed by a save, so there is exactly one
   * install path to reason about.
   * @param pkg - the package name.
   * @param version - the concrete version or dist-tag to install.
   * @param npmPath - the configured `npm` override.
   * @param onLine - receives install output as it arrives.
   * @returns the concrete installed version.
   */
  installPlugin(pkg: string, version: string, npmPath: string | undefined, onLine: (line: string) => void): Promise<string>
  isQuitting(): boolean
}

/** What a repair pass managed and what it could not. */
export interface RepairOutcome {
  installed: string[]
  failed: { spec: string; reason: string }[]
}

/**
 * Install the plugins the healthcheck found missing.
 *
 * A single failure never abandons the rest: plugins are independent, and one
 * unreachable package must not cost the user the others. `isQuitting` is
 * checked before every install rather than once, because each call spawns a
 * detached `npm` that only the quit path's own reap would ever collect — and
 * that reap runs once, before this loop could still be running.
 * @param specs - the specs to install, as `repairablePlugins` returned them.
 * @param npmPath - the configured `npm` override.
 * @param deps - injected effects.
 * @param onLine - receives install output as it arrives.
 * @returns what was installed and what failed.
 */
export async function repairPlugins(
  specs: string[],
  npmPath: string | undefined,
  deps: RepairDeps,
  onLine: (line: string) => void,
): Promise<RepairOutcome> {
  const installed: string[] = []
  const failed: { spec: string; reason: string }[] = []
  for (const spec of specs) {
    if (deps.isQuitting()) break
    const { package: pkg, pinnedVersion } = parseSpec(spec)
    try {
      await deps.installPlugin(pkg, pinnedVersion ?? 'latest', npmPath, onLine)
      installed.push(spec)
    } catch (error) {
      failed.push({ spec, reason: (error as Error).message })
    }
  }
  return { installed, failed }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/repair.spec.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Prove the quit guard is not vacuous**

Move `if (deps.isQuitting()) break` to before the loop and re-run.
Expected: "stops spawning installs once quitting lands" FAILS with 3 calls instead of 1. Restore.

- [ ] **Step 6: Commit**

```bash
npx tsc --noEmit -p tsconfig.json
git add src/main/repair.ts src/main/repair.spec.ts
git commit -m "feat(startup): install what the healthcheck found missing"
```

---

### Task 3: The startup surface

**Files:**
- Create: `src/renderer/startup.html`, `src/renderer/startup.js`, `src/preload/startup.ts`, `src/main/startup-window.ts`
- Modify: `package.json` (`build:renderer` copies the new files)
- Test: `src/renderer/startup.spec.ts`

**Interfaces:**
- Consumes: `Finding` (Task 1), `RepairOutcome` (Task 2).
- Produces:
  - `showStartup(window: BrowserWindow): Promise<void>` — loads the page
  - `pushFindings(window: BrowserWindow, findings: Finding[]): void`
  - `pushProgress(window: BrowserWindow, line: string): void`
  - `pushPhase(window: BrowserWindow, phase: 'checking' | 'repairing' | 'starting' | 'failed'): void`
  - renderer bridge `window.startup`: `onFindings`, `onProgress`, `onPhase`, `openSettings()`, `continueAnyway()`

- [ ] **Step 1: Write the failing test**

Create `src/renderer/startup.spec.ts`, modelled on `settings.spec.ts`'s fake DOM — reuse its `element()`/`declaredIds()` approach, remembering that fake supports only single-argument `append` and has no `createTextNode`. Cover: a finding list renders one row per finding; a `blocked` finding shows its detail; progress lines append to the progress node; the `repairing` phase reveals that node; the `failed` phase reveals Open Settings and Continue Anyway; and clicking each calls its bridge exactly once.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/startup.spec.ts`
Expected: FAIL — `startup.html` does not exist.

- [ ] **Step 3: Build the page**

`startup.html`: the product name, a phase line, a `<ul id="findings">`, a `<pre id="progress" hidden>`, and a hidden actions row with `#open-settings` and `#continue-anyway`. Reuse `settings.css` for the theme tokens so it matches the Settings window rather than inventing a second look.

`startup.js`: a dumb renderer, exactly like `settings.js` — subscribe to the three pushes, render, and call the bridge on click. No policy.

`src/preload/startup.ts`: expose only those five members over `contextBridge`, with a module JSDoc stating what the surface can and cannot do, following `preload/settings.ts`.

`src/main/startup-window.ts`: `showStartup` loads the file into the passed window; the three `push*` helpers send to `window.webContents`; register `startup:open-settings` and `startup:continue-anyway` once, mirroring `settings-window.ts`'s `channelsRegistered` guard.

Add `src/renderer/startup.html src/renderer/startup.js` to `build:renderer`'s `cp` list in `package.json`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run`
Expected: PASS, all suites.

- [ ] **Step 5: Prove the packaged app ships it**

Extend `tests/smoke.spec.ts`'s existing shipped-files assertion to include `dist/renderer/startup.html` and `dist/renderer/startup.js`. Then rename `src/renderer/startup.html`, run `npm run pack && npm run test:smoke`, and confirm the smoke test FAILS naming it. Restore and confirm it passes.

This is the same class of failure the preload/renderer assertion exists for: a renderer file missing from `build:renderer` produces no compile error.

- [ ] **Step 6: Commit**

```bash
npx tsc --noEmit -p tsconfig.json
git add -A
git commit -m "feat(startup): a startup surface for findings, progress, and failure"
```

---

### Task 4: Wire it into boot, and reinstate the default

**Files:**
- Modify: `src/main/index.ts`, `src/main/index.spec.ts`, `src/main/plugin-defaults.ts`
- Test: `src/main/index.spec.ts`

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Write the failing test**

Append to `src/main/index.spec.ts`, inside the existing suite whose `beforeEach` gives each test a temp `$DSH_HOME`:

```ts
describe('startup healthcheck', () => {
  it('installs a declared plugin that is not installed, before the harness boots', async () => {
    configResult = { configured: true, config: { ...STORED, plugins: [{ spec: 'dsh-project-mcp-bridge@0.2.1' }] } }
    pluginStatusMock.mockImplementation(() => ({ kind: 'unavailable', package: 'dsh-project-mcp-bridge', reason: 'not installed yet' }))
    await bootReady()
    expect(installPluginMock).toHaveBeenCalledWith('dsh-project-mcp-bridge', '0.2.1', undefined, expect.any(Function))
  })

  it('boots the harness only after repair has finished', async () => {
    const order: string[] = []
    configResult = { configured: true, config: { ...STORED, plugins: [{ spec: 'a@1.0.0' }] } }
    pluginStatusMock.mockImplementation(() => ({ kind: 'unavailable', package: 'a', reason: 'not installed yet' }))
    installPluginMock.mockImplementation(async () => {
      order.push('install')
      return '1.0.0'
    })
    startServerMock.mockImplementation(async (options: StartOptions) => {
      order.push('boot')
      return fakeHandle(options)
    })
    await bootReady()
    expect(order).toEqual(['install', 'boot'])
  })

  it('installs nothing when everything the config declares is present', async () => {
    configResult = { configured: true, config: { ...STORED, plugins: [{ spec: 'a', version: '1.0.0' }] } }
    pluginStatusMock.mockImplementation(() => ({ kind: 'ready', package: 'a', entryPath: '/a/i.js', probeDirectory: '/a', packageDir: '/a' }))
    await bootReady()
    expect(installPluginMock).not.toHaveBeenCalled()
  })

  it('still boots when repair fails, with whatever did install', async () => {
    configResult = { configured: true, config: { ...STORED, plugins: [{ spec: 'a@1.0.0' }] } }
    pluginStatusMock.mockImplementation(() => ({ kind: 'unavailable', package: 'a', reason: 'not installed yet' }))
    installPluginMock.mockImplementation(async () => {
      throw new Error('registry unreachable')
    })
    const child = await bootReady()
    expect(child).toBeDefined()
  })
})
```

Adapt `installPluginMock`, `startServerMock`, and `fakeHandle` to the names those mocks actually carry in that file; preserve each test's intent, not its spelling. If `installPlugin` is not yet mocked there, add it to the existing `vi.mock` factory in the same change that uses it — otherwise every test in the file fails at import, and the cause looks unrelated.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/index.spec.ts -t "startup healthcheck"`
Expected: FAIL — nothing installs before boot.

- [ ] **Step 3: Run the phases in `whenReady`**

In `index.ts`, between `ensureDefaultPlugins(DSH_HOME)` and the first boot: show the startup page in the window, run `runHealthcheck` over the stored config, push the findings, and when `repairablePlugins` is non-empty push the `repairing` phase and run `repairPlugins`, streaming each line through `pushProgress`. Push `starting`, then boot as today; the harness URL replaces the page.

A `blocked` finding, or a repair with failures, pushes `failed` instead of booting — the page then offers Open Settings, which calls the existing `showSettings()`, and Continue Anyway, which proceeds to `bootNow()` exactly as today.

`quitting` is re-checked after the repair await and before the boot.

- [ ] **Step 4: Reinstate the default**

In `plugin-defaults.ts`, restore:

```ts
export const DEFAULT_PLUGIN_SPECS: readonly string[] = [PROJECT_MCP_BRIDGE]
```

and update its JSDoc: the set is no longer empty because startup now installs what the config declares. Update `plugin-defaults.spec.ts`'s "adds nothing while the default set is empty" case to assert the bridge is added instead, and `plugin-entries.spec.ts`'s default-set assertion accordingly.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run`
Expected: PASS, all suites.

- [ ] **Step 6: Verify in the packaged app**

```bash
npm run pack
```

Launch with a fresh `$DSH_HOME` containing a `desktop.json` that declares a plugin which is not installed. Expected: the window shows the startup page, reports the plugin as repairable, streams `npm install` output, then loads the harness URL — and `~/.dsh/runtimes` afterwards contains the package. Confirm the Plugins tab shows it installed, with no red row.

- [ ] **Step 7: Commit**

```bash
npx tsc --noEmit -p tsconfig.json
git add -A
git commit -m "feat(startup): repair before boot, and ship the per-project MCP bridge again"
```

---

### Task 5: Update checks, and documentation

**Files:**
- Modify: `src/main/index.ts`, `README.md`, `docs/decisions.md`, `CHANGELOG.md`
- Create: `docs/notes/startup.md`

- [ ] **Step 1: Move update checks off the Settings window**

After the harness boots, run the existing `checkManagedUpdate` for the harness source and for each unpinned plugin, and surface the result through the tray note rather than blocking anything. Settings keeps its own check — it is the surface that acts on one — but a user who never opens Settings is now told an update exists.

- [ ] **Step 2: Write the note**

`docs/notes/startup.md`: why declared and installed could diverge; why repair happens before boot rather than behind it; why an absent shell-PATH cache is `ok` and not a finding; why findings carry their repair action; and that the surface is Electron because it is the recovery path when the harness cannot start.

- [ ] **Step 3: Record the decisions**

Add to `docs/decisions.md` under `## Startup healthcheck (2026-08-26)`, one bullet each with its cost-if-wrong: repair-before-boot over repair-behind-boot; findings as data with severity rather than prose; the shell-PATH cache being `ok`; reusing `installPlugin` rather than adding an install path; and reinstating the default only once repair exists.

- [ ] **Step 4: Update the README and changelog**

README: a short Startup section describing what the screen does and that a first launch after adding a plugin waits on the install. CHANGELOG under `[Unreleased]` → `### Added`, folding in the reinstated default so there is one entry, not two.

- [ ] **Step 5: Full verification and commit**

```bash
npx tsc --noEmit -p tsconfig.json
npx vitest run
npm run pack && npm run test:smoke
git add -A
git commit -m "docs: startup healthcheck, repair, and update checks"
```
