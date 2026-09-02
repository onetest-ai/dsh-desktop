import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, nativeTheme, Notification, shell, utilityProcess } from 'electron'
import { accessSync, constants, existsSync, mkdirSync, renameSync, rmSync, statSync, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadDeclaredPatchRows } from './bundle-patch'
import { checkBinaries } from './check-binaries'
import { DEFAULT_VIEW_TOOLS_PORT, loadConfig, writeConfig, type ConfigResult, type DesktopConfig } from './config'
import { ConfigurationError } from './configuration-error'
import { configPath, PROFILE, resolveDshHome, type HarnessSource } from './harness-source'
import { createInstallRunner } from './install-process'
import { createManagedInstaller, createUpdateChecker } from './managed-install'
import { mcpConfigPath, readMcpConfig, writeMcpConfig, type McpServerEntry } from './mcp-config'
import { migrateMcpConfig } from './mcp-migrate'
import { createMcpProber } from './mcp-probe'
import { alignDefaultPlugins, ensureDefaultPlugins } from './plugin-defaults'
import { repairablePlugins, runHealthcheck, type Finding } from './healthcheck'
import { repairPlugins } from './repair'
import { closeStartup, pushFindings, pushPhase, pushProgress, showStartup } from './startup-window'
import { loadPresets, shippedPresetsPath, userPresetsPath } from './mcp-presets'
import { activeServers, MCP_CLIENT_PACKAGE, serverEnv, serverRows } from './mcp-servers'
import { portIsFree, startNotifyListener, type NotifyServer } from './notify'
import { openConfigFile } from './open-config-file'
import {
  bundlePatchDeclaration,
  declaresClientHalf,
  HOOKS_PACKAGE,
  parseSpec,
  pluginInstallMarker,
  pluginStatus,
  presetsDeclaration,
  type PluginEntry,
  type PluginStatus,
} from './plugin-entries'
import { ensurePluginLink, reconcilePluginLinks } from './plugin-link'
import { ensurePluginPresets, reconcilePluginPresets } from './plugin-presets'
import { preflight } from './preflight'
import { attributeBootFailure, runtimeFilePaths, writeRuntimeFiles, type AttributionRow } from './runtime-files'
import { readCachedShellPath, resolveShellPath, runShell, shellPathCachePath, writeCachedShellPath } from './shell-path'
import type { InstallDeps } from './runtime-install'
import { composePath, dshWebCommand, resolveBinary, startServer, type ServerHandle } from './server'
import { createSettingsHandlers } from './settings-ipc'
import { settingsContents, openSettings } from './settings-window'
import { singleFlight } from './single-flight'
import { createTray, type TrayController } from './tray'
import { DEFAULT_EDITOR_WIDTH, DEFAULT_FILES_WIDTH, PANE_ORIGIN, applyLayout, createWindow, installMenu, registerPaneScheme, servePane, showError, type MainWindow,
  DEFAULT_TERMINAL_HEIGHT,
  DEFAULT_TERMINAL_WIDTH,
} from './window'
import { readWorkspaces } from './workspaces'
import { readDirectory } from './file-tree'
import { DIVIDER_WIDTH, RAIL_WIDTH, nextSideView, type Columns, type SideView } from './layout'
import { gitDiffFor, readProject, type ProjectGit } from './git-model'
import { findRepos, hasGit } from './git-find'
import type { Section } from './git-status'
import { setGitPath } from './git-run'
import { serveViewTools, SURFACES, type BrowserAutomation, type PageText, type ViewServer } from './view-mcp'
import { PAGE_TEXT_LIMIT, pageTextScript } from './page-text'
import { projectFileUrl } from './project-url'
import { loadableUrl } from './view-tools'
import { readTextFile, writeTextFile } from './file-io'
import { createFile, createFolder } from './file-create'
import { deleteEntry, pasteEntry, renameEntry } from './file-ops'
import { treeMenu, type TreeAction } from './tree-menu'
import { isWebPage } from './web-page'
import { resolveInRoot } from './file-tree'
import { watchProject, type ProjectWatch } from './project-watch'
import type { HostEvent } from './pty-host'
import { Terminals } from './terminal'
import { argsFor, resolveShell, shellProblem } from './terminal-shell'
import { BrowserSession } from './browser-cdp'
import {
  click as clickElement,
  drag as dragElement,
  dragCancel as cancelDrag,
  dragDrop as dropDrag,
  dragMove as moveDrag,
  dragStart as beginDrag,
  hover as hoverElement,
  press as pressKey,
  readPage as readBrowserPage,
  resizeViewport,
  screenshot as capturePage,
  selectOption as chooseOption,
  type as typeText,
  uploadFile as attachFile,
  waitFor as awaitCondition,
} from './browser-actions'
import { harnessTheme, settingsPath } from './harness-theme'
import { workspacesPath } from './workspaces'
import type { ServerStatus } from './status'

/** The config lives under `$DSH_HOME` (see `configPath`), beside the harness's own state. */
const CONFIG_PATH = configPath(process.env)

/** Where a managed harness install lives; see `managedDir`. */
const DSH_HOME = resolveDshHome(process.env)

/** How long the harness may take to report its URL. */
const READY_TIMEOUT_MS = 60_000

/** How long the Advanced tab's Check button waits for `pnpm --version`/`npm --version` before treating a binary as hung. */
const CHECK_BINARY_TIMEOUT_MS = 10_000

/**
 * How many extra attempts `bootNow` may make beyond the primary one when a
 * server-stage failure is attributable, or falls back, to dropping plugins.
 *
 * Bounds worst-case boot time to `(1 + MAX_ISOLATION_ATTEMPTS) *
 * READY_TIMEOUT_MS` regardless of how many plugins are configured: without a
 * cap, a config with many independently broken plugins could isolate one per
 * attempt forever, each attempt paying a full readiness timeout. Two extra
 * attempts covers the realistic cases this feature exists for — one bad
 * plugin, or two whose failures surface one after the other — while the
 * unattributable-failure fallback (drop every remaining plugin at once)
 * always guarantees a bounded final attempt reaches a plugin-free boot.
 */
const MAX_ISOLATION_ATTEMPTS = 2

let window: BrowserWindow | undefined
/** The window together with its harness and pane views; undefined before it exists. */
let views: MainWindow | undefined
/**
 * Each column's width and whether it is showing.
 *
 * Mutable module state rather than a config read per layout pass: it changes
 * on every pointer move of a divider drag, and only the end of that drag is
 * written to disk.
 */
const columns: Columns = {
  editor: { width: DEFAULT_EDITOR_WIDTH, open: false },
  files: { width: DEFAULT_FILES_WIDTH, open: false, view: 'files' },
  terminal: { width: DEFAULT_TERMINAL_WIDTH, height: DEFAULT_TERMINAL_HEIGHT, open: false },
}

/**
 * Move a column and re-lay the window out.
 * @param key - which column to change.
 * @param next - the width, open state, or both to apply.
 */
/**
 * Set the terminal panel's height.
 *
 * Its own setter because the panel is the one part sized vertically:
 * `setColumn` writes a width, which for this panel is what it claims when no
 * column is open to sit under — a different number entirely.
 * @param height - the height in pixels; clamped by `layout`.
 */
function setTerminalHeight(height: number): void {
  columns.terminal.height = Math.max(0, Math.round(height))
  if (views !== undefined && !views.window.isDestroyed()) applyLayout(views, columns, webViewVisible)
}

function setColumn(key: keyof Columns, next: { width?: number; open?: boolean }): void {
  if (next.width !== undefined) columns[key].width = next.width
  if (next.open !== undefined) columns[key].open = next.open
  if (views !== undefined && !views.window.isDestroyed()) applyLayout(views, columns, webViewVisible)
}

/**
 * The view the side column's rectangle is currently in.
 *
 * The tree and the git panel take turns in that column, and `applyLayout`
 * gives the one that is not showing a 0x0 rectangle — so anything measuring
 * the column has to ask the view that has it. Measuring `files` while the
 * panel is up reads zero, and a zero committed at the end of a drag is stored
 * as a width the user never chose.
 * @param window - the window and its views.
 * @returns whichever of the two is holding the column.
 */
function sideColumn(window: MainWindow): MainWindow['files'] {
  return columns.files.view === 'git' ? window.git : window.files
}

/**
 * Show or hide the browser.
 *
 * The Web tab lives in the editor column, so opening the browser opens that
 * column and selects the tab — a browser you can only reach by first opening
 * a file is not one the user can go to. Toggling it off closes the column
 * only when the browser is what it was showing.
 */
function toggleWeb(): void {
  if (columns.editor.open && webViewVisible) {
    setColumn('editor', { open: false })
    storeColumns()
    return
  }
  if (!columns.editor.open) {
    setColumn('editor', { open: true })
    storeColumns()
  }
  if (views !== undefined && !views.window.isDestroyed()) views.pane.webContents.send('pane:show-web')
}

/** Show or hide one column, storing the choice. */
function toggleColumn(key: keyof Columns): void {
  setColumn(key, { open: !columns[key].open })
  storeColumns()
}

/**
 * Put one of the side column's two views up, or close the column.
 *
 * The one path the rail button and the menu item both take. 0.3.0 shipped a
 * fix for the terminal, where they did not: the rail did work the menu item
 * never learned about, so the shortcut opened a panel with nothing in it.
 * @param pressed - the view whose button or menu item was used.
 */
function toggleSideView(pressed: SideView): void {
  const next = nextSideView({ open: columns.files.open, view: columns.files.view }, pressed)
  columns.files.view = next.view
  setColumn('files', { open: next.open })
  storeColumns()
  // Opening the panel is one of the moments its status is stale: it has been
  // showing whatever was true when it was last put away.
  if (next.open && next.view === 'git') notifyGitChanged()
}

/**
 * Store the columns' current state.
 *
 * Called at the end of a drag and when a column opens or closes, never during
 * one: a write per pointer move would put a file write behind every frame. A
 * failed write costs the user their column widths on the next launch and
 * nothing else, so it is warned about rather than surfaced.
 */
function storeColumns(): void {
  try {
    const stored = loadConfig(CONFIG_PATH)
    if (!stored.configured) return
    writeConfig(CONFIG_PATH, {
      ...stored.config,
      pane: {
        editor: { ...columns.editor },
        files: { ...columns.files },
        terminal: { ...columns.terminal },
      },
    })
  } catch (error) {
    console.warn(`dsh-desktop: the column sizes could not be stored: ${(error as Error).message}`)
  }
}

/**
 * Whether the pane's Web tab is the one showing.
 *
 * Held here rather than in the pane page because the web view it controls is
 * a view of this window, not an element of that page; see Task 6.
 */
let webViewVisible = false

/** Watches the harness's settings document for a theme change; closed on quit. */
let themeWatcher: FSWatcher | undefined
/** Watches its workspace list for the project the tree should show; closed on quit. */
let workspaceWatcher: FSWatcher | undefined

/**
 * The watch over the project the file tree is showing.
 *
 * One at a time: the tree shows one project, and a watch over a project
 * nobody is looking at would report changes into a listing that no longer
 * exists.
 */
let projectWatcher: ProjectWatch | undefined

/** This app's own MCP server, serving the view tools; undefined when switched off. */
let viewServer: ViewServer | undefined

/**
 * Start the view tools, unless they are switched off.
 *
 * Started before the harness boots, since its MCP client is handed the port
 * as part of the overlay: a server that came up afterwards would be one the
 * child never learned about.
 * @param config - the desktop settings this launch is starting from.
 */
async function startViewTools(config: DesktopConfig): Promise<void> {
  if (config.viewTools === false) return
  try {
    viewServer = await serveViewTools(config.viewToolsPort ?? DEFAULT_VIEW_TOOLS_PORT, {
      roots: () => readWorkspaces(DSH_HOME).map((workspace) => workspace.path),
      openFile: openInPane,
      openUrl: openUrlInPane,
      showDiff: showDiffInPane,
      selection: readPaneSelection,
      fetchPage: fetchPageText,
      readPage: readPageText,
      browser: browserAutomation,
    })
  } catch (error) {
    // A port already taken costs the user the view tools and nothing else:
    // the harness boots, and every other tool it has still works.
    console.warn(`dsh-desktop: the view tools could not start: ${(error as Error).message}`)
  }
}

/**
 * Tell the panel it is on screen.
 *
 * The page is loaded with the window, long before anyone opens the panel, and
 * runs once: without this it comes back empty for good once its last tab
 * closes, because nothing in the page runs a second time to start a shell.
 */
function tellTerminalShown(): void {
  if (views === undefined || views.window.isDestroyed()) return
  const target = views.terminal.webContents
  // A page that has not finished loading drops what is sent to it, which is
  // the panel's state for the first moments after boot.
  if (target.isLoading()) {
    target.once('did-finish-load', () => {
      target.send('terminal:shown')
    })
    return
  }
  target.send('terminal:shown')
}

/**
 * How far the conversation may be zoomed, in Chromium's zoom levels.
 *
 * Each step is a factor of 1.2; five steps out is 2.5x and five in is 0.4x,
 * past which the harness Web UI's own layout stops working.
 */
const ZOOM_LIMIT = 5

/**
 * Zoom the harness, which is the only view with reading in it.
 *
 * Never this app's own page: it draws the rail and the dividers at the
 * window's coordinates, and a zoomed page lays them out somewhere else.
 * @param step - levels to move by, or `0` to go back to actual size.
 */
function zoomHarness(step: number): void {
  if (views === undefined || views.window.isDestroyed()) return
  const contents = views.harness.webContents
  const next = step === 0 ? 0 : contents.getZoomLevel() + step
  contents.setZoomLevel(Math.max(-ZOOM_LIMIT, Math.min(ZOOM_LIMIT, next)))
}

/**
 * Show or hide the terminal panel.
 *
 * Shared by the rail's button and the View menu: opening the panel has to
 * tell its page, which starts a shell when it has none, and two call sites
 * doing that separately is one of them forgetting.
 */
function toggleTerminalPanel(): void {
  toggleColumn('terminal')
  if (columns.terminal.open) tellTerminalShown()
}

/**
 * Start a shell for the terminal panel.
 *
 * The directory is the workspace the tree is showing at the moment the panel
 * opens, and is not revisited: a terminal is a place someone is working, and
 * moving its `cwd` under a running shell would be a surprise no terminal
 * anywhere does.
 * @param cols - the panel's measured width in characters.
 * @param rows - its measured height in rows.
 * @returns the id to address it by, or why no shell started.
 */
function startTerminal(cols: number, rows: number): { id: number; cwd: string; shell: string } | { error: string } {
  const stored = loadConfig(CONFIG_PATH)
  const configured = stored.configured ? stored.config.terminalShell : undefined
  const shell = resolveShell(configured)
  const problem = shellProblem(shell.command, (path) => {
    try {
      accessSync(path, constants.X_OK)
      return statSync(path).isFile()
    } catch {
      return false
    }
  })
  if (problem !== undefined) {
    return {
      error: shell.source === 'configured'
        ? `${problem} Change it under Settings → Advanced → Terminal shell.`
        : problem,
    }
  }
  const cwd = currentProject?.path ?? app.getPath('home')
  const id = terminals.start({
    shell: shell.command,
    args: argsFor(shell.command),
    cwd,
    cols: Math.max(1, Math.floor(cols)),
    rows: Math.max(1, Math.floor(rows)),
    env: { ...process.env, PATH: probePath(), TERM: 'xterm-256color' } as Record<string, string>,
  })
  return { id, cwd, shell: shell.command }
}

/**
 * The terminals this app has open, and the host process behind them.
 *
 * Constructed once; it starts nothing until a terminal is opened, so an app
 * nobody opens one in never forks a host or loads the native binary.
 */
const terminals = new Terminals({
  fork: (onEvent, onGone) => {
    const host = utilityProcess.fork(join(__dirname, 'pty-entry.js'), [], {
      // A shell inherits the environment the harness's own tools were given,
      // so a terminal finds the same toolchain the agent does.
      // The same PATH the harness's own tools are found on, so a terminal
      // finds the toolchain the agent does — a Finder-launched app inherits
      // almost none of it otherwise.
      env: { ...process.env, PATH: probePath() },
      serviceName: 'dsh-terminal',
    })
    host.on('message', (event: HostEvent) => {
      onEvent(event)
    })
    host.on('exit', () => {
      onGone()
    })
    return {
      post: (request) => {
        host.postMessage(request)
      },
      kill: () => {
        host.kill()
      },
    }
  },
  toPanel: (event) => {
    if (views === undefined || views.window.isDestroyed()) return
    const target = views.terminal.webContents
    if (event.kind === 'data') target.send('terminal:data', event.id, event.data)
    else if (event.kind === 'exit') target.send('terminal:exit', event.id, event.code)
    else target.send('terminal:failed', event.id, event.reason)
  },
})

/**
 * The protocol session over the browser column.
 *
 * One for the life of the app: it attaches on first use and survives every
 * navigation after that, so the console and dialog buffers span a whole task
 * rather than a single page.
 */
const browser = new BrowserSession(() =>
  views === undefined || views.window.isDestroyed() ? undefined : views.web.webContents.debugger,
)

/**
 * The browser tools, bound to that session.
 *
 * A thin binding on purpose: each verb is implemented against the protocol in
 * `browser-actions`, which is where the behaviour is tested, and this only
 * says which session they run on.
 */
const browserAutomation: BrowserAutomation = {
  readPage: () => readBrowserPage(browser),
  click: (target, options) => clickElement(browser, target, options),
  hover: (target) => hoverElement(browser, target),
  type: (target, text, clear) => typeText(browser, target, text, clear),
  press: (key) => pressKey(browser, key),
  selectOption: (target, value) => chooseOption(browser, target, value),
  drag: (from, to, offset) => dragElement(browser, from, to, offset),
  dragStart: (from) => beginDrag(browser, from),
  dragMove: (to, offset) => moveDrag(browser, to, offset),
  dragDrop: (to, offset) => dropDrag(browser, to, offset),
  dragCancel: () => cancelDrag(browser),
  waitFor: (target, text, gone, seconds) => awaitCondition(browser, target, text, gone, seconds),
  evaluate: (expression) => browser.evaluate(expression),
  uploadFile: (target, path) => attachFile(browser, target, [path]),
  resize: (width, height) => resizeViewport(browser, width, height),
  screenshot: () => capturePage(browser),
  setDialogPolicy: (policy) => browser.setDialogPolicy(policy),
  takeConsole: () => browser.takeConsole(),
  takeDialogs: () => browser.takeDialogs(),
  takeNavigations: () => browser.takeNavigations(),
}

/**
 * Load a page in the web view and read it back as text.
 *
 * The load is watched rather than raced: `loadURL` resolves when the document
 * is committed, which is before a page that renders itself has anything to
 * read. A page that never finishes is reported rather than hung on, since the
 * agent is waiting on this call.
 * @param url - the page to load.
 * @returns the page's text, or why it could not be read.
 */
async function fetchPageText(url: string): Promise<PageText> {
  if (views === undefined || views.window.isDestroyed()) return { ok: false, reason: 'The window is not open.' }
  openUrlInPane(url)
  const { webContents } = views.web
  const loaded = await new Promise<boolean>((resolve) => {
    const done = (ok: boolean): void => {
      clearTimeout(timer)
      webContents.off('did-finish-load', onLoad)
      webContents.off('did-fail-load', onFail)
      resolve(ok)
    }
    const onLoad = (): void => done(true)
    // Only the main frame: an advert or a tracker in an iframe fails on a
    // great many perfectly good pages, and treating that as the page failing
    // is what made this report pages it had in fact loaded.
    const onFail = (_event: unknown, _code: number, _description: string, _url: string, isMainFrame: boolean): void => {
      if (isMainFrame) done(false)
    }
    const timer = setTimeout(() => done(false), PAGE_LOAD_TIMEOUT_MS)
    webContents.on('did-finish-load', onLoad)
    webContents.on('did-fail-load', onFail)
  })
  // This navigation was asked for, so it is not news: reporting it would put
  // "the browser moved" against the very call that moved it, and bury the
  // ones nobody asked for.
  browser.takeNavigations()
  if (!loaded) return { ok: false, reason: `${url} did not finish loading.` }
  return await readPageText()
}

/**
 * Read whatever the web view is showing.
 * @returns the page's text, or why it could not be read.
 */
async function readPageText(): Promise<PageText> {
  if (views === undefined || views.window.isDestroyed()) return { ok: false, reason: 'The window is not open.' }
  const { webContents } = views.web
  if (webContents.getURL().startsWith(PANE_ORIGIN)) {
    return { ok: false, reason: 'The browser has no page open yet.' }
  }
  try {
    const page = (await webContents.executeJavaScript(pageTextScript(PAGE_TEXT_LIMIT))) as {
      title: string
      url: string
      text: string
    }
    return { ok: true, ...page }
  } catch (error) {
    return { ok: false, reason: (error as Error).message }
  }
}

/**
 * How long a page gets to finish loading before the agent is told it did not.
 *
 * The wait itself is for the document's own load event, which is what a
 * browser automation library waits for by default; this only bounds it.
 * Generous, because the cost of being wrong in one direction is a page the
 * agent reports as broken when it was merely slow, and in the other a tool
 * call that takes a minute to say so.
 */
const PAGE_LOAD_TIMEOUT_MS = 60_000

/**
 * Tell the browser's address bar where the page is and where it can go.
 *
 * Pushed rather than asked for: the page navigates on its own — a link, a
 * redirect — and a bar that only updated when something asked it to would
 * show the last address the user typed rather than the one they are on.
 */
function pushWebState(): void {
  if (views === undefined || views.window.isDestroyed()) return
  const { webContents } = views.web
  const url = webContents.getURL()
  views.pane.webContents.send('pane:web-state', {
    // The empty page is this app's own; showing its `app://` URL in the bar
    // would be an address the user can neither use nor go back to.
    url: url.startsWith(PANE_ORIGIN) ? '' : url,
    canGoBack: webContents.navigationHistory.canGoBack(),
    canGoForward: webContents.navigationHistory.canGoForward(),
  })
}

/**
 * The `file:` URL for a page inside an open project, if it may be shown.
 *
 * The only way a local file reaches the web view. `loadableUrl` still refuses
 * `file:` for the address bar and for the agent's own `open`, so a page the
 * user did not ask for cannot be pointed at their filesystem; this is the
 * one path in, and it is gated on the project being open, the entry being
 * inside it, and the name being one the view renders rather than shows as
 * source.
 * @param root - the project the entry is in.
 * @param relative - the entry's path within it.
 * @returns the URL to load, or undefined when it may not be shown.
 */
function webPageInProject(root: string, relative: string): string | undefined {
  if (!knownProject(root) || !isWebPage(relative)) return undefined
  const target = resolveInRoot(root, relative)
  return target === undefined ? undefined : pathToFileURL(target).href
}

/**
 * Show a page in the web view, opening the editor column and its Web tab.
 * @param url - the page to load.
 */
function openUrlInPane(url: string): void {
  if (views === undefined || views.window.isDestroyed()) return
  if (!columns.editor.open) {
    setColumn('editor', { open: true })
    storeColumns()
  }
  void views.web.webContents.loadURL(url)
  views.pane.webContents.send('pane:show-web')
}

/**
 * Show a file beside the text an agent proposes for it.
 * @param root - the project directory.
 * @param relative - the file's path within it.
 * @param proposed - the text the agent proposes.
 */
function showDiffInPane(root: string, relative: string, proposed: string): void {
  if (views === undefined || views.window.isDestroyed()) return
  if (!columns.editor.open) {
    setColumn('editor', { open: true })
    storeColumns()
  }
  views.pane.webContents.send('pane:diff', root, relative, proposed)
}

/**
 * Ask the pane what the user has selected.
 *
 * Asked of the page rather than pushed by it: a selection is only interesting
 * at the moment a tool asks, and mirroring every selection change into main
 * would be a message per keystroke.
 * @returns the selected text, or '' when there is none or no pane.
 */
async function readPaneSelection(): Promise<string> {
  if (views === undefined || views.window.isDestroyed()) return ''
  try {
    return (await views.pane.webContents.executeJavaScript('window.__paneSelection?.() ?? ""')) as string
  } catch (error) {
    // The pane page may not have run its script yet; an empty selection is
    // the honest answer either way.
    console.warn(`dsh-desktop: the editor selection could not be read: ${(error as Error).message}`)
    return ''
  }
}

/**
 * The project whose root the file tree is showing.
 *
 * Set from the harness's own workspace list and from whatever file is opened
 * in the editor, never from a control in the tree: which project is open is
 * the harness's to decide, and a second way to choose one here is how the two
 * come to disagree.
 */
let currentProject: { path: string; title: string } | undefined

/**
 * Tell the file tree which project to show.
 *
 * Prefers a project already chosen by something the user did — opening a file
 * — over the workspace list, which only moves when a session attaches and so
 * lags behind what someone is looking at.
 * @param project - the project to show, or undefined to recompute from the
 *   harness's own list.
 */
function showProject(project?: { path: string; title: string }): void {
  const next = project ?? currentProject ?? readWorkspaces(DSH_HOME)[0]
  if (next === undefined) return
  const moved = currentProject?.path !== next.path
  currentProject = { path: next.path, title: next.title }
  if (moved) watchCurrentProject()
  if (views === undefined || views.window.isDestroyed()) return
  views.files.webContents.send('pane:project', currentProject)
  // The panel follows the project the tree does; a moved project is a
  // different set of repositories entirely.
  if (moved) notifyGitChanged()
}

/**
 * Watch the current project, so the tree shows files the user did not add
 * through it.
 *
 * Most of what appears in a project here is written by the agent, not by the
 * tree's own New File — without this, the tree shows the project as it was
 * when it was opened until something makes it reload.
 */
function watchCurrentProject(): void {
  projectWatcher?.close()
  projectWatcher = undefined
  closeGitWatchers()
  const root = currentProject?.path
  if (root === undefined) return
  projectWatcher = watchProject(root, (relative) => {
    if (views === undefined || views.window.isDestroyed()) return
    views.files.webContents.send('pane:project-changed', root, relative)
    // An edit to a tracked file changes what git reports about it, so the
    // same watch serves both — for everything outside `.git`.
    notifyGitChanged()
  })
  watchRepos(root)
}

/**
 * Whether git could be run at all, once it has been asked.
 *
 * Cached only when the answer was yes: a no is worth asking again, since the
 * user's remedy is to name git's directory under Settings and come back.
 */
let gitOnPath = false

/**
 * The `readProject` call already running, if there is one.
 *
 * A rebase in the terminal panel moves `.git` dozens of times a second, and
 * every move asks for a read; without this each event would start its own
 * git. The project it was started for is held with it, because a read is only
 * an answer to the project it was started for.
 */
let gitReading: { root: string; promise: Promise<ProjectGit> } | undefined

/**
 * Whether anything has changed since the running read began.
 *
 * A read that started before a change cannot see it, so its answer is stale
 * the moment this is set — a caller waiting on it takes a fresh read instead.
 * This is what makes a refresh superseded rather than queued: the change is
 * remembered, not the request.
 */
let gitDirty = false

/**
 * Read the current project's repositories.
 *
 * A project with none, and no project at all, are both an empty list: the
 * panel says so in words and nothing is wrong. git missing from `PATH` is the
 * one state that names its own remedy, since the user can fix it.
 *
 * A caller arriving while a read is running waits it out and then takes that
 * read's answer only if it was for the same project and nothing changed
 * meanwhile; otherwise it starts one more. Two callers never run git at once,
 * and neither is handed a snapshot of something it did not ask about.
 *
 * **Serialised per project, not per repo.** `readProject` reads every
 * repository in one call, so one flag covers them all — an action on a single
 * repository (Task 9) must not assume the same, since two repositories can be
 * acted on at once and one waiting on the other would be a stall with no
 * cause.
 * @returns what the panel should draw.
 */
async function readCurrentGit(): Promise<ProjectGit> {
  const project = currentProject
  if (project === undefined) return { ok: true, repos: [] }
  if (!gitOnPath) {
    gitOnPath = await hasGit()
    if (!gitOnPath) {
      return { ok: false, reason: 'git is not on your PATH. Add it under Settings → Advanced → Extra PATH entries.' }
    }
  }
  for (;;) {
    const running = gitReading
    if (running === undefined) break
    // Waited out rather than joined blindly: a read of the previous project,
    // or one that began before the change that prompted this call, answers a
    // question nobody asked.
    await running.promise.catch(() => undefined)
    if (running.root === project.path && !gitDirty) return await running.promise
  }
  gitDirty = false
  const promise = readProject(project.path)
  const started = { root: project.path, promise }
  gitReading = started
  // Cleared by a reaction registered here, before any waiter's — so a caller
  // resuming from the loop above sees the slot free and starts the one more
  // read the change it is carrying deserves.
  void promise.then(
    () => {
      if (gitReading === started) gitReading = undefined
    },
    () => {
      if (gitReading === started) gitReading = undefined
    },
  )
  return await promise
}

/**
 * Show a row's diff in the editor column.
 *
 * The repository and path are checked before anything is read, since
 * `git:open-diff` is reachable from the panel's own renderer and neither is
 * evidence of anything — see `gitDiffFor`. A row that fails the check, or
 * whose diff git could not produce, is silently ignored rather than shown as
 * an error: the panel already reflects the repositories it can see, so a
 * mismatched click here would mean the project moved between the click and
 * the answer, not something worth interrupting the user over.
 * @param repo - the repository the row's file belongs to, as the row named it.
 * @param path - the file's path within that repository.
 * @param section - which list the row was in.
 */
async function openGitDiffInPane(repo: string, path: string, section: Section): Promise<void> {
  const project = currentProject
  const sides = await gitDiffFor(repo, path, section, () => (project === undefined ? [] : findRepos(project.path)))
  if (sides === undefined) return
  if (views === undefined || views.window.isDestroyed()) return
  if (!columns.editor.open) {
    setColumn('editor', { open: true })
    storeColumns()
  }
  views.pane.webContents.send('pane:diff-texts', repo, path, sides.original, sides.modified, true)
}

/**
 * How long git changes are collected before the panel is told.
 *
 * A single `git commit` writes the index, HEAD, and a ref within a few
 * milliseconds of each other; without this each one would be a separate read.
 */
const GIT_SETTLE_MS = 200

/** The pending `git:changed`, so a burst of them arrives as one. */
let gitNotify: ReturnType<typeof setTimeout> | undefined

/** Tell the panel to read itself again, once the changes behind it have settled. */
function notifyGitChanged(): void {
  // Marked before the debounce, not after: a read already running started
  // before this change and cannot report it, whenever the message goes out.
  gitDirty = true
  if (gitNotify !== undefined) clearTimeout(gitNotify)
  gitNotify = setTimeout(() => {
    gitNotify = undefined
    if (views === undefined || views.window.isDestroyed()) return
    views.git.webContents.send('git:changed')
  }, GIT_SETTLE_MS)
  gitNotify.unref?.()
}

/**
 * Watches over each repository's own `.git`, closed when the project moves.
 *
 * The project watcher cannot serve here: it drops everything under `.git` (see
 * `IGNORED` in `file-tree.ts`), which is exactly where staging, committing,
 * and fetching are recorded. Working-tree edits still arrive through it.
 */
let gitWatchers: FSWatcher[] = []

/** Stop watching every repository's `.git`. */
function closeGitWatchers(): void {
  for (const watcher of gitWatchers) watcher.close()
  gitWatchers = []
}

/**
 * Watch each repository in the current project for git's own writes.
 *
 * Recursive over `.git`, which covers `index`, `HEAD`, and everything under
 * `refs` in one watch rather than three per repository — and catches the
 * files git actually writes, which are temporaries renamed into place.
 * @param root - the project directory.
 */
function watchRepos(root: string): void {
  for (const repo of findRepos(root)) {
    try {
      const watcher = watch(join(repo, '.git'), { recursive: true, persistent: false }, () => {
        notifyGitChanged()
      })
      gitWatchers.push(watcher)
    } catch (error) {
      // A repository that cannot be watched still reads; the panel refreshes
      // when the window is focused instead.
      console.warn(`dsh-desktop: ${repo} could not be watched for git changes: ${(error as Error).message}`)
    }
  }
}

/**
 * Follow the harness's workspace list for as long as the app runs.
 *
 * A fallback. When the desktop plugin is installed it reports the open
 * session's own directory, which is exact; this covers the case where it is
 * not, using the closest thing the harness writes down — the list moves when
 * a session attaches to a workspace.
 */
function watchWorkspaces(): void {
  try {
    workspaceWatcher = watch(workspacesPath(DSH_HOME), { persistent: false }, () => {
      const newest = readWorkspaces(DSH_HOME)[0]
      // Only when it actually moved: this file is rewritten for reasons that
      // have nothing to do with which project is open.
      if (newest !== undefined && newest.path !== currentProject?.path) {
        currentProject = undefined
        showProject({ path: newest.path, title: newest.title })
      }
    })
  } catch (error) {
    // No workspace storage yet: the tree shows whatever it was last told,
    // which is the harness's own default until a session lands.
    console.warn(`dsh-desktop: the harness's workspaces could not be followed: ${(error as Error).message}`)
  }
}

/**
 * Look for a newer harness once, in the background.
 *
 * At startup rather than when the Settings window opens: an update the user
 * only learns about by opening a window they have no reason to open is one
 * they do not learn about. The answer goes to the tray, which is the surface
 * of this app they see without asking.
 *
 * Never awaited and never surfaced as a failure — an offline registry is not
 * something to interrupt a launch for.
 * @param config - the desktop settings this launch is starting from.
 */
function checkForUpdate(config: DesktopConfig): void {
  if (config.harness.kind !== 'managed') return
  const { package: pkg, version } = config.harness
  try {
    void createUpdateChecker(installDeps, resolveBinary(config.npmPath, 'npm', process.env))(pkg, version)
      .then((latest) => {
        if (latest !== undefined && !quitting) tray?.setUpdate(latest)
      })
      .catch(() => {
        // An offline or unreachable registry leaves the tray as it was.
      })
  } catch {
    // `createUpdateChecker` resolves the npm binary before it has a promise
    // to reject, so a Finder-minimal PATH throws here rather than rejecting.
  }
}

/**
 * Tell this app's own pages which theme to draw in.
 *
 * The harness owns the setting — its Appearance row writes it — so every
 * surface here follows that document rather than offering a second control
 * for the same thing. `system` is passed through as such: only the page knows
 * what the OS is currently showing.
 */
function pushTheme(): void {
  if (views === undefined || views.window.isDestroyed()) return
  const preference = harnessTheme(DSH_HOME)
  // Resolved here rather than in each page: a renderer's
  // `prefers-color-scheme` answers for the document, not the machine, and a
  // page that has not declared `color-scheme` is told light however the OS is
  // set. `nativeTheme` is the machine's own answer.
  const dark = preference === 'dark' || (preference === 'system' && nativeTheme.shouldUseDarkColors)
  const settings = settingsContents()
  for (const target of [
    views.window.webContents,
    views.pane.webContents,
    views.files.webContents,
    // The git panel is a page of this app's own like the rest: without this
    // its body never gets `data-ds-dark-theme`, every `--dsw-alias-*` token
    // resolves to the light value, and the panel renders white beside a dark
    // harness — the failure 0.3.0 fixed for the Settings window.
    views.git.webContents,
    views.terminal.webContents,
    ...(settings === undefined ? [] : [settings]),
  ]) {
    target.send('theme', dark)
  }
}

/**
 * Follow the harness's theme for as long as the app runs.
 *
 * Watched rather than read once: the setting changes in the harness's own UI,
 * and a pane that only matched at launch would drift the moment someone used
 * that control.
 */
function watchTheme(): void {
  try {
    themeWatcher = watch(settingsPath(DSH_HOME), { persistent: false }, () => {
      pushTheme()
    })
  } catch (error) {
    // No settings document yet, or a home this app may not watch: the pages
    // keep whatever they were given, which is the harness's default.
    console.warn(`dsh-desktop: the harness theme could not be followed: ${(error as Error).message}`)
  }
}

/**
 * Show the tree's context menu and wait for a choice.
 *
 * The menu's items are decided in `treeMenu`, which has no Electron in it;
 * this only turns them into a native menu and reports what was chosen.
 * @param window - the window to pop over.
 * @param target - what the menu was opened on.
 * @returns the action chosen, or undefined when the menu was dismissed.
 */
async function popTreeMenu(
  window: BrowserWindow,
  target: { directory: boolean; pending: boolean; name: string },
): Promise<TreeAction | undefined> {
  return await new Promise<TreeAction | undefined>((resolve) => {
    let chosen: TreeAction | undefined
    const menu = Menu.buildFromTemplate(
      treeMenu({ ...target, web: !target.directory && isWebPage(target.name) }).map((item) =>
        'separator' in item
          ? { type: 'separator' as const }
          : {
              label: item.label,
              enabled: item.enabled ?? true,
              click: () => {
                chosen = item.action
              },
            },
      ),
    )
    // `callback` runs after the click handler above, so it reports what was
    // chosen — including nothing, when the menu was dismissed.
    menu.popup({ window, callback: () => resolve(chosen) })
  })
}

/** Refusal for a root that is not a project the harness has opened. */
const OUTSIDE_PROJECT = { ok: false as const, reason: 'That file is not inside a project the harness has opened.' }

/**
 * Whether a directory is one of the projects the harness has opened.
 *
 * Every path the pane may read is rooted in one of these. The renderer names
 * the root it wants, so this is what keeps it to a project the user actually
 * opened rather than anywhere on the disk.
 * @param root - the directory the renderer named.
 * @returns whether it is a known project.
 */
function knownProject(root: string): boolean {
  return readWorkspaces(DSH_HOME).some((workspace) => workspace.path === root)
}

/**
 * Show a file in the editor column, opening it if it is closed.
 *
 * Opening the column is deliberate: a call that loaded a file into a hidden
 * surface would look like nothing happened.
 * @param root - the project directory.
 * @param relative - the file's path within it.
 */
function openInPane(root: string, relative: string): void {
  if (views === undefined || views.window.isDestroyed()) return
  if (!columns.editor.open) {
    setColumn('editor', { open: true })
    storeColumns()
  }
  views.pane.webContents.send('pane:open', root, relative, projectFileUrl(PANE_ORIGIN, root, relative))
  // Opening a file says more about what is being worked on than the workspace
  // list does, so the tree follows it there.
  const workspace = readWorkspaces(DSH_HOME).find((each) => each.path === root)
  if (workspace !== undefined) showProject({ path: workspace.path, title: workspace.title })
}

/** The frameless startup splash, open only until the main window appears. */
let splash: BrowserWindow | undefined
/**
 * Whether a page has ever finished loading in the main window.
 *
 * A window that has loaded nothing paints white, so this gates every reveal:
 * see `revealWindow`.
 */
let windowHasContent = false
/** Whether a reveal arrived before the window had content, to be replayed once it does. */
let revealPending = false
let quitting = false
let tray: TrayController | undefined
let notifier: NotifyServer | undefined
/** A deep link that arrived before the window existed; see the `open-url` handler. */
let deepLinkPending = false

/**
 * Whether two harness sources differ, compared field by field so a config
 * file with reordered (but identical) keys never looks like a change.
 *
 * The `default` branch covers one axis only: it fails to compile if
 * `HarnessSource` grows a new `kind` without a case here. A new *field* on an
 * existing kind still compiles — structural typing lets the extra property
 * through — and would be silently treated as unchanged, so every field added
 * to an arm must be added to its comparison by hand.
 * @param previous - the source being replaced.
 * @param next - the source just configured.
 * @returns whether the two differ.
 */
function harnessSourceChanged(previous: HarnessSource, next: HarnessSource): boolean {
  if (previous.kind !== next.kind) return true
  switch (next.kind) {
    case 'local': {
      const prev = previous as Extract<HarnessSource, { kind: 'local' }>
      return prev.repo !== next.repo
    }
    case 'managed': {
      const prev = previous as Extract<HarnessSource, { kind: 'managed' }>
      return prev.package !== next.package || prev.version !== next.version || prev.workspace !== next.workspace
    }
    default: {
      const exhaustive: never = next
      return exhaustive
    }
  }
}

/** Whether two plugin lists differ in spec or resolved version, order-sensitively. */
function pluginsChanged(previous: PluginEntry[], next: PluginEntry[]): boolean {
  if (previous.length !== next.length) return true
  return previous.some((entry, index) => entry.spec !== next[index].spec || entry.version !== next[index].version)
}

/** Whether two configs differ in a way that requires respawning the harness child. */
function needsRestart(previous: DesktopConfig | undefined, next: DesktopConfig): boolean {
  if (previous === undefined) return true
  return (
    harnessSourceChanged(previous.harness, next.harness) ||
    // The notify port is baked into the generated hooks.json at boot, so a
    // changed port only reaches the harness through a respawn.
    previous.notifyPort !== next.notifyPort ||
    // Both binaries are resolved when the child is spawned.
    previous.pnpmPath !== next.pnpmPath ||
    previous.npmPath !== next.npmPath ||
    // Every entry's resolved entry file is baked into the generated overlay
    // at boot, so a newly resolved or reordered list only reaches the
    // harness child through a respawn.
    pluginsChanged(previous.plugins ?? [], next.plugins ?? []) ||
    // Every enabled server contributes its own overlay row and its own
    // environment variable, both fixed at spawn, so any change to the
    // section — the master switch, a server's URL, or which servers are on
    // — only reaches the harness through a respawn. Compared by value
    // because the section is rebuilt fresh on every save.
    mcpChanged(previous, next)
  )
}

/**
 * Every enabled MCP server's token, as environment variables for the harness
 * child.
 *
 * Read at spawn time rather than cached: `mcp.json` is hand-editable and may
 * have changed since the last boot, and the restart that follows a save must
 * pick up the new values.
 * @param config - the desktop settings this boot is starting from.
 * @returns the variables to add to the child's environment.
 */
function mcpEnv(config: DesktopConfig): Record<string, string> {
  return serverEnv(configuredMcpServers(), config.mcpEnabled === true)
}

/**
 * Every server `mcp.json` configures, enabled or not.
 * @returns the configured entries, in file order.
 */
function configuredMcpServers(): McpServerEntry[] {
  return [...readMcpConfig(mcpConfigPath(DSH_HOME)), ...viewToolsEntry()]
}

/**
 * This app's own view tools, as a server entry the harness can mount.
 *
 * Synthesized per boot rather than written into `mcp.json`: the port is this
 * process's, so a file entry would be stale the moment the app is not
 * running, and `mcp.json` is the user's file — a server they never added has
 * no business appearing in it.
 * @returns the entry, or nothing when the tools are switched off or not up.
 */
function viewToolsEntry(): McpServerEntry[] {
  // These are MCP tools, served to the harness's MCP client — so the master
  // switch governs them as it governs every other server. Their own switch
  // decides whether they are offered at all; that one decides whether
  // anything is.
  if (viewServer === undefined) return []
  const port = String(viewServer.port)
  // One entry per surface, so the harness namespaces each surface's tools
  // under its own name and the tool itself is left as a bare verb.
  return Object.values(SURFACES).map((surface) => ({
    name: surface.name,
    disabled: false,
    transport: 'http' as const,
    args: [],
    env: {},
    url: `http://127.0.0.1:${port}${surface.path}`,
    headers: {},
    rest: {},
  }))
}

/**
 * Check the install, repair what can be repaired, and only then boot.
 *
 * Before this, `desktop.json` could declare a plugin that was never
 * installed — plugins install during a Settings save — and the Plugins tab
 * reported that divergence as a failure the user did not cause. Repair runs
 * ahead of the boot rather than behind it: a session that starts without its
 * plugins and is then restarted underneath is worse than a launch that says
 * what it is waiting for.
 *
 * Never throws. Every phase here is best-effort — the harness boots after it
 * whatever happened, exactly as it did before this existed.
 * @param config - the stored settings this launch is starting from.
 * @returns resolution once the screen has handed off to the boot.
 */
async function runStartupPhases(config: DesktopConfig): Promise<void> {
  try {
    splash = await showStartup({ openSettings: showSettings, continueAnyway: () => {} })
  } catch {
    // A startup page that will not load must not cost the user their launch:
    // the boot below is what matters, and it proceeds unannounced.
    return
  }

  // The MCP client is filtered out for the same reason the boot filters it:
  // this app owns that package on the MCP tab, a bare entry for it is
  // residue, and offering to install something the boot will ignore would
  // spend the user's time on a plugin that then does not appear.
  const checked: DesktopConfig = {
    ...config,
    plugins: (config.plugins ?? []).filter((entry) => parseSpec(entry.spec).package !== MCP_CLIENT_PACKAGE),
  }
  const findings: Finding[] = runHealthcheck(checked, {
    preflight,
    statusFor: (entry) => pluginStatus(installDeps, DSH_HOME, entry),
    // Checked against what the boot will actually mount, below.
    binaryResolves: (configured, name) => {
      try {
        resolveBinary(configured, name, process.env)
        return true
      } catch {
        // `resolveBinary` throws when a Finder-minimal PATH cannot supply the
        // launcher and no absolute path is configured — which is the finding.
        return false
      }
    },
    shellPathCached: () => cachedShellPath() !== undefined,
  })
  pushFindings(splash, findings)

  const missing = repairablePlugins(findings)
  if (missing.length === 0) {
    pushPhase(splash, 'starting')
    return
  }

  pushPhase(splash, 'repairing')
  const outcome = await repairPlugins(
    missing,
    config.npmPath,
    {
      installPlugin: installPluginEntry,
      isQuitting: () => quitting,
    },
    (line) => pushProgress(splash, line),
  )
  if (quitting) return
  for (const failure of outcome.failed) pushProgress(splash, `${failure.spec}: ${failure.reason}`)
  recordRepairedVersions(config, outcome.installed)
  pushPhase(splash, 'starting')
}

/**
 * Write the versions a repair resolved back into the stored config.
 *
 * An entry with no recorded version is what `pluginStatus` reports as not
 * installed, so without this the same plugin is found missing and reinstalled
 * on every launch — the repair would never converge. A failed write is not
 * fatal: the boot below reads the config from disk either way, and the only
 * cost is that the next launch repairs again.
 * @param config - the config this launch started from.
 * @param installed - each repaired spec with the version npm resolved.
 */
function recordRepairedVersions(config: DesktopConfig, installed: { spec: string; version: string }[]): void {
  if (installed.length === 0) return
  const resolved = new Map(installed.map(({ spec, version }) => [spec, version]))
  const plugins = (config.plugins ?? []).map((entry) => {
    const version = resolved.get(entry.spec)
    return version === undefined ? entry : { ...entry, version }
  })
  try {
    writeConfig(CONFIG_PATH, { ...config, plugins })
  } catch (error) {
    console.warn(`dsh-desktop: the repaired plugin versions could not be recorded: ${(error as Error).message}`)
  }
}

/**
 * The PATH a probed MCP server should be started with: the same composition
 * the harness child receives.
 * @returns the composed PATH.
 */
function probePath(): string {
  const stored = loadConfig(CONFIG_PATH)
  const extraPath = stored.configured ? stored.config.extraPath : undefined
  return composePath(process.env.PATH ?? '', extraPath, cachedShellPath())
}

/**
 * The login-shell PATH this boot should hand the harness child.
 *
 * Read from cache rather than resolved here: resolution costs seconds (an
 * interactive login shell sources the user's whole rc file), which must not
 * be added to every launch. `refreshShellPath` updates the cache in the
 * background, so a machine whose toolchain moved is correct from the next
 * launch onward.
 * @returns the cached PATH, or undefined on a first run or after a failure.
 */
function cachedShellPath(): string | undefined {
  return readCachedShellPath(shellPathCachePath(DSH_HOME))
}

/**
 * Re-resolve the login-shell PATH and cache it, off the launch path.
 *
 * Deliberately fire-and-forget and deliberately not awaited: nothing in this
 * boot uses the result, and a shell that takes its full timeout must delay
 * nothing the user can see. A failure leaves the previous cache in place.
 */
function refreshShellPath(): void {
  setTimeout(() => {
    const resolved = resolveShellPath(process.env.SHELL, runShell)
    if (resolved === undefined) return
    try {
      writeCachedShellPath(shellPathCachePath(DSH_HOME), resolved, process.env.SHELL ?? '', new Date().toISOString())
    } catch {
      // A cache that cannot be written is not worth reporting: the next
      // launch simply resolves again, and nothing else depends on it.
    }
  }, 0).unref()
}

/**
 * Whether the MCP master switch or client version changed in a way a boot
 * bakes in.
 *
 * The servers themselves are deliberately not compared here: they live in
 * `mcp.json`, outside the config this function is given, so a save that edits
 * them restarts the harness explicitly (see `settings-ipc.ts`) rather than
 * being detected by comparing two `DesktopConfig` values that are identical.
 * @param previous - the settings applied to the running harness.
 * @param next - the settings just saved.
 * @returns whether the harness has to be respawned.
 */
function mcpChanged(previous: DesktopConfig | undefined, next: DesktopConfig): boolean {
  return previous?.mcpEnabled !== next.mcpEnabled || previous?.mcpClientVersion !== next.mcpClientVersion
}

/**
 * Apply saved settings to the running app.
 *
 * Harness-affecting changes go through `restart`, the same serialized
 * transition the tray's Restart uses, so a save can never interleave with a
 * boot, another restart, or shutdown.
 *
 * `quitting` is re-checked after every `await` and before every side effect:
 * the save's own check happens before the write, but a quit landing during any
 * of these awaits has already run `will-quit`, so a listener bound afterwards
 * is younger than the teardown that would have closed it and a hotkey armed
 * afterwards outlives `unregisterAll()`.
 * @param previous - the config being replaced, or undefined on a first run.
 * @param next - the config just written to disk.
 * @returns non-blocking warnings for the settings form to display.
 */
export async function applySettings(previous: DesktopConfig | undefined, next: DesktopConfig): Promise<string[]> {
  const warnings: string[] = []
  if (needsRestart(previous, next)) {
    // restart() reports 'starting' on the tray for the whole respawn window;
    // inlining stop-then-boot here would leave a stale 'running' dot up for as
    // long as the readiness timeout.
    await restart()
  }

  if (!quitting && previous?.notifyPort !== next.notifyPort) {
    await notifier?.close()
    notifier = undefined
    if (!quitting) {
      try {
        const started = await startNotifyListener(next.notifyPort, onTurnEnd)
        if (quitting) {
          // `will-quit` already closed whatever it knew about; this listener
          // was bound after that, so nothing else would ever close it.
          await started.close()
        } else {
          notifier = started
        }
      } catch (error) {
        warnings.push((error as Error).message)
      }
    }
  }

  if (!quitting && previous?.hotkey !== next.hotkey) {
    globalShortcut.unregisterAll()
    if (!globalShortcut.register(next.hotkey, toggleWindow)) {
      warnings.push(`The hotkey ${next.hotkey} could not be registered; another app already owns it.`)
      // unregisterAll() already dropped the previous binding, so without this
      // the app would silently end up with no hotkey at all; re-arm the one
      // that was working rather than leave the user with nothing bound.
      if (previous !== undefined && !globalShortcut.register(previous.hotkey, toggleWindow)) {
        // Both accelerators are gone: the user has no hotkey at all, which is
        // exactly the state the save result is supposed to name.
        warnings.push(
          `The previous hotkey ${previous.hotkey} could not be restored either; no show/hide shortcut is bound.`,
        )
      }
    }
  }

  return warnings
}

/**
 * Owns every `npm` child a managed install spawns.
 *
 * Held at module scope, not inside the installer, because the quit path has to
 * reach it: an install runs for minutes, and `shutdown` reaps these children
 * alongside the harness child rather than letting them outlive the app.
 */
const installs = createInstallRunner()

/**
 * Probes candidate MCP servers, and owns their children the same way
 * `installs` owns an install's — a probed server may spawn a browser or a
 * language server, and quitting must reap the whole group.
 */
const probes = createMcpProber()

/** Real `InstallDeps`, backing `runtime-install.ts`'s effects with the actual filesystem and `npm`. */
const installDeps: InstallDeps = {
  run: (command, args, options) => installs.run(command, args, options),
  exists: existsSync,
  mkdir: (path) => mkdirSync(path, { recursive: true }),
  rm: (path) => rmSync(path, { recursive: true, force: true }),
  rename: renameSync,
}

/**
 * Resolve and install one plugin entry.
 *
 * Named rather than inlined into the settings dependencies because startup
 * repair installs through it too: an entry installed at launch must be
 * indistinguishable from one installed by a save, and two call sites sharing
 * a definition is the only way that stays true.
 * @param pkg - the package name.
 * @param version - the concrete version or dist-tag to install.
 * @param npmPath - the configured `npm` override.
 * @param onLine - receives `npm install` output as it arrives.
 * @returns the concrete installed version.
 */
function installPluginEntry(
  pkg: string,
  version: string,
  npmPath: string | undefined,
  onLine: (line: string) => void,
): Promise<string> {
  return createManagedInstaller(
    installDeps,
    resolveBinary(npmPath, 'npm', process.env),
    DSH_HOME,
    // A plugin entry links no `bin`, so its completion marker cannot be the
    // default `dsh` binary check; see `plugin-entries.ts`'s own doc.
    (dir) => pluginInstallMarker(dir, pkg),
  )(pkg, version, onLine)
}

const settingsHandlers = createSettingsHandlers({
  readConfig: () => loadConfig(CONFIG_PATH),
  writeConfig: (config) => writeConfig(CONFIG_PATH, config),
  pickFolder: async () => {
    const chosen = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return chosen.canceled ? undefined : chosen.filePaths[0]
  },
  probePort: portIsFree,
  apply: applySettings,
  isQuitting: () => quitting,
  installManaged: (pkg, version, npmPath, onLine) =>
    createManagedInstaller(installDeps, resolveBinary(npmPath, 'npm', process.env), DSH_HOME)(pkg, version, onLine),
  installPlugin: installPluginEntry,
  checkManagedUpdate: (pkg, installed, npmPath) =>
    createUpdateChecker(installDeps, resolveBinary(npmPath, 'npm', process.env))(pkg, installed),
  checkBinaries: (pnpmPath, npmPath) => checkBinaries(pnpmPath, npmPath, process.env, CHECK_BINARY_TIMEOUT_MS),
  disabledPlugins: () => Object.fromEntries(disabledPlugins),
  clientLinkWarnings: () => Object.fromEntries(clientLinkWarnings),
  openConfigFile: () => openConfigFile(CONFIG_PATH, existsSync, (path) => shell.openPath(path)),
  readMcpServers: () => readMcpConfig(mcpConfigPath(DSH_HOME)),
  writeMcpServers: (servers) => writeMcpConfig(mcpConfigPath(DSH_HOME), servers),
  openMcpConfigFile: () => openConfigFile(mcpConfigPath(DSH_HOME), existsSync, (path) => shell.openPath(path)),
  readWorkspaces: () => readWorkspaces(DSH_HOME),
  openProjectMcpFile: (file) => openConfigFile(file, existsSync, (path) => shell.openPath(path)),
  writeProjectMcpServers: (file, servers) => writeMcpConfig(file, servers),
  readMcpPresets: () => loadPresets(shippedPresetsPath(), userPresetsPath(DSH_HOME)),
  probeMcpServer: (target, onLine) =>
    // The probe spawns the server's command directly from this process,
    // which under a Finder launch has only the system PATH — `npx` and
    // friends live nowhere in it. It needs exactly the PATH the harness
    // child is given, or a server that works once mounted fails to probe.
    probes.probe({ ...target, env: { PATH: probePath(), ...target.env } }, onLine),
  restartHarness: () => restart(),
})

/**
 * The harness child this app owns, from `spawn()` until it is stopped.
 *
 * It is set the moment the child exists — before readiness — so the quit path
 * can always reap it; without that, quitting mid-boot leaves a detached child
 * (and its node-pty grandchildren) behind.
 */
interface Child {
  /** Which `boot` produced this child; see `generation`. */
  generation: number
  stop(): Promise<void>
}
let child: Child | undefined

/**
 * Why each currently-configured plugin is not mounted in the running
 * harness, keyed by package name; absent means the entry is either mounted
 * or not configured at all.
 *
 * Held at module scope, not on the settings window: a boot's outcome must
 * reach a Settings window opened long after that boot finished, and this is
 * what `read()` (via `SettingsDeps.disabledPlugins`) consults regardless of
 * whether any window existed when the boot happened. Replaced wholesale by
 * `recordDisabledPlugins` at the end of every boot attempt that reaches a
 * final outcome — never merged — so a plugin that starts working again after
 * a later boot cannot leave a stale reason behind.
 */
let disabledPlugins = new Map<string, string>()

/**
 * Replace the disabled-plugin state a Settings window reads, from a single
 * boot attempt's own knowledge: entries the overlay never tried to mount
 * (pre-flight `omitted`, e.g. not installed yet) and entries this boot
 * isolated after attributing a runtime failure to them.
 * @param omitted - pre-flight omissions from the attempt that ultimately ran.
 * @param isolated - package/reason pairs isolated during this boot's retries.
 */
/**
 * A tray-sized summary of the plugins that were dropped.
 *
 * The harness's own reason is a full error, stack trace included, and a menu
 * item renders its label on one unwrapped line — pasting the reason there
 * stretches the menu across the screen. The reason belongs on the plugin's
 * row in Settings, which shows it in full; the tray only says which plugins
 * are affected and where to look.
 * @param isolated - the entries dropped to get the harness running.
 * @returns a short note, or an empty string when nothing was dropped.
 */
function summariseDisabled(isolated: readonly { package: string }[]): string {
  if (isolated.length === 0) return ''
  const names = isolated.map((entry) => entry.package)
  const listed = names.length <= 2 ? names.join(' and ') : `${names.length} plugins`
  return `${listed} disabled — see Settings for why`
}

function recordDisabledPlugins(omitted: { package: string; reason: string }[], isolated: { package: string; reason: string }[]): void {
  disabledPlugins = new Map([...omitted, ...isolated].map((entry) => [entry.package, entry.reason]))
}

/**
 * Why a currently-mounted plugin's browser half did not load, keyed by
 * package name; absent means either the plugin has no declared browser half
 * (see `plugin-entries.ts`'s `declaresClientHalf`) or its half loaded fine.
 *
 * Distinct from `disabledPlugins`: an entry here is still mounted — its
 * tools work — but `ensurePluginLink` could not link it by name, which is
 * the only way `@deepseek-ai/dsh-client-modules` ever discovers a browser
 * bundle (see `plugin-link.ts`). Held at module scope for the same reason
 * `disabledPlugins` is: a Settings window opened long after the boot that
 * discovered this must still see it. Replaced wholesale, never merged, at
 * the end of every boot attempt that reaches a final outcome.
 */
let clientLinkWarnings = new Map<string, string>()

/**
 * Replace the client-link-warning state a Settings window reads.
 * @param warnings - package/reason pairs from the boot attempt that ultimately ran.
 */
function recordClientLinkWarnings(warnings: { package: string; reason: string }[]): void {
  clientLinkWarnings = new Map(warnings.map((entry) => [entry.package, entry.reason]))
}

/**
 * Incremented for every child the app starts and every stop it performs.
 *
 * A child's `'exit'` can arrive after its replacement is already running, so
 * every callback checks its own generation against this counter and does
 * nothing when it has been superseded. Without that check a dead child's
 * `onExit` overwrites the live child's state, which both misreports the UI and
 * hides the live child from the quit path — orphaning its process group.
 */
let generation = 0

/**
 * Tail of the serialized lifecycle chain.
 *
 * Every async transition (boot, restart, the final stop) runs through
 * `enqueue`, so transitions never interleave and `before-quit` can make itself
 * the last link: a quit is therefore always ordered after whatever transition
 * is in flight, instead of racing an `await` that leaves the app looking idle.
 */
let transition: Promise<void> = Promise.resolve()

/**
 * Append a lifecycle step to the serialized chain.
 * @param step - the transition to run once the chain is free.
 * @returns a promise that settles when this step is done; it never rejects.
 */
function enqueue(step: () => Promise<void>): Promise<void> {
  const next = transition.then(step).catch((error: unknown) => {
    console.error('dsh-desktop: lifecycle step failed', error)
  })
  transition = next
  return next
}

/**
 * Report the server status through the tray.
 * @param next - the new status.
 * @param note - a non-blocking condition discovered at boot, shown alongside
 *   the status; omit when there is none.
 */
function setStatus(next: ServerStatus, note?: string): void {
  if (note === undefined) tray?.setStatus(next)
  else tray?.setStatus(next, note)
}

/**
 * Report a failure in the window, if one is still there to report it in.
 * @param title - short failure summary.
 * @param detail - remedy text or captured stderr.
 */
function fail(title: string, detail: string): void {
  setStatus('failed')
  if (views !== undefined && !views.window.isDestroyed()) showError(views, title, detail)
}

/**
 * Report a failure the user can fix in Settings, and open it so the fix is
 * one step away.
 *
 * Reserved for configuration-class failures: an unreadable or invalid config,
 * a checkout that is missing or unbuilt, or a launcher that cannot be
 * resolved. A harness that was configured correctly and then crashed or timed
 * out goes through `fail` alone — reopening Settings there would be noise
 * over a problem Settings cannot fix, and the existing retry pane (Restart in
 * the tray) is the right response.
 * @param title - short failure summary.
 * @param detail - remedy text.
 */
function failConfiguration(title: string, detail: string): void {
  fail(title, detail)
  showSettings()
}

/**
 * Bring the window to the front, unless it would come up empty.
 *
 * macOS fires `activate` as the app launches, and the tray, the hotkey, and a
 * cold-start deep link all reach here too — every one of them before the
 * harness URL has painted anything. Showing the window then puts a blank
 * white frame behind the splash, so the reveal waits for content and raises
 * the splash instead, that being the window the user is meant to be looking
 * at while the startup sequence runs.
 */
function revealWindow(): void {
  if (!windowHasContent) {
    revealPending = true
    if (splash !== undefined && !splash.isDestroyed()) splash.focus()
    return
  }
  if (window === undefined || window.isDestroyed()) return
  window.show()
  window.focus()
}

/** Where the generated patch overlay and hook config are written. */
function runtimeDirectory(): string {
  return join(app.getPath('userData'), 'runtime')
}

/**
 * Stop the child this app currently owns and retire its generation.
 * @returns a promise that settles once the child's process group is gone.
 */
async function stopCurrent(): Promise<void> {
  const stopping = child
  child = undefined
  generation += 1
  await stopping?.stop()
}

/**
 * Start the harness and point the window at it.
 * Runs only inside `enqueue`, so it can assume no other transition is active.
 */
async function bootNow(): Promise<void> {
  if (quitting) return
  if (window === undefined || window.isDestroyed()) return

  let config: DesktopConfig
  try {
    const result = loadConfig(CONFIG_PATH)
    if (!result.configured) {
      // The config was removed or never saved; settings is the only useful
      // thing to show until the user configures a harness.
      showSettings()
      return
    }
    config = result.config
  } catch (error) {
    failConfiguration('Configuration problem', (error as Error).message)
    return
  }

  const check = preflight(config.harness)
  if (!check.ok) {
    failConfiguration('The harness checkout is not ready', check.message)
    return
  }

  const mine = (generation += 1)

  const attempt = await attemptBoot(config, mine, new Set())

  if (attempt.ok) {
    if (mine !== generation) {
      // A stop overtook this boot; the child is already being reaped elsewhere.
      return
    }
    recordDisabledPlugins(attempt.omitted, [])
    recordClientLinkWarnings(attempt.clientWarnings)
    setStatus('running', attempt.hooksNote)
    if (views !== undefined && !views.window.isDestroyed()) void views.harness.webContents.loadURL(attempt.handle.url)
    return
  }

  if (attempt.stage === 'files') {
    fail('The harness launch files could not be written', attempt.message)
    return
  }

  // attempt.stage === 'server'
  if (mine !== generation) return
  // The rejection paths (readiness timeout, early exit) can leave a child
  // mid-death, so it is reaped here rather than merely forgotten. This is
  // also every retry's own generation token from here on: `stopCurrent`
  // always advances `generation`, so `mine` itself can never match it again
  // — each retry needs a fresh baseline captured right after this expected
  // bump, not the boot's original token, to tell a legitimate advance (this
  // reap) from an illegitimate one (a newer transition superseding this
  // attempt).
  await stopCurrent()
  let token = generation

  // A ConfigurationError means `dshWebCommand` could not resolve the
  // configured launcher — a config mistake unrelated to plugins, fixed in
  // Settings; a bad harness path must still fail fast, not after a second
  // full timeout. Every other rejection (readiness timeout, early exit,
  // spawn ENOENT) means a correctly configured launcher started something
  // that then failed, which — when the overlay had inserted at least one
  // plugin — is retried, isolating the plugin the error attributes the
  // failure to (see `attributeBootFailure`) rather than dropping every
  // plugin: the app holds that a broken plugin costs its own feature, never
  // the whole app, and a plugin that loads but rejects its config is exactly
  // that case, just discovered one step later than the loadability probe
  // alone catches. When a failure names no identifiable plugin, every
  // remaining candidate is dropped at once — the old drop-all behavior,
  // still reported below via `isolated`.
  let current: BootAttempt = attempt
  const excluded = new Set<string>()
  const isolated: { package: string; reason: string }[] = []
  let attemptsMade = 1

  while (
    current.stage === 'server' &&
    current.insertedCount > 0 &&
    !(current.error instanceof ConfigurationError) &&
    !quitting &&
    attemptsMade < 1 + MAX_ISOLATION_ATTEMPTS
  ) {
    const survivors = current.ready.filter((entry) => !excluded.has(entry.package))
    const culprit = attributeBootFailure(current.error.message, survivors)
    if (culprit !== undefined) {
      excluded.add(culprit)
      isolated.push({ package: culprit, reason: current.error.message })
    } else {
      // Unattributable: falling back to dropping every plugin still standing
      // is reported the same as an attributed isolation, via `isolated`, so
      // the user still learns plugins were disabled and why, even though the
      // "why" here is the harness's own undifferentiated failure rather than
      // a single named cause.
      for (const entry of survivors) {
        excluded.add(entry.package)
        isolated.push({ package: entry.package, reason: current.error.message })
      }
    }

    attemptsMade += 1
    const retry = await attemptBoot(config, token, excluded)

    if (token !== generation) {
      // Superseded (a newer boot, restart, or shutdown landed mid-retry) —
      // the retry's child, if any, must still be reaped rather than left
      // running unreported.
      if (retry.ok) await stopCurrent()
      return
    }

    if (retry.ok) {
      recordDisabledPlugins(retry.omitted, isolated)
      recordClientLinkWarnings(retry.clientWarnings)
      setStatus(
        'running',
        [retry.hooksNote, summariseDisabled(isolated)]
          .filter((note): note is string => note !== undefined && note !== '')
          .join('; '),
      )
      if (views !== undefined && !views.window.isDestroyed()) void views.harness.webContents.loadURL(retry.handle.url)
      return
    }

    if (retry.stage === 'files') {
      // Unreachable in practice — the primary attempt already wrote these
      // files successfully — but handled the same way a primary files
      // failure is, rather than left to fall through as a server failure.
      fail('The harness launch files could not be written', retry.message)
      return
    }

    await stopCurrent()
    token = generation
    current = retry
  }

  // Every isolation attempt is reported even though the loop is exiting on
  // an unrecoverable failure, so Settings can show why a plugin dropped
  // along the way is disabled, not just the final error pane.
  recordDisabledPlugins([], isolated)
  recordClientLinkWarnings(current.stage === 'server' ? current.clientWarnings : [])

  if (current.stage === 'server' && current.error instanceof ConfigurationError) {
    failConfiguration('The harness failed to start', current.error.message)
  } else if (current.stage === 'server') {
    fail('The harness failed to start', current.error.message)
  }
}

/** What one `attemptBoot` call produced. */
type BootAttempt =
  | {
      ok: true
      handle: ServerHandle
      hooksNote?: string
      omitted: { package: string; reason: string }[]
      clientWarnings: { package: string; reason: string }[]
    }
  | { ok: false; stage: 'files'; message: string }
  | {
      ok: false
      stage: 'server'
      error: Error
      insertedCount: number
      ready: AttributionRow[]
      clientWarnings: { package: string; reason: string }[]
    }

/**
 * Write the runtime files and spawn the harness once, with every configured
 * plugin entry resolved except those in `excludePackages` — the shape
 * `bootNow` uses for the primary boot (empty set) and for every isolation or
 * drop-all retry (one or more packages named).
 *
 * Runs only inside `enqueue` (via `bootNow`), so it can assume no other
 * transition is active; still checks `mine !== generation` nowhere itself —
 * that is `bootNow`'s job, since only it knows whether a given attempt is
 * the primary or a retry, and only it holds the per-retry token.
 * @param config - the desktop settings this boot is starting from.
 * @param mine - this boot's generation token, closed over by `onSpawned`/`onExit`.
 * @param excludePackages - package names to leave out of the overlay
 *   entirely, as if they were never configured — empty for the primary boot.
 * @returns the outcome, discriminated by `ok` and, on failure, by `stage`.
 */
async function attemptBoot(config: DesktopConfig, mine: number, excludePackages: ReadonlySet<string>): Promise<BootAttempt> {
  let patchPath: string
  let hooksNote: string | undefined
  let omitted: { package: string; reason: string }[] = []
  let ready: AttributionRow[] = []
  let clientWarnings: { package: string; reason: string }[] = []
  try {
    // Where each configured plugin entry would load from, or why it is
    // unavailable — from whatever a Settings save last resolved and
    // installed; never installed here at boot. The hook bridge is
    // privileged with `configPath` pointing at the hooks file this same
    // boot is about to write; every other entry gets none.
    const { hooksPath } = runtimeFilePaths(runtimeDirectory())
    // The MCP client is filtered out of the user's own plugin list, not just
    // absent from it: a bare entry for it carries no config, which cordis
    // rejects at load, and this app owns that package's configuration on the
    // MCP tab. A save drops such an entry permanently (see
    // `settings-validate.ts`); this keeps one that is still on disk from
    // failing the boot in the meantime.
    const configured = (config.plugins ?? []).filter(
      (entry) =>
        !excludePackages.has(parseSpec(entry.spec).package) && parseSpec(entry.spec).package !== MCP_CLIENT_PACKAGE,
    )
    // The MCP client is not a plugin entry the user manages: it is one
    // package backing however many servers the MCP tab configures, so it is
    // installed and resolved exactly like an entry but never appears in
    // that list. It is skipped entirely when no server is enabled — the
    // whole point of the master switch is that the harness pays nothing.
    const mcpServers = activeServers(configuredMcpServers(), config.mcpEnabled === true)
    const mcpEntries: PluginEntry[] =
      mcpServers.length === 0 || excludePackages.has(MCP_CLIENT_PACKAGE)
        ? []
        : [{ spec: MCP_CLIENT_PACKAGE, ...(config.mcpClientVersion === undefined ? {} : { version: config.mcpClientVersion }) }]
    const statuses = [...configured, ...mcpEntries].map((entry) =>
      pluginStatus(installDeps, DSH_HOME, entry, parseSpec(entry.spec).package === HOOKS_PACKAGE ? hooksPath : undefined),
    )
    // Linked (bare package name) whenever `ensurePluginLink` succeeds — the
    // only way `@deepseek-ai/dsh-client-modules` ever discovers a plugin's
    // browser bundle, see `plugin-link.ts`. Falls back to the resolved
    // absolute entry path when linking fails, which still mounts the
    // plugin's tools; a plugin that declares a browser half
    // (`declaresClientHalf`) and lost it to that fallback is collected into
    // `clientWarnings` rather than silently downgraded. Every package this
    // boot links is collected into `linked` so the prune pass below removes
    // exactly the links that are not (or no longer) wanted; `presetIds`
    // does the same for the agent presets a plugin's own manifest declares
    // (see `plugin-entries.ts`'s `presetsDeclaration`), independent of
    // whether linking itself succeeded.
    const linked = new Set<string>()
    const presetIds = new Set<string>()
    const warnings: { package: string; reason: string }[] = []
    const resolveName = (status: Extract<PluginStatus, { kind: 'ready' }>): string => {
      const declaration = presetsDeclaration(status.packageDir)
      if (declaration !== undefined) {
        for (const id of ensurePluginPresets(DSH_HOME, status.package, status.packageDir, declaration)) presetIds.add(id)
      }

      const result = ensurePluginLink(DSH_HOME, PROFILE, status.package, status.packageDir)
      if (result.linked) {
        linked.add(status.package)
        return status.package
      }
      if (declaresClientHalf(status.packageDir)) warnings.push({ package: status.package, reason: result.reason })
      return status.entryPath
    }
    // A package's own declared mount (`plugin-entries.ts`'s
    // `bundlePatchDeclaration`) is read and parsed independently of linking
    // or presets above: `patchOverlay` decides whether to use it (falling
    // back to a synthesized row on a collision or a missing/malformed
    // declaration) so this resolver only ever surfaces what the package
    // itself declared.
    const resolveDeclaredPatch = (status: Extract<PluginStatus, { kind: 'ready' }>) => {
      // The MCP client's rows are this app's own, one per enabled server,
      // and take precedence over anything that package may declare for
      // itself: a single declared row could only mount one server, and its
      // id would collide the moment a second was configured.
      if (status.package === MCP_CLIENT_PACKAGE && mcpServers.length > 0) {
        return serverRows(configuredMcpServers(), config.mcpEnabled === true)
      }
      const declaredPath = bundlePatchDeclaration(status.packageDir)
      return declaredPath !== undefined ? loadDeclaredPatchRows(status.packageDir, declaredPath) : undefined
    }
    const files = writeRuntimeFiles(runtimeDirectory(), config.notifyPort, statuses, undefined, resolveName, resolveDeclaredPatch)
    reconcilePluginLinks(DSH_HOME, PROFILE, linked)
    reconcilePluginPresets(DSH_HOME, presetIds)
    patchPath = files.patchPath
    omitted = files.omitted
    ready = files.ready
    clientWarnings = warnings
    const bridgeOmitted = omitted.find((entry) => entry.package === HOOKS_PACKAGE)
    const otherOmitted = omitted.filter((entry) => entry.package !== HOOKS_PACKAGE)
    const notes: string[] = []
    if (bridgeOmitted !== undefined) notes.push(`notifications unavailable — hook bridge not loaded: ${bridgeOmitted.reason}`)
    for (const entry of otherOmitted) notes.push(`${entry.package} not loaded: ${entry.reason}`)
    for (const entry of clientWarnings) notes.push(`${entry.package} browser UI unavailable — not linked by name: ${entry.reason}`)
    hooksNote = notes.length > 0 ? notes.join('; ') : undefined
  } catch (error) {
    return { ok: false, stage: 'files', message: (error as Error).message }
  }

  try {
    const handle = await startServer({
      spec: dshWebCommand(config, patchPath, DSH_HOME, mcpEnv(config), cachedShellPath()),
      timeoutMs: READY_TIMEOUT_MS,
      onSpawned: (stop) => {
        child = { generation: mine, stop }
      },
      onExit: (code, tail) => {
        if (mine !== generation) return
        child = undefined
        fail(`The harness exited (code ${String(code)})`, tail || 'No output captured.')
      },
    })
    return { ok: true, handle, hooksNote, omitted, clientWarnings }
  } catch (error) {
    const insertedCount = ready.length
    return { ok: false, stage: 'server', error: error as Error, insertedCount, ready, clientWarnings }
  }
}

/**
 * Stop the current server (if any) and boot a fresh one.
 *
 * The whole stop-then-boot sequence is one link in the lifecycle chain, so a
 * quit arriving inside the stop window is ordered after it instead of finding
 * no child to reap and letting the queued boot spawn one behind its back.
 */
async function restart(): Promise<void> {
  await enqueue(async () => {
    await stopCurrent()
    setStatus('starting')
    await bootNow()
  })
}

/**
 * Reap the harness and let every in-flight transition unwind, before quitting.
 *
 * `quitting` is set first and synchronously, so a transition still queued
 * behind this one cannot spawn anything the quit would not know about. The
 * child is then stopped directly rather than through `enqueue`: a boot waits
 * on its child's readiness, so queuing the reap behind it would make the quit
 * wait out the readiness timeout instead of cutting the boot short. Stopping
 * the child is what lets that boot unwind — its `startServer` rejects once the
 * child is gone — which is why the chain is only awaited afterwards.
 * @returns a promise that settles once nothing of this app's is left running.
 */
async function shutdown(): Promise<void> {
  quitting = true
  // A frameless splash is not a window the user can close, so a quit during
  // startup has to take it down itself.
  closeStartup(splash)
  splash = undefined
  themeWatcher?.close()
  themeWatcher = undefined
  workspaceWatcher?.close()
  workspaceWatcher = undefined
  projectWatcher?.close()
  projectWatcher = undefined
  closeGitWatchers()
  // The install child is reaped first and unconditionally: it is in neither
  // the lifecycle chain nor `child`, so nothing below would ever find it, and
  // an unreaped `npm` keeps writing into $DSH_HOME after Electron is gone.
  // Killing it also makes the in-flight save's install reject, which is what
  // lets that save unwind instead of finishing behind the quit's back.
  await Promise.all([installs.stopAll(), probes.stopAll()])
  await stopCurrent()
  await transition
  // A transition that was mid-flight may have registered a child of its own
  // between the stop above and its own quitting check.
  await stopCurrent()
}

/** Serialized entry point for the tray's "Restart harness" action; see `restart`. */
const restartOnce = singleFlight(restart)

/**
 * Open settings, quitting if a first run closes it without configuring anything.
 *
 * An unreadable config is deliberately not a quit: it means a real config may
 * exist and merely be broken, and quitting would take away the one window that
 * can repair it. The app stays in the tray, where Settings is reachable again.
 */
function showSettings(): void {
  openSettings(settingsHandlers, () => {
    let stored: ConfigResult
    try {
      stored = loadConfig(CONFIG_PATH)
    } catch (error) {
      console.warn((error as Error).message)
      return
    }
    if (!stored.configured) app.quit()
  })
}

/** Show the window if hidden or unfocused, otherwise hide it. */
function toggleWindow(): void {
  if (window === undefined || window.isDestroyed()) return
  if (window.isVisible() && window.isFocused()) {
    window.hide()
    return
  }
  revealWindow()
}

/** Raise a turn-complete notification, but only when the user is looking elsewhere. */
function onTurnEnd(): void {
  console.log(`[notify] turn-end ping received at ${new Date().toISOString()}`)
  if (window === undefined || window.isDestroyed()) return
  if (window.isFocused()) return
  new Notification({ title: 'DeepSeek Harness', body: 'The agent finished its turn.' }).show()
}

/**
 * Read the configured hotkey, tolerating a broken config.
 * @returns the accelerator, or undefined when unavailable.
 */
function safeHotkey(): string | undefined {
  try {
    const result = loadConfig(CONFIG_PATH)
    return result.configured ? result.config.hotkey : undefined
  } catch {
    // boot() reports config failures in the window; the hotkey just goes unbound.
    return undefined
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (window === undefined || window.isDestroyed()) return
    if (window.isMinimized()) window.restore()
    window.focus()
  })

  app.setAsDefaultProtocolClient('dsh')

  // macOS delivers deep links through open-url, not argv.
  app.on('open-url', (event) => {
    event.preventDefault()
    if (window === undefined || window.isDestroyed()) {
      // A cold-start link arrives before whenReady, so there is nothing to
      // raise yet; the window applies it once it exists.
      deepLinkPending = true
      return
    }
    revealWindow()
  })

  // Before the app is ready, and before anything creates a window: Chromium
  // reads the privileged scheme table once, at startup.
  registerPaneScheme()

  // Every git child runs under the PATH the harness child gets, not the bare
  // one a Finder launch inherits. Asked per call, so Extra PATH entries added
  // in Settings take effect without a restart.
  setGitPath(probePath)

  void app.whenReady().then(async () => {
    servePane(() => readWorkspaces(DSH_HOME).map((workspace) => workspace.path))
    // Scheduled before anything else and never awaited: the resolution runs
    // on its own turn, so a slow rc file delays nothing here, and its result
    // is only ever read by the NEXT launch.
    refreshShellPath()
    // Before anything reads `mcp.json`: converts the superseded `mcp` section
    // and token store, once, and is a no-op afterwards.
    migrateMcpConfig(DSH_HOME)
    // Offers each shipped default once, recorded by generation so a default
    // the user removes stays removed.
    ensureDefaultPlugins(DSH_HOME)
    // A default this build pins newer than what is installed moves forward
    // here, before the healthcheck reads the config and repairs what it finds.
    alignDefaultPlugins(DSH_HOME)
    installMenu(showSettings, {
      toggleFiles: () => {
        toggleSideView('files')
      },
      toggleGit: () => {
        toggleSideView('git')
      },
      toggleWeb,
      toggleTerminal: toggleTerminalPanel,
      zoomIn: () => {
        zoomHarness(1)
      },
      zoomOut: () => {
        zoomHarness(-1)
      },
      zoomReset: () => {
        zoomHarness(0)
      },
    })
    try {
      const stored = loadConfig(CONFIG_PATH)
      if (stored.configured && stored.config.pane !== undefined) {
        // The editor's width is restored but never its open state: the column
        // exists because a file is in it, and nothing is open at launch. A
        // stored `true` would put an empty editor on screen offering to be
        // closed.
        columns.editor = { width: stored.config.pane.editor.width, open: false }
        // `view` is absent from every config written before the git panel, and
        // `loadConfig` fills it in — the fallback here is for a stored object
        // that reached this build by any other route.
        const side = stored.config.pane.files
        columns.files = { ...side, view: side.view === 'git' ? 'git' : 'files' }
        // The panel's size is restored but never its open state, for the
        // editor's reason: a terminal exists because someone opened one, and
        // reopening it at launch would start a shell nobody asked for.
        if (stored.config.pane.terminal !== undefined) {
          columns.terminal = { ...stored.config.pane.terminal, open: false }
        }
      }
    } catch {
      // An unreadable config is reported further down, where it can open
      // Settings; the columns simply start at their defaults until then.
    }
    views = createWindow(columns)
    window = views.window
    // Sent, not invoked: a divider drag reports a coordinate per pointer move
    // and wants no answer. Which divider is dragging comes with it, since the
    // page draws one per open column.
    ipcMain.on('shell:resize-column', (_event, key: keyof Columns, windowX: number) => {
      if (views === undefined || views.window.isDestroyed()) return
      // Docked along the bottom the panel is sized by height, which the page
      // measured from the bottom edge. Standing in the editor's slot it is a
      // column like any other and sized by width — the same distinction the
      // divider's own orientation follows.
      if (key === 'terminal') {
        if (columns.editor.open) setTerminalHeight(windowX)
        else {
          const [full] = views.window.getContentSize()
          const outside = columns.files.open ? sideColumn(views).getBounds().width + DIVIDER_WIDTH : 0
          setColumn('terminal', { width: full - RAIL_WIDTH - windowX - outside })
        }
        return
      }
      const [width] = views.window.getContentSize()
      // Each column is measured inward from the rail, past whatever columns
      // sit outside it: dragging the editor's divider must not move the tree,
      // and neither reaches the strip at the edge.
      const outside = key === 'editor' && columns.files.open
        ? sideColumn(views).getBounds().width + DIVIDER_WIDTH
        : 0
      setColumn(key, { width: width - RAIL_WIDTH - windowX - outside })
    })
    ipcMain.on('shell:nudge-column', (_event, key: keyof Columns, delta: number) => {
      if (key === 'terminal') {
        if (columns.editor.open) setTerminalHeight(columns.terminal.height + delta)
        else setColumn('terminal', { width: columns.terminal.width + delta })
        return
      }
      setColumn(key, { width: columns[key].width + delta })
    })
    ipcMain.on('shell:commit-columns', () => {
      // The widths `layout` settled on, not the ones the drag asked for: a
      // stored width the clamp already refused would reopen at the wrong size.
      if (views !== undefined && !views.window.isDestroyed()) {
        if (columns.editor.open) columns.editor.width = views.pane.getBounds().width
        if (columns.files.open) columns.files.width = sideColumn(views).getBounds().width
      }
      storeColumns()
    })
    // The rail's two buttons. The editor is not among them: it is not
    // something to open empty, and appears when a file goes into it.
    ipcMain.on('shell:toggle-files', () => {
      toggleSideView('files')
    })
    ipcMain.on('shell:toggle-git', () => {
      toggleSideView('git')
    })
    ipcMain.on('shell:toggle-web', toggleWeb)
    // The panel's own read. Nothing about git reaches the renderer but this
    // result: the parsing, the spawning, and the serialisation are all here.
    ipcMain.handle('git:read', async () => await readCurrentGit())
    // A row's diff. A send rather than an invoke: the editor column is
    // main's to fill, and there is no answer for the panel to wait on.
    ipcMain.on('git:open-diff', (_event, repo: string, path: string, section: Section) => {
      void openGitDiffInPane(repo, path, section)
    })
    ipcMain.on('shell:toggle-terminal', toggleTerminalPanel)
    // The harness telling us which project it is working in — pushed by the
    // desktop plugin when the user switches session. Better than anything
    // this app can infer: selecting an existing session moves nothing on
    // disk, so the file watchers below never see it.
    ipcMain.on('harness:workspace', (_event, cwd: string) => {
      const workspace = readWorkspaces(DSH_HOME).find((each) => each.path === cwd)
      if (workspace === undefined) return
      currentProject = undefined
      showProject({ path: workspace.path, title: workspace.title })
    })
    // A link in a rendered file goes where the user's links go, not into a
    // view of this app. Checked here because the URL comes from a file.
    ipcMain.on('pane:open-external', (_event, url: string) => {
      if (loadableUrl(url)) void shell.openExternal(url)
    })
    ipcMain.on('pane:close-editor', () => {
      setColumn('editor', { open: false })
      storeColumns()
    })
    // The pane's own reads. Both are rooted in a project the harness has
    // opened: the renderer names a root, and main refuses one that is not on
    // that list — the same rule the per-project MCP file follows.
    ipcMain.handle('pane:projects', () =>
      readWorkspaces(DSH_HOME).map(({ path, title }) => ({ path, title })),
    )
    ipcMain.handle('pane:list-directory', (_event, root: string, relative: string) =>
      knownProject(root) ? readDirectory(root, relative) : [],
    )
    // The tree's context menu. Native, so it looks like every other menu on
    // the machine, and popped from here since only main can.
    ipcMain.handle('pane:tree-menu', async (_event, target: { directory: boolean; pending: boolean; name: string }) => {
      if (views === undefined || views.window.isDestroyed()) return undefined
      return await popTreeMenu(views.window, target)
    })
    ipcMain.handle('pane:rename-entry', (_event, root: string, relative: string, name: string) =>
      knownProject(root) ? renameEntry(root, relative, name) : OUTSIDE_PROJECT,
    )
    ipcMain.handle('pane:paste-entry', (_event, root: string, relative: string, into: string, move: boolean) =>
      knownProject(root) ? pasteEntry(root, relative, into, move) : OUTSIDE_PROJECT,
    )
    // Deleting is the one operation with no undo, so it asks first — and it
    // asks here, where the answer cannot be faked by a renderer.
    ipcMain.handle('pane:delete-entry', async (_event, root: string, relative: string, directory: boolean) => {
      if (!knownProject(root)) return OUTSIDE_PROJECT
      if (views === undefined || views.window.isDestroyed()) return OUTSIDE_PROJECT
      const { response } = await dialog.showMessageBox(views.window, {
        type: 'warning',
        buttons: ['Delete', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        message: `Delete ${relative}?`,
        detail: directory
          ? 'The folder and everything in it is deleted. This cannot be undone, and it does not go to the Trash.'
          : 'This cannot be undone, and it does not go to the Trash.',
      })
      if (response !== 0) return { ok: false as const, reason: '' }
      return deleteEntry(root, relative)
    })
    // Asked for from the tree, which is its own page and cannot see what the
    // editor is holding. The editor page saves the file if it has unsaved
    // edits in it and asks for the load back, so what the web view shows is
    // the file as it is rather than as it was last written.
    ipcMain.on('pane:open-in-web', (_event, root: string, relative: string) => {
      if (views === undefined || views.window.isDestroyed()) return
      if (webPageInProject(root, relative) === undefined) return
      views.pane.webContents.send('pane:save-for-web', root, relative)
    })
    // The load itself, asked for by the editor page once it has saved. The
    // path is checked again rather than trusted: this channel is reachable
    // from a renderer, and the first check was of what the tree sent.
    ipcMain.on('pane:load-in-web', (_event, root: string, relative: string) => {
      const url = webPageInProject(root, relative)
      if (url !== undefined) openUrlInPane(url)
    })
    ipcMain.on('pane:reveal-entry', (_event, root: string, relative: string) => {
      if (!knownProject(root)) return
      const target = resolveInRoot(root, relative)
      if (target !== undefined) shell.showItemInFolder(target)
    })
    // The chat lives in the harness's own page, so this hands the reference
    // to that page; the desktop plugin's browser half puts it in the
    // composer. Nothing happens if that plugin is not installed.
    ipcMain.on('pane:add-to-chat', (_event, root: string, relative: string, directory: boolean) => {
      if (!knownProject(root) || views === undefined || views.window.isDestroyed()) return
      const target = resolveInRoot(root, relative)
      if (target === undefined) return
      views.harness.webContents.send('harness:add-to-chat', { path: target, directory })
    })
    ipcMain.on('pane:copy-path', (_event, root: string, relative: string) => {
      if (!knownProject(root)) return
      const target = resolveInRoot(root, relative)
      if (target !== undefined) clipboard.writeText(target)
    })
    ipcMain.handle('pane:create-file', (_event, root: string, relative: string) =>
      knownProject(root) ? createFile(root, relative) : OUTSIDE_PROJECT,
    )
    ipcMain.handle('pane:create-folder', (_event, root: string, relative: string) =>
      knownProject(root) ? createFolder(root, relative) : OUTSIDE_PROJECT,
    )
    ipcMain.handle('pane:read-file', (_event, root: string, relative: string) =>
      knownProject(root) ? readTextFile(root, relative) : OUTSIDE_PROJECT,
    )
    ipcMain.handle('pane:write-file', (_event, root: string, relative: string, text: string) =>
      knownProject(root) ? writeTextFile(root, relative, text) : OUTSIDE_PROJECT,
    )
    // The tree's own clicks take the same route a view tool will, so there is
    // one path into the editor rather than two.
    ipcMain.on('pane:open-file', (_event, root: string, relative: string) => {
      openInPane(root, relative)
    })
    // The browser's chrome. The page is a view of this window, so its address
    // bar can only reach it through here.
    ipcMain.on('pane:navigate', (_event, url: string) => {
      if (views === undefined || views.window.isDestroyed()) return
      if (!loadableUrl(url)) return
      void views.web.webContents.loadURL(url)
    })
    ipcMain.on('pane:web-back', () => {
      if (views !== undefined && !views.window.isDestroyed()) views.web.webContents.navigationHistory.goBack()
    })
    ipcMain.on('pane:web-forward', () => {
      if (views !== undefined && !views.window.isDestroyed()) views.web.webContents.navigationHistory.goForward()
    })
    ipcMain.on('pane:web-reload', () => {
      if (views !== undefined && !views.window.isDestroyed()) views.web.webContents.reload()
    })
    // Every navigation, wherever it came from — the address bar, a link in the
    // page, or the agent's own tool — reports back so the bar shows where the
    // browser actually is.
    // Attached as soon as there is a page, not when a tool first asks: a
    // dialog that opens while nothing is attached is never answered, and it
    // blocks the browser column until someone dismisses it by hand.
    views.web.webContents.on('dom-ready', () => {
      void browser.ready()
    })
    views.web.webContents.on('did-navigate', () => {
      pushWebState()
    })
    views.web.webContents.on('did-navigate-in-page', () => {
      pushWebState()
    })
    // The pane's Web tab: the web view is stacked over the pane's own bounds,
    // so only main can raise or drop it.
    ipcMain.on('pane:show-web-view', (_event, visible: boolean) => {
      webViewVisible = visible === true
      if (views !== undefined && !views.window.isDestroyed()) applyLayout(views, columns, webViewVisible)
    })
    // Each page asks for the theme as it loads: main cannot know when a page
    // is ready to be told, and a page that missed the push would draw in the
    // wrong one until something else changed.
    ipcMain.on('theme:ask', () => {
      pushTheme()
    })
    // The page asks only for a size. Which shell, and where it runs, are
    // decided here: a renderer that named either could start any program in
    // any directory.
    ipcMain.handle('terminal:start', (_event, cols: number, rows: number) => startTerminal(cols, rows))
    ipcMain.on('terminal:input', (_event, id: number, data: string) => {
      terminals.send({ kind: 'input', id, data })
    })
    ipcMain.on('terminal:resize', (_event, id: number, cols: number, rows: number) => {
      terminals.send({ kind: 'resize', id, cols, rows })
    })
    ipcMain.on('terminal:ack', (_event, id: number, chars: number) => {
      terminals.send({ kind: 'ack', id, chars })
    })
    ipcMain.on('terminal:kill', (_event, id: number) => {
      terminals.send({ kind: 'kill', id })
    })
    // The panel's own close button. It closes the column, exactly as the
    // rail's toggle does — the shells in it are killed by the page first.
    ipcMain.on('terminal:close-panel', () => {
      if (!columns.terminal.open) return
      toggleColumn('terminal')
    })
    // Asked for as the tree's page loads, for the same reason as the theme:
    // main cannot know when a page is ready to be told.
    ipcMain.on('pane:ask-project', () => {
      showProject()
    })
    watchTheme()
    // The OS setting moves independently of the harness's, and `system` means
    // following it.
    nativeTheme.on('updated', pushTheme)
    watchWorkspaces()
    // The splash covers the wait before the main window has anything to
    // paint; the moment a real page lands there — the harness URL, or the
    // error pane when boot fails — the splash has said everything it can.
    views.harness.webContents.on('did-finish-load', () => {
      windowHasContent = true
      closeStartup(splash)
      splash = undefined
      // The window is created hidden and no longer shows itself on
      // `ready-to-show`: that event belongs to the window's own page, which
      // is just the divider and loads immediately, so waiting on it would put
      // an empty frame on screen before the harness had anything.
      if (window !== undefined && !window.isDestroyed() && !window.isVisible()) window.show()
      // A deep link, an `activate`, or the hotkey may have asked for the
      // window while it was still empty; that ask is honoured now rather than
      // dropped, which is what raises the window for a cold-start dsh:// link.
      if (revealPending) {
        revealPending = false
        revealWindow()
      }
    })
    // Anything at all can move a repository while this app is not the one in
    // front — the agent's own tools, another editor, a shell. Coming back is
    // the moment the panel is about to be read, so it is the moment to check.
    window.on('focus', () => {
      notifyGitChanged()
    })
    window.on('close', (event) => {
      // Closing the window leaves the app running in the tray; only a quit,
      // which sets `quitting` first, may actually destroy it.
      if (quitting) return
      event.preventDefault()
      if (window !== undefined && !window.isDestroyed()) window.hide()
    })
    window.on('closed', () => {
      window = undefined
      views = undefined
    })
    tray = createTray({
      toggleWindow,
      restart: () => void restartOnce(),
      openSettings: showSettings,
      quit: () => app.quit(),
    })
    const hotkey = safeHotkey()
    if (hotkey !== undefined && !globalShortcut.register(hotkey, toggleWindow)) {
      console.warn(`dsh-desktop: the hotkey ${hotkey} could not be registered; another app already owns it.`)
    }
    try {
      const result = loadConfig(CONFIG_PATH)
      if (result.configured) {
        notifier = await startNotifyListener(result.config.notifyPort, onTurnEnd)
      }
    } catch (error) {
      console.warn((error as Error).message)
    }
    if (deepLinkPending) {
      deepLinkPending = false
      revealWindow()
    }
    let stored: ConfigResult
    try {
      stored = loadConfig(CONFIG_PATH)
    } catch (error) {
      // Without this the voided whenReady handler would simply reject: no
      // boot, no error pane, no settings window — a hidden window and a tray
      // icon, with no way to reach the form that fixes the config.
      failConfiguration('Configuration problem', (error as Error).message)
      return
    }
    if (!stored.configured) {
      // Nothing to boot and nothing to show until the user says where the
      // harness lives, so settings is the whole app until it is saved.
      showSettings()
      return
    }
    await runStartupPhases(stored.config)
    // Before the boot: the harness child is handed this server's port in the
    // overlay, so one that came up afterwards would be one it never learned
    // about.
    await startViewTools(stored.config)
    checkForUpdate(stored.config)
    await enqueue(bootNow)
  })

  // The window is hidden rather than closed, so this only fires on the way out;
  // the app stays in the tray instead of quitting with its last window.
  app.on('window-all-closed', () => {})

  app.on('activate', () => revealWindow())

  app.on('before-quit', async (event) => {
    if (quitting) return
    event.preventDefault()
    await shutdown()
    app.quit()
  })

  app.on('will-quit', () => {
    globalShortcut.unregisterAll()
    tray?.destroy()
    void notifier?.close()
  })
}
