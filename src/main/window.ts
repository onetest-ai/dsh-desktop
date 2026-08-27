import { app, BrowserWindow, Menu, WebContentsView, net, protocol, shell } from 'electron'
import { pathToFileURL } from 'node:url'
import { join, normalize, sep } from 'node:path'
import { errorPage } from './error-page'
import { layout } from './layout'

/**
 * CSS injected into the main window's `webContents` to make the top edge
 * draggable.
 *
 * The main window loads the harness Web UI unmodified (see `createWindow`),
 * so this cannot add markup there — only style what already renders. A
 * `body::before` pseudo-element gets its own box in the render tree without
 * touching the harness's DOM, so it can carry `-webkit-app-region: drag`
 * like a real element.
 *
 * It is 15px tall. A drag region sits above the page and swallows clicks in
 * its band, so the height trades grabbability against covering the harness's
 * own controls: 6px was measured off a CSS padding value and proved too thin
 * to hit reliably, while the topmost harness control (the sidebar
 * logo/collapse button) renders about 40px below the window's top edge, so
 * 15px clears it. The global `no-drag` rule on interactive elements is a
 * second line of defense if a future harness layout raises that control.
 */
export const DRAG_REGION_CSS = `
body::before {
  content: "";
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  height: 15px;
  -webkit-app-region: drag;
  z-index: 2147483647;
}
button, a, input, textarea, select, [role="button"], [contenteditable="true"], [contenteditable=""] {
  -webkit-app-region: no-drag;
}
`

/** The window and the views it holds. */
export interface MainWindow {
  window: BrowserWindow
  /** Holds the harness Web UI, and the error pane when a boot fails. */
  harness: WebContentsView
  /** Holds this app's own file, editor, and web views. */
  pane: WebContentsView
}

/** How wide the pane opens the first time, before the user has sized it. */
export const DEFAULT_PANE_WIDTH = 420

/**
 * Where the pane is served from.
 *
 * A custom scheme rather than `file://`, because Chromium refuses to
 * construct a Worker from a file page and the editor's language services are
 * workers. Registered as standard and secure so the page gets a real origin.
 */
export const PANE_ORIGIN = 'app://pane'

/**
 * Claim the pane's scheme.
 *
 * Must run before the app is ready — Chromium reads the privileged scheme
 * table once, at startup — so this is called from module scope in `index.ts`
 * rather than from `createWindow`.
 */
export function registerPaneScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ])
}

/**
 * Serve the pane's own files, and nothing else.
 *
 * Every request is resolved inside the renderer directory and refused if it
 * lands outside it: the scheme is reachable from the pane's own page, so a
 * path with `..` in it must not be able to read the rest of the disk.
 * @returns nothing; installs the handler on the `app` scheme.
 */
export function servePane(): void {
  const root = join(__dirname, '..', 'renderer')
  protocol.handle('app', async (request) => {
    const { host, pathname } = new URL(request.url)
    if (host !== 'pane') return new Response('Not found', { status: 404 })
    const file = join(root, normalize(pathname))
    if (file !== root && !file.startsWith(root + sep)) return new Response('Forbidden', { status: 403 })
    return await net.fetch(pathToFileURL(file).toString())
  })
}

/**
 * Create the single application window and the views inside it.
 *
 * The window's own page is not the harness: it renders only in the gap
 * between the two views, where it draws the divider. The harness and the
 * pane are `WebContentsView`s positioned from here, so the harness Web UI
 * keeps a whole page to itself — and so foreign content in the pane never
 * shares a process with it.
 *
 * The window is not shown here. It stays hidden until something has finished
 * loading in the harness view, since an unloaded window paints white; see
 * `index.ts`'s `did-finish-load` handler.
 * @param paneState - the pane's stored width and whether it starts open.
 * @returns the window and its two views.
 */
export function createWindow(paneState: { width: number; open: boolean }): MainWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    show: false,
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(__dirname, '..', 'preload', 'shell.js'),
    },
  })
  void window.loadFile(join(__dirname, '..', 'renderer', 'shell.html'))

  const harness = new WebContentsView({
    // The harness Web UI is loaded unmodified, so it runs with node
    // integration off and context isolation on. Its preload exposes exactly
    // one no-argument call — toggle this app's pane — which is what lets a
    // harness-side button reach it; see `src/preload/harness.ts`.
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(__dirname, '..', 'preload', 'harness.js'),
    },
  })
  const pane = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(__dirname, '..', 'preload', 'pane.js'),
    },
  })
  window.contentView.addChildView(harness)
  window.contentView.addChildView(pane)
  void pane.webContents.loadURL(`${PANE_ORIGIN}/pane.html`)

  applyLayout({ window, harness, pane }, paneState)
  window.on('resize', () => applyLayout({ window, harness, pane }, paneState))

  // Anything targeting a new window is an external link; hand it to the browser.
  harness.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  // `hiddenInset` leaves no drag-able chrome: the harness content it loads
  // reaches the top edge with nothing marked `-webkit-app-region: drag`.
  // Re-run on every `dom-ready` (the harness URL and, on failure, the error
  // page loaded by `showError`) since a fresh document has no memory of a
  // prior `insertCSS` call.
  harness.webContents.on('dom-ready', () => {
    void harness.webContents.insertCSS(DRAG_REGION_CSS)
  })

  return { window, harness, pane }
}

/**
 * Size the views to the window's current content area.
 *
 * Called on every resize and on every pane change: `WebContentsView` has no
 * layout of its own, so nothing moves unless this does it.
 * @param views - the window and its views.
 * @param paneState - the pane's width and whether it is showing.
 */
export function applyLayout(views: MainWindow, paneState: { width: number; open: boolean }): void {
  if (views.window.isDestroyed()) return
  const [width, height] = views.window.getContentSize()
  const places = layout({ width, height }, paneState)
  views.harness.setBounds(places.harness)
  views.pane.setBounds(places.pane)
  // A closed pane is given no bounds to render in rather than being detached:
  // it keeps whatever it was showing, so reopening costs no reload.
  views.pane.setVisible(paneState.open)
}

/**
 * Replace the harness view's contents with a failure pane.
 * @param views - the window and its views.
 * @param title - short failure summary.
 * @param detail - remedy text or captured stderr.
 */
export function showError(views: MainWindow, title: string, detail: string): void {
  void views.harness.webContents.loadURL(errorPage(title, detail))
  if (!views.window.isVisible()) views.window.show()
}

/**
 * Install the application menu.
 * Electron ships no usable default for a custom app, and without an Edit menu
 * the standard clipboard shortcuts do not reach the renderer. Settings appears
 * both in the File menu (explicitly requested) and the app menu (macOS
 * convention), so `onSettings` is wired to both.
 * @param onSettings - opens the settings window.
 * @param onTogglePane - shows or hides the side pane.
 */
export function installMenu(onSettings: () => void, onTogglePane: () => void): void {
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
          // The only way to open the pane by hand. Alt rather than plain
          // Cmd+B, which the harness Web UI may want for its own sidebar.
          { label: 'Toggle Side Pane', accelerator: 'CmdOrCtrl+Alt+B', click: onTogglePane },
          { type: 'separator' },
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
