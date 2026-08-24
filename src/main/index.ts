import { app, BrowserWindow, dialog, globalShortcut, Notification, shell } from 'electron'
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { checkBinaries } from './check-binaries'
import { loadConfig, writeConfig, type ConfigResult, type DesktopConfig } from './config'
import { ConfigurationError } from './configuration-error'
import { configPath, PROFILE, resolveDshHome, type HarnessSource } from './harness-source'
import { createInstallRunner } from './install-process'
import { createManagedInstaller, createUpdateChecker } from './managed-install'
import { portIsFree, startNotifyListener, type NotifyServer } from './notify'
import { openConfigFile } from './open-config-file'
import { HOOKS_PACKAGE, parseSpec, pluginInstallMarker, pluginStatus, type PluginEntry, type PluginStatus } from './plugin-entries'
import { ensurePluginLink, reconcilePluginLinks } from './plugin-link'
import { preflight } from './preflight'
import { attributeBootFailure, runtimeFilePaths, writeRuntimeFiles } from './runtime-files'
import type { InstallDeps } from './runtime-install'
import { dshWebCommand, resolveBinary, startServer, type ServerHandle } from './server'
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

/** How long the Advanced tab's Check button waits for `pnpm --version`/`npm --version` before treating a binary as hung. */
const CHECK_BINARY_TIMEOUT_MS = 10_000

/**
 * How many extra attempts `bootNow` may make beyond the primary one when a
 * server-stage failure is attributable, or falls back, to dropping plugins.
 *
 * Bounds worst-case boot time to `(1 + MAX_ISOLATION_ATTEMPTS) *
 * READY_TIMEOUT_MS` regardless of how many plugins are configured: without a
 * cap, a config with many independently broken plugins could isolate one per
 * attempt forever, each attempt paying a full readiness timeout. Two extra
 * attempts covers the realistic cases this feature exists for — one bad
 * plugin, or two whose failures surface one after the other — while the
 * unattributable-failure fallback (drop every remaining plugin at once)
 * always guarantees a bounded final attempt reaches a plugin-free boot.
 */
const MAX_ISOLATION_ATTEMPTS = 2

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

/** Whether two plugin lists differ in spec or resolved version, order-sensitively. */
function pluginsChanged(previous: PluginEntry[], next: PluginEntry[]): boolean {
  if (previous.length !== next.length) return true
  return previous.some((entry, index) => entry.spec !== next[index].spec || entry.version !== next[index].version)
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
    previous.npmPath !== next.npmPath ||
    // Every entry's resolved entry file is baked into the generated overlay
    // at boot, so a newly resolved or reordered list only reaches the
    // harness child through a respawn.
    pluginsChanged(previous.plugins ?? [], next.plugins ?? [])
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
 * Owns every `npm` child a managed install spawns.
 *
 * Held at module scope, not inside the installer, because the quit path has to
 * reach it: an install runs for minutes, and `shutdown` reaps these children
 * alongside the harness child rather than letting them outlive the app.
 */
const installs = createInstallRunner()

/** Real `InstallDeps`, backing `runtime-install.ts`'s effects with the actual filesystem and `npm`. */
const installDeps: InstallDeps = {
  run: (command, args, options) => installs.run(command, args, options),
  exists: existsSync,
  mkdir: (path) => mkdirSync(path, { recursive: true }),
  rm: (path) => rmSync(path, { recursive: true, force: true }),
  rename: renameSync,
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
  installPlugin: (pkg, version, npmPath, onLine) =>
    createManagedInstaller(
      installDeps,
      resolveBinary(npmPath, 'npm', process.env),
      DSH_HOME,
      // A plugin entry links no `bin`, so its completion marker cannot be
      // the default `dsh` binary check; see `plugin-entries.ts`'s own doc.
      (dir) => pluginInstallMarker(dir, pkg),
    )(pkg, version, onLine),
  checkManagedUpdate: (pkg, installed, npmPath) =>
    createUpdateChecker(installDeps, resolveBinary(npmPath, 'npm', process.env))(pkg, installed),
  checkBinaries: (pnpmPath, npmPath) => checkBinaries(pnpmPath, npmPath, process.env, CHECK_BINARY_TIMEOUT_MS),
  disabledPlugins: () => Object.fromEntries(disabledPlugins),
  openConfigFile: () => openConfigFile(CONFIG_PATH, existsSync, (path) => shell.openPath(path)),
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
 * Why each currently-configured plugin is not mounted in the running
 * harness, keyed by package name; absent means the entry is either mounted
 * or not configured at all.
 *
 * Held at module scope, not on the settings window: a boot's outcome must
 * reach a Settings window opened long after that boot finished, and this is
 * what `read()` (via `SettingsDeps.disabledPlugins`) consults regardless of
 * whether any window existed when the boot happened. Replaced wholesale by
 * `recordDisabledPlugins` at the end of every boot attempt that reaches a
 * final outcome — never merged — so a plugin that starts working again after
 * a later boot cannot leave a stale reason behind.
 */
let disabledPlugins = new Map<string, string>()

/**
 * Replace the disabled-plugin state a Settings window reads, from a single
 * boot attempt's own knowledge: entries the overlay never tried to mount
 * (pre-flight `omitted`, e.g. not installed yet) and entries this boot
 * isolated after attributing a runtime failure to them.
 * @param omitted - pre-flight omissions from the attempt that ultimately ran.
 * @param isolated - package/reason pairs isolated during this boot's retries.
 */
/**
 * A tray-sized summary of the plugins that were dropped.
 *
 * The harness's own reason is a full error, stack trace included, and a menu
 * item renders its label on one unwrapped line — pasting the reason there
 * stretches the menu across the screen. The reason belongs on the plugin's
 * row in Settings, which shows it in full; the tray only says which plugins
 * are affected and where to look.
 * @param isolated - the entries dropped to get the harness running.
 * @returns a short note, or an empty string when nothing was dropped.
 */
function summariseDisabled(isolated: readonly { package: string }[]): string {
  if (isolated.length === 0) return ''
  const names = isolated.map((entry) => entry.package)
  const listed = names.length <= 2 ? names.join(' and ') : `${names.length} plugins`
  return `${listed} disabled — see Settings for why`
}

function recordDisabledPlugins(omitted: { package: string; reason: string }[], isolated: { package: string; reason: string }[]): void {
  disabledPlugins = new Map([...omitted, ...isolated].map((entry) => [entry.package, entry.reason]))
}

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
 * @param note - a non-blocking condition discovered at boot, shown alongside
 *   the status; omit when there is none.
 */
function setStatus(next: ServerStatus, note?: string): void {
  if (note === undefined) tray?.setStatus(next)
  else tray?.setStatus(next, note)
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

  const attempt = await attemptBoot(config, mine, new Set())

  if (attempt.ok) {
    if (mine !== generation) {
      // A stop overtook this boot; the child is already being reaped elsewhere.
      return
    }
    recordDisabledPlugins(attempt.omitted, [])
    setStatus('running', attempt.hooksNote)
    if (window !== undefined && !window.isDestroyed()) void window.loadURL(attempt.handle.url)
    return
  }

  if (attempt.stage === 'files') {
    fail('The harness launch files could not be written', attempt.message)
    return
  }

  // attempt.stage === 'server'
  if (mine !== generation) return
  // The rejection paths (readiness timeout, early exit) can leave a child
  // mid-death, so it is reaped here rather than merely forgotten. This is
  // also every retry's own generation token from here on: `stopCurrent`
  // always advances `generation`, so `mine` itself can never match it again
  // — each retry needs a fresh baseline captured right after this expected
  // bump, not the boot's original token, to tell a legitimate advance (this
  // reap) from an illegitimate one (a newer transition superseding this
  // attempt).
  await stopCurrent()
  let token = generation

  // A ConfigurationError means `dshWebCommand` could not resolve the
  // configured launcher — a config mistake unrelated to plugins, fixed in
  // Settings; a bad harness path must still fail fast, not after a second
  // full timeout. Every other rejection (readiness timeout, early exit,
  // spawn ENOENT) means a correctly configured launcher started something
  // that then failed, which — when the overlay had inserted at least one
  // plugin — is retried, isolating the plugin the error attributes the
  // failure to (see `attributeBootFailure`) rather than dropping every
  // plugin: the app holds that a broken plugin costs its own feature, never
  // the whole app, and a plugin that loads but rejects its config is exactly
  // that case, just discovered one step later than the loadability probe
  // alone catches. When a failure names no identifiable plugin, every
  // remaining candidate is dropped at once — the old drop-all behavior,
  // still reported below via `isolated`.
  let current: BootAttempt = attempt
  const excluded = new Set<string>()
  const isolated: { package: string; reason: string }[] = []
  let attemptsMade = 1

  while (
    current.stage === 'server' &&
    current.insertedCount > 0 &&
    !(current.error instanceof ConfigurationError) &&
    !quitting &&
    attemptsMade < 1 + MAX_ISOLATION_ATTEMPTS
  ) {
    const survivors = current.ready.filter((entry) => !excluded.has(entry.package))
    const culprit = attributeBootFailure(current.error.message, survivors)
    if (culprit !== undefined) {
      excluded.add(culprit)
      isolated.push({ package: culprit, reason: current.error.message })
    } else {
      // Unattributable: falling back to dropping every plugin still standing
      // is reported the same as an attributed isolation, via `isolated`, so
      // the user still learns plugins were disabled and why, even though the
      // "why" here is the harness's own undifferentiated failure rather than
      // a single named cause.
      for (const entry of survivors) {
        excluded.add(entry.package)
        isolated.push({ package: entry.package, reason: current.error.message })
      }
    }

    attemptsMade += 1
    const retry = await attemptBoot(config, token, excluded)

    if (token !== generation) {
      // Superseded (a newer boot, restart, or shutdown landed mid-retry) —
      // the retry's child, if any, must still be reaped rather than left
      // running unreported.
      if (retry.ok) await stopCurrent()
      return
    }

    if (retry.ok) {
      recordDisabledPlugins(retry.omitted, isolated)
      setStatus(
        'running',
        [retry.hooksNote, summariseDisabled(isolated)]
          .filter((note): note is string => note !== undefined && note !== '')
          .join('; '),
      )
      if (window !== undefined && !window.isDestroyed()) void window.loadURL(retry.handle.url)
      return
    }

    if (retry.stage === 'files') {
      // Unreachable in practice — the primary attempt already wrote these
      // files successfully — but handled the same way a primary files
      // failure is, rather than left to fall through as a server failure.
      fail('The harness launch files could not be written', retry.message)
      return
    }

    await stopCurrent()
    token = generation
    current = retry
  }

  // Every isolation attempt is reported even though the loop is exiting on
  // an unrecoverable failure, so Settings can show why a plugin dropped
  // along the way is disabled, not just the final error pane.
  recordDisabledPlugins([], isolated)

  if (current.stage === 'server' && current.error instanceof ConfigurationError) {
    failConfiguration('The harness failed to start', current.error.message)
  } else if (current.stage === 'server') {
    fail('The harness failed to start', current.error.message)
  }
}

/** What one `attemptBoot` call produced. */
type BootAttempt =
  | { ok: true; handle: ServerHandle; hooksNote?: string; omitted: { package: string; reason: string }[] }
  | { ok: false; stage: 'files'; message: string }
  | { ok: false; stage: 'server'; error: Error; insertedCount: number; ready: { package: string; entryPath: string }[] }

/**
 * Write the runtime files and spawn the harness once, with every configured
 * plugin entry resolved except those in `excludePackages` — the shape
 * `bootNow` uses for the primary boot (empty set) and for every isolation or
 * drop-all retry (one or more packages named).
 *
 * Runs only inside `enqueue` (via `bootNow`), so it can assume no other
 * transition is active; still checks `mine !== generation` nowhere itself —
 * that is `bootNow`'s job, since only it knows whether a given attempt is
 * the primary or a retry, and only it holds the per-retry token.
 * @param config - the desktop settings this boot is starting from.
 * @param mine - this boot's generation token, closed over by `onSpawned`/`onExit`.
 * @param excludePackages - package names to leave out of the overlay
 *   entirely, as if they were never configured — empty for the primary boot.
 * @returns the outcome, discriminated by `ok` and, on failure, by `stage`.
 */
async function attemptBoot(config: DesktopConfig, mine: number, excludePackages: ReadonlySet<string>): Promise<BootAttempt> {
  let patchPath: string
  let hooksNote: string | undefined
  let omitted: { package: string; reason: string }[] = []
  let ready: { package: string; entryPath: string }[] = []
  try {
    // Where each configured plugin entry would load from, or why it is
    // unavailable — from whatever a Settings save last resolved and
    // installed; never installed here at boot. The hook bridge is
    // privileged with `configPath` pointing at the hooks file this same
    // boot is about to write; every other entry gets none.
    const { hooksPath } = runtimeFilePaths(runtimeDirectory())
    const statuses = (config.plugins ?? [])
      .filter((entry) => !excludePackages.has(parseSpec(entry.spec).package))
      .map((entry) => pluginStatus(installDeps, DSH_HOME, entry, parseSpec(entry.spec).package === HOOKS_PACKAGE ? hooksPath : undefined))
    // Linked (bare package name) whenever `ensurePluginLink` succeeds;
    // falls back to the resolved absolute entry path otherwise — a
    // permissions error, a name collision with a real install, or any other
    // failure never costs the plugin itself, only its display name. Every
    // package this boot links is collected into `linked` so the prune pass
    // below removes exactly the links that are not (or no longer) wanted.
    const linked = new Set<string>()
    const resolveName = (status: Extract<PluginStatus, { kind: 'ready' }>): string => {
      if (ensurePluginLink(DSH_HOME, PROFILE, status.package, status.packageDir)) {
        linked.add(status.package)
        return status.package
      }
      return status.entryPath
    }
    const files = writeRuntimeFiles(runtimeDirectory(), config.notifyPort, statuses, undefined, resolveName)
    reconcilePluginLinks(DSH_HOME, PROFILE, linked)
    patchPath = files.patchPath
    omitted = files.omitted
    ready = files.ready
    const bridgeOmitted = omitted.find((entry) => entry.package === HOOKS_PACKAGE)
    const otherOmitted = omitted.filter((entry) => entry.package !== HOOKS_PACKAGE)
    const notes: string[] = []
    if (bridgeOmitted !== undefined) notes.push(`notifications unavailable — hook bridge not loaded: ${bridgeOmitted.reason}`)
    for (const entry of otherOmitted) notes.push(`${entry.package} not loaded: ${entry.reason}`)
    hooksNote = notes.length > 0 ? notes.join('; ') : undefined
  } catch (error) {
    return { ok: false, stage: 'files', message: (error as Error).message }
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
    return { ok: true, handle, hooksNote, omitted }
  } catch (error) {
    const insertedCount = ready.length
    return { ok: false, stage: 'server', error: error as Error, insertedCount, ready }
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
  // The install child is reaped first and unconditionally: it is in neither
  // the lifecycle chain nor `child`, so nothing below would ever find it, and
  // an unreaped `npm` keeps writing into $DSH_HOME after Electron is gone.
  // Killing it also makes the in-flight save's install reject, which is what
  // lets that save unwind instead of finishing behind the quit's back.
  await installs.stopAll()
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
