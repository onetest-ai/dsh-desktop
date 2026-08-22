import { BrowserWindow, ipcMain, type WebContents } from 'electron'
import { join } from 'node:path'
import type { SettingsHandlers } from './settings-ipc'
import type { SettingsForm } from './settings-validate'

let settingsWindow: BrowserWindow | undefined
let channelsRegistered = false

function isOpen(): boolean {
  return settingsWindow !== undefined && !settingsWindow.isDestroyed()
}

/**
 * Push one value back over a receive-only channel to the renderer that started
 * the operation, tolerating one that has since closed.
 *
 * Addressed to the originating `WebContents` rather than to whichever settings
 * window happens to be current. A managed install runs for minutes, so the
 * user can close Settings and reopen it while one is still going: sending to
 * the current window would stream that install's output into a fresh window
 * whose own Save is idle, and would deliver an update-available hint to a
 * window that never asked for one. A closed window's `WebContents` is
 * destroyed, so a line arriving after the window is gone is dropped here.
 * @param sender - the renderer that invoked the channel.
 * @param channel - the IPC channel the preload listens on.
 * @param payload - the value to send.
 */
function pushToSender(sender: WebContents, channel: string, payload: string): void {
  if (!sender.isDestroyed()) sender.send(channel, payload)
}

/**
 * Open the settings window, or focus it if it is already open.
 *
 * The preload lives only on this window: the main window loads the harness
 * Web UI, which must never reach an IPC bridge.
 *
 * Progress and update-available results are pushed back to the renderer that
 * invoked the channel, so a second settings window opened over a running
 * install never receives the first window's output.
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
    ipcMain.handle('settings:read', (event) =>
      handlers.read((latest) => pushToSender(event.sender, 'settings:update-available', latest)),
    )
    ipcMain.handle('settings:pick-folder', () => handlers.pickFolder())
    ipcMain.handle('settings:save', (event, form: SettingsForm) =>
      handlers.save(form, (line) => pushToSender(event.sender, 'settings:progress', line)),
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
