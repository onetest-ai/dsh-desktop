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
