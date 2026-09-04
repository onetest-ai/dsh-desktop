import { app, BrowserWindow, Menu, WebContentsView, net, protocol, shell, type MenuItemConstructorOptions } from 'electron'
import { pathToFileURL } from 'node:url'
import { join, normalize, sep } from 'node:path'
import { errorPage } from './error-page'
import { layout, type Columns } from './layout'
import { projectFilePath, PROJECT_HOST } from './project-url'

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
  /** Holds this app's editor, in the middle column. */
  pane: WebContentsView
  /** Holds the file tree, in the side column. */
  files: WebContentsView
  /**
   * Holds the source-control panel, in the side column.
   *
   * A view of its own rather than a second panel inside the tree's page: the
   * two take turns in one column, and a view that is given no bounds keeps
   * whatever it drew, so switching back costs no reload.
   */
  git: WebContentsView
  /** Holds the terminal panel, along the bottom of the columns. */
  terminal: WebContentsView
  /**
   * Holds whatever page the Web tab is showing.
   *
   * A view of its own rather than a frame in the pane's page: a foreign page
   * gets its own process this way, and nothing it does can reach the pane's
   * preload.
   */
  web: WebContentsView
}

/**
 * How wide each column opens the first time, before the user has sized it.
 *
 * Chosen so all three fit at the window's own opening size without the
 * clamp: 1280 less the harness's 480 minimum and the two dividers leaves 788,
 * and these come to 740 — so a first open shows the editor and the tree at
 * the widths they asked for rather than at whatever was left over.
 */
export const DEFAULT_EDITOR_WIDTH = 520
export const DEFAULT_FILES_WIDTH = 220

/** How tall the terminal panel opens, and how wide it claims when no column is open. */
export const DEFAULT_TERMINAL_HEIGHT = 240
export const DEFAULT_TERMINAL_WIDTH = 720

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
 * Every request is resolved inside the renderer directory — or, for a project
 * file, inside a project the harness has opened — and refused if it lands
 * outside: the scheme is reachable from the pane's own page, so a path with
 * `..` in it must not be able to read the rest of the disk.
 * @param projectRoots - the projects a file may be served from.
 */
export function servePane(projectRoots: () => string[]): void {
  const root = join(__dirname, '..', 'renderer')
  protocol.handle('app', async (request) => {
    const { host, pathname } = new URL(request.url)
    // Project files: an image or a video the editor column is showing. Served
    // under their own host and checked against the projects the harness has
    // opened, since this scheme is reachable from any page this app loads.
    if (host === PROJECT_HOST) {
      const file = projectFilePath(pathname, projectRoots())
      if (file === undefined) return new Response('Forbidden', { status: 403 })
      return await net.fetch(pathToFileURL(file).toString())
    }
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
 * @param columns - each column's stored width and whether it starts open.
 * @returns the window and its views.
 */
export function createWindow(columns: Columns): MainWindow {
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
  // This page is chrome, not content: `applyLayout` places the rail and the
  // dividers at the window's own coordinates, and a zoomed page lays them out
  // in CSS pixels that no longer match — at zoom 1.1 in a 1280pt window the
  // rail is positioned at 1250 inside a 1168-wide page and is never seen.
  // Chromium persists zoom per origin and restores it on load, so it is
  // pinned here and again once the document has loaded.
  window.webContents.setZoomLevel(0)
  window.webContents.on('did-finish-load', () => {
    window.webContents.setZoomLevel(0)
  })

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
  const files = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(__dirname, '..', 'preload', 'pane.js'),
    },
  })
  const git = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(__dirname, '..', 'preload', 'pane.js'),
    },
  })
  const terminal = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(__dirname, '..', 'preload', 'terminal.js'),
    },
  })
  const web = new WebContentsView({
    // Whatever the Web tab loads is foreign: no preload, no node, isolated —
    // and stacked over the pane rather than inside its document.
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  })
  window.contentView.addChildView(harness)
  window.contentView.addChildView(pane)
  window.contentView.addChildView(files)
  window.contentView.addChildView(git)
  window.contentView.addChildView(terminal)
  // Added last so it stacks over the editor column it covers.
  window.contentView.addChildView(web)
  void pane.webContents.loadURL(`${PANE_ORIGIN}/pane.html`)
  void files.webContents.loadURL(`${PANE_ORIGIN}/files.html`)
  // Loaded with the window even though the column starts on the tree, for the
  // reason the web and terminal views are: an unloaded view is a target that
  // never finishes loading, and an automation client attaching to this window
  // waits on it.
  void git.webContents.loadURL(`${PANE_ORIGIN}/git.html`)
  // Loaded up front rather than left on its initial blank document: an
  // unloaded view is a target that never finishes, and an automation client
  // attaching to this window waits for it.
  void web.webContents.loadURL(`${PANE_ORIGIN}/web.html`)
  // Loaded with the window, for the same reason as the web view: an unloaded
  // view is a target that never finishes. Its shell starts only when the panel
  // is opened, not here.
  void terminal.webContents.loadURL(`${PANE_ORIGIN}/terminal.html`)

  // A page that opens a new window gets the system browser, exactly as the
  // harness view does: this app has one place to put a page, and it is here.
  web.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  const views = { window, harness, pane, files, git, terminal, web }
  applyLayout(views, columns, false)
  window.on('resize', () => applyLayout(views, lastColumns, webShowing))
  // Laid out again once the page can hear it. The rail and the dividers have
  // no position in CSS — `shell.css` gives the rail `position: absolute` and
  // nothing to place it by — so both come from the `shell:places` message
  // alone. The pass above runs while `shell.html` is still loading, and a
  // page mid-load drops what is sent to it: without this the rail sits at the
  // window's left edge behind the harness view, invisible, and no divider has
  // a gap to be grabbed by.
  window.webContents.on('did-finish-load', () => applyLayout(views, lastColumns, webShowing))

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

  return views
}

/**
 * What the views were last laid out with.
 *
 * Held here so a resize can put them back the way they were: `resize` carries
 * no state of its own, and reading it from a renderer would mean asking a
 * page where a view belongs.
 */
let webShowing = false
let lastColumns: Columns = {
  editor: { width: DEFAULT_EDITOR_WIDTH, open: false },
  files: { width: DEFAULT_FILES_WIDTH, open: false, view: 'files' },
  terminal: { width: DEFAULT_TERMINAL_WIDTH, height: DEFAULT_TERMINAL_HEIGHT, open: false },
}

/**
 * Size the views to the window's current content area.
 *
 * Called on every resize and on every column change: `WebContentsView` has no
 * layout of its own, so nothing moves unless this does it.
 * @param views - the window and its views.
 * @param columns - each column's width and whether it is showing.
 * @param webVisible - whether the Web tab is the one selected.
 */
export function applyLayout(views: MainWindow, columns: Columns, webVisible: boolean): void {
  if (views.window.isDestroyed()) return
  webShowing = webVisible
  lastColumns = columns
  const [width, height] = views.window.getContentSize()
  const places = layout({ width, height }, columns)
  views.harness.setBounds(places.harness)
  views.pane.setBounds(places.editor)
  // The tree and the git panel take turns in the side column: whichever is
  // not showing is given no rectangle at all rather than being hidden by CSS,
  // so a page nobody can see is laying nothing out.
  const showingGit = columns.files.view === 'git'
  const nowhere = { x: places.files.x, y: places.files.y, width: 0, height: 0 }
  views.files.setBounds(showingGit ? nowhere : places.files)
  views.git.setBounds(showingGit ? places.files : nowhere)
  views.terminal.setBounds(places.terminal)
  // The web view covers the editor column's panel area, minus its tab strip
  // and the address bar under it, so both stay reachable while a page shows.
  const chrome = TAB_STRIP_HEIGHT + ADDRESS_BAR_HEIGHT
  views.web.setBounds({
    x: places.editor.x,
    y: places.editor.y + chrome,
    width: places.editor.width,
    height: Math.max(0, places.editor.height - chrome),
  })
  // A hidden view is given no bounds to render in rather than being detached:
  // it keeps whatever it was showing, so reopening costs no reload.
  views.pane.setVisible(columns.editor.open)
  views.files.setVisible(columns.files.open && !showingGit)
  views.git.setVisible(columns.files.open && showingGit)
  views.terminal.setVisible(columns.terminal.open)
  views.web.setVisible(columns.editor.open && webVisible)
  // The window's own page draws the dividers and the rail but cannot see
  // where the views are, so it is told: each divider is placed over its own
  // gap, a closed column's is given no width to be grabbed by, and the rail
  // takes the strip at the edge.
  views.window.webContents.send('shell:places', {
    editor: places.editorDivider,
    files: places.filesDivider,
    terminal: places.terminalDivider,
    rail: places.rail,
    // The rail's buttons show which columns are up, so it is told.
    open: {
      editor: columns.editor.open,
      files: columns.files.open && !showingGit,
      git: columns.files.open && showingGit,
      terminal: columns.terminal.open,
      web: columns.editor.open && webVisible,
    },
  })
}

/**
 * How much of the editor column the tab strip occupies.
 *
 * Mirrors `pane.css`: 8px of padding, an 18px line, and 7px of padding under
 * it, plus the strip's own border. The web view is placed under it rather
 * than over it, so the tabs stay clickable while a page is loaded.
 */
const TAB_STRIP_HEIGHT = 35

/**
 * How much of the Web tab the address bar occupies.
 *
 * Mirrors `pane.css`: a 34px row plus its border. The page is placed under it
 * rather than over it, so what is showing and where it can go stay visible.
 */
const ADDRESS_BAR_HEIGHT = 35

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
 * Every pane this app can open has an item here, which is what gives it a
 * keyboard shortcut: an accelerator on a menu item is scoped to this app,
 * unlike `globalShortcut`, which takes the key from every other application
 * for as long as this one runs.
 *
 * The developer items are left out of a packaged build. They are ours, not
 * the user's — a DevTools window over the harness is a support call, not a
 * feature.
 * @param onSettings - opens the settings window.
 * @param panes - shows or hides this app's own columns.
 */
export function installMenu(
  onSettings: () => void,
  panes: {
    toggleFiles(): void
    toggleGit(): void
    toggleWeb(): void
    toggleTerminal(): void
    zoomIn(): void
    zoomOut(): void
    zoomReset(): void
  },
): void {
  const developer: MenuItemConstructorOptions[] = app.isPackaged
    ? []
    : [{ role: 'toggleDevTools' }, { type: 'separator' }]
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
          // Alt rather than plain Cmd+B and Cmd+W, both of which the harness
          // Web UI may want — and Cmd+W already closes a window.
          { label: 'Toggle File Tree', accelerator: 'CmdOrCtrl+Alt+B', click: panes.toggleFiles },
          { label: 'Toggle Source Control', accelerator: 'CmdOrCtrl+Alt+G', click: panes.toggleGit },
          { label: 'Toggle Browser', accelerator: 'CmdOrCtrl+Alt+W', click: panes.toggleWeb },
          { label: 'Toggle Terminal', accelerator: 'CmdOrCtrl+Alt+J', click: panes.toggleTerminal },
          { type: 'separator' },
          { role: 'reload' },
          { role: 'forceReload' },
          ...developer,
          // Aimed at the harness rather than left as roles: a role acts on the
          // focused window's own page — this app's chrome — and zooming that
          // moves the rail out of the window.
          { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: panes.zoomReset },
          { label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', click: panes.zoomIn },
          { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: panes.zoomOut },
          { type: 'separator' },
          { role: 'togglefullscreen' },
        ],
      },
      { role: 'windowMenu' },
    ]),
  )
}
