import { app, BrowserWindow, globalShortcut, Notification } from 'electron'
import { join } from 'node:path'
import { loadConfig, type DesktopConfig } from './config'
import { startNotifyListener, type NotifyServer } from './notify'
import { preflight } from './preflight'
import { dshWebCommand, startServer, type ServerHandle } from './server'
import { singleFlight } from './single-flight'
import { createTray, type TrayController } from './tray'
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
/**
 * Stops the harness child while it is still booting, i.e. after `spawn()` but
 * before `startServer()` resolves into `server`. Without this, quitting during
 * that window leaves a detached child (and its node-pty grandchildren) behind:
 * `before-quit` only knows to stop `server`, which is still `undefined`.
 */
let pendingStop: (() => Promise<void>) | undefined
let quitting = false
let tray: TrayController | undefined
let notifier: NotifyServer | undefined

/**
 * Record the server status and mirror it into the tray.
 * @param next - the new status.
 */
function setStatus(next: ServerStatus): void {
  status = next
  tray?.setStatus(next)
}

async function boot(): Promise<void> {
  if (window === undefined || window.isDestroyed()) return

  let config: DesktopConfig
  try {
    config = loadConfig(CONFIG_PATH)
  } catch (error) {
    setStatus('failed')
    showError(window, 'Configuration problem', (error as Error).message)
    return
  }

  const check = preflight(config.harnessRepo)
  if (!check.ok) {
    setStatus('failed')
    showError(window, 'The harness checkout is not ready', check.message)
    return
  }

  try {
    server = await startServer({
      spec: dshWebCommand(config, PATCH_PATH),
      timeoutMs: READY_TIMEOUT_MS,
      onSpawned: (stop) => {
        pendingStop = stop
      },
      onExit: (code, tail) => {
        setStatus('failed')
        server = undefined
        if (window !== undefined && !window.isDestroyed()) {
          showError(window, `The harness exited (code ${String(code)})`, tail || 'No output captured.')
        }
      },
    })
  } catch (error) {
    setStatus('failed')
    pendingStop = undefined
    showError(window, 'The harness failed to start', (error as Error).message)
    return
  }

  pendingStop = undefined
  setStatus('running')
  if (window !== undefined && !window.isDestroyed()) void window.loadURL(server.url)
}

/**
 * Stop the current server (if any) and boot a fresh one.
 * Wrapped in `singleFlight` at its call site: two "Restart harness" clicks in
 * quick succession must not race on the shared `server`/`pendingStop` state
 * and spawn two harness children, one of which `before-quit` could not find.
 */
async function restart(): Promise<void> {
  const stopping = server
  server = undefined
  await stopping?.stop()
  setStatus('starting')
  await boot()
}

/** Serialized entry point for the tray's "Restart harness" action; see `restart`. */
const restartOnce = singleFlight(restart)

/** Show the window if hidden or unfocused, otherwise hide it. */
function toggleWindow(): void {
  if (window === undefined || window.isDestroyed()) return
  if (window.isVisible() && window.isFocused()) {
    window.hide()
    return
  }
  window.show()
  window.focus()
}

/** Raise a turn-complete notification, but only when the user is looking elsewhere. */
function onTurnEnd(): void {
  if (window?.isFocused() === true) return
  new Notification({ title: 'DeepSeek Harness', body: 'The agent finished its turn.' }).show()
}

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
    window.on('closed', () => {
      window = undefined
    })
    tray = createTray({
      toggleWindow,
      restart: () => void restartOnce(),
      quit: () => app.quit(),
    })
    const hotkey = safeHotkey()
    if (hotkey !== undefined) globalShortcut.register(hotkey, toggleWindow)
    try {
      notifier = await startNotifyListener(loadConfig(CONFIG_PATH).notifyPort, onTurnEnd)
    } catch (error) {
      console.warn((error as Error).message)
    }
    await boot()
  })

  app.on('window-all-closed', () => app.quit())

  app.on('before-quit', async (event) => {
    if (quitting) return
    const stop = server?.stop ?? pendingStop
    if (stop === undefined) return
    quitting = true
    event.preventDefault()
    server = undefined
    pendingStop = undefined
    await stop()
    app.quit()
  })

  app.on('will-quit', () => {
    globalShortcut.unregisterAll()
    tray?.destroy()
    void notifier?.close()
  })
}
