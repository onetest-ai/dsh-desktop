import { app, BrowserWindow, dialog, globalShortcut, Notification } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig, writeConfig, type ConfigResult, type DesktopConfig } from './config'
import { ConfigurationError } from './configuration-error'
import { configPath, resolveDshHome, type HarnessSource } from './harness-source'
import { createManagedInstaller, createUpdateChecker } from './managed-install'
import { portIsFree, startNotifyListener, type NotifyServer } from './notify'
import { preflight } from './preflight'
import { writeRuntimeFiles } from './runtime-files'
import type { InstallDeps } from './runtime-install'
import { dshWebCommand, resolveBinary, startServer } from './server'
import { createSettingsHandlers } from './settings-ipc'
import { openSettings } from './settings-window'
import { singleFlight } from './single-flight'
import { createTray, type TrayController } from './tray'
import { createWindow, installMenu, showError } from './window'
import type { ServerStatus } from './status'

/** The config lives under `$DSH_HOME` (see `configPath`), beside the harness's own state. */
const CONFIG_PATH = configPath(process.env)

/** Where a managed harness install lives; see `managedDir`. */
const DSH_HOME = resolveDshHome(process.env)

/** How long the harness may take to report its URL. */
const READY_TIMEOUT_MS = 60_000

let window: BrowserWindow | undefined
let quitting = false
let tray: TrayController | undefined
let notifier: NotifyServer | undefined
/** A deep link that arrived before the window existed; see the `open-url` handler. */
let deepLinkPending = false

/**
 * Whether two harness sources differ, compared field by field so a config
 * file with reordered (but identical) keys never looks like a change.
 *
 * The `default` branch covers one axis only: it fails to compile if
 * `HarnessSource` grows a new `kind` without a case here. A new *field* on an
 * existing kind still compiles — structural typing lets the extra property
 * through — and would be silently treated as unchanged, so every field added
 * to an arm must be added to its comparison by hand.
 * @param previous - the source being replaced.
 * @param next - the source just configured.
 * @returns whether the two differ.
 */
function harnessSourceChanged(previous: HarnessSource, next: HarnessSource): boolean {
  if (previous.kind !== next.kind) return true
  switch (next.kind) {
    case 'local': {
      const prev = previous as Extract<HarnessSource, { kind: 'local' }>
      return prev.repo !== next.repo
    }
    case 'managed': {
      const prev = previous as Extract<HarnessSource, { kind: 'managed' }>
      return prev.package !== next.package || prev.version !== next.version || prev.workspace !== next.workspace
    }
    default: {
      const exhaustive: never = next
      return exhaustive
    }
  }
}

/** Whether two configs differ in a way that requires respawning the harness child. */
function needsRestart(previous: DesktopConfig | undefined, next: DesktopConfig): boolean {
  if (previous === undefined) return true
  return (
    harnessSourceChanged(previous.harness, next.harness) ||
    // The notify port is baked into the generated hooks.json at boot, so a
    // changed port only reaches the harness through a respawn.
    previous.notifyPort !== next.notifyPort ||
    // Both binaries are resolved when the child is spawned.
    previous.pnpmPath !== next.pnpmPath ||
    previous.npmPath !== next.npmPath
  )
}

/**
 * Apply saved settings to the running app.
 *
 * Harness-affecting changes go through `restart`, the same serialized
 * transition the tray's Restart uses, so a save can never interleave with a
 * boot, another restart, or shutdown.
 *
 * `quitting` is re-checked after every `await` and before every side effect:
 * the save's own check happens before the write, but a quit landing during any
 * of these awaits has already run `will-quit`, so a listener bound afterwards
 * is younger than the teardown that would have closed it and a hotkey armed
 * afterwards outlives `unregisterAll()`.
 * @param previous - the config being replaced, or undefined on a first run.
 * @param next - the config just written to disk.
 * @returns non-blocking warnings for the settings form to display.
 */
export async function applySettings(previous: DesktopConfig | undefined, next: DesktopConfig): Promise<string[]> {
  const warnings: string[] = []
  if (needsRestart(previous, next)) {
    // restart() reports 'starting' on the tray for the whole respawn window;
    // inlining stop-then-boot here would leave a stale 'running' dot up for as
    // long as the readiness timeout.
    await restart()
  }

  if (!quitting && previous?.notifyPort !== next.notifyPort) {
    await notifier?.close()
    notifier = undefined
    if (!quitting) {
      try {
        const started = await startNotifyListener(next.notifyPort, onTurnEnd)
        if (quitting) {
          // `will-quit` already closed whatever it knew about; this listener
          // was bound after that, so nothing else would ever close it.
          await started.close()
        } else {
          notifier = started
        }
      } catch (error) {
        warnings.push((error as Error).message)
      }
    }
  }

  if (!quitting && previous?.hotkey !== next.hotkey) {
    globalShortcut.unregisterAll()
    if (!globalShortcut.register(next.hotkey, toggleWindow)) {
      warnings.push(`The hotkey ${next.hotkey} could not be registered; another app already owns it.`)
      // unregisterAll() already dropped the previous binding, so without this
      // the app would silently end up with no hotkey at all; re-arm the one
      // that was working rather than leave the user with nothing bound.
      if (previous !== undefined && !globalShortcut.register(previous.hotkey, toggleWindow)) {
        // Both accelerators are gone: the user has no hotkey at all, which is
        // exactly the state the save result is supposed to name.
        warnings.push(
          `The previous hotkey ${previous.hotkey} could not be restored either; no show/hide shortcut is bound.`,
        )
      }
    }
  }

  return warnings
}

/**
 * Run a command to completion, feeding every combined stdout/stderr line to
 * `onLine` as it arrives, for `runtime-install.ts`'s injected `InstallDeps`.
 * @param command - the binary to run.
 * @param args - its arguments.
 * @param options - working directory, environment, and a per-line callback.
 * @returns the completed run's exit code and captured output.
 */
function runInstallCommand(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; onLine?: (line: string) => void },
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env })
    let stdout = ''
    let stderr = ''
    let buffer = ''
    const feed = (chunk: Buffer): void => {
      buffer += chunk.toString('utf8')
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) options.onLine?.(line)
    }
    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
      feed(chunk)
    })
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
      feed(chunk)
    })
    proc.on('error', (cause) => reject(new Error(`dsh-desktop: failed to spawn ${command}`, { cause })))
    proc.on('close', (code) => {
      if (buffer !== '') options.onLine?.(buffer)
      resolve({ code: code ?? 1, stdout, stderr })
    })
  })
}

/** Real `InstallDeps`, backing `runtime-install.ts`'s effects with the actual filesystem and `npm`. */
const installDeps: InstallDeps = {
  run: runInstallCommand,
  exists: existsSync,
  mkdir: (path) => mkdirSync(path, { recursive: true }),
}

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
  installManaged: (pkg, version, npmPath, onLine) =>
    createManagedInstaller(installDeps, resolveBinary(npmPath, 'npm', process.env), DSH_HOME)(pkg, version, onLine),
  checkManagedUpdate: (pkg, installed, npmPath) =>
    createUpdateChecker(installDeps, resolveBinary(npmPath, 'npm', process.env))(pkg, installed),
})

/**
 * The harness child this app owns, from `spawn()` until it is stopped.
 *
 * It is set the moment the child exists — before readiness — so the quit path
 * can always reap it; without that, quitting mid-boot leaves a detached child
 * (and its node-pty grandchildren) behind.
 */
interface Child {
  /** Which `boot` produced this child; see `generation`. */
  generation: number
  stop(): Promise<void>
}
let child: Child | undefined

/**
 * Incremented for every child the app starts and every stop it performs.
 *
 * A child's `'exit'` can arrive after its replacement is already running, so
 * every callback checks its own generation against this counter and does
 * nothing when it has been superseded. Without that check a dead child's
 * `onExit` overwrites the live child's state, which both misreports the UI and
 * hides the live child from the quit path — orphaning its process group.
 */
let generation = 0

/**
 * Tail of the serialized lifecycle chain.
 *
 * Every async transition (boot, restart, the final stop) runs through
 * `enqueue`, so transitions never interleave and `before-quit` can make itself
 * the last link: a quit is therefore always ordered after whatever transition
 * is in flight, instead of racing an `await` that leaves the app looking idle.
 */
let transition: Promise<void> = Promise.resolve()

/**
 * Append a lifecycle step to the serialized chain.
 * @param step - the transition to run once the chain is free.
 * @returns a promise that settles when this step is done; it never rejects.
 */
function enqueue(step: () => Promise<void>): Promise<void> {
  const next = transition.then(step).catch((error: unknown) => {
    console.error('dsh-desktop: lifecycle step failed', error)
  })
  transition = next
  return next
}

/**
 * Report the server status through the tray.
 * @param next - the new status.
 */
function setStatus(next: ServerStatus): void {
  tray?.setStatus(next)
}

/**
 * Report a failure in the window, if one is still there to report it in.
 * @param title - short failure summary.
 * @param detail - remedy text or captured stderr.
 */
function fail(title: string, detail: string): void {
  setStatus('failed')
  if (window !== undefined && !window.isDestroyed()) showError(window, title, detail)
}

/**
 * Report a failure the user can fix in Settings, and open it so the fix is
 * one step away.
 *
 * Reserved for configuration-class failures: an unreadable or invalid config,
 * a checkout that is missing or unbuilt, or a launcher that cannot be
 * resolved. A harness that was configured correctly and then crashed or timed
 * out goes through `fail` alone — reopening Settings there would be noise
 * over a problem Settings cannot fix, and the existing retry pane (Restart in
 * the tray) is the right response.
 * @param title - short failure summary.
 * @param detail - remedy text.
 */
function failConfiguration(title: string, detail: string): void {
  fail(title, detail)
  showSettings()
}

/** Bring the window to the front. */
function revealWindow(): void {
  if (window === undefined || window.isDestroyed()) return
  window.show()
  window.focus()
}

/** Where the generated patch overlay and hook config are written. */
function runtimeDirectory(): string {
  return join(app.getPath('userData'), 'runtime')
}

/**
 * Stop the child this app currently owns and retire its generation.
 * @returns a promise that settles once the child's process group is gone.
 */
async function stopCurrent(): Promise<void> {
  const stopping = child
  child = undefined
  generation += 1
  await stopping?.stop()
}

/**
 * Start the harness and point the window at it.
 * Runs only inside `enqueue`, so it can assume no other transition is active.
 */
async function bootNow(): Promise<void> {
  if (quitting) return
  if (window === undefined || window.isDestroyed()) return

  let config: DesktopConfig
  try {
    const result = loadConfig(CONFIG_PATH)
    if (!result.configured) {
      // The config was removed or never saved; settings is the only useful
      // thing to show until the user configures a harness.
      showSettings()
      return
    }
    config = result.config
  } catch (error) {
    failConfiguration('Configuration problem', (error as Error).message)
    return
  }

  const check = preflight(config.harness)
  if (!check.ok) {
    failConfiguration('The harness checkout is not ready', check.message)
    return
  }

  const mine = (generation += 1)

  let patchPath: string
  try {
    patchPath = writeRuntimeFiles(runtimeDirectory(), config.notifyPort).patchPath
  } catch (error) {
    fail('The harness launch files could not be written', (error as Error).message)
    return
  }

  try {
    const handle = await startServer({
      spec: dshWebCommand(config, patchPath, DSH_HOME),
      timeoutMs: READY_TIMEOUT_MS,
      onSpawned: (stop) => {
        child = { generation: mine, stop }
      },
      onExit: (code, tail) => {
        if (mine !== generation) return
        child = undefined
        fail(`The harness exited (code ${String(code)})`, tail || 'No output captured.')
      },
    })
    if (mine !== generation) {
      // A stop overtook this boot; the child is already being reaped elsewhere.
      return
    }
    setStatus('running')
    if (window !== undefined && !window.isDestroyed()) void window.loadURL(handle.url)
  } catch (error) {
    if (mine !== generation) return
    // The rejection paths (readiness timeout, early exit) can leave a child
    // mid-death, so it is reaped here rather than merely forgotten.
    await stopCurrent()
    // A ConfigurationError here means `dshWebCommand` could not resolve the
    // configured launcher — a config mistake, fixed in Settings. Every other
    // rejection (readiness timeout, early exit, spawn ENOENT) means a
    // correctly configured harness misbehaved after actually being launched,
    // which Settings cannot fix.
    if (error instanceof ConfigurationError) {
      failConfiguration('The harness failed to start', error.message)
    } else {
      fail('The harness failed to start', (error as Error).message)
    }
  }
}

/**
 * Stop the current server (if any) and boot a fresh one.
 *
 * The whole stop-then-boot sequence is one link in the lifecycle chain, so a
 * quit arriving inside the stop window is ordered after it instead of finding
 * no child to reap and letting the queued boot spawn one behind its back.
 */
async function restart(): Promise<void> {
  await enqueue(async () => {
    await stopCurrent()
    setStatus('starting')
    await bootNow()
  })
}

/**
 * Reap the harness and let every in-flight transition unwind, before quitting.
 *
 * `quitting` is set first and synchronously, so a transition still queued
 * behind this one cannot spawn anything the quit would not know about. The
 * child is then stopped directly rather than through `enqueue`: a boot waits
 * on its child's readiness, so queuing the reap behind it would make the quit
 * wait out the readiness timeout instead of cutting the boot short. Stopping
 * the child is what lets that boot unwind — its `startServer` rejects once the
 * child is gone — which is why the chain is only awaited afterwards.
 * @returns a promise that settles once nothing of this app's is left running.
 */
async function shutdown(): Promise<void> {
  quitting = true
  await stopCurrent()
  await transition
  // A transition that was mid-flight may have registered a child of its own
  // between the stop above and its own quitting check.
  await stopCurrent()
}

/** Serialized entry point for the tray's "Restart harness" action; see `restart`. */
const restartOnce = singleFlight(restart)

/**
 * Open settings, quitting if a first run closes it without configuring anything.
 *
 * An unreadable config is deliberately not a quit: it means a real config may
 * exist and merely be broken, and quitting would take away the one window that
 * can repair it. The app stays in the tray, where Settings is reachable again.
 */
function showSettings(): void {
  openSettings(settingsHandlers, () => {
    let stored: ConfigResult
    try {
      stored = loadConfig(CONFIG_PATH)
    } catch (error) {
      console.warn((error as Error).message)
      return
    }
    if (!stored.configured) app.quit()
  })
}

/** Show the window if hidden or unfocused, otherwise hide it. */
function toggleWindow(): void {
  if (window === undefined || window.isDestroyed()) return
  if (window.isVisible() && window.isFocused()) {
    window.hide()
    return
  }
  revealWindow()
}

/** Raise a turn-complete notification, but only when the user is looking elsewhere. */
function onTurnEnd(): void {
  console.log(`[notify] turn-end ping received at ${new Date().toISOString()}`)
  if (window === undefined || window.isDestroyed()) return
  if (window.isFocused()) return
  new Notification({ title: 'DeepSeek Harness', body: 'The agent finished its turn.' }).show()
}

/**
 * Read the configured hotkey, tolerating a broken config.
 * @returns the accelerator, or undefined when unavailable.
 */
function safeHotkey(): string | undefined {
  try {
    const result = loadConfig(CONFIG_PATH)
    return result.configured ? result.config.hotkey : undefined
  } catch {
    // boot() reports config failures in the window; the hotkey just goes unbound.
    return undefined
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (window === undefined || window.isDestroyed()) return
    if (window.isMinimized()) window.restore()
    window.focus()
  })

  app.setAsDefaultProtocolClient('dsh')

  // macOS delivers deep links through open-url, not argv.
  app.on('open-url', (event) => {
    event.preventDefault()
    if (window === undefined || window.isDestroyed()) {
      // A cold-start link arrives before whenReady, so there is nothing to
      // raise yet; the window applies it once it exists.
      deepLinkPending = true
      return
    }
    revealWindow()
  })

  void app.whenReady().then(async () => {
    installMenu(showSettings)
    window = createWindow()
    window.on('close', (event) => {
      // Closing the window leaves the app running in the tray; only a quit,
      // which sets `quitting` first, may actually destroy it.
      if (quitting) return
      event.preventDefault()
      if (window !== undefined && !window.isDestroyed()) window.hide()
    })
    window.on('closed', () => {
      window = undefined
    })
    tray = createTray({
      toggleWindow,
      restart: () => void restartOnce(),
      openSettings: showSettings,
      quit: () => app.quit(),
    })
    const hotkey = safeHotkey()
    if (hotkey !== undefined && !globalShortcut.register(hotkey, toggleWindow)) {
      console.warn(`dsh-desktop: the hotkey ${hotkey} could not be registered; another app already owns it.`)
    }
    try {
      const result = loadConfig(CONFIG_PATH)
      if (result.configured) {
        notifier = await startNotifyListener(result.config.notifyPort, onTurnEnd)
      }
    } catch (error) {
      console.warn((error as Error).message)
    }
    if (deepLinkPending) {
      deepLinkPending = false
      revealWindow()
    }
    let stored: ConfigResult
    try {
      stored = loadConfig(CONFIG_PATH)
    } catch (error) {
      // Without this the voided whenReady handler would simply reject: no
      // boot, no error pane, no settings window — a hidden window and a tray
      // icon, with no way to reach the form that fixes the config.
      failConfiguration('Configuration problem', (error as Error).message)
      return
    }
    if (!stored.configured) {
      // Nothing to boot and nothing to show until the user says where the
      // harness lives, so settings is the whole app until it is saved.
      showSettings()
      return
    }
    await enqueue(bootNow)
  })

  // The window is hidden rather than closed, so this only fires on the way out;
  // the app stays in the tray instead of quitting with its last window.
  app.on('window-all-closed', () => {})

  app.on('activate', () => revealWindow())

  app.on('before-quit', async (event) => {
    if (quitting) return
    event.preventDefault()
    await shutdown()
    app.quit()
  })

  app.on('will-quit', () => {
    globalShortcut.unregisterAll()
    tray?.destroy()
    void notifier?.close()
  })
}
