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
/**
 * Stops the harness child while it is still booting, i.e. after `spawn()` but
 * before `startServer()` resolves into `server`. Without this, quitting during
 * that window leaves a detached child (and its node-pty grandchildren) behind:
 * `before-quit` only knows to stop `server`, which is still `undefined`.
 */
let pendingStop: (() => Promise<void>) | undefined
let quitting = false

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
      onSpawned: (stop) => {
        pendingStop = stop
      },
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
    pendingStop = undefined
    showError(window, 'The harness failed to start', (error as Error).message)
    return
  }

  pendingStop = undefined
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
}
