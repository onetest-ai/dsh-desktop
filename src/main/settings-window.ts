import { BrowserWindow, ipcMain, type WebContents } from 'electron'
import { join } from 'node:path'
import type { SettingsHandlers } from './settings-ipc'
import type { McpServerEntry } from './mcp-config'
import type { SettingsForm } from './settings-validate'

let settingsWindow: BrowserWindow | undefined
let channelsRegistered = false

function isOpen(): boolean {
  return settingsWindow !== undefined && !settingsWindow.isDestroyed()
}

/**
 * The settings window's page, when one is open.
 *
 * Exposed so main can push it what every one of this app's own pages needs —
 * the theme the harness is set to — without holding a second reference to the
 * window this module owns.
 * @returns its `webContents`, or undefined when no settings window is open.
 */
export function settingsContents(): WebContents | undefined {
  return isOpen() && settingsWindow !== undefined ? settingsWindow.webContents : undefined
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
function pushToSender(sender: WebContents, channel: string, payload: unknown): void {
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
      handlers.read(
        (latest) => pushToSender(event.sender, 'settings:update-available', latest),
        (pkg, latest) => pushToSender(event.sender, 'settings:plugin-update-available', { pkg, latest }),
      ),
    )
    ipcMain.handle('settings:pick-folder', () => handlers.pickFolder())
    ipcMain.handle('settings:save', (event, form: SettingsForm) =>
      handlers.save(form, (line) => pushToSender(event.sender, 'settings:progress', line)),
    )
    ipcMain.handle('settings:accept-plugin-update', (event, pkg: string, version: string) =>
      handlers.acceptPluginUpdate(pkg, version, (line) => pushToSender(event.sender, 'settings:progress', line)),
    )
    ipcMain.handle('settings:validate-plugin', (_event, spec: string, existingPackages: string[]) =>
      handlers.validatePlugin(spec, existingPackages),
    )
    ipcMain.handle('settings:validate-plugin-config', (_event, text: string) => handlers.validatePluginConfig(text))
    ipcMain.handle('settings:check-binaries', (_event, pnpmPath: string, npmPath: string) =>
      handlers.checkBinaries(pnpmPath, npmPath),
    )
    ipcMain.handle('settings:open-config-file', () => handlers.openConfigFile())
    ipcMain.handle('settings:prepare-mcp-server', (event, server: McpServerEntry) =>
      handlers.prepareMcpServer(server, (line) => pushToSender(event.sender, 'settings:mcp-progress', line)),
    )
    ipcMain.handle('settings:read-mcp-servers', () => handlers.readMcpServers())
    ipcMain.handle('settings:save-mcp-servers', (_event, servers: McpServerEntry[]) => handlers.saveMcpServers(servers))
    ipcMain.handle('settings:paste-mcp-block', (_event, text: string) => handlers.pasteMcpBlock(text))
    ipcMain.handle('settings:open-mcp-config-file', () => handlers.openMcpConfigFile())
    ipcMain.handle('settings:read-workspaces', () => handlers.readWorkspaces())
    ipcMain.handle('settings:open-project-mcp-file', (_event, file: string) => handlers.openProjectMcpFile(file))
    ipcMain.handle('settings:save-project-mcp-servers', (_event, file: string, servers: McpServerEntry[]) =>
      handlers.saveProjectMcpServers(file, servers),
    )
    ipcMain.handle('settings:paste-project-mcp-block', (_event, file: string, text: string) =>
      handlers.pasteProjectMcpBlock(file, text),
    )
    channelsRegistered = true
  }

  settingsWindow = new BrowserWindow({
    // Landscape, because the sections moved into a column of their own: the
    // list needs ~208px that the content no longer has to give up, and a
    // settings window is read across rather than down.
    width: 880,
    height: 640,
    title: 'DeepSeek Harness Settings',
    // Genuinely frameless, matching the main window: this window owns its
    // markup, so it can carry a real drag strip (`.titlebar` in
    // settings.html) instead of the CSS-injection workaround the harness
    // content needs. `titleBarStyle`/`trafficLightPosition` apply on macOS
    // only; Electron ignores both elsewhere and this window keeps its
    // native frame there, so it is unaffected on Windows/Linux.
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 16, y: 14 },
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
