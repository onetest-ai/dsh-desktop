import { app, BrowserWindow, Menu, shell } from 'electron'
import { errorPage } from './error-page'

/**
 * CSS injected into the main window's `webContents` to make the top edge
 * draggable.
 *
 * The main window loads the harness Web UI unmodified (see `createWindow`),
 * so this cannot add markup there — only style what already renders. A
 * `body::before` pseudo-element gets its own box in the render tree without
 * touching the harness's DOM, so it can carry `-webkit-app-region: drag`
 * like a real element. It is 6px tall: the harness sidebar's topmost
 * control (the logo/collapse button) sits at 6px of padding from the
 * window's top edge in its expanded state, so a strip any taller would sit
 * under that button and swallow its clicks. The global `no-drag` rule on
 * interactive elements is a second line of defense if a future harness
 * layout narrows that margin.
 */
export const DRAG_REGION_CSS = `
body::before {
  content: "";
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  height: 6px;
  -webkit-app-region: drag;
  z-index: 2147483647;
}
button, a, input, textarea, select, [role="button"], [contenteditable="true"], [contenteditable=""] {
  -webkit-app-region: no-drag;
}
`

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

  // `hiddenInset` leaves no drag-able chrome: the harness content it loads
  // reaches the top edge with nothing marked `-webkit-app-region: drag`.
  // Re-run on every `dom-ready` (the harness URL and, on failure, the error
  // page loaded by `showError`) since a fresh document has no memory of a
  // prior `insertCSS` call.
  window.webContents.on('dom-ready', () => {
    void window.webContents.insertCSS(DRAG_REGION_CSS)
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
