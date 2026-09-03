import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConfigResult, DesktopConfig } from './config'
import type { OpenConfigFileResult } from './open-config-file'
import type { PluginStatus } from './plugin-entries'
import type { StartOptions } from './server'

/** The stored config used by tests that need a configured first run. */
const STORED: DesktopConfig = {
  harness: { kind: 'local', repo: '/tmp/harness' },
  notifyPort: 44444,
  hotkey: 'CommandOrControl+Shift+D',
}

/** The same, with a managed harness — the only kind an update check applies to. */
const MANAGED_STORED: DesktopConfig = {
  harness: { kind: 'managed', package: '@deepseek-ai/dsh', version: '0.1.0', workspace: '/tmp/ws' },
  notifyPort: 44444,
  hotkey: 'CommandOrControl+Shift+D',
}

/**
 * Orchestration tests for the main entry point.
 *
 * `index.ts` owns the app's mutable cross-cutting state — the current child,
 * its generation, the lifecycle chain, and the quit flag — so it is driven here
 * through a faked `electron` module: the fake records the handlers the module
 * registers and lets a test fire them in the orders the real app can produce.
 */

const fake = vi.hoisted(() => {
  type Handler = (...args: unknown[]) => unknown

  const handlers = new Map<string, Handler[]>()
  const windowHandlers = new Map<string, Handler[]>()
  let readyResolve: () => void = () => {}
  let whenReady: Promise<void> = new Promise<void>((resolve) => {
    readyResolve = resolve
  })

  /** Arm a fresh whenReady, so a later test does not inherit an already-ready app. */
  function resetReady(): void {
    whenReady = new Promise<void>((resolve) => {
      readyResolve = resolve
    })
  }

  const window = {
    isDestroyed: vi.fn(() => false),
    isVisible: vi.fn(() => true),
    isFocused: vi.fn(() => true),
    isMinimized: vi.fn(() => false),
    show: vi.fn(),
    hide: vi.fn(),
    focus: vi.fn(),
    restore: vi.fn(),
    loadURL: vi.fn(),
    getContentSize: vi.fn(() => [1280, 860]),
    on: vi.fn((name: string, handler: Handler) => {
      windowHandlers.set(name, [...(windowHandlers.get(name) ?? []), handler])
      return window
    }),
    // The window's own page is told the theme and where its dividers go.
    webContents: { send: vi.fn() },
  }

  // The window's two views. Only what index.ts touches: it loads the harness
  // URL and the error pane into one, and closes the splash when either
  // finishes loading.
  const harness = {
    webContents: {
      on: vi.fn((name: string, handler: Handler) => {
        windowHandlers.set(`harness:${name}`, [...(windowHandlers.get(`harness:${name}`) ?? []), handler])
      }),
      loadURL: vi.fn(),
    },
  }
  const pane = { getBounds: vi.fn(() => ({ x: 0, y: 0, width: 520, height: 860 })), webContents: { send: vi.fn() } }
  const files = {
    getBounds: vi.fn(() => ({ x: 0, y: 0, width: 220, height: 860 })),
    // `index.ts` tells the tree which project to show.
    webContents: { send: vi.fn() },
  }
  // The git panel: `index.ts` tells it when to read itself again.
  const git = {
    getBounds: vi.fn(() => ({ x: 0, y: 0, width: 220, height: 860 })),
    webContents: { send: vi.fn() },
  }
  // The terminal panel: `index.ts` pushes it the theme and the shell's output.
  const terminal = {
    getBounds: vi.fn(() => ({ x: 0, y: 620, width: 740, height: 240 })),
    webContents: {
      send: vi.fn(),
      isLoading: vi.fn(() => false),
      once: vi.fn((name: string, handler: Handler) => {
        windowHandlers.set(`terminal:${name}`, [...(windowHandlers.get(`terminal:${name}`) ?? []), handler])
      }),
    },
  }
  // The browser: `index.ts` drives its navigation and listens for where it
  // ends up.
  const web = {
    getBounds: vi.fn(() => ({ x: 0, y: 0, width: 520, height: 860 })),
    webContents: {
      on: vi.fn((name: string, handler: Handler) => {
        windowHandlers.set(`web:${name}`, [...(windowHandlers.get(`web:${name}`) ?? []), handler])
      }),
      loadURL: vi.fn(),
      reload: vi.fn(),
      getURL: vi.fn(() => 'https://example.com/'),
      navigationHistory: {
        canGoBack: vi.fn(() => false),
        canGoForward: vi.fn(() => false),
        goBack: vi.fn(),
        goForward: vi.fn(),
      },
    },
  }
  const views = { window, harness, pane, files, git, terminal, web }

  const app = {
    requestSingleInstanceLock: vi.fn(() => true),
    setAsDefaultProtocolClient: vi.fn(),
    getPath: vi.fn(() => '/tmp/dsh-desktop-test-userdata'),
    whenReady: vi.fn(() => whenReady),
    on: vi.fn((name: string, handler: Handler) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler])
      return app
    }),
    quit: vi.fn(() => {
      // The real app.quit() emits before-quit, and a handler that calls
      // preventDefault cancels the quit until it calls quit() again.
      void emit('before-quit', quitEvent())
    }),
  }

  const globalShortcut = {
    register: vi.fn(() => true),
    unregisterAll: vi.fn(),
  }

  const shell = {
    openPath: vi.fn(async () => ''),
  }

  /**
   * The confirmation the two destructive git writes raise, and the tree's
   * Delete. Answers with the default button — Cancel — so a test that forgets
   * to say otherwise never silently discards anything.
   */
  const showMessageBox = vi.fn(async () => ({ response: 1 }))

  function quitEvent(): { preventDefault: () => void; prevented: boolean } {
    const event = {
      prevented: false,
      preventDefault: () => {
        event.prevented = true
      },
    }
    quitEvents.push(event)
    return event
  }

  const quitEvents: Array<{ preventDefault: () => void; prevented: boolean }> = []

  // `index.ts` registers the window's own channels here: the divider's
  // send-only ones and the pane's reads. `settings-window.ts` owns its own
  // and is mocked.
  // Only what `index.ts` reads and subscribes to: whether the machine is dark,
  // and a change to that.
  const nativeTheme = { shouldUseDarkColors: false, on: vi.fn() }

  const ipcHandlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const ipcMain = {
    on: vi.fn((channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, handler)
    }),
    handle: vi.fn((channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, handler)
    }),
  }

  function emit(name: string, ...args: unknown[]): Promise<unknown[]> {
    return Promise.all((handlers.get(name) ?? []).map((handler) => handler(...args)))
  }

  function emitWindow(name: string, ...args: unknown[]): Promise<unknown[]> {
    return Promise.all((windowHandlers.get(name) ?? []).map((handler) => handler(...args)))
  }

  return {
    app,
    window,
    views,
    harness,
    terminal,
    web,
    ipcMain,
    nativeTheme,
    /**
     * Invoke one of the divider's channels, as the window page would.
     * @param channel - the channel name.
     * @param args - the payload.
     */
    sendIpc: (channel: string, ...args: unknown[]) => ipcHandlers.get(channel)?.({}, ...args),
    globalShortcut,
    shell,
    showMessageBox,
    handlers,
    windowHandlers,
    quitEvents,
    emit,
    emitWindow,
    quitEvent,
    resetReady,
    ready: () => readyResolve(),
  }
})

vi.mock('electron', () => ({
  app: fake.app,
  BrowserWindow: class {},
  globalShortcut: fake.globalShortcut,
  shell: fake.shell,
  dialog: { showOpenDialog: vi.fn(), showMessageBox: fake.showMessageBox },
  ipcMain: fake.ipcMain,
  nativeTheme: fake.nativeTheme,
  Notification: class {
    show(): void {}
  },
}))

const createWindow = vi.fn(() => fake.views)
const applyLayout = vi.fn()
const installMenuMock = vi.fn()
const showError = vi.fn()
vi.mock('./window', () => ({
  createWindow: (...args: unknown[]) => createWindow(...(args as [])),
  showError: (...args: unknown[]) => showError(...(args as [])),
  applyLayout: (...args: unknown[]) => applyLayout(...(args as [])),
  registerPaneScheme: vi.fn(),
  servePane: vi.fn(),
  PANE_ORIGIN: 'app://pane',
  DEFAULT_EDITOR_WIDTH: 520,
  DEFAULT_FILES_WIDTH: 220,
  DEFAULT_TERMINAL_HEIGHT: 240,
  DEFAULT_TERMINAL_WIDTH: 720,
  installMenu: (...args: unknown[]) => installMenuMock(...(args as [])),
}))

const updateCheckerMock = vi.fn(async (_pkg: string, _installed: string): Promise<string | undefined> => undefined)
const setTrayStatus = vi.fn()
const setTrayUpdate = vi.fn()
let trayActions:
  | { toggleWindow(): void; restart(): void; quit(): void; openSettings(): void }
  | undefined
vi.mock('./tray', () => ({
  createTray: (actions: {
    toggleWindow(): void
    restart(): void
    quit(): void
    openSettings(): void
  }) => {
    trayActions = actions
    return { setStatus: setTrayStatus, setUpdate: setTrayUpdate, destroy: vi.fn() }
  },
}))

const notifyCloseMock = vi.fn(async () => {})
const startNotifyListenerMock = vi.fn(async () => ({ port: 1, close: notifyCloseMock }))
vi.mock('./notify', () => ({
  startNotifyListener: (...args: unknown[]) => startNotifyListenerMock(...(args as [])),
  portIsFree: vi.fn(async () => true),
}))

/** Mutated by settings tests to switch between first-run and configured states. */
let configResult: ConfigResult = { configured: true, config: STORED }
const loadConfigMock = vi.fn((): ConfigResult => configResult)
const writeConfigMock = vi.fn()
vi.mock('./config', () => ({
  loadConfig: (...args: unknown[]) => loadConfigMock(...(args as [])),
  writeConfig: (...args: unknown[]) => writeConfigMock(...(args as [])),
  DEFAULT_VIEW_TOOLS_PORT: 43118,
}))

/** `createSettingsHandlers` has its own tests; here it only needs to exist. */
/**
 * The deps object `index.ts` builds once at module scope and hands to
 * `createSettingsHandlers`. Captured so tests can call `disabledPlugins()`
 * directly — the exact function a Settings window's `read()` would call,
 * whether that window is open at boot time or opened long afterwards — to
 * verify what a boot recorded without needing the real `settings-ipc`
 * plumbing, which has its own tests for turning this into `PluginInfo.disabledReason`.
 */
let capturedSettingsDeps:
  | {
      disabledPlugins(): Record<string, string>
      clientLinkWarnings(): Record<string, string>
      openConfigFile(): Promise<OpenConfigFileResult>
    }
  | undefined
vi.mock('./settings-ipc', () => ({
  createSettingsHandlers: vi.fn(
    (deps: {
      disabledPlugins(): Record<string, string>
      clientLinkWarnings(): Record<string, string>
      openConfigFile(): Promise<OpenConfigFileResult>
    }) => {
      capturedSettingsDeps = deps
      return { read: vi.fn(), pickFolder: vi.fn(), save: vi.fn() }
    },
  ),
}))

/** Captures the `onClosed` callback so tests can fire it via `closeSettings()`. */
let settingsOnClosed: (() => void) | undefined
const openSettingsMock = vi.fn((_handlers: unknown, onClosed: () => void) => {
  settingsOnClosed = onClosed
})
vi.mock('./settings-window', () => ({
  openSettings: (...args: unknown[]) => openSettingsMock(...(args as [unknown, () => void])),
  // The settings window is told the theme like every other page of this
  // app's; no window is open in these tests.
  settingsContents: () => undefined,
}))

/** Invoke the settings window's close callback, as the real window does on `closed`. */
function closeSettings(): void {
  settingsOnClosed?.()
}

/** The install runner `index.ts` owns; tests assert the quit path reaches it. */
const installStopAll = vi.fn(async () => {})
const installRun = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }))
vi.mock('./install-process', () => ({
  createInstallRunner: () => ({ run: installRun, stopAll: installStopAll }),
}))

/**
 * Installs the startup repair phase performs, as
 * `[package, version]`. `managed-install` is mocked rather than left real
 * because the real installer spawns `npm`; the runner beneath it is already
 * mocked, but the resolve-then-install logic is not this file's subject.
 */
const managedInstallMock = vi.fn(async (_pkg: string, _version: string, _onLine: (line: string) => void) => '1.0.0')
vi.mock('./managed-install', () => ({
  createManagedInstaller:
    () =>
    (pkg: string, version: string, onLine: (line: string) => void) =>
      managedInstallMock(pkg, version, onLine),
  createUpdateChecker: () => (pkg: string, installed: string) => updateCheckerMock(pkg, installed),
}))

/**
 * The startup surface, mocked: it registers `ipcMain` handlers and loads a
 * file, neither of which exists under the electron fake. Without this the
 * phases degrade to a silent boot — which is the designed failure, and would
 * make every assertion below vacuous.
 */
const showStartupMock = vi.fn(async () => {})
const pushPhaseMock = vi.fn()
vi.mock('./startup-window', () => ({
  showStartup: (...args: unknown[]) => showStartupMock(...(args as [])),
  pushFindings: vi.fn(),
  pushPhase: (...args: unknown[]) => pushPhaseMock(...(args as [])),
  pushProgress: vi.fn(),
  closeStartup: vi.fn(),
}))

// The real one binds a loopback port; `view-mcp.spec.ts` covers it against a
// real server. Here it only has to resolve, or the awaited boot never runs.
const serveViewToolsMock = vi.fn(async () => ({ port: 43118, close: async () => {} }))
vi.mock('./view-mcp', () => ({
  serveViewTools: (...args: unknown[]) => serveViewToolsMock(...(args as [])),
  SURFACES: {
    browser: { name: 'app_browser', path: '/browser' },
    editor: { name: 'app_editor', path: '/editor' },
  },
}))

const harnessThemeMock = vi.fn((): string => 'system')
vi.mock('./harness-theme', () => ({
  harnessTheme: (...args: unknown[]) => harnessThemeMock(...(args as [])),
  settingsPath: (home: string) => `${home}/settings.yaml`,
}))

const readWorkspacesMock = vi.fn((): unknown[] => [])
vi.mock('./workspaces', () => ({
  readWorkspaces: (...args: unknown[]) => readWorkspacesMock(...(args as [])),
  workspacesPath: (home: string) => `${home}/storages/workspace.json`,
}))

const readDirectoryMock = vi.fn(() => [] as unknown[])
vi.mock('./file-tree', () => ({ readDirectory: (...args: unknown[]) => readDirectoryMock(...(args as [])) }))

/** The panel's read, so a test can hold one open and watch what a second does. */
const readProjectMock = vi.fn(async (root: string) => ({ ok: true as const, repos: [{ path: root }] }))
// Partial: `refuseUnlessInProject` is the gate every write channel is checked
// by, and a suite that stubbed it would prove nothing about the channels it
// exists to protect. Only the read — which would spawn git — is replaced.
vi.mock('./git-model', async () => ({
  ...(await vi.importActual<typeof import('./git-model')>('./git-model')),
  readProject: (...args: unknown[]) => readProjectMock(...(args as [string])),
}))
const hasGitMock = vi.fn(async () => true)
// No repositories by default: this suite's project roots do not exist on disk,
// so nothing is watched. A test that needs a repository the gate will accept
// sets this to a real temporary directory.
const findReposMock = vi.fn((): string[] => [])
vi.mock('./git-find', () => ({
  hasGit: () => hasGitMock(),
  findRepos: (...args: unknown[]) => findReposMock(...(args as [string])),
}))

// The write half. Mocked so no git child is spawned and so a test can read
// back exactly which arguments a channel passed on — the `add`/`keep` split
// and the `--track` flag are the two places where a wrong argument is a bug
// nothing else would catch.
const stageMock = vi.fn(async (): Promise<unknown> => ({ ok: true }))
const unstageMock = vi.fn(async (): Promise<unknown> => ({ ok: true }))
const discardMock = vi.fn(async (): Promise<unknown> => ({ ok: true }))
const commitMock = vi.fn(async (): Promise<unknown> => ({ ok: true }))
vi.mock('./git-actions', () => ({
  stage: (...args: unknown[]) => stageMock(...(args as [])),
  unstage: (...args: unknown[]) => unstageMock(...(args as [])),
  discard: (...args: unknown[]) => discardMock(...(args as [])),
  commit: (...args: unknown[]) => commitMock(...(args as [])),
}))
const checkoutMock = vi.fn(async (): Promise<unknown> => ({ ok: true }))
const createBranchMock = vi.fn(async (): Promise<unknown> => ({ ok: true }))
vi.mock('./git-branch', () => ({
  checkout: (...args: unknown[]) => checkoutMock(...(args as [])),
  createBranch: (...args: unknown[]) => createBranchMock(...(args as [])),
  listBranches: vi.fn(async () => []),
}))
const pushStashMock = vi.fn(async (): Promise<unknown> => ({ ok: true }))
const applyStashMock = vi.fn(async (): Promise<unknown> => ({ ok: true }))
const dropStashMock = vi.fn(async (): Promise<unknown> => ({ ok: true }))
vi.mock('./git-stash', () => ({
  pushStash: (...args: unknown[]) => pushStashMock(...(args as [])),
  applyStash: (...args: unknown[]) => applyStashMock(...(args as [])),
  dropStash: (...args: unknown[]) => dropStashMock(...(args as [])),
  listStashes: vi.fn(async () => []),
}))

const preflightMock = vi.fn(() => ({ ok: true }))
vi.mock('./preflight', () => ({ preflight: (...args: unknown[]) => preflightMock(...(args as [])) }))

/**
 * A fixture-only mirror of `runtime-files.ts`'s `insertId`: collapses every
 * character outside `[a-zA-Z0-9]` to `-`. Kept local (not imported) so this
 * file's mocks stay independent of the module under test's internals; only
 * the sanitizing rule, not the function itself, needs to match.
 */
function sanitizedId(pkg: string): string {
  return pkg.replaceAll(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

/**
 * Derives `ready`/`omitted` from the `statuses` `bootNow` actually passed in
 * for this attempt, so an isolation retry's exclusion (which drops entries
 * before `pluginStatus` is even called) is reflected the same way the real
 * `writeRuntimeFiles` would reflect it, instead of a canned return value that
 * can't tell one attempt's surviving entries from another's. `ready` rows
 * default to `status.entryPath` as their overlay `name` — the same fallback
 * `writeRuntimeFiles`'s own default `resolveName` uses — since this default
 * mock implementation is never given a `resolveName` of its own.
 */
const writeRuntimeFilesMock = vi.fn((_directory: string, _port: number, statuses: PluginStatus[] = []) => ({
  patchPath: '/tmp/p.yml',
  hooksPath: '/tmp/h.json',
  omitted: statuses.filter((s): s is Extract<PluginStatus, { kind: 'unavailable' }> => s.kind === 'unavailable').map((s) => ({ package: s.package, reason: s.reason })),
  ready: statuses
    .filter((s): s is Extract<PluginStatus, { kind: 'ready' }> => s.kind === 'ready')
    .map((s) => ({ package: s.package, id: sanitizedId(s.package), name: s.entryPath })),
}))
vi.mock('./runtime-files', async () => {
  const actual = await vi.importActual<typeof import('./runtime-files')>('./runtime-files')
  return {
    attributeBootFailure: actual.attributeBootFailure,
    writeRuntimeFiles: (...args: unknown[]) => writeRuntimeFilesMock(...(args as [string, number, PluginStatus[]])),
    runtimeFilePaths: (directory: string) => ({ patchPath: `${directory}/desktop.patch.yml`, hooksPath: `${directory}/hooks.json` }),
  }
})

/** Controlled by tests that assert what `bootNow` derives for each configured plugin entry. */
const pluginStatusMock = vi.fn(() => ({ kind: 'unavailable', package: '@deepseek-ai/dsh-hooks-claude-code', reason: 'not installed yet' }))
/** Controlled by tests exercising `resolveName`'s client-half-warning path. */
const declaresClientHalfMock = vi.fn(() => false)
const presetsDeclarationMock = vi.fn((): string | undefined => undefined)
vi.mock('./plugin-entries', () => ({
  pluginStatus: (...args: unknown[]) => pluginStatusMock(...(args as [])),
  pluginInstallMarker: vi.fn(),
  parseSpec: (spec: string) => {
    const at = spec.indexOf('@', spec.startsWith('@') ? 1 : 0)
    return at === -1 ? { package: spec } : { package: spec.slice(0, at), pinnedVersion: spec.slice(at + 1) }
  },
  HOOKS_PACKAGE: '@deepseek-ai/dsh-hooks-claude-code',
  declaresClientHalf: (...args: unknown[]) => declaresClientHalfMock(...(args as [string])),
  presetsDeclaration: (...args: unknown[]) => presetsDeclarationMock(...(args as [string])),
}))

/** Controlled by tests exercising `resolveName`'s link-failure path. */
const ensurePluginLinkMock = vi.fn(() => ({ linked: true }) as { linked: true } | { linked: false; reason: string })
vi.mock('./plugin-link', () => ({
  ensurePluginLink: (...args: unknown[]) => ensurePluginLinkMock(...(args as [])),
  reconcilePluginLinks: vi.fn(),
}))

vi.mock('./plugin-presets', () => ({
  ensurePluginPresets: vi.fn(() => []),
  reconcilePluginPresets: vi.fn(),
}))

/** One spawned harness child, controlled by the test. */
interface FakeChild {
  options: StartOptions
  stop: ReturnType<typeof vi.fn>
  /** Resolve `startServer` as if the ready line had arrived. */
  ready(url?: string): void
  /** Reject `startServer` as if the child had failed to become ready. */
  failToStart(message: string): void
  /** Fire the post-readiness exit callback this child was given. */
  exit(code: number, tail: string): void
  /** Release a stop that was made to hang; only for children stopped with `hangStop`. */
  releaseStop(): void
}

const children: FakeChild[] = []
const startServer = vi.fn()
const dshWebCommandMock = vi.fn(() => ({ command: 'pnpm', args: [], cwd: '/tmp/harness' }))
vi.mock('./server', () => ({
  startServer: (options: StartOptions) => startServer(options),
  dshWebCommand: (...args: unknown[]) => dshWebCommandMock(...(args as [])),
  resolveBinary: vi.fn((configured: string | undefined, name: string) => configured ?? name),
  stopGroup: vi.fn(async () => {}),
}))

/** Whether the next spawned child's `stop()` hangs until `releaseStop()`. */
let hangStop = false

function installStartServer(): void {
  startServer.mockImplementation(
    (options: StartOptions) =>
      new Promise((resolve, reject) => {
        let release: () => void = () => {}
        const hanging = hangStop
        let settled = false
        // A stop before readiness kills the child, and the real startServer
        // rejects on that exit rather than waiting out its readiness timeout.
        const finishStop = (done: () => void): void => {
          if (!settled) {
            settled = true
            reject(new Error('dsh-desktop: the harness exited with code null before starting.'))
          }
          done()
        }
        const stop = vi.fn(
          () =>
            new Promise<void>((done) => {
              if (!hanging) {
                finishStop(done)
                return
              }
              release = () => finishStop(done)
            }),
        )
        options.onSpawned?.(stop)
        children.push({
          options,
          stop,
          ready: (url = 'http://127.0.0.1:5000') => {
            settled = true
            resolve({ url, stop })
          },
          failToStart: (message) => {
            settled = true
            reject(new Error(message))
          },
          exit: (code, tail) => options.onExit?.(code, tail),
          releaseStop: () => release(),
        })
      }),
  )
}

/** The freshly imported entry point's exports, captured by `loadIndex`. */
let indexModule: typeof import('./index') | undefined

/** Import the entry point fresh, so its module state starts clean. */
async function loadIndex(): Promise<void> {
  indexModule = await import('./index')
}

/** `applySettings` from the currently loaded module instance. */
function applySettings(previous: DesktopConfig | undefined, next: DesktopConfig): Promise<string[]> {
  if (indexModule === undefined) throw new Error('loadIndex() must run before applySettings()')
  return indexModule.applySettings(previous, next)
}

/** Let queued microtasks and the lifecycle chain settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve()
}

/** Drive the app to a booted, ready harness. */
async function bootReady(): Promise<FakeChild> {
  await loadIndex()
  fake.ready()
  await vi.waitFor(() => expect(children.length).toBe(1))
  children[0].ready()
  await settle()
  // The harness URL loading in the window is what the real app reports here,
  // and what closes the splash and un-gates `revealWindow`.
  await fake.emitWindow('harness:did-finish-load')
  await settle()
  return children[0]
}

/** Drive the app through `whenReady`, for cases (first run) where no child boots. */
async function readyHandler(): Promise<void> {
  await loadIndex()
  fake.ready()
  await settle()
}

// `index.ts` resolves DSH_HOME at module load, and its whenReady handler
// writes there — a migration, a shell-path cache. Without a home of its own
// every test in this file operates on the developer's real ~/.dsh, which is
// exactly what happened: a test run migrated a live config and left a cache
// file behind. Set for EVERY test, not per-suite, so a case added later
// cannot reintroduce it by forgetting.
let realDshHome: string | undefined

beforeEach(() => {
  realDshHome = process.env.DSH_HOME
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-index-home-'))
  vi.resetModules()
  children.length = 0
  fake.handlers.clear()
  fake.windowHandlers.clear()
  fake.quitEvents.length = 0
  trayActions = undefined
  hangStop = false
  configResult = { configured: true, config: STORED }
  // clearAllMocks leaves implementations in place, so a test that made the
  // config unreadable would otherwise leak that into the next one.
  // `vi.clearAllMocks()` clears calls but not a `mockReturnValue`, so a test
  // that stubs preflight would otherwise stub it for every test after it.
  preflightMock.mockReturnValue({ ok: true })
  loadConfigMock.mockImplementation(() => configResult)
  startNotifyListenerMock.mockImplementation(async () => ({ port: 1, close: notifyCloseMock }))
  writeRuntimeFilesMock.mockImplementation((_directory: string, _port: number, statuses: PluginStatus[] = []) => ({
    patchPath: '/tmp/p.yml',
    hooksPath: '/tmp/h.json',
    omitted: statuses.filter((s): s is Extract<PluginStatus, { kind: 'unavailable' }> => s.kind === 'unavailable').map((s) => ({ package: s.package, reason: s.reason })),
    ready: statuses
      .filter((s): s is Extract<PluginStatus, { kind: 'ready' }> => s.kind === 'ready')
      .map((s) => ({ package: s.package, id: sanitizedId(s.package), name: s.entryPath })),
  }))
  capturedSettingsDeps = undefined
  pluginStatusMock.mockImplementation(() => ({
    kind: 'unavailable',
    package: '@deepseek-ai/dsh-hooks-claude-code',
    reason: 'not installed yet',
  }))
  installStopAll.mockImplementation(async () => {})
  managedInstallMock.mockImplementation(async () => '1.0.0')
  showStartupMock.mockImplementation(async () => {})
  settingsOnClosed = undefined
  declaresClientHalfMock.mockImplementation(() => false)
  presetsDeclarationMock.mockImplementation(() => undefined)
  ensurePluginLinkMock.mockImplementation(() => ({ linked: true }))
  vi.clearAllMocks()
  // The git write half, back to its defaults: no repositories discovered, a
  // confirmation answered with Cancel, and every action reporting success. A
  // test that changes any of these must not change it for the next one.
  findReposMock.mockReturnValue([])
  fake.showMessageBox.mockResolvedValue({ response: 1 })
  for (const mock of [stageMock, unstageMock, discardMock, commitMock, checkoutMock, createBranchMock, pushStashMock, applyStashMock, dropStashMock]) {
    mock.mockResolvedValue({ ok: true })
  }
  fake.resetReady()
  fake.app.requestSingleInstanceLock.mockReturnValue(true)
  fake.app.getPath.mockReturnValue('/tmp/dsh-desktop-test-userdata')
  fake.globalShortcut.register.mockReturnValue(true)
  fake.window.isDestroyed.mockReturnValue(false)
  installStartServer()
})

afterEach(() => {
  if (realDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = realDshHome
})

describe('boot', () => {
  it('loads the harness URL once the child reports ready, marking no plugin disabled', async () => {
    const child = await bootReady()
    expect(child.options.timeoutMs).toBeGreaterThan(0)
    expect(fake.harness.webContents.loadURL).toHaveBeenCalledWith('http://127.0.0.1:5000')
    expect(setTrayStatus).toHaveBeenLastCalledWith('running')
    // A healthy boot marks nothing disabled — the map a later-opened Settings
    // window would read is empty, not merely unset.
    expect(capturedSettingsDeps?.disabledPlugins()).toEqual({})
  })

  it('derives a plugin status per configured entry, and passes them straight to writeRuntimeFiles', async () => {
    configResult = {
      configured: true,
      config: { ...STORED, plugins: [{ spec: '@deepseek-ai/dsh-hooks-claude-code', version: '0.1.1-rc.2' }] },
    }
    pluginStatusMock.mockImplementation(() => ({
      kind: 'ready',
      package: '@deepseek-ai/dsh-hooks-claude-code',
      entryPath: '/tmp/bridge/lib/index.js',
      probeDirectory: '/tmp/bridge',
    }))

    await bootReady()

    expect(pluginStatusMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      { spec: '@deepseek-ai/dsh-hooks-claude-code', version: '0.1.1-rc.2' },
      expect.stringContaining('hooks.json'),
    )
    expect(writeRuntimeFilesMock).toHaveBeenCalledWith(
      expect.any(String),
      STORED.notifyPort,
      [{ kind: 'ready', package: '@deepseek-ai/dsh-hooks-claude-code', entryPath: '/tmp/bridge/lib/index.js', probeDirectory: '/tmp/bridge' }],
      undefined,
      expect.any(Function),
      expect.any(Function),
    )
  })

  it('reports a plugin whose declared browser half could not be linked, rather than silently downgrading it', async () => {
    const DECK = '@onetest/dsh-deck'
    configResult = { configured: true, config: { ...STORED, plugins: [{ spec: DECK, version: '0.2.1' }] } }
    const readyStatus = { kind: 'ready' as const, package: DECK, entryPath: '/tmp/deck/lib/index.js', probeDirectory: '/tmp/deck', packageDir: '/tmp/deck/pkg' }
    pluginStatusMock.mockImplementation(() => readyStatus)
    ensurePluginLinkMock.mockImplementation(() => ({ linked: false, reason: 'could not link: EACCES' }))
    declaresClientHalfMock.mockImplementation(() => true)
    writeRuntimeFilesMock.mockImplementation((_directory: string, _port: number, statuses: PluginStatus[], _probe: unknown, resolveName: (s: unknown) => string) => {
      const name = resolveName(readyStatus)
      return {
        patchPath: '/tmp/p.yml',
        hooksPath: '/tmp/h.json',
        omitted: [],
        ready: [{ package: readyStatus.package, id: sanitizedId(readyStatus.package), name }],
      }
    })

    await bootReady()

    // The plugin is still mounted (no omission), but its browser half is
    // named — on the tray note and, via `clientLinkWarnings`, on its
    // Settings row — instead of vanishing with nothing said about it.
    expect(capturedSettingsDeps?.clientLinkWarnings()).toEqual({ [DECK]: 'could not link: EACCES' })
    expect(setTrayStatus).toHaveBeenLastCalledWith('running', expect.stringContaining(`${DECK} browser UI unavailable`))
  })

  it('falls back quietly when a plugin with no declared browser half fails to link', async () => {
    const DECK = '@onetest/dsh-deck'
    configResult = { configured: true, config: { ...STORED, plugins: [{ spec: DECK, version: '0.2.1' }] } }
    const readyStatus = { kind: 'ready' as const, package: DECK, entryPath: '/tmp/deck/lib/index.js', probeDirectory: '/tmp/deck', packageDir: '/tmp/deck/pkg' }
    pluginStatusMock.mockImplementation(() => readyStatus)
    ensurePluginLinkMock.mockImplementation(() => ({ linked: false, reason: 'could not link: EACCES' }))
    declaresClientHalfMock.mockImplementation(() => false)
    writeRuntimeFilesMock.mockImplementation((_directory: string, _port: number, statuses: PluginStatus[], _probe: unknown, resolveName: (s: unknown) => string) => {
      const name = resolveName(readyStatus)
      return {
        patchPath: '/tmp/p.yml',
        hooksPath: '/tmp/h.json',
        omitted: [],
        ready: [{ package: readyStatus.package, id: sanitizedId(readyStatus.package), name }],
      }
    })

    await bootReady()

    expect(capturedSettingsDeps?.clientLinkWarnings()).toEqual({})
    expect(setTrayStatus).toHaveBeenLastCalledWith('running')
  })

  it('still boots, with the insert omitted, when a plugin is unavailable', async () => {
    configResult = {
      configured: true,
      config: { ...STORED, plugins: [{ spec: '@deepseek-ai/dsh-hooks-claude-code' }] },
    }
    pluginStatusMock.mockImplementation(() => ({
      kind: 'unavailable',
      package: '@deepseek-ai/dsh-hooks-claude-code',
      reason: 'not installed yet',
    }))
    writeRuntimeFilesMock.mockImplementation(() => ({
      patchPath: '/tmp/p.yml',
      hooksPath: '/tmp/h.json',
      omitted: [{ package: '@deepseek-ai/dsh-hooks-claude-code', reason: 'not installed yet' }],
      ready: [],
    }))

    await bootReady()

    expect(fake.harness.webContents.loadURL).toHaveBeenCalledWith('http://127.0.0.1:5000')
    expect(capturedSettingsDeps?.disabledPlugins()).toEqual({ '@deepseek-ai/dsh-hooks-claude-code': 'not installed yet' })
    expect(setTrayStatus).toHaveBeenLastCalledWith(
      'running',
      expect.stringContaining('not installed yet'),
    )
  })

  it('shows the failure pane when the child never becomes ready, without opening settings', async () => {
    await loadIndex()
    fake.ready()
    await vi.waitFor(() => expect(children.length).toBe(1))
    children[0].failToStart('no URL')
    await settle()
    expect(children[0].stop).toHaveBeenCalled()
    expect(showError).toHaveBeenCalledWith(fake.views, 'The harness failed to start', expect.stringContaining('no URL'))
    // A correctly configured harness that simply never became ready is not a
    // configuration mistake: reopening Settings here would be noise over a
    // problem it cannot fix.
    expect(openSettingsMock).not.toHaveBeenCalled()
  })

  it("reports the live child's exit in the window, without opening settings", async () => {
    const child = await bootReady()
    child.exit(9, 'stderr tail')
    await settle()
    expect(showError).toHaveBeenCalledWith(fake.views, 'The harness exited (code 9)', 'stderr tail')
    expect(setTrayStatus).toHaveBeenLastCalledWith('failed')
    expect(openSettingsMock).not.toHaveBeenCalled()
  })
})

describe('configuration-class boot failures', () => {
  it('opens settings when the checkout preflight fails', async () => {
    // Not `Once`: the startup healthcheck reports the harness state before
    // the boot checks it, so preflight is legitimately called twice per
    // launch and a one-shot stub would be consumed by the first.
    preflightMock.mockReturnValue({ ok: false, message: 'checkout missing' })
    await readyHandler()
    expect(showError).toHaveBeenCalledWith(fake.views, 'The harness checkout is not ready', 'checkout missing')
    expect(openSettingsMock).toHaveBeenCalled()
    expect(startServer).not.toHaveBeenCalled()
  })

  it('opens settings when the launcher cannot be resolved', async () => {
    // `vi.resetModules()` (in `beforeEach`) means `loadIndex()` below re-imports
    // `./configuration-error` as a fresh module instance; importing it here
    // first, before `loadIndex()`, warms that same cache entry so the class
    // thrown here is `instanceof`-identical to the one `index.ts` checks
    // against.
    const { ConfigurationError: FreshConfigurationError } = await import('./configuration-error')
    // Mirrors what `dshWebCommand` throws when `resolveBinary` fails: a
    // ConfigurationError, not a startServer rejection.
    dshWebCommandMock.mockImplementationOnce(() => {
      throw new FreshConfigurationError('dsh-desktop: npm is not on PATH')
    })
    await readyHandler()
    expect(showError).toHaveBeenCalledWith(
      fake.views,
      'The harness failed to start',
      expect.stringContaining('npm is not on PATH'),
    )
    expect(openSettingsMock).toHaveBeenCalled()
    expect(startServer).not.toHaveBeenCalled()
  })
})

describe('plugin-caused boot failures', () => {
  const DECK = '@onetest/dsh-deck'
  const DECK_ENTRY = '/tmp/deck/lib/index.js'
  const OTHER = '@onetest/dsh-other'
  const OTHER_ENTRY = '/tmp/other/lib/index.js'

  /** The real harness's own wording: names the failing insert id and, in parens, its resolved entry path. */
  function deckFailure(): string {
    return `failed to apply loader entry onetest-dsh-deck (${DECK_ENTRY}): invalid config: - base must be a non-empty string starting with "/", received undefined (at base)`
  }

  /** Configure one entry that resolves to a ready overlay insert. */
  function configureOneReadyPlugin(): void {
    configResult = {
      configured: true,
      config: { ...STORED, plugins: [{ spec: DECK, version: '0.2.1' }] },
    }
    pluginStatusMock.mockImplementation(() => ({ kind: 'ready', package: DECK, entryPath: DECK_ENTRY, probeDirectory: '/tmp/deck' }))
    // The default `writeRuntimeFilesMock` derives `ready`/`omitted` from
    // whatever `statuses` this attempt actually resolved, so the one
    // configured entry counts as inserted (`insertedCount` = 1) on the
    // primary boot and drops out once excluded on a retry.
  }

  /** Configure two entries that both resolve to ready overlay inserts. */
  function configureTwoReadyPlugins(): void {
    configResult = {
      configured: true,
      config: { ...STORED, plugins: [{ spec: DECK, version: '0.2.1' }, { spec: OTHER, version: '1.0.0' }] },
    }
    pluginStatusMock.mockImplementation((_deps: unknown, _home: string, entry: { spec: string }) => {
      const isDeck = entry.spec.startsWith(DECK)
      return {
        kind: 'ready',
        package: isDeck ? DECK : OTHER,
        entryPath: isDeck ? DECK_ENTRY : OTHER_ENTRY,
        probeDirectory: isDeck ? '/tmp/deck' : '/tmp/other',
      }
    })
  }

  it('attributes a failure naming one plugin and retries with only that plugin dropped, the other still inserted', async () => {
    configureTwoReadyPlugins()

    await loadIndex()
    fake.ready()
    await vi.waitFor(() => expect(children.length).toBe(1))
    children[0].failToStart(deckFailure())
    await vi.waitFor(() => expect(children.length).toBe(2))
    children[1].ready('http://127.0.0.1:6000')
    await settle()

    expect(startServer).toHaveBeenCalledTimes(2)
    // Only the culprit is excluded: the retry's own `pluginStatus` calls
    // still cover both configured entries (exclusion happens in the `entry`
    // filter before `pluginStatus`), but `writeRuntimeFilesMock` derives its
    // `ready` list from what actually reached it — proving the survivor's
    // status was still resolved and passed through.
    expect(writeRuntimeFilesMock).toHaveBeenLastCalledWith(
      expect.any(String),
      STORED.notifyPort,
      expect.arrayContaining([expect.objectContaining({ package: OTHER })]),
      undefined,
      expect.any(Function),
      expect.any(Function),
    )
    expect(fake.harness.webContents.loadURL).toHaveBeenCalledWith('http://127.0.0.1:6000')
    expect(setTrayStatus).toHaveBeenLastCalledWith('running', expect.stringContaining(`${DECK} disabled`))
    expect(showError).not.toHaveBeenCalled()
    expect(openSettingsMock).not.toHaveBeenCalled()
    // Non-vacuity: reverting `attributeBootFailure` to always return
    // undefined makes this fail — `writeRuntimeFilesMock`'s last call carries
    // no `OTHER` entry, because the unattributable fallback drops every
    // configured plugin instead of isolating just the one named in the error.
    expect(capturedSettingsDeps?.disabledPlugins()).toEqual({ [DECK]: expect.stringContaining('base must be a non-empty string') })

    // A Settings window opened well after this boot finished still sees the
    // reason: `disabledPlugins()` reads the same module-level state a window
    // open at boot time would, not anything captured by a window instance.
    // Non-vacuity: hardwiring `recordDisabledPlugins` to a no-op makes this
    // assertion fail with `{}` instead of the deck's reason.
    expect(capturedSettingsDeps?.disabledPlugins()[DECK]).toContain('base must be a non-empty string')
  })

  it('falls back to dropping every plugin, and reports it, when a failure names none of them', async () => {
    configureTwoReadyPlugins()

    await loadIndex()
    fake.ready()
    await vi.waitFor(() => expect(children.length).toBe(1))
    // No entry path or insert id appears anywhere in this message.
    children[0].failToStart('the harness crashed on an unrelated assertion')
    await vi.waitFor(() => expect(children.length).toBe(2))
    children[1].ready('http://127.0.0.1:6000')
    await settle()

    expect(startServer).toHaveBeenCalledTimes(2)
    expect(writeRuntimeFilesMock).toHaveBeenLastCalledWith(
      expect.any(String),
      STORED.notifyPort,
      [],
      undefined,
      expect.any(Function),
      expect.any(Function),
    )
    expect(fake.harness.webContents.loadURL).toHaveBeenCalledWith('http://127.0.0.1:6000')
    expect(setTrayStatus).toHaveBeenLastCalledWith('running', expect.stringContaining('disabled'))
    expect(capturedSettingsDeps?.disabledPlugins()).toEqual({
      [DECK]: expect.stringContaining('unrelated assertion'),
      [OTHER]: expect.stringContaining('unrelated assertion'),
    })
    expect(showError).not.toHaveBeenCalled()
  })

  it('does not retry, and does not double the wait, when no plugin was inserted', async () => {
    // `STORED` carries no `plugins`, so `insertedCount` is 0 and the retry
    // path must never engage — an ordinary failure fails fast, once.
    await loadIndex()
    fake.ready()
    await vi.waitFor(() => expect(children.length).toBe(1))
    children[0].failToStart('no URL')
    await settle()

    expect(startServer).toHaveBeenCalledTimes(1)
    expect(showError).toHaveBeenCalledWith(fake.views, 'The harness failed to start', expect.stringContaining('no URL'))
    expect(openSettingsMock).not.toHaveBeenCalled()
  })

  it('bounds isolation retries: at most MAX_ISOLATION_ATTEMPTS extra attempts, even with a pathological plugin count', async () => {
    // Three configured plugins, each individually attributable but each
    // retry still fails: without a bound, this would isolate one per
    // attempt until none remained. The bound must stop it after two extra
    // attempts (three `startServer` calls total), leaving the third
    // configured plugin's own failure as whatever the last attempt reports,
    // not an unbounded fourth attempt.
    const THIRD = '@onetest/dsh-third'
    const THIRD_ENTRY = '/tmp/third/lib/index.js'
    configResult = {
      configured: true,
      config: { ...STORED, plugins: [{ spec: DECK, version: '0.2.1' }, { spec: OTHER, version: '1.0.0' }, { spec: THIRD, version: '1.0.0' }] },
    }
    pluginStatusMock.mockImplementation((_deps: unknown, _home: string, entry: { spec: string }) => {
      if (entry.spec.startsWith(DECK)) return { kind: 'ready', package: DECK, entryPath: DECK_ENTRY, probeDirectory: '/tmp/deck' }
      if (entry.spec.startsWith(OTHER)) return { kind: 'ready', package: OTHER, entryPath: OTHER_ENTRY, probeDirectory: '/tmp/other' }
      return { kind: 'ready', package: THIRD, entryPath: THIRD_ENTRY, probeDirectory: '/tmp/third' }
    })

    await loadIndex()
    fake.ready()
    await vi.waitFor(() => expect(children.length).toBe(1))
    children[0].failToStart(`failed to apply loader entry (${DECK_ENTRY}): invalid config`)
    await vi.waitFor(() => expect(children.length).toBe(2))
    children[1].failToStart(`failed to apply loader entry (${OTHER_ENTRY}): invalid config`)
    await vi.waitFor(() => expect(children.length).toBe(3))
    children[2].failToStart(`failed to apply loader entry (${THIRD_ENTRY}): invalid config`)
    await settle()

    // 1 primary + MAX_ISOLATION_ATTEMPTS (2) retries = 3 total, never 4.
    expect(startServer).toHaveBeenCalledTimes(3)
    expect(showError).toHaveBeenCalledWith(fake.views, 'The harness failed to start', expect.stringContaining(THIRD_ENTRY))
    // Non-vacuity: raising the loop's attempt bound (or removing it) makes
    // this fail because a fourth `startServer` call follows, isolating the
    // third plugin too instead of giving up after the bound.
  })

  it('leaks no child when a quit lands while the retry is still starting', async () => {
    configureOneReadyPlugin()

    await loadIndex()
    fake.ready()
    await vi.waitFor(() => expect(children.length).toBe(1))
    children[0].failToStart(deckFailure())
    await vi.waitFor(() => expect(children.length).toBe(2))

    // The retry's child is spawned but has not yet reported ready or exited.
    await fake.emit('before-quit', fake.quitEvent())
    await settle()

    expect(children[1].stop).toHaveBeenCalledTimes(1)
    expect(startServer).toHaveBeenCalledTimes(2)
    expect(fake.app.quit).toHaveBeenCalled()
  })
})

describe('restart', () => {
  it('ignores a superseded child’s exit instead of clobbering the live one', async () => {
    const first = await bootReady()
    trayActions?.restart()
    await vi.waitFor(() => expect(children.length).toBe(2))
    children[1].ready('http://127.0.0.1:6000')
    await settle()

    // The outgoing child finally dies, long after its replacement took over.
    first.exit(143, 'terminated')
    await settle()

    expect(showError).not.toHaveBeenCalled()
    expect(setTrayStatus).toHaveBeenLastCalledWith('running')

    // The decisive part: the live child must still be reachable from the quit path.
    await fake.emit('before-quit', fake.quitEvent())
    await settle()
    expect(children[1].stop).toHaveBeenCalled()
  })

  it('is visible to a quit that arrives inside its stop window', async () => {
    hangStop = true
    const first = await bootReady()

    trayActions?.restart()
    await settle()
    expect(first.stop).toHaveBeenCalled()
    // The old child is stopping and no new one exists yet: the app looks idle.
    const event = fake.quitEvent()
    void fake.emit('before-quit', event)
    await settle()

    expect(event.prevented).toBe(true)

    first.releaseStop()
    await settle()

    // Nothing may be spawned behind the quit's back.
    expect(children.length).toBe(1)
    expect(fake.app.quit).toHaveBeenCalled()
  })
})

describe('before-quit', () => {
  it('reaps a child that has not become ready yet', async () => {
    await loadIndex()
    fake.ready()
    await vi.waitFor(() => expect(children.length).toBe(1))

    await fake.emit('before-quit', fake.quitEvent())
    await settle()

    expect(children[0].stop).toHaveBeenCalled()
    expect(fake.app.quit).toHaveBeenCalled()
  })

  it('does not re-enter once quitting', async () => {
    const child = await bootReady()
    await fake.emit('before-quit', fake.quitEvent())
    await settle()
    const second = fake.quitEvent()
    await fake.emit('before-quit', second)
    expect(second.prevented).toBe(false)
    expect(child.stop).toHaveBeenCalledTimes(1)
  })

  it('reaps the npm install child, which is in neither the chain nor the harness child', async () => {
    // A managed install runs for minutes. It is not the harness child and it
    // is not a lifecycle transition, so nothing else on the quit path would
    // ever find it, and an unreaped npm keeps writing into $DSH_HOME after
    // Electron has exited.
    await bootReady()

    await fake.emit('before-quit', fake.quitEvent())
    await settle()

    expect(installStopAll).toHaveBeenCalled()
    expect(fake.app.quit).toHaveBeenCalled()
  })

  it('reaps the install before the app is allowed to quit', async () => {
    await bootReady()
    let stopped = false
    installStopAll.mockImplementation(async () => {
      await Promise.resolve()
      stopped = true
    })

    await fake.emit('before-quit', fake.quitEvent())
    await settle()

    expect(stopped).toBe(true)
    expect(fake.app.quit).toHaveBeenCalled()
  })
})

describe('window lifetime', () => {
  it('hides the window on close and keeps the app running in the tray', async () => {
    await bootReady()
    const event = fake.quitEvent()
    await fake.emitWindow('close', event)
    expect(event.prevented).toBe(true)
    expect(fake.window.hide).toHaveBeenCalled()
    await fake.emit('window-all-closed')
    expect(fake.app.quit).not.toHaveBeenCalled()
  })

  it('lets the window close for real once a quit is under way', async () => {
    await bootReady()
    await fake.emit('before-quit', fake.quitEvent())
    await settle()
    const event = fake.quitEvent()
    await fake.emitWindow('close', event)
    expect(event.prevented).toBe(false)
  })
})

describe('deep links', () => {
  it('applies a cold-start dsh:// link once the window exists', async () => {
    await loadIndex()
    // macOS delivers open-url before whenReady, when there is no window yet.
    await fake.emit('open-url', fake.quitEvent(), 'dsh://open')
    expect(fake.window.show).not.toHaveBeenCalled()

    fake.ready()
    await vi.waitFor(() => expect(children.length).toBe(1))
    children[0].ready()
    await settle()
    await fake.emitWindow('harness:did-finish-load')
    await settle()

    expect(fake.window.show).toHaveBeenCalled()
    expect(fake.window.focus).toHaveBeenCalled()
  })

  // reason: macOS fires `activate` as the app launches, long before the
  // harness URL has painted. Revealing then puts an empty white window behind
  // the splash — which is what the app did until the reveal was gated.
  it('keeps the empty window hidden while the splash is up, and reveals it once it has content', async () => {
    await loadIndex()
    fake.ready()
    await vi.waitFor(() => expect(children.length).toBe(1))
    await fake.emit('activate')
    expect(fake.window.show).not.toHaveBeenCalled()

    children[0].ready()
    await settle()
    await fake.emitWindow('harness:did-finish-load')
    await settle()
    expect(fake.window.show).toHaveBeenCalled()
  })

  it('raises the window for a link that arrives while it is up', async () => {
    await bootReady()
    await fake.emit('open-url', fake.quitEvent(), 'dsh://open')
    expect(fake.window.focus).toHaveBeenCalled()
  })
})

describe('hotkey', () => {
  it('reports an accelerator the system refused to bind', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    fake.globalShortcut.register.mockReturnValue(false)
    await bootReady()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not be registered'))
    warn.mockRestore()
  })
})

describe('settings', () => {
  it('opens settings and does not boot when no config exists', async () => {
    configResult = { configured: false }
    await readyHandler()
    expect(openSettingsMock).toHaveBeenCalled()
    expect(startServer).not.toHaveBeenCalled()
  })

  it('boots without opening settings when a config exists', async () => {
    configResult = { configured: true, config: STORED }
    await bootReady()
    expect(openSettingsMock).not.toHaveBeenCalled()
    expect(startServer).toHaveBeenCalled()
  })

  it('quits when first-run settings close without a config being saved', async () => {
    configResult = { configured: false }
    await readyHandler()
    closeSettings()
    expect(fake.app.quit).toHaveBeenCalled()
  })

  it('does not quit when settings close and a config exists', async () => {
    configResult = { configured: true, config: STORED }
    await readyHandler()
    trayActions?.openSettings()
    closeSettings()
    expect(fake.app.quit).not.toHaveBeenCalled()
  })
})

describe('the config-file-open deps wiring', () => {
  // `configPath(process.env)` is resolved once at module load, so `DSH_HOME`
  // is pointed at a fresh temp directory before each import — never the real
  // `~/.dsh` a running app on this machine owns.
  let originalDshHome: string | undefined
  let dshHome: string

  beforeEach(() => {
    originalDshHome = process.env.DSH_HOME
    dshHome = mkdtempSync(join(tmpdir(), 'dsh-desktop-open-config-'))
    process.env.DSH_HOME = dshHome
  })

  afterEach(() => {
    if (originalDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = originalDshHome
  })

  it('opens the resolved config path and writes nothing', async () => {
    const configFile = join(dshHome, 'desktop.json')
    writeFileSync(configFile, '{}')
    await loadIndex()

    const result = await capturedSettingsDeps?.openConfigFile()

    expect(fake.shell.openPath).toHaveBeenCalledWith(configFile)
    expect(result).toEqual({ ok: true })
  })

  it('surfaces an openPath failure rather than swallowing it', async () => {
    writeFileSync(join(dshHome, 'desktop.json'), '{}')
    fake.shell.openPath.mockResolvedValueOnce('No application knows how to open this file.')
    await loadIndex()

    const result = await capturedSettingsDeps?.openConfigFile()

    expect(result).toEqual({ ok: false, error: 'No application knows how to open this file.' })
  })

  it('reports a missing config file without ever calling openPath', async () => {
    // No file written at `dshHome`: first run, nothing saved yet.
    await loadIndex()

    const result = await capturedSettingsDeps?.openConfigFile()

    expect(fake.shell.openPath).not.toHaveBeenCalled()
    expect(result).toEqual({ ok: false, error: 'No config file yet — save your settings once to create it.' })
  })
})

describe('an unreadable config', () => {
  /** Make every `loadConfig` fail the way a malformed or EACCES file does. */
  function unreadable(): void {
    loadConfigMock.mockImplementation(() => {
      throw new Error('dsh-desktop: cannot read /tmp/desktop.json')
    })
  }

  it('shows the failure pane and opens settings at startup instead of stranding the app', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    unreadable()
    await readyHandler()
    expect(showError).toHaveBeenCalledWith(
      fake.views,
      'Configuration problem',
      expect.stringContaining('cannot read'),
    )
    expect(openSettingsMock).toHaveBeenCalled()
    expect(startServer).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('does not throw out of the settings close handler, and keeps the app alive', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    unreadable()
    await readyHandler()
    // The close handler runs on the main process's event loop: a throw here is
    // an uncaught exception, not a rejected promise someone can catch.
    expect(() => {
      closeSettings()
    }).not.toThrow()
    // Quitting would remove the only window that can repair the config.
    expect(fake.app.quit).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('applySettings', () => {
  const OTHER_REPO = '/tmp/other-harness'

  /**
   * Drive `applySettings` when it is expected to respawn the harness: the
   * respawned child's readiness is awaited from outside just like `bootReady`,
   * since `applySettings` itself blocks on the child becoming ready.
   */
  async function applySettingsReady(previous: DesktopConfig | undefined, next: DesktopConfig): Promise<void> {
    const before = children.length
    const pending = applySettings(previous, next)
    await vi.waitFor(() => expect(children.length).toBe(before + 1))
    children[children.length - 1].ready()
    await pending
    await settle()
  }

  it('restarts the harness when the source changes', async () => {
    const child = await bootReady()
    startServer.mockClear()
    await applySettingsReady(STORED, { ...STORED, harness: { kind: 'local', repo: OTHER_REPO } })
    expect(startServer).toHaveBeenCalledTimes(1)
    expect(child.stop).toHaveBeenCalled()
  })

  it('restarts the harness when the notify port changes, because hooks.json is regenerated at boot', async () => {
    await bootReady()
    startServer.mockClear()
    await applySettingsReady(STORED, { ...STORED, notifyPort: 5000 })
    expect(startServer).toHaveBeenCalledTimes(1)
  })

  it('rebinds the notify listener when the port changes', async () => {
    await bootReady()
    await applySettingsReady(STORED, { ...STORED, notifyPort: 5000 })
    expect(startNotifyListenerMock).toHaveBeenLastCalledWith(5000, expect.any(Function))
  })

  it('re-registers the hotkey without restarting the harness', async () => {
    await bootReady()
    startServer.mockClear()
    await applySettings(STORED, { ...STORED, hotkey: 'Alt+D' })
    await settle()
    expect(fake.globalShortcut.unregisterAll).toHaveBeenCalled()
    expect(fake.globalShortcut.register).toHaveBeenLastCalledWith('Alt+D', expect.any(Function))
    expect(startServer).not.toHaveBeenCalled()
  })

  it('restarts when a binary path changes, since it is resolved at spawn', async () => {
    await bootReady()
    startServer.mockClear()
    await applySettingsReady(STORED, { ...STORED, pnpmPath: '/opt/pnpm' })
    expect(startServer).toHaveBeenCalledTimes(1)
  })

  it('restarts when the npm binary path changes, since it is resolved at spawn', async () => {
    await bootReady()
    startServer.mockClear()
    await applySettingsReady(STORED, { ...STORED, npmPath: '/opt/npm' })
    expect(startServer).toHaveBeenCalledTimes(1)
  })

  it('restarts when the resolved plugin list changes, since it is baked into the generated overlay', async () => {
    await bootReady()
    startServer.mockClear()
    await applySettingsReady(STORED, {
      ...STORED,
      plugins: [{ spec: '@deepseek-ai/dsh-hooks-claude-code', version: '0.1.1-rc.2' }],
    })
    expect(startServer).toHaveBeenCalledTimes(1)
  })

  it('does not restart when the harness source has the same values in a different key order', async () => {
    await bootReady()
    startServer.mockClear()
    // Same values as STORED.harness, but constructed with the keys in a
    // different order; a config file hand-edited or reserialized this way
    // must not look like a change.
    const reordered = { repo: STORED.harness.kind === 'local' ? STORED.harness.repo : '', kind: 'local' as const }
    await applySettings(STORED, { ...STORED, harness: reordered })
    await settle()
    expect(startServer).not.toHaveBeenCalled()
  })

  it('surfaces a warning naming the accelerator when hotkey registration fails, and still reports success', async () => {
    await bootReady()
    fake.globalShortcut.register.mockImplementation((accelerator: string) => accelerator !== 'Alt+D')
    const warnings = await applySettings(STORED, { ...STORED, hotkey: 'Alt+D' })
    await settle()
    expect(warnings).toEqual([expect.stringContaining('Alt+D')])
  })

  it('binds no listener and arms no hotkey when a quit lands during the respawn', async () => {
    await bootReady()
    startNotifyListenerMock.mockClear()
    fake.globalShortcut.register.mockClear()
    fake.globalShortcut.unregisterAll.mockClear()

    // Both a port and a hotkey change, so every side effect below the restart
    // is in play; the restart's await is the window the quit lands in.
    const pending = applySettings(STORED, { ...STORED, notifyPort: 5000, hotkey: 'Alt+D' })
    await vi.waitFor(() => expect(children.length).toBe(2))

    // will-quit has run by the time the respawn unwinds: the listener it would
    // have closed and the shortcuts it unregistered are already gone.
    void fake.emit('before-quit', fake.quitEvent())
    await settle()
    await pending
    await settle()

    expect(startNotifyListenerMock).not.toHaveBeenCalled()
    expect(fake.globalShortcut.unregisterAll).not.toHaveBeenCalled()
    expect(fake.globalShortcut.register).not.toHaveBeenCalled()
  })

  it('closes a listener that wins its race with a quit', async () => {
    await bootReady()
    let bind: (listener: { port: number; close: () => Promise<void> }) => void = () => {}
    startNotifyListenerMock.mockImplementation(
      async () =>
        new Promise<{ port: number; close: () => Promise<void> }>((resolve) => {
          bind = resolve
        }),
    )

    const pending = applySettings(STORED, { ...STORED, notifyPort: 5000 })
    await vi.waitFor(() => expect(children.length).toBe(2))
    children[children.length - 1].ready()
    await settle()

    // The respawn is done and the listener is mid-bind: the quit lands here.
    void fake.emit('before-quit', fake.quitEvent())
    await settle()

    const close = vi.fn(async () => {})
    bind({ port: 5000, close })
    await pending
    await settle()

    // Nothing else knows about this listener: will-quit already ran its close.
    expect(close).toHaveBeenCalled()
  })

  it('reports the tray as starting for the whole respawn window', async () => {
    await bootReady()
    setTrayStatus.mockClear()
    const pending = applySettings(STORED, { ...STORED, harness: { kind: 'local', repo: OTHER_REPO } })
    await vi.waitFor(() => expect(children.length).toBe(2))
    // The child is spawned but not ready: the tray must not still say running.
    expect(setTrayStatus).toHaveBeenLastCalledWith('starting')
    children[children.length - 1].ready()
    await pending
    await settle()
    expect(setTrayStatus).toHaveBeenLastCalledWith('running')
  })

  it('names both accelerators when the previous hotkey cannot be restored either', async () => {
    await bootReady()
    fake.globalShortcut.register.mockReturnValue(false)
    const warnings = await applySettings(STORED, { ...STORED, hotkey: 'Alt+D' })
    await settle()
    expect(warnings).toEqual([
      expect.stringContaining('Alt+D'),
      expect.stringContaining(STORED.hotkey),
    ])
  })

  it('does nothing when nothing changed', async () => {
    await bootReady()
    startServer.mockClear()
    fake.globalShortcut.unregisterAll.mockClear()
    await applySettings(STORED, { ...STORED })
    await settle()
    expect(startServer).not.toHaveBeenCalled()
    expect(fake.globalShortcut.unregisterAll).not.toHaveBeenCalled()
  })

  it('boots for the first time when there was no previous config', async () => {
    configResult = { configured: false }
    await readyHandler()
    // The settings save already wrote this config to disk by the time
    // `applySettings` runs; `bootNow` re-reads it via `loadConfig`.
    configResult = { configured: true, config: STORED }
    startServer.mockClear()
    await applySettingsReady(undefined, STORED)
    expect(startServer).toHaveBeenCalledTimes(1)
  })
})

describe('MCP servers at boot', () => {
  const MCP_CLIENT = '@deepseek-ai/dsh-mcp-client'

  // Every case reads mcp.json and the secret values under $DSH_HOME. Without
  // a home of its own the suite would read the developer's real ~/.dsh.
  let mcpHome: string
  let originalDshHome: string | undefined

  beforeEach(() => {
    originalDshHome = process.env.DSH_HOME
    mcpHome = mkdtempSync(join(tmpdir(), 'dsh-mcp-boot-'))
    process.env.DSH_HOME = mcpHome
  })

  afterEach(() => {
    if (originalDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = originalDshHome
  })

  /** Write an mcp.json into this case's home. */
  function withServers(servers: Record<string, unknown>): void {
    writeFileSync(join(mcpHome, 'mcp.json'), JSON.stringify({ mcpServers: servers }))
  }

  /** Store settings with the master switch in a given state. */
  function withSwitch(mcpEnabled: boolean, mcpClientVersion = '1.2.3'): void {
    configResult = { configured: true, config: { ...STORED, mcpEnabled, mcpClientVersion } }
  }

  /** The `resolveDeclaredPatch` callback `bootNow` handed `writeRuntimeFiles`. */
  function declaredPatchResolver(): (status: unknown) => unknown {
    return writeRuntimeFilesMock.mock.calls.at(-1)![5] as (status: unknown) => unknown
  }

  it('resolves the MCP client alongside the configured plugins when a server is enabled', async () => {
    withServers({ tavily: { type: 'http', url: 'https://mcp.tavily.com/mcp/' } })
    withSwitch(true)
    await bootReady()
    expect(pluginStatusMock).toHaveBeenCalledWith(expect.anything(), expect.any(String), { spec: MCP_CLIENT, version: '1.2.3' }, undefined)
  })

  it('does not resolve it at all when the master switch is off', async () => {
    withServers({ tavily: { type: 'http', url: 'https://mcp.tavily.com/mcp/' } })
    withSwitch(false)
    await bootReady()
    expect(pluginStatusMock.mock.calls.some((call) => (call[2] as { spec: string }).spec === MCP_CLIENT)).toBe(false)
  })

  // reason: this app's own view tools are themselves a server on that client,
  // so one is active even when every configured server is off.
  it('still resolves it for the view tools when every configured server is disabled', async () => {
    withServers({ tavily: { type: 'http', url: 'https://mcp.tavily.com/mcp/', disabled: true } })
    withSwitch(true)
    await bootReady()
    expect(pluginStatusMock.mock.calls.some((call) => (call[2] as { spec: string }).spec === MCP_CLIENT)).toBe(true)
  })

  // reason: the view tools are MCP tools. The master switch turns off the
  // client that serves them, and saying otherwise would make "no server is
  // contacted" untrue.
  it('resolves nothing when the master switch is off, view tools included', async () => {
    withServers({ tavily: { type: 'http', url: 'https://mcp.tavily.com/mcp/' } })
    withSwitch(false)
    await bootReady()
    expect(pluginStatusMock.mock.calls.some((call) => (call[2] as { spec: string }).spec === MCP_CLIENT)).toBe(false)
  })

  it('gives the MCP client one overlay row per enabled server, each under its own id', async () => {
    withServers({
      tavily: { type: 'http', url: 'https://mcp.tavily.com/mcp/' },
      playwright: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
    })
    withSwitch(true)
    await bootReady()
    const rows = declaredPatchResolver()({ package: MCP_CLIENT, packageDir: '/tmp/mcp' }) as { id: string; name: string }[]
    // This app's own view tools ride the same client, so they are a row too.
    // One row per surface: the app serves a server per surface so the harness
    // namespaces each one's tools under its own name.
    expect(rows.map((row) => row.id)).toEqual([
      'mcp-tavily', 'mcp-playwright', 'mcp-app_browser', 'mcp-app_editor',
    ])
    expect(new Set(rows.map((row) => row.name))).toEqual(new Set([MCP_CLIENT]))
  })

  it('carries a stdio server env value to the harness child by environment, never in the overlay', async () => {
    withServers({ gh: { command: 'npx', args: ['-y', 'server-github'], env: { GITHUB_TOKEN: 'ghp-secret' } } })
    withSwitch(true)
    await bootReady()
    const env = dshWebCommandMock.mock.calls.at(-1)![3] as Record<string, string>
    expect(Object.values(env)).toContain('ghp-secret')
  })

  it('adds no MCP environment at all when the switch is off', async () => {
    withServers({ gh: { command: 'npx', env: { GITHUB_TOKEN: 'ghp-secret' } } })
    withSwitch(false)
    await bootReady()
    expect(dshWebCommandMock.mock.calls.at(-1)![3]).toEqual({})
  })
})

describe('a stored MCP client plugin entry', () => {
  const MCP_CLIENT = '@deepseek-ai/dsh-mcp-client'

  it('never reaches the overlay from the plugin list, so it cannot fail the boot with an empty config', async () => {
    configResult = {
      configured: true,
      config: { ...STORED, plugins: [{ spec: MCP_CLIENT, version: '1.0.0' }] },
    }
    await bootReady()
    expect(pluginStatusMock.mock.calls.some((call) => (call[2] as { spec: string }).spec === MCP_CLIENT)).toBe(false)
  })

  it('leaves the other configured plugins alone', async () => {
    configResult = {
      configured: true,
      config: {
        ...STORED,
        plugins: [
          { spec: MCP_CLIENT, version: '1.0.0' },
          { spec: '@deepseek-ai/dsh-hooks-claude-code', version: '0.1.1-rc.2' },
        ],
      },
    }
    await bootReady()
    // Deduplicated: each declared plugin is resolved twice per launch — once
    // by the startup healthcheck to report it, once by the boot to mount it.
    // What this pins is which packages are considered at all.
    const specs = new Set(pluginStatusMock.mock.calls.map((call) => (call[2] as { spec: string }).spec))
    expect([...specs]).toEqual(['@deepseek-ai/dsh-hooks-claude-code'])
  })
})

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

describe('startup healthcheck', () => {
  let home: string
  let original: string | undefined

  beforeEach(() => {
    original = process.env.DSH_HOME
    home = mkdtempSync(join(tmpdir(), 'dsh-startup-'))
    process.env.DSH_HOME = home
  })

  afterEach(() => {
    if (original === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = original
  })

  /** A stored config declaring the given plugins. */
  function declaring(plugins: { spec: string; version?: string }[]): void {
    configResult = { configured: true, config: { ...STORED, plugins } }
  }

  it('installs a declared plugin that is not installed, before the harness boots', async () => {
    declaring([{ spec: 'dsh-project-mcp-bridge@0.2.1' }])
    pluginStatusMock.mockImplementation(() => ({
      kind: 'unavailable',
      package: 'dsh-project-mcp-bridge',
      reason: 'not installed yet',
    }))
    await bootReady()
    expect(managedInstallMock).toHaveBeenCalledWith('dsh-project-mcp-bridge', '0.2.1', expect.any(Function))
  })

  it('boots the harness only after repair has finished', async () => {
    const order: string[] = []
    declaring([{ spec: 'a@1.0.0' }])
    pluginStatusMock.mockImplementation(() => ({ kind: 'unavailable', package: 'a', reason: 'not installed yet' }))
    managedInstallMock.mockImplementation(async () => {
      order.push('install')
      return '1.0.0'
    })
    const previousStart = startServer.getMockImplementation()
    startServer.mockImplementation((options: StartOptions) => {
      order.push('boot')
      return previousStart!(options)
    })
    await bootReady()
    expect(order).toEqual(['install', 'boot'])
  })

  it('installs nothing when everything the config declares is present', async () => {
    declaring([{ spec: 'a', version: '1.0.0' }])
    pluginStatusMock.mockImplementation(() => ({
      kind: 'ready',
      package: 'a',
      entryPath: '/a/i.js',
      probeDirectory: '/a',
      packageDir: '/a',
    }))
    await bootReady()
    expect(managedInstallMock).not.toHaveBeenCalled()
  })

  // reason: `pluginStatus` reports an entry with no recorded version as not
  // installed, so a repair that does not write the resolved version back
  // reinstalls the same plugin on every launch and the chip never turns green.
  it('records the version a repair resolved, so the next launch finds it installed', async () => {
    declaring([{ spec: 'dsh-project-mcp-bridge@0.2.1' }])
    pluginStatusMock.mockImplementation(() => ({
      kind: 'unavailable',
      package: 'dsh-project-mcp-bridge',
      reason: 'not installed yet',
    }))
    managedInstallMock.mockImplementation(async () => '0.2.1')
    await bootReady()
    expect(writeConfigMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ plugins: [{ spec: 'dsh-project-mcp-bridge@0.2.1', version: '0.2.1' }] }),
    )
  })

  it('leaves the config alone when a repair fails', async () => {
    declaring([{ spec: 'a@1.0.0' }])
    pluginStatusMock.mockImplementation(() => ({ kind: 'unavailable', package: 'a', reason: 'not installed yet' }))
    managedInstallMock.mockImplementation(async () => {
      throw new Error('registry unreachable')
    })
    await bootReady()
    expect(writeConfigMock).not.toHaveBeenCalled()
  })

  it('still boots when repair fails, with whatever did install', async () => {
    declaring([{ spec: 'a@1.0.0' }])
    pluginStatusMock.mockImplementation(() => ({ kind: 'unavailable', package: 'a', reason: 'not installed yet' }))
    managedInstallMock.mockImplementation(async () => {
      throw new Error('registry unreachable')
    })
    const child = await bootReady()
    expect(child).toBeDefined()
  })
})

describe('the side columns', () => {
  // reason: the divider page reports a window coordinate, not a width — it
  // has no way to know where the views are. Main owns that arithmetic.
  it('turns a divider drag into that column’s width', async () => {
    await bootReady()
    fake.sendIpc('shell:resize-column', 'files', 1040)
    expect(applyLayout).toHaveBeenLastCalledWith(
      fake.views,
      expect.objectContaining({ files: expect.objectContaining({ width: 1280 - 30 - 1040 }) }),
      expect.any(Boolean),
    )
  })

  // reason: the panel's page is loaded with the window and runs once, so it
  // starts a shell only at load. A panel whose last tab closed comes back
  // empty — a strip of chrome with nothing in it — unless opening it says so.
  it('tells the panel it is on screen when the rail opens it', async () => {
    await bootReady()
    fake.terminal.webContents.send.mockClear()
    fake.sendIpc('shell:toggle-terminal')
    expect(fake.terminal.webContents.send).toHaveBeenCalledWith('terminal:shown')
  })

  it('says nothing to the panel when the rail closes it', async () => {
    await bootReady()
    fake.sendIpc('shell:toggle-terminal')
    fake.terminal.webContents.send.mockClear()
    fake.sendIpc('shell:toggle-terminal')
    expect(fake.terminal.webContents.send).not.toHaveBeenCalledWith('terminal:shown')
  })

  // reason: a page that has not finished loading drops what is sent to it,
  // which is the panel's state when the rail is used in the first moments
  // after boot — the case where an empty panel is least recoverable.
  it('waits for the page when the panel is opened before it has loaded', async () => {
    await bootReady()
    fake.terminal.webContents.isLoading.mockReturnValue(true)
    fake.terminal.webContents.send.mockClear()
    fake.sendIpc('shell:toggle-terminal')
    expect(fake.terminal.webContents.send).not.toHaveBeenCalledWith('terminal:shown')
    await fake.emitWindow('terminal:did-finish-load')
    expect(fake.terminal.webContents.send).toHaveBeenCalledWith('terminal:shown')
  })

  // reason: the editor's divider sits inside the tree, so its width is
  // measured past whatever columns lie outside it — otherwise dragging the
  // editor would move the tree too.
  it('measures the editor past the tree beside it', async () => {
    await bootReady()
    fake.sendIpc('pane:open-file', '/p/known', 'readme.md')
    fake.sendIpc('shell:toggle-files')
    fake.sendIpc('shell:resize-column', 'editor', 700)
    expect(applyLayout).toHaveBeenLastCalledWith(
      fake.views,
      expect.objectContaining({ editor: expect.objectContaining({ width: 1280 - 30 - 700 - 220 - 8 }) }),
      expect.any(Boolean),
    )
  })

  it('nudges a column by a step for a keyboard user', async () => {
    await bootReady()
    fake.sendIpc('shell:nudge-column', 'files', 20)
    expect(applyLayout).toHaveBeenLastCalledWith(
      fake.views,
      expect.objectContaining({ files: expect.objectContaining({ width: 240 }) }),
      expect.any(Boolean),
    )
  })

  // reason: a write per pointer move would put a file write behind every
  // frame of a drag.
  it('stores nothing while the drag is still running', async () => {
    await bootReady()
    writeConfigMock.mockClear()
    fake.sendIpc('shell:resize-column', 'files', 900)
    expect(writeConfigMock).not.toHaveBeenCalled()
  })

  // reason: a drag can ask for a width `layout` refuses. Storing the ask
  // rather than the outcome would reopen the column at a size it never had.
  it('stores the widths the layout settled on when the drag ends', async () => {
    readWorkspacesMock.mockReturnValue([
      { path: '/p/known', title: 'known', file: '/p/known/.dsh/mcp.json', declared: false, servers: [] },
    ])
    await bootReady()
    fake.sendIpc('pane:open-file', '/p/known', 'readme.md')
    fake.sendIpc('shell:toggle-files')
    writeConfigMock.mockClear()
    fake.sendIpc('shell:resize-column', 'files', 10)
    fake.sendIpc('shell:commit-columns')
    expect(writeConfigMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        pane: {
          editor: { width: 520, open: true },
          files: { width: 220, open: true, view: 'files' },
          terminal: { width: 720, height: 240, open: false },
        },
      }),
    )
  })

  // reason: whichever of the two side-column views is not showing is given a
  // 0x0 rectangle, so measuring the tree while the panel is up reads zero —
  // and `shell:commit-columns` fires at the end of ANY divider drag, so that
  // zero would be stored as the column's width by dragging the editor's.
  it('measures the side column from the view that is actually in it', async () => {
    await bootReady()
    fake.sendIpc('shell:toggle-git')
    // The tree's view now has no bounds at all, exactly as `applyLayout`
    // leaves it while the panel is showing.
    fake.views.files.getBounds.mockReturnValue({ x: 0, y: 0, width: 0, height: 0 })
    writeConfigMock.mockClear()
    fake.sendIpc('shell:commit-columns')
    expect(writeConfigMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        pane: expect.objectContaining({ files: { width: 220, open: true, view: 'git' } }),
      }),
    )
  })

  // reason: the editor is measured inward past whatever sits outside it, and
  // the side column's width is what that is. Read off the empty view it is
  // zero, and the editor jumps by the whole width of the panel beside it.
  it('measures past the git panel when the editor divider is dragged', async () => {
    await bootReady()
    fake.sendIpc('pane:open-file', '/p/known', 'readme.md')
    fake.sendIpc('shell:toggle-git')
    fake.views.files.getBounds.mockReturnValue({ x: 0, y: 0, width: 0, height: 0 })
    fake.sendIpc('shell:resize-column', 'editor', 600)
    // 1280 window, 30 of rail, the drag at 600, past the 220-wide panel and
    // its 8px divider.
    expect(applyLayout).toHaveBeenLastCalledWith(
      fake.views,
      expect.objectContaining({ editor: expect.objectContaining({ width: 1280 - 30 - 600 - (220 + 8) }) }),
      expect.any(Boolean),
    )
  })

  // reason: the editor is not something to open empty — it appears when a
  // file goes into it. The tree is the column a user opens by hand.
  it('opens the tree from the View menu, leaving the editor closed', async () => {
    await bootReady()
    const toggle = (installMenuMock.mock.calls[0][1] as { toggleFiles(): void }).toggleFiles
    writeConfigMock.mockClear()
    toggle()
    expect(applyLayout).toHaveBeenLastCalledWith(
      fake.views,
      expect.objectContaining({
        editor: expect.objectContaining({ open: false }),
        files: expect.objectContaining({ open: true }),
      }),
      expect.any(Boolean),
    )
    toggle()
    expect(applyLayout).toHaveBeenLastCalledWith(
      fake.views,
      expect.objectContaining({ files: expect.objectContaining({ open: false }) }),
      expect.any(Boolean),
    )
  })

  // reason: 0.3.0 shipped a fix for the terminal, where the rail and the menu
  // did not share a path and the shortcut opened a panel with nothing in it.
  // The side column now has two views and three ways to change it.
  it('switches the side column between the tree and source control, from either the rail or the menu', async () => {
    await bootReady()
    const menu = installMenuMock.mock.calls[0][1] as { toggleFiles(): void; toggleGit(): void }
    const side = (): { open: boolean; view: string } =>
      (applyLayout as unknown as { mock: { calls: unknown[][] } }).mock.calls.at(-1)?.[1] as never

    fake.sendIpc('shell:toggle-git')
    expect(side()).toMatchObject({ files: { open: true, view: 'git' } })
    // The tree's own button switches the column rather than closing it.
    menu.toggleFiles()
    expect(side()).toMatchObject({ files: { open: true, view: 'files' } })
    // And pressing the view already showing closes the column.
    fake.sendIpc('shell:toggle-files')
    expect(side()).toMatchObject({ files: { open: false, view: 'files' } })
    menu.toggleGit()
    expect(side()).toMatchObject({ files: { open: true, view: 'git' } })
  })

  // reason: the panel asks main for everything it draws, and with no project
  // there is nothing to read — an empty list rather than a failure, since
  // nothing is wrong.
  /**
   * Let every pending microtask run.
   *
   * `readCurrentGit` awaits `hasGit` before it ever calls `readProject`, so a
   * test that gates the read has to give it that turn first.
   * @returns resolution once the queue has drained.
   */
  const settle = async (): Promise<void> => {
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
  }

  /**
   * Hold the next read open, so a second one can be watched against it.
   * @returns a function that lets the held read finish.
   */
  function gateNextRead(): () => void {
    let open: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      open = () => resolve()
    })
    readProjectMock.mockImplementationOnce(async (root: string) => {
      await gate
      return { ok: true as const, repos: [{ path: `${root}#first` }] }
    })
    return () => open?.()
  }

  // reason: the spec says a refresh already running is superseded rather than
  // queued. Handing the second caller the running promise would answer it with
  // a snapshot taken before the change that prompted it — and, when the
  // project moved meanwhile, with another project's repositories entirely.
  it('takes one more read when a change lands while one is running', async () => {
    readWorkspacesMock.mockReturnValue([
      { path: '/p/known', title: 'known', file: '/p/known/.dsh/mcp.json', declared: false, servers: [] },
    ])
    await bootReady()
    fake.sendIpc('harness:workspace', '/p/known')
    readProjectMock.mockClear()
    const release = gateNextRead()
    const first = fake.sendIpc('git:read') as Promise<unknown>
    await settle()
    // Something moved while that read was in flight; it began before the
    // change and cannot report it.
    await fake.emitWindow('focus')
    const second = fake.sendIpc('git:read') as Promise<unknown>
    await settle()
    release()
    await expect(first).resolves.toEqual({ ok: true, repos: [{ path: '/p/known#first' }] })
    await expect(second).resolves.toEqual({ ok: true, repos: [{ path: '/p/known' }] })
    // Two reads, not one and not one per caller: the second was superseded
    // into exactly one more.
    expect(readProjectMock).toHaveBeenCalledTimes(2)
  })

  // reason: a read is only an answer to the project it was started for.
  it('never answers a read with the project it has just left', async () => {
    readWorkspacesMock.mockReturnValue([
      { path: '/p/known', title: 'known', file: '/p/known/.dsh/mcp.json', declared: false, servers: [] },
      { path: '/p/other', title: 'other', file: '/p/other/.dsh/mcp.json', declared: false, servers: [] },
    ])
    await bootReady()
    fake.sendIpc('harness:workspace', '/p/known')
    readProjectMock.mockClear()
    const release = gateNextRead()
    const first = fake.sendIpc('git:read') as Promise<unknown>
    await settle()
    fake.sendIpc('harness:workspace', '/p/other')
    const second = fake.sendIpc('git:read') as Promise<unknown>
    await settle()
    release()
    await expect(first).resolves.toEqual({ ok: true, repos: [{ path: '/p/known#first' }] })
    await expect(second).resolves.toEqual({ ok: true, repos: [{ path: '/p/other' }] })
  })

  // reason: a burst of watcher events with nothing between them is one change,
  // not one read each. A rebase in the terminal panel fires dozens a second.
  it('runs one git for callers that arrive with nothing new between them', async () => {
    readWorkspacesMock.mockReturnValue([
      { path: '/p/known', title: 'known', file: '/p/known/.dsh/mcp.json', declared: false, servers: [] },
    ])
    await bootReady()
    fake.sendIpc('harness:workspace', '/p/known')
    readProjectMock.mockClear()
    const release = gateNextRead()
    const first = fake.sendIpc('git:read') as Promise<unknown>
    await settle()
    const second = fake.sendIpc('git:read') as Promise<unknown>
    await settle()
    release()
    await expect(first).resolves.toEqual({ ok: true, repos: [{ path: '/p/known#first' }] })
    await expect(second).resolves.toEqual({ ok: true, repos: [{ path: '/p/known#first' }] })
    expect(readProjectMock).toHaveBeenCalledTimes(1)
  })

  it('reads no repositories when no project is open', async () => {
    readWorkspacesMock.mockReturnValue([])
    await bootReady()
    await expect(fake.sendIpc('git:read')).resolves.toEqual({ ok: true, repos: [] })
  })

  /**
   * Wait out the notification's settle window.
   *
   * Real timers rather than fake ones: this suite drives a module whose boot
   * schedules timers of its own, and taking the clock away from it here would
   * change more than the debounce under test.
   * @returns resolution once a debounced notification would have been sent.
   */
  const settleNotify = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 300))
  }

  // reason: the panel's page is loaded with the window and redraws on every
  // `git:changed`, whether or not the column is showing it. A user who has
  // never pressed the rail button would otherwise pay a `git status` of every
  // repository, and a rebuild of an invisible DOM, for every file the agent
  // writes.
  it('says nothing to the panel while the column is not showing it', async () => {
    readWorkspacesMock.mockReturnValue([
      { path: '/p/known', title: 'known', file: '/p/known/.dsh/mcp.json', declared: false, servers: [] },
    ])
    await bootReady()
    fake.views.git.webContents.send.mockClear()
    await fake.emitWindow('focus')
    await settleNotify()
    expect(fake.views.git.webContents.send).not.toHaveBeenCalledWith('git:changed')
  })

  // reason: and nothing is lost by the silence — opening the column notifies,
  // so the panel reads what it missed the moment anyone looks at it.
  it('tells the panel to read again once the column is showing it', async () => {
    readWorkspacesMock.mockReturnValue([
      { path: '/p/known', title: 'known', file: '/p/known/.dsh/mcp.json', declared: false, servers: [] },
    ])
    await bootReady()
    fake.sendIpc('shell:toggle-git')
    fake.views.git.webContents.send.mockClear()
    await fake.emitWindow('focus')
    await settleNotify()
    expect(fake.views.git.webContents.send).toHaveBeenCalledWith('git:changed')
  })

  it('opens the tree from the rail', async () => {
    await bootReady()
    fake.sendIpc('shell:toggle-files')
    expect(applyLayout).toHaveBeenLastCalledWith(
      fake.views,
      expect.objectContaining({ files: expect.objectContaining({ open: true }) }),
      expect.any(Boolean),
    )
  })

  // reason: with nothing open the editor has no reason to take width from the
  // conversation beside it.
  it('closes the editor column when the pane asks, and remembers it', async () => {
    readWorkspacesMock.mockReturnValue([
      { path: '/p/known', title: 'known', file: '/p/known/.dsh/mcp.json', declared: false, servers: [] },
    ])
    await bootReady()
    fake.sendIpc('pane:open-file', '/p/known', 'readme.md')
    writeConfigMock.mockClear()
    fake.sendIpc('pane:close-editor')
    expect(applyLayout).toHaveBeenLastCalledWith(
      fake.views,
      expect.objectContaining({ editor: expect.objectContaining({ open: false }) }),
      expect.any(Boolean),
    )
    expect(writeConfigMock).toHaveBeenCalled()
  })

  // reason: the address bar is a page in this app; the browser it drives is a
  // view of the window. Only main can carry one to the other.
  it('loads what the address bar asks for, and refuses what it should not', async () => {
    await bootReady()
    fake.sendIpc('pane:navigate', 'https://example.com')
    expect(fake.web.webContents.loadURL).toHaveBeenCalledWith('https://example.com')

    fake.web.webContents.loadURL.mockClear()
    fake.sendIpc('pane:navigate', 'file:///etc/passwd')
    expect(fake.web.webContents.loadURL).not.toHaveBeenCalled()
  })

  // reason: the page navigates on its own — a link, a redirect — and a bar
  // that only updated when asked would show the last address typed.
  it('reports where the browser went, whoever took it there', async () => {
    await bootReady()
    fake.views.pane.webContents.send.mockClear()
    await fake.emitWindow('web:did-navigate')
    expect(fake.views.pane.webContents.send).toHaveBeenCalledWith('pane:web-state', {
      url: 'https://example.com/',
      canGoBack: false,
      canGoForward: false,
    })
  })

  // reason: the empty page is this app's own, and its app:// URL is an
  // address the user can neither use nor go back to.
  it('shows no address for its own empty page', async () => {
    await bootReady()
    fake.web.webContents.getURL.mockReturnValue('app://pane/web.html')
    fake.views.pane.webContents.send.mockClear()
    await fake.emitWindow('web:did-navigate')
    expect(fake.views.pane.webContents.send).toHaveBeenCalledWith('pane:web-state', expect.objectContaining({ url: '' }))
  })

  // reason: an update the user only learns about by opening a window they
  // have no reason to open is one they do not learn about.
  it('looks for a newer harness at startup and puts it in the tray', async () => {
    configResult = { configured: true, config: MANAGED_STORED }
    updateCheckerMock.mockResolvedValue('9.9.9')
    await bootReady()
    await vi.waitFor(() => expect(setTrayUpdate).toHaveBeenCalledWith('9.9.9'))
  })

  it('leaves the tray alone when the harness is current', async () => {
    configResult = { configured: true, config: MANAGED_STORED }
    updateCheckerMock.mockResolvedValue(undefined)
    await bootReady()
    await settle()
    expect(setTrayUpdate).not.toHaveBeenCalled()
  })

  // reason: an offline registry is not something to interrupt a launch for.
  it('boots anyway when the lookup fails', async () => {
    configResult = { configured: true, config: MANAGED_STORED }
    updateCheckerMock.mockRejectedValue(new Error('offline'))
    const child = await bootReady()
    expect(child).toBeDefined()
  })

  it('looks for nothing when the harness is a local checkout', async () => {
    await bootReady()
    await settle()
    expect(updateCheckerMock).not.toHaveBeenCalled()
  })

  // reason: the editor column exists because a file is in it, and nothing is
  // open at launch. A stored `true` would put an empty editor on screen,
  // offering to be closed.
  // reason: a renderer's `prefers-color-scheme` answers for the document, and
  // a page that has not declared `color-scheme` is told light however the
  // machine is set — which is how these columns came up white beside a dark
  // harness. Main resolves it instead.
  it('resolves system against the machine, not the page', async () => {
    fake.nativeTheme.shouldUseDarkColors = true
    await bootReady()
    fake.views.files.webContents.send.mockClear()
    fake.sendIpc('theme:ask')
    expect(fake.views.files.webContents.send).toHaveBeenCalledWith('theme', true)
  })

  // reason: the git panel is a page of this app's own like the tree beside
  // it. Left out of the push its body never gets `data-ds-dark-theme`, every
  // `--dsw-alias-*` token resolves light, and it renders white beside a dark
  // harness — the failure 0.3.0 fixed for the Settings window.
  it('pushes the theme to every page of its own, the git panel included', async () => {
    fake.nativeTheme.shouldUseDarkColors = true
    await bootReady()
    for (const view of [fake.views.pane, fake.views.files, fake.views.git, fake.views.terminal]) {
      view.webContents.send.mockClear()
    }
    fake.sendIpc('theme:ask')
    for (const view of [fake.views.pane, fake.views.files, fake.views.git, fake.views.terminal]) {
      expect(view.webContents.send).toHaveBeenCalledWith('theme', true)
    }
  })

  it('follows the harness over the machine when it names a theme', async () => {
    fake.nativeTheme.shouldUseDarkColors = true
    harnessThemeMock.mockReturnValue('light')
    await bootReady()
    fake.views.files.webContents.send.mockClear()
    fake.sendIpc('theme:ask')
    expect(fake.views.files.webContents.send).toHaveBeenCalledWith('theme', false)
  })

  it('re-reads the theme when the machine own setting changes', async () => {
    await bootReady()
    expect(fake.nativeTheme.on).toHaveBeenCalledWith('updated', expect.any(Function))
  })

  // reason: switching to an existing session moves nothing on disk, so no
  // watcher sees it — the harness has to say so, and the plugin is what says.
  it('shows the project the harness reports it is working in', async () => {
    readWorkspacesMock.mockReturnValue([
      { path: '/p/one', title: 'one', file: '/p/one/.dsh/mcp.json', declared: false, servers: [] },
      { path: '/p/two', title: 'two', file: '/p/two/.dsh/mcp.json', declared: false, servers: [] },
    ])
    await bootReady()
    fake.views.files.webContents.send.mockClear()
    fake.sendIpc('harness:workspace', '/p/two')
    expect(fake.views.files.webContents.send).toHaveBeenCalledWith('pane:project', {
      path: '/p/two',
      title: 'two',
    })
  })

  it('ignores a directory that is not a project the harness has opened', async () => {
    readWorkspacesMock.mockReturnValue([
      { path: '/p/one', title: 'one', file: '/p/one/.dsh/mcp.json', declared: false, servers: [] },
    ])
    await bootReady()
    fake.views.files.webContents.send.mockClear()
    fake.sendIpc('harness:workspace', '/somewhere/else')
    expect(fake.views.files.webContents.send).not.toHaveBeenCalled()
  })

  it('opens at the widths the last session stored, with the editor closed', async () => {
    configResult = {
      configured: true,
      config: { ...STORED, pane: { editor: { width: 600, open: true }, files: { width: 300, open: true } } },
    }
    await bootReady()
    expect(createWindow).toHaveBeenCalledWith({
      editor: { width: 600, open: false },
      // A stored config predating the git panel names no view; the column
      // that has always been the tree opens as the tree.
      files: { width: 300, open: true, view: 'files' },
      // A stored config predating the terminal opens it closed, at its
      // default size, rather than refusing to load.
      terminal: { width: 720, height: 240, open: false },
    })
  })

  // reason: the renderer names the root it wants to read. Without this it
  // could name any directory on the disk, not just a project the user opened.
  it('lists a directory only inside a project the harness has opened', async () => {
    readWorkspacesMock.mockReturnValue([
      { path: '/p/known', title: 'known', file: '/p/known/.dsh/mcp.json', declared: false, servers: [] },
    ])
    await bootReady()
    await fake.sendIpc('pane:list-directory', '/p/known', '')
    expect(readDirectoryMock).toHaveBeenCalledWith('/p/known', '')

    readDirectoryMock.mockClear()
    expect(await fake.sendIpc('pane:list-directory', '/etc', '')).toEqual([])
    expect(readDirectoryMock).not.toHaveBeenCalled()
  })

  it('offers the pane the projects the harness has opened', async () => {
    readWorkspacesMock.mockReturnValue([
      { path: '/p/known', title: 'known', file: '/p/known/.dsh/mcp.json', declared: false, servers: [] },
    ])
    await bootReady()
    expect(await fake.sendIpc('pane:projects')).toEqual([{ path: '/p/known', title: 'known' }])
  })

  // reason: a file loaded into a hidden column would look like nothing
  // happened.
  it('opens the editor column when a file is opened into it', async () => {
    readWorkspacesMock.mockReturnValue([
      { path: '/p/known', title: 'known', file: '/p/known/.dsh/mcp.json', declared: false, servers: [] },
    ])
    await bootReady()
    fake.sendIpc('pane:open-file', '/p/known', 'readme.md')
    expect(applyLayout).toHaveBeenLastCalledWith(
      fake.views,
      expect.objectContaining({ editor: expect.objectContaining({ open: true }) }),
      expect.any(Boolean),
    )
    // The URL is how the pane shows a file it cannot read as text.
    expect(fake.views.pane.webContents.send).toHaveBeenCalledWith(
      'pane:open',
      '/p/known',
      'readme.md',
      expect.stringContaining('project'),
    )
  })
})

/**
 * The nine write channels, and the gate they all pass through.
 *
 * reason: every one of these names a repository and most name paths. A
 * renderer supplies both, and a name is not evidence — the read side was
 * already found reading `/etc/passwd` this way before `pathInRepo` existed.
 * Nine handlers each checking for themselves is nine chances to repeat that,
 * so there is one gate and these tests are of the gate through its callers.
 */
describe('the git write channels', () => {
  /**
   * A real directory to stand in for a repository.
   *
   * Real, not `/p/demo`: the gate resolves both sides through `realpath`, so a
   * repository that does not exist on disk is refused for its path before any
   * question about the file is reached — and a test using one would pass while
   * proving nothing about the path check it names.
   */
  let repo = ''

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'dsh-git-repo-'))
    mkdirSync(join(repo, 'src'))
    writeFileSync(join(repo, 'src', 'a.ts'), 'export {}\n')
  })

  /** The module's exports, once it has been imported fresh. */
  async function exports(): Promise<typeof import('./index')> {
    await loadIndex()
    if (indexModule === undefined) throw new Error('loadIndex() left no module')
    return indexModule
  }

  it('refuses a repository that is not in the open project', async () => {
    const { gitStageFor } = await exports()
    expect(await gitStageFor('/etc', ['passwd'], () => [repo])).toEqual({
      ok: false,
      reason: 'That repository is not in the open project.',
    })
    expect(stageMock).not.toHaveBeenCalled()
  })

  it('refuses a path that escapes the repository', async () => {
    const { gitStageFor } = await exports()
    expect(await gitStageFor(repo, ['../../etc/passwd'], () => [repo])).toEqual({
      ok: false,
      reason: 'That file is not in the repository.',
    })
    expect(stageMock).not.toHaveBeenCalled()
  })

  it('allows a path inside it', async () => {
    const { gitStageFor } = await exports()
    expect(await gitStageFor(repo, ['src/a.ts'], () => [repo])).toMatchObject({ ok: true })
    expect(stageMock).toHaveBeenCalledWith(repo, ['src/a.ts'])
  })

  it('refuses an absolute path even inside the repository', async () => {
    const { gitUnstageFor } = await exports()
    expect(await gitUnstageFor(repo, [join(repo, 'src/a.ts')], () => [repo])).toEqual({
      ok: false,
      reason: 'That file is not in the repository.',
    })
  })

  // reason: an untracked discard deletes the file from disk, so the list that
  // is not the tracked one is the half where an escape costs the most.
  it('checks the untracked half of a discard too', async () => {
    const { gitDiscardFor } = await exports()
    expect(await gitDiscardFor(repo, [], ['../../etc/passwd'], () => [repo])).toEqual({
      ok: false,
      reason: 'That file is not in the repository.',
    })
    expect(discardMock).not.toHaveBeenCalled()
  })

  // reason: `staged` is named by the renderer like the other two, and `commit`
  // turns it into `git restore --staged` for anything not ticked.
  it('checks every one of the commit lists', async () => {
    const { gitCommitFor } = await exports()
    expect(await gitCommitFor(repo, 'msg', [], [], ['../../etc/passwd'], () => [repo])).toEqual({
      ok: false,
      reason: 'That file is not in the repository.',
    })
    expect(commitMock).not.toHaveBeenCalled()
  })

  // reason: a file staged and then edited again has a tick in two sections
  // meaning two different contents. Collapsed into one list, `git add` would
  // stage the newer working-tree version over the one the tick preserved.
  it('keeps the staged selection separate from the added one', async () => {
    const { gitCommitFor } = await exports()
    await gitCommitFor(repo, 'msg', ['src/a.ts'], ['src/b.ts'], ['src/b.ts', 'src/c.ts'], () => [repo])
    expect(commitMock).toHaveBeenCalledWith(repo, 'msg', ['src/a.ts'], ['src/b.ts'], ['src/b.ts', 'src/c.ts'])
  })

  // reason: these name no paths, but a repository the project does not hold is
  // not one this app checks out, stashes in, or drops a stash from either.
  it('refuses a repository outside the project for the channels that name no paths', async () => {
    const index = await exports()
    const refused = { ok: false, reason: 'That repository is not in the open project.' }
    expect(await index.gitCheckoutFor('/etc', 'main', false, () => [repo])).toEqual(refused)
    expect(await index.gitCreateBranchFor('/etc', 'topic', () => [repo])).toEqual(refused)
    expect(await index.gitStashPushFor('/etc', 'wip', () => [repo])).toEqual(refused)
    expect(await index.gitStashApplyFor('/etc', 'stash@{0}', false, () => [repo])).toEqual(refused)
    expect(await index.gitStashDropFor('/etc', 'stash@{0}', () => [repo])).toEqual(refused)
    for (const mock of [checkoutMock, createBranchMock, pushStashMock, applyStashMock, dropStashMock]) {
      expect(mock).not.toHaveBeenCalled()
    }
  })

  // reason: a remote-tracking branch needs `--track`, and plain checkout of a
  // remote ref detaches HEAD instead of creating the local branch. The flag
  // has to survive the whole way from the row to `checkout`.
  it('carries the remote flag through to the checkout', async () => {
    const { gitCheckoutFor } = await exports()
    await gitCheckoutFor(repo, 'origin/feature', true, () => [repo])
    expect(checkoutMock).toHaveBeenCalledWith(repo, 'origin/feature', true)
  })

  /** Boot with one project open and one repository discovered in it. */
  async function bootWithRepo(): Promise<void> {
    readWorkspacesMock.mockReturnValue([
      { path: '/p/known', title: 'known', file: '/p/known/.dsh/mcp.json', declared: false, servers: [] },
    ])
    findReposMock.mockReturnValue([repo])
    await bootReady()
    fake.sendIpc('harness:workspace', '/p/known')
    await settle()
  }

  it('refuses over the channel, not only in the helper', async () => {
    await bootWithRepo()
    await expect(fake.sendIpc('git:stage', '/etc', ['passwd'])).resolves.toEqual({
      ok: false,
      reason: 'That repository is not in the open project.',
    })
    expect(stageMock).not.toHaveBeenCalled()
  })

  it('stages over the channel when the repository is one the project holds', async () => {
    await bootWithRepo()
    await expect(fake.sendIpc('git:stage', repo, ['src/a.ts'])).resolves.toEqual({ ok: true })
    expect(stageMock).toHaveBeenCalledWith(repo, ['src/a.ts'])
  })

  // reason: a confirmation a renderer could answer for itself is not a
  // confirmation. Discard throws work away with nothing in the reflog, so the
  // dialog is raised in main and Cancel means nothing ran.
  it('discards nothing when the confirmation is cancelled', async () => {
    await bootWithRepo()
    await expect(fake.sendIpc('git:discard', repo, ['src/a.ts'], [])).resolves.toEqual({ ok: false, reason: '' })
    expect(fake.showMessageBox).toHaveBeenCalled()
    expect(discardMock).not.toHaveBeenCalled()
  })

  it('discards once the confirmation is accepted', async () => {
    await bootWithRepo()
    fake.showMessageBox.mockResolvedValue({ response: 0 })
    await expect(fake.sendIpc('git:discard', repo, ['src/a.ts'], ['scratch.txt'])).resolves.toEqual({ ok: true })
    expect(discardMock).toHaveBeenCalledWith(repo, ['src/a.ts'], ['scratch.txt'])
  })

  // reason: the prompt is itself a thing a hostile page could use — a dialog
  // naming a plausible file, with Discard under the pointer. A repository the
  // project does not hold must not raise one at all.
  it('raises no dialog for a repository outside the project', async () => {
    await bootWithRepo()
    await expect(fake.sendIpc('git:discard', '/etc', ['passwd'], [])).resolves.toEqual({
      ok: false,
      reason: 'That repository is not in the open project.',
    })
    expect(fake.showMessageBox).not.toHaveBeenCalled()
  })

  it('drops no stash when the confirmation is cancelled', async () => {
    await bootWithRepo()
    await expect(fake.sendIpc('git:stash-drop', repo, 'stash@{0}')).resolves.toEqual({ ok: false, reason: '' })
    expect(fake.showMessageBox).toHaveBeenCalled()
    expect(dropStashMock).not.toHaveBeenCalled()
  })

  it('drops the stash once the confirmation is accepted', async () => {
    await bootWithRepo()
    fake.showMessageBox.mockResolvedValue({ response: 0 })
    await expect(fake.sendIpc('git:stash-drop', repo, 'stash@{0}')).resolves.toEqual({ ok: true })
    expect(dropStashMock).toHaveBeenCalledWith(repo, 'stash@{0}')
  })

  // reason: the action is exactly what makes what the panel is showing stale.
  it('tells the panel to read itself again after a write', async () => {
    await bootWithRepo()
    fake.sendIpc('shell:toggle-git')
    fake.views.git.webContents.send.mockClear()
    await fake.sendIpc('git:unstage', repo, ['src/a.ts'])
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(fake.views.git.webContents.send).toHaveBeenCalledWith('git:changed')
  })
})
