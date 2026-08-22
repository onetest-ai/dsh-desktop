import { app, BrowserWindow, Menu, shell } from 'electron'
import { errorPage } from './error-page'

/**
 * Create the single application window.
 * The renderer loads the harness UI unmodified, so it runs with node
 * integration off and context isolation on.
 * @returns the created window.
 */
export function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    show: false,
    titleBarStyle: 'hiddenInset',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  })

  window.once('ready-to-show', () => window.show())

  // Anything targeting a new window is an external link; hand it to the browser.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  return window
}

/**
 * Replace the window contents with a failure pane.
 * @param window - the application window.
 * @param title - short failure summary.
 * @param detail - remedy text or captured stderr.
 */
export function showError(window: BrowserWindow, title: string, detail: string): void {
  void window.loadURL(errorPage(title, detail))
  if (!window.isVisible()) window.show()
}

/**
 * Install the application menu.
 * Electron ships no usable default for a custom app, and without an Edit menu
 * the standard clipboard shortcuts do not reach the renderer. Settings appears
 * both in the File menu (explicitly requested) and the app menu (macOS
 * convention), so `onSettings` is wired to both.
 * @param onSettings - opens the settings window.
 */
export function installMenu(onSettings: () => void): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: app.name,
        submenu: [
          { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: onSettings },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      {
        label: 'File',
        submenu: [{ label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: onSettings }],
      },
      { role: 'editMenu' },
      {
        label: 'View',
        submenu: [
          { role: 'reload' },
          { role: 'forceReload' },
          { role: 'toggleDevTools' },
          { type: 'separator' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' },
        ],
      },
      { role: 'windowMenu' },
    ]),
  )
}
