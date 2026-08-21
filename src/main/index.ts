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
