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
 * Push one value to the settings window over a receive-only channel,
 * tolerating a window that has since closed. A managed install runs for
 * minutes; the window can be gone by the time a later line arrives.
 * @param channel - the IPC channel the preload listens on.
 * @param payload - the value to send.
 */
function pushToWindow(channel: string, payload: string): void {
  if (isOpen()) settingsWindow?.webContents.send(channel, payload)
}

/**
 * Open the settings window, or focus it if it is already open.
 *
 * The preload lives only on this window: the main window loads the harness
 * Web UI, which must never reach an IPC bridge.
 *
 * The IPC channels are registered once and close over the `handlers` of the
 * first call for the process lifetime; a later call passing a different set is
 * ignored. The app has a single construction site, so this is never observable
 * today.
 * @param handlers - the operations the renderer may invoke.
 * @param onClosed - called when the window closes, however it closes.
 */
export function openSettings(handlers: SettingsHandlers, onClosed: () => void): void {
  if (isOpen()) {
    settingsWindow?.focus()
    return
  }

  if (!channelsRegistered) {
    ipcMain.handle('settings:read', () =>
      handlers.read((latest) => pushToWindow('settings:update-available', latest)),
    )
    ipcMain.handle('settings:pick-folder', () => handlers.pickFolder())
    ipcMain.handle('settings:save', (_event, form: SettingsForm) =>
      handlers.save(form, (line) => pushToWindow('settings:progress', line)),
    )
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
